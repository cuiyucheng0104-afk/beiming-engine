// S14：纯数据变异与真实 Cycles → 线性 EXR → AgX → 显示亮度对拍。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { bakeAgxLut, SHAPER } from '../../comp/lut/bake-agx.mjs';
import { branchFilter, runTool, tools } from '../../comp/stitch.mjs';
import { writeExr } from '../../verify/exr/exr.mjs';
import { FLOOR, registeredTemplate } from '../../verify/predicates.mjs';
import { findBlender } from './host.mjs';
import { compareDraftFinalTiers, exrToDisplayLumaFrame, normalizedBboxIou, runBlenderTierParity } from './s14-tier-parity.mjs';

const fullSize = [512, 288], halfSize = [256, 144];
const closeTo = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-12, `${value} ≠ ${expected}`);

test('S14 A：按各自帧尺寸归一，偏移、相离、零面积及非法包围盒', () => {
  assert.equal(normalizedBboxIou([32, 18, 128, 72], halfSize, [64, 36, 256, 144], fullSize), 1);
  assert.equal(normalizedBboxIou([0, 0, 128, 72], halfSize, [128, 0, 384, 144], fullSize), 1 / 3);
  assert.equal(normalizedBboxIou([0, 0, 128, 72], halfSize, [256, 0, 512, 144], fullSize), 0);
  assert.equal(normalizedBboxIou([32, 18, 32, 72], halfSize, [64, 36, 256, 144], fullSize), 0);
  for (const box of [[-1, 0, 128, 72], [0, 0, 257, 72], [40, 0, 39, 1], [0, 0, NaN, 72], Array(4), null]) {
    assert.throws(() => normalizedBboxIou(box, halfSize, [64, 36, 256, 144], fullSize), /bbox2d/);
  }
  assert.throws(() => normalizedBboxIou([0, 0, 1, 1], [Infinity, 1], [0, 0, 1, 1], fullSize), /size/);
});

function fixture() {
  const tier = (size, scale) => ({
    roles: { hero: 'body' },
    predicates: [{ id: 'inside_frame', pass: true }, { id: 'visible', pass: true }],
    frames: [10, 12].map((frame) => ({
      meta: { frame, size, entities: [
        { name: 'body', bbox2d: [32, 18, 128, 72].map(n => n * scale) },
        { name: 'knob', role: 'mustSee', bbox2d: [136, 18, 168, 42].map(n => n * scale) },
        { name: 'floor', bbox2d: [0, 0, ...size] },
      ] },
      luma: { p01: 0.12, p50: 0.5, p99: 0.8 },
    })),
  });
  const draft = tier(halfSize, 1), final = tier(fullSize, 2);
  final.frames[1].meta.entities[0].bbox2d[0] += 1;
  final.frames[1].luma = { p01: 0.11, p50: 0.51, p99: 0.82 };
  return { draft, final };
}

test('S14 A：分辨率不同、包围盒和亮度略抖，三项通过并保留最差帧', () => {
  const report = compareDraftFinalTiers(fixture());
  assert.deepEqual([report.pass, report.predicates.pass, report.bbox.pass, report.luma.pass], [true, true, true, true]);
  assert.equal(report.bbox.worstFrame, 12);
  assert.equal(report.bbox.worstEntity, 'body');
  closeTo(report.bbox.minIou, 191 / 192);
  for (const [key, diff] of Object.entries({ p01: 0.01, p50: 0.01, p99: 0.02 })) closeTo(report.luma.maxDiffs[key], diff);
  assert.deepEqual(report.frames.map(row => row.frame), [10, 12]);
  assert.deepEqual(report.frames[0].bbox.map(row => row.entity), ['body', 'knob']);
});

test('S14 A：谓词翻转和条目错序逐项定位，两档同为 false 仍相等', () => {
  const inputs = fixture();
  inputs.final.predicates[1].pass = false;
  const report = compareDraftFinalTiers(inputs);
  assert.equal(report.pass, false);
  assert.equal(report.predicates.pass, false);
  assert.deepEqual(report.predicates.diffs, [{ index: 1, draft: { id: 'visible', pass: true }, final: { id: 'visible', pass: false } }]);
  assert.equal(report.bbox.pass && report.luma.pass, true);
  inputs.draft.predicates[1].pass = false;
  assert.equal(compareDraftFinalTiers(inputs).pass, true);
  inputs.final.predicates.reverse();
  assert.equal(compareDraftFinalTiers(inputs).predicates.diffs.length, 2);
});

