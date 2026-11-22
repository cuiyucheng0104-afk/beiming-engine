// B4：二级第二批 4 道考题（5-1[05-1]、18-1、18-2、15-2）契约校验与参考片/反例自动判分核验
// 参考读数夹具里只有数，没有原片媒体：包络、彩色帧、灰度帧都在这里照读数现造，再交给 observe 的真实实现去量。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectPublicQuestion, scanQuestionLeaks, validateQuestion } from './index.mjs';
import { readBaseShare, readCameraStatic, readFades, readHits, readLock, readMoveStarts, readMusicAlign, readSubtitleLag, score } from './questions/level-2-b/evaluate-b4.mjs';

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
    assert.deepEqual(q.calibration, { ...q.calibration, status: 'uncalibrated', noiseFloor: null, version: 0 });
  }
  // 对位题必须带随机对照；15-2 考的是机位锁死，没有可对的事件
  for (const id of ['5-1', '18-1', '18-2']) assert.ok(question(id).controls.random, `${id} 缺随机对照`);
  assert.equal(question('15-2').controls.random, undefined);
});

test('B4-3 题目、夹具、核验器全部文件零泄露', () => {
  const files = [...readdirSync(QUESTIONS).map((name) => join(QUESTIONS, name)), ...readdirSync(REFS).map((name) => join(REFS, name))];
  assert.equal(files.length, 9, '4 道题、1 个核验器、4 份夹具');
  for (const file of files) assert.deepEqual(scanQuestionLeaks(readFileSync(file, 'utf8')), [], file);
});

/* ---------------- 5-1 ---------------- */

test('B4-4 5-1：案例 05 的读数满分；拉伸超 3%、不相关的配乐、重击偏离硬切判不过', () => {
  const q = question('5-1'), ref = reference('5-1');
  const alignArgs = argsOf(q, 'music.align'), hitArgs = argsOf(q, 'beat.onset-hit');
  assert.ok(q.basePredicates.includes(`cut_at(${ref.hardCutFrame})`), '硬切事件是基础谓词');
  assert.equal(ref.frames, q.deliverable.frames);
  const music = (over, synth) => readMusicAlign(envelopes({ ...ref.musicAlign, ...over }, ref, synth), alignArgs);
  const hit = (peaks, cut = ref.hardCutFrame) => readHits([cut], peaks, [0, ref.frames], hitArgs.tolFrames);
  const judge = (align, onset) => score(q, { 'music.align': align, 'beat.onset-hit': onset });

  const refAlign = music(), refHit = hit(ref.lowBand.peakFrames);
  assert.equal(refAlign.stretch, ref.musicAlign.stretch, '真实求解器量回拉伸比 1.009');
  assert.ok(Math.abs(refAlign.corr - ref.musicAlign.corr) <= 0.01, `相关 ${refAlign.corr} 应在 0.836 上下`);
  assert.equal(refAlign.offsetSec, ref.musicAlign.offsetSec);
  assert.deepEqual(refHit, { offsetsFrames: [1], hitRate: 1, randomRate: 87 / 720 });
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
  const late = hit(ref.lowBand.peakFrames.map((frame) => frame + 4));
  assert.deepEqual(late.offsetsFrames, [3]);
  assert.deepEqual(failed(judge(refAlign, late)), ['beat.onset-hit']);
  // 边界：正好 2 帧过，3 帧不过
  assert.ok(full(judge(refAlign, hit([626]))));
  assert.deepEqual(failed(judge(refAlign, hit([627]))), ['beat.onset-hit']);
  assert.deepEqual(failed(judge(refAlign, hit([]))), ['beat.onset-hit'], '没有重击峰');
  // 每 4 帧一个峰：硬切怎么放都命中，随机基线 100%，不算对上
  const dense = hit(Array.from({ length: 181 }, (_, i) => i * 4));
  assert.equal(dense.hitRate, 1);
  assert.equal(dense.randomRate, 1);
  assert.deepEqual(failed(judge(refAlign, dense)), ['beat.onset-hit']);

  // 判分线的边界
  const line = (corr, stretch) => failed(judge({ corr, stretch }, refHit));
  assert.deepEqual(line(0.5, 0.97), []);
  assert.deepEqual(line(0.5, 1.03), []);
  assert.deepEqual(line(0.499, 1), ['music.align'], '相关低于 0.5 不判，不算过');
  assert.deepEqual(line(0.9, 1.031), ['music.align']);
  assert.deepEqual(line(0.9, 0.969), ['music.align']);
  assert.deepEqual(line(null, 1), ['music.align']);
});

