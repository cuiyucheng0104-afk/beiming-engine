// 三打白骨精 — 皮影戏（Shadow Puppetry）
import { makeGL } from './gl.js';
import { canvas } from '/styles/shadow-puppet/demo/carve.js';
import { drawFrame, drawAudience, drawPillar } from '/styles/shadow-puppet/demo/stage.js';
import { silhouette, fistHand, pinchHand, lampBody, flame as lampFlame, smoke } from '/styles/shadow-puppet/demo/backstage.js';
import { clamp, lerp, seg, ss, eio, eo, ei, back, vnoise } from '/core/lib.js';
import { W, H, mul, T as tM, S as sM, R as rM, ap, set, camM, camK, layer, liftM, drawRods, rodEnds, rivets } from './rig.js';
import { build as buildW, drawWukong, soleY } from './wukong.js';
import { build as buildR, drawRobed, drawSkeleton, drawPile, drawCloudP, drawPaper } from './robed.js';
import { buildScenery, drawLand, groundY } from './scenery.js';
import { buildPlaques, drawSub } from './plaques.js';
import { T, DUR, SUBS, shotAt } from './story.js';
import { wkPose, tsPose, girlPose, cronePose, elderPose, liftFx } from './acting.js';

const qs = new URLSearchParams(location.search);
const [trc, tr] = canvas(W, H), [frc, fr] = canvas(W, H), [dmc, dm] = canvas(4, 4);
const GL = makeGL(document.getElementById('gl'));
await document.fonts.load('400 40px "Ma Shan Zheng"', '三打白骨精西游记皮影戏全剧终说悟空白虎岭夫人');
buildW(); buildR(); buildScenery(); const PL = buildPlaques();
const TEST = qs.get('test');
const testMod = TEST ? await import('./test.js') : null;

const E = (t, a, b) => ss(seg(t, a, b));
const win = (t, a, b, i = .15, o = .3) => Math.max(0, Math.min(seg(t, a, a + i), 1 - seg(t, b - o, b)));
const toW = (C, p) => [(p[0] - C[4]) / C[0], (p[1] - C[5]) / C[3]];
const LAMP = [960, 300], CORE = .8;

// ================= 灯（整个世界的光）=================
function coldAmt(t) {
  const w = (a, b) => E(t, a, a + 1.0) * (1 - E(t, b, b + 1.2));
  return Math.max(w(T.cold1, T.hit1), w(T.cold2, T.hit2), w(T.cold3, T.hit3));
}
const eyeAmt = t => Math.max(win(t, T.eye1, T.eye1 + 1.05, .12, .35), win(t, T.eye2, T.eye2 + .5, .08, .2), win(t, T.eye3, T.eye3 + .65, .1, .25));
const xrayGirl = t => E(t, T.xray1, T.xray1 + .7) * (1 - E(t, T.xray1Off, T.xray1Off + .45));
const xrayCrone = t => win(t, T.xray2, T.xray2 + .55, .12, .22);
const xrayElder = t => win(t, T.xray3, T.xray3 + .6, .12, .25);
const spellPulse = t => t > T.spell[0] + .2 && t < T.spell[1] ? Math.pow(.5 + .5 * Math.cos((t - T.spell[0]) / (.46 - .07 * seg(t, T.spell[0], T.spell[1])) * Math.PI * 2), 3) * E(t, T.spell[0], T.spell[0] + .6) * (1 - E(t, T.spell[1] - .4, T.spell[1])) : 0;
const flashAmt = t => [[T.hit1, .8], [T.hit2, .6], [T.hit3, 1.6]].reduce((a, [h, k]) => a + (t >= h ? k * Math.exp(-(t - h) * 7) : 0), 0);
function lampMain(t) {
  if (t < T.match) return 0;
  if (t < T.lampOn) return .05 * (1 + Math.sin(t * 60)) * seg(t, T.match, T.match + .08);
  const u = t - T.lampOn; let I = u < .45 ? lerp(.1, 1, eo(u / .45)) + .35 * Math.sin(u / .45 * Math.PI) : 1;
  const c = coldAmt(t);
  I *= (1 - .22 * c) * (1 + (.06 + .16 * c) * (vnoise(t * 7) - .5) * 2 + .03 * Math.sin(t * 23));
  I *= 1 + .3 * spellPulse(t);
  I *= 1 + flashAmt(t);
  if (t > T.wkGone2 - .4 && t < T.wkGone2 + .6) I *= 1 + .35 * Math.sin(seg(t, T.wkGone2 - .4, T.wkGone2 + .6) * Math.PI);  // 悟空融进灯里
  return Math.max(0, I);
}
function lightCols(t) {
  const c = coldAmt(t) * (1 - eyeAmt(t));
  const mix = (a, b, u) => a.map((v, i) => lerp(v, b[i], u));
  return { lcol: mix([1, .77, .46], [.64, .84, .86], .72 * c), hotcol: mix([1, .9, .62], [.82, .96, .95], .72 * c) };
}

