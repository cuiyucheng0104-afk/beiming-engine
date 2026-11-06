import sys
from PIL import Image, ImageDraw, ImageFont
f = ImageFont.truetype('/System/Library/Fonts/STHeiti Medium.ttc', 22)
paths, out, cols = sys.argv[2:], sys.argv[1], 2
ims = [Image.open(p).convert('RGB') for p in paths]
W = 640; H = int(W * ims[0].height / ims[0].width)
rows = (len(ims) + cols - 1) // cols
o = Image.new('RGB', (W * cols + 8 * (cols - 1), H * rows + 8 * (rows - 1)), 'white')
for i, (im, p) in enumerate(zip(ims, paths)):
    t = im.resize((W, H)); d = ImageDraw.Draw(t); lab = p.split('/')[-1].rsplit('.', 1)[0]
    d.rectangle([0, 0, 12 * len(lab) + 10, 28], fill='black'); d.text((5, 2), lab, fill='yellow', font=f)
    o.paste(t, ((i % cols) * (W + 8), (i // cols) * (H + 8)))
o.save(out); print(out, o.size, ims[0].size)
