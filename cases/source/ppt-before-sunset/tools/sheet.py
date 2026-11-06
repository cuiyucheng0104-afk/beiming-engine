import sys, glob
from PIL import Image
fs = sorted(glob.glob(sys.argv[1] + '/check_*.jpg'))
ims = [Image.open(f).resize((960, 540)) for f in fs]
S = Image.new('RGB', (1920, 540 * ((len(ims) + 1) // 2)))
for i, im in enumerate(ims): S.paste(im, ((i % 2) * 960, (i // 2) * 540))
S.save(sys.argv[2], quality=85); print(len(ims))
