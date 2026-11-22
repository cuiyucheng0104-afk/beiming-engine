import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cameraBasis, checkScene, loadScenes, objectTransform, project } from './check.mjs';
import {
  PUBLIC_CALIB_SCENES,
  calibMetaLights,
  listCalibScenes,
  materializeCalibWorkspace,
  resolveCalibScene,
} from './index.mjs';
import { startSource as startThreeSource } from '../host/page/host.mjs';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { findBlender, startSource as startBlenderSource } from '../sources/blender/host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { validate } = await loadContracts();

// meta/0.1 的实体名（beiming/kernel/contracts/meta/schema/meta.schema.json）：点分的字母、数字、下划线，不许连字符
const META_NAME = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
// 标称亮度写死在这里，不从 scene.json 读：规格里把亮球改成 0，规格自己还是自洽的（一审 M09）
const HDR_PEAKS = { 'spark.1000': 1000, 'spark.100': 100, 'bar.50': 50 };
// 考题 28-1 的画幅和取景限制（beiming/kernel/contracts/question-file/examples/full.json）
const Q28_SIZE = [1920, 824];
const TURN_FRAMES = [0, 12, 24, 36, 48];

/** 帧源交回的原始元数据直接过正式契约：结构和各条不变量都是 0 问题 */
function assertMeta(meta, where) {
  const v = validate(meta);
  assert.deepEqual([v.contract, v.schemaErrors, v.violations], ['meta', [], {}], `${where} 的原始元数据没过 meta/0.1 契约`);
}

/** 只有二进制确实不在（没装、路径不存在）才跳过；别的错（起来之后的运行时错在内）照常抛，算失败 */
async function startOrSkip(t, start, what) {
  try {
    return await start();
  } catch (err) {
    if (err?.code !== 'ENOENT' && !/Executable doesn't exist|ENOENT/.test(String(err?.message))) throw err;
    t.skip(`本机没有${what}（二进制不存在），跳过实渲`);
    return null;
  }
}

const world = (o, t, p) => { const { R, T } = objectTransform(o, t); return R.map((r, i) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + T[i]); };
const luma = (c, i) => 0.2126 * c[4 * i] + 0.7152 * c[4 * i + 1] + 0.0722 * c[4 * i + 2];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 物体表面上够密的一圈点（局部坐标）：盒子和平面取角点，圆柱取两个端面的圆周，球取经纬网格 */
function surfacePoints(o) {
  const ring = (n, fn) => Array.from({ length: n }, (_, i) => fn((i / n) * 2 * Math.PI));
  if (o.shape === 'cylinder') return [-1, 1].flatMap((s) => ring(64, (a) => [o.radiusM * Math.cos(a), (s * o.heightM) / 2, o.radiusM * Math.sin(a)]));
  if (o.shape === 'sphere') return ring(24, (b) => ring(48, (a) => [Math.cos(a) * Math.sin(b / 2), Math.cos(b / 2), Math.sin(a) * Math.sin(b / 2)].map((x) => x * o.radiusM))).flat();
  const [x, y, z = 0] = o.sizeM.map((v) => v / 2);
  return [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => [sx * x, sy * y, sz * z])));
}

/** 从规格算：全部物体在第 f 帧并在一起的投影包围盒，四边各留多少白（占画幅的比例） */
function specMargins(scene, f, [W, H]) {
  const camera = { ...scene.camera, widthPx: W, heightPx: H };
  const px = scene.objects.flatMap((o) => surfacePoints(o).map((p) => project(camera, world(o, f, p))));
  const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
  return { left: Math.min(...xs) / W, right: 1 - Math.max(...xs) / W, top: Math.min(...ys) / H, bottom: 1 - Math.max(...ys) / H };
}

/** 从编号层量：全部非背景像素并在一起的包围盒，四边各留多少白 */
function maskMargins(ids, [W, H]) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    const x = i % W, y = (i - x) / W;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { left: x0 / W, right: (W - 1 - x1) / W, top: y0 / H, bottom: (H - 1 - y1) / H };
}

/** 层文件读进来：哈希和字节数对得上层引用 */
async function readLayers(ws, layers, [W, H], where) {
  const read = {};
  for (const [name, layer] of Object.entries(layers)) {
    const bytes = await readFile(join(ws, layer.file));
    assert.equal(layer.hash, `sha256:${createHash('sha256').update(bytes).digest('hex')}`, `${where} ${name} 层哈希`);
    assert.deepEqual([layer.shape[0], layer.shape[1], bytes.length], [H, W, H * W * layer.shape[2] * 4], `${where} ${name} 层尺寸`);
    read[name] = new (name === 'objectId' ? Uint32Array : Float32Array)(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  }
  return read;
}

/** hdr-post：三个高亮体中心 5×5 像素里的线性峰值在标称值的一半到一倍半之间（Cycles 的像素滤镜会让峰值偏离几个百分点） */
function checkHdrPeaks(scene, color, where) {
  const W = scene.camera.widthPx;
  for (const [id, nominal] of Object.entries(HDR_PEAKS)) {
    const [u, v] = project(scene.camera, scene.objects.find((o) => o.id === id).positionM).map(Math.floor);
    let peak = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) peak = Math.max(peak, luma(color, (v + dy) * W + u + dx));
    assert.ok(peak >= 0.5 * nominal && peak <= 1.5 * nominal, `${where} ${id} 的线性峰值 ${peak}，标称 ${nominal}`);
  }
}