/* ---------------- 18-1 ---------------- */

test('B4-5 18-1：案例 18 的读数满分；字幕滞后、不淡出、底色占比超界判不过', () => {
  const q = question('18-1'), ref = reference('18-1');
  const lagArgs = argsOf(q, 'narration.timing', (args) => 'maxSubtitleLagSec' in args), paletteArgs = argsOf(q, 'color.palette');
  const span = ref.frames / ref.fps;
  const lag = (appear = ref.subtitleAppearSec, onsets = ref.narrationOnsetsSec) => readSubtitleLag(appear, onsets, span, lagArgs.maxSubtitleLagSec);
  const shares = (frames) => readBaseShare(frames.map(({ colors }) => paletteFrame(colors)), paletteArgs);
  const judge = (timing, fades, palette) => score(q, { 'narration.timing': { ...timing, ...readFades(fades) }, 'color.palette': palette });

  const refLag = lag(), refShares = shares(ref.palette.sceneFrames);
  assert.ok(Math.abs(refLag.subtitleLagSec - ref.subtitleLag.medianSec) <= 0.01, `中位数 ${refLag.subtitleLagSec} 和原量测的 0.013 秒差在取整的一格内`);
  assert.equal(Math.round(refLag.hitRate * ref.subtitleLag.blocks), ref.subtitleLag.matchedWithin04Sec, '47 块里对上 44 块');
  assert.equal(Math.round(refLag.randomRate * 100), 4);
  assert.match(q.controls.random, /约 4%/);
  assert.equal(readFades(ref.sceneFadeFrames).fadeFramesMedian, 3);
  assert.deepEqual(refShares, { shares: [0.846, 0.792, 0.752] });
  assert.ok(full(judge(refLag, ref.sceneFadeFrames, refShares)), '案例 18 的读数满分');

  // 字幕整体滞后 0.2 秒（6 帧）
  const late = lag(ref.subtitleAppearSec.map((at) => at + 0.2));
  assert.ok(late.subtitleLagSec > 0.19);
  assert.deepEqual(failed(judge(late, ref.sceneFadeFrames, refShares)), ['narration.timing']);
  assert.equal(judge(late, ref.sceneFadeFrames, refShares).score, 0.6);
  // 字幕提前 0.2 秒一样不过：比的是绝对值
  assert.deepEqual(failed(judge(lag(ref.subtitleAppearSec.map((at) => at - 0.2)), ref.sceneFadeFrames, refShares)), ['narration.timing']);
  // 旁白每 0.1 秒一次起声：字幕怎么放都对得上，随机基线 100%
  const chatter = lag(ref.subtitleAppearSec, Array.from({ length: Math.floor(span * 10) }, (_, i) => i / 10));
  assert.ok(chatter.subtitleLagSec <= lagArgs.maxSubtitleLagSec);
  assert.ok(chatter.randomRate > 0.99);
  assert.deepEqual(failed(judge(chatter, ref.sceneFadeFrames, refShares)), ['narration.timing']);
  assert.deepEqual(failed(judge(lag([]), ref.sceneFadeFrames, refShares)), ['narration.timing'], '没有字幕');
  assert.deepEqual(failed(judge(lag(ref.subtitleAppearSec, []), ref.sceneFadeFrames, refShares)), ['narration.timing'], '没有旁白');

  // 淡出：不做淡出、淡得太长都不过；3 帧和 4 帧是两端
  for (const fades of [[0, 0, 0, 0, 0, 0, 0, 0, 0], [8, 8, 8], [2, 2, 3], [5, 4, 5], []]) {
    assert.deepEqual(failed(judge(refLag, fades, refShares)), ['narration.timing'], JSON.stringify(fades));
  }
  assert.ok(full(judge(refLag, [3, 3, 3], refShares)));
  assert.ok(full(judge(refLag, [4, 4, 4], refShares)));

  // 底色占比：片尾来源卡 85.4% 超上限，所以夹具里不把它算进讲解场景
  assert.deepEqual(shares([ref.palette.creditsCard]), { shares: [0.854] });
  assert.deepEqual(failed(judge(refLag, ref.sceneFadeFrames, shares([...ref.palette.sceneFrames, ref.palette.creditsCard]))), ['color.palette']);
  for (const share of [0.6, 0.749, 0.851, 0.95]) {
    assert.deepEqual(failed(judge(refLag, ref.sceneFadeFrames, shares([{ colors: [['#F4F0E9', share]] }]))), ['color.palette'], String(share));
  }
  assert.ok(full(judge(refLag, ref.sceneFadeFrames, shares([{ colors: [['#F4F0E9', 0.75]] }, { colors: [['#F4F0E9', 0.85]] }]))));
  // 换了底色（不在同一个色格里）
  assert.deepEqual(failed(judge(refLag, ref.sceneFadeFrames, shares([{ colors: [['#E4F0E9', 0.8]] }]))), ['color.palette']);
  assert.deepEqual(failed(judge(refLag, ref.sceneFadeFrames, { shares: [] })), ['color.palette'], '一帧都没抽');
});

