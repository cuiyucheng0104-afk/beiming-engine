#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按 audio/sfx_manifest.json 从 Freesound 搜索/下载 CC0 录音的 HQ 预览（MP3）到 audio/samples/sfx/（已被 .gitignore 排除）。

选材与检索规则：
1. 先按相关性抓取多页候选（默认 45 条），再在相关性池内按下载量与评分投票数重排（★4.4(380) 优先于 ★5.0(2)）；
2. 读取上传者 description 与 tags：一票否决嘴模(made with my mouth)、合成器(synth/VST/Serum)、手机内置麦；给专业录音设备(Zoom/Sound Devices/Sennheiser/Rode/Neumann/foley)加分；
3. ThreadPoolExecutor(6) 六线程并发下载（带临时文件原子替换与 CC0 许可证强校验）。

用法（需先设置环境变量 FREESOUND_TOKEN）：
  node tools/env/py.mjs tools/fetch_sfx.py                        # 按清单并发下载
  node tools/env/py.mjs tools/fetch_sfx.py --search "wood hit"    # 相关性池重排 + 描述信号检索
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import html as html_lib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
CC0 = 'http://creativecommons.org/publicdomain/zero/1.0/'
_BW_PLAYER_RE = re.compile(r'<div\s+class="bw-player"(.*?)</div>\s*(?:<div[^>]*class="bw-player__tags-list-height">(.*?)</div>)?', re.S)
_TAG_HREF_RE = re.compile(r'/browse/tags/([^/"\s]+)/')

ALWAYS_BAD_TAGS = {
    '8bit', '8-bit', 'chiptune', 'retro', 'arcade', 'nes', 'bit',
    'music', 'loop', 'melody', 'chord', 'song', 'singing', 'voice', 'vocal', 'speech',
    'dubstep', 'edm', 'techno', 'house', 'trance', 'riser', 'trailer',
    'gore', 'flesh', 'blood', 'fart', 'flatulant', 'burp', 'belch', 'cartoon', 'comedy'
}
ORGANIC_ONLY_BAD_TAGS = {
    'synth', 'synthesizer', 'electronic', 'sci-fi', 'scifi', 'laser',
    'robot', 'alien', 'cyberpunk', 'futuristic', 'digital',
}
BAD_TAGS = ALWAYS_BAD_TAGS | ORGANIC_ONLY_BAD_TAGS

_HITECH_QUERY_RE = re.compile(
    r'\b(hitech|hi[- ]?tech|hud|ui|beep|laser|telemetry|digital|interface|menu|futuristic|glitch|scan|cyber|holo)\b',
    re.I,
)
_PASSIVE_MECH_QUERY_RE = re.compile(
    r'\b(pen|ballpoint|watch|clockwork|ratchet|unscrew|screw|spring|latch|hinge|dial|caliper|clasp)\b',
    re.I,
)
_MOTOR_QUERY_RE = re.compile(r'\b(motor|servo|electric|drill|engine|power|zoom)\b', re.I)
_MOTOR_POLLUTION_RE = re.compile(
    r'\b(electric motor|servo|power drill|dentist drill|blender|mixer|vacuum cleaner|hair dryer|chainsaw|engine|fan)\b',
    re.I,
)
BAD_DESC_ALWAYS_RE = re.compile(
    r'\b(made with my mouth|with my mouth|my own voice|mouth sound|built[- ]in mic|'
    r'phone mic|iphone mic|laptop mic|8[- ]bit|sfxr|bfxr|chip[- ]?tune)\b', re.I
)
BAD_DESC_ORGANIC_RE = re.compile(
    r'\b(synthesized|synthesizer|serum|massive|sylenth|vital|vst|ableton operator)\b', re.I
)
GOOD_DESC_RE = re.compile(
    r'\b(zoom h[124568]|sound devices|sennheiser|mkh\d*|rode|neumann|tascam|sony pcm|'
    r'schoeps|akg|shure|foley|field recording|condenser|shotgun mic|close[- ]mic)\b', re.I
)
GOOD_HITECH_RE = re.compile(
    r'\b(hitech|hi[- ]?tech|hud|telemetry|ui|interface|precision|micro|readout|scanner|clean)\b', re.I
)