/** 球在画面上的圆盘（往里收到 0.8 倍半径，避开抗锯齿的边）里属于这个球的像素：dx、dy 相对球心，l 是线性亮度 */
function ballPixels(scene, id, read, idOf) {
  const { camera } = scene, W = camera.widthPx, o = scene.objects.find((x) => x.id === id), { fwd, f } = cameraBasis(camera);
  const [cx, cy] = project(camera, o.positionM), R = (0.8 * f * o.radiusM) / dot(fwd, o.positionM.map((x, k) => x - camera.positionM[k]));
  const out = [];
  for (let y = Math.ceil(cy - R); y <= cy + R; y++) for (let x = Math.ceil(cx - R); x <= cx + R; x++) {
    const i = y * W + x, dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    if (dx * dx + dy * dy <= R * R && read.objectId[i] === idOf[id]) out.push({ dx, dy, l: luma(read.color, i) });
  }
  return out;
}

/** studio-balls：灰球真的受光（明暗差得开、亮的一半朝着主灯），铬球有远高于球面的高光亮斑 */
function checkStudioShading(scene, read, idOf, where) {
  const { right, up } = cameraBasis(scene.camera);
  const levels = (px) => px.map((p) => p.l).sort((a, b) => a - b), at = (s, q) => s[Math.floor(q * (s.length - 1))];
  const mean = (px) => px.reduce((s, p) => s + p.l, 0) / px.length;

  const gray = ballPixels(scene, 'ball.gray', read, idOf), g = levels(gray);
  assert.ok(gray.length > 1000, `${where} 灰球圆盘只有 ${gray.length} 个像素`);
  // 本机实测第 10、90 百分位：three 0.041、0.194（只有直接光），Cycles 0.086、0.205（地台的反弹光把暗部垫高）；不受光的常数球两个数相等
  assert.ok(at(g, 0.9) >= 1.5 * at(g, 0.1) && at(g, 0.9) - at(g, 0.1) >= 0.05, `${where} 灰球没有明暗梯度：第 10、90 百分位亮度 ${at(g, 0.1)}、${at(g, 0.9)}`);
  // 主灯在球的哪一边（画面上）：朝主灯的半个圆盘比背着的亮
  const toKey = scene.lights.find((l) => l.id === 'key').positionM.map((x, k) => x - scene.objects.find((o) => o.id === 'ball.gray').positionM[k]);
  const side = (p) => p.dx * dot(toKey, right) - p.dy * dot(toKey, up);
  const lit = mean(gray.filter((p) => side(p) > 0)), shade = mean(gray.filter((p) => side(p) < 0));
  assert.ok(lit >= 1.25 * shade, `${where} 灰球朝主灯的一半 ${lit} 不比背光的一半 ${shade} 亮`); // 实测 three 2.2 倍，Cycles 1.6 倍

  const chrome = levels(ballPixels(scene, 'ball.chrome', read, idOf)), peak = chrome.at(-1), body = at(chrome, 0.5);
  assert.ok(peak >= 1 && peak >= 5 * body, `${where} 铬球没有高光亮斑：峰值 ${peak}，球面中位 ${body}`); // 实测峰值 three 39.6、Cycles 49.1，中位 0.04、0.25
}

/**
 * 拿规格的标准答案对帧源读回的东西：按规格画幅、不缩放，把标准答案用到的每一帧渲一遍。
 * 每一帧的原始元数据过 meta/0.1 契约；层文件的哈希和字节数对得上层引用；实体表等于规格的物体表；
 * 编号层在每个 pixelHits 像素上读到标准答案的第一个物体（背景读 0），深度层读到它的平面深度；
 * 元数据包围盒和 projectedBox 的交并比过线；颜色层在 patchColor 像素上读到面片的线性值。
 * hdr-post 另读三个高亮体的线性峰值，studio-balls 另读灰球的明暗和铬球的高光。
 */
