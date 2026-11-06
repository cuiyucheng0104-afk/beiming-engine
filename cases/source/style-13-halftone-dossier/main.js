// 消失的第十三页 —— render(t) 确定性，所有时间取自 timeline.js
import {
  W, H, C, F, font, clamp, lerp, seg, eo, ei, eio, ss, back, wob, hash, TAU,
  TXT, regText, halftone, radial, ramp, edgeF, setBoil, BOIL, ink, ell, rectPts, poly,
  shadowText, popText, captionBar, buildStamp, drawStamp, dotWipe, buildPaper, drawGrain, buildGrainMask,
  glyphSprite, drawGlyph, buildPage, drawPage,
} from './draw.js';
import { magpie, BEAK_TIP } from './magpie.js';
import { FPS, DUR, T, B } from './timeline.js';

const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const layer = document.createElement('canvas'); layer.width = W; layer.height = H; const L = layer.getContext('2d');
let GM = null, GMP = null, ST = {}, SP = {}, PAGE = null;
const I = new DOMMatrix();

// ——— 带线条抖动 + 墨粒的道具层：画进离屏层，吃掉一点墨，再盖回主画布 ———
function inkLayer(m, fn) {
  L.setTransform(I); L.clearRect(0, 0, W, H); L.setTransform(m); fn(L);
  L.setTransform(I); L.globalCompositeOperation = 'destination-out';
  GMP.setTransform(new DOMMatrix().translate((BOIL * 137) % 512, (BOIL * 71) % 512)); L.fillStyle = GMP; L.fillRect(0, 0, W, H);
  L.globalCompositeOperation = 'source-over';
  ctx.save(); ctx.setTransform(I); ctx.drawImage(layer, 0, 0); ctx.restore();
}
const camM = (cx, cy, z, dx = 0, dy = 0) => new DOMMatrix([z, 0, 0, z, W / 2 - cx * z + dx, H / 2 - cy * z + dy]);

// ——— 震屏（二次衰减）、闪光、拍点脉动 ———
const SHAKES = [
  [T.key0, 2, .08], [T.key1, 2, .08], [T.key2, 2, .08], [T.key3, 2, .08], [T.key4, 2, .08], [T.key5, 2, .08], [T.key6, 2, .08],
  [T.pin1, 7, .22], [T.pin2, 7, .22], [T.pin3, 7, .22], [T.pull, 12, .3],
  [T.str1, 5, .2], [T.str2, 5, .2], [T.str3, 6, .2], [T.x1, 4, .15], [T.x2, 5, .15], [T.x3, 5, .15], [T.x4, 6, .15], [T.x5, 7, .15], [T.x6, 8, .15],
  [T.plate, 6, .2], [T.stamp, 26, .45], [T.land, 4, .15],
];
function shake(t) {
  let dx = 0, dy = 0;
  for (const [t0, a, d] of SHAKES) if (t >= t0 && t < t0 + d) { const k = 1 - (t - t0) / d; dx += a * k * k * Math.sin(t * 91 + t0); dy += a * k * k * Math.cos(t * 77 + t0 * 3); }
  if (t >= 12 && t < 13) { const a = 10 * Math.pow(seg(t, 12, 13), 1.5); dx += a * Math.sin(t * 113); dy += a * Math.cos(t * 97); }
  return [dx, dy];
}
const FLASHES = [[T.flash1, .5, .32], [T.snap, .42, .26], [T.stamp, .5, .12]];
function beatPulse(t) {
  const groove = [[B('cover', .5), B('exhibits', 9), 90, B('cover', .5)], [T.pull, 11, 120, T.pull], [T.snap, T.cut, 90, T.flash1]];
  for (const [a, b, bpm, o] of groove) if (t >= a && t < b) { const ph = ((t - o) % (60 / bpm) + 60 / bpm) % (60 / bpm); return 1 + .006 * Math.exp(-ph / .07); }
  return 1;
}

// ——— HUD：案卷号 + 章节签（左上），REC + 日期（右上）；暗场反色 ———
const CHIPS = [[0, 3, '封面'], [3, 9, '证物'], [9, 14, '证物板'], [14, T.stamp, '嫌犯'], [T.stamp, 99, '结案']];
function hud(t, dark) {
  ctx.setTransform(I);
  const ink1 = dark ? C.paper : C.navy, ink2 = dark ? C.navy : C.paper;
  ctx.font = font(30, F.mono, 800); const s1 = '案卷 No.1013', w1 = ctx.measureText(s1).width;
  ctx.beginPath(); ctx.roundRect(56, 44, w1 + 40, 52, 12); ctx.fillStyle = ink1; ctx.fill();
  ctx.fillStyle = ink2; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(s1, 76, 71); regText(ctx, 'hud_case', s1, 76, 52, 76 + w1, 90);
  const ch = CHIPS.find(c => t >= c[0] && t < c[1]); ctx.font = font(30, F.sans);
  const w2 = ctx.measureText(ch[2]).width;
  ctx.beginPath(); ctx.roundRect(56 + w1 + 56, 44, w2 + 40, 52, 26); ctx.fillStyle = C.yellow; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = ink1; ctx.stroke();
  ctx.fillStyle = C.navy; ctx.fillText(ch[2], 76 + w1 + 56, 71); regText(ctx, 'hud_chip', ch[2], 76 + w1 + 56, 52, 76 + w1 + 56 + w2, 90);
  ctx.font = font(30, F.mono, 800); const s3 = 'REC  1958.10.31', w3 = ctx.measureText(s3).width;
  const x3 = W - 60 - w3; ctx.beginPath(); ctx.roundRect(x3 - 60, 44, w3 + 82, 52, 12); ctx.fillStyle = ink2; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = ink1; ctx.stroke(); ctx.fillStyle = ink1; ctx.fillText(s3, x3, 71); regText(ctx, 'hud_rec', s3, x3, 52, x3 + w3, 90);
  if (Math.floor(t * 2) % 2 === 0) { ctx.beginPath(); ctx.arc(x3 - 26, 71, 11, 0, TAU); ctx.fillStyle = C.red; ctx.fill(); }
}

