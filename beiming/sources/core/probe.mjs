// 核心帧源的一致性探针：把校准场景（beiming/calib/ 下的 probe-*，calib-scene/0.1）用 chassis/scenepack.mjs 写成场景包，
// 经帧源接口（source.mjs 的 startSource → open → render）出层，照校准规格自己算期望，七项读数交给一致性套件的
// evaluateSourceConformance 判。口径与 three、blender 两个帧源的探针相同（beiming/kernel/conformance/fixtures/v4-probe.mjs、
// probe-observations.mjs 与 beiming/calib/table/ 里那几行）：
//   颜色线性度  probe-gray-chart：灰阶与色卡中心像素、背景像素的线性值对规格里的发光值。场景包的材质还没有发光闭包（场景包契约
//              第 6 节「材质参数登记」待定），色块写成对相机可见的矩形面光，辐亮度照内核读包的换算（功率 ÷ (π·宽·高) × 灯色）取成发光值
//   深度        probe-plane-steps：规格里八个像素的平面深度对深度层，取相对误差的中位
//   编号与元数据 probe-occlusion：三个方块各自单独渲（场景包里另两个方块这一帧的矩阵为 0），编号层反算的包围盒对元数据的 bbox2d 求交并比
//   法线        probe-axes-turntable：三个端头球内部像素（probe-observations.mjs 的 spherePixels）的法线层对规格法线的相机空间
//   相机约定    probe-axes-turntable：端头球与转台标记块单独渲，编号层覆盖质心对规格投影（calib/check.mjs 的 project）的距离，取最大
//   乱序、重复  probe-axes-turntable 第 0、12、24、36、48 帧：一个会话顺序渲、再原样渲一遍，另起一个帧源按命名随机流打乱的次序渲，
//              按帧号比颜色层与法线层文件的 SHA-256
// 内核没有运动模糊，转台镜头的快门角写 0；几何体切成三角形（球 96 × 48 段、圆柱 96 段），形体的法线是解析的。
//   node beiming/sources/core/probe.mjs [--out 报告.json] [--machine 名字]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { cameraBasis, objectTransform, project } from '../../calib/check.mjs';
import { boxOfIds, centroid, iou } from '../../kernel/conformance/compare.mjs';
import { CUBES, FRAMES, SEED, shuffledFrames, spherePixels, toCamera } from '../../kernel/conformance/probe-observations.mjs';
import { evaluateSourceConformance } from '../../kernel/conformance/suite.mjs';
import { rotX, writePack } from './chassis/scenepack.mjs';
import { startSource } from './source.mjs';

const CALIB = fileURLToPath(new URL('../../calib/', import.meta.url));
const scene = (id) => JSON.parse(fs.readFileSync(path.join(CALIB, id, 'scene.json'), 'utf8'));
/** 实体名只收字母、数字、下划线和点（S 契约 5.2）：校准规格里的连字符换成下划线 */
export const entityName = (id) => id.replaceAll('-', '_');
const SAMPLES = 16;
// 这一帧不画的行：左上 3×3 全 0（场景包契约 5.4），第 16 个数仍是 1
const ZERO = [...Array(15).fill(0), 1];

// ------------------------------------------------------------------------------------------------ 形体切成三角形

const quad = (p, n, out) => {
  const k = out.positions.length / 3;
  out.positions.push(...p.flat());
  out.normals.push(...Array(4).fill(n).flat());
  out.indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
};

