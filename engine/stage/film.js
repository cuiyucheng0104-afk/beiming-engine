// 北冥引擎 · 影片外壳：渲染器、最上层的 2D 显示层、设计尺寸缩放、按时间切镜头，并兑现页面约定（engine/render/page.mjs）。
// 渲染器走线性工作流：输出 sRGB、不做色调映射（保色板），开软阴影。显示层画布叠在最上面，不过后期（不加颗粒、不受辉光与笔触影响）。
// 镜头在设计画幅 DW×DH 里按像素坐标摆；实际画面（W×H，如原生 4K、竖屏）由渲染器、后期、显示层用，镜头交给显示层的屏幕坐标乘 K。
//
//   createFilm({ width, height, designWidth, designHeight, fit, fps, shadows })
//     → { renderer, overlay, ctx, W, H, K, DW, DH, design, fit, output, fps, run }
//     output = { width, height, profile, injected }（injected：渲染器注入了 __RENDER）；fps 是当前影片帧率（run 之后为最终值）
//     width / height   实际像素；不写时取渲染器注入的 window.__RENDER（页面约定 v1：{ fps, width, height, profile }），
//                      没有注入时取视口 innerWidth / innerHeight
//     designWidth / designHeight / fit   设计画幅与适配方式，K = 实际像素 / 设计像素（见 designFit）：
//       只给 designHeight（老写法）：K = H / designHeight，与改动前逐位相同；只给 designWidth：K = W / designWidth；
//       两个都给：fit = 'contain'（默认，设计稿整块装进画面、另一方向多出来）| 'cover'（铺满、另一方向裁掉）| 'height' | 'width'
//       design = { x, y, w, h }：设计稿在 DW×DH 里的位置（居中），镜头把要紧的东西摆在里面，换竖屏也不出画
//     fps        页面按这个帧率量化一拍二 / 一拍三；不写时 run 再定（见下）
//     shadows    阴影贴图类型（THREE.*ShadowMap），false = 不开阴影
//   film.run({ dur, fps, shots, post, debug, draw, texts, warm })   设好 window.DUR / FPS / render / TEXTS，预热后置 window.READY
//     fps       帧率 = run 的 fps ?? createFilm 的 fps ?? window.__RENDER.fps ?? 24；写进 window.FPS 和 engine/core/clock.js 的
//               setFilmFps（之后 frameOf / heldTime 不写 fps 时都按它）。页面帧率与渲染器注入的不一致时由渲染器拒绝出片
//     shots     镜头表，按开始时间升序。两种写法（一张表里只用一种）：
//                 [{ at: 开始秒, shot, id? }]      老写法：t ≥ at 起用这个镜头（与改动前完全相同）
//                 [{ in: 开始帧, shot, id? }]      帧号写法（film.json v2 的 in）：帧号 f ≥ in 起用这个镜头
//               镜头 = { scene, camera, update(t, f, ctx), look(t, ctx) → 后期参数 }；ctx 见 shotTable
//     post      后期：{ render(scene, camera, params), ready }
//     debug     非空时写进后期参数的 debug（调试视图）
//     draw(ctx, t, shot, sctx)   每帧在清空的显示层上画（字幕、界面、调试标记）；sctx 是同一个镜头上下文
//     texts(t)  该时刻画面上的文字。window.TEXTS 每条都带 { id, text, x0, y0, x1, y1, box: [x, y, w, h], alpha }（见 normalizeTexts）
//     warm      预热时刻：每个镜头渲一帧，提前编译着色器、上传贴图、生成阴影贴图，最后回到 t = 0
// render(t) 的帧号 f = frameOf(t, fps)，镜头里的一拍二、一拍三都从它量化（engine/core/clock.js）。
//
// 下面几个是纯函数（Node 里能直接测）：
//   renderInfo(win)              读并校验 win.__RENDER → { fps, width, height, profile } 或 null（没注入）；格式不对直接抛错
//   designFit(o)                 { width, height, designWidth, designHeight, fit } → { K, DW, DH, fit, design: { x, y, w, h } }
//   shotTable(shots, { fps, dur }) → { list, total, at(t, f) }：校验镜头表，at 返回 { entry, ctx }，
//                                ctx = { shotId, index, inFrame, outFrame, localFrame, localT, fps }
//                                inFrame 是镜头的第一帧，outFrame 是下一个镜头的 inFrame（末镜 = 总帧数 round(dur × fps)），
//                                [inFrame, outFrame) 就是这个镜头占的全部整帧：
//                                  老写法：inFrame = 第一个 ≥ at 的整帧；第一镜记 0（t 早于它的 at 时也用它，与改动前一样）
//                                  帧号写法：第一镜必须 in: 0，in 严格递增、小于总帧数；写了 out（film.json v2）就必须与下一镜的 in
//                                    （末镜：总帧数）相接，镜头之间不许有空档或重叠
//                                localFrame = f − inFrame，localT = (f − inFrame) / fps + (t − f / fps)：整帧上就是 localFrame / fps，
//                                与镜头在全片里的位置无关（第一镜加长几帧，后面镜头同一局部帧的输入逐位不变）。
//                                t 不在整帧上、又早于镜头的第一帧时（老写法 at 不在整帧上），两者都夹成不小于 0
//   normalizeTexts(list)         给每条文字补 box（由 x0..y1 算）或 x0..y1（由 box 算），没写 alpha 的记 1（报了就是看得见）
//
// 页面约定的出处：window.DUR / render(t) / READY / TEXTS（{ id, text, x0, y0, x1, y1 }）沿用 lemo-opuscar@bebbbe1
// core/README.md「The page contract」（MIT，LemoLab；见 routes/directing/SOURCES.md）；box、alpha、__RENDER 是本仓库的扩展（页面约定 v1）。
import * as THREE from 'three';
import { frameOf, setFilmFps, filmFps, REF_FPS } from '../core/clock.js';

