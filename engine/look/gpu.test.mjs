// engine 着色层（stage / form / shade / look）的 GPU 回归测试：node --test engine/look/gpu.test.mjs
// 本地起一个只读静态服务器（仓库根目录）+ 无头 Chrome（与 engine/render/page.mjs 同一套 BEIMING_ANGLE / BEIMING_CHROME），
// 每个用例是一张内存里的测试页，直接 import 仓库里的 engine 模块，在 GPU 上渲染后读回像素。
// 没装 chromium-headless-shell（npm run setup）时整组跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
// 测试页：模块脚本里的 import 必须在顶层，报错（加载失败、顶层 await 抛错）由前面的普通脚本兜住，写进 RESULT.error
const HEAD = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script>
window.addEventListener('error', e => { window.RESULT ??= { error: String(e.message || e) }; });
window.addEventListener('unhandledrejection', e => { window.RESULT ??= { error: String(e.reason && e.reason.stack || e.reason) }; });
</script>
</head><body style="margin:0;background:#000"><script type="module">
`;
const TAIL = `
</script></body></html>`;
const PAGES = {};

let browser = null, server = null, port = 0, skip = null;
test.before(async () => {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { skip = '没有 playwright-core'; return; }
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.startsWith('/__gpu__/')) { const body = PAGES[rel.slice(9)]; res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(body || ''); }
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); port = server.address().port;
  const angle = process.env.BEIMING_ANGLE || (process.platform === 'darwin' ? 'metal' : 'default');
  try {
    browser = await chromium.launch({ executablePath: process.env.BEIMING_CHROME || undefined, args: [...(angle === 'default' ? [] : [`--use-angle=${angle}`]), '--enable-gpu', '--ignore-gpu-blocklist'] });
  } catch (e) { skip = '无头 Chrome 起不来（先 npm run setup）：' + String(e.message).split('\n')[0]; }
});
test.after(async () => { await browser?.close(); server?.close(); });

async function run(name, body, { w = 400, h = 300, timeout = 120000 } = {}) {
  PAGES[name] = HEAD + body + TAIL;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text().slice(0, 200)); });
  try {
    await page.goto(`http://127.0.0.1:${port}/__gpu__/${name}`);
    await page.waitForFunction(() => window.RESULT !== undefined, null, { timeout });
    const r = await page.evaluate(() => window.RESULT);
    if (r.error) throw new Error(r.error);
    return Object.defineProperty(r, 'logs', { value: logs, enumerable: false });   // 控制台告警留着看，不混进结果的键
  } finally { await page.close(); }
}
const gpuTest = (title, fn) => test(title, async t => { if (skip) return t.skip(skip); await fn(); });

gpuTest('R30 抠像面片：半透明的部分和身后的透明底板混合，不和清屏色（黑）混合；遮罩照样写深度', async () => {
  const r = await run('r30', `
import * as THREE from 'three';
import { plate, cutoutPlane, canvasLayer } from '/engine/stage/plates.js';
import { aimCamera, fillScreen } from '/engine/stage/camera.js';
const W = 400, H = 200, renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, W / H, 1, 5000); aimCamera(cam, new THREE.Vector3(), 0, 0);
const sky = canvasLayer(64, 32); sky.ctx.fillStyle = '#9C8FD8'; sky.ctx.fillRect(0, 0, 64, 32); sky.tex.needsUpdate = true;
const skyP = plate(sky.tex, 0); scene.add(skyP); fillScreen(skyP, cam, W, H, 1000);
const b = canvasLayer(W, H); b.ctx.fillStyle = 'rgba(42,45,82,0.6)'; b.ctx.fillRect(20, 50, 110, 100); b.ctx.fillStyle = 'rgba(42,45,82,1)'; b.ctx.fillRect(270, 50, 110, 100); b.tex.needsUpdate = true;
const birds = cutoutPlane(b.tex, { order: 9, cut: 0.45 }); scene.add(birds); fillScreen(birds, cam, W, H, 30);
const gl = renderer.getContext(), px = (x, y) => { const a = new Uint8Array(4); gl.readPixels(x, H - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a); return [a[0], a[1], a[2]]; };
renderer.render(scene, cam); const semi = px(75, 100), opaque = px(325, 100);
const rt = new THREE.WebGLRenderTarget(W, H, { depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
renderer.setRenderTarget(rt); renderer.render(scene, cam);
const dm = new THREE.ShaderMaterial({ uniforms: { t: { value: rt.depthTexture } }, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }', fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = vec4(vec3(texture2D(t, vUv).x < .9999 ? 1. : 0.), 1.); }' });
const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dm); q.frustumCulled = false; const s2 = new THREE.Scene(); s2.add(q);
renderer.setRenderTarget(null); renderer.render(s2, cam);
window.RESULT = { semi, opaque, depthSemi: px(75, 100)[0] > 128, depthSky: px(200, 20)[0] > 128 };`);
  const want = [42, 45, 82].map((c, i) => 0.6 * c + 0.4 * [156, 143, 216][i]);   // 0.6 墨色 + 0.4 天空
  r.semi.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 3, `半透明处 ${r.semi} 应约为 ${want.map(Math.round)}`));
  assert.deepEqual(r.opaque, [42, 45, 82]);
  assert.equal(r.depthSemi, true, 'alpha ≥ cut 处仍写深度（Kuwahara 按它给前景小笔触）'); assert.equal(r.depthSky, false);
});

