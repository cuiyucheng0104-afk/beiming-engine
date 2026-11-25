// M3 验收：夹具只交实测数据。通过和返修都从公开的断言/模板入口走，不直调求值器。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipHighlightRatio } from '../observe/metrics/index.mjs';
import { enforcePredicateFloor, evaluateAssertion, evaluateItem, registeredTemplate } from './predicates.mjs';

const shot = (id, from, to) => ({ id, in: from, out: to, source: 'blender', roles: { hero: 'shaft', mustSee: ['ring', 'pin'] } });
const film = { output: { frames: 24, fps: '24/1', size: [200, 100] }, audio: { mode: 'script' }, shots: [shot('open', 0, 24)] };
const cutFilm = { ...film, shots: [shot('open', 0, 12), shot('hold', 12, 24)] };
const sample = (frame, entity = {}, meta = {}) => ({ frame, meta: { frame, size: [200, 100],
  entities: [{ name: 'shaft', bbox2d: [40, 20, 160, 80], pxArea: 0.36, ...entity }], ...meta } });
const motion = (speed) => ({ speed, unit: 'm/frame' });
const pair = (value, a = 'shaft', b = 'ring') => ({ a, b, value, unit: 'm' });
const query = (frame, kind, ...items) => ({ frame, result: { kind, items } });
const evaluate = (expr, measured, f = film) => evaluateAssertion(expr, f, measured);
function pass(expr, measured, f) {
  const r = evaluate(expr, measured, f);
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.equal(r.ok, true);
}
function reject(expr, measured, frame, f) {
  const r = evaluate(expr, measured, f);
  assert.equal(r.status, 'fail', JSON.stringify(r));
  assert.equal(r.ok, false);
  if (frame !== undefined) assert.equal(r.counterexampleFrame, frame, JSON.stringify(r));
  assert.ok(Object.hasOwn(r, 'measured') && Object.hasOwn(r, 'counterexampleFrame'));
  assert.ok(r.expected && Array.isArray(r.fixes) && (r.fixes.length || r.hint), `缺少返修依据：${JSON.stringify(r)}`);
  return r;
}

test('no_intersect：m 读数对 mm 阈值；最深反例而非首个，排除无关实体和区间外帧', () => {
  const rule = 'no_intersect(hero, ring, tol=0.5mm) @ [1,10)';
  const within = { queries: [query(0, 'intersect', pair(0.2)), query(2, 'intersect', pair(0.0005), pair(0.1, 'shaft', 'pin'))] };
  pass(rule, within);
  const bad = { queries: [...within.queries, query(5, 'intersect', pair(0.001)), query(8, 'intersect', pair(0.0033))] };
  const r = reject(rule, bad, 8);
  assert.match(JSON.stringify(r.measured), /0\.0033/);
  assert.equal(evaluate(rule, {}).status, 'skipped');
  // 合法的镜头角色可重叠：shaft 自身不应成为一个缺测的相交实体对。
  const roles = { hero: 'shaft', mustSee: ['shaft', 'ring'] };
  pass('no_intersect(hero, mustSee)', { queries: [query(2, 'intersect', pair(0))] }, { ...film, shots: [{ ...film.shots[0], roles }] });
  // QueryResult 自身不带全片帧号；没有那个帧号时不能编一个。
  pass('no_intersect(shaft, ring)', { queries: [{ kind: 'intersect', items: [pair(0)] }] });
  reject('no_intersect(shaft, ring)', { intersections: [{ frame: 9, a: 'shaft', b: 'ring', depth: 0.0005 }] }, 9);
});

test('contact：查询的实际间隙 ≤ 上限才过；别的零件贴合不能掩盖主体悬空', () => {
  const rule = 'contact(hero, ring, max=0.2mm)';
  pass(rule, { queries: [query(3, 'contact', pair(0.0002))] });
  const bad = { queries: [query(3, 'contact', pair(0)), query(6, 'contact', pair(0, 'shaft', 'pin'), pair(0.004))] };
  assert.match(JSON.stringify(reject(rule, bad, 6).measured), /0\.004/);
  const otherSource = { ...film, shots: film.shots.map((s) => ({ ...s, source: 'three' })) };
  assert.equal(evaluate(rule, bad, otherSource).status, 'skipped');
});

