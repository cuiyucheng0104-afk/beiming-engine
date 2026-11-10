// 北冥 QA · plates：底板。两件事（默认只查左右两边的竖直边：截断竖边是已知的穿帮；上下两边多是有意的雾带过渡，档位 plates.sides 可改）——
//   ① 直线淡出 / 硬切边露在画内（plates.straight-fade，软项）：先静态分析每张透明底板四边（lib/plate-edges.mjs），
//      再把直线边按每帧的面片位置投影到屏幕，落在画内、该处不透明度够、没被裁切面片的软边遮掉，就报帧号与屏幕位置。
//      前面有没有雾或云片把它盖住，这里不建模，所以是软项：按帧号逐帧看。
//   ② 贴图密度（plates.density，硬门）：面片在屏幕上每个像素分到几个贴图像素（texel/px），取画内各采样点的最小值；
//      低于档位 plates.densityWarn（1.0）报注意，低于 plates.densityFail（0.6）不通过（GAP-03：4K 下底板被放大 2.6–3.5 倍）。
// 面片位置来自 three.js 垫片探针（lib/page.mjs 的 installThree）：页面按 importmap 取 three 时自动装上，不改页面代码。
// B 路线（原生运行时）没有页面：读 film.json 的 native.images 做静态分析，投影与密度记「未执行」。
// 也可以直接给图片做静态分析（素材入库前查边）：qa plates a.png b.png。
//
//   runPlates({ pageDir, root, profile, film, step, images, readyTimeoutMs, timeoutMs }) → { checks, warnings, summary }
import fs from 'node:fs';
import path from 'node:path';
import { makeCheck, finding, settle, notRun } from '../lib/checks.mjs';
import { openPage, samplePlates } from '../lib/page.mjs';
import { analyzePlate } from '../lib/plate-edges.mjs';
import { fpsOf, REPO_ROOT } from '../lib/profiles.mjs';

const SIDE = { left: '左', right: '右', top: '上', bottom: '下' };
const nameOf = f => path.basename(f).replace(/\.[^.]+$/, '');
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// 面片的仿射参数化：TL(0,1) TR(1,1) BL(0,0) BR(1,0)
const lerp4 = (C, s, t) => C[2].map((b, k) => b + s * (C[3][k] - b) + t * (C[0][k] - b));
function screenAt(P, s, t, W, H) {
  const c = lerp4(P.clip, s, t);
  if (!(c[3] > 1e-6)) return null;
  return [(c[0] / c[3] + 1) / 2 * W, (1 - c[1] / c[3]) / 2 * H];
}
function stOfUv(P, u, v) {
  const [b, r, tl] = [P.uv[2], P.uv[3], P.uv[0]];
  const a11 = r[0] - b[0], a12 = tl[0] - b[0], a21 = r[1] - b[1], a22 = tl[1] - b[1];
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-12) return null;
  const du = u - b[0], dv = v - b[1];
  return [(du * a22 - a12 * dv) / det, (a11 * dv - a21 * du) / det];
}
const cropMask = (P, s, t) => (P.crop ? 1 - smoothstep(P.crop.soft, 1, Math.hypot((s - 0.5) * 2, (t - 0.5) * 2 * 1.15)) : 1);
const inFrame = (p, W, H) => p && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H;

// 画内采样点上的局部放大率：texel/px（横、竖取小的）
function density(P, W, H) {
  let min = Infinity, at = null;
  const e = 0.01;
  for (let i = 1; i <= 9; i++) for (let j = 1; j <= 9; j++) {
    const s = i / 10, t = j / 10;
    if (cropMask(P, s, t) < 0.5) continue;
    const p = screenAt(P, s, t, W, H), ps = screenAt(P, s + e, t, W, H), pt = screenAt(P, s, t + e, W, H);
    if (!inFrame(p, W, H) || !ps || !pt) continue;
    const uv = lerp4(P.uv, s, t), uvs = lerp4(P.uv, s + e, t), uvt = lerp4(P.uv, s, t + e);
    const ts = Math.hypot((uvs[0] - uv[0]) * P.iw, (uvs[1] - uv[1]) * P.ih), tt = Math.hypot((uvt[0] - uv[0]) * P.iw, (uvt[1] - uv[1]) * P.ih);
    const ls = Math.hypot(ps[0] - p[0], ps[1] - p[1]), lt = Math.hypot(pt[0] - p[0], pt[1] - p[1]);
    if (ls < 1e-6 || lt < 1e-6) continue;
    const d = Math.min(ts / ls, tt / lt);
    if (d < min) { min = d; at = p; }
  }
  return Number.isFinite(min) ? { value: min, at } : null;
}

