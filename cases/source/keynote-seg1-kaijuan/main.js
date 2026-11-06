// 片段一「开卷」画面：render(t) 只依赖 t（确定性），所有时刻与位置来自 timeline.js。
import * as T from './timeline.js';
import { makeComp, layers } from './comp.js';
import { mk, draw, blot, TONE } from './brush.js';
import { makeGlyph, drawGlyph, strokeTimes } from './glyph.js';
import { makeSeal, VERM, glyphOverride } from './seal.js';
import { clamp, lerp, seg, ss, eio, eo, mulberry, vnoise } from '/core/lib.js';

const { A0, L, FAN: F, ZOOM0, B } = T;
const q = new URLSearchParams(location.search);
const W = 1920, H = 1080;
const VERMC = `rgb(${VERM.join(',')})`;

// ───────── 资源 ─────────
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('missing ' + src)); i.src = src; });
const [paper, back, silk, lianG, deer, ...posters] = await Promise.all([
  'material/paper.png', 'material/paper_back.png', 'material/silk.png', 'fonts/lian.png', 'material/p01_jiuselu.png',
  ...T.SCROLLS.map(s => s.img)].map(loadImg));
await Promise.all([document.fonts.load('80px MaShanZheng', '展卷角色'), document.fonts.load('500 30px NotoSerifSC', '上美影')]);
const MA = '{S} MaShanZheng', NS = '500 {S} NotoSerifSC';

const cv = document.getElementById('c');
const comp = makeComp(cv, paper, back);
const Ls = layers(W, H);

// 九色鹿：团扇圆窗取以鹿与光轮为中心的圆（只遮挡，不改像素）。圆的直径 = 原图高。
const DEER_C = [1370, 628], DEER_R = 628, KF = F.r / DEER_R;
const deerS = await createImageBitmap(deer, { resizeWidth: Math.round(deer.width * KF), resizeHeight: Math.round(deer.height * KF), resizeQuality: 'high' });
const deerM = await createImageBitmap(deer, { resizeWidth: Math.round(deer.width * KF * 2), resizeHeight: Math.round(deer.height * KF * 2), resizeQuality: 'high' });
// 立轴画芯：高 560，按原宽高比
const CORE_H = 560, CORE_TOP = 228, ROD_Y = L.rodY, ROLL_END = 858, BORDER = 31;
const SC = await Promise.all(L.sc.map(async (s, i) => {
  const im = posters[i], ar = im.width / im.height, cw = Math.round(CORE_H * ar);
  const bm = await createImageBitmap(im, { resizeWidth: cw, resizeHeight: CORE_H, resizeQuality: 'high' });
  return { ...s, bm, cw, mw: cw + BORDER * 2, ar };
}));
// 绫绢：取一块，向纸色收一点饱和度
const silkTile = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 640; const x = c.getContext('2d');
  x.drawImage(silk, 1200, 600, 640, 640, 0, 0, 640, 640);
  x.globalCompositeOperation = 'saturation'; x.fillStyle = 'rgba(128,128,128,.42)'; x.fillRect(0, 0, 640, 640);
  x.globalCompositeOperation = 'multiply'; x.fillStyle = '#F4EEE2'; x.fillRect(0, 0, 640, 640);
  return c;
})();
const silkPat = Ls.c.mount.createPattern(silkTile, 'repeat');

// ───────── 字 ─────────
const G = (ch, font, size) => makeGlyph(ch, font, size);
const TITLE = [...'展卷'].map((ch, i) => ({ g: G(ch, MA, 158), x: L.title.x, y: L.title.y + 79 + i * 168 }));
const SMALL = ['上', '美', '影', 'IP', '全', '景'].map((ch, i) => ({ ch, x: L.small.x, y: L.small.y + 20 + i * 41 }));
const MOTTO = (() => {
  let y = L.motto.y; const out = [];
  for (const ch of T.MOTTO.text) {
    const cell = ch === '，' ? L.motto.size * .55 : L.motto.size * 1.06;
    const g = G(ch, MA, L.motto.size);
    out.push({ g, ch, x: L.motto.x + (ch === '，' ? L.motto.size * .32 : 0), y: y + (ch === '，' ? -L.motto.size * .12 : L.motto.size * .53) });
    y += cell;
  }
  return out;
})();
// 按笔画总长把一串字的书写时间分开
function sched(list, t0, t1) {
  const tot = list.reduce((a, o) => a + o.g.total, 0); let acc = 0;
  for (const o of list) { o.t0 = t0 + (t1 - t0) * acc / tot; acc += o.g.total; o.t1 = t0 + (t1 - t0) * acc / tot; }
  return list;
}
sched(TITLE, A0.titleStart, A0.titleEnd);
sched(MOTTO, T.MOTTO.t0, T.MOTTO.t1);

