// render(t)：确定性，任何一帧可单独渲染。整部片 = 一个点数组。
import { buildPath, headAt, posAt } from './engine/geom.js';
import { prepare, drawLine, drawBlots } from './engine/ink.js';
import { makePaper, drawPaper, vignette, makeTooth, drawTooth } from './engine/paper.js';
import { camAt, worldToScreen, BASE } from './engine/cam.js';
import { SEGS, STOP, ACCENT } from './drawing.js';
import { CAM } from './shots.js';
import { DUR, HT, HIT, SIGN, SECS } from './timeline.js';
import { clamp, lerp, ss } from '/core/lib.js';

const q = new URLSearchParams(location.search);
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const W = cv.width, H = cv.height;
await document.fonts.load('80px "Long Cang"', SIGN.text);

const P = prepare(buildPath(SEGS), ACCENT);
window.PATH = P;
// 停笔墨点：城市段最后一点
const cityI = P.segs.findIndex(s => s.id === 'city');
P.blots.push({ k: P.range[cityI][1], t0: STOP.t, dur: STOP.dur, r: 6.5 });
const paper = makePaper(), tooth = makeTooth();

function camFor(t) {
  if (q.get('cam')) { const [x, y, z] = q.get('cam').split(',').map(Number); return { cx: x, cy: y, k: BASE * z, r: 0, z }; }
  return camAt(P, CAM, t, W, H);
}

