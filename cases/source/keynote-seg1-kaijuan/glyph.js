// 字形当骨架的笔顺书写：把 OFL 字体（Ma Shan Zheng / Noto Serif SC）栅格化 → 距离场（笔画粗细）→ Zhang–Suen 细化得到中心线
// → 拆成笔段、在交叉处把方向相近的笔段接成一笔 → 按"先上后下、先左后右、横先于竖"排序 → 写的时候沿中心线推进一支圆笔，
// 只露出字形内部（字形是骨架，墨迹不越出字形）。结果有笔顺感，字的结构和重心仍是书法字体本身。
import { clamp } from '/core/lib.js';

const cache = new Map();

export function makeGlyph(ch, font, size) {
  const key = ch + '|' + font + '|' + size;
  if (cache.has(key)) return cache.get(key);
  const N = Math.ceil(size * 1.5) | 0;
  const cv = document.createElement('canvas'); cv.width = cv.height = N;
  const c = cv.getContext('2d');
  c.font = font.replace('{S}', size + 'px'); c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = '#000'; c.fillText(ch, N / 2, N / 2);
  const id = c.getImageData(0, 0, N, N).data;
  const B = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) B[i] = id[i * 4 + 3] > 100 ? 1 : 0;
  // 距离场（chamfer 3-4）
  const D = new Float32Array(N * N);
  const INF = 1e9;
  for (let i = 0; i < N * N; i++) D[i] = B[i] ? INF : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= N || y >= N) ? 0 : D[y * N + x];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = y * N + x; if (!B[i]) continue; D[i] = Math.min(D[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4); }
  for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) { const i = y * N + x; if (!B[i]) continue; D[i] = Math.min(D[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4); }
  for (let i = 0; i < N * N; i++) D[i] /= 3;
  // Zhang–Suen 细化
  const S = B.slice();
  const g = (x, y) => (x < 0 || y < 0 || x >= N || y >= N) ? 0 : S[y * N + x];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const del = [];
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
        if (!S[y * N + x]) continue;
        const p2 = g(x, y - 1), p3 = g(x + 1, y - 1), p4 = g(x + 1, y), p5 = g(x + 1, y + 1), p6 = g(x, y + 1), p7 = g(x - 1, y + 1), p8 = g(x - 1, y), p9 = g(x - 1, y - 1);
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]; let a = 0; for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) a++;
        if (a !== 1) continue;
        if (pass === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
        del.push(y * N + x);
      }
      if (del.length) { changed = true; for (const i of del) S[i] = 0; }
    }
  }
  // 骨架图：端点 / 交叉点 / 笔段
  const nb = (x, y) => { const r = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && g(x + dx, y + dy)) r.push([x + dx, y + dy]); return r; };
  const deg = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (S[y * N + x]) deg[y * N + x] = nb(x, y).length;
  const isNode = i => deg[i] !== 2;
  const seen = new Uint8Array(N * N);
  const segs = [];
  const walk = (sx, sy, nx, ny) => {
    const pts = [[sx, sy]]; let px = sx, py = sy, x = nx, y = ny;
    for (let guard = 0; guard < N * 8; guard++) {
      pts.push([x, y]);
      const i = y * N + x;
      if (isNode(i)) break;
      seen[i] = 1;
      const nx2 = nb(x, y).filter(([a, b]) => !(a === px && b === py) && !(seen[b * N + a] && !isNode(b * N + a)));
      if (!nx2.length) break;
      // 优先直邻
      nx2.sort((p, q) => (Math.abs(p[0] - x) + Math.abs(p[1] - y)) - (Math.abs(q[0] - x) + Math.abs(q[1] - y)));
      px = x; py = y; [x, y] = nx2[0];
    }
    return pts;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x; if (!S[i] || !isNode(i)) continue;
    for (const [a, b] of nb(x, y)) {
      const j = b * N + a;
      if (isNode(j)) { if (j > i) segs.push([[x, y], [a, b]]); continue; }
      if (seen[j]) continue;
      segs.push(walk(x, y, a, b));
    }
  }
  // 纯环（无节点）
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x; if (!S[i] || seen[i] || isNode(i)) continue;
    seen[i] = 1; const n = nb(x, y); if (!n.length) continue;
    segs.push(walk(x, y, n[0][0], n[0][1]));
  }
  // 去掉细碎毛刺：一端悬空且很短
  const kEnd = (p) => deg[p[1] * N + p[0]] === 1;
  let strokes = segs.filter(s => s.length >= 2).filter(s => {
    const free = kEnd(s[0]) || kEnd(s[s.length - 1]), both = kEnd(s[0]) && kEnd(s[s.length - 1]);
    return both || !free || s.length > size * .1;
  }).filter(s => s.length > 2 || size < 40)
    .filter(s => !(s.length < 6 && deg[s[0][1] * N + s[0][0]] >= 3 && deg[s[s.length - 1][1] * N + s[s.length - 1][0]] >= 3));   // 交叉点里的碎段
  // 在交叉点把方向接近相反（即一笔贯穿）的两段接起来
  const dirAt = (s, fromStart) => { const k = Math.min(s.length - 1, 7); const a = fromStart ? s[0] : s[s.length - 1], b = fromStart ? s[k] : s[s.length - 1 - k]; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };
  const near = (p, q) => Math.abs(p[0] - q[0]) <= 4 && Math.abs(p[1] - q[1]) <= 4;
  for (let iter = 0; iter < 60; iter++) {
    let best = null;
    for (let a = 0; a < strokes.length; a++) for (let b = a + 1; b < strokes.length; b++) {
      for (const ea of [0, 1]) for (const eb of [0, 1]) {
        const pa = ea ? strokes[a][strokes[a].length - 1] : strokes[a][0], pb = eb ? strokes[b][strokes[b].length - 1] : strokes[b][0];
        if (!near(pa, pb) || deg[pa[1] * N + pa[0]] === 1 || deg[pb[1] * N + pb[0]] === 1) continue;
        const da = dirAt(strokes[a], !ea), db = dirAt(strokes[b], !eb);
        const dot = da[0] * db[0] + da[1] * db[1];
        if (dot < -.86 && (!best || dot < best.dot)) best = { a, b, ea, eb, dot };
      }
    }
    if (!best) break;
    let A = strokes[best.a], Bq = strokes[best.b];
    if (!best.ea) A = A.slice().reverse();
    if (best.eb) Bq = Bq.slice().reverse();
    const merged = A.concat(Bq);
    strokes = strokes.filter((_, k) => k !== best.a && k !== best.b); strokes.push(merged);
  }
  // 方向：偏横的从左到右，其余从上到下
  strokes = strokes.map(s => {
    const a = s[0], b = s[s.length - 1], dx = b[0] - a[0], dy = b[1] - a[1];
    const flip = Math.abs(dx) > Math.abs(dy) * 1.2 ? dx < 0 : dy < 0;
    return flip ? s.slice().reverse() : s;
  });
  // 顺序：先上后下、先左后右、横先于竖
  const info = strokes.map(s => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const horiz = (x1 - x0) > (y1 - y0) * 1.2;
    return { s, key: y0 + x0 * .45 + (horiz ? 0 : size * .06) };
  });
  info.sort((p, q) => p.key - q.key);
  const out = info.map(({ s }) => {
    const pts = s.map(([x, y]) => [x, y, Math.max(1, D[y * N + x])]);
    let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { pts, len: Math.max(len, 2) };
  });
  // 笔与笔之间的停顿（按"一笔的长度"计）
  const gap = size * .18;
  let tot = 0; const spans = out.map(s => { const a = tot; tot += s.len + gap; return [a, a + s.len]; });
  const G = { ch, N, mask: cv, strokes: out, spans, total: tot, size, colored: {} };
  cache.set(key, G);
  return G;
}

