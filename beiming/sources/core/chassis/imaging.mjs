#!/usr/bin/env node
// 北冥 · 成像一路的第 2 级：像素滤波与 Cycles 口径的夹取接进内核（core-render render-pack）后渲图对解析值。
//   像素滤波：刀口场景（半平面黑白分界）在三种滤波、两种宽度下出图，沿分界的剖面（把每一列像素平均）对「Cycles 的滤波表
//   给出的分布与刀口的卷积」（tableExpected），每一列的差不超过 4 个标准误；对连续滤波函数的卷积（knifeExpected）只记录不判：
//   Cycles 的表在尾巴上有离散化（util/math_cdf.cpp 对称的一支、scene/film.cpp 表的最后一格为 0），约 0.3% 的样本不照连续
//   滤波函数分布，标准答案是 Cycles 的表。盒式宽 1 不查表（子像素均匀抖动），对连续盒式判；与不加参数逐位相同。
//   夹取：相机直接看天空（直接光）、两面镜子拼的直角反射器里看两次反射之后的天空（间接光），上限低于真值时读数等于照 Cycles
//   的式子手算的值（±3 个标准误）；上限为 0 时与不设逐位相同。
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
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { PRESETS, buildRenderer, missing } from './build.mjs';
import { IDENTITY, translate, writePack } from './scenepack.mjs';

export const GATES = { knifeSE: 4, clampSE: 3 };

const UNITS = { meter: 1, up: 'Y', hand: 'right' };
const SOURCE = { exporter: 'chassis/imaging@0.1', blender: '5.2.3', sha256: '0'.repeat(64) };
// 镜面：金属度 1、粗糙度 0（内核给纯金属带着上游的 0.02 下限）、底色白，F82 的边缘色默认白，反射率处处是 1
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
// 平台（镜面一侧的读数，不是恰好 1：两次 GGX 的能量损失与环境光的多重重要性采样）取 plateau 那几列的均值：分界减 0.5 再减
// 最宽的支撑半宽（高斯宽 3 的 4.5）之后还在左边的列，每个样本都落在镜面上。
export const KNIFE = { w: 32, h: 128, spp: 256, tan: 0.5, cam: 3, edge: 16.3, plateau: [0, 11] };
const knifePixel = () => (2 * KNIFE.cam * KNIFE.tan * (KNIFE.w / KNIFE.h)) / KNIFE.w;
export function knifePack() {
  const X0 = (KNIFE.edge - KNIFE.w / 2) * knifePixel();
  return pack('pack:chassis-knife@1', [quad('plate', [[-50, -50, 0], [X0, -50, 0], [X0, 50, 0], [-50, 50, 0]], [0, 0, 1])], { world: [1, 1, 1], visible: false, cam: [0, 0, KNIFE.cam], fovY: 2 * Math.atan(KNIFE.tan) });
}

// 夹取，直接光：相机直接看白色天空（亮度 1；画面外放一块镜子凑足几何）。Cycles 里相机射线打到背景的弹射数减 1 是 −1，用直接光的上限
export const SKY = { w: 16, h: 16, spp: 16 };
export function skyPack() {
  return pack('pack:chassis-sky@1', [quad('behind', [[-1, -1, 10], [1, -1, 10], [1, 1, 10], [-1, 1, 10]], [0, 0, 1])], { world: [1, 1, 1], visible: true, cam: [0, 0, 3], fovY: 0.3 });
}
// 夹取，间接光：两面镜子沿 y 轴拼成开口朝 +z 的直角（棱在原点），相机在 (0, 0, 5) 朝 -z 看进去：每条相机射线在两面镜子上各反射一次，
// 原路方向退回去打到白色天空（亮度 1）。打到天空时路径上已有两次弹射，Cycles 的弹射数减 1 是 1，用间接光的上限
export const CORNER = { w: 32, h: 32, spp: 64 };
export function cornerPack() {
  const L = 2, Y = 5, s = Math.SQRT1_2;
  return pack('pack:chassis-corner@1', [
    quad('a', [[-L, -Y, L], [0, -Y, 0], [0, Y, 0], [-L, Y, L]], [s, 0, s]),
    quad('b', [[0, -Y, 0], [L, -Y, L], [L, Y, L], [0, Y, 0]], [-s, 0, s]),
  ], { world: [1, 1, 1], visible: true, cam: [-0.4, 0, 5], fovY: 2 * Math.atan(0.03) });
}

// ---------------------------------------------------------------------------------------------------------------
// 渲染