gpuTest('R31 bloom：同一个亮斑在 1040 与 2080 高的光晕剖面一致（相对画高）', async () => {
  const r = await run('r31', `
import * as THREE from 'three';
import { createFullscreen, renderTarget } from '/engine/look/pass.js';
import { createBloom } from '/engine/look/bloom.js';
const renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setPixelRatio(1); renderer.setSize(64, 64);
const fx = createFullscreen(renderer);
const DISC = fx.material('uniform vec2 uRes; varying vec2 vUv; void main(){ vec2 p = (vUv - .5) * uRes / uRes.y; gl_FragColor = vec4(vec3(length(p) < .01 ? 6. : 0.), 1.); }', { uRes: { value: new THREE.Vector2() } });
const COPY = fx.material('uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(t, vUv).rgb, 1.); }', { t: { value: null } });
function prof(W, H) {
  const src = renderTarget(W, H); DISC.uniforms.uRes.value.set(W, H); fx.draw(DISC, src);
  const b = createBloom(fx, { refHeight: 1080 }); b.resize(W, H);
  COPY.uniforms.t.value = b.render(src.texture, { threshold: .72, knee: .25, radius: .65 });
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType }); fx.draw(COPY, rt);
  const row = new Float32Array(W * 4); renderer.readRenderTargetPixels(rt, 0, H >> 1, W, 1, row);
  const at = r => row[Math.min(W - 1, Math.round(W / 2 + r * H)) * 4];
  let eOut = 0; for (let x = W / 2; x < W; x++) if ((x - W / 2) / H > .1) eOut += row[x * 4] / H;
  return { c: at(0), r10: at(.1), r25: at(.25), r35: at(.35), eOut };
}
window.RESULT = { a: prof(1920, 1040), b: prof(3840, 2080) };`, { timeout: 180000 });
  for (const k of ['c', 'r10', 'r25', 'r35', 'eOut']) {
    const ratio = r.b[k] / r.a[k];
    assert.ok(ratio > .9 && ratio < 1.12, `${k}：2080 / 1040 = ${ratio.toFixed(3)}（修改前中心 1.45、0.25H 处 0.03、0.35H 处 0）`);
  }
});

