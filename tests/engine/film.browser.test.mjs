// engine/stage/film.js 在真浏览器里的页面约定 v1（附录 C5）：渲染器注入 window.__RENDER = { fps, width, height, profile }，
// 页面按它出帧。逐帧照渲染器的方式调 render(f / fps)，核对：
//   · 24 / 25 / 30 fps 下页面帧号 = 输出帧号（没有未声明的重复或跳帧），一拍二 / 一拍三每张画停整数帧（不出现 2、3 帧交替）；
//   · 镜头拿到的 ctx（shotId、inFrame、localFrame、localT）；第一镜加长 12 帧，第二镜同一局部帧逐像素一致；
//   · 传了 paperUrl 却加载失败：页面报错、错误里带地址、READY 不置位；渲染器（engine/render/still.mjs）非零退出。
// 运行：node --test tests/engine/film.browser.test.mjs（没装 headless shell 时整组跳过；npm run setup 装）
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, HEAD, TAIL, ROOT } from './lib/browser.mjs';

let B = null;
test.before(async () => { B = await open(); });
test.after(async () => { if (B && !B.skip) await B.close(); });
const btest = (title, fn) => test(title, async t => { if (B.skip) return t.skip(B.skip); await fn(t); });

// 两镜头的夹具页：每帧 update 记下拿到的 (t, f, ctx) 与一拍二 / 一拍三的拍号；PAGE_OPTS 由各用例替换
const filmPage = ({ create = '{}', run = '{}', dur = 2, split = 0.5 } = {}) => HEAD + `
import * as THREE from 'three';
import { createFilm } from '/engine/stage/film.js';
import { hold, heldTime, filmFps } from '/engine/core/clock.js';
const film = createFilm(${create});
const REC = [];
const mk = name => {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  return { scene, camera, update(t, f, ctx) { REC.push({ name, t, f, h2: hold(f, 2), h3: hold(f, 3), ht2: heldTime(f, 2), ...ctx }); }, look: () => ({}) };
};
const post = { ready: Promise.resolve(), render(scene, camera) { film.renderer.render(scene, camera); } };
const fps0 = window.__RENDER ? window.__RENDER.fps : 24, N = Math.round(${dur} * fps0), cut = Math.round(N * ${split});
await film.run({ dur: ${dur}, shots: [{ in: 0, id: 'A', shot: mk('A') }, { in: cut, id: 'B', shot: mk('B') }], post, warm: [],
  texts: t => [{ id: 'cap', text: '北冥', x0: 10, y0: 20, x1: 110, y1: 60 }], ...${run} });
REC.length = 0;
const FPS = window.FPS, total = Math.round(window.DUR * FPS);
for (let f = 0; f < total; f++) window.render(f / FPS);     // 与渲染器相同：第 f 帧渲 t = f / FPS
window.RESULT = { rec: REC, FPS, total, cut, filmFps: filmFps(), fps: film.fps, W: film.W, H: film.H, K: film.K, DW: film.DW, DH: film.DH,
  design: film.design, fit: film.fit, output: film.output, gl: [film.renderer.domElement.width, film.renderer.domElement.height],
  overlay: [film.overlay.width, film.overlay.height], texts: window.TEXTS(0.5), ready: window.READY };
` + TAIL;

// 一串拍号的「每张停几帧」（最后一张可能被片尾截短，单独返回）
const runsOf = seq => { const r = []; let n = 0; for (let i = 0; i < seq.length; i++) { n++; if (i === seq.length - 1 || seq[i + 1] !== seq[i]) { r.push(n); n = 0; } } return { body: r.slice(0, -1), last: r.at(-1) }; };

