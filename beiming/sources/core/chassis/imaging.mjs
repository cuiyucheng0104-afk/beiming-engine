#!/usr/bin/env node
// 北冥 · 成像一路的第 2 级：像素滤波与 Cycles 口径的夹取接进内核（core-render render-pack）后渲图对解析值。
//   像素滤波：刀口场景（半平面黑白分界）在三种滤波、两种宽度下出图，沿分界的剖面（把每一列像素平均）对「Cycles 的滤波表
//   给出的分布与刀口的卷积」（tableExpected），每一列的差不超过 4 个标准误；对连续滤波函数的卷积（knifeExpected）只记录不判：
//   Cycles 的表在尾巴上有离散化（util/math_cdf.cpp 对称的一支、scene/film.cpp 表的最后一格为 0），约 0.3% 的样本不照连续
//   滤波函数分布，标准答案是 Cycles 的表。盒式宽 1 不查表（子像素均匀抖动），对连续盒式判；与不加参数逐位相同。
//   夹取：粗糙度 0 的金属是奇异闭包（不做光源采样，多重重要性采样的权重是 1），经它看亮度已知的均匀天空，每个样本的贡献
//   是确定的数。照 Cycles，背景按「弹射数减 1」选上限（kernel/film/light_passes.h:638 与 :140-141）：相机直接看到的天空与
//   单面镜里的天空（减 1 之后是 −1、0）走直接光的上限，直角反射器里两次反射之后的天空（减 1 之后是 1）走间接光的上限。
//   上限低于真值时逐通道等于照 Cycles 的式子手算的值（±3 个标准误；每个样本相同、标准误为 0 时按 1e-5 相对误差）；不该
//   起作用的那个上限与不夹逐位相同；上限为 0 时与不设逐位相同。直角反射器「每条相机射线恰好反射两次」由 cornerBounces 的
//   几何追踪与读数一起证明。
//   滤光泽：漫反射地面经近镜面金属板看小面光的焦散，关与开各对 Blender Cycles 渲的同一场景（cycles-filter-glossy.json）
//   取中央一块区域的均值，±4 个合并标准误；开与关之差在两边都要超过 5 个合并标准误（判得出的条件）；滤光泽给 0 与不给逐位相同。
//   负对照：在源码的拷贝上各改错一项（build.mjs 的 inject），对应的一项必须不过。
//   node beiming/sources/core/chassis/imaging.mjs [--out 报告.json]
// 退出码：0 全部过；4 有一项不过；3 缺工具链（cargo、显卡）。
// 渲染一律取内核的线性浮点原始输出（--hdr，曝光与后期之前），不降噪。场景包由 scenepack.mjs 写在系统临时目录里。
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { crs, dot3 } from '../fncheck/registry.mjs';
import { PRESETS, buildRenderer, missing } from './build.mjs';
import { IDENTITY, translate, writePack } from './scenepack.mjs';

export const GATES = { knifeSE: 4, clampSE: 3, clampRel: 1e-5, glossySE: 4, glossyDistinct: 5 };

const UNITS = { meter: 1, up: 'Y', hand: 'right' };
const SOURCE = { exporter: 'chassis/imaging@0.1', blender: '5.2.3', sha256: '0'.repeat(64) };
// 镜面：金属度 1、粗糙度 0（奇异闭包）、底色白，F82 的边缘色默认白：Cycles 的 F82-tint 在 F0 = 1、边缘色 = 1 时 b = 0，反射率恒为 1
const MIRROR = { name: 'mirror', closure: 'surface', params: { baseColor: [1, 1, 1], metallic: 1, roughness: 0 } };
const quad = (name, corners, n) => ({ name, positions: corners.flat(), normals: Array(4).fill(n).flat(), indices: [0, 1, 2, 0, 2, 3] });
const mesh = m => ({ name: m.name, tris: 2, attrs: ['position', 'cornerNormal'] });

/** 一个包：meshes 每个一行实例（单位矩阵），一个镜面材质，没有灯；世界颜色 world、对相机可不可见；相机在 cam（平移），fovY 弧度 */
function pack(id, meshes, { world, visible, cam, fovY }) {
  const n = meshes.length;
  return {
    manifest: {
      format: 'scene-pack/0.1', id, units: UNITS,
      geometry: { file: 'geometry.glb', meshes: meshes.map(mesh) },
      instances: { file: 'instances.u32', shape: [n, 4], names: meshes.map(m => m.name), class: meshes.map(() => 'part') },
      materials: [MIRROR],
      lights: [],
      world: { color: world, visibleToCamera: visible },
      camera: { type: 'persp', near: 0.05, far: 100 },
      frames: {
        count: 1,
        instances: { file: 'frames/instances.f32', shape: [1, n, 16], fields: ['mat16'] },
        camera: { file: 'frames/camera.f32', shape: [1, 17], fields: ['mat16', 'fovY'] },
        lights: { file: 'frames/lights.f32', shape: [1, 0, 16], fields: ['mat16'] },
      },
      source: SOURCE,
    },
    meshes,
    rows: meshes.map((_, i) => [i, 0, i + 1, 0]),
    tables: { instances: meshes.flatMap(() => IDENTITY), camera: [...translate(...cam), fovY], lights: [] },
  };
}

