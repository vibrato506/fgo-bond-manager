const { createApp, ref, computed, onMounted, watch } = Vue;

const BOND_REQ_11_TO_15 = {
  10: 1090000, 11: 1230000, 12: 1360000, 13: 1500000, 14: 1640000
};

const BOND_REQ_1_TO_10 = {
  0: 10000, 1: 20000, 2: 30000, 3: 40000, 4: 250000,
  5: 300000, 6: 340000, 7: 360000, 8: 385000, 9: 390000
};

createApp({
  setup() {
    const isLoading = ref(true);
    const activeTab = ref('simulation');
    const servants = ref([]);
    
    const classIdMap = {
      saber: 1,
      lancer: 3,
      archer: 2,
      rider: 4,
      caster: 5,
      assassin: 6,
      berserker: 7,
      shielder: 8,
      ruler: 9,
      alterEgo: 10,
      avenger: 11,
      moonCancer: 23,
      foreigner: 25,
      pretender: 28,
      beast: 33,
      ex1: 1004,
      ex2: 1005
    };

    // 固定の11特性リスト
    const availableTraits = ref([
      'セイバー', 'キャスター', 'ライダー', 'ケモノ科', '今を生きる人類', 
      '秩序かつ善', '霊衣を持つ者', '秩序かつ女性', '星または悪', 
      '混沌かつ七騎士', '中立'
    ]);
    
    const getDefaultParty = (name = '編成1', id = null) => ({
      id: id || Date.now(),
      name,
      baseBond: 4748,
      teapotActive: false,
      extraGlobalPercent: 0,
      friendCEs: ['teatime', 'none'],
      party: [null, null, null, null, null],
      partyCEs: ['none', 'none', 'none', 'none', 'none'],
      partyCEs2: ['none', 'none', 'none', 'none', 'none'],
      isGrand: [false, false, false, false, false],
      mashCost16: [false, false, false, false, false],
      partyBonus: [1.24, 1.24, 1.04, 1.04, 1.04]
    });

    const parties = ref([getDefaultParty()]);
    const activePartyIndex = ref(0);
    const currentParty = computed(() => parties.value[activePartyIndex.value]);

    const filter = ref({ 
      possession: 'all', 
      search: '',
      rarity: 'all',
      classNames: [], // 複数選択（OR条件）のために配列へ変更
      trait: 'all'
    });

    const toggleClassFilter = (cls) => {
      const idx = filter.value.classNames.indexOf(cls);
      if (idx === -1) {
        filter.value.classNames.push(cls);
      } else {
        filter.value.classNames.splice(idx, 1);
      }
    };

    const filterExpanded = ref(true);

    const ownedCEs = ref({
      teatime: true,
      lunchtime: true,
      kyokuten: true,
      portrait: true,
      traitCEs: []
    });

    const getDefaultBattleTemplate = (name = '新規バトル', baseBond = 855, ap = 40) => ({
      id: Date.now() + Math.random(),
      name,
      baseBond,
      ap,
      useTeapot: false,
      bonusPreset: 'front', // 'front', 'back', 'none'
      grandSlot: null, // null, 1, 2, 3, 4, 5 (1-indexed)
      friendDoubleCE: false, // true or false
      constraints: {
        allowedClasses: [],
        fixedSlots: [null, null, null, null, null],
        fixedCEs: [null, null, null, null, null]
      },
      notes: ''
    });

    const defaultCoronation = getDefaultBattleTemplate('狂戴冠戦', 4748, 40);
    defaultCoronation.grandSlot = 1;
    defaultCoronation.friendDoubleCE = true;
    defaultCoronation.constraints.allowedClasses = ['berserker'];

    const battleTemplates = ref([
      defaultCoronation
    ]);

    const selectedTemplateId = ref('all');
    const scheduleResults = ref(null);
    const scheduleCheckpoints = ref({});

    const traitCEOptions = computed(() => {
      return availableTraits.value.map(t => ({ value: t, label: `20%礼装 (${t})` }));
    });

    onMounted(async () => {
      await fetchAtlasData();
      isLoading.value = false;

      // ローカルストレージからの読み込みとマイグレーション
      const savedTemplates = localStorage.getItem('fgo_bond_manager_templates');
      if (savedTemplates) {
        try {
          const parsed = JSON.parse(savedTemplates);
          if (Array.isArray(parsed)) {
            battleTemplates.value = parsed.map(t => {
              const def = getDefaultBattleTemplate(t.name, t.baseBond, t.ap);
              return {
                ...def,
                ...t,
                constraints: {
                  ...def.constraints,
                  ...(t.constraints || {})
                }
              };
            });
          }
        } catch (e) {}
      }
      const savedOwnedCEs = localStorage.getItem('fgo_bond_manager_owned_ces');
      if (savedOwnedCEs) {
        try {
          const parsed = JSON.parse(savedOwnedCEs);
          ownedCEs.value = {
            teatime: parsed.teatime !== undefined ? parsed.teatime : true,
            lunchtime: parsed.lunchtime !== undefined ? parsed.lunchtime : true,
            kyokuten: parsed.kyokuten !== undefined ? parsed.kyokuten : true,
            portrait: parsed.portrait !== undefined ? parsed.portrait : true,
            traitCEs: parsed.traitCEs || []
          };
        } catch (e) {}
      }
      const savedSelTmpl = localStorage.getItem('fgo_bond_manager_selected_template');
      if (savedSelTmpl) {
        selectedTemplateId.value = savedSelTmpl;
      }
      const savedCheckpoints = localStorage.getItem('fgo_bond_manager_checkpoints');
      if (savedCheckpoints) {
        try {
          scheduleCheckpoints.value = JSON.parse(savedCheckpoints);
        } catch (e) {}
      }
    });

    watch(servants, () => { saveToLocalStorage(); }, { deep: true });
    watch(parties, () => { saveToLocalStorage(); }, { deep: true });
    watch(activePartyIndex, () => { saveToLocalStorage(); });
    watch(battleTemplates, () => { saveToLocalStorage(); }, { deep: true });
    watch(ownedCEs, () => { saveToLocalStorage(); }, { deep: true });
    watch(selectedTemplateId, () => { saveToLocalStorage(); });
    watch(scheduleCheckpoints, () => { saveToLocalStorage(); }, { deep: true });

    const saveToLocalStorage = () => {
      // ユーザー固有の入力データだけを抽出して保存 (IDベースで保存するのが理想だが、既存のセーブデータ引継ぎのため名前にする)
      const userData = servants.value.map(s => ({
        id: s.id,
        name: s.name,
        owned: s.owned,
        currentLv: s.currentLv,
        targetLevel: s.targetLevel,
        nextExp: s.nextExp
      })).filter(s => s.owned || s.currentLv !== null || s.nextExp !== null || s.targetLevel !== 10);

      localStorage.setItem('fgo_bond_manager_userdata_v3', JSON.stringify(userData));
      localStorage.setItem('fgo_bond_manager_parties_v1', JSON.stringify(parties.value));
      localStorage.setItem('fgo_bond_manager_active_party', activePartyIndex.value.toString());
      localStorage.setItem('fgo_bond_manager_templates', JSON.stringify(battleTemplates.value));
      localStorage.setItem('fgo_bond_manager_owned_ces', JSON.stringify(ownedCEs.value));
      localStorage.setItem('fgo_bond_manager_selected_template', selectedTemplateId.value);
      localStorage.setItem('fgo_bond_manager_checkpoints', JSON.stringify(scheduleCheckpoints.value));
    };

    const fetchAtlasData = async () => {
      try {
        const response = await fetch('https://api.atlasacademy.io/export/JP/basic_svt.json');
        const rawData = await response.json();

        // プレイヤブルなサーヴァントのみを抽出 (Mashは通常ID:800100)
        const playableSvts = rawData.filter(s => s.type === 'normal' || s.type === 'heroine');

        // AtlasのTraits配列から各種条件を満たしているか判定する関数
        const hasTrait = (svt, traitName) => {
          return svt.traits.some(t => t.name === traitName);
        };

        const parsedServants = playableSvts.map(s => {
          const svt = {
            id: s.id,
            collectionNo: s.collectionNo,
            name: s.name,
            iconUrl: s.face || '',
            className: s.className,
            rarity: s.rarity,
            // ユーザー設定のデフォルト
            owned: false,
            currentLv: null,
            targetLevel: 10,
            nextExp: null
          };

          // 11特性の動的判定
          svt['セイバー'] = s.className === 'saber';
          svt['キャスター'] = s.className === 'caster';
          svt['ライダー'] = s.className === 'rider';
          svt['ケモノ科'] = hasTrait(s, 'havingAnimalsCharacteristics');
          svt['今を生きる人類'] = hasTrait(s, 'livingHuman');
          svt['秩序かつ善'] = hasTrait(s, 'alignmentLawful') && hasTrait(s, 'alignmentGood');
          svt['霊衣を持つ者'] = hasTrait(s, 'hasCostume');
          svt['秩序かつ女性'] = hasTrait(s, 'alignmentLawful') && hasTrait(s, 'genderFemale');
          svt['星または悪'] = hasTrait(s, 'attributeStar') || hasTrait(s, 'alignmentEvil');
          
          const isStandardClass = ['saber', 'archer', 'lancer', 'rider', 'caster', 'assassin', 'berserker'].includes(s.className);
          svt['混沌かつ七騎士'] = hasTrait(s, 'alignmentChaotic') && isStandardClass;
          
          svt['中立'] = hasTrait(s, 'alignmentNeutral');

          return svt;
        });

        // 重複名の対応など（同じ名前ならIDが新しい方を優先したり、ID順にしたり）
        // ユーザーのセーブデータを読み込んでマージ
        const savedParties = localStorage.getItem('fgo_bond_manager_parties_v1');
        if (savedParties) {
          try {
            const parsed = JSON.parse(savedParties);
            if (Array.isArray(parsed)) {
              parties.value = parsed.map(p => {
                const def = getDefaultParty(p.name, p.id);
                return {
                  ...def,
                  ...p,
                  party: p.party || def.party,
                  partyCEs: p.partyCEs || def.partyCEs,
                  partyCEs2: p.partyCEs2 || def.partyCEs2,
                  isGrand: p.isGrand || def.isGrand,
                  mashCost16: p.mashCost16 || def.mashCost16,
                  partyBonus: p.partyBonus || def.partyBonus
                };
              });
            }
          } catch (e) {}
        } else {
          const savedSettings = localStorage.getItem('fgo_bond_manager_settings_v2');
          if (savedSettings) {
            try {
              const parsed = JSON.parse(savedSettings);
              const migrated = getDefaultParty('編成1');
              Object.assign(migrated, parsed);
              if (!migrated.partyCEs2) migrated.partyCEs2 = ['none', 'none', 'none', 'none', 'none'];
              if (!migrated.isGrand) migrated.isGrand = [false, false, false, false, false];
              if (!migrated.mashCost16) migrated.mashCost16 = [false, false, false, false, false];
              if (!migrated.friendCEs) migrated.friendCEs = ['teatime', 'none'];
              parties.value = [migrated];
            } catch (e) { }
          }
        }
        const savedIndex = localStorage.getItem('fgo_bond_manager_active_party');
        if (savedIndex !== null) {
          const idx = parseInt(savedIndex, 10);
          if (idx >= 0 && idx < parties.value.length) activePartyIndex.value = idx;
        }

        // 旧セーブデータ（V2）からの引継ぎ、またはV3からの読み込み
        const savedUserDataV3 = localStorage.getItem('fgo_bond_manager_userdata_v3');
        const savedServantsV2 = localStorage.getItem('fgo_bond_manager_servants');

        if (savedUserDataV3) {
          const userData = JSON.parse(savedUserDataV3);
          userData.forEach(ud => {
            const match = parsedServants.find(s => s.id === ud.id);
            if (match) {
              match.owned = ud.owned;
              match.currentLv = ud.currentLv;
              match.targetLevel = ud.targetLevel || 10;
              match.nextExp = ud.nextExp !== undefined ? ud.nextExp : (ud.remainingP !== undefined ? ud.remainingP : null);
            }
          });
        } else if (savedServantsV2) {
          // V2からのマイグレーション (名前ベースでのマッチング)
          const oldData = JSON.parse(savedServantsV2);
          oldData.forEach(od => {
            // （）や〔〕などの旧表記揺れを削除してマッチ
            const searchName = od.name.replace(/（.*）|〔.*〕/, '').trim();
            const match = parsedServants.find(s => s.name.includes(searchName));
            if (match) {
              match.owned = od.owned;
              match.currentLv = od.currentLv;
              match.targetLevel = od.targetLevel || 10;
              match.remainingP = od.remainingP;
            }
          });
        }

        servants.value = parsedServants.sort((a, b) => a.id - b.id);

      } catch (error) {
        console.error("API取得エラー:", error);
        alert("データの取得に失敗しました。インターネット接続を確認してください。");
      }
    };

    const saveData = () => {
      saveToLocalStorage();
      alert('データを保存しました。次回アクセス時もこの状態から復元されます。');
    };

    const addBattleTemplate = () => {
      battleTemplates.value.push(getDefaultBattleTemplate());
    };

    const removeBattleTemplate = (idx) => {
      if (battleTemplates.value.length <= 1) {
        alert('最低1つのバトルは残す必要があります。');
        return;
      }
      battleTemplates.value.splice(idx, 1);
    };

    const toggleCheckpoint = (phase) => {
      saveToLocalStorage();
      alert(`Phase ${phase.id} の進捗を反映しました！`);
    };

    const exportScheduleJSON = () => {
      if (!scheduleResults.value) return;
      const dataStr = JSON.stringify(scheduleResults.value, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fgo_schedule_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    const resetData = () => {
      if (confirm('初期データにリセットしますか？入力した所持状況や絆Lvなどはすべて消去されます。')) {
        servants.value.forEach(s => {
          s.owned = false;
          s.currentLv = null;
          s.targetLevel = 10;
          s.nextExp = null;
        });
        currentParty.value.party = [null, null, null, null, null];
        currentParty.value.partyCEs = ['none', 'none', 'none', 'none', 'none'];
        currentParty.value.partyCEs2 = ['none', 'none', 'none', 'none', 'none'];
        currentParty.value.isGrand = [false, false, false, false, false];
        currentParty.value.mashCost16 = [false, false, false, false, false];
        currentParty.value.friendCEs = ['teatime', 'none'];
        currentParty.value.partyBonus = [1.24, 1.24, 1.04, 1.04, 1.04];
        saveToLocalStorage();
      }
    };

    const addParty = () => {
      const newId = Date.now();
      const newName = `編成${parties.value.length + 1}`;
      parties.value.push(getDefaultParty(newName, newId));
      activePartyIndex.value = parties.value.length - 1;
      saveToLocalStorage();
    };

    const copyParty = (index) => {
      const sourceParty = parties.value[index];
      if (!sourceParty) return;
      const newId = Date.now();
      const newName = `${sourceParty.name}のコピー`;
      const cloned = JSON.parse(JSON.stringify(sourceParty));
      cloned.id = newId;
      cloned.name = newName;
      parties.value.splice(index + 1, 0, cloned);
      activePartyIndex.value = index + 1;
      saveToLocalStorage();
    };

    const removeParty = (index) => {
      if (parties.value.length <= 1) {
        alert('最低1つの編成は残す必要があります。');
        return;
      }
      if (confirm(`「${parties.value[index].name}」を削除しますか？`)) {
        parties.value.splice(index, 1);
        if (activePartyIndex.value >= parties.value.length) {
          activePartyIndex.value = parties.value.length - 1;
        }
        saveToLocalStorage();
      }
    };

    // ----- UI・選択肢用データ -----
    const partyCEOptions = computed(() => {
      const base = [
        { value: 'none', label: 'なし' },
        { value: 'teatime', label: 'カルデア・ティータイム (+5%)' },
        { value: 'lunchtime', label: 'カルデア・ランチタイム (+10%)' },
        { value: 'kyokuten', label: '英霊極点 (+2%)' },
        { value: 'portrait', label: '英霊肖像 (+50)' }
      ];
      availableTraits.value.forEach(trait => {
        base.push({ value: `trait_${trait}`, label: `20%礼装 (${trait})` });
      });
      return base;
    });

    const friendCEOptions = computed(() => {
      return partyCEOptions.value.map(opt => {
        if (opt.value === 'teatime') {
          return { ...opt, label: 'カルデア・ティータイム (+15%)' };
        }
        return opt;
      });
    });

    const classOptions = [
      { value: 'all', label: 'すべてのクラス' },
      { value: 'saber', label: 'セイバー' },
      { value: 'archer', label: 'アーチャー' },
      { value: 'lancer', label: 'ランサー' },
      { value: 'rider', label: 'ライダー' },
      { value: 'caster', label: 'キャスター' },
      { value: 'assassin', label: 'アサシン' },
      { value: 'berserker', label: 'バーサーカー' },
      { value: 'ruler', label: 'ルーラー' },
      { value: 'avenger', label: 'アヴェンジャー' },
      { value: 'alterEgo', label: 'アルターエゴ' },
      { value: 'moonCancer', label: 'ムーンキャンサー' },
      { value: 'foreigner', label: 'フォーリナー' },
      { value: 'pretender', label: 'プリテンダー' },
      { value: 'beast', label: 'ビースト' },
      { value: 'shielder', label: 'シールダー' }
    ];

    const ownedServantsList = computed(() => servants.value.filter(s => s.owned));

    const getPartyServant = (index) => {
      const idOrName = currentParty.value.party[index];
      if (!idOrName) return null;
      // 後方互換のためIDと名前の両方で検索（今後はID保存に移行）
      return servants.value.find(s => s.id === idOrName || s.name === idOrName) || null;
    };

    const clearSlot = (index) => {
      currentParty.value.party[index] = null;
      currentParty.value.partyCEs[index] = 'none';
    };

    const applyBonusPreset = (type) => {
      if (type === 'front') {
        currentParty.value.partyBonus = [1.24, 1.24, 1.0, 1.0, 1.0];
      } else if (type === 'back') {
        currentParty.value.partyBonus = [1.0, 1.0, 1.0, 1.0, 1.0];
      }
    };

    const getServantAllTraits = (svt) => {
      return availableTraits.value.filter(t => svt[t]);
    };

    const lv15BonusPercent = computed(() => {
      let count = 0;
      for (let i = 0; i < 5; i++) {
        const svt = getPartyServant(i);
        if (svt && svt.currentLv >= 15) {
          count++;
        }
      }
      return count * 25;
    });

    const getSlotBonusPercent = (index) => {
      const svt = getPartyServant(index);
      let percent = 0;
      currentParty.value.friendCEs.forEach(ce => {
        if (ce === 'teatime') percent += 15;
        else if (ce === 'lunchtime') percent += 10;
        else if (ce === 'kyokuten') percent += 2;
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (svt && svt[trait]) percent += 20;
        }
      });
      currentParty.value.partyCEs.forEach((ce, i) => {
        if (!currentParty.value.party[i]) return;
        if (ce === 'teatime') percent += 5;
        else if (ce === 'lunchtime') percent += 10;
        else if (ce === 'kyokuten') percent += 2;
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (svt && svt[trait]) percent += 20;
        }
      });

      if (currentParty.value.isGrand) {
        currentParty.value.isGrand.forEach((isG, i) => {
          if (!currentParty.value.party[i]) return;
          if (isG) {
            const ce2 = currentParty.value.partyCEs2[i];
            if (ce2 === 'teatime') percent += 5;
            else if (ce2 === 'lunchtime') percent += 10;
            else if (ce2 === 'kyokuten') percent += 2;
            else if (ce2 && ce2.startsWith('trait_')) {
              const trait = ce2.replace('trait_', '');
              if (svt && svt[trait]) percent += 20;
            }
          }
        });
      }

      percent += (currentParty.value.extraGlobalPercent || 0);
      percent += lv15BonusPercent.value;
      
      return percent;
    };

    const getSlotBonusDetails = (index) => {
      const svt = getPartyServant(index);
      let details = [];

      currentParty.value.friendCEs.forEach((ce, i) => {
        if (ce === 'teatime') details.push(`サポート礼装${i+1} (TT): +15%`);
        else if (ce === 'lunchtime') details.push(`サポート礼装${i+1} (LT): +10%`);
        else if (ce === 'kyokuten') details.push(`サポート礼装${i+1} (極点): +2%`);
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (svt && svt[trait]) details.push(`サポート礼装${i+1} (20%特攻): +20%`);
        }
      });

      currentParty.value.partyCEs.forEach((ce, i) => {
        if (!currentParty.value.party[i]) return;
        if (ce === 'teatime') details.push(`自陣枠${i+1} (TT): +5%`);
        else if (ce === 'lunchtime') details.push(`自陣枠${i+1} (LT): +10%`);
        else if (ce === 'kyokuten') details.push(`自陣枠${i+1} (極点): +2%`);
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (svt && svt[trait]) details.push(`自陣枠${i+1} (20%特攻): +20%`);
        }
      });

      if (currentParty.value.isGrand) {
        currentParty.value.isGrand.forEach((isG, i) => {
          if (!currentParty.value.party[i]) return;
          if (isG) {
            const ce2 = currentParty.value.partyCEs2[i];
            if (ce2 === 'teatime') details.push(`自陣枠${i+1}G (TT): +5%`);
            else if (ce2 === 'lunchtime') details.push(`自陣枠${i+1}G (LT): +10%`);
            else if (ce2 === 'kyokuten') details.push(`自陣枠${i+1}G (極点): +2%`);
            else if (ce2 && ce2.startsWith('trait_')) {
              const trait = ce2.replace('trait_', '');
              if (svt && svt[trait]) details.push(`自陣枠${i+1}G (20%特攻): +20%`);
            }
          }
        });
      }

      if (currentParty.value.extraGlobalPercent) {
        details.push(`その他の加算: +${currentParty.value.extraGlobalPercent}%`);
      }

      if (lv15BonusPercent.value > 0) {
        details.push(`絆15ボーナス: +${lv15BonusPercent.value}%`);
      }

      return details;
    };

    const calculateSlotPointsPerRun = (index) => {
      const svt = getPartyServant(index);
      if (!svt) return { total: 0, bonus: 0 };

      const base = currentParty.value.baseBond || 0;
      const percent = getSlotBonusPercent(index);
      const B = currentParty.value.partyBonus[index] || 1.0;
      const C = Math.floor(base * B); 

      let flatBonus = 0;
      currentParty.value.friendCEs.forEach(ce => { if (ce === 'portrait') flatBonus += 50; });
      currentParty.value.partyCEs.forEach(ce => { if (ce === 'portrait') flatBonus += 50; });
      
      if (currentParty.value.isGrand) {
        currentParty.value.isGrand.forEach((isG, idx) => {
          if (isG && currentParty.value.partyCEs2[idx] === 'portrait') flatBonus += 50;
        });
      }

      const Y = Math.floor(C * (percent / 100));
      let total = C + Y + flatBonus;
      if (currentParty.value.teapotActive) total *= 2;
      
      return { total, base, bonus: total - base };
    };

    const calculateTargetRemainingP = (svt) => {
      if (!svt) return null;
      const targetLv = svt.targetLevel || 10;
      const currentLv = svt.currentLv;
      
      if (currentLv === null || currentLv === undefined || currentLv === '') return null;
      if (currentLv >= targetLv) return 0;

      const reqs = (typeof BOND_REQUIREMENTS !== 'undefined') ? BOND_REQUIREMENTS[svt.collectionNo] : null;

      let total = 0;
      
      // 現在Lvから(現在Lv+1)までのポイントを加算（nextExpが入力されていればそれを採用、なければ全額）
      if (svt.nextExp !== null && svt.nextExp !== undefined && svt.nextExp !== '') {
        total += Number(svt.nextExp);
      } else {
        if (currentLv >= 10 && currentLv < 15) total += BOND_REQ_11_TO_15[currentLv];
        else if (currentLv < 10 && reqs && typeof reqs[currentLv] === 'number') total += reqs[currentLv];
        else if (currentLv < 10 && typeof BOND_REQ_1_TO_10[currentLv] === 'number') total += BOND_REQ_1_TO_10[currentLv];
      }

      // 残りのレベル(現在Lv+1 ～ 目標Lv-1)のポイントを加算
      for (let i = currentLv + 1; i < targetLv; i++) {
        if (i >= 10 && i < 15) total += BOND_REQ_11_TO_15[i];
        else if (i < 10) {
          if (reqs && typeof reqs[i] === 'number') total += reqs[i];
          else if (typeof BOND_REQ_1_TO_10[i] === 'number') total += BOND_REQ_1_TO_10[i]; // フォールバック
        }
      }
      return total;
    };

    const calculateNextLvRemainingP = (svt) => {
      if (!svt) return null;
      const currentLv = svt.currentLv;
      
      if (currentLv === null || currentLv === undefined || currentLv === '') return null;
      if (currentLv >= 15) return 0;

      const reqs = (typeof BOND_REQUIREMENTS !== 'undefined') ? BOND_REQUIREMENTS[svt.collectionNo] : null;
      let total = 0;
      
      if (svt.nextExp !== null && svt.nextExp !== undefined && svt.nextExp !== '') {
        total += Number(svt.nextExp);
      } else {
        if (currentLv >= 10 && currentLv < 15) total += BOND_REQ_11_TO_15[currentLv];
        else if (currentLv < 10 && reqs && typeof reqs[currentLv] === 'number') total += reqs[currentLv];
        else if (currentLv < 10 && typeof BOND_REQ_1_TO_10[currentLv] === 'number') total += BOND_REQ_1_TO_10[currentLv];
      }
      
      return total;
    };

    const calculateSlotRunsNeeded = (index) => {
      const svt = getPartyServant(index);
      if (!svt) return '-';

      const ppr = calculateSlotPointsPerRun(index).total;
      if (ppr <= 0) return '-';
      
      const rem = calculateTargetRemainingP(svt);
      if (rem === 0) return '達成済';
      if (rem === null || isNaN(rem)) return '-';
      
      return Math.ceil(rem / ppr);
    };

    const filteredServants = computed(() => {
      let result = servants.value;
      if (filter.value.possession === 'owned') result = result.filter(s => s.owned);
      else if (filter.value.possession === 'unowned') result = result.filter(s => !s.owned);

      if (filter.value.rarity !== 'all') {
        result = result.filter(s => s.rarity === parseInt(filter.value.rarity));
      }
      
      if (filter.value.classNames && filter.value.classNames.length > 0) {
        const allowedClasses = new Set();
        filter.value.classNames.forEach(cls => {
          if (cls === 'ex1') {
            ['ruler', 'avenger', 'shielder', 'mooncancer'].forEach(c => allowedClasses.add(c));
          } else if (cls === 'ex2') {
            ['alterego', 'foreigner', 'pretender', 'beast'].forEach(c => allowedClasses.add(c));
          } else {
            allowedClasses.add(cls.toLowerCase());
          }
        });
        result = result.filter(s => allowedClasses.has(s.className.toLowerCase()));
      }

      if (filter.value.trait !== 'all') {
        result = result.filter(s => s[filter.value.trait] === true);
      }

        if (filter.value.search) {
        const q = filter.value.search.toLowerCase();
        result = result.filter(s => s.name.toLowerCase().includes(q));
      }
      return result;
    });

    const getServantCost = (svt, isMash16 = false) => {
      if (!svt) return 0;
      if (svt.id === 800100) { // マシュ
        return isMash16 ? 16 : 0;
      }
      if (svt.id === 1100100) { // アンリマユ
        return 4;
      }
      if (svt.rarity === 5) return 16;
      if (svt.rarity === 4) return 12;
      if (svt.rarity === 3) return 7;
      if (svt.rarity === 2) return 4;
      if (svt.rarity === 1) return 3;
      if (svt.rarity === 0) return 4;
      return 0;
    };

    const getCECost = (ce) => {
      if (!ce || ce === 'none') return 0;
      if (ce === 'portrait') return 5;
      if (ce === 'kyokuten') return 9;
      return 12; // 20% CEs, Teatime, Lunchtime are 5-star (12 cost)
    };

    const formatCEName = (ce) => {
      if (!ce || ce === 'none') return 'なし';
      if (ce === 'teatime') return 'カルデア・ティータイム (+5%/15%)';
      if (ce === 'lunchtime') return 'カルデア・ランチタイム (+10%)';
      if (ce === 'kyokuten') return '英霊極点 (+2%)';
      if (ce === 'portrait') return '英霊肖像 (+50)';
      if (ce.startsWith('trait_')) {
        const trait = ce.replace('trait_', '');
        return `20%礼装 (${trait})`;
      }
      return ce;
    };

    const totalPartyCost = computed(() => {
      let total = 0;
      for (let i = 0; i < 5; i++) {
        const svt = getPartyServant(i);
        if (svt) {
          total += getServantCost(svt, currentParty.value.mashCost16 && currentParty.value.mashCost16[i]);
        }
        const ce = currentParty.value.partyCEs[i];
        total += getCECost(ce);
      }
      return total;
    });

    const runLocalRuleBasedGeneration = () => {
      if (typeof window.generateSchedule !== 'function') {
        alert("周回チャート生成エンジンがロードされていません。再読み込みしてください。");
        return;
      }
      window.generateSchedule({
        servants: servants.value,
        availableTraits: availableTraits.value,
        battleTemplates: battleTemplates.value,
        selectedTemplateId: selectedTemplateId.value,
        ownedCEs: ownedCEs.value,
        scheduleResults: scheduleResults,
        BOND_REQ_11_TO_15,
        BOND_REQ_1_TO_10,
        calculateTargetRemainingP,
        getServantCost,
        getCECost,
        formatCEName
      });
    };

    const calculateSlotPointsForParty = (partyObj, slotIdx) => {
      const idOrName = partyObj.party[slotIdx];
      if (!idOrName) return 0;
      const svt = servants.value.find(s => s.id === idOrName || s.name === idOrName);
      if (!svt) return 0;

      const base = partyObj.baseBond || 0;
      const B = partyObj.partyBonus[slotIdx] || 1.0;
      const C = Math.floor(base * B);

      let percent = 0;
      
      // 15Lvボーナス（そのパーティ内でのLv15の人数をカウント）
      let lv15Count = 0;
      for (let i = 0; i < 5; i++) {
        const pId = partyObj.party[i];
        if (pId) {
          const pSvt = servants.value.find(s => s.id === pId || s.name === pId);
          if (pSvt && pSvt.currentLv >= 15) lv15Count++;
        }
      }
      const lv15Percent = lv15Count * 25;

      // フレンド礼装
      partyObj.friendCEs.forEach(ce => {
        if (ce === 'teatime') percent += 15;
        else if (ce === 'lunchtime') percent += 10;
        else if (ce === 'kyokuten') percent += 2;
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (svt[trait]) percent += 20;
        }
      });

      // 自陣礼装
      partyObj.partyCEs.forEach((ce, i) => {
        if (!partyObj.party[i]) return;
        if (ce === 'teatime') percent += 5;
        else if (ce === 'lunchtime') percent += 10;
        else if (ce === 'kyokuten') percent += 2;
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (svt[trait]) percent += 20;
        }
      });

      // Grand枠
      if (partyObj.isGrand) {
        partyObj.isGrand.forEach((isG, i) => {
          if (!partyObj.party[i]) return;
          if (isG) {
            const ce2 = partyObj.partyCEs2[i];
            if (ce2 === 'teatime') percent += 5;
            else if (ce2 === 'lunchtime') percent += 10;
            else if (ce2 === 'kyokuten') percent += 2;
            else if (ce2 && ce2.startsWith('trait_')) {
              const trait = ce2.replace('trait_', '');
              if (svt[trait]) percent += 20;
            }
          }
        });
      }

      percent += (partyObj.extraGlobalPercent || 0);
      percent += lv15Percent;

      // フラットボーナス
      let flatBonus = 0;
      partyObj.friendCEs.forEach(ce => { if (ce === 'portrait') flatBonus += 50; });
      partyObj.partyCEs.forEach((ce, i) => {
        if (partyObj.party[i] && ce === 'portrait') flatBonus += 50;
      });
      if (partyObj.isGrand) {
        partyObj.isGrand.forEach((isG, i) => {
          if (partyObj.party[i] && isG && partyObj.partyCEs2[i] === 'portrait') flatBonus += 50;
        });
      }

      const Y = Math.floor(C * (percent / 100));
      let total = C + Y + flatBonus;
      if (partyObj.teapotActive) total *= 2;

      return total;
    };

    const calculatePartyTotalBond = (partyObj) => {
      if (!partyObj) return 0;
      let total = 0;
      for (let i = 0; i < 5; i++) {
        total += calculateSlotPointsForParty(partyObj, i);
      }
      return total;
    };

    return {
      calculatePartyTotalBond,
      isLoading,
      activeTab,
      parties,
      activePartyIndex,
      currentParty,
      addParty,
      copyParty,
      removeParty,
      servants,
      availableTraits,
      classOptions,
      classIdMap,
      filterExpanded,
      ownedCEs,
      battleTemplates,
      selectedTemplateId,
      scheduleResults,
      scheduleCheckpoints,
      traitCEOptions,
      addBattleTemplate,
      removeBattleTemplate,
      exportScheduleJSON,
      toggleCheckpoint,
      runLocalRuleBasedGeneration,
      toggleClassFilter,
      formatCEName,

      filter,
      filteredServants,
      ownedServantsList,
      friendCEOptions,
      partyCEOptions,
      resetData,
      saveData,
      getPartyServant,
      clearSlot,
      applyBonusPreset,
      getServantAllTraits,
      calculateSlotPointsPerRun,
      getSlotBonusPercent,
      getSlotBonusDetails,
      lv15BonusPercent,
      calculateTargetRemainingP,
      calculateNextLvRemainingP,
      calculateSlotRunsNeeded,
      totalPartyCost
    };
  }
}).mount('#app');
