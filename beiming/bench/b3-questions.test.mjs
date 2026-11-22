// B3：二级第一批 4 道考题（27-1、29-2、23-2、30-1[外01-1]）契约校验与随机基线/反例自动判分核验
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateAssertion } from '../verify/predicates.mjs';
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
// 镜头表：切点把全片分成首尾相接的镜头
const shotsAt = (cuts, frames) => [0, ...cuts].map((start, i) => ({ in: start, out: cuts[i] ?? frames }));
// 合成片这一头的交付量测：色彩标签是 BT.709，没有黑帧，没有冻结
const CLEAN = { colorTag: 'bt709', blackFrames: [], freezes: [] };
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
// 合成画面：每过一个切点深浅翻一次，逐帧再抖 4 个码值（不算冻结，也够不上切点），三十分之一的小图放大到交付尺寸，
// 无损编码，打 BT.709 标签；声音的输入参数接在后面
function flipFilm(file, { size: [width, height], fps, frames, cuts }, audio) {
  const w = width / 30, h = height / 30, raw = Buffer.alloc(frames * w * h);
  for (let f = 0; f < frames; f++) raw.fill((cuts.filter((cut) => cut <= f).length % 2 ? 200 : 60) + (f % 2) * 4, f * w * h, (f + 1) * w * h);
  ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0', ...audio,
    '-vf', `scale=${width}:${height}:flags=neighbor`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'pcm_s16le', file], raw);
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
  // 基础谓词和判分一起看：五条都交给正式谓词核，参考读数五条都过
  const base = (verdict) => Object.fromEntries(verdict.base.map((item) => [item.predicate, item.pass]));
  const shotCheck = (verdict) => verdict.base.find((item) => item.predicate === 'cut_at(shots)');
  assert.deepEqual(base(evaluate(q, reference)), { 'delivery(width=1080, height=1080, fps=30, frames=510)': true, 'cut_at(shots)': true,
    'cut_at(96)': true, 'loudness(film) in [-15,-13]': true, 'true_peak(film) <= -1': true });
  // 第 96 帧没切（挪到了第 48 帧）：首切不在第 96 帧，切点项不过；镜头表里 96 那个交界也没检出
  const late = evaluate(q, { ...reference, cuts: [48, ...reference.cuts.slice(1)] });
  assert.deepEqual([passed(late), late.score, late.basePass, late.pass], [[false, true], 0.4, false, false]);
  assert.deepEqual([base(late)['cut_at(96)'], base(late)['cut_at(shots)']], [false, false]);
  // 二审反例：第 96 帧照切，还是 13 个切点，每个镜头都是 1、2、4、8 拍，只是第 48 帧先切了一刀。
  // 镜头表照这组切点写，基础谓词全过，判不合格靠的是首切
  const early = [48, 96, 144, 168, 192, 240, 264, 276, 288, 336, 384, 432, 456];
  const rushed = evaluate(q, { ...reference, cuts: early, shots: shotsAt(early, 510) });
  assert.deepEqual([passed(rushed), rushed.basePass, rushed.pass, rushed.items[0].detail.firstCut], [[false, true], true, false, 48]);
  // 二审反例：镜头表在第 100 帧有交界，成片切点里没有 100。判分两项都过，基础谓词不过，带着反例帧
  const split = evaluate(q, { ...reference, shots: shotsAt([100], 510) });
  assert.deepEqual([passed(split), split.score, split.basePass, split.pass], [[true, true], 1, false, false]);
  assert.deepEqual([shotCheck(split).pass, shotCheck(split).status, shotCheck(split).atFrame], [false, 'fail', 100]);
  // 没证据的不算过：读数里没有镜头表、镜头表不首尾相接、没有色彩标签
  const { shots: _shots, ...shotless } = reference;
  for (const bad of [shotless, { ...reference, shots: [] }, { ...reference, shots: [{ in: 0, out: 96 }, { in: 100, out: 510 }] }, { ...reference, shots: shotsAt([96], 500) }]) {
    const verdict = evaluate(q, bad);
    assert.deepEqual([shotCheck(verdict).pass, shotCheck(verdict).status, verdict.score, verdict.basePass, verdict.pass], [false, 'skipped', 1, false, false]);
  }
  const { colorTag: _tag, ...untagged } = reference;
  assert.deepEqual([base(evaluate(q, untagged))['delivery(width=1080, height=1080, fps=30, frames=510)'], evaluate(q, untagged).pass], [false, false]);
  // 交付谓词连黑帧、半秒以上的冻结一起管；镜头声明成刻意的那一段不算
  assert.equal(evaluate(q, { ...reference, blackFrames: [50] }).basePass, false);
  assert.equal(evaluate(q, { ...reference, freezes: [{ in: 10, out: 40 }] }).basePass, false);
  const held = reference.shots.map((shot, i) => (i ? shot : { ...shot, deliberate: [{ kind: 'freeze', in: 10, out: 40, why: '定格' }] }));
  assert.equal(evaluate(q, { ...reference, freezes: [{ in: 10, out: 40 }], shots: held }).pass, true);
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
  assert.deepEqual(ref.timeline, { bpm: 80, beatFrames: 18, beatConstantDefs: 1, hardcodedFrames: 0 });
  const timed = (timeline) => evaluate(q, { ...ref, timeline });
  assert.deepEqual(passed(timed({ ...ref.timeline, hardcodedFrames: 1 })), [true, false]);
  assert.deepEqual(passed(timed({ ...ref.timeline, beatConstantDefs: 2 })), [true, false]);
  // 二审反例：节拍表得是题面的 80 BPM（24 帧每秒下一拍 18 帧），落拍也按工程自己那张表算。
  // 表写成 120 BPM、bpm 和 beatFrames 对不上，落拍项不过；只写其中一个、写对了，照样认
  assert.deepEqual(passed(timed({ ...ref.timeline, bpm: 120, beatFrames: 12 })), [false, true]);
  assert.deepEqual(passed(timed({ ...ref.timeline, beatFrames: 12 })), [false, true]);
  assert.deepEqual(passed(timed({ ...ref.timeline, bpm: 120 })), [false, true]);
  assert.equal(timed({ bpm: 80, beatConstantDefs: 1, hardcodedFrames: 0 }).score, 1);
  assert.equal(timed({ beatFrames: 18, beatConstantDefs: 1, hardcodedFrames: 0 }).score, 1);
  // 没有节拍表，别处有一个节拍常量：定义数是 1 也不算，两项都不过
  assert.deepEqual(passed(timed({ beatConstantDefs: 1, hardcodedFrames: 0 })), [false, false]);
  // 二审反例：写死帧号的计数也认 hardcodedFrameCount 这个名字；两个名字给了哪个都要是 0，给了负数是不成形
  const { hardcodedFrames: _count, ...uncounted } = ref.timeline;
  assert.equal(timed({ ...uncounted, hardcodedFrameCount: 0 }).score, 1);
  assert.equal(timed({ ...ref.timeline, hardcodedFrameCount: 0 }).score, 1);
  assert.deepEqual(passed(timed({ ...uncounted, hardcodedFrameCount: 2 })), [true, false]);
  assert.deepEqual(passed(timed({ ...ref.timeline, hardcodedFrameCount: 2 })), [true, false]);
  for (const hardcodedFrameCount of [-1, 0.5, '0', null]) {
    const verdict = timed({ ...ref.timeline, hardcodedFrameCount });
    assert.deepEqual([verdict.score, verdict.pass, typeof verdict.items[1].detail.invalid], [0, false, 'string'], `hardcodedFrameCount 是 ${hardcodedFrameCount}`);
  }
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
  const { evaluate, read27_1, readFilm } = await evaluator();
  const q = question('27-1'), { cuts, shots } = reading('27-1.reference');
  const dir = workdir();
  try {
    const film = (name, gainDb) => {
      const file = join(dir, name);
      flipFilm(file, { size: [1080, 1080], fps: 30, frames: 510, cuts },
        ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=17', '-af', `volume=${gainDb}dB`, '-ac', '2']);
      return read27_1(file, { shots });
    };
    // 先量一遍，再把增益补到目标响度
    const probe = await film('probe.mov', -20);
    const { loudnessLufs: _lufs, truePeakDbtp: _peak, ...seen } = probe;
    assert.deepEqual(seen, { width: 1080, height: 1080, fps: 30, frames: 510, ...CLEAN, cuts, shots });
    // readFilm 只量成片这一头，给 30-1 这种读数从工程来的题补交付量测
    assert.deepEqual(await readFilm(join(dir, 'probe.mov')), { width: 1080, height: 1080, fps: 30, frames: 510, ...CLEAN, cuts });
    for (const [target, expected, pass] of [[-14, [true, true], true], [-8.7, [true, false], false]]) {
      const measured = await film(`tone${target}.mov`, -20 + target - probe.loudnessLufs);
      assert.ok(Math.abs(measured.loudnessLufs - target) <= 0.1, `${measured.loudnessLufs} LUFS`);
      const verdict = evaluate(q, measured);
      assert.deepEqual([passed(verdict), verdict.basePass, verdict.pass], [expected, pass, pass], `${target} LUFS`);
      // 同一条片子，工程的镜头表在第 100 帧有交界：成片没在那里切，基础谓词不过
      assert.equal(evaluate(q, { ...measured, shots: shotsAt([100], 510) }).basePass, false);
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
  // 29-2 二审反例：点击帧号出自事件表，事件表的时间基准要和交付规格一致，没写也不行
  rejected('29-2', { ...refs['29-2'], eventsFps: '60/1', eventsFrames: 1200 }, '事件表是 60 帧每秒、1200 帧的');
  rejected('29-2', { ...refs['29-2'], eventsFps: '60/1' }, '事件表的帧率不一致');
  rejected('29-2', { ...refs['29-2'], eventsFps: 30 }, '事件表的帧率不是分数写法');
  rejected('29-2', { ...refs['29-2'], eventsFrames: 1200 }, '事件表的总帧数不一致');
  for (const field of ['eventsFps', 'eventsFrames']) {
    const { [field]: _base, ...rest } = refs['29-2'];
    rejected('29-2', rest, `缺 ${field}`);
  }
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
  for (const bad of [{ hardcodedFrames: -1 }, { hardcodedFrames: NaN }, { beatConstantDefs: 1.5 }, { beatConstantDefs: '1' }, { hardcodedFrames: undefined },
    { bpm: 0 }, { bpm: '80' }, { beatFrames: 18.5 }, { beatFrames: null }]) {
    rejected('30-1', { ...refs['30-1'], timeline: { ...timeline, ...bad } }, `静态计数是 ${JSON.stringify(bad)}`);
  }
  // 没有节拍表（定义数是 0）：读数成形，没有表可对，两项都不过
  assert.deepEqual(passed(evaluate(question('30-1'), { ...refs['30-1'], timeline: { beatConstantDefs: 0, hardcodedFrames: 0 } })), [false, false]);
  // 成片这一头的证据（镜头表、色彩标签、黑帧、冻结）缺了或者不成样子：不抛错，判分照算，基础谓词不过
  for (const id of IDS) {
    for (const field of ['shots', 'colorTag', 'blackFrames', 'freezes']) {
      for (const junk of [undefined, null, 5, 'x', {}, [null], [[1, 2]], [{ in: 5 }], [{ in: 0, out: 1e9 }]]) {
        const verdict = evaluate(question(id), { ...refs[id], [field]: junk });
        assert.deepEqual([verdict.score, verdict.basePass, verdict.pass], [1, false, false], `${id} 的 ${field} 是 ${JSON.stringify(junk)}`);
      }
    }
  }
  // 题目和判法对不上是调用方的错，照旧抛
  assert.throws(() => evaluate({ ...question('27-1'), id: '99-9' }, refs['27-1']), /没有和 scoring 对得上的判法/);
});

test('B3-10 29-2 从真片读数：read29_2 从事件表取点击、用 cutYdif 取切点、从声轨取起音；点击挪开就判不合格', MEDIA, async () => {
  const { evaluate, read29_2 } = await evaluator();
  const q = question('29-2');
  // 11 次点击，前 9 次的时刻各有一个起音，后 2 次没有；另放 6 个不挨着点击的起音
  const clicks = [45, 90, 135, 180, 240, 300, 345, 390, 450, 495, 540], cuts = clicks.map((frame) => frame + 2);
  const onsets = [...clicks.slice(0, 9).map((frame) => (frame * 100) / 3), 700, 2300, 5300, 9400, 12100, 19000].sort((a, b) => a - b);
  const events = (frames, base = { fps: '30/1', frames: 600 }) => ({ format: 'events/0.1', film: 'f_click', ...base, events: [
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
    assert.deepEqual(measured, { width: 1080, height: 1350, fps: 30, frames: 600, ...CLEAN, cuts, eventsFps: '30/1', eventsFrames: 600,
      shots: shotsAt(cuts, 600), clicks, onsetsMs: onsets });
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.basePass, verdict.pass], [[true, true], 1, true, true]);
    assert.deepEqual([verdict.items[1].detail.hits, verdict.items[1].detail.events], [9, 11]);
    assert.ok(verdict.items[1].detail.randomBaseline < 0.1);
    // 同一条片子，事件表里的点击整体晚 7 帧：切点不在点击后第 2 帧，也踩不上起音
    const shifted = evaluate(q, await read29_2(film, events(clicks.map((frame) => frame + 7)), { crop }));
    assert.deepEqual([passed(shifted), shifted.pass], [[false, false], false]);
    // 二审反例：同一条片子、同样的点击帧号，事件表头写的是 60 帧每秒、1200 帧。那张表的第 30 帧是 0.5 秒，不是这条片子的 1 秒，不判
    const foreign = evaluate(q, await read29_2(film, events(clicks, { fps: '60/1', frames: 1200 }), { crop }));
    assert.deepEqual([foreign.score, foreign.basePass, foreign.pass], [0, false, false]);
    assert.match(foreign.items[0].detail.invalid, /事件表/);
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
    // 每章一个镜头：切点在第 48、192、336、432、528 帧
    const cuts = [48, 192, 336, 432, 528], shots = shotsAt(cuts, 672);
    flipFilm(join(dir, 'picture.mov'), { size: [1920, 1080], fps: 24, frames: 672, cuts }, audio);
    const film = async (name, chapters) => {
      const meta = join(dir, `${name}.txt`), file = join(dir, `${name}.mov`);
      writeFileSync(meta, [';FFMETADATA1', ...chapters.flatMap((start, i) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`,
        `END=${chapters[i + 1] ?? 28000}`, `title=第 ${i + 1} 章`])].join('\n'));
      ffmpeg(['-i', join(dir, 'picture.mov'), '-i', meta, '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', file]);
      return read23_2(file, { shots });
    };
    const chapters = [0, 2000, 8000, 14000, 18000, 22000];
    const measured = await film('on-beat', chapters);
    assert.deepEqual(measured, { width: 1920, height: 1080, fps: 24, frames: 672, ...CLEAN, cuts, shots, chaptersMs: chapters,
      beat: { periodMs: 500, phaseMs: 480 }, strongOnsetsMs: onsets });
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.basePass, verdict.pass], [[true, true], 1, true, true]);
    assert.deepEqual([verdict.items[1].detail.hits, verdict.items[1].detail.events], [55, 59]);
    const late = evaluate(q, await film('off-beat', [0, 2000, 8083, 14000, 18000, 22000]));
    assert.deepEqual([passed(late), late.pass], [[false, true], false]);
    assert.equal(Math.max(...late.items[0].detail.offBeatMs), 103);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-12 30-1 从工程读数：read30_1 静态扫工程目录，一张 80 BPM 的节拍表驱动 20 个命名时刻的满分；表不对、另起节拍常量、散落的帧号都拦下', async () => {
  const { evaluate, read30_1 } = await evaluator();
  const q = question('30-1'), { moments } = reading('30-1.reference');
  const dir = workdir();
  // 镜头表：一个镜头，相机卡的关键帧从第 0 帧起，片名卡的入场写成命名时刻
  const card = (keys, enter) => [{ as: 'cam', use: 'camera.keys@1', params: { keys } }, { as: 'title', use: 'overlay.title@1', params: { text: '对决', enter } }];
  const shots = [{ id: 's01', in: 0, out: 2160, cards: card([{ f: 0, pos: [0, 0, 1] }], 'event(m02)') }];
  // 一个工程：片子描述 film.json（节拍表 timeline、命名时刻 events）加镜头代码
  const project = (name, { film = {}, code = {} } = {}) => {
    const root = join(dir, name);
    for (const sub of ['shots', 'rig']) mkdirSync(join(root, sub), { recursive: true });
    writeFileSync(join(root, 'film.json'), JSON.stringify({ format: 'film/3.0', id: 'f_beats', title: '一张节拍表',
      output: { size: [1920, 1080], fps: '24/1', frames: 2160 }, timeline: { bpm: 80, beatFrames: 18 }, shots, events: moments,
      overlays: [{ id: 'name', shot: 's01', in: 'event(m02) - 2', out: 'event(m03) + 12', text: '对决' }], ...film }, null, 2));
    // 镜头代码里的时刻都从节拍表来；移位、小数比较、箭头函数回一个数，都不是拿帧号比
    const files = { 'shots/fx.js': 'export const burst = (frame, at) => frame >= at(\'m04\') + 6 && frame < at(\'m05\');\n'
      + 'export const tint = (v) => ((v << 16) | 255) >>> 0;\nexport const ease = (x) => (x * 1.25 <= 1 ? x : 1);\nexport const fill = (list) => list.map(() => 432);\n',
      'shots/camera.mjs': '// 第 432 帧附近推近：时刻从节拍表来\nexport const push = (frame, at, beatFrames) => (frame - at(\'m02\')) / beatFrames;\n', ...code };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    return read30_1(root);
  };
  const judged = (read) => { const verdict = evaluate(q, read); return [passed(verdict), verdict.pass]; };
  try {
    const good = project('one-table');
    assert.deepEqual(good, { width: 1920, height: 1080, fps: 24, frames: 2160, shots, moments,
      timeline: { bpm: 80, beatFrames: 18, beatConstantDefs: 1, hardcodedFrames: 0, found: [] } });
    // 光扫工程：判分两项满分；基础谓词说的是成片，没有成片量测不算过。补上成片这一头（readFilm 量的那几项）才整题合格
    const scanned = evaluate(q, good);
    assert.deepEqual([passed(scanned), scanned.score, scanned.basePass, scanned.pass], [[true, true], 1, false, false]);
    const verdict = evaluate(q, { ...good, ...CLEAN, cuts: [] });
    assert.deepEqual([passed(verdict), verdict.score, verdict.basePass, verdict.pass], [[true, true], 1, true, true]);
    assert.deepEqual([verdict.items[0].detail.hits, verdict.items[0].detail.events], [17, 20]);

    // 二审反例：1 个锚点加 19 个写成算式的时刻（引用写在定义前面也行），展开是 20 个时刻、全在拍上
    const derived = project('derived', { film: { events: [
      ...Array.from({ length: 19 }, (_, k) => ({ id: `m${String(20 - k).padStart(2, '0')}`, frame: `event(m01) + ${18 * (19 - k)}` })), { id: 'm01', frame: 0 }] } });
    assert.deepEqual(derived.moments.map(({ frame }) => frame).sort((a, b) => a - b), Array.from({ length: 20 }, (_, k) => 18 * k));
    const full = evaluate(q, derived);
    assert.deepEqual([passed(full), full.score, full.items[0].detail.hits, full.items[0].detail.events, full.items[0].detail.hitRate], [[true, true], 1, 20, 20, 1]);
    // 以切点为基点的算式一样展开；镜头的出入点、转场、刻意区间契约只许写整数，不算写死的帧号
    const two = project('two-shots', { film: { shots: [{ ...shots[0], out: 1080 }, { id: 's02', in: 1080, out: 2160, deliberate: [{ kind: 'black', in: 1080, out: 1092, why: '换场' }] }],
      transitions: [{ id: 'to-s02', at: 1080, type: 'cut' }], events: [...moments.slice(0, 19), { id: 'drop', frame: 'cut(1080) + 18' }] } });
    assert.deepEqual([two.moments.at(-1), two.timeline.found], [{ id: 'drop', frame: 1098 }, []]);
    assert.deepEqual([evaluate(q, two).items[0].detail.hits, evaluate(q, two).score], [18, 1]);
    // 算式展开不了（引用了没定义的事件）：读不了，干净判不合格
    const ghost = project('ghost', { film: { events: [...moments, { id: 'ghost', frame: 'event(nope) + 3' }] } });
    assert.match(ghost.unreadable, /^film\.json/);
    assert.deepEqual([evaluate(q, ghost).score, evaluate(q, ghost).pass], [0, false]);

    // 二审反例：中央节拍表写成 120 BPM、一拍 12 帧。时刻没动，落拍按这张表算，表也不是题面的 80 BPM
    const fast = project('table-120', { film: { timeline: { bpm: 120, beatFrames: 12 } } });
    assert.deepEqual([fast.timeline.bpm, fast.timeline.beatFrames, fast.timeline.beatConstantDefs], [120, 12, 1]);
    assert.deepEqual(judged(fast), [[false, true], false]);
    // 二审反例：没有中央节拍表，镜头代码自己写了 const BPM = 80。定义数是 1，但那不是节拍表
    const stray = project('stray-bpm', { film: { timeline: undefined }, code: { 'shots/music.js': 'const BPM = 80;\nexport const beatSeconds = 60 / BPM;\n' } });
    assert.deepEqual(stray.timeline, { beatConstantDefs: 1, hardcodedFrames: 0, found: [] });
    assert.deepEqual(judged(stray), [[false, false], false]);
    // 没有节拍表，也没有别的定义
    const none = project('no-table', { film: { timeline: undefined } });
    assert.equal(none.timeline.beatConstantDefs, 0);
    assert.deepEqual(judged(none), [[false, false], false]);
    // 有节拍表，配乐代码自己又定义了一遍节拍常量
    const twice = project('two-tables', { code: { 'shots/music.js': 'const BPM = 80;\nexport const beatSeconds = 60 / BPM;\n' } });
    assert.equal(twice.timeline.beatConstantDefs, 2);
    assert.deepEqual(judged(twice), [[true, false], false]);

    // 二审反例：相机卡的关键帧写死第 432 帧，片名卡的入场写死第 240 帧
    const keyed = project('card-frames', { film: { shots: [{ ...shots[0], cards: card([{ f: 0, pos: [0, 0, 1] }, { f: 432, pos: [0, 0, 2] }], 240) }] } });
    assert.deepEqual(keyed.timeline.found, ['film.json:shots/s01/cards/cam/params/keys/1/f', 'film.json:shots/s01/cards/title/params/enter']);
    assert.deepEqual(judged(keyed), [[true, false], false]);
    // 二审反例：镜头函数的形参不叫 frame，照样是拿帧号跟两位以上的数比；数写在左边、ctx.frame、代码里的关键帧表、switch 的 case 也认
    const bare = project('bare-compare', { code: { 'shots/fx.js': 'export const burst = (f) => f >= 432 && f < 648;\n'
      + 'export const flash = (ctx) => ctx.frame === 5 || 989 < ctx.t;\nexport const keys = [{ f: 0 }, { f: 432 }];\nswitch (f) { case 432: flash(); }\n' } });
    assert.deepEqual(bare.timeline.found, ['shots/fx.js:1', 'shots/fx.js:1', 'shots/fx.js:2', 'shots/fx.js:2', 'shots/fx.js:3', 'shots/fx.js:4']);
    assert.deepEqual(judged(bare), [[true, false], false]);
    // 变量就叫 frame 的写法
    const magic = project('magic-frames', { code: { 'shots/fx.js': 'export const burst = (frame) => frame >= 432 && frame < 648;\nexport const cue = { frame: 989 };\n' } });
    assert.equal(magic.timeline.hardcodedFrames, 3);
    assert.deepEqual(magic.timeline.found, ['shots/fx.js:1', 'shots/fx.js:1', 'shots/fx.js:2']);
    assert.deepEqual(judged(magic), [[true, false], false]);
    // 三审反例：换行不改结论。比较号和帧号分在两行、数写在左边再换行，和写成一行一样各认一处；字符串里的 // 不是注释，它后面的代码照扫
    const wrapped = project('wrapped-compare', { code: { 'shots/fx.js': 'export const burst = (f) => f >=\n  432 && f <\n  648;\n'
      + 'export const late = (ctx) => 989 <=\n  ctx.frame;\nconst src = \'http://example.invalid/a\'; export const hit = (ctx, k) => k >= 432;\n' } });
    assert.deepEqual(wrapped.timeline.found, ['shots/fx.js:1', 'shots/fx.js:2', 'shots/fx.js:4', 'shots/fx.js:6']);
    assert.deepEqual(judged(wrapped), [[true, false], false]);
    // 三审反例：节拍常量换行再定义，和写成一行一样算重复定义（节拍表 1 处加这里 4 处，Python 的反斜杠续行在内）
    const split = project('wrapped-bpm', { code: { 'shots/music.js': 'const BPM =\n  120;\nlet beatFrames =\n  12;\nexport const table = { bpm:\n  120 };\n'
      + 'export const turn = (f) => (f * BPM) / beatFrames / table.bpm;\n', 'rig/tempo.py': 'TEMPO = \\\n    120\n' } });
    assert.equal(split.timeline.beatConstantDefs, 5);
    assert.deepEqual(judged(split), [[true, false], false]);
    assert.deepEqual(judged(project('wrapped-bpm-once', { code: { 'shots/music.js': 'const BPM =\n  120;\nexport const turn = (f) => f * BPM;\n' } })), [[true, false], false]);
    // 三审反例：像素宽度、画幅比、循环下标跟数比不是帧号；注释、字符串、模板字符串里的字样也不算。整题照样满分
    const pixels = project('pixel-width', { code: { 'shots/fit.js': 'export function fit(ctx, mesh) {\n  const [width, height] = ctx.size, aspect = width / height;\n'
      + '  mesh.scale.x = ctx.size[0] >= 640 ? 1 : 0.5;\n  if (width >= 1920 && height < 1080 && aspect > 1) mesh.visible = true;\n'
      + '  for (let i = 0; i < 100; i++) mesh.rotation.y += 0.01;\n  /* f >= 432\n     frame === 240 */\n'
      + '  return \'frame >= 432，见 http://example.invalid/432\' + `BPM = 120; f >= ${width}`; // const BPM = 120\n}\n'
      + 'export const wide = (width) => width >= 1920;\n' } });
    assert.deepEqual([pixels.timeline.found, pixels.timeline.beatConstantDefs], [[], 1]);
    const fitted = evaluate(q, { ...pixels, ...CLEAN, cuts: [] });
    assert.deepEqual([passed(fitted), fitted.score, fitted.pass], [[true, true], 1, true]);
    // 同一个工程把帧号比较写进模板字符串的 ${} 里、用只做加减的派生量去比，照样拦下
    const sly = project('derived-frame', { code: { 'shots/fx.js': 'export const tag = (f) => `${f >= 432 ? 1 : 0}`;\n'
      + 'export function state(n, sub) {\n  const local = n - 96;\n  return local >= 24 && n < 648;\n}\n' } });
    assert.deepEqual(sly.timeline.found, ['shots/fx.js:1', 'shots/fx.js:4', 'shots/fx.js:4']);
    assert.deepEqual(judged(sly), [[true, false], false]);
    // 下面几组补上成片这一头再判，结论只跟源码扫描走：[写死的帧号数, 得分, 整题合格]
    const whole = (read) => { const all = evaluate(q, { ...read, ...CLEAN, cuts: [] }); return [read.timeline.hardcodedFrames, all.score, all.pass]; };
    const shot = (name, body) => project(name, { code: { 'shots/shot.js': `export function build(ctx, mesh) {\n  return { state(f, sub) {\n${body}\n  }, meta() { return {}; } };\n}\n` } });
    // 四审反例：派生量的初值换到等号下一行，和写成一行一样认两处；不写分号、算式中间换行、一条 const 连着声明两个量、带类型标注也一样
    for (const [name, init] of Object.entries({ 'local-one-line': 'const local = f - 1;', 'local-wrapped': 'const local =\n  f - 1;', 'local-no-semicolon': 'const local =\n  f -\n  1',
      'local-second': 'const zero = 0, local = f\n  - 1;', 'local-typed': 'const local: number = f - 1;' })) {
      assert.deepEqual(whole(shot(name, `${init}\n  mesh.visible = local >= 432 && local < 648;`)), [2, 0.6, false], name);
    }
    // 派生量的定义写在用处后面（闭包里先用），多认几遍照样传到
    assert.deepEqual(whole(shot('local-later', '  const show = () => { const late = local + 6; return late >= 432; };\n  const local = f - 1;\n  mesh.visible = show();')), [1, 0.6, false]);
    // 四审反例：比像素宽度的辅助函数写成 function 还是箭头函数都不是帧回调，形参不当帧，整题照样满分
    for (const [name, wide] of Object.entries({ 'wide-function': 'function wide(pixels) { return pixels >= 640; }', 'wide-arrow': 'const wide = pixels => pixels >= 640;',
      'wide-arrow-parens': 'const wide = (pixels) => pixels >= 640;' })) {
      assert.deepEqual(whole(project(name, { code: { 'shots/fit.js': `${wide}\nexport const fit = (ctx, mesh) => { mesh.scale.x = wide(ctx.size[0]) ? 1 : 0.5; };\n` } })), [0, 1, true], name);
    }
    // 帧回调的第一个形参不管叫什么都是帧：写成方法、属性上的箭头函数、对象里点名的函数（state: tick）都认
    for (const [name, code] of Object.entries({ 'hook-method': 'export const build = () => ({ state(n, sub) { return n >= 432; } });',
      'hook-arrow': 'export const build = () => ({ state: n => n >= 432 });',
      'hook-named': 'const tick = n => n >= 432;\nexport function build() {\n  return { state: tick, meta() { return {}; } };\n}',
      'hook-named-function': 'function tick(n, sub) { return n >= 432; }\nexport const build = () => ({ meta: () => ({}), state: tick });' })) {
      assert.deepEqual(whole(project(name, { code: { 'shots/shot.js': `${code}\n` } })), [1, 0.6, false], name);
    }
    // 五审反例：四对画面逐帧相同的镜头，判定要成对相同。JS 按语法树和词法作用域认帧，不看名字在文件别处是什么
    const lifecycle = (hooks, top = '') => `${top}export const build = () => ({ ${hooks}, meta() { return {}; } });\n`;
    const HARD = [1, 0.6, false], SOFT = [0, 1, true];
    for (const [name, code, want] of [
      // 1 派生量写在箭头工厂返回的对象里，和写在 function 里一样认两处
      ['factory-function', 'export function build() {\n  return { state(f, ctx) {\n    const local =\n      f - 1;\n    return local >= 432 && local < 648;\n  } };\n}\n', [2, 0.6, false]],
      ['factory-arrow', lifecycle('state(f, ctx) {\n    const local =\n      f - 1;\n    return local >= 432 && local < 648;\n  }'), [2, 0.6, false]],
      // 2 帧回调的第一个形参叫 i 也是帧；普通循环的 i 不是
      ['hook-cursor', lifecycle('state(cursor, ctx) { return cursor >= 432; }'), HARD],
      ['hook-i', lifecycle('state(i, ctx) { return i >= 432; }'), HARD],
      ['loop-i', lifecycle('state(f, ctx) { let n = 0; for (let i = 0; i < 100; i++) n += i >= 50 ? 1 : 0; return n; }'), SOFT],
      // 3 调用 fit(ctx, pixels) 是调用，不是形参表；有调用点的函数，形参是不是帧看传进来的实参
      ['call-view', lifecycle('state(f, view) { const pixels = view.size[0]; return fit(view, pixels); }', 'const wide = pixels => pixels >= 640;\nconst fit = (v, w) => wide(w);\n'), SOFT],
      ['call-ctx', lifecycle('state(f, ctx) { const pixels = ctx.size[0]; return fit(ctx, pixels); }', 'const wide = pixels => pixels >= 640;\nconst fit = (v, w) => wide(w);\n'), SOFT],
      ['call-ctx-param', lifecycle('state(f, ctx) { const pixels = ctx.size[0]; return fit(ctx, pixels); }', 'const wide = pixels => pixels >= 640;\nconst fit = (ctx, w) => wide(w);\n'), SOFT],
      ['call-apply', lifecycle('state(f, ctx) { return apply(ctx.size[0]); }', 'const apply = pixels => pixels >= 640;\n'), SOFT],
      // 4 辅助函数自己的形参和外层的帧形参重名，里面那个是像素
      ['shadow-pixels', lifecycle('state(cursor, ctx) { const wide = pixels => pixels >= 640; return wide(ctx.size[0]); }'), SOFT],
      ['shadow-cursor', lifecycle('state(cursor, ctx) { const wide = cursor => cursor >= 640; return wide(ctx.size[0]); }'), SOFT],
      // 帧传进辅助函数换了形参名、不经声明直接赋值、解构改名、帧号藏在算术里、换进制、换成秒，都是同一个第 432 帧
      ['helper-arg', lifecycle('state(f, ctx) { return on(f - 1); }', 'const on = n => n >= 431;\n'), HARD],
      ['assigned-later', lifecycle('state(f, ctx) { let local; local = f - 1; return local >= 431; }'), HARD],
      ['destructured', lifecycle('state(f, ctx) { const { frame: n } = ctx; return n >= 432; }'), HARD],
      ['offset-in-derived', lifecycle('state(f, ctx) { const local = f - 432; return local >= 0; }'), HARD],
      ['offset-inline', lifecycle('state(f, ctx) { return f - 432 >= 0; }'), HARD],
      ['hex', lifecycle('state(f, ctx) { return f >= 0x1b0; }'), HARD],
      ['seconds', lifecycle('state(f, ctx) { const sec = f / 24; return sec >= 18; }'), HARD],
      ['folded', lifecycle('state(f, ctx) { return f >= 18 * 24; }'), HARD],
      // 相对命名时刻的偏移、归一化的进度不是写死的帧号
      ['relative', lifecycle('state(f, ctx) { const since = f - ctx.at(\'m02\'); return since >= 12 && f / ctx.total >= 0.5 && ctx.t > 1; }'), SOFT],
      // 六审反例：三对画面逐帧相同的镜头
      // 1 落在局部绑定上的 f 看这个绑定：有调用点的辅助函数形参叫 f，传进来的是像素宽度就不是帧；初值是像素的局部量叫 f 也不是
      ['inner-pixels', lifecycle('state(f, view) { const wide = pixels => pixels >= 640; return wide(view.size[0]); }'), SOFT],
      ['inner-f', lifecycle('state(f, view) { const wide = f => f >= 640; return wide(view.size[0]); }'), SOFT],
      ['local-f-pixels', lifecycle('state(cursor, view) { const f = view.size[0]; return f >= 640; }'), SOFT],
      // 2 同一个辅助函数在两处收到不同的帧式子，哪一处写在前面都认
      ['calls-late-first', lifecycle('state(f, ctx) { const late = on(f - 432), early = on(f); return early && late; }', 'function on(n) { return n >= 0; }\n'), HARD],
      ['calls-early-first', lifecycle('state(f, ctx) { const early = on(f), late = on(f - 432); return early && late; }', 'function on(n) { return n >= 0; }\n'), HARD],
      // 3 帧回调的第一个形参叫 ctx 也是帧，写成方法还是单独的 function 都一样
      ['hook-ctx', lifecycle('state(ctx, sub) { return ctx >= 432; }'), HARD],
      ['hook-ctx-function', 'export function state(ctx, sub) { return ctx >= 432; }\n', HARD],
    ]) assert.deepEqual(whole(project(name, { code: { 'shots/shot.js': code } })), want, name);
    // 带类型标注的源码先抹掉类型再解析，结论和不带标注的一样（这台 Node 没有 stripTypeScriptTypes 时退回正则扫描，不在这里核）
    if (typeof nodeModule.stripTypeScriptTypes === 'function') {
      for (const [name, hooks, want] of [['typed-hook-i', 'state(i: number, ctx: { size: number[] }): boolean { return i >= 432; }', HARD],
        ['typed-shadow', 'state(cursor: number, ctx: { size: number[] }) { const wide = (cursor: number) => cursor >= 640; return wide(ctx.size[0]); }', SOFT]]) {
        assert.deepEqual(whole(project(name, { code: { 'shots/shot.ts': lifecycle(hooks) } })), want, name);
      }
    }
    // 片子描述里叠加层的出入点写死帧号
    const pinned = project('pinned-overlay', { film: { overlays: [{ id: 'name', shot: 's01', in: 240, out: 'event(m03) + 12', text: '对决' }] } });
    assert.deepEqual([pinned.timeline.hardcodedFrames, pinned.timeline.found], [1, ['film.json:overlays/name/in']]);
    assert.deepEqual(judged(pinned), [[true, false], false]);
    // Python 脚本里的帧号和节拍常量一样认，# 注释里的不算
    const script = project('python-rig', { code: { 'rig/keys.py': '# frame == 432 只是注释\nBPM = 80\nif frame == 432:\n    flash()\nif 432 <= t < 648:\n    hold()\n' } });
    assert.deepEqual([script.timeline.beatConstantDefs, script.timeline.found], [2, ['rig/keys.py:3', 'rig/keys.py:5', 'rig/keys.py:5']]);
    // 命名时刻不在拍上（整体晚 5 帧）
    const drift = project('off-grid', { film: { events: moments.map((moment) => ({ ...moment, frame: moment.frame + 5 })) } });
    assert.deepEqual(judged(drift), [[false, true], false]);
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

test('B3-14 基础谓词和正式谓词核不打架：读数带镜头表时逐条同一个结论，B3 判过的正式谓词核一定判过', async () => {
  const { evaluate } = await evaluator();
  const ref = reading('27-1.reference'), early = [48, 96, 144, 168, 192, 240, 264, 276, 288, 336, 384, 432, 456];
  const readings = [...readdirSync(REFS).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(REFS, name), 'utf8'))),
    { ...ref, shots: shotsAt([100], 510) }, { ...ref, cuts: early }, { ...ref, cuts: early, shots: shotsAt(early, 510) }, { ...ref, cuts: [] },
    { ...ref, colorTag: 'bt601' }, { ...ref, width: 1920 }, { ...ref, blackFrames: [50] }, { ...ref, freezes: [{ in: 10, out: 40 }] },
    { ...ref, loudnessLufs: -8.7 }, { ...ref, truePeakDbtp: 2.1 }];
  let compared = 0;
  for (const read of readings) {
    const q = question(read.question), { size, fps, frames } = q.deliverable;
    // 这里照正式谓词核的输入格式另拼一遍片子描述和量测，不经过判分器
    const film = { output: { size, fps, frames }, shots: read.shots };
    const measured = { output: { size: [read.width, read.height], fps, frames: read.frames, colorTag: read.colorTag }, blackFrames: read.blackFrames,
      freezes: read.freezes, cuts: read.cuts, audio: { loudnessLufs: read.loudnessLufs, truePeakDbtp: read.truePeakDbtp } };
    const verdict = evaluate(q, read);
    assert.deepEqual(verdict.base.map((item) => item.predicate), q.basePredicates);
    for (const item of verdict.base) {
      const formal = evaluateAssertion(item.predicate, film, measured);
      if (item.pass) assert.equal(formal.status, 'pass', `${read.question} ${item.predicate}`);
      if (Array.isArray(read.shots)) {
        assert.deepEqual([item.status, item.pass], [formal.status, formal.status === 'pass'], `${read.question} ${item.predicate}`);
        compared++;
      }
    }
    assert.equal(verdict.basePass, verdict.base.every((item) => item.pass));
    assert.equal(verdict.pass, verdict.basePass && verdict.items.every((item) => item.pass));
  }
  assert.ok(compared >= 50, `只比了 ${compared} 条`);
});
