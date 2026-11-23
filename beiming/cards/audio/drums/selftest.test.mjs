import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { checks as eventChecks } from '../../../kernel/contracts/events/check.mjs';
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

  const snare1 = synthesizeVoice('snare', { seed: 101 });
  const snare2 = synthesizeVoice('snare', { seed: 202 });
  assert.notEqual(sha256Float32(snare1), sha256Float32(snare2));
});

test('audio.drums 自测：节拍网格（bpm + stepsPerBeat + step/beat/bar）换算与 EV1 (frame, id) 规范排序', () => {
  // 1. 只按节拍网格 step/beat 定位，不显式填 frame；改变 bpm 或 stepsPerBeat 后落点与波形同步改变
  const gridHits = [
    { id: 'g0-kick', voice: 'kick', step: 0, velocity: 1.0 },
    { id: 'g1-hat', voice: 'hihat', step: 2, velocity: 0.7 },
    { id: 'g2-snare', voice: 'snare', beat: 1, velocity: 0.9 },
  ];
  const r120 = renderDrums({
    fps: '24/1',
    frames: 24,
    seed: 55,
    pattern: { bpm: 120, stepsPerBeat: 4, hits: gridHits },
  });
  const r240 = renderDrums({
    fps: '24/1',
    frames: 24,
    seed: 55,
    pattern: { bpm: 240, stepsPerBeat: 4, hits: gridHits },
  });
  const rSteps8 = renderDrums({
    fps: '24/1',
    frames: 24,
    seed: 55,
    pattern: { bpm: 120, stepsPerBeat: 8, hits: gridHits },
  });

  // 120 BPM, stepsPerBeat=4, 24fps：step=2 -> 0.5 beat -> 第 6 帧 (12000 采样)；beat=1 -> 第 12 帧 (24000 采样)
  assert.equal(r120.placements[1].frame, 6);
  assert.equal(r120.placements[1].sample, 12000);
  assert.equal(r120.placements[2].frame, 12);
  assert.equal(r120.placements[2].sample, 24000);

  // 240 BPM：速度加倍，step=2 落到第 3 帧 (6000 采样)，beat=1 落到第 6 帧 (12000 采样)
  assert.equal(r240.placements[1].frame, 3);
  assert.equal(r240.placements[1].sample, 6000);
  assert.equal(r240.placements[2].frame, 6);
  assert.equal(r240.placements[2].sample, 12000);
  assert.notEqual(sha256Float32(r120.channels[0]), sha256Float32(r240.channels[0]));

  // stepsPerBeat=8：step=2 变为 0.25 beat -> 第 3 帧 (6000 采样)
  assert.equal(rSteps8.placements[1].frame, 3);
  assert.equal(rSteps8.placements[1].sample, 6000);
  assert.notEqual(sha256Float32(r120.channels[0]), sha256Float32(rSteps8.channels[0]));

  // 2. 同帧的 z (sub=0) 与 a (sub=0.5) 导出事件表必须按 EV1 (frame, id) 排为 a, z 并通过仓库 EV1 检查器
  const sameFrame = renderDrums({
    fps: '24/1',
    frames: 12,
    seed: 1,
    pattern: {
      hits: [
        { id: 'z', voice: 'kick', frame: 0, sub: 0 },
        { id: 'a', voice: 'hihat', frame: 0, sub: 0.5 },
      ],
    },
  });
  assert.deepEqual(sameFrame.events.map((e) => e.id), ['a', 'z']);
  assert.deepEqual(
    eventChecks.EV1({ format: 'events/0.1', film: 'test', fps: '24/1', frames: 12, events: sameFrame.events }),
    [],
    '导出事件表必须 0 错误通过仓库 EV1 检查器',
  );
});

test('audio.drums 自测：立体声节拍渲染、防削波上限、L2 跨帧纯函数一致性与非法参数拒绝', () => {
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

  assert.equal(h1.object.placements[1].sample, 13000);
  assert.equal(h1.object.events[0].frame, 100);
  assert.equal(h1.object.events[2].frame, 112);
  assert.ok(h1.object.peakDb <= -1 + 1e-5, `峰值 ${h1.object.peakDb} dBFS 不得超过 -1 dBFS`);

  const testFrames = [0, 6, 12, 18, 20, 23];
  const forward = testFrames.map((f) => h1.meta(f));
  const reversed = [...testFrames].reverse().map((f) => h1.meta(f)).reverse();
  const single = h1.meta(12);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(single, forward[2]);
  assert.equal(single.readings.hitCount, 1);
  assert.ok(single.readings.rms > 0);

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
});
