// 港口集市的像素人物：逐像素程序绘制（3/4 侧面朝右），一帧一个姿势，打成图集；广告牌接受场景光照并投影
import * as THREE from 'three';
import { PX, ramp, hex, texOf, billboard, blob } from './px.js';

export const SPX = 1 / 27;          // 人物像素 → 米（44 px ≈ 1.63 m）
export const FW = 26, FH = 44;

const R = (c) => ramp(c, .22);
export const PAL = {
  skin: R(['#a8705a', '#d09878', '#ecc09c', '#fbdcc0']),
  skin2: R(['#7a4a34', '#9c6448', '#bd8462', '#d6a07a']),
  boot: R(['#160e0c', '#2a1b14', '#423024']),
  trouser: R(['#1a1a24', '#2c2c3c', '#424258']),
  // 摊主们
  teal: R(['#0e2624', '#17403b', '#256058', '#3a8276', '#5aa496']),
  brown: R(['#24150e', '#3e2618', '#5c3c24', '#7c5634', '#9a7248']),
  plum: R(['#1e1022', '#36203c', '#523058', '#704476', '#8e5e92']),
  slate: R(['#141a26', '#222c40', '#34425c', '#4a5c7a', '#667a98']),
  olive: R(['#1a1c10', '#2e3218', '#474c26', '#626a36', '#7e884a']),
  navy: R(['#0c1020', '#161e38', '#243052', '#36466e', '#4c5e8a']),
  mustard: R(['#4a3410', '#7a5a1c', '#a8822e', '#d0aa48']),
  cream: R(['#6e6450', '#9a8e74', '#c4b898', '#e6dcbc']),
  grey: R(['#4c4a50', '#76747c', '#a4a2aa', '#d0ced6']),
  hairD: R(['#140c0a', '#28180f', '#3e2618', '#583a24']),
  hairR: R(['#3a1a0e', '#5e2c16', '#844222', '#a85e34']),
  crimson: R(['#2e0610', '#560e1a', '#861824', '#b42a30', '#d84a42']),   // 主角独有的猩红：全片只有围巾和帆用它
  brass: R(['#3e2a10', '#7a5a24', '#b88c3e', '#e6c26a']),
  flame: R(['#ff8a1c', '#ffc14a', '#ffe79a', '#fffbe6']),
};
const INK = hex('#1a1016');

