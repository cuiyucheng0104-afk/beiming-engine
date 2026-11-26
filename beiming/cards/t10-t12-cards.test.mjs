import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { Quaternion, Vector3 } from 'three-webgpu';
import { checkScene } from '../calib/check.mjs';
import { resolveCalibScene } from '../calib/index.mjs';
import cardSchema from '../kernel/contracts/card-file/schema/card.schema.json' with { type: 'json' };
import eventsSchema from '../kernel/contracts/events/schema/events.schema.json' with { type: 'json' };
import { findBlender } from '../sources/blender/host.mjs';
import { evaluateAssertion } from '../verify/predicates.mjs';
import { evaluate as fit } from './camera/fit/evaluate.mjs';
import { createCardRegistry } from './registry.mjs';
import { resolveParams } from './runtime.mjs';
import { dataValidators } from './sweep-schema.mjs';
import { scanCardLeaks, validateCard } from './validate-card.mjs';

const BM = join(import.meta.dirname, '..');
const pythonCli = join(BM, 'jobs/python/py.mjs');
const specs = [
  ['assembly.schedule', 'assembly/schedule', []],
  ['assembly.explode', 'assembly/explode', ['1-2']],
  ['motion.snap', 'motion/snap', []],
  ['camera.fit', 'camera/fit', ['28-1']],
  ['camera.shake', 'camera/shake', []],
];
const text = path => readFileSync(path, 'utf8');
const readCards = () => specs.map(([, dir]) => JSON.parse(text(join(BM, 'cards', dir, 'card.json'))));
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
delete env.NODE_TEST_CONTEXT;

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { env, timeout: 120_000, encoding: 'utf8', ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('T10/T12 五卡：结构与 CF、参数 schema、注册、全目录零泄漏及独立自测', () => {
  const cards = readCards();
  const registry = createCardRegistry(cards, { nowDate: '2026-11-25', allowReproducedUntilDate: '2026-11-30' });
  const validate = new Ajv2020({ strict: false }).compile(cardSchema);
  for (const [i, [id, dir, exams]] of specs.entries()) {
    const card = cards[i], path = join(BM, 'cards', dir);
    assert.equal(card.id, id);
    assert.equal(card.kind, id.split('.')[0]);
    assert.equal(card.version, id === 'camera.fit' ? '1.1.0' : '1.0.0');
    assert.deepEqual(card.exams, [...exams, `cal:${id}`]);
    assert.deepEqual(card.livesIn, id === 'camera.fit' ? ['data', 'source:blender'] : ['source:blender']);
    assert.ok(validate(card), JSON.stringify(validate.errors));
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, id);
    assert.deepEqual(registry.getCard(`${id}@1`), card);
    const visible = card.status.some(s => s.level !== 'read');
    assert.equal(registry.searchCards({ q: id, kind: card.kind, source: 'blender' }).some(c => c.id === id), visible, id);
    for (const name of globSync('**/*.{json,py,mjs,md}', { cwd: path })) {
      assert.deepEqual(scanCardLeaks(text(join(path, name))), [], `${id}/${name}`);
    }
    const calib = resolveCalibScene(card.calibration, { allowProbes: true });
    assert.deepEqual(checkScene(calib.scene, calib.id), [], id);
    const checks = new Map(dataValidators(card));
    for (const [key, spec] of Object.entries(card.params)) {
      if (spec.type === 'data') assert.ok(checks.get(key)?.(spec.default), `${id}.${key} schema/default`);
    }
    const impl = card.impl.find(i => i.livesIn === 'source:blender');
    assert.equal(impl.shape, 'create');
    assert.deepEqual(impl.hosts, [{ host: 'cycles', version: '5.2.0' }]);
    for (const { entry, selftest } of card.impl) {
      assert.ok(existsSync(join(BM, entry)), entry);
      assert.match(run(process.execPath, ['--test', join(BM, selftest)]), /pass [1-9]/, selftest);
    }
  }
  for (const name of ['choreo.py', 'e5.test.mjs']) {
    assert.deepEqual(scanCardLeaks(text(join(BM, 'sources/blender', name))), [], name);
  }
});

