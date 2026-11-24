#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""商用音效库（rog-5090）索引生成与检索。库本体不入仓，仓库只存元数据索引。

用法（Python 一律经仓库入口，见 docs/ENVIRONMENT.md）：
  node tools/env/py.mjs tools/sfx_library.py index --csv <音效库总目录.csv> [--defects <音效库瑕疵清单.txt>] [--out <索引路径>]
      从库根解析总目录（UTF-8 BOM）生成 JSONL 索引；瑕疵清单里的坏文件打 defect 标记
  node tools/env/py.mjs tools/sfx_library.py search "水花" [--sub SoundMorph.Mechanism] [--dur-max 3] [--limit 10] [--json]
      中英关键词 + 子库/分类/时长过滤检索；返回的 path 相对库根（BEIMING_SFX_ROOT 指向本机挂载点）
  node tools/env/py.mjs tools/sfx_library.py search --brand "BOOM Library"        # 纯过滤（不给关键词）

检索层只用仓库内置索引，离线可跑；要读音频本体时设 BEIMING_SFX_ROOT（sshfs / 本机挂载两可），
未设时 abs_path 为 None，作品照旧走程序化合成。许可证边界见 docs/rights/sfx-library.md；每条候选带 rights（全部 owner-confirmed）；盘内有第三方渠道残留文件的子库另标 ℹ来源注记（不排除、不阻塞）。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.audio import sfx_library  # noqa: E402
from engine.audio._cli import ArgumentParser, CliError, rel, run, sha256_file  # noqa: E402


def _parser():
    p = ArgumentParser(prog='sfx_library', description='商用音效库（rog-5090）索引生成与检索')
    sub = p.add_subparsers(dest='command', required=True)

    pi = sub.add_parser('index', help='从库根总目录 CSV 生成 JSONL 索引')
    pi.add_argument('--csv', required=True, help='音效库总目录.csv（UTF-8 BOM）')
    pi.add_argument('--defects', help='音效库瑕疵清单.txt（坏文件打标记）')
    pi.add_argument('--out', default=str(sfx_library.INDEX_PATH), help='索引输出路径（默认仓库内置索引）')

    ps = sub.add_parser('search', help='检索索引（中英关键词 + 过滤）')
    ps.add_argument('query', nargs='*', help='中英关键词；不给时纯过滤')
    ps.add_argument('--brand', help='品牌精确匹配（如 "BOOM Library"）')
    ps.add_argument('--sub', help='子库前缀匹配（如 SoundMorph.Mechanism）')
    ps.add_argument('--cat', help='分类子串匹配')
    ps.add_argument('--subcat', help='子分类子串匹配')
    ps.add_argument('--dur-min', type=float, help='时长下限（秒）')
    ps.add_argument('--dur-max', type=float, help='时长上限（秒）')
    ps.add_argument('--limit', type=int, default=20)
    ps.add_argument('--include-defective', action='store_true', help='连瑕疵清单里的坏文件一起检索')
    ps.add_argument('--index', help='用别的索引文件（默认仓库内置索引）')
    return p


def main(args, ctx):
    if args.command == 'index':
        csv_path = Path(args.csv)
        if not csv_path.exists():
            raise CliError('env.missing-csv', f'找不到总目录 CSV：{csv_path}', hint='CSV 在 rog-5090 的 /mnt/data1/共享盘/音效库/，先复制或挂载到本机')
        try:
            rows, stats = sfx_library.build_index(args.csv, args.defects)
        except sfx_library.IndexBuildError as e:
            raise CliError('contract.bad-csv', str(e), hint='修正总目录 CSV 对应行后重跑 index') from None
        size = sfx_library.write_index(rows, args.out)
        return {
            'data': {'rows': len(rows), 'bytes': size, 'defects': stats, 'out': rel(args.out)},
            'outputs': [{'path': rel(args.out), 'sha256': sha256_file(args.out)}],
        }

    if not sfx_library.available() and not args.index:
        raise CliError('env.missing-index', f'仓库内置索引不存在：{sfx_library.INDEX_PATH}', hint='先运行 index 子命令生成')
    index = None
    if args.index:
        if not Path(args.index).exists():
            raise CliError('env.missing-index', f'找不到 --index 指定的索引：{args.index}', hint='先用 index 子命令生成，或去掉 --index 用仓库内置索引')
        index = sfx_library.load_index(args.index)
    hits = sfx_library.search(
        ' '.join(args.query) or None, brand=args.brand, sub=args.sub, cat=args.cat, subcat=args.subcat,
        dur_min=args.dur_min, dur_max=args.dur_max, include_defective=args.include_defective,
        limit=args.limit, index=index)
    r = sfx_library.root()
    if not ctx.json and not ctx.quiet:
        for h in hits:
            print(f"{h['score']:>6.1f}  {h['dur']:>7.2f}s  {h['brand']} / {h['sub']}  {h['path']}"
                  + (f"  ℹ来源注记:{h['source_residue']}" if h.get('source_residue') else '')
                      + (f"  [{h.get('desc', '')[:70]}]" if h.get('desc') else ''))
        if any(h.get('source_residue') for h in hits):
            print('ℹ来源注记：这些子库盘内有第三方渠道残留文件（授权状态仍为 owner-confirmed，不阻塞使用），建议以官方原盘替换拷贝，清单见 docs/rights/sfx-library.md')
        print(f"{'（库根未设置：设 BEIMING_SFX_ROOT 后可读音频本体）' if not r else f'库根：{r}'}；共 {len(hits)} 条")
    return {'data': {'hits': hits, 'root': r}}


if __name__ == '__main__':
    raise SystemExit(run(main, _parser()))
