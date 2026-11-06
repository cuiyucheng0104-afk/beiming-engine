// 《豹变》A 水墨 · S5 一跃·逍遥（崖顶 → 穿云 → 长卷）与 T2a 豹眼
//   两个世界共用一条相机路径：崖顶世界（S5a、S5b 前半）与长卷世界（S5b 后半、S5c）；f565–f575 两个世界都渲，按近云的遮挡做遮罩溶解
//   3D：崖顶石峰（三个交叠的墨块，笔触基元）、崖顶松（两条不对称笔线的干 + 一团团半扇形针）、远山脊、云海；近云是钉在世界里的几团云（相机横移时有真视差）
//   长卷世界：3 层 3D 山脊 + 底板 A10 + 前景石松剪影（从画右滑进来）
//   2D：小豹 A01（镜像，坐定）与 A02 四姿态（伏身、腾起、凌空、滑翔），残影 3 层；尾迹七墨点在合成里画（母型 R）
import * as THREE from 'three';
import { U, K, DW, DH, DEG, clamp, lerp, seg, ss, ss5, eo, ei, eio, hashi, hash2, mulberry, monotone, PAL, COL, placeOnScreen, screenToWorld, project, aim, fpx, fbm1, ridged1, css, mix3, inPoly } from '../lib/core.js';
import { inkMat, ridgeStrip, fogPlane, canvasPlane, needleMat, needleTexture, barkMat, bakeCavity, blobPlane, projRelief } from '../lib/inkwash.js';
import { sprite, setHandle, clearHandles, setBreath, setSpots } from '../lib/sprite.js';
import { stroke, freshClear, wetBlob, blobPath } from '../lib/draw2d.js';
import { NOISE, PALETTE, FOG, ROSETTE } from '../lib/glsl.js';
import { placeImg, rockMass, mossDots, makeSpotTable } from './cliff.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const FOV = 44, FP = fpx(FOV);                        // 1287
export const DOT_F = [565, 573, 581, 597, 613, 621, 629];

// ───────── 共用相机路径（S5a 起点为原点，仰 3°）；S5c 末段向小豹推近 ─────────
export function camPathS5(fr) {
  const u = ss5(seg(fr, 504, 547));
  let x = 0, y = 0.15 * u, z = -0.2 * u;
  const v = eio(seg(fr, 554, 590));
  x += -2.6 * v; y += 1.2 * v; z += -1.0 * v;
  const g = fr < 591 ? 0 : fr < 597 ? (fr - 591) ** 2 / 12 : (fr - 594);
  x -= 3.2 / 24 * g;
  z -= 1.8 * ss(seg(fr, 620, 636));
  return { pos: V3(x, y, z), pitch: 3 * DEG };
}

