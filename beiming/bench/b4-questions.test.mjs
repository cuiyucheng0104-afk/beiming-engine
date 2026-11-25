// B4：二级第二批 4 道考题（5-1[05-1]、18-1、18-2、15-2）契约校验与参考片/反例自动判分核验
// 参考读数夹具里只有数，没有原片媒体：包络、彩色帧、灰度帧都在这里照读数现造，再交给 observe 的真实实现去量。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectPublicQuestion, scanQuestionLeaks, validateQuestion } from './index.mjs';
import { denseFinite, median, readBaseShare, readCameraStatic, readHits, readLock, readMoveStarts, readMusicAlign, readSubtitleLag, score } from './questions/level-2-b/evaluate-b4.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUESTIONS = join(HERE, 'questions/level-2-b');
const REFS = join(HERE, 'refs/level-2-b');
const IDS = ['5-1', '18-1', '18-2', '15-2'];
const CLEAN = { ok: true, schemaErrors: [], violations: {}, leaks: [] };
const question = (id) => JSON.parse(readFileSync(join(QUESTIONS, `${id}.json`), 'utf8'));
const reference = (id) => JSON.parse(readFileSync(join(REFS, `${id}.json`), 'utf8'));
const argsOf = (q, metric, pick = () => true) => q.scoring.find((item) => item.metric === metric && pick(item.args)).args;
const full = (verdict) => verdict.pass && Math.abs(verdict.score - 1) < 1e-9;
const failed = (verdict) => verdict.items.filter((item) => !item.pass).map((item) => item.metric);
// 同一个指标有几条线的题（18-1）按 scoring 里的下标认是哪一条没过
const failedAt = (verdict) => verdict.items.flatMap((item, index) => (item.pass ? [] : [index]));
// 一审抓到的坏数组：空洞、null、NaN、字符串、空洞和附加属性正好抵掉个数
const holed = (values, at) => { const list = [...values]; delete list[at]; return Object.assign(list, { note: 1 }); };

/* ---------------- 专名扫描 ---------------- */

// 案例 05、15、18 的专名（片名、角色、人名、地名、党派、媒体）和发布平台名只以小写词元的 SHA-256 前 24 位存在这里，明文不进仓库。
// 「哨兵」两个不是专名：是给 B4-10 验扫描器用的假词元，测试里现拼出来，源码里不连着写。
const NOUN_HASHES = {
  '05': ['ecc9bddb65dc44516ca3eae9'],
  '15': ['566f0e77c60c808d3df7b1a1', '63d3b43e6d435d22e0b7cc21', '7633807107cbdcc4174f1af1', 'b05a020b94ff9f43c3b65c5a', 'def3735d7a0d2696775d6d72'],
  '18': [
    '076cf05c96c8c20b60923f38', '089604bb0ff1ecd14b7ea9c7', '12cea0154ec4197be1086abf', '1afa6288d29572719515162a', '234330834c41105ad5ed794f',
    '4525c311a99de9a61848525d', '49acc9cf1abc2ba8d84ed6a8', '49dc32d144254d01d8552785', '4aa08612a8f6e9e429c9a460', '4af48d7c76b521e9d80c5230',
    '4b42194596899bcdf9c34975', '4d4cae7427a8d6cd86e571d0', '557e4489db5fb3fbe2ad822a', '5612606d4255b7f815565530', '5873102fa0951713a8115478',
    '58ed3bdb0c701c24d6bb0aad', '61e81a50ea9de3c9a48c95d6', '7781113a99f177280ad3e89b', '783ef849d8a6ffe64e7dd712', '7921767e6c66d880c2ab8e6f',
    '85ef3bae7236215b8c5f4dfe', '91826add52a73308c02e18e9', '965b8a7ec41772241a9bc0d8', '9fdc4c03d5273e3f2c9c83e7', 'a60a52382d7077712def2a69',
    'aad226149fbe8747517aeb8b', 'ae116ddc05ab23967947b990', 'b20a63a37c1698c7fb2174f8', 'b8a8419e2236fc7ae0da5ecd', 'c34305e7b35f6f0bdf4eaacb',
    'c383a4673531ee25f43f19e0', 'c4a1e6f3639a098e68060c2a', 'c512ca0c5c1e71be19f33568', 'c880901c00eae55922076e75', 'd00622926850b0b5bcaa0970',
    'd28f8c2373c679cc67da209e', 'd85e7e209322f1bfa433f876', 'e39d09a79f5f5dd87b8865ce', 'ebc53c4358ac0cbc5b1ed738', 'efe335d482607688ab22b4af',
    'f9070e8db0018ad670e837ed', 'f98407019f8c4af6fbb6c9dd', 'fce1063da40b94ca30598bc9',
  ],
  '平台': ['50b2676afbe30c833f43fedf'],
  '哨兵': ['7f0fc5db48e25e28bae3470a', 'c89664987661b0dc3c75a2ca'],
};
const NOUN_GROUP = new Map(Object.entries(NOUN_HASHES).flatMap(([group, hashes]) => hashes.map((hash) => [hash, group])));
const tokenHash = (token) => createHash('sha256').update(token).digest('hex').slice(0, 24);
// 分词后逐个比哈希，回 [{ line, group }]（不回词元本身，日志里不印专名）。先做 NFKC、去零宽字符，和 B1 的泄露扫描一个口径；
// 字母按词切并转小写，驼峰、数字、下划线、连字符都断词（按词比，不按子串比：三个字母的台名会撞进普通单词里）；汉字连续段取每个 2 到 4 字的片段。
function scanProperNouns(text) {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '').split('\n').flatMap((line, index) => {
    const tokens = (line.match(/\p{Script=Han}+|\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})/gu) ?? []).flatMap((run) => (/\p{Script=Han}/u.test(run)
      ? [2, 3, 4].flatMap((size) => Array.from({ length: Math.max(0, run.length - size + 1) }, (_, i) => run.slice(i, i + size)))
      : [run.toLowerCase()]));
    return [...new Set(tokens)].flatMap((token) => (NOUN_GROUP.has(tokenHash(token)) ? [{ line: index + 1, group: NOUN_GROUP.get(tokenHash(token)) }] : []));
  });
}

/* ---------------- 照读数造信号 ---------------- */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 配乐的包络是平滑的随机起伏加每半秒一下重音；成片的包络是它平移、拉伸之后叠上不相关的声音（noise 越大相关越低）
function envelopes({ stretch, offsetSec, trackSec, stepSec }, { fps, frames }, { noise = 0.333, trackSeed = 5 } = {}) {
  const rand = rng(5), other = rng(trackSeed);
  const m = Math.round(trackSec / stepSec), n = Math.round(frames / fps / stepSec);
  const raw = Array.from({ length: m + 4 }, () => rand());
  const mixed = Array.from({ length: m + 4 }, () => other());
  const smooth = (source) => Array.from({ length: m }, (_, k) => (source[k] + source[k + 1] + source[k + 2] + source[k + 3] + source[k + 4]) / 5 + (k % 25 === 0 ? 0.5 : 0));
  const trackEnvelope = smooth(raw), played = smooth(trackSeed === 5 ? raw : mixed);
  const filmEnvelope = Array.from({ length: n }, (_, i) => {
    const k = (i - offsetSec / stepSec) / stretch, k0 = Math.floor(k);
    return (k0 >= 0 && k0 + 1 < m ? played[k0] + (played[k0 + 1] - played[k0]) * (k - k0) : 0.5) + noise * (rand() - 0.5);
  });
  return { filmEnvelope, trackEnvelope, fps };
}

