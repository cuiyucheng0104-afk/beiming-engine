import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { findBlender, loadCards, startSource } from '../sources/blender/host.mjs';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import { dataValidators } from './sweep-schema.mjs';

const BEIMING = fileURLToPath(new URL('../', import.meta.url));
const BLENDER = process.env.BLENDER_BIN || findBlender();
const CARDS = [
  ['mat.bevel-node', 'material/bevel-node', 'target', { material: 'steel' }, { object: 'box', material: 'steel' }],
  ['mat.ao-ink', 'material/ao-ink', 'target', { object: 'plate' }, { object: '' }],
  ['look.plated', 'material/look-plated', 'target', { material: 'steel' }, {}],
  ['form.primitives', 'form/primitives', 'spec', { kind: 'cylinder', radiusM: 0.4, heightM: 1 }, { kind: 'box', sizeM: [0, 1, 1] }],
  ['form.superloft', 'form/superloft', 'sections', [
    { rx: 0.6, ry: 0.8, exponent: 2, center: [0, 0, 0] },
    { rx: 0.8, ry: 0.6, exponent: 8, center: [0, 0, 1], twistDeg: 45 },
  ], [{ rx: 1, ry: 1, exponent: 0.5, center: [0, 0, 0] }]],
];
const dirs = CARDS.map(([, dir]) => `cards/${dir}`);
const files = ['card.json', 'index.py', 'schema.json', 'selftest.test.mjs'];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('T14 五张卡通过卡契约、注册、Ajv 数据校验与泄露扫描', async () => {
  const library = await loadCards(dirs);
  const registry = createCardRegistry(Object.values(library).map(({ card }) => card), { allowReproduced: true });
  for (const [id, dir, dataParam, good, bad] of CARDS) {
    const kind = dir.split('/')[0];
    const base = join(BEIMING, 'cards', dir);
    const card = readJson(join(base, 'card.json'));
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, id);
    assert.deepEqual([card.id, card.version, card.kind, card.visibleToAgent, card.livesIn],
      [id, '1.0.0', kind, true, ['source:blender']]);
    assert.deepEqual(card.impl, [{ livesIn: 'source:blender', entry: `cards/${dir}/index.py`, shape: 'create',
      hosts: [{ host: 'cycles', version: '5.2.0' }], selftest: `cards/${dir}/selftest.test.mjs` }]);
    assert.deepEqual(card.exams, id === 'form.primitives' ? ['1-2', `cal:${id}`] : [`cal:${id}`]);
    assert.deepEqual(card.status, [{ level: 'reproduced', host: 'cycles', source: '5.2.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]);
    assert.equal(readJson(join(BEIMING, 'calib', card.calibration, 'scene.json')).id, card.calibration);
    assert.deepEqual(readdirSync(base).sort(), files);
    for (const file of files) assert.deepEqual(scanCardLeaks(readFileSync(join(base, file), 'utf8')), [], `${dir}/${file}`);
    assert.equal(registry.getCard(`${id}@1`)?.id, id);
    assert.ok(registry.searchCards({ kind, livesIn: 'source:blender', q: card.title }).some((hit) => hit.id === id));
    const [[name, validate]] = dataValidators(card);
    assert.equal(name, dataParam);
    assert.equal(card.params[name].schema, 'schema.json');
    for (const value of [resolveParams(card)[name], good]) assert.ok(validate(value), JSON.stringify(validate.errors));
    assert.equal(validate(bad), false, id);
  }
  assert.deepEqual(scanCardLeaks(readFileSync(fileURLToPath(import.meta.url), 'utf8')), []);
  const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  const entry = changelog.split('\n').find((line) => /^- Blender 卡库新增 M3 T14/.test(line));
  assert.ok(entry);
  assert.deepEqual(scanCardLeaks(entry), []);
});

test('T14 离线自测各自有通过用例且清单内无 Python 字节码', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const dir of dirs) {
    const base = join(BEIMING, dir);
    const run = spawnSync(process.execPath, ['--test', join(base, 'selftest.test.mjs')], { encoding: 'utf8', timeout: 30000, env });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /pass [1-9]/);
    assert.deepEqual(readdirSync(base).sort(), files);
  }
});

