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

def load_config(file_path=None):
    if file_path is None:
        file_path = os.path.join(SCRIPT_DIR, 'config.yaml')
    if not os.path.exists(file_path):
        print(f"エラー: 設定ファイル {file_path} が見つかりません。")
        sys.exit(1)
    with open(file_path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)

# -----------------------------------------------------------------------------
# Solver Class for Multi-Phase Loadout Optimization (6種素材・ALLコン版)
# -----------------------------------------------------------------------------

class FixedLoadoutSolver:
    """
    ポイントが存在しないイベント向けのマルチフェーズ最適化ソルバー。
    各素材の不足量を計算し、最も完了に時間がかかる素材から優先的に礼装を装備。
    """
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
        """
        指定された素材のCEを優先順位順に装備し、残りを絆CEで埋める。
        （設定ファイルの所持数にしたがって装備する）
        """
        loadout = {k: {'normal': 0, 'evolved': 0} for k in ['gold', 'silver', 'copper']}
        loadout['bond'] = 0
        total_slots = 5 - self.reserved_slots
        remaining_slots = total_slots
        inv = copy.deepcopy(custom_inventory if custom_inventory is not None else self.inventory)

        # Must Equip
        for cat, count in self.must_equip.items():
            if count <= 0 or remaining_slots <= 0 or cat not in inv:
                continue
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

        # CE Equip (evolved first, then normal)
        for ce_key in needed_ce_keys:
            if remaining_slots <= 0:
                break
            avail_e = inv.get(ce_key, {}).get('evolved', 0)
            take = min(avail_e, remaining_slots)
            if take > 0:
                loadout[ce_key]['evolved'] += take
                inv[ce_key]['evolved'] -= take
                remaining_slots -= take
                
        for ce_key in needed_ce_keys:
            if remaining_slots <= 0:
                break
            avail_n = inv.get(ce_key, {}).get('normal', 0)
            take = min(avail_n, remaining_slots)
            if take > 0:
                loadout[ce_key]['normal'] += take
                inv[ce_key]['normal'] -= take
                remaining_slots -= take

        # Bond CEs
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

    def _solve_for_friend(self, fixed_friend_type, friend_evolved, targets):
        """最適周回数とフェーズを計算する。fixed_friend_type='auto' ならフェーズ毎に最適フレンドを選択"""
        accumulated = {k: self.materials[k].get('owned', 0) for k in self.materials.keys()}
        phases = []
        total_runs = 0

        # ループ安全装置
        sanity_limit = 1000
        iteration = 0

        while iteration < sanity_limit:
            iteration += 1
            deficits = {k: max(0, targets[k] - accumulated[k]) for k in accumulated.keys()}
            active_mats = [k for k, v in deficits.items() if v > 0]
            
            if not active_mats:
                break
                
            active_ce_types = set([k for k in active_mats if k in ['gold', 'silver', 'copper']])

            if fixed_friend_type == 'auto':
                # 動的フレンド選択：ボトルネックを測るため、それぞれ「最適フレンド」を借りた前提で深刻度を出す
                severity = {}
                for ce_type in active_ce_types:
                    best_loadout = self._build_loadout([ce_type])
                    best_drop = self._calc_per_run(best_loadout, ce_type, friend_evolved)
                    if ce_type in ['gold', 'silver', 'copper']:
                        severity[ce_type] = deficits[ce_type] / best_drop[ce_type] if best_drop[ce_type] > 0 else float('inf')
                
                R_lower_bound = max(severity.values()) if severity else 0
                optimal_friend = max(severity, key=severity.get) if severity else 'none'
            else:
                optimal_friend = fixed_friend_type
                severity = {}
                for ce_type in active_ce_types:
                    best_loadout = self._build_loadout([ce_type]) 
                    best_drop = self._calc_per_run(best_loadout, optimal_friend, friend_evolved)
                    if ce_type in ['gold', 'silver', 'copper']:
                        severity[ce_type] = deficits[ce_type] / best_drop[ce_type] if best_drop[ce_type] > 0 else float('inf')
                
                R_lower_bound = max(severity.values()) if severity else 0

            empty_loadout = self._build_loadout([])
            base_drops = self._calc_per_run(empty_loadout, optimal_friend, friend_evolved)

            target_inventory = {}
            for k in ['gold', 'silver', 'copper']:
                target_inventory[k] = {'normal': 0, 'evolved': 0}
                
            needs_ce = []
            for k in active_ce_types:
                target_rate = deficits[k] / R_lower_bound if R_lower_bound > 0 else 0
                needed_boxes_bonus = (target_rate - base_drops[k]) / self.materials[k].get('boxes', 1)
                req_B = max(0, math.ceil(needed_boxes_bonus - 1e-9))
                
                if req_B > 0:
                    needs_ce.append(k)
                    avail_e = self.inventory.get(k, {}).get('evolved', 0)
                    avail_n = self.inventory.get(k, {}).get('normal', 0)
                    se, sn, curr_B = 0, 0, 0
                    
                    while curr_B < req_B:
                        remaining = req_B - curr_B
                        if remaining == 1 and avail_n > 0:
                            avail_n -= 1
                            sn += 1
                            curr_B += 1
                        elif avail_e > 0:
                            avail_e -= 1
                            se += 1
                            curr_B += 2
                        elif avail_n > 0:
                            avail_n -= 1
                            sn += 1
                            curr_B += 1
                        else:
                            break
                    target_inventory[k]['normal'] = sn
                    target_inventory[k]['evolved'] = se

            priority_order = sorted(needs_ce, key=lambda k: severity[k], reverse=True)
            current_loadout = self._build_loadout(priority_order, custom_inventory=target_inventory)
            current_drops = self._calc_per_run(current_loadout, optimal_friend, friend_evolved)
            
            # この編成で走った場合、最初にどれかの素材が目標達成するまでの周回数
            runs_to_finish = {}
            for k in active_mats:
                if current_drops[k] > 0:
                    full_finish = math.ceil(deficits[k] / current_drops[k])
                    gains = current_drops[k] - base_drops[k]
                    if gains > 1e-9:
                        surplus_at_R = base_drops[k] * R_lower_bound
                        if deficits[k] > surplus_at_R:
                            r_k = (deficits[k] - surplus_at_R) / gains
                            ce_drop_turn = max(1, math.ceil(r_k))
                            runs_to_finish[k] = min(full_finish, ce_drop_turn)
                        else:
                            runs_to_finish[k] = min(full_finish, 1)
                    else:
                        runs_to_finish[k] = full_finish
                else:
                    runs_to_finish[k] = float('inf')
                    
            phase_runs = max(1, min(runs_to_finish.values()))
            
            # 適用
            for k in accumulated.keys():
                accumulated[k] += phase_runs * current_drops[k]
                
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

        return {
            'total_runs': total_runs,
            'phases': phases,
            'friend_type': fixed_friend_type,
            'friend_evolved': friend_evolved
        }

    def solve(self):
        """設定ファイルで指定されたフレンドを利用して最適プランを計算する"""
        targets = {k: self.materials[k]['needed'] for k in self.materials.keys()}
        
        ft = self.friend_config.get('type', 'auto')
        fe = self.friend_config.get('evolved', True)
        
        result = self._solve_for_friend(ft, fe, targets)
        return result


