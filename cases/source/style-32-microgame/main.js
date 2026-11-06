// 组装：舞台 ↔ 电视推拉 ↔ 各关画材，BOSS 拼接，结尾入夜；导出 render / EV / TEXTS
import { FPS, SEGS, S, NF, DUR, BEATS, PUSH, SHRINK, bf, hf } from './timeline.js';
import { canvas, W, H } from './media.js';
import { drawStage, TV, TVC, HOST, stamp } from './stage.js';
import { command, banner, fuse } from './hud.js';
import { PAL, INK, star } from './toon.js';
import { game1, sceneCrayon } from './g_crayon.js';
import { game2, pixelOverlay, heroPixel, cloudPixel } from './g_pixel.js';
import { game3, clearPlates, heroRisoBody, printPlates } from './g_riso.js';
import { game4, clearInk, inkLayers, flood, printInk, heroInk, pompom, room } from './g_ink.js';
import { boss } from './g_boss.js';
import { clamp, lerp, eo, ei, eio, back, hash, mulberry, TAU } from '/core/lib.js';

const cv = document.getElementById('c'); cv.width = W; cv.height = H;
const C = cv.getContext('2d');
const GAME = canvas(), G = GAME.getContext('2d');
const Q = new URLSearchParams(location.search);
window.DUR = DUR;

const GAMES = { g1: game1, g2: game2, g3: game3, g4: game4, boss };
const nextGame = id => { const i = SEGS.findIndex(s => s.id === id); return SEGS.slice(i + 1).find(s => s.kind === 'game'); };
const prevGame = id => { const i = SEGS.findIndex(s => s.id === id); return SEGS.slice(0, i).reverse().find(s => s.kind === 'game'); };
const HOLD = { 11: 6, 10: 5, 9: 4 };   // 指令停留帧数随加速缩短

// 画一关到 GAME（含 HUD：引信 + 指令角标）。hud 0..1 透明度
function renderGame(sg, lf, hud = 1) {
  G.setTransform(1, 0, 0, 1, 0, 0); G.globalAlpha = 1; G.globalCompositeOperation = 'source-over'; G.filter = 'none';
  if (sg.id === 'boss' && lf < 0) G.clearRect(0, 0, W, H); else { G.fillStyle = '#000'; G.fillRect(0, 0, W, H); }
  GAMES[sg.id](G, lf, sg.fpb);
  let box = null;
  if (hud > 0) {
    G.save(); G.globalAlpha = hud;
    if (sg.id !== 'boss') fuse(G, sg.beats, lf / sg.fpb);
    if (sg.id === 'boss') { if (lf >= sg.fpb) box = command(G, sg.cmd, lf - sg.fpb, { hold: HOLD[9], size: 170, y0: 640 }); }
    else box = command(G, sg.cmd, lf, { hold: HOLD[sg.fpb] });
    // BOSS! 在第 0.5 拍起飞出、第 1 拍（指令砸下）前完全离开——一次只有一张横幅
    if (sg.id === 'boss' && lf < sg.fpb) banner(G, 'BOSS!', lf, { out: sg.fpb / 2, fly: sg.fpb / 2, size: 230, y: 400 });
    G.restore();
  }
  return box;
}
// 测试画面（开场电视里）
function colorBars(c) { const cols = [PAL.cream, PAL.gold, PAL.cyan, '#3fe08a', PAL.magenta, PAL.fail, '#3d6fd1']; for (let i = 0; i < 7; i++) { c.fillStyle = cols[i]; c.fillRect(TV.x + i * TV.w / 7, TV.y, TV.w / 7 + 1, TV.h * .75); } c.fillStyle = INK; c.fillRect(TV.x, TV.y + TV.h * .75, TV.w, TV.h * .25); }
const screenFrom = canvasImg => c => c.drawImage(canvasImg, TV.x, TV.y, TV.w, TV.h);

// 彩纸（确定性粒子）
function confetti(c, k) {
  const R = mulberry(9);
  for (let i = 0; i < 90; i++) { const a = -Math.PI / 2 + (R() - .5) * 2.6, sp = 700 + R() * 900, x = TVC.x + Math.cos(a) * sp * k, y = TVC.y - 60 + Math.sin(a) * sp * k + 900 * k * k, col = [PAL.gold, PAL.magenta, PAL.cyan, PAL.ok, PAL.cream][i % 5];
    c.save(); c.translate(x, y); c.rotate(k * 12 * (R() - .5) + i); c.scale(1, Math.cos(k * 20 + i)); c.fillStyle = col; c.fillRect(-12, -7, 24, 14); c.restore(); }
}
function zzz(c, k, x, y) { c.save(); c.font = '80px TitanOne'; c.textAlign = 'center'; c.lineJoin = 'round';
  for (let i = 0; i < 3; i++) { const u = (k * 1.3 + i * .33) % 1, a = Math.sin(Math.PI * u); c.globalAlpha = a; const s = .6 + u * .7;
    c.save(); c.translate(x + 30 * i + Math.sin(u * 6) * 20, y - u * 220); c.scale(s, s); c.lineWidth = 12; c.strokeStyle = INK; c.strokeText('Z', 0, 0); c.fillStyle = PAL.cream; c.fillText('Z', 0, 0); c.restore(); }
  c.restore(); }

