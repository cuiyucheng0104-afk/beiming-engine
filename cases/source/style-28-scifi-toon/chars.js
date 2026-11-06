// chars.js — 本片原创角色：高瘦（冷面）、矮胖（慌张）、收银员（可疑地正常），以及道具（冰淇淋桶、冰棍、手）
// 局部坐标：原点在脚底，y 向下为正（向上为负）；face=1 朝右（3/4 侧），-1 镜像。
import { clamp, lerp, hash, TAU } from '/core/lib.js';
import { INK, push, pop, translate, rotate, scale, shape, fillOnly, stroke, ell, arc, spline, rr, rect, noodle, quad, dot, S } from './engine/toon.js';

export const PAL = {
  white: '#ffffff', mouthIn: '#4a1a2a', tongue: '#e8637a',
  // 高瘦：雾紫皮肤 + 芥末黄长围巾
  tSkin: '#aba4e2', tSkinS: '#8a82c6', tBelly: '#c3bdee', scarf: '#dba73c', scarfS: '#b5852a', tShoe: '#4a3a52',
  // 矮胖：番茄珊瑚 + 鱼缸头盔
  sSkin: '#ee7b5c', sSkinS: '#c85d42', sBelly: '#f6a585', glass: 'rgba(236,240,255,.22)', collar: '#6d7480', collarS: '#525866', sShoe: '#3a3550',
  // 收银员
  cSkin: '#e9c9a1', cSkinS: '#cfa77d', hair: '#6b4a32', hairS: '#4f3524', uni: '#8f9a7e', uniS: '#707b60', gum: '#f29ab7', gumS: '#d9789a', tag: '#f3ead2',
  // 冰（非发光色：冰棍不是装置，所以用淡紫白，不用冰青）
  ice: 'rgba(236,233,252,.52)', iceLine: '#b9b2e4', stick: '#d9b884', stickS: '#b8955f',
};

// —— 脸部零件 ——
export function eye(cx, cy, rx, ry, { lid = 0, look = [0, 0], pupil = 4.5, skin, closed = false, lw = 6, jit = [0, 0], lower = 0 } = {}) {
  if (closed) { stroke(arc(cx, cy + ry * .1, rx * .85, ry * .35, Math.PI * .08, Math.PI * .92, 14), lw); return; }
  shape(ell(cx, cy, rx, ry, 36), {
    fill: PAL.white, lw, shade: () => {
      dot(cx + look[0] * rx * .55 + jit[0], cy + look[1] * ry * .5 + jit[1], pupil);
      if (lid > 0) {
        const yl = cy - ry + lid * 2 * ry;
        fillOnly([[cx - rx * 1.3, cy - ry * 1.5], [cx + rx * 1.3, cy - ry * 1.5], [cx + rx * 1.3, yl], [cx - rx * 1.3, yl + ry * .06]], skin, { boil: .5 });
        stroke([[cx - rx * 1.2, yl + ry * .06], [cx + rx * 1.2, yl]], lw);
      }
      if (lower > 0) { const yb = cy + ry - lower * 2 * ry; fillOnly([[cx - rx * 1.3, yb], [cx + rx * 1.3, yb], [cx + rx * 1.3, cy + ry * 1.5], [cx - rx * 1.3, cy + ry * 1.5]], skin, { boil: .5 }); stroke([[cx - rx * 1.2, yb], [cx + rx * 1.2, yb]], lw * .8); }
    }
  });
}
export function mouth(cx, cy, mw, { o = 0, w = 1, sm = 0, skew = 0, lw = 6, teeth = true } = {}) {
  const hw = mw * w / 2, k = mw * .22, lc = [cx - hw, cy - sm * k + skew * k], rc = [cx + hw, cy - sm * k - skew * k];
  if (o < .07) { stroke(quad(lc, [cx, cy + sm * k * 1.3], rc, 12), lw); return; }
  const h = o * mw * .62;
  const up = quad(lc, [cx, cy - h * .25 + sm * k * .4], rc, 12), dn = quad(rc, [cx, cy + h + sm * k * .6], lc, 14);
  shape([...up, ...dn], {
    fill: PAL.mouthIn, lw, shade: () => {
      if (teeth && o > .25) fillOnly(rect(cx - hw * 1.2, cy - h * .6, hw * 2.4, h * .38), PAL.white, { boil: .3 });
      fillOnly(ell(cx + hw * .12, cy + h * .95, hw * .62, h * .45, 20), PAL.tongue, { boil: .3 });
    }
  });
}
function brow(x0, y0, x1, y1, lw = 7) { stroke([[x0, y0], [x1, y1]], lw); }
// 手套式卡通手：ang 指向，r 大小
export function hand(x, y, ang, r, col, { grip = 0, lw = 6 } = {}) {
  push(); translate(x, y); rotate(ang);
  const pts = grip > .5
    ? spline([[-r * .7, -r * .8], [r * .6, -r * .95], [r * 1.15, -r * .3], [r * 1.05, r * .55], [r * .2, r * .95], [-r * .7, r * .8], [-r * 1, 0]])
    : spline([[-r * .6, -r * .8], [r * .4, -r * 1.0], [r * 1.4, -r * .8], [r * 1.0, -r * .32], [r * 1.55, -r * .12], [r * 1.05, r * .28], [r * 1.35, r * .7], [r * .5, r * .95], [-r * .6, r * .8], [-r * .95, 0]]);
  shape(pts, { fill: col, lw });
  stroke([[r * .1, -r * .2], [r * .7, -r * .5]], lw * .6);
  pop();
}

