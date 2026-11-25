import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { scanCardLeaks, validateCard } from '../../validate-card.mjs';
import { open } from '../../../../tests/engine/lib/browser.mjs';
import { bloomReference } from './three.js';

const fixture = (width, height, channels, f) => ({ width, height,
  color: Float32Array.from({ length: width * height * channels }, (_, i) =>
    f(Math.floor(i / channels) % width, Math.floor(i / channels / width), i % channels)) });
const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('公开卡符合契约，三个文件均无泄露', () => {
  const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
  const card = JSON.parse(read('card.json'));
  assert.deepEqual(validateCard(card), { ok: true, leaks: [], violations: {}, schemaErrors: [] });
  for (const name of ['card.json', 'three.js', 'selftest.test.mjs']) assert.deepEqual(scanCardLeaks(read(name)), []);
  assert.deepEqual(Object.keys(card.params).sort(), ['additive', 'clamp', 'enabled', 'intensity', 'knee', 'radius', 'threshold']);
});

test('四降三升，奇数尺寸向下取整；常量 HDR 与逐像素 alpha 守恒', () => {
  const src = fixture(63, 37, 4, (x, y, c) => c === 3 ? (x + y) / 100 : [8, 0.5, 2][c]);
  const { down, up, color } = bloomReference(src);
  assert.deepEqual(down.map(({ width, height }) => [width, height]), [[31, 18], [15, 9], [7, 4], [3, 2]]);
  assert.deepEqual(up.map(({ width, height }) => [width, height]), [[31, 18], [15, 9], [7, 4]]);
  for (const p of [...down, ...up]) assert.ok(p.data.every((v, i) => v === [8, 0.5, 2][i % 3]));
  assert.deepEqual(color, src.color);
});

test('首级双线性后用 RGB 峰值做 Karis；关卡零差、输入不被写回', () => {
  // 输出 (3,3) 在源 (6.5,6.5) 四周采样；右下 2×2 色块正好占其中一项。
  const src = fixture(32, 32, 3, (x, y, c) => x >= 7 && x <= 8 && y >= 7 && y <= 8 ? [15, 3, 1][c] : 0);
  const original = src.color.slice();
  const { down } = bloomReference(src);
  for (let c = 0; c < 3; c++) close(down[0].data[3 * (3 * 16 + 3) + c], [15, 3, 1][c] / 49, 0.00013);
  for (const opt of [{ enabled: false }, { intensity: 0 }]) {
    const off = bloomReference(src, opt);
    assert.deepEqual(off.color, original);
    assert.equal(off.down.length + off.up.length, 0);
  }
  assert.deepEqual(src.color, original);
});

test('13 点和帐篷独立核对中心像素，帐篷按 62% 与同级原色混合', () => {
  const src = fixture(64, 64, 3, (x, y, c) => c === 0 ? (x * y % 11) ** 2 : 0);
  const { down, up } = bloomReference(src);
  // 采用整数像素处的红通道，不复用卡片的 tap 表或插值函数。
  const pixel = (p, x, y) => p.data[3 * (y * p.width + x)];
  const kernel = [[2,0,4,0,2], [0,8,0,8,0], [4,0,8,0,4], [0,8,0,8,0], [2,0,4,0,2]];
  let expected = 0;
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    for (const j of [0,1]) for (const i of [0,1]) expected += kernel[y][x] * pixel(down[0], 8+x+i, 8+y+j) / 256;
  }
  close(pixel(down[1],5,5), expected, 0.016);
  expected = 0;
  // up[1](5,5) 投到 up[2] 的 (2.25,2.25)，3×3 帐篷再双线性。
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    for (const j of [0,1]) for (const i of [0,1]) expected += pixel(up[2],2+x+i,2+y+j)
      * (2-Math.abs(x))*(2-Math.abs(y)) * (i ? 0.25 : 0.75)*(j ? 0.25 : 0.75) / 16;
  }
  close(pixel(up[1],5,5), 0.38 * pixel(down[1],5,5) + 0.62 * expected, 0.016);
});