// 刀口：z = 0 上一块镜面占住 x < X0 的半平面（往上下左右各伸 50 m），背景对相机不可见（相机射线没打到表面的样本记 0）、
// 白色世界亮度 1 从镜面反射进相机，镜面那一侧的读数约 1、另一侧恰为 0。相机在 (0, 0, 3) 朝 -z，画面 32×128，tan(fovY/2) = 0.5，
// 过 z = 0 的平面上像素到 x 是线性映射（一个像素 3·0.5·宽高比·2/32 m），分界落在第 EDGE 列（像素坐标，0 是左边缘）。
// 平台（镜面一侧的读数；粗糙度 0 的金属是奇异闭包，每个样本恰为 1，标准误为 0）取 plateau 那几列的均值：分界减 0.5 再减
// 最宽的支撑半宽（高斯宽 3 的 4.5）之后还在左边的列，每个样本都落在镜面上。
export const KNIFE = { w: 32, h: 128, spp: 256, tan: 0.5, cam: 3, edge: 16.3, plateau: [0, 11] };
const knifePixel = () => (2 * KNIFE.cam * KNIFE.tan * (KNIFE.w / KNIFE.h)) / KNIFE.w;
export function knifePack() {
  const X0 = (KNIFE.edge - KNIFE.w / 2) * knifePixel();
  return pack('pack:chassis-knife@1', [quad('plate', [[-50, -50, 0], [X0, -50, 0], [X0, 50, 0], [-50, 50, 0]], [0, 0, 1])], { world: [1, 1, 1], visible: false, cam: [0, 0, KNIFE.cam], fovY: 2 * Math.atan(KNIFE.tan) });
}

// 夹取用的三个场景，天空颜色 world 可选（默认白，亮度 1）。
// 相机直接看天空（画面外放一块镜子凑足几何）：相机射线打到背景，弹射数减 1 是 −1，走直接光的上限
export const SKY = { w: 16, h: 16, spp: 16 };
export function skyPack(world = [1, 1, 1]) {
  return pack('pack:chassis-sky@1', [quad('behind', [[-1, -1, 10], [1, -1, 10], [1, 1, 10], [-1, 1, 10]], [0, 0, 1])], { world, visible: true, cam: [0, 0, 3], fovY: 0.3 });
}
// 单面镜：z = 0 上 100×100 m 的镜子，相机在 (0, 0, 3) 朝 −z，fovY 0.3：每条相机射线在镜子上反射一次后朝上打到天空，
// 弹射数减 1 是 0，走直接光的上限
export const MIRROR_VIEW = { w: 32, h: 32, spp: 64 };
export const mirrorQuads = () => [quad('mirror', [[-50, -50, 0], [50, -50, 0], [50, 50, 0], [-50, 50, 0]], [0, 0, 1])];
export function mirrorPack(world = [1, 1, 1]) {
  return pack('pack:chassis-mirror@1', mirrorQuads(), { world, visible: true, cam: [0, 0, 3], fovY: 0.3 });
}
// 直角反射器：两面镜子沿 y 轴拼成开口朝 +z 的直角（棱在原点，镜面法线 (±1, 0, 1)/√2），相机在 (−0.4, 0, 5) 朝 −z、
// tan(fovY/2) = 0.03 看进去：相机射线先打 x < 0 的那面，再打 x > 0 的那面，原路方向退回去打到天空。打到天空时路径上已有
// 两次弹射，弹射数减 1 是 1，走间接光的上限
export const CORNER = { w: 32, h: 32, spp: 64, cam: [-0.4, 0, 5], tan: 0.03 };
export function cornerQuads() {
  const L = 2, Y = 5, s = Math.SQRT1_2;
  return [
    quad('a', [[-L, -Y, L], [0, -Y, 0], [0, Y, 0], [-L, Y, L]], [s, 0, s]),
    quad('b', [[0, -Y, 0], [L, -Y, L], [L, Y, L], [0, Y, 0]], [-s, 0, s]),
  ];
}
export function cornerPack(world = [1, 1, 1]) {
  return pack('pack:chassis-corner@1', cornerQuads(), { world, visible: true, cam: CORNER.cam, fovY: 2 * Math.atan(CORNER.tan) });
}

const sub = (a, b) => a.map((x, i) => x - b[i]);
/** 射线与三角形（Möller–Trumbore），返回距离或 Infinity */
function hitTri(o, d, p0, p1, p2) {
  const e1 = sub(p1, p0), e2 = sub(p2, p0), q = crs(d, e2), det = dot3(e1, q);
  if (Math.abs(det) < 1e-12) return Infinity;
  const s = sub(o, p0), u = dot3(s, q) / det, r = crs(s, e1), v = dot3(d, r) / det, t = dot3(e2, r) / det;
  return u >= 0 && v >= 0 && u + v <= 1 && t > 1e-9 ? t : Infinity;
}
/** 几何追踪（双精度）：从 o 沿 d 在这几面镜子之间理想反射，返回反射次数与最后离开时的方向；超过 8 次算没出来 */
export function traceMirrors(quads, o, d) {
  let n = 0;
  for (; n <= 8; n++) {
    let best = { t: Infinity };
    for (const q of quads) {
      const P = k => q.positions.slice(3 * k, 3 * k + 3);
      for (let k = 0; k < q.indices.length; k += 3) {
        const t = hitTri(o, d, P(q.indices[k]), P(q.indices[k + 1]), P(q.indices[k + 2]));
        if (t < best.t) best = { t, N: q.normals.slice(0, 3) };
      }
    }
    if (best.t === Infinity) return { reflections: n, out: d };
    o = o.map((x, i) => x + best.t * d[i]);
    const k = 2 * dot3(d, best.N);
    d = d.map((x, i) => x - k * best.N[i]);
  }
  return { reflections: n, out: d };
}
/** 相机射线覆盖的整个视锥（盒式宽 1 的子像素抖动不出画面）上取 (m+1)² 个方向，含四角，逐个几何追踪：
 *  返回各个反射次数出现的次数，与离开时朝下（z ≤ 0）的条数。场景是平面镜、视锥是凸的，取到四角与网格就覆盖了 */
