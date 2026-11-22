// B3：二级第一批 4 道考题（27-1、29-2、23-2、30-1[外01-1]）契约校验与随机基线/反例自动判分核验
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { audioLoudness, cutYdif } from '../observe/metrics/index.mjs';
import { projectPublicQuestion, scanQuestionLeaks, validateQuestion } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const REFS = join(HERE, 'refs/level-2-a');
const IDS = ['27-1', '29-2', '23-2', '30-1'];
const question = (id) => JSON.parse(readFileSync(join(HERE, 'questions/level-2-a', `${id}.json`), 'utf8'));
const reading = (name) => JSON.parse(readFileSync(join(REFS, `${name}.json`), 'utf8'));
// 判分器在题目文件写好之后才有，放到用例里再载入，缺文件时只红用例、不红整个文件
const evaluator = () => import('./questions/level-2-a/evaluate-b3.mjs');
const passed = (verdict) => verdict.items.map((item) => item.pass);
// 固定种子的线性同余，负对照要能复现
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

test('B3-1 二级 4 道考题文件存在且原文与对象均通过 B1 validateQuestion（0 错误、0 违反、0 泄露）', () => {
  for (const id of IDS) {
    const file = join(HERE, 'questions/level-2-a', `${id}.json`);
    assert.ok(existsSync(file), `缺少题目文件: ${file}`);
    const raw = readFileSync(file, 'utf8');
    for (const verdict of [validateQuestion(raw), validateQuestion(JSON.parse(raw))]) {
      assert.equal(verdict.ok, true, `${id} 校验未过: ${JSON.stringify(verdict)}`);
      assert.deepEqual([verdict.schemaErrors, verdict.violations, verdict.leaks], [[], {}, []]);
    }
    const pub = projectPublicQuestion(JSON.parse(raw));
    assert.equal(pub.id, id);
    assert.equal(pub.level, 2);
    assert.equal('ext' in pub, false, '公开副本不带 ext');
  }
});

test('B3-2 库外案例的题按题号契约编成 30-1，代号记在 ext；拍点类的题都带随机对照，29-2 写明 34%', () => {
  assert.deepEqual(question('30-1').ext, { 'bench.code': '外01-1' });
  for (const id of IDS) {
    const q = question(id);
    assert.match(q.controls.random, /随机对照/, `${id} 缺随机对照`);
    for (const ref of q.refs) assert.ok(existsSync(join(ROOT, ref)), `${id} 的参考 ${ref} 不在仓库里`);
  }
  assert.match(question('29-2').controls.random, /34%/);
});

test('B3-3 参考读数夹具不带泄露，逐份判分结果和夹具里登记的预期一致', async () => {
  const { evaluate } = await evaluator();
  const files = readdirSync(REFS).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(files, ['23-2.original.json', '23-2.reference.json', '27-1.original.json', '27-1.reference.json',
    '29-2.reference.json', '30-1.reference.json']);
  for (const name of files) {
    const raw = readFileSync(join(REFS, name), 'utf8');
    const ref = JSON.parse(raw);
    assert.deepEqual([scanQuestionLeaks(raw), scanQuestionLeaks(ref)], [[], []], name);
    const verdict = evaluate(question(ref.question), ref);
    assert.deepEqual({ pass: verdict.pass, score: verdict.score, items: passed(verdict) }, ref.expect, name);
  }
  // 每道题都有一份满分的参考读数
  for (const id of IDS) assert.deepEqual(reading(`${id}.reference`).expect, { pass: true, score: 1, items: [true, true] });
});

