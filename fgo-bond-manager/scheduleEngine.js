// fgo-bond-manager/scheduleEngine.js

window.generateSchedule = function({
  servants,
  availableTraits,
  battleTemplates,
  selectedTemplateId,
  ownedCEs,
  scheduleResults,
  BOND_REQ_11_TO_15,
  BOND_REQ_1_TO_10,
  calculateTargetRemainingP,
  getServantCost,
  getCECost,
  formatCEName
}) {
  // 1. 目標未達成のサーヴァントを抽出
  let unfinished = servants
    .filter(s => s.owned && s.currentLv !== null && s.currentLv !== '' && s.currentLv < (s.targetLevel || 10))
    .map(s => ({
      id: s.id,
      name: s.name,
      iconUrl: s.iconUrl || s.face || '',
      className: s.className,
      rarity: s.rarity,
      currentLv: s.currentLv,
      targetLevel: s.targetLevel || 10,
      remainingP: calculateTargetRemainingP(s),
      collectionNo: s.collectionNo,
      nextExp: s.nextExp,
      traits: availableTraits.filter(t => s[t])
    }))
    .filter(s => s.remainingP > 0);

  if (unfinished.length === 0) {
    alert('目標未達成のサーヴァント（所持かつ絆Lvが目標未満）がいません。\n「所持鯖管理」タブで所持・絆Lv・目標Lvを設定してください。');
    return;
  }

  if (battleTemplates.length === 0) {
    alert('バトルテンプレートを1つ以上設定してください。');
    return;
  }

  // 2. 特性の出現頻度（人気度）をカウントしてスコア付け
  const traitCounts = {};
  availableTraits.forEach(t => { traitCounts[t] = 0; });
  unfinished.forEach(s => {
    s.traits.forEach(t => { traitCounts[t]++; });
  });
  unfinished.forEach(s => {
    s.traitScore = s.traits.reduce((sum, t) => sum + (traitCounts[t] || 0), 0);
  });

  // 3. サーヴァントキューのソート
  // - 特性スコア（降順）：特性の重なりが多い鯖を優先してCE効果を極大化
  // - 残りポイント（昇順）：あと少しで卒業する鯖を優先して枠を空ける
  let servantQueue = [...unfinished].sort((a, b) => {
    if (b.traitScore !== a.traitScore) return b.traitScore - a.traitScore;
    return a.remainingP - b.remainingP;
  });

  // シミュレーション進捗のコピー初期化
  const simProgress = {};
  unfinished.forEach(s => {
    simProgress[s.id] = {
      id: s.id,
      name: s.name,
      collectionNo: s.collectionNo,
      currentLv: s.currentLv,
      targetLevel: s.targetLevel,
      nextExp: s.nextExp
    };
  });

  const processedPhases = [];
  let phaseId = 1;
  const maxPhases = 100; // 安全のための最大フェーズ数上限

  // 4. シミュレーションループ開始
  while (servantQueue.some(s => simProgress[s.id].currentLv < s.targetLevel)) {
    // 4.1. 候補となるバトルテンプレートの選定（個別指定 or すべてのバトルから自動最適化）
    let templatesToEvaluate = [];
    if (selectedTemplateId === 'all') {
      templatesToEvaluate = battleTemplates;
    } else {
      const match = battleTemplates.find(t => t.id === parseFloat(selectedTemplateId));
      templatesToEvaluate = match ? [match] : [battleTemplates[0]];
    }

    const candidateInfos = [];

    // 4.2. 各候補テンプレートについて編成と絆効率をシミュレート
    templatesToEvaluate.forEach(tmpl => {
      const baseBond = tmpl.baseBond;
      const useTeapot = tmpl.useTeapot !== false;

      const currentPartyList = [null, null, null, null, null];

      // ① 固定枠サーヴァントの割当
      tmpl.constraints.fixedSlots.forEach((fixedId, slotIdx) => {
        if (fixedId) {
          const svtInfo = servants.find(s => s.id === fixedId);
          if (svtInfo) {
            currentPartyList[slotIdx] = {
              id: svtInfo.id,
              name: svtInfo.name,
              iconUrl: svtInfo.iconUrl || svtInfo.face || '',
              className: svtInfo.className,
              rarity: svtInfo.rarity,
              traits: availableTraits.filter(t => svtInfo[t]),
              isFixed: true
            };
          }
        }
      });

      // クラス制限の展開・判定
      let allowedClassSet = null;
      if (tmpl.constraints.allowedClasses && tmpl.constraints.allowedClasses.length > 0) {
        const classes = tmpl.constraints.allowedClasses.map(c => c.toLowerCase());
        if (!classes.includes('all')) {
          allowedClassSet = new Set();
          classes.forEach(c => {
            if (c === 'ex1') {
              ['ruler', 'avenger', 'shielder', 'mooncancer'].forEach(cls => allowedClassSet.add(cls));
            } else if (c === 'ex2') {
              ['alterego', 'foreigner', 'pretender', 'beast'].forEach(cls => allowedClassSet.add(cls));
            } else {
              allowedClassSet.add(c);
            }
          });
        }
      }

      // ③ 配置ボーナス（配置ボーナスプリセット連動）の事前算出
      let partyBonus = [1.24, 1.24, 1.04, 1.04, 1.04]; // デフォルト前衛
      if (tmpl.bonusPreset === 'back') {
        partyBonus = [1.20, 1.20, 1.20, 1.00, 1.00];
      } else if (tmpl.bonusPreset === 'none') {
        partyBonus = [1.00, 1.00, 1.00, 1.00, 1.00];
      }

      // ② 自由枠に目標キューから出撃可能なサーヴァントを優先的に編成
      const freeSlotIndices = [];
      for (let i = 0; i < 5; i++) {
        if (currentPartyList[i] === null) {
          freeSlotIndices.push(i);
        }
      }
      freeSlotIndices.sort((a, b) => partyBonus[b] - partyBonus[a]);

      // このフェーズで出撃可能な候補サーヴァントを抽出
      const phaseCandidates = servantQueue.filter(s => {
        const alreadyInParty = currentPartyList.some(p => p && p.id === s.id);
        if (alreadyInParty) return false;

        const prog = simProgress[s.id];
        if (prog.currentLv >= s.targetLevel) return false;

        if (allowedClassSet) {
          return allowedClassSet.has(s.className.toLowerCase());
        }
        return true;
      });

      // 1. クエスト制限（クラス制限など）を満たす出撃可能候補内での特性の出現頻度（人気度）をカウント
      const phaseTraitCounts = {};
      availableTraits.forEach(t => { phaseTraitCounts[t] = 0; });
      phaseCandidates.forEach(s => {
        s.traits.forEach(t => { phaseTraitCounts[t]++; });
      });

      // 2. このクエストの候補内における特性スコア（人気度）を割り当て
      phaseCandidates.forEach(s => {
        s.phaseTraitScore = s.traits.reduce((sum, t) => sum + (phaseTraitCounts[t] || 0), 0);
      });

      // 3. 特性スコア（降順） -> 目標までの残り必要ポイント（降順）でソート！
      phaseCandidates.sort((a, b) => {
        if (b.phaseTraitScore !== a.phaseTraitScore) {
          return b.phaseTraitScore - a.phaseTraitScore;
        }
        const remA = calculateTargetRemainingP(simProgress[a.id]);
        const remB = calculateTargetRemainingP(simProgress[b.id]);
        return remB - remA; // 降順
      });

      // 高い配置ボーナスのスロットから順に、残り必要ポイントの多いサーヴァントを配置
      freeSlotIndices.forEach((slotIdx, idx) => {
        if (idx < phaseCandidates.length) {
          const s = phaseCandidates[idx];
          currentPartyList[slotIdx] = {
            id: s.id,
            name: s.name,
            iconUrl: s.iconUrl || s.face || '',
            className: s.className,
            rarity: s.rarity,
            traits: s.traits,
            isFixed: false
          };
        }
      });

      // 出撃サーヴァントが1体も配置されなかった場合は効率0
      const hasBondTargets = currentPartyList.some(p => p && !p.isFixed && simProgress[p.id].currentLv < simProgress[p.id].targetLevel);
      if (!hasBondTargets) {
        candidateInfos.push({ efficiencyScore: 0 });
        return;
      }

      // ④ 戴冠戦特別ルールの判定（設定されたスロットをGrand化、フレンド礼装2枠化）
      const grandSlotIdx = (tmpl.grandSlot !== undefined && tmpl.grandSlot !== null) ? tmpl.grandSlot - 1 : -1;
      const isGrand = [false, false, false, false, false];
      if (grandSlotIdx >= 0 && grandSlotIdx < 5) {
        isGrand[grandSlotIdx] = true;
      }

      // ⑤ 自陣の最適な概念礼装を決定（重複不可コスト118制限＋ティータイム重複可能）
      const partyCEs = ['none', 'none', 'none', 'none', 'none'];
      const partyCEs2 = ['none', 'none', 'none', 'none', 'none'];

      // 固定礼装の適用
      tmpl.constraints.fixedCEs.forEach((fixedCe, slotIdx) => {
        if (fixedCe) partyCEs[slotIdx] = fixedCe;
      });

      // 利用可能な礼装プール
      const pool = [];
      if (ownedCEs.lunchtime && !tmpl.constraints.fixedCEs.includes('lunchtime')) pool.push('lunchtime');
      if (ownedCEs.kyokuten && !tmpl.constraints.fixedCEs.includes('kyokuten')) pool.push('kyokuten');
      if (ownedCEs.portrait && !tmpl.constraints.fixedCEs.includes('portrait')) pool.push('portrait');
      (ownedCEs.traitCEs || []).forEach(tr => {
        const trCE = `trait_${tr}`;
        if (!tmpl.constraints.fixedCEs.includes(trCE)) pool.push(trCE);
      });

      // 各スロットに最適な礼装を割り当て
      for (let i = 0; i < 5; i++) {
        const member = currentPartyList[i];
        if (!member || tmpl.constraints.fixedCEs[i]) continue;

        // 第1礼装スロット
        let selectedCE = 'none';
        const bestTraitCeIdx = pool.findIndex(ce => ce.startsWith('trait_') && member.traits.includes(ce.replace('trait_', '')));
        if (bestTraitCeIdx !== -1) {
          selectedCE = pool.splice(bestTraitCeIdx, 1)[0];
        } else if (pool.includes('lunchtime')) {
          selectedCE = pool.splice(pool.indexOf('lunchtime'), 1)[0];
        } else if (ownedCEs.teatime) {
          selectedCE = 'teatime';
        } else if (pool.includes('kyokuten')) {
          selectedCE = pool.splice(pool.indexOf('kyokuten'), 1)[0];
        } else if (pool.includes('portrait')) {
          selectedCE = pool.splice(pool.indexOf('portrait'), 1)[0];
        }
        partyCEs[i] = selectedCE;

        // 戴冠戦の第2礼装スロット（Grandスロットのみ）
        if (isGrand[i]) {
          let selectedCE2 = 'none';
          if (pool.includes('lunchtime')) {
            selectedCE2 = pool.splice(pool.indexOf('lunchtime'), 1)[0];
          } else if (ownedCEs.teatime) {
            selectedCE2 = 'teatime';
          } else if (pool.includes('kyokuten')) {
            selectedCE2 = pool.splice(pool.indexOf('kyokuten'), 1)[0];
          } else if (pool.includes('portrait')) {
            selectedCE2 = pool.splice(pool.indexOf('portrait'), 1)[0];
          }
          partyCEs2[i] = selectedCE2;
        }
      }

      // ⑤-A. コスト調整プロセス
      let costOptimized = false;
      
      const getCalculatedCost = () => {
        let total = 0;
        for (let i = 0; i < 5; i++) {
          const p = currentPartyList[i];
          if (p) {
            total += getServantCost(p, false);
            total += getCECost(partyCEs[i]);
            if (isGrand[i]) {
              total += getCECost(partyCEs2[i]);
            }
          }
        }
        return total;
      };

      while (getCalculatedCost() > 118) {
        const downgradeCandidates = [];
        for (let i = 0; i < 5; i++) {
          if (!currentPartyList[i]) continue;

          if (!tmpl.constraints.fixedCEs[i]) {
            const ce1 = partyCEs[i];
            if (ce1 !== 'none') {
              downgradeCandidates.push({
                slotIdx: i,
                isSecondCE: false,
                currentCE: ce1,
                cost: getCECost(ce1),
                bonus: partyBonus[i]
              });
            }
          }

          if (isGrand[i]) {
            const ce2 = partyCEs2[i];
            if (ce2 !== 'none') {
              downgradeCandidates.push({
                slotIdx: i,
                isSecondCE: true,
                currentCE: ce2,
                cost: getCECost(ce2),
                bonus: partyBonus[i]
              });
            }
          }
        }

        if (downgradeCandidates.length === 0) {
          break;
        }

        downgradeCandidates.sort((a, b) => {
          if (a.bonus !== b.bonus) return a.bonus - b.bonus;
          if (a.slotIdx !== b.slotIdx) return b.slotIdx - a.slotIdx;
          return a.isSecondCE ? -1 : 1;
        });

        const target = downgradeCandidates[0];
        let nextCE = 'none';

        if (target.currentCE === 'teatime' || target.currentCE === 'lunchtime' || target.currentCE.startsWith('trait_')) {
          nextCE = 'kyokuten';
        } else if (target.currentCE === 'kyokuten') {
          nextCE = 'portrait';
        } else if (target.currentCE === 'portrait') {
          nextCE = 'none';
        }

        if (target.isSecondCE) {
          partyCEs2[target.slotIdx] = nextCE;
        } else {
          partyCEs[target.slotIdx] = nextCE;
        }
        costOptimized = true;
      }

      // ⑥ フレンドサポート礼装の決定
      const friendCEs = ['teatime'];
      if (tmpl.friendDoubleCE) {
        let bestFriendCE2 = 'none';
        // 自陣編成メンバーが持つ特性の出現頻度をカウント
        const partyTraitCounts = {};
        availableTraits.forEach(tr => { partyTraitCounts[tr] = 0; });
        currentPartyList.forEach(p => {
          if (p && p.traits) {
            p.traits.forEach(tr => { partyTraitCounts[tr]++; });
          }
        });

        // 最も多くのメンバーが持っている特性をサポート礼装として選択
        let bestTrait = null;
        let maxCount = 0;
        availableTraits.forEach(tr => {
          if (partyTraitCounts[tr] > maxCount) {
            maxCount = partyTraitCounts[tr];
            bestTrait = tr;
          }
        });

        if (bestTrait) {
          bestFriendCE2 = `trait_${bestTrait}`;
        } else {
          bestFriendCE2 = 'lunchtime';
        }
        friendCEs.push(bestFriendCE2);
      }

      // ⑦ 絆15ボーナスの計算
      let simulatedLv15Count = 0;
      currentPartyList.forEach(p => {
        if (p && simProgress[p.id].currentLv >= 15) simulatedLv15Count++;
      });
      const lv15Percent = simulatedLv15Count * 25;

      // ⑧ 各メンバーの perRunBond 計算
      const calculatedParty = currentPartyList.map((p, slotIdx) => {
        if (!p) {
          return {
            id: null,
            name: '空き枠',
            iconUrl: '',
            className: '',
            rarity: 0,
            equippedCE: 'none',
            perRunBond: 0,
            completed: false,
            servantCost: 0,
            ceCost: 0,
            cost: 0
          };
        }

        const base = baseBond;
        const B = partyBonus[slotIdx];
        const C = Math.floor(base * B);

        let percent = 0;
        const ce = partyCEs[slotIdx];
        if (ce === 'teatime') percent += 5;
        else if (ce === 'lunchtime') percent += 10;
        else if (ce === 'kyokuten') percent += 2;
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (p.traits.includes(trait)) percent += 20;
        }

        if (isGrand[slotIdx]) {
          const ce2 = partyCEs2[slotIdx];
          if (ce2 === 'teatime') percent += 5;
          else if (ce2 === 'lunchtime') percent += 10;
          else if (ce2 === 'kyokuten') percent += 2;
          else if (ce2 && ce2.startsWith('trait_')) {
            const trait = ce2.replace('trait_', '');
            if (p.traits.includes(trait)) percent += 20;
          }
        }

        friendCEs.forEach(fCE => {
          if (fCE === 'teatime') percent += 15;
          else if (fCE === 'lunchtime') percent += 10;
          else if (fCE === 'kyokuten') percent += 2;
          else if (fCE && fCE.startsWith('trait_')) {
            const trait = fCE.replace('trait_', '');
            if (p.traits.includes(trait)) percent += 20;
          }
        });

        percent += lv15Percent;

        let portraitCount = 0;
        if (ce === 'portrait') portraitCount++;
        if (isGrand[slotIdx] && partyCEs2[slotIdx] === 'portrait') portraitCount++;
        friendCEs.forEach(fCE => { if (fCE === 'portrait') portraitCount++; });
        const flatBonus = portraitCount * 50;

        const Y = Math.floor(C * (percent / 100));
        let total = C + Y + flatBonus;
        if (useTeapot) total *= 2;

        const servantCost = getServantCost(p, false);
        const ceCost = getCECost(ce) + (isGrand[slotIdx] ? getCECost(partyCEs2[slotIdx]) : 0);

        return {
          id: p.id,
          name: p.name,
          iconUrl: p.iconUrl,
          className: p.className,
          rarity: p.rarity,
          equippedCE: ce,
          perRunBond: total,
          completed: simProgress[p.id].currentLv >= p.targetLevel,
          servantCost,
          ceCost,
          cost: servantCost + ceCost
        };
      });

      const totalCost = calculatedParty.reduce((sum, member) => sum + member.cost, 0);

      const totalBondGained = calculatedParty.reduce((sum, member) => {
        if (!member.id || member.completed) return sum;
        return sum + member.perRunBond;
      }, 0);
      const efficiencyScore = totalBondGained / tmpl.ap;

      candidateInfos.push({
        tmpl,
        calculatedParty,
        partyCEs,
        friendCEs,
        partyBonus,
        totalCost,
        efficiencyScore,
        costOptimized
      });
    });

    const validCandidates = candidateInfos.filter(c => c.efficiencyScore > 0);
    if (validCandidates.length === 0) {
      break;
    }

    validCandidates.sort((a, b) => b.efficiencyScore - a.efficiencyScore);
    const best = validCandidates[0];

    const tmpl = best.tmpl;
    const calculatedParty = best.calculatedParty;
    const partyCEs = best.partyCEs;
    const friendCEs = best.friendCEs;
    const partyBonus = best.partyBonus;
    const totalPhaseCost = best.totalCost;

    let minRunsNeeded = Infinity;
    calculatedParty.forEach(p => {
      if (p.id) {
        const prog = simProgress[p.id];
        if (prog && prog.currentLv < prog.targetLevel) {
          const ppr = p.perRunBond;
          if (ppr > 0) {
            const rem = calculateTargetRemainingP(prog);
            if (rem > 0) {
              const runs = Math.ceil(rem / ppr);
              if (runs > 0 && runs < minRunsNeeded) {
                minRunsNeeded = runs;
              }
            }
          }
        }
      }
    });

    if (minRunsNeeded === Infinity || minRunsNeeded <= 0) {
      minRunsNeeded = 1;
    }

    const completedServants = [];
    const BOND_REQUIREMENTS = window.BOND_REQUIREMENTS || {};

    calculatedParty.forEach(p => {
      if (!p.id) return;
      const prog = simProgress[p.id];
      if (!prog) return;

      if (prog.currentLv < prog.targetLevel) {
        let expPool = p.perRunBond * minRunsNeeded;
        const reqs = BOND_REQUIREMENTS[prog.collectionNo] || null;

        while (expPool > 0) {
          const currentLv = prog.currentLv;
          if (currentLv >= prog.targetLevel) {
            break;
          }

          let reqForNext = 0;
          if (currentLv >= 10 && currentLv < 15) reqForNext = BOND_REQ_11_TO_15[currentLv];
          else if (currentLv < 10 && reqs && typeof reqs[currentLv] === 'number') reqForNext = reqs[currentLv];
          else if (currentLv < 10 && typeof BOND_REQ_1_TO_10[currentLv] === 'number') reqForNext = BOND_REQ_1_TO_10[currentLv];

          let nextExp = (prog.nextExp !== null && prog.nextExp !== undefined && prog.nextExp !== '') ? Number(prog.nextExp) : reqForNext;

          if (expPool >= nextExp) {
            expPool -= nextExp;
            prog.currentLv += 1;
            prog.nextExp = null;
          } else {
            prog.nextExp = nextExp - expPool;
            expPool = 0;
          }
        }

        if (prog.currentLv >= prog.targetLevel) {
          completedServants.push(prog.name);
        }
      }
    });

    const ceLabels = partyCEs.map((ce, idx) => {
      if (!calculatedParty[idx].id) return null;
      return `${calculatedParty[idx].name}: ${formatCEName(ce)}`;
    }).filter(Boolean);

    processedPhases.push({
      id: phaseId++,
      questName: tmpl.name,
      baseBond: tmpl.baseBond,
      party: calculatedParty.map(member => ({
        ...member,
        completed: simProgress[member.id] ? simProgress[member.id].currentLv >= member.targetLevel : member.completed
      })),
      ceLabels: ceLabels,
      runs: minRunsNeeded,
      completedServants: completedServants,
      partyCEs: partyCEs,
      friendCEs: friendCEs.map(formatCEName),
      partyBonus: partyBonus,
      totalCost: totalPhaseCost,
      costOptimized: best.costOptimized,
      isOptimizedPlacement: true
    });

    servantQueue = servantQueue.filter(s => simProgress[s.id].currentLv < s.targetLevel);

    if (phaseId > maxPhases) {
      break;
    }
  }

  scheduleResults.value = {
    phases: processedPhases,
    totalRuns: processedPhases.reduce((sum, p) => sum + p.runs, 0),
    totalServants: unfinished.length,
    generatedAt: new Date().toLocaleString('ja-JP') + '（動的自動最適化）'
  };
};
