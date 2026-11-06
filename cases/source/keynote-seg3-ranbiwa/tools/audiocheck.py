"""音频自检：响度、真峰值、静默拍、燃比娃那一下比其余最响处高多少（瞬时响度 400 ms）"""
import sys, subprocess, re, json, os
f = sys.argv[1]; HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ev = json.load(open(os.path.join(HERE, 'events.json')))['ev']; tB = [e['t'] for e in ev if e['type'] == 'burst'][0]; tS = [e['t'] for e in ev if e['type'] == 'silence'][0]
o = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', f, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
M = [(float(a), float(b)) for a, b in re.findall(r't:\s*([0-9.]+)\s+TARGET.*?M:\s*(-?[0-9.]+|-inf)', o) if b != '-inf']
I = re.findall(r'I:\s+(-?[0-9.]+) LUFS', o)[-1]; TP = re.findall(r'Peak:\s+(-?[0-9.]+) dBFS', o)[-1]
burst = max(m for t, m in M if tB + .1 <= t <= tB + 1.0)
rest = max(m for t, m in M if not (tB - .05 <= t <= tB + 2.5))
o2 = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-ss', str(tS + .01), '-t', str(tB - tS - .02), '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True).stderr
mv = re.findall(r'max_volume:\s*(-?[0-9.inf]+)', o2)
print(json.dumps({'I_LUFS': float(I), 'truepeak_dBTP': float(TP), 'burst_M': burst, 'rest_max_M': rest, 'burst_minus_rest_dB': round(burst - rest, 1), 'silence_max_dB': mv[0] if mv else None}, ensure_ascii=False))
