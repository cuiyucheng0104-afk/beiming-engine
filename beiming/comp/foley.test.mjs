import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findOnset, findPCenter } from './audio-onsets.mjs';
import { mixEvents, SAMPLE_RATE, VOICES } from './audio.mjs';

const materials = ['foley.impact', 'foley.step', 'foley.metal', 'foley.cloth'];
const seed = 0x51bc;
function triggers(audio, sync, fps) {
  const events = [0.375, 0.875, 0.5, 0.8125, 0.625].map((sub, i) => ({
    id: `cue.${i}`, frame: (i + 1) * fps / 2, sub, kind: 'burst', from: 'tracks', audio, sync,
  }));
  return { format: 'events/0.1', film: 'x5', fps: `${fps}/1`, frames: 3 * fps, events };
}
const bytes = (samples) => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);

test('四种复合拟音在音色库内可直接调用', async () => {
  const { FOLEY_VOICES } = await import('./foley.mjs');
  for (const name of materials) {
    assert.equal(VOICES[name], FOLEY_VOICES[name]);
    const wave = FOLEY_VOICES[name].make();
    assert.ok(wave.left.length > 0 && wave.left.length === wave.right.length);
    for (const ch of [wave.left, wave.right]) assert.ok(ch.every((v) => Number.isFinite(v) && Math.abs(v) <= 1));
  }
});

for (const fps of [24, 30, 60]) {
  for (const sync of ['onset', 'pcenter']) {
    test(`${fps} fps ${sync} 从终混样本检测四种带前导的拟音，各五次亚帧触发`, (t) => {
      const errors = [];
      for (const name of materials) {
        const table = triggers(name, sync, fps);
        const mix = mixEvents(table, { seed });
        const replay = mixEvents(table, { seed });
        for (const ch of ['left', 'right']) assert.ok(bytes(mix[ch]).equals(bytes(replay[ch])), `${name} ${ch} 重放`);
        const mono = mix.left.map((v, i) => (v + mix.right[i]) / 2);
        const segments = [];
        for (const { frame, sub, id } of table.events) {
          const target = (frame + sub) / fps;
          const result = findOnset(mono, SAMPLE_RATE, target);
          assert.ok(result, `${name} ${id} 应有可测包络`);
          const error = (result.t - target) * fps;
          assert.ok(error >= -0.25 && error <= 1, `${name} ${id} 误差 ${error} 帧`);
          errors.push(error);
          const sample = Math.round(target * SAMPLE_RATE);
          const begin = sample - SAMPLE_RATE / 10;
          const cue = mono.subarray(begin, sample + SAMPLE_RATE * 0.35);
          const peak = cue.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
          for (const threshold of [0.001, peak * 0.1, peak * 0.5]) {
            const first = cue.findIndex((v) => Math.abs(v) >= threshold);
            assert.ok(first >= 0, `${name} ${id} 未达到阈值 ${threshold}`);
            const lag = ((begin + first) / SAMPLE_RATE - target) * fps;
            assert.ok(lag >= -0.25 && lag <= 1, `${name} ${id} 阈值 ${threshold} 偏差 ${lag} 帧`);
            errors.push(lag);
            if (threshold === 0.001 && sync === 'pcenter') {
              const leadMs = -lag * 1000 / fps;
              assert.ok(leadMs > 0 && leadMs < 4.1, `${name} ${id} 可闻前导 ${leadMs} ms`);
            }
          }
          if (sync === 'pcenter') {
            const center = findPCenter(mono, SAMPLE_RATE, target);
            assert.ok(center && Math.abs(center.t - target) <= 0.25 / fps, `${name} ${id} 感知重心须对齐`);
            const pre = mono.subarray(sample - 192, sample - 24);
            assert.ok(pre.some((v) => Math.abs(v) > 0.001), `${name} ${id} 冲击前应有前导声`);
          }
          const segment = bytes(mono.subarray(sample, sample + 4800));
          assert.ok(segments.every((s) => !s.equals(segment)), `${name} ${id} 不能复用本轮或前一轮的触发样本`);
          segments.push(segment);
        }
      }
      t.diagnostic(`测得 ${errors.length} 次，误差 ${Math.min(...errors).toFixed(4)} 至 ${Math.max(...errors).toFixed(4)} 帧`);
    });
  }
}

