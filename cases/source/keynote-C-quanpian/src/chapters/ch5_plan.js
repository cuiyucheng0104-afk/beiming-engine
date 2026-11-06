// 第五章 合作城 · 城市平面（纯数据，不依赖 three；node 里也能跑，用来查碰撞、出俯视图）。
// 街道 = 一个「谈」字的十笔（第七章从上空看拼成「谈」，ARCH §11.6 的约定）；建筑只盖在笔画以外的地块上。
// 坐标：世界 x（右）、z（朝镜头），单位米。书摊平后：近半页 z ∈ [−.137, .137]（跨页 7 的地面页），
// 远半页 z ∈ [−.413, −.143]（第 6 页的背面，向远处有 4.7° 的坡），书脊 z = −.14（两页之间的折缝，建筑不跨缝）。
export const ZH = -.14;
export const NEAR = { x0: -.232, x1: .232, z0: -.131, z1: .134 };
export const FAR = { x0: -.232, x1: .232, z0: -.405, z1: -.149 };
// 「谈」字框：x ∈ [−.20, .20]、z ∈ [−.40, 0]（100 × 100 个单位，单位 4 mm）；前沿 z 0 → .137 留给广场
const UX = -.20, UZ = -.40, US = .004;
export const u2w = (u, v) => [UX + u * US, UZ + v * US];
export const TAN_BOX = { x0: UX, z0: UZ, x1: UX + 100 * US, z1: UZ + 100 * US, size: 100 * US };
export const STREET_W = .032;                                  // 街宽 3.2 cm（笔画宽 8 个单位）
// 十笔（书写顺序；单位坐标，v 向下 = 朝镜头）
export const STROKES_U = [
  { id: '讠·点', p: [[10, 10], [19, 22]] },
  { id: '讠·横折提', p: [[3, 40], [17, 40], [17, 82], [27, 72]] },
  { id: '上火·左点', p: [[44, 14], [49, 28]] },
  { id: '上火·右点', p: [[90, 10], [83, 26]] },
  { id: '上火·撇', p: [[66, 2], [66, 24], [42, 46]] },
  { id: '上火·点', p: [[68, 28], [94, 46]] },
  { id: '下火·左点', p: [[42, 62], [47, 78]] },
  { id: '下火·右点', p: [[92, 58], [84, 76]] },
  { id: '下火·撇', p: [[66, 52], [66, 76], [36, 99]] },
  { id: '下火·捺', p: [[68, 78], [99, 99]] },
];
export const STROKES = STROKES_U.map(s => ({ id: s.id, p: s.p.map(([u, v]) => u2w(u, v)) }));

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, u = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const qx = ax + u * dx - px, qz = az + u * dz - pz; return Math.sqrt(qx * qx + qz * qz);
}
export function streetDist(x, z) {
  let d = 1e9; for (const s of STROKES) for (let i = 0; i < s.p.length - 1; i++) d = Math.min(d, segDist(x, z, s.p[i][0], s.p[i][1], s.p[i + 1][0], s.p[i + 1][1]));
  return d;
}
// 有方向的矩形（中心 cx,cz，宽 w 沿本地 x，深 d 沿本地 z，绕 y 转 ang：本地 +z → (sin ang, cos ang)）
export function rectPts(r, n = 6) {
  const out = [], c = Math.cos(r.ang || 0), s = Math.sin(r.ang || 0);
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const lx = (i / n - .5) * r.w, lz = (j / n - .5) * r.d; out.push([r.cx + lx * c + lz * s, r.cz - lx * s + lz * c]); }
  return out;
}
export const inRect = (r, x, z, pad = 0) => { const c = Math.cos(r.ang || 0), s = Math.sin(r.ang || 0), dx = x - r.cx, dz = z - r.cz; const lx = dx * c - dz * s, lz = dx * s + dz * c; return Math.abs(lx) <= r.w / 2 + pad && Math.abs(lz) <= r.d / 2 + pad; };
const half = z => z > ZH ? 'near' : 'far';
export function rectOK(r, { street = STREET_W / 2 + .004, reserved = [] } = {}) {
  const pts = rectPts(r); const h0 = half(pts[0][1]);
  for (const [x, z] of pts) {
    const H = half(z); if (H !== h0) return false; const B = H === 'near' ? NEAR : FAR;
    if (x < B.x0 || x > B.x1 || z < B.z0 || z > B.z1) return false;
    if (streetDist(x, z) < street) return false;
    for (const q of reserved) if (inRect(q, x, z, .003)) return false;
  }
  return true;
}

