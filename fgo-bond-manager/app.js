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
    const servantPicker = ref({
      isOpen: false,
      targetType: null, // 'simulation' or 'scheduler'
      targetIndex: null,
      search: '',
      classFilter: 'all'
    });

    const activeTab = ref('management'); // デフォルトをスケジューラータブに変更
    const servants = ref([]);

    // ▼ グローバルなグランド指定 ▼
    const globalGrandSvtIds = ref({
      saber: null, archer: null, lancer: null, rider: null,
      caster: null, assassin: null, berserker: null,
      ex1: null, ex2: null
    });
    
    const getGrandGroup = (className) => {
      if (['ruler', 'avenger', 'moonCancer', 'shielder'].includes(className)) return 'ex1';
      if (['alterEgo', 'foreigner', 'pretender', 'beast'].includes(className)) return 'ex2';
      return className;
    };
    
    const getFixedSlotServant = (index) => {
      const id = schedulerForm.value.fixedSlots[index];
      if (!id) return null;
      return servants.value.find(s => s.id === id) || null;
    };

    const openServantPicker = (targetType, index) => {
      servantPicker.value.targetType = targetType;
      servantPicker.value.targetIndex = index;
      servantPicker.value.search = '';
      servantPicker.value.classFilter = 'all';
      servantPicker.value.isOpen = true;
    };

    const closeServantPicker = () => {
      servantPicker.value.isOpen = false;
      servantPicker.value.targetType = null;
      servantPicker.value.targetIndex = null;
    };

    const selectServantInPicker = (svtId) => {
      if (servantPicker.value.targetType === 'simulation') {
        currentParty.value.party[servantPicker.value.targetIndex] = svtId;
      } else if (servantPicker.value.targetType === 'scheduler') {
        schedulerForm.value.fixedSlots[servantPicker.value.targetIndex] = svtId;
      }
      closeServantPicker();
    };

    const getServantPickerList = computed(() => {
      let baseList = servantPicker.value.targetType === 'scheduler'
        ? getFilteredServantsForScheduler.value
        : ownedServantsList.value;

      return baseList.filter(s => {
        if (servantPicker.value.classFilter !== 'all') {
          if (servantPicker.value.classFilter === 'ex') {
            if (['saber','archer','lancer','rider','caster','assassin','berserker'].includes(s.className)) return false;
          } else if (s.className !== servantPicker.value.classFilter) {
            return false;
          }
        }
        if (servantPicker.value.search) {
          if (!s.name.toLowerCase().includes(servantPicker.value.search.toLowerCase())) return false;
        }
        return true;
      });
    });

    const isGrand = (svt) => {
      if (!svt) return false;
      const group = getGrandGroup(svt.className);
      return globalGrandSvtIds.value[group] === svt.id;
    };

    const classIdMap = {
      saber: 1, lancer: 3, archer: 2, rider: 4, caster: 5,
      assassin: 6, berserker: 7, shielder: 8, ruler: 9,
      alterEgo: 10, avenger: 11, moonCancer: 23, foreigner: 25,
      pretender: 28, beast: 33, ex1: 1004, ex2: 1005
    };

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
      isGrand: [false, false, false, false, false], // 手動シミュ用（後方互換）
      mashCost16: [false, false, false, false, false],
      partyBonus: [1.24, 1.24, 1.04, 1.04, 1.04]
    });

    const parties = ref([getDefaultParty()]);
    const activePartyIndex = ref(0);
    const currentParty = computed(() => parties.value[activePartyIndex.value]);

    const filter = ref({
      possession: 'all', search: '', rarities: [],
      classNames: [], traits: [],
      isGrandOnly: false, isTargetNotReachedOnly: false
    });

    const sortConfig = ref({
      key: 'id',
      order: 'asc'
    });

    const toggleClassFilter = (cls) => {
      const idx = filter.value.classNames.indexOf(cls);
      if (idx === -1) filter.value.classNames.push(cls);
      else filter.value.classNames.splice(idx, 1);
    };

    const toggleRarityFilter = (val) => {
      const idx = filter.value.rarities.indexOf(val);
      if (idx === -1) filter.value.rarities.push(val);
      else filter.value.rarities.splice(idx, 1);
    };

    const toggleTraitFilter = (t) => {
      const idx = filter.value.traits.indexOf(t);
      if (idx === -1) filter.value.traits.push(t);
      else filter.value.traits.splice(idx, 1);
    };

    const filterExpanded = ref(false);

    const ownedCEs = ref({
      teatime: true, lunchtime: true, kyokuten: true, portrait: true, bond5Count: 0, traitCEs: []
    });

    // ▼ クエスト(バトル)テンプレートの定義 ▼
    const getDefaultBattleTemplate = (name = '新規バトル', baseBond = 855, ap = 40) => ({
      id: Date.now() + Math.random(),
      name, baseBond, ap,
      isCrown: false,             // 戴冠戦特別ルール
      applyBond15Bonus: false,    // 絆15バフ強制適用
      constraints: {
        allowedClasses: [],       // クラス制限配列
      },
      notes: ''
    });

    const defaultCoronation = getDefaultBattleTemplate('狂戴冠戦', 4748, 40);
    defaultCoronation.isCrown = true;
    defaultCoronation.applyBond15Bonus = true;
    defaultCoronation.constraints.allowedClasses = ['berserker'];

    const battleTemplates = ref([defaultCoronation]);

    // ▼ スケジューラータブ専用の状態 (State) ▼
    const schedulerForm = ref({
      selectedTemplateId: null,
      fixedSlots: [null, null, null, null, null], // 固定枠 (サーヴァントID)
      fixedCEs: [
        { ce1: 'auto', ce2: 'auto' },
        { ce1: 'auto', ce2: 'auto' },
        { ce1: 'auto', ce2: 'auto' },
        { ce1: 'auto', ce2: 'auto' },
        { ce1: 'auto', ce2: 'auto' }
      ],
      fixedSupportCEs: ['auto', 'auto'], // サポート固定礼装
      extraGlobalPercent: 0,
      useTeapot: false,
      isMultipleMode: false
    });

    const advancedScheduleResults = ref(null);
    const savedSchedules = ref([]);
    const openedScheduleId = ref(null);

    // 選択中のテンプレートをリアクティブに取得
    const activeSchedulerTemplate = computed(() => {
      return battleTemplates.value.find(t => t.id === schedulerForm.value.selectedTemplateId) || battleTemplates.value[0];
    });

    // ▼ クラス制限に合致する「所持鯖」だけをフィルタリングして返す (固定枠用) ▼
    const getFilteredServantsForScheduler = computed(() => {
      const allowedClasses = activeSchedulerTemplate.value?.constraints?.allowedClasses || [];
      let expandedAllowedClasses = [...allowedClasses];
      if (expandedAllowedClasses.includes('ex1')) {
        expandedAllowedClasses.push('ruler', 'shielder', 'avenger', 'mooncancer');
      }
      if (expandedAllowedClasses.includes('ex2')) {
        expandedAllowedClasses.push('alterego', 'foreigner', 'pretender', 'beast');
      }
      return ownedServantsList.value.filter(svt => {
        if (expandedAllowedClasses.length === 0) return true; // 制限なし
        return expandedAllowedClasses.includes(svt.className.toLowerCase());
      });
    });

    // テンプレートのクラス制限をトグルする
    const toggleTemplateClassLimit = (template, cls) => {
      if (!template.constraints.allowedClasses) template.constraints.allowedClasses = [];
      const arr = template.constraints.allowedClasses;
      const idx = arr.indexOf(cls);
      if (idx === -1) arr.push(cls);
      else arr.splice(idx, 1);
    };

    const traitCEOptions = computed(() => {
      return availableTraits.value.map(t => ({ value: t, label: `20%特攻礼装 (${t})` }));
    });

    let isInitializing = true;

    const exportScheduleImage = async () => {
      const el = document.getElementById('schedule-chart-container');
      if (!el) return;
      try {
        // html2canvas の文字切れ問題を回避するため html-to-image を使用
        // ウィンドウサイズに関わらず常にPCレイアウト(1024px)で綺麗に保存するための処理
        const originalMaxWidth = el.style.maxWidth;
        const originalWidth = el.style.width;
        
        el.style.maxWidth = '1024px';
        el.style.width = '1024px';

        const dataUrl = await window.htmlToImage.toPng(el, { 
          backgroundColor: '#f9fafb',
          pixelRatio: 2,
          style: {
            margin: '0' // mx-auto による右ズレを防止
          }
        });

        // スタイルを元に戻す
        el.style.maxWidth = originalMaxWidth;
        el.style.width = originalWidth;
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `fgo_schedule_chart_${new Date().getTime()}.png`;
        a.click();
      } catch (err) {
        console.error("画像保存に失敗しました", err);
        alert("画像の保存に失敗しました。");
      }
    };

    // ===== 初期化とローカルストレージの読み込み =====
    onMounted(async () => {
      const savedTemplates = localStorage.getItem('fgo_bond_manager_templates_v2');
      if (savedTemplates) {
        try {
          const parsed = JSON.parse(savedTemplates);
          if (Array.isArray(parsed) && parsed.length > 0) {
            battleTemplates.value = parsed.map(t => {
              const def = getDefaultBattleTemplate(t.name, t.baseBond, t.ap);
              return { ...def, ...t, constraints: { ...def.constraints, ...(t.constraints || {}) } };
            });
          }
        } catch (e) { }
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
            bond5Count: parsed.bond5Count !== undefined ? parsed.bond5Count : 0,
            traitCEs: parsed.traitCEs || []
          };
        } catch (e) { }
      }

      // 以前のバージョンの互換性
      const savedGrandId = localStorage.getItem('fgo_bond_manager_global_grand');
      if (savedGrandId) {
        const id = parseInt(savedGrandId, 10);
        if (!isNaN(id)) globalGrandSvtIds.value.saber = id;
      }
      const savedGrands = localStorage.getItem('fgo_bond_manager_global_grands');
      if (savedGrands) {
        try {
          const parsed = JSON.parse(savedGrands);
          globalGrandSvtIds.value = { ...globalGrandSvtIds.value, ...parsed };
        } catch (e) {}
      }

      // テンプレートの初期選択
      if (battleTemplates.value.length > 0) {
        schedulerForm.value.selectedTemplateId = battleTemplates.value[0].id;
      }

      const savedResults = localStorage.getItem('fgo_bond_manager_schedule_results');
      if (savedResults) {
        try {
          advancedScheduleResults.value = JSON.parse(savedResults);
        } catch(e) {}
      }

      const savedHistory = localStorage.getItem('fgo_bond_manager_saved_schedules');
      if (savedHistory) {
        try {
          savedSchedules.value = JSON.parse(savedHistory);
        } catch(e) {}
      }

      await fetchAtlasData();
      isLoading.value = false;
      
      // 次のTick以降で保存を有効化する
      setTimeout(() => {
        isInitializing = false;
      }, 100);
    });

    // ===== ローカルストレージへの保存監視 =====
    watch(servants, () => { saveToLocalStorage(); }, { deep: true });
    watch(parties, () => { saveToLocalStorage(); }, { deep: true });
    watch(activePartyIndex, () => { saveToLocalStorage(); });
    watch(battleTemplates, () => { saveToLocalStorage(); }, { deep: true });
    watch(ownedCEs, () => { saveToLocalStorage(); }, { deep: true });
    watch(globalGrandSvtIds, () => { saveToLocalStorage(); }, { deep: true });
    watch(advancedScheduleResults, () => { saveToLocalStorage(); }, { deep: true });
    watch(savedSchedules, () => { saveToLocalStorage(); }, { deep: true });

    const saveToLocalStorage = () => {
      if (isInitializing) return;
      const userData = servants.value.map(s => ({
        id: s.id, name: s.name, owned: s.owned,
        currentLv: s.currentLv, targetLevel: s.targetLevel, nextExp: s.nextExp
      })).filter(s => s.owned || s.currentLv !== null || s.nextExp !== null || s.targetLevel !== 10);

      localStorage.setItem('fgo_bond_manager_userdata_v3', JSON.stringify(userData));
      localStorage.setItem('fgo_bond_manager_parties_v1', JSON.stringify(parties.value));
      localStorage.setItem('fgo_bond_manager_active_party', activePartyIndex.value.toString());
      localStorage.setItem('fgo_bond_manager_templates_v2', JSON.stringify(battleTemplates.value));
      localStorage.setItem('fgo_bond_manager_owned_ces', JSON.stringify(ownedCEs.value));
      localStorage.setItem('fgo_bond_manager_global_grands', JSON.stringify(globalGrandSvtIds.value));
      if (advancedScheduleResults.value) {
        localStorage.setItem('fgo_bond_manager_schedule_results', JSON.stringify(advancedScheduleResults.value));
      } else {
        localStorage.removeItem('fgo_bond_manager_schedule_results');
      }
      localStorage.setItem('fgo_bond_manager_saved_schedules', JSON.stringify(savedSchedules.value));
    };

    const fetchAtlasData = async () => {
      try {
        const response = await fetch('https://api.atlasacademy.io/export/JP/basic_svt.json');
        const rawData = await response.json();
        const playableSvts = rawData.filter(s => s.type === 'normal' || s.type === 'heroine');

        const hasTrait = (svt, traitName) => svt.traits.some(t => t.name === traitName);

        const parsedServants = playableSvts.map(s => {
          const svt = {
            id: s.id, collectionNo: s.collectionNo, name: s.name,
            iconUrl: s.face || '', className: s.className, rarity: s.rarity,
            owned: false, currentLv: null, targetLevel: 10, nextExp: null
          };

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

        const savedParties = localStorage.getItem('fgo_bond_manager_parties_v1');
        if (savedParties) {
          try {
            const parsed = JSON.parse(savedParties);
            if (Array.isArray(parsed)) {
              parties.value = parsed.map(p => {
                const def = getDefaultParty(p.name, p.id);
                return {
                  ...def, ...p,
                  party: p.party || def.party,
                  partyCEs: p.partyCEs || def.partyCEs,
                  partyCEs2: p.partyCEs2 || def.partyCEs2,
                  isGrand: p.isGrand || def.isGrand,
                  mashCost16: p.mashCost16 || def.mashCost16,
                  partyBonus: p.partyBonus || def.partyBonus
                };
              });
            }
          } catch (e) { }
        }

        const savedIndex = localStorage.getItem('fgo_bond_manager_active_party');
        if (savedIndex !== null) {
          const idx = parseInt(savedIndex, 10);
          if (idx >= 0 && idx < parties.value.length) activePartyIndex.value = idx;
        }

        const savedUserDataV3 = localStorage.getItem('fgo_bond_manager_userdata_v3');
        if (savedUserDataV3) {
          const userData = JSON.parse(savedUserDataV3);
          userData.forEach(ud => {
            const match = parsedServants.find(s => s.id === ud.id);
            if (match) {
              match.owned = ud.owned; match.currentLv = ud.currentLv;
              match.targetLevel = ud.targetLevel || 10;
              match.nextExp = ud.nextExp !== undefined ? ud.nextExp : (ud.remainingP !== undefined ? ud.remainingP : null);
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
      const newTmpl = getDefaultBattleTemplate();
      battleTemplates.value.push(newTmpl);
      schedulerForm.value.selectedTemplateId = newTmpl.id;
    };

    const copyBattleTemplate = () => {
      const sourceTmpl = activeSchedulerTemplate.value;
      if (!sourceTmpl) return;
      const cloned = JSON.parse(JSON.stringify(sourceTmpl));
      cloned.id = Date.now() + Math.random();
      cloned.name = `${sourceTmpl.name}のコピー`;
      battleTemplates.value.push(cloned);
      schedulerForm.value.selectedTemplateId = cloned.id;
    };

    const removeBattleTemplateBySId = () => {
      if (battleTemplates.value.length <= 1) {
        alert('最低1つのバトルは残す必要があります。');
        return;
      }
      if (confirm('現在選択中のクエスト設定を削除しますか？')) {
        const idx = battleTemplates.value.findIndex(t => t.id === schedulerForm.value.selectedTemplateId);
        if (idx !== -1) {
          battleTemplates.value.splice(idx, 1);
          schedulerForm.value.selectedTemplateId = battleTemplates.value[0].id;
        }
      }
    };

    const exportScheduleJSON = () => {
      if (!advancedScheduleResults.value) return;
      const dataStr = JSON.stringify(advancedScheduleResults.value, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fgo_schedule_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    };

    const saveCurrentSchedule = () => {
      if (!advancedScheduleResults.value) return;
      
      const now = new Date();
      const dateStr = `${now.getFullYear()}/${(now.getMonth()+1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      
      let inputName = prompt("保存する履歴の名前（タイトル）を入力してください。\n空欄の場合は日時が名前になります。");
      if (inputName === null) return;
      
      const finalName = inputName.trim() === "" ? dateStr : inputName.trim();
      
      let conditionStr = "";
      if (schedulerForm.value.isMultipleMode) conditionStr += "複数モード, ";
      if (schedulerForm.value.useTeapot) conditionStr += "ティーポットあり, ";
      const fixedCount = schedulerForm.value.fixedSlots.filter(s => s).length;
      if (fixedCount > 0) conditionStr += `固定枠${fixedCount}名, `;
      if (activeSchedulerTemplate.value && activeSchedulerTemplate.value.isCrown) conditionStr += "戴冠戦ルール, ";
      if (conditionStr === "") conditionStr = "標準設定";
      else conditionStr = conditionStr.replace(/, $/, '');

      const detailedConditions = {
        fixedSlots: schedulerForm.value.fixedSlots.map(id => {
          if (!id) return null;
          const s = servants.value.find(svt => svt.id === id);
          return s ? s.name : null;
        }),
        fixedCEs: JSON.parse(JSON.stringify(schedulerForm.value.fixedCEs)),
        fixedSupportCEs: JSON.parse(JSON.stringify(schedulerForm.value.fixedSupportCEs)),
        isCrown: activeSchedulerTemplate.value ? activeSchedulerTemplate.value.isCrown : false,
        useTeapot: schedulerForm.value.useTeapot,
        extraGlobalPercent: schedulerForm.value.extraGlobalPercent
      };

      const historyItem = {
        id: Date.now(),
        name: finalName,
        timestamp: dateStr,
        totalRuns: advancedScheduleResults.value.totalRuns,
        totalPhases: advancedScheduleResults.value.phases.length,
        conditionSummary: conditionStr,
        detailedConditions: detailedConditions,
        results: JSON.parse(JSON.stringify(advancedScheduleResults.value))
      };
      
      savedSchedules.value.unshift(historyItem);
      alert(`履歴「${finalName}」を保存しました。`);
    };

    const loadScheduleHistory = (index) => {
      const item = savedSchedules.value[index];
      if (!item) return;
      
      if (confirm('現在のシミュレーション結果、および左パネルの実行条件が上書きされます。よろしいですか？')) {
        advancedScheduleResults.value = JSON.parse(JSON.stringify(item.results));
        
        if (item.detailedConditions) {
          if (item.detailedConditions.fixedSlots) {
            schedulerForm.value.fixedSlots = item.detailedConditions.fixedSlots.map(name => {
              if (!name) return null;
              const svt = servants.value.find(s => s.name === name);
              return svt ? svt.id : null;
            });
          }
          
          if (item.detailedConditions.fixedCEs) {
            schedulerForm.value.fixedCEs = JSON.parse(JSON.stringify(item.detailedConditions.fixedCEs));
          }
          
          if (item.detailedConditions.fixedSupportCEs) {
            schedulerForm.value.fixedSupportCEs = JSON.parse(JSON.stringify(item.detailedConditions.fixedSupportCEs));
          }
          
          if (item.detailedConditions.useTeapot !== undefined) {
            schedulerForm.value.useTeapot = item.detailedConditions.useTeapot;
          }
          if (item.detailedConditions.extraGlobalPercent !== undefined) {
            schedulerForm.value.extraGlobalPercent = item.detailedConditions.extraGlobalPercent;
          }
          
          if (item.detailedConditions.isCrown !== undefined) {
            const targetTemplate = battleTemplates.value.find(t => !!t.isCrown === !!item.detailedConditions.isCrown);
            if (targetTemplate) {
              schedulerForm.value.selectedTemplateId = targetTemplate.id;
            }
          }
        }
      }
    };

    const renameScheduleHistory = (index) => {
      const item = savedSchedules.value[index];
      if (!item) return;
      const newName = prompt("新しい履歴名を入力してください:", item.name);
      if (newName !== null && newName.trim() !== "") {
        item.name = newName.trim();
      }
    };

    const deleteScheduleHistory = (index) => {
      if (confirm('この履歴を削除しますか？')) {
        savedSchedules.value.splice(index, 1);
      }
    };



    const resetData = () => {
      if (confirm('初期データにリセットしますか？入力した所持状況や絆Lvなどはすべて消去されます。')) {
        servants.value.forEach(s => {
          s.owned = false; s.currentLv = null; s.targetLevel = 10; s.nextExp = null;
        });
        currentParty.value.party = [null, null, null, null, null];
        currentParty.value.partyCEs = ['none', 'none', 'none', 'none', 'none'];
        currentParty.value.partyCEs2 = ['none', 'none', 'none', 'none', 'none'];
        Object.keys(globalGrandSvtIds.value).forEach(k => globalGrandSvtIds.value[k] = null);
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
      const cloned = JSON.parse(JSON.stringify(sourceParty));
      cloned.id = Date.now();
      cloned.name = `${sourceParty.name}のコピー`;
      parties.value.splice(index + 1, 0, cloned);
      activePartyIndex.value = index + 1;
      saveToLocalStorage();
    };

    const removeParty = (index) => {
      if (parties.value.length <= 1) { alert('最低1つの編成は残す必要があります。'); return; }
      if (confirm(`「${parties.value[index].name}」を削除しますか？`)) {
        parties.value.splice(index, 1);
        if (activePartyIndex.value >= parties.value.length) activePartyIndex.value = parties.value.length - 1;
        saveToLocalStorage();
      }
    };

    const partyCEOptions = computed(() => {
      const base = [
        { value: 'none', label: 'なし' },
        { value: 'teatime', label: 'カルデア・ティータイム (+5%)' },
        { value: 'lunchtime', label: 'カルデア・ランチタイム (+10%)' },
        { value: 'kyokuten', label: '英霊極点 (+2%)' },
        { value: 'portrait', label: '英霊肖像 (+50)' }
      ];
      availableTraits.value.forEach(trait => {
        base.push({ value: `trait_${trait}`, label: `20%特攻礼装 (${trait})` });
      });
      return base;
    });

    const friendCEOptions = computed(() => {
      return partyCEOptions.value.map(opt => {
        if (opt.value === 'teatime') return { ...opt, label: 'カルデア・ティータイム (+15%)' };
        return opt;
      });
    });

    const classOptions = [
      { value: 'all', label: 'すべてのクラス' }, { value: 'saber', label: 'セイバー' },
      { value: 'archer', label: 'アーチャー' }, { value: 'lancer', label: 'ランサー' },
      { value: 'rider', label: 'ライダー' }, { value: 'caster', label: 'キャスター' },
      { value: 'assassin', label: 'アサシン' }, { value: 'berserker', label: 'バーサーカー' },
      { value: 'ruler', label: 'ルーラー' }, { value: 'avenger', label: 'アヴェンジャー' },
      { value: 'alterEgo', label: 'アルターエゴ' }, { value: 'moonCancer', label: 'ムーンキャンサー' },
      { value: 'foreigner', label: 'フォーリナー' }, { value: 'pretender', label: 'プリテンダー' },
      { value: 'beast', label: 'ビースト' }, { value: 'shielder', label: 'シールダー' },
      { value: 'ex1', label: 'EX1' }, { value: 'ex2', label: 'EX2' }
    ];

    const ownedServantsList = computed(() => servants.value.filter(s => s.owned));

    const filteredServants = computed(() => {
      const result = servants.value.filter(s => {
        if (filter.value.possession === 'owned' && !s.owned) return false;
        if (filter.value.possession === 'unowned' && s.owned) return false;

        if (filter.value.rarities.length > 0 && !filter.value.rarities.includes(String(s.rarity))) return false;

        if (filter.value.classNames.length > 0) {
          const c = s.className;
          let match = filter.value.classNames.includes(c);
          if (!match && filter.value.classNames.includes('ex1')) {
            if (['ruler', 'avenger', 'moonCancer', 'shielder'].includes(c)) match = true;
          }
          if (!match && filter.value.classNames.includes('ex2')) {
            if (['alterEgo', 'foreigner', 'pretender', 'beast'].includes(c)) match = true;
          }
          if (!match) return false;
        }

        if (filter.value.traits.length > 0) {
          for (let t of filter.value.traits) {
            if (!s[t]) return false;
          }
        }

        if (filter.value.search) {
          if (!s.name.toLowerCase().includes(filter.value.search.toLowerCase())) return false;
        }

        if (filter.value.isGrandOnly && !isGrand(s)) return false;
        if (filter.value.isTargetNotReachedOnly) {
          const rem = calculateTargetRemainingP(s);
          if (rem === null || rem <= 0) return false;
        }

        return true;
      });

      result.sort((a, b) => {
        let valA, valB;
        if (sortConfig.value.key === 'rarity') {
          valA = a.rarity;
          valB = b.rarity;
        } else if (sortConfig.value.key === 'currentLv') {
          valA = a.currentLv !== null ? a.currentLv : -1;
          valB = b.currentLv !== null ? b.currentLv : -1;
        } else if (sortConfig.value.key === 'remainingP') {
          const remA = calculateTargetRemainingP(a);
          const remB = calculateTargetRemainingP(b);
          valA = remA !== null ? remA : -1;
          valB = remB !== null ? remB : -1;
        } else {
          valA = a.id;
          valB = b.id;
        }

        if (valA === valB) {
          return a.id - b.id;
        }

        if (sortConfig.value.order === 'asc') {
          return valA > valB ? 1 : -1;
        } else {
          return valA < valB ? 1 : -1;
        }
      });

      return result;
    });

    const getPartyServant = (index) => {
      const idOrName = currentParty.value.party[index];
      if (!idOrName) return null;
      return servants.value.find(s => s.id === idOrName || s.name === idOrName) || null;
    };

    const clearSlot = (index) => {
      currentParty.value.party[index] = null;
      currentParty.value.partyCEs[index] = 'none';
    };

    const applyBonusPreset = (type) => {
      if (type === 'front') currentParty.value.partyBonus = [1.24, 1.24, 1.04, 1.04, 1.04];
      else if (type === 'back') currentParty.value.partyBonus = [1.20, 1.20, 1.20, 1.00, 1.00];
    };

    const getServantAllTraits = (svt) => {
      return availableTraits.value.filter(t => svt[t]);
    };

    const getServantCost = (svt, isMash16 = false) => {
      if (!svt) return 0;
      if (svt.id === 800100) return isMash16 ? 16 : 0;
      if (svt.id === 1100100) return 4;
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
      return 12;
    };

    const formatCEName = (ce, isSupport = false) => {
      if (ce === 'auto_trait') return '自動最適化 特攻礼装 (20%)';
      if (ce === 'teatime') return isSupport ? 'カルデア・ティータイム (+15%)' : 'カルデア・ティータイム (+5%)';
      if (ce === 'lunchtime') return 'カルデア・ランチタイム (+10%)';
      if (ce === 'kyokuten') return '英霊極点 (+2%)';
      if (ce === 'portrait') return '英霊肖像 (+50)';
      if (ce === 'none' || !ce) return 'なし';
      
      let traitName = ce;
      if (ce.startsWith('trait_')) {
        traitName = ce.replace('trait_', '');
      }
      if (availableTraits.value.includes(traitName)) {
        return `20%特攻礼装 (${traitName})`;
      }
      return ce;
    };

    const calculateTargetRemainingP = (svt) => {
      if (!svt) return null;
      const targetLv = svt.targetLevel || 10;
      const currentLv = svt.currentLv;

      if (currentLv === null || currentLv === undefined || currentLv === '') return null;
      if (currentLv >= targetLv) return 0;

      // 1. 各サーヴァント個別の必要経験値テーブル（next-exp配列）を取得
      const reqs = (typeof BOND_REQUIREMENTS !== 'undefined') ? BOND_REQUIREMENTS[svt.collectionNo] : null;
      let total = 0;

      // 現在のレベル -> 次のレベル までの必要経験値
      if (svt.nextExp !== null && svt.nextExp !== undefined && svt.nextExp !== '') {
        // ユーザーが手動で nextExp (次レベルまで) を入力している場合はそれを起点にする
        total += Number(svt.nextExp);
      } else {
        // 未入力の場合は現在のレベルの初期状態（経験値0）と仮定し、次レベルまでの全必要量を加算
        if (currentLv >= 10 && currentLv < 15) total += BOND_REQ_11_TO_15[currentLv];
        else if (currentLv < 10 && reqs && typeof reqs[currentLv] === 'number') total += reqs[currentLv];
        else if (currentLv < 10 && typeof BOND_REQ_1_TO_10[currentLv] === 'number') total += BOND_REQ_1_TO_10[currentLv]; // フォールバック
      }

      // 次のレベル以降 -> 目標レベル までの必要経験値を個別の経験値テーブルから加算
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

      // 個別の必要経験値テーブル
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

    // ▼ ▼ ▼ 新しい「自動スケジューラー」の実行関数 ▼ ▼ ▼
    const runAdvancedScheduler = () => {
      if (typeof window.generateGreedySchedule !== 'function') {
        alert("貪欲法スケジューラーがロードされていません。再読み込みしてください。");
        return;
      }

      // 1. サーヴァントデータの整形
      const formattedServants = servants.value.map(s => ({
        ...s,
        traits: getServantAllTraits(s)
      }));

      // 2. 礼装プールの整形
      const formattedOwnedCEs = {
        teatime: ownedCEs.value.teatime ? 1 : 0,
        lunchtime: ownedCEs.value.lunchtime ? 1 : 0,
        kyokuten: ownedCEs.value.kyokuten ? 1 : 0,
        portrait: ownedCEs.value.portrait ? 1 : 0,
        bond5: ownedCEs.value.bond5Count || 0
      };
      if (Array.isArray(ownedCEs.value.traitCEs)) {
        ownedCEs.value.traitCEs.forEach(trait => {
          formattedOwnedCEs[trait] = 1;
        });
      }

      // 【重要】新しい仕様に合わせて、greedySchedulerに渡すデータを大幅に拡張します
      window.generateGreedySchedule({
        servants: formattedServants,
        availableTraits: availableTraits.value,

        // テンプレートとして「現在選択中の1つ」を深くコピーして渡す
        battleTemplate: JSON.parse(JSON.stringify(activeSchedulerTemplate.value)),

        // 新規追加: ユーザーがダッシュボードで設定した条件・制約
        fixedSlots: schedulerForm.value.fixedSlots,
        fixedCEs: schedulerForm.value.fixedCEs,
        fixedSupportCEs: schedulerForm.value.fixedSupportCEs,
        globalGrandSvtIds: globalGrandSvtIds.value,
        getGrandGroup,
        extraGlobalPercent: schedulerForm.value.extraGlobalPercent,
        useTeapot: schedulerForm.value.useTeapot,
        ownedCEs: formattedOwnedCEs,
        scheduleResults: advancedScheduleResults,
        BOND_REQ_11_TO_15,
        BOND_REQ_1_TO_10,
        calculateTargetRemainingP,
        getServantCost,
        getCECost,
        formatCEName
      });
    };
    // ▲ ▲ ▲ 修正箇所ここまで ▲ ▲ ▲

    // -----------------------------------------------------------------------------------
    // 以下は「編成シミュレーション(手動電卓)」タブ用に取り残された既存ロジック（変更なし）
    // -----------------------------------------------------------------------------------
    const lv15BonusPercent = computed(() => {
      let count = 0;
      for (let i = 0; i < 5; i++) {
        const svt = getPartyServant(i);
        if (svt && svt.currentLv >= 15) count++;
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

      // すべてのスロットのグランド鯖の第2礼装をチェックして全体に加算
      currentParty.value.partyCEs2.forEach((ce2, i) => {
        const grandSvt = getPartyServant(i);
        if (!grandSvt || !isGrand(grandSvt)) return;
        if (ce2 === 'teatime') percent += 5;
        else if (ce2 === 'lunchtime') percent += 10;
        else if (ce2 === 'kyokuten') percent += 2;
        else if (ce2 && ce2.startsWith('trait_')) {
          const trait = ce2.replace('trait_', '');
          if (svt && svt[trait]) percent += 20;
        }
      });

      percent += (currentParty.value.extraGlobalPercent || 0);
      percent += lv15BonusPercent.value;
      return percent;
    };

    const getSlotBonusDetails = (index) => {
      const svt = getPartyServant(index);
      let details = [];

      currentParty.value.friendCEs.forEach((ce, i) => {
        if (ce === 'teatime') details.push(`サポート礼装${i + 1} (TT): +15%`);
        else if (ce === 'lunchtime') details.push(`サポート礼装${i + 1} (LT): +10%`);
        else if (ce === 'kyokuten') details.push(`サポート礼装${i + 1} (極点): +2%`);
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (svt && svt[trait]) details.push(`サポート礼装${i + 1} (20%特攻): +20%`);
        }
      });

      currentParty.value.partyCEs.forEach((ce, i) => {
        if (!currentParty.value.party[i]) return;
        if (ce === 'teatime') details.push(`自陣枠${i + 1} (TT): +5%`);
        else if (ce === 'lunchtime') details.push(`自陣枠${i + 1} (LT): +10%`);
        else if (ce === 'kyokuten') details.push(`自陣枠${i + 1} (極点): +2%`);
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (svt && svt[trait]) details.push(`自陣枠${i + 1} (20%特攻): +20%`);
        }
      });

      // すべてのスロットのグランド鯖の第2礼装をチェックして全体に加算
      currentParty.value.partyCEs2.forEach((ce2, i) => {
        const grandSvt = getPartyServant(i);
        if (!grandSvt || !isGrand(grandSvt)) return;
        if (ce2 === 'teatime') details.push(`自陣枠${i + 1}G (TT): +5%`);
        else if (ce2 === 'lunchtime') details.push(`自陣枠${i + 1}G (LT): +10%`);
        else if (ce2 === 'kyokuten') details.push(`自陣枠${i + 1}G (極点): +2%`);
        else if (ce2 && ce2.startsWith('trait_')) {
          const trait = ce2.replace('trait_', '');
          if (svt && svt[trait]) details.push(`自陣枠${i + 1}G (20%特攻): +20%`);
        }
      });

      if (currentParty.value.extraGlobalPercent) details.push(`その他の加算: +${currentParty.value.extraGlobalPercent}%`);
      if (lv15BonusPercent.value > 0) details.push(`絆15ボーナス: +${lv15BonusPercent.value}%`);

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

      if (isGrand(svt) && currentParty.value.partyCEs2[index] === 'portrait') {
        flatBonus += 50;
      }

      const Y = Math.floor(C * (percent / 100));
      let total = C + Y + flatBonus;
      if (currentParty.value.teapotActive) total *= 2;

      return { total, base, baseVal: C, bonus: total - C };
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

    const calculateSlotPointsForParty = (partyObj, slotIdx) => {
      const idOrName = partyObj.party[slotIdx];
      if (!idOrName) return 0;
      const svt = servants.value.find(s => s.id === idOrName || s.name === idOrName);
      if (!svt) return 0;

      const base = partyObj.baseBond || 0;
      const B = partyObj.partyBonus[slotIdx] || 1.0;
      const C = Math.floor(base * B);

      let percent = 0;
      let lv15Count = 0;
      for (let i = 0; i < 5; i++) {
        const pId = partyObj.party[i];
        if (pId) {
          const pSvt = servants.value.find(s => s.id === pId || s.name === pId);
          if (pSvt && pSvt.currentLv >= 15) lv15Count++;
        }
      }
      const lv15Percent = lv15Count * 25;

      partyObj.friendCEs.forEach(ce => {
        if (ce === 'teatime') percent += 15;
        else if (ce === 'lunchtime') percent += 10;
        else if (ce === 'kyokuten') percent += 2;
        else if (ce && ce.startsWith('trait_')) {
          const trait = ce.replace('trait_', '');
          if (svt[trait]) percent += 20;
        }
      });

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

      // すべてのスロットのグランド鯖の第2礼装をチェックして全体に加算
      partyObj.partyCEs2.forEach((ce2, i) => {
        const grandId = partyObj.party[i];
        if (!grandId) return;
        const grandSvt = servants.value.find(s => s.id === grandId || s.name === grandId);
        if (!grandSvt || !isGrand(grandSvt)) return;
        if (ce2 === 'teatime') percent += 5;
        else if (ce2 === 'lunchtime') percent += 10;
        else if (ce2 === 'kyokuten') percent += 2;
        else if (ce2 && ce2.startsWith('trait_')) {
          const trait = ce2.replace('trait_', '');
          if (svt[trait]) percent += 20;
        }
      });

      percent += (partyObj.extraGlobalPercent || 0);
      percent += lv15Percent;

      let flatBonus = 0;
      partyObj.friendCEs.forEach(ce => { if (ce === 'portrait') flatBonus += 50; });
      partyObj.partyCEs.forEach((ce, i) => {
        if (partyObj.party[i] && ce === 'portrait') flatBonus += 50;
      });
      // すべてのスロットのグランド鯖の第2礼装肖像フラット効果も全体に加算
      partyObj.partyCEs2.forEach((ce2, i) => {
        const grandId = partyObj.party[i];
        if (!grandId) return;
        const grandSvt = servants.value.find(s => s.id === grandId || s.name === grandId);
        if (!grandSvt || !isGrand(grandSvt)) return;
        if (ce2 === 'portrait') {
          flatBonus += 50;
        }
      });

      const Y = Math.floor(C * (percent / 100));
      let total = C + Y + flatBonus;
      if (partyObj.teapotActive) total *= 2;

      return total;
    };

    const calculatePartyTotalBond = (partyObj) => {
      if (!partyObj) return 0;
      let total = 0;
      for (let i = 0; i < 5; i++) total += calculateSlotPointsForParty(partyObj, i);
      return total;
    };

    return {
      servantPicker, openServantPicker, closeServantPicker, selectServantInPicker, getServantPickerList,
      getFixedSlotServant,
      sortConfig, calculatePartyTotalBond, isLoading, activeTab, parties, activePartyIndex, currentParty,
      addParty, copyParty, removeParty, servants, availableTraits, classOptions, classIdMap,
      filterExpanded, ownedCEs, battleTemplates, traitCEOptions, addBattleTemplate, copyBattleTemplate,
      removeBattleTemplateBySId, exportScheduleJSON, exportScheduleImage, toggleTemplateClassLimit,
      runAdvancedScheduler, formatCEName, filter, filteredServants, ownedServantsList,
      friendCEOptions, partyCEOptions, resetData, saveData, getPartyServant, clearSlot,
      applyBonusPreset, getServantAllTraits, calculateSlotPointsPerRun, exportScheduleImage,
      exportScheduleJSON,
      saveCurrentSchedule,
      loadScheduleHistory,
      deleteScheduleHistory,
      renameScheduleHistory,
      savedSchedules,
      openedScheduleId,
      getSlotBonusDetails,
      getSlotBonusPercent, calculateTargetRemainingP, calculateNextLvRemainingP,
      calculateSlotRunsNeeded, totalPartyCost, toggleRarityFilter, toggleTraitFilter, toggleClassFilter,

      globalGrandSvtIds, getGrandGroup, isGrand,
      schedulerForm,
      activeSchedulerTemplate,
      getFilteredServantsForScheduler,
      advancedScheduleResults
    };
  }
}).mount('#app');