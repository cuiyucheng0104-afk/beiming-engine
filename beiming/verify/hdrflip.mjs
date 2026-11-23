// HDR-FLIP 多档曝光感知误差（metric:image.hdrflip）：两张线性 sRGB 原色的 HDR 图，按参考图亮度定曝光区间，
// 每档做曝光缩放、ACES 色调映射、钳到 [0,1] 后跑 LDR-FLIP（视觉对比敏感度滤波后的 Hunt 修正 HyAB 色差，
// 再用边缘与点特征差放大），逐像素取各档最大值。0 是没有可见差异，1 是最大差异。
// 数值口径对齐 NVIDIA flip-evaluator 1.7（含参考图中位亮度为 0 时把中位数抬到单精度机器精度的分支）。
//
// 来源：算法出自 Andersson 等「FLIP: A Difference Evaluator for Alternating Images」（HPG 2020）与
// 「Visualizing Errors in Rendered High Dynamic Range Images」（Eurographics 2021 短文）。常数、滤波核与
// 曝光区间算法照 NVlabs/flip 的参考实现（FLIP.h，v1.7）用 JavaScript 重写，按其 BSD-3-Clause 许可使用，
// 保留下面的版权声明、条件与免责声明；其余部分（输入读取、统计与返回结构）为本项目原创。
// SPDX-License-Identifier: MIT AND BSD-3-Clause
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-FileCopyrightText: Copyright (c) 2020-2025 NVIDIA CORPORATION & AFFILIATES
//
// Copyright (c) 2020-2025, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
// list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
// this list of conditions and the following disclaimer in the documentation
// and/or other materials provided with the distribution.
//
// 3. Neither the name of the copyright holder nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
import { readFileSync } from 'node:fs';
import { readExr } from './exr/exr.mjs';

// 0.7 米外看 0.7 米宽、3840 像素的显示器，每度视角的像素数（单精度值 67.02064514160156）。
const DEFAULT_PPD = Math.fround(3840 * Math.PI / 180);
const FLT_EPSILON = 2 ** -23;
// ACES 拟合曲线 (c²·t0 + c·t1 + t2) / (c²·t3 + c·t4 + t5)，0.6 是预乘的曝光因子。
const ACES = [0.6 * 0.6 * 2.51, 0.6 * 0.03, 0, 0.6 * 0.6 * 2.43, 0.6 * 0.59, 0.14];
// 线性 sRGB 到 XYZ（D65）及其逆，白点是正矩阵各行之和。
const TO_XYZ = [
  10135552 / 24577794, 8788810 / 24577794, 4435075 / 24577794,
  2613072 / 12288897, 8788810 / 12288897, 887015 / 12288897,
  1425312 / 73733382, 8788810 / 73733382, 70074185 / 73733382,
];
const TO_RGB = [
  3.241003275, -1.537398934, -0.498615861,
  -0.969224334, 1.875930071, 0.041554224,
  0.055639423, -0.204011202, 1.057148933,
];
const WHITE_X = TO_XYZ[0] + TO_XYZ[1] + TO_XYZ[2];
const WHITE_Z = TO_XYZ[6] + TO_XYZ[7] + TO_XYZ[8];
// 色差指数、重映射拐点（占最大色差的比例与映射到的值）、特征核宽度（度）、特征差指数。
const GQC = 0.7, GPC = 0.4, GPT = 0.95, GW = 0.082, GQF = 0.5;

function check(ok, message) { if (!ok) throw new RangeError(`hdrFlip: ${message}`); }
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const sum = (k) => k.reduce((s, v) => s + v, 0);

