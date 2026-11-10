// engine/look、paint、overlay 里不碰 GPU 与画布的纯函数（Node）：
//   · 后期的颗粒 / 墨线沸腾的种子、颗粒格子、纸纹 layer 与锚点：默认参数下与改动前（abfdc83）的式子逐位相同，
//     新参数（holdFrames、size、boilHold、scaleMode、anchor）按影片帧率 / 分辨率工作；
//   · paint 的仿射矩阵、平滑曲线与弧长、毛笔飞白的笔毛干段、宣纸的亮度场与纤维清单；
//   · overlay 的倒角距离变换。
// 画到画布上的效果（毛笔一笔、宣纸）在 tests/engine/paint.browser.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry, hashi } from '../../engine/core/math.js';
import { createNoise2D } from '../../engine/core/noise.js';
import { brushOutline } from '../../engine/core/stroke.js';
import { grainSeedOf, grainCellOf, lookParams, LOOK_BASE } from '../../engine/look/index.js';
import { boilSeed } from '../../engine/look/ink.js';
import { paperAnchor } from '../../engine/look/paper.js';
import { mul, translate, rotate, scale, apply, chain, zoomAt } from '../../engine/paint/affine.js';
import { catmullRom, pointAt, spanPoints, project } from '../../engine/paint/curve.js';
import { dryRuns } from '../../engine/paint/brushwork.js';
import { xuanField, xuanFibers } from '../../engine/paint/xuan.js';
import { chamfer } from '../../engine/overlay/brush.js';

const R = mulberry(20261110);

test('look：颗粒种子与格子——不写 holdFrames / size 时与改动前逐位相同；holdFrames 按影片帧率每 n 帧换一次', () => {
  for (let i = 0; i < 20000; i++) {
    const t = R() * 600, fps = [24, 25, 30][i % 3];
    assert.equal(grainSeedOf(t, fps, null), Math.floor(t * fps + 1e-6), '默认：与 abfdc83 的 Math.floor(t * fps + 1e-6) 相同');
    assert.equal(grainSeedOf(t, fps, 1), Math.floor(t * fps + 1e-6));
  }
  for (const fps of [24, 25, 30]) for (const n of [2, 3]) {
    const seeds = Array.from({ length: fps * 4 }, (_, f) => grainSeedOf(f / fps, fps, n));
    const runs = []; let c = 1; for (let i = 1; i < seeds.length; i++) { if (seeds[i] === seeds[i - 1]) c++; else { runs.push(c); c = 1; } }
    assert.ok(runs.every(r => r === n), `${fps} fps holdFrames ${n}：每 ${n} 帧换一次`);
  }
  for (const kp of [1, 2, 3]) assert.equal(grainCellOf(null, kp * 0.97, kp), kp, '不写 size：格子 = 整数倍率（与改动前相同）');
  assert.equal(grainCellOf(1.5, 2, 2), 3); assert.equal(grainCellOf(1, 1.333, 1), 1); assert.equal(grainCellOf(0.2, 1, 1), 1, '至少 1 像素');
  assert.throws(() => lookParams({ grain: { amount: 0.1, holdFrames: 1.5 } }), /holdFrames/);
  assert.throws(() => lookParams({ grain: { amount: 0.1, size: 0 } }), /size/);
  const p = lookParams({ grain: 0.2 });
  assert.ok(p.grain === 0.2 && p.grainSize === null && p.grainHold === null, '数字写法：只有强度');
  assert.equal(LOOK_BASE.grain, 0, '默认不加颗粒');
});

test('墨线沸腾：不写 boilHold 时与改动前逐位相同；boilHold 按影片帧率每 n 帧沸一次', () => {
  for (let i = 0; i < 20000; i++) {
    const t = R() * 600, boilFps = [8, 12, 6][i % 3];
    assert.equal(boilSeed(t, { boilFps }), Math.floor(t * boilFps + 1e-6) % 100000);
  }
  for (const fps of [24, 25, 30]) {
    const s = Array.from({ length: fps * 2 }, (_, f) => boilSeed(f / fps, { boilFps: 12, boilHold: 2 }, fps));
    for (let f = 0; f < s.length; f++) assert.equal(s[f], Math.floor(f / 2), `${fps} fps 第 ${f} 帧`);
  }
  assert.throws(() => boilSeed(0, { boilHold: 0 }), /boilHold/);
});

