// 第六章 洽谈 + 第七章 尾声（第 74–90 小节，146–180 s）。分镜：notes/ch67.md。接口见 ARCH.md §4。
// 六：第五章的城沿纸面折平、洽谈室立起，镜头推拉变焦成等距（准正交）；地面一字一拍印四步，三个背影小人按顺序走过；文件夹 → 立牌 → 三条纸条。
// 七：镜头升起离开等距，「谈」城从房间处一圈圈弹起，正俯时街道按笔顺朱红点亮 → 城折平收回书页 → 第 89 小节第 1 拍合书（共用层）→ 封面加印 → 口径小字 → 锁定成结尾海报。
//
// 与第五章的接口（ctx.use('city')）：gate.retract(r) 折平广场门楼给洽谈室让地方；plan.strokes = 「谈」十条街；setRetract(r, t) 第 88 小节收城。
// 广场上落在房间范围里的小物（路灯、花坛、路过的行人）在房间立起时隐藏。没有改共用层。
import { at, KEY, fq } from '../timeline.js';
import { camKey } from '../shared/world.js';
import { TEXT } from '../shared/texts.js';
import { clamp, seg, ss, track } from '/core/lib.js';
import { E as EZ, colX, rowY, ML, CW as COLW, GUT, RH, H as LH_, W as LW_, layout as coverGrid } from '../cover.js';
import { TM, E8, E16, stepTimes, O, PG, STATION_X, ROOM, BOARD, TABLE, FIG_H, N_STROKES } from './ch67_plan.js';
import { buildRoom, updateRoom, rowTypeT } from './ch67_room.js';
import { buildTan, updateTan, strokeT } from './ch67_tan.js';

export const ID = 'ch67';
const wx = lx => O[0] + lx, wz = lz => O[2] + lz;
const ISO = (lx, lz, vis, y = PG) => camKey(.8, 35.264, 45, wx(lx), y, wz(lz), vis);
const SH = .0072;   // 返修：沿路跟随段机位向画面右侧移 6%（地面大字不再被右边框斜切）
const SIGN = [BOARD.x, ROOM.floorT + TABLE.h + BOARD.h * .52, BOARD.z];
export const camera = [
  // M1 推拉变焦：146.0 前后由共用层从第五章机位衔接（145.5–146.5），148.0 等距成形
  [146.5, camKey(9, 37.5, 40, wx(.094), PG + .004, wz(.004), .150)],
  [148.0, ISO(.090, .004, .098)],
  // M2 沿路跟随：每次小人起步，镜头随领头人平移一站
  [149.9, ISO(.055 + SH, .002 - SH, .096)],
  [152.0, ISO(.055 + SH, .002 - SH, .096)], [153.6, ISO(.017 + SH, .000 - SH, .096)],
  [156.0, ISO(.017 + SH, .000 - SH, .096)], [157.6, ISO(-.021 + SH, -.002 - SH, .097)],
  [159.4, ISO(-.021 + SH * .6, -.002 - SH * .6, .097)],
  // M3 缓推到立牌
  [161.7, ISO(-.058, .006, .090)],
  [163.0, camKey(.8, 35.264, 45, wx(SIGN[0] + .006), PG + SIGN[1] * .62, wz(SIGN[2] + .022), .082)],
  [166.0, camKey(.8, 35.264, 45, wx(SIGN[0] + .006), PG + SIGN[1] * .66, wz(SIGN[2] + .026), .086)],
  [168.0, camKey(.8, 35.264, 45, wx(SIGN[0] + .006), PG + SIGN[1] * .66, wz(SIGN[2] + .026), .083)],
  // M4 升起、离开等距（fov 推开、仰角抬到近正俯、方位转正）：第五章的城从上空看，街道是一个「谈」字
  [169.4, camKey(6, 60, 24, .03, PG, -.05, .21)],
  [170.8, camKey(30, 83, 3, 0, PG - .004, -.196, .53)],
  [173.9, camKey(30, 85.5, 0, 0, PG - .004, -.199, .505)],
  // M5 拉远回到木桌（城收回、合书）
  [175.6, camKey(28, 55, 5, 0, PG, -.02, .68)],
  // M6 缓推到海报、锁定
  [176.6, camKey(26, 57, 6, -.006, PG + .006, .010, .50)],
  [179.3, camKey(24, 60, 7, -.012, PG + .008, .008, .34)],
  [180.0, camKey(24, 60, 7, -.012, PG + .008, .008, .34)],
];