test('at_rest：只判到位后的运动速率；没有 motion 时从世界坐标求位移', () => {
  const rule = 'at_rest(hero) @ [4,12)';
  const frames = [sample(1, { motion: motion(2) }), sample(4, { motion: motion(0) }), sample(5, { motion: motion(0.0001) })];
  pass(rule, { frames });
  reject(rule, { frames: [...frames, sample(7, { motion: motion(0.002) })] }, 7);
  const pos = (frame, x) => sample(frame, { pos: [x, 0, 0] });
  pass(rule, { frames: [pos(4, 1), pos(5, 1)] });
  reject(rule, { frames: [pos(4, 1), pos(5, 1.01)] }, 5);
});

for (const [expr, bbox2d] of [
  ['bbox_w(hero) in [0.5,0.7]', [50, 20, 90, 80]],   // 缩小至画宽 20%
  ['bbox_h(hero) >= 0.5', [40, 30, 160, 50]],         // 缩小至画高 20%
  ['margin_lr(hero) >= 0.1', [40, 20, 194, 80]],      // 只有右侧贴边
  ['margin_tb(hero) >= 0.1', [40, 3, 160, 80]],       // 只有上侧贴边
]) {
  test(`${expr}：按画幅宽高归一，定位第一幅失去取景余量的抽帧`, () => {
    pass(expr, { frames: [sample(1)] });
    reject(expr, { frames: [sample(1), sample(7, { bbox2d }), sample(8, { bbox2d })] }, 7);
  });
}

test('highlight_clip_ratio：地面白斑与金属端面分别量；报最严重一帧，不用全帧冒充实体证据', () => {
  const f = (i, all, metal) => sample(i, {}, { stats: { highlightClipRatio: all, byEntity: { shaft: { highlightClipRatio: metal } } } });
  const frames = [f(0, 0.01, 0.02), f(3, 0.03, 0.05), f(8, 0.15, 0.18)];
  for (const expr of ['highlight_clip_ratio()', 'highlight_clip_ratio(hero)']) {
    pass(expr, { frames: frames.slice(0, 1) });
    reject(expr, { frames }, 8);
  }
  pass('highlight_clip_ratio(hero)', { frames: [f(0, 0.93, 0.01)] });
  assert.notEqual(evaluate('highlight_clip_ratio(hero)', { highlightClipRatio: 0 }).status, 'pass');
});

test('luma_p99：按被点名实体取 p99；上限和区间均按原始读数判，不被全局暗背景稀释', () => {
  const f = (i, p99) => sample(i, { lumaP99: p99 }, { stats: { lumaP99: 0.7 } });
  const frames = [f(2, 0.98), f(3, 0.985), f(9, 1)];
  pass('luma_p99()', { frames });
  pass('luma_p99(shaft)', { frames: frames.slice(0, 1) });
  reject('luma_p99(hero) in [0.5,0.98]', { frames }, 9);
});

test('in_focus：按米/毫米单位和传感器宽度算 CoC，深度区间最远端也得在焦内', () => {
  const camera = { focalLengthMm: 50, fStop: 2, focusDistance: 2, sensorWidthMm: 36 };
  const f = (frame, depth) => sample(frame, { depth }, { camera, size: [1920, 1080] });
  pass('in_focus(hero)', { frames: [f(2, [2, 2])] });
  const frames = [f(2, [2, 2]), f(7, [2, 4])];
  // 50²/(2×1950) × (4000−2000)/4000 × 1920/36 = 17.094... px。
  pass('in_focus(hero) <= 17.10', { frames });
  reject('in_focus(hero) <= 17.09', { frames }, 7);
  reject('in_focus(hero)', { frames: [sample(5, { cocPx: 2.1 })] }, 5);
  const byRange = (d) => ({ frames: [sample(6, { depth: d }, { camera: { dofRange: [1.8, 2.2], maxCocPx: 2 } })] });
  pass('in_focus(hero)', byRange(2));
  reject('in_focus(hero)', byRange(3), 6);
});

