// 《豹变》A 水墨 · 南山雾崖世界：T1 后半、S2（一镜）、S4（一镜）共用
//   3D：崖壁（洞口画进崖体材质）、断成几级的石台、六重山脊（顶线 = 六爻）、前景松枝；雾片按深度穿插；七日剪纸圆在天门后
//   2D：小豹 A01、陆蔚 A04、陆蔚右手 A07-R（S4），鹿群画布面片（D 25，谷底），雨与墨滴画在叠加层
// 摆放一律以 S2 参考机位 C2 的屏幕构图为准（DESIGN 4.3），世界坐标由屏幕目标反解。
// 近景真虚焦：小豹、陆蔚、手、脚下墨点放在相机层 1（前景），其余在层 0，由 look.worldSplit 分两遍渲。
import * as THREE from 'three';
import {
  U, K, DW, DH, DEG, clamp, lerp, seg, ss, ss5, eo, ei, eio, hashi, hash2, mulberry, monotone,
  PAL, COL, mixPal, placeOnScreen, screenToWorld, project, aim, frameAt, fpx, fbm1, ridged1, fbm3, ridged3, alphaOf, inPoly, css, mix3,
} from '../lib/core.js';
import { inkMat, ridgeStrip, fogPlane, sunPlane, canvasPlane, needleMat, needleTexture, barkMat, bakeCavity, bakeTopView, blobPlane, projMat, projRect, projRelief } from '../lib/inkwash.js';
import { sprite, setHandle, clearHandles, setBreath, setSpots } from '../lib/sprite.js';
import { drawRain, drawDeer, drawDrop, drawInkDrop, freshClear, stroke } from '../lib/draw2d.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const FOV = 32, FP = fpx(FOV);                          // 1813
export const RIDGE_D = [60, 85, 120, 170, 240, 340];   // L1（初九）… L6（上六）
export const RIDGE_Y = [690, 610, 560, 520, 490, 466];  // C2 机位下的顶线
const RIDGE_DK = [0.78, 0.66, 0.55, 0.45, 0.36, 0.28];
const RIDGE_HK = [5.5, 7, 9, 12, 15, 19];
const RIDGE_A = [3.0, 4.0, 5.4, 7.2, 9.5, 12.5];
const GAP = { 1: 1280, 5: 1420 };                       // L2 山口、L6 天门（屏幕 x，C2）
export const FG = 1;                                    // 前景相机层

// 按 2D 资产像素摆面片：图上 (ax, ay) 落到屏幕 (sx, sy)，s = 屏幕像素 / 图像素，深度 D
export function placeImg(mesh, cam, iw, ih, ax, ay, sx, sy, s, D, flip = false) {
  const cx = sx + ((flip ? ax - iw / 2 : iw / 2 - ax)) * s, cy = sy + (ih / 2 - ay) * s;
  placeOnScreen(mesh, cam, cx, cy, iw * s, D, ih * s);
  if (flip) mesh.scale.x *= -1;
  return mesh;
}
// 小豹的头型（style-03）：口鼻缩短约 15%，两耳压低压圆——向 A03 的圆脸短吻靠
export function cubHeadShape(m, A, k = 1) {
  const eye = A.points.eye, nose = A.points.nose;
  setHandle(m, 0, { c: nose, r0: 22, r1: 82, tr: [(eye[0] - nose[0]) * 0.17 * k, (eye[1] - nose[1]) * 0.10 * k] });
  const ef = A.circles.ear_front, eb = A.circles.ear_back;
  setHandle(m, 1, { c: [ef[0], ef[1] - 6], r0: 24, r1: 64, pivot: [ef[0] - 6, ef[1] + 34], sc: 1 - 0.20 * k, tr: [0, 7 * k] });
  setHandle(m, 2, { c: [eb[0], eb[1] - 6], r0: 24, r1: 64, pivot: [eb[0] + 8, eb[1] + 34], sc: 1 - 0.20 * k, tr: [0, 6 * k] });
}