test('纸纹锚点：paperAnchor 把两次屏幕投影换成 { pos, origin, zoom }；纸纹点 = (像素 − pos) / zoom + origin 随锚点走', () => {
  const ref = { x: 960, y: 540, s: 120 }, now = { x: 1010, y: 520, s: 150 };
  const a = paperAnchor(now, ref);
  assert.deepEqual(a, { pos: [1010, 520], origin: [960, 540], zoom: 1.25 });
  // 锚点在屏幕上从 ref 移到 now：now 处的纸纹点正是 ref 处原来的纸纹点（纸跟着画走）
  const paperAt = (px, py) => [(px - a.pos[0]) / a.zoom + a.origin[0], (py - a.pos[1]) / a.zoom + a.origin[1]];
  assert.deepEqual(paperAt(now.x, now.y), [ref.x, ref.y]);
  // 锚点附近一段长度按 zoom 放大
  const [u0] = paperAt(now.x, now.y), [u1] = paperAt(now.x + 150, now.y);
  assert.ok(Math.abs((u1 - u0) - 120) < 1e-9, '屏幕上 150 像素 = 铺纸那一帧的 120 像素');
  for (const bad of [null, { x: 1, y: 2 }, { x: 1, y: 2, s: 0 }, { x: NaN, y: 2, s: 1 }]) assert.throws(() => paperAnchor(bad, ref), TypeError);
});

test('paint/affine：与 Canvas 2D setTransform 同序；chain、zoomAt、旋转保距', () => {
  const m = chain(translate(10, 20), rotate(0.3), scale(2));
  const p = apply(m, [3, 4]);
  const c = Math.cos(0.3), s = Math.sin(0.3);
  assert.ok(Math.abs(p[0] - (10 + 2 * (3 * c - 4 * s))) < 1e-12 && Math.abs(p[1] - (20 + 2 * (3 * s + 4 * c))) < 1e-12, '先缩放、再旋转、再平移');
  assert.deepEqual(apply(zoomAt(100, 50, 3), [100, 50]), [100, 50], '缩放中心不动');
  const q = apply(mul(rotate(1.1), translate(0, 0)), [3, 4]);
  assert.ok(Math.abs(Math.hypot(...q) - 5) < 1e-12, '旋转保距');
  assert.deepEqual(apply({ a: 1, b: 0, c: 0, d: 1, e: 5, f: 6 }, [1, 1]), [6, 7], 'DOMMatrix 形状也收');
});

test('paint/curve：Catmull-Rom 过控制点；弧长取点单调、两端夹住；project 求最近点与侧向', () => {
  const sp = catmullRom([[0, 0], [100, 0], [200, 50], [300, 50]], 16);
  assert.deepEqual(sp.pts[0], [0, 0]); assert.deepEqual(sp.pts.at(-1).map(Math.round), [300, 50]);
  assert.ok(sp.L.every((v, i) => !i || v >= sp.L[i - 1]) && Math.abs(sp.total - sp.L.at(-1)) < 1e-9, '累计弧长单调');
  assert.deepEqual(pointAt(sp, -5), sp.pts[0]); assert.deepEqual(pointAt(sp, sp.total + 9), sp.pts.at(-1));
  const pts = spanPoints(sp, 10, 120, 7, d => d / 100);
  assert.ok(Math.abs(pts.at(-1)[2] - 1.2) < 1e-9, '末点落在 d1，带 f(d)');
  // project：用一条直的样条核对（弯的那条在第一段会往下鼓 3.7 像素，那是 Catmull-Rom 朝下一个控制点的正常走势）
  const line = catmullRom([[0, 0], [100, 0], [200, 0], [300, 0]], 16);
  const [dist, at, side] = project(line, 50, -10);
  assert.ok(Math.abs(dist - 10) < 1e-9 && Math.abs(at - 50) < 1e-9 && Math.abs(side) === 1, `最近点 ${dist} @ ${at}，侧 ${side}`);
  assert.equal(project(line, 50, 10)[2], -side, '另一侧符号相反');
  // 弯曲样条上：project 给的距离不大于到任何采样点的距离
  const [d2] = project(sp, 50, -10);
  assert.ok(sp.pts.every(([x, y]) => Math.hypot(x - 50, y + 10) >= d2 - 1e-9), '最近距离不大于到任何采样点的距离');
});