test('S14 A：任一帧的 hero 或其他角色包围盒超线即判红', () => {
  for (const [i, entity] of ['body', 'knob'].entries()) {
    const inputs = fixture();
    const box = inputs.final.frames[1].meta.entities[i].bbox2d;
    inputs.final.frames[1].meta.entities[i].bbox2d = box.map((v, axis) => v + (axis % 2 ? 0 : 20));
    const report = compareDraftFinalTiers(inputs);
    assert.equal(report.pass, false);
    assert.equal(report.bbox.pass, false);
    assert.ok(report.bbox.minIou < 0.95);
    assert.deepEqual(report.bbox.violations, [{ frame: 12, entity, iou: report.bbox.minIou }]);
    assert.equal(report.predicates.pass && report.luma.pass, true);
  }
});

test('S14 A：p01、p50、p99 独立报越界，恰好 5 个百分点通过', () => {
  for (const [percentile, value] of Object.entries({ p01: 0.04, p50: 0.6, p99: 0.91 })) {
    const inputs = fixture();
    inputs.final.frames[1].luma[percentile] = value;
    const report = compareDraftFinalTiers(inputs);
    assert.equal(report.pass, false);
    assert.equal(report.luma.pass, false);
    assert.deepEqual(report.luma.violations, [{ frame: 12, percentile, draft: inputs.draft.frames[1].luma[percentile], final: value, diff: report.luma.maxDiffs[percentile] }]);
    assert.ok(report.luma.maxDiffs[percentile] > 0.05);
    assert.equal(report.predicates.pass && report.bbox.pass, true);
  }
  const inputs = fixture();
  inputs.final.frames[1].luma.p50 = 0.55;
  assert.equal(compareDraftFinalTiers(inputs).pass, true);
  assert.equal(compareDraftFinalTiers({ ...inputs, maxLumaPctDiff: 0.049 }).luma.pass, false);
  assert.equal(compareDraftFinalTiers({ ...inputs, minBboxIou: 1 }).bbox.pass, false);
});

test('S14 A：帧、实体、谓词或亮度证据缺失或非法时拒绝比较', () => {
  for (const [edit, error] of [
    [({ final }) => final.frames.pop(), /帧数/],
    [({ final }) => { final.frames[1].meta.frame = 13; }, /帧号/],
    [({ draft }) => { draft.frames[0].meta.frame = 12; }, /帧号/],
    [({ final }) => final.frames[1].meta.entities.shift(), /final.*12.*body/],
    [({ final }) => final.frames[1].meta.entities.splice(1, 1), /final.*12.*knob/],
    [({ draft, final }) => { for (const tier of [draft, final]) tier.frames[1].meta.entities.splice(1, 1); }, /12.*knob/],
    [({ draft, final }) => { draft.frames[0].meta.entities.shift(); final.frames[0].meta.entities.shift(); }, /10.*body/],
    [({ final }) => { delete final.frames[1].meta.entities[0].bbox2d; }, /12.*body.*bbox2d/],
    [({ draft }) => { delete draft.frames[0].luma.p01; }, /draft.*10.*p01/],
    [({ final }) => { final.frames[1].luma.p50 = Infinity; }, /final.*12.*p50/],
    [({ final }) => final.predicates.pop(), /谓词.*数量/],
    [({ final }) => { final.predicates[0].pass = 'true'; }, /predicates.*pass/],
    [(inputs) => { inputs.minBboxIou = NaN; }, /minBboxIou/],
  ]) {
    const inputs = fixture();
    edit(inputs);
    assert.throws(() => compareDraftFinalTiers(inputs), error);
  }
});

