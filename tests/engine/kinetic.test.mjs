// engine/overlay/kinetic.js 的性质测试（Node，不开浏览器）：12 个动效的静止态、起始态、纯函数性、种子，以及 progressOf 的四种次序。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFECTS, glyphState, progressOf, quantizeP, labelComponents } from '../../engine/overlay/kinetic.js';

const NAMES = Object.keys(EFFECTS);
const RANDOM = ['scramble', 'neon', 'pieceAssemble'];
const base = { i: 2, n: 6, seed: 1 };
const REST = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, alpha: 1 };

test('共 12 个动效，都有中文名与 per', () => {
  assert.equal(NAMES.length, 12);
  for (const k of NAMES) { assert.ok(EFFECTS[k].title); assert.ok(['glyph', 'piece'].includes(EFFECTS[k].per)); }
});

for (const name of NAMES) {
  test(`${name}：入场 p=1 静止，p=0 不可见或在起始态`, () => {
    const s1 = glyphState(name, { ...base, p: 1 });
    for (const k of Object.keys(REST)) assert.equal(s1[k], REST[k], `${name}.${k}`);
    const s0 = glyphState(name, { ...base, p: 0 });
    assert.ok(s0.alpha === 0, `${name} p=0 应不可见`);
  });
  test(`${name}：出场 p=0 静止，p=1 不可见`, () => {
    const s0 = glyphState(name, { ...base, p: 0, phase: 'out' });
    for (const k of Object.keys(REST)) assert.equal(s0[k], REST[k]);
    assert.equal(glyphState(name, { ...base, p: 1, phase: 'out' }).alpha, 0);
  });
  test(`${name}：纯函数，同参逐位相同，与求值顺序无关`, () => {
    const a = glyphState(name, { ...base, p: 0.7 }), b = glyphState(name, { ...base, p: 0.7 });
    assert.deepEqual(a, b);
    const x = glyphState(name, { ...base, p: 0.3 });
    glyphState(name, { ...base, p: 0.7 });
    assert.deepEqual(glyphState(name, { ...base, p: 0.3 }), x);
    // 出场就是入场反向
    assert.deepEqual(glyphState(name, { ...base, p: 0.3, phase: 'out' }), glyphState(name, { ...base, p: 0.7 }));
  });
}

for (const name of RANDOM) {
  test(`${name}：不同 seed 结果不同`, () => {
    const set = new Set();
    for (let s = 1; s <= 6; s++) set.add(JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7].map(i => glyphState(name, { ...base, i, p: 0.4, seed: s }))));
    assert.ok(set.size > 1);
  });
}

test('progressOf：四种次序', () => {
  const P = (i, order) => progressOf({ i, n: 5, p: 0.5, stagger: 0.5, order, seed: 3 });
  assert.ok(P(0, 'forward') > P(4, 'forward'));
  assert.ok(P(4, 'reverse') > P(0, 'reverse'));
  assert.ok(P(2, 'center') > P(0, 'center') && P(0, 'center') === P(4, 'center'));
  const r = [0, 1, 2, 3, 4].map(i => P(i, 'random'));
  assert.ok(new Set(r).size > 1);
  assert.deepEqual(r, [0, 1, 2, 3, 4].map(i => P(i, 'random')));
  for (const o of ['forward', 'reverse', 'center', 'random']) for (let i = 0; i < 5; i++) {
    assert.equal(progressOf({ i, n: 5, p: 1, order: o }), 1);
    assert.equal(progressOf({ i, n: 5, p: 0, order: o }), 0);
  }
});

test('quantizeP：一拍二 24fps 每 2 帧一张，端点不变', () => {
  const q = p => quantizeP({ p, dur: 1, hold: 2, fps: 24 });
  assert.equal(q(0), 0); assert.equal(q(1), 1);
  assert.equal(q(3 / 24), 2 / 24); assert.equal(q(2 / 24), 2 / 24);
  assert.equal(quantizeP({ p: 0.37 }), 0.37);
});

test('labelComponents：8 连通域标记', () => {
  // 两块：左上 L 形（含对角相连）与右下单点
  const a = Uint8Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  const { labels, count } = labelComponents(a, 4, 3);
  assert.equal(count, 2);
  assert.equal(labels[0], labels[5]); assert.notEqual(labels[0], labels[11]);
  assert.equal(labels[1], 0);
});
