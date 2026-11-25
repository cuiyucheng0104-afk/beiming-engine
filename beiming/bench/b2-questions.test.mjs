// B2：一级 4 道考题（29-1、28-1、23-1、01-1）契约校验与参考片/原作反例自动判分核验
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateAssertion, registered } from '../verify/predicates.mjs';
import { projectPublicQuestion, scanQuestionLeaks, validateQuestion } from './index.mjs';
import { argsOf, readClosure, readFraming, readLayout, readMaster, readNearest, readPixelBoxes, score } from './questions/level-1/evaluate-b2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEVEL = join(HERE, 'questions/level-1'), REFS = join(HERE, 'refs/level-1');
// 文件名照规划文档的题号；01-1 文件里的 id 是 1-1：冻结的题号写法不带前导零（题目文件契约 5.1）
const IDS = { '29-1': '29-1', '28-1': '28-1', '23-1': '23-1', '01-1': '1-1' };
const rawOf = (name) => readFileSync(join(LEVEL, `${name}.json`), 'utf8');
const question = (name) => JSON.parse(rawOf(name));
const ref = (name) => JSON.parse(readFileSync(join(REFS, `${name}.json`), 'utf8'));
const failed = (verdict) => verdict.items.filter((item) => !item.pass).map((item) => item.metric);
/** 一份判定的四个结论：[得分, 判分项全过, 基础门, 整题合格] */
const marks = (verdict) => [verdict.score, verdict.scoringPass, verdict.basePass, verdict.pass];
/** 题目的交付规格写成成片读回的样子（和 deliver.spec 读数同一种写法） */
const specOf = ({ deliverable: { size, fps, frames, audio } }) => {
  const [num, den] = fps.split('/').map(Number);
  return { width: size[0], height: size[1], fps: num / den, frames, audioChannels: { none: 0, stereo: 2 }[audio] };
};
/** 合成片的基础门证据：规格照题面，基础谓词按构造都成立。取景、环绕这几条谓词本版 verify 还判不了，这里顶替它的判定 */
const built = (q, predicates = {}) => ({ spec: specOf(q), predicates: { ...Object.fromEntries(q.basePredicates.map((text) => [text, 'pass'])), ...predicates } });

/** 合成帧：先铺底色，再依次画矩形 [x0, y0, x1, y1, [r, g, b]] */
function paint(width, height, bg, rects = []) {
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1, color] of [[0, 0, width, height, bg], ...rects]) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set(color, (y * width + x) * 4);
  }
  return { width, height, rgba };
}

test('B2-1 一级 4 道考题文件存在且原文与对象均通过 B1 validateQuestion（0 错误、0 违反、0 泄露）', () => {
  const expected = {
    '29-1': { size: [1080, 1350], fps: '30/1', frames: 600, audio: 'none', needs: ['layout.panels', 'deliver.encode'] },
    '28-1': { size: [1920, 824], fps: '24/1', frames: 288, audio: 'none', needs: ['camera.orbit', 'camera.fit', 'deliver.encode'] },
    '23-1': { size: [720, 1080], fps: '24/1', frames: 72, audio: 'none', needs: ['camera.orbit', 'deliver.encode'] },
    '01-1': { size: [1920, 1080], fps: '30/1', frames: 1104, audio: 'stereo', needs: ['deliver.encode', 'audio.master'] },
  };
  for (const [name, id] of Object.entries(IDS)) {
    const file = join(LEVEL, `${name}.json`);
    assert.ok(existsSync(file), `缺少题目文件: ${file}`);
    const raw = rawOf(name);
    for (const input of [raw, JSON.parse(raw)]) {
      const verdict = validateQuestion(input);
      assert.deepEqual(verdict, { ok: true, schemaErrors: [], violations: {}, leaks: [] }, `${name} 校验未过: ${JSON.stringify(verdict)}`);
    }
    const pub = projectPublicQuestion(JSON.parse(raw));
    assert.equal(pub.id, id);
    assert.equal(pub.level, 1);
    const { needs, ...deliverable } = expected[name];
    assert.deepEqual(pub.deliverable, deliverable);
    assert.deepEqual(pub.needs, needs);
    assert.equal(pub.scoring.reduce((sum, item) => sum + item.weight, 0), 1, `${name} 权重和不是 1`);
    assert.equal(pub.calibration.status, 'calibrated');
    assert.equal(pub.calibration.version, 1);
    assert.ok(typeof pub.calibration.noiseFloor === 'number' && Number.isFinite(pub.calibration.noiseFloor) && pub.calibration.noiseFloor >= 0);
    for (const text of pub.basePredicates) assert.ok(registered(text.match(/^[A-Za-z_.]+/)[0]), `${name} 的 ${text} 没登记`);
    // 参考都指向仓库里脱敏的读数夹具（相对 beiming/）
    assert.ok(pub.refs.length > 0);
    for (const path of pub.refs) assert.ok(existsSync(join(HERE, '..', path)), `${name} 的参考 ${path} 不存在`);
  }
  assert.equal(question('28-1').assets.subject, 'calib/mech-head-proxy@1');
});

// 原作关联的品牌、型号、片名词元的 sha256 前 16 位：词本身不入库，免得这份测试自己带专名
const NAME_HASHES = new Set(['8c6e8e8b9a0eb983', 'c5165083befc92b4', '8d4321d936320802', '60eb33388f4e0888', '3cb95ec0c6cc1835',
  'f60ed56a9c827589', '13d00b4f50b002bf', '50b2676afbe30c83', '3f8f01ea269b6cfe']);
