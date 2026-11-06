// s2a-principles.js — 原理 1–3（24–48 s），三个场景各 8 s（4 小节）：
//   s2a-1 24–32 骨架先搭好，光再灌进去   s2a-2 32–40 统一时钟，按原帧放置   s2a-3 40–48 钉住满意的结果
// 共享小工具挂在 F.s2a 下（只在本文件用）。
'use strict';
(function () {
const F = window.F;
const CF = (window.FILM_DATA && FILM_DATA.shots && FILM_DATA.shots.cut_frames) || [0, 27, 42, 66, 88, 104, 114, 128, 135, 147, 161, 171, 191, 249];
const NS = CF.length - 1;                 // 13 个镜头
const S = .06;                            // 每帧 0.06 m
const X = f => (f - (CF[NS] / 2)) * S;    // 帧号 → 世界 x（时间轨居中）
const LETTERS = 'ABCDEFGHIJKLM';
const S2A = F.s2a = {};

// 图片按"cover"裁进 w×h 的面板：返回 { tex, rx, ry, ox, oy }
S2A.coverTex = function (i, w, h) {
  const tex = F.frameTexture(i); if (!tex) return null;
  const a = w / h, ia = 2;                // 截帧 640×320
  let rx = 1, ry = 1;
  if (a < ia) rx = a / ia; else ry = ia / a;
  const ox = (1 - rx) / 2, oy = (1 - ry) / 2;
  tex.repeat.set(rx, ry); tex.offset.set(ox, oy);
  return { tex, rx, ry, ox, oy };
};
const glowMat = (hex, k = 0) => { const m = F.glow(hex, k); return m; };
const fadeLabel = (t, a, b) => Math.min(F.easeOut((t - a) / .4), 1 - F.smooth((t - (b - .3)) / .3));

// ════════════════════════════════════════════════════════════════════════════
// 原理 1：骨架先搭好（13 个空段落 + 字幕条 + 原声），再把生成的画面灌进去
// ════════════════════════════════════════════════════════════════════════════
(function () {
  const T0 = 24, T1 = 32;
  const LOCK = 24.5, CAP_LOCK = 25.0, WAVE_LOCK = 25.5, GOLD_PULSE = 26.0, POUR = 28.0, SEAL = 30.0;
  const FILL_DUR = .4;
  const fillStart = i => POUR + (CF[i] / CF[NS]) * 1.5;
  let cam, pieces = [], panes = [], ribGlow = [], wave, waveBars = [], waveGroup, WN = 0;
  const camK = {};

  F.addScene({
    id: 's2a-1', t0: T0, t1: T1,
    captions: [{ t0: 24.5, t1: 31.6, title: '结构交给代码，素材交给生成', body: '先搭好骨架：13 个空段落、字幕条、原声；生成的画面再灌进去' }],
    build() {
      const scene = new THREE.Scene();
      F.makeEnv(scene, { fog: .02, keyDir: [-6, 9, 7], keyInt: 1.6, target: [0, .8, 0], shadowBox: 12 });
      const L = X(CF[NS]) - X(0);
      // 阶梯底座：后层放画面，中层放字幕条，前层放原声
      const stepB = F.block(L + 1.4, .6, 1.0, F.mat.plasterShade, .04); stepB.position.set(0, .3, -.8); scene.add(stepB);
      const stepM = F.block(L + 1.4, .4, .7, F.mat.plasterShade, .04); stepM.position.set(0, .2, .05); scene.add(stepM);
      const stepF = F.block(L + 1.4, .2, .7, F.mat.plasterShade, .04); stepF.position.set(0, .1, .75); scene.add(stepF);
      // 画面骨架：下梁、上梁、14 根肋（落在切点上）、13 块深色凹板
      const recess = new THREE.MeshStandardMaterial({ color: '#343B4B', roughness: .96 });
      const botBeam = F.block(L + .3, .12, .3, F.mat.plaster, .02); botBeam.position.set(0, .66, -.8); scene.add(botBeam);
      const topBeam = F.block(L + .3, .12, .3, F.mat.plaster, .02); topBeam.position.set(0, 1.68, -.8); scene.add(topBeam);
      pieces.push(F.piece(botBeam, { d: [0, 1.6, 1.4], axis: [1, 0, 0], ang: .2, t0: 23.8, t1: LOCK }));
      pieces.push(F.piece(topBeam, { d: [0, 3.4, .8], axis: [1, 0, 0], ang: -.25, t0: 23.9, t1: LOCK }));
      const r = F.rng(241);
      for (let k = 0; k <= NS; k++) {
        const rib = F.block(.06, .9, .3, F.mat.plaster, .01); rib.position.set(X(CF[k]), 1.17, -.8); scene.add(rib);
        pieces.push(F.piece(rib, { d: [(r() - .5) * .8, 2.2 + r() * 1.6, .9 + r() * .8], axis: [0, 0, 1], ang: (r() - .5) * .7, t0: 23.75 + r() * .15, t1: LOCK }));
        const gm = glowMat(F.C.gold, 0); const gl = new THREE.Mesh(new THREE.PlaneGeometry(.018, .9), gm);
        gl.position.set(0, 0, .152); rib.add(gl); ribGlow.push(gm);
      }
      const fillEdgeMat = [];
      for (let i = 0; i < NS; i++) {
        const x0 = X(CF[i]), x1 = X(CF[i + 1]), cx = (x0 + x1) / 2, w = x1 - x0 - .06;
        const back = F.block(w, .9, .06, recess, .01); back.position.set(cx, 1.17, -.93); scene.add(back);
        pieces.push(F.piece(back, { d: [0, 0, -1.6], axis: [0, 1, 0], ang: .15, t0: 23.8, t1: LOCK }));
        // 灌光的画面：几何原点在底边，scale.y = 灌满比例
        const ct = S2A.coverTex(i, w, .9);
        const mat = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#FFFFFF', emissiveMap: ct.tex, emissiveIntensity: 1, roughness: 1 });
        const geo = new THREE.PlaneGeometry(w, .9); geo.translate(0, .45, 0);
        const mesh = new THREE.Mesh(geo, mat); mesh.position.set(cx, .72, -.885); scene.add(mesh);
        const em = glowMat(F.C.window, 5); fillEdgeMat.push(em);
        const edge = new THREE.Mesh(new THREE.BoxGeometry(w, .022, .02), em); edge.position.set(cx, .72, -.875); scene.add(edge);
        panes.push({ mesh, mat, ct, edge, em, cx, w });
      }
      // 字幕条（中层）：一条石膏条 + 一道凹槽
      const capBar = F.block(L, .1, .34, F.mat.plaster, .02); capBar.position.set(0, .45, .05); scene.add(capBar);
      const groove = new THREE.Mesh(new THREE.PlaneGeometry(L - .2, .1), recess); groove.rotation.x = -Math.PI / 2; groove.position.set(0, .051, 0); capBar.add(groove);
      pieces.push(F.piece(capBar, { d: [0, 1.8, 1.3], axis: [1, 0, 0], ang: .3, t0: 24.3, t1: CAP_LOCK }));
      // 原声波形（前层）：一排石膏细条
      waveGroup = new THREE.Group(); waveGroup.position.set(0, .2, .75); scene.add(waveGroup);
      WN = 190;
      const rw = F.rng(77);
      wave = new THREE.InstancedMesh(new THREE.BoxGeometry(.045, 1, .16), F.mat.plaster, WN); wave.castShadow = wave.receiveShadow = true;
      for (let j = 0; j < WN; j++) {
        const x = X(0) + (j + .5) * L / WN;
        const env = .35 + .65 * Math.abs(Math.sin(j * .19 + .6)) * (.55 + .45 * Math.sin(j * .043 + 1.2));
        waveBars.push({ x, h: .03 + .26 * env * (.45 + .55 * rw()) });
      }
      waveGroup.add(wave);
      pieces.push(F.piece(waveGroup, { d: [0, 1.4, 1.6], axis: [1, 0, 0], ang: .25, t0: 24.8, t1: WAVE_LOCK }));
      F.buildTown(scene, { zFrom: -14, zTo: -80, seed: 23, density: .8 });
      cam = S2A.cam1 = new THREE.PerspectiveCamera(40, F.W / F.H, .05, 400);
      // 镜头：左前方低角度 → 正面抬高看全貌
      const keys = [[0, [-11.6, 2.0, 4.4], [-5.6, .6, -.6]], [3.4, [-11.0, 2.3, 5.4], [-4.6, .6, -.6]], [5.6, [-10.9, 3.0, 8.0], [-2.2, .55, -.6]], [8, [-11.3, 3.2, 8.9], [-1.8, .5, -.6]]];
      for (let c = 0; c < 3; c++) {
        camK['p' + c] = F.mspline(keys.map(k => [k[0], k[1][c]]));
        camK['l' + c] = F.mspline(keys.map(k => [k[0], k[2][c]]));
      }
      // 声音
      F.ev(24.0, 'hit'); F.ev(24.0, 'whoosh', { dur: .5, soft: true });
      F.ev(LOCK, 'lock', { n: 14 }); F.ev(CAP_LOCK, 'lock'); F.ev(WAVE_LOCK, 'thud');
      F.ev(GOLD_PULSE, 'lock', { soft: true });
      F.ev(POUR, 'hit'); F.ev(POUR, 'whoosh', { dur: 1.9, soft: true });
      for (let i = 0; i < NS; i++) F.ev(fillStart(i), 'tick', { i });
      F.ev(SEAL, 'lock', { n: 13 });
      return { scene, camera: cam };
    },
    seek(tl, t) {
      F.poseAll(pieces, t);
      // 原声波形：落定后从左到右长出来
      const m4 = new THREE.Matrix4();
      for (let j = 0; j < WN; j++) {
        const b = waveBars[j];
        const g = F.easeOut((t - (WAVE_LOCK + (b.x - X(0)) / (X(CF[NS]) - X(0)) * .45)) / .25);
        const h = Math.max(.001, b.h * (.15 + .85 * g));
        m4.makeScale(1, h, 1); m4.setPosition(b.x, h / 2, 0); wave.setMatrixAt(j, m4);
      }
      wave.instanceMatrix.needsUpdate = true;
      // 肋上的金线：26.0 一次脉冲后保持微亮；30.0 灌满后再闪一次
      const pulse = x => Math.max(0, 1 - Math.abs(x) / .3);
      for (let k = 0; k <= NS; k++) {
        const wavefront = GOLD_PULSE + (CF[k] / CF[NS]) * .3;
        const base = .9 * F.smooth((t - GOLD_PULSE) / .3);
        ribGlow[k].emissiveIntensity = base + 3.5 * pulse(t - wavefront) + 2.5 * pulse(t - SEAL);
      }
      // 灌光：每格在 fillStart(i) 开始从下往上灌满
      for (let i = 0; i < NS; i++) {
        const p = panes[i], k = F.easeIO((t - fillStart(i)) / FILL_DUR);
        p.mesh.visible = k > .001;
        p.mesh.scale.y = Math.max(.001, k);
        p.ct.tex.repeat.y = p.ct.ry * Math.max(.001, k); p.ct.tex.offset.y = p.ct.oy;
        p.mat.emissiveIntensity = 1 + .6 * pulse(t - SEAL) * .6;
        p.edge.visible = k > .001 && k < .999;
        p.edge.position.y = .72 + .9 * k;
        p.em.emissiveIntensity = 5 * Math.sin(Math.PI * k);
      }
      const P = [camK.p0(tl), camK.p1(tl), camK.p2(tl)], Lk = [camK.l0(tl), camK.l1(tl), camK.l2(tl)];
      F.aimCam(cam, P, Lk, 40);
    },
    overlay(g, tl, t) {
      // 骨架三层的名字（左端，落定时出现，灌光前退场）
      const items = [['13 个空段落', [X(0) - .3, 1.17, -.65], LOCK], ['字幕条', [X(0) - .3, .45, .22], CAP_LOCK], ['原声', [X(0) - .3, .38, .75], WAVE_LOCK]];
      for (const [s, p, ta] of items) {
        const a = fadeLabel(t, ta + .05, 27.9); if (a <= .004) continue;
        const q = F.project(cam, p); if (!q || q.y > 790) continue;
        F.label(g, s, q.x - 14, q.y, { size: 28, weight: 500, align: 'right', prog: F.easeOut((t - ta - .05) / .4), alpha: 1 - F.smooth((t - 27.6) / .3) });
      }
      // 灌光时：生成的画面（青蓝）
      const a2 = fadeLabel(t, POUR + .5, 31.75);
      if (a2 > .004) {
        const q = F.project(cam, [0, 2.05, -.8]);
        if (q) F.label(g, '生成的画面', q.x, q.y - 26, { size: 30, weight: 500, color: F.C.teal, prog: F.easeOut((t - POUR - .5) / .4), alpha: 1 - F.smooth((t - 31.45) / .3) });
      }
    },
    bloom: (tl, t) => .55 + .25 * Math.max(0, 1 - Math.abs(t - SEAL) / .4),
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// 原理 2：统一时钟。24/25/60 fps 三条尺 → 齿轮 → 30 fps；13 块按原帧落位
// ════════════════════════════════════════════════════════════════════════════
(function () {
  const T0 = 32, T1 = 40;
  const EMERGE0 = 33.0, EMERGE1 = 35.0, DROP0 = 36.0, DSTEP = .25, END_LOCK = 39.0;
  const land = i => DROP0 + DSTEP * i;
  const FPS_IN = [24, 25, 60];
  const XEXIT = -8.2, XEND = X(252);
  let cam, rulerIn = [], outSlab, outTicks, gears = [], blocks = [], marks = [];
  const camK = {};

  function tickTexIn(fps) {
    const [c, x] = F.canvas(1024, 128);
    x.fillStyle = F.C.plaster; x.fillRect(0, 0, 1024, 128);
    for (let k = 0; k < fps; k++) {
      const px = k * 1024 / fps, major = k === 0;
      x.fillStyle = major ? '#4A4640' : '#77716A';
      x.fillRect(px, major ? 0 : 128 * .5, major ? 5 : 2.5, major ? 128 : 64);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8;
    return t;
  }
  function tickTexOut(len) {
    const Wc = 4096, Hc = 96, [c, x] = F.canvas(Wc, Hc);
    x.fillStyle = F.C.plaster; x.fillRect(0, 0, Wc, Hc);
    for (let f = 0; f <= 250; f++) {
      const px = (X(f) - XEXIT) / len * Wc;
      const sec = f % 30 === 0, five = f % 5 === 0;
      x.fillStyle = sec ? '#3E3A35' : five ? '#5E5953' : '#8A847C';
      const h = sec ? Hc : five ? Hc * .62 : Hc * .38;
      x.fillRect(px - (sec ? 2 : 1), Hc - h, sec ? 4 : 2, h);   // 刻度从前缘（画布下缘）长出
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
    return t;
  }
  function gearGeo(r, n, th = .16) {
    const s = new THREE.Shape(), ri = r - .1, st = Math.PI * 2 / n;
    for (let k = 0; k < n; k++) {
      const a = k * st, pts = [[ri, a], [r, a + .18 * st], [r, a + .47 * st], [ri, a + .65 * st]];
      pts.forEach(([rr, aa], j) => { const px = rr * Math.cos(aa), py = rr * Math.sin(aa); if (k === 0 && j === 0) s.moveTo(px, py); else s.lineTo(px, py); });
    }
    s.closePath();
    const hole = new THREE.Path(); hole.absarc(0, 0, r * .18, 0, Math.PI * 2, true); s.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(s, { depth: th, bevelEnabled: true, bevelThickness: .02, bevelSize: .015, bevelSegments: 1, curveSegments: 6 });
    geo.translate(0, 0, -th / 2);
    return geo;
  }

  F.addScene({
    id: 's2a-2', t0: T0, t1: T1,
    captions: [{ t0: 32.5, t1: 39.6, title: '统一时钟，按原帧放置', body: '不同帧率的素材换算到每秒 30 帧；13 个镜头落在第 0、27、42 … 249 帧' }],
    build() {
      F.renderer.localClippingEnabled = true;       // 只影响带 clippingPlanes 的材质（本场景的 30 fps 尺）
      const scene = new THREE.Scene();
      F.makeEnv(scene, { fog: .026, keyDir: [-6, 10, 7], keyInt: 1.65, target: [-2, .8, 0], shadowBox: 16 });
      // 输入三条尺（左）：底座 + 尺身 + 刻度面（纹理滚动 = 尺在走）
      // 三层阶梯架，三条尺竖着排（刻度在正面，朝镜头）
      const sup = F.block(11.6, .5, 2.2, F.mat.plasterShade, .05); sup.position.set(-18.1, .25, -.2); scene.add(sup);
      const RY = [1.75, 1.25, .75];
      RY.forEach((y, k) => {
        const slab = F.block(11.2, .3, .22, F.mat.plaster, .02); slab.position.set(-17.95, y, .2 - k * .0); scene.add(slab);
        const post = F.block(.3, y - .5, .2, F.mat.plasterShade, .02); post.position.set(-22.8 + k * 1.3, .5 + (y - .5) / 2, .2); scene.add(post);
        const post2 = post.clone(); post2.position.x = -15.2 - k * 1.3; scene.add(post2);
        const tex = tickTexIn(FPS_IN[k]); tex.repeat.x = 11 / 1.8;
        const face = new THREE.Mesh(new THREE.PlaneGeometry(11, .26), new THREE.MeshStandardMaterial({ color: '#FFFFFF', map: tex, roughness: .92 }));
        face.position.set(-17.9, y, .2 + .111); face.receiveShadow = true; scene.add(face);
        rulerIn.push({ tex, y });
      });
      // 齿轮箱
      const box = F.block(4, 2.3, 2.8, F.mat.plaster, .06); box.position.set(-10.2, 1.15, 0); scene.add(box);
      const slotMat = new THREE.MeshStandardMaterial({ color: '#232A3A', roughness: 1 });
      for (const y of RY) { const sl = new THREE.Mesh(new THREE.PlaneGeometry(.4, .38), slotMat); sl.rotation.y = -Math.PI / 2; sl.position.set(-12.21, y, .2); scene.add(sl); }
      const ex = new THREE.Mesh(new THREE.PlaneGeometry(1.1, .38), slotMat); ex.rotation.y = Math.PI / 2; ex.position.set(-8.19, .95, 0); scene.add(ex);
      const G = [[.74, 18, -11.05, 1.0], [.5, 12, -11.05 + .74 + .5 - .04, 1.0], [.37, 9, -11.05 + .74 + .5 - .04, 1.0 + .5 + .37 - .04]];
      G.forEach(([r, n, x, y], k) => {
        const gm = new THREE.Mesh(gearGeo(r, n), F.mat.plaster); gm.castShadow = gm.receiveShadow = true;
        gm.position.set(x, y, 1.48); scene.add(gm);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * .16, r * .16, .26, 24), k === 2 ? F.goldMat() : F.mat.plasterShade);
        hub.rotation.x = Math.PI / 2; hub.position.set(x, y, 1.5); scene.add(hub);
        if (k === 2) hub.material.emissiveIntensity = 1.2;
        gears.push({ mesh: gm, n, phase: k === 1 ? Math.PI / 12 : k === 2 ? Math.PI / 9 : 0 });
      });
      // 输出：30 fps 尺（从齿轮箱出口挤出来，出口左侧裁掉）
      const clip = [new THREE.Plane(new THREE.Vector3(1, 0, 0), -XEXIT)];
      const bed = F.block(XEND - XEXIT + .6, .8, 2.0, F.mat.plasterShade, .05); bed.position.set((XEND + XEXIT) / 2 + .3, .4, 0); scene.add(bed);
      const len = XEND - XEXIT;
      const slabMat = F.mat.plaster.clone(); slabMat.clippingPlanes = clip; slabMat.clipShadows = true;
      outSlab = F.block(len, .3, 1.0, slabMat, .02); outSlab.position.set((XEND + XEXIT) / 2, .95, 0); scene.add(outSlab);
      const ttex = tickTexOut(len);
      const faceMat = new THREE.MeshStandardMaterial({ color: '#FFFFFF', map: ttex, roughness: .92, clippingPlanes: clip });
      outTicks = new THREE.Mesh(new THREE.PlaneGeometry(len, .27), faceMat);
      outTicks.position.set(0, 0, .502); outTicks.receiveShadow = true; outSlab.add(outTicks);
      outSlab.userData.homeX = outSlab.position.x;
      // 切点金线（尺面上）
      for (let k = 0; k <= NS; k++) {
        const m = glowMat(F.C.gold, 0);
        const mk = new THREE.Mesh(new THREE.BoxGeometry(.028, .28, .012), m); mk.position.set(X(CF[k]), .95, .506); scene.add(mk);
        marks.push({ mesh: mk, mat: m });
      }
      // 13 块镜头块：宽 = 镜头帧数，刻镜头字母
      const r = F.rng(512);
      for (let i = 0; i < NS; i++) {
        const w = (CF[i + 1] - CF[i]) * S - .035, cx = (X(CF[i]) + X(CF[i + 1])) / 2;
        const b = F.block(w, .34, .6, F.mat.plaster, .025); b.position.set(cx, 1.1 + .17, -.05); scene.add(b);
        const lt = F.engrave(LETTERS[i], { w: 128, h: 128, size: 84, weight: 600 });
        const face = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(.24, w - .06), Math.min(.24, w - .06)), new THREE.MeshStandardMaterial({ color: '#FFFFFF', map: lt, roughness: .92 }));
        face.position.set(0, 0, .302); b.add(face);
        blocks.push({ mesh: b, home: b.position.clone(), tilt: (r() - .5) * .6, spin: (r() - .5) * .5 });
      }
      F.buildTown(scene, { zFrom: -26, zTo: -90, seed: 41, density: .8 });
      cam = S2A.cam2 = new THREE.PerspectiveCamera(40, F.W / F.H, .05, 400);
      const keys = [[0, [-10.2, 2.6, 8.6], [-10.9, 1.2, 0]], [2.0, [-9.6, 2.7, 8.2], [-9.9, 1.15, 0]], [3.9, [-5.9, 2.5, 5.7], [-5.3, 1.0, 0]], [4.3, [-5.6, 2.5, 5.7], [-5.0, 1.0, 0]], [6.0, [.4, 2.5, 5.7], [1.0, 1.0, 0]], [7.4, [.4, 4.9, 13.0], [.3, .8, 0]], [8, [.4, 4.75, 12.6], [.3, .8, 0]]];
      for (let c = 0; c < 3; c++) { camK['p' + c] = F.mspline(keys.map(k => [k[0], k[1][c]])); camK['l' + c] = F.mspline(keys.map(k => [k[0], k[2][c]])); }
      // 声音
      F.ev(32.0, 'hit');
      for (let b = 0; b < 8; b++) F.ev(32.0 + b * .5, 'gear', { i: b });
      F.ev(EMERGE0, 'whoosh', { dur: 2, soft: true });
      F.ev(34.0, 'whoosh', { dur: 2 });
      F.ev(DROP0, 'hit');
      for (let i = 0; i < NS; i++) { F.ev(land(i), 'thud', { i, soft: true }); F.ev(land(i), 'tick', { i }); }
      F.ev(END_LOCK, 'lock');
      return { scene, camera: cam };
    },
    seek(tl, t) {
      // 输入尺在走（连续），齿轮每拍咔哒一齿
      for (const ru of rulerIn) ru.tex.offset.x = -(tl * .9) / 1.8;
      const beats = tl * 2, bi = Math.floor(beats), step = bi + F.easeOut((beats - bi) / .3);
      gears.forEach((gr, k) => {
        const base = step * Math.PI * 2 / 18;   // 大齿轮一拍转一齿
        const a = k === 0 ? base : k === 1 ? -base * 18 / 12 : base * 18 / 9;
        gr.mesh.rotation.z = a + gr.phase;
      });
      // 30 fps 尺挤出
      const e = F.easeIO((t - EMERGE0) / (EMERGE1 - EMERGE0));
      outSlab.position.x = outSlab.userData.homeX - (XEND - XEXIT + .2) * (1 - e);
      // 镜头块：34.0 起从高处降到悬停，落拍依次落位
      for (let i = 0; i < NS; i++) {
        const b = blocks[i], TL = land(i), DD = .42;
        const drop = F.easeIn((t - (TL - DD)) / DD);
        const up = 3.2 * (1 - drop);
        b.mesh.visible = t > TL - DD - .01;
        b.mesh.position.set(b.home.x, b.home.y + up, b.home.z);
        const tw = (1 - drop);
        b.mesh.rotation.set(0, b.spin * tw, b.tilt * tw);
        const fl = Math.max(0, 1 - Math.abs(t - TL) / .25);
        marks[i].mat.emissiveIntensity = t < TL ? 0 : 1.4 + 4 * fl;
        marks[i].mesh.visible = t > EMERGE1;
      }
      const fe = Math.max(0, 1 - Math.abs(t - END_LOCK) / .25);
      marks[NS].mat.emissiveIntensity = t < END_LOCK ? 0 : 1.4 + 4 * fe;
      marks[NS].mesh.visible = t > EMERGE1;
      const P = [camK.p0(tl), camK.p1(tl), camK.p2(tl)], Lk = [camK.l0(tl), camK.l1(tl), camK.l2(tl)];
      F.aimCam(cam, P, Lk, 40);
    },
    overlay(g, tl, t) {
      // 输入尺的帧率
      const inA = 1 - F.smooth((t - 33.65) / .3);
      if (inA > .004) FPS_IN.forEach((fps, k) => {
        const q = F.project(cam, [-14.6, rulerIn[k].y, .31]); if (!q || q.y > 790) return;
        F.label(g, `${fps} fps`, q.x - 20, q.y, { size: 30, weight: 600, mono: true, align: 'right', prog: F.easeOut((t - 32.0 - k * .08) / .35), alpha: inA });
      });
      // 输出 30 fps（金）
      const oa = fadeLabel(t, 34.0, 39.85);
      if (oa > .004) {
        const q = F.project(cam, [XEXIT + .15, 1.1, .5]);
        if (q && q.y < 790) F.label(g, '30 fps', q.x, q.y - 40, { size: 34, weight: 600, mono: true, color: F.C.gold, align: 'left', prog: F.easeOut((t - 34.0) / .4), alpha: 1 - F.smooth((t - 39.55) / .3) });
      }
      // 切点帧号：落位时出现，两行交错；细引线连到刻度
      const endA = 1 - F.smooth((t - 39.55) / .3);
      for (let k = 0; k <= NS; k++) {
        const ta = k < NS ? land(k) : END_LOCK;
        const p = F.easeOut((t - ta) / .3); if (p <= .004 || endA <= .004) continue;
        const q = F.project(cam, [X(CF[k]), .8, .5]); if (!q) continue;
        const row = k % 2 === 0 ? 0 : 1, ly = q.y + 30 + row * 40;
        if (ly > 790) continue;
        g.save(); g.globalAlpha = p * endA; g.strokeStyle = k === NS ? F.C.gold : 'rgba(242,180,90,.75)'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(q.x, q.y + 2); g.lineTo(q.x, ly - 17); g.stroke(); g.restore();
        F.label(g, String(CF[k]), q.x, ly, { size: 28, weight: 600, mono: true, color: k === NS ? F.C.gold : F.C.ivory, prog: p, alpha: endA });
      }
    },
    bloom: () => .55,
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// 原理 3：金色图钉钉住一格；重建扫描光扫过，其他格闪动重排，钉住的格纹丝不动
// ════════════════════════════════════════════════════════════════════════════
(function () {
  const T0 = 40, T1 = 48;
  const PIN = 40.5, SCANS = [42.0, 44.0], SCAN_DUR = 1.5, SETTLE = 46.0;
  const PI_ = 3;                            // 钉住第 D 格（眼睛特写）
  const SX0 = -13.2, SX1 = 13.2;
  let cam, strip, texs = [], pin, pinFrom, pinTo, halo, scanBar, scanSheet, scanMat, sheetMat;
  const camK = {};
  const scanX = (t, s) => F.lerp(SX0, SX1, F.clamp((t - SCANS[s]) / SCAN_DUR));
  const passT = (s, x) => SCANS[s] + SCAN_DUR * (x - SX0) / (SX1 - SX0);

  F.addScene({
    id: 's2a-3', t0: T0, t1: T1,
    captions: [{ t0: 40.5, t1: 47.6, title: '钉住满意的结果', body: 'build-record + satisfy：改剪辑、改字幕，都不再重新生成' }],
    build() {
      const scene = new THREE.Scene();
      F.makeEnv(scene, { fog: .018, keyDir: [-5, 9, 8], keyInt: 1.6, target: [-2, 1.5, 0], shadowBox: 16 });
      strip = F.buildStrip({ paneW: 1.6 });
      strip.group.position.set(0, 2.25, 0); scene.add(strip.group);
      strip.panes.forEach((p, i) => { texs.push(p.mat.emissiveMap); p.home = p.group.position.clone(); });
      for (let k = -3; k <= 3; k++) {
        const b = F.block(2.4, .5 + Math.abs(k) * .12, 2.2, F.mat.plasterShade, .05);
        b.position.set(k * 4.4, .25, -3.2 - Math.abs(k) * .9); scene.add(b);
      }
      // 图钉：金色钉帽 + 颈 + 钢针（沿 -z 扎进画面）
      pin = new THREE.Group();
      const gm = F.goldMat(); gm.emissiveIntensity = .4;
      const head = new THREE.Mesh(new THREE.CylinderGeometry(.14, .14, .08, 40), gm); head.rotation.x = Math.PI / 2; head.position.z = .42; head.castShadow = true;
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(.055, .09, .2, 32), gm); neck.rotation.x = Math.PI / 2; neck.position.z = .28; neck.castShadow = true;
      const needle = new THREE.Mesh(new THREE.CylinderGeometry(.016, .006, .4, 12), new THREE.MeshStandardMaterial({ color: '#A7ADB6', metalness: .7, roughness: .35 }));
      needle.rotation.x = Math.PI / 2; needle.position.z = .0;
      pin.add(head, neck, needle); pin.userData.gm = gm;
      strip.group.add(pin);
      const px = strip.panes[PI_].home.x;
      pinTo = new THREE.Vector3(px - strip.paneW / 2 + .02, strip.paneH / 2 + .02, .2);
      pinFrom = new THREE.Vector3(px - .2, strip.paneH / 2 + 1.0, 2.0);
      halo = new THREE.Mesh(new THREE.RingGeometry(.3, .34, 72), new THREE.MeshBasicMaterial({ color: new THREE.Color(F.C.gold).multiplyScalar(2.2), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      halo.position.copy(pinTo).setZ(.5); strip.group.add(halo);
      // 重建扫描光：一道青蓝细光 + 柔光片
      scanMat = glowMat(F.C.teal, 5);
      scanBar = new THREE.Mesh(new THREE.BoxGeometry(.05, strip.paneH + 1.1, .05), scanMat); scanBar.position.z = .35; strip.group.add(scanBar);
      const [c, x] = F.canvas(256, 8); const gr = x.createLinearGradient(0, 0, 256, 0);
      gr.addColorStop(0, 'rgba(63,183,176,0)'); gr.addColorStop(.85, 'rgba(63,183,176,.55)'); gr.addColorStop(1, 'rgba(63,183,176,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 256, 8);
      const st = new THREE.CanvasTexture(c); st.colorSpace = THREE.SRGBColorSpace;
      sheetMat = new THREE.MeshBasicMaterial({ map: st, transparent: true, opacity: .7, depthWrite: false, blending: THREE.AdditiveBlending });
      scanSheet = new THREE.Mesh(new THREE.PlaneGeometry(2.2, strip.paneH + 1.1), sheetMat); scanSheet.position.z = .33; strip.group.add(scanSheet);
      F.buildTown(scene, { zFrom: -6, zTo: -70, seed: 57, density: .8 });
      cam = S2A.cam3 = new THREE.PerspectiveCamera(38, F.W / F.H, .05, 400);
      const keys = [[0, [-2.9, 3.05, 5.2], [-5.25, 2.45, 0]], [1.6, [-3.2, 3.0, 4.5], [-5.3, 2.35, 0]], [3.2, [-12.2, 3.9, 9.8], [-2.4, 2.1, 0]], [5.8, [-11.6, 4.2, 11.6], [-1.2, 2.0, 0]], [8, [-8.2, 4.1, 16.2], [-.4, 1.95, 0]]];
      for (let cc = 0; cc < 3; cc++) { camK['p' + cc] = F.mspline(keys.map(k => [k[0], k[1][cc]])); camK['l' + cc] = F.mspline(keys.map(k => [k[0], k[2][cc]])); }
      // 声音
      F.ev(40.0, 'hit'); F.ev(PIN, 'pin'); F.ev(41.0, 'tick', { n: 0 });
      SCANS.forEach((s, k) => { F.ev(s, 'hit'); F.ev(s, 'whoosh', { dur: SCAN_DUR }); F.ev(s, 'tick', { n: k + 1 }); F.ev(s + SCAN_DUR, 'lock', { soft: true }); });
      F.ev(SETTLE, 'whoosh', { dur: 2, soft: true }); F.ev(SETTLE, 'lock');
      return { scene, camera: cam };
    },
    seek(tl, t) {
      // 图钉：飞入 → 40.5 扎下
      const k = F.easeIn((t - (PIN - .6)) / .6);
      pin.position.lerpVectors(pinFrom, pinTo, k);
      const push = t > PIN ? -.05 * Math.max(0, 1 - (t - PIN) / .15) : 0;
      pin.position.z += push;
      pin.rotation.set(.55 * (1 - k), -.45 * (1 - k), .3 * (1 - k));
      const strike = Math.max(0, 1 - Math.abs(t - PIN) / .3);
      pin.userData.gm.emissiveIntensity = .4 + 1.6 * strike + 1.2 * Math.max(0, 1 - Math.abs(t - SETTLE) / .3);
      const hk = F.clamp((t - PIN) / .7);
      halo.visible = t > PIN && hk < 1;
      halo.scale.setScalar(1 + F.easeOut(hk) * 2.4);
      halo.material.opacity = .45 * (1 - hk);
      // 扫描
      let active = -1;
      for (let s = 0; s < SCANS.length; s++) if (t >= SCANS[s] - .05 && t <= SCANS[s] + SCAN_DUR + .05) active = s;
      scanBar.visible = scanSheet.visible = active >= 0;
      if (active >= 0) {
        const sx = scanX(t, active), fade = F.env(t, SCANS[active] - .05, SCANS[active] + .12, SCANS[active] + SCAN_DUR - .12, SCANS[active] + SCAN_DUR + .05);
        scanBar.position.x = sx; scanSheet.position.x = sx - 1.0;
        scanMat.emissiveIntensity = 5 * fade; sheetMat.opacity = .7 * fade;
      }
      // 面板：扫描经过时推出、轻翻、闪动换图后回位；被钉住的格不动
      for (let i = 0; i < 13; i++) {
        const p = strip.panes[i];
        p.group.position.copy(p.home); p.group.rotation.set(0, 0, 0);
        if (i === PI_) {
          const guard = SCANS.reduce((m, s, j) => Math.max(m, Math.max(0, 1 - Math.abs(t - passT(j, p.home.x)) / .35)), 0);
          const gold = t < PIN ? .12 : 1.0 + 1.2 * strike + .9 * guard;
          strip.setLit(i, 1, gold); p.mat.emissiveMap = texs[i];
          continue;
        }
        let e = 0, sw = -1;
        for (let s = 0; s < SCANS.length; s++) {
          const u = (t - passT(s, p.home.x) + .06) / .62;
          if (u > 0 && u < 1) { e = Math.sin(Math.PI * u); if (u > .3 && u < .7) sw = s; }
        }
        p.group.position.z = p.home.z + .42 * e;
        p.group.position.y = p.home.y + .08 * e;
        p.group.rotation.x = (i % 2 ? .3 : -.3) * e;
        p.group.rotation.y = (i % 2 ? -.12 : .12) * e;
        p.mat.emissiveMap = sw >= 0 ? texs[(i + 5 + 4 * sw) % 13] : texs[i];
        const flick = sw >= 0 ? .55 + .25 * Math.sin(t * 90 + i) : 1;
        strip.setLit(i, (1 - .45 * e) * flick, .12 + .8 * e);
      }
      const P = [camK.p0(tl), camK.p1(tl), camK.p2(tl)], Lk = [camK.l0(tl), camK.l1(tl), camK.l2(tl)];
      F.aimCam(cam, P, Lk, 38);
    },
    overlay(g, tl, t) {
      const out = 1 - F.smooth((t - 47.45) / .3);
      // 图钉旁："已钉住"
      const pa = F.easeOut((t - (PIN + .25)) / .4) * out * (1 - F.smooth((t - 41.8) / .3));
      if (pa > .004) {
        strip.group.updateMatrixWorld(true);
        const w = pinTo.clone().add(new THREE.Vector3(0, .42, .3)).applyMatrix4(strip.group.matrixWorld);
        const q = F.project(cam, w);
        if (q && q.y < 790) F.label(g, '已钉住', q.x, q.y - 20, { size: 30, weight: 600, color: F.C.gold, prog: F.easeOut((t - PIN - .25) / .4), alpha: out * (1 - F.smooth((t - 41.8) / .3)) });
      }
      // 右上角计数
      const ca = F.easeOut((t - 41.0) / .4);
      if (ca <= .004 || out <= .004) return;
      const x0 = 1395, yA = 150, yB = 238;
      const lab = (s, o) => F.bake(s, Object.assign({ size: 30, weight: 500 }, o));
      const a1 = lab('付费生成'), n0 = F.bake('0', { size: 72, weight: 600, mono: true, color: F.C.gold }), c1 = lab('次');
      F.drawText(g, a1, x0, yA + 6, { align: 'left', prog: ca, alpha: out });
      F.drawText(g, n0, x0 + a1.tw + 22, yA, { align: 'left', prog: ca, alpha: out });
      F.drawText(g, c1, x0 + a1.tw + 22 + n0.tw + 16, yA + 6, { align: 'left', prog: ca, alpha: out });
      const n = (t >= SCANS[0] ? 1 : 0) + (t >= SCANS[1] ? 1 : 0);
      const tc = n === 0 ? 41.0 : SCANS[n - 1], np = F.easeOut((t - tc) / .3);
      const a2 = lab('重建'), nn = F.bake(String(n), { size: 48, weight: 600, mono: true, color: F.C.teal }), c2 = lab('次');
      F.drawText(g, a2, x0, yB, { align: 'left', prog: ca, alpha: out });
      const nx = x0 + a1.tw + 22 + (n0.tw - nn.tw) / 2;     // 数字与上一行的 0 对齐
      F.drawText(g, nn, nx, yB - 2, { align: 'left', prog: Math.max(.3, np), alpha: out });
      F.drawText(g, c2, x0 + a1.tw + 22 + n0.tw + 16, yB, { align: 'left', prog: ca, alpha: out });
      if (n > 0) {
        const why = n === 1 ? '改剪辑' : '改字幕';
        F.label(g, why, x0 + a1.tw + 22 + n0.tw + 16 + c2.tw + 26, yB, { size: 26, weight: 500, color: F.C.teal, align: 'left', prog: Math.max(.3, np), alpha: out * .95 });
      }
      g.save(); g.globalAlpha = .55 * ca * out; g.fillStyle = F.C.gold; g.fillRect(x0, yA + 50, 300 * F.easeOut((t - 41.1) / .5), 1.5); g.restore();
    },
    bloom: (tl, t) => .55 + .35 * Math.max(0, 1 - Math.abs(t - PIN) / .35),
  });
})();
})();
