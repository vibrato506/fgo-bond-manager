import sys
import math
import os
import re
import copy


# ANSI Color Codes
RED = '\033[91m'
RESET = '\033[0m'

try:
    import yaml
except ImportError:
    print("エラー: PyYAMLライブラリが見つかりません。")
    print("pip install PyYAML")
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SCRIPT_DIR)

def load_config(file_path=None):
    if file_path is None:
        file_path = os.path.join(BASE_DIR, 'config.yaml')
        if not os.path.exists(file_path):
            file_path = os.path.join(SCRIPT_DIR, 'config.yaml')
    if not os.path.exists(file_path):
        print(f"エラー: 設定ファイル {file_path} が見つかりません。")
        sys.exit(1)
    with open(file_path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)

class FixedLoadoutSolver:
    def __init__(self, config):
        self.config = config
        self.materials = config['materials']
        self.stage = config['stage']
        self.inventory = config['loadout']['self']
        self.friend_config = config['loadout']['friend']
        self.preconditions = config.get('preconditions', {})
        self.reserved_slots = self.preconditions.get('reserved_slots', 0)
        self.must_equip = self.preconditions.get('must_equip', {})
        self.max_bond_equips = self.preconditions.get('max_bond_equips', 0)
        self.BASE_DROP = self.stage.get('base_drop', 3)

    def _build_loadout(self, needed_ce_keys, custom_inventory=None):
        loadout = {k: {'normal': 0, 'evolved': 0} for k in ['gold', 'silver', 'copper']}
        loadout['bond'] = 0
        total_slots = 5 - self.reserved_slots
        remaining_slots = total_slots
        inv = copy.deepcopy(custom_inventory if custom_inventory is not None else self.inventory)

        for cat, count in self.must_equip.items():
            if count <= 0 or remaining_slots <= 0 or cat not in inv: continue
            needed = min(count, remaining_slots)
            take_e = min(needed, inv[cat].get('evolved', 0))
            loadout[cat]['evolved'] += take_e
            inv[cat]['evolved'] -= take_e
            remaining_slots -= take_e
            needed -= take_e
            if needed > 0:
                take_n = min(needed, inv[cat].get('normal', 0))
                loadout[cat]['normal'] += take_n
                inv[cat]['normal'] -= take_n
                remaining_slots -= take_n

        for ce_key in needed_ce_keys:
            if remaining_slots <= 0: break
            avail_e = inv.get(ce_key, {}).get('evolved', 0)
            take = min(avail_e, remaining_slots)
            if take > 0:
                loadout[ce_key]['evolved'] += take
                inv[ce_key]['evolved'] -= take
                remaining_slots -= take
                
        for ce_key in needed_ce_keys:
            if remaining_slots <= 0: break
            avail_n = inv.get(ce_key, {}).get('normal', 0)
            take = min(avail_n, remaining_slots)
            if take > 0:
                loadout[ce_key]['normal'] += take
                inv[ce_key]['normal'] -= take
                remaining_slots -= take

        if remaining_slots > 0:
            loadout['bond'] = min(remaining_slots, self.max_bond_equips)
            
        return loadout

    def _calc_per_run(self, loadout, friend_type, friend_evolved):
        drops = {}
        base_drop = self.BASE_DROP
        for mat_key in ['gold', 'silver', 'copper']:
            mat_conf = self.materials[mat_key]
            s_norm = loadout.get(mat_key, {}).get('normal', 0)
            s_evo = loadout.get(mat_key, {}).get('evolved', 0)
            bonus = (s_norm * mat_conf.get('bonus_normal', 1)) + (s_evo * mat_conf.get('bonus_evolved', 2))
            if friend_type == mat_key:
                bonus += mat_conf.get('bonus_evolved', 2) if friend_evolved else mat_conf.get('bonus_normal', 1)
            drops[mat_key] = mat_conf.get('boxes', 10) * (base_drop + bonus)
        return drops
        
    def _solve_lp_heuristic(self, loadout, deficits, friend_evolved, fixed_friend_type):
        d_arr = [deficits.get('gold', 0), deficits.get('silver', 0), deficits.get('copper', 0)]
        if max(d_arr) <= 0: return {'gold': 0, 'silver': 0, 'copper': 0}
        
        drops_G = self._calc_per_run(loadout, 'gold', friend_evolved)
        drops_S = self._calc_per_run(loadout, 'silver', friend_evolved)
        drops_C = self._calc_per_run(loadout, 'copper', friend_evolved)
        
        dG = [drops_G['gold'], drops_G['silver'], drops_G['copper']]
        dS = [drops_S['gold'], drops_S['silver'], drops_S['copper']]
        dC = [drops_C['gold'], drops_C['silver'], drops_C['copper']]
        
        if fixed_friend_type != 'auto':
            if fixed_friend_type == 'gold': drops = dG
            elif fixed_friend_type == 'silver': drops = dS
            elif fixed_friend_type == 'copper': drops = dC
            else: drops = dG
            req = max([math.ceil(d_arr[i]/drops[i]) for i in range(3) if drops[i]>0] + [0])
            return {fixed_friend_type: req}
            
        best_runs = float('inf')
        best_x, best_y, best_z = 0, 0, 0
        best_surplus = -float('inf')
        upper_bound = 300
        for x in range(upper_bound + 1):
            for y in range(upper_bound + 1 - x):
                if x + y >= best_runs: break
                rem_G = d_arr[0] - x*dG[0] - y*dS[0]
                rem_S = d_arr[1] - x*dG[1] - y*dS[1]
                rem_C = d_arr[2] - x*dG[2] - y*dS[2]
                
                z1 = math.ceil(rem_G / dC[0]) if rem_G > 0 and dC[0]>0 else 0
                z2 = math.ceil(rem_S / dC[1]) if rem_S > 0 and dC[1]>0 else 0
                z3 = math.ceil(rem_C / dC[2]) if rem_C > 0 and dC[2]>0 else 0
                z = max(0, z1, z2, z3)
                
                if x + y + z < best_runs:
                    best_runs = x + y + z
                    best_x, best_y, best_z = x, y, z
                    best_surplus = (x*dG[0]+y*dS[0]+z*dC[0] - d_arr[0]) + (x*dG[1]+y*dS[1]+z*dC[1] - d_arr[1]) + (x*dG[2]+y*dS[2]+z*dC[2] - d_arr[2])
                elif x + y + z == best_runs:
                    surplus = (x*dG[0]+y*dS[0]+z*dC[0] - d_arr[0]) + (x*dG[1]+y*dS[1]+z*dC[1] - d_arr[1]) + (x*dG[2]+y*dS[2]+z*dC[2] - d_arr[2])
                    if surplus > best_surplus:
                        best_x, best_y, best_z = x, y, z
                        best_surplus = surplus
                    
        return {'gold': best_x, 'silver': best_y, 'copper': best_z}

    def _solve_for_friend(self, fixed_friend_type, friend_evolved, targets):
        accumulated = {k: self.materials[k].get('owned', 0) for k in self.materials.keys()}
        phases = []
        total_runs = 0
        sanity_limit = 1000
        iteration = 0

        while iteration < sanity_limit:
            iteration += 1
            deficits = {k: max(0, targets[k] - accumulated[k]) for k in accumulated.keys()}
            active_mats = [k for k, v in deficits.items() if v > 0]
            if not active_mats: break
            active_ce_types = set([k for k in active_mats if k in ['gold', 'silver', 'copper']])

            # Determine severity to pick the priority order for OWN CEs
            severity = {}
            if fixed_friend_type == 'auto':
                for ce_type in active_ce_types:
                    best_loadout = self._build_loadout([ce_type])
                    best_drop = self._calc_per_run(best_loadout, ce_type, friend_evolved)
                    if ce_type in ['gold', 'silver', 'copper']:
                        severity[ce_type] = deficits[ce_type] / best_drop[ce_type] if best_drop[ce_type] > 0 else float('inf')
            else:
                for ce_type in active_ce_types:
                    best_loadout = self._build_loadout([ce_type]) 
                    best_drop = self._calc_per_run(best_loadout, fixed_friend_type, friend_evolved)
                    if ce_type in ['gold', 'silver', 'copper']:
                        severity[ce_type] = deficits[ce_type] / best_drop[ce_type] if best_drop[ce_type] > 0 else float('inf')

            # 理念の反映：絆礼装枠を極力自前のボーナス礼装枠に置き換え、周回数を最小化する。
            # そのため、人為的な装備数の制限(req_B)を撤廃し、不足度(severity)が高い素材の自前礼装から
            # 装備可能な限り枠いっぱいに詰め込む。
            priority_order = sorted(active_ce_types, key=lambda k: severity[k], reverse=True)
            current_loadout = self._build_loadout(priority_order, custom_inventory=self.inventory)
            
            # LP logic to find exact optimal friend and phase duration
            lp_res = self._solve_lp_heuristic(current_loadout, deficits, friend_evolved, fixed_friend_type)
            optimal_friend = max(lp_res, key=lp_res.get)
            lp_target_runs = lp_res[optimal_friend]
            
            if lp_target_runs <= 0:
                break
                
            current_drops = self._calc_per_run(current_loadout, optimal_friend, friend_evolved)
            
            # Find when the FIRST material finishes, because loadout MIGHT change then
            runs_to_finish = {}
            for k in active_mats:
                if current_drops[k] > 0:
                    runs_to_finish[k] = math.ceil(deficits[k] / current_drops[k])
                else: runs_to_finish[k] = float('inf')
                    
            limit_by_finish = min(runs_to_finish.values())
            
            # Take the smaller of LP suggestion or material finish
            phase_runs = max(1, min(lp_target_runs, limit_by_finish))
            
            if fixed_friend_type == 'auto':
                can_finish_all = True
                for f_test in ['gold', 'silver', 'copper']:
                    test_drops = self._calc_per_run(current_loadout, f_test, friend_evolved)
                    if any(accumulated[mat] + phase_runs * test_drops[mat] < targets[mat] for mat in active_mats):
                        can_finish_all = False
                        break
                if can_finish_all:
                    optimal_friend = 'any'
            
            for k in accumulated.keys(): accumulated[k] += phase_runs * current_drops[k]
            total_runs += phase_runs
            completed_mats = [k for k in active_mats if accumulated[k] >= targets[k]]
            
            phases.append({
                'loadout': copy.deepcopy(current_loadout),
                'friend_type': optimal_friend,
                'runs': phase_runs,
                'completed_resource': completed_mats,
                'drops_per_run': current_drops,
                'accumulated': copy.deepcopy(accumulated)
            })

        return {'total_runs': total_runs, 'phases': phases, 'friend_type': fixed_friend_type, 'friend_evolved': friend_evolved}

    def solve(self):
        targets = {k: self.materials[k]['needed'] for k in self.materials.keys()}
        ft = self.friend_config.get('type', 'auto')
        fe = self.friend_config.get('evolved', True)
        return self._solve_for_friend(ft, fe, targets)