for (const [fps, w, h, profile] of [[24, 320, 180, 'web-1080p24'], [25, 320, 180, 'broadcast-1080p25'], [30, 180, 320, 'vertical-1080x1920-30']]) {
  btest(`__RENDER ${fps} fps ${w}×${h}：页面帧号 = 输出帧号，一拍二 / 一拍三每张停 2 / 3 帧，镜头 ctx 与画幅都按注入的值`, async () => {
    const pg = await B.page(`film-${fps}`, filmPage({ create: '{ designWidth: 1920, designHeight: 1080 }' }), { w, h, init: { __RENDER: { fps, width: w, height: h, profile } } });
    try {
      const r = await pg.result();
      assert.equal(r.ready, true);
      assert.equal(r.FPS, fps, 'window.FPS = 注入的帧率（渲染器据此核对）');
      assert.equal(r.fps, fps); assert.equal(r.filmFps, fps, 'clock 的影片帧率同步设好');
      assert.equal(r.total, 2 * fps);
      assert.deepEqual(r.rec.map(x => x.f), Array.from({ length: r.total }, (_, k) => k), '页面帧号逐帧等于输出帧号：没有重复、没有跳帧');
      for (const n of [2, 3]) {
        const { body, last } = runsOf(r.rec.map(x => x[`h${n}`]));
        assert.ok(body.every(v => v === n) && last <= n, `${fps} fps 一拍 ${n}：每张停 ${n} 帧，实际 ${[...new Set(body)].join('/')}（末张 ${last}）`);
      }
      assert.ok(r.rec.every(x => Math.abs(x.ht2 * fps - 2 * Math.floor(x.f / 2)) < 1e-9), 'heldTime 按影片帧率换算');
      // 镜头 ctx
      const A = r.rec.filter(x => x.name === 'A'), Bs = r.rec.filter(x => x.name === 'B');
      assert.equal(A.length, r.cut); assert.equal(Bs.length, r.total - r.cut);
      for (const [list, id, inF, outF] of [[A, 'A', 0, r.cut], [Bs, 'B', r.cut, r.total]]) {
        list.forEach((x, j) => {
          assert.ok(x.shotId === id && x.inFrame === inF && x.outFrame === outF && x.fps === fps, `${id} 第 ${j} 帧的 ctx`);
          assert.equal(x.localFrame, j, `${id} 的 localFrame 从 0 数`);
          assert.equal(x.localT, j / fps, `${id} 的 localT = localFrame / fps（逐位）`);
        });
      }
      // 画幅：实际像素取注入的宽高；设计稿 1920×1080 按 contain 整块装进画面
      assert.equal(r.W, w); assert.equal(r.H, h);
      assert.deepEqual(r.gl, [w, h]); assert.deepEqual(r.overlay, [w, h]);
      assert.deepEqual(r.output, { width: w, height: h, profile, injected: true });
      assert.equal(r.fit, 'contain'); assert.equal(r.K, Math.min(w / 1920, h / 1080));
      assert.ok(r.design.w === 1920 && r.design.h === 1080 && r.design.x >= -1e-9 && r.design.y >= -1e-9, '设计稿不出画');
      // TEXTS：页面约定 v1 的 box 与 alpha
      assert.deepEqual(r.texts, [{ id: 'cap', text: '北冥', x0: 10, y0: 20, x1: 110, y1: 60, box: [10, 20, 100, 40], alpha: 1 }]);
    } finally { await pg.close(); }
  });
}

btest('没有注入 __RENDER：按 24 fps、视口尺寸（与改动前相同）；页面自己写 fps 时以页面为准，window.FPS 报给渲染器核对', async () => {
  const a = await B.page('film-none', filmPage(), { w: 200, h: 100 });
  try {
    const r = await a.result();
    assert.equal(r.FPS, 24); assert.equal(r.W, 200); assert.equal(r.H, 100); assert.equal(r.K, 1);
    assert.deepEqual(r.output, { width: 200, height: 100, profile: null, injected: false });
  } finally { await a.close(); }
  const b = await B.page('film-page-fps', filmPage({ run: '{ fps: 24 }' }), { w: 200, h: 100, init: { __RENDER: { fps: 30, width: 200, height: 100 } } });
  try {
    const r = await b.result();
    assert.equal(r.FPS, 24, '页面写死 24：window.FPS = 24，与注入的 30 不一致，由渲染器拒绝出片（不在页面里悄悄改）');
  } finally { await b.close(); }
  const c = await B.page('film-bad-render', filmPage(), { w: 200, h: 100, init: { __RENDER: { fps: '30' } } });
  try {
    await assert.rejects(c.result(), /__RENDER\.fps 要是正数/, '注入的格式不对：页面直接报错，不按 24 fps 悄悄渲');
  } finally { await c.close(); }
});

