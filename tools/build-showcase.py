#!/usr/bin/env python3
"""生成北冥案例馆页面（投资人向的作品站）。

数据来自 cases/catalog.json。策展规则写在 CURATION 里：
  · 只保留有观看预览的成片（无案例展示的不上站）
  · 下掉「自研动画与预演」整组
  · 下掉状态为 rejected / support / interactive / previs 的记录
仓库里的完整档案（96 条）不变，本站只是对外展示的策展版本。

用法：
  python3 tools/build-showcase.py                                   # 仓库内预览
  python3 tools/build-showcase.py --out _site/index.html \
      --poster-prefix cases/ --media-prefix media/                  # GitHub Pages 站点根
不联网、不执行影片。
"""
from __future__ import annotations

import argparse
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'cases' / 'catalog.json'
DEFAULT_OUT = ROOT / 'showcase' / 'index.html'

REPO = 'https://github.com/cuiyucheng0104-afk/beiming-engine'
RELEASE = f'{REPO}/releases/tag/casebook-2026.11'
FILM_1080 = f'{REPO}/releases/download/v1.0/beiming.mp4'
FILM_4K = f'{REPO}/releases/download/v1.0/beiming_4k.mp4'

# 对外品牌名（不出现上游仓库名；许可与来源见仓库 THIRD-PARTY.md）
TRACKS = [
    {
        'key': 'A',
        'name': '北冥风格 · WebGL 三渲二',
        'en': 'BEIMING STYLE / WEBGL',
        'body': '造型、三色分档卡通着色、ID 墨线、Kuwahara 笔触与 Canvas 2D 人物，全部在无头浏览器里逐帧绘制；'
                '1080p 与原生 4K 出自同一份代码。',
        'points': ['九层引擎模块', '确定性逐帧', '一条命令出片'],
        'href': f'{REPO}/tree/main/engine',
    },
    {
        'key': 'B',
        'name': '北冥原生 · BNE',
        'en': 'BEIMING NATIVE ENGINE / RTX',
        'body': '同一套鲲、渡船与底板导出为 GLB，交给原生运行时与独立 GPU。速度与画质分别记录，'
                '不把浏览器的 Vulkan 数据写成原生 GPU 成绩。',
        'points': ['GLB 资产桥', '原生 GPU 执行', '独立验收'],
        'href': f'{REPO}/blob/main/docs/TRACKS.md',
    },
    {
        'key': 'C',
        'name': '北冥代码动画风格 · 86 式',
        'en': 'BEIMING CODE-MOTION STYLES',
        'body': '86 式代码画法，已产出 66 部成片：笔触、材质、排版、信息图与剪辑节奏都写成代码，'
                '可逐部对照、可直接复用为新片的风格底稿。',
        'points': ['86 式画法', '66 部成片', '逐部可还原'],
        'href': f'{REPO}/tree/main/cases',
    },
]

GROUPS = {
    'styles': {
        'title': '北冥代码动画风格',
        'en': 'CODE-MOTION STYLES',
        'desc': '66 部风格样片，每部 18–20 秒。同一套代码骨架，换笔触与材质就是另一种画风。',
    },
    'ppt-stories': {
        'title': 'PPT 故事介绍片',
        'en': 'STORY FILMS',
        'desc': '7 部品牌故事片，2–4 分钟。从原画分层、时间线到代码镜头与混音，完整链路交付。',
    },
    'ppt-keynote': {
        'title': '发布会动画',
        'en': 'KEYNOTE FILMS',
        'desc': '6 条发布会工程，20 秒到 3 分钟。开场、段落与落版，同一套管线批量出片。',
    },
}
GROUP_ORDER = ['styles', 'ppt-stories', 'ppt-keynote']

CURATION = {
    'excludeGroups': {'local-films'},
    'excludeStatuses': {'rejected', 'support', 'interactive', 'previs'},
    'requirePreview': True,
}

FORBIDDEN_ON_PAGE = ['RAEA', 'raea', 'Lemo', 'lemo', 'Opuscar', 'opuscar', 'SY100', 'sy-style-100', '外部仓库', '上游']


def esc(value) -> str:
    return html.escape('' if value is None else str(value), quote=True)


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
    if seconds is None:
        return ''
    if seconds < 60:
        return f'{seconds:.0f} 秒' if seconds >= 10 else f'{seconds:.1f} 秒'
    return f'{int(seconds // 60)} 分 {seconds % 60:04.0f} 秒'


