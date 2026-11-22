// B3：二级第一批 4 道考题（27-1、29-2、23-2、30-1[外01-1]）契约校验与随机基线/反例自动判分核验
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
// 量真片的用例要 ffmpeg 和 ffprobe；机器上没有就标明原因跳过，不拿一句看不懂的断言去红
const MEDIA = ['ffmpeg', 'ffprobe'].every((tool) => spawnSync(tool, ['-version']).status === 0) ? {} : { skip: '缺少 ffmpeg/ffprobe' };
const ffmpeg = (args, input) => {
  const run = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args], { input });
  assert.equal(run.status, 0, String(run.stderr));
};
const workdir = () => mkdtempSync(join(tmpdir(), 'beiming-b3-'));
// 合成声轨：16 千赫单声道裸 PCM，每个起点放一段 50 毫秒的 1 千赫正弦，其余静音
function burstTrack(file, startsMs, seconds) {
  const pcm = new Int16Array(seconds * 16000);
  for (const ms of startsMs) for (let k = 0; k < 800; k++) pcm[ms * 16 + k] = Math.round(12000 * Math.sin((Math.PI * k) / 8));
  writeFileSync(file, Buffer.from(pcm.buffer));
  return ['-f', 's16le', '-ar', '16000', '-ac', '1', '-i', file];
}
// 合成画面：每过一个切点黑白翻一次，三十分之一的小图放大到交付尺寸，无损编码；声音的输入参数接在后面
function flipFilm(file, { size: [width, height], fps, frames, cuts }, audio) {
  const w = width / 30, h = height / 30, raw = Buffer.alloc(frames * w * h);
  for (let f = 0; f < frames; f++) raw.fill(cuts.filter((cut) => cut <= f).length % 2 ? 235 : 16, f * w * h, (f + 1) * w * h);
  ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0', ...audio,
    '-vf', `scale=${width}:${height}:flags=neighbor`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', file], raw);
}
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
    assert.deepEqual({ pass: verdict.pass, basePass: verdict.basePass, score: verdict.score, items: passed(verdict) }, ref.expect, name);
  }
  // 每道题都有一份满分的参考读数
  for (const id of IDS) assert.deepEqual(reading(`${id}.reference`).expect, { pass: true, basePass: true, score: 1, items: [true, true] });
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
  assert.equal(verdict.basePass, false, '响度、真峰值也是基础谓词');
  assert.equal(evaluate(q, reference).score, 1);
  // 基础谓词和判分一起看：第 96 帧没切、画幅不对，判分两项都过也不合格
  const base = (verdict) => Object.fromEntries(verdict.base.map((item) => [item.predicate, item.pass]));
  assert.deepEqual(base(evaluate(q, reference)), { 'delivery(width=1080, height=1080, fps=30, frames=510)': true, 'cut_at(shots)': null,
    'cut_at(96)': true, 'loudness(film) in [-15,-13]': true, 'true_peak(film) <= -1': true });
  const late = evaluate(q, { ...reference, cuts: [48, ...reference.cuts.slice(1)] });
  assert.deepEqual([passed(late), late.score, late.basePass, late.pass], [[true, true], 1, false, false]);
  assert.equal(base(late)['cut_at(96)'], false);
  const wide = evaluate(q, { ...reference, width: 1920 });
  assert.deepEqual([wide.score, wide.basePass, wide.pass], [1, false, false]);
  // 读数里没有画幅，交付规格那条就是没核过，不能算过
  const { width: _, ...sizeless } = reference;
  assert.deepEqual([base(evaluate(q, sizeless))['delivery(width=1080, height=1080, fps=30, frames=510)'], evaluate(q, sizeless).pass], [false, false]);
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
  // 随机基线的取样口径：全片每一帧，容差两端都算
  assert.deepEqual(verdict.items[1].detail.baselineFrames, [0, 600]);
  assert.ok(ref.clicks.every((frame, i) => ref.cuts[i] - frame === 2));
  // 切点改成点击后第 4 帧：对位那一项还过，切点那一项不过
  assert.deepEqual(passed(evaluate(q, { ...ref, cuts: ref.clicks.map((frame) => frame + 4) })), [false, true]);
  // 点击少一个：事件数和题面不一致
  assert.equal(evaluate(q, { ...ref, clicks: ref.clicks.slice(1), cuts: ref.cuts.slice(1) }).pass, false);
  // 随机打点（切点照样跟在点击后 2 帧）：命中率在随机基线附近，没有一次能过
  const rates = [];
  for (let seed = 1; seed <= 200; seed++) {
    const rand = lcg(seed);
    const picked = new Set();
    while (picked.size < 11) picked.add(Math.floor(rand() * (ref.frames - 2)));
    const clicks = [...picked].sort((a, b) => a - b);
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

test('B3-8 27-1 从真片读数：read27_1 用 deliverSpec、cutYdif、audioLoudness 量合成片，-14 LUFS 的满分，-8.7 LUFS 的判不合格', MEDIA, async () => {
  const { evaluate, read27_1 } = await evaluator();
  const q = question('27-1'), { cuts } = reading('27-1.reference');
  const dir = workdir();
  try {
    const film = (name, gainDb) => {
      const file = join(dir, name);
      flipFilm(file, { size: [1080, 1080], fps: 30, frames: 510, cuts },
        ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=17', '-af', `volume=${gainDb}dB`, '-ac', '2']);
      return read27_1(file);
    };
    // 先量一遍，再把增益补到目标响度
    const probe = await film('probe.mov', -20);
    assert.deepEqual([probe.width, probe.height, probe.fps, probe.frames, probe.cuts], [1080, 1080, 30, 510, cuts]);
    for (const [target, expected, pass] of [[-14, [true, true], true], [-8.7, [true, false], false]]) {
      const measured = await film(`tone${target}.mov`, -20 + target - probe.loudnessLufs);
      assert.ok(Math.abs(measured.loudnessLufs - target) <= 0.1, `${measured.loudnessLufs} LUFS`);
      const verdict = evaluate(q, measured);
      assert.deepEqual([passed(verdict), verdict.basePass, verdict.pass], [expected, pass, pass], `${target} LUFS`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-9 一审反例：不成形的读数一律判 0 分、不合格、基础谓词不过，不向外抛错', async () => {
  const { evaluate } = await evaluator();
  const refs = Object.fromEntries(IDS.map((id) => [id, reading(`${id}.reference`)]));
  const rejected = (id, bad, why) => {
    const verdict = evaluate(question(id), bad);
    assert.deepEqual([verdict.score, verdict.pass, verdict.basePass, passed(verdict)], [0, false, false, [false, false]], `${id} ${why}`);
    assert.ok(verdict.items.every((item) => typeof item.detail.invalid === 'string'), `${id} ${why} 要说明读数哪里不成形`);
  };
  const holed = (list) => { const copy = [...list]; delete copy[1]; return copy; };
  for (const id of IDS) {
    for (const bad of [null, undefined, 42, '读数', [], () => {}]) rejected(id, bad, `读数是 ${String(bad)}`);
    rejected(id, { ...refs[id], fps: 0 }, 'fps 是 0');
    rejected(id, { ...refs[id], fps: refs[id].fps + 1 }, 'fps 和交付规格不一致');
    rejected(id, { ...refs[id], frames: refs[id].frames + 1 }, 'frames 和交付规格不一致');
  }
  // 带机关的对象：已撤销的代理、一读就抛的取值器照样干净判不合格；读一回变一回的字段只读一次，按头一回的值判
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const id of IDS) {
    rejected(id, revoked.proxy, '已撤销的代理');
    rejected(id, Object.defineProperty({ ...refs[id] }, 'fps', { enumerable: true, get() { throw new TypeError('机关'); } }), '一读就抛的取值器');
  }
  let reads = 0;
  const flip = Object.defineProperty({ ...refs['27-1'] }, 'loudnessLufs', { enumerable: true, get: () => (reads++ ? -8.7 : -14) });
  assert.deepEqual([evaluate(question('27-1'), flip).pass, reads], [true, 1]);
  // 缺子表、数组有空洞、混进 NaN 或 null
  const tables = { '27-1': ['cuts'], '29-2': ['clicks', 'cuts', 'onsetsMs'], '23-2': ['chaptersMs', 'strongOnsetsMs', 'beat'], '30-1': ['moments', 'timeline'] };
  for (const [id, fields] of Object.entries(tables)) {
    for (const field of fields) {
      const { [field]: table, ...rest } = refs[id];
      rejected(id, rest, `缺 ${field}`);
      rejected(id, { ...rest, [field]: 'x' }, `${field} 不是表`);
      if (!Array.isArray(table)) continue;
      rejected(id, { ...rest, [field]: holed(table) }, `${field} 有空洞`);
      for (const junk of [NaN, null, Infinity, -1, '7']) rejected(id, { ...rest, [field]: [table[0], junk, ...table.slice(2)] }, `${field} 混进 ${junk}`);
    }
  }
  // 27-1：响度不是有限数
  rejected('27-1', { ...refs['27-1'], loudnessLufs: NaN }, '响度是 NaN');
  rejected('27-1', { ...refs['27-1'], truePeakDbtp: null }, '真峰值是 null');
  // 29-2：11 条点击记录都是同一帧，只有一个切点；点击、切点要严格递增、落在片内
  rejected('29-2', { ...refs['29-2'], clicks: Array(11).fill(108), cuts: [110] }, '重复点击配同一个切点');
  rejected('29-2', { ...refs['29-2'], clicks: [...refs['29-2'].clicks].reverse() }, '点击没有递增');
  rejected('29-2', { ...refs['29-2'], cuts: [...refs['29-2'].cuts.slice(0, 10), 600] }, '切点出了片尾');
  rejected('29-2', { ...refs['29-2'], onsetsMs: [] }, '起音表是空的');
  rejected('29-2', { ...refs['29-2'], onsetsMs: [...refs['29-2'].onsetsMs, 20000] }, '起音出了片尾');
  rejected('29-2', { ...refs['29-2'], onsetsMs: Array(109).fill(3600) }, '起音表是同一个时刻抄了 109 遍');
  // 23-2：六个章节起点都是 0；节拍表不成形
  rejected('23-2', { ...refs['23-2'], chaptersMs: Array(6).fill(0) }, '章节起点全是 0');
  rejected('23-2', { ...refs['23-2'], chaptersMs: [...refs['23-2'].chaptersMs.slice(0, 5), 28000] }, '章节起点出了片尾');
  rejected('23-2', { ...refs['23-2'], strongOnsetsMs: [] }, '强起音表是空的');
  rejected('23-2', { ...refs['23-2'], strongOnsetsMs: [480, 480, 480] }, '强起音是同一个时刻抄了三遍');
  for (const beat of [null, [], { periodMs: 0, phaseMs: 0 }, { periodMs: NaN, phaseMs: 480 }, { periodMs: 500, phaseMs: 0.5 }, { periodMs: 500 }]) {
    rejected('23-2', { ...refs['23-2'], beat }, `节拍是 ${JSON.stringify(beat)}`);
  }
  // 23-2：原作第 3 个章节错拍，帧率写成 0 也不能混过去（上面按题逐个判过），帧率对的时候照旧只有章节项不过
  assert.deepEqual(passed(evaluate(question('23-2'), reading('23-2.original'))), [false, true]);
  // 30-1：命名时刻要有不空、不重复的名字，帧号是片内的整数；静态检查的两个计数是非负整数
  const { moments, timeline } = refs['30-1'];
  const patch = (change) => moments.map((moment, i) => (i === 2 ? change(moment) : moment));
  rejected('30-1', { ...refs['30-1'], moments: moments.map(({ frame }) => ({ frame })) }, '时刻都没有名字');
  rejected('30-1', { ...refs['30-1'], moments: moments.map((moment) => ({ ...moment, id: 'm' })) }, '时刻都同名');
  rejected('30-1', { ...refs['30-1'], moments: patch((moment) => ({ ...moment, id: '' })) }, '有一个名字是空的');
  rejected('30-1', { ...refs['30-1'], moments: patch((moment) => ({ ...moment, id: 3 })) }, '有一个名字不是字符串');
  for (const frame of [NaN, 2178, -18, 18.5, '514', null]) rejected('30-1', { ...refs['30-1'], moments: patch((moment) => ({ ...moment, frame })) }, `帧号是 ${frame}`);
  rejected('30-1', { ...refs['30-1'], moments: patch(() => [514]) }, '时刻不是对象');
  for (const bad of [{ hardcodedFrames: -1 }, { hardcodedFrames: NaN }, { beatConstantDefs: 1.5 }, { beatConstantDefs: '1' }, { hardcodedFrames: undefined }]) {
    rejected('30-1', { ...refs['30-1'], timeline: { ...timeline, ...bad } }, `静态计数是 ${JSON.stringify(bad)}`);
  }
  // 没有节拍表（定义数是 0）：读数成形，静态检查那一项不过
  assert.deepEqual(passed(evaluate(question('30-1'), { ...refs['30-1'], timeline: { beatConstantDefs: 0, hardcodedFrames: 0 } })), [true, false]);
  // 题目和判法对不上是调用方的错，照旧抛
  assert.throws(() => evaluate({ ...question('27-1'), id: '99-9' }, refs['27-1']), /没有和 scoring 对得上的判法/);
});

test('B3-10 29-2 从真片读数：read29_2 从事件表取点击、用 cutYdif 取切点、从声轨取起音；点击挪开就判不合格', MEDIA, async () => {
  const { evaluate, read29_2 } = await evaluator();
  const q = question('29-2');
  // 11 次点击，前 9 次的时刻各有一个起音，后 2 次没有；另放 6 个不挨着点击的起音
  const clicks = [45, 90, 135, 180, 240, 300, 345, 390, 450, 495, 540], cuts = clicks.map((frame) => frame + 2);
  const onsets = [...clicks.slice(0, 9).map((frame) => (frame * 100) / 3), 700, 2300, 5300, 9400, 12100, 19000].sort((a, b) => a - b);
  const events = (frames) => ({ format: 'events/0.1', film: 'f_click', fps: '30/1', frames: 600, events: [
    ...frames.map((frame, i) => ({ id: `click-${String(i + 1).padStart(2, '0')}`, frame, sub: 0, kind: 'named', from: 'film' })),
    ...cuts.map((frame) => ({ id: `cut.${frame}`, frame, sub: 0, kind: 'cut', from: 'film' })),
    { id: 'title', frame: 12, sub: 0, kind: 'named', from: 'film' }] });
  const dir = workdir();
  try {
    const film = join(dir, 'clicks.mov');
    flipFilm(film, { size: [1080, 1350], fps: 30, frames: 600, cuts }, burstTrack(join(dir, 'music.raw'), onsets, 20));
    // 只看左上角一块就够认切点
    const crop = { x: 0, y: 0, width: 90, height: 90 };
    const measured = await read29_2(film, events(clicks), { crop });
    assert.deepEqual(measured, { width: 1080, height: 1350, fps: 30, frames: 600, clicks, cuts, onsetsMs: onsets });
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.basePass, verdict.pass], [[true, true], 1, true, true]);
    assert.deepEqual([verdict.items[1].detail.hits, verdict.items[1].detail.events], [9, 11]);
    assert.ok(verdict.items[1].detail.randomBaseline < 0.1);
    // 同一条片子，事件表里的点击整体晚 7 帧：切点不在点击后第 2 帧，也踩不上起音
    const shifted = evaluate(q, await read29_2(film, events(clicks.map((frame) => frame + 7)), { crop }));
    assert.deepEqual([passed(shifted), shifted.pass], [[false, false], false]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-11 23-2 从真片读数：read23_2 读章节元数据、从声轨估拍子和强起音；第 3 个章节晚 83 毫秒就判不合格', MEDIA, async () => {
  const { evaluate, read23_2 } = await evaluator();
  const q = question('23-2');
  // 120 BPM：拍点在 480 + 500k 毫秒，55 拍每拍一个强起音，另有 4 个不在拍上
  const beats = Array.from({ length: 55 }, (_, k) => 480 + 500 * k), strays = [6200, 11230, 12690, 23730];
  const onsets = [...beats, ...strays].sort((a, b) => a - b);
  const dir = workdir();
  try {
    const audio = burstTrack(join(dir, 'music.raw'), onsets, 28);
    const film = async (name, chapters) => {
      const meta = join(dir, `${name}.txt`), file = join(dir, `${name}.mov`);
      writeFileSync(meta, [';FFMETADATA1', ...chapters.flatMap((start, i) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`,
        `END=${chapters[i + 1] ?? 28000}`, `title=第 ${i + 1} 章`])].join('\n'));
      ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=1920x1080:r=24:d=28', ...audio, '-i', meta, '-map_metadata', '2', '-map_chapters', '2',
        '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', file]);
      return read23_2(file);
    };
    const chapters = [0, 2000, 8000, 14000, 18000, 22000];
    const measured = await film('on-beat', chapters);
    assert.deepEqual(measured, { width: 1920, height: 1080, fps: 24, frames: 672, chaptersMs: chapters,
      beat: { periodMs: 500, phaseMs: 480 }, strongOnsetsMs: onsets });
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.basePass, verdict.pass], [[true, true], 1, true, true]);
    assert.deepEqual([verdict.items[1].detail.hits, verdict.items[1].detail.events], [55, 59]);
    const late = evaluate(q, await film('off-beat', [0, 2000, 8083, 14000, 18000, 22000]));
    assert.deepEqual([passed(late), late.pass], [[false, true], false]);
    assert.equal(Math.max(...late.items[0].detail.offBeatMs), 103);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-12 30-1 从工程读数：read30_1 静态扫工程目录，一张节拍表驱动 20 个命名时刻的满分；散落的帧号、第二处节拍常量都拦下', async () => {
  const { evaluate, read30_1 } = await evaluator();
  const q = question('30-1'), { moments } = reading('30-1.reference');
  const dir = workdir();
  // 一个工程：片子描述 film.json（节拍表 timeline、命名时刻 events）加镜头代码
  const project = (name, { film = {}, code = {} } = {}) => {
    const root = join(dir, name);
    for (const sub of ['shots', 'rig']) mkdirSync(join(root, sub), { recursive: true });
    writeFileSync(join(root, 'film.json'), JSON.stringify({ format: 'film/3.0', id: 'f_beats', title: '一张节拍表',
      output: { size: [1920, 1080], fps: '24/1', frames: 2160 }, timeline: { bpm: 80, beatFrames: 18 },
      shots: [{ id: 's01', in: 0, out: 2160 }],
      events: [...moments, { id: 'flash', frame: 'event(m04) + 6' }, { id: 'echo', frame: 'event(flash) + 9' }],
      overlays: [{ id: 'name', shot: 's01', in: 'event(m02) - 2', out: 'event(m03) + 12', text: '对决' }], ...film }, null, 2));
    const files = { 'shots/fx.js': 'export const burst = (frame, at) => frame >= at(\'m04\') + 6 && frame < at(\'m05\');\n',
      'shots/camera.mjs': '// 第 432 帧附近推近：时刻从节拍表来\nexport const push = (frame, at, beatFrames) => (frame - at(\'m02\')) / beatFrames;\n', ...code };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    return read30_1(root);
  };
  try {
    const good = project('one-table');
    assert.deepEqual(good, { width: 1920, height: 1080, fps: 24, frames: 2160, moments,
      timeline: { beatConstantDefs: 1, hardcodedFrames: 0, found: [] } });
    const verdict = evaluate(q, good);
    assert.deepEqual([passed(verdict), verdict.score, verdict.basePass, verdict.pass], [[true, true], 1, true, true]);
    assert.deepEqual([verdict.items[0].detail.hits, verdict.items[0].detail.events], [17, 20]);
    // 反例一：镜头代码里散落写死的帧号
    const magic = project('magic-frames', { code: { 'shots/fx.js': 'export const burst = (frame) => frame >= 432 && frame < 648;\nexport const cue = { frame: 989 };\n' } });
    assert.equal(magic.timeline.hardcodedFrames, 3);
    assert.deepEqual(magic.timeline.found, ['shots/fx.js:1', 'shots/fx.js:1', 'shots/fx.js:2']);
    assert.deepEqual([passed(evaluate(q, magic)), evaluate(q, magic).pass], [[true, false], false]);
    // 反例二：片子描述里叠加层的出入点写死帧号
    const pinned = project('pinned-overlay', { film: { overlays: [{ id: 'name', shot: 's01', in: 240, out: 'event(m03) + 12', text: '对决' }] } });
    assert.deepEqual([pinned.timeline.hardcodedFrames, pinned.timeline.found], [1, ['film.json:overlays/name/in']]);
    assert.deepEqual(passed(evaluate(q, pinned)), [true, false]);
    // 反例三：配乐代码自己又定义了一遍节拍常量
    const twice = project('two-tables', { code: { 'shots/music.js': 'const BPM = 80;\nexport const beatSeconds = 60 / BPM;\n' } });
    assert.equal(twice.timeline.beatConstantDefs, 2);
    assert.deepEqual(passed(evaluate(q, twice)), [true, false]);
    // 反例三之二：Python 脚本里的帧号和节拍常量一样认，# 注释里的不算
    const script = project('python-rig', { code: { 'rig/keys.py': '# frame == 432 只是注释\nBPM = 80\nif frame == 432:\n    flash()\n' } });
    assert.deepEqual([script.timeline.beatConstantDefs, script.timeline.found], [2, ['rig/keys.py:3']]);
    // 反例四：没有节拍表
    const none = project('no-table', { film: { timeline: undefined } });
    assert.equal(none.timeline.beatConstantDefs, 0);
    assert.deepEqual(passed(evaluate(q, none)), [true, false]);
    // 反例五：命名时刻不在拍上（整体晚 5 帧）
    const drift = project('off-grid', { film: { events: moments.map((moment) => ({ ...moment, frame: moment.frame + 5 })) } });
    assert.deepEqual(passed(evaluate(q, drift)), [false, true]);
    // 没有片子描述的目录：读数不成形，干净判不合格
    mkdirSync(join(dir, 'empty'));
    const empty = evaluate(q, read30_1(join(dir, 'empty')));
    assert.deepEqual([empty.score, empty.pass, empty.basePass], [0, false, false]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-13 机器上没有 ffmpeg：三个读真片的函数回 toolMissing 说明缺哪个工具，拿去判分是干净的不合格', async () => {
  const { evaluate, read27_1, read29_2, read23_2 } = await evaluator();
  const dir = workdir(), path = process.env.PATH;
  process.env.PATH = dir;
  try {
    const film = join(dir, 'film.mov');
    const readings = { '27-1': await read27_1(film), '29-2': await read29_2(film, { events: [] }), '23-2': await read23_2(film) };
    for (const [id, measured] of Object.entries(readings)) {
      assert.match(measured.toolMissing, /^ff(mpeg|probe)$/, id);
      const verdict = evaluate(question(id), measured);
      assert.deepEqual([verdict.score, verdict.pass, verdict.basePass], [0, false, false], id);
    }
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});