// p: { coat, hair, skin, hat:'scarf'|'cap'|'bun'|'none', hatC, apron, beard, scarf (主角围巾), arm, bob, blink, look, taper }
function drawPerson(P, E, p) {
  const by = p.bob || 0, sk = PAL[p.skin || 'skin'], coat = PAL[p.coat], hair = PAL[p.hair || 'hairD'];
  // 靴子与腿
  const st = p.step;
  const legs = st == null ? [[9, 0], [14, 0]] : [[[7, 0], [16, 0]], [[10, 0], [13, 0]], [[16, 0], [7, 0]], [[13, 0], [10, 0]]][st];
  legs.forEach(([lx], i) => {
    for (let y = 31; y < 40; y++) for (let x = lx; x < lx + 3; x++) P.set(x, y, PAL.trouser((i ? .45 : .75) - (x === lx ? .25 : 0), x, y));
    for (let y = 40; y < 44; y++) for (let x = lx; x < lx + 4; x++) P.set(x, y, PAL.boot(y === 40 ? .8 : .45 - (x === lx ? .2 : 0), x, y));
  });
  // 外衣：梯形身体 + 下摆
  const top = 17 + by, bot = 34;
  P.poly([[8, top], [18, top], [20, bot], [6, bot]], (x, y) => {
    const u = (y - top) / (bot - top), l = 8 - 2 * u, r = 18 + 2 * u, s = (x - l) / (r - l);
    let v = .7 - s * .5 + (1 - u) * .15; if ((x + (y >> 2)) % 6 === 0 && u > .3) v -= .15;
    return coat(v, x, y);
  });
  if (p.apron) P.poly([[10, 24 + by], [17, 24 + by], [18, 34], [10, 34]], (x, y) => PAL[p.apron](.75 - (x - 10) * .05, x, y));
  // 腰带
  for (let x = 8; x < 19; x++) P.set(x, 25 + by, PAL.boot(.5, x, 0));
  // 头
  const hx = 13, hy = 11 + by;
  P.ellipse(hx + .5, hy, 4.4, 4.8, (x, y, dx, dy) => sk(.75 - dx * .35 - dy * .15, x, y));
  // 头发 / 帽子（后脑在左）
  for (let y = hy - 5; y <= hy + 3; y++) for (let x = hx - 5; x <= hx + 5; x++) {
    const dx = (x + .5 - hx - .5) / 4.6, dy = (y + .5 - hy) / 5;
    if (dx * dx + dy * dy > 1.05) continue;
    const back = dx < -.15 + dy * .3, crown = dy < -.45;
    if (p.hat === 'scarf' && (crown || back || dy < -.2)) P.set(x, y, PAL[p.hatC](.65 - dy * .3 + (back ? -.2 : 0), x, y));
    else if (p.hat === 'cap' && dy < -.3) P.set(x, y, PAL[p.hatC](.55 - dy * .2, x, y));
    else if ((p.hat === 'none' || p.hat === 'bun' || p.hat === 'cap') && (back || crown)) P.set(x, y, hair(.6 - dy * .3, x, y));
  }
  if (p.hat === 'cap') { for (let x = hx - 1; x <= hx + 6; x++) P.set(x, hy - 2, PAL[p.hatC](.25, x, 0)); }
  if (p.hat === 'bun') P.ellipse(hx - 3, hy - 4, 2.2, 2, (x, y) => hair(.55, x, y));
  if (p.hat === 'scarf') { P.set(hx - 4, hy + 4, PAL[p.hatC](.4, 0, 0)); P.set(hx - 5, hy + 5, PAL[p.hatC](.3, 0, 0)); }
  // 眼、鼻
  if (!p.blink) { P.set(hx + 2, hy, INK); P.set(hx + 2, hy - 1, PAL.boot(.1, 0, 0)); } else P.set(hx + 2, hy, sk(.2, 0, 0));
  P.set(hx + 5, hy + 1, sk(.45, 0, 0));
  if (p.beard) for (let y = hy + 2; y <= hy + 5; y++) for (let x = hx - 1; x <= hx + 4; x++) if ((x - hx) + (hy + 5 - y) > 0) P.set(x, y, PAL.grey(.7 - (y - hy) * .08, x, y));
  // 主角的猩红围巾：绕颈 + 一条飘带
  if (p.scarf) {
    for (let x = 9; x < 18; x++) for (let y = 16 + by; y < 19 + by; y++) P.set(x, y, PAL.crimson(.75 - (x - 9) * .04 - (y - 16 - by) * .12, x, y));
    const fl = p.scarf === 2 ? [[7, 18], [6, 19], [5, 19], [4, 20]] : [[8, 19], [8, 20], [7, 21], [7, 22]];
    fl.forEach(([x, y]) => { P.set(x, y + by, PAL.crimson(.55, x, y)); P.set(x, y + by + 1, PAL.crimson(.35, x, y)); });
  }
  // 手臂（前臂朝右）
  const arm = (pts, hand) => {
    pts.forEach(([x, y]) => { P.rect(x, y + by, 3, 3, coat(.45, x, y)); P.set(x + 2, y + by, coat(.7, x, y)); });
    P.rect(hand[0], hand[1] + by, 2, 2, sk(.7, 0, 0));
  };
  const A = p.arm || 'low';
  if (A === 'low') arm([[15, 18], [15, 21], [16, 24]], [17, 27]);
  else if (A === 'hold') arm([[15, 18], [17, 20], [19, 21]], [21, 21]);
  else if (A === 'reach') arm([[16, 16], [18, 13], [19, 10], [20, 7]], [21, 5]);
  else if (A === 'haul0') { arm([[15, 16], [16, 12], [16, 9]], [17, 6]); }
  else if (A === 'haul1') { arm([[15, 18], [16, 17], [17, 15]], [18, 14]); }
  else if (A === 'wave0') arm([[16, 16], [18, 13], [19, 10]], [20, 7]);
  else if (A === 'wave1') arm([[16, 16], [19, 14], [21, 12]], [23, 10]);
  // 点灯杆：手到右上角，顶端一粒火（自发光层同时画）
  if (p.taper) {
    for (let i = 0; i < 6; i++) P.set(22 + (i > 3 ? 1 : 0), 4 - i + by, PAL.brown(.6, 0, 0));
    const fl = [[23, -1], [23, 0], [24, 0], [22, 0]];
    for (const [x, y] of [[23, 0], [24, 0], [23, 1]]) { if (y + by >= 0) { const c = PAL.flame(.8, x, y); P.set(x, y + by, c); E.set(x, y + by, c); } }
    void fl;
  }
}

function atlas(table, base) {
  const names = Object.keys(table), n = names.length, P = new PX(FW * n, FH), E = new PX(FW * n, FH);
  names.forEach((k, i) => {
    const p1 = new PX(FW, FH), e1 = new PX(FW, FH);
    drawPerson(p1, e1, { ...base, ...table[k] }); p1.outline(.3);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) { const c = p1.get(x, y); if (c) P.set(i * FW + x, y, c); const e = e1.get(x, y); if (e) E.set(i * FW + x, y, e); }
  });
  const tex = texOf(P.done()), em = texOf(E.done());
  tex.repeat.set(1 / n, 1); em.repeat.set(1 / n, 1);
  return { tex, em, names, n };
}

const POSES = {
  idle0: {}, idle1: { bob: 1 }, blink: { blink: 1 }, reach: { arm: 'reach', taper: 1 }, reachB: { arm: 'reach', taper: 1, bob: 1 }, hold: { arm: 'hold' },
  look: { arm: 'low', bob: -1 },
  haul0: { arm: 'haul0' }, haul1: { arm: 'haul1', bob: 1 }, wave0: { arm: 'wave0', scarf: 2 }, wave1: { arm: 'wave1', scarf: 2 },
};

// 角色对象：mesh + 设帧 / 朝向
export function makePerson(base, poses = Object.keys(POSES)) {
  const table = Object.fromEntries(poses.map(k => [k, POSES[k]]));
  const A = atlas(table, base);
  const mesh = billboard(A.tex, FW * SPX, FH * SPX, { em: A.em, emCol: '#ffffff', emI: 2.4 });
  const root = new THREE.Group(); root.add(mesh); root.userData.char = base.id || 'npc';
  const sh = blob(.36, .5); sh.position.y = .015; root.add(sh);
  return {
    root, mesh,
    frame(name) { const i = A.names.indexOf(name); if (i < 0) throw new Error('frame ' + name); A.tex.offset.x = A.em.offset.x = i / A.n; },
    face(cam, flip = false) { root.rotation.y = Math.atan2(cam.position.x - root.position.x, cam.position.z - root.position.z); mesh.scale.x = flip ? -1 : 1; },
  };
}
