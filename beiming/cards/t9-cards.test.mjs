import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { findBlender, loadAssets, loadCards, startSource } from '../sources/blender/host.mjs';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import { dataValidators } from './sweep-schema.mjs';

const dir = join(import.meta.dirname, 'assembly/dsl');
const id = 'assembly.dsl', ref = `${id}@1`;
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const triangle = { vertices: [[0,0,0], [1,0,0], [0,1,0]], faces: [[0,1,2]] };
async function bake(recipe, meshes, outPath) {
  const { evaluate } = await import('./assembly/dsl/bake.mjs');
  return evaluate({ recipe, meshes, outPath, engine: 'python' });
}

test('正式卡文件通过 validateCard', async () => {
  const card = await json(join(dir, 'card.json'));
  assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
});

test('双落点的清单、卡目录泄漏扫描、注册发现与参数 schema', async () => {
  const card = await json(join(dir, 'card.json'));
  assert.deepEqual(card.status, [{ level: 'reproduced', host: 'cycles', source: '5.2.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]);
  assert.deepEqual([card.kind, card.version, card.visibleToAgent, card.livesIn, card.exams],
    ['assembly','1.0.0',true,['bake','source:blender'],['cal:assembly.dsl']]);
  assert.deepEqual(card.impl.map(({ livesIn, entry, shape, hosts, selftest }) => [livesIn, entry, shape, hosts, selftest]), [
    ['bake','cards/assembly/dsl/bake.mjs','evaluate',[],'cards/assembly/dsl/selftest.test.mjs'],
    ['source:blender','cards/assembly/dsl/index.py','create',[{ host: 'cycles', version: '5.2.0' }],'cards/assembly/dsl/selftest.test.mjs'],
  ]);
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) assert.deepEqual(scanCardLeaks(await readFile(join(entry.parentPath, entry.name), 'utf8')), [], entry.name);
  }
  const registry = createCardRegistry([card], { allowReproduced: true });
  assert.deepEqual(registry.getCard(ref), card);
  assert.deepEqual(registry.searchCards({ kind: 'assembly', source: 'blender' }).map((row) => row.id), [id]);
  const validate = new Map(dataValidators(card)).get('baked');
  assert.ok(validate(resolveParams(card).baked));
  const example = await bake({ steps: [] }, { lid: triangle });
  assert.ok(validate(example), JSON.stringify(validate.errors));
  example.parts.lid.matrix4x4[2].pop();
  assert.equal(validate(example), false);
});

test('卡自测在独立 node --test 进程实际运行', async (t) => {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, ['--test','--test-reporter=tap',join(dir, 'selftest.test.mjs')], { env });
  assert.match(stdout, /pass [1-9]/);
  t.diagnostic(stdout.match(/# pass \d+/)[0]);
});

test('五件配方单行旋转变化仅影响选中的子树', async (t) => {
  const meshes = Object.fromEntries(['base','arm','pin','cap','foot'].map((n) => [n,triangle]));
  const recipe = { root: 'base', steps: [
    { op: 'attach', target: 'pin', parent: 'arm' }, { op: 'attach', target: 'cap', parent: 'pin' },
    { op: 'attach', target: 'arm', parent: 'base' }, { op: 'move', target: '*', delta: [1,2,3] },
    { op: 'rot', target: 'arm+', pivot: [1,0,0], axis: [0,1,0], angleDeg: 30 },
  ] };
  const before = await bake(recipe, meshes);
  recipe.steps[4].angleDeg = 45;
  const after = await bake(recipe, meshes);
  const changed = Object.keys(meshes).filter((n) => JSON.stringify(before.parts[n].matrix4x4) !== JSON.stringify(after.parts[n].matrix4x4));
  assert.deepEqual(changed, ['arm','pin','cap']);
  assert.deepEqual(after.parts.base, before.parts.base);
  assert.deepEqual(after.parts.foot, before.parts.foot);
  t.diagnostic('30° → 45°：arm、pin、cap 改变，base、foot 矩阵逐位相同');
});

const blender = process.env.BLENDER_BIN || findBlender();
test('真实 cards-data 经 Cycles 渲染，乱序回读起始、半程和到位姿态', { skip: !blender, timeout: 180000 }, async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'assembly-cycles-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const assetRef = 'asset:fixture@1', assetPath = join(work, 'kit.json'), outPath = join(work, 'asm.baked.json');
  const box = (at) => [{ shape: 'box', at, size: [0.4,0.2,0.1], material: 'blue' }];
  await writeFile(assetPath, JSON.stringify({ format: 'kit-spec/0.1',
    materials: { blue: { base: [0,0.2,1], metallic: 0, roughness: 0.5, emission: [0,0.2,1], strength: 1 } },
    parts: { arm: box([0,0,-2]), fixed: box([-0.4,0,-2]) },
  }));
  const name = 'kit.arm';
  const baked = await bake({ steps: [
    { op: 'rot', target: name, pivot: [0,0,-2], axis: [0,0,1], angleDeg: 90 },
    { op: 'move', target: name, delta: [0.2,0.2,-0.1] },
  ] }, { [name]: triangle }, outPath);
  const cards = ['cards/assembly/dsl','cards/mechanism/blender-cycles'];
  const assets = { [assetRef]: assetPath };
  const library = await loadCards(cards), assetLib = await loadAssets(assets);
  const src = await startSource({ cards, assets, blenderBin: blender });
  t.after(() => src.stop());
  const size = [96,64];
  const input = { film: 'assembly', output: { size, fps: '24/1' }, shot: {
    id: 'pose', in: 0, out: 3, source: 'blender', host: 'cycles', mode: 'cards-data', colorRef: 'scene',
    assets: { kit: assetRef }, cards: [{ use: ref, as: 'pose', params: { baked: outPath, animate: true } }, { use: ['blender.cycles',1].join('@'), as: 'cycles' }],
  } };
  const lock = { film: input.film, seeds: { pose: 1 }, shots: { pose: { shutterSamples: 1 } }, assets: { [assetRef]: assetLib[assetRef].sha256 },
    cards: Object.fromEntries(Object.values(library).map(({ card, sha256 }) => [card.id, { version: card.version, sha256, impl: card.livesIn }])),
  };
  const env = { lock, workspace: work, tier: 'draft', filmDir: work };
  const session = await src.open(input, env);
  const centers = [], counts = [], hashes = [];
  try {
    for (const f of [2,0,1,2]) {
      const { meta, layers } = await session.render(f, { scale: 1, samples: 1 }, ['color','objectId','meta']);
      assert.equal(meta.source.host, 'cycles');
      const arm = meta.entities.find((e) => e.name === name), fixed = meta.entities.find((e) => e.name === 'kit.fixed');
      const center = (box) => box.slice(0,3).map((v,k) => (v + box[k+3]) / 2);
      const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-5, `${a} ≠ ${b}`);
      const u = f/2, measured = center(arm.bbox3d);
      measured.forEach((v,k) => near(v, [0.2*u,0.2*u,-2-0.1*u][k]));
      center(fixed.bbox3d).forEach((v,k) => near(v, [-0.4,0,-2][k]));
      const a = u*Math.PI/2;
      near(arm.bbox3d[3]-arm.bbox3d[0], 0.4*Math.cos(a)+0.2*Math.sin(a));
      const data = await readFile(join(work, layers.objectId.file));
      const ids = new Uint32Array(Uint8Array.from(data).buffer);
      const pixels = ids.reduce((count, id) => count+Number(id === arm.id), 0);
      assert.ok(pixels > 0);
      centers.push(measured.map((v) => Number(v.toFixed(6))));
      counts.push(pixels);
      hashes.push(layers.objectId.hash);
    }
    assert.equal(hashes[0], hashes[3]);
    assert.equal(new Set(hashes).size, 3);
  } finally { await session.close(); }
  // 同一数据内嵌传递，progress 可固定在任一姿态。
  input.shot.cards[0].params = { baked, progress: 0.5 };
  const still = await src.open(input, env);
  try {
    for (const f of [2,0]) {
      const rendered = await still.render(f, { scale: 1, samples: 1 }, ['color','objectId']);
      assert.equal(rendered.layers.objectId.hash, hashes[2]);
    }
  } finally { await still.close(); }
  t.diagnostic(`Blender ${src.caps().version} ${src.device.backend} ${src.device.gpu || ''}；${size.join('×')}，帧 2/0/1/2 中心 ${JSON.stringify(centers)} m，零件像素 ${counts.join('/')}，重渲编号层 ${hashes[0]}`);
});
