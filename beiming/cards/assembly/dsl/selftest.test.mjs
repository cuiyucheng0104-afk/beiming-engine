import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluate } from './bake.mjs';

function cube(x) {
  return {
    vertices: [[0,0,0], [1,0,0], [1,1,0], [0,1,0], [0,0,1], [1,0,1], [1,1,1], [0,1,1]].map(([a,b,c]) => [a+x,b,c]),
    faces: [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]],
  };
}
const meshes = { base: cube(0), pin: cube(2), peg: cube(2), lid: cube(2), left: cube(0) };
const steps = [
  { op: 'slide', target: 'pin', onto: 'base', dir: [-2,0,0] },
  { op: 'seat', target: 'peg', onto: 'base', dir: [-1,0,0], maxExtra: 0 },
  { op: 'fit', target: 'lid', onto: 'base', rangeX: [-1,0,0.5], rangeY: 0, rangeZ: 0 },
  { op: 'attach', target: 'peg', parent: 'pin' },
  { op: 'move', target: 'pin+', delta: [0,2,0] },
  { op: 'rot', target: 'left', pivot: [0.5,0.5,0.5], axis: [0,0,1], angleDeg: 90 },
  { op: 'mirror', target: 'left', ref: 'lid' },
];
const recipe = { root: 'base', centerX: 0, steps };
const bake = (r, options) => evaluate({ recipe: r, meshes, engine: 'python', ...options });
const translation = (part) => part.matrix4x4.slice(0,3).map((row) => row[3]);

test('七步烘焙可重放，接触与刚体旋转保留，双遍输出逐字节相同', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'assembly-card-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'asm.baked.json');
  const first = await bake(recipe, { outPath: path });
  const bytes = await readFile(path);
  assert.deepEqual(first, JSON.parse(bytes));
  await bake(recipe, { outPath: path });
  assert.ok(bytes.equals(await readFile(path)));
  t.diagnostic(`七步输出 SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`);
  assert.equal(first.steps.length, 7);
  const { pin, peg, lid, left } = first.parts;
  assert.deepEqual([pin.parent, peg.parent, lid.parent], ['base','pin','base']);
  assert.deepEqual([translation(pin), translation(peg), translation(lid)], [[-1,2,0],[-1,2,0],[-1,0,0]]);
  assert.deepEqual(left.matrix4x4, [[0,-1,0,-1],[1,0,0,0],[0,0,1,0],[0,0,0,1]]);
});

test('单步改动只移动被选择的父子两件', async () => {
  const edited = structuredClone(recipe);
  edited.steps[4].delta = [0,-3,0];
  const before = await bake(recipe), after = await bake(edited);
  for (const name of ['pin','peg']) assert.deepEqual(translation(after.parts[name]), [-1,-3,0]);
  for (const name of ['base','lid','left']) assert.deepEqual(after.parts[name], before.parts[name]);
});

test('未登记的零件、未知操作和缺少镜面位置一律报错', async () => {
  for (const step of [
    { op: 'move', target: 'missing', delta: [0,0,0] },
    { op: 'scale', target: 'pin' },
    { op: 'mirror', target: 'pin', ref: 'lid' },
  ]) await assert.rejects(() => bake({ root: 'base', steps: [step] }));
});
