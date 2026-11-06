from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json,sys
root=Path(__file__).resolve().parents[1]
directory=root/'out/keyframes'
meta=json.loads((directory/'index.json').read_text(encoding='utf-8'))
font_candidates=['/System/Library/Fonts/Supplemental/Arial.ttf','C:/Windows/Fonts/arial.ttf']
font=next((ImageFont.truetype(p,18) for p in font_candidates if Path(p).exists()),ImageFont.load_default())
rows=meta['results'];per=20
for part in range((len(rows)+per-1)//per):
 batch=rows[part*per:(part+1)*per];cw,ch=480,290
 sheet=Image.new('RGB',(cw*4,ch*((len(batch)+3)//4)),(23,27,51));d=ImageDraw.Draw(sheet)
 for i,r in enumerate(batch):
  im=Image.open(directory/r['file']).convert('RGB');im.thumbnail((cw-8,256));x=(i%4)*cw+4;y=(i//4)*ch
  sheet.paste(im,(x,y));d.text((x+4,y+260),f"{r['id']}  {r['t']:07.2f}s  {r['kind']}",font=font,fill=(242,226,201))
 out=root/'out'/f'sheet_{part+1:02d}.jpg';sheet.save(out,quality=91);print(out)