// 统一的身体阴影：在 fill 内画一块偏右下的深色形状（硬边）
const shadeBlob = (cx, cy, rx, ry, col) => () => fillOnly(ell(cx, cy, rx, ry, 30), col, { boil: .35 });

// —— 高瘦 ——
// P: {x,y,s,face,lean,sq,lid,look,brow,mouth,blink,handR,handL,tilt,shrug,scarfWind:[dx,dy],stretch,jit}
export function tall(P) {
  const f = P.face ?? 1, s = P.s ?? 1;
  push(); translate(P.x, P.y); rotate(P.rot || 0); scale(s * f * (P.stx ?? 1), s * (P.sq ?? 1));
  const lean = P.lean ?? 0, sh = (P.shrug || 0) * 22;
  const hipY = -230, shY = -392 - sh * .4, neckTop = -468;
  const lx = P.legs || [0, 0];
  // 腿
  for (const [sx, dx] of [[-1, lx[0]], [1, lx[1]]]) {
    const hip = [sx * 18, hipY], ank = [sx * 24 + dx, -20];
    shape(noodle(hip, ank, sx * -5, 24, 19), { fill: PAL.tSkin, lw: 7, shade: () => fillOnly(rect(sx > 0 ? 6 : -40, -300, 34, 300), PAL.tSkinS, { boil: .3 }) });
    shape(spline([[ank[0] - 18, ank[1] + 18], [ank[0] - 16, ank[1] - 4], [ank[0] + 14, ank[1] - 6], [ank[0] + 44, ank[1] + 6], [ank[0] + 40, ank[1] + 20]]), { fill: PAL.tShoe, lw: 7 });
  }
  push(); translate(0, hipY); rotate(lean); translate(0, -hipY);
  // 围巾尾巴：从颈后垂到膝盖，末端有流苏（不碰地，免得读成第三条腿）
  const wind = P.scarfWind || [0, 0];
  const a0 = [24, -446], a1 = [70 + wind[0] * .45, -300 + wind[1] * .45], a2 = [92 + wind[0] * .8, -170 + wind[1] * .85];
  shape(noodle(a0, a2, 30 + wind[0] * .05, 44, 40), { fill: PAL.scarf, lw: 7, shade: () => { for (let k = 0; k < 3; k++) fillOnly(rect(-400, -390 + k * 70 + wind[1] * .5, 800, 14), PAL.scarfS, { boil: .3 }); } });
  for (let k = -1; k <= 1; k++) stroke([[a2[0] + k * 12, a2[1] + 14], [a2[0] + k * 14 + wind[0] * .1, a2[1] + 40 + wind[1] * .05]], 5);
  // 躯干
  const torso = spline([[-30, hipY + 6], [-40, -300], [-36, shY + 10], [0, shY - 14], [36, shY + 10], [44, -300], [32, hipY + 6], [0, hipY + 16]]);
  shape(torso, { fill: PAL.tSkin, lw: 7, shade: () => { fillOnly(ell(-6, -300, 20, 56, 20), PAL.tBelly, { boil: .3 }); fillOnly(ell(52, -300, 26, 120, 24), PAL.tSkinS, { boil: .3 }); } });
  // 后手臂
  const shL = [-30, shY + 8], shR = [30, shY + 8];
  const hL = P.handL || [-48, -250], hR = P.handR || [48, -250];
  shape(noodle(shL, hL, -10, 17, 13), { fill: PAL.tSkin, lw: 6 });
  hand(hL[0], hL[1], Math.atan2(hL[1] - shL[1], hL[0] - shL[0]), 15, PAL.tSkin, { grip: P.gripL || 0 });
  // 脖子
  push(); translate(0, shY); rotate((P.tilt || 0) * .5); translate(0, -shY);
  shape(noodle([0, shY - 4], [4, neckTop + 10], 6, 26, 22), { fill: PAL.tSkin, lw: 7, shade: () => fillOnly(rect(6, neckTop, 20, 120), PAL.tSkinS, { boil: .3 }) });
  // 围巾绕颈圈
  shape(rr(-34, shY - 52, 74, 40, 18), { fill: PAL.scarf, lw: 7, shade: () => fillOnly(rect(10, shY - 60, 40, 60), PAL.scarfS, { boil: .3 }) });
  stroke([[-10, shY - 50], [-6, shY - 14]], 4); stroke([[12, shY - 50], [16, shY - 14]], 4);
  // 头
  push(); translate(4, neckTop); rotate(P.tilt || 0); translate(-4, -neckTop);
  const hc = [6, -548];
  // 天线
  const aw = (P.antWind || 0);
  stroke(quad([hc[0] - 6, hc[1] - 74], [hc[0] - 4 + aw * .5, hc[1] - 120], [hc[0] + 14 + aw, hc[1] - 150 + Math.abs(aw) * .2], 10), 6);
  shape(ell(hc[0] + 14 + aw, hc[1] - 156 + Math.abs(aw) * .2, 13, 13, 16), { fill: PAL.scarf, lw: 6 });
  shape(spline([[hc[0] - 58, hc[1] + 10], [hc[0] - 52, hc[1] - 56], [hc[0] - 10, hc[1] - 82], [hc[0] + 40, hc[1] - 70], [hc[0] + 64, hc[1] - 18], [hc[0] + 56, hc[1] + 50], [hc[0] + 10, hc[1] + 82], [hc[0] - 40, hc[1] + 62]]), {
    fill: PAL.tSkin, lw: 7, shade: () => fillOnly(ell(hc[0] + 62, hc[1] + 20, 30, 80, 24), PAL.tSkinS, { boil: .3 })
  });
  // 眼睛（大、相触）
  const lid = P.blink ? 1 : (P.lid ?? .45), look = P.look || [0, 0], j = P.jit || [0, 0];
  if (lid >= .98) { stroke([[hc[0] - 52, hc[1] - 4], [hc[0] - 4, hc[1] - 2]], 6); stroke([[hc[0] + 4, hc[1] - 2], [hc[0] + 52, hc[1] - 4]], 6); }
  else {
    eye(hc[0] - 26, hc[1] - 4, 27, 31, { lid, look, pupil: 4.5, skin: PAL.tSkin, jit: j, lower: P.lower || 0 });
    eye(hc[0] + 27, hc[1] - 4, 27, 31, { lid, look, pupil: 4.5, skin: PAL.tSkin, jit: j, lower: P.lower || 0 });
  }
  // 眼袋
  stroke(arc(hc[0] - 26, hc[1] + 30, 16, 6, .2, Math.PI - .2, 8), 4); stroke(arc(hc[0] + 27, hc[1] + 30, 16, 6, .2, Math.PI - .2, 8), 4);
  // 眉
  const br = P.brow ?? 0;
  brow(hc[0] - 48, hc[1] - 50 - br * 10, hc[0] - 8, hc[1] - 46 - br * 4 + br * -2);
  brow(hc[0] + 8, hc[1] - 46 - br * 4, hc[0] + 50, hc[1] - 50 - br * 10);
  const m = P.mouth || {};
  mouth(hc[0] + 4, hc[1] + 50, 46, { lw: 6, ...m });
  pop(); pop();
  // 前手臂
  shape(noodle(shR, hR, 10, 17, 13), { fill: PAL.tSkin, lw: 6, shade: () => fillOnly(rect(shR[0] + 4, shR[1], 20, 300), PAL.tSkinS, { boil: .3 }) });
  hand(hR[0], hR[1], Math.atan2(hR[1] - shR[1], hR[0] - shR[0]), 15, PAL.tSkin, { grip: P.gripR || 0 });
  pop();
  pop();
}

