// time.timeline 的自测：换算结果和手算的比。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from './evaluate.mjs';

const inputs = { fps: '30/1', shot: { id: 's02', in: 180, frames: 120 } };

test('time.timeline：30 帧每秒、起始帧 180 的镜头，局部第 12 帧是全片第 192 帧、6.4 秒、第 16 拍', () => {
  assert.deepEqual(evaluate(inputs, { holdFrames: 1, beatFrames: 12 }, 12, 0), { time: { local: 12, held: 12, global: 192, seconds: 6.4, beat: 16 } });
});

test('time.timeline：一拍二把第 13 帧压到第 12 帧，带子帧相位也不变；帧内的时间照常往前走', () => {
  const { time } = evaluate(inputs, { holdFrames: 2, beatFrames: 12 }, 13, 0.5);
  assert.deepEqual([time.held, time.local, time.global], [12, 13.5, 193.5]);
});

test('time.timeline：帧率不是整数时秒数按分数算', () => {
  const { time } = evaluate({ fps: '30000/1001', shot: { id: 's', in: 0, frames: 60 } }, { holdFrames: 1, beatFrames: 12 }, 30, 0);
  assert.equal(time.seconds, (30 * 1001) / 30000);
});
