// V4 补录：给帧源一致性套件 Mac 一列的「法线空间」「乱序求值」两行补实测（探针表 P7/P8 没量这两样）。
//   node beiming/kernel/conformance/fixtures/v4-probe.mjs record <three|blender>   # 实渲、写 fixtures/v4-<帧源>.mac.json（只在 Mac 上跑）
//   node beiming/kernel/conformance/fixtures/v4-probe.mjs check [文件...]          # 不重渲，只核已记的文件
// 两个帧源都走自己的帧源接口（startSource → open → render）：three 是页面宿主 beiming/host/page/host.mjs，镜头 v4-turntable.shot.js；
// blender 是 Blender 帧源 beiming/sources/blender/host.mjs（device: 'cpu'，同机颜色逐位可复现），镜头 v4-blender.py（build-script）。
// 几何标准：校准场景 probe-axes-turntable，期望一律照 calib/check.mjs 的 raycast 求交算。法线只比三个端头球的内部像素
// （像素中心周围 ±0.75 像素九点都打到同一个球，避开边缘），期望 = 归一(交点 − 球心) 折成相机空间（x 右、y 上、z 朝向相机）。
// 法线空间按两个帧源能力声明写死为相机空间，帧源交回的值原样当相机空间比；另两种空间的夹角只记作诊断，不参与判定。
// 帧序：一个帧源进程按 FRAMES 升序渲，另起一个进程、新会话按命名随机流打乱的次序渲（同 run.mjs 的 shuffled），按帧号比颜色层哈希。
// 临时产物只放系统临时目录，用完删掉；记录文件只有法线样本和摘要。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cameraBasis, objectTransform, raycast } from '../../../calib/check.mjs';
import { eventsTable, shotInput } from '../../eval/input.mjs';
import { stream, streamName } from '../../eval/rng.mjs';
import { readLayer } from '../compare.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const SCENE = JSON.parse(readFileSync(join(REPO, 'beiming/calib/probe-axes-turntable/scene.json'), 'utf8'));
const FRAMES = [0, 12, 24, 36, 48];
const SEED = 20261122, SHOT = 's01';
const INTERIOR = [-0.75, 0, 0.75].flatMap((dx) => [-0.75, 0, 0.75].map((dy) => [dx, dy]));
const { widthPx: W, heightPx: H } = SCENE.camera;
const BASIS = cameraBasis(SCENE.camera);
const ENTRY = {
  three: { source: 'three', host: 'page', mode: 'native-code', entry: 'v4-turntable.shot.js', tiers: { final: { samples: 1, scale: 1 } } },
  blender: { source: 'blender', host: 'cycles', mode: 'build-script', entry: 'v4-blender.py', tiers: { final: { samples: 64, scale: 1 } } },
};

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const n = Math.hypot(...a); return n > 0 ? a.map((v) => v / n) : [0, 0, 0]; };
const deg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180) / Math.PI;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return (s[Math.floor(s.length / 2)] + s[Math.floor((s.length - 1) / 2)]) / 2; };
const toCamera = (n) => [dot(n, BASIS.right), dot(n, BASIS.up), -dot(n, BASIS.fwd)];

/** 像素 (x, y) 中心处、时刻 t 的期望：打到的端头球和它在规格世界轴里的法线；不是端头球内部的像素交回 null */
function sphereNormalAt(x, y, t) {
  const first = (px) => raycast(SCENE, px, t)[0] ?? null;
  const hit = first([x + 0.5, y + 0.5]);
  const o = SCENE.objects.find((s) => s.id === hit?.objectId);
  if (o?.shape !== 'sphere' || !INTERIOR.every(([dx, dy]) => first([x + 0.5 + dx, y + 0.5 + dy])?.objectId === o.id)) return null;
  const { fwd, right, up, f } = BASIS;
  const d = [0, 1, 2].map((i) => right[i] * (x + 0.5 - W / 2) / f - up[i] * (y + 0.5 - H / 2) / f + fwd[i]);
  const p = SCENE.camera.positionM.map((v, i) => v + hit.planeDepthM * d[i]);
  const center = objectTransform(o, t).T;
  return { object: o.id, world: unit(p.map((v, i) => v - center[i])) };
}

