import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PerspectiveCamera, Vector3 } from 'three-webgpu';
import { findBlender, startSource as startBlender } from '../sources/blender/host.mjs';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { eventsTable } from '../kernel/eval/index.mjs';
import { writeExr } from '../verify/exr/exr.mjs';
import * as comp from './index.mjs';

const { CompError, PIECES, SHAPER, bakeAgxLut, escapeFilterValue, framePath, probeMedia, renderRaw, runTool, srgbEncode, stitchGraph, tools, verifyDeliveryBundle } = comp;
const { composeMixedFilm, renderAnchoredOverlayFrames, measureOverlayAnchorCenter } = comp;
const FPS = '24/1';
const SIZE = [256, 144];
const CUT = 3;
const FRAMES = 5;
const VIEW_SHAPER = { minEv: SHAPER.minStops, maxEv: SHAPER.maxStops, mid: SHAPER.midGray };
const HERE = dirname(fileURLToPath(import.meta.url));
const ANNOTATOR = join(HERE, 'x7-overlay.shot.js');
const PARAMS = Object.freeze({
  callouts: Object.freeze([Object.freeze({ id: 'board', entity: 'board', anchor: 'chip', text: 'CORE', dx: 40, dy: -26 })]),
  dotRadiusPx: 7, strokePx: 1, safeMarginPx: 8, fontPx: 12, ink: '#FFFFFF',
});
const json = (url) => JSON.parse(readFileSync(new URL(url, import.meta.url), 'utf8'));
const LOCK = json('../kernel/contracts/lock/examples/minimal.json');
const FULL_LOCK = json('../kernel/contracts/lock/examples/check-full.json').lock;
const META = json('../kernel/contracts/meta/examples/minimal.json');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bad = (e) => e instanceof CompError && e.code === 'usage.bad-argument';
const distance = ([x, y], [u, v]) => Math.hypot(x - u, y - v);
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${label}: ${actual}, expected ${expected} ± ${tolerance}`);

function workDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'beiming-x7-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function ffmpeg(args, input) {
  return runTool(tools().ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { input }).stdout;
}

function encodePng(pattern, size, rgba, count, start = 0) {
  ffmpeg(['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', size.join('x'), '-framerate', FPS, '-i', '-',
    '-frames:v', String(count), '-threads:v', '1', '-c:v', 'png', '-start_number', String(start), pattern], rgba);
}

function decode(file, pixelFormat) {
  return ffmpeg(['-i', file, '-threads:v', '1', '-f', 'rawvideo', '-pix_fmt', pixelFormat, '-']);
}

function writeGrayExr(path, [width, height], gray) {
  writeFileSync(path, writeExr({ width, height, channels: { R: gray, G: gray, B: gray } }));
}

// Blender 5.2.0 LTS 实烘 agx-mhc 3³ 格点。0.18 附近的中性灰用中心格点核对，离线无需 Blender/OCIO。
function offlineView(root) {
  const lutPath = join(root, 'agx-mhc.cube');
  const white = '1.000000 1.000000 1.000000';
  const samples = [
    '0.000000 0.000000 0.000000', '0.398739 0.000025 0.000217', white,
    '0.013547 0.424911 0.022214', '0.466594 0.441767 0.000000', white,
    white, white, white,
    '0.000062 0.115145 0.410134', '0.433596 0.024186 0.458284', white,
    '0.001155 0.458042 0.464079', '0.466080 0.466078 0.466115', white,
    ...Array(12).fill(white),
  ];
  writeFileSync(lutPath, `TITLE "agx-mhc"\nLUT_3D_SIZE 3\n${samples.join('\n')}\n`);
  return { lutPath, shaper: VIEW_SHAPER };
}

function filmOptions(view, second) {
  const film = json('../kernel/contracts/film/examples/minimal.json');
  film.output = { size: SIZE, fps: FPS, frames: FRAMES };
  film.shots = [
    { id: 's01', in: 0, out: CUT, source: 'blender', host: 'cycles', mode: 'build-script', entry: 'board.py', colorRef: 'scene', seed: 7802 },
    { id: 's02', in: CUT, out: FRAMES, source: 'three', host: 'page', mode: 'native-code', entry: second.entry, colorRef: 'display', seed: 7803 },
  ];
  film.transitions = [{ id: 'cut-3', at: CUT, type: 'cut' }];
  film.delivery = { master: 'h264-crf14-bt709', web: true, contact: true };
  const lock = structuredClone(LOCK);
  lock.sources.blender.version = '5.2.0';
  lock.sources.three = FULL_LOCK.sources.three;
  lock.seeds.s01 = 7802;
  lock.seeds.s02 = 7803;
  lock.shots.s02 = { shutterSamples: 1 };
  lock.view['agx-mhc'] = `sha256:${sha(readFileSync(view.lutPath))}`;
  return { film, events: eventsTable(film), lock, view };
}

function assertFrameMeta(contracts, meta) {
  const { schemaErrors, violations } = contracts.validate(meta);
  assert.deepEqual([schemaErrors, violations], [[], {}]);
}

function verifyBundle(bundle) {
  const names = Object.values(PIECES).sort();
  assert.deepEqual(readdirSync(bundle.dir).sort(), names);
  assert.deepEqual(verifyDeliveryBundle(bundle.dir, { reportSha256: bundle.files[PIECES.report].sha256 }).files, bundle.files);
  for (const name of names) {
    const bytes = readFileSync(join(bundle.dir, name));
    assert.deepEqual(bundle.files[name], { bytes: bytes.length, sha256: sha(bytes) }, name);
  }
  for (const name of [PIECES.master, PIECES.web]) {
    const { video } = probeMedia(join(bundle.dir, name));
    assert.deepEqual([video.frames, video.rate, video.pixFmt, video.colorRange, video.colorSpace, video.colorPrimaries, video.colorTransfer],
      [FRAMES, FPS, 'yuv420p', 'tv', 'bt709', 'bt709', 'bt709']);
    near(video.duration, FRAMES / 24, 1e-6, name);
  }
}

function assertAnchoredPixels(t, label, bundle, meta, overlay) {
  verifyBundle(bundle);
  const [w, h] = SIZE;
  const master = decode(join(bundle.dir, PIECES.master), 'rgb24');
  assert.equal(master.length, w * h * 3 * FRAMES);
  const cutPixels = [];
  for (let f = 0; f < FRAMES; f++) {
    const start = f * w * h * 3;
    const rgb = master.subarray(start, start + w * h * 3);
    const corner = [...rgb.subarray(0, 3)];
    cutPixels.push(corner);
    if (f >= CUT) {
      assert.ok(corner[2] > 170 && corner[0] < 60 && corner[1] < 100, `第二镜头第 ${f} 帧 RGB=${corner}`);
      continue;
    }
    assert.ok(Math.max(...corner) < 155, `第一镜头第 ${f} 帧 RGB=${corner}`);
    const [x, y] = meta[f].entities.find((e) => e.name === 'board').anchors.chip.screen;
    const roi = [Math.floor(x) - 10, Math.floor(y) - 10, Math.ceil(x) + 10, Math.ceil(y) + 10];
    const rgba = decode(framePath(overlay.pattern, f + (overlay.start ?? 0)), 'rgba');
    assert.equal(rgba.length, w * h * 4);
    assert.deepEqual([...rgba.subarray(0, 4)], [0, 0, 0, 0]);
    const png = measureOverlayAnchorCenter(rgba, { size: SIZE, channels: 4, roi });
    const encoded = measureOverlayAnchorCenter(rgb, { size: SIZE, roi });
    const errors = [png, encoded].map((center) => distance(center, [x, y]));
    assert.ok(errors.every((v) => v <= 2), `${label} 第 ${f} 帧：meta ${[x, y]}，PNG ${png}，master ${encoded}`);
    // 引线跨过圆点半径，标签框左侧比锚点右移 40 px；测透明层上两处有墨迹。
    const alpha = (u, v) => rgba[(Math.floor(v) * w + Math.floor(u)) * 4 + 3];
    const elbowX = 40 - 14;
    assert.ok(alpha(x + elbowX / 2, y - 13) > 0, '引线缺失');
    assert.ok(alpha(x + 40.5, y - 23) > 0, '标签框缺失');
    t.diagnostic(`${label} f${f}: ${JSON.stringify({ meta: [x, y], png, master: encoded, errorPx: errors })}`);
  }
  t.diagnostic(`${label} cut frame ${CUT}, RGB ${JSON.stringify(cutPixels)}, BT.709, SHA-256 ${JSON.stringify(bundle.files)}`);
}

function checkDisplacement(t, a, b) {
  const point = (meta) => meta.entities.find((e) => e.name === 'board').anchors.chip;
  const shifts = a.map((m, f) => {
    assert.deepEqual(point(m).world, point(b[f]).world);
    return distance(point(m).screen, point(b[f]).screen);
  });
  assert.ok(shifts.every((v) => v >= 40), `两组相机锚点位移 ${shifts}`);
  for (const seq of [a, b]) assert.ok(distance(point(seq[0]).screen, point(seq.at(-1)).screen) > 4);
  t.diagnostic(`Camera A → B displacement px: ${shifts.join(', ')}`);
}

test('X7 stitch：overlay 校验、旧图逐字一致、AgX/sRGB 后直通 alpha 与硬切像素', (t) => {
  const root = workDir(t);
  const view = offlineView(root);
  const size = [64, 64], [w, h] = size;
  const shots = [
    { id: 'a', in: 0, out: 2, colorRef: 'scene', pattern: 'a.%04d.exr' },
    { id: 'b', in: 2, out: 4, colorRef: 'display', pattern: 'b.%04d.exr', start: 3 },
  ];
  const spec = { shots, size, fps: FPS, view, finish: { grain: 0.02, vignette: 0.1 }, checkFiles: false };
  // 此摘要取自改造前的图，固定 LUT 路径后可比较每一个字节。
  const lutPath = join(HERE, 'stitch.mjs');
  const legacy = stitchGraph({ ...spec, view: { ...view, lutPath } });
  const input = (start, pattern) => ['-f', 'image2', '-framerate', FPS, '-start_number', String(start), '-i', pattern];
  assert.deepEqual(legacy.inputs, [input(0, shots[0].pattern), input(3, shots[1].pattern)]);
  const baselineFilter = legacy.filter.replace(escapeFilterValue(lutPath), 'beiming/comp/stitch.mjs');
  assert.equal(sha(baselineFilter), '4091c04bb8b9569812c0c44f8a5c949455af9a4976215ef1ea58d70245be7af3');
  const pattern = join(root, 'mark.%04d.png');
  const graphWith = (overlay, rest = {}) => stitchGraph({ ...spec, ...rest, shots: [{ ...shots[0], overlay }, shots[1]] });
  for (const overlay of [null, [], 'layer', {}, { pattern: 'layer.png' }, { pattern: 'layer.%d.png' },
    { pattern: 'layer.%00d.png' }, { pattern: 'layer.%04d.%04d.png' }, { pattern: 'layer.%04d.exr', kind: 'png' },
    { pattern, kind: 'exr' }, { pattern, kind: null }, { pattern, start: -1 }, { pattern, start: 0.5 },
    { pattern, start: null }, ...[0, -0.1, 1.01, Infinity, NaN, '0.5', null].map((opacity) => ({ pattern, opacity }))]) {
    assert.throws(() => graphWith(overlay), bad, String(overlay?.pattern ?? overlay));
  }
  shots.forEach((s) => { s.pattern = join(root, s.pattern); });
  const mid = SHAPER.midGray * 2 ** ((SHAPER.minStops + SHAPER.maxStops) / 2);
  for (const [shot, value] of [[shots[0], mid], [shots[1], 0.03]]) {
    for (let f = 0; f < 2; f++) writeGrayExr(framePath(shot.pattern, (shot.start ?? 0) + f), size, new Float32Array(w * h).fill(value));
  }
  const rgba = Buffer.alloc(32 * 32 * 4 * 3, 255);
  for (let f = 0; f < 3; f++) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    rgba[((f * 32 + y) * 32 + x) * 4 + 3] = y < 16 ? 0 : x < 16 ? 255 : f % 2 ? 64 : 128;
  }
  const overlay = { pattern, start: 7, kind: 'png', opacity: 0.5 };
  encodePng(pattern, [32, 32], rgba, 3, overlay.start);
  assert.throws(() => graphWith({ ...overlay, start: 9 }, { checkFiles: true }), (e) => bad(e) && /0010\.png/.test(e.message));
  mkdirSync(framePath(pattern, 10));
  assert.throws(() => graphWith({ ...overlay, start: 9 }, { checkFiles: true }), bad);
  const graph = stitchGraph({ ...spec, shots: shots.map((s) => ({ ...s, overlay })), checkFiles: true,
    finish: {}, transitions: [{ id: 'cut', type: 'cut', at: 2 }] });
  assert.deepEqual(graph.inputs, [input(0, shots[0].pattern), input(3, shots[1].pattern), input(7, pattern), input(7, pattern)]);
  const finish = graphWith(overlay).filter;
  assert.match(finish, /lut3d[^;]+\[base0\];[^;]+format=rgba,setsar=1,colorchannelmixer=aa=0\.5[^;]+;[^;]+overlay=0:0:format=auto:shortest=1,setsar=1,vignette=[^;]+format=yuv420p,noise=/);
  const raw = renderRaw(graph);
  const stride = w * h * 1.5;
  assert.equal(raw.length, stride * 4);
  const readings = [];
  for (let f = 0; f < 4; f++) {
    const base = f < 2 ? 0.46608 : srgbEncode(0.03);
    const points = [[4, 4, 0], [8, 48, 255], [48, 48, f % 2 ? 64 : 128]];
    readings.push(points.map(([x, y, alpha]) => {
      const a = alpha / 255 / 2;
      const at = f * stride + y * w + x;
      near(raw[at], Math.round(16 + 219 * (base * (1 - a) + a)), 1, `Y f${f} (${x},${y})`);
      const c = f * stride + w * h + (y >> 1) * (w >> 1) + (x >> 1);
      assert.deepEqual([raw[c], raw[c + w * h / 4]], [128, 128]);
      return raw[at];
    }));
  }
  t.diagnostic(`raw Y [clear, opacity-only, PNG alpha × opacity]: ${JSON.stringify(readings)}`);
});

function projectShot(root, cameraX) {
  const pattern = join(root, 'board.%04d.exr');
  const [w, h] = SIZE;
  const camera = new PerspectiveCamera(40, w / h, 0.1, 100);
  const world = [0, 0, 0.3];
  const project = (point) => {
    const p = new Vector3(...point).project(camera);
    return [(1 + p.x) * w / 2, (1 - p.y) * h / 2];
  };
  const meta = Array.from({ length: CUT }, (_, f) => {
    camera.position.set(cameraX + 0.12 * f, 0.18, 6);
    camera.updateMatrixWorld();
    const screen = project(world);
    const bbox2d = [...project([-0.8, 0.42, world[2]]), ...project([0.8, -0.42, world[2]])];
    const [x0, y0, x1, y1] = bbox2d;
    const gray = Float32Array.from({ length: w * h }, (_, i) => {
      const x = i % w + 0.5, y = Math.floor(i / w) + 0.5;
      return x >= x0 && x < x1 && y >= y0 && y < y1 ? 0.13 : 0.025;
    });
    const file = framePath(pattern, f);
    writeGrayExr(file, SIZE, gray);
    return { ...META, film: LOCK.film, shot: 's01', frame: f, shotFrame: f, size: SIZE, fps: FPS, seed: 7802,
      camera: { ...META.camera, world: camera.matrixWorld.toArray(), proj: camera.projectionMatrix.toArray(), fovYDeg: camera.fov },
      entities: [{ id: 1, name: 'board', class: 'part', role: 'hero', bbox2d, visible: 1,
        pxArea: (x1 - x0) * (y1 - y0) / (w * h), anchors: { chip: { world, screen } } }],
      stats: { luma: { p1: 0.025, p50: 0.025, p99: 0.13 }, noise: null, tris: 2 },
      hash: { color: `sha256:${sha(readFileSync(file))}` } };
  });
  return { pattern, meta };
}

test('X7 离线：同一标注配置跟随两组运动机位并分别交付硬切六件套', async (t) => {
  assert.equal(typeof composeMixedFilm, 'function');
  const root = workDir(t);
  const view = offlineView(root);
  const display = join(root, 'display.%04d.png');
  const rgba = Buffer.alloc(SIZE[0] * SIZE[1] * 4 * (FRAMES - CUT));
  rgba.fill(Buffer.from([32, 72, 208, 255]));
  encodePng(display, SIZE, rgba, FRAMES - CUT);
  const opts = filmOptions(view, { entry: 'display.shot.js' });
  const contracts = await loadContracts();
  const fingerprint = () => sha(Buffer.concat([readFileSync(ANNOTATOR), Buffer.from(JSON.stringify(PARAMS))]));
  const original = fingerprint();
  const takes = [];
  for (const [label, cameraX] of [['A', 0.85], ['B', -0.85]]) {
    const dir = join(root, label);
    mkdirSync(dir);
    const { pattern, meta } = projectShot(dir, cameraX);
    for (const frame of meta) assertFrameMeta(contracts, frame);
    const overlay = await renderAnchoredOverlayFrames({ meta, params: PARAMS, outDir: join(dir, 'overlay') });
    const bundle = await composeMixedFilm({ ...opts, outDir: join(dir, 'delivery'),
      frames: { s01: { pattern }, s02: { pattern: display } }, overlayShot: 's01', overlay });
    assert.equal(fingerprint(), original);
    assertAnchoredPixels(t, `offline ${label}`, bundle, meta, overlay);
    takes.push(meta);
  }
  checkDisplacement(t, ...takes);
  t.diagnostic(`annotator + callouts SHA-256: ${original}`);
});

// Blender 只改变相机横向起点，固定硬表面件、发光材质与世界锚点。相机轨道在各自镜头内持续移动。
const BOARD = `
import bpy
import math