test('fx_visible：有效区间有一帧达最小面积即过；区间外的闪光不能挽救全程不可见的特效', () => {
  const f = (frame, pxArea) => sample(frame, { name: 'glow', pxArea });
  const expr = 'fx_visible(glow, minArea=0.01) @ [4,12)';
  pass(expr, { frames: [f(4, 0), f(5, 0.01)] });
  reject(expr, { frames: [f(2, 0.3), f(4, 0), f(5, 0.0002)] }, 5);
});

test('no_ghost：检查指定切点和 shots；不得把别的切点或低对比度当作干净证据', () => {
  const row = (cutFrame, ghostEnergy, hasGhost) => ({ cutFrame, status: 'ok', ghostEnergy, hasGhost });
  const cutGhost = { hasGhost: true, ghostFrames: [12], perCut: [row(3, 0, false), row(12, 0.20, true)] };
  pass('no_ghost(3)', { cutGhost });
  reject('no_ghost(shots)', { renderStats: { cutGhost } }, 12, cutFilm);
  reject('no_ghost(12) <= 0.05', { cutGhost: { perCut: [row(12, 0.07, false)] } }, 12);
  reject('no_ghost(12)', { cutGhost: { perCut: [row(12, 0.12, true)] } }, 12);
  for (const perCut of [[row(3, 0, false)], [{ cutFrame: 12, status: 'low-contrast', ghostEnergy: null }]]) {
    assert.notEqual(evaluate('no_ghost(shots)', { cutGhost: { perCut } }, cutFilm).status, 'pass');
  }
});

test('备用证据：轨道位移、按实体的特效开关差图、O8 与正式 meta 统计', () => {
  const tracks = { shaft: [{ frame: 4, pos: [0, 0, 0] }, { frame: 6, pos: [0, 0.001, 0] }] };
  reject('at_rest(hero)', { tracks }, 6);
  const fxDiff = [{ frame: 8, entity: 'glow', areaRatio: 0.001 }, { frame: 9, entity: 'other', areaRatio: 0.5 }];
  reject('fx_visible(glow, 0.01)', { fxDiff }, 8);
  pass('fx_visible(other, 0.01)', { fxDiff });
  const highlightClipRatio = clipHighlightRatio({ width: 2, height: 2, luma: Uint8Array.of(255, 200, 200, 200) });
  reject('highlight_clip_ratio()', { highlightClipRatio }, null);
  const frames = [sample(8, {}, { stats: { luma: { p99: 1.2 }, clipHigh: 0.03 } })];
  reject('luma_p99()', { frames }, 8);
  reject('highlight_clip_ratio()', { frames }, 8);
});

test('全片逐镜头断言：只取第一镜的证据不能替第二镜报通过', () => {
  const measured = { queries: [query(4, 'intersect', pair(0))], frames: [sample(4, { motion: motion(0) })] };
  for (const expr of ['no_intersect(hero, ring)', 'at_rest(hero)', 'bbox_w(hero) >= 0.5']) {
    assert.equal(evaluate(expr, measured, cutFilm).status, 'skipped', expr);
    pass(`${expr} @ shot(open)`, measured, cutFilm);
  }
});

const readback = () => ({ output: { frames: 24, durationSec: 1, colorTag: 'bt709/bt709/bt709/tv' }, audio: { truePeakDbtp: -1 } });
test('encoded_readback：接受两种 BT.709 标签、半帧内时长误差；无声片不索要真峰值', () => {
  const expr = 'encoded_readback()';
  pass(expr, readback());
  const m = readback();
  delete m.output.colorTag;
  Object.assign(m.output, { colorPrimaries: 'bt709', colorSpace: 'bt709', colorTrc: 'bt709', colorRange: 'tv', durationSec: 1 - 0.49 / 24 });
  pass(expr, m);
  pass(expr, { output: m.output }, { ...film, audio: { mode: 'none' } });
});