// —— 矮胖 ——
export function short(P) {
  const f = P.face ?? 1, s = P.s ?? 1;
  push(); translate(P.x + (P.jit ? P.jit[0] * .6 : 0), P.y); rotate(P.rot || 0); scale(s * f * (P.stx ?? 1), s * (P.sq ?? 1));
  const breathe = P.puff || 0;
  // 腿 + 鞋
  const lx = P.legs || [0, 0];
  for (const [sx, dx] of [[-1, lx[0]], [1, lx[1]]]) {
    const hip = [sx * 40, -46], ank = [sx * 44 + dx, -14];
    shape(noodle(hip, ank, 0, 30, 26), { fill: PAL.sSkin, lw: 7 });
    shape(spline([[ank[0] - 26, ank[1] + 14], [ank[0] - 20, ank[1] - 8], [ank[0] + 16, ank[1] - 10], [ank[0] + 40, ank[1] + 4], [ank[0] + 34, ank[1] + 16]]), { fill: PAL.sShoe, lw: 7 });
  }
  const bc = [0, -132], rx = 104 * (1 + breathe * .1), ry = 98 * (1 + breathe * .06);
  // 后手臂
  const hL = P.handL || [-120, -70], hR = P.handR || [124, -80];
  shape(noodle([-82, -128], hL, 12, 26, 20), { fill: PAL.sSkin, lw: 6 });
  hand(hL[0], hL[1], Math.atan2(hL[1] + 128, hL[0] + 82), 17, PAL.sSkin, { grip: P.gripL || 0 });
  // 身体（头身一体）
  shape(ell(bc[0], bc[1], rx, ry, 64), {
    fill: PAL.sSkin, lw: 7, shade: () => { fillOnly(ell(bc[0] + 4, bc[1] + 52, 58, 40, 30), PAL.sBelly, { boil: .3 }); fillOnly(ell(bc[0] + rx * .9, bc[1] + 20, rx * .4, ry * .9, 30), PAL.sSkinS, { boil: .3 }); }
  });
  // 两根小触角（在头盔里）
  stroke(quad([bc[0] - 30, bc[1] - ry + 6], [bc[0] - 40, bc[1] - ry - 22], [bc[0] - 22, bc[1] - ry - 34], 8), 5);
  stroke(quad([bc[0] + 30, bc[1] - ry + 6], [bc[0] + 42, bc[1] - ry - 20], [bc[0] + 30, bc[1] - ry - 36], 8), 5);
  dot(bc[0] - 22, bc[1] - ry - 34, 6); dot(bc[0] + 30, bc[1] - ry - 36, 6);
  // 脸
  const fx = 14, ey = bc[1] - 34, j = P.jit || [0, 0];
  const lid = P.blink ? 1 : (P.lid ?? 0), look = P.look || [0, 0];
  if (lid >= .98) { stroke([[fx - 66, ey], [fx - 6, ey]], 6); stroke([[fx + 6, ey], [fx + 66, ey]], 6); }
  else {
    const pr = P.pupil ?? 4;
    eye(fx - 34, ey, 32 * (P.eyeS ?? 1), 37 * (P.eyeS ?? 1), { lid, look, pupil: pr, skin: PAL.sSkin, jit: [j[0] * .5, j[1] * .5] });
    eye(fx + 34, ey, 32 * (P.eyeS ?? 1), 37 * (P.eyeS ?? 1), { lid, look, pupil: pr, skin: PAL.sSkin, jit: [j[0] * .5, j[1] * .5] });
  }
  stroke(arc(fx - 34, ey + 44, 18, 6, .25, Math.PI - .25, 8), 4); stroke(arc(fx + 34, ey + 44, 18, 6, .25, Math.PI - .25, 8), 4);
  const br = P.brow ?? 0; // + 抬起/担忧（内侧上扬）
  brow(fx - 64, ey - 50 + br * 4, fx - 18, ey - 56 - br * 12);
  brow(fx + 18, ey - 56 - br * 12, fx + 64, ey - 50 + br * 4);
  const m = P.mouth || {};
  mouth(fx, bc[1] + 30, 54, { lw: 6, ...m });
  if (P.sweat) for (const [sx, sy, k] of [[-96, -200, 0], [100, -186, 1]]) { if (P.sweat > k * .5) shape(spline([[sx, sy - 16], [sx + 9, sy + 4], [sx, sy + 12], [sx - 9, sy + 4]]), { fill: '#e6eefc', lw: 5 }); }
  // 前手臂
  shape(noodle([82, -128], hR, -12, 26, 20), { fill: PAL.sSkin, lw: 6, shade: () => fillOnly(rect(84, -200, 60, 200), PAL.sSkinS, { boil: .3 }) });
  hand(hR[0], hR[1], Math.atan2(hR[1] + 128, hR[0] - 82), 17, PAL.sSkin, { grip: P.gripR || 0 });
  // 鱼缸头盔：透明圆罩 + 高光 + 底部扣环
  if (P.helmet !== false) {
    const hr = 128, hy = bc[1] - 18;
    shape(ell(0, hy, hr, hr * 1.02, 72), { fill: PAL.glass, lw: 6, shade: () => {
      fillOnly(arcBand(-hr * .62, hy - hr * .55, hr * .5, 2.4, 3.9, 14), 'rgba(255,255,255,.75)', { boil: .2 });
      fillOnly(ell(hr * .55, hy - hr * .5, 10, 16, 12), 'rgba(255,255,255,.7)', { boil: .2 });
    } });
    shape(rr(-hr * .86, hy + hr * .62, hr * 1.72, 30, 14), { fill: PAL.collar, lw: 6, shade: () => fillOnly(rect(hr * .2, hy + hr * .6, hr, 40), PAL.collarS, { boil: .3 }) });
    for (const bx of [-60, 0, 60]) dot(bx, hy + hr * .62 + 15, 5, '#c9ced6');
  }
  pop();
}
// 一段弯月形高光
function arcBand(cx, cy, r, a0, a1, w) {
  const o = arc(cx, cy, r, r, a0, a1, 14), i = arc(cx + w * .4, cy + w * .4, r - w, r - w, a1, a0, 14);
  return [...o, ...i];
}

