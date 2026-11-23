// 北冥引擎 · 编号图与后期回归的冻结 r170 金标准：不随待测的 engine/look 重生的那一份参照（Node 侧，回归夹具，不是 engine 的公开模块）。
// 对拍执行器两边跑的是同一份 engine/look，两版一起漂移时互比照样全等；这里把改动前（基线提交）的 r170 结果存进
// r187-look-regression.golden.json，每次对拍都拿当前代码的 r170 结果去比它：
//   shaders  标定场景这一趟在 r170 下交给 WebGL 编译的全部着色器源码（three 展开 #include、加完前缀之后的最终文本）各自的 SHA-256，
//            逐字节比：画面上看不出的 GLSL 改动也拦（只和 three 版本、渲染器设置、engine 源码有关，不随显卡变）
//   thumbs   逐级画面各一张 16 × 12 的缩略图：每块 40 × 40 像素的 RGB 均值，外加一个「粗糙度」（块内绿色通道相邻像素差的平均值 × 8）。
//            均值管颜色、雾、暗角、线的位置；粗糙度管均值看不出的高频（颗粒、纸纹、笔触）。THUMB_SKIP 里的三张离散缓冲不存缩略图
//   ids      ID 图里每个编号占的像素数。编号本身是离散值，冻结的编号必须都在、不能多；像素数留容差（不同显卡在物体边缘上差几个像素）
//
//   decodeIds(px16) → { id, lo, hi, width, alpha }   ids.js 的半浮点 RGBA（id 低 11 位, id 高位, 线宽系数, 可见度）→ 每像素的整数编号（lo + hi × 2048）与四个通道的原值；
//                         NaN / Infinity 照原样解出来，由调用方判（r187-look-regression.mjs 的 compareIdMaps / idCensus）
//   idAreas(px16) → { 编号: 像素数 }          0（没有描边物体）不算
//   thumb(rgba) → Uint8Array                  一张 W × H 画面的缩略图（每块 4 字节：R、G、B 均值与粗糙度）
//   thumbDiff(a, b) → { maxBlockDiff, meanBlockDiff, maxRoughDiff, meanRoughDiff, pass }   均值按 RGB 里最差的一个通道算
//   shaderDigests(sources) → 排好序的 SHA-256 列表
//   checkGolden(base, sources) → { baseline, backend, gate, shaders, shadersChanged: { added, removed }, frames: [{ id, …thumbDiff }], ids: [{ id, frozen, now, pass }], pass }
//                         base = r170 这次读回的 { id, <各级画面> }，sources = r170 这一趟的着色器源码
//   freezeGolden(base, sources, { baseline, backend })   重写 golden.json。只在有意改画面、按 docs/style-baselines/POLICY.md 审批之后才重冻
import fs from 'node:fs';
import { Buffer } from 'node:buffer';   // eslint 把 engine/ 下的 .mjs 当浏览器端，Node 全局显式导入
import { createHash } from 'node:crypto';
import { W, H, STAGES } from './r187-look-regression.scene.mjs';

const FILE = new URL('./r187-look-regression.golden.json', import.meta.url);
const TW = 16, TH = 12, BW = W / TW, BH = H / TH, ROUGH_GAIN = 8;
// 容差按实测定。同一份代码换后端（macOS Metal 对 SwiftShader）：均值最大差 1 级、平均不到 0.28 级，粗糙度最大差 3、平均不到 0.22；
// 只关一道后期时至少有一项远超容差（关颗粒：粗糙度平均 5；关 Kuwahara：粗糙度最大 32、平均 0.95；关 bloom：均值最大 24）
export const THUMB_GATE = { maxBlockDiff: 4, meanBlockDiff: 0.6, maxRoughDiff: 8, meanRoughDiff: 0.6 };
export const ID_AREA_GATE = { pixels: 24, ratio: 0.04 };   // 每个编号的像素数：差不超过 24 个或 4%（取大的）；Metal 对 SwiftShader 实测差 1 到 2 个像素
// 离散的 ID / 深度 / 边缘视图不存缩略图：物体边缘差一个像素块差就很大（Metal 对 SwiftShader 实测粗糙度差到 50）；
// ID 由上面的编号像素数管，深度与边缘的结果落在墨线（view-line、solo-outline）里
export const THUMB_SKIP = ['view-id', 'view-depth', 'view-edge'];
const THUMBED = STAGES.filter(s => !THUMB_SKIP.includes(s.id));