// ================= 场景 1：案卷封面（打字机） =================
const TITLE = '第13页失踪案', KEYS = [T.key0, T.key1, T.key2, T.key3, T.key4, T.key5, T.key6];
function sceneCover(t, sh) {
  ctx.setTransform(I); ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
  const z = (1 + .05 * ss(t / 3)) * beatPulse(t), m = camM(960, 545, z, sh[0], sh[1]);
  ctx.setTransform(m);
  halftone(ctx, { x0: -120, y0: -120, w: 2160, h: 1320, step: 24, angle: 15, color: C.cobalt, f: edgeF(960, 540, 760, 1.4, 1.2) });
  const fm = m.translate(960, 560).rotate(-1.2);
  inkLayer(fm, g => {
    ink(g, rectPts(-735, -470, 360, 110, 3), { fill: C.yellow, lw: 8, curve: false, salt: 11 });
    ink(g, rectPts(-750, -390, 1500, 830, 5), { fill: C.yellow, lw: 8, curve: false, salt: 12, clipFn: () => {
      halftone(g, { x0: -760, y0: -400, w: 1520, h: 850, step: 22, angle: 45, color: C.navy, mul: true, f: (x, y) => .55 * clamp((x + y - 300) / 900) + .05 });
    } });
  });
  ctx.setTransform(fm);
  ctx.font = font(44, F.sans); ctx.fillStyle = C.navy; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillText('卷宗', -705, -400); regText(ctx, 'cover_tab', '卷宗', -705, -440, -705 + 88, -396);
  // 巨大半调"13"，出血到画右（装饰图形，不计入阅读检查）
  drawGlyph(ctx, SP.g13, 330, 470, 1, { dx: 14, dy: 14 });
  inkLayer(fm, g => { ink(g, rectPts(-640, -300, 900, 520, 4), { fill: C.card, lw: 6, curve: false, salt: 13 }); g.strokeStyle = C.navy; g.lineWidth = 2.5; g.strokeRect(-620, -280, 860, 480); });
  ctx.setTransform(fm);
  // 打字机：每个键一个字，带轻微错位与墨色深浅
  const lines = [[0, 4, -585, -60], [4, 7, -585, 150]];
  let typed = 0; for (const k of KEYS) if (t >= k) typed++;
  ctx.font = font(196, F.serif); ctx.textBaseline = 'alphabetic';
  const chars = [...TITLE]; let caretX = -585, caretY = -60;
  for (const [a, b, x0, y0] of lines) {
    let pen = x0;
    for (let i = a; i < b; i++) {
      const adv = ctx.measureText(chars[i]).width;
      if (i < typed) {
        const age = t - KEYS[i], s = 1 + .08 * clamp(1 - age / .06);
        ctx.save(); ctx.translate(pen + adv / 2, y0 + (hash(i * 5.1) - .5) * 7); ctx.rotate((hash(i * 2.7) - .5) * .05); ctx.scale(s, s);
        shadowText(ctx, chars[i], -adv / 2, 0, 196, F.serif, { color: C.navy, shadow: C.cobalt, dx: 8, dy: 8 });
        ctx.restore(); caretX = pen + adv + 10; caretY = y0;
      }
      pen += adv;
    }
  }
  if (typed > 0) regText(ctx, 'cover_title', TITLE, -585, -235, 120, 190);
  if (typed < 7 || Math.floor((t - T.key6) * 3) % 2 === 0) { ctx.fillStyle = C.red; ctx.fillRect(caretX, caretY - 150, 16, 170); }
  ctx.font = font(46, F.mono, 800); ctx.fillStyle = C.navy; ctx.fillText('页数 12/', -585, 330);
  const pw = ctx.measureText('页数 12/').width; ctx.fillStyle = C.red; ctx.fillText('13', -585 + pw, 330);
  regText(ctx, 'cover_pages', '页数 12/13', -585, 290, -585 + pw + 56, 340);
  ctx.font = font(30, F.mono, 800); ctx.fillStyle = C.navy; ctx.fillText('缺页 1', -585 + pw + 90, 330); regText(ctx, 'cover_miss', '缺页 1', -585 + pw + 90, 300, -585 + pw + 200, 336);
  drawStamp(ctx, ST.secret, 'cover_secret', '机密', 380, -300, 11, 99, -1, .9);
}

