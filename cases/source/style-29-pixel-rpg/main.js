// main.js — 导演脚本：按 timeline.js 的帧网格排镜头、转场、调色板、UI；导出 EV（拟音事件）与 TEXTS（读字核对）
import { W, H, SCALE, FB, C, T, LUT, makeOut, mosaic, whiten, bayer, clamp, lerp, eo, eo3, eio, mod } from './px.js';
import { initCJK, text, bigText, textW, CS } from './font.js';
import { hero, POSE, mix, walkPose, chestSprite, portraitMimic, key, sparkle, HEART, BANG } from './art.js';
import { dungeon, fgPillars, battleBG, shadow, FEET_Y, BAT } from './scenes.js';
import { win, topMsg, menu, statusBattle, statusExp, dialog, visible, nVis, itemPos, MENU } from './ui.js';
import { FPS, CUE, DUR, NFRAMES, SILENCE, fA, fB } from './timeline.js';

const q = new URLSearchParams(location.search);
const ALL_TEXT = '宝箱怪出现了它在发抖攻击魔法对话逃跑勇者给你获得钥匙友情';
await initCJK(ALL_TEXT, 'NotoSC5', 500, .45, 14);

const fb = new FB(), wfb = new FB(), src = new FB(), zfb = new FB(), out = makeOut(document.getElementById('c'));
const S = f => f / FPS;

// ——————————————— 文字 ———————————————
const M1 = '宝箱怪 出现了！', M2 = '它在发抖…', D1 = '……给你。', M3 = '获得 钥匙！';
// 打字：每帧一字，最后一字落在 cue 帧
const typeStart = (s, cue, per = 1) => cue - (nVis(s) - 1) * per;

// ——————————————— 世界里的人物 ———————————————
const CHEST_WX = 318;
const heroWX = f => f < 60 ? 196 + 88 * f / 60 : 284;
const dCam = f => Math.round(Math.min(heroWX(f), 284) - 124);
const DRIPS = [{ wx: 250, t0: S(22) }, { wx: 410, t0: S(52) }, { wx: 470, t0: S(440) }];

// 姿态混合（12 fps 步进）
function poseAt(keys, f) {
  const fq = Math.floor(f / 2) * 2;   // 12 fps
  let i = 0; while (i < keys.length - 1 && fq >= keys[i + 1][0]) i++;
  const [f0, p0] = keys[i], nx = keys[i + 1];
  if (!nx) return POSE[p0] || p0;
  const [f1, p1, dur = f1 - f0] = nx;
  const k = clamp((fq - (f1 - dur)) / Math.max(1, dur), 0, 1);
  return mix(POSE[p0] || p0, POSE[p1] || p1, eio(k));
}