// 印（Ma Shan Zheng 的「莲」是繁体写法，印文改用同一字体拼出的简体「莲」，见 tools/lian_glyph.py）
glyphOverride('莲', lianG);
const SEAL0 = makeSeal('内容资源概念发布', L.seal0.w, L.seal0.h, 11, { margin: .09 });
const sealSize = n => n <= 4 ? 112 : n <= 6 ? 120 : 126;
const SEALS = L.seals.map((s, i) => {
  const n = [...s.name].length, sz = sealSize(n), R = mulberry(i * 31 + 7);
  return { ...s, sz, rot: (R() - .5) * .05, img: makeSeal(s.name, sz, sz, 100 + i, { margin: .085 }), dotR: 8 + R() * 5 };
});
// 组名
const GNAME = T.GROUPS.map((g, gi) => {
  const Gr = L.groups[gi], first = SEALS.find(s => s.group === gi);
  const x = Gr.right + 54, list = [...g.name].map((ch, k) => ({ g: G(ch, MA, 38), x, y: 318 + k * 42 }));
  return sched(list, first.t - .62, first.t - .06);
});
// 甩笔与墨点
const FX0 = L.motto.x - 46, G1N = L.groups[0].right + 54;
const FLICK = mk([[FX0, 92, .85], [FX0 - 52, 118, 1], [lerp(FX0, G1N, .62), 168, .9], [G1N + 22, 232, .55]],
  { w: 42, tone: .55, dry: .72, wet: .05, prof: 'cone', rough: .3, nb: 44, seed: 4242, fade: .6 });
const FL_END = [G1N + 22, 232], FL_DIR = (() => { const a = [G1N + 22 - lerp(FX0, G1N, .62), 232 - 168], l = Math.hypot(...a); return [a[0] / l, a[1] / l]; })();
// 甩出的一串墨点：沿笔势的弧线继续飞出、落纸，±30 px 不规则、大小不一
const SPRAY = (() => { const R = mulberry(2020), o = [];
  for (let i = 0; i < 9; i++) { const d = 18 + i * 13 + R() * 12, bend = d * d * .0016;
    o.push({ x: FL_END[0] + FL_DIR[0] * d - bend * .4 + (R() - .5) * 60, y: FL_END[1] + FL_DIR[1] * d + bend + (R() - .5) * 60,
      r: 1.3 + R() * R() * 5.5, t: T.FLICK + .015 + d / 1500 }); }
  return o; })();
// 每方印对应一颗墨点：在它的印之前"两个音符间隔"（夹在一个八分到一拍之间）才落纸溅开，落点都在拍格上；
// 画面里同时等着变印的墨点最多两三颗。第一颗就是甩笔那一下甩出来的（20.000 落纸）。
SEALS.forEach((s, i) => {
  const R = mulberry(i * 97 + 3);
  s.dx = (R() - .5) * 34; s.dy = (R() - .5) * 26;
  const prev = i ? SEALS[i - 1].t : T.FLICK;
  s.land = s.t - clamp(2 * (s.t - prev), B / 2, B);
  if (i === 0) s.land = T.FLICK;
  s.fall = .11; s.dotR = 6 + R() * 7;
  s.sat = [0, 1, 2, 3].map(k => { const a = R() * 6.283, d = 26 + R() * 46; return { x: Math.cos(a) * d, y: Math.sin(a) * d * .8, r: 1 + R() * 2.4 }; });
});
// 页边 477 个墨点：随印雨的前缘自右向左长，最后一点与第 25 方同时落下
const DOTS = (() => {
  const b = L.band, out = [];
  const fr = [[T.COUNT.t0, b.right + 4]]; let mn = b.right + 4;
  for (const s of SEALS) { mn = Math.min(mn, s.x - 70); fr.push([s.t, mn]); }
  const front2t = x => { for (let i = 1; i < fr.length; i++) if (fr[i][1] <= x) { const [ta, xa] = fr[i - 1], [tb, xb] = fr[i]; return ta + (tb - ta) * clamp((xa - x) / ((xa - xb) || 1)); } return fr[fr.length - 1][0]; };
  const tc = []; for (let c = 0; c < 159; c++) tc.push(front2t(b.right - c * b.pitch));
  const t0 = T.COUNT.t0, k = (T.COUNT.t1 - t0) / (tc[158] - t0);
  const R = mulberry(477);
  for (let c = 0; c < 159; c++) for (let r = 0; r < 3; r++) {
    let t = t0 + (tc[c] - t0) * k + r * .018;
    if (c === 158) t = T.COUNT.t1 - (2 - r) * .03;
    out.push({ x: b.right - c * b.pitch + (R() - .5) * 2.2, y: b.y + r * b.pitch + (R() - .5) * 2.2, r: 2.0 + R() * .9, t: Math.min(t, T.COUNT.t1) });
  }
  out[out.length - 1].t = T.COUNT.t1;
  return out;
})();
// 说明句与数字
const CAP_PRE = '资料底稿 ', CAP_POST = ' 条作品、系列、版本记录｜非 IP 数量';
const mctx = document.createElement('canvas').getContext('2d');
mctx.font = `500 ${L.caption.size}px NotoSerifSC`;
const capPreW = mctx.measureText(CAP_PRE).width, slotW = 50;
const capChars = (() => {
  const out = []; let x = L.caption.x;
  for (const ch of CAP_PRE) { const w = mctx.measureText(ch).width; out.push({ ch, x: x + w / 2 }); x += w; }
  x += slotW;
  for (const ch of CAP_POST) { const w = mctx.measureText(ch).width; out.push({ ch, x: x + w / 2 }); x += w; }
  return { list: out, x1: x };
})();
capChars.list.forEach((o, i, a) => { o.t = T.CAPTION.t0 + (T.CAPTION.t1 - T.CAPTION.t0) * i / a.length; });
const NUMS = [...'477'].map((ch, i) => ({ g: G(ch, NS, 31), x: L.caption.x + capPreW + 9 + i * 16, y: L.caption.y + 1, t0: T.NUM477[i], t1: T.NUM477[i] + .13 }));
const BIG = sched([...'25'].map((ch, i) => ({ g: G(ch, MA, L.big25.size), x: L.big25.x - 78 + i * 156, y: L.big25.y })), T.BIG25.t0, T.BIG25.t1);
mctx.font = `500 ${L.cat.size}px NotoSerifSC`;
const CAT = (() => { const s = '官网动画分类', w = mctx.measureText(s).width; let x = L.cat.x - w / 2; return [...s].map((ch, i) => { const cw = mctx.measureText(ch).width, o = { ch, x: x + cw / 2, t: T.CAT.t0 + (T.CAT.t1 - T.CAT.t0) * i / 6 }; x += cw; return o; }); })();

