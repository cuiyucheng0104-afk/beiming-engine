#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""商用音效库索引、Agent 总地图、检索与 Google Drive 按需拉取 CLI。

用法（Python 一律经仓库入口，或 npm run audio:sfx -- <子命令>）：
  node tools/env/py.mjs tools/sfx_library.py manifest [--build] [--json]
      查看或重生成 Agent 总地图（19 子库定位、12 标准大类、用途分布、Google Drive 源配置）
  node tools/env/py.mjs tools/sfx_library.py search "金属 机关" [--role oneshot] [--norm-cat mechanical] [--dur-max 3] [--group-variants] [--limit 10] [--json]
      中英关键词 + 归一化大类/用途/时长/变体聚类检索（本地自动 SQLite FTS5 加速）
  node tools/env/py.mjs tools/sfx_library.py info <id_or_path> [--json]
      查单条完整元数据、同组变体与本地缓存状态
  node tools/env/py.mjs tools/sfx_library.py fetch <id_or_path ...> [--from-film <sfx.json>] [--json]
      按需从 Google Drive 拉取单条或整片依赖到本机缓存（~/.cache/beiming/sfx）
  node tools/env/py.mjs tools/sfx_library.py backfill-gids --lsjson <rclone_lsjson.json> [--folder-id <id>] [--folder-url <url>] [--remote <rclone_remote>] [--json]
      Step 2 上传完 Google Drive 后，把 rclone lsjson -R --files-only 的 File ID 批量回填进索引与总地图
  node tools/env/py.mjs tools/sfx_library.py index --csv <音效库总目录.csv> [--defects <音效库瑕疵清单.txt>] [--out <索引路径>] [--manifest <总地图路径>]
      从库根总目录 CSV 重建 JSONL 索引与总地图
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.audio import sfx_library  # noqa: E402
from engine.audio._cli import ArgumentParser, CliError, rel, run, sha256_file  # noqa: E402