// ——————————————— A 段：地牢 ———————————————
function drawDungeonWorld(g, f, t) {
  g.clear(C.ink);
  const camX = dCam(f);
  dungeon(g, camX, t, { drips: DRIPS });
  // 宝箱
  let st = {}, lift = 0;
  if (f >= 66 && f < 70) lift = 1;                                   // 箱盖抽动
  if (f >= 80 && f < 90) lift = mod(Math.floor(f / 2), 2);           // 颤
  if (f >= 90) { const k = clamp((f - 90) / 3, 0, 1); st = { open: k, mouth: Math.round(3 + 6 * k), eyes: 'mad', tongue: k, t }; }
  const cs = chestSprite(22, 10, 7, st);
  const jump = f >= 90 && f < 96 ? [0, -3, -4, -3, -1, 0][f - 90] : 0;
  shadow(g, CHEST_WX - camX, FEET_Y, 12, 2);
  g.blit(cs, CHEST_WX - camX - cs.ox, FEET_Y - cs.oy - lift * 0 + jump);
  if (lift) { /* 盖子抬 1px：重画上半 */ const s2 = chestSprite(22, 10, 7, { mouth: 1 }); g.blit(s2, CHEST_WX - camX - s2.ox, FEET_Y - s2.oy); }
  // 金光闪
  if (f < 90) for (const fs of [0, 30, 60]) if (f >= fs && f < fs + 8) sparkle(g, CHEST_WX - camX + 1, FEET_Y - 13, Math.floor((f - fs) / 2) % 4);
  // 勇者
  let P, hx = heroWX(f), hy = FEET_Y;
  if (f < 60) P = walkPose(Math.floor(f / 3) / 5);
  else if (f < 75) P = { ...POSE.stand, hip: (f >= 66 && f < 72) ? -1 : 0 };
  else if (f < 90) P = poseAt([[75, 'stand'], [83, 'reach', 8]], f);
  else { const k = clamp((f - 90) / 8, 0, 1); P = POSE.recoil; hx -= Math.round(12 * eo(k)); hy -= Math.round(Math.sin(Math.PI * k) * 6); if (f >= 98) P = mix(POSE.recoil, POSE.guard, clamp((f - 98) / 4, 0, 1)); }
  const hs = hero(P, t);
  shadow(g, Math.round(hx - camX), FEET_Y, 6, 2);
  g.blit(hs, Math.round(hx - camX) - hs.ox, hy - hs.oy);
  if (f >= 90 && f < 106) g.blit(BANG, Math.round(hx - camX) - 3, hy - 42 - (f < 92 ? 2 : 0));
  fgPillars(g, camX);
}
function composeDungeon(f, t) {
  drawDungeonWorld(wfb, f, t);
  if (f < 75) { fb.d.set(wfb.d); return; }
  // ×2 快推：焦点在勇者与宝箱之间
  const camX = dCam(f), fx = 300 - camX, fy = 140;
  let sx = 160, sy = 104;
  if (f >= 90 && f < 98) { const sh = [3, -3, 2, -2, 1, -1, 1, 0][f - 90]; sx += sh; sy += (f % 2 ? -sh : sh) >> 1; }
  fb.zoomFrom(wfb, 2, fx, fy, sx, sy);
}

// ——————————————— 遇敌漩涡 ———————————————
function swirl(f, t) {
  composeDungeon(99, S(99)); src.d.set(fb.d);
  const s = (f - CUE.swirl) / (CUE.battle - CUE.swirl);
  const tw = 7.5 * Math.pow(s, 1.6), n = 1 + Math.floor(s * s * 10), dis = clamp((s - .4) / .6, 0, 1) * .9;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const bx = Math.floor(x / n) * n + (n >> 1), by = Math.floor(y / n) * n + (n >> 1);
    const dx = bx - 160, dy = by - 90, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx) + tw * (1 - Math.min(1, r / 200));
    let c = src.get(160 + r * Math.cos(a), 90 + r * Math.sin(a)); if (c === T) c = C.ink;
    if (bayer(x, y) < dis) c = C.gw;
    fb.d[y * W + x] = c;
  }
}

