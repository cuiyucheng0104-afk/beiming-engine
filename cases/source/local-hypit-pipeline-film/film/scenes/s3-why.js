// s3-why.js — 为什么要关卡 64–72 s。
// 69 块石膏碎片落下，按 9 类失误堆成 9 堆（堆高 = 条数，FILM_META.categories），镜头从俯视落到平视；
// 最高一堆标"说过头 15"；最后一小节碎片被扫成一块两级、整齐的拱门地基（金线锁定），交给 72 s 的关卡道路。
'use strict';
(function () {
const F = window.F;
const T0 = 64, T1 = 72;
// 类别短名（BIBLE §5）按 FILM_META 的全名对应；n 一律取自数据
const SHORT = {
  '说过头、证据等级不清': '说过头', '绕开或替代既有方法': '绕开方法', '先做后问、先花钱后理解': '先做后问',
  '沟通与记录': '沟通与记录', '只看像不像，不看作用和运动': '只看像不像', '命令副作用、状态没核实': '副作用没核实',
  '凭据与合规': '凭据与合规', '等待方式与上下文成本': '等待与上下文', '范围漂移': '范围漂移',
};
const CATS = Object.entries(window.FILM_META.categories).map(([k, v]) => ({ name: SHORT[k] || k, n: v.n })).sort((a, b) => b.n - a.n);
const TOTAL = CATS.reduce((a, c) => a + c.n, 0);          // 69
if (TOTAL !== 69) console.warn('[s3-why] 失误总数不是 69：', TOTAL);

const BW = .62, BH = .24, STEP = .25, GAP = 1.06;
const pileX = k => (k - (CATS.length - 1) / 2) * GAP;
const landT = j => .5 + j * .17;                  // 第 j 层在 tl 落定（最高 15 层 2.88 s 落完）
const NAMES_T = 3.0, HERO_T = 4.0, SWEEP_T = 6.0, LOCK_T = 7.0;

let cam, blocks = [], goldMat, pileTops = [];

F.addScene({
  id: 's3-why', t0: T0, t1: T1,
  captions: [{ t0: 64.5, t1: 71.6, title: '一次复盘：69 条判断失误', body: '最多的一类（15 条）是"说过头"：所以每一关都要证据才放行' }],
  build() {
    const scene = new THREE.Scene();
    F.makeEnv(scene, { fog: .024, keyDir: [-6, 10, 7], keyInt: 1.65, fillInt: .72, target: [0, 1, 0], shadowBox: 10 });
    const r = F.rng(64);
    const proto = F.block(BW, BH, BW, F.mat.plaster, .03);
    const protoS = F.block(BW, BH, BW, F.mat.plasterShade, .03);
    // 地基格位：下层 12×4 = 48，上层 7×3 = 21，共 69
    const cells = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 4; j++) cells.push([(i - 5.5) * .64, BH / 2, (j - 1.5) * .64]);
    for (let i = 0; i < 7; i++) for (let j = 0; j < 3; j++) cells.push([(i - 3) * .64, BH / 2 + STEP, (j - 1) * .64 - .02]);
    cells.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    CATS.forEach((c, k) => {
      for (let j = 0; j < c.n; j++) {
        const m = (r() < .25 ? protoS : proto).clone();
        scene.add(m);
        const home = new THREE.Vector3(pileX(k) + (r() - .5) * .08, BH / 2 + j * STEP, (r() - .5) * .08);
        const homeRy = (r() - .5) * .22, sc = .9 + r() * .14;
        const fall = new THREE.Vector3((r() - .5) * 2.4, 6.5 + j * .35 + r() * 1.5, (r() - .5) * 2.4);
        const axis = new THREE.Vector3(r() - .5, r() - .5, r() - .5).normalize();
        blocks.push({ m, k, j, home, homeRy, sc, fall, axis, tl: landT(j) + k * .012, cell: null, sw0: 0 });
      }
      pileTops.push(c.n);
    });
    // 扫：按堆从左到右排序，对应地基格位从左到右
    const order = blocks.slice().sort((a, b) => a.home.x - b.home.x || a.j - b.j);
    order.forEach((b, i) => { b.cell = new THREE.Vector3(...cells[i]); b.sw0 = SWEEP_T + (b.home.x - pileX(0)) / (pileX(CATS.length - 1) - pileX(0)) * .3 + b.j * .004; });
    // 地基锁定的金线：下层、上层顶面外沿
    goldMat = F.goldMat();
    const ring = (w, d, y) => {
      for (const [bw, bd, x, z] of [[w, .035, 0, d / 2], [w, .035, 0, -d / 2], [.035, d, w / 2, 0], [.035, d, -w / 2, 0]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, .03, bd), goldMat); bar.position.set(x, y, z); scene.add(bar);
      }
    };
    ring(12 * .64 - .01, 4 * .64 - .01, BH + .005); ring(7 * .64 - .01, 3 * .64 - .01, BH + STEP + .005);
    F.C3why = { goldBars: scene.children.slice(-8) };
    F.C3why.goldBars.forEach(b => { b.visible = false; });
    F.buildTown(scene, { zFrom: -24, zTo: -80, seed: 17, density: .7 });
    cam = new THREE.PerspectiveCamera(40, F.W / F.H, .05, 400);
    // 声音
    F.ev(T0, 'hit'); F.ev(T0, 'whoosh', { dur: 3.5 });
    for (let b = 1; b <= 5; b++) F.ev(T0 + b * .5, 'thud', { soft: b < 5 });
    F.ev(T0 + NAMES_T, 'tick');
    F.ev(T0 + HERO_T, 'hit'); F.ev(T0 + HERO_T, 'tick');
    F.ev(T0 + SWEEP_T, 'hit'); F.ev(T0 + SWEEP_T, 'whoosh', { dur: 1.0 });
    F.ev(T0 + LOCK_T, 'lock'); F.ev(T0 + LOCK_T, 'thud');
    F.ev(T0 + 7.0, 'riser', { dur: 1.0 });
    return { scene, camera: cam };
  },
  seek(tl) {
    const q = new THREE.Quaternion(), qe = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0);
    for (const b of blocks) {
      // 落：分解图式的收拢（越来越慢，最后锁定），落定后原地不动
      const a = 1 - F.easeOut((tl - (b.tl - .95)) / .95);
      const pos = b.home.clone().addScaledVector(b.fall, a);
      q.setFromAxisAngle(yAxis, b.homeRy); qe.setFromAxisAngle(b.axis, .9 * a); q.multiply(qe);
      let s = b.sc;
      // 扫：弧线移到地基格位，转正、统一尺寸
      const k = F.easeIO((tl - b.sw0) / (LOCK_T - .02 - b.sw0));
      if (k > 0) {
        pos.lerp(b.cell, k); pos.y += Math.sin(k * Math.PI) * (1.0 + b.j * .03);
        q.slerp(qe.identity(), k); s = F.lerp(b.sc, 1, k);
      }
      b.m.position.copy(pos); b.m.quaternion.copy(q); b.m.scale.setScalar(s);
    }
    const on = tl >= LOCK_T - .02;
    F.C3why.goldBars.forEach(bar => { bar.visible = on; });
    goldMat.emissiveIntensity = .9 + 3 * Math.max(0, 1 - (tl - LOCK_T) / .45);
    // 镜头：俯视 → 平视（0–3.5），缓推（3.5–6），扫的时候降低并顺着 −z 看出去，接关卡道路
    const x = F.mspline([[0, .2], [3.5, .5], [6, .3], [8, 1.3]])(tl);
    const y = F.mspline([[0, 13.5], [3.5, 3.4], [6, 3.2], [8, 2.55]])(tl);
    const z = F.mspline([[0, 4.6], [3.5, 10.6], [6, 9.9], [8, 10.4]])(tl);
    const ly = F.mspline([[0, .1], [3.5, 1.05], [6, 1.05], [8, 1.0]])(tl);
    const lz = F.mspline([[0, .5], [3.5, 0], [6, 0], [8, -3.5]])(tl);
    F.aimCam(cam, [x, y, z], [x * .9, ly, lz], 40);
  },
  overlay(g, tl) {
    const fade = 1 - F.smooth((tl - 5.4) / .5);
    if (fade <= 0) return;
    CATS.forEach((c, k) => {
      // 堆顶计数：随落定的层数增加；说过头那堆在 4.0 换成大标签
      const landed = Math.min(c.n, Math.max(0, Math.floor((tl - .5 - k * .012) / .17 + 1e-6) + 1));
      if (landed <= 0) return;
      const topY = BH + (landed - 1) * STEP + .12;
      const pt = F.project(cam, [pileX(k), topY, 0]); if (!pt) return;
      const dim = tl > HERO_T ? F.lerp(1, .55, F.smooth((tl - HERO_T) / .4)) : 1;
      const heroK = k === 0 ? F.easeOut((tl - HERO_T) / .45) : 0;
      if (k === 0 && heroK > 0) {
        const lw = 64 * heroK;
        F.label(g, `${c.name} ${c.n}`, pt.x, pt.y - 62, { size: 56, weight: 700, prog: heroK, alpha: fade });
        g.save(); g.globalAlpha = fade * heroK; g.fillStyle = F.C.gold; g.fillRect(pt.x - lw / 2, pt.y - 24, lw, 2); g.restore();
      }
      F.label(g, String(landed), pt.x, pt.y - 26, { size: 30, weight: 600, mono: true, color: F.C.ivory, alpha: fade * dim * (1 - heroK) });
      // 堆底类名
      const nk = F.easeOut((tl - NAMES_T - k * .04) / .45);
      if (nk > 0 && !(k === 0 && heroK >= 1)) {
        const pb = F.project(cam, [pileX(k), 0, .45]);
        if (pb) F.label(g, c.name, pb.x, pb.y + 26 + (k % 2) * 30, { size: 25, weight: 500, color: '#D5D9E0', prog: nk, alpha: fade * dim * (k === 0 ? 1 - heroK : 1) });
      }
    });
  },
  bloom: tl => .5 + .15 * Math.max(0, 1 - Math.abs(tl - LOCK_T) / .4),
});
})();
