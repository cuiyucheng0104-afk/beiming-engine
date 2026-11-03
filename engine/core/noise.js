// 北冥引擎 · 单纯形噪声（2D / 3D），由一个确定性随机函数打乱置换表。
// 用法：const n = createNoise3D(mulberry(7)); n(x, y, z) → 约 [-1, 1]
// 同一个种子永远给出同一张噪声场，所以墨线抖动、斑驳纹理在每次重渲时都逐帧一致。

const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3, G3 = 1 / 6;

// 12 个梯度方向：立方体各棱的中点
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

// 0..255 的置换表（从前往后的 Fisher–Yates 洗牌），复制一遍省去取模
function permutation(random) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 0; i < 255; i++) {
    const j = i + Math.floor(random() * (256 - i));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512), g = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; g[i] = (perm[i] % 12) * 3; }
  return { perm, g };
}

export function createNoise2D(random = Math.random) {
  const { perm, g } = permutation(random);
  const corner = (x, y, gi) => {
    const t = 0.5 - x * x - y * y;
    if (t < 0) return 0;
    const t2 = t * t;
    return t2 * t2 * (GRAD3[gi] * x + GRAD3[gi + 1] * y);
  };
  return (x, y) => {
    const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s);
    const u = (i + j) * G2, x0 = x - (i - u), y0 = y - (j - u);
    const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    return 70 * (
      corner(x0, y0, g[ii + perm[jj]]) +
      corner(x1, y1, g[ii + i1 + perm[jj + j1]]) +
      corner(x2, y2, g[ii + 1 + perm[jj + 1]]));
  };
}

export function createNoise3D(random = Math.random) {
  const { perm, g } = permutation(random);
  const corner = (x, y, z, gi) => {
    const t = 0.6 - x * x - y * y - z * z;
    if (t < 0) return 0;
    const t2 = t * t;
    return t2 * t2 * (GRAD3[gi] * x + GRAD3[gi + 1] * y + GRAD3[gi + 2] * z);
  };
  return (x, y, z) => {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const u = (i + j + k) * G3;
    const x0 = x - (i - u), y0 = y - (j - u), z0 = z - (k - u);
    // 落在单纯形的哪一块：按坐标大小排序决定第二、三个角
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const ii = i & 255, jj = j & 255, kk = k & 255;
    return 32 * (
      corner(x0, y0, z0, g[ii + perm[jj + perm[kk]]]) +
      corner(x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3, g[ii + i1 + perm[jj + j1 + perm[kk + k1]]]) +
      corner(x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3, g[ii + i2 + perm[jj + j2 + perm[kk + k2]]]) +
      corner(x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3, g[ii + 1 + perm[jj + 1 + perm[kk + 1]]]));
  };
}