// 读成交错的线性 RGB（负值钳到 0）。EXR 取 color.R/G/B，没有就取 R/G/B。
function load(input, label) {
  if (typeof input === 'string') {
    check(input.length > 0, `${label} 文件路径不能为空`);
    input = readFileSync(input);
  }
  let width, height, planes, data, channels;
  if (input instanceof Uint8Array) {
    const exr = readExr(input);
    ({ width, height } = exr);
    check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0, `${label} 的 EXR 尺寸无效`);
    planes = ['R', 'G', 'B'].map((c) => exr.channels[`color.${c}`] ?? exr.channels[c]);
    check(planes.every((p) => p instanceof Float32Array && p.length === width * height), `${label} 的 EXR 缺少浮点 color.R/G/B 或 R/G/B 通道`);
  } else {
    check(input !== null && typeof input === 'object', `${label} 必须是 { width, height, data } 或 EXR 字节、文件路径`);
    ({ width, height, data, channels = 3 } = input);
    check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0, `${label} 尺寸无效`);
    check(channels === 3 || channels === 4, `${label} 的 channels 只能是 3 或 4`);
    check(data instanceof Float32Array && data.length === width * height * channels, `${label} 的 data 必须是长度为 width × height × channels 的 Float32Array`);
  }
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    const v = planes ? planes[c][i] : data[i * channels + c];
    // 非有限值会让整张误差图变成 NaN，而 NaN 与任何阈值比较都不成立，门会被悄悄放过。
    check(Number.isFinite(v), `${label} 含非有限值（像素 ${i}）`);
    rgb[i * 3 + c] = Math.max(v, 0);
  }
  return { width, height, rgb };
}

// 曝光区间：最亮处刚好映射到 0.85 的那一档是起点，中位亮度映射到 0.85 的那一档是终点。
function exposureRange(rgb, n) {
  const t = 0.85;
  const a = ACES[0] - t * ACES[3], b = ACES[1] - t * ACES[4], c = ACES[2] - t * ACES[5];
  const d1 = -0.5 * b / a;
  const xMax = d1 + Math.sqrt(d1 * d1 - c / a);
  const luminance = new Float32Array(n);
  for (let i = 0; i < n; i++) luminance[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  luminance.sort();
  // 中位数取排序后第 n/2 个（偶数个时是偏上的那个），为 0 时抬到机器精度，都与 v1.7 一致。
  const yMedian = Math.max(luminance[n >> 1], FLT_EPSILON);
  // 最亮值低于机器精度（全黑参考图）时官方报错退出；这里同样抬到机器精度，区间退化成一档，相同的两张图仍得 0。
  const yMax = Math.max(luminance[n - 1], FLT_EPSILON);
  const startExposure = Math.fround(Math.log2(xMax / yMax));
  const stopExposure = Math.fround(Math.log2(xMax / yMedian));
  return { startExposure, stopExposure, numExposures: Math.max(2, Math.ceil(stopExposure - startExposure)) };
}

function kernels(ppd) {
  // 对比敏感度滤波：空间域高斯 a·√(π/b)·exp(-π²x²/b)，半径取最宽那个（b = 0.04）的三倍标准差。
  const r = Math.ceil(3 * Math.sqrt(0.04 / (2 * Math.PI ** 2)) * ppd);
  const csf = (a, b) => Float64Array.from({ length: 2 * r + 1 }, (_, i) => Math.sqrt(a * Math.sqrt(Math.PI / b)) * Math.exp(-((Math.PI * (i - r) / ppd) ** 2) / b));
  const unit = (k) => k.map((v) => v / sum(k));
  // 蓝黄通道是两个高斯之和，拆成两次可分离卷积，二维总和归一到 1。
  const z1 = csf(34.1, 0.04), z2 = csf(13.5, 0.025);
  const zNorm = Math.hypot(sum(z1), sum(z2));
  // 特征检测：高斯及其一阶、二阶导数；导数核的正权与负权各自归一到 1 与 -1。
  const sd = 0.5 * GW * ppd;
  const fr = Math.ceil(3 * sd);
  const g = Float64Array.from({ length: 2 * fr + 1 }, (_, i) => (i === fr ? 1 : Math.exp(-((i - fr) ** 2) / (2 * sd * sd))));
  const signed = (k) => {
    const positive = sum(k.filter((v) => v > 0)), negative = -sum(k.filter((v) => v < 0));
    return k.map((v) => (v > 0 ? v / positive : v < 0 ? v / negative : 0));
  };
  return {
    y: unit(csf(1, 0.0047)), cx: unit(csf(1, 0.0053)), z1: z1.map((v) => v / zNorm), z2: z2.map((v) => v / zNorm),
    g: unit(g), dg: signed(g.map((v, i) => -(i - fr) * v)),
    ddg: signed(g.map((v, i) => (i === fr ? -1 : v === 0 ? 0 : ((i - fr) ** 2 / (sd * sd) - 1) * v))),
  };
}

// 可分离卷积，先横后竖，越界取边缘像素。累加用双精度：官方用单精度，大面积纯色差异处它的舍入残差
// 经特征项开方放大，逐像素会与这里差到 6e-5 量级（实测），有纹理的图差在 1e-5 以内。
// shortcut: 每张图每档做 8 次互不共用的卷积，960×540 实测每档约 1 秒；要进逐帧批量门时合并共用的横向遍。
function convolve(src, w, h, kx, ky) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const rx = kx.length >> 1, ry = ky.length >> 1;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    let s = 0;
    for (let k = -rx; k <= rx; k++) s += kx[k + rx] * src[y * w + Math.min(Math.max(x + k, 0), w - 1)];
    tmp[i] = s;
  }
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    let s = 0;
    for (let k = -ry; k <= ry; k++) s += ky[k + ry] * tmp[Math.min(Math.max(y + k, 0), h - 1) * w + x];
    out[i] = s;
  }
  return out;
}

