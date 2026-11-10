// engine/form 的性质测试（Node，不开浏览器）：弯曲的 JS 镜像、放样、山石、表面散布、平面曲线。
// GPU 上 GLSL 与 JS 镜像逐像素对位的检查在 engine/look/gpu.test.mjs（R34）；这里管不需要 GPU 也能锁住的性质：
// 头部不动、整块弯曲是刚体变换、时间上按角频率周期、GLSL 拿到的就是传进来的参数；几何有限、确定、拓扑自洽。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mulberry, TAU } from '../../engine/core/math.js';
import { pitchWave, pitchYawWave, pitchYawLinearWave, frameWave } from '../../engine/form/bend.js';
import { profileBody, axisStations, ringsAt, loftRings, sideAngle } from '../../engine/form/loft.js';
import { spire, mesa } from '../../engine/form/rock.js';
import { weightedSampler, placeOnSurface, pickFrom } from '../../engine/form/scatter.js';
import { catmull, spiral } from '../../engine/form/curves.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const hashArr = a => { let h = 2166136261; for (const v of a) { h = Math.imul(h ^ Math.round(v * 1e6), 16777619); } return h >>> 0; };

// 四种弯曲形式的 uniform 名与一组非平凡的取值
const FORMS = {
  pitchWave: [pitchWave, ['T', 'Amp', 'Wave', 'Omega', 'HalfL']],
  pitchYawWave: [pitchYawWave, ['T', 'Amp', 'AmpZ', 'Wave', 'Omega', 'HalfL', 'PhZ']],
  pitchYawLinearWave: [pitchYawLinearWave, ['T', 'Amp', 'AmpZ', 'Wave', 'Omega', 'HalfL', 'PhZ']],
  frameWave: [frameWave, ['T', 'AmpY', 'AmpZ', 'Wave', 'Omega', 'HalfL', 'PhY']],
};
const VALS = { T: 0, Amp: 0.35, AmpY: 0.35, AmpZ: 0.3, Wave: 1.3, Omega: 2.2, HalfL: 2.5, PhZ: 0.5, PhY: 0.3 };
const uniformsOf = keys => { const U = {}; for (const k of keys) U['uFish' + k] = { value: VALS[k] }; return U; };
// 每种形式的「轴上一点的位移」：统一成 [dy, dz]
const dispOf = (name, J) => ({
  pitchWave: (x, t) => [J.dy(x, t), 0],
  pitchYawWave: (x, t) => J.d(x, t),
  pitchYawLinearWave: (x, t) => [J.dy(x, t), J.dz(x, t)],
  frameWave: (x, t) => J.off(x, t),
})[name];

test('弯曲 JS 镜像：头部不动、尾部摆幅不超过振幅、时间上按 2π / ω 周期、全程有限', () => {
  for (const [name, [form, keys]] of Object.entries(FORMS)) {
    const U = uniformsOf(keys), J = form('fish').js(U), D = dispOf(name, J), H = VALS.HalfL, per = TAU / VALS.Omega;
    const amp = Math.max(VALS.Amp ?? 0, VALS.AmpY ?? 0, VALS.AmpZ ?? 0);
    for (let i = 0; i <= 40; i++) {
      const t = i * 0.173;
      const head = D(H, t);
      assert.ok(close(head[0], 0) && close(head[1], 0), `${name}：头部（x = HalfL）t=${t} 位移 ${head}`);
      for (let k = 0; k <= 50; k++) {
        const x = H - k * (4 * H / 50), d = D(x, t), d2 = D(x, t + per);
        assert.ok(d.every(Number.isFinite), `${name}：x=${x} t=${t} 有限`);
        assert.ok(Math.abs(d[0]) <= amp + 1e-12 && Math.abs(d[1]) <= amp + 1e-12, `${name}：摆幅 ${d} 不超过振幅`);
        assert.ok(close(d[0], d2[0], 1e-9) && close(d[1], d2[1], 1e-9), `${name}：周期 2π/ω`);
      }
    }
  }
});

