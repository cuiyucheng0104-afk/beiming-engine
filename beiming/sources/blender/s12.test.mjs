// S12：输入计划、F9、真实 Blender 求值网格和渲染隔离。
import Ajv2020 from 'ajv/dist/2020.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fail } from '../../api/envelope.mjs';
import { checks } from '../../kernel/contracts/source/check.mjs';
import resultSchema from '../../kernel/contracts/source/schema/query-result.schema.json' with { type: 'json' };
import registry from '../../kernel/contracts/source/source.json' with { type: 'json' };
import { caps } from './caps.mjs';
import { findBlender, finishQuery, planFrame, planQuery, startSource } from './host.mjs';

const CAPS = caps('5.2.0');
const NAMES = ['part.b', 'part', 'part.a.z', 'part.a', 'partly', 'root'];
const BAD_FRAMES = [-1, 2, 0.5, NaN, Infinity, '0', null, undefined, 0n, {}, Symbol('frame')];
const code = (want) => (e) => { assert.equal(e.code, want, e.message); return true; };
const bad = code('usage.bad-argument');
const valid = new Ajv2020({ strict: false }).compile(resultSchema);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `期望 ${b} ± ${eps}，实际 ${a}`);
const nearArray = (a, b) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i])); };

function unsupported(e) {
  code('contract.unsupported-query')(e);
  assert.ok(e.next.length);
  assert.deepEqual(fail(e.code, e.message, { next: e.next }).next, e.next);
  return true;
}

test('S12：五种查询逐项登记，按字节序展开通配并快照，against 可省略', () => {
  assert.deepEqual(CAPS.sceneQuery, registry.sources.blender.sceneQuery);
  for (const kind of CAPS.sceneQuery) {
    const of = ['part.*', 'root', 'part.b'];
    const plan = planQuery(CAPS, { kind, of, tol: -0 }, NAMES);
    of[0] = 'part';
    assert.deepEqual(plan, { kind, of: ['part.a', 'part.a.z', 'part.b', 'root'], tol: 0 });
  }
  for (const kind of ['intersect', 'contact']) {
    const q = { kind, of: ['root'], against: ['root', 'part.*'], tol: 0.0005 };
    assert.deepEqual(planQuery(CAPS, q, NAMES), { kind, of: ['root'], tol: 0.0005, against: ['part.a', 'part.a.z', 'part.b', 'root'] });
    assert.deepEqual(planQuery(CAPS, { ...q, against: ['missing.*'] }, NAMES).against, []);
  }
  assert.deepEqual(planQuery(CAPS, runInNewContext('({kind:"bbox3d", of:["part"]})'), NAMES).of, ['part']);
  assert.deepEqual(planQuery(CAPS, Object.assign(Object.create(null), { kind: 'bbox3d', of: ['absent.*'] }), NAMES).of, []);
  assert.throws(() => planQuery(CAPS, { kind: 'volume', of: [], extra: true }, NAMES), unsupported);
  assert.throws(() => planQuery({ sceneQuery: [] }, { kind: 'contact' }, NAMES), unsupported);
});

test('S12：查询拒绝非纯数据，全程零 Proxy 陷阱与访问器调用', () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error('调用了陷阱'); };
  const traps = { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap };
  const of = ['part'];
  const good = { kind: 'anchor', of };
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const invalid = [null, [], 'anchor', new Date(), { of }, { kind: 0, of }, { kind: 'anchor' },
    { ...good, extra: true }, { ...good, [Symbol('extra')]: 1 }, Object.create(good),
    Object.defineProperty({ ...good }, 'tol', { value: 0 }), Object.create(new Proxy({}, traps)),
    { ...good, get kind() { return trap(); } }, { ...good, get against() { return trap(); } },
    new Proxy(good, traps), new Proxy(good, {}), revoked.proxy];
  for (const tol of [-1, NaN, Infinity, null, '0', false, undefined, new Proxy({}, traps)]) invalid.push({ ...good, tol });
  const lists = [[], 'part', [null], ['*'], ['part.*.a'], ['part-1'], ['missing'], new Array(2),
    [new Proxy({}, traps)], new Proxy(of, traps), revoked.proxy,
    Object.setPrototypeOf(new Array(1), { 0: 'part' }), Object.assign([...of], { extra: 1 }),
    Object.assign([...of], { [Symbol('extra')]: 1 }), Object.defineProperty([...of], '0', { enumerable: false }),
    Object.defineProperty([...of], '0', { get: trap })];
  for (const list of lists) invalid.push({ ...good, of: list }, { ...good, against: list });
  for (const q of invalid) assert.throws(() => planQuery(CAPS, q, NAMES), bad);
  assert.equal(calls, 0);
});

