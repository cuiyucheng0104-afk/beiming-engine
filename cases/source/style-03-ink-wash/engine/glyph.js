// 骨架书写：把 OFL 毛笔字体（Ma Shan Zheng）只当"骨架"——栅格化 → Zhang-Suen 细化取中心线 → 距离场给笔压 →
// 按"先上后下、先左后右"排笔序，沿中心线用笔刷引擎逐笔写出（藏锋入笔、出锋收），最后用略扩的字形轮廓收边。
import { mk, draw, TONE } from './ink.js';
import { clamp } from '/core/lib.js';

const R = 192;                       // 骨架栅格
const cache = {};

function raster(ch) {
  const cv = document.createElement('canvas'); cv.width = cv.height = R;
  const c = cv.getContext('2d');
  c.font = `${R * .9}px MaShanZheng`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#000';
  const m = c.measureText(ch), y = R / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  c.fillText(ch, R / 2, y);
  const d = c.getImageData(0, 0, R, R).data, B = new Uint8Array(R * R);
  for (let i = 0; i < R * R; i++) B[i] = d[i * 4 + 3] > 110 ? 1 : 0;
  return { B, y };
}
// 3-4 倒角距离变换
function dist(B) {
  const D = new Float32Array(R * R).fill(1e9);
  for (let i = 0; i < R * R; i++) if (!B[i]) D[i] = 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= R || y >= R) ? 0 : D[y * R + x];
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) { const i = y * R + x; if (!D[i]) continue; D[i] = Math.min(D[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4); }
  for (let y = R - 1; y >= 0; y--) for (let x = R - 1; x >= 0; x--) { const i = y * R + x; if (!D[i]) continue; D[i] = Math.min(D[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4); }
  for (let i = 0; i < R * R; i++) D[i] /= 3;
  return D;
}
function thin(B0) {
  const B = Uint8Array.from(B0); let ch = true;
  const g = (x, y) => (x < 0 || y < 0 || x >= R || y >= R) ? 0 : B[y * R + x];
  while (ch) {
    ch = false;
    for (let pass = 0; pass < 2; pass++) {
      const del = [];
      for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
        if (!B[y * R + x]) continue;
        const p = [g(x, y - 1), g(x + 1, y - 1), g(x + 1, y), g(x + 1, y + 1), g(x, y + 1), g(x - 1, y + 1), g(x - 1, y), g(x - 1, y - 1)];
        const n = p.reduce((a, b) => a + b, 0); if (n < 2 || n > 6) continue;
        let A = 0; for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) A++;
        if (A !== 1) continue;
        if (pass === 0 ? (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) : (p[0] * p[2] * p[6] || p[0] * p[4] * p[6])) continue;
        del.push(y * R + x);
      }
      for (const i of del) B[i] = 0; if (del.length) ch = true;
    }
  }
  return B;
}
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
function paths(S) {
  const on = (x, y) => x >= 0 && y >= 0 && x < R && y < R && S[y * R + x];
  const deg = (x, y) => NB.reduce((a, [dx, dy]) => a + (on(x + dx, y + dy) ? 1 : 0), 0);
  const used = new Set(), key = (x, y, a, b) => `${x},${y}>${a},${b}`;
  const isNode = (x, y) => deg(x, y) !== 2;
  const out = [];
  const walk = (x, y, nx, ny) => {
    const P = [[x, y]]; let px = x, py = y, cx = nx, cy = ny;
    used.add(key(px, py, cx, cy)); used.add(key(cx, cy, px, py));
    for (let guard = 0; guard < 2000; guard++) {
      P.push([cx, cy]);
      if (isNode(cx, cy)) break;
      let moved = false;
      for (const [dx, dy] of NB) {
        const qx = cx + dx, qy = cy + dy;
        if (!on(qx, qy) || (qx === px && qy === py) || used.has(key(cx, cy, qx, qy))) continue;
        used.add(key(cx, cy, qx, qy)); used.add(key(qx, qy, cx, cy)); px = cx; py = cy; cx = qx; cy = qy; moved = true; break;
      }
      if (!moved) break;
    }
    return P;
  };
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    if (!on(x, y) || !isNode(x, y)) continue;
    for (const [dx, dy] of NB) { const qx = x + dx, qy = y + dy; if (on(qx, qy) && !used.has(key(x, y, qx, qy))) out.push(walk(x, y, qx, qy)); }
  }
  // 纯环（无端点）
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    if (!on(x, y)) continue;
    for (const [dx, dy] of NB) { const qx = x + dx, qy = y + dy; if (on(qx, qy) && !used.has(key(x, y, qx, qy))) out.push(walk(x, y, qx, qy)); }
  }
  return out;
}
const plen = P => P.reduce((a, p, i) => i ? a + Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1]) : 0, 0);