// ———————————————— 事件 ————————————————
const STEP_TOK = TEXT.ch6.steps.map(s => [...s.matchAll(/[A-Za-z0-9]+|\S/gu)].length);
const ST = STEP_TOK.map((n, k) => stepTimes(k, n));
const leadSteps = k => { const [a, b] = ST[k].walk, out = []; for (let t = a; t <= b - .1; t += E8) out.push(fq(t)); return out; };
export function events() {
  const E = [];
  const add = (t, type, id, o = {}) => E.push({ t: +(+t).toFixed(4), type, id: 'ch67.' + id, ...o });
  add(TM.ch5Fold[0], 'gate_close', 'gate.close', { sfx: true });      // 返修：144.5 关门
  add(TM.ch5Fold[1], 'gate_fold', 'gate.fold', { sfx: true });        // 145.5 门楼折平（shuffle 止于此）
  add(TM.floorRoll[1], 'floor_roll', 'floor.roll', { sfx: true });    // 146.0 地板铺平（shuffle 止于此）
  add(TM.roomRise[0], 'room_rise', 'room.rise', { sfx: true });
  add(TM.roomRise[1], 'room_up', 'room.up', { sfx: true });
  ST.forEach((s, k) => {
    add(s.T, 'floor_mark', `step.${k}`, { sfx: true, text: TEXT.ch6.steps[k] });
    s.toks.forEach((t, j) => add(t, 'floor_char', `step.${k}.c${j}`, { sfx: true }));
    add(s.sub, 'floor_sub', `step.${k}.sub`, { sfx: true, text: TEXT.ch6.stepSubs[k] });
    leadSteps(k).forEach((t, j) => add(t, 'footstep', `walk.${k}.s${j}`));
  });
  add(TM.folderLift, 'folder_lift', 'folder.lift');
  add(TM.folder, 'folder', 'folder', { sfx: true });
  add(TM.folderOpen, 'folder_open', 'folder.open', { sfx: true });
  add(TM.sign, 'sign_up', 'sign', { sfx: true, text: TEXT.ch6.folder.title });
  TM.rows.forEach((t, i) => { add(t, 'label_up', `row.${i}`, { sfx: true, text: TEXT.ch6.folder.rows[i] });
    [...TEXT.ch6.folder.rows[i]].forEach((_, j) => add(rowTypeT(i, j), 'type', `row.${i}.t${j}`)); });
  for (let i = 0; i < N_STROKES; i++) add(strokeT(i), 'tan_stroke', `tan.s${i}`, { sfx: true });
  add(TM.roomFold[0], 'room_fold', 'room.fold');
  add(TM.cityBack[0], 'city_back', 'city.back', { sfx: true });
  add(TM.cityBack[1], 'city_flat', 'city.flat');
  add(TM.coverA, 'cover_text', 'cover.a', { sfx: true, text: TEXT.ch7.cover });
  add(TM.coverB, 'cover_text', 'cover.b', { sfx: true });
  add(TM.footer, 'footer', 'footer', { sfx: true, text: TEXT.ch7.footer });
  return E;
}