/** 端头球的投影很小：只扫各球投影周围的方框 */
function spherePixels(t) {
  const out = [], { right, up, fwd, f } = BASIS;
  for (const o of SCENE.objects.filter((s) => s.shape === 'sphere')) {
    const d = objectTransform(o, t).T.map((v, i) => v - SCENE.camera.positionM[i]), z = dot(d, fwd);
    const cx = W / 2 + f * dot(d, right) / z, cy = H / 2 - f * dot(d, up) / z, rad = Math.ceil(f * o.radiusM / z) + 2;
    for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(H - 1, Math.ceil(cy + rad)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(W - 1, Math.ceil(cx + rad)); x++) {
        const hit = sphereNormalAt(x, y, t);
        if (hit) out.push({ x, y, ...hit });
      }
    }
  }
  return out;
}

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

/** 同 run.mjs 的 shuffled：用命名随机流打乱；打乱后和原来一样就再来 */
function shuffledFrames() {
  const s = stream(streamName(SEED, SHOT, 'conformance/shuffle')), out = [...FRAMES];
  do {
    for (let i = out.length - 1; i > 0; i--) { const j = s.u32() % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  } while (out.every((v, i) => v === FRAMES[i]));
  return out;
}

/** 一个帧源进程、一个会话，按 order 渲；交回逐帧颜色层哈希、法线层哈希和法线层文件 */
async function renderOrder(source, order, tmp) {
  const film = JSON.parse(readFileSync(join(HERE, 'film.json'), 'utf8'));
  Object.assign(film, { id: 'v4-turntable', events: [] });
  film.output.frames = 49;
  film.shots = [{ id: SHOT, in: 0, out: 49, colorRef: 'scene', seed: SEED, shutter: { angleDeg: 180 }, ...ENTRY[source] }];
  const input = shotInput(film, SHOT, eventsTable(film));
  const { startSource } = source === 'three' ? await import('../../../host/page/host.mjs') : await import('../../../sources/blender/host.mjs');
  const src = await startSource(source === 'blender' ? { device: 'cpu' } : {});
  try {
    const session = await src.open(input, { lock: null, tier: 'final', workspace: tmp, filmDir: HERE });
    const frames = [];
    for (const f of order) {
      const { layers } = await session.render(f, {}, ['color', 'normal']);
      // 摘要自己按层文件字节算，再和帧源交回的哈希对照：不单信帧源的说法
      const hex = (l) => {
        const own = createHash('sha256').update(readFileSync(join(tmp, l.file))).digest('hex');
        assert.equal(`sha256:${own}`, l.hash, `第 ${f} 帧 ${l.file} 的文件字节哈希和帧源交回的不符`);
        return own;
      };
      frames.push({ frame: f, digest: hex(layers.color), normalDigest: hex(layers.normal), normalFile: join(tmp, layers.normal.file) });
    }
    await session.close();
    return { frames, version: src.caps().version, device: src.device ?? null };
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
    const shuf = await renderOrder(source, shuffled, tmps[1]);
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
    };
    out.observed = { ...summarize(out), normalDiagnosticMedianDegPerFrame: perFrame.map((p, i) => ({ frame: FRAMES[i], ...p.diagnostic })) };
    // 先写同目录的临时文件、核过再原子替换：核不过时现有记录原样留着
    const file = join(HERE, `v4-${source}.mac.json`), staged = `${file}.tmp-${process.pid}`;
    writeFileSync(staged, `${JSON.stringify(out)}\n`);
    console.log(JSON.stringify(out.observed, null, 1));
    check(staged);
    renameSync(staged, file);
    console.log(file);
  } finally {
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
    rmSync(join(HERE, `v4-${source}.mac.json.tmp-${process.pid}`), { force: true });
  }
}