// 舞台状态
function stageState(f) {
  const t = f / FPS, sg = SEGS.find(s => f >= s.f0 && f < s.f1) || SEGS[SEGS.length - 1];
  let bi = 0, ph = 0; for (let i = BEATS.length - 1; i >= 0; i--) if (f >= BEATS[i].f) { bi = i; ph = (f - BEATS[i].f) / SEGS.find(s => s.id === BEATS[i].seg).fpb; break; }
  const host = { t, hop: ph, tilt: bi % 2 ? .6 : -.6, mode: 'tick', ring: 0, press: 0, eyes: 'open', mouth: 'smile' };
  // 主持表演
  const ring0 = Math.max(0, 1 - f / 10);
  if (f < 12) { host.ring = ring0 > 0 ? 1 : 0; host.eyes = 'wide'; host.mouth = 'o'; host.mode = 'cheer'; }
  for (const k of ['s0_button', 's1_button']) { const d = f - hf(k); if (d >= -3 && d < 6) host.press = d < 0 ? eo((d + 3) / 3) : d < 3 ? 1 : 1 - (d - 3) / 3; }
  const dc = f - hf('s2_crack'); if (dc >= 0 && dc < 14) { host.flinch = Math.exp(-dc / 5); host.eyes = 'wide'; host.mouth = 'o'; }
  if (f >= hf('s2_crack') && f < S.s2.f1) { host.eyes = 'wide'; host.mouth = 'o'; }
  if (f >= hf('s3_speed') && f < S.s3.f1) { host.ring = .6; host.mode = 'cheer'; host.eyes = 'happy'; host.mouth = 'grin'; }
  if (f >= hf('s4_cut') && f < S.s4.f1) { host.mode = 'stop'; host.hop = 0; host.tilt = .6; host.eyes = 'wide'; host.mouth = 'flat'; }
  if (f >= S.end.f0) { const d = f - S.end.f0; host.mode = d < 9 ? 'cheer' : 'stop'; host.ring = d < 9 ? 1 - d / 9 * .5 : 0;
    host.eyes = d < 9 ? 'happy' : 'shut'; host.mouth = d < 9 ? 'grin' : d < 18 ? 'yawn' : 'smile'; host.hop = d < 9 ? ph : 0; }
  // 生命
  const crack = f >= hf('s2_crack') ? clamp((f - hf('s2_crack')) / 12) : 0, lives = f >= hf('s2_crack') ? 2 : 3;
  // 关卡牌
  let badge = '第1关', flip = 0;
  const flips = [['s1_button', '第2关'], ['s2_crack', '第3关'], ['s3_speed', '第4关'], ['s4_stamp', 'BOSS'], ['end_snap', '通关']];
  for (const [k, txt] of flips) { const d = f - hf(k); if (d >= -3) { badge = d < 0 ? badge : txt; if (d < 3) flip = (d + 3) / 6; } }
  return { t, beat: bi, host, lives, crack, badge, badgeFlip: flip, night: 0, pulse: ph < .2 ? 1 - ph / .2 : 0 };
}

// 相机：z=1 舞台全景；z=2.5 屏幕满画幅
function camSet(z, cx, cy) { C.setTransform(z, 0, 0, z, 960 - cx * z, 540 - cy * z); }
const pushCam = u => ({ z: lerp(1, 2.5, u), cx: lerp(960, TVC.x, u), cy: lerp(540, TVC.y, u) });