def load_cases(poster_prefix: str) -> list[dict]:
    manifest = json.loads(CATALOG.read_text(encoding='utf-8'))
    cases = []
    for case in manifest['cases']:
        if not keep_case(case):
            continue
        preview = case.get('preview') or {}
        poster = f'{poster_prefix}{case["poster"]}' if case.get('poster') else ''
        cases.append({
            'id': case['id'],
            'group': case['group'],
            'title': case['title'],
            'poster': poster,
            'video': preview.get('url') or '',
            'duration': duration_of(case),
            'entry': f'{REPO}/blob/main/cases/entries/{case["id"]}.md',
            'style': case.get('upstreamStyle') or '',
        })
    order = {g: i for i, g in enumerate(GROUP_ORDER)}
    cases.sort(key=lambda c: (order.get(c['group'], 99), c['id']))
    return cases


def card_html(case: dict) -> str:
    title = esc(case['title'])
    img = (f'<img loading="lazy" src="{esc(case["poster"])}" alt="{title}" '
           f'width="640" height="360">' if case['poster'] else '')
    dur = fmt_duration(case['duration'])
    style = f'<span class="card-style">{esc(case["style"])}</span>' if case['style'] else ''
    return f'''<article class="card" data-group="{esc(case['group'])}" data-title="{title} {esc(case['id'])}">
  <button class="card-hit" data-id="{esc(case['id'])}" aria-label="播放预览：{title}">
    <span class="poster">{img}<span class="veil"></span>
      <span class="play" aria-hidden="true">▶</span>
      <span class="card-meta">{dur}{(' · ' + esc(case['style'])) if case['style'] else ''}</span>
    </span>
    <span class="card-title">{title}</span>
  </button>
  <a class="card-link" href="{esc(case['entry'])}" target="_blank" rel="noreferrer">案例卡与源码 ↗</a>
</article>'''


def build(out_path: Path, poster_prefix: str, media_prefix: str) -> str:
    cases = load_cases(poster_prefix)
    groups = {g: [c for c in cases if c['group'] == g] for g in GROUP_ORDER}
    total = len(cases)
    total_seconds = sum(c['duration'] or 0 for c in cases)
    stats = [
        (str(total), '部成片'),
        ('3', '条渲染路线'),
        ('9', '层引擎模块'),
        ('原生 4K', '平台输出'),
    ]

    data = json.dumps({c['id']: {'title': c['title'], 'video': c['video'],
                                 'entry': c['entry'], 'duration': fmt_duration(c['duration'])}
                       for c in cases}, ensure_ascii=False)

    filters = ''.join(
        f'<button class="tab{" is-on" if i == 0 else ""}" data-group="all">全部 <em>{total}</em></button>'
        for i in [0]
    ) + ''.join(
        f'<button class="tab" data-group="{g}">{esc(GROUPS[g]["title"])} <em>{len(groups[g])}</em></button>'
        for g in GROUP_ORDER
    )

    sections = []
    for g in GROUP_ORDER:
        meta = GROUPS[g]
        cards = '\n'.join(card_html(c) for c in groups[g])
        sections.append(f'''<section class="work-group" data-group="{esc(g)}" aria-labelledby="g-{esc(g)}">
  <header class="group-head">
    <p class="eyebrow">{esc(meta['en'])}</p>
    <h2 id="g-{esc(g)}">{esc(meta['title'])}<span class="count">{len(groups[g])} 部</span></h2>
    <p class="group-desc">{esc(meta['desc'])}</p>
  </header>
  <div class="grid">{cards}</div>
</section>''')

    tracks = ''.join(f'''<article class="route">
  <span class="route-key" aria-hidden="true">{t['key']}</span>
  <p class="eyebrow">{esc(t['en'])}</p>
  <h3>{esc(t['name'])}</h3>
  <p class="route-body">{esc(t['body'])}</p>
  <ul class="route-points">{''.join(f'<li>{esc(p)}</li>' for p in t['points'])}</ul>
  <a class="route-link" href="{esc(t['href'])}" target="_blank" rel="noreferrer">查看工程 ↗</a>
</article>''' for t in TRACKS)

    stats_html = ''.join(f'<div class="stat"><b>{esc(v)}</b><span>{esc(k)}</span></div>' for v, k in stats)

    page = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>北冥引擎 · 代码即影片</title>
