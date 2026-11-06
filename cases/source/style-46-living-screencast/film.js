// 画面时间线：相机、卡片（吉祥物）、光标、界面状态、声音事件。全部挂在 timeline.js 的拍号上。
import { clamp, lerp, seg, ss, eio, eo, ei, back, hash, monotone } from '/core/lib.js';
import { B, bt, DUR, HIT as H, act, FPS, BPM, FPB } from './timeline.js';
import { LAY } from './ui.js';
export { DUR };
const b = bt;
export const CARD = LAY.card;            // 480×80
export const PXL = 7;
export const ZZZ = [37.5, 38, 39.5];

// ───────── 声音 / 拍点事件（mix.py 与 cuecheck.py 读取）
export const EV = [];
const ev = (beat, type, o = {}) => EV.push({ t: b(beat), b: beat, type, ...o });
EV.push({ t: 0, b: 0, type: 'tempo', bpm: BPM, fps: FPS, fpb: FPB });

// ───────── 相机 [拍, cx, cy, z]
const CAM = [
  [0, 960, 540, 1.0], [1, 900, 500, 1.18], [4, 540, 300, 2.35], [5.6, 540, 312, 2.3],
  [7.5, 560, 520, 1.95], [9, 570, 556, 2.1], [11.5, 580, 560, 2.35], [12, 582, 540, 2.4], [12.5, 590, 505, 2.2], [13, 600, 545, 2.1],
  [15.5, 640, 548, 2.0], [16, 680, 530, 1.95], [17, 1300, 380, 1.55], [18.5, 1300, 440, 1.55],
  [19.5, 1290, 540, 1.6], [21, 1240, 560, 1.6], [22, 1270, 540, 1.5],
  [23, 1270, 420, 1.5], [24, 1281, 352, 1.6], [25, 1281, 352, 3.0], [27.6, 1281, 352, 3.1], [28, 1281, 362, 3.05],
  [28.6, 1164, 880, 2.6], [29.2, 1164, 960, 3.6], [30, 1164, 990, 4.4], [31, 1164, 1000, 5.6], [31.5, 1164, 1005, 6.3], [31.9, 1164, 1010, 7.0], [32, 1164, 1010, 7.0],
  [32.5, 1000, 760, 1.75], [33.5, 640, 600, 1.9], [34, 600, 566, 2.1], [35.5, 566, 530, 2.25], [36.3, 560, 524, 2.42],
  [37, 580, 530, 2.2], [38.5, 600, 528, 2.1], [40, 960, 540, 1.0], [42, 960, 540, 1.0],
];
const camF = [1, 2, 3].map(j => monotone(CAM.map(k => [b(k[0]), k[j]])));
export function camAt(t) {
  let cx = camF[0](t), cy = camF[1](t), z = Math.max(1, camF[2](t));
  // 拍 12 挣脱：相机小幅震一下
  if (t > b(12) && t < b(12.8)) { const k = seg(t, b(12), b(12.8)); cx += Math.sin(k * 40) * 9 * (1 - k); cy += Math.cos(k * 34) * 6 * (1 - k); }
  if (t > b(32) && t < b(32.6)) { const k = seg(t, b(32), b(32.6)); cx += Math.sin(k * 46) * 14 * (1 - k); cy += Math.cos(k * 40) * 10 * (1 - k); }
  // 永远不拍到屏幕外
  const hw = 960 / z, hh = 540 / z;
  cx = clamp(cx, hw, 1920 - hw); cy = clamp(cy, hh, 1080 - hh);
  return [cx, cy, z];
}

