// AI 眼镜显示层 + 片名「北冥」（2D canvas，叠在最终画面最上层，不经过任何后期）
//
// 导出：
//   loadHUDFonts()                 加载 fonts/ 里的字体子集（READY 之前 await 它）
//   drawHUD(ctx, t, w, h, s)       显示层：镜头 C（5.0–9.2）、镜头 D（10.2–14.6）、镜头 E（15.2–18.5）三个时间窗
//   drawTitle(ctx, t, w, h)        片名，默认 27.4 起一笔一笔写出（可改 HUD_T）
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
// 通用部分在 engine/overlay/（辉光字与描线、卡片、文字记录、小部件路径、毛笔写字）和 engine/paint/curve.js（平滑与弧长），
// 这里只留本片显示层的布局、文案、时间表、配色和片名字的骨架。
import { inkStroke } from '../engine/core/stroke.js';
import { clamp, lerp, seg, ss, eo, eio } from '../engine/core/math.js';
import { catmullRom, pointAt, spanPoints } from '../engine/paint/curve.js';
import { fillPoly } from '../engine/paint/path.js';
import { shadowOnly } from '../engine/paint/canvas.js';
import { loadFonts, fontSpec, rgba, measure as meas, measureContext as mctx, createOverlay } from '../engine/overlay/text.js';
import { brackets, arcGap, swayOffset } from '../engine/overlay/widgets.js';
import { buildBrushGlyph, paintBrushGlyph } from '../engine/overlay/brush.js';

// ───────────────────────── 字体 ─────────────────────────
const FAM_LAT = 'BM HUD Latin';   // Barlow：数字与西文（接近 AI 眼镜界面里 DIN 风格的数字）
const FAM_SC = 'BM HUD SC';       // Noto Sans SC 可变字重子集：中文
const FAM_TITLE = 'BM Title';     // 马善政毛笔楷书：片名
const fontURL = f => new URL(`../fonts/${f}`, import.meta.url).href;
let fontsReady = false;

export async function loadHUDFonts() {
  await loadFonts([
    [FAM_LAT, fontURL('Barlow-300.woff2'), '300'], [FAM_LAT, fontURL('Barlow-400.woff2'), '400'], [FAM_LAT, fontURL('Barlow-500.woff2'), '500'],
    [FAM_SC, fontURL('NotoSansSC-var.woff2'), '300 500'],
    [FAM_TITLE, fontURL('MaShanZheng-400.woff2'), '400'],
  ]);
  fontsReady = true;
}
const font = (wt, px, fam = 'ui') => fontSpec(wt, px, fam === 'title' ? [FAM_TITLE] : [FAM_LAT, FAM_SC]);

