import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findBlender, loadCards, startSource } from '../sources/blender/host.mjs';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import { dataValidators } from './sweep-schema.mjs';

const root = join(import.meta.dirname, '..');
const cards = [
  { id: 'light.studio', kind: 'lighting', dir: 'cards/lighting/studio', exams: ['cal:light.studio'] },
  { id: 'mat.library', kind: 'material', dir: 'cards/material/library', exams: ['1-2', 'cal:mat.library'] },
];

test('T13 两张公开卡可校验、注册、检索，参数的实际数据 schema 有效', async () => {
  const library = await loadCards(cards.map(c => c.dir));
  const registry = createCardRegistry(Object.values(library).map(x => x.card), { allowReproduced: true });
  for (const { id, kind, dir, exams } of cards) {
    const { card } = library[id];
    assert.deepEqual(validateCard(card), { ok: true, leaks: [], violations: {}, schemaErrors: [] });
    assert.deepEqual([card.kind, card.visibleToAgent, card.livesIn, card.calibration, card.exams],
      [kind, true, ['source:blender'], 'studio-balls@1', exams]);
    assert.deepEqual(card.impl, [{ livesIn: 'source:blender', entry: `${dir}/index.py`, shape: 'create',
      hosts: [{ host: 'cycles', version: '5.2.0' }], selftest: `${dir}/selftest.test.mjs` }]);
    assert.deepEqual(card.status, [{ level: 'reproduced', host: 'cycles', source: '5.2.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]);
    assert.equal(registry.getCard(`${id}@1`)?.id, id);
    assert.ok(registry.searchCards({ kind, livesIn: 'source:blender', q: card.title }).some(hit => hit.id === id));
    const fields = dataValidators(card);
    assert.ok(fields.length > 0);
    for (const [key, validate] of fields) {
      assert.ok(validate(resolveParams(card)[key]), JSON.stringify(validate.errors));
      assert.equal(validate(42), false, key);
      if (key === 'spec') {
        assert.ok(validate({ anchor: [0, .25, 0], cues: [{ frame: 8, exposureScale: .25 }] }));
        assert.equal(validate({ anchor: [0, .25] }), false);
      }
      if (key === 'assignments') {
        assert.ok(validate({ 'part.*': 'copper', trim: 'plastic_black' }));
        assert.equal(validate({ trim: 'absent' }), false);
      }
    }
    for (const f of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      assert.notEqual(f.name, '__pycache__');
      if (f.isFile()) assert.deepEqual(scanCardLeaks(readFileSync(join(f.parentPath, f.name), 'utf8')), [], f.name);
    }
  }
  assert.deepEqual(scanCardLeaks(readFileSync(import.meta.filename, 'utf8')), []);
});

test('T13 两张卡的离线自测在独立进程中实际运行', () => {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.NODE_TEST_CONTEXT;
  for (const { dir } of cards) {
    const run = spawnSync(process.execPath, ['--test', join(root, dir, 'selftest.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /pass [1-9]/);
  }
});

// 同一个 C8 搭景入口、镜头和 OCIO 显示链。临时 PNG16 读编码值，EXR32 保留 HDR 峰值。
const setup = String.raw`
import json, runpy, sys
from pathlib import Path
from types import SimpleNamespace
import bpy
import numpy as np

sys.dont_write_bytecode = True
root, scratch = map(Path, sys.argv[sys.argv.index('--') + 1:])
def load(relative):
    return runpy.run_path(str(root / relative))

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
ctx = SimpleNamespace(bpy=bpy, hostScene=scene)
load('calib/studio-balls@1/shot.blender.py')['build'](ctx)
for obj in list(scene.objects):
    if obj.type == 'LIGHT':
        bpy.data.objects.remove(obj, do_unlink=True)
studio = load('cards/lighting/studio/index.py')['create']
balls = bpy.data.collections.new('receivers')
scene.collection.children.link(balls)
for obj in scene.objects:
    if obj.name.startswith('ball.'):
        balls.objects.link(obj)

def rig(preset='hero', scale=1, **options):
    h = studio(ctx, {'preset': preset, 'subjectScaleM': .5 * scale,
                     'spec': {'anchor': [0, .25 * scale, 0], 'receiverCollection': balls.name, **options}})
    h['apply'](0, 0)
    return h

w, h = 640, 360
r, c = scene.render, scene.cycles
r.engine = 'CYCLES'
r.resolution_x, r.resolution_y, r.resolution_percentage = w, h, 100
r.dither_intensity = 0
r.image_settings.color_mode = 'RGB'
scene.display_settings.display_device = 'sRGB'
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
c.samples, c.use_adaptive_sampling, c.use_animated_seed = 32, False, False
c.use_denoising, c.denoiser, c.denoising_use_gpu = True, 'OPENIMAGEDENOISE', False
# 与四球标定保持同一反弹预算，避免把额外间接光误当作卡的功率偏差。
c.denoising_prefilter = 'ACCURATE'
c.max_bounces, c.glossy_bounces, c.diffuse_bounces = 6, 4, 2
c.volume_bounces, c.transparent_max_bounces, c.transmission_bounces = 0, 4, 2
c.sample_clamp_indirect = 4
c.caustics_reflective = c.caustics_refractive = False
prefs = bpy.context.preferences.addons['cycles'].preferences
device = 'CPU'
for backend in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
    try:
        prefs.compute_device_type = backend
    except TypeError:
        continue
    prefs.refresh_devices()
    gpu = next((d for d in prefs.devices if d.type == backend), None)
    if gpu:
        for d in prefs.devices:
            d.use = d == gpu
        device, c.device = backend + ' / ' + gpu.name, 'GPU'
        break
print('T13 device:', bpy.app.version_string, device, flush=True)

def pixels(path, raw=False):
    im = bpy.data.images.load(str(path), check_existing=False)
    try:
        if raw:
            im.colorspace_settings.name = 'Non-Color'
        assert tuple(im.size) == (w, h)
        data = np.empty(w * h * 4, dtype=np.float32)
        im.pixels.foreach_get(data)
        rgb = data.reshape(h, w, 4)[:, :, :3]
        assert np.isfinite(rgb).all()
        return rgb
    finally:
        bpy.data.images.remove(im)

def render(seed=71, with_linear=False):
    c.seed = seed
    bpy.ops.render.render()
    result = bpy.data.images['Render Result']
    r.image_settings.file_format, r.image_settings.color_depth = 'PNG', '16'
    png = scratch / 'display.png'
    result.save_render(str(png), scene=scene)
    display = pixels(png, raw=True)
    if not with_linear:
        return display
    r.image_settings.file_format, r.image_settings.color_depth = 'OPEN_EXR', '32'
    exr = scratch / 'linear.exr'
    result.save_render(str(exr), scene=scene)
    return display, pixels(exr)

# 像素中心射线到球心的垂距；剔除最外 2.5% 半径，不把轮廓或背景算入测光。
def sphere_mask(obj):
    cam = scene.camera
    local = cam.matrix_world.inverted() @ obj.location
    x, y = np.meshgrid(np.arange(w) + .5 - w / 2, np.arange(h) + .5 - h / 2)
    k = cam.data.sensor_height / (cam.data.lens * h)
    t = (x*k*local.x + y*k*local.y - local.z) / np.sqrt(1 + (x*k)**2 + (y*k)**2)
    roi = (t > 0) & (local.length_squared - t*t < (.975 * .25)**2)
    assert roi.sum() > 800
    return roi

luma = np.array([.2126, .7152, .0722])
`;

const lightingProbe = String.raw`
gray, chrome = (sphere_mask(scene.objects['ball.' + n]) for n in ('gray', 'chrome'))
presets = [('hero', 6, 0), ('explode', 5, 0), ('poster', 6, 0),
           ('mech-matte', 5, 3), ('mech-plated', 12, 11), ('wide-matte', 5, 3)]
for name, count, linked in presets:
    original_world = scene.world
    handle = rig(name, cues=[{'frame': 8, 'exposureScale': .25}])
    lights = [o for o in scene.objects if o.type == 'LIGHT' and not o.hide_render]
    assert len(lights) == handle['readings']()['lightCount'] == count
    assert sum(o.light_linking.receiver_collection == balls for o in lights) == linked
    powers = np.array([o.data.energy for o in lights])
    handle['apply'](8, .5)
    assert np.allclose([o.data.energy for o in lights], powers * .25)
    handle['apply'](0, 0)
    assert np.array_equal([o.data.energy for o in lights], powers)
    assert scene.world != original_world and handle['meta'](0)['readings'] == handle['readings']()
    display, linear = render(with_linear=True)
    g, ch, hdr = display[gray] @ luma, display[chrome] @ luma, linear[chrome] @ luma
    print('T13 C8:', name, 'gray', g.mean(), 'chrome', ch.mean(), 'peak', hdr.max(), flush=True)
    assert .10 <= g.mean() <= .72 and g.max() < .98, (name, g.mean(), g.max())
    assert hdr.max() >= hdr.mean() * 2 and ch.max() >= .45
    assert ch.max() >= ch.mean() + .20 and np.mean(ch > .98) <= .20
    handle['dispose']()
    assert scene.world == original_world

# 尺度探针保留地台，把同一灰球移至棚光锚点。每个对照只改一个变量。
gray_obj = scene.objects['ball.gray']
gray_obj.location.x = 0
for obj in scene.objects:
    if obj.type == 'MESH' and obj.name not in ('ball.gray', 'floor'):
        obj.hide_render = True
handle = rig()
baseline = render()
def diff(other):
    return float(np.abs(other - baseline).mean(dtype=np.float64))
noise = (diff(render(173)) + diff(render(299))) / 2
handle['dispose']()
for obj in (gray_obj, scene.objects['floor'], scene.camera):
    obj.location *= 100
    if obj.type == 'MESH':
        obj.scale *= 100
scene.camera.data.clip_end *= 100
scene.camera.data.clip_start *= 100
handle = rig(scale=100)
error = diff(render())
active = [o for o in scene.objects if o.type == 'LIGHT' and not o.hide_render and o.data.energy > 0]
assert len(active) == 6
for obj in active:
    assert obj.data.type == 'AREA' and obj.data.shape == 'RECTANGLE' and not obj.visible_camera
    obj.data.energy /= 10000
negative = diff(render())
print('T13 AgX: ' + json.dumps(dict(meanDifference=error, noiseFloor=noise, unscaledPower=negative)), flush=True)
assert noise > 0 and error <= 2 * noise, (error, noise)
assert negative > 5 * noise, (negative, noise)
handle['dispose']()
`;

const materialProbe = String.raw`
lib = load('cards/material/library/index.py')
base = scene.objects['ball.gray']
base.location.x = 0
for obj in scene.objects:
    if obj.type == 'MESH' and obj.name != 'floor':
        obj.hide_render = True
samples = {}
for name in ('copper', 'plastic_black', 'emit_white'):
    obj = base.copy()
    obj.name = 'sample.' + name
    obj.data = base.data.copy()
    scene.collection.objects.link(obj)
    samples[name] = obj
handle = lib['create'](ctx, {'assignments': {'sample.cop*': 'copper', 'sample.plastic_black': 'plastic_black', 'sample.emit_white': 'emit_white'}})
readings = handle['meta'](0)['readings']
assert handle['readings']() == readings
assert (readings['materialCount'], readings['assignedCount']) == (21, 3), readings
mats = handle['materials']
assert len(mats) == len(set(mats.values())) == 21
for name, mat in mats.items():
    tree = mat.node_tree
    assert mat.use_nodes and all(link.is_valid for link in tree.links), name
    output = next(n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
    assert output.inputs[0].links[0].from_node.type == 'BSDF_PRINCIPLED', name
light = rig()
roi = sphere_mask(base)
means = {}
for name, obj in samples.items():
    assert obj.active_material == mats[name], name
    obj.hide_render = False
    y = render()[roi] @ luma
    assert np.mean(y > .01) > .95, name
    means[name] = float(y.mean())
    obj.hide_render = True
print('T13 material AgX: ' + json.dumps(means), flush=True)
assert means['emit_white'] > means['copper'] > means['plastic_black']
light['dispose']()
handle['dispose']()
`;

const blender = process.env.BLENDER_BIN || findBlender();
const version = blender && spawnSync(blender, ['--version'], { encoding: 'utf8', timeout: 15000 });
function blenderSkip() {
  if (!version || version.error?.code === 'ENOENT') return '没有 Blender';
  assert.ifError(version.error);
  assert.equal(version.status, 0, version.stderr);
  return !/^Blender 5\.2\./m.test(version.stdout) && '需要 Blender 5.2';
}
const skip = blenderSkip();
for (const [title, probe] of [['四球校准与 100× 尺度、噪声和功率负对照', lightingProbe], ['21 种材质实建与同机位三种单球读回', materialProbe]]) {
  test(`T13 Cycles：${title}`, { skip, timeout: 240000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'bm-t13-'));
    try {
      const script = join(dir, 'probe.py');
      await writeFile(script, setup + probe);
      const run = spawnSync(blender, ['-b', '-noaudio', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', root, dir],
        { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 220000, maxBuffer: 8 * 1024 * 1024 });
      for (const line of run.stdout.split('\n').filter(s => s.startsWith('T13 '))) t.diagnostic(line);
      assert.ifError(run.error);
      assert.equal(run.status, 0, (run.stdout + run.stderr).slice(-5000));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('T13 cards-data：两张卡与资产共同装载、交回帧读数并关闭镜头', { skip, timeout: 120000 }, async () => {
  const dirs = ['cards/asset/bbox-proxy', ...cards.map(c => c.dir)];
  const library = await loadCards(dirs);
  const workspace = await mkdtemp(join(tmpdir(), 'bm-t13-host-'));
  let source;
  try {
    source = await startSource({ blenderBin: blender, cards: dirs, limitMs: 60000 });
    const film = 'f_t13', seed = 13;
    const input = { film, output: { size: [64, 48], fps: '24/1' }, shot: {
      id: 's01', in: 0, out: 1, seed, colorRef: 'scene', source: 'blender', host: 'cycles', mode: 'cards-data',
      cards: [{ as: 'proxy', use: 'asset.bbox-proxy@1', params: {} }, { as: 'lights', use: 'light.studio@1', params: {} },
        { as: 'surface', use: 'mat.library@1', params: { assignments: { 'bod*': 'copper' } } }],
    } };
    const lock = { film, seeds: { s01: seed }, shots: { s01: { shutterSamples: 1 } },
      sources: { blender: { version: source.caps().version, host: 'cycles' } },
      cards: Object.fromEntries(Object.entries(library).map(([id, { card, sha256 }]) =>
        [id, { version: card.version, impl: card.livesIn, sha256 }])) };
    const session = await source.open(input, { lock, tier: 'draft', workspace, filmDir: root });
    try {
      const { meta: { readings } } = await session.render(0, {}, ['meta']);
      assert.deepEqual([readings['surface.materialCount'], readings['surface.assignedCount'], readings['lights.lightCount']], [21, 1, 6]);
    } finally {
      // 宿主按装载顺序释放，材质卡到这里时代理网格可能已被资产卡删除。
      await session.close();
    }
  } finally {
    try { await source?.stop(); } finally { await rm(workspace, { recursive: true, force: true }); }
  }
});