// —— 收银员（只画柜台以上的上半身）——
// P: {x,y,s,lid,look,chew,gum(0..1 泡泡大小),pop(0..1 爆开),handR:[x,y],gripR,handL,blink}
export function cashier(P) {
  push(); translate(P.x, P.y); scale(P.s ?? 1);
  // 躯干（制服）
  shape(spline([[-120, 40], [-118, -150], [-80, -220], [0, -232], [80, -220], [118, -150], [120, 40]]), {
    fill: PAL.uni, lw: 7, shade: () => { fillOnly(ell(110, -80, 50, 200, 20), PAL.uniS, { boil: .3 }); }
  });
  stroke([[0, -226], [0, 40]], 5);
  shape(rr(30, -170, 56, 30, 6), { fill: PAL.tag, lw: 5 });
  stroke([[40, -155], [74, -155]], 4);
  // 左手（后）
  const hL = P.handL || [-150, -10];
  shape(noodle([-100, -196], hL, -20, 40, 30), { fill: PAL.uni, lw: 7 });
  if (!P.hideHandL) hand(hL[0], hL[1], Math.atan2(hL[1] + 196, hL[0] + 100), 24, PAL.cSkin, { grip: P.gripL || 0 });
  // 脖子 + 头
  shape(rect(-26, -270, 52, 56), { fill: PAL.cSkin, lw: 7 });
  const hc = [0, -350];
  // 发髻
  shape(ell(-8, hc[1] - 104, 48, 38, 30), { fill: PAL.hair, lw: 7, shade: () => fillOnly(ell(20, hc[1] - 90, 30, 30, 16), PAL.hairS, { boil: .3 }) });
  shape(spline([[hc[0] - 92, hc[1] + 10], [hc[0] - 90, hc[1] - 60], [hc[0] - 40, hc[1] - 96], [hc[0] + 40, hc[1] - 96], [hc[0] + 92, hc[1] - 58], [hc[0] + 92, hc[1] + 20], [hc[0] + 60, hc[1] + 82], [hc[0], hc[1] + 98], [hc[0] - 64, hc[1] + 80]]), {
    fill: PAL.cSkin, lw: 7, shade: () => fillOnly(ell(hc[0] + 96, hc[1] + 20, 34, 100, 24), PAL.cSkinS, { boil: .3 })
  });
  // 刘海
  shape(spline([[hc[0] - 96, hc[1] - 10], [hc[0] - 88, hc[1] - 72], [hc[0] - 20, hc[1] - 104], [hc[0] + 60, hc[1] - 92], [hc[0] + 98, hc[1] - 40], [hc[0] + 60, hc[1] - 60], [hc[0] - 10, hc[1] - 56], [hc[0] - 70, hc[1] - 30]]), { fill: PAL.hair, lw: 7 });
  // 厚眼皮的眼
  const lid = P.blink ? 1 : (P.lid ?? .55), look = P.look || [0, 0];
  if (lid >= .98) { stroke([[hc[0] - 64, hc[1] + 4], [hc[0] - 14, hc[1] + 4]], 6); stroke([[hc[0] + 14, hc[1] + 4], [hc[0] + 64, hc[1] + 4]], 6); }
  else { eye(hc[0] - 38, hc[1] + 4, 26, 26, { lid, look, pupil: 4.5, skin: PAL.cSkin }); eye(hc[0] + 38, hc[1] + 4, 26, 26, { lid, look, pupil: 4.5, skin: PAL.cSkin }); }
  stroke(arc(hc[0] - 38, hc[1] + 34, 14, 5, .2, Math.PI - .2, 8), 4); stroke(arc(hc[0] + 38, hc[1] + 34, 14, 5, .2, Math.PI - .2, 8), 4);
  stroke([[hc[0] - 62, hc[1] - 36], [hc[0] - 16, hc[1] - 34]], 6); stroke([[hc[0] + 16, hc[1] - 34], [hc[0] + 62, hc[1] - 36]], 6);
  // 嘴：嚼口香糖（嘴角左右歪）
  const ch = P.chew || 0, mx = hc[0] + 4 + ch * 6, my = hc[1] + 62;
  if ((P.gum || 0) > .02 && !(P.pop > 0)) {
    const r = 14 + P.gum * 70;
    stroke([[mx - 18, my], [mx + 18, my]], 6);
    shape(ell(mx, my + 4, r, r * .94, 40), { fill: PAL.gum, lw: 6, shade: () => { fillOnly(ell(mx + r * .45, my + r * .3, r * .5, r * .6, 20), PAL.gumS, { boil: .3 }); fillOnly(ell(mx - r * .4, my - r * .4, r * .18, r * .12, 10), 'rgba(255,255,255,.8)', { boil: .2 }); } });
  } else if (P.pop > 0) {
    // 爆开：糊在脸上的粉色碎片
    const k = P.pop;
    shape(spline([[mx - 70, my - 20], [mx - 30, my - 46], [mx + 20, my - 30], [mx + 74, my - 40], [mx + 60, my + 10], [mx + 80, my + 40], [mx + 20, my + 30], [mx - 20, my + 44], [mx - 76, my + 24]].map(([x, y]) => [mx + (x - mx) * (.8 + k * .2), my + (y - my) * (.8 + k * .2)])), { fill: PAL.gum, lw: 6 });
  } else {
    stroke(quad([mx - 22, my - 2 + ch * 3], [mx, my + 4], [mx + 22, my - 2 - ch * 3], 10), 6);
  }
  // 右手（前）
  const hR = P.handR || [150, -10];
  shape(noodle([100, -196], hR, 20, 40, 30), { fill: PAL.uni, lw: 7, shade: () => fillOnly(rect(110, -300, 80, 400), PAL.uniS, { boil: .3 }) });
  if (!P.hideHandR) hand(hR[0], hR[1], Math.atan2(hR[1] + 196, hR[0] - 100), 24, PAL.cSkin, { grip: P.gripR || 0 });
  pop();
}