const SIZE = [1600, 900];
const ASPECT = SIZE[0] / SIZE[1];
const box = (x, y = 0.3, z = 0.2) => ({ min: [-x, -y, -z], max: [x, y, z] });
const bboxes = [0.3, 0.3, 0.5, 1.1, 1.8, 2, 2, 1.6, 1, 0.5].map(x => box(x));
const fitCard = () => JSON.parse(text(join(BM, 'cards/camera/fit/card.json')));

function project(box, camera) {
  const halfY = Math.tan(camera.fovDeg * Math.PI / 360);
  const inverse = new Quaternion(...camera.quat).invert();
  const position = new Vector3(...camera.pos), points = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    const q = new Vector3(x, y, z).sub(position).applyQuaternion(inverse);
    assert.ok(q.z < 0, '角点在相机前方');
    points.push([(0.5 + q.x / (-2 * q.z * halfY * ASPECT)) * SIZE[0], (0.5 - q.y / (-2 * q.z * halfY)) * SIZE[1], -q.z]);
  }
  return points;
}

function projectedFrames(poses, boxes) {
  return poses.map(({ camera }, frame) => {
    const points = project(boxes[frame], camera);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const aabb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const [w, h] = SIZE;
    const [x0, y0, x1, y1] = aabb;
    const pxArea = Math.max(0, Math.min(w, x1) - Math.max(0, x0))
      * Math.max(0, Math.min(h, y1) - Math.max(0, y0)) / (w * h);
    return { frame, meta: { size: SIZE, entities: [{ name: 'assembly', bbox2d: aabb, pxArea }] } };
  });
}

test('T12 动态取景：八角投影全过；关闭滑窗后爆炸扩张逐帧判分出现反例', t => {
  const params = resolveParams(fitCard(), {
    bboxes, windowFrames: 2, smoothAlpha: 0.3, aspect: ASPECT,
    azimuthDeg: 15, elevationDeg: 4, fovYDeg: 38, margin: 0.85,
    groundY: 0, groundClearanceM: 0.04, nearClipM: 0.1,
  });
  const up = bboxes.map((_, f) => fit({}, params, f));
  const down = bboxes.map((_, f) => fit({}, { ...params, useSlidingMax: false }, f));
  const film = { output: { size: SIZE, frames: bboxes.length }, shots: [{ id: 's01', in: 0, out: bboxes.length, source: 'blender', mode: 'build-script', roles: { hero: 'assembly' } }] };
  const good = projectedFrames(up, bboxes), bad = projectedFrames(down, bboxes);
  const verdict = frames => evaluateAssertion('inside_frame(hero, margin=0.05)', film, { frames });
  assert.equal(verdict(good).status, 'pass');
  assert.equal(verdict(bad).status, 'fail');
  const cropped = bad.filter(f => !verdict([f]).ok).length;
  const outside = down.flatMap(({ camera }, f) => project(bboxes[f], camera)).filter(([x, y]) => x < 0 || y < 0 || x > SIZE[0] || y > SIZE[1]).length;
  assert.ok(outside > 0);
  assert.ok(up.every(p => p.camera.pos[1] >= 0.04 - 1e-12));
  t.diagnostic(`滑窗开：${good.length}/${good.length} 帧通过；关：${cropped}/${bad.length} 帧未通过，${outside} 个角点越出画幅`);
});

