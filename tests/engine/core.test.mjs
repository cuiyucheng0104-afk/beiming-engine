// engine/core 的性质测试（Node，不开浏览器）：math、clock、noise、stroke。
// 运行：node --test "tests/engine/**/*.test.mjs"（Node 24 的 node --test 不接受目录参数，要写成 glob）
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../engine/core/math.js';
import * as C from '../../engine/core/clock.js';
import { createNoise2D, createNoise3D } from '../../engine/core/noise.js';
import { inkStroke, brushOutline } from '../../engine/core/stroke.js';

// 确定性的取样：不用 Math.random，失败时可复现
const R = M.mulberry(20261110);
const samples = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('math：缓动与区间函数的端点、单调与值域', () => {
  for (const [name, f] of Object.entries({ ss: M.ss, ei: M.ei, eo: M.eo, eio: M.eio, ss5: M.ss5 })) {
    assert.equal(f(0), 0, `${name}(0)`); assert.equal(f(1), 1, `${name}(1)`);
    assert.equal(f(-3), 0, `${name} 夹住左端`); assert.equal(f(7), 1, `${name} 夹住右端`);
    let prev = -Infinity;
    for (let i = 0; i <= 1000; i++) { const v = f(i / 1000); assert.ok(v >= prev - 1e-15, `${name} 单调不减（i=${i}）`); prev = v; }
  }
  assert.equal(M.seg(5, 4, 6), 0.5); assert.equal(M.seg(3, 4, 6), 0); assert.equal(M.seg(9, 4, 6), 1);
  assert.equal(M.clamp(2), 1); assert.equal(M.clamp(-1, -0.5, 0.5), -0.5); assert.equal(M.lerp(2, 4, 0.25), 2.5);
  assert.equal(M.TAU, Math.PI * 2); assert.equal(M.DEG * 180, Math.PI);
});

test('math：hashi 是 [0, 1) 的确定性哈希，相邻整数不相关', () => {
  const v = samples(20000, i => M.hashi(i));
  for (const x of v) assert.ok(x >= 0 && x < 1);
  assert.deepEqual(samples(20000, i => M.hashi(i)), v, '同样的输入同样的输出');
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  assert.ok(Math.abs(mean - 0.5) < 0.01, `均值 ${mean}`);
  let c = 0; for (let i = 1; i < v.length; i++) c += (v[i] - 0.5) * (v[i - 1] - 0.5);
  assert.ok(Math.abs(c / v.length / (1 / 12)) < 0.03, '相邻值的相关系数接近 0');
});

test('math：mulberry 同种子同序列、不同种子不同序列，值域 [0, 1)', () => {
  const a = M.mulberry(7), b = M.mulberry(7), c = M.mulberry(8);
  const A = samples(5000, () => a()), B = samples(5000, () => b()), Cc = samples(5000, () => c());
  assert.deepEqual(A, B);
  assert.notDeepEqual(A.slice(0, 10), Cc.slice(0, 10));
  for (const x of A) assert.ok(x >= 0 && x < 1);
});

test('math：monotone 过关键帧、不过冲、在单调关键帧之间单调', () => {
  for (let trial = 0; trial < 200; trial++) {
    const n = 2 + Math.floor(R() * 7), keys = [];
    let t = R() * 2, v = R() * 10;
    const up = R() < 0.5;
    for (let i = 0; i < n; i++) { keys.push([t, v]); t += 0.1 + R() * 2; v += (up ? 1 : -1) * R() * 5 * (R() < 0.2 ? 0 : 1); }
    const f = M.monotone(keys);
    for (const [kt, kv] of keys) assert.ok(Math.abs(f(kt) - kv) < 1e-9, '过关键帧');
    assert.equal(f(keys[0][0] - 5), keys[0][1]); assert.equal(f(keys[n - 1][0] + 5), keys[n - 1][1]);
    const lo = Math.min(...keys.map(k => k[1])), hi = Math.max(...keys.map(k => k[1]));
    let prev = f(keys[0][0]);
    for (let i = 1; i <= 400; i++) {
      const x = keys[0][0] + (keys[n - 1][0] - keys[0][0]) * i / 400, y = f(x);
      assert.ok(y >= lo - 1e-9 && y <= hi + 1e-9, '不过冲');
      assert.ok(up ? y >= prev - 1e-9 : y <= prev + 1e-9, '单调');
      prev = y;
    }
  }
  assert.equal(M.monotone([[3, 7]])(100), 7, '单个关键帧是常数');
});

// ── clock ──
// 改动前的实现（engine/core/clock.js@c49da14），用来证明 24 fps 下数值逐位不变
const OLD = {
  frameOf: (t, fps = 24) => Math.round(t * fps),
  hold: (f, n) => Math.floor(f / n),
  heldTime: (f, n, fps = 24) => Math.floor(f / n) * n / fps,
  tick: (t, rate) => Math.floor(t * rate + 1e-6),
  snapTime: (t, rate) => Math.floor(t * rate + 1e-6) / rate,
};