const isPos = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isDim = v => Number.isInteger(v) && v > 0;
const show = v => (typeof v === 'string' ? JSON.stringify(v) : `${String(v)}（${typeof v}）`);

export function renderInfo(win = globalThis) {
  const R = win?.__RENDER;
  if (R === undefined || R === null) return null;
  if (typeof R !== 'object') throw new TypeError(`window.__RENDER 要是对象 { fps, width, height, profile }，收到 ${show(R)}`);
  if (!isPos(R.fps)) throw new TypeError(`window.__RENDER.fps 要是正数，收到 ${show(R.fps)}（渲染器注入的页面约定 v1）`);
  for (const k of ['width', 'height']) if (R[k] !== undefined && !isDim(R[k])) throw new TypeError(`window.__RENDER.${k} 要是正整数，收到 ${show(R[k])}`);
  if (R.profile !== undefined && R.profile !== null && typeof R.profile !== 'string') throw new TypeError(`window.__RENDER.profile 要是档位名字符串，收到 ${show(R.profile)}`);
  return { fps: R.fps, width: R.width ?? null, height: R.height ?? null, profile: R.profile ?? null };
}

const FITS = ['height', 'width', 'contain', 'cover'];
export function designFit({ width, height, designWidth, designHeight, fit } = {}) {
  if (!isPos(width) || !isPos(height)) throw new TypeError(`designFit：实际画面宽高要是正数，收到 ${show(width)} × ${show(height)}`);
  for (const [k, v] of [['designWidth', designWidth], ['designHeight', designHeight]]) if (v !== undefined && v !== null && !isPos(v)) throw new TypeError(`designFit：${k} 要是正数，收到 ${show(v)}`);
  const hasW = designWidth !== undefined && designWidth !== null, hasH = designHeight !== undefined && designHeight !== null;
  if (fit !== undefined && fit !== null && !FITS.includes(fit)) throw new TypeError(`designFit：fit 只能是 ${FITS.join(' / ')}，收到 ${show(fit)}`);
  const mode = fit ?? (hasW && hasH ? 'contain' : hasW ? 'width' : 'height');
  if ((mode === 'width' && !hasW) || ((mode === 'contain' || mode === 'cover') && !(hasW && hasH))) {
    throw new TypeError(`designFit：fit = '${mode}' 需要 ${mode === 'width' ? 'designWidth' : 'designWidth 和 designHeight'}`);
  }
  const dh = hasH ? designHeight : height, dw = hasW ? designWidth : null;
  const K = mode === 'height' ? height / dh : mode === 'width' ? width / dw
    : mode === 'contain' ? Math.min(width / dw, height / dh) : Math.max(width / dw, height / dh);
  const DW = width / K, DH = height / K;
  const bw = dw ?? DW, bh = hasH ? dh : DH;
  return { K, DW, DH, fit: mode, design: { x: (DW - bw) / 2, y: (DH - bh) / 2, w: bw, h: bh } };
}

