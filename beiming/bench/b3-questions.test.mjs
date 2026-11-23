// B3：二级第一批四道考题（27-1、29-2、23-2、30-1）契约校验、随机基线与行为/反例自动判分核验
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { create as createCursor } from '../cards/two-d/overlay-cursor/comp.mjs';
import { audioLoudness } from '../observe/metrics/index.mjs';
import { evaluateAssertion } from '../verify/predicates.mjs';
import { projectPublicQuestion, scanQuestionLeaks, validateQuestion } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const REFS = join(HERE, 'refs/level-2-a');
const IDS = ['27-1', '29-2', '23-2', '30-1'];
const question = (id) => JSON.parse(readFileSync(join(HERE, 'questions/level-2-a', `${id}.json`), 'utf8'));
// 分辨率无关的声画/切点算法回归项用等比缩放画幅（主用例 B3-8/10/11 保持全尺寸 1080×1080 / 1080×1350 / 1920×1080 端到端验证）
const scaledQuestion = (q, [w, h]) => ({
  ...q,
  deliverable: { ...q.deliverable, size: [w, h] },
  basePredicates: q.basePredicates.map((p) => p.replace(/width=\d+,\s*height=\d+/, `width=${w}, height=${h}`)),
});
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
// 合成画面：每过一个切点深浅翻一次，逐帧再抖 4 个码值（不算冻结，也够不上切点），小图放大到目标尺寸，
// 无损编码，打 BT.709 标签；声音的输入参数接在后面
function flipFilm(file, { size: [width, height], fps, frames, cuts }, audio) {
  const div = width >= 600 && height >= 600 && width % 30 === 0 && height % 30 === 0 ? 30 : 6;
  const w = Math.max(2, Math.floor(width / div)), h = Math.max(2, Math.floor(height / div));
  const raw = Buffer.alloc(frames * w * h);
  for (let f = 0; f < frames; f++) raw.fill((cuts.filter((cut) => cut <= f).length % 2 ? 200 : 60) + (f % 2) * 4, f * w * h, (f + 1) * w * h);
  ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0', ...audio,
    '-vf', `scale=${width}:${height}:flags=neighbor`, '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...(audio.length ? ['-c:a', 'pcm_s16le'] : []), file], raw);
}
// 固定种子的线性同余，负对照要能复现
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

test('B3-1 二级第一批 4 道考题文件存在且原文与对象均通过 B1 validateQuestion（0 错误、0 违反、0 泄露）', () => {
  for (const id of IDS) {
    const file = join(HERE, 'questions/level-2-a', `${id}.json`);
    assert.ok(existsSync(file), `缺少题目文件: ${file}`);
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    for (const verdict of [validateQuestion(raw), validateQuestion(parsed)]) {
      assert.equal(verdict.ok, true, `${id} 校验未过: ${JSON.stringify(verdict)}`);
      assert.deepEqual([verdict.schemaErrors, verdict.violations, verdict.leaks], [[], {}, []]);
    }
    const pub = projectPublicQuestion(parsed);
    assert.equal(pub.id, id);
    assert.equal(pub.level, 2);
    assert.equal('ext' in pub, false, '公开副本不带 ext');
    assert.equal(validateQuestion(pub).ok, true, `${id} 公开投影校验未过`);
  }
  assert.equal(question('30-1').ext?.['bench.code'], '外01-1');
});

test('B3-2 拍点类的题都带随机对照，29-2 写明 34%', () => {
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
    '29-2.reference.json', '30-1.hardcoded.json', '30-1.reference.json']);
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

