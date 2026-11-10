// 北冥引擎 · 原生层 · 底板边缘策略（edgePolicy）：给透明底板的截断边加「有机软边」，在准备阶段烘进 PNG 的 alpha。
// 原因：绘画底板常在画幅处被截断（左 / 右 / 上 / 下一条直边），原生 ImagePlane 不能像 A 路那样在着色器里裁切，
// 镜头一动截断边进画就是一道竖直的刀口（docs/raea/experiment.md 记录过）。正确做法仍是摆位让截断边始终在画外
// （routes/directing/craft/two-five-d.md §2.1 硬规矩）；软边是安全网：万一擦边，看到的是一团散开的云，而不是直线。
//
//   film.json → native.images[] 的 edge 字段：
//     { "left": 0.12, "right": 0, "top": 0.06, "bottom": 0, "jitter": 0.6, "lobes": 6, "seed": 1 }
//     left / right 是占图宽的比例，top / bottom 是占图高的比例（0 或不写 = 这条边不动）；
//     jitter 软边起点沿边游走的幅度（占该边羽化宽的比例，0–1），lobes 沿边大约几团起伏，seed 换一组相位。
//   edgeExpr(edge) → FFmpeg geq 的 alpha 表达式（纯函数，可单测）
//   applyEdge(src, out, edge, { ffmpeg, timeoutMs }) → 只改 alpha：a' = a · Π smoothstep(…)，RGB（含透明区的填色）原样保留，
//                                                       所以不破坏「直通 alpha、透明区已填色」的底板约定（plates.json 通用设置）
// 结果对同一 FFmpeg 构建是确定的；prepare 把 FFmpeg 版本记进 media/prepared.json。
import { rename, rm } from 'node:fs/promises';
import { CliError, EXIT, runQuick } from './cli.mjs';

const SIDES = { left: ['X/W', 'Y/H'], right: ['(W-1-X)/W', 'Y/H'], top: ['Y/H', 'X/W'], bottom: ['(H-1-Y)/H', 'X/W'] };
const f = x => Number(x).toFixed(6);

export function checkEdge(edge) {
  if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new CliError(EXIT.CONTRACT, 'edge', 'edge 要写成 { left, right, top, bottom, jitter, lobes, seed }');
  for (const k of Object.keys(edge)) if (![...Object.keys(SIDES), 'jitter', 'lobes', 'seed'].includes(k)) throw new CliError(EXIT.CONTRACT, 'edge', `edge 里不认识的字段 ${k}`);
  for (const k of Object.keys(SIDES)) if (edge[k] !== undefined && !(edge[k] >= 0 && edge[k] <= 0.5)) throw new CliError(EXIT.CONTRACT, 'edge', `edge.${k} 要在 0–0.5 之间（占图宽 / 高的比例）`);
  if (edge.jitter !== undefined && !(edge.jitter >= 0 && edge.jitter <= 1)) throw new CliError(EXIT.CONTRACT, 'edge', 'edge.jitter 要在 0–1 之间');
  if (!Object.keys(SIDES).some(k => edge[k] > 0)) throw new CliError(EXIT.CONTRACT, 'edge', 'edge 至少要给一条边一个大于 0 的宽度');
}

export function edgeExpr({ jitter = 0.5, lobes = 6, seed = 1, ...sides }) {
  const terms = [];
  let i = 0;
  for (const [side, [d, s]] of Object.entries(SIDES)) {
    const w = sides[side];
    if (!(w > 0)) continue;
    // 三个不可通约频率的正弦叠成 0–1 的起伏：主频给「团」，高频给碎边
    const ph = k => f(((seed * 7.31 + i * 3.17 + k * 1.93) % (2 * Math.PI)));
    const n = `(0.5+0.5*(0.55*sin(2*PI*${f(lobes)}*${s}+${ph(1)})+0.30*sin(2*PI*${f(lobes * 2.17)}*${s}+${ph(2)})+0.15*sin(2*PI*${f(lobes * 4.61)}*${s}+${ph(3)})))`;
    terms.push(`(st(0,clip((${d}-${f(jitter * w)}*${n})/${f(w)},0,1));ld(0)*ld(0)*(3-2*ld(0)))`);
    i++;
  }
  return `alpha(X,Y)*${terms.join('*')}`;
}

export async function applyEdge(src, out, edge, { ffmpeg = process.env.FFMPEG || 'ffmpeg', timeoutMs = 120000 } = {}) {
  checkEdge(edge);
  const tmp = `${out}.edge.png`;
  const vf = `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${edgeExpr(edge)}'`;
  const p = runQuick(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-vf', vf, '-frames:v', '1', '-c:v', 'png', tmp], { timeoutMs, label: 'FFmpeg（底板软边）' });
  if (p.status !== 0) { await rm(tmp, { force: true }); throw new CliError(EXIT.FAIL, 'edge', `底板软边处理失败：${p.stderr.trim().slice(0, 300)}`); }
  await rename(tmp, out);
}
