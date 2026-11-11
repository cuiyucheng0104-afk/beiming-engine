# -*- coding: utf-8 -*-
"""北冥引擎 · 配音命令：python -m engine.audio.voice <build | check | providers> [对白文件或作品目录] [选项]（Node 入口 tools/audio/voice.mjs）

  build      dialogue.json → 配音轨、字幕（SRT / WebVTT / ASS）、texts.json（window.TEXTS 的数据）、口型提示、开口时刻（写法见 README.md）
  check      只校验 dialogue.json 的写法（不合成、不写盘）；不合规退出 4
  providers  列出配音服务与本机能不能用（不联网、不花钱）
退出码（附录 C1）：0 成功；2 用法；3 缺依赖、缺密钥、离线时缓存里没有、找不到文件；4 对白文件不合规、台词放不下或叠在一起；1 运行失败。
"""
import sys

from .._cli import ArgumentParser, CliError, rel, run, sha256_file
from . import dialogue as DL
from . import providers as PV


def make_parser():
    p = ArgumentParser(prog='python -m engine.audio.voice', description='配音、字幕与口型：dialogue.json → voice.wav、subtitles.srt/.vtt/.ass、'
                       'texts.json、lips.json。退出码：0 成功；2 用法；3 缺依赖 / 密钥 / 离线缓存；4 对白不合规或放不下；1 运行失败。')
    p.add_argument('action', choices=['build', 'check', 'providers'], help='build 合成并导出；check 只校验；providers 列出服务')
    p.add_argument('dialogue', nargs='?', help='dialogue.json，或作品目录（读其中的 dialogue.json）')
    p.add_argument('--film', help='film.json 或作品目录（默认在对白文件所在目录与上一级找）')
    p.add_argument('--out', help='输出目录（默认 <作品>/out/dialogue）')
    p.add_argument('--cache', help='缓存目录（默认 <作品>/out/cache/voice；付费服务的长片指到仓库外的固定目录）')
    p.add_argument('--offline', action='store_true', help='联网的服务只读缓存（缓存没有就退出 3）；本机的服务照常合成')
    p.add_argument('--provider', choices=sorted(PV.PROVIDERS), help='把所有说话人换成这个服务（动态预演用 synthetic）')
    return p


def main(args, ctx):
    if args.action == 'providers':
        rows = []
        for name, cls in PV.PROVIDERS.items():
            ok, why, hint = cls().available()
            rows.append({'provider': name, 'network': cls.network, 'available': ok, 'reason': why or None, 'hint': hint,
                         'defaults': cls.defaults})
            ctx.out(f"  {'✓' if ok else '✗'} {name:10} {'联网' if cls.network else '本机'}  {why or ''}" + (f'（{hint}）' if hint and not ok else ''))
        return {'data': {'providers': rows}}
    if not args.dialogue:
        raise CliError('usage.missing-argument', f'{args.action} 要给对白文件或作品目录', hint='例：python -m engine.audio.voice build films/dawn')
    if args.action == 'check':
        path, _ = DL.resolve_dialogue(args.dialogue)
        try:
            d = DL.load(path)
        except DL.DialogueError as e:
            raise CliError(e.code, e.message, hint=e.hint) from None
        ctx.out(f'{rel(path)}：{len(d["lines"])} 句、{len(d["speakers"])} 个说话人，写法合规')
        return {'data': {'lines': len(d['lines']), 'speakers': list(d['speakers'])}}
    try:
        r = DL.build(args.dialogue, film=args.film, out=args.out, cache=args.cache, offline=args.offline, provider=args.provider, log=ctx.log)
    except DL.DialogueError as e:
        raise CliError(e.code, e.message, hint=e.hint) from None
    for w in r['warnings']:
        ctx.warn(w['code'], w['message'], w.get('hint'))
    kinds = {'voice': 'audio', 'srt': 'subtitles', 'vtt': 'subtitles', 'ass': 'subtitles', 'texts': 'texts', 'lips': 'lips', 'onsets': 'onsets',
             'manifest': 'manifest'}
    outputs = [{'path': rel(p), 'sha256': sha256_file(p), 'kind': kinds[k]} for k, p in r['paths'].items()]
    fps = r['fps']
    for c in r['cues']:
        ctx.out(f"  {c['startFrame']:5d}–{c['endFrame']:<5d} {c['speaker'] or '':10} {' / '.join(c['lines'])}")
    ctx.out(f"配音 {len(r['lines'])} 句（缓存命中 {r['cache']['hit']}、新合成 {r['cache']['miss']}）、字幕 {len(r['cues'])} 条 → {rel(r['out'])}")
    data = {'out': rel(r['out']), 'fps': fps, 'lines': [{k: x[k] for k in ('id', 'speaker', 'onset', 'end', 'onsetFrame', 'endFrame', 'timing', 'cache')}
                                                         for x in r['lines']],
            'cues': [{k: c[k] for k in ('id', 'text', 'startFrame', 'endFrame')} for c in r['cues']], 'cache': r['cache']}
    return {'data': data, 'outputs': outputs}


if __name__ == '__main__':
    sys.exit(run(main, make_parser(), command='audio:voice'))