const digest = (word) => createHash('sha256').update(word).digest('hex').slice(0, 16);
/** 文字拆成小写的字母段和数字段（驼峰先拆开），回单段和相邻两段连写里命中专名的个数 */
function nameHits(text) {
  const words = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]+|[0-9]+/g) ?? [];
  return new Set(words.flatMap((word, i) => [word, word + (words[i + 1] ?? '')]).filter((gram) => NAME_HASHES.has(digest(gram)))).size;
}

test('B2-2 B2 新增的全部文件不带商业专名；题目与读数夹具另不带私有路径和原包文件名', () => {
  const inDir = (dir) => readdirSync(dir).map((name) => join(dir, name));
  const data = [...inDir(LEVEL), ...inDir(REFS)].filter((file) => file.endsWith('.json'));
  assert.equal(data.length, 8);
  for (const file of data) {
    const text = readFileSync(file, 'utf8');
    assert.deepEqual(scanQuestionLeaks(text), [], file);
    assert.doesNotMatch(text, /\.mp4|[0-9a-f]{16}/i, file);
  }
  // 题目、夹具、判分辅助和这份测试自己
  const added = [...inDir(LEVEL), ...inDir(REFS), fileURLToPath(import.meta.url)];
  assert.equal(added.length, 10);
  for (const file of added) assert.equal(nameHits(readFileSync(file, 'utf8')), 0, `${file} 带专名`);
  // 查法自己要查得出：摘要算得对，登记过的词连写、驼峰、夹在标点里都认得
  assert.equal(digest('beiming'), '0cfcb0e49ddfc211');
  NAME_HASHES.add(digest('beiming')).add(digest('beiming86'));
  try {
    for (const text of ['北冥 Beiming 引擎', 'x-beiming_y', 'BEIMING', 'kunBeiming', 'beiming-86', 'Beiming86']) assert.ok(nameHits(text) > 0, text);
    assert.equal(nameHits('beimings beimin 北冥'), 0);
  } finally { NAME_HASHES.delete(digest('beiming')); NAME_HASHES.delete(digest('beiming86')); }
});

