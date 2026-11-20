// Blender 帧源的自检。前半不要 Blender：能力声明对登记表、装载和出帧的计划（报哪个错误码）。
// 后半在本机有 Blender 时实跑：常驻进程里装一个校准镜头（三个发光方块，一个匀速平移），渲多帧，
// 读回各层文件核对线性度、深度、编号、法线、坐标换轴、快门相位，编号层反算的包围盒对元数据的包围盒算交并比，元数据过契约校验。
// 再实跑一遍进程协议的失败路径：入口文件出错之后进程照常可用，渲染失败之后进程以非零退出码结束，超过时限被杀掉。
// 渲染产物都在系统临时目录里，跑完删掉。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import source from '../../kernel/contracts/source/source.json' with { type: 'json' };
import { loadContracts } from '../../kernel/contracts/validate.mjs';
import { caps, DRAFT_MAX_PIXELS, DRAFT_MAX_SIZE } from './caps.mjs';
import { findBlender, planOpen, planRender, startSource } from './host.mjs';

const CAPS = caps('5.2.0');
const { validate } = await loadContracts();
const clean = (obj, contract, schemaFile) => {
  const res = validate(obj, contract, schemaFile);
  assert.deepEqual(res.schemaErrors, []);
  assert.deepEqual(res.violations, {});
};
const code = (c) => (e) => e.code === c;

const SHOT = { id: 's01', in: 100, out: 125, source: 'blender', host: 'cycles', mode: 'build-script', entry: 'shots/cubes.py', colorRef: 'scene', seed: 7 };
const SIZE = [640, 360];
const INPUT = { film: 'f_calib', output: { size: SIZE, fps: '24/1' }, shot: SHOT };
// 上层展开好的事件表，帧号是全片帧号：镜头占全片第 100 到 124 帧
const EVENTS = {
  format: 'events/0.1', film: 'f_calib', fps: '24/1', frames: 125,
  events: [
    { id: 'cut.100', frame: 100, sub: 0, kind: 'cut', from: 'film' },
    { id: 'hit', frame: 112, sub: 0, shot: 's01', kind: 'named', from: 'film' },
    { id: 'land', frame: 112, sub: 0, shot: 's01', kind: 'named', from: 'film' },
    { id: 'tail', frame: 113, sub: 0, shot: 's01', kind: 'named', from: 'film' },
  ],
};
const LOCK = { seeds: { s01: 99 }, shots: { s01: { shutterSamples: 1 } } };

test('能力声明：结构合法，落在登记表 blender 一项之内', () => {
  clean(CAPS);
  const reg = source.sources.blender;
  assert.deepEqual(CAPS.hosts, reg.hosts);
  assert.equal(CAPS.motionBlur.mode, reg.motionBlur.mode);
  assert.equal(CAPS.determinism, reg.determinism);
  for (const [name, type] of Object.entries(reg.outputs)) assert.equal(CAPS.outputs[name] === false ? false : CAPS.outputs[name].type, type, name);
  assert.deepEqual(Object.keys(CAPS.outputs).filter((k) => k !== 'meta').sort(), Object.keys(reg.outputs).sort());
  assert.deepEqual(CAPS.modes, ['build-script']);
  assert.deepEqual(CAPS.sceneQuery, []);
  for (const mode of CAPS.modes) assert.ok(reg.modes.includes(mode), mode);
  for (const kind of CAPS.sceneQuery) assert.ok(reg.sceneQuery.includes(kind), kind);
  assert.deepEqual(CAPS.motionBlur.conflicts, ['motion']);
  assert.deepEqual(caps('5.2.0'), CAPS);
});

test('motion 层：没声明时报 unsupported-output；声明了又开着原生运动模糊时报 output-conflict', () => {
  const blur = { shutter: { angleDeg: 180, samples: 1 } };
  // 登记表里 blender 的 motion 是 false：没声明过的输出归 F3，开不开模糊都一样
  assert.throws(() => planRender(CAPS, SHOT, SIZE, 'final', blur, ['color', 'motion']), code('contract.unsupported-output'));
  assert.throws(() => planRender(CAPS, SHOT, SIZE, 'final', {}, ['color', 'motion']), code('contract.unsupported-output'));
  // F5 这一支：conflicts 里列的输出一旦声明了，开着原生运动模糊就不能要
  const withMotion = { ...CAPS, outputs: { ...CAPS.outputs, motion: { type: 'f32' } } };
  assert.throws(() => planRender(withMotion, SHOT, SIZE, 'final', blur, ['color', 'motion']), code('contract.output-conflict'));
  assert.throws(() => planRender(withMotion, { ...SHOT, shutter: { angleDeg: 90 } }, SIZE, 'final', {}, ['motion', 'color']), code('contract.output-conflict'));
  assert.deepEqual(planRender(withMotion, SHOT, SIZE, 'final', {}, ['color', 'motion']).layers, ['color', 'motion']);
  // 不在 conflicts 里的辅助层开着模糊照样交
  assert.deepEqual(planRender(CAPS, SHOT, SIZE, 'final', blur, ['color', 'depth', 'objectId', 'normal', 'meta']).layers, ['color', 'depth', 'objectId', 'normal']);
});

