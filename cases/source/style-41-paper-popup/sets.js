// 两个跨页：白天城堡（拉片 + 吊桥 + 士兵）与夜晚城堡（月亮拉片）。弹起由后往前，每块的"立直"时刻卡在拍点上。
import * as THREE from 'three';
import * as A from './art.js';
import { back, seg, ss, eio, TAU, mulberry } from './lib.js';
import { cutMesh, thread } from './cutmesh.js';
import { T } from './timeline.js';

export const BACK_S = 1.7, POP_D = .5, CROSS = 1 - BACK_S / (BACK_S + 1);   // back() 第一次到 1 的位置
// 让卡片恰好在 ts 立直：rise(t) = back(seg(t, ts − CROSS·D, ts + (1−CROSS)·D))
export const rise = (t, ts, D = POP_D) => back(seg(t, ts - CROSS * D, ts + (1 - CROSS) * D), BACK_S);

function popper(L, parent, item, x, y, z, o = {}) {
  const g = new THREE.Group(); g.position.set(x, y, z);
  const m = cutMesh(item, o); g.add(m); parent.add(g);
  const r = { g, m, ts: o.ts, tf: o.tf, df: o.df ?? .35, dir: o.dir ?? -1, sway: o.sway || 0, ph: o.ph ?? x * 40, name: o.name };
  L.push(r); return r;
}

