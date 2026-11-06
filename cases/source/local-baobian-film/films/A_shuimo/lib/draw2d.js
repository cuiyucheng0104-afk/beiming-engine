// 《豹变》A 水墨 · Canvas 2D 画的东西：雨、鹿群、收尖墨线、墨滴、镊子、眼镜、砚台、灯笼、前景剪影、字幕
// 所有坐标都是设计像素；调用方先 g.setTransform(K, 0, 0, K, 0, 0)。随机全部按种子哈希，任意帧可单独重画。
import { inkStroke } from '/engine/core/stroke.js';
import { hash2, hash3, clamp, lerp, css, vnoise1, ss } from './core.js';

// 每帧重画的画布：清空后至少做一次真实绘制（否则 GPU 画布在"只清空"的帧里会沿用上一帧的快照）
export function freshClear(g, w, h) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.filter = 'none'; g.globalAlpha = 1;
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(0,0,0,0.004)'; g.fillRect(0, 0, 1, 1);
}
export function fillPoly(g, pts) {
  if (!pts.length) return;
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath(); g.fill();
}
// 收尖墨线：pts = [[x, y, 笔压], ...]
export function stroke(g, pts, size, color, o = {}) {
  const poly = inkStroke(pts, { size, thinning: o.thinning ?? 0.55, streamline: o.streamline ?? 0.25, start: { taper: o.t0 ?? size * 2 }, end: { taper: o.t1 ?? size * 3 } });
  g.fillStyle = color; fillPoly(g, poly);
}
// 毛笔墨线：轮廓带毛边（沿周长的静态噪声位移）、沿行笔方向由浓到淡（起笔重、收笔枯）、外面一圈极淡的湿晕
export function inkBrush(g, pts, size, c3, alpha, seed, o = {}) {
  const poly = inkStroke(pts, { size, thinning: o.thinning ?? 0.55, streamline: o.streamline ?? 0.3, start: { taper: o.t0 ?? size }, end: { taper: o.t1 ?? size * 3 } });
  if (poly.length < 3) return;
  const n = poly.length, rough = o.rough ?? Math.max(0.8, size * 0.10);
  // 返修 w3（v3-05）：毛边按"周长弧长"取噪声、沿轮廓的外法线位移（原来按顶点序号取噪声、沿到中心的方向推：线一长，两端几乎不起毛，点一密，毛边频率又跟着变）
  const Ls = [0]; for (let i = 1; i < n; i++) Ls.push(Ls[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  let area = 0; for (let i = 0; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
  const sg = area > 0 ? 1 : -1;
  const nrm = poly.map((p, i) => { const a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n]; const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [sg * dy / l, -sg * dx / l]; });
  const jit = poly.map((p, i) => { const j = vnoise1(Ls[i] / 70 + seed * 3.1, seed) * rough + vnoise1(Ls[i] / 16 + seed, seed + 5) * rough * 0.45 + vnoise1(Ls[i] / 5 + seed * 1.3, seed + 9) * rough * 0.15; return [p[0] + nrm[i][0] * j, p[1] + nrm[i][1] * j]; });
  const a = pts[0], b = pts[pts.length - 1];
  const gr = g.createLinearGradient(a[0], a[1], b[0], b[1]);
  gr.addColorStop(0, css(c3, alpha)); gr.addColorStop(0.45, css(c3, alpha * 0.86)); gr.addColorStop(1, css(c3, alpha * (o.endA ?? 0.55)));
  const sc = Math.abs(g.getTransform().a) || 1;
  const halo = o.halo ?? 1;
  if (halo > 0.01) { g.save(); g.filter = `blur(${(1.8 * sc).toFixed(2)}px)`; g.fillStyle = css(c3, alpha * 0.22 * halo); fillPoly(g, jit); g.restore(); }
  // 返修 w3（v3-05）：洇边——轮廓按低频噪声往外长 1–2 设计像素（墨在纸上洇开的不规则边），淡一档；不是整圈等宽的模糊
  if ((o.bleed ?? 0) > 0.05) {
    const bl = o.bleed;
    const grow = poly.map((p, i) => { const w = bl * (0.55 + 0.45 * vnoise1(Ls[i] / 40 + seed * 2.3, seed + 11)) + bl * 0.7 * Math.max(0, vnoise1(Ls[i] / 13 + seed, seed + 13)); return [p[0] + nrm[i][0] * w, p[1] + nrm[i][1] * w]; });
    g.save(); g.filter = `blur(${(0.7 * sc).toFixed(2)}px)`; g.fillStyle = css(c3, alpha * 0.30); fillPoly(g, grow); g.restore();
  }
  g.save(); g.filter = `blur(${(0.5 * sc).toFixed(2)}px)`; g.fillStyle = gr; fillPoly(g, jit); g.restore();
}
// 带静态抖动的线（±0.6 设计像素，种子固定）
export function wobbleLine(a, b, n, seed, amp = 0.6, press = [0.4, 1, 0.5]) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, nx = -(b[1] - a[1]), ny = b[0] - a[0], l = Math.hypot(nx, ny) || 1;
    const w = vnoise1(u * 6 + seed * 3.1, seed) * amp;
    const p = u < 0.5 ? lerp(press[0], press[1], u / 0.5) : lerp(press[1], press[2], (u - 0.5) / 0.5);
    pts.push([lerp(a[0], b[0], u) + nx / l * w, lerp(a[1], b[1], u) + ny / l * w, p]);
  }
  return pts;
}