def is_hitech_query(query: str) -> bool:
    """判断检索词是否属于高科技 UI / 镭射脉冲 / 数字界面类（此类检索放行并加分 electronic/hitech/laser 标签）。"""
    return bool(_HITECH_QUERY_RE.search(str(query or '')))


def desc_signal(desc: str, tags=(), *, allow_hitech: bool = False) -> float:
    """上传者描述与标签信号：< 0 表示拒绝（嘴模/劣质麦/禁标；自然拟音额外禁合成器），> 0 表示专业实录或精密科技加分。"""
    tset = {str(t).lower() for t in (tags or ())}
    bad_set = ALWAYS_BAD_TAGS if allow_hitech else BAD_TAGS
    if tset & bad_set:
        return -50.0
    text = str(desc or '')
    if BAD_DESC_ALWAYS_RE.search(text):
        return -50.0
    if not allow_hitech and BAD_DESC_ORGANIC_RE.search(text):
        return -50.0
    hits = len(GOOD_DESC_RE.findall(text))
    if allow_hitech:
        hits += len(GOOD_HITECH_RE.findall(text + ' ' + ' '.join(tset)))
    return min(12.0, hits * 4.5)


def human_score(item: dict, *, query: str = '') -> float:
    """在相关性召回池内按人类反馈（下载量 + 贝叶斯加权评分人数 + 描述信号 + 原始采样率/位深质量）打分。
    物理本体守卫：检索无源纯机械物件（圆珠笔、钟表、棘轮、弹簧等）且未点名电机时，一票否决混入电机/伺服嗡鸣的素材。"""
    q_str = str(query or '')
    if _PASSIVE_MECH_QUERY_RE.search(q_str) and not _MOTOR_QUERY_RE.search(q_str):
        hay = f"{item.get('name', '')} {item.get('description', '')} {' '.join(str(t) for t in (item.get('tags') or ()))}"
        if _MOTOR_POLLUTION_RE.search(hay):
            return -45.0
    sig = desc_signal(item.get('description', ''), item.get('tags', ()), allow_hitech=is_hitech_query(q_str))
    if sig < 0:
        return sig
    sr = int(item.get('samplerate') or 48000)
    if sr < 24000:
        return -30.0
    sr_pts = -8.0 if sr < 44100 else (1.5 if sr >= 48000 else 0.0)
    bd = int(item.get('bitdepth') or 16)
    fmt = str(item.get('type') or '').lower()
    fmt_pts = (2.5 if fmt in ('wav', 'flac', 'aiff', 'aif') else 0.0) + (1.5 if bd >= 24 else 0.0)
    dl = max(0, int(item.get('num_downloads') or 0))
    rating = float(item.get('avg_rating') or 0.0)
    votes = max(0, int(item.get('num_ratings') or 0))
    dl_pts = math.log10(dl + 1) * 8.0
    # 投票人数越多越可信：★4.4(380) >> ★5.0(2)
    vote_pts = max(0.0, rating - 3.0) * math.log1p(votes) * 4.0
    return round(dl_pts + vote_pts + sig + sr_pts + fmt_pts, 2)


def curl(url, token=None, out=None):
    cfg = f'header = "Authorization: Token {token}"\n' if token else 'header = "User-Agent: Mozilla/5.0"\n'
    cmd = ['curl', '-fsSL', '--retry', '2', '--max-time', '60', '-K', '-', url] + (['-o', str(out)] if out else [])
    r = subprocess.run(cmd, input=cfg, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f'curl 失败（{r.returncode}）：{url}\n{r.stderr.strip()}')
    return r.stdout


