// 朱红白文印：不规则方印 + 印文（Ma Shan Zheng）反白 + 边缘印泥残缺 + 细小白点。每方印画一次缓存成画布。
import { mulberry, vnoise } from '/core/lib.js';
export const VERM = [190, 58, 46];   // #BE3A2E
// 个别字形替换：字体里写法不对的字（如「莲」）用预先拼好的 alpha 字形图（600×600，字号 400 的 em 居中）代替 fillText
const OVR = new Map();
export function glyphOverride(ch, img) { OVR.set(ch, img); }

// 印文排布：竖排、自右向左；返回 [列数, 每列字数]
function layout(n) {
  if (n <= 1) return [[1]];
  if (n === 2) return [[1], [1]];
  if (n === 3) return [[2], [1]];
  if (n === 4) return [[2], [2]];
  if (n === 5) return [[2], [2], [1]];
  if (n === 6) return [[2], [2], [2]];
  if (n === 7) return [[3], [2], [2]];
  if (n === 8) return [[4], [4]];
  return [[3], [3], [3]];
}

export function makeSeal(text, w, h, seed = 1, o = {}) {
  const chars = [...text], R = mulberry(seed * 7919 + 13);
  const pad = Math.ceil(Math.max(w, h) * .12);
  const cv = document.createElement('canvas'); cv.width = Math.ceil(w + pad * 2); cv.height = Math.ceil(h + pad * 2);
  const c = cv.getContext('2d'); c.translate(pad, pad);
  // 印面：略不规整的四边形，四角微圆
  const jit = Math.min(w, h) * .016, N = 44;
  c.beginPath();
  for (let i = 0; i < N; i++) {
    const t = i / N * 4, side = Math.floor(t), u = t - side;
    let px, py; if (side === 0) { px = u * w; py = 0; } else if (side === 1) { px = w; py = u * h; } else if (side === 2) { px = w - u * w; py = h; } else { px = 0; py = h - u * h; }
    px += (vnoise(seed * 3.1 + i * 1.7) - .5) * jit * 2; py += (vnoise(seed * 5.3 + 40 + i * 1.7) - .5) * jit * 2;
    i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.closePath(); c.fillStyle = `rgb(${VERM.join(',')})`; c.fill();
  // 印文反白
  c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000';
  const cols = layout(chars.length).map(a => a[0]);
  const nc = cols.length, rowsMax = Math.max(...cols);
  const mx = w * (o.margin ?? .1), my = h * (o.margin ?? .1);
  const cw = (w - mx * 2) / nc, ch = (h - my * 2) / rowsMax;
  const fs = Math.min(cw, ch) * (o.fill ?? 1.02);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  let k = 0;
  for (let ci = 0; ci < nc; ci++) {
    const n = cols[ci], colX = w - mx - cw * (ci + .5);
    const chh = (h - my * 2) / n;              // 本列每字的格高（字少的列把字拉开）
    for (let r = 0; r < n; r++) {
      const chr = chars[k++]; if (!chr) continue;
      const cy = my + chh * (r + .5);
      const sy = Math.min(1.35, chh / fs);     // 字少的列略拉长字形，印文常见做法
      c.save(); c.translate(colX, cy); c.scale(1, n < rowsMax ? Math.min(sy, 1.3) : 1);
      if (OVR.has(chr)) { const k = fs * 1.5; c.drawImage(OVR.get(chr), -k / 2, -k / 2 + fs * .04, k, k); }
      else { c.font = `${fs}px MaShanZheng`; c.fillText(chr, 0, fs * .04); }
      c.restore();
    }
  }
  // 白文印的边框线（留一圈朱边）——用细白线勾内框
  c.lineWidth = Math.max(1.2, Math.min(w, h) * .018);
  c.strokeStyle = '#000'; c.globalAlpha = .9;
  const ib = Math.min(w, h) * .055;
  c.strokeRect(ib, ib, w - ib * 2, h - ib * 2);
  c.globalAlpha = 1;
  // 印泥不匀：小白点与边缘残缺
  for (let i = 0; i < 90; i++) {
    const a = R(), b = R(), rr = Math.min(w, h) * (.004 + .014 * R() * R());
    c.globalAlpha = .35 + .6 * R(); c.beginPath(); c.arc(a * w, b * h, rr, 0, 7); c.fill();
  }
  for (let i = 0; i < 9; i++) {      // 边缘缺口
    const side = Math.floor(R() * 4), u = R(), rr = Math.min(w, h) * (.02 + .045 * R());
    const px = side === 0 ? u * w : side === 1 ? w : side === 2 ? u * w : 0, py = side === 0 ? 0 : side === 1 ? u * h : side === 2 ? h : u * h;
    c.globalAlpha = .55 + .45 * R(); c.beginPath(); c.ellipse(px, py, rr * (1 + R()), rr, R() * 3, 0, 7); c.fill();
  }
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  return { cv, pad, w, h };
}