def _parser():
    p = ArgumentParser(prog='sfx_library', description='商用音效库索引、总地图、FTS5 检索与按需拉取')
    sub = p.add_subparsers(dest='command', required=True)

    pi = sub.add_parser('index', help='从库根总目录 CSV 生成 JSONL 索引与总地图')
    pi.add_argument('--csv', required=True, help='音效库总目录.csv（UTF-8 BOM）')
    pi.add_argument('--defects', help='音效库瑕疵清单.txt（坏文件打标记）')
    pi.add_argument('--out', default=str(sfx_library.INDEX_PATH), help='索引输出路径（默认仓库内置索引）')
    pi.add_argument('--manifest', default=str(sfx_library.MANIFEST_PATH), help='总地图输出路径（传 "" 跳过）')

    pm = sub.add_parser('manifest', help='查看或重建 Agent 总地图（manifest.json）')
    pm.add_argument('--build', action='store_true', help='从索引重新生成总地图并落盘')
    pm.add_argument('--index', help='指定索引文件（默认仓库内置索引）')
    pm.add_argument('--manifest', default=str(sfx_library.MANIFEST_PATH), help='总地图路径')

    ps = sub.add_parser('search', help='检索索引（中英关键词 + 归一化大类/用途/时长过滤）')
    ps.add_argument('query', nargs='*', help='中英关键词；不给时纯过滤')
    ps.add_argument('--brand', help='品牌精确匹配（如 "BOOM Library"）')
    ps.add_argument('--sub', help='子库前缀匹配（如 SoundMorph.Mechanism）')
    ps.add_argument('--cat', help='原始分类子串匹配')
    ps.add_argument('--subcat', help='原始子分类子串匹配')
    ps.add_argument('--norm-cat', choices=sorted(sfx_library.NORM_CATEGORIES), help='归一化标准大类')
    ps.add_argument('--role', choices=sorted(sfx_library.ROLE_DESCRIPTIONS), help='用途分型（oneshot/transition/bed/sequence）')
    ps.add_argument('--dur-min', type=float, help='时长下限（秒）')
    ps.add_argument('--dur-max', type=float, help='时长上限（秒）')
    ps.add_argument('--limit', type=int, default=20)
    ps.add_argument('--include-defective', action='store_true', help='连瑕疵清单里的坏文件一起检索')
    ps.add_argument('--group-variants', action='store_true', help='将同类变体（_01/_02）合并成 1 条代表返回')
    ps.add_argument('--no-fts', action='store_true', help='禁用本地 SQLite FTS5 缓存，强制内存扫描')
    ps.add_argument('--index', help='用别的索引文件（默认仓库内置索引）')

    pn = sub.add_parser('info', help='查单条音效详情与同组变体')
    pn.add_argument('target', help='短 ID（如 sfx_...）或库内相对路径')
    pn.add_argument('--index', help='用别的索引文件（默认仓库内置索引）')

    pf = sub.add_parser('fetch', help='按需从 Google Drive 拉取单条或整片依赖到本机缓存')
    pf.add_argument('targets', nargs='*', help='一个或多个短 ID / 相对路径')
    pf.add_argument('--from-film', help='作品 sfx.json（批量拉取其中引用的全部音效）')
    pf.add_argument('--remote', help='rclone remote（默认读 BEIMING_SFX_REMOTE 或 manifest）')
    pf.add_argument('--cache-dir', help='本地缓存目录（默认 BEIMING_SFX_CACHE 或 ~/.cache/beiming/sfx）')
    pf.add_argument('--index', help='用别的索引文件（默认仓库内置索引）')

    pb = sub.add_parser('backfill-gids', help='从 rclone lsjson -R --files-only 回填 Google Drive File ID')
    pb.add_argument('--lsjson', required=True, help='rclone lsjson -R --files-only 导出的 JSON 文件')
    pb.add_argument('--index', default=str(sfx_library.INDEX_PATH), help='输入索引路径')
    pb.add_argument('--out', help='若显式指定则将 gid 写回该 JSONL 索引；默认写入独立的 sfx_library_gids.json 以保持主索引 < 5 MiB')
    pb.add_argument('--gids', default=str(sfx_library.GIDS_PATH), help='独立的 id->gid 映射文件输出路径')
    pb.add_argument('--manifest', default=str(sfx_library.MANIFEST_PATH), help='同步更新总地图路径')
    pb.add_argument('--folder-id', help='Google Drive 根文件夹 ID')
    pb.add_argument('--folder-url', help='Google Drive 根文件夹链接')
    pb.add_argument('--remote', help='默认 rclone remote 名称（如 gdrive:beiming-sfx）')
    return p


def _load_custom_index(index_arg):
    if not index_arg:
        if not sfx_library.available():
            raise CliError('env.missing-index', f'仓库内置索引不存在：{sfx_library.INDEX_PATH}', hint='先运行 index 子命令生成')
        return None
    if not Path(index_arg).exists():
        raise CliError('env.missing-index', f'找不到 --index 指定的索引：{index_arg}', hint='先用 index 子命令生成，或去掉 --index 用仓库内置索引')
    return sfx_library.load_index(index_arg)


def _targets_from_film(film_sfx_path: str) -> list[str]:
    p = Path(film_sfx_path)
    if not p.exists():
        raise CliError('env.missing-file', f'找不到作品音效清单：{p}')
    obj = json.loads(p.read_text(encoding='utf-8'))
    out = []
    if isinstance(obj, list):
        for item in obj:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict) and (item.get('id') or item.get('path')):
                out.append(item.get('id') or item['path'])
    elif isinstance(obj, dict):
        items = obj.get('items') or obj.get('sounds') or obj.get('sfx') or []
        if isinstance(items, dict):
            for v in items.values():
                if isinstance(v, str):
                    out.append(v)
                elif isinstance(v, dict) and (v.get('id') or v.get('path')):
                    out.append(v.get('id') or v['path'])
        elif isinstance(items, list):
            for item in items:
                if isinstance(item, str):
                    out.append(item)
                elif isinstance(item, dict) and (item.get('id') or item.get('path')):
                    out.append(item.get('id') or item['path'])
    return list(dict.fromkeys(out))