export function buildSets(book) {
  const L = [], S = book.stage, ex = {};
  // ===== 白天 =====
  // 翻页时：前面的先倒（纸页从自由边卷起），每一排都在卷曲波到达之前折平
  const foldDay = z => T.turn - .18 + (.3 - z) * .9;
  const D = (ts, z, o = {}) => ({ ts, tf: foldDay(z), df: .15, ...o });
  popper(L, S, A.hill(.26, .085, A.C.hill, A.C.hillS, 11, { bumps: 2 }), -.12, 0, .012, D(T.popHills, .012));
  popper(L, S, A.hill(.2, .075, A.C.hill2, A.C.hill2S, 12, { bumps: 3 }), .055, 0, .014, D(T.popHills, .014));
  ex.towers = [];
  for (const [x, sd] of [[-.105, 1], [.105, 2]]) {
    const r = popper(L, S, A.tower(.046, .165, false, sd), x, 0, .042, D(T.popTowers, .042)); ex.towers.push(r);
    const f = cutMesh(A.flag(.026, .02, A.C.gold)); f.position.set(0, .158, .001); r.g.add(f); r.flag = f;
  }
  ex.keep = popper(L, S, A.keep(.13, .14, false), 0, 0, .07, D(T.popKeep, .07));
  { const f = cutMesh(A.flag(.03, .022, A.C.red)); f.position.set(0, .136, .001); ex.keep.g.add(f); ex.keep.flag = f; }
  ex.wall = popper(L, S, A.wall(.31, .06, false, .036), 0, 0, .1, D(T.popWall, .1));
  // 吊桥：铰链在门洞底边，竖起时盖住城门
  { const it = A.bridge(.036, .042); const g = new THREE.Group(); const m = cutMesh(it, { backCol: '#8a5a34' }); g.add(m); g.position.set(0, 0, .0016); ex.wall.g.add(g); ex.bridge = g; ex.bridgeLen = .042; }
  // 吊桥铁链（每帧按两端点重新定向）
  ex.chains = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.CylinderGeometry(.0004, .0004, 1, 5), new THREE.MeshStandardMaterial({ color: '#5a5560', roughness: .5, metalness: .6 })); m.geometry.translate(0, .5, 0); m.castShadow = true; S.add(m); return m; });
  popper(L, S, A.waves(.31, .012, '#7cc6ef', '#4a9fd8', 51, 10), 0, 0, .128, D(T.popFront, .128, { dir: 1 }));
  ex.soldiers = [];
  const SX = [-.135, -.075, .075, .135];
  SX.forEach((x, i) => ex.soldiers.push(popper(L, S, A.soldier(.04, ['#d8423a', '#3f8fd8', '#d8423a', '#3f8fd8'][i], 60 + i), x, 0, .19, D(T.popFront + .15 * (i % 2), .19, { dir: 1 }))));
  const R = mulberry(90); ex.flowers = [];
  for (let i = 0; i < 8; i++) { const x = -.2 + i * .057 + (R() - .5) * .015; if (Math.abs(x) < .05) continue; ex.flowers.push(popper(L, S, A.flower(.016 + R() * .007, ['#ff7aa8', '#ffd23f', '#ffffff', '#b58cff'][i % 4], i), x, 0, .245 + R() * .03, D(T.popFront + .3, .25, { dir: 1, sway: .07 }))); }
  ex.bushL = popper(L, S, A.bush(.07, .03, '#4fae4c', '#3a8a3a', 31, '#e8413a'), -.175, 0, .275, D(T.popFront + .3, .275, { dir: 1 }));
  popper(L, S, A.bush(.06, .026, '#5cbb52', '#44953e', 32), .18, 0, .278, D(T.popFront + .3, .278, { dir: 1 }));
  // 拉片：平躺在页面上，从纸缝里被拉出
  { const it = A.pullTab(.04, .016); const g = new THREE.Group(); const m = cutMesh(it); m.rotation.x = -Math.PI / 2; m.rotation.z = -Math.PI / 2; g.add(m); g.position.set(.063, .0012, .228); S.add(g); ex.tab = g;
    const slot = new THREE.Mesh(new THREE.PlaneGeometry(.022, .0016), new THREE.MeshStandardMaterial({ color: '#8a7058', roughness: .95 })); slot.rotation.x = -Math.PI / 2; slot.position.set(.063, .0006, .229); S.add(slot); ex.slot = slot; }

  // ===== 夜晚 =====
  const foldNight = z => T.fold + (.3 - z) * .5;
  const N = (ts, z, o = {}) => ({ ts, tf: foldNight(z), ...o });
  popper(L, S, A.hill(.26, .08, A.C.nhill, A.C.nhillS, 21, { bumps: 3, stars: true }), -.12, 0, .016, N(T.nightHills, .016));
  popper(L, S, A.hill(.2, .07, '#4a4a8c', '#36366c', 22, { bumps: 2, stars: true }), .055, 0, .018, N(T.nightHills, .018));
  for (const [x, sd] of [[-.105, 3], [.105, 4]]) popper(L, S, A.tower(.046, .165, true, sd), x, 0, .042, N(T.leafDown, .042));
  ex.nkeep = popper(L, S, A.keep(.13, .14, true), 0, 0, .07, N(T.leafDown, .07));
  popper(L, S, A.wall(.31, .06, true, .036), 0, 0, .1, N(T.nightFront, .1));
  popper(L, S, A.waves(.31, .012, '#3a5aa0', '#283f7a', 52, 10), 0, 0, .128, N(T.nightFront, .128, { dir: 1 }));
  popper(L, S, A.bush(.07, .03, '#2f4f6a', '#22394f', 33, '#ffd76a'), -.175, 0, .26, N(T.nightFront, .26, { dir: 1 }));
  popper(L, S, A.bush(.06, .026, '#30506c', '#233a50', 34, '#ffd76a'), .18, 0, .262, N(T.nightFront, .262, { dir: 1 }));
  // 月亮竹签（从山后升起）
  { const g = new THREE.Group(); g.add(cutMesh(A.moonStick(.02, .16))); g.position.set(.175, -.2, .009); S.add(g); ex.moon = g; }
  return { L, ex };
}

export function updatePops(L, t) {
  for (const r of L) {
    const up = rise(t, r.ts), dn = 1 - ss(seg(t, r.tf, r.tf + r.df)), k = Math.min(up, dn);
    r.g.visible = k > .002; if (!r.g.visible) continue;
    r.g.rotation.x = r.dir * (Math.PI / 2) * (1 - k);
    if (r.sway) r.m.rotation.z = Math.sin(t * 1.6 + r.ph) * r.sway * k;
  }
}