export function buildCliff(ctx) {
  const { tex, man } = ctx;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.01, 5000);
  cam.layers.enableAll();
  const C2 = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.01, 5000);
  aim(C2, V3(0, 0.75, 0), 0, -3 * DEG);
  const C2E = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.01, 5000);
  aim(C2E, V3(-0.5, 0.75, -0.3), 0, -3 * DEG);
  // 投影机位 CG（返修第 2 轮）：C2 的位置与朝向、vfov 42°、固定 16:9；崖体水墨原画就是按它画、按它投的
  const CG = new THREE.PerspectiveCamera(42, 16 / 9, 0.01, 5000);
  CG.position.copy(C2.position); CG.quaternion.copy(C2.quaternion); CG.updateProjectionMatrix(); CG.updateMatrixWorld(true);
  const L = [-0.35, 0.85, 0.40];
  const fgObj = [];
  const toFG = m => { m.layers.set(FG); fgObj.push(m); return m; };

  // ───────── 崖：一大团石块，受暗面一笔一笔的披麻 / 斧劈；崖右缘、顶轮廓、洞口到焦或浓；只有崖顶上方化进雾 ─────────
  const rockMat = (o = {}) => inkMat({ L, Dbase: 0.40, lit: 0.42, cun: 0.0, rim: 0.55, cavK: 0.55, en: 1, softQ: 0.36, ws: 0.09,
    mass: [0.20, 0.45, 0.0, 0.14], top: [0.90, 0.10, 0.85, 0.80], side: THREE.FrontSide,
    stk: [0.22, 0.42, 0.13, 0.08], stk2: [0.32, 0.46, 0.18, 0.55], ...o });
  const rocks = [];
  const addRock = (cx, cy, wpx, hpx, D, sz, seed, o = {}, mo = {}) => {
    const m = rockMass({ cx, cy, wpx, hpx, D, sz, seed, cam: C2, ...o }, rockMat(mo));
    m.renderOrder = 8 + 0.01 * (10 - D); scene.add(m); rocks.push(m); return m;
  };
  addRock(250, 430, 1180, 640, 10.2, 1.0, 1, { amp: 0.20, flat: 0.6 }, { Dbase: 0.70, lit: 0.22, top: [1.50, 0.60, 4.6, 0.72], rim: 0.95,
    fade: [1.30, 2.7, 0, 0], mass: [0.26, 0.40, 0.0, 0.15], grad: [0.06, 0.02, 0, 0.0], stk: [0.24, 0.48, 0.15, 0.08] });
  addRock(60, 612, 720, 220, 8.9, 0.8, 2, { amp: 0.20 }, { Dbase: 0.76, top: [1.35, 0.32, 1.6, 0.80], mass: [0.22, 0.5, 0.0, 0.12], stk: [0.22, 0.36, 0.12, 0.08] });
  // 洞口：按 C2 机位从屏幕 (808, 520) 打到崖体上求交，画进崖体材质（椭球内到焦墨，边带花椰菜噪声）
  const CAVE = { sx: 808, sy: 520, rpx: [178, 150] };
  {
    const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(CAVE.sx / DW * 2 - 1, -(CAVE.sy / DH) * 2 + 1), C2);
    const hit = rc.intersectObject(rocks[0], false)[0];
    const p = hit ? hit.point.clone() : screenToWorld(C2, CAVE.sx, CAVE.sy, 9.6);
    const D = p.distanceTo(C2.position);
    p.z -= 0.25;
    for (const r of rocks) { r.material.uniforms.uCave.value.set(p.x, p.y, p.z, 1); r.material.uniforms.uCaveR.value.set(CAVE.rpx[0] / FP * D, CAVE.rpx[1] / FP * D, 1.3); }
  }
  // ───────── 石台：截面拉伸；右端断成三级（每级低一截），顶面横擦加飞白；正面唇口下一道浓墨 ─────────
  let slab;
  {
    const PR = [[-1.6, -7.95], [-0.35, -7.62], [-0.07, -7.42], [0.0, -7.22], [0.02, -6.6], [0.0, -5.95], [-0.05, -5.74], [-0.20, -5.62], [-1.0, -5.52], [-3.6, -5.38]];
    const curve = new THREE.CatmullRomCurve3(PR.map(([y, z]) => V3(0, y, z)), false, 'centripetal');
    const g = new THREE.PlaneGeometry(1, 1, 600, 160);
    const p = g.attributes.position;
    const pt = V3(0, 0, 0), tg = V3(0, 0, 0);
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) + 0.5, v = 0.5 - p.getY(i);
      curve.getPointAt(v, pt); curve.getTangentAt(v, tg);
      let y = pt.y, z = pt.z;
      const ny = tg.z, nz = -tg.y;
      const xr = 1.02 + 0.45 * fbm1(y * 1.4 + z * 0.4, 5) - clamp(-y - 0.1, 0, 3) * 0.16;
      const x = -9.6 + u * (xr + 9.6);
      const lip = Math.exp(-(((v - 0.66) / 0.08) ** 2));
      const d = (0.07 + 0.16 * lip) * fbm3(x * 0.9, y * 1.1, z * 1.1, 25, 3) - 0.03;
      y += ny * d; z += nz * d;
      // 右端断成三级：每级低一截、往前错一点（不再圆转下卷）
      const s1 = clamp((x - (xr - 1.05)) / 0.035), s2 = clamp((x - (xr - 0.48)) / 0.035);
      y -= 0.11 * s1 + 0.15 * s2; z += 0.05 * s1 + 0.05 * s2;
      p.setXYZ(i, x, y, z);
    }
    g.computeVertexNormals(); bakeCavity(g, 3, 2);
    const vRow = i => Math.floor(i / 601) / 160;
    bakeTopView(g, V3(0, 0, 0), C2, FP, { binPx: 5, use: i => vRow(i) >= 0.475, below: 9 });
    slab = new THREE.Mesh(g, inkMat({ L, Dbase: 0.26, lit: 0.45, cun: 0.0, rim: 0.45, cavK: 0.55, softQ: 0.34, ws: 0.09,
      mass: [0.16, 0.55, 0.0, 0.22], top: [1.18, 0.16, 0.72, 0.84], fade: [0, 0, -0.62, -1.45], grad: [0, -0.34, 0, 0.0],
      stk: [0.20, 0.55, 0.10, 0.05], stk2: [0.10, 0.40, 0.22, 0.30], stkH: 1 }));
    slab.renderOrder = 8.5;
    scene.add(slab);
  }
  // ───────── 返修第 2 轮：崖换成水墨原画（Magpie，按 CG 机位的素描稿重画；DESIGN 风险表 #6 的降级：崖壁是 2D 底板，石台仍是 3D）
  //   崖壁：一张 B 类墨画面片，摆在 D 9.5（参考机位下正好盖住原画那块画面）；石台：3D 几何，按 CG 把同一张画投上去（人豹坐在它上面，视差对得上）
  const CLIFF_PX = [28, 37, 1372, 1045];                    // 原画在 CG 画面里的像素框（1920×1080）
  const FGd = 540 / Math.tan(21 * DEG), scG = FP / FGd;
  const g2c = (x, y) => [960 + (x - 960) * scG, 520 + (y - 540) * scG];
  const [wx0, wy0] = g2c(CLIFF_PX[0], CLIFF_PX[1]), [wx1, wy1] = g2c(CLIFF_PX[2], CLIFF_PX[3]);
  const mWall = man['R2-CLIFF'] || { Lp: 0.963, Li: 0.078 };
  // 返修第 3 轮（v2-02）：崖壁不再是 2D 面片——按这张原画自己的轮廓长出一块 3D 浮雕（基准 D 9.6，中间往前鼓 1.1 m，洞口往里凹 2.6 m），
  //   再用 projMat 按 CG 机位把同一张画投回去（CG 机位下与原画逐像素一致）；S2 横移、S4 大幅推拉时，崖面的透视、洞口的纵深与遮挡都是真的；
  //   投影出来的墨浓再按 N·L 分两阶（受光面淡一档、背光面浓一档）
  const caveCG = [960 + (808 - 960) / scG, 540 + (520 - 520) / scG];
  const wall = projRelief(tex.cliffWall, CG, CLIFF_PX, { Dbase: 9.6, bulge: 1.1, blurPx: 18, cave: { x: caveCG[0], y: caveCG[1], rx: 150 / scG, ry: 130 / scG, depth: 2.6 } },
    { Lp: mWall.Lp, Li: mWall.Li, fall: [-1, 0], nl: 0.22, L, depthWrite: false });
  wall.renderOrder = 7.8;
  scene.add(wall);
  slab.material = projMat(tex.cliffWall, CG, projRect(...CLIFF_PX), { Lp: mWall.Lp, Li: mWall.Li, fall: [0.10, 0.04] });
  for (const r of rocks) r.visible = false;
  // 人和豹脚下各一笔淡墨横点，把人压住
  const feet = [[800, 652, 190, 20, 6.0, 4.1], [1048, 660, 270, 22, 6.15, 6.3]].map(([x, y, w, h, D, sd]) => {
    const m = blobPlane({ D0: 0.36, D1: 0.24, seed: sd, soft: 0.42, order: 9.6 });
    placeOnScreen(m, C2, x, y, w, D, h); scene.add(m); return toFG(m);
  });

  // ───────── 苔点：只取崖顶前沿、石台前沿的顶轮廓顶点（贴在几何表面上），横向扁点成簇 ─────────
  const moss = [];                                        // 苔点画在原画里了

  // ───────── 六重山脊（顶线 = 六爻；amp 0 时是直线） ─────────
  const ridges = RIDGE_D.map((D, k) => {
    let lo = -200, hi = 200;
    for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; const y = project(C2, V3(0, mid, -D)).y; if (y > RIDGE_Y[k]) lo = mid; else hi = mid; }
    const H = (lo + hi) / 2;
    const gx = GAP[k] !== undefined ? screenToWorld(C2, GAP[k], 500, D).x : null;
    const A = RIDGE_A[k], fq = 1 / (0.20 * D), seed = 70 + k * 11;
    const prof = x => A * 1.6 * (0.78 * fbm1(x * fq + k * 13.1, seed, 3) + 0.22 * (ridged1(x * fq * 1.7 + 3.7, seed + 3) * 2 - 1))
      - (gx !== null ? A * 1.7 * Math.exp(-(((x - gx) / (0.05 * D)) ** 2)) : 0);
    const w = D * 1.4 + 30;
    const m = ridgeStrip({ x0: -w, x1: w, z: -D, H, bottom: H - 60, seg: 900, prof, Dk: RIDGE_DK[k], Hk: RIDGE_HK[k], hue: 0.06 * k,
      hueC: COL.indigoM, soft: 0.004 * D, seed: k * 3.7, order: 1 + (5 - k), topV: 0.5 });
    m.userData = { H, D, k, prof, gx };
    scene.add(m);
    return m;
  });

  // ───────── 雾片（颜色 = 纸） ─────────
  const fogs = {};
  const mkFog = (name, D, x0, x1, y0, y1, o) => {
    const m = fogPlane({ w: 1, h: 1, ...o });
    m.userData = { D, rect: [x0, x1, y0, y1] };
    placeOnScreen(m, C2, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, D, y1 - y0);
    scene.add(m); fogs[name] = m; return m;
  };
  mkFog('M4', 300, -500, 2700, 290, 480, { a0: 0.50, drift: 0.010, seed: 4, lo: 0.30, hi: 0.70, sc: [5, 1.2], edge: 0.42, order: 1.5 });
  mkFog('M2', 150, -500, 2700, 470, 575, { a0: 0.85, drift: 0.016, seed: 2, lo: 0.28, hi: 0.66, sc: [6, 1.3], edge: 0.40, order: 3.5 });
  mkFog('M1', 40, -700, 2900, 585, 715, { a0: 0.88, drift: 0.022, seed: 1, lo: 0.28, hi: 0.64, sc: [6, 1.4], edge: 0.40, order: 6.5 });
  mkFog('M1a', 22, 1040, 2500, 805, 905, { a0: 0.86, drift: 0.03, seed: 7, lo: 0.22, hi: 0.58, sc: [4, 1.2], edge: 0.30, side: 0.10, order: 7.5 });
  mkFog('M0', 4, -500, 2700, 765, 1150, { a0: 0.94, drift: 0.045, seed: 9, lo: 0.20, hi: 0.55, sc: [5, 1.6], edge: 0.30, order: 14 });
  // 返修第 3 轮（story-05）：雾雨一天比一天浓——一条压在谷里、盖住近处四重山山脚的厚雾带（D 50，山头还露着）；S2 里随七日渐渐浓起来，
  //   S4 的 f444（18.52 s 最大涌起）从天门 x≈1420 一分为二，两半各自往外滑开约 350 px、变薄，谷底与六重山整个露出来
  mkFog('MR', 50, -200, 2700, 505, 840, { a0: 0.97, drift: 0.012, seed: 5, lo: 0.15, hi: 0.52, sc: [7, 1.3], edge: 0.36, order: 6.2 });
  fogs.MR.userData.openX = (1420 + 200) / 2900;

  // ───────── 七日（剪纸圆，淡赭带深边，D 600）与第七日 ─────────
  const SUNC = [0.824, 0.706, 0.525];
  const suns = [0, 1].map(i => { const m = sunPlane({ color: SUNC, halo: 0.18, haloA: 0.06, rim: 1.6, seed: i * 3 + 1, order: 0.4 }); scene.add(m); return m; });
  // 第七日：返修第 3 轮（story-05）颜色往暖、往深走一档（原来的晨光藤黄和暖纸几乎一个亮度，读不出"日出"），暖晕大一圈
  const sun7 = sunPlane({ color: [0.925, 0.800, 0.560], halo: 3.4, haloA: 0.34, rim: 1, seed: 17, order: 0.45 }); scene.add(sun7);

  // ───────── 鹿群（D 25，谷底；腿的下 1/3 被谷底雾 M1a 盖住） ─────────
  const DEER_RECT = [1060, 1880, 740, 900];
  const deer = canvasPlane(1640, 320, { order: 7.2, fogMul: 1 });
  placeOnScreen(deer.mesh, C2, (DEER_RECT[0] + DEER_RECT[1]) / 2, (DEER_RECT[2] + DEER_RECT[3]) / 2, DEER_RECT[1] - DEER_RECT[0], 25, DEER_RECT[3] - DEER_RECT[2]);
  scene.add(deer.mesh);
  const DEER = Array.from({ length: 6 }, (_, i) => ({ f0: 146 + i * 12 + Math.round(hash2(i, 2610) * 5), x0: 1415 + (hash2(i, 2611) - 0.5) * 30,
    L: 56 * (0.88 + 0.24 * hash2(i, 2612)), ph: (i * 3 + 1) % 4, dy: (hash2(i, 2613) - 0.5) * 14, stag: i === 1 || i === 4 }));

  // ───────── 前景松枝（S2 右上，D≈2.3）：有转折、有分叉；干是两条不对称的笔线 + 鳞皴；针是一团团半扇形 ─────────
  const pine = new THREE.Group(); scene.add(pine);
  {
    const L5 = L;
    const mkBranch = (pts, D0, r0, r1, seed) => {
      const sp = pts.map(([x, y], i) => screenToWorld(C2, x, y, D0 + i * 0.03));
      const curve = new THREE.CatmullRomCurve3(sp);
      const tg = new THREE.TubeGeometry(curve, 140, 1, 10, false);
      const p = tg.attributes.position, segs = 141, rad = 11;
      for (let s = 0; s < segs; s++) {
        const u = s / (segs - 1), c = curve.getPointAt(u);
        const r = lerp(r0, r1, Math.pow(u, 0.7)) * (1 - ss(seg(u, 0.88, 1.0)) * 0.92);      // 最后 10% 收尖
        for (let j = 0; j < rad; j++) {
          const i = s * rad + j; const v = V3(p.getX(i), p.getY(i), p.getZ(i)).sub(c);
          const jit = 1 + 0.18 * fbm3(u * 9, j * 0.7, 3, 31 + seed);
          p.setXYZ(i, c.x + v.x * r * jit, c.y + v.y * r * jit, c.z + v.z * r * jit);
        }
      }
      tg.computeVertexNormals();
      const m = new THREE.Mesh(tg, barkMat({ L: L5, len: curve.getLength(), circ: 2 * Math.PI * (r0 + r1) / 2, D0: 0.75, seed }));
      m.renderOrder = 14.5; pine.add(m);
      return curve;
    };
    // 返修第 2 轮（style-08）：前景松枝换成 Magpie 水墨原画（一张 B 类面片，D 2.25，预先虚一点）；下面的 3D 管与针团只留作构图参考稿，不再显示
    const pineCard = sprite(tex.pineS2, man['R2-PINE2'] || { Lp: 0.98, Li: 0.056 }, { order: 15, deform: false, a0: 0.20, a1: 0.80, fogMul: 0 });
    { const [x0, y0] = g2c(1180, 0), [x1, y1] = g2c(1920, 370); placeOnScreen(pineCard, C2, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, 2.25, y1 - y0); }
    pine.add(pineCard); pine.userData.card = pineCard;
    const main = mkBranch([[3250, -230], [2700, -70], [2380, 50], [2160, 30], [1950, 120], [1790, 100], [1640, 175], [1520, 238]], 2.25, 0.052, 0.010, 1);
    const fork = mkBranch([[2160, 30], [2030, -40], [1880, -62], [1760, -36]], 2.33, 0.022, 0.006, 2);
    // 枝梢收笔：一点焦墨
    const tipDot = blobPlane({ D0: 1.0, D1: 0.85, seed: 8.1, soft: 0.25, order: 15.2 });
    { const p = main.getPointAt(1); const pr = project(C2, p); placeOnScreen(tipDot, C2, pr.x - 3, pr.y + 1, 9, pr.z, 7); pine.add(tipDot); }
    const tex4 = [11, 12, 13, 14, 15].map(s => needleTexture(s));
    const groups = [[main, [0.40, 0.52, 0.63, 0.74, 0.86, 0.95]], [fork, [0.45, 0.75, 0.97]]];
    const rnd = mulberry(331);
    groups.forEach(([curve, us], gi) => us.forEach((u0, k) => {
      const nm = needleMat(tex4[(k + gi * 2) % tex4.length], { D0: 0.58 + 0.12 * rnd(), D1: 0.88, lod: 0.2, fogMul: 0 });
      const n = 3 + Math.floor(rnd() * 3), inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.17, 0.125), nm, n);
      const mtx = new THREE.Matrix4(), q = new THREE.Quaternion();
      for (let j = 0; j < n; j++) {
        const u = clamp(u0 + (rnd() - 0.5) * 0.06), c = curve.getPointAt(u), t = curve.getTangentAt(u);
        const pa = project(C2, c), pb = project(C2, c.clone().add(t.clone().multiplyScalar(0.05)));
        const ang = Math.atan2(-(pb.y - pa.y), pb.x - pa.x) + (rnd() - 0.5) * 0.9;                // 扇口朝枝梢（屏幕方向）
        q.copy(C2.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.5, ang)));
        const off = V3((rnd() - 0.5) * 0.06, (rnd() - 0.3) * 0.05, (rnd() - 0.5) * 0.05);
        const s = 0.75 + 0.5 * rnd();
        mtx.compose(c.clone().add(off), q, V3(s, s, s)); inst.setMatrixAt(j, mtx);
      }
      inst.renderOrder = 15; inst.frustumCulled = false; pine.add(inst);
    }));
  }

  pine.children.forEach(o => { if (o !== pine.userData.card) o.visible = false; });
  // ───────── 小豹 A01（笔块化）、陆蔚 A04 ─────────
  const mA01 = man.A01, aA01 = mA01['锚点'];
  const CW1 = tex.cub.image.width, CH1 = tex.cub.image.height;   // A01（返修版 cub_sit_v2：圆脸短吻、三四团墨）
  const cub = sprite(tex.cub, mA01, { order: 10, a0: 0.28, a1: 0.78, fur: 1, furF: 15, erode: 1.5 });
  cub.material.uniforms.uBlock.value.set(0.7, 4.6, 0.86, 0.09);
  scene.add(toFG(cub));
  const CUB_S2 = { s: 250 / 1350, anchor: aA01.points.bbox_bottom_center, at: [800, 652], D: 6.0 };
  placeImg(cub, C2, CW1, CH1, CUB_S2.anchor[0], CUB_S2.anchor[1], CUB_S2.at[0], CUB_S2.at[1], CUB_S2.s, CUB_S2.D);
  cub.updateMatrixWorld(true);
  const cubM = cub.matrixWorld.clone();
  const imgToWorld = (x, y, out = new THREE.Vector3()) => out.set(x / CW1 - 0.5, 0.5 - y / CH1, 0).applyMatrix4(cubM);
  const mA04 = man.A04, aA04 = mA04['锚点'];
  const lu = sprite(tex.luSit, mA04, { order: 10.5, a0: 0.30, a1: 0.80, erode: 2.5, rimInk: [3.2, 5.0] });
  scene.add(toFG(lu));
  placeImg(lu, C2, 725, 831, aA04.points.bbox_bottom_center[0], aA04.points.bbox_bottom_center[1], 1030, 656, 298 / 772, 6.2);
  lu.material.uniforms.uLi.value = 0.22;
  lu.updateMatrixWorld(true);
  const luCorners = [V3(-0.5, -0.5, 0), V3(0.5, -0.5, 0), V3(-0.5, 0.5, 0), V3(0.5, 0.5, 0)].map(v => v.applyMatrix4(lu.matrixWorld));
  const luScreen = c => { const ps = luCorners.map(p => project(c, p)); return { x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) }; };

  // ───────── 斑点表（DESIGN 4.5，固定种子 20261104；体侧斑减到 22 枚，贴边处按体侧方向压扁） ─────────
  const spots = makeSpotTable(alphaOf(tex.cub.image), aA01, 22, CH1 / 992 * 0.95);

  // ───────── S4：陆蔚右手 A07-R + 手上的雨流画布 ─────────
  const mA07 = man['A07-R'], aA07 = mA07['锚点'];
  const hand = sprite(tex.handRain, mA07, { order: 11, a0: 0.30, a1: 0.80, erode: 3, rimInk: [2.4, 4.0] });
  hand.material.uniforms.uLi.value = 0.38;
  hand.material.uniforms.uLine.value.set(1, 2.2, 6, 0.80);
  hand.visible = false; scene.add(toFG(hand));
  const handFx = canvasPlane(885, 884, { order: 11.5, fogMul: 0, mip: true });
  handFx.mesh.visible = false; scene.add(toFG(handFx.mesh));

  // ───────── 每帧 ─────────
  function placeSun(m, x, y, rpx, haloRatio, op, cam0) {
    m.visible = op > 0.002;
    if (!m.visible) return;
    placeOnScreen(m, cam0, x, y, 2 * rpx * (1 + haloRatio), 600, 2 * rpx * (1 + haloRatio));
    m.material.uniforms.uOp.value = op;
  }
  function deerDraw(f, pal6) {
    const g = deer.ctx; freshClear(g, 1640, 320);
    const sc = 1640 / (DEER_RECT[1] - DEER_RECT[0]);
    g.setTransform(sc, 0, 0, sc, -DEER_RECT[0] * sc, -DEER_RECT[2] * sc);
    const f2 = Math.floor(f / 2) * 2;
    const inks = [pal6[1], pal6[2], pal6[3], pal6[4], pal6[5]];
    DEER.forEach((d, i) => {
      if (f2 < d.f0) return;
      const x = d.x0 + 3.2 * (f2 - d.f0), y = 822 + d.dy;
      if (x > 1900) return;
      g.globalAlpha = ss(seg(f2, d.f0, d.f0 + 8));                     // 从谷底雾后走出来：逐只淡入
      drawDeer(g, x, y, d.L, (Math.floor(f2 / 2) + d.ph) % 4, inks, d.stag, i + 1);
      g.globalAlpha = 1;
    });
    deer.tex.needsUpdate = true;
  }

  // 雨：三层深度，跟随视差（设计像素）
  // 返修 w3（qa2-10）：雨丝太淡（静帧里要拉三倍对比才看得清）：近层不透明度约提一倍、加长加粗一点、墨色深半档（淡—重之间），中层略提
  const RAIN = [
    { n: 34, D: 3, op: 0.34, lenA: 140, lenB: 200, wA: 1.5, wB: 1.9, seed: 501, col: mix3(PAL.cliff[2], PAL.cliff[3], 0.5) },
    { n: 50, D: 8, op: 0.27, lenA: 95, lenB: 140, wA: 1.2, wB: 1.4, seed: 502 },
    { n: 58, D: 25, op: 0.22, lenA: 70, lenB: 100, wA: 1.1, wB: 1.25, seed: 503 },
  ];

  function setScene(st) {
    const { f, fr, t } = st;
    const t2 = Math.floor(f / 2) * 2 / 24;
    const pal6 = st.pal;
    ridges.forEach((m, k) => {
      const u = m.material.uniforms;
      u.uAmp.value = st.amp ?? 1;
      u.uTide.value = st.tide ? st.tide[k] : 0; u.uTideW.value = 6 / FP * m.userData.D;
      u.uDmul.value = st.ridgeMul ?? 1;
    });
    for (const [name, m] of Object.entries(fogs)) {
      const u = m.material.uniforms;
      u.uA0.value = m.userData.a0base ?? (m.userData.a0base = u.uA0.value);
      u.uA0.value = m.userData.a0base * (st.fogMul?.[name] ?? 1);
      u.uOpen.value.set(m.userData.openX ?? 0.55, st.fogOpen?.[name] ?? 0, name === 'MR' ? 0.07 : 0.12, 0);
      u.uSlide.value = st.fogSlide?.[name] ?? 0;
    }
    for (const s of suns) s.visible = false;
    if (st.days) {
      let si = 0;
      for (const d of st.days) { if (si > 1) break; placeSun(suns[si], d.x, d.y, 44, 0.18, d.op, C2); si++; }
    }
    if (st.sun7) placeSun(sun7, st.sun7.x, st.sun7.y, 62, 3.4, st.sun7.op, C2E); else sun7.visible = false;
    deer.mesh.visible = !!st.deer;
    if (st.deer) deerDraw(f, pal6);
    pine.visible = st.pine !== false;
    const cu = cub.material.uniforms;
    const br = Math.sin(2 * Math.PI * t2 / 3.0);
    setBreath(cub, aA01.points.bbox_bottom_center[1], 1 + 0.005 * br, 1 + 0.012 * br, aA01.points.bbox_bottom_center[0]);
    clearHandles(cub);
    if (st.headTurn) setHandle(cub, 3, { c: [aA01.points.eye[0] - 150, aA01.points.eye[1] + 10], r0: 220, r1: 420, pivot: aA01.points.neck, ang: st.headTurn * DEG });
    const scr = st.cubScreenScale ?? CUB_S2.s;
    const er = Math.max(6, 2.6 / scr);
    cu.uEye.value.set(aA01.points.eye[0], aA01.points.eye[1], er, 1);
    cu.uEyeC.value.set(...(st.amber || COL.amber), st.blink || 0);
    cu.uFurF.value = 6;
    cu.uLod.value = st.cubLod ?? 0;
    cu.uBlock.value.x = st.blockK ?? 0.7; cu.uBlock.value.w = st.blockW ?? 0.09;   // 返修 w3（qa2-12）：近景时笔块化的量化比例和阶边深线都降下来
    cu.uSpInk.value.set(...pal6[5]); cu.uWetC.value.set(...COL.wetSpot); cu.uSpCore.value.set(...COL.spotCore);
    setSpots(cub, st.spotList || []);
    cu.uWash.value.set(...COL.furOchre, st.wash || 0);
    const lb = Math.sin(2 * Math.PI * t2 / 4.2 + 1.3);
    setBreath(lu, 800, 1 + 0.003 * lb, 1 + 0.008 * lb, 362);
    lu.visible = st.lu !== false;
    feet[1].visible = lu.visible;
  }

  // 湿斑（S2 与 S4 落墨前）：没干的墨圈，最大的 12 枚
  const wetIdx = spots.body.map((s, i) => [s.R, i]).sort((a, b) => b[0] - a[0]).slice(0, 12).map(a => a[1]);
  function wetList(op = 1) { return [...wetIdx.map(i => ({ ...spots.body[i], R: spots.body[i].R * 0.95, mode: 1, prog: 1, op, core: 0 })), ...tailDots(1)]; }
  function tailDots(op) { return spots.tail.map(s => ({ ...s, mode: 4, prog: 1, op: 0.9 * op, core: 0 })); }

  // ───────── S2 相机 ─────────
  const zIn = monotone([[102, 3.0], [114, 0.9], [132, 0.1], [140, 0]]);
  function camS2(fr) {
    const z = fr < 140 ? zIn(fr) : -0.3 * ss5(seg(fr, 140, 265));
    const x = -0.5 * ss5(seg(fr, 140, 265));
    aim(cam, V3(x, 0.75, z), 0, -3 * DEG);
    return { dx: x, dz: z };
  }
  // 七日：第 k 日峰值帧，生命 24 帧；从天门左侧升起，右滑约 360 px 后沉进雾里；一个比一个淡（日本身设下限）
  const DAY_PEAK = [138, 154, 173, 190, 206, 222, 238];
  function daysAt(fr) {
    const out = [];
    DAY_PEAK.forEach((pk, i) => {
      const a = pk - 12, b = pk + 12;
      if (fr < a || fr > b) return;
      const u = (fr - a) / 24;
      const env = fr < pk - 2 ? ss(seg(fr, a, pk - 2)) : fr > pk + 2 ? 1 - ss(seg(fr, pk + 2, b)) : 1;
      const x = 1250 + 30 * i + 360 * u, y = 478 - 158 * Math.sin(Math.PI * u);
      out.push({ x, y, op: 0.92 * Math.pow(0.86, i) * env });
    });
    return out;
  }
  // 昼夜呼吸：两个日之间纸色轻轻暗一下再亮回来（3–4%）
  function dayExpo(fr) {
    if (fr < 126 || fr > 252) return 1;
    let m = 0;
    for (const pk of DAY_PEAK) m = Math.max(m, Math.exp(-(((fr - pk) / 6.5) ** 2)));
    return 1 - 0.035 * (1 - m) * ss(seg(fr, 126, 134)) * (1 - ss(seg(fr, 244, 252)));
  }
  function rain(g, fr, camDx, camDy, op, layers = RAIN) {
    if (op <= 0) return;
    drawRain(g, fr / 24, { layers, color: PAL.cliff[2], camDx, camDy, fpx: FP, op, speed: 2600, angle: 18 });
  }

  // S2：f114–f265（T1 期间 f104 起也用它）
  function S2(st) {
    const { f, fr, over } = st;
    const c = camS2(fr);
    const days = daysAt(fr);
    const f2 = Math.floor(f / 2) * 2;
    const headTurn = 7 * ss(seg(f2, 188, 196)) * (1 - ss(seg(f2, 228, 238)));      // 小豹转头看一眼鹿（踩 8.0 s 的涌起），又回过去
    const blink = f >= 226 && f < 230 ? 1 : 0;
    for (const m of [...rocks, slab, wall]) m.material.uniforms.uMist.value.set(0, 1, 3);
    wall.material.uniforms.uDk.value = 1; slab.material.uniforms.uDk.value = 1;
    moss.forEach(m => m.material.uniforms.uOp.value = 1);
    lu.material.uniforms.uRevT.value = 0; lu.material.uniforms.uVeil.value.set(0, 0, 0, 0);   // S2 里不罩近雾（每帧都重设：任意帧单独渲也一样）
    setScene({ ...st, days, deer: true, headTurn, blink, spotList: wetList(st.wetOp ?? 1), amp: st.amp ?? 1, fogMul: { MR: ss(seg(fr, 150, 250)) } });
    hand.visible = false; handFx.mesh.visible = false;
    if (over) rain(over, fr, c.dx, 0, st.rainOp ?? 1);
    return { cam, paper: paperAnchor(cam), expo: dayExpo(fr) };
  }
  const PAPER_PT = screenToWorld(C2, 805, 650, 6.2);
  const PAPER_REF = project(C2, PAPER_PT);
  function paperAnchor(c) {
    const p = project(c, PAPER_PT);
    const s = clamp(Math.pow(PAPER_REF.z / Math.max(p.z, 0.05), 0.35), 0.6, 1.8);
    return { x: p.x, y: p.y, rx: PAPER_REF.x, ry: PAPER_REF.y, s };
  }
  // T1 需要：每重山顶线在当前相机下的屏幕折线（同一条顶线函数、同一个 amp）
  function ridgeLineY(k) { return project(cam, V3(0, ridges[k].userData.H, -RIDGE_D[k])).y; }
  function ridgePolyline(k, amp, n = 64) {
    const { H, D, prof } = ridges[k].userData;
    const cz = cam.position.z, cx = cam.position.x;
    const w = (D + cz) * Math.tan(FOV * DEG / 2) * (DW / DH) * 1.25;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const xw = cx - w + 2 * w * i / n;
      const p = project(cam, V3(xw, H + amp * prof(xw), -D));
      pts.push([p.x, p.y]);
    }
    return pts;
  }
  // T1 末段：只渲前景（崖、石台、人、豹、松枝）到遮罩，六道线落在它们后面
  const bgObj = () => [...ridges, ...Object.values(fogs), ...suns, sun7, deer.mesh];
  function fgMask(world, c) {
    const hid = bgObj().map(m => [m, m.visible]);
    hid.forEach(([m]) => m.visible = false);
    world('M', scene, c, [0, 0, 0], 0);
    hid.forEach(([m, v]) => m.visible = v);
  }

  // ═════════ S4 豹变（一个连续长镜头，DESIGN 4.5） ═════════
  const qC2 = C2.quaternion.clone();
  const RT = V3(1, 0, 0).applyQuaternion(qC2), UP = V3(0, 1, 0).applyQuaternion(qC2), FW = V3(0, 0, -1).applyQuaternion(qC2);
  const S0 = spots.body[0];
  const P0w = imgToWorld(S0.x, S0.y);
  const cubC = imgToWorld(CW1 * 0.48, CH1 * 0.56);
  const IMG_M = CUB_S2.s / FP * CUB_S2.D;
  const DROP_H = 0.36;
  const TIP = P0w.clone().addScaledVector(UP, DROP_H).addScaledVector(FW, -0.05);
  const HAND_M = 0.00037;
  const aTip = aA07.points.index_tip;
  function placeHandWorld(off) {
    const c = TIP.clone().addScaledVector(RT, (885 / 2 - aTip[0]) * HAND_M + off).addScaledVector(UP, (aTip[1] - 884 / 2) * HAND_M + off * 0.8);
    for (const m of [hand, handFx.mesh]) { m.position.copy(c); m.quaternion.copy(qC2); m.scale.set(885 * HAND_M, 884 * HAND_M, 1); m.visible = true; m.updateMatrixWorld(true); }
  }
  const DROP_R = 0.0068, F_OFF = 378, F_LAND = 386;   // 返修 w3（qa2-03）：下落 12 帧 → 8 帧，f386 落背（16.08 s，踩 16.10 s 的起音；原 f390 晚 150 ms）
  const dropAt = fr => { const u = clamp((fr - F_OFF) / (F_LAND - F_OFF)); return TIP.clone().lerp(P0w, u * u); };
  const camA = project(C2E, cubC);
  const KEYS = [
    [326, cubC, camA.x, camA.y, camA.z, -3],
    [347, cubC, camA.x, camA.y, camA.z * 0.97, -3],
    [362, TIP, 1320, 470, 0.62, -10],
    [377, TIP, 1320, 472, 0.615, -10],
    [386, P0w, 1250, 600, 0.95, -3],
    [411, P0w, 1250, 600, 0.93, -3],
    // 返修第 2 轮（story-05）：K3 提前到 f430，f430–f446 踩着 18.52 s 的涌起快速拉开到近 C2_end 的全景（雾散、第七日从天门升起都在全景里看得见），之后缓缓落到 C2_end
    [430, cubC, 1150, 560, 1.75, -3],
    [446, cubC, camA.x, camA.y, camA.z * 0.90, -3],
    [490, cubC, camA.x, camA.y, camA.z, -3],
  ];
  const kf = j => monotone(KEYS.map(k => [k[0], j(k)]));
  const KX = kf(k => k[1].x), KY = kf(k => k[1].y), KZ = kf(k => k[1].z), KSX = kf(k => k[2]), KSY = kf(k => k[3]), KLD = kf(k => Math.log(k[4])), KP = kf(k => k[5]);
  function camS4(fr) {
    if (fr >= 490) { aim(cam, C2E.position, 0, (-3 + 3 * ss(seg(fr, 490, 503))) * DEG); return cam; }
    if (fr > 377 && fr < F_LAND) {                         // 镜头跟着墨滴走：滴始终在画面中上部
      const u = ss(seg(fr, 377, F_LAND));
      frameAt(cam, dropAt(fr), lerp(1320, 1250, u), lerp(470, 560, u), Math.exp(lerp(Math.log(0.615), Math.log(0.95), u)), 0, lerp(-10, -3, u) * DEG);
      return cam;
    }
    const q = Math.max(326, fr);
    frameAt(cam, V3(KX(q), KY(q), KZ(q)), KSX(q), KSY(q), Math.exp(KLD(q)), 0, KP(q) * DEG);
    return cam;
  }
  const body = spots.body, dmax = Math.max(...body.map(s => s.d));
  const startF = (s, i) => i === 0 ? F_LAND : i === 1 ? 422 : i === 2 ? 427 : s.f0;
  function spotsS4(fr) {
    const L = [];
    for (const i of wetIdx) {
      const s = body[i], f0 = startF(s, i), op = fr < f0 ? 1 : 1 - ss(seg(fr, f0, f0 + (i === 0 ? 8 : 7)));
      if (op > 0.01) L.push({ ...s, R: s.R * 0.95, mode: 1, prog: 1, op, core: 0 });
    }
    body.forEach((s, i) => {
      const f0 = startF(s, i), b = i === 0 ? 12 : i < 3 ? 8 : 5, tt = i === 0 ? 13 : i < 3 ? 8 : 7;   // 0 号斑：f386 落、晕开 12 帧、收紧 13 帧，f411 定形（17.11 s 不变）
      if (fr < f0) return;
      const prog = fr < f0 + b ? 0.5 * (fr - f0) / b : 0.5 + 0.5 * clamp((fr - f0 - b) / tt);
      const dd = s.d / dmax, core = 0.40 * ss(seg(fr, 446 + 18 * dd, 452 + 18 * dd));
      L.push({ x: s.x, y: s.y, R: s.R, seed: s.seed, sq: s.sq, sqA: s.sqA, mode: i < 3 ? 2.3 : 2, prog: Math.max(prog, 0.001), op: 1, core });
    });
    const sm = ss(seg(fr, 440, 452));
    if (sm > 0) { for (const s of spots.head) L.push({ ...s, mode: 4, prog: sm, op: 0.95, core: 0 }); for (const s of spots.leg) L.push({ ...s, mode: 4, prog: sm, op: 0.95, core: 0 }); }
    L.push(...tailDots(1));
    return L;
  }
  // 手上的雨流与墨渍：2–3 道淡墨细流往指尖汇聚（越长越淡），指尖一块淡心浓边的墨渍随雨褪淡
  function drawHandFx(fr, pal6) {
    const g = handFx.ctx; freshClear(g, 885, 884);
    const lines = aA07.lines;
    const wash = ss(seg(fr, 364, 378));
    const pad = aA07.points.index_pad;
    const stA = 1 - 0.65 * wash;
    g.save(); g.translate(pad[0] + 4, pad[1] - 10); g.rotate(-0.55);
    const gr = g.createRadialGradient(0, 0, 3, 0, 0, 17);
    gr.addColorStop(0, css(pal6[3], 0.35 * stA)); gr.addColorStop(0.65, css(pal6[4], 0.55 * stA)); gr.addColorStop(0.9, css(pal6[5], 0.85 * stA)); gr.addColorStop(1, css(pal6[5], 0));
    g.fillStyle = gr; g.beginPath(); g.ellipse(0, 0, 18, 13, 0, 0, 6.283); g.fill();
    g.strokeStyle = css(pal6[5], 0.6 * stA); g.lineWidth = 1.2;
    for (const rr of [5.5, 9.5, 13]) { g.beginPath(); g.ellipse(1, 1, rr, rr * 0.72, 0, 0.3 + rr * 0.1, 2.4 + rr * 0.12); g.stroke(); }
    g.restore();
    // 返修第 2 轮（v1-06）：雨水顺着手指往下走——一截短而弯的淡墨水痕（上淡下浓、越往下越粗），前头带两三颗水珠；整截随时间往指尖挪，越到后面越淡
    for (const [name, w, f0, sd] of [['index_mid', 5.0, 362, 1], ['middle_mid', 3.8, 366, 2], ['ring_mid', 3.6, 369, 3]]) {
      const pts = lines[name].map(p => [...p]);
      const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const tot = cum[cum.length - 1];
      const at = u => { const d = clamp(u) * tot; let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const k = (d - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-3); return [lerp(pts[i - 1][0], pts[i][0], k), lerp(pts[i - 1][1], pts[i][1], k), Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0])]; };
      const head = ss(seg(fr, f0, f0 + 16)), tail = Math.max(0, head - 0.38);
      if (head <= 0.02) continue;
      const fade = 0.75 * (1 - 0.55 * ss(seg(fr, 380, 392)));
      const seg3 = [];
      for (let j = 0; j <= 14; j++) {
        const u = lerp(tail, head, j / 14), [x, y, a] = at(u), bend = 3.5 * Math.sin(Math.PI * j / 14 + sd) * (1 - j / 14);
        seg3.push([x - Math.sin(a) * bend, y + Math.cos(a) * bend, 0.25 + 0.75 * j / 14]);
      }
      stroke(g, seg3.slice(0, 8), w * 0.75, css(pal6[2], 0.40 * fade), { t0: 12, t1: 2, thinning: 0.6 });
      stroke(g, seg3.slice(6), w, css(pal6[3], 0.62 * fade), { t0: 2, t1: 4, thinning: 0.5 });
      const [hx, hy, ha] = at(head);
      for (let b = 0; b < 3; b++) {                         // 水珠：淡墨小圆 + 一点纸色高光
        const bu = head - 0.035 * b - 0.02 * (b ? hashi(sd * 7 + b) : 0), [bx, by] = at(bu), br = (3.4 - 0.8 * b) * (0.85 + 0.3 * hashi(sd * 11 + b));
        if (bu <= tail) continue;
        g.fillStyle = css(pal6[3], 0.55 * fade); g.beginPath(); g.ellipse(bx + Math.cos(ha + 1.57) * (b - 1) * 3, by + Math.sin(ha + 1.57) * (b - 1) * 3, br, br * 0.85, ha, 0, 6.283); g.fill();
        g.fillStyle = css(pal6[0], 0.70 * fade); g.beginPath(); g.ellipse(bx - br * 0.3, by - br * 0.3, br * 0.32, br * 0.24, 0, 0, 6.283); g.fill();
      }
    }
    handFx.tex.needsUpdate = true;
  }
  function S4(st) {
    const { f, fr, over } = st;
    const c = camS4(fr);
    const k = ss(seg(fr, 444, 490));
    // 第七日：天门右上，0.3 s 内升到位（踩 18.52 s 最大涌起），不与陆蔚重叠
    // f444 起先是山脊后面的一团暖光（日在山后），等陆蔚随拉开移出这一块（f470 后）才升出山脊：日盘全程不和陆蔚重叠
    // 日在 D 600（相当于无穷远，屏幕位置只随机位朝向变）：f444 起从陆蔚右后方的山脊后升起；他挡住的部分就是被挡住（他是实的），
    // 镜头拉开、他往左移时日盘露出来；暖晕 f444 起就在他身后亮开（踩 18.52 s 涌起）
    // 18.52 s 涌起时：雾向两侧滑开、雨停、天边一团暖光在他身后亮起（日还在山后）；镜头拉开、他移到画面中间以后，
    // 日盘才从天门一带升出山脊（f466–f488，踩 19.5 s 次峰），全程不压在他身上
    const su = eo(seg(fr, 444, 451));
    const sun7 = fr >= 443 ? { x: 1445, y: lerp(545, 345, su), op: 0.92 * ss(seg(fr, 443, 447)) } : null;
    const camZ = c.position.z;
    const fo = eo(seg(fr, 444, 462));
    const fo2 = ss(seg(fr, 444, 468));
    const fogMul = { M0: ss(seg(camZ, -3.6, -2.7)), M1: lerp(1, 0.40, fo), M2: lerp(1, 0.40, fo), M4: lerp(1, 0.38, fo), M1a: lerp(1, 0.42, fo), MR: lerp(1, 0.12, fo2) };
    const fogOpen = { M1: 0.30 * fo, M2: 0.26 * fo, MR: 0.13 * fo2 };
    const fogSlide = { M1: 0.095 * fo, M2: 0.085 * fo, M4: 0.04 * fo, MR: 0.12 * fo2 };
    const cd = Math.max(0.2, project(c, cubC).z), scr = IMG_M * FP / cd;
    const near = 1 - ss(seg(cd, 1.5, 5.0));
    const mk = 0.30 * near;
    for (const m of [...rocks, slab, wall]) m.material.uniforms.uMist.value.set(mk, cd + 0.4, cd + 2.2);
    wall.material.uniforms.uDk.value = 1 - 0.80 * near; slab.material.uniforms.uDk.value = 1 - 0.70 * near;   // 近景：虚焦的崖往纸里化（主体背后是亮处）
    moss.forEach(m => m.material.uniforms.uOp.value = (1 - mk) * ss(seg(cd, 1.0, 2.6)));
    const cubLod = fr < 378 ? 1.6 * ss(seg(fr, 350, 362)) : 1.6 * (1 - ss(seg(fr, 378, F_LAND)));
    const amber = mix3(COL.amber, COL.amberB, ss(seg(fr, 446, 460)));
    const f2 = Math.floor(f / 2) * 2;
    // 陆蔚一直留在世界里：整个人出了画右缘才不画（推镜把他"推出"画外，拉开时他自然从画右回来）
    const lb = luScreen(c), luOn = lb.x0 < DW + 50;
    setScene({ ...st, amp: 1, days: null, sun7, deer: false, pine: false, fogMul, fogOpen, fogSlide, ridgeMul: lerp(1, 1.4, eo(seg(fr, 444, 470))),
      spotList: spotsS4(fr), wash: 0.25 * ss(seg(fr, 450, 480)), amber, cubScreenScale: scr, cubLod, blockK: lerp(0.7, 0.36, near), blockW: lerp(0.09, 0.035, near),
      headTurn: -6 * ss(seg(f2, 468, 476)), lu: luOn });
    lu.material.uniforms.uRevT.value = 0;
    // 返修 w3（qa2-09）：拉开时他从画右入画，头几帧只露出衬衫的几笔浓墨轮廓线（看不出是人）：入画时先过一层近雾——
    //   只罩在他身上、靠画右缘最浓，露进画里越多雾越薄（露 240 px 以内全罩，露到 540 px 时散尽）
    const vis = DW - lb.x0;
    lu.material.uniforms.uVeil.value.set(fr >= 400 && fr < 470 ? 0.90 * (1 - ss(seg(vis, 240, 540))) : 0, DW - 460, DW - 40, 0);
    const handOn = fr >= 355 && fr < 436;
    hand.visible = handFx.mesh.visible = handOn;
    if (handOn) {
      const inK = 1 - eo(seg(fr, 355, 364)), outK = ss(seg(fr, 427, 435));
      placeHandWorld(0.30 * inK + 0.6 * outK * outK);
      hand.material.uniforms.uLod.value = 0;
      drawHandFx(fr, st.pal);
    }
    if (over) {
      let dp = null, r = 0, stretch = 1;
      if (fr >= 364 && fr < F_OFF) { dp = TIP.clone(); r = DROP_R * ss(seg(fr, 364, 377)); }
      else if (fr >= F_OFF && fr < F_LAND) { const u = (fr - F_OFF) / (F_LAND - F_OFF); dp = dropAt(fr); r = DROP_R; stretch = 1 + 0.3 * u; }
      if (dp) {
        const pr = project(c, dp);
        if (pr.z > 0.05) drawInkDrop(over, pr.x, pr.y, r * FP / pr.z, stretch, st.pal[5], st.pal[0], 3);
      }
      for (const [fl, si] of [[422, 1], [427, 2]]) {
        if (fr >= fl - 9 && fr < fl) {
          const tgt = imgToWorld(body[si].x, body[si].y), src = tgt.clone().addScaledVector(UP, DROP_H);
          const u = (fr - (fl - 9)) / 9, q = src.lerp(tgt, u * u), pr = project(c, q);
          if (pr.z > 0.05) drawInkDrop(over, pr.x, pr.y, 0.0050 * FP / pr.z, 1 + 0.3 * u, st.pal[5], st.pal[0], 5 + si);
        }
      }
      const rop = 1 - ss(seg(fr, 444, 460));
      if (rop > 0) rain(over, fr, c.position.x - C2.position.x, c.position.y - C2.position.y, rop, RAIN.map(L => ({ ...L, n: Math.round(L.n * 0.65) })));
    }
    return { cam: c, paper: paperAnchor(c), fogK: k, blurSig: 10 * near * (fr < 347 ? 0 : 1) };
  }

  // ───────── 资产参考稿（返修第 2 轮）：按投影机位 CG 渲崖体 / 松枝的素描稿，交给 Magpie 重画成水墨 ─────────
  function guide(renderer, kind) {
    S2({ f: 140, fr: 140, t: 140 / 24, over: null, pal: PAL.cliff, amp: 1 });
    for (const m of [...ridges, ...Object.values(fogs), ...suns, sun7, deer.mesh, cub, lu, hand, handFx.mesh, ...feet, ...moss, wall]) m.visible = false;
    pine.visible = kind === 'pine2';
    for (const m of [...rocks, slab]) {
      m.visible = kind === 'cliff';
      const u = m.material.uniforms; if (!u.uStk) continue; u.uStk.value.x = 0; u.uMass.value.set(0, 0.3, 0, 0); u.uWS.value = 0; u.uSoftQ.value = 1; u.uMist.value.x = 0; u.uFogMul.value = 0;
    }
    renderer.setRenderTarget(null); renderer.setClearColor(new THREE.Color(1, 1, 1), 1); renderer.clear(true, true, true);
    renderer.render(scene, CG);
  }

  return {
    scene, cam, C2, C2E, ridges, fogs, spots, cub, lu, hand, handFx, wetList, setScene, camS2, daysAt, rain, S2, ridgeLineY, ridgePolyline, paperAnchor,
    imgToWorld, CUB_S2, aA01, aA07, mA07, RAIN, FP, S4, camS4, fgMask, luScreen, guide, CG, wall, slab,
    clear: () => U.uPal.value[0],
  };
}

