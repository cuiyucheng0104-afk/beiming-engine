// 每个镜头一个函数：({t, f, lt, g, e, A}) → 可选的 CRT 参数覆盖
import { canvas, W, H, TAU, rgba, mix, LWK, poly, path, cel, line, hash } from './cel.js';
import { PAL, RIM } from './pal.js';
import { MODES, LAND, poles } from './bg.js';
import { rider, head, hat, hatOnHead, bust, hand, limb, ik, longBack, arm } from './girl.js';
import { tram, TRAM_L } from './tram.js';
import { speedLines, flare } from './fx.js';
import { bf, df, FPS, FPB, F20, FC, CUES } from './timeline.js';

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, u) => a + (b - a) * u;
const seg = (x, a, b) => clamp((x - a) / (b - a));
const ss = u => { u = clamp(u); return u * u * (3 - 2 * u); };
const eio = u => { u = clamp(u); return u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };
const eo = u => 1 - Math.pow(1 - clamp(u), 3);
const two = t => Math.floor(t * 12 + 1e-6) / 12;      // 一拍二（12 fps）
const three = t => Math.floor(t * 8 + 1e-6) / 8;      // 一拍三（8 fps）
// 关键帧（帧号, 值）线性/平滑插值
function keys(K, f, ease = ss) { if (f <= K[0][0]) return K[0][1]; for (let i = 0; i < K.length - 1; i++) { const [f0, v0] = K[i], [f1, v1] = K[i + 1]; if (f <= f1) { const u = ease((f - f0) / (f1 - f0)); return Array.isArray(v0) ? v0.map((x, j) => lerp(x, v1[j], u)) : lerp(v0, v1, u); } } return K[K.length - 1][1]; }

// —— 离屏画布：角色单独画在 cc 上，便于光带（source-atop）、冲击帧剪影、在发光板上压黑 ——
const [cc, cg] = canvas(W, H), [tmp, tg] = canvas(W, H);
function clearC() { cg.setTransform(1, 0, 0, 1, 0, 0); cg.globalCompositeOperation = 'source-over'; cg.globalAlpha = 1; cg.clearRect(0, 0, W, H); }
function stamp(e, src = cc) {   // 角色剪影压进发光板（光不透过人物）
  tg.setTransform(1, 0, 0, 1, 0, 0); tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, W, H); tg.drawImage(src, 0, 0);
  tg.globalCompositeOperation = 'source-in'; tg.fillStyle = '#000'; tg.fillRect(0, 0, W, H); tg.globalCompositeOperation = 'source-over';
  e.drawImage(tmp, 0, 0);
}
function silhouette(src, col) {
  tg.setTransform(1, 0, 0, 1, 0, 0); tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, W, H); tg.drawImage(src, 0, 0);
  tg.globalCompositeOperation = 'source-in'; tg.fillStyle = col; tg.fillRect(0, 0, W, H); tg.globalCompositeOperation = 'source-over';
  return tmp;
}
// 光带扫过定住的赛璐璐：斜向亮带（+ 前后两条细带），只落在角色上
function lightBands(x, w, ang = -.5, col = '#fff1c8', a = .55) {
  cg.save(); cg.setTransform(1, 0, 0, 1, 0, 0); cg.globalCompositeOperation = 'source-atop';
  cg.translate(x, 540); cg.rotate(ang);
  cg.fillStyle = rgba(col, a); cg.fillRect(-w / 2, -1400, w, 2800);
  cg.fillStyle = rgba(col, a * .7); cg.fillRect(-w / 2 - w * .9, -1400, w * .22, 2800); cg.fillRect(w / 2 + w * .5, -1400, w * .14, 2800);
  cg.restore();
}
// 冲击帧：单色背景 + 放射线 + 反色剪影
function impact(g, e, cx, cy, frameIdx) {
  e.setTransform(1, 0, 0, 1, 0, 0); e.fillStyle = '#000'; e.fillRect(0, 0, W, H);
  g.fillStyle = frameIdx ? '#fff4dc' : '#2a0d3c'; g.fillRect(0, 0, W, H);
  speedLines(g, 7 + frameIdx, { type: 'radial', cx, cy, n: 120, r0: 90, col: frameIdx ? '#2a0d3c' : '#ffb35a', a: .9, wmul: 1.4 });
  g.drawImage(silhouette(cc, frameIdx ? '#2a0d3c' : '#fff4dc'), 0, 0);
  e.fillStyle = rgba('#ffb35a', frameIdx ? .1 : .35); e.fillRect(0, 0, W, H);
}
// 海鸥（一拍二的两张画）
function gull(g, x, y, s, ph, col) {
  const up = Math.floor(ph * 2) % 2 ? -1 : 1;
  g.strokeStyle = col; g.lineWidth = 2.4 * s; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(x - 16 * s, y - 6 * s * up); g.quadraticCurveTo(x - 7 * s, y - 9 * s * up, x, y); g.quadraticCurveTo(x + 7 * s, y - 9 * s * up, x + 16 * s, y - 6 * s * up); g.stroke();
}

