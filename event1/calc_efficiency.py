"""
FGO Event Farming Optimizer — 最適周回プラン計算エンジン

イベントの素材収集・ポイント獲得を同時に最適化するソルバー。
「どの礼装をいつ外すか」をフェーズ分割で計画し、
総周回数を最小化しつつ全リソースの目標達成を保証する。

主な機能:
  - YAML設定ファイルからイベントパラメータを読み込み
  - 全フレンドタイプを探索して最小周回数の組み合わせを自動選択
  - 礼装進化の比較シミュレーション
  - LINE Bot経由での呼び出しに対応 (run_for_line)
"""

import sys
import math
import os
import re
import copy

# ANSI Color Codes
RED = '\033[91m'
RESET = '\033[0m'

def strip_ansi(text):
    return re.sub(r'\x1b\[[0-9;]*m', '', text)

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
# Solver Class for Multi-Phase Loadout Optimization (Look-Ahead)
# -----------------------------------------------------------------------------

class FixedLoadoutSolver:
    """
    マルチフェーズ最適化ソルバー（先読み型）

    素材礼装を最小限の周回数だけ装備し、残りはポイント礼装に全振りすることで
    余剰を最小化しつつ全リソースを効率よく集める。

    アルゴリズム:
      1. ポイント全振りの基本ドロップを算出
      2. N周で足りない素材を特定し、その礼装を装備するフェーズを挿入
      3. 各素材の目標達成時点で礼装を外し、ポイント礼装に切替
      4. 全フレンドタイプ×進化状態を探索し最小周回数を選択
    """
    def __init__(self, config):
        self.config = config
        self.materials = config['materials']
        self.points = config['points']
        self.stage = config['stage']
        self.inventory = config['loadout']['self']
        self.friend_config = config['loadout']['friend']
        self.preconditions = config.get('preconditions', {})
        self.reserved_slots = self.preconditions.get('reserved_slots', 0)
        self.must_equip = self.preconditions.get('must_equip', {})
        self.max_bond_equips = self.preconditions.get('max_bond_equips', 0)
        self.BASE_RUNS = self.stage['base_runs']
        self.BASE_DROP = self.stage['base_drop']
        self.BASE_POINT = self.points['base_point']

    def _build_loadout(self, needed_mat_keys):
        """
        指定された素材のCEを装備し、残りをポイントCE→絆CEで埋める。
        needed_mat_keys: CEが必要な素材キーのリスト (e.g. ['copper'])
        """
        loadout = {k: {'normal': 0, 'evolved': 0} for k in ['gold', 'silver', 'copper', 'point']}
        loadout['bond'] = 0
        total_slots = 5 - self.reserved_slots
        remaining_slots = total_slots
        inv = copy.deepcopy(self.inventory)

        # Must Equip
        for cat, count in self.must_equip.items():
            if count <= 0 or remaining_slots <= 0:
                continue
            needed = min(count, remaining_slots)
            take_e = min(needed, inv.get(cat, {}).get('evolved', 0))
            loadout[cat]['evolved'] += take_e
            inv[cat]['evolved'] -= take_e
            remaining_slots -= take_e
            needed -= take_e
            if needed > 0:
                take_n = min(needed, inv.get(cat, {}).get('normal', 0))
                loadout[cat]['normal'] += take_n
                inv[cat]['normal'] -= take_n
                remaining_slots -= take_n
        if remaining_slots <= 0:
            return loadout

        # Material CEs (evolved first, then normal)
        for mat_key in needed_mat_keys:
            if remaining_slots <= 0:
                break
            avail_e = inv.get(mat_key, {}).get('evolved', 0)
            take = min(avail_e, remaining_slots)
            if take > 0:
                loadout[mat_key]['evolved'] += take
                inv[mat_key]['evolved'] -= take
                remaining_slots -= take
        for mat_key in needed_mat_keys:
            if remaining_slots <= 0:
                break
            avail_n = inv.get(mat_key, {}).get('normal', 0)
            take = min(avail_n, remaining_slots)
            if take > 0:
                loadout[mat_key]['normal'] += take
                inv[mat_key]['normal'] -= take
                remaining_slots -= take

        # Point CEs
        if remaining_slots > 0:
            take = min(inv.get('point', {}).get('evolved', 0), remaining_slots)
            if take > 0:
                loadout['point']['evolved'] += take
                remaining_slots -= take
        if remaining_slots > 0:
            take = min(inv.get('point', {}).get('normal', 0), remaining_slots)
            if take > 0:
                loadout['point']['normal'] += take
                remaining_slots -= take

        # Bond CEs
        if remaining_slots > 0:
            loadout['bond'] = min(remaining_slots, self.max_bond_equips)
        return loadout

    def _calc_per_run(self, loadout, friend_type, friend_evolved):
        drops = {}
        for mat_key in ['gold', 'silver', 'copper']:
            mat_conf = self.materials[mat_key]
            s_norm = loadout.get(mat_key, {}).get('normal', 0)
            s_evo = loadout.get(mat_key, {}).get('evolved', 0)
            bonus = (s_norm * mat_conf.get('bonus_normal', 1)) + (s_evo * mat_conf.get('bonus_evolved', 2))
            if friend_type == mat_key:
                bonus += mat_conf.get('bonus_evolved', 2) if friend_evolved else mat_conf.get('bonus_normal', 1)
            drops[mat_key] = self.BASE_RUNS * (self.BASE_DROP + bonus)

        s_norm_p = loadout.get('point', {}).get('normal', 0)
        s_evo_p = loadout.get('point', {}).get('evolved', 0)
        b_norm = self.points.get('bonus_normal', 0.3)
        b_evo = self.points.get('bonus_evolved', 0.6)
        multiplier = 1.0 + (s_norm_p * b_norm) + (s_evo_p * b_evo)
        if friend_type == 'point':
            multiplier += b_evo if friend_evolved else b_norm
        pts = math.floor(self.BASE_POINT * multiplier)
        return drops, pts

    def _solve_for_friend(self, friend_type, friend_evolved, deficits):
        """指定フレンドでの最適周回数とフェーズを計算する"""
        pt_loadout = self._build_loadout([])
        base_drops, pts_max = self._calc_per_run(pt_loadout, friend_type, friend_evolved)

        if pts_max <= 0:
            return None

        N = max(1, math.ceil(deficits['point'] / pts_max))

        for _ in range(30):
            ce_mats = [k for k in ['gold', 'silver', 'copper'] if base_drops[k] * N < deficits[k]]
            if not ce_mats:
                break

            ce_loadout = self._build_loadout(ce_mats)
            ce_drops, ce_pts = self._calc_per_run(ce_loadout, friend_type, friend_evolved)

            ce_runs = {}
            for k in ce_mats:
                bonus = ce_drops[k] - base_drops[k]
                shortfall = deficits[k] - base_drops[k] * N
                ce_runs[k] = math.ceil(shortfall / bonus) if bonus > 0 else N

            sorted_ce = sorted(ce_runs.items(), key=lambda x: x[1])
            active = list(ce_mats)
            sub_phases = []
            prev_r = 0
            for k, r in sorted_ce:
                if r > prev_r:
                    lo = self._build_loadout(active)
                    _, sp = self._calc_per_run(lo, friend_type, friend_evolved)
                    sub_phases.append((r - prev_r, sp, lo, k))
                    prev_r = r
                active.remove(k)

            total_ce_runs = max(ce_runs.values())
            pts_from_ce = sum(runs * pts for runs, pts, _, _ in sub_phases)
            remaining_pt = deficits['point'] - pts_from_ce
            pt_runs = max(0, math.ceil(remaining_pt / pts_max)) if remaining_pt > 0 else 0
            N_new = total_ce_runs + pt_runs

            if N_new <= N:
                N = N_new
                break
            N = N_new

        # Build final phases
        ce_mats = [k for k in ['gold', 'silver', 'copper'] if base_drops[k] * N < deficits[k]]

        accumulated = {
            'gold': self.materials['gold']['owned'],
            'silver': self.materials['silver']['owned'],
            'copper': self.materials['copper']['owned'],
            'point': self.points['current'],
        }
        phases = []

        if ce_mats:
            ce_loadout = self._build_loadout(ce_mats)
            ce_drops, _ = self._calc_per_run(ce_loadout, friend_type, friend_evolved)
            ce_runs = {}
            for k in ce_mats:
                bonus = ce_drops[k] - base_drops[k]
                shortfall = deficits[k] - base_drops[k] * N
                ce_runs[k] = math.ceil(shortfall / bonus) if bonus > 0 else N

            sorted_ce = sorted(ce_runs.items(), key=lambda x: x[1])
            active = list(ce_mats)
            prev_r = 0
            for k, r in sorted_ce:
                if r > prev_r:
                    lo = self._build_loadout(active)
                    dr, pt = self._calc_per_run(lo, friend_type, friend_evolved)
                    phase_runs = r - prev_r
                    for m in ['gold', 'silver', 'copper']:
                        accumulated[m] += dr[m] * phase_runs
                    accumulated['point'] += pt * phase_runs
                    phases.append({
                        'loadout': copy.deepcopy(lo), 'runs': phase_runs,
                        'completed_resource': k, 'drops_per_run': dr,
                        'pts_per_run': pt, 'accumulated': copy.deepcopy(accumulated),
                    })
                    prev_r = r
                active.remove(k)

        # Point-only phase
        total_ce_runs = sum(p['runs'] for p in phases)
        pt_runs = N - total_ce_runs
        if pt_runs > 0:
            for m in ['gold', 'silver', 'copper']:
                accumulated[m] += base_drops[m] * pt_runs
            accumulated['point'] += pts_max * pt_runs
            phases.append({
                'loadout': copy.deepcopy(pt_loadout), 'runs': pt_runs,
                'completed_resource': 'point', 'drops_per_run': base_drops,
                'pts_per_run': pts_max, 'accumulated': copy.deepcopy(accumulated),
            })

        # Post-check: ensure all targets are met (rounding can cause small shortfalls)
        target_pts = self.points['target']
        targets = {k: self.materials[k]['needed'] for k in ['gold', 'silver', 'copper']}
        targets['point'] = target_pts

        while True:
            shortfall = False
            for k in ['gold', 'silver', 'copper']:
                if accumulated[k] < targets[k]:
                    shortfall = True
                    break
            if accumulated['point'] < targets['point']:
                shortfall = True
            if not shortfall:
                break
            # Add 1 run to last phase
            N += 1
            if phases:
                last = phases[-1]
                last['runs'] += 1
                dr, pt = last['drops_per_run'], last['pts_per_run']
                for m in ['gold', 'silver', 'copper']:
                    accumulated[m] += dr[m]
                    last['accumulated'][m] = accumulated[m]
                accumulated['point'] += pt
                last['accumulated']['point'] = accumulated['point']

        return {
            'total_runs': N, 'phases': phases,
            'friend_type': friend_type, 'friend_evolved': friend_evolved,
        }

    def solve(self):
        """全フレンドタイプを試して最適な組み合わせを自動選択する"""
        deficits = {}
        for k in ['gold', 'silver', 'copper']:
            deficits[k] = max(0, self.materials[k]['needed'] - self.materials[k]['owned'])
        deficits['point'] = max(0, self.points['target'] - self.points['current'])

        best = None
        for ft in ['gold', 'silver', 'copper', 'point']:
            for fe in [True, False]:
                result = self._solve_for_friend(ft, fe, deficits)
                if result and (best is None or result['total_runs'] < best['total_runs']):
                    best = result
        return best or {'total_runs': 0, 'phases': [], 'friend_type': 'point', 'friend_evolved': True}