const ENTRY = `
import bpy
from mathutils import Vector


def build(ctx):
    scene = bpy.context.scene
    gain = EXPOSURE_GAIN if ctx.tier == 'final' else 1.0
    world = bpy.data.worlds.new('studio ambient')
    world.use_nodes = True
    world.node_tree.nodes.get('Background').inputs['Strength'].default_value = 0.4 * gain
    scene.world = world
    entities = []

    def aim(obj, target):
        obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

    def block(name, loc, size, color, metallic=0.0, role=None, bevel=0.04):
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = size
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        if bevel:
            edges = obj.modifiers.new('machined edges', 'BEVEL')
            edges.width, edges.segments = bevel, 3
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = (*color, 1)
        bsdf.inputs['Metallic'].default_value = metallic
        bsdf.inputs['Roughness'].default_value = 0.58
        obj.data.materials.append(mat)
        entity = {'name': name, 'class': 'part', 'objects': [obj]}
        if role:
            entity['role'] = role
        entities.append(entity)

    bpy.ops.object.camera_add(location=(3.2, -6.2, 3.25))
    cam = scene.camera = bpy.context.object
    cam.data.lens = 39
    block('body', (0, 0, .61), (1.9, 1.15, 1.2), (.26, .36, .44), .4, 'hero')
    block('cap', (-.2, 0, 1.38), (1.3, .86, .3), (.42, .38, .29), .55, 'mustSee')
    block('bracket', (1.34, .16, .29), (.44, .65, .56), (.32, .16, .08), .3, 'mustSee')
    block('floor', (0, 0, -.1), (200, 200, .2), (.27, .27, .27), bevel=0)
    for name, loc, power, size in [('key', (1, -4, 6), 420, 5), ('fill', (-3, -1, 3), 170, 4)]:
        bpy.ops.object.light_add(type='AREA', location=loc)
        lamp = bpy.context.object
        lamp.name, lamp.data.energy, lamp.data.size = name, power * gain, size
        aim(lamp, (0, 0, .6))

    def state(f):
        loc = Vector((3.2 + .1 * f, -6.2, 3.25))
        rot = (Vector((0, 0, .6)) - loc).to_track_quat('-Z', 'Y')
        return {'objects': {cam: {'location': loc, 'rotation_quaternion': rot}}}

    return {'entities': entities, 'state': state}
`;

const blenderBin = process.env.BLENDER_BIN || findBlender() || (process.platform === 'win32' ? 'blender.exe' : null);

