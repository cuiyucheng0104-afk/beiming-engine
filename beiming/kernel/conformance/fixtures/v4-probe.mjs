// V4 补录：Mac 实测法线空间、乱序求值；Blender 另从 probe-occlusion 实渲三个单独方块的编号层，与帧源元数据对照。
//   node beiming/kernel/conformance/fixtures/v4-probe.mjs record <three|blender>   # 实渲、写 fixtures/v4-<帧源>.mac.json（只在 Mac 上跑）
//   node beiming/kernel/conformance/fixtures/v4-probe.mjs check [文件...]          # 不重渲，只核已记的文件
// 两个帧源都走自己的帧源接口（startSource → open → render）：three 是页面宿主 beiming/host/page/host.mjs，镜头 v4-turntable.shot.js；
// blender 是 Blender 帧源 beiming/sources/blender/host.mjs（device: 'cpu'，同机颜色逐位可复现），镜头 v4-blender.py（build-script）。
// 几何标准：校准场景 probe-axes-turntable，期望一律照 calib/check.mjs 的 raycast 求交算。法线只比三个端头球的内部像素
// （像素中心周围 ±0.75 像素九点都打到同一个球，避开边缘），期望 = 归一(交点 − 球心) 折成相机空间（x 右、y 上、z 朝向相机）。
// 法线空间按两个帧源能力声明写死为相机空间，帧源交回的值原样当相机空间比；另两种空间的夹角只记作诊断，不参与判定。
// 帧序：一个帧源进程按 FRAMES 升序渲，另起一个进程、新会话按命名随机流打乱的次序渲（同 run.mjs 的 shuffled），按帧号比颜色层哈希。
// 临时产物放系统临时目录；编号层保存所有非零行程，离线可以逐字节还原并核对帧源摘要。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventsTable, shotInput } from '../../eval/input.mjs';
import { CUBES, FRAMES, H, SEED, SHOT, W, deg, probeObservations, shuffledFrames, spherePixels, toCamera } from '../probe-observations.mjs';
import { readLayer } from '../compare.mjs';

// 兼容原先从录制脚本导入的调用方；离线核验的实现不反向依赖这里。
export { probeObservations };
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const ENTRY = {
  three: { source: 'three', host: 'page', mode: 'native-code', entry: 'v4-turntable.shot.js', tiers: { final: { samples: 1, scale: 1 } } },
  blender: { source: 'blender', host: 'cycles', mode: 'build-script', entry: 'v4-blender.py', tiers: { final: { samples: 64, scale: 1 } } },
};

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return (s[Math.floor(s.length / 2)] + s[Math.floor((s.length - 1) / 2)]) / 2; };

/** 帧源交回的法线原样当相机空间（能力声明写死）；diagnostic 是拿它当另两种空间时的夹角中位数，只作诊断 */
function normalSamples(normal, t) {
  const px = spherePixels(t), raw = (p) => [0, 1, 2].map((k) => normal[(p.y * W + p.x) * 3 + k]);
  const samples = px.map((p) => ({ frame: t, object: p.object, pixel: [p.x, p.y], expected: toCamera(p.world).map(r5), got: raw(p).map(r5) }));
  const diagnostic = {
    'world-yup': r5(median(px.map((p) => deg(raw(p), p.world)))),
    'world-blender-zup': r5(median(px.map((p) => deg(raw(p), [p.world[0], -p.world[2], p.world[1]])))),
  };
  return { samples, diagnostic };
}

function probeInput(source, solo) {
  const film = JSON.parse(readFileSync(join(HERE, 'film.json'), 'utf8'));
  Object.assign(film, { id: solo ? 'probe-occlusion' : 'v4-turntable', events: [] });
  if (solo) film.style = { tokens: { probeSoloCube: solo } };
  film.output.frames = solo ? 1 : 49;
  film.shots = [{ id: SHOT, in: 0, out: film.output.frames, colorRef: 'scene', seed: SEED, shutter: { angleDeg: solo ? 0 : 180 }, ...ENTRY[source] }];
  return shotInput(film, SHOT, eventsTable(film));
}

