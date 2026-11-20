import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, estimateTokens, withinBudget, margins, severity, entityFlags,
  buildContactSheet, buildCutStrips, collectCuts, encodePng, decodePng, pngSize, drawLabel, compactFrames,
  SUMMARY_TOKEN_LIMIT } from './index.mjs';

import { syncBuiltinESMExports } from 'node:module';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import full from '../kernel/contracts/meta/examples/full.json' with { type: 'json' };
import legacy from '../kernel/contracts/meta/examples/legacy-page.json' with { type: 'json' };
import envelope from '../kernel/contracts/envelope/examples/error-unknown-key.json' with { type: 'json' };

const { validate } = await loadContracts();
function assertContract(value, contract) {
  assert.deepEqual(validate(value), { contract, schemaErrors: [], violations: {} });
  return value;
}
const W = 1920, H = 1080;
function entity(name, bbox2d, extra = {}) {
  const ix = Math.max(0, Math.min(W, bbox2d[2]) - Math.max(0, bbox2d[0]));
  const iy = Math.max(0, Math.min(H, bbox2d[3]) - Math.max(0, bbox2d[1]));
  return { id: extra.id ?? 1, name, class: 'part', bbox2d, visible: extra.role ? 1 : null, pxArea: (ix * iy) / (W * H), ...extra };
}
function meta(frame, entities, extra = {}) {
  return assertContract({ ...structuredClone(entities === null ? legacy : full), frame, shotFrame: frame, entities, lights: [],
    events: [], texts: [], colorRef: 'display', hash: extra.stats === null ? { color: null } : full.hash,
    stats: { luma: { p1: 0.01, p50: 0.2, p99: 0.9 }, clipHigh: 0.001, clipLow: 0.002, noise: null, tris: null }, ...extra }, 'meta');
}
function entityRows(result) {
  if (result.entityGroups) return result.entityGroups.flatMap(({ names, ...row }) => names.map(name => ({ ...row, name })));
  return result.entities.map(row => ({ ...result.values?.[row.valueIndex], ...row }));
}
const fits400 = (obj) => {
  const s = JSON.stringify(obj);
  return estimateTokens(s) <= 400 && s.length <= 1400;
};

// 35 个实体：5 个出画、4 个可见度低、3 个屏占过小，其余 23 个正常；正常的排在前面，用来确认排序真的把异常顶上去
function crowd() {
  const list = [];
  for (let i = 0; i < 23; i++) list.push(entity(`crowd.normal_${String(i).padStart(2, '0')}_with_a_long_descriptive_name`, [100 + i * 10, 100, 300 + i * 10, 300], { id: 100 + i, bbox3d: [0, 0, 0, 1, 1, 1], depth: [2, 3] }));
  for (let i = 0; i < 3; i++) list.push(entity(`crowd.tiny_${i}`, [900, 500, 910 + i, 510], { id: 200 + i }));
  for (let i = 0; i < 4; i++) list.push(entity(`crowd.hidden_${i}`, [500, 500, 700, 700], { id: 300 + i, role: 'mustSee', visible: 0.2 }));
  for (let i = 0; i < 5; i++) list.push(entity(`crowd.out_${i}`, [-50 - i, 400, 200, 600], { id: 400 + i }));
  return list;
}

test('estimateTokens 按 UTF-8 字节除以 3.5 向上取整', () => {
  assert.equal(estimateTokens('abcdefg'), 2);
  assert.equal(estimateTokens('中'), 1);
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('x'.repeat(8)), 3);
  assert.equal(estimateTokens('x'.repeat(1400)), 400);
  assert.equal(estimateTokens('中'.repeat(467)), 401);
  assert.equal(withinBudget('x'.repeat(1400)), true);
  assert.equal(withinBudget('x'.repeat(1401)), false);
});

test('边距按左上右下归一化，伸出画面为负', () => {
  assert.deepEqual(margins([192, 108, 1728, 972], [W, H]), [0.1, 0.1, 0.1, 0.1]);
  assert.ok(margins([-96, 0, 100, 100], [W, H])[0] < 0);
});

test('异常严重度：出画 > 可见度低 > 屏占过小 > 正常', () => {
  assert.equal(severity(entityFlags(entity('a', [-1, 0, 10, 10], { visible: 0.1 }), [W, H])), 3);
  assert.equal(severity(entityFlags(entity('a', [0, 0, 500, 500], { visible: 0.1 }), [W, H])), 2);
  assert.equal(severity(entityFlags(entity('a', [0, 0, 2, 2]), [W, H])), 1);
  assert.equal(severity(entityFlags(entity('a', [0, 0, 500, 500]), [W, H])), 0);
});

test('entities：单帧回答边距、包围盒、屏占、可见比例、三维盒、深度', () => {
  const hero = entity('kit', [192, 108, 1728, 972], { role: 'hero', bbox3d: [-0.17, 0, -0.07, 0.17, 0.14, 0.07], depth: [2.81, 3.16], visible: 0.9 });
  const r = query([meta(10, [hero])], { type: 'entities' });
  assert.equal(r.ok, true);
  assert.equal(r.frame, 10);
  assert.equal(r.totalEntities, 1);
  assert.equal(r.truncated, false);
  const [e] = r.entities;
  assert.deepEqual(e.margins, [0.1, 0.1, 0.1, 0.1]);
  assert.deepEqual(e.bbox2d, [192, 108, 1728, 972]);
  assert.deepEqual(e.depth, [2.81, 3.16]);
  assert.deepEqual(e.bbox3d, [-0.17, 0, -0.07, 0.17, 0.14, 0.07]);
  assert.equal(e.visible, 0.9);
  assert.equal(e.pxArea, 0.64);
  assert.equal(e.role, 'hero');
});