/** 校准规格的一个形体在它的局部坐标里切成三角形（尺寸照规格；plane 在局部 z = 0、法线 +z；cylinder 的轴沿局部 y） */
export function meshOf(o) {
  const m = { name: entityName(o.id), positions: [], normals: [], indices: [] };
  if (o.shape === 'plane') {
    const [x, y] = o.sizeM.map((v) => v / 2);
    quad([[-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0]], [0, 0, 1], m);
  } else if (o.shape === 'box') {
    const h = o.sizeM.map((v) => v / 2);
    for (let a = 0; a < 3; a++) {
      const [b, c] = [(a + 1) % 3, (a + 2) % 3];
      for (const s of [-1, 1]) {
        const corner = (u, v) => { const p = [0, 0, 0]; p[a] = s * h[a]; p[b] = u * h[b]; p[c] = v * h[c]; return p; };
        const n = [0, 0, 0]; n[a] = s;
        // 逆时针朝外
        quad(s > 0 ? [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] : [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)], n, m);
      }
    }
  } else if (o.shape === 'sphere') {
    const [nu, nv] = [96, 48];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const [th, ph] = [(j / nv) * Math.PI, (i / nu) * 2 * Math.PI];
        const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), -Math.sin(th) * Math.sin(ph)];
        m.positions.push(...n.map((v) => v * o.radiusM));
        m.normals.push(...n);
      }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const k = j * (nu + 1) + i;
      m.indices.push(k, k + nu + 1, k + 1, k + 1, k + nu + 1, k + nu + 2);
    }
  } else if (o.shape === 'cylinder') {
    const [r, h, n] = [o.radiusM, o.heightM / 2, 96];
    for (let i = 0; i < n; i++) {
      const [a0, a1] = [(i / n) * 2 * Math.PI, ((i + 1) / n) * 2 * Math.PI];
      const [c0, s0, c1, s1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
      const k = m.positions.length / 3;
      m.positions.push(r * c0, -h, -r * s0, r * c1, -h, -r * s1, r * c1, h, -r * s1, r * c0, h, -r * s0);
      m.normals.push(c0, 0, -s0, c1, 0, -s1, c1, 0, -s1, c0, 0, -s0);
      m.indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
      for (const [y, ny] of [[h, 1], [-h, -1]]) {
        const q = m.positions.length / 3;
        m.positions.push(0, y, 0, r * c0, y, -r * s0, r * c1, y, -r * s1);
        m.normals.push(0, ny, 0, 0, ny, 0, 0, ny, 0);
        m.indices.push(...(ny > 0 ? [q, q + 1, q + 2] : [q, q + 2, q + 1]));
      }
    }
  } else throw new Error(`未知形体 ${o.shape}`);
  return m;
}

/** 规格的 { R（行主序 3×3）, T } 换成场景包的 mat16（列主序） */
const mat16 = ({ R, T }) => [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, T[0], T[1], T[2], 1];
/** 相机到世界：列是右、上、后（相机看 −Z）和位置 */
const cameraMat = (c) => { const { right, up, fwd } = cameraBasis(c); return [...right, 0, ...up, 0, ...fwd.map((v) => -v), 0, ...c.positionM, 1]; };
const clamp01 = (rgb) => { const m = Math.max(...rgb, 1); return rgb.map((v) => (0.8 * v) / m); };

/**
 * 校准场景写成场景包的 spec（给 writePack）。frames：每一帧 { t, only? }，t 是规格的时刻（帧），only 给了就只画这个物体（别的行矩阵为 0）。
 * asLights：物体写成对相机可见的矩形面光（只用于全是平面发光块的灰阶），几何里只留一个这一帧不画的小三角形。
 */
export function packOf(s, frames, { asLights = false } = {}) {
  const objs = asLights ? [] : s.objects;
  const meshes = asLights ? [{ name: 'unused', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }] : objs.map(meshOf);
  const rows = asLights ? [[0, 0, 1, 0]] : objs.map((o, i) => [i, i, o.idIndex, 0]);
  const flip = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0];
  // 面光：发光面朝局部 −Z，绕 x 转半圈让它朝 +Z（朝相机）；功率 π·宽·高 时辐亮度就是灯色
  const lights = asLights
    ? s.objects.map((o) => ({ name: o.id, type: 'area-rect', size: o.sizeM, watts: Math.PI * o.sizeM[0] * o.sizeM[1], color: o.emissionLinear, visibleToCamera: true }))
    : [{ name: 'key', type: 'area-rect', size: [2, 2], watts: 400, color: [1, 1, 1], visibleToCamera: false }];
  // 别的场景：注视点正上方 4 米一盏朝下的面光（颜色只给乱序、重复两项一张有明暗的画）
  const lightMats = asLights ? s.objects.map((o) => [...flip, ...o.positionM, 1]) : [rotX(-Math.PI / 2, s.camera.lookAtM[0], s.camera.lookAtM[1] + 4, s.camera.lookAtM[2])];
  const manifest = {
    format: 'scene-pack/0.1',
    id: `pack:${s.id}@1`,
    units: { meter: 1, up: 'Y', hand: 'right' },
    geometry: { file: 'geometry.glb', meshes: meshes.map((m) => ({ name: m.name, tris: m.indices.length / 3, attrs: ['position', 'cornerNormal'] })) },
    instances: { file: 'instances.u32', shape: [rows.length, 4], names: asLights ? ['unused'] : objs.map((o) => entityName(o.id)), class: rows.map(() => 'part') },
    materials: asLights
      ? [{ name: 'm', closure: 'surface', params: { baseColor: [0, 0, 0], metallic: 0, roughness: 1 } }]
      : objs.map((o) => ({ name: entityName(o.id), closure: 'surface', params: { baseColor: clamp01(o.emissionLinear), metallic: 0, roughness: 1 } })),
    lights,
    world: { color: s.backgroundLinear, visibleToCamera: true },
    camera: { type: 'persp', near: s.camera.nearM, far: s.camera.farM },
    frames: {
      count: frames.length,
      instances: { file: 'frames/instances.f32', shape: [frames.length, rows.length, 16], fields: ['mat16'] },
      camera: { file: 'frames/camera.f32', shape: [frames.length, 17], fields: ['mat16', 'fovY'] },
      lights: { file: 'frames/lights.f32', shape: [frames.length, lights.length, 16], fields: ['mat16'] },
    },
    source: { exporter: 'core/probe@0.1', blender: '5.2.3', sha256: '0'.repeat(64) },
  };
  const instances = frames.flatMap(({ t, only }) => (asLights ? [ZERO] : objs.map((o) => (only && only !== o.id ? ZERO : mat16(objectTransform(o, t))))).flat());
  const camera = frames.flatMap(() => [...cameraMat(s.camera), (s.camera.yFovDeg * Math.PI) / 180]);
  return { manifest, meshes, rows, tables: { instances, camera, lights: frames.flatMap(() => lightMats.flat()) } };
}