// 老写法（at 秒）里镜头的第一帧：最小的整数 F，使 F / fps ≥ at（与 render 按 t ≥ at 选镜头在整帧上一致）
function firstFrame(at, fps) {
  let F = Math.ceil(at * fps - 1e-9);
  while ((F - 1) / fps >= at) F--;
  while (F / fps < at) F++;
  return F === 0 ? 0 : F;   // 不交出 -0
}

export function shotTable(shots, { fps, dur } = {}) {
  if (!isPos(fps)) throw new TypeError(`shotTable：fps 要是正数，收到 ${show(fps)}`);
  if (!Array.isArray(shots) || !shots.length) throw new TypeError('film.run：shots 要是非空数组 [{ at: 开始秒, shot }] 或 [{ in: 开始帧, shot }]');
  const byFrame = shots.some(c => c && c.in !== undefined), byTime = shots.some(c => c && c.at !== undefined);
  if (byFrame && byTime) throw new TypeError('film.run：镜头表里 at（秒）和 in（帧）只能用一种');
  const total = isPos(dur) ? Math.round(dur * fps) : Infinity;
  const list = shots.map((c, i) => {
    const where = `film.run：shots[${i}]`;
    if (!c || typeof c !== 'object') throw new TypeError(`${where} 要是 { at | in, shot }，收到 ${show(c)}`);
    const S = c.shot;
    if (!S || typeof S.update !== 'function' || typeof S.look !== 'function' || !S.scene || !S.camera) {
      throw new TypeError(`${where}.shot 要是 { scene, camera, update(t, f, ctx), look(t, ctx) }`);
    }
    if (byFrame && !(Number.isInteger(c.in) && c.in >= 0)) throw new TypeError(`${where}.in 要是不小于 0 的整数帧号，收到 ${show(c.in)}`);
    if (byTime && (typeof c.at !== 'number' || !Number.isFinite(c.at))) throw new TypeError(`${where}.at 要是秒数，收到 ${show(c.at)}`);
    if (!byFrame && !byTime) throw new TypeError(`${where} 缺 at（开始秒）或 in（开始帧）`);
    if (c.out !== undefined && !byFrame) throw new TypeError(`${where}.out 只能和帧号写法 in 一起用`);
    if (c.out !== undefined && !(Number.isInteger(c.out) && c.out > c.in)) throw new TypeError(`${where}.out 要是大于 in 的整数帧号，收到 ${show(c.out)}`);
    if (c.id !== undefined && (typeof c.id !== 'string' || !c.id)) throw new TypeError(`${where}.id 要是非空字符串，收到 ${show(c.id)}`);
    // 老写法的第一镜从第 0 帧起用（改动前 t 早于它的 at 时也用它），所以它的 inFrame 记 0
    const inFrame = byFrame ? c.in : i === 0 ? 0 : firstFrame(c.at, fps);
    return { index: i, id: c.id ?? `S${i + 1}`, shot: S, at: byTime ? c.at : c.in / fps, inFrame, outFrame: total, out: c.out };
  });
  if (byFrame && list[0].inFrame !== 0) throw new TypeError(`film.run：镜头表的第一镜要从第 0 帧开始（shots[0].in = 0），收到 ${list[0].inFrame}`);
  for (let i = 1; i < list.length; i++) {
    if (list[i].at < list[i - 1].at) throw new TypeError(`film.run：镜头表要按开始时间升序，shots[${i}] 比 shots[${i - 1}] 早`);
    if (byFrame && list[i].inFrame === list[i - 1].inFrame) throw new TypeError(`film.run：shots[${i}] 与 shots[${i - 1}] 的 in 都是 ${list[i].inFrame}，前一镜一帧也不占`);
    list[i - 1].outFrame = Math.min(list[i].inFrame, total);
  }
  if (byFrame && list.at(-1).inFrame >= total) throw new TypeError(`film.run：shots[${list.length - 1}].in = ${list.at(-1).inFrame} 不在影片里（总帧数 ${total}）`);
  for (const e of list) {
    if (e.out !== undefined && e.out !== e.outFrame) {
      const next = e.index + 1 < list.length ? `下一镜 shots[${e.index + 1}].in = ${e.outFrame}` : `总帧数 round(dur × fps) = ${e.outFrame}`;
      throw new TypeError(`film.run：shots[${e.index}].out = ${e.out}，与${next}不相接（镜头之间不许有空档或重叠）`);
    }
    delete e.out;
  }
  const ids = new Set();
  for (const e of list) { if (ids.has(e.id)) throw new TypeError(`film.run：镜头 id 重复：${e.id}`); ids.add(e.id); }
  // 选镜头：老写法按 t ≥ at（逐位同改动前），帧号写法按 f ≥ in
  const at = (t, f) => {
    let e = list[0];
    for (const c of list) if (byFrame ? f >= c.inFrame : t >= c.at) e = c;
    const localFrame = Math.max(0, f - e.inFrame);
    const localT = Math.max(0, (f - e.inFrame) / fps + (t - f / fps));
    return { entry: e, ctx: { shotId: e.id, index: e.index, inFrame: e.inFrame, outFrame: e.outFrame, localFrame, localT, fps } };
  };
  return { list, total, at };
}

