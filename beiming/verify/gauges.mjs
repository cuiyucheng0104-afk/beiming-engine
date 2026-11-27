// 第 4 级灯光与图案节点的形状量具：都是纯函数，输入是行主序的浮点图（RGB 三个数一像素、法线 XYZ 三个数一像素）与
// 同尺寸的掩膜（Uint8Array，非 0 是选中），不读文件、不读阈值。判多少算过由调用方照阈值文件（floor-gate.json 的 level4）定。
// 量法是写这几个量具时定的，口径写在各函数的注释里；chassis/level4.mjs 拿核心 16 个种子的均值对参考包的收敛图量。
//   高光掩膜        亮度大于峰值的 fraction 倍（默认一半）的像素；峰值只在 region 里取（不给 region 是整幅）
//   掩膜 IoU        交集 ÷ 并集；两个都空记 null（量不出，不算过）
//   半影宽          region 里亮度落在「受光水平」的 lo 到 hi 倍之间的像素数；受光水平取 region 里亮度的 95 百分位
//   法线角度剖面    带状区：region 里参考法线离开「主平面法线」超过 bandDeg 的像素（圆角与棱边那一圈）；主平面法线是
//                   邻域里几乎不变的那些参考法线聚成的几个方向。剖面误差：带状区里核心法线与参考法线夹角（度）的均方根
//   高光带宽        带状区（外扩 1 像素）里落在高光掩膜里的像素数
//   勾线掩膜        region 里反照率的亮度小于 region 里反照率 95 百分位的 fraction 倍（默认一半）的像素

/** Rec.709 亮度 */
export const luma = (rgb, i) => 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];

const count = (m) => { let n = 0; for (let i = 0; i < m.length; i++) if (m[i]) n++; return n; };
const pixels = (rgb) => rgb.length / 3;
const inRegion = (region, i) => !region || region[i] !== 0;

/** 若干张同尺寸浮点图逐元素的均值 */
export function meanImage(images) {
  const out = new Float64Array(images[0].length);
  for (const im of images) for (let i = 0; i < out.length; i++) out[i] += im[i];
  for (let i = 0; i < out.length; i++) out[i] /= images.length;
  return out;
}

/** 物体编号图里属于这些编号、且覆盖率为 1 的像素 */
export function entityMask(ids, coverage, entities) {
  const m = new Uint8Array(ids.length);
  for (let i = 0; i < ids.length; i++) m[i] = entities.includes(ids[i]) && (!coverage || coverage[i] === 1) ? 1 : 0;
  return m;
}

/** 分位数（q 在 [0, 1]），只取 region 里的像素的亮度；region 里没有像素时返回 0 */
export function regionQuantile(rgb, region, q) {
  const v = [];
  for (let i = 0; i < pixels(rgb); i++) if (inRegion(region, i)) v.push(luma(rgb, i));
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
}

/** 高光掩膜：亮度大于 region 里峰值的 fraction 倍 */
export function highlightMask(rgb, { fraction = 0.5, region = null } = {}) {
  const n = pixels(rgb);
  let peak = 0;
  for (let i = 0; i < n; i++) if (inRegion(region, i)) peak = Math.max(peak, luma(rgb, i));
  const m = new Uint8Array(n);
  if (peak > 0) for (let i = 0; i < n; i++) m[i] = inRegion(region, i) && luma(rgb, i) > fraction * peak ? 1 : 0;
  return m;
}

/** 两个掩膜的 IoU；两个都空返回 null */
export function maskIoU(a, b) {
  if (a.length !== b.length) throw new TypeError('maskIoU：两个掩膜的大小不同');
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) union++; }
  return union ? inter / union : null;
}

/** 半影宽（像素数）：region 里亮度在受光水平（95 百分位）的 lo 到 hi 倍之间的像素 */
export function penumbraWidth(rgb, region, { lo = 0.1, hi = 0.9 } = {}) {
  const lit = regionQuantile(rgb, region, 0.95);
  let n = 0;
  for (let i = 0; i < pixels(rgb); i++) {
    if (!inRegion(region, i)) continue;
    const y = luma(rgb, i);
    if (y > lo * lit && y < hi * lit) n++;
  }
  return n;
}

