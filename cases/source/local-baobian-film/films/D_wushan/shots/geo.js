// 《豹变》D 雾山 · 程序几何：崖面、平台、岩块、山脊高度场、松（加载时用固定种子算好，渲染时不再变）
import * as THREE from 'three';
import { createNoise2D, createNoise3D } from '/engine/core/noise.js';
import { mulberry } from '/engine/core/math.js';

export const N2 = createNoise2D(mulberry(11));
export const N3 = createNoise3D(mulberry(13));
const N2b = createNoise2D(mulberry(17));
export const fbm2 = (x, y, oct = 4, n = N2) => { let s = 0, a = .5, f = 1; for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); f *= 2.03; a *= .5; } return s; };
const ridged = (x, y) => 1 - Math.abs(N2b(x, y));
const h1 = k => { let h = (k | 0) * 374761393 + 668265263; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return (h >>> 0) / 4294967296; };

// 崖面的走向：x_face(z)。南段向西弯近镜头、北段向东退远，围出平台所在的"湾"
export function xFace(z) {
  const n = 1 / (1 + Math.exp((z + 3) / 2));
  return (-3 - z) * 0.45 * n;
}
// 洞口（崖面上的椭圆凹进）
export const CAVE = { z: -1.5, y: 1.7, w: 4.2, h: 3.5 };
// 崖面上一点的外凸量（米，正 = 向西凸出）
function cliffDisp(y, z) {
  let d = fbm2(z * .035, y * .035, 2) * 4;
  const k = Math.floor(y / 2.8 + .6 * N2(z * .05, y * .02));
  d += (h1(k * 31 + 7) - .5) * .7;                                   // 岩层台阶
  d += ridged(z * .32, y * .035) * .7;                                // 竖向沟槽（竖皴的体积版）
  d += fbm2(z * .6 + 40, y * .6, 2) * .12;
  // 上部向东后仰（陡坡），从高处俯看能看到山体
  d -= Math.max(y - 22, 0) * .28;
  // 洞口：椭圆内向东推进 0–5 m
  const ex = (z - CAVE.z) / (CAVE.w / 2), ey = (y - CAVE.y) / (CAVE.h / 2), er = Math.hypot(ex, ey);
  if (er < 1.25) { const t = 1 - Math.min(1, Math.max(0, (er - .55) / .7)); d -= 5 * t * t * (3 - 2 * t); }
  return d;
}
export function cliffFace({ z0 = -130, z1 = 40, y0 = -115, y1 = 170, nz = 220, ny = 300 } = {}) {
  const pos = [], idx = [];
  for (let j = 0; j <= ny; j++) {
    const y = y0 + (y1 - y0) * j / ny;
    for (let i = 0; i <= nz; i++) {
      const z = z0 + (z1 - z0) * i / nz;
      pos.push(xFace(z) - cliffDisp(y, z), y, z);
    }
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nz; i++) {
    const a = j * (nz + 1) + i, b = a + 1, c = a + nz + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);   // 法线朝 -x（西）
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// 平台：从洞口向西伸出的岩台。回转体（顶面平、口沿圆、侧壁陡、底部收进）+ 角向噪声的不规则外缘 + 侧壁岩层台阶
export function platform() {
  const prof = [];
  const R = 1;
  const pts = [[0, 0], [.55, 0], [.86, -.005], [.95, -.03], [.99, -.09], [1.0, -.2], [.985, -.45], [.96, -.75], [.9, -1.05], [.78, -1.4], [.6, -1.75], [.38, -2.1], [.15, -2.45], [0, -2.6]];
  for (const [r, y] of pts.slice().reverse()) prof.push(new THREE.Vector2(r * R, y));   // 自下而上：法线朝外
  // 细分剖面，让侧壁有足够的段数
  const curve = new THREE.SplineCurve(prof);
  const g = new THREE.LatheGeometry(curve.getPoints(60), 160);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = Math.hypot(v.x, v.z), a = Math.atan2(v.z, v.x);
    const ca = Math.cos(a), sa = Math.sin(a);
    // 外缘：低频大起伏 + 中频碎口
    const edge = 1 + fbm2(ca * 1.1 + 4, sa * 1.1, 3) * .32 + fbm2(ca * 4.5, sa * 4.5 + 2, 2) * .06;
    let rr = r * edge;
    let y = v.y;
    if (y < -.15) {
      // 侧壁：几道平缓的岩层（只沿高度变化）+ 低频起伏
      const band = Math.sin((y + 3) * 6.5 + N2(ca * 2, sa * 2) * 1.5);
      rr *= 1 + .022 * Math.max(band, 0) + N2(a * 2.5, y * 1.2) * .04;
    }
    // 顶面微起伏、西端下垂
    let x = ca * rr, z = sa * rr;
    const X = x * 4.3 - 3.0, Z = z * 4.1 + .3;
    if (y > -.02) y += fbm2(X * .8, Z * .8, 2) * .05 - .3 * Math.max(0, Math.min(1, (-5.8 - X) / 1.6)) ** 2;
    p.setXYZ(i, X, y * 1.5, Z);
  }
  g.computeVertexNormals();
  return g;
}
// 岩块（Icosahedron 细分后沿法线位移）
//   smooth > 0（返修 1）：着色法线往球面法线靠（低通），两阶交界不再沿三角形的棱分色
export function rock(seed = 1, detail = 3, amp = .22, { smooth = 0 } = {}) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position, v = new THREE.Vector3();
  const off = seed * 7.13;
  const sph = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    sph[i * 3] = v.x; sph[i * 3 + 1] = v.y; sph[i * 3 + 2] = v.z;
    const n = N3(v.x * 1.3 + off, v.y * 1.3, v.z * 1.3) * .6 + N3(v.x * 3.1, v.y * 3.1 + off, v.z * 3.1) * .25;
    const strata = (h1(Math.floor(v.y * 2.5 + off) * 17) - .5) * .12;
    v.multiplyScalar(1 + amp * n + strata);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  if (smooth > 0) {
    const nn = g.attributes.normal, a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let i = 0; i < nn.count; i++) { a.fromBufferAttribute(nn, i); b.set(sph[i * 3], sph[i * 3 + 1], sph[i * 3 + 2]).normalize(); a.lerp(b, smooth).normalize(); nn.setXYZ(i, a.x, a.y, a.z); }
    nn.needsUpdate = true;
  }
  return g;
}
// 山脊高度场：宽 w、深 d（米），主峰高 hmax；沿 x 无缝重复时 seamless = true
export function ridgeField({ w = 1400, d = 320, nx = 240, nz = 60, hmax = 90, freq = .004, seed = 1, falloff = true } = {}) {
  const g = new THREE.PlaneGeometry(w, d, nx, nz);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const o = seed * 37.1;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    let h = 0, a = 1, f = freq;
    for (let k = 0; k < 4; k++) { h += a * (1 - Math.abs(N2b(x * f + o, z * f * 1.3 + o * .5))); f *= 2.1; a *= .45; }
    h = Math.pow(h / 1.8, 2.2) * hmax;
    // 前后两端压低（像一道脊）
    if (falloff) { const t = Math.abs(z) / (d / 2); h *= 1 - Math.pow(t, 2.5); }
    p.setY(i, h);
  }
  g.computeVertexNormals();
  return g;
}
// 草坡：缓坡噪声
export function meadowField({ w = 420, d = 320, nx = 80, nz = 60 } = {}) {
  const g = new THREE.PlaneGeometry(w, d, nx, nz);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setY(i, fbm2(x * .01 + 3, z * .01, 3) * 6 + fbm2(x * .05, z * .05 + 7, 2) * 1.2); }
  g.computeVertexNormals();
  return g;
}
// 松：弯折的干 + 层层平展的针叶团（扇贝边）
export function pineTree({ seed = 1, h = 6, lean = [0.5, 0, -0.3], clumps = 9, spread = 2.2 } = {}) {
  const r = mulberry(seed * 101 + 7);
  const pts = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    pts.push(new THREE.Vector3(lean[0] * h * t * t + (r() - .5) * .5 * t, h * t, lean[2] * h * t * t + (r() - .5) * .5 * t));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const trunk = new THREE.TubeGeometry(curve, 40, .28 * h / 6, 8, false);
  // 半径从下往上收细
  { const p = trunk.attributes.position, n = 40 + 1, ring = 8 + 1;
    for (let i = 0; i < n; i++) { const t = i / 40, c = curve.getPoint(t), s = 1 - .82 * t; for (let k = 0; k < ring; k++) { const j = i * ring + k; const v = new THREE.Vector3().fromBufferAttribute(p, j).sub(c).multiplyScalar(s).add(c); p.setXYZ(j, v.x, v.y, v.z); } }
    trunk.computeVertexNormals(); }
  const leaves = [];
  for (let k = 0; k < clumps; k++) {
    const t = .45 + .55 * (k / Math.max(1, clumps - 1));
    const c = curve.getPoint(Math.min(1, t));
    const ang = r() * Math.PI * 2, rad = spread * (.3 + .7 * r()) * (1.1 - .5 * t);
    const s = new THREE.SphereGeometry(1, 18, 10);
    const sp = s.attributes.position, v = new THREE.Vector3();
    const sx = 1.8 * (.7 + .6 * r()) * h / 6, sy = .38 * h / 6, sz = 1.2 * (.7 + .6 * r()) * h / 6;
    for (let i = 0; i < sp.count; i++) {
      v.fromBufferAttribute(sp, i);
      const a = Math.atan2(v.z, v.x);
      const scal = 1 + .16 * Math.sin(a * 7 + k) + .1 * N3(v.x * 2 + k, v.y * 2, v.z * 2);   // 扇贝边
      v.set(v.x * sx * scal, v.y * sy * (v.y < 0 ? .55 : 1), v.z * sz * scal);
      v.x += c.x + Math.cos(ang) * rad; v.y += c.y + (r() - .5) * .2; v.z += c.z + Math.sin(ang) * rad;
      sp.setXYZ(i, v.x, v.y, v.z);
    }
    s.computeVertexNormals();
    leaves.push(s);
  }
  return { trunk, leaves };
}
// 豹背曲面（#10 背景、#11）：球面的一块，细分 128×96，缩放成 (sx, sy, sz) 米，沿脊线微隆
export function backPatch({ sx = .30, sy = .14, sz = .52, cap = .75 } = {}) {
  const g = new THREE.SphereGeometry(1, 160, 72, 0, Math.PI * 2, 0, Math.PI * cap);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) * sx, y = p.getY(i) * sy, z = p.getZ(i) * sz;
    p.setXYZ(i, x, y + .012 * Math.exp(-Math.pow(x / .05, 2)), z);
  }
  g.computeVertexNormals();
  return g;
}
// 洞口暗拱：在参考相机前围一圈（内缘 = 不规则的超椭圆开口，外缘出画），深度带起伏，toon 着色后内缘吃边光
//   s2w(x, y, D)：设计像素 + 深度 → 世界坐标；open = [cx, cy, 左半宽, 右半宽, 上半高, 下半高]
export function archMesh(s2w, { open = [960, 535, 735, 735, 400, 400], D = 1.45, NA = 200, NR = 16, seed = 3 } = {}) {
  const pos = [], idx = [];
  const [cx, cy, wl, wr, ht, hb] = open;
  for (let j = 0; j <= NR; j++) {
    const u = j / NR;
    for (let i = 0; i <= NA; i++) {
      const th = i / NA * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      const ne = 3.2, r = 1 / Math.pow(Math.pow(Math.abs(c), ne) + Math.pow(Math.abs(s), ne), 1 / ne);
      const n1 = fbm2(c * 1.4 + seed, s * 1.4, 3) * .08 + fbm2(c * 5 + 3, s * 5 + seed, 2) * .022;
      const k = r * (1 + n1 * (1 - u * .6)) * (1 + u * u * 1.6 + u * .25);
      const x = cx + c * (c < 0 ? wl : wr) * k, y = cy + s * (s < 0 ? ht : hb) * k;
      const dd = D * (1 - .28 * u) * (1 + fbm2(c * 2.2 + 9, s * 2.2 + u * 1.5, 3) * .22);
      const w = s2w(x, y, dd);
      pos.push(w.x, w.y, w.z);
    }
  }
  for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
    const a = j * (NA + 1) + i, b = a + 1, c2 = a + NA + 1, d = c2 + 1;
    idx.push(a, c2, b, b, c2, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// 草坡：一道横着的缓丘（脊线沿局部 x），脊高 hy，两侧向下落进雾里
// 返修 2：四边改成圆缓地落下去（原来是平顶陡壁的"台子"，俯看像一块方盒子）；导出高度函数，坡上的松、鹿按它落脚
export function hillHeight(x, z, { len = 84, dep = 50, hy = 12, seed = 2 } = {}) {
  const u = x / (len / 2), w = z / (dep / 2);
  const crest = 1 - Math.min(1, Math.abs(w) * (w < 0 ? 1.1 : 1.6));
  const ends = 1 - Math.pow(Math.min(1, Math.abs(u)), 3);
  let y = hy * Math.pow(Math.max(crest, 0), 1.4) * ends + fbm2(x * .03 + seed, z * .05, 3) * 3 * ends - hy * .9 - 26 * Math.pow(Math.min(1, Math.hypot(u, w * .8)), 4);
  return y + fbm2(x * .12, z * .12 + seed, 2) * .6;
}
export function hillField({ len = 84, dep = 50, hy = 12, nx = 110, nz = 50, seed = 2, uvSide = null } = {}) {
  const g = new THREE.PlaneGeometry(len, dep, nx, nz);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const y = hillHeight(x, z, { len, dep, hy, seed });
    p.setY(i, y);
    // 侧面投影的贴图坐标：草坡身上贴底板里绿黄的山腰笔触
    if (uvSide) uv.setXY(i, uvSide.u0 + (x / len + .5) * uvSide.du, uvSide.v0 + Math.max(0, Math.min(1, (y + 14) / 16)) * (uvSide.v1 - uvSide.v0));
  }
  g.computeVertexNormals();
  return g;
}
// 圆顶山峰（云海里冒出来的中景峰）：几个高斯包叠成的圆头山体 + 竖向折皱，顶部圆、山脚宽、山脚是圆的（不是方形面片的直边）
//   返修 1：着色法线用低通后的高度场（只含大形和折皱），细碎的 ridged 只进几何剪影（≤ 0.8 m），
//          峰顶 0.75H 以上细节再乘 0.3，不再长针尖；两阶交界不会沿三角形的边分色
export function peakField({ w = 120, d = 90, nx = 110, nz = 90, H = 70, seed = 1, uvSide = null } = {}) {
  const g = new THREE.PlaneGeometry(w, d, nx, nz);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const r = mulberry(seed * 31 + 5);
  // 返修 2：鼓包加宽（半径 0.24–0.32 w），峰顶是浑圆的山头，不再是一簇细高的尖
  const bumps = [...Array(4)].map((_, i) => ({ x: (r() - .5) * w * .42, z: (r() - .5) * d * .3, R: w * (i === 0 ? .3 : .2 + .1 * r()), h: H * (i === 0 ? 1 : .5 + .35 * r()) }));
  const hs = new Float32Array(p.count), hd = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    // 几个高斯包做"软并集"（log-sum-exp），相接处是圆的，不出折痕
    let es = 0, hm = 0;
    const hb = bumps.map(b => { const dx = x - b.x, dz = z - b.z, q = (dx * dx + dz * dz) / (b.R * b.R); return b.h * Math.exp(-q * .75); });
    for (const v of hb) { es += Math.exp(v * .12); hm = Math.max(hm, v); }
    const h = Math.max(hm, Math.log(es) / .12 - Math.log(bumps.length) / .12 * .35);
    // 竖向肋：沿方位角的平滑余弦（9 道左右，相位被低频噪声打乱），山腰最深、峰顶和山脚为 0——
    //   光沿着肋走，就是顺坡的竖皴；是平滑的起伏，不是折痕，所以不出针尖、不出三角面
    const az = Math.atan2(z - bumps[0].z, x - bumps[0].x);
    const ph = 2.2 * N2(Math.cos(az) * 1.3 + seed, Math.sin(az) * 1.3 + 2.7);
    const rib = .5 + .5 * Math.cos(9 * az + ph + seed);
    const mid = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, h / H * .92))), .8);
    const fold = 1 - .11 * rib * mid;
    // 圆形山脚：从 55% 半径往外落进云海
    const rad = Math.hypot(x / (w / 2), z / (d / 2));
    const foot = 45 * Math.pow(Math.max(0, (rad - .55) / .45), 2);
    const sm = h * fold + fbm2(x * .03, z * .03 + seed, 2) * 1.6 - foot;
    const det = fbm2(x * .08, z * .08 + seed, 3) * .45 * (1 - .7 * Math.min(1, Math.max(0, (h / H - .6) / .25)));
    hs[i] = sm; hd[i] = sm + det;
  }
  for (let i = 0; i < p.count; i++) p.setY(i, hs[i]);
  g.computeVertexNormals();
  for (let i = 0; i < p.count; i++) p.setY(i, hd[i]);
  p.needsUpdate = true;
  // 返修 2：侧面投影的贴图坐标（给"把南山底板的笔触贴到山上"用）：u 沿 x，v 沿高度（峰顶 → 底板山脊下沿，山脚 → 山腰）
  if (uvSide) {
    const uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i);
      uv.setXY(i, uvSide.u0 + (x / w + .5 + z / d * .18) * uvSide.du, uvSide.v0 + Math.max(0, Math.min(1, hd[i] / H)) * (uvSide.v1 - uvSide.v0)); }
    uv.needsUpdate = true;
  }
  return g;
}
// 崖顶岩台（#13）：顶面是 y = Y 的平台，远边（崖沿）沿 A → B 一条锯齿线，崖沿外侧是往下的崖壁（带岩层台阶）
//   A、B：崖沿两端（世界坐标），toward：从崖沿指向镜头一侧的水平单位向量，depth：顶面往镜头一侧延伸多远
//   返修 1：顶面朝镜头一侧分 3 道岩层台阶往下落（ref_03 的层理），返回 lips（每道台阶唇口的折线，给金线用）；
//          崖沿上加几处凸起和断口（剪影不再是一条直线）；崖壁永远在崖沿内侧（不再翻出一块浅金色的"棚子"）
export function ledgeSlab(A, B, toward, { Y = .27, depth = 9, drop = 7, nu = 200, nv = 90, nd = 30, seed = 3 } = {}) {
  const pos = [], idx = [];
  const ab = new THREE.Vector3().subVectors(B, A), L = ab.length(); ab.normalize();
  const edge = u => (fbm2(u * L * .45 + seed, 1.3, 3) * .55 + fbm2(u * L * 1.7, 7.7, 2) * .18);   // 崖沿的进退（米）
  // 崖沿剪影：几块凸起的岩头、两处断口（高度，米）
  const crest = u => {
    let h = 0;
    for (const [c, w, a] of [[.18, .03, .16], [.31, .018, .09], [.52, .025, -.12], [.63, .04, .2], [.82, .02, -.1], [.9, .035, .13]]) h += a * Math.exp(-Math.pow((u - c) / w, 2));
    return h + fbm2(u * L * 2.4, 3.3, 2) * .03;
  };
  // 岩层台阶：v 方向（崖沿 0 → 镜头 1）三道，台阶线沿 u 起伏；每道往下落 0.10–0.14 m
  const STEPS = [[.045, .16], [.1, .14], [.17, .18]];
  const stepV = (k, u) => STEPS[k][0] + fbm2(u * L * .35 + k * 7.1, 4.4 + k, 2) * .05;
  const topY = (u, v) => {
    let y = Y;
    for (let k = 0; k < STEPS.length; k++) { const sv = stepV(k, u); y -= STEPS[k][1] * Math.min(1, Math.max(0, (v - sv) / .012)); }
    return y + crest(u) * Math.max(0, 1 - v / .1);
  };
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, e = edge(u);
      const p = A.clone().addScaledVector(ab, u * L).addScaledVector(toward, e + v * v * depth);
      p.y = topY(u, v * v) + fbm2(p.x * .7, p.z * .7, 2) * .03;
      pos.push(p.x, p.y, p.z);
    }
  }
  // 崖壁：d 0（崖沿）→ 1（往下 drop 米），台阶；只往崖沿内侧（远离镜头的一侧）退，不往镜头一侧凸
  const base = (nv + 1) * (nu + 1);
  for (let j = 0; j <= nd; j++) {
    const d = j / nd;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, e = edge(u);
      const step = Math.max(0, Math.floor(d * 5 + N2(u * 6, 2)) / 5);
      const off = Math.min(e - .02, e - .35 * step - .15 * d + N2(u * L * .9, d * 4) * .12);
      const p = A.clone().addScaledVector(ab, u * L).addScaledVector(toward, off);
      p.y = Y + crest(u) * (1 - d) - d * drop;
      pos.push(p.x, p.y, p.z);
    }
  }
  const quad = (a, b, c, d) => idx.push(a, c, b, b, c, d);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i; quad(a, a + 1, a + nu + 1, a + nu + 2); }
  for (let j = 0; j < nd; j++) for (let i = 0; i < nu; i++) { const a = base + j * (nu + 1) + i; quad(a + nu + 1, a + nu + 2, a, a + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  // 台阶唇口折线（世界坐标，金线用）：每道台阶上沿
  g.userData.lips = STEPS.map((_, k) => { const pts = []; for (let i = 0; i <= 120; i++) { const u = i / 120, e = edge(u), sv = stepV(k, u); const vv = Math.sqrt(Math.max(0, sv - .002));
    const q = A.clone().addScaledVector(ab, u * L).addScaledVector(toward, e + vv * vv * depth); q.y = topY(u, sv - .002) + .006; pts.push(q); } return pts; });
  g.userData.crestY = u => Y + crest(u);
  return g;
}