// ───────── 镜头 ─────────
const zoomAt = t => t < A0.zoomStart ? ZOOM0 : t > A0.zoomEnd ? 1 : lerp(ZOOM0, 1, eio(seg(t, A0.zoomStart, A0.zoomEnd)));
function camera(t) {
  const z = zoomAt(t), k = (z - 1) / (ZOOM0 - 1);
  const Px = lerp(F.x, W / 2, k), Py = lerp(F.y, H / 2, k);
  let ox = Px - F.x * z - T.camL(t), oy = Py - F.y * z;
  for (const th of [A0.sealHit, T.GONG]) if (t >= th - 1 / 60) oy += 2.6 * Math.exp(-(t - th) / .09);
  return { z, ox, oy };
}
const sx = (wx, t) => { const c = camera(t); return wx * c.z + c.ox; };

// ───────── A0 ─────────
const bloomR = t => t < A0.dropHit - 1 / 60 ? 0 : F.r * 1.2 * Math.sqrt(clamp((t - A0.dropHit + .014) / (A0.bloomEnd - A0.dropHit)));
// 显影半径：实测扇面在 D≈309 时全部洗净；取 F.r×1.19≈312 配 1.3 次缓出，使最后一点墨正好在 5.000 前后洗净（与沙沙声同止）
const devRad = t => t < A0.devStart ? 0 : F.r * 1.19 * (1 - Math.pow(1 - seg(t, A0.devStart, A0.devEnd), 1.3));
const SAT = (() => { const R = mulberry(25); const o = []; for (let i = 0; i < 11; i++) { const a = R() * 6.283, out = i >= 9, d = out ? F.r * (1.12 + R() * .25) : F.r * (.1 + R() * .5); o.push({ a, d, r: out ? 1.6 + R() * 1.4 : 1.2 + R() * 2.6, dt: .03 + R() * .07 }); } return o; })();
const RIM = (() => {
  const pts = (a0, a1) => { const o = []; for (let i = 0; i <= 40; i++) { const a = lerp(a0, a1, i / 40); o.push([F.x + Math.cos(a) * (F.r + 3), F.y + Math.sin(a) * (F.r + 3), 1]); } return o; };
  return [mk(pts(-Math.PI / 2, Math.PI / 2 + .05), { w: 6.5, tone: TONE.nong, dry: .3, wet: .3, prof: 'even', rough: .1, nb: 20, seed: 71 }),
          mk(pts(-Math.PI / 2, -Math.PI * 1.5 - .05), { w: 6.5, tone: TONE.nong, dry: .3, wet: .3, prof: 'even', rough: .1, nb: 20, seed: 72 })];
})();
const RIM_T = [3.52, 3.95];
const HANDLE = mk([[F.x, F.y + F.r + 6, .8], [F.x + 1, F.y + F.r + 80, 1], [F.x + 2, F.y + F.r + 160, .95], [F.x + 2, F.y + F.r + 222, .8]], { w: 13, tone: TONE.nong, dry: .32, wet: .35, prof: 'even', rough: .1, nb: 24, seed: 73 });
const HANDLE_T = [4.32, 4.64];