function verifiedBytes(layer, workspace) {
  const bytes = readFileSync(join(workspace, layer.file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(`sha256:${digest}`, layer.hash, `${layer.file} 的文件字节哈希和帧源交回的不符`);
  return { bytes, digest };
}

/** 同一帧源进程里另开三个会话，各自只渲一个方块；每次都从帧源实际返回的层和 meta 取证。 */
async function renderCubes(src, env) {
  const objects = [];
  for (const name of CUBES) {
    const session = await src.open(probeInput('blender', name), env);
    try {
      // 按帧源契约，want 不含 color 时只交元数据，不会写任何像素层。
      const { layers, meta } = await session.render(0, {}, ['color', 'objectId']);
      assert.equal(meta.film, 'probe-occlusion');
      assert.equal(meta.frame, 0);
      assert.deepEqual(meta.size, [W, H]);
      assert.equal(meta.source.version, src.caps().version);
      assert.equal(meta.source.backend, src.device.backend);
      const { id, bbox2d: metaBBox } = meta.entities.find((e) => e.name === name);
      const layer = layers.objectId, { bytes, digest } = verifiedBytes(layer, env.workspace);
      assert.deepEqual(layer.shape, [H, W, 1]);
      assert.deepEqual(layer.components, ['id']);
      assert.equal(bytes.length, W * H * 4);
      const runs = [];
      let last;
      for (let i = 0; i < W * H; i++) {
        const got = bytes.readUInt32LE(i * 4);
        if (!got) continue;
        assert.equal(got, id, `${name} 的单渲编号层混入了其他实体`);
        if (last && last[0] + last[1] === i) last[1]++;
        else { last = [i, 1]; runs.push(last); }
      }
      objects.push({ name, id, metaBBox, pixelSha256: digest, runs });
    } finally { await session.close(); }
  }
  return { scene: 'probe-occlusion', frame: 0, size: [W, H], objects };
}

/** 每次从新的帧源进程开转台会话。方块在乱序转台渲完后补录，不干扰两遍的初始状态。 */
async function renderOrder(source, order, tmp, cubes = false) {
  const { startSource } = source === 'three' ? await import('../../../host/page/host.mjs') : await import('../../../sources/blender/host.mjs');
  const src = await startSource(source === 'blender' ? { device: 'cpu' } : {});
  try {
    const env = { lock: null, tier: 'final', workspace: tmp, filmDir: HERE };
    const session = await src.open(probeInput(source), env);
    const frames = [];
    for (const f of order) {
      const { layers } = await session.render(f, {}, ['color', 'normal']);
      frames.push({ frame: f, digest: verifiedBytes(layers.color, tmp).digest, normalDigest: verifiedBytes(layers.normal, tmp).digest, normalFile: join(tmp, layers.normal.file) });
    }
    await session.close();
    return { frames, version: src.caps().version, device: src.device ?? null, ...(cubes && { objectIdEvidence: await renderCubes(src, env) }) };
  } finally {
    await src.stop();
  }
}

async function record(source) {
  // 只记 Mac：别的机器上的实测要在那台机器上用它自己的记录方式补，不许拿这里的数顶
  if (process.platform !== 'darwin') throw new Error('v4-probe.mjs 只记 Mac 一列；别的机器不在这里补');
  if (!ENTRY[source]) throw new Error(`不认识帧源 ${source}`);
  const shuffled = shuffledFrames();
  const tmps = [mkdtempSync(join(tmpdir(), 'v4-seq-')), mkdtempSync(join(tmpdir(), 'v4-shuf-'))];
  try {
    const seq = await renderOrder(source, FRAMES, tmps[0]);
    const shuf = await renderOrder(source, shuffled, tmps[1], source === 'blender');
    assert.equal(seq.version, shuf.version);
    assert.deepEqual(seq.device, shuf.device);
    const perFrame = seq.frames.map((x) => normalSamples(readLayer(x.normalFile, 'f32'), x.frame));
    const strip = ({ frame, digest, normalDigest }) => ({ frame, digest, normalDigest });
    const out = {
      format: 'v4-probe/0.1',
      source,
      machine: 'mac',
      recordedAt: new Date().toISOString(),
      provenance: {
        how: source === 'three'
          ? 'three 帧源经页面宿主帧源接口实渲（beiming/host/page/host.mjs startSource/open/render），镜头 fixtures/v4-turntable.shot.js'
          : 'Blender 帧源经帧源接口实渲（beiming/sources/blender/host.mjs startSource({ device: cpu })/open/render，build-script 模式），镜头 fixtures/v4-blender.py；法线层由帧源从 Cycles 世界空间转相机空间',
        rerun: `node beiming/kernel/conformance/fixtures/v4-probe.mjs record ${source}`,
        commit: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        platform: `${process.platform} ${release()} ${process.arch}`,
        node: process.version,
        sourceVersion: seq.version,
        device: seq.device,
        tier: 'final',
        samples: ENTRY[source].tiers.final.samples,
      },
      geometry: {
        scene: 'beiming/calib/probe-axes-turntable/scene.json',
        expected: 'calib/check.mjs raycast 求交；端头球内部像素（中心周围 ±0.75 像素九点同球）；法线 = 归一(交点 − 球心)',
        normalSpace: 'camera（x 右、y 上、z 朝向相机），按帧源能力声明固定，不按读数挑',
        size: [W, H],
      },
      frameOrder: { sequential: FRAMES, shuffled, stream: `streamName(${SEED}, '${SHOT}', 'conformance/shuffle')`, process: '两遍各起一个帧源进程、各开一个会话', digest: '颜色层文件字节的 SHA-256（帧源交回的层哈希）；normalDigest 同法算法线层' },
      normals: perFrame.flatMap((p) => p.samples),
      sequential: seq.frames.map(strip),
      shuffled: shuf.frames.map(strip),
      ...(shuf.objectIdEvidence && { objectIdEvidence: shuf.objectIdEvidence }),
    };
    out.observed = { ...summarize(out), normalDiagnosticMedianDegPerFrame: perFrame.map((p, i) => ({ frame: FRAMES[i], ...p.diagnostic })) };
    // 同卷临时文件核过再原子替换；独占创建失败时不碰已有文件。
    const file = join(HERE, `v4-${source}.mac.json`), staged = `${file}.tmp-${process.pid}`;
    const fd = openSync(staged, 'wx');
    try {
      try { writeFileSync(fd, `${JSON.stringify(out)}\n`); } finally { closeSync(fd); }
      console.log(JSON.stringify(out.observed, null, 1));
      check(staged);
      renameSync(staged, file);
      console.log(file);
    } finally { rmSync(staged, { force: true }); }
  } finally {
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
  }
}

/** 观测摘要：只写看到的数，过不过线由套件判 */
function summarize(rec, verified = probeObservations(rec)) {
  const angles = rec.normals.map((n) => deg(n.got, n.expected));
  const bySeq = new Map(rec.sequential.map((x) => [x.frame, x]));
  return {
    ...(rec.source === 'blender' && { objectIdMetaIous: verified.objectIdMetaIous }),
    normalSamples: angles.length,
    normalMedianDeg: r5(median(angles)),
    normalMaxDeg: r5(Math.max(...angles)),
    normalMedianDegPerFrame: rec.frameOrder.sequential.map((f) => ({ frame: f, medianDeg: r5(median(rec.normals.filter((n) => n.frame === f).map((n) => deg(n.got, n.expected)))) })),
    reorderedPositions: rec.frameOrder.shuffled.filter((f, i) => f !== rec.frameOrder.sequential[i]).length,
    shuffledColorDigestMismatch: rec.shuffled.filter((x) => bySeq.get(x.frame)?.digest !== x.digest).length,
    shuffledNormalDigestMismatch: rec.shuffled.filter((x) => bySeq.get(x.frame)?.normalDigest !== x.normalDigest).length,
    distinctColorDigestsAcrossFrames: new Set(rec.sequential.map((x) => x.digest)).size,
  };
}

/** 核已记的文件：结构、期望法线照规格重算对上、摘要和逐帧记录对上。不重渲 */
function check(file) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(rec.format, 'v4-probe/0.1');
  assert.ok(['three', 'blender'].includes(rec.source));
  assert.equal(rec.machine, 'mac', '这个脚本只记 Mac 一列');
  const column = JSON.parse(readFileSync(join(REPO, `beiming/calib/table/${rec.source}.json`), 'utf8'));
  const verified = probeObservations(rec, column);
  if (rec.source === 'blender') {
    for (const name of CUBES) assert.ok(Number.isFinite(verified.objectIdMetaIous?.[name]), `${name} 缺少可信单渲编号层或元数据框`);
    console.log(`单渲编号层/元数据框 IoU：${JSON.stringify(verified.objectIdMetaIous)}`);
  }
  assert.ok(verified.normals, '法线像素集合或方向与校准规格不符');
  assert.ok(verified.shuffled, '转台帧序、颜色变化或层摘要不完整');
  assert.deepEqual(rec.sequential.map((x) => x.frame), rec.frameOrder.sequential);
  assert.deepEqual(rec.shuffled.map((x) => x.frame), rec.frameOrder.shuffled);
  const again = summarize(rec, verified);
  for (const [k, v] of Object.entries(again)) assert.deepEqual(v, rec.observed[k], `摘要 ${k} 和记录对不上`);
  console.log(`ok ${file}: ${rec.source}/${rec.machine} 法线 ${again.normalSamples} 个样本 中位 ${again.normalMedianDeg}° 最大 ${again.normalMaxDeg}°；乱序挪动 ${again.reorderedPositions} 帧，颜色哈希不同 ${again.shuffledColorDigestMismatch} 帧`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'record') await record(rest[0]);
  else if (cmd === 'check') for (const f of rest.length ? rest : ['three', 'blender'].map((s) => join(HERE, `v4-${s}.mac.json`))) check(f);
  else { console.error('用法：v4-probe.mjs record <three|blender> | check [文件...]'); process.exitCode = 2; }
}