test('S14 B：真实 Blender 5.2 Cycles 双档一致，终稿照明 ×2.5 重渲触发亮度门', { timeout: 240000 }, async (t) => {
  if (!blenderBin) return t.skip('本机没有 Blender 5.2');
  const probe = spawnSync(blenderBin, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (probe.error?.code === 'ENOENT' && !process.env.BLENDER_BIN) return t.skip('本机没有 Blender 5.2');
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  if (!/^Blender 5\.2\.\d+\b/m.test(probe.stdout)) return t.skip(probe.stdout.split('\n')[0]);

  const workDir = await mkdtemp(join(tmpdir(), "beiming s14 [AgX]' "));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  await t.test('同尺寸 EXR 转换与出片预览滤镜的 RGB 逐字节相等', async () => {
    const dir = await mkdtemp(join(workDir, 'display-'));
    try {
      const exr = join(dir, 'frame%01d.exr'), lutPath = join(dir, 'agx.cube');
      const width = 4, height = 2;
      const values = [-0.1, 0, 0.001, 0.18, 0.4, 1, 3, 12];
      const channels = Object.fromEntries(['R', 'G', 'B'].map((name, i) => [name, Float32Array.from(values, v => v * (1 + i * 0.5))]));
      await writeFile(exr, writeExr({ width, height, channels, compression: 2 }));
      await bakeAgxLut({ blenderBin, outPath: lutPath });
      const shaper = { minEv: SHAPER.minStops, maxEv: SHAPER.maxStops, mid: SHAPER.midGray };
      const filter = branchFilter({ id: 's14', colorRef: 'scene', count: 1, transfer: 'linear' }, {
        size: [width, height], fps: { num: 24, den: 1 }, view: { lutPath, shaper },
      });
      const args = ['-nostdin', '-v', 'error', '-f', 'image2', '-pattern_type', 'none', '-i', exr,
        '-filter_complex', `[0:v]${filter},format=rgb24[o]`, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-'];
      const { stdout } = runTool(tools().ffmpeg, args);
      const display = exrToDisplayLumaFrame(exr, { lutPath, shaper, width, height });
      assert.deepEqual(display.data, stdout);
      assert.throws(() => exrToDisplayLumaFrame(exr, { lutPath, shaper, width: height, height: width }), /尺寸/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const roles = { hero: 'body', mustSee: ['cap', 'bracket'] };
  const predicates = ['inside_frame', 'visible'].map(id => ({ id, expr: FLOOR.items.find(item => item.uses.includes(id)).expr }));
  const assembly = registeredTemplate('assembly', 1);
  for (const id of ['at_rest', 'no_intersect']) predicates.push({ id, expr: assembly.items.find(item => item.uses.includes(id)).expr });
  predicates.at(-1).query = { kind: 'intersect', of: [roles.hero], against: roles.mustSee };
  predicates.push({ id: 'below_ground', query: { kind: 'belowGround', of: [roles.hero, ...roles.mustSee], tol: 0.0001 } },
    { id: 'highlight_clip_ratio', expr: 'highlight_clip_ratio()' }, { id: 'luma_p99', expr: 'luma_p99()' });

  const run = (gain) => runBlenderTierParity({
    blenderBin, frames: [0, 1, 2], workDir, roles, predicates,
    draftRenderOpts: { scale: 0.5, samples: 4 }, finalRenderOpts: { scale: 1, samples: 16 },
    async shotBuilder({ workDir: dir }) {
      await writeFile(join(dir, 'assembly.py'), ENTRY.replace('EXPOSURE_GAIN', String(gain)));
      return { film: 's14', output: { size: [320, 180], fps: '24/1' }, shot: {
        id: 'assembly', in: 10, out: 13, source: 'blender', host: 'cycles', mode: 'build-script', entry: 'assembly.py', colorRef: 'scene', seed: 17,
      } };
    },
  });

  function record(label, report) {
    const { pass, bbox, luma, predicates, frames } = report;
    t.diagnostic(`${label} ${JSON.stringify({ pass, bbox, luma, predicates,
      frames: frames.map(({ frame, draft, final, bbox, lumaDiffs }) => ({
        frame, bbox, lumaDiffs,
        draft: { size: draft.meta.size, source: draft.meta.source, luma: draft.luma, clip: draft.highlightClipRatio },
        final: { size: final.meta.size, source: final.meta.source, luma: final.luma, clip: final.highlightClipRatio },
      })) })}`);
  }
  const good = await run(1);
  record('正常双档', good);
  assert.equal(good.pass, true);
  assert.deepEqual(good.frames.map(f => f.frame), [10, 11, 12]);
  for (const { draft, final, bbox } of good.frames) {
    assert.deepEqual([draft.meta.size, final.meta.size], [[160, 90], [320, 180]]);
    assert.deepEqual([draft.meta.source.tier, final.meta.source.tier], ['draft', 'final']);
    assert.deepEqual([draft.meta.source.samples, final.meta.source.samples], [4, 16]);
    assert.equal(draft.meta.format, 'meta/0.1');
    assert.equal(final.meta.format, 'meta/0.1');
    assert.equal(bbox.length, 3);
  }
  assert.deepEqual(good.predicates.draft.map(({ pass }) => pass), predicates.map(() => true));
  assert.deepEqual(good.predicates.final.map(({ pass }) => pass), predicates.map(() => true));

  const bad = await run(2.5);
  record('终稿照明 ×2.5', bad);
  assert.equal(bad.pass, false);
  assert.equal(bad.predicates.pass && bad.bbox.pass, true);
  assert.equal(bad.luma.pass, false);
  assert.ok(bad.luma.maxDiffs.p50 > 0.05);
  assert.deepEqual(bad.frames.map(f => f.draft.luma), good.frames.map(f => f.draft.luma));
  assert.notEqual(bad.frames[0].final.meta.hash.color, good.frames[0].final.meta.hash.color);
  assert.deepEqual(await readdir(workDir), []);
});