test('entities：35 个实体先保留全部 12 个异常再填正常，并标截断', () => {
  const r = query([meta(0, crowd())], { type: 'entities' });
  assert.equal(r.ok, true);
  assert.equal(r.totalEntities, 35);
  assert.equal(r.truncated, true);
  assert.equal(r.anomalies, 12);
  assert.ok(r.returnedEntities >= 12 && r.returnedEntities <= 20, `返回 ${r.returnedEntities} 个`);
  assert.equal(r.entities.length, r.returnedEntities);
  const kinds = r.entities.map((e) => e.name.split('_')[0]);
  assert.deepEqual(kinds.slice(0, 12), [...Array(5).fill('crowd.out'), ...Array(4).fill('crowd.hidden'), ...Array(3).fill('crowd.tiny')]);
  assert.ok(fits400(r), `JSON ${JSON.stringify(r).length} 字符，${estimateTokens(JSON.stringify(r))} token`);
});

test('entities：任何实体规模下回答都不超 400 token 和 1400 字符', () => {
  for (const n of [1, 5, 21, 35, 200]) {
    const ents = Array.from({ length: n }, (_, i) => entity(`e.${'x'.repeat(40)}${i}`, [i, i, i + 50, i + 50], { id: i + 1, bbox3d: [0, 0, 0, 1, 1, 1], depth: [1, 2] }));
    const r = query([meta(0, ents)], { type: 'entities' });
    assert.equal(r.ok, true);
    assert.equal(r.totalEntities, n);
    assert.ok(fits400(r), `n=${n}`);
  }
});

test('framing：按 hero 角色跨帧统计最小边距、屏占峰谷、出画、遮挡风险', () => {
  const frames = [0, 1, 2, 3].map((f) => meta(f, [
    entity('kit', [100 - f * 60, 100, 600 + f * 100, 600], { role: 'hero', visible: [1, 0.8, 0.3, 0.9][f] }),
    entity('bg', [0, 0, 100, 100], { id: 2 }),
  ]));
  const r = query(frames, { type: 'framing', target: 'hero' });
  assert.equal(r.ok, true);
  assert.equal(r.framesScanned, 4);
  assert.deepEqual(r.frameRange, [0, 3]);
  const [k] = r.entities;
  assert.equal(k.name, 'kit');
  assert.equal(k.out, true);
  assert.equal(k.firstOutside, 2);
  assert.equal(k.outsideFrames, 2);
  assert.equal(k.minMarginFrame, 3);
  assert.equal(k.minMargin, Number((-80 / W).toFixed(3)));
  assert.equal(k.peakFrame, 3);
  assert.equal(k.minPxAreaFrame, 0);
  assert.equal(k.occlusionRisk, true);
  assert.equal(k.minVisibleFrame, 2);
});

test('framing：按实体名查，缺帧计 missing', () => {
  const r = query({ 5: meta(5, [entity('cup', [10, 10, 20, 20])]), 6: meta(6, []) }, { type: 'framing', target: 'cup' });
  assert.equal(r.ok, true);
  assert.equal(r.entities[0].frames, 1);
  assert.equal(r.entities[0].missing, 1);
  assert.equal(r.entities[0].out, false);
});

test('texts：像素与归一化位置、相邻最小间距、越界', () => {
  const m = meta(0, [], { texts: [
    { id: 'title', text: '北冥', bbox2d: [100, 100, 500, 200] },
    { id: 'sub', text: 'subtitle', bbox2d: [100, 230, 500, 280] },
    { id: 'tag', text: 'edge', bbox2d: [1800, 1000, 1950, 1060] },
  ] });
  const r = query(m, { type: 'texts' });
  assert.equal(r.ok, true);
  assert.equal(r.totalTexts, 3);
  assert.equal(r.minGap.px, 30);
  assert.deepEqual(r.minGap.pair, ['title', 'sub']);
  assert.deepEqual(r.outside, ['tag']);
  assert.equal(r.texts[0].id, 'tag');
  assert.deepEqual(r.texts.find((t) => t.id === 'title').norm, [0.052, 0.093, 0.26, 0.185]);
  assert.ok(fits400(r));
});

test('texts：重叠的文字框间距为 0 并标 overlap', () => {
  const m = meta(0, [], { texts: [{ text: 'a', bbox2d: [0, 0, 100, 100] }, { text: 'b', bbox2d: [50, 50, 150, 150] }] });
  const r = query(m, { type: 'texts' });
  assert.equal(r.minGap.px, 0);
  assert.equal(r.minGap.overlap, true);
});