export function normalizeTexts(list) {
  if (!Array.isArray(list)) return list;   // 不是数组原样交出去，由检查方报错
  return list.map(r => {
    if (!r || typeof r !== 'object') return r;
    const o = { ...r };
    const xyxy = [o.x0, o.y0, o.x1, o.y1].every(Number.isFinite);
    if (o.box === undefined && xyxy) o.box = [o.x0, o.y0, o.x1 - o.x0, o.y1 - o.y0];
    else if (!xyxy && Array.isArray(o.box) && o.box.length === 4 && o.box.every(Number.isFinite)) {
      o.x0 = o.box[0]; o.y0 = o.box[1]; o.x1 = o.box[0] + o.box[2]; o.y1 = o.box[1] + o.box[3];
    }
    if (o.alpha === undefined) o.alpha = 1;
    return o;
  });
}

export function createFilm({ width, height, designWidth, designHeight, fit, fps, shadows = THREE.PCFSoftShadowMap } = {}) {
  const R = renderInfo();
  const W = width ?? R?.width ?? innerWidth, H = height ?? R?.height ?? innerHeight;
  const F = designFit({ width: W, height: H, designWidth, designHeight, fit });
  const { K, DW, DH } = F;
  if (fps !== undefined && !isPos(fps)) throw new TypeError(`createFilm：fps 要是正数，收到 ${show(fps)}`);
  const fps0 = fps ?? R?.fps;
  if (fps0 !== undefined) setFilmFps(fps0);   // 建镜头时（run 之前）frameOf / heldTime 就按这部片的帧率

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(W, H);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  if (shadows !== false) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = shadows; }
  renderer.domElement.style.cssText = 'position:absolute;left:0;top:0;z-index:1';
  document.body.appendChild(renderer.domElement);

  const overlay = document.createElement('canvas'); overlay.width = W; overlay.height = H;
  overlay.style.cssText = 'position:absolute;left:0;top:0;z-index:10;pointer-events:none';
  document.body.appendChild(overlay);
  const ctx = overlay.getContext('2d');

  async function run({ dur, fps: runFps, shots, post, debug = null, draw = null, texts = null, warm = [] }) {
    if (!isPos(dur)) throw new TypeError(`film.run：dur 要是正的秒数，收到 ${show(dur)}`);
    if (runFps !== undefined && !isPos(runFps)) throw new TypeError(`film.run：fps 要是正数，收到 ${show(runFps)}`);
    const rate = setFilmFps(runFps ?? fps ?? R?.fps ?? REF_FPS);
    const table = shotTable(shots, { fps: rate, dur });
    window.DUR = dur;
    window.FPS = rate;   // 页面约定：渲染器据此核对输出帧率，不一致就报错，免得一拍二、一拍三的节奏抖
    window.render = t => {
      t = Math.min(Math.max(t, 0), dur - 1e-6);
      const f = frameOf(t, rate);
      const { entry, ctx: sctx } = table.at(t, f);
      const S = entry.shot;
      S.update(t, f, sctx);
      const p = S.look(t, sctx);
      if (debug) p.debug = debug;
      post.render(S.scene, S.camera, p);
      ctx.clearRect(0, 0, W, H);
      if (draw) draw(ctx, t, S, sctx);
    };
    if (texts) window.TEXTS = t => normalizeTexts(texts(t));
    await post.ready;
    for (const t of warm) window.render(t);
    window.render(0);
    window.READY = true;
  }

  return {
    renderer, overlay, ctx, W, H, K, DW, DH, design: F.design, fit: F.fit, run,
    output: { width: W, height: H, profile: R?.profile ?? null, injected: !!R },
    get fps() { return filmFps(); },
  };
}
