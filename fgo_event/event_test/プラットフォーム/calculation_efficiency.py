import sys
import math
import os
import copy
from itertools import product

try:
    import yaml
except ImportError:
    print("エラー: PyYAMLライブラリが見つかりません。")
    sys.exit(1)

try:
    import pulp
except ImportError:
    print("エラー: PuLPライブラリが見つかりません。 pip install pulp を実行してください。")
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

class IPFarmingSolver:
    def __init__(self, config, allowed_quests):
        self.config = config
        self.materials = config['materials']
        self.quests = config.get('quests', {})
        self.allowed_quests = [q for q in allowed_quests if q in self.quests]
        self.inventory = config['loadout']['self']
        self.preconditions = config.get('preconditions', {})
        self.reserved_slots = self.preconditions.get('reserved_slots', 0)
        self.max_bond_equips = self.preconditions.get('max_bond_equips', 5)
        self.max_slots = 5 - self.reserved_slots

    def _generate_valid_loadouts(self):
        inv = {
            'ge': self.inventory.get('gold', {}).get('evolved', 0),
            'gn': self.inventory.get('gold', {}).get('normal', 0),
            'se': self.inventory.get('silver', {}).get('evolved', 0),
            'sn': self.inventory.get('silver', {}).get('normal', 0),
            'ce': self.inventory.get('copper', {}).get('evolved', 0),
            'cn': self.inventory.get('copper', {}).get('normal', 0)
        }
        
        max_ge = min(inv['ge'], self.max_slots)
        max_gn = min(inv['gn'], self.max_slots)
        max_se = min(inv['se'], self.max_slots)
        max_sn = min(inv['sn'], self.max_slots)
        max_ce = min(inv['ce'], self.max_slots)
        max_cn = min(inv['cn'], self.max_slots)
        
        valid_loadouts = []
        for ge in range(max_ge + 1):
            for gn in range(max_gn + 1):
                if ge + gn > self.max_slots: break
                for se in range(max_se + 1):
                    if ge + gn + se > self.max_slots: break
                    for sn in range(max_sn + 1):
                        if ge + gn + se + sn > self.max_slots: break
                        for ce in range(max_ce + 1):
                            if ge + gn + se + sn + ce > self.max_slots: break
                            for cn in range(max_cn + 1):
                                total = ge + gn + se + sn + ce + cn
                                if total > self.max_slots: break
                                valid_loadouts.append({
                                    'ge': ge, 'gn': gn,
                                    'se': se, 'sn': sn,
                                    'ce': ce, 'cn': cn,
                                    'bond': min(self.max_slots - total, self.max_bond_equips)
                                })
        return valid_loadouts

    def _calc_drops_per_run(self, quest_key, loadout, friend_type):
        quest = self.quests[quest_key]
        base_drop = quest.get('base_drop', 3)
        boxes = quest.get('boxes', {'gold': 0, 'silver': 0, 'copper': 0})
        
        drops = {}
        for mat, c_key, e_key in [('gold', 'gn', 'ge'), ('silver', 'sn', 'se'), ('copper', 'cn', 'ce')]:
            mat_conf = self.materials[mat]
            b_norm = mat_conf.get('bonus_normal', 1)
            b_evo = mat_conf.get('bonus_evolved', 2)
            
            bonus = loadout[c_key] * b_norm + loadout[e_key] * b_evo
            if friend_type == mat:
                bonus += b_evo
            
            drops[mat] = boxes.get(mat, 0) * (base_drop + bonus)
        return drops

    def solve(self):
        needed = {
            'gold': max(0, self.materials['gold'].get('needed', 0) - self.materials['gold'].get('owned', 0)),
            'silver': max(0, self.materials['silver'].get('needed', 0) - self.materials['silver'].get('owned', 0)),
            'copper': max(0, self.materials['copper'].get('needed', 0) - self.materials['copper'].get('owned', 0))
        }
        
        if sum(needed.values()) <= 0:
            return {'total_runs': 0, 'phases': [], 'accumulated': {'gold': 0, 'silver': 0, 'copper': 0}}
            
        loadouts = self._generate_valid_loadouts()
        friend_types = ['gold', 'silver', 'copper', 'none']
        
        prob = pulp.LpProblem("FarmingOptimization", pulp.LpMinimize)
        
        patterns = []
        var_dict = {}
        idx = 0
        
        for q in self.allowed_quests:
            for l in loadouts:
                for f in friend_types:
                    drops = self._calc_drops_per_run(q, l, f)
                    if sum(drops.values()) > 0:
                        var = pulp.LpVariable(f"x_{idx}", lowBound=0, cat='Integer')
                        var_dict[var] = {'quest': q, 'loadout': l, 'friend': f, 'drops': drops}
                        patterns.append(var)
                        idx += 1
                        
        if not patterns:
            return None
            
        prob += pulp.lpSum(patterns)
        
        prob += pulp.lpSum([v * var_dict[v]['drops']['gold'] for v in patterns]) >= needed['gold']
        prob += pulp.lpSum([v * var_dict[v]['drops']['silver'] for v in patterns]) >= needed['silver']
        prob += pulp.lpSum([v * var_dict[v]['drops']['copper'] for v in patterns]) >= needed['copper']
        
        prob.solve(pulp.PULP_CBC_CMD(msg=0))
        
        if pulp.LpStatus[prob.status] != 'Optimal':
            return None
            
        phases = []
        total_runs = 0
        acc_g = 0; acc_s = 0; acc_c = 0
        
        for v in patterns:
            runs = int(round(v.varValue))
            if runs > 0:
                p_data = var_dict[v]
                phases.append({
                    'quest': p_data['quest'],
                    'loadout': p_data['loadout'],
                    'friend': p_data['friend'],
                    'runs': runs,
                    'drops_per_run': p_data['drops']
                })
                total_runs += runs
                acc_g += p_data['drops']['gold'] * runs
                acc_s += p_data['drops']['silver'] * runs
                acc_c += p_data['drops']['copper'] * runs
                
        accumulated = {
            'gold': self.materials['gold'].get('owned', 0) + acc_g,
            'silver': self.materials['silver'].get('owned', 0) + acc_s,
            'copper': self.materials['copper'].get('owned', 0) + acc_c
        }
        
        phases.sort(key=lambda x: x['runs'], reverse=True)
        
        return {'total_runs': total_runs, 'phases': phases, 'accumulated': accumulated}

