# grey zoom with pixel grid: gz.py x0 y0 x1 y1 scale plate out
import sys
from PIL import Image, ImageDraw
import numpy as np
x0,y0,x1,y1=[int(v) for v in sys.argv[1:5]]; s=float(sys.argv[5]); f=sys.argv[6]; out=sys.argv[7]
im=np.asarray(Image.open(f).convert("RGB")).astype(np.float32)[y0:y1,x0:x1]
g=im[...,0]*0.5+im[...,1]*0.5
lo,hi=np.percentile(g,[1,99.7]); g=np.clip((g-lo)/(hi-lo),0,1)**0.9*255
W,H=int((x1-x0)*s),int((y1-y0)*s)
o=Image.fromarray(g.astype(np.uint8)).resize((W,H)).convert('RGB'); d=ImageDraw.Draw(o)
st=50 if (x1-x0)>300 else 25
for y in range((y0//st+1)*st,y1,st):
    d.line([(0,(y-y0)*s),(W,(y-y0)*s)],fill=(255,40,40) if y%100==0 else (120,30,30))
    d.text((4,(y-y0)*s+2),str(y),fill=(255,90,90))
for x in range((x0//st+1)*st,x1,st):
    d.line([((x-x0)*s,0),((x-x0)*s,H)],fill=(255,40,40) if x%100==0 else (120,30,30))
    d.text(((x-x0)*s+2,4),str(x),fill=(255,90,90))
o.save(out,quality=88)
