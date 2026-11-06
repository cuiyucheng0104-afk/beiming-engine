// 《零点密码》全片：表演、摄影机、声音事件、可读文字。所有时间来自 timeline.js
import { g, C, S, W, H, clear, piece, rough, roughC, rectP, circP, arcP } from './paper.js';
import { layout, drawLine } from './glyph.js';
import { agentSide, courierSide, bowler, runPose, walkPose, coRunPose, AGENT_POSE, COURIER_POSE } from './chars.js';
import { drawTitle, titleLayout, strokeSeed } from './title.js';
import { B, BEAT, DUR, HIT, T } from './timeline.js';
import { clamp, lerp, seg, ss, eio, eo, ei, back, hash } from '/core/lib.js';
export { DUR };

const tw = t => Math.floor(t * 12 + 1e-6) / 12;     // 人偶一拍二（12 fps）
const mixP = (a, b, u) => { const o = { ...a }; for (const k in b) { if (typeof b[k] === 'number' && typeof a[k] === 'number') o[k] = a[k] + (b[k] - a[k]) * u; else if (u > .5 || !(k in a)) o[k] = b[k]; } return o; };
const PI = Math.PI, TAU = PI * 2, TAN30 = Math.tan(PI / 6);

// ── 摄影机：唯一的 world→screen ──
let CAM = { x: 960, y: 540, z: 1, r: 0 };
function cam(x, y, z, r = 0) { CAM = { x, y, z, r }; const c = Math.cos(r) * z, s = Math.sin(r) * z; g.setTransform(c, s, -s, c, 960 - (x * c - y * s), 540 - (x * s + y * c)); }
const toS = (x, y) => { const c = Math.cos(CAM.r) * CAM.z, s = Math.sin(CAM.r) * CAM.z, dx = x - CAM.x, dy = y - CAM.y; return [960 + dx * c - dy * s, 540 + dx * s + dy * c]; };
function ground(col) { clear(col); }

// ── 文字：排一行剪纸字，并登记它的屏幕框（给 readcheck）──
let TXT = [];
function credit(id, str, x, base, size, col, opt = {}) {
  const L = layout(str, size, { track: opt.track ?? .04 });
  drawLine(L, x, base, { col, seed: opt.seed ?? 10, jit: .8, amp: 1.5 + size * .002, shA: .36, each: opt.each });
  if (opt.report !== false) {
    const a = L.letters[0], z = L.letters[L.letters.length - 1];
    const top = Math.min(...L.letters.map(l => l.top));
    const p0 = toS(x + a.x + a.x0, base + top), p1 = toS(x + z.x + z.x1, base + size * .12);
    TXT.push({ id, text: str.replace(/\s/g, ''), x0: Math.min(p0[0], p1[0]), y0: Math.min(p0[1], p1[1]), x1: Math.max(p0[0], p1[0]), y1: Math.max(p0[1], p1[1]) });
  }
  return L;
}

// ── 斜格：30° 一族 + 60° 一族的暗色纸条，从画外切入（生长在 ones 上）──
function gridBands(t0, t, col, opt = {}) {
  const u = t - t0; if (u < 0) return;
  const sp = opt.sp ?? 300, w = opt.w ?? 46;
  for (let k = -3; k < 9; k++) {           // 30° 族：y = x·tan30 + c
    const grow = eo(seg(u, k * .045 + .02, k * .045 + .42)); if (grow <= 0) continue;
    const c = -600 + k * sp, x0 = -300, x1 = x0 + (2600) * grow;
    const P = [[x0, x0 * TAN30 + c], [x1, x1 * TAN30 + c], [x1, x1 * TAN30 + c + w], [x0, x0 * TAN30 + c + w]];
    piece(roughC('gb' + k + (opt.key || '') + Math.round(grow * 40), () => P, 900 + k, 1.6, 12), col, { gap: 0, shadow: false });
  }
  if (opt.cross) for (let k = 0; k < 6; k++) {  // 60° 族（第二拍后才长出来）
    const grow = eo(seg(u, .5 + k * .06, .9 + k * .06)); if (grow <= 0) continue;
    const x = -200 + k * 430, y0 = -200, y1 = y0 + 1700 * grow, dx = 1 / Math.tan(PI / 3);
    const P = [[x + y0 * -dx, y0], [x + y1 * -dx, y1], [x + y1 * -dx + 30, y1], [x + y0 * -dx + 30, y0]];
    piece(roughC('gc' + k + Math.round(grow * 40), () => P, 950 + k, 1.4, 12), col, { gap: 0, shadow: false });
  }
}