gpuTest('R32 原生 4K：纸纹与颗粒缩回 1040 后与 1040 直出一致（同样的纹理、同样的幅度）', async () => {
  const r = await run('r32', `
import * as THREE from 'three';
import { createLook } from '/engine/look/index.js';
const renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setPixelRatio(1); renderer.setSize(64, 64); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#8a7fb8');
const cam = new THREE.PerspectiveCamera(30, 1920 / 1040, 1, 100);
async function shot(W, H, p) {
  const look = createLook(renderer, W, H, { paperUrl: '/assets/plates/paper.png' }); await look.ready;
  const rt = new THREE.WebGLRenderTarget(W, H);
  look.render(scene, cam, { t: 1, outline: false, kuwahara: false, bloom: false, grade: false, vignette: 0, ...p, target: rt });
  const b = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, b); rt.dispose(); look.dispose();
  const L = new Float32Array(W * H); for (let i = 0; i < W * H; i++) L[i] = b[i * 4 + 1]; return L;
}
const down2 = (A, W, H) => { const w = W / 2, h = H / 2, o = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = 2 * y * W + 2 * x; o[y * w + x] = (A[i] + A[i + 1] + A[i + W] + A[i + W + 1]) / 4; } return o; };
function st(a, b) { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let va = 0, vb = 0, cv = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; va += x * x; vb += y * y; cv += x * y; } return { sa: Math.sqrt(va / n), sb: Math.sqrt(vb / n), corr: cv / Math.sqrt(va * vb) }; }
const out = {};
for (const [k, p] of [['paper', { paper: { strength: .14 }, grain: 0 }], ['grain', { paper: false, grain: .65 }]]) out[k] = st(await shot(1920, 1040, p), down2(await shot(3840, 2080, p), 3840, 2080));
window.RESULT = out;`, { timeout: 240000 });
  assert.ok(r.paper.corr > .95, `纸纹相关 ${r.paper.corr.toFixed(3)}（修改前约 0）`);
  assert.ok(r.grain.corr > .99, `颗粒相关 ${r.grain.corr.toFixed(3)}`);
  assert.ok(Math.abs(r.grain.sb / r.grain.sa - 1) < .03, `颗粒幅度比 ${(r.grain.sb / r.grain.sa).toFixed(3)}（修改前 0.5）`);
});

gpuTest('R33 卡通材质接 engine/look 的 ID 图：translucent 是软遮挡，noId 不挡线', async () => {
  const r = await run('r33', `
import * as THREE from 'three';
import { toonKind } from '/engine/shade/toon.js';
import { createIdPass } from '/engine/look/ids.js';
const W = 64, H = 64, renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setPixelRatio(1); renderer.setSize(W, H);
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 20); cam.position.set(0, 0, 5); cam.updateMatrixWorld();
const kind = toonKind({ name: 'gpu33' }), ids = createIdPass(renderer);
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
function idAt(front) {
  const scene = new THREE.Scene(), back = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial()); back.userData.outline = true; scene.add(back);
  front.position.z = 1; scene.add(front); renderer.setRenderTarget(null); renderer.render(scene, cam); ids.render(scene, cam, rt);
  const b = new Float32Array(4); renderer.readRenderTargetPixels(rt, W / 2, H / 2, 1, 1, b); return Array.from(b);
}
const plane = o => { const m = kind.make({ color: '#ff8040', ...o }), mesh = new THREE.Mesh(new THREE.PlaneGeometry(.8, .8), m); kind.bind(mesh, m, { outline: false }); return mesh; };
window.RESULT = { translucent: idAt(plane({ translucent: true, opacity: .5 })), noId: idAt(plane({ noId: true })) };`);
  r.translucent.forEach((v, i) => assert.ok(Math.abs(v - [1, 0, 1, .5][i]) < 1e-3, `translucent 读回 ${r.translucent}（修改前 1, 0.108, 0.526, 1）`));
  assert.deepEqual(r.noId, [1, 0, 1, 1], `noId 读回 ${r.noId}（修改前 0,0,0,0 实心挡线）`);
});