def format_fixed_loadout_results(result, solver):
    if not result or not result.get('phases'):
        return "最適解が見つかりませんでした。"
    lines = []
    lines.append("========================================")
    lines.append("       最適周回プラン (Phased Loadout)")
    lines.append("========================================")

    lines.append("\n【現在の所持数】")
    lines.append(f"  ポイント: {solver.points['current']:,} pt / 目標: {solver.points['target']:,}")
    for k in ['gold', 'silver', 'copper']:
        lines.append(f"  {solver.materials[k]['name']}: {solver.materials[k]['owned']:,} 個 / 必要数: {solver.materials[k]['needed']:,}")

    friend_names = {'gold': '金', 'silver': '銀', 'copper': '銅', 'point': 'ポイント', 'none': 'なし'}
    f_name = friend_names.get(result['friend_type'], result['friend_type'])
    f_status = '進化' if result['friend_evolved'] else '未進化'
    lines.append(f"\n【フレンド】{f_name}({f_status})")

    lines.append("\n【周回プラン (フェーズ別)】")
    resource_names = {
        'gold': solver.materials['gold']['name'], 'silver': solver.materials['silver']['name'],
        'copper': solver.materials['copper']['name'], 'point': 'ポイント'
    }
    base_drop = solver.BASE_RUNS * solver.BASE_DROP

    for i, phase in enumerate(result['phases']):
        is_last = (i == len(result['phases']) - 1)
        loadout = phase['loadout']
        lines.append(f"\n[{i + 1}] {phase['runs']} 周")

        l_parts = []
        for mat_key in ['gold', 'silver', 'copper']:
            n, e = loadout[mat_key]['normal'], loadout[mat_key]['evolved']
            if n > 0 or e > 0:
                name = solver.materials[mat_key]['name']
                if e > 0 and n > 0: l_parts.append(f"{name}(進x{e},未x{n})")
                elif e > 0: l_parts.append(f"{name}(進x{e})")
                elif n > 0: l_parts.append(f"{name}(未x{n})")
        p_n, p_e = loadout['point']['normal'], loadout['point']['evolved']
        if p_n > 0 or p_e > 0:
            p_strs = []
            if p_e > 0: p_strs.append(f"進x{p_e}")
            if p_n > 0: p_strs.append(f"未x{p_n}")
            l_parts.append(f"Pt({','.join(p_strs)})")
        bond = loadout.get('bond', 0)
        if bond > 0: l_parts.append(f"絆x{bond}")
        if not l_parts: l_parts.append("なし")
        lines.append(f"    編成: 自前[{', '.join(l_parts)}] + フレンド[{f_name}({f_status})]")

        drops, pts = phase['drops_per_run'], phase['pts_per_run']
        gain_parts = []
        for k in ['gold', 'silver', 'copper']:
            gain_parts.append(f"{solver.materials[k]['name']}+{drops[k]}")
        gain_parts.append(f"Pt+{pts:,}")
        lines.append(f"    1周あたり: {', '.join(gain_parts)}")

        acc = phase['accumulated']
        lines.append(f"    (終了後: 金:{acc['gold']:,} / 銀:{acc['silver']:,} / 銅:{acc['copper']:,} / Pt:{acc['point']:,})")

        completed = phase['completed_resource']
        if not is_last:
            lines.append(f"    → {resource_names[completed]}の礼装が不要に！ ポイント礼装に入れ替え")

    lines.append(f"\n========================================")
    lines.append(f"総周回数: {result['total_runs']} 周")
    lines.append(f"========================================")

    if result['phases']:
        final = result['phases'][-1]['accumulated']
        lines.append("\n【最終獲得予測】")
        lines.append(f"  ポイント: {final['point']:,} pt (目標+ {final['point'] - solver.points['target']:,})")
        for k in ['gold', 'silver', 'copper']:
            surplus = final[k] - solver.materials[k]['needed']
            name = solver.materials[k]['name']
            marker = " ← 余剰" if surplus > 200 else ""
            lines.append(f"  {name}: {final[k]:,} 個 (必要数+ {surplus:,}){marker}")
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
    for cat in ['gold', 'silver', 'copper', 'point']:
        if inventory.get(cat, {}).get('normal', 0) >= 5:
            evolution_candidates.append(cat)

    solver_class = FixedLoadoutSolver
    formatter = format_fixed_loadout_results

    if not evolution_candidates:
        output_text = run_simulation(config, "最適化計算を実行中...", solver_class, formatter)
        result_path = os.path.join(SCRIPT_DIR, 'result.md')
        with open(result_path, 'w', encoding='utf-8') as f:
            f.write(output_text)
        print(f"\n詳細結果を {result_path} に保存しました。")
        return

    print(f"進化可能な礼装が見つかりました: {', '.join(evolution_candidates)}")
    results_combined = []
    res_i = run_simulation(config, "--- [i] 現状維持 (未進化x5 のまま) ---", solver_class, formatter)
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


# --- LINE Bot連携用 ---
def run_for_line(custom_config):
    evolution_candidates = []
    inventory = custom_config['loadout']['self']
    for cat in ['gold', 'silver', 'copper', 'point']:
        if inventory.get(cat, {}).get('normal', 0) >= 5:
            evolution_candidates.append(cat)
    solver_class = FixedLoadoutSolver
    formatter = format_fixed_loadout_results
    if not evolution_candidates:
        return run_simulation(custom_config, "最適化計算を実行中...", solver_class, formatter)
    results_combined = []
    res_i = run_simulation(custom_config, "--- [i] 現状維持 ---", solver_class, formatter)
    results_combined.append("## [i] 現状維持\n" + res_i)
    config_evolved = copy.deepcopy(custom_config)
    inv_evo = config_evolved['loadout']['self']
    for cat in evolution_candidates:
        stacks = inv_evo[cat]['normal'] // 5
        inv_evo[cat]['normal'] -= (stacks * 5)
        inv_evo[cat]['evolved'] += stacks
    res_ii = run_simulation(config_evolved, "--- [ii] 進化合成 ---", solver_class, formatter)
    results_combined.append("## [ii] 進化合成\n" + res_ii)
    return "\n\n".join(results_combined)