// 一个字 → 有序笔画（字格 0..1 坐标 + 半宽）
// 手工笔路：细化骨架对笔画多的字会碎成几十段（「鹤」38 段），这类字按笔顺手写中心线。
// 点：[x, y, 半宽]（字格 0..1）；起笔略轻（藏锋），撇、钩的末端半宽收小（出锋）。
const HAND = {
  '鹤': [
    [[.365, .09, .02], [.372, .13, .03], [.37, .168, .028]],                                             // 丶
    [[.212, .19, .024], [.186, .25, .03], [.162, .33, .022]],                                            // 冖 左点
    [[.222, .19, .022], [.3, .184, .027], [.4, .18, .03], [.462, .198, .03], [.474, .232, .024], [.455, .256, .014]],   // 冖 横钩
    [[.335, .232, .024], [.302, .32, .03], [.25, .42, .03], [.18, .53, .026], [.11, .62, .012]],        // 亻 撇
    [[.266, .47, .024], [.261, .56, .03], [.256, .68, .03], [.252, .8, .022]],                          // 亻 竖
    [[.392, .36, .02], [.41, .39, .03], [.42, .418, .024]],                                              // 隹 点
    [[.31, .432, .022], [.38, .43, .028], [.462, .428, .022]],                                           // 隹 横
    [[.402, .435, .026], [.4, .52, .03], [.395, .62, .03], [.39, .7, .024]],                            // 隹 竖
    [[.31, .532, .022], [.36, .522, .028], [.425, .518, .02]],                                           // 隹 横
    [[.31, .61, .022], [.36, .6, .028], [.432, .588, .02]],                                              // 隹 横
    [[.24, .735, .024], [.3, .726, .03], [.385, .716, .024]],                                            // 隹 底横
    [[.625, .145, .022], [.595, .22, .03], [.545, .31, .028], [.5, .385, .012]],                        // 鸟 撇
    [[.665, .236, .022], [.71, .23, .028], [.746, .252, .03], [.742, .33, .03], [.735, .41, .026], [.69, .435, .022], [.64, .43, .012]],   // 鸟 横折钩
    [[.632, .328, .018], [.66, .345, .03], [.684, .362, .018]],                                          // 鸟 点
    [[.586, .352, .024], [.576, .45, .03], [.565, .565, .03], [.68, .566, .03], [.8, .564, .03], [.83, .625, .03], [.83, .7, .028], [.805, .785, .024], [.755, .83, .016], [.71, .842, .01]],   // 竖折折钩
    [[.4, .712, .022], [.5, .705, .03], [.6, .696, .026], [.665, .69, .014]],                            // 鸟 横
  ],
};

export function skeleton(ch) {
  if (cache[ch]) return cache[ch];
  if (HAND[ch]) return (cache[ch] = HAND[ch]);
  const { B } = raster(ch), D = dist(B), S = thin(B);
  let ps = paths(S).filter(P => plen(P) > 5);
  // 方向：横画左→右，其余上→下（撇自右上起）
  ps = ps.map(P => {
    const a = P[0], b = P[P.length - 1], dx = b[0] - a[0], dy = b[1] - a[1];
    const flip = Math.abs(dx) > Math.abs(dy) * 1.6 ? dx < 0 : dy < 0;
    return flip ? P.slice().reverse() : P;
  });
  // 笔序：按起笔的"行"（上下）再按左右
  ps.sort((P, Q) => { const a = P[0], b = Q[0]; const ra = Math.round(Math.min(a[1], P[P.length - 1][1]) / 21), rb = Math.round(Math.min(b[1], Q[Q.length - 1][1]) / 21); return ra - rb || a[0] - b[0]; });
  const strokes = ps.map(P => {
    const pts = [];
    for (let i = 0; i < P.length; i += 3) pts.push(P[i]);
    if ((P.length - 1) % 3) pts.push(P[P.length - 1]);
    return pts.map(([x, y]) => [x / R, y / R, Math.max(1.2, D[y * R + x]) / R]);
  });
  return (cache[ch] = strokes);
}

// 字形轮廓蒙版（略扩，收边用）
const maskC = {};
function glyphMask(ch, size) {
  const k = ch + size; if (maskC[k]) return maskC[k];
  const cv = document.createElement('canvas'); cv.width = cv.height = Math.ceil(size * 1.2);
  const c = cv.getContext('2d'), o = size * .1;
  c.font = `${size * .9}px MaShanZheng`; c.textAlign = 'center'; c.textBaseline = 'middle';
  const m = c.measureText(ch), y = size / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  c.fillStyle = '#000'; c.fillText(ch, o + size / 2, o + y);
  c.strokeStyle = '#000'; c.lineWidth = size * .035; c.lineJoin = 'round'; c.strokeText(ch, o + size / 2, o + y);
  return (maskC[k] = { cv, o });
}