gpuTest('R33 回归 noId 只管材质自己：挂在下面的普通实心子网格照常挡线 / 继承描边，多材质只跳过 noId 那一组', async () => {
  const r = await run('r33c', `
import * as THREE from 'three';
import { toonKind } from '/engine/shade/toon.js';
import { createIdPass } from '/engine/look/ids.js';
const W = 64, H = 64, renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setPixelRatio(1); renderer.setSize(W, H);
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 20); cam.position.set(0, 0, 5); cam.updateMatrixWorld();
const kind = toonKind({ name: 'gpu33c' }), ids = createIdPass(renderer);
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
const at = (x, y) => { const b = new Float32Array(4); renderer.readRenderTargetPixels(rt, x, y, 1, 1, b); return Array.from(b); };
const draw = s => { renderer.setRenderTarget(null); renderer.render(s, cam); ids.render(s, cam, rt); };
// 描边底板（ID 1）铺满画面；前面摆要测的东西
const base = () => { const s = new THREE.Scene(), back = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), new THREE.MeshBasicMaterial()); back.userData.outline = true; s.add(back); return s; };
// noId 卡通父网格在左上（世界 -0.5, 0.5 → 像素 16, 48），普通不透明子网格挂在它下面、落在画面中心（像素 32, 32）
function family(outline) {
  const s = base(), m = kind.make({ noId: true }), parent = kind.bind(new THREE.Mesh(new THREE.PlaneGeometry(.4, .4), m), m, { outline });
  parent.position.set(-.5, .5, 1); s.add(parent);
  const child = new THREE.Mesh(new THREE.PlaneGeometry(.4, .4), new THREE.MeshBasicMaterial({ color: 0x336699 })); child.position.set(.5, -.5, 0); parent.add(child);
  draw(s); return { parent: at(16, 48), child: at(32, 32) };
}
// 一张面片两组材质：左上三角（像素 24, 40）是 noId 卡通材质，右下三角（像素 40, 24）是普通材质
// 软遮挡那组让 noId 材质也透明：它进透明队列、排在底板之后画，修改前沿用自身材质按软遮挡画，能读出差别
function multi(other, nOpts = {}) {
  const s = base(), g = new THREE.PlaneGeometry(1, 1); g.addGroup(0, 3, 0); g.addGroup(3, 3, 1);
  const mesh = new THREE.Mesh(g, [kind.make({ noId: true, ...nOpts }), other]); mesh.position.z = 1; s.add(mesh);
  draw(s); return { noId: at(24, 40), other: at(40, 24) };
}
window.RESULT = { off: family(false), on: family(true), solid: multi(new THREE.MeshBasicMaterial()),
  soft: multi(new THREE.MeshBasicMaterial({ transparent: true, opacity: .5 }), { transparent: true }) };`);
  const near = (a, b, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-3, `${what} 读回 ${a}，应为 ${b}`));
  near(r.off.parent, [1, 0, 1, 1], 'outline:false 的 noId 父网格（不挡线，透出底板）');
  near(r.off.child, [0, 0, 0, 0], '它下面的普通实心子网格（实心挡线；上一轮 1,0,1,1 被跳过）');
  near(r.on.parent, [1, 0, 1, 1], 'outline:true 的 noId 父网格（自己不描边；修改前 2,0,1,1）');
  near(r.on.child, [2, 0, 1, 1], '它下面的子网格（照常继承描边拿到 ID 2；上一轮 1,0,1,1 被跳过）');
  near(r.solid.noId, [1, 0, 1, 1], '多材质 noId 组（修改前 0,0,0,0 实心挡线）');
  near(r.solid.other, [0, 0, 0, 0], '多材质普通组（实心挡线）');
  near(r.soft.noId, [1, 0, 1, 1], '多材质 noId 组，另一组软遮挡（修改前沿用自身材质按软遮挡画，alpha 压成 0：1,0,1,0）');
  near(r.soft.other, [1, 0, 1, .5], '多材质软遮挡组（alpha 0.5 半挡）');
});

