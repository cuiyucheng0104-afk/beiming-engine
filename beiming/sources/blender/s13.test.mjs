import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { bakeAssembly, loadBakedAssembly } from './bake.mjs';
import { findBlender } from './host.mjs';

// Closed, outward-facing triangles of a cuboid in world Y-up coordinates.
function block(x0, y0, z0, x1, y1, z1) {
  return { vertices: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
  faces: [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]] };
}

// Extrude a U section. Its inner right wall guides the peg down to a lower floor.
function socket() {
  const u = 1 / 128;
  const xy = [[-3, -1], [3, -1], [3, 2], [1, 2], [1, 0], [-1, 0], [-1, 2], [-3, 2]];
  const vertices = [-4, 4].flatMap(z => xy.map(([x, y]) => [x * u, y * u, z * u]));
  const cap = [[0, 1, 4], [0, 4, 5], [1, 2, 3], [1, 3, 4], [0, 5, 6], [0, 6, 7]];
  const faces = cap.flatMap(([a, b, c]) => [[a, c, b], [a + 8, b + 8, c + 8]]);
  xy.forEach((_, i) => {
    const j = (i + 1) % 8;
    faces.push([i, j, j + 8], [i, j + 8, i + 8]);
  });
  return { vertices, faces };
}

const floor = block(-1, -0.5, -1, 1, 0, 1);
const pad = block(-0.25, 0.125, -0.25, 0.25, 0.25, 0.25);
const peg = block(-1 / 256, 1 / 32, -1 / 64, 1 / 128, 3 / 64, 1 / 64);
const down = { dir: [0, -3, 0] };
const fit = { op: 'fit', target: 'pad', onto: 'floor', rangeX: [-0.1, 0.1, 0.1],
  rangeY: [-0.25, 0, 0.0625], rangeZ: 0 };
const seat = { op: 'seat', target: 'peg', onto: 'socket', ...down, step: 1 / 1024, tol: 0.0001 };
const collisionFixture = { meshes: { floor, pad, peg, socket: socket(), slider: pad }, recipe: { root: 'floor', steps: [
  { op: 'slide', target: 'slider', onto: 'floor', ...down }, seat, fit,
] } };
const bake = (input) => bakeAssembly({ ...input, engine: 'python' });
const translation = (part) => part.matrix4x4.slice(0, 3).map(row => row[3]);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function checkContacts({ parts }) {
  assert.deepEqual(translation(parts.slider), [0, -0.125, 0]);
  assert.deepEqual(translation(parts.peg), [0, -1 / 32, 0]);
  assert.deepEqual(translation(parts.pad), [0, -0.125, 0]);
  for (const [name, parent] of [['slider', 'floor'], ['peg', 'socket'], ['pad', 'floor']]) {
    assert.equal(parts[name].parent, parent);
    assert.equal(parts[name].touched, true);
  }
}

test('S13 slide 零间隙、seat 沿槽继续深入至槽底、fit 排除穿插并选择最大贴合', async () => {
  checkContacts(await bake(collisionFixture));
  const first = await bake({ meshes: collisionFixture.meshes, recipe: { steps: [{ op: 'slide', target: 'peg', onto: 'socket', ...down }] } });
  assert.equal(translation(first.parts.peg)[1], -1 / 64);
});

