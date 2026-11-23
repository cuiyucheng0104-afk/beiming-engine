import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPureFunctionGate } from '../verify/l2.mjs';
import { loadCards, startSource } from '../host/page/host.mjs';
import { loadQuestion, measure } from '../bench/negatives/level-2-b/run-b6.mjs';
import { readMoveStarts, score } from '../bench/questions/level-2-b/evaluate-b4.mjs';
import { evaluate as camera } from './camera/cue-kf/evaluate.mjs';
import { createCardRegistry } from './registry.mjs';
import { resolveParams } from './runtime.mjs';
import { dataValidators } from './sweep-schema.mjs';
import { evaluate as narration } from './time/narration/evaluate.mjs';
import { scanCardLeaks, validateCard } from './validate-card.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const spec = [
  ['mechanism/page-det2d', 'page.det2d', 'source:three', 'create', false, '18-1'],
  ['camera/cue-kf', 'camera.cue-kf', 'data', 'evaluate', true, '18-2'],
];
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('T8 成卡：C1 原文与对象、校准场景、自测入口、题号；机制卡只可按名取，不在搜索结果里', async () => {
  const cards = [];
  for (const [dir, id, landing, shape, visible, exam] of spec) {
    const raw = readFileSync(join(here, dir, 'card.json'), 'utf8'), card = JSON.parse(raw);
    cards.push(card);
    // C1 的扫描器可读未解析的原文（包括重复键），结构与 CF 校验器只收对象。
    for (const input of [raw, card]) assert.deepEqual(scanCardLeaks(input), [], id);
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, id);
    for (const file of readdirSync(join(here, dir), { withFileTypes: true, recursive: true }).filter((d) => d.isFile())) {
      assert.deepEqual(scanCardLeaks(readFileSync(join(file.parentPath, file.name), 'utf8')), [], `${dir}/${file.name}`);
    }
    assert.deepEqual([card.id, card.kind, card.livesIn, card.visibleToAgent], [id, dir.split('/')[0], [landing], visible]);
    assert.deepEqual(card.status.map((row) => row.level), ['reproduced']);
    assert.ok(card.exams.includes(exam) && loadQuestion(exam).needs.includes(id));
    assert.equal(json(join(here, '../calib', card.calibration, 'scene.json')).id, card.calibration);
    const [impl] = card.impl;
    assert.deepEqual([card.impl.length, impl.livesIn, impl.shape, impl.selftest], [1, landing, shape, `cards/${dir}/selftest.test.mjs`]);
    assert.ok(impl.entry.startsWith(`cards/${dir}/`) && existsSync(join(here, '..', impl.selftest)));
    const entry = await import(pathToFileURL(join(here, '..', impl.entry)).href);
    assert.deepEqual(['create', 'evaluate'].filter((name) => typeof entry[name] === 'function'), [shape]);
    const defaults = resolveParams(card, {});
    for (const [name, validate] of dataValidators(card)) assert.ok(validate(defaults[name]), `${id}.${name}: ${JSON.stringify(validate.errors)}`);
  }
  assert.deepEqual(scanCardLeaks(readFileSync(fileURLToPath(import.meta.url), 'utf8')), []);
  const registry = createCardRegistry(cards, { allowReproduced: true });
  assert.equal(registry.getCard('page.det2d@1')?.id, 'page.det2d');
  assert.deepEqual(registry.searchCards().map(({ id }) => id), ['camera.cue-kf']);
});

test('18-1：真实页面三场纸色读回、顺序／乱序／独立帧及 B4 判分', async (t) => {
  const { verifyPageEvidence } = await import(pathToFileURL(join(here, 'mechanism/page-det2d/evidence.mjs')).href);
  await verifyPageEvidence(t);
});

test('18-1：B6 仅移去纸底，字幕、淡出与留白不变，独立打穿底色线', () => {
  const question = loadQuestion('18-1');
  const negative = score(question, measure('18-1', { pageCanvas: false }).readings);
  assert.deepEqual(negative.items.filter((i) => !i.pass).map((i) => i.metric), ['color.palette']);
});