test('B3-4 27-1：原作成片 13 个切点全在 12 帧格子上，但响度 -8.7 LUFS 超限，必须判不合格；随机切点也不过', async () => {
  const { evaluate } = await evaluator();
  const q = question('27-1'), original = reading('27-1.original'), reference = reading('27-1.reference');
  assert.equal(original.cuts.length, 13);
  assert.ok(original.cuts.every((frame) => frame % 12 === 0));
  assert.equal(original.loudnessLufs, -8.7);
  const verdict = evaluate(q, original);
  assert.equal(verdict.pass, false);
  assert.deepEqual(passed(verdict), [true, false]);
  assert.equal(evaluate(q, reference).score, 1);
  // 响度压在界上算过，出界 0.1 就不过
  assert.equal(evaluate(q, { ...reference, loudnessLufs: -15 }).pass, true);
  assert.equal(evaluate(q, { ...reference, loudnessLufs: -15.1 }).pass, false);
  assert.equal(evaluate(q, { ...reference, truePeakDbtp: -0.9 }).pass, false);
  // 负对照：整体错位 2 帧、镜头长度用了 3 拍、随机切点
  assert.equal(evaluate(q, { ...reference, cuts: reference.cuts.map((frame) => frame + 2) }).pass, false);
  assert.equal(evaluate(q, { ...reference, cuts: [96, 132, 192, 288, 384, 480] }).pass, false);
  for (let seed = 1; seed <= 20; seed++) {
    const rand = lcg(seed);
    const cuts = [...new Set(Array.from({ length: 13 }, () => 1 + Math.floor(rand() * 509)))].sort((a, b) => a - b);
    assert.equal(evaluate(q, { ...reference, cuts }).pass, false, `随机切点 seed=${seed}`);
  }
});

test('B3-5 29-2：11 次点击 9 次踩起音（81.8%），比随机基线 34% 高出 40 个百分点以上；随机打点和切点偏离 2 帧必败', async () => {
  const { evaluate } = await evaluator();
  const q = question('29-2'), ref = reading('29-2.reference');
  const verdict = evaluate(q, ref);
  assert.equal(verdict.score, 1);
  const { hits, events, hitRate, randomBaseline } = verdict.items[1].detail;
  assert.deepEqual([hits, events], [9, 11]);
  assert.equal(Math.round(hitRate * 1000) / 10, 81.8);
  assert.equal(Math.round(randomBaseline * 100), 34);
  assert.ok(hitRate - randomBaseline >= 0.4 && hitRate >= 0.8);
  assert.ok(ref.clicks.every((frame, i) => ref.cuts[i] - frame === 2));
  // 切点改成点击后第 4 帧：对位那一项还过，切点那一项不过
  assert.deepEqual(passed(evaluate(q, { ...ref, cuts: ref.clicks.map((frame) => frame + 4) })), [false, true]);
  // 点击少一个：事件数和题面不一致
  assert.equal(evaluate(q, { ...ref, clicks: ref.clicks.slice(1), cuts: ref.cuts.slice(1) }).pass, false);
  // 随机打点（切点照样跟在点击后 2 帧）：命中率在随机基线附近，没有一次能过
  const rates = [];
  for (let seed = 1; seed <= 200; seed++) {
    const rand = lcg(seed);
    const clicks = Array.from({ length: 11 }, () => Math.floor(rand() * (ref.frames - 2)));
    const random = evaluate(q, { ...ref, clicks, cuts: clicks.map((frame) => frame + 2) });
    assert.deepEqual(passed(random), [true, false], `随机打点 seed=${seed}`);
    rates.push(random.items[1].detail.hitRate);
  }
  const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  assert.ok(Math.abs(mean - randomBaseline) < 0.05, `随机打点的平均命中率 ${mean} 应该贴着基线 ${randomBaseline}`);
});

test('B3-6 23-2：6 个章节起点都落拍、强起音命中不低于 80% 才满分；原作成片第 3 个章节起点晚 2.5 帧，章节项不过', async () => {
  const { evaluate } = await evaluator();
  const q = question('23-2'), ref = reading('23-2.reference'), original = reading('23-2.original');
  const verdict = evaluate(q, ref);
  assert.equal(verdict.score, 1);
  assert.equal(ref.chaptersMs.length, 6);
  assert.ok(verdict.items[1].detail.hitRate >= 0.8);
  // 原作实测：强起音过，章节不过（8083 毫秒离拍点 103 毫秒，一帧是 41.7 毫秒）
  const measured = evaluate(q, original);
  assert.deepEqual(passed(measured), [false, true]);
  assert.equal(Math.max(...measured.items[0].detail.offBeatMs), 103);
  // 负对照：章节整体错开半拍、少一个章节、起音整体挪 100 毫秒
  assert.equal(evaluate(q, { ...ref, chaptersMs: ref.chaptersMs.map((ms) => ms + 250) }).pass, false);
  assert.equal(evaluate(q, { ...ref, chaptersMs: ref.chaptersMs.slice(0, 5) }).pass, false);
  assert.deepEqual(passed(evaluate(q, { ...ref, strongOnsetsMs: ref.strongOnsetsMs.map((ms) => ms + 100) })), [true, false]);
  // 配乐不是 120 BPM：两项都不认
  assert.deepEqual(passed(evaluate(q, { ...ref, beat: { ...ref.beat, periodMs: 750 } })), [false, false]);
});