test('B3-7 30-1（外01-1）：双固定行为样本（参考通过 1.0、写死帧号失败 0.6）、time.timeline 行为探针、绝对时间排除与随机基线全覆盖', async () => {
  const { evaluate, read30_1 } = await evaluator();
  const q = question('30-1'), ref = reading('30-1.reference'), hardcoded = reading('30-1.hardcoded');

  // 1) 双固定样本核验：参考样本 1.0 满分通过；写死帧号样本 80 BPM 落拍通过得 0.6 分，改 96 BPM 不动判不合格
  const refVerdict = evaluate(q, ref);
  assert.deepEqual([passed(refVerdict), refVerdict.score, refVerdict.basePass, refVerdict.pass], [[true, true], 1, true, true]);
  assert.deepEqual([refVerdict.items[0].detail.hits, refVerdict.items[0].detail.events, refVerdict.items[0].detail.hitRate], [17, 20, 0.85]);
  assert.equal(refVerdict.items[0].detail.randomBaseline, 3 / 18);
  assert.ok(refVerdict.items[0].detail.lift >= 0.4);
  assert.deepEqual(refVerdict.items[0].detail.offBeatIds, ['m03', 'm10', 'm20']);
  assert.deepEqual([refVerdict.items[1].detail.followed, refVerdict.items[1].detail.followedRatio, refVerdict.items[1].detail.unfollowedIds], [20, 1, []]);

  const hardVerdict = evaluate(q, hardcoded);
  assert.deepEqual([passed(hardVerdict), hardVerdict.score, hardVerdict.basePass, hardVerdict.pass], [[true, false], 0.6, true, false]);
  assert.deepEqual([hardVerdict.items[1].detail.followed, hardVerdict.items[1].detail.followedRatio, hardVerdict.items[1].detail.unfollowedIds.length], [0, 0, 20]);

  // 2) read30_1 纯行为求值：单一节拍表（经 time.timeline 换算）满分通过；绝对时间事件 title_enter（2s = 第 48 帧）固定不动不扣分
  const beatCues = [
    ['m01', 12], ['m02', 20], ['m03', 28.5], ['m04', 32], ['m05', 36],
    ['m06', 38], ['m07', 40], ['m08', 48], ['m09', 52], ['m10', 54.5],
    ['m11', 56], ['m12', 62], ['m13', 66], ['m14', 68], ['m15', 76],
    ['m16', 84], ['m17', 90], ['m18', 92], ['m19', 112], ['m20', 115.5],
  ];
  const livePositive = await read30_1({
    filmMeta: { cuts: ref.cuts, shots: ref.shots },
    resolveEvents: ({ frameAtBeat, frameAtSeconds }) => ({
      beatEvents: beatCues.map(([id, beat]) => ({ id, frame: frameAtBeat(beat) })),
      absoluteEvents: [{ id: 'title_enter', frame: frameAtSeconds(2) }, { id: 'end_card', frame: frameAtSeconds(80) }],
    }),
  });
  assert.deepEqual(livePositive.beatEvents, ref.beatEvents);
  assert.deepEqual(livePositive.probeBeatEvents, ref.probeBeatEvents);
  assert.deepEqual(livePositive.absoluteEvents, [{ id: 'title_enter', frame: 48 }, { id: 'end_card', frame: 1920 }]);
  assert.deepEqual(livePositive.probeAbsoluteEvents, [{ id: 'title_enter', frame: 48 }, { id: 'end_card', frame: 1920 }]);
  const livePass = evaluate(q, livePositive);
  assert.deepEqual([passed(livePass), livePass.score, livePass.basePass, livePass.pass], [[true, true], 1, true, true]);

  // probeBeatEvents 顺序打乱但 id->frame 映射一致，仍按事件名精确匹配满分通过
  assert.equal(evaluate(q, { ...ref, probeBeatEvents: [...ref.probeBeatEvents].reverse() }).pass, true);

  // 复用同一份可变数组缓冲（原地改写 frame）或直接传 deliverable（fps='24/1', size=[1920,1080]）时，read30_1 先快照隔离仍满分通过
  const sharedRows = beatCues.map(([id]) => ({ id, frame: 0 }));
  const reusedOut = await read30_1({
    filmMeta: q.deliverable,
    resolveEvents: ({ frameAtBeat }) => {
      sharedRows.forEach((row, idx) => { row.frame = frameAtBeat(beatCues[idx][1]); });
      return { beatEvents: sharedRows };
    },
  });
  assert.equal(evaluate(q, reusedOut).pass, true);

  // 20 个不同 id 全部挤在同一个拍点帧（216 -> 180）伪造数量：distinctFrames 退化被拦下
  const clonedSingleBeat = evaluate(q, {
    ...ref,
    beatEvents: ref.beatEvents.map(({ id }) => ({ id, frame: 216 })),
    probeBeatEvents: ref.beatEvents.map(({ id }) => ({ id, frame: 180 })),
  });
  assert.deepEqual([passed(clonedSingleBeat), clonedSingleBeat.pass], [[false, true], false]);

  // 3) read30_1 写死帧号与部分写死负对照：忽略节拍表写死帧号得 0.6 分不过；19 个跟拍、仅 m08 写死第 864 帧也不过
  const liveHardcoded = await read30_1(({ frameAtSeconds }) => ({
    beatEvents: ref.beatEvents.map((e) => ({ ...e })),
    absoluteEvents: [{ id: 'title_enter', frame: frameAtSeconds(2) }],
  }));
  const liveHardVerdict = evaluate(q, liveHardcoded);
  assert.deepEqual([passed(liveHardVerdict), liveHardVerdict.score, liveHardVerdict.pass], [[true, false], 0.6, false]);

  const partialHardcoded = await read30_1(({ frameAtBeat }) => ({
    beatEvents: beatCues.map(([id, beat]) => ({ id, frame: id === 'm08' ? 864 : frameAtBeat(beat) })),
  }));
  const partialVerdict = evaluate(q, partialHardcoded);
  assert.deepEqual([passed(partialVerdict), partialVerdict.score, partialVerdict.pass, partialVerdict.items[1].detail.unfollowedIds], [[true, false], 0.6, false, ['m08']]);

  // 把本该跟拍的事件误写成固定 48 帧并塞进 beatEvents，必须被检出；缩放方向写反或恒定平移也不过；全塞第 0 帧逃避位移也不过
  const leakedAbs = evaluate(q, {
    ...ref,
    beatEvents: [...ref.beatEvents, { id: 'extra_fixed', frame: 72 }],
    probeBeatEvents: [...ref.probeBeatEvents, { id: 'extra_fixed', frame: 72 }],
  });
  assert.deepEqual([passed(leakedAbs), leakedAbs.items[1].detail.unfollowedIds], [[true, false], ['extra_fixed']]);
  const wrongDir = evaluate(q, {
    ...ref,
    probeBeatEvents: ref.beatEvents.map(({ id, frame }) => ({ id, frame: Math.min(2159, Math.round(frame * (96 / 80))) })),
  });
  assert.deepEqual([passed(wrongDir), wrongDir.pass], [[true, false], false]);
  const allZero = evaluate(q, {
    ...ref,
    beatEvents: ref.beatEvents.map(({ id }) => ({ id, frame: 0 })),
    probeBeatEvents: ref.beatEvents.map(({ id }) => ({ id, frame: 0 })),
  });
  assert.deepEqual([passed(allZero), allZero.pass], [[false, false], false]);
  const halfZero = evaluate(q, {
    ...ref,
    beatEvents: ref.beatEvents.map(({ id }, i) => ({ id, frame: i < 11 ? 0 : (i - 10) * 18 })),
    probeBeatEvents: ref.beatEvents.map(({ id }, i) => ({ id, frame: i < 11 ? 0 : (i - 10) * 15 })),
  });
  assert.deepEqual([passed(halfZero), halfZero.pass], [[true, false], false]);

  // 4) 落拍率低于 85%（16/20 = 80%）与 200 组确定性随机帧负对照（即使等比跟随 BPM 仍因偏离拍点网格判败）
  const sixteenOnBeat = beatCues.map(([id, beat], i) => [id, i === 0 ? 12.5 : beat]);
  const lowHit = evaluate(q, await read30_1(({ frameAtBeat }) => ({
    beatEvents: sixteenOnBeat.map(([id, beat]) => ({ id, frame: frameAtBeat(beat) })),
  })));
  assert.deepEqual([passed(lowHit), lowHit.score, lowHit.pass, lowHit.items[0].detail.hitRate], [[false, true], 0.4, false, 0.8]);

  const rates = [];
  for (let seed = 1; seed <= 200; seed++) {
    const rand = lcg(seed);
    const beatEvents = Array.from({ length: 20 }, (_, i) => ({
      id: `m${String(i + 1).padStart(2, '0')}`,
      frame: 18 + Math.floor(rand() * (ref.frames - 18)),
    }));
    const probeBeatEvents = beatEvents.map(({ id, frame }) => ({ id, frame: Math.round(frame * (80 / 96)) }));
    const rv = evaluate(q, { ...ref, beatEvents, probeBeatEvents });
    assert.deepEqual([passed(rv), rv.pass], [[false, true], false], `30-1 随机帧 seed=${seed}`);
    rates.push(rv.items[0].detail.hitRate);
  }
  const mean = rates.reduce((sum, r) => sum + r, 0) / rates.length;
  assert.ok(Math.abs(mean - (3 / 18)) < 0.05, `随机帧平均命中率 ${mean} 应贴近随机基线 ${3 / 18}`);

  // 5) read30_1 异常回调与非法探针参数安全返回 unreadable，交 evaluate 判 0 分不抛错
  for (const badProbe of [
    await read30_1({}),
    await read30_1(() => { throw new Error('回调崩了'); }),
    await read30_1(() => null),
    await read30_1(() => ({ beatEvents: ref.beatEvents }), { baseBpm: 80, probeBpm: 80 }),
  ]) {
    assert.equal(typeof badProbe.unreadable, 'string');
    const badVerdict = evaluate(q, badProbe);
    assert.deepEqual([badVerdict.score, badVerdict.pass, badVerdict.basePass], [0, false, false]);
  }
});