// ———————————————— 封面加印（开头那张瑞士海报的版面坐标，1920×1080 × S2）————————————————
const COVER_FROM = fq(TM.close + .2);
let CL = null;   // 封面加印的版面（字体就绪后量一次）
function coverLayout(x) {
  const A = TEXT.ch7.cover.split('·').map(s => s.trim());             // 「选定方向」「开始洽谈」
  const size = 150, font = `700 ${size}px SC`; x.font = font;
  const m = s => { const k = x.measureText(s); return { w: k.actualBoundingBoxRight + k.actualBoundingBoxLeft, lb: k.actualBoundingBoxLeft, asc: k.actualBoundingBoxAscent, desc: k.actualBoundingBoxDescent }; };
  const a = m(A[0]), b = m(A[1]);
  const base = rowY(3) + a.asc;                                        // 字顶贴第 4 行模块上沿
  const xa = ML + a.lb, xb = colX(6) + b.lb, aEnd = ML + a.w;
  const dotX = (aEnd + colX(6)) / 2, dotY = base - a.asc * .42, dotR = size * .1;
  // 口径小字：与数字条细线同一套网格，压在细线上方一行
  x.font = '800 100px Inter'; const k = x.measureText('1960'), w100 = k.actualBoundingBoxRight + k.actualBoundingBoxLeft;
  const sRow = 100 * (2 * COLW - GUT * 2) / w100; x.font = `800 ${sRow}px Inter`; const ascRow = x.measureText('1960').actualBoundingBoxAscent;
  const rowTop = coverGrid(x).rowTop;   // 返修：直接取封面版面的数字条细线位置（与画出来的那条线同一个值）
  // 返修：口径小字放大（原 40）。优先整行：取放得下版心宽度（W − 2·ML）的最大字号（52 → 42），在「选定方向 · 开始洽谈」与数字条细线之间垂直居中
  // （上下都留 ≥ 1 个字高）；整行放不下才按「｜」断成两行
  const coverBot = base + Math.max(a.desc, b.desc), maxW = LW_ - 2 * ML, avail = rowTop - coverBot;
  const met = (str, fs) => { x.font = `500 ${fs}px SCM`; const m = x.measureText(str); return { w: m.actualBoundingBoxRight + m.actualBoundingBoxLeft, asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent }; };
  let fsz = 0, lines = null;
  for (let fs = 52; fs >= 42 && !lines; fs -= 2) { const m = met(TEXT.ch7.footer, fs); if (m.w <= maxW && avail >= m.asc + m.desc + 2 * fs) { fsz = fs; const top = coverBot + (avail - m.asc - m.desc) / 2; lines = [{ s: TEXT.ch7.footer, base: top + m.asc, ...m }]; } }
  if (!lines) { fsz = 40; const FL = TEXT.ch7.footer.split('｜').map(q => q.trim()), m1 = met(FL[0], fsz), m2 = met(FL[1], fsz), b1 = coverBot + fsz + m1.asc; lines = [{ s: FL[0], base: b1, ...m1 }, { s: FL[1], base: b1 + fsz * 1.4, ...m2 }]; }
  const fx = ML, fTop = lines[0].base - lines[0].asc, fBot = lines[lines.length - 1].base + lines[lines.length - 1].desc, fw = Math.max(...lines.map(l => l.w));
  return { A, size, a, b, base, xa, xb, dotX, dotY, dotR, fsz, lines, fx, fw, fTop, fBot, rowTop };
}
const snapP = (t, tk, d = E8) => EZ(seg(t, tk - d, tk));
const FOOT_D = .5;   // 返修：口径小字 177.5 起从切口升起，178.0（第 90 小节第 1 拍）落定
function drawOverlay(x, t, S2) {
  if (!CL) CL = coverLayout(x);
  const L = CL;
  x.save(); x.setTransform(S2, 0, 0, S2, 0, 0); x.textBaseline = 'alphabetic'; x.textAlign = 'left';
  const clipRise = (tk, x0, y0, w, h, draw, d = E8) => { if (t < tk - d) return; x.save(); if (t < tk) { const p = snapP(t, tk, d); x.beginPath(); x.rect(x0 - 6, y0 - 6, w + 12, h + 12); x.clip(); x.translate(0, (1 - p) * (h + 14)); } draw(); x.restore(); };
  // 「选定方向」
  clipRise(TM.coverA, L.xa - L.a.lb, L.base - L.a.asc, L.a.w, L.a.asc + L.a.desc, () => { x.font = `700 ${L.size}px SC`; x.fillStyle = '#141414'; x.fillText(L.A[0], L.xa, L.base); });
  // 朱红「·」+「开始洽谈」
  clipRise(TM.coverB, L.dotX - L.dotR, L.base - L.b.asc, (L.xb - L.b.lb + L.b.w) - (L.dotX - L.dotR), L.b.asc + L.b.desc, () => {
    x.fillStyle = '#BE3A2E'; x.beginPath(); x.arc(L.dotX, L.dotY, L.dotR, 0, Math.PI * 2); x.fill();
    x.font = `700 ${L.size}px SC`; x.fillStyle = '#141414'; x.fillText(L.A[1], L.xb, L.base); });
  // 口径小字
  for (const ln of L.lines) clipRise(TM.footer, L.fx, ln.base - ln.asc, ln.w, ln.asc + ln.desc, () => { x.font = `500 ${L.fsz}px SCM`; x.fillStyle = 'rgba(20,20,20,.8)'; x.fillText(ln.s, L.fx, ln.base); }, FOOT_D);
  x.restore();
}