// —— 主角建筑（手摆）：三家店、广场门楼。ang 让门脸朝向街道 ——
const LEG = STROKES[8].p;                                       // 下火·撇：(.064,−.096) 拐点 → (−.056,−.004) 出口
const legDir = (() => { const [a, b] = [LEG[1], LEG[2]], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); return [dx / L, dz / L, L]; })();
const LEG_N = [legDir[1], -legDir[0]];                          // 法线：指向东南（街道这一侧看过去，店在西北侧，门脸朝东南）
function onLeg(s, back, w, d) {                                 // 撇画第 s 段（0 拐点 → 1 出口），往西北退 back
  const [a] = [LEG[1]]; const px = a[0] + legDir[0] * legDir[2] * s, pz = a[1] + legDir[1] * legDir[2] * s;
  return { cx: px + LEG_N[0] * back * -1, cz: pz + LEG_N[1] * back * -1, w, d, ang: Math.atan2(LEG_N[0], LEG_N[1]) };
}
const S10 = STROKES[9].p, s10Dir = (() => { const dx = S10[1][0] - S10[0][0], dz = S10[1][1] - S10[0][1], L = Math.hypot(dx, dz); return [dx / L, dz / L, L]; })();
const S10_N = [s10Dir[1], -s10Dir[0]];                          // 捺画的法线：指向西南（朝街），店在东北侧
function onS10(s, back, w, d) {
  const px = S10[0][0] + s10Dir[0] * s10Dir[2] * s, pz = S10[0][1] + s10Dir[1] * s10Dir[2] * s;
  const n = S10_N[1] > 0 ? S10_N : [-S10_N[0], -S10_N[1]];       // 取朝 +z 的一侧
  return { cx: px - n[0] * back, cz: pz - n[1] * back, w, d, ang: Math.atan2(n[0], n[1]) };
}
export const SHOPS = {
  coffee: { ...onLeg(.84, STREET_W / 2 + .007 + .016, .062, .032), name: '咖啡店', h: .046 },
  tea: { ...onS10(.8, STREET_W / 2 + .007 + .013, .06, .026), name: '茶饮店', h: .05 },
  book: { cx: .066, cz: -.2335, w: .064, d: .029, ang: 0, name: '书店', h: .05 },
};
export const GATE = { cx: .07, cz: .0215, w: .186, d: .017, ang: 0, h: .1 };                    // 广场门楼：门脸朝 +z
export const PLAZA = { x0: -.035, x1: .175, z0: .034, z1: .134 };
export const BANNER = { x: .07, z: .095 };                                                       // 标题纸条立在广场中央
export const RESERVED = [
  SHOPS.coffee, SHOPS.tea, SHOPS.book, { ...GATE, d: .02 },
  { cx: (PLAZA.x0 + PLAZA.x1) / 2, cz: (PLAZA.z0 + PLAZA.z1) / 2, w: PLAZA.x1 - PLAZA.x0 + .02, d: PLAZA.z1 - PLAZA.z0 + .02, ang: 0 },
  { cx: SHOPS.coffee.cx + LEG_N[0] * .03, cz: SHOPS.coffee.cz + LEG_N[1] * .03, w: .07, d: .02, ang: SHOPS.coffee.ang },   // 店前人行道 + 小桌
  { cx: SHOPS.book.cx, cz: SHOPS.book.cz + .022, w: .07, d: .016, ang: 0 },
];
export const LEG_INFO = { dir: legDir, n: LEG_N };
// 店前的取景通道：不种树、不盖楼（镜头停在店前时，前景干净，说明纸条不被挡）
export const CORRIDORS = Object.values(SHOPS).map(s => ({ cx: s.cx + Math.sin(s.ang) * (s.d / 2 + .05), cz: s.cz + Math.cos(s.ang) * (s.d / 2 + .05), w: .16, d: .1, ang: s.ang }));

// —— 普通建筑：5 mm 网格上贪心摆放（种子随机，结果固定）——
export function mulb(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function genCity(seed = 5) {
  const R = mulb(seed), C = .005, blds = [], trees = [];
  const cands = [];
  for (const B of [NEAR, FAR]) for (let x = B.x0 + C; x < B.x1; x += C) for (let z = B.z0 + C; z < B.z1; z += C) cands.push([x, z]);
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
  const sizes = [[.034, .03], [.03, .028], [.028, .024], [.026, .026], [.024, .02], [.02, .02], [.018, .016], [.016, .014]];
  const taken = r => blds.some(b => { const dx = Math.abs(b.cx - r.cx), dz = Math.abs(b.cz - r.cz); return dx < (b.w + r.w) / 2 + .0045 && dz < (b.d + r.d) / 2 + .0045; });
  for (const [x, z] of cands) {
    if (streetDist(x, z) < STREET_W / 2 + .006) continue;
    for (const [w0, d0] of sizes) {
      const sw = R() < .5, w = sw ? d0 : w0, d = sw ? w0 : d0, r = { cx: x, cz: z, w, d, ang: 0 };
      if (taken(r)) continue;
      if (!rectOK(r, { reserved: [...RESERVED, ...CORRIDORS] })) continue;
      blds.push(r); break;
    }
  }
  // 树：贴着街道的空地（行道树）+ 零星的小公园
  for (let k = 0; k < 2400 && trees.length < 150; k++) {
    const B = R() < .62 ? NEAR : FAR, x = B.x0 + R() * (B.x1 - B.x0), z = B.z0 + R() * (B.z1 - B.z0);
    const sd = streetDist(x, z); if (sd < STREET_W / 2 + .0035 || sd > STREET_W / 2 + .03) continue;
    if (blds.some(b => inRect(b, x, z, .005)) || RESERVED.some(q => inRect(q, x, z, .004)) || CORRIDORS.some(q => inRect(q, x, z, .004)) || trees.some(t => Math.hypot(t.x - x, t.z - z) < .011)) continue;
    trees.push({ x, z, kind: Math.floor(R() * 5), s: .8 + R() * .45 });
  }
  return { blds, trees };
}
