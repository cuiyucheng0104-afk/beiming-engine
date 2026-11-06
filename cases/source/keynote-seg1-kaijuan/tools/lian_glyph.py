# 「宝莲灯」的「莲」：Ma Shan Zheng 的 U+83B2 是繁体写法（車旁）。用同一字体的「草」字头 + 「连」拼出简体「莲」，输出白文印用的 alpha 字形。
# 运行：$LIB/.venv/bin/python tools/lian_glyph.py fonts/lian.png   （只需在改字形时运行一次，build.sh 不调用）
from PIL import Image, ImageDraw, ImageFont
import numpy as np, sys
import os; F=os.environ.get('LIB',os.path.expanduser('~/lemo-opuscar'))+'/styles/shadow-puppet/demo/fonts/MaShanZheng-Regular.ttf'
S=600; f=ImageFont.truetype(F,400)
def g(c):
  im=Image.new('L',(S,S),0); ImageDraw.Draw(im).text((300,300),c,font=f,fill=255,anchor='mm'); return im
cao=g('草').crop((150,118,450,229))     # 艹
lian=g('连').crop((115,136,483,486))
out=Image.new('L',(S,S),0)
tx0,ty0,tx1,ty1=117,126,481,494
# 艹：宽度略收，居中偏右（让出辶的点位）
cw=int(300*.92); ch=int(111*.84)
c2=cao.resize((cw,ch),Image.LANCZOS); out.paste(c2,( (tx0+tx1)//2-cw//2+14, ty0),c2)
lh=ty1-(ty0+ch-4); l2=lian.resize((tx1-tx0+4,lh),Image.LANCZOS)
out.paste(l2,(tx0-2,ty0+ch-4),l2)
a=np.array(out); Image.fromarray(np.dstack([np.zeros_like(a)]*3+[a]).astype(np.uint8),"RGBA").save(sys.argv[1])
# 预览：和原字并排