test('出帧计划：值域、快门自相矛盾、档位的默认值和草稿档上限', () => {
  const plan = (tier, opts, want = ['color'], size = SIZE, shot = SHOT) => planRender(CAPS, shot, size, tier, opts, want);
  assert.throws(() => plan('final', {}, ['color', 'color']), code('usage.bad-argument'));
  assert.throws(() => plan('final', { shutter: { angleDeg: 400, samples: 1 } }), code('usage.bad-argument'));
  assert.throws(() => plan('final', { shutter: { angleDeg: 90, samples: 0 } }), code('usage.bad-argument'));
  assert.throws(() => plan('final', { scale: 2 }), code('usage.bad-argument'));
  assert.throws(() => plan('final', { samples: 1.5 }), code('usage.bad-argument'));
  assert.throws(() => plan('final', { shutter: { angleDeg: 0, samples: 4 } }), code('contract.shutter-conflict'));
  assert.deepEqual(plan('final', {}), { angleDeg: 0, shutterSamples: 1, size: [640, 360], samples: 64, denoise: false, layers: ['color'] });
  assert.deepEqual(plan('draft', {}), { angleDeg: 0, shutterSamples: 1, size: [320, 180], samples: 24, denoise: true, layers: ['color'] });
  assert.deepEqual(plan('final', {}, ['meta']).layers, []);
  assert.deepEqual(plan('draft', {}, ['color'], [1920, 1080]).size, [960, 540]);
  const big = plan('draft', {}, ['color'], [3840, 2160]).size;
  assert.ok(big[0] * big[1] <= DRAFT_MAX_PIXELS && big[0] === 960 && big[1] === 540, `${big}`);
  for (const size of [[2560, 1080], [1080, 2560], [2048, 1536], [3000, 2000], [3840, 1080]]) {
    const [w, h] = plan('draft', {}, ['color'], size).size;
    assert.ok(w <= DRAFT_MAX_SIZE[0] && h <= DRAFT_MAX_SIZE[1] && w * h <= DRAFT_MAX_PIXELS, `${size} -> ${w}x${h}`);
  }
  assert.throws(() => plan('draft', { scale: 0.3 }, ['color'], [3840, 1080]), code('contract.unsupported-option'));
  const unstringable = JSON.parse('{"toString":"180"}');
  assert.throws(() => plan('final', { shutter: { angleDeg: unstringable } }, ['meta']), code('usage.bad-argument'));
  assert.throws(() => plan('final', { scale: unstringable }, ['meta']), code('usage.bad-argument'));
  assert.throws(() => plan('final', { samples: unstringable }, ['meta']), code('usage.bad-argument'));
  assert.throws(() => plan('final', { scale: 0.001 }), code('contract.unsupported-option'));
  assert.equal(plan('final', { samples: 2 ** 24 }).samples, 2 ** 24);
  assert.throws(() => plan('final', { samples: 2 ** 24 + 1 }), code('contract.unsupported-option'));
  assert.throws(() => plan('constructor', {}), code('usage.bad-argument'));
  const inherited = Object.create({ draft: { samples: 1 } });
  assert.equal(plan('draft', {}, ['color'], SIZE, { ...SHOT, tiers: inherited }).samples, 24);
  assert.throws(() => plan('draft', { scale: 1 }, ['color'], [1920, 1080]), code('contract.unsupported-option'));
  assert.throws(() => plan('draft', { samples: 64 }), code('contract.unsupported-option'));
  assert.equal(plan('draft', {}, ['color'], SIZE, { ...SHOT, tiers: { draft: { samples: 8 } } }).samples, 8);
});