async function crossCheck(source, key, ref, outDir) {
  const { scene } = resolveCalibScene(ref);
  const { widthPx: W, heightPx: H } = scene.camera;
  const mat = await materializeCalibWorkspace(ref, outDir, { source: key });
  const ws = join(outDir, 'ws');
  const session = await source.open(mat[`${key}ShotInput`], { lock: null, tier: 'draft', workspace: ws, filmDir: mat.filmDir });
  try {
    const idOf = Object.fromEntries(session.manifest().entities.map((e) => [e.name, e.id]));
    assert.deepEqual(Object.keys(idOf).sort(), scene.objects.map((o) => o.id).sort(), `${ref} ${key} 实体表和规格的物体表不一致`);
    const at = (e) => e.atFrame ?? scene.frameRange.startFrame;
    for (const f of [...new Set(scene.expected.filter((e) => e.kind !== 'projectPoint' && e.kind !== 'projectedWidth').map(at))].sort((a, b) => a - b)) {
      const where = `${ref} ${key} 第 ${f} 帧`;
      const { meta, layers } = await session.render(f, { scale: 1 }, ['color', 'depth', 'objectId']);
      assertMeta(meta, where);
      assert.deepEqual([meta.frame, meta.size, meta.hash.color], [f, [W, H], layers.color.hash], where);
      const read = await readLayers(ws, layers, [W, H], where);
      const pixel = ([u, v]) => Math.floor(v) * W + Math.floor(u);
      for (const e of scene.expected.filter((x) => at(x) === f)) {
        if (e.kind === 'pixelHits') {
          const first = e.hits[0], p = pixel(e.pixelPx);
          assert.equal(read.objectId[p], first ? idOf[first.objectId] : 0, `${where} 像素 ${e.pixelPx} 的编号（${e.source}）`);
          if (first) assert.ok(Math.abs(read.depth[p] - first.planeDepthM) <= e.toleranceRatio * first.planeDepthM, `${where} 像素 ${e.pixelPx} 的深度 ${read.depth[p]}，标准答案 ${first.planeDepthM}`);
        } else if (e.kind === 'projectedBox') {
          const [x0, y0, x1, y1] = meta.entities.find((x) => x.name === e.objectId).bbox2d, [a0, b0] = e.boxMinPx, [a1, b1] = e.boxMaxPx;
          const inter = Math.max(0, Math.min(x1, a1) - Math.max(x0, a0)) * Math.max(0, Math.min(y1, b1) - Math.max(y0, b0));
          const iou = inter / ((x1 - x0) * (y1 - y0) + (a1 - a0) * (b1 - b0) - inter);
          assert.ok(iou >= e.minIouRatio, `${where} ${e.objectId} 的元数据包围盒交并比 ${iou}`);
        } else if (e.kind === 'patchColor') {
          const p = pixel(e.pixelPx) * 4;
          // 非零分量按相对容差比，零分量按绝对 0.005（同帧源一致性报告 color-linearity 的过线）
          e.valueLinear.forEach((want, c) => assert.ok(Math.abs(read.color[p + c] - want) <= (want ? e.toleranceRatio * want : 0.005), `${where} ${e.objectId} 的颜色分量 ${c} 读回 ${read.color[p + c]}，标准答案 ${want}`));
        }
      }
      if (ref === 'calib/hdr-post@1') checkHdrPeaks(scene, read.color, where);
      if (ref === 'calib/studio-balls@1') {
        checkStudioShading(scene, read, idOf, where);
        // 两个宿主现在都把 meta.lights 写成 null（能力声明的 metaNull）；规格的灯表换成 meta/0.1 的写法并进去，照样过契约
        const lights = calibMetaLights(scene);
        assert.deepEqual(lights.map((l) => l.name), ['key', 'fill', 'rim'], `${where} 三点灯`);
        assertMeta({ ...meta, lights }, `${where}（并进灯表）`);
      }
    }
  } finally {
    await session.close();
  }
}

/** mech-head-proxy：28-1 的 1920×824 和默认 16:9 两种画幅下，转一圈的五个时刻整头（编号层全部非背景像素）四边留白都够 */
async function checkHeadFraming(source, key, root) {
  const ref = 'calib/mech-head-proxy@1';
  for (const size of [Q28_SIZE, [640, 360]]) {
    const dir = join(root, `framing-${size.join('x')}`), ws = join(dir, 'ws');
    const mat = await materializeCalibWorkspace(ref, dir, { source: key, size });
    // Blender 的草稿档最大 960×540，1920×824 走终稿档。两个帧源的辅助层都要和颜色层一起要
    const session = await source.open(mat[`${key}ShotInput`], { lock: null, tier: key === 'blender' && size[0] > 960 ? 'final' : 'draft', workspace: ws, filmDir: mat.filmDir });
    try {
      for (const f of TURN_FRAMES) {
        const where = `${ref} ${key} ${size.join('×')} 第 ${f} 帧`;
        const { meta, layers } = await session.render(f, { scale: 1 }, ['color', 'objectId']);
        assertMeta(meta, where);
        assert.deepEqual(meta.size, size, where);
        const m = maskMargins((await readLayers(ws, layers, size, where)).objectId, size);
        for (const [edge, got] of Object.entries(m)) assert.ok(got >= 0.15, `${where} 整头的${edge}留白 ${got} 不到 15%`);
        // 28-1 的另外三条：头宽不超过 60%、高不超过 70%、左右留白不少于 20%
        assert.ok(1 - m.left - m.right <= 0.6 && 1 - m.top - m.bottom <= 0.7 && Math.min(m.left, m.right) >= 0.2, `${where} 不满足 28-1 的宽高和左右留白：${JSON.stringify(m)}`);
      }
    } finally {
      await session.close();
    }
  }
}