test('B3-8 27-1 从真片读数：read27_1 用 deliverSpec、cutYdif、audioLoudness 量合成片，-14 LUFS 的满分，-8.7 LUFS 的判不合格', MEDIA, async () => {
  const { evaluate, read27_1, readFilm } = await evaluator();
  const q = question('27-1'), { cuts, shots } = reading('27-1.reference');
  const dir = workdir();
  try {
    // 单次编码全尺寸 1080×1080 视频轨，再分别无损复用不同增益声轨；先在纯音频 WAV 上标定 -20dB 基准响度
    const pic = join(dir, 'pic.mov'), probeWav = join(dir, 'probe.wav');
    flipFilm(pic, { size: [1080, 1080], fps: 30, frames: 510, cuts }, []);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=17', '-af', 'volume=-20dB', '-ac', '2', '-c:a', 'pcm_s16le', probeWav]);
    const probeLufs = (await audioLoudness(probeWav)).value;
    const film = (name, gainDb) => {
      const file = join(dir, name);
      ffmpeg(['-i', pic, '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=17',
        '-af', `volume=${gainDb}dB`, '-ac', '2', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'pcm_s16le', file]);
      return read27_1(file, { shots });
    };
    const passFile = join(dir, 'tone-14.mov');
    const measuredPass = await film('tone-14.mov', -20 + (-14) - probeLufs);
    const { loudnessLufs: _lufs, truePeakDbtp: _peak, ...seen } = measuredPass;
    assert.deepEqual(seen, { width: 1080, height: 1080, fps: 30, frames: 510, ...CLEAN, cuts, shots });
    assert.ok(Math.abs(measuredPass.loudnessLufs - (-14)) <= 0.1, `${measuredPass.loudnessLufs} LUFS`);
    // readFilm 只量成片这一头，给 30-1 这种读数从工程来的题补交付量测
    assert.deepEqual(await readFilm(passFile), { width: 1080, height: 1080, fps: 30, frames: 510, ...CLEAN, cuts });
    const passVerdict = evaluate(q, measuredPass);
    assert.deepEqual([passed(passVerdict), passVerdict.basePass, passVerdict.pass], [[true, true], true, true], '-14 LUFS');
    // 同一条片子，工程的镜头表在第 100 帧有交界：成片没在那里切，基础谓词不过
    assert.equal(evaluate(q, { ...measuredPass, shots: shotsAt([100], 510) }).basePass, false);

    // -8.7 LUFS 负对照（复用同一 1080×1080 视频轨）
    const measuredLoud = await film('tone-8.7.mov', -20 + (-8.7) - probeLufs);
    assert.ok(Math.abs(measuredLoud.loudnessLufs - (-8.7)) <= 0.1, `${measuredLoud.loudnessLufs} LUFS`);
    const loudVerdict = evaluate(q, measuredLoud);
    assert.deepEqual([passed(loudVerdict), loudVerdict.basePass, loudVerdict.pass], [[true, false], false, false], '-8.7 LUFS');
    assert.equal(evaluate(q, { ...measuredLoud, shots: shotsAt([100], 510) }).basePass, false);
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
  const tables = {
    '27-1': ['cuts'],
    '29-2': ['clicks', 'cuts', 'onsetsMs'],
    '23-2': ['chaptersMs', 'strongOnsetsMs', 'beat'],
    '30-1': ['beatEvents', 'probeBeatEvents'],
  };
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
  // 30-1：非法 BPM、空事件表、重复或空白事件名、越界或非整数帧号、两组事件名不一致、绝对时间表不同构或与跟拍表重名、非有限响度
  rejected('30-1', { ...refs['30-1'], baseBpm: 0 }, 'baseBpm 是 0');
  rejected('30-1', { ...refs['30-1'], probeBpm: -96 }, 'probeBpm 是负数');
  rejected('30-1', { ...refs['30-1'], probeBpm: 80 }, 'probeBpm 等于 baseBpm');
  rejected('30-1', { ...refs['30-1'], probeBpm: NaN }, 'probeBpm 是 NaN');
  rejected('30-1', { ...refs['30-1'], beatEvents: [], probeBeatEvents: [] }, '跟拍事件表为空');
  rejected('30-1', {
    ...refs['30-1'],
    beatEvents: [{ id: 'm01', frame: 216 }, { id: 'm01', frame: 360 }],
    probeBeatEvents: [{ id: 'm01', frame: 180 }, { id: 'm01', frame: 300 }],
  }, '重复事件名');
  rejected('30-1', {
    ...refs['30-1'],
    beatEvents: [{ id: '  ', frame: 216 }],
    probeBeatEvents: [{ id: '  ', frame: 180 }],
  }, '空白事件名');
  rejected('30-1', {
    ...refs['30-1'],
    beatEvents: [{ id: 'm01', frame: 2160 }, ...refs['30-1'].beatEvents.slice(1)],
  }, '事件帧号越过片尾');
  rejected('30-1', {
    ...refs['30-1'],
    beatEvents: [{ id: 'm01', frame: 18.5 }, ...refs['30-1'].beatEvents.slice(1)],
  }, '事件帧号是小数');
  rejected('30-1', {
    ...refs['30-1'],
    probeBeatEvents: refs['30-1'].probeBeatEvents.slice(0, 19),
  }, '缺失 probe 事件');
  rejected('30-1', {
    ...refs['30-1'],
    probeBeatEvents: [{ id: 'm99', frame: 180 }, ...refs['30-1'].probeBeatEvents.slice(1)],
  }, 'probe 事件名不一致');
  rejected('30-1', { ...refs['30-1'], probeAbsoluteEvents: undefined }, '缺失 probeAbsoluteEvents');
  rejected('30-1', {
    ...refs['30-1'],
    absoluteEvents: [{ id: 'm01', frame: 48 }],
    probeAbsoluteEvents: [{ id: 'm01', frame: 48 }],
  }, 'absoluteEvents 与 beatEvents 重名');
  rejected('30-1', { ...refs['30-1'], loudnessLufs: NaN }, '30-1 响度是 NaN');
  rejected('30-1', { ...refs['30-1'], truePeakDbtp: null }, '30-1 真峰值是 null');
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
    const audioArgs = burstTrack(join(dir, 'music.raw'), onsets, 20);
    const film = join(dir, 'clicks.mov');
    flipFilm(film, { size: [1080, 1350], fps: 30, frames: 600, cuts }, audioArgs);
    // 全尺寸 1080×1350 正对照；只看左上角一块就够认切点
    const crop = { x: 0, y: 0, width: 90, height: 90 };
    const measured = await read29_2(film, events(clicks), { crop });
    assert.deepEqual(measured, { width: 1080, height: 1350, fps: 30, frames: 600, ...CLEAN, cuts, eventsFps: '30/1', eventsFrames: 600,
      shots: shotsAt(cuts, 600), clicks, onsetsMs: onsets });
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.basePass, verdict.pass], [[true, true], 1, true, true]);
    assert.deepEqual([verdict.items[1].detail.hits, verdict.items[1].detail.events], [9, 11]);
    assert.ok(verdict.items[1].detail.randomBaseline < 0.1);
    // 事件表偏移与错误时间基准负对照（等比小画幅避免重复解码 1080×1350×600）
    const smallFilm = join(dir, 'clicks-small.mov');
    flipFilm(smallFilm, { size: [144, 180], fps: 30, frames: 600, cuts }, audioArgs);
    const sq = scaledQuestion(q, [144, 180]), smallCrop = { x: 0, y: 0, width: 36, height: 36 };
    const shifted = evaluate(sq, await read29_2(smallFilm, events(clicks.map((frame) => frame + 7)), { crop: smallCrop }));
    assert.deepEqual([passed(shifted), shifted.pass], [[false, false], false]);
    // 二审反例：同一条片子、同样的点击帧号，事件表头写的是 60 帧每秒、1200 帧。那张表的第 30 帧是 0.5 秒，不是这条片子的 1 秒，不判
    const foreign = evaluate(sq, await read29_2(smallFilm, events(clicks, { fps: '60/1', frames: 1200 }), { crop: smallCrop }));
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
    const muxAndRead = async (src, name, chapters) => {
      const meta = join(dir, `${name}.txt`), file = join(dir, `${name}.mov`);
      writeFileSync(meta, [';FFMETADATA1', ...chapters.flatMap((start, i) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`,
        `END=${chapters[i + 1] ?? 28000}`, `title=第 ${i + 1} 章`])].join('\n'));
      ffmpeg(['-i', src, '-i', meta, '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', file]);
      return read23_2(file, { shots });
    };
    const chapters = [0, 2000, 8000, 14000, 18000, 22000];
    const measured = await muxAndRead(join(dir, 'picture.mov'), 'on-beat', chapters);
    assert.deepEqual(measured, { width: 1920, height: 1080, fps: 24, frames: 672, ...CLEAN, cuts, shots, chaptersMs: chapters,
      beat: { periodMs: 500, phaseMs: 480 }, strongOnsetsMs: onsets });
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.basePass, verdict.pass], [[true, true], 1, true, true]);
    assert.deepEqual([verdict.items[1].detail.hits, verdict.items[1].detail.events], [55, 59]);
    // 第 3 章晚 83ms 负对照（等比小画幅，章节元数据校验与分辨率无关）
    const smallPic = join(dir, 'picture-small.mov');
    flipFilm(smallPic, { size: [192, 108], fps: 24, frames: 672, cuts }, audio);
    const late = evaluate(scaledQuestion(q, [192, 108]), await muxAndRead(smallPic, 'off-beat', [0, 2000, 8083, 14000, 18000, 22000]));
    assert.deepEqual([passed(late), late.pass], [[false, true], false]);
    assert.equal(Math.max(...late.items[0].detail.offBeatMs), 103);
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
  assert.ok(compared >= 40, `只比了 ${compared} 条`);
});

test('B3-15 十四审甲类回归（29-2 弱切点）：上半裁框切点 YDIF 约 19.5 时默认阈值 15 可检出全部 11 个切点', MEDIA, async () => {
  const { evaluate, read29_2 } = await evaluator();
  const q = scaledQuestion(question('29-2'), [144, 180]);
  const clicks = [45, 90, 135, 180, 240, 302, 345, 390, 450, 495, 540], cuts = clicks.map((frame) => frame + 2);
  const onsets = clicks.map((frame) => Math.round((frame * 1000) / 30));
  const events = { format: 'events/0.1', film: 'f_weak_cut', fps: '30/1', frames: 600, events: [
    ...clicks.map((frame, i) => ({ id: `click-${String(i + 1).padStart(2, '0')}`, frame, sub: 0, kind: 'named', from: 'film' })),
    ...cuts.map((frame) => ({ id: `cut.${frame}`, frame, sub: 0, kind: 'cut', from: 'film' }))] };
  // 上半画面每过切点跳变：第 304 帧（第 6 个切点）只从 180 跳到 207（TV 范围压缩后 YDIF 约 19.8 < 24），其余切点大跳；下半画面常驻不动
  const levels = [60, 200, 60, 200, 60, 180, 207, 60, 220, 70, 210, 70];
  const dir = workdir();
  try {
    const w = 36, h = 45, raw = Buffer.alloc(600 * w * h), audio = burstTrack(join(dir, 'music.raw'), onsets, 20);
    for (let f = 0; f < 600; f++) {
      const shot = cuts.filter((cut) => cut <= f).length, dither = (f % 2) * 4;
      for (let y = 0; y < h; y++) raw.fill((y < 20 ? levels[shot] : 60) + dither, (f * h + y) * w, (f * h + y + 1) * w);
    }
    const film = join(dir, 'split.mov');
    ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', '30', '-i', 'pipe:0', ...audio,
      '-vf', 'scale=144:180:flags=neighbor', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'pcm_s16le', film], raw);
    const crop = { x: 0, y: 0, width: 144, height: 80 };
    const measured = await read29_2(film, events, { crop });
    assert.deepEqual(measured.cuts, cuts);
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.pass], [[true, true], 1, true]);
    const strict = await read29_2(film, events, { crop, cutThreshold: 24 });
    assert.equal(strict.cuts.includes(304), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-16 十四审甲类回归（27-1 双栏稀释切点）：全画幅 YDIF 约 15 的硬切全检出，平滑快摇（YDIF 约 16）不误检', MEDIA, async () => {
  const { evaluate, read27_1 } = await evaluator();
  const q = scaledQuestion(question('27-1'), [144, 144]), { cuts, shots } = reading('27-1.reference');
  const dir = workdir();
  try {
    // 左半画幅在 13 个网格切点硬切（步长 36，全画幅被右半静景与 TV 范围稀释到 YDIF 约 15 < 24）；
    // 第 298..310 帧（第 10 镜内）左半平滑加速扫亮（峰值左半帧差 38、全画幅 YDIF 约 16.3），不是硬切
    const w = 36, h = 36, raw = Buffer.alloc(510 * w * h);
    const pan = [0, 4, 10, 18, 29, 43, 61, 82, 103, 121, 134, 143, 149, 152];
    let leftBase = 64;
    for (let f = 0; f < 510; f++) {
      if (cuts.includes(f)) leftBase = leftBase > 80 ? 64 : 100;
      const offset = f >= 298 && f < 336 ? (f < 298 + pan.length ? pan[f - 298] : 152) : 0;
      const left = Math.min(245, leftBase + offset) + (f % 2) * 2, right = 80 + (f % 2) * 2;
      for (let y = 0; y < h; y++) {
        raw.fill(left, (f * h + y) * w, (f * h + y) * w + 18);
        raw.fill(right, (f * h + y) * w + 18, (f * h + y + 1) * w);
      }
    }
    const file = join(dir, 'panel27.mov');
    ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', '30', '-i', 'pipe:0',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=17', '-af', 'volume=-3dB', '-ac', '2',
      '-vf', 'scale=144:144:flags=neighbor', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'pcm_s16le', file], raw);
    const measured = await read27_1(file, { shots });
    assert.deepEqual(measured.cuts, cuts);
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.pass], [[true, false], 0.6, false]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-17 十四审甲类回归（起音去重）：同一个渐起音头跨连续 3 个 10ms 窗越阈只计 1 次起音', MEDIA, async () => {
  const { read29_2 } = await evaluator();
  const clicks = [45, 90, 135, 180, 240, 300, 345, 390, 450, 495, 540], cuts = clicks.map((frame) => frame + 2);
  const startsMs = clicks.slice(0, 9).map((frame) => (frame * 100) / 3);
  const events = { format: 'events/0.1', film: 'f_ramp', fps: '30/1', frames: 600, events: [
    ...clicks.map((frame, i) => ({ id: `click-${String(i + 1).padStart(2, '0')}`, frame, sub: 0, kind: 'named', from: 'film' })),
    ...cuts.map((frame) => ({ id: `cut.${frame}`, frame, sub: 0, kind: 'cut', from: 'film' }))] };
  const dir = workdir();
  try {
    // 每个起音分 3 个连续 10ms 窗逐窗放大约 6 倍（每窗对数音量跳变约 0.78 > 0.25），第 2 窗涨幅最大
    const pcm = new Int16Array(20 * 16000);
    const amps = [250, 1800, 14000, 14000];
    for (const ms of startsMs) {
      for (let w = 0; w < amps.length; w++) {
        for (let k = 0; k < 160; k++) pcm[ms * 16 + w * 160 + k] = Math.round(amps[w] * Math.sin((Math.PI * k) / 8));
      }
    }
    const rawAudio = join(dir, 'ramp.raw'), film = join(dir, 'ramp.mov');
    writeFileSync(rawAudio, Buffer.from(pcm.buffer));
    flipFilm(film, { size: [144, 180], fps: 30, frames: 600, cuts }, ['-f', 's16le', '-ar', '16000', '-ac', '1', '-i', rawAudio]);
    const measured = await read29_2(film, events, { crop: { x: 0, y: 0, width: 36, height: 36 } });
    assert.equal(measured.onsetsMs.length, startsMs.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-18 十四审丙类回归（29-2 配乐分轨）：配乐比点击早 200ms 时混入点击音效不能把负对照骗成满分', MEDIA, async () => {
  const { evaluate, read29_2 } = await evaluator();
  const q = scaledQuestion(question('29-2'), [144, 180]);
  const clicks = [45, 90, 135, 180, 240, 300, 345, 390, 450, 495, 540], cuts = clicks.map((frame) => frame + 2);
  const earlyMusicMs = clicks.map((frame) => (frame * 100) / 3 - 200);
  const clickSfxMs = clicks.map((frame) => (frame * 100) / 3);
  const events = { format: 'events/0.1', film: 'f_mix_cheat', fps: '30/1', frames: 600, events: [
    ...clicks.map((frame, i) => ({ id: `click-${String(i + 1).padStart(2, '0')}`, frame, sub: 0, kind: 'named', from: 'film' })),
    ...cuts.map((frame) => ({ id: `cut.${frame}`, frame, sub: 0, kind: 'cut', from: 'film' }))] };
  const dir = workdir();
  try {
    const musicRaw = join(dir, 'music.raw'), musicWav = join(dir, 'music.wav'), mixedRaw = join(dir, 'mixed.raw'), film = join(dir, 'mixed.mov');
    burstTrack(musicRaw, earlyMusicMs, 20);
    ffmpeg(['-f', 's16le', '-ar', '16000', '-ac', '1', '-i', musicRaw, musicWav]);
    burstTrack(mixedRaw, [...earlyMusicMs, ...clickSfxMs].sort((a, b) => a - b), 20);
    flipFilm(film, { size: [144, 180], fps: 30, frames: 600, cuts }, ['-f', 's16le', '-ar', '16000', '-ac', '1', '-i', mixedRaw]);
    const crop = { x: 0, y: 0, width: 36, height: 36 };
    const measured = await read29_2(film, events, { crop, musicFile: musicWav });
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.pass, verdict.items[1].detail.hits], [[true, false], 0.4, false, 0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-19 十四审甲类回归（29-2 光标卡契约）：识别 overlay.cursor 生成的 tap-* 点击事件', MEDIA, async () => {
  const { evaluate, read29_2 } = await evaluator();
  const q = scaledQuestion(question('29-2'), [144, 180]);
  const clicks = [45, 90, 135, 180, 240, 300, 345, 390, 450, 495, 540], cuts = clicks.map((frame) => frame + 2);
  const onsets = clicks.slice(0, 9).map((frame) => (frame * 100) / 3);
  const cursor = createCursor({ size: [1080, 1350], shot: { in: 0, frames: 600 } }, {
    clicks: clicks.map((frame, i) => ({ id: `tap-${String(i + 1).padStart(2, '0')}`, frame, x: 0.5, y: 0.5 })),
    cutDelayFrames: 2, audio: 'click', startX: 0.2, startY: 0.2, moveFrames: 10, pressFrames: 4, rippleFrames: 12,
    sizeFrac: 0.02, rippleFrac: 0.08, ink: '#cbfb03',
  });
  const events = { format: 'events/0.1', film: 'f_tap', fps: '30/1', frames: 600, events: cursor.object.events };
  const dir = workdir();
  try {
    const film = join(dir, 'tap.mov');
    flipFilm(film, { size: [144, 180], fps: 30, frames: 600, cuts }, burstTrack(join(dir, 'music.raw'), onsets, 20));
    const measured = await read29_2(film, events, { crop: { x: 0, y: 0, width: 36, height: 36 } });
    assert.deepEqual(measured.clicks, clicks);
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.pass], [[true, true], 1, true]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-20 十四审甲类回归（29-2 刻意冻结）：read29_2 保留 film.shots 的 deliberate 声明，与正式谓词核一致', MEDIA, async () => {
  const { evaluate, read29_2 } = await evaluator();
  const q = scaledQuestion(question('29-2'), [144, 180]);
  const clicks = [45, 90, 135, 180, 240, 300, 345, 390, 450, 495, 540], cuts = clicks.map((frame) => frame + 2);
  const onsets = clicks.slice(0, 9).map((frame) => (frame * 100) / 3);
  const events = { format: 'events/0.1', film: 'f_freeze', fps: '30/1', frames: 600, events: [
    ...clicks.map((frame, i) => ({ id: `click-${String(i + 1).padStart(2, '0')}`, frame, sub: 0, kind: 'named', from: 'film' })),
    ...cuts.map((frame) => ({ id: `cut.${frame}`, frame, sub: 0, kind: 'cut', from: 'film' }))] };
  const shots = shotsAt(cuts, 600).map((shot, i) => (i === 0
    ? { id: 's01', ...shot, deliberate: [{ kind: 'freeze', in: 10, out: 35, why: '开场定格' }] }
    : { id: `s${String(i + 1).padStart(2, '0')}`, ...shot }));
  const filmDesc = { output: q.deliverable, shots };
  const dir = workdir();
  try {
    // 第 10..34 帧（25 帧 > 半秒 15 帧）完全静止，其余帧照常微抖
    const w = 36, h = 45, raw = Buffer.alloc(600 * w * h), file = join(dir, 'held.mov');
    for (let f = 0; f < 600; f++) {
      const dither = f >= 10 && f < 35 ? 0 : (f % 2) * 4;
      raw.fill((cuts.filter((cut) => cut <= f).length % 2 ? 200 : 60) + dither, f * w * h, (f + 1) * w * h);
    }
    ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', '30', '-i', 'pipe:0',
      ...burstTrack(join(dir, 'music.raw'), onsets, 20),
      '-vf', 'scale=144:180:flags=neighbor', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'pcm_s16le', file], raw);
    const crop = { x: 0, y: 0, width: 36, height: 36 };
    // 不传 film 时按未声明冻结判败；传了 film 时保留 deliberate，和正式谓词核一致判过
    const bare = evaluate(q, await read29_2(file, events, { crop }));
    assert.deepEqual([bare.score, bare.basePass, bare.pass], [1, false, false]);
    const measured = await read29_2(file, events, { crop, film: filmDesc });
    const verdict = evaluate(q, measured);
    const formal = evaluateAssertion(q.basePredicates[0], filmDesc, {
      output: { size: [measured.width, measured.height], fps: q.deliverable.fps, frames: measured.frames, colorTag: measured.colorTag },
      blackFrames: measured.blackFrames, freezes: measured.freezes, cuts: measured.cuts,
    });
    assert.equal(formal.status, 'pass');
    assert.deepEqual([verdict.score, verdict.basePass, verdict.pass], [1, true, true]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-21 十四审丙类回归（音视频 start_time 对齐）：音轨晚 0.500s 开始时补回轨道偏移后精确命中', MEDIA, async () => {
  const { evaluate, read29_2 } = await evaluator();
  const q = scaledQuestion(question('29-2'), [144, 180]);
  const clicks = [45, 90, 135, 180, 240, 300, 345, 390, 450, 495, 540], cuts = clicks.map((frame) => frame + 2);
  // 播放时刻与前 9 次点击对齐（首击第 45 帧 = 1500ms），音轨从 0.500s 起播，所以在音轨内位于 1000ms..；另放一个 19700ms 尾音（加偏移后超 20000ms 应裁掉）
  const inStreamMs = [...clicks.slice(0, 9).map((frame) => (frame * 100) / 3 - 500), 19700];
  const events = { format: 'events/0.1', film: 'f_offset', fps: '30/1', frames: 600, events: [
    ...clicks.map((frame, i) => ({ id: `click-${String(i + 1).padStart(2, '0')}`, frame, sub: 0, kind: 'named', from: 'film' })),
    ...cuts.map((frame) => ({ id: `cut.${frame}`, frame, sub: 0, kind: 'cut', from: 'film' }))] };
  const dir = workdir();
  try {
    const w = 36, h = 45, raw = Buffer.alloc(600 * w * h), rawAudio = join(dir, 'delayed.raw'), file = join(dir, 'offset.mkv');
    for (let f = 0; f < 600; f++) raw.fill((cuts.filter((cut) => cut <= f).length % 2 ? 200 : 60) + (f % 2) * 4, f * w * h, (f + 1) * w * h);
    burstTrack(rawAudio, inStreamMs, 20);
    // 用 Matroska + asetpts 显式把音轨首包 PTS 移到 0.500s，避免跨版本 FFmpeg 的 MOV editlist/itsoffset 行为差异
    ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', '30', '-i', 'pipe:0',
      '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', rawAudio,
      '-vf', 'scale=144:180:flags=neighbor', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-af', 'asetpts=PTS+0.5/TB', '-c:a', 'pcm_s16le', file], raw);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', file], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const streams = JSON.parse(probe.stdout).streams;
    const audioStart = Number(streams.find((s) => s.codec_type === 'audio')?.start_time);
    const videoStart = Number(streams.find((s) => s.codec_type === 'video')?.start_time);
    assert.equal(Math.round((audioStart - videoStart) * 1000), 500, `测试夹具应具备 500ms 音画偏移: ${probe.stdout}`);
    const measured = await read29_2(file, events, { crop: { x: 0, y: 0, width: 36, height: 36 } });
    assert.equal(measured.onsetsMs[0], 1500);
    assert.ok(measured.onsetsMs.every((ms) => ms >= 0 && ms < 20000));
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.pass], [[true, true], 1, true]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-22 十四审丙类回归（23-2 拍长抖动与一帧容差）：±10ms 交替抖动仍估出 500ms 拍长，41.600ms 章节偏差不被取整误扣', MEDIA, async () => {
  const { evaluate, read23_2 } = await evaluator();
  const q = scaledQuestion(question('23-2'), [192, 108]);
  // 55 个强起音在 480 + 500k 毫秒网格上交替提前、延后 10ms（相邻间隔全是 520ms 和 480ms，没有一个 500ms）
  const onsets = Array.from({ length: 55 }, (_, k) => 480 + 500 * k + (k % 2 ? 10 : -10));
  const cuts = [48, 192, 336, 432, 528], shots = shotsAt(cuts, 672);
  const dir = workdir();
  try {
    const audio = burstTrack(join(dir, 'jitter.raw'), onsets, 28);
    flipFilm(join(dir, 'base.mov'), { size: [192, 108], fps: 24, frames: 672, cuts }, audio);
    const mux = async (name, startsUs) => {
      const meta = join(dir, `${name}.txt`), file = join(dir, `${name}.mkv`);
      writeFileSync(meta, [';FFMETADATA1', ...startsUs.flatMap((start, i) => ['[CHAPTER]', 'TIMEBASE=1/1000000',
        `START=${start}`, `END=${startsUs[i + 1] ?? 28000000}`, `title=第 ${i + 1} 章`])].join('\n'));
      ffmpeg(['-i', join(dir, 'base.mov'), '-i', meta, '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', file]);
      return read23_2(file, { shots });
    };
    // 第 3 章起点 8021.600ms 离拍点 7980ms 差 41.600ms < 1000/24 = 41.667ms，应满分通过
    const within = await mux('within', [0, 2000000, 8021600, 14000000, 18000000, 22000000]);
    assert.deepEqual(within.beat, { periodMs: 500, phaseMs: 480 });
    assert.equal(within.chaptersMs[2], 8021.6);
    const ok = evaluate(q, within);
    assert.deepEqual([passed(ok), ok.score, ok.basePass, ok.pass], [[true, true], 1, true, true]);
    // 差到 42.000ms（8022ms）则超过 24fps 一帧，章节项不通过
    const over = evaluate(q, await mux('over', [0, 2000000, 8022000, 14000000, 18000000, 22000000]));
    assert.deepEqual([passed(over), over.pass], [[false, true], false]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B3-23 十五审甲类回归（27-1 镜头内平滑快摇与孤立弱硬切）：YDIF>16 且 scd>3% 的连续快摇不误报切点，13 个弱硬切全检出并满分通过', MEDIA, async () => {
  const { evaluate, read27_1 } = await evaluator();
  const q = scaledQuestion(question('27-1'), [144, 144]), { cuts, shots } = reading('27-1.reference');
  const dir = workdir();
  try {
    // 13 个网格切点为孤立弱硬切（全画幅 YDIF 约 15..17，孤立尖峰）；
    // 第 306..312 帧（第 10 镜内）模拟左栏平滑快摇：第 307 帧 YDIF=18 > 16 且 scdet=3.81% > 3%，随后 308..312 帧持续高 YDIF（14.75..20.5），无孤立尖峰
    const w = 36, h = 36, raw = Buffer.alloc(510 * w * h);
    const panSteps = new Map([[306, 36], [307, 46], [308, 48], [309, 46], [310, 44], [311, 42], [312, 24]]);
    let leftBase = 64, panPhase = 0;
    for (let f = 0; f < 510; f++) {
      if (cuts.includes(f)) leftBase = leftBase > 80 ? 64 : 100;
      const step = panSteps.get(f) ?? 0;
      if (step) panPhase ^= 1;
      const dither = (f % 2) * 2, right = 80 + dither;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < 18; x++) {
          raw[(f * h + y) * w + x] = leftBase + (((x + y) & 1) === panPhase ? step : 0) + dither;
        }
        raw.fill(right, (f * h + y) * w + 18, (f * h + y + 1) * w);
      }
    }
    const file = join(dir, 'fastpan27.mov');
    ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', '30', '-i', 'pipe:0',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=17', '-af', 'volume=7.1dB', '-ac', '2',
      '-vf', 'scale=144:144:flags=neighbor', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'pcm_s16le', file], raw);
    const measured = await read27_1(file, { shots });
    assert.deepEqual(measured.cuts, cuts);
    const verdict = evaluate(q, measured);
    assert.deepEqual([passed(verdict), verdict.score, verdict.basePass, verdict.pass], [[true, true], 1, true, true]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});