test('clock：默认 24 fps 时 frameOf / hold / heldTime / tick / snapTime 与改动前逐位相同', () => {
  assert.equal(C.filmFps(), 24); assert.equal(C.REF_FPS, 24);
  const ts = [...samples(20000, () => (R() - 0.2) * 700), ...samples(2400, i => i / 24), ...samples(2400, i => i / 24 + 1e-9), ...samples(2400, i => i / 24 - 1e-9)];
  for (const t of ts) {
    assert.equal(C.frameOf(t), OLD.frameOf(t));
    for (const rate of [8, 12, 24, 5]) { assert.equal(C.tick(t, rate), OLD.tick(t, rate)); assert.equal(C.snapTime(t, rate), OLD.snapTime(t, rate)); }
  }
  for (let f = -500; f < 6000; f++) for (const n of [1, 2, 3, 4]) {
    assert.equal(C.hold(f, n), OLD.hold(f, n));
    assert.ok(Object.is(C.heldTime(f, n), OLD.heldTime(f, n)), `heldTime(${f}, ${n})`);
  }
});

test('clock：frameOf(f / fps) === f（24 / 25 / 30 / 60 fps，10 万帧）', () => {
  for (const fps of [24, 25, 30, 60]) for (let f = 0; f < 100000; f++) assert.equal(C.frameOf(f / fps, fps), f);
});

test('clock：25 / 30 fps 下一拍二、一拍三每张画停整数帧，不出现 2、3 帧交替', () => {
  try {
    for (const fps of [25, 30, 24]) {
      C.setFilmFps(fps);
      for (const n of [2, 3]) {
        const runs = [];
        let last = null, len = 0;
        for (let k = 0; k < fps * 20; k++) {
          const t = k / fps, f = C.frameOf(t);
          assert.equal(f, k, '页面帧号 = 输出帧号，没有重复');
          const h = C.hold(f, n), ht = C.heldTime(f, n);
          assert.equal(C.holdAt(t, n), h); assert.equal(C.heldAt(t, n), ht);
          assert.ok(Math.abs(ht * fps - Math.floor(k / n) * n) < 1e-9, 'heldTime 按影片帧率换算成秒');
          if (h === last) len++; else { if (last !== null) runs.push(len); last = h; len = 1; }
        }
        assert.ok(runs.every(r => r === n), `${fps} fps 一拍 ${n}：每张停 ${n} 帧，实际 ${[...new Set(runs)].join('/')}`);
      }
    }
    // 对照：按"每秒 12 张"（tick）在 30 fps 下必然 2、3 帧交替——所以按一拍 n 写画面时要用 hold / heldTime
    C.setFilmFps(30);
    const counts = {}; let prev = C.tick(0, 12), len = 0;
    for (let k = 0; k < 300; k++) { const v = C.tick(k / 30, 12); if (v === prev) len++; else { counts[len] = (counts[len] || 0) + 1; prev = v; len = 1; } }
    assert.deepEqual(Object.keys(counts).sort(), ['2', '3'], 'tick 与帧率无关（记录取舍）');
  } finally { C.setFilmFps(24); }
});

test('clock：setFilmFps 拒绝非正、非有限、非数字；holdFrames 把秒换成整数帧', () => {
  for (const bad of [0, -24, NaN, Infinity, '24', null, undefined, {}]) assert.throws(() => C.setFilmFps(bad), TypeError);
  assert.equal(C.filmFps(), 24, '拒绝后不改');
  assert.equal(C.holdFrames(1 / 12), 2); assert.equal(C.holdFrames(1 / 12, 25), 2); assert.equal(C.holdFrames(1 / 12, 30), 3);
  assert.equal(C.holdFrames(1 / 8, 24), 3); assert.equal(C.holdFrames(0.001, 24), 1, '至少 1 帧');
});

// ── noise ──
test('noise：不传种子直接报错（不会退回 Math.random）', () => {
  for (const make of [createNoise2D, createNoise3D]) {
    assert.throws(() => make(), { name: 'TypeError', message: /需要一个确定性随机函数.*mulberry/ });
    assert.throws(() => make(42), TypeError);
  }
});

