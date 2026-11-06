// s2b-principles.js — 原理 ④⑤（48–64 s）。
//   ④ 48–56「先看账单，再花钱」：一张三折石膏账单翻开，4 行请求逐拍入账，合计 ¥1.00 锁定，金印盖章。
//   ⑤ 56–64「修问题，修它的"主人"」：四层石膏塔（方案/源码/配方/Run）逐层锁定；源码层裂开，只有这一层抽出、换新。
// 共享小工具挂在 F.C2b 下（只本文件使用）。
'use strict';
(function () {
const F = window.F;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// 石膏刻字（自定义排版版本的 F.engrave）：在已有画布上的 (x,y) 处刻一段字
function engraveAt(x, str, px, py, { size = 80, weight = 600, align = 'left', mono = false } = {}) {
  x.font = `${weight} ${size}px ${mono ? '"SF Mono", Menlo, monospace' : F.FONT}`;
  x.textAlign = align; x.textBaseline = 'middle';
  x.fillStyle = 'rgba(255,255,255,.55)'; x.fillText(str, px + 2, py + 3);
  x.fillStyle = '#6F6A63'; x.fillText(str, px, py);
  x.fillStyle = 'rgba(40,36,32,.35)'; x.fillText(str, px - 1.5, py - 2);
}
function groove(x, x0, x1, y) {           // 刻线：暗线 + 下缘反光
  x.fillStyle = 'rgba(70,64,58,.45)'; x.fillRect(x0, y - 1, x1 - x0, 2);
  x.fillStyle = 'rgba(255,255,255,.5)'; x.fillRect(x0, y + 1, x1 - x0, 2);
}
const tex = c => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };

// ════════════════════════════════════════════════════════════════════════════
// ④ 账单 48–56
// ════════════════════════════════════════════════════════════════════════════
(function () {
const T0 = 48, T1 = 56;
const D = window.FILM_DATA;
const PRICE_CENTS = Math.round(D.market.price.offpeak_yuan_per_s * 100);   // 5 分/秒（闲时）
const SECS = [5, 4, 5, 6];                                                 // r1–r4（BIBLE §6）
const TOTAL_S = SECS.reduce((a, b) => a + b, 0);
if (TOTAL_S !== D.ledger.redo_seconds || TOTAL_S * PRICE_CENTS !== Math.round(D.ledger.redo_yuan * 100))
  console.warn('[s2b] 账单与 FILM_DATA.ledger 不一致', TOTAL_S, D.ledger);
const yuan = cents => `¥${(cents / 100).toFixed(2)}`;
const PRICE_STR = `¥${(PRICE_CENTS / 100).toFixed(2)}/秒（闲时）`;

// 账单版面（账单局部坐标，单位 m）：宽 7，三折，每折高 1.6；铰链在 y=0 和 y=-1.6
const BW = 7, PH = 1.6, TH = .1;
const ROW_Y = [.4, -.4, -1.2, -2.0], BAND_Y = -2.8;
const X_ID = -3.05, X_BAR = -2.35, BAR_MAX = 2.9, X_SEC = .82, X_AMT = 3.1;
const ROW_T = [2.0, 2.5, 3.0, 3.5];          // 每行入账的拍点
const LOCK_T = 4.0, STAMP_T = 6.0;
const SEAL = { x: 2.15, y: 1.12, w: 1.9, h: .66 };

let cam, bill, p1, p2, bars = [], bandLine, bandLineMat, seal, sealGoldMat, imprintMat, imprint;

function panelTexture(k) {
  const S = 200, [c, x] = F.canvas(BW * S, PH * S);
  x.fillStyle = F.C.plaster; x.fillRect(0, 0, c.width, c.height);
  const Y = y => (k === 0 ? PH - y : k === 1 ? -y : -PH - y) * S;   // 账单 y → 该折画布 y
  const X = xx => (xx + BW / 2) * S;
  if (k === 0) {
    engraveAt(x, '账单', X(-3.1), Y(1.14), { size: 92, weight: 600 });
    engraveAt(x, '外部请求 · 闲时价', X(-1.55), Y(1.08), { size: 50, weight: 500 });
    groove(x, X(-3.2), X(3.2), Y(.8));
  }
  // 行线（折痕上也有一条）
  for (const gy of [0, -.8, -1.6, -2.4]) if (Y(gy) > 2 && Y(gy) < c.height - 2) groove(x, X(-3.2), X(3.2), Y(gy));
  // 行首的请求编号刻在石膏里
  ROW_Y.forEach((ry, i) => { const py = Y(ry); if (py > 0 && py < c.height) engraveAt(x, `r${i + 1}`, X(X_ID), py, { size: 46, weight: 600, mono: true }); });
  // 进度条凹槽
  ROW_Y.forEach(ry => { const py = Y(ry); if (py > 0 && py < c.height) { x.fillStyle = 'rgba(80,74,66,.18)'; x.fillRect(X(X_BAR), py - 13, BAR_MAX * S, 26); } });
  return tex(c);
}

function sealTexture() {
  const [c, x] = F.canvas(760, 264);
  x.strokeStyle = '#fff'; x.lineWidth = 16; x.lineJoin = 'round';
  x.strokeRect(14, 14, 732, 236); x.lineWidth = 5; x.strokeRect(34, 34, 692, 196);
  x.fillStyle = '#fff'; x.font = `700 132px ${F.FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.letterSpacing = '18px'; x.fillText('已估价', 380 + 9, 136);
  const t = tex(c); return t;
}

F.addScene({
  id: 's2b-ledger', t0: T0, t1: T1,
  captions: [{ t0: 48.5, t1: 55.6, title: '先看账单，再花钱', body: 'plan 列出每个外部请求，pricing 查价目，这两步都不花钱' }],
  build() {
    const scene = new THREE.Scene();
    F.makeEnv(scene, { fog: .03, keyDir: [-5, 9, 8], keyInt: 1.55, fillInt: .7, target: [0, 2, 0], shadowBox: 9 });
    // 立架：底座 + 两根柱 + 顶梁（账单挂在顶梁下）
    const plinth = F.block(8.6, .4, 1.8, F.mat.plasterShade, .05); plinth.position.set(0, .2, -.2); scene.add(plinth);
    for (const sx of [-1, 1]) { const post = F.block(.34, 5.6, .34, F.mat.plaster, .04); post.position.set(sx * 3.95, .4 + 2.8, -.35); scene.add(post); }
    const beam = F.block(8.3, .34, .5, F.mat.plaster, .04); beam.position.set(0, 5.62, -.3); scene.add(beam);
    // 账单（后仰 0.1 rad），铰链在局部 y=0；顶折 y∈[0,1.6]
    bill = new THREE.Group(); bill.position.set(0, 3.82, 0); bill.rotation.x = -.1; scene.add(bill);
    const mkPanel = k => {
      const g = new THREE.Group();
      const b = F.block(BW, PH, TH, F.mat.plaster, .02); g.add(b);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(BW - .04, PH - .04), new THREE.MeshStandardMaterial({ color: '#fff', map: panelTexture(k), roughness: .93 }));
      face.position.z = TH / 2 + .002; face.receiveShadow = true; g.add(face);
      return g;
    };
    const m0 = mkPanel(0); m0.position.set(0, PH / 2, 0); bill.add(m0);
    // 第 2 折：铰链在顶折底边前沿；折起时翻到顶折前面
    p1 = new THREE.Group(); p1.position.set(0, 0, TH / 2); bill.add(p1);
    const m1 = mkPanel(1); m1.position.set(0, -PH / 2, -TH / 2); p1.add(m1);
    // 第 3 折：铰链在第 2 折底边后沿；折起时贴在第 2 折背面（风琴折）
    p2 = new THREE.Group(); p2.position.set(0, -PH, -TH); p1.add(p2);
    const m2 = mkPanel(2); m2.position.set(0, -PH / 2, TH / 2); p2.add(m2);
    // 青蓝时长条：长度 ∝ 秒数（最长 6 秒 = BAR_MAX）
    const barMat = new THREE.MeshStandardMaterial({ color: '#0E2A2A', emissive: new THREE.Color(F.C.teal), emissiveIntensity: 1.6, roughness: .5 });
    const barGeo = new THREE.BoxGeometry(1, .15, .05); barGeo.translate(.5, 0, 0);
    ROW_Y.forEach((ry, i) => {
      const m = new THREE.Mesh(barGeo, barMat.clone()); m.castShadow = true;
      const len = BAR_MAX * SECS[i] / 6;
      // 账单坐标 → 所在折的局部坐标
      if (ry > 0) { m.position.set(X_BAR, ry, TH / 2 + .03); bill.add(m); }
      else if (ry > -PH) { m.position.set(X_BAR, ry, .03); p1.add(m); }
      else { m.position.set(X_BAR, ry + PH, TH + .03); p2.add(m); }
      bars.push({ m, len });
    });
    // 合计栏：深靛凹槽 + 顶边金线
    const band = F.block(6.5, .64, .04, F.mat.ink, .015); band.position.set(0, BAND_Y + PH, TH + .02); p2.add(band);
    bandLineMat = F.goldMat();
    bandLine = new THREE.Mesh(new THREE.BoxGeometry(6.5, .03, .03), bandLineMat); bandLine.position.set(0, BAND_Y + PH + .345, TH + .03); p2.add(bandLine);
    // 金印：金色印面 + 石膏印钮；印文贴片在账单上
    seal = new THREE.Group();
    sealGoldMat = F.goldMat(); sealGoldMat.emissiveIntensity = .15;
    const sb = F.block(SEAL.w, SEAL.h, .3, sealGoldMat, .04); sb.position.z = .15; seal.add(sb);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(.16, .22, .55, 32), F.mat.plaster); neck.rotation.x = Math.PI / 2; neck.position.z = .55; neck.castShadow = true; seal.add(neck);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(.26, 32, 16), F.mat.plaster); knob.position.z = .92; knob.castShadow = true; seal.add(knob);
    seal.traverse(o => { o.castShadow = false; });   // 悬停的印不投影，免得盖住 r1 的金额
    bill.add(seal);
    imprintMat = new THREE.MeshBasicMaterial({ map: sealTexture(), transparent: true, depthWrite: false, color: new THREE.Color(F.C.gold) });
    imprint = new THREE.Mesh(new THREE.PlaneGeometry(SEAL.w, SEAL.h), imprintMat);
    imprint.position.set(SEAL.x, SEAL.y, TH / 2 + .006); bill.add(imprint);
    F.buildTown(scene, { zFrom: -7, zTo: -70, seed: 23, density: .8 });
    cam = new THREE.PerspectiveCamera(34, F.W / F.H, .05, 400);
    // 声音
    F.ev(T0, 'hit'); F.ev(T0 + .5, 'paper'); F.ev(T0 + 1.0, 'paper');
    ROW_T.forEach(t => F.ev(T0 + t, 'tick'));
    F.ev(T0 + LOCK_T, 'hit'); F.ev(T0 + LOCK_T, 'lock');
    F.ev(T0 + 5.0, 'whoosh', { dur: 1.0, soft: true });
    F.ev(T0 + STAMP_T, 'hit'); F.ev(T0 + STAMP_T, 'stamp');
    F.ev(T0 + 7.0, 'riser', { dur: 1.0 });
    return { scene, camera: cam };
  },
  seek(tl) {
    // 翻开：第 2 折 −π→0（0.5 落定），第 3 折 +π→0（1.0 落定），落定时轻微回弹
    const a1 = F.easeOut((tl + .05) / .55), a2 = F.easeOut((tl - .45) / .55);
    p1.rotation.x = -Math.PI * (1 - a1) + .025 * Math.sin(F.clamp((tl - .5) / .3) * Math.PI);
    p2.rotation.x = Math.PI * (1 - a2) - .025 * Math.sin(F.clamp((tl - 1.0) / .3) * Math.PI);
    // 时长条
    bars.forEach((b, i) => {
      const k = F.easeOut((tl - ROW_T[i]) / .4);
      b.m.visible = k > .001; b.m.scale.x = Math.max(.001, b.len * k);
      b.m.material.emissiveIntensity = 1.5 + 2.5 * Math.max(0, 1 - Math.abs(tl - ROW_T[i] - .2) / .3);
    });
    const lock = Math.max(0, 1 - Math.abs(tl - LOCK_T) / .35);
    bandLineMat.emissiveIntensity = 1.2 * F.smooth((tl - LOCK_T + .1) / .2) + 5 * lock;
    // 金印：5.0 从右上方进场悬停，6.0 落下盖章，6.25 起抬走
    const inK = F.easeOut((tl - 4.9) / .7), slam = F.easeIn((tl - 5.6) / .4), up = F.easeIO((tl - 6.25) / 1.1);
    const z = F.lerp(F.lerp(2.4, 1.0, inK), TH / 2 + .002, slam) + up * 3.6;
    const hov = .55 * (1 - slam);   // 悬停时抬高一点，不挡住 r1 的金额
    seal.position.set(SEAL.x + (1 - inK) * 2.2 + up * .6, SEAL.y + (1 - inK) * 2.4 + hov + up * 1.6, z);
    seal.rotation.set(0, 0, (1 - inK) * .35 - up * .12);
    seal.visible = tl > 4.85 && tl < 7.9;
    sealGoldMat.emissiveIntensity = .15 + 1.1 * Math.max(0, 1 - Math.abs(tl - STAMP_T) / .3);
    const ink = F.smooth((tl - STAMP_T + .02) / .06);
    const ifl = Math.max(0, 1 - (tl - STAMP_T) / .5) * (tl >= STAMP_T ? 1 : 0);
    imprint.visible = ink > .001; imprintMat.opacity = ink * .95;
    imprintMat.color.set(F.C.gold).multiplyScalar(1.35 + 1.6 * ifl);
    // 镜头：从翻开的上沿推下来，1.6 后稳在账单正前方，之后极慢地推近
    const x = F.mspline([[0, -1.6], [1.8, .35], [8, -.35]])(tl);
    const y = F.mspline([[0, 5.3], [1.8, 3.35], [8, 3.15]])(tl);
    const zc = F.mspline([[0, 9.4], [1.8, 13.4], [8, 12.3]])(tl);
    const ly = F.mspline([[0, 3.6], [1.8, 2.05], [8, 2.0]])(tl);
    F.aimCam(cam, [x, y, zc], [x * .25, ly, 0], 34);
  },
  overlay(g, tl) {
    bill.updateMatrixWorld(true);
    const P = (x, y) => F.project(cam, bill.localToWorld(V3(x, y, TH / 2 + .01)));
    const ink = F.C.ink;
    // 行：时长（青蓝条右侧）与金额（右对齐）
    ROW_Y.forEach((ry, i) => {
      const k = F.easeOut((tl - ROW_T[i] - .05) / .35); if (k <= 0) return;
      const ps = P(X_SEC, ry);
      const pa = P(X_AMT, ry);
      F.label(g, `${SECS[i]} 秒`, ps.x, ps.y, { size: 40, weight: 500, color: ink, halo: false, align: 'left', prog: k });
      F.label(g, yuan(SECS[i] * PRICE_CENTS), pa.x, pa.y, { size: 44, weight: 600, color: ink, halo: false, mono: true, align: 'right', prog: k });
    });
    // 合计：逐行累加（整数分），4.0 锁定变金
    const n = ROW_T.filter(t => tl >= t).length;
    const secs = SECS.slice(0, n).reduce((a, b) => a + b, 0);
    const bandIn = F.easeOut((tl - 1.3) / .5);
    if (bandIn > 0) {
      const pl = P(-3.05, BAND_Y), pr = P(X_AMT, BAND_Y);
      F.label(g, `合计 ${secs} 秒 × ${PRICE_STR}`, pl.x, pl.y, { size: 34, weight: 500, color: '#E8DFCF', align: 'left', prog: bandIn });
      const locked = tl >= LOCK_T;
      const pop = 1 + .12 * Math.max(0, 1 - Math.abs(tl - LOCK_T) / .3);
      const sp = F.bake(yuan(secs * PRICE_CENTS), { size: 64, weight: 700, mono: true, color: locked ? F.C.gold : '#E8DFCF', align: 'right' });
      g.save(); g.translate(pr.x, pr.y); g.scale(pop, pop); F.drawText(g, sp, 0, 0, { prog: bandIn }); g.restore();
    }
  },
  bloom: tl => .5 + .2 * Math.max(0, 1 - Math.abs(tl - STAMP_T) / .4),
});
})();

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 四层塔 56–64
// ════════════════════════════════════════════════════════════════════════════
(function () {
const T0 = 56, T1 = 64;
const FLOORS = [
  { name: '方案 · TREATMENT', fault: '设计错' },
  { name: '源码 · SVML', fault: '参数错' },
  { name: '配方 · Recipe', fault: null },
  { name: 'Run', fault: null },
];
const BAD = 1;                                  // 出问题的一层：源码
const SW = 2.8, SH = 1.0, PITCH = 1.1, BASE = .4;
const floorY = k => BASE + SH / 2 + .02 + k * PITCH;
const LOCKS = [.5, 1.0, 1.5, 2.0];
const LABEL_T = [2.5, 3.0, 3.5];                 // 三条"主人"标签（第 0、1、3 层）
const CRACK_T = 4.0, OUT_T = [4.5, 5.4], IN_T = [5.4, 6.0];

let cam, floors = [], pieces = [], fresh, freshGold, crackSegs = [], crackMat;

function buildFloor(k, { gold = false } = {}) {
  const g = new THREE.Group();
  const b = F.block(SW, SH, SW, F.mat.plaster, .04); g.add(b);
  const corn = F.block(SW + .22, .1, SW + .22, F.mat.plasterShade, .02); corn.position.y = SH / 2 + .05; g.add(corn);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(2.66, 2.66 * 200 / 1024),
    new THREE.MeshStandardMaterial({ color: '#fff', map: F.engrave(FLOORS[k].name, { w: 1024, h: 200, size: FLOORS[k].name.length > 12 ? 92 : FLOORS[k].name.length > 6 ? 104 : 132, weight: 600 }), roughness: .92 }));
  face.position.set(0, -.02, SW / 2 + .004); g.add(face);
  // 左侧面的窗光（每层三扇）
  for (let c = 0; c < 3; c++) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(.22, .36), F.C2b.winMat);
    w.position.set(-SW / 2 - .004, -.04, -.8 + c * .8); w.rotation.y = -Math.PI / 2; g.add(w);
  }
  let gm = null;
  if (gold) {       // 新换上的一层：底边一圈金线
    gm = F.goldMat();
    for (const [w, d, x, z] of [[SW + .04, .04, 0, SW / 2 + .01], [SW + .04, .04, 0, -SW / 2 - .01], [.04, SW + .04, SW / 2 + .01, 0], [.04, SW + .04, -SW / 2 - .01, 0]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, .035, d), gm); bar.position.set(x, -SH / 2 + .02, z); g.add(bar);
    }
  }
  return { g, gold: gm };
}

F.C2b = F.C2b || {};
F.C2b.winMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(F.C.window), emissiveIntensity: .9, roughness: 1 });

F.addScene({
  id: 's2b-tower', t0: T0, t1: T1,
  captions: [{ t0: 56.5, t1: 63.6, title: '修问题，修它的"主人"', body: '设计错改方案，参数错改源码，选错素材改 Run' }],
  build() {
    const scene = new THREE.Scene();
    F.makeEnv(scene, { fog: .026, keyDir: [-6, 10, 6], keyInt: 1.6, fillInt: .7, target: [0, 2.4, 0], shadowBox: 9 });
    const plinth = F.block(3.8, BASE, 3.8, F.mat.plasterShade, .05); plinth.position.y = BASE / 2; scene.add(plinth);
    FLOORS.forEach((f, k) => {
      const fl = buildFloor(k); fl.g.position.set(0, floorY(k), 0); scene.add(fl.g); floors.push(fl);
      // 分解图：层按楼层抬起，轻微翻转，逐拍落定
      pieces.push(F.piece(fl.g, { d: [0, 2.4 + k * 1.3, .3], axis: [1, 0, .4], ang: .28, t0: LOCKS[k] - 1.1, t1: LOCKS[k], mode: 'gather' }));
    });
    fresh = buildFloor(BAD, { gold: true }); freshGold = fresh.gold; scene.add(fresh.g);
    // 裂缝：一串细段，贴在源码层正面，跟着这一层走
    crackMat = new THREE.MeshStandardMaterial({ color: '#3A2A2A', emissive: new THREE.Color(F.C.red), emissiveIntensity: 0, roughness: .9 });
    const pts = [[.35, .5], [.22, .3], [.36, .12], [.08, -.04], [.2, -.22], [-.06, -.36], [.04, -.5]];
    const segGeo = new THREE.BoxGeometry(1, .04, .02); segGeo.translate(.5, 0, 0);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const m = new THREE.Mesh(segGeo, crackMat);
      m.position.set(x0 + .55, y0, SW / 2 + .012); m.rotation.z = Math.atan2(y1 - y0, x1 - x0);
      floors[BAD].g.add(m); crackSegs.push({ m, len: Math.hypot(x1 - x0, y1 - y0) + .015 });
    }
    F.buildTown(scene, { zFrom: -13, zTo: -70, seed: 41, density: .7 });
    cam = new THREE.PerspectiveCamera(36, F.W / F.H, .05, 400);
    F.ev(T0, 'hit');
    LOCKS.forEach(t => F.ev(T0 + t, 'lock'));
    F.ev(T0 + CRACK_T, 'hit'); F.ev(T0 + CRACK_T, 'crack');
    F.ev(T0 + OUT_T[0], 'whoosh', { dur: .9 });
    F.ev(T0 + 6.0, 'hit'); F.ev(T0 + 6.0, 'lock');
    F.ev(T0 + 6.0, 'riser', { dur: 2.0 });
    return { scene, camera: cam };
  },
  seek(tl) {
    F.poseAll(pieces, tl);
    // 裂缝 4.0 起 0.3 s 内逐段裂开
    crackSegs.forEach((s, i) => {
      const k = F.clamp((tl - CRACK_T - i * .04) / .06);
      s.m.visible = k > 0; s.m.scale.x = Math.max(.001, s.len * k);
    });
    crackMat.emissiveIntensity = tl < CRACK_T ? 0 : 1.1 + 3 * Math.max(0, 1 - (tl - CRACK_T) / .35);
    // 源码层：4.5 起沿 −x 抽出（先微微前移离开上下两层），5.4 后移出画面
    const bad = floors[BAD].g;
    if (tl >= OUT_T[0]) {
      const k = F.easeIn((tl - OUT_T[0]) / (OUT_T[1] - OUT_T[0]));
      bad.position.set(-9.5 * k, floorY(BAD), .25 * F.smooth((tl - OUT_T[0]) / .25));
      bad.rotation.set(0, .12 * k, 0);
    }
    bad.visible = tl < OUT_T[1] + .05;
    // 新的一层：从塔后方推入空位，6.0 锁定，金线闪一下后保留微光
    const kin = F.easeOut((tl - IN_T[0]) / (IN_T[1] - IN_T[0]));
    fresh.g.visible = tl > IN_T[0];
    fresh.g.position.set(0, floorY(BAD), -7 * (1 - kin));
    const fl = Math.max(0, 1 - Math.abs(tl - IN_T[1]) / .35);
    freshGold.emissiveIntensity = (tl >= IN_T[1] - .05 ? 1.1 : 0) + 6 * fl;
    // 镜头：左前方 3/4 视角，缓慢绕塔
    const th = F.mspline([[0, -.5], [8, -.28]])(tl);
    const R = F.mspline([[0, 13.2], [8, 12.2]])(tl);
    const y = F.mspline([[0, 4.3], [8, 3.8]])(tl);
    F.aimCam(cam, [R * Math.sin(th), y, R * Math.cos(th)], [1.35, 1.35, 0], 36);
  },
  overlay(g, tl) {
    // "主人"标签：塔右前角引一条细线到右侧文字
    const labels = [[0, 0], [1, 1], [3, 2]];
    for (const [k, li] of labels) {
      const fault = k === 0 ? '设计错' : k === 1 ? '参数错' : '选错素材';
      const k2 = F.easeOut((tl - LABEL_T[li]) / .45); if (k2 <= 0) continue;
      const a = F.project(cam, [SW / 2 + .06, floorY(k), SW / 2 + .06]); if (!a) continue;
      const x0 = a.x + 14, x1 = a.x + 14 + 150 * k2, tx = a.x + 184;
      let color = '#C9CFD9', lineC = 'rgba(201,207,217,.7)';
      if (k === BAD && tl >= CRACK_T) {
        const fixed = tl >= IN_T[1];
        color = fixed ? F.C.gold : F.C.red; lineC = fixed ? F.C.gold : F.C.red;
      }
      g.save(); g.globalAlpha = k2; g.strokeStyle = lineC; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x0, a.y); g.lineTo(x1, a.y); g.stroke();
      g.fillStyle = lineC; g.beginPath(); g.arc(x0, a.y, 4, 0, Math.PI * 2); g.fill(); g.restore();
      F.label(g, fault, tx, a.y, { size: 34, weight: 500, color, align: 'left', prog: k2 });
    }
  },
  bloom: tl => .5 + .3 * Math.max(0, 1 - Math.abs(tl - CRACK_T) / .4) + .3 * Math.max(0, 1 - Math.abs(tl - IN_T[1]) / .4),
});
})();
})();
