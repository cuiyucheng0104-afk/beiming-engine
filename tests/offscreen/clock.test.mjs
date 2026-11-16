// 离屏出片 · 确定性帧时钟（engine/offscreen/clock.mjs）：纯 JS，不需要 GPU。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameClock } from '../../engine/offscreen/clock.mjs';

test('tick 调用已登记的回调，各调一次，参数是时刻', () => {
  const c = createFrameClock(), got = [];
  c.self.requestAnimationFrame(t => got.push(['a', t]));
  c.self.requestAnimationFrame(t => got.push(['b', t]));
  c.tick(41.5);
  assert.deepEqual(got, [['a', 41.5], ['b', 41.5]]);
  assert.equal(c.pending(), 0);
});

test('回调里重新登记的，留到下一次 tick', () => {
  const c = createFrameClock(); let n = 0;
  const loop = () => { n++; c.self.requestAnimationFrame(loop); };
  c.self.requestAnimationFrame(loop);
  c.tick(0); assert.equal(n, 1); assert.equal(c.pending(), 1);
  c.tick(1); assert.equal(n, 2);
});

test('cancelAnimationFrame 取消后不再调用', () => {
  const c = createFrameClock(); let n = 0;
  const id = c.self.requestAnimationFrame(() => n++);
  c.self.cancelAnimationFrame(id);
  c.tick(0);
  assert.equal(n, 0);
});
