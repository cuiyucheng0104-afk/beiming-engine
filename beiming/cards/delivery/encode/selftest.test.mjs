// deliver.encode 的自测：预设名换出来的设置表逐项核对。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from './comp.mjs';

const ctx = { size: [1920, 1080], fps: '30/1' };

test('deliver.encode：h264-crf14-bt709 换成 H.264、质量系数 14、4:2:0 八位、BT.709 有限范围、MP4，带上画幅和帧率', () => {
  const { object } = create(ctx, { master: 'h264-crf14-bt709' });
  assert.deepEqual(object, { container: 'mp4', codec: 'h264', crf: 14, pixelFormat: 'yuv420p', primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited', size: [1920, 1080], fps: '30/1' });
  assert.ok(Object.isFrozen(object));
});

test('deliver.encode：不认得的预设报错；4:2:0 的画面宽或高是奇数报错', () => {
  assert.throws(() => create(ctx, { master: 'prores-4444' }), /prores-4444/);
  assert.throws(() => create({ ...ctx, size: [1921, 1080] }, { master: 'h264-crf14-bt709' }), RangeError);
  assert.throws(() => create({ ...ctx, size: [1920, 1079] }, { master: 'h264-crf14-bt709' }), RangeError);
});