def build(ctx):
    scene = bpy.context.scene
    scene.world = bpy.data.worlds.new('dark studio')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes.get('Background').inputs[0].default_value = (0.025, 0.025, 0.025, 1)
    bpy.ops.object.camera_add()
    cam = bpy.context.object
    scene.camera = cam
    cam.data.sensor_fit = 'VERTICAL'
    cam.data.sensor_height = 24
    cam.data.lens = 12 / math.tan(math.radians(20))
    cam.rotation_euler = (math.pi / 2, 0, 0)
    for f in range(ctx.frames):
        cam.location = ctx.to_blender((ctx.tokens['cameraX'] + 0.12 * f, 0.18, 6))
        cam.keyframe_insert(data_path='location', frame=f)

    def part(name, pos, scale, strength):
        bpy.ops.mesh.primitive_cube_add(size=1, location=ctx.to_blender(pos))
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bevel = obj.modifiers.new('machined edges', 'BEVEL')
        bevel.width, bevel.segments = 0.035, 3
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        emission = nodes.new('ShaderNodeEmission')
        emission.inputs['Color'].default_value = (0.25, 0.45, 0.52, 1)
        emission.inputs['Strength'].default_value = strength
        mat.node_tree.links.new(emission.outputs[0], nodes.get('Material Output').inputs['Surface'])
        obj.data.materials.append(mat)
        return obj

    board = part('board', (0, 0, 0), (1.65, 0.36, 0.90), 0.22)
    chip = part('chip', (0, 0, 0.22), (0.65, 0.16, 0.45), 0.32)
    return {'entities': [{'name': 'board', 'class': 'part', 'role': 'hero', 'objects': [board, chip]}],
            'meta': lambda f: {'anchors': {'board#chip': [0, 0, 0.30]}}}