// ================= 镜头 =================
const crash = (t, h, d = 5 / 24) => t < h ? 0 : back(seg(t, h, h + d), 1.3) * (1 - E(t, h + .35, h + 1.3));
function wkEyeW(t) { const p = wkPose(t); const r = drawWukong(dm, [1, 0, 0, 1, 0, 0], p); return r.eye; }
function camRaw(t) {
  const [t0, t1, n] = shotAt(t), u = (t - t0) / (t1 - t0);
  switch (n) {
    case 'house': return [960, 560, lerp(.72, .8, eio(u))];
    case 'ridge': { const a = E(t, 7.8, 9.4), b = E(t, 9.4, 13.2); return [lerp(960, 760, b), lerp(lerp(560, 540, a), 575, b), lerp(lerp(.8, 1.0, a), 1.12, b)]; }
    case 'cloud': return [lerp(760, 900, eio(u)), lerp(575, 470, eio(u)), 1.12];
    case 'girl': { const pull = E(t, 20.9, 22.0), pan = E(t, 16.4, 18.6); return [lerp(lerp(900, 1047, pan), 960, pull), lerp(560, 540, pull), lerp(1.1, 1.0, pull)]; }
    case 'land': return [960, 540, 1.0];
    case 'eye': { const e = wkEyeW(Math.min(t, T.eye1 + .1)), z = lerp(2.2, 4.3, back(seg(t, t0, t0 + 5 / 24), 1.2)) + E(t, t0 + .3, t1) * .25; return [e[0] - 18, e[1] + 22, z]; }
    case 'xray': { const g = girlPose(t0), out = E(t, 26.25, 27.1); return [lerp(g.x - 10, 990, out), lerp(g.y - 300, 600, out), lerp(lerp(1.95, 2.1, E(t, t0, 26.2)), 1.3, out)]; }
    case 'strike1': return [990, 600, 1.3 + .3 * crash(t, T.hit1)];
    case 'scold': return [lerp(730, 745, u), 610, lerp(1.35, 1.45, eio(u))];
    case 'crone': return [960, 540, 1.0];
    case 'spell': return [840, 640, 1.45 + .04 * spellPulse(t)];
    case 'elder': return [lerp(960, 1000, eio(u)), 545, 1.05];
    case 'choice': return [985, 600, lerp(1.35, 1.52, E(t, T.silence, T.raise[1]))];
    case 'kill': return [1080, 612, 1.5 + .32 * crash(t, T.hit3)];
    case 'bones': return [lerp(1265, 1272, u), lerp(835, 848, u), lerp(2.15, 2.5, eio(u))];
    case 'expel': return [lerp(690, 705, u), 610, lerp(1.35, 1.43, eio(u))];
    case 'farewell': {
      const up = E(t, 78.0, 79.4), back2 = E(t, 79.5, 80.6);
      return [lerp(lerp(760, 900, up), 700, back2), lerp(lerp(595, 480, up), 600, back2), lerp(lerp(1.25, 1.1, up), 1.2, back2)];
    }
    case 'truck': { const pull = E(t, 80.6, 81.15), tk = ei(seg(t, 81.15, 81.95)); return [lerp(700, 960, pull) + tk * 1540, lerp(600, 560, pull), lerp(1.2, .72, pull)]; }
    default: return [960, 560, .8];
  }
}
function shake(t) { return [[T.hit1, 1], [T.hit2, .7], [T.hit3, 1.8]].reduce((a, [h, k]) => a + (t >= h ? k * Math.exp(-(t - h) * 5) : 0), 0) + .35 * spellPulse(t); }
function camAt(t) {
  const c = camRaw(t), n = shotAt(t)[2], s = shake(t);
  c[0] += (vnoise(t * 31) - .5) * 16 * s / c[2]; c[1] += (vnoise(t * 29 + 7) - .5) * 12 * s / c[2];
  if (c[2] >= 1 && !['house', 'truck', 'end', 'back'].includes(n)) { c[0] = clamp(c[0], 960 / c[2], 1920 - 960 / c[2]); c[1] = clamp(c[1], 540 / c[2], 1080 - 540 / c[2]); }
  return c;
}

