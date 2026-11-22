import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkScene, loadScenes } from './check.mjs';
import {
  PUBLIC_CALIB_SCENES,
  listCalibScenes,
  materializeCalibWorkspace,
  resolveCalibScene,
} from './index.mjs';
import { startSource as startThreeSource } from '../host/page/host.mjs';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { findBlender, startSource as startBlenderSource } from '../sources/blender/host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 拿规格的标准答案对帧源读回的东西：按规格画幅、不缩放，把标准答案用到的每一帧渲一遍。
 * 层文件的哈希和字节数对得上层引用；实体表等于规格的物体表；编号层在每个 pixelHits 像素上读到标准答案的第一个物体（背景读 0），
 * 深度层读到它的平面深度；元数据包围盒和 projectedBox 的交并比过线；颜色层在 patchColor 像素上读到面片的线性值。
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
      assert.deepEqual([meta.frame, meta.size, meta.hash.color], [f, [W, H], layers.color.hash], where);
      const read = {};
      for (const [name, layer] of Object.entries(layers)) {
        const bytes = await readFile(join(ws, layer.file));
        assert.equal(layer.hash, `sha256:${createHash('sha256').update(bytes).digest('hex')}`, `${where} ${name} 层哈希`);
        assert.deepEqual([layer.shape[0], layer.shape[1], bytes.length], [H, W, H * W * layer.shape[2] * 4], `${where} ${name} 层尺寸`);
        read[name] = new (name === 'objectId' ? Uint32Array : Float32Array)(bytes.buffer, bytes.byteOffset, bytes.length / 4);
      }
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
    }
  } finally {
    await session.close();
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

test('C8-3 three 页面宿主能加载并渲染全部四个公开校准场景', async (t) => {
  let source;
  try {
    source = await startThreeSource();
  } catch (err) {
    t.skip(`无浏览器环境跳过：${String(err.message).split('\n')[0]}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'bm-c8-three-'));
  try {
    for (const ref of PUBLIC_CALIB_SCENES) {
      const sceneDir = join(root, ref.replace(/[/@]/g, '_'));
      const mat = await materializeCalibWorkspace(ref, sceneDir, { size: [320, 180] });
      const ws = join(sceneDir, 'ws-three');
      const session = await source.open(mat.threeShotInput, { lock: mat.lock ?? null, tier: 'draft', workspace: ws, filmDir: mat.filmDir });
      try {
        const mf = await session.manifest();
        assert.ok(Array.isArray(mf.entities) && mf.entities.length >= 3, `${ref} three manifest 实体不足`);
        const frame = mat.threeShotInput.shot.in;
        const out = await session.render(frame, {}, ['color', 'depth', 'objectId']);
        assert.ok(out.layers?.color?.file && out.layers?.objectId?.file, `${ref} three 缺少输出层`);
        const colorBytes = await readFile(join(ws, out.layers.color.file));
        assert.ok(colorBytes.byteLength > 0);
      } finally {
        await session.close();
      }
      await crossCheck(source, 'three', ref, join(sceneDir, 'native'));
    }
  } finally {
    await source.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('C8-4 Blender 帧源能加载并渲染全部四个公开校准场景', async (t) => {
  if (!findBlender()) {
    t.skip('本机未安装 Blender，跳过实渲');
    return;
  }
  let source;
  try {
    source = await startBlenderSource();
  } catch (err) {
    t.skip(`Blender 启动不可用：${String(err.message).split('\n')[0]}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'bm-c8-blender-'));
  try {
    for (const ref of PUBLIC_CALIB_SCENES) {
      const sceneDir = join(root, ref.replace(/[/@]/g, '_'));
      const mat = await materializeCalibWorkspace(ref, sceneDir, { size: [320, 180] });
      const ws = join(sceneDir, 'ws-blender');
      const session = await source.open(mat.blenderShotInput, { lock: mat.lock ?? null, tier: 'draft', workspace: ws, filmDir: mat.filmDir });
      try {
        const mf = await session.manifest();
        assert.ok(Array.isArray(mf.entities) && mf.entities.length >= 3, `${ref} blender manifest 实体不足`);
        const frame = mat.blenderShotInput.shot.in;
        const out = await session.render(frame, {}, ['color', 'depth', 'objectId']);
        assert.ok(out.layers?.color?.file && out.layers?.objectId?.file, `${ref} blender 缺少输出层`);
        const colorBytes = await readFile(join(ws, out.layers.color.file));
        assert.ok(colorBytes.byteLength > 0);
      } finally {
        await session.close();
      }
      await crossCheck(source, 'blender', ref, join(sceneDir, 'native'));
    }
  } finally {
    await source.stop();
    await rm(root, { recursive: true, force: true });
  }
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
  // 探针场景两种写法都认，引用统一成带 calib/ 前缀的
  const probe = resolveCalibScene('probe-gray-chart');
  assert.deepEqual([probe.ref, probe.id, probe.scene.id], ['calib/probe-gray-chart', 'probe-gray-chart', 'probe-gray-chart']);
  assert.deepEqual(resolveCalibScene('calib/probe-gray-chart'), probe);
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