export function viewBounces(quads, cam, tanY, aspect, m = 64) {
  const count = {};
  let down = 0;
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= m; j++) {
      const d = [(2 * i / m - 1) * tanY * aspect, (2 * j / m - 1) * tanY, -1];
      const r = traceMirrors(quads, cam, d);
      count[r.reflections] = (count[r.reflections] ?? 0) + 1;
      if (r.out[2] <= 0) down++;
    }
  }
  return { count, down };
}
export const cornerBounces = () => viewBounces(cornerQuads(), CORNER.cam, CORNER.tan, CORNER.w / CORNER.h);
export const mirrorBounces = () => viewBounces(mirrorQuads(), [0, 0, 3], Math.tan(0.15), MIRROR_VIEW.w / MIRROR_VIEW.h);

// ---------------------------------------------------------------------------------------------------------------
// 渲染

let tmp = null;
const work = () => tmp ?? (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-imaging-')));
process.on('exit', () => tmp && fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

/** 写包、渲一帧，返回 { hdr: Float32Array（RGB，行主序）, bytes: Buffer }；args 是 render-pack 的额外参数，env 是额外的环境变量
 *  （THREERT_SEED 换随机数种子） */
export function render(bin, spec, { w, h, spp }, args = [], env = {}) {
  const dir = path.join(work(), `p${seq++}`), out = path.join(work(), `r${seq++}.raw`);
  writePack(dir, spec);
  const r = spawnSync(bin, ['render-pack', dir, '-o', path.join(work(), 'out.png'), '--hdr', out, '--spp', String(spp), '--width', String(w), '--height', String(h), '--no-denoise', '--presets', PRESETS, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...env } });
  if (r.status !== 0) throw Object.assign(new Error(`render-pack ${args.join(' ')} 失败：${r.stderr.trim().split('\n').at(-1)}`), /adapter|GPU|显卡/i.test(r.stderr) ? { missing: 'GPU' } : {});
  const bytes = fs.readFileSync(out);
  return { bytes, hdr: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) };
}

const pixel = (hdr, i) => (hdr[3 * i] + hdr[3 * i + 1] + hdr[3 * i + 2]) / 3;
const meanSe = xs => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean: m, se: Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length) };
};

// ---------------------------------------------------------------------------------------------------------------
// 像素滤波：滤波函数照 Cycles 的 scene/film.cpp（建表前高斯的宽度乘 3、Blackman-Harris 乘 2），支撑在 [−R, R] 上，
// R 是放大后的宽度的一半。像素内的偏移 o 落在 [0.5 − R, 0.5 + R]，按滤波函数分布

export const FILTERS = {
  box: { R: w => w / 2, f: () => 1 },
  gaussian: { R: w => 1.5 * w, f: (a, w) => Math.exp(-2 * ((6 * a) / (3 * w)) ** 2) },
  'blackman-harris': { R: w => w, f: (a, w) => { const v = 2 * Math.PI * (a / (2 * w) + 0.5); return 0.35875 - 0.48829 * Math.cos(v) + 0.14128 * Math.cos(2 * v) - 0.01168 * Math.cos(3 * v); } },
};

/** 滤波函数从 −R 积到 v（归一到 1），中点法 m 格：误差是 O((2R/m)²)，m = 20000 时比读数的标准误小两个量级以上 */
export function filterCdf(kind, w, m = 20_000) {
  const { R, f } = FILTERS[kind], r = R(w), dx = (2 * r) / m, c = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) c[i + 1] = c[i] + f(Math.abs(-r + (i + 0.5) * dx), w);
  const total = c[m];
  return v => {
    if (v <= -r) return 0;
    if (v >= r) return 1;
    const x = (v + r) / dx, i = Math.floor(x);
    return (c[i] + (x - i) * (c[Math.min(i + 1, m)] - c[i])) / total;
  };
}

/** 刀口的剖面：第 i 列的期望 = 平台 × P(i + o < 分界)，即滤波函数在 v = 分界 − i − 0.5 处的累积分布 */
export function knifeExpected(kind, w, plateau) {
  const cdf = filterCdf(kind, w);
  return Array.from({ length: KNIFE.w }, (_, i) => plateau * cdf(KNIFE.edge - i - 0.5));
}

/** 判定用：照宿主一侧建出的表（core-render fncheck-host filter_table，第 1 级逐项对 Cycles 建的表，相对误差 0）算的剖面期望。
 *  表是分段线性的反函数，第 s 段占随机数的 1/1023、在 [表[s], 表[s+1]] 上均匀（最后一段反着铺回 0），第 i 列的期望是
 *  平台 × Σ_s (1/1023) × 这一段里 i + o < 分界的比例。每段是闭式，没有数值积分，误差只有双精度舍入（约 1e-15，远小于标准误的 1/10）。
 *  bin 必须是没改错的渲染程序：负对照改的正是建表，拿改错的程序建期望就抓不到了 */