// ================= 画幕布（透射率画布）=================
const landUp = t => 1 - eo(seg(t, 7.1, 7.85));               // 景片由艺人从台下举上来
const introLift = t => 1 - eo(seg(t, 7.8, 8.4));            // 人物压上布
function drawDemon(t, C, who, p, xr, hitT, info) {
  const k = camK(C);
  if (p.vis >= .5) {
    const fx = liftFx(p.lift, k), c = ap(C, p.x, p.y - 220);
    layer(tr, g => {
      const r = drawRobed(g, liftM(C, c, fx.s), who, p, { t }); rivets(g, r.riv, r.K);
      if (!info.noRods) drawRods(g, r.rods, rodEnds(r.rods, r.K, -1), 2.4 * k, .6);
      info[who] = r;
    }, { blur: fx.blur, alpha: fx.alpha * (1 - .42 * xr) });
    if (xr > .01) {
      layer(tr, g => drawSkeleton(g, C, { ...p, fall: 0 }), { blur: (1 - xr) * 16 * k, alpha: Math.min(1, xr * 1.4) });
      info.xrayW = [p.x, p.y - 300];
    }
  }
  // 解尸法：白骨真身从倒下的假身里离布逃走
  if (hitT && t > hitT + .06 && t < hitT + 1.6) {
    const u = seg(t, hitT + .06, hitT + 1.55), p0 = { ...p, fall: 0, lean: 0, x: p.x + eo(u) * 170, y: p.y - eo(u) * 250 };
    const c = ap(C, p0.x, p0.y - 250);
    layer(tr, g => drawSkeleton(g, liftM(C, c, 1 + u * 1.1), p0), { blur: u * 30 * k, alpha: 1 - ei(u) });
  }
}
function drawScreen(t, C, opt = {}) {
  tr.setTransform(1, 0, 0, 1, 0, 0); tr.fillStyle = '#fff'; tr.fillRect(0, 0, W, H);
  const k = camK(C), info = { noRods: opt.noRods };
  const lu = landUp(t);
  if (t >= 7.1 && !opt.noLand) drawLand(tr, mul(C, tM(0, lu * 420)));
  // 片名牌
  if (t >= T.titleIn && t < T.titleOut + .9) {
    const up = eo(seg(t, T.titleIn, T.titleSet)), off = seg(t, T.titleOut, T.titleOut + .8);
    const sc = 1.1 * (1 + ei(off) * .7), y = lerp(1300, 470, up) - off * 30;
    layer(tr, g => { set(g, mul(C, mul(tM(960, y), sM(sc)))); g.globalCompositeOperation = 'multiply'; g.drawImage(PL.title.c, PL.title.x0, PL.title.y0, PL.title.w, PL.title.h);
      if (off < .3) { const r = [[-420, 190], [420, 190]].map(([a, b]) => ap(C, 960 + a * sc, y + b * sc)); drawRods(g, r, r.map(p => [p[0] - 60 * k, p[1] + 900]), 2.4 * k, .6); } }, { blur: off * 30 * k, alpha: 1 - ei(off) });
  }
  if (opt.endPlaque) {
    const up = eo(seg(t, T.endIn, T.endIn + 1.0)), y = lerp(1250, 470, up);
    layer(tr, g => { set(g, mul(C, tM(960, y))); g.globalCompositeOperation = 'multiply'; g.drawImage(PL.end.c, PL.end.x0, PL.end.y0, PL.end.w, PL.end.h);
      const r = [[-400, 200], [400, 200]].map(([a, b]) => ap(C, 960 + a, y + b)); drawRods(g, r, r.map(p => [p[0] - 60 * k, p[1] + 900]), 2.4 * k, .6); });
  }
  if (opt.endPlaque || t < 7.1) return info;
  // 白骨堆（第三打之后一直在）
  if (t >= T.hit3 + .15) { const a = E(t, T.hit3 + .15, T.hit3 + .65); layer(tr, g => drawPile(g, C, 1200, groundY(1200) + 6, 1.25), { alpha: a, blur: (1 - a) * 14 * k }); }
  // 贬书
  if (t >= T.paperFall[0]) {
    const h0 = toW([1, 0, 0, 1, 0, 0], drawRobed(dm, [1, 0, 0, 1, 0, 0], 'tang', tsPose(T.paperFall[0])).hand), u = seg(t, T.paperFall[0], T.paperFall[1]);
    const x = lerp(h0[0], 700, u) + Math.sin(u * 9) * 26 * (1 - u), y = lerp(h0[1], groundY(700) - 30, Math.pow(u, 1.35)), rot = Math.sin(u * 8) * .7 * (1 - u) + u * 1.5;
    drawPaper(tr, C, x, y, rot, .95);
  }
  // 唐僧
  { const p = tsPose(t), il = introLift(t), fx = liftFx(il, k), c = ap(C, p.x, p.y - 250);
    layer(tr, g => { const r = drawRobed(g, liftM(C, c, fx.s), 'tang', p, { t }); rivets(g, r.riv, r.K); if (!opt.noRods) drawRods(g, r.rods, rodEnds(r.rods, r.K, p.flip), 2.4 * k, .6); info.ts = r;
      if (p.paper >= .5) { const hw = toW(C, r.hand); drawPaper(g, C, hw[0] + 6, hw[1] + 10, .1, .95); } }, { blur: fx.blur, alpha: fx.alpha }); }
  // 白骨精三变
  if (t > T.girlIn - .1 && t < T.corpse1Off + 1) drawDemon(t, C, 'girl', girlPose(t), xrayGirl(t), T.hit1, info);
  if (t > T.croneIn - .1 && t < T.corpse2Off + 1) drawDemon(t, C, 'crone', cronePose(t), xrayCrone(t), T.hit2, info);
  if (t > T.elderIn - .1 && t < T.hit3) drawDemon(t, C, 'elder', elderPose(t), xrayElder(t), null, info);
  if (t >= T.hit3 && t < T.hit3 + 1.5) {       // 第三打：老翁在铆钉处散架，白骨立不住，塌成一堆
    const p = elderPose(T.hit3), u = t - T.hit3;
    layer(tr, g => drawRobed(g, C, 'elder', p, { explode: { u, seed: 3 } }), { blur: Math.min(24, u * 18) * k, alpha: 1 - seg(u, .45, 1.3) });
    const a = 1 - seg(u, .12, .6);
    if (a > 0) layer(tr, g => drawSkeleton(g, C, { ...p, fall: 0, lean: 0, y: p.y + ei(seg(u, .1, .6)) * 70, rot: seg(u, .1, .6) * .18 }), { alpha: a, blur: seg(u, .25, .6) * 6 * k });
  }
  // 悟空（+ 筋斗云）
  const wp = wkPose(t);
  if (wp.vis >= .5) {
    const lift = Math.max(wp.lift, introLift(t)), fx = liftFx(lift, k), c = ap(C, wp.x, wp.y - 80), Cl = liftM(C, c, fx.s);
    if (wp.cloud > .01) { const fy = wp.y + soleY(wp); layer(tr, g => drawCloudP(g, Cl, wp.x - 16, fy + 24, .92, 0, wp.flip < 0 ? -1 : 1), { blur: Math.max(fx.blur, (1 - wp.cloud) * 24 * k), alpha: fx.alpha * Math.min(1, wp.cloud * 1.5) }); }
    layer(tr, g => { const r = drawWukong(g, Cl, wp); info.wk = r; rivets(g, r.riv, r.K); if (!opt.noRods) drawRods(g, r.rods, rodEnds(r.rods, r.K, wp.flip), 2.4 * k, .6); }, { blur: fx.blur, alpha: fx.alpha });
    if (info.wk) { info.wkEyeW = toW(C, info.wk.eye); info.wkBandW = toW(C, info.wk.band); }
  }
  return info;
}
function lampsFor(t, info) {
  const L = [[LAMP[0], LAMP[1], lampMain(t), CORE]];
  const e = eyeAmt(t); if (e > 0 && info.wkEyeW) { L.push([info.wkEyeW[0], info.wkEyeW[1], 2.6 * e, -9]); L.push([info.wkEyeW[0], info.wkEyeW[1], .9 * e, -46]); }
  const x = Math.max(xrayGirl(t), xrayCrone(t), xrayElder(t)); if (x > 0 && info.xrayW) L.push([info.xrayW[0], info.xrayW[1], .75 * x, -150]);
  const b = spellPulse(t); if (b > 0 && info.wkBandW) L.push([info.wkBandW[0], info.wkBandW[1], 1.1 * b, -40]);
  return L;
}

