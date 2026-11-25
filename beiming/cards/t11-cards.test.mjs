import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { findBlender, loadCards, startSource } from '../sources/blender/host.mjs';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import { dataValidators } from './sweep-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEIMING = dirname(HERE);
const BLENDER = process.env.BLENDER_BIN || findBlender();
const CARDS = [
  { id: 'asset.bbox-proxy', dir: 'cards/asset/bbox-proxy', entry: 'proxy.py', exams: ['1-2', 'cal:asset.bbox-proxy'] },
  { id: 'asset.stl-kit', dir: 'cards/asset/stl-kit', entry: 'stl_kit.py', exams: ['cal:asset.stl-kit'] },
];
const dirs = CARDS.map(({ dir }) => dir);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const cardFiles = (dir) => readdirSync(join(BEIMING, dir)).sort();
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const plate = Buffer.alloc(84 + 50);
plate.writeUInt32LE(1, 80);
// STL Z 向上，输入毫米。归一后的三角面跨 X、Y 与 Z 三轴。
[0, 1, 0, 0, 3000, -200, 500, 3100, -200, 0, 3000, 250].forEach((v, i) => plate.writeFloatLE(v, 84 + 4 * i));
const plateBox = [0, -0.2, -3.1, 0.5, 0.25, -3];
const capBox = [0.61, -0.2, -3.2, 0.86, 0.2, -2.92];
const bracketBox = [-0.75, -0.25, -3.15, -0.35, 0.25, -2.9];
const half = (box) => box.map((x) => x / 2);
const kit = { parts: [{ name: 'plate', bytes: plate.toString('base64') }, { name: 'cap', fallbackBbox: capBox }] };
const spec = {
  envelope: half([-1, -0.5, -3.4, 1, 0.5, -2.8]),
  parts: [
    { name: 'plate', entity: 'plate', bbox: half(plateBox), clearances: [{ against: 'bracket', minGap: 0.15 }] },
    { name: 'bracket', entity: 'absent_bracket', bbox: half(bracketBox) },
  ],
};

