#!/usr/bin/env python3
"""MiniMax 同步合成（国内站 /v1/t2a_v2）。Key 只从 ~/.config/minimax/key 读，不打印。
用法：minimax_tts.py <lines.json> <out_dir> [--voice ID] [--speed 1.0] [--only a01,a02] [--force]
lines.json: [{"id","zh"(字幕),"say"(可选读法)}]；输出 <id>.wav、<id>.json（原始响应去掉音频）、dur.json、usage.json"""
import json, sys, ssl, time, urllib.request, argparse
from pathlib import Path
ap = argparse.ArgumentParser()
ap.add_argument('lines'); ap.add_argument('out')
ap.add_argument('--voice', default='Chinese (Mandarin)_Reliable_Executive')
ap.add_argument('--speed', type=float, default=1.0); ap.add_argument('--pitch', type=int, default=0)
ap.add_argument('--emotion', default=None)
ap.add_argument('--model', default='speech-2.8-hd')
ap.add_argument('--only', default=''); ap.add_argument('--force', action='store_true')
a = ap.parse_args()
KEY = (Path.home() / '.config/minimax/key').read_text().strip()
CTX = ssl.create_default_context(cafile='/etc/ssl/cert.pem')
out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
L = json.load(open(a.lines)); L = L['lines'] if isinstance(L, dict) else L
only = set(x for x in a.only.split(',') if x)
def post(body):
    req = urllib.request.Request('https://api.minimax.cn/v1/t2a_v2', data=json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, context=CTX, timeout=180))
durp = out / 'dur.json'; dur = json.load(open(durp)) if durp.exists() else {}
usep = out / 'usage.json'; use = json.load(open(usep)) if usep.exists() else {}
for x in L:
    i = x['id']
    if only and i not in only: continue
    if (out / f'{i}.wav').exists() and not a.force: continue
    vs = {'voice_id': x.get('voice', a.voice), 'speed': x.get('speed', a.speed), 'vol': 1.0, 'pitch': x.get('pitch', a.pitch)}
    if x.get('emotion', a.emotion): vs['emotion'] = x.get('emotion', a.emotion)
    body = {'model': a.model, 'text': x.get('say', x['zh']), 'stream': False, 'voice_setting': vs,
            'audio_setting': {'sample_rate': 44100, 'format': 'wav', 'channel': 1},
            'language_boost': x.get('lang', 'Chinese'), 'subtitle_enable': True, 'subtitle_type': 'word',
            'output_format': 'hex', 'aigc_watermark': False}
    for k in range(5):
        try:
            r = post(body); st = r.get('base_resp', {}).get('status_code')
        except Exception as e:
            print(i, 'net', e); time.sleep(5 * (k + 1)); continue
        if st == 0 and (r.get('data') or {}).get('audio'): break
        print(i, 'status', st, r.get('base_resp', {}).get('status_msg'), r.get('trace_id'))
        if st in (1004, 2049, 1008, 2038, 2022, 1026, 1027, 1042, 2013, 2014): sys.exit(2)
        time.sleep(6 * (k + 1))
    else:
        sys.exit(3)
    (out / f'{i}.wav').write_bytes(bytes.fromhex(r['data']['audio']))
    r['data']['audio'] = f'<{i}.wav>'
    json.dump(r, open(out / f'{i}.json', 'w'), ensure_ascii=False, indent=1)
    ex = r.get('extra_info', {})
    dur[i] = round(ex.get('audio_length', 0) / 1000, 3); use[i] = ex.get('usage_characters')
    print(i, dur[i], 's', use[i], 'chars', r.get('trace_id'))
    json.dump(dur, open(durp, 'w'), indent=1); json.dump(use, open(usep, 'w'), indent=1)
    time.sleep(3.2)   # 20 RPM
