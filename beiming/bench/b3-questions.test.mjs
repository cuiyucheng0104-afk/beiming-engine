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
    const GE = 'const ge = (x, min) => x >= min;\n', PAIR = 'ge(frame, view.events.m01) && ge(view.size[0], 640)', PAIR_HARD = 'ge(frame, 432) && ge(view.size[0], 640)';
    const GE_WIDE = 'const ge = (x, min = 640) => x >= min;\n', GE_LATE = 'const ge = (x, min = 432) => x >= min;\n';
    const ON = 'const on = ctx => ctx >= 0;\n', SUB = 'const sub = (a, b) => a - b;\n', OFFSET = 'const offset = n => n - 432;\n';
    // 7 个两两互相调用的函数
    const TANGLE = Array.from({ length: 7 }, (_, i) => `const m${i} = n => ${Array.from({ length: 7 }, (_, j) => `m${j}(n)`).join(' + ')} + n - 1;\n`).join('');
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
      // 七审反例：三对画面逐帧相同的镜头
      // 1 交给 some 这类调用的回调，形参叫 f 也不是帧：点名交、直接写在调用里、写在文件顶层都一样。调用点在别的文件的导出函数照旧按名字认
      ['callback-pixels', lifecycle('state(n, view) { const wide = pixels => pixels >= 640; return view.size.some(wide); }'), SOFT],
      ['callback-f', lifecycle('state(n, view) { const wide = f => f >= 640; return view.size.some(wide); }'), SOFT],
      ['callback-inline-f', lifecycle('state(n, view) { return view.size.some(f => f >= 640); }'), SOFT],
      ['callback-top-f', lifecycle('state(n, view) { return view.size.some(wide); }', 'const wide = f => f >= 640;\n'), SOFT],
      ['callback-exported-f', lifecycle('state(n, view) { return view.size.some(wide); }', 'export const wide = f => f >= 640;\n'), SOFT],
      ['unused-local-f', lifecycle('state(n, view) { const wide = f => f >= 640; return view.size[0] >= 640; }'), SOFT],
      ['exported-f', lifecycle('state(n, view) { return true; }', 'export const late = f => f >= 432;\n'), HARD],
      // 2 固定偏移取了局部常量名，和直接写数一样认：声明时给值、后来才赋值、-= 减掉、常数当实参传进去都算；两边都是像素常数的比较不算
      ['offset-literal', lifecycle('state(frame, ctx) { return on(frame) && on(frame - 432); }', 'const on = x => x >= 0;\n'), HARD],
      ['offset-const', lifecycle('state(frame, ctx) { const delay = 432; return on(frame) && on(frame - delay); }', 'const on = x => x >= 0;\n'), HARD],
      ['offset-const-top', lifecycle('state(frame, ctx) { return on(frame) && on(frame - DELAY); }', 'const DELAY = 18 * 24;\nconst on = x => x >= 0;\n'), HARD],
      ['offset-assigned', lifecycle('state(frame, ctx) { let delay; delay = 432; return on(frame - delay); }', 'const on = x => x >= 0;\n'), HARD],
      ['offset-compound', lifecycle('state(f, ctx) { let local = f; local -= 432; return local >= 0; }'), HARD],
      ['offset-reassigned', lifecycle('state(f, ctx) { let local = f; local = local - 432; return local >= 0; }'), HARD],
      ['const-threshold', lifecycle('state(f, ctx) { const start = 432; return f >= start; }'), HARD],
      ['const-arg', lifecycle('state(f, ctx) { return on(f, 432); }', 'const on = (x, from) => x >= from;\n'), HARD],
      ['const-pixels', lifecycle('state(f, view) { const min = 640, pixels = view.size[0]; return pixels >= min && wide(min); }', 'const wide = w => w >= 640;\n'), SOFT],
      ['const-relative', lifecycle('state(f, ctx) { const hold = 12, since = f - ctx.at(\'m02\'); return since >= hold; }'), SOFT],
      // 3 同一个辅助函数收到 17 种偏移，第 432 帧那个排第一还是排最后都认
      ['offsets-late-first', lifecycle(`state(frame, ctx) { return on(frame - 432) && ${Array.from({ length: 16 }, (_, k) => `on(frame + ${k})`).join(' && ')}; }`, 'const on = x => x >= 0;\n'), HARD],
      ['offsets-late-last', lifecycle(`state(frame, ctx) { return ${Array.from({ length: 16 }, (_, k) => `on(frame + ${k})`).join(' && ')} && on(frame - 432); }`, 'const on = x => x >= 0;\n'), HARD],
      // 八审反例：两对画面逐帧相同的镜头
      // 1 同一次调用的几个实参配成一组看。比较函数一处比帧和命名时刻、一处比像素宽度和 640，不把这处的帧配上那处的 640；真拿帧比 432 的那一组照样认。
      //   两处调用谁先谁后、比较落在派生量上、写在闭包或回调里、隔一层辅助函数传进来都一样
      ['pair-inline', lifecycle('state(frame, view) { return frame >= view.events.m01 && view.size[0] >= 640; }'), SOFT],
      ['pair-helper', lifecycle(`state(frame, view) { return ${PAIR}; }`, GE), SOFT],
      ['pair-helper-swapped', lifecycle('state(frame, view) { return ge(view.size[0], 640) && ge(frame, view.events.m01); }', GE), SOFT],
      ['pair-helper-hard', lifecycle(`state(frame, view) { return ${PAIR_HARD}; }`, GE), HARD],
      ['pair-helper-third', lifecycle(`state(frame, view) { return ${PAIR} && ge(frame, 432); }`, GE), HARD],
      ['pair-derived', lifecycle(`state(frame, view) { return ${PAIR}; }`, 'const ge = (x, min) => { const over = x - min; return over >= 0; };\n'), SOFT],
      ['pair-derived-hard', lifecycle(`state(frame, view) { return ${PAIR_HARD}; }`, 'const ge = (x, min) => { const over = x - min; return over >= 0; };\n'), HARD],
      ['pair-closure', lifecycle(`state(frame, view) { return ${PAIR}; }`, 'const ge = (x, min) => { const test = () => x >= min; return test(); };\n'), SOFT],
      ['pair-closure-hard', lifecycle(`state(frame, view) { return ${PAIR_HARD}; }`, 'const ge = (x, min) => { const test = () => x >= min; return test(); };\n'), HARD],
      ['pair-callback', lifecycle(`state(frame, view) { return ${PAIR}; }`, 'const ge = (x, min) => [0].every(() => x >= min);\n'), SOFT],
      ['pair-callback-hard', lifecycle(`state(frame, view) { return ${PAIR_HARD}; }`, 'const ge = (x, min) => [0].every(() => x >= min);\n'), HARD],
      ['pair-nested', lifecycle('state(frame, view) { return both(frame, view.events.m01, view.size[0], 640); }', `${GE}const both = (a, b, c, d) => ge(a, b) && ge(c, d);\n`), SOFT],
      ['pair-nested-hard', lifecycle('state(frame, view) { return both(frame, 432, view.size[0], 640); }', `${GE}const both = (a, b, c, d) => ge(a, b) && ge(c, d);\n`), HARD],
      ['chained-helpers', lifecycle('state(frame, view) { return first(frame); }', 'const first = x => second(x - 432);\nconst second = n => n >= 0;\n'), HARD],
      ['recursive-helper', lifecycle('state(frame, view) { return wait(frame - 432); }', 'const wait = n => (n >= 0 ? n : wait(n + 1));\n'), HARD],
      ['shared-variable', lifecycle('state(frame, view) { mark(frame); return since >= 0; }', 'let since;\nconst mark = v => { since = v - 432; };\n'), HARD],
      // 2 直接调用的辅助函数，形参叫 ctx 也照传进来的实参认：收到帧就是帧，收到像素就不是；从帧名解构改名叫 ctx、函数写出来当场调用也一样
      ['helper-n', lifecycle('state(frame, view) { return on(frame - 432); }', 'const on = n => n >= 0;\n'), HARD],
      ['helper-ctx', lifecycle('state(frame, view) { return on(frame - 432); }', 'const on = ctx => ctx >= 0;\n'), HARD],
      ['helper-ctx-function', lifecycle('state(frame, view) { return on(frame - 432); }', 'function on(ctx) { return ctx >= 0; }\n'), HARD],
      ['helper-ctx-stepped', lifecycle('state(frame, view) { return on(frame); }', 'const on = ctx => { ctx = ctx - 432; return ctx >= 0; };\n'), HARD],
      ['helper-ctx-pixels', lifecycle('state(frame, view) { return on(view.size[0]); }', 'const on = ctx => ctx >= 640;\n'), SOFT],
      ['destructured-ctx', lifecycle('state(f, view) { const { frame: ctx } = view; return ctx >= 432; }'), HARD],
      ['called-in-place', lifecycle('state(frame, view) { return (n => n >= 0)(frame - 432); }'), HARD],
      ['called-in-place-pixels', lifecycle('state(frame, view) { return (f => f >= 640)(view.size[0]); }'), SOFT],
      // 九审反例：两对画面逐帧相同的镜头
      // 1 形参的默认值只在这次调用没传实参时才用：比像素宽度的那次靠默认的 640，不配到传了命名时刻那次的帧上，两处谁先谁后都一样；
      //   真靠默认值拿帧比 432 的照样认：没传、传 undefined 或 void 0、默认值从前面的形参算出来、函数体里又赋了一次
      ['default-explicit', lifecycle(`state(frame, view) { return ${PAIR}; }`, GE_WIDE), SOFT],
      ['default-pixels', lifecycle('state(frame, view) { return ge(frame, view.events.m01) && ge(view.size[0]); }', GE_WIDE), SOFT],
      ['default-pixels-swapped', lifecycle('state(frame, view) { return ge(view.size[0]) && ge(frame, view.events.m01); }', GE_WIDE), SOFT],
      ['default-frame', lifecycle('state(frame, view) { return ge(frame); }', GE_LATE), HARD],
      ['default-frame-undefined', lifecycle('state(frame, view) { return ge(frame, undefined); }', GE_LATE), HARD],
      ['default-frame-void', lifecycle('state(frame, view) { return ge(frame, void 0); }', GE_LATE), HARD],
      ['default-frame-passed', lifecycle('state(frame, view) { return ge(frame, view.events.m01); }', GE_LATE), SOFT],
      ['default-frame-mixed', lifecycle('state(frame, view) { return ge(frame, view.events.m01) && ge(frame); }', GE_LATE), HARD],
      ['default-from-param', lifecycle('state(frame, view) { return late(frame); }', 'const late = (x, over = x - 432) => over >= 0;\n'), HARD],
      ['default-reassigned', lifecycle('state(frame, view) { return ge(frame, view.events.m01); }', 'const ge = (x, min = 640) => { min = 432; return x >= min; };\n'), HARD],
      ['default-exported', lifecycle('state(n, view) { return true; }', 'export function late(f, min = 432) { return f >= min; }\n'), HARD],
      // 2 同文件辅助函数返回的帧偏移跟着走：箭头函数直接回、function 里 return、套两层、拿返回值直接比或先赋给量，都是第 432 帧；
      //   三元、逗号、?? 包一层也一样。同一次调用的实参照旧配成一组：sub(帧, 命名时刻) 和 sub(像素宽度, 640) 不配出帧减 640
      ['return-offset', lifecycle('state(frame, view) { return on(offset(frame)); }', `${ON}const offset = n => n - 432;\n`), HARD],
      ['return-offset-function', lifecycle('state(frame, view) { return on(offset(frame)); }', `${ON}function offset(n) { const back = 432; return n - back; }\n`), HARD],
      ['return-offset-compared', lifecycle('state(frame, view) { return offset(frame) >= 0; }', 'const offset = n => n - 432;\n'), HARD],
      ['return-offset-derived', lifecycle('state(frame, view) { const local = offset(frame); return local >= 0; }', 'const offset = n => n - 432;\n'), HARD],
      ['return-nested', lifecycle('state(frame, view) { return on(sub(sub(frame, 400), 32)); }', `${ON}${SUB}`), HARD],
      ['return-sub-hard', lifecycle('state(frame, view) { return on(sub(frame, 432)); }', `${ON}${SUB}`), HARD],
      ['return-sub', lifecycle('state(frame, view) { return on(sub(frame, view.events.m01)) && on(sub(view.size[0], 640)); }', `${ON}${SUB}`), SOFT],
      ['return-sub-swapped', lifecycle('state(frame, view) { return on(sub(view.size[0], 640)) && on(sub(frame, view.events.m01)); }', `${ON}${SUB}`), SOFT],
      ['return-pixels', lifecycle('state(frame, view) { return wide(half(view.size[0])); }', 'const wide = w => w >= 640;\nconst half = w => w / 2;\n'), SOFT],
      ['return-recursive', lifecycle('state(frame, view) { return on(back(frame, 2)); }', `${ON}const back = (n, k) => (k ? back(n, k - 1) : n - 432);\n`), HARD],
      ['wrapped-conditional', lifecycle('state(frame, view) { return on(view.ready ? frame - 432 : frame - 431); }', ON), HARD],
      ['wrapped-sequence', lifecycle('state(frame, view) { return on((view.ready, frame - 432)); }', ON), HARD],
      ['wrapped-nullish', lifecycle('state(frame, view) { return on(view.since ?? frame - 432); }', ON), HARD],
      ['wrapped-half-known', lifecycle('state(frame, view) { return on(view.ready ? sub(frame, view.events.m01) : sub(frame, 432)); }', `${ON}${SUB}`), HARD],
      ['return-recursive-step', lifecycle('state(frame, view) { return on(back(frame, 2)); }', `${ON}const back = (n, k) => (k ? back(n - 216, k - 1) : n);\n`), HARD],
      ['wrapped-relative', lifecycle('state(frame, view) { return on(view.ready ? frame - view.events.m01 : view.size[0] - 640); }', ON), SOFT],
      // 柯里化的比较函数：外层那次调用的门槛和里层这次调用的量配成一组，里层形参叫 x 还是 f 都只看实参；先存成量再调用也一样
      ['curried-hard', lifecycle('state(frame, view) { return ge(432)(frame); }', 'const ge = min => x => x >= min;\n'), HARD],
      ['curried-pair', lifecycle('state(frame, view) { return ge(view.events.m01)(frame) && ge(640)(view.size[0]); }', 'const ge = min => x => x >= min;\n'), SOFT],
      ['curried-pair-f', lifecycle('state(frame, view) { return ge(view.events.m01)(frame) && ge(640)(view.size[0]); }', 'const ge = min => f => f >= min;\n'), SOFT],
      ['curried-hard-f', lifecycle('state(frame, view) { return ge(view.events.m01)(view.size[0]) && ge(432)(frame); }', 'const ge = min => f => f >= min;\n'), HARD],
      ['curried-stored', lifecycle('state(frame, view) { const late = ge(432); return late(frame); }', 'const ge = min => x => x >= min;\n'), HARD],
      ['curried-stored-pair', lifecycle('state(frame, view) { const late = ge(view.events.m01), wide = ge(640); return late(frame) && wide(view.size[0]); }', 'const ge = min => x => x >= min;\n'), SOFT],
      ['curried-shift', lifecycle('state(frame, view) { return on(shift(432)(frame)); }', `${ON}const shift = d => n => n - d;\n`), HARD],
      ['curried-shift-pair', lifecycle('state(frame, view) { return on(shift(view.events.m01)(frame)) && on(shift(640)(view.size[0])); }', `${ON}const shift = d => n => n - d;\n`), SOFT],
      ['awaited', lifecycle('async state(frame, view) { return on(await offset(frame)); }', `${ON}const offset = async n => n - 432;\n`), HARD],
      ['picked-helper', lifecycle('state(frame, view) { const test = view.ready ? late : later; return test(frame); }', 'const late = n => n >= 432;\nconst later = n => n >= 433;\n'), [2, 0.6, false]],
      // 回出去、没人在文件里调用的函数照名字认帧，文件别处有没有拿数当实参的调用都一样；柯里化的比较函数导出去也一样
      ['returned-f', 'export const make = () => f => f >= 432;\n', HARD],
      ['returned-f-beside-call', 'const pad = n => n + 1;\nexport const gap = pad(2);\nexport const make = () => f => f >= 432;\n', HARD],
      ['returned-pixels-beside-call', 'const pad = n => n + 1;\nexport const gap = pad(2);\nexport const make = () => pixels => pixels >= 640;\n', SOFT],
      ['curried-exported', 'export const ge = min => f => f >= min;\nexport const late = ge(432);\n', HARD],
      // 局部工厂回出来、局部对象里放着的比较函数只在文件里调用，形参叫 f、t 也只看实参
      ['local-factory-f', lifecycle('state(frame, view) { return ge(view.events.m01)(frame) && ge(640)(view.size[0]); }', 'function ge(min) { function test(f) { return f >= min; } return test; }\n'), SOFT],
      ['local-factory-f-hard', lifecycle('state(frame, view) { return ge(432)(frame); }', 'function ge(min) { function test(f) { return f >= min; } return test; }\n'), HARD],
      ['local-object-t', lifecycle('state(frame, view) { const tools = { wide }; return tools.wide(view.size[0]); }', 'const wide = t => t >= 640;\n'), SOFT],
      ['exported-in-array', 'export const late = f => f >= 432;\nexport const all = Object.freeze([late]);\n', HARD],
      ['exported-named-expression', 'export const late = function inner(f) { return f >= 432; };\n', HARD],
      // 交出去的回调包在三元、展开里也是交出去的，形参叫 f 不照名字认
      ['callback-picked-f', lifecycle('state(n, view) { return view.size.some(view.strict ? (f => f >= 640) : (f => f >= 320)); }'), SOFT],
      ['callback-spread-f', lifecycle('state(n, view) { return view.size.some(...[f => f >= 640]); }'), SOFT],
      // 没传的实参一路传下去还是没传：中间隔一层辅助函数、先存成 undefined 的量，里头的默认值照用
      ['default-through', lifecycle('state(frame, view) { return late(frame); }', `${GE_LATE}const late = (x, min) => ge(x, min);\n`), HARD],
      ['default-through-mixed', lifecycle('state(frame, view) { return late(frame) && late(view.size[0], 640); }', `${GE_LATE}const late = (x, min) => ge(x, min);\n`), HARD],
      ['default-through-passed', lifecycle('state(frame, view) { return late(frame, view.events.m01) && late(view.size[0], 640); }', `${GE_LATE}const late = (x, min) => ge(x, min);\n`), SOFT],
      ['default-undefined-const', lifecycle('state(frame, view) { const none = undefined; return ge(frame, none); }', GE_LATE), HARD],
      // 兜底值（??、||、??=、三元）和默认值一个口径：这次调用没传才轮到它；传了命名时刻的那次不配上像素那次的 640
      ['fallback-nullish', lifecycle('state(frame, view) { return ge(frame, view.events.m01) && ge(view.size[0]); }', 'const ge = (x, min) => x >= (min ?? 640);\n'), SOFT],
      ['fallback-nullish-hard', lifecycle('state(frame, view) { return ge(frame); }', 'const ge = (x, min) => x >= (min ?? 432);\n'), HARD],
      ['fallback-assigned', lifecycle('state(frame, view) { return ge(frame, view.events.m01) && ge(view.size[0]); }', 'const ge = (x, min) => { min = min ?? 640; return x >= min; };\n'), SOFT],
      ['fallback-assigned-hard', lifecycle('state(frame, view) { return ge(frame); }', 'const ge = (x, min) => { min = min ?? 432; return x >= min; };\n'), HARD],
      ['fallback-nullish-assign', lifecycle('state(frame, view) { return ge(frame); }', 'const ge = (x, min) => { min ??= 432; return x >= min; };\n'), HARD],
      ['fallback-or', lifecycle('state(frame, view) { return ge(frame); }', 'function ge(x, min) { var min = min || 432; return x >= min; }\n'), HARD],
      ['fallback-branch', lifecycle('state(frame, view) { return ge(frame, view.events.m01, false) && ge(view.size[0], 0, true); }', 'const ge = (x, min, px) => x >= (px ? 640 : min);\n'), SOFT],
      ['fallback-moment', lifecycle('state(frame, view) { return frame - (view.events.m02 ?? 0) >= 18; }'), SOFT],
      ['fallback-moment-branch', lifecycle('state(frame, view) { return frame - (view.ready ? view.events.m02 : 0) >= 18; }'), SOFT],
      ['fallback-total', lifecycle('state(frame, view) { const p = frame / (view.total ?? 2160); return p >= 0.5; }'), SOFT],
      // 帧回调、导出的函数在文件里另有一处调用：文件外那次调用照旧算，默认值、照名字认帧都还在；文件里的两次调用照旧各配各的
      ['hook-also-called', 'function tick(n, view, min = 432) { return n >= min; }\nexport const build = () => ({ state: tick, preview: (view) => tick(view.events.m01, view, 0) });\n', HARD],
      ['exported-also-called', lifecycle('state(frame, view) { return late(frame, view.events.m01); }', 'export function late(f, min = 432) { return f >= min; }\n'), HARD],
      ['exported-pair', lifecycle('state(frame, view) { return ge(frame, view.events.m01) && ge(view.size[0]); }', `export ${GE_WIDE}`), SOFT],
      // 三元挑出来的两个比较函数出自同一个工厂，哪个写前面都认；?? 兜底的函数、逗号包着的函数名一样认
      ['curried-picked', lifecycle('state(frame, view) { const early = ge(view.events.m01), late = ge(432); return (view.ready ? early : late)(frame); }', 'const ge = min => x => x >= min;\n'), HARD],
      ['curried-picked-swapped', lifecycle('state(frame, view) { const early = ge(view.events.m01), late = ge(432); return (view.ready ? late : early)(frame); }', 'const ge = min => x => x >= min;\n'), HARD],
      ['curried-fallback', lifecycle('state(frame, view) { return (view.test ?? ge(432))(frame); }', 'const ge = min => x => x >= min;\n'), HARD],
      ['called-sequence', lifecycle('state(frame, view) { return (0, ge)(frame, 432); }', GE), HARD],
      // 一组互相调用的函数算不完时，不相干的比较函数照旧认，写在这组函数前面还是后面都一样
      ['tangle-before', lifecycle('state(frame, view) { return ge(frame, 432); }', `${GE}${TANGLE}`), HARD],
      ['tangle-after', lifecycle('state(frame, view) { return ge(frame, 432); }', `${TANGLE}${GE}`), HARD],
      // 十审反例：三对画面逐帧相同的镜头
      // 1 展开的实参摊平了按位配：...[命名时刻] 和直接写一样是传了这一位，摊出来没有这一位（...[]、数组里的空位）才算没传。
      //   点名的数组、套一层展开、三元挑的、函数回出来的数组一样摊；中途改过的数组摊不开，照旧当没传
      ['spread-literal', lifecycle('state(frame, view) { return ge(frame, ...[view.events.m01]) && ge(view.size[0]); }', GE_WIDE), SOFT],
      ['spread-literal-swapped', lifecycle('state(frame, view) { return ge(view.size[0]) && ge(frame, ...[view.events.m01]); }', GE_WIDE), SOFT],
      ['spread-empty', lifecycle('state(frame, view) { return ge(frame, ...[]); }', GE_LATE), HARD],
      ['spread-hole', lifecycle('state(frame, view) { return ge(frame, ...[,]); }', GE_LATE), HARD],
      ['spread-whole', lifecycle('state(frame, view) { return ge(...[frame, view.events.m01]) && ge(...[view.size[0]]); }', GE_WIDE), SOFT],
      ['spread-whole-hard', lifecycle('state(frame, view) { return ge(...[frame, 432]); }', GE), HARD],
      ['spread-whole-default', lifecycle('state(frame, view) { return ge(...[frame]); }', GE_LATE), HARD],
      ['spread-nested', lifecycle('state(frame, view) { return ge(...[frame, ...[view.events.m01]]) && ge(view.size[0]); }', GE_WIDE), SOFT],
      ['spread-named', lifecycle('state(frame, view) { const args = [frame, view.events.m01]; return ge(...args) && ge(view.size[0]); }', GE_WIDE), SOFT],
      ['spread-named-hard', lifecycle('state(frame, view) { const args = [frame, 432]; return ge(...args); }', GE), HARD],
      ['spread-named-tail', lifecycle('state(frame, view) { const rest = [view.events.m01]; return ge(frame, ...rest) && ge(view.size[0]); }', GE_WIDE), SOFT],
      ['spread-picked', lifecycle('state(frame, view) { return ge(...(view.ready ? [frame, view.events.m01] : [view.size[0], 640])); }', GE), SOFT],
      ['spread-picked-hard', lifecycle('state(frame, view) { return ge(...(view.ready ? [frame, 432] : [view.size[0], 640])); }', GE), HARD],
      ['spread-returned', lifecycle('state(frame, view) { return ge(...pair(frame, view)) && ge(view.size[0]); }', `${GE_WIDE}const pair = (n, v) => [n, v.events.m01];\n`), SOFT],
      ['spread-returned-hard', lifecycle('state(frame, view) { return ge(...pair(frame)); }', `${GE}const pair = n => [n, 432];\n`), HARD],
      ['spread-pushed', lifecycle('state(frame, view) { const args = [frame]; args.push(view.events.m01); return ge(...args) && ge(view.size[0]); }', GE_WIDE), SOFT],
      // 剩余形参收到的是这次调用剩下的那几位：按下标取、解构、再展开传给下一层都照实参认
      ['rest-pair', lifecycle(`state(frame, view) { return ${PAIR}; }`, 'const ge = (...pair) => pair[0] >= pair[1];\n'), SOFT],
      ['rest-hard', lifecycle(`state(frame, view) { return ${PAIR_HARD}; }`, 'const ge = (...pair) => pair[0] >= pair[1];\n'), HARD],
      ['rest-tail-hard', lifecycle(`state(frame, view) { return ${PAIR_HARD}; }`, 'const ge = (x, ...more) => x >= more[0];\n'), HARD],
      ['rest-destructured', lifecycle(`state(frame, view) { return ${PAIR}; }`, 'const ge = (...pair) => { const [x, min] = pair; return x >= min; };\n'), SOFT],
      ['rest-destructured-hard', lifecycle(`state(frame, view) { return ${PAIR_HARD}; }`, 'const ge = (...pair) => { const [x, min] = pair; return x >= min; };\n'), HARD],
      ['rest-forwarded', lifecycle('state(frame, view) { return late(frame, view.events.m01) && late(view.size[0]); }', `${GE_WIDE}const late = (...args) => ge(...args);\n`), SOFT],
      ['rest-forwarded-hard', lifecycle('state(frame, view) { return late(frame); }', `${GE_LATE}const late = (...args) => ge(...args);\n`), HARD],
      // 2 写成语句块的函数走得到末尾、写了不带值的 return，都是回 undefined，和三元里写 undefined 一样让默认值生效；
      //   每条路都回了值（if 两支、if 后面接着 return、switch 带 default、try 两头、抛错、不带出口的死循环）就没有这一份 undefined
      ['void-ternary', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}const cue = v => (v.size[0] < 640 ? v.events.m01 : undefined);\n`), HARD],
      ['void-fallthrough', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { if (v.size[0] < 640) return v.events.m01; }\n`), HARD],
      ['void-arrow-block', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}const cue = v => { if (v.size[0] < 640) return v.events.m01; };\n`), HARD],
      ['void-bare-return', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { if (v.size[0] >= 640) return; return v.events.m01; }\n`), HARD],
      ['void-empty-body', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue() {}\n`), HARD],
      ['void-loop', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { for (const id of v.ids) if (id) return v.events[id]; }\n`), HARD],
      ['void-switch-break', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { switch (v.mode) { case 1: break; default: return v.events.m01; } }\n`), HARD],
      ['void-nullish', lifecycle('state(frame, view) { return frame >= (cue(view) ?? 432); }', 'function cue(v) { if (v.size[0] < 640) return v.events.m01; }\n'), HARD],
      ['returns-both', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { if (v.size[0] < 640) return v.events.m01; else return v.events.m02; }\n`), SOFT],
      ['returns-after-if', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { if (v.size[0] < 640) return v.events.m01; return v.events.m02; }\n`), SOFT],
      ['returns-switch', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { switch (v.mode) { case 1: return v.events.m01; default: return v.events.m02; } }\n`), SOFT],
      ['returns-try', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { try { return v.events.m01; } catch { return v.events.m02; } }\n`), SOFT],
      ['returns-throw', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { if (v.size[0] < 640) return v.events.m01; throw new Error('窄'); }\n`), SOFT],
      ['returns-forever', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { for (;;) { if (v.ready) return v.events.m01; } }\n`), SOFT],
      ['void-pixels', lifecycle('state(frame, view) { return ge(frame, view.events.m01) && ge(view.size[0], floor(view)); }', `${GE_WIDE}function floor(v) { if (v.narrow) return 320; }\n`), SOFT],
      // 3 写在文件里的对象、数组上放着的函数和数，取出来用和直接点名一样：简写属性、方法、箭头函数、套一层对象、数组下标、
      //   后来赋上去的属性、展开抄过来的对象、工厂回出来的对象、解构出来的名字都跟着走
      ['member-call', lifecycle('state(frame, view) { return on(timing.offset(frame)); }', `${ON}${OFFSET}const timing = { offset };\n`), HARD],
      ['member-call-computed', lifecycle('state(frame, view) { return on(timing[\'offset\'](frame)); }', `${ON}${OFFSET}const timing = { offset };\n`), HARD],
      ['member-call-optional', lifecycle('state(frame, view) { return on(timing?.offset(frame)); }', `${ON}${OFFSET}const timing = { offset };\n`), HARD],
      ['member-method', lifecycle('state(frame, view) { return on(timing.offset(frame)); }', `${ON}const timing = { offset(n) { return n - 432; } };\n`), HARD],
      ['member-arrow', lifecycle('state(frame, view) { return on(timing.offset(frame)); }', `${ON}const timing = { offset: n => n - 432 };\n`), HARD],
      ['member-nested', lifecycle('state(frame, view) { return on(ns.timing.offset(frame)); }', `${ON}${OFFSET}const ns = { timing: { offset } };\n`), HARD],
      ['member-array', lifecycle('state(frame, view) { return on(steps[0](frame)); }', `${ON}${OFFSET}const steps = [offset];\n`), HARD],
      ['member-assigned', lifecycle('state(frame, view) { return on(timing.offset(frame)); }', `${ON}${OFFSET}const timing = {};\ntiming.offset = offset;\n`), HARD],
      ['member-spread', lifecycle('state(frame, view) { return on(timing.offset(frame)); }', `${ON}${OFFSET}const base = { offset };\nconst timing = { ...base };\n`), HARD],
      ['member-factory', lifecycle('state(frame, view) { return on(tools().offset(frame)); }', `${ON}${OFFSET}const tools = () => ({ offset });\n`), HARD],
      ['member-factory-arg', lifecycle('state(frame, view) { return on(shift(432).offset(frame)); }', `${ON}const shift = d => ({ offset: n => n - d });\n`), HARD],
      ['member-factory-pair', lifecycle('state(frame, view) { return on(shift(view.events.m01).offset(frame)) && on(shift(640).offset(view.size[0])); }', `${ON}const shift = d => ({ offset: n => n - d });\n`), SOFT],
      ['member-destructured', lifecycle('state(frame, view) { const { offset: fn } = timing; return on(fn(frame)); }', `${ON}${OFFSET}const timing = { offset };\n`), HARD],
      ['member-destructured-array', lifecycle('state(frame, view) { const [fn] = [offset]; return on(fn(frame)); }', `${ON}${OFFSET}`), HARD],
      ['member-const', lifecycle('state(frame, view) { return frame >= cfg.min; }', 'const cfg = { min: 432 };\n'), HARD],
      ['member-const-offset', lifecycle('state(frame, view) { const since = frame - cfg.delay; return since >= 0; }', 'const cfg = { delay: 18 * 24 };\n'), HARD],
      ['member-const-destructured', lifecycle('state(frame, view) { const { min } = cfg; return frame >= min; }', 'const cfg = { min: 432 };\n'), HARD],
      ['member-const-arg', lifecycle('state(frame, view) { return ge(frame, cfg.min); }', `${GE}const cfg = { min: 432 };\n`), HARD],
      ['member-boxed', lifecycle('state(frame, view) { const box = [frame - 432]; return box[0] >= 0; }'), HARD],
      ['member-pair', lifecycle('state(frame, view) { return tools.ge(frame, view.events.m01) && tools.ge(view.size[0], 640); }', 'const tools = { ge: (x, min) => x >= min };\n'), SOFT],
      ['member-pair-hard', lifecycle('state(frame, view) { return tools.ge(frame, 432) && tools.ge(view.size[0], 640); }', 'const tools = { ge: (x, min) => x >= min };\n'), HARD],
      // 像素那一头照旧不是帧：对象里的函数只在文件里经属性调用时，形参叫 f 也只看实参；对象导出去、回出去了，文件外的人照名字调得到，照旧按名字认
      ['member-pixels', lifecycle('state(frame, view) { return on(pixel.id(view.size[0])); }', `${ON}const pixel = { id: w => w - 640 };\n`), SOFT],
      ['member-pixels-const', lifecycle('state(frame, view) { return view.size[0] >= cfg.width; }', 'const cfg = { width: 640 };\n'), SOFT],
      ['member-pixels-f', lifecycle('state(frame, view) { return helpers.check(view.size[0]); }', 'const helpers = { check(f) { return f >= 640; } };\n'), SOFT],
      ['member-relative', lifecycle('state(frame, view) { const since = frame - view.events.m02; return since >= cfg.hold; }', 'const cfg = { hold: 12 };\n'), SOFT],
      ['member-exported-f', lifecycle('state(n, view) { return true; }', 'export const api = { check(f) { return f >= 432; } };\n'), HARD],
      ['member-exported-f-called', lifecycle('state(n, view) { return api.check(view.size[0]); }', 'export const api = { check(f) { return f >= 432; } };\n'), HARD],
      ['member-returned-f-called', 'const make = () => ({ check(f) { return f >= 432; } });\nexport const build = (view) => (make().check(view.size[0]) ? make() : null);\n', HARD],
      ['member-leaked-f-called', lifecycle('state(frame, view) { return helpers.check(view.size[0]); }', 'const helpers = { check(f) { return f >= 640; } };\nexport const leak = helpers.check;\n'), HARD],
      ['member-array-pixels-f', lifecycle('state(frame, view) { return tests[0](view.size[0]); }', 'const tests = [f => f >= 640];\n'), SOFT],
      ['member-array-exported-f', lifecycle('state(frame, view) { return tests[0](view.size[0]); }', 'export const tests = [f => f >= 640];\n'), HARD],
      ['member-shadowed', lifecycle('state(frame, view) { const cfg = view.cfg; return frame >= cfg.min; }', 'const cfg = { min: 432 };\n'), SOFT],
      // 二阶的写法：数字键、模板键、套两层的解构、剩余形参接着展开；动过的数组（给下标赋值、交给别人）摊不开，照旧当没传
      ['member-numeric-key', lifecycle('state(frame, view) { return on(table[1](frame)); }', `${ON}${OFFSET}const table = { 1: offset };\n`), HARD],
      ['member-template-key', lifecycle('state(frame, view) { return on(table[`offset`](frame)); }', `${ON}${OFFSET}const table = { offset };\n`), HARD],
      ['member-destructured-nested', lifecycle('state(frame, view) { const { a: [fn] } = box; return on(fn(frame)); }', `${ON}${OFFSET}const box = { a: [offset] };\n`), HARD],
      ['rest-forwarded-tail', lifecycle('state(frame, view) { return late(frame); }', `${GE_LATE}const late = (x, ...more) => ge(x, ...more);\n`), HARD],
      ['spread-index-written', lifecycle('state(frame, view) { const args = [frame]; args[1] = view.events.m01; return ge(...args) && ge(view.size[0]); }', GE_WIDE), SOFT],
      ['spread-handed', lifecycle('state(frame, view) { const args = [frame]; view.fill(args); return ge(...args) && ge(view.size[0]); }', GE_WIDE), SOFT],
      // 拿不准走不走得到末尾的（带标号的块、有 break 的死循环、catch 里没回值、switch 没有 default）算走得到；finally 里回了值的不算
      ['void-labeled', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { out: { if (v.ready) break out; return v.events.m01; } }\n`), HARD],
      ['void-forever-break', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { while (true) { if (v.ready) break; return v.events.m01; } }\n`), HARD],
      ['void-catch', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { try { return v.events.m01; } catch { v.log(); } }\n`), HARD],
      ['void-switch-no-default', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { switch (v.mode) { case 1: return v.events.m01; } }\n`), HARD],
      ['returns-finally', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { try { v.touch(); } finally { return v.events.m01; } }\n`), SOFT],
      ['returns-forever-inner-break', lifecycle('state(frame, view) { return ge(frame, cue(view)); }', `${GE_LATE}function cue(v) { while (true) { switch (v.mode) { case 1: break; } if (v.ready) return v.events.m01; } }\n`), SOFT],
      // 绕回自己的对象、数组扫得完：展开抄自己的工厂、展开自己的数组、8 个互相引用的属性
      ['member-recursive-spread', lifecycle('state(frame, view) { return on(grow(2).offset(frame)); }', `${ON}${OFFSET}const grow = k => (k ? { ...grow(k - 1) } : { offset });\n`), HARD],
      ['spread-recursive', lifecycle('state(frame, view) { return ge(...loop()); }', `${GE}const loop = () => [...loop()];\n`), SOFT],
      ['member-tangle', lifecycle('state(frame, view) { return ge(frame, 432) && box.p0 >= 1; }', `${GE}const box = {};\n${Array.from({ length: 8 }, (_, i) => `box.p${i} = ${Array.from({ length: 8 }, (_, j) => `box.p${j}`).join(' + ')} + 1;\n`).join('')}`), HARD],
      // 递归的读词函数回 { end }、调用处解构出来接着读：循环下标不会一圈圈累加成写死的数，和回一个数的写法一个结论
      ['recursive-destructured', lifecycle('state(frame, view) { return read(view.src, 0).end > 0; }',
        'function read(src, i) { while (i < src.length) { if (src[i] === \'(\') { const { end } = read(src, i + 1); i = end; continue; } i++; } return { end: i }; }\n'), SOFT],
      ['recursive-returned', lifecycle('state(frame, view) { return read(view.src, 0) > 0; }',
        'function read(src, i) { while (i < src.length) { if (src[i] === \'(\') { i = read(src, i + 1); continue; } i++; } return i; }\n'), SOFT],
      // 解构是取数、不是又写了一处时间键：{ end: 432 } 只在写它的那一格算一处
      ['destructured-time-key', 'const read = () => ({ end: 432 });\nexport function scan() { const { end } = read(); return end; }\n', HARD],
    ]) assert.deepEqual(whole(project(name, { code: { 'shots/shot.js': code } })), want, name);
    // 从节拍常量算出来的量（beatSeconds = 60 / BPM）不是另一处定义；绕回自己的量、递归的辅助函数、一长串派生量都扫得完
    const derivedBeat = project('derived-beat', { code: { 'shots/music.js': 'const BPM = 80;\nexport const beatSeconds = 60 / BPM;\nexport const table = { tempo: BPM };\n' } });
    assert.equal(derivedBeat.timeline.beatConstantDefs, 2);
    const chained = Array.from({ length: 3000 }, (_, k) => `const v${k + 1} = v${k} + 1;`).join('\n');
    assert.deepEqual(whole(project('cycles', { code: { 'shots/shot.js': lifecycle('state(f, ctx) { let angle = 0; angle = angle + 0.01; return step(f) > angle; }',
      `const step = n => (ready(n) ? n : step(n + 1));\nlet a = 1, b = 2;\na = b + 1;\nb = a + 1;\nconst v0 = 0;\n${chained}\n`) } })), SOFT);
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

