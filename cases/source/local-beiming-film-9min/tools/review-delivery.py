"""Extract from the encoded movie (not the live scene) for visual review."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json,subprocess
from PIL import Image,ImageDraw,ImageFont
R=Path(__file__).resolve().parents[1];D=R/'delivery';Q=D/'qa';S=Q/'stills';S.mkdir(parents=True,exist_ok=True)
rows=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import{SHOTS}from'./src/storyboard.js';console.log(JSON.stringify(SHOTS));"],cwd=R,text=True))
def frame(row):
 t=row['start']+(row['end']-row['start'])*.55;f=S/(row['id']+'.jpg')
 subprocess.run(['ffmpeg','-v','error','-nostdin','-y','-ss',str(t),'-i',str(D/'beiming_9min_1080.mp4'),'-frames:v','1','-q:v','2',str(f)],check=True)
 return row,f,t
with ThreadPoolExecutor(max_workers=3) as pool:shots=list(pool.map(frame,rows))
font=ImageFont.load_default()
for p in ['/System/Library/Fonts/Supplemental/Arial.ttf','C:/Windows/Fonts/arial.ttf']:
 if Path(p).exists():font=ImageFont.truetype(p,18);break
for start in range(0,len(shots),20):
 batch=shots[start:start+20];canvas=Image.new('RGB',(1920,290*((len(batch)+3)//4)),(21,24,43));draw=ImageDraw.Draw(canvas)
 for j,(r,f,t) in enumerate(batch):
  im=Image.open(f);im.thumbnail((472,256));x=j%4*480+4;y=j//4*290;canvas.paste(im,(x,y));draw.text((x+5,y+260),f"{r['id']}  {t:06.2f}s  {r['kind']}",font=font,fill=(239,222,206))
 canvas.save(Q/f'film-sheet-{start//20+1}.jpg',quality=92)
subprocess.run(['ffmpeg','-v','error','-nostdin','-y','-ss','75','-i',str(D/'beiming_9min_1080.mp4'),'-frames:v','1','-q:v','2',str(D/'poster.jpg')],check=True)
print('84 encoded-film frames and 5 sheets exported.')
