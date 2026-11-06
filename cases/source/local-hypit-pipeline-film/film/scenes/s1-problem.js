// s1-problem.js — 问题段 8–24 s：石膏时间轨上 13 块原片镜头浮雕块（宽度按切点帧）；
// 一条发光生成片带着自己错位的红色切痕送进来；16 s 起 13 把金刀按原片切点落下，把生成片切开，各段落进对应镜头块。
// 节拍：8.0 重拍（浮雕块已在锁定）· 8.5 锁定 · 10.0 生成片滑入 · 11.5 就位 · 12.0–14.0 红切痕逐个冒出（八分音符）
//       14.0 金色原片切线升起（对比错位）· 15.5 金刀下落 · 16.0 切开 · 17.0–20.0 各段依次落位（八分音符）· 20.0 全部锁定
'use strict';
(function () {
const F = window.F;
const T0 = 8, T1 = 24;
const CUTS = (window.FILM_DATA && FILM_DATA.shots && FILM_DATA.shots.cut_frames) || [0, 27, 42, 66, 88, 104, 114, 128, 135, 147, 161, 171, 191, 249];
const N = CUTS.length - 1;                           // 13 个镜头
const S = .075;                                      // 每帧 0.075 m → 249 帧 ≈ 18.7 m
const X = f => (f - CUTS[N] / 2) * S;                // 帧号 → 世界 x（整条轨居中）
// 生成片自己的切点（示意：模型自己剪的位置，刻意和原片 12 刀都错开 ≥5 帧）
const RED = [18, 52, 77, 96, 120, 154, 182, 213, 233];
const RED_ORDER = [4, 1, 7, 2, 5, 0, 8, 3, 6];       // 冒出的先后（不按顺序：它"自己剪"）
const RED_T = k => 4.0 + .25 * RED_ORDER.indexOf(k); // 本地时间 12.0–14.0
const ROW_Y = 1.05, WIN_H = .9, TAB_H = 1.6, TAB_D = .6, FACE_Z = TAB_D / 2;
const GEN_Y = 3.05, GEN_Z = FACE_Z + .05, GAP = .16;
const STRIKE = 8.0, DROP0 = 9.0, DROP_STEP = .25, DROP_DUR = .45;   // 本地时间
const landT = i => DROP0 + DROP_STEP * i;             // 第 i 段落位（本地 9.0–12.0 = 绝对 17.0–20.0）

let cam, tabs = [], tabPieces = [], pre = [], preGroup, redBars = [], segs = [], guides = [], knives = [], inlays = [];
let backMat, genBack, inlayMat;

// ─── 浮雕线稿：石膏底 + 凹刻细线（只示意构图，不出现原剧画面） ─────────────────
function reliefTexture(i, aspect) {
  const h = 256, w = Math.max(96, Math.round(h * aspect));
  const [c, x] = F.canvas(w, h), r = F.rng(400 + i * 17);
  x.fillStyle = '#E4DED3'; x.fillRect(0, 0, w, h);
  // 内框阴影（像一个浅凹槽）
  const gr = x.createLinearGradient(0, 0, 0, 22); gr.addColorStop(0, 'rgba(60,54,48,.28)'); gr.addColorStop(1, 'rgba(60,54,48,0)');
  x.fillStyle = gr; x.fillRect(0, 0, w, 22);
  const line = (pts, lw = 3) => {
    for (const [dx, dy, col] of [[1.5, 2, 'rgba(255,255,255,.7)'], [0, 0, 'rgba(92,86,78,.72)']]) {
      x.strokeStyle = col; x.lineWidth = lw; x.lineCap = 'round'; x.lineJoin = 'round';
      x.beginPath(); pts.forEach(([px, py], k) => k ? x.lineTo(px + dx, py + dy) : x.moveTo(px + dx, py + dy)); x.stroke();
    }
  };
  const circ = (cx, cy, rr) => {
    for (const [dx, dy, col] of [[1.5, 2, 'rgba(255,255,255,.7)'], [0, 0, 'rgba(92,86,78,.72)']]) {
      x.strokeStyle = col; x.lineWidth = 3; x.beginPath(); x.arc(cx + dx, cy + dy, rr, 0, Math.PI * 2); x.stroke();
    }
  };
  const hz = h * (.55 + r() * .2);
  // 远山 / 屋脊
  const mtn = []; for (let k = 0; k <= 6; k++) mtn.push([w * k / 6, hz - 10 - r() * h * .22]);
  line(mtn, 2.5);
  line([[0, hz], [w, hz]], 2);
  // 人物剪影（1–2 个）
  const nFig = 1 + (r() < .45 ? 1 : 0);
  for (let k = 0; k < nFig; k++) {
    const fx = w * (.25 + .5 * r()), fs = h * (.26 + r() * .16), fy = hz + h * .12;
    circ(fx, fy - fs, fs * .16);
    line([[fx, fy - fs * .84], [fx - fs * .05, fy - fs * .3], [fx - fs * .2, fy]], 3);
    line([[fx - fs * .05, fy - fs * .3], [fx + fs * .16, fy]], 3);
    line([[fx - fs * .02, fy - fs * .7], [fx + fs * .3 * (r() < .5 ? 1 : -1), fy - fs * .5]], 3);
  }
  // 雨线（开场几镜在雨里）
  if (i < 3 || r() < .25) for (let k = 0; k < w / 26; k++) { const px = r() * w, py = r() * h * .5; line([[px, py], [px - 10, py + 26]], 1.6); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

// 复刻截帧按面板比例裁切（cover）
function coverTex(i, aspect) {
  const t = F.frameTexture(i); if (!t) return null;
  const ia = 2;                                      // 640×320
  if (aspect < ia) { const k = aspect / ia; t.repeat.set(k, 1); t.offset.set((1 - k) / 2, 0); }
  else { const k = ia / aspect; t.repeat.set(1, k); t.offset.set(0, (1 - k) / 2); }
  return t;
}
function panelMat(i, aspect) {
  const tex = coverTex(i, aspect);
  return new THREE.MeshStandardMaterial({ color: '#000', emissive: tex ? '#FFFFFF' : F.C.window, emissiveMap: tex, emissiveIntensity: 1, roughness: 1 });
}

F.addScene({
  id: 's1-problem', t0: T0, t1: T1,
  captions: [
    { t0: 8.5, t1: 15.6, title: '在提示词里写"这里切"，只是请求', body: '生成模型会自己剪、自己演：它的切点，对不上原片的 13 刀' },
    { t0: 16.5, t1: 23.6, title: '结构要由代码保证', body: '切点、时长、字幕、声音，按原片的帧确定地落位' },
  ],
  build() {
    const scene = new THREE.Scene();
    F.makeEnv(scene, { fog: .02, keyDir: [-6, 9, 7], keyInt: 1.65, target: [0, 1.2, 0], shadowBox: 14 });
    const L = CUTS[N] * S;
    // 时间轨：一条低矮的石膏基座 + 前沿细条
    const rail = F.block(L + 1.2, .25, 1.5, F.mat.plasterShade, .04); rail.position.set(0, .125, 0); scene.add(rail);
    const lip = F.block(L + 1.2, .08, .12, F.mat.plaster, .02); lip.position.set(0, .29, .66); scene.add(lip);
    // 切点刻槽里的金色镶线（落刀时点亮）
    inlayMat = new THREE.MeshStandardMaterial({ color: '#6A5530', emissive: new THREE.Color(F.C.gold), emissiveIntensity: 0, roughness: .5 });
    for (let k = 0; k <= N; k++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(.035, .02, 1.3), inlayMat); m.position.set(X(CUTS[k]), .255, 0); scene.add(m); inlays.push(m);
    }
    // 13 块镜头浮雕块：宽 = 帧数 × S，按层从轨道里抬起就位
    const r = F.rng(71);
    for (let i = 0; i < N; i++) {
      const w = (CUTS[i + 1] - CUTS[i]) * S - GAP, cx = (X(CUTS[i]) + X(CUTS[i + 1])) / 2;
      const g = new THREE.Group(); g.position.set(cx, .25 + TAB_H / 2, 0);
      const b = F.block(w, TAB_H, TAB_D, F.mat.plaster, .04); g.add(b);
      const ww = w - .14;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(ww, WIN_H), new THREE.MeshStandardMaterial({ color: '#FFFFFF', map: reliefTexture(i, ww / WIN_H), roughness: .94 }));
      face.position.set(0, ROW_Y - (.25 + TAB_H / 2), FACE_Z + .004); face.receiveShadow = true; g.add(face);
      // 镜头字母（刻在块顶下沿）
      const lt = F.engrave(String.fromCharCode(65 + i), { w: 128, h: 96, size: 64, weight: 500 });
      const lp = new THREE.Mesh(new THREE.PlaneGeometry(.3, .225), new THREE.MeshStandardMaterial({ color: '#FFFFFF', map: lt, roughness: .94 }));
      lp.position.set(0, TAB_H / 2 - .17, FACE_Z + .004); if (ww > .3) g.add(lp);
      scene.add(g); tabs.push(g);
      tabPieces.push(F.piece(g, { d: [0, -1.1 - r() * .4, .5 + r() * .5], axis: [1, 0, (r() - .5)], ang: .3, t0: -.35 + i * .02, t1: .5, mode: 'gather' }));
    }
    // ─ 生成片（切开前）：一条发光的长片，面板按它"自己的"切点分段 ─
    preGroup = new THREE.Group(); preGroup.position.set(0, GEN_Y, GEN_Z); scene.add(preGroup);
    backMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(F.C.window), emissiveIntensity: .9, roughness: 1 });
    genBack = new THREE.Mesh(new THREE.BoxGeometry(L - .1, WIN_H * .8, .05), backMat); genBack.position.z = -.04; preGroup.add(genBack);
    const pcuts = [0, ...RED, CUTS[N]];
    for (let k = 0; k < pcuts.length - 1; k++) {
      const w = (pcuts[k + 1] - pcuts[k]) * S, cx = (X(pcuts[k]) + X(pcuts[k + 1])) / 2;
      // 取的是"它自己演"的画面：按面板中点落在哪个原片镜头里，再错一位
      const mid = (pcuts[k] + pcuts[k + 1]) / 2; let si = 0; while (si < N - 1 && CUTS[si + 1] <= mid) si++;
      const img = Math.min(N - 1, (si + (k % 2)) % N);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, WIN_H), panelMat(img, w / WIN_H)); m.position.set(cx, 0, 0);
      preGroup.add(m); pre.push({ mesh: m, jog: (k % 2 ? 1 : -1) * (.035 + .02 * ((k * 7) % 3)), t: k === 0 ? 1e9 : RED_T(k - 1) });
    }
    const redMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(F.C.red), emissiveIntensity: 2.4, roughness: 1 });
    for (let k = 0; k < RED.length; k++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(.06, WIN_H + .44, .03), redMat.clone()); m.position.set(X(RED[k]), 0, .03);
      preGroup.add(m); redBars.push(m);
    }
    // ─ 生成片（切开后）：13 段，宽度按原片切点；每段显示对应镜头的复刻画面 ─
    for (let i = 0; i < N; i++) {
      const w = (CUTS[i + 1] - CUTS[i]) * S, cx = (X(CUTS[i]) + X(CUTS[i + 1])) / 2, ww = w - .14;
      const mat = panelMat(i, ww / WIN_H);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, WIN_H), mat); m.position.set(cx, GEN_Y, GEN_Z); m.visible = false; scene.add(m);
      segs.push({ mesh: m, mat, w, ww, cx });
    }
    // ─ 原片切线（金色细线，从块缝升起穿过生成片，用来对比错位） ─
    const gMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(F.C.gold), emissiveIntensity: 1.6, roughness: 1, transparent: true, opacity: 1 });
    for (let k = 0; k <= N; k++) {
      const h = GEN_Y + WIN_H / 2 + .25 - (.25 + TAB_H);
      const m = new THREE.Mesh(new THREE.BoxGeometry(.022, h, .02), gMat); m.geometry.translate(0, h / 2, 0);
      m.position.set(X(CUTS[k]), .25 + TAB_H, GEN_Z + .06); scene.add(m); guides.push(m);
    }
    // ─ 13 把金刀：刀身（金）+ 石膏刀柄；落在第 0 … 191 帧（13 个镜头的起点） ─
    for (let i = 0; i < N; i++) {
      const g = new THREE.Group();
      const bm = F.goldMat(); bm.emissiveIntensity = 1.2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(.05, 1.7, .28), bm); blade.position.y = .85; blade.castShadow = true; g.add(blade);
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0, .025, .16, 4, 1), bm); tip.scale.z = 5.6; tip.rotation.y = Math.PI / 4; tip.position.y = -.08; g.add(tip);
      const handle = F.block(.2, .42, .26, F.mat.plaster, .04); handle.position.y = 1.9; g.add(handle);
      g.position.set(X(CUTS[i]), 0, GEN_Z + .02); scene.add(g); knives.push({ g, bm });
    }
    F.buildTown(scene, { zFrom: -7, zTo: -70, seed: 23, density: .8 });
    cam = new THREE.PerspectiveCamera(38, F.W / F.H, .05, 400);

    // 声音事件（绝对时间）
    F.ev(8.0, 'hit'); F.ev(8.0, 'whoosh', { dur: 2.0 }); F.ev(8.5, 'lock', { n: 13 });
    F.ev(10.0, 'whoosh', { dur: 1.5 }); F.ev(11.5, 'lock');
    for (let k = 0; k < RED.length; k++) F.ev(T0 + 4.0 + .25 * k, 'tick', { k, tone: 'wrong' });
    F.ev(14.0, 'riser', { dur: 2.0 });
    F.ev(15.25, 'whoosh', { dur: .6 });
    F.ev(16.0, 'hit'); F.ev(16.0, 'pin', { n: 13 });
    for (let i = 0; i < N; i++) F.ev(T0 + landT(i), 'lock', { i });
    F.ev(20.0, 'hit');
    F.ev(22.0, 'riser', { dur: 2.0 });
    return { scene, camera: cam };
  },

  seek(tl) {
    // 浮雕块：按层抬起、锁定于 8.5
    F.poseAll(tabPieces, tl);
    // 生成片（切开前）：10.0 从右侧滑入，11.5 就位；16.0 被切开后隐藏
    const slide = F.easeOut((tl - 2.0) / 1.5), cut = tl >= STRIKE;
    preGroup.position.x = F.lerp(26, 0, slide);
    preGroup.visible = tl > 1.9 && !cut;
    backMat.emissiveIntensity = .8 + .25 * Math.max(0, 1 - Math.abs(tl - 3.5) / .3);
    for (const p of pre) {
      const on = F.easeBack((tl - p.t) / .2);
      p.mesh.position.y = p.jog * on;
    }
    for (let k = 0; k < RED.length; k++) {
      const a = F.easeOut((tl - RED_T(k)) / .18), b = redBars[k];
      b.scale.y = Math.max(.001, a); b.visible = a > 0;
      b.material.emissiveIntensity = 2.2 + 4 * Math.max(0, 1 - (tl - RED_T(k)) / .3) + (tl > 7 ? 1.5 * F.smooth((tl - 7) / .8) : 0);
    }
    // 原片切线：14.0 从块缝升起；落刀后收回
    const gUp = F.easeOut((tl - 6.0) / .5) * (1 - F.smooth((tl - 8.2) / .5));
    for (const g of guides) { g.scale.y = Math.max(.001, gUp); g.visible = gUp > .002; }
    guides[0].material.opacity = 1;
    // 金刀：15.0 出现在高处，15.5–16.0 加速落下，16.0 切到块缝；17.0 抬起离场
    const fall = F.easeIn((tl - 7.5) / .5), rise = F.easeIO((tl - 8.9) / 1.0);
    const kY = F.lerp(6.2, 1.88, fall) + rise * 6;
    for (let i = 0; i < N; i++) {
      const k = knives[i];
      k.g.position.y = kY + (1 - fall) * (i % 3) * .12;
      k.g.visible = tl > 7.45 && tl < 10.2;
      k.bm.emissiveIntensity = .35 + 1.0 * Math.max(0, 1 - Math.abs(tl - STRIKE) / .3);
    }
    // 切开后：13 段先微微分开（分解），再按 17.0–20.0 八分音符依次落进各自的浮雕块
    for (let i = 0; i < N; i++) {
      const s = segs[i], m = s.mesh;
      m.visible = cut;
      if (!cut) continue;
      const open = F.easeOut((tl - STRIKE) / .5);
      const d = F.smooth((tl - (landT(i) - DROP_DUR)) / DROP_DUR), dd = d * d * (3 - 2 * d);
      const lift = .18 * open * (1 - dd);
      m.position.set(s.cx, F.lerp(GEN_Y + lift, ROW_Y, dd), F.lerp(GEN_Z, FACE_Z + .012, dd));
      m.scale.x = F.lerp(1 - (.08 / s.w) * open, s.ww / s.w, dd);
      const land = Math.max(0, 1 - Math.abs(tl - landT(i)) / .22);
      const allLock = Math.max(0, 1 - Math.abs(tl - 12.0) / .35);
      s.mat.emissiveIntensity = 1 + .7 * Math.max(0, 1 - (tl - STRIKE) / .5) + .9 * land + .5 * allLock - .12 * F.smooth((tl - 12.5) / 2);
    }
    // 轨道金镶线：落刀时亮起，全部锁定时再亮一下
    inlayMat.emissiveIntensity = (tl > STRIKE ? 1.4 : 0) + 2.5 * Math.max(0, 1 - Math.abs(tl - STRIKE) / .35) + 2.5 * Math.max(0, 1 - Math.abs(tl - 12) / .4);

    // ─ 镜头：一条连续样条 ─
    const P = (keys) => F.mspline(keys)(tl);
    // A 左端斜看、向右推进 → B 生成片从远端滑入，拉开 → C 斜向全景看红切痕 → D 推近中段看错位
    // → E 拉回全景等金刀 → F 跟着落位从左扫到右 → G 从右端回望，缓慢收住
    const KX = [[0, -11.8], [2, -9.6], [3.6, -13.4], [6, -12.2], [6.8, -2.6], [7.3, -1.2], [7.75, -13.2], [8.6, -12.8], [9.2, -10.8], [12, 3.4], [13.4, 1.6], [16, 0]];
    const KY = [[0, 1.55], [2, 2.3], [3.6, 4.9], [6, 4.6], [6.8, 2.75], [7.3, 2.7], [7.75, 4.9], [8.6, 4.7], [9.2, 4.6], [12, 4.6], [13.4, 5.2], [16, 4.6]];
    const KZ = [[0, 4.6], [2, 6.8], [3.6, 11.4], [6, 10.8], [6.8, 8.0], [7.3, 7.8], [7.75, 11.8], [8.6, 11.4], [9.2, 10.8], [12, 11.0], [13.4, 17.4], [16, 15.4]];
    const LX = [[0, -6.4], [2, -3.2], [3.6, -.6], [6, .4], [6.8, .6], [7.3, 1.0], [7.75, -.2], [8.6, .2], [9.2, -4.6], [12, 8.0], [13.4, .4], [16, 0]];
    const LY = [[0, 1.2], [2, 1.6], [3.6, 1.3], [6, 1.3], [6.8, 1.95], [7.3, 1.95], [7.75, 1.4], [8.6, 1.4], [9.2, 1.15], [12, 1.1], [13.4, 1.25], [16, 1.2]];
    const px = P(KX), py = P(KY), pz = P(KZ), lx = P(LX), ly = P(LY);
    F.aimCam(cam, [px, py, pz], [lx, ly, 0], 38);
  },

  overlay(g, tl) {
    // 标签只在 y<800：原片 / 生成片 / 请求
    const lab = (str, wp, a, o) => { const p = F.project(cam, wp); if (!p || a <= .004) return; F.label(g, str, p.x, Math.min(p.y, 780), Object.assign({ alpha: a }, o)); };
    const a1 = F.env(tl, .5, .9, 3.2, 3.6);
    lab('原片 · 13 个镜头', [X(27) + .1, .25 + TAB_H + .32, FACE_Z], a1, { size: 28, weight: 500, align: 'left', color: F.C.ivory, prog: F.easeOut((tl - .5) / .45) });
    const a2 = F.env(tl, 3.5, 3.9, 7.1, 7.45);
    const gx = preGroup.position.x;
    lab('生成片', [X(27) + gx + .1, GEN_Y + WIN_H / 2 + .36, GEN_Z], a2, { size: 28, weight: 500, align: 'left', color: F.C.ivory, prog: F.easeOut((tl - 3.5) / .45) });
    // "请求"：14.5 起，指向一道红切痕（第 120 帧）与它旁边的原片切线
    const a3 = F.env(tl, 6.5, 6.85, 7.3, 7.6);
    if (a3 > .004) {
      const p = F.project(cam, [X(120), GEN_Y + WIN_H / 2 + .2, GEN_Z + .03]);
      if (p) {
        g.save(); g.globalAlpha = a3; g.strokeStyle = F.C.red; g.lineWidth = 2;
        g.beginPath(); g.moveTo(p.x, p.y - 6); g.lineTo(p.x, p.y - 58); g.stroke(); g.restore();
        F.label(g, '请求', p.x, p.y - 88, { size: 30, weight: 500, color: '#E9A49C', alpha: a3, prog: F.easeOut((tl - 6.5) / .4) });
      }
    }
  },
  bloom: tl => .55 + .15 * Math.max(0, 1 - Math.abs(tl - STRIKE) / .4) + .2 * Math.max(0, 1 - Math.abs(tl - 12) / .4),
});
})();