def format_fixed_loadout_results(result, solver):
    if not result or not result.get('phases') and result.get('total_runs') > 0:
        return "最適解が見つかりませんでした。"
    if result.get('total_runs') == 0:
        return "既にすべての素材が目標数に達しています。"

    lines = []
    lines.append("========================================")
    lines.append("       最適周回プラン (3種基本素材版)")
    lines.append("========================================")

    lines.append("\n【現在の所持数】")
    for k in ['gold', 'silver', 'copper']:
        mat_name = solver.materials[k]['name']
        lines.append(f"  {mat_name}: {solver.materials[k]['owned']:,} 個 / 必要数: {solver.materials[k]['needed']:,}")

    friend_names = {'gold': '金', 'silver': '銀', 'copper': '銅', 'none': 'なし'}
    f_status = '進化' if result['friend_evolved'] else '未進化'
    
    if result['friend_type'] == 'auto':
        lines.append(f"\n【フレンド】フェーズ毎に最適選択({f_status})")
    elif result['friend_type'] == 'none':
        lines.append(f"\n【フレンド】なし")
    else:
        f_name = friend_names.get(result['friend_type'], result['friend_type'])
        lines.append(f"\n【フレンド】固定: {f_name}({f_status})")

    lines.append("\n【周回プラン (フェーズ別)】")
    resource_names = {k: solver.materials[k]['name'] for k in solver.materials.keys()}

    for i, phase in enumerate(result['phases']):
        is_last = (i == len(result['phases']) - 1)
        loadout = phase['loadout']
        lines.append(f"\n[{i + 1}] {phase['runs']} 周")

        l_parts = []
        mat_type_names = {'gold': '金', 'silver': '銀', 'copper': '銅'}
        for mat_key in ['gold', 'silver', 'copper']:
            n, e = loadout[mat_key]['normal'], loadout[mat_key]['evolved']
            if n > 0 or e > 0:
                name = mat_type_names[mat_key]
                if e > 0 and n > 0: l_parts.append(f"{name}(進x{e},未x{n})")
                elif e > 0: l_parts.append(f"{name}(進x{e})")
                elif n > 0: l_parts.append(f"{name}(未x{n})")
                
        bond = loadout.get('bond', 0) + solver.reserved_slots
        if bond > 0: l_parts.append(f"絆・自由枠x{bond}")
        if not l_parts: l_parts.append("なし")
        
        phase_friend_type = phase.get('friend_type', result['friend_type'])
        p_f_name = friend_names.get(phase_friend_type, phase_friend_type)
        if phase_friend_type == 'none':
            lines.append(f"    編成礼装: 自前[{', '.join(l_parts)}] + フレンド[なし]")
        else:
            lines.append(f"    編成礼装: 自前[{', '.join(l_parts)}] + フレンド[{p_f_name}({f_status})]")

        drops = phase['drops_per_run']
        gain_parts = []
        for k in ['gold', 'silver', 'copper']:
            gain_parts.append(f"{solver.materials[k]['name']}+{drops[k]:.1f}")
            
        lines.append(f"    1周あたり: {', '.join(gain_parts)}")

        acc = phase['accumulated']
        acc_str = f"金:{acc['gold']:.0f} / 銀:{acc['silver']:.0f} / 銅:{acc['copper']:.0f}"
        lines.append(f"    (終了後: {acc_str})")

        completed = phase['completed_resource']
        if not is_last and completed:
            comp_names = [resource_names[c] for c in completed]
            lines.append(f"    → {', '.join(comp_names)}が目標達成！ 以降の周回で礼装枠が空きます")

    lines.append(f"\n========================================")
    lines.append(f"総周回数: {result['total_runs']} 周")
    lines.append(f"========================================")

    if result['phases']:
        final = result['phases'][-1]['accumulated']
        lines.append("\n【最終獲得予測】")
        for k in ['gold', 'silver', 'copper']:
            surplus = final[k] - solver.materials[k]['needed']
            name = solver.materials[k]['name']
            marker = " ← 余剰" if surplus > 100 else ""
            lines.append(f"  {name}: {final[k]:,.0f} 個 (必要数+ {surplus:,.0f}){marker}")
        lines.append("========================================")
    return "\n".join(lines)