// ───────── 界面状态
export function deskState(t) {
  const S = {};
  S.toastX = t < b(H.toastIn) ? null : t < b(H.swipe) ? (1 - eo(seg(t, b(H.toastIn), b(17)))) * 560 : t < b(19.3) ? ei(seg(t, b(H.swipe), b(19.2))) * 620 : null;
  S.setDx = t < b(H.grab) ? 0 : t < b(20) ? -230 * eio(seg(t, b(H.grab), b(20))) : -230 + 80 * eo(seg(t, b(20), b(H.release)));
  S.setDy = t < b(H.grab) ? 0 : t < b(20) ? -24 * Math.sin(Math.PI * seg(t, b(H.grab), b(20))) : 0;
  S.toggle = t < b(H.spit) ? eo(seg(t, b(H.stomp), b(H.stomp) + 3 / FPS)) : 1 - eo(seg(t, b(H.spit) + .25, b(H.spit) + .25 + 4 / FPS));
  S.allDone = t >= b(H.check);
  S.slotEmpty = t >= b(H.press) && t < b(H.land5);
  // 回收站
  let sx = 1, sy = 1, lid = 0;
  const pulse = (bb, a, d = .32) => { if (t >= b(bb) && t < b(bb) + d) { const k = seg(t, b(bb), b(bb) + d); return a * Math.sin(Math.PI * Math.min(1, k * 2)) * (1 - k * .5); } return 0; };
  if (t >= b(H.gulp) && t < b(H.gulp) + .3) lid = 1 - eo(seg(t, b(H.gulp), b(H.gulp) + .3));
  if (t >= b(H.gulp) - .08 && t < b(H.gulp)) lid = seg(t, b(H.gulp) - .08, b(H.gulp));
  const g = pulse(H.gulp, .1, .25) + pulse(H.bulge1, .16) + pulse(H.bulge2, .22);
  // 第三鼓：越鼓越大一直撑到吐出
  const sw = t >= b(H.bulge3) && t < b(H.spit) ? eo(seg(t, b(H.bulge3), b(H.spit))) : 0;
  sx = 1 + g * .7 + sw * .26 + (sw > 0 ? Math.sin(t * 70) * .012 : 0); sy = 1 + g + sw * .42;
  if (t >= b(H.spit)) { const k = seg(t, b(H.spit), b(H.spit) + .7); sx = 1 + (-.18 * Math.cos(k * 12)) * (1 - k); sy = 1 + (-.3 * Math.cos(k * 12)) * (1 - k); lid = t < b(H.spit) + .5 ? 1 - eo(seg(t, b(H.spit) + .1, b(H.spit) + .5)) : 0; }
  // 藏在里面时：盖子被顶开一条缝，跟着鼓动一起跳
  if (t >= b(H.gulp) + .3 && t < b(H.spit)) lid = Math.max(lid, .18 + g * 1.6 + sw * .35 + (sw > 0 ? Math.abs(Math.sin(t * 70)) * .06 : 0));
  S.trash = { sx, sy, lid, kick: t >= b(H.gulp) + .12 && t < b(H.spit) ? g + sw * .6 : null };
  return S;
}
// 深浅色：返回 {base, over, at, r}
export function darkState(t) {
  if (t < b(H.stomp)) return { base: 'L' };
  if (t < b(H.spit)) { const k = seg(t, b(H.stomp), b(H.stomp) + 1.3); return k >= 1 ? { base: 'D' } : { base: 'L', over: 'D', at: 'toggle', r: 2700 * ei(k) ** .55 * eo(k) }; }
  const k = seg(t, b(H.spit), b(H.spit) + 1.0); return k >= 1 ? { base: 'L' } : { base: 'D', over: 'L', at: 'trash', r: 2700 * eo(k) };
}

