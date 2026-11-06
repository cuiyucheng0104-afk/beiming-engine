import fs from 'node:fs';import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {openFilm,closeServer} from '../engine/render/page.mjs';
import {SHOTS} from '../src/storyboard.js';
const out='out/keyframes';fs.mkdirSync(out,{recursive:true});
const a=process.argv.slice(2),times=a.length?a.map(Number):SHOTS.map(s=>s.start+(s.end-s.start)*.55);
const {browser,page,gpu}=await openFilm('.',{w:1920,h:1040});
console.log('GPU',gpu);
if(process.platform==='win32'&&(!/5090/.test(gpu)||!/vulkan/i.test(gpu)))throw new Error('不是指定5090 Vulkan');
const results=[];
try{
 for(const t of times){await page.evaluate(t=>window.render(t),t);const shot=await page.evaluate(()=>window.activeShot());const name=`${shot.id}_${t.toFixed(3)}.jpg`;
 await page.screenshot({path:`${out}/${name}`,type:'jpeg',quality:94});results.push({t,id:shot.id,kind:shot.kind,file:name});console.log(name);}
 await page.evaluate(()=>window.render(201));const one=await page.screenshot({type:'png'});
 await page.evaluate(()=>window.render(81));await page.evaluate(()=>window.render(201));const two=await page.screenshot({type:'png'});
 const same=crypto.createHash('sha256').update(one).digest('hex')===crypto.createHash('sha256').update(two).digest('hex');
 fs.writeFileSync(`${out}/det_a.png`,one);fs.writeFileSync(`${out}/det_b.png`,two);
 const stats=JSON.parse(execFileSync(process.env.PYTHON||'python',['-c',`from PIL import Image\nimport numpy as np,json\na=np.array(Image.open('${out}/det_a.png')).astype(int);b=np.array(Image.open('${out}/det_b.png')).astype(int);d=abs(a-b);print(json.dumps({'max':int(d.max()),'mean':float(d.mean()),'pixelsOver2':int((d.max(2)>2).sum()),'totalPixels':int(a.shape[0]*a.shape[1])}))`],{encoding:'utf8'}));
 const stable=same||(stats.max<=8&&stats.pixelsOver2/stats.totalPixels<.00001);
 fs.writeFileSync(`${out}/index.json`,JSON.stringify({gpu,pixelIdentical:same,seekStable:stable,seekDifference:stats,results},null,2));
 console.log('Seek check',JSON.stringify(stats));
 if(!stable)throw new Error('跨镜跳帧差异超出GPU边缘舍入容差');
}finally{await browser.close();await closeServer();}