function drawA0(t, c) {
  // 墨滴下落
  if (t >= A0.dropStart && t < A0.dropHit - 1 / 60) {
    const u = seg(t, A0.dropStart, A0.dropHit), y = F.y - 150 + 150 * u * u, r = 4.4, st = 1 + 1.15 * u;
    const o = c.over; o.save(); o.translate(F.x, y - r * (st - 1)); o.scale(1, st);
    const g = o.createRadialGradient(-r * .3, -r * .35, r * .1, 0, 0, r); g.addColorStop(0, '#2c2925'); g.addColorStop(.6, '#0e0d0b'); g.addColorStop(1, '#050504');
    o.fillStyle = g; o.beginPath(); o.arc(0, 0, r, 0, 7); o.fill();
    o.fillStyle = 'rgba(255,250,240,.55)'; o.beginPath(); o.ellipse(-r * .35, -r * .38, r * .22, r * .14, -.5, 0, 7); o.fill();
    o.restore();
    blot(c.wet, F.x + 2, F.y + 2, 7 - 3 * u, .10 * u * u, 0, 1, 3);   // 影子
  }
  // 落纸溅出的小墨珠
  if (t >= A0.dropHit - 1 / 60) {
    const dv = devRad(t);
    SAT.forEach((s, i) => {
      const k = clamp((t - A0.dropHit) / s.dt), x = F.x + Math.cos(s.a) * s.d * eo(k), y = F.y + Math.sin(s.a) * s.d * eo(k);
      if (k < 1) { c.over.fillStyle = 'rgba(10,9,8,.9)'; c.over.beginPath(); c.over.arc(x, y - 6 * Math.sin(k * 3.14), s.r * .8, 0, 7); c.over.fill(); return; }
      if (s.d < F.r && dv * .82 > s.d) return;      // 显影的清水会把扇面里的墨珠带走
      blot(c.dry, x, y, s.r, .85, s.a, .8, i); blot(c.wet, x, y, s.r * 1.3, .3, s.a, .8, i + 9);
    });
  }
  // 扇缘与扇柄
  RIM.forEach(s => draw(c, s, eo(seg(t, RIM_T[0], RIM_T[1]))));
  draw(c, HANDLE, eo(seg(t, HANDLE_T[0], HANDLE_T[1])));
  if (t >= HANDLE_T[0]) { blot(c.dry, F.x, F.y + F.r + 8, 7, .85 * seg(t, HANDLE_T[0], HANDLE_T[0] + .1), 0, .7, 5); }
  // 团扇绢面（装裱层；合成器只在水洇到之处露出）
  if (t >= A0.dropHit - 1 / 60) { const m = c.mount; m.save(); m.globalAlpha = .78; m.fillStyle = silkPat; m.beginPath(); m.arc(F.x, F.y, F.r + .5, 0, 7); m.fill(); m.restore(); }
  // 九色鹿（只在团扇圆窗里，由着色器的显影遮罩露出；微距阶段不露）
  if (t >= A0.dropHit - 1 / 60) {
    const z = camera(t).z, im = z > 1.9 ? deer : z > 1.15 ? deerM : deerS;
    const g = c.img; g.save(); g.beginPath(); g.arc(F.x, F.y, F.r + .5, 0, 7); g.clip();
    g.drawImage(im, F.x - DEER_C[0] * KF, F.y - DEER_C[1] * KF, deer.width * KF, deer.height * KF); g.restore();
  }
  // 题字「展卷」：笔顺书写，写时湿、写完渐干
  for (const o of TITLE) {
    const p = seg(t, o.t0, o.t1); if (p <= 0) continue;
    drawGlyph(c.dry, o.g, o.x, o.y, p, '#000', .95);
    const wet = p < 1 ? .5 : .5 * Math.exp(-(t - o.t1) / .5) + .1;
    drawGlyph(c.wet, o.g, o.x, o.y, p, '#000', wet);
  }
  // 小字逐字洇出
  SMALL.forEach((o, i) => {
    const t0 = A0.smallStart + i * .1, k = seg(t, t0, t0 + .2); if (k <= 0) return;
    wetIn(c, o.ch, o.x, o.y, o.ch === 'IP' ? 25 : L.small.size, k, .72);
  });
  // 朱印「内容资源概念发布」
  sealDraw(c, SEAL0, L.seal0.x, L.seal0.y, 0, A0.sealHit, t);
}
function wetIn(c, ch, x, y, size, k, a) {
  for (const [ctx, al] of [[c.dry, a * Math.pow(k, .8)], [c.wet, .5 * (1 - k * .75)]]) {
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, size * (.15 + .85 * eo(k)), 0, 7); ctx.clip();
    ctx.globalAlpha = clamp(al); ctx.fillStyle = '#000'; ctx.font = `500 ${size}px NotoSerifSC`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ch, x, y); ctx.restore();
  }
}
// 印落：落前一瞬一片软影由大收小（印在下落），落拍时印文完整出现，随后纸面微陷的湿痕慢慢退去
function sealDraw(c, S, x, y, rot, th, t, big = 1) {
  const pre = th - .16;
  if (t >= pre && t < th - 1 / 60) {
    const u = seg(t, pre, th), s = lerp(1.5, 1.02, eo(u));
    const o = c.over; o.save(); o.translate(x + 10 * (1 - u), y + 14 * (1 - u)); o.rotate(rot); o.scale(s, s);
    o.fillStyle = `rgba(20,16,12,${.05 + .13 * u})`; o.filter = `blur(${6 * (1 - u) + 2}px)`;
    o.fillRect(-S.w / 2, -S.h / 2, S.w, S.h); o.restore();
  }
  if (t < th - 1 / 60) return false;
  const e = Math.max(0, t - th);
  const k = c.col; k.save(); k.translate(x, y); k.rotate(rot);
  const press = 1 + .025 * Math.exp(-e / .05);
  k.scale(press, press); k.globalAlpha = 1;
  k.drawImage(S.cv, -S.w / 2 - S.pad, -S.h / 2 - S.pad); k.restore();
  const dent = Math.exp(-e / .35) * .16 * big;
  if (dent > .005) { const w = c.wet; w.save(); w.translate(x, y); w.rotate(rot); w.globalAlpha = dent; w.strokeStyle = '#000'; w.lineWidth = 5; w.strokeRect(-S.w / 2 - 3, -S.h / 2 - 3, S.w + 6, S.h + 6); w.restore(); }
  return true;
}