test('noise：同种子逐值相同、不同种子不同，值域约 [-1, 1] 且全是有限数', () => {
  const a2 = createNoise2D(M.mulberry(7)), b2 = createNoise2D(M.mulberry(7)), c2 = createNoise2D(M.mulberry(9));
  const a3 = createNoise3D(M.mulberry(7)), b3 = createNoise3D(M.mulberry(7));
  let diff = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 50000; i++) {
    const x = (R() - 0.5) * 400, y = (R() - 0.5) * 400, z = (R() - 0.5) * 400;
    const v2 = a2(x, y), v3 = a3(x, y, z);
    assert.ok(Number.isFinite(v2) && Number.isFinite(v3));
    assert.ok(Object.is(v2, b2(x, y)) && Object.is(v3, b3(x, y, z)), '同种子同值');
    if (v2 !== c2(x, y)) diff++;
    lo = Math.min(lo, v2, v3); hi = Math.max(hi, v2, v3);
  }
  assert.ok(diff > 49000, '不同种子几乎处处不同');
  assert.ok(lo >= -1.0001 && hi <= 1.0001, `值域 [${lo}, ${hi}]`);
  assert.ok(lo < -0.6 && hi > 0.6, '用得到大部分值域');
});

// ── stroke ──
const wave = (n = 60) => samples(n + 1, i => [i * 6, 200 + 30 * Math.sin(i / 8), 0.5 + 0.3 * Math.sin(i / 11)]);

test('stroke：inkStroke 的输出锁定（改动前的实现 c49da14 上的哈希），单点画整圆、空输入返回空', () => {
  const h = pts => { let x = 0; for (const [a, b] of pts) x = (Math.imul(x, 31) + Math.round(a * 1000) * 7 + Math.round(b * 1000)) | 0; return [pts.length, x]; };
  assert.deepEqual(h(inkStroke(wave(), { size: 14, thinning: 0.6, streamline: 0.2, start: { taper: 30 }, end: { taper: 50 } })), INK_LOCK[0]);
  assert.deepEqual(h(inkStroke(wave(30), { size: 9 })), INK_LOCK[1]);
  assert.equal(inkStroke([[10, 10, 0.5]], { size: 8 }).length, 16);
  assert.deepEqual(inkStroke([]), []);
});
// 在 c49da14（改动前）上算出的值：inkStroke 不许被本包的改动影响
const INK_LOCK = [[124, -1583957250], [82, 1423821878]];

test('stroke：brushOutline 起收笔造型——露锋 / 出锋收成尖、藏锋笔头鼓在按笔方向一侧、两端有限闭合', () => {
  const pts = samples(41, i => [100 + i * 8, 300, 0.5]);
  const sharp = brushOutline(pts, { size: 20, entry: 'exposed', exit: 'exposed' });
  assert.ok(sharp.spine[0].r < 1e-3 && sharp.spine.at(-1).r < 1e-3, '露锋、出锋两端收成一点');
  const hid = brushOutline(pts, { size: 20, entry: 'hidden', exit: 'return' }), mid = hid.spine[Math.floor(hid.spine.length / 2)];
  assert.ok(hid.spine[0].r > mid.r * 1.05, '藏锋的笔头比笔身略鼓');
  assert.ok(hid.spine[0].rl > hid.spine[0].rr, '向右写的横画：鼓在下侧（左法线朝下，与右下 45° 的按笔方向同侧）');
  assert.equal(hid.spine[0].ny, 1, '左法线朝下');
  const sym = brushOutline(pts, { size: 20, entry: 'hidden', exit: 'return', slant: 0 });
  assert.ok(Math.abs(sym.spine[0].rl - sym.spine[0].rr) < 1e-12, 'slant = 0 两侧对称');
  const press = brushOutline(pts, { size: 20, entry: 'exposed', exit: 'press' }), n = press.spine.length;
  const peak = Math.max(...press.spine.slice(Math.floor(n * 0.6)).map(p => p.r));
  assert.ok(peak > mid.r * 1.15 && press.spine.at(-1).r < 1e-3, '顿笔：先按（鼓）后提（收尖）');
  for (const o of [sharp, hid, press]) for (const p of o.outline) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
  assert.ok(Math.abs(hid.length - 320) < 1e-6, `总长 ${hid.length}`);
  // 等距重采样：相邻中心线点的间距一致（除了最后一段）
  const gaps = hid.spine.slice(1).map((p, i) => p.s - hid.spine[i].s);
  assert.ok(gaps.slice(0, -1).every(g => Math.abs(g - gaps[0]) < 1e-6), '中心线按弧长等距');
});

test('stroke：brushOutline 确定性、单点画圆、非法参数报错', () => {
  const a = brushOutline(wave(), { size: 16, entry: 'hidden', exit: 'press' }), b = brushOutline(wave(), { size: 16, entry: 'hidden', exit: 'press' });
  assert.deepEqual(a, b);
  const one = brushOutline([[5, 5, 0.5]], { size: 10 });
  assert.equal(one.outline.length, 16); assert.equal(one.length, 0);
  assert.deepEqual(brushOutline([]), { outline: [], spine: [], length: 0 });
  assert.throws(() => brushOutline(wave(), { entry: 'zigzag' }), /entry/);
  assert.throws(() => brushOutline(wave(), { exit: 'hook' }), /exit/);
  assert.throws(() => brushOutline(wave(), { size: 0 }), /size/);
});
