"""字幕区间 → out/cues.json（与 story.js 的 SUBS 规则一致：max(1.8, 汉字数 ÷ 4.5 + 1.5) s，截到下一句前 0.3 s）"""
import json, os, re
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(D, 'story.js'), encoding='utf-8').read()
sub = re.findall(r"\{ t: ([\d.]+), text: '([^']+)' \}", src)
dive0 = float(re.search(r'dive: \[([\d.]+)', src).group(1))
hz = lambda s: len(re.findall(r'[一-鿿]', s))
cues = []
for i, (t, text) in enumerate(sub):
    t = float(t); t1 = t + max(1.8, hz(text) / 4.5 + 1.5)
    t1 = min(t1, float(sub[i + 1][0]) - .3) if i + 1 < len(sub) else min(t1, dive0 - .1)
    cues.append(dict(t0=t, t1=round(t1, 2), text=text))
os.makedirs(os.path.join(D, 'out'), exist_ok=True)
json.dump(cues, open(os.path.join(D, 'out', 'cues.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(cues), 'cues')