// ───────── A1 立轴 ─────────
const RODS = SC.map((s, i) => mk([[s.x - s.mw / 2 - 20, ROD_Y + 1.5, .85], [s.x - s.mw / 4, ROD_Y, 1], [s.x + s.mw / 4, ROD_Y - .5, 1], [s.x + s.mw / 2 + 20, ROD_Y + 1, .85]], { w: 10, tone: TONE.nong, dry: .26, wet: .25, prof: 'even', rough: .08, nb: 26, seed: 300 + i }));
const CORDS = SC.map((s, i) => [-1, 1].map(sd => mk([[s.x + sd * s.mw * .3, ROD_Y - 2, .8], [s.x + sd * s.mw * .14, ROD_Y - 32, 1], [s.x, ROD_Y - 58, .9]], { w: 2.6, tone: TONE.zhong, dry: .2, wet: .2, prof: 'even', rough: .05, nb: 6, seed: 320 + i * 2 + sd })));
const rollerY = (s, t) => {
  if (t < s.roll0) return ROD_Y + 17;
  if (t < s.land - 1 / 60) return lerp(ROD_Y + 17, ROLL_END, Math.pow(seg(t, s.roll0, s.land), 1.75));
  const e = t - s.land; return ROLL_END - 7 * Math.exp(-e * 7) * Math.abs(Math.sin(e * 19));
};
const devFront = (s, t) => CORE_TOP - 46 + (CORE_H + 140) * (1 - Math.pow(1 - seg(t, s.dev0, s.dev1), 1.6));
function drawScroll(s, i, t, c, dev) {
  if (t < s.rod0) return;
  const xl = s.x - s.mw / 2, xr = s.x + s.mw / 2;
  draw(c, RODS[i], eo(seg(t, s.rod0, s.rod1)));
  CORDS[i].forEach(cd => draw(c, cd, eo(seg(t, s.rod1, s.rod1 + .24))));
  if (t >= s.rod1 + .2) blot(c.dry, s.x, ROD_Y - 58, 3.2, .9, 0, 1, i);
  if (t < s.rod1 - .08) return;
  const appear = seg(t, s.rod1 - .08, s.rod1 + .12);
  const yR = rollerY(s, t), u = seg(t, s.roll0, s.land);
  // 绫绢
  const m = c.mount;
  if (yR > ROD_Y + 8) {
    m.save(); m.globalAlpha = appear; m.fillStyle = silkPat; m.fillRect(xl, ROD_Y + 4, s.mw, yR - ROD_Y - 4);
    const coreB = Math.min(yR, CORE_TOP + CORE_H);
    if (coreB > CORE_TOP) { m.fillStyle = '#EEE8DB'; m.fillRect(s.x - s.cw / 2, CORE_TOP, s.cw, coreB - CORE_TOP); }
    m.restore();
    // 轻影与边线
    const w = c.wet; w.save(); w.globalAlpha = .07 * appear; w.fillStyle = '#000'; w.fillRect(xl + 7, ROD_Y + 12, s.mw, yR - ROD_Y - 4); w.restore();
    const d = c.dry; d.save(); d.globalAlpha = .22 * appear; d.strokeStyle = '#000'; d.lineWidth = 1.3;
    d.beginPath(); d.moveTo(xl, ROD_Y + 4); d.lineTo(xl, yR); d.moveTo(xr, ROD_Y + 4); d.lineTo(xr, yR); d.stroke();
    if (yR >= CORE_TOP + CORE_H) { d.globalAlpha = .3; d.lineWidth = 1.5; d.strokeRect(s.x - s.cw / 2 - 3, CORE_TOP - 3, s.cw + 6, CORE_H + 6); }
    d.restore();
  }
  // 画芯（原图）
  if (t >= s.dev0 - .001) {
    c.img.drawImage(s.bm, s.x - s.cw / 2, CORE_TOP, s.cw, CORE_H);
    if (t < s.dev1 + .6) dev.push({ rect: [s.x - s.cw / 2, CORE_TOP, s.x + s.cw / 2, CORE_TOP + CORE_H], front: devFront(s, t), band: 1, seed: i * 3.7 + 1 });
  } else if (yR > CORE_TOP) dev.push({ rect: [s.x - s.cw / 2, CORE_TOP, s.x + s.cw / 2, CORE_TOP + CORE_H], front: CORE_TOP - 400, band: 0, seed: 0 });
  // 地轴（滚着的画卷）与轴头
  const thick = 20 + 12 * (1 - u);
  const rs = mk([[xl - 5, yR, .95], [s.x, yR + .5, 1], [xr + 5, yR, .95]], { w: thick, tone: TONE.nong, dry: .1, wet: .3, prof: 'even', rough: .04, nb: 30, seed: 340 + i });
  draw(c, rs, 1, appear);
  for (const sd of [-1, 1]) { blot(c.dry, s.x + sd * (s.mw / 2 + 13), yR, 9.5, .93 * appear, 0, 1.45, 350 + i + sd); blot(c.wet, s.x + sd * (s.mw / 2 + 13), yR, 11, .35 * appear, 0, 1.4, 360 + i); }
}