test('T12 单帧解析距离、地面净空、近裁剪与 Python/JS 轨迹对拍', t => {
  const card = fitCard(), simple = box(0.5);
  const base = { bboxes: [simple], azimuthDeg: 0, elevationDeg: 0, fovYDeg: 60, aspect: ASPECT, margin: 0.9 };
  const solve = overrides => fit({}, resolveParams(card, { ...base, ...overrides }), 0);
  const k = 0.9 * Math.tan(Math.PI / 6);
  const expected = 0.2 + Math.max(0.5 / (k * ASPECT), 0.3 / k);
  const rel = Math.abs(solve({}).distance / expected - 1);
  assert.ok(rel <= 0.001, `解析相对误差 ${rel}`);
  const low = solve({ elevationDeg: -20, groundY: 0.5, groundClearanceM: 0.2, nearClipM: 4 });
  assert.ok(low.camera.pos[1] >= 0.7 - 1e-12);
  assert.ok(project(simple, low.camera).every(p => p[2] >= 4 - 1e-12));

  const py = `
import json, sys
sys.path.insert(0, sys.argv[1])
from choreo import solve_dynamic_camera_fit
boxes, elevation, sliding = json.load(sys.stdin)
print(json.dumps(solve_dynamic_camera_fit(boxes, 15, elevation, 38, 16 / 9, .85, 2, .3, .05, .04, .1, sliding)))
`;
  let maxRel = 0;
  for (const [elevationDeg, useSlidingMax] of [[4, true], [4, false], [-12, true]]) {
    const params = resolveParams(card, { bboxes, windowFrames: 2, smoothAlpha: 0.3, useSlidingMax, aspect: ASPECT,
      azimuthDeg: 15, elevationDeg, fovYDeg: 38, margin: 0.85, groundY: 0.05, groundClearanceM: 0.04, nearClipM: 0.1 });
    const rows = JSON.parse(run(process.execPath, [pythonCli, '-I', '-B', '-c', py, join(BM, 'sources/blender')], {
      input: JSON.stringify([bboxes, elevationDeg, useSlidingMax]),
    }));
    assert.equal(rows.length, bboxes.length);
    for (const [f, row] of rows.entries()) {
      const js = fit({}, params, f);
      maxRel = Math.max(maxRel, Math.abs(row.distance / js.distance - 1));
      assert.ok(Math.hypot(...row.position.map((v, i) => v - js.camera.pos[i])) < 1e-9);
      assert.ok(Math.abs(new Quaternion(...row.quaternion).dot(new Quaternion(...js.camera.quat))) > 1 - 1e-12);
    }
  }
  assert.ok(maxRel <= 0.001, `跨端最大相对误差 ${maxRel}`);
  t.diagnostic(`解析距离相对误差 ${100 * rel}%，Python/JS 最大相对误差 ${100 * maxRel}%`);
});