export function tableExpected(bin, kind, width, plateau) {
  const type = Object.keys(FILTERS).indexOf(kind);
  const input = Float32Array.from([type, width]);
  const r = spawnSync(bin, ['fncheck-host', 'filter_table'], { input: Buffer.from(input.buffer, input.byteOffset, input.byteLength) });
  if (r.status !== 0) throw new Error(`core-render fncheck-host filter_table 失败：${r.stderr}`);
  const t = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length));
  return Array.from({ length: KNIFE.w }, (_, i) => {
    const cut = KNIFE.edge - i;
    let p = 0;
    for (let k = 0; k < 1023; k++) {
      const a = Math.min(t[k], t[k + 1]), b = Math.max(t[k], t[k + 1]);
      p += b > a ? Math.min(1, Math.max(0, (cut - a) / (b - a))) : (a < cut ? 1 : 0);
    }
    // 先加各段的比例、最后除一次：整列都落在镜面一侧时 p 恰为 1。合并后镜面是奇异闭包，平台每个样本都是 1、标准误为 0，
    // 逐段除 1023 再加会留下 1e-16 的舍入，在标准误为 0 时就成了无穷多个标准误
    return plateau * (p / 1023);
  });
}

/** 每一列（128 行）的均值与标准误（行与行之间独立：每个像素自己的随机数种子） */
export function columns(hdr, w, h) {
  return Array.from({ length: w }, (_, x) => meanSe(Array.from({ length: h }, (_, y) => pixel(hdr, y * w + x))));
}

/** 一种滤波、一个宽度：剖面每一列对期望的标准误倍数。bin 出图，ref 建期望用的表（默认同 bin；负对照传没改错的那个）。
 *  判定对 Cycles 表给出的期望（盒式宽 1 不查表，对连续盒式）；对连续滤波函数的那一列（continuousWorst）只记录 */
export function knifeCase(bin, kind, width, { ref = bin, args = ['--pixel-filter', kind, '--filter-width', String(width)] } = {}) {
  const { hdr } = render(bin, knifePack(), KNIFE, args);
  const cols = columns(hdr, KNIFE.w, KNIFE.h);
  const plat = meanSe(cols.slice(...KNIFE.plateau).map(c => c.mean)), plateau = plat.mean;
  const continuous = knifeExpected(kind, width, plateau);
  const exp = kind === 'box' && width === 1 ? continuous : tableExpected(ref, kind, width, plateau);
  // 标准误把平台的标准误按这一列的覆盖比例算进去（期望是平台乘一个确定的数）
  const zOf = (c, e) => {
    const se = Math.hypot(c.se, (e / plateau) * plat.se);
    return { se, z: se > 0 ? (c.mean - e) / se : (c.mean === e ? 0 : Infinity) };
  };
  const rows = cols.map((c, i) => ({ column: i, mean: c.mean, expected: exp[i], ...zOf(c, exp[i]), continuous: continuous[i], zContinuous: zOf(c, continuous[i]).z }));
  const worst = rows.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a));
  const cw = rows.reduce((a, b) => (Math.abs(b.zContinuous) > Math.abs(a.zContinuous) ? b : a));
  return { name: `${kind} ${width}`, kind, width, plateau, rows, worst, continuousWorst: { column: cw.column, expected: cw.continuous, z: cw.zContinuous }, ok: rows.every(r => Math.abs(r.z) <= GATES.knifeSE) };
}

// ---------------------------------------------------------------------------------------------------------------
// 夹取：照 Cycles 的 kernel/film/light_passes.h film_clamp_light，一次贡献三个分量绝对值之和超过上限（用户值乘 3，
// scene/integrator.cpp:311-315）就按比例缩到上限。灰的贡献 (v, v, v) 夹过之后每个分量是 min(v, 用户值)

/** 照 Cycles 的式子手算夹过之后的颜色：天空 c 的三个分量之和超过 3 × 上限 u 就按比例缩 */
export const clampedSky = (c, u) => c.map(x => x * Math.min(1, (3 * u) / (c[0] + c[1] + c[2])));
const channel = (hdr, n, k) => meanSe(Array.from({ length: n }, (_, i) => hdr[3 * i + k]));
/** 一项夹取，逐通道对手算值：标准误不为 0 时 ±3 个标准误；每个样本相同（标准误为 0）时相对误差 ≤ 1e-5 */
function clampCase(bin, name, spec, size, args, expected) {
  const { hdr } = render(bin, spec, size, args);
  const rows = expected.map((e, k) => {
    const { mean, se } = channel(hdr, size.w * size.h, k);
    const rel = Math.abs(mean - e) / Math.abs(e);
    return { mean, se, expected: e, z: se > 0 ? (mean - e) / se : null, rel, ok: se > 0 ? Math.abs(mean - e) <= GATES.clampSE * se : rel <= GATES.clampRel };
  });
  const worst = rows.reduce((p, r) => (r.z ?? r.rel / GATES.clampRel * GATES.clampSE) ** 2 > (p.z ?? p.rel / GATES.clampRel * GATES.clampSE) ** 2 ? r : p);
  return { name, args, channels: rows, z: worst.z, rel: worst.rel, ok: rows.every(r => r.ok) };
}
/** 一项「这个上限不该起作用」：与不夹逐位相同 */
function clampSame(bin, name, spec, size, args) {
  const a = render(bin, spec, size, args), b = render(bin, spec, size);
  let diff = 0;
  for (let i = 0; i < a.hdr.length; i++) diff = Math.max(diff, Math.abs(a.hdr[i] - b.hdr[i]));
  return { name, args, diff, ok: a.bytes.equals(b.bytes) };
}

