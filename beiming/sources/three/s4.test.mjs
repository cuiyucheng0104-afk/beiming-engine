// S4：子帧累积和后期链的先后（04 §3.1、P7 探针表第 8 行）、快门参数、帧起点开快门的拖影中点。
// 纯函数部分不起浏览器；实渲部分起无头、静音的浏览器（起不了时跳过）：
//   一、自带页面直接调 createThreeSource，宿主装校准场景再挂一条自写的非线性后期链；
//   二、经页面宿主 startSource 渲一致性夹具 s01（calib/probe-moving-cube），和 calib/table/blender.json 的帧起点读数对拍。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromeArgs, chromeExecutable } from '../../../engine/render/lib/gpu.mjs';
import { resolveServed, startSource } from '../../host/page/host.mjs';
import { shotInput } from '../../kernel/eval/input.mjs';
import { caps } from './caps.mjs';
import { parseShutterArgs, planRender, shutterAngle, SourceError } from './plan.mjs';
import { averageDisplaySrgbFrames } from './source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '../../kernel/conformance/fixtures');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const SPEC = await readJson(join(FIXTURES, 'moving-cube.scene.json'));
const BLENDER = await readJson(join(HERE, '../../calib/table/blender.json'));
const CAPS = caps();
const code = (c) => (e) => e instanceof SourceError && e.code === c;
const [W, H] = [640, 360];

// ---------- 纯函数 ----------

test('命令行快门参数：--shutter 是快门角（度），--samples 是子帧采样数；没给的不出现', () => {
  assert.deepEqual(parseShutterArgs(['--shutter', '180', '--samples', '8']), { shutter: { angleDeg: 180, samples: 8 } });
  assert.deepEqual(parseShutterArgs(['x.json', '--samples=4', '--tier', 'final']), { shutter: { samples: 4 } });
  assert.deepEqual(parseShutterArgs([]), {});
  for (const argv of [['--shutter'], ['--samples', 'abc'], ['--shutter=']]) assert.throws(() => parseShutterArgs(argv), code('usage.bad-argument'), argv.join(' '));
  // 交给 planRender：快门从帧起点打开，子帧落在 [f, f + 角 / 360) 里，辅助层固定 sub = 0
  const p = planRender(CAPS, {}, [W, H], 'final', parseShutterArgs(['--shutter', '180', '--samples', '8']), ['color']);
  assert.deepEqual([p.angleDeg, p.shutterSamples, p.auxSub], [180, 8, 0]);
  assert.deepEqual(p.subs, [1, 3, 5, 7, 9, 11, 13, 15].map((k) => k / 32));
  assert.throws(() => planRender(CAPS, {}, [W, H], 'final', parseShutterArgs(['--shutter', '0', '--samples', '2']), ['color']), code('contract.shutter-conflict'));
});

test('快门角的兼容写法 angle：和 angleDeg 一样生效，两个都写又不相等报错', () => {
  assert.equal(shutterAngle({ angle: 90 }), 90);
  assert.equal(shutterAngle({ angle: 90, angleDeg: 90 }), 90);
  assert.equal(shutterAngle(undefined), undefined);
  assert.throws(() => shutterAngle({ angle: 90, angleDeg: 180 }), code('usage.bad-argument'));
  assert.deepEqual(planRender(CAPS, { shutter: { angle: 360, samples: 2 } }, [W, H], 'final', {}, ['color']).subs, [0.25, 0.75]);
  assert.equal(planRender(CAPS, { shutter: { angleDeg: 180 } }, [W, H], 'final', { shutter: { angle: 90, samples: 1 } }, ['color']).angleDeg, 90);
  assert.throws(() => planRender(CAPS, {}, [W, H], 'final', { shutter: { angle: 0, samples: 3 } }, ['color']), code('contract.shutter-conflict'));
  // 快门角只认 number：'0'、false 不能借隐式转换过值域
  for (const shutter of [{ angle: '0', samples: 2 }, { angle: false, samples: 1 }, { angleDeg: '180' }, { angleDeg: NaN }, { angleDeg: Infinity }]) {
    assert.throws(() => planRender(CAPS, {}, [W, H], 'final', { shutter }, ['color']), code('usage.bad-argument'), JSON.stringify(shutter));
  }
});

