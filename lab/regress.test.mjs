// 正片源码（src/）的回归测试：node --test lab/regress.test.mjs
// 只测能在 Node 里跑的部分（three 的场景图、姿态、投影；不开 WebGL。2D 画布换成记录式假上下文，只比调用序列），
// 外加几条“别处按行号或清单引用 src/ 的地方仍然对得上”的核对。
// 画面层面的核对（逐帧单独重渲 = 顺序渲染、4K 与 1080p 光晕一致等）要用 engine/render 在浏览器里渲，见各条注释。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { frameOf, heldTime } from '../engine/core/clock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return null; } };

const fakeTex = (w = 2048, h = 1024) => { const t = new THREE.Texture(); t.image = { width: w, height: h }; return t; };
const PLATES = ['sky_dawn', 'sky_tall', 'shotB_sky', 'clouds_back', 'clouds_front_a', 'clouds_front_b', 'skyline_pudong', 'skyline_pudong_reflect', 'skyline_bund', 'river', 'mist_low'];
const fakePlates = () => Object.fromEntries(PLATES.map(n => [n, fakeTex()]));
const q0 = () => new URLSearchParams('');
const quats = kun => kun.fins.map(f => f.pivot.quaternion.toArray());
const LOOK = new THREE.Vector3(40, -260, -180);

// ── R15：setPose 不在调用之间留状态（胸鳍的欧拉角顺序是构建参数，不再被“看过镜头”改写） ──
for (const mod of ['kun.js', 'kun_refine.js']) {
  test(`${mod}：同一个 ts，新建后直接摆与先带 look 摆过别的时刻再摆，胸鳍完全相同`, async () => {
    const { createKun } = await import(`../src/${mod}`);
    for (const order of ['XYZ', 'YXZ']) {
      const a = createKun({ lod: 0.1, wisps: false, finEulerOrder: order });
      const b = createKun({ lod: 0.1, wisps: false, finEulerOrder: order });
      a.setPose(7.5);
      b.setPose(5.375, { look: LOOK }); b.setPose(6.25, { look: LOOK }); b.setPose(7.5);
      assert.deepEqual(quats(b), quats(a), `${order}：先带 look 摆过再摆 7.5 应与直接摆相同`);
      const c = createKun({ lod: 0.1, wisps: false, finEulerOrder: order });
      c.setPose(6.0, { look: LOOK }); const first = quats(c);
      c.setPose(6.0, { look: LOOK });
      assert.deepEqual(quats(c), first, `${order}：第一次带 look 的帧与重摆同一帧应相同`);
    }
    const x = createKun({ lod: 0.1, wisps: false, finEulerOrder: 'XYZ' }), y = createKun({ lod: 0.1, wisps: false, finEulerOrder: 'YXZ' });
    x.setPose(7.5); y.setPose(7.5);
    assert.notDeepEqual(quats(x), quats(y), 'finEulerOrder 应当生效（两种顺序的胸鳍不同）');
  });
}

// 各个鲲（含变体）的 setPose 都只依赖参数：整棵树的世界矩阵、可见性、CPU 形变的顶点、眼睛与时钟 uniform 全部相同
// （kun_bronze 的纹样要 Canvas2D，Node 里建不了；它的 setPose 只写 uniform，见源码）
const snapshot = kun => {
  kun.group.updateMatrixWorld(true);
  const out = [];
  kun.group.traverse(o => {
    out.push(o.name, o.visible, o.matrixWorld.elements.join(','));
    const a = o.isMesh && o.geometry?.attributes?.position?.array;
    if (a) { let h = 0; for (let i = 0; i < a.length; i += 3) h = (h * 31 + Math.round(a[i] * 1e5)) | 0; out.push(h); }
    const u = o.material?.userData?.toon;
    if (u) for (const k of ['uKunT', 'uWingT', 'uOpen', 'uLook', 'uLidU', 'uLidL', 'uCatch1', 'uCatch2']) if (u[k]) out.push(k + JSON.stringify(u[k].value));
  });
  return out;
};
for (const mod of ['kun', 'kun_refine', 'kun_qinglv', 'kun_xuan', 'kun_peng']) {
  test(`${mod}.js：setPose 与之前摆过什么无关`, async () => {
    const { createKun } = await import(`../src/${mod}.js`);
    const a = createKun({ lod: 0.15 }), b = createKun({ lod: 0.15 });
    a.setPose(7.5, { t: 7.5 });
    b.setPose(5.375, { look: LOOK, t: 5.375 }); b.setPose(2.0, { blink: 1, t: 2.0 }); b.setPose(7.5, { t: 7.5 });
    assert.deepEqual(snapshot(b), snapshot(a));
  });
}