test('B2-3 29-1：参考片读数满分；合成版式过真实 layoutEdges 满分，上下左右任何一条边界偏 1 像素或分隔线偏色判不过', () => {
  const q = question('29-1'), args = argsOf(q, 'layout.edges');
  const fixture = ref('29-1-reference');
  const measured = fixture.readings['layout.edges'];
  assert.deepEqual([measured.edgeErrorsPx, measured.sideErrorsPx], [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]);
  assert.ok(measured.lineColorError <= 4);
  // 读数满分。整题合格另要过基础门：作者原文件带立体声（题面不要声音），又是没有每帧元数据的视频，基础谓词都没判过，如实不算合格
  const reference = score(q, fixture.readings);
  assert.deepEqual(marks(reference), [1, true, false, false]);
  assert.deepEqual(reference.items, [{ metric: 'layout.edges', weight: 0.5, pass: true }, { metric: 'layout.edges', weight: 0.5, pass: true }]);
  assert.deepEqual(reference.base.map((check) => check.pass), Array(1 + q.basePredicates.length).fill(false));

  const bg = [9, 9, 6], panel = [128, 110, 90], wide = [0, 1080];
  const layout = ({ top = [44, 652], bottom = [698, 1306], line = [673, 677], color = [0xCB, 0xFB, 0x03], topX = wide, bottomX = wide, lineX = wide } = {}) => ({ base: built(q),
    'layout.edges': readLayout(paint(1080, 1350, bg, [[topX[0], top[0], topX[1], top[1], panel], [bottomX[0], bottom[0], bottomX[1], bottom[1], panel], [lineX[0], line[0], lineX[1], line[1], color]]), args, q.deliverable.size) });
  const exact = layout();
  assert.deepEqual(exact['layout.edges'], { bands: [[44, 652], [673, 677], [698, 1306]], edgeErrorsPx: [0, 0, 0, 0, 0, 0], sideErrorsPx: [0, 0, 0, 0, 0, 0], lineColorError: 0 });
  assert.deepEqual(marks(score(q, exact)), [1, true, true, true]);
  // 线色差正好 4 级还过，5 级不过
  assert.equal(score(q, layout({ color: [0xCB, 0xFB - 4, 0x03 + 4] })).score, 1);
  const tinted = score(q, layout({ color: [0xCB, 0xFB - 5, 0x03] }));
  assert.deepEqual([tinted.pass, tinted.score], [false, 0.5]);
  // 每条上下沿各偏 1 像素
  for (const shifted of [{ top: [45, 652] }, { top: [44, 651] }, { top: [45, 653] }, { bottom: [697, 1306] }, { bottom: [698, 1307] }, { line: [672, 676] }, { line: [673, 678] }]) {
    const verdict = score(q, layout(shifted));
    assert.equal(verdict.pass, false, JSON.stringify(shifted));
    assert.equal(verdict.items[0].pass, false, JSON.stringify(shifted));
  }
  // 一审反例：左右沿。面板左沿右移 1 像素（宽 1079）、右沿缩 1 像素、只剩半宽 540、居中半宽，分隔线不通栏
  assert.deepEqual(layout({ topX: [1, 1080] })['layout.edges'].sideErrorsPx, [1, 0, 0, 0, 0, 0]);
  assert.deepEqual(layout({ bottomX: [0, 540] })['layout.edges'].sideErrorsPx, [0, 0, 0, 0, 0, 540]);
  for (const narrowed of [{ topX: [1, 1080] }, { bottomX: [1, 1080] }, { topX: [1, 1080], bottomX: [1, 1080] }, { topX: [0, 1079] }, { bottomX: [0, 1079] },
    { topX: [0, 540], bottomX: [0, 540] }, { topX: [270, 810] }, { lineX: [1, 1080] }, { lineX: [0, 1079] }]) {
    const verdict = score(q, layout(narrowed));
    assert.deepEqual([verdict.pass, verdict.items[0].pass], [false, false], JSON.stringify(narrowed));
  }
  // 少一段（没画分隔线）
  assert.equal(score(q, layout({ line: [673, 673] })).score, 0);
  // 画面尺寸和题面不一样（矮了、窄了 1 像素、宽了）：行号和通栏的右沿对不上，量不了
  for (const [width, height] of [[1080, 600], [1079, 1350], [1081, 1350], [1080, 1351]]) {
    const off = readLayout(paint(width, height, bg), args, q.deliverable.size);
    assert.deepEqual(off, { bands: null, edgeErrorsPx: null, sideErrorsPx: null, lineColorError: null }, `${width}×${height}`);
    assert.equal(score(q, { base: built(q), 'layout.edges': off }).score, 0);
  }
  assert.equal(score(q, {}).score, 0);
  // 二审反例：边界读数给了却不成形（空洞数组、字符串、带多余属性、伪数组、槽数不对、槽里是负数或不是数），整份读数作废：
  // 整题 0 分，线色量得再准也不给分，也不抛。数组成形只是偏了 1 像素、或者没量出来（null），只有边界那一项不过，线色照常给分
  const reading = exact['layout.edges'];
  const edgesWith = (key, value) => score(q, { ...exact, 'layout.edges': { ...reading, [key]: value } });
  for (const key of ['edgeErrorsPx', 'sideErrorsPx']) {
    for (const bad of [Array(6), '000000', Object.assign([0, 0, 0, 0, 0, 0], { ok: true }), Object.assign([0, 0, 0, 0, 0, 0], { [Symbol('ok')]: 1 }), { length: 6 }, { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, length: 6 },
      [0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [], [0, 0, 0, 0, 0, -1], [0, 0, 0, 0, 0, NaN], [0, 0, 0, 0, 0, Infinity], [0, 0, 0, 0, 0, null], [0, 0, 0, 0, 0, '0'], [0, 0, 0, , 0, 0], 0, true, {}]) {
      const verdict = edgesWith(key, bad);
      assert.deepEqual([verdict.malformed, verdict.items.map((item) => item.pass), ...marks(verdict)], [true, [false, false], 0, false, true, false], `${key} ${JSON.stringify(bad)}`);
    }
    for (const off of [[0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0.5], null, undefined]) {
      const verdict = edgesWith(key, off);
      assert.deepEqual([verdict.malformed, verdict.items.map((item) => item.pass), ...marks(verdict)], [false, [false, true], 0.5, false, true, false], `${key} ${JSON.stringify(off)}`);
    }
  }
  assert.equal(score(q, exact).malformed, false);
  // 三审反例：边界数组有个槽位是取值器（一取就抛，或者回个合格的 0），原来只算边界那一项不过，线色照拿 0.5 分。
  // 成不成形只看属性描述，取值器一次都不调：槽位、读数的一栏、整项读数、基础门里，凡是取值器、不可枚举的属性、连描述都取不出来的代理，整份读数作废
  let calls = 0;
  const getters = [() => { calls += 1; throw new TypeError('取不到'); }, () => { calls += 1; return 0; }];
  const refuse = () => { throw new TypeError('取不到'); };
  const zeros = () => [0, 0, 0, 0, 0, 0];
  const voided = (readings, label) => {
    const verdict = score(q, readings);
    assert.deepEqual([verdict.malformed, verdict.items.map((item) => item.pass), verdict.score, verdict.scoringPass, verdict.pass], [true, [false, false], 0, false, false], label);
    return verdict;
  };
  const revoked = Proxy.revocable(zeros(), {});
  revoked.revoke();
  for (const key of ['edgeErrorsPx', 'sideErrorsPx']) {
    const withList = (list) => ({ ...exact, 'layout.edges': { ...reading, [key]: list } });
    for (const [n, get] of getters.entries()) {
      for (const slot of [0, 2, 5]) {
        // 基础门的证据是另一栏，照常判
        assert.equal(voided(withList(Object.defineProperty(zeros(), slot, { get, enumerable: true })), `${key} 第 ${slot} 槽是取值器 ${n}`).basePass, true);
      }
      voided({ ...exact, 'layout.edges': Object.defineProperty({ ...reading }, key, { get, enumerable: true }) }, `${key} 这一栏是取值器 ${n}`);
    }
    voided(withList(Object.defineProperty(zeros(), 2, { value: 0, enumerable: false })), `${key} 第 2 槽不可枚举`);
    voided(withList(new Proxy(zeros(), { getOwnPropertyDescriptor: refuse })), `${key} 取不出属性描述的代理`);
    voided(withList(new Proxy(zeros(), { ownKeys: refuse })), `${key} 列不出键的代理`);
    voided(withList(revoked.proxy), `${key} 撤销了的代理`);
    voided({ ...exact, 'layout.edges': Object.defineProperty({ ...reading }, key, { value: zeros(), enumerable: false }) }, `${key} 这一栏不可枚举`);
  }
  for (const [n, get] of getters.entries()) {
    voided(Object.defineProperty({ ...exact }, 'layout.edges', { get, enumerable: true }), `整项读数是取值器 ${n}`);
    assert.equal(voided(Object.defineProperty({ ...exact }, 'base', { get, enumerable: true }), `基础门证据是取值器 ${n}`).basePass, false);
    assert.equal(voided({ ...exact, base: Object.defineProperty({ ...exact.base }, 'spec', { get, enumerable: true }) }, `基础门的规格是取值器 ${n}`).basePass, false);
  }
  assert.equal(calls, 0);
  for (const bad of [null, undefined, NaN, '1', -1, 5]) {
    assert.deepEqual(score(q, { ...exact, 'layout.edges': { ...reading, lineColorError: bad } }).items.map((item) => item.pass), [true, false], String(bad));
  }
});

test('B2-4 28-1：原作读数判不过（289 帧高度全超 70%，首尾 27.7 dB 低于相邻帧 37.6 dB 减 1 dB）；合规的合成环绕过真实指标满分', () => {
  const q = question('28-1');
  const original = ref('28-1-negative');
  const framing = original.readings['meta.bbox-limits'], closure = original.readings['loop.closure-psnr'];
  assert.equal(framing.frames, 289);
  assert.ok(framing.minH > 0.70 && original.violatingFrames.maxH === 289);
  assert.ok(Math.abs(closure.closurePsnr - 27.7) < 0.05 && Math.abs(closure.adjacentPsnr - 37.6) < 0.05);
  assert.ok(closure.closurePsnr < closure.adjacentPsnr - 1);
  const negative = score(q, original.readings);
  assert.deepEqual(marks(negative), [0, false, false, false]);
  assert.deepEqual(negative.items, [
    { metric: 'meta.bbox-limits', weight: 0.5, pass: false }, { metric: 'loop.closure-psnr', weight: 0.3, pass: false }, { metric: 'pixel.bbox', weight: 0.2, pass: false }]);

  // 合成环绕：头是一块深色矩形，宽随角度变，里面一条亮带随角度左右摆；首尾对称
  const W = 1920, H = 824, grey = [110, 108, 108];
  const boxAt = (k, height = 560) => {
    const angle = 2 * Math.PI * k / 288, half = Math.round(300 + 50 * Math.cos(angle));
    return [960 - half, (H - height) / 2, 960 + half, (H + height) / 2];
  };
  const frameAt = (k, box = boxAt(k)) => {
    const stripe = 960 + Math.round(200 * Math.sin(2 * Math.PI * k / 288));
    return paint(W, H, grey, [[...box, [30, 30, 40]], [stripe - 20, box[1] + 40, stripe + 20, box[3] - 40, [200, 180, 160]]]);
  };
  const boxes = Array.from({ length: 288 }, (_, k) => boxAt(k));
  const samples = [0, 72, 144, 216].map((k) => ({ frame: frameAt(k), box: boxes[k] }));
  const good = {
    base: built(q),
    'meta.bbox-limits': readFraming(boxes, [W, H]),
    'loop.closure-psnr': readClosure(frameAt(0), frameAt(287), frameAt(1)),
    'pixel.bbox': readPixelBoxes(samples, '#6E6C6C', 16),
  };
  const but = (metric, patch) => score(q, { ...good, [metric]: { ...good[metric], ...patch } });
  assert.equal(good['meta.bbox-limits'].frames, 288);
  assert.equal(good['pixel.bbox'].maxDiffPx, 0);
  const verdict = score(q, good);
  assert.deepEqual(marks(verdict), [1, true, true, true]);
  assert.deepEqual(verdict.items, [
    { metric: 'meta.bbox-limits', weight: 0.5, pass: true }, { metric: 'loop.closure-psnr', weight: 0.3, pass: true }, { metric: 'pixel.bbox', weight: 0.2, pass: true }]);
  // 头太高（高 600 像素，占 72.8%）：只有取景那一项不过
  assert.deepEqual(failed(score(q, { ...good, 'meta.bbox-limits': readFraming(boxes.map((_, k) => boxAt(k, 600)), [W, H]) })), ['meta.bbox-limits']);
  // 只转了半圈：末帧对不上第 0 帧
  assert.deepEqual(failed(score(q, { ...good, 'loop.closure-psnr': readClosure(frameAt(0), frameAt(144), frameAt(1)) })), ['loop.closure-psnr']);
  // 元数据说谎：报的包围盒每边比画面里的小 20 像素
  const lying = samples.map(({ frame, box }) => ({ frame, box: [box[0] + 20, box[1] + 20, box[2] - 20, box[3] - 20] }));
  assert.deepEqual(failed(score(q, { ...good, 'pixel.bbox': readPixelBoxes(lying, '#6E6C6C', 16) })), ['pixel.bbox']);

  // 一审反例：题面要 100% 的帧，只给 1 帧、少 1 帧、多 1 帧的包围盒都不算
  for (const count of [1, 287, 289]) {
    const partial = readFraming(Array.from({ length: count }, (_, k) => boxAt(k % 288)), [W, H]);
    assert.equal(partial.frames, count);
    assert.deepEqual(failed(score(q, { ...good, 'meta.bbox-limits': partial })), ['meta.bbox-limits'], String(count));
  }
  // 一审反例：缺测的读数不当成 0 来比
  for (const key of ['frames', 'maxW', 'maxH', 'minMarginLr', 'minMarginTb']) {
    for (const bad of [null, undefined, NaN, '0.1']) assert.deepEqual(failed(but('meta.bbox-limits', { [key]: bad })), ['meta.bbox-limits'], `${key} ${bad}`);
  }
  for (const patch of [{ closurePsnr: null, adjacentPsnr: null }, { closurePsnr: null }, { adjacentPsnr: null }, { closurePsnr: undefined }, { closurePsnr: NaN }, { adjacentPsnr: '30' }, { closurePsnr: -Infinity }, { closurePsnr: -1e9, adjacentPsnr: -1e9 }]) {
    assert.deepEqual(failed(but('loop.closure-psnr', patch)), ['loop.closure-psnr'], JSON.stringify(patch));
  }
  for (const bad of [null, undefined, NaN, '0', -1, 9]) assert.deepEqual(failed(but('pixel.bbox', { maxDiffPx: bad })), ['pixel.bbox'], String(bad));
  assert.deepEqual(readPixelBoxes([], '#6E6C6C', 16), { maxDiffPx: null });
  // 包围盒不成形（空盒、出画、左右颠倒、不是数、整条没有）：这份取景读数作废
  for (const box of [[960, 412, 960, 412], [-10, 100, 500, 600], [0, 0, 1921, 500], [500, 100, 100, 600], [100, NaN, 500, 600], [100, null, 500, 600], '1234', null]) {
    const broken = readFraming(boxes.with(5, box), [W, H]);
    assert.deepEqual([broken.frames, broken.maxW, broken.maxH, broken.minMarginLr, broken.minMarginTb], [288, null, null, null, null], JSON.stringify(box));
    assert.deepEqual(failed(score(q, { ...good, 'meta.bbox-limits': broken })), ['meta.bbox-limits'], JSON.stringify(box));
  }
  for (const none of [[], Array(288), null]) assert.deepEqual(failed(score(q, { ...good, 'meta.bbox-limits': readFraming(none, [W, H]) })), ['meta.bbox-limits']);

  // 基础门：没给证据、规格对不上、有一条基础谓词没过或没判，得分照旧是 1，整题不合格
  const { base } = good;
  const unjudged = { ...base.predicates };
  delete unjudged['no_cut @ all'];
  for (const weak of [undefined, null, 'pass', {}, { spec: base.spec }, { predicates: base.predicates }, { ...base, spec: { ...base.spec, frames: 287 } }, { ...base, spec: { ...base.spec, audioChannels: 2 } },
    { ...base, predicates: unjudged }, built(q, { 'no_cut @ all': 'fail' }), built(q, { 'bbox_h(subject) <= 0.70 @ all': 'skipped' }), built(q, { 'no_cut @ all': true })]) {
    assert.deepEqual(marks(score(q, { ...good, base: weak })), [1, true, false, false], JSON.stringify(weak));
  }
  assert.deepEqual(score(q, { ...good, base: built(q, { 'no_cut @ all': 'fail' }) }).base.filter((check) => !check.pass), [{ check: 'no_cut @ all', pass: false }]);
  assert.deepEqual(score(q, { ...good, base: { ...base, spec: { ...base.spec, frames: 287 } } }).base.filter((check) => !check.pass), [{ check: 'deliverable', pass: false }]);
});

test('B2-5 23-1：72 帧与 60 帧两条参考转台读数满分；合成转台过真实 loopClosurePsnr 满分，少转、多转、末帧跳开判不过', () => {
  const q = question('23-1');
  const fixture = ref('23-1-reference');
  // 读数满分，规格也对得上；总角度和无切点两条基础谓词在没有相机元数据的视频上没判过，整题如实不算合格
  const reference = score(q, fixture.readings);
  assert.deepEqual(marks(reference), [1, true, false, false]);
  assert.deepEqual(reference.items, [{ metric: 'loop.closure-psnr', weight: 0.5, pass: true }, { metric: 'loop.closure-psnr', weight: 0.5, pass: true }]);
  assert.deepEqual(reference.base, [{ check: 'deliverable', pass: true }, ...q.basePredicates.map((check) => ({ check, pass: false }))]);
  // 头部转台：同一套判分，帧号按 60 帧换算
  const [head] = fixture.variants;
  const q60 = structuredClone(q);
  Object.assign(q60.deliverable, head.deliverable);
  Object.assign(q60.scoring[0].args, { search: [30, 60], expect: 59 });
  q60.scoring[1].args.b = 59;
  assert.equal(validateQuestion(q60).ok, true);
  const variant = score(q60, head.readings);
  assert.deepEqual([variant.score, variant.scoringPass, variant.base[0]], [1, true, { check: 'deliverable', pass: true }]);
  // 72 帧的题拿 60 帧的读数来判：最像的帧不是第 71 帧
  assert.equal(score(q, head.readings).scoringPass, false);

  // 合成转台：一条横向正弦条纹，相位就是转过的角度
  const turn = (degrees) => {
    const rgba = new Uint8Array(64 * 8 * 4).fill(255);
    for (let i = 0; i < 64 * 8; i++) rgba.fill(Math.round(128 + 100 * Math.sin(2 * Math.PI * (i % 64) / 64 + degrees * Math.PI / 180)), i * 4, i * 4 + 3);
    return { width: 64, height: 8, rgba };
  };
  const measure = (frameAt) => ({ base: built(q),
    'loop.closure-psnr': { ...readNearest(frameAt, argsOf(q, 'loop.closure-psnr').search), ...readClosure(frameAt(0), frameAt(71), frameAt(1)) } });
  const passes = (readings) => score(q, readings).items.map((item) => item.pass);
  const sweep = (total) => (k) => turn(k * total / 72);
  const loop = measure(sweep(360));
  assert.equal(loop['loop.closure-psnr'].nearest, 71);
  assert.deepEqual(marks(score(q, loop)), [1, true, true, true]);
  // 少转到 350°：末帧离第 0 帧约 15°，是相邻帧差的 3 倍
  const under = score(q, measure(sweep(350)));
  assert.deepEqual([under.pass, under.items.map((item) => item.pass)], [false, [true, false]]);
  // 多转到 370°：最像第 0 帧的成了第 70 帧
  const over = score(q, measure(sweep(370)));
  assert.deepEqual([over.pass, over.items.map((item) => item.pass)], [false, [false, true]]);
  // 末帧跳到半圈处
  assert.equal(score(q, measure((k) => (k === 71 ? turn(180) : turn(k * 5)))).score, 0);

  // 一审反例：第 0、1、71 帧的灰度是 0、10、11，别的帧 220。首尾差正好是相邻差的 1.1 倍，在线上，过；12 就不过
  const flat = (level) => paint(8, 8, [level, level, level]);
  const edge = (last) => measure((k) => flat(k === 0 ? 0 : k === 1 ? 10 : k === 71 ? last : 220));
  assert.equal(edge(11)['loop.closure-psnr'].nearest, 71);
  assert.deepEqual(marks(score(q, edge(11))), [1, true, true, true]);
  assert.deepEqual(passes(edge(10)), [true, true]);
  assert.deepEqual(passes(edge(12)), [true, false]);
  // 末帧和第 0 帧逐像素相同：PSNR 是正无穷，是量出来的数，照常比
  const same = measure((k) => turn(k === 71 ? 0 : k * 5));
  assert.equal(same['loop.closure-psnr'].closurePsnr, Infinity);
  assert.deepEqual(passes(same), [true, true]);
  // 一审反例：PSNR 或最像的帧号缺测，不得满分
  const reading = loop['loop.closure-psnr'];
  for (const patch of [{ closurePsnr: null, adjacentPsnr: null }, { closurePsnr: null }, { adjacentPsnr: null }, { adjacentPsnr: undefined }, { closurePsnr: NaN }, { closurePsnr: '30' }, { adjacentPsnr: -Infinity }, { closurePsnr: -1e9, adjacentPsnr: -1e9 }]) {
    assert.deepEqual(passes({ ...loop, 'loop.closure-psnr': { ...reading, ...patch } }), [true, false], JSON.stringify(patch));
  }
  for (const bad of [null, undefined, '71', 70, 71.5]) assert.deepEqual(passes({ ...loop, 'loop.closure-psnr': { ...reading, nearest: bad } }), [false, true], String(bad));
});

/** 01-1 的三条基础谓词本版 verify 判得了：读数换成 verify 的量测写法，交真的 evaluateAssertion 逐条判 */
function judged(q, readings) {
  const spec = readings['deliver.spec'] ?? {}, audio = readings['audio.loudness'] ?? {}, frames = readings['frame.black-freeze-dup'] ?? {};
  const tags = new Set(['color_space', 'color_transfer', 'color_primaries'].map((tag) => spec[tag]));
  const measured = {
    output: { size: [spec.width, spec.height], fps: `${spec.fps}/1`, frames: spec.frames, colorTag: tags.size === 1 ? [...tags][0] : null },
    // 读数里只有数目没有帧号：是 0 才给得出空表；不是 0 就不给，delivery 判不过
    blackFrames: frames.blackFrames === 0 ? [] : null,
    freezes: frames.freezeSegments === 0 ? [] : null,
    audio: { loudnessLufs: audio.lufs, truePeakDbtp: audio.truePeakDbtp },
  };
  const { size, fps, frames: total } = q.deliverable;
  return { spec, predicates: Object.fromEntries(q.basePredicates.map((text) => [text, evaluateAssertion(text, { output: { size, fps, frames: total } }, measured).status])) };
}
const ITEMS_01 = (spec, loudness, frames) => [
  { metric: 'deliver.spec', weight: 0.25, pass: spec }, { metric: 'audio.loudness', weight: 0.5, pass: loudness }, { metric: 'frame.black-freeze-dup', weight: 0.25, pass: frames }];

test('B2-6 01-1：重制片终版读回满分且整题合格；缺色彩标签、单声道、响度超差、真峰值超标、带黑帧的读数都判不过', () => {
  const q = question('01-1');
  const fixture = ref('01-1-reference');
  assert.equal(q.id, fixture.question);
  const judge = (readings) => score(q, { ...readings, base: judged(q, readings) });
  // 基础谓词由 verify 逐条判过，整题合格
  assert.deepEqual(judge(fixture.readings), { id: '1-1', score: 1, pass: true, basePass: true, scoringPass: true, malformed: false,
    base: [{ check: 'deliverable', pass: true }, ...q.basePredicates.map((check) => ({ check, pass: true }))], items: ITEMS_01(true, true, true) });
  // 夹具里只有读回的规格，基础谓词没判：满分，不算合格
  assert.deepEqual(marks(score(q, fixture.readings)), [1, true, false, false]);
  const mutate = (metric, patch) => judge({ ...fixture.readings, [metric]: { ...fixture.readings[metric], ...patch } });
  const { preview } = fixture;
  // 预演版的读回记录：三样各自判不过
  assert.deepEqual(failed(mutate('deliver.spec', Object.fromEntries(preview.missingColorTags.map((tag) => [tag, null])))), ['deliver.spec']);
  assert.deepEqual(failed(mutate('audio.loudness', preview['audio.loudness'])), ['audio.loudness']);
  assert.deepEqual(failed(mutate('frame.black-freeze-dup', { blackFrames: preview.blackFrames.length })), ['frame.black-freeze-dup']);
  for (const [metric, patch] of [
    ['deliver.spec', { color_space: 'bt470bg' }], ['deliver.spec', { frames: 1103 }], ['deliver.spec', { fps: 29.97 }], ['deliver.spec', { width: 1280, height: 720 }],
    // 一审反例：题面要立体声，单声道、没有音轨、没读声道数都不算
    ['deliver.spec', { audioChannels: 1 }], ['deliver.spec', { audioChannels: 0 }], ['deliver.spec', { audioChannels: 6 }], ['deliver.spec', { audioChannels: undefined }], ['deliver.spec', { audioChannels: '2' }],
    ['audio.loudness', { lufs: -13.4 }], ['audio.loudness', { lufs: -14.6 }], ['audio.loudness', { lufs: -Infinity }], ['audio.loudness', { truePeakDbtp: -0.9 }],
    ['audio.loudness', { lufs: null }], ['audio.loudness', { lufs: NaN }], ['audio.loudness', { lufs: '-14' }], ['audio.loudness', { truePeakDbtp: null }], ['audio.loudness', { truePeakDbtp: undefined }],
    ['frame.black-freeze-dup', { freezeSegments: 1 }], ['frame.black-freeze-dup', { duplicateFrames: 1 }], ['frame.black-freeze-dup', { blackFrames: null }], ['frame.black-freeze-dup', { duplicateFrames: undefined }],
  ]) {
    const verdict = mutate(metric, patch);
    assert.deepEqual([failed(verdict), verdict.pass, verdict.score < 1], [[metric], false, true], JSON.stringify(patch));
  }
  // 基础谓词跟着读数走：单声道规格对不上，响度超差那条谓词不过
  assert.deepEqual(mutate('deliver.spec', { audioChannels: 1 }).base.filter((check) => !check.pass), [{ check: 'deliverable', pass: false }]);
  assert.deepEqual(mutate('audio.loudness', { lufs: -13.4 }).base.filter((check) => !check.pass), [{ check: 'loudness(film) in [-14.5, -13.5]', pass: false }]);
  // 线上的值还过
  assert.equal(mutate('audio.loudness', { lufs: -14.5, truePeakDbtp: -1 }).pass, true);
  assert.equal(mutate('audio.loudness', { lufs: -13.5 }).pass, true);
});

test('B2-7 01-1：合成成片过真实 deliverSpec、audioLoudness、blackFreezeDup 满分；不带标签、过响、开头一秒黑场的成片三项都判不过，单声道和没有音轨的成片也判不过', async (t) => {
  if (['ffmpeg', 'ffprobe'].some((tool) => spawnSync(tool, ['-version']).error?.code === 'ENOENT')) return t.skip('环境缺少音视频工具');
  // 同一套判分线，画面缩到 64×36：1104 帧的 1080p 逐帧量要几十秒
  const q = question('01-1');
  q.deliverable.size = [64, 36];
  q.basePredicates[0] = 'delivery(width=64, height=36, fps=30, frames=1104)';
  const dir = mkdtempSync(join(tmpdir(), 'b2-'));
  // audio 是每个声道的正弦幅度：两个数是立体声，一个数是单声道，空的不带音轨
  const encode = (name, video, audio, tags) => {
    const file = join(dir, name);
    const sound = audio.length ? ['-f', 'lavfi', '-i', `aevalsrc=${audio.map((amplitude) => `${amplitude}*sin(2*PI*997*t)`).join('|')}:s=48000:d=36.8`] : [];
    const build = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', video, ...sound,
      '-frames:v', '1104', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...tags, ...(audio.length ? ['-c:a', 'alac'] : []), file]);
    assert.equal(build.status, 0, build.stderr.toString());
    return file;
  };
  const read = async (...clip) => {
    const readings = await readMaster(encode(...clip), argsOf(q, 'frame.black-freeze-dup'));
    return { ...readings, base: judged(q, readings) };
  };
  try {
    // 三项标签要另经 x264 参数写进码流，只给 ffmpeg 的输出选项读回来缺传递函数和原色（案例 01 预演版踩过）
    const bt709 = ['-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
    // 横向正弦条纹每帧挪 4°：每一帧都在动，没有重复帧
    const moving = "color=gray:s=64x36:r=30:d=36.8,geq=lum='128+100*sin(2*PI*(X/W+N/90))':cb=128:cr=128";
    // 两个声道同相的 997 Hz 正弦，幅度 −14 dBFS，响度就是 −14 LUFS
    const good = await read('good.mp4', moving, [0.1995, 0.1995], bt709);
    assert.deepEqual([good.hasAudio, good['deliver.spec'].hasAudio, good['deliver.spec'].audioChannels], [true, true, 2]);
    const verdict = score(q, good);
    assert.deepEqual([marks(verdict), verdict.items], [[1, true, true, true], ITEMS_01(true, true, true)], JSON.stringify(good));
    const bad = await read('bad.mp4', `${moving},drawbox=w=iw:h=ih:color=black:t=fill:enable='lt(n,30)'`, [0.95, 0.95], []);
    const rejected = score(q, bad);
    assert.deepEqual([marks(rejected), rejected.items], [[0, false, false, false], ITEMS_01(false, false, false)], JSON.stringify(bad));
    assert.equal(bad['deliver.spec'].frames, 1104);
    assert.equal(bad['frame.black-freeze-dup'].blackFrames, 30);
    // 一审反例：单声道。一个声道 −11 dBFS 的正弦响度也是 −14 LUFS，别的都合规，只差声道数
    const mono = await read('mono.mp4', moving, [0.2818], bt709);
    assert.deepEqual([mono.hasAudio, mono['deliver.spec'].hasAudio, mono['deliver.spec'].audioChannels], [true, true, 1]);
    assert.ok(Math.abs(mono['audio.loudness'].lufs + 14) <= 0.5 && mono['audio.loudness'].truePeakDbtp <= -1, JSON.stringify(mono));
    const single = score(q, mono);
    assert.deepEqual([marks(single), single.items], [[0.75, false, false, false], ITEMS_01(false, true, true)], JSON.stringify(mono));
    // 一审、二审反例：没有音轨。读数照常回来，hasAudio 明写 false，声音两项是空的，不抛
    const silent = await read('silent.mp4', moving, [], bt709);
    assert.equal(silent.hasAudio, false);
    assert.deepEqual([silent['deliver.spec'].hasAudio, silent['deliver.spec'].audioChannels], [false, 0]);
    assert.deepEqual(silent['audio.loudness'], { lufs: null, truePeakDbtp: null });
    const mute = score(q, silent);
    assert.deepEqual([marks(mute), mute.items], [[0.25, false, false, false], ITEMS_01(false, false, true)], JSON.stringify(silent));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B2-8 读数整份不成形（空、不是对象）时四道题都回 0 分不合格，不抛', () => {
  for (const name of Object.keys(IDS)) {
    const q = question(name);
    for (const bad of [null, undefined, 0, 42, 'readings', true, [], () => ({})]) {
      const verdict = score(q, bad);
      assert.deepEqual(marks(verdict), [0, false, false, false], `${name} ${String(bad)}`);
      assert.deepEqual([verdict.id, verdict.items.length, verdict.base.length], [IDS[name], q.scoring.length, 1 + q.basePredicates.length]);
    }
    // 每项读数自己不成形、读数是继承来的、取读数时出错，也一样
    const thrower = { get() { throw new TypeError('取不到'); }, enumerable: true };
    const keys = ['base', ...q.scoring.map((item) => item.metric)];
    for (const bad of [null, 1, 'x', [], true]) {
      assert.deepEqual(marks(score(q, Object.fromEntries(keys.map((key) => [key, bad])))), [0, false, false, false], `${name} ${String(bad)}`);
    }
    const full = Object.fromEntries(keys.map((key) => [key, key === 'base' ? built(q) : {}]));
    assert.deepEqual(marks(score(q, Object.create(full))), [0, false, false, false], name);
    const trapped = score(q, Object.defineProperties({}, Object.fromEntries(keys.map((key) => [key, thrower]))));
    assert.deepEqual([...marks(trapped), trapped.malformed], [0, false, false, false, true], name);
  }
});

test('B2-9 score 的第一个参数给题号也行（01-1 和 1-1 是同一道题），判出来和给题目对象一样；题号不认识、给的不是题目，回 0 分不合格，不抛', () => {
  const fixtures = { '29-1': '29-1-reference', '28-1': '28-1-negative', '23-1': '23-1-reference', '01-1': '01-1-reference' };
  for (const [name, id] of Object.entries(IDS)) {
    const q = question(name), { readings } = ref(fixtures[name]);
    for (const key of new Set([name, id])) {
      // 二审反例：score('29-1', null)、score('1-1', null) 原来在取 scoring 时抛 TypeError
      for (const bad of [null, undefined, 0, 'readings', []]) {
        const verdict = score(key, bad);
        assert.deepEqual([...marks(verdict), verdict.malformed], [0, false, false, false, false], `${key} ${String(bad)}`);
        assert.deepEqual([verdict.id, verdict.items.length, verdict.base.length], [id, q.scoring.length, 1 + q.basePredicates.length], key);
      }
      assert.deepEqual(score(key, readings), score(q, readings), key);
    }
    assert.equal(score(name, readings).score, name === '28-1' ? 0 : 1, name);
  }
  // 认不出题目：id 是 null，一项都不列
  const none = { id: null, score: 0, pass: false, basePass: false, scoringPass: false, malformed: false, base: [], items: [] };
  const { readings } = ref('29-1-reference');
  for (const bad of ['99-9', '', '29-1 ', '29-1.json', '../level-1/29-1', '__proto__', 'constructor', 'toString', null, undefined, 291, 1.1, true, [], ['29-1'], {}, { id: '29-1' }, { scoring: null, basePredicates: [] },
    { scoring: [null], basePredicates: [] }, { scoring: [{ metric: 'layout.edges', weight: 1 }] }, () => question('29-1'), new String('29-1')]) {
    for (const given of [readings, null]) assert.deepEqual(score(bad, given), none, `${String(bad)} ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(score(), none);
  // 三审反例：过不了 validateQuestion 的题目对象不判。只有交付规格、scoring 是空数组的对象，原来空数组上的 every 回 true，凭成片规格相符就整题合格
  const master = question('01-1');
  const hollow = { deliverable: master.deliverable, scoring: [], basePredicates: [] };
  assert.equal(validateQuestion(hollow).ok, false);
  assert.deepEqual(score(hollow, { base: { spec: specOf(master) } }), none);
  for (const [name, fixture] of Object.entries(fixtures)) {
    const q = question(name), full = { ...ref(fixture).readings, base: built(q) };
    const { id, ...anonymous } = q;
    const invalid = { 'scoring 是空数组': { ...q, scoring: [] }, '没有题号': anonymous, '多一个字段': { ...q, extra: 1 }, '权重和不是 1': { ...q, scoring: q.scoring.map((item) => ({ ...item, weight: item.weight / 2 })) },
      '谓词没登记': { ...q, basePredicates: [...q.basePredicates, 'no.such.predicate == 1'] }, 'scoring 是取值器': Object.defineProperty({ ...q }, 'scoring', { get: () => q.scoring, enumerable: true }) };
    for (const [label, bad] of Object.entries(invalid)) {
      assert.equal(validateQuestion(bad).ok, false, `${id} ${label}`);
      for (const given of [full, null]) assert.deepEqual(score(bad, given), none, `${id} ${label}`);
    }
    // 代理：描述照实给（校验看的是描述），取值时把 scoring 说成空的，或者把基础谓词说成一条都没有。抄不成普通数据的题目也不判
    for (const [field, lie] of [['scoring', []], ['basePredicates', []]]) {
      const lying = new Proxy(q, { get: (target, key) => (key === field ? lie : target[key]) });
      for (const given of [full, null]) assert.deepEqual(score(lying, given), none, `${id} 代理谎报 ${field}`);
    }
    assert.notDeepEqual(score(q, full), none, id);
  }
});
