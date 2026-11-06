import sys,glob,os
from PIL import Image, ImageDraw
import numpy as np
fs=sorted(glob.glob("material/plates/*.png"),key=lambda f:f.split("_")[3])
os.makedirs("frames/crops",exist_ok=True)
for f in fs:
    im=np.asarray(Image.open(f).convert("RGB")).astype(np.float32)
    H,W=im.shape[:2]
    c=im[250:1450,550:1450]
    g=c.mean(2); lo,hi=np.percentile(g,[2,99.5]); g=np.clip((g-lo)/(hi-lo),0,1)**0.8*255
    o=Image.fromarray(g.astype(np.uint8)).convert("RGB"); d=ImageDraw.Draw(o)
    for y in range(0,1200,100): d.line([(0,y),(12,y)],fill=(255,0,0)); d.text((14,y-5),str(y+250),fill=(255,0,0))
    for x in range(0,900,100): d.line([(x,0),(x,12)],fill=(255,0,0)); d.text((x+2,14),str(x+550),fill=(255,0,0))
    o.save("frames/crops/"+f.split("_")[3]+".jpg",quality=85)
print(W,H)