// —— 道具 ——
// 冰淇淋桶（侧视：圆柱 + 椭圆顶 + 盖上画甜筒图标，不写字）
export function tub(x, y, w, h, col, colS, lidCol) {
  shape(rr(x - w / 2, y - h, w, h, 8), { fill: col, lw: 6, shade: () => { fillOnly(rect(x + w * .18, y - h - 4, w * .4, h + 8), colS, { boil: .3 }); fillOnly(rect(x - w, y - h * .62, w * 2, h * .16), 'rgba(255,255,255,.55)', { boil: .3 }); } });
  shape(ell(x, y - h, w / 2 + 4, w * .16, 24), { fill: lidCol, lw: 6 });
  // 甜筒图标
  shape([[x - w * .14, y - h * .52], [x + w * .14, y - h * .52], [x, y - h * .12]], { fill: '#e7b874', lw: 4 });
  shape(ell(x, y - h * .58, w * .17, w * .14, 14), { fill: '#fff4f0', lw: 4 });
  // 霜点
  for (let k = 0; k < 3; k++) dot(x - w * .3 + k * w * .28, y - h * .9 + hash(x * .1 + k) * 10, 3, 'rgba(255,255,255,.9)');
}
// 冰棍：drawInside() 画被冻住的角色（局部坐标，冰块中心在 (0,0)），size 冰块宽高
export function popsicle(x, y, rot, s, drawInside, { w = 150, h = 210, stick = 1, crack = 0 } = {}) {
  push(); translate(x, y); rotate(rot); scale(s);
  // 木棍
  if (stick > 0) shape(rr(-18, h / 2 - 12, 36, 110 * stick, 16), { fill: PAL.stick, lw: 6, shade: () => fillOnly(rect(4, h / 2, 16, 140), PAL.stickS, { boil: .3 }) });
  drawInside();
  const P = rr(-w / 2, -h / 2, w, h, 46);
  shape(P, { fill: PAL.ice, lw: 7, shade: () => {
    fillOnly(rect(-w * .34, -h * .44, w * .12, h * .7), 'rgba(255,255,255,.6)', { boil: .2 });
    fillOnly(rect(-w * .14, -h * .44, w * .05, h * .4), 'rgba(255,255,255,.5)', { boil: .2 });
    fillOnly(ell(w * .5, h * .2, w * .25, h * .5, 20), 'rgba(160,150,210,.25)', { boil: .2 });
  } });
  // 结霜边点
  for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + .3; dot(Math.cos(a) * w * .4, Math.sin(a) * h * .42, 4, 'rgba(255,255,255,.95)'); }
  if (crack > 0) { stroke([[w * .1, -h * .5], [w * .2, -h * .3], [w * .05, -h * .18], [w * .22, -h * .02]], 4, { line: PAL.iceLine }); }
  pop();
}