// ------------------------------------------------------------------------------------------------ 经帧源接口渲

const readLayer = (dir, ref) => {
  const b = fs.readFileSync(path.join(dir, ref.file));
  return ref.file.endsWith('.u32') ? new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const digest = (dir, ref) => createHash('sha256').update(fs.readFileSync(path.join(dir, ref.file))).digest('hex');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return (s[Math.floor(s.length / 2)] + s[Math.floor((s.length - 1) / 2)]) / 2; };

/** 镜头输入：一个场景包一个镜头，build-script 模式，草稿档照原尺寸出（缩放 1） */
const shotInput = (s, dir, frames) => ({
  film: 'core-probe',
  output: { size: [s.camera.widthPx, s.camera.heightPx], fps: '24/1' },
  shot: { id: 's01', in: 0, out: frames, source: 'core', host: 'offscreen', mode: 'build-script', entry: dir, colorRef: 'scene', seed: SEED, tiers: { draft: { samples: SAMPLES, scale: 1 } } },
});

/** 跑完整套探针：返回 { report（evaluateSourceConformance 的结果）, readings, observations, runs } */
export async function runProbe({ machine = null, bin } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-core-probe-'));
  const env = { lock: null, tier: 'draft', workspace: path.join(tmp, 'ws'), filmDir: tmp };
  const src = await startSource({ bin });
  const opened = async (s, frames, opts) => {
    const dir = path.join(tmp, `${s.id}-${fs.readdirSync(tmp).length}`);
    writePack(dir, packOf(s, frames, opts));
    return src.open(shotInput(s, dir, frames.length), env);
  };
  try {
    // 颜色线性度
    const gray = scene('probe-gray-chart'), W = gray.camera.widthPx;
    const g = await (await opened(gray, [{ t: 0 }], { asLights: true })).render(0, {}, ['color']);
    const color = readLayer(env.workspace, g.layers.color);
    const at = (px) => { const i = Math.floor(px[1]) * W + Math.floor(px[0]); return [0, 1, 2].map((c) => color[i * 4 + c]); };
    const patches = gray.expected.filter((e) => e.kind === 'patchColor').map((e) => ({ what: e.objectId, expected: e.valueLinear, got: at(e.pixelPx) }));
    patches.push({ what: '背景', expected: gray.backgroundLinear, got: at([320.5, 130.5]) });
    const rel = [], zero = [];
    for (const { expected, got } of patches) expected.forEach((x, c) => (x === 0 ? zero : rel).push(x === 0 ? Math.abs(got[c]) : Math.abs((got[c] - x) / x)));

    // 深度
    const steps = scene('probe-plane-steps');
    const d = await (await opened(steps, [{ t: 0 }])).render(0, {}, ['color', 'depth']);
    const depth = readLayer(env.workspace, d.layers.depth);
    const planes = steps.expected.filter((e) => e.kind === 'pixelHits').map((e) => {
      const got = depth[Math.floor(e.pixelPx[1]) * steps.camera.widthPx + Math.floor(e.pixelPx[0])];
      return { pixel: e.pixelPx, expected: e.hits[0].planeDepthM, got };
    });

    // 编号与元数据：三个方块各自单独渲
    const occ = scene('probe-occlusion'), [ow, oh] = [occ.camera.widthPx, occ.camera.heightPx];
    const occSession = await opened(occ, CUBES.map((only) => ({ t: 0, only })));
    const objectIdMetaIous = {};
    for (const [k, name] of CUBES.entries()) {
      const r = await occSession.render(k, {}, ['color', 'objectId']);
      const e = r.meta.entities.find((x) => x.name === entityName(name));
      objectIdMetaIous[name] = iou(boxOfIds(ow, oh, readLayer(env.workspace, r.layers.objectId), [e.id]), e.bbox2d);
    }

    // 相机约定：端头球与标记块单独渲，编号层覆盖质心对规格投影
    const turn = scene('probe-axes-turntable'), [tw, th] = [turn.camera.widthPx, turn.camera.heightPx];
    const solo = [...['tip-x', 'tip-y', 'tip-z'].map((only) => ({ t: 0, only })), ...[0, 24, 48, 72, 96].map((t) => ({ t, only: 'turntable-marker' }))];
    const soloSession = await opened(turn, solo);
    const anchors = [];
    for (const [k, { t, only }] of solo.entries()) {
      const r = await soloSession.render(k, {}, ['color', 'objectId']);
      const ids = readLayer(env.workspace, r.layers.objectId), id = turn.objects.find((o) => o.id === only).idIndex;
      const got = centroid(tw, th, (i) => ids[i] === id).px;
      const expected = project(turn.camera, objectTransform(turn.objects.find((o) => o.id === only), t).T);
      anchors.push({ object: only, t, expected, got, px: Math.hypot(got[0] - expected[0], got[1] - expected[1]) });
    }

    // 法线、乱序、重复：转台 0 到 96 帧（镜头局部帧号就是规格的时刻）
    const frames = Array.from({ length: 97 }, (_, t) => ({ t }));
    const pass = async (session, order) => {
      const out = [];
      for (const f of order) {
        const r = await session.render(f, {}, ['color', 'normal']);
        out.push({ frame: f, digest: digest(env.workspace, r.layers.color), normalDigest: digest(env.workspace, r.layers.normal), normal: readLayer(env.workspace, r.layers.normal) });
      }
      return out;
    };
    const seqSession = await opened(turn, frames);
    const sequential = await pass(seqSession, FRAMES);
    const repeat = await pass(seqSession, FRAMES);
    const other = await startSource({ bin });
    const dir = path.join(tmp, `${turn.id}-shuffled`);
    writePack(dir, packOf(turn, frames));
    const shuffled = await pass(await other.open(shotInput(turn, dir, frames.length), env), shuffledFrames());
    const normals = sequential.flatMap(({ frame, normal }) => spherePixels(frame).map((p) => ({
      frame, object: p.object, pixel: [p.x, p.y], expected: toCamera(p.world), got: [0, 1, 2].map((c) => normal[(p.y * tw + p.x) * 3 + c]),
    })));

    const strip = (xs) => xs.map(({ frame, digest: dg, normalDigest }) => ({ frame, digest: dg, normalDigest }));
    const readings = {
      colorLinearityMaxRelErr: Math.max(...rel), colorZeroMaxAbsErr: Math.max(...zero),
      depthMedianRelErr: median(planes.map((p) => Math.abs((p.got - p.expected) / p.expected))),
      cameraAnchorMaxPx: Math.max(...anchors.map((a) => a.px)),
    };
    const observations = { objectIdMetaIous, normals: normals.map(({ expected, got }) => ({ expected, got })), sequential: strip(sequential), shuffled: strip(shuffled), repeat: strip(repeat) };
    const caps = src.caps();
    const report = evaluateSourceConformance({ source: 'core', machine, conformance: caps.conformance, determinism: caps.determinism, readings, observations });
    // 确定性另记一份原始比较：不论能力声明写的哪一档，同一帧各种渲法的颜色层、法线层是不是逐字节相同
    const byFrame = new Map(sequential.map((x) => [x.frame, x]));
    const same = (xs) => xs.filter((x) => byFrame.get(x.frame).digest === x.digest && byFrame.get(x.frame).normalDigest === x.normalDigest).length;
    const determinism = { frames: FRAMES.length, repeatSame: same(repeat), shuffledSame: same(shuffled), distinctAcrossFrames: new Set(sequential.map((x) => x.digest)).size };
    return { report, readings, observations: { objectIdMetaIous, normalSamples: normals.length, normalMedianDeg: report.rows.find((r) => r.id === 'normal-space').measured.normalMedianDeg }, determinism, runs: { patches, planes, anchors }, caps };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = await runProbe({ machine: arg('--machine') ?? null });
  const text = `${JSON.stringify({ platform: `${process.platform} ${os.release()} ${process.arch}`, ...out }, null, 1)}\n`;
  if (arg('--out')) fs.writeFileSync(arg('--out'), text);
  process.stdout.write(`${JSON.stringify({ ok: out.report.ok, rows: out.report.rows.map((r) => [r.id, r.status, r.measured]), determinism: out.determinism })}\n`);
  process.exitCode = out.report.ok ? 0 : 4;
}