const WHITE = [1, 1, 1], COLORED = [1, 0.5, 0.25];
const U = 0.2;
/** 夹取的各项，键是负对照挑项用的名字 */
export const CLAMP_CASES = {
  skyDirect: bin => clampCase(bin, '相机直接看天空，直接光上限 0.5', skyPack(), SKY, ['--clamp-direct', '0.5'], clampedSky(WHITE, 0.5)),
  skyIndirect: bin => clampSame(bin, '相机直接看天空，只设间接光上限 0.1', skyPack(), SKY, ['--clamp-indirect', '0.1']),
  mirrorDirectWhite: bin => clampCase(bin, '单面镜、白天空，直接光上限 0.2', mirrorPack(WHITE), MIRROR_VIEW, ['--clamp-direct', String(U)], clampedSky(WHITE, U)),
  mirrorDirectColored: bin => clampCase(bin, '单面镜、彩色天空，直接光上限 0.2', mirrorPack(COLORED), MIRROR_VIEW, ['--clamp-direct', String(U)], clampedSky(COLORED, U)),
  mirrorIndirect: bin => clampSame(bin, '单面镜，只设间接光上限 0.2', mirrorPack(COLORED), MIRROR_VIEW, ['--clamp-indirect', String(U)]),
  cornerIndirectWhite: bin => clampCase(bin, '直角反射器、白天空，间接光上限 0.2', cornerPack(WHITE), CORNER, ['--clamp-indirect', String(U)], clampedSky(WHITE, U)),
  cornerIndirectColored: bin => clampCase(bin, '直角反射器、彩色天空，间接光上限 0.2', cornerPack(COLORED), CORNER, ['--clamp-indirect', String(U)], clampedSky(COLORED, U)),
  cornerDirect: bin => clampSame(bin, '直角反射器，只设直接光上限 0.2', cornerPack(COLORED), CORNER, ['--clamp-direct', String(U)]),
};
/** 夹取：几何追踪（单面镜每条相机射线恰好反射一次、直角反射器恰好两次，离开时都朝上）与各项读数 */
export function clampCases(bin, only = Object.keys(CLAMP_CASES)) {
  return { geometry: { mirror: mirrorBounces(), corner: cornerBounces() }, cases: only.map(k => CLAMP_CASES[k](bin)) };
}
/** 几何追踪的判定：count 里只有 want 次反射，没有离开时朝下的 */
export const geometryOk = (g, want) => Object.keys(g.count).join() === String(want) && g.down === 0;

// ---------------------------------------------------------------------------------------------------------------
// 滤光泽：照 Cycles 的 integrator/surface_shader.h surface_shader_prepare_closures，弹过一次之后打到的微表面闭包按路径上最小的
// 采样概率密度 min_ray_pdf 把 alpha 抬到 sqrt(1 − filter_glossy × min_ray_pdf) × 0.5（宿主存 1 / blur_glossy）。相机直接看到的面
// 不模糊，所以要一个「先漫反射、再光泽」的场景：漫反射地面经一块近镜面的金属板看小面光的焦散。标准答案是 Blender 5.2.3 的
// Cycles 渲的同一场景（cycles-filter-glossy.json，blur_glossy 关与开），取画面中央一块区域的均值，对它 ±4 个合并标准误；
// 开与关之差在两边都要超过 5 个合并标准误，否则这个场景判不出滤光泽，报不过。