// ——————————————— 战斗 ———————————————
function mimicState(f, t) {
  const b = f - CUE.battle;
  if (f < CUE.tremble) {   // 凶：每两拍咬一次
    const k = mod(b, 20), m = k < 2 ? 26 : k < 6 ? 26 - (k - 2) * 2 : 18;
    return { open: 1, mouth: m, eyes: 'mad', tongue: k < 6 ? 1 : .7, t, dx: 0 };
  }
  if (f < CUE.heart) {     // 发抖（静默时冻住）
    const frozen = f >= SILENCE[0][0];
    return { open: .8, mouth: 19, eyes: 'scared', t: frozen ? S(SILENCE[0][0]) : t, dx: frozen ? 0 : (mod(Math.floor(f / 2), 2) ? 1 : -1) };
  }
  if (f < CUE.spit) return { open: .4, mouth: 11, eyes: 'shy', look: -1, teeth: .4, t, dx: 0 };
  if (f < CUE.spit + 8) { const k = f - CUE.spit; return { open: 1, mouth: [22, 24, 24, 21, 18, 15, 13, 12][k], eyes: 'happy', teeth: .6, t, dx: 0, dy: k < 3 ? -2 : 0 }; }
  if (f < CUE.status) return { open: .4, mouth: 11, eyes: 'shy', look: 1, teeth: .4, t, dx: 0 };
  return { open: .6, mouth: 14, eyes: 'happy', teeth: .5, t, dx: 0, dy: mod(f - CUE.status, 10) < 3 ? -1 : 0 };
}
// 钥匙飞行：吐出 → 抛物线 → 勇者手里
function keyPos(f, handW) {
  const k = clamp((f - CUE.spit) / (CUE.catch - CUE.spit), 0, 1);
  const x0 = BAT.mimicX + 2, y0 = BAT.feet - 34, [x1, y1] = handW;
  return [lerp(x0, x1, k), lerp(y0, y1, k) - Math.sin(Math.PI * k) * 40, (f - CUE.spit) * .55];
}
function heroBattlePose(f) {
  return poseAt([[0, 'guard'], [CUE.select, 'lower', 2], [CUE.spit + 8, 'lower'], [CUE.catch, 'catch', 12], [CUE.status + 6, 'lower', 6], [CUE.status + 25, 'crouch', 5], [CUE.levelup, 'raise', 1]], f);
}
function drawBattleWorld(g, f, t, ox = 0, noHero = false) {
  g.clear(C.ink);
  battleBG(g, t, ox);
  // 宝箱怪
  const st = mimicState(f, t), ms = chestSprite(72, 32, 22, st);
  shadow(g, BAT.mimicX + ox, BAT.feet, 38, 4);
  g.blit(ms, BAT.mimicX + ox - ms.ox + (st.dx || 0), BAT.feet - ms.oy + (st.dy || 0));
  if (noHero) return null;
  // 勇者（朝左）
  let P = heroBattlePose(f);
  const breath = f < CUE.select && mod(f, 14) < 7 ? -1 : 0;
  if (breath) P = { ...P, hip: P.hip + breath };
  const hs = hero(P, t), hx = BAT.heroX + ox;
  shadow(g, hx, BAT.feet, 8, 2);
  g.blit(hs, hx - (hs.w - 1 - hs.ox), BAT.feet - hs.oy, true);
  const handW = [hx - hs.hand[0], BAT.feet + hs.hand[1]];
  // 钥匙
  if (f >= CUE.spit && f < CUE.catch) { const [kx, ky, a] = keyPos(f, handW); key(g, kx, ky, a); }
  if (f >= CUE.catch && f < CUE.levelup) {
    key(g, handW[0], handW[1] - 1, 0);
    if (f < CUE.catch + 8) sparkle(g, handW[0] - 2, handW[1] - 5, Math.floor((f - CUE.catch) / 2));
  }
  if (f >= CUE.levelup) {
    // 举过头顶：手臂走后脑一侧，钥匙在手的正上方、底边离头顶 5 px（side view 道具 / 手臂都不挡脸）
    const headTop = BAT.feet + hs.head[1], kx = handW[0], ky = headTop - 5 - 3;
    key(g, kx, ky, 0);
    for (const [o, dx, dy] of [[0, -8, -3], [5, 8, 1], [2, 1, -7]]) { const k = mod(f - CUE.levelup + o * 2, 10); if (k < 8) sparkle(g, kx + dx, ky + dy, k >> 1); }
  }
  return handW;
}