/** 观测摘要：只写看到的数，过不过线由套件判 */
function summarize(rec) {
  const angles = rec.normals.map((n) => deg(n.got, n.expected));
  const bySeq = new Map(rec.sequential.map((x) => [x.frame, x]));
  return {
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

// 规格固定，离线加载多张表只需求交一次。每次核对都使用独立的像素清单。
let expectedNormals;
function validNormalSamples(samples) {
  expectedNormals ??= new Map(FRAMES.flatMap((f) => spherePixels(f).map((p) =>
    [`${f}/${p.object}@${p.x},${p.y}`, toCamera(p.world)])));
  if (!Array.isArray(samples) || samples.length !== expectedNormals.size) return false;
  const unseen = new Map(expectedNormals);
  const unitVector = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) && Math.abs(Math.hypot(...v) - 1) < 1e-3;
  for (const n of samples) {
    if (!n || !Number.isSafeInteger(n.frame) || !Array.isArray(n.pixel) || n.pixel.length !== 2 || !n.pixel.every(Number.isSafeInteger)) return false;
    const key = `${n.frame}/${n.object}@${n.pixel}`, expected = unseen.get(key);
    if (!expected || !unitVector(n.expected) || !unitVector(n.got) || deg(expected, n.expected) >= 1e-3) return false;
    unseen.delete(key);
  }
  return unseen.size === 0;
}

function validTurntableOrder(rec) {
  const matches = (run, frames) => Array.isArray(run) && run.length === frames.length && frames.every((f, i) => run[i]?.frame === f);
  if (!matches(rec.sequential, FRAMES) || !matches(rec.shuffled, shuffledFrames())) return false;
  // 这组转台帧的颜色必须随时间变化，才能检出总是返回第一帧的帧源。
  if (rec.source === 'blender' && rec.machine === 'linux-5090') {
    const first = rec.sequential[0].rgb8;
    return Array.isArray(first) && rec.sequential.some(({ rgb8 }) => Array.isArray(rgb8) && rgb8.length === first.length && rgb8.some((v, i) => v !== first[i]));
  }
  const hex = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  return [...rec.sequential, ...rec.shuffled].every((r) => hex(r.digest) && hex(r.normalDigest)) && new Set(rec.sequential.map((r) => r.digest)).size > 1;
}

/** 文件补测与通用读数的区别是已知场景、帧序和设备。失败的那一项留空，由套件判为缺测。 */
export function probeObservations(rec, column) {
  const p = rec.provenance;
  if (!p || typeof p.sourceVersion !== 'string' || !p.sourceVersion || (column && p.sourceVersion !== column.version?.split(' ')[0])) return {};
  const backend = rec.machine === 'mac' ? 'CPU' : 'OPTIX';
  if (rec.source === 'blender' && p.device?.backend?.toUpperCase?.() !== backend) return {};
  return { normals: validNormalSamples(rec.normals) ? rec.normals : null, sequential: rec.sequential,
    shuffled: validTurntableOrder(rec) ? rec.shuffled : null };
}

/** 核已记的文件：结构、期望法线照规格重算对上、摘要和逐帧记录对上。不重渲 */
function check(file) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(rec.format, 'v4-probe/0.1');
  assert.ok(['three', 'blender'].includes(rec.source));
  assert.equal(rec.machine, 'mac', '这个脚本只记 Mac 一列');
  const verified = probeObservations(rec);
  assert.ok(verified.normals, '法线像素集合或方向与校准规格不符');
  assert.ok(verified.shuffled, '转台帧序、颜色变化或层摘要不完整');
  assert.deepEqual(rec.sequential.map((x) => x.frame), rec.frameOrder.sequential);
  assert.deepEqual(rec.shuffled.map((x) => x.frame), rec.frameOrder.shuffled);
  const again = summarize(rec);
  for (const [k, v] of Object.entries(again)) assert.deepEqual(v, rec.observed[k], `摘要 ${k} 和记录对不上`);
  console.log(`ok ${file}: ${rec.source}/${rec.machine} 法线 ${again.normalSamples} 个样本 中位 ${again.normalMedianDeg}° 最大 ${again.normalMaxDeg}°；乱序挪动 ${again.reorderedPositions} 帧，颜色哈希不同 ${again.shuffledColorDigestMismatch} 帧`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'record') await record(rest[0]);
  else if (cmd === 'check') for (const f of rest.length ? rest : ['three', 'blender'].map((s) => join(HERE, `v4-${s}.mac.json`))) check(f);
  else { console.error('用法：v4-probe.mjs record <three|blender> | check [文件...]'); process.exitCode = 2; }
}