// ================= 场景 2+3：证物板（同一个世界） =================
const EX = [{ x: -610, y: 60, r: -4 }, { x: -170, y: -20, r: 3 }, { x: 270, y: 80, r: -2 }];
const PINS = [T.pin1, T.pin2, T.pin3], ACTS = [T.act1, T.act2, T.act3];
const QC = { x: 700, y: -30, r: 1.5 };
const NOTES = [{ x: -860, y: 420, r: -6 }, { x: 560, y: 380, r: 5 }, { x: -280, y: 420, r: 3 }];
const rotP = (o, lx, ly) => { const a = o.r * Math.PI / 180; return [o.x + lx * Math.cos(a) - ly * Math.sin(a), o.y + lx * Math.sin(a) + ly * Math.cos(a)]; };
const pinOf = o => rotP(o, 0, -o.h || -176);
EX.forEach(e => e.h = 176); QC.h = 132; NOTES.forEach(n => n.h = 56);
const STR = [
  [EX[0], QC, T.str1, 0], [EX[1], QC, T.str2, 1], [EX[2], QC, T.str3, 2],
  [EX[0], EX[1], T.x1, 3], [EX[1], EX[2], T.x2, 4], [NOTES[0], QC, T.x3, 5], [NOTES[1], QC, T.x4, 6], [NOTES[2], EX[1], T.x5, 7], [EX[0], EX[2], T.x6, 8],
];
const TWO = k => [EX[k].x - 230, EX[k].y - 40, 1.35];
function camBoard(t) {
  const L3 = (a, b, p) => [lerp(a[0], b[0], p), lerp(a[1], b[1], p), Math.exp(lerp(Math.log(a[2]), Math.log(b[2]), p))];
  if (t < T.pan2 - .5) { const c = TWO(0); return [c[0] + (t - 3) * 9, c[1], c[2]]; }
  if (t < T.pan2) return L3([TWO(0)[0] + 13.5, TWO(0)[1], 1.35], TWO(1), eio(seg(t, T.pan2 - .5, T.pan2)));
  if (t < T.pan3 - .5) { const c = TWO(1); return [c[0] + (t - T.pan2) * 9, c[1], c[2]]; }
  if (t < T.pan3) return L3([TWO(1)[0] + 13.5, TWO(1)[1], 1.35], TWO(2), eio(seg(t, T.pan3 - .5, T.pan3)));
  if (t < T.pull - 1 / 3) { const c = TWO(2); return [c[0], c[1], c[2] + .05 * ss(seg(t, T.pan3, T.pull - 1 / 3))]; }
  if (t < T.pull) { const p = seg(t, T.pull - 1 / 3, T.pull), q = p * p; return L3([TWO(2)[0], TWO(2)[1], 1.4], [0, 0, 1], q); }
  if (t < 11) { const a = t - T.pull; return [0, 0, 1 - .04 * Math.exp(-a * 7) * Math.sin(a * 17)]; }
  const p = seg(t, 11, 13); return [lerp(0, 560, ss(p)), lerp(0, -10, ss(p)), lerp(1, 1.3, p * p)];
}
function drawString(g, a, b, hit, t, i) {
  if (t < hit - .12) return;
  const pa = pinOf(a), pb = pinOf(b), p = seg(t, hit - .12, hit), e = [lerp(pa[0], pb[0], ei(p)), lerp(pa[1], pb[1], ei(p))];
  const len = Math.hypot(e[0] - pa[0], e[1] - pa[1]), age = t - hit;
  let sag = age < 0 ? lerp(70, 26, p) : 14 + len * .012 + 26 * Math.exp(-age * 6) * Math.cos(age * 42);
  if (t > 12) sag += 9 * seg(t, 12, 13) * Math.sin(t * 60 + i * 2);
  const mx = (pa[0] + e[0]) / 2, my = (pa[1] + e[1]) / 2 + sag * 2;
  const path = () => { g.beginPath(); g.moveTo(pa[0], pa[1]); g.quadraticCurveTo(mx, my, e[0], e[1]); };
  g.lineCap = 'round';
  g.globalCompositeOperation = 'multiply'; g.save(); g.translate(5, 6); path(); g.strokeStyle = C.cobalt; g.lineWidth = 5; g.stroke(); g.restore();
  g.globalCompositeOperation = 'source-over'; path(); g.strokeStyle = C.red; g.lineWidth = 6; g.stroke();
}
function pin(g, x, y) {
  g.beginPath(); g.arc(x, y, 17, 0, TAU); g.fillStyle = C.red; g.fill(); g.lineWidth = 5; g.strokeStyle = C.navy; g.stroke();
  g.beginPath(); g.arc(x - 5, y - 6, 5, 0, TAU); g.fillStyle = C.white; g.fill();
}
function silhouette(g, cx, cy, s, fill, stroke, lw = 6) {
  g.save(); g.translate(cx, cy); g.scale(s, s);
  ink(g, [[-120, 110], [-112, 40], [-70, 8], [-30, -4], [30, -4], [70, 8], [112, 40], [120, 110]], { fill, stroke, lw, salt: 31 });
  ink(g, ell(0, -48, 40, 46, 12), { fill, stroke, lw, salt: 32 });
  ink(g, ell(0, -82, 82, 15, 12), { fill, stroke, lw, salt: 33 });
  ink(g, [[-44, -86], [-38, -132], [0, -142], [38, -132], [44, -86]], { fill, stroke, lw, salt: 34 });
  g.restore();
}
function cardBody(g, k, t) {
  const pts = rectPts(-170, -200, 340, 400, 3);
  ink(g, pts, { fill: C.card, lw: 6, curve: false, salt: 20 + k });
  g.strokeStyle = C.navy; g.lineWidth = 2.5; g.strokeRect(-150, -172, 300, 252);
  g.save(); g.beginPath(); g.rect(-150, -172, 300, 252); g.clip();
  halftone(g, { x0: -150, y0: -172, w: 300, h: 252, step: 14, angle: 30, color: C.cobalt, mul: true, k: .6, f: () => .2 });
  if (k === 0) {   // 书签：右边一个 V 形咬痕
    g.save(); g.rotate(6 * Math.PI / 180);
    const bm = [[-44, -150], [44, -150], [44, -56], [24, -42], [44, -28], [44, 64], [0, 40], [-44, 64]];
    ink(g, bm, { fill: C.yellow, lw: 6, curve: false, salt: 40, clipFn: () => {
      halftone(g, { x0: -50, y0: -160, w: 100, h: 230, step: 12, angle: 45, color: C.red, mul: true, k: .6, f: (x, y) => .25 + .25 * Math.sin(y / 18) });
      g.fillStyle = C.navy; for (let i = 0; i < 5; i++) g.fillRect(-30, -96 + i * 22, 44 - (i % 2) * 14, 5);
    } });
    g.beginPath(); g.arc(0, -128, 9, 0, TAU); g.fillStyle = C.paper; g.fill(); g.lineWidth = 4; g.strokeStyle = C.navy; g.stroke();
    const sw = t > T.pin1 ? 22 * Math.exp(-(t - T.pin1) * 2.6) * Math.cos((t - T.pin1) * 8.5) : 0;
    g.save(); g.translate(0, -128); g.rotate((sw - 20) * Math.PI / 180);
    g.strokeStyle = C.red; g.lineWidth = 5; g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(30, -40, 70, -20, 64, 30); g.stroke();
    ink(g, [[56, 26], [74, 26], [82, 92], [48, 92]], { fill: C.red, lw: 4, curve: false, salt: 42 });
    g.restore();
    // 证物动作：红笔圈出咬痕
    const pc = seg(t, T.act1 - .25, T.act1);
    if (pc > 0) { g.strokeStyle = C.red; g.lineWidth = 7; g.lineCap = 'round'; g.beginPath(); g.ellipse(36, -42, 46, 40, -.3, -2.2, -2.2 + TAU * 1.08 * eo(pc)); g.stroke(); }
    g.restore();
  } else if (k === 1) {   // 墨水指纹：扫粉后径向显影
    const pd = seg(t, T.act2 - .25, T.act2), aft = t - T.act2;
    const den = pd > 0 ? (aft < 0 ? eo(pd) : 1 + wob(aft, .25, 18, 7)) : 0;
    halftone(g, { x0: -150, y0: -172, w: 300, h: 252, step: 13, angle: 15, color: C.navy, mul: true, k: .66, f: radial(0, -46, 70 + 70 * den, 1, .2 + .7 * den) });
    g.save(); g.translate(0, -46); g.rotate(.18);
    for (let i = 0; i < 9; i++) {
      const r = 14 + i * 11.5, gap = hash(i * 9.3) * 5;
      g.beginPath(); g.ellipse(0, 0, r * .82, r, 0, gap + .5, gap + .5 + TAU * (.78 + hash(i) * .16));
      g.strokeStyle = den > 0 ? C.navy : C.cobalt; g.lineWidth = 3.4 + den * 1.4; g.stroke();
    }
    g.restore();
  } else {   // 窗台 + 黑白羽毛
    g.fillStyle = C.navy; g.fillRect(-120, -172, 240, 168);
    halftone(g, { x0: -120, y0: -172, w: 240, h: 168, step: 13, angle: 15, color: C.cobalt, k: .66, f: (x, y) => .5 + .3 * Math.sin(x / 30) * .5 });
    g.beginPath(); g.arc(60, -120, 22, 0, TAU); g.fillStyle = C.yellow; g.fill();
    g.strokeStyle = C.card; g.lineWidth = 12; g.strokeRect(-120, -172, 240, 168); g.beginPath(); g.moveTo(0, -172); g.lineTo(0, -4); g.moveTo(-120, -88); g.lineTo(120, -88); g.stroke();
    g.strokeStyle = C.navy; g.lineWidth = 4; g.strokeRect(-126, -178, 252, 180);
    ink(g, rectPts(-150, 2, 300, 30, 3), { fill: C.yellow, lw: 5, curve: false, salt: 44 });
    if (t >= T.pin3) {
      const p = seg(t, T.pin3, T.act3), aft = t - T.act3;
      const fy = aft < 0 ? lerp(-190, -6, ss(p)) : -6 + wob(aft, 3, 30, 12), fx = aft < 0 ? 46 * Math.sin(p * 9) * (1 - p) : 0;
      const fr = aft < 0 ? 40 * Math.sin(p * 9 + 1) * (1 - p) - 8 : -8 + wob(aft, 4, 26, 10);
      g.save(); g.translate(fx, fy); g.rotate(fr * Math.PI / 180);
      ink(g, [[-80, 0], [-40, -16], [10, -20], [60, -10], [86, 0], [60, 8], [10, 12], [-40, 10]], { fill: C.white, lw: 5, salt: 45 });
      ink(g, [[-80, 0], [-40, -16], [10, -20], [8, 12], [-40, 10]], { fill: C.navy, lw: 5, salt: 46 });
      g.strokeStyle = C.teal; g.lineWidth = 5; g.beginPath(); g.moveTo(-60, -6); g.quadraticCurveTo(-20, -14, 0, -10); g.stroke();
      g.strokeStyle = C.navy; g.lineWidth = 3; g.beginPath(); g.moveTo(-96, 3); g.lineTo(84, 0); g.stroke();
      g.restore();
    }
  }
  g.restore();
}
const TAGS = [['证物 01', '书签'], ['证物 02', '墨水指纹'], ['证物 03', '黑白羽毛']];
const PEEK = 430;
function cardPose(k, t) {   // 卡片从画下冲上来，T.pin 撞上板子
  const e = EX[k], p = seg(t, PINS[k] - .4, PINS[k]), a = t - PINS[k];
  let dy = a < 0 ? 760 * Math.pow(1 - p, 1.6) : 0; const rr = a < 0 ? 10 * (1 - p) : wob(a, 3, 20, 7);
  // 证物一：擦除一退就从画下探出顶部（3.0→3.267 缓出，停在露头位置），再在 T.pin1-.4 起猛冲钉住（预备动作）
  if (k === 0 && a < 0) dy = t < PINS[0] - .4 ? lerp(760, PEEK, 1 - Math.pow(1 - seg(t, T.wipe, PINS[0] - .4), 3)) : PEEK * Math.pow(1 - p, 1.6);
  return { x: e.x, y: e.y + dy, r: e.r + rr, s: a < 0 ? 1 : 1 + wob(a, .04, 26, 9) };
}
function sceneBoard(t, sh) {
  ctx.setTransform(I); ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
  const [cx, cy, z0] = camBoard(t), z = z0 * beatPulse(t), m = camM(cx, cy, z, sh[0], sh[1]);
  ctx.setTransform(m);
  halftone(ctx, { x0: -1300, y0: -800, w: 2600, h: 1700, step: 24, angle: 15, color: C.cobalt, f: (x, y) => clamp((Math.max(x - 1230, -1630 - x, Math.abs(y) - 600)) / 140 + .3) });
  // 板子（一张大纸）
  inkLayer(m, g => ink(g, rectPts(-1660, -620, 2920, 1250, 8), { fill: C.card, lw: 8, curve: false, salt: 50, clipFn: () => {
    halftone(g, { x0: -1660, y0: -620, w: 2920, h: 1250, step: 22, angle: 45, color: C.yellow, mul: true, k: .62, f: (x, y) => .26 + .34 * clamp((Math.hypot(x, y * 1.4) - 600) / 600) });
    g.globalCompositeOperation = 'multiply'; g.strokeStyle = C.cobalt; g.lineWidth = 2;
    for (let x = -1600; x <= 1200; x += 100) { g.beginPath(); g.moveTo(x, -620); g.lineTo(x, 630); g.stroke(); }
    for (let y = -600; y <= 630; y += 100) { g.beginPath(); g.moveTo(-1660, y); g.lineTo(1260, y); g.stroke(); }
    g.globalCompositeOperation = 'source-over';
  } }));
  ctx.setTransform(m);
  // 巨大编号（钉上时弹出）
  ['g1', 'g2', 'g3'].forEach((key, k) => {
    const a = t - PINS[k]; if (a < -.2) return;
    const s = a < 0 ? eo(seg(t, PINS[k] - .2, PINS[k])) : 1 + wob(a, .1, 20, 8);
    drawGlyph(ctx, SP[key], EX[k].x + 175, EX[k].y + 300, s, { dx: 14, dy: 14, center: true });
  });
  // 嫌犯卡周围的红色网点光晕（11 s 起越来越密）
  if (t > 11) { const p = seg(t, 11, 13); halftone(ctx, { x0: -1000, y0: -560, w: 2000, h: 1190, step: 24, angle: 70, color: C.red, mul: true, k: .7, f: radial(QC.x, QC.y, 200 + 900 * ss(p), 1.1, .4 + 1.1 * p) }); }
  // 便签（无字的涂鸦）
  inkLayer(m, g => NOTES.forEach((n, i) => {
    g.save(); g.translate(n.x, n.y); g.rotate(n.r * Math.PI / 180);
    ink(g, rectPts(-75, -75, 150, 150, 2), { fill: C.yellow, lw: 5, curve: false, salt: 60 + i });
    g.strokeStyle = C.navy; g.lineWidth = 6; g.lineCap = 'round'; g.beginPath();
    if (i === 0) { g.moveTo(0, -30); g.lineTo(0, 30); g.moveTo(0, 0); g.lineTo(-30, -34); g.moveTo(0, 0); g.lineTo(30, -34); g.moveTo(0, 30); g.lineTo(0, 50); }
    else if (i === 1) { g.arc(0, 8, 36, -1.2, 2.6); }
    else { g.moveTo(-36, 30); g.lineTo(-10, -30); g.lineTo(14, 20); g.lineTo(40, -26); }
    g.stroke(); g.restore();
  }));
  // 嫌犯卡（戴礼帽的剪影 + 问号）
  // 嫌犯卡在拉远落定的强拍上从画下冲上来钉住
  const qa = t - T.pull, qp = seg(t, T.pull - .4, T.pull), qdy = qa < 0 ? 760 * Math.pow(1 - qp, 1.6) : 0, qr = QC.r + (qa < 0 ? 10 * (1 - qp) : wob(qa, 3, 20, 7));
  const qm = m.translate(QC.x, QC.y + qdy).rotate(qr);
  if (t >= T.pull - .4) inkLayer(m, g => {
    g.save(); g.translate(QC.x, QC.y + qdy); g.rotate(qr * Math.PI / 180);
    ink(g, rectPts(-160, -150, 320, 300, 3), { fill: C.card, lw: 6, curve: false, salt: 70 });
    g.save(); g.beginPath(); g.rect(-140, -126, 280, 196); g.clip();
    halftone(g, { x0: -140, y0: -126, w: 280, h: 196, step: 14, angle: 30, color: C.cobalt, mul: true, k: .62, f: () => .32 });
    silhouette(g, 0, 40, .9, C.navy, C.navy, 4);
    g.restore(); g.strokeStyle = C.navy; g.lineWidth = 2.5; g.strokeRect(-140, -126, 280, 196);
    g.restore();
  });
  if (t >= T.pull - .4) {
  ctx.setTransform(qm);
  shadowText(ctx, '?', 0, 30, 150, F.bagel, { color: C.yellow, shadow: C.red, dx: 6, dy: 6, align: 'center', w: 400 });
  ctx.font = font(46, F.sans); ctx.textAlign = 'left'; ctx.fillStyle = C.navy; ctx.fillText('嫌犯？', -130, 126); regText(ctx, 'qcard', '嫌犯？', -130, 84, -130 + ctx.measureText('嫌犯？').width, 132);
  }
  // 三张证物卡
  for (let k = 0; k < 3; k++) {
    if (t < (k ? PINS[k] - .4 : T.wipe)) continue;
    const ps = cardPose(k, t), cm = m.translate(ps.x, ps.y).rotate(ps.r).scale(ps.s);
    inkLayer(cm, g => cardBody(g, k, t));
    ctx.setTransform(cm); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = font(30, F.mono, 800); ctx.fillStyle = C.cobalt; ctx.fillText(TAGS[k][0], -150, 124); regText(ctx, `tag${k}a`, TAGS[k][0], -150, 98, -150 + ctx.measureText(TAGS[k][0]).width, 128);
    ctx.font = font(50, F.sans); ctx.fillStyle = C.navy; ctx.fillText(TAGS[k][1], -150, 180); regText(ctx, `tag${k}b`, TAGS[k][1], -150, 136, -150 + ctx.measureText(TAGS[k][1]).width, 186);
  }
  // 红线 + 图钉
  inkLayer(m, g => {
    STR.forEach(([a, b, hit, i]) => drawString(g, a, b, hit, t, i));
    for (let k = 0; k < 3; k++) if (t >= PINS[k]) { const ps = cardPose(k, t); const [px, py] = rotP({ x: ps.x, y: ps.y, r: ps.r }, 0, -176); pin(g, px, py); }
    if (t >= T.pull) pin(g, ...rotP({ x: QC.x, y: QC.y + qdy, r: qr }, 0, -QC.h)); NOTES.forEach(n => pin(g, ...pinOf(n)));
  });
  ctx.setTransform(I);
  // 标题（屏幕空间）
  if (t < T.pull) popText(ctx, 'hl_ex', '三件证物', 110, 245, 110, F.serif, t, T.hl1);
  else popText(ctx, 'hl_board', '谁拿走了第13页？', 110, 245, 100, F.serif, t, T.hl2, { colors: [0, 0, 0, 0, 0, C.red, C.red, 0, 0].map(c => c || C.navy) });
  // 画面边缘的网点越挤越密 → 吞满
  ctx.setTransform(I);
  if (t > 11) {
    const p = seg(t, 11, 13), u = Math.pow(seg(t, 12.45, 12.97), 2) * 1.3;
    halftone(ctx, { step: 24, angle: 15, color: C.navy, k: .72, f: (x, y) => edgeF(960, 540, lerp(1100, 380, p * p), 1.3, lerp(.8, 3, p * p))(x, y) + u });
    if (t >= 12.97) { ctx.fillStyle = C.navy; ctx.fillRect(0, 0, W, H); }
  }
  // 吞噬的最后 0.2 s：礼帽剪影带着钴蓝网点晕叠印出来（网点从零长大），13.0 正好长满接停顿镜头，不留纯色帧
  if (t >= 12.8) hushLayer(t, ss(seg(t, 12.8, T.swallow)));
}

