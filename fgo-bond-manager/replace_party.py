import re

# Update app.js
with open('app.js', 'r', encoding='utf-8') as f:
    js = f.read()

# 1. Replace settings definition with parties
js = re.sub(
    r'const settings = ref\(\{[\s\S]*?partyBonus: \[1\.24, 1\.24, 1\.04, 1\.04, 1\.04\]\n    \}\);',
    r'''const getDefaultParty = (name = '編成1', id = null) => ({
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
    const currentParty = computed(() => parties.value[activePartyIndex.value]);''',
    js
)

# 2. Replace onMounted loading logic
loading_logic = r'''const savedParties = localStorage.getItem('fgo_bond_manager_parties_v1');
      if (savedParties) {
        try {
          parties.value = JSON.parse(savedParties);
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
        let idx = parseInt(savedIndex, 10);
        if (idx >= 0 && idx < parties.value.length) activePartyIndex.value = idx;
      }'''

js = re.sub(
    r'const savedSettings = localStorage\.getItem\(\'fgo_bond_manager_settings_v2\'\);[\s\S]*?if \(!settings\.value\.friendCEs\) settings\.value\.friendCEs = \[\'teatime\', \'none\'\];\n        \}',
    loading_logic,
    js
)

# 3. Replace saveToLocalStorage
js = re.sub(
    r'localStorage\.setItem\(\'fgo_bond_manager_settings_v2\', JSON\.stringify\(settings\.value\)\);',
    r'''localStorage.setItem('fgo_bond_manager_parties_v1', JSON.stringify(parties.value));
      localStorage.setItem('fgo_bond_manager_active_party', activePartyIndex.value.toString());''',
    js
)

# 4. Replace resetData
js = re.sub(
    r'if \(confirm\(\'すべての設定をリセットしますか？\'\)\) \{[\s\S]*?saveToLocalStorage\(\);\n      \}',
    r'''if (confirm('現在表示中の編成データをリセットしますか？')) {
        const id = currentParty.value.id;
        const name = currentParty.value.name;
        parties.value[activePartyIndex.value] = getDefaultParty(name, id);
        saveToLocalStorage();
      }''',
    js
)

# 5. Add party management functions
party_funcs = r'''const addParty = () => {
      const newId = Date.now();
      const newName = `編成${parties.value.length + 1}`;
      parties.value.push(getDefaultParty(newName, newId));
      activePartyIndex.value = parties.value.length - 1;
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
    };'''

js = js.replace('// ----- UI・選択肢用データ -----', party_funcs + '\n\n    // ----- UI・選択肢用データ -----')

# 6. Replace all settings.value with currentParty.value
js = js.replace('settings.value', 'currentParty.value')

# 7. Add exported variables
js = js.replace('activeTab,', 'activeTab,\n      parties,\n      activePartyIndex,\n      currentParty,\n      addParty,\n      removeParty,')

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(js)

# Update index.html
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Replace settings. with currentParty.
html = html.replace('settings.', 'currentParty.')

# Add Party Tabs UI
tabs_ui = r'''<!-- 編成タブUI -->
      <div class="bg-gray-100 border-b border-gray-200 px-4 pt-2 flex items-end overflow-x-auto shrink-0 custom-scrollbar">
        <div v-for="(party, idx) in parties" :key="party.id" 
          @click="activePartyIndex = idx"
          class="px-4 py-2 mr-1 rounded-t-lg text-sm font-bold cursor-pointer border-t border-l border-r transition-colors flex items-center gap-2 group min-w-[120px] max-w-[200px]"
          :class="activePartyIndex === idx ? 'bg-white text-blue-700 border-gray-200 shadow-[0_4px_0_0_white]' : 'bg-gray-200 text-gray-500 border-gray-300 hover:bg-gray-50'">
          <input v-if="activePartyIndex === idx" v-model="party.name" @click.stop class="bg-transparent border-b border-blue-300 focus:border-blue-600 focus:outline-none w-full text-blue-700 font-bold truncate" />
          <span v-else class="truncate w-full block">{{ party.name }}</span>
          <button v-if="activePartyIndex === idx && parties.length > 1" @click.stop="removeParty(idx)" class="text-red-400 hover:text-red-600 rounded-full p-0.5 hover:bg-red-50 flex-shrink-0" title="編成を削除">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
          </button>
        </div>
        <button @click="addParty" class="px-3 py-2 mr-1 rounded-t-lg text-sm font-bold bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200 transition-colors flex items-center gap-1 shrink-0 mb-[1px]">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" /></svg>
          追加
        </button>
      </div>

      <!-- 上部パネル: シミュレーション設定 -->'''

html = html.replace('<!-- 上部パネル: シミュレーション設定 -->', tabs_ui)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print("Done")