test('镜头 C 的鲲按 YXZ 合成胸鳍（v1.0 成片的顺序），与渲染顺序无关', async () => {
  const { buildShotC } = await import('../src/shotC.js');
  const { createKun } = await import('../src/kun.js');
  const ref = createKun({ lod: 1, wisps: false, blinkPeriod: 4, blinkOffset: 2.375, finEulerOrder: 'YXZ' });
  const s1 = buildShotC({ W: 1920, H: 1040, tex: fakePlates(), q: q0() });
  const s2 = buildShotC({ W: 1920, H: 1040, tex: fakePlates(), q: q0() });
  s1.update(7.5, 180);                                             // 直接渲 7.5（之前没带 look 摆过）
  for (const t of [5.3, 6.0, 9.6]) s2.update(t, frameOf(t));       // 先渲带 look 的帧（预热里的 5.3）
  s2.update(7.5, 180);
  ref.setPose(heldTime(180, 3));
  assert.deepEqual(quats(s1.kun), quats(ref));
  assert.deepEqual(quats(s2.kun), quats(ref));
});

// ── R16：镜头 C 的城市暖光调哪些网格写成明确名单（照成片：身体、尾鳍、鳍上藤壶），?finwarm=1 才调胸鳍本身 ──
test('镜头 C 城市暖光：默认名单与成片一致，finwarm=1 换成胸鳍网格', async () => {
  const { buildShotC } = await import('../src/shotC.js');
  const val = (o) => { const u = o.material.userData.toon; return [u.uFillStep.value, u.uFillStep2.value, u.uFillW1.value, u.uFillAmt.value]; };
  const WARM = [0.38, 0.72, 0.5, 1.0];
  for (const finwarm of [false, true]) {
    const s = buildShotC({ W: 1920, H: 1040, tex: fakePlates(), q: new URLSearchParams(finwarm ? 'finwarm=1' : '') });
    const g = s.kun.group, by = n => g.getObjectsByProperty('name', n);
    for (const o of [...by('kun-body'), ...by('kun-flukes')]) assert.deepEqual(val(o), WARM, o.name);
    const barn = by('kun-fin-barnacles'), fins = s.kun.fins.map(f => f.mesh);
    assert.equal(barn.length, 2); assert.equal(fins.length, 2);
    for (const o of barn) assert.deepEqual(val(o), finwarm ? [0.45, 0.8, 0.45, 0.6] : WARM, 'kun-fin-barnacles');
    for (const o of fins) assert.deepEqual(val(o), finwarm ? WARM : [0.6, 0.94, 0.42, 0.6], '胸鳍网格');
    assert.deepEqual(val(by('kun-barnacles')[0]), [0.45, 0.8, 0.45, 0.6], '身上的藤壶不调');
  }
});

// ── R18：各鲲变体能经 makeKun 换进镜头 C；只有 { side, pivot } 刚体胸鳍才收远侧那片 ──
// kun_bronze 的纹样要用 Canvas2D 画，Node 里建不了，在浏览器里核对过（换进正片渲 5.3 / 7.5 / 9.6 无报错）。
for (const v of ['kun_xuan', 'kun_peng', 'kun_qinglv', 'kun_refine']) {
  test(`${v} 换进镜头 C：按预热时刻 update 不出错`, async () => {
    const { buildShotC } = await import('../src/shotC.js');
    const { createKun } = await import(`../src/${v}.js`);
    let made = null;
    const s = buildShotC({ W: 1920, H: 1040, tex: fakePlates(), q: q0(), makeKun: o => (made = createKun({ ...o, lod: 0.3 })) });
    assert.ok(made && s.kun === made, '镜头 C 应当用传进来的鲲');
    for (const t of [5.3, 7.5, 9.6]) s.update(t, frameOf(t));
    assert.ok(Array.isArray(s.kun.fins), 'fins 应是数组（没有刚体胸鳍时为空）');
    if (v === 'kun_peng') for (const w of s.kun.wings) { assert.equal(w.pivot.scale.x, 1, '翅膀不该被当成胸鳍收起'); assert.equal(w.pivot.visible, true); }
    assert.ok(s.hudState.nav.length > 0);
  });
}
test('kun.js：镜头 C 在 7.1–7.9 收起远侧胸鳍', async () => {
  const { buildShotC } = await import('../src/shotC.js');
  const s = buildShotC({ W: 1920, H: 1040, tex: fakePlates(), q: q0() });
  const far = s.kun.fins.find(f => f.side === -1);
  s.update(6.0, 144); assert.equal(far.pivot.scale.x, 1);
  s.update(9.6, frameOf(9.6)); assert.ok(Math.abs(far.pivot.scale.x - 0.1) < 1e-9); assert.equal(far.pivot.visible, false);
});