let TEXTS_NOW = [];
function render(t) {
  const f = Math.round(t * FPS), sg = SEGS.find(s => f >= s.f0 && f < s.f1) || SEGS[SEGS.length - 1];
  const texts = [];
  C.setTransform(1, 0, 0, 1, 0, 0); C.globalAlpha = 1; C.globalCompositeOperation = 'source-over'; C.filter = 'none';
  C.fillStyle = PAL.violet; C.fillRect(0, 0, W, H);

  if (sg.kind === 'game' && sg.id === 'boss') {
    // BOSS：满屏（不在电视里），开头两半撞进来
    renderGame(sg, f - sg.f0, 1); C.drawImage(GAME, 0, 0);
    const box = commandBox(sg, f - sg.f0); if (box) texts.push(box);
    const sh = f - sg.f0 < 5 ? Math.sin((f - sg.f0) * 2.2) * 22 * (1 - (f - sg.f0) / 5) : 0;
    if (sh) { C.save(); C.globalCompositeOperation = 'copy'; C.drawImage(cv, sh, -sh * .5); C.restore(); }
  } else if (sg.kind === 'game') {
    const lf = f - sg.f0, shr = f - (sg.f1 - SHRINK);
    if (shr < 0) { // 满屏
      const box = renderGame(sg, lf, 1); C.drawImage(GAME, 0, 0); if (box) texts.push(box);
    } else {       // 缩回电视
      const u = eo(clamp((shr + 1) / SHRINK)); renderGame(sg, lf, 1 - u);
      const st = stageState(f); st.screen = screenFrom(GAME);
      const cam = pushCam(1 - u); camSet(cam.z, cam.cx, cam.cy); drawStage(C, st);
    }
  } else {
    stageFrame(f, sg, texts);
  }
  TEXTS_NOW = texts;
}
function commandBox(sg, lf) { // TEXTS 用：指令在本关全程以完整文字报告
  if (sg.id === 'boss') return lf >= sg.fpb ? { id: 'cmd', text: sg.cmd, x0: 60, y0: 60, x1: 600, y1: 170 } : null;
  return { id: 'cmd', text: sg.cmd, x0: 60, y0: 60, x1: 480, y1: 170 };
}

function stageFrame(f, sg, texts) {
  const st = stageState(f), lfS = f - sg.f0, ng = nextGame(sg.id), pg = prevGame(sg.id);
  // 电视里的内容
  let scr = null;
  const pushStart = sg.f1 - PUSH;
  if (sg.id === 's0' && f < pushStart) scr = colorBars;
  else if (ng && f >= pushStart && sg.id !== 's4') { renderGame(ng, 0, 0); scr = screenFrom(GAME); }
  else if (pg) { renderGame(pg, pg.f1 - pg.f0 - 1, 0); scr = screenFrom(GAME); }
  st.screen = scr;
  if (ng && Math.abs(f - pushStart) < 2 && sg.id !== 's4') st.flick = 1 - Math.abs(f - pushStart) / 2;
  // 印章：上一关结果在第 0 拍砸上
  if (pg && sg.id !== 'end' && !(ng && f >= pushStart && sg.id !== 's4')) { const p = (f - (sg.f0 - 2)) / 2; st.stamp = { kind: pg.id === 'g2' ? 'fail' : 'ok', p: clamp(p, 0, 1) }; }
  // 相机
  let z = 1, cx = 960, cy = 540;
  if (ng && f >= pushStart && sg.id !== 's4') { const c = pushCam(ei((f - pushStart + 1) / PUSH)); z = c.z; cx = c.cx; cy = c.cy; }
  if (sg.id === 's3') { const d = f - hf('s3_speed'); if (d >= 0 && f < pushStart) z *= 1 + .1 * Math.exp(-d / 4); }   // 冲击变焦
  if (sg.id === 's4' && f >= hf('s4_cut')) { const u = eio(clamp((f - hf('s4_cut')) / (S.s4.f1 - hf('s4_cut')))); z = lerp(1, 1.45, u); cx = lerp(960, 1380, u); cy = lerp(540, 560, u); }
  if (sg.id === 'end') { // 一拍拉回全景（带回弹），舞台入夜
    const d = f - sg.f0; const u = clamp((d + 1) / 4); z = d < 4 ? lerp(2.5, .94, eo(u)) : lerp(.94, 1, eo(clamp((d - 3) / 4)));
    const k = clamp((d + 1) / 4); cx = lerp(TVC.x, 960, eo(k)); cy = lerp(TVC.y, 540, eo(k));
    renderGame(S.boss, S.boss.f1 - S.boss.f0 - 1, 0); st.screen = screenFrom(GAME);
    st.night = clamp(d / 12); st.bulbs = d >= 0;
    st.preInk = c => { clearInk(); flood(inkLayers().dr, TVC.x, TVC.y, clamp((d + 2) / 16), 1900, 4); c.save(); c.globalAlpha = .85; printInk(c, false); c.restore(); };
    st.stamp = { kind: 'done', p: clamp((d + 1) / 2) };
  }
  camSet(z, cx, cy);
  drawStage(C, st);
  // 舞台灯灭：一束顶光
  if (sg.id === 's4' && f >= hf('s4_cut')) {
    C.save(); C.setTransform(1, 0, 0, 1, 0, 0);
    const hx = (HOST.x - cx) * z + 960, hy = (HOST.y - cy) * z + 540;
    const g = C.createRadialGradient(hx, hy - 60 * z, 60 * z, hx, hy, 420 * z); g.addColorStop(0, 'rgba(6,3,18,0)'); g.addColorStop(.7, 'rgba(6,3,18,.55)'); g.addColorStop(1, 'rgba(6,3,18,.86)');
    C.fillStyle = g; C.fillRect(0, 0, W, H);
    C.globalAlpha = .16; C.fillStyle = '#fff6d8'; C.beginPath(); C.moveTo(hx - 70 * z, -10); C.lineTo(hx + 70 * z, -10); C.lineTo(hx + 300 * z, hy + 320 * z); C.lineTo(hx - 300 * z, hy + 320 * z); C.closePath(); C.fill();
    C.restore();
    // BOSS 两半从画外撞进来（最后 6 帧）
  }
  if (sg.id === 's4' && f >= S.s4.f1 - 6) { renderGame(S.boss, f - S.boss.f0, 0); C.setTransform(1, 0, 0, 1, 0, 0); C.drawImage(GAME, 0, 0); }
  // 开场：灯一下亮（≤ 60 % 白闪）
  if (f < 4) { C.save(); C.setTransform(1, 0, 0, 1, 0, 0); C.globalAlpha = .55 * (1 - f / 4); C.fillStyle = '#fff'; C.fillRect(0, 0, W, H); C.restore(); }
  // 横幅
  C.save(); C.setTransform(1, 0, 0, 1, 0, 0);
  if (sg.id === 's3') { const b = banner(C, 'SPEED UP!', f - hf('s3_speed'), { out: hf('s3_out') - hf('s3_speed') + 6, size: 175, y: 500 }); if (b) texts.push(b); }
  if (sg.id === 'end') { const d = f - sg.f0; if (d >= 0) confetti(C, clamp(d / 30)); if (d >= 14) zzz(C, (d - 14) / 24, HOST.x + 120, HOST.y - 180); texts.push({ id: 'done', text: '通关！', x0: 600, y0: 360, x1: 1050, y1: 580 }); }
  C.restore();
  texts.push({ id: 'badge', text: st.badge, x0: 1470, y0: 50, x1: 1850, y1: 190 });
}