export function buildSky(ctx) {
  const { tex, man } = ctx;
  const cam = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.01, 6000);
  const at = (c, fr) => { const p = camPathS5(fr); aim(c, p.pos, 0, p.pitch); return c; };
  const mkCam = fr => at(new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.01, 6000), fr);
  const C5a = mkCam(504), C591 = mkCam(591), C570 = mkCam(570);
  const P5 = PAL.scroll;
  const L5 = [0.30, 0.85, 0.42];

  const skyTex = (() => { const c = document.createElement('canvas'); c.width = 4; c.height = 256; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, css(COL.zenith)); gr.addColorStop(0.22, css(mix3(COL.zenith, P5[0], 0.7))); gr.addColorStop(0.45, css(P5[0])); gr.addColorStop(1, css(P5[0])); g.fillStyle = gr; g.fillRect(0, 0, 4, 256); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t; })();
  const skyPlane = (cam0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: skyTex, depthWrite: false })); m.renderOrder = -10; placeOnScreen(m, cam0, 960, 520, 3200, 3000, 1500); return m; };
  // 山脊：每层 2–3 个主峰，其余是缓坡和断开处；顶线断笔、积墨忽浓忽淡；远层偏花青，近层受光面一层赭淡
  const ridgeProf = (D, i, seed, A) => { const fq = 1 / (0.30 * D); return x => A * (1.0 * fbm1(x * fq * 0.55 + i * 7.7, seed, 2) + 0.38 * fbm1(x * fq * 1.3 + 3, seed + 10, 3) + 0.12 * (ridged1(x * fq * 2.2 + 2.1, seed + 20, 2) - 0.5)); };

  // ═════════ 崖顶世界 ═════════
  const peak = new THREE.Scene();
  peak.add(skyPlane(C5a));
  const farR = [[1050, 580], [800, 598], [600, 620], [450, 642], [340, 668], [260, 698]].map(([D, y], i) => {
    let lo = -900, hi = 900;
    for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (project(C5a, V3(0, mid, -D)).y > y) lo = mid; else hi = mid; }
    const H = (lo + hi) / 2, A = D * 0.085;
    const prof = ridgeProf(D, i, 300 + i, A);
    const m = ridgeStrip({ x0: -D * 1.6, x1: D * 1.6, z: -D, H, bottom: H - D * 0.3, seg: 900, prof, Dk: [0.30, 0.37, 0.45, 0.54, 0.63, 0.72][i], Hk: D * 0.065,
      hue: 0.10 + 0.035 * (5 - i), hueC: COL.sIndigoM, soft: 0.004 * D, seed: 20 + i, order: 1 + i, hemp: 0.28, topV: 0.8, brk: [1, 0.35 * D], ochre: i >= 4 ? 0.10 : 0, ochreC: COL.sOchreL });
    peak.add(m); return m;
  });
  const cloudSea = [[200, -300, 1500, 560, 760, 0.85], [110, -300, 1350, 620, 860, 0.9], [60, -400, 1300, 700, 980, 0.92], [30, -500, 1250, 790, 1150, 0.95]].map(([D, x0, x1, y0, y1, a], i) => {
    const m = fogPlane({ w: 1, h: 1, a0: a, drift: 0.012 + 0.006 * i, seed: 40 + i, lo: 0.25, hi: 0.60, sc: [4, 1.3], edge: 0.35, edgeInk: 0.5, side: 0.10, order: 1.5 + i * 1.2 });
    placeOnScreen(m, C5a, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, D, y1 - y0); peak.add(m); return m;
  });
  // 崖顶石峰：三个交叠的墨块，受暗面一笔一笔的斧劈，受光面留飞白、一层赭
  const peakRockMat = () => inkMat({ L: L5, Dbase: 0.40, lit: 0.48, cun: 0.0, rim: 0.65, cavK: 0.5, softQ: 0.36, ws: 0.09, mass: [0.22, 0.5, 0.0, 0.34], top: [1.20, 0.30, 1.6, 0.78],
    aT: 0.18, tint: COL.sOchreL, side: THREE.FrontSide, stk: [0.22, 0.40, 0.13, 0.08], stk2: [0.40, 0.46, 0.16, 0.55] });
  const peakRocks = [[1560, 905, 900, 440, 5.2, 1.6, 51, 0.22, 0.5], [1180, 975, 440, 230, 4.7, 1.0, 52, 0.25, 0.45], [1830, 850, 380, 400, 5.8, 1.2, 53, 0.20, 0.4]].map(([cx, cy, w, h, D, sz, sd, amp, flat], i) => {
    const m = rockMass({ cx, cy, wpx: w, hpx: h, D, sz, seed: sd, cam: C5a, amp, flat, fp: FP }, peakRockMat());
    m.renderOrder = 8 + 0.01 * i; peak.add(m); return m;
  });
  const pmoss = mossDots(peak, C5a, [
    { mesh: peakRocks[0], n: 6, xr: [1140, 1900], yMax: 820, topMax: 0.14 },
    { mesh: peakRocks[1], n: 2, xr: [1000, 1380], yMax: 940, topMax: 0.12 },
  ], 5151, FP);
  // 崖顶松：主干从右缘起，往左上探到 x 1150；干是两条不对称笔线 + 鳞皴；针是 4–6 种半扇形针团，沿枝成组、组间留空
  const pine = new THREE.Group(); peak.add(pine);
  {
    const branches = [
      { pts: [[1990, 800, 4.7], [1900, 560, 4.6], [1780, 420, 4.5], [1600, 300, 4.55], [1420, 250, 4.6], [1160, 205, 4.75]], r0: 0.13, r1: 0.022 },
      { pts: [[1835, 470, 4.55], [1820, 330, 4.6], [1870, 180, 4.65], [1860, 100, 4.7]], r0: 0.06, r1: 0.012 },
      { pts: [[1640, 330, 4.55], [1500, 390, 4.6], [1380, 400, 4.7], [1300, 430, 4.72]], r0: 0.045, r1: 0.010 },
    ];
    const tex5 = [21, 22, 23, 24, 25].map(s => needleTexture(s));
    const rnd = mulberry(515);
    branches.forEach((b, bi) => {
      const curve = new THREE.CatmullRomCurve3(b.pts.map(([x, y, D]) => screenToWorld(C5a, x, y, D)));
      const tg = new THREE.TubeGeometry(curve, 120, 1, 10, false), p = tg.attributes.position;
      for (let s = 0; s <= 120; s++) { const u = s / 120, c = curve.getPointAt(u), r = lerp(b.r0, b.r1, Math.pow(u, 0.7)) * (1 - ss(seg(u, 0.9, 1.0)) * 0.92); for (let j = 0; j <= 10; j++) { const i = s * 11 + j; const v = V3(p.getX(i), p.getY(i), p.getZ(i)).sub(c); const jit = 1 + 0.2 * fbm1(u * 12 + j, 600 + bi); p.setXYZ(i, c.x + v.x * r * jit, c.y + v.y * r * jit, c.z + v.z * r * jit); } }
      tg.computeVertexNormals();
      const m = new THREE.Mesh(tg, barkMat({ L: L5, len: curve.getLength(), circ: Math.PI * (b.r0 + b.r1), D0: 0.64, seed: bi + 3 })); m.renderOrder = 8.6; pine.add(m);
      const us = bi === 0 ? [0.30, 0.42, 0.55, 0.66, 0.78, 0.90, 0.98] : [0.40, 0.70, 0.96];
      us.forEach((u0, k) => {
        const nm = needleMat(tex5[(k + bi) % 5], { D0: 0.60 + 0.15 * rnd(), D1: 0.92, lod: 0, fogMul: 0 });
        const n = 4 + Math.floor(rnd() * 4), inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.46, 0.34), nm, n);
        const mtx = new THREE.Matrix4(), q = new THREE.Quaternion();
        for (let j = 0; j < n; j++) {
          const uu = clamp(u0 + (rnd() - 0.5) * 0.07), c = curve.getPointAt(uu), t = curve.getTangentAt(uu);
          const pa = project(C5a, c), pb = project(C5a, c.clone().add(t.clone().multiplyScalar(0.1)));
          const ang = Math.atan2(-(pb.y - pa.y), pb.x - pa.x) + (rnd() - 0.5) * 0.8 + (rnd() < 0.5 ? 0.5 : -0.5);
          q.copy(C5a.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.5, ang)));
          const off = V3((rnd() - 0.5) * 0.25, (rnd() - 0.3) * 0.16, (rnd() - 0.5) * 0.2);
          const s = 0.7 + 0.5 * rnd();
          mtx.compose(c.clone().add(off), q, V3(s, s, s)); inst.setMatrixAt(j, mtx);
        }
        inst.renderOrder = 9; inst.frustumCulled = false; pine.add(inst);
      });
    });
  }
  // ───────── 返修第 2 轮（style-02 / style-08）：崖顶石峰、崖顶松换成 Magpie 水墨原画（按 C5a 投影机位的素描稿重画），各是一张 B 类墨画面片 ─────────
  //   石峰 D 5.0（小豹坐在它顶上，视差一致）；松 D 4.6，画在石峰之前一层（层序低于石峰：树干从石顶后面长出来）
  const g5 = (x, y) => [960 + (x - 960) / 0.789131, 520 + (y - 540) / 0.789131];   // 投影机位（56°、16:9）像素 → C5a 设计像素
  const putCard = (m, rect, D) => { const [x0, y0] = g5(rect[0], rect[1]), [x1, y1] = g5(rect[2], rect[3]); placeOnScreen(m, C5a, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, D, y1 - y0); return m; };
  // 返修第 3 轮（v2-02）：崖顶石峰同样长成 3D 浮雕（按原画轮廓，基准 D 5.35、中间往前鼓 0.45 m），按投影机位 CG5 把原画投回去，N·L 分两阶
  const CG5 = new THREE.PerspectiveCamera(56, 16 / 9, 0.01, 6000);
  CG5.position.copy(C5a.position); CG5.quaternion.copy(C5a.quaternion); CG5.updateProjectionMatrix(); CG5.updateMatrixWorld(true);
  const mPeak = man['R2-PEAK'] || { Lp: 0.965, Li: 0.113 };
  const rockCard = projRelief(tex.peakRock, CG5, [940, 603, 1880, 1073], { Dbase: 5.35, bulge: 0.45, blurPx: 16, seg: [180, 100] },
    { Lp: mPeak.Lp, Li: mPeak.Li, fall: [-1, 0], nl: 0.22, L: L5, depthWrite: false, fogMul: 1 });
  rockCard.renderOrder = 8;
  const pineCard = putCard(sprite(tex.pineS5, man['R2-PINE5'] || { Lp: 0.904, Li: 0.153 }, { order: 7.9, deform: false, a0: 0.20, a1: 0.80, fogMul: 0.6 }), [1060, 30, 1900, 870], 4.6);
  // 返修第 3 轮（v2-05）：起跳那几帧（f548–f566）小豹从松的左下针团后面掠过——松（D 4.6）比小豹近：把松画面切成上下两半，
  //   上半（枝与针，图 y < 700，不碰石峰）另画一遍、层序放在小豹之上；下半（树干根部）照旧在石峰之下（树干从石顶后面长出来）
  const PINE_CUT = 700;
  const pineTop = putCard(sprite(tex.pineS5, man['R2-PINE5'] || { Lp: 0.904, Li: 0.153 }, { order: 46, deform: false, a0: 0.20, a1: 0.80, fogMul: 0.6 }), [1060, 30, 1900, 870], 4.6);
  pineTop.material.uniforms.uClip.value.set(-1e9, PINE_CUT); pineTop.visible = false;
  peak.add(rockCard); peak.add(pineCard); peak.add(pineTop);
  const pineSplit = on => { pineTop.visible = on; pineCard.material.uniforms.uClip.value.set(on ? PINE_CUT : -1e9, 1e9); };
  for (const r of peakRocks) r.visible = false;
  pmoss.forEach(m => m.visible = false);
  pine.visible = false;
  const fgMist = fogPlane({ w: 1, h: 1, a0: 0.75, drift: 0.05, seed: 61, lo: 0.30, hi: 0.70, sc: [3, 1.2], edge: 0.4, order: 20 });
  placeOnScreen(fgMist, C5a, 760, 960, 2600, 1.5, 300); peak.add(fgMist);

  // ═════════ 长卷世界 ═════════
  const scroll = new THREE.Scene();
  scroll.add(skyPlane(C591));
  const srR = [[200, 470, 0.32, 0.24, 0], [60, 610, 0.55, 0.20, 0.85], [40, 700, 0.75, 0.07, 0.95]].map(([D, y, Dk, hue, och], i) => {
    let lo = -900, hi = 900;
    for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (project(C591, V3(C591.position.x, mid, C591.position.z - D)).y > y) lo = mid; else hi = mid; }
    const H = (lo + hi) / 2, A = D * 0.10;
    const prof = ridgeProf(D, i + 3, 330 + i, A);
    const m = ridgeStrip({ x0: -D * 2.5 - 20, x1: D * 1.5, z: -D + C591.position.z, H, bottom: H - D * 0.4, seg: 900, prof, Dk, Hk: D * 0.06, hue, hueC: COL.sIndigoM, soft: 0.004 * D, seed: 40 + i, order: 1 + i,
      hemp: 0.32, topV: 0.9, brk: [1, 0.33 * D], ochre: och * 1.0, ochreC: i === 2 ? [0.86, 0.69, 0.44] : [0.88, 0.72, 0.46] });
    m.position.x = C591.position.x; scroll.add(m); return m;
  });
  const scrollPlate = sprite(tex.scroll, man.A10, { order: 4, mode: 'A', deform: false, a0: -1, a1: 0.0001 });
  scrollPlate.material.uniforms.uLp.value = 0.99; scrollPlate.material.uniforms.uLi.value = 0.20;
  // 返修第 3 轮（style-16 ②）：长卷底板的近山受光坡上一层赭石淡彩（浅绛：近赭远青），成块、只在中间调、叠在墨上；远峰（图上半）不上
  scrollPlate.material.uniforms.uOch.value.set(0.88, 0.72, 0.46, 0.86); scrollPlate.material.uniforms.uOchY.value.set(0.14, 0.36);   // 淡赭（偏褐，不偏橙金）
  placeOnScreen(scrollPlate, C591, 850, 560, 2240, 30, 560); scroll.add(scrollPlate);
  const srFog = [[150, -800, 2800, 560, 720, 0.6], [30, -2400, 3600, 700, 900, 0.7]].map(([D, x0, x1, y0, y1, a], i) => {
    // 返修第 3 轮（v2-06）：这两条雾带横跨 6000 px，x 向噪声太疏，下缘那道"清墨边"连成一根贯穿全画面的细直线——x 向噪声加密、清墨边减到很淡
    const m = fogPlane({ w: 1, h: 1, a0: a, drift: 0.03, seed: 70 + i, lo: 0.28, hi: 0.66, sc: [15, 1.4], edge: 0.45, edgeInk: 0.08, order: 2.5 + i * 3 });
    placeOnScreen(m, C591, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, D, y1 - y0); scroll.add(m); return m;
  });
  // 前景石与松剪影（D 6）：没骨墨块（边带噪声与水渍边），不透明度 0.6，只露画底 80–120 px；钉在世界里，随横移从画右滑进来
  const fgS = canvasPlane(4096, 640, { order: 30, fogMul: 0 });
  const FGW = 16, FGH = FGW * 640 / 4096;
  {
    const g = fgS.ctx; g.clearRect(0, 0, 4096, 640); const rnd = mulberry(515);
    g.save(); g.filter = 'blur(6px)';
    const ROCKS = [[340, 560, 230], [1300, 620, 170], [2250, 460, 250], [3200, 700, 210], [3900, 380, 150]];
    ROCKS.forEach(([x, w, h], i) => {
      blobPath(g, x, 660 - h * 0.45, w * 0.5, h * 0.62, (rnd() - 0.5) * 0.2, 520 + i, 0.16); g.fillStyle = css(P5[i % 2 ? 3 : 4], 0.78); g.fill();
      blobPath(g, x - w * 0.12, 660 - h * 0.55, w * 0.30, h * 0.40, 0, 540 + i, 0.18); g.fillStyle = css(P5[5], 0.55); g.fill();
    });
    g.restore();
    ROCKS.forEach(([x, w, h], i) => { g.save(); g.filter = 'blur(3px)'; blobPath(g, x, 660 - h * 0.45, w * 0.49, h * 0.61, 0, 520 + i, 0.16); g.strokeStyle = css(P5[5], 0.35); g.lineWidth = 7; g.stroke(); g.restore(); });
    g.save(); g.filter = 'blur(4px)';
    const px = 2250, py = 660 - 270;
    stroke(g, [[px, py + 40, 1], [px + 90, py - 60, 0.8], [px + 220, py - 120, 0.5]], 14, css(P5[5], 0.9), { t0: 4, t1: 30 });
    for (const [cx, cy] of [[px + 120, py - 90], [px + 210, py - 125], [px + 60, py - 30]]) for (let j = 0; j < 9; j++) { const a = (-60 + 120 * j / 8) * DEG; const L = 55 + rnd() * 30; stroke(g, [[cx, cy, 1], [cx + Math.sin(a) * L, cy - Math.cos(a) * L, 0.2]], 4.5, css(P5[5], 0.85), { t0: 2, t1: 20 }); }
    g.restore(); fgS.tex.needsUpdate = true;
  }
  // 相机向左横移，画面内容右滑：剪影条的右端在 f591 时刚好在画左缘外，之后从左边滑进来
  { const C = mkCam(591); const pxm = FP / 6; fgS.mesh.quaternion.copy(C.quaternion); fgS.mesh.scale.set(FGW, FGH, 1);
    fgS.mesh.position.copy(screenToWorld(C, -20 - FGW / 2 * pxm, 615 + FGH / 2 * pxm, 6)); scroll.add(fgS.mesh); }
  fgS.mesh.material.uniforms.uOp.value = 0.62;

  // ═════════ 小豹 ═════════
  const A01 = man.A01['锚点'], A02 = man.A02;
  const CW1 = tex.cub.image.width, CH1 = tex.cub.image.height, SA = 230 / 1350;
  const cubSit = sprite(tex.cub, man.A01, { order: 10, a0: 0.28, a1: 0.78, fur: 1 });
  cubSit.material.uniforms.uBlock.value.set(0.7, 4.6, 0.86, 0.09);
  const sitSpots = makeSpotTable(alphaOfTex(tex.cub), A01, 22, CH1 / 992 * 0.95);
  const ringsOf = (tbl) => [...tbl.body.map(s => ({ ...s, mode: 2, prog: 1, op: 1, core: 0.20 })), ...tbl.head.map(s => ({ ...s, mode: 4, prog: 1, op: 0.95, core: 0 })), ...tbl.leg.map(s => ({ ...s, mode: 4, prog: 1, op: 0.95, core: 0 })), ...tbl.tail.map(s => ({ ...s, mode: 4, prog: 1, op: 0.9, core: 0 }))];
  setSpots(cubSit, ringsOf(sitSpots));
  const POSES = ['pose1_crouch', 'pose2_launch', 'pose3_airborne', 'pose4_glide'].map((name, i) => {
    const part = A02['零件'][name], off = part.offset_in_sheet, A = A02['锚点'];
    const key = name.split('_')[0];
    const poly = A.polys[key + '_body'].map(([x, y]) => [x - off[0], y - off[1]]);
    const eye = A.points[key + '_eye'], nose = A.points[key + '_nose'], tr = A.points[key + '_tail_root'];
    const m = sprite(tex['pose' + (i + 1)], A02, { order: 10, a0: 0.28, a1: 0.78, fur: 1 });
    m.material.uniforms.uBlock.value.set(0.7, 4.0, 0.86, 0.09);
    const al = alphaOfTex(tex['pose' + (i + 1)]), rnd = mulberry(7100 + i), sp = [];
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    for (let k = 0; k < 6000 && sp.length < 24; k++) {
      const x = Math.min(...xs) + rnd() * (Math.max(...xs) - Math.min(...xs)), y = Math.min(...ys) + rnd() * (Math.max(...ys) - Math.min(...ys)), R = 12 + 5 * rnd();
      if (!inPoly(x, y, poly) || al.at(x, y) < 0.6) continue;
      if (sp.some(s => Math.hypot(s.x - x, s.y - y) < 32)) continue;
      sp.push({ x, y, R, seed: 400 + i * 50 + sp.length, mode: 2, prog: 1, op: 1, core: 0.20 });
    }
    setSpots(m, sp);
    const ctr = [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
    return { m, part, eye: [eye[0] - off[0], eye[1] - off[1]], nose: [nose[0] - off[0], nose[1] - off[1]], tail: [tr[0] - off[0], tr[1] - off[1]], ctr, sp, name };
  });
  const en = (e, n) => Math.hypot(n[0] - e[0], n[1] - e[1]);
  const POSE_K = en(A01.points.eye, A01.points.nose) / en(A02['锚点'].points.pose1_eye, A02['锚点'].points.pose1_nose) * (A02.poseK ?? 1);
  const ghosts = [0, 1, 2].map(i => { const m = sprite(tex.pose2, A02, { order: 44.9 - i * 0.1, mode: 'A', a0: 0.28, a1: 0.78 }); m.material.uniforms.uDesat.value = 0.8; return m; });
  // 返修第 2 轮（v1-01）：小豹一律画在近云之后（层序 45），穿云全程看得见；只有 f564–f574 一团"掠云"从它身前飘过（层序 50）
  cubSit.renderOrder = 45; POSES.forEach(p => p.m.renderOrder = 45);
  const allCubs = [cubSit, ...POSES.map(p => p.m), ...ghosts];
  // 近云：三团带清墨底边与孔洞的云块，钉在 f570 机位前 2–3.4 米（相机横移、上升时从左上扫到右下，视差明显）
  const CLOUDS = [[880, 430, 1500, 980, 2.5, -0.50], [1420, 700, 1300, 820, 3.3, -0.42], [520, 210, 1250, 760, 4.1, -0.55]];
  const nearClouds = CLOUDS.map(([x, y, w, h, D, rot], i) => {
    // 返修第 3 轮（story-13 ①）：云块的清墨底边、孔洞、云身比天亮一档都加重一点，读成一团团有体积的云，不是整屏一层纱
    const m = fogPlane({ w: 1, h: 1, a0: 0.95, drift: 0.0, seed: 90 + i, lo: 0.18, hi: 0.50, sc: [1.1, 0.9], edge: 0.40, edgeInk: 0.36, side: 0.40, hole: 0.32, order: 40 + i });
    m.material.uniforms.uShade.value = 0.82; m.material.uniforms.uBright.value = 0.40;
    placeOnScreen(m, C570, x, y, w, D, h); m.rotateZ(rot); m.updateMatrixWorld(true);
    return m;
  });
  const cloudScene = new THREE.Scene();
  // 掠云：钉在 f568 机位前 2.2 米、正对小豹；相机快速横移上升时从左上掠过小豹、往右下出画（遮挡峰值约 70%，3–4 帧）
  const C568 = mkCam(568);
  const veil = fogPlane({ w: 1, h: 1, a0: 0.80, drift: 0.0, seed: 97, lo: 0.20, hi: 0.52, sc: [1.0, 0.8], edge: 0.42, edgeInk: 0.38, side: 0.42, hole: 0.24, order: 50 });
  veil.material.uniforms.uShade.value = 0.75; veil.material.uniforms.uBright.value = 0.38;
  { const cs = { x: 900, y: 380 }; placeOnScreen(veil, C568, cs.x + 20, cs.y + 10, 760, 2.2, 560); veil.rotateZ(-0.45); veil.updateMatrixWorld(true); }
  const cloudEnv = fr => ss(seg(fr, 552, 558)) * (1 - ss(seg(fr, 577, 588)));
  // 返修 w3（v3-03）：长卷段小豹肚子下面一缕淡云丝（D 比小豹远一点、画在它身后），把它和下面的山脊隔开
  const wisp = fogPlane({ w: 1, h: 1, a0: 0.8, drift: 0.02, seed: 141, lo: 0.28, hi: 0.62, sc: [2.6, 0.9], edge: 0.45, edgeInk: 0.34, side: 0.30, order: 44.5 });
  wisp.material.uniforms.uShade.value = 0.75; wisp.visible = false;

  function cubUniforms(m) {
    const u = m.material.uniforms;
    u.uSpInk.value.set(...P5[5]); u.uSpCore.value.set(...COL.spotCore);
    u.uWash.value.set(...COL.furOchre, 0.25); u.uFurF.value = 6;
    u.uEyeC.value.set(...COL.amberB, 0);
  }
  function attach(scene) { for (const m of [...allCubs, ...nearClouds, veil, wisp]) { if (m.parent !== scene) scene.add(m); m.visible = false; } }

  // 小豹在屏幕上的位置（设计像素）与姿态；S5c 末段向 T2 的眼位 P 推近（放大、回望）
  const PEYE = [650, 372];
  function cubScreen(fr) {
    const f = Math.round(fr), f2 = Math.floor(f / 2) * 2;
    if (f < 548) return { pose: f < 540 ? -1 : 0, x: 1370, y: 690, sc: 1 };
    if (f < 554) { const P = [[548, 1370, 600], [550, 1250, 520], [552, 1180, 470], [554, 1120, 430]]; const k = P.find(p => p[0] >= f2) || P[3]; return { pose: 1, x: k[1], y: k[2], sc: 1 }; }
    // 返修第 3 轮（v2-03）：不再凌空 / 滑翔每 4 帧硬切（两张剪影差太多，6 Hz 闪）——f554 起凌空（伸展），
    //   f568 掠云遮得最厚时换成滑翔（只换这一次，换的那一帧被云挡住），之后一直是滑翔，尾巴、前后腿用控制柄一拍二连续地划（像在空中游）
    const pose = f < 568 ? 2 : 3;
    const bob = 5 * Math.sin(2 * Math.PI * (Math.floor(f / 2) * 2) / 24 * 0.9);
    if (f < 591) { const u = ss(seg(fr, 554, 568)); return { pose, x: lerp(1120, 900, u), y: lerp(430, 380, u) + 8 * Math.sin(fr * 0.25), sc: 1 }; }
    // 返修 w3（v3-03）：长卷段整条路径抬高约 65 px（f586–f600 缓缓升上去），脚离开近层山脊的顶线——读成在云上飞，不是在山脊上走
    const lift = 65 * ss(seg(fr, 586, 600));
    const y = 395 - 70 * Math.sin(Math.PI * (fr - 591) / 45) - lift;
    const pu = ss(seg(fr, 620, 636));
    return { pose, x: lerp(lerp(900, 860, ss(seg(fr, 591, 600))), 760, pu), y: lerp(lerp(380 - lift, y, ss(seg(fr, 591, 597))), 330, pu) + bob * (1 - pu), sc: lerp(1, 2.1, pu) };
  }

  function placeCub(fr, f, scene, c) {
    attach(scene);
    const t2 = Math.floor(f / 2) * 2 / 24, cs = cubScreen(fr);
    const sA = SA;
    if (cs.pose < 0) {
      const m = cubSit; m.visible = true;
      clearHandles(m);
      const bb = A01.points.bbox_bottom_center;
      const br = Math.sin(2 * Math.PI * t2 / 3.0); setBreath(m, bb[1], 1 + 0.005 * br, 1 + 0.012 * br, bb[0]);
      if (f >= 524 && f < 540) { const k = Math.floor((f - 524) / 2); const ang = [6, 10, 4, -6, -10, -4, 5, 2][k] * DEG; const tt = A01.points.tail_tip; setHandle(m, 3, { c: [tt[0] - 60, tt[1] + 20], r0: 120, r1: 380, pivot: [tt[0] - 420, tt[1] + 130], ang }); }
      placeImg(m, C5a, CW1, CH1, bb[0], bb[1], cs.x, cs.y, sA, 4.9, true);
      cubUniforms(m);
      m.material.uniforms.uEye.value.set(A01.points.eye[0], A01.points.eye[1], 2.6 / sA, 1);
      return;
    }
    const P = POSES[cs.pose], m = P.m; m.visible = true;
    const sP = sA * POSE_K * cs.sc;
    clearHandles(m);
    const br = Math.sin(2 * Math.PI * t2 / 3.0); setBreath(m, P.part.size[1], 1 + 0.004 * br, 1 + 0.010 * br, P.part.size[0] / 2);
    if (cs.pose === 0) setBreath(m, P.part.size[1], 1.0, 0.97, P.part.size[0] / 2);
    if (cs.pose === 3 && f >= 618) setHandle(m, 0, { c: P.eye, r0: 60, r1: 190, pivot: [P.eye[0] + 70, P.eye[1] + 60], ang: -8 * ss(seg(Math.floor(f / 2) * 2, 618, 632)) * DEG });
    if (cs.pose === 3) {                                   // 滑翔：尾巴摆、前后腿交替划水（一拍二，每秒约 0.9 个来回；回望时动作收小）
      const f2 = Math.floor(f / 2) * 2, ph = 2 * Math.PI * f2 / 24 * 0.9, k = 1 - 0.6 * ss(seg(f2, 618, 630));
      setHandle(m, 1, { c: [505, 285], r0: 50, r1: 150, pivot: [492, 186], ang: 10 * Math.sin(ph) * k * DEG });
      // 返修 w3（v3-03）：前后腿都往后收 24°（腾空收腿，不再四条腿垂在身子下面像在走）
      const tuck = -24 * ss(seg(f2, 586, 598));
      setHandle(m, 2, { c: [150, 262], r0: 40, r1: 105, pivot: [190, 185], ang: (tuck + 8 * Math.sin(ph + 1.4) * k) * DEG });
      setHandle(m, 3, { c: [300, 272], r0: 40, r1: 105, pivot: [335, 200], ang: (tuck - 8 * Math.sin(ph + 2.8) * k) * DEG });
    }
    if (f < 548) placeImg(m, C5a, P.part.size[0], P.part.size[1], P.ctr[0], P.part.size[1] - 14, cs.x, cs.y, sP, 4.9);
    else placeImg(m, c, P.part.size[0], P.part.size[1], P.ctr[0], P.ctr[1], cs.x, cs.y, sP, f < 554 ? 4.9 : 6.0);
    cubUniforms(m);
    m.material.uniforms.uEye.value.set(P.eye[0], P.eye[1], 2.6 / sP, 1);
    const wk = ss(seg(fr, 588, 598)) * (1 - ss(seg(fr, 624, 634)));
    if (wk > 0.01 && scene === scroll) {
      wisp.visible = true; wisp.material.uniforms.uA0.value = 0.80 * wk;
      placeOnScreen(wisp, c, cs.x + 40 * cs.sc, cs.y + 78 * cs.sc, 420 * cs.sc, 6.3, 90 * cs.sc);
    }
    if (f >= 548 && f < 562) {
      [2, 4, 6].forEach((d, i) => {
        const g = ghosts[i], q = cubScreen(fr - d); if (q.pose < 1) { g.visible = false; return; }
        const PP = POSES[q.pose]; g.material.uniforms.map.value = PP.m.material.uniforms.map.value;
        g.material.uniforms.uImg.value.set(PP.part.size[0], PP.part.size[1]);
        g.visible = true; g.material.uniforms.uOp.value = [0.35, 0.20, 0.10][i];
        placeImg(g, c, PP.part.size[0], PP.part.size[1], PP.ctr[0], PP.ctr[1], q.x, q.y, sP, 6.2 + 0.1 * i);
      });
    }
  }
  // 尾迹墨点：落在尾根 / 后爪下方（当时那张姿态图上的尾根），之后钉在 D 12 平面的世界里；大小不一
  const tailScreen = fr => { const cs = cubScreen(fr); if (cs.pose < 1) return [cs.x + 70, cs.y - 40]; const P = POSES[cs.pose], s = SA * POSE_K * cs.sc; return [cs.x + (P.tail[0] - P.ctr[0]) * s, cs.y + (P.tail[1] - P.ctr[1]) * s + 10]; };
  const DOTW = DOT_F.map(fd => { const c = mkCam(fd); const t = tailScreen(fd); return screenToWorld(c, t[0], t[1], 12); });
  const DOTR = DOT_F.map((_, i) => 16 + 14 * hashi(i * 17 + 3));

  function nearCloud(fr, c, on) {
    const env = cloudEnv(fr);
    nearClouds.forEach(m => { m.visible = on && env > 0.003; m.material.uniforms.uA0.value = 0.95 * env; });
    const vk = fr < 562 || fr > 576 ? 0 : Math.exp(-(((fr - 568) / 3.6) ** 2));
    veil.visible = on && vk > 0.01; veil.material.uniforms.uA0.value = 0.80 * vk;
  }
  // S5a / S5b 前半：崖顶世界
  function S5peak(st) {
    const { f, fr } = st;
    at(cam, fr);
    placeCub(fr, f, peak, cam);
    nearCloud(fr, cam, true);
    placeDots(dotsPeak, fr, cam);
    pineSplit(f >= 548 && f < 567);
    return { cam, scene: peak, paper: anchor(cam, C5a) };
  }
  // S5b 后半、S5c：长卷世界（f572–f588 底板与山脊"浓先淡后"显影）
  function S5scroll(st) {
    const { f, fr } = st;
    at(cam, fr);
    placeCub(fr, f, scroll, cam);
    nearCloud(fr, cam, true);
    placeDots(dotsScroll, fr, cam);
    const tau = fr < 571 ? 1.05 : 1.05 - 1.1 * ss(seg(fr, 571, 588));
    scrollPlate.material.uniforms.uRevT.value = tau > 0 ? tau : 0;
    srR.forEach((m, i) => { m.material.uniforms.uDmul.value = ss(seg(fr, 572 + 3 * (2 - i), 586 + 3 * (2 - i))); });
    return { cam, scene: scroll, paper: anchor(cam, C591) };
  }
  // 换场遮罩：只渲近云（输出遮挡）
  function cloudMask(world, fr) {
    at(cam, fr);
    const env = cloudEnv(fr);
    for (const m of nearClouds) { cloudScene.add(m); m.visible = env > 0.003; m.material.uniforms.uA0.value = 0.95 * env; m.material.uniforms.uMaskOut.value = 1; }
    world('M', cloudScene, cam, [0, 0, 0], 0);
    for (const m of nearClouds) m.material.uniforms.uMaskOut.value = 0;
  }
  // 返修第 3 轮（v2-04）：尾迹墨点改成钉在世界里的面片（D 12，正对相机），按深度合成——画在长卷 / 远山之上、小豹与近云之下：
  //   掠云从小豹身前飘过时墨点一起被遮，晕开时的墨团也压不到小豹身上；墨仍是减色（正片叠底：底色 × 墨的透过率）
  const DOT_VS = /* glsl */`varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
  const DOT_FS = /* glsl */`
${NOISE}
${PALETTE}
${FOG}
${ROSETTE}
uniform float uSeedD, uProg, uOpD; varying vec2 vUv; varying vec3 vW;
// 返修 w3（v3-04）：落下那一刻不再是比豹斑还大、还黑、四周放射一圈溅点的实心圆盘（读成海胆、煤球），定形后也不再留一圈等距溅点（像病毒图标）：
//   用母型 R 的轻版（mode 2.6：晕开峰值 1.15R、墨浓 0.6）；溅点只 2–3 个、只落在运动方向的后侧（画面右侧：豹往左飞、墨点被留在身后），6 帧内淡掉
float trailSplash(vec2 p, float R, float s, float prog){
  float n = 2. + step(.5, hS(s, 81.)), c = 0.;
  for (int i = 0; i < 3; i++) {
    float fi = float(i); if (fi >= n) break;
    float ang = (hS(s, 82. + fi) - .5) * 1.3;                                // 后侧 ±37°
    float dist = R * (1.20 + .45 * hS(s, 85. + fi)), rr = R * (.05 + .05 * hS(s, 88. + fi));
    vec2 dir = vec2(cos(ang), sin(ang)), q = p - dist * dir;
    float u = dot(q, dir), v = dot(q, vec2(-dir.y, dir.x));
    float body = 1. - smoothstep(.75, 1.1, length(vec2(u / (rr * 1.6), v / rr)) + (vn2(q / (rr * .8) + fi * 7.1, uint(s) + 77u) - .5) * .35);
    c = max(c, body);
  }
  return c * (1. - smoothstep(.15, .50, prog));
}
void main(){
  vec2 p = (vUv - .5) * 2. * 2.6 * 50.;
  vec4 r = rosette(p, 50., uSeedD, 2.6, uProg);
  r.z = trailSplash(p, 50., uSeedD, uProg) * step(.001, uProg);
  float ink = clamp(r.x + r.z, 0., 1.);
  float Dd = 1. - (1. - .9 * ink) * (1. - .8 * r.w);
  float cov = clamp(ink + r.w * 2., 0., 1.) * uOpD;
  vec3 T = mix(vec3(1.), rampS(Dd) / max(uPal[0], vec3(.01)), cov);
  T = mix(T, vec3(1.), fogAmt(length(vW - cameraPosition), vW.y));
  gl_FragColor = vec4(T, 1.);
}`;
  const mkDots = (scene, order) => DOT_F.map((_, i) => {
    const mat = new THREE.ShaderMaterial({ uniforms: { uPal: U.uPal, uK: U.uK, uT: U.uT, uFogA: U.uFogA, uFogB: U.uFogB, uSeedD: { value: 300 + i * 17 }, uProg: { value: 0 }, uOpD: { value: 1 } },
      vertexShader: DOT_VS, fragmentShader: DOT_FS, transparent: true, depthWrite: false, depthTest: false });
    mat.blending = THREE.CustomBlending; mat.blendEquation = THREE.AddEquation; mat.blendSrc = THREE.ZeroFactor; mat.blendDst = THREE.SrcColorFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor; mat.blendDstAlpha = THREE.OneFactor;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat); m.renderOrder = order; m.frustumCulled = false; m.visible = false; scene.add(m); return m;
  });
  const dotsPeak = mkDots(peak, 7.5), dotsScroll = mkDots(scroll, 20);
  function placeDots(list, fr, c) {
    list.forEach((m, i) => {
      m.visible = fr >= DOT_F[i];
      if (!m.visible) return;
      const prog = clamp((fr - DOT_F[i]) / 6) * 0.5 + 0.5 * clamp((fr - DOT_F[i] - 3) / 6);
      m.material.uniforms.uProg.value = Math.max(0.001, prog);
      const Rw = DOTR[i] * 12 / FP, sz = 2 * 2.6 * Rw;
      m.position.copy(DOTW[i]); m.quaternion.copy(c.quaternion); m.scale.set(sz, sz, 1); m.updateMatrixWorld(true);
    });
  }
  function dots(fr, c) {
    const out = [];
    DOTW.forEach((w, i) => {
      if (fr < DOT_F[i]) return;
      const p = project(c, w); if (p.z < 0.5) return;
      const prog = clamp((fr - DOT_F[i]) / 6) * 0.5 + 0.5 * clamp((fr - DOT_F[i] - 3) / 6);
      out.push([p.x, p.y, DOTR[i] * 12 / p.z, Math.max(0.001, prog)]);
    });
    return out;
  }
  const anchor = (c, ref) => { const p0 = project(ref, V3(ref.position.x, ref.position.y, ref.position.z - 30)); const p = project(c, V3(ref.position.x, ref.position.y, ref.position.z - 30)); return { x: p.x, y: p.y, rx: p0.x, ry: p0.y, s: 1 }; };

  // ═════════ T2a 豹眼：A03 正片叠底在长卷纸色上，以 P = (650, 372) 为心缓推 1.00 → 1.03 ═════════
  const headScene = new THREE.Scene();
  const headCam = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.01, 100); aim(headCam, V3(0, 0, 0), 0, 0);
  const headFog = [0, 1].map(i => { const m = fogPlane({ w: 1, h: 1, a0: 0.5, drift: 0.02, seed: 95 + i, lo: 0.3, hi: 0.7, sc: [3, 1.5], edge: 0.4, order: 1 + i }); placeOnScreen(m, headCam, 960 + 300 * i, 300 + 500 * i, 2600, 20 - 5 * i, 700); headScene.add(m); return m; });
  const head = sprite(tex.head, man.A03, { order: 5, mode: 'A', deform: false, a0: -1, a1: 0.0001 });
  head.material.uniforms.uLp.value = 0.99; head.material.uniforms.uLi.value = 0.15; headScene.add(head);
  const A03 = man.A03['锚点'].points, IRIS = 59, IRIS_S = 75;
  function T2a(st) {
    const { fr } = st;
    const s = (IRIS_S / IRIS) * lerp(1.0, 1.03, ss(seg(fr, 637, 645)));
    placeImg(head, headCam, 1672, 941, A03.eye_near_center[0], A03.eye_near_center[1], PEYE[0], PEYE[1], s, 5);
    const far = [PEYE[0] + (A03.eye_far_center[0] - A03.eye_near_center[0]) * s, PEYE[1] + (A03.eye_far_center[1] - A03.eye_near_center[1]) * s];
    return { cam: headCam, scene: headScene, eye: { x: PEYE[0], y: PEYE[1], r: IRIS * s }, far, s };
  }
  // ───────── 资产参考稿（返修第 2 轮）：崖顶石峰 / 崖顶松的素描稿（投影机位 = C5a 的位置朝向、vfov 56°、固定 16:9） ─────────
  function guide(renderer, kind) {
    peak.traverse(o => { if (o !== peak) o.visible = false; });
    const show = kind === 'peak' ? peakRocks : [pine];
    rockCard.visible = pineCard.visible = false;
    for (const m of show) { m.visible = true; m.traverse(o => o.visible = true); }
    for (const m of peakRocks) { const u = m.material.uniforms; u.uStk.value.x = 0; u.uMass.value.set(0, 0.3, 0, 0); u.uWS.value = 0; u.uSoftQ.value = 1; u.uFogMul.value = 0; }
    renderer.setRenderTarget(null); renderer.setClearColor(new THREE.Color(1, 1, 1), 1); renderer.clear(true, true, true);
    renderer.render(peak, CG5);
  }
  return { peak, scroll, headScene, cam, S5peak, S5scroll, T2a, dots, cloudMask, C5a, C591, guide, CG5 };
}

function alphaOfTex(t) {
  const img = t.image, c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return { w: c.width, h: c.height, at(x, y) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0; return a[y * this.w + x] / 255; } };
}