test('stats：亮度分位、溢出压死、对比档数，缺统计的帧单独计数', () => {
  const frames = [meta(0, []), meta(1, [], { stats: { luma: { p1: 0.0, p50: 0.5, p99: 1.2 }, clipHigh: 0.08, clipLow: 0.3, noise: null, tris: null } }), meta(2, [], { stats: null })];
  const r = query(frames, { type: 'stats' });
  assert.equal(r.ok, true);
  assert.equal(r.summary.framesWithStats, 2);
  assert.equal(r.summary.framesWithoutStats, 1);
  assert.equal(r.summary.clipHighMax, 0.08);
  assert.equal(r.summary.clipLowMax, 0.3);
  assert.equal(r.summary.p99Max, 1.2);
  assert.equal(r.frames[0].frame, 1);
  assert.equal(r.summary.dynamicRangeStopsMax, Number(Math.log2(1.2 / 1e-4).toFixed(2)));
  const one = query(frames, { type: 'stats', frame: 0 });
  assert.equal(one.summary.p50Min, 0.2);
  assert.equal(one.frames[0].dynamicRangeStops, Number(Math.log2(90).toFixed(2)));
});

test('stats：600 帧也压进 400 token', () => {
  const r = query(Array.from({ length: 600 }, (_, f) => meta(f, [])), { type: 'stats' });
  assert.equal(r.totalFrames, 600);
  assert.equal(r.truncated, true);
  assert.ok(fits400(r));
});

test('framing 与 texts 在大量目标下也压进 400 token，出画目标排在前面', () => {
  const ents = Array.from({ length: 40 }, (_, i) => entity(`must.see_${'y'.repeat(30)}_${i}`, i === 39 ? [-10, 0, 50, 50] : [100, 100, 200, 200], { id: i + 1, role: 'mustSee' }));
  const r = query([meta(0, ents), meta(1, ents)], { type: 'framing', target: 'mustSee' });
  assert.equal(r.ok, true);
  assert.equal(r.totalEntities, 40);
  assert.equal(r.truncated, true);
  assert.equal(entityRows(r)[0].out, true);
  assert.ok(fits400(r));
  const texts = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, text: '很长的一段字幕文字'.repeat(5), bbox2d: [i * 10, 0, i * 10 + 8, 20] }));
  const t = query(meta(0, [], { texts }), { type: 'texts' });
  assert.equal(t.totalTexts, 60);
  assert.ok(t.returnedTexts > 0 && t.returnedTexts < 60);
  assert.ok(fits400(t));
});

test('非法输入一律返回 usage.bad-argument，不抛异常', () => {
  const cases = [
    [[], { type: 'entities' }],
    [null, { type: 'entities' }],
    [[{ format: 'meta/0.1' }], { type: 'entities' }],
    [[{ format: 'other' }], { type: 'stats' }],
    [[meta(0, [])], { type: 'nope' }],
    [[meta(0, [])], { type: 'toString' }],
    [[meta(0, [])], null],
    [[meta(0, [])], { type: 'framing' }],
    [[meta(0, [])], { type: 'entities', frame: 9 }],
    [[meta(0, [])], { type: 'entities', frame: -1 }],
    [[{ ...meta(0, []), entities: [{ name: 'x' }] }], { type: 'entities' }],
    [[{ ...meta(0, []), texts: [{ text: 'a' }] }], { type: 'texts' }],
  ];
  for (const [metas, req] of cases) {
    let r;
    assert.doesNotThrow(() => { r = query(metas, req); });
    assert.equal(r.ok, false, JSON.stringify(req));
    assert.equal(r.error.code, 'usage.bad-argument');
    assert.ok(r.error.message.length > 0);
  }
});

test('legacy-page 的 entities 是 null 时如实回答', () => {
  const r = query(meta(0, null), { type: 'entities' });
  assert.equal(r.ok, true);
  assert.equal(r.entities, null);
});

// ---------- 联系表与切点条带 ----------

function solid(width, height, v) {
  return { width, height, rgb: new Uint8Array(width * height * 3).fill(v) };
}
function writeFrames(dir, values, w = 32, h = 18) {
  return values.map((v, i) => {
    const p = join(dir, `f${String(i).padStart(3, '0')}.png`);
    writeFileSync(p, encodePng(solid(w, h, v)));
    return p;
  });
}
const tmp = () => mkdtempSync(join(tmpdir(), 'observe-ext-'));
const hasFfmpeg = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore', timeout: 15000, windowsHide: true }).status === 0;

test('PNG 编解码往返无损，5x7 字模把帧号写进像素', () => {
  const img = solid(40, 12, 128);
  const [w, h] = drawLabel(img, 0, 0, '12');
  assert.deepEqual([w, h], [13, 9]);
  const back = decodePng(encodePng(img));
  assert.deepEqual([back.width, back.height], [40, 12]);
  assert.deepEqual(Buffer.from(back.rgb), Buffer.from(img.rgb));
  let white = 0;
  for (let i = 0; i < back.rgb.length; i += 3) if (back.rgb[i] === 255) white++;
  // 「1」点亮 9 点，「2」点亮 15 点
  assert.equal(white, 24);
});