// ───────── 卡片（吉祥物）
// 每段：k = slot / drag / jump / stand / ride / hide / fly / sit
// 位置 = 「脚底中点」世界坐标；卡片底边 = 脚 - 腿长
const at = (key, fx = .5, fy = 0, dx = 0, dy = 0) => A => { const p = A(key, fx, fy); return p ? { x: p.x + dx, y: p.y + dy } : null; };
const slotFeet = A => { const p = A('slot', 0, 0); return p ? { x: p.x + CARD.w / 2, y: p.y + CARD.h } : null; };
const SEG = [
  { k: 'slot', b0: 0, b1: H.press },
  { k: 'drag', b0: H.press, b1: H.breakFree },
  { k: 'jump', b0: H.breakFree, b1: H.land1, to: at('r3', .5, 0, 30), h: 110, birth: true },
  { k: 'stand', b0: H.land1, b1: H.jump1, at: at('r3', .5, 0, 30), eyes: t => t < b(13.6) ? 'l' : t < b(14.7) ? 'wide' : t < b(15.4) ? 'l' : 'r', arms: t => t < b(14) ? 'down' : t < b(14.7) ? 'up' : 'down', mouth: t => t >= b(14) && t < b(14.7) },
  { k: 'jump', b0: H.jump1, b1: H.land2, to: at('toast', 0, 0, 250), h: 180, eyes: 'r' },
  { k: 'ride', b0: H.land2, b1: H.hop, at: at('toast', 0, 0, 250), eyes: t => t < b(17.8) ? 'l' : 'wide', scramble: b(H.swipe) },
  { k: 'jump', b0: H.hop, b1: H.land3, to: at('settb', 0, 0, 330), h: 70, eyes: 'd' },
  { k: 'ride', b0: H.land3, b1: H.release, at: at('settb', 0, 0, 330), eyes: t => t < b(19.6) ? 'l' : 'wide', scramble: b(H.grab), mouth: t => t >= b(H.grab) },
  { k: 'jump', b0: H.release, b1: H.stomp, to: at('toggle', .5, 0), h: 60, eyes: 'd', stomp: true },
  { k: 'stand', b0: H.stomp, b1: H.jump4, at: at('toggle', .5, 0), eyes: t => t < b(21.4) ? 'wide' : t < b(21.7) ? 'l' : 'r' },
  { k: 'jump', b0: H.jump4, b1: H.gulp, to: at('trash', .5, 0), h: 230, dive: true, eyes: t => 'wide', mouth: () => true },
  { k: 'hide', b0: H.gulp, b1: H.spit },
  { k: 'fly', b0: H.spit, b1: H.land5, from: at('trash', .5, 0), to: slotFeet, h: 330 },
  { k: 'sit', b0: H.land5, b1: 99, at: slotFeet },
];
SEG.forEach(s => { s.t0 = b(s.b0); s.t1 = b(s.b1); });
// 声音事件：跳、落地、步子
for (const s of SEG) {
  if (s.k === 'jump' || s.k === 'fly') { ev(s.b0, s.birth ? 'break' : s.k === 'fly' ? 'spit' : 'jump', { d: s.t1 - s.t0 }); if (s.k !== 'fly' || true) ev(s.b1, s.dive ? 'gulp' : s.stomp ? 'stomp' : s.k === 'fly' ? 'slotland' : 'land'); }
  if (s.k === 'ride') for (let bb = s.b0 + .5; bb < s.b1; bb += .5) ev(bb, 'step', { v: .5 + .2 * ((bb * 2) % 2) });
}
const LEG = 4;  // 站立时腿长（格）
const legLenOf = (s, t) => {
  if (s.k === 'slot' || s.k === 'drag') return 0;
  if (s.k === 'sit') return 0;
  if (s.birth) return LEG * eo(seg(t, s.t0, s.t0 + 4 / FPS));
  return LEG;
};
// 抓取时光标相对卡片左上角的偏移
const GRAB = { x: 196, y: 44 };
export function cardAt(t, A, cursorAt) {
  let s = SEG.find(x => t >= x.t0 && t < x.t1); if (!s) return null;
  if (s.k === 'hide') return { hidden: true };
  let pos, legs = 'stand', dir = 1, sq = 0, rot = 0, sx = 1, sy = 1, arms = 'down', eyes = 'n', mouth = false, lifted = false, alive = true, LH = legLenOf(s, t);
  const P = f => typeof f === 'function' ? f(A, t) : f;
  if (s.k === 'slot') { pos = slotFeet(A); alive = false; }
  if (s.k === 'drag') {
    alive = false; lifted = true;
    const home = slotFeet(A), c = cursorAt(t), c0 = cursorAt(b(H.press));
    const d = { x: c.x - c0.x, y: c.y - c0.y };
    // 被拖着跟光标走；拍 11 起往回拽（橡皮筋）并发抖
    const res = eio(seg(t, b(H.resist), b(H.breakFree)));
    const follow = lerp(.95, .45, res);
    pos = { x: home.x + d.x * follow, y: home.y + d.y * follow };
    if (t > b(10.5)) { const j = seg(t, b(10.5), b(H.breakFree)); pos.x += Math.sin(t * 95) * 3.5 * j; pos.y += Math.cos(t * 83) * 2 * j; rot = Math.sin(t * 60) * .012 * j; }
    rot += (c.x - pos.x - 0) * .00002;
  }
  if (s.k === 'jump' || s.k === 'fly') {
    let a;
    if (s.k === 'fly') a = P(s.from); else {
      // 起点 = 上一段在 t0 时的位置（落在当时量到的锚点上）
      const prev = SEG[SEG.indexOf(s) - 1];
      a = prev.k === 'drag' ? cardAt(s.t0 - 1e-4, A, cursorAt).feet : P(prev.at) || P(prev.to);
    }
    const bb = P(s.to); if (!a || !bb) return null;
    let p = seg(t, s.t0, s.t1);
    if (s.dive) p = (act(t) - act(s.t0)) / (act(s.t1) - act(s.t0));
    const top = Math.min(a.y, bb.y) - s.h, cyy = 2 * top - (a.y + bb.y) / 2;
    const pe = s.k === 'fly' ? ss(p) * .3 + p * .7 : p;
    pos = { x: lerp(a.x, bb.x, pe), y: (1 - pe) ** 2 * a.y + 2 * (1 - pe) * pe * cyy + pe * pe * bb.y };
    legs = 'tuck'; arms = 'up'; dir = bb.x >= a.x ? 1 : -1;
    sq = p < .5 ? -.2 * (1 - p * 2) : -.1 * (p * 2 - 1);
    if (s.dive) {   // 头朝下钻进 84px 的回收站：卡片一路被挤成竖条
      const k = seg(p, .72, 1); rot = eio(k) * Math.PI / 2 * (bb.x >= a.x ? 1 : -1); sx = 1 - .8 * eio(seg(p, .78, 1)); sy = 1 - .2 * eio(seg(p, .85, 1)); arms = 'up';
    }
    if (s.k === 'fly') { rot = -eio(seg(p, .05, .85)) * Math.PI * 2; sx = lerp(.25, 1, eo(seg(p, 0, .22))); eyes = p < .5 ? 'wide' : 'dizzy'; arms = 'flail'; legs = 'tuck'; LH = 3; }
    if (s.birth) { arms = 'up'; eyes = 'wide'; mouth = true; legs = p < .2 ? 'stand' : 'tuck'; }
  }
  if (s.k === 'stand' || s.k === 'ride') pos = P(s.at);
  if (s.k === 'ride') {
    dir = -1; const sc = t >= s.scramble;
    legs = sc ? (Math.floor(t * 12) % 2 ? 'walkA' : 'walkB') : 'stand'; arms = sc ? 'flail' : 'down';
    if (sc) { sq += Math.abs(Math.sin(t * 24)) * .05; rot = Math.sin(t * 13) * .03; }
  }
  if (s.k === 'sit') {
    pos = P(s.at); legs = 'sit'; LH = 0;
    eyes = t < b(34.6) ? 'dizzy' : t < b(H.look) ? 'n' : 'u'; arms = t < b(H.check) ? 'down' : 'none';
    if (t >= b(H.check)) { alive = false; }
  }
  if (!pos) return null;
  // 预备下蹲 / 落地挤压
  for (const j of SEG) {
    if (j.k !== 'jump' && j.k !== 'fly') continue;
    if (!j.birth && t >= j.t0 - .14 && t < j.t0) sq = Math.max(sq, .26 * ss(seg(t, j.t0 - .14, j.t0)));
    if (t >= j.t1 && t < j.t1 + .25) { const k = seg(t, j.t1, j.t1 + .25); sq = (j.stomp ? .42 : .3) * (1 - k) * Math.cos(k * 7); }
  }
  if (s.k === 'stand' && s.b0 === H.land1 && t >= b(15.5)) sq = Math.max(sq, .22 * ss(seg(t, b(15.5), b(15.8))));   // 长预备
  if (s.k === 'stand' || s.k === 'sit') { const bp = ((t % B) + B) % B; if (bp < .12) sq += .05 * Math.sin(bp / .12 * Math.PI); }   // 跟着拍子呼吸
  if (s.eyes) { const e = typeof s.eyes === 'function' ? s.eyes(t) : s.eyes; if (e) eyes = e; }
  if (s.arms) arms = typeof s.arms === 'function' ? s.arms(t) : s.arms;
  if (s.mouth) mouth = typeof s.mouth === 'function' ? s.mouth(t) : s.mouth;
  // 不规则眨眼
  const bl = Math.floor(t / 1.7), bt0 = t - bl * 1.7 - hash(bl * 3.1) * 1.2;
  if (alive && bt0 > 0 && bt0 < .1 && (eyes === 'n' || eyes === 'l' || eyes === 'r' || eyes === 'u')) eyes = 'blink';
  // 位置步进到半格（像素感）
  const x = alive ? Math.round(pos.x / (PXL / 2)) * (PXL / 2) : pos.x;
  return { feet: { x, y: pos.y }, LH, legs, dir, sq, rot, sx, sy, arms, eyes, mouth, lifted, alive, seg: s.k, done: t >= b(H.check) };
}