test('B3-7 30-1（外01-1）：20 个命名时刻 17 个落拍（85%）且节拍常量只定义一次才满分；写死帧号或落拍不足 85% 必败', async () => {
  const { evaluate } = await evaluator();
  const q = question('30-1'), ref = reading('30-1.reference');
  const verdict = evaluate(q, ref);
  assert.equal(verdict.score, 1);
  const { hits, events, hitRate } = verdict.items[0].detail;
  assert.deepEqual([hits, events, hitRate], [17, 20, 0.85]);
  assert.deepEqual(ref.timeline, { beatConstantDefs: 1, hardcodedFrames: 0 });
  assert.deepEqual(passed(evaluate(q, { ...ref, timeline: { beatConstantDefs: 1, hardcodedFrames: 1 } })), [true, false]);
  assert.deepEqual(passed(evaluate(q, { ...ref, timeline: { beatConstantDefs: 2, hardcodedFrames: 0 } })), [true, false]);
  // 再挪走一个落拍的时刻：16/20 = 80%
  const moved = ref.moments.map((moment, i) => (i === 0 ? { ...moment, frame: moment.frame + 1 } : moment));
  assert.deepEqual(passed(evaluate(q, { ...ref, moments: moved })), [false, true]);
  assert.equal(evaluate(q, { ...ref, moments: ref.moments.slice(0, 19) }).pass, false, '命名时刻不足 20 个');
  for (let seed = 1; seed <= 20; seed++) {
    const rand = lcg(seed);
    const moments = ref.moments.map((moment) => ({ ...moment, frame: Math.floor(rand() * ref.frames) }));
    assert.equal(evaluate(q, { ...ref, moments }).pass, false, `随机时刻 seed=${seed}`);
  }
});

test('B3-8 27-1 用真实的 cutYdif 与 audioLoudness 量合成片：-14 LUFS 的满分，-8.7 LUFS 的判不合格', async () => {
  const { evaluate } = await evaluator();
  const q = question('27-1'), { cuts, frames } = reading('27-1.reference');
  const dir = mkdtempSync(join(tmpdir(), 'beiming-b3-'));
  const ffmpeg = (args, input) => {
    const run = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args], { input });
    assert.equal(run.status, 0, String(run.stderr));
  };
  try {
    // 画面：每过一个切点黑白翻一次，无损编码
    const size = 32, raw = Buffer.alloc(frames * size * size);
    for (let f = 0; f < frames; f++) raw.fill(cuts.filter((cut) => cut <= f).length % 2 ? 235 : 16, f * size * size, (f + 1) * size * size);
    const video = join(dir, 'grid.mp4');
    ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${size}x${size}`, '-r', '30', '-i', 'pipe:0',
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', video], raw);
    const detected = await cutYdif(video);
    assert.deepEqual(detected.value, cuts);
    // 声音：1 千赫正弦，先量一遍再把增益补到目标响度
    const tone = async (name, gainDb) => {
      const file = join(dir, name);
      ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=17', '-af', `volume=${gainDb}dB`, '-ac', '2', file]);
      return audioLoudness(file);
    };
    const probe = await tone('probe.wav', -20);
    for (const [target, expected] of [[-14, [true, true]], [-8.7, [true, false]]]) {
      const audio = await tone(`tone${target}.wav`, -20 + target - probe.value);
      assert.ok(Math.abs(audio.value - target) <= 0.1, `${audio.value} LUFS`);
      const verdict = evaluate(q, { frames, cuts: detected.value, loudnessLufs: audio.value, truePeakDbtp: audio.details.truePeakDbtp });
      assert.deepEqual(passed(verdict), expected, `${target} LUFS`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