// 线性 RGB 到 Hunt 修正的 L*a*b*（色度按明度缩放），写进三个平面的第 i 格。
const DELTA = 6 / 29;
const labCurve = (t) => (t > DELTA ** 3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29);
function huntLab(r, g, b, L, A, B, i) {
  const fx = labCurve((TO_XYZ[0] * r + TO_XYZ[1] * g + TO_XYZ[2] * b) / WHITE_X);
  const fy = labCurve(TO_XYZ[3] * r + TO_XYZ[4] * g + TO_XYZ[5] * b);
  const fz = labCurve((TO_XYZ[6] * r + TO_XYZ[7] * g + TO_XYZ[8] * b) / WHITE_Z);
  L[i] = 116 * fy - 16;
  A[i] = 500 * (fx - fy) * 0.01 * L[i];
  B[i] = 200 * (fy - fz) * 0.01 * L[i];
}
const hyab = (L, A, B, i, L2, A2, B2, j) => Math.abs(L[i] - L2[j]) + Math.hypot(A[i] - A2[j], B[i] - B2[j]);

// 最大色差取纯绿对纯蓝。
const CMAX = (() => {
  const L = new Float64Array(2), A = new Float64Array(2), B = new Float64Array(2);
  huntLab(0, 1, 0, L, A, B, 0);
  huntLab(0, 0, 1, L, A, B, 1);
  return hyab(L, A, B, 0, L, A, B, 1) ** GQC;
})();

// 一张图在一档曝光下的感知表示：滤波后的 Hunt 修正 L*a*b*，以及边缘、点特征强度。
function perceive(rgb, w, h, gain, K) {
  const n = w * h;
  const Y = new Float32Array(n), Cx = new Float32Array(n), Cz = new Float32Array(n);
  const tone = (v) => { const c = v * gain; return clamp01((c * c * ACES[0] + c * ACES[1] + ACES[2]) / (c * c * ACES[3] + c * ACES[4] + ACES[5])); };
  for (let i = 0; i < n; i++) {
    const r = tone(rgb[i * 3]), g = tone(rgb[i * 3 + 1]), b = tone(rgb[i * 3 + 2]);
    const x = (TO_XYZ[0] * r + TO_XYZ[1] * g + TO_XYZ[2] * b) / WHITE_X;
    const y = TO_XYZ[3] * r + TO_XYZ[4] * g + TO_XYZ[5] * b;
    const z = (TO_XYZ[6] * r + TO_XYZ[7] * g + TO_XYZ[8] * b) / WHITE_Z;
    Y[i] = y; // 特征检测用归一到 [0,1] 的亮度，即 (116y - 16 + 16) / 116
    Cx[i] = 500 * (x - y);
    Cz[i] = 200 * (y - z);
  }
  // 亮度通道的对立色表示是 116y - 16；滤波核和为 1，直接对 y 滤波再换算，结果相同。
  const fY = convolve(Y, w, h, K.y, K.y), fCx = convolve(Cx, w, h, K.cx, K.cx);
  const fZ1 = convolve(Cz, w, h, K.z1, K.z1), fZ2 = convolve(Cz, w, h, K.z2, K.z2);
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = fY[i], x = (y + fCx[i] / 500) * WHITE_X, z = (y - (fZ1[i] + fZ2[i]) / 200) * WHITE_Z;
    huntLab(
      clamp01(TO_RGB[0] * x + TO_RGB[1] * y + TO_RGB[2] * z),
      clamp01(TO_RGB[3] * x + TO_RGB[4] * y + TO_RGB[5] * z),
      clamp01(TO_RGB[6] * x + TO_RGB[7] * y + TO_RGB[8] * z), L, A, B, i,
    );
  }
  const dx = convolve(Y, w, h, K.dg, K.g), dy = convolve(Y, w, h, K.g, K.dg);
  const ddx = convolve(Y, w, h, K.ddg, K.g), ddy = convolve(Y, w, h, K.g, K.ddg);
  const edge = dx.map((v, i) => Math.hypot(v, dy[i])), point = ddx.map((v, i) => Math.hypot(v, ddy[i]));
  return { L, A, B, edge, point };
}

