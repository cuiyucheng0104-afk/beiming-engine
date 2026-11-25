import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { chromeArgs, chromeExecutable } from '../../../../engine/render/lib/gpu.mjs';
import { startServer } from '../../../host/page/host.mjs';
import { scanCardLeaks, validateCard } from '../../validate-card.mjs';

function fixture() {
  const width = 35, height = 19, n = width * height;
  return { width, height, color: new Float32Array(n * 4).fill(0.75), depth: new Float32Array(n).fill(40),
    cameraWorld: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-500,0,1], inverseFocal: [0.6, 0.5], lightColor: [1, 0.5, 0.25],
    shadow: { matrix: [0.003,0,0,0, 0,0,0,0, 0,0,0,0, 0.5,0.5,0.7,1], width: 2, height: 1, data: new Float32Array([0.1, 0.9]) } };
}

test('公开契约与三份文件均无泄露', () => {
  for (const name of ['card.json', 'three.js', 'selftest.test.mjs']) {
    const text = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.deepEqual(scanCardLeaks(text), []);
    if (name === 'card.json') assert.deepEqual(validateCard(JSON.parse(text)), {ok:true, schemaErrors:[], violations:{}, leaks:[]});
  }
});

test('十四个变步长样本：遮挡负积分、无遮挡零、最远深度与天空上限', async () => {
  const { volumetricCPU } = await import('./three.js');
  const f = fixture(), run = (changes) => volumetricCPU({...f, ...changes});
  const { color, shaft, shaftWidth, shaftHeight } = run();
  assert.deepEqual([shaftWidth,shaftHeight],[8,4]);
  // 相机在地面以下，密度恒定；第一条视线十四点全在挡光的半边。
  const phase = (52.9829189 * (0.5 * (0.06711056 + 0.00583715))) % 1;
  const expected = -0.004 * 1.1 * 40 * (0.35 + 1.3 * (6.5 + phase) / 14);
  assert.ok(Math.abs(shaft[0] - expected) < 0.0002);
  assert.equal(shaft[7], 0);
  assert.ok(color[0] < 0.7 && color[1] > color[0] && color[2] > color[1]);
  assert.equal(color[3], f.color[3]); assert.equal(f.color[0], 0.75);
  const open = run({shadow:null}); assert.ok(open.shaft.every(x => x === 0));
  assert.deepEqual(open.color, f.color); assert.deepEqual(volumetricCPU(f, {enabled:false}).color, f.color);
  const depth = new Float32Array(f.depth.length).fill(500);
  const capped = run({ depth }); assert.ok(Math.abs(capped.shaft[0] / shaft[0] - 6) < 0.01);
  // 四个深度里只有右上那个是天空。
  depth[3 * f.width + 3] = Infinity;
  assert.ok(Math.abs(run({depth}).shaft[0] / shaft[0] - 2.75) < 0.01);
});

test('独立空气散射：不需要底雾，阴影只挡住正散射', async () => {
  const {volumetricCPU} = await import('./three.js'); const f=fixture();
  const {shaft} = volumetricCPU(f,{mode:'standalone'});
  assert.equal(shaft[0],0); assert.ok(shaft[7]>0.1);
  const open=volumetricCPU({...f,shadow:null},{mode:'standalone'});
  assert.ok(open.shaft.every(x=>x>0));
});

test('HG 前向与后向有解析比值，米制消光随距离积累', async () => {
  const { volumetricCPU } = await import('./three.js');
  const f = fixture(); f.inverseFocal = [0.01,0.01];
  const sample = (direction,params) => volumetricCPU({...f, sunDirection:direction},params).shaft[0];
  const iso = sample([0,0,-1],{}), forward=sample([0,0,-1],{anisotropy:0.5});
  assert.ok(Math.abs(forward/iso - 6) < 0.02);
  assert.ok(Math.abs(sample([0,0,1],{anisotropy:0.5})/iso - 2/9) < 0.002);
  const atten = sample([0,0,-1],{extinction:0.05}); assert.ok(atten/iso > 0.40 && atten/iso < 0.47);
  assert.throws(() => sample(undefined,{anisotropy:0.5}), /sunDirection/);
});

function cloud() {
  return {width:2,height:2,data:new Uint8Array([255,128,16,255, 20,128,48,255, 90,128,180,255, 225,128,10,255]),
    frequency:0.02,offset:[-0.1,0.2],slope:[0.22,0.45],azimuth:[0.6,0.8],cover:0.8,
    storm:[20,0.7,15,0.5],edge:10,ceiling:35,segments:Array(6).fill([-10,-25,10,-25]).flat(),radii:[4,7]};
}

