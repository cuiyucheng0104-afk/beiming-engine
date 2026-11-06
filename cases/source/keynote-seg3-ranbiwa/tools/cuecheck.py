"""画面事件 ↔ 声音起音 对拍检查。
画面：从成片逐帧（30 fps，缩到 192×108 灰度）找每个事件附近亮度上升最大 / 变化最大的那一帧 → 画面事件时刻。
声音：mix.py 写的 out/cues.json（每条卡点声音在自己分轨上的实测起音）。
用法：python cuecheck.py <video.mp4>"""
import sys, os, json, subprocess
import numpy as np
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
vid = sys.argv[1]
W, H, FPS = 192, 108, 30
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', vid, '-vf', f'scale={W}:{H},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
F = np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)
lum = F.mean(axis=(1, 2)); dl = np.diff(lum, prepend=lum[0]); md = np.abs(np.diff(F, axis=0, prepend=F[:1])).mean(axis=(1, 2))
ev = json.load(open(os.path.join(HERE, 'events.json')))['ev']
cues = json.load(open(os.path.join(HERE, 'out', 'cues.json')))
def onset(name, t):
    c = [x for x in cues if x['name'] == name and abs(x['plan'] - t) < .02]
    return c[0]['onset'] if c else None
# (事件类型, 画面判据, 对应声音名)
CHECK = [('snuff', 'down', 'snuff'), ('layer', 'up', 'layer_chime'), ('window_big', 'up', 'bell'), ('window_small', 'up', 'win_small'),
         ('slip', 'diff', 'slip_wood'), ('forest', 'up', 'forest_chime'), ('glyph_title', 'up', 'lls_glyph'), ('burst', 'up', 'burst_drum'),
         ('lamp_on', 'up', 'lamp_click'), ('leaf_land', 'diff', 'leaf_land'), ('door', 'diff', 'door_pop'), ('silence', 'down', None)]
rows = []
for typ, how, snd in CHECK:
    for e in [x for x in ev if x['type'] == typ]:
        t = e['t']; f0 = int(np.floor(t * FPS)); lo, hi = max(1, f0 - 2), min(len(F) - 1, f0 + 3)
        if how == 'up': f = lo + int(np.argmax(dl[lo:hi + 1]))
        elif how == 'down': f = lo + int(np.argmin(dl[lo:hi + 1]))
        else:
            # 动作落定：动作在拍前进行，拍后迅速停下 → 取拍附近"变化量骤减"之前的最后一帧
            seg = md[lo:hi + 1]; f = lo + int(np.argmax(-np.diff(seg, append=seg[-1])))
        tv = f / FPS
        a = onset(snd, t) if snd else None
        rows.append({'event': typ, 'beat_t': round(t, 4), 'frame': f, 'visual_t': round(tv, 4), 'audio_onset': a,
                     'visual_minus_beat_ms': round((tv - t) * 1000, 1), 'audio_minus_beat_ms': None if a is None else round((a - t) * 1000, 2)})
bad = [r for r in rows if abs(r['visual_minus_beat_ms']) > 34 or (r['audio_minus_beat_ms'] is not None and abs(r['audio_minus_beat_ms']) > 1)]
for r in rows: print(r)
print('CHECKED', len(rows), 'OUT_OF_TOL', len(bad))
json.dump(rows, open(os.path.join(HERE, 'out', 'cuecheck.json'), 'w'), ensure_ascii=False, indent=1)
