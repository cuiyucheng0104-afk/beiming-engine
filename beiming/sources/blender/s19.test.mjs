// S19：从独立构造的三角形包和常驻 Blender 会话两端验证导出。
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { findBlender, loadAssets, loadCards, startSource } from './host.mjs';
import minimal from '../../kernel/contracts/scene-pack/examples/minimal.json' with { type: 'json' };
import { verifyScenePackDir } from './export-pack.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'beiming-s19-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function triangle() {
  const bin = Buffer.alloc(84);
  new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]).forEach((v, i) => bin.writeFloatLE(v, i * 4));
  for (let i = 0; i < 3; i++) bin.writeUInt32LE(i, 72 + i * 4);
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }],
    bufferViews: [[0, 36], [36, 36], [72, 12]].map(([byteOffset, byteLength]) => ({ buffer: 0, byteOffset, byteLength })),
    accessors: ['VEC3', 'VEC3', 'SCALAR'].map((type, i) => ({ type, bufferView: i, count: 3, componentType: i === 2 ? 5125 : 5126 })),
    meshes: [{ name: 'box', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }] };
  const json = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20), chunk = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + bin.length, 8);
  header.writeUInt32LE(padded.length, 12); header.write('JSON', 16);
  chunk.writeUInt32LE(bin.length); chunk.write('BIN\0', 4);
  return Buffer.concat([header, padded, chunk, bin]);
}

async function fixture(t) {
  const dir = await temporary(t), pack = structuredClone(minimal);
  pack.geometry.meshes[0].tris = 1;
  const matrix = Buffer.alloc(64);
  for (const i of [0, 5, 10, 15]) matrix.writeFloatLE(1, i * 4);
  const camera = Buffer.alloc(68);
  matrix.copy(camera); camera.writeFloatLE(1, 64);
  const row = Buffer.alloc(16); row.writeUInt32LE(1, 8);
  await mkdir(join(dir, 'frames'));
  for (const [path, bytes] of Object.entries({ 'pack.json': `${JSON.stringify(pack, null, 1)}\n`, 'geometry.glb': triangle(),
    'instances.u32': row, 'frames/instances.f32': matrix, 'frames/lights.f32': matrix, 'frames/camera.f32': camera })) {
    await writeFile(join(dir, path), bytes);
  }
  return { dir, pack };
}

for (const [id, damage] of [
  ['SP1', (dir) => rm(join(dir, 'frames/lights.f32'))],
  ['SP3', async (dir) => {
    const path = join(dir, 'instances.u32'), row = await readFile(path);
    row.writeUInt32LE(1, 12); await writeFile(path, row);
  }],
  ['SP3 singular', async (dir) => {
    const path = join(dir, 'frames/instances.f32'), row = await readFile(path);
    row.writeFloatLE(0, 0); await writeFile(path, row);
  }],
  ['SP5', (dir, pack) => {
    pack.materials[0].pattern = [{ node: 'unknown' }];
    return writeFile(join(dir, 'pack.json'), `${JSON.stringify(pack, null, 1)}\n`);
  }],
  ['SP8', (dir) => writeFile(join(dir, 'frames/camera.f32'), Buffer.alloc(67))],
]) {
  test(`S19 离线负对照 ${id}`, async (t) => {
    const { dir, pack } = await fixture(t);
    await verifyScenePackDir(dir);
    await damage(dir, pack);
    await assert.rejects(async () => verifyScenePackDir(dir), new RegExp(id.split(' ')[0]));
  });
}

const bin = findBlender();
const BLENDER = bin && /^Blender 5\.2\./m.test(execFileSync(bin, ['--version'], { encoding: 'utf8' })) && bin;
const SKIP = !BLENDER && '本机没有 Blender 5.2';
const FILES = ['frames/camera.f32', 'frames/instances.f32', 'frames/lights.f32', 'geometry.glb', 'instances.u32', 'pack.json'];

