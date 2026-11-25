import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { findBlender, loadAssets, loadCards, startSource } from '../sources/blender/host.mjs';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { eventsTable, shotInput } from '../kernel/eval/input.mjs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import { dataValidators } from './sweep-schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cards = [
  ['particle.ballistic', 'particle/ballistic'],
  ['fx.streak-ring', 'particle/fx-streak-ring'],
  ['rig.rigid-ik', 'motion/rig-rigid-ik'],
];
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
for (const [id, dir] of cards) {
  test(`${id} 的声明、注册、参数与目录泄漏检查`, () => {
    const root = join(here, dir);
    const card = readJson(join(root, 'card.json'));
    assert.equal(card.id, id);
    assert.equal(card.kind, dir.split('/')[0]);
    assert.equal(card.visibleToAgent, true);
    assert.deepEqual(card.exams, ['03B-1', `cal:${id}`]);
    const registry = createCardRegistry([card], { allowReproduced: true });
    assert.equal(registry.getCard(`${id}@1`).id, id);
    assert.ok(registry.searchCards({ kind: card.kind }).some(row => row.id === id));
    const entries = id === 'particle.ballistic' ? [['data', 'evaluate', 'index.mjs'], ['source:blender', 'create', 'blender.py']] : [['source:blender', 'create', 'index.py']];
    assert.deepEqual(card.livesIn, entries.map(([place]) => place));
    assert.deepEqual(card.impl.map(({ livesIn, shape, entry }) => [livesIn, shape, entry]), entries.map(([p, s, f]) => [p, s, `cards/${dir}/${f}`]));
    assert.deepEqual(card.impl.at(-1).hosts, [{ host: 'cycles', version: '5.2.0' }]);
    assert.deepEqual(card.status[0], { level: 'reproduced', host: 'cycles', source: '5.2.0', gpu: 'apple-m5-pro', date: '2026-11-25' });
    assert.ok(card.impl.every(impl => impl.selftest === `cards/${dir}/selftest.test.mjs`));
    for (const impl of card.impl) assert.ok(existsSync(join(dirname(here), impl.entry)));
    for (const name of readdirSync(root)) assert.deepEqual(scanCardLeaks(readFileSync(join(root, name), 'utf8')), [], name);
    assert.deepEqual(scanCardLeaks(readFileSync(import.meta.filename, 'utf8')), []);
    const params = resolveParams(card, {});
    for (const [key, validate] of dataValidators(card)) {
      assert.ok(validate(params[key]), JSON.stringify(validate.errors));
      assert.equal(validate({ unexpectedField: 1 }), false);
    }
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
  });
  test(`${id} 的独立离线自测`, () => {
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(here, dir, 'selftest.test.mjs')], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /pass [1-9]/);
  });
}

// 仅用 Python 标准库拆压 NPY v1 数值列；不加载 pickle，也不依赖本机的 NumPy。
function snapshots(path) {
  const count = 48561;
  const unpack = `
import ast, struct, sys, zipfile
count = int(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name, dtype, stride in [('frame','<i4',1), ('pool','|u1',1), ('slot','<i4',1), ('gpu','<f4',10), ('cpu','<f8',5)]:
        with archive.open(name + '.npy') as column:
            assert column.read(8) == b'\\x93NUMPY\\x01\\x00'
            size, = struct.unpack('<H', column.read(2))
            header = ast.literal_eval(column.read(size).decode('ascii').strip())
            assert header['descr'] == dtype and header['fortran_order'] is False
            assert header['shape'] == ((count,) if stride == 1 else (count,stride))
            nbytes = count * stride * int(dtype[-1])
            data = column.read(nbytes + 1)
            assert len(data) == nbytes
            sys.stdout.buffer.write(data)
`;
  const run = spawnSync('python3', ['-I', '-B', '-c', unpack, path, String(count)], { maxBuffer: 8 * 1024 ** 2 });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr?.toString());
  let offset = 0;
  const take = n => { const start = offset; offset += n * count; return run.stdout.subarray(start, offset); };
  return { frame: take(4), pool: take(1), slot: take(4), gpu: take(40), cpu: take(40), count };
}