// ——————————————— 结尾：同行 ———————————————
function drawEnding(f, t) {
  const e = f - CUE.mosaic, hx = 300 + 2.2 * e, camX = Math.round(hx - 150);
  wfb.clear(C.ink); dungeon(wfb, camX, t, { drips: DRIPS });
  // 宝箱怪跟在后面蹦（每拍落地）
  const ph = mod(e, 10) / 10, mx = hx - 36, my = FEET_Y - Math.round(Math.sin(Math.PI * ph) * 7);
  shadow(wfb, Math.round(mx - camX), FEET_Y, 11, 2);
  const cs = chestSprite(22, 10, 7, { open: .5, mouth: ph < .5 ? 4 : 2, eyes: 'happy', teeth: .5 });
  wfb.blit(cs, Math.round(mx - camX) - cs.ox, my - cs.oy);
  if (f >= CUE.final) { const k = f - CUE.final; wfb.blit(HEART, Math.round(mx - camX) - 3, my - 26 - Math.floor(k / 4)); }
  const P = walkPose(Math.floor(e / 2) / 5, POSE.lower);
  const hs = hero({ ...P, aF: .9, eF: -.4 }, t);
  shadow(wfb, Math.round(hx - camX), FEET_Y, 6, 2);
  wfb.blit(hs, Math.round(hx - camX) - hs.ox, FEET_Y - hs.oy);
  key(wfb, Math.round(hx - camX) + hs.hand[0], FEET_Y + hs.hand[1] - 1, 0);
  fgPillars(wfb, camX);
  fb.d.set(wfb.d);
}

// ——————————————— 每帧 ———————————————
let TXT = [];
function render(t) {
  const f = Math.min(NFRAMES - 1, Math.round(t * FPS));
  TXT = [];
  let lut = LUT.full, pick = null;
  if (f < CUE.swirl) composeDungeon(f, t);
  else if (f < CUE.battle) { swirl(f, t); if (f < CUE.swirl + 3) lut = [whiten(LUT.full, .75), whiten(LUT.full, .5), whiten(LUT.full, .25)][f - CUE.swirl]; }   // 遇敌白闪，按调色板阶梯退回，同时开始扭
  else if (f < CUE.levelup) {
    const ox = f >= SILENCE[0][0] && f < CUE.heart ? Math.round(12 * eio((f - SILENCE[0][0]) / (CUE.heart - SILENCE[0][0]))) : f >= CUE.heart ? 12 : 0;
    drawBattleWorld(fb, f, t, ox);
    battleUI(f, t);
    if (f >= CUE.heart) lut = f === CUE.heart ? LUT.blush1 : f === CUE.heart + 1 ? LUT.blush2 : LUT.blush;
  } else if (f < CUE.mosaic) levelUp(f, t), ({ lut, pick } = luLUT(f));
  else drawEnding(f, t), lut = LUT.blush;
  // 战斗入场：白→画面（Bayer）
  if (f >= CUE.battle && f < CUE.battle + 2) { const d = [.5, .25][f - CUE.battle]; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (bayer(x, y) < d) fb.d[y * W + x] = C.gw; }
  out.present(fb, lut, pick);
  // 马赛克交叉
  if (f >= CUE.mosaic - 6 && f < CUE.mosaic + 6) mosaic(out.u32, 1 + Math.round(11 * (1 - Math.abs(f - CUE.mosaic + .5) / 6.5)));
  out.show();
}