/** 一个帧源上的全套实渲：四个场景各在 320×180 上开、列实体、渲一帧，再按规格画幅对标准答案；最后量机械头的取景 */
async function renderAll(source, key) {
  const root = await mkdtemp(join(tmpdir(), `bm-c8-${key}-`));
  try {
    for (const ref of PUBLIC_CALIB_SCENES) {
      const sceneDir = join(root, ref.replace(/[/@]/g, '_'));
      const mat = await materializeCalibWorkspace(ref, sceneDir, { size: [320, 180] });
      const input = mat[`${key}ShotInput`], ws = join(sceneDir, `ws-${key}`);
      const session = await source.open(input, { lock: null, tier: 'draft', workspace: ws, filmDir: mat.filmDir });
      try {
        const mf = await session.manifest();
        assert.ok(Array.isArray(mf.entities) && mf.entities.length >= 3, `${ref} ${key} manifest 实体不足`);
        const out = await session.render(input.shot.in, {}, ['color', 'depth', 'objectId']);
        assertMeta(out.meta, `${ref} ${key} 320×180`);
        assert.ok(out.layers?.color?.file && out.layers?.objectId?.file, `${ref} ${key} 缺少输出层`);
        assert.ok((await readFile(join(ws, out.layers.color.file))).byteLength > 0);
      } finally {
        await session.close();
      }
      await crossCheck(source, key, ref, join(sceneDir, 'native'));
    }
    await checkHeadFraming(source, key, root);
  } finally {
    await source.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test('C8-1 四个公开合成校准场景齐备、零私有素材且全部通过 checkScene 与单位/expected 核验', () => {
  assert.deepEqual(PUBLIC_CALIB_SCENES, [
    'calib/hdr-post@1',
    'calib/studio-balls@1',
    'calib/boxes-explode@1',
    'calib/mech-head-proxy@1',
  ]);
  assert.equal(Object.isFrozen(PUBLIC_CALIB_SCENES), true);

  for (const ref of PUBLIC_CALIB_SCENES) {
    const item = resolveCalibScene(ref);
    assert.equal(Object.isFrozen(item), true);
    assert.equal(Object.isFrozen(item.scene), true);
    assert.equal(item.ref, ref);
    const shortId = ref.slice('calib/'.length);
    assert.equal(item.id, shortId);
    assert.deepEqual(resolveCalibScene(shortId), item);
    assert.deepEqual(checkScene(item.scene, shortId), [], `${ref} 未通过 checkScene`);
    assert.ok(item.scene.objects.length >= 3, `${ref} 至少包含 3 个解析几何体`);
    assert.ok(item.scene.expected.length >= 3, `${ref} 至少包含 3 条可复算标准答案`);
    const raw = readFileSync(item.scenePath, 'utf8');
    assert.equal(/lab:\/\/|原包源码|复刻\/|调研资料\/|\.glb|\.gltf|\.obj|\.exr|\.png/i.test(raw), false, `${ref} 不得引用外部或私有素材`);
  }

  // 原有 7 个 probe-* 场景依然全部通过
  const probes = loadScenes(HERE);
  assert.equal(probes.length, 7);
  for (const p of probes) assert.deepEqual(checkScene(p.scene, p.name), []);
  assert.equal(listCalibScenes().length, 4);
  assert.equal(listCalibScenes({ includeProbes: true }).length, 11);
});

test('C8-2 beiming/calib/README.md 满足 <= 1500 token 预算且非法引用被拒收', () => {
  const readmeBytes = readFileSync(join(HERE, 'README.md')).byteLength;
  const tokens = Math.ceil(readmeBytes / 3.5);
  assert.ok(tokens <= 1500, `README.md token=${tokens} 超过 1500 上限`);

  for (const bad of ['', null, undefined, 123, '../README.md', 'calib/../check.mjs', 'calib/unknown@1', 'hdr-post@1/extra']) {
    assert.throws(() => resolveCalibScene(bad));
  }
});

test('C8-3 three 页面宿主实渲四个公开场景：元数据过契约、标准答案对得上、HDR 峰值、棚拍受光、机械头取景', async (t) => {
  const source = await startOrSkip(t, startThreeSource, '无头浏览器');
  if (source) await renderAll(source, 'three');
});

test('C8-4 Blender 帧源实渲四个公开场景：元数据过契约、标准答案对得上、HDR 峰值、棚拍受光、机械头取景', async (t) => {
  if (!findBlender()) {
    t.skip('本机没有 Blender（二进制不存在），跳过实渲');
    return;
  }
  await renderAll(await startBlenderSource(), 'blender');
});

test('C8-5 引用只认一段合法场景名：穿越、反斜杠、控制字符、大小写变体一律拒收，非字符串抛 TypeError', () => {
  for (const bad of [null, undefined, 123, 1n, true, {}, ['calib/hdr-post@1'], Symbol('x'), () => 'hdr-post@1', new String('hdr-post@1')]) {
    assert.throws(() => resolveCalibScene(bad), TypeError);
  }
  for (const bad of [
    '', 'calib/', '.', '..', '../calib/hdr-post@1', 'calib/../calib/hdr-post@1', 'calib/calib/hdr-post@1', '/hdr-post@1', 'hdr-post@1/', 'hdr-post@1/scene.json',
    'calib\\hdr-post@1', '..\\calib\\hdr-post@1', 'hdr-post@1\0', 'hdr-post@1\n', ' hdr-post@1', 'hdr-post@1 ', 'HDR-POST@1', 'Probe-Gray-Chart',
    'hdr-post', 'hdr-post@0', 'hdr-post@01', 'hdr-post@2', 'hdr-post@1@1', 'hdr--post@1', '-hdr-post@1', 'table', 'calib/table', 'check.mjs', '%2e%2e/check.mjs',
  ]) {
    assert.throws(() => resolveCalibScene(bad), RangeError, JSON.stringify(bad));
  }
  // 默认只认公开清单里的四个：探针场景不显式放行就拒收
  for (const ref of ['probe-gray-chart', 'calib/probe-gray-chart', ...loadScenes(HERE).map((p) => p.name)]) {
    assert.throws(() => resolveCalibScene(ref), RangeError, ref);
    assert.throws(() => resolveCalibScene(ref, { allowProbes: false }), RangeError, ref);
  }
  assert.throws(() => resolveCalibScene('table', { allowProbes: true }), RangeError);
  assert.throws(() => resolveCalibScene('../calib/hdr-post@1', { allowProbes: true }), RangeError);
  // 放行之后探针场景两种写法都认，引用统一成带 calib/ 前缀的
  const probe = resolveCalibScene('probe-gray-chart', { allowProbes: true });
  assert.deepEqual([probe.ref, probe.id, probe.scene.id], ['calib/probe-gray-chart', 'probe-gray-chart', 'probe-gray-chart']);
  assert.deepEqual(resolveCalibScene('calib/probe-gray-chart', { allowProbes: true }), probe);
  assert.equal(probe.scenePath, join(HERE, 'probe-gray-chart', 'scene.json'));
});

test('C8-6 取回的场景深冻结：哪一层都改不动，每次取回的是新对象；清单也冻结，顺序是公开场景在前、探针场景按名字排在后', () => {
  const item = resolveCalibScene('calib/boxes-explode@1');
  for (const write of [
    () => { item.id = 'x'; },
    () => { item.scene.title = 'x'; },
    () => { item.scene.camera.yFovDeg = 90; },
    () => { item.scene.objects.push({}); },
    () => { item.scene.objects[0].positionM[0] = 9; },
    () => { item.scene.objects[0].motion.velocityMPerFrame[2] = 9; },
    () => { item.scene.expected[0].pixelPx[0] = 9; },
    () => { delete item.scene.expected; },
  ]) assert.throws(write, TypeError);
  assert.notEqual(resolveCalibScene('calib/boxes-explode@1'), item);
  assert.throws(() => { PUBLIC_CALIB_SCENES.push('calib/x@1'); }, TypeError);

  const all = listCalibScenes({ includeProbes: true });
  assert.throws(() => { all.pop(); }, TypeError);
  assert.equal(all.every((x) => Object.isFrozen(x) && Object.isFrozen(x.scene.objects[0].emissionLinear)), true);
  assert.deepEqual(all.map((x) => x.ref), [...PUBLIC_CALIB_SCENES, ...loadScenes(HERE).map((p) => `calib/${p.name}`)]);
  assert.deepEqual(listCalibScenes().map((x) => x.ref), PUBLIC_CALIB_SCENES);
  assert.deepEqual(listCalibScenes({ includeProbes: false }), listCalibScenes());
});

test('C8-7 四个公开场景各改一个数，检查器都抓得出来：挪物体、改答案、改相机、丢单位后缀、挪出裁剪面', () => {
  for (const ref of PUBLIC_CALIB_SCENES) {
    const { id, scene } = resolveCalibScene(ref);
    const broken = (edit) => { const s = structuredClone(scene); edit(s); return checkScene(s, id); };
    // 每个场景的第一条 pixelHits 打到的那个物体沿视线方向挪 1 厘米：深度答案对不上
    const firstHit = scene.expected.find((e) => e.kind === 'pixelHits' && e.hits.length).hits[0].objectId;
    assert.ok(broken((s) => { s.objects.find((o) => o.id === firstHit).positionM[2] += 0.01; }).some((p) => /重算/.test(p)), `${ref} 挪物体`);
    // 每一条标准答案的第一个数各加千分之一：逐条被抓
    scene.expected.forEach((e, i) => {
      const bump = (s) => {
        const x = s.expected[i];
        if (x.kind === 'pixelHits' && !x.hits.length) x.intendedHitIds.push(scene.objects[0].id);
        else if (x.kind === 'pixelHits') x.hits[0].planeDepthM *= 1.001;
        else if (x.kind === 'projectedBox') x.boxMinPx[0] *= 1.001;
        else if (x.kind === 'projectedWidth') x.widthPx *= 1.001;
        else if (x.kind === 'patchColor' && x.valueLinear[0]) x.valueLinear[0] *= 1.001;
        else if (x.kind === 'patchColor') x.valueLinear[0] = 0.001;
        else x.pixelPx[0] *= 1.001;
      };
      assert.ok(broken(bump).some((p) => p.startsWith(`expected[${i}]`)), `${ref} expected[${i}]（${e.kind}）改了没被抓`);
    });
    assert.ok(broken((s) => { s.camera.yFovDeg += 0.1; }).length > 0, `${ref} 改视场角`);
    assert.ok(broken((s) => { s.frameRateFps = 24.5; s.frameRate = 24; delete s.frameRateFps; }).some((p) => /frameRate/.test(p)), `${ref} 丢单位后缀`);
    assert.ok(broken((s) => { s.camera.nearM = s.camera.farM - 0.001; }).some((p) => /裁剪面/.test(p)), `${ref} 裁剪面`);
    assert.ok(broken((s) => { s.id = 'probe-x'; }).some((p) => /目录名/.test(p)), `${ref} id 和目录名`);
  }
});

test('C8-8 装载器：片子描述过契约校验并落在 outDir/film.json，镜头入口随场景入库；source、size 写错和探针场景都拒收', async () => {
  const { validate } = await loadContracts();
  const root = await mkdtemp(join(tmpdir(), 'bm-c8-mat-'));
  try {
    for (const ref of PUBLIC_CALIB_SCENES) {
      const { id, dir, scene } = resolveCalibScene(ref);
      const out = join(root, id, 'nested');
      const mat = await materializeCalibWorkspace(ref, out);
      assert.deepEqual(Object.keys(mat), ['film', 'filmDir', 'threeShotInput', 'blenderShotInput']);
      assert.deepEqual(await readdir(out), ['film.json']);
      assert.deepEqual(JSON.parse(await readFile(join(out, 'film.json'), 'utf8')), mat.film);
      const verdict = validate(mat.film);
      assert.deepEqual([verdict.contract, verdict.schemaErrors, verdict.violations], ['film', [], {}], `${ref} 的片子描述没过契约校验`);
      assert.equal(mat.filmDir, dir);
      assert.deepEqual(mat.film.output, { size: [scene.camera.widthPx, scene.camera.heightPx], fps: '24/1', frames: scene.frameRange.endFrame + 1 });
      for (const [input, source, entry] of [[mat.threeShotInput, 'three', 'shot.three.js'], [mat.blenderShotInput, 'blender', 'shot.blender.py']]) {
        assert.deepEqual([input.film, input.output.size, input.shot.in, input.shot.out], [mat.film.id, mat.film.output.size, 0, mat.film.output.frames]);
        assert.deepEqual([input.shot.source, input.shot.entry, Number.isInteger(input.shot.seed)], [source, entry, true]);
        assert.ok(readFileSync(join(mat.filmDir, input.shot.entry)).byteLength > 0);
        // 两个帧源只差出帧的那四样
        assert.deepEqual({ ...input.shot, source: 0, host: 0, mode: 0, entry: 0 }, { ...mat.threeShotInput.shot, source: 0, host: 0, mode: 0, entry: 0 });
      }
      assert.deepEqual(mat.film.shots, [mat.threeShotInput.shot]);
    }
    const only = await materializeCalibWorkspace('hdr-post@1', join(root, 'only'), { source: 'blender', size: [320, 180] });
    assert.deepEqual(Object.keys(only), ['film', 'filmDir', 'blenderShotInput']);
    assert.deepEqual([only.film.shots[0].source, only.film.output.size, validate(only.film).schemaErrors], ['blender', [320, 180], []]);

    const refuse = (args, type) => assert.rejects(() => materializeCalibWorkspace(...args), type, JSON.stringify(args));
    for (const source of ['core', '', 'toString', null, ['three']]) await refuse(['calib/hdr-post@1', join(root, 'bad'), { source }], RangeError);
    for (const size of [[0, 180], [320], [320, 180, 1], [320.5, 180], ['320', '180'], '320x180', null]) await refuse(['calib/hdr-post@1', join(root, 'bad'), { size }], RangeError);
    await refuse(['calib/probe-occlusion', join(root, 'bad')], RangeError);
    await refuse(['../hdr-post@1', join(root, 'bad')], RangeError);
    await refuse([42, join(root, 'bad')], TypeError);
    // 拒收的调用不落任何文件
    assert.equal((await readdir(root)).includes('bad'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('C8-9 公开场景的物体名都是 meta/0.1 认的实体名；HDR 三个高亮体的标称亮度没被改', () => {
  for (const ref of PUBLIC_CALIB_SCENES) {
    const { scene } = resolveCalibScene(ref);
    for (const o of scene.objects) assert.match(o.id, META_NAME, `${ref} 的物体名 ${o.id} 过不了 meta/0.1 的实体名规则`);
  }
  const hdr = resolveCalibScene('calib/hdr-post@1').scene;
  for (const [id, nominal] of Object.entries(HDR_PEAKS)) assert.deepEqual(hdr.objects.find((o) => o.id === id)?.emissionLinear, [nominal, nominal, nominal], id);
});

test('C8-10 studio-balls 有三点灯和受光的灰、铬、白、黑四个球；检查器认得受光材质和灯，写坏了拒收，不写的旧场景照过', () => {
  const { id, scene } = resolveCalibScene('calib/studio-balls@1');
  assert.deepEqual(scene.lights.map((l) => [l.id, l.kind]), [['key', 'point'], ['fill', 'point'], ['rim', 'point']]);
  const [key, fill] = scene.lights;
  assert.ok(key.powerW > fill.powerW && fill.powerW > 0, '主灯比辅灯亮');
  const ball = (name) => scene.objects.find((o) => o.id === `ball.${name}`);
  for (const name of ['gray', 'chrome', 'white', 'black']) {
    assert.deepEqual([ball(name).shape, ball(name).material.kind, ball(name).emissionLinear], ['sphere', 'standard', [0, 0, 0]], `ball.${name} 是受光的球，自己不发光`);
  }
  assert.deepEqual([ball('gray').material.baseColorLinear, ball('gray').material.metallicRatio], [[0.18, 0.18, 0.18], 0]);
  assert.ok(ball('chrome').material.metallicRatio === 1 && ball('chrome').material.roughnessRatio <= 0.3, '铬球是金属、低粗糙度');
  assert.ok(scene.objects.filter((o) => o.id.startsWith('chart.')).length === 6 && scene.objects.some((o) => o.id === 'ruler' && o.heightM === 1), '色卡和 1 米标尺还在');
  // 灯表换成 meta/0.1 的写法：名字、类型、位置、瓦数、颜色
  assert.deepEqual(calibMetaLights(scene)[0], { name: 'key', type: 'point', pos: key.positionM, watts: key.powerW, color: key.colorLinear });
  assert.deepEqual(calibMetaLights(resolveCalibScene('calib/hdr-post@1').scene), []);

  const broken = (edit) => { const s = structuredClone(scene); edit(s); return checkScene(s, id); };
  const gray = (s) => s.objects.find((o) => o.id === 'ball.gray');
  for (const [what, edit] of [
    ['灯的种类', (s) => { s.lights[0].kind = 'spot'; }],
    ['灯缺瓦数', (s) => { delete s.lights[0].powerW; }],
    ['灯的瓦数是负的', (s) => { s.lights[0].powerW = -1; }],
    ['灯的瓦数丢了单位后缀', (s) => { s.lights[0].power = 500; delete s.lights[0].powerW; }],
    ['灯重名', (s) => { s.lights[1].id = s.lights[0].id; }],
    ['灯和物体重名', (s) => { s.lights[1].id = 'floor'; }],
    ['灯的位置', (s) => { s.lights[0].positionM = [0, 1]; }],
    ['lights 不是数组', (s) => { s.lights = {}; }],
    ['材质种类', (s) => { gray(s).material.kind = 'toon'; }],
    ['粗糙度出范围', (s) => { gray(s).material.roughnessRatio = 1.5; }],
    ['金属度出范围', (s) => { gray(s).material.metallicRatio = -0.1; }],
    ['材质缺底色', (s) => { delete gray(s).material.baseColorLinear; }],
    ['材质多了不认识的字段', (s) => { gray(s).material.ior = 1.5; }],
  ]) assert.ok(broken(edit).length > 0, `${what}写坏了没被抓`);
  // 受光物体读回多少要看灯和渲染器，规格不给答案：对它写 patchColor 拒收
  assert.ok(broken((s) => { s.expected.push({ kind: 'patchColor', objectId: 'ball.gray', toleranceRatio: 0.02, source: 'x', pixelPx: [0, 0], valueLinear: [0, 0, 0] }); }).some((p) => /受光/.test(p)));
  // 向后兼容：去掉灯和材质，剩下的自发光规格照过
  assert.deepEqual(broken((s) => { delete s.lights; for (const o of s.objects) delete o.material; }), []);
});

test('C8-11 mech-head-proxy 的机位：28-1 的 1920×824 和默认 16:9 下，转一整圈每一帧整头四边留白都不少于 15%，上留白落在 18% 到 24%', () => {
  const { scene } = resolveCalibScene('calib/mech-head-proxy@1');
  assert.deepEqual([scene.frameRange.endFrame, [scene.camera.widthPx, scene.camera.heightPx]], [48, [640, 360]]);
  for (const size of [Q28_SIZE, [640, 360]]) {
    for (let f = 0; f <= 48; f++) {
      const m = specMargins(scene, f, size), where = `${size.join('×')} 第 ${f} 帧`;
      for (const [edge, got] of Object.entries(m)) assert.ok(got >= 0.15, `${where} 整头的${edge}留白 ${got} 不到 15%`);
      assert.ok(m.top >= 0.18 && m.top <= 0.24, `${where} 上留白 ${m.top} 不在 18% 到 24%`);
      assert.ok(1 - m.left - m.right <= 0.6 && 1 - m.top - m.bottom <= 0.7 && Math.min(m.left, m.right) >= 0.2, `${where} 不满足 28-1 的宽高和左右留白`);
    }
  }
});

test('C8-12 装载器不覆盖已有的 film.json：再调一次、两个调用抢同一个目录、目录里本来就有别人的 film.json，原文件逐字节不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bm-c8-keep-'));
  const exists = (err) => err.code === 'EEXIST' && /film\.json/.test(err.message);
  try {
    // 再调一次：换一个场景也好、同一个场景也好，都拒收
    const again = join(root, 'again');
    await materializeCalibWorkspace('calib/hdr-post@1', again);
    const first = await readFile(join(again, 'film.json'));
    await assert.rejects(() => materializeCalibWorkspace('calib/studio-balls@1', again), exists);
    await assert.rejects(() => materializeCalibWorkspace('calib/hdr-post@1', again), exists);
    assert.deepEqual(await readFile(join(again, 'film.json')), first);
    assert.equal(JSON.parse(first).id, 'calib-hdr-post-v1');

    // 四个调用抢同一个目录：恰好一个成，落盘的是它那一份，别的都报已存在
    const race = join(root, 'race');
    const settled = await Promise.allSettled(PUBLIC_CALIB_SCENES.map((ref) => materializeCalibWorkspace(ref, race)));
    const won = settled.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1);
    assert.equal(settled.filter((r) => r.status === 'rejected').every((r) => exists(r.reason)), true);
    assert.deepEqual(JSON.parse(await readFile(join(race, 'film.json'), 'utf8')), won[0].value.film);
    assert.deepEqual(await readdir(race), ['film.json']);

    // 目录里本来就有一份别人的 film.json：一个字节都不动
    const foreign = join(root, 'foreign');
    await materializeCalibWorkspace('calib/hdr-post@1', join(foreign, 'x'));
    await writeFile(join(foreign, 'film.json'), '{ "mine": true }\n');
    await assert.rejects(() => materializeCalibWorkspace('calib/boxes-explode@1', foreign), exists);
    assert.equal(await readFile(join(foreign, 'film.json'), 'utf8'), '{ "mine": true }\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('C8-13 直接运行 check.mjs 查全部 11 个场景；公开场景的答案被改，命令非零退出', async () => {
  const run = (dir) => spawnSync(process.execPath, [join(dir, 'check.mjs')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const ok = run(HERE);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout.trim().split('\n').at(-1), '11 个场景，0 个有问题');
  for (const ref of PUBLIC_CALIB_SCENES) assert.match(ok.stdout, new RegExp(`^${ref.slice('calib/'.length)}：通过`, 'm'));

  const root = await mkdtemp(join(tmpdir(), 'bm-c8-cli-'));
  try {
    for (const ref of PUBLIC_CALIB_SCENES) {
      const copy = join(root, ref.replace(/[/@]/g, '_')), id = ref.slice('calib/'.length);
      await cp(HERE, copy, { recursive: true, filter: (src) => !/[\\/](__pycache__|table)$/.test(src) });
      const path = join(copy, id, 'scene.json'), scene = JSON.parse(await readFile(path, 'utf8'));
      // 第一条带像素坐标的答案挪 4 像素（一审 M01 的同类变异）
      scene.expected.find((e) => 'pixelPx' in e && e.kind !== 'pixelHits').pixelPx[0] += 4;
      await writeFile(path, JSON.stringify(scene));
      const bad = run(copy);
      assert.equal(bad.status, 1, `${ref} 的答案改了，命令还是退出 ${bad.status}`);
      assert.match(bad.stdout, new RegExp(`^${id}：有问题`, 'm'));
      assert.equal(bad.stdout.trim().split('\n').at(-1), '11 个场景，1 个有问题');
    }
    // 少了一个场景也不算过
    const short = join(root, 'short');
    await cp(HERE, short, { recursive: true, filter: (src) => !/[\\/](__pycache__|table|hdr-post@1)$/.test(src) });
    assert.equal(run(short).status, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('C8-14 帧源起不来：二进制不存在才跳过，别的错（起来之后的运行时错）照常失败', async () => {
  const skipped = [], t = { skip: (why) => skipped.push(why) };
  const fails = (make) => async () => { throw make(); };
  assert.equal(await startOrSkip(t, async () => 'source', 'x'), 'source');
  assert.equal(await startOrSkip(t, fails(() => Object.assign(new Error('spawn blender ENOENT'), { code: 'ENOENT' })), 'Blender'), null);
  assert.equal(await startOrSkip(t, fails(() => new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell")), '无头浏览器'), null);
  assert.equal(skipped.length, 2);
  await assert.rejects(() => startOrSkip(t, fails(() => new Error('页面运行时没装起来：超时')), '无头浏览器'), /没装起来/);
  await assert.rejects(() => startOrSkip(t, fails(() => new TypeError('boom')), 'Blender'), TypeError);
  assert.equal(skipped.length, 2);
});