// ———————————————— 搭建 ————————————————
let R = null, TN = null, CITY = null, CTX = null, plazaObjs = [];
const camT = track(camera);
export async function build(ctx) {
  CTX = ctx;
  R = buildRoom(ctx); ctx.root.add(R.roomG, R.roll);
  CITY = ctx.has('city') ? ctx.use('city') : null;
  if (CITY && CITY.plan && CITY.plan.strokes) TN = buildTan(ctx, CITY.plan);
  if (CITY && CITY.near) plazaObjs = CITY.near.children.filter(o => o !== (CITY.gate && CITY.gate.g));
  for (const f of ['700 150px SC', '500 52px SCM', '800 100px Inter']) await document.fonts.load(f);   // 返修：字体就绪后再量版面（原来可能量到后备字体）
  CL = coverLayout(ctx.kit.cv(8, 8).getContext('2d'));
  ctx.book.setCoverOverlay(COVER_FROM, drawOverlay);
}

// ———————————————— 每帧 ————————————————
const inRoomRect = (x, z, pad = .006) => Math.abs(x - O[0]) < ROOM.hx + pad && Math.abs(z - O[2]) < ROOM.hz + pad;
function cityInterplay(t) {
  if (!CITY || t < TM.ch5Fold[0]) return;
  // 返修：144.5–145.0 先关门（一拍），145.0–145.5 门楼折平；洽谈室 145.5 起在原地铺开、立起
  if (CITY.gate && CITY.gate.retract) CITY.gate.retract(seg(t, TM.ch5Fold[0], TM.ch5Fold[1]));
  // 房间范围里的广场小物、路过的行人：145.0–145.5 缩回纸面（只改第五章每帧都会重设的 scale / visible）
  if (t >= TM.plazaClear[0]) { const k = 1 - ss(seg(t, TM.plazaClear[0], TM.plazaClear[1]));
    for (const o of plazaObjs) if (o.visible && inRoomRect(o.position.x, o.position.z)) {
      if (k < .004) { o.visible = false; continue; }
      const c0 = o.children.length === 1 ? o.children[0] : null, tgt = c0 && c0.userData && c0.userData.body ? c0 : o;   // 小车/行人：第五章每帧重设的是里层的 scale
      tgt.scale.multiplyScalar(k); } }
  // 第 88 小节收城
  if (t >= TM.cityBack[0] && CITY.setRetract) CITY.setRetract(ss(seg(t, TM.cityBack[0], TM.cityBack[1])), t);
}
export function update(t, ctx) {
  cityInterplay(t);
  updateRoom(R, t, ctx);
  if (TN) updateTan(TN, t);
  // 景深：焦点 = 相机到本章镜头目标点（第五章的 update 会按它自己的镜头设焦点，本章晚调用，覆盖之）
  if (t >= TM.roomRise[0]) {
    const k = camT(Math.max(t, camera[0][0])), d = ctx.cam.position.distanceTo(new ctx.THREE.Vector3(k[3], k[4], k[5]));
    ctx.post.dof.focus = Math.max(.05, d); ctx.post.dof.aper = t < 168 ? 1.6 : t < 175.8 ? 2.4 : 3.0; ctx.post.dof.maxCoc = 10;
  }
}