// ================= 画一帧 =================
function render(t) {
  fr.setTransform(1, 0, 0, 1, 0, 0); fr.clearRect(0, 0, W, H); fr.globalAlpha = 1; fr.filter = 'none';
  if (TEST === 'model') { const o = testMod.modelSheet(tr, fr, qs.get('v') || '1'); GL.render(trc, frc, o); return; }
  if (TEST === 'poster') {       // 海报：第三回——唐僧、悟空举棒、老翁体内的白骨；上方片名
    const tp = 53.62, cam = [960, 560, 1.0], C = camM(cam), info = drawScreen(tp, C);
    fr.save(); fr.textAlign = 'center'; fr.textBaseline = 'middle';
    fr.shadowColor = 'rgba(40,16,6,.55)'; fr.shadowBlur = 14; fr.font = '400 112px "Ma Shan Zheng"'; fr.letterSpacing = '26px'; fr.fillStyle = '#3a160c'; fr.fillText('三打白骨精', 960, 120);
    fr.shadowBlur = 0; fr.font = '400 38px "Ma Shan Zheng"'; fr.letterSpacing = '12px'; fr.fillStyle = '#6a2a14'; fr.fillText('西游记  皮影戏', 960, 205); fr.restore();
    GL.render(trc, frc, { sigB: 700, sigC: 120, amb: .3, time: tp, vign: .45, sat: 1.1, contrast: .15, bloom: .3, ...lightCols(tp), cam, lamps: lampsFor(tp, info), expo: 1.72 }); return;
  }
  const [, , name] = shotAt(t);
  const base = { sigB: 700, sigC: 120, amb: .3, time: t, vign: .45, sat: 1.1, contrast: .15, bloom: .3, ...lightCols(t) };
  let o;
  if (name === 'back' || (name === 'truck' && t >= T.cutBack)) o = renderBack(t, base);
  else if (name === 'end') o = renderEnd(t, base);
  else {
    const cam = camAt(t), C = camM(cam);
    const info = drawScreen(t, C);
    const L = lampsFor(t, info), I0 = L[0][2];
    if (cam[2] < 1.02) drawFrame(fr, C, clamp(I0, 0, 1.4) / 1.2);
    if (name === 'house') drawAudience(fr, 1 - E(t, 5.8, 7.6), t);
    if (name === 'truck') { drawAudience(fr, E(t, 80.7, 81.1) * .9 * (1 - E(t, 81.2, 81.5)), t); drawPillar(fr, lerp(2700, 960, eo(seg(t, 81.15, T.cutBack)))); }
    o = { ...base, cam, lamps: L, expo: 1.72, bloom: .28 + .25 * clamp(flashAmt(t) + eyeAmt(t) * .6, 0, 1) };
    if (t < T.lampOn + .1) o.bloom = .5;
  }
  drawSubs(t);
  GL.render(trc, frc, o);
}
function drawSubs(t) {
  if (qs.get('nosub')) return;
  for (const s of SUBS) if (t >= s.t0 && t < s.t1) { const a = Math.min(E(t, s.t0, s.t0 + .2), 1 - E(t, s.t1 - .25, s.t1)); drawSub(fr, s.text, a, 1 - eo(seg(t, s.t0, s.t0 + .22))); }
}