<meta name="description" content="北冥引擎：用代码逐帧画出的三渲二 / 2.5D 动画管线。1080p 与原生 4K 同源，{total} 部成片按风格归档。">
<meta property="og:title" content="北冥引擎 · 代码即影片">
<meta property="og:description" content="用代码逐帧画出的三渲二 / 2.5D 动画管线。{total} 部成片按风格归档。">
<meta property="og:image" content="{media_prefix}shot_7.6.jpg">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='%23070d12'/><text x='32' y='44' font-size='38' text-anchor='middle' fill='%23c7a46a' font-family='serif'>北</text></svg>">
<style>
:root {{
  --ink: #080d14;
  --ink-soft: #0d1723;
  --paper: #f1e9dc;
  --muted: #9aa4b8;
  --gold: #d9a36c;
  --gold-dim: #a8754c;
  --lilac: #b9a7d6;
  --line: rgba(217,163,108,.20);
  --line-soft: rgba(241,233,220,.10);
  --serif: "Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", "SimSun", serif;
  --sans: "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, sans-serif;
  --mono: "SF Mono", "Cascadia Mono", "Consolas", ui-monospace, monospace;
  --pad: clamp(20px, 5vw, 72px);
}}
* {{ box-sizing: border-box; }}
html {{ scroll-behavior: smooth; }}
body {{
  margin: 0; background: var(--ink); color: var(--paper);
  font: 16px/1.75 var(--sans);
  -webkit-font-smoothing: antialiased;
}}
::selection {{ background: var(--gold); color: var(--ink); }}
a {{ color: inherit; text-decoration: none; }}
img {{ max-width: 100%; display: block; }}
button {{ font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }}
:focus-visible {{ outline: 2px solid var(--gold); outline-offset: 3px; }}
.skip {{ position: absolute; left: -999px; top: 0; background: var(--gold); color: var(--ink); padding: 10px 16px; z-index: 100; }}
.skip:focus {{ left: 12px; top: 12px; }}

/* ---------- nav ---------- */
.nav {{
  position: fixed; inset: 0 0 auto 0; z-index: 40;
  display: flex; align-items: center; gap: 28px;
  padding: 0 var(--pad); height: 66px;
  background: linear-gradient(180deg, rgba(7,13,18,.92), rgba(7,13,18,.55) 70%, transparent);
}}
.nav .brand {{ font-family: var(--serif); font-size: 19px; letter-spacing: .28em; color: var(--gold); }}
.nav .mark {{ font-family: var(--mono); font-size: 10px; letter-spacing: .22em; color: var(--muted); }}
.nav .links {{ display: flex; gap: 26px; margin-left: auto; font-size: 13px; letter-spacing: .1em; }}
.nav .links a {{ color: var(--muted); transition: color .2s; }}
.nav .links a:hover {{ color: var(--paper); }}
.nav .gh {{ border: 1px solid var(--line); padding: 6px 14px; border-radius: 2px; color: var(--gold); }}
.nav .gh:hover {{ background: rgba(199,164,106,.12); }}

/* ---------- hero ---------- */
.hero {{ position: relative; min-height: 100svh; padding: 120px var(--pad) 0; display: flex; flex-direction: column; overflow: hidden; }}
.hero-still {{ position: absolute; inset: 0; background: url("{media_prefix}shot_1.6.jpg") center 34%/cover no-repeat; opacity: 1; }}
.hero-still::after {{ content: ""; position: absolute; inset: 0; background:
  linear-gradient(96deg, var(--ink) 0%, rgba(8,13,20,.95) 30%, rgba(8,13,20,.55) 52%, rgba(8,13,20,.12) 78%, rgba(8,13,20,.42) 100%),
  linear-gradient(0deg, var(--ink) 0%, rgba(8,13,20,.72) 16%, rgba(8,13,20,.05) 46%, rgba(8,13,20,.28) 82%, rgba(8,13,20,.86) 100%); }}
.hero-inner {{ position: relative; z-index: 2; flex: 1; display: flex; flex-direction: column; justify-content: center;
  max-width: 1240px; width: 100%; margin: 0 auto; padding-bottom: 40px; }}
.hero .eyebrow {{ color: var(--lilac); letter-spacing: .34em; }}
.hero h1 {{ font-family: var(--serif); font-weight: 500; letter-spacing: .06em; line-height: .94;
  font-size: clamp(104px, 18vw, 244px); margin: 16px 0 24px; text-shadow: 0 8px 60px rgba(8,13,20,.55); }}
.hero h1 .en {{ display: block; font-family: var(--mono); font-size: clamp(11px, 1.2vw, 14px);
  letter-spacing: .62em; color: var(--muted); margin-top: 24px; }}