async function exportTwice(t, { id, entry, filmDir, frames, shotFrames, sourceSha256, exercise }) {
  const workspace = await temporary(t);
  const src = await startSource({ blenderBin: BLENDER, device: 'cpu', limitMs: 240000 });
  try {
    const shot = { id, in: 0, out: shotFrames, source: 'blender', host: 'cycles', mode: 'build-script', entry, colorRef: 'scene', seed: 7 };
    const session = await src.open({ film: 's19', output: { size: [960, 540], fps: '24/1' }, shot },
      { lock: null, tier: 'final', filmDir, workspace });
    const options = { frames, packId: `pack:${id}@1`, label: id, sourceSha256 };
    const run = (dir) => session.exportScenePack({ ...options, outDir: join(workspace, dir) });
    const a = await run('first'), b = await run('second');
    assert.deepEqual(a.stats, b.stats);
    assert.equal(a.digest, b.digest);
    assert.deepEqual(a.files, FILES);
    assert.equal(a.packPath, join(a.outDir, 'pack.json'));
    const result = await verifyScenePackDir(a.outDir, { blenderStats: a.stats, secondPassDir: b.outDir });
    const { pack, record, digest } = result;
    assert.equal(digest, a.digest);
    assert.deepEqual(pack.source.sha256, sourceSha256 ?? createHash('sha256').update(await readFile(join(filmDir, entry))).digest('hex'));
    assert.equal(pack.frames.count, frames?.length ?? shotFrames);
    t.diagnostic(`${id}：网格 ${a.stats.meshes}，三角面 ${a.stats.meshTris.reduce((x, y) => x + y, 0)} / 逐实例 ${a.stats.instanceTris}，实例 ${a.stats.instances}，灯 ${a.stats.lights}，帧 ${pack.frames.count}，${a.files.length} 文件 × 2，${digest}`);
    if (exercise) await exercise(session, a, b, pack, record);
    await session.close();
    await assert.rejects(run('closed'), { code: 'usage.bad-argument' });
    return { pack, record, stats: a.stats, digest, outDir: a.outDir };
  } finally { await src.stop(); }
}

const BUILTIN = `
import bpy


def build(ctx):
    scene = bpy.context.scene
    bpy.ops.object.camera_add(location=(0, -7, 2))
    camera = bpy.context.object
    scene.camera = camera
    bpy.ops.mesh.primitive_cube_add()
    base = bpy.context.object
    paint = bpy.data.materials.new('paint')
    paint.use_nodes = True
    tree = paint.node_tree
    bsdf = next(n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['IOR'].default_value = 1.8
    bevel = tree.nodes.new('ShaderNodeBevel')
    ao = tree.nodes.new('ShaderNodeAmbientOcclusion')
    ramp = tree.nodes.new('ShaderNodeMapRange')
    ramp.interpolation_type = 'SMOOTHSTEP'
    mix = tree.nodes.new('ShaderNodeMixRGB')
    tree.links.new(bevel.outputs['Normal'], bsdf.inputs['Normal'])
    tree.links.new(ao.outputs['AO'], ramp.inputs[0])
    tree.links.new(ramp.outputs[0], mix.inputs[0])
    tree.links.new(mix.outputs[0], bsdf.inputs['Base Color'])
    base.data.materials.append(paint)
    metal = bpy.data.materials.new('metal')
    metal.use_nodes = True
    base.data.materials.append(metal)
    base.data.polygons[0].material_index = 1
    mirror, array = base.copy(), base.copy()
    for obj in (mirror, array):
        scene.collection.objects.link(obj)
    array.modifiers.new('double', 'ARRAY').count = 2
    receivers = bpy.data.collections.new('receivers')
    receivers.objects.link(mirror)
    for name, kind in [('key', 'AREA'), ('fill', 'POINT')]:
        bpy.ops.object.light_add(type=kind)
        lamp = bpy.context.object
        lamp.name = name
        lamp.data.energy = 25.125
        if kind == 'AREA':
            lamp.data.shape = 'RECTANGLE'
            lamp.data.size, lamp.data.size_y = 2, 3
            lamp.light_linking.receiver_collection = receivers
        else:
            for f in range(3):
                lamp.data.energy = 10 + f
                lamp.data.keyframe_insert(data_path='energy', frame=f)

    def state(f):
        return {'objects': {base: {'location': (1+f, 2, 3)}, camera: {'location': (0, -7+f, 2)},
                            mirror: {'scale': (-1 if f < 3 else 1, 1, 1)}}}

    return {'state': state, 'entities': [{'name': n, 'class': 'part', 'objects': [o]}
                                         for n, o in [('mirror', mirror), ('base', base), ('array', array)]]}
`;