// 只看一小块连续灰度纹理；在地图平面上按卡给的中心（像素）、缩放取样。
// 判分器只能看到画面，拿不到关键帧声明、速度或事件。用原题的 600 帧窗口与搜索参数。
const size = [48, 27], question = loadQuestion('18-2'), { frames, fps } = question.deliverable;
const args = question.scoring[0].args;
const shot = { id: 'map', in: 0, frames };
function wordEvents(at) {
  const phrase = ['region north', 'region coast'];
  const words = at.flatMap((startSec, i) => phrase[i].split(' ').map((word, j) => ({ scene: 'map', word, startSec: startSec + j * 0.2, endSec: startSec + (j + 1) * 0.2 })));
  const triggers = phrase.map((p, i) => ({ id: args.events[i], scene: 'map', phrase: p }));
  const { cues } = narration({ fps, shot }, { timing: { scenes: [{ scene: 'map', startSec: 0 }], words }, triggers, anticipationSec: 0 }, 0, 0);
  return cues.events;
}
const segments = [
  { cue: 'cue_a', from: [0, 0], to: [90, 0], zoomFrom: 1, zoomTo: 1.08 },
  { cue: 'cue_b', from: [90, 0], to: [90, 90], zoomFrom: 1.08, zoomTo: 1.02 },
].map((move) => ({ ...move, durationFrames: 45 }));
const advanced = segments.map((move, i) => ({ ...move, cueOffsetFrames: -args.leadFrames[i] }));
const inputsOf = (events) => ({ events, fps, shot, size, seed: 182 });
function mapFrame({ panX, panY, zoom }) {
  const [w, h] = size, frame = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x - (w - 1) / 2) / zoom + panX, v = (y - (h - 1) / 2) / zoom + panY;
    frame[y * w + x] = Math.round(128 + 43 * Math.sin(u * 0.37 + v * 0.13) + 31 * Math.cos(v * 0.69 - u * 0.05) + 35 * Math.sin(u * 0.17 - v * 0.29));
  }
  return frame;
}
function observeMoves(events, moves) {
  const inputs = inputsOf(events);
  return readMoveStarts((f) => mapFrame(camera(inputs, { moves }, f, 0)), [0, frames], size, args);
}
const verdict = (events, markFrames) => score(question, { 'narration.timing': { eventFrames: events.map((item) => item.frame), markFrames } });

test('18-2：旁白卡 → 命名事件 → 运镜卡 → 地图像素 → B4；换配音后旧固定帧和零提前量都不过', (t) => {
  const events = wordEvents([5, 14]), retimed = wordEvents([6.2, 14.8]);
  assert.deepEqual(events.map(({ frame }) => frame), [150, 420]);
  assert.deepEqual(retimed.map(({ frame }) => frame), [186, 444]);
  const observed = observeMoves(events, advanced), updated = observeMoves(retimed, advanced);
  for (const [source, marks] of [[events, observed], [retimed, updated]]) {
    const expected = source.map(({ frame }, i) => frame - args.leadFrames[i]);
    assert.equal(marks.length, expected.length);
    assert.ok(marks.every((f, i) => Math.abs(f - expected[i]) <= 1), `应起 ${expected}，读回 ${marks}`);
    assert.deepEqual([verdict(source, marks).pass, verdict(source, marks).score], [true, 1]);
    t.diagnostic(`18-2 触发词 ${source.map((e) => e.frame)}；应起 ${expected}；从地图读回 ${marks}；B4 1.0`);
  }
  // 冻结旧时间线上的相机帧，只有旁白重新配时。读数仍是两次实测运动，不是缺读数导致的 0 分。
  assert.equal(verdict(retimed, observed).score, 0);
  const late = observeMoves(events, advanced.map((move) => ({ ...move, cueOffsetFrames: move.cueOffsetFrames + 2 })));
  assert.deepEqual(late, observed.map((frame) => frame + 2), '仅错位两帧，仍应检测到相同的两次运动');
  assert.equal(verdict(events, late).score, 0);
  const onCue = observeMoves(events, segments);
  assert.equal(onCue.length, events.length);
  assert.ok(onCue.every((f, i) => Math.abs(f - events[i].frame) <= 1));
  assert.equal(verdict(events, onCue).score, 0, 'B6 关卡模型：在词上启动不满足题面提前量');
  t.diagnostic(`默认零偏移读回 ${onCue}；在 18-2 题面下，零提前量和换配音后沿用固定帧均为 0 分`);
});