// ── R20：hudAt(t) 与 render(t) 交给 drawHUD 的完全相同，只依赖 t ──
test('镜头 C hudAt(t) = update(t) 的 hudState，且与之前算过哪一帧无关', async () => {
  const { buildShotC } = await import('../src/shotC.js');
  const s = buildShotC({ W: 1920, H: 1040, tex: fakePlates(), q: q0() });
  const snap = st => JSON.parse(JSON.stringify(st));
  const ref = {};
  for (let f = 120; f < 240; f++) { s.update(f / 24, f); ref[f] = snap(s.hudState); }
  for (let f = 239; f >= 120; f -= 7) {
    s.update(9.9, frameOf(9.9));                      // 先摆到别的时刻
    assert.deepEqual(snap(s.hudAt(f / 24)), ref[f], `f=${f}`);
  }
  const fresh = buildShotC({ W: 1920, H: 1040, tex: fakePlates(), q: q0() });
  assert.deepEqual(snap(fresh.hudAt(6.0)), ref[144]);
});

// ── R22：镜头分界只在 src/timeline.js 写一次；改起点后镜头整体平移，不冻帧 ──
test('镜头表：各模块的起点都取自 timeline.js', async () => {
  const { TIMELINE, DESIGN } = await import('../src/timeline.js');
  const { GIRL_SHOT } = await import('../src/girl.js');
  const { C_START } = await import('../src/shotC.js');
  const { HUD_T } = await import('../src/hud.js');
  assert.equal(GIRL_SHOT.start, TIMELINE.B);
  assert.equal(GIRL_SHOT.dur, TIMELINE.C - TIMELINE.B);
  assert.equal(C_START, TIMELINE.C);
  assert.equal(HUD_T.on, DESIGN.C);
  assert.equal(HUD_T.clockIn, DESIGN.C);
});
// 按改过的镜头表载入整套模块：把 src/ 复制到临时目录，只改 timeline.js 里 TIMELINE 那一行（平常改镜头表就是这么改），
// engine/ 与 node_modules/ 链回仓库。复制出来的每个模块都是新实例，载入时读到的就是改过的镜头表。
async function withTimeline(tl, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bm-timeline-')), links = ['engine', 'node_modules'].map(d => join(dir, d));
  try {
    cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
    ['engine', 'node_modules'].forEach((d, i) => symlinkSync(join(ROOT, d), links[i], 'junction'));
    const p = join(dir, 'src', 'timeline.js'), code = readFileSync(p, 'utf8'), re = /(export const TIMELINE = (?:Object\.freeze\()?)\{[^}]*\}/;
    assert.match(code, re, 'timeline.js 里找不到 TIMELINE 那一行');
    writeFileSync(p, code.replace(re, (m, head) => head + JSON.stringify(tl)));
    return await fn(f => import(pathToFileURL(join(dir, 'src', f)).href));
  } finally {
    for (const l of links) try { unlinkSync(l); } catch {}   // 先拆链接，再删临时目录（不碰仓库里的 engine/）
    rmSync(dir, { recursive: true, force: true });
  }
}
// 记录式 2D 上下文：调用与赋值按顺序记下（数字保留 6 位）；measureText 给确定的假度量（宽 = 字数 × 0.6 字号）
function recCtx() {
  const log = [], num = v => typeof v === 'number' ? +v.toFixed(6) : v, box = { font: '10px x' };
  const ctx = new Proxy(box, {
    get(o, k) {
      if (k === 'measureText') return str => { const px = parseFloat(/([\d.]+)px/.exec(o.font)[1]); return { width: [...str].length * px * 0.6, actualBoundingBoxAscent: px * 0.8, actualBoundingBoxDescent: px * 0.2 }; };
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return (...a) => { log.push([k, a.map(num)]); const id = `${k}#${log.length}`; return { addColorStop: (...b) => log.push([id, b.map(num)]), toString: () => id }; };
      return k in o ? o[k] : (...a) => { log.push([k, a.map(num)]); };
    },
    set(o, k, v) { o[k] = v; log.push(['=' + String(k), typeof v === 'object' ? String(v) : num(v)]); return true; },
    has: () => true,   // 'letterSpacing' in ctx
  });
  return { ctx, log };
}
// hud.js 量字用 document.createElement('canvas')：Node 里换成记录式上下文
async function withDoc(fn) {
  const had = 'document' in globalThis, keep = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => recCtx().ctx }), fonts: { check: () => true } };
  try { return await fn(); } finally { if (had) globalThis.document = keep; else delete globalThis.document; }
}
const close = (a, b, msg) => { const r = (k, v) => typeof v === 'number' ? +v.toFixed(6) : v; assert.equal(JSON.stringify(a, r), JSON.stringify(b, r), msg); };