test('S19 内建：跨帧换轴、镜像共享、求值修改器、分材质与灯光链接', { skip: SKIP }, async (t) => {
  const filmDir = await temporary(t);
  await writeFile(join(filmDir, 'entry.py'), BUILTIN);
  await exportTwice(t, { id: 'builtin', entry: 'entry.py', filmDir, frames: [0, 1, 2], shotFrames: 4,
    async exercise(session, a, b, pack, record) {
      assert.deepEqual(a.stats.meshTris.toSorted((x, y) => x - y), [2, 4, 10, 20]);
      assert.equal(a.stats.instanceTris, 48);
      const { instances, frameInstances } = record.tables;
      const rows = (name) => instances.filter((_, i) => pack.instances.names[i] === name);
      assert.deepEqual(rows('mirror').map((r) => [r[0], r[3]]), rows('base').map((r) => [r[0], 1]));
      assert.deepEqual(pack.world, { color: [0, 0, 0], visibleToCamera: false });
      assert.deepEqual(pack.materials.find((m) => m.name === 'paint').pattern.map((n) => n.node), ['bevel', 'ao', 'smoothstep', 'mix']);
      assert.ok(pack.ext['blender.unexported'].paint.IOR > 1.7);
      assert.deepEqual(pack.lights.map((l) => [l.type, l.link]), [['point', undefined], ['area-rect', ['mirror']]]);
      for (const sample of frameInstances.filter(({ row }) => pack.instances.names[row] === 'base')) {
        assert.deepEqual(Array.from(sample.mat16).slice(12, 15), [1 + sample.frame, 3, -2]);
      }
      const cam = await readFile(join(a.outDir, pack.frames.camera.file));
      const stride = pack.frames.camera.shape.at(-1);
      for (let f = 0; f < 3; f++) assert.equal(cam.readFloatLE(4 * (f * stride + 14)), 7 - f);
      const output = { outDir: join(a.outDir, '..', 'rejected') };
      for (const frames of [[], [4], [-1], [0.5], [null], new Array(2)]) {
        await assert.rejects(session.exportScenePack({ ...output, frames }), { code: 'usage.bad-argument' });
      }
      await assert.rejects(session.exportScenePack({ ...output, frames: [0, 3] }), /符号|行列式|determinant|sign/i);
      assert.deepEqual(a.stats.frameLightWatts.map(([fill]) => fill), [10, 11, 12]);
      for (const changed of [{ instanceTris: 47 }, { meshTris: a.stats.meshTris.toReversed() }, { lights: 0 },
        { instances: 0 }, { frameLightWatts: a.stats.frameLightWatts.toReversed() }, { lightWatts: { ...a.stats.lightWatts, fill: 1 } }]) {
        await assert.rejects(async () => verifyScenePackDir(a.outDir, { blenderStats: { ...a.stats, ...changed } }), /Blender|SP2/);
      }
      const secondCamera = join(b.outDir, 'frames/camera.f32');
      const changedCamera = Buffer.from(cam);
      changedCamera.writeFloatLE(3, 48);
      await writeFile(secondCamera, changedCamera);
      await assert.rejects(async () => verifyScenePackDir(a.outDir, { secondPassDir: b.outDir }), /camera.f32/);
      const path = join(a.outDir, 'instances.u32'), data = await readFile(path);
      data.writeUInt32LE(0, 16 * pack.instances.names.indexOf('mirror') + 12); await writeFile(path, data);
      await assert.rejects(async () => verifyScenePackDir(a.outDir), /SP3/);
      await writeFile(join(b.outDir, 'junk'), '');
      await assert.rejects(async () => verifyScenePackDir(b.outDir), /SP1/);
    } });
});

