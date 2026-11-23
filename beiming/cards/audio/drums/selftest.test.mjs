import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { create, renderDrums, SAMPLE_RATE, synthesizeVoice, VOICE_NAMES } from './index.mjs';

function sha256Float32(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return createHash('sha256').update(bytes).digest('hex');
}

test('audio.drums 自测：五种程序化音色（kick/snare/hihat/rim/accent）48000 Hz 确定性合成与种子敏感性', () => {
  assert.equal(SAMPLE_RATE, 48000);
  assert.deepEqual(VOICE_NAMES, ['kick', 'snare', 'hihat', 'rim', 'accent']);

  for (const v of VOICE_NAMES) {
    const a = synthesizeVoice(v, { seed: 42, velocity: 0.9 });
    const b = synthesizeVoice(v, { seed: 42, velocity: 0.9 });
    assert.ok(a instanceof Float32Array && a.length > 1000, `${v} 应产出非空 Float32Array`);
    assert.equal(sha256Float32(a), sha256Float32(b), `${v} 相同种子重复合成必须逐位一致`);

    let maxAbs = 0;
    for (let i = 0; i < a.length; i++) {
      assert.ok(Number.isFinite(a[i]), `${v}[${i}] 不能是 NaN 或 Infinity`);
      if (Math.abs(a[i]) > maxAbs) maxAbs = Math.abs(a[i]);
    }
    assert.ok(maxAbs > 0.1 && maxAbs <= 2, `${v} 峰值应在合理范围内，实际 ${maxAbs}`);
    assert.equal(a[a.length - 1], 0, `${v} 最后一个采样应完成渐隐归零`);
  }

  // 带噪音色换 seed 必须变化
  const snare1 = synthesizeVoice('snare', { seed: 101 });
  const snare2 = synthesizeVoice('snare', { seed: 202 });
  assert.notEqual(sha256Float32(snare1), sha256Float32(snare2));
});

test('audio.drums 自测：立体声节拍渲染、精确采样对齐、防削波上限与 L2 跨帧纯函数一致性', () => {
  const pattern = {
    bpm: 120,
    stepsPerBeat: 4,
    hits: [
      { id: 'h0-kick', voice: 'kick', frame: 0, sub: 0, velocity: 1.0, pan: 0 },
      { id: 'h1-hat', voice: 'hihat', frame: 6, sub: 0.5, velocity: 0.7, pan: -0.5 },
      { id: 'h2-snare', voice: 'snare', frame: 12, sub: 0, velocity: 0.95, pan: 0.2 },
      { id: 'h3-rim', voice: 'rim', frame: 18, sub: 0.25, velocity: 0.8, pan: 0.6 },
      { id: 'h4-accent', voice: 'accent', frame: 20, sub: 0, velocity: 1.2, pan: 0 },
    ],
  };

  const h1 = create({ fps: '24/1', frames: 24, seed: 777, shot: { in: 100, frames: 24 } }, { pattern, gainDb: 0, ceilingDb: -1 });
  const h2 = create({ fps: '24/1', frames: 24, seed: 777, shot: { in: 100, frames: 24 } }, { pattern, gainDb: 0, ceilingDb: -1 });

  assert.equal(h1.object.channels.length, 2);
  assert.equal(h1.object.channels[0].length, 48000);
  assert.equal(sha256Float32(h1.object.channels[0]), sha256Float32(h2.object.channels[0]));
  assert.equal(sha256Float32(h1.object.channels[1]), sha256Float32(h2.object.channels[1]));

  // 第 6.5 帧（24 fps）对应 6.5 * 2000 = 13000 采样点
  assert.equal(h1.object.placements[1].sample, 13000);
  // 事件全片帧号 = shot.in (100) + 局部帧号
  assert.equal(h1.object.events[0].frame, 100);
  assert.equal(h1.object.events[2].frame, 112);

  // 峰值不得超过 ceilingDb (-1 dBFS)
  assert.ok(h1.object.peakDb <= -1 + 1e-5, `峰值 ${h1.object.peakDb} dBFS 不得超过 -1 dBFS`);

  // L2 纯函数门：顺序 vs 逆序 vs 单帧
  const testFrames = [0, 6, 12, 18, 20, 23];
  const forward = testFrames.map((f) => h1.meta(f));
  const reversed = [...testFrames].reverse().map((f) => h1.meta(f)).reverse();
  const single = h1.meta(12);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(single, forward[2]);
  assert.equal(single.readings.hitCount, 1);
  assert.ok(single.readings.rms > 0);
});

test('audio.drums 自测：零陷阱拦截 Proxy、getter、稀疏数组、越界帧与非法采样率', () => {
  let traps = 0;
  const proxySpec = new Proxy({ fps: '24/1', frames: 24 }, {
    get() {
      traps++;
      return '24/1';
    },
  });
  assert.throws(() => renderDrums(proxySpec), (err) => err?.code === 'usage.bad-argument');

  const getterOpts = {};
  Object.defineProperty(getterOpts, 'seed', {
    enumerable: true,
    get() {
      traps++;
      return 1;
    },
  });
  assert.throws(() => synthesizeVoice('kick', getterOpts), (err) => err?.code === 'usage.bad-argument');

  assert.throws(
    () => synthesizeVoice('kick', { sampleRate: 44100 }),
    (err) => err?.code === 'usage.bad-argument',
  );
  assert.throws(
    () => renderDrums({
      fps: '24/1',
      frames: 12,
      pattern: { hits: [{ id: 'late', voice: 'kick', frame: 12 }] },
    }),
    (err) => err?.code === 'usage.bad-argument',
  );
  assert.equal(traps, 0);
});