// ───────────────────────── 时间轴（全局秒） ─────────────────────────
export const HUD_T = {
  // 镜头 C（5.0–9.2s）
  on: 5.0, off: 8.9, offEnd: 9.2,             // 显示层整体出现 / 开始收淡 / 完全消失
  clockIn: 5.0, remindIn: 5.2,                // 左上时间、提醒卡
  scan: 5.45, scanLock: 5.9, fail: 6.25,      // 识别框出现、收拢到位、变成「未能识别」
  scanOut: 6.78, scanGone: 7.0,               // 识别框收起（7.0 前收完，保证同时最多 2 行字）
  navIn: 7.0, navDone: 8.4,                   // 导航卡出现、导航线画完
  // 镜头 D（10.2–14.6s）
  dOn: 10.2, dOnEnd: 10.5, dOff: 14.3, dOffEnd: 14.6,
  dNavIn: 10.2, dNavDone: 11.6,
  // 镜头 E（15.2–18.5s）
  eOn: 15.2, eOnEnd: 15.45, eDim: 15.6, eDimEnd: 15.95, eOff: 18.2, eOffEnd: 18.5,
  // 片名「北冥」（默认 30s 正片；?dur=10 时由 main.js 通过 Object.assign 覆盖）
  titleA: [27.4, 27.85], titleB: [27.9, 28.45],
  subIn: 28.2, subFull: 28.85,
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
const O = createOverlay(TH);   // 显示层画笔：辉光字、辉光描线、卡片、文字方框记录
const { glowText, glowStroke, card, rec } = O;
export function setHUDTheme(name) { TH = O.theme = THEMES[name] || THEMES.mono; }

// ───────────────────────── 头部微晃：屏幕固定元素的反向浮动 ─────────────────────────
// 约 35mm 等效（竖直视场 ~38°）下 1 弧度对应的像素，乘一个小增益：0.5° 晃动 ≈ 2–3 像素
const headOffset = (s, h) => swayOffset(s?.head, h, { fov: 38, gain: 0.18 });

function hudWindow(t) {
  if (t >= HUD_T.on && t <= HUD_T.offEnd + 0.1) {
    const A = ss(seg(t, HUD_T.on, HUD_T.on + 0.18)) * (1 - ss(seg(t, HUD_T.off, HUD_T.offEnd)));
    return {
      id: 'C', A, clock: '05:54', clockIn: HUD_T.clockIn, cardIn: HUD_T.remindIn, icon: 'bell',
      cardText: '远洋聘书 · 回复截止 06:00',
      parts: [['远洋聘书', 'a', 'ink', 1], [' · 回复截止 ', 'a', 'ink', 0.66], ['06:00', 'b', 'hi', 1]],
      recog: true,
      nav: { in: HUD_T.navIn, done: HUD_T.navDone, off: HUD_T.off, offEnd: HUD_T.offEnd, dist: '23', delayFade: true },
    };
  }
  if (t >= HUD_T.dOn && t <= HUD_T.dOffEnd + 0.05) {
    const A = ss(seg(t, HUD_T.dOn, HUD_T.dOnEnd)) * (1 - ss(seg(t, HUD_T.dOff, HUD_T.dOffEnd)));
    return {
      id: 'D', A, clock: '05:56', clockIn: HUD_T.dOn, cardIn: HUD_T.dOn + 0.02, icon: 'alert',
      cardText: '偏离既定航线 · 航向 072° 东海',
      parts: [['偏离既定航线', 'a', 'hi', 1], [' · 航向 ', 'a', 'ink', 0.66], ['072°', 'b', 'hi', 1], [' 东海', 'a', 'ink', 1]],
      recog: false,
      nav: { in: HUD_T.dNavIn, done: HUD_T.dNavDone, off: HUD_T.dOff, offEnd: HUD_T.dOffEnd, dist: '11', delayFade: false },
    };
  }
  if (t >= HUD_T.eOn && t <= HUD_T.eOffEnd + 0.05) {
    const A = ss(seg(t, HUD_T.eOn, HUD_T.eOnEnd))
      * lerp(1, 0.65, ss(seg(t, HUD_T.eDim, HUD_T.eDimEnd)))
      * (1 - ss(seg(t, HUD_T.eOff, HUD_T.eOffEnd)));
    return {
      id: 'E', A, clock: '05:58', clockIn: HUD_T.eOn, cardIn: HUD_T.eOn + 0.02, icon: 'power',
      cardText: '全船照明 · 已关闭 · 航行灯保持',
      parts: [['全船照明', 'a', 'ink', 0.85], [' · ', 'a', 'ink', 0.55], ['已关闭', 'c', 'hi', 1], [' · ', 'a', 'ink', 0.55], ['航行灯保持', 'a', 'ink', 0.9]],
      recog: false, nav: null,
    };
  }
  return null;
}

// ───────────────────────── 1. 左上：时间 + 状态卡（同一行） ─────────────────────────
function statusRow(ctx, t, w, h, S, A, off, win) {
  const isC = win.id === 'C';
  const aClock = A * (isC ? ss(seg(t, win.clockIn, win.clockIn + 0.3)) : 1) * TH.a;
  const aCard = A * (isC ? ss(seg(t, win.cardIn, win.cardIn + 0.12)) : 1) * TH.a;
  if (aClock <= 0.002 && aCard <= 0.002) return;
  const X = 0.115 * w + off.x, Yc = 0.125 * h + off.y;     // 显示区左上角（不贴画框边，像是浮在镜片里）
  // 时间
  const fT = font(300, 48 * S), mT = meas(win.clock, fT, 1 * S), base = Yc + 17 * S;
  glowText(ctx, win.clock, X, base, fT, TH.ink, aClock, S, { ls: 1 * S });
  rec('hud-clock', win.clock, X, base - mT.asc, X + mT.w, base + mT.desc, aClock);
  // 胶囊卡：图标 + 两级文字层次
  const cx0 = X + mT.w + 26 * S, ch = 48 * S, cy0 = Yc - ch / 2;
  const fonts = { a: font(400, 23 * S), b: font(500, 25 * S), c: font(500, 23 * S) }, ls = 0.6 * S;
  const parts = win.parts.map(([str, fk, ck, k]) => [str, fonts[fk], TH[ck], k]);
  const ms = parts.map(([str, f]) => meas(str, f, ls)), tw = ms.reduce((a, m) => a + m.w, 0);
  const padL = 48 * S, padR = 24 * S, cw = padL + tw + padR;
  const pop = eo(seg(t, win.cardIn, win.cardIn + 0.16));
  const unfold = eio(seg(t, win.cardIn + 0.05, win.cardIn + (isC ? 0.36 : 0.30)));
  const cwNow = lerp(ch, cw, unfold), sc = lerp(0.6, 1, pop);
  if (O.draw && aCard > 0.003) {
    ctx.save();
    ctx.translate(cx0 + ch / 2, Yc); ctx.scale(sc, sc); ctx.translate(-(cx0 + ch / 2), -Yc);
    card(ctx, cx0, cy0, cwNow, ch, ch / 2, aCard, S);
    if (win.icon === 'bell') {
      const ring = Math.sin(seg(t, win.cardIn + 0.1, win.cardIn + 0.7) * Math.PI * 4) * (1 - seg(t, win.cardIn + 0.1, win.cardIn + 0.7)) * 0.35;
      bell(ctx, cx0 + 26 * S, Yc, 9 * S, ring, aCard, S);
    } else if (win.icon === 'alert') {
      alertIcon(ctx, cx0 + 26 * S, Yc, 9 * S, aCard, S);
    } else if (win.icon === 'power') {
      powerIcon(ctx, cx0 + 26 * S, Yc, 9 * S, aCard, S);
    }
    ctx.beginPath(); ctx.rect(cx0, cy0 - 10 * S, cwNow - padR * 0.5, ch + 20 * S); ctx.clip();   // 文字随卡片展开露出
    const tb = Yc + 8.5 * S;
    let xx = cx0 + padL;
    parts.forEach(([str, f, col, k], i) => { glowText(ctx, str, xx, tb, f, col, aCard * k * ss(seg(unfold, 0.25, 0.9)), S, { ls, halo: 0 }); xx += ms[i].w; });
    ctx.restore();
  }
  const tb = Yc + 8.5 * S;
  rec('hud-remind', win.cardText, cx0 + padL, tb - Math.max(...ms.map(m => m.asc)), cx0 + padL + tw, tb + Math.max(...ms.map(m => m.desc)), aCard * ss(seg(unfold, 0.25, 0.9)));
}
function bell(ctx, x, y, r, rot, a, S) {
  if (!O.draw || a <= 0.003) return;
  glowStroke(ctx, c => {
    c.translate(x, y - r * 0.9); c.rotate(rot); c.translate(0, r * 0.9);
    c.moveTo(-r, r * 0.55); c.quadraticCurveTo(-r * 0.86, r * 0.3, -r * 0.82, -r * 0.1);
    c.bezierCurveTo(-r * 0.8, -r * 0.95, r * 0.8, -r * 0.95, r * 0.82, -r * 0.1);
    c.quadraticCurveTo(r * 0.86, r * 0.3, r, r * 0.55); c.closePath();
    c.moveTo(-r * 0.22, r * 0.85); c.lineTo(r * 0.22, r * 0.85);
    c.moveTo(0, -r * 0.72); c.lineTo(0, -r * 0.95);
  }, TH.ink, a, 1.6 * S, S, 0.4);
}
function alertIcon(ctx, x, y, r, a, S) {
  if (!O.draw || a <= 0.003) return;
  glowStroke(ctx, c => {
    c.moveTo(x, y - r * 0.86); c.lineTo(x + r * 0.92, y + r * 0.72); c.lineTo(x - r * 0.92, y + r * 0.72); c.closePath();
    c.moveTo(x, y - r * 0.28); c.lineTo(x, y + r * 0.18);
    c.moveTo(x, y + r * 0.44); c.lineTo(x, y + r * 0.47);
  }, TH.hi, a, 1.6 * S, S, 0.4);
}
function powerIcon(ctx, x, y, r, a, S) {
  if (!O.draw || a <= 0.003) return;
  glowStroke(ctx, c => {
    c.arc(x, y + r * 0.08, r * 0.78, -Math.PI * 0.3, Math.PI * 1.3);
    c.moveTo(x, y - r * 0.86); c.lineTo(x, y + r * 0.04);
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
  glowStroke(ctx, c => { c.translate(x, y); c.rotate(rot); brackets(c, H, arm); }, lock > 0.05 ? TH.hi : TH.ink, a * dim, (2.4 + 1.2 * lock) * S, S, 0.6 + 0.4 * lock);
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
    glowStroke(ctx, c => arcGap(c, x, y, R, a0, a0 + 2 * Math.PI, gc, gh), TH.ink, aArc * 0.16, 1.2 * S, S, 0);   // 弧的底轨
    glowStroke(ctx, c => arcGap(c, x, y, R, a0, a1, gc, gh), TH.ink, aArc * 0.9, 1.6 * S, S);
    if (O.draw) { ctx.save(); ctx.shadowColor = rgba(TH.glow, aArc); ctx.shadowBlur = 8 * S; ctx.fillStyle = rgba(TH.hi, aArc);
      ctx.beginPath(); ctx.arc(x + R * Math.cos(a1), y + R * Math.sin(a1), 2.6 * S, 0, 7); ctx.fill(); ctx.restore(); }
  }
  // 扫描线：识别中自上而下扫一遍（AI 眼镜购物识别界面的扫描线）
  const ps = seg(t, HUD_T.scanLock - 0.1, HUD_T.fail - 0.05);
  if (O.draw && ps > 0 && ps < 1) {
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
      if (O.draw) { ctx.save(); ctx.shadowColor = rgba(TH.glow, aTxt * 0.5); ctx.shadowBlur = 6 * S; ctx.fillStyle = rgba(TH.ink, aTxt * k);
        ctx.beginPath(); ctx.arc(tx + mm.w + (5 + i * 8) * S, by - 3 * S, 2 * S, 0, 7); ctx.fill(); ctx.restore(); }
    }
  }
  rec('hud-recog', full, tx, by - m.asc, tx + m.w, by + m.desc, aTxt);
}
function face(ctx, x, y, r, failed, a, S, t) {
  if (!O.draw || a <= 0.003) return;
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
// 稀疏折线 → Catmull-Rom 平滑（每段 16 份），之后按弧长取点
const smoothPath = pts => pts.length < 2 ? null : catmullRom(pts.map(p => [p.x, p.y]), 16);
function navLine(ctx, t, w, h, S, A, s, navCfg) {
  if (!s?.nav || s.nav.length < 2 || t < navCfg.in) return;
  const sp = smoothPath(s.nav); if (!sp || sp.total < 4) return;
  // 一笔画出：起笔快、越往天边越慢（也符合透视：远处在屏幕上走得慢）
  const u = seg(t, navCfg.in, navCfg.done), p = 1 - Math.pow(1 - u, 2.3);
  const tail = eio(seg(t, navCfg.off, navCfg.offEnd + 0.05));   // 收淡时线尾向终点收回
  const d0 = sp.total * tail, d1 = sp.total * p;
  const a = A * TH.a; if (d1 - d0 < 1 || a <= 0.002) return;
  if (O.draw) {
    // 按弧长每 5px 取一点，压力随「远近」递减：近处（江面）粗，远处（天边）细
    const press = d => Math.pow(1 - d / sp.total, 1.6) * 0.78 + 0.22;   // 压力 1 → 0.22：江面上约 8px，天边约 2px
    const pts = spanPoints(sp, d0, d1, 5 * S, press);
    if (pts.length >= 2) {
      const opt = { thinning: 0.8, streamline: 0 };
      const outer = inkStroke(pts, { ...opt, size: 4.6 * S }), core = inkStroke(pts, { ...opt, size: 1.7 * S });
      ctx.save();
      ctx.shadowColor = rgba(TH.glow, 0.7 * a); ctx.shadowBlur = 9 * S;
      ctx.fillStyle = rgba(TH.ink, 0.92 * a); fillPoly(ctx, outer);
      ctx.shadowBlur = 0; ctx.fillStyle = rgba(TH.hi, 0.9 * a); fillPoly(ctx, core);
      ctx.restore();
    }
    // 线头的小光点
    const hp = pointAt(sp, d1), aHead = a * (p < 1 ? 1 : 1 - 0.4 * seg(t, navCfg.done, navCfg.done + 0.3));
    ctx.save();
    const g = ctx.createRadialGradient(hp[0], hp[1], 0, hp[0], hp[1], 16 * S);
    g.addColorStop(0, rgba(TH.hi, 0.75 * aHead)); g.addColorStop(0.35, rgba(TH.glow, 0.32 * aHead)); g.addColorStop(1, rgba(TH.glow, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hp[0], hp[1], 16 * S, 0, 7); ctx.fill();
    ctx.fillStyle = rgba([255, 255, 255], 0.95 * aHead); ctx.beginPath(); ctx.arc(hp[0], hp[1], 3.4 * S, 0, 7); ctx.fill();
    ctx.restore();
    // 到达终点：一圈光环扩散一次
    const pr = seg(t, navCfg.done, navCfg.done + 0.5);
    if (pr > 0 && pr < 1) glowStroke(ctx, c => c.arc(hp[0], hp[1], lerp(5, 24, eo(pr)) * S, 0, 2 * Math.PI), TH.ink, a * 0.8 * (1 - pr), 1.4 * S, S);
  }
}
// ───────────────────────── 4. 导航卡：导航 · 吴淞口 23 / 11 km ─────────────────────────
function navCard(ctx, t, w, h, S, A, s, off, navCfg) {
  if (t < navCfg.in) return;
  const a = A * (navCfg.delayFade ? ss(seg(t, navCfg.in, navCfg.in + 0.3)) : 1) * TH.a;
  if (a <= 0.002) return;
  const rise = (1 - eo(seg(t, navCfg.in, navCfg.in + 0.45))) * 12 * S;
  const fA = font(400, 25 * S), fN = font(500, 33 * S), fU = font(400, 21 * S);
  const sA = '导航 · 吴淞口', sN = navCfg.dist, sU = ' km';
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
  rec('hud-nav', `${sA} ${sN}${sU}`, cx0 + padL, tb - mN.asc, cx0 + padL + mA.w + gap + mN.w + mU.w, tb + Math.max(mA.desc, mN.desc), a);
}
function navIcon(ctx, x, y, r, a, S) {      // 导航箭头（朝右上）
  if (!O.draw || a <= 0.003) return;
  ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
  ctx.shadowColor = rgba(TH.glow, 0.5 * a); ctx.shadowBlur = 7 * S;
  ctx.fillStyle = rgba(TH.hi, a);
  ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.78, r * 0.85); ctx.lineTo(0, r * 0.42); ctx.lineTo(-r * 0.78, r * 0.85); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ───────────────────────── 显示层入口 ─────────────────────────
let lastS = null, lastT = NaN;
function renderHUD(ctx, t, w, h, s, collectOnly = false) {
  const win = hudWindow(t);
  if (!win || win.A <= 0.002) return;
  const S = h / 1040, off = headOffset(s, h);
  if (win.nav && !collectOnly) navLine(ctx, t, w, h, S, win.A, s, win.nav);   // 先画线，卡片和字压在上面
  if (win.recog) recognition(ctx, t, w, h, S, win.A, s);
  statusRow(ctx, t, w, h, S, win.A, off, win);
  if (win.nav) navCard(ctx, t, w, h, S, win.A, s, off, win.nav);
}
export function drawHUD(ctx, t, w, h, s) {
  lastS = s; lastT = t;
  renderHUD(ctx, t, w, h, s, false);
}

// ───────────────────────── 片名「北冥」：字形 + 按笔顺逐步揭开 ─────────────────────────
// 骨架是我按马善政楷书的字形手标的笔画中线（em 单位，原点 = 字的中心锚点，textAlign center / textBaseline middle），按笔顺排列。
// 书写本身由 engine/overlay/brush.js 完成（每个画面尺寸预计算一次，约 30–50 ms），这里只给骨架、飞白和书写区间。
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
export const __TITLE_SKEL = SKEL;   // 以下两个只给自测页叠骨架用
export const __titleLayout = (w, h) => titleLayout(w, h);
const TITLE_CACHE = new Map();
const buildGlyph = (ch, F, span) => buildBrushGlyph(ch, { font: font(400, F, 'title'), size: F, strokes: SKEL[ch], span, dry: DRY[ch] || [], dryScale: TITLE_CFG.dry });
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
  const f = fontSpec(300, 25 * S, [FAM_SC]), ls = 4 * S, gap = 15 * S;
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
  const G = TITLE_CACHE.get(key), far = 4 * w;
  ctx.save();
  // 光晕只画阴影不画图（engine/paint/canvas.js 的 shadowOnly），避免字边被叠画两遍变粗
  L.glyphs.forEach(([, x, y], gi) => {
    const g = G[gi];
    if (!paintBrushGlyph(g, t, { edge: 0.035, rgb: [255, 252, 246] })) return;
    const gx = x - g.size / 2, gy = y - g.size / 2;
    if (TITLE_CFG.shade > 0) shadowOnly(ctx, g.out, gx, gy + 4 * L.S, `rgba(28,30,78,${(0.45 * TITLE_CFG.shade).toFixed(3)})`, 26 * L.S, far);
    // 白字 + 极淡的暖色光晕（外圈大而淡，内圈小）
    shadowOnly(ctx, g.out, gx, gy, 'rgba(255,190,140,0.55)', 38 * L.S, far);
    shadowOnly(ctx, g.out, gx, gy, 'rgba(255,214,180,0.45)', 10 * L.S, far);
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
  if (hudWindow(t)) {
    const ctx = mctx();
    out.push(...O.collect(() => renderHUD(ctx, t, w, h, s, true)));
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