// 第二镜画一块随 ctx.localT 移动的方块（WebGL）与一行随 localFrame 变化的字（显示层）
const shiftPage = cut => HEAD + `
import * as THREE from 'three';
import { createFilm } from '/engine/stage/film.js';
const film = createFilm();
const mk = (color, move) => {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); camera.position.z = 5;
  scene.background = new THREE.Color(color);
  const sq = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial({ color: '#f2a0a6' })); scene.add(sq);
  return { scene, camera, update(t, f, ctx) { if (move) { sq.position.x = -0.8 + 0.9 * ctx.localT; sq.rotation.z = ctx.localFrame * 0.05; } }, look: () => ({}) };
};
const post = { ready: Promise.resolve(), render(scene, camera) { film.renderer.render(scene, camera); } };
await film.run({ dur: 4, shots: [{ in: 0, shot: mk('#4f5bbf', false) }, { in: ${cut}, id: 'B', shot: mk('#9c8fd8', true) }], post, warm: [],
  draw: (g, t, S, ctx) => { g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText(ctx.shotId + ':' + ctx.localFrame, 10, 30); } });
const gl = film.renderer.getContext(), W = film.W, H = film.H, px = new Uint8Array(W * H * 4);
const hash = a => { let h = 2166136261; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619); return (h >>> 0).toString(16); };
const out = [];
for (let j = 0; j < 24; j++) {
  window.render((${cut} + j) / window.FPS);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  out.push(hash(px) + '/' + hash(film.ctx.getImageData(0, 0, W, H).data));
}
window.RESULT = out;
` + TAIL;

btest('第一镜加长 12 帧：第二镜同一局部帧的画面（WebGL 与显示层）逐像素一致——镜头可以重排、改长', async () => {
  const init = { __RENDER: { fps: 24, width: 160, height: 90 } };
  const a = await B.page('shift-24', shiftPage(24), { w: 160, h: 90, init }), b = await B.page('shift-36', shiftPage(36), { w: 160, h: 90, init });
  try {
    const [ra, rb] = [await a.result(), await b.result()];
    assert.equal(new Set(ra).size, 24, '方块每帧都在动（不是同一张图）');
    assert.deepEqual(rb, ra);
  } finally { await a.close(); await b.close(); }
});

const paperPage = HEAD + `
import { createFilm } from '/engine/stage/film.js';
import { createLook } from '/engine/look/index.js';
import * as THREE from 'three';
const film = createFilm();
const look = createLook(film.renderer, film.W, film.H, { paperUrl: './missing-paper.png' });
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
await film.run({ dur: 1, shots: [{ in: 0, shot: { scene, camera, update() {}, look: () => ({}) } }], post: look, warm: [] });
window.RESULT = 'READY 不该到这里';
` + TAIL;

btest('传了 paperUrl 却加载失败：look.ready 拒绝，页面报错里带地址，READY 不置位（不再悄悄换成程序化纸纹）', async () => {
  const pg = await B.page('paper-missing', paperPage, { w: 160, h: 90, init: { __RENDER: { fps: 24, width: 160, height: 90 } } });
  try {
    await assert.rejects(pg.result(), e => /纸纹图加载失败/.test(e.message) && /missing-paper\.png/.test(e.message) && /\/__p13__\/missing-paper\.png/.test(e.message));
    assert.notEqual(await pg.page.evaluate(() => window.READY), true);
  } finally { await pg.close(); }
});

btest('渲染器对纸纹缺失的页面非零退出，报错带地址（node engine/render/still.mjs <夹具> 0）', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-still-'));
  try {
    const r = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'engine/render/still.mjs'), 'tests/engine/fixtures/paper-missing', '0', '--size', '160x90', '--out', out],
        { cwd: ROOT, env: { ...process.env, BEIMING_READY_TIMEOUT: '60' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => { err += d; });
      p.stdout.resume();
      const kill = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`渲染器 120 秒没退出：\n${err}`)); }, B.soft ? 360000 : 120000);
      p.on('error', reject);
      p.on('close', code => { clearTimeout(kill); resolve({ code, err }); });
    });
    assert.notEqual(r.code, 0, `应当非零退出，实际 ${r.code}`);
    assert.match(r.err, /纸纹图加载失败/);
    assert.match(r.err, /paper-missing\.png/, '报错里带纸纹地址');
    assert.deepEqual(fs.readdirSync(out), [], '失败时不留下静帧');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