// —— 海岸大景（S1 与 S8 共用同一构图，换色指定）——
function coast(g, e, A, mode, cam, actors) {
  const M = MODES[mode], z = cam.z, sky = A['sky_' + mode], sea = A['sea_' + mode], land = A['land_' + mode];
  const put = (ctx, img, wx, wy, p) => { const tx = (wx - cam.x * p - 960) * z + 960, ty = (wy - cam.y * p - 540) * z + 540; ctx.drawImage(img, tx, ty, img.width * z, img.height * z); };
  put(g, sky.c, -1000, -440, .25); put(e, sky.e, -1000, -440, .25);
  // 海鸥（远层）
  const gt = two(cam.t);
  for (let k = 0; k < 6; k++) { const wx = 300 + k * 260 + gt * (20 + k * 6), wy = 120 + (k * 53) % 160 + Math.sin(gt * 2 + k) * 8; const tx = (wx - cam.x * .3 - 960) * z + 960, ty = (wy - cam.y * .3 - 540) * z + 540; gull(g, tx, ty, .9 * z, gt * 3 + k * .37, mode === 'gold' ? '#4a4a6a' : '#3a2440'); }
  put(g, sea.c, -800, 410, .5); put(e, sea.e, -800, 410, .5);
  put(g, land.c, -800, 0, 1); put(e, land.e, -800, 0, 1);
  // 电线杆（陆地层）
  g.save(); g.setTransform(z, 0, 0, z, (-cam.x - 960) * z + 960, (-cam.y - 540) * z + 540);
  poles(g, M, -800, 4400, LAND.wall - 260, LAND.rail + 6, 360, 1);
  g.restore();
  const S = (wx, wy) => [(wx - cam.x - 960) * z + 960, (wy - cam.y - 540) * z + 540];
  actors(S, z);
}

// ================= S1 大远景横摇：巨大的夏日海岸，小小的少女 =================
export function coastShot({ t, f, g, e, A }) {
  const u = t / (bf(8) / FPS);
  const cam = { x: lerp(560, 1620, eio(u * .92 + .04)), y: lerp(-50, 0, ss(u)), z: lerp(1.0, 1.06, ss(u)), t };
  coast(g, e, A, 'gold', cam, (S, z) => {
    const tc = two(t);
    // 电车：b7 车头从画面左边进来
    const t7 = bf(7) / FPS, camAt7 = lerp(560, 1620, eio((t7 / (bf(8) / FPS)) * .92 + .04)), z7 = lerp(1.0, 1.06, ss(t7 / (bf(8) / FPS)));
    const tramX0 = camAt7 + 960 - 960 / z7;   // b7 时车头正好在画面左缘
    const tx = tramX0 + (t - t7) * 560;
    if (t >= t7 - 1 / 24) { g.save(); const [sx, sy] = S(tx, LAND.rail + 14); g.translate(sx, sy); g.scale(.46 * z, .46 * z); tram(g, e, PAL.gold, { wheelA: tc * 9, ph: 0 }); g.restore(); }
    // 少女（约画高 1/11）
    const gx = 1720 + 165 * t, [sx, sy] = S(gx, LAND.road0 + 70);
    clearC(); cg.translate(sx, sy); cg.scale(.19 * z, .19 * z);
    rider(cg, PAL.gold, { crank: tc * 9.5, wheelA: tc * 7, speed: .4, ph: tc * 1.6, wind: .7, expr: 'neutral' });
    g.drawImage(cc, 0, 0); stamp(e);
  });
  // 前景草（最快一层，带横向拖影）
  const fgx = -lerp(560, 1620, eio(u * .92 + .04)) * 1.35;
  g.save(); g.filter = 'blur(2px)';
  for (let k = 0; k < 30; k++) { const x = ((k * 211 + fgx) % 2400 + 2400) % 2400 - 240, h = 60 + (k * 37) % 90; g.fillStyle = k % 3 ? '#2a5a34' : '#3d7a40'; g.beginPath(); g.moveTo(x, 1090); g.quadraticCurveTo(x + 10, 1090 - h * .6, x + 26 + (k % 5) * 4, 1090 - h); g.quadraticCurveTo(x + 18, 1090 - h * .5, x + 30, 1090); g.fill(); }
  g.restore();
  // 太阳闪光（逐帧）
  { const cx = lerp(560, 1620, eio(u * .92 + .04)), cy = lerp(-50, 0, ss(u)), z = lerp(1.0, 1.06, ss(u)); flare(e, (1450 - 1000 - cx * .25 - 960) * z + 960, (690 - 440 - cy * .25 - 540) * z + 540, .8, '#ffd08a', { streak: 700, ghostA: .7 }); }
  return {};
}