/* ---------------- 18-2 ---------------- */

test('B4-6 18-2：案例 18 两次运镜的读数满分；错位 2 帧以上、少一次、不运镜判不过', () => {
  const q = question('18-2'), ref = reference('18-2');
  const args = argsOf(q, 'narration.timing');
  const size = [64, 36], range = ref.sceneFrames;
  assert.deepEqual(ref.moves.map((move) => move.cue), args.events);
  for (const move of ref.moves) assert.ok(Math.abs(move.cueSec - move.leadSec - move.expectedStartSec) < 1e-9);
  const expected = ref.moves.map((move) => move.expectedStartSec * ref.fps);
  // 每次运镜 45 帧、每帧横移 2 像素；别的时候机位不动
  const film = (starts) => (k) => grayFrame(...size, { dx: -2 * starts.reduce((sum, start) => sum + Math.max(0, Math.min(45, k - start)), 0) });
  const judge = (starts) => score(q, { 'narration.timing': readHits(expected, readMoveStarts(film(starts), range, size, args), range, args.tolFrames) });

  const measured = ref.moves.map((move) => Math.round(move.measuredStartSec * ref.fps));
  assert.deepEqual(measured, [3621, 3915]);
  assert.deepEqual(readMoveStarts(film(measured), range, size, args), measured, '真实指标逐帧量回两次运镜的起点');
  const refHits = readHits(expected, measured, range, args.tolFrames);
  assert.ok(refHits.offsetsFrames.every((offset) => offset < 0.31), JSON.stringify(refHits.offsetsFrames));
  assert.equal(refHits.randomRate, 6 / 619);
  assert.match(q.controls.random, /6\/600/);
  assert.ok(full(judge(measured)), '案例 18 的读数满分');

  for (const shift of [-3, -2, 2, 3, 15]) assert.equal(judge(measured.map((start) => start + shift)).pass, false, `整体错位 ${shift} 帧`);
  assert.equal(judge([measured[0], measured[1] + 3]).pass, false, '只有第二次错位');
  assert.equal(judge([measured[0]]).pass, false, '只做一次运镜');
  assert.equal(judge([]).pass, false, '全程不运镜');
  assert.equal(judge(measured.map((start) => start - 1)).pass, true, '早 1 帧（离应起帧 0.7 帧）还在容差内');

  // 判分线的边界
  const line = (offsetsFrames, randomRate = 0.01) => score(q, { 'narration.timing': { offsetsFrames, hitRate: offsetsFrames.filter((d) => d <= 1).length / 2, randomRate } }).pass;
  assert.equal(line([1, 1]), true);
  assert.equal(line([1, 1.01]), false);
  assert.equal(line([0]), false, '事件数对不上');
  assert.equal(score(q, { 'narration.timing': { offsetsFrames: [0], hitRate: 1, randomRate: 0.01 } }).pass, false, '只交了一个触发点，命中率写满也不过');
  assert.equal(line([0, 0], 0.61), false, '随机基线太高');
});

/* ---------------- 15-2 ---------------- */

