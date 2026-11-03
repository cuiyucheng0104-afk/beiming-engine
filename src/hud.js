// AI 眼镜显示层 + 片名「北冥」（2D canvas，叠在最终画面最上层，不经过任何后期）
//
// 导出：
//   loadHUDFonts()                 加载 fonts/ 里的字体子集（READY 之前 await 它）
//   drawHUD(ctx, t, w, h, s)       显示层，只在镜头 C（5.0–8.9）出现，8.9–9.2 淡出
//   drawTitle(ctx, t, w, h)        片名，9.0 起一笔一笔写出
//   textsAt(t, w, h[, s])          当前画面上的全部文字及其方框（给 window.TEXTS）
//   setHUDTheme('mono'|'neutral') 显示层配色：mono=AI 眼镜产品图里的单色绿（默认），neutral=共享色板的青白
//   setTitleLayout({x, y, size, shade, dry})  片名版式（画面比例），默认 {x:.105, y:.262, size:288/1040, shade:0, dry:1}
//   HUD_T                          全部时间点（可在第一帧之前改，例如 HUD_T.titleB = [9.3, 9.6]）
//
// 约定：两个 draw 函数都不清屏，调用方每帧先 ctx.clearRect(0,0,w,h)，再 drawHUD、drawTitle。
//       ctx 用单位变换（画布像素 = w×h）；函数内部都 save/restore，不改调用方 ctx 的状态。
// s 由合成代理每帧传入（全部是屏幕像素坐标，原点左上）：
//   s.eye  = {x, y, r}          鲲眼睛中心与半径；看不见时传 null
//   s.nav  = [{x, y}, ...]      导航线折线，起点在画面下方江面，终点在海平线曙光处（点数不限，内部会平滑）
//   s.head = {yaw, pitch}       头部微晃，弧度（与 three.js 的相机旋转同号）；屏幕固定的元素随之轻微反向浮动
//   s.navCardAt = {x, y}        可选：导航卡中心位置；不给就自动放在导航线起点的另一侧、画面下方
// 确定性：只依赖参数，不用 Date.now / Math.random，任意帧可单独渲染。
import { inkStroke } from '../engine/core/stroke.js';

// ───────────────────────── 字体 ─────────────────────────
const FAM_LAT = 'BM HUD Latin';   // Barlow：数字与西文（接近 AI 眼镜界面里 DIN 风格的数字）
const FAM_SC = 'BM HUD SC';       // Noto Sans SC 可变字重子集：中文
const FAM_TITLE = 'BM Title';     // 马善政毛笔楷书：片名
const fontURL = f => new URL(`../fonts/${f}`, import.meta.url).href;
let fontsReady = false;

export async function loadHUDFonts() {
  const list = [
    [FAM_LAT, 'Barlow-300.woff2', '300'], [FAM_LAT, 'Barlow-400.woff2', '400'], [FAM_LAT, 'Barlow-500.woff2', '500'],
    [FAM_SC, 'NotoSansSC-var.woff2', '300 500'],
    [FAM_TITLE, 'MaShanZheng-400.woff2', '400'],
  ];
  await Promise.all(list.map(async ([fam, file, weight]) => {
    const f = new FontFace(fam, `url(${fontURL(file)})`, { weight, display: 'block' });
    await f.load(); document.fonts.add(f);
  }));
  await document.fonts.ready;
  fontsReady = true;
}
const font = (wt, px, fam = 'ui') => `${wt} ${px.toFixed(2)}px ${fam === 'title' ? `"${FAM_TITLE}"` : `"${FAM_LAT}", "${FAM_SC}"`}, sans-serif`;

