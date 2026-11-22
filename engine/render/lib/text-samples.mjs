// 渲染旁注与离线 QA 用相同的字框、字体数据与像素对比度。
import fs from 'node:fs';
import path from 'node:path';

export function normalizeItem(t, W, H) {
  if (!t || typeof t !== 'object') return null;
  const text = t.text == null ? '' : String(t.text);
  let box = null;
  if (Array.isArray(t.box) && t.box.length === 4 && t.box.every(Number.isFinite)) box = [t.box[0], t.box[1], t.box[0] + t.box[2], t.box[1] + t.box[3]];
  else if ([t.x0, t.y0, t.x1, t.y1].every(Number.isFinite)) box = [t.x0, t.y0, t.x1, t.y1];
  if (!box) return { bad: true, text };
  return { id: t.id != null ? String(t.id) : text, text, box, alpha: Number.isFinite(t.alpha) ? t.alpha : null, font: typeof t.font === 'string' ? t.font : null, W, H };
}
const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const area = b => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

export function loadFaceBytes(face, origin, root) {
  if (face.bin) return Buffer.from(face.bin, 'base64');
  const src = face.src || '';
  if (/^\s*local\(/i.test(src) && !/url\(/i.test(src)) return { local: true };
  const m = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(src);
  if (!m) return null;
  let u;
  try { u = new URL(m[2], face.base || origin + '/'); } catch { return null; }
  if (u.protocol === 'data:') {
    const i = u.href.indexOf(',');
    return /;base64/i.test(u.href.slice(0, i)) ? Buffer.from(decodeURIComponent(u.href.slice(i + 1)), 'base64') : Buffer.from(decodeURIComponent(u.href.slice(i + 1)), 'latin1');
  }
  if (u.origin !== origin) return { external: u.href };
  const file = path.join(root, decodeURIComponent(u.pathname));
  if (!file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file)) return { missing: u.pathname };
  return fs.readFileSync(file);
}

const lin = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (d, i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const pctl = (arr, p) => { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };

// 同一帧「照常」与「关掉文字」两张图里，按方框算文字对比度（两张图都按 sRGB 解码成 WCAG 相对亮度）：
//   方框内差值 ≥ 0.5×P99 的像素是字的笔画核心；方框向外扩 max(4 px, 0.3×字高) 的范围里、差值 < max(6, 0.1×P99) 的像素是字周围
//   没被改动的背景；两者之间（抗锯齿边、辉光）两边都不算。字取笔画核心亮度的 P75（亮字）/ P25（暗字），
//   背景取对字不利的一侧四分位（亮字取背景 P75、暗字取 P25），按 WCAG 公式求比值。
//   背景按「照常」那张图取：字后面的半透明底板、描边、暗晕都算进背景（它们本来就是为可读性画的）。
export function measureContrast(on, off, box) {
  const W = on.width, H = on.height;
  const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(W, Math.ceil(box[2])), y1 = Math.min(H, Math.ceil(box[3]));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const pad = Math.max(4, Math.round(0.3 * (y1 - y0)));
  const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad), X1 = Math.min(W, x1 + pad), Y1 = Math.min(H, y1 + pad);
  const diffAt = i => Math.max(Math.abs(on.data[i] - off.data[i]), Math.abs(on.data[i + 1] - off.data[i + 1]), Math.abs(on.data[i + 2] - off.data[i + 2]));
  const inner = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) inner.push(diffAt((y * W + x) * 4));
  const top = pctl(inner, 0.99);
  const hi = Math.max(24, 0.5 * top), lo = Math.max(6, 0.1 * top);
  const fg = [], bg = [];
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const i = (y * W + x) * 4, d = diffAt(i);
    const inBox = x >= x0 && x < x1 && y >= y0 && y < y1;
    if (inBox && d >= hi) fg.push(lum(on.data, i));
    else if (d < lo) bg.push(lum(on.data, i));
  }
  if (fg.length < Math.max(12, 0.004 * inner.length) || bg.length < 12) return { separable: false, fgPixels: fg.length, bgPixels: bg.length };
  const bright = pctl(fg, 0.5) >= pctl(bg, 0.5);
  const Lf = bright ? pctl(fg, 0.75) : pctl(fg, 0.25);
  const Lb = bright ? pctl(bg, 0.75) : pctl(bg, 0.25);
  return { separable: true, ratio: +ratio(Lf, Lb).toFixed(2), fg: +Lf.toFixed(4), bg: +Lb.toFixed(4), fgPixels: fg.length, bgPixels: bg.length, textIs: bright ? 'lighter' : 'darker' };
}

// 取画字不透明度、字框、字体的规则由页面探针与离线判定共用。
export function sampleTextItems(s, derived, W, H) {
  let items;
  if (!derived) items = (s.texts || []).map(t => normalizeItem(t, W, H)).filter(Boolean);
  else {
    const merged = new Map();
    for (const r of [...s.runs.filter(x => x.attached && x.box), ...s.dom]) {
      if (!r.text.trim()) continue;
      const k = r.text.trim();
      const m = merged.get(k);
      if (m) { m.box = [Math.min(m.box[0], r.box[0]), Math.min(m.box[1], r.box[1]), Math.max(m.box[2], r.box[2]), Math.max(m.box[3], r.box[3])]; m.alpha = Math.max(m.alpha, r.alpha ?? 1); }
      else merged.set(k, { id: k, text: k, box: [...r.box], alpha: r.alpha ?? 1, font: r.font });
    }
    items = [...merged.values()];
  }
  return items.map(it => {
    if (it.bad) return it;
    // 探针给出同一帧里落在方框内、文字相同的画字调用：取它们的最大不透明度与字体
    const runs = s.runs.filter(r => r.box && (r.text === it.text || (it.text.includes(r.text) && r.text.trim().length > 0)) && (!r.attached || overlap(r.box, it.box) > 0.3 * Math.min(area(r.box), area(it.box) || 1)));
    const alpha = it.alpha ?? (runs.length ? Math.max(...runs.map(r => r.alpha ?? 1)) : null);
    const font = it.font || runs.find(r => !r.filter)?.font || runs[0]?.font || null;
    return { ...it, alpha, font };
  });
}