test('S19 cards-data：默认导出全镜头，轨道相机与 render 的世界矩阵一致', { skip: SKIP }, async (t) => {
  const root = await temporary(t), cards = ['cards/camera/spline'];
  const library = await loadCards(cards), assets = await loadAssets();
  const src = await startSource({ blenderBin: BLENDER, cards, device: 'cpu' });
  try {
    const shot = { id: 'cards', in: 10, out: 13, source: 'blender', host: 'cycles', mode: 'cards-data', colorRef: 'scene',
      assets: { kit: 'asset:rtx-card@1' }, cards: [{ as: 'cam', use: 'camera.spline@1', params: { keys: [
        { f: 0, pos: [0, 1, 2], look: 'kit' }, { f: 2, pos: [2, 1, 2], look: 'kit' },
      ] } }] };
    const lock = { seeds: { cards: 7 }, shots: { cards: { shutterSamples: 1 } },
      cards: Object.fromEntries(Object.entries(library).map(([name, { card, sha256 }]) => [name, { version: card.version, impl: card.livesIn, sha256 }])),
      assets: { 'asset:rtx-card@1': assets['asset:rtx-card@1'].sha256 } };
    const session = await src.open({ film: 's19', shot, output: { size: [160, 90], fps: '24/1' } }, { filmDir: root, workspace: root, tier: 'final', lock });
    const observe = () => session.render(2, {}, ['meta']);
    const before = await observe();
    const a = await session.exportScenePack({ outDir: join(root, 'all') });
    const { pack } = await verifyScenePackDir(a.outDir, { blenderStats: a.stats });
    assert.equal(pack.id, 'pack:cards@1');
    assert.equal(pack.frames.count, 3);
    const bytes = await readFile(join(a.outDir, pack.frames.camera.file));
    const stride = 4 * pack.frames.camera.shape[1];
    for (let f = 0; f < 3; f++) assert.equal(bytes.readFloatLE(f * stride + 48), f);
    const world = Array.from({ length: 16 }, (_, i) => bytes.readFloatLE(2 * stride + i * 4));
    // render 的 rigid() 会把浮点旋转列重新归一；包直接存 A @ M，再舍入到 float32。
    assert.ok(world.every((v, i) => Math.abs(v - before.meta.camera.world[i]) < 2e-7));
    assert.deepEqual((await observe()).meta.camera, before.meta.camera);
    await session.close();
  } finally { await src.stop(); }
});

// 真实场景只在本机资产齐备时打开。入口放在各自的临时 filmDir，所有源资产只读。
const ownDir = process.env.BEIMING_OWN_DIR;
const ownScenes = [
  { id: 'head-03', project: 'mech-head', script: 'render.py', count: 1 },
  { id: 'part-03b', project: 'mech-full-a', script: 'scene.py', count: 5 },
  { id: 'shot-03c', project: 'mech-full-b', script: 'scene.py', count: 5 },
];

function ownSkip({ id, project, script }) {
  if (!BLENDER) return '本机没有 Blender';
  if (!ownDir || !existsSync(join(ownDir, project, 'build', script))) return '缺少本机场景脚本';
  if (id === 'part-03b') {
    const dir = process.env.MECH_A_STL_DIR;
    if (!dir || !existsSync(dir) || !readdirSync(dir).some((name) => /_L-1\.stl$/i.test(name))) return '缺少 03B 配套 STL';
  }
  if (id === 'shot-03c') {
    const cache = process.env.KS_CACHE;
    if (!cache || !existsSync(join(cache, 'lo', 'BS-01.npz'))) return '缺少 03C 配套网格缓存';
  }
  return false;
}