export const GLOSSY_REF = JSON.parse(fs.readFileSync(new URL('./cycles-filter-glossy.json', import.meta.url), 'utf8'));
// 场景的数照 Cycles 一侧的脚本（GLOSSY_REF.source.scene），Blender 坐标、z 朝上；写进包时照导出器换轴 (x, y, z) → (x, z, −y)，
// 相机与灯的矩阵是 A·M（相机看 −z、上是 +y；面光朝局部 −z 发光）。区域对 x、y 都对称，画面怎么存都不影响读数
export const GLOSSY = { w: 64, h: 64, region: [24, 40], sppOff: 16_384, sppOn: 4096, seeds: 4, blur: 0.25 };
const toPack = v => [v[0], v[2], -v[1]];
const unit = v => v.map(x => x / Math.hypot(...v));
const axpy = (a, b, s) => a.map((x, i) => x + s * b[i]);
/** 中心 c、边 u、v（u × v 是正面法线）、半边长 h 的方块，四角逆时针，与 Cycles 一侧的 quad 同序 */
function quadB(name, c, u, v, h) {
  const n = unit(crs(u, v)), P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => axpy(axpy(c, u, a * h), v, b * h));
  return { name, positions: P.flatMap(toPack), normals: Array(4).fill(toPack(n)).flat(), indices: [0, 1, 2, 0, 2, 3] };
}
/** 列主序 A·M：M 的三列是局部 x、y、z 轴在 Blender 里的方向，t 是位置 */
const matA = (x, y, z, t) => [...toPack(x), 0, ...toPack(y), 0, ...toPack(z), 0, ...toPack(t), 1];
export function glossyPack() {
  const { camera, light, plate, floor } = GLOSSY_REF.source.scene;
  const n = unit(axpy(unit(axpy(light.location, plate.center, -1)), unit(axpy(plate.target, plate.center, -1)), 1));
  const meshes = [quadB('floor', [0, 0, 0], [1, 0, 0], [0, 1, 0], floor.half), quadB('plate', plate.center, [0, 1, 0], [-n[2], 0, n[0]], plate.half)];
  const mat = (name, m) => ({ name, closure: 'surface', params: { baseColor: m.base_color, metallic: m.metallic, roughness: m.roughness } });
  return {
    manifest: {
      format: 'scene-pack/0.1', id: 'pack:chassis-glossy@1', units: UNITS,
      geometry: { file: 'geometry.glb', meshes: meshes.map(mesh) },
      instances: { file: 'instances.u32', shape: [2, 4], names: ['floor', 'plate'], class: ['part', 'part'] },
      materials: [mat('floor', floor.material), mat('plate', plate.material)],
      lights: [{ name: 'lamp', type: 'area-rect', size: light.size, watts: light.watts, color: [1, 1, 1], visibleToCamera: false }],
      world: { color: [0, 0, 0], visibleToCamera: true },
      camera: { type: 'persp', near: 0.05, far: 100 },
      frames: {
        count: 1,
        instances: { file: 'frames/instances.f32', shape: [1, 2, 16], fields: ['mat16'] },
        camera: { file: 'frames/camera.f32', shape: [1, 17], fields: ['mat16', 'fovY'] },
        lights: { file: 'frames/lights.f32', shape: [1, 1, 16], fields: ['mat16'] },
      },
      source: SOURCE,
    },
    meshes,
    rows: [[0, 0, 1, 0], [1, 1, 2, 0]],
    tables: {
      instances: [...IDENTITY, ...IDENTITY],
      camera: [...matA([1, 0, 0], [0, 1, 0], [0, 0, 1], camera.location), 2 * Math.atan(camera.tan_half_fov)],
      // 面光朝 +z：绕 x 轴转 180°
      lights: matA([1, 0, 0], [0, -1, 0], [0, 0, -1], light.location),
    },
  };
}

/** 区域均值与标准误，口径同 Cycles 一侧：几个种子逐像素平均，标准误 = sqrt(Σ_像素 种子间方差 / 种子数) / 像素数 */
export function regionReading(images, { w, region: [a, b] }) {
  const k = images.length;
  let sum = 0, varSum = 0, n = 0;
  for (let y = a; y < b; y++) {
    for (let x = a; x < b; x++) {
      const v = images.map(im => pixel(im, y * w + x)), m = v.reduce((p, q) => p + q, 0) / k;
      sum += m;
      varSum += v.reduce((p, q) => p + (q - m) ** 2, 0) / (k - 1);
      n++;
    }
  }
  return { mean: sum / n, se: Math.sqrt(varSum / k) / n };
}
// 渲染设置对上 Cycles 一侧：原理化 BSDF 默认的分布是多重散射 GGX（能量补偿开），弹射上限 128。render-pack 默认的预设
// （cinematic）能量补偿是 0、弹射上限 8，所以用 --override 改这两项，做法同 level2.mjs 的白炉
export const GLOSSY_OVERRIDE = ['--override', JSON.stringify({ native: { energyCompensation: 1, maxBounces: 128 } })];
const glossyRender = (bin, args, spp) => regionReading(Array.from({ length: GLOSSY.seeds }, (_, s) => render(bin, glossyPack(), { ...GLOSSY, spp }, [...GLOSSY_OVERRIDE, ...args], { THREERT_SEED: String(s + 1) }).hdr), GLOSSY);
const cyclesRow = blur => GLOSSY_REF.rows.find(r => r.blur_glossy === blur);
const zOfPair = (a, b) => (a.mean - b.mean) / Math.hypot(a.se, b.se);

/** 滤光泽：关与开（blur_glossy = GLOSSY.blur）各对 Cycles；开与关之差在两边都要超过 5 个合并标准误（判得出的条件）。
 *  only 挑项（负对照只跑开的那一项） */
export function glossyCases(bin, only = ['off', 'on']) {
  const ours = {}, rows = [];
  for (const key of only) {
    const blur = key === 'on' ? GLOSSY.blur : 0;
    ours[key] = glossyRender(bin, key === 'on' ? ['--filter-glossy', String(blur)] : [], key === 'on' ? GLOSSY.sppOn : GLOSSY.sppOff);
    const ref = cyclesRow(blur), z = zOfPair(ours[key], { mean: ref.region_mean, se: ref.se });
    rows.push({ name: `滤光泽${key === 'on' ? `开（blur_glossy ${blur}）` : '关'}对 Cycles`, blur, ours: ours[key], cycles: { mean: ref.region_mean, se: ref.se }, z, ok: Math.abs(z) <= GATES.glossySE });
  }
  if (only.length === 2) {
    const c = zOfPair({ mean: cyclesRow(GLOSSY.blur).region_mean, se: cyclesRow(GLOSSY.blur).se }, { mean: cyclesRow(0).region_mean, se: cyclesRow(0).se });
    const o = zOfPair(ours.on, ours.off);
    rows.push({ name: '判得出：开与关之差', zCycles: c, zOurs: o, ok: Math.abs(c) > GATES.glossyDistinct && Math.abs(o) > GATES.glossyDistinct });
  }
  return rows;
}