test('T11 卡文件、校准场景、注册表、数据 schema 与卡目录泄露检查', async () => {
  const library = await loadCards(dirs);
  const registry = createCardRegistry(Object.values(library).map(({ card }) => card), { allowReproduced: true });
  for (const { id, dir, entry, exams } of CARDS) {
    const card = readJson(join(BEIMING, dir, 'card.json'));
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, id);
    assert.deepEqual([card.id, card.version, card.kind, card.visibleToAgent, card.livesIn],
      [id, '1.0.0', 'asset', true, ['source:blender']]);
    assert.deepEqual(card.impl, [{ livesIn: 'source:blender', entry: `${dir}/${entry}`, shape: 'create',
      hosts: [{ host: 'cycles', version: '5.2.0' }], selftest: `${dir}/selftest.test.mjs` }]);
    assert.deepEqual(card.exams, exams);
    assert.deepEqual(card.status, [{ level: 'reproduced', host: 'cycles', source: '5.2.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]);
    assert.equal(card.calibration, 'probe-axes-turntable');
    assert.equal(readJson(join(BEIMING, 'calib', card.calibration, 'scene.json')).id, card.calibration);
    assert.deepEqual(cardFiles(dir), ['card.json', entry, 'schema.json', 'selftest.test.mjs'].sort());
    for (const f of cardFiles(dir)) assert.deepEqual(scanCardLeaks(readFileSync(join(BEIMING, dir, f), 'utf8')), [], `${dir}/${f}`);
    assert.equal(registry.getCard(`${id}@1`)?.id, id);
    assert.ok(registry.searchCards({ kind: 'asset', livesIn: 'source:blender', q: card.title }).some((hit) => hit.id === id));
    const [[name, validate]] = dataValidators(card);
    for (const value of [resolveParams(card)[name], name === 'spec' ? spec : kit]) {
      assert.equal(validate(value), true, JSON.stringify(validate.errors));
    }
    for (const value of [{ parts: [] }, { parts: [{ name: 'bad name', size: [0, 1, 1] }] }]) assert.equal(validate(value), false);
  }
  assert.deepEqual(scanCardLeaks(readFileSync(fileURLToPath(import.meta.url), 'utf8')), []);
});

test('T11 两张卡的离线自测均可独立运行，且导入不留下字节码', () => {
  for (const { dir, entry } of CARDS) {
    const run = spawnSync(process.execPath, ['--test', join(BEIMING, dir, 'selftest.test.mjs')], { encoding: 'utf8', timeout: 30000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(cardFiles(dir), ['card.json', entry, 'schema.json', 'selftest.test.mjs'].sort());
  }
});

test('T11 Blender 卡加数据实跑，两张卡均用缺件代理出帧并交元数据', { skip: !BLENDER && '本机没有 Blender', timeout: 180000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-t11-cards-'));
  let src;
  try {
    const library = await loadCards(dirs);
    src = await startSource({ blenderBin: BLENDER, cards: dirs, limitMs: 90000 });
    const version = src.caps().version;
    t.diagnostic(`Blender ${version}，Cycles ${src.device.backend}${src.device.gpu ? `（${src.device.gpu}）` : ''}`);
    assert.match(version, /^5\.2\./);
    const input = {
      film: 'f_t11', output: { size: [128, 96], fps: '24/1' },
      shot: {
        id: 's01', in: 0, out: 2, seed: 1107, colorRef: 'scene', source: 'blender', host: 'cycles', mode: 'cards-data',
        cards: [
          { as: 'kit', use: 'asset.stl-kit@1', params: { kit } },
          { as: 'proxy', use: 'asset.bbox-proxy@1', params: { spec, envelopeScale: 2 } },
        ],
      },
    };
    const lock = {
      film: input.film, seeds: { s01: input.shot.seed }, shots: { s01: { shutterSamples: 1 } },
      sources: { blender: { version, host: 'cycles' } },
      cards: Object.fromEntries(Object.entries(library).map(([id, { card, sha256 }]) => [id, { version: card.version, impl: card.livesIn, sha256 }])),
    };
    const env = { lock, tier: 'draft', workspace, filmDir: BEIMING };
    const session = await src.open(input, env);
    try {
      assert.deepEqual(session.manifest().entities.map((e) => e.name), ['kit.cap', 'kit.plate', 'proxy.bracket']);
      const { meta, layers } = await session.render(0, { scale: 1, samples: 1 }, ['color', 'objectId', 'meta']);
      const contracts = await loadContracts();
      const { schemaErrors, violations } = contracts.validate(meta);
      assert.deepEqual({ schemaErrors, violations }, { schemaErrors: [], violations: {} });
      assert.deepEqual(meta.size, [128, 96]);
      assert.deepEqual(meta.readings, {
        'kit.partCount': 2, 'kit.loadedCount': 1, 'kit.proxiedCount': 1, 'kit.totalTriangles': 13, 'kit.viewCount': 4,
        'proxy.partCount': 2, 'proxy.loadedCount': 1, 'proxy.missingCount': 1, 'proxy.proxiedCount': 1, 'proxy.ok': 1,
      });
      assert.deepEqual(meta.ext['blender.load'].cards.map(({ card, calledVia }) => [card, calledVia]),
        [['asset.stl-kit@1', 'cards.use'], ['asset.bbox-proxy@1', 'cards.use']]);
      const pixels = {};
      for (const key of ['color', 'objectId']) {
        const bytes = await readFile(join(workspace, layers[key].file));
        assert.equal(layers[key].hash, sha(bytes));
        assert.equal(bytes.length, 128 * 96 * 4 * (key === 'color' ? 4 : 1));
        pixels[key] = bytes;
      }
      const expected = { 'kit.cap': capBox, 'kit.plate': plateBox, 'proxy.bracket': bracketBox };
      for (const e of meta.entities) {
        assert.ok(e.pxArea > 0, e.name);
        assert.ok(e.bbox3d.every((n, i) => Math.abs(n - expected[e.name][i]) < 1e-6), `${e.name} 的世界包围盒`);
        let hits = 0;
        for (let i = 0; i < 128 * 96; i++) {
          if (pixels.objectId.readUInt32LE(4 * i) === e.id && pixels.color.readFloatLE(16 * i + 12) > 0) hits++;
        }
        assert.ok(hits > 20, `${e.name} 的可见像素 ${hits}`);
      }
      const second = await session.render(1, {}, ['meta']);
      assert.deepEqual(second.meta.readings, meta.readings);
    } finally {
      await session.close();
    }
    for (const [index, params, message] of [[0, { missingPolicy: 'error' }, /cap.*缺少 STL/], [1, { fallbackMissing: false }, /bracket missing-part/]]) {
      const bad = structuredClone(input);
      Object.assign(bad.shot.cards[index].params, params);
      await assert.rejects(() => src.open(bad, env), message);
    }
    for (const { dir, entry } of CARDS) assert.deepEqual(cardFiles(dir), ['card.json', entry, 'schema.json', 'selftest.test.mjs'].sort());
  } finally {
    try { await src?.stop(); } finally { await rm(workspace, { recursive: true, force: true }); }
  }
});