// ───────── 雨：长而细的淡墨斜线，从右上落向左下，偏离竖直 18° ─────────
// layers = [{ n, D, op, lenA, lenB, wA, wB, seed }]；camDx 相机横移（米）→ 按深度视差
export function drawRain(g, t, { layers, color, camDx = 0, camDy = 0, fpx = 1813, op = 1, speed = 2600, angle = 18 }) {
  if (op <= 0) return;
  const a = angle * Math.PI / 180, dx = -Math.sin(a), dy = Math.cos(a);
  for (const L of layers) {
    const TW = 2400, TH = 1400;
    const px = -camDx * fpx / L.D, py = camDy * fpx / L.D;
    g.fillStyle = css(L.col || color, L.op * op);                 // 返修 w3（qa2-10）：每层可以有自己的墨色（近层深一档）
    for (let i = 0; i < L.n; i++) {
      const h1 = hash2(i, L.seed), h2 = hash2(i, L.seed + 1), h3 = hash2(i, L.seed + 2), h4 = hash2(i, L.seed + 3);
      const v = speed * (0.85 + 0.3 * h3) * (L.D < 5 ? 1.2 : L.D > 15 ? 0.8 : 1);
      let x = h1 * TW + dx * v * t + px, y = h2 * TH + dy * v * t + py;
      x = ((x % TW) + TW) % TW - 240; y = ((y % TH) + TH) % TH - 180;
      const len = lerp(L.lenA, L.lenB, h4), w = lerp(L.wA, L.wB, h3);
      const x1 = x + dx * len, y1 = y + dy * len, nx = -dy * w / 2, ny = dx * w / 2;
      g.beginPath();
      g.moveTo(x, y); g.lineTo((x + x1) / 2 + nx, (y + y1) / 2 + ny); g.lineTo(x1, y1); g.lineTo((x + x1) / 2 - nx, (y + y1) / 2 - ny);
      g.closePath(); g.fill();
    }
  }
}

// ───────── 湿墨块：不规则轮廓（静态噪声）、边软、边上一道深（水渍边） ─────────
export function blobPath(g, cx, cy, rx, ry, rot, seed, irr = 0.18) {
  g.beginPath();
  for (let k = 0; k <= 120; k++) {
    const a = k / 120 * 2 * Math.PI;
    const r = 1 + irr * vnoise1(Math.cos(a) * 1.6 + Math.sin(a) * 0.7 + seed * 3.1, seed) + irr * 0.45 * vnoise1(a * 3.2 + seed * 1.7, seed + 7);
    const x = Math.cos(a) * rx * r, y = Math.sin(a) * ry * r;
    g.lineTo(cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot));
  }
  g.closePath();
}
export function wetBlob(g, cx, cy, rx, ry, rot, seed, col, a, { blur = 1.2, rim = 0.55, irr = 0.18 } = {}) {
  const sc = Math.abs(g.getTransform().a) || 1;
  g.save(); g.filter = `blur(${(blur * sc).toFixed(2)}px)`; blobPath(g, cx, cy, rx, ry, rot, seed, irr); g.fillStyle = css(col, a); g.fill(); g.restore();
  if (rim > 0) { g.save(); g.filter = `blur(${(0.6 * sc).toFixed(2)}px)`; blobPath(g, cx, cy, rx * 0.97, ry * 0.97, rot, seed, irr); g.strokeStyle = css(col, Math.min(1, a * rim)); g.lineWidth = Math.max(0.8, Math.min(rx, ry) * 0.16); g.stroke(); g.restore(); }
}