/** 上限给 0、盒式宽 1 显式给出、滤光泽给 0：与不加参数逐位相同 */
export function bitwiseCases(bin) {
  const knife = knifePack(), corner = cornerPack(COLORED), glossy = glossyPack();
  const same = (spec, size, args) => render(bin, spec, size, args).bytes.equals(render(bin, spec, size).bytes);
  return [
    { name: '盒式宽 1 显式给出', ok: same(knife, KNIFE, ['--pixel-filter', 'box', '--filter-width', '1']) },
    { name: '两个夹取上限给 0', ok: same(corner, CORNER, ['--clamp-direct', '0', '--clamp-indirect', '0']) },
    { name: '滤光泽给 0', ok: render(bin, glossy, { ...GLOSSY, spp: 256 }, [...GLOSSY_OVERRIDE, '--filter-glossy', '0']).bytes.equals(render(bin, glossy, { ...GLOSSY, spp: 256 }, GLOSSY_OVERRIDE).bytes) },
  ];
}

export const KNIFE_CASES = [['box', 1], ['box', 1.5], ['box', 3], ['gaussian', 1.5], ['gaussian', 3], ['blackman-harris', 1.5], ['blackman-harris', 3]];

// 负对照（build.mjs 的 inject；file 相对 beiming/sources/core/，工作树不动）：每项改错一处，挑出来的每一项都必须不过
export const NEGATIVE = [
  {
    name: '像素滤波：高斯建表前宽度乘 2.5（应为 3）',
    inject: { file: 'path/src/pixel_filter.rs', from: 'FilterType::Gaussian => (filter_func_gaussian, width * 3.0),', to: 'FilterType::Gaussian => (filter_func_gaussian, width * 2.5),' },
    run: (bin, ref) => [knifeCase(bin, 'gaussian', 1.5, { ref })],
  },
  {
    name: '像素滤波：Blackman-Harris 建表前宽度乘 1.8（应为 2）',
    inject: { file: 'path/src/pixel_filter.rs', from: 'FilterType::BlackmanHarris => (filter_func_blackman_harris, width * 2.0),', to: 'FilterType::BlackmanHarris => (filter_func_blackman_harris, width * 1.8),' },
    run: (bin, ref) => [knifeCase(bin, 'blackman-harris', 1.5, { ref })],
  },
  {
    name: '像素滤波：盒式的表照半宽建（宽度少乘一半）',
    inject: { file: 'path/src/pixel_filter.rs', from: 'FilterType::Box => (filter_func_box, width),', to: 'FilterType::Box => (filter_func_box, width * 0.5),' },
    run: (bin, ref) => [knifeCase(bin, 'box', 3, { ref })],
  },
  {
    name: '夹取：宿主没把用户值乘 3（夹到的是三个分量之和）',
    inject: { file: 'path/src/main.rs', from: 'let times3 = |v: f32| if v == 0.0 { 0.0 } else { v * 3.0 };', to: 'let times3 = |v: f32| if v == 0.0 { 0.0 } else { v };' },
    run: bin => clampCases(bin, ['mirrorDirectWhite', 'mirrorDirectColored']).cases,
  },
  {
    name: '夹取：背景的弹射数没减 1（单面镜里的天空当成了间接光）',
    inject: { file: 'path/shaders/integrator.wgsl', from: '@if(sample_clamp) c = film_clamp_contribution(c, i32(depth) - 1);\n            if (depth == 0u) { e0 += c; }\n            if (depth == 1u && spec_lobe) { spec_t = 1.0e4; }', to: '@if(sample_clamp) c = film_clamp_contribution(c, i32(depth));\n            if (depth == 0u) { e0 += c; }\n            if (depth == 1u && spec_lobe) { spec_t = 1.0e4; }' },
    run: bin => clampCases(bin, ['mirrorDirectWhite', 'mirrorIndirect']).cases,
  },
  {
    name: '夹取：按最大分量而不是三个分量之和比上限',
    inject: { file: 'shaders/imaging.wgsl', from: 'let sum = a.x + a.y + a.z;', to: 'let sum = max(a.x, max(a.y, a.z));' },
    run: bin => clampCases(bin, ['mirrorDirectColored']).cases,
  },
  {
    name: '滤光泽：内核里再取一次倒数（全局参数里已经是 1 / blur_glossy）',
    inject: { file: 'path/shaders/closure.wgsl', from: 'filter_glossy_roughness(P.integrator.filter_glossy, state.min_ray_pdf)', to: 'filter_glossy_roughness(1.0 / P.integrator.filter_glossy, state.min_ray_pdf)' },
    run: bin => glossyCases(bin, ['on']),
  },
];

/** 一项读数的一句话：逐通道读数对手算值，或逐位比的结果 */
export function reading(r) {
  if (r.worst) return `最差一列 ${r.worst.z.toFixed(1)} 个标准误`;
  if (r.ours) return `${r.ours.mean.toPrecision(6)}（标准误 ${r.ours.se.toExponential(2)}）对 Cycles ${r.cycles.mean.toPrecision(6)}（${r.cycles.se.toExponential(2)}），${r.z.toFixed(2)} 个合并标准误`;
  if (r.zCycles !== undefined) return `开与关之差：Cycles ${r.zCycles.toFixed(1)}、北冥 ${r.zOurs.toFixed(1)} 个合并标准误`;
  if (!r.channels) return r.ok ? '逐位相同' : `不逐位相同（最大差 ${r.diff.toExponential(2)}）`;
  return r.channels.map(c => `${c.mean.toPrecision(9)} 对 ${c.expected.toPrecision(9)}（${c.z === null ? `标准误 0，相对差 ${c.rel.toExponential(2)}` : `${c.z.toFixed(2)} 个标准误`}）`).join('，');
}