// ================= S2 侧向跟拍：并跑，回头，站起来蹬 =================
export function sideShot({ t, f, g, e, A }) {
  const t0 = bf(8) / FPS, lt = t - t0, tc = two(t), M = MODES.gold;
  // 远景：天空 + 海（慢）
  g.drawImage(A.sky_gold.c, -380 - lt * 30, 360 - 910); e.drawImage(A.sky_gold.e, -380 - lt * 30, 360 - 910);
  g.drawImage(A.sea_gold.c, -600 - lt * 60, 300); e.drawImage(A.sea_gold.e, -600 - lt * 60, 300);
  // 海堤
  const wallY = 560;
  const grd = g.createLinearGradient(0, wallY, 0, wallY + 50); grd.addColorStop(0, mix(M.wall, '#ffffff', .25)); grd.addColorStop(.3, M.wall); grd.addColorStop(1, M.wallSh);
  g.fillStyle = grd; g.fillRect(0, wallY, W, 50);
  const off = lt * 1150;
  g.fillStyle = rgba('#000000', .2); for (let x = -(off % 260); x < W; x += 260) g.fillRect(x, wallY, 5, 50);
  // 道砟 + 轨道
  g.fillStyle = M.ballast; g.fillRect(0, wallY + 50, W, 100);
  for (let x = -(off % 40); x < W; x += 40) { g.fillStyle = mix(M.ballast, '#3a2a2a', .45); g.fillRect(x, 676, 20, 22); }
  g.fillStyle = M.rail; g.fillRect(0, 668, W, 6); g.fillRect(0, 690, W, 6);
  // 电线杆（在轨道外侧，被电车挡住一部分）——横向拖影
  g.save(); g.translate(-(off % 520), 0); poles(g, M, 0, W + 1040, 60, wallY + 10, 520, 1.6); g.restore();
  // 电车：从左后方追上来并超过
  const tramFront = lerp(-60, 1500, seg(lt, 0, 2.3));
  g.save(); g.translate(tramFront, 700); tram(g, e, PAL.gold, { wheelA: tc * 14, ph: (tc * 60) % 40 }); g.restore();
  // 路面（快）
  const rg = g.createLinearGradient(0, 700, 0, 1000); rg.addColorStop(0, M.roadLit); rg.addColorStop(1, mix(M.road, '#000000', .2));
  g.fillStyle = rg; g.fillRect(0, 700, W, 300);
  g.fillStyle = M.line; g.fillRect(0, 712, W, 6);
  const off2 = lt * 1750;
  g.save(); g.filter = 'blur(3px)'; for (let x = -(off2 % 300); x < W; x += 300) g.fillRect(x, 850, 150, 8); g.restore();
  // 少女（全身 ≈ 画高 47%）
  const turn = keys([[bf(10) - 1, 0], [bf(10), .45], [bf(10) + 3, .8], [bf(10) + 6, 1], [bf(11) - 3, 1], [bf(11), .45], [bf(11) + 3, 0]], Math.floor(f / 3) * 3, x => x);
  const stand = keys([[bf(11), 0], [bf(11) + 3, .55], [bf(11) + 6, 1]], Math.floor(f / 3) * 3, x => x);
  const cad = lerp(1.6, 2.4, seg(f, bf(11), bf(12)));
  clearC(); cg.translate(760, 990 + (stand > .5 ? Math.sin(tc * TAU * 2.4) * 6 : 0)); cg.scale(.78, .78);
  rider(cg, PAL.gold, { crank: tc * TAU * cad, wheelA: tc * 20, speed: .85, ph: tc * 2, wind: 1, stand, turn, hairWind: turn > .66 ? .2 : .95, expr: turn > .66 ? 'neutral' : 'determined' });
  g.drawImage(cc, 0, 0); stamp(e);
  // 近景草（最快，拖影）
  const off3 = lt * 2600;
  g.save(); g.filter = 'blur(6px)';
  for (let k = 0; k < 18; k++) { const x = ((k * 197 - off3) % 2400 + 2400) % 2400 - 240, h = 90 + (k * 53) % 120; g.fillStyle = k % 3 ? '#2e6a38' : '#4a8a44'; g.beginPath(); g.moveTo(x - 60, 1090); g.quadraticCurveTo(x + 10, 1090 - h * .7, x + 40, 1090 - h); g.quadraticCurveTo(x + 30, 1090 - h * .4, x + 90, 1090); g.fill(); }
  g.restore();
  g.fillStyle = M.grassSh; g.fillRect(0, 1000, W, 80);
  flare(e, 140 - lt * 30, 140, .5, '#ffd08a', { streak: 500, ghostA: .5 });
  return {};
}