const unit = (v, i) => { const x = v[3 * i], y = v[3 * i + 1], z = v[3 * i + 2], l = Math.hypot(x, y, z); return l > 0 ? [x / l, y / l, z / l] : null; };
const angleDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;

/**
 * 带状区：region 里参考法线离开所有主平面法线都超过 bandDeg 的像素。主平面法线：3×3 邻域（都在 region 里）里与中心夹角都不到
 * flatDeg 的「平」像素，按夹角 < clusterDeg 贪心聚成的方向（每类取第一个像素的法线）。没有平像素时带状区是空的
 */
export function bevelBand(normals, w, h, region, { flatDeg = 0.5, clusterDeg = 2, bandDeg = 2 } = {}) {
  const dirs = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!inRegion(region, i)) continue;
      const c = unit(normals, i);
      if (!c) continue;
      let flat = true;
      for (let dy = -1; dy <= 1 && flat; dy++) {
        for (let dx = -1; dx <= 1 && flat; dx++) {
          const j = i + dy * w + dx;
          const n = inRegion(region, j) ? unit(normals, j) : null;
          if (!n || angleDeg(c, n) >= flatDeg) flat = false;
        }
      }
      if (flat && !dirs.some((d) => angleDeg(d, c) < clusterDeg)) dirs.push(c);
    }
  }
  const band = new Uint8Array(w * h);
  if (!dirs.length) return { band, planes: 0 };
  for (let i = 0; i < w * h; i++) {
    if (!inRegion(region, i)) continue;
    const n = unit(normals, i);
    if (n && dirs.every((d) => angleDeg(d, n) > bandDeg)) band[i] = 1;
  }
  return { band, planes: dirs.length };
}

/** 法线角度剖面误差：带状区里核心法线与参考法线夹角的均方根（度）；带状区空时返回 null */
export function normalAngleRms(core, ref, band) {
  let s = 0, n = 0;
  for (let i = 0; i < band.length; i++) {
    if (!band[i]) continue;
    const a = unit(core, i), b = unit(ref, i);
    if (!a || !b) continue;
    const d = angleDeg(a, b);
    s += d * d;
    n++;
  }
  return n ? Math.sqrt(s / n) : null;
}

/** 掩膜外扩 r 个像素（方形邻域） */
export function dilate(mask, w, h, r = 1) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w) out[yy * w + xx] = 1;
      }
    }
  }
  return out;
}

/** 高光带宽（像素数）：带状区外扩 1 像素之后落在高光掩膜里的像素 */
export function highlightBand(highlight, band, w, h) {
  const zone = dilate(band, w, h, 1);
  let n = 0;
  for (let i = 0; i < zone.length; i++) if (zone[i] && highlight[i]) n++;
  return n;
}

/** 勾线掩膜：region 里反照率亮度小于 region 里反照率 95 百分位的 fraction 倍 */
export function lineMask(albedo, region, { fraction = 0.5 } = {}) {
  const top = regionQuantile(albedo, region, 0.95);
  const m = new Uint8Array(pixels(albedo));
  if (top > 0) for (let i = 0; i < m.length; i++) m[i] = inRegion(region, i) && luma(albedo, i) < fraction * top ? 1 : 0;
  return m;
}

/** 相对差 |a − b| / b；b 为 0 时：a 也是 0 记 0，否则 null */
export const relDiff = (a, b) => (b === 0 ? (a === 0 ? 0 : null) : Math.abs(a - b) / b);

export { count as maskCount };

/** mask 里两张法线图夹角超过 deg 度的像素数（两边都有法线的才算）：{ count, total } */
export function normalMismatch(a, b, mask, deg) {
  let count = 0, total = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = unit(a, i), q = unit(b, i);
    if (!p || !q) continue;
    total++;
    if (angleDeg(p, q) > deg) count++;
  }
  return { count, total };
}
