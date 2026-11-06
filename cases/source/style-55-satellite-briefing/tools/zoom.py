import sys
from PIL import Image, ImageDraw
import numpy as np
x0,y0,x1,y1,s=[int(v) for v in sys.argv[1:6]]; f=sys.argv[6]; out=sys.argv[7]
im=np.asarray(Image.open(f).convert("RGB")).astype(np.float32)[y0:y1,x0:x1]
lo,hi=np.percentile(im,[1,99.7]); im=np.clip((im-lo)/(hi-lo),0,1)**0.75*255
o=Image.fromarray(im.astype(np.uint8)).resize(((x1-x0)*s,(y1-y0)*s),Image.NEAREST); d=ImageDraw.Draw(o)
for y in range((y0//10+1)*10,y1,10):
    L=24 if y%50==0 else 8; d.line([(0,(y-y0)*s),(L,(y-y0)*s)],fill=(255,40,40))
    if y%50==0: d.text((26,(y-y0)*s-5),str(y),fill=(255,80,80))
for x in range((x0//10+1)*10,x1,10):
    L=24 if x%50==0 else 8; d.line([((x-x0)*s,0),((x-x0)*s,L)],fill=(255,40,40))
    if x%50==0: d.text(((x-x0)*s+2,26),str(x),fill=(255,80,80))
o.save(out,quality=88)
