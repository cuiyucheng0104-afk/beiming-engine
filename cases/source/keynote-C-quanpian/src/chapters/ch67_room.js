// 第六章 洽谈室：等距绘本的一间屋（地板、两面后墙、矮前墙、门、会议桌）、地面印字、三个无脸背影小人、文件夹 → 立牌 → 三条纸条。
// 整间屋是一个立体件：roomG 原点在地板面（世界 O），scale.y 0→1 = 从纸面立起，1→0 = 折平。全部是 t 的纯函数。
import * as THREE from 'three';
import { clamp, lerp, seg, ss, eo, ei, eio } from '/core/lib.js';
import { TEXT } from '../shared/texts.js';
import { TM, E8, E16, stepTimes, O, ROOM, FIG_H, BIG, SMALL, STATION_X, PHRASE_Z, LANE_Z, TABLE, BOARD, START, STOP, FINAL } from './ch67_plan.js';

const D2R = Math.PI / 180;
const CREAM = '#F2E5CE', WALL = '#EFE3CB', WALL2 = '#E4D5BA', ULTRA = '#3F5596', ULTRA_D = '#2E3F73', GOLDM = '#D9A441';
let K, INK, VERM, GRAIN, cv, popAt, texOf;

// —— 小工具 ——
function stdMat(o = {}) { return new THREE.MeshStandardMaterial({ roughness: .9, ...o }); }
function box(w, h, d, mat) { const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0); const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; return m; }
function grainOver(x, w, h, a = .8) { x.save(); x.globalCompositeOperation = 'source-atop'; x.globalAlpha = a; x.fillStyle = x.createPattern(GRAIN, 'repeat'); x.fillRect(0, 0, w, h); x.restore(); }
// 印泥：字边缘的纸纹缺口（destination-out 纸纹，几遍）
function inkRough(c) { const x = c.getContext('2d'); x.save(); x.globalCompositeOperation = 'destination-out'; x.fillStyle = x.createPattern(GRAIN, 'repeat'); for (let i = 0; i < 6; i++) { x.setTransform(1, 0, 0, 1, i * 37, i * 53); x.fillRect(-60, -60, c.width + 120, c.height + 120); } x.restore(); return c; }
// 平放在地面上的面片：本地 X = 阅读方向（世界 −z），本地 Y = 字头方向（世界 −x），法线 +y
const FLOOR_Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)));
function flatMesh(c, w, h, o = {}) {
  const t = texOf(c), m = stdMat({ map: t, transparent: true, depthWrite: false, roughness: .95, polygonOffset: true, polygonOffsetFactor: -2 - (o.lift || 0), polygonOffsetUnits: -2 });
  const me = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); me.quaternion.copy(FLOOR_Q); me.receiveShadow = true; return me;
}

// —— 地面字：一行拆成 token（连续的拉丁字母合成一个，空格只占位）——
function tokenize(str) { const out = []; let gap = 0; for (const m of str.matchAll(/[A-Za-z0-9]+|\s|./gu)) { if (/\s/.test(m[0])) { gap += 1; continue; } out.push({ s: m[0], gap }); gap = 0; } return out; }
function floorLine(str, { sizeM, f, ppm, perToken }) {
  const meas = cv(4, 4).getContext('2d'); meas.font = K.font(f, sizeM * ppm);
  const g = new THREE.Group(), items = []; let s = 0;
  const toks = perToken ? tokenize(str) : [{ s: str, gap: 0 }];
  toks.forEach((tk, i) => {
    s += tk.gap * sizeM * .3;
    const adv = meas.measureText(tk.s).width / ppm;
    const a = K.textArt(tk.s, { sizeM, ppm, f, color: INK }); inkRough(a.c);
    const me = flatMesh(a.c, a.w, a.h); me.position.set(0, 0, -(s + adv / 2)); g.add(me);
    items.push({ me, s0: s, adv }); s += adv + (i < toks.length - 1 ? sizeM * .06 : 0);
  });
  g.userData.len = s; return { g, items };
}