// ───────── 光标（用户）
// 每段 {b0, b1, to: A => 点, arc, lock}；lock 段 = 位置锁在锚点上（拖窗口）
const pt = (x, y) => () => ({ x, y });
const slotPt = (dx, dy) => A => { const p = A('slot', 0, 0); return p ? { x: p.x + dx, y: p.y + dy } : null; };
const CUR = [
  { b0: 5, b1: 5, to: pt(1180, 860) },
  { b0: 5, b1: 7, to: slotPt(GRAB.x, GRAB.y), arc: 60 },
  { b0: H.press, b1: 10.5, to: slotPt(GRAB.x + 26, GRAB.y + 66), arc: 10 },
  { b0: 10.5, b1: H.breakFree, to: slotPt(GRAB.x + 40, GRAB.y + 118), arc: 6, shake: true },
  { b0: H.breakFree, b1: 12.5, to: slotPt(GRAB.x - 90, GRAB.y + 150), arc: -30 },
  { b0: 12.5, b1: 14, to: slotPt(-40, 210), arc: 40 },
  { b0: 14.5, b1: 15.5, to: slotPt(10, 236), arc: 10 },
  { b0: 15.5, b1: 16, to: slotPt(60, 236), arc: 0 },
  { b0: 16, b1: 17.5, to: A => { const p = A('toast', 0, 0); return p && { x: p.x + 70, y: p.y + 56 }; }, arc: -120 },
  { b0: 17.5, b1: H.swipe, to: A => { const p = A('toast', 0, 0); return p && { x: p.x + 150, y: p.y + 48 }; }, arc: 0 },
  { b0: H.swipe, b1: H.grab, to: A => { const p = A('settb', 0, 0); return p && { x: p.x + 120, y: p.y + 26 }; }, arc: 50 },
  { b0: H.grab, b1: H.release, to: A => { const p = A('settb', 0, 0); return p && { x: p.x + 120, y: p.y + 26 }; }, lock: true },
  { b0: H.release, b1: 22, to: A => { const p = A('toggle', 0, 0); return p && { x: p.x - 120, y: p.y - 10 }; }, arc: 20 },
  { b0: 22.5, b1: H.freeze, to: (A, t, card) => card(b(H.freeze)) && { x: card(b(H.freeze)).feet.x - 250, y: card(b(H.freeze)).feet.y - 30 }, arc: -60, lunge: true },
  { b0: H.unfreeze, b1: 29.5, to: A => { const p = A('trash', 0, 0); return p && { x: p.x - 60, y: p.y - 70 }; }, arc: 30 },
  { b0: H.bulge1, b1: 30.5, to: A => { const p = A('trash', 0, 0); return p && { x: p.x - 20, y: p.y - 40 }; }, arc: 0 },
  { b0: H.bulge2, b1: 31.4, to: A => { const p = A('trash', 0, 0); return p && { x: p.x - 70, y: p.y - 80 }; }, arc: 0 },
  { b0: H.spit, b1: 32.5, to: A => { const p = A('trash', 0, 0); return p && { x: p.x - 210, y: p.y - 230 }; }, arc: -20 },
  { b0: 33, b1: 35.5, to: slotPt(41, 30), arc: 80 },
  { b0: 35.5, b1: H.check, to: slotPt(41, 40), arc: 0 },
  { b0: 36.6, b1: 38.6, to: slotPt(300, 200), arc: 40 },
];
CUR.forEach(s => { s.t0 = b(s.b0); s.t1 = b(s.b1); });
export const CLICKS = [H.press, 16, H.swipe, H.grab, H.check].map(x => b(x));
ev(H.cursorIn, 'cursorIn'); ev(H.press, 'press'); ev(H.press, 'drag', { d: b(H.breakFree) - b(H.press) }); ev(H.resist, 'shake', { d: b(H.breakFree) - b(H.resist) });
ev(16, 'miss'); ev(H.toastIn, 'notif'); ev(H.swipe, 'click'); ev(H.swipe, 'toastOut'); ev(H.grab, 'press'); ev(H.grab, 'winDrag', { d: b(H.release) - b(H.grab) });
ev(H.stomp, 'dark'); ev(H.lunge, 'lunge'); ev(H.freeze, 'shutter'); ev(H.unfreeze, 'unfreeze'); ev(H.bulge1, 'creak', { v: .6 }); ev(H.bulge2, 'creak', { v: .8 }); ev(H.bulge3, 'creak', { v: 1 });
ev(H.spit, 'light'); ev(H.check, 'check'); ev(36.5, 'poof'); for (const z of ZZZ) ev(z, 'zzz'); ev(H.title, 'title'); ev(H.bang, 'bang'); ev(H.end, 'end');
ev(H.freeze, 'cue_freeze'); ev(H.spit, 'cue_spit'); ev(H.stomp, 'cue_dark');