test('毛笔飞白 dryRuns：dry = 0 不露白；越到后段笔毛越枯，dry 越大越多；确定性', () => {
  const noise = createNoise2D(mulberry(17));
  const { spine } = brushOutline(Array.from({ length: 61 }, (_, i) => [i * 10, 200, 0.5]), { size: 30, entry: 'hidden', exit: 'return' });
  assert.deepEqual(dryRuns(spine, { size: 30, dry: 0, noise }), []);
  const dryLen = o => dryRuns(spine, { size: 30, noise, ...o }).reduce((s, b) => s + b.runs.reduce((a, [i0, i1]) => a + spine[i1].s - spine[i0].s, 0), 0);
  const lo = dryLen({ dry: 0.2 }), hi = dryLen({ dry: 0.8 });
  assert.ok(hi > lo * 1.5 && lo >= 0, `dry 0.2 → ${lo.toFixed(0)}，0.8 → ${hi.toFixed(0)}`);
  const runs = dryRuns(spine, { size: 30, dry: 0.7, dryFrom: 0.35, noise });
  const total = spine.at(-1).s;
  for (const b of runs) {
    assert.ok(b.off >= -1 && b.off <= 1 && b.depth >= 0.65 && b.depth <= 1 && b.width > 0);
    for (const [i0, i1] of b.runs) assert.ok(i1 > i0 && spine[i0].s / total >= 0.35 - 1e-9, '干段不早于 dryFrom');
  }
  assert.deepEqual(dryRuns(spine, { size: 30, dry: 0.7, noise: createNoise2D(mulberry(17)) }), runs, '同噪声种子同结果');
});

test('宣纸 xuanField / xuanFibers：平铺无缝、亮度对比克制（±5% 内）、纤维数量与尺度随 scale、确定性', () => {
  const W = 256, H = 192, f = xuanField({ width: W, height: H, seed: 3 });
  let lo = Infinity, hi = -Infinity, seamX = 0, seamY = 0, inner = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = f(x + 0.5, y + 0.5); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let y = 0; y < H; y++) { seamX += Math.abs(f(W - 0.5, y + 0.5) - f(0.5, y + 0.5)); inner += Math.abs(f(W / 2 - 0.5, y + 0.5) - f(W / 2 + 0.5, y + 0.5)); }
  for (let x = 0; x < W; x++) seamY += Math.abs(f(x + 0.5, H - 0.5) - f(x + 0.5, 0.5));
  assert.ok(lo > 0.94 && hi < 1.06, `亮度倍率 ${lo.toFixed(3)}–${hi.toFixed(3)}：宣纸的絮与帘纹远看几乎看不见`);
  assert.ok(seamX / H < (inner / H) * 1.6 && seamY / W < (inner / H) * 1.6, '四边接缝处的跳变与画面内部相邻像素同量级（无缝）');
  assert.equal(f(10.5, 20.5), f(10.5 + W, 20.5 + H), '按宽高周期');
  const a = xuanFibers({ width: 512, height: 512, seed: 2 }), b = xuanFibers({ width: 512, height: 512, seed: 2 }), c = xuanFibers({ width: 512, height: 512, seed: 2, scale: 2 });
  assert.deepEqual(a, b, '同种子同纤维');
  assert.ok(Math.abs(a.length / c.length - 4) < 0.2, '纤维数 ∝ 面积 / scale²');
  const len = l => l.reduce((s, x) => s + x.len, 0) / l.length;
  assert.ok(Math.abs(len(c) / len(a) - 2) < 0.4, '纤维长度 ∝ scale');
  assert.ok(a.every(x => x.alpha > 0 && x.alpha <= 0.26 && x.len >= 16 - 1e-9 && x.len <= 110 + 1e-9));
  const light = a.filter(x => x.light).length / a.length;
  assert.ok(light > 0.5 && light < 0.75, `透光纤维约六成：${light.toFixed(2)}`);
  assert.throws(() => xuanField({ width: 0 }), /正整数/);
});

test('overlay/brush 的 chamfer：形内到边缘的倒角距离——圆盘中心约等于半径，形外为 0', () => {
  const W = 81, H = 81, inside = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) inside[y * W + x] = Math.hypot(x - 40, y - 40) <= 30 ? 1 : 0;
  const d = chamfer(inside, W, H);
  assert.equal(d[0], 0, '形外 0');
  assert.ok(Math.abs(d[40 * W + 40] - 31) < 2.5, `圆心距离 ${d[40 * W + 40].toFixed(2)} ≈ 半径`);
  assert.ok(d[40 * W + 11] <= 2, '贴边的像素距离小');
  assert.ok(Math.abs(d[40 * W + 25] - d[25 * W + 40]) < 1e-6 && Math.abs(d[40 * W + 25] - d[40 * W + 55]) < 1e-6, '对称');
  assert.ok(hashi(1) !== hashi(2));
});