def run_simulation(config, title, solver_class, formatter):
    solver = solver_class(config)
    print(f"\n{title}")
    opt_results = solver.solve()
    output_text = formatter(opt_results, solver)
    terminal_output = re.sub(r'\*\*(.*?)\*\*', f'{RED}\\1{RESET}', output_text)
    print(terminal_output)
    return output_text


def main():
    config = load_config()
    evolution_candidates = []
    inventory = config['loadout']['self']
    for cat in ['gold', 'silver', 'copper']:
        if inventory.get(cat, {}).get('normal', 0) >= 5:
            evolution_candidates.append(cat)

    solver_class = FixedLoadoutSolver
    formatter = format_fixed_loadout_results

    if not evolution_candidates:
        output_text = run_simulation(config, "最適化計算を実行中...", solver_class, formatter)
        result_path = os.path.join(SCRIPT_DIR, 'result.md')
        with open(result_path, 'w', encoding='utf-8') as f:
            f.write("# イベント周回 最適効率プラン\n\n" + output_text)
        print(f"\n詳細結果を {result_path} に保存しました。")
        return

    print(f"進化可能な礼装が見つかりました: {', '.join(evolution_candidates)}")
    results_combined = []
    res_i = run_simulation(config, "--- [i] 現状維持 (未進化のまま) ---", solver_class, formatter)
    results_combined.append("## [i] 現状維持\n" + res_i)

    config_evolved = copy.deepcopy(config)
    inv_evo = config_evolved['loadout']['self']
    for cat in evolution_candidates:
        stacks = inv_evo[cat]['normal'] // 5
        inv_evo[cat]['normal'] -= (stacks * 5)
        inv_evo[cat]['evolved'] += stacks
        
    res_ii = run_simulation(config_evolved, "--- [ii] 進化合成 (進化x1 にまとめる) ---", solver_class, formatter)
    results_combined.append("## [ii] 進化合成\n" + res_ii)

    full_text = "\n\n".join(results_combined)
    result_path = os.path.join(SCRIPT_DIR, 'result.md')
    with open(result_path, 'w', encoding='utf-8') as f:
        f.write("# 進化合成の比較結果\n\n" + full_text)
    print(f"\n比較結果を {result_path} に保存しました。")

if __name__ == "__main__":
    main()