def format_phases(phases, config):
    lines = []
    quests_conf = config.get('quests', {})
    for i, phase in enumerate(phases):
        q_title = quests_conf.get(phase['quest'], {}).get('title', phase['quest'])
        runs = phase['runs']
        
        f_map = {'gold': '金(進化)', 'silver': '銀(進化)', 'copper': '銅(進化)', 'none': 'なし'}
        friend = f_map.get(phase['friend'], 'なし')
        
        l = phase['loadout']
        parts = []
        if l['ge'] > 0 and l['gn'] > 0: parts.append(f"金(進x{l['ge']},未x{l['gn']})")
        elif l['ge'] > 0: parts.append(f"金(進x{l['ge']})")
        elif l['gn'] > 0: parts.append(f"金(未x{l['gn']})")
        
        if l['se'] > 0 and l['sn'] > 0: parts.append(f"銀(進x{l['se']},未x{l['sn']})")
        elif l['se'] > 0: parts.append(f"銀(進x{l['se']})")
        elif l['sn'] > 0: parts.append(f"銀(未x{l['sn']})")
        
        if l['ce'] > 0 and l['cn'] > 0: parts.append(f"銅(進x{l['ce']},未x{l['cn']})")
        elif l['ce'] > 0: parts.append(f"銅(進x{l['ce']})")
        elif l['cn'] > 0: parts.append(f"銅(未x{l['cn']})")
        
        if l['bond'] > 0: parts.append(f"絆・自由枠x{l['bond']}")
        
        own_str = ", ".join(parts) if parts else "なし"
        
        lines.append(f"### 📍 {q_title} 【 {runs} 周 】")
        lines.append(f"*   **編成礼装**: 自前 `[{own_str}]` ＋ フレンド `[{friend}]`")
        drops = phase['drops_per_run']
        lines.append(f"*   **1周の目安**: 🟡 +{drops['gold']:.1f} / ⚪️ +{drops['silver']:.1f} / 🟠 +{drops['copper']:.1f}")
        lines.append("")
    return "\n".join(lines)