test('联系表：均匀抽 4 帧拼 2×2 网格，PNG 尺寸与网格坐标对得上', () => {
  const dir = tmp();
  try {
    const frames = writeFrames(dir, Array.from({ length: 10 }, (_, i) => i * 20));
    const out = join(dir, 'sheet.png');
    const r = buildContactSheet({ frames, count: 4, cellWidth: 64, gap: 2, out });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.deepEqual(r.summary.grid, [2, 2]);
    assert.deepEqual(r.summary.cell, [64, 36]);
    assert.equal(r.summary.frames, '0-9/3');
    assert.deepEqual(r.cells.map((c) => c.frame), [0, 3, 6, 9]);
    assert.deepEqual(r.summary.size, [2 * 64 + 3 * 2, 2 * 36 + 3 * 2]);
    assert.deepEqual(pngSize(readFileSync(out)), r.summary.size);
    assert.deepEqual(r.cells[3], { frame: 9, col: 1, row: 1 });
    const img = decodePng(readFileSync(out));
    // 第 4 格（帧 9，码值 180）中心像素
    const cx = 2 + 64 + 2 + 32, cy = 2 + 36 + 2 + 30;
    assert.equal(img.rgb[(cy * img.width + cx) * 3], 180);
    assert.ok(estimateTokens(JSON.stringify(r.summary)) <= SUMMARY_TOKEN_LIMIT);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('联系表：pick 指定帧号；越界帧号报错不崩', () => {
  const dir = tmp();
  try {
    const frames = writeFrames(dir, [0, 50, 100, 150, 200]);
    const ok = buildContactSheet({ frames, start: 100, pick: [104, 100, 102], columns: 3, cellWidth: 32, out: join(dir, 'p.png') });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.summary.grid, [3, 1]);
    assert.equal(ok.summary.frames, '104,100,102');
    const badPick = buildContactSheet({ frames, pick: [7], out: join(dir, 'q.png') });
    assert.equal(badPick.ok, false);
    assert.equal(badPick.error.code, 'usage.bad-argument');
    assert.equal(existsSync(join(dir, 'q.png')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('切点条带：切点前后各 3 帧、6 格横拼，差值认出硬切', () => {
  const dir = tmp();
  try {
    // 0-9 帧码值 40，10-19 帧码值 200：切点 10
    const frames = writeFrames(dir, Array.from({ length: 20 }, (_, i) => (i < 10 ? 40 : 200)));
    const r = buildCutStrips({ frames, cuts: [10], cellWidth: 32, gap: 2, outDir: join(dir, 'strips') });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.outputs.length, 1);
    assert.deepEqual(pngSize(readFileSync(r.outputs[0])), [6 * 32 + 7 * 2, 18 + 4]);
    const [c] = r.summary.cuts;
    assert.equal(c.cut, 10);
    assert.deepEqual(c.pair, [9, 10]);
    assert.equal(c.clamped, undefined);
    assert.equal(c.cutDiff, Number((160 / 255).toFixed(4)));
    assert.equal(c.preDiff, 0);
    assert.equal(c.postDiff, 0);
    assert.equal(c.lumaJump, Number((160 / 255).toFixed(4)));
    assert.deepEqual(c.flags, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('切点条带：边界切点钳制并标 clamped，假切与重影被标出', () => {
  const dir = tmp();
  try {
    // 帧 0、1 码值 10；2 起码值 10（假切 2）；6 起 120，7 起 240（切后还在大变：重影）
    const values = [10, 10, 10, 10, 10, 10, 120, 240, 240, 240];
    const frames = writeFrames(dir, values);
    const r = buildCutStrips({ frames, transitions: [{ id: 't1', at: 2, type: 'cut' }], events: { format: 'events/0.1', events: [{ id: 'c', frame: 6, kind: 'cut' }, { id: 'n', frame: 9, kind: 'named' }] }, cuts: [9], cellWidth: 16, outDir: dir });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.summary.totalCuts, 3);
    const by = Object.fromEntries(r.summary.cuts.map((c) => [c.cut, c]));
    assert.equal(by[2].clamped, true);
    assert.deepEqual(by[2].frames, [0, 0, 1, 2, 3, 4]);
    assert.deepEqual(by[2].flags, ['weak']);
    assert.equal(by[9].clamped, true);
    assert.deepEqual(by[9].frames, [6, 7, 8, 9, 9, 9]);
    assert.ok(by[6].flags.includes('ghost'));
    assert.equal(by[6].clamped, undefined);
    assert.equal(r.outputs.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('切点条带：100 个切点摘要也压在 300 token 内，异常切点优先', () => {
  const dir = tmp();
  try {
    const frames = writeFrames(dir, Array.from({ length: 210 }, (_, i) => (Math.floor(i / 2) % 2 ? 200 : 20)), 8, 8);
    const cuts = Array.from({ length: 100 }, (_, i) => 4 + i * 2);
    const r = buildCutStrips({ frames, cuts, cellWidth: 16, outDir: join(dir, 'o') });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.outputs.length, 100);
    const text = JSON.stringify(r.summary);
    assert.ok(estimateTokens(text) <= SUMMARY_TOKEN_LIMIT, `${estimateTokens(text)} token`);
    assert.equal(r.summary.totalCuts, 100);
    assert.equal(r.summary.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('切点收集与非法参数不崩', () => {
  assert.deepEqual(collectCuts({ cuts: [5, 1, 5], transitions: [{ at: 3 }], events: [{ kind: 'cut', frame: 1 }, { kind: 'arrive', frame: 2 }] }), [1, 3, 5]);
  assert.equal(compactFrames([0, 5, 10, 15, 17]), '0-15/5,17');
  const dir = tmp();
  try {
    const frames = writeFrames(dir, [0, 0, 0]);
    for (const opts of [{}, { frames: [] }, { frames, outDir: dir }, { frames, cuts: [-1], outDir: dir }, { frames, cuts: [9], outDir: dir },
      { frames, cuts: [1] }, { video: 'x.mp4', fps: 'abc', cuts: [1], outDir: dir }, { frames: [join(dir, 'missing.png')], cuts: [0], outDir: dir }]) {
      let r;
      assert.doesNotThrow(() => { r = buildCutStrips(opts); });
      assert.equal(r.ok, false, JSON.stringify(opts));
      assert.equal(r.error.code, 'usage.bad-argument');
    }
    writeFileSync(join(dir, 'junk.png'), 'not a png');
    const junk = buildContactSheet({ frames: [join(dir, 'junk.png')], out: join(dir, 's.png') });
    assert.equal(junk.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('视频输入：ffmpeg 按帧率抽帧，联系表与切点条带帧号对得上', { skip: !hasFfmpeg && '没有 ffmpeg' }, () => {
  const dir = tmp();
  try {
    const video = join(dir, 'v.mkv');
    // 0-11 帧灰 40，12-23 帧灰 200，无损编码
    const gen = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x282828:s=32x18:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=0xc8c8c8:s=32x18:r=24:d=0.5', '-filter_complex', '[0][1]concat=n=2:v=1', '-c:v', 'ffv1', '-pix_fmt', 'rgb24', video],
    { timeout: 60000, windowsHide: true });
    assert.equal(gen.status, 0, String(gen.stderr));
    const sheet = buildContactSheet({ video, fps: '24/1', count: 3, cellWidth: 32, out: join(dir, 'sheet.png') });
    assert.equal(sheet.ok, true, JSON.stringify(sheet.error));
    assert.equal(sheet.summary.totalFrames, 24);
    assert.equal(sheet.summary.frames, '0,12,23');
    const strips = buildCutStrips({ video, fps: 24, cuts: [12], cellWidth: 32, outDir: dir });
    assert.equal(strips.ok, true, JSON.stringify(strips.error));
    const [c] = strips.summary.cuts;
    assert.deepEqual(c.pair, [11, 12]);
    assert.ok(Math.abs(c.cutDiff - 160 / 255) < 0.01, String(c.cutDiff));
    assert.equal(c.postDiff, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B01 / S01 — 冻结正例、必填字段、半截对象与 M4/M6/M7', () => {
  assertContract(meta(0, crowd()), 'meta');
  for (const path of ['texts', 'stats', 'film', 'entities.0.pxArea', 'entities.0.visible', 'stats.luma.p99', 'camera.near', 'origin.host', 'source.tier']) {
    const m = structuredClone(full);
    const keys = path.split('.');
    const key = keys.pop();
    delete keys.reduce((obj, k) => obj[k], m)[key];
    assert.equal(query(m, { type: 'stats' }).error.code, 'usage.bad-argument', path);
  }
  for (const invalid of [{ texts: [{ bbox2d: [0, 0, 1, 1] }] }, { entities: null }, { hash: { color: null } },
    { entities: [entity('kit', [10, 10, 100, 100], { visible: 0.1 })] }]) {
    assert.equal(query({ ...full, ...invalid }, { type: 'entities' }).error.code, 'usage.bad-argument');
  }
  const missing = meta(0, [entity('kit', [0, 0, 10, 10])], { stats: null, lights: null, texts: null });
  assert.equal(query(missing, { type: 'stats' }).summary.framesWithoutStats, 1);
  assert.equal(query(missing, { type: 'texts' }).texts, null);
  assert.equal(query(legacy, { type: 'entities' }).entities, null);
});

test('B02 — 18 个出画实体保全观测，超过 20 个异常也按预算保留', () => {
  for (const anomalies of [18, 24, 80]) {
    const entities = Array.from({ length: anomalies + 6 }, (_, i) => entity(`e${i}`, i < anomalies ? [-20, 100, 400, 400] : [0, 0, 400, 400], { id: i + 1 }));
    const r = query(meta(0, entities), { type: 'entities' });
    const rows = entityRows(r);
    assert.equal(r.anomalies, anomalies);
    assert.deepEqual(rows.filter(row => row.flags?.includes('outsideFrame')).map(row => row.name), entities.slice(0, anomalies).map(e => e.name));
    assert.deepEqual(rows[0].bbox2d, entities[0].bbox2d);
    assert.ok(fits400(r));
  }
  const list = Array.from({ length: 24 }, (_, i) => entity(`p${i}`, i === 23 ? [900, 500, 905, 505] : [0, 0, 400, 400], { id: i + 1, role: 'mustSee', visible: 0.9 }));
  assert.equal(entityRows(query(meta(0, list), { type: 'framing', target: 'mustSee' }))[0].name, 'p23');
});

test('B03 — 名称、内容预算足够时完整，必须截短时保留首尾', () => {
  for (const length of [60, 1800]) {
    const names = ['A', 'B'].map(s => 'x'.repeat(length) + s);
    const m = meta(0, names.map((name, i) => entity(name, [-1, 0, 20, 20], { id: i + 1, role: 'mustSee' })));
    for (const request of [{ type: 'entities' }, { type: 'framing', target: 'mustSee' }]) {
      const r = query(m, request);
      const actual = entityRows(r).map(e => e.name);
      assert.deepEqual(actual.map(s => s.at(-1)), ['A', 'B']);
      assert.equal(r.truncated, length === 1800);
      if (length === 60) assert.deepEqual(actual, names);
      else assert.ok(actual.every(s => s.startsWith('x') && s.includes('…')));
      assert.ok(fits400(r));
    }
  }
  for (const n of [48, 2000]) {
    const text = `首${'字'.repeat(n)}尾`;
    const r = query(meta(0, [], { texts: [{ text, bbox2d: [1, 2, 3, 4] }] }), { type: 'texts' });
    assert.equal(r.truncated, n === 2000);
    if (n === 48) assert.equal(r.texts[0].text, text);
    else assert.match(r.texts[0].text, /^首.*….*尾$/u);
    assert.ok(fits400(r));
  }
});

test('B04 / B05 — 倒序跨镜头按当帧角色，整段缺读数时遮挡风险为 null', () => {
  const m = meta(150, [entity('kit', [0, 0, 400, 400], { role: 'hero', visible: 0.9 })]);
  const other = meta(151, [entity('kit', [-10, 0, 300, 400], { role: 'mustSee', visible: 0.1 })], { shot: 's02', shotFrame: 0 });
  const get = target => query([other, m], { type: 'framing', target }).entities[0];
  assert.deepEqual([get('hero').frames, get('hero').firstOutside, get('hero').minVisible], [1, null, 0.9]);
  assert.deepEqual([get('kit').frames, get('kit').firstOutside, get('kit').minVisible], [2, 151, 0.1]);
  m.entities[0].visible = null;
  assertContract(m, 'meta');
  assert.equal(get('hero').occlusionRisk, null);
  assert.equal(get('hero').minVisible, null);
});

test('B06 / B07 — 原始浮点间距与长 ID 越界代表条目', () => {
  const boxes = [[0, 0, 10.011, 10], [10.049, 0, 20, 10], [20.039, 0, 30, 10]];
  const texts = boxes.map((bbox2d, i) => ({ id: `t${i}`, text: '字', bbox2d }));
  const gap = count => query(meta(0, [], { texts: texts.slice(0, count) }), { type: 'texts' }).minGap;
  assert.deepEqual(gap(2), { px: 0.04, pair: ['t0', 't1'], overlap: false });
  assert.deepEqual(gap(3).pair, ['t0', 't1']);
  const outside = Array.from({ length: 44 }, (_, i) => ({ id: '观测'.repeat(16) + i, text: `字${i}`, bbox2d: [-1, i * 20, 10, i * 20 + 10] }));
  const r = query(meta(0, [], { texts: outside }), { type: 'texts' });
  assert.equal(r.outsideCount, 44);
  assert.equal(r.minGapPx, 10);
  assert.ok(r.returnedTexts > 0 && r.outside.length < 44);
  assert.deepEqual(r.outside, r.texts.map(t => t.id));
  assert.equal(r.truncated, true);
  assert.ok(fits400(r));
});

test('B08 / B09 — 颜色参考分桶，动态范围与实测主辅比各自有据', () => {
  const r = query([legacy, full], { type: 'stats' });
  assert.equal(r.colorRef, null);
  assert.deepEqual(r.frames.map(f => [f.frame, f.colorRef]).sort(), [[150, 'scene'], [420, 'display']]);
  assert.equal(r.summary.byColorRef.scene.clipLowMax, null);
  assert.equal(r.summary.byColorRef.display.clipLowMax, 0.01);
  for (const watts of [1, 400]) {
    const m = assertContract({ ...full, lights: [full.lights[0], { ...full.lights[0], name: 'fill', watts }] }, 'meta');
    const [row] = query(m, { type: 'stats' }).frames;
    assert.equal(row.keyFillRatio, null);
    assert.equal(row.dynamicRangeStops, 6.28);
    const measured = assertContract({ ...m, readings: { keyFillRatio: 4 } }, 'meta');
    assert.equal(query(measured, { type: 'stats' }).frames[0].keyFillRatio, 4);
  }
});

test('S03 — 元数据省略的部件数与查询截断独立', () => {
  const m = meta(0, [entity('kit', [0, 0, 400, 400])], { omittedParts: 23 });
  const r = query(m, { type: 'entities' });
  assert.deepEqual([r.totalEntities, r.returnedEntities, r.omittedParts, r.truncated], [1, 1, 23, false]);
});

function assertSheetBudget(summary) {
  const json = JSON.stringify(summary);
  assert.ok(Math.ceil(Buffer.byteLength(json) / 3.5) <= 300);
  assert.ok(json.length <= 1050);
}

test('B10 — 按最终序列化的控制字符文件名计预算', () => {
  const dir = tmp();
  try {
    const frames = writeFrames(dir, Array(9).fill(32));
    // Windows 文件系统禁止控制字符，合法文件名在该平台仍走相同的最终序列化断言。
    const file = (process.platform === 'win32' ? 'x' : '\u0001').repeat(185) + '.png';
    const out = join(dir, file);
    const r = buildContactSheet({ frames, out, cellWidth: 16 });
    assert.deepEqual(r.outputs, [out]);
    assert.ok(existsSync(out));
    assert.equal(r.summary.frames, '0-8');
    assertSheetBudget(r.summary);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B11 — 110 个切点的摘要保留完整帧对、六帧与三段差值', () => {
  const dir = tmp();
  try {
    const frames = writeFrames(dir, Array(135).fill(32), 8, 8);
    const cuts = Array.from({ length: 110 }, (_, i) => i + 1);
    const r = buildCutStrips({ frames, cuts, outDir: dir, cellWidth: 16 });
    assert.equal(r.outputs.filter(file => existsSync(file)).length, 110);
    assertSheetBudget(r.summary);
    assert.equal(r.summary.truncated, true);
    assert.equal(r.summary.returnedCuts, r.summary.cuts.length);
    assert.ok(r.summary.cuts.some(c => c.cut === 1 && c.clamped));
    for (const c of r.summary.cuts) {
      assert.deepEqual(c.frames, [-3,-2,-1,0,1,2].map(d => Math.max(0, c.cut + d)));
      assert.deepEqual(c.pair, c.frames.slice(2, 4));
      assert.deepEqual([c.preDiff, c.cutDiff, c.postDiff], [0, 0, 0]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 独立编码的固定 PNG 样本。灰度与索引图在相邻像素循环走遍该位深的样本值。
const pngFixtures = {
  bits1: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUAQAAAADNAaKYAAAAFUlEQVR4nGMMZWBg+M0CIr8x0pENAA8YGkF2ewTkAAAAAElFTkSuQmCC',
  indexed1: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUAQMAAADftA12AAAABlBMVEUAAAD///+l2Z/dAAAAFUlEQVR4nGMMZWBg+M0CIr8x0pENAA8YGkF2ewTkAAAAAElFTkSuQmCC',
  bits2: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUAgMAAACYFHemAAAADFBMVEUAAABVVVWqqqr////Bf2LRAAAAGUlEQVR4nGOUZoAClkA4yxXOEoWxGAe5OgCvvQQg596qLQAAAABJRU5ErkJggg==',
  bits4: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUBAMAAAAXVIIGAAAAMFBMVEUAAAAREREiIiIzMzNERERVVVVmZmZ3d3eIiIiZmZmqqqq7u7vMzMzd3d3u7u7///97EBgKAAAAP0lEQVR4nGNkVIIAITjNJAgBjAgaJoQEmDAUCeJUxYikCKcqRmRFuFShKsKhCk0RdlXoihixqcJQhCckSA8vAExcF6Ei9FouAAAAAElFTkSuQmCC',
  bits8: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUCAAAAADAEcDpAAAAG0lEQVR4nGNkYCQMmIhQwziqiHE0CBgHYxAAAEqtAvdcIJmGAAAAAElFTkSuQmCC',
  bits16: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUEAAAAACQgRyqAAAAjUlEQVR4nK2S0Q3AIAgFBdnJ/Yd5ezRNTdsUUMGGH8KZeOijUqhdxe3b6Qm5jCuk19PpSZ0zAYN6vbqmJhgzDt4Ll0noXnIZh98CDjuNfnGS+P/AYt1o34lTmYHBaiIzZLDbaNtJUjkmxTjxP7AYrxySlTXF0TWXaoM118Rl7mQEMvX0RiCTcTADmXA6ACHXY/6MDHxdAAAAAElFTkSuQmCC',
  adam7: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUCAAAAAG3FvB/AAAA0klEQVR4nIXK2xaBQBiG4VeSJEmSJEmSJEk2939pNksnzcEczD/fetYLuu3Hv5PzPTWq6YZ8Xsrnlai6abt+GKf8/7xE0QzL8YIooR0Z7ShoR0U7GhRV0w3Tsh3X84MwipOULmQ5XShKulDVdKF50OsPhqPxZDqbL5ar9Wa72yPIAUGOCHJCkDOCXBDkiiA3BLkjyJOe0lcH2lAfGWNzYk3tmTN3F97SXwXrcBNt412yT5Enhwx5csyRJ6cCeXIukSeXCnlyrZEntwZ5cn8gT56vN9XFS/GZsz98AAAAAElFTkSuQmCC',
  transparentBlack: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUCAYAAADlep81AAAAGklEQVR4nO3BMQEAAADCoPVPbQhfoAAAgA4DC1QAAe4CTtoAAAAASUVORK5CYII=',
  transparentWhite: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUCAYAAADlep81AAAAOUlEQVR4nM3OQQEAIACEMKR/5/NvAVmCnW2USIzESIzESIzESIzESIzESIzESIzESIzESIzE+DvwusPsAyXD6dxBAAAAAElFTkSuQmCC',
  halfWhite: 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAUCAYAAADlep81AAAAO0lEQVR4nM3OMQEAIAzAsFLlOB8/BtYoyJmZS4jESIzESIzESIzESIzESIzESIzESIzESIzESIzbgd8DbEYDpbOtaT8AAAAASUVORK5CYII=',
};

test('B12 — 各 PNG 位深及 Adam7 输入通过联系表入口，核对逐像素结果', () => {
  const dir = tmp();
  try {
    for (const [key, depth] of [['bits1', 1], ['indexed1', 1], ['bits2', 2], ['bits4', 4], ['bits8', 8], ['bits16', 16], ['adam7', 8]]) {
      const data = Buffer.from(pngFixtures[key], 'base64');
      assert.equal(data[24], depth);
      if (key === 'adam7') assert.equal(data[28], 1);
      const file = join(dir, `${key}.png`);
      writeFileSync(file, data);
      const r = buildContactSheet({ frames: [file], out: join(dir, 'out.png'), gap: 0, cellWidth: 36 });
      assert.equal(r.ok, true, JSON.stringify(r.error));
      const { width, height, rgb } = decodePng(data);
      const sheet = decodePng(readFileSync(r.outputs[0]));
      assert.deepEqual([width, height], [36, 20]);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const max = 2 ** depth - 1;
        const sample = depth === 16 ? 311 * x + 997 * y : (x + y) % (max + 1);
        const value = Math.round(sample * 255 / max);
        const i = 3 * (y * width + x);
        assert.deepEqual([...rgb.slice(i, i + 3)], [value, value, value]);
        if (y >= 9) assert.equal(sheet.rgb[i], value);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S02 — IHDR、IDAT、IEND 校验和损坏或 IEND 截断均报读帧错误', () => {
  const dir = tmp();
  try {
    const bytes = encodePng(solid(8, 8, 100));
    const corrupt = [bytes.subarray(0, -12), bytes.subarray(0, -1)];
    for (const offset of [29, bytes.length - 16, bytes.length - 1]) {
      const copy = Buffer.from(bytes);
      copy[offset] ^= 1;
      corrupt.push(copy);
    }
    const file = join(dir, 'broken.png');
    for (const data of corrupt) {
      writeFileSync(file, data);
      const r = buildContactSheet({ frames: [file], out: join(dir, 'result.png') });
      assert.equal(r.error.code, 'usage.bad-argument');
      assert.match(r.error.message, /broken\.png/);
      assert.equal(existsSync(join(dir, 'result.png')), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B13 — 全透明黑白的切口为零，半透明白按灰底合成', () => {
  const dir = tmp();
  try {
    const frames = ['transparentBlack', 'transparentWhite', 'halfWhite'].map(key => {
      const file = join(dir, `${key}.png`);
      writeFileSync(file, Buffer.from(pngFixtures[key], 'base64'));
      return file;
    });
    const r = buildCutStrips({ frames: [...Array(3).fill(frames[0]), ...Array(3).fill(frames[1])], cuts: [3], outDir: dir, gap: 0, cellWidth: 36 });
    const [c] = r.summary.cuts;
    assert.deepEqual([c.cutDiff, c.lumaJump, c.flags], [0, 0, ['weak']]);
    const sheet = buildContactSheet({ frames, columns: 3, gap: 0, cellWidth: 36, out: join(dir, 'sheet.png') });
    const img = decodePng(readFileSync(sheet.outputs[0]));
    for (const [i, expected] of [32, 32, Math.round(255 * 128 / 255 + 32 * 127 / 255)].entries()) {
      assert.equal(img.rgb[(img.width * 15 + i * 36 + 18) * 3], expected);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B14 — FFmpeg 缺失、超时及失败的实际错误可装入 envelope/0.1', t => {
  const dir = tmp();
  const original = process.env.FFMPEG;
  const run = (code, exitCode) => {
    const r = buildContactSheet({ video: join(dir, 'input.mkv'), fps: 24, out: join(dir, 'out.png') });
    assert.equal(r.error.code, code);
    assertContract({ ...envelope, ok: r.ok, exitCode, error: r.error, diagnostics: [] }, 'envelope');
  };
  try {
    process.env.FFMPEG = join(dir, 'absent-executable');
    run('env.ffmpeg-missing', 3);
    process.env.FFMPEG = process.execPath;
    run('failure.ffmpeg', 1);
    t.mock.method(childProcess, 'spawnSync', () => ({ error: { code: 'ETIMEDOUT' } }));
    syncBuiltinESMExports();
    run('timeout.ffmpeg', 124);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (original === undefined) delete process.env.FFMPEG;
    else process.env.FFMPEG = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R01 — 超长文字框 ID 仅中段不同时，32 字符强制截短档仍保持唯一区分', () => {
  const id0 = `${'a'.repeat(137)}0${'a'.repeat(137)}`;
  const id1 = `${'a'.repeat(137)}1${'a'.repeat(137)}`;
  const m = meta(0, [], {
    texts: [
      { id: id0, text: 'T0', bbox2d: [-10, 10, 90, 50] },
      { id: id1, text: 'T1', bbox2d: [-10, 54, 90, 94] },
    ],
  });
  const r = query(m, { type: 'texts', frame: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(r.returnedTexts, 2);
  assert.notEqual(r.texts[0].id, r.texts[1].id);
  assert.deepEqual(r.outside, [r.texts[0].id, r.texts[1].id]);
  assert.deepEqual(r.minGap.pair, [r.texts[0].id, r.texts[1].id]);
  assert.ok(fits400(r));
});