// ================= S3 胸像推镜 + 速度线 + 光带 =================
export function bustShot({ t, f, g, e }) {
  const t0 = bf(12) / FPS, lt = t - t0, tc = two(t), z = lerp(2.05, 2.3, ss(lt / (bf(14) / FPS - t0)));
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#3f78d4'); gr.addColorStop(.55, '#8fc2ec'); gr.addColorStop(1, '#f6d6b0');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  speedLines(g, Math.floor(f), { type: 'h', n: 90, col: '#ffffff', a: .75, hmax: 9 });
  speedLines(e, Math.floor(f) + 50, { type: 'h', n: 20, col: '#ffe0a0', a: .3, hmax: 5 });
  clearC(); cg.translate(980, 470); cg.scale(z, z); LWK.k = .75;
  bust(cg, PAL.gold, { view: 'q', neck: true });
  head(cg, PAL.gold, { view: 'q', expr: 'determined', ph: tc * 2.2, wind: 1, neck: false });
  hatOnHead(cg, PAL.gold, 'q', { ph: tc * 2.2, wind: 1, lift: .06 + Math.sin(tc * 20) * .03 });
  LWK.k = 1;
  // 电线杆的影子 / 阳光一条条扫过（从右往左，逐帧）
  for (let k = 0; k < 3; k++) { const x = 2300 - ((lt * 2600 + k * 760) % 2600); lightBands(x, 120, -.35, k % 2 ? '#3a2a6a' : '#fff1c8', k % 2 ? .22 : .38); }
  g.drawImage(cc, 0, 0); stamp(e);
  return {};
}

// ================= S4 眼睛大特写：眯眼 + 星芒 =================
export function eyesShot({ t, f, g, e }) {
  const t0 = bf(14) / FPS, lt = t - t0, tc = two(t), z = lerp(6.6, 7.1, ss(lt / (bf(16) / FPS - t0)));
  g.fillStyle = '#f6d6b0'; g.fillRect(0, 0, W, H);
  speedLines(g, f, { type: 'h', n: 60, col: '#ffffff', a: .8, hmax: 12 });
  // 眯眼：b15 三张（8 fps）
  const nf = f - bf(15), lid = nf < 0 ? .38 : nf < 3 ? .5 : nf < 6 ? .6 : .66;
  clearC(); cg.translate(960 + 21 * z, 560 - 22 * z); cg.scale(z, z); LWK.k = .42;
  head(cg, PAL.gold, { view: 'q', expr: 'resolve', lid, ph: tc * 2.2, wind: 1 });
  hatOnHead(cg, PAL.gold, 'q', { ph: tc * 2.2, wind: 1 });
  LWK.k = 1;
  const x = 2400 - ((lt * 3000) % 3000); lightBands(x, 220, -.35, '#fff1c8', .3);
  g.drawImage(cc, 0, 0); stamp(e);
  // 眼中星芒（b15 起闪 6 帧）
  if (nf >= 0 && nf < 8) { const k = 1 - nf / 8; flare(e, 960 - 7 * z, 560 - 0 * z, .55 * k + .1, '#ffffff', { streak: 500, ghosts: false, spikes: 4, rot: .78 }); }
  return {};
}

// 仰头/惊讶时也保持杏仁眼（与 S3/S4 同一个人：眼睛不变圆、虹膜不放大）
const EYE_KEEP = { open: .9, lid: .14, iris: .96 };