// —— 事件表（拟音与核对）——
const EV = [];
const ev = (f, type, o = {}) => EV.push({ t: +(f / FPS).toFixed(6), f, type, ...o });
(function buildEV() {
  ev(0, 'ring', { dur: 10 / FPS }); ev(0, 'flash');
  for (const b of BEATS) { const s = S[b.seg]; if (s.kind !== 'stage') continue; if (b.seg === 's4' && b.i >= 1) continue; if (b.seg === 'end' && b.i >= 1) continue; ev(b.f, 'tick'); }
  for (const k of ['s0_button', 's1_button']) ev(hf(k), 'press');
  for (const s of SEGS) if (s.kind === 'game') {
    ev(s.f0, 'cmd', { seg: s.id, medium: s.medium });
    if (s.id !== 'boss') { ev(s.f0 - PUSH, 'push'); ev(s.f0 - PUSH, 'flick'); ev(s.f1 - SHRINK, 'shrink'); }
    const nx = SEGS[SEGS.indexOf(s) + 1]; if (s.id !== 'boss') ev(nx.f0, 'stamp', { kind: s.id === 'g2' ? 'fail' : 'ok' });
  }
  // g1 蜡笔
  ev(hf('g1_wobble'), 'leaves'); ev(hf('g1_drop'), 'appleFall', { dur: 2 * S.g1.spb });
  for (let fr = hf('g1_run'); fr < bf('g1', 3.5); fr += 3) ev(fr, 'step', { medium: 'crayon' });
  ev(hf('g1_catch'), 'catch'); ev(hf('g1_cheer'), 'cheer');
  // g2 像素
  ev(bf('g2', .3), 'cloudIn'); ev(bf('g2', .6), 'rain', { dur: (bf('g2', 3) - bf('g2', .6)) / FPS, heavy: 0 });
  ev(hf('g2_dash'), 'dash'); ev(hf('g2_zip'), 'zip'); ev(hf('g2_pour'), 'pour'); ev(hf('g2_pour'), 'rain', { dur: (S.g2.f1 - hf('g2_pour')) / FPS, heavy: 1 });
  ev(hf('g2_pour') + 4, 'wah'); for (const d of [0, 5]) ev(hf('g2_drip') + d, 'drip');
  // 舞台
  ev(hf('s2_crack'), 'crack');
  for (const k of ['s1_button', 's2_crack', 's3_speed', 's4_stamp']) ev(hf(k), 'flip');
  // g3 网印
  for (let i = 1; i <= 4; i++) { ev(bf('g3', i), 'brush', { dir: i % 2 ? -1 : 1 }); ev(bf('g3', i) + 3, 'foam'); }
  ev(hf('g3_shine'), 'shine');
  // SPEED UP
  ev(hf('s3_speed'), 'speed'); ev(hf('s3_out') + 6, 'bannerOut');
  // g4 水墨
  ev(hf('g4_crouch'), 'crouch'); ev(bf('g4', 1.6), 'jump'); ev(hf('g4_slap'), 'switch'); ev(hf('g4_slap'), 'flood', { dur: S.g4.spb * 1.2 });
  // 静默
  ev(hf('s4_cut'), 'cut'); ev(hf('s4_hb1'), 'hb'); ev(hf('s4_hb2'), 'hb');
  // BOSS
  ev(S.boss.f0 - 6, 'slideIn'); ev(hf('boss_slam'), 'slam'); ev(bf('boss', .5), 'bannerOut'); ev(bf('boss', 1), 'land'); ev(hf('boss_bonk'), 'bonk'); ev(hf('boss_bonk'), 'appleFall', { dur: S.boss.spb });
  ev(hf('boss_catch'), 'catch'); ev(hf('boss_slap'), 'switch'); ev(hf('boss_slap'), 'flood', { dur: S.boss.spb * 1.4 });
  // 结尾
  ev(hf('end_snap'), 'snap'); ev(hf('end_snap'), 'confetti'); ev(hf('end_snap'), 'claps'); ev(hf('end_ring'), 'ring', { dur: 9 / FPS }); ev(hf('end_yawn'), 'yawn'); ev(hf('end_sleep'), 'zzz');
  EV.sort((a, b) => a.f - b.f);
})();
window.EV = EV;
window.TEXTS = t => { render(t); return TEXTS_NOW; };