function battleUI(f, t) {
  const B0 = CUE.battle;
  const slide = (f0, dist) => Math.round(dist * (1 - eo3(clamp((f - f0) / 7, 0, 1))));
  // 顶部消息
  if (f < CUE.heart + 4) {
    const dyT = f >= CUE.heart ? -Math.round((f - CUE.heart + 1) * 8) : -slide(B0, 30);
    if (f < CUE.tremble) { const s0 = typeStart(M1, CUE.msg1); const n = f < s0 ? 0 : f - s0 + 1; const b = topMsg(fb, M1, n, dyT); if (n > 0 && dyT === 0) TXT.push({ id: 'm1', text: M1, ...b }); }
    else { const s0 = typeStart(M2, CUE.tremble); const b = topMsg(fb, M2, f - s0 + 1, dyT); if (dyT === 0) TXT.push({ id: 'm2', text: M2, ...b }); }
  }
  if (f >= typeStart(M3, CUE.catch) - 2 && f < CUE.levelup) {
    const s0 = typeStart(M3, CUE.catch), dyT = -Math.round(30 * (1 - eo3(clamp((f - s0 + 2) / 2, 0, 1))));
    const b = topMsg(fb, M3, f - s0 + 1, dyT); if (f >= s0 && dyT === 0) TXT.push({ id: 'm3', text: M3, ...b });
  }
  // 底部：菜单 + 状态 → 对话框 → EXP 状态
  if (f < CUE.heart) {
    const dy = slide(B0, 50);
    const cur = f < CUE.cursor ? null : f < CUE.cur1 ? 0 : f < CUE.cur2 ? 1 : 2;
    const sel = f >= CUE.select ? 2 : -1, flash = f >= CUE.select && f < CUE.select + 6 && mod(Math.floor((f - CUE.select) / 2), 2) === 0;
    menu(fb, dy, sel, cur, f < CUE.tremble, t, flash);
    statusBattle(fb, dy);
    if (dy === 0) {
      MENU.items.forEach((s, i) => { const [x, y] = itemPos(i); TXT.push({ id: 'menu' + i, text: s, x0: x, y0: y, x1: x + textW(s), y1: y + CS }); });
      TXT.push({ id: 'hero', text: '勇者', x0: 136, y0: 140, x1: 136 + textW('勇者'), y1: 140 + CS });
    }
  } else if (f < CUE.status) {
    const dy = Math.round(46 * (1 - eo3(clamp((f - CUE.heart) / 5, 0, 1))));
    const pst = mimicPortrait(f);
    const s0 = typeStart(D1, CUE.line, 3), n = f < s0 ? 0 : Math.floor((f - s0) / 3) + 1;
    const b = dialog(fb, dy, portraitMimic(pst), D1, n, f >= CUE.line, t - S(CUE.line));
    if (dy === 0) TXT.push({ id: 'name', text: '宝箱怪', ...b.name });
    if (n > 0 && dy === 0) TXT.push({ id: 'd1', text: D1, ...b.line });
  } else {
    const dy = Math.round(46 * (1 - eo3(clamp((f - CUE.status) / 5, 0, 1))));
    const k = Math.min(5, Math.floor((f - CUE.status) / 5));
    statusExp(fb, dy, 1, [.2, .36, .52, .68, .84, .97][k], false, null);
    if (dy === 0) TXT.push({ id: 'hero2', text: '勇者', x0: 18, y0: 140, x1: 18 + textW('勇者'), y1: 140 + CS });
  }
}
function mimicPortrait(f) { return { open: .45, mouth: 4, eyes: f >= CUE.spit && f < CUE.spit + 8 ? 'happy' : 'shy', look: f < CUE.spit ? -1 : 1, teeth: .5 }; }

