import Ajv2020 from 'ajv/dist/2020.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startSource as startThree } from '../host/page/host.mjs';
import { checks } from '../kernel/contracts/meta/check.mjs';
import metaSchema from '../kernel/contracts/meta/schema/meta.schema.json' with { type: 'json' };
import { findBlender, startSource as startBlender } from './blender/host.mjs';
import { measureProbe } from './scene-probe-measure.mjs';
import { planProbe } from './scene-probe-plan.mjs';

const validMeta = new Ajv2020({ strict: false }).compile(metaSchema);
const ground = { kind: 'probe.ground', of: ['finger'], tol: 0.001 };
const near = { kind: 'probe.near-clip', of: ['near', 'edge', 'outside', 'behind'] };
const tris = { ...near, kind: 'probe.tri-budget', limit: 1 };
const deform = { kind: 'probe.deform', of: ['deform'] };
const joints = { kind: 'probe.joint-vel', of: ['follow'], against: ['lead'] };
const foot = { kind: 'probe.footslide', of: ['foot'] };
const section = { kind: 'probe.section', of: ['finger'], axis: 'y', offset: 0 };
const contact = { kind: 'probe.contact', of: ['contact_a'], against: ['contact_b'] };
const instanceGround = { kind: 'probe.ground', of: ['instance_assembly'] };
const instanceSection = { ...section, of: instanceGround.of };
const instanceDeform = { ...deform, of: instanceGround.of };
const approximate = (value, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(value - expected) <= tolerance, `expected ${expected} ± ${tolerance}, got ${value}`);