test('S13 同截面封闭件不能把穿入和完全重合当成贴合', async () => {
  const meshes = { base: block(0, 0, 0, 1, 1, 1), plug: block(2, 0, 0, 3, 1, 1) };
  const steps = [
    { op: 'fit', target: 'plug', onto: 'base', rangeX: [-2, -1, 0.25], rangeY: 0, rangeZ: 0 },
    { op: 'seat', target: 'plug', onto: 'base', dir: [-1, 0, 0], maxExtra: 0.25, step: 0.0625 },
  ];
  for (const step of steps) {
    const { parts } = await bake({ meshes, recipe: { steps: [step] } });
    assert.deepEqual(translation(parts.plug), [-1, 0, 0], step.op);
  }
  const plane = { vertices: [[0, 0, 0], [1, 1, 0], [0, 0, 1]], faces: [[0, 1, 2]] };
  const offset = { ...plane, vertices: plane.vertices.map(([x, y, z]) => [x + 0.25, y, z]) };
  const open = await bake({ meshes: { base: plane, plug: offset }, recipe: {
    steps: [{ op: 'fit', target: 'plug', onto: 'base', rangeX: 0, rangeY: 0, rangeZ: 0 }],
  } });
  assert.deepEqual(translation(open.parts.plug), [0, 0, 0]); // Overlapping AABBs, no solid interior.
});

test('S13 slide 反向射线命中斜三角面，分位数和 push 叠加', async () => {
  const slope = { vertices: [[-2, 1, -2], [2, 3, -2], [0, 2, 2]], faces: [[0, 1, 2]] };
  const post = block(-0.25, -1, -0.25, 0.25, 0, 0.25);
  const meshes = { slope, post, pad, floor };
  const { parts } = await bake({ meshes, recipe: { steps: [
    { op: 'slide', target: 'slope', onto: 'post', ...down },
    { op: 'slide', target: 'pad', onto: 'floor', quantile: 0.5, push: 0.03125, ...down },
  ] } });
  assert.deepEqual(translation(parts.slope), [0, -1.875, 0]);
  assert.deepEqual(translation(parts.pad), [0, -0.21875, 0]);
});

test('S13 组装移动保留内部边；显式 attach 将每个目标直接挂到指定父件', async () => {
  const meshes = { root: floor, a: pad, b: pad };
  const attach = { op: 'attach', target: 'b', parent: 'a' };
  const slide = { op: 'slide', target: 'a+', onto: 'root', ...down };
  const parentMap = async (...steps) => {
    const { parts } = await bake({ meshes, recipe: { steps } });
    return [parts.a.parent, parts.b.parent];
  };
  assert.deepEqual(await parentMap(attach, slide), ['root', 'a']);
  assert.deepEqual(await parentMap(attach, slide, { op: 'attach', target: ['a', 'b'], parent: 'root' }), ['root', 'root']);
});

test('S13 递归从属、逗号和数组重叠去重、已动件含 root、偏心旋转和镜像', async () => {
  const meshes = Object.fromEntries(['root', 'arm', 'tip', 'pin', 'other', 'spare'].map(name => [name, floor]));
  const { parts } = await bake({ meshes, recipe: { root: 'root', centerX: 2, steps: [
    { op: 'attach', target: 'tip', parent: 'arm' }, ['pin', 'attach', 'tip'],
    { op: 'move', target: ['arm+', 'pin,tip'], delta: [2, 0, 0] },
    { op: 'rot', target: 'arm+', pivot: [1, 0, 0], axis: [0, 3, 0], angleDeg: 90 },
    { op: 'move', target: '*', delta: [0, 1, 0] }, { op: 'mirror', target: 'other', ref: 'pin' },
  ] } });
  for (const name of ['arm', 'tip', 'pin']) {
    assert.deepEqual(parts[name].matrix4x4, [[0, 0, 1, 1], [0, 1, 0, 1], [-1, 0, 0, -1], [0, 0, 0, 1]]);
  }
  assert.equal(parts.tip.parent, 'arm');
  assert.equal(parts.pin.parent, 'tip');
  assert.deepEqual(translation(parts.other), [3, 1, -1]);
  assert.deepEqual(translation(parts.root), [0, 1, 0]);
  assert.deepEqual(translation(parts.spare), [0, 0, 0]);
  assert.equal(parts.spare.touched, false);
});