def merge_phases(phases):
    merged = []
    for p in phases:
        if not merged:
            merged.append(copy.deepcopy(p))
            continue
        last = merged[-1]
        if last['friend_type'] == p['friend_type'] and last['loadout'] == p['loadout']:
            last['runs'] += p['runs']
            last['accumulated'] = copy.deepcopy(p['accumulated'])
            last['completed_resource'].extend(p['completed_resource'])
        else:
            merged.append(copy.deepcopy(p))
    return merged

def generate_markdown(result_a, result_b, result_c, config, title, timber_boxes):
    md = []
    md.append(f"# 📊 {title}\n")
    md.append("> [!TIP]")
    md.append(f"> **前提条件**: {title.split(': ')[-1]}のドロップ率（金{config['materials']['gold']['boxes']} / 銀{config['materials']['silver']['boxes']} / 銅{config['materials']['copper']['boxes']}枠）を想定したプランです。\n")
    md.append("---\n")
    md.append("## 🎯 目標と現在の所持数\n")
    md.append("| 素材 | 現在の所持数 | 目標（必要数） |")
    md.append("| :--- | :--- | :--- |")
    name_gold = config['materials']['gold'].get('name', '金素材')
    name_silver = config['materials']['silver'].get('name', '銀素材')
    name_copper = config['materials']['copper'].get('name', '銅素材')
    md.append(f"| 🟡 **{name_gold}** | {config['materials']['gold']['owned']:,} 個 | {config['materials']['gold']['needed']:,} 個 |")
    md.append(f"| ⚪️ **{name_silver}** | {config['materials']['silver']['owned']:,} 個 | {config['materials']['silver']['needed']:,} 個 |")
    md.append(f"| 🟠 **{name_copper}** | {config['materials']['copper']['owned']:,} 個 | {config['materials']['copper']['needed']:,} 個 |\n")
    
    def format_phases(phases):
        lines = []
        for i, phase in enumerate(phases):
            is_last = (i == len(phases) - 1)
            runs = phase['runs']
            friend = "金(進化)" if phase['friend_type'] == 'gold' else "銀(進化)" if phase['friend_type'] == 'silver' else "銅(進化)"
            if phase['friend_type'] == 'none': friend = "なし"
            if phase['friend_type'] == 'any': friend = "おまかせ(どれでもOK)"
            
            l = phase['loadout']
            parts = []
            for mat_key, label in [('gold', '金'), ('silver', '銀'), ('copper', '銅')]:
                e = l.get(mat_key, {}).get('evolved', 0)
                n = l.get(mat_key, {}).get('normal', 0)
                if e > 0 and n > 0: parts.append(f"{label}(進x{e},未x{n})")
                elif e > 0: parts.append(f"{label}(進x{e})")
                elif n > 0: parts.append(f"{label}(未x{n})")
            
            bond = l.get('bond', 0)
            if bond > 0: parts.append(f"絆・自由枠x{bond}")
            
            own_str = ", ".join(parts) if parts else "なし"
            lines.append(f"### フェーズ {i+1} 【 {runs} 周 】")
            lines.append(f"*   **編成礼装**: 自前 `[{own_str}]` ＋ フレンド `[{friend}]`")
            drops = phase['drops_per_run']
            lines.append(f"*   **1周の目安**: 🟡 +{drops['gold']:.1f} / ⚪️ +{drops['silver']:.1f} / 🟠 +{drops['copper']:.1f}")
            acc = phase['accumulated']
            lines.append(f"*   *(終了時点: 🟡 {acc['gold']:,.0f} / ⚪️ {acc['silver']:,.0f} / 🟠 {acc['copper']:,.0f})*")
            
            if phase.get('completed_resource') and not is_last:
                comp = []
                if 'gold' in phase['completed_resource']: comp.append(f"🟡 **{name_gold}**")
                if 'silver' in phase['completed_resource']: comp.append(f"⚪️ **{name_silver}**")
                if 'copper' in phase['completed_resource']: comp.append(f"🟠 **{name_copper}**")
                if comp:
                    lines.append("> [!NOTE]")
                    lines.append(f"> {'・'.join(comp)} がここで目標達成！")
            lines.append("")
        return "\n".join(lines)

    runs_a = result_a['total_runs']
    runs_b = result_b['total_runs']
    runs_c = result_c['total_runs']
    min_runs = min(runs_a, runs_b, runs_c)

    def get_star(runs):
        return " ✨(おすすめ)" if runs == min_runs else ""

    # Plan A
    md.append("---\n")
    md.append(f"## 🏃‍♂️ プランA: 【最適・フレンド切り替え】 (全 {runs_a} 周){get_star(runs_a)}\n")
    md.append("**【フレンド枠】**: フェーズ毎に最適なボーナス礼装（進化/凸）を借りて調整します。\n")
    md.append(format_phases(merge_phases(result_a['phases'])))
    
    # Plan B
    md.append("---\n")
    md.append(f"## 🏃‍♂️ プランB: 【フレンド固定】金礼装(凸) のみ借りる場合 (全 {runs_b} 周){get_star(runs_b)}\n")
    md.append("**【フレンド枠】**: 全ての周回で固定して `[金(進化)]` を借ります。\n")
    md.append(format_phases(merge_phases(result_b['phases'])))
    if runs_b > min_runs:
        md.append(f"> [!WARNING]")
        md.append(f"> フレンドを切り替えずに金礼装だけを借り続けると、銀素材などが最後まで残るため、最適プランよりも **+{runs_b - min_runs}周** 多く周回する必要があります。\n")

    # Plan C
    md.append("---\n")
    md.append(f"## 🏃‍♂️ プランC: 【自前礼装完全フリー】 (全 {runs_c} 周){get_star(runs_c)}\n")
    md.append("**【フレンド枠】**: プランAと同じように切り替えますが、**自前は最初から最後まで一切イベント礼装を装備しません（完全自由枠x5）**。\n")
    md.append(format_phases(merge_phases(result_c['phases'])))
    if runs_c == min_runs:
        md.append("> [!TIP]")
        md.append("> 自前のイベント礼装を一切装備しなくても（完全自由枠x5）、最短周回数でクリア可能です！銅礼装の装備コストがゼロになるため、こちらのプランがおすすめです。\n")
    elif runs_c - min_runs <= 2:
        md.append("> [!TIP]")
        md.append(f"> 最短プランと比べてもわずか **+{runs_c - min_runs}周** の差です。自前のイベント礼装を外して「絆アップ礼装」などを5枠フルで積めるため、実質的にはこのプランが最もおすすめです！\n")
    

    def format_final(res):
        acc = res['phases'][-1]['accumulated']
        lines = []
        for key, icon, name in [('gold', '🟡', name_gold), ('silver', '⚪️', name_silver), ('copper', '🟠', name_copper)]:
            needed = config['materials'][key]['needed']
            surplus = acc[key] - needed
            if surplus > 0:
                s_text = f"(余剰 +{surplus:,.0f})"
            elif surplus == 0:
                s_text = "(必要数ピッタリ +0)"
            else:
                s_text = f"(不足 {abs(surplus):,.0f})"
            lines.append(f"*   {icon} **{name}**: {acc[key]:,.0f} 個 `{s_text}`")
        return "\n".join(lines)

    md.append("---\n")
    md.append("## 🏆 最終結果\n")
    md.append(f"### プランA（全 {runs_a} 周）の獲得予測{get_star(runs_a)}\n" + format_final(result_a) + "\n")
    md.append(f"### プランB（全 {runs_b} 周）の獲得予測{get_star(runs_b)}\n" + format_final(result_b) + "\n")
    md.append(f"### プランC（全 {runs_c} 周）の獲得予測{get_star(runs_c)}\n" + format_final(result_c) + "\n")

    # 固有のアイテム予測などを追加する場合はここに記述します
    return "\n".join(md)

