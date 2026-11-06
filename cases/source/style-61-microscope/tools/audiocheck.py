"""Measure, in the final film's audio, the onset nearest every designed event (±60 ms window, 2 ms hop)."""
import json, sys, os, subprocess, numpy as np
D = sys.argv[1]
EV = json.load(open(os.path.join(D, 'events.json')))['ev']
raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', os.path.join(D, '61-microscope.mp4'), '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'], capture_output=True).stdout
x = np.frombuffer(raw, np.float32); SR = 48000; hop = 96
e = np.sqrt(np.convolve(x ** 2, np.ones(hop) / hop, 'same'))[::hop]
de = np.diff(np.log(e + 1e-6), prepend=0)
skip = {'stria', 'mark', 'hush', 'sweep', 'scan', 'count', 'climb', 'dive', 'breath', 'fall'}
offs = []
for ev in EV:
    if ev['type'] in skip: continue
    i = int(ev['t'] * SR / hop); w = int(.06 * SR / hop)
    j = i - w + int(np.argmax(de[i - w:i + w]))
    off = (j - i) * hop / SR * 1000; offs.append(abs(off))
    print(f"{ev['type']:10s} {ev['t']:8.3f}s  onset {off:+6.1f} ms")
print(f'max |offset| {max(offs):.1f} ms (resolution 2 ms)')