// 一张 100×10 的彩色帧：各主色按占比铺像素，剩下的铺一个不在底色格里的深色
function paletteFrame(colors) {
  const width = 100, height = 10, rgba = new Uint8Array(width * height * 4).fill(255);
  let at = 0;
  const paint = (hex, pixels) => {
    for (let i = 0; i < pixels; i++, at++) [1, 3, 5].forEach((from, c) => { rgba[at * 4 + c] = parseInt(hex.slice(from, from + 2), 16); });
  };
  for (const [hex, share] of colors) paint(hex, Math.round(share * width * height));
  paint('#101010', width * height - at);
  return { width, height, rgba };
}

// 连续的纹理（两层格点噪声），可以在任意坐标上取值：平移、缩放之后的帧直接照变换去取
function texture(x, y) {
  const lattice = (ix, iy) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const layer = (u, v) => {
    const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
    const top = lattice(iu, iv) + (lattice(iu + 1, iv) - lattice(iu, iv)) * fu;
    const bottom = lattice(iu, iv + 1) + (lattice(iu + 1, iv + 1) - lattice(iu, iv + 1)) * fu;
    return top + (bottom - top) * fv;
  };
  return 0.7 * layer(x / 9, y / 9) + 0.3 * layer(x / 3, y / 3);
}

// 和 motionZoomPan 一个变换模型：以帧中心为原点缩放 scale，再平移 (dx, dy)；noise 是叠上去的均匀噪声的全幅
function grayFrame(width, height, { scale = 1, dx = 0, dy = 0, noise = 0, seed = 1 } = {}) {
  const cx = (width - 1) / 2, cy = (height - 1) / 2, rand = rng(seed), gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = 30 + 195 * texture((x - cx - dx) / scale + cx, (y - cy - dy) / scale + cy) + noise * (rand() - 0.5);
    gray[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
  }
  return gray;
}

/* ---------------- 题目文件 ---------------- */

test('B4-1 二级第二批 4 道考题文件存在且原文与对象均通过 B1 validateQuestion（0 错误、0 违反、0 泄露）', () => {
  for (const id of IDS) {
    const file = join(HERE, 'questions/level-2-b', `${id}.json`);
    assert.ok(existsSync(file), `缺少题目文件: ${file}`);
    const raw = readFileSync(file, 'utf8');
    const verdict = validateQuestion(raw);
    assert.equal(verdict.ok, true, `${id} 校验未过: ${JSON.stringify(verdict)}`);
    assert.deepEqual(verdict, CLEAN, `${id} 原文`);
    assert.deepEqual(validateQuestion(JSON.parse(raw)), CLEAN, `${id} 对象`);
    const pub = projectPublicQuestion(JSON.parse(raw));
    assert.equal(pub.id, id);
    assert.equal(pub.level, 2);
    assert.equal('ext' in pub, false, `${id} 的公开投影不带私有的 ext`);
    assert.deepEqual(pub.scoring, JSON.parse(raw).scoring, `${id} 是公开题，判分细则照回`);
  }
});

test('B4-2 题号、代号、参考夹具、要用的卡和随机对照照 05 第 6.3 节', () => {
  assert.deepEqual(question('5-1').ext, { 'bench.code': '05-1' });
  const needs = { '5-1': ['audio.align'], '18-1': ['time.narration', 'overlay.subs', 'page.det2d'], '18-2': ['camera.cue-kf', 'time.narration'], '15-2': ['camera.drift'] };
  for (const id of IDS) {
    const q = question(id);
    assert.deepEqual(q.needs, needs[id], id);
    assert.deepEqual(q.refs, [`bench/refs/level-2-b/${id}.json`], id);
    assert.equal(reference(id).question, id);
    assert.equal(q.flags.hidden, false);
    assert.equal(q.calibration.status, 'calibrated');
    assert.equal(q.calibration.version, 1);
    assert.ok(typeof q.calibration.noiseFloor === 'number' && Number.isFinite(q.calibration.noiseFloor) && q.calibration.noiseFloor >= 0);
  }
  // 对位题必须带随机对照；15-2 考的是机位锁死，没有可对的事件
  for (const id of ['5-1', '18-1', '18-2']) assert.ok(question(id).controls.random, `${id} 缺随机对照`);
  assert.equal(question('15-2').controls.random, undefined);
});

test('B4-3 题目、夹具、核验器和本测试文件全部零泄露、零专名', () => {
  const files = [...readdirSync(QUESTIONS).map((name) => join(QUESTIONS, name)), ...readdirSync(REFS).map((name) => join(REFS, name)), fileURLToPath(import.meta.url)];
  assert.equal(files.length, 10, '4 道题、1 个核验器、4 份夹具、1 个测试');
  for (const file of files) {
    assert.deepEqual(scanQuestionLeaks(readFileSync(file, 'utf8')), [], file);
    assert.deepEqual(scanProperNouns(readFileSync(file, 'utf8')), [], `${file} 里有案例专名`);
  }
});

/* ---------------- 5-1 ---------------- */

