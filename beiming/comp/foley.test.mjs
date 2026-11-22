import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findOnset, findPCenter } from '../../tools/qa/lib/audio.mjs';
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
        let previous;
        for (const { frame, sub, id } of table.events) {
          const target = (frame + sub) / fps;
          const result = findOnset(mono, SAMPLE_RATE, target);
          assert.ok(result, `${name} ${id} 应有可测包络`);
          const error = (result.t - target) * fps;
          assert.ok(error >= -0.25 && error <= 1, `${name} ${id} 误差 ${error} 帧`);
          errors.push(error);
          const sample = Math.round(target * SAMPLE_RATE);
          if (sync === 'pcenter') {
            const center = findPCenter(mono, SAMPLE_RATE, target);
            assert.ok(center && Math.abs(center.t - target) <= 0.25 / fps, `${name} ${id} 感知重心须对齐`);
            const pre = mono.subarray(sample - 192, sample - 24);
            assert.ok(pre.some((v) => Math.abs(v) > 0.001), `${name} ${id} 冲击前应有前导声`);
          }
          const segment = bytes(mono.subarray(sample, sample + 4800));
          assert.ok(!previous || !previous.equals(segment), `${name} ${id} 相邻触发须有变化`);
          previous = segment;
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
      const gap = attack.findIndex((v, i) => i >= 48 && v === 0 && attack[i + 1] === 0);
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