def generate_all_short_markdown(shorts_data, config):
    lines = []
    
    lines.append("【現在の素材状況】")
    lines.append(f"🟡金: {config['materials']['gold']['owned']:,} / {config['materials']['gold']['needed']:,}")
    lines.append(f"⚪️銀: {config['materials']['silver']['owned']:,} / {config['materials']['silver']['needed']:,}")
    lines.append(f"🟠銅: {config['materials']['copper']['owned']:,} / {config['materials']['copper']['needed']:,}")
    lines.append("")
    
    shorts_data_sorted = sorted(shorts_data, key=lambda x: x['title'], reverse=True)
    
    for s_data in shorts_data_sorted:
        title = s_data['title']
        result_a = s_data['result_a']
        result_b = s_data['result_b']
        result_c = s_data['result_c']
        
        lines.append(f"■ {title}")
        
        plans = [
            ('プランA(最適・フレ切替)', result_a, result_a['total_runs']),
            ('プランB(金礼装固定)', result_b, result_b['total_runs']),
            ('プランC(自前礼装フリー)', result_c, result_c['total_runs'])
        ]
        plans.sort(key=lambda x: x[2])
        
        for i, (p_name, res, runs) in enumerate(plans[:2]):
            lines.append(f" {i+1}位: {p_name} (全 {runs} 周)")
            phases = merge_phases(res['phases'])
            for phase in phases:
                friend = "金(進化)" if phase['friend_type'] == 'gold' else "銀(進化)" if phase['friend_type'] == 'silver' else "銅(進化)"
                if phase['friend_type'] == 'none': friend = "なし"
                if phase['friend_type'] == 'any': friend = "おまかせ"
                
                l = phase['loadout']
                parts = []
                for mat_key, label in [('gold', '金'), ('silver', '銀'), ('copper', '銅')]:
                    e = l.get(mat_key, {}).get('evolved', 0)
                    n = l.get(mat_key, {}).get('normal', 0)
                    if e > 0 and n > 0: parts.append(f"{label}(進x{e},未x{n})")
                    elif e > 0: parts.append(f"{label}(進x{e})")
                    elif n > 0: parts.append(f"{label}(未x{n})")
                
                bond = l.get('bond', 0)
                if bond > 0: parts.append(f"絆自由x{bond}")
                
                own_str = ", ".join(parts) if parts else "なし"
                lines.append(f"  【{phase['runs']}周】自前: {own_str} / フレ: {friend}")
                
                acc = phase['accumulated']
                lines.append(f"  (終了時点: 🟡 {int(acc['gold']):,} / ⚪️ {int(acc['silver']):,} / 🟠 {int(acc['copper']):,})")
            
            acc = res['phases'][-1]['accumulated']
            final_strs = []
            for mat_key, label in [('gold', '🟡'), ('silver', '⚪️'), ('copper', '🟠')]:
                needed = config['materials'][mat_key]['needed']
                surplus = int(acc[mat_key] - needed)
                surplus_str = f"+{surplus}" if surplus > 0 else str(surplus)
                final_strs.append(f"{label} {int(acc[mat_key]):,}(余剰{surplus_str})")
            lines.append(f"  最終: {' / '.join(final_strs)}")
            lines.append("")
        
        lines.append("")

    # 固有のアイテム予測などを追加する場合はここに記述します

    return "\n".join(lines).strip()