// ───────── 鹿：没骨（2–3 团相互交叠的湿墨块：背浓腹淡、臀最浓），头颈一笔写出，腿一笔细线收尖、膝部略折，耳两点焦墨 ─────────
//   x, y：身体中心；L：体长；phase 0..3：四张步态；stag：是否画角
export function drawDeer(g, x, y, L, phase, inks, stag = false, seed = 0) {
  const [qing, dan, zhong, nong, jiao] = inks;
  const bob = [0, -1, 0, -1][phase] * (L / 70);
  const by = y + bob;
  const st = [[0.16, -0.10, -0.12, 0.14], [0.05, 0.02, -0.02, 0.05], [-0.12, 0.14, 0.16, -0.10], [0.02, 0.05, 0.05, 0.02]][phase];
  const hips = [[-0.28, 0.08], [-0.20, 0.09], [0.22, 0.09], [0.29, 0.08]];
  // 腿：先画（在身体后面），前后腿浓淡不同
  for (let k = 0; k < 4; k++) {
    const hx = x + hips[k][0] * L, hy = by + hips[k][1] * L;
    const fx = hx + st[k] * L, fy = y + 0.60 * L;
    const kx = (hx + fx) / 2 + (k < 2 ? 0.05 : -0.035) * L, ky = hy + (fy - hy) * 0.50;
    stroke(g, [[hx, hy, 1], [kx, ky, 0.7], [fx, fy, 0.35]], 0.024 * L * 2.2, css(k < 2 ? nong : zhong, k % 2 ? 0.80 : 0.92), { t0: 1, t1: 0.16 * L, thinning: 0.7 });
  }
  // 身体：主块（重墨）、背臀一块浓墨、胸前一块淡墨
  wetBlob(g, x, by, 0.40 * L, 0.16 * L, -0.04, seed * 3 + 1, zhong, 0.82, { blur: 1.0 });
  wetBlob(g, x - 0.17 * L, by - 0.05 * L, 0.24 * L, 0.11 * L, -0.10, seed * 3 + 2, nong, 0.78, { blur: 0.9 });
  wetBlob(g, x + 0.16 * L, by + 0.05 * L, 0.20 * L, 0.08 * L, 0.05, seed * 3 + 3, dan, 0.55, { blur: 1.2, rim: 0.3 });
  // 头颈一笔：颈粗头小
  const nx0 = x + 0.26 * L, ny0 = by - 0.04 * L, hx = x + 0.47 * L, hy = by - 0.40 * L;
  stroke(g, [[nx0, ny0, 1], [x + 0.38 * L, by - 0.22 * L, 0.8], [hx, hy, 0.55]], 0.13 * L, css(zhong, 0.9), { t0: 1, t1: 2, thinning: 0.6 });
  wetBlob(g, hx + 0.05 * L, hy + 0.01 * L, 0.085 * L, 0.05 * L, 0.45, seed * 3 + 5, zhong, 0.92, { blur: 0.6, rim: 0.4, irr: 0.12 });
  g.fillStyle = css(jiao, 0.95);
  for (const [ex, ey] of [[-0.03, -0.06], [0.03, -0.075]]) { g.beginPath(); g.ellipse(hx + ex * L, hy + ey * L, 0.026 * L, 0.018 * L, -0.6, 0, 6.283); g.fill(); }   // 耳：两个焦墨点
  g.beginPath(); g.ellipse(hx + 0.13 * L, hy + 0.05 * L, 0.018 * L, 0.014 * L, 0, 0, 6.283); g.fill();                                                         // 鼻
  if (stag) {
    for (const sgn of [0, 1]) {
      const bx = hx + (0.0 + 0.03 * sgn) * L, byy = hy - 0.07 * L;
      stroke(g, [[bx, byy, 0.8], [bx - 0.06 * L, byy - 0.15 * L, 0.6], [bx - 0.03 * L, byy - 0.27 * L, 0.3]], 0.026 * L, css(nong, 0.88), { t0: 1, t1: 0.05 * L });
      stroke(g, [[bx - 0.05 * L, byy - 0.12 * L, 0.6], [bx + 0.03 * L, byy - 0.19 * L, 0.3]], 0.02 * L, css(nong, 0.82), { t0: 1, t1: 0.04 * L });
    }
  }
  g.fillStyle = css(nong, 0.85); g.beginPath(); g.ellipse(x - 0.42 * L, by - 0.07 * L, 0.045 * L, 0.022 * L, -0.7, 0, 6.283); g.fill();
}