def main(args, ctx):
    if args.command == 'index':
        csv_path = Path(args.csv)
        if not csv_path.exists():
            raise CliError('env.missing-csv', f'找不到总目录 CSV：{csv_path}', hint='先从共享盘或 Google Drive 获取音效库总目录.csv')
        try:
            rows, stats = sfx_library.build_index(args.csv, args.defects)
        except sfx_library.IndexBuildError as e:
            raise CliError('contract.bad-csv', str(e), hint='修正总目录 CSV 对应行后重跑 index') from None
        size = sfx_library.write_index(rows, args.out)
        outputs = [{'path': rel(args.out), 'sha256': sha256_file(args.out)}]
        manifest_out = None
        if args.manifest:
            existing_src = None
            if Path(args.manifest).exists():
                try:
                    existing_src = sfx_library.load_manifest(args.manifest).get('source')
                except (OSError, ValueError):
                    existing_src = None
            m = sfx_library.build_manifest(rows, source=existing_src)
            sfx_library.write_manifest(m, args.manifest)
            manifest_out = rel(args.manifest)
            outputs.append({'path': manifest_out, 'sha256': sha256_file(args.manifest)})
        return {
            'data': {'rows': len(rows), 'bytes': size, 'defects': stats, 'out': rel(args.out), 'manifest': manifest_out},
            'outputs': outputs,
        }

    if args.command == 'manifest':
        mpath = Path(args.manifest)
        if args.build or not mpath.exists():
            idx = _load_custom_index(args.index)
            rows = sfx_library.load_index() if idx is None else idx
            existing_src = None
            if mpath.exists():
                try:
                    existing_src = sfx_library.load_manifest(mpath).get('source')
                except (OSError, ValueError):
                    existing_src = None
            m = sfx_library.build_manifest(rows, source=existing_src)
            sfx_library.write_manifest(m, mpath)
        else:
            m = sfx_library.load_manifest(mpath)
        if not ctx.json and not ctx.quiet:
            st = m['stats']
            print(f"北冥商用音效库总地图（{st['total']} 条，有效 {st['active']}，瑕疵 {st['defective']}，已回填 gid {st['with_gid']}）")
            print('标准大类：' + '、'.join(f"{k}({v['count']})" for k, v in m['categories'].items()))
            print('用途分型：' + '、'.join(f"{k}({v['count']})" for k, v in m['roles'].items()))
            print(f"子库数：{st['sublibraries']}；Google Drive folder_id={m['source'].get('folder_id') or '(待 Step 2 回填)'}")
        return {'data': m}

    if args.command == 'info':
        idx = _load_custom_index(args.index)
        item = sfx_library.info(args.target, index=idx)
        if item is None:
            raise CliError('contract.not-found', f'索引里找不到：{args.target}', hint='用 search 子命令确认 id 或相对路径')
        if not ctx.json and not ctx.quiet:
            print(f"{item['id']}  {item['path']}  ({item['dur']:.2f}s, {item['sr']}Hz, {item['ch']}ch)")
            print(f"大类={item['norm_cat']}  用途={item['role']}  变体组={item['vgroup']}（共 {len(item['variants'])} 条）  gid={item.get('gid') or '(未回填)'}")
            if item.get('desc'):
                print(f"描述：{item['desc']}")
        return {'data': item}

    if args.command == 'fetch':
        idx = _load_custom_index(args.index)
        targets = list(args.targets or [])
        if args.from_film:
            targets.extend(_targets_from_film(args.from_film))
        if not targets:
            raise CliError('usage.missing-target', '请至少提供一个音效 id/path，或传 --from-film <sfx.json>')
        fetched = []
        for t in targets:
            try:
                p = sfx_library.fetch(t, index=idx, cache_dir=args.cache_dir, remote=args.remote)
            except sfx_library.SfxFetchError as e:
                raise CliError('env.fetch-failed', str(e)) from None
            fetched.append({'target': t, 'local_path': p})
            if not ctx.json and not ctx.quiet:
                print(f'OK  {t} -> {p}')
        return {'data': {'fetched': fetched, 'count': len(fetched)}}

    if args.command == 'backfill-gids':
        lsj_path = Path(args.lsjson)
        if not lsj_path.exists():
            raise CliError('env.missing-file', f'找不到 lsjson 文件：{lsj_path}')
        idx_path = Path(args.index)
        if not idx_path.exists():
            raise CliError('env.missing-index', f'找不到索引文件：{idx_path}')
        lsjson_items = json.loads(lsj_path.read_text(encoding='utf-8'))
        rows = sfx_library.load_index(idx_path)
        updated, stats = sfx_library.backfill_gids(rows, lsjson_items)
        if args.out:
            size = sfx_library.write_index(updated, args.out)
            out_target = args.out
        else:
            size = sfx_library.write_gids(updated, args.gids)
            out_target = args.gids
        outputs = [{'path': rel(out_target), 'sha256': sha256_file(out_target)}]
        if args.manifest:
            existing_src = None
            if Path(args.manifest).exists():
                try:
                    existing_src = sfx_library.load_manifest(args.manifest).get('source')
                except (OSError, ValueError):
                    existing_src = None
            src = dict(existing_src or {})
            if args.folder_id:
                src['folder_id'] = args.folder_id
            if args.folder_url:
                src['folder_url'] = args.folder_url
            if args.remote:
                src['rclone_remote'] = args.remote
            m = sfx_library.build_manifest(updated, source=src)
            sfx_library.write_manifest(m, args.manifest)
            outputs.append({'path': rel(args.manifest), 'sha256': sha256_file(args.manifest)})
        if not ctx.json and not ctx.quiet:
            print(f"已回填 gid：{stats['matched']}/{stats['total']} 条（写入 {rel(out_target)}，{size} 字节）")
        return {'data': {**stats, 'bytes': size, 'out': rel(out_target)}, 'outputs': outputs}

    # search
    index = _load_custom_index(args.index)
    hits = sfx_library.search(
        ' '.join(args.query) or None,
        brand=args.brand, sub=args.sub, cat=args.cat, subcat=args.subcat,
        role=args.role, norm_cat=args.norm_cat,
        dur_min=args.dur_min, dur_max=args.dur_max,
        include_defective=args.include_defective,
        group_variants=args.group_variants,
        limit=args.limit,
        index=index,
        index_path=args.index if index is None else None,
        use_fts=not args.no_fts,
    )
    r = sfx_library.root()
    if not ctx.json and not ctx.quiet:
        for h in hits:
            vtag = f" [x{h['variant_count']}]" if h.get('variant_count', 1) > 1 else ''
            print(
                f"{h['score']:>5.1f}  {h['id']}  {h['role']:<10}  {h['norm_cat']:<10}  {h['dur']:>6.2f}s  {h['path']}{vtag}"
                + (f"  ℹ来源注记:{h['source_residue']}" if h.get('source_residue') else '')
                + (f"  [{h.get('desc', '')[:60]}]" if h.get('desc') else '')
            )
        if any(h.get('source_residue') for h in hits):
            print('ℹ来源注记：这些子库盘内有第三方渠道残留文件（授权状态仍为 owner-confirmed，不阻塞使用），建议以官方原盘替换拷贝，清单见 docs/rights/sfx-library.md')
        print(f"{'（未设 BEIMING_SFX_ROOT：可用 fetch 子命令按需从 Google Drive 拉取到本机缓存）' if not r else f'库根：{r}'}；共 {len(hits)} 条")
    return {'data': {'hits': hits, 'root': r}}


if __name__ == '__main__':
    raise SystemExit(run(main, _parser()))