// ───────── A2 印谱 ─────────
function drawA2(t, c) {
  draw(c, FLICK, eo(seg(t, T.FLICK - .17, T.FLICK - 1 / 60)));
  // 甩出的墨点
  for (const d of SPRAY) {
    if (t < T.FLICK - .02) break;
    if (t < d.t - 1 / 60) { const u = seg(t, T.FLICK - .02, d.t), o = c.over; o.fillStyle = 'rgba(12,10,9,.85)';
      o.beginPath(); o.arc(lerp(FL_END[0], d.x, u), lerp(FL_END[1], d.y, u) - 14 * Math.sin(u * 3.14), Math.max(.8, d.r * .7), 0, 7); o.fill(); continue; }
    blot(c.dry, d.x, d.y, d.r, .82, d.x, .85, d.y | 0); blot(c.wet, d.x, d.y, d.r * 1.4, .28, d.x, .85, (d.y | 0) + 3);
  }
  // 每方印的墨点：落纸前一瞬从右上方斜落（顺着甩笔的势），落纸溅开，等到拍点化成朱印
  SEALS.forEach((s, i) => {
    const t0 = s.land - s.fall; if (t < t0) return;
    const X = s.x + s.dx, Y = s.y + s.dy, R = mulberry(i * 13 + 5);
    if (t < s.land - 1 / 60) {
      const u = seg(t, t0, s.land), uu = u * u, o = c.over;
      const hx = X + 70 * (1 - uu), hy = Y - 120 * (1 - uu);
      o.strokeStyle = 'rgba(10,9,8,.35)'; o.lineWidth = s.dotR * .45; o.lineCap = 'round';
      o.beginPath(); o.moveTo(hx, hy); o.lineTo(hx + 70 * .22 * (1 - u * .5), hy - 120 * .22 * (1 - u * .5)); o.stroke();
      o.fillStyle = 'rgba(8,7,6,.92)'; o.beginPath(); o.arc(hx, hy, s.dotR * .42, 0, 7); o.fill();
      return;
    }
    const e = t - s.land, sp = .55 + .45 * clamp(e / .05);
    for (const q of s.sat) { const k = clamp(e / .06); blot(c.dry, X + q.x * eo(k), Y + q.y * eo(k), q.r, .8, 0, 1, i * 7 + q.x); }
    if (t < s.t - 1 / 60) {
      const g = sp * (1 + .3 * seg(t, s.t - .14, s.t));
      blot(c.dry, X, Y, s.dotR * g, .9, R() * 3, .85, i);
      blot(c.wet, X, Y, s.dotR * 1.4 * g, .4, R() * 3, .85, i + 50);
      return;
    }
    sealDraw(c, s.img, s.x, s.y, s.rot, s.t, t, .7);
  });
  // 组名
  for (const list of GNAME) for (const o of list) {
    const p = seg(t, o.t0, o.t1); if (p <= 0) continue;
    drawGlyph(c.dry, o.g, o.x, o.y, p, '#000', .92);
    drawGlyph(c.wet, o.g, o.x, o.y, p, '#000', p < 1 ? .4 : .4 * Math.exp(-(t - o.t1) / .4) + .08);
  }
  // 页边点数
  for (const d of DOTS) {
    if (t < d.t - 1 / 60) continue;
    const g = .55 + .45 * clamp((t - d.t + 1 / 60) / .05);
    blot(c.dry, d.x, d.y, d.r * g, .88, d.x * .01, .9, d.x);
  }
  // 说明句（数字留空）
  for (const o of capChars.list) { const k = seg(t, o.t, o.t + .14); if (k > 0) wetIn(c, o.ch, o.x, L.caption.y, L.caption.size, k, .72); }
  for (const o of NUMS) { const p = seg(t, o.t0 - 1 / 60, o.t1); if (p <= 0) continue; drawGlyph(c.dry, o.g, o.x, o.y, p, '#000', .93); drawGlyph(c.wet, o.g, o.x, o.y, p, '#000', .3); }
  // 朱红「25」
  for (const o of BIG) { const p = seg(t, o.t0, o.t1); if (p > 0) drawGlyph(c.col, o.g, o.x, o.y, p, VERMC, 1); }
  for (const o of CAT) { const k = seg(t, o.t, o.t + .16); if (k > 0) wetIn(c, o.ch, o.x, L.cat.y, L.cat.size, k, .72); }
}