// ── 姿势 ──
const P_ = {
  tuck: { lean: .7, bob: 70, head: -.45, thF: 2.0, knF: 2.55, ftF: .3, thB: 1.75, knB: 2.45, ftB: .3, shF: 1.3, elF: 1.4, shB: 1.1, elB: 1.5, tie: .8, tph: 0 },
  crouch: { lean: .38, bob: 92, head: -.1, thF: 1.05, knF: 1.9, ftF: .1, thB: .55, knB: 1.75, ftB: .4, shF: 1.0, elF: .5, shB: -.6, elB: .6, tie: .35, tph: 1 },
  stand: AGENT_POSE.stand,
  look: { ...AGENT_POSE.stand, head: -.06, eye: 'open', tie: .05 },
  peek: { lean: -.32, bob: 4, head: -.18, thF: .12, knF: .05, ftF: 0, thB: -.15, knB: .1, ftB: 0, shF: .25, elF: .4, shB: -.2, elB: .3, tie: -.35, tph: 2, eye: 'open' },
  leap: AGENT_POSE.leap,
  dial: { lean: -.04, bob: 0, head: .06, thF: .2, knF: .1, ftF: 0, thB: -.18, knB: .2, ftB: 0, shF: 1.95, elF: .05, shB: -.15, elB: .4, tie: .05, tph: .5, eye: 'open' },
  peekUp: { lean: .1, bob: -185, head: -.14, thF: 1.25, knF: 2.1, ftF: .3, thB: 1.0, knB: 2.0, ftB: .3, shF: .75, elF: 1.1, shB: 1.1, elB: 1.0, tie: -.15, tph: 2, eye: 'open' },
  hop: { lean: -.25, bob: -40, head: -.3, thF: .9, knF: 1.4, ftF: .2, thB: .3, knB: 1.6, ftB: .3, shF: 2.4, elF: .5, shB: 2.0, elB: .6, tie: -.6, tph: 3, eye: 'open' },
};
const RV = {
  lunge: { lean: .55, bob: 30, head: -.25, thF: 1.25, knF: .6, ftF: 0, thB: -.7, knB: .3, ftB: .4, shF: 1.75, elF: .05, shB: 1.45, elB: .1, flare: 1, ph: 2, key: 0 },
  fall: { lean: 1.35, bob: 140, head: -.3, thF: .6, knF: .3, ftF: 0, thB: -.4, knB: .2, ftB: .3, shF: 2.3, elF: .1, shB: 2.1, elB: .2, flare: .8, ph: 3, key: 0 },
  skid: { lean: -.45, bob: 30, head: .25, thF: 1.0, knF: .05, ftF: -.4, thB: .15, knB: 1.4, ftB: .2, shF: -1.2, elF: .4, shB: -1.6, elB: .5, flare: .6, ph: 1, key: 0 },
  up: { lean: -.1, bob: 0, head: -.5, thF: .1, knF: .05, ftF: 0, thB: -.1, knB: .05, ftB: 0, shF: -.3, elF: .3, shB: -.2, elB: .3, flare: .1, ph: 0, key: 0 },
  stand: COURIER_POSE.stand,
};
// 绕身体中心旋转画特工（翻滚）
function agentRot(x, y, s, pose, rot, opt = {}) {
  g.save(); g.translate(x, y); g.rotate(rot); agentSide(0, 230 * s, s, pose, opt); g.restore();
}

// ═══════════ A 坠入：0–7 拍 ═══════════
const A_LINE = { x: 110, base: 330, dx: 285, dy: 164, size: 255 };
let A_L = null;
const charTop = k => { A_L ??= layout('零点情报局', A_LINE.size, {}); const l = A_L.letters[k]; return [A_LINE.x + k * A_LINE.dx + (l.x0 + l.x1) / 2, A_LINE.base + k * A_LINE.dy + l.top + 4]; };
function sFall(t) {
  const u = t - T.open;
  ground(C.paper);
  const cz = lerp(.96, 1.03, ss(seg(t, B(1), B(7)))), cx = lerp(880, 1020, eio(seg(t, B(.5), B(7)))), cy = lerp(500, 575, eio(seg(t, B(.5), B(7))));
  cam(cx, cy, cz);
  gridBands(-.1, t, C.paperD, { cross: true, key: 'A' });
  // 字卡沿 30° 线滑入，第 1 拍定死
  const p = eo(seg(t, -.12, B(1)));
  const off = (1 - p) * -1700;
  g.save(); g.translate(off, off * TAN30);
  // 每个字自己的基线：一级一级的台阶
  const L = layout('零点情报局', A_LINE.size, {});
  drawLine(L, 0, 0, { col: C.ink, seed: 21, jit: .8, amp: 1.9, shA: .36, each: (l, i) => ({ dx: A_LINE.x + i * A_LINE.dx - l.x, dy: A_LINE.base + i * A_LINE.dy }) });
  g.restore();
  // 文字框（整行台阶的外接框）
  { const p0 = toS(A_LINE.x + off, A_LINE.base - A_LINE.size * .9 + off * TAN30), p1 = toS(A_LINE.x + 4 * A_LINE.dx + A_LINE.size + off, A_LINE.base + 4 * A_LINE.dy + 25 + off * TAN30); TXT.push({ id: 'a_main', text: '零点情报局', x0: p0[0], y0: p0[1], x1: p1[0], y1: p1[1] }); }
  // 「出品」在第 2 拍弹起
  if (t >= T.land1 - .001) {
    const k = back(seg(t, T.land1, T.land1 + .2), 2.2);
    g.save(); g.translate(1640, 1000); g.scale(1, Math.max(.05, k)); g.translate(-1640, -1000);
    credit('a_role', '出品', 1560, 1000, 110, C.ink, { seed: 33 });
    g.restore();
  }
  // 特工：从左上翻滚落下，第 2/4/6 拍落在字顶
  const tp = tw(t), s = .7;
  const L1 = charTop(1), L3 = charTop(3), L5 = [1480, 1040];
  const keys = [[-.35, [-60, -260]], [T.land1, L1], [T.land2, L3], [T.land3, L5]];
  let pos, rot = 0, pose = P_.tuck;
  if (tp < T.land1) { const v = seg(tp, -.35, T.land1); pos = [lerp(-60, L1[0], v), lerp(-260, L1[1], v * v)]; rot = v * TAU * 1.25 - TAU * .25; }
  else {
    let i = tp < T.land2 ? 1 : tp < T.land3 ? 2 : 3;
    const [ta, A] = keys[i], [tb, Bq] = i < 3 ? keys[i + 1] : [ta + 9, A];
    const since = tp - ta;
    if (i < 3 && since > .14) {   // 落地后蹲 0.14 s 再翻向下一级
      const v = seg(tp, ta + .14, tb);
      pos = [lerp(A[0], Bq[0], v), lerp(A[1], Bq[1], v) - Math.sin(v * PI) * 150];
      rot = v * TAU;
    } else pos = A;
    if (i < 3 && since > .14) pose = P_.tuck;
    else { const q = seg(since, 0, .14); pose = i === 3 ? mixP(P_.crouch, P_.look, ss(seg(since, .1, .3))) : mixP(P_.crouch, P_.tuck, q); rot = 0; }
  }
  if (rot === 0) agentSide(pos[0], pos[1], s, pose); else agentRot(pos[0], pos[1] - 120 * s, s, pose, rot);
}