export function cursorAt(t, A, card) {
  const tc = t >= b(H.freeze) && t < b(H.unfreeze) ? b(H.freeze) : t;
  let p = null;
  for (let i = 0; i < CUR.length; i++) {
    const m = CUR[i]; if (tc < m.t0 && i > 0) break;
    const to = m.to(A, tc, card); if (!to) continue;
    if (!p || m.t1 <= m.t0) { p = { ...to }; continue; }
    if (m.lock) { if (tc >= m.t0) p = { ...to }; continue; }
    const k = seg(tc, m.t0, m.t1), e = m.lunge ? ei(k) * .4 + eio(k) * .6 : eio(k), from = p;
    const dx = to.x - from.x, dy = to.y - from.y, L = Math.hypot(dx, dy) || 1, arc = m.arc || 0;
    p = { x: lerp(from.x, to.x, e) - dy / L * arc * Math.sin(Math.PI * e), y: lerp(from.y, to.y, e) + dx / L * arc * Math.sin(Math.PI * e), sp: L / Math.max(.05, m.t1 - m.t0) * Math.sin(Math.PI * k) };
    if (m.shake && k > 0 && k < 1) { p.x += Math.sin(tc * 90) * 4; p.y += Math.cos(tc * 77) * 3; }
    if (k < 1) break;
  }
  if (!p) return null;
  let sc = 1, ring = 0, op = clamp((t - b(H.cursorIn)) / .15);
  for (const c of CLICKS) { if (t >= c && t < c + .1) sc = .82; if (t >= c && t < c + .45) ring = seg(t, c, c + .45); }
  if (t >= b(H.press) && t < b(H.breakFree)) sc = .86;    // 按住拖动
  if (t >= b(H.grab) && t < b(H.release)) sc = .86;
  return { ...p, op, sc, ring };
}

// ───────── HUD（屏幕空间）
export function hudState(t) {
  const fz0 = b(H.freeze), fz1 = b(H.unfreeze);
  return {
    spot: t >= fz0 && t < fz1 + .3 ? Math.min(seg(t, fz0, fz0 + .25), 1 - seg(t, fz1, fz1 + .3)) : 0,
    flash: t >= fz0 && t < fz0 + 4 / FPS ? 1 - seg(t, fz0, fz0 + 4 / FPS) : 0,
    pill: t >= fz0 && t < b(29.5) ? Math.min(seg(t, fz0, fz0 + 3 / FPS), 1 - seg(t, b(29.5) - 6 / FPS, b(29.5))) : 0,
    dim: seg(t, b(H.end), b(H.end) + .5) * .18,
  };
}