// 笔影：手在右下方。柔和、模糊的短楔形（约为原来的 1/3），从笔尖指向右下；笔走得快时手抬得高一点，
// 影子随之略长、略偏、略淡（笔本身不画）
function penShadow(tip, k, alpha, v = 0) {
  const sp = clamp(v / 800), kk = Math.min(k, 3);
  const ang = 0.98 + 0.07 * sp, dx = Math.cos(ang), dy = Math.sin(ang);
  const [x, y] = tip, L = 185 * kk * (0.85 + 0.3 * sp), nx = -dy, ny = dx, w0 = 1.2 * k + 1.5, w1 = 26 * kk;
  const off = 6 * Math.max(1, k * .4);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = `blur(${(9 + 4.5 * kk).toFixed(1)}px)`; ctx.globalAlpha = alpha * (0.11 - 0.025 * sp);
  const g = ctx.createLinearGradient(x, y, x + dx * L, y + dy * L);
  g.addColorStop(0, 'rgba(64,52,40,1)'); g.addColorStop(0.6, 'rgba(64,52,40,0.7)'); g.addColorStop(1, 'rgba(64,52,40,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x + dx * off + nx * w0, y + dy * off + ny * w0); ctx.lineTo(x + dx * L + nx * w1, y + dy * L + ny * w1);
  ctx.lineTo(x + dx * L - nx * w1, y + dy * L - ny * w1); ctx.lineTo(x + dx * off - nx * w0, y + dy * off - ny * w0); ctx.closePath(); ctx.fill();
  ctx.filter = 'none'; ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(20,18,16,0.9)'; ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, 1.05 * k), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 落款「早安」：手写体，从左到右写出（遮罩横扫），身后一圈纸色光晕；位置锚在纸上（世界坐标）
const SIGN_AT = [640, 468];
function sign(t, M, k) {
  if (q.has('clean')) return;
  const u = clamp((t - SIGN.t0) / SIGN.write); if (u <= 0) return;
  const p = M(...SIGN_AT), size = 78 * k / 0.81;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${size.toFixed(1)}px "Long Cang"`; ctx.textBaseline = 'alphabetic';
  const w = ctx.measureText(SIGN.text).width, x0 = p[0] - w / 2;
  ctx.beginPath(); ctx.rect(x0 - 10, p[1] - size * 1.2, (w + 20) * ss(u), size * 1.6); ctx.clip();
  ctx.fillStyle = 'rgba(29,26,23,0.84)'; ctx.fillText(SIGN.text, x0, p[1]);
  ctx.restore();
  return { x0, y0: p[1] - size * 0.9, x1: x0 + w, y1: p[1] + size * 0.25 };
}

function render(t) {
  const cam = camFor(t), M = worldToScreen(cam, W, H);
  drawPaper(ctx, paper, cam, W, H);
  const all = q.has('all'), head = all ? P.N - 1 : headAt(P, t);
  drawLine(ctx, P, head, M, cam.k);
  drawBlots(ctx, P, all ? 999 : t, M, cam.k);
  drawTooth(ctx, tooth, cam, W, H);
  vignette(ctx, W, H);
  sign(t, M, cam.k);
  if (!all && !q.has('nopen')) {
    const tip = M(...posAt(P, head));
    const leave = 1 - ss((t - HT.close - 0.3) / 0.8);         // 最后一笔后，笔影抬走
    const moving = !(t >= STOP.t && t < STOP.t + STOP.dur) && t < HT.close;
    if (leave > 0) penShadow(tip, cam.k, leave, moving ? P.V[Math.min(P.N - 1, Math.floor(head))] : 0);
  }
}

// 每一个画面事件的「实测」时刻：在路径上找到标记位置，读出笔尖经过它的时间
function markTime(seg, m) {
  const [i0, i1] = P.range[P.segs.indexOf(seg)], r = m.r ?? 4, n = m.n ?? 1;
  let cnt = 0, inside = false;
  for (let i = i0; i <= i1; i++) {
    const d = Math.hypot(P.X[i] - m.at[0], P.Y[i] - m.at[1]);
    if (d < r && !inside) { cnt++; inside = true; if (cnt === n) { let j = i, best = d; while (j + 1 <= i1 && Math.hypot(P.X[j + 1] - m.at[0], P.Y[j + 1] - m.at[1]) < best) { j++; best = Math.hypot(P.X[j] - m.at[0], P.Y[j] - m.at[1]); } return P.T[j]; } }
    if (d > r * 2) inside = false;
  }
  return null;
}

function events() {
  const ev = [];
  const track = [];
  for (let t = 0; t <= DUR + 1e-9; t += 0.005) {
    const h = headAt(P, t), i = Math.min(P.N - 2, Math.floor(h)), cam = camAt(P, CAM, t, W, H), Mx = worldToScreen(cam, W, H);
    const p = Mx(...posAt(P, h));
    const moving = t >= P.T[0] && t < P.T[P.N - 1] && !(t >= STOP.t && t < STOP.t + STOP.dur);
    // 屏幕速度（像素/秒）也导出：拟音的亮度跟随观众看到的速度
    track.push([+t.toFixed(3), moving ? Math.round(P.V[i]) : 0, +(p[0] / W).toFixed(3), P.segs[P.SEG[i]].id, +cam.k.toFixed(3)]);
  }
  ev.push({ t: 0, type: 'track', data: track });
  // 拐角（大转角 + 速度局部极小）：窗格、楼角的小「嗒」
  const corners = [];
  for (let i = 8; i < P.N - 8; i++) {
    if (P.TURN[i] < 0.9) continue;
    let isMin = true; for (let j = -6; j <= 6; j++) if (P.V[i + j] < P.V[i]) { isMin = false; break; }
    if (isMin && (!corners.length || P.T[i] - corners.at(-1).t > 0.06)) corners.push({ t: +P.T[i].toFixed(4), seg: P.segs[P.SEG[i]].id, turn: +P.TURN[i].toFixed(2) });
  }
  ev.push({ t: 0, type: 'corners', data: corners });
  // 关键动作：路径实测时刻 vs 拍点
  for (const sg of P.segs) for (const m of (sg.marks || [])) {
    const key = Object.keys(HT).find(k => Math.abs(HT[k] - m.t) < 1e-9);
    ev.push({ t: markTime(sg, m), type: 'hit', id: key, seg: sg.id, beat: m.t });
  }
  for (const sg of P.segs) ev.push({ t: P.T[P.range[P.segs.indexOf(sg)][0]], type: 'hit', id: 'seg:' + sg.id, beat: sg.t[0] });
  ev.push({ t: P.T[P.N - 1], type: 'hit', id: 'close', beat: HT.close });
  ev.push({ t: P.T[P.range[cityI][1]], type: 'hit', id: 'stop', beat: HT.stop });
  ev.push({ t: P.T[0], type: 'touch' });
  ev.push({ t: STOP.t, type: 'blot', dur: STOP.dur });
  ev.push({ t: HT.resume, type: 'resume' });
  ev.push({ t: HT.wingR, type: 'wing' });
  ev.push({ t: HT.body, type: 'wing' });
  ev.push({ t: SIGN.t0, type: 'sign', dur: SIGN.write });
  ev.push({ t: HT.close, type: 'close' });
  return ev;
}

window.DUR = DUR;
window.EV = events();
window.TEXTS = t => {
  if (t < SIGN.t0) return [];
  const cam = camAt(P, CAM, t, W, H), M = worldToScreen(cam, W, H), p = M(...SIGN_AT), size = 78 * cam.k / 0.81;
  return [{ id: 'sign', text: SIGN.text, x0: p[0] - size, y0: p[1] - size * .9, x1: p[0] + size, y1: p[1] + size * .25 }];
};
window.render = render;
window.READY = true;
