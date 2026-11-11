// 北冥引擎 · 原生层 · 底板边缘策略（edgePolicy）：给透明底板的截断边加「有机软边」或「圆形收边」，在准备阶段烘进 PNG 的 alpha。
// 原因：绘画底板常在画幅处被截断（左 / 右 / 上 / 下一条直边，或沿直线做了线性淡出），原生图片卡不能像 A 路那样在着色器里裁切，
// 镜头一动截断边进画就是一道竖直的刀口（docs/raea/experiment.md、QA-B-001）。规矩（routes/directing/craft/two-five-d.md §2.1）：
// 截断边在整段运动里留在画外；软边只是安全网。确实要在画内结束的远景云堤，把端头烘成「圆形收边」（round）：淡出线沿边弯成
// 圆弧、再叠低频起伏，读起来是云自己收住，而不是刀切——相当于 A 路 engine/stage/plates.js 的 cropPlate 椭圆软边，只作用在截断的那一侧。
//
//   film.json → native.images[] 的 edge 字段：
//     { "left": 0.12, "right": 0, "top": 0.06, "bottom": 0, "jitter": 0.6, "lobes": 6, "seed": 1, "round": 0, "center": 0.5 }
//     left / right 是占图宽的比例，top / bottom 是占图高的比例（0 或不写 = 这条边不动）；
//     jitter 软边起点沿边游走的幅度（占该边羽化宽的比例，0–1），lobes 沿边大约几团起伏，seed 换一组相位；
//     round（0–1）圆形收边：淡出起点离 center（沿边的比例位置，默认 0.5，取云体的竖直中心）越远越往里收，两端多收 round × 羽化宽。
//     round = 0 时与旧写法逐位相同。
//   images[] 另可写 crop: [x, y, w, h]（占原图宽高的比例，先裁再处理）与 flip: true（水平翻转），从一张底板派生一块云片。
//   edgeExpr(edge) → FFmpeg geq 的 alpha 表达式（纯函数，可单测）
//   imageFilter({ edge, crop, flip }) → 完整的 -vf 滤镜串（纯函数）
//   applyEdge(src, out, edge, { ffmpeg, timeoutMs, crop, flip }) → 只改 alpha：a' = a · Π smoothstep(…)，RGB（含透明区的填色）原样保留，
//                                                       所以不破坏「直通 alpha、透明区已填色」的底板约定（plates.json 通用设置）
// 结果对同一 FFmpeg 构建是确定的；prepare 把 FFmpeg 版本记进 media/prepared.json。
import { rename, rm } from 'node:fs/promises';
import { EXIT, fail, runQuick } from './cli.mjs';
import { ffmpegBins } from '../../tools/env/lib/ffmpeg.mjs';

const SIDES = { left: ['X/W', 'Y/H'], right: ['(W-1-X)/W', 'Y/H'], top: ['Y/H', 'X/W'], bottom: ['(H-1-Y)/H', 'X/W'] };
const FIELDS = [...Object.keys(SIDES), 'jitter', 'lobes', 'seed', 'round', 'center'];
const f = x => Number(x).toFixed(6);

export function checkEdge(edge, { required = true } = {}) {
  if (edge === undefined && !required) return;
  if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw fail(EXIT.CONTRACT, 'edge', 'edge 要写成 { left, right, top, bottom, jitter, lobes, seed, round, center }');
  for (const k of Object.keys(edge)) if (!FIELDS.includes(k)) throw fail(EXIT.CONTRACT, 'edge', `edge 里不认识的字段 ${k}`, `可用：${FIELDS.join('、')}`);
  for (const k of Object.keys(SIDES)) if (edge[k] !== undefined && !(edge[k] >= 0 && edge[k] <= 0.5)) throw fail(EXIT.CONTRACT, 'edge', `edge.${k} 要在 0–0.5 之间（占图宽 / 高的比例）`);
  for (const k of ['jitter', 'round', 'center']) if (edge[k] !== undefined && !(edge[k] >= 0 && edge[k] <= 1)) throw fail(EXIT.CONTRACT, 'edge', `edge.${k} 要在 0–1 之间`);
  if (edge.lobes !== undefined && !(edge.lobes > 0 && edge.lobes <= 64)) throw fail(EXIT.CONTRACT, 'edge', 'edge.lobes 要在 0–64 之间（沿边几团起伏）');
  if (!Object.keys(SIDES).some(k => edge[k] > 0)) throw fail(EXIT.CONTRACT, 'edge', 'edge 至少要给一条边一个大于 0 的宽度');
}

