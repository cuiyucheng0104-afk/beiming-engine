"""Package rendered PNGs into labeled boards and a self-contained offline gallery.
Does not alter source references or shader-rendered masters.
"""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageStat,ImageChops
import json,hashlib,statistics,html

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'out';DELIVERY=ROOT/'delivery';DELIVERY.mkdir(exist_ok=True)
(DELIVERY/'thumbs').mkdir(exist_ok=True)
font_path=next(str(p) for p in [Path('/System/Library/Fonts/Hiragino Sans GB.ttc'),Path('C:/Windows/Fonts/msyh.ttc')] if p.exists())
def font(n):return ImageFont.truetype(font_path,n)
report=json.loads((OUT/'renders/render-log.json').read_text())
items=report['logs']; assert len(items)==40
assert 'RTX 5090' in report['gpu'] and 'Vulkan' in report['gpu']
hashes=set();files=[]
for it in items:
    p=OUT/'renders'/it['file'];im=Image.open(p).convert('RGB')
    assert im.size==(2400,1350)
    sha=hashlib.sha256(p.read_bytes()).hexdigest();assert sha not in hashes;hashes.add(sha)
    im.thumbnail((960,540));im.save(DELIVERY/'thumbs'/f"{it['id']}.jpg",quality=90)
    files.append({'id':it['id'],'sha256':sha,'bytes':p.stat().st_size})

# Master 8 x 5 matrix. Original PNGs stay full size.
cw,ch,gap,left,top=680,383,18,180,190
board=Image.new('RGB',(left+5*(cw+gap)+30,top+8*(ch+80)+60),'#101d23');d=ImageDraw.Draw(board)
d.text((36,26),'北冥引擎 / 色阶实验 01',font=font(52),fill='#f1ead8')
d.text((38,98),'同一三维场景 · 8 组配色 × 5 套色阶 · RTX 5090 / Vulkan',font=font(26),fill='#a6b8ba')
for c,it in enumerate(items[:5]):d.text((left+c*(cw+gap),151),it['preset']['profile']['name'],font=font(26),fill='#dac298')
for row in range(8):
    p=items[row*5]['preset']['palette'];y=top+row*(ch+80)
    d.text((35,y+12),p['id'],font=font(52),fill='#dac298')
    name=p['name'];d.text((35,y+87),name[:2]+'\n'+name[2:],font=font(28),fill='#d9e0df',spacing=10)
    for c in range(5):
        it=items[row*5+c];x=left+c*(cw+gap)
        im=Image.open(OUT/'renders'/it['file']).convert('RGB').resize((cw,ch),Image.Resampling.LANCZOS);board.paste(im,(x,y))
        d.text((x,y+ch+10),f"{it['id']}   {it['preset']['profile']['name']}",font=font(23),fill='#e3e8e3')
board.save(DELIVERY/'40版总览.jpg',quality=94)
small=board.copy();small.thumbnail((2000,2200));small.save(DELIVERY/'40版总览_预览.jpg',quality=92)

# Each palette gets an easy-to-read sheet: wide on top and corresponding closeup below.
for row in range(8):
    p=items[row*5]['preset']['palette'];w,h=640,360
    b=Image.new('RGB',(5*(w+16)+32,920),'#101d23');dr=ImageDraw.Draw(b)
    dr.text((30,22),f"{p['id']} / {p['name']}  ·  色阶与局部对照",font=font(36),fill='#eee6d5')
    for c in range(5):
        it=items[row*5+c];x=24+c*(w+16)
        for sub,y in [('renders',110),('detail',500)]:
            im=Image.open(OUT/sub/it['file']).convert('RGB').resize((w,h),Image.Resampling.LANCZOS);b.paste(im,(x,y))
        dr.text((x,76),f"{it['id']}  {it['preset']['profile']['name']}",font=font(22),fill='#d7bd91')
    b.save(DELIVERY/f"{p['id']}_{p['name']}_对照.jpg",quality=94)

# A compact preview of all palettes using profile 3 (same band configuration).
pw,ph=800,450;b=Image.new('RGB',(1648,4*(ph+65)+100),'#101d23');dr=ImageDraw.Draw(b)
dr.text((24,20),'八组配色 · 统一三阶柔边',font=font(36),fill='#eee6d5')
for row in range(8):
    it=items[row*5+2];x=16+(row%2)*816;y=92+(row//2)*(ph+65)
    b.paste(Image.open(OUT/'renders'/it['file']).convert('RGB').resize((pw,ph),Image.Resampling.LANCZOS),(x,y))
    dr.text((x,y+ph+9),it['id']+'  '+it['preset']['palette']['name'],font=font(25),fill='#dac298')
b.save(DELIVERY/'八组配色预览.jpg',quality=93)

# Independent shader probe: same neutral sphere, no fog/reflection/post.
b=Image.new('RGB',(2424,405),'#101d23');dr=ImageDraw.Draw(b)
dr.text((24,15),'光照校准 · 同一灰色球体，关闭雾、反射与后期',font=font(27),fill='#eee6d5')
for col,it in enumerate(items[:5]):
    im=Image.open(OUT/'probe'/it['file']).convert('RGB').resize((470,264),Image.Resampling.LANCZOS)
    x=16+col*480;b.paste(im,(x,74));dr.text((x+20,352),it['preset']['profile']['name'],font=font(23),fill='#dac298')
b.save(DELIVERY/'五套色阶_光照校准.jpg',quality=95)

dataset=[{'id':it['id'],'number':it['preset']['number'],'name':it['preset']['name'],'palette':it['preset']['palette']['id'],'paletteName':it['preset']['palette']['name'],'profile':it['preset']['profile'],'colors':{k:it['preset']['palette'][k] for k in ['roof','rock','leaf','water','shadow','light']}} for it in items]
template=Path(__file__).with_name('gallery.template.html').read_text()
(DELIVERY/'index.html').write_text(template.replace('__DATA__',json.dumps(dataset,ensure_ascii=False)),encoding='utf-8')
(DELIVERY/'presets.json').write_text(json.dumps([it['preset'] for it in items],ensure_ascii=False,indent=2))

# Quantify that profile changes affect geometry shading, not just filename/palette.
diff=[]
for row in range(8):
    a=Image.open(OUT/'renders'/items[row*5]['file']).convert('RGB');b=Image.open(OUT/'renders'/items[row*5+4]['file']).convert('RGB')
    stat=ImageStat.Stat(ImageChops.difference(a,b))
    diff.append({'palette':items[row*5]['preset']['palette']['id'],'A1_vs_A5_mean_absolute_RGB_difference':sum(stat.mean)/3})
(DELIVERY/'verification.json').write_text(json.dumps({'master_count':40,'closeup_count':len(list((OUT/'detail').glob('*.png'))),'size':[2400,1350],'gpu':report['gpu'],'shader_errors':report['errors'],'unique_hashes':len(hashes),'profile_difference':diff,'files':files},ensure_ascii=False,indent=2))
print(json.dumps({'delivery':str(DELIVERY),'masters':40,'unique_hashes':len(hashes),'median_capture_ms':statistics.median(x['ms'] for x in items),'profile_diff':diff},ensure_ascii=False))