test('encoded_readback：错标、切短两帧、时长超过半帧、AAC 峰值反弹或任一字段缺测均 fail', () => {
  const expr = 'encoded_readback()';
  for (const [edit, frame] of [
    [(m) => { m.output.colorTag = 'bt709/bt709/bt709/pc'; }],
    [(m) => { m.output.colorTag = 'bt709'; }],
    [(m) => { m.output.frames -= 2; }, 22],
    [(m) => { m.output.durationSec = 1 + 0.51 / 24; }],
    [(m) => { m.audio.truePeakDbtp = -0.3; }],
    [(m) => { delete m.output.colorTag; }], [(m) => { delete m.output.frames; }],
    [(m) => { delete m.output.durationSec; }], [(m) => { delete m.audio; }],
    [(m) => { m.audio.truePeakDbtp = NaN; }],
  ]) {
    const m = readback(); edit(m); reject(expr, m, frame);
  }
  reject(expr, {});
});

test('template:assembly@1 与 floor@1 一起生效，必填 mustSee 不能留空', () => {
  const f = { ...cutFilm, predicates: { base: ['floor@1', 'template:assembly@1'] } };
  const tpl = registeredTemplate('assembly', 1);
  const entities = { open: ['shaft', 'pin', 'ring'], hold: ['shaft', 'pin', 'ring'] };
  const guarded = enforcePredicateFloor(f, tpl, { entities });
  assert.equal(guarded.ok, true, JSON.stringify(guarded.violations));
  assert.equal(guarded.items.filter((it) => it.source === 'template:assembly@1').length, 4);
  const missing = structuredClone(f);
  missing.shots[1].roles.mustSee = [];
  assert.ok(enforcePredicateFloor(missing, tpl, { entities }).violations.some((v) => v.code === 'role-missing'));
});

const assemblyEvidence = () => ({
  cuts: [12], frames: [4, 16].map((i) => sample(i, { motion: motion(0) })),
  queries: [4, 16].map((i) => query(i, 'intersect', pair(0), pair(0, 'shaft', 'pin'))),
});
for (const [name, edit, at] of [
  ['inside_frame', (m) => { m.frames[0].meta.entities[0].bbox2d[0] = 2; }, 4],
  ['at_rest', (m) => { m.frames[1].meta.entities[0].motion = motion(0.002); }, 16],
  ['no_intersect', (m) => { m.queries[1].result.items[1].value = 0.0033; }, 16],
  ['cut_at', (m) => { m.cuts = []; }, 12],
]) {
  test(`template:assembly@1：只破坏 ${name}，模板四项中恰有相应一项失败`, () => {
    const t = registeredTemplate('assembly', 1);
    assert.equal(t?.version, '1.0.0');
    assert.deepEqual(t.roles, ['hero', 'mustSee']);
    assert.deepEqual(t.items.map((it) => it.uses), [['inside_frame'], ['at_rest'], ['no_intersect'], ['cut_at', 'no_cut']]);
    const m = assemblyEvidence();
    const run = () => t.items.map((item) => evaluateItem(item, cutFilm, m));
    assert.deepEqual(run().map((r) => r.status), Array(4).fill('pass'));
    edit(m);
    const results = run();
    assert.deepEqual(results.map((r) => r.status), t.items.map((it) => it.uses.includes(name) ? 'fail' : 'pass'));
    const failed = results.flatMap((r) => r.results).filter((r) => r.status === 'fail');
    assert.deepEqual(failed.map((r) => r.counterexampleFrame), [at]);
  });
}

test('O9 → M3：逐帧原始亮度读数和切点读数直接进入断言，报告反白和首帧重影的位置', async () => {
  const { lumaPercentile, cutGhost } = await import('../observe/index.mjs');
  const frames = (codes) => codes.map((v, i) => ({ frame: i + 11, width: 8, height: 8, data: new Uint8Array(64).fill(v) }));
  const clean = frames([20, 220, 220]);
  pass('luma_p99()', { lumaPercentile: lumaPercentile(clean) });
  pass('no_ghost(shots)', { cutGhost: cutGhost(clean, { cuts: [12] }) }, cutFilm);
  const blend = frames([20, 180, 220]); // (1−0.20)×220 + 0.20×20
  reject('no_ghost(shots)', { cutGhost: cutGhost(blend, { cuts: [12] }) }, 12, cutFilm);
  const luma = { lumaPercentile: lumaPercentile(frames([20, 255, 220])) };
  reject('luma_p99()', luma, 12);
  pass('luma_p99() @ [13,14)', luma);
});