`;

test('X7 实渲：Blender 5.2 + three 页面宿主，同一透明镜头跟随两套机位再硬切 three', { timeout: 300_000 }, async (t) => {
  const bin = process.env.BLENDER_BIN || findBlender();
  const version = bin && spawnSync(bin, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 }).stdout;
  if (!/^Blender 5\.2\.\d+\b/.test(version ?? '')) return t.skip('需要 Blender 5.2');
  assert.equal(typeof renderAnchoredOverlayFrames, 'function');
  const { startSource: startPage } = await import('../host/page/host.mjs');
  let page;
  try { page = await startPage(); }
  catch (e) {
    if (!/Executable doesn't exist|Failed to launch|Host system is missing dependencies/.test(e.message)) throw e;
    return t.skip(`Chromium 不可用：${e.message.split('\n')[0]}`);
  }
  t.after(() => page.stop());
  const root = workDir(t);
  const lutPath = join(root, 'agx-mhc.cube');
  await bakeAgxLut({ blenderBin: bin, outPath: lutPath });
  const view = { lutPath, shaper: VIEW_SHAPER };
  const displayDir = fileURLToPath(new URL('../sources/three/', import.meta.url));
  const second = { entry: 's3-probe.shot.js', params: { elements: [
    { kind: 'canvas2d', name: 'card', rect: [0, 0, ...SIZE], fill: ['#2048D0', '#2048D0'] },
  ] } };
  const opts = filmOptions(view, second);
  const workspace = join(root, 'page');
  const session2 = await page.open({ film: opts.film.id, output: opts.film.output, shot: { ...opts.film.shots[1], ...second } },
    { lock: null, tier: 'final', workspace, filmDir: displayDir });
  const display = join(root, 'three.%04d.png');
  try {
    const rgba = Buffer.alloc(SIZE[0] * SIZE[1] * 4 * (FRAMES - CUT));
    for (let f = 0; f < FRAMES - CUT; f++) {
      const { layers } = await session2.render(f, {}, ['color']);
      const bytes = readFileSync(join(workspace, layers.color.file));
      for (let i = 0; i < bytes.length / 4; i++) {
        const value = bytes.readFloatLE(i * 4);
        rgba[f * SIZE[0] * SIZE[1] * 4 + i] = Math.round((i % 4 === 3 ? value : srgbEncode(value)) * 255);
      }
    }
    encodePng(display, SIZE, rgba, FRAMES - CUT);
  } finally { await session2.close(); }

  const blender = await startBlender({ blenderBin: bin, device: 'cpu', limitMs: 90000 });
  t.after(() => blender.stop());
  writeFileSync(join(root, 'board.py'), BOARD);
  const contracts = await loadContracts();
  const fingerprint = () => sha(Buffer.concat([readFileSync(ANNOTATOR), Buffer.from(JSON.stringify(PARAMS))]));
  const original = fingerprint();
  const takes = [];
  for (const [label, cameraX] of [['A', 0.85], ['B', -0.85]]) {
    const dir = join(root, label);
    mkdirSync(dir);
    const pattern = join(dir, 'board.%04d.exr');
    const session = await blender.open({ film: opts.film.id, output: opts.film.output, shot: opts.film.shots[0], tokens: { cameraX } },
      { lock: null, tier: 'final', workspace: dir, filmDir: root });
    const meta = [];
    try {
      for (let f = 0; f < CUT; f++) {
        const rendered = await session.render(f, { samples: 4 }, ['color', 'meta']);
        assertFrameMeta(contracts, rendered.meta);
        // Blender 宿主从多层 EXR 读出线性 f32。按原样装入独立 RGB EXR，保持同帧尺寸和线性光。
        const bytes = readFileSync(join(dir, rendered.layers.color.file));
        const [width, height] = rendered.meta.size;
        const channels = Object.fromEntries(['R', 'G', 'B'].map((name, c) => [name,
          Float32Array.from({ length: width * height }, (_, i) => bytes.readFloatLE((i * 4 + c) * 4)),
        ]));
        writeFileSync(framePath(pattern, f), writeExr({ width, height, channels }));
        meta.push(rendered.meta);
      }
    } finally { await session.close(); }
    const overlay = await renderAnchoredOverlayFrames({ meta, params: PARAMS, pageSource: page, outDir: join(dir, 'overlay') });
    const bundle = await composeMixedFilm({ ...opts, outDir: join(dir, 'delivery'),
      frames: { s01: { pattern }, s02: { pattern: display } }, overlayShot: 's01', overlay });
    assert.equal(fingerprint(), original);
    assertAnchoredPixels(t, `Blender ${label}`, bundle, meta, overlay);
    takes.push(meta);
  }
  checkDisplacement(t, ...takes);
  t.diagnostic(`${version.split('\n')[0]}, ${blender.device.backend}; annotator + callouts SHA-256: ${original}`);
});