// ───────── 一帧 ─────────
function render(t) {
  Ls.clear();
  const cam = camera(t);
  Ls.xf(cam.z, cam.ox, cam.oy);
  const c = { ...Ls.c, wet: Ls.c.wet, dry: Ls.c.dry, col: Ls.c.col };
  const dev = [];
  drawA0(t, c);
  if (t > T.T0 - .2) SC.forEach((s, i) => drawScroll(s, i, t, c, dev));
  if (t >= T.MOTTO.t0) for (const o of MOTTO) {
    const p = seg(t, o.t0, o.t1); if (p <= 0) continue;
    drawGlyph(c.dry, o.g, o.x, o.y, p, '#000', .94);
    drawGlyph(c.wet, o.g, o.x, o.y, p, '#000', p < 1 ? .45 : .45 * Math.exp(-(t - o.t1) / .45) + .08);
  }
  if (t >= T.FLICK - .2) drawA2(t, c);
  // 光：0–2 s 由黑转背光微距，拉远时转为正面光
  const back = ss(seg(t, .12, 1.95)) * (1 - ss(seg(t, 2.95, 4.0)));
  const front = ss(seg(t, 2.8, 3.9));
  const vig = lerp(.62, .16, ss(seg(t, 1.5, 4.2)));
  const fanOn = t >= A0.dropHit - 1 / 60 ? 1 : 0;
  const tideFade = seg(t, A0.devEnd - .1, A0.devEnd + .4);
  comp(Ls, {
    cam: [-cam.ox / cam.z, -cam.oy / cam.z, cam.z], light: [back, front], vig, bleed: 4.2, rim: .85,
    fan: [F.x, F.y, F.r, fanOn], bloom: [bloomR(t), devRad(t), 1, tideFade], dev,
  });
}