/** 跑完成像一路的第 2 级，返回报告（ok 为全部过） */
export async function runImaging({ negatives = true, log = () => {} } = {}) {
  const t0 = Date.now();
  const say = s => log(`[${((Date.now() - t0) / 1000).toFixed(0)} s] ${s}`);
  say('构建：从 beiming/sources/core/path/ 编 core-render');
  const { bin } = buildRenderer();
  const info = spawnSync(bin, ['info'], { encoding: 'utf8' });
  if (info.status !== 0) throw missing(`core-render info 没跑起来（拿不到显卡？）：${(info.stderr || String(info.error)).trim().split('\n').slice(-3).join(' ')}`);
  const gpu = JSON.parse(info.stdout);
  say('像素滤波：刀口');
  const knife = KNIFE_CASES.map(([k, w]) => knifeCase(bin, k, w));
  say('夹取');
  const clamp = clampCases(bin);
  say('滤光泽');
  const glossy = glossyCases(bin);
  say('逐位相同的三项');
  const bitwise = bitwiseCases(bin);
  const negative = [];
  if (negatives) {
    for (const n of NEGATIVE) {
      say(`负对照：${n.name}`);
      const rows = n.run(buildRenderer({ inject: [n.inject] }).bin, bin);
      negative.push({ name: n.name, rows: rows.map(r => ({ name: r.name, ok: r.ok, reading: reading(r) })), caught: rows.every(r => !r.ok) });
    }
  }
  const geometry = { mirror: geometryOk(clamp.geometry.mirror, 1), corner: geometryOk(clamp.geometry.corner, 2) };
  const ok = knife.every(c => c.ok) && geometry.mirror && geometry.corner && clamp.cases.every(c => c.ok) && glossy.every(c => c.ok) && bitwise.every(c => c.ok) && negative.every(n => n.caught);
  return { ok, adapter: gpu.adapter, backend: gpu.backend, gates: GATES, knife, geometry, clamp, glossy, bitwise, negative };
}

export const command = defineCommand({
  name: 'chassis-imaging',
  summary: '成像一路的第 2 级：像素滤波的刀口剖面对解析式、Cycles 口径的夹取对手算值、滤光泽对 Cycles、负对照',
  usage: ['node beiming/sources/core/chassis/imaging.mjs [--out 报告.json] [--no-negatives]'],
  options: {
    out: { type: 'string', arg: '<文件>', describe: '报告写到这里（JSON）' },
    'no-negatives': { type: 'boolean', describe: '不跑负对照（每项要另编一次渲染程序）' },
  },
  exitCodes: { 0: '全部过', 2: '用法错误', 3: '缺工具链', 4: '有一项不过' },
  async run(ctx) {
    let report;
    try {
      report = await runImaging({ negatives: !ctx.opts['no-negatives'], log: s => ctx.out(s) });
    } catch (e) {
      if (e.missing) throw new CliError('env.chassis-toolchain', `缺工具链：${e.missing}`, '要 cargo 与能拿到显卡的环境');
      throw e;
    }
    for (const c of report.knife) ctx.out(`${c.ok ? '✓' : '✗'} 刀口 ${c.name.padEnd(22)} 平台 ${c.plateau.toFixed(6)}  最差一列 ${c.worst.column}：${c.worst.mean.toFixed(6)} 对 ${c.worst.expected.toFixed(6)}，${c.worst.z.toFixed(2)} 个标准误（标准误 ${c.worst.se.toExponential(2)}）；对连续滤波函数最差第 ${c.continuousWorst.column} 列 ${c.continuousWorst.z.toFixed(2)} 个标准误（只记录）`);
    for (const [k, want] of [['mirror', 1], ['corner', 2]]) ctx.out(`${report.geometry[k] ? '✓' : '✗'} 几何 ${k === 'mirror' ? '单面镜' : '直角反射器'}：视锥上 ${JSON.stringify(report.clamp.geometry[k].count)}（反射次数: 条数，应只有 ${want}），离开时朝下 ${report.clamp.geometry[k].down} 条`);
    for (const c of report.clamp.cases) ctx.out(`${c.ok ? '✓' : '✗'} 夹取 ${c.name}：${reading(c)}`);
    for (const c of report.glossy) ctx.out(`${c.ok ? '✓' : '✗'} ${c.name}：${reading(c)}`);
    for (const c of report.bitwise) ctx.out(`${c.ok ? '✓' : '✗'} 逐位相同 ${c.name}`);
    for (const n of report.negative) ctx.out(`${n.caught ? '✓' : '✗'} 负对照 ${n.name}：${n.rows.map(r => `${r.name} ${r.ok ? '过' : '不过'}（${r.reading}）`).join('；')}`);
    if (ctx.opts.out) fs.writeFileSync(ctx.opts.out, `${JSON.stringify(report, null, 2)}\n`);
    return { data: report, ...(!report.ok && { error: { code: 'contract.chassis-imaging', message: '成像一路的第 2 级有一项不过', hint: '逐项见上' } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