gpuTest('R34 / R36 弯曲：四种形式的 rigid 模式都能编译且与 JS 镜像对位；两套弯曲进同一个实例化材质；preBend 不带换行', async () => {
  const r = await run('r34', `
import * as THREE from 'three';
import * as B from '/engine/form/bend.js';
import { toonKind } from '/engine/shade/toon.js';
import { createIdPass } from '/engine/look/ids.js';
const W = 200, H = 200, renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true }); renderer.setPixelRatio(1); renderer.setSize(W, H); renderer.shadowMap.enabled = true;
let bad = 0; renderer.debug.onShaderError = () => bad++;
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 20); cam.position.set(0, 0, 5); cam.updateMatrixWorld();
const gl = renderer.getContext();
function draw(scene) { renderer.setRenderTarget(null); renderer.setClearColor(0, 1); renderer.render(scene, cam); const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let n = 0, sx = 0, sy = 0, h = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y * W + x) * 4; h = (h * 31 + px[k]) >>> 0; if (px[k] + px[k + 1] + px[k + 2] > 0) { n++; sx += x + .5; sy += y + .5; } }
  return { n, cx: n ? sx / n / W * 2 - 1 : 0, cy: n ? sy / n / H * 2 - 1 : 0, h }; }
const F = { pitchWave: ['T', 'Amp', 'Wave', 'Omega', 'HalfL'], pitchYawWave: ['T', 'Amp', 'AmpZ', 'Wave', 'Omega', 'HalfL', 'PhZ'], pitchYawLinearWave: ['T', 'Amp', 'AmpZ', 'Wave', 'Omega', 'HalfL', 'PhZ'], frameWave: ['T', 'AmpY', 'AmpZ', 'Wave', 'Omega', 'HalfL', 'PhY'] };
const V = { T: .7, Amp: .35, AmpY: .35, AmpZ: .3, Wave: 1, Omega: 2, HalfL: 1, PhZ: .5, PhY: .3 };
const rigid = {}; let i = 0;
for (const [name, keys] of Object.entries(F)) {
  const p = 'gq' + (i++), u = 'u' + p[0].toUpperCase() + p.slice(1), f = B[name](p), U = {}; for (const k of keys) U[u + k] = { value: V[k] };
  const b0 = bad, hk = f.modeHooks(U, { mode: 'rigid' }), kind = toonKind({ name: 'gpu34' + name }), mat = kind.make({ uniforms: U, side: THREE.DoubleSide, ...hk });
  const P = new THREE.Vector3(-.55, .15, .1), ax = -.65, g = new THREE.PlaneGeometry(.03, .03); g.translate(P.x, P.y, P.z);
  g.setAttribute('aAnchor', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(ax), 1));
  const mesh = new THREE.Mesh(g, mat); kind.bind(mesh, mat); mesh.userData.outlineVertex = hk.outlineVertex;
  const scene = new THREE.Scene(); scene.add(mesh); const L = new THREE.DirectionalLight(); L.position.set(1, 2, 3); L.castShadow = true; scene.add(L);
  const d = draw(scene); mesh.userData.outline = true;
  createIdPass(renderer).render(scene, cam, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) }));
  const e = f.js(U).rigid(P, ax, V.T, new THREE.Vector3());
  rigid[name] = { errors: bad - b0, pixels: d.n, dx: d.cx - e.x, dy: d.cy - e.y };
}
const Up = (p, a) => { const u = 'u' + p[0].toUpperCase() + p.slice(1); return { [u + 'T']: { value: .5 }, [u + 'Amp']: { value: a }, [u + 'Wave']: { value: 1 }, [u + 'Omega']: { value: 2 }, [u + 'HalfL']: { value: 1 } }; };
const join = (a, b) => { const o = {}; for (const k of ['vertexPars', 'vertexMainStart', 'vertexBegin', 'vertexNormal']) o[k] = (a[k] || '') + '\\n' + (b[k] || ''); return o; };
const geo = new THREE.BoxGeometry(.3, .3, .3), kind2 = toonKind({ name: 'gpu36' });
const inst = m => { const im = new THREE.InstancedMesh(geo, m, 2); im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-.5, 0, 0)); im.setMatrixAt(1, new THREE.Matrix4().makeTranslation(.5, 0, 0)); const s = new THREE.Scene(); s.add(im); return s; };
const b1 = bad;
const two = draw(inst(kind2.make({ uniforms: { ...Up('aa', .3), ...Up('bb', .2) }, ...join(B.pitchWave('aa').hooks(), B.pitchWave('bb').hooks()) })));
const twoZero = draw(inst(kind2.make({ uniforms: { ...Up('aa', .3), ...Up('bb', 0) }, ...join(B.pitchWave('aa').hooks(), B.pitchWave('bb').hooks()) })));
const single = draw(inst(kind2.make({ uniforms: Up('aa', .3), ...B.pitchWave('aa').hooks() })));
const nl = (() => { const s = new THREE.Scene(); s.add(new THREE.Mesh(new THREE.PlaneGeometry(.3, .3), kind2.make({ uniforms: Up('cc', .2), ...B.pitchWave('cc').hooks({ preBend: 'transformed.x += 0.0;', extraNormal: 'objectNormal = objectNormal;' }) }))); return draw(s); })();
window.RESULT = { rigid, two: two.n, twoZeroHash: twoZero.h, singleHash: single.h, twoErrors: bad - b1, noNewline: nl.n };`, { w: 200, h: 200 });
  for (const [name, v] of Object.entries(r.rigid)) {
    assert.equal(v.errors, 0, `${name} rigid 编译失败（修改前 pitchWave 等三种各 3 个程序报 BendRigid 未定义）`);
    assert.ok(v.pixels > 0, `${name} 画出来了`);
    assert.ok(Math.abs(v.dx) < .01 && Math.abs(v.dy) < .01, `${name} GPU 与 JS rigid 对位：${v.dx.toFixed(4)}, ${v.dy.toFixed(4)}`);
  }
  assert.equal(r.twoErrors, 0); assert.ok(r.two > 0, '两套弯曲的实例化网格画出来了（修改前宏重定义、整批不画）');
  assert.equal(r.twoZeroHash, r.singleHash, '第二套振幅为 0 时与单套逐像素相同（逐层复合）');
  assert.ok(r.noNewline > 0, 'preBend / extraNormal 不带换行也能编译');
});