export function checkCrop(crop) {
  if (crop === undefined) return;
  if (!(Array.isArray(crop) && crop.length === 4 && crop.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) || crop[2] <= 0 || crop[3] <= 0 || crop[0] + crop[2] > 1 + 1e-9 || crop[1] + crop[3] > 1 + 1e-9) {
    throw fail(EXIT.CONTRACT, 'crop', `crop 要写成 [x, y, w, h]（占原图宽高的比例，0–1，且不越出原图）：${JSON.stringify(crop)}`);
  }
}

export function edgeExpr({ jitter = 0.5, lobes = 6, seed = 1, round = 0, center = 0.5, ...sides }) {
  const terms = [];
  let i = 0;
  const span = Math.max(center, 1 - center);   // 沿边离 center 最远的距离（归一到 1）
  for (const [side, [d, s]] of Object.entries(SIDES)) {
    const w = sides[side];
    if (!(w > 0)) continue;
    // 三个不可通约频率的正弦叠成 0–1 的起伏：主频给「团」，高频给碎边
    const ph = k => f(((seed * 7.31 + i * 3.17 + k * 1.93) % (2 * Math.PI)));
    const n = `(0.5+0.5*(0.55*sin(2*PI*${f(lobes)}*${s}+${ph(1)})+0.30*sin(2*PI*${f(lobes * 2.17)}*${s}+${ph(2)})+0.15*sin(2*PI*${f(lobes * 4.61)}*${s}+${ph(3)})))`;
    // 圆形收边：淡出起点随沿边位置按抛物线往里收（离 center 越远收得越多），端头读成圆弧
    const cap = round > 0 ? `-${f(round * w)}*pow((${s}-${f(center)})/${f(span)},2)` : '';
    terms.push(`(st(0,clip((${d}-${f(jitter * w)}*${n}${cap})/${f(w)},0,1));ld(0)*ld(0)*(3-2*ld(0)))`);
    i++;
  }
  return `alpha(X,Y)*${terms.join('*')}`;
}

export function imageFilter({ edge, crop, flip = false } = {}) {
  const vf = ['format=rgba'];
  if (crop) vf.push(`crop=w=trunc(iw*${f(crop[2])}/2)*2:h=trunc(ih*${f(crop[3])}/2)*2:x=trunc(iw*${f(crop[0])}):y=trunc(ih*${f(crop[1])})`);
  if (flip) vf.push('hflip');
  if (edge) vf.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${edgeExpr(edge)}'`);
  return vf.join(',');
}

export async function applyEdge(src, out, edge, { ffmpeg = ffmpegBins(process.env).ffmpeg, timeoutMs = 120000, crop, flip = false } = {}) {
  checkEdge(edge, { required: !crop && !flip });
  checkCrop(crop);
  const tmp = `${out}.edge.png`;
  const p = runQuick(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-vf', imageFilter({ edge, crop, flip }), '-frames:v', '1', '-c:v', 'png', tmp], { timeoutMs, label: 'FFmpeg（底板软边）' });
  if (p.status !== 0) { await rm(tmp, { force: true }); throw fail(EXIT.FAIL, 'edge', `底板软边处理失败：${p.stderr.trim().slice(0, 300)}`); }
  await rename(tmp, out);
}