const size = [120, 100];
const count = size[0] * size[1];
const luminance = (bytes, i) => [0.2126, 0.7152, 0.0722].reduce((sum, w, c) => sum + w * bytes.readFloatLE(16 * i + 4 * c), 0);
const instance = (as, id, params) => ({ as, use: `${id}@1`, params });
const primitive = (name, spec) => instance(name, 'form.primitives', { spec: { name, ...spec } });
const orbit = (params = {}) => instance('cam', 'camera.orbit', {
  target: [0, 0.6, 0], distance: 3.8, elevationDeg: 23, startAzimuthDeg: 28, turns: 0, ...params,
});
const finish = (object, params = {}) => instance('look', 'look.plated', { target: { object }, ...params });

function entity(render, name) {
  const hit = render.meta.entities.find((e) => e.name === name);
  assert.ok(hit?.pxArea > 0, `${name} 必须可见`);
  return hit;
}

function screenPoint({ meta: { camera } }, point) {
  const { world, proj } = camera;
  const offset = point.map((value, i) => value - world[12 + i]);
  const view = [0, 1, 2].map((i) => offset.reduce((sum, value, j) => sum + world[4 * i + j] * value, 0)).concat(1);
  const [x, y, w] = [0, 1, 3].map((i) => view.reduce((sum, value, j) => sum + proj[4 * j + i] * value, 0));
  return [(1 + x / w) * size[0] / 2, (1 - y / w) * size[1] / 2];
}

function comparison(a, b, name, around = []) {
  const [aId, bId] = [entity(a, name).id, entity(b, name).id];
  const focus = around.map((point) => screenPoint(a, point));
  let common = 0, silhouette = 0, changed = 0, darkened = 0, maxDarkening = 0, sum = 0;
  let regionChanged = 0, regionDarkened = 0;
  for (let i = 0; i < count; i++) {
    const inA = a.ids.readUInt32LE(4 * i) === aId;
    const inB = b.ids.readUInt32LE(4 * i) === bId;
    if (inA !== inB) silhouette++;
    if (!(inA && inB)) continue;
    common++;
    const delta = luminance(a.color, i) - luminance(b.color, i);
    sum += Math.abs(delta);
    if (Math.abs(delta) > 0.01) changed++;
    if (delta < -0.02) darkened++;
    const x = (i % size[0]) + 0.5, y = Math.floor(i / size[0]) + 0.5;
    if (focus.some(([px, py]) => Math.hypot(x - px, y - py) <= 5)) {
      if (Math.abs(delta) > 0.01) regionChanged++;
      if (delta < -0.02) regionDarkened++;
    }
    maxDarkening = Math.max(maxDarkening, -delta);
  }
  assert.ok(common > 100);
  return { common, silhouette, changed, darkened, maxDarkening, meanAbsLuma: sum / common,
    ...(around.length ? { regionChanged, regionDarkened } : {}) };
}

function measure(render, name, bbox) {
  const hit = entity(render, name);
  assert.ok(hit.bbox3d.every((value, i) => Math.abs(value - bbox[i]) < 1e-6), JSON.stringify(hit.bbox3d));
  let lit = 0;
  for (let i = 0; i < count; i++) {
    if (render.ids.readUInt32LE(4 * i) === hit.id && luminance(render.color, i) > 0.001) lit++;
  }
  assert.ok(lit > 100, `${name} 的非黑像素 ${lit}`);
  return { bbox: hit.bbox3d, lit };
}