def _probe_with_judge(cands: list, query: str, top_n: int) -> list:
    """下载候选 HQ 预览并经 Stage 1 sfx_judge 做零训练物理形态与录音取证过滤。"""
    if not cands:
        return []
    import tempfile
    sys.path.insert(0, str(ROOT))
    from engine.audio import sfx_judge as SJ
    arch = SJ.infer_archetype(query)
    with tempfile.TemporaryDirectory(prefix='beiming-sfx-probe-') as td:
        tdir = Path(td)
        kept = []
        for r in cands:
            prev = r.get('previews') or {}
            p_url = prev.get('preview-hq-ogg') or prev.get('preview-hq-mp3')
            if not p_url:
                continue
            ext = '.ogg' if p_url.endswith('.ogg') else '.mp3'
            fp = tdir / f"{r['id']}{ext}"
            try:
                curl(p_url, out=fp)
                jg = SJ.judge_file(str(fp), archetype=arch)
                r['_judge'] = jg
                if not jg['ok']:
                    continue
                r['_human_score'] = round(r['_human_score'] + 0.25 * (jg['score'] - 70.0), 2)
                kept.append(r)
            except Exception:
                continue
        kept.sort(key=lambda x: x['_human_score'], reverse=True)
        return kept[:top_n]


def parse_public_search_html(page: str, d_lo=0.04, d_hi=30.0) -> list:
    """从 Freesound 公开 CC0 搜索页 HTML 解析候选元数据（免 API Token 兜底通道）。"""
    def _attr(blk, name):
        m = re.search(rf'{name}="([^"]*)"', blk)
        return html_lib.unescape(m.group(1)) if m else ''

    items = []
    for blk, tag_blk in _BW_PLAYER_RE.findall(page or ''):
        sid = _attr(blk, 'data-sound-id')
        ogg_lq = _attr(blk, 'data-ogg')
        mp3_lq = _attr(blk, 'data-mp3')
        if not sid or not (ogg_lq or mp3_lq):
            continue
        dur = float(_attr(blk, 'data-duration') or 0.0)
        sr = int(float(_attr(blk, 'data-samplerate') or 48000))
        if dur < d_lo or dur > d_hi or sr < 24000:
            continue
        title = _attr(blk, 'data-title')
        user = _attr(blk, 'data-username')
        tags = [urllib.parse.unquote(t) for t in _TAG_HREF_RE.findall(tag_blk or '')]
        ext_m = re.search(r'\.(wav|flac|aiff|aif|ogg|mp3)$', title, re.I)
        prev = {}
        if ogg_lq:
            prev['preview-hq-ogg'] = re.sub(r'-lq\.ogg$', '-hq.ogg', ogg_lq)
        if mp3_lq:
            prev['preview-hq-mp3'] = re.sub(r'-lq\.mp3$', '-hq.mp3', mp3_lq)
        items.append({
            'id': int(sid),
            'name': title,
            'username': user,
            'duration': dur,
            'samplerate': sr,
            'bitdepth': 24 if sr >= 48000 else 16,
            'type': ext_m.group(1).lower() if ext_m else 'wav',
            'num_downloads': 0,
            'avg_rating': 0.0,
            'num_ratings': 0,
            'tags': tags,
            'description': title + ' ' + ' '.join(tags),
            'previews': prev,
            'license': CC0,
        })
    return items