test('装载计划：模式、锁文件、装不了的输入各报各的错误码', () => {
  const env = { lock: null, tier: 'final', workspace: 'w', filmDir: 'd' };
  assert.deepEqual(planOpen(CAPS, INPUT, env), { seed: 7, entry: 'shots/cubes.py' });
  assert.throws(() => planOpen(CAPS, { ...INPUT, shot: { ...SHOT, mode: 'native-code' } }, env), code('contract.unsupported-mode'));
  assert.throws(() => planOpen(CAPS, { ...INPUT, shot: { ...SHOT, host: 'page' } }, env), code('contract.unsupported-mode'));
  assert.throws(() => planOpen(CAPS, { ...INPUT, shot: { ...SHOT, seed: undefined } }, env), code('env.lock-required'));
  assert.throws(() => planOpen(CAPS, { ...INPUT, shot: { ...SHOT, cards: [{ card: 'x@1' }] } }, env), code('env.lock-required'));
  const locked = { ...env, lock: LOCK };
  assert.deepEqual(planOpen(CAPS, INPUT, locked), { seed: 99, shutterSamples: 1, entry: 'shots/cubes.py' });
  assert.throws(() => planOpen(CAPS, INPUT, { ...env, lock: { seeds: {}, shots: {} } }), code('usage.bad-argument'));
  for (const key of ['seeds', 'shots']) {
    assert.throws(() => planOpen(CAPS, INPUT, { ...env, lock: { ...LOCK, [key]: Object.create(LOCK[key]) } }), code('usage.bad-argument'));
  }
  assert.throws(() => planOpen(CAPS, INPUT, { ...env, lock: { seeds: { s01: 7 }, shots: { s01: Object.create({ shutterSamples: 7 }) } } }), code('usage.bad-argument'));
  // 装不了的输入只有卡、资产、叠加层三样；事件表照常装，空着带来的也照常装
  assert.throws(() => planOpen(CAPS, { ...INPUT, overlays: [{ shot: 's01' }] }, locked), code('contract.unsupported-input'));
  assert.throws(() => planOpen(CAPS, { ...INPUT, shot: { ...SHOT, cards: [{ card: 'x@1' }] } }, locked), code('contract.unsupported-input'));
  assert.throws(() => planOpen(CAPS, { ...INPUT, assets: { hdri: { path: 'a.exr' } } }, locked), code('contract.unsupported-input'));
  assert.deepEqual(planOpen(CAPS, { ...INPUT, events: EVENTS, assets: {}, overlays: [] }, env), { seed: 7, entry: 'shots/cubes.py' });
  assert.throws(() => planOpen(CAPS, { ...INPUT, shot: { ...SHOT, source: 'three' } }, env), code('usage.bad-argument'));
  assert.throws(() => planOpen(CAPS, { ...INPUT, shot: { ...SHOT, entry: undefined } }, env), code('usage.bad-argument'));
  assert.throws(() => planOpen(CAPS, INPUT, { ...env, tier: 'preview' }), code('usage.bad-argument'));
  // 带 renderer 对象的镜头：出帧用的那一套取 renderer 里的
  const viaRenderer = { ...SHOT, source: 'three', host: 'page', mode: 'native-code', renderer: { source: 'blender', host: 'cycles', mode: 'build-script', entry: 'alt.py' } };
  assert.equal(planOpen(CAPS, { ...INPUT, shot: viaRenderer }, env).entry, 'alt.py');
});

test('没有 Blender：报 env.missing-tool', async () => {
  assert.equal(findBlender({ BEIMING_BLENDER: join(tmpdir(), 'no-such-blender') }), null);
  await assert.rejects(() => startSource({ blenderBin: null }), code('env.missing-tool'));
});

test('行协议接受启动横幅，拒绝坏应答，停止超时后回收进程', { skip: process.platform === 'win32' && 'POSIX shell 启动器' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'beiming-protocol-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = await scratchDirs();
  const launcher = join(dir, 'launcher');
  const script = (body) => writeFile(launcher, `#!/bin/sh\necho 'launcher banner'\nread -r hello\n${body}\n`, { mode: 0o700 });
  const hello = `echo '{"id":1,"ok":true,"result":{"version":"5.2.0","backend":"CPU"}}'`;
  const start = () => startSource({ blenderBin: launcher, handshakeMs: 5000, stopMs: 100 });
  const env = { lock: null, tier: 'final', workspace: dir, filmDir: dir };
  for (const response of ['null', '{"id":999,"ok":true,"result":{}}', '{"id":1,"op":"hello"}']) {
    await script(`echo '${response}'\nexec sleep 30`);
    await assert.rejects(start, /应答格式或序号错误.*launcher banner/);
  }
  await script(`${hello}\nread -r request\necho bad-reply\nexec sleep 30`);
  const malformed = await start();
  try {
    await assert.rejects(() => malformed.open(INPUT, env), /应答不是 JSON.*bad-reply/);
  } finally { await malformed.stop(); }
  await script(`${hello}\nread -r quit\nexec sleep 30`);
  const stubborn = await start();
  await assert.rejects(() => stubborn.stop(), /Blender stop 超过 100 毫秒/);
  assert.equal(await scratchDirs(), before);
});