test('B4-4 5-1：案例 05 的读数满分；拉伸超 3%、不相关的配乐、重击偏离硬切判不过', () => {
  const q = question('5-1'), ref = reference('5-1');
  const alignArgs = argsOf(q, 'music.align'), hitArgs = argsOf(q, 'beat.onset-hit');
  assert.ok(q.basePredicates.includes(`cut_at(${ref.hardCutFrame})`), '硬切事件是基础谓词');
  assert.equal(ref.frames, q.deliverable.frames);
  assert.deepEqual(hitArgs.eventFrames, [ref.hardCutFrame]);
  const span = [0, ref.frames];
  const music = (over, synth) => readMusicAlign(envelopes({ ...ref.musicAlign, ...over }, ref, synth), alignArgs);
  // 判分吃的是原始读数：硬切帧号、重击峰帧号、成片帧范围；偏差、命中率、随机基线由判分线重算
  const hit = (peaks, cuts = [ref.hardCutFrame], range = span) => ({ eventFrames: cuts, markFrames: peaks, range });
  const stats = (peaks) => readHits([ref.hardCutFrame], peaks, span, hitArgs.tolFrames);
  const judge = (align, onset) => score(q, { 'music.align': align, 'beat.onset-hit': onset });

  const refAlign = music(), refHit = hit(ref.lowBand.peakFrames);
  assert.equal(refAlign.stretch, ref.musicAlign.stretch, '真实求解器量回拉伸比 1.009');
  assert.ok(Math.abs(refAlign.corr - ref.musicAlign.corr) <= 0.01, `相关 ${refAlign.corr} 应在 0.836 上下`);
  assert.equal(refAlign.offsetSec, ref.musicAlign.offsetSec);
  assert.deepEqual(stats(ref.lowBand.peakFrames), { offsetsFrames: [1], hitRate: 1, randomRate: 87 / 720 });
  assert.match(q.controls.random, /87\/720/);
  assert.ok(full(judge(refAlign, refHit)), '案例 05 的读数满分');

  const stretched = music({ stretch: 1.05 });
  assert.equal(stretched.stretch, 1.05, '超限的拉伸量得出来');
  assert.ok(stretched.corr >= alignArgs.minCorr);
  assert.deepEqual(failed(judge(stretched, refHit)), ['music.align']);
  assert.equal(judge(stretched, refHit).score, 0.5);
  const unrelated = music({}, { trackSeed: 77 });
  assert.ok(unrelated.corr < alignArgs.minCorr, `不相关的配乐相关 ${unrelated.corr}`);
  assert.deepEqual(failed(judge(unrelated, refHit)), ['music.align']);

  // 整条配乐晚 4 帧：最近的峰离硬切 3 帧
  const latePeaks = ref.lowBand.peakFrames.map((frame) => frame + 4);
  assert.deepEqual(stats(latePeaks).offsetsFrames, [3]);
  assert.deepEqual(failed(judge(refAlign, hit(latePeaks))), ['beat.onset-hit']);
  // 边界：正好 2 帧过，3 帧不过
  assert.ok(full(judge(refAlign, hit([626]))));
  assert.deepEqual(failed(judge(refAlign, hit([627]))), ['beat.onset-hit']);
  // 每 4 帧一个峰（第 1、5、…、717 帧）：硬切怎么放都命中，随机基线 100%，不算对上
  const dense = Array.from({ length: 180 }, (_, i) => 1 + i * 4);
  assert.equal(stats(dense).hitRate, 1);
  assert.equal(stats(dense).randomRate, 1);
  assert.deepEqual(failed(judge(refAlign, hit(dense))), ['beat.onset-hit']);
  // 随机基线的分母是题目的 720 帧，不是读数自报的范围：把范围报成 [0, 1440) 基线就摊成 50%，不认
  assert.equal(readHits([ref.hardCutFrame], dense, [0, 2 * ref.frames], hitArgs.tolFrames).randomRate, 0.5);
  assert.deepEqual(failed(judge(refAlign, hit(dense, undefined, [0, 2 * ref.frames]))), ['beat.onset-hit'], '范围翻倍摊薄基线');
  assert.deepEqual(failed(judge(refAlign, { eventFrames: [ref.hardCutFrame], markFrames: dense })), ['beat.onset-hit'], '不报范围，基线照 720 帧算还是 100%');
  // 读数可以不报范围；报了就必须正好是题目的 [0, 720)
  assert.ok(full(judge(refAlign, { eventFrames: [ref.hardCutFrame], markFrames: ref.lowBand.peakFrames })), '不报范围');
  assert.ok(full(judge(refAlign, hit([623, 719]))), '峰在成片最后一帧');
  assert.match(q.scoring[1].pass, /都要落在成片的 720 帧里/);

  // 硬切表和重击峰表都得非空、密实、是有限数；只交汇总数不认
  const broken = {
    '没有重击峰': hit([]),
    '没有硬切': hit(ref.lowBand.peakFrames, []),
    '没有硬切，峰在第 0 帧': hit([0], []),
    '硬切是 null': hit([0], [null]),
    '峰是 null': hit([null]),
    '峰表有空洞': hit(Array(18)),
    '峰表空洞和附加属性抵掉个数': hit(holed(ref.lowBand.peakFrames, 3)),
    '峰表不递增': hit([626, 623]),
    '多报一次硬切': hit(ref.lowBand.peakFrames, [623, 624]),
    '硬切不在成片里': hit([10000], [10000]),
    '量到的硬切不是题面的第 624 帧': hit([100], [100]),
    '帧范围倒着': hit(ref.lowBand.peakFrames, [ref.hardCutFrame], [720, 0]),
    '帧范围不是整数': hit(ref.lowBand.peakFrames, [ref.hardCutFrame], [0, 720.5]),
    '帧范围缺一头': hit(ref.lowBand.peakFrames, [ref.hardCutFrame], [0]),
    '帧范围翻倍': hit(ref.lowBand.peakFrames, [ref.hardCutFrame], [0, 1440]),
    '帧范围少一帧': hit(ref.lowBand.peakFrames, [ref.hardCutFrame], [0, 719]),
    '帧范围不从第 0 帧起': hit(ref.lowBand.peakFrames, [ref.hardCutFrame], [1, 720]),
    '帧范围往片头前伸': hit(ref.lowBand.peakFrames, [ref.hardCutFrame], [-720, 720]),
    '帧范围多一项': hit(ref.lowBand.peakFrames, [ref.hardCutFrame], [0, 720, 1440]),
    '帧范围是 null': hit(ref.lowBand.peakFrames, [ref.hardCutFrame], null),
    '有个峰在片尾之外（第 720 帧）': hit([623, 720]),
    '有个峰在片头之前': hit([-1, 623]),
    '只交汇总': { offsetsFrames: [0], hitRate: 1, randomRate: 0 },
  };
  for (const [what, onset] of Object.entries(broken)) assert.deepEqual(failed(judge(refAlign, onset)), ['beat.onset-hit'], what);

  // 判分线的边界
  const line = (corr, stretch) => failed(judge({ corr, stretch }, refHit));
  assert.deepEqual(line(0.5, 0.97), []);
  assert.deepEqual(line(0.5, 1.03), []);
  assert.deepEqual(line(0.499, 1), ['music.align'], '相关低于 0.5 不判，不算过');
  assert.deepEqual(line(0.9, 1.031), ['music.align']);
  assert.deepEqual(line(0.9, 0.969), ['music.align']);
  assert.deepEqual(line(null, 1), ['music.align']);
  assert.deepEqual(line(0.9, null), ['music.align']);
  assert.deepEqual(line('0.9', 1), ['music.align'], '字符串不是数');
  assert.deepEqual(line(1.5, 1), ['music.align'], '相关不会超过 1');
});

/* ---------------- 18-1 ---------------- */

