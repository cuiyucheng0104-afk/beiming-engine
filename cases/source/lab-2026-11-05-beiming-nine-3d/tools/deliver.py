"""整理原生渲染文件、无损原图链接、浏览预览和三维检查页；不改动成图风格。"""
from pathlib import Path
import json, shutil, hashlib, zipfile
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'delivery'
for d in ['full','preview','qa','refs','logs']:(OUT/d).mkdir(parents=True,exist_ok=True)
titles=['烛下挥毫','青铜案头','烟雨舟人','云山楼阁','林间市集','碑林风起','仰望藏书楼','江山云海','暮色江村']
details=[
 '实体人物、木案、书卷、烛台与窗格投影。人物脸与手仍有生成误差。',
 '空腔青铜器、浮雕环带、剑身、书卷和案几，全部为程序几何。',
 '实体舟人、船板、撑篙、立体树冠及水面反射。人物尚未绑定。',
 '实体楼阁、曲面瓦脊、栏杆、岛礁和山体；远处天空是北冥水彩底板。',
 '程序化曲面屋顶、立柱、窗格、摊位与人群，检查群景空间与材质统一。',
 '楼阁实体、碑刻、石板地面和飞纸，检查近中远三维遮挡。',
 '同类建筑世界的仰拍构图，检验屋檐厚度、空间纵深与飞纸透视。',
 '体积山体、实例植被、河道反射与水彩远云；山体重复性仍需进一步设计。',
 '真实房屋、曲面屋顶、枝干、舟船与倒影，蓝紫夜色配暖窗光。'
]
rows=[]
for i,title in enumerate(titles,1):
 sid=f'{i:02}';tag='r6' if i==8 else 'r5';src=ROOT/'out/final'/tag/(sid+'_hero.png')
 if not src.exists():raise RuntimeError(f'缺少成图 {src}')
 im=Image.open(src);assert im.size==(3840,2160),(src,im.size)
 target=OUT/'full'/(sid+'.png');shutil.copy2(src,target)
 pv=im.copy();pv.thumbnail((1600,900));pv.convert('RGB').save(OUT/'preview'/(sid+'.jpg'),quality=92,subsampling=0)
 shutil.copy2(ROOT/'refs'/(sid+'.jpg'),OUT/'refs'/(sid+'.jpg'))
 log=json.loads((ROOT/'out/final'/tag/(sid+'_log.json')).read_text(encoding='utf-8'))
 assert 'RTX 5090' in log['gpu'] and 'Vulkan' in log['gpu'],log['gpu']
 shutil.copy2(ROOT/'out/final'/tag/(sid+'_log.json'),OUT/'logs'/(sid+'.json'))
 for view in ['clay','angle']:
  q=ROOT/'out/qa'/tag/(sid+'_'+view+'.png');assert q.exists(),q
  shutil.copy2(q,OUT/'qa'/(sid+'_'+view+'.png'))
 rows.append({'id':sid,'title':title,'description':details[i-1],'faces':log['logs'][0]['faces'],'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'size':im.size,'gpu':log['gpu']})
(OUT/'manifest.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')

fontpaths=['/System/Library/Fonts/Hiragino Sans GB.ttc','C:/Windows/Fonts/msyh.ttc']
fp=next((p for p in fontpaths if Path(p).exists()),None)
font=ImageFont.truetype(fp,28) if fp else ImageFont.load_default()
small=ImageFont.truetype(fp,18) if fp else ImageFont.load_default()
sheet=Image.new('RGB',(2400,1548),'#121625');d=ImageDraw.Draw(sheet)
d.text((24,18),'北冥九景  /  原生4K · 三维重建',font=font,fill='#f1dfc6')
for i,row in enumerate(rows):
 x=(i%3)*800;y=84+(i//3)*488
 im=Image.open(OUT/'preview'/(row['id']+'.jpg'));im=im.resize((800,450),Image.Resampling.LANCZOS);sheet.paste(im,(x,y))
 d.text((x+14,y+456),row['id']+'  '+row['title'],font=small,fill='#e9dfd5')
sheet.save(OUT/'九景总览.jpg',quality=94)
# geometry proof overview
proof=Image.new('RGB',(2400,1452),'#121625');d=ImageDraw.Draw(proof)
d.text((24,12),'三维检查  /  灰模侧移机位',font=font,fill='#f1dfc6')
for i,row in enumerate(rows):
 x=i%3*800;y=64+i//3*460;im=Image.open(OUT/'qa'/(row['id']+'_angle.png'));im=im.resize((800,450),Image.Resampling.LANCZOS);proof.paste(im,(x,y))
proof.save(OUT/'三维检查总览.jpg',quality=93)
data=json.dumps(rows,ensure_ascii=False)
html=r'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>北冥九景 · 三维风格样张</title><style>
:root{--bg:#0d1220;--panel:#151d2d;--ink:#eee9df;--muted:#a2adc2;--gold:#f0ba83}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif}a{color:var(--gold);text-underline-offset:4px}header{max-width:1500px;margin:auto;padding:52px 28px 24px}.eyebrow{letter-spacing:.22em;color:var(--gold);font-size:12px}h1{font:500 clamp(32px,4vw,54px)/1.35 Georgia,"Songti SC",serif;margin:12px 0}header p{max-width:900px;color:var(--muted);margin:12px 0}.chips{display:flex;gap:10px;flex-wrap:wrap}.chip{border:1px solid #354259;border-radius:99px;padding:4px 14px;font-size:12px;color:#c8d1e2}main{max-width:1500px;margin:auto;padding:0 28px 56px}.viewer{background:#090d16;border:1px solid #2a3549;border-radius:12px;overflow:hidden}.toolbar{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--panel)}button{font:inherit;color:var(--ink);background:#202b3e;border:1px solid #3a475e;border-radius:6px;padding:6px 12px;cursor:pointer}button:hover{background:#33415a}button[aria-pressed="true"]{background:#eab785;color:#182132;border-color:#eab785}.tabs{display:flex;gap:6px;flex-wrap:wrap}#stage{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:contain;background:#070b12}.caption{padding:16px 20px;background:var(--panel);display:flex;justify-content:space-between;gap:24px}.caption p{margin:0;color:var(--muted)}#name{display:block;font-size:20px;margin-bottom:6px}.actions{flex-shrink:0;display:flex;align-items:center;gap:18px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:28px}.tile{padding:0;background:var(--panel);border:1px solid #2b364a;text-align:left;overflow:hidden}.tile img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}.tile span{display:block;padding:9px 13px}.tile.active{outline:2px solid var(--gold)}details{margin-top:28px;border-top:1px solid #2b364a;padding-top:18px;color:var(--muted)}summary{cursor:pointer;color:#e3dcd2}details p{max-width:1100px}footer{color:var(--muted);font-size:13px;border-top:1px solid #2b364a;margin-top:28px;padding-top:18px}.controls{display:flex;gap:8px;align-items:center}.keys{color:var(--muted);font-size:12px}@media(max-width:760px){header{padding:28px 16px 18px}main{padding:0 12px 30px}.grid{grid-template-columns:repeat(2,1fr);gap:9px}.caption{display:block}.actions{margin-top:12px}.keys{display:none}}button:focus-visible,a:focus-visible{outline:3px solid #ffd9ac;outline-offset:3px}
</style></head><body><header><div class="eyebrow">BEIMING ENGINE / VISUAL DEVELOPMENT</div><h1>九景，进入北冥。</h1><p>把九张参考中的人物、器物与山水重建为三维场景，使用北冥的蓝紫阴影、暖色边缘光、分档着色和墨线。先看画面，再切到灰模与侧移机位检查体积。</p><div class="chips"><span class="chip">9 张原生 3840 × 2160</span><span class="chip">RTX 5090 · Vulkan</span><span class="chip">真实主体几何 + 水彩远景</span><span class="chip">风格试验 / 非原图精确复刻</span></div></header><main><section class="viewer"><div class="toolbar"><div class="tabs"><button data-mode="hero" aria-pressed="true">北冥成图</button><button data-mode="ref" aria-pressed="false">原始参考</button><button data-mode="clay" aria-pressed="false">实体灰模</button><button data-mode="angle" aria-pressed="false">侧移检查</button></div><div class="controls"><span class="keys">← → 切换场景</span><button id="prev" aria-label="上一景">←</button><span id="counter"></span><button id="next" aria-label="下一景">→</button></div></div><img id="stage" alt=""><div class="caption"><div><strong id="name"></strong><p id="description"></p></div><div class="actions"><a id="open" target="_blank">打开当前原图</a><a id="download" download>下载4K PNG</a></div></div></section><div class="grid" id="grid"></div><details><summary>画风、清晰度与模型范围</summary><p>本轮使用北冥原片的 toon / look 模块。三档明暗由表面法线、灯光和投影决定；关闭了此前的参考图整体投影方式。Kuwahara 强度降到0.14、半径1.2，保留几何边缘和瓦垄细节。所有正式成图均由5090原生4K光栅化，未做AI超分。</p><p>书生、舟人、楼阁是三个既有TRELLIS.2实体模型；其他器物、树、山、舟船、建筑和人群由程序几何搭建。06与07复用楼阁资产。天空和远云使用北冥自有水彩底板；灰模检查仍保留天空、水面和远景底板以便对位。</p><p>这是一组风格开发样张。角色的脸、手和衣褶仍有生成误差，程序化树冠、村舍也有重复性。参考图只用于题材与构图参考，没有承诺逐像素重现，也没有完成角色绑定或动画稳定性验证。</p><p><a href="../README.md">工程说明</a> · <a href="../docs/画风与几何说明.md">具体材质与参数</a> · <a href="manifest.json">输出文件与SHA256</a></p></details><footer><a href="九景总览.jpg" target="_blank">九景总览</a> · <a href="三维检查总览.jpg" target="_blank">三维检查总览</a><p>工程：D:北冥experimentseiming-nine-3d　｜　本页与4K成图均可离线查看。</p></footer></main><script>
const scenes=__DATA__;let index=0,mode='hero';const $=s=>document.querySelector(s),src=()=>mode==='hero'?'full/'+scenes[index].id+'.png':mode==='ref'?'refs/'+scenes[index].id+'.jpg':'qa/'+scenes[index].id+'_'+mode+'.png';
function paint(){const s=scenes[index],url=src();$('#stage').src=mode==='hero'?'preview/'+s.id+'.jpg':url;$('#stage').alt=s.title+' · '+mode;$('#name').textContent=s.id+' / '+s.title;$('#description').textContent=s.description;$('#counter').textContent=(index+1)+' / 9';$('#open').href=url;$('#download').href='full/'+s.id+'.png';$('#download').download='北冥九景_'+s.id+'_'+s.title+'_4K.png';document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.mode===mode));document.querySelectorAll('.tile').forEach((b,i)=>b.classList.toggle('active',index===i));history.replaceState(null,'','#scene-'+s.id);}
scenes.forEach((s,i)=>{const b=document.createElement('button');b.className='tile';b.innerHTML='<img loading="lazy" src="preview/'+s.id+'.jpg" alt="'+s.title+'"><span>'+s.id+'　'+s.title+'</span>';b.onclick=()=>{index=i;paint();$('.viewer').scrollIntoView({behavior:'smooth',block:'start'});};$('#grid').append(b);});
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;paint();});$('#prev').onclick=()=>{index=(index+8)%9;paint();};$('#next').onclick=()=>{index=(index+1)%9;paint();};document.addEventListener('keydown',e=>{if(e.key==='ArrowRight')$('#next').click();if(e.key==='ArrowLeft')$('#prev').click();});let h=location.hash.match(/scene-(\d+)/);if(h)index=Math.max(0,Math.min(8,+h[1]-1));paint();
</script></body></html>'''.replace('__DATA__',data)
(OUT/'index.html').write_text(html,encoding='utf-8')
# Only the9 original4K files are archived; no source images or preview JPEG substituted.
with zipfile.ZipFile(OUT/'北冥九景_原生4K.zip','w',compression=zipfile.ZIP_STORED) as z:
 for row in rows:z.write(OUT/'full'/(row['id']+'.png'),row['id']+'_'+row['title']+'_4K.png')
print(json.dumps({'images':len(rows),'size':[3840,2160],'manifest':str(OUT/'manifest.json'),'gallery':str(OUT/'index.html')},ensure_ascii=False))