def get_quest_results(quest_key, quest_data, config_template):
    config = copy.deepcopy(config_template)
    if 'stage' not in config:
        config['stage'] = {}
    config['stage']['base_drop'] = quest_data.get('base_drop', 3)
    for mat in ['gold', 'silver', 'copper']:
        config['materials'][mat]['boxes'] = quest_data['boxes'][mat]
    
    # Plan A: Auto (Standard)
    config_a = copy.deepcopy(config)
    config_a['loadout']['friend']['type'] = 'auto'
    solver_a = FixedLoadoutSolver(config_a)
    result_a = solver_a.solve()
    
    # Plan B: Gold Fixed
    config_b = copy.deepcopy(config)
    config_b['loadout']['friend']['type'] = 'gold'
    solver_b = FixedLoadoutSolver(config_b)
    result_b = solver_b.solve()
    
    # Plan C: Auto, No Own CE
    config_c = copy.deepcopy(config)
    config_c['loadout']['friend']['type'] = 'auto'
    for k in ['gold', 'silver', 'copper']:
        config_c['loadout']['self'][k] = {'normal': 0, 'evolved': 0}
    solver_c = FixedLoadoutSolver(config_c)
    result_c = solver_c.solve()
    
    long_md = generate_markdown(result_a, result_b, result_c, config, quest_data['title'], quest_data['timber_boxes'])
    short_data = {
        'title': quest_data['title'],
        'timber_boxes': quest_data['timber_boxes'],
        'result_a': result_a,
        'result_b': result_b,
        'result_c': result_c
    }
    return long_md, short_data