// ================= S5 帽飞：冲击帧 → 帽子近景 → 跟摇上仰（甩起后越来越慢），渐慢 =================
// 镜头先在少女胸像上停 4 帧（头肩完整、占画高 > 1/2），草帽贴着镜头飞起（近景，约 1/3 画高）；
// 然后猛地上仰跟着帽子，少女从画面下方整个甩出去；帽子越飞越小，身后拖着速度线，越来越慢地飞向太阳。
const S5P = [[bf(16) + 2, 0], [bf(16) + 6, .045], [bf(17), .36], [bf(18), .76], [bf(19), .93], [F20, 1]];
const s5cam = f => { const p = keys(S5P, f, x => x), pe = ss(p) * .25 + p * .75; return { p, ox: lerp(880, 120, pe), oy: lerp(1620, 160, pe) }; };
const S5HP = [[bf(16), [1010, 400]], [bf(16) + 6, [900, 330]], [bf(17), [880, 300]], [bf(18), [790, 360]], [F20, [668, 404]]];
const S5HS = [[bf(16), 2.25], [bf(16) + 6, 2.0], [bf(17), 1.2], [bf(18), .8], [bf(19), .64], [F20, .56]];
function hatTrail(g, e, f, x, y, size) {
  // 相对天空的速度（屏幕位移 + 镜头位移）→ 反方向拖出几条速度线
  const a = s5cam(f), b = s5cam(f - 1), h0 = keys(S5HP, f), h1 = keys(S5HP, f - 1);
  const vx = (h0[0] - h1[0]) + (a.ox - b.ox), vy = (h0[1] - h1[1]) + (a.oy - b.oy), sp = Math.hypot(vx, vy);
  if (sp < .5) return;
  const dx = -vx / sp, dy = -vy / sp, px = -dy, py = dx, L = Math.min(620, 60 + sp * 5.5);
  // 赛璐璐速度线：细长楔形（根部粗、尾端尖），白色实心 + 淡紫描边，一拍二换一张
  g.save();
  for (let k = 0; k < 14; k++) {
    const r = hash(k * 7.3 + Math.floor(f / 2) * 1.7), o = (k / 13 - .5) * size * 1.25 * (.8 + .4 * r), l = L * (.4 + .6 * hash(k * 3.1 + Math.floor(f / 2) * .37));
    const x0 = x + px * o + dx * size * .3, y0 = y + py * o + dy * size * .3, w = (2.5 + 6 * r) * Math.min(1.2, .4 + size / 300);
    g.beginPath(); g.moveTo(x0 + px * w, y0 + py * w); g.lineTo(x0 + dx * l, y0 + dy * l); g.lineTo(x0 - px * w, y0 - py * w); g.closePath();
    g.fillStyle = k % 3 ? 'rgba(255,255,255,.9)' : 'rgba(255,240,210,.85)'; g.fill();
  }
  g.restore();
}
export function hatShot({ t, f, g, e, A }) {
  const tc = two(t), sky = A.sky_tall;
  const { p, ox, oy } = s5cam(f);
  g.drawImage(sky.c, -ox, -oy); e.drawImage(sky.e, -ox, -oy);
  // 少女：胸像（3/4 朝右，惊讶地往后上方看帽子），前景层 → 比天空移得快，被镜头整个甩下去
  const gx = 1270 + (880 - ox) * .5, gy = 640 + (1620 - oy) * 2.4;   // 前景视差大：镜头一甩，3 帧内整个出画，不在底边露半个头
  clearC();
  if (gy < 1330) {
    const ex = f < bf(16) + 3 ? 'determined' : 'surprised';
    cg.save(); cg.translate(gx, gy); cg.rotate(-.1); cg.scale(1.55, 1.55);
    longBack(cg, PAL.gold, { ph: tc * 2, wind: 1, len: .8 });
    bust(cg, PAL.gold, { view: 'q', neck: true });
    head(cg, PAL.gold, { view: 'q', expr: ex, E: ex === 'surprised' ? { open: .98, lid: .04, iris: .9, look: [-.7, -.75] } : {}, ph: tc * 2.2, wind: 1, neck: false });
    cg.restore();
  }
  // 草帽：近景飞起 → 越来越小（逐帧位置跟镜头），自身旋转一拍二
  const hp = keys(S5HP, f), hs = keys(S5HS, f);
  const sp = tc * 7.5, q = Math.sin(sp) * .8, rot = Math.sin(sp * .7) * .6 - .3;
  if (f >= bf(16) + 2) hatTrail(g, e, f, hp[0], hp[1], 300 * hs * .78);
  cg.save(); cg.setTransform(1, 0, 0, 1, 0, 0); cg.translate(hp[0], hp[1]); cg.scale(hs * .78, hs * .78);
  hat(cg, PAL.gold, { q, rot, ph: tc * 3, wind: 1, tailAng: -rot });
  cg.restore();
  if (f < bf(16) + 2) { impact(g, e, hp[0], hp[1], f - bf(16)); return { bloom: .5 }; }
  // 阵风流线（白色斜线，逐帧，随渐慢变稀）
  g.save(); g.translate(960, 540); g.rotate(-.42); g.translate(-960, -540);
  speedLines(g, f, { type: 'h', n: Math.round(lerp(46, 10, p)), col: '#ffffff', a: lerp(.6, .25, p), hmax: 4 });
  g.restore();
  g.drawImage(cc, 0, 0); stamp(e);
  // 太阳闪光越来越大
  const sun = [640 - ox, 520 - oy];
  flare(e, sun[0], sun[1], lerp(.6, 1.4, p), '#ffd08a', { streak: 900, ghostA: .8 });
  return {};
}