// ================= 场景 4：停顿（深墨底） =================
function hushLayer(t, a = 1) {   // a：叠印进度（0→1）。网点按 a 长大，剪影与问号按 a 显影
  const z = 1 + .02 * seg(t, 13, 14), m = camM(960, 560, z);
  ctx.setTransform(m);
  halftone(ctx, { step: 24, angle: 15, color: C.cobalt, k: .7, f: radial(960, 560, (560 + 30 * Math.sin(t * 3)) * (.55 + .45 * a), 1.3, .85 * a) });
  ctx.save(); ctx.globalAlpha = a;
  inkLayer(m, g => silhouette(g, 960, 600, 2.2, null, C.paper, 3));
  const qs = 1 + .35 * (1 - a);
  ctx.setTransform(m.translate(960, 640).scale(qs)); shadowText(ctx, '?', 0, 0, 300, F.bagel, { color: C.yellow, shadow: C.red, dx: 10, dy: 10, align: 'center', w: 400 });
  ctx.restore();
}
function sceneHush(t) {
  ctx.setTransform(I); ctx.fillStyle = C.navy; ctx.fillRect(0, 0, W, H);
  hushLayer(t, 1);
  // 闪光灯充电的光点（配合充电声）
  const pc = seg(t, 13.55, 14);
  if (pc > 0) {
    ctx.setTransform(I); ctx.save(); ctx.translate(960, 380); ctx.rotate(t * 2);
    const r = 6 + 70 * pc * pc; ctx.beginPath();
    for (let i = 0; i < 16; i++) { const a = i / 16 * TAU, rr = i % 2 ? r * .25 : r; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    ctx.closePath(); ctx.fillStyle = C.paper; ctx.fill(); ctx.restore();
  }
}

// ================= 场景 5：嫌犯照 + 结案 =================
const MP = { x: 1200, y: 830 }, HOLD = [MP.x + BEAK_TIP[0], MP.y + BEAK_TIP[1]];
const STAMP_XY = [880, 610];   // 斜压在喜鹊胸口与照片的交界处
function camMug(t) {
  const ecu = [928, 468, 3.0];
  if (t < T.snap - 1 / 6) return [ecu[0], ecu[1], ecu[2] + .12 * seg(t, T.flash1, T.snap - 1 / 6)];
  if (t < T.snap) { const q = Math.pow(seg(t, T.snap - 1 / 6, T.snap), 3); return [lerp(ecu[0], 960, q), lerp(ecu[1], 540, q), Math.exp(lerp(Math.log(3.12), 0, q))]; }
  const a = t - T.snap, zs = 1 - .045 * Math.exp(-a * 6) * Math.sin(a * 15);
  if (t < T.cap) return [960, 540, zs];
  const p = ss(seg(t, T.cap, T.cut)); return [lerp(960, 985, p), lerp(540, 530, p), zs * lerp(1, 1.05, p) * (1 + .006 * seg(t, T.cut, T.stamp))];
}
function pose(t) {
  const P = { open: 1, wide: 0, lookX: -.5, lookY: .1, beak: 0, tilt: 0, puff: 0, sq: 1, breathe: Math.sin(t * 2.6) };
  if (t > T.plate) P.open = lerp(1, .62, seg(t, T.plate, T.plate + .2));
  for (const b of [T.hl3 + .25]) if (t > b && t < b + .14) P.open = 0;
  if (t >= T.snap && t < T.cut) { const ph = (t - T.flash1) % (2 / 3); P.tilt = 5 * Math.exp(-ph / .16) * (Math.floor((t - T.flash1) / (2 / 3)) % 2 ? 1 : -1); }
  if (t >= T.cut) { const p = eo(seg(t, T.cut, T.cut + .22)); P.lookY = lerp(.1, -1, p); P.lookX = lerp(-.5, .2, p); P.wide = p; P.open = lerp(P.open, 1, p); P.tilt = -9 * p; }
  if (t >= T.stamp) {
    const a = t - T.stamp; P.sq = 1 + wob(a, .1, 22, 7); P.puff = Math.exp(-a * 3); P.open = a < .26 ? 0 : 1; P.wide = a < .26 ? 0 : 1 - .6 * seg(t, T.squawk + .3, T.final);
    P.lookY = lerp(-1, .3, seg(t, T.stamp, T.stamp + .1)); P.lookX = -.4; P.tilt = lerp(-9, 4, seg(t, T.stamp, T.stamp + .12)) + wob(a, 4, 18, 5);
  }
  if (t >= T.squawk - .07) { const a = t - T.squawk; P.beak = a < 0 ? seg(t, T.squawk - .07, T.squawk) : clamp(1 - seg(t, T.squawk + .35, T.squawk + .6) * .6); }
  if (t >= T.final) { const a = t - T.final; P.puff = Math.max(P.puff, .7 * Math.exp(-a * 4) * (1 + Math.sin(a * 30)) / 2); P.open = t > 19.15 && t < 19.29 ? 0 : .85; P.beak = .4; P.lookX = -.7; P.lookY = .2; }
  return P;
}
function pagePos(t) {   // 纸页：叼着 → 松口飘落 → T.land 落地
  if (t < T.squawk) { const P = pose(t); return [HOLD[0], HOLD[1] + P.beak * 10, -12 + (P.tilt || 0) * .6]; }
  const p = seg(t, T.squawk, T.land), a = t - T.land;
  if (a < 0) return [lerp(HOLD[0], 390, ss(p)) + 70 * Math.sin(p * 7) * (1 - p), lerp(HOLD[1], 592, p * p), -12 + 34 * Math.sin(p * 7 + .4) * (1 - p) + 16 * p];
  return [390, 592 + wob(a, -6, 26, 10), 4 + wob(a, 3, 22, 8)];
}
function sceneMug(t, sh) {
  ctx.setTransform(I); ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
  const [cx, cy, z0] = camMug(t), z = z0 * beatPulse(t), m = camM(cx, cy, z, sh[0], sh[1]);
  ctx.setTransform(m);
  // 背景：自上而下变密的钴蓝网点 + 身高尺
  halftone(ctx, { x0: -60, y0: -60, w: 2040, h: 1200, step: 22, angle: 15, color: C.cobalt, f: ramp(100, 900, .06, .42, 1.3) });
  const bloom = t > T.stamp ? 1 + .5 * Math.exp(-(t - T.stamp) * 2.2) : 1;
  halftone(ctx, { x0: 500, y0: 0, w: 1420, h: 1000, step: 22, angle: 45, color: C.yellow, mul: true, k: .7, f: radial(1190, 520, 520 * bloom, 1.2, .95) });
  ctx.fillStyle = C.navy;
  for (let cm = 0; cm <= 52; cm += 2) {
    const y = MP.y - cm * 12, major = cm % 10 === 0;
    ctx.fillRect(180, y - (major ? 2.5 : 1), major ? W - 300 : 34, major ? 5 : 2); if (!major) ctx.fillRect(W - 154, y - 1, 34, 2);
    if (major && cm > 0 && cm < 50) { ctx.font = font(40, F.mono, 800); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; const s = String(cm); ctx.fillText(s, 168, y); regText(ctx, 'chart' + cm, s, 168 - ctx.measureText(s).width, y - 18, 168, y + 18); }
  }
  // 地台
  halftone(ctx, { x0: -60, y0: MP.y, w: 2040, h: 340, step: 22, angle: 15, color: C.navy, f: ramp(MP.y, 1080, .35, .8) });
  ctx.fillStyle = C.navy; ctx.fillRect(-60, MP.y - 4, 2040, 8);
  // 印章将至：影子越压越近
  if (t > T.cut && t < T.stamp) { const p = seg(t, T.cut, T.stamp - .09); halftone(ctx, { x0: 420, y0: 300, w: 820, h: 680, step: 22, angle: 30, color: C.navy, mul: true, k: .7, f: radial(STAMP_XY[0], STAMP_XY[1], lerp(420, 260, p), 1.4, lerp(.15, .85, p * p)) }); }
  // 喜鹊（含线条抖动与墨粒）
  const P = pose(t), mm = m.translate(MP.x, MP.y);
  inkLayer(mm, g => magpie(g, P, t));
  // 被叼着的纸页（松口后飘落）
  const pp = pagePos(t);
  if (t < T.squawk) { ctx.setTransform(m); drawPage(ctx, PAGE, pp[0], pp[1], pp[2]); pageText(pp); }
  // 名牌
  if (t >= T.plate - .22) {
    const a = t - T.plate, dy = a < 0 ? 300 * Math.pow(1 - seg(t, T.plate - .22, T.plate), 1.6) : wob(a, 8, 24, 9);
    const pm = m.translate(MP.x, 885 + dy).rotate(a < 0 ? 0 : wob(a, 2, 20, 7));
    inkLayer(pm, g => { ink(g, rectPts(-210, -56, 420, 112, 3), { fill: C.navy, lw: 6, curve: false, salt: 80 }); g.strokeStyle = C.yellow; g.lineWidth = 3; g.strokeRect(-196, -42, 392, 84); });
    ctx.setTransform(pm); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = font(64, F.sans); ctx.fillStyle = C.paper; ctx.fillText('喜鹊', -176, 4); regText(ctx, 'plate_a', '喜鹊', -176, -32, -176 + ctx.measureText('喜鹊').width, 36);
    ctx.font = font(54, F.bagel, 400); ctx.fillStyle = C.yellow; ctx.textAlign = 'right'; ctx.fillText('No.13', 180, 6); regText(ctx, 'plate_b', 'No.13', 180 - ctx.measureText('No.13').width, -26, 180, 34);
  }
  // 结案
  ctx.setTransform(m); drawStamp(ctx, ST.closed, 'stamp', '结案', STAMP_XY[0], STAMP_XY[1], -9, t, T.stamp);
  // 飘落的纸页压在最上面
  if (t >= T.squawk) { ctx.setTransform(m); drawPage(ctx, PAGE, pp[0], pp[1], pp[2]); pageText(pp); }
  // 喳！
  if (t >= T.squawk - .1) {
    const a = t - T.squawk, s = a < 0 ? eo(seg(t, T.squawk - .1, T.squawk)) : 1 + wob(a, .18, 22, 7);
    ctx.setTransform(m.translate(780, 245).rotate(-10).scale(s));
    shadowText(ctx, '喳！', 0, 0, 150, F.hand, { color: C.paper, shadow: C.cobalt, dx: 9, dy: 9, align: 'center', w: 400, stroke: C.navy, sw: 16 });
    ctx.font = font(150, F.hand, 400); const ww = ctx.measureText('喳！').width; regText(ctx, 'squawk', '喳！', -ww / 2, -130, ww / 2, 20);
  }
  // 屏幕空间：标题 + 说明条
  ctx.setTransform(I);
  popText(ctx, 'hl_mug', '嫌犯', 230, 262, 150, F.serif, t, T.hl3);
  captionBar(ctx, 'cap_mug', [['罪名：叼走'], ['第13页', C.yellow]], 960, 1000, 50, t, T.cap);
}
function pageText(pp) {   // 纸页上的"13"计入阅读检查（大特写时出血，不算"完整可见"）
  const P = PAGE, [a, b, c, d] = P.numBox; ctx.save(); ctx.translate(pp[0], pp[1]); ctx.rotate(pp[2] * Math.PI / 180); regText(ctx, 'page13', '13', a, b, c, d); ctx.restore();
}

// ================= render(t) =================
function render(t) {
  t = Math.min(Math.max(t, 0), DUR - 1e-6);
  TXT.length = 0; setBoil(t);
  const sh = shake(t);
  let dark = false;
  if (t < T.wipe) sceneCover(t, sh);
  else if (t < T.swallow) { sceneBoard(t, sh); dark = t > 12.8; }
  else if (t < T.flash1) { sceneHush(t); dark = true; }
  else sceneMug(t, sh);
  ctx.setTransform(I);
  hud(t, dark);
  dotWipe(ctx, t, T.wipe, C.cobalt);
  let fl = 0; for (const [f, a, d] of FLASHES) if (t >= f && t < f + d) fl = Math.max(fl, a * Math.pow(1 - (t - f) / d, 2));
  if (fl > 0) { ctx.fillStyle = `rgba(255,255,255,${fl.toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  drawGrain(document.getElementById('fx'), Math.round(t * FPS), dark);
}

// ——— 声音事件（mix.py 读 events.json）———
function buildEV() {
  const E = [];
  const ev = (t, type, o = {}) => E.push({ t: +t.toFixed(6), type, ...o });
  KEYS.forEach((k, i) => ev(k, 'key', { i, hit: 'key' + i }));
  ev(T.bell, 'bell', { hit: 'bell' }); ev(T.wipe - .22, 'whoosh', { d: .44, g: .8, hit: 'wipe', peak: T.wipe });
  [...'三件证物'].forEach((_, i) => ev(T.hl1 + i / 15, 'pop', { i, hit: i ? undefined : 'hl1' }));
  PINS.forEach((p, k) => { ev(p - .34, 'swish', { d: .34, g: .5 }); ev(p, 'pin', { k, hit: 'pin' + (k + 1) }); ev(p, 'numeral', { k }); });
  ev(T.wipe, 'swish', { d: PINS[0] - .4 - T.wipe, g: .3 });   // 证物一探头
  ev(T.pin1 + .05, 'tassel', {});
  ev(T.act1 - .25, 'marker', { d: .25, hit: 'act1', peak: T.act1 }); ev(T.act2 - .25, 'dust', { d: .25, hit: 'act2', peak: T.act2 }); ev(T.pin3, 'featherfall', { d: T.act3 - T.pin3 }); ev(T.act3, 'featherland', { hit: 'act3' });
  ev(T.pan2 - .5, 'whoosh', { d: .5, g: .6, hit: 'pan2', peak: T.pan2 }); ev(T.pan3 - .5, 'whoosh', { d: .5, g: .6, hit: 'pan3', peak: T.pan3 });
  ev(T.pull - 1 / 3, 'riser', { d: 1 / 3, hit: 'pull', peak: T.pull }); ev(T.pull, 'boardhit', {}); ev(T.pull - .34, 'swish', { d: .34, g: .5 }); ev(T.pull, 'pin', { k: 3 });
  [...'谁拿走了第13页？'].forEach((_, i) => ev(T.hl2 + i / 15, 'pop', { i: i + 2, hit: i ? undefined : 'hl2' }));
  STR.forEach(([, , hit, i]) => ev(hit, 'twang', { i, hit: ['str1', 'str2', 'str3', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6'][i] }));
  ev(12, 'rattle', { d: 1 }); ev(T.swallow, 'swallow', { hit: 'swallow' });
  ev(13.55, 'charge', { d: T.flash1 - 13.55 });
  ev(T.flash1, 'shutter', { big: 1, hit: 'flash1' }); ev(T.snap - 1 / 6, 'whoosh', { d: 1 / 6, g: .7, peak: T.snap }); ev(T.snap, 'shutter', { big: 0, hit: 'snap' });
  ev(T.plate - .22, 'swish', { d: .22, g: .4 }); ev(T.plate, 'clack', { hit: 'plate' });
  [...'嫌犯'].forEach((_, i) => ev(T.hl3 + i / 15, 'pop', { i: i + 4, hit: i ? undefined : 'hl3' }));
  ev(T.cap, 'pop', { i: 9, big: 1, hit: 'cap' });
  ev(T.cut, 'lookup', { hit: 'cut' });
  ev(T.stamp, 'stamp', { hit: 'stamp' }); ev(T.stamp, 'flinch', {});
  ev(T.squawk, 'squawk', { hit: 'squawk' }); ev(T.squawk, 'flutter', { d: T.land - T.squawk }); ev(T.land, 'paperland', { hit: 'land' });
  ev(T.final, 'ruffle', { hit: 'final' });
  return E.map(e => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)));
}

async function init() {
  const all = document.documentElement.innerHTML + await (await fetch('main.js')).text();
  const fams = ['900 60px "SerifSC"', '900 60px "SansSC"', '400 60px "Bagel"', '800 60px "Mono"', '400 60px "Kuaile"'];
  await Promise.all(fams.map(f => document.fonts.load(f, all.replace(/[\x00-\x1f]/g, ''))));
  await document.fonts.ready;
  buildPaper(document.getElementById('paper'));
  GM = buildGrainMask(); GMP = ctx.createPattern(GM, 'repeat');
  ST.closed = buildStamp('结案', 190, C.red, 5); ST.secret = buildStamp('机密', 64, C.red, 9);
  SP.g13 = glyphSprite('13', 860, F.bagel, { fill: C.white, step: 24, angle: 45, f: (x, y) => .2 + .65 * clamp(y / 700), k: .7 });
  ['1', '2', '3'].forEach((n, k) => SP['g' + n] = glyphSprite(n, 640, F.bagel, { fill: [C.yellow, C.white, C.yellow][k], step: 22, angle: 45, f: (x, y) => .15 + .6 * clamp(y / 560), k: .68 }));
  PAGE = buildPage(3.5);
  window.DUR = DUR; window.EV = buildEV();
  window.TEXTS = () => TXT.map(b => ({ ...b }));
  window.render = render;
  const q = new URLSearchParams(location.search); render(parseFloat(q.get('t') || '0'));
  window.READY = true;
}
init();