test('镜头 C 起点改到 4.75：整段编排（含显示层、片名）提前 0.25 秒，4.75 起就在动', async () => {
  const { buildShotC } = await import('../src/shotC.js');
  const hud = await import('../src/hud.js');
  const base = buildShotC({ W: 1920, H: 1040, tex: fakePlates(), q: q0() });
  await withTimeline({ A: 0, B: 2.75, C: 4.75, end: 10 }, async imp => {
    const { buildShotC: build2, C_START } = await imp('shotC.js');
    const { GIRL_SHOT } = await imp('girl.js');
    const hud2 = await imp('hud.js');
    assert.equal(C_START, 4.75); assert.equal(GIRL_SHOT.start, 2.75); assert.equal(GIRL_SHOT.dur, 2);
    const moved = build2({ W: 1920, H: 1040, tex: fakePlates(), q: q0() });
    const seen = new Set();
    await withDoc(() => {
      for (const k of [0, 1, 6, 11, 15, 24, 40, 52, 70, 90, 96, 106, 119]) {
        const t = 4.75 + k / 24, tu = 5 + k / 24;
        const s2 = moved.hudAt(t), s1 = base.hudAt(tu);
        close(s2, s1, `第 ${k} 帧 hudAt`);
        close(moved.kun.group.position.toArray(), (base.update(tu, frameOf(tu)), base.kun.group.position.toArray()), `第 ${k} 帧鲲的位置`);
        // 显示层和片名跟着镜头 C 平移：报的文字与方框、画显示层的每一笔都和原镜头表晚 0.25 秒的那一帧相同
        const texts = hud.textsAt(tu, 1920, 1040, s1);
        close(hud2.textsAt(t, 1920, 1040, s2), texts, `第 ${k} 帧 textsAt`);
        const a = recCtx(), b = recCtx();
        hud2.drawHUD(a.ctx, t, 1920, 1040, s2); hud.drawHUD(b.ctx, tu, 1920, 1040, s1);
        close(a.log, b.log, `第 ${k} 帧 drawHUD`);
        texts.forEach(x => seen.add(x.id)); if (b.log.length > 50) seen.add('drawn');
      }
    });
    for (const id of ['hud-recog', 'hud-nav', 'title', 'subtitle', 'drawn']) assert.ok(seen.has(id), `抽查的帧里应出现 ${id}（否则上面的比对是空比）`);
    // 起点之后前几帧鲲在走（旧写法会停在 5.0 的姿态上）
    moved.update(4.75, frameOf(4.75)); const p0 = moved.kun.group.position.clone();
    moved.update(4.75 + 6 / 24, frameOf(4.75 + 6 / 24));
    assert.ok(moved.kun.group.position.distanceTo(p0) > 0.1, '4.75–5.0 之间鲲应在移动');
  });
});
// 运行中改镜头表：镜头 C 的 C_START、main.js 的镜头切点都在载入时定下，所以运行中改了也不动；
// 显示层若现读镜头表就会单独平移（画面上显示层和鲲错开）。TIMELINE 冻结后赋值直接报错。
test('镜头表冻结：运行中给 TIMELINE 赋值抛 TypeError，显示层不会单独平移', async () => {
  const { TIMELINE } = await import('../src/timeline.js');
  const hud = await import('../src/hud.js');
  const { buildShotC } = await import('../src/shotC.js');
  const s = buildShotC({ W: 1920, H: 1040, tex: fakePlates(), q: q0() });
  await withDoc(() => {
    const keep = { ...TIMELINE }, at = t => hud.textsAt(t, 1920, 1040, s.hudAt(t)), before = [5.6, 7.5, 9.5].map(at);
    let err = null;
    try { TIMELINE.C = 4.75; } catch (e) { err = e; }
    try {
      assert.deepEqual([5.6, 7.5, 9.5].map(at), before, '运行中改了 TIMELINE.C 之后显示层平移了，镜头 C 却没动');
      assert.ok(err instanceof TypeError, '给冻结的 TIMELINE 赋值应抛 TypeError');
      assert.ok(Object.isFrozen(TIMELINE));
    } finally { if (!err) Object.assign(TIMELINE, keep); }
  });
});