// 校准镜头的入口文件。坐标按北冥的口径写（米，右手系，Y 向上），用 ctx.to_blender 换进 Blender。
// 相机在 (0, 1, 6) 平视 −Z，竖直视场角 40 度。cube 边长 1，中心 (0.1 × (f − 12), 1, 0)，每帧右移 0.1 米，线性光发光 (3.2, 0.8, 0.4)。
// pole 是 0.2 × 2 × 0.2 的竖杆，中心 (−3.2, 1, −1)；blocker 挡住它在视平线以下的那一半。
const ENTRY = `
import math
import bpy

FACES = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]


def glow(name, color):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    out, em = nodes.new('ShaderNodeOutputMaterial'), nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (color[0], color[1], color[2], 1.0)
    em.inputs['Strength'].default_value = 1.0
    mat.node_tree.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return mat


def box(ctx, name, center, size, color):
    hx, hy, hz = size[0] / 2, size[2] / 2, size[1] / 2
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(x, y, z) for x in (-hx, hx) for y in (-hy, hy) for z in (-hz, hz)], [], FACES)
    mesh.materials.append(glow(name, color))
    obj = bpy.data.objects.new(name, mesh)
    obj.location = ctx.to_blender(center)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build(ctx):
    scene = bpy.context.scene
    data = bpy.data.cameras.new('cam')
    data.sensor_fit, data.sensor_height = 'VERTICAL', 24.0
    data.lens = 24.0 / 2.0 / math.tan(math.radians(40.0) / 2.0)
    data.clip_start, data.clip_end = 0.1, 100.0
    cam = bpy.data.objects.new('cam', data)
    cam.location, cam.rotation_euler = ctx.to_blender((0.0, 1.0, 6.0)), (math.pi / 2.0, 0.0, 0.0)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cube = box(ctx, 'cube', (-1.2, 1.0, 0.0), (1.0, 1.0, 1.0), (3.2, 0.8, 0.4))
    cube.keyframe_insert('location', frame=0)
    cube.location = ctx.to_blender((1.2, 1.0, 0.0))
    cube.keyframe_insert('location', frame=24)
    # 匀速：两个关键帧之间线性插值
    anim = cube.animation_data
    curves = anim.action.fcurves if hasattr(anim.action, 'fcurves') else anim.action.layers[0].strips[0].channelbag(anim.action_slot).fcurves
    for curve in curves:
        for key in curve.keyframe_points:
            key.interpolation = 'LINEAR'
    pole = box(ctx, 'pole', (-3.2, 1.0, -1.0), (0.2, 2.0, 0.2), (0.1, 0.5, 0.1))
    blocker = box(ctx, 'blocker', (-3.2 * 6.0 / 7.0, 0.5, 0.0), (0.6, 1.0, 0.2), (0.1, 0.1, 0.5))
    return {'entities': [
        {'name': 'cube', 'class': 'part', 'role': 'hero', 'objects': [cube]},
        {'name': 'pole', 'class': 'part', 'role': 'mustSee', 'objects': [pole]},
        {'name': 'blocker', 'class': 'part', 'objects': [blocker]},
    ]}
`;