test('B4-5 18-1：案例 18 的读数满分；字幕滞后、不淡出、不留白、底色占比超界、场景没量全判不过', () => {
  const q = question('18-1'), ref = reference('18-1');
  const [LAG, FADE, PAUSE, PALETTE] = [0, 1, 2, 3];
  assert.deepEqual(q.scoring.map(({ metric, args }) => [metric, Object.keys(args)[0]]),
    [['narration.timing', 'maxSubtitleLagSec'], ['narration.timing', 'fadeFrames'], ['narration.timing', 'minLeadSec'], ['color.palette', 'color']]);
  const lagArgs = q.scoring[LAG].args, pauseArgs = q.scoring[PAUSE].args, paletteArgs = q.scoring[PALETTE].args;
  for (const index of [FADE, PAUSE, PALETTE]) assert.equal(q.scoring[index].args.minScenes, 3, '题面要至少三个场景');
  // 两个时长：题目的成片 900 帧（30 秒），正式判分 score(q, r) 只认它；参考片 5375 帧（题目 args.refFrames 照夹具写明）只在核验夹具时由第三个参数 REF 打开
  const span = ref.frames / ref.fps, own = q.deliverable.frames / ref.fps;
  assert.equal(q.deliverable.fps, `${ref.fps}/1`);
  assert.equal(own, 30);
  assert.deepEqual(lagArgs.refFrames, [0, ref.frames]);
  assert.match(q.scoring[LAG].pass, /自报的时长/);
  const stats = (appear = ref.subtitleAppearSec, onsets = ref.narrationOnsetsSec) => readSubtitleLag(appear, onsets, span, lagArgs.maxSubtitleLagSec);
  const shares = (frames) => readBaseShare(frames.map(({ colors }) => paletteFrame(colors)), paletteArgs);
  // 判分吃的是原始读数：字幕与起声的时刻、各边界的淡出帧数、各场景的首尾留白、各场景的底色占比
  const refTiming = { appearSec: ref.subtitleAppearSec, onsetsSec: ref.narrationOnsetsSec, spanSec: span,
    fadeFrames: ref.sceneFadeFrames, leadSec: ref.scenePauses.leadSec, tailSec: ref.scenePauses.tailSec };
  const refShares = shares(ref.palette.sceneFrames);
  const REF = { allowReferenceSpan: true };
  const judge = (timing = {}, palette = refShares) => score(q, { 'narration.timing': { ...refTiming, ...timing }, 'color.palette': palette }, REF);

  const refLag = stats();
  assert.ok(Math.abs(refLag.subtitleLagSec - ref.subtitleLag.medianSec) <= 0.01, `中位数 ${refLag.subtitleLagSec} 和原量测的 0.013 秒差在取整的一格内`);
  assert.equal(Math.round(refLag.hitRate * ref.subtitleLag.blocks), ref.subtitleLag.matchedWithin04Sec, '47 块里对上 44 块');
  assert.equal(Math.round(refLag.randomRate * 100), 4);
  assert.match(q.controls.random, /约 4%/);
  assert.equal(median(ref.sceneFadeFrames), 3);
  assert.equal(ref.scenePauses.leadSec.length, ref.sceneFadeFrames.length + 1, '10 个场景、9 处场景之间的边界');
  assert.equal(ref.scenePauses.tailSec.length, ref.scenePauses.leadSec.length);
  assert.equal(ref.scenePauses.leadSec[0], ref.narrationOnsetsSec[0], '第一场的开头留白就是第一次起声');
  assert.ok(Math.abs(median(ref.scenePauses.leadSec) - 0.46) < 1e-9 && Math.abs(median(ref.scenePauses.tailSec) - 0.47) < 1e-9);
  assert.match(q.controls.referencePass, /0\.46 秒.*0\.47 秒/);
  assert.deepEqual(refShares, { shares: [0.846, 0.792, 0.752] });
  assert.ok(full(judge()), '案例 18 的读数满分');
  assert.ok(full(judge({ spanSec: undefined })), '打开了参考片时长，读数可以不报时长');
  // 不打开就是正式判分：参考片的时刻装不进题目的 30 秒，字幕这条不过；开关只认调用方传的 true，读数里自带的不算
  const refReadings = { 'narration.timing': refTiming, 'color.palette': refShares };
  for (const opts of [undefined, null, {}, { allowReferenceSpan: false }, { allowReferenceSpan: 'true' }, { allowReferenceSpan: 1 }]) {
    assert.deepEqual(failedAt(score(q, refReadings, opts)), [LAG], `第三个参数 ${JSON.stringify(opts)}`);
  }
  assert.deepEqual(failedAt(score(q, { ...refReadings, 'narration.timing': { ...refTiming, allowReferenceSpan: true } })), [LAG], '读数自己带开关不算');

  // 字幕整体滞后 0.2 秒（6 帧）
  const late = ref.subtitleAppearSec.map((at) => at + 0.2);
  assert.ok(stats(late).subtitleLagSec > 0.19);
  assert.deepEqual(failedAt(judge({ appearSec: late })), [LAG]);
  assert.ok(Math.abs(judge({ appearSec: late }).score - 0.7) < 1e-9);
  // 字幕提前 0.2 秒一样不过：比的是绝对值
  assert.deepEqual(failedAt(judge({ appearSec: ref.subtitleAppearSec.map((at) => at - 0.2) })), [LAG]);
  // 旁白每 0.1 秒一次起声：字幕怎么放都对得上，随机基线 100%
  const chatter = Array.from({ length: Math.floor(span * 10) }, (_, i) => i / 10);
  assert.ok(stats(ref.subtitleAppearSec, chatter).subtitleLagSec <= lagArgs.maxSubtitleLagSec);
  assert.ok(stats(ref.subtitleAppearSec, chatter).randomRate > 0.99);
  assert.deepEqual(failedAt(judge({ onsetsSec: chatter })), [LAG]);
  const badLag = {
    '没有字幕': { appearSec: [] },
    '没有旁白': { onsetsSec: [] },
    '字幕时刻是 null': { appearSec: ref.subtitleAppearSec.with(0, null) },
    '字幕表全是空洞': { appearSec: Array(47) },
    '起声表有 NaN': { onsetsSec: ref.narrationOnsetsSec.with(5, NaN) },
    '成片时长是 0': { spanSec: 0 },
    '成片时长是字符串': { spanSec: String(span) },
    '参考片的读数自报题目的 30 秒': { spanSec: own },
    '参考片的时长报长一倍': { spanSec: span * 2 },
    '参考片的时长多报 1 秒': { spanSec: span + 1 },
    '字幕时刻在成片之外': { appearSec: [...ref.subtitleAppearSec, span + 1] },
    '起声在片头之前': { onsetsSec: [-0.1, ...ref.narrationOnsetsSec] },
  };
  for (const [what, timing] of Object.entries(badLag)) assert.deepEqual(failedAt(judge(timing)), [LAG], what);
  assert.ok(full(judge({ spanSec: span + 1 / ref.fps })), '参考片时长差一帧以内还认，基线照题目写明的参考片帧数算');

  // 三审的反例：随机基线的时长由题目定（900 帧、30 帧每秒，30 秒），读数自报的时长改不了它。
  // 30 次起声从 0.4 秒起每秒一次，字幕一块同帧、一块晚 0.1 秒：命中 50%，基线 30×0.126/30 = 12.6%，高出 37.4 个百分点，不够 40
  const onsets30 = Array.from({ length: 30 }, (_, i) => (4 + 10 * i) / 10);
  const half = onsets30.map((at, i) => (i % 2 ? (5 + 10 * i) / 10 : at));
  const local = (appearSec, spanSec, onsetsSec = onsets30) => score(q, { 'narration.timing': { ...refTiming, appearSec, onsetsSec, spanSec }, 'color.palette': refShares });
  const halfStats = readSubtitleLag(half, onsets30, own, lagArgs.maxSubtitleLagSec);
  assert.ok(Math.abs(halfStats.subtitleLagSec - 0.05) < 1e-9 && halfStats.hitRate === 0.5 && Math.abs(halfStats.randomRate - 0.126) < 1e-9, JSON.stringify(halfStats));
  for (const spanSec of [undefined, own, own + 1 / 30, own - 1 / 30, 60, 45, own + 0.1, span, 1e9, Infinity, null, '30']) {
    const verdict = local(half, spanSec);
    assert.deepEqual(failedAt(verdict), [LAG], `命中一半、自报时长 ${spanSec}：不过`);
    assert.ok(Math.abs(verdict.score - 0.7) < 1e-9);
  }
  // 同一组起声、字幕全部同帧：命中 100%，不报时长、报 30 秒（差一帧以内）都满分；报别的时长照样不认
  for (const spanSec of [undefined, own, own + 1 / 30, own - 1 / 30]) assert.ok(full(local(onsets30, spanSec)), `全部同帧、自报时长 ${spanSec}`);
  for (const spanSec of [60, own + 0.1, span, 0, -30, NaN]) assert.deepEqual(failedAt(local(onsets30, spanSec)), [LAG], `全部同帧、自报时长 ${spanSec}`);
  assert.deepEqual(failedAt(local([...onsets30, 30.01])), [LAG], '字幕在第 30 秒之后');
  // 四审的反例：同样命中一半，把最后一次起声和它的字幕挪到 30.4、30.5 秒，再自报参考片的时长。
  // 正式判分不看读数自报什么，时长一律是题目的 30 秒：时刻出了 30 秒就不过，换不到参考片的 179 秒去摊薄基线（那样基线只剩 2.11%）
  const [spillOnsets, spillAppear] = [onsets30.with(-1, 30.4), half.with(-1, 30.5)];
  const spilled = readSubtitleLag(spillAppear, spillOnsets, span, lagArgs.maxSubtitleLagSec);
  assert.ok(spilled.hitRate === 0.5 && Math.abs(spilled.randomRate - 30 * 0.126 / span) < 1e-9 && spilled.hitRate - spilled.randomRate >= lagArgs.minLiftOverRandom, JSON.stringify(spilled));
  for (const spanSec of [span, span + 1 / 30, undefined, own, 60]) {
    const verdict = local(spillAppear, spanSec, spillOnsets);
    assert.deepEqual(failedAt(verdict), [LAG], `时刻出了 30 秒、自报时长 ${spanSec}：不过`);
    assert.ok(Math.abs(verdict.score - 0.7) < 1e-9 && verdict.pass === false);
  }
  // 时长只从题目的 deliverable 来：帧数、帧率写坏了这条线不判过
  for (const deliverable of [{ frames: 900 }, { fps: '30/1' }, { frames: 900, fps: 30 }, { frames: 900.5, fps: '30/1' }, { frames: 0, fps: '30/1' }]) {
    assert.deepEqual(failedAt(score({ ...q, deliverable }, { 'narration.timing': { ...refTiming, appearSec: onsets30, onsetsSec: onsets30, spanSec: undefined }, 'color.palette': refShares })), [LAG], JSON.stringify(deliverable));
  }
  // 题目没写参考片的帧范围：参考片的时长也不认
  const noRef = { ...q, scoring: q.scoring.map((item, i) => (i === LAG ? { ...item, args: { ...item.args, refFrames: undefined } } : item)) };
  assert.deepEqual(failedAt(score(noRef, refReadings, REF)), [LAG]);
  // 只交汇总数（中位数、命中率、随机基线）不认：三条线都要原始读数
  assert.deepEqual(failedAt(score(q, { 'narration.timing': { subtitleLagSec: 0, hitRate: 1, randomRate: 0, fadeFramesMedian: 3 }, 'color.palette': refShares })), [LAG, FADE, PAUSE]);

  // 淡出：不做淡出、淡得太长都不过；三个场景至少两处边界，至少两处各自在 3 到 4 帧里，中位数也在
  const badFades = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [8, 8, 8], [2, 2, 3], [5, 4, 5], [], [3], [0, 7], [3, 0, 17, 9, 9], [3, 4, 9, 9, 9], [-1, 3, 4, 100], [3, null, 4], [3, NaN, 4], Array(9), holed([3, 3, 3, 3], 1)];
  for (const fades of badFades) assert.deepEqual(failedAt(judge({ fadeFrames: fades })), [FADE], JSON.stringify(fades));
  for (const fades of [[3, 3, 3], [4, 4, 4], [3, 4]]) assert.ok(full(judge({ fadeFrames: fades })), JSON.stringify(fades));

  // 首尾留白：按中位数判（参考是平台重压版，门限把词尾余音算进说话，收声到边界最短读出 0.32 秒），至少三个场景
  const badPauses = {
    '开头不留白': { leadSec: ref.scenePauses.leadSec.map(() => 0.1) },
    '结尾留得不够': { tailSec: ref.scenePauses.tailSec.map(() => 0.2) },
    '只量了两个场景': { leadSec: [0.3, 0.3], tailSec: [0.36, 0.36] },
    '首尾个数对不上': { leadSec: ref.scenePauses.leadSec.slice(1) },
    '没量结尾': { tailSec: undefined },
    '开头是 null': { leadSec: ref.scenePauses.leadSec.with(0, null) },
    '结尾有空洞': { tailSec: Array(10) },
    '留白是负数': { leadSec: [-1, 0.3, 0.3, 0.3], tailSec: [0.4, 0.4, 0.4, 0.4] },
  };
  for (const [what, timing] of Object.entries(badPauses)) assert.deepEqual(failedAt(judge(timing)), [PAUSE], what);
  assert.ok(full(judge({ leadSec: [0.3, 0.3, 0.3], tailSec: [0.36, 0.36, 0.36] })), '三个场景正好留够');
  assert.deepEqual(failedAt(judge({ leadSec: [0.3, 0.29, 0.29], tailSec: [0.36, 0.36, 0.36] })), [PAUSE]);
  assert.deepEqual(failedAt(judge({ leadSec: [0.3, 0.3, 0.3], tailSec: [0.36, 0.35, 0.35] })), [PAUSE]);
  assert.deepEqual([pauseArgs.minLeadSec, pauseArgs.minTailSec], [0.3, 0.36]);

  // 底色占比：片尾来源卡 85.4% 超上限，所以夹具里不把它算进讲解场景
  const scene = (share, hex = '#F4F0E9') => ({ colors: [[hex, share]] });
  assert.deepEqual(shares([ref.palette.creditsCard]), { shares: [0.854] });
  assert.deepEqual(failedAt(judge({}, shares([...ref.palette.sceneFrames, ref.palette.creditsCard]))), [PALETTE]);
  for (const share of [0.6, 0.749, 0.851, 0.95]) assert.deepEqual(failedAt(judge({}, shares([scene(0.8), scene(share), scene(0.8)]))), [PALETTE], String(share));
  assert.ok(full(judge({}, shares([scene(0.75), scene(0.8), scene(0.85)]))));
  // 换了底色（不在同一个色格里）
  assert.deepEqual(failedAt(judge({}, shares([scene(0.8), scene(0.8), scene(0.8, '#E4F0E9')]))), [PALETTE]);
  // 每个场景都要量到：只交一两场、空洞、null 都不过
  const badShares = [[], [0.8], [0.8, 0.8], Array(3), [0.8, null, 0.8], [0.8, NaN, 0.8], [0.8, 0.8, '0.8'], holed([0.8, 0.8, 0.8, 0.8], 2), Object.assign([0.8, 0.8, 0.8], { note: 1 })];
  for (const list of badShares) assert.deepEqual(failedAt(judge({}, { shares: list })), [PALETTE], JSON.stringify(list));
  assert.deepEqual(failedAt(judge({}, {})), [PALETTE], '没交占比');

  // 底色是同一个色格里 80 种不同的细分色值（压缩后的画面就是这样），占 80%：照色格数全帧，读回 0.80，满分
  const rgba = new Uint8Array(100 * 4).fill(255);
  for (let i = 0; i < 80; i++) rgba.set([0xF0 + (i % 16), 0xF0 + (i >> 4), 0xE9], i * 4);
  for (let i = 80; i < 100; i++) rgba.set([0, 0, 0], i * 4);
  assert.equal(new Set(Array.from({ length: 80 }, (_, i) => rgba[i * 4] * 256 + rgba[i * 4 + 1])).size, 80);
  const graded = readBaseShare([1, 2, 3].map(() => ({ width: 100, height: 1, rgba })), paletteArgs);
  assert.deepEqual(graded, { shares: [0.8, 0.8, 0.8] });
  assert.ok(full(judge({}, graded)));
  assert.throws(() => readBaseShare([null], paletteArgs), RangeError, '坏帧报 RangeError，不是 TypeError');
});

