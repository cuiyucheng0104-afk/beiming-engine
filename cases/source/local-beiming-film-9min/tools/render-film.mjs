// 15个可断点恢复的场次；仍逐帧调用北冥 render(t)，并不重复/减速原预告片。
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {openFilm,closeServer} from '../engine/render/page.mjs';
import {SHOTS} from '../src/storyboard.js';
const args=process.argv.slice(2),opt=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const size=opt('--size','3840x2080').split('x').map(Number),workers=Number(opt('--workers','4'));
const out=path.resolve('out/chunks-'+size.join('x'));fs.mkdirSync(out,{recursive:true});
const fps=24,selected=opt('--scenes','').split(',').filter(Boolean).map(Number);
const scenes=Array.from({length:15},(_,i)=>{const s=SHOTS.filter(s=>s.scene===i+1);return {id:i+1,start:s[0].start,end:s.at(-1).end};});
const hash=crypto.createHash('sha256');
function scan(d){for(const e of fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(d,e.name);if(e.isDirectory())scan(p);else if(/\.(js|mjs|json)$/.test(p))hash.update(fs.readFileSync(p));}}
scan('src');scan('engine');hash.update(fs.readFileSync('audio/dialogue.json'));hash.update(fs.readFileSync('audio/lips.json'));const key=hash.digest('hex');
const logPath=path.join(out,'progress.json');
const previous=fs.existsSync(logPath)?JSON.parse(fs.readFileSync(logPath)):null;
const log={size,fps,key,gpu:previous?.key===key?previous.gpu:null,started:new Date().toISOString(),scenes:{},
 previousRenderSeconds:previous?.key===key?(previous.previousRenderSeconds||0)+(previous.wallSeconds||0):0,
 canvasFlush:true};
const save=()=>fs.writeFileSync(logPath,JSON.stringify(log,null,2));
const valid=s=>{const m=path.join(out,`${s.id}.json`);return fs.existsSync(m)&&JSON.parse(fs.readFileSync(m)).key===key&&fs.existsSync(path.join(out,`${s.id}.mp4`));};
const jobs=scenes.filter(s=>(!selected.length||selected.includes(s.id))&&(args.includes('--force')||!valid(s)));
let next=0;const start=Date.now();
async function worker(k){
 if(next>=jobs.length)return;
 const {page,browser,gpu}=await openFilm('.',{w:size[0],h:size[1]});
 if(!/5090/.test(gpu)||!/Vulkan/i.test(gpu))throw new Error(`需要RTX5090 Vulkan，实际${gpu}`);
 log.gpu=gpu;save();
 try{
 while(next<jobs.length){const s=jobs[next++],file=path.join(out,`${s.id}.mp4`),tmp=path.join(out,`${s.id}.partial.mp4`);
 const ff=spawn('ffmpeg',['-v','error','-nostdin','-y','-f','image2pipe','-framerate','24','-c:v','mjpeg','-i','-','-an','-c:v','libx264','-preset','medium','-crf','14','-pix_fmt','yuv420p',tmp],{stdio:['pipe','inherit','inherit']});
 const closed=new Promise((resolve,reject)=>{ff.on('error',reject);ff.on('close',resolve);});
 const frames=Math.round((s.end-s.start)*fps);log.scenes[s.id]={start:s.start,end:s.end,done:0,frames,status:'rendering',worker:k};save();
 for(let n=0;n<frames;n++){
  const t=s.start+n/fps;await page.evaluate(async t=>{
   window.render(t);
   // Vulkan 下空白的2D覆盖层偶尔没有及时提交清屏；读回一个像素并等一次
   // 合成帧，避免上一镜的字幕/卡片残留在下一镜的屏幕截图中。
   document.querySelectorAll('canvas')[1].getContext('2d').getImageData(0,0,1,1);
   await new Promise(requestAnimationFrame);
  },t);
  const jpg=await page.screenshot({type:'jpeg',quality:95});
  if(!ff.stdin.write(jpg))await new Promise(r=>ff.stdin.once('drain',r));
  if(n%120===0){log.scenes[s.id].done=n;save();console.log(`scene ${s.id} ${n}/${frames} elapsed ${Math.round((Date.now()-start)/1000)}s`);}
 }
 ff.stdin.end();if(await closed!==0)throw new Error('FFmpeg失败scene'+s.id);
 fs.renameSync(tmp,file);const meta={...s,key,frames,size,fps,gpu,canvasFlush:true};fs.writeFileSync(path.join(out,`${s.id}.json`),JSON.stringify(meta,null,2));
 log.scenes[s.id].status='complete';log.scenes[s.id].done=frames;save();
 }
 }finally{await browser.close();}
}
try{
 await Promise.all(Array.from({length:workers},(_,i)=>worker(i)));
 if(scenes.every(valid)){
  fs.writeFileSync(path.join(out,'concat.txt'),scenes.map(s=>`file '${s.id}.mp4'`).join('\n'));
  execFileSync('ffmpeg',['-v','error','-nostdin','-y','-f','concat','-safe','0','-i',path.join(out,'concat.txt'),'-c','copy','out/video_4k.mp4'],{stdio:'inherit'});
 }
 log.finished=new Date().toISOString();log.wallSeconds=(Date.now()-start)/1000;save();
 console.log('COMPLETE',log.wallSeconds);
}finally{await closeServer();}