// 一条直线边在这一帧露在画内的部分
function edgeOnScreen(P, edge, W, H, minOpacity) {
  if (P.opacity < minOpacity) return null;
  if ((edge.side === 'left' || edge.side === 'right') && P.wrapS) return null;     // 横向循环贴图的左右边是接缝，不是截断
  if ((edge.side === 'top' || edge.side === 'bottom') && P.wrapT) return null;
  const K = 32, pts = [];
  for (let k = 0; k < K; k++) {
    const along = edge.span[0] + (k + 0.5) / K * (edge.span[1] - edge.span[0]);
    let x, y;
    if (edge.side === 'left' || edge.side === 'right') { x = edge.posPx + 0.5; y = along; } else { x = along; y = edge.posPx + 0.5; }
    const u = x / P.iw, v = P.flipY ? 1 - y / P.ih : y / P.ih;
    const st = stOfUv(P, u, v);
    if (!st || st[0] < 0 || st[0] > 1 || st[1] < 0 || st[1] > 1) continue;
    if (cropMask(P, st[0], st[1]) < 0.5) continue;
    const p = screenAt(P, st[0], st[1], W, H);
    if (inFrame(p, W, H)) pts.push(p);
  }
  if (pts.length < 0.3 * K) return null;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { frac: pts.length / K, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

function resolveSrc(src, origin, root) {
  try {
    const u = new URL(src);
    if (u.origin !== origin) return null;
    const f = path.join(root, decodeURIComponent(u.pathname));
    return f.startsWith(path.resolve(root)) && fs.existsSync(f) ? f : null;
  } catch { return null; }
}

export async function runPlates({ pageDir = null, root = REPO_ROOT, profile, film = null, step = 1, images = [], readyTimeoutMs = 120000, timeoutMs = 600000, size = null }) {
  const T = profile.plates;
  const [W, H] = size || [film?.width || profile.width, film?.height || profile.height];
  const sides = new Set(T.sides || ['left', 'right']);
  const fps = (film?.fps || fpsOf(profile)).value;
  const warnings = [];
  const inv = makeCheck('plates.inventory'), fade = makeCheck('plates.straight-fade'), dens = makeCheck('plates.density');
  fade.expected = '透明底板的直线淡出 / 硬切边不露在画内';
  dens.expected = `画内贴图密度 ≥ ${T.densityWarn} texel/px（低于 ${T.densityFail} 不通过）`;
  const opts = { maxStdPx: T.maxStdPx, minCoverage: T.minCoverage, timeoutMs };
  const files = new Map();                              // 文件 → { name, analysis, uses }
  const addFile = async (f, use) => {
    if (!files.has(f)) files.set(f, { name: nameOf(f), file: f, analysis: await analyzePlate(f, opts), uses: new Set() });
    if (use) files.get(f).uses.add(use);
    return files.get(f);
  };
  const relp = f => path.relative(root, f).split(path.sep).join('/');

  // ── 来源一：直接给的图片；来源二：B 路线 film.json 的 native.images ──
  for (const f of images) await addFile(path.resolve(f), '命令行');
  const nativeImgs = film?.native?.images || [];
  for (const im of nativeImgs) {
    const f = film.dir ? path.resolve(film.dir, im.from || im.to || '') : null;
    if (f && fs.existsSync(f) && /\.(png|webp|tiff?)$/i.test(f)) await addFile(f, `native:${im.to}`);
    else if (f) warnings.push(`film.json 的 native.images 引用的 ${im.from || im.to} 找不到，跳过`);
  }

  // ── 来源三：页面逐帧投影 ──
  let projected = false, frames = 0, placementsSeen = 0;
  const vis = new Map();      // `${file}|${side}` → { frames: [], box, maxOpacity, edge }
  const dmin = new Map();     // file → { value, frame, at }
  if (pageDir) {
    const h = await openPage({ root, pageDir, width: W, height: H, fps, profileId: profile.id, readyTimeoutMs, shimThree: true });
    try {
      const frameCount = film?.frameCount ?? Math.round(h.info.dur * fps);
      const list = [];
      for (let f = 0; f < frameCount; f += step) list.push(f);
      if (list[list.length - 1] !== frameCount - 1) list.push(frameCount - 1);
      const samples = await samplePlates(h, list, { fps, timeoutMs });
      frames = samples.length;
      if (h.platesErr) warnings.push(`面片探针出错（结果可能不全）：${h.platesErr}`);
      if (!h.three) {
        finding(inv, { key: 'no-three', message: '页面没有经 importmap 加载 three.js（或不是 WebGL 三渲二页面），面片位置记不到：只做静态分析', hint: 'A 路线页面按模版的 importmap 引 three；C 路线 2D 页面不需要这一项' });
      } else projected = true;
      for (const s of samples) {
        for (const P of s.plates) {
          const f = resolveSrc(P.src, h.origin, root);
          if (!f) continue;
          placementsSeen++;
          const rec = await addFile(f, '页面');
          if (P.opacity >= T.minOpacity) {
            const d = density(P, W, H);
            if (d) {
              const cur = dmin.get(f);
              if (!cur || d.value < cur.value) dmin.set(f, { value: d.value, frame: s.f, at: d.at.map(Math.round) });
            }
          }
          for (const e of rec.analysis.edges.filter(x => sides.has(x.side))) {
            const on = edgeOnScreen(P, e, W, H, T.minOpacity);
            if (!on) continue;
            const k = `${f}|${e.side}`;
            let v = vis.get(k);
            if (!v) { v = { file: f, frames: [], box: on.box, maxOpacity: 0, edge: e }; vis.set(k, v); }
            v.frames.push(s.f);
            v.box = [Math.min(v.box[0], on.box[0]), Math.min(v.box[1], on.box[1]), Math.max(v.box[2], on.box[2]), Math.max(v.box[3], on.box[3])];
            v.maxOpacity = Math.max(v.maxOpacity, P.opacity);
          }
        }
      }
    } finally { await h.close(); }
  }

  // ── 清单 ──
  const rows = [...files.values()].map(r => ({ name: r.name, file: relp(r.file), size: [r.analysis.width, r.analysis.height], transparent: r.analysis.hasAlpha, edges: r.analysis.edges, uses: [...r.uses] }));
  inv.value = `${files.size} 张底板${projected ? `，${frames} 帧里记到 ${placementsSeen} 次面片（three.js 面片探针）` : ''}`;
  inv.evidence = { plates: rows, frames, projected };
  if (!files.size && !inv.findings.length) finding(inv, { key: 'none', message: '没有找到底板（页面没用贴图面片，作品描述也没有 native.images）' });
  settle(inv);

  // ── 直线淡出 ──
  if (projected) {
    for (const v of vis.values()) {
      const r = files.get(v.file), e = v.edge;
      const fr = [...new Set(v.frames)].sort((a, b) => a - b);
      const desc = `${r.name} ${SIDE[e.side]}边的${e.kind === 'hard-cut' ? '硬切边' : '直线淡出'}（图内 ${e.side === 'left' || e.side === 'right' ? 'x' : 'y'}≈${(e.pos * 100).toFixed(1)}%，${e.kind === 'hard-cut' ? '' : `淡出带 ${e.fadePx} px、`}覆盖主体 ${Math.round(e.coverage * 100)}%）`;
      finding(fade, { key: `${r.name}:${e.side}`, target: r.name, frames: [fr[0], fr[fr.length - 1] + 1],
        message: `${desc}露在画内：屏幕 x ${Math.round(v.box[0])}–${Math.round(v.box[2])}、y ${Math.round(v.box[1])}–${Math.round(v.box[3])}，${fr.length} 帧（第 ${fr[0]}–${fr[fr.length - 1]} 帧），面片不透明度最高 ${v.maxOpacity.toFixed(2)}`,
        hint: '逐帧看这几帧：若没被前面的雾或云片盖住，按 routes/directing/craft/two-five-d.md 把这一端放到画外、用 cropPlate 椭圆软边裁掉，或扩图重做这一端（docs/quality/known-issues.json 的 QA-B-001）' });
    }
    fade.value = vis.size ? `${vis.size} 条直线边露在画内` : '没有直线边露在画内';
    fade.evidence = { visible: [...vis.values()].map(v => ({ plate: files.get(v.file).name, side: v.edge.side, kind: v.edge.kind, frames: [Math.min(...v.frames), Math.max(...v.frames) + 1], count: new Set(v.frames).size, screenBox: v.box.map(Math.round) })) };
  } else {
    const all = rows.flatMap(r => r.edges.filter(e => sides.has(e.side)).map(e => ({ r, e })));
    for (const { r, e } of all) {
      finding(fade, { key: `${r.name}:${e.side}`, target: r.name, status: 'warn',
        message: `${r.name} ${SIDE[e.side]}边有${e.kind === 'hard-cut' ? '硬切边' : '直线淡出'}（图内 ≈${(e.pos * 100).toFixed(1)}%，覆盖主体 ${Math.round(e.coverage * 100)}%）；${pageDir ? '页面面片位置记不到' : '没有页面可投影'}，露不露在画内要人工看`,
        hint: 'B 路线：在最大相机运动处出静帧逐张看这一端（native.mjs --at）；素材入库：先修掉这一端再用' });
    }
    fade.value = all.length ? `${all.length} 条直线边（未投影）` : '没有直线边';
  }
  settle(fade);

  // ── 贴图密度 ──
  if (!projected && pageDir) notRun(dens, '页面面片位置记不到', '密度只能在页面渲染时量：页面要按 importmap 引 three（A 路线模版的写法）');
  else if (!projected) {
    // 原生片（B 路线）与单独的图片：结构上量不了，记「注意」而不是硬失败
    dens.value = '不适用（没有页面）';
    finding(dens, { key: 'n/a', status: 'warn', message: '没有页面可量贴图密度（B 路线原生片或只给了图片）：4K 交付时按 routes/directing/craft/two-five-d.md §2.2 的公式手算，或出 1:1 对照帧人工看' });
    settle(dens);
  }
  else {
    const drows = [...dmin.entries()].map(([f, d]) => ({ plate: files.get(f).name, texelPerPx: +d.value.toFixed(3), frame: d.frame, at: d.at })).sort((a, b) => a.texelPerPx - b.texelPerPx);
    dens.value = drows.length ? drows.slice(0, 6).map(d => `${d.plate} ${d.texelPerPx}`).join('；') : '画内没有贴图面片';
    dens.evidence = { rows: drows, resolution: `${W}×${H}` };
    for (const d of drows) {
      if (d.texelPerPx < T.densityFail) finding(dens, { key: `low@${d.plate}`, target: d.plate, frames: [d.frame, d.frame + 1], message: `${d.plate} 在第 ${d.frame} 帧画内只有 ${d.texelPerPx} texel/px（${W}×${H}），低于 ${T.densityFail}：底板被放大得发虚`, hint: '按镜头与档位重新生成更大的底板，或缩小该层的推近幅度；4K 交付要么换大图、要么在运行记录写明放大方法并附 1:1 对照（GAP-03）' });
      else if (d.texelPerPx < T.densityWarn) finding(dens, { key: `soft@${d.plate}`, target: d.plate, frames: [d.frame, d.frame + 1], status: 'warn', message: `${d.plate} 在第 ${d.frame} 帧画内 ${d.texelPerPx} texel/px（${W}×${H}），低于 ${T.densityWarn}：比原图放大了` });
    }
    settle(dens);
  }
  return { checks: [inv, fade, dens], warnings, summary: { plates: rows.length, frames, projected } };
}
