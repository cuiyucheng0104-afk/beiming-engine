// engine/paint 的纯 JS 回归测试（不需要浏览器）：路径小语言（parsePath）与仿射矩阵（asMatrix）。
// 用法：node --test engine/paint/paint.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, samplePath } from './path.js';
import { apply, asMatrix, mul, zoomAt } from './affine.js';

const P = s => parsePath(s);

test('parsePath：小写相对命令、H/V 展开成绝对坐标（R56）', () => {
  assert.deepEqual(P('M 10 10 l 5 5 h 20 v 20 z'), [['M', 10, 10], ['L', 15, 15], ['L', 35, 15], ['L', 35, 35], ['Z']]);
  assert.deepEqual(P('m 1 2 3 4 z l 1 1'), [['M', 1, 2], ['L', 4, 6], ['Z'], ['L', 2, 3]]);
  assert.deepEqual(P('M0 0 H 5 V 6 h -1 v -1'), [['M', 0, 0], ['L', 5, 0], ['L', 5, 6], ['L', 4, 6], ['L', 4, 5]]);
  assert.deepEqual(P('M 1 1 c 1 0 2 1 2 2 q 1 1 2 0'), [['M', 1, 1], ['C', 2, 1, 3, 2, 3, 3], ['Q', 4, 4, 5, 3]]);
});

test('parsePath：S / T 取上一段控制点的反射', () => {
  assert.deepEqual(P('M0 0 C 1 1 2 2 3 3 S 5 5 6 6'), [['M', 0, 0], ['C', 1, 1, 2, 2, 3, 3], ['C', 4, 4, 5, 5, 6, 6]]);
  assert.deepEqual(P('M0 0 Q 1 1 2 0 T 4 0'), [['M', 0, 0], ['Q', 1, 1, 2, 0], ['Q', 3, -1, 4, 0]]);
  assert.deepEqual(P('M0 0 L 1 1 S 2 2 3 3'), [['M', 0, 0], ['L', 1, 1], ['C', 1, 1, 2, 2, 3, 3]]);
});

test('parsePath：指数记法、省略整数部分、正负号与连写数字', () => {
  assert.deepEqual(P('M 0 0 L 1e2 5'), [['M', 0, 0], ['L', 100, 5]]);
  assert.deepEqual(P('M10,20L30-40C1.5.5,2,3,4,5'), [['M', 10, 20], ['L', 30, -40], ['C', 1.5, 0.5, 2, 3, 4, 5]]);
  assert.deepEqual(P(`M ${0.1 + 0.2 - 0.3} 10 L 20 20`), [['M', 5.551115123125783e-17, 10], ['L', 20, 20]]);
  assert.deepEqual(P('M +3 -.5 L 5. 1E-1'), [['M', 3, -0.5], ['L', 5, 0.1]]);
});

test('parsePath：M 后省略命令按 L 读，开头省略 M 按 M 读（与旧写法兼容）', () => {
  assert.deepEqual(P('M 1 2 3 4 5 6'), [['M', 1, 2], ['L', 3, 4], ['L', 5, 6]]);
  assert.deepEqual(P('10 10 L 20 20'), [['M', 10, 10], ['L', 20, 20]]);
  assert.deepEqual(P('M 0 0 C 1 1 2 2 3 3 4 4 5 5 6 6'), [['M', 0, 0], ['C', 1, 1, 2, 2, 3, 3], ['C', 4, 4, 5, 5, 6, 6]]);
});

test('parsePath：不支持的命令、认不出的字符、坐标不够都报错，空串返回 []', () => {
  assert.throws(() => P('M0,0 A 5 5 0 0 1 10 10 L 20 20'), /弧线/);
  assert.throws(() => P('M 0 0 X 1 1'), /不认识的命令 X/);
  assert.throws(() => P('M 0 0 # 1'), /认不出来/);
  assert.throws(() => P('M 0 0 L 1'), /L 要 2 个数/);
  assert.throws(() => P('M 0 0 C 1 2 3'), /C 要 6 个数/);
  assert.throws(() => P('M 0 0 Z 5 5'), /Z 后面/);
  assert.throws(() => P(null), TypeError);
  assert.deepEqual(P(''), []);
  assert.deepEqual(P('  \n '), []);
});

test('parsePath：结果不含 NaN，采样不丢段', () => {
  const cmds = P('M 0 0 l 30 0 h 30 v 30 s 10 10 0 20 t -10 10 z');
  for (const c of cmds) for (const v of c.slice(1)) assert.ok(Number.isFinite(v), JSON.stringify(c));
  const pl = samplePath(cmds, 3)[0];
  assert.ok(pl.length > 40, `采样点只有 ${pl.length} 个`);
});

test('asMatrix：数组原样返回，DOMMatrix 形状取 a..f，别的类型报错（R50）', () => {
  const m = [2, 0, 0, 2, -32, -32];
  assert.equal(asMatrix(m), m);
  assert.deepEqual(asMatrix({ a: 2, b: 0, c: 0, d: 2, e: -32, f: -32, is2D: true }), m);
  assert.deepEqual(asMatrix(new Float64Array(m)), new Float64Array(m));
  assert.throws(() => asMatrix({ x: 1 }), TypeError);
  const dm = { a: 2, b: 0, c: 0, d: 2, e: -32, f: -32 };
  assert.deepEqual(apply(dm, [10, 10]), apply(m, [10, 10]));
  assert.deepEqual(mul(dm, [1, 0, 0, 1, 5, 5]), mul(m, [1, 0, 0, 1, 5, 5]));
  assert.deepEqual(zoomAt(32, 32, 2), m);
});