// —— 小人：背影、无脸、无手；腿剪刀步、手臂反向摆。按腿角量化成 15 张贴图 ——
const TOPS = [['#C9A063', '#A9824A', '#DDBB86'], ['#8FA3B8', '#73879C', '#AABBCD'], ['#9C8FA8', '#7F738C', '#B5AABF']];
const LEGS = ['#4A4038', '#3E4A5C', '#5A4E46'], HAIR = '#2E2622', SKIN = '#D9A88A', SHOE = '#231C18';
const NPOSE = 15, AMAX = .34, PW = 160, PH = 380, FW = FIG_H * PW / PH * 1.0;
function drawPerson(x, k, ang, holds) {
  const W = PW, H = PH, u = H / 1.04, top = TOPS[k], cx = W / 2, foot = H - 6;
  const Y = v => foot - v * u;                       // v = 身高比例 0（脚底）…1（头顶）
  x.clearRect(0, 0, W, H); x.lineJoin = 'round';
  const bob = Math.abs(ang) / AMAX * .012;
  const hip = Y(.50 + bob), legW = u * .095, legL = u * .47;
  // 腿（先画后面那条）
  const leg = (sgn, a, col) => { x.save(); x.translate(cx + sgn * u * .055, hip); x.rotate(a);
    x.fillStyle = col; x.beginPath(); x.roundRect(-legW / 2, 0, legW, legL - u * .03, legW * .3); x.fill();
    x.fillStyle = SHOE; x.beginPath(); x.roundRect(-legW * .6, legL - u * .05, legW * 1.2, u * .05, u * .02); x.fill(); x.restore(); };
  const legC = LEGS[k], legD = shade(legC, -.18);
  if (ang >= 0) { leg(1, -ang, legD); leg(-1, ang, legC); } else { leg(-1, ang, legD); leg(1, -ang, legC); }
  // 手臂（袖子，比躯干暗一档），与腿反向摆
  const sh = Y(.80 + bob), armW = u * .07, armL = u * .30;
  const arm = (sgn, a) => { x.save(); x.translate(cx + sgn * u * .155, sh); x.rotate(a); x.fillStyle = top[1]; x.beginPath(); x.roundRect(-armW / 2, 0, armW, armL, armW * .45); x.fill(); x.restore(); };
  arm(-1, -ang * .8 + .05); if (holds) arm(1, -.12); else arm(1, ang * .8 - .05);
  // 躯干：两色（左亮右暗）+ 肩上一道亮
  const t0 = Y(.83 + bob), t1 = Y(.49 + bob), tw = u * .30;
  x.fillStyle = top[0]; x.beginPath(); x.roundRect(cx - tw / 2, t0, tw, t1 - t0, [u * .07, u * .07, u * .03, u * .03]); x.fill();
  x.save(); x.beginPath(); x.roundRect(cx - tw / 2, t0, tw, t1 - t0, [u * .07, u * .07, u * .03, u * .03]); x.clip();
  x.fillStyle = top[1]; x.fillRect(cx + tw * .12, t0, tw, t1 - t0); x.fillStyle = top[2]; x.fillRect(cx - tw / 2, t0, tw, u * .035); x.restore();
  // 脖子 + 头（后脑勺：发色圆，耳边一线肤色）
  x.fillStyle = SKIN; x.fillRect(cx - u * .035, Y(.875 + bob), u * .07, u * .05);
  const hr = u * .085, hy = Y(.915 + bob);
  x.fillStyle = SKIN; x.beginPath(); x.ellipse(cx + hr * .93, hy + hr * .15, hr * .16, hr * .28, 0, 0, 7); x.fill();
  x.fillStyle = HAIR; x.beginPath(); x.arc(cx, hy, hr, 0, 7); x.fill();
}
function shade(hex, a) { const c = new THREE.Color(hex); if (a < 0) c.lerp(new THREE.Color('#3A2A20'), -a); else c.lerp(new THREE.Color('#FFF6E6'), a); return '#' + c.getHexString(); }
function makeFigure(k, holds) {
  const texs = [];
  for (let i = 0; i < NPOSE; i++) { const c = cv(PW, PH), ang = (i / (NPOSE - 1) * 2 - 1) * AMAX; drawPerson(c.getContext('2d'), k, ang, holds); texs.push(texOf(c)); }
  const m = stdMat({ map: texs[(NPOSE - 1) / 2], alphaTest: .5, side: THREE.DoubleSide, roughness: .85 });
  const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: texs[(NPOSE - 1) / 2], alphaTest: .5, side: THREE.DoubleSide });
  const geo = new THREE.PlaneGeometry(FW, FIG_H); geo.translate(0, FIG_H / 2, 0);
  const me = new THREE.Mesh(geo, m); me.castShadow = true; me.receiveShadow = true; me.customDepthMaterial = dm; me.rotation.y = 45 * D2R;
  const g = new THREE.Group(); g.add(me);
  return { g, me, setPose(ang) { const i = Math.round((clamp(ang / AMAX, -1, 1) + 1) / 2 * (NPOSE - 1)); if (m.map !== texs[i]) { m.map = texs[i]; dm.map = texs[i]; } } };
}