// ================= 幕后：挂在同一根竹竿上的三个化身与白骨 =================
const RACK = [['girl', 300], ['crone', 490], ['elder', 680], ['bones', 850]];
function renderBack(t, base) {
  const tIn = eo(seg(t, T.cutBack, T.truck1 + .6));
  const push = eio(seg(t, T.truck1, T.dive[0])), dive = ei(seg(t, T.dive[0], T.dive[1]));
  const zBase = .83, cx0 = 970, cy0 = 640, sx = (1 - tIn) * 900;
  const C0 = camM([cx0 - sx / zBase, cy0, zBase], -1);
  const lampV0 = ap(C0, LAMP[0], LAMP[1] + 70), flameV = [lampV0[0] + 20 * .85, lampV0[1] - 30 * .85];
  const sc = 1 + push * .1 + dive * 2.4;
  const F = [lerp(990, flameV[0], ss(seg(t, T.dive[0] - .6, T.dive[0]))), lerp(600, flameV[1], ss(seg(t, T.dive[0] - .6, T.dive[0])))];
  const C = [C0[0] * sc, 0, 0, C0[3] * sc, F[0] + (C0[4] - F[0]) * sc, F[1] + (C0[5] - F[1]) * sc];
  const Vt = (x, y, par = 1) => [F[0] + (x - F[0]) * sc - sx * (par - 1) * .6, F[1] + (y - F[1]) * sc];
  const info = drawScreen(t, C, { noRods: true });
  // 竹竿上挂着的四件：离布（近镜头）→ 略虚
  const poleY = Vt(0, 96)[1];
  const hangs = [];
  layer(tr, g => {
    RACK.forEach(([who, vx], i) => {
      const v = Vt(vx, 540), w = toW(C, v), sw = Math.sin(t * .9 + i * 1.7) * .035;
      const pose = { x: w[0], y: w[1], flip: 1, sc: .78, rot: sw, fT: [14, 98], bT: [-12, 98] };
      if (who === 'bones') { drawSkeleton(g, C, { ...pose, sc: .8 }); hangs.push(ap(C, w[0], w[1] - 450 * .8)); }
      else { const r = drawRobed(g, C, who, { ...pose, ...(who === 'crone' ? { lean: .2 } : {}), cane: false }); hangs.push(r.rods[0]); }
    });
  }, { blur: 2.2 * sc });
  // 暗场 + 木框背面
  fr.save(); fr.setTransform(1, 0, 0, 1, 0, 0);
  const sr = [C[0] * 1920 + C[4], C[5], C[4], C[3] * 1080 + C[5]];
  fr.fillStyle = '#0d0705'; fr.beginPath(); fr.rect(0, 0, W, H); fr.rect(sr[0], sr[1], sr[2] - sr[0], sr[3] - sr[1]); fr.fill('evenodd');
  fr.strokeStyle = '#2a120a'; fr.lineWidth = 26 * sc; fr.strokeRect(sr[0], sr[1], sr[2] - sr[0], sr[3] - sr[1]);
  fr.fillStyle = '#1c0d08'; fr.fillRect(0, sr[3], W, 60 * sc);
  const gl2 = fr.createLinearGradient(0, sr[3], 0, sr[3] + 60 * sc); gl2.addColorStop(0, 'rgba(255,170,90,.35)'); gl2.addColorStop(1, 'rgba(255,170,90,0)'); fr.fillStyle = gl2; fr.fillRect(0, sr[3], W, 60 * sc);
  fr.restore();
  // 竹竿 + 吊线（剪影 + 暖轮廓光）
  silhouette(fr, g => {
    g.lineWidth = 14 * sc; g.beginPath(); g.moveTo(Vt(80, 0)[0], poleY); g.lineTo(Vt(980, 0)[0], poleY + 6 * sc); g.stroke();
    g.lineWidth = 2.2 * sc; hangs.forEach(h => { g.beginPath(); g.moveTo(h[0], poleY); g.lineTo(h[0], h[1]); g.stroke(); });
    g.lineWidth = 5 * sc; g.beginPath(); g.moveTo(Vt(80, 0)[0], poleY); g.lineTo(Vt(40, 0)[0], -20); g.moveTo(Vt(980, 0)[0], poleY); g.lineTo(Vt(1010, 0)[0], -20); g.stroke();
  }, { dir: [.3, 1], k: 3, rimA: .7, rim: '#ffb766' });
  // 油灯
  const lampV = ap(C, LAMP[0], LAMP[1] + 70), I = lampMain(t);
  silhouette(fr, g => lampBody(g, lampV[0], lampV[1], .85 * sc), { dir: [0, -1], k: 3, rimA: .55, rim: '#ffb766' });
  lampFlame(fr, lampV[0], lampV[1], .85 * sc, t, 1);
  // 艺人的手握着唐僧的三根杆
  const hb = Vt(1480, 905, 1.4), hp = Vt(1230, 925, 1.4), hs = 1.3 * sc;
  silhouette(fr, g => {
    const a = fistHand(g, [hs, 0, 0, hs, hb[0], hb[1]]);
    const b = pinchHand(g, [hs * Math.cos(-.2), hs * Math.sin(-.2), -hs * Math.sin(-.2), hs * Math.cos(-.2), hp[0], hp[1]], .2);
    if (info.ts) { const grips = [a.grip, b.gripA, b.gripB]; info.ts.rods.forEach((p, i) => { const q = grips[i]; g.lineWidth = (i === 0 ? 6 : 4) * sc; g.beginPath(); g.moveTo(q[0] + (q[0] - p[0]) * .18, q[1] + (q[1] - p[1]) * .18); g.lineTo(p[0], p[1]); g.stroke(); }); }
  }, { dir: [-.5, -.86], k: 5, rimA: .85 });
  silhouette(fr, g => { const s = Vt(1900, 1160, 1.8); g.beginPath(); g.ellipse(s[0], s[1], 300 * sc, 220 * sc, -.2, 0, 7); g.fill(); g.beginPath(); g.ellipse(s[0] + 60 * sc, s[1] - 300 * sc, 120 * sc, 150 * sc, 0, 0, 7); g.fill(); }, { dir: [-.7, -.7], k: 7, rimA: .6, blur: 10 });
  return { ...base, cam: [(960 - C[4]) / C[0], (540 - C[5]) / C[3], C[3]], mir: -1, expo: 1.0, lamps: [[LAMP[0], LAMP[1] + 40, I * 1.2, 1.4], [...toW(C, Vt(560, 330)), .55 * I, -330]], bloom: .38, vign: .55, fade: dive * .92, fadeCol: [1, .82, .55] };
}
// ================= 片尾 =================
function renderEnd(t, base) {
  const cam = [960, 560, lerp(.84, .8, seg(t, T.endIn, T.end))], C = camM(cam);
  drawScreen(t, C, { endPlaque: true });
  drawFrame(fr, C, .7);
  drawAudience(fr, .9, t);
  const fadeIn = 1 - E(t, T.dive[1], T.endIn + .4), fadeOut = E(t, T.end - .7, T.end);
  return { ...base, cam, expo: 1.72, lamps: [[LAMP[0], LAMP[1] + 80, lampMain(t), .8]], fade: Math.max(fadeIn, fadeOut), fadeCol: fadeOut > fadeIn ? [0, 0, 0] : [1, .82, .55] };
}