test('显示参考的子帧：8 位 sRGB 先线性化再平均，不是直接平均码值', () => {
  // 黑和白各一帧：线性平均是 0.5（码值 188 附近），直接平均码值会是 127.5（线性 0.21）
  const avg = averageDisplaySrgbFrames([new Uint8Array([0, 0, 0, 0]), new Uint8Array([255, 255, 255, 255])]);
  assert.deepEqual([...avg], [0.5, 0.5, 0.5, 0.5]);
  // 四个通道取互异的码值：RGB 走 sRGB 解码，透明度（半透明 128）只除以 255
  const eotf = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const mid = averageDisplaySrgbFrames([new Uint8Array([188, 10, 200, 128])]);
  [eotf(188 / 255), eotf(10 / 255), eotf(200 / 255), 128 / 255].forEach((v, c) => assert.ok(Math.abs(mid[c] - v) < 1e-7, `通道 ${c}：${mid[c]} 对 ${v}`));
  assert.throws(() => averageDisplaySrgbFrames([]), code('usage.bad-argument'));
  assert.throws(() => averageDisplaySrgbFrames([new Uint8Array(4), new Uint8Array(8)]), code('usage.bad-argument'));
});

// ---------- 实渲一：自带页面，挂自写的后期链 ----------

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{ "imports": { "three": "/node_modules/three-webgpu/build/three.module.js" } }</script>`;

/** 在页面里跑：装校准场景（规格 spec），挂后期链 chain，依次渲 jobs，交回各层的 base64 */
async function pageRun({ spec, chain, jobs }) {
  const THREE = await import('three');
  const { createThreeSource } = await import('/beiming/sources/three/source.js');
  const { calibShot } = await import('/beiming/kernel/conformance/fixtures/calib-scene.js');
  const fetchIn = 'texelFetch(tInput, ivec2(gl_FragCoord.xy), 0)';
  const FS = {
    // 亮部溢出：超过 1 的部分乘 0.5 加回。逐像素、非线性，解析期望就是 P(平均)
    overflow: `uniform sampler2D tInput; void main() { vec4 c = ${fetchIn}; gl_FragColor = vec4(c.rgb + 0.5 * max(c.rgb - 1.0, 0.0), c.a); }`,
    // 把后期链拿到的深度写出来：R 平面深度，G 打没打到
    depth: `uniform sampler2D tInput; uniform sampler2D tDepth; void main() { vec4 d = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0); gl_FragColor = vec4(d.r, d.a, ${fetchIn}.r, 1.0); }`,
    // 两个串起来、次序有关的通道：先 R 乘 2，再 G 加上（已乘过的）R
    gain: `uniform sampler2D tInput; void main() { vec4 c = ${fetchIn}; gl_FragColor = vec4(2.0 * c.r, c.gba); }`,
    mix: `uniform sampler2D tInput; void main() { vec4 c = ${fetchIn}; gl_FragColor = vec4(c.r, c.g + c.r, c.ba); }`,
    // 带动画参数的通道：B 加上 uTime（宿主 apply 时写 f + sub）
    animated: `uniform sampler2D tInput; uniform float uTime; void main() { vec4 c = ${fetchIn}; gl_FragColor = vec4(c.rg, c.b + uTime, c.a); }`,
    // 读深度但不改颜色的恒等通道
    depthId: `uniform sampler2D tInput; uniform sampler2D tDepth; void main() { gl_FragColor = ${fetchIn} + 0.0 * texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0); }`,
  };
  // 数 dispose：后期链每帧建的平均纹理、会话的浮点目标都要释放
  const disposed = { data: 0, targets: new Set() };
  const { dispose: dtDispose } = THREE.DataTexture.prototype, { dispose: rtDispose } = THREE.WebGLRenderTarget.prototype;
  THREE.DataTexture.prototype.dispose = function () { disposed.data++; return dtDispose.call(this); };
  THREE.WebGLRenderTarget.prototype.dispose = function () { disposed.targets.add(this); return rtDispose.call(this); };
  const pass = (name) => {
    const uniforms = { tInput: { value: null }, ...(['depth', 'depthId'].includes(name) ? { tDepth: { value: null } } : {}), ...(name === 'animated' ? { uTime: { value: -1 } } : {}) };
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: FS[name], blending: THREE.NoBlending, depthTest: false, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    return mesh;
  };
  const host = {
    now: () => performance.now(),
    async load() { return { object: calibShot(spec)({ THREE, params: {}, size: [640, 360] }), size: [640, 360], post: chain.map(pass) }; },
    apply: (loaded, f, sub) => { loaded.object.state(f, sub); for (const p of loaded.post) if (p.material.uniforms.uTime) p.material.uniforms.uTime.value = f + sub; },
    async measure() { return {}; },
  };
  const shot = { id: 's4', in: 0, out: 49, source: 'three', host: 'page', mode: 'native-code', shutter: { angleDeg: 180, samples: 8 }, tiers: { final: { samples: 1, scale: 1 } } };
  const session = await createThreeSource({ THREE, host }).open(shot, 'final', { seed: 1 });
  const b64 = (a) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const out = [];
  for (const j of jobs) {
    const { layers } = await session.render(j.f, j.opts, j.want ?? ['color']);
    out.push(Object.fromEntries(Object.entries(layers).map(([k, l]) => [k, b64(l.data)])));
  }
  const dataDuring = disposed.data;
  // setSize 换尺寸时渲染库自己也调 dispose，只数关会话那一下
  disposed.targets.clear();
  await session.close();
  THREE.DataTexture.prototype.dispose = dtDispose;
  THREE.WebGLRenderTarget.prototype.dispose = rtDispose;
  return { out, dataDisposed: dataDuring, targetsDisposed: disposed.targets.size };
}

async function withPage(t, fn) {
  const server = createServer(async (req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    const file = resolveServed(req.url), body = file && await readFile(file).catch(() => null);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(body);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  let browser;
  try {
    try { browser = await chromium.launch({ headless: true, executablePath: chromeExecutable(), args: [...chromeArgs(), '--mute-audio'] }); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return; }
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const run = async (arg) => {
      const { out, ...counts } = await page.evaluate(pageRun, arg).catch((e) => { throw new Error(`${e.message} ${errors.join('；')}`); });
      run.counts = counts;
      return out.map((layers) => Object.fromEntries(Object.entries(layers).map(([k, s]) => { const b = Buffer.from(s, 'base64'); return [k, new Float32Array(b.buffer, b.byteOffset, b.length / 4)]; })));
    };
    await fn(run);
  } finally {
    await browser?.close();
    await new Promise((ok) => server.close(ok));
  }
}

const P = (v) => v + 0.5 * Math.max(v - 1, 0);
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const SINGLE = { shutter: { angleDeg: 0, samples: 1 } };
// 180 度快门 8 个子帧的第 k 个 sub = (2k + 1) / 32，单独渲它用快门角 720 × sub、1 个采样
const SUB_K = (k) => ({ shutter: { angleDeg: 22.5 * (2 * k + 1), samples: 1 } });

test('实渲：静止场景 8 个子帧累积等于单个子帧（无后期 <= 1e-6，带非线性后期链 <= 1e-5）', async (t) => {
  const still = { ...SPEC, objects: SPEC.objects.map(({ motion, ...o }) => o) };
  await withPage(t, async (run) => {
    for (const [chain, tol] of [[[], 1e-6], [['overflow'], 1e-5]]) {
      const [acc, one] = await run({ spec: still, chain, jobs: [{ f: 24, opts: {} }, { f: 24, opts: SINGLE }] });
      assert.ok(maxDiff(acc.color, one.color) <= tol, `后期链 [${chain}]：${maxDiff(acc.color, one.color)}`);
      // 高光球的线性亮度 50 进了画面，后期链真的跑了
      assert.ok(acc.color.reduce((m, v) => Math.max(m, v), 0) >= (chain.length ? P(50) : 50) - 1e-3);
    }
  });
});

test('实渲：运动高光（亮度 50）过非线性后期链，先线性平均再跑一次后期 = 解析期望 P(平均)，和逐子帧后期再平均显著不同；后期拿到的深度是 sub = 0 的', async (t) => {
  await withPage(t, async (run) => {
    const jobs = [{ f: 24, opts: {} }, ...Array.from({ length: 8 }, (_, k) => ({ f: 24, opts: SUB_K(k) }))];
    const [plain, ...subs] = await run({ spec: SPEC, chain: [], jobs });
    const [posted] = await run({ spec: SPEC, chain: ['overflow'], jobs: [{ f: 24, opts: {} }] });
    // 无后期时累积就是各子帧的线性平均（逐子帧单渲对拍，子帧时刻对得上）
    const mean = plain.color.map((_, i) => subs.reduce((s, x) => s + x.color[i], 0) / 8);
    assert.ok(maxDiff(plain.color, mean) <= 1e-5, `累积对各子帧平均：${maxDiff(plain.color, mean)}`);
    const expected = plain.color.map(P), perSub = plain.color.map((_, i) => subs.reduce((s, x) => s + P(x.color[i]), 0) / 8);
    let worst = 0;
    for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(posted.color[i] - expected[i]) / Math.max(1, Math.abs(expected[i])));
    assert.ok(worst <= 1e-6, `对解析期望的相对差 ${worst}`);
    // 逐子帧后期再平均（旧做法）在高光拖影的边上差出一截：子帧里时而 50 时而 0.18，P(平均) 和平均(P) 差 0.5 × (1 − …)
    const gap = maxDiff(perSub, expected);
    assert.ok(gap > 0.1, `先后两种做法的最大差只有 ${gap}`);
    // 后期链声明了 tDepth：拿到的是 sub = 0 的平面深度（不随快门模糊）
    const [withDepth] = await run({ spec: SPEC, chain: ['depth'], jobs: [{ f: 24, opts: {}, want: ['color', 'depth'] }] });
    let hits = 0;
    for (let i = 0; i < W * H; i++) {
      const [d, hit] = [withDepth.color[i * 4], withDepth.color[i * 4 + 1]];
      if (hit) { hits++; assert.equal(d, withDepth.depth[i]); } else assert.equal(withDepth.depth[i], 1e10);
    }
    assert.ok(hits > 100);
  });
});

test('实渲：后期链多个通道依次全跑；带动画参数的通道取 sub = 0，加一个读深度的恒等通道结果逐像素不变；临时纹理和浮点目标都释放', async (t) => {
  await withPage(t, async (run) => {
    const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
    const [{ color: m }] = await run({ spec: SPEC, chain: [], jobs: [{ f: 24, opts: {} }] });
    const [{ color: two }] = await run({ spec: SPEC, chain: ['gain', 'mix'], jobs: [{ f: 24, opts: {} }] });
    // 平均纹理每帧一张、渲完就释放；会话关时释放 rt、rtPost
    assert.deepEqual(run.counts, { dataDisposed: 1, targetsDisposed: 2 });
    for (let i = 0; i < m.length; i += 4) {
      const want = [2 * m[i], m[i + 1] + 2 * m[i], m[i + 2], m[i + 3]];
      for (let c = 0; c < 4; c++) assert.ok(near(two[i + c], want[c]), `像素 ${i / 4} 通道 ${c}：${two[i + c]} 对 ${want[c]}`);
    }
    const [{ color: anim }] = await run({ spec: SPEC, chain: ['animated'], jobs: [{ f: 24, opts: {} }] });
    // 最后一个子帧是 24 + 15/32；后期通道的 uTime 应回到 sub = 0，就是 24
    for (let i = 2; i < m.length; i += 4) assert.ok(near(anim[i], m[i] + 24), `像素 ${(i - 2) / 4} 的 B：${anim[i]} 对 ${m[i] + 24}`);
    const [{ color: animDepth }] = await run({ spec: SPEC, chain: ['animated', 'depthId'], jobs: [{ f: 24, opts: {} }] });
    assert.equal(maxDiff(animDepth, anim), 0);
    // 要深度时多一个 rtDepth，关会话时也释放
    assert.deepEqual(run.counts, { dataDisposed: 1, targetsDisposed: 3 });
  });
});

// ---------- 实渲二：页面宿主，一致性夹具 s01 = calib/probe-moving-cube ----------

const lumaCentroid = (rgba) => {
  let s = 0, sx = 0, sy = 0;
  for (let i = 0; i < W * H; i++) {
    const l = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
    s += l; sx += l * ((i % W) + 0.5); sy += l * (Math.floor(i / W) + 0.5);
  }
  return [sx / s, sy / s];
};

test('实渲：匀速方块 180 度快门从帧起点开，拖影亮度质心在 f + 0.25，和 Blender 帧起点（START）读数一致；辅助层等于 sub = 0 不模糊的', async (t) => {
  let source;
  try { source = await startSource(); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-s4-'));
  try {
    const film = await readJson(join(FIXTURES, 'film.json'));
    const session = await source.open(shotInput(film, 's01'), { lock: null, tier: 'final', workspace, filmDir: FIXTURES });
    const AUX = ['depth', 'objectId', 'normal'];
    const blur = await session.render(24, {}, ['color', ...AUX]);
    const still0 = await session.render(24, SINGLE, ['color', ...AUX]);
    // 每帧像素速度用整帧位移（f = 24 到 25，都取 sub = 0）标定：Metal 的 SUBPIXEL_BITS 是 4（边缘量化 1/16 像素），
    // 拿 0.25 帧的短基线标定会把量化误差放大 4 倍（约 0.023 帧，< 0.03 帧）；整帧基线把它压到 0.02 帧容差以内
    const still1 = await session.render(25, SINGLE, ['color']);
    const read = async (ref) => {
      const b = await readFile(join(workspace, ref.file));
      assert.equal(ref.hash, `sha256:${createHash('sha256').update(b).digest('hex')}`);
      return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
    };
    await session.close();
    for (const name of AUX) assert.equal(blur.layers[name].hash, still0.layers[name].hash, `${name} 层应等于 sub = 0 不模糊的`);
    const [c, c0, c1] = await Promise.all([blur, still0, still1].map(async (r) => lumaCentroid(await read(r.layers.color))));
    // 像素读数和 Blender 同口径：整图亮度重心的位移加在方块 sub = 0 的期望像素 (320, 180) 上
    const phase = (c[0] - c0[0]) / (c1[0] - c0[0]), px = [320 + c[0] - c0[0], 180 + c[1] - c0[1]];
    const row = BLENDER.rows.find((r) => r.row === '快门相位').readings;
    const bPhase = row.find((x) => x.what === '拖影中点的相位（START）'), bPx = row.find((x) => /START/.test(x.what) && Array.isArray(x.got));
    t.diagnostic(`three 拖影中点 f + ${phase.toFixed(4)}，${px.map((v) => v.toFixed(4))} px；Blender START f + ${bPhase.got}，${bPx.got} px`);
    assert.ok(Math.abs(phase - 0.25) <= 0.02, `相位 ${phase}`);
    assert.ok(Math.abs(phase - bPhase.got) <= 0.02, `对 Blender 相位差 ${phase - bPhase.got}`);
    assert.ok(Math.abs(px[0] - bPx.expected[0]) <= 0.5 && Math.abs(px[0] - bPx.got[0]) <= 0.5 && Math.abs(px[1] - bPx.got[1]) <= 0.5, `拖影中点 ${px}`);
  } finally {
    await source.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});