def generate_markdown(res_a, res_b, res_c, config):
    md = []
    md.append("# 📊 周回シミュレーション結果\n")
    
    md.append("## 🎯 目標と現在の所持数\n")
    md.append("| 素材 | 現在の所持数 | 目標（必要数） |")
    md.append("| :--- | :--- | :--- |")
    name_gold = config['materials']['gold'].get('name', '金素材')
    name_silver = config['materials']['silver'].get('name', '銀素材')
    name_copper = config['materials']['copper'].get('name', '銅素材')
    md.append(f"| 🟡 **{name_gold}** | {config['materials']['gold']['owned']:,} 個 | {config['materials']['gold']['needed']:,} 個 |")
    md.append(f"| ⚪️ **{name_silver}** | {config['materials']['silver']['owned']:,} 個 | {config['materials']['silver']['needed']:,} 個 |")
    md.append(f"| 🟠 **{name_copper}** | {config['materials']['copper']['owned']:,} 個 | {config['materials']['copper']['needed']:,} 個 |\n")
    
    runs_a = res_a['total_runs'] if res_a else float('inf')
    runs_b = res_b['total_runs'] if res_b else float('inf')
    runs_c = res_c['total_runs'] if res_c else float('inf')
    min_runs = min(runs_a, runs_b, runs_c)
    
    def get_star(runs):
        return " ✨(全体最短)" if runs == min_runs and runs != float('inf') else ""
        
    if res_a:
        md.append("---\n")
        md.append(f"## 🏃‍♂️ プランA: 【全体最適・クエスト混合】 (全 {res_a['total_runs']} 周){get_star(res_a['total_runs'])}\n")
        md.append("**【対象クエスト】**: すべてのクエストを利用し、最も効率の良い組み合わせを導き出します。\n")
        md.append(format_phases(res_a['phases'], config))
        
    if res_b:
        md.append("---\n")
        q1 = list(config['quests'].keys())[0]
        q1_title = config['quests'][q1].get('title', q1)
        md.append(f"## 🏃‍♂️ プランB: 【{q1_title}のみ】 (全 {res_b['total_runs']} 周){get_star(res_b['total_runs'])}\n")
        md.append(format_phases(res_b['phases'], config))
        
    if res_c:
        md.append("---\n")
        q2 = list(config['quests'].keys())[1]
        q2_title = config['quests'][q2].get('title', q2)
        md.append(f"## 🏃‍♂️ プランC: 【{q2_title}のみ】 (全 {res_c['total_runs']} 周){get_star(res_c['total_runs'])}\n")
        md.append(format_phases(res_c['phases'], config))

    def format_final(res):
        if not res: return "計算不可"
        acc = res['accumulated']
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
    if res_a: md.append(f"### プランA（全 {res_a['total_runs']} 周）の獲得予測{get_star(res_a['total_runs'])}\n" + format_final(res_a) + "\n")
    if res_b: md.append(f"### プランB（全 {res_b['total_runs']} 周）の獲得予測{get_star(res_b['total_runs'])}\n" + format_final(res_b) + "\n")
    if res_c: md.append(f"### プランC（全 {res_c['total_runs']} 周）の獲得予測{get_star(res_c['total_runs'])}\n" + format_final(res_c) + "\n")
    
    return "\n".join(md)