test('从接触瞬态后的间隙量到主体首个样本，并检查余响', (t) => {
  for (const name of materials) {
    const table = triggers(name, 'pcenter', 60);
    const { left } = mixEvents(table, { seed });
    const lags = table.events.map(({ frame, sub }) => {
      const at = Math.round((frame + sub) * SAMPLE_RATE / 60);
      const attack = left.subarray(at, at + 240);
      assert.ok(attack.subarray(0, 48).some((v) => Math.abs(v) > 0.05), `${name} 缺接触瞬态`);
      // 低通的衰减尾巴渐近于零，用与主体起点一致的振幅阈值判定间隙。
      const gap = attack.findIndex((v, i) => i >= 48 && Math.abs(v) <= 1e-7 && Math.abs(attack[i + 1]) <= 1e-7);
      assert.ok(gap >= 0, `${name} 找不到瞬态和主体的间隙`);
      const body = attack.findIndex((v, i) => i > gap && Math.abs(v) > 1e-7);
      const lagMs = body * 1000 / SAMPLE_RATE;
      assert.ok(lagMs >= 1.8 && lagMs <= 3, `${name} 主体滞后 ${lagMs} ms`);
      assert.ok(left.subarray(at + 4320, at + 4800).some((v) => Math.abs(v) > 1e-4), `${name} 缺余响`);
      return lagMs;
    });
    t.diagnostic(`${name} 主体滞后 ${Math.min(...lags).toFixed(3)}–${Math.max(...lags).toFixed(3)} ms`);
  }
});

test('金属每轮取遍四种音高，同槽跨轮的共振主频有可重放的微扰', () => {
  const voice = VOICES['foley.metal'];
  const peaks = [];
  for (let idx = 0; idx < 8; idx++) {
    const body = voice.make(seed, idx).left.subarray(voice.pcenter + 240, voice.pcenter + 4800);
    assert.deepEqual(body, voice.make(seed, idx).left.subarray(voice.pcenter + 240, voice.pcenter + 4800));
    let maxPower = 0, peakHz = 0;
    for (let hz = 1100; hz <= 1240; hz += 0.5) {
      const omega = 2 * Math.PI * hz / SAMPLE_RATE;
      let re = 0, im = 0;
      for (let i = 0; i < body.length; i++) { re += body[i] * Math.cos(i * omega); im += body[i] * Math.sin(i * omega); }
      const power = re * re + im * im;
      if (power > maxPower) { maxPower = power; peakHz = hz; }
    }
    peaks.push(peakHz);
  }
  for (const cycle of [peaks.slice(0, 4), peaks.slice(4)]) {
    const slots = cycle.map((hz) => Math.round(2 * (12 * Math.log2(hz / 1170) + 0.75)));
    assert.deepEqual(new Set(slots), new Set([0, 1, 2, 3]));
  }
  for (let i = 0; i < 4; i++) {
    const shift = Math.abs(peaks[i] - peaks[i + 4]);
    assert.ok(shift >= 1 && shift < 17, `同槽跨轮 ${peaks[i]} → ${peaks[i + 4]} Hz`);
  }
});

test('金属尾段保有独立余响的能量', () => {
  const voice = VOICES['foley.metal'];
  for (let callIdx = 0; callIdx < 8; callIdx++) {
    const { left } = voice.make(seed, callIdx);
    // 末尾 30 至 3 ms 的腔体单独衰减到约 −68 dBFS，叠加余响后约 −64 dBFS。
    const tail = left.subarray(left.length - 1440, left.length - 144);
    const power = tail.reduce((sum, v) => sum + v * v, 0) / tail.length;
    assert.ok(10 * Math.log10(power) > -66, `第 ${callIdx + 1} 次触发缺少金属余响`);
  }
});

test('轮换由片种子和本材质的触发次数决定，旧音色沿用原音色库的样本', () => {
  for (const [i, name] of materials.entries()) {
    const table = triggers(name, 'onset', 30);
    const bare = mixEvents(table, { seed });
    const changed = mixEvents(table, { seed: seed + 1 });
    const other = { ...table.events[0], id: 'extra', audio: materials[(i + 1) % materials.length], frame: 21 };
    const interleaved = mixEvents({ ...table, events: [table.events[0], other, ...table.events.slice(1)] }, { seed });
    // 第三个触发距插入的另一个材质 0.8 秒，已越过余响。
    const at = Math.round((table.events[2].frame + table.events[2].sub) * SAMPLE_RATE / 30);
    const region = (mix) => bytes(mix.left.subarray(at, at + 4800));
    assert.ok(!region(bare).equals(region(changed)), `${name} 更换种子`);
    assert.ok(region(bare).equals(region(interleaved)), `${name} 独立轮换`);
  }
  for (const name of ['hit.low', 'hit.soft', 'whoosh', 'riser']) {
    const table = triggers(name, 'onset', 24);
    table.events.length = 1;
    const { left, placements } = mixEvents(table, { seed });
    // 混入静音从 +0 累加，原始波形里的 -0 在这里成为 +0。
    const expected = VOICES[name].make().left.map((v) => 0 + v);
    assert.ok(bytes(left.subarray(placements[0].start, placements[0].start + expected.length)).equals(bytes(expected)), name);
  }
  assert.throws(() => mixEvents(triggers('foley.unknown', 'onset', 30)), { code: 'usage.bad-argument', message: /不在音色库里/ });
});
