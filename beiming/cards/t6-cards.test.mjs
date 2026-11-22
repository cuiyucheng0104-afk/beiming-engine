// 讲解片与节奏剪辑的四张卡（time.cut-grid、time.narration、time.narration-est、overlay.subs）的汇总验收：
//   一、卡文件过契约校验和泄露扫描，注册表找得到，参数默认值和例子过卡内的结构定义，每份实现只有一个卡入口；
//   二、拍点网格：切点全部落在 12 帧的网格上，交出的切点条目过事件表契约；
//   三、估时、触发点、字幕在一份原创的合成稿上和参考表逐项相等，交出的命名条目过事件表契约；
//   四、纯函数门（单独求、顺序求、乱序求摘要相同，不改输入）和负向变异（改一个常数必须对不上）；
//   五、外部时间表的核对：短语表没有时从时间表自己反推短语，照样逐项比；这套核对先在合成稿上证明改一处就过不了。
//      设了环境变量 BEIMING_L16_TRUTH_DIR 就拿那个目录里的稿子和时间表再核一遍，没设就跳过；
//   六、非首镜头：帧号是镜头局部帧号时，切点、字幕和这一刻的读数都对着全片帧。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { eventsTable } from '../kernel/eval/input.mjs';
import { stream, streamName } from '../kernel/eval/rng.mjs';
import { createCardRegistry } from './registry.mjs';
import { resolveParams } from './runtime.mjs';
import { dataValidators } from './sweep-schema.mjs';
import { scanCardLeaks, validateCard } from './validate-card.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const T6_CARD_PATHS = [
  ['time.cut-grid', path.join(HERE, 'time/cut-grid/card.json')],
  ['time.narration', path.join(HERE, 'time/narration/card.json')],
  ['time.narration-est', path.join(HERE, 'time/narration-est/card.json')],
  ['overlay.subs', path.join(HERE, 'two-d/overlay-subs/card.json')],
];
// 任务书的表：类别、落点、形状、至少挂着的考题
const T6_SPEC = {
  'time.cut-grid': ['time', 'data', 'evaluate', ['27-1', '23-2']],
  'time.narration': ['time', 'data', 'evaluate', ['18-1', '18-2']],
  'time.narration-est': ['time', 'data', 'evaluate', ['cal:time.narration-est']],
  'overlay.subs': ['two-d', 'comp', 'create', ['18-1', 'cal:overlay.subs']],
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
const multipleOf = (n) => (frame) => frame % n === 0;

// 27-1 式的网格剪辑用例（原创）：30 帧每秒、每分钟 150 拍，一拍正好 12 帧；手排的镜头时长长短不齐（秒），里面有短到不够一拍的
const GRID_SECONDS = [1.9, 0.7, 2.35, 0.45, 1.2, 3.1, 0.2, 0.33, 1.61, 2.02, 0.95, 0.4, 0.38, 2.8, 1.15, 0.05, 2.6];
const GRID_DURATIONS = GRID_SECONDS.map((s) => s * 30);
const GRID_INPUTS = deepFreeze({ fps: '30/1', size: [1280, 720], seed: 2701, shot: { id: 's01', in: 0, frames: 720 } });
const GRID_PARAMS = deepFreeze({ marks: GRID_DURATIONS, marksAre: 'durations', gridFrames: 12, minShotFrames: 12, offsetFrames: 0, startFrame: 0, endFrame: 0 });

// ---------- 一、卡文件 ----------

test('T6-1 四张卡文件存在且全部通过 validateCard 与零泄露检查', () => {
  for (const [expectedId, cardPath] of T6_CARD_PATHS) {
    assert.equal(fs.existsSync(cardPath), true, `缺少卡文件: ${cardPath}`);
    const raw = fs.readFileSync(cardPath, 'utf8');
    const card = JSON.parse(raw);
    assert.equal(card.id, expectedId);
    const res = validateCard(card);
    assert.equal(res.ok, true, `${expectedId} 校验失败: ${JSON.stringify(res)}`);
    assert.deepEqual(res, { ok: true, schemaErrors: [], violations: {}, leaks: [] }, expectedId);
    const dir = path.dirname(cardPath);
    for (const f of fs.readdirSync(dir)) assert.deepEqual(scanCardLeaks(fs.readFileSync(path.join(dir, f), 'utf8')), [], `${expectedId} 的 ${f}`);
  }
  assert.deepEqual(scanCardLeaks(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')), [], '这份测试自己');
});

test('T6-2 time.cut-grid 27-1 切点 100% 是 12 的倍数，且三张旁白/字幕卡导出齐全', async () => {
  const cutGrid = await import('./time/cut-grid/evaluate.mjs');
  const narrationEst = await import('./time/narration-est/evaluate.mjs');
  const narration = await import('./time/narration/evaluate.mjs');
  const subs = await import('./two-d/overlay-subs/comp.mjs');

  assert.equal(typeof (cutGrid.evaluate ?? cutGrid.default), 'function');
  assert.equal(typeof (narrationEst.evaluate ?? narrationEst.default), 'function');
  assert.equal(typeof (narration.evaluate ?? narration.default), 'function');
  assert.ok(typeof subs.buildSubtitles === 'function' || typeof subs.create === 'function' || typeof subs.evaluate === 'function');

  const { frames, end } = cutGrid.evaluate(GRID_INPUTS, GRID_PARAMS, 0, 0).cuts;
  assert.equal(frames.length, GRID_DURATIONS.length - 1);
  assert.ok([...frames, end].every(multipleOf(12)), `有切点不在 12 帧的网格上：${frames}`);
});

test('T6-3 每张卡：类别、落点、形状和任务书一致，入口和自测在卡目录里，状态 reproduced，挂着考题，对外只有一个卡入口', async () => {
  for (const [id, cardPath] of T6_CARD_PATHS) {
    const card = readJson(cardPath), [impl] = card.impl, [kind, livesIn, shape, exams] = T6_SPEC[id], dir = `cards/${path.relative(HERE, path.dirname(cardPath)).split(path.sep).join('/')}`;
    assert.deepEqual([card.kind, card.livesIn, card.impl.length, impl.livesIn, impl.shape, card.visibleToAgent, card.version], [kind, [livesIn], 1, livesIn, shape, true, '1.0.0'], id);
    assert.ok(impl.entry.startsWith(`${dir}/`) && impl.selftest === `${dir}/selftest.test.mjs`, `${id} 的入口和自测在卡目录里`);
    assert.ok(fs.existsSync(path.join(HERE, '..', impl.entry)) && fs.existsSync(path.join(HERE, '..', impl.selftest)), `${id} 的入口和自测文件在`);
    assert.ok(card.status.some((s) => s.level === 'reproduced'), id);
    for (const exam of exams) assert.ok(card.exams.includes(exam), `${id} 挂着 ${exam}`);
    const exported = Object.keys(await import(pathToFileURL(path.join(HERE, '..', impl.entry)))).filter((k) => ['create', 'evaluate'].includes(k));
    assert.deepEqual(exported, [shape], id);
    if (shape === 'evaluate') assert.equal((await import(pathToFileURL(path.join(HERE, '..', impl.entry)))).evaluate.length, 4, `${id} 的入口是 (inputs, params, f, sub)`);
  }
});

test('T6-4 注册表找得到四张卡；参数默认值过得了自己的检查，数据参数的默认值过卡内的结构定义', () => {
  const cards = T6_CARD_PATHS.map(([, p]) => readJson(p)), registry = createCardRegistry(cards, { allowReproduced: true });
  for (const card of cards) {
    assert.equal(registry.getCard(card.id)?.id, card.id);
    assert.equal(registry.getCard(`${card.id}@1`)?.version, '1.0.0');
    const params = resolveParams(card, {});
    assert.deepEqual(Object.keys(params), Object.keys(card.params), card.id);
    for (const [name, check] of dataValidators(card)) assert.equal(check(params[name]), true, `${card.id} 的 ${name}：${JSON.stringify(check.errors)}`);
  }
  for (const card of cards) assert.ok(registry.searchCards({ kind: card.kind, livesIn: card.livesIn[0], q: card.title }).some((c) => c.id === card.id), `按标题搜不到 ${card.id}`);
  assert.deepEqual(registry.searchCards({ livesIn: 'comp' }).map((c) => c.id), ['overlay.subs']);
});

test('T6-5 三份实现里切词的写法逐字相同（卡目录各自成套，不互相引用，所以各带一份）', () => {
  const bodies = ['time/narration-est/evaluate.mjs', 'time/narration/evaluate.mjs', 'two-d/overlay-subs/comp.mjs'].map((f) => /function tokens\(text\) \{[\s\S]*?\n\}/.exec(fs.readFileSync(path.join(HERE, f), 'utf8'))?.[0]);
  assert.ok(bodies[0]?.length > 100);
  assert.deepEqual(bodies, [bodies[0], bodies[0], bodies[0]]);
});

// ---------- 事件表契约的核对 ----------

const contracts = await loadContracts();

/** 照切点和命名事件写一份最小的片子描述：镜头首尾相接，切点就是镜头的起始帧 */
function filmOf(id, fps, frames, cuts, events = []) {
  const bounds = [0, ...cuts, frames];
  return {
    format: 'film/3.0', id, output: { size: [1280, 720], fps, frames },
    shots: bounds.slice(0, -1).map((start, i) => ({ id: `s${String(i + 1).padStart(2, '0')}`, in: start, out: bounds[i + 1], source: 'blender', host: 'cycles', mode: 'cards-data', colorRef: 'scene' })),
    ...(events.length ? { events } : {}),
    style: { view: { scene: 'agx-mhc', display: 'srgb' } }, predicates: { base: ['floor@1'] }, delivery: { master: 'h264-crf14-bt709' },
  };
}

/** 卡交出的事件条目拼成事件表，连同片子描述过事件表契约的结构和 EV 各条，再和求值核自己从片子描述展开的那一份逐项比 */
function assertEventsTable(film, entries) {
  const events = [...entries].sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : 1));
  const table = { format: 'events/0.1', film: film.id, fps: film.output.fps, frames: film.output.frames, events };
  const judged = contracts.validate({ format: 'events-check/0.1', events: table, film });
  assert.deepEqual([judged.contract, judged.schemaErrors, judged.violations], ['events', [], {}], film.id);
  assert.deepEqual(table, eventsTable(film), film.id);
  return table;
}

// ---------- 二、拍点网格 ----------

test('T6-6 time.cut-grid：27-1 式用例的切点 100% 是 12 的整数倍，严格递增、没有零长镜头，同一份输入求两次逐位相同；改了步长就对不上', async () => {
  const { evaluate } = await import('./time/cut-grid/evaluate.mjs');
  const { frames, end, events } = evaluate(GRID_INPUTS, GRID_PARAMS, 0, 0).cuts;
  assert.equal(frames.length, GRID_DURATIONS.length - 1, '镜头一个不少');
  assert.ok([...frames, end].every(multipleOf(12)));
  const bounds = [0, ...frames, end];
  for (let i = 1; i < bounds.length; i++) assert.ok(bounds[i] - bounds[i - 1] >= 12, `第 ${i} 个镜头只有 ${bounds[i] - bounds[i - 1]} 帧`);
  assert.equal(JSON.stringify(evaluate(GRID_INPUTS, GRID_PARAMS, 0, 0)), JSON.stringify(evaluate(GRID_INPUTS, GRID_PARAMS, 0, 0)));
  // 同一组切点改成「想切的位置」再对一次，结果不变；带相位的网格上每个切点和相位同余
  assert.deepEqual(evaluate(GRID_INPUTS, { ...GRID_PARAMS, marks: frames, marksAre: 'cuts', endFrame: end }, 0, 0).cuts.frames, frames);
  assert.ok(evaluate(GRID_INPUTS, { ...GRID_PARAMS, offsetFrames: 5 }, 0, 0).cuts.frames.every((c) => c % 12 === 5));
  // 事件表契约：切点条目和求值核从镜头区间展开的一样
  const table = assertEventsTable(filmOf('f_t6_grid', '30/1', end, frames), events);
  assert.equal(table.events.length, frames.length);
  // 负向变异：步长改成 10，必须有切点不在 12 帧的网格上
  assert.ok(!evaluate(GRID_INPUTS, { ...GRID_PARAMS, gridFrames: 10 }, 0, 0).cuts.frames.every(multipleOf(12)));
});

// ---------- 三、估时、触发点、字幕：合成稿 ----------

// 一份和任何作品无关的气象站合成稿，专门凑边角：连字符、弯引号和弯撇号、带句点的缩写、所有格、两种破折号、叠标点、省略号、
// 引号包住的句点、数字与符号、只有一块字幕的段、没有旁白的段。
const SYN = {
  script: [
    { id: 's01', scene: 'alpha', text: 'Station nine-alpha logs rain; the U.S. gauge — rated “A.P.” class — didn’t drift! Was it luck?! No: it’s careful, well-kept kit—nothing more...' },
    { id: 's02', scene: 'beta', text: 'Probe B.’s reading was 3.7% low, then $4 high. An operator said “stop.” Nobody stopped: the O.K. light — green; steady — stayed on.' },
    { id: 'x03', scene: 'gamma', text: 'End of the synthetic check.' },
    { id: 'sources', holdSec: 6 },
  ],
  // 每块字幕：[显示的字, 起始短语]
  SUBS: {
    s01: [['Station 9-alpha logs rain;', 'station nine alpha'], ['the U.S. gauge didn’t drift!', 'the us gauge'], ['Was it luck?!', 'was it luck'], ['No: careful kit.', 'no it’s careful']],
    s02: [['Probe B’s reading was 3.7% low,', "probe b's reading"], ['then $4 high.', 'then 4 high'], ['An operator said “stop.”', 'an operator said'], ['Nobody stopped:', 'nobody stopped'], ['the O.K. light stayed on.', 'the ok light']],
    x03: [['End of the synthetic check.', 'end of']],
  },
  CUES: {
    s01: { gauge: 'us gauge', ap: 'rated ap', drift: "didn't drift", kit: 'well kept kit', more: 'nothing more' },
    s02: { pct: '3 7 low', stop: 'said stop', ok: 'O.K. light', on: 'stayed on' },
    x03: { end: 'check' },
  },
};
// 参考表：另一份独立写的整数毫秒实现（不是这里的卡）在这份合成稿上算出来的。触发点是离场景起点的秒数，字幕是全片时间。
const SYN_EXPECTED = {
  timeline: {
    fps: 30, duration: 28.92,
    scenes: [
      { id: 'alpha', seg: 's01', start: 0, dur: 10.736, audioStart: 0.55, audioDur: 9.826, cues: { gauge: 2.602, ap: 3.674, drift: 4.736, kit: 8.164, more: 9.19 } },
      { id: 'beta', seg: 's02', start: 10.736, dur: 9.492, audioStart: 11.036, audioDur: 8.832, cues: { pct: 1.548, stop: 4.132, ok: 5.926, on: 8.054 } },
      { id: 'gamma', seg: 'x03', start: 20.228, dur: 2.692, audioStart: 20.528, audioDur: 2.032, cues: { end: 1.512 } },
      { id: 'sources', seg: null, start: 22.92, dur: 6, cues: {} },
    ],
  },
  subs: [
    { start: 0.55, end: 2.284, text: 'Station 9-alpha logs rain;' }, { start: 2.284, end: 5.712, text: 'the U.S. gauge didn’t drift!' },
    { start: 5.712, end: 6.826, text: 'Was it luck?!' }, { start: 6.826, end: 10.626, text: 'No: careful kit.' },
    { start: 11.036, end: 13.034, text: 'Probe B’s reading was 3.7% low,' }, { start: 13.034, end: 14.148, text: 'then $4 high.' },
    { start: 14.148, end: 15.396, text: 'An operator said “stop.”' }, { start: 15.396, end: 16.344, text: 'Nobody stopped:' },
    { start: 16.344, end: 20.118, text: 'the O.K. light stayed on.' }, { start: 20.528, end: 22.81, text: 'End of the synthetic check.' },
  ],
  words: { s01: 24, s02: 23, x03: 5 },
};

const FPS = '30/1';
const INPUTS = deepFreeze({ fps: FPS, size: [1920, 1080], seed: 1801, shot: { id: 's01', in: 0, frames: 868 } });
const cardDefaults = (id) => resolveParams(readJson(T6_CARD_PATHS.find(([name]) => name === id)[1]), {});
const { evaluate: cutGrid } = await import('./time/cut-grid/evaluate.mjs');
const { evaluate: estimate } = await import('./time/narration-est/evaluate.mjs');
const { evaluate: locate } = await import('./time/narration/evaluate.mjs');
const { create: subtitles } = await import('./two-d/overlay-subs/comp.mjs');

/**
 * 三张卡接起来跑一份稿子：估时 → 触发点、字幕。tables 是 { SUBS, CUES }（按段的标识），不给就只估时。
 * 返回各张卡的原始输出，加一份写成参考表那个样子的 { timeline, subs }。mut 是各张卡要改的参数（负向变异用）。
 */
function pipeline(script, tables, mut = {}) {
  const narration = estimate(INPUTS, { ...cardDefaults('time.narration-est'), ...mut.est, script }, 0, 0).narration;
  const sceneOf = (seg) => seg.scene ?? seg.id, spoken = script.filter((seg) => seg.text !== undefined);
  const triggers = tables ? spoken.flatMap((seg) => Object.entries(tables.CUES[seg.id] ?? {}).map(([name, phrase]) => ({ id: `${sceneOf(seg)}-${name}`, scene: sceneOf(seg), phrase }))) : [];
  const blocks = tables ? spoken.flatMap((seg) => (tables.SUBS[seg.id] ?? []).map(([text, phrase]) => ({ scene: sceneOf(seg), text, phrase }))) : [];
  const cues = locate(INPUTS, { ...cardDefaults('time.narration'), timing: narration, triggers }, 0, 0).cues;
  const handle = tables ? subtitles({ size: INPUTS.size, fps: FPS }, { ...cardDefaults('overlay.subs'), ...mut.subs, timing: narration, blocks }) : null;
  const timeline = {
    fps: 30, duration: narration.durationSec,
    scenes: narration.scenes.map((s) => ({
      id: s.scene, seg: s.seg, start: s.startSec, dur: s.durSec, ...(s.seg === null ? {} : { audioStart: s.audioStartSec, audioDur: s.audioDurSec }),
      cues: Object.fromEntries(cues.list.filter((c) => c.scene === s.scene).map((c) => [c.id.slice(s.scene.length + 1), c.sceneSec])),
    })),
  };
  return { narration, triggers, blocks, cues, handle, timeline, subs: handle?.object.table.map((r) => ({ start: r.startSec, end: r.endSec, text: r.text })) ?? [] };
}

test('T6-7 估时、触发点、字幕在合成稿上和参考表逐项精确相等：4 个场景、10 个触发点、10 块字幕、52 个词', () => {
  const run = pipeline(SYN.script, SYN);
  assert.deepStrictEqual(run.timeline, SYN_EXPECTED.timeline);
  assert.deepStrictEqual(run.subs, SYN_EXPECTED.subs);
  assert.deepEqual(Object.fromEntries(SYN.script.slice(0, 3).map((seg) => [seg.id, run.narration.words.filter((w) => w.scene === seg.scene).length])), SYN_EXPECTED.words);
  assert.deepEqual([run.cues.list.length, run.subs.length, run.narration.words.length, run.narration.frames], [10, 10, 52, 868]);
  // 稿子、触发点、字幕分块和估时的输出都过卡内的结构定义
  const valid = (id, values) => { for (const [name, check] of dataValidators(readJson(T6_CARD_PATHS.find(([n]) => n === id)[1]))) assert.equal(check(values[name]), true, `${id} 的 ${name}：${JSON.stringify(check.errors)}`); };
  valid('time.narration-est', { script: SYN.script });
  valid('time.narration', { timing: run.narration, triggers: run.triggers });
  valid('overlay.subs', { timing: run.narration, blocks: run.blocks });
});

test('T6-8 字幕时间表：帧号由秒数定，同场景首尾相接，相邻不重叠、不越出所属场景；文字框在画面里；每帧最多一块', () => {
  const { handle, narration } = pipeline(SYN.script, SYN), table = handle.object.table;
  table.forEach((row, i) => {
    const scene = narration.scenes.find((s) => s.scene === row.scene), next = table[i + 1];
    assert.deepEqual([row.index, row.startFrame, row.endFrame], [i, Math.round(row.startSec * 30), Math.round(row.endSec * 30)]);
    assert.ok(row.startSec < row.endSec && row.startFrame < row.endFrame, row.text);
    assert.ok(scene.startSec <= row.startSec && row.endSec <= scene.startSec + scene.durSec && scene.startFrame <= row.startFrame && row.endFrame <= scene.endFrame, `${row.text} 越出了场景 ${row.scene}`);
    if (next) assert.ok(row.endSec <= next.startSec && row.endFrame <= next.startFrame, `${row.text} 和下一块重叠`);
    if (next?.scene === row.scene) assert.equal(row.endSec, next.startSec);
    const [x0, y0, x1, y1] = row.bbox;
    assert.ok(0 <= x0 && x0 < x1 && x1 <= 1920 && 0 <= y0 && y0 < y1 && y1 <= 1080 && Math.abs(x0 + x1 - 1920) < 1e-9, row.text);
  });
  const shown = Array.from({ length: narration.frames }, (_, f) => handle.meta(f).texts);
  assert.ok(shown.every((texts) => texts.length <= 1));
  table.forEach((row) => assert.equal(shown.filter((texts) => texts[0]?.id === `sub-${row.index}`).length, row.endFrame - row.startFrame, row.text));
  assert.deepEqual([shown[16], shown[17]], [[], [{ id: 'sub-0', text: table[0].text, bbox2d: table[0].bbox }]]);
  assert.equal(handle.object.ass().split('\n').filter((l) => l.startsWith('Dialogue:')).length, 10);
});

test('T6-9 合成稿的触发点和场景切点拼成事件表，过事件表契约，和求值核从片子描述展开的逐项相同', () => {
  const { narration, cues } = pipeline(SYN.script, SYN), cuts = narration.scenes.slice(1).map((s) => s.startFrame);
  for (const c of cues.list) assert.equal(c.frame, Math.round(c.sec * 30), c.id);
  const film = filmOf('f_t6_syn', FPS, narration.frames, cuts, cues.list.map((c) => ({ id: c.id, frame: c.frame })));
  const table = assertEventsTable(film, [...cues.events, ...cuts.map((frame) => ({ id: `cut.${frame}`, frame, sub: 0, kind: 'cut', from: 'film' }))]);
  assert.equal(table.events.length, 13);
});

// ---------- 四、纯函数门和负向变异 ----------

/** 用命名随机流打乱；打乱后和原来一样就再来 */
function shuffled(list, s) {
  const out = [...list];
  do {
    for (let i = out.length - 1; i > 0; i--) { const j = s.u32() % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  } while (out.length > 1 && out.every((v, i) => v === list[i]));
  return out;
}
// 第 78 帧是触发点 alpha-gauge（0.55 秒起的场景里 2.602 秒），第 322 帧是第一个场景切点
const MOMENTS = [{ f: 0, sub: 0 }, { f: 17, sub: 0 }, { f: 17, sub: 0.5 }, { f: 78, sub: 0 }, { f: 78, sub: 0.25 }, { f: 322, sub: 0 }, { f: 700, sub: 0.75 }];

test('T6-10 纯函数门：三张数据卡同一个时刻单独求、顺序求、乱序求摘要相同，不改传进去的输入和参数；字幕卡先问别的帧再回来结果相同', () => {
  const base = pipeline(SYN.script, SYN);
  const gates = {
    'time.cut-grid': [cutGrid, GRID_INPUTS, GRID_PARAMS],
    'time.narration-est': [estimate, INPUTS, deepFreeze({ ...cardDefaults('time.narration-est'), script: structuredClone(SYN.script) })],
    'time.narration': [locate, INPUTS, deepFreeze({ ...cardDefaults('time.narration'), timing: structuredClone(base.narration), triggers: structuredClone(base.triggers) })],
  };
  for (const [id, [evaluate, inputs, params]] of Object.entries(gates)) {
    const digest = (m) => sha(JSON.stringify(evaluate(inputs, params, m.f, m.sub)));
    const single = MOMENTS.map((m) => digest(m)), sequential = MOMENTS.map((m) => digest(m));
    const again = shuffled(MOMENTS, stream(streamName(1801, 't6', `gate/${id}`))).map((m) => [MOMENTS.indexOf(m), digest(m)]);
    assert.deepEqual(sequential, single, id);
    for (const [i, d] of again) assert.equal(d, single[i], `${id} f=${MOMENTS[i].f} sub=${MOMENTS[i].sub}`);
    assert.ok(new Set(single).size > 1, `${id} 随时刻变`);
  }
  const params = deepFreeze({ ...cardDefaults('overlay.subs'), timing: structuredClone(base.narration), blocks: structuredClone(base.blocks) });
  const one = subtitles({ size: INPUTS.size, fps: FPS }, params), two = subtitles({ size: INPUTS.size, fps: FPS }, params);
  assert.equal(JSON.stringify(one.object.table), JSON.stringify(two.object.table));
  assert.equal(one.object.ass(), two.object.ass());
  const frames = MOMENTS.map((m) => m.f), first = frames.map((f) => JSON.stringify(one.meta(f)));
  for (const f of shuffled(frames, stream(streamName(1801, 't6', 'gate/overlay.subs')))) assert.equal(JSON.stringify(one.meta(f)), first[frames.indexOf(f)], `overlay.subs f=${f}`);
  assert.ok(new Set(first).size > 1, 'overlay.subs 随帧变');
});

test('T6-11 负向变异：每字母、句末停顿、字幕提前量各改一毫秒级的量，结果必须和参考表对不上；短语不在稿子里必须报错', () => {
  const differs = (mut, key) => assert.notDeepStrictEqual(pipeline(SYN.script, SYN, mut)[key], SYN_EXPECTED[key]);
  differs({ est: { letterSec: 0.037 } }, 'timeline');
  differs({ est: { stopSec: 0.33 } }, 'timeline');
  differs({ est: { letterCap: 8 } }, 'timeline');
  differs({ subs: { earlySec: 0.05 } }, 'subs');
  differs({ subs: { holdSec: 0.24 } }, 'subs');
  // 字幕提前量不改估时：只动字幕这一侧的时候场景和触发点原样
  assert.deepStrictEqual(pipeline(SYN.script, SYN, { subs: { earlySec: 0.05 } }).timeline, SYN_EXPECTED.timeline);
  const missing = (tables) => assert.throws(() => pipeline(SYN.script, tables), (e) => e.code === 'contract.bad-value');
  missing({ ...SYN, CUES: { ...SYN.CUES, x03: { end: 'snowfall' } } });
  missing({ ...SYN, SUBS: { ...SYN.SUBS, x03: [['End.', 'the very end']] } });
});

// ---------- 五、可选的外部对拍 ----------

// 目录里要有 tts_request.json（{ segments: [{ id, text }] }）、timeline.json、subs.json；另有 tables.json（{ SUBS, CUES }，写法同上面的 SYN）时
// 短语照它的。目录的位置和里面的内容都不进仓库。
const msOf = (sec) => Math.round(sec * 1000);

/**
 * 拿一套外部的稿子和时间表核三张卡：场景起止、每个触发点、每块字幕的字和起止，逐项相等。
 * 没有 tables 时短语从时间表自己反推：字幕拿它显示的字当起始短语；触发点先要求同一个场景里按写的次序时间不往回走、
 * 正好落在估出来的某个词的起点上，再从那个词起往后接词、接到这几个词在场景里头一回出现就是这儿为止，当它的短语交给触发点卡。
 * 接到场景末尾还不是头一回出现的（整段重复的稿子）只核到「落在词的起点上」。返回核了几个触发点、几块字幕。
 */
function assertTruth(request, timeline, subs, tables) {
  const segScene = Object.fromEntries(timeline.scenes.filter((s) => s.seg !== null).map((s) => [s.seg, s.id]));
  const script = [...request.segments.map((seg) => ({ id: seg.id, scene: segScene[seg.id], text: seg.text })), ...timeline.scenes.filter((s) => s.seg === null).map((s) => ({ id: s.id, holdSec: s.dur }))];
  const bare = (t) => ({ fps: t.fps, duration: t.duration, scenes: t.scenes.map(({ cues, ...scene }) => scene) });
  const est = pipeline(script, null);
  assert.deepStrictEqual(bare(est.timeline), bare(timeline), '场景起止、配音起止、全片时长');
  const derived = { SUBS: {}, CUES: {} };
  for (const scene of est.narration.scenes.filter((sc) => sc.seg !== null)) {
    const from = msOf(scene.startSec), words = est.narration.words.filter((w) => w.scene === scene.scene), truth = timeline.scenes.find((sc) => sc.id === scene.scene);
    derived.SUBS[scene.seg] = subs.filter((b) => from <= msOf(b.start) && msOf(b.start) < from + msOf(scene.durSec)).map((b) => [b.text, b.text]);
    derived.CUES[scene.seg] = {};
    let prev = 0;
    for (const [name, at] of Object.entries(truth.cues)) {
      assert.ok(msOf(at) >= prev, `场景 ${scene.scene} 的触发点 ${name} 比它前面的触发点还早`);
      prev = msOf(at);
      const i = words.findIndex((w) => msOf(w.startSec) === from + msOf(at));
      assert.ok(i >= 0, `场景 ${scene.scene} 的触发点 ${name} 不在词的起点上`);
      const firstAt = (n) => words.findIndex((_, j) => words.slice(i, i + n).every((w, k) => words[j + k]?.word === w.word));
      let n = 1;
      while (firstAt(n) !== i && i + n < words.length) n++;
      if (firstAt(n) === i) derived.CUES[scene.seg][name] = words.slice(i, i + n).map((w) => w.word).join(' ');
    }
  }
  const used = tables ?? derived, run = pipeline(script, used);
  for (const scene of timeline.scenes) {
    const mine = run.timeline.scenes.find((sc) => sc.id === scene.id).cues;
    assert.deepStrictEqual(mine, tables ? scene.cues : Object.fromEntries(Object.entries(scene.cues).filter(([name]) => name in mine)), `场景 ${scene.id} 的触发点`);
  }
  assert.deepStrictEqual(run.subs, subs.map((b) => ({ start: b.start, end: b.end, text: b.text })), '字幕的字和起止');
  return { cues: run.cues.list.length, subs: run.subs.length };
}

test('T6-12 外部时间表的核对自己先过一遍：合成稿上有没有短语表都逐项相等；对调触发点、挪一毫秒、改字幕的字、少一块字幕都必须过不了', () => {
  const request = { segments: SYN.script.filter((seg) => seg.text !== undefined).map(({ id, text }) => ({ id, text })) }, timeline = SYN_EXPECTED.timeline;
  assert.deepEqual(assertTruth(request, timeline, SYN_EXPECTED.subs, SYN), { cues: 10, subs: 10 });
  // 没有短语表：参考表的字幕显示的字和旁白不是一回事（9-alpha 对 nine-alpha），拿每块的起始短语当显示的字，另排一份
  const phraseAsText = { ...SYN, SUBS: Object.fromEntries(Object.entries(SYN.SUBS).map(([seg, rows]) => [seg, rows.map(([, phrase]) => [phrase, phrase])])) };
  const subs = pipeline(SYN.script, phraseAsText).subs;
  assert.deepEqual(subs.map((b) => [b.start, b.end]), SYN_EXPECTED.subs.map((b) => [b.start, b.end]));
  assert.deepEqual(assertTruth(request, timeline, subs, null), { cues: 10, subs: 10 });
  const fails = (what, tl, sb) => assert.throws(() => assertTruth(request, tl, sb, null), (e) => e.code === 'ERR_ASSERTION' || e.code === 'contract.bad-value', what);
  const withCues = (edit) => ({ ...timeline, scenes: timeline.scenes.map((sc, i) => (i === 0 ? { ...sc, cues: edit(sc.cues) } : sc)) });
  fails('对调两个触发点的时间', withCues((c) => ({ ...c, gauge: c.ap, ap: c.gauge })), subs);
  fails('触发点挪一毫秒', withCues((c) => ({ ...c, drift: c.drift + 0.001 })), subs);
  fails('触发点挪到下一个词', withCues((c) => ({ ...c, more: 9.5 })), subs);
  fails('字幕换了一个稿子里没有的词', timeline, subs.map((b, i) => (i === 3 ? { ...b, text: 'no it’s careless' } : b)));
  fails('字幕换成稿子里别处的词', timeline, subs.map((b, i) => (i === 2 ? { ...b, text: 'luck' } : b)));
  fails('字幕的结束挪一毫秒', timeline, subs.map((b, i) => (i === 5 ? { ...b, end: b.end + 0.001 } : b)));
  // 少的是中间的一块：前一块就该一直停到再下一块。少场景里的头一块看不出来，那样的表自己也说得通
  fails('少中间的一块字幕', timeline, subs.filter((_, i) => i !== 1));
  fails('场景起点挪一毫秒', { ...timeline, scenes: timeline.scenes.map((sc, i) => (i === 1 ? { ...sc, start: sc.start + 0.001 } : sc)) }, subs);
});

const TRUTH = process.env.BEIMING_L16_TRUTH_DIR;
const truthSkip = TRUTH && fs.existsSync(TRUTH) ? false : '没有设 BEIMING_L16_TRUTH_DIR（或目录不在）：只核了合成稿';

test('T6-13 外部对拍：BEIMING_L16_TRUTH_DIR 里的稿子上，场景起止、每个触发点、每块字幕的字和起止都和那里的时间表逐项相等', { skip: truthSkip }, () => {
  const read = (name) => readJson(path.join(TRUTH, name)), timeline = read('timeline.json'), subs = read('subs.json');
  const done = assertTruth(read('tts_request.json'), timeline, subs, fs.existsSync(path.join(TRUTH, 'tables.json')) ? read('tables.json') : null);
  assert.ok(done.subs === subs.length && done.subs > 0 && done.cues > 0, `核了 ${done.cues} 个触发点、${done.subs} 块字幕`);
});

// ---------- 六、非首镜头 ----------

test('T6-14 非首镜头（从第 96 帧起）：拍点卡的局部切点交成全片帧号、过事件表契约，局部第 12 帧正好到切点；字幕卡 meta(0) 是全片第 96 帧', () => {
  const shot = { id: 's02', in: 96, frames: 120 }, at = (f) => cutGrid({ ...GRID_INPUTS, shot }, { ...GRID_PARAMS, marks: [12, 50], marksAre: 'cuts' }, f, 0).cuts;
  assert.deepEqual([at(0).frames, at(0).sinceFrames, at(12).shot, at(12).sinceFrames, at(12).untilFrames], [[108, 144], 0, 1, 0, 36]);
  assertEventsTable(filmOf('f_t6_shot2', '30/1', 216, [96, ...at(0).frames]), [{ id: 'cut.96', frame: 96, sub: 0, kind: 'cut', from: 'film' }, ...at(0).events]);
  assert.throws(() => cutGrid(GRID_INPUTS, { ...GRID_PARAMS, gridFrames: 0 }, 0, 0), (e) => e.code === 'usage.bad-argument');
  const { narration, blocks } = pipeline(SYN.script, SYN), params = { ...cardDefaults('overlay.subs'), timing: narration, blocks };
  const whole = subtitles({ size: INPUTS.size, fps: FPS }, params), second = subtitles({ size: INPUTS.size, fps: FPS, shot }, params);
  assert.deepEqual(second.object.table, whole.object.table);
  for (const f of [0, 75, 120]) assert.deepEqual(second.meta(f), whole.meta(96 + f), `f=${f}`);
  assert.equal(second.meta(0).texts[0].id, 'sub-1');
  // 估时卡：第 2 个场景从第 322 帧起，镜头从那一帧起时 f = 0 就在第 2 个场景里
  const est = (inShot, f) => estimate({ ...INPUTS, shot: { id: 's02', in: inShot, frames: 100 } }, { ...cardDefaults('time.narration-est'), script: SYN.script }, f, 0).narration;
  assert.deepEqual([est(322, 0).scenes[1].startFrame, est(322, 0).at.scene, est(0, 321).at.scene], [322, 'beta', 'alpha']);
});

test('T6-15 同一帧的触发点 id 一个是 U+E000、一个是 U+10000：交出的命名条目不用再排就过事件表契约的次序检查', () => {
  const { narration } = pipeline(SYN.script, null), ids = ['\u{10000}', '\u{E000}', 'z'];
  const cues = locate(INPUTS, { ...cardDefaults('time.narration'), timing: narration, triggers: ids.map((id) => ({ id, scene: 'gamma', phrase: 'check' })) }, 0, 0).cues;
  assert.deepEqual(cues.events.map((e) => e.id), ['z', '\u{E000}', '\u{10000}']);
  // 片子描述里的事件 id 只让写小写字母、数字、连字符，这两个 id 进不了片子描述；事件表自己的结构不拦，所以单拿事件表过契约
  const judge = (events) => contracts.validate({ format: 'events/0.1', film: 'f_t6_cp', fps: FPS, frames: narration.frames, events });
  assert.deepEqual([judge(cues.events).schemaErrors, judge(cues.events).violations], [[], {}]);
  assert.deepEqual(Object.keys(judge([...cues.events].sort((x, y) => (x.id < y.id ? -1 : 1))).violations), ['EV1'], '按 UTF-16 码元排就过不了');
});

test('T6-16 估时：多留的段前留白跟着 id 是 s01 的段，调换段序后各段自己的时长不变；自己切的字幕遇到超长的词硬切，每块不超过 maxChars', () => {
  const [a, b] = SYN.script, lead = (script) => pipeline(script, null).narration.scenes.map((sc) => [sc.seg, msOf(sc.audioStartSec - sc.startSec), msOf(sc.durSec)]);
  assert.deepEqual(lead([a, b]), [['s01', 550, 10736], ['s02', 300, 9492]]);
  assert.deepEqual(lead([b, a]), [['s02', 300, 9492], ['s01', 550, 10736]]);
  const narration = pipeline([{ id: 's01', text: `Short ${'x'.repeat(43)} words follow here.` }], null).narration;
  const table = subtitles({ size: INPUTS.size, fps: FPS }, { ...cardDefaults('overlay.subs'), timing: narration, blocks: [] }).object.table;
  assert.ok(table.length >= 2 && table.every((r) => [...r.text].length <= 42), JSON.stringify(table.map((r) => r.text)));
  assert.equal(table.map((r) => r.text).join(' ').replaceAll(' ', ''), `short${'x'.repeat(43)}wordsfollowhere`);
});