// ——————————————— 升级 ———————————————
function levelUp(f, t) {
  const fy0 = BAT.feet - 14, tilt = Math.round(12 * eio(clamp((f - CUE.levelup) / (CUE.phrase2 - CUE.levelup), 0, 1)));
  drawBattleWorld(wfb, f, t, 0); drawBattleWorld(src, f, t, 0, true);
  const hop = f >= CUE.levelup && f < CUE.levelup + 4 ? [-2, -3, -2, -1][f - CUE.levelup] : 0;
  fb.zoomFrom(wfb, 2, BAT.heroX, fy0 - tilt + hop, 160, 98);
  zfb.zoomFrom(src, 2, BAT.heroX, fy0 - tilt + hop, 160, 98);   // 无勇者版本：两者不同的像素 = 勇者/钥匙，光柱不盖它们
  // 光柱：50% 棋盘 + 25% 边（屏幕空间，避开标题）
  const g0 = BAT.feet, footY = Math.round(98 + (g0 - (fy0 - tilt + hop)) * 2);
  for (let y = 50; y < Math.min(footY, 132); y++) for (let x = 160 - 30; x <= 160 + 30; x++) {
    const e = Math.abs(x - 160) / 30, c = fb.d[y * W + x];
    if (c === C.ink || c >= 32 || c !== zfb.d[y * W + x]) continue;
    if (e < .6 && (x + y) % 2 === 0) fb.d[y * W + x] = C.g0; else if (e < 1 && (x % 2 === 0) && (y % 2 === 0)) fb.d[y * W + x] = C.g1;
  }
  // LEVEL UP!（2× 大字，落定于 levelup 帧，之后 1 px 回弹）
  const s = 'LEVEL UP!', w = textW(s) * 2, bounce = [0, -2, -1, 0][Math.min(3, f - CUE.levelup)];
  bigText(fb, s, Math.round((W - w) / 2), 16 + bounce, [C.gw, C.g0, C.g1, C.g1, C.g2, C.g3]);
  TXT.push({ id: 'lvup', text: s, x0: Math.round((W - w) / 2), y0: 12, x1: Math.round((W - w) / 2) + w, y1: 12 + 28 });
  statusExp(fb, 0, 2, f < CUE.levelup + 6 ? 1 : 0, f < CUE.levelup + 4 && f % 2 === 0, '友情 +1');
  TXT.push({ id: 'hero2', text: '勇者', x0: 18, y0: 140, x1: 18 + textW('勇者'), y1: 140 + CS });
  TXT.push({ id: 'lv2', text: 'Lv 2', x0: 58, y0: 140, x1: 58 + textW('Lv 2'), y1: 140 + CS });
  TXT.push({ id: 'fr', text: '友情 +1', x0: 216, y0: 140, x1: 216 + textW('友情 +1'), y1: 140 + CS });
}
// 金色抖动波：从勇者脚下向外扩散（扁椭圆，上沿与左右边同时出画），前沿 = 最亮金 / 黄两级 Bayer 抖动，后沿抖回“亮一步”
function luLUT(f) {
  const R = (f - CUE.levelup) * 20 + 8, cx = 160, cy = 124, BW = 16, SQ = 1.3;
  if (R - BW > 230) return { lut: LUT.blush, pick: (x, y) => y < 132 ? LUT.light : null };
  const tw = textW('LEVEL UP!') * 2 + 4, tx0 = Math.round((W - tw) / 2);   // 标题框里不上波（保住墨描边）
  return { lut: LUT.blush, pick: (x, y) => {
    if (y >= 132) return null;
    if (y >= 12 && y < 46 && x >= tx0 && x < tx0 + tw) return R - BW > Math.hypot(x - cx, (y - cy) * SQ) ? LUT.light : null;
    const d = Math.hypot(x - cx, (y - cy) * SQ); if (d > R) return null;
    const u = (R - d) / BW, b = bayer(x, y);
    if (u < .35) return b < .5 ? LUT.goldHi : LUT.goldY;
    if (u < 1) return b < (1 - u) / .65 ? LUT.goldY : LUT.light;
    return LUT.light;
  } };
}