/* ---------------- 18-2 ---------------- */

test('B4-6 18-2：案例 18 两次运镜的读数满分；错位 2 帧以上、少一次、多一次、不运镜判不过', () => {
  const q = question('18-2'), ref = reference('18-2');
  const args = argsOf(q, 'narration.timing');
  // 夹具的帧号是原片里的绝对帧号；题目的时间线从地图场景的起点记作第 0 帧。判分认两个窗口：题目的 [0, 600)，和夹具写明的原片场景范围
  const size = [64, 36], origin = ref.sceneFrames[0], range = [0, q.deliverable.frames];
  assert.ok(ref.sceneFrames[1] - origin >= q.deliverable.frames, '地图场景够 600 帧');
  assert.deepEqual(ref.moves.map((move) => move.cue), args.events);
  assert.equal(args.moves, args.events.length, '快速运镜正好两次，一次对一个触发点');
  // 比较基准：触发词的帧号减去题面规定的提前量（15 帧、27 帧），不是触发词本身
  assert.deepEqual(ref.moves.map((move) => Math.round(move.leadSec * ref.fps)), args.leadFrames);
  assert.deepEqual(args.leadFrames, [15, 27]);
  for (const frames of args.leadFrames) assert.ok(q.brief.includes(`${frames} 帧`) && q.scoring[0].pass.includes(`${frames} 帧`), `题面和判分细则都写明提前 ${frames} 帧`);
  for (const move of ref.moves) assert.ok(Math.abs(move.cueSec - move.leadSec - move.expectedStartSec) < 1e-9);
  const cues = ref.moves.map((move) => move.cueSec * ref.fps - origin);
  const expected = ref.moves.map((move) => move.expectedStartSec * ref.fps - origin);
  // 判分吃的是原始读数：触发词的帧号、量出的运镜起点、地图场景的帧范围
  const reading = (starts, events = cues, span = range) => ({ eventFrames: events, markFrames: starts, range: span });
  // 每次运镜 45 帧、每帧横移 2 像素；别的时候机位不动
  const film = (starts) => (k) => grayFrame(...size, { dx: -2 * starts.reduce((sum, start) => sum + Math.max(0, Math.min(45, k - start)), 0) });
  const judge = (starts) => score(q, { 'narration.timing': reading(readMoveStarts(film(starts), range, size, args)) });

  const measured = ref.moves.map((move) => Math.round(move.measuredStartSec * ref.fps) - origin);
  assert.deepEqual(measured.map((start) => start + origin), [3621, 3915]);
  assert.deepEqual(measured, [225, 519]);
  for (const frame of [...cues, ...expected, ...measured]) assert.ok(frame >= 0 && frame < q.deliverable.frames, `第 ${frame} 帧在题目的 600 帧里`);
  assert.deepEqual(readMoveStarts(film(measured), range, size, args), measured, '真实指标逐帧量回两次运镜的起点');
  const refHits = readHits(expected, measured, range, args.tolFrames);
  assert.ok(refHits.offsetsFrames.every((offset) => offset < 0.31), JSON.stringify(refHits.offsetsFrames));
  assert.equal(refHits.randomRate, 6 / 600);
  assert.match(q.controls.random, /6\/600/);
  assert.ok(full(judge(measured)), '案例 18 的读数满分');

  for (const shift of [-3, -2, 2, 3, 15]) assert.equal(judge(measured.map((start) => start + shift)).pass, false, `整体错位 ${shift} 帧`);
  assert.equal(judge([measured[0], measured[1] + 3]).pass, false, '只有第二次错位');
  assert.equal(judge([measured[0]]).pass, false, '只做一次运镜');
  assert.equal(judge([]).pass, false, '全程不运镜');
  assert.equal(judge(measured.map((start) => start - 1)).pass, true, '早 1 帧（离应起帧 0.7 帧）还在容差内');
  // 两次都对上，中间又多做一次：题面只许两次
  assert.deepEqual(readMoveStarts(film([225, 304, 519]), range, size, args), [225, 304, 519]);
  assert.equal(judge([225, 304, 519]).pass, false, '多做一次运镜');
  // 起在触发词上、没照题面提前：差 15 帧和 27 帧
  assert.equal(score(q, { 'narration.timing': reading(cues.map(Math.round)) }).pass, false, '比的是扣掉提前量之后的应起帧');
  // 夹具的原片帧号直接交也认，前提是连夹具的场景范围 [3396, 4015) 一起报上来（题目 args.refFrames 照夹具写明，判分只多认这一个窗口）
  assert.deepEqual(args.refFrames, ref.sceneFrames);
  assert.deepEqual(ref.sceneFrames, [3396, 4015]);
  const absolute = { eventFrames: ref.moves.map((move) => move.cueSec * ref.fps), markFrames: ref.moves.map((move) => Math.round(move.measuredStartSec * ref.fps)) };
  assert.deepEqual(absolute.eventFrames.map((frame) => Math.round(frame * 10) / 10), [3635.7, 3941.7]);
  assert.deepEqual(absolute.markFrames, [3621, 3915]);
  const direct = (range, extra = {}) => score(q, { 'narration.timing': { ...absolute, ...extra, ...(range === undefined ? {} : { range }) } });
  assert.ok(full(direct(ref.sceneFrames)), '夹具的原片窗口读数满分');
  assert.ok(full(score(q, { 'narration.timing': reading(measured) })), '换到题目的 [0, 600) 同样满分');
  assert.equal(direct().pass, false, '绝对帧号不报范围：照题目的 600 帧算，都在片外');
  assert.equal(direct().score, 0);
  // 随手编的窗口都不认：放宽、平移、差一帧、照 600 帧截短、字符串
  for (const range of [[0, 1200], [100, 700], [0, 4015], [3396, 4016], [3395, 4015], [3396, 3996], [3000, 4500], ['3396', 4015], [3396, 4015, 1], Object.assign([3396, 4015], { note: 1 })]) {
    assert.equal(direct(range).score, 0, `窗口 ${JSON.stringify(range)}`);
  }
  // 原片窗口里三样照样都要在 [3396, 4015) 里；贴着两头的还算
  const inRef = (starts, events) => score(q, { 'narration.timing': { eventFrames: events, markFrames: starts, range: ref.sceneFrames } }).pass;
  assert.equal(inRef([3396, 3696], [3411, 3723]), true, '第一次运镜正好从场景第一帧起');
  assert.equal(inRef([3496, 3987], [3511, 4014]), true, '第二个触发词在场景最后一帧');
  assert.equal(inRef([3395, 3696], [3411, 3723]), false, '运镜起在场景之前');
  assert.equal(inRef([3396, 3696], [3410, 3723]), false, '应起帧在场景之前');
  assert.equal(inRef([3496, 3988], [3511, 4015]), false, '触发词在场景之外');
  assert.equal(inRef([3496, 4015], [3511, 4041]), false, '运镜起在场景之外');
  assert.equal(inRef(measured, cues), false, '报原片的窗口、帧号却是成片的');
  assert.equal(inRef(absolute.markFrames.map((frame) => frame + 3), absolute.eventFrames), false, '原片窗口里错位 3 帧');
  assert.equal(inRef(absolute.markFrames, absolute.eventFrames.map((frame, i) => frame - args.leadFrames[i])), false, '原片窗口里也要照提前量');

  // 判分线的边界：触发词在第 115、327 帧，应起帧是第 100、300 帧
  const line = (starts, events = [115, 327], span = [0, 600]) => score(q, { 'narration.timing': reading(starts, events, span) }).pass;
  assert.equal(line([100, 300]), true);
  assert.equal(line([101, 301]), true);
  assert.equal(line([99, 299]), true);
  assert.equal(score(q, { 'narration.timing': { eventFrames: [115, 327], markFrames: [100, 300] } }).pass, true, '读数可以不报范围，窗口照题目的 600 帧');
  // 触发词、应起帧、量到的起点三样都要在 [0, 600) 里；贴着两头的还算
  assert.equal(line([0, 300], [15, 327]), true, '第一次运镜正好从第 0 帧起');
  assert.equal(line([100, 572], [115, 599]), true, '第二个触发词在最后一帧');
  assert.match(q.scoring[0].pass, /都要落在成片的 600 帧里/);
  // 窗口只从题目的 deliverable.frames 来：题目没写、写的不是正整数，这条线不判过
  for (const frames of [undefined, '600', 600.5, 0, -600, Infinity]) {
    assert.equal(score({ ...q, deliverable: { ...q.deliverable, frames } }, { 'narration.timing': { eventFrames: [115, 327], markFrames: [100, 300] } }).pass, false, String(frames));
  }
  assert.equal(score({ scoring: q.scoring }, { 'narration.timing': { eventFrames: [115, 327], markFrames: [100, 300] } }).pass, false, '题目没有 deliverable');
  const broken = {
    '第二次差 1.01 帧': [[101, 301.01]],
    '第一次差 2 帧': [[98, 300]],
    '中间多一次': [[100, 200, 300]],
    '后面多一次（前两次都对上）': [[100, 300, 400]],
    '两个应起帧挤在同一次运镜上，另一次在别处': [[101, 500], [115, 129]],
    '只有一次': [[100]],
    '一次都没有': [[]],
    '起点是 null（不能当成第 0 帧）': [[null, 300], [15, 327]],
    '起点表全是空洞': [Array(2)],
    '起点表空洞和附加属性抵掉个数': [holed([100, 200, 300], 1)],
    '起点倒着': [[300, 100]],
    '起点重复': [[100, 100]],
    '只报一个触发点': [[100, 300], [115]],
    '触发点是 null': [[100, 300], [null, 327]],
    '触发点不递增': [[100, 300], [327, 115]],
    '运镜起在片头之前（第 −1 帧）': [[-1, 300], [15, 327]],
    '触发词在片尾之外（第 617 帧）': [[100, 590], [115, 617]],
    '运镜起在片尾之外': [[100, 600], [115, 626]],
    '应起帧在片头之前': [[0, 300], [14, 327]],
    '帧范围不从第 0 帧起': [[100, 300], [115, 327], [200, 600]],
    '帧范围不是数': [[100, 300], [115, 327], [0, '600']],
    '帧范围改窄': [[100, 102], [115, 129], [99, 104]],
    '帧范围放宽到片外，片外的触发词不认': [[100, 590], [115, 617], [0, 1200]],
    '帧范围往片头前伸，片头前的运镜不认': [[-1, 300], [15, 327], [-600, 600]],
    '帧范围报原片的、帧号却是成片的': [[100, 300], [115, 327], [3396, 4015]],
    '帧范围是 null': [[100, 300], [115, 327], null],
  };
  for (const [what, given] of Object.entries(broken)) assert.equal(line(...given), false, what);
  // 只交汇总数不认：偏差写 999、命中率写满，或者偏差写 0，都没有原始读数
  for (const offsetsFrames of [[999, 999], [0, 0], [0]]) {
    assert.equal(score(q, { 'narration.timing': { offsetsFrames, hitRate: 1, randomRate: 0 } }).pass, false, JSON.stringify(offsetsFrames));
  }
});