// ================= S6 定格：逆光，帽子悬在太阳前，无声伸手 =================
export function freezeShot({ t, f, g, e, A }) {
  const back = A.sky_back, lf = f - F20, z = 1 + .045 * ss(lf / (FC - F20));
  g.save(); g.translate(700, 380); g.scale(z, z); g.translate(-700, -380);
  e.save(); e.translate(700, 380); e.scale(z, z); e.translate(-700, -380);
  g.drawImage(back.c, -60, -40); e.drawImage(back.e, -60, -40);
  // 草帽：逆光剪影 + 暖色轮廓（悬停）
  clearC(); cg.translate(780, 330); cg.scale(.72, .72); hat(cg, PAL.backlit, { q: -.35, rot: -.4, ph: .3, wind: .6, rim: { c: RIM, d: [2.5, 2.5] } });
  cg.setTransform(1, 0, 0, 1, 0, 0);
  // 少女：逆光仰头（镜像 3/4，朝左），只有头发循环在动
  const P = PAL.backlit, rim = { c: RIM, d: [1.8, 1.3] };
  const ph = two(t) * .6;
  cg.save(); cg.translate(1300, 650); cg.scale(-1.9, 1.9); cg.rotate(-.12);
  // 伸手：C-9f 起三张（8 fps）
  const k = lf - (FC - F20 - 9), stage = k < 0 ? 0 : k < 3 ? 1 : k < 6 ? 2 : 3;
  longBack(cg, P, { ph, wind: .6, rim, len: .85 });
  bust(cg, P, { view: 'q', rim, neck: true });
  head(cg, P, { view: 'q', expr: 'upward', E: EYE_KEEP, ph, wind: .7, rim, skinRim: RIM, neck: false, lockRim: false });
  // 近侧手臂（局部坐标，镜像后在画面右侧）——伸向帽子：上臂 + 肘 + 前臂一整块，带袖口
  const SH = [140, 196];
  const HA = [[190, 420], [250, 150], [300, -60], [330, -240]][stage];
  const el = arm(cg, P, SH, HA, { rim });
  hand(cg, P, HA[0], HA[1], Math.atan2(HA[1] - el[1], HA[0] - el[0]), 1.1, { rim });
  cg.restore();
  // 「和声」赛璐璐：定格的高潮画面允许在人物里用一次渐变（左上被太阳照亮 → 右下沉入暗紫）
  cg.save(); cg.globalCompositeOperation = 'source-atop';
  const hg = cg.createLinearGradient(700, 300, 1500, 1080); hg.addColorStop(0, 'rgba(255,170,100,.42)'); hg.addColorStop(.45, 'rgba(255,140,120,.12)'); hg.addColorStop(1, 'rgba(40,10,60,.35)');
  cg.fillStyle = hg; cg.fillRect(0, 0, W, H); cg.restore();
  g.drawImage(cc, 0, 0); stamp(e);
  g.restore(); e.restore();
  flare(e, 700 + (700 - 700) * z, 380, 1.5, '#ffcf8a', { streak: 1100, ghostA: .9 });
  return { bloom: 1.0, halo: .3 };
}

