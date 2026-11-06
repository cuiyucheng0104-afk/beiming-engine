import sys
from PIL import Image, ImageDraw, ImageFont
f = ImageFont.truetype('/System/Library/Fonts/STHeiti Medium.ttc', 20)
ids, out = sys.argv[2].split(","), sys.argv[1]
SEEDS = tuple(int(x) for x in (sys.argv[3] if len(sys.argv) > 3 else "1,2").split(","))
W, H = 420, 240
o = Image.new('RGB', (W * 2 + 8, (H + 6) * len(ids)), 'white')
for r, sid in enumerate(ids):
    for c, sd in enumerate(SEEDS):
        t = Image.open(f'out/kf/{sid}_s{sd}.png').convert('RGB').resize((W, H))
        d = ImageDraw.Draw(t); d.rectangle([0, 0, 90, 26], fill='black'); d.text((4, 2), f'{sid}_{sd}', fill='yellow', font=f)
        o.paste(t, (c * (W + 8), r * (H + 6)))
o.save(out)