/* ---------------- 15-2 ---------------- */

test('B4-7 15-2：案例 15 细密画一行的读数满分；缓推、平移、相机矩阵有一帧不同或不完整判不过', () => {
  const q = question('15-2'), ref = reference('15-2');
  const args = argsOf(q, 'motion.zoom-pan'), frames = q.deliverable.frames;
  assert.equal(argsOf(q, 'meta.camera-static').frames, frames, '相机矩阵要 300 帧一帧不少');
  assert.equal(args.maxErrorGap, 0, '估出不动，误差就该等于不动时的误差');
  const first = grayFrame(...ref.size);
  // 尾帧 = 首帧照读数变换，再叠上和读数的误差一样大的噪声（均匀噪声全幅是平均绝对值的 4 倍）
  const pair = ({ scale, dx, dy, error }, seed) => [first, grayFrame(...ref.size, { scale, dx, dy, noise: 4 * error, seed })];
  const camera = () => ({ world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 4, 1], proj: [1.3, 0, 0, 0, 0, 2.3, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2, 0] });
  const locked = () => Array.from({ length: frames }, camera);
  // 判分吃的是原始读数：逐帧的相机矩阵、每对帧估出的变换和两种误差
  const judge = (lock, cameras = locked()) => score(q, { 'motion.zoom-pan': lock, 'meta.camera-static': { cameras } });

  const refLock = readLock(ref.locked.map(pair), ref.size, args);
  ref.locked.forEach((reading, i) => {
    const { scale, dx, dy, error, stillError } = refLock.pairs[i];
    assert.deepEqual({ scale, dx, dy }, { scale: 1, dx: 0, dy: 0 }, `镜头 ${reading.shot}`);
    assert.equal(error, stillError, '误差等于不动时的误差');
    assert.equal(reading.error, reading.stillError);
    assert.ok(Math.abs(error - reading.error) <= 0.5, `镜头 ${reading.shot} 造出的误差 ${error} 应在读数 ${reading.error} 上下`);
  });
  assert.deepEqual(readCameraStatic(locked()), { frames, changedAt: null });
  assert.ok(full(judge(refLock)), '案例 15 细密画一行的读数满分');
  // 夹具里的读数原样交上去（不经造帧）也是满分
  assert.ok(full(judge({ pairs: ref.locked })));

  // 另外两行读出缓推或平移的五个镜头
  for (const reading of ref.drifting) {
    const lock = readLock([pair(ref.locked[0], 1), pair(reading, 7)], ref.size, args);
    const { scale, dx, dy, error, stillError } = lock.pairs[1];
    assert.ok(scale !== 1 || dx !== 0 || dy !== 0, `${reading.row}${reading.shot} 应量出机位在动`);
    assert.ok(Math.abs(scale - reading.scale) <= 0.025 && Math.abs(dx - reading.dx) <= 1 && Math.abs(dy - reading.dy) <= 1, `${reading.row}${reading.shot} 量回 ${JSON.stringify({ scale, dx, dy })}`);
    assert.ok(error < stillError);
    assert.deepEqual(failed(judge(lock)), ['motion.zoom-pan'], `${reading.row}${reading.shot}`);
    assert.equal(judge(lock).score, 0.5);
    assert.deepEqual(failed(judge({ pairs: [ref.locked[0], reading] })), ['motion.zoom-pan'], `${reading.row}${reading.shot} 夹具读数原样`);
  }
  // 只推近不平移
  const pushIn = readLock([pair(ref.locked[0], 1), pair({ scale: 1.05, dx: 0, dy: 0, error: 2 }, 3)], ref.size, args);
  assert.deepEqual({ scale: pushIn.pairs[1].scale, dx: pushIn.pairs[1].dx, dy: pushIn.pairs[1].dy }, { scale: 1.05, dx: 0, dy: 0 });
  assert.deepEqual(failed(judge(pushIn)), ['motion.zoom-pan']);

  // 帧对读数：两对都要量到，每对都是完整的数，估出不动时两种误差必须相等
  const still = { scale: 1, dx: 0, dy: 0, error: 2, stillError: 2 };
  assert.ok(full(judge({ pairs: [still, still] })));
  const badPairs = {
    '少量了一对帧': refLock.pairs.slice(0, 1),
    '一对都没量': [],
    '两个槽位都是空洞': Array(2),
    '帧对是 null': [null, null],
    '空洞和附加属性抵掉个数': holed([still, still, still], 1),
    '误差对不上（20 对 1）': [still, { ...still, error: 20, stillError: 1 }],
    '没报误差': [still, { scale: 1, dx: 0, dy: 0 }],
    '误差是 null': [still, { ...still, error: null, stillError: null }],
    '误差是负数': [still, { ...still, error: -2, stillError: -2 }],
    '缩放是字符串': [still, { ...still, scale: '1' }],
    '平移是 null': [still, { ...still, dx: null }],
    '平移 1 像素': [still, { ...still, dx: 1 }],
  };
  for (const [what, pairs] of Object.entries(badPairs)) assert.deepEqual(failed(judge({ pairs })), ['motion.zoom-pan'], what);
  assert.deepEqual(failed(judge({})), ['motion.zoom-pan'], '没交帧对');
  assert.throws(() => readLock([null], ref.size, args), RangeError, '坏帧对报 RangeError，不是 TypeError');

  // 相机矩阵：任何一帧、任何一个分量不同都不过；像素量不出的微漂移靠它拦
  const nudged = (key, index, at) => locked().map((cam, k) => (k === at ? { ...cam, [key]: cam[key].with(index, cam[key][index] + 1e-6) } : cam));
  assert.deepEqual(readCameraStatic(nudged('world', 12, 137)), { frames, changedAt: 137 });
  assert.deepEqual(failed(judge(refLock, nudged('world', 12, 137))), ['meta.camera-static']);
  assert.deepEqual(failed(judge(refLock, nudged('proj', 0, frames - 1))), ['meta.camera-static'], '只有末帧变了焦');
  const subPixel = readLock([[first, grayFrame(...ref.size, { dx: 0.3 })], pair(ref.locked[0], 1)], ref.size, args);
  assert.deepEqual(failed(judge(subPixel, nudged('world', 12, 1))), ['meta.camera-static'], '0.3 像素的漂移像素指标读成不动，矩阵核对拦住');

  // 相机矩阵必须是 300 帧、每帧两个 16 元有限数数组：缺帧、空矩阵、null、NaN、空洞都不过，也不抛错
  const every = (make) => Array.from({ length: frames }, make);
  const at = (index, cam) => locked().with(index, cam);
  const sparse = locked();
  delete sparse[150];
  // 下面几项的第三个数是读出的帧数：相机数组自己有空洞或带了附加属性（键数对不上）时帧数读成 null
  const patched = locked();
  delete patched[150];
  const badCameras = {
    '少一帧': [locked().slice(1), null],
    '多一帧': [[...locked(), camera()], null],
    '一帧都没有': [[], null],
    '300 帧都是空矩阵': [every(() => ({ world: [], proj: [] })), 0],
    '分量全是 null': [every(() => ({ world: Array(16).fill(null), proj: Array(16).fill(null) })), 0],
    '矩阵是 16 个空洞': [every(() => ({ world: Array(16), proj: Array(16) })), 0],
    '第 150 帧缺了（稀疏数组）': [sparse, 150, null],
    '300 帧都对，数组上多挂了一个 fps': [Object.assign(locked(), { fps: 30 }), null, null],
    '300 帧都对，数组上多挂了一个 Symbol 键': [Object.assign(locked(), { [Symbol('fps')]: 30 }), null, null],
    '第 150 帧缺了，附加属性正好抵掉个数': [Object.assign(patched, { fps: 30 }), 150],
    '第 7 帧是 null': [at(7, null), 7],
    '第 7 帧没有投影矩阵': [at(7, { world: camera().world }), 7],
    '第 7 帧只有 15 个分量': [at(7, { ...camera(), world: camera().world.slice(1) }), 7],
    '第 7 帧有 17 个分量': [at(7, { ...camera(), proj: [...camera().proj, 0] }), 7],
    '第 7 帧有个 NaN': [at(7, { ...camera(), world: camera().world.with(3, NaN) }), 7],
    '第 7 帧有个字符串': [at(7, { ...camera(), proj: camera().proj.with(0, '1.3') }), 7],
    '第 7 帧矩阵空洞和附加属性抵掉个数': [at(7, { ...camera(), world: holed(camera().world, 4) }), 7],
  };
  for (const [what, [cameras, changedAt, count = cameras.length]] of Object.entries(badCameras)) {
    assert.deepEqual(readCameraStatic(cameras), { frames: count, changedAt }, what);
    assert.deepEqual(failed(judge(refLock, cameras)), ['meta.camera-static'], what);
  }
  for (const cameras of [null, undefined, 300, { length: frames }]) {
    assert.deepEqual(readCameraStatic(cameras), { frames: null, changedAt: null });
    assert.deepEqual(failed(score(q, { 'motion.zoom-pan': refLock, 'meta.camera-static': { cameras } })), ['meta.camera-static'], String(cameras));
  }
  // 只交汇总数（帧数、哪一帧变了）不认
  assert.deepEqual(failed(score(q, { 'motion.zoom-pan': refLock, 'meta.camera-static': { frames, changedAt: null } })), ['meta.camera-static']);
});