/**
 * HDR-FLIP。reference 与 test 是 { width, height, data: Float32Array, channels?: 3 | 4 }（交错的线性 sRGB 原色，
 * 第四通道忽略），或 EXR 的字节（Uint8Array / Buffer）、文件路径。曝光区间只由 reference 决定，所以两个参数不可互换。
 * 返回平均值 value、逐像素误差图 errorMap（从上到下、从左到右）与 details 里的曝光区间和分位数。
 */
export function hdrFlip(reference, test, options = {}) {
  check(options !== null && typeof options === 'object' && !Array.isArray(options), 'options 必须是对象');
  const { ppd = DEFAULT_PPD, tonemapper = 'aces' } = options;
  check(Number.isFinite(ppd) && ppd > 0, 'ppd 必须是正数');
  check(tonemapper === 'aces', `只支持 tonemapper 'aces'，收到 ${JSON.stringify(tonemapper)}`);
  const ref = load(reference, 'reference'), tst = load(test, 'test');
  const { width: w, height: h } = ref, n = w * h;
  check(tst.width === w && tst.height === h, `两张图尺寸不同：${w}×${h} 对 ${tst.width}×${tst.height}`);
  const { startExposure, stopExposure, numExposures } = exposureRange(ref.rgb, n);
  const K = kernels(ppd);
  const knee = GPC * CMAX;
  const step = (stopExposure - startExposure) / (numExposures - 1);
  const errorMap = new Float32Array(n);
  for (let e = 0; e < numExposures; e++) {
    const gain = 2 ** (startExposure + e * step);
    const p = perceive(ref.rgb, w, h, gain, K), q = perceive(tst.rgb, w, h, gain, K);
    for (let i = 0; i < n; i++) {
      // 色差重映射到 [0,1]：拐点以下线性压到 [0, GPT]，以上压到 (GPT, 1]。
      let color = hyab(p.L, p.A, p.B, i, q.L, q.A, q.B, i) ** GQC;
      color = color < knee ? color * GPT / knee : GPT + (color - knee) / (CMAX - knee) * (1 - GPT);
      const feature = (Math.SQRT1_2 * Math.max(Math.abs(p.edge[i] - q.edge[i]), Math.abs(p.point[i] - q.point[i]))) ** GQF;
      errorMap[i] = Math.max(errorMap[i], color ** (1 - feature));
    }
  }
  // 均值按行主序用单精度累加再除以单精度像素数，与 v1.7 FLIP.h 一致（百万像素级图像上单双精度累加可差到 1e-3）。
  let total = 0;
  for (let i = 0; i < n; i++) total = Math.fround(total + errorMap[i]);
  const value = Math.fround(total / Math.fround(n));
  const sorted = Float32Array.from(errorMap).sort();
  const quantile = (f) => sorted[Math.max(Math.ceil(f * n) - 1, 0)]; // 最近秩
  return {
    metric: 'metric:image.hdrflip', unit: 'flip', value,
    details: { ppd, tonemapper, startExposure, stopExposure, numExposures, min: sorted[0], max: sorted[n - 1], p50: quantile(0.5), p95: quantile(0.95) },
    errorMap,
  };
}
