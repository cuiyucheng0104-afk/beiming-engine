#!/usr/bin/env python3
"""生成案例馆页面：把 cases/catalog.json 的 96 条案例渲染成一个零依赖单页。

用法：
  python3 tools/build-showcase.py                      # 仓库内预览：showcase/index.html，海报走 ../cases/
  python3 tools/build-showcase.py --out _site/index.html --poster-prefix cases/   # GitHub Pages 站点根
不联网、不执行影片；预览视频指向 casebook-2026.11 Release，海报指向 cases/previews。
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

GROUP_META = {
    'beiming-labs': ('北冥画风实验', '北冥引擎的色阶、九景与三维重建试验；画风实验不计为正式成片。'),
    'local-films': ('自研动画与预演', '豹变四版、九分钟试作、机械动画、交互页面与技术预演。'),
    'ppt-stories': ('PPT 故事介绍片', '从幻灯片原画、分层、时间轴到代码镜头与混音的七部故事片。'),
    'ppt-keynote': ('发布会动画', '上影发布会六条工程与一组共用资源。'),
    'styles': ('纯代码风格基座', '66 部代码风格实验：笔触、材质、排版与信息图的实现集合。'),
}
GROUP_ORDER = ['beiming-labs', 'ppt-stories', 'ppt-keynote', 'local-films', 'styles']

STATUS_CN = {
    'historical-render': '历史成片 · 未重渲',
    'rejected': '画面未获认可',
    'experiment': '画风实验',
    'interactive': '交互 / 页面实验',
    'previs': '技术预演',
    'support': '共用资源',
}
STATUS_CLASS = {
    'historical-render': 'ok',
    'rejected': 'bad',
    'experiment': 'wip',
    'interactive': 'wip',
    'previs': 'wip',
    'support': 'muted',
}

TRACKS = [
    {
        'key': 'A',
        'name': '北冥风格 · WebGL 三渲二',
        'en': 'BEIMING STYLE / WEBGL',
        'desc': '造型、三色分档卡通着色、ID 墨线、Kuwahara 笔触与 Canvas 2D 人物，全部逐帧确定性绘制；显示层单独合成。',
        'entries': [('engine/', '引擎九层'), ('src/', '《北冥》样片'), ('lab/', '模块自测页')],
        'href': f'{REPO}/tree/main/engine',
    },
    {
        'key': 'B',
        'name': 'RAEA 原生 · RTX 工具链',
        'en': 'RAEA NATIVE / RTX',
        'desc': '同一套鲲、渡船与底板导出为 GLB，走原生运行时与 GPU；与 WebGL 路线分别验收，不把原生加速记在浏览器头上。',
        'entries': [('examples/raea/', '原生示例'), ('docs/raea/', '源码对照与集成')],
        'href': f'{REPO}/tree/main/examples/raea',
    },
    {
        'key': 'C',
        'name': '纯代码风格 · 66 + 20 基座',
        'en': 'CODE STYLES / VENDOR',
        'desc': 'SY 的 20 风格 / 100 示例与 Lemo 的 66 风格完整快照，作为画风参照与可复用方法库；它们是外部 MIT 代码，保留原署名。',
        'entries': [('cases/vendor/sy-style-100/', 'SY 基座'), ('cases/vendor/lemo-opuscar/', 'Lemo 基座')],
        'href': f'{REPO}/tree/main/cases/vendor',
    },
]


def esc(value) -> str:
    return html.escape('' if value is None else str(value), quote=True)


def poster_url(case: dict, prefix: str) -> str:
    poster = case.get('poster')
    return f'{prefix}{poster}' if poster else ''


def duration_of(case: dict) -> float | None:
    preview = case.get('preview') or {}
    if isinstance(preview.get('duration'), (int, float)):
        return float(preview['duration'])
    for art in case.get('artifacts') or []:
        video = art.get('video') or {}
        if isinstance(video.get('duration'), (int, float)):
            return float(video['duration'])
    return None


def load_cases(poster_prefix: str) -> list[dict]:
    manifest = json.loads(CATALOG.read_text(encoding='utf-8'))
    cases = []
    for case in manifest['cases']:
        preview = case.get('preview') or {}
        item = {
            'id': case['id'],
            'group': case['group'],
            'status': case['status'],
            'statusText': STATUS_CN.get(case['status'], case['status']),
            'statusClass': STATUS_CLASS.get(case['status'], 'muted'),
            'title': case['title'],
            'poster': poster_url(case, poster_prefix),
            'video': preview.get('url') or '',
            'duration': duration_of(case),
            'entry': f'{REPO}/blob/main/cases/entries/{case["id"]}.md',
            'source': f'{REPO}/tree/main/cases/source/{case["id"]}',
            'workspace': case.get('workspacePath') or '',
            'notes': ' '.join(case.get('notes') or []),
            'upstreamStyle': case.get('upstreamStyle') or '',
        }
        cases.append(item)
    order = {g: i for i, g in enumerate(GROUP_ORDER)}
    cases.sort(key=lambda c: (order.get(c['group'], 99), c['id']))
    return cases


def fmt_duration(seconds: float | None) -> str:
    if seconds is None:
        return ''
    return f'{seconds:.1f}s' if seconds < 60 else f'{int(seconds // 60)}:{seconds % 60:04.1f}'


def card_html(case: dict) -> str:
    poster = esc(case['poster'])
    img = (f'<img loading="lazy" src="{poster}" alt="{esc(case["title"])}">'
           if poster else '<div class="noposter">北冥</div>')
    play = ('<button class="play" data-id="%s" aria-label="播放预览">▶</button>' % esc(case['id'])
            if case['video'] else '<span class="novideo">无预览</span>')
    dur = fmt_duration(case['duration'])
    style = f'<span class="tag">{esc(case["upstreamStyle"])}</span>' if case['upstreamStyle'] else ''
    return f'''<article class="card" data-id="{esc(case['id'])}" data-group="{esc(case['group'])}" data-status="{esc(case['status'])}" data-title="{esc(case['title'])} {esc(case['id'])}">
  <div class="thumb">{img}{play}<span class="badge {case['statusClass']}">{esc(case['statusText'])}</span></div>
  <div class="body">
    <h3>{esc(case['title'])}</h3>
    <p class="meta"><code>{esc(case['id'])}</code>{f' · {dur}' if dur else ''} {style}</p>
  </div>
</article>'''


def build(out_path: Path, poster_prefix: str) -> str:
    cases = load_cases(poster_prefix)
    groups = {g: [c for c in cases if c['group'] == g] for g in GROUP_ORDER}
    durations = [c['duration'] for c in cases if c['duration']]
    stats = [
        ('96', '案例记录'),
        ('83', '历史成片'),
        ('66', '纯代码风格'),
        ('2809', '上游基座文件'),
        (f'{sum(durations):,.0f}s' if durations else '—', '可看片长合计'),
    ]

    cards_json = json.dumps({c['id']: {'title': c['title'], 'video': c['video'],
                                       'entry': c['entry'], 'status': c['statusText'],
                                       'duration': fmt_duration(c['duration'])}
                             for c in cases}, ensure_ascii=False)

    group_filters = ''.join(
        f'<button class="chip" data-group="{esc(g)}">{esc(GROUP_META[g][0])} <em>{len(groups[g])}</em></button>'
        for g in GROUP_ORDER
    )

    sections = []
    for g in GROUP_ORDER:
        title, desc = GROUP_META[g]
        section_cards = '\n'.join(card_html(c) for c in groups[g])
        sections.append(f'''<section class="group" data-group="{esc(g)}">
  <header class="group-head"><h2>{esc(title)} <em>{len(groups[g])}</em></h2><p>{esc(desc)}</p></header>
  <div class="grid">{section_cards}</div>
</section>''')

    track_cards = ''.join(f'''<a class="track" href="{esc(t['href'])}" target="_blank" rel="noreferrer">
  <span class="key">{t['key']}</span>
  <h3>{esc(t['name'])}</h3>
  <p class="en">{esc(t['en'])}</p>
  <p>{esc(t['desc'])}</p>
  <p class="links">{' · '.join(f'<span>{esc(name)}</span>' for _, name in t['entries'])}</p>
</a>''' for t in TRACKS)

    stats_html = ''.join(f'<div class="stat"><b>{esc(v)}</b><span>{esc(k)}</span></div>' for v, k in stats)
    html_doc = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>北冥 · 案例馆 / Beiming Engine</title>
<meta name="description" content="北冥引擎的案例馆：96 个创作与实验工程，66 个纯代码风格，20 + 66 套上游风格基座。">
<style>
:root{{--bg:#0d1520;--bg2:#111c29;--line:#243449;--ink:#ece7de;--dim:#93a4b8;--gold:#d9b46a;--cyan:#6fb6c9;--bad:#c96b6b}}
*{{box-sizing:border-box}}
html{{scroll-behavior:smooth}}
body{{margin:0;background:linear-gradient(180deg,#0a121b,#0d1520 30%,#0b131d);color:var(--ink);font:16px/1.65 "PingFang SC","Microsoft YaHei",system-ui,sans-serif}}
a{{color:var(--cyan);text-decoration:none}}a:hover{{text-decoration:underline}}
.wrap{{max-width:1240px;margin:0 auto;padding:0 24px}}
nav{{position:sticky;top:0;z-index:30;background:rgba(10,18,27,.86);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}}
nav .wrap{{display:flex;align-items:center;gap:22px;height:58px;font-size:14px}}
nav .brand{{font-weight:700;letter-spacing:.14em;color:var(--gold)}}
nav .sp{{flex:1}}
.hero{{padding:84px 0 46px;border-bottom:1px solid var(--line);background:radial-gradient(900px 320px at 20% 0%,rgba(111,182,201,.10),transparent 70%)}}
.hero .eyebrow{{color:var(--gold);letter-spacing:.3em;font-size:12px}}
.hero h1{{font-size:clamp(38px,6vw,68px);line-height:1.08;margin:16px 0 14px;font-weight:800}}
.hero h1 span{{color:var(--gold)}}
.hero p.lead{{max-width:760px;color:var(--dim);font-size:17px}}
.stats{{display:flex;flex-wrap:wrap;gap:14px;margin:30px 0 0}}
.stat{{border:1px solid var(--line);background:var(--bg2);padding:12px 18px;border-radius:12px;min-width:118px}}
.stat b{{display:block;font-size:24px;color:var(--gold)}}
.stat span{{font-size:12px;color:var(--dim);letter-spacing:.06em}}
section.block{{padding:56px 0;border-bottom:1px solid var(--line)}}
section.block>h2{{font-size:26px;margin:0 0 6px}}
section.block>p.sub{{color:var(--dim);margin:0 0 26px;max-width:820px}}
.tracks{{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}}
.track{{display:block;border:1px solid var(--line);background:linear-gradient(180deg,#12202e,#0e1926);border-radius:16px;padding:22px;color:var(--ink)}}
.track:hover{{border-color:var(--gold);text-decoration:none}}
.track .key{{display:inline-flex;width:30px;height:30px;border:1px solid var(--gold);color:var(--gold);border-radius:50%;align-items:center;justify-content:center;font-weight:700;font-size:14px}}
.track h3{{margin:14px 0 2px;font-size:19px}}
.track .en{{color:var(--dim);font-size:11px;letter-spacing:.18em;margin:0 0 12px}}
.track p{{color:var(--dim);font-size:14px;margin:0 0 12px}}
.track .links{{color:var(--cyan);font-size:13px;margin:0}}
.toolbar{{position:sticky;top:58px;z-index:20;background:rgba(11,19,29,.92);backdrop-filter:blur(8px);padding:14px 0;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:12px;align-items:center}}
.chip{{border:1px solid var(--line);background:transparent;color:var(--dim);padding:7px 14px;border-radius:999px;cursor:pointer;font-size:13px}}
.chip em{{font-style:normal;color:var(--gold);margin-left:4px}}
.chip.on{{border-color:var(--gold);color:var(--ink);background:rgba(217,180,106,.10)}}
input[type=search],select{{background:#0e1926;border:1px solid var(--line);color:var(--ink);padding:8px 12px;border-radius:8px;font-size:13px}}
input[type=search]{{min-width:220px}}
.count{{margin-left:auto;color:var(--dim);font-size:13px}}
.group{{padding:34px 0 8px}}
.group-head h2{{font-size:22px;margin:0 0 4px}}.group-head h2 em{{font-style:normal;color:var(--gold);font-size:15px;margin-left:6px}}
.group-head p{{color:var(--dim);margin:0 0 20px;font-size:14px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(236px,1fr));gap:16px}}
.card{{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg2);display:flex;flex-direction:column;transition:transform .15s,border-color .15s}}
.card:hover{{transform:translateY(-3px);border-color:#3b5570}}
.thumb{{position:relative;aspect-ratio:16/9;background:#05090e;overflow:hidden}}
.thumb img{{width:100%;height:100%;object-fit:cover;display:block}}
.noposter{{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#2a3d54;font-size:26px;letter-spacing:.3em}}
.play{{position:absolute;inset:0;margin:auto;width:46px;height:46px;border-radius:50%;border:1px solid rgba(255,255,255,.5);background:rgba(6,12,18,.55);color:#fff;font-size:15px;cursor:pointer;opacity:0;transition:opacity .15s}}
.card:hover .play{{opacity:1}}
.novideo{{position:absolute;right:8px;bottom:8px;font-size:11px;color:#b9c7d6;background:rgba(5,9,14,.65);padding:2px 7px;border-radius:6px}}
.badge{{position:absolute;left:8px;top:8px;font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(5,9,14,.72);border:1px solid var(--line);color:#c9d6e4}}
.badge.ok{{border-color:rgba(217,180,106,.5);color:var(--gold)}}
.badge.bad{{border-color:rgba(201,107,107,.6);color:#e09a9a}}
.badge.wip{{border-color:rgba(111,182,201,.5);color:var(--cyan)}}
.body{{padding:12px 14px 14px}}
.body h3{{font-size:15px;line-height:1.4;margin:0 0 6px;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}}
.meta{{margin:0;color:var(--dim);font-size:12px}}
.meta code{{color:#8fa7c0;font-size:11px}}
.tag{{display:inline-block;border:1px solid var(--line);border-radius:5px;padding:0 5px;margin-left:4px;font-size:11px}}
.vendor{{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}}
.vendor .card2{{border:1px solid var(--line);border-radius:16px;padding:20px;background:var(--bg2)}}
.vendor h3{{margin:0 0 4px}}.vendor .commit{{color:var(--dim);font-size:12px;font-family:ui-monospace,monospace;word-break:break-all}}
.vendor p{{color:var(--dim);font-size:14px}}
footer{{padding:44px 0 64px;color:var(--dim);font-size:13px}}
footer p{{margin:0 0 8px}}
.modal{{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:rgba(3,6,10,.82);padding:24px}}
.modal.open{{display:flex}}
.modal .box{{width:min(1080px,100%);background:#0b131d;border:1px solid var(--line);border-radius:16px;overflow:hidden}}
.modal video{{width:100%;max-height:66vh;background:#000;display:block}}
.modal .mbody{{padding:16px 20px 20px}}
.modal h3{{margin:0 0 4px}}
.modal .mmeta{{color:var(--dim);font-size:13px;margin:0 0 12px}}
.modal .mlinks a{{margin-right:16px;font-size:14px}}
.modal .close{{float:right;background:none;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:4px 12px;cursor:pointer}}
@media(max-width:640px){{.hero{{padding:56px 0 34px}}.toolbar{{position:static}}input[type=search]{{min-width:0;width:100%}}}}
</style>
</head>
<body>
<nav><div class="wrap">
  <span class="brand">北冥 / BEIMING</span>
  <a href="#tracks">三条路线</a>
  <a href="#gallery">案例</a>
  <a href="#vendor">完整基座</a>
  <a href="{REPO}" target="_blank" rel="noreferrer">GitHub ↗</a>
  <span class="sp"></span>
  <a href="{RELEASE}" target="_blank" rel="noreferrer">下载成片与素材 ↗</a>
</div></nav>

<header class="hero"><div class="wrap">
  <div class="eyebrow">BEIMING ENGINE · CASE ATLAS</div>
  <h1>代码即影片，<br><span>走过的路都在这里。</span></h1>
  <p class="lead">96 个创作与实验工程、66 种纯代码风格、7 部 PPT 故事片、6 条发布会动画，以及完整的 20 + 66 套上游风格基座。
  每张卡片都能观看历史成片、追溯源码，并还原到独立工作区。</p>
  <div class="stats">{stats_html}</div>
</div></header>

<section class="block" id="tracks"><div class="wrap">
  <h2>一套引擎，三条路线</h2>
  <p class="sub">同一个仓库里，按画面怎么执行区分路线；路线决定作品组织方式，后端决定画面在哪里跑。三条路线分别验收，不把一处的成绩记到另一处。</p>
  <div class="tracks">{track_cards}</div>
</div></section>

<section class="block" id="gallery"><div class="wrap">
  <h2>案例馆</h2>
  <p class="sub">筛选、搜索、点开即播。视频是 Release 中的 960 像素观看副本，由历史成片转码，不是重新渲染；原始画质见各案例卡与 Release。</p>
  <div class="toolbar">
    <button class="chip on" data-group="all">全部 <em>96</em></button>
    {group_filters}
    <select id="status"><option value="all">全部状态</option>{''.join(f'<option value="{esc(k)}">{esc(v)}</option>' for k, v in STATUS_CN.items())}</select>
    <input type="search" id="search" placeholder="搜索片名 / 案例 ID">
    <span class="count" id="count"></span>
  </div>
  {''.join(sections)}
</div></section>

<section class="block" id="vendor"><div class="wrap">
  <h2>完整基座</h2>
  <p class="sub">两套外部仓库按固定提交完整收录，保留原始文件、许可证与作者署名；它们作为方法库与画风参照，不冒充北冥原创。</p>
  <div class="vendor">
    <div class="card2"><h3>sy-style-100</h3>
      <p class="commit">331 文件 · 20 风格 / 100 示例 · MIT · XIAOXIONG</p>
      <p>入口、渲染采样、SDF 光线步进与 18 个 lib 模块；风格命名、构成与复用方法。</p>
      <a href="{REPO}/tree/main/cases/vendor/sy-style-100">浏览快照 ↗</a></div>
    <div class="card2"><h3>lemo-opuscar</h3>
      <p class="commit">2478 文件 · 66 风格 · MIT · LemoLab</p>
      <p>66 套风格基座、全部 demo、core、导演与技术文档；历史 66 部风格实验的方法来源。</p>
      <a href="{REPO}/tree/main/cases/vendor/lemo-opuscar">浏览快照 ↗</a></div>
  </div>
</div></section>

<footer><div class="wrap">
  <p>北冥自有代码与本站点由北冥引擎仓库维护，按 MIT 开放；历史影片、素材与上游快照保留各自原权利范围。</p>
  <p>SY 与 Lemo 快照的 MIT 许可证与署名见 <a href="{REPO}/blob/main/cases/NOTICES.md">cases/NOTICES.md</a>；外部许可与固定版本见 <a href="{REPO}/blob/main/THIRD-PARTY.md">THIRD-PARTY.md</a>。RAEA 运行时未随仓库分发，按其自身许可使用。</p>
</div></footer>

<div class="modal" id="modal" role="dialog" aria-modal="true"><div class="box">
  <video id="player" controls playsinline preload="none"></video>
  <div class="mbody">
    <button class="close" id="close">关闭 ✕</button>
    <h3 id="mtitle"></h3>
    <p class="mmeta" id="mmeta"></p>
    <p class="mlinks"><a id="mentry" target="_blank" rel="noreferrer">案例卡与源码映射 ↗</a><a id="mrelease" target="_blank" rel="noreferrer">下载原始影片包 ↗</a></p>
  </div>
</div></div>

<script>
const DATA = {cards_json};
const statusSelect = document.getElementById('status');
const search = document.getElementById('search');
const countEl = document.getElementById('count');
const groups = [...document.querySelectorAll('.group')];
const cards = [...document.querySelectorAll('.card')];
let activeGroup = 'all';

function apply() {{
  const q = search.value.trim().toLowerCase();
  const st = statusSelect.value;
  let shown = 0;
  for (const group of groups) {{
    let groupShown = 0;
    for (const card of group.querySelectorAll('.card')) {{
      const okGroup = activeGroup === 'all' || card.dataset.group === activeGroup;
      const okStatus = st === 'all' || card.dataset.status === st;
      const okQuery = !q || card.dataset.title.toLowerCase().includes(q);
      const show = okGroup && okStatus && okQuery;
      card.style.display = show ? '' : 'none';
      if (show) groupShown++;
    }}
    group.style.display = groupShown ? '' : 'none';
    shown += groupShown;
  }}
  countEl.textContent = `显示 ${{shown}} / ${{cards.length}}`;
}}
document.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => {{
  document.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b === btn));
  activeGroup = btn.dataset.group;
  apply();
}}));
statusSelect.addEventListener('change', apply);
search.addEventListener('input', apply);
apply();

const modal = document.getElementById('modal');
const player = document.getElementById('player');
function openModal(id) {{
  const item = DATA[id];
  if (!item) return;
  document.getElementById('mtitle').textContent = item.title;
  document.getElementById('mmeta').textContent = [item.status, item.duration].filter(Boolean).join(' · ');
  document.getElementById('mentry').href = item.entry;
  document.getElementById('mrelease').href = '{RELEASE}';
  if (item.video) {{ player.src = item.video; player.play().catch(() => {{}}); }}
  modal.classList.add('open');
}}
function closeModal() {{ modal.classList.remove('open'); player.pause(); player.removeAttribute('src'); player.load(); }}
document.querySelectorAll('.play').forEach(btn => btn.addEventListener('click', e => {{ e.stopPropagation(); openModal(btn.dataset.id); }}));
document.getElementById('close').addEventListener('click', closeModal);
modal.addEventListener('click', e => {{ if (e.target === modal) closeModal(); }});
document.addEventListener('keydown', e => {{ if (e.key === 'Escape') closeModal(); }});
</script>
</body>
</html>
'''
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html_doc, encoding='utf-8')
    return str(out_path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='生成北冥案例馆单页')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT, help='输出 HTML 路径')
    parser.add_argument('--poster-prefix', default='../cases/', help='海报相对前缀（站点根部署用 cases/）')
    options = parser.parse_args()
    path = build(options.out, options.poster_prefix)
    print(f'wrote {path}')