/* ---------------- 判分器本身 ---------------- */

test('B4-8 没给读数、读数缺项、读数不是对象的题一条都不过，也不抛错', () => {
  for (const id of IDS) {
    const q = question(id);
    const zero = { items: q.scoring.map(({ metric, weight }) => ({ metric, weight, pass: false })), score: 0, pass: false };
    for (const readings of [{}, null, undefined, 42, 'x', [], true]) assert.deepEqual(score(q, readings), zero, `${id} ${JSON.stringify(readings)}`);
    for (const reading of [{}, null, [], 42, 'x', [null]]) {
      assert.deepEqual(score(q, Object.fromEntries(q.scoring.map(({ metric }) => [metric, reading]))), zero, `${id} 每个指标都交 ${JSON.stringify(reading)}`);
    }
  }
  // 一条判分线都没写的 scoring 不算过；不认识的指标、对象自带的属性名也不算过
  const reading = { fadeFrames: [3, 4] };
  const one = (item) => score({ scoring: [{ weight: 1, ...item }] }, { [item.metric]: reading }).pass;
  assert.equal(one({ metric: 'narration.timing' }), false);
  assert.equal(one({ metric: 'narration.timing', args: { fadeFrames: [3, 4], minScenes: 3 } }), true);
  assert.equal(one({ metric: 'narration.timing', args: { fadeFrames: [3, 4] } }), false, '没写要几个场景，不判过');
  assert.equal(one({ metric: 'not.registered' }), false);
  assert.equal(one({ metric: 'constructor' }), false);
  assert.equal(one({ metric: 'toString' }), false);
  // 读数里带一取就抛错的取值器：这条线不过，错不往外抛
  const trap = { get corr() { throw new Error('boom'); }, get cameras() { throw new Error('boom'); } };
  assert.equal(score(question('5-1'), { 'music.align': trap, 'beat.onset-hit': trap }).score, 0);
  assert.equal(score(question('15-2'), { 'motion.zoom-pan': trap, 'meta.camera-static': trap }).score, 0);
});