test('云缘与开口可增光，太阳阴影会遮断光柱', async () => {
  const { volumetricCPU } = await import('./three.js');
  const f = fixture(); f.cameraWorld[13] = 2;
  const clouds = cloud(), run = (changes, params) => volumetricCPU({...f, clouds, shadow:null, ...changes}, params);
  const open = run(), noBeam = run({}, {beamGain:0}), occluded = run({shadow:f.shadow});
  assert.ok(open.shaft.some((v,i) => v > noBeam.shaft[i] + 0.03));
  assert.ok(noBeam.shaft.some(v => v > 0.005)); assert.ok(occluded.shaft.some(v => v < 0));
  assert.throws(() => run({cameraWorld:undefined}), /cameraWorld/);
});

test('页面注入渲染库：浮点目标实渲与离线结果相符', async t => {
  let browser;
  try { browser = await chromium.launch({executablePath:chromeExecutable(),args:chromeArgs()}); }
  catch (e) { t.skip(`浏览器不可用：${e.message.split('\n')[0]}`); return; }
  t.after(() => browser.close()); const server = await startServer(); t.after(() => server.close());
  const page = await browser.newPage(); await page.goto(server.origin);
  if (!await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2')?.getExtension('EXT_color_buffer_float'))) {
    t.skip('WebGL2 浮点颜色目标不可用'); return;
  }
  const f = fixture(); f.cameraWorld[13] = 2; f.clouds = cloud(); f.sunDirection=[0.3,0.1,-1];
  const params={mode:'standalone',anisotropy:0.35,extinction:0.05};
  const { volumetricCPU } = await import('./three.js'); const expected = volumetricCPU(f,params).color;
  const inputs = {...f, params, color:[...f.color], depth:[...f.depth], shadow:{...f.shadow,data:[...f.shadow.data]},clouds:{...f.clouds,data:[...f.clouds.data]}};
  const pixels = await page.evaluate(async f => {
    const THREE = await import('/node_modules/three-webgpu/build/three.module.js');
    const {create} = await import('/beiming/cards/post/volumetric/three.js');
    const r = new THREE.WebGLRenderer(), scene = new THREE.Scene(); const textures = [];
    function tex(data,w,h,type,format) { const t = new THREE.DataTexture(data,w,h,format,type); t.needsUpdate = true; textures.push(t); return t; }
    const depth = new Float32Array(f.width*f.height*4); for (let i=0;i<f.depth.length;i++) { depth[4*i]=f.depth[i]; depth[4*i+3]=1; }
    const tDepth = tex(depth,f.width,f.height,THREE.FloatType,THREE.RGBAFormat);
    const tInput = tex(Float32Array.from(f.color),f.width,f.height,THREE.FloatType,THREE.RGBAFormat);
    const shadowTex = tex(Float32Array.from(f.shadow.data),2,1,THREE.FloatType,THREE.RedFormat);
    const cloudTex = tex(Uint8Array.from(f.clouds.data),2,2,THREE.UnsignedByteType,THREE.RGBAFormat);
    cloudTex.minFilter=cloudTex.magFilter=THREE.LinearFilter; cloudTex.wrapS=cloudTex.wrapT=THREE.RepeatWrapping;
    const v = create({THREE},f.params); v.setFrame({...f, shadow:{matrix:f.shadow.matrix,texture:shadowTex}, clouds:{...f.clouds,texture:cloudTex}});
    const rt = new THREE.WebGLRenderTarget(f.width,f.height,{type:THREE.FloatType,depthBuffer:false});
    try { scene.add(v.object); v.object.material.uniforms.tDepth.value=tDepth; v.object.material.uniforms.tInput.value=tInput;
      r.setRenderTarget(rt); r.render(scene,new THREE.Camera()); const out = new Float32Array(f.color.length);
      r.readRenderTargetPixels(rt,0,0,f.width,f.height,out); return [...out];
    } finally {v.dispose(); rt.dispose(); textures.forEach(t=>t.dispose()); r.dispose();}
  },inputs);
  const err = Math.max(...pixels.map((x,i)=>Math.abs(x-expected[i]))); assert.ok(err < 0.002, `最大线性误差 ${err}`);
});