// ───────── 墨滴：水滴形，焦墨 + 一道留白月牙 ─────────
export function drawDrop(g, x, y, r, stretch, ang, ink, hi, paper = null) {
  if (r <= 0.2) return;
  g.save(); g.translate(x, y); g.rotate(ang);
  const shape = (k) => {
    g.beginPath();
    g.moveTo(0, -r * 1.25 * stretch * k);
    g.bezierCurveTo(r * 0.55 * k, -r * 0.6 * stretch * k, r * k, 0, r * k, r * 0.25);
    g.arc(0, r * 0.25, r * k, 0, Math.PI, false);
    g.bezierCurveTo(-r * k, 0, -r * 0.55 * k, -r * 0.6 * stretch * k, 0, -r * 1.25 * stretch * k);
  };
  if (paper) { shape(1 + 1.5 / Math.max(r, 1)); g.lineWidth = 3.2; g.strokeStyle = css(paper, 0.9); g.stroke(); }   // 1.5K 留白边：水滴折射出来的亮边
  shape(1); g.fillStyle = css(ink, 0.97); g.fill();
  g.strokeStyle = css(hi, 0.85); g.lineWidth = Math.max(1, r * 0.22); g.lineCap = 'round';
  g.beginPath(); g.arc(-r * 0.15, r * 0.2, r * 0.58, Math.PI * 1.05, Math.PI * 1.45); g.stroke();
  g.restore();
}

// 返修第 2 轮（v1-06）：墨滴改成不规则的墨团——轮廓带静态噪声与一圈毛边，顶上拉尖；高光是一小块不规则的纸色，不是对称的白月牙
export function drawInkDrop(g, x, y, r, stretch, ink, paper, seed = 1) {
  if (r <= 0.2) return;
  const N = 44, P = [];
  const hz = (i, k) => { const h = Math.sin((i + 1) * 12.9898 + seed * 78.233 + k * 37.719) * 43758.5453; return h - Math.floor(h); };
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2, top = Math.max(0, -Math.sin(a));
    let rr = r * (1 + 0.16 * (hz(i, 1) - 0.5) + 0.08 * Math.sin(a * 3 + seed) + 0.05 * Math.sin(a * 7 + seed * 2));
    const px = Math.cos(a) * rr * (1 - 0.55 * top * top), py = Math.sin(a) * rr - r * (0.85 * stretch) * Math.pow(top, 2.2);
    P.push([px, py]);
  }
  const path = (k, dx = 0, dy = 0) => { g.beginPath(); P.forEach(([px, py], i) => i ? g.lineTo(x + dx + px * k, y + dy + py * k) : g.moveTo(x + dx + px * k, y + dy + py * k)); g.closePath(); };
  g.save();
  if (paper) { g.filter = 'blur(1.5px)'; path(1.28); g.fillStyle = css(paper, 0.40); g.fill(); }
  g.filter = 'blur(1.1px)'; path(1.10); g.fillStyle = css(ink, 0.45); g.fill();
  g.filter = 'none'; path(1.0); g.fillStyle = css(ink, 0.95); g.fill();
  if (paper && r > 2) {                                    // 纸色小高光：左上一块不规则的留白
    g.beginPath();
    for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2, rr = r * 0.16 * (0.6 + 0.8 * hz(i, 5)); const hx = x - r * 0.52 + Math.cos(a) * rr * 0.7, hy = y - r * 0.05 + Math.sin(a) * rr * 1.6; i ? g.lineTo(hx, hy) : g.moveTo(hx, hy); }
    g.closePath(); g.fillStyle = css(paper, 0.78); g.fill();
  }
  g.restore();
}