// ================= S7 接帽：冲击帧 → 逆光中近景，光带扫过，笑 =================
export function catchShot({ t, f, g, e, A }) {
  const back = A.sky_back, lf = f - FC, tc = two(t);
  const P = PAL.backlit, rim = { c: RIM, d: [1.6, 1.2] };
  // 接住瞬间震镜，然后慢拉
  const shake = lf < 10 ? (1 - lf / 10) * 14 : 0, sx = Math.sin(lf * 2.7) * shake, sy = Math.cos(lf * 3.1) * shake;
  const z = lerp(1.13, 1.0, ss(lf / (df(6) - FC)));
  g.save(); g.translate(960 + sx, 540 + sy); g.scale(z, z); g.translate(-960, -540);
  e.save(); e.translate(960 + sx, 540 + sy); e.scale(z, z); e.translate(-960, -540);
  g.drawImage(back.c, -260, -120); e.drawImage(back.e, -260, -120);
  // 远处海平线 + 电车剪影（向右远去，预告结尾）
  g.fillStyle = '#6a4a7a'; g.fillRect(-100, 900, W + 200, 300);
  const trx = 300 + lf * 4;
  g.save(); g.translate(trx, 905); g.scale(.22, .22); tram(g, e, PAL.backlit, { lit: 1, wheelA: 0 }); g.restore();
  clearC();
  // 手与帽：先举在太阳前，C+1.5 起三张放到胸前（8 fps）
  const k = f - (FC + Math.round(1.5 * FPB)), st = k < 0 ? 0 : k < 3 ? 1 : k < 6 ? 2 : 3;
  const smile = f >= df(2) ? (f >= df(2) + 3 ? 'smileopen' : 'smile') : (lf < 4 ? 'surprised' : 'upward');
  cg.save(); cg.translate(1080, 400); cg.scale(-2.05, 2.05); LWK.k = .8;
  longBack(cg, P, { ph: tc * .7, wind: .7, rim, len: .85 });
  bust(cg, P, { view: 'q', rim, neck: true });
  head(cg, P, { view: 'q', expr: smile, E: smile.startsWith('smile') ? {} : EYE_KEEP, ph: tc * .7, wind: .8, rim, skinRim: RIM, neck: false, lockRim: false });
  // 帽子位置（局部坐标）
  const HP = [[270, -150, -.25, .5], [230, 40, .2, .3], [140, 200, .6, .1], [60, 270, .82, 0]][st];
  const SH = [140, 196];
  // 手臂
  const handA = [HP[0] + 40, HP[1] + 40];
  // 叠放顺序：手臂（带袖口）→ 草帽 → 手（手指压在帽檐上，帽子真的「在手里」；胸前那一张帽子盖住前臂）
  const el = arm(cg, P, SH, handA, { rim });
  cg.save(); cg.translate(HP[0], HP[1]); hat(cg, PAL.backlit, { q: HP[2], rot: HP[3], s: .78, ph: tc * .8, wind: .4, rim: { c: RIM, d: [2, 2] } }); cg.restore();
  hand(cg, P, handA[0], handA[1], Math.atan2(handA[1] - el[1], handA[0] - el[0]), 1.1, { rim });
  if (st === 3) hand(cg, P, HP[0] - 110, HP[1] + 20, Math.PI * .1, 1.05, { rim });   // 另一只手扶住帽檐
  LWK.k = 1; cg.restore();
  // 光带三次扫过（C+1、C+3、C+5，各 10 帧，逐帧移动）
  for (const bk of [1, 3, 5]) { const b0 = df(bk), u = (f - b0) / 10; if (u >= 0 && u <= 1) lightBands(lerp(300, 1700, u), 150, -.6, '#ffe6b8', .5); }
  if (lf < 2) { g.restore(); e.restore(); impact(g, e, 640, 300, lf); return { bloom: .5 }; }
  g.drawImage(cc, 0, 0); stamp(e);
  g.restore(); e.restore();
  flare(e, 500 + sx, 300 + sy, 1.3, '#ffc078', { streak: 1000, ghostA: .9 });
  // 光带同时在发光板上闪一下
  for (const bk of [1, 3, 5]) { const u = (f - df(bk)) / 10; if (u >= 0 && u <= 1) { e.save(); e.translate(lerp(300, 1700, u), 540); e.rotate(-.6); e.fillStyle = 'rgba(255,220,160,.12)'; e.fillRect(-90, -1400, 180, 2800); e.restore(); } }
  return { bloom: 1.0, halo: .3 };
}

// ================= S8 首尾呼应：同一海岸，夕阳色指定；电车远去；摇臂上升；标题 =================
export function sunsetShot({ t, f, g, e, A }) {
  const lf = f - df(6), u = lf / (A.END_F - df(6));
  const cam = { x: 1560, y: lerp(70, -95, eio(u)), z: lerp(1.06, 1.0, ss(u)), t };
  coast(g, e, A, 'sunset', cam, (S, z) => {
    const tc = two(t);
    const tx = 2380 + lf / FPS * 300;
    g.save(); const [px, py] = S(tx, LAND.rail + 14); g.translate(px, py); g.scale(.46 * z, .46 * z); tram(g, e, PAL.sunset, { lit: 1, wheelA: tc * 6 }); g.restore();
    // 少女：慢慢骑到路边（近侧路肩），C+8 停下、单脚撑地；帽子戴回头上，帽檐描一道薄荷绿强调色边缘光
    const fs = two(t) * FPS, u = clamp((fs - df(6)) / (df(8) - df(6))), ride = u - u * u / 2;
    const gxw = 2236 - 200 * (1 - u) * (1 - u);
    const fdn = f < df(8) - 3 ? 0 : f < df(8) ? .55 : 1, bob = f >= df(8) && f < df(8) + 3 ? 7 : 0;
    const [sx, sy] = S(gxw, LAND.road1 + 14);
    clearC(); cg.translate(sx, sy); cg.scale(.22 * z, .22 * z);
    rider(cg, PAL.sunset, { crank: .4 + ride * 7, wheelA: ride * 6, speed: (1 - u) * .3, ph: tc * .5, wind: .25, hairWind: .35, expr: 'smile', turn: 0, footDown: fdn, bob,
      hatRim: { c: '#9ff8e8', d: [16, 12] } });
    g.drawImage(cc, 0, 0); stamp(e);
  });
  { const z = cam.z, sxp = (1830 - 1000 - cam.x * .25 - 960) * z + 960, syp = (870 - 440 - cam.y * .25 - 540) * z + 540; flare(e, sxp, syp, lerp(1.1, .78, seg(f, df(7) - 8, df(7) - 2)), '#ff9a4a', { streak: lerp(1200, 820, seg(f, df(7) - 8, df(7) - 2)), ghostA: .6 }); }   // 标题上屏前夕阳闪光收一点，别压字
  // 白闪（切入时）
  if (lf < 5) { g.fillStyle = rgba('#fffaf0', [.92, .7, .45, .22, .08][lf]); g.fillRect(0, 0, W, H); }
  title(g, e, f);
  return {};
}