// —— 走路：每个人一串路段 [t0, t1, 路径点]，路段之间站着。脚步落在八分音符上 ——
function pathLen(P) { let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return L; }
function pathAt(P, s) { for (let i = 1; i < P.length; i++) { const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); if (s <= l || i === P.length - 1) { const u = l ? clamp(s / l) : 1; return [lerp(P[i - 1][0], P[i][0], u), lerp(P[i - 1][1], P[i][1], u)]; } s -= l; } return P[P.length - 1]; }
const walkEase = u => u - Math.sin(2 * Math.PI * u) / (2 * Math.PI);

export function buildRoom(ctx) {
  K = ctx.kit; ({ INK, VERM } = K); GRAIN = null; cv = K.cv; popAt = K.popAt; texOf = K.texOf;
  // GRAIN：kit 没导出，借 finishCut 的纸纹——自己做一张同样的
  GRAIN = (() => { const n = 256, c = cv(n, n), x = c.getContext('2d'), R = K.mulberry(11), img = x.createImageData(n, n), d = img.data;
    for (let i = 0; i < n * n; i++) { const v = R(); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v < .5 ? 0 : 255; d[i * 4 + 3] = Math.abs(v - .5) * 34; } x.putImageData(img, 0, 0); return c; })();

  const roomG = new THREE.Group(); roomG.name = 'ch67.room'; roomG.position.set(O[0], O[1] + .0003, O[2]);
  const R = ROOM, FT = R.floorT, all = { roomG };
  // ———— 地板（地毯纸 + 淡格 + 走道） ————
  {
    const ppm = 8000, w = 2 * R.hx * ppm, h = 2 * R.hz * ppm, c = cv(w, h), x = c.getContext('2d');
    const X = lx => (lx + R.hx) * ppm, Z = lz => (lz + R.hz) * ppm;     // 画布 u = 局部 x，v = 局部 z（顶视图，+z 向下）
    x.fillStyle = CREAM; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(120,90,60,.075)'; x.lineWidth = 3;
    for (let lx = -R.hx; lx <= R.hx + 1e-6; lx += .01) { x.beginPath(); x.moveTo(X(lx), 0); x.lineTo(X(lx), h); x.stroke(); }
    for (let lz = -R.hz; lz <= R.hz + 1e-6; lz += .01) { x.beginPath(); x.moveTo(0, Z(lz)); x.lineTo(w, Z(lz)); x.stroke(); }
    x.fillStyle = '#EAD9BA'; x.fillRect(0, Z(LANE_Z - .0105), w, .021 * ppm);           // 走道
    x.strokeStyle = GOLDM; x.lineWidth = 7; x.setLineDash([46, 34]);
    for (const zz of [LANE_Z - .0105, LANE_Z + .0105]) { x.beginPath(); x.moveTo(X(-.064), Z(zz)); x.lineTo(w, Z(zz)); x.stroke(); }
    x.setLineDash([]);
    grainOver(x, w, h, .9);
    const geo = new THREE.BoxGeometry(2 * R.hx, FT, 2 * R.hz); geo.translate(0, FT / 2, 0);
    const side = stdMat({ color: '#D8C7A8' }), topM = stdMat({ map: texOf(c), roughness: .93 });
    // BoxGeometry 的 +y 面 UV：u 沿 +x，v 沿 −z（翻一下让画布 v = +z）
    const uv = geo.attributes.uv; for (let i = 8; i < 12; i++) uv.setY(i, 1 - uv.getY(i));
    const floor = new THREE.Mesh(geo, [side, side, topM, side, side, side]); floor.receiveShadow = true; floor.castShadow = true;
    roomG.add(floor); all.floor = floor; all.floorMats = [side, topM];
  }
  // ———— 墙：后墙（−z、−x）满高带窗，前墙（+z、+x）切到矮栏，+x 墙开门 ————
  {
    const ppm = 6000, wallArt = (len, H, windows) => {
      const c = cv(len * ppm, H * ppm), x = c.getContext('2d'), w = c.width, h = c.height;
      x.fillStyle = WALL; x.fillRect(0, 0, w, h);
      x.fillStyle = ULTRA; x.fillRect(0, h - .0035 * ppm, w, .0035 * ppm);           // 墙裙：群青
      for (const [c0, c1] of windows) {
        const x0 = c0 * ppm, x1 = c1 * ppm, y0 = h - .025 * ppm, y1 = h - .0095 * ppm;
        x.fillStyle = '#FFFCF4'; x.fillRect(x0 - 10, y0 - 10, x1 - x0 + 20, y1 - y0 + 20);
        const gg = x.createLinearGradient(0, y0, 0, y1); gg.addColorStop(0, '#C3D3D6'); gg.addColorStop(1, '#DCE6E4'); x.fillStyle = gg; x.fillRect(x0, y0, x1 - x0, y1 - y0);
        x.fillStyle = INK; x.fillRect((x0 + x1) / 2 - 4, y0, 8, y1 - y0); x.fillRect(x0, (y0 + y1) / 2 - 4, x1 - x0, 8);
      }
      grainOver(x, w, h, .8); return c;
    };
    const mk = (len, H, windows, rotY, pos) => {
      const art = wallArt(len, H, windows), geo = new THREE.BoxGeometry(len, H, .002); geo.translate(0, H / 2, 0);
      const inner = stdMat({ map: texOf(art), roughness: .9 }), other = stdMat({ color: WALL2 }), edge = stdMat({ color: '#B4A894' });
      const me = new THREE.Mesh(geo, [edge, edge, edge, edge, inner, other]); me.castShadow = me.receiveShadow = true;
      me.rotation.y = rotY; me.position.set(...pos); roomG.add(me); return me;
    };
    mk(2 * R.hx, R.wallH, [[.074, .104], [.120, .150], [.164, .194]], 0, [0, FT, -R.hz + .001]);                 // −z 墙（右上），内面朝 +z
    mk(2 * R.hz, R.wallH, [], Math.PI / 2, [-R.hx + .001, FT, 0]);                                                 // −x 墙（左上），内面朝 +x
    mk(2 * R.hx, R.lowH, [], Math.PI, [0, FT, R.hz - .001]);                                                       // +z 矮栏（左下），内面朝 −z
    const dz0 = -R.hz, dz1 = R.door[0], dl = dz1 - dz0;
    mk(dl, R.lowH, [], -Math.PI / 2, [R.hx - .001, FT, (dz0 + dz1) / 2]);                                          // +x 矮栏（右下），门洞在 z ∈ door
  }
  // ———— 会议桌（群青）、两盆植物 ————
  {
    const T = TABLE, tw = T.x[1] - T.x[0], td = T.z[1] - T.z[0];
    const top = box(tw, .0012, td, stdMat({ color: ULTRA })); top.position.set((T.x[0] + T.x[1]) / 2, FT + T.h - .0012, (T.z[0] + T.z[1]) / 2); roomG.add(top);
    const base = box(tw * .55, T.h - .0012, td * .8, stdMat({ color: ULTRA_D })); base.position.set((T.x[0] + T.x[1]) / 2, FT, (T.z[0] + T.z[1]) / 2); roomG.add(base);
    for (const [px, pz] of [[-.090, -.053], [.088, -.053]]) {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(.0032, .0026, .0045, 12).translate(0, .00225, 0), stdMat({ color: '#C9A063' })); pot.position.set(px, FT, pz); pot.castShadow = pot.receiveShadow = true; roomG.add(pot);
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(.0058, 0), stdMat({ color: '#3D6B59', flatShading: true })); leaf.position.set(px, FT + .0098, pz); leaf.castShadow = leaf.receiveShadow = true; roomG.add(leaf);
    }
  }
  // ———— 地面字：四步 ————
  const steps = TEXT.ch6.steps.map((str, k) => {
    const xk = STATION_X[k], big = floorLine(str, { sizeM: BIG, f: 'SC', ppm: 20000, perToken: true });
    big.g.position.set(xk - BIG * .52, FT + .00012, PHRASE_Z); roomG.add(big.g);
    const sub = floorLine(TEXT.ch6.stepSubs[k], { sizeM: SMALL, f: 'SCM', ppm: 28000, perToken: false });
    sub.g.position.set(xk + .0036 + SMALL * .5, FT + .00012, PHRASE_Z); roomG.add(sub.g);
    // 朱红方块（与开头纸条标签句首同一个记号）
    const mc = cv(120, 120), mx = mc.getContext('2d'); mx.fillStyle = VERM; mx.fillRect(10, 10, 100, 100); inkRough(mc);
    const mark = flatMesh(mc, .0042, .0042); mark.position.set(xk - BIG * .52, FT + .00012, PHRASE_Z + .0058); roomG.add(mark);
    return { big, sub, mark, tm: stepTimes(k, big.items.length) };
  });
  all.steps = steps;
  // ———— 朱红箭头：走道上一串人字形，在领头人前方生长、身后淡去 ————
  const chev = [];
  {
    const c = cv(160, 160), x = c.getContext('2d'); x.strokeStyle = VERM; x.lineWidth = 26; x.lineCap = 'square'; x.lineJoin = 'miter';
    x.beginPath(); x.moveTo(40, 30); x.lineTo(110, 80); x.lineTo(40, 130); x.stroke(); inkRough(c);
    for (let lx = .118; lx > -.066; lx -= .0062) { const me = flatMesh(c, .0036, .0036, { lift: 1 }); me.rotation.set(0, 0, 0); me.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI)); me.position.set(lx, FT + .00018, LANE_Z); roomG.add(me); chev.push({ me, x: lx }); }
  }
  // ———— 小人 ————
  const figs = [0, 1, 2].map(k => { const f = makeFigure(k, k === 0); roomG.add(f.g); return f; });
  // 每个人的路段
  const walks = [];
  for (let k = 0; k < 4; k++) {
    const { walk } = steps[k].tm, from = k === 0 ? START : STOP(k - 1), to = k === 3 ? null : STOP(k);
    for (let i = 0; i < 3; i++) {
      const d = i * E16, P = k === 3 ? [from[i], [FINAL[i][0] + .008, LANE_Z], FINAL[i]] : [from[i], to[i]];
      (walks[i] ||= []).push({ t0: walk[0] + d, t1: walk[1] + d, P, L: pathLen(P) });
    }
  }
  all.walks = walks;
  // ———— 文件夹（朱红）：领头人夹着 → 放上桌 → 翻开 ————
  const folder = new THREE.Group(), FWd = .0086, FDp = .0064, FTk = .00035;
  {
    const red = stdMat({ color: VERM, roughness: .7 }), paper = stdMat({ color: '#FBF4E4' });
    const back = box(FWd, FTk, FDp, red); folder.add(back);
    const inside = new THREE.Mesh(new THREE.PlaneGeometry(FWd * .94, FDp * .94), paper); inside.rotation.x = -Math.PI / 2; inside.position.y = FTk + .00005; inside.receiveShadow = true; folder.add(inside);
    const hinge = new THREE.Group(); hinge.position.set(-FWd / 2, FTk, 0); folder.add(hinge);
    const cover = box(FWd, FTk, FDp, red); cover.position.set(FWd / 2, 0, 0); hinge.add(cover);
    const cin = new THREE.Mesh(new THREE.PlaneGeometry(FWd * .94, FDp * .94), paper); cin.rotation.x = Math.PI / 2; cin.position.set(FWd / 2, -.00002, 0); hinge.add(cin);
    folder.userData.hinge = hinge; roomG.add(folder);
  }
  // ———— 立牌（从文件夹里弹起，面朝 +x）+ 三条纸条 ————
  const boardG = new THREE.Group(); boardG.position.set(BOARD.x, FT + TABLE.h + FTk * 2, BOARD.z); roomG.add(boardG);
  let board, title, rows;
  {
    const ppm = 40000, w = BOARD.w, h = BOARD.h, pad = 40, c = cv(w * ppm, h * ppm), x = c.getContext('2d'), W = c.width, H = c.height;
    x.beginPath(); x.roundRect(pad, pad, W - 2 * pad, H - 2 * pad, 26); x.fillStyle = '#FBF4E4'; x.fill(); x.lineWidth = 16; x.strokeStyle = INK; x.stroke();
    x.strokeStyle = 'rgba(58,42,32,.45)'; x.lineWidth = 5; x.strokeRect(pad + 34, pad + 34, W - 2 * pad - 68, H - 2 * pad - 68);
    const fs = .0046 * ppm, ty = pad + 70 + fs * .62, sq = fs * .42;
    x.fillStyle = VERM; x.fillRect(pad + 110, ty - sq / 2, sq, sq);
    x.font = K.font('SC', fs); x.fillStyle = INK; x.textBaseline = 'middle'; x.fillText(TEXT.ch6.folder.title, pad + 110 + sq + fs * .45, ty + fs * .04);
    x.fillStyle = INK; x.fillRect(pad + 110, ty + fs * .78, W - 2 * pad - 220, 10);
    grainOver(x, W, H, .7);
    board = K.piece(c, w, h, { border: 26 }); boardG.add(board);
    title = { box: [pad + 110, ty - fs * .6, pad + 110 + sq + fs * .45 + x.measureText(TEXT.ch6.folder.title).width, ty + fs * .6], W, H };
    rows = TEXT.ch6.folder.rows.map((str, i) => { const L = K.label(str, { w: .0405, h: .0056, ppm: 50000 }); L.g.position.set(.0005, .0167 - i * .0076, .0006); board.add(L.g); return L; });
  }
  Object.assign(all, { figs, chev, folder, boardG, board, rows, title });
  // 返修：地板不再在 145.5 一帧顶替广场——整间屋用一张世界坐标裁切面，145.5–146.0 从门楼折线（房间后沿）向镜头推开，前沿压着一个越滚越细的纸卷
  const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e3);
  ctx.renderer.localClippingEnabled = true;
  roomG.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) { m.clippingPlanes = [clip]; m.clipShadows = true; } });
  const rollM = stdMat({ color: '#EADBBE', roughness: .93 });
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2 * R.hx + .002, 28, 1).rotateZ(Math.PI / 2), rollM); roll.castShadow = roll.receiveShadow = true; roll.visible = false;
  Object.assign(all, { clip, roll });
  return all;
}