// ═══════════ B 窥镜 / 第〇号档案：7–16 拍 ═══════════
const RING = { x: 660, y: 540, r: 270, w: 66 };   // 窥镜圆 = 〇 = 转盘：圆心、半径全片不变
function sLens(t) {
  ground(C.ink); cam(960, 540, 1);
  const tp = tw(t);
  // 放大镜手柄
  piece(roughC('handle', () => [[RING.x + 170, RING.y + 200], [RING.x + 220, RING.y + 160], [1290, 1110], [1210, 1150]], 61, 2, 12), C.paperD);
  piece(roughC('lens', () => circP(RING.x, RING.y, RING.r, 120), 62, 2.2, 10), C.paper);
  g.save(); g.beginPath(); g.arc(RING.x, RING.y, RING.r - 4, 0, TAU); g.clip();
  const turn = tp >= B(HIT.lens + 1);
  const pose = turn ? { ...P_.look, head: -.02 } : { ...P_.stand, head: -.25, eye: 'open' };
  agentSide(turn ? 690 : 700, 1420, 1.62, pose, { flip: !turn });
  g.restore();
}
function fileScene(t, opt = {}) {
  // 芥黄底，〇 奶油色（和窥镜同圆），「第」「号档案」黑字
  ground(C.mus);
  const tp = tw(t);
  const zSlow = lerp(1, 1.04, ss(seg(t, T.role, T.push)));
  // 推进〇：缓入缓出，最后几帧放大率连续收敛到 1:1（第 175 帧内圈已盖过画面对角线，硬切点无尺寸跳变）
  const zPush = Math.pow(7.2, eio(seg(t, T.push, T.chase)));
  // 第 12 拍探头：轻推 1.1 倍；第 13 拍拉回，对手从画左走进来（拉出揭示）
  const kPk = eo(seg(t, T.peek, T.peek + .2)) * (1 - eio(seg(t, T.rival, T.rival + .22)));
  const PKF = [948, 420];   // 推镜中心：兼顾「第」「原著」都留在画内（readcheck）
  const z = zSlow * zPush * (1 + .1 * kPk);
  const cx = lerp(960, RING.x, eio(seg(t, T.push - .1, T.chase))) + (PKF[0] - 960) * .75 * kPk;
  const cy = RING.y + (PKF[1] - RING.y) * .75 * kPk;
  cam(cx, cy, z);
  // 地板（基线）
  piece(roughC('flB', () => rectP(-200, 668, 2400, 12), 70, 1, 12), C.musD, { gap: 0, shadow: false });
  // 〇 环
  piece([roughC('ringO', () => circP(RING.x, RING.y, RING.r, 120), 63, 2.2, 10), roughC('ringI', () => circP(RING.x, RING.y, RING.r - RING.w, 100), 64, 1.8, 10)], C.paper, { shA: .34 });
  // 环内：下一场的窗口（推进时出现）
  if (t >= T.push - .2 && opt.window) {
    g.save(); g.beginPath(); g.arc(RING.x, RING.y, RING.r - RING.w - 2, 0, TAU); g.clip();
    const m = g.getTransform(); opt.window(t); g.setTransform(m);
    g.restore();
    cam(cx, cy, z);
  }
  // 字卡：第 10 拍定死
  const p = eo(seg(t, T.match + .05, T.role));
  if (t >= T.match + .05) {
    credit('b_di', '第', 105 - (1 - p) * 700, 650, 300, C.ink, { seed: 41 });
    credit('b_main', '号档案', 950 + (1 - p) * 900, 650, 300, C.ink, { seed: 47 });
  }
  if (t >= T.role) {
    const k = back(seg(t, T.role, T.role + .2), 2);
    g.save(); g.translate(1430, 300); g.scale(Math.max(.05, k), 1); g.translate(-1430, -300);
    credit('b_role', '原著', 1340, 300, 96, C.paper, { seed: 52 });
    g.restore();
  }
  // 对手：从「第」后面走出（第 13 拍）
  if (tp >= T.rival - .25) {
    const v = seg(tp, T.rival - .25, T.rival + .3);
    const pose = v < 1 ? walkPose(v * .5) : mixP(RV.stand, RV.lunge, ss(seg(tp, T.dive, T.dive + .25)) * .6);
    courierSide(lerp(160, 330, eo(v)), 668, .5, { ...pose, headFlip: false }, { noKey: true });
  }
  // 特工：躲在「号」后，第 12 拍探头，第 14 拍纵身跳进〇
  if (tp < T.dive) {
    // 第 12 拍从「号」顶上冒出半个上身（帽、脸、红领带、扒着字顶的手），腿收在字后
    const pk = back(seg(tp, T.peek, T.peek + .2), 1.6);
    const pose = mixP({ ...P_.stand, head: -.1 }, P_.peekUp, pk);
    agentSide(lerp(1110, 1035, clamp(pk)), 668, .55, pose, { flip: true });
    // 「号」字重画在特工前面（他藏在字后）；字后先垫一块同底色的纸，腿不会从字的空隙里露出来
    if (t >= T.match + .05) piece(rectP(940, 442, 250, 220), C.mus, { gap: 0, shadow: false });
    if (t >= T.match + .05) credit('b_main_occ', '号档案', 950 + (1 - p) * 900, 650, 300, C.ink, { seed: 47, report: false, each: (l, i) => i > 0 ? { hide: true } : null });
  } else if (tp < T.push) {
    const v = seg(tp, T.dive, T.push);
    const x = lerp(1035, RING.x + 20, ss(v)), y = lerp(582, RING.y + 140, ss(v)) - Math.sin(v * PI) * 160;
    const sc = lerp(.55, .22, v);
    agentSide(x, y, sc, mixP(P_.leap, P_.tuck, ss(seg(v, .5, 1))), { flip: true });
  }
}