const tmp = (() => { const c = document.createElement('canvas'); c.width = c.height = 8; return c; })();
function coloredMask(G, color) {
  if (G.colored[color]) return G.colored[color];
  const c = document.createElement('canvas'); c.width = c.height = G.N; const x = c.getContext('2d');
  x.drawImage(G.mask, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, G.N, G.N);
  return (G.colored[color] = c);
}

// 把写到 p (0..1) 的字画到 ctx（ctx 已设好世界变换）；cx,cy = 字心（世界坐标）；返回笔尖位置（世界）
export function drawGlyph(ctx, G, cx, cy, p, color = '#000', alpha = 1) {
  if (p <= 0 || alpha <= 0) return null;
  const x0 = cx - G.N / 2, y0 = cy - G.N / 2;
  ctx.save(); ctx.globalAlpha = clamp(alpha);
  if (p >= 1) { ctx.drawImage(coloredMask(G, color), x0, y0); ctx.restore(); return null; }
  if (tmp.width !== G.N) { tmp.width = tmp.height = G.N; }
  const t = tmp.getContext('2d'); t.setTransform(1, 0, 0, 1, 0, 0); t.globalCompositeOperation = 'source-over'; t.clearRect(0, 0, G.N, G.N);
  t.fillStyle = color;
  const pos = p * G.total; let tip = null;
  G.strokes.forEach((s, i) => {
    const [a, b] = G.spans[i]; if (pos <= a) return;
    const q = clamp((pos - a) / (b - a)), n = s.pts.length, upto = Math.max(1, Math.round(q * (n - 1)));
    t.beginPath();
    for (let k = 0; k <= upto; k++) { const [x, y, r] = s.pts[k]; t.moveTo(x + r * 1.45 + 1.5, y); t.arc(x, y, r * 1.45 + 1.5, 0, 6.2832); }
    t.fill();
    if (q < 1) tip = [x0 + s.pts[upto][0], y0 + s.pts[upto][1]];
  });
  t.globalCompositeOperation = 'destination-in'; t.drawImage(G.mask, 0, 0);
  ctx.drawImage(tmp, x0, y0);
  ctx.restore();
  return tip;
}

// 每一笔的起止（0..1 的写字进度），给音效排点用
export function strokeTimes(G) { return G.spans.map(([a, b]) => [a / G.total, b / G.total, (b - a)]); }