// ——————————————— 事件（拟音）———————————————
const EV = [];
const ev = (f, type, o = {}) => EV.push({ t: +(f / FPS).toFixed(5), f, type, ...o });
ev(0, 'amb', { dur: S(CUE.chomp) });
for (const d of DRIPS) ev(Math.round(d.t0 * FPS) + 10, 'drip', { pan: -.3 });
for (let k = 0; k < 4; k++) ev(fA(k), 'step', { cue: k ? 'step' + k : 'open', pan: -.2 + k * .08, echo: 1 });
for (const fs of [0, 30]) ev(fs, 'glint', { v: .35, pan: .4 });
ev(CUE.stop, 'glint', { v: .8, pan: .4, cue: 'stop' });
ev(66, 'creak', { v: .5, pan: .35 });
ev(CUE.push, 'zoom', { cue: 'push' }); ev(CUE.push + 2, 'cloth', { v: .4 });
ev(80, 'rattle', { dur: S(10), pan: .2 });
ev(CUE.chomp, 'chomp', { cue: 'chomp' }); ev(CUE.chomp, 'bang', { pan: -.2 }); ev(CUE.chomp + 1, 'hop', { pan: -.2 });
ev(CUE.swirl, 'swirl', { cue: 'swirl', dur: S(CUE.battle - CUE.swirl) });
ev(CUE.battle, 'win', { cue: 'battle' });
const typeEv = (s, cue, per, kind) => { const s0 = typeStart(s, cue, per); for (let i = 0; i < nVis(s); i++) ev(s0 + i * per, 'blip', { kind, i, ...(i === nVis(s) - 1 ? { cue: kind === 'mimic' ? 'line' : undefined } : {}) }); };
typeEv(M1, CUE.msg1, 1, 'sys'); EV[EV.length - 1].cue = 'msg1';
for (const fc of [CUE.battle, CUE.battle + 20, CUE.battle + 40, CUE.battle + 60]) ev(fc, 'clack', { pan: -.5 });
ev(CUE.cursor, 'cursor', { cue: 'cursor', p: 0 });
typeEv(M2, CUE.tremble, 1, 'sys'); EV[EV.length - 1].cue = 'tremble';
ev(CUE.tremble, 'tremble', { dur: S(SILENCE[0][0] - CUE.tremble), pan: -.5 });
ev(CUE.cur1, 'cursor', { cue: 'cur1', p: 1 }); ev(CUE.cur2, 'cursor', { cue: 'cur2', p: 2 });
ev(CUE.select, 'confirm', { cue: 'select' }); ev(CUE.select, 'sheath', { pan: .4 });
ev(CUE.heart, 'heartbeat', { cue: 'heart' }); ev(CUE.heart, 'win', { v: .5 });
typeEv(D1, CUE.line, 3, 'mimic');
ev(CUE.spit, 'spit', { cue: 'spit', pan: -.4 }); ev(CUE.spit + 2, 'spin', { dur: S(CUE.catch - CUE.spit - 2) });
ev(CUE.catch, 'clink', { cue: 'catch', pan: .4 });
{ const s0 = typeStart(M3, CUE.catch); ev(s0 - 1, 'win', { v: .4 }); for (let i = 0; i < nVis(M3) - 1; i++) ev(s0 + i, 'blip', { kind: 'sys', i }); }
ev(CUE.status, 'win', { cue: 'status' });
for (let k = 0; k < 6; k++) ev(CUE.status + k * 5, 'tick', { k });
ev(CUE.status + 25, 'cloth', { v: .5 });
ev(CUE.levelup, 'flash', { cue: 'levelup' }); ev(CUE.levelup, 'whoosh', { v: .5 });
for (let k = 1; k < 6; k++) ev(CUE.levelup + k * 10, 'glint', { v: .35, pan: .1 * (k % 3 - 1) });
ev(CUE.mosaic - 6, 'mosaic', { dur: S(12) });
ev(CUE.mosaic, 'amb', { dur: S(NFRAMES - CUE.mosaic) });
for (let k = 0; k < 4; k++) ev(CUE.mosaic + k * 10, 'step', { v: .8, pan: .1 });
for (let k = 1; k < 4; k++) ev(CUE.mosaic + k * 10, 'hop', { v: .7, pan: -.2, kind: 'chest' });
ev(CUE.final, 'pop', { cue: 'final' });

window.DUR = DUR;
window.EV = EV;
window.render = render;
window.TEXTS = t => { render(t); return TXT.map(o => ({ id: o.id, text: o.text, x0: o.x0 * SCALE, y0: o.y0 * SCALE, x1: o.x1 * SCALE, y1: o.y1 * SCALE })); };
window.READY = true;