test('S12：F23 帧界与宿主 F9 的严重度、UTF-8 并列顺序和数值校验', () => {
  for (const frame of BAD_FRAMES) assert.throws(() => planFrame(2, frame), bad);
  assert.equal(planFrame(2, 0), 0);
  assert.equal(planFrame(2, 1), 1);
  const item = (a, b, value) => ({ a, b, value, unit: 'm', at: [-0, 0, -0] });
  const many = Array.from({ length: 49 }, (_, i) => item('a', `part${i}`, i + 1));
  const items = [item('a', '\u{10000}', -0), item('a', '', -0), ...many];
  const cut = finishQuery('contact', { kind: 'contact', items });
  assert.ok(valid(cut), JSON.stringify(valid.errors));
  assert.deepEqual([cut.items.length, cut.truncated, cut.items[0].value, cut.items[49]], [50, 1, 49, { ...items[1], value: 0, at: [0, 0, 0] }]);
  assert.ok(!Object.hasOwn(finishQuery('contact', { kind: 'contact', items: cut.items }), 'truncated'));
  assert.deepEqual(finishQuery('contact', cut), cut);
  for (const broken of [NaN, Infinity, -Infinity, null]) {
    assert.throws(() => finishQuery('contact', { kind: 'contact', items: [item('a', 'b', broken)] }), code('contract.bad-value'));
    assert.throws(() => finishQuery('contact', { kind: 'contact', items: [{ ...item('a', 'b', 1), at: [1, 2, broken] }] }), code('contract.bad-value'));
  }
});

const ENTRY = `
import math
import bpy


def build(ctx):
    scene, rt = bpy.context.scene, ctx.runtime
    bpy.ops.object.camera_add(location=(0, -12, 2), rotation=(math.pi / 2, 0, 0))
    scene.camera = bpy.context.object
    entities = []

    def register(name, obj, kind='part'):
        entities.append({'name': name, 'class': kind, 'objects': [obj] if obj else []})
        return obj

    def cube(name, center, size=1):
        bpy.ops.mesh.primitive_cube_add(size=size, location=ctx.to_blender(center))
        cube = bpy.context.object
        return register(name, cube) if name else cube

    def triangle(name, verts):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([ctx.to_blender(p) for p in verts], [], [(0, 1, 2)])
        ob = bpy.data.objects.new(name, mesh)
        scene.collection.objects.link(ob)
        return register(name, ob)

    register('part', None, 'assembly')
    base = cube('part.a', (0, 1, 0))
    moving = cube('part.b', (0.9995, 1, 0))
    cube('part.c', (-1, 1, 0))  # a 与 c 贴合。
    cube('part.d', (0, 1, 0))  # d 和 a 故意重合，通过装配元数据豁免。
    cube('deep', (4, -.25, -2))
    cube('shallow', (5, .25, -2))
    cube('outer', (8, 1, 0), 2)
    cube('inner', (8, 1, 0), .5)
    cube('same.a', (8, 1, 3))
    cube('same.b', (8, 1, 3))
    # 两条长边在 XZ 投影交叉，最近点都在长边内部，Y 方向间隔 0.2 m。
    triangle('edge.a', [(-10, 2, -1), (-8, 2, 1), (-10, 2, -2)])
    triangle('edge.b', [(-10, 2.2, 1), (-8, 2.2, -1), (-10, 2.2, 2)])
    triangle('flat.a', [(11, 1, 0), (13, 1, 0), (11, 1, 2)])
    triangle('flat.b', [(13, 1, 2), (13, 1, 1), (12, 1, 2)])
    # 大三角面的所有顶点、边和中心都在 outer 之外，只有面内部切入。
    triangle('slice', [(-10, 1, -20), (30, 1, -20), (8, 1, 100)])

    root = register('changed', bpy.data.objects.new('changed', None), 'assembly')
    scene.collection.objects.link(root)
    root.location = (2, 3, 4)
    child = cube(None, (1, 0, 0))
    child.parent = root
    modifier = child.modifiers.new('evaluated geometry', 'ARRAY')
    modifier.count = 2
    modifier.relative_offset_displace = (2, 0, 0)
    coll = bpy.data.collections.new('query instance fixture')
    template = cube(None, (0, 0, 0))
    scene.collection.objects.unlink(template)
    coll.objects.link(template)
    instance = register('instance', bpy.data.objects.new('instance', None), 'assembly')
    scene.collection.objects.link(instance)
    instance.instance_type, instance.instance_collection = 'COLLECTION', coll
    instance.location = (-3, 2, 4)

    for i in range(53):
        cube(f'crowd.p{i:02}', (20 + i, -i/8, 0))

    def state(f):
        return {'objects': {moving: {'location': ctx.to_blender((0.9995 + .001*f, 1, 0))}}}

    def meta(f):
        collector = rt.MetaCollector()
        collector.add_anchor('part.a#mount', (1, 2, 3), blender=True)
        collector.add_anchor('part.a#alternate', (0, 0, 0))
        return collector

    return {'entities': entities, 'state': state, 'meta': meta, 'ignore_pairs': [('part.a', 'part.d')]}
`;
const BLENDER = process.env.BLENDER_BIN || findBlender();