// ═══════════ C 追逐：16–26 拍（含定格）═══════════
const V_RUN = 760;
const SILC = { outline: 4.5 };          // 追逐段剪影外缘剪缝加宽（黑剪影压在黑字柱上也分得开）                      // 地面滚动速度 px/s
const te = t => t < T.freeze ? t : t < T.resume ? T.freeze : t - (T.resume - T.freeze);   // 定格：世界时间停住
// 地板位移：b16→b22.5 匀速，b22.5→b23 刹停
function floorX(x) {
  const a = T.chase, b = B(22.5), c = T.sw3;
  if (x <= b) return V_RUN * (x - a);
  const d = c - b, v = clamp((x - b) / d);
  return V_RUN * (b - a) + V_RUN * d * (v - v * v / 2);
}
const FSTOP = floorX(T.sw3);
const GAP = [1290, 1560];               // 地板缺口（刹停后的屏幕位置）
function chaseGround(t) {
  const x = te(t);
  if (x >= T.freeze) return C.red;
  if (x >= T.sw3) return C.paper;
  if (x >= T.sw2) return C.red;
  if (x >= T.sw1) return C.mus;
  return C.paper;
}
const DARK = { [C.paper]: C.paperD, [C.mus]: C.musD, [C.red]: C.redD };
function prevGround(x) { return x >= T.freeze ? C.paper : x >= T.sw3 ? C.red : x >= T.sw2 ? C.mus : x >= T.sw1 ? C.paper : null; }
function lastSwitch(x) { return x >= T.freeze ? T.freeze : x >= T.sw3 ? T.sw3 : x >= T.sw2 ? T.sw2 : x >= T.sw1 ? T.sw1 : -9; }
function chaseCam(t) {
  const x = te(t);
  if (t >= T.freeze && t < T.resume) return [1492, 330, 3.5];   // 定格：铜管一刀硬切成大特写（世界冻结，只剩眨眼）
  if (x < T.sw3) return [960, 540, 1];
  return [1250, 560, 1.42];
}
function sChase(t, asWindow = false) {
  const x = te(t), tp = tw(x);
  const col = asWindow ? C.paper : chaseGround(t);
  ground(col);
  const [cx, cy, cz] = asWindow ? [960, 540, 1] : chaseCam(t);
  if (!asWindow) cam(cx, cy, cz);
  const dk = DARK[col];
  const fx = asWindow ? 0 : floorX(Math.max(T.chase, x));
  // 远景斜条（中速，暗色地纸）
  const mid = (fx * .38) % 520;
  for (let k = -1; k < 6; k++) {
    const x0 = k * 520 - mid;
    piece(roughC('cb' + k, () => [[0, -100], [150, -100], [150 + 1300 * TAN30 * 1.7, 1200], [1300 * TAN30 * 1.7, 1200]], 300 + k, 1.6, 12).map(([a, b]) => [a + x0 - 400, b]), dk, { gap: 0, shadow: false });
  }
  // 上一种底色留下的斜色块，沿斜线滑走（换底的「颜色块」）
  const ls = lastSwitch(x), pg = prevGround(x);
  if (!asWindow && pg && x - ls < .32) {
    const v = eo(seg(x, ls, ls + .32)), o = v * 1500;
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    piece([[-200 - o, 1080 + o * TAN30], [900 - o, 1080 + o * TAN30 - 1080 * 1.0], [1500 - o, -100 + o * TAN30], [-200 - o, -100 + o * TAN30]].map(([a, b]) => [a, b]), pg, { gap: 0, shA: .4 });
    g.restore(); cam(cx, cy, cz);
  }
  // 字卡：「编剧」+ 三根字柱「破译组」（慢速视差）
  const px = asWindow ? 0 : Math.min(fx, FSTOP) * .07;
  credit('c_role', '编剧', 130 - px * .5, 190, 92, col === C.red ? C.paper : C.ink, { seed: 61, report: !asWindow });
  credit('c_main', '破译组', 300 - px, 880, 430, C.ink, { seed: 67, track: .14, report: !asWindow });
  // 地板：黑色纸条，带一个缺口（第 23 拍刹停时停在 GAP）
  const fy = 880;
  const gx0 = GAP[0] + FSTOP - fx, gx1 = GAP[1] + FSTOP - fx;
  const floorPiece = (a, b, key) => { if (b > a) piece(rough(rectP(a, fy, b - a, 22), 80 + key, 1.2, 12), C.ink, { gap: 0, shA: .3 }); };
  floorPiece(-400, gx0, 1); floorPiece(gx1, 2400, 2);
  // 地板下：快速掠过的短木条（前景，最快）
  for (let k = 0; k < 14; k++) { const xx = ((k * 190 - fx * 1.0) % 2660 + 2660) % 2660 - 370; if (xx > gx0 - 40 && xx < gx1) continue; piece(roughC('sl' + k % 4, () => [[0, 0], [70, 0], [34, 70], [-36, 70]], 400 + k % 4, 1.2, 10).map(([a, b]) => [a + xx, b + fy + 40]), dk, { gap: 0, shadow: false }); }
  // 人物
  const s = .62;
  if (x < T.sw3) {
    const rp = runPose(((tp - T.chase) / (BEAT * 2)) % 1);
    const back_ = tp >= B(19) && tp < B(19.9) ? mixP(rp, AGENT_POSE.overShoulder, .7) : rp;
    agentSide(1240 + Math.sin(tp * 3) * 12, fy, s, back_, { sil: SILC });
    const rx = lerp(500, 960, ss(seg(tp, T.sw2, T.sw3)));
    courierSide(rx, fy, s * .95, coRunPose(((tp - T.chase) / (BEAT * 2) + .5) % 1), { noKey: true, sil: SILC });
  } else {
    // 起跳（第 23 拍）→ 顶点（第 24 拍，定格）→ 落到缺口对岸（世界时间第 25 拍 = 实际第 27 拍，硬切）
    const v = (x - T.sw3) / (2 * BEAT);    // 0..1 over b23..b25(world)
    const ax = lerp(1180, 1700, v), ay = fy - Math.sin(v * PI) * 250;
    const pose = v < .08 ? mixP(P_.crouch, P_.leap, v / .08) : { ...P_.leap, eye: 'open', blink: blinkAmt(t), head: -.35 };
    agentSide(ax, ay, s, pose, { sil: SILC });
    // 对手：扑过来，定格时双手前伸；恢复后栽进缺口
    const w = (x - T.sw3) / BEAT;
    if (w < 1) courierSide(lerp(960, 1140, ss(w)), fy - Math.sin(w * PI * .5) * 60, s * .95, mixP(coRunPose(.2), RV.lunge, ss(w)), { noKey: true, sil: SILC });
    else { const f = clamp(w - 1); courierSide(1140 + f * 220, fy - 60 + f * f * 520, s * .95, mixP(RV.lunge, RV.fall, ss(f)), { noKey: true, sil: SILC }); }
  }
}
function blinkAmt(t) { const d = t - T.blink; return d < 0 || d > .17 ? 0 : Math.sin(clamp(d / .17) * PI); }