const half = h => { const e = (h >> 10) & 31, m = h & 1023; return (h & 0x8000 ? -1 : 1) * (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15)); };
export function decodeIds(px) {
  const n = px.length / 4, id = new Float64Array(n), lo = new Float32Array(n), hi = new Float32Array(n), width = new Float32Array(n), alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) { lo[i] = half(px[i * 4]); hi[i] = half(px[i * 4 + 1]); id[i] = lo[i] + hi[i] * 2048; width[i] = half(px[i * 4 + 2]); alpha[i] = half(px[i * 4 + 3]); }
  return { id, lo, hi, width, alpha };
}
export function idAreas(px) {
  const out = {}, { id } = decodeIds(px);
  for (const v of id) if (v !== 0 && Number.isFinite(v)) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function thumb(rgba) {
  const out = new Uint8Array(TW * TH * 4), n = BW * BH;
  for (let by = 0; by < TH; by++) for (let bx = 0; bx < TW; bx++) {
    const sum = [0, 0, 0], at = (px, py, c) => rgba[((by * BH + py) * W + bx * BW + px) * 4 + c];
    for (let py = 0; py < BH; py++) for (let px = 0; px < BW; px++) for (let c = 0; c < 3; c++) sum[c] += at(px, py, c);
    let rough = 0; for (let py = 0; py < BH - 1; py++) for (let px = 0; px < BW - 1; px++) rough += Math.abs(at(px + 1, py, 1) - at(px, py, 1)) + Math.abs(at(px, py + 1, 1) - at(px, py, 1));
    out.set([...sum.map(s => Math.round(s / n)), Math.min(255, Math.round(ROUGH_GAIN * rough / n))], (by * TW + bx) * 4);
  }
  return out;
}
export function thumbDiff(a, b) {
  const max = a.length === b.length ? [0, 0, 0, 0] : [255, 255, 255, 255], sum = [0, 0, 0, 0], up3 = v => Math.ceil(1000 * v * 4 / a.length) / 1000;   // 长度不对（没冻结过、文件坏了）= 全变了
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - (b[i] ?? 255)); sum[i % 4] += d; if (d > max[i % 4]) max[i % 4] = d; }
  const m = { maxBlockDiff: Math.max(max[0], max[1], max[2]), meanBlockDiff: up3(Math.max(sum[0], sum[1], sum[2])), maxRoughDiff: max[3], meanRoughDiff: up3(sum[3]) };
  return { ...m, pass: Object.keys(THUMB_GATE).every(k => m[k] <= THUMB_GATE[k]) };
}

export const shaderDigests = sources => sources.map(s => createHash('sha256').update(s).digest('hex')).sort();

export function checkGolden(base, sources) {
  const frozen = { shaders: [], thumbs: {}, ids: {}, ...(fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {}) };   // 还没冻结过、缺字段 = 全部算变了
  const digests = shaderDigests(sources), shadersChanged = { added: digests.filter(d => !frozen.shaders.includes(d)).length, removed: frozen.shaders.filter(d => !digests.includes(d)).length };
  const frames = THUMBED.map(s => ({ id: s.id, ...thumbDiff(thumb(base[s.id]), Buffer.from(frozen.thumbs[s.id] ?? '', 'base64')) }));
  const now = idAreas(base.id);
  const ids = [...new Set([...Object.keys(frozen.ids), ...Object.keys(now)])].map(Number).sort((a, b) => a - b).map(id => {
    const f = frozen.ids[id] ?? 0, n = now[id] ?? 0;
    return { id, frozen: f, now: n, pass: f > 0 && n > 0 && Math.abs(n - f) <= Math.max(ID_AREA_GATE.pixels, ID_AREA_GATE.ratio * f) };
  });
  return { baseline: frozen.baseline, backend: frozen.backend, gate: { ...THUMB_GATE, idArea: ID_AREA_GATE }, shaders: digests.length, shadersChanged, frames, ids,
    pass: digests.length > 0 && shadersChanged.added + shadersChanged.removed === 0 && frames.every(f => f.pass) && ids.length > 0 && ids.every(i => i.pass) };
}

export function freezeGolden(base, sources, { baseline, backend }) {
  const thumbs = Object.fromEntries(THUMBED.map(s => [s.id, Buffer.from(thumb(base[s.id])).toString('base64')]));
  fs.writeFileSync(FILE, JSON.stringify({ schema: 'beiming.r187-look-golden/1', baseline, three: '170', backend, frame: { width: W, height: H }, thumb: { width: TW, height: TH },
    shaders: shaderDigests(sources), ids: idAreas(base.id), thumbs }, null, 2) + '\n');
}
