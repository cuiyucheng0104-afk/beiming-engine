import pathlib,json,hashlib,platform
from PIL import Image,ImageDraw,ImageFont
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parents[1];D=ROOT/'delivery';D.mkdir(exist_ok=True)
scenes=json.loads((ROOT/'scenes.json').read_text(encoding='utf-8'));presets=json.loads((D/'presets.json').read_text(encoding='utf-8'))
notes=['烛火暖色落在手、袖口与纸面；青绿暗部要托住人物，不能压掉脸部。','青铜的青黑与烛火的橙金分开；避免细碎反光把轮廓打散。','保留烟雨的灰绿层次，斗笠、肤色和衣褶是主次关系的检查点。','暖光楼阁作为视觉中心；远山逐层退后，避免所有物体同样抢眼。','白墙、人物与树荫形成层次；整体绿调中仍需保留暖肤色。','斜射暖光、青绿石壁、飞纸组成动势；留住前后景的亮度差。','仰视的暗建筑夹住亮天空；纸片与光柱需要从暗部中显出来。','山体、云海、河面分别组织色块；远景保持空气感，避免硬线铺满画面。','蓝灰暮色衬暖灯，舟船和大树构成前景剪影；水面不宜失去细层次。']
for s,n in zip(scenes,notes):s['note']=n
fonts=['C:/Windows/Fonts/msyh.ttc','/System/Library/Fonts/Hiragino Sans GB.ttc'];fontpath=next(p for p in fonts if pathlib.Path(p).exists());F=lambda sz:ImageFont.truetype(fontpath,sz)
BG='#111c20';FG='#e9e5db';GOLD='#dbc39c'

def fit(im,size):
 im=im.copy();im.thumbnail(size,Image.Resampling.LANCZOS);canvas=Image.new('RGB',size,BG);canvas.paste(im,((size[0]-im.width)//2,(size[1]-im.height)//2));return canvas
rows=[];hashes=set();gpus=set();errors=[];sceneinfo=[]
(D/'boards').mkdir(exist_ok=True)
for s in scenes:
 sid=s['id'];out=ROOT/'out/frame-renders'/sid;th=D/'thumbs'/sid;th.mkdir(parents=True,exist_ok=True)
 logs=json.loads((out/'render-log-r1.json').read_text());gpus.add(logs['gpu']);errors+=logs['errors']
 board=Image.new('RGB',(3100,3080),BG);draw=ImageDraw.Draw(board);draw.text((38,20),f"{sid} / {s['name']} · 40组画面配方",font=F(42),fill=FG)
 draw.text((38,80),'每行固定配色 · 二阶硬切 / 三阶硬切 / 三阶柔边 / 四阶叠色 / 六阶塑形',font=F(23),fill=GOLD)
 for i,p in enumerate(presets):
  file=out/(p['id']+'.png');im=Image.open(file).convert('RGB');assert im.width==2400,(sid,p['id'],im.size)
  sha=hashlib.sha256(file.read_bytes()).hexdigest();assert sha not in hashes,(sid,p['id'],'duplicate');hashes.add(sha)
  thumb=im.copy();thumb.thumbnail((900,600),Image.Resampling.LANCZOS);thumb.save(th/(p['id']+'.jpg'),quality=90)
  x=30+(i%5)*615;y=135+(i//5)*365;board.paste(fit(im,(590,313)),(x,y));draw.text((x+4,y+318),f"{p['id']}  {p['palette']['name']} · {p['profile']['name']}",font=F(21),fill=FG)
  a=np.asarray(im.resize((240,135))).astype(float);rows.append({'scene':sid,'preset':p['id'],'size':im.size,'sha256':sha,'file':file.relative_to(ROOT).as_posix(),'meanRGB':a.mean((0,1)).round(3).tolist(),'std':round(float(a.std()),3)})
 board.save(D/'boards'/f'{sid}.jpg',quality=91)
 sceneinfo.append({'id':sid,'name':s['name'],'count':40,'faces':logs['logs'][0]['faces'],'vertices':logs['logs'][0]['vertices'],'fovY':logs['logs'][0]['fovY'],'render_seconds':sum(x['ms'] for x in logs['logs'])/1000})
 print('packaged',sid,flush=True)
# Nine scenes under the same A5 recipe.
overview=Image.new('RGB',(2520,1600),BG);dr=ImageDraw.Draw(overview);dr.text((34,20),'九景 / 同一配方 A5 · 黛青鎏金 / 六阶塑形',font=F(39),fill=FG)
for i,s in enumerate(scenes):
 x=25+(i%3)*835;y=100+(i//3)*490;im=Image.open(ROOT/'out/frame-renders'/s['id']/'A5.png').convert('RGB');overview.paste(fit(im,(810,435)),(x,y));dr.text((x,y+440),s['id']+' / '+s['name'],font=F(25),fill=GOLD)
overview.save(D/'九景总览.jpg',quality=93)
# A useful cover comparison: source, hard three bands, soft three, six bands.
comp=Image.new('RGB',(2560,1470),BG);dd=ImageDraw.Draw(comp);dd.text((30,20),'人物 / 从原画到北冥着色',font=F(38),fill=FG)
for i,(p,label) in enumerate([('source','参考原图'),('A2','三阶硬切'),('A3','三阶柔边'),('A5','六阶塑形')]):
 im=Image.open(ROOT/'refs/01.jpg' if p=='source' else ROOT/'out/frame-renders/01'/f'{p}.png').convert('RGB');x=20+(i%2)*1270;y=85+(i//2)*680;comp.paste(fit(im,(1250,620)),(x,y));dd.text((x,y+625),label,font=F(28),fill=GOLD)
comp.save(D/'人物色阶对照.jpg',quality=94)
assert len(rows)==360 and len(hashes)==360 and not errors
verification={'count':len(rows),'uniqueHashes':len(hashes),'gpu':sorted(gpus),'scenes':sceneinfo,'errors':errors,'geometry':'Single-view MoGe-2 depth/normal mesh, baked source colors retained; not complete multi-view assets','images':rows}
(D/'verification.json').write_text(json.dumps(verification,ensure_ascii=False,indent=2),encoding='utf-8')
html=(ROOT/'tools/gallery.html').read_text(encoding='utf-8').replace('__DATA__',json.dumps({'scenes':scenes,'presets':presets},ensure_ascii=False))
(D/'index.html').write_text(html,encoding='utf-8');print('PASS: 360 PNGs, unique checksums, all render logs clean',flush=True)