// ═══════════ D 保险箱：27–33 拍 ═══════════
const DOOR = { x0: 250, y0: 80, x1: 1620, y1: 1000 };
// 转盘角度：快转刹停（b28）→ 反转（b29）→ 慢转到 0（b31）
function dialAng(t) {
  const a1 = TAU * 2.15, a2 = TAU * 1.55, a3 = TAU * 2.0;
  if (t < T.safe) return 0;
  if (t < T.click1) return a1 * eo(seg(t, T.safe, T.click1));
  if (t < T.click2) return a1 + (a2 - a1) * eo(seg(t, T.click1, T.click2));
  if (t < T.click3) return a2 + (a3 - a2) * eio(seg(t, T.click2, T.click3));
  return a3;
}
export const NOTCH = TAU / 40;
function drawSafe(t, open = 0) {
  // 门：黑纸 + 暗色铆钉条；open 0..1 门绕左铰链转开（宽度压扁）
  const w = (DOOR.x1 - DOOR.x0) * Math.cos(open * PI / 2);
  // 门洞里（片名背景）
  piece(roughC('vault', () => rectP(DOOR.x0 + 30, DOOR.y0 + 30, DOOR.x1 - DOOR.x0 - 60, DOOR.y1 - DOOR.y0 - 60), 90, 2, 14), C.inkL, { gap: 0 });
  if (open >= 1) return;
  g.save(); g.translate(DOOR.x0, 0); g.scale(Math.max(.002, w / (DOOR.x1 - DOOR.x0)), 1); g.translate(-DOOR.x0, 0);
  piece(roughC('door', () => rectP(DOOR.x0, DOOR.y0, DOOR.x1 - DOOR.x0, DOOR.y1 - DOOR.y0), 91, 2.2, 14), C.ink, { shA: .4 });
  for (const [y] of [[170], [910]]) for (let k = 0; k < 9; k++) piece(roughC('rv' + y + k, () => circP(DOOR.x0 + 120 + k * 150, y, 13, 14), 92 + k, .6, 6), C.inkL, { gap: 0, shadow: false });
  // 把手（奶油色拉杆）
  piece(roughC('hdl', () => [[1300, 520], [1480, 520], [1480, 560], [1300, 560]], 93, 1.2, 10), C.paper);
  piece(roughC('hdl2', () => circP(1300, 540, 34, 24), 94, 1, 8), C.paper);
  // 刻度指针（芥黄三角，转盘正上方）
  piece(roughC('idx', () => [[RING.x - 18, RING.y - RING.r - 40], [RING.x + 18, RING.y - RING.r - 40], [RING.x, RING.y - RING.r - 8]], 95, .6, 6), C.mus, { gap: 0 });
  // 转盘
  const a = dialAng(t);
  piece(roughC('dial', () => circP(RING.x, RING.y, RING.r, 120), 96, 2.2, 10), C.paper, { shA: .4 });
  g.save(); g.translate(RING.x, RING.y); g.rotate(a);
  for (let k = 0; k < 40; k++) {
    const big = k % 5 === 0, an = k * NOTCH;
    g.save(); g.rotate(an);
    piece(roughC('tk' + big, () => rectP(-(big ? 7 : 4), -RING.r + 16, big ? 14 : 8, big ? 62 : 36), 97 + big, .6, 6), k === 0 ? C.red : C.ink, { gap: 0, shadow: false });
    g.restore();
  }
  // 中心旋钮（芥黄，黑底衬 = 追逐对象）
  piece(roughC('knobB', () => circP(0, 0, 112, 40), 98, 1, 8), C.ink, { gap: 0, shadow: false });
  piece(roughC('knob', () => { const o = []; for (let i = 0; i < 48; i++) { const r = i % 4 < 2 ? 98 : 88; const an = i / 48 * TAU; o.push([Math.cos(an) * r, Math.sin(an) * r]); } return o; }, 99, .8, 6), C.mus, { gap: 0 });
  piece(roughC('knobC', () => circP(0, 0, 30, 20), 100, .6, 6), C.ink, { gap: 0, shadow: false });
  g.restore();
  g.restore();
}
function sSafe(t) {
  ground(C.paper);
  const z = lerp(1, 1.16, ss(seg(t, T.safe, T.click3))), cx = lerp(900, 760, ss(seg(t, T.safe, T.click3)));
  cam(cx, 540, z);
  piece(roughC('flD', () => rectP(-300, 1000, 2600, 200), 101, 1.5, 12), C.paperD, { gap: 0, shadow: false });
  drawSafe(t);
  // 特工：第 27 拍从左上落地（承接追逐的跳跃），然后伸手拧转盘
  const tp = tw(t);
  const land = seg(tp, T.safe, T.safe + .25);
  let pose;
  if (tp < T.safe + .25) pose = mixP(P_.crouch, P_.stand, ss(land));
  else pose = mixP(P_.stand, P_.dial, ss(seg(tp, T.safe + .25, T.click1 - .05)));
  // 手腕随转盘轻轻扭
  pose = { ...pose, elF: (pose.elF || 0) + Math.sin(dialAng(t) * 1.3) * .05 };
  agentSide(930, 1052, 1.0, pose, { flip: true });
}

