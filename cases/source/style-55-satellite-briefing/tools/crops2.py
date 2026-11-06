import sys
from PIL import Image, ImageDraw
import numpy as np
x0,y0,x1,y1=[int(v) for v in sys.argv[1:5]]; out=sys.argv[5]; fs=sys.argv[6:]
tiles=[]
for f in fs:
    im=np.asarray(Image.open(f).convert("RGB")).astype(np.float32)[y0:y1,x0:x1]
    lo,hi=np.percentile(im,[1,99.7]); im=np.clip((im-lo)/(hi-lo),0,1)**0.7*255
    o=Image.fromarray(im.astype(np.uint8)); d=ImageDraw.Draw(o)
    for y in range((y0//50+1)*50,y1,50): d.line([(0,y-y0),(10 if y%100 else 22,y-y0)],fill=(255,40,40)); d.text((24,y-y0-5),str(y),fill=(255,60,60)) if y%100==0 else None
    for x in range((x0//50+1)*50,x1,50): d.line([(x-x0,0),(x-x0,10 if x%100 else 22)],fill=(255,40,40)); d.text((x-x0+2,24),str(x),fill=(255,60,60)) if x%100==0 else None
    d.text((8,y1-y0-16),f.split("_")[3],fill=(255,255,0)); tiles.append(o)
W=sum(t.width for t in tiles)+8*(len(tiles)-1); S=Image.new("RGB",(W,tiles[0].height),(20,20,20)); x=0
for t in tiles: S.paste(t,(x,0)); x+=t.width+8
S.save(out,quality=88)
