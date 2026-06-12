// fgo-bond-manager/greedyScheduler.js
// 
// 【貪欲法によるスケジューリング専用ファイル (高度化・制約遵守版)】
// 

window.generateGreedySchedule = function ({
  servants,
  availableTraits,
  battleTemplate,
  fixedSlots,
  fixedCEs,
  fixedSupportCEs,
  globalGrandSvtIds,
  getGrandGroup,
  extraGlobalPercent,
  useTeapot,
  ownedCEs,
  scheduleResults,
  BOND_REQ_11_TO_15,
  BOND_REQ_1_TO_10,
  calculateTargetRemainingP,
  getServantCost,
  getCECost,
  formatCEName
}) {
  console.log("Advanced Greedy Scheduler Initialized. Starting simulation...");

  // --- 1. 初期化とパラメータの展開 ---
  const baseBond = battleTemplate.baseBond || 1000;
  const isCrown = battleTemplate.isCrown || false;
  const applyBond15SystemBuff = battleTemplate.applyBond15Bonus || false;
  let allowedClasses = battleTemplate.constraints?.allowedClasses || [];
  let expandedAllowedClasses = [...allowedClasses];
  if (expandedAllowedClasses.includes('ex1')) {
    expandedAllowedClasses.push('ruler', 'shielder', 'avenger', 'mooncancer');
  }
  if (expandedAllowedClasses.includes('ex2')) {
    expandedAllowedClasses.push('alterego', 'foreigner', 'pretender', 'beast');
  }


  // --- 2. 固定枠の展開と自由枠の抽出 ---

  // 固定戦闘要員のオブジェクトを抽出
  const fixedServants = fixedSlots.map(id => {
    if (!id) return null;
    const svt = servants.find(s => s.id === id);
    if (!svt) return null;
    return {
      ...svt,
      remP: calculateTargetRemainingP(svt) || 0
    };
  });

  // 自由引率枠の対象となる未達成サーヴァントの抽出
  let uncompleted = servants
    .filter(svt => {
      // 既に固定枠に指定されている鯖は除外
      if (fixedSlots.includes(svt.id)) return false;
      // クラス制限のチェック (空配列の場合は制限なし)
      if (expandedAllowedClasses.length > 0 && !expandedAllowedClasses.includes(svt.className.toLowerCase())) return false;
      return true;
    })
    .map(svt => {
      return {
        ...svt,
        remP: calculateTargetRemainingP(svt)
      };
    })
    .filter(svt => svt.remP > 0); // 目標未達のみ抽出

  // 目標達成済みのサーヴァント（ダミー枠要員として、余った枠で礼装を持つために選出）
  let completedCandidates = servants
    .filter(svt => {
      if (!svt.owned) return false;
      if (fixedSlots.includes(svt.id)) return false;
      if (expandedAllowedClasses.length > 0 && !expandedAllowedClasses.includes(svt.className.toLowerCase())) return false;
      const rem = calculateTargetRemainingP(svt);
      return rem === null || rem <= 0;
    })
    .map(svt => ({ ...svt, remP: 0 }))
    .sort((a, b) => getServantCost(a) - getServantCost(b)); // 低コスト順に並べる

  // レベルアップ実績サマリー用の初期データ記録
  const initialBondData = {};
  servants.forEach(svt => {
    initialBondData[svt.id] = {
      name: svt.name,
      oldLv: svt.currentLv,
      oldRemP: calculateTargetRemainingP(svt) || 0,
      targetLevel: svt.targetLevel
    };
  });

  // 礼装インベントリの初期状態をディープコピー
  const initialCEPool = JSON.parse(JSON.stringify(ownedCEs));

  const finalRemPMap = {};
  const activeServantIds = new Set();

  let phases = [];
  let totalRuns = 0;
  let phaseCount = 0;

  // --- ヘルパー関数（メインループ外に定義、パラメータ化） ---

  /** サポート（フレンド）礼装の効果パラメータを算出 */
  const getFriendBonusParams = (ceArray) => {
    let friendBonusPercent = 0;
    let friendFlatBonus = 0;
    const traitBonuses = [];
    for (let ce of ceArray) {
      if (ce === 'teatime') friendBonusPercent += 15;
      else if (ce === 'lunchtime') friendBonusPercent += 10;
      else if (ce === 'kyokuten') friendBonusPercent += 2;
      else if (ce === 'portrait') friendFlatBonus += 50;
      else traitBonuses.push(ce);
    }
    return { friendBonusPercent, friendFlatBonus, traitBonuses };
  };

  /** 
   * 指定スロットの1周あたり獲得絆ptを算出
   * @param {object} node - partyノード
   * @param {object} friendParams - getFriendBonusParamsの返り値
   * @param {string} supportPos - サポート配置 ('front' or 'back')
   * @param {Array} partyMembers - パーティ全体の配列
   * @param {number} lv15Count - パーティ内の絆15以上の鯖数
   */
  const computeSlotPoints = (node, friendParams, supportPos, partyMembers, lv15Count) => {
    if (!node || !node.svt) return 0;
    
    let B = 1.0;
    if (supportPos === 'back') {
      B = node.slotIdx < 3 ? 1.20 : 1.00;
    } else {
      B = node.slotIdx < 2 ? 1.24 : 1.04;
    }
    const C = Math.floor(baseBond * B);

    let percent = friendParams.friendBonusPercent;

    // 自陣の全メンバーの礼装効果（通常・グランド第2）を全体に適用
    for (let other of partyMembers) {
      if (!other || !other.svt) continue;

      // 第1礼装
      const ce = other.equippedCE;
      if (ce === 'teatime' || ce === 'bond5') percent += 5;
      else if (ce === 'lunchtime') percent += 10;
      else if (ce === 'kyokuten') percent += 2;
      else if (ce !== 'none' && ce !== 'portrait') {
        const myTraits = node.svt.traits || [];
        if (myTraits.includes(ce)) percent += 20;
      }

      // グランド鯖の第2礼装
      if (other.isGrand) {
        const ce2 = other.equippedCE2;
        if (ce2 === 'teatime' || ce2 === 'bond5') percent += 5;
        else if (ce2 === 'lunchtime') percent += 10;
        else if (ce2 === 'kyokuten') percent += 2;
        else if (ce2 !== 'none' && ce2 !== 'portrait') {
          const myTraits = node.svt.traits || [];
          if (myTraits.includes(ce2)) percent += 20;
        }
      }
    }

    // サポートの特攻礼装ボーナス
    const myTraits = node.svt.traits || [];
    for (let t of friendParams.traitBonuses) {
      if (myTraits.includes(t)) percent += 20;
    }

    // 絆15ボーナス
    const lv15Bonus = applyBond15SystemBuff ? 25 : lv15Count * 25;
    percent += lv15Bonus;
    percent += extraGlobalPercent;
    if (useTeapot) percent += 100;

    let D = Math.floor(C * (percent / 100));

    let flat = friendParams.friendFlatBonus;
    // 自陣の全メンバーの肖像フラット効果を集計
    for (let other of partyMembers) {
      if (!other.svt) continue;
      if (other.equippedCE === 'portrait') flat += 50;
      if (other.isGrand && other.equippedCE2 === 'portrait') flat += 50;
    }

    return C + D + flat;
  };

  /**
   * トライアルパーティに対して礼装を割り当てる（CE poolを消費する）
   * @param {Array} trialParty - パーティ配列
   * @param {object} trialPool - 礼装プール（この関数内で消費される）
   */
  const allocateCEsToParty = (trialParty, trialPool) => {
    let ceSlots = [];
    for (let node of trialParty) {
      if (!node.svt) continue;
      if (!node.isFixedCE1) ceSlots.push({ node, isSecond: false, isDummy: node.isDummy });
      if (node.isGrand && !node.isFixedCE2) ceSlots.push({ node, isSecond: true, isDummy: node.isDummy });
    }

    // Pass 1: 特攻CE優先割り当て
    for (let slot of ceSlots) {
      if (slot.isDummy) continue; // ダミー枠は特攻CEの恩恵がないためスキップ
      const svtTraits = slot.node.svt.traits || [];
      let assignedTrait = null;
      for (let trait of svtTraits) {
        const poolKey = trialPool[trait] > 0 ? trait : (trialPool[`trait_${trait}`] > 0 ? `trait_${trait}` : null);
        if (poolKey) {
          trialPool[poolKey]--;
          assignedTrait = trait;
          break;
        }
      }
      if (assignedTrait) {
        if (slot.isSecond) slot.node.equippedCE2 = assignedTrait;
        else slot.node.equippedCE = assignedTrait;
      }
    }

    // Pass 2: 通常絆礼装の割り当て
    const fallbackCEs = ['lunchtime', 'teatime', 'bond5', 'portrait', 'kyokuten'];
    // 基礎絆が少ない場合は肖像を優先
    if (baseBond < 1000) {
      fallbackCEs.splice(0, 5, 'portrait', 'lunchtime', 'teatime', 'bond5', 'kyokuten');
    }
    
    for (let slot of ceSlots) {
      const currentCE = slot.isSecond ? slot.node.equippedCE2 : slot.node.equippedCE;
      if (currentCE !== 'none') continue;
      
      let assigned = 'none';
      for (let ce of fallbackCEs) {
        if (trialPool[ce] > 0) {
          trialPool[ce]--;
          assigned = ce;
          break;
        }
      }
      
      if (slot.isSecond) slot.node.equippedCE2 = assigned;
      else slot.node.equippedCE = assigned;
    }
  };

  /**
   * トライアルパーティのコスト超過を調整する
   * @param {Array} trialParty - パーティ配列
   * @param {object} trialPool - 礼装プール
   */
  const adjustCostForParty = (trialParty, trialPool) => {
    let safetyCounter = 0;
    while (calculateTotalCost(trialParty, getServantCost, getCECost) > 118 && safetyCounter < 50) {
      safetyCounter++;
      let sortedForDowngrade = [...trialParty].filter(n => n.svt).sort((a, b) => {
        if (a.isFixed !== b.isFixed) return a.isFixed ? 1 : -1;
        if (a.isDummy !== b.isDummy) return a.isDummy ? 1 : -1; // ダミー枠は全体効果礼装を持っているため最後にダウングレード
        return a.svt.remP - b.svt.remP;
      });
      let downgraded = false;
      for (let node of sortedForDowngrade) {
        if (tryDowngradeCE(node, trialPool, getCECost)) {
          downgraded = true;
          break;
        }
      }
      if (!downgraded) break;
    }
  };

  // --- 3. メインループ（統合最適化: サポート構成 × スロット配置 × 礼装の同時評価） ---
  while ((uncompleted.length > 0 || fixedServants.some(svt => svt && svt.remP > 0)) && phaseCount < 1000) {
    phaseCount++;

    // a. サポートCE候補リストの構築（パーティ候補の特性も含める）
    const supportCECandidates = ['teatime', 'lunchtime', 'kyokuten', 'portrait'];
    
    // ▼ 固定サポート礼装のパースと候補への追加
    const parsedFixedSupport = (fixedSupportCEs || [])
      .filter(ce => ce && ce !== 'auto')
      .map(ce => ce.startsWith('trait_') ? ce.replace('trait_', '') : ce);
      
    parsedFixedSupport.forEach(t => { if (!supportCECandidates.includes(t)) supportCECandidates.push(t); });
    
    const allTraitsInPlay = new Set();
    uncompleted.forEach(svt => (svt.traits || []).forEach(t => allTraitsInPlay.add(t)));
    fixedServants.forEach(svt => { if (svt) (svt.traits || []).forEach(t => allTraitsInPlay.add(t)); });
    allTraitsInPlay.forEach(t => { if (!supportCECandidates.includes(t)) supportCECandidates.push(t); });

    const numSupportSlots = isCrown ? 2 : 1;

    // サポートCEの組み合わせを列挙
    let supportCECombos = [];
    if (numSupportSlots === 1) {
      if (parsedFixedSupport.length === 1) {
        supportCECombos.push([parsedFixedSupport[0]]);
      } else {
        supportCECandidates.forEach(ce => supportCECombos.push([ce]));
      }
    } else {
      if (parsedFixedSupport.length === 2) {
        supportCECombos.push([parsedFixedSupport[0], parsedFixedSupport[1]]);
      } else if (parsedFixedSupport.length === 1) {
        // 1枠固定、もう1枠は自由探索（重複を排除）
        supportCECandidates.forEach(ce => {
          if (ce !== parsedFixedSupport[0]) {
            supportCECombos.push([parsedFixedSupport[0], ce]);
          }
        });
      } else {
        // 固定なし
        for (let i = 0; i < supportCECandidates.length; i++) {
          for (let j = i + 1; j < supportCECandidates.length; j++) {
            supportCECombos.push([supportCECandidates[i], supportCECandidates[j]]);
          }
        }
      }
    }

    // b. 自由枠候補のソート（特攻CE一致優先 → 残り絆P降順）
    uncompleted.sort((a, b) => {
      const matchA = hasMatchingTraitCE(a, initialCEPool);
      const matchB = hasMatchingTraitCE(b, initialCEPool);
      if (matchA !== matchB) return matchA ? -1 : 1;
      return b.remP - a.remP;
    });

    // c. サポート構成（前衛/後衛 × CE組合せ）の全パターンを統合評価
    let bestConfig = null; // { party, slotPoints, totalP, supportPos, supportCEs }

    for (let pos of ['front', 'back']) {
      // この配置での各スロットのB値
      const bMap = pos === 'back'
        ? [1.20, 1.20, 1.20, 1.00, 1.00]
        : [1.24, 1.24, 1.04, 1.04, 1.04];

      for (let ceCombo of supportCECombos) {
        // 安全装置: 同名礼装の重複を許容しない
        if (ceCombo.length === 2 && ceCombo[0] === ceCombo[1]) continue;

        const friendParams = getFriendBonusParams(ceCombo);

        // --- トライアルパーティの構築 ---

        // 固定枠の配置
        let trialParty = new Array(5);
        for (let i = 0; i < 5; i++) {
          if (fixedServants[i]) {
            trialParty[i] = {
              svt: fixedServants[i], slotIdx: i, isFixed: true,
              equippedCE: 'none', equippedCE2: 'none',
              isGrand: isCrown && globalGrandSvtIds[getGrandGroup(fixedServants[i].className)] === fixedServants[i].id
            };
          } else {
            trialParty[i] = {
              svt: null, slotIdx: i, isFixed: false,
              equippedCE: 'none', equippedCE2: 'none', isGrand: false
            };
          }
        }

        // 空きスロットの抽出（B値降順にソート）
        const freeSlotInfos = [];
        for (let i = 0; i < 5; i++) {
          if (!fixedServants[i]) freeSlotInfos.push({ idx: i, bValue: bMap[i] });
        }
        freeSlotInfos.sort((a, b) => b.bValue - a.bValue);

        const numFreeSlots = freeSlotInfos.length;

        // 自由枠候補の選出（上位N名）
        const selectedCandidates = uncompleted.slice(0, numFreeSlots);

        // 貪欲マッチング: 高%候補 → 高B値スロットに配置
        // 各候補のスコア = 特攻CEマッチで+20%の恩恵、その次にremP
        const scoredCandidates = selectedCandidates.map(svt => ({
          svt,
          hasTraitMatch: hasMatchingTraitCE(svt, initialCEPool)
        }));
        // 高%候補を先頭に（特攻マッチあり → 高B値スロットへ）
        scoredCandidates.sort((a, b) => {
          if (a.hasTraitMatch !== b.hasTraitMatch) return a.hasTraitMatch ? -1 : 1;
          return b.svt.remP - a.svt.remP;
        });

        // 空きスロットへの割り当て（高B値スロット ← 高スコア候補）
        let completedIdx = 0;
        for (let k = 0; k < freeSlotInfos.length; k++) {
          const slotInfo = freeSlotInfos[k];
          let candidate = null;
          let isDummy = false;

          if (k < scoredCandidates.length) {
            candidate = scoredCandidates[k].svt;
          } else {
            // 未達成鯖が足りない場合、目標達成済みの低コスト鯖をダミー枠として配置し礼装枠を確保
            if (completedIdx < completedCandidates.length) {
              candidate = completedCandidates[completedIdx++];
              isDummy = true;
            }
          }

          if (candidate) {
            trialParty[slotInfo.idx] = {
              svt: candidate, slotIdx: slotInfo.idx, isFixed: false, isDummy: isDummy,
              equippedCE: 'none', equippedCE2: 'none',
              isGrand: isCrown && globalGrandSvtIds[getGrandGroup(candidate.className)] === candidate.id
            };
          }
        }

        // 絆15カウント
        let lv15Count = 0;
        for (let node of trialParty) {
          if (node.svt && node.svt.currentLv >= 15) lv15Count++;
        }

        // 礼装割り当て（トライアル用に独立したプールを使用）
        let trialPool = JSON.parse(JSON.stringify(initialCEPool));

        if (fixedCEs) {
          for (let i = 0; i < 5; i++) {
            const fce = fixedCEs[i];
            if (!fce || !trialParty[i].svt) continue;
            
            // ce1 が 'auto' の場合は何もしない（後続の allocateCEsToParty で自動割り当てされる）
            if (fce.ce1 && fce.ce1 !== 'auto') {
              let actualCe = fce.ce1.startsWith('trait_') ? fce.ce1.replace('trait_', '') : fce.ce1;
              trialParty[i].equippedCE = actualCe;
              trialParty[i].isFixedCE1 = true;
              
              // 'none' (意図的な装備なし) の場合はプールを消費しない
              if (actualCe !== 'none') {
                let pKey = trialPool[actualCe] > 0 ? actualCe : (trialPool[fce.ce1] > 0 ? fce.ce1 : null);
                if (pKey) trialPool[pKey]--;
              }
            }
            
            // ce2 も同様
            if (trialParty[i].isGrand && fce.ce2 && fce.ce2 !== 'auto') {
              let actualCe = fce.ce2.startsWith('trait_') ? fce.ce2.replace('trait_', '') : fce.ce2;
              trialParty[i].equippedCE2 = actualCe;
              trialParty[i].isFixedCE2 = true;
              
              if (actualCe !== 'none') {
                let pKey = trialPool[actualCe] > 0 ? actualCe : (trialPool[fce.ce2] > 0 ? fce.ce2 : null);
                if (pKey) trialPool[pKey]--;
              }
            }
          }
        }

        allocateCEsToParty(trialParty, trialPool);

        // コスト調整
        adjustCostForParty(trialParty, trialPool);

        // --- 追加: 絶対的なコスト上限バリデーションとサーヴァント入れ替えフォールバック ---
        if (calculateTotalCost(trialParty, getServantCost, getCECost) > 118) {
          let fallbackSuccess = false;
          // 選出されなかった控えの候補（コストを下げるための代替要員）
          const reserveCandidates = uncompleted.slice(numFreeSlots);
          
          // 自由枠のサーヴァントを、優先度が低い（残りptが少ない）順にソートしてダウングレード対象にする
          let downgradeTargets = trialParty.filter(n => n && n.svt && !n.isFixed).sort((a, b) => {
            if (a.isDummy !== b.isDummy) return a.isDummy ? -1 : 1; // コスト超過時はダミーを最優先で外す
            return a.svt.remP - b.svt.remP;
          });

          // 優先度の低い鯖から順に、より低コストの控え鯖への入れ替えを試みる
          for (let targetNode of downgradeTargets) {
            const currentSvtCost = getServantCost(targetNode.svt);
            
            for (let i = 0; i < reserveCandidates.length; i++) {
              const resSvt = reserveCandidates[i];
              if (!resSvt || resSvt._usedInFallback) continue;
              
              if (getServantCost(resSvt) < currentSvtCost) {
                // 低コスト鯖への入れ替えを実行
                targetNode.svt = resSvt;
                targetNode.isGrand = isCrown && globalGrandSvtIds[getGrandGroup(resSvt.className)] === resSvt.id;
                // 入れ替えた鯖の礼装はいったん外してコスト増を防ぐ
                targetNode.equippedCE = 'none';
                targetNode.equippedCE2 = 'none';
                resSvt._usedInFallback = true;
                
                // 入れ替え後、再度コスト超過をチェック（必要なら礼装ダウングレードを再試行）
                adjustCostForParty(trialParty, trialPool);
                
                if (calculateTotalCost(trialParty, getServantCost, getCECost) <= 118) {
                  fallbackSuccess = true;
                  break;
                }
              }
            }
            if (fallbackSuccess) break;
            
            // 控えとの入れ替えを尽くしても118を超えている（または控えがいない）場合、
            // そのスロット自体を「空（編成なし）」にして究極のコストダウンを行う
            if (!fallbackSuccess) {
              targetNode.svt = null;
              targetNode.isGrand = false;
              targetNode.equippedCE = 'none';
              targetNode.equippedCE2 = 'none';
              
              adjustCostForParty(trialParty, trialPool);
              if (calculateTotalCost(trialParty, getServantCost, getCECost) <= 118) {
                fallbackSuccess = true;
                break;
              }
            }
          }
          
          // フラグのお掃除
          reserveCandidates.forEach(s => delete s._usedInFallback);
          
          // 入れ替えを尽くしても118を超えている場合は、この編成パターンを強制スキップ（無効化）
          if (calculateTotalCost(trialParty, getServantCost, getCECost) > 118) {
            continue;
          }
        }

        // 全スロットのpt/周を算出して合計を評価
        let totalP = 0;
        let slotPoints = [];
        for (let node of trialParty) {
          if (!node.svt) {
            slotPoints.push(0);
            continue;
          }
          const p = computeSlotPoints(node, friendParams, pos, trialParty, lv15Count);
          if (node.svt.remP > 0) {
            totalP += p;
          }
          slotPoints.push(p);
        }

        // ベスト構成の更新
        if (!bestConfig || totalP > bestConfig.totalP) {
          bestConfig = {
            party: trialParty,
            slotPoints: slotPoints,
            totalP: totalP,
            supportPos: pos,
            supportCEs: [...ceCombo]
          };
        }
      }
    }

    // 安全装置: 有効な構成が見つからない場合
    if (!bestConfig || bestConfig.totalP <= 0) {
      alert("コスト制限（118）により編成できませんでした。固定枠を見直してください。");
      console.warn(`[Phase ${phaseCount}] 有効な構成が見つかりません。シミュレーション終了。`);
      break;
    }

    // d. ベスト構成の採用とフェーズ確定処理
    let party = bestConfig.party;
    let bestSlotPoints = bestConfig.slotPoints;

    // アクティブサーヴァントIDの追跡
    for (let node of party) {
      if (node.svt) activeServantIds.add(node.svt.id);
    }

    // 各スロットにpPerRunを適用し、最小周回数を算出
    let minRunsForPhase = Infinity;
    for (let i = 0; i < party.length; i++) {
      let node = party[i];
      if (!node.svt) continue;
      node.pPerRun = bestSlotPoints[i];
      if (node.pPerRun > 0 && node.svt.remP > 0) {
        let runsNeeded = Math.ceil(node.svt.remP / node.pPerRun);
        if (runsNeeded < minRunsForPhase) minRunsForPhase = runsNeeded;
      }
    }

    // 安全装置: 進行不能時
    if (minRunsForPhase === Infinity || minRunsForPhase <= 0) {
      break;
    }

    // e. ポイントの減算と同着を含む卒業判定
    totalRuns += minRunsForPhase;
    let completedInThisPhase = [];

    // 【追加】減算前の remP を保持しておく
    const remPBeforePhaseMap = {};
    for (let node of party) {
      if (node.svt) {
        remPBeforePhaseMap[node.svt.id] = node.svt.remP;
      }
    }

    // 合計獲得ポイントの算出（減算前の remP で判定する）
    let totalGainedPerRun = 0;
    for (let node of party) {
      if (node.svt && node.pPerRun && node.svt.remP > 0) {
        totalGainedPerRun += node.pPerRun;
      }
    }

    for (let node of party) {
      if (!node.svt) continue;
      if (!node.isFixed) {
        if (!node.isDummy) {
          node.svt.remP -= node.pPerRun * minRunsForPhase;
          if (node.svt.remP <= 0) completedInThisPhase.push(node.svt.name);
        }
      } else {
        let oldRemP = node.svt.remP;
        if (oldRemP > 0) {
          node.svt.remP -= node.pPerRun * minRunsForPhase;
          if (node.svt.remP <= 0) completedInThisPhase.push(node.svt.name + " (固定枠)");
        }
      }
      finalRemPMap[node.svt.id] = node.svt.remP;
    }

    uncompleted = uncompleted.filter(u => u.remP > 0);

    // 検証用コンソールログ
    console.log(`[Phase ${phaseCount}] totalP/run: ${totalGainedPerRun} | support: ${bestConfig.supportPos} + [${bestConfig.supportCEs.join(', ')}] | party: [${party.map(n => n.svt ? n.svt.name : '空').join(', ')}]`);

    // f. UIの期待する出力スキーマに合わせた結果データの成形
    phases.push({
      phase: phaseCount,
      questName: battleTemplate.name || "フリクエ周回",
      runs: minRunsForPhase,
      completed: completedInThisPhase,
      optimizedFriendPosition: bestConfig.supportPos,
      optimizedFriendCEs: bestConfig.supportCEs,
      totalGainedPerRun: totalGainedPerRun,
      party: party.map(node => {
        if (!node.svt) {
          return {
            name: '', iconUrl: '', equippedCE: 'none', ceName: 'なし',
            gainedPerRun: 0, remainingAfter: 0, isGrand: false, traits: [],
            phaseStartLv: '-', phaseEndLv: '-', totalRemP: 0
          };
        }

        // フェーズ開始時と終了時のレベルを計算
        const initData = initialBondData[node.svt.id];
        const initRemP = initData ? initData.oldRemP : 0;
        const remPBefore = remPBeforePhaseMap[node.svt.id];
        const remPAfter = node.svt.remP;
        
        const phaseStartLv = calculateFinalLevel(node.svt, Math.max(0, remPBefore), initRemP);
        const phaseEndLv = calculateFinalLevel(node.svt, Math.max(0, remPAfter), initRemP);

        let ceNameStr = formatCEName ? formatCEName(node.equippedCE) : node.equippedCE;
        if (node.isGrand && node.equippedCE2 !== 'none') {
          ceNameStr += ` / ${formatCEName ? formatCEName(node.equippedCE2) : node.equippedCE2}`;
        }

        return {
          name: node.svt.name,
          iconUrl: node.svt.iconUrl || '',
          equippedCE: node.equippedCE,
          ceName: ceNameStr,
          gainedPerRun: node.pPerRun,
          remainingAfter: Math.max(0, node.svt.remP),
          phaseStartLv: phaseStartLv,
          phaseEndLv: phaseEndLv,
          totalRemP: Math.max(0, remPAfter),
          isGrand: node.isGrand,
          traits: node.svt.traits || []
        };
      }),
      completedServants: completedInThisPhase
    });
  }

  // 無限ループ警告
  if (phaseCount >= 1000) {
    console.error("Greedy scheduler hit 1000 phases limit. Terminated to prevent crash.");
  }

  // 最終的なレベルアップ実績サマリーの生成
  let levelUpSummary = [];

  activeServantIds.forEach(id => {
    const initData = initialBondData[id];
    const svt = servants.find(s => s.id === id);
    if (initData && svt && initData.oldRemP > 0) {
      const finalRemP = finalRemPMap[id] !== undefined ? Math.max(0, finalRemPMap[id]) : initData.oldRemP;
      const newLv = calculateFinalLevel(svt, finalRemP, initData.oldRemP);
      if (newLv > initData.oldLv) {
        levelUpSummary.push({
          name: initData.name,
          oldLv: initData.oldLv,
          newLv: newLv
        });
      }
    }
  });

  // 最終到達Lvの降順にソート
  levelUpSummary.sort((a, b) => b.newLv - a.newLv);

  // 結果をVueのリアクティブデータに代入
  scheduleResults.value = {
    totalRuns: totalRuns,
    phases: phases,
    levelUpSummary: levelUpSummary
  };

  console.log("Advanced Greedy Scheduler Finished. Total Runs:", totalRuns);


  // ==========================================
  // 以下、内部計算用のヘルパー関数群
  // ==========================================

  function hasMatchingTraitCE(svt, pool) {
    if (!svt || !svt.traits) return false;
    for (let trait of svt.traits) {
      if (pool[trait] > 0 || pool[`trait_${trait}`] > 0) {
        return true;
      }
    }
    return false;
  }

  function getRequiredPForLevel(lvl, collectionNo) {
    if (lvl >= 10 && lvl < 15) {
      return BOND_REQ_11_TO_15[lvl];
    }
    if (lvl < 10) {
      const reqs = (typeof BOND_REQUIREMENTS !== 'undefined') ? BOND_REQUIREMENTS[collectionNo] : null;
      if (reqs && typeof reqs[lvl] === 'number') {
        return reqs[lvl];
      }
      return BOND_REQ_1_TO_10[lvl];
    }
    return Infinity;
  }

  function calculateFinalLevel(svt, finalRemP, initialRemP) {
    const initialLv = svt.currentLv;
    if (initialLv === null || initialLv === undefined) return initialLv;

    let gainedP = initialRemP - finalRemP;
    if (gainedP <= 0) return initialLv;

    let level = initialLv;
    let nextExp = (svt.nextExp !== null && svt.nextExp !== undefined && svt.nextExp !== '') 
      ? Number(svt.nextExp) 
      : getRequiredPForLevel(level, svt.collectionNo);

    while (level < 15 && gainedP >= nextExp) {
      gainedP -= nextExp;
      level++;
      nextExp = getRequiredPForLevel(level, svt.collectionNo);
    }
    return level;
  }

  function calculateTotalCost(currentParty, costFnSvt, costFnCE) {
    let total = 0;
    for (let node of currentParty) {
      if (node && node.svt) {
        total += costFnSvt(node.svt);
        // 第1礼装のみをコスト計算の対象とする（第2礼装は無視）
        total += costFnCE(node.equippedCE);
      }
    }
    return total;
  }

  function tryDowngradeCE(node, pool, costFnCE) {
    if (node.isFixedCE1) return false;
    const currentCE = node.equippedCE;
    const cost = costFnCE(currentCE);

    if (cost <= 0) return false;

    // 12(特攻/LT/TT) -> 9(極点) -> 5(肖像) -> 0(なし)
    if (cost === 12) {
      if (pool['kyokuten'] > 0) {
        pool['kyokuten']--;
        returnCEToPool(currentCE, pool);
        node.equippedCE = 'kyokuten';
        return true;
      }
      if (pool['portrait'] > 0) {
        pool['portrait']--;
        returnCEToPool(currentCE, pool);
        node.equippedCE = 'portrait';
        return true;
      }
      returnCEToPool(currentCE, pool);
      node.equippedCE = 'none';
      return true;
    } else if (cost === 9) {
      if (pool['portrait'] > 0) {
        pool['portrait']--;
        returnCEToPool(currentCE, pool);
        node.equippedCE = 'portrait';
        return true;
      }
      returnCEToPool(currentCE, pool);
      node.equippedCE = 'none';
      return true;
    } else if (cost === 5) {
      returnCEToPool(currentCE, pool);
      node.equippedCE = 'none';
      return true;
    }
    return false;
  }

  function returnCEToPool(ce, pool) {
    if (ce !== 'none') {
      if (pool[ce] !== undefined) pool[ce]++;
      else pool[ce] = 1;
    }
  }


};