// ═══════════ E 片名：33 拍 → 结束 ═══════════
const TITLE = { x: 330, y: 300, H: 290 };
const RIV_STOP = 640;   // 对手急停点：「零」与「点」之间的下方，头不压字
function sTitle(t) {
  ground(C.paper);
  const tf = Math.min(t, T.hatLand);         // 收尾定格：帽子落在「点」的〇上那一拍，世界停住
  const z = lerp(1.16, .98, eo(seg(t, T.door, B(40)))), cx = lerp(760, 960, eo(seg(t, T.door, B(40)))), cy = lerp(540, 560, eo(seg(t, T.door, B(40))));
  cam(cx, cy, z);
  piece(roughC('flD', () => rectP(-300, 1000, 2600, 200), 101, 1.5, 12), C.paperD, { gap: 0, shadow: false });
  const open = eio(seg(t, T.door, T.door + .2));
  drawSafe(T.click3, open);
  // 门背面（转过 90° 后露出的暗面，往左摊开）
  if (open >= 1) { const v = eo(seg(t, T.door + .2, T.door + .45)); piece(roughC('doorB', () => rectP(DOOR.x0 - 190, DOOR.y0 + 10, 190, DOOR.y1 - DOOR.y0 - 20), 102, 1.6, 12).map(([a, b]) => [DOOR.x0 - (DOOR.x0 - a) * v, b]), C.inkL, { shA: .4 }); }
  // 片名碎片沿 30° 斜格飞进来，第 34 拍定死
  if (t >= T.door) {
    const L = titleLayout(TITLE.H);
    TXT.push((() => { const p0 = toS(TITLE.x - 10, TITLE.y - 40), p1 = toS(TITLE.x + L.w + 10, TITLE.y + TITLE.H * 1.15); return { id: 'title', text: '零点密码', x0: p0[0], y0: p0[1], x1: p1[0], y1: p1[1] }; })());
    drawTitle(TITLE.x, TITLE.y, TITLE.H, {
      col: C.mus, ringCol: C.paper, backing: 5,
      fly: (l, j, n) => {
        const h = strokeSeed(l, j), d0 = T.door + .08 + h * .14;
        const v = eo(seg(t, d0, T.title));
        if (t < d0) return { hide: true };
        const dist = (1 - v) * (900 + h * 900), dir = h > .5 ? 1 : -1;
        return { dx: -dist * Math.cos(PI / 6) * dir, dy: dist * Math.sin(PI / 6) * dir, rot: (1 - v) * (h - .5) * 4 };
      },
    });
  }
  // 特工：门开时被吓得往后一跳（第 33→34 拍），然后走出画右
  const tp = tw(tf);
  let ax, ay = 1052, pose;
  if (tp < T.title) { const v = seg(tp, T.door, T.title); ax = lerp(930, 1500, eo(v)); ay = 1052 - Math.sin(v * PI) * 120; pose = P_.hop; }
  else if (tp < B(37)) { ax = 1500; pose = mixP(P_.crouch, { ...P_.look, head: -.4 }, ss(seg(tp, T.title, T.title + .3))); }   // 回头看片名
  else { const v = (tp - B(37)) / (BEAT * 2); ax = 1500 + (tp - B(37)) * 150; pose = walkPoseA(v); }
  agentSide(ax, ay, .82, pose, { flip: tp >= B(37) ? false : true });
  // 对手：第 38 拍跑进，第 40 拍急停，第 41 拍帽子弹起 → 定格
  if (tp >= T.rivalIn - .3) {
    let rx, rp;
    if (tp < T.skid) { rx = lerp(-200, RIV_STOP - 70, seg(tp, T.rivalIn - .3, T.skid)); rp = coRunPose(((tp - T.rivalIn) / (BEAT * 2)) % 1); }
    else { rx = RIV_STOP - 70 + eo(seg(tp, T.skid, T.skid + .3)) * 70; rp = mixP(RV.skid, RV.up, ss(seg(tp, T.skid + .2, T.button))); }
    const popped = tp >= T.button;
    courierSide(rx, 1052, .78, rp, { noKey: true, noHat: popped });
    if (popped) {   // 帽子弹起，划一道弧，第 42 拍正好扣在「点」的〇顶上
      const v = clamp((tf - T.button) / (T.hatLand - T.button)), s = .78, lean = rp.lean;
      const hip = [rx, 1052 + (-300 + rp.bob) * s];
      const nk = [hip[0] + (8 * Math.cos(lean) + 236 * Math.sin(lean)) * s, hip[1] + (8 * Math.sin(lean) - 236 * Math.cos(lean)) * s];
      const tgt = ringTop();
      const x = lerp(nk[0], tgt[0], v), y = lerp(nk[1], tgt[1], v) - Math.sin(v * PI) * 230;
      bowler(x, y, s, lerp(rp.head + lean * .5, 0, v) + Math.sin(v * PI) * -2.2);
    }
  }
}
// 「点」的〇顶（世界坐标），帽子的落点
function ringTop() {
  const L = titleLayout(TITLE.H).L[1], k = L.h / 100;
  return [TITLE.x + L.x + 48 * k, TITLE.y + L.y + (52 - 18 - 4.5) * k + 72 * .78 + 4];
}
function walkPoseA(v) { const f = v * TAU; const leg = q => { const s = Math.sin(q); return [.02 + .4 * s, .1 + .7 * Math.pow(Math.max(0, Math.sin(q + 1.7)), 2), -.05 + .3 * Math.max(0, Math.sin(q + 2.4))]; }; const [thF, knF, ftF] = leg(f), [thB, knB, ftB] = leg(f + PI); return { lean: .05, bob: -6 * Math.abs(Math.cos(f)) + 3, head: 0, thF, knF, ftF, thB, knB, ftB, shF: .05 - .4 * Math.sin(f), elF: .3, shB: .05 + .4 * Math.sin(f), elB: .3, tie: .1, tph: f }; }