for (const renderer of ['three', 'blender']) {
  const three = renderer === 'three';
  test(`O11 session query and meta/0.1 on ${renderer}`, { timeout: 120000 }, async (t) => {
    if (!three && !findBlender()) { t.skip('Blender unavailable'); return; }
    let source;
    try {
      source = await (three ? startThree() : startBlender({ device: 'cpu' }));
    } catch (e) {
      if (three && /executable|chrome/i.test(e.message)) { t.skip(e.message.split('\n')[0]); return; }
      throw e;
    }
    t.after(() => source.stop());
    const workspace = await mkdtemp(join(tmpdir(), 'beiming-o11-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const plans = [ground, near, tris, deform, joints, ...(three ? [foot] : [section, contact, instanceGround, instanceSection, instanceDeform])];
    const shot = {
      id: 'calibration', in: 20, out: 24, source: renderer, host: three ? 'page' : 'cycles',
      mode: three ? 'native-code' : 'build-script', entry: three ? 'o11-calibration.three.js' : 'o11-calibration.blender.py',
      colorRef: 'scene', seed: 11, params: { sceneProbes: plans },
    };
    const env = { lock: null, tier: 'final', workspace, filmDir: import.meta.dirname };
    const output = { size: [64, 36], fps: '24/1' };
    assert.ok(source.caps().ext['scene.probes'].includes('probe.ground'));
    const session = await source.open({ film: 'o11', output, shot }, env);
    const query = (f, plan) => session.query(f, plan);
    const frame = async (f) => {
      const { meta, layers } = await session.render(f, {}, ['meta']);
      assert.deepEqual(layers, {});
      assert.equal(meta.frame, f + 20);
      assert.ok(validMeta(meta), JSON.stringify(validMeta.errors));
      for (const check of Object.values(checks)) assert.deepEqual(check(meta), []);
      const actual = meta.ext['scene.probes'];
      assert.deepEqual(actual, await Promise.all(plans.map((plan) => query(f, plan))));
      return actual;
    };
    const third = await frame(3);
    const first = await frame(1);
    assert.deepEqual(await frame(3), third);
    approximate(first[0].items[0].value, 0.0019);
    assert.deepEqual(first[1].items.map((i) => i.a), ['near']);
    approximate(first[1].items[0].depth, 0.5);
    assert.deepEqual(first[2], { kind: 'probe.tri-budget', triangles: 2, limit: 1, over: true });
    approximate(first[3].items[0].value, 0.139);
    approximate(third[3].items[0].value, 0);
    approximate(third[4].items[0].value, 0.6);
    assert.equal(third[4].items[0].lagFrames, 2);
    assert.equal(third[4].items[0].plateaus, 1);
    assert.deepEqual((await query(0, joints)).items[0], { a: 'follow', value: null, plateaus: 0, lagFrames: null });
    assert.equal((await query(1, { ...ground, tol: 0.002 })).items.length, 0);
    assert.equal((await query(1, { kind: 'belowGround', of: ['finger'], tol: 0.001 })).kind, 'belowGround');
    await assert.rejects(query(4, near), { code: 'usage.bad-argument' });
    await assert.rejects(query(0, three ? section : foot), { code: 'contract.unsupported-query' });

    if (three) {
      approximate(first[5].items[0].value, 0.025);
      const bone = { kind: 'probe.joint-vel', of: ['rig'], bone: 'lag', against: ['rig'], againstBone: 'pilot' };
      assert.equal((await query(3, bone)).items[0].lagFrames, 2);
      const shifted = { kind: 'probe.near-clip', of: ['shifted'] };
      assert.equal((await query(1, shifted)).items.length, 0);
      assert.equal((await query(2, shifted)).items.length, 1);
      assert.equal((await query(2, foot)).items[0].value, null);
    } else {
      assert.equal(first[5].items.length, 8);
      assert.ok(first[5].items.every(({ ends }) => ends.every((point) => point[1] === 0)));
      approximate(first[6].items[0].value, 0.0005);

      // Two children instance one mesh datablock. Only the right instancer is registered directly.
      const [sink] = first[7].items;
      assert.deepEqual([sink.a, sink.unit, sink.value, sink.at[1]], ['instance_assembly', 'm', 0.1875, -0.1875]);
      const ordinaryGround = await query(1, { ...instanceGround, kind: 'belowGround' });
      assert.equal(sink.value, ordinaryGround.items[0].value);
      const segments = first[8].items;
      assert.equal(segments.length, 16);
      assert.ok(segments.every(({ ends }) => ends.every((point) => point[1] === 0)));
      assert.equal(segments.filter(({ ends }) => ends.every((point) => point[0] < 0)).length, 8);
      assert.equal((await query(1, { ...instanceSection, of: ['instance_assembly.right'] })).items.length, 8);
      approximate(first[9].items[0].value, 0.125);
      approximate(third[9].items[0].value, 0);
    }
    const probedColor = await session.render(0, { samples: 1 }, ['color', 'meta']);
    await session.close();

    const ordinary = await source.open({ film: 'o11', output, shot: { ...shot, params: {} } }, env);
    const { meta } = await ordinary.render(0, { samples: 1 }, ['color', 'meta']);
    assert.ok(!Object.hasOwn(meta.ext ?? {}, 'scene.probes'));
    assert.equal(meta.hash.color, probedColor.meta.hash.color);
    await ordinary.close();
  });
}

test('O11 probe plans expand prefixes, snapshot input and validate parameters', () => {
  const q = { ...ground, of: ['finger.left', 'finger.*'] };
  const plan = planProbe('three', q, 3, ['finger.right', 'finger.left', 'finger']);
  q.of.push('finger');
  assert.deepEqual(plan.of, ['finger.left', 'finger.right']);
  for (const bad of [{ ...deform, rest: 3 }, { ...ground, tol: NaN }, { ...near, distance: 0 },
    { ...joints, window: 0 }, { ...joints, window: undefined }, { ...joints, against: ['follow', 'lead'] },
    { ...tris, limit: -1 }, { ...section, axis: 't' }, { ...ground, of: ['missing'] }]) {
    assert.throws(() => planProbe('blender', bad, 3, ['finger', 'near', 'edge', 'outside', 'behind', 'follow', 'lead', 'deform']),
      { code: 'usage.bad-argument' });
  }
});

test('O11 section truncates by segment count in deterministic order', () => {
  const mesh = { names: ['finger'], vertices: [], indices: [] };
  for (let i = 50; i >= 0; i--) {
    mesh.indices.push(mesh.vertices.length, mesh.vertices.length + 1, mesh.vertices.length + 2);
    mesh.vertices.push([i, -1, 0], [i, 1, 0], [i, 1, 1]);
  }
  const result = measureProbe(section, new Map([[0, { meshes: [mesh] }]]), 0);
  assert.equal(result.items.length, 50);
  assert.equal(result.truncated, 1);
  assert.deepEqual(result.items[0].ends, [[0, 0, 0], [0, 0, 0.5]]);
  assert.deepEqual(result.items[49].ends, [[49, 0, 0], [49, 0, 0.5]]);
});