test('S13 双遍文件与 SHA-256 完全一致，UTF-8 键序、米制换算与内嵌网格', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 's13-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recipe = { units: 'mm', meshes: { '\u{10000}': pad, pad: block(0, 100, 0, 10, 200, 10),
    '': pad, floor: block(-100, -100, -100, 100, 0, 100) }, steps: [
    { op: 'slide', target: 'pad', onto: 'floor', push: 2, ...down },
  ] };
  const files = [join(dir, 'first.json'), join(dir, 'second.json')];
  const [first] = await Promise.all(files.map(outPath => bake({ recipe, outPath })));
  assert.equal(first.format, 'asm-baked/0.1');
  assert.match(first.recipeSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.steps.length, 1);
  assert.deepEqual(translation(first.parts.pad), [0, -0.102, 0]);
  assert.deepEqual(first, await loadBakedAssembly(files[0]));
  const [a, b] = await Promise.all(files.map(file => readFile(file)));
  assert.deepEqual(a, b);
  assert.equal(sha256(a), sha256(b));
  assert.doesNotMatch(a.toString(), /(?<!\d)-0(?:\.0+)?(?=[\s,\]])/);
  assert.deepEqual(Object.keys(first.parts), ['floor', 'pad', '', '\u{10000}']);
  t.diagnostic(`双遍 ${a.length} B，SHA-256 ${sha256(a)}`);
});

test('S13 坏配方给出错误，包括命名、从属环、网格步长、无命中与缺少对称面', async () => {
  const meshes = { floor, pad };
  const bad = [ { op: 'move', target: 'absent+', delta: [0, 0, 0] }, { op: 'attach', target: 'pad', parent: 'absent' },
    { op: 'mirror', target: 'pad', ref: 'floor' }, { op: 'slide', target: 'pad', onto: 'floor', dir: [0, 0, 0] },
    { op: 'slide', target: 'pad', onto: 'floor', dir: [1, 0, 0] },
    { ...fit, rangeZ: [0, 1, 0] }, { op: 'rot', target: 'pad', axis: [0, 1, 0], angleDeg: 90 },
    { op: 'attach', target: 'floor', parent: 'floor' } ];
  for (const step of bad) {
    await assert.rejects(bake({ meshes, recipe: { steps: [step] } }), step.op === 'mirror' ? /centerX/ : undefined);
  }
});

const blenderBin = process.env.BLENDER_BIN || findBlender();
test('S13 掠过近板边缘时不能选中 2 m 后方的挡板', { skip: !blenderBin && '本机没有 Blender' }, async () => {
  const dir = [1, 3, 0.5], u = dir.map(x => x / Math.sqrt(10.25));
  const mid = [0.5, 0.25, 0], start = mid.map((x, i) => x - u[i]);
  const front = [[0, 0, 0], [1, 0.5, 0], [0, 0, 1]];
  const back = front.map(p => p.map((x, i) => mid[i] + 3 * (x - mid[i]) + 2 * u[i]));
  const moving = [[0, 0, 0], [0.09375, 0.046875, -0.125], [0.03125, 0.015625, -0.125]];
  const meshes = { probe: { vertices: moving.map(p => p.map((x, i) => x + start[i])), faces: [[0, 1, 2]] },
    boards: { vertices: [...front, ...back], faces: [[0, 1, 2], [3, 4, 5]] } };
  const recipe = { steps: [{ op: 'slide', target: 'probe', onto: 'boards', dir }] };
  for (const engine of ['python', 'blender']) {
    const { parts } = await bakeAssembly({ recipe, meshes, engine, blenderBin });
    assert.ok(Math.abs(Math.hypot(...translation(parts.probe)) - 1) < 1e-8, `${engine}: ${translation(parts.probe)}`);
  }
});

test('S13 Blender BVHTree 和离线三角求解烘出同一组接触位姿', { skip: !blenderBin && '本机没有 Blender' }, async () => {
  const offline = await bake(collisionFixture);
  const bvh = await bakeAssembly({ ...collisionFixture, engine: 'blender', blenderBin });
  checkContacts(bvh);
  assert.deepEqual(bvh, offline);
});