const BLENDER = findBlender();
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}：期望 ${want} ± ${tol}，实际 ${got}`);
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** 读一个层文件：核对字节数和哈希，返回 { at(x, y) → 这个像素的各分量, w, h } */
async function readLayer(workspace, ref, kind) {
  const bytes = await readFile(join(workspace, ref.file));
  const [h, w, n] = ref.shape;
  assert.equal(bytes.length, h * w * n * 4, `${ref.file} 的字节数`);
  assert.equal(ref.hash, sha(bytes), `${ref.file} 的哈希`);
  clean(ref, 'source', 'layer-ref.schema.json');
  const data = new (kind === 'u32' ? Uint32Array : Float32Array)(new Uint8Array(bytes).buffer);
  return { w, h, data, at: (x, y) => Array.from(data.subarray((y * w + x) * n, (y * w + x + 1) * n)) };
}

/** 编号层里编号是 id 的像素的包围盒 [x0, y0, x1, y1]（像素的外沿） */
function idBox(layer, id) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < layer.h; y++) for (let x = 0; x < layer.w; x++) {
    if (layer.data[y * layer.w + x] !== id) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  return [x0, y0, x1, y1];
}

/** 两个包围盒 [x0, y0, x1, y1] 的交并比 */
function iouOf(a, b) {
  const inter = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

/** 颜色层按亮度（Rec.709 权重，线性光）加权的重心的横坐标，像素 */
function lumaCentroidX(layer) {
  let sum = 0, sumX = 0;
  for (let y = 0; y < layer.h; y++) for (let x = 0; x < layer.w; x++) {
    const i = (y * layer.w + x) * 4, l = 0.2126 * layer.data[i] + 0.7152 * layer.data[i + 1] + 0.0722 * layer.data[i + 2];
    sum += l; sumX += l * (x + 0.5);
  }
  return sumX / sum;
}

const scratchDirs = async () => (await readdir(tmpdir())).filter((n) => n.startsWith('beiming-blender-')).length;

describe('Blender 实跑', { concurrency: false }, () => {
test('实跑：常驻 Blender 渲校准镜头，层文件、元数据、交并比、快门相位', { skip: BLENDER ? false : '本机没有 Blender', timeout: 600000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-blender-test-'));
  const before = await scratchDirs();
  after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'cubes.py'), ENTRY.replace('    scene.camera = cam', `    scene.camera = cam
    scene.render.engine = 'BLENDER_EEVEE' if bpy.app.version >= (5, 0, 0) else 'BLENDER_EEVEE_NEXT' if bpy.app.version >= (4, 2, 0) else 'BLENDER_EEVEE'
    scene.render.motion_blur_position = 'CENTER'`));
  const input = { ...INPUT, shot: { ...SHOT, entry: 'cubes.py' }, events: EVENTS };
  clean(EVENTS);
  const src = await startSource({ blenderBin: BLENDER });
  try {
    t.diagnostic(`Blender ${src.caps().version}，后端 ${src.device.backend}${src.device.gpu ? `（${src.device.gpu}）` : ''}`);
    clean(src.caps());
    const env = { lock: null, tier: 'final', workspace: join(root, 'final'), filmDir: root };
    const session = await src.open(input, env);
    const manifest = session.manifest();
    clean(manifest, 'source', 'manifest.schema.json');
    // 没有场景包：编号是实体名按字节序排的名次
    assert.deepEqual(manifest, { frames: 25, entities: [{ id: 1, name: 'blocker', class: 'part' }, { id: 2, name: 'cube', class: 'part' }, { id: 3, name: 'pole', class: 'part' }] });
    await assert.rejects(() => src.open(input, env), code('usage.bad-argument'));
    await assert.rejects(() => src.open(input, { tier: 'final', workspace: env.workspace, filmDir: root }), code('usage.bad-argument'));
    await assert.rejects(() => session.render(25, {}, ['color']), code('usage.bad-argument'));
    await assert.rejects(() => session.render(0, {}, ['color', 'motion']), code('contract.unsupported-output'));
    await assert.rejects(() => session.query(0, { kind: 'bbox3d', of: ['cube'] }), code('contract.unsupported-query'));

    const want = ['color', 'depth', 'objectId', 'normal', 'meta'];
    const frames = {};
    for (const f of [0, 12, 24]) {
      const { meta, layers } = await session.render(f, { samples: 8 }, want);
      clean(meta);
      assert.deepEqual(Object.keys(layers).sort(), ['color', 'depth', 'normal', 'objectId']);
      const color = await readLayer(env.workspace, layers.color, 'f32'), ids = await readLayer(env.workspace, layers.objectId, 'u32');
      frames[f] = { meta, layers, color, ids };
      t.diagnostic(`第 ${f} 帧耗时（毫秒）：写状态 ${meta.timing.stateMs.toFixed(1)}，渲染 ${meta.timing.renderMs.toFixed(1)}，读回 ${meta.timing.readbackMs.toFixed(1)}`);
      assert.deepEqual(layers.color.shape, [360, 640, 4]);
      assert.deepEqual([meta.frame, meta.shotFrame, meta.seed, meta.size, meta.hash.color], [100 + f, f, 7, [640, 360], layers.color.hash]);
      assert.deepEqual([meta.source.id, meta.source.renderer, meta.source.host, meta.source.tier, meta.source.samples], ['blender', 'blender', 'cycles', 'final', 8]);
      assert.equal(meta.source.denoise, undefined);
      // 编号层反算的包围盒对元数据的包围盒；cube 和 blocker 都没被挡
      for (const name of ['cube', 'blocker']) {
        const e = meta.entities.find((x) => x.name === name), box = idBox(ids, e.id), iou = iouOf(box, e.bbox2d);
        t.diagnostic(`第 ${f} 帧 ${name} 的交并比 ${iou.toFixed(4)}`);
        assert.ok(iou >= 0.95, `第 ${f} 帧 ${name} 的交并比 ${iou}`);
        // 编号层取的是 sub = 0 的像素中心：每条边离元数据的包围盒不到 1 像素。cube 每帧走 9 像素，掺进别的时刻这一条就过不了
        box.forEach((v, i) => near(v, e.bbox2d[i], 1, `第 ${f} 帧 ${name} 编号层包围盒的第 ${i} 条边，像素`));
      }
      // 换轴：cube 的三维包围盒在 Y 向上的坐标里
      const cx = 0.1 * (f - 12), cube = meta.entities.find((x) => x.name === 'cube');
      [cx - 0.5, 0.5, -0.5, cx + 0.5, 1.5, 0.5].forEach((v, i) => near(cube.bbox3d[i], v, 1e-5, `第 ${f} 帧 cube.bbox3d[${i}]`));
      near(cube.depth[0], 5.5, 1e-5, 'cube 最近的平面深度');
      near(cube.depth[1], 6.5, 1e-5, 'cube 最远的平面深度');
      near(cube.visible, 1, 0.02, 'cube 的可见比例');
      const pole = meta.entities.find((x) => x.name === 'pole');
      [-3.3, 0, -1.1, -3.1, 2, -0.9].forEach((v, i) => near(pole.bbox3d[i], v, 1e-5, `pole.bbox3d[${i}]`));
      assert.ok(pole.visible > 0.4 && pole.visible < 0.6, `pole 被挡住下半截，可见比例应在 0.5 上下，实际 ${pole.visible}`);
      assert.equal(meta.entities.find((x) => x.name === 'blocker').visible, null);
    }

    // 第 12 帧 cube 在画面正中：相机、线性度、深度、编号、法线
    const mid = frames[12];
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 6, 1].forEach((v, i) => near(mid.meta.camera.world[i], v, 1e-6, `camera.world[${i}]`));
    near(mid.meta.camera.fovYDeg, 40, 1e-4, 'fovYDeg');
    [3.2, 0.8, 0.4, 1].forEach((v, i) => near(mid.color.at(320, 180)[i], v, 1e-4, `正中像素的线性颜色分量 ${i}（HDR 不截）`));
    assert.deepEqual(mid.ids.at(320, 180), [2]);
    assert.deepEqual(mid.ids.at(10, 10), [0]);
    const depth = await readLayer(env.workspace, mid.layers.depth, 'f32'), normal = await readLayer(env.workspace, mid.layers.normal, 'f32');
    near(depth.at(320, 180)[0], 5.5, 1e-4, '正中像素的平面深度');
    assert.equal(depth.at(10, 10)[0], 1e10);
    // 取像素中心、不抗锯齿：这一帧 cube 正对相机，轮廓就是它的屏幕包围盒（四条边离最近的像素中心 0.04 像素以上），
    // 编号是 cube 的像素必须正好是像素中心落在包围盒里的那些
    const cubeBox = mid.meta.entities.find((x) => x.name === 'cube').bbox2d;
    let offCenter = 0;
    for (let y = 0; y < mid.ids.h; y++) for (let x = 0; x < mid.ids.w; x++) {
      const inside = x + 0.5 > cubeBox[0] && x + 0.5 < cubeBox[2] && y + 0.5 > cubeBox[1] && y + 0.5 < cubeBox[3];
      if ((mid.ids.data[y * mid.ids.w + x] === 2) !== inside) offCenter++;
    }
    assert.equal(offCenter, 0, `编号层和「像素中心在不在包围盒里」对不上的像素有 ${offCenter} 个`);
    // 镜头没设背景：什么都没打到的像素 A 和 R、G、B 都是 0
    assert.deepEqual(mid.color.at(10, 10), [0, 0, 0, 0]);
    // 深度是平面深度，不是到相机的直线距离：blocker 的正面在 5.9 米，取它偏在画面左下的中心像素（直线距离是 6.53 米）
    const focalPx = 180 / Math.tan(20 * Math.PI / 180);
    const bx = Math.floor(320 + focalPx * (-3.2 * 6 / 7) / 5.9), by = Math.floor(180 + focalPx * 0.5 / 5.9);
    assert.deepEqual(mid.ids.at(bx, by), [1]);
    near(depth.at(bx, by)[0], 5.9, 1e-3, 'blocker 正面的平面深度，米');
    [0, 0, 1].forEach((v, i) => near(normal.at(bx, by)[i], v, 1e-5, `blocker 正面的相机空间法线分量 ${i}`));
    [0, 0, 1].forEach((v, i) => near(normal.at(320, 180)[i], v, 1e-5, `正中像素的相机空间法线分量 ${i}`));
    assert.deepEqual(normal.at(10, 10), [0, 0, 0]);
    assert.equal(mid.meta.stats.tris, 36);
    // 事件：只列事件表里全片帧号等于这一帧的条目，只留 id 和 frame
    assert.deepEqual(frames[0].meta.events, [{ id: 'cut.100', frame: 100 }]);
    assert.deepEqual(mid.meta.events, [{ id: 'hit', frame: 112 }, { id: 'land', frame: 112 }]);
    assert.deepEqual(frames[24].meta.events, []);

    // 同一帧再渲一遍：辅助层是 CPU 上 1 个样本、取像素中心，必须逐位相同；颜色层在显卡上，只记下来不判
    const again = await session.render(12, { samples: 8 }, want);
    for (const name of ['depth', 'objectId', 'normal']) assert.equal(again.layers[name].hash, mid.layers[name].hash, `${name} 层重渲的哈希`);
    assert.notEqual(again.layers.depth.file, mid.layers.depth.file);
    t.diagnostic(`第 12 帧重渲：辅助层 3 层逐位相同，颜色层${again.layers.color.hash === mid.layers.color.hash ? '也逐位相同' : '不逐位相同'}`);

    // 开 180 度原生运动模糊：拖影中点在 f + 0.25（快门从帧起点打开），辅助层仍是 sub = 0，和不开模糊时逐位相同
    const blurred = await session.render(12, { samples: 32, shutter: { angleDeg: 180, samples: 1 } }, ['color', 'objectId', 'meta']);
    clean(blurred.meta);
    assert.equal(blurred.meta.camera.shutterAngleDeg, 180);
    assert.equal(blurred.layers.objectId.hash, mid.layers.objectId.hash);
    // 尺子：不开模糊的第 13 帧和第 12 帧，整图亮度重心差出来的就是每帧走的像素数
    const next = await session.render(13, { samples: 8 }, ['color']);
    const pxPerFrame = lumaCentroidX(await readLayer(env.workspace, next.layers.color, 'f32')) - lumaCentroidX(mid.color);
    const phase = (lumaCentroidX(await readLayer(env.workspace, blurred.layers.color, 'f32')) - lumaCentroidX(mid.color)) / pxPerFrame;
    t.diagnostic(`拖影中点的相位 f + ${phase.toFixed(4)}（期望 0.25）`);
    near(phase, 0.25, 0.03, '拖影中点的相位，帧');

    // 只要元数据：不出像素
    const only = await session.render(3, {}, ['meta']);
    clean(only.meta);
    assert.deepEqual(only.layers, {});
    assert.deepEqual([only.meta.stats, only.meta.hash.color, only.meta.timing.renderMs], [null, null, 0]);
    assert.ok(only.meta.entities.every((e) => e.visible === null));
    near(only.meta.entities.find((x) => x.name === 'cube').bbox3d[0], 0.1 * (3 - 12) - 0.5, 1e-5, '第 3 帧 cube 的位置（匀速）');
    await session.close();

    // 同一个进程里再装一遍，草稿档，带锁文件：一半尺寸、24 采样、带降噪，种子取锁里的
    const draftEnv = { ...env, lock: LOCK, tier: 'draft', workspace: join(root, 'draft') };
    const draft = await src.open(input, draftEnv);
    assert.deepEqual(draft.manifest(), manifest);
    await assert.rejects(() => draft.render(0, { samples: 64 }, ['color']), code('contract.unsupported-option'));
    const d = await draft.render(12, {}, ['color', 'meta']);
    clean(d.meta);
    assert.deepEqual([d.meta.size, d.layers.color.shape, d.meta.source.samples, d.meta.source.tier, d.meta.seed], [[320, 180], [180, 320, 4], 24, 'draft', 99]);
    assert.match(d.meta.source.denoise, /^oidn-(gpu|cpu)$/);
    t.diagnostic(`草稿档降噪设备 ${d.meta.source.denoise}`);
    const small = await readLayer(draftEnv.workspace, d.layers.color, 'f32');
    [3.2, 0.8, 0.4].forEach((v, i) => near(small.at(160, 90)[i], v, 0.05, `草稿档正中像素的线性颜色分量 ${i}`));
    await draft.close();
    await assert.rejects(() => draft.render(12, {}, ['color']), code('usage.bad-argument'));
  } finally {
    await src.stop();
  }
  assert.equal(await scratchDirs(), before, '帧源停掉之后临时目录里不留中间 EXR 的目录');
});

test('实跑：DCI 草稿首帧投影、入口覆盖设置、非法请求恢复与并发层文件', { skip: !BLENDER, timeout: 180000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-blender-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'auto.py'), ENTRY.replace("'VERTICAL'", "'AUTO'").replace('    scene.camera = cam', `    scene.camera = cam
    data.lens = 50
    data.sensor_width = 36
    scene.render.resolution_percentage = 50
    scene.render.use_border = True
    scene.render.use_crop_to_border = True
    scene.render.border_min_x = scene.render.border_min_y = 0.25
    scene.render.border_max_x = scene.render.border_max_y = 0.75`));
  const src = await startSource({ blenderBin: BLENDER });
  try {
    const env = { lock: null, workspace: root, filmDir: root, tier: 'draft' };
    const shot = { ...SHOT, entry: 'auto.py' };
    const draft = await src.open({ ...INPUT, shot, output: { ...INPUT.output, size: [2048, 1080] } }, env);
    const want = ['color', 'objectId', 'meta'];
    const first = await draft.render(3, {}, want);
    const again = await draft.render(3, {}, want);
    const stable = (meta) => JSON.stringify({ ...meta, timing: null, stats: null, hash: { ...meta.hash, color: null } });
    clean(first.meta);
    clean(again.meta);
    assert.equal(stable(first.meta), stable(again.meta));
    assert.equal(first.layers.objectId.hash, again.layers.objectId.hash);
    const [w, h] = first.meta.size;
    assert.deepEqual([w, h], [960, 506]);
    assert.deepEqual(first.layers.color.shape, [h, w, 4]);
    near(first.meta.camera.fovYDeg, 2 * Math.atan(36 * h / (100 * w)) * 180 / Math.PI, 1e-5, 'AUTO 相机按实际尺寸量视场角');
    const ids = await readLayer(root, first.layers.objectId, 'u32');
    const cube = first.meta.entities.find((e) => e.name === 'cube');
    idBox(ids, cube.id).forEach((edge, i) => near(edge, cube.bbox2d[i], 0.51, '编号层外沿与首帧投影'));
    await draft.close();

    const session = await src.open({ ...INPUT, shot }, { ...env, tier: 'final' });
    const unstringable = JSON.parse('{"toString":"180"}');
    for (const value of ['180', true, [90], null, Infinity, NaN, unstringable]) {
      await assert.rejects(() => session.render(3, { shutter: { angleDeg: value, samples: 1 } }, ['color']), code('usage.bad-argument'));
    }
    for (const scale of ['0.5', true, [0.5], null, Infinity, NaN, unstringable]) {
      await assert.rejects(() => session.render(3, { scale }, ['color']), code('usage.bad-argument'));
    }
    await assert.rejects(() => session.render(3, { samples: unstringable }, ['meta']), code('usage.bad-argument'));
    await assert.rejects(() => session.render(3, { samples: 2 ** 31 }, ['color']), code('contract.unsupported-option'));
    const [full, half] = await Promise.all([session.render(3, {}, ['color']), session.render(3, { scale: 0.5 }, ['color'])]);
    assert.notEqual(full.layers.color.file, half.layers.color.file);
    for (const [result, width, height] of [[full, 640, 360], [half, 320, 180]]) {
      clean(result.meta);
      const layer = await readLayer(root, result.layers.color, 'f32');
      assert.deepEqual([layer.w, layer.h], [width, height]);
      assert.deepEqual(result.meta.size, [width, height]);
    }
    await session.close();
  } finally { await src.stop(); }
});

test('实跑：进程协议的失败路径', { skip: BLENDER ? false : '本机没有 Blender', timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-blender-test-'));
  const before = await scratchDirs();
  after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'cubes.py'), ENTRY);
  await writeFile(join(root, 'switch.py'), `import bpy\ndef build(ctx):\n    bpy.context.window.scene = bpy.data.scenes.new('other')\n    return {'entities': []}\n`);
  await writeFile(join(root, 'broken.py'), 'def build(ctx):\n    raise ValueError("broken on purpose")\n');
  await writeFile(join(root, 'no-camera.py'), 'def build(ctx):\n    return {"entities": []}\n');
  await writeFile(join(root, 'a-file'), 'x');
  const at = (entry) => ({ ...INPUT, shot: { ...SHOT, entry } });

  // 时限：1 毫秒之内 Blender 起不完，宿主把它杀掉，临时目录照样清掉
  await assert.rejects(() => startSource({ blenderBin: BLENDER, limitMs: 1 }), /Blender hello 超过 1 毫秒/);
  assert.equal(await scratchDirs(), before);

  const src = await startSource({ blenderBin: BLENDER, limitMs: 120000 });
  try {
    const env = { lock: null, tier: 'final', workspace: join(root, 'out'), filmDir: root };
    // 入口文件自己出错：open 失败，不带错误码；进程还在，接着能装别的镜头
    await assert.rejects(() => src.open(at('broken.py'), env), (e) => e.code === undefined && /ValueError: broken on purpose/.test(e.message));
    await assert.rejects(() => src.open(at('no-camera.py'), env), (e) => e.code === undefined && /scene\.camera/.test(e.message));
    await assert.rejects(() => src.open(at('switch.py'), env), /切换了当前场景/);
    const ok = await src.open(at('cubes.py'), env);
    assert.equal((await ok.render(12, { samples: 1 }, ['color', 'objectId'])).meta.shotFrame, 12);
    await ok.close();
    // 渲染失败（这里是层文件写不出去：工作目录指到一个普通文件底下）：这次 render 报错，进程以退出码 3 结束
    const doomed = await src.open(at('cubes.py'), { ...env, workspace: join(root, 'a-file', 'under') });
    await assert.rejects(() => doomed.render(12, { samples: 1 }, ['color']), (e) => e.code === undefined && /Error/.test(e.message));
    await assert.rejects(() => doomed.render(12, { samples: 1 }, ['color']), /Blender 进程已退出（退出码 3）/);
    await assert.rejects(() => doomed.close(), /Blender 进程已退出（退出码 3）/);
  } finally {
    await src.stop();
  }
  assert.equal(await scratchDirs(), before, '进程死掉之后临时目录也要清掉');
});
});