function ownEntry({ project, id }) {
  return `
import math
import os
import re
import runpy
import sys
from pathlib import Path
from tempfile import mkdtemp
from types import SimpleNamespace
from unittest.mock import patch
import bpy


def build(ctx):
    source = Path(os.environ['BEIMING_OWN_DIR']) / '${project}' / 'build'
    scratch = Path(mkdtemp(dir=Path(__file__).parent))
    scene = bpy.context.scene
    if '${id}' == 'head-03':
        # 让原始 hero 入口完成建模、机位和布光；其输出目录映射到测试临时目录。
        # run_path 使用别名路径，脚本可照常读取相邻的几何数据。
        local = scratch / 'build'
        local.mkdir()
        for dep in source.iterdir():
            if dep.suffix == '.py' or dep.name == 'geometry':
                (local / dep.name).symlink_to(dep, target_is_directory=dep.is_dir())
        with patch.object(sys, 'argv', ['blender', '--', '--views', 'hero']), \\
             patch.object(bpy.ops, 'render', SimpleNamespace(render=lambda **opts: {'FINISHED'})):
            runpy.run_path(str(local / 'render.py'), run_name='__main__')
    else:
        cache = '${id}' == 'shot-03c'
        if cache:
            os.environ['MECH_B_CACHE'] = os.environ['KS_CACHE']
        else:
            # 两版配套 STL 的文件名前缀不同。按组和零件号为加载器建立临时只读别名。
            aliases = scratch / 'stl'
            aliases.mkdir()
            for path in sorted(Path(os.environ['MECH_A_STL_DIR']).iterdir()):
                suffix = re.fullmatch(r'.+_([A-Z]+-\\d+)\\.stl', path.name, re.IGNORECASE)
                if suffix:
                    (aliases / ('MECH-A_' + suffix[1].upper() + '.stl')).symlink_to(path)
            os.environ['MECH_A_STL_DIR'] = str(aliases)
        sys.path.insert(0, str(source))
        with patch.object(sys, 'argv', ['blender', '--'] + (['--lo'] if cache else [])):
            import scene as shot
            root, parts, info = shot.build()
        if cache:
            info['cam'] = shot.camera_fit(parts, info)
            first = info['t_done'] // 2
        else:
            keep = [p for p in parts if p['key'].rstrip("'") == 'L-1']
            assert len(keep) == 2 and sum(p['mirror'] for p in keep) == 1
            for part in parts:
                if part not in keep:
                    bpy.data.objects.remove(part['obj'], do_unlink=True)
            parts = keep
            first = math.ceil(keep[0]['t0']) + 1
        shot.studio(info['height'], parts)
        camera = bpy.data.objects.new('camera', bpy.data.cameras.new('camera'))
        scene.collection.objects.link(camera)
        scene.camera = camera
        camera.data.clip_start, camera.data.clip_end = .05, 200
        for f in range(ctx.frames):
            if cache:
                shot.pose(parts, info, f=first + f)
            else:
                shot.pose(parts, f=first + f)
            shot.camera_anim(camera, first + f, info)
            for obj in [root, camera, *(part['obj'] for part in parts)]:
                for channel in ('location', 'rotation_euler', 'scale'):
                    obj.keyframe_insert(data_path=channel, frame=f)
            camera.data.keyframe_insert(data_path='lens', frame=f)
        scene.frame_set(0)
    entities = [{'name': re.sub(r'[^A-Za-z0-9_]', '_', o.name), 'class': 'part', 'objects': [o]}
                for o in scene.objects if o.type == 'MESH' and not o.hide_render]
    return {'entities': entities}
`;
}

async function ownSourceHash({ project, id }) {
  const root = join(ownDir, project), rows = [];
  async function collect(dir, prefix, include) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}/${item.name}`, path = join(dir, item.name);
      if (item.isDirectory() && item.name !== '__pycache__') await collect(path, name, include);
      if (item.isFile() && include.test(item.name)) {
        const hash = createHash('sha256').update(await readFile(path)).digest('hex');
        rows.push([name, hash]);
      }
    }
  }
  await collect(join(root, 'build'), 'build', /\.(py|json)$/);
  if (id === 'part-03b') {
    await collect(process.env.MECH_A_STL_DIR, 'stl', /\.stl$/i);
    if (existsSync(join(root, 'out/assembly'))) await collect(join(root, 'out/assembly'), 'assembly', /\.json$/);
  }
  if (id === 'shot-03c') {
    await collect(join(process.env.KS_CACHE, 'lo'), 'lo', /\.npz$/);
    if (existsSync(join(root, 'out/robot.json'))) {
      rows.push(['out/robot.json', createHash('sha256').update(await readFile(join(root, 'out/robot.json'))).digest('hex')]);
    }
  }
  rows.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return createHash('sha256').update(rows.map(([name, hash]) => `${hash}  ${name}\n`).join('')).digest('hex');
}

for (const spec of ownScenes) {
  test(`S19 真实场景 ${spec.id}`, { skip: ownSkip(spec), timeout: 240000 }, async (t) => {
    const filmDir = await temporary(t), entry = 'entry.py';
    await writeFile(join(filmDir, entry), ownEntry(spec));
    const frames = Array.from({ length: spec.count }, (_, i) => i);
    const sourceSha256 = await ownSourceHash(spec);
    const result = await exportTwice(t, { id: spec.id, filmDir, entry, frames, shotFrames: spec.count, sourceSha256 });
    assert.equal(result.pack.source.sha256, sourceSha256);
    if (spec.count > 1) {
      for (const name of ['instances', 'camera']) {
        const table = result.pack.frames[name], bytes = await readFile(join(result.outDir, table.file));
        const width = bytes.length / spec.count;
        assert.ok(!bytes.subarray(0, width).equals(bytes.subarray(-width)), `${spec.id} 的 ${name} 在运动窗口内应有变化`);
      }
    }
    if (spec.id === 'part-03b') {
      const rows = await readFile(join(result.outDir, result.pack.instances.file));
      assert.ok(result.pack.instances.names.some((_, i) => rows.readUInt32LE(i * 16 + 12) === 1), '03B 应含镜像件');
    }
  });
}