test('弯曲 JS 镜像：整块弯曲（rigid）是刚体变换，轴上的点落在该处的位移上', () => {
  const R = mulberry(34);
  for (const [name, [form, keys]] of Object.entries(FORMS)) {
    const U = uniformsOf(keys), J = form('fish').js(U), D = dispOf(name, J);
    for (let trial = 0; trial < 60; trial++) {
      const t = R() * 5, ax = (R() - 0.5) * 2 * VALS.HalfL;
      const on = J.rigid(new THREE.Vector3(ax, 0, 0), ax, t, new THREE.Vector3()), d = D(ax, t);
      assert.ok(close(on.x, ax, 1e-12) && close(on.y, d[0], 1e-12) && close(on.z, d[1], 1e-12), `${name}：轴上一点 → (ax, dy, dz)`);
      const p = new THREE.Vector3(ax + (R() - 0.5), (R() - 0.5), (R() - 0.5)), q = new THREE.Vector3(ax + (R() - 0.5), (R() - 0.5), (R() - 0.5));
      const P = J.rigid(p, ax, t, new THREE.Vector3()), Q = J.rigid(q, ax, t, new THREE.Vector3());
      assert.ok(close(P.distanceTo(Q), p.distanceTo(q), 1e-9), `${name}：整块弯曲保距（刚体）`);
    }
  }
});

test('弯曲：GLSL 拿到的就是传进来的形状参数（e0、sMax 原样写进着色器），uniform 名带前缀', () => {
  for (const [name, [form]] of Object.entries(FORMS)) {
    const f = form('eel', { e0: 0.31, sMax: 1.2 });
    assert.match(f.funcs, /smoothstep\( 0\.31, 1\.0, /, `${name}：e0`);
    assert.match(f.funcs, /0\.0, 1\.2 \)/, `${name}：sMax`);
    assert.match(f.unif, /uniform float uEelT/, `${name}：uniform 前缀`);
    assert.doesNotMatch(f.glsl, /uFish/, `${name}：不串前缀`);
  }
});

const fishBody = () => profileBody({ xs: [-2, -1, 0, 1, 2], top: [0.05, 0.4, 0.6, 0.45, 0.1], bottom: [-0.05, -0.3, -0.45, -0.35, -0.08], width: [0.03, 0.3, 0.45, 0.35, 0.06], exp: [2.2, 2.6] });

test('放样：超椭圆截面过顶线 / 底线 / 半宽，左右对称；环带网格拓扑自洽、确定', () => {
  const B = fishBody();
  for (const x of [-1.5, -0.3, 0.8]) {
    const top = B.point(x, Math.PI / 2, new THREE.Vector3()), bot = B.point(x, -Math.PI / 2, new THREE.Vector3()), side = B.point(x, 0, new THREE.Vector3());
    assert.ok(close(top.y, B.top(x), 1e-9) && close(bot.y, B.bottom(x), 1e-9), `x=${x}：背中线、腹中线`);
    assert.ok(close(side.z, B.width(x), 1e-9), `x=${x}：体侧 = 半宽`);
    const l = B.point(x, 0.7, new THREE.Vector3()), r = B.point(x, Math.PI - 0.7, new THREE.Vector3());
    assert.ok(close(l.y, r.y, 1e-9) && close(l.z, -r.z, 1e-9), `x=${x}：左右镜像`);
  }
  assert.ok(close(sideAngle(Math.cos(0.4), Math.sin(0.4)), sideAngle(Math.cos(Math.PI - 0.4), Math.sin(Math.PI - 0.4))), 'sideAngle 把左右折到同一侧');
  const xs = axisStations(-2, 2, 24, 0.6), nv = 18;
  assert.ok(close(xs[0], -2) && close(xs.at(-1), 2) && xs.every((x, i) => !i || x > xs[i - 1]), '站位单调、端点不动');
  const build = () => loftRings(ringsAt((x, ph) => B.point(x, ph, new THREE.Vector3()), xs, nv), { startCap: { p: new THREE.Vector3(-2.05, 0, 0) }, endCap: { p: new THREE.Vector3(2.05, 0, 0) } });
  const g = build(), pos = g.attributes.position.array, idx = g.index.array;
  assert.equal(pos.length / 3, xs.length * nv + 2, '每环 nv 个点 + 两个封口中心');
  assert.equal(idx.length, (xs.length - 1) * nv * 6 + 2 * nv * 3, '侧面两三角 / 格，封口一圈扇形');
  assert.ok(Math.max(...idx) < pos.length / 3 && pos.every(Number.isFinite));
  assert.equal(hashArr(pos), hashArr(build().attributes.position.array), '两次放样逐值相同');
});