test('B4-7 15-2：案例 15 细密画一行的读数满分；缓推、平移、相机矩阵有一帧不同判不过', () => {
  const q = question('15-2'), ref = reference('15-2');
  const args = argsOf(q, 'motion.zoom-pan'), frames = q.deliverable.frames;
  const first = grayFrame(...ref.size);
  // 尾帧 = 首帧照读数变换，再叠上和读数的误差一样大的噪声（均匀噪声全幅是平均绝对值的 4 倍）
  const pair = ({ scale, dx, dy, error }, seed) => [first, grayFrame(...ref.size, { scale, dx, dy, noise: 4 * error, seed })];
  const camera = () => ({ world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 4, 1], proj: [1.3, 0, 0, 0, 0, 2.3, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2, 0] });
  const locked = () => Array.from({ length: frames }, camera);
  const judge = (lock, cameras = locked()) => score(q, { 'motion.zoom-pan': lock, 'meta.camera-static': readCameraStatic(cameras) });

  const refLock = readLock(ref.locked.map(pair), ref.size, args);
  ref.locked.forEach((reading, i) => {
    const { scale, dx, dy, error, stillError } = refLock.pairs[i];
    assert.deepEqual({ scale, dx, dy }, { scale: 1, dx: 0, dy: 0 }, `镜头 ${reading.shot}`);
    assert.equal(error, stillError, '误差等于不动时的误差');
    assert.ok(Math.abs(error - reading.error) <= 0.5, `镜头 ${reading.shot} 造出的误差 ${error} 应在读数 ${reading.error} 上下`);
  });
  assert.deepEqual(readCameraStatic(locked()), { frames, changedAt: null });
  assert.ok(full(judge(refLock)), '案例 15 细密画一行的读数满分');

  // 另外两行读出缓推或平移的五个镜头
  for (const reading of ref.drifting) {
    const lock = readLock([pair(ref.locked[0], 1), pair(reading, 7)], ref.size, args);
    const { scale, dx, dy, error, stillError } = lock.pairs[1];
    assert.ok(scale !== 1 || dx !== 0 || dy !== 0, `${reading.row}${reading.shot} 应量出机位在动`);
    assert.ok(Math.abs(scale - reading.scale) <= 0.025 && Math.abs(dx - reading.dx) <= 1 && Math.abs(dy - reading.dy) <= 1, `${reading.row}${reading.shot} 量回 ${JSON.stringify({ scale, dx, dy })}`);
    assert.ok(error < stillError);
    assert.deepEqual(failed(judge(lock)), ['motion.zoom-pan'], `${reading.row}${reading.shot}`);
    assert.equal(judge(lock).score, 0.5);
  }
  // 只推近不平移
  const pushIn = readLock([pair(ref.locked[0], 1), pair({ scale: 1.05, dx: 0, dy: 0, error: 2 }, 3)], ref.size, args);
  assert.deepEqual({ scale: pushIn.pairs[1].scale, dx: pushIn.pairs[1].dx, dy: pushIn.pairs[1].dy }, { scale: 1.05, dx: 0, dy: 0 });
  assert.deepEqual(failed(judge(pushIn)), ['motion.zoom-pan']);
  assert.deepEqual(failed(judge({ pairs: refLock.pairs.slice(0, 1) })), ['motion.zoom-pan'], '少量了一对帧');

  // 相机矩阵：任何一帧、任何一个分量不同都不过；像素量不出的微漂移靠它拦
  const nudged = (key, index, at) => locked().map((cam, k) => (k === at ? { ...cam, [key]: cam[key].with(index, cam[key][index] + 1e-6) } : cam));
  assert.deepEqual(readCameraStatic(nudged('world', 12, 137)), { frames, changedAt: 137 });
  assert.deepEqual(failed(judge(refLock, nudged('world', 12, 137))), ['meta.camera-static']);
  assert.deepEqual(failed(judge(refLock, nudged('proj', 0, frames - 1))), ['meta.camera-static'], '只有末帧变了焦');
  assert.deepEqual(failed(judge(refLock, locked().slice(1))), ['meta.camera-static'], '少一帧');
  const subPixel = readLock([[first, grayFrame(...ref.size, { dx: 0.3 })], pair(ref.locked[0], 1)], ref.size, args);
  assert.deepEqual(failed(judge(subPixel, nudged('world', 12, 1))), ['meta.camera-static'], '0.3 像素的漂移像素指标读成不动，矩阵核对拦住');
});

/* ---------------- 判分器本身 ---------------- */

test('B4-8 没给读数、读数缺项的题一条都不过', () => {
  for (const id of IDS) {
    const q = question(id);
    assert.deepEqual(score(q, {}), { items: q.scoring.map(({ metric, weight }) => ({ metric, weight, pass: false })), score: 0, pass: false }, id);
    assert.equal(score(q, Object.fromEntries(q.scoring.map(({ metric }) => [metric, {}]))).score, 0, id);
  }
  // 一条判分线都没写的 scoring 不算过；不认识的指标也不算过
  const perfect = { subtitleLagSec: 0, hitRate: 1, randomRate: 0, fadeFramesMedian: 3, offsetsFrames: [0] };
  assert.equal(score({ scoring: [{ metric: 'narration.timing', weight: 1 }] }, { 'narration.timing': perfect }).pass, false);
  assert.equal(score({ scoring: [{ metric: 'narration.timing', args: { fadeFrames: [3, 4] }, weight: 1 }] }, { 'narration.timing': perfect }).pass, true);
  assert.equal(score({ scoring: [{ metric: 'not.registered', weight: 1 }] }, { 'not.registered': perfect }).pass, false);
});