def search_public_cc0(query: str, d_lo=0.04, d_hi=30.0, top_n=8, probe_audio=False) -> list:
    """免 Token 公开 CC0 检索：合并相关性优先与下载量优先两路召回，经描述禁词过滤与可选 sfx_judge 物理实测重排。"""
    seen = {}
    for rank_bias, sort_mode in ((14.0, ''), (10.0, 'Downloads (most first)')):
        params = {'q': query, 'f': 'license:"Creative Commons 0"'}
        if sort_mode:
            params['s'] = sort_mode
        page = curl('https://freesound.org/search/?' + urllib.parse.urlencode(params))
        for idx, it in enumerate(parse_public_search_html(page, d_lo=d_lo, d_hi=d_hi)):
            sc = human_score(it, query=query)
            if sc < 0:
                continue
            pos_pts = max(0.0, rank_bias - idx * 0.75)
            tot = round(sc + pos_pts, 2)
            prev = seen.get(it['id'])
            if prev is None or tot > prev['_human_score']:
                it['_human_score'] = tot
                seen[it['id']] = it
    ranked = sorted(seen.values(), key=lambda x: x['_human_score'], reverse=True)
    cands = ranked[:max(top_n, 12) if probe_audio else top_n]
    return _probe_with_judge(cands, query, top_n) if (probe_audio and cands) else cands[:top_n]


def fetch_public_sound_meta(sid: int) -> dict:
    """免 Token 单条声音页元数据解析（强制核验页面 CC0 许可链接，提取 HQ 预览地址）。"""
    page = curl(f'https://freesound.org/s/{int(sid)}/')
    if 'creativecommons.org/publicdomain/zero/1.0' not in page:
        raise ValueError(f'Freesound {sid} 公开页未检出 CC0 许可，拒绝下载')
    items = parse_public_search_html(page, d_lo=0.0, d_hi=3600.0)
    for it in items:
        if it['id'] == int(sid):
            return it
    ogg_m = re.search(r'https://cdn\.freesound\.org/previews/\d+/' + str(int(sid)) + r'_[^\s"\']+-(?:lq|hq)\.ogg', page)
    mp3_m = re.search(r'https://cdn\.freesound\.org/previews/\d+/' + str(int(sid)) + r'_[^\s"\']+-(?:lq|hq)\.mp3', page)
    if not ogg_m and not mp3_m:
        raise RuntimeError(f'Freesound {sid} 页面未找到可下载的预览音频流')
    prev = {}
    if ogg_m:
        prev['preview-hq-ogg'] = re.sub(r'-lq\.ogg$', '-hq.ogg', ogg_m.group(0))
    if mp3_m:
        prev['preview-hq-mp3'] = re.sub(r'-lq\.mp3$', '-hq.mp3', mp3_m.group(0))
    title_m = re.search(r'<title>([^<]+)</title>', page)
    return {
        'id': int(sid),
        'name': html_lib.unescape(title_m.group(1)).strip() if title_m else str(sid),
        'username': 'freesound-cc0',
        'previews': prev,
        'license': CC0,
    }


def search_pool(query: str, token: str = None, d_lo=0.04, d_hi=30.0, pool_size=45, top_n=8, probe_audio=False):
    """按相关性抓取 pool_size 条 CC0 候选，再用 human_score（及可选下载后 sfx_judge 声学形态复核）重排；无 Token 时自动走公开 CC0 检索。"""
    if not token:
        return search_public_cc0(query, d_lo=d_lo, d_hi=d_hi, top_n=top_n, probe_audio=probe_audio)
    params = {
        'query': query,
        'filter': f'license:"Creative Commons 0" duration:[{d_lo} TO {d_hi}]',
        'sort': 'score',
        'fields': 'id,name,username,duration,samplerate,bitdepth,type,num_downloads,avg_rating,num_ratings,tags,description,previews,license',
        'page_size': min(150, pool_size),
    }
    data = json.loads(curl('https://freesound.org/apiv2/search/text/?' + urllib.parse.urlencode(params), token))
    ranked = []
    for r in data.get('results', []):
        sc = human_score(r, query=query)
        if sc < 0:
            continue
        r['_human_score'] = sc
        ranked.append(r)
    ranked.sort(key=lambda x: x['_human_score'], reverse=True)
    cands = ranked[:max(top_n, 12) if probe_audio else top_n]
    return _probe_with_judge(cands, query, top_n) if (probe_audio and cands) else cands[:top_n]


