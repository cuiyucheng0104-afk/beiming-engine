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

BAD_TAGS = {
    'synth', 'synthesizer', 'electronic', '8bit', '8-bit', 'chiptune', 'retro', 'arcade',
    'sci-fi', 'scifi', 'laser', 'robot', 'alien', 'cyberpunk', 'futuristic', 'digital',
    'music', 'loop', 'melody', 'chord', 'song', 'singing', 'voice', 'vocal', 'speech',
    'dubstep', 'edm', 'techno', 'house', 'trance', 'riser', 'trailer', 'nes', 'bit',
    'gore', 'flesh', 'blood', 'fart', 'flatulant', 'burp', 'belch', 'cartoon', 'comedy'
}

BAD_DESC_RE = re.compile(
    r'\b(made with my mouth|with my mouth|my own voice|mouth sound|built[- ]in mic|'
    r'phone mic|iphone mic|laptop mic|synthesized|synthesizer|serum|massive|sylenth|'
    r'vital|vst|ableton operator|8[- ]bit|sfxr|bfxr|chip[- ]?tune)\b', re.I
)
GOOD_DESC_RE = re.compile(
    r'\b(zoom h[124568]|sound devices|sennheiser|mkh\d*|rode|neumann|tascam|sony pcm|'
    r'schoeps|akg|shure|foley|field recording|condenser|shotgun mic|close[- ]mic)\b', re.I
)


def desc_signal(desc: str, tags=()) -> float:
    """上传者描述与标签信号：< 0 表示拒绝（嘴模/合成器/劣质麦/禁标），> 0 表示专业实录加分。"""
    tset = {str(t).lower() for t in (tags or ())}
    if tset & BAD_TAGS:
        return -50.0
    text = str(desc or '')
    if BAD_DESC_RE.search(text):
        return -50.0
    hits = len(GOOD_DESC_RE.findall(text))
    return min(12.0, hits * 4.5)


def human_score(item: dict) -> float:
    """在相关性召回池内按人类反馈（下载量 + 贝叶斯加权评分人数 + 录音描述信号）打分。"""
    sig = desc_signal(item.get('description', ''), item.get('tags', ()))
    if sig < 0:
        return sig
    dl = max(0, int(item.get('num_downloads') or 0))
    rating = float(item.get('avg_rating') or 0.0)
    votes = max(0, int(item.get('num_ratings') or 0))
    dl_pts = math.log10(dl + 1) * 8.0
    # 投票人数越多越可信：★4.4(380) >> ★5.0(2)
    vote_pts = max(0.0, rating - 3.0) * math.log1p(votes) * 4.0
    return round(dl_pts + vote_pts + sig, 2)


def curl(url, token=None, out=None):
    cfg = f'header = "Authorization: Token {token}"\n' if token else ''
    cmd = ['curl', '-fsSL', '--retry', '2', '--max-time', '60', '-K', '-', url] + (['-o', str(out)] if out else [])
    r = subprocess.run(cmd, input=cfg, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f'curl 失败（{r.returncode}）：{url}\n{r.stderr.strip()}')
    return r.stdout


def search_pool(query: str, token: str, d_lo=0.04, d_hi=30.0, pool_size=45, top_n=8):
    """按相关性抓取 pool_size 条 CC0 候选，再用 human_score 重排。"""
    params = {
        'query': query,
        'filter': f'license:"Creative Commons 0" duration:[{d_lo} TO {d_hi}]',
        'sort': 'score',
        'fields': 'id,name,username,duration,num_downloads,avg_rating,num_ratings,tags,description,previews,license',
        'page_size': min(150, pool_size),
    }
    data = json.loads(curl('https://freesound.org/apiv2/search/text/?' + urllib.parse.urlencode(params), token))
    ranked = []
    for r in data.get('results', []):
        sc = human_score(r)
        if sc < 0:
            continue
        r['_human_score'] = sc
        ranked.append(r)
    ranked.sort(key=lambda x: x['_human_score'], reverse=True)
    return ranked[:top_n]


def download_many(items, out_dir: Path, token: str, workers=6):
    """6 线程并发下载（带临时文件原子替换与 CC0 校验）。items: [(name, id_or_dict), ...]"""
    out_dir.mkdir(parents=True, exist_ok=True)

    def one(pair):
        name, m = pair
        sid = m['id'] if isinstance(m, dict) else int(m)
        dest = out_dir / f'{sid}.mp3'
        if dest.exists() and dest.stat().st_size > 2000:
            return f'skip {name:12} {sid}'
        meta = m if (isinstance(m, dict) and 'previews' in m and 'license' in m) else json.loads(
            curl(f'https://freesound.org/apiv2/sounds/{sid}/?fields=license,previews,username,name', token)
        )
        if meta.get('license') != CC0:
            raise ValueError(f"{name}: Freesound {sid} 不是 CC0（{meta.get('license')}），拒绝下载")
        tmp = out_dir / f'{sid}.mp3.part'
        curl(meta['previews']['preview-hq-mp3'], out=tmp)
        tmp.replace(dest)
        return f"ok   {name:12} {sid}  {meta.get('username', '?')}: {meta.get('name', '')}"

    with ThreadPoolExecutor(workers) as ex:
        for msg in ex.map(one, items):
            print(msg)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--search', help='按相关性池 + 人类反馈 + 描述过滤搜索关键词')
    ap.add_argument('--min-dur', type=float, default=0.04)
    ap.add_argument('--max-dur', type=float, default=30.0)
    ap.add_argument('-n', type=int, default=8)
    args = ap.parse_args()

    token = os.environ.get('FREESOUND_TOKEN') or sys.exit('需要环境变量 FREESOUND_TOKEN（Freesound API Key）')
    if args.search:
        for r in search_pool(args.search, token, args.min_dur, args.max_dur, top_n=args.n):
            desc = re.sub(r'\s+', ' ', r.get('description', '')).strip()[:85]
            print(f"fs:{r['id']:<7d} score={r['_human_score']:5.1f}  {r['duration']:5.2f}s  "
                  f"↓{r.get('num_downloads', 0):<5d} ★{r.get('avg_rating', 0):.1f}({r.get('num_ratings', 0)})  "
                  f"{r['name'][:36]:36s} | {desc}")
        return

    sounds = json.loads((ROOT / 'audio/sfx_manifest.json').read_text(encoding='utf-8'))['sounds']
    download_many(list(sounds.items()), ROOT / 'audio/samples/sfx', token)


if __name__ == '__main__':
    main()