// ───────── 事件表（声音与对拍）─────────
function events() {
  const ev = [], pan = (wx, t) => clamp((sx(wx, t) / W * 2 - 1) * .55, -.7, .7);
  const strokes = (G, t0, t1, wx, w = 1) => {
    // 很短的笔段并入前一笔（交叉点附近的碎段不单独出声）
    const grp = [];
    for (const [a, b, len] of strokeTimes(G)) { if (grp.length && len < G.size * .16) { grp[grp.length - 1][1] = b; grp[grp.length - 1][2] += len; } else grp.push([a, b, len]); }
    for (const [a, b, len] of grp) ev.push({ t: +(t0 + (t1 - t0) * a).toFixed(4), type: 'stroke', d: +((t1 - t0) * (b - a)).toFixed(4), w: w * clamp(len / (G.size * .8), .25, 1), pan: pan(wx, t0) });
  };
  ev.push({ t: A0.dropHit, type: 'drop', pan: 0 });
  ev.push({ t: A0.dropHit, type: 'soak', d: A0.bloomEnd - A0.dropHit + .4 });
  ev.push({ t: A0.devStart, type: 'rustle', t1: A0.devEnd, g: .9, pan: 0 });
  ev.push({ t: RIM_T[0], type: 'stroke', d: RIM_T[1] - RIM_T[0], w: .5, pan: 0 });
  ev.push({ t: HANDLE_T[0], type: 'stroke', d: HANDLE_T[1] - HANDLE_T[0], w: .6, pan: 0 });
  for (const o of TITLE) strokes(o.g, o.t0, o.t1, o.x, 1);
  SMALL.forEach((o, i) => ev.push({ t: A0.smallStart + i * .1, type: 'wetin', pan: pan(o.x, 6) }));
  ev.push({ t: A0.sealHit, type: 'seal0', pan: pan(L.seal0.x, A0.sealHit), visual: true });
  SC.forEach((s, i) => {
    ev.push({ t: s.rod0, type: 'stroke', d: s.rod1 - s.rod0, w: .8, pan: pan(s.x, s.rod0) });
    ev.push({ t: s.rod1, type: 'stroke', d: .24, w: .25, pan: pan(s.x, s.rod1) });
    ev.push({ t: s.roll0, type: 'unroll', t1: s.land, pan: pan(s.x, s.land) });
    ev.push({ t: s.land, type: 'land', pan: pan(s.x, s.land), visual: true });
    ev.push({ t: s.dev0, type: 'rustle', t1: s.dev1, g: .75, pan: pan(s.x, s.dev0) });
  });
  for (const o of MOTTO) strokes(o.g, o.t0, o.t1, o.x, .8);
  ev.push({ t: T.FLICK, type: 'flick', pan: pan(FL_END[0], T.FLICK), visual: true });
  SPRAY.forEach((d, i) => { if (i % 2 === 0) ev.push({ t: +d.t.toFixed(4), type: 'splat', g: .35, pan: pan(d.x, d.t) }); });
  SEALS.forEach((s, i) => {
    ev.push({ t: +s.land.toFixed(4), type: 'splat', g: 1, pan: pan(s.x, s.land), drip: true });
    ev.push({ t: s.t, type: 'seal', idx: i, pan: pan(s.x, s.t), visual: true, last: i === 24 });
  });
  for (const list of GNAME) for (const o of list) strokes(o.g, o.t0, o.t1, o.x, .55);
  // 算盘珠：按十六分音符，随这一格里新落的墨点数增减
  const s16 = B / 4;
  for (let k = Math.floor((T.COUNT.t0 - T.T0) / s16); ; k++) {
    const ta = T.T0 + k * s16; if (ta >= T.COUNT.t1 - 1e-6) break;
    const n = DOTS.filter(d => d.t >= ta && d.t < ta + s16).length;
    if (n > 0 && Math.abs(ta - (T.GONG - s16)) > 1e-3) ev.push({ t: +ta.toFixed(4), type: 'abacus', n: Math.min(3, Math.ceil(n / 3)), pan: .1 });
  }
  capChars.list.forEach((o, i) => { if (i % 3 === 0) ev.push({ t: o.t, type: 'wetin', pan: pan(o.x, o.t) }); });
  NUMS.forEach(o => ev.push({ t: o.t0, type: 'num', pan: pan(o.x, o.t0), visual: true }));
  ev.push({ t: T.GONG, type: 'gong', pan: 0 });
  ev.push({ t: T.BIG25.t0, type: 'big25', d: T.BIG25.t1 - T.BIG25.t0, pan: pan(L.big25.x, T.GONG) });
  CAT.forEach(o => ev.push({ t: o.t, type: 'wetin', pan: pan(o.x, o.t) }));
  for (const e of T.SCORE) ev.push({ ...e });
  SEALS.forEach((s2, i) => { const e = ev.find(x => x.type === 'seal' && x.idx === i); e.pitch = T.SEAL_PITCH[i]; });
  // 视觉事件实际出现的帧（对拍自检用）
  for (const e of ev) if (e.visual) e.frame = Math.ceil((e.t - 1 / 60) * 30 - 1e-9);
  return ev.sort((a, b) => a.t - b.t);
}

// ───────── 读字时长自检 ─────────
function TEXTS(t) {
  const out = [], cam = camera(t);
  const box = (id, text, x0, y0, x1, y1) => out.push({ id, text, x0: x0 * cam.z + cam.ox, y0: y0 * cam.z + cam.oy, x1: x1 * cam.z + cam.ox, y1: y1 * cam.z + cam.oy });
  if (t >= TITLE[0].t0) box('title', '展卷', L.title.x - 80, L.title.y, L.title.x + 80, L.title.y + 340);
  if (t >= A0.smallStart) box('small', '上美影 IP 全景', L.small.x - 20, L.small.y, L.small.x + 20, L.small.y + 250);
  if (t >= A0.sealHit) box('seal0', '内容资源概念发布', L.seal0.x - L.seal0.w / 2, L.seal0.y - L.seal0.h / 2, L.seal0.x + L.seal0.w / 2, L.seal0.y + L.seal0.h / 2);
  if (t >= T.MOTTO.t0) box('motto', T.MOTTO.text, L.motto.x - 30, L.motto.y, L.motto.x + 30, L.motto.y + 600);
  GNAME.forEach((list, gi) => { if (t >= list[0].t0) box('g' + gi, T.GROUPS[gi].name, list[0].x - 20, 296, list[0].x + 20, 296 + 42 * list.length); });
  SEALS.forEach(s => { if (t >= s.t - 1 / 60) box('s' + s.idx, s.name, s.x - s.sz / 2, s.y - s.sz / 2, s.x + s.sz / 2, s.y + s.sz / 2); });
  if (t >= T.CAPTION.t0) box('cap', CAP_PRE + '477' + CAP_POST, L.caption.x, L.caption.y - 15, capChars.x1, L.caption.y + 15);
  if (t >= T.BIG25.t0) box('25', '25', L.big25.x - 160, L.big25.y - 150, L.big25.x + 160, L.big25.y + 150);
  if (t >= T.CAT.t0) box('cat', '官网动画分类', L.cat.x - 100, L.cat.y - 18, L.cat.x + 100, L.cat.y + 18);
  return out;
}

window.DUR = T.DUR;
window.EV = events();
window.TEXTS = TEXTS;
window.render = render;
window.READY = true;