// —— 风格帧 / 模型表 ——
function modelSheet() {
  C.setTransform(1, 0, 0, 1, 0, 0); C.fillStyle = '#20202a'; C.fillRect(0, 0, W, H);
  const panel = (i, draw, label) => { draw(); C.drawImage(GAME, 480, 60, 960, 960, i * 480, 60, 480, 480); C.fillStyle = '#fff'; C.font = '40px ZQK, TitanOne'; C.fillText(label, i * 480 + 20, 600); };
  const reset = () => { G.setTransform(1, 0, 0, 1, 0, 0); G.fillStyle = '#000'; G.fillRect(0, 0, W, H); };
  panel(0, () => { reset(); sceneCrayon(G, { t: 0, boil: 0, cam: 0, hero: { x: 960, y: 905, arms: 'basket', eyes: 'happy', basketApple: true }, appleState: null }); }, '蜡笔');
  panel(1, () => { reset(); G.fillStyle = '#3d4f8f'; G.fillRect(0, 0, W, H); pixelOverlay(G, L => { heroPixel(L, 80, 75, {}); }); }, '像素');
  panel(2, () => { reset(); clearPlates(); heroRisoBody(960, 1000, 1, { l: [-140, -150], r: [140, -150] }, 'smile'); printPlates(G, [6, -4]); }, '网印');
  panel(3, () => { reset(); clearInk(); const h = heroInk({ x: 960, y: 960 }); printInk(G); pompom(G, h.hx, h.hy - 122, 26); }, '水墨');
  // 主持人
  const st = stageState(30); C.save(); C.translate(-700, 560); C.scale(.8, .8); C.restore();
}
window.render = t => {
  const sc = Q.get('scene');
  if (sc === 'model') return modelSheet();
  if (sc === 'g1' || sc === 'g2' || sc === 'g3' || sc === 'g4' || sc === 'boss') { const s = S[sc], lf = Math.round(t * FPS); renderGame(s, lf, 1); C.setTransform(1, 0, 0, 1, 0, 0); C.drawImage(GAME, 0, 0); return; }
  render(t);
};
document.fonts.load('100px ZQK', '接住躲开刷牙关灯通第').then(() => document.fonts.load('900 100px NSC', '接住躲开刷牙关灯＋！')).then(() => document.fonts.load('100px TitanOne', 'SPEEDUPBOS!Z0123')).then(() => document.fonts.ready).then(() => { window.READY = true; });