def generate_all_short_markdown(res_a, res_b, res_c, config):
    lines = []
    lines.append("【現在の素材状況】")
    lines.append(f"🟡金: {config['materials']['gold']['owned']:,} / {config['materials']['gold']['needed']:,}")
    lines.append(f"⚪️銀: {config['materials']['silver']['owned']:,} / {config['materials']['silver']['needed']:,}")
    lines.append(f"🟠銅: {config['materials']['copper']['owned']:,} / {config['materials']['copper']['needed']:,}")
    lines.append("")
    
    plans = []
    if res_a: plans.append(('プランA(クエスト混合)', res_a))
    if res_b: plans.append(('プランB(クエスト1のみ)', res_b))
    if res_c: plans.append(('プランC(クエスト2のみ)', res_c))
    
    for p_name, res in plans:
        lines.append(f"■ {p_name} (全 {res['total_runs']} 周)")
        quests_conf = config.get('quests', {})
        for phase in res['phases']:
            q_title = quests_conf.get(phase['quest'], {}).get('title', phase['quest']).split(":")[-1].strip()
            friend = {'gold': '金(進化)', 'silver': '銀(進化)', 'copper': '銅(進化)', 'none': 'なし'}.get(phase['friend'], 'なし')
            l = phase['loadout']
            parts = []
            if l['ge'] > 0 and l['gn'] > 0: parts.append(f"金(進x{l['ge']},未x{l['gn']})")
            elif l['ge'] > 0: parts.append(f"金(進x{l['ge']})")
            elif l['gn'] > 0: parts.append(f"金(未x{l['gn']})")
            if l['se'] > 0 and l['sn'] > 0: parts.append(f"銀(進x{l['se']},未x{l['sn']})")
            elif l['se'] > 0: parts.append(f"銀(進x{l['se']})")
            elif l['sn'] > 0: parts.append(f"銀(未x{l['sn']})")
            if l['ce'] > 0 and l['cn'] > 0: parts.append(f"銅(進x{l['ce']},未x{l['cn']})")
            elif l['ce'] > 0: parts.append(f"銅(進x{l['ce']})")
            elif l['cn'] > 0: parts.append(f"銅(未x{l['cn']})")
            if l['bond'] > 0: parts.append(f"絆自由x{l['bond']}")
            own_str = ", ".join(parts) if parts else "なし"
            
            lines.append(f"  [{q_title}] {phase['runs']}周 | 自: {own_str} / フレ: {friend}")
            
        acc = res['accumulated']
        final_strs = []
        for mat_key, label in [('gold', '🟡'), ('silver', '⚪️'), ('copper', '🟠')]:
            needed = config['materials'][mat_key]['needed']
            surplus = int(acc[mat_key] - needed)
            surplus_str = f"+{surplus}" if surplus > 0 else str(surplus)
            final_strs.append(f"{label} {int(acc[mat_key]):,}(余剰{surplus_str})")
        lines.append(f"  最終: {' / '.join(final_strs)}")
        lines.append("")

    return "\n".join(lines).strip()

def run_all_quests(config):
    quests = list(config.get('quests', {}).keys())
    
    solver_a = IPFarmingSolver(config, quests)
    res_a = solver_a.solve()
    
    res_b = None
    if len(quests) > 0:
        solver_b = IPFarmingSolver(config, [quests[0]])
        res_b = solver_b.solve()
        
    res_c = None
    if len(quests) > 1:
        solver_c = IPFarmingSolver(config, [quests[1]])
        res_c = solver_c.solve()

    long_md = generate_markdown(res_a, res_b, res_c, config)
    short_output = generate_all_short_markdown(res_a, res_b, res_c, config)
    return long_md, short_output

def run_for_line(custom_config):
    return run_all_quests(custom_config)[1]

def main():
    config = load_config()
    markdown_output, short_output = run_all_quests(config)
    
    result_path = os.path.join(SCRIPT_DIR, 'result.md')
    short_path = os.path.join(SCRIPT_DIR, 'result_short.md')
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