test('阈值、软膝、上限影响提取；半径改变扩散，强度只混合一次', () => {
  const flat = fixture(8,8,3, () => 2);
  for (const [options, value] of [[{threshold:2},0],[{threshold:2,knee:1},0.25],[{clamp:1},1]]) {
    assert.ok(bloomReference(flat, { ...options, intensity:1 }).color.every(v => v === value));
  }
  const src = fixture(33,31,3,(x,y) => x === 15 && y === 14 ? 20 : 0);
  const full = bloomReference(src,{intensity:1}).color;
  const half = bloomReference(src,{intensity:0.5}).color;
  assert.ok(half.every((v,i) => Math.abs(v - 0.5*(src.color[i]+full[i])) < 1e-6));
  const additive = bloomReference(src,{intensity:0.5,additive:true}).color;
  assert.ok(additive.every((v,i) => Math.abs(v - (src.color[i]+0.5*full[i])) < 1e-6));
  assert.notDeepEqual(bloomReference(src,{radius:2,intensity:1}).color,full);
  assert.throws(() => bloomReference({ ...src, width:32 }), /color/);
  assert.throws(() => bloomReference(src, { intensity:NaN }), /intensity/);
});

test('WebGL2：从仅有近邻过滤的宿主纹理生成七张浮点层，与 CPU 逐层核对，复用且可缩放', async t => {
  const b = await open();
  if (b.skip) return t.skip(b.skip);
  t.after(() => b.close());
  const probe = await b.page('capabilities.html', '<!doctype html><title>WebGL2</title>');
  const floatTargets = await probe.page.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl2')?.getExtension('EXT_color_buffer_float')));
  await probe.close();
  if (!floatTargets) return t.skip('无可渲染浮点目标的 WebGL2 上下文');
  const p = await b.page('bloom.html', `<!doctype html><script type="module">
    import * as T from '/node_modules/three-webgpu/build/three.module.js';
    import {create,bloomReference} from '/beiming/cards/post/bloom/three.js';
    const r=new T.WebGLRenderer(), camera=new T.Camera(), opt={additive:true,radius:1.25,threshold:0.3,knee:0.2,clamp:5,intensity:0.4};
    const h=create({THREE:T},opt), errors=[];
    for (const [w,height] of [[61,37],[38,48]]) {
      const color=Float32Array.from({length:w*height*4},(_,i)=>i%4===3?0.625:(i*89%317)/39);
      const tex=new T.DataTexture(color,w,height,T.RGBAFormat,T.FloatType); tex.needsUpdate=true;
      const dst=new T.WebGLRenderTarget(w,height,{type:T.FloatType});
      const cpu=bloomReference({width:w,height,color},opt);
      h.object.material.uniforms.tInput.value=tex; r.setRenderTarget(dst); r.render(h.object,camera);
      if (r.getRenderTarget()!==dst) throw new Error('目标未归还宿主');
      for (const [list,ref] of [[h.targets.down,cpu.down],[h.targets.up,cpu.up]]) {
        if(list.length!==ref.length) throw new Error('中间层数错误');
        list.forEach((rt,j)=>{
          const raw=new Uint16Array(rt.width*rt.height*4); r.readRenderTargetPixels(rt,0,0,rt.width,rt.height,raw);
          errors.push(ref[j].data.reduce((max,v,i)=>Math.max(max,Math.abs(v-T.DataUtils.fromHalfFloat(raw[Math.floor(i/3)*4+i%3]))),0));
        });
      }
      const out=new Float32Array(color.length); r.readRenderTargetPixels(dst,0,0,w,height,out);
      errors.push(out.reduce((m,v,i)=>Math.max(m,Math.abs(v-cpu.color[i])),0)); dst.dispose(); tex.dispose();
    }
    h.dispose(); r.dispose(); window.RESULT=errors;
    </script>`);
  const errors = await p.result();
  assert.equal(errors.length,16);
  assert.ok(errors.every(x => x !== null && x < 0.016), JSON.stringify(errors));
});