gpuTest('R37 壁画层：本像素的结果不受相邻像素 toonMuralK 是否为 0 影响（导数在一致控制流里）', async () => {
  const r = await run('r37', `
import * as THREE from 'three';
import { muralLayer } from '/engine/shade/surface.js';
import { NOISE_GLSL } from '/engine/shade/noise.glsl.js';
const W = 128, H = 128, renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setPixelRatio(1); renderer.setSize(W, H);
const mat = new THREE.ShaderMaterial({ uniforms: { ...muralLayer.uniforms({ ...muralLayer.defaults, muralAmt: 1 }), uPattern: { value: 0 } }, depthTest: false,
  vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: muralLayer.pars + NOISE_GLSL + 'uniform float uPattern;\\nvoid main(){ vec4 diffuseColor = vec4(.55, .42, .33, 1.); vec3 vToonObj = vec3(gl_FragCoord.xy * .37, 2.);\\n' + muralLayer.vars + 'if (uPattern > .5 && mod(floor(gl_FragCoord.x), 2.) > .5) toonMuralK = 0.;\\n' + muralLayer.post + 'gl_FragColor = diffuseColor; }' });
const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); q.frustumCulled = false; const scene = new THREE.Scene(); scene.add(q);
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType });
const read = p => { mat.uniforms.uPattern.value = p; renderer.setRenderTarget(rt); renderer.render(scene, new THREE.Camera()); const b = new Float32Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, b); return b; };
const A = read(0), Bm = read(1); let changed = 0, keep = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y * W + x) * 4; const d = Math.max(Math.abs(A[k] - Bm[k]), Math.abs(A[k + 1] - Bm[k + 1]), Math.abs(A[k + 2] - Bm[k + 2]));
  if (x % 2 === 0) { if (d > 1e-6) changed++; } else if (Math.abs(Bm[k] - .55) < 1e-6 && Math.abs(Bm[k + 2] - .33) < 1e-6) keep++; }
window.RESULT = { changed, keep, total: W * H / 2 };`, { w: 128, h: 128 });
  assert.equal(r.changed, 0, `K > 0 的像素被邻列拖变了 ${r.changed} 个（修改前是全部）`);
  assert.equal(r.keep, r.total, 'K = 0 的像素不改色');
});

gpuTest('R40 / R42 ID 图：材质不可见的物体不挡线、不描边；反复 createLook → dispose 不漏 ID 程序，不删共享全屏几何', async () => {
  const r = await run('r40', `
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createIdPass } from '/engine/look/ids.js';
import { createLook } from '/engine/look/index.js';
const W = 64, H = 64, renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setPixelRatio(1); renderer.setSize(W, H);
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 20); cam.position.set(0, 0, 5); cam.updateMatrixWorld();
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
const ids = createIdPass(renderer);
const read = s => { ids.render(s, cam, rt); const b = new Float32Array(4); renderer.readRenderTargetPixels(rt, W / 2, H / 2, 1, 1, b); return Array.from(b); };
const scene = new THREE.Scene(), back = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial()); back.userData.outline = true; scene.add(back);
const ghost = new THREE.Mesh(new THREE.BoxGeometry(.6, .6, .6), new THREE.MeshBasicMaterial({ visible: false })); ghost.position.z = 1; scene.add(ghost);
const ghostId = read(scene);
let shared = 0; new FullScreenQuad(new THREE.MeshBasicMaterial())._mesh.geometry.addEventListener('dispose', () => shared++);
const s2 = new THREE.Scene(); for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(.2, .2, .2), new THREE.MeshBasicMaterial()); m.position.x = -.8 + i * .3; m.userData.outline = true; s2.add(m); }
const pc = new THREE.PerspectiveCamera(40, 1, .1, 20); pc.position.set(0, 0, 3); pc.updateMatrixWorld();
const used = [];
for (let k = 0; k < 3; k++) { const look = createLook(renderer, W, H, {}); await look.ready; look.render(s2, pc, { t: 0, target: new THREE.WebGLRenderTarget(W, H) }); look.dispose(); used.push(renderer.info.programs.reduce((a, p) => a + p.usedTimes, 0)); }
window.RESULT = { ghostId, used, shared };`, { w: 64, h: 64 });
  assert.deepEqual(r.ghostId, [1, 0, 1, 1], `隐形盒子挡在前面时读回 ${r.ghostId}（修改前 0,0,0,0）`);
  assert.equal(r.used[2], r.used[0], `程序引用数 ${r.used}（修改前每轮 +6）`);
  assert.equal(r.shared, 0, 'look.dispose 不再删 three 全局共享的全屏几何');
});