// ───────────────────────── 小工具 ─────────────────────────
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const ss = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const eo = x => 1 - Math.pow(1 - clamp(x), 3);
const eio = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a).toFixed(4)})`;

// ───────────────────────── 时间轴（全局秒） ─────────────────────────
export const HUD_T = {
  on: 5.0, off: 8.9, offEnd: 9.2,             // 显示层整体出现 / 开始收淡 / 完全消失
  clockIn: 5.0, remindIn: 5.2,                // 左上时间、提醒卡
  scan: 5.45, scanLock: 5.9, fail: 6.25,      // 识别框出现、收拢到位、变成「未能识别」
  scanOut: 6.78, scanGone: 7.0,               // 识别框收起（7.0 前收完，保证同时最多 2 行字）
  navIn: 7.0, navDone: 8.4,                   // 导航卡出现、导航线画完
  titleA: [9.0, 9.34], titleB: [9.38, 9.80],  // 「北」「冥」的书写区间
  subIn: 9.55, subFull: 9.9,                  // 副标题淡入
};

// ───────────────────────── 配色 ─────────────────────────
// mono：从AR 眼镜常见的单色绿界面（界面单色绿 #2BE426 / 发光处 #48B858–#60D880），
//        为了在粉紫色天空上看得清，正文提亮成 #60FF88，高光近白绿。
// neutral：共享色板，主色 #EAF6FF（约 85% 不透明），点缀 #9FE8FF。
const THEMES = {
  mono:   { ink: [96, 255, 136],  hi: [206, 255, 218], glow: [34, 226, 84],   halo: [4, 24, 26],  fill: [6, 30, 34],  a: 0.94 },
  neutral: { ink: [234, 246, 255], hi: [159, 232, 255], glow: [159, 232, 255], halo: [18, 22, 58], fill: [22, 28, 70], a: 0.86 },
};
let TH = THEMES.mono;
export function setHUDTheme(name) { TH = THEMES[name] || THEMES.mono; }

// ───────────────────────── 绘制 / 记录 两用 ─────────────────────────
// drawHUD 画图；textsAt 用同一套布局代码只量字、记方框，不画
let DRAW = true, REC = null;
let measureCtx = null;
const mctx = () => (measureCtx ??= document.createElement('canvas').getContext('2d'));
function rec(id, text, x0, y0, x1, y1, a) { if (REC && a > 0.02) REC.push({ id, text, x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) }); }

// 量一段字（左对齐、字母基线）。用模块自己的离屏 ctx，不改调用方 ctx 的状态
function meas(str, f, ls = 0) {
  const ctx = mctx();
  ctx.font = f; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; if ('letterSpacing' in ctx) ctx.letterSpacing = `${ls}px`;
  const m = ctx.measureText(str);
  return { w: m.width, asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent };
}
// 发光字：先画一层模糊的暗晕托底（亮天空上也看得清），再画带细辉光的字
function glowText(ctx, str, x, y, f, col, a, S, { ls = 0, glow = 0.55, halo = 0.3 } = {}) {
  if (!DRAW || a <= 0.003) return;
  ctx.save();
  ctx.font = f; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; if ('letterSpacing' in ctx) ctx.letterSpacing = `${ls}px`;
  if (halo > 0) { ctx.filter = `blur(${(4.5 * S).toFixed(2)}px)`; ctx.fillStyle = rgba(TH.halo, halo * a); ctx.fillText(str, x, y + 1 * S); ctx.filter = 'none'; }
  ctx.shadowColor = rgba(TH.glow, glow * a); ctx.shadowBlur = 7 * S;
  ctx.fillStyle = rgba(col, a); ctx.fillText(str, x, y);
  ctx.restore();
}
// 发光描线：path 是 (ctx)=>void
function glowStroke(ctx, path, col, a, lw, S, glow = 0.6) {
  if (!DRAW || a <= 0.003) return;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lw;
  ctx.shadowColor = rgba(TH.glow, glow * a); ctx.shadowBlur = 8 * S;
  ctx.strokeStyle = rgba(col, a); ctx.beginPath(); path(ctx); ctx.stroke();
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// 卡片：半透明暗底 + 细描边（AI 眼镜产品图里的圆角细框）
function card(ctx, x, y, w, h, r, a, S) {
  if (!DRAW || a <= 0.003) return;
  ctx.save();
  ctx.fillStyle = rgba(TH.fill, 0.36 * a); ctx.beginPath(); roundRect(ctx, x, y, w, h, r); ctx.fill();
  ctx.restore();
  glowStroke(ctx, c => roundRect(c, x, y, w, h, r), TH.ink, 0.78 * a, 1.6 * S, S, 0.45);
}

// ───────────────────────── 头部微晃：屏幕固定元素的反向浮动 ─────────────────────────
// 约 35mm 等效（竖直视场 ~38°）下 1 弧度对应的像素，乘一个小增益：0.5° 晃动 ≈ 2–3 像素
function headOffset(s, h) {
  const F = (h / 2) / Math.tan(19 * Math.PI / 180), g = 0.18;
  const yaw = s?.head?.yaw || 0, pitch = s?.head?.pitch || 0;
  return { x: yaw * F * g, y: pitch * F * g };
}
const masterAlpha = t => ss(seg(t, HUD_T.on, HUD_T.on + 0.18)) * (1 - ss(seg(t, HUD_T.off, HUD_T.offEnd)));

// ───────────────────────── 1. 左上：时间 + 提醒卡（同一行） ─────────────────────────
function statusRow(ctx, t, w, h, S, A, off) {
  const aClock = A * ss(seg(t, HUD_T.clockIn, HUD_T.clockIn + 0.3)) * TH.a;
  const aCard = A * ss(seg(t, HUD_T.remindIn, HUD_T.remindIn + 0.12)) * TH.a;
  if (aClock <= 0.002 && aCard <= 0.002) return;
  const X = 0.115 * w + off.x, Yc = 0.125 * h + off.y;     // 显示区左上角（不贴画框边，像是浮在镜片里）
  // 时间
  const fT = font(300, 48 * S), mT = meas('05:54', fT, 1 * S), base = Yc + 17 * S;
  glowText(ctx, '05:54', X, base, fT, TH.ink, aClock, S, { ls: 1 * S });
  rec('hud-clock', '05:54', X, base - mT.asc, X + mT.w, base + mT.desc, aClock);
  // 提醒卡：铃铛 + 远洋聘书 · 回复截止 06:00。两级层次：事项亮、连接词暗、截止时间用高光色
  // 出场：先冒出一个圆（铃铛），再向右展开成胶囊，文字随展开露出
  const cx0 = X + mT.w + 26 * S, ch = 48 * S, cy0 = Yc - ch / 2;
  const fA = font(400, 23 * S), fB = font(500, 25 * S), ls = 0.6 * S;
  const parts = [['远洋聘书', fA, TH.ink, 1], [' · 回复截止 ', fA, TH.ink, 0.66], ['06:00', fB, TH.hi, 1]];
  const ms = parts.map(([str, f]) => meas(str, f, ls)), tw = ms.reduce((a, m) => a + m.w, 0);
  const padL = 48 * S, padR = 24 * S, cw = padL + tw + padR;
  const pop = eo(seg(t, HUD_T.remindIn, HUD_T.remindIn + 0.16)), unfold = eio(seg(t, HUD_T.remindIn + 0.06, HUD_T.remindIn + 0.36));
  const cwNow = lerp(ch, cw, unfold), sc = lerp(0.6, 1, pop);
  if (DRAW && aCard > 0.003) {
    ctx.save();
    ctx.translate(cx0 + ch / 2, Yc); ctx.scale(sc, sc); ctx.translate(-(cx0 + ch / 2), -Yc);
    card(ctx, cx0, cy0, cwNow, ch, ch / 2, aCard, S);
    // 铃铛：提醒弹出时轻摇两下
    const ring = Math.sin(seg(t, HUD_T.remindIn + 0.1, HUD_T.remindIn + 0.7) * Math.PI * 4) * (1 - seg(t, HUD_T.remindIn + 0.1, HUD_T.remindIn + 0.7)) * 0.35;
    bell(ctx, cx0 + 26 * S, Yc, 9 * S, ring, aCard, S);
    ctx.beginPath(); ctx.rect(cx0, cy0 - 10 * S, cwNow - padR * 0.5, ch + 20 * S); ctx.clip();   // 文字随卡片展开露出
    const tb = Yc + 8.5 * S;
    let xx = cx0 + padL;
    parts.forEach(([str, f, col, k], i) => { glowText(ctx, str, xx, tb, f, col, aCard * k * ss(seg(unfold, 0.25, 0.9)), S, { ls, halo: 0 }); xx += ms[i].w; });
    ctx.restore();
  }
  const tb = Yc + 8.5 * S;
  rec('hud-remind', '远洋聘书 · 回复截止 06:00', cx0 + padL, tb - Math.max(...ms.map(m => m.asc)), cx0 + padL + tw, tb + Math.max(...ms.map(m => m.desc)), aCard * ss(seg(unfold, 0.25, 0.9)));
}
function bell(ctx, x, y, r, rot, a, S) {
  if (!DRAW || a <= 0.003) return;
  glowStroke(ctx, c => {
    c.translate(x, y - r * 0.9); c.rotate(rot); c.translate(0, r * 0.9);
    c.moveTo(-r, r * 0.55); c.quadraticCurveTo(-r * 0.86, r * 0.3, -r * 0.82, -r * 0.1);
    c.bezierCurveTo(-r * 0.8, -r * 0.95, r * 0.8, -r * 0.95, r * 0.82, -r * 0.1);
    c.quadraticCurveTo(r * 0.86, r * 0.3, r, r * 0.55); c.closePath();
    c.moveTo(-r * 0.22, r * 0.85); c.lineTo(r * 0.22, r * 0.85);
    c.moveTo(0, -r * 0.72); c.lineTo(0, -r * 0.95);
  }, TH.ink, a, 1.6 * S, S, 0.4);
}

// ───────────────────────── 2. 识别框：四角收拢套住眼睛 + 进度弧 + 识别中… / 未能识别 ─────────────────────────
function recognition(ctx, t, w, h, S, A, s) {
  const e = s?.eye; if (!e || t < HUD_T.scan || t > HUD_T.scanGone) return;
  const aIn = ss(seg(t, HUD_T.scan, HUD_T.scan + 0.16)), aOut = 1 - ss(seg(t, HUD_T.scanOut, HUD_T.scanGone));
  const a = A * aIn * aOut * TH.a; if (a <= 0.002) return;
  const failed = t >= HUD_T.fail;
  const tau = t - HUD_T.fail;
  const shake = failed ? 7 * S * Math.exp(-tau * 7) * Math.sin(2 * Math.PI * 6.5 * tau) : 0;   // 克制的小抖动，0.4 s 内衰减完
  const x = e.x + shake, y = e.y;
  const H0 = Math.max(1.7 * e.r, 64 * S);
  const conv = eo(seg(t, HUD_T.scan, HUD_T.scanLock));
  const scale = lerp(2.3, 1, conv) * (failed ? lerp(1, 1.07, eo(seg(t, HUD_T.fail, HUD_T.fail + 0.3))) : 1);
  const H = H0 * scale, arm = clamp(0.26 * H, 14 * S, 40 * S), rot = (1 - conv) * 0.16;   // 收拢时顺带转正
  const dim = failed ? lerp(1, 0.72, ss(seg(t, HUD_T.fail, HUD_T.fail + 0.2))) : 1;
  const lock = Math.exp(-Math.max(0, t - HUD_T.scanLock) * 9) * (t >= HUD_T.scanLock - 0.04 ? 1 : 0);   // 套住的一瞬间亮一下
  // 四角括号
  glowStroke(ctx, c => {
    c.translate(x, y); c.rotate(rot);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      c.moveTo(sx * H, sy * (H - arm)); c.lineTo(sx * H, sy * H); c.lineTo(sx * (H - arm), sy * H);
    }
  }, lock > 0.05 ? TH.hi : TH.ink, a * dim, (2.4 + 1.2 * lock) * S, S, 0.6 + 0.4 * lock);
  // 进度弧（从正上方顺时针），失败后停住、熄掉。半径取在括号内侧，避开眼周的藤壶
  const p = 0.88 * eio(seg(t, HUD_T.scan + 0.15, HUD_T.fail - 0.03));
  const aArc = a * (1 - ss(seg(t, HUD_T.fail, HUD_T.fail + 0.32))) * ss(seg(t, HUD_T.scanLock - 0.2, HUD_T.scanLock));
  // AI 眼镜小脸：坐在下边框正中（产品图里的 AI 助手图标），识别中是弯弯的眼，失败后变成平眼
  const below = y + H + 92 * S < h - 24 * S;          // 眼睛太靠下时，脸和字放到框上方
  const fy = below ? y + H : y - H, fr = 12.5 * S;
  if (p > 0.002 && aArc > 0.003) {
    const R = H * 0.92, a0 = -Math.PI / 2, a1 = a0 + p * 2 * Math.PI;
    // 弧线在小脸处断开（像产品图里图标打断卡片边框那样），不用擦除合成，免得伤到下层
    const gc = below ? Math.PI / 2 : -Math.PI / 2, gh = (fr + 5 * S) / R;
    const arcGap = (c, s0, s1) => {
      const cuts = [[gc - gh, gc + gh], [gc - gh + 2 * Math.PI, gc + gh + 2 * Math.PI], [gc - gh - 2 * Math.PI, gc + gh - 2 * Math.PI]];
      let segs = [[s0, s1]];
      for (const [c0, c1] of cuts) segs = segs.flatMap(([u, v]) => (c1 <= u || c0 >= v) ? [[u, v]] : [[u, Math.max(u, c0)], [Math.min(v, c1), v]].filter(([m, n]) => n - m > 1e-3));
      for (const [u, v] of segs) { c.moveTo(x + R * Math.cos(u), y + R * Math.sin(u)); c.arc(x, y, R, u, v); }
    };
    glowStroke(ctx, c => arcGap(c, a0, a0 + 2 * Math.PI), TH.ink, aArc * 0.16, 1.2 * S, S, 0);   // 弧的底轨
    glowStroke(ctx, c => arcGap(c, a0, a1), TH.ink, aArc * 0.9, 1.6 * S, S);
    if (DRAW) { ctx.save(); ctx.shadowColor = rgba(TH.glow, aArc); ctx.shadowBlur = 8 * S; ctx.fillStyle = rgba(TH.hi, aArc);
      ctx.beginPath(); ctx.arc(x + R * Math.cos(a1), y + R * Math.sin(a1), 2.6 * S, 0, 7); ctx.fill(); ctx.restore(); }
  }
  // 扫描线：识别中自上而下扫一遍（AI 眼镜购物识别界面的扫描线）
  const ps = seg(t, HUD_T.scanLock - 0.1, HUD_T.fail - 0.05);
  if (DRAW && ps > 0 && ps < 1) {
    const yy = y - H * 0.85 + ps * H * 1.7, hw = H * 0.86, aS = a * 0.42 * Math.sin(ps * Math.PI);
    ctx.save(); const g = ctx.createLinearGradient(x - hw, 0, x + hw, 0);
    g.addColorStop(0, rgba(TH.ink, 0)); g.addColorStop(0.5, rgba(TH.ink, aS)); g.addColorStop(1, rgba(TH.ink, 0));
    ctx.strokeStyle = g; ctx.lineWidth = 1.4 * S; ctx.beginPath(); ctx.moveTo(x - hw, yy); ctx.lineTo(x + hw, yy); ctx.stroke(); ctx.restore();
  }
  face(ctx, x, fy, fr, failed, a, S, t);
  // 文字
  const f = font(400, 26 * S), str = failed ? '未能识别' : '识别中', full = failed ? '未能识别' : '识别中…';
  const m = meas(failed ? str : '识别中…', f, 1.5 * S);
  const by = below ? fy + fr + 36 * S : fy - fr - 16 * S;
  const tx = x - m.w / 2;
  const aTxt = a * ss(seg(t, HUD_T.scan + 0.1, HUD_T.scan + 0.3));
  if (failed) glowText(ctx, str, tx, by, f, TH.hi, aTxt, S, { ls: 1.5 * S });
  else {
    const mm = meas(str, f, 1.5 * S);
    glowText(ctx, str, tx, by, f, TH.ink, aTxt, S, { ls: 1.5 * S });
    // 省略号三个点依次亮起（字本身不变，TEXTS 始终报完整的「识别中…」）
    for (let i = 0; i < 3; i++) {
      const ph = ((t - HUD_T.scan) * 2.2 - i * 0.22) % 1, k = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 2);
      if (DRAW) { ctx.save(); ctx.shadowColor = rgba(TH.glow, aTxt * 0.5); ctx.shadowBlur = 6 * S; ctx.fillStyle = rgba(TH.ink, aTxt * k);
        ctx.beginPath(); ctx.arc(tx + mm.w + (5 + i * 8) * S, by - 3 * S, 2 * S, 0, 7); ctx.fill(); ctx.restore(); }
    }
  }
  rec('hud-recog', full, tx, by - m.asc, tx + m.w, by + m.desc, aTxt);
}
function face(ctx, x, y, r, failed, a, S, t) {
  if (!DRAW || a <= 0.003) return;
  ctx.save(); ctx.fillStyle = rgba(TH.fill, 0.45 * a); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.restore();
  glowStroke(ctx, c => c.arc(x, y, r, 0, 2 * Math.PI), TH.ink, a, 1.8 * S, S);
  const ex = r * 0.36, ey = y + r * 0.02, ew = r * 0.2;
  glowStroke(ctx, c => {
    for (const sx of [-1, 1]) {
      if (failed) { c.moveTo(x + sx * ex - ew, ey + r * 0.06); c.lineTo(x + sx * ex + ew, ey + r * 0.06); }
      else { c.moveTo(x + sx * ex - ew, ey + r * 0.08); c.arc(x + sx * ex, ey + r * 0.08, ew, Math.PI, 0); }
    }
  }, TH.ink, a, 1.6 * S, S, 0.3);
}

// ───────────────────────── 3. 导航线：沿 s.nav 一笔画出 ─────────────────────────
// 把稀疏折线做 Catmull-Rom 平滑，再按弧长重采样
function smoothPath(pts) {
  const P = pts.map(p => [p.x, p.y]); if (P.length < 2) return null;
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let k = 0; k < 16; k++) {
      const u = k / 16, u2 = u * u, u3 = u2 * u;
      out.push([0, 1].map(d => 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * u + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u3)));
    }
  }
  out.push(P[P.length - 1]);
  const L = [0]; for (let i = 1; i < out.length; i++) L.push(L[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  return { pts: out, L, total: L[L.length - 1] };
}
function pointAt(sp, d) {
  const { pts, L } = sp; if (d <= 0) return pts[0]; if (d >= sp.total) return pts[pts.length - 1];
  let i = 1; while (L[i] < d) i++;
  const u = (d - L[i - 1]) / (L[i] - L[i - 1] || 1);
  return [lerp(pts[i - 1][0], pts[i][0], u), lerp(pts[i - 1][1], pts[i][1], u)];
}
function navLine(ctx, t, w, h, S, A, s) {
  if (!s?.nav || s.nav.length < 2 || t < HUD_T.navIn) return;
  const sp = smoothPath(s.nav); if (!sp || sp.total < 4) return;
  // 一笔画出：起笔快、越往天边越慢（也符合透视：远处在屏幕上走得慢）
  const u = seg(t, HUD_T.navIn, HUD_T.navDone), p = 1 - Math.pow(1 - u, 2.3);
  const tail = eio(seg(t, HUD_T.off, HUD_T.offEnd + 0.05));   // 收淡时线尾向终点收回
  const d0 = sp.total * tail, d1 = sp.total * p;
  const a = A * TH.a; if (d1 - d0 < 1 || a <= 0.002) return;
  if (DRAW) {
    // 按弧长每 5px 取一点，压力随「远近」递减：近处（江面）粗，远处（天边）细
    const press = d => Math.pow(1 - d / sp.total, 1.6) * 0.78 + 0.22;   // 压力 1 → 0.22：江面上约 8px，天边约 2px
    const pts = [];
    for (let d = d0; d < d1; d += 5 * S) { const q = pointAt(sp, d); pts.push([q[0], q[1], press(d)]); }
    const q1 = pointAt(sp, d1); pts.push([q1[0], q1[1], press(d1)]);
    if (pts.length >= 2) {
      const opt = { thinning: 0.8, smoothing: 0.5, streamline: 0, simulatePressure: false, last: true };
      const outer = inkStroke(pts, { ...opt, size: 4.6 * S }), core = inkStroke(pts, { ...opt, size: 1.7 * S });
      ctx.save();
      ctx.shadowColor = rgba(TH.glow, 0.7 * a); ctx.shadowBlur = 9 * S;
      ctx.fillStyle = rgba(TH.ink, 0.92 * a); fillPoly(ctx, outer);
      ctx.shadowBlur = 0; ctx.fillStyle = rgba(TH.hi, 0.9 * a); fillPoly(ctx, core);
      ctx.restore();
    }
    // 线头的小光点
    const hp = pointAt(sp, d1), aHead = a * (p < 1 ? 1 : 1 - 0.4 * seg(t, HUD_T.navDone, HUD_T.navDone + 0.3));
    ctx.save();
    const g = ctx.createRadialGradient(hp[0], hp[1], 0, hp[0], hp[1], 16 * S);
    g.addColorStop(0, rgba(TH.hi, 0.75 * aHead)); g.addColorStop(0.35, rgba(TH.glow, 0.32 * aHead)); g.addColorStop(1, rgba(TH.glow, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hp[0], hp[1], 16 * S, 0, 7); ctx.fill();
    ctx.fillStyle = rgba([255, 255, 255], 0.95 * aHead); ctx.beginPath(); ctx.arc(hp[0], hp[1], 3.4 * S, 0, 7); ctx.fill();
    ctx.restore();
    // 到达终点：一圈光环扩散一次
    const pr = seg(t, HUD_T.navDone, HUD_T.navDone + 0.5);
    if (pr > 0 && pr < 1) glowStroke(ctx, c => c.arc(hp[0], hp[1], lerp(5, 24, eo(pr)) * S, 0, 2 * Math.PI), TH.ink, a * 0.8 * (1 - pr), 1.4 * S, S);
  }
}
function fillPoly(ctx, poly) {
  if (poly.length < 3) return;
  ctx.beginPath(); ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath(); ctx.fill();
}

// ───────────────────────── 4. 导航卡：导航 · 吴淞口 23 km ─────────────────────────
function navCard(ctx, t, w, h, S, A, s, off) {
  if (t < HUD_T.navIn) return;
  const a = A * ss(seg(t, HUD_T.navIn, HUD_T.navIn + 0.3)) * TH.a; if (a <= 0.002) return;
  const rise = (1 - eo(seg(t, HUD_T.navIn, HUD_T.navIn + 0.45))) * 12 * S;
  const fA = font(400, 25 * S), fN = font(500, 33 * S), fU = font(400, 21 * S);
  const sA = '导航 · 吴淞口', sN = '23', sU = ' km';
  const mA = meas(sA, fA, 0.8 * S), mN = meas(sN, fN, 0.5 * S), mU = meas(sU, fU, 0.5 * S);
  const gap = 18 * S, padL = 54 * S, padR = 26 * S, ch = 60 * S;
  const cw = padL + mA.w + gap + mN.w + mU.w + padR;
  // 卡片放在导航线起点的另一侧，不压线
  const nav = s?.nav, goesLeft = nav && nav.length > 1 ? nav[nav.length - 1].x < nav[0].x : true;
  const sx = nav && nav.length ? nav[0].x : w / 2;
  let cx0 = goesLeft ? sx + 70 * S : sx - 70 * S - cw;
  cx0 = clamp(cx0, 0.115 * w, 0.885 * w - cw) + off.x;
  let cy0 = 0.845 * h - ch / 2 + rise + off.y;
  if (s?.navCardAt) { cx0 = s.navCardAt.x - cw / 2 + off.x; cy0 = s.navCardAt.y - ch / 2 + rise + off.y; }   // 合成代理可指定卡片中心
  card(ctx, cx0, cy0, cw, ch, 16 * S, a, S);
  navIcon(ctx, cx0 + 28 * S, cy0 + ch / 2, 10.5 * S, a, S);
  const tb = cy0 + ch / 2 + 9 * S;
  glowText(ctx, sA, cx0 + padL, tb, fA, TH.ink, a, S, { ls: 0.8 * S, halo: 0 });
  glowText(ctx, sN, cx0 + padL + mA.w + gap, tb + 1.5 * S, fN, TH.hi, a, S, { ls: 0.5 * S, halo: 0 });
  glowText(ctx, sU, cx0 + padL + mA.w + gap + mN.w, tb, fU, TH.ink, a, S, { ls: 0.5 * S, halo: 0 });
  rec('hud-nav', '导航 · 吴淞口 23 km', cx0 + padL, tb - mN.asc, cx0 + padL + mA.w + gap + mN.w + mU.w, tb + Math.max(mA.desc, mN.desc), a);
}
function navIcon(ctx, x, y, r, a, S) {      // 导航箭头（朝右上）
  if (!DRAW || a <= 0.003) return;
  ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
  ctx.shadowColor = rgba(TH.glow, 0.5 * a); ctx.shadowBlur = 7 * S;
  ctx.fillStyle = rgba(TH.hi, a);
  ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.78, r * 0.85); ctx.lineTo(0, r * 0.42); ctx.lineTo(-r * 0.78, r * 0.85); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ───────────────────────── 显示层入口 ─────────────────────────
let lastS = null, lastT = NaN;
export function drawHUD(ctx, t, w, h, s) {
  lastS = s; lastT = t;
  if (t < HUD_T.on || t > HUD_T.offEnd + 0.1) return;
  const S = h / 1040, A = masterAlpha(t); if (A <= 0.002) return;
  const off = headOffset(s, h);
  navLine(ctx, t, w, h, S, A, s);          // 先画线，卡片和字压在上面
  recognition(ctx, t, w, h, S, A, s);
  statusRow(ctx, t, w, h, S, A, off);
  navCard(ctx, t, w, h, S, A, s, off);
}

// ───────────────────────── 片名「北冥」：字形 + 按笔顺逐步揭开 ─────────────────────────
// 骨架是我按马善政楷书的字形手标的笔画中线（em 单位，原点 = 字的中心锚点，textAlign center / textBaseline middle），按笔顺排列。
// 预计算（每个画面尺寸一次，约 30–50 ms）：用距离变换估每一笔的半宽，字形每个像素归给「笔身包含它的、最先写的那一笔」
// （都不包含就归最近的一笔），记下它在该笔上的弧长位置和飞白系数；渲染时按时间推进每一笔的「笔锋位置」揭开像素。
const SKEL = {
  '北': [
    [[-0.172, -0.289], [-0.176, -0.167], [-0.189, 0.0], [-0.197, 0.167], [-0.198, 0.344]],                     // 竖
    [[-0.328, -0.109], [-0.278, -0.080], [-0.222, -0.056]],                                                     // 横
    [[-0.428, 0.267], [-0.322, 0.172], [-0.222, 0.056], [-0.144, -0.011], [-0.069, -0.080]],                    // 提
    [[0.250, -0.256], [0.189, -0.178], [0.122, -0.100], [0.044, 0.011], [-0.033, 0.111], [-0.098, 0.178]],      // 撇
    [[0.031, -0.344], [0.028, -0.167], [0.024, 0.056], [0.044, 0.211], [0.111, 0.300], [0.233, 0.342],
     [0.344, 0.333], [0.411, 0.278], [0.428, 0.189], [0.420, 0.100]],                                           // 竖弯钩
  ],
  '冥': [
    [[-0.267, -0.361], [-0.294, -0.278], [-0.324, -0.200], [-0.337, -0.139]],                                   // 点（冖）
    [[-0.239, -0.353], [-0.111, -0.376], [0.056, -0.380], [0.233, -0.364], [0.333, -0.331], [0.353, -0.294],
     [0.300, -0.264], [0.217, -0.247], [0.172, -0.236]],                                                        // 横钩（冖）
    [[-0.139, -0.239], [-0.136, -0.111], [-0.133, -0.022], [-0.131, 0.050]],                                    // 竖（日）
    [[-0.117, -0.239], [-0.022, -0.258], [0.089, -0.253], [0.156, -0.228], [0.131, -0.111], [0.128, -0.011], [0.109, 0.050]], // 横折（日）
    [[-0.111, -0.139], [-0.044, -0.156], [0.024, -0.153]],                                                      // 横（日）
    [[-0.106, -0.011], [-0.022, -0.017], [0.056, -0.006]],                                                      // 横（日）
    [[-0.076, 0.047], [-0.033, 0.083], [0.013, 0.117]],                                                         // 点（六）
    [[-0.250, 0.191], [-0.144, 0.169], [0.011, 0.156], [0.167, 0.144], [0.267, 0.158]],                         // 横（六）
    [[-0.076, 0.250], [-0.144, 0.333], [-0.222, 0.409], [-0.291, 0.458]],                                       // 撇（六）
    [[0.091, 0.272], [0.156, 0.333], [0.217, 0.400], [0.258, 0.444]],                                           // 点（六）
  ],
};
// 每一笔的飞白强度（0 = 不露白），按笔顺；只给收笔快的笔画（提、撇、长横、钩）
const DRY = { '北': [0, 0, 0.7, 0.6, 0.45], '冥': [0, 0.4, 0, 0.25, 0, 0, 0, 0.5, 0.7, 0.35] };
const hash1 = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
const vnoise = x => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash1(i), hash1(i + 1), u); };
export const __TITLE_SKEL = SKEL;   // 以下两个只给自测页叠骨架用
export const __titleLayout = (w, h) => titleLayout(w, h);
// 把骨架折线加密成平滑曲线（Catmull-Rom）
function densify(P) {
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let k = 0; k < 8; k++) {
      const u = k / 8, u2 = u * u, u3 = u2 * u;
      out.push([0, 1].map(d => 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * u + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u3)));
    }
  }
  out.push(P[P.length - 1]);
  const L = [0]; for (let i = 1; i < out.length; i++) L.push(L[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  return { pts: out, L, total: L[L.length - 1] };
}
// 点到加密骨架的最近距离与投影弧长
function project(sk, x, y) {
  let best = 1e9, bs = 0, side = 1;
  const { pts, L } = sk;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
    const u = clamp(((x - ax) * dx + (y - ay) * dy) / l2);
    const px = ax + u * dx - x, py = ay + u * dy - y, d = px * px + py * py;
    if (d < best) { best = d; bs = L[i] + u * (L[i + 1] - L[i]); side = dx * (y - ay) - dy * (x - ax) >= 0 ? 1 : -1; }
  }
  return [Math.sqrt(best), bs, side];   // 距离、投影弧长、在骨架哪一侧
}
const TITLE_CACHE = new Map();
// 倒角距离变换：字形内每个像素到字形边缘的距离（像素），用来估每一笔的半宽
function chamfer(inside, W, H) {
  const d = new Float32Array(W * H), D = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? 1e9 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!d[i]) continue; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) { v = Math.min(v, d[i - W] + 1); if (x > 0) v = Math.min(v, d[i - W - 1] + D); if (x < W - 1) v = Math.min(v, d[i - W + 1] + D); }
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!d[i]) continue; let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < H - 1) { v = Math.min(v, d[i + W] + 1); if (x < W - 1) v = Math.min(v, d[i + W + 1] + D); if (x > 0) v = Math.min(v, d[i + W - 1] + D); }
    d[i] = v;
  }
  return d;
}
function buildGlyph(ch, F, span) {
  const sks = SKEL[ch].map(densify);
  const size = Math.ceil(F * 1.12), cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.font = font(400, F, 'title'); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff';
  c.fillText(ch, size / 2, size / 2);
  const src = c.getImageData(0, 0, size, size).data;
  const inside = new Uint8Array(size * size); for (let i = 0; i < inside.length; i++) inside[i] = src[i * 4 + 3] > 127 ? 1 : 0;
  const dt = chamfer(inside, size, size);
  // 每一笔的半宽（em）：沿骨架采样距离变换取 70 分位
  const hw = sks.map(sk => {
    const v = [];
    for (const [u, w2] of sk.pts) { const x = Math.round(u * F + size / 2), y = Math.round(w2 * F + size / 2); if (x >= 0 && y >= 0 && x < size && y < size && dt[y * size + x] > 0) v.push(dt[y * size + x]); }
    v.sort((a, b) => a - b); return (v.length ? v[Math.floor(v.length * 0.7)] : 0.03 * F) / F;
  });
  const idx = [], ks = [], sv = [], al = [], dr = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const A = src[(y * size + x) * 4 + 3]; if (!A) continue;
    const ex = (x + 0.5 - size / 2) / F, ey = (y + 0.5 - size / 2) / F;
    const res = sks.map(sk => project(sk, ex, ey));
    // 像素落在哪几笔的笔身里，就归给其中最先写的那一笔（交叉处由先落笔的一画盖住）；都不在就归最近的一笔
    let k = res.findIndex((r, i) => r[0] <= hw[i] * 1.12 + 1.2 / F);
    if (k < 0) { let m = 1e9; res.forEach((r, i) => { if (r[0] < m) { m = r[0]; k = i; } }); }
    idx.push(y * size + x); ks.push(k); sv.push(res[k][1]); al.push(A);
    // 飞白：笔画收尾处，沿笔势方向出现几道断续的露白（毛笔枯笔）。垂直偏移归一到笔宽 [-1,1]，按「笔毛」分道取值噪声
    const amt = ((DRY[ch] || [])[k] || 0) * TITLE_CFG.dry;
    if (amt > 0) {
      const sk = sks[k], u = res[k][1] / sk.total, pv = res[k][2] * res[k][0] / Math.max(hw[k], 1e-3);
      const dry = amt * ss(seg(u, 0.5, 0.97)) * (0.65 + 0.35 * vnoise(res[k][1] * F / 26 + k * 3.1));
      const n = vnoise(pv * 4.6 + k * 7.3 + 11), thr = dry * 0.62;
      dr.push(Math.round(255 * ss(seg(n, thr - 0.07, thr + 0.07))));
    } else dr.push(255);
  }
  // 每一笔的起止时间：总时长按「笔画长度 + 顿笔常数」分配，笔与笔之间留一点提笔间隙
  const n = sks.length, gapT = 0.012, wts = sks.map(sk => sk.total + 0.14), sw = wts.reduce((a, b) => a + b, 0);
  const avail = (span[1] - span[0]) - gapT * (n - 1);
  let tt = span[0];
  const strokes = sks.map((sk, i) => { const d = avail * wts[i] / sw, r = { L: sk.total, t0: tt, t1: tt + d }; tt += d + gapT; return r; });
  const out = document.createElement('canvas'); out.width = out.height = size;
  const octx = out.getContext('2d');
  return { size, idx: Int32Array.from(idx), k: Uint8Array.from(ks), s: Float32Array.from(sv), a: Uint8Array.from(al), dry: Uint8Array.from(dr), strokes, out, octx, img: octx.createImageData(size, size) };
}
// 片名版式（画面比例）：x = 片名左缘，y = 字的中线，size = 字号 / 画面高；shade = 字下面加一层冷色暗晕（0–1，背景太亮时用）；
// dry = 飞白强度倍数（0 = 关掉枯笔露白，1 = 默认）
const TITLE_CFG = { x: 0.105, y: 0.262, size: 288 / 1040, shade: 0, dry: 1 };
export function setTitleLayout(o = {}) { Object.assign(TITLE_CFG, o); }
function titleLayout(w, h) {
  const S = h / 1040, F = TITLE_CFG.size * h;
  const xB = TITLE_CFG.x * w + 0.462 * F, xM = xB + 0.90 * F, yc = TITLE_CFG.y * h;
  return { S, F, glyphs: [['北', xB, yc, HUD_T.titleA], ['冥', xM, yc, HUD_T.titleB]],
    box: [xB - 0.47 * F, yc - 0.42 * F, xM + 0.38 * F, yc + 0.47 * F], subY: yc + 0.47 * F + 62 * S, subX: xB - 0.43 * F };
}
const SUB = 'AI 眼镜 · 品牌短片 · 概念样片';
// 副标题分段排：字距 4px，「·」两侧留固定空隙（整串带字距会把间隔点拉得太散）
function subLayout(ctx, S) {
  const f = `300 ${(25 * S).toFixed(2)}px "${FAM_SC}", sans-serif`, ls = 4 * S, gap = 15 * S;
  const parts = ['AI 眼镜', '·', '品牌短片', '·', '概念样片'];
  let x = 0, asc = 0, desc = 0; const out = [];
  for (const p of parts) { const m = meas(p, f, ls); out.push([p, x]); x += m.w - ls + gap; asc = Math.max(asc, m.asc); desc = Math.max(desc, m.desc); }
  return { f, ls, parts: out, w: x - gap, asc, desc };
}
export function drawTitle(ctx, t, w, h) {
  if (t < HUD_T.titleA[0]) return;
  const L = titleLayout(w, h), key = [w, h, L.F.toFixed(2), TITLE_CFG.dry, HUD_T.titleA, HUD_T.titleB].join('|');   // 改了 HUD_T 的书写区间也会重算
  if (!fontsReady && !document.fonts.check(font(400, 40, 'title'))) return;
  if (!TITLE_CACHE.has(key)) TITLE_CACHE.set(key, L.glyphs.map(([ch, , , span]) => buildGlyph(ch, L.F, span)));
  const G = TITLE_CACHE.get(key), ws = 0.035;   // 笔锋前沿的柔边宽度（em）
  ctx.save();
  // 只画阴影不画图：图本身挪到画布外，靠 shadowOffset 把阴影送回原位（避免字边被叠画两遍变粗）
  const shadowOnly = (img, x, y, color, blur) => {
    const far = 4 * w, m = ctx.getTransform();          // shadowOffset 不受变换影响：按当前缩放换算（只支持缩放/平移的 ctx）
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur * m.a; ctx.shadowOffsetX = far * m.a;
    ctx.drawImage(img, x - far, y); ctx.restore();
  };
  L.glyphs.forEach(([, x, y], gi) => {
    const g = G[gi], d = g.img.data; d.fill(0);
    const front = g.strokes.map(st => t <= st.t0 ? -1 : t >= st.t1 ? st.L + 1 : st.L * ss((t - st.t0) / (st.t1 - st.t0)));
    let any = false;
    for (let j = 0; j < g.idx.length; j++) {
      const f = front[g.k[j]]; if (f < 0) continue;
      const v = clamp((f - g.s[j]) / ws + 0.5); if (v <= 0) continue;
      const o = g.idx[j] * 4; d[o] = 255; d[o + 1] = 252; d[o + 2] = 246; d[o + 3] = g.a[j] * v * g.dry[j] / 255; any = true;
    }
    if (!any) return;
    g.octx.putImageData(g.img, 0, 0);
    const gx = x - g.size / 2, gy = y - g.size / 2;
    if (TITLE_CFG.shade > 0) shadowOnly(g.out, gx, gy + 4 * L.S, `rgba(28,30,78,${(0.45 * TITLE_CFG.shade).toFixed(3)})`, 26 * L.S);
    // 白字 + 极淡的暖色光晕（外圈大而淡，内圈小）
    shadowOnly(g.out, gx, gy, 'rgba(255,190,140,0.55)', 38 * L.S);
    shadowOnly(g.out, gx, gy, 'rgba(255,214,180,0.45)', 10 * L.S);
    ctx.drawImage(g.out, gx, gy);
  });
  // 副标题
  const aSub = ss(seg(t, HUD_T.subIn, HUD_T.subFull));
  if (aSub > 0.003) {
    const sl = subLayout(ctx, L.S), yy = L.subY + (1 - eo(seg(t, HUD_T.subIn, HUD_T.subFull + 0.1))) * 8 * L.S;
    ctx.font = sl.f; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; if ('letterSpacing' in ctx) ctx.letterSpacing = `${sl.ls.toFixed(2)}px`;
    ctx.shadowColor = `rgba(255,196,150,${(0.5 * aSub).toFixed(3)})`; ctx.shadowBlur = 12 * L.S;
    ctx.fillStyle = `rgba(255,250,244,${(0.92 * aSub).toFixed(3)})`;
    for (const [p, dx] of sl.parts) ctx.fillText(p, L.subX + dx, yy);
  }
  ctx.restore();
}

// ───────────────────────── 文字报告（window.TEXTS） ─────────────────────────
// s 可不传：沿用同一帧 drawHUD 收到的 s（渲染器的文字检查 总是先 render(t) 再 TEXTS(t)）
export function textsAt(t, w, h, s) {
  if (s === undefined) s = lastT === t ? lastS : null;
  const out = [];
  if (t >= HUD_T.on && t <= HUD_T.offEnd + 0.1) {
    const S = h / 1040, A = masterAlpha(t), off = headOffset(s, h), ctx = mctx();
    DRAW = false; REC = out;
    try { recognition(ctx, t, w, h, S, A, s); statusRow(ctx, t, w, h, S, A, off); navCard(ctx, t, w, h, S, A, s, off); }
    finally { DRAW = true; REC = null; }
  }
  if (t > HUD_T.titleA[0]) {
    const L = titleLayout(w, h);
    out.push({ id: 'title', text: '北冥', x0: Math.floor(L.box[0]), y0: Math.floor(L.box[1]), x1: Math.ceil(L.box[2]), y1: Math.ceil(L.box[3]) });
    const aSub = ss(seg(t, HUD_T.subIn, HUD_T.subFull));
    if (aSub > 0.02) {
      const sl = subLayout(mctx(), L.S);
      out.push({ id: 'subtitle', text: SUB, x0: Math.floor(L.subX), y0: Math.floor(L.subY - sl.asc), x1: Math.ceil(L.subX + sl.w), y1: Math.ceil(L.subY + sl.desc + 8 * L.S) });
    }
  }
  return out;
}