// ── R24：航行灯左舷红、右舷绿（船头 +X、上 +Y 的右手系里右舷是 +Z） ──
test('渡船航行灯：红灯在左舷（−Z），绿灯在右舷（+Z）', async () => {
  const { createFerry } = await import('../src/ferry.js');
  const f = createFerry();
  const starboard = new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));   // 前 × 上 = 右舷
  // 用相机核对“右”：站在船上朝船头（+X）看，相机本地 +X 就是右手边
  const cam = new THREE.PerspectiveCamera(); cam.up.set(0, 1, 0); cam.lookAt(1, 0, 0); cam.updateMatrixWorld();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  assert.ok(right.distanceTo(starboard) < 1e-9);
  assert.ok(f.lights.green.position.dot(starboard) > 0, '绿灯应在右舷');
  assert.ok(f.lights.red.position.dot(starboard) < 0, '红灯应在左舷');
});

// ── R19：镜头 A 的鸽群画布按实际像素建（原生 4K 时 2 倍），每帧先缩放 K ──
test('镜头 A 鸽群画布：K = 2 时 3840×2080，绘制前 setTransform(2)', async () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (o, k) => k in o ? o[k] : (...a) => { calls.push([k, a]); }, set: (o, k, v) => { o[k] = v; return true; } });
  const made = [];
  globalThis.document = { createElement: () => { const c = { width: 0, height: 0, getContext: () => ctx }; made.push(c); return c; } };
  try {
    const { buildShotA } = await import('../src/shotA.js');
    for (const K of [1, 2]) {
      made.length = 0; calls.length = 0;
      const s = buildShotA({ W: 1920, H: 1040, K, tex: fakePlates(), q: q0() });
      assert.equal(made.length, 1);
      assert.deepEqual([made[0].width, made[0].height], [1920 * K, 1040 * K]);
      s.update(1.6, frameOf(1.6));
      assert.deepEqual(calls.find(c => c[0] === 'setTransform')[1], [K, 0, 0, K, 0, 0]);
    }
  } finally { delete globalThis.document; }
});

// ── R23：六个鲲的 fitShadow 共用 src/shadow.js ──
test('fitShadowTo：阴影相机罩住给定半径，法线偏移按缩放', async () => {
  const { fitShadowTo } = await import('../src/shadow.js');
  const g = new THREE.Group(); g.position.set(100, 50, -20); g.scale.setScalar(0.5);
  const light = new THREE.DirectionalLight(); light.position.set(1, 1, 0); light.target.position.set(0, 0, 0);
  fitShadowTo(light, g, { center: [-10, -5, 0], radius: 380, size: 2048, normalBias: 1.2 });
  const cam = light.shadow.camera, R = 380 * 0.5;
  assert.deepEqual([cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far], [-R, R, R, -R, R * 0.5, R * 5.5]);
  assert.equal(light.shadow.normalBias, 1.2 * 0.5);
  assert.equal(light.shadow.mapSize.x, 2048);
  const c = new THREE.Vector3(-10, -5, 0).applyMatrix4(g.matrixWorld);
  assert.ok(light.target.position.distanceTo(c) < 1e-9);
  assert.ok(Math.abs(light.position.distanceTo(c) - R * 3) < 1e-9);
});