def download_many(items, out_dir: Path, token: str, workers=6, verify=True):
    """6 线程并发下载（优先 HQ OGG/MP3 预览，带临时文件原子替换、CC0 校验与 Stage 1 物理形态筛查）。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT))
    try:
        from engine.audio import sfx_judge as SJ
    except Exception:
        SJ = None

    def _audit_suffix(name, m, dest):
        if not verify or SJ is None:
            return ''
        spec = m if isinstance(m, dict) else None
        arch = (spec.get('archetype') if spec else None) or SJ.infer_archetype(name)
        jg = SJ.judge_file(str(dest), archetype=arch, spec=spec)
        tag = f" [judge:{jg['status']} {jg['score']:.0f}]"
        if jg['reasons']:
            tag += f" ({'; '.join(jg['reasons'][:2])})"
        return tag

    def one(pair):
        name, m = pair
        sid = m['id'] if isinstance(m, dict) else int(m)
        existing = sorted(out_dir.glob(f'{sid}.*'))
        existing = [p for p in existing if not p.name.endswith('.part') and p.stat().st_size > 2000]
        if existing:
            return f'skip {name:12} {sid}{_audit_suffix(name, m, existing[0])}'
        if isinstance(m, dict) and 'previews' in m and 'license' in m:
            meta = m
        elif token:
            meta = json.loads(curl(f'https://freesound.org/apiv2/sounds/{sid}/?fields=license,previews,username,name', token))
        else:
            meta = fetch_public_sound_meta(sid)
        if meta.get('license') != CC0:
            raise ValueError(f"{name}: Freesound {sid} 不是 CC0（{meta.get('license')}），拒绝下载")
        prev = meta.get('previews') or {}
        url = prev.get('preview-hq-ogg') or prev.get('preview-hq-mp3')
        ext = '.ogg' if (url and url.endswith('.ogg')) else '.mp3'
        dest = out_dir / f'{sid}{ext}'
        tmp = out_dir / f'{sid}{ext}.part'
        curl(url, out=tmp)
        tmp.replace(dest)
        return f"ok   {name:12} {sid}  {meta.get('username', '?')}: {meta.get('name', '')}{_audit_suffix(name, m, dest)}"

    with ThreadPoolExecutor(workers) as ex:
        for msg in ex.map(one, items):
            print(msg)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--search', help='按相关性池 + 人类反馈 + 描述过滤搜索关键词')
    ap.add_argument('--probe-audio', action='store_true', help='搜索时下载预览并用 sfx_judge 做物理形态实测过滤')
    ap.add_argument('--min-dur', type=float, default=0.04)
    ap.add_argument('--max-dur', type=float, default=30.0)
    ap.add_argument('-n', type=int, default=8)
    args = ap.parse_args()

    token = os.environ.get('FREESOUND_TOKEN')
    if args.search:
        for r in search_pool(args.search, token, args.min_dur, args.max_dur, top_n=args.n, probe_audio=args.probe_audio):
            desc = re.sub(r'\s+', ' ', r.get('description', '')).strip()[:75]
            jg = r.get('_judge')
            j_str = f" judge={jg['score']:.0f}({jg['archetype']})" if jg else ''
            print(f"fs:{r['id']:<7d} score={r['_human_score']:5.1f}{j_str}  {r['duration']:5.2f}s  "
                  f"↓{r.get('num_downloads', 0):<5d} ★{r.get('avg_rating', 0):.1f}({r.get('num_ratings', 0)})  "
                  f"{r['name'][:34]:34s} | {desc}")
        return

    sounds = json.loads((ROOT / 'audio/sfx_manifest.json').read_text(encoding='utf-8'))['sounds']
    download_many(list(sounds.items()), ROOT / 'audio/samples/sfx', token)


if __name__ == '__main__':
    main()