gpuTest('R43 程序化纸纹：画面小于 128 像素也量得到中性点；1040 与 2080 的中性点一致', async () => {
  const r = await run('r43', `
import * as THREE from 'three';
import { createFullscreen } from '/engine/look/pass.js';
import { createPaper } from '/engine/look/paper.js';
const renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setPixelRatio(1); renderer.setSize(64, 64);
const fx = createFullscreen(renderer), out = {};
for (const [w, h] of [[160, 96], [127, 720], [1920, 1040], [3840, 2080]]) {
  const p = createPaper(fx, renderer, { refHeight: 1080 }); p.resize(w, h); p.prepare();
  const b = new Uint8Array(w * h * 4); renderer.readRenderTargetPixels(p.target, 0, 0, w, h, b); let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i] / 255;
  out[w + 'x' + h] = { mid: p.layer({ strength: .12 }).mid, mean: s / (w * h) }; p.dispose();
}
window.RESULT = out;`, { timeout: 180000 });
  for (const [k, v] of Object.entries(r)) assert.ok(Math.abs(v.mid - v.mean) < .005, `${k}：中性点 ${v.mid.toFixed(4)}，整幅均值 ${v.mean.toFixed(4)}（修改前小画面是 0）`);
  assert.ok(Math.abs(r['1920x1040'].mid - r['3840x2080'].mid) < .002, '换分辨率中性点不漂（修改前 0.529 / 0.538）');
});

gpuTest('R35 墨线：宽线、farScale > 1 时在 2080 高与 1040 高的线宽占画高一致（圆头笔不被搜索窗截掉）', async () => {
  const r = await run('r35', `
import * as THREE from 'three';
import { createLook } from '/engine/look/index.js';
const renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setPixelRatio(1); renderer.setSize(64, 64);
const scene = new THREE.Scene(), sq = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: '#888' })); sq.userData.outline = true; sq.position.z = -5; scene.add(sq);
async function lw(W, H, ol) {
  const cam = new THREE.OrthographicCamera(-W / H, W / H, 1, -1, .1, 100), look = createLook(renderer, W, H, { ss: 2 }); await look.ready;
  look.render(scene, cam, { t: 0, outline: { wobble: 0, breakup: 0, pressure: 0, near: 1, far: 2, ...ol }, kuwahara: false, bloom: false, paper: false, vignette: 0, grain: 0, target: new THREE.WebGLRenderTarget(W, H) });
  const L = look.targets.line, b = new Uint8Array(L.width * 4); renderer.readRenderTargetPixels(L, 0, L.height >> 1, L.width, 1, b);
  let s = 0; for (let x = 0; x < L.width / 2; x++) s += b[x * 4] / 255; look.dispose(); return s / 2 / H;
}
const out = {}; for (const [k, ol] of Object.entries({ w6: { width: 6, farScale: 1 }, far3: { width: 2.6, farScale: 3 } })) out[k] = (await lw(3840, 2080, ol)) / (await lw(1920, 1040, ol));
window.RESULT = out;`, { timeout: 180000 });
  for (const [k, v] of Object.entries(r)) assert.ok(Math.abs(v - 1) < .02, `${k}：2080 / 1040 线宽比 ${v.toFixed(3)}（修改前 w6 为 0.735、far3 为 0.833）`);
});