// ── 站点按行号引用 src/hud.js 的片名骨架：site/js/brush-title.js 与 site/CONTRACT.md 写的是“第 284–309 行（SKEL、DRY）” ──
// hud.js 里 SKEL 之前多一行或少一行，这两处就指歪了（第一轮修 R20/R22 时出过一次）；站点那份 SKEL / DRY 是拷贝，两边也要逐笔相同。
// 站点文档改成不写行号时，这里没有可核对的行号，只核对拷贝。
const literal = (code, name) => {   // 源码里 `const 名字 = {…}` 的对象字面量（按花括号配对；里面只有数字、带引号的键和行尾注释）
  const i = code.indexOf(`const ${name} = {`); if (i < 0) return undefined;
  const start = code.indexOf('{', i); let k = start, depth = 0;
  for (; k < code.length; k++) { if (code[k] === '{') depth++; else if (code[k] === '}' && --depth === 0) break; }
  return Function(`return (${code.slice(start, k + 1)});`)();
};
test('站点文档引用的 src/hud.js 行号仍是 SKEL … __TITLE_SKEL，站点拷的骨架与片里一致', t => {
  const hudCode = read('src/hud.js'), lines = hudCode.split('\n'), at = n => lines[n - 1] ?? '';
  let refs = 0;
  for (const doc of ['site/js/brush-title.js', 'site/CONTRACT.md']) {
    for (const m of (read(doc) ?? '').matchAll(/src\/hud\.js`?\s*第\s*(\d+)\s*[–—-]\s*(\d+)\s*行/g)) {
      const a = +m[1], b = +m[2]; refs++;
      assert.match(at(a), /^const SKEL = \{/, `${doc} 说 src/hud.js 第 ${a} 行起是 SKEL，实际是：${at(a)}`);
      assert.ok(lines.slice(a - 1, b).some(l => /^const DRY = \{/.test(l)), `${doc} 说第 ${a}–${b} 行里有 DRY`);
      assert.match(at(b), /^export const __TITLE_SKEL = SKEL;/, `${doc} 说到第 ${b} 行（__TITLE_SKEL）为止，实际是：${at(b)}`);
    }
  }
  const site = read('site/js/brush-title.js');
  const copied = site && site.includes('const SKEL = {');
  if (copied) for (const name of ['SKEL', 'DRY']) assert.deepEqual(literal(site, name), literal(hudCode, name), `站点 brush-title.js 的 ${name} 与 src/hud.js 不一致`);
  t.diagnostic(`核对了 ${refs} 处行号引用${copied ? '，站点 SKEL / DRY 拷贝与 hud.js 相同' : ''}`);
});

// ── R26②：底板清单 assets/plates/plates.json 要和代码实际载入的一致（标了镜头的底板都有代码载入；显存说明的张数等于常驻张数） ──
// plates.json 不归 film-src 改，先记成 todo（失败不算整套失败）；资产负责人改好后这条会通过，届时去掉 todo。
test('plates.json 与实际载入的底板一致（main.js 的 NAMES + look.js 的纸纹）', () => {
  const J = JSON.parse(read('assets/plates/plates.json')), main = read('src/main.js');
  const NAMES = Function(`return ${/const NAMES = (\[[^\]]*\])/.exec(main)[1]}`)();
  const resident = [...NAMES, ...(/paperUrl:\s*'[^']+'/.test(main) ? ['paper'] : [])];
  for (const n of NAMES) assert.ok(J.plates.some(p => p.name === n), `main.js 载入的 ${n} 在 plates.json 里没有登记`);
  for (const p of J.plates) if ((p['镜头'] || []).length) assert.ok(resident.includes(p.name), `${p.name} 标了镜头 ${p['镜头']}，但没有代码载入它`);
  const n = /(\d+)\s*张全部常驻/.exec(J['通用设置']?.['显存'] || '');
  if (n) assert.equal(+n[1], resident.length, `显存说明写「${n[1]} 张全部常驻」，实际常驻 ${resident.length} 张`);
});
