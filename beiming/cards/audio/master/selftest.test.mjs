// audio.master 的自测：用算得出标准答案的正弦信号量响度和真峰值，再看增益调到哪。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from './comp.mjs';

const RATE = 48000;
/** 正弦：频率赫兹，幅度是满幅的几分之几（dBFS），时长秒，初相位度 */
const sine = (hz, dbfs, seconds, phaseDeg = 0) => Float32Array.from({ length: RATE * seconds }, (_, i) => 10 ** (dbfs / 20) * Math.sin((2 * Math.PI * hz * i) / RATE + (phaseDeg * Math.PI) / 180));
const card = (loudness = -14, truePeak = -1) => create({}, { loudness, truePeak }).object;
const within = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} 应在 ${b} ± ${tol}`);

test('audio.master：1000 赫兹、−23 dBFS、双声道同相的正弦量出 −23.0 LUFS；只有一个声道时低 3 LU', () => {
  const tone = sine(1000, -23, 20);
  within(card().measure([tone, tone], RATE).loudnessLufs, -23, 0.1);
  within(card().measure([tone], RATE).loudnessLufs, -26.01, 0.1);
});

/** K 加权在某个频率上的增益（分贝）：拿标准里 48000 赫兹的两级滤波系数，在单位圆上直接算传递函数的模 */
function kWeightDb(hz) {
  const w = (2 * Math.PI * hz) / RATE, mag2 = ([b0, b1, b2, a1, a2]) => {
    const re = (c0, c1, c2) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w), im = (c1, c2) => -c1 * Math.sin(w) - c2 * Math.sin(2 * w);
    return (re(b0, b1, b2) ** 2 + im(b1, b2) ** 2) / (re(1, a1, a2) ** 2 + im(a1, a2) ** 2);
  };
  return 10 * Math.log10(mag2([1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585]) * mag2([1, -2, 1, -1.99004745483398, 0.99007225036621]));
}

test('audio.master：K 加权压低频、抬高频：50 赫兹和 8000 赫兹的正弦相对 1000 赫兹的响度差，和从滤波系数直接算的频率响应一致', () => {
  const at = (hz) => { const tone = sine(hz, -23, 5); return card().measure([tone, tone], RATE).loudnessLufs; };
  const mid = at(1000);
  within(at(50) - mid, kWeightDb(50) - kWeightDb(1000), 0.05);
  within(at(8000) - mid, kWeightDb(8000) - kWeightDb(1000), 0.05);
  assert.ok(at(50) < mid - 2 && at(8000) > mid + 2);
});

test('audio.master：相对门限：响的一段后面接上低 30 分贝的一段，量出来还是响的那一段的响度', () => {
  const loud = sine(1000, -20, 10), quiet = sine(1000, -50, 10), both = new Float32Array(loud.length + quiet.length);
  both.set(loud);
  both.set(quiet, loud.length);
  within(card().measure([both, both], RATE).loudnessLufs, -20, 0.2);
});

test('audio.master：真峰值：12000 赫兹、相位 45 度的满幅正弦，采样点最大只到 −3 dBFS，量出来是 0 dBTP', () => {
  const tone = sine(12000, 0, 1, 45);
  within(20 * Math.log10(Math.max(...tone)), -3.01, 0.01);
  within(card().measure([tone], RATE).truePeakDbtp, 0, 0.2);
});

test('audio.master：响度够得着时调到目标响度；真峰值先到上限时增益停在上限，并写明是被它定住的', () => {
  const tone = sine(1000, -23, 5);
  const a = card(-14, -1).master([tone, tone], RATE);
  assert.equal(a.limitedBy, 'loudness');
  within(a.gainDb, 9, 0.1);
  within(a.loudnessLufs, -14, 1e-9);
  within(card().measure(a.channels, RATE).loudnessLufs, -14, 0.1);
  // 目标 −5 LUFS 要加 18 分贝，真峰值上限 −9 dBTP 只容得下 14 分贝
  const b = card(-5, -9).master([tone, tone], RATE);
  assert.equal(b.limitedBy, 'truePeak');
  within(b.gainDb, 14, 0.1);
  within(b.truePeakDbtp, -9, 1e-9);
  within(card().measure(b.channels, RATE).truePeakDbtp, -9, 0.1);
  within(b.loudnessLufs, -9, 0.1);
});

test('audio.master：别的采样率、多于两个声道、不到 400 毫秒、全是静音都报错', () => {
  const tone = sine(1000, -23, 1);
  assert.throws(() => card().measure([tone], 44100), RangeError);
  assert.throws(() => card().measure([tone, tone, tone], RATE), RangeError);
  assert.throws(() => card().measure([tone.subarray(0, 1000)], RATE), RangeError);
  assert.throws(() => card().master([new Float32Array(RATE)], RATE), RangeError);
});