// ================= 音效事件（给 mix.py）=================
function events() {
  const ev = [], add = (type, t, o = {}) => ev.push({ type, t: +t.toFixed(3), ...o });
  add('clap', T.clap); add('match', T.match); add('ignite', T.lampOn);
  add('rodtap', T.titleIn + .1); add('rodtap', T.titleSet - .05, { v: .6 }); add('gong', T.titleSet, { v: .9 }); add('liftoff', T.titleOut);
  add('rodtap', 7.2, { v: .5 }); add('rodtap', 7.5, { v: .4 }); add('press', 7.95, { v: .5 }); add('press', 8.1, { v: .4 });
  add('wind', 7.4, { d: T.cold1 - 7.4 + .8 }); add('wind', T.hit1 + 1.0, { d: T.croneIn - T.hit1, v: .8 }); add('wind', T.hit2 + 1.0, { d: T.elderIn - T.hit2, v: .6 });
  add('tai', T.wkBow, { v: .5 }); add('flip', T.wkTurn + .1); add('flip', 12.4, { v: .6 });
  add('hop', T.wkLeap); add('tai', T.wkLeap + .05, { v: .7 }); add('cloud', 13.6, { d: 1.4 });
  // 村姑
  add('cold', T.cold1, { d: T.hit1 - T.cold1 + 1.2 }); add('swell', T.girlIn - .5, { d: .55 }); add('press', T.girlIn + .5);
  for (let k = 0; k < 12; k++) add('patter', T.girlWalk[0] + .1 + k * (T.girlWalk[1] - T.girlWalk[0] - .2) / 12, { v: .5 + .2 * (k % 2) });
  add('cloud', T.wkBack - .1, { d: .8 }); add('press', T.wkLand - .1, { v: .8 }); add('land', T.wkLand + .05);
  add('shing', T.eye1); add('bones', T.xray1 + .1, { d: 1.2 }); add('drone', T.xray1, { d: T.xray1Off - T.xray1 + .4 });
  add('ting', T.ear1 + .45); add('grow', T.staffOut1 + .05, { d: .35 });
  const strike = (w, h, big = 1) => { add('swish', h - .22, { d: .25, v: big }); add('gong', h, { v: .85 * big }); add('cymbal', h + .01, { v: .7 * big }); add('thwack', h + .005, { v: big }); };
  add('creak', T.wind1, { d: .5 }); strike(T.wind1, T.hit1); add('fall', T.hit1 + .62); add('spirit', T.hit1 + .08, { d: 1.5 });
  // 斥责
  add('flip', 31.2); add('clapper', 31.6); add('clapper', 32.2, { v: .8 }); add('clapper', 32.8, { v: .9 }); add('clapper', 33.6, { v: .7 }); add('kneel', 32.35);
  add('liftoff', T.corpse1Off + .1, { v: .6 });
  // 老妇
  add('cold', T.cold2, { d: T.hit2 - T.cold2 + 1.2 }); add('swell', T.croneIn - .5, { d: .55 }); add('press', T.croneIn + .5);
  for (let k = 0; k < 6; k++) add('canetap', T.croneWalk[0] + .2 + k * .4, { v: .6 });
  add('shing', T.eye2, { v: .8 }); add('bones', T.xray2 + .05, { d: .5, v: .8 }); add('steps', T.dash2, { d: .35 });
  strike(T.dash2, T.hit2, .9); add('fall', T.hit2 + .55); add('spirit', T.hit2 + .08, { d: 1.4 });
  // 紧箍咒
  add('staffin', T.staffIn2, { d: .3 });
  for (let t = T.spell[0] + .2, i = 0; t < T.spell[1] - .1; i++) { add('muyu', t, { v: .75 }); if (i % 4 === 3) add('tai', t, { v: .45 }); t += .46 - .07 * seg(t, T.spell[0], T.spell[1]); }
  add('ring', T.spell[0] + .3, { d: T.spell[1] - T.spell[0] - .5 });
  for (const t of [44.25, 44.9, 45.55, 46.1, 46.62]) add('thud', t, { v: .7 });
  add('liftoff', T.corpse2Off + .1, { v: .6 });
  // 老翁
  add('cold', T.cold3, { d: T.silence - T.cold3 }); add('swell', T.elderIn - .5, { d: .55 }); add('press', T.elderIn + .5);
  for (let k = 0; k < 5; k++) { add('stafftap', T.elderWalk[0] + .25 + k * .5, { v: .6 }); add('beads', T.elderWalk[0] + .45 + k * .5, { v: .4 }); }
  add('ting', T.staffOut3 + .3); add('grow', T.staffOut3 + .38, { d: .35 });
  add('shing', T.eye3, { v: .85 }); add('bones', T.xray3 + .05, { d: .55, v: .8 });
  // 静场：只剩灯芯
  add('flip', T.look[0] + .1, { v: .5 }); add('flip', T.look[1] - .1, { v: .5 }); add('creak', T.raise[0], { d: T.raise[1] - T.raise[0], v: .6 });
  add('heart', 56.1, { v: .6 }); add('heart', 56.9, { v: .75 }); add('heart', 57.45, { v: .9 }); add('steps', T.dash3, { d: .4 });
  strike(T.dash3, T.hit3, 1.35); add('tanggu', T.hit3); add('crash', T.hit3 + .01);
  for (let k = 0; k < 9; k++) add('pop', T.hit3 + .02 + k * .035, { v: .5 + .5 * ((k * 7) % 3) / 2 });
  add('flaps', T.hit3 + .05, { d: .8 }); add('bonefall', T.hit3 + .45);
  add('wind', T.warm3, { d: T.cutBack - T.warm3, v: .8 });
  // 贬书、拜别
  add('clapper', 63.4, { v: .6 }); add('paper', T.paperFall[0], { d: T.paperFall[1] - T.paperFall[0] }); add('sleeve', 68.1); add('flip', T.tsTurn + .1);
  add('kneel', 71.45, { v: .7 }); T.bows.forEach(b => { add('kowtow', b + .38); add('tai', b + .4, { v: .55 }); });
  add('flip', 77.6, { v: .6 }); add('hop', 78.35); add('cloud', 78.4, { d: 1.2 });
  add('flip', T.tsBack + .1, { v: .5 });
  // 幕后
  add('whoosh', 81.0, { d: .9 }); add('cloth', 81.4); add('room', T.cutBack, { d: T.clap2 - T.cutBack + .3 });
  add('rack', 82.2, { v: .5 }); add('rack', 83.4, { v: .35 }); add('breath', 85.2); add('rodtap', 84.3, { v: .4 });
  add('swell', T.dive[0] - .2, { d: .75 }); add('gong', T.dive[1] - .05, { v: .75 });
  add('clap', T.clap2); add('rodtap', T.endIn + .1, { v: .6 }); add('rodtap', T.endIn + .95, { v: .5 });
  return ev.sort((a, b) => a.t - b.t);
}
window.EV = events(); window.T = T; window.SUBS = SUBS;
window.render = render; window.DUR = DUR;
render(parseFloat(qs.get('t') ?? '20'));
window.READY = true;