let tmp = null;
const work = () => tmp ?? (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-imaging-')));
process.on('exit', () => tmp && fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

/** 写包、渲一帧，返回 { hdr: Float32Array（RGB，行主序）, bytes: Buffer }；args 是 render-pack 的额外参数 */
export function render(bin, spec, { w, h, spp }, args = []) {
  const dir = path.join(work(), `p${seq++}`), out = path.join(work(), `r${seq++}.raw`);
  writePack(dir, spec);
  const r = spawnSync(bin, ['render-pack', dir, '-o', path.join(work(), 'out.png'), '--hdr', out, '--spp', String(spp), '--width', String(w), '--height', String(h), '--no-denoise', '--presets', PRESETS, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
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
      p += (b > a ? Math.min(1, Math.max(0, (cut - a) / (b - a))) : (a < cut ? 1 : 0)) / 1023;
    }
    return plateau * p;
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

/** 一项夹取的读数：全画面像素均值与标准误（像素之间独立），对手算值的标准误倍数 */
function clampCase(bin, name, spec, size, args, expected) {
  const { hdr } = render(bin, spec, size, args);
  const px = Array.from({ length: size.w * size.h }, (_, i) => pixel(hdr, i));
  const { mean, se } = meanSe(px);
  const exp = typeof expected === 'function' ? expected() : expected;
  const z = se > 0 ? (mean - exp) / se : (mean === exp ? 0 : Infinity);
  return { name, args, mean, se, expected: exp, z, ok: Math.abs(z) <= GATES.clampSE };
}

/** 夹取的几项：直接光夹到 0.5、间接光的上限不碰直接光；间接光夹到 0.2、直接光的上限不碰间接光；上限为 0 与不设逐位相同 */
export function clampCases(bin) {
  const sky = skyPack(), corner = cornerPack();
  const plain = render(bin, corner, CORNER).hdr;
  const free = meanSe(Array.from({ length: CORNER.w * CORNER.h }, (_, i) => pixel(plain, i)));
  return {
    // 不夹时两次反射之后的读数（两面镜子 GGX 的能量损失，只作记录）
    cornerFree: free,
    cases: [
      clampCase(bin, '直接光夹到 0.5（相机直接看天空）', sky, SKY, ['--clamp-direct', '0.5'], 0.5),
      clampCase(bin, '间接光的上限不碰直接光', sky, SKY, ['--clamp-indirect', '0.1'], 1),
      clampCase(bin, '间接光夹到 0.2（两次反射之后的天空）', corner, CORNER, ['--clamp-indirect', '0.2'], 0.2),
      clampCase(bin, '直接光的上限不碰间接光', corner, CORNER, ['--clamp-direct', '0.1'], free.mean),
    ],
  };
}

/** 上限给 0、盒式宽 1 显式给出：与不加参数逐位相同 */
export function bitwiseCases(bin) {
  const knife = knifePack(), corner = cornerPack();
  const same = (spec, size, args) => render(bin, spec, size, args).bytes.equals(render(bin, spec, size).bytes);
  return [
    { name: '盒式宽 1 显式给出', ok: same(knife, KNIFE, ['--pixel-filter', 'box', '--filter-width', '1']) },
    { name: '两个夹取上限给 0', ok: same(corner, CORNER, ['--clamp-direct', '0', '--clamp-indirect', '0']) },
  ];
}

export const KNIFE_CASES = [['box', 1], ['box', 1.5], ['box', 3], ['gaussian', 1.5], ['gaussian', 3], ['blackman-harris', 1.5], ['blackman-harris', 3]];

// 负对照（build.mjs 的 inject；file 相对 beiming/sources/core/，工作树不动）：每项改错一处，对应的一项必须不过
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
    run: bin => clampCases(bin).cases.slice(0, 1),
  },
  {
    name: '夹取：发光与背景的弹射数没减 1（相机看到的天空当成了间接光）',
    inject: { file: 'path/shaders/integrator.wgsl', from: '@if(sample_clamp) c = film_clamp_contribution(c, i32(depth) - 1);\n            if (depth == 0u) { e0 += c; }\n            if (depth == 1u && spec_lobe) { spec_t = 1.0e4; }', to: '@if(sample_clamp) c = film_clamp_contribution(c, i32(depth));\n            if (depth == 0u) { e0 += c; }\n            if (depth == 1u && spec_lobe) { spec_t = 1.0e4; }' },
    run: bin => clampCases(bin).cases.slice(1, 3),
  },
];

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
  say('逐位相同的两项');
  const bitwise = bitwiseCases(bin);
  const negative = [];
  if (negatives) {
    for (const n of NEGATIVE) {
      say(`负对照：${n.name}`);
      const rows = n.run(buildRenderer({ inject: [n.inject] }).bin, bin);
      negative.push({ name: n.name, rows: rows.map(r => ({ name: r.name, z: r.z ?? r.worst.z, ok: r.ok })), caught: rows.some(r => !r.ok) });
    }
  }
  const ok = knife.every(c => c.ok) && clamp.cases.every(c => c.ok) && bitwise.every(c => c.ok) && negative.every(n => n.caught);
  return { ok, adapter: gpu.adapter, backend: gpu.backend, gates: GATES, knife, clamp, bitwise, negative };
}

export const command = defineCommand({
  name: 'chassis-imaging',
  summary: '成像一路的第 2 级：像素滤波的刀口剖面对解析式、Cycles 口径的夹取对手算值、负对照',
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
    ctx.out(`  不夹时直角反射器的读数 ${report.clamp.cornerFree.mean.toFixed(6)} ± ${report.clamp.cornerFree.se.toExponential(2)}`);
    for (const c of report.clamp.cases) ctx.out(`${c.ok ? '✓' : '✗'} 夹取 ${c.name}：${c.mean.toPrecision(9)} 对 ${c.expected.toPrecision(9)}，${c.z.toFixed(2)} 个标准误（标准误 ${c.se.toExponential(2)}）`);
    for (const c of report.bitwise) ctx.out(`${c.ok ? '✓' : '✗'} 逐位相同 ${c.name}`);
    for (const n of report.negative) ctx.out(`${n.caught ? '✓' : '✗'} 负对照 ${n.name}：${n.rows.map(r => `${r.name} ${r.ok ? '过' : '不过'}（${Number(r.z).toFixed(1)}）`).join('，')}`);
    if (ctx.opts.out) fs.writeFileSync(ctx.opts.out, `${JSON.stringify(report, null, 2)}\n`);
    return { data: report, ...(!report.ok && { error: { code: 'contract.chassis-imaging', message: '成像一路的第 2 级有一项不过', hint: '逐项见上' } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