// ———————————————— 画面文字 ————————————————
function boxOfWorld(ctx, pts) { const P = pts.map(p => ctx.project(...p)); return { x0: Math.min(...P.map(p => p[0])), y0: Math.min(...P.map(p => p[1])), x1: Math.max(...P.map(p => p[0])), y1: Math.max(...P.map(p => p[1])) }; }
function coverBox(ctx, u0, v0, u1, v1) { const S = ctx.S; return boxOfWorld(ctx, [[u0, v0], [u1, v0], [u0, v1], [u1, v1]].map(([u, v]) => { const p = S.coverToWorld(u, v); return [p.x, p.y, p.z]; })); }
export function texts(t, ctx) {
  const out = [], onScr = b => b && b.x1 > 0 && b.x0 < 1920 && b.y1 > 0 && b.y0 < 1080 && b.x1 - b.x0 > 2;
  const roomOn = R.roomG.visible && t < TM.roomFold[0];
  if (roomOn) {
    R.steps.forEach((S, k) => {
      if (t >= S.tm.toks[0] - .12) { const b = ctx.screenBox(S.big.g); if (onScr(b)) out.push({ id: `ch67.step.${k}`, text: TEXT.ch6.steps[k], ...b }); }
      if (t >= S.tm.sub - .1) { const b = ctx.screenBox(S.sub.g); if (onScr(b)) out.push({ id: `ch67.sub.${k}`, text: TEXT.ch6.stepSubs[k], ...b }); }
    });
    if (R.boardG.visible && t >= TM.sign - .1) { const b = ctx.screenBox(R.board); if (onScr(b)) out.push({ id: 'ch67.sign', text: TEXT.ch6.folder.title, ...b }); }
    R.rows.forEach((L, i) => { if (t >= TM.rows[i] + E16 - .01) { const b = ctx.screenBox(L.g); if (onScr(b)) out.push({ id: `ch67.row.${i}`, text: TEXT.ch6.folder.rows[i], ...b }); } });
  }
  if (TN && t >= strokeT(0) && t < TM.cityBack[1]) { const B = TN.box; out.push({ id: 'ch67.tan', text: TEXT.ch7.tan, ...boxOfWorld(ctx, [[B.x0, PG, B.z0], [B.x1, PG, B.z0], [B.x0, PG, B.z1], [B.x1, PG, B.z1]]) }); }
  if (CL && t >= TM.coverA - E8) out.push({ id: 'ch67.cover', text: TEXT.ch7.cover, ...coverBox(ctx, CL.xa - CL.a.lb, CL.base - Math.max(CL.a.asc, CL.b.asc), CL.xb - CL.b.lb + CL.b.w, CL.base + Math.max(CL.a.desc, CL.b.desc)) });
  if (CL && t >= TM.footer - FOOT_D * .3) out.push({ id: 'ch67.footer', text: TEXT.ch7.footer, ...coverBox(ctx, CL.fx, CL.fTop, CL.fx + CL.fw, CL.fBot) });
  return out;
}
export function probe(t) {
  return { room: +R.roomG.scale.y.toFixed(4), lead: R.figs[0].g.position.toArray().map(v => +v.toFixed(4)), tan: TN ? TN.strokes.map(S => S.parts.reduce((n, P) => n + P.me.geometry.drawRange.count / 6, 0)) : null };
}
export const coverLayoutInfo = () => CL && { base: CL.base, a: CL.a, b: CL.b, fsz: CL.fsz, lines: CL.lines, rowTop: CL.rowTop };   // 几何检查用（tools/geo.mjs）