// ───────── 斑点表 ─────────
export function makeSpotTable(alpha, A, nBody = 22, ks = 1) {   // ks：图像素尺度（相对旧 A01 的 992 高）
  const region = A.polys.pattern_region, P0 = A.points.P0_spine_mid, SH = A.points.shoulder;
  const er = 30 * ks;
  const ok = (x, y, poly = region, e = er) => {
    if (!inPoly(x, y, poly) || alpha.at(x, y) < 0.5) return false;
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; if (alpha.at(x + e * Math.cos(a), y + e * Math.sin(a)) < 0.5) return false; }
    return true;
  };
  // 贴边的斑按体侧方向压扁（0.6–0.8）：找最近的 alpha 边，压扁方向 = 指向边的方向
  const squash = (x, y, R) => {
    let best = 1e9, ang = 0;
    for (let k = 0; k < 24; k++) {
      const a = k * Math.PI / 12;
      for (let r = R * 0.6; r < R * 2.6; r += 3) if (alpha.at(x + r * Math.cos(a), y + r * Math.sin(a)) < 0.5) { if (r < best) { best = r; ang = a; } break; }
    }
    if (best > R * 2.4) return { sq: 1, sqA: 0 };
    return { sq: 0.6 + 0.2 * clamp((best - R * 0.6) / (R * 1.8)), sqA: ang };
  };
  const rnd = mulberry(20261104);
  let best = null, bd = 1e9;
  for (let y = P0[1] - 90 * ks; y <= P0[1] + 90 * ks; y += 2) for (let x = P0[0] - 90 * ks; x <= P0[0] + 90 * ks; x += 2) {
    if (!ok(x, y, region, 44 * ks)) continue; const d = Math.hypot(x - P0[0], y - P0[1]); if (d < bd) { bd = d; best = [x, y]; }
  }
  const body = [{ x: best[0], y: best[1], R: 44 * ks, seed: 7, sq: 1, sqA: 0 }];
  const xs = region.map(p => p[0]), ys = region.map(p => p[1]);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  for (let i = 0; i < 12000 && body.length < nBody + 1; i++) {
    const x = bx0 + rnd() * (bx1 - bx0), y = by0 + rnd() * (by1 - by0), R = (23 + 8 * rnd()) * ks;
    if (!ok(x, y, region, 22 * ks)) continue;
    let fine = true;
    for (const s of body) if (Math.hypot(s.x - x, s.y - y) < Math.max(64 * ks, (s.R + R) * 1.18)) { fine = false; break; }
    if (fine) body.push({ x, y, R, seed: 100 + body.length * 7, ...squash(x, y, R) });
  }
  const s0 = body[0];
  const rest = body.slice(1).map(s => ({ ...s, d: Math.hypot(s.x - s0.x, s.y - s0.y) })).sort((a, b) => a.d - b.d);
  const near = rest.slice(0, 6).map(s => ({ s, ds: Math.hypot(s.x - SH[0], s.y - SH[1]) })).sort((a, b) => a.ds - b.ds).slice(0, 2).map(a => a.s);
  const others = rest.filter(s => !near.includes(s));
  const ordered = [{ ...s0, d: 0 }, ...near, ...others];
  const dmax = Math.max(...ordered.map(s => s.d));
  ordered.forEach((s, i) => { s.i = i; s.f0 = i < 3 ? 0 : 415 + 30 * (s.d / dmax) + Math.round((hashi(i * 13 + 5) - 0.5) * 4); });
  const small = (poly, n, r0, r1, dmin, seed) => {
    const out = [], rr = mulberry(seed);
    const px = poly.map(p => p[0]), py = poly.map(p => p[1]);
    for (let i = 0; i < 4000 && out.length < n; i++) {
      const x = Math.min(...px) + rr() * (Math.max(...px) - Math.min(...px)), y = Math.min(...py) + rr() * (Math.max(...py) - Math.min(...py));
      if (!inPoly(x, y, poly) || alpha.at(x, y) < 0.6 || !ok(x, y, poly, 8 * ks)) continue;
      if (out.some(s => Math.hypot(s.x - x, s.y - y) < dmin)) continue;
      out.push({ x, y, R: r0 + (r1 - r0) * rr(), seed: seed + out.length * 3 });
    }
    return out;
  };
  const head = small(A.polys.head_spot_region, 8, 7 * ks, 11 * ks, 24 * ks, 811);
  const leg = small(A.polys.leg_spot_region, 10, 9 * ks, 13 * ks, 28 * ks, 812);
  const tl = A.lines.tail;
  const tailPt = u => { const n = tl.length - 1, x = u * n, i = Math.min(n - 1, Math.floor(x)), k = x - i; return [lerp(tl[i][0], tl[i + 1][0], k), lerp(tl[i][1], tl[i + 1][1], k)]; };
  const tail = [0.30, 0.45, 0.60, 0.74].map((u, i) => { const [x, y] = tailPt(u); return { x: x + (hashi(i * 7 + 1) - 0.5) * 10 * ks, y: y + (hashi(i * 7 + 2) - 0.5) * 8 * ks - 20 * ks, R: (10 + 3 * hashi(i * 7 + 3)) * ks, seed: 900 + i }; });
  return { body: ordered, head, leg, tail };
}