// ───────── 镊子：两道收尖细线 3→1 设计像素 ─────────
export function drawTweezers(g, x, y, ang, len, ink) {
  g.save(); g.translate(x, y); g.rotate(ang);
  for (const s of [-1, 1]) stroke(g, [[0, s * 5, 1], [len * 0.55, s * 3.2, 0.8], [len, s * 0.6, 0.35]], 3.2, css(ink, 0.92), { t0: 1, t1: len * 0.25 });
  g.fillStyle = css(ink, 0.8); g.beginPath(); g.ellipse(-2, 0, 4, 6.5, 0, 0, 6.283); g.fill();
  g.restore();
}

// ───────── 眼镜：两圆框浓墨、镜片纸白 6% + 一道光带、镜腿 ─────────
// mode 'folded'：折好平放；'held'：拿起来（tilt 倾斜 0..1）
export function drawGlasses(g, x, y, R, ang, tilt, inks, paper, light, flash = 0, noRight = false) {
  const [, , , nong] = inks;
  g.save(); g.translate(x, y); g.rotate(ang);
  const sy = 1 - 0.55 * tilt;
  for (const s of [-1, 1]) {
    const cx = s * R * 1.12;
    g.save(); g.translate(cx, 0); g.scale(1, sy);
    g.fillStyle = css(paper.map(v => Math.min(1, v * 1.06)), 0.10); g.beginPath(); g.arc(0, 0, R, 0, 6.283); g.fill();
    g.strokeStyle = css(nong, 0.92); g.lineWidth = 2.6; g.beginPath(); g.arc(0, 0, R, 0, 6.283); g.stroke();
    g.strokeStyle = css(light, 0.28 + 0.4 * flash); g.lineWidth = R * 0.18; g.beginPath(); g.moveTo(-R * 0.55, -R * 0.35); g.lineTo(R * 0.15, R * 0.55); g.stroke();
    g.restore();
  }
  g.strokeStyle = css(nong, 0.9); g.lineWidth = 2.6;
  g.beginPath(); g.moveTo(-R * 0.3, -R * 0.08 * sy); g.quadraticCurveTo(0, -R * 0.32 * sy, R * 0.3, -R * 0.08 * sy); g.stroke();
  // 镜腿（折起：沿镜框上沿往回收；拿起：伸向一侧）
  g.lineWidth = 2.2;
  if (tilt < 0.01) {
    g.beginPath(); g.moveTo(-R * 2.1, -R * 0.2); g.lineTo(R * 0.6, -R * 0.62); g.stroke();
    g.beginPath(); g.moveTo(R * 2.1, -R * 0.2); g.lineTo(-R * 0.4, -R * 0.7); g.stroke();
  } else {
    if (!noRight) { g.beginPath(); g.moveTo(R * 2.2, -R * 0.1 * sy); g.lineTo(R * 3.6, -R * 0.9 * sy - R * 0.6 * tilt); g.stroke(); }
    g.beginPath(); g.moveTo(-R * 2.2, -R * 0.1 * sy); g.lineTo(-R * 2.9, -R * 0.95 * sy - R * 0.5 * tilt); g.stroke();
  }
  g.restore();
}

// ───────── 字幕：竖排，墨渗显影（模糊 6 → 0、墨浓 0 → 1）；画在单独的字幕画布上，洇之后才叠 ─────────
export function drawSubtitle(g, chars, x, y0, size, step, prog, color, alpha, font = 'BBMS') {
  g.save();
  g.font = `${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'top';
  chars.forEach((ch, i) => {
    const p = prog[i];
    if (p <= 0) return;
    const bl = 5 * (1 - p);
    g.filter = bl > 0.05 ? `blur(${(bl * g.getTransform().d).toFixed(2)}px)` : 'none';
    g.fillStyle = css(color, alpha * ss(p));
    g.fillText(ch, x, y0 + i * step);
  });
  g.filter = 'none';
  g.restore();
}
