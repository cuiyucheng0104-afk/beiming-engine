// 在有显示器的 Chrome 中，从 file:// 离线打开终包；每次在 rAF 中渲染一帧，再等真实 GPU 完成。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const dir=path.resolve(process.argv[2]??'films/wonderx-m0'), discrete=process.argv.includes('--nvidia');
const args=['--class=wonderx-m0-bench','--start-fullscreen'];
const env={...process.env};
if(discrete){args.push('--use-angle=vulkan','--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE','--use-vulkan=native');
  Object.assign(env,{__NV_PRIME_RENDER_OFFLOAD:'1',__GLX_VENDOR_LIBRARY_NAME:'nvidia',VK_ICD_FILENAMES:'/usr/share/vulkan/icd.d/nvidia_icd.json'});}
const browser=await chromium.launch({executablePath:process.env.BEIMING_CHROME||'/usr/bin/google-chrome-stable',headless:false,args,env});
const isolated=await fs.mkdtemp(path.join(os.tmpdir(),'wonderx-offline-'));
try {
  const single=path.join(isolated,'index.html');
  await fs.copyFile(path.join(dir,'out/standalone/index.html'),single);
  const page=await browser.newPage({viewport:null,offline:true});const external=[],errors=[];
  page.on('pageerror',err=>{errors.push(err.message);console.error(err.message);});
  page.on('console',msg=>{if(msg.type()==='error'){errors.push(msg.text());console.error(msg.text().slice(0,600));}});
  page.on('request',r=>{if(/^https?:/.test(r.url())) external.push(r.url());});
  await page.goto(pathToFileURL(single).href+'?bench');
  await page.waitForFunction(()=>window.READY,null,{timeout:60000});
  if(process.argv.includes('--fullscreen')) await page.waitForFunction(()=>innerWidth===screen.width && innerHeight===screen.height,null,{timeout:20000});
  const info=await page.evaluate(()=>{
    const gl=__BENCH.renderer.getContext();return {gpu:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),size:[innerWidth,innerHeight],dpr:devicePixelRatio};});
  const brush=await page.evaluate(()=>__BENCH.checkBrush());
  assert.ok(brush.han > 0 && brush.missing.length === 0, '脚本汉字笔画覆盖失败');
  if (discrete) assert.match(info.gpu,/NVIDIA/i);
  const results=[];
  for(const chapter of ['A08','A09']) for(const tier of ['full','medium','low','minimal']) {
    const row=await page.evaluate(async ([chapter,tier])=>{
      const {renderer,world}=__BENCH, gl=renderer.getContext(),shot=TIMELINE.shot(chapter), start=(shot.t0+shot.t1)/2;
      const pixel=new Uint8Array(4),draw=i=>{render(start+i/TIMELINE.fps,{tier,pointer:[.6,.4]});gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);};
      const raf=()=>new Promise(requestAnimationFrame); for(let i=0;i<4;i++){await raf();draw(i);}
      let prev=performance.now(); const dt=[];
      for(let i=0;i<48;i++){await raf();draw(i);const now=performance.now();dt.push(now-prev);prev=now;}
      return {chapter,tier,instances:chapter==='A09'?world.voxels.count:0,buffer:[gl.drawingBufferWidth,gl.drawingBufferHeight],fps:48000/dt.reduce((a,b)=>a+b,0),p95ms:dt.sort((a,b)=>a-b)[45]};
    },[chapter,tier]);results.push(row);console.log(JSON.stringify(row));
  }
  const determinism=await page.evaluate(()=>{
    const gl=__BENCH.renderer.getContext();function signature(){const bytes=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,bytes);let v=2166136261;for(const x of bytes)v=Math.imul(v^x,16777619);return v>>>0;}
    const t=TIMELINE.shot('A08').t0+12,input={tier:'low',pointer:[.79,.23]};render(t,input);const a=signature();render(t-8,{tier:'minimal',pointer:[.2,.6]});render(t,input);return [a,signature()];});
  await page.evaluate(()=>{const ext=__BENCH.renderer.getContext().getExtension('WEBGL_lose_context');ext.loseContext();setTimeout(()=>ext.restoreContext(),350);});
  await page.waitForFunction(()=>!__BENCH.restored);await page.waitForFunction(()=>__BENCH.restored);
  await page.setViewportSize({width:960,height:540});await page.evaluate(()=>render(TIMELINE.shot('A08').t0,{tier:'low'}));
  const resize=await page.locator('#stage').evaluate(el=>[el.width,el.height]);
  assert.deepEqual(resize,[Math.round(960*.65),Math.round(540*.65)]);
  // 将合成阻塞到第一次 M、A 之后，检查的是真实主 GainNode，不是 UI 状态。
  await page.addInitScript(() => {
    const gate = new Promise(resolve => { window.releaseSynth = resolve; });
    const start = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = async function() { await gate; return start.call(this); };
    const gain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function() { const node = gain.call(this); window.masterProbe ??= node; return node; };
  });
  await page.goto(pathToFileURL(single).href);
  await page.waitForFunction(()=>window.READY);
  await page.keyboard.press('m'); await page.keyboard.press('a');
  assert.equal(await page.evaluate(()=>window.masterProbe.gain.value),0);
  await page.evaluate(()=>window.releaseSynth());
  await page.waitForFunction(()=>document.querySelector('.bne-deck-ui').shadowRoot.querySelectorAll('.stem').length===3);
  assert.equal(await page.evaluate(()=>window.masterProbe.gain.value),0);
  await page.keyboard.press('m'); await page.waitForFunction(()=>window.masterProbe.gain.value>.99);
  const sha256=createHash('sha256').update(await fs.readFile(single)).digest('hex');
  const report={...info,sha256,brush,coldMute:true,version:browser.version(),external,errors,results,determinism,contextRestored:true,resize};
  await fs.writeFile(path.join(dir,`out/bench-${discrete?'discrete':'default'}.json`),JSON.stringify(report,null,2)+'\n');
  if(external.length||errors.length||determinism[0]!==determinism[1])throw Error('离线、控制台或确定性检查失败');
}finally{await browser.close();await fs.rm(isolated,{recursive:true,force:true});}