test('真实页面宿主：非首镜头按局部 f 解词，tracks.camera 真正控制元数据中的世界矩阵和视场', async (t) => {
  const id = 'camera.cue-kf', dir = 'cards/camera/cue-kf', library = await loadCards([dir]);
  let source;
  try { source = await startSource({ cards: [dir] }); } catch (e) {
    if (!/executable (doesn't|does not) exist/i.test(e.message)) throw e;
    return t.skip('没有安装 Chromium 可执行文件：未运行页面相机读回');
  }
  const workspace = await mkdtemp(join(tmpdir(), 'cue-kf-host-'));
  try {
    const events = wordEvents([5, 14]), params = { moves: advanced };
    const input = { film: 'map', output: { size, fps }, events: { format: 'events/0.1', film: 'map', fps, frames, events },
      shot: { id: 'detail', in: 120, out: frames, host: 'page', source: 'three', mode: 'cards-data', colorRef: 'display', cards: [{ as: 'move', use: `${id}@1`, params }] } };
    const { card, sha256 } = library[id];
    const lock = { film: input.film, seeds: { detail: 1 }, shots: { detail: { shutterSamples: 1 } }, cards: { [id]: { version: card.version, sha256, impl: card.livesIn } } };
    const session = await source.open(input, { tier: 'final', lock, workspace, filmDir: join(here, 'camera/cue-kf') });
    try {
      for (const f of [0, 30, 291, 330]) {
        const { meta } = await session.render(f, {}, ['meta']);
        const expected = camera({ size, events, shot: { in: input.shot.in } }, params, f, 0).camera;
        assert.deepEqual(meta.camera.world.slice(12, 15), expected.pos);
        assert.equal(meta.camera.fovYDeg, expected.fovDeg);
        assert.equal(meta.ext['page.load'].camera.from, 'tracks');
      }
    } finally { await session.close(); }
  } finally { await source.stop(); await rm(workspace, { recursive: true, force: true }); }
});

test('运镜 L2：整镜 600 帧顺序、乱序和单帧新输入在同一子帧逐字节一致；不会改写上游事件', async () => {
  const initial = [inputsOf(wordEvents([5, 14])), { moves: advanced }];
  const adapter = { open() {
    const [inputs, params] = structuredClone(initial);
    return {
      render(f) {
        const view = camera(inputs, params, f, 0.5), { pos, quat, fovDeg } = view.camera;
        assert.deepEqual(view.tracks.camera, view.camera);
        // 固定字段顺序和 IEEE 754 编码，包含符号零；V8 对同值对象可选不同的内部序列化表示。
        return Float64Array.of(view.panX, view.panY, view.zoom, ...view.matrix, ...pos, ...quat, fovDeg, view.speed);
      },
      close() { assert.deepEqual([inputs, params], initial); },
    };
  } };
  const gate = await runPureFunctionGate(adapter, Array.from({ length: frames }, (_, f) => f), { compare: 'hash' });
  assert.ok(gate.ok && gate.bitExact, JSON.stringify(gate.mismatches.slice(0, 3)));
  const probe = adapter.open();
  assert.notDeepEqual(probe.render(134), probe.render(136), '运动时刻与静止时刻应读回不同状态');
  probe.close();
});