const truthDir = process.env.BEIMING_L15_TRUTH_DIR;
function truthSkip() {
  if (!truthDir) return '未设置 BEIMING_L15_TRUTH_DIR';
  try { accessSync(truthDir, constants.R_OK); } catch { return '无法读取真值目录'; }
  return false;
}
test('L15 逐行重放出生记录，对照 CPU 世界点、GPU 屏幕中心与全局形状时间', { skip: truthSkip() }, async t => {
  const { replayBirthFrame, shapeStep } = await import('./particle/ballistic/index.mjs');
  const birth = readJson(join(truthDir, 'birth_records.json'));
  const { frames } = readJson(join(truthDir, 'frames.json'));
  const s = snapshots(join(truthDir, 'snapshots.npz'));
  assert.equal(frames.length, 120);
  assert.ok(frames.every((m, i) => m.frame === frames[0].frame + i));
  const variants = [{}, { noFan: true }, { dragScale: 1.25 }, { gravOffset: 1 }];
  for (const [index, options] of variants.entries()) {
    let row = 0, maxScreenPxError = 0, maxWorldErrorM = 0;
    for (const meta of frames) {
      const particles = replayBirthFrame(birth, meta, options);
      assert.ok(particles.length > 0);
      const step = shapeStep(meta), [width, height] = meta.viewport;
      assert.equal(step, Math.round(meta.gpu_vShapeT * 12));
      for (const { pool, slot, world, px } of particles) {
        assert.equal(s.frame.readInt32LE(4 * row), meta.frame);
        assert.equal(s.pool[row], pool);
        assert.equal(s.slot.readInt32LE(4 * row), slot);
        const at = row * 40, w = s.gpu.readFloatLE(at + 12);
        assert.ok(w > 0);
        const x = width * (0.5 + 0.5 * s.gpu.readFloatLE(at) / w);
        const y = height * (0.5 - 0.5 * s.gpu.readFloatLE(at + 4) / w);
        assert.ok(Math.abs(step / 12 - s.gpu.readFloatLE(at + 32)) < 2e-6);
        maxScreenPxError = Math.max(maxScreenPxError, Math.hypot(px[0] - x, px[1] - y));
        maxWorldErrorM = Math.max(maxWorldErrorM, Math.hypot(...[0, 1, 2].map(j => world[j] - s.cpu.readDoubleLE(at + j * 8))));
        row++;
      }
    }
    assert.equal(row, s.count);
    t.diagnostic(JSON.stringify({ options, frames: frames.length, particleFrames: row, maxScreenPxError, maxWorldErrorM }));
    assert.ok(Number.isFinite(maxScreenPxError) && Number.isFinite(maxWorldErrorM));
    if (index === 0) assert.ok(maxScreenPxError < 1 && maxScreenPxError <= 0.02 && maxWorldErrorM < 1e-4);
    else assert.ok(maxScreenPxError > 1, `负对照未被检出: ${JSON.stringify(options)}`);
  }
});