.hero .lede {{ max-width: 620px; font-size: clamp(16px, 1.4vw, 20px); line-height: 1.95; color: #efe5d4; text-shadow: 0 2px 26px rgba(8,13,20,.6); }}
.hero .cta {{ display: flex; flex-wrap: wrap; gap: 14px; margin: 36px 0 0; }}
.btn {{ display: inline-flex; align-items: center; gap: 10px; padding: 14px 26px; font-size: 14px; letter-spacing: .12em; border: 1px solid var(--gold); color: var(--gold); transition: background .2s, color .2s; }}
.btn:hover {{ background: var(--gold); color: var(--ink); }}
.btn.ghost {{ border-color: rgba(241,233,220,.35); color: var(--paper); }}
.btn.ghost:hover {{ border-color: var(--gold); background: transparent; color: var(--gold); }}
.hero-data {{ position: relative; z-index: 2; margin: 0 auto; max-width: 1240px; width: 100%;
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; border-top: 1px solid var(--line);
  padding: 24px 0 26px; background: linear-gradient(180deg, rgba(8,13,20,.0), rgba(8,13,20,.55)); }}
.stat b {{ display: block; font-family: var(--serif); font-size: clamp(20px, 2vw, 28px); font-weight: 500; color: var(--paper); }}
.stat span {{ font-size: 11px; letter-spacing: .2em; color: var(--muted); }}
.tide {{ display: none; }}
.scroll-note {{ position: relative; z-index: 2; display: flex; justify-content: center; padding: 0 0 22px; }}
.scroll-note span {{ font-family: var(--mono); font-size: 10px; letter-spacing: .3em; color: var(--gold-dim); }}

/* ---------- shared ---------- */
main {{ counter-reset: none; }}
.section {{ padding: clamp(84px, 12vh, 150px) var(--pad); }}
.section-inner {{ max-width: 1240px; margin: 0 auto; }}
.eyebrow {{ margin: 0 0 18px; font-family: var(--mono); font-size: 10px; letter-spacing: .3em; text-transform: uppercase; color: var(--gold-dim); }}
h2 {{ font-family: var(--serif); font-weight: 500; font-size: clamp(32px, 4.4vw, 62px); line-height: 1.18; letter-spacing: .03em; margin: 0 0 22px; }}
.lede {{ color: #d5cab6; font-size: 17px; line-height: 1.95; max-width: 660px; }}
.rule {{ height: 1px; background: var(--line-soft); margin: 0 var(--pad); }}

/* ---------- engine ---------- */
.engine {{ display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: clamp(32px, 6vw, 96px); }}
.layers {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line-soft); border: 1px solid var(--line-soft); }}
.layer {{ background: var(--ink); padding: 22px 20px; min-height: 132px; }}
.layer b {{ font-family: var(--serif); font-size: 27px; font-weight: 500; color: var(--gold); display: block; }}
.layer span {{ display: block; font-family: var(--mono); font-size: 9px; letter-spacing: .26em; color: var(--muted); margin: 8px 0 4px; }}
.layer p {{ margin: 0; font-size: 13px; line-height: 1.7; color: #c8bda9; }}
.proof {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; margin-top: 54px; border-top: 1px solid var(--line); padding-top: 26px; }}
.proof b {{ display: block; font-family: var(--serif); font-size: clamp(24px, 2.6vw, 34px); font-weight: 500; }}
.proof span {{ display: block; font-size: 12px; color: var(--muted); margin-top: 6px; }}

/* ---------- routes ---------- */
.routes {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px; margin-top: 56px; }}
.route {{ position: relative; border: 1px solid var(--line-soft); background: linear-gradient(170deg, rgba(12,26,34,.9), rgba(7,13,18,.4)); padding: 34px 28px 30px; display: flex; flex-direction: column; gap: 14px; transition: border-color .25s, transform .25s; }}
.route:hover {{ border-color: var(--line); transform: translateY(-4px); }}
.route-key {{ position: absolute; right: 20px; top: 6px; font-family: var(--serif); font-size: clamp(64px, 7vw, 96px); line-height: 1; color: transparent; -webkit-text-stroke: 1px rgba(199,164,106,.28); }}
.route .eyebrow {{ margin: 0; }}
.route h3 {{ margin: 0; font-family: var(--serif); font-weight: 500; font-size: clamp(20px, 1.7vw, 25px); line-height: 1.4; max-width: 100%; text-wrap: balance; word-break: keep-all; }}
.route-body {{ margin: 0; font-size: 14px; line-height: 1.85; color: #c8bda9; flex: 1; }}
.route-points {{ list-style: none; margin: 0; padding: 16px 0 0; border-top: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 6px; font-family: var(--mono); font-size: 10px; letter-spacing: .16em; color: var(--muted); }}
.route-points li::before {{ content: "— "; color: var(--gold-dim); }}
.route-link {{ font-size: 12px; letter-spacing: .14em; color: var(--gold); margin-top: 8px; }}

/* ---------- works ---------- */
.works-head {{ display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; }}
.toolbar {{ display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 44px 0 10px; padding-bottom: 18px; border-bottom: 1px solid var(--line-soft); }}
.tab {{ font-family: var(--mono); font-size: 11px; letter-spacing: .14em; color: var(--muted); padding: 9px 16px; border: 1px solid transparent; }}
.tab em {{ font-style: normal; color: var(--gold-dim); margin-left: 6px; }}
.tab:hover {{ color: var(--paper); }}
.tab.is-on {{ border-color: var(--line); color: var(--gold); }}
.search {{ margin-left: auto; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--line-soft); padding: 6px 2px; }}
.search input {{ background: none; border: 0; color: var(--paper); font-family: var(--mono); font-size: 12px; letter-spacing: .06em; width: 210px; }}
.search input::placeholder {{ color: #62747b; }}
.search input:focus {{ outline: none; }}
.search svg {{ width: 13px; height: 13px; stroke: var(--muted); fill: none; }}
.work-group {{ padding-top: 56px; }}
.group-head {{ max-width: 680px; margin-bottom: 30px; }}
.group-head h2 {{ font-size: clamp(24px, 2.6vw, 34px); margin-bottom: 10px; }}
.count {{ font-family: var(--mono); font-size: 11px; letter-spacing: .2em; color: var(--gold-dim); margin-left: 14px; vertical-align: middle; }}
.group-desc {{ margin: 0; color: var(--muted); font-size: 14px; line-height: 1.8; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 30px 22px; }}
.card {{ min-width: 0; }}
.card-hit {{ display: block; width: 100%; text-align: left; }}
.poster {{ position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden; background: #05090d; }}
.poster img {{ width: 100%; height: 100%; object-fit: cover; transition: transform .6s cubic-bezier(.2,.7,.2,1); }}
.card-hit:hover .poster img {{ transform: scale(1.045); }}
.veil {{ position: absolute; inset: 0; background: linear-gradient(180deg, transparent 55%, rgba(5,9,13,.82)); opacity: .9; transition: opacity .3s; }}
.card-hit:hover .veil {{ opacity: 1; }}
.play {{ position: absolute; inset: 0; margin: auto; width: 46px; height: 46px; display: grid; place-items: center; border: 1px solid rgba(237,228,211,.55); border-radius: 50%; color: var(--paper); font-size: 13px; background: rgba(7,13,18,.35); opacity: 0; transform: translateY(6px); transition: opacity .25s, transform .25s; }}
.card-hit:hover .play, .card-hit:focus-visible .play {{ opacity: 1; transform: none; }}
.card-meta {{ position: absolute; left: 12px; bottom: 10px; font-family: var(--mono); font-size: 10px; letter-spacing: .14em; color: rgba(237,228,211,.82); }}
.card-title {{ display: block; margin: 14px 0 6px; font-family: var(--serif); font-size: 16.5px; line-height: 1.55; letter-spacing: .01em; min-height: 2.9em; }}
.card-hit:hover .card-title {{ color: var(--gold); }}
.card-link {{ font-family: var(--mono); font-size: 9.5px; letter-spacing: .16em; color: #5f7178; }}
.card-link:hover {{ color: var(--gold); }}
.empty {{ padding: 60px 0; color: var(--muted); font-family: var(--mono); font-size: 12px; letter-spacing: .14em; }}

/* ---------- method ---------- */
.method {{ display: grid; grid-template-columns: minmax(0, 6fr) minmax(0, 6fr); gap: clamp(32px, 6vw, 90px); align-items: start; }}
.quote {{ font-family: var(--serif); font-size: clamp(24px, 2.6vw, 36px); line-height: 1.7; margin: 0; color: var(--paper); }}
.quote span {{ display: block; margin-top: 20px; font-family: var(--mono); font-size: 10px; letter-spacing: .26em; color: var(--gold-dim); }}
.method ul {{ list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-soft); }}
.method li {{ display: grid; grid-template-columns: 92px 1fr; gap: 18px; padding: 20px 0; border-bottom: 1px solid var(--line-soft); }}
.method li b {{ font-family: var(--mono); font-size: 10px; letter-spacing: .2em; color: var(--gold); padding-top: 4px; }}
.method li p {{ margin: 0; font-size: 14.5px; line-height: 1.85; color: #cfc4b0; }}

/* ---------- footer ---------- */
footer {{ padding: 56px var(--pad) 40px; border-top: 1px solid var(--line-soft); }}
.foot {{ max-width: 1240px; margin: 0 auto; display: flex; justify-content: space-between; align-items: flex-end; gap: 30px; flex-wrap: wrap; }}
.foot .brand {{ font-family: var(--serif); font-size: 26px; letter-spacing: .18em; color: var(--paper); }}
.foot p {{ margin: 8px 0 0; font-family: var(--mono); font-size: 10px; letter-spacing: .16em; color: #5f7178; line-height: 1.9; }}
.foot .right {{ text-align: right; }}
.foot a {{ color: var(--gold-dim); }}
.foot a:hover {{ color: var(--gold); }}

/* ---------- modal ---------- */
.modal {{ position: fixed; inset: 0; z-index: 80; display: none; align-items: center; justify-content: center; padding: clamp(12px, 4vw, 48px); }}
.modal.is-open {{ display: flex; }}
.modal-scrim {{ position: absolute; inset: 0; background: rgba(4,8,11,.9); backdrop-filter: blur(3px); }}
.modal-box {{ position: relative; width: min(1120px, 100%); }}
.modal video {{ width: 100%; max-height: 68svh; background: #000; border: 1px solid var(--line-soft); }}
.modal-bar {{ display: flex; align-items: baseline; justify-content: space-between; gap: 18px; margin-top: 16px; flex-wrap: wrap; }}
.modal-title {{ font-family: var(--serif); font-size: 19px; }}
.modal-meta {{ font-family: var(--mono); font-size: 10px; letter-spacing: .16em; color: var(--muted); }}
.modal-close {{ border: 1px solid var(--line); padding: 9px 18px; font-family: var(--mono); font-size: 10px; letter-spacing: .2em; color: var(--gold); }}
.modal-close:hover {{ background: rgba(199,164,106,.12); }}

/* ---------- responsive ---------- */
@media (max-width: 1080px) {{
  .engine, .method {{ grid-template-columns: 1fr; }}
  .routes {{ grid-template-columns: 1fr; }}
  .hero-still {{ inset: 0 0 0 20%; opacity: .55; }}
}}
@media (max-width: 760px) {{
  :root {{ --pad: 20px; }}
  .nav {{ gap: 14px; height: 58px; }}
  .nav .links {{ gap: 12px; }}
  .nav .links a:not(.gh) {{ display: none; }}
  .hero {{ padding-top: 96px; align-items: flex-start; min-height: auto; padding-bottom: 0; }}
  .hero h1 {{ font-size: clamp(84px, 30vw, 132px); }}
  .hero-data {{ grid-template-columns: repeat(2, 1fr); gap: 22px 12px; }}
  .layers {{ grid-template-columns: repeat(2, 1fr); }}
  .proof {{ grid-template-columns: 1fr; gap: 18px; }}
  .grid {{ grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px 12px; }}
  .card-title {{ font-size: 14.5px; min-height: 0; }}
  .card-meta {{ display: none; }}
  .play {{ opacity: .92; transform: none; width: 40px; height: 40px; }}
  .search {{ margin-left: 0; width: 100%; }}
  .search input {{ width: 100%; }}
  .foot .right {{ text-align: left; }}
}}
@media (prefers-reduced-motion: reduce) {{
  html {{ scroll-behavior: auto; }}
  .poster img, .route, .play {{ transition: none; }}
  .card-hit:hover .poster img {{ transform: none; }}
}}
</style>
</head>
<body>
<a class="skip" href="#works">跳到作品</a>

<nav class="nav" aria-label="主导航">
  <span class="brand">北冥</span>
  <span class="mark">BEIMING ENGINE · 2026</span>
  <span class="links">
    <a href="#engine">引擎</a>
    <a href="#routes">路线</a>
    <a href="#works">作品</a>
    <a href="#method">方法</a>
    <a class="gh" href="{REPO}" target="_blank" rel="noreferrer">GitHub ↗</a>
  </span>
</nav>

<header class="hero">
  <div class="hero-still" role="img" aria-label="《北冥》样片第 3 镜：鲲在雾江之上"></div>
  <div class="hero-inner">
    <p class="eyebrow">BEIMING ENGINE · 北冥引擎</p>
    <h1>北冥<span class="en">CODE IS THE FILM</span></h1>
    <p class="lede">一条用代码逐帧画出的三渲二 / 2.5D 渲染管线。造型、光照、墨线与人物都在代码里，同一帧永远画出同一张图——1080p 与原生 4K 出自同一份源码。</p>
    <div class="cta">
      <button class="btn" id="filmBtn">▶ 观看《北冥》样片 · 10 秒</button>
      <a class="btn ghost" href="#works">79 部作品 ↓</a>
    </div>
  </div>
  <div class="tide" aria-hidden="true"></div>
  <div class="scroll-note"><span>SCROLL</span></div>
  <div class="hero-data">{stats_html}</div>
</header>

<main>
  <section class="section" id="engine">
    <div class="section-inner engine">
      <div>
        <p class="eyebrow">01 · ENGINE</p>
        <h2>把画风<br>写成代码</h2>
        <p class="lede">画风不锁在素材里，而由造型、着色与后期三处代码共同决定。同一条鲲，换一组着色器，就是另一种气质。九个模块各管一件事，任何一层都能单独替换、单独验收。</p>
      </div>
      <div>
        <div class="layers">
          <div class="layer"><b>形</b><span>FORM</span><p>轮廓放样、翼型与鳍、沿脊游动弯曲，程序化道具确定性散布。</p></div>
          <div class="layer"><b>光</b><span>SHADE</span><p>三色分档卡通着色、量化阴影、边缘光与表面层。</p></div>
          <div class="layer"><b>景</b><span>STAGE</span><p>手绘底板分层进三维空间，按设计像素摆位，视差自然产生。</p></div>
          <div class="layer"><b>笔</b><span>LOOK</span><p>ID 墨线、空气透视、Kuwahara 笔触、纸纹与颗粒。</p></div>
          <div class="layer"><b>人</b><span>PAINT</span><p>Canvas 2D 逐笔绘制：可变宽墨线、轮廓光、水彩渗色。</p></div>
          <div class="layer"><b>界</b><span>OVERLAY</span><p>显示层与片名最后合成；毛笔字按笔顺落笔。</p></div>
          <div class="layer"><b>时</b><span>TIME</span><p>分层时钟：角色一拍二、鲲一拍三，镜头每帧都动。</p></div>
          <div class="layer"><b>声</b><span>AUDIO</span><p>程序化音效、采样编配、混音与响度，全部确定性。</p></div>
          <div class="layer"><b>片</b><span>RENDER</span><p>无头浏览器逐帧截图，多路并行，FFmpeg 编码封装。</p></div>
        </div>
        <div class="proof">
          <div><b>0.52 ms</b><span>重着色器单帧（RTX 5090 · Vulkan）</span></div>
          <div><b>31 秒</b><span>原生 4K 整片 240 帧</span></div>
          <div><b>SSIM 0.973</b><span>工作站与 Mac 4K 成片一致性</span></div>
        </div>
      </div>
    </div>
  </section>

  <div class="rule" role="presentation"></div>

  <section class="section" id="routes">
    <div class="section-inner">
      <p class="eyebrow">02 · ROUTES</p>
      <h2>一套引擎，三条路线</h2>
      <p class="lede">画面在哪里执行，决定了它的速度、分辨率与验收方式。三条路线分开记录证据，不把一处成绩记到另一处。</p>
      <div class="routes">{tracks}</div>
    </div>
  </section>

  <div class="rule" role="presentation"></div>

  <section class="section" id="works">
    <div class="section-inner">
      <div class="works-head">
        <div>
          <p class="eyebrow">03 · WORKS</p>
          <h2>作品</h2>
        </div>
        <p class="lede" style="max-width:420px;font-size:14.5px;margin:0 0 6px">全部由代码逐帧渲染，不是素材剪辑。点开即播；原始画质与素材包在 GitHub Release。</p>
      </div>
      <div class="toolbar" role="tablist" aria-label="按类别筛选">
        {filters}
        <label class="search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
          <input id="q" type="search" placeholder="搜索片名" aria-label="搜索片名">
        </label>
      </div>
      <div id="groups">{''.join(sections)}</div>
      <p class="empty" id="empty" hidden>没有匹配的作品，换个关键词。</p>
    </div>
  </section>

  <div class="rule" role="presentation"></div>

  <section class="section" id="method">
    <div class="section-inner method">
      <div>
        <p class="eyebrow">04 · METHOD</p>
        <blockquote class="quote">「代码不是素材的替代品，<br>而是画风的来源。」<span>BEIMING ENGINE · 制作原则</span></blockquote>
      </div>
      <div>
        <ul>
          <li><b>确定性</b><p>没有 Date.now，没有无种子随机。任何一个时刻都能单独重渲，第 137 帧永远和第 137 帧一样。</p></li>
          <li><b>整数帧</b><p>全局帧、镜头局部帧与动作相位分开计算；预演与成片用同一套时间轴，不靠剪辑凑时长。</p></li>
          <li><b>原始分辨率</b><p>镜头按设计尺寸摆位，4K 是直接算出来的，不是放大出来的；超分只用于拿不到原生分辨率的素材。</p></li>
          <li><b>可复刻</b><p>每一部旧片都能从归档源码还原重建；同一部片换一组参数，就是新的画风试验。</p></li>
        </ul>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="foot">
    <div>
      <div class="brand">北冥</div>
      <p>BEIMING ENGINE · 代码即影片<br>代码 MIT · 影片、底板与展示图保留所有权利<br>第三方许可与完整来源见仓库 THIRD-PARTY.md</p>
    </div>
    <div class="right">
      <p><a href="{REPO}" target="_blank" rel="noreferrer">GitHub 仓库 ↗</a><br>
      <a href="{RELEASE}" target="_blank" rel="noreferrer">下载成片与素材 ↗</a><br>
      <a href="{REPO}/blob/main/LICENSE" target="_blank" rel="noreferrer">LICENSE ↗</a></p>
    </div>
  </div>
</footer>

<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
  <div class="modal-scrim" data-close></div>
  <div class="modal-box">
    <video id="player" controls playsinline preload="none"></video>
    <div class="modal-bar">
      <span class="modal-title" id="modalTitle"></span>
      <span class="modal-meta" id="modalMeta"></span>
      <button class="modal-close" data-close>关闭 ✕</button>
    </div>
  </div>
</div>

<script>
const ITEMS = {data};
const FEATURED = {{ title: '《北冥》概念样片', meta: '10 秒 · 1920×1040 · 有声', video: '{FILM_1080}' }};
const modal = document.getElementById('modal');
const player = document.getElementById('player');
const titleEl = document.getElementById('modalTitle');
const metaEl = document.getElementById('modalMeta');
let lastFocus = null;

function openItem(item) {{
  lastFocus = document.activeElement;
  titleEl.textContent = item.title;
  metaEl.textContent = item.meta || '';
  player.src = item.video;
  modal.classList.add('is-open');
  document.documentElement.style.overflow = 'hidden';
  player.play().catch(() => {{}});
  document.querySelector('.modal-close').focus();
}}
function close() {{
  modal.classList.remove('is-open');
  document.documentElement.style.overflow = '';
  player.pause(); player.removeAttribute('src'); player.load();
  if (lastFocus) lastFocus.focus();
}}
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
document.addEventListener('keydown', e => {{ if (e.key === 'Escape' && modal.classList.contains('is-open')) close(); }});
document.getElementById('filmBtn').addEventListener('click', () => openItem(FEATURED));
document.querySelectorAll('.card-hit').forEach(btn => btn.addEventListener('click', () => {{
  const item = ITEMS[btn.dataset.id];
  if (item) openItem({{ title: item.title, meta: item.duration, video: item.video }});
}}));

const tabs = [...document.querySelectorAll('.tab')];
const groups = [...document.querySelectorAll('.work-group')];
const q = document.getElementById('q');
const empty = document.getElementById('empty');
let activeGroup = 'all';

function apply() {{
  const term = q.value.trim().toLowerCase();
  let shown = 0;
  for (const group of groups) {{
    let groupShown = 0;
    for (const card of group.querySelectorAll('.card')) {{
      const okGroup = activeGroup === 'all' || card.dataset.group === activeGroup;
      const okTerm = !term || card.dataset.title.toLowerCase().includes(term);
      const show = okGroup && okTerm;
      card.hidden = !show;
      if (show) groupShown++;
    }}
    group.hidden = groupShown === 0;
    shown += groupShown;
  }}
  empty.hidden = shown !== 0;
}}
tabs.forEach(tab => tab.addEventListener('click', () => {{
  tabs.forEach(t => {{
    t.classList.toggle('is-on', t === tab);
    t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
  }});
  activeGroup = tab.dataset.group;
  apply();
}}));
q.addEventListener('input', apply);
apply();

// 滚动淡入（尊重 reduced-motion）
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {{
  const targets = document.querySelectorAll('.section-inner > *, .work-group, .route');
  targets.forEach(el => {{ el.style.opacity = '0'; el.style.transform = 'translateY(18px)'; el.style.transition = 'opacity .7s ease, transform .7s ease'; }});
  const io = new IntersectionObserver(entries => {{
    for (const entry of entries) {{
      if (!entry.isIntersecting) continue;
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'none';
      io.unobserve(entry.target);
    }}
  }}, {{ rootMargin: '0px 0px -8% 0px' }});
  targets.forEach(el => io.observe(el));
}}
</script>
</body>
</html>
'''

    for term in FORBIDDEN_ON_PAGE:
        if term in page:
            raise SystemExit(f'showcase copy still mentions forbidden upstream name: {term!r}')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(page, encoding='utf-8')
    return str(out_path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='生成北冥作品站')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT, help='输出 HTML 路径')
    parser.add_argument('--poster-prefix', default='../cases/', help='海报相对前缀（站点根用 cases/）')
    parser.add_argument('--media-prefix', default='../media/', help='样片剧照前缀（站点根用 media/）')
    options = parser.parse_args()
    path = build(options.out, options.poster_prefix, options.media_prefix)
    print(f'wrote {path}')