test('B3-15 30-1 按对象、数组的实际来源和导出入口判分', async (t) => {
  const { read30_1, evaluate } = await evaluator();
  const q = question('30-1'), ref = reading('30-1.reference'), dir = workdir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'film.json'), JSON.stringify({ output: { size: [ref.width, ref.height], fps: `${ref.fps}/1`, frames: ref.frames },
    timeline: { bpm: 80, beatFrames: 18 }, shots: ref.shots.map((shot) => ({ id: 's01', ...shot })), events: ref.moments }));
  const ge = 'const ge = (x, min = 432) => x >= min; ';
  const inner = `${ge}const inner = (...rest) => ge(frame, ...rest, view.events.m01); `;
  const on = 'const on = n => n >= 0; ';
  const patch = 'const timing = {}; timing.offset = n => n - 432; const alias = timing; ';
  const hard = [1, 0.6, false], soft = [0, 1, true];
  const check = (code, expected) => {
    writeFileSync(join(dir, 'shot.mjs'), code);
    const read = read30_1(dir), result = evaluate(q, { ...read, ...CLEAN, cuts: [] });
    assert.deepEqual([read.timeline.hardcodedFrames, result.score, result.pass], expected, code);
  };
  await t.test('局部函数只按调用点的实参认帧', () => {
    for (const code of [
      'const h = { width: 640, check(f) { return f >= h.width; } }; h.check(view.size[0]);',
      'const h = { check(f) { return f >= 640; } }; const { check } = h; check(view.size[0]);',
      'const make = min => ({ check: f => f >= min }); make(640).check(view.size[0]);',
      'const [check] = [f => f >= 640]; check(view.size[0]);',
    ]) check(code, soft);
  });
  await t.test('数组经别名、属性、工厂与剩余形参传递后仍按位配对', () => {
    for (const [array, call] of [
      ['const rest = [view.events.m01]; const copy = rest;', 'ge(frame, ...copy)'],
      ['const rest = [view.events.m01]; const box = { rest };', 'ge(frame, ...box.rest)'],
    ]) check(ge + array + call, soft);
    check(ge + 'const args = [frame, 432]; const copy = args; ge(...copy);', hard);
    check(ge + 'const pack = x => { const a = [x, 432]; return a; }; ge(...pack(frame));', hard);
    check(inner + 'inner(...view.extra); inner();', hard);
    check(inner + 'inner(); inner(...view.extra);', hard);
  });
  await t.test('解构只在已知槽位缺失或为 undefined 时使用常数默认值', () => {
    for (const value of ['view.events.m01', 'view.cfg.min', 'view.size[0]', '0', '5', 'null', 'undefined', 'void 0', '432']) {
      const expected = ['5', 'undefined', 'void 0', '432'].includes(value) ? hard : soft;
      check(`const { min = 432 } = { min: ${value} }; frame >= min;`, expected);
      check(`const [min = 432] = [${value}]; frame >= min;`, expected);
    }
    check('const { min = 432 } = view.cfg; frame >= min;', soft);
    check('const min = view.cfg.min ?? 432; frame >= min;', soft);
    check('const { min = 432 } = {}; frame >= min;', hard);
    check('const [min = 432] = []; frame >= min;', hard);
    check('const { min = 432 } = { ...view.cfg }; frame >= min;', soft);
    check('let min; ({ min = 432 } = { min: view.events.m01 }); frame >= min;', soft);
    check('let min; [min = 432] = []; frame >= min;', hard);
    check('const ge = (x, { min = 432 }) => x >= min; ge(frame, { min: view.events.m01 });', soft);
    check('const ge = (x, [min = 432]) => x >= min; ge(frame, []);', hard);
    check('const limit = 5; frame >= limit;', hard);
  });
  await t.test('按对象身份读取后补属性，沿导出对象找到外部可调用的函数', () => {
    check(on + patch + 'on(alias.offset(frame));', hard);
    check(on + patch + 'const copy = { ...alias }; on(copy.offset(frame));', hard);
    check(on + 'const make = () => { const o = {}; o.offset = n => n - 432; return o; }; on(make().offset(frame));', hard);
    check('const cfg = {}; const alias = cfg; alias.min = 432; frame >= cfg.min;', hard);
    for (const declaration of [
      'export const api = {}; api.check = f => f >= 432;',
      'const check = f => f >= 432; export const api = { check };',
      'const check = f => f >= 432; const api = { check }; export { api as helpers };',
      'const check = f => f >= 432; const api = { check }; export default [{ ...api }];',
    ]) for (const call of ['', 'api.check(view.size[0]);']) check(declaration + call, hard);
    check('const check = f => f >= 432; register(check); check(view.size[0]);', hard);
    check('const check = f => f >= 432; export const api = { ...{ check }, check: () => true };', soft);
    check('export const api = {}; api.check = f => f >= 432; api.check = () => true;', soft);
    check('const a = {min: 432}; const copy = {...a}; a.min = view.events.m01; frame >= copy.min;', hard);
    check('const make = () => ({}); const a = make(), b = make(); a.min = view.events.m01; b.min = 640; frame >= a.min;', soft);
    check('const make = min => ({check: f => f >= min}); export const api = make(0); make(640).check(view.size[0]);', soft);
    check('const id = x => x; export const api = id({check: f => f >= 432}); view.size.some(api.check);', hard);
    check('const check = f => f >= 640; function unused() { register(check); } Object.freeze({check}).check(view.size[0]);', soft);
    check('const absent = () => {}; const {check = f => f >= 432} = {check: absent()}; export {check};', hard);
    check('export class Cue {} Cue.prototype.check = f => f >= 432;', hard);
    check('const invoke = (fn, x) => fn(x); invoke(f => f >= 432, frame);', hard);
    check(ge + 'const rest = [view.events.m01]; const empty = x => x.pop(); empty(rest); ge(frame, ...rest);', hard);
    check(ge + 'const args = [frame, 432]; view.log(...args); ge(...args);', hard);
    check('const {min = 432} = {min: 5}; frame - min >= 0;', hard);
  });
  await t.test('自引用的调用正常出读数，同一文件的帧门槛仍能检出', async () => {
    const { scanTree } = await evaluator();
    for (const body of [
      'let x = view.pos; x = h(x.clone());', 'let x = view.text; x = h(x.trim());',
      'let x = view.pos; x = await h(x.json());', 'let x = view.pos; x = h(x.clone().add(1));',
      'let x = view.pos; while (view.more) x = h(x.next());', 'view = h(view.m());',
      'let a = view.pos, b = view.dir; a = h(b.m()); b = h(a.m());',
    ]) {
      const shot = `const h = v => v; export const build = () => ({ async state(frame, view) { ${body} return frame >= 432; } });`;
      check(shot, hard);
      check(shot.replace('432', 'view.events.m01'), soft);
      assert.deepEqual(scanTree(shot).lines, [1], body);
    }
  });
  await t.test('解析器内部异常返回不可读文件，整题不通过', (t) => {
    const load = nodeModule.createRequire(nodeModule.createRequire(import.meta.url).resolve('eslint/package.json'));
    writeFileSync(join(dir, 'shot.mjs'), 'export const late = frame => frame >= 432;');
    t.mock.method(load('espree'), 'parse', () => { throw new RangeError('测试扫描异常'); });
    const read = read30_1(dir);
    assert.deepEqual(read, { unreadable: 'shot.mjs' });
    assert.equal(evaluate(q, { ...read, ...CLEAN, cuts: [] }).pass, false);
  });
  await t.test('文件外入口、帧回调和本地调用按实参决定形参的容器默认值', () => {
    check('export const build = ({ start = 432, end = 648 } = {}) => ({ state(frame) { return frame >= start && frame < end; } });', [2, 0.6, false]);
    check('export const late = (f, { min = 432 } = {}) => f >= min;', hard);
    check('export const hook = { state(frame, { start = 432 } = {}) { return frame >= start; } };', hard);
    check('const hook = { state(frame, { start = 432 } = {}) { return frame >= start; } };', hard);
    check('export const late = (f, { min = 432 } = { min: view.events.m01 }) => f >= min;', hard);
    for (const body of ['const { min = 432 } = opts; return f >= min;', 'return f >= (opts.min ?? 432);']) {
      const mk = `const mk = (f, opts = {}) => { ${body} };`;
      check(`export ${mk}`, hard);
      for (const arg of ['', ', undefined', ', void 0', ', {}', ', ok ? { min: view.events.m01 } : undefined']) check(`${mk} mk(frame${arg});`, hard);
      check(`${mk} mk(frame, { min: view.events.m01 }); mk(view.size[0]);`, soft);
    }
  });
  await t.test('一位数存在对象或数组里也按帧名的门槛判', () => {
    check('const cfg = { fadeIn: 6 }; frame < cfg.fadeIn;', hard);
    check('const cues = [8]; frame >= cues[0];', hard);
    check('const cfg = { hold: 5 }; frame - cfg.hold >= 3;', hard);
    check('const cfg = { fadeIn: 6 }; f < cfg.fadeIn;', soft);
  });
  await t.test('数组回调按位置识别，像素比较换形参名也得同分', () => {
    for (const method of ['every', 'some', 'map', 'flatMap', 'filter', 'forEach', 'find', 'findIndex', 'findLast', 'findLastIndex', 'reduce', 'reduceRight', 'sort', 'toSorted']) {
      for (const name of ['f', 'pixels']) check(`const wide = ${name} => ${name} >= 640; view.size.${method}(wide);`, soft);
    }
    check('Array.from(view.size, f => f >= 640);', soft);
    check('const wide = f => f >= 640; Array.from(view.size, wide); register(wide);', hard);
    check('const Array = view.api; Array.from(view.size, f => f >= 640);', hard);
    check('const args = [view.events.m01, frame]; args.sort(); const ge = (x, min = 432) => x >= min; ge(frame, ...args);', hard);
  });
});

test('B3-16 语法树扫描真实仓库源码，逐文件正常返回行号和节拍计数', async (t) => {
  const { scanTree } = await evaluator();
  const files = readdirSync(HERE, { recursive: true }).filter((file) => /\.[cm]?js$/.test(file)).map((file) => join(HERE, file));
  files.push(join(ROOT, 'tools/site-qa.mjs'));
  const start = performance.now();
  for (const file of files) {
    const scan = scanTree(readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(scan?.lines) && Number.isInteger(scan.beatDefs), file);
  }
  const elapsed = performance.now() - start;
  t.diagnostic(`${files.length} 个文件，${Math.round(elapsed)} ms`);
  assert.ok(elapsed < 30000, `扫描耗时 ${elapsed} ms`);
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