test('S12：Blender 实测穿插、接触、最小间隙、评值网格、坐标、F9 与查询后出帧', { skip: !BLENDER && '本机没有 Blender', timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-s12-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 's12.py'), ENTRY);
  const src = await startSource({ blenderBin: BLENDER, device: 'cpu', limitMs: 60000 });
  t.after(() => src.stop());
  t.diagnostic(`Blender ${src.caps().version}，后端 ${src.device.backend}`);
  const smallGap = { kind: 'probe.contact', of: ['part.b'], against: ['part.a'], tol: 0.0001 };
  const suppressSmallGap = { ...smallGap, tol: 0.0008 };
  const shot = {
    id: 's12', in: 20, out: 22, source: 'blender', host: 'cycles', mode: 'build-script',
    entry: 's12.py', colorRef: 'scene', seed: 7, params: { sceneProbes: [smallGap, suppressSmallGap] },
  };
  const session = await src.open({ film: 's12', output: { size: [64, 36], fps: '24/1' }, shot }, { lock: null, tier: 'final', filmDir: root, workspace: root });
  const query = async (kind, of, more = {}, f = 0) => {
    const res = await session.query(f, { kind, of, ...more });
    assert.ok(valid(res), JSON.stringify(valid.errors));
    assert.equal(res.kind, kind);
    for (const row of res.items) assert.ok([row.value, ...row.at].every((n) => Number.isFinite(n) && !Object.is(n, -0)));
    return res;
  };
  const observations = [];
  const observed = (res, total) => {
    observations.push({ kind: res.kind, status: 'ok', total, returned: res.items.length,
      ...(res.truncated !== undefined && { truncated: res.truncated }) });
    return res;
  };
  for (const frame of BAD_FRAMES) await assert.rejects(session.query(frame, { kind: 'volume', of: ['part.a'] }), bad);
  await assert.rejects(session.query(0, { kind: 'volume', of: ['part.a'] }), (e) => {
    observations.push({ kind: 'volume', status: 'error', code: e.code });
    return unsupported(e);
  });
  const rendering = () => session.render(0, { samples: 2 }, ['color', 'meta']);
  const before = await rendering();

  const of = ['part.a', 'part.b'];
  const [overlap] = observed(await query('intersect', of), 1).items;
  assert.deepEqual([overlap.a, overlap.b], of);
  assert.ok(overlap.value >= 0.0003 && overlap.value <= 0.0008, `穿插深度 ${overlap.value}`);
  assert.deepEqual((await query('intersect', of, { against: of })).items, [overlap]);
  assert.deepEqual((await query('intersect', of, { against: ['absent.*'] })).items, []);
  assert.deepEqual((await query('intersect', of, { tol: 0.0008 })).items, []);
  assert.deepEqual((await query('intersect', ['part.a', 'part.c'])).items, []);
  assert.deepEqual((await query('intersect', ['part.a', 'part.d'])).items, []);
  assert.deepEqual((await query('intersect', ['part.*'])).items.map(({ a, b }) => [a, b]), [['part.a', 'part.b'], ['part.b', 'part.d']]);
  assert.deepEqual((await query('intersect', of, {}, 1)).items, []);
  const [gap] = observed(await query('contact', ['part.b'], { against: ['part.a'], tol: 0.0001 }, 1), 1).items;
  near(gap.value, 0.0005);
  near(gap.at[0], 0.50025);
  assert.deepEqual([gap.a, gap.b], ['part.b', 'part.a']);
  const atThreshold = { kind: 'probe.contact', items: [gap] };
  const belowThreshold = { kind: 'probe.contact', items: [] };
  assert.deepEqual(await session.query(1, { ...smallGap, tol: gap.value }), atThreshold);
  assert.deepEqual(await session.query(1, suppressSmallGap), belowThreshold);
  assert.deepEqual((await query('contact', ['part.b'], { against: ['part.a'], tol: suppressSmallGap.tol }, 1)).items, [gap]);
  assert.deepEqual((await session.render(1, {}, ['meta'])).meta.ext['scene.probes'], [atThreshold, belowThreshold]);
  const manyGaps = { kind: 'probe.contact', of: ['crowd.*'], against: ['part.a'] };
  const limited = await session.query(0, manyGaps);
  assert.equal(limited.truncated, 3);
  const filtered = await session.query(0, { ...manyGaps, tol: 27 });
  assert.ok(filtered.items.length > 0 && filtered.items.length < 50);
  assert.deepEqual(filtered, { kind: 'probe.contact', items: limited.items.filter(({ value }) => value >= 27) });
  const [touch] = (await query('contact', ['part.a', 'part.c'])).items;
  near(touch.value, 0);
  near(touch.at[0], -0.5);
  assert.equal((await query('contact', of)).items[0].value, 0);
  assert.equal((await query('contact', ['part.a', 'part.d'])).items[0].value, 0);
  t.diagnostic(`0.5 mm 穿插实测 ${overlap.value} m，0.5 mm 间隙实测 ${gap.value} m，贴合实测 ${touch.value} m`);

  assert.deepEqual((await query('intersect', ['inner', 'outer'])).items.map((i) => i.value), [0.75]);
  assert.deepEqual((await query('intersect', ['outer', 'inner'], { tol: 0.7 })).items.map((i) => i.value), [0.75]);
  assert.deepEqual((await query('intersect', ['same.*'])).items.map((i) => i.value), [0.5]);
  assert.equal((await query('contact', ['inner', 'outer'])).items[0].value, 0);
  near((await query('intersect', ['outer', 'slice'])).items[0].value, 1);
  assert.equal((await query('contact', ['outer', 'slice'])).items[0].value, 0);
  near((await query('contact', ['edge.*'])).items[0].value, 0.2);
  assert.deepEqual((await query('intersect', ['flat.*'])).items, []);
  near((await query('contact', ['flat.*'])).items[0].value, Math.SQRT1_2);

  const boxes = observed(await query('bbox3d', ['changed', 'instance', 'part']), 3).items;
  const box = Object.fromEntries(boxes.map((i) => [i.a, i]));
  nearArray(box.changed.at, [2.5, 3.5, -3.5, 5.5, 4.5, -2.5]);
  near(box.changed.value, Math.sqrt(11));
  nearArray(box.instance.at, [-3.5, 3.5, -2.5, -2.5, 4.5, -1.5]);
  nearArray(box.part.at, [-1.5, 0.5, -0.5, 1.4995, 1.5, 0.5]);
  const anchors = observed(await query('anchor', ['part.a', 'changed']), 3).items;
  assert.deepEqual(anchors.map(({ a, at }) => [a, at]), [
    ['changed#origin', [2, 4, -3]], ['part.a#mount', [1, 3, -2]], ['part.a#alternate', [0, 0, 0]],
  ]);
  for (const { value, at } of anchors) near(value, Math.hypot(...at));
  assert.deepEqual((await query('belowGround', ['shallow', 'deep'])).items, [
    { a: 'deep', value: 0.75, unit: 'm', at: [3.5, -0.75, -2.5] },
    { a: 'shallow', value: 0.25, unit: 'm', at: [4.5, -0.25, -2.5] },
  ]);
  assert.deepEqual((await query('belowGround', ['deep', 'shallow'], { tol: 0.25 })).items.map((i) => i.a), ['deep']);
  const crowd = observed(await query('belowGround', ['crowd.*']), 53);
  assert.deepEqual([crowd.items.length, crowd.truncated, crowd.items[0].a, crowd.items[49].a], [50, 3, 'crowd.p52', 'crowd.p03']);
  assert.ok(!Object.hasOwn(await query('bbox3d', ['part.a']), 'truncated'));
  assert.deepEqual(observations.filter((o) => o.status === 'ok').map((o) => o.kind).sort(), [...CAPS.sceneQuery].sort());
  const report = { format: 'source-check/0.1', caps: src.caps(), queries: observations };
  for (const check of ['F8', 'F9', 'F15', 'F24']) assert.deepEqual(checks[check](report, { registries: { source: registry } }), [], check);

  near((await query('bbox3d', ['part.b'], {}, 1)).items[0].at[0], 0.5005);
  const after = await rendering();
  assert.equal(after.layers.color.hash, before.layers.color.hash);
  assert.deepEqual(after.meta.entities, before.meta.entities);
  await session.close();
  await assert.rejects(session.query(0, { kind: 'bbox3d', of }), bad);
});