test('山石：同一个种子两次生成逐值相同，几何有限、包围盒合理；换种子形状不同', () => {
  const geo = s => spire(mulberry(s), 10, 2, { steps: 4, NH: 30, NA: 32, seed: s });
  const a = geo(7), b = geo(7), c = geo(8);
  const pa = a.attributes.position.array;
  assert.ok(pa.every(Number.isFinite));
  assert.equal(hashArr(pa), hashArr(b.attributes.position.array), 'spire：同种子逐值相同');
  assert.notEqual(hashArr(pa), hashArr(c.attributes.position.array), '换种子形状不同');
  a.computeBoundingBox();
  const bb = a.boundingBox;
  assert.ok(bb.min.y >= -1e-9 && bb.max.y <= 10 * 1.05 && bb.max.y >= 10 * 0.8, `高度 ${bb.min.y}–${bb.max.y}`);
  assert.ok(Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z) <= 2 * 1.4, '底宽不超过半径的 1.4 倍');
  const m1 = mesa(mulberry(3), { cx: 0, cz: 0, rx: 4, rz: 3, yTop: () => 2, yBot: () => -1, NA: 40 }), m2 = mesa(mulberry(3), { cx: 0, cz: 0, rx: 4, rz: 3, yTop: () => 2, yBot: () => -1, NA: 40 });
  assert.equal(hashArr(m1.attributes.position.array), hashArr(m2.attributes.position.array), 'mesa：同种子逐值相同');
  assert.ok(m1.attributes.position.array.every(Number.isFinite));
});

test('表面散布：同种子同位置；placeOnSurface 让局部 +Y 朝法线、保持正交；pickFrom 不越界', () => {
  const geo = new THREE.IcosahedronGeometry(1, 3), n = geo.attributes.position.count;
  const w = new Float32Array(n).map((_, i) => (geo.attributes.position.getY(i) > 0 ? 1 : 0));
  const take = seed => { const s = weightedSampler(geo.clone(), null, seed), out = []; const p = new THREE.Vector3(), nn = new THREE.Vector3(); for (let i = 0; i < 50; i++) { s.sample(p, nn); out.push(p.x, p.y, p.z); } return out; };
  assert.deepEqual(take(5), take(5), '同种子同位置');
  // 按权重：权重属性只在上半球为 1 时，取样全在上半球
  const gw = geo.clone(); gw.setAttribute('w', new THREE.BufferAttribute(w, 1));
  const s = weightedSampler(gw, 'w', 9), p = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let i = 0; i < 200; i++) { s.sample(p, nn); assert.ok(p.y > -0.2, `按权重取样落在上半球：y=${p.y}`); }
  const m = placeOnSurface(new THREE.Vector3(1, 2, 3), new THREE.Vector3(0, 0, 1), { yaw: 0.7, scale: new THREE.Vector3(2, 2, 2), sink: 0.1 });
  const up = new THREE.Vector3(0, 1, 0).transformDirection(m);
  assert.ok(up.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-9, '局部 +Y 朝法线');
  const e = m.elements, cols = [0, 4, 8].map(o => new THREE.Vector3(e[o], e[o + 1], e[o + 2]));
  assert.ok(cols.every(c => close(c.length(), 2, 1e-9)) && close(cols[0].dot(cols[1]), 0, 1e-9) && close(cols[1].dot(cols[2]), 0, 1e-9), '等比缩放、正交');
  for (const r of [0, 0.5, 0.999999]) assert.ok(['a', 'b', 'c'].includes(pickFrom(r, ['a', 'b', 'c'])));
});

test('平面曲线：Catmull-Rom 加密过每个控制点；圆旋涡半径单调收向圆心', () => {
  const pts = [[0, 0], [10, 5], [20, -3], [30, 8]], out = catmull(pts, 8, false);
  for (let i = 0; i < pts.length - 1; i++) assert.deepEqual(out[i * 8].map(v => Math.round(v * 1e9) / 1e9), pts[i], `第 ${i} 个控制点`);
  assert.ok(out.flat().every(Number.isFinite));
  const sp = spiral(0, 0, 10, 2, 1, 0);
  let prev = Infinity;
  for (const [x, y] of sp) { const r = Math.hypot(x, y); assert.ok(r <= prev + 1e-9, '半径不增'); prev = r; }
});