test('T14 Blender 5.2 Cycles 五卡实渲、变异对照和异序重渲', { skip: !BLENDER && '本机没有 Blender', timeout: 360000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-t14-'));
  let src;
  try {
    const allDirs = [...dirs, 'cards/camera/orbit'];
    const library = await loadCards(allDirs);
    // CPU 提供固定采样的逐位对照，也覆盖 Cycles Bevel 在 GPU 后端缺少支持的机器。
    src = await startSource({ blenderBin: BLENDER, cards: allDirs, device: 'cpu', limitMs: 90000 });
    const version = src.caps().version;
    if (!/^5\.2\./.test(version)) return t.skip(`本机 Blender ${version} 缺少 5.2 宿主`);
    t.diagnostic(`Blender ${version}，Cycles ${src.device.backend}，${size.join('×')}，每像素 32 样本`);
    const contracts = await loadContracts();
    const film = 'f_t14';
    const seed = 1407;
    const lock = {
      film, seeds: { s01: seed }, shots: { s01: { shutterSamples: 1 } },
      sources: { blender: { version, host: 'cycles' } },
      cards: Object.fromEntries(Object.entries(library).map(([id, { card, sha256 }]) => [id, { version: card.version, impl: card.livesIn, sha256 }])),
    };
    async function render(label, cards, frames = [0]) {
      const dir = join(workspace, label);
      const session = await src.open({ film, output: { size, fps: '24/1' }, shot: {
        id: 's01', in: 0, out: 21, seed, colorRef: 'scene', source: 'blender', host: 'cycles', mode: 'cards-data', cards,
      } }, { lock, workspace: dir, tier: 'final', filmDir: BEIMING });
      try {
        const output = [];
        for (const f of frames) {
          const { meta, layers } = await session.render(f, { scale: 1, samples: 32 }, ['color', 'objectId', 'meta']);
          const { schemaErrors, violations } = contracts.validate(meta);
          assert.deepEqual({ schemaErrors, violations }, { schemaErrors: [], violations: {} });
          assert.deepEqual(meta.size, size);
          assert.equal(meta.shotFrame, f);
          assert.deepEqual(meta.ext['blender.load'].cards.filter((entry) => entry.calledVia === 'cards.use').map((entry) => entry.card),
            cards.filter((card) => card.as !== 'cam').map((card) => card.use));
          const color = await readFile(join(dir, layers.color.file));
          const ids = await readFile(join(dir, layers.objectId.file));
          assert.equal(color.length, count * 16);
          assert.equal(ids.length, count * 4);
          const hash = `sha256:${createHash('sha256').update(color).digest('hex')}`;
          assert.equal(layers.color.hash, hash);
          output.push({ meta, color, ids, hash });
        }
        return output;
      } finally {
        await session.close();
      }
    }

    await t.test('mat.bevel-node 的着色倒角改变立方体边缘高光', async (s) => {
      const cards = (enabled) => [orbit(), primitive('cube', { kind: 'box', sizeM: [1, 1, 1], center: [0, 0.6, 0] }),
        finish('cube'), instance('bevel', 'mat.bevel-node', { target: { material: 'cube.surface' }, radiusM: 0.12, samples: 8, enabled })];
      const [on] = await render('bevel-on', cards(true));
      const [off] = await render('bevel-off', cards(false));
      const delta = comparison(on, off, 'cube', [[0.5, 0.65, 0.5], [0.2, 1.1, 0.5], [0.5, 1.1, 0.2]]);
      assert.equal(on.meta.readings['bevel.nodeCount'], 1);
      assert.equal(off.meta.readings['bevel.nodeCount'], 0);
      assert.equal(delta.silhouette, 0);
      assert.ok(delta.changed > 60 && delta.regionChanged > 30 && delta.meanAbsLuma > 0.002, JSON.stringify(delta));
      s.diagnostic(JSON.stringify({ ...delta, on: on.hash, off: off.hash }));
    });

    await t.test('mat.ao-ink 将板件凹槽的内角压暗', async (s) => {
      const cards = (enabled) => [orbit({ target: [0, 0.32, 0], elevationDeg: 48, distance: 3.3 }),
        primitive('panel', { kind: 'slotted_plate', sizeM: [1.6, 0.5, 1.4], center: [0, 0.3, 0], slotSizeM: [0.9, 0.8], slotDepthM: 0.36 }),
        finish('panel'), instance('ink', 'mat.ao-ink', { target: { object: 'panel' }, distanceM: 0.45, samples: 16, inkStrength: 1, enabled })];
      const [on] = await render('ink-on', cards(true));
      const [off] = await render('ink-off', cards(false));
      const delta = comparison(on, off, 'panel', [[-0.39, 0.19, -0.32], [0, 0.19, -0.35], [-0.40, 0.19, 0]]);
      assert.equal(on.meta.readings['ink.aoCount'], 1);
      assert.equal(off.meta.readings['ink.aoCount'], 0);
      assert.equal(delta.silhouette, 0);
      assert.ok(delta.darkened > 40 && delta.regionDarkened > 40 && delta.maxDarkening > 0.06, JSON.stringify(delta));
      s.diagnostic(JSON.stringify({ ...delta, on: on.hash, off: off.hash }));
    });

    await t.test('look.plated 的灯条闭式扫光，关闭后两帧逐位一致', async (s) => {
      const cards = (sweepEnabled, variant = 'plated') => [orbit(),
        primitive('sample', { kind: 'box', sizeM: [1.3, 1, 1], center: [0, 0.6, 0], bevelM: 0.18, bevelSegments: 4 }),
        finish('sample', { sweepEnabled, variant, stripCount: 5, sweepRateDeg: 3 })];
      const [f0, f20] = await render('sweep-on', cards(true), [0, 20]);
      const [fixed0, fixed20] = await render('sweep-off', cards(false), [0, 20]);
      const [silver] = await render('silver', cards(false, 'silver'));
      const delta = comparison(f0, f20, 'sample');
      assert.notEqual(f0.hash, f20.hash);
      assert.ok(delta.changed > 60, JSON.stringify(delta));
      assert.ok(f0.color.equals(fixed0.color));
      assert.ok(fixed0.color.equals(fixed20.color));
      assert.notEqual(silver.hash, fixed0.hash);
      assert.equal(f0.meta.readings['look.azimuthDeg'], 0);
      assert.equal(f20.meta.readings['look.azimuthDeg'], 60);
      assert.equal(fixed20.meta.readings['look.azimuthDeg'], 0);
      s.diagnostic(JSON.stringify({ ...delta, f0: f0.hash, f20: f20.hash, fixed0: fixed0.hash, fixed20: fixed20.hash, silver: silver.hash }));
    });

    await t.test('form.primitives 的倒角盒、两端倒角圆柱与开槽板尺寸和可见像素', async (s) => {
      const [frame] = await render('primitives', [orbit({ distance: 5.9, target: [0, 0.5, 0], elevationDeg: 35, startAzimuthDeg: 12 }),
        primitive('box', { kind: 'box', sizeM: [1, 0.8, 0.6], center: [-1.1, 0.5, 0], bevelM: 0.13, bevelSegments: 3 }),
        primitive('cylinder', { kind: 'cylinder', radiusM: 0.28, heightM: 0.9, center: [0, 0.5, 0], bevelM: 0.09, segments: 19 }),
        primitive('plate', { kind: 'slotted_plate', sizeM: [1.1, 0.35, 1], center: [1.1, 0.5, 0], slotSizeM: [0.4, 0.62], slotDepthM: 0.35 }),
        finish('box')]);
      s.diagnostic(JSON.stringify({
        box: measure(frame, 'box', [-1.6, 0.1, -0.3, -0.6, 0.9, 0.3]),
        cylinder: measure(frame, 'cylinder', [-0.28, 0.05, -0.28, 0.28, 0.95, 0.28]),
        plate: measure(frame, 'plate', [0.55, 0.325, -0.5, 1.65, 0.675, 0.5]),
        vertices: ['box', 'cylinder', 'plate'].map((name) => frame.meta.readings[`${name}.vertexCount`]),
        hash: frame.hash,
      }));
    });

    await t.test('form.superloft 的 n=2 与 n=8 几何、像素及异序重渲', async (s) => {
      const cards = (exponent) => [orbit({ elevationDeg: 13, startAzimuthDeg: 15, turns: 0.2, frames: 40 }),
        instance('loft', 'form.superloft', { radialSegments: 48, sections: [-0.6, 0, 0.6].map((z, i) => ({
          rx: i === 1 ? 0.66 : 0.49, ry: i === 1 ? 0.52 : 0.40, exponent, center: [0, 0.65, z], twistDeg: i * 8,
        })) }), finish('superloft')];
      const [round0, round20] = await render('round-forward', cards(2), [0, 20]);
      const [roundBack20, roundBack0] = await render('round-back', cards(2), [20, 0]);
      const [square0, square20] = await render('square-forward', cards(8), [0, 20]);
      const [squareBack20, squareBack0] = await render('square-back', cards(8), [20, 0]);
      for (const [a, b] of [[round0, roundBack0], [round20, roundBack20], [square0, squareBack0], [square20, squareBack20]]) {
        assert.ok(a.color.equals(b.color));
        assert.ok(a.ids.equals(b.ids));
      }
      const delta = comparison(round0, square0, 'loft');
      assert.ok(delta.silhouette > 40 && delta.changed > 40, JSON.stringify(delta));
      const reading = (frame, key) => frame.meta.readings[`loft.${key}`];
      for (const frame of [round0, square0]) assert.equal(reading(frame, 'vertexCount'), 146);
      const vertexDeltaM = reading(square0, 'meanSectionRadiusM') - reading(round0, 'meanSectionRadiusM');
      assert.ok(vertexDeltaM > 0.04, String(vertexDeltaM));
      s.diagnostic(JSON.stringify({ ...delta, vertices: 146, vertexDeltaM,
        round: [round0.hash, round20.hash], square: [square0.hash, square20.hash], reverseMatches: 4 }));
    });
  } finally {
    try { await src?.stop(); } finally { await rm(workspace, { recursive: true, force: true }); }
  }
});
