// 主舞台：放射光、电视（画中画）、生命板、关卡牌、按钮台、闹钟主持
import { toon, rrect, circ, ell, heartPath, star, INK, PAL } from './toon.js';
import { clamp, lerp, ss, eo, back, hash, TAU } from '/core/lib.js';

export const TV = { x: 440, y: 250, w: 768, h: 432 };            // 屏幕（16:9，= 画幅 / 2.5）
export const TVC = { x: TV.x + TV.w / 2, y: TV.y + TV.h / 2 };
export const HOST = { x: 1600, y: 600, r: 145 };
export const BTN = { x: 1340, y: 736 };
const FLOOR = 880;

const mixc = (a, b, k) => { // '#rrggbb' 线性混色
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(lerp(v, pb[i], k))).join(',')})`;
};

function sunburst(c, t, night) {
  c.fillStyle = mixc(PAL.violet, PAL.night, night); c.fillRect(-400, -400, 2720, 1880);
  c.save(); c.translate(TVC.x, TVC.y); c.rotate(t * .18);
  c.fillStyle = mixc(PAL.violet2, PAL.night2, night);
  for (let i = 0; i < 16; i++) { c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, 2400, i * TAU / 16, i * TAU / 16 + TAU / 32); c.closePath(); c.fill(); }
  c.restore();
  if (night > 0) { // 夜里：星点
    c.save(); c.globalAlpha = night;
    for (let i = 0; i < 40; i++) { const x = hash(i) * 1920, y = hash(i + 50) * 700, tw = .5 + .5 * Math.sin(t * 3 + i);
      c.fillStyle = PAL.cream; c.beginPath(); star(c, x, y, 2 + tw * 2, 6 + tw * 4, 4); c.fill(); }
    c.restore();
  }
}

function floor(c, beat, night, bulbsOn) {
  toon(c, rrect(-60, FLOOR, 2040, 300, 0), mixc(PAL.magenta, '#3a1450', night), mixc(PAL.magentaD, '#250c38', night), { off: 0 });
  toon(c, rrect(-60, FLOOR, 2040, 50, 0), mixc('#ff6aa8', '#4a1d63', night), null);
  // 跑马灯：每拍前进一格
  for (let i = 0; i < 22; i++) {
    const on = bulbsOn && ((i + beat) % 3 === 0);
    toon(c, circ(40 + i * 88, FLOOR + 110, 16), on ? PAL.gold : mixc('#7a2f6a', '#2a1238', night), null, { lw: 5 });
    if (on) { c.save(); c.globalAlpha = .35; c.fillStyle = PAL.gold; c.beginPath(); c.arc(40 + i * 88, FLOOR + 110, 30, 0, TAU); c.fill(); c.restore(); }
  }
}

function tvSet(c, drawScreen, flick) {
  const { x, y, w, h } = TV, b = 44;
  // 天线
  c.save(); c.lineWidth = 9; c.strokeStyle = INK; c.lineCap = 'round';
  c.beginPath(); c.moveTo(TVC.x - 20, y - b + 4); c.lineTo(TVC.x - 150, y - b - 150); c.moveTo(TVC.x + 20, y - b + 4); c.lineTo(TVC.x + 130, y - b - 165); c.stroke(); c.restore();
  toon(c, circ(TVC.x - 150, y - b - 150, 18), PAL.magenta, PAL.magentaD, { off: 4 });
  toon(c, circ(TVC.x + 130, y - b - 165, 18), PAL.cyan, PAL.cyanD, { off: 4 });
  // 底柜
  toon(c, rrect(x + 40, y + h + b - 10, w - 80, FLOOR - (y + h + b) + 14, 14), PAL.cyan, PAL.cyanD);
  for (let i = 0; i < 3; i++) toon(c, rrect(x + 90 + i * 210, y + h + b + 40, 170, 70, 10), PAL.cyanD, null, { lw: 5 });
  // 机身
  toon(c, rrect(x - b, y - b, w + 2 * b, h + 2 * b, 46), PAL.gold, PAL.goldD, { off: 12 });
  c.save(); c.beginPath(); c.roundRect(x, y, w, h, 18); c.clip();
  c.fillStyle = '#111'; c.fillRect(x, y, w, h);
  drawScreen && drawScreen(c);
  if (flick > 0) { c.globalAlpha = flick * .6; c.fillStyle = '#fff'; for (let i = 0; i < 12; i++) c.fillRect(x, y + ((i * 37 + flick * 400) % h), w, 6); }
  c.restore();
  c.save(); c.lineWidth = 7; c.strokeStyle = INK; c.beginPath(); c.roundRect(x, y, w, h, 18); c.stroke(); c.restore();
  // 玻璃高光
  c.save(); c.globalAlpha = .12; c.fillStyle = '#fff'; c.beginPath(); c.moveTo(x + 30, y + 20); c.lineTo(x + 230, y + 20); c.lineTo(x + 110, y + 200); c.lineTo(x + 20, y + 200); c.closePath(); c.fill(); c.restore();
}

function livesBoard(c, lives, crack, pulse) {
  const x = 60, y = 50;
  toon(c, rrect(x, y, 420, 150, 30), PAL.cyan, PAL.cyanD);
  for (let i = 0; i < 3; i++) {
    const cx = x + 85 + i * 125, cy = y + 80, alive = i < lives, breaking = i === 2 && crack > 0 && crack < 1;
    const s = 92 * (alive ? 1 + .12 * pulse : 1) * (breaking ? 1 + .25 * Math.sin(crack * 9) * (1 - crack) : 1);
    if (alive || breaking) toon(c, cc => heartPath(cc, cx, cy, s), PAL.magenta, PAL.magentaD, { off: 6 });
    else toon(c, cc => heartPath(cc, cx, cy + crack * 0, s), '#5a3a7a', '#47295f', { off: 6 });
    if (i === 2 && crack > 0) { // 玻璃裂纹 + 飞散碎片
      c.save(); c.strokeStyle = crack < 1 ? '#fff' : INK; c.lineWidth = 6; c.lineJoin = 'miter'; c.beginPath();
      c.moveTo(cx - 6, cy - s * .27); c.lineTo(cx + 8, cy - s * .05); c.lineTo(cx - 10, cy + s * .08); c.lineTo(cx + 4, cy + s * .3); c.stroke(); c.restore();
      if (crack < 1) for (let k = 0; k < 7; k++) {
        const a = -1.2 + k * .45, d = eo(crack) * 140, px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d + crack * crack * 160;
        c.save(); c.globalAlpha = 1 - crack; c.translate(px, py); c.rotate(crack * 6 + k); c.fillStyle = k % 2 ? PAL.magenta : '#fff';
        c.beginPath(); c.moveTo(-10, -6); c.lineTo(12, -3); c.lineTo(-2, 10); c.closePath(); c.fill(); c.restore();
      }
    }
  }
}

function badge(c, text, flip) {
  const x = 1470, y = 50, w = 380, h = 140;
  c.save(); c.translate(x + w / 2, y + h / 2); c.scale(1, Math.abs(Math.cos(flip * Math.PI)) * .96 + .04);
  toon(c, rrect(-w / 2, -h / 2, w, h, 30), PAL.gold, PAL.goldD);
  c.fillStyle = INK; c.font = '86px ZQK, TitanOne'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 0, 6); c.restore();
}

function podium(c, press, night) {
  toon(c, rrect(BTN.x - 60, BTN.y + 8, 120, FLOOR - BTN.y - 4, 12), mixc(PAL.violet2, '#221a55', night * .6), '#2a0f6e');
  const dy = press * 14;
  toon(c, ell(BTN.x, BTN.y + 8, 56, 16), '#8a8a9a', '#5a5a6a', { off: 3 });
  toon(c, cc => { cc.ellipse(BTN.x, BTN.y - 8 + dy, 44, 30 - press * 10, 0, Math.PI, 0); cc.lineTo(BTN.x + 44, BTN.y + 6); cc.lineTo(BTN.x - 44, BTN.y + 6); cc.closePath(); }, PAL.fail, PAL.failD, { off: 6 });
}

// 闹钟主持。h = {hop 0..1(拍后相位), tilt -1..1(锤子左右), mode, ring 0..1, press 0..1, eyes:'open'|'wide'|'shut'|'happy', mouth, t}
export function host(c, h) {
  const { x, y, r } = HOST; const t = h.t;
  let jx = 0, jy = 0, sq = 1;
  if (h.mode === 'tick' || h.mode === 'cheer') { const p = h.hop; jy = -Math.sin(Math.PI * clamp(p * 1.4)) * (h.mode === 'cheer' ? 50 : 22); sq = 1 + .07 * Math.max(0, 1 - p * 6); }
  if (h.ring > 0) { jx = Math.sin(t * 190) * 7 * h.ring; jy += Math.cos(t * 160) * 4 * h.ring; }
  if (h.flinch) { jx += -18 * h.flinch; }
  c.save(); c.translate(x + jx, y + jy);
  // 腿
  c.save(); c.lineWidth = 12; c.strokeStyle = INK; c.lineCap = 'round';
  c.beginPath(); c.moveTo(-55, r * .8); c.lineTo(-70, FLOOR - y - jy - 18); c.moveTo(55, r * .8); c.lineTo(70, FLOOR - y - jy - 18); c.stroke(); c.restore();
  toon(c, ell(-82, FLOOR - y - jy - 14, 40, 18), PAL.fail, PAL.failD, { off: 4 });
  toon(c, ell(82, FLOOR - y - jy - 14, 40, 18), PAL.fail, PAL.failD, { off: 4 });
  c.scale(1 / sq, sq);
  // 手臂（左臂按按钮）
  const pr = h.press || 0;
  const hx = lerp(-r - 40, BTN.x - x - jx, pr), hy = lerp(40, BTN.y - y - jy - 40 + pr * 10, pr);
  c.save(); c.lineWidth = 11; c.strokeStyle = INK; c.lineCap = 'round';
  c.beginPath(); c.moveTo(-r * .85, 20); c.quadraticCurveTo(-r - 40, 100 - pr * 40, hx, hy); c.stroke();
  const ra = h.mode === 'cheer' || h.ring > 0 ? -1 : 0;
  c.beginPath(); c.moveTo(r * .85, 20); c.quadraticCurveTo(r + 50, 60 + ra * 80, r + 40, 60 + ra * 160); c.stroke(); c.restore();
  toon(c, circ(hx, hy, 26), '#fff', '#d8d8e8', { off: 4, lw: 6 });
  toon(c, circ(r + 40, 60 + ra * 160, 26), '#fff', '#d8d8e8', { off: 4, lw: 6 });
  // 双铃 + 锤
  const ham = h.ring > 0 ? Math.sin(t * 150) * .9 : h.tilt;
  for (const sgn of [-1, 1]) {
    c.save(); c.rotate(sgn * .62); c.translate(0, -r - 6);
    c.lineWidth = 9; c.strokeStyle = INK; c.beginPath(); c.moveTo(0, 20); c.lineTo(0, -6); c.stroke();
    toon(c, cc => { cc.arc(0, -10, 62, Math.PI, 0); cc.lineTo(62, -4); cc.lineTo(-62, -4); cc.closePath(); }, PAL.gold, PAL.goldD, { off: 7 });
    toon(c, circ(0, -76, 12), PAL.gold, PAL.goldD, { off: 3, lw: 5 });
    c.restore();
  }
  c.save(); c.translate(0, -r - 6); c.rotate(ham * .55);
  c.lineWidth = 8; c.strokeStyle = INK; c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -88); c.stroke();
  toon(c, circ(0, -92, 15), PAL.cyan, PAL.cyanD, { off: 3, lw: 5 }); c.restore();
  // 机身 + 表盘
  toon(c, circ(0, 0, r), PAL.magenta, PAL.magentaD, { off: 12 });
  toon(c, circ(0, 0, r * .78), PAL.cream, PAL.creamD, { off: 8, lw: 6 });
  for (let i = 0; i < 12; i++) { const a = i * TAU / 12; c.fillStyle = INK; c.beginPath(); c.arc(Math.cos(a) * r * .66, Math.sin(a) * r * .66, i % 3 ? 4 : 7, 0, TAU); c.fill(); }
  // 脸
  const e = h.eyes || 'open';
  c.fillStyle = INK; c.strokeStyle = INK; c.lineCap = 'round';
  for (const sgn of [-1, 1]) {
    const ex = sgn * 38, ey = -22;
    if (e === 'shut') { c.lineWidth = 8; c.beginPath(); c.arc(ex, ey, 18, .2, Math.PI - .2); c.stroke(); }
    else if (e === 'happy') { c.lineWidth = 8; c.beginPath(); c.arc(ex, ey + 10, 18, Math.PI + .3, -.3); c.stroke(); }
    else { const s = e === 'wide' ? 1.35 : 1; c.beginPath(); c.ellipse(ex, ey, 15 * s, 24 * s, 0, 0, TAU); c.fill();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(ex + 5, ey - 9 * s, 5 * s, 0, TAU); c.fill(); c.fillStyle = INK; }
  }
  c.lineWidth = 8;
  const m = h.mouth || 'smile';
  c.beginPath();
  if (m === 'smile') c.arc(0, 30, 34, .25, Math.PI - .25);
  else if (m === 'o') { c.ellipse(0, 52, 16, 22, 0, 0, TAU); c.fill(); }
  else if (m === 'flat') { c.moveTo(-26, 48); c.lineTo(26, 48); }
  else if (m === 'yawn') { c.ellipse(0, 50, 24, 30, 0, 0, TAU); c.fill(); }
  else if (m === 'grin') { c.moveTo(-44, 30); c.quadraticCurveTo(0, 96, 44, 30); c.closePath(); c.fill(); }
  c.stroke();
  c.restore();
}

export function drawStage(c, s) {
  sunburst(c, s.t, s.night);
  floor(c, s.beat, s.night, s.bulbs !== false);
  if (s.preInk) s.preInk(c);
  tvSet(c, s.screen, s.flick || 0);
  if (s.stamp) stamp(c, s.stamp.kind, s.stamp.p, TVC.x, TVC.y, 1);
  podium(c, s.press || 0, s.night);
  livesBoard(c, s.lives, s.crack || 0, s.pulse || 0);
  badge(c, s.badge, s.badgeFlip || 0);
  host(c, s.host);
}

// ✓ / ✗ / 通关 印章（成功色 / 失败色固定）
export function stamp(c, kind, p, x, y, k = 1) {
  if (p <= 0) return;
  const sc = p < 1 ? lerp(2.3, 1, eo(p)) : 1, a = -.2;
  c.save(); c.translate(x, y); c.rotate(a); c.scale(sc * k, sc * k);
  const col = kind === 'fail' ? PAL.fail : PAL.ok, sh = kind === 'fail' ? PAL.failD : PAL.okD;
  if (kind === 'done') {
    toon(c, rrect(-330, -120, 660, 240, 40), col, sh, { lw: 10, off: 12 });
    c.fillStyle = '#fff'; c.font = '170px ZQK'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 16; c.strokeStyle = INK; c.lineJoin = 'round'; c.strokeText('通关！', 0, 10); c.fillText('通关！', 0, 10);
  } else {
    toon(c, circ(0, 0, 150), col, sh, { lw: 10, off: 12 });
    toon(c, circ(0, 0, 118), '#fff', null, { lw: 6 });
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const [w, st] of [[54, INK], [34, col]]) {
      c.lineWidth = w; c.strokeStyle = st; c.beginPath();
      if (kind === 'fail') { c.moveTo(-55, -55); c.lineTo(55, 55); c.moveTo(55, -55); c.lineTo(-55, 55); }
      else { c.moveTo(-62, 4); c.lineTo(-16, 50); c.lineTo(66, -48); }
      c.stroke();
    }
  }
  c.restore();
}