def run_all_quests(config):
    md_longs = []
    shorts_data = []
    quests = config.get('quests', {})
    
    if not quests:
        # Fallback for old config.yaml
        q_data = {
            'title': "リザルト: 周回シミュレーション",
            'base_drop': config.get('stage', {}).get('base_drop', 3),
            'timber_boxes': 0,
            'boxes': {
                'gold': config['materials']['gold'].get('boxes', 9),
                'silver': config['materials']['silver'].get('boxes', 9),
                'copper': config['materials']['copper'].get('boxes', 9)
            }
        }
        long_md, s_data = get_quest_results('default', q_data, config)
        md_longs.append(long_md)
        shorts_data.append(s_data)
    else:
        for q_key, q_data in quests.items():
            long_md, s_data = get_quest_results(q_key, q_data, config)
            md_longs.append(long_md)
            shorts_data.append(s_data)
            
    short_output = generate_all_short_markdown(shorts_data, config)
    return "\n\n<br>\n<br>\n\n".join(md_longs), short_output

# --- LINE Bot連携用 ---
def run_for_line(custom_config):
    return run_all_quests(custom_config)[1]

def main():
    config = load_config()
    markdown_output, short_output = run_all_quests(config)
    
    result_path = os.path.join(BASE_DIR, 'result.md')
    short_path = os.path.join(BASE_DIR, 'result_short.md')
    try:
        with open(result_path, 'w', encoding='utf-8') as f:
            f.write(markdown_output)
        with open(short_path, 'w', encoding='utf-8') as f:
            f.write(short_output)
    except FileNotFoundError:
        result_path = os.path.join(SCRIPT_DIR, 'result.md')
        short_path = os.path.join(SCRIPT_DIR, 'result_short.md')
        with open(result_path, 'w', encoding='utf-8') as f:
            f.write(markdown_output)
        with open(short_path, 'w', encoding='utf-8') as f:
            f.write(short_output)
    
    print(f"シミュレーションが完了しました。\n詳細な結果: {result_path}\n簡潔版: {short_path} に保存しました。")

if __name__ == "__main__":
    main()