// ———————————————— 每帧 ————————————————
export function roomScale(t) {   // 立起 / 折平
  if (t < TM.roomRise[0]) return 0;
  if (t < TM.roomFold[0]) return Math.max(.001, popAt(t, TM.roomRise[1], .9));
  return Math.max(0, 1 - ei(seg(t, TM.roomFold[0], TM.roomFold[1])));
}
function figState(walks, i, t) {
  const W = walks[i];
  let P0 = W[0].P[0];
  for (const w of W) {
    if (t < w.t0) return { p: P0, ang: 0 };
    if (t <= w.t1) {
      const u = seg(t, w.t0, w.t1), p = pathAt(w.P, w.L * walkEase(u));
      const ph = Math.PI / 2 + Math.PI * (t - w.t0) / E8, env = Math.min(1, (t - w.t0) / .1, (w.t1 - t) / .14);
      return { p, ang: AMAX * Math.sin(ph) * clamp(env), walking: true };
    }
    P0 = w.P[w.P.length - 1];
  }
  return { p: P0, ang: 0 };
}
export function updateRoom(R, t, ctx) {
  // 地毯式铺开（返修）：裁切面 z ≤ zc，纸卷在 zc 处滚向镜头、半径越来越小
  { const [r0, r1] = TM.floorRoll, u = seg(t, r0, r1), z0 = O[2] - ROOM.hz - .002, z1 = O[2] + ROOM.hz + .004;
    if (t >= r0 && t < r1) { const e = eio(u), zc = lerp(z0, z1, e), rr = .0008 + .0042 * Math.sqrt(1 - e);
      R.clip.constant = zc; R.roll.visible = true; R.roll.scale.set(1, rr, rr); R.roll.position.set(O[0], O[1] + .0003 + rr, zc); R.roll.rotation.x = -(zc - z0) / rr * .2; }
    else { R.clip.constant = t < r0 ? -1e3 : 1e3; R.roll.visible = false; } }
  const s = roomScale(t);
  R.roomG.visible = s > 0.0015 || (t >= TM.roomRise[0] && t < TM.roomFold[0]);
  if (!R.roomG.visible) return;
  R.roomG.scale.y = Math.max(.001, s);
  const fold = seg(t, TM.roomFold[0], TM.roomFold[1]), inkA = 1 - ss(fold);
  for (const m of R.floorMats) { m.transparent = fold > 0; m.opacity = 1 - fold; }
  // 地面字
  for (const S of R.steps) {
    const { T, toks, sub } = S.tm;
    const land = (me, tb, d, s0) => { const p = seg(t, tb - d, tb); me.visible = t >= tb - d; me.material.opacity = eo(p) * inkA; const sc = s0 - (s0 - 1) * eo(p); me.scale.set(sc, sc, 1); };
    land(S.mark, T, .1, 1.5);
    S.big.items.forEach((it, j) => land(it.me, toks[j], .12, 1.28));
    land(S.sub.items[0].me, sub, .1, 1.07);
  }
  // 小人
  let lead = null;
  R.figs.forEach((f, i) => {
    const st = figState(R.walks, i, t);
    f.g.position.set(st.p[0], R.floor.geometry.parameters.height * clamp((ROOM.hx + .004 - st.p[0]) / .008), st.p[1]);
    f.setPose(st.ang);
    f.me.scale.y = st.walking ? 1 : 1 + .006 * Math.sin(2 * Math.PI * (t / 2.4 + i / 3));
    if (i === 0) lead = st;
  });
  // 箭头：当前这一段路
  let wk = null; for (const w of R.walks[0]) if (t >= w.t0 - .6 && t <= w.t1 + .5) { wk = w; break; }
  for (const c of R.chev) {
    let a = 0;
    if (wk) {
      const x0 = wk.P[0][0], x1 = wk.P[wk.P.length - 1][0] - .002, span = Math.max(1e-4, x0 - x1);
      if (c.x < x0 - .004 && c.x > x1 - .003) {
        const grow = seg(t, wk.t0 - .5 + .4 * (x0 - c.x) / span, wk.t0 - .38 + .4 * (x0 - c.x) / span);
        const behind = clamp((lead.p[0] - .003 - c.x) / .006);          // 领头人走过就淡掉
        a = grow * behind * (1 - seg(t, wk.t1, wk.t1 + .4));
      }
    }
    c.me.visible = a > .01; c.me.material.opacity = a * inkA;
  }
  // 文件夹
  const FT = R.floor.geometry.parameters.height, F = R.folder, lf = R.figs[0].g.position;
  const tl = TM.folderLift, tf = TM.folder;
  const held = new THREE.Vector3(lf.x + .0026, FT + .0062, lf.z - .0026 + .0016);     // 领头人右侧（屏幕右），略朝镜头
  const onTable = new THREE.Vector3(BOARD.x, FT + TABLE.h, BOARD.z + .003);
  const qHeld = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 45 * D2R, 0, 'YXZ')), qFlat = new THREE.Quaternion();
  if (t < tl) { F.position.copy(held); F.position.y -= F.userData.hold || 0; F.quaternion.copy(qHeld); }
  else { const u = seg(t, tl, tf), e = eio(u); F.position.lerpVectors(held, onTable, e); F.position.y += Math.sin(Math.PI * u) * .006; F.quaternion.slerpQuaternions(qHeld, qFlat, ss(u)); }
  F.userData.hinge.rotation.z = Math.PI * eio(seg(t, TM.folderOpen - .4, TM.folderOpen));
  if (t >= TM.folderOpen) F.userData.hinge.rotation.z = Math.PI - .05 * Math.sin(Math.PI * seg(t, TM.folderOpen, TM.folderOpen + .15));
  // 立牌：从文件夹里弹起（宽度从文件夹宽展开）
  const pb = popAt(t, TM.sign, .62);
  R.boardG.visible = t >= TM.sign - .62 * K.BX;
  R.board.rotation.x = Math.PI / 2 * (1 - pb);
  R.board.scale.x = lerp(.18, 1, ss(seg(t, TM.sign - .3, TM.sign)));
  // 纸条：贴着立牌从水平翻起到竖直，立起后每十六分音符打一个字
  R.rows.forEach((L, i) => {
    const tb = TM.rows[i], p = popAt(t, tb, .5);
    L.g.visible = t >= tb - .5 * K.BX;
    L.g.rotation.x = Math.PI / 2 * (1 - p);
    let n = 0; const N = [...L.text].length; for (let j = 0; j < N; j++) if (rowTypeT(i, j) <= t + 1e-6) n = j + 1;
    L.set(n);
  });
}
// 打字时刻（给 events）：第 i 条第 j 个字
export const rowTypeT = (i, j) => +(Math.round((TM.rows[i] + (j + 1) * E16) * 30) / 30).toFixed(4);