test('B4-9 denseFinite：密实、没有附加属性、元素都是有限数的数组才算数', () => {
  assert.equal(denseFinite([0]), true);
  assert.equal(denseFinite([1, 2.5, -3]), true);
  assert.equal(denseFinite([1, 2], 2), true);
  assert.equal(denseFinite([1, 2], 3), false);
  assert.equal(denseFinite([], 0), true);
  const bad = [[], Array(3), [1, null], [1, undefined], [1, NaN], [1, Infinity], ['1'], [1n], [[1]], holed([1, 2, 3], 1), Object.assign([1, 2], { note: 1 }),
    { length: 1, 0: 1 }, new Float32Array([1, 2]), null, undefined, 'ab', 12];
  for (const value of bad) assert.equal(denseFinite(value), false, String(value));
});

test('B4-10 专名扫描：三个案例各有词元在册，拼进已知词元就报警，换大小写、驼峰、全角、夹零宽字符都躲不过', () => {
  for (const group of ['05', '15', '18', '平台', '哨兵']) assert.ok(NOUN_HASHES[group].length >= 1, `${group} 没有词元`);
  const hashes = Object.values(NOUN_HASHES).flat();
  assert.equal(new Set(hashes).size, hashes.length, '没有重复');
  for (const hash of hashes) assert.match(hash, /^[0-9a-f]{24}$/, '只存 24 位前缀，不是裸的 64 位摘要');
  // 真专名在仓库里只有哈希、拿不出明文，这里用在册的两个哨兵词元验扫描器；两段现拼，源码里不连着出现
  const word = ['zqx', 'canary'].join(''), han = ['甲乙', '丙丁'].join('');
  const alarm = [{ line: 2, group: '哨兵' }];
  const disguises = {
    '注释里': `// ${word}`,
    '全大写': word.toUpperCase(),
    '首字母大写接在驼峰里': `ref${word[0].toUpperCase()}${word.slice(1)}Frames`,
    '下划线和数字夹着': `shot_${word}_02.json`,
    '全角字母': [...word].map((letter) => String.fromCodePoint(letter.codePointAt(0) + 0xFEE0)).join(''),
    '夹零宽字符': `${word.slice(0, 3)}\u200b${word.slice(3)}`,
    '汉字，前后连着别的字': `案例${han}的读数`,
    '汉字夹零宽字符': `${han.slice(0, 2)}\u200d${han.slice(2)}`,
    'JSON 的值里': JSON.stringify({ note: `${han} ${word}` }),
  };
  for (const [what, text] of Object.entries(disguises)) assert.deepEqual(scanProperNouns(`第一行\n${text}\n`).map(({ line, group }) => ({ line, group })).slice(0, 1), alarm, what);
  // 二审的做法：给本测试文件的原文追加一行带词元的注释，必须报出是哪一行
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.deepEqual(scanProperNouns(self), []);
  assert.deepEqual(scanProperNouns(`${self}\n// ${word}`), [{ line: self.split('\n').length + 1, group: '哨兵' }]);
  // 按词比，不按子串比：词元前后连着别的字母不算
  for (const clean of ['', '旁白讲解场景，底色 #F4F0E9', `${word}s`, `un${word}`, word.slice(1), han.slice(1)]) assert.deepEqual(scanProperNouns(clean), [], clean);
});