const blenderBin = process.env.BLENDER_BIN || findBlender();
test('Cycles 5.2 cards-data：逐卡隔离出图，反向重开镜头逐帧比颜色和读数', {
  skip: !blenderBin && '没有安装 Blender', timeout: 360000,
}, async t => {
  const dirs = ['cards/camera/spline', ...cards.map(([, dir]) => `cards/${dir}`)];
  const library = await loadCards(dirs), assets = await loadAssets();
  const contracts = await loadContracts();
  const filmDir = join(dirname(here), 'kernel/contracts/examples/film-min');
  const workspace = mkdtempSync(join(tmpdir(), 't15-render-'));
  let source;
  try {
    // 同机 CPU 作为逐位对照，避免异步 GPU 调度与卡的跨帧状态混淆。
    source = await startSource({ blenderBin, cards: dirs, device: 'cpu', limitMs: 60000 });
    assert.equal(source.caps().version, '5.2.0');
    for (const [id] of cards) {
      const rig = id === 'rig.rigid-ik', sparks = id === 'particle.ballistic';
      const film = readJson(join(filmDir, 'film.json'));
      const input = shotInput(film, 's01', eventsTable(film));
      input.output = { ...input.output, size: [160, 120] };
      const params = resolveParams(library[id].card);
      if (rig) params.spec.bindings = { foot: ['kit.fan_L'] };
      if (sparks) params.particles.push({ position: [0.2, 0.12, -1], velocity: [0.3, 0, 0], birth: 0.15, life: 0.2, sizeM: 0.04 });
      const cameraKey = { f: 0, pos: rig ? [0, 0.24, 0.7] : [0, 0.5, 0.5], look: rig ? [0, 0, 0] : [0, 0, -1] };
      input.shot = { ...input.shot, out: 25, assets: rig ? input.shot.assets : {}, roles: rig ? input.shot.roles : {},
        shutter: { angleDeg: 0 }, cards: [{ as: 'cam', use: 'camera.spline@1', params: { keys: [cameraKey] } }, { as: 'probe', use: `${id}@1`, params }] };
      const lock = { film: film.id, seeds: { s01: input.shot.seed }, shots: { s01: { shutterSamples: 1 } }, sources: { blender: { version: '5.2.0' } },
        cards: Object.fromEntries(Object.entries(library).map(([key, { card, sha256 }]) => [key, { version: card.version, impl: card.livesIn, sha256 }])),
        assets: Object.fromEntries(Object.entries(assets).map(([key, asset]) => [key, asset.sha256])) };
      const seq = rig ? [0, 12] : [2, 7];
      const frames = new Map();
      for (const reverse of [false, true]) {
        const session = await source.open(input, { workspace, tier: 'draft', filmDir, lock });
        try {
          for (const f of reverse ? seq.toReversed() : seq) {
            const { meta, layers } = await session.render(f, { scale: 1, samples: 8 }, ['color', 'meta']);
            assert.deepEqual(contracts.validate(meta), { contract: 'meta', schemaErrors: [], violations: {} });
            assert.deepEqual([meta.format, meta.frame, meta.source.host, meta.source.version], ['meta/0.1', f, 'cycles', '5.2.0']);
            assert.deepEqual(meta.ext['blender.load'].applyOrder, ['tracks', 'probe']);
            const r = meta.readings;
            if (rig) {
              assert.equal(r['probe.boundObjects'], 1);
              assert.equal(r['probe.reachable'], 1);
              assert.equal(r['probe.phase'], f === 0 ? 0 : 0.5);
            } else if (sparks) {
              assert.equal(r['probe.alive'], f === 2 ? 2 : 3);
              assert.equal(r['probe.shapeStep'], Math.floor(f / 30 * 12));
            } else {
              assert.equal(r['probe.streakFaces'], f === 2 ? 4 : 12);
              assert.equal(r['probe.ringFaces'], 96);
              assert.ok(Math.abs(r['probe.ringRadiusM'] - (0.12 + 0.4 * (1 - Math.exp(-f / 7)))) < 1e-9);
            }
            const rgba = readFileSync(join(workspace, layers.color.file));
            assert.equal(rgba.length, 160 * 120 * 16);
            let lit = 0;
            for (let k = 0; k < rgba.length; k += 16) {
              const rgb = rgba.readFloatLE(k) + rgba.readFloatLE(k + 4) + rgba.readFloatLE(k + 8);
              assert.ok(Number.isFinite(rgb));
              if (rgb > 1e-4) lit++;
            }
            assert.ok(lit > 0, `${id} 帧 ${f} 颜色全黑`);
            const hash = `sha256:${createHash('sha256').update(rgba).digest('hex')}`;
            assert.equal(hash, meta.hash.color);
            const bbox = rig ? meta.entities.find(e => e.name === 'kit.fan_L').bbox3d : null;
            const result = { hash, lit, readings: r, bbox };
            if (reverse) assert.deepEqual(result, frames.get(f), `${id} 乱序帧 ${f}`);
            else frames.set(f, result);
          }
        } finally { await session.close(); }
      }
      const [first, last] = seq.map(f => frames.get(f));
      assert.notEqual(first.hash, last.hash, `${id} 应改变画面`);
      if (rig) for (let i = 0; i < 6; i++) {
        // 足部刚体在半程的位移正好是目标位移的一半，独立从宿主量到的包围盒核对。
        assert.ok(Math.abs(last.bbox[i] - first.bbox[i] - [0.1, 0.025, 0.05][i % 3]) < 1e-6);
      }
      t.diagnostic(`${id}：${JSON.stringify(Object.fromEntries(frames))}`);
    }
  } finally { try { await source?.stop(); } finally { rmSync(workspace, { recursive: true, force: true }); } }
});
