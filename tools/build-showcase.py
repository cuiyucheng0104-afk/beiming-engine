#!/usr/bin/env python3
"""北冥作品站 · 整站构建器（works 角色维护）。

把 site/ 装配成可以直接发布的静态站，按 site/CONTRACT.md 第 5 节的七步执行：

  1. 读 cases/catalog.json + 策展规则 CURATION + site/data/works-meta.json，得到作品列表（79 部：66 / 7 / 6）
  2. 复制 site/（不含 *.md、dev/、data/works-meta.json）到输出目录；作品区标记填进 <!-- @works -->；写 data/works.json
  3. 从 site/js/ 下每一个 .js 出发解析 import 图（静态、动态、new URL(…, import.meta.url)），
     只复制用到的 engine/、src/、three 与 three/addons 文件；缺文件就报错退出
  4. 复制 GSAP（gsap、ScrollTrigger、Flip）到 vendor/gsap/
  5. 字体：按页面上 .f-brush 的字与引擎层名取 Ma Shan Zheng 子集，Barlow 取 ASCII 子集（Google Fonts CSS2 API），
     写 css/fonts.css；联网失败只打印警告，退回仓库自带子集与系统字体，构建不失败
  6. 复制作品海报、预览视频（默认软链接，--copy-previews 时复制）、样片 media/beiming.mp4 与手机版 media/beiming-1280.mp4
     （手机版提交在仓库里，构建核对它是从现在的原片转的、不超过 6 MB）；
     有本地预览且有 ffmpeg 时，另剪悬停短循环 media/hover/<id>-hover.mp4（在第 1 步之后剪好、缓存在 out/.cache/hover/；
     剪失败时 ffmpeg 报错原文写进构建日志）
  7. 校验：输出目录里所有本地 src / href / poster / srcset / CSS url() 都能解析到文件，
     页内锚点都存在，页面可见文字里没有破折号、内部代号和工程残留

用法：
  npm run site:build                                         # = python3 tools/build-showcase.py → out/site/
  python3 tools/build-showcase.py --out out/dev-works \\
      --previews-dir ~/beiming-case-audit-20261107/release    # 本地：预览视频软链接进 media/previews/
  python3 tools/build-showcase.py --out _site --previews-dir _previews --copy-previews   # CI（GitHub Pages）
  python3 tools/build-showcase.py --make-film-1280          # 换了 media/beiming.mp4 之后：重转手机版样片（不构建站点）

不给 --previews-dir 时，作品预览直接用 GitHub Release 的下载地址。
开发选项：--template 换模板（默认 <site>/index.html）、--site 换源目录（默认 site/）、
--offline 不联网取字、--no-hover-clips 不剪悬停短循环、--lenient 把校验错误降为警告（只用于并行开发，CI 不用）。
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import posixpath
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'cases' / 'catalog.json'
NODE = ROOT / 'node_modules'
FONTS_DIR = ROOT / 'fonts'
FILM = ROOT / 'media' / 'beiming.mp4'
FILM_1280 = ROOT / 'media' / 'beiming-1280.mp4'
DEFAULT_SITE = ROOT / 'site'
DEFAULT_OUT = ROOT / 'out' / 'site'
FONT_CACHE = ROOT / 'out' / '.cache' / 'fonts'
BUILD_MARK = '.site-build.json'

REPO = 'https://github.com/cuiyucheng0104-afk/beiming-engine'
RELEASE_TAG = 'casebook-2026.11'
RELEASE_PAGE = f'{REPO}/releases/tag/{RELEASE_TAG}'
CASES_PAGE = f'{REPO}/tree/main/cases'

# 策展规则（与旧版作品站一致；仓库里 96 条完整档案不变，站上只展示策展版本）
#   · 只保留有观看预览的成片
#   · 下掉「自研动画与预演」整组
#   · 下掉状态为 rejected / support / interactive / previs 的记录
CURATION = {
    'excludeGroups': {'local-films'},
    'excludeStatuses': {'rejected', 'support', 'interactive', 'previs'},
    'requirePreview': True,
}

# 作品分组：标题与说明照 site/DESIGN.md 第 7 节定稿文案；范围用 durationRange 校验，文案和数据对不上就报错
GROUPS = [
    {'key': 'styles', 'title': '北冥代码动画风格', 'layout': 'sheet',
     'desc': '每部 18 到 20 秒。同一套代码骨架，换一组笔触与材质，就是另一种画风。',
     'durationRange': (17.5, 20.5)},
    {'key': 'ppt-stories', 'title': 'PPT 故事介绍片', 'layout': 'strip',
     'desc': '2 到 4 分钟的品牌故事片。原画来自提案，分层、时间线、镜头与混音由代码完成。',
     'durationRange': (120, 240)},
    {'key': 'ppt-keynote', 'title': '发布会动画', 'layout': 'strip',
     'desc': '开场、段落与落版，20 秒到 3 分钟，同一套管线批量出片。',
     'durationRange': (19.5, 181)},
]
# 站上多处文案写死了这些数字（DESIGN.md 第 7 节）；策展结果变了必须先改文案再改这里
EXPECTED_COUNTS = {'styles': 66, 'ppt-stories': 7, 'ppt-keynote': 6}

LEDE = '{all} 部成片，每一部都由代码合成出片：镜头、版式、笔触与混音都写在程序里。'
NOTE = '注：部分作品以提案原画、AI 生成的画面或公有领域影像为素材，来源写在每部的案例卡里。站内播放的是历史成片的 960 宽转码；原始画质与素材包在 {release}，每部的归档源码与案例卡在 {cases}。'

# 站点可见文字里不能出现的内容（AGENTS.md 对外名称、DESIGN.md 第 7 节文案规则）
FORBIDDEN_TERMS = ['RAEA', 'raea', 'Lemo', 'lemo', 'Opuscar', 'opuscar', 'SY100', 'sy-style-100',
                   'TREATMENT', 'Treatment', '导演阐述', '处理方案', '风格样片']
FORBIDDEN_DASHES = ['—', '--']          # 包括「——」
WARN_DASHES = ['–']                      # 连接号：不算破折号，只提醒

# Google Fonts（CSS2 API 按 text= 子集化）
GF_CSS = 'https://fonts.googleapis.com/css2'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')
BRUSH_SAFETY = '北冥形光景笔人界时声片作品方法'   # 页面上一定会用到的毛笔字，抓不到元素时也带上
BARLOW_TEXT = ''.join(chr(c) for c in range(0x20, 0x7F)) + '·×−°…'
BARLOW_WEIGHTS = (300, 400, 500, 600)

GSAP_FILES = ('gsap.min.js', 'ScrollTrigger.min.js', 'Flip.min.js')
GSAP_VERSION = '3.15.1'

# 悬停短循环：从海报那一帧（previewStart）起剪 4 秒、480 宽、无音轨、最高 30 帧，每段约 100–300 KB。
# 悬停只播它，不用为几秒悬停下载整部预览（几 MB）；点开放映台才用完整预览。参数一变缓存就失效
HOVER = {'seconds': 4, 'width': 480, 'crf': 30, 'fpsmax': 30}
HOVER_CACHE = ROOT / 'out' / '.cache' / 'hover'
FFMPEG_ERR_LINES = 60          # ffmpeg 报错原文写进构建日志时最多保留的行数（取最后几行）

# 手机版样片 media/beiming-1280.mp4：页面在窄屏用 <source media> 选它，原片 9 Mbps、11 MB 对手机太重。
# 由原片转码后提交进仓库，构建只核对、复制，不在 CI 里转。1280 宽、两遍 4 Mbps 的 H.264，音轨原样复用（AAC），faststart；
# 色彩不做转换：沿用原片的全范围与 BT.601 矩阵标记，手机上和桌面版一个颜色。
# 元数据 comment 记下原片的 sha256：原片换了而手机版没重转，构建报错。重转：python3 tools/build-showcase.py --make-film-1280
FILM_1280_ENC = {'width': 1280, 'kbps': 4000, 'maxkbps': 6000, 'bufkbps': 8000, 'gop': 48}
FILM_1280_MAX_BYTES = 6_000_000
FILM_1280_SOURCE = re.compile(rb'beiming\.mp4 sha256=([0-9a-f]{64})')

WEB_EXT = {'.js', '.mjs', '.json', '.css', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg',
           '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.glb', '.gltf',
           '.bin', '.ktx2', '.hdr', '.wasm', '.txt'}


class BuildError(Exception):
    pass


class Log:
    def __init__(self, lenient: bool = False):
        self.lenient = lenient
        self.warnings: list[str] = []
        self.errors: list[str] = []

    def info(self, msg: str) -> None:
        print(msg, flush=True)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)
        print(f'  警告：{msg}', file=sys.stderr, flush=True)

    def error(self, msg: str) -> None:
        """可降级的错误：--lenient 时只当警告。"""
        if self.lenient:
            self.warn(msg)
        else:
            self.errors.append(msg)
            print(f'  错误：{msg}', file=sys.stderr, flush=True)

    def check(self, step: str) -> None:
        if self.errors:
            raise BuildError(f'{step}失败，共 {len(self.errors)} 处问题（见上方）')


def esc(value) -> str:
    return html.escape('' if value is None else str(value), quote=True)


def rel_posix(path: Path, base: Path) -> str:
    return path.relative_to(base).as_posix()


# ───────────────────────── 1. 作品数据 ─────────────────────────

def keep_case(case: dict) -> bool:
    if case['group'] in CURATION['excludeGroups']:
        return False
    if case['status'] in CURATION['excludeStatuses']:
        return False
    if CURATION['requirePreview'] and not (case.get('preview') or {}).get('url'):
        return False
    return True


def duration_of(case: dict) -> float | None:
    preview = case.get('preview') or {}
    if isinstance(preview.get('duration'), (int, float)):
        return float(preview['duration'])
    for art in case.get('artifacts') or []:
        video = art.get('video') or {}
        if isinstance(video.get('duration'), (int, float)):
            return float(video['duration'])
    return None


def fmt_duration(seconds: float | None) -> str:
    """20 秒 / 2 分 51 秒 / 3 分钟。四舍五入到整秒（旧站的「2 分 0051 秒」就是这里格式写错了）；
    整分钟写「3 分钟」，只写「3 分」读着像缺了秒数。"""
    if seconds is None:
        return ''
    total = int(seconds + 0.5)
    if total < 60:
        return f'{total} 秒'
    minutes, secs = divmod(total, 60)
    return f'{minutes} 分钟' if secs == 0 else f'{minutes} 分 {secs} 秒'


TITLE_RESIDUE = [
    (re.compile(r'\d+(?:\.\d+)?\s*(?:s|秒)(?![\w])', re.I), '秒数'),
    (re.compile(r'^\s*\d{1,3}\s*[·.、]'), '编号'),
    (re.compile(r'[（(]\s*(?:treatment|TREATMENT)'), 'TREATMENT'),
]


def check_text(label: str, text: str, log: Log, *, limit: int | None = None) -> None:
    for term in FORBIDDEN_TERMS:
        if term in text:
            log.error(f'{label} 含有不该出现的「{term}」：{text}')
    for dash in FORBIDDEN_DASHES:
        if dash in text:
            log.error(f'{label} 含有破折号「{dash}」：{text}')
    if limit is not None and len(text) > limit:
        log.error(f'{label} 超过 {limit} 字（{len(text)} 字）：{text}')


def load_works(site: Path, previews_dir: Path | None, log: Log) -> dict:
    catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
    meta_path = site / 'data' / 'works-meta.json'
    if not meta_path.exists():
        raise BuildError(f'缺少策展数据 {meta_path}')
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    families = meta.get('families') or []
    family_keys = [f['key'] for f in families]
    entries = meta.get('works') or {}

    kept = [c for c in catalog['cases'] if keep_case(c)]
    kept_ids = {c['id'] for c in kept}
    for missing in sorted(kept_ids - set(entries)):
        log.error(f'works-meta.json 缺少 {missing} 的策展条目')
    for stale in sorted(set(entries) - kept_ids):
        log.error(f'works-meta.json 有多余条目 {stale}（它不在策展结果里）')
    if not 6 <= len(families) <= 9:
        log.error(f'画风家族应为 6–9 个，现在是 {len(families)} 个')
    if len(set(family_keys)) != len(family_keys):
        log.error('画风家族的 key 有重复')
    log.check('读取策展数据')

    order = {g['key']: i for i, g in enumerate(GROUPS)}
    for case in kept:
        if case['group'] not in order:
            raise BuildError(f'{case["id"]} 属于未知分组 {case["group"]}')

    position = {c['id']: i for i, c in enumerate(catalog['cases'])}

    def sort_key(case):   # 分组 → works-meta 里可选的 order → catalog.json 的原有顺序（风格样片按编号，其余按制作先后）
        m = entries[case['id']]
        return (order[case['group']], m.get('order', 0), position[case['id']])

    kept.sort(key=sort_key)
    works = []
    counters = {g['key']: 0 for g in GROUPS}
    for case in kept:
        m = entries[case['id']]
        group = case['group']
        counters[group] += 1
        label = f'works-meta.json · {case["id"]}'
        title = (m.get('title') or '').strip()
        style_name = (m.get('styleName') or '').strip()
        blurb = (m.get('blurb') or '').strip()
        family = m.get('family')
        if not title or not style_name or not blurb:
            log.error(f'{label} 缺 title / styleName / blurb')
        check_text(f'{label} 片名', title, log)
        check_text(f'{label} 画风名', style_name, log)
        check_text(f'{label} 简介', blurb, log, limit=40)
        for pattern, what in TITLE_RESIDUE:
            if pattern.search(title):
                log.error(f'{label} 片名里还有{what}残留：{title}')
        if group == 'styles':
            if family not in family_keys:
                log.error(f'{label} 的画风家族 {family!r} 不在 families 里')
        elif family is not None:
            log.error(f'{label} 不是风格样片，family 应为 null')

        preview = case.get('preview') or {}
        filename = preview.get('filename') or f'{case["id"]}-preview.mp4'
        poster_src = ROOT / 'cases' / case['poster'] if case.get('poster') else None
        # 海报覆盖：works-meta 的 poster 是 site/data/ 下的相对路径（从预览视频里另取的一帧，见 _说明）
        if m.get('poster'):
            override = (site / 'data' / m['poster']).resolve()
            if not override.is_relative_to((site / 'data' / 'posters').resolve()) or override.suffix.lower() != '.jpg':
                log.error(f'{label} 的 poster 应是 posters/ 下的 .jpg：{m["poster"]!r}')
            poster_src = override
        if poster_src is None or not poster_src.exists():
            log.error(f'{case["id"]} 缺少海报 {poster_src}')
        duration = duration_of(case)
        lo, hi = next(g['durationRange'] for g in GROUPS if g['key'] == group)
        if duration is None or not lo <= duration <= hi:
            log.error(f'{case["id"]} 时长 {duration} 不在本组文案写的范围 {lo}–{hi} 秒内，请核对 DESIGN.md 文案')
        # 悬停预览的起播点：海报就是从预览视频这一刻截的，从这里播，海报到视频没有跳变
        start = m.get('previewStart', 0)
        if not isinstance(start, (int, float)) or start < 0 or (duration and start >= duration):
            log.error(f'{label} 的 previewStart={start!r} 不在 0 到时长之间')
            start = 0
        works.append({
            'id': case['id'],
            'group': group,
            'family': family if group == 'styles' else None,
            'n': counters[group],
            'title': title,
            'styleName': style_name,
            'blurb': blurb,
            'duration': round(duration, 3) if duration is not None else None,
            'durationLabel': fmt_duration(duration),
            'poster': f'media/posters/{case["id"]}.jpg',
            'preview': f'media/previews/{filename}' if previews_dir else preview['url'],
            'previewBytes': preview.get('size'),
            'previewStart': round(float(start), 2),
            'caseUrl': f'{REPO}/blob/main/cases/entries/{case["id"]}.md',
            'sourceUrl': f'{REPO}/tree/main/cases/source/{case["id"]}',
            '_posterSrc': poster_src,
            '_previewFile': filename,
            '_previewSha': preview.get('sha256'),
        })
    log.check('整理作品数据')

    counts = {g['key']: counters[g['key']] for g in GROUPS}
    for key, expected in EXPECTED_COUNTS.items():
        if counts.get(key) != expected:
            log.error(f'{key} 策展结果是 {counts.get(key)} 部，文案写的是 {expected} 部；先改 DESIGN.md 与页面文案，再改 EXPECTED_COUNTS')
    log.check('核对作品数量')
    fam_count = {k: 0 for k in family_keys}
    for w in works:
        if w['family']:
            fam_count[w['family']] += 1
    for key, n in fam_count.items():
        if n == 0:
            log.error(f'画风家族 {key} 一部作品都没有')
    log.check('核对画风家族')

    return {
        'counts': {'all': len(works), **counts, 'archived': len(catalog['cases'])},
        'groups': [{'key': g['key'], 'title': g['title'], 'count': counts[g['key']]} for g in GROUPS],
        'families': [{'key': f['key'], 'title': f['title'], 'count': fam_count[f['key']]} for f in families],
        'works': works,
    }


def run_ffmpeg(cmd: list[str], timeout: float) -> None:
    """跑一条 ffmpeg 命令；失败时抛出带 stderr 的 CalledProcessError / TimeoutExpired / OSError。"""
    subprocess.run(cmd, check=True, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)


def ffmpeg_failure(cmd: list[str], exc: Exception) -> tuple[str, str]:
    """ffmpeg 为什么失败（一句）与写进构建日志的细节：完整命令和 ffmpeg 报错原文（stderr，太长只留最后几行）。"""
    if isinstance(exc, subprocess.CalledProcessError):
        why = f'ffmpeg 退出码 {exc.returncode}'
    elif isinstance(exc, subprocess.TimeoutExpired):
        why = f'ffmpeg 超过 {exc.timeout:g} 秒没跑完'
    else:
        why = f'ffmpeg 没能运行：{exc.__class__.__name__} {exc}'
    raw = getattr(exc, 'stderr', None) or b''
    text = (raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else str(raw)).strip()
    lines = [f'    命令：{shlex.join(cmd)}']
    if text:
        body = text.splitlines()
        if len(body) > FFMPEG_ERR_LINES:
            lines.append(f'    ffmpeg 报错原文（共 {len(body)} 行，只列最后 {FFMPEG_ERR_LINES} 行）：')
            body = body[-FFMPEG_ERR_LINES:]
        else:
            lines.append('    ffmpeg 报错原文：')
        lines += [f'      {line}' for line in body]
    else:
        lines.append('    ffmpeg 没有输出报错文字')
    return why, '\n'.join(lines)


def prepare_hover_clips(data: dict, previews_dir: Path | None, enabled: bool, log: Log) -> dict:
    """剪悬停短循环到 out/.cache/hover/（按预览文件、起播点与参数缓存），给每部作品记上 hover 路径。
    要在生成作品区标记之前跑：标记里的 data-hover 指向它。没有本地预览或没有 ffmpeg 时跳过，悬停退回整部预览。
    剪失败的那一部也退回整部预览；ffmpeg 的报错原文连同命令写进构建日志，CI 上直接看 Actions 日志排查。"""
    stats = {'mode': 'off', 'clips': 0, 'made': 0, 'failed': 0, 'bytes': 0}
    if not enabled:
        return stats
    if not previews_dir:
        log.info('  没给 --previews-dir：不剪悬停短循环，悬停直接播 Release 上的整部预览')
        return stats
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        log.warn('找不到 ffmpeg：不剪悬停短循环，悬停直接播整部预览（每次几 MB）')
        return stats
    stats['mode'] = 'clips'
    HOVER_CACHE.mkdir(parents=True, exist_ok=True)
    params = json.dumps(HOVER, sort_keys=True)
    for w in data['works']:
        src = previews_dir / w['_previewFile']
        if not src.is_file():
            continue                      # 第 6 步会报缺文件
        ident = w['_previewSha'] or f'{src.stat().st_size}'
        key = hashlib.sha256(f'{ident}|{w["previewStart"]}|{params}'.encode()).hexdigest()[:12]
        cached = HOVER_CACHE / f'{w["id"]}-{key}.mp4'
        if not cached.is_file():
            tmp = cached.with_suffix('.tmp.mp4')
            cmd = [ffmpeg, '-v', 'error', '-nostdin', '-y', '-ss', f'{w["previewStart"]:g}', '-i', str(src),
                   '-t', str(HOVER['seconds']), '-an', '-sn', '-dn', '-map_metadata', '-1',
                   '-vf', f'scale={HOVER["width"]}:-2:flags=lanczos,format=yuv420p', '-fpsmax', str(HOVER['fpsmax']),
                   '-c:v', 'libx264', '-preset', 'slow', '-crf', str(HOVER['crf']), '-profile:v', 'main',
                   '-movflags', '+faststart', str(tmp)]
            try:
                run_ffmpeg(cmd, timeout=120)
                tmp.replace(cached)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
                tmp.unlink(missing_ok=True)
                why, detail = ffmpeg_failure(cmd, exc)
                log.warn(f'{w["id"]} 的悬停短循环没剪成（{why}），悬停退回整部预览\n{detail}')
                stats['failed'] += 1
                continue
            stats['made'] += 1
        w['hover'] = f'media/hover/{w["id"]}-hover.mp4'
        w['_hoverSrc'] = cached
        stats['clips'] += 1
        stats['bytes'] += cached.stat().st_size
    return stats


def public_works_json(data: dict) -> str:
    works = [{k: v for k, v in w.items() if not k.startswith('_')} for w in data['works']]
    payload = {'counts': data['counts'], 'groups': data['groups'], 'families': data['families'], 'works': works}
    return json.dumps(payload, ensure_ascii=False, indent=1) + '\n'


# ───────────────────────── 作品区标记 ─────────────────────────

EXT_MARK = '<span class="wk-sr">（新标签页）</span>'
ICON_PREV = ('<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">'
             '<path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>')
ICON_NEXT = ('<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">'
             '<path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>')


def ext_link(href: str, text: str, cls: str = '') -> str:
    c = f' class="{cls}"' if cls else ''
    return f'<a{c} href="{esc(href)}" target="_blank" rel="noopener">{esc(text)}{EXT_MARK}</a>'


# 作品链接的读屏名：「《片名》，画风，时长，动作」。没有 JS 时链接直接打开预览视频；
# works.js 接管后把最后一段换成「原地放映」。简介不进名字，用 aria-describedby 指过去。
LINK_ACTION = '预览视频'


def frame_html(w: dict, wide: bool) -> str:
    """一格作品。印样（wide=False）：画面 + 片边一行小字（编号、片名、时长），画风名悬停才出现；
    胶片条（wide=True）：胶片框里的画面 + 下方片名、画风、时长与简介。"""
    n = f'{w["n"]:02d}'
    attrs = {
        'class': 'wk-frame' + (' wk-frame--wide' if wide else ''),
        'data-id': w['id'],
        'data-group': w['group'],
        'data-family': w['family'] or '',
        'data-n': n,
        'data-preview': w['preview'],
        'data-start': f'{w["previewStart"]:g}',
        'data-case': w['caseUrl'],
        'data-source': w['sourceUrl'],
        'data-duration': '' if w['duration'] is None else f'{w["duration"]:.2f}',
        'data-bytes': w['previewBytes'] or '',
    }
    if w.get('hover'):
        attrs['data-hover'] = w['hover']
    attr_html = ' '.join(f'{k}="{esc(v)}"' for k, v in attrs.items())
    desc_id = f'wk-d-{w["id"]}'
    label = f'《{w["title"]}》，{w["styleName"]}，{w["durationLabel"]}，{LINK_ACTION}'
    title, style, dur, blurb = (esc(w['title']), esc(w['styleName']), esc(w['durationLabel']), esc(w['blurb']))
    img = (f'<img src="{esc(w["poster"])}" alt="{blurb}" '
           f'width="640" height="360" loading="lazy" decoding="async">')
    if wide:
        cap = f'''<span class="wk-cap">
        <span class="wk-name">{title}</span>
        <span class="wk-meta"><span class="wk-style">{style}</span><span class="wk-dur">{dur}</span></span>
        <span class="wk-blurb" id="{desc_id}" aria-hidden="true">{blurb}</span>
      </span>'''
        pic = f'<span class="wk-film"><span class="wk-pic">{img}<span class="wk-n" aria-hidden="true">{n}</span></span></span>'
    else:
        cap = (f'<span class="wk-cap"><span class="wk-n" aria-hidden="true">{n}</span>'
               f'<span class="wk-name">{title}</span><span class="wk-dur">{dur}</span>'
               f'<span class="wk-sr" id="{desc_id}" aria-hidden="true">{blurb}</span></span>')
        pic = f'<span class="wk-pic">{img}<span class="wk-style" aria-hidden="true">{style}</span></span>'
    return f'''<li {attr_html}>
    <a class="wk-link" href="{esc(w['preview'])}" type="video/mp4" aria-label="{esc(label)}" aria-describedby="{desc_id}">
      {cap}
      {pic}
    </a>
  </li>'''


def works_markup(data: dict) -> str:
    counts = data['counts']
    by_group = {g['key']: [w for w in data['works'] if w['group'] == g['key']] for g in GROUPS}
    toc = ''.join(
        f'<li><a href="#works-{g["key"]}"><span class="wk-toc-name">{esc(g["title"])}</span>'
        f'<span class="wk-toc-n">{len(by_group[g["key"]])}</span></a></li>'
        for g in GROUPS)
    parts = [f'''<div class="wk" data-works>
<header class="wk-head">
  <p class="wk-label" lang="en">WORKS</p>
  <h2 class="wk-title f-brush" id="works-title">作品</h2>
  <div class="wk-intro">
    <p class="wk-lede">{esc(LEDE.format(all=counts['all']))}</p>
    <nav class="wk-toc" aria-label="作品分组"><ol>{toc}</ol></nav>
  </div>
</header>''']
    for g in GROUPS:
        items = by_group[g['key']]
        gid = f'works-{g["key"]}'
        head = f'''<header class="wk-group-head">
    <h3 class="wk-group-title" id="{gid}-title">{esc(g['title'])}<span class="wk-group-n">{len(items)} 部</span></h3>
    <p class="wk-group-desc">{esc(g['desc'])}</p>'''
        if g['layout'] == 'sheet':
            chips = [f'<button type="button" class="wk-chip" data-family="all" aria-pressed="true">'
                     f'全部<span class="wk-chip-n">{len(items)}</span></button>']
            chips += [f'<button type="button" class="wk-chip" data-family="{esc(f["key"])}" aria-pressed="false">'
                      f'{esc(f["title"])}<span class="wk-chip-n">{f["count"]}</span></button>'
                      for f in data['families']]
            frames = '\n  '.join(frame_html(w, wide=False) for w in items)
            parts.append(f'''<section class="wk-group wk-group--sheet" id="{gid}" data-group="{g['key']}" aria-labelledby="{gid}-title">
  {head}
  </header>
  <div class="wk-filter" role="group" aria-label="按画风家族筛选" hidden>
    {''.join(chips)}
  </div>
  <p class="wk-sr" data-filter-status aria-live="polite"></p>
  <ol class="wk-sheet" data-sheet>
  {frames}
  </ol>
</section>''')
        else:
            frames = '\n  '.join(frame_html(w, wide=True) for w in items)
            parts.append(f'''<section class="wk-group wk-group--strip" id="{gid}" data-group="{g['key']}" aria-labelledby="{gid}-title">
  {head}
    <div class="wk-strip-nav" hidden>
      <button type="button" class="wk-strip-btn" data-dir="-1" aria-controls="{gid}-track"><span class="wk-sr">向左翻看</span>{ICON_PREV}</button>
      <button type="button" class="wk-strip-btn" data-dir="1" aria-controls="{gid}-track"><span class="wk-sr">向右翻看</span>{ICON_NEXT}</button>
    </div>
  </header>
  <div class="wk-strip">
  <ol class="wk-track" id="{gid}-track" data-track>
  {frames}
  </ol>
  </div>
</section>''')
    note = NOTE.format(release=ext_link(RELEASE_PAGE, 'GitHub Release'), cases=ext_link(CASES_PAGE, '案例库'))
    parts.append(f'<p class="wk-note">{note}</p>\n</div>')
    return '\n'.join(parts)


WORKS_MARKER = re.compile(r'<!--\s*@works\s*-->')


# ───────────────────────── 2. 复制 site/ ─────────────────────────

def site_files(site: Path):
    for path in sorted(site.rglob('*')):
        if not path.is_file():
            continue
        rel = rel_posix(path, site)
        if rel.startswith('dev/') or path.suffix.lower() == '.md' or path.name == '.DS_Store':
            continue
        if rel == 'data/works-meta.json' or rel.startswith('data/posters/'):
            continue          # 策展源数据与海报覆盖只给构建器用；海报由第 6 步放进 media/posters/
        yield rel, path


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def prepare_out(out: Path, site: Path) -> None:
    out = out.resolve()
    forbidden = {ROOT.resolve(), site.resolve(), (ROOT / 'cases').resolve(), Path.home().resolve(), Path('/')}
    if out in forbidden or out in ROOT.resolve().parents or site.resolve() in out.parents:
        raise BuildError(f'拒绝把站点写到 {out}')
    if out.exists():
        if not out.is_dir():
            raise BuildError(f'{out} 不是目录')
        entries = [p for p in out.iterdir() if p.name != '.DS_Store']
        if entries and not (out / BUILD_MARK).exists():
            raise BuildError(f'{out} 非空且不是本构建器的产物（缺 {BUILD_MARK}），拒绝覆盖')
        shutil.rmtree(out)
    out.mkdir(parents=True)
    # 先写标记：构建中途失败，下次也能放心清掉重来
    (out / BUILD_MARK).write_text('{"builder": "tools/build-showcase.py", "status": "building"}\n', encoding='utf-8')


# ───────────────────────── 3. import 图 ─────────────────────────

JS_TOKENS = re.compile(r'''
    (?P<str>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)
  | (?P<block>/\*.*?\*/)
  | (?P<line>//[^\n]*)
''', re.S | re.X)
STATIC_IMPORT = re.compile(r'''(?<![\w$.])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?(["'])([^"'\n]+)\1''')
DYNAMIC_LITERAL = re.compile(r'''(?<![\w$.])import\s*\(\s*(["'`])([^"'`]*)\1\s*[,)]''')
DYNAMIC_ANY = re.compile(r'''(?<![\w$.])import\s*\(''')
URL_META = re.compile(r'''new\s+URL\s*\(\s*(["'`])([^"'`]*)\1\s*,\s*import\.meta\.url\s*\)''')

BARE = [('three/addons/', 'vendor/three/addons/'), ('@engine/', 'engine/'), ('@film/', 'src/')]
IMPORTMAP = {'three': './vendor/three/three.module.min.js', 'three/addons/': './vendor/three/addons/',
             '@engine/': './engine/', '@film/': './src/'}


def strip_comments(code: str) -> str:
    return JS_TOKENS.sub(lambda m: m.group('str') if m.group('str') else ' ', code)


class Graph:
    """从入口模块出发，按页面上的 importmap 规则把依赖映射到输出目录并复制。"""

    def __init__(self, out: Path, site: Path, log: Log):
        self.out, self.site, self.log = out, site, log
        self.done: dict[str, Path] = {}          # 输出相对路径 → 源文件
        self.bare_used: set[str] = set()
        self.unresolved: list[str] = []

    def source_of(self, rel: str) -> Path | None:
        if rel == 'vendor/three/three.module.min.js':
            return NODE / 'three' / 'build' / 'three.module.min.js'
        if rel.startswith('vendor/three/addons/'):
            return NODE / 'three' / 'examples' / 'jsm' / rel[len('vendor/three/addons/'):]
        if rel.startswith(('engine/', 'src/', 'fonts/')):
            return ROOT / rel
        return self.site / rel

    def resolve(self, spec: str, base_rel: str, where: str) -> str | None:
        clean = spec.split('?', 1)[0].split('#', 1)[0]
        if re.match(r'^[a-z][a-z0-9+.-]*:', clean, re.I) or clean.startswith('//'):
            self.log.error(f'{where} 引用了站外模块 {spec}（只允许 three、three/addons、@engine、@film 与相对路径）')
            return None
        if clean.startswith('/'):
            self.log.error(f'{where} 用了以 / 开头的绝对路径 {spec}；Pages 站点在子路径下，请改成相对路径')
            return None
        if clean.startswith(('./', '../')):
            rel = posixpath.normpath(posixpath.join(posixpath.dirname(base_rel), clean))
        elif clean == 'three':
            self.bare_used.add('three')
            rel = 'vendor/three/three.module.min.js'
        else:
            for prefix, target in BARE:
                if clean.startswith(prefix):
                    self.bare_used.add(prefix)
                    rel = target + clean[len(prefix):]
                    break
            else:
                hint = '（three/examples/jsm 请改写成 three/addons/）' if clean.startswith('three/') else ''
                self.log.error(f'{where} 引用了 importmap 里没有的模块 {spec}{hint}')
                return None
        if rel.startswith('../') or rel == '..':
            self.log.error(f'{where} 的 {spec} 解析到了站点根目录之外')
            return None
        return rel

    def add(self, rel: str, where: str, parse: bool = True) -> None:
        if rel in self.done:
            return
        src = self.source_of(rel)
        if src is None or not src.is_file():
            self.log.error(f'{where} 需要 {rel}，但找不到源文件 {src}')
            return
        self.done[rel] = src
        dst = self.out / rel
        if not dst.exists():
            copy_file(src, dst)
        if parse and src.suffix in ('.js', '.mjs'):
            self.scan(src.read_text(encoding='utf-8'), rel)

    def scan(self, code: str, base_rel: str) -> None:
        clean = strip_comments(code)
        where = base_rel
        for m in STATIC_IMPORT.finditer(clean):
            target = self.resolve(m.group(2), base_rel, where)
            if target:
                self.add(target, where)
        literal_dyn = 0
        for m in DYNAMIC_LITERAL.finditer(clean):
            literal_dyn += 1
            spec = m.group(2)
            if '${' in spec:
                self.unresolved.append(f'{where}: import(`{spec}`)')
                literal_dyn -= 1
                continue
            target = self.resolve(spec, base_rel, where)
            if target:
                self.add(target, where)
        total_dyn = len(DYNAMIC_ANY.findall(clean))
        if total_dyn > literal_dyn:
            self.unresolved.append(f'{where}: {total_dyn - literal_dyn} 处动态 import 不是字面量')
        for m in URL_META.finditer(clean):
            spec = m.group(2)
            if '${' in spec:
                self.asset_prefix(spec, base_rel, where)
                continue
            target = self.resolve(spec if spec.startswith(('./', '../')) else './' + spec, base_rel, where)
            if target:
                self.add(target, where, parse=False)

    def asset_prefix(self, spec: str, base_rel: str, where: str) -> None:
        """new URL(`../fonts/${f}`, import.meta.url) 这类模板地址：把前缀目录里同后缀的网页资源整目录带上。"""
        prefix, _, rest = spec.partition('${')
        suffix = rest.rsplit('}', 1)[-1]
        if not prefix.endswith('/'):
            self.unresolved.append(f'{where}: new URL(`{spec}`)')
            return
        rel_dir = posixpath.normpath(posixpath.join(posixpath.dirname(base_rel), prefix))
        src_dir = self.source_of(rel_dir + '/x')
        src_dir = src_dir.parent if src_dir else None
        if not src_dir or not src_dir.is_dir():
            self.unresolved.append(f'{where}: new URL(`{spec}`)（目录 {rel_dir} 不存在）')
            return
        n = 0
        for f in sorted(src_dir.iterdir()):
            if f.is_file() and f.suffix.lower() in WEB_EXT and f.name.endswith(suffix):
                self.add(f'{rel_dir}/{f.name}', where, parse=False)
                n += 1
        self.log.info(f'  {where}：模板地址 {spec} → 带上 {rel_dir}/ 下 {n} 个文件')


# ───────────────────────── HTML 解析 ─────────────────────────

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
REF_ATTRS = {'src', 'href', 'poster', 'data-preview', 'data-hover', 'data-src', 'data-poster'}
TEXT_ATTRS = {'alt', 'title', 'aria-label', 'placeholder'}


class PageScan(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool, bool, bool]] = []   # (tag, 在 .f-brush 里, 在不可见元素里, 在署名区块里)
        self.brush: list[str] = []
        self.text: list[str] = []
        self.attrib_text: list[str] = []                # 署名区块 [data-attribution] 里的文字：可以写上游项目名（决定 D04），仍查破折号
        self.refs: list[tuple[str, str]] = []           # (属性, 值)
        self.ids: set[str] = set()
        self.modules: list[str] = []                    # 内联 module 脚本
        self.importmaps: list[str] = []
        self._script_kind: str | None = None

    def handle_starttag(self, tag, attrs):
        a = {k: (v or '') for k, v in attrs}
        parent_brush = self.stack[-1][1] if self.stack else False
        parent_hidden = self.stack[-1][2] if self.stack else False
        parent_attrib = self.stack[-1][3] if self.stack else False
        brush = parent_brush or 'f-brush' in a.get('class', '').split()
        attrib = parent_attrib or 'data-attribution' in a
        hidden = parent_hidden or tag in ('script', 'style', 'template')
        if 'id' in a:
            self.ids.add(a['id'])
        for key, value in a.items():
            if key in REF_ATTRS and value:
                self.refs.append((key, value))
            elif key == 'srcset' and value:
                for cand in value.split(','):
                    url = cand.strip().split(' ')[0]
                    if url:
                        self.refs.append(('srcset', url))
            elif key in TEXT_ATTRS and value and not hidden:
                (self.attrib_text if attrib else self.text).append(value)
        if tag == 'meta' and a.get('content') and (a.get('name') in ('description',) or
                                                   a.get('property', '').startswith('og:') and
                                                   a.get('property') in ('og:title', 'og:description')):
            self.text.append(a['content'])
        if tag == 'script':
            t = a.get('type', '').strip().lower()
            self._script_kind = 'module' if (t == 'module' and 'src' not in a) else ('importmap' if t == 'importmap' else None)
        if tag not in VOID:
            self.stack.append((tag, brush, hidden, attrib))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break
        if tag == 'script':
            self._script_kind = None

    def handle_data(self, data):
        if self._script_kind == 'module':
            self.modules.append(data)
            return
        if self._script_kind == 'importmap':
            self.importmaps.append(data)
            return
        brush = self.stack[-1][1] if self.stack else False
        hidden = self.stack[-1][2] if self.stack else False
        attrib = self.stack[-1][3] if self.stack else False
        if brush:
            self.brush.append(data)
        if not hidden and data.strip():
            (self.attrib_text if attrib else self.text).append(data)


def scan_page(path: Path) -> PageScan:
    scan = PageScan()
    scan.feed(path.read_text(encoding='utf-8'))
    scan.close()
    return scan


# ───────────────────────── 5. 字体 ─────────────────────────

def http_get(url: str, timeout: float = 20) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/css,*/*;q=0.1'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def cached_get(url: str, offline: bool, log: Log) -> bytes | None:
    FONT_CACHE.mkdir(parents=True, exist_ok=True)
    cache = FONT_CACHE / hashlib.sha256(url.encode()).hexdigest()[:24]
    if cache.exists():
        return cache.read_bytes()
    if offline:
        return None
    try:
        data = http_get(url)
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        log.warn(f'取字体失败：{exc}')
        return None
    cache.write_bytes(data)
    return data


FACE_RE = re.compile(r'@font-face\s*{(.*?)}', re.S)


def google_faces(query: str, text: str, offline: bool, log: Log) -> list[dict] | None:
    url = f'{GF_CSS}?{query}&text={urllib.parse.quote(text)}&display=swap'
    css = cached_get(url, offline, log)
    if css is None:
        return None
    faces = []
    for block in FACE_RE.findall(css.decode('utf-8', 'replace')):
        fam = re.search(r"font-family:\s*['\"]?([^;'\"]+)", block)
        weight = re.search(r'font-weight:\s*(\d+)', block)
        style = re.search(r'font-style:\s*(\w+)', block)
        src = re.search(r'url\(([^)]+)\)\s*format\([\'"]?woff2', block)
        if not (fam and src):
            continue
        data = cached_get(src.group(1).strip('\'"'), offline, log)
        if data is None:
            return None
        faces.append({'family': fam.group(1).strip(), 'weight': int(weight.group(1)) if weight else 400,
                      'style': style.group(1) if style else 'normal', 'data': data})
    return faces or None


def font_face(family: str, weight: int, url: str, extra: str = '') -> str:
    return (f'@font-face {{ font-family: "{family}"; font-style: normal; font-weight: {weight}; '
            f'font-display: swap; src: url("{url}") format("woff2");{extra} }}')


def build_fonts(out: Path, page: PageScan, site: Path, offline: bool, log: Log) -> dict:
    # 仓库自带子集只带用得到的：「北冥」两字的毛笔子集（首屏预载、js/brush-title.js 写字都用它）与许可。
    # Barlow 数字子集只在联网取字失败、退回时才写进 fonts.css，那时才复制；其余（如显示层用的思源黑体子集）不进站点。
    # 第 7 步会校验页面与 CSS 的每一处引用，漏带就构建失败。
    copy_file(FONTS_DIR / 'MaShanZheng-400.woff2', out / 'fonts' / 'MaShanZheng-400.woff2')
    if (FONTS_DIR / 'LICENSE.md').exists():
        copy_file(FONTS_DIR / 'LICENSE.md', out / 'fonts' / 'LICENSE.md')

    glyphs = set(''.join(page.brush))
    for js in sorted((site / 'js').rglob('*.js')) if (site / 'js').exists() else []:
        for m in re.finditer(r'''glyph\s*:\s*['"]([^'"]+)['"]''', js.read_text(encoding='utf-8')):
            glyphs.update(m.group(1))
    glyphs.update(BRUSH_SAFETY)
    brush_text = ''.join(sorted(ch for ch in glyphs if not ch.isspace()))

    lines = ['/* 由 tools/build-showcase.py 生成，不要手改。',
             ' * 字体：Ma Shan Zheng（马善政毛笔楷书）与 Barlow，SIL Open Font License 1.1，许可全文见 fonts/LICENSE.md。',
             f' * Ma Shan Zheng 只含页面上 .f-brush 与引擎层名用到的 {len(brush_text)} 个字；Barlow 只含 ASCII 与少量符号。 */']
    report = {'brushChars': len(brush_text), 'mode': 'google'}
    site_fonts = out / 'fonts' / 'site'

    brush = google_faces('family=Ma+Shan+Zheng', brush_text, offline, log)
    barlow = google_faces('family=Barlow:wght@' + ';'.join(map(str, BARLOW_WEIGHTS)), BARLOW_TEXT, offline, log)
    if brush:
        for face in brush:
            name = f'ma-shan-zheng-{face["weight"]}.{hashlib.sha256(face["data"]).hexdigest()[:8]}.woff2'
            (site_fonts).mkdir(parents=True, exist_ok=True)
            (site_fonts / name).write_bytes(face['data'])
            lines.append(font_face('Ma Shan Zheng', face['weight'], f'../fonts/site/{name}'))
    else:
        report['mode'] = 'fallback'
        log.warn('Ma Shan Zheng 子集没取到：退回仓库自带的「北冥」两字子集，其余毛笔字用系统楷体')
        lines.append('/* 联网取字失败：毛笔字只保证「北冥」两字（仓库自带子集），其余退回系统楷体。 */')
        lines.append(font_face('Ma Shan Zheng', 400, '../fonts/MaShanZheng-400.woff2', ' unicode-range: U+5317, U+51A5;'))
    if barlow:
        for face in sorted(barlow, key=lambda f: f['weight']):
            name = f'barlow-{face["weight"]}.{hashlib.sha256(face["data"]).hexdigest()[:8]}.woff2'
            site_fonts.mkdir(parents=True, exist_ok=True)
            (site_fonts / name).write_bytes(face['data'])
            lines.append(font_face('Barlow', face['weight'], f'../fonts/site/{name}'))
    else:
        report['mode'] = 'fallback'
        log.warn('Barlow 子集没取到：数字退回仓库自带子集，西文退回系统字体')
        lines.append('/* 联网取字失败：Barlow 只覆盖数字与少量符号（仓库自带子集），西文退回系统字体。 */')
        for weight in (300, 400, 500):
            if (FONTS_DIR / f'Barlow-{weight}.woff2').exists():
                copy_file(FONTS_DIR / f'Barlow-{weight}.woff2', out / 'fonts' / f'Barlow-{weight}.woff2')
                lines.append(font_face('Barlow', weight, f'../fonts/Barlow-{weight}.woff2',
                                       ' unicode-range: U+0025, U+002E, U+0030-003A, U+00B7, U+2026;'))
    css = '\n'.join(lines) + '\n'
    (out / 'css').mkdir(parents=True, exist_ok=True)
    (out / 'css' / 'fonts.css').write_text(css, encoding='utf-8')
    report['brushText'] = brush_text
    return report


# ───────────────────────── 6. 媒体 ─────────────────────────

def place_media(out: Path, data: dict, previews_dir: Path | None, copy_previews: bool, log: Log) -> dict:
    stats = {'posters': 0, 'previews': 0, 'previewMode': 'release'}
    for w in data['works']:
        copy_file(w['_posterSrc'], out / w['poster'])
        stats['posters'] += 1
    if previews_dir:
        stats['previewMode'] = 'copy' if copy_previews else 'symlink'
        for w in data['works']:
            src = previews_dir / w['_previewFile']
            dst = out / w['preview']
            if not src.is_file():
                log.error(f'--previews-dir 里缺少 {w["_previewFile"]}')
                continue
            if w['previewBytes'] and src.stat().st_size != w['previewBytes']:
                log.error(f'{src.name} 大小 {src.stat().st_size} 与 catalog.json 记录的 {w["previewBytes"]} 不符')
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            if copy_previews:
                shutil.copy2(src, dst)
            else:
                os.symlink(src.resolve(), dst)
            stats['previews'] += 1
    for w in data['works']:          # 悬停短循环：跟预览视频一样，本地软链接、CI 复制
        if not w.get('_hoverSrc'):
            continue
        dst = out / w['hover']
        dst.parent.mkdir(parents=True, exist_ok=True)
        if copy_previews:
            shutil.copy2(w['_hoverSrc'], dst)
        else:
            os.symlink(w['_hoverSrc'].resolve(), dst)
        stats['hover'] = stats.get('hover', 0) + 1
    if FILM.is_file():
        copy_file(FILM, out / 'media' / 'beiming.mp4')
    else:
        log.error(f'缺少样片 {FILM}')
    if FILM_1280.is_file():
        stats['film1280'] = check_film_1280(log)
        copy_file(FILM_1280, out / 'media' / FILM_1280.name)
    else:
        log.error(f'缺少手机版样片 {rel_posix(FILM_1280, ROOT)}；用 python3 tools/build-showcase.py --make-film-1280 从原片转出来再提交')
    return stats


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def check_film_1280(log: Log) -> int:
    """手机版样片不超过 6 MB，且是从现在这份原片转出来的（比对元数据 comment 里记的原片 sha256）。返回字节数。"""
    data = FILM_1280.read_bytes()
    name = rel_posix(FILM_1280, ROOT)
    if len(data) > FILM_1280_MAX_BYTES:
        log.error(f'{name} 有 {len(data) / 1e6:.2f} MB，超过手机版 {FILM_1280_MAX_BYTES / 1e6:g} MB 的上限')
    found = FILM_1280_SOURCE.search(data)
    if not found:
        log.warn(f'{name} 没记原片的 sha256，核对不了是不是从现在的 media/beiming.mp4 转的；'
                 '建议用 python3 tools/build-showcase.py --make-film-1280 重转')
    elif FILM.is_file() and found.group(1).decode() != sha256_file(FILM):
        log.error(f'media/beiming.mp4 换过了，{name} 还是从旧原片转的；'
                  '运行 python3 tools/build-showcase.py --make-film-1280 重转，两个文件一起提交')
    return len(data)


def film_1280_commands(ffmpeg: str, dst: Path, passlog: Path, source_sha: str) -> list[list[str]]:
    """手机版样片的两遍转码命令（参数见 FILM_1280_ENC）。"""
    e = FILM_1280_ENC
    head = [ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(FILM)]
    video = ['-vf', f'scale={e["width"]}:-2:flags=lanczos,setsar=1', '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high',
             '-b:v', f'{e["kbps"]}k', '-maxrate', f'{e["maxkbps"]}k', '-bufsize', f'{e["bufkbps"]}k',
             '-g', str(e['gop']), '-passlogfile', str(passlog)]
    return [
        head + ['-map', '0:v:0', *video, '-pass', '1', '-an', '-f', 'null', os.devnull],
        head + ['-map', '0:v:0', '-map', '0:a:0', *video, '-pass', '2', '-c:a', 'copy',
                '-metadata', f'comment=from media/beiming.mp4 sha256={source_sha}',
                '-movflags', '+faststart', str(dst)],
    ]


def make_film_1280(log: Log) -> int:
    """--make-film-1280：从 media/beiming.mp4 重转手机版样片 media/beiming-1280.mp4（换了原片之后用）。"""
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise BuildError('找不到 ffmpeg，转不了手机版样片')
    if not FILM.is_file():
        raise BuildError(f'缺少样片 {FILM}')
    sha = sha256_file(FILM)
    tmp_out = FILM_1280.with_suffix('.tmp.mp4')
    try:
        with tempfile.TemporaryDirectory(prefix='beiming-1280-') as tmp:
            for cmd in film_1280_commands(ffmpeg, tmp_out, Path(tmp) / 'x264', sha):
                try:
                    run_ffmpeg(cmd, timeout=900)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
                    why, detail = ffmpeg_failure(cmd, exc)
                    print(detail, file=sys.stderr, flush=True)
                    raise BuildError(f'手机版样片没转成（{why}）') from None
        size = tmp_out.stat().st_size
        if size > FILM_1280_MAX_BYTES:
            raise BuildError(f'手机版样片有 {size / 1e6:.2f} MB，超过 {FILM_1280_MAX_BYTES / 1e6:g} MB 上限；调低 FILM_1280_ENC 的码率')
        tmp_out.replace(FILM_1280)
    finally:
        tmp_out.unlink(missing_ok=True)
    log.info(f'手机版样片：{rel_posix(FILM_1280, ROOT)}，{size / 1e6:.2f} MB（原片 sha256 {sha[:12]}…）；记得和原片一起提交')
    return 0


# ───────────────────────── 7. 校验 ─────────────────────────

SKIP_REF = re.compile(r'^(?:[a-z][a-z0-9+.-]*:|//|#$|javascript:)', re.I)
CSS_URL = re.compile(r'''url\(\s*(['"]?)([^'")]+)\1\s*\)''')
CSS_IMPORT = re.compile(r'''@import\s+(?:url\()?\s*['"]([^'"]+)['"]''')


def check_local(out: Path, owner: Path, ref: str, what: str, log: Log, ids: set[str] | None = None) -> None:
    if not ref or SKIP_REF.match(ref):
        return
    if ref.startswith('#'):
        if ids is not None and ref[1:] and urllib.parse.unquote(ref[1:]) not in ids:
            log.error(f'{rel_posix(owner, out)} 的 {what}="{ref}" 指向不存在的锚点')
        return
    path = urllib.parse.unquote(ref.split('#', 1)[0].split('?', 1)[0])
    if not path:
        return
    if path.startswith('/'):
        log.error(f'{rel_posix(owner, out)} 的 {what}="{ref}" 是以 / 开头的绝对路径（Pages 在子路径下会 404）')
        return
    target = (owner.parent / path)
    try:
        target.resolve().relative_to(out.resolve())
        inside = True
    except ValueError:
        inside = target.is_symlink() and target.parent.resolve().is_relative_to(out.resolve())
    if not inside:
        log.error(f'{rel_posix(owner, out)} 的 {what}="{ref}" 指到了输出目录之外')
        return
    if not target.exists():
        log.error(f'{rel_posix(owner, out)} 的 {what}="{ref}" 找不到文件')


def validate(out: Path, log: Log) -> None:
    for page in sorted(out.rglob('*.html')):
        scan = scan_page(page)
        for attr, ref in scan.refs:
            check_local(out, page, ref, attr, log, scan.ids)
        for raw in scan.importmaps:
            try:
                imap = json.loads(raw).get('imports', {})
            except json.JSONDecodeError as exc:
                log.error(f'{rel_posix(page, out)} 的 importmap 不是合法 JSON：{exc}')
                continue
            for target in imap.values():
                if target.endswith('/'):
                    if not (page.parent / target).is_dir():
                        log.error(f'{rel_posix(page, out)} 的 importmap 目录 {target} 不存在')
                else:
                    check_local(out, page, target, 'importmap', log)
    for css in sorted(out.rglob('*.css')):
        code = css.read_text(encoding='utf-8')
        for m in CSS_URL.finditer(code):
            check_local(out, css, m.group(2).strip(), 'url()', log)
        for m in CSS_IMPORT.finditer(code):
            check_local(out, css, m.group(1), '@import', log)


def check_copy(out: Path, page: PageScan, log: Log) -> None:
    # 上游项目名只允许出现在署名区块 [data-attribution] 里（决定 D04：技术、署名与许可语境如实写上游名，不作我方产品名）
    text = '\n'.join(page.text)
    for term in FORBIDDEN_TERMS:
        if term in text:
            hit = next(t for t in page.text if term in t)
            log.error(f'页面可见文字里有「{term}」（上游项目名只能写在页脚署名区块 [data-attribution] 里）：{hit.strip()[:60]}')
    every = page.text + page.attrib_text
    text = '\n'.join(every)
    for dash in FORBIDDEN_DASHES:
        if dash in text:
            hit = next(t for t in every if dash in t)
            log.error(f'页面可见文字里有破折号「{dash}」：{hit.strip()[:60]}')
    for dash in WARN_DASHES:
        if dash in text:
            hit = next(t for t in every if dash in t)
            log.warn(f'页面可见文字里有连接号「{dash}」，确认不是当破折号用：{hit.strip()[:60]}')


def check_importmap(page: PageScan, graph: Graph, log: Log) -> None:
    if not graph.bare_used:
        return
    imap = {}
    for raw in page.importmaps:
        try:
            imap.update(json.loads(raw).get('imports', {}))
        except json.JSONDecodeError:
            pass
    for key in sorted(graph.bare_used):
        want = IMPORTMAP[key]
        have = imap.get(key)
        norm = lambda s: s[2:] if s and s.startswith('./') else s
        if norm(have) != norm(want):
            log.error(f'模块用了 "{key}"，页面 importmap 应映射到 "{want}"，现在是 {have!r}')


def dir_size(path: Path, skip: tuple[str, ...] = ()) -> int:
    total = 0
    for f in path.rglob('*'):
        rel = rel_posix(f, path)
        if f.is_file() and not f.is_symlink() and not rel.startswith(skip):
            total += f.stat().st_size
    return total


# ───────────────────────── 主流程 ─────────────────────────

def build(args) -> int:
    log = Log(lenient=args.lenient)
    site = args.site.resolve()
    out = args.out.resolve()
    template = (args.template or site / 'index.html').resolve()
    previews_dir = args.previews_dir.expanduser().resolve() if args.previews_dir else None
    if previews_dir and not previews_dir.is_dir():
        raise BuildError(f'--previews-dir {previews_dir} 不是目录')
    if args.copy_previews and not previews_dir:
        raise BuildError('--copy-previews 需要同时给 --previews-dir')
    if not template.is_file():
        raise BuildError(f'模板 {template} 不存在（site/index.html 还没写好时用 --template 指定临时模板）')

    log.info('[1/7] 作品数据')
    data = load_works(site, previews_dir, log)
    c = data['counts']
    log.info(f'  {c["all"]} 部：风格 {c["styles"]} · 故事 {c["ppt-stories"]} · 发布会 {c["ppt-keynote"]}（档案共 {c["archived"]} 条）')
    hover = prepare_hover_clips(data, previews_dir, not args.no_hover_clips, log)
    if hover['mode'] == 'clips':
        failed = f'；{hover["failed"]} 段没剪成，退回整部预览（报错原文见上方警告）' if hover['failed'] else ''
        log.info(f'  悬停短循环 {hover["clips"]} 段（新剪 {hover["made"]} 段，其余用缓存），共 {hover["bytes"] / 1e6:.1f} MB{failed}')

    log.info(f'[2/7] 复制 site/ → {out}')
    prepare_out(out, site)
    n_site = 0
    for rel, path in site_files(site):
        copy_file(path, out / rel)
        n_site += 1
    tpl = template.read_text(encoding='utf-8')
    markers = WORKS_MARKER.findall(tpl)
    if len(markers) != 1:
        raise BuildError(f'模板里应有且只有一个 <!-- @works -->，现在有 {len(markers)} 个')
    page_html = WORKS_MARKER.sub(lambda _: works_markup(data), tpl, count=1)
    (out / 'index.html').write_text(page_html, encoding='utf-8')
    (out / 'data').mkdir(parents=True, exist_ok=True)
    (out / 'data' / 'works.json').write_text(public_works_json(data), encoding='utf-8')
    log.info(f'  复制 {n_site} 个文件；作品区 {c["all"]} 部已填入；写 data/works.json')

    log.info('[3/7] 模块依赖')
    graph = Graph(out, site, log)
    entries = sorted((site / 'js').rglob('*.js')) if (site / 'js').exists() else []
    for js in entries:
        rel = 'js/' + rel_posix(js, site / 'js')
        graph.done.setdefault(rel, js)
        graph.scan(js.read_text(encoding='utf-8'), rel)
    page = scan_page(out / 'index.html')
    for i, code in enumerate(page.modules):
        graph.scan(code, 'index.html')
    check_importmap(page, graph, log)
    for item in graph.unresolved:
        log.warn(f'无法静态解析，没有自动带上：{item}')
    log.check('解析模块依赖')
    groups = {}
    for rel in graph.done:
        key = rel.split('/', 2)[0] if not rel.startswith('vendor/three') else 'vendor/three'
        groups[key] = groups.get(key, 0) + 1
    log.info(f'  入口 {len(entries)} 个；复制依赖：' + '，'.join(f'{k} {v}' for k, v in sorted(groups.items())))

    log.info('[4/7] GSAP')
    pkg = NODE / 'gsap' / 'package.json'
    if not pkg.exists():
        raise BuildError('缺少 node_modules/gsap，先运行 npm ci')
    version = json.loads(pkg.read_text(encoding='utf-8')).get('version')
    if version != GSAP_VERSION:
        log.warn(f'node_modules 里的 GSAP 是 {version}，package.json 锁定的是 {GSAP_VERSION}；请重新 npm ci')
    for name in GSAP_FILES:
        src = NODE / 'gsap' / 'dist' / name
        if not src.exists():
            raise BuildError(f'缺少 {src}')
        copy_file(src, out / 'vendor' / 'gsap' / name)
    log.info(f'  gsap {version}：' + '、'.join(GSAP_FILES))

    log.info('[5/7] 字体')
    fonts = build_fonts(out, page, site, args.offline, log)
    log.info(f'  毛笔字 {fonts["brushChars"]} 个（{fonts["brushText"]}）；方式：'
             + ('Google Fonts 子集' if fonts['mode'] == 'google' else '退回仓库子集与系统字体'))

    log.info('[6/7] 媒体')
    media = place_media(out, data, previews_dir, args.copy_previews, log)
    log.check('放置媒体')
    mode = {'release': '用 Release 地址', 'symlink': '软链接', 'copy': '复制'}[media['previewMode']]
    film1280 = f'、手机版 media/beiming-1280.mp4（{media["film1280"] / 1e6:.2f} MB）' if media.get('film1280') else ''
    log.info(f'  海报 {media["posters"]} 张；预览视频 {media["previews"]} 个（{mode}）；悬停短循环 {media.get("hover", 0)} 段；'
             f'样片 media/beiming.mp4{film1280}')

    log.info('[7/7] 校验')
    validate(out, log)
    check_copy(out, page, log)
    log.check('校验')

    (out / BUILD_MARK).write_text(json.dumps({
        'builder': 'tools/build-showcase.py',
        'counts': data['counts'],
        'previews': media['previewMode'],
        'hoverClips': media.get('hover', 0),
        'fonts': fonts['mode'],
        'gsap': version,
    }, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    size = dir_size(out, skip=('media/',))
    log.info(f'  通过。除 media/ 外站点共 {size / 1e6:.2f} MB')
    if log.warnings:
        log.info(f'完成（{len(log.warnings)} 条警告）：{out}')
    else:
        log.info(f'完成：{out}')
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='构建北冥作品站（整站）')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT, help='输出目录（默认 out/site）')
    parser.add_argument('--previews-dir', type=Path, help='本地预览视频目录（<id>-preview.mp4）')
    parser.add_argument('--copy-previews', action='store_true', help='复制预览视频（默认软链接）')
    parser.add_argument('--template', type=Path, help='页面模板（默认 <site>/index.html）')
    parser.add_argument('--site', type=Path, default=DEFAULT_SITE, help='站点源目录（默认 site/）')
    parser.add_argument('--offline', action='store_true', help='不联网取字体（有缓存用缓存，没有就退回）')
    parser.add_argument('--lenient', action='store_true', help='校验错误只警告（仅限并行开发时本地自测）')
    parser.add_argument('--no-hover-clips', action='store_true',
                        help='不剪悬停短循环（默认有本地预览且有 ffmpeg 就剪，缓存在 out/.cache/hover/）')
    parser.add_argument('--make-film-1280', action='store_true',
                        help='只从 media/beiming.mp4 重转手机版样片 media/beiming-1280.mp4（换了原片之后用），不构建站点')
    args = parser.parse_args(argv)
    try:
        if args.make_film_1280:
            return make_film_1280(Log())
        return build(args)
    except BuildError as exc:
        print(f'构建失败：{exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
