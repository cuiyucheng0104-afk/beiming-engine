// s4-gates.js — 11 道证据关卡 72–160 s：一条连续推轨穿过 11 座拱门。
// 每关 8 s（本地时间 u）：u∈[-0.6,1.6] 拱门组装 · [1,6.5] 证据板上展示证据（evidence 模块画）
//                          u=4.0→4.5 证据块从证据板飞进拱门证据槽，4.5 锁定、灯变金 · [6,8] 穿门
// 证据模块接口（evidence-a.js 画第 0–5 关，evidence-b.js 画第 6–10 关）：
//   F.EVIDENCE[i] = { build(scene, anchor), seek(u, t), overlay(g, u, cam, t) }
//   anchor = F.boardAnchor(i) = { group（证据板局部坐标：原点在板面底边中点，x 向右、y 向上、+z 朝观众；板面 4.6×2.8，
//            板面前表面在 z=0.08），w, h, emitLocal（证据块起飞点，板局部坐标） }
'use strict';
(function () {
const F = window.F;
const T0 = F.GATE_T0, N = F.GATES.length, T1 = T0 + N * F.GATE_LEN;   // 72–160
F.EVIDENCE = F.EVIDENCE || [];
const LOCK_U = 4.5, FLY_U = 4.0;

F.EVIDENCE_LINES = [
  '每类镜头都连到能做它的服务，做不到的标"不支持"',
  '切点检测 16 个候选，逐帧核对：12 个真切点',
  '用户原话、替换项、花费上限 ¥30，写进 BRIEF',
  '原片每个"作用"都要有去向：继承、换形式或放弃',
  '图管长相 · 片段管动作 · 首尾帧管终点 · 提示词管态度',
  '本机请求 46 · 付费请求 0',
  '4 个请求 · 共 20 秒 · 合计 ¥1.00',
  '4 个任务并行 · 从提交到拿齐 15.7 分钟',
  '选段不跨内部切点 · 重建时付费生成 0 次',
  '连续帧 · 运动量 · 切点数 = 13',
  '看过、听过，结论如实分级',
];

// 证据板位置：拱门左前方，转向道路
F.boardAnchor = function (i) {
  const p = F.gatePos(i), ry = F.gateRotY(i);
  const g = new THREE.Group();
  const lx = -6.0, lz = 1.2;
  g.position.set(p.x + Math.cos(ry) * lx + Math.sin(ry) * lz, .95, p.z - Math.sin(ry) * lx + Math.cos(ry) * lz);
  g.rotation.y = ry + .72; g.scale.setScalar(1.3);
  return { group: g, w: 4.6, h: 2.8, emitLocal: new THREE.Vector3(1.9, 1.4, .3) };
};

// 镜头轨迹：全段一条单调样条（z），每关减速看证据、加速穿门
const zKeys = [], yKeys = [];
for (let i = 0; i < N; i++) {
  const g0 = T0 + i * F.GATE_LEN, pz = F.gatePos(i).z;
  zKeys.push([g0, pz + 15], [g0 + 2, pz + 10.6], [g0 + 5.4, pz + 7.6]);
  yKeys.push([g0, 2.7], [g0 + 3, 3.05], [g0 + 5.6, 2.9], [g0 + 7, 2.3]);
}
zKeys.push([T1, F.gatePos(N - 1).z - 1]); yKeys.push([T1, 2.4]);
const camZ = F.mspline(zKeys), camY = F.mspline(yKeys);
F.roadCam = function (t) {
  const z = camZ(t), y = camY(t), x = F.roadX(z) + 1.3;
  const i = Math.max(0, Math.min(N - 1, Math.floor((t - T0) / F.GATE_LEN))), u = t - T0 - i * F.GATE_LEN;
  const P = F.gatePos(i), Pn = F.gatePos(Math.min(N - 1, i + 1));
  const gateC = new THREE.Vector3(P.x, 3.4, P.z);
  const nextC = i < N - 1 ? new THREE.Vector3(Pn.x, 3.0, Pn.z) : new THREE.Vector3(P.x, 2.6, P.z - 30);
  const a = F.boardAnchor(i); a.group.updateMatrixWorld(true);
  const boardC = new THREE.Vector3(0, 1.4, 0).applyMatrix4(a.group.matrixWorld);
  const wb = .68 * F.smooth(u / 2) * (1 - F.smooth((u - 4.8) / 1.2));
  const look = gateC.clone().lerp(boardC, wb).lerp(nextC, F.smooth((u - 5.4) / 1.8));
  return { pos: [x, y, z], look: [look.x, look.y, look.z], i, u };
};

let cam, env, gates = [], allPieces = [], blocks = [], anchors = [];
F.addScene({
  id: 's4-gates', t0: T0, t1: T1,
  captions: F.GATES.map((G, i) => ({ t0: T0 + i * 8 + .5, t1: T0 + i * 8 + 7.6, title: `第${G.n}关 · ${G.name}：${G.sub}`, body: F.EVIDENCE_LINES[i] })),
  build() {
    const scene = new THREE.Scene();
    env = F.makeEnv(scene, { fog: .022, keyDir: [-7, 10, 6], keyInt: 1.7, shadowBox: 18 });
    F.buildRoad(scene);
    F.buildTown(scene, { zFrom: 20, zTo: -190, seed: 5 });
    for (let i = 0; i < N; i++) {
      const g0 = T0 + i * 8;
      const gate = F.buildGate(i, { assembleT0: g0 - .6, assembleT1: g0 + 1.6 });
      scene.add(gate.group); gates.push(gate); allPieces.push(...gate.pieces);
      // 证据板：石膏板 + 两条腿
      const a = F.boardAnchor(i); anchors.push(a); scene.add(a.group);
      const board = F.block(4.6, 2.8, .16, F.mat.plaster, .05); board.position.set(0, 1.4, 0); a.group.add(board);
      for (const sx of [-1, 1]) { const leg = F.block(.22, .95, .22, F.mat.plasterShade, .03); leg.position.set(sx * 1.7, -.475, 0); a.group.add(leg); }
      // 板子随拱门一起从分解状态组装
      for (const ch of [...a.group.children]) allPieces.push(F.piece(ch, { d: [-1.5, 3 + ch.position.y, .8], axis: [0, 0, 1], ang: .3, t0: g0 - .3, t1: g0 + 1.2, mode: 'gather' }));
      const ev = F.buildEvidenceBlock(); scene.add(ev.mesh); blocks.push(ev);
      if (F.EVIDENCE[i] && F.EVIDENCE[i].build) F.EVIDENCE[i].build(scene, a);
      // 声音
      F.ev(g0, 'whoosh', { dur: 1.6 }); F.ev(g0 + 1.5, 'thud'); F.ev(g0 + FLY_U, 'whoosh', { dur: .5, soft: true });
      F.ev(g0 + LOCK_U, 'lock'); F.ev(g0 + LOCK_U, 'gate', { i });
      if (i % 2 === 0) F.ev(g0, 'hit');
    }
    F.ev(T1 - 2, 'riser', { dur: 2 });
    cam = new THREE.PerspectiveCamera(45, F.W / F.H, .05, 500);
    return { scene, camera: cam };
  },
  seek(tl, t) {
    F.poseAll(allPieces, t);
    for (let i = 0; i < N; i++) {
      const u = t - T0 - i * 8;
      const on = F.smooth((u - LOCK_U) / .25), flash = Math.max(0, 1 - Math.abs(u - LOCK_U) / .3);
      gates[i].light(on, flash);
      // 证据块：从证据板起飞 → 嵌入证据槽
      const b = blocks[i], a = anchors[i];
      a.group.updateMatrixWorld(true);
      const from = a.emitLocal.clone().applyMatrix4(a.group.matrixWorld), to = gates[i].slotWorld();
      const k = F.easeIO((u - FLY_U) / (LOCK_U - FLY_U));
      b.mesh.visible = u > FLY_U - .6;
      const pos = from.clone().lerp(to, k); pos.y += Math.sin(k * Math.PI) * 1.2;
      b.mesh.position.copy(pos); b.mesh.rotation.set(k * 3.1, k * 2.2, 0);
      b.mesh.scale.setScalar(F.lerp(1, .95, k) * (u < FLY_U ? F.easeBack((u - FLY_U + .6) / .6) : 1));
      b.mat.emissiveIntensity = 3.2 + 4 * flash;
      if (F.EVIDENCE[i] && F.EVIDENCE[i].seek) F.EVIDENCE[i].seek(u, t);
    }
    const c = F.roadCam(t);
    F.aimCam(cam, c.pos, c.look, 45);
    // 主光跟着镜头走（阴影范围有限）
    env.key.target.position.set(c.pos[0], 0, c.pos[2] - 8); env.key.position.set(c.pos[0] - 7, 10, c.pos[2] - 2);
    env.fill.position.set(c.pos[0] + 7, 4, c.pos[2] - 14);
  },
  overlay(g, tl, t) {
    const c = F.roadCam(t);
    for (let i = Math.max(0, c.i - 1); i <= Math.min(N - 1, c.i + 1); i++) {
      const u = t - T0 - i * 8;
      if (F.EVIDENCE[i] && F.EVIDENCE[i].overlay && u > -1 && u < 8.5) { g.save(); F.EVIDENCE[i].overlay(g, u, cam, t); g.restore(); }
    }
  },
  bloom: (tl, t) => { const u = (t - T0) % 8; return .55 + .35 * Math.max(0, 1 - Math.abs(u - LOCK_U) / .4); },
});
})();