// ═══════════ 总调度 ═══════════
export function renderFilm(t) {
  TXT = [];
  S.gap = 2.4;
  if (t < T.lens) sFall(t);
  else if (t < T.match) sLens(t);
  else if (t < T.chase) fileScene(t, { window: sChaseWindow });
  else if (t < T.safe) sChase(t);
  else if (t < T.door) sSafe(t);
  else sTitle(t);
  return TXT;
}
// 〇 内圈里看到的下一场：追逐场的整帧画面，按〇内圈在屏幕上的大小缩放贴进圆里；第 16 拍正好 1:1 铺满
function sChaseWindow(t) {
  const [hx, hy] = toS(RING.x, RING.y), rS = (RING.r - RING.w) * CAM.z;
  const sc = Math.min(1, rS / ((RING.r - RING.w) * 7.2 * 1.04));   // 第 16 拍正好 = 1
  g.setTransform(sc, 0, 0, sc, hx - 960 * sc, hy - 540 * sc);
  const save = S.bg; sChase(t, true); S.bg = save;
}

export function texts(t) { return renderFilm(t); }

// ── 声音事件 ──
export function events() {
  const E = [];
  const add = (t, type, o = {}) => E.push({ t: +t.toFixed(6), type, ...o });
  for (const [k, b] of Object.entries(HIT)) add(B(b), 'hit', { name: k, beat: b });
  // A：斜条切入（随生长）
  for (let k = -3; k < 9; k++) if (k % 2 === 0) add(T.open + k * .045 + .03, 'paperCut', { pan: -.6 + k * .12 });
  for (let k = 0; k < 6; k++) if (k % 2 === 0) add(T.open + .52 + k * .06, 'paperCut', { pan: -.4 + k * .15, g: .6 });
  add(T.open + .02, 'cardSlide', { pan: -.5 }); add(B(1), 'cardSlap', { g: 1.1 });
  add(-.3 + .01, 'tumble', {}); [T.land1, T.land2].forEach(x => add(x + .14, 'tumble', {}));
  [T.land1, T.land2, T.land3].forEach((x, i) => add(x, 'land', { pan: -.5 + i * .4 }));
  add(T.land1, 'cardPop', { pan: .6 });
  add(B(8), 'swish', { pan: 0 });
  add(T.match, 'paperSlap', { g: 1.2 }); add(T.match + .05, 'cardSlide', { pan: -.6 }); add(T.match + .05, 'cardSlide', { pan: .6 });
  add(T.role, 'cardSlap', { pan: -.6 }); add(T.role, 'cardSlap', { pan: .6 }); add(T.role, 'cardPop', { pan: .2 });
  add(T.peek, 'cloth', { pan: .3 }); add(T.rival - .25, 'step', { pan: -.7 }); add(T.rival, 'step', { pan: -.6 });
  add(T.dive, 'whoosh', { d: .45, pan: .1 }); add(T.push, 'whoosh', { d: .5, g: 1.2 });
  // C：每拍两人各一步
  for (let b = 16; b < 23; b++) { add(B(b), 'step', { pan: .35, g: .9 }); add(B(b) + BEAT * .5, 'step', { pan: -.45, g: .7 }); }
  [T.sw1, T.sw2, T.sw3].forEach(x => add(x, 'paperSlide', { g: 1 }));
  add(B(22.5), 'skidS', { pan: .3 }); add(T.sw3, 'whoosh', { d: .4, pan: .3 });
  add(T.blink, 'tapeClick', {});
  add(T.resume, 'whoosh', { d: .45, pan: .5 }); add(T.resume + BEAT * .6, 'fallThump', { pan: .2 });
  // D：落地 + 转盘棘轮（由角度越过刻度驱动）+ 停格
  add(T.safe, 'landHeavy', {});
  let prev = 0; const N = Math.round((T.door - T.safe) * 240);
  for (let i = 1; i <= N; i++) { const tt = T.safe + i / 240, a = dialAng(tt), k0 = Math.floor(prev / NOTCH), k1 = Math.floor(a / NOTCH); if (k1 !== k0 && !([T.click1, T.click2, T.click3].some(c => Math.abs(c - tt) < .02))) add(tt, 'tick', { g: .5 + .3 * hash(i) }); prev = a; }
  // 反转时角度递减
  [T.click1, T.click2].forEach(x => add(x, 'dialStop', {})); add(T.click3, 'dialFinal', {});
  // E
  add(T.door, 'doorOpen', {}); add(T.door + .02, 'stripSlide', {});
  add(T.title, 'titleSlap', {});
  for (let k = 0; k < 4; k++) add(T.title + .002, 'cardSlap', { pan: -.6 + k * .4, g: .8 });
  for (let b = 37; b < 41; b++) add(B(b), 'step', { pan: .7, g: .5 });
  for (let b = 38; b < 40; b++) { add(B(b), 'step', { pan: -.4, g: .8 }); add(B(b) + BEAT * .5, 'step', { pan: -.3, g: .8 }); }
  add(T.skid, 'skid', { pan: -.2 }); add(T.button, 'hatPop', { pan: -.2 }); add(T.hatLand, 'hatLand', { pan: -.1 });
  return E.sort((a, b) => a.t - b.t);
}