// ───────── 石块：位移扁球，底部压平，按屏幕框摆放 ─────────
export function rockMass({ cx, cy, wpx, hpx, D, sz, seed, cam, amp = 0.18, flat = 0.35, fp = FP }, mat) {
  const g = new THREE.SphereGeometry(1, 192, 128);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 0.72 * fbm3(x * 1.1 + seed, y * 1.3, z * 1.1, seed, 3) + 0.28 * (ridged3(x * 1.8, y * 2.2 + seed, z * 1.8, seed + 1, 2) * 2 - 1)
      + 0.25 * x * (hashi(seed * 7) - 0.5);
    const r = 1 + amp * n;
    let yy = y * r; if (yy < -flat) yy = -flat + (yy + flat) * 0.4;
    p.setXYZ(i, x * r, yy, z * r);
  }
  const hw = wpx / 2 / fp * D, hh = hpx / 2 / fp * D;
  g.scale(hw, hh, sz);
  g.computeVertexNormals(); bakeCavity(g, 4, 2);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(screenToWorld(cam, cx, cy, D));
  bakeTopView(g, m.position, cam, fp, { binPx: 5 });
  m.updateMatrixWorld(true);
  return m;
}
// ───────── 苔点：取几何体顶轮廓上的顶点（aTop 小、朝向相机），成簇；横向扁点（长宽比 1.6–2.4，一端尖），偶尔夹个字点 ─────────
function mossTex(kind) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#000';
  if (kind === 0) {                                     // 扁点：左圆右尖
    g.beginPath(); g.moveTo(14, 32); g.bezierCurveTo(14, 12, 52, 12, 76, 22); g.quadraticCurveTo(100, 30, 120, 34); g.quadraticCurveTo(96, 40, 74, 44); g.bezierCurveTo(50, 54, 14, 52, 14, 32); g.fill();
  } else {                                              // 个字点：三笔短撇
    for (const [x0, y0, x1, y1, w] of [[64, 10, 30, 52, 9], [64, 10, 98, 50, 8], [64, 24, 64, 56, 7]]) { g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(x0, y0); g.lineTo((x0 + x1) / 2, (y0 + y1) / 2); g.lineTo(x1, y1); g.stroke(); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  return t;
}
export function mossDots(scene, cam, sets, seed, fp = FP) {
  const rnd = mulberry(seed);
  const dots = [[], []];
  const camPos = cam.position;
  for (const S of sets) {
    const g = S.mesh.geometry, P = g.attributes.position, Nn = g.attributes.normal, T = g.attributes.aTop;
    S.mesh.updateMatrixWorld(true);
    const M = S.mesh.matrixWorld, NM = new THREE.Matrix3().getNormalMatrix(M);
    const cand = [];
    const stride = Math.max(1, Math.floor(P.count / 60000));
    for (let i = 0; i < P.count; i += stride) {
      if (T.getX(i) > S.topMax) continue;
      const w = V3(P.getX(i), P.getY(i), P.getZ(i)).applyMatrix4(M);
      if (S.yWorldMax !== undefined && w.y > S.yWorldMax) continue;
      const n = V3(Nn.getX(i), Nn.getY(i), Nn.getZ(i)).applyMatrix3(NM).normalize();
      const v = camPos.clone().sub(w).normalize();
      if (n.dot(v) < 0.12) continue;
      const pr = project(cam, w);
      if (pr.x < S.xr[0] || pr.x > S.xr[1] || pr.y > S.yMax || pr.y < 0) continue;
      cand.push({ w, n, pr });
    }
    const centers = [];
    for (let it = 0; it < 4000 && centers.length < S.n && cand.length; it++) {
      const c = cand[Math.floor(rnd() * cand.length)];
      if (centers.some(o => Math.abs(o.pr.x - c.pr.x) < (S.xr[1] - S.xr[0]) / (S.n + 2))) continue;
      centers.push(c);
    }
    for (const c of centers) {
      const near = cand.filter(o => Math.abs(o.pr.x - c.pr.x) < 30 && Math.abs(o.pr.y - c.pr.y) < 10);
      const k = 3 + Math.floor(rnd() * 5);
      for (let j = 0; j < k && near.length; j++) {
        const o = near[Math.floor(rnd() * near.length)];
        const r = (3 + 4 * rnd()) * (rnd() < 0.2 ? 1.6 : 1);
        dots[rnd() < 0.12 ? 1 : 0].push({ w: o.w.clone().addScaledVector(o.n, 0.012), r, z: o.pr.z, ar: 1.6 + 0.8 * rnd(), rot: (rnd() - 0.5) * 50 * DEG, flip: rnd() < 0.5 });
      }
    }
  }
  return [0, 1].map(kind => {
    const mat = needleMat(mossTex(kind), { D0: 0.86, D1: 1.0, lod: 0, fogMul: 1 });
    const list = dots[kind], inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, Math.max(1, list.length));
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion();
    list.forEach((d, i) => {
      const h = 2 * d.r / fp * d.z, w = h * (kind === 0 ? d.ar : 1.4);
      q.copy(cam.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(V3(0, 0, 1), d.rot));
      mtx.compose(d.w, q, V3(w * (d.flip ? -1 : 1), h * (kind === 0 ? 1 : 1.1), 1)); inst.setMatrixAt(i, mtx);
    });
    if (!list.length) inst.visible = false;
    inst.renderOrder = 9; inst.frustumCulled = false; scene.add(inst);
    return inst;
  });
}