// —— 片尾标题：镀铬渐变、深色 + 霓虹描边、12 fps 闪亮、光扫、星芒 ——
export const TITLE = { text: '追电车的夏天', sub: 'CHASING THE SUMMER TRAM', x: 1010, y: 290, size: 150 };
function title(g, e, f) {
  const fT = df(7), on = f - fT;
  // 闪亮：D7 前 6 帧以 12 fps 闪（开/关/开…），D7 完全点亮
  if (on < -6) return;
  if (on < 0 && [1, 0, 1, 0, 1, 1][on + 6] === 0) return;
  const a = on < 0 ? .75 : 1;
  tg.setTransform(1, 0, 0, 1, 0, 0); tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, W, H);
  for (const [ctx, pass] of [[tg, 0], [e, 1]]) {
    ctx.save(); ctx.translate(TITLE.x, TITLE.y); ctx.transform(1, 0, -.18, 1, 0, 0);
    ctx.font = `900 ${TITLE.size}px NSC`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.globalAlpha = a;
    if (pass === 0) {
      ctx.strokeStyle = '#ff4fa8'; ctx.lineWidth = 26; ctx.strokeText(TITLE.text, 0, 0);
      ctx.strokeStyle = '#1a0c30'; ctx.lineWidth = 16; ctx.strokeText(TITLE.text, 0, 0);
      const gr = ctx.createLinearGradient(0, -70, 0, 70);
      gr.addColorStop(0, '#7fd6ff'); gr.addColorStop(.42, '#e8f6ff'); gr.addColorStop(.5, '#ffffff'); gr.addColorStop(.53, '#5a3a9a'); gr.addColorStop(.72, '#ff6aa8'); gr.addColorStop(1, '#ffd36a');
      ctx.fillStyle = gr; ctx.fillText(TITLE.text, 0, 0);
      // 光扫：落定后先让字完全清楚 6 帧，再从左到右扫一遍（D7+6 → D7+21），字面上亮度 ≤ 0.5
      if (on >= 6 && on < 22) {
        ctx.save(); ctx.globalCompositeOperation = 'source-atop';
        const lx = lerp(-700, 700, (on - 6) / 15); ctx.fillStyle = 'rgba(255,255,255,.42)'; ctx.fillRect(lx - 40, -100, 80, 200); ctx.restore();
      }
    } else {
      ctx.strokeStyle = 'rgba(255,90,170,.32)'; ctx.lineWidth = 30; ctx.strokeText(TITLE.text, 0, 0);
      ctx.fillStyle = 'rgba(255,230,240,.16)'; ctx.fillText(TITLE.text, 0, 0);
    }
    ctx.font = 'italic 900 40px Kanit'; ctx.letterSpacing = '10px';
    if (pass === 0) { ctx.strokeStyle = '#1a0c30'; ctx.lineWidth = 8; ctx.strokeText(TITLE.sub, 0, 128); ctx.fillStyle = '#fff1c8'; ctx.fillText(TITLE.sub, 0, 128); }
    else { ctx.fillStyle = 'rgba(255,200,120,.25)'; ctx.fillText(TITLE.sub, 0, 128); }
    ctx.restore();
  }
  g.drawImage(tmp, 0, 0);
  // 星芒：落定时与 C+12
  // 星芒锚在「天」字右上角之外（标题右端外、字顶以上），不压任何一个字
  for (const [fs, x, y] of [[fT, TITLE.x + 590, TITLE.y - 120], [df(12), TITLE.x + 590, TITLE.y - 120]]) {
    const k = f - fs; if (k >= 0 && k < 12) flare(e, x, y, .55 * (1 - k / 12) + .15, '#ffffff', { streak: 420, ghosts: false, spikes: 4, rot: .78 });
  }
}
export const SHOT_FN = { coast: coastShot, side: sideShot, bust: bustShot, eyes: eyesShot, hat: hatShot, freeze: freezeShot, catch: catchShot, sunset: sunsetShot };