// 写一个字：dst = 目标层（世界变换已设），T = 临时层；box = [x, y, size]（世界坐标），p = 0..1 书写进度，z = 屏幕缩放
export function write(dst, T, ch, box, p, xf, o = {}) {
  if (p <= 0) return;
  const [x0, y0, S] = box, st = skeleton(ch);
  const { s, tx, ty } = xf;
  for (const c of [T.cw, T.cd]) { c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.clearRect(0, 0, T.W, T.H); c.setTransform(s, 0, 0, s, tx, ty); }
  const lens = st.map(P => plen(P.map(q => [q[0] * 100, q[1] * 100])) + 6), tot = lens.reduce((a, b) => a + b, 0);
  let acc = 0;
  st.forEach((P, i) => {
    const a = acc / tot, b = (acc + lens[i]) / tot; acc += lens[i];
    const u = clamp((p - a) / (b - a)); if (u <= 0) return;
    const meanW = P.reduce((q, r) => q + r[2], 0) / P.length;
    const pts = P.map((q, j) => [x0 + q[0] * S, y0 + q[1] * S, clamp(q[2] / meanW, .45, 1.6) * (j === 0 ? .8 : 1)]);
    // 实心墨芯：沿中心线一笔圆头粗线（保证笔画连贯，飞白纹理由上面的笔刷给）
    // 墨芯随笔压变粗细（起笔顿、行笔匀、出锋收尖），逐段画
    const c = T.cd, m = Math.max(2, Math.ceil(pts.length * u));
    c.save(); c.globalAlpha = .82; c.strokeStyle = '#000'; c.lineCap = 'round'; c.lineJoin = 'round';
    for (let j = 1; j < Math.min(m, pts.length); j++) { c.lineWidth = meanW * 3.1 * S * (pts[j - 1][2] + pts[j][2]) / 2; c.beginPath(); c.moveTo(pts[j - 1][0], pts[j - 1][1]); c.lineTo(pts[j][0], pts[j][1]); c.stroke(); }
    c.restore();
    draw(T.ink, mk(pts, { w: meanW * 3.6 * S, tone: TONE.jiao, dry: o.dry ?? .05, wet: .3, prof: 'even', rough: .05, nb: 40, solid: true, seed: (o.seed ?? 7) * 100 + i, per: 4 }), u, 1);
  });
  // 收边：略扩的字形轮廓（屏幕空间）
  const M = glyphMask(ch, S * s);
  for (const key of ['cw', 'cd']) {
    const c = T[key]; c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'destination-in';
    c.drawImage(M.cv, x0 * s + tx - M.o, y0 * s + ty - M.o);
    c.globalCompositeOperation = 'source-over';
  }
  for (const key of ['cw', 'cd']) { const d = key === 'cw' ? dst.wet : dst.dry; d.save(); d.setTransform(1, 0, 0, 1, 0, 0); d.globalAlpha = o.am ?? 1; d.drawImage(T[key === 'cw' ? 'wet' : 'dry'], 0, 0); d.restore(); }
}

// 白文印的字线：印文用手工设计的方折篆意笔画（字格 0..1），不用毛笔字骨架——印文要方、直、匀才认得出。
// 格子 (x0, y0) 起、宽 w、高 h；线宽 lw 不随格子拉伸（竖横一样粗）
const SEALG = {
  '墨': [
    [[.12, .36], [.12, .04], [.88, .04], [.88, .36]], [[.12, .36], [.88, .36]],      // 黑：上框
    [[.28, .11], [.4, .25]], [[.72, .11], [.6, .25]], [[.5, .04], [.5, .56]],        // 框内两点、中竖
    [[.2, .46], [.8, .46]], [[.04, .56], [.96, .56]],
    [[.16, .64], [.13, .71]], [[.38, .64], [.37, .71]], [[.62, .64], [.63, .71]], [[.84, .64], [.87, .71]],   // 灬
    [[.24, .82], [.76, .82]], [[.5, .74], [.5, .96]], [[.06, .96], [.94, .96]],      // 土
  ],
  '戏': [
    [[.04, .22], [.4, .22], [.06, .9]], [[.14, .46], [.44, .92]],                    // 又
    [[.46, .36], [.98, .32]], [[.6, .04], [.66, .5], [.96, .94], [.98, .8]],          // 戈：横、斜钩
    [[.9, .52], [.5, .88]], [[.82, .06], [.92, .16]],                                // 撇、点
  ],
};
export function sealLines(c, ch, x0, y0, w, h, lw) {
  c.lineCap = 'square'; c.lineJoin = 'miter'; c.lineWidth = lw;
  const G = SEALG[ch];
  if (G) { for (const P of G) { c.beginPath(); P.forEach(([u, v], i) => { const X = x0 + u * w, Y = y0 + v * h; i ? c.lineTo(X, Y) : c.moveTo(X, Y); }); c.stroke(); } return; }
  const st = skeleton(ch);
  for (const P of st) { c.beginPath(); P.forEach((q, i) => { const X = x0 + q[0] * w, Y = y0 + q[1] * h; i ? c.lineTo(X, Y) : c.moveTo(X, Y); }); c.stroke(); }
}