test('T10/T12 Blender 5.2：帧源装载五张卡，Cycles 正序与逆序出帧哈希一致', t => {
  const blender = findBlender();
  if (!blender || !/^Blender 5\.2\.\d+\b/m.test(run(blender, ['--version']))) return t.skip('需要 Blender 5.2');
  const dir = mkdtempSync(join(tmpdir(), 'beiming-choreo-cycles-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cards = readCards();
  const instances = cards.map((card, i) => {
    const impl = card.impl.find(row => row.livesIn === 'source:blender');
    return { as: ['schedule', 'explode', 'snap', 'fit', 'shake'][i], use: card.id, kind: card.kind,
      impl: 'source:blender', shape: impl.shape, entry: join(BM, impl.entry), overlay: false,
      paramNames: Object.keys(card.params), params: resolveParams(card, {}) };
  });
  Object.assign(instances[0].params, { parts: [{ id: 'insert', rest_pos: [0.3, 0.15, 0] }], flyFrames: 8, offsetM: 0.75 });
  Object.assign(instances[1].params, {
    parts: [{ id: 'block', rest_pos: [-0.4, 0, 0] }], center: [0, 0, 0], scaleM: 0.5,
    phase: { startFrame: 0, endFrame: 11, from: 0, to: 1 }, bindings: { block: 'Exploding' },
  });
  Object.assign(instances[2].params, { object: 'Flying', settleFrames: 3 });
  Object.assign(instances[3].params, { bboxes: Array.from({ length: 12 }, (_, i) => box(1 + i / 20, 1, 0.75)), aspect: 4 / 3,
    smoothAlpha: 0.4, windowFrames: 2, azimuthDeg: 18, elevationDeg: 12 });
  Object.assign(instances[4].params, { impulses: [{ frame: 4 }], baseCard: 'fit', ampPosM: 0.12 });
  const script = `
import sys
sys.dont_write_bytecode = True
import hashlib, json
from math import dist
from pathlib import Path
from types import SimpleNamespace
import bpy

source, out, raw = sys.argv[sys.argv.index('--') + 1:]
sys.path.insert(0, source)
from loader import Loaded, _module
instances = json.loads(raw)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 2
scene.cycles.use_denoising = False
scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 64, 48, 100
scene.render.image_settings.file_format = 'PNG'
scene.world = bpy.data.worlds.new('Ambient')
scene.world.use_nodes = True
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value = 0.7
for name in ('Flying', 'Exploding'):
    bpy.ops.mesh.primitive_cube_add(size=0.36)
    bpy.context.object.name = name
bpy.ops.object.light_add(type='AREA', location=(1, -3, 4))
bpy.context.object.data.energy = 250

fps, shot, seed = '30/1', dict(id='s01', **{'in': 0}), 42
schedule = _module(instances[0]['entry'], instances[0]['use']).create(SimpleNamespace(fps=fps, seed=seed, shot=shot), instances[0]['params'])
instances[2]['params']['part'] = schedule['schedule']['parts'][0]
schedule['dispose']()
job = dict(shot=shot, fps=fps, size=[64, 48], frames=12, seed=seed, instances=instances,
           assets=[], tracksCamera=False, pairs=[['fit', 'shake']])
loader = Loaded(job, scene, None)
loader.build()
assert loader.account['camera']['from'] == 'card'
assert len(loader.made) == len(instances)
frames = [0, 3, 5, 7, 11]

def render(f):
    scene.frame_set(f)
    loader.state(f, 0, {})
    readings = loader.meta(f)
    assert readings['fit.distance'] > 0
    assert readings['schedule.partCount'] == 1
    assert (readings['shake.shakeM'] > 0) == (f >= 4)
    assert readings['snap.settled'] == int(f >= 8)
    assert dist(scene.objects['Exploding'].location, (-0.4 - f * 0.5 / 11, 0, 0)) < 1e-6
    if f >= 8:
        assert dist(scene.objects['Flying'].location, (0.3, 0, 0.15)) < 1e-6
    bpy.context.view_layer.update()
    path = Path(out) / 'frame.png'
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    return hashlib.sha256(path.read_bytes()).hexdigest()

forward = {f: render(f) for f in frames}
reverse = {f: render(f) for f in reversed(frames)}
loader.dispose()
print('CHOREO_RESULT ' + json.dumps(dict(forward=forward, reverse=reverse, events=schedule['events'])))
`;
  const path = join(dir, 'probe.py');
  writeFileSync(path, script);
  const output = run(blender, ['--background', '--factory-startup', '-t', '1', '--python-exit-code', '1', '--python', path,
    '--', join(BM, 'sources/blender'), dir, JSON.stringify(instances)], { maxBuffer: 8 * 1024 * 1024 });
  const line = output.split('\n').find(s => s.startsWith('CHOREO_RESULT '));
  assert.ok(line, output);
  const { forward, reverse, events } = JSON.parse(line.slice('CHOREO_RESULT '.length));
  const validate = new Ajv2020().compile(eventsSchema);
  assert.ok(validate(events), JSON.stringify(validate.errors));
  assert.equal(Object.keys(forward).length, 5);
  assert.equal(new Set(Object.values(forward)).size, 5, '合成镜头确实在变化');
  assert.deepEqual(forward, reverse);
  t.diagnostic('Blender 5.2 CPU Cycles：5/5 帧正序和逆序 PNG 哈希相同');
});
