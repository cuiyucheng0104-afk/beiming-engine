// 一滴颜料变锦鲤 —— render(t)：一张长卷，一镜到底。时间全部来自 timeline.js（TL）。
// 笔触引擎 engine.js（mk / drawS / drawList / withSeed …）。render 内不调用 RNG：所有笔触在 build() 里固定种子生成。
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const T = TL.T, at = TL.at;
window.DUR = TL.DUR;

// ---------- 调色板 ----------
const PAP = '#f2eadb';
const VER = '#c8361e', VER2 = '#d9512f', VERL = '#e8876a', VERD = '#9e2915', VEDGE = '#8a2a17';
const WATER = '#b6c6c3', WATER2 = '#97adae', RIPPLE = '#6f8790';
const SEASONS = [
  { id: 'spring', name: '春', mono: 'III–V', x0: 2300, x1: 3200, col: '#a9bd73', col2: '#7f9a4e', t: T.spring, sw: '#9fb86a' },
  { id: 'summer', name: '夏', mono: 'VI–VIII', x0: 3200, x1: 4100, col: '#78a8a0', col2: '#4f8279', t: T.summer, sw: '#5f9c94' },
  { id: 'autumn', name: '秋', mono: 'IX–XI', x0: 4100, x1: 5000, col: '#d8ad66', col2: '#b97a34', t: T.autumn, sw: '#c48a3c' },
  { id: 'winter', name: '冬', mono: 'XII–II', x0: 5000, x1: 7600, col: '#a3aaae', col2: '#77828a', t: T.winter, sw: '#8f979c' },
];

// ---------- 小工具 ----------
const lin = u => clamp(u);
function KF(keys) {   // [[t, v, ease]]：ease 作用在「到达这一键」的那一段
  return t => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1, e] = keys[i]; return v0 + (v1 - v0) * (e || ss)((t - t0) / (t1 - t0));
    }
    return keys[keys.length - 1][1];
  };
}
const fade2 = (t, a, b, fi = .4, fo = .4) => ss(seg(t, a, a + fi)) * (1 - ss(seg(t, b - fo, b)));
const TAU = Math.PI * 2;
const wrapA = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };

// ---------- 锦鲤的运动 ----------
const L = 500, XMAX = 660, NSP = 44;               // 直身锦鲤：头 X=0，尾鳍尖 X≈660（单位 px，sc=1）
const pathY = x => 55 * Math.sin(x / 420 + .3) + 22 * Math.sin(x / 165 + 1.3);
const headX = monotone([[3.0, 40], [4.5, 130], [6.0, 640], [7.5, 1330], [9.0, 2300], [10.0, 3200], [11.0, 4100], [12.0, 5000], [13.0, 5650], [13.6, 5722], [14.0, 5725]]);
// 摆尾相位：整数 = 尾鳍到极点（落在 TL.FLICKS 的每一拍上）
function kph(t) {
  if (t < 4.5) return (t - 4.5) / .75;
  if (t < 7.5) return (t - 4.5) / .75;
  if (t < 13.0) return 4 + (t - 7.5) / .5;
  if (t < 14.0) return 15 + (t - 13) / 1.0;
  return 16 + (t - 14) / .22;                      // 跃起时急甩
}
const swimAmp = t => ss(seg(t, 3.9, 4.5)) * (1 - .55 * ss(seg(t, 13.0, 13.6)));
const koiSc = KF([[0, .45], [3.0, .45], [4.5, 1.0, eio], [13.0, 1.0], [13.5, .85, ss], [14.0, .85], [14.75, 1.5, eo], [15.05, 1.8, eo]]);
const koiAlpha = t => t < 13.0 ? 1 : t < 14.0 ? 1 - .5 * ss(seg(t, 13.0, 13.4)) : t < 14.75 ? .5 + .5 * ss(seg(t, 14.0, 14.08)) : 1 - ss(seg(t, 14.75, 14.97));
// 跃起中心（世界坐标）：14.0 时鱼身中点，上浮 150
let LEAP0 = null;
function pathSpine(t, sc) {
  const hx = headX(t), out = [], ds = XMAX * sc / (NSP - 1);
  let x = hx, y = pathY(hx), acc = 0, k = 0, px = x, py = y; out.push([x, y]);
  const amp = swimAmp(t), ph = Math.PI * kph(t);
  while (out.length < NSP) {
    const nx = px - 3, ny = pathY(nx), d = Math.hypot(nx - px, ny - py);
    if (acc + d >= ds * out.length) { const u = (ds * out.length - acc) / d; out.push([lerp(px, nx, u), lerp(py, ny, u)]); continue; }
    acc += d; px = nx; py = ny;
  }
  // 横向波：沿路径法线
  const res = [];
  for (let i = 0; i < NSP; i++) {
    const s = i / (NSP - 1) * XMAX / L, a = out[Math.max(0, i - 1)], b = out[Math.min(NSP - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], ll = Math.hypot(dx, dy) || 1, nx = -dy / ll, ny = dx / ll;
    const disp = L * sc * amp * (.015 + .085 * s * s) * Math.cos(ph - TAU * (s - 1.2) / 1.35);
    res.push([out[i][0] + nx * disp, out[i][1] + ny * disp]);
  }
  return res;
}
function curlSpine(sc) {   // 盘在晕染里：头在下方朝右，身体绕左侧卷上去
  const span = 2.75, Rc = L * sc / span, res = [];
  for (let i = 0; i < NSP; i++) { const s = i / (NSP - 1) * XMAX / L, th = Math.PI / 2 + s * span; res.push([Rc * Math.cos(th) * 1.0, Rc * Math.sin(th) * .92]); }
  return res;
}
function leapSpine(t, sc, M, h0) {
  const u = eo(seg(t, T.leap, T.burst)), hm = h0 - .6 * u, kap = 2.6 * u + .3 * Math.sin(TAU * (t - T.leap) * 3.2) * u;
  const ds = XMAX * sc / (NSP - 1), mid = Math.round((NSP - 1) * (.5 * L / XMAX)), P = new Array(NSP);
  P[mid] = [M[0], M[1]];
  for (let i = mid + 1; i < NSP; i++) { const s = (i - .5) / (NSP - 1) * XMAX / L, h = hm + kap * (s - .5); P[i] = [P[i - 1][0] - Math.cos(h) * ds, P[i - 1][1] - Math.sin(h) * ds]; }
  for (let i = mid - 1; i >= 0; i--) { const s = (i + .5) / (NSP - 1) * XMAX / L, h = hm + kap * (s - .5); P[i] = [P[i + 1][0] + Math.cos(h) * ds, P[i + 1][1] + Math.sin(h) * ds]; }
  return P;
}
function koiSpine(t) {
  const sc = koiSc(t);
  if (t < 4.6) {
    const w = ss(seg(t, 3.5, 4.6)), A = curlSpine(sc); if (w <= 0) return { P: A, sc };
    const B = pathSpine(t, sc); return { P: A.map((p, i) => [lerp(p[0], B[i][0], w), lerp(p[1], B[i][1], w)]), sc };
  }
  if (t < T.leap) return { P: pathSpine(t, sc), sc };
  const w = ss(seg(t, T.leap, T.leap + .25)), A = pathSpine(T.leap, sc);
  const M = [LEAP0[0], LEAP0[1] - 150 * eo(seg(t, T.leap, T.burst))];
  const B = leapSpine(t, sc, M, LEAP0[2]);
  return { P: A.map((p, i) => [lerp(p[0], B[i][0], w), lerp(p[1], B[i][1], w)]), sc };
}
function spineNormals(P) {
  return P.map((_, i) => { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; });
}
function mapPt(SP, N, sc, X, Y) {
  const f = clamp(X / XMAX) * (NSP - 1), i = Math.min(NSP - 2, Math.floor(f)), u = f - i;
  const px = lerp(SP[i][0], SP[i + 1][0], u), py = lerp(SP[i][1], SP[i + 1][1], u), nx = lerp(N[i][0], N[i + 1][0], u), ny = lerp(N[i][1], N[i + 1][1], u);
  return [px + nx * Y * sc, py + ny * Y * sc];
}
function bendStroke(tp, SP, N, sc, t) {
  const pts = tp.pts.map(([X, Y]) => {
    if (tp.fin) { const k = 1 + .28 * Math.sin(TAU * 1.6 * t + tp.fin.ph); Y = tp.fin.yr + (Y - tp.fin.yr) * k; X = tp.fin.xr + (X - tp.fin.xr) * (1 + .1 * (k - 1)); }
    return mapPt(SP, N, sc, X, Y);
  });
  const n = pts.length, nx = [], ny = [];
  for (let i = 0; i < n; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; nx.push(-dy / l); ny.push(dx / l); }
  return { pts, ws: tp.ws.map(w => w * sc), nx, ny, col: tp.col, a: tp.a, rib: tp.rib, br: tp.br ? tp.br.map(b => ({ ...b, bw: b.bw * sc })) : null };
}
const hwBody = X => { const s = X / L; return L * .15 * Math.pow(Math.sin(Math.PI * clamp(s * .92 + .05)), .55) * (1 - .5 * s); };

// ---------- 摄影机（唯一 world → screen） ----------
const dropY = t => -330 * (1 - Math.pow(clamp(t / T.drop), 2));
const camZ = KF([[0, 3.2], [T.drop, 3.2], [T.head, 3.7, lin], [4.5, 1.45, eio], [9.0, 1.2, ss], [13.0, 1.1, ss], [T.leap, 1.14, ss], [T.burst, 1.34, eo], [T.bloom, 1.4, ss], [T.seal, 1.02, eio], [TL.DUR, .955, lin]]);
let CAM = { x: 0, y: 0, z: 1 };
function camAt(t) {
  const z = camZ(t);
  if (t < T.drop) return { x: 0, y: .55 * dropY(t), z };
  if (t < T.head) return { x: 0, y: 0, z };
  const follow = tt => headX(tt) - 110;
  if (t < T.leap) { const w = ss(seg(t, T.head, 4.6)); return { x: lerp(0, follow(t), w), y: 0, z }; }
  const f0 = follow(T.leap), u = eo(seg(t, T.leap, T.burst - .15)), v = eio(seg(t, T.bloom, T.seal));
  return { x: lerp(f0, LEAP0[0], u) + 270 * v, y: lerp(0, LEAP0[1] - 150, u) * (1 - .6 * v), z };
}
const W2S = (x, y) => [(x - CAM.x) * CAM.z + 960, (y - CAM.y) * CAM.z + 540];
function worldT() { ctx.setTransform(CAM.z, 0, 0, CAM.z, 960 - CAM.x * CAM.z, 540 - CAM.y * CAM.z); }
function screenT() { ctx.setTransform(1, 0, 0, 1, 0, 0); }
function viewRect(pad = 0) { const hw = 960 / CAM.z + pad, hh = 540 / CAM.z + pad; return [CAM.x - hw, CAM.y - hh, CAM.x + hw, CAM.y + hh]; }

// ---------- 资源 ----------
let PAPER_IMG, PAPER_PAT, VIGN;
function drawPaper() {
  worldT(); const [x0, y0, x1, y1] = viewRect(4);
  PAPER_PAT.setTransform(new DOMMatrix().scale(.5)); ctx.fillStyle = PAPER_PAT; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}
function sprite2(Lst, k = 2) {
  const [x0, y0, x1, y1] = bbox(Lst), c2 = document.createElement('canvas');
  c2.width = Math.max(1, (x1 - x0) * k); c2.height = Math.max(1, (y1 - y0) * k);
  const c = c2.getContext('2d'); c.scale(k, k); c.translate(-x0, -y0); for (const s of Lst) drawS(c, s, 1);
  return { cv: c2, x0, y0, w: x1 - x0, h: y1 - y0 };
}
// 世界里的「画入」物件：S 按顺序画，t0 起 dur 秒画完；画完用 2× 精灵
const OBJ = [];
function addObj(S, wx, wy, t0, dur, o = {}) { const ob = { S, wx, wy, t0, dur, rot: o.rot || 0, sway: o.sway || 0, ph: o.ph || 0, layer: o.layer || 0 }; OBJ.push(ob); return ob; }
function drawObj(ob, t) {
  const p = seg(t, ob.t0, ob.t0 + ob.dur); if (p <= 0) return;
  const [vx0, vy0, vx1, vy1] = viewRect(60);
  if (ob.spr && (ob.wx + ob.spr.x0 > vx1 || ob.wx + ob.spr.x0 + ob.spr.w < vx0 || ob.wy + ob.spr.y0 > vy1 || ob.wy + ob.spr.y0 + ob.spr.h < vy0)) return;
  worldT(); ctx.translate(ob.wx, ob.wy); if (ob.rot) ctx.rotate(ob.rot);
  if (ob.sway) ctx.rotate(ob.sway * (Math.sin(1.15 * t + ob.ph) + .4 * Math.sin(2.7 * t + 2 * ob.ph)));
  if (p < 1) drawList(ctx, ob.S, p); else ctx.drawImage(ob.spr.cv, ob.spr.x0, ob.spr.y0, ob.spr.w, ob.spr.h);
}

// ---------- 生成器 ----------
function lotusPad(r, cols, notch) {
  const S = [], nA = notch ?? rnd(0, TAU);
  for (let k = 0; k < 4; k++) {   // 底色：绕一圈的宽笔（留出缺口）
    const pts = []; for (let j = 0; j <= 20; j++) { const a = nA + .25 + (k * .9 + j / 20 * 1.9); pts.push([Math.cos(a) * r * .62, Math.sin(a) * r * .62]); }
    S.push(mk(pts, r * .78, cols[0], { prof: 'even', nb: 7, a: .42, rough: .25 }));
  }
  for (let i = 0; i < 6; i++) {   // 扇形宽笔：先铺叶面
    const a = nA + .35 + i * (TAU - .7) / 6.4 + rnd(-.08, .08);
    S.push(mk(qcurve(Math.cos(a) * r * .1, Math.sin(a) * r * .1, Math.cos(a) * r * .93, Math.sin(a) * r * .93, rnd(-r * .1, r * .1), 12), r * rnd(.5, .66), pick(cols), { prof: 'leaf', nb: 5, a: rnd(.32, .42), rough: .2 }));
  }
  for (let k = 0; k < 5; k++) {   // 叶缘积色：几段短的深色湿边
    const a0 = nA + .4 + k * 1.15 + rnd(0, .3), pts = []; for (let j = 0; j <= 8; j++) { const a = a0 + j / 8 * rnd(.4, .7); pts.push([Math.cos(a) * r * .86, Math.sin(a) * r * .86]); }
    S.push(mk(pts, rnd(8, 14), cols[cols.length - 1], { prof: 'leaf', nb: 3, a: .22, rough: .5 }));
  }
  for (let i = 0; i < 10; i++) {  // 叶脉
    const a = nA + .45 + i * (TAU - .9) / 9;
    S.push(mk(qcurve(0, 0, Math.cos(a) * r * .82, Math.sin(a) * r * .82, rnd(-6, 6), 8), 2.6, cols[cols.length - 1], { prof: 'tip', nb: 0, a: .38 }));
  }
  S.push(mk(qcurve(-6, 0, 6, 0, 0, 4), 14, cols[cols.length - 1], { prof: 'even', nb: 0, a: .55 }));
  return S;
}
function koiTemplates() {
  const S = [];
  const along = (x0, x1, y0, y1, w, col, o) => mk(qcurve(x0, y0, x1, y1, o.bend || 0, o.n || 16), w, col, o);
  S.push(along(0, 270, 0, 0, 114, VERL, { prof: 'leaf', nb: 7, a: .62, rough: .12 }));
  S.push(along(150, 505, 0, 0, 96, VERL, { prof: 'tip', nb: 6, a: .58, rough: .12 }));
  S.push(along(20, 430, 0, 0, 62, VER2, { prof: 'tip', nb: 5, a: .5, rough: .15 }));
  S.push(along(12, 125, 0, 2, 72, VER, { prof: 'leaf', nb: 4, a: .78 }));
  S.push(along(160, 300, -8, 4, 82, VER, { prof: 'leaf', nb: 5, a: .74 }));
  S.push(along(330, 440, 6, -2, 46, VER, { prof: 'leaf', nb: 3, a: .7 }));
  S.push(along(0, 60, 0, 0, 46, VERD, { prof: 'brush', nb: 0, a: .3 }));
  S.push(along(200, 420, 0, 0, 7, VERD, { prof: 'even', nb: 0, a: .5 }));
  for (const sd of [1, -1]) {   // 身侧暗边：唯一的「线」
    const pts = []; for (let i = 0; i <= 18; i++) { const X = 24 + i / 18 * 290; pts.push([X, sd * hwBody(X) * .56]); }
    S.push(mk(pts, 4.2, VEDGE, { prof: 'brush', nb: 0, a: sd > 0 ? .34 : .2, rough: .45 }));
  }
  const fins = [];
  for (const sd of [1, -1]) {   // 胸鳍、腹鳍
    const a = mk(qcurve(105, sd * 48, 196, sd * 128, sd * 18, 10), 56, VERL, { prof: 'brush', nb: 7, a: .42 }); a.fin = { xr: 105, yr: sd * 48, ph: sd > 0 ? 0 : 1.7 }; fins.push(a);
    const b = mk(qcurve(110, sd * 46, 176, sd * 104, sd * 12, 8), 22, VER2, { prof: 'brush', nb: 3, a: .32 }); b.fin = a.fin; fins.push(b);
    const c = mk(qcurve(285, sd * 30, 336, sd * 74, sd * 8, 8), 30, VERL, { prof: 'brush', nb: 4, a: .4 }); c.fin = { xr: 285, yr: sd * 30, ph: sd > 0 ? 2.4 : .6 }; fins.push(c);
  }
  S.push(...fins);
  for (const sd of [1, -1]) {   // 尾鳍两叶
    S.push(mk(qctrl(478, 0, 560, sd * 20, 650, sd * 92, 14), 62, VERL, { prof: 'brush', nb: 8, a: .46 }));
    S.push(mk(qctrl(484, 0, 545, sd * 14, 612, sd * 56, 12), 22, VER2, { prof: 'brush', nb: 3, a: .36 }));
  }
  S.push(mk(qcurve(470, 0, 600, 0, 0, 10), 18, VERL, { prof: 'tip', nb: 2, a: .35 }));
  const EYES = [mk(qcurve(36, 19, 41, 20, 0, 4), 9, INK, { prof: 'even', nb: 0, a: .9 }), mk(qcurve(36, -19, 41, -20, 0, 4), 9, INK, { prof: 'even', nb: 0, a: .9 })];
  return { S, EYES };
}
function buildLotus() {
  const S = [], rings = [
    { n: 10, len: 300, w: 150, a0: 0, col: '#eba08a', tip: '#cc3d22', d0: 0 },
    { n: 8, len: 228, w: 122, a0: .31, col: '#e5806a', tip: '#c3381f', d0: .1 },
    { n: 6, len: 152, w: 92, a0: .55, col: '#dd6747', tip: '#b8321c', d0: .2 }];
  const items = [];
  for (const R of rings) for (let i = 0; i < R.n; i++) {
    const a = R.a0 + i * TAU / R.n + rnd(-.07, .07), r0 = 26, b = rnd(-16, 16);
    const P = qcurve(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * R.len, Math.sin(a) * R.len, b, 16);
    const s1 = mk(P, R.w * rnd(.9, 1.08), R.col, { prof: 'leaf', nb: 9, a: .52, rough: .18 });
    const tipP = P.slice(8); const s2 = mk(tipP, R.w * .62, R.tip, { prof: 'leaf', nb: 6, a: .52, rough: .2 });
    for (const st of [s1, s2]) st.br.forEach(b => { b.bw *= .42; b.a = Math.min(.9, b.a * 1.15); });
    const d = R.d0 * .8 + rnd(0, .24);
    items.push({ s: s1, d }, { s: s2, d: d + .08 });
    if (R.n >= 8) {   // 暗边：只一侧、只一段、两头收尖的一笔（不沿粗糙轮廓，不成多边形）
      const sd = rnd() < .5 ? 1 : -1, ww = s1.ws.reduce((m, v) => Math.max(m, v), 0), e = [];
      for (let i = 4; i <= 15; i++) { const q = i / 16, f = Math.pow(Math.sin(Math.PI * (q * .94 + .03)), .7); e.push([P[i][0] + s1.nx[i] * ww * .3 * f * sd, P[i][1] + s1.ny[i] * ww * .3 * f * sd]); }
      items.push({ s: mk(e, rnd(9, 14), VERD, { prof: 'leaf', nb: 0, a: .16, rough: .2 }), d: d + .15 });
    }
  }
  items.push({ s: mk(qcurve(-30, 0, 30, 0, 0, 6), 96, '#d9bd5c', { prof: 'even', nb: 4, a: .62 }), d: .3 });
  for (let i = 0; i < 9; i++) { const a = i / 9 * TAU, r = i ? 26 : 0; items.push({ s: mk(qcurve(Math.cos(a) * r - 3, Math.sin(a) * r, Math.cos(a) * r + 3, Math.sin(a) * r, 0, 3), 10, '#6d6a30', { prof: 'even', nb: 0, a: .75 }), d: .38 }); }
  for (let i = 0; i < 46; i++) { const a = i / 46 * TAU + rnd(-.05, .05); items.push({ s: mk(qcurve(Math.cos(a) * 52, Math.sin(a) * 52, Math.cos(a) * rnd(78, 96), Math.sin(a) * rnd(78, 96), rnd(-4, 4), 5), 3.2, '#d8a83c', { prof: 'tip', nb: 0, a: .8 }), d: .36 + rnd(0, .08) }); }
  return items;
}
function maple(cols) {
  const S = [], c = pick(cols), base = rnd(0, TAU);
  for (let i = 0; i < 5; i++) { const a = base + (i - 2) * .62, l = i === 2 ? 40 : rnd(26, 34); S.push(mk(polar(0, 0, a, l, rnd(-3, 3), 6), rnd(15, 20), c, { prof: 'leaf', nb: 3, a: rnd(.6, .78) })); }
  S.push(mk(polar(0, 0, base + Math.PI, 22, 2, 5), 2.5, '#7a4a26', { prof: 'tip', nb: 0, a: .7 }));
  return S;
}
// 世界里的水洗（离屏 0.5×）
function washCanvas(x0, x1, y0, y1, paint) {
  const k = .5, c2 = document.createElement('canvas'); c2.width = Math.ceil((x1 - x0) * k); c2.height = Math.ceil((y1 - y0) * k);
  const c = c2.getContext('2d'); c.scale(k, k); c.translate(-x0, -y0); paint(c); return { cv: c2, x0, y0, w: x1 - x0, h: y1 - y0 };
}
function washPoly(c, pts, fill, a, passes = 3, jit = 6) {
  for (let p = 0; p < passes; p++) {
    c.beginPath(); pts.forEach(([x, y], i) => { const xx = x + rnd(-jit, jit), yy = y + rnd(-jit, jit); i ? c.lineTo(xx, yy) : c.moveTo(xx, yy); });
    c.closePath(); c.globalAlpha = a / passes * 1.6; c.fillStyle = fill; c.fill();
  }
  c.globalAlpha = 1;
}
let SPLASH = [], BDOTS = [];
let POND, BANDS = [], KOI, LOTUS, LOTUS_SPR, SEAL, LEG = [], BLOOM;

function build() {
  // 池水：长横笔
  POND = withSeed(11, () => washCanvas(-900, 2420, -700, 700, c => {
    for (let i = 0; i < 16; i++) { const y = rnd(-640, 640), x0 = rnd(-900, -500), x1 = rnd(2150, 2400); drawS(c, mk(qcurve(x0, y, x1, y + rnd(-30, 30), rnd(-40, 40), 30), rnd(110, 230), pick([WATER, WATER, WATER2]), { prof: 'even', nb: 3, a: rnd(.15, .24), rough: .4 })); }
  }));
  // 四季色带：三遍不同外形的底色 → 两侧积色边 → 三层横向笔触（宽淡 / 中 / 干笔）→ 回流斑 → 向右越出本带的淡湿边（不留白纸）
  BANDS = SEASONS.map((S0, k) => withSeed(30 + k, () => {
    const m = 90, FR = k < 3 ? 900 : 0, W0 = S0.x0 - m, W1 = S0.x1 + m + FR;
    const eL = (y, ph) => S0.x0 - 6 + (vnoise(y * .0035 + ph) - .5) * 64 + (vnoise(y * .017 + ph * 3) - .5) * 16;
    const eR = (y, ph) => S0.x1 + 6 + (vnoise(y * .0035 + ph + 40) - .5) * 64 + (vnoise(y * .017 + ph * 3 + 40) - .5) * 16;
    const strip = (c, fl, fr, col, a) => { c.beginPath(); for (let y = -1200; y <= 1200; y += 20) c.lineTo(fl(y), y); for (let y = 1200; y >= -1200; y -= 20) c.lineTo(fr(y), y); c.closePath(); c.fillStyle = rgba(col, a); c.fill(); };
    const cvs = washCanvas(W0, W1, -1200, 1200, c => {
      for (let p = 0; p < 3; p++) { const ph = k * 11 + p * 2.7; strip(c, y => eL(y, ph), y => eR(y, ph), S0.col, .2); }
      for (let p = 0; p < 2; p++) { const ph = k * 11 + p * 2.7, q = 5 + p;   // 积色边：内缘宽 20–70，随高度变化
        strip(c, y => eL(y, ph), y => eL(y, ph) + 22 + 48 * vnoise(y * .006 + q), S0.col2, .09);
        if (k < 3) strip(c, y => eR(y, ph) - 22 - 48 * vnoise(y * .006 + q + 9), y => eR(y, ph), S0.col2, .09); }
      for (let i = 0; i < 8; i++) { const y = rnd(-1150, 1150); drawS(c, mk(qcurve(S0.x0 - 40, y, S0.x1 + 40, y + rnd(-50, 50), rnd(-40, 40), 26), rnd(170, 320), S0.col, { prof: 'even', nb: 7, a: rnd(.08, .13), rough: .35 })); }
      for (let i = 0; i < 10; i++) { const y = rnd(-1100, 1100); drawS(c, mk(qcurve(S0.x0 + rnd(-20, 120), y, S0.x1 - rnd(-20, 160), y + rnd(-40, 40), rnd(-30, 30), 24), rnd(50, 130), S0.col2, { prof: 'even', nb: 6, a: rnd(.08, .14), rough: .4 })); }
      for (let i = 0; i < 12; i++) { const y = rnd(-1100, 1100), x = rnd(S0.x0, S0.x1 - 200); drawS(c, mk(qcurve(x, y, x + rnd(220, 600), y + rnd(-25, 25), rnd(-20, 20), 16), rnd(14, 34), S0.col2, { prof: 'tip', nb: 4, a: rnd(.12, .22), rough: .5 })); }
      for (let i = 0; i < 6; i++) { const x = rnd(S0.x0 + 80, S0.x1 - 80), y = rnd(-900, 900), r = rnd(60, 160), pts = [];
        for (let j = 0; j < 24; j++) { const a = j / 24 * TAU; pts.push([x + Math.cos(a) * r * (1 + .25 * Math.sin(a * 3 + x)), y + Math.sin(a) * r * (1 + .25 * Math.sin(a * 3 + x))]); }
        washPoly(c, pts, S0.col2, .1, 3, r * .08); }
      if (FR) for (const [ext, ph] of [[260, 1], [480, 2], [720, 3]]) strip(c, y => eR(y, k * 11 + ph) - 30, y => S0.x1 + ext + (vnoise(y * .004 + ph * 7) - .5) * 160, S0.col, .09);
      if (FR) for (let i = 0; i < 12; i++) { const y = -1150 + i * 200 + rnd(-60, 60); drawS(c, mk(qcurve(S0.x1 - 140, y, S0.x1 + rnd(380, FR - 60), y + rnd(-40, 40), rnd(-30, 30), 20), rnd(180, 300), S0.col, { prof: 'tip', nb: 6, a: rnd(.1, .16), rough: .4 })); }
    });
    return { ...S0, cvs, oy: pathY(S0.x0), ph: rnd(0, 9), ph2: rnd(0, 9) };
  }));
  // 锦鲤
  KOI = withSeed(7, koiTemplates);
  // B 段荷叶：每拍一片，位置在当拍鱼头附近
  const LV = [['leaf1', 160, 240, 150, 1.2], ['leaf2', 60, -250, 172, 4.1], ['leaf3', 210, 250, 132, 2.6], ['leaf4', 280, 245, 158, 5.3]];
  LV.forEach(([k, dx, dy, r, nA], i) => withSeed(50 + i, () => { const x = headX(T[k]) + dx; const ob = addObj(lotusPad(r, ['#8aa66a', '#7a9a5e', '#567a45'], nA), x, pathY(x) + dy, T[k], .6, { sway: .012, ph: i }); ob.spr = sprite2(ob.S); }));
  // 春：芦苇 + 花瓣
  withSeed(61, () => {
    const S = [];
    for (const [x, bot] of [[2400, 1], [2560, 1], [2900, 1], [3060, 1], [2480, -1], [2780, -1], [3120, -1]]) {
      const y0 = bot * 640, y1 = bot * rnd(300, 360), bx = x + rnd(-40, 40);
      S.push(mk(qcurve(x, y0, bx, y1, rnd(-30, 30), 12), 9, '#7f9a4e', { prof: 'tip', nb: 3, a: .78 }));
      S.push(mk(qcurve(x, y0 - bot * 80, x + rnd(40, 90), y0 - bot * rnd(220, 280), rnd(-20, 20), 10), 16, '#9fb86a', { prof: 'leaf', nb: 3, a: .6 }));
    }
    const o = addObj(S, 0, 0, T.spring, .5); o.spr = sprite2(S);
    const P = []; for (let i = 0; i < 14; i++) { const x = rnd(2360, 3160), y = pathY(x) + (i % 2 ? 1 : -1) * rnd(180, 430), a = rnd(0, TAU); P.push(mk(polar(x, y, a, rnd(14, 22), rnd(-3, 3), 5), rnd(13, 20), pick(['#e8a7a0', '#dd8f8a', '#e9b5a8']), { prof: 'leaf', nb: 0, a: rnd(.6, .8) })); }
    const o2 = addObj(P, 0, 0, T.spring2, .4); o2.spr = sprite2(P);
  });
  // 夏：大荷叶 + 花苞
  [[3330, -330, 190, .4], [3640, 340, 152, 2.2], [3970, -320, 172, 5.0]].forEach(([x, y, r, nA], i) => withSeed(70 + i, () => { const o = addObj(lotusPad(r, ['#5f8f5a', '#6c9a62', '#3f6b45'], nA), x, y, T.summer, .45, { sway: .01, ph: i * 2 }); o.spr = sprite2(o.S); }));
  withSeed(75, () => {
    const S = [];
    for (const [x, y, r] of [[3480, 330, 62], [3820, 300, 70], [4060, 330, 54]]) S.push(...lotusPad(r, ['#6c9a62', '#4f8a5a', '#3f6b45']).map(s => ({ ...s, pts: s.pts.map(([a, b]) => [a + x, b + y]) })));
    // 花苞（俯视：一枚泪滴）
    S.push(mk(qcurve(3720, -205, 3760, -255, 4, 8), 44, '#e5806a', { prof: 'leaf', nb: 4, a: .6 }));
    S.push(mk(qcurve(3732, -220, 3758, -252, 2, 6), 18, VER, { prof: 'leaf', nb: 2, a: .6 }));
    S.push(mk(qcurve(3700, -180, 3722, -206, -3, 5), 14, '#5f8f5a', { prof: 'tip', nb: 0, a: .6 }));
    const o = addObj(S.map(s => { const n = s.pts.length, nx = [], ny = []; for (let i = 0; i < n; i++) { const a = s.pts[Math.max(0, i - 1)], b = s.pts[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; nx.push(-dy / l); ny.push(dx / l); } return { ...s, nx, ny }; }), 0, 0, T.summer2, .45); o.spr = sprite2(o.S);
  });
  // 秋：漂浮的落叶 + 风痕
  withSeed(81, () => {
    const mkSet = (n, x0, x1) => { const S = []; for (let i = 0; i < n; i++) { const x = rnd(x0, x1), y = pathY(x) + (i % 2 ? 1 : -1) * rnd(170, 440); S.push(...maple(['#b8612a', '#d39a3e', '#a8452a', '#c97a2e']).map(s => ({ ...s, pts: s.pts.map(([a, b]) => [a + x, b + y]) }))); } return S; };
    const A = mkSet(9, 4140, 4980); const o = addObj(A, 0, 0, T.autumn, .45); o.spr = sprite2(A);
    const B = mkSet(5, 4300, 5000); for (let i = 0; i < 3; i++) { const y = rnd(-420, 420); if (Math.abs(y) < 160) continue; B.push(mk(qcurve(4200, y, 4950, y + rnd(-20, 20), rnd(-20, 20), 20), 10, '#a77d4a', { prof: 'tip', nb: 3, a: .2, rough: .5 })); }
    const o2 = addObj(B, 0, 0, T.autumn2, .4); o2.spr = sprite2(B);
  });
  // 冬：残荷枯梗 + 冰纹 + 落雪
  withSeed(91, () => {
    const S = [];
    for (const [x, bot] of [[5080, 1], [5300, -1], [5560, 1], [5900, -1], [6150, 1], [6400, -1], [5760, 1]]) {
      const y0 = bot * 650, y1 = bot * rnd(280, 380), x1 = x + rnd(-60, 60);
      S.push(mk(qcurve(x, y0, x1, y1, rnd(-20, 20), 12), 12, '#4e4237', { prof: 'trunk', nb: 4, a: .62, rough: .35 }));
      const bx = x1 + rnd(30, 90) * (rnd() < .5 ? 1 : -1), by = y1 + bot * rnd(60, 120);
      S.push(mk(qcurve(x1, y1, bx, by, rnd(-10, 10), 8), 9, '#5a4a3c', { prof: 'tip', nb: 3, a: .55, rough: .4 }));
      if (rnd() < .6) S.push(mk(qcurve(bx - 26, by, bx + 26, by + rnd(-10, 10), rnd(-10, 10), 8), 30, '#8a7a62', { prof: 'leaf', nb: 4, a: .5 }));
    }
    const o = addObj(S, 0, 0, T.winter, .45); o.spr = sprite2(S);
    const I = [];
    for (let k = 0; k < 6; k++) { const bot = k % 2 ? 1 : -1, x = 5050 + k * 230 + rnd(0, 80); let px = x, py = bot * rnd(330, 470); const pts = [[px, py]]; for (let j = 0; j < 6; j++) { px += rnd(30, 70); py += rnd(-30, 30); pts.push([px, py]); } I.push(mk(pts.slice(0, 4), rnd(13, 18), '#6e7e88', { prof: 'tip', nb: 5, a: .3, rough: .4 }), mk(pts.slice(3), rnd(10, 14), '#6e7e88', { prof: 'tip', nb: 4, a: .24, rough: .4 })); }
    for (let i = 0; i < 70; i++) { const x = rnd(5020, 6900), y = rnd(-560, 560), a = rnd(0, TAU); I.push(mk(polar(x, y, a, rnd(4, 8), 0, 3), rnd(5, 9), '#7f8e98', { prof: 'leaf', nb: 0, a: rnd(.35, .6) })); }
    const o2 = addObj(I, 0, 0, T.winter2, .4); o2.spr = sprite2(I);
  });
  // 跃起中心：14.0 时鱼身中点与朝向
  { const sp = pathSpine(T.leap, koiSc(T.leap)), m = Math.round((NSP - 1) * (.5 * L / XMAX)), a = sp[m - 2], b = sp[m + 2]; LEAP0 = [sp[m][0], sp[m][1], Math.atan2(a[1] - b[1], a[0] - b[0])]; }
  LOTUS = withSeed(101, buildLotus);
  SPLASH = withSeed(141, () => [...Array(30)].map(() => ({ a: rnd(0, TAU), v0: rnd(260, 720), sz: rnd(4, 11), col: rnd() < .25 ? VER2 : '#6f8a96', dl: rnd(0, .05) })));
  BDOTS = withSeed(151, () => [...Array(46)].map(() => ({ a: rnd(0, TAU), v0: rnd(350, 900), sz: rnd(2, 7), col: rnd() < .7 ? VER2 : VERD })));
  // 晕染：角度噪声（固定）
  BLOOM = withSeed(5, () => ({ ph: [...Array(10)].map(() => rnd(0, TAU)), lobes: [...Array(7)].map((_, k) => ({ a: rnd(0, TAU), amp: rnd(.12, .26), t0: rnd(.4, 1.4) })),
    sat: [...Array(16)].map(() => ({ a: rnd(0, TAU), d: rnd(150, 240), r: rnd(1.4, 4.5) })), back: [...Array(4)].map(() => ({ a: rnd(0, TAU), d: rnd(.15, .6), r: rnd(.18, .34), t0: rnd(.5, 1.5) })), gran: [...Array(160)].map(() => ({ a: rnd(0, TAU), d: Math.sqrt(rnd()) , r: rnd(.5, 1.5) })) }));
  // 季节图例（屏幕坐标）
  LEG = withSeed(121, () => SEASONS.map((S0, k) => ({ ...S0, st: mk(qcurve(96 + k * 86, 92, 160 + k * 86, 92 + rnd(-2, 2), rnd(-3, 3), 8), 16, S0.sw, { prof: 'even', nb: 4, a: .85 }) })));
  // 朱印「鲤」
  SEAL = withSeed(131, () => {
    const s = 220, c2 = document.createElement('canvas'); c2.width = c2.height = s; const c = c2.getContext('2d');
    const pts = []; const q = 30, e = s - 30; for (let i = 0; i <= 10; i++) pts.push([q + (e - q) * i / 10, q]); for (let i = 0; i <= 10; i++) pts.push([e, q + (e - q) * i / 10]); for (let i = 10; i >= 0; i--) pts.push([q + (e - q) * i / 10, e]); for (let i = 10; i >= 0; i--) pts.push([q, q + (e - q) * i / 10]);
    washPoly(c, pts, VER, 1.0, 4, 3);
    for (let i = 0; i < 9; i++) drawS(c, mk(qcurve(q + 6, q + 12 + i * 18, e - 6, q + 12 + i * 18 + rnd(-3, 3), rnd(-3, 3), 10), 10, '#b52f19', { prof: 'even', nb: 3, a: .5 }));
    c.globalCompositeOperation = 'destination-out';
    c.font = '700 128px "Noto Serif SC"'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#000'; c.fillText('鲤', s / 2, s / 2 + 6);
    for (let i = 0; i < 90; i++) { c.globalAlpha = rnd(.3, .9); c.beginPath(); c.arc(rnd(q - 4, e + 4), rnd(q - 4, e + 4), rnd(.6, 2.4), 0, TAU); c.fill(); }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    return c2;
  });
}

// ---------- 绘制：晕染与颜料滴 ----------
function bloomR(th, u) {
  const R = 12 + 95 * (1 - Math.exp(-u * 1.6));
  let k = 1; for (let j = 2; j < 10; j++) k += .11 / (j * .6) * Math.sin(j * th + BLOOM.ph[j]);
  for (const lb of BLOOM.lobes) { const d = wrapA(th - lb.a); k += lb.amp * Math.exp(-((d / .2) ** 2)) * ss(seg(u, lb.t0, lb.t0 + 1.4)); }
  return R * k;
}
function bloomPath(u, scl = 1, jit = 0) {
  ctx.beginPath(); for (let i = 0; i <= 120; i++) { const th = i / 120 * TAU, r = bloomR(th, u) * scl * (1 + jit * Math.sin(th * 7 + jit * 40)); i ? ctx.lineTo(Math.cos(th) * r, Math.sin(th) * r) : ctx.moveTo(Math.cos(th) * r, Math.sin(th) * r); }
  ctx.closePath();
}
// 一块水彩晕：没有任何描边。多遍抖动叠色铺底 → 边缘一圈环带多遍积色（宽窄随角度变）→ 沿边几条短笔（回流）。
// 在当前变换下画；u 是晕开进度（bloomR 的参数）。所有笔触都在固定种子下生成，逐帧稳定。
const _jr = (th, ph, j) => 1 + j * (Math.sin(3 * th + ph) * .6 + Math.sin(5 * th + 2.1 * ph) * .3 + Math.sin(9 * th + 3.3 * ph) * .15);
function bloomSub(u, scl, ph, j) { for (let i = 0; i <= 120; i++) { const th = i / 120 * TAU, r = bloomR(th, u) * scl * _jr(th, ph, j); i ? ctx.lineTo(Math.cos(th) * r, Math.sin(th) * r) : ctx.moveTo(Math.cos(th) * r, Math.sin(th) * r); } ctx.closePath(); }
function pooledBloom(u, A, P) {
  if (A <= 0) return;
  // 铺底：4 遍，每遍外形不同，重叠处自然更深
  [[1.0, .4, .028], [.994, 2.3, .03], [1.004, 4.1, .026], [.97, 5.7, .04]].forEach(([scl, ph, j]) => { ctx.beginPath(); bloomSub(u, scl, ph, j); ctx.fillStyle = rgba(P.body, P.bodyA * A); ctx.fill(); });
  // 湿边积色：外缘与内缘相位不同的环带（evenodd），叠 4 遍，宽度随角度变化
  [[1.0, .9, .4, 1.2, P.rim], [1.0, .86, 2.3, 3.1, P.rim], [1.0, .93, 4.1, 5.3, P.deep], [.995, .95, 5.7, .7, P.deep]].forEach(([so, si, p1, p2, col], k) => {
    ctx.beginPath(); bloomSub(u, so, p1, [.028, .03, .026, .04][k]); bloomSub(u, si, p2, .045); ctx.fillStyle = rgba(col, P.rimA * (k < 2 ? 1 : .8) * A); ctx.fill('evenodd');
  });
  if (!P.strokes) return;
  // 回流：沿边缘内侧几条短笔，带飞白
  withSeed(P.seed, () => { for (let i = 0; i < 9; i++) {
    const a0 = rnd(0, TAU), span = rnd(.35, .8), d = rnd(.8, .92), w = rnd(6, 11), pts = [];
    for (let k = 0; k <= 18; k++) { const th = a0 + span * k / 18, r = bloomR(th, u) * d * (1 + .012 * Math.sin(k * .6 + i)); pts.push([Math.cos(th) * r, Math.sin(th) * r]); }
    drawS(ctx, mk(pts, w, pick([P.rim, P.deep]), { prof: rnd() < .5 ? 'leaf' : 'brush', nb: 4, a: rnd(.12, .2), rough: .15 }), 1, null, A * (P.sA ?? 1));
  } });
}
function drawBloom(t) {
  const u = t - T.drop; if (u < 0) return;
  const fadeA = 1 - .72 * ss(seg(t, T.head, 4.5));
  worldT();
  pooledBloom(u, fadeA, { body: VER2, bodyA: .1, rim: VER, deep: VERD, rimA: .1, strokes: true, seed: 211 });
  for (const g of BLOOM.gran) { const r = bloomR(g.a, u) * g.d; if (g.d > .96) continue; ctx.fillStyle = rgba(VERD, .13 * fadeA); ctx.beginPath(); ctx.arc(Math.cos(g.a) * r, Math.sin(g.a) * r, g.r * .7, 0, TAU); ctx.fill(); }
  // 溅出的颜料点：每个由两三下不规则的短笔叠成，不是正圆
  const gr = 1 + .5 * ss(seg(u, 0, 1));
  BLOOM.sat.forEach((s0, i) => withSeed(300 + i, () => {
    const cx = Math.cos(s0.a) * s0.d, cy = Math.sin(s0.a) * s0.d, r = s0.r * gr, nS = 2 + (i % 2);
    for (let k = 0; k < nS; k++) { const a = rnd(0, TAU), l = r * rnd(1.1, 2.2), ox = rnd(-.5, .5) * r, oy = rnd(-.5, .5) * r;
      drawS(ctx, mk(qcurve(cx + ox - Math.cos(a) * l / 2, cy + oy - Math.sin(a) * l / 2, cx + ox + Math.cos(a) * l / 2, cy + oy + Math.sin(a) * l / 2, rnd(-r, r) * .4, 5), r * rnd(1.2, 1.9), k ? VER : VER2, { prof: 'leaf', nb: 0, a: rnd(.3, .5), rough: .5 }), 1, null, fadeA); }
  }));
  if (u < .3) { const k = u / .3;   // 落纸瞬间溅开的一圈短笔
    withSeed(330, () => { for (let i = 0; i < 16; i++) { const a = i / 16 * TAU + hash(i) * .4, r = 12 + (55 + 30 * hash(i + 9)) * eo(k), l = (5 + 6 * hash(i + 3)) * (1 - k) + 1;
      drawS(ctx, mk(polar(Math.cos(a) * r, Math.sin(a) * r, a, l, rnd(-1, 1), 4), 3.2 * (1 - k) + 1, VER2, { prof: 'tip', nb: 0, a: .6, rough: .4 }), 1, null, 1 - k); } });
  }
}
function drawDrop(t) {
  if (t >= T.drop) return;
  const u = clamp(t / T.drop), y = dropY(t); worldT();
  ctx.fillStyle = rgba('#5d5048', .22 * u * u); ctx.beginPath(); ctx.ellipse(-y * .06, 0, 8 + 4 * (1 - u), 6 + 3 * (1 - u), 0, 0, TAU); ctx.fill();
  const st = 1 + .9 * u; ctx.save(); ctx.translate(0, y);
  ctx.fillStyle = rgba(VER, .92); ctx.beginPath(); ctx.ellipse(0, 0, 7.5, 7.5 * st, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = rgba(VERD, .5); ctx.beginPath(); ctx.ellipse(1.5, 2 * st, 5, 4.5 * st, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = rgba(VERL, .9); ctx.beginPath(); ctx.ellipse(-2.4, -2.6 * st, 2, 2.4 * st, 0, 0, TAU); ctx.fill();
  ctx.restore();
}

// ---------- 绘制：水 ----------
function drawPond(t) {
  const rx = 420 + 2000 * eo(seg(t, T.head, 4.5)); worldT();
  ctx.save(); ctx.beginPath(); ctx.moveTo(-1000, -800);
  for (let y = -800; y <= 800; y += 40) ctx.lineTo(rx + (vnoise(y * .01 + 3) - .5) * 160, y);
  ctx.lineTo(-1000, 800); ctx.closePath(); ctx.clip();
  ctx.drawImage(POND.cv, POND.x0, POND.y0, POND.w, POND.h); ctx.restore();
}
function drawBands(t) {
  for (const B of BANDS) {
    const p = seg(t, B.t, B.t + 1.0); if (p <= 0) continue;
    const [vx0, , vx1] = viewRect(50); if (B.cvs.x0 + B.cvs.w < vx0 || B.x0 - 80 > vx1) continue;
    const R = 3000 * eo(p) + 20, ox = B.x0, oy = B.oy; worldT();
    const sub = (RR, ph) => { for (let i = 0; i <= 72; i++) { const a = i / 72 * TAU, r = RR * (1 + .07 * Math.sin(a * 5 + ph) + .05 * Math.sin(a * 11 + ph * 2)); i ? ctx.lineTo(ox + Math.cos(a) * r, oy + Math.sin(a) * r) : ctx.moveTo(ox + Math.cos(a) * r, oy + Math.sin(a) * r); } ctx.closePath(); };
    ctx.save(); if (p < 1) { ctx.beginPath(); sub(R, B.ph); ctx.clip(); }
    ctx.drawImage(B.cvs.cv, B.cvs.x0, B.cvs.y0, B.cvs.w, B.cvs.h); ctx.restore();
    if (p < 1) for (const [k, ph] of [[.955, B.ph2], [.975, B.ph2 + 1.3]]) {   // 湿的前沿：颜料往前推，积在边上（同一张色带再叠一遍，只在一条宽窄不一的环带里）
      ctx.save(); ctx.beginPath(); sub(R, B.ph); sub(R * k, ph); ctx.clip('evenodd'); ctx.globalAlpha = .5 * (1 - p); ctx.drawImage(B.cvs.cv, B.cvs.x0, B.cvs.y0, B.cvs.w, B.cvs.h); ctx.restore(); }
  }
}
// 涟漪：断成几段的毛笔弧，宽窄随圆周变化、带飞白；种子固定，所以同一圈涟漪逐帧不闪
function ring(cx, cy, r, a, lw, sq = .82, seed = 1) {
  if (a <= .01) return;
  withSeed(4000 + seed, () => {
    for (const k of [1, .95]) {
      let th = rnd(0, TAU); const end = th + TAU - .25;
      for (let g = 0; g < 9 && th < end; g++) {
        const span = rnd(.45, 1.15), th1 = Math.min(th + span, end), n = Math.max(4, Math.round(span * 12)), pts = [];
        for (let i = 0; i <= n; i++) { const q = th + (th1 - th) * i / n, rr = r * k * (1 + .025 * Math.sin(q * 3 + seed)); pts.push([cx + Math.cos(q) * rr, cy + Math.sin(q) * rr * sq]); }
        const w = lw * (k === 1 ? 1 : .6) * rnd(1.3, 2.4);
        drawS(ctx, mk(pts, w, k === 1 ? RIPPLE : WATER2, { prof: rnd() < .5 ? 'even' : 'tip', nb: 3, a: rnd(.75, 1), rough: .45 }), 1, null, a);
        th = th1 + rnd(.12, .4);
      }
    }
  });
}
function tailTip(tt) { const K = koiSpine(tt), N = spineNormals(K.P); return mapPt(K.P, N, K.sc, 600, 0); }
function drawWake(t) {
  worldT();
  for (const tk of TL.FLICKS) { const u = (t - tk) / 1.3; if (u < 0 || u > 1) continue; const [x, y] = tailTip(tk); ring(x, y, 12 + 70 * eo(u), .42 * (1 - u), 2.2, .82, Math.round(tk * 100)); }
  if (t > T.dive && t < T.dive + 1.6) { const u = (t - T.dive) / 1.6, sp = koiSpine(T.dive), [x, y] = sp.P[10]; ring(x, y, 20 + 170 * eo(u), .45 * (1 - u), 2.6, .82, 2001); ring(x, y, 10 + 90 * eo(u), .3 * (1 - u), 1.8, .82, 2002); }
}

// ---------- 绘制：锦鲤 ----------
function drawKoi(t) {
  if (t < T.head || t > 15.1) return;
  const K = koiSpine(t), N = spineNormals(K.P), a = koiAlpha(t); if (a <= 0) return;
  worldT(); ctx.globalAlpha = a;
  const p = seg(t, T.head, T.head + 1.3);
  const list = KOI.S.map(s => bendStroke(s, K.P, N, K.sc, t));
  drawList(ctx, list, p);
  const pe = seg(t, T.eye, T.eye + .1); if (pe > 0) for (const e of KOI.EYES) drawS(ctx, bendStroke(e, K.P, N, K.sc, t), pe);
  ctx.globalAlpha = 1;
}
function drawLeapFx(t) {
  if (t < T.leap || t > 16.4) return;
  worldT(); const [cx, cy] = LEAP0, u = t - T.leap;
  // 水面上的影子：三圈叠色，外圈渐淡，边缘相位各不相同
  const sa = .3 * (1 - ss(seg(t, T.leap, T.burst)));
  if (sa > 0) { ctx.save(); ctx.translate(cx, cy); ctx.rotate(LEAP0[2]);
    [[1.38, .16, .3], [1.2, .24, 1.9], [1.04, .32, 3.4], [.86, .3, 4.8]].forEach(([k, al, ph]) => {
      ctx.beginPath(); for (let i = 0; i <= 64; i++) { const th = i / 64 * TAU, j = _jr(th, ph, .07); i ? ctx.lineTo(Math.cos(th) * 230 * k * j, Math.sin(th) * 70 * k * j) : ctx.moveTo(Math.cos(th) * 230 * k * j, Math.sin(th) * 70 * k * j); }
      ctx.closePath(); ctx.fillStyle = rgba('#53646d', sa * al * 1.1); ctx.fill(); });
    ctx.restore(); }
  for (let k = 0; k < 3; k++) { const v = (u - k * .09) / 1.4; if (v > 0 && v < 1) ring(cx, cy, 60 + 520 * eo(v), .5 * (1 - v), 3.2 * (1 - v) + 1, .7, 2200 + k); }
  // 水冠飞溅：每滴一笔尖笔，半透明叠色
  SPLASH.forEach((d, i) => {
    const w = u - d.dl; if (w <= 0 || w > 1.1) return; const r = d.v0 * (1 - Math.exp(-3.2 * w)) / 3.2 + 40, lift = -Math.sin(Math.min(1, w / .9) * Math.PI) * 90;
    const x = cx + Math.cos(d.a) * r * 1.2, y = cy + Math.sin(d.a) * r * .8 + lift, al = .8 * (1 - ss(seg(w, .55, 1.1))), l = d.sz * 2.6 * (1.2 - w) + 3;
    withSeed(2300 + i, () => drawS(ctx, mk(qcurve(x, y, x - Math.cos(d.a) * l, y - Math.sin(d.a) * l * .7 + 2, rnd(-2, 2), 5), d.sz * (1.25 - .5 * w), d.col, { prof: 'tip', nb: d.sz > 8 ? 2 : 0, a: .7, rough: .4 }), 1, null, al));
  });
}
function lotusCenter() { return [LEAP0[0], LEAP0[1] - 150]; }
function drawLotus(t) {
  if (t < T.burst) return;
  const [cx, cy] = lotusCenter(), u = t - T.burst, op = .76 + .24 * eo(seg(t, T.burst, T.bloom));
  // 炸开时的一圈湿晕（与开场的那滴呼应），留在红莲下面
  { const k = eo(seg(t, T.burst, T.burst + .9)), sc = (110 + 250 * k) / 107; worldT(); ctx.translate(cx, cy); ctx.rotate(1.3); ctx.scale(sc, sc);
    pooledBloom(3, 1, { body: VERL, bodyA: .055, rim: VER2, deep: VER, rimA: .045 + .05 * (1 - k), strokes: true, sA: .45, seed: 251 }); }
  worldT(); ctx.translate(cx, cy); ctx.rotate(.18 + .012 * Math.sin(1.15 * t) + .05 * (1 - eo(seg(t, T.burst, T.bloom)))); ctx.scale(op, op);
  if (u > .95 && LOTUS_SPR) { ctx.drawImage(LOTUS_SPR.cv, LOTUS_SPR.x0, LOTUS_SPR.y0, LOTUS_SPR.w, LOTUS_SPR.h); }
  else for (const it of LOTUS) drawS(ctx, it.s, seg(u, it.d, it.d + .35));
  // 炸开的颜料点：一笔一点的短笔，不是正圆
  worldT();
  BDOTS.forEach((d, i) => {
    const w = u; if (w > .9) return; const r = d.v0 * (1 - Math.exp(-4 * w)) / 4 + 60, x = cx + Math.cos(d.a) * r, y = cy + Math.sin(d.a) * r;
    withSeed(2400 + i, () => drawS(ctx, mk(polar(x, y, d.a + rnd(-.6, .6), d.sz * rnd(1.2, 2.2), rnd(-1, 1), 4), d.sz * 1.7, d.col, { prof: 'leaf', nb: 0, a: .75, rough: .5 }), 1, null, 1 - ss(seg(w, .3, .9))));
  });
}
function drawDrips(t) {   // 水珠落回：小涟漪
  worldT(); const [cx, cy] = lotusCenter();
  TL.DROPS.forEach((td, i) => { const u = (t - td) / 1.0; if (u < 0 || u > 1) return; const a = hash(i * 7.3) * TAU, d = 360 + hash(i * 3.1) * 260; ring(cx + Math.cos(a) * d, cy + Math.sin(a) * d * .8, 6 + 46 * eo(u), .5 * (1 - u), 2, .82, 2100 + i); });
}

// ---------- 雾、手札、图例、题字与印 ----------
function drawMist(t) {
  const c = eio(seg(t, T.mist, T.mist + 1.0)); if (c <= 0) return;
  for (const [lift, a] of [[150, .6], [0, .82]]) {
    const top = 1200 - c * 1500 - lift; screenT();
    ctx.save(); ctx.beginPath(); ctx.moveTo(-10, 1100);
    for (let x = -10; x <= 1960; x += 40) ctx.lineTo(x, top + (vnoise(x * .006 + lift) - .5) * 170 + Math.sin(x * .01 + t * 1.3) * 14);
    ctx.lineTo(1930, 1100); ctx.closePath(); ctx.clip(); ctx.globalAlpha = a; drawPaper(); ctx.restore(); ctx.globalAlpha = 1;
  }
}
function hand(txt, x, y, p, o = {}) {
  if (p <= 0) return; screenT();
  ctx.save(); ctx.font = o.font || `400 ${o.size || 52}px "Long Cang"`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  if (o.ls) ctx.letterSpacing = o.ls;
  const w = ctx.measureText(txt).width; ctx.beginPath(); ctx.rect(x - 8, y - 60, (w + 16) * eo(p), 120); ctx.clip();
  ctx.shadowColor = rgba(PAP, .95); ctx.shadowBlur = 12; ctx.fillStyle = rgba(o.col || INK, o.a ?? .88); ctx.fillText(txt, x, y); ctx.fillText(txt, x, y);
  ctx.restore();
}
function leader(x0, y0, x1, y1, p, bend = 20, a = .72) {
  if (p <= 0) return; screenT();
  const pts = qcurve(x0, y0, x1, y1, bend, 16), m = Math.max(1, Math.round(16 * clamp(p)));
  ctx.beginPath(); for (let i = 0; i <= m; i++) i ? ctx.lineTo(pts[i][0], pts[i][1]) : ctx.moveTo(pts[i][0], pts[i][1]);
  ctx.strokeStyle = rgba(INK, a); ctx.lineWidth = 1.7; ctx.lineCap = 'round'; ctx.stroke();
  if (p >= 1) { ctx.beginPath(); ctx.arc(x1, y1, 3, 0, TAU); ctx.fillStyle = rgba(INK, a); ctx.fill(); }
}
const NOTE1 = { t0: T.note1, t1: 4.5 }, NOTE2 = { t0: T.note2, t1: 9.3 };
function note1Pos() { const [ax, ay] = W2S(bloomR(-.55, Math.max(0, CAM._t - T.drop)) * Math.cos(-.55) * .96, bloomR(-.55, Math.max(0, CAM._t - T.drop)) * Math.sin(-.55) * .96); return { ax, ay, lx: Math.min(ax + 150, 1560), ly: Math.max(ay - 170, 150) }; }
function note2Pos(t) { const K = koiSpine(t), N = spineNormals(K.P), [hx, hy] = mapPt(K.P, N, K.sc, 40, 0), [ax, ay] = W2S(hx, hy); return { ax, ay, lx: ax + 150, ly: ay - 230 }; }
function drawNotes(t) {
  if (t >= NOTE1.t0 && t < NOTE1.t1) {
    const f = 1 - ss(seg(t, NOTE1.t1 - .4, NOTE1.t1)), P = note1Pos(); ctx.globalAlpha = f;
    leader(P.lx - 10, P.ly + 34, P.ax, P.ay, seg(t, NOTE1.t0, NOTE1.t0 + .45), 22);
    hand('朱砂一滴', P.lx, P.ly, seg(t, NOTE1.t0 + .15, NOTE1.t0 + 1.0), { size: 56 });
    hand('Ø 6 mm', P.lx + 4, P.ly + 52, seg(t, NOTE1.t0 + .7, NOTE1.t0 + 1.1), { font: '400 19px "IBM Plex Mono"', ls: '3px', a: .7, col: '#5b4a3c' });
    ctx.globalAlpha = 1;
  }
  if (t >= NOTE2.t0 && t < NOTE2.t1) {
    const f = 1 - ss(seg(t, NOTE2.t1 - .4, NOTE2.t1)), P = note2Pos(t); ctx.globalAlpha = f;
    leader(P.lx - 8, P.ly + 32, P.ax, P.ay, seg(t, NOTE2.t0, NOTE2.t0 + .4), -18);
    hand('锦鲤', P.lx, P.ly, seg(t, NOTE2.t0 + .1, NOTE2.t0 + .75), { size: 60 });
    ctx.globalAlpha = 1;
  }
}
const LEG_T0 = T.spring, LEG_T1 = T.dive + .3;
function legendIdx() { return clamp((headX(CAM._t) - 2300) / 900, 0, 3.999); }
function drawLegend(t) {
  if (t < LEG_T0 || t > LEG_T1) return; screenT();
  const f = 1 - ss(seg(t, LEG_T1 - .3, LEG_T1)); ctx.globalAlpha = f;
  const k = legendIdx();
  LEG.forEach((g, i) => {
    drawS(ctx, g.st, seg(t, LEG_T0 + i * .06, LEG_T0 + .3 + i * .06));
    const on = 1 - clamp(Math.abs(Math.floor(k) - i)), al = .4 + .55 * on;
    hand(g.name, 106 + i * 86, 138, seg(t, LEG_T0 + .05, LEG_T0 + .3), { size: 42, a: al });
    hand(g.mono, 98 + i * 86, 176, seg(t, LEG_T0 + .1, LEG_T0 + .35), { font: '400 13px "IBM Plex Mono"', ls: '1px', a: .45 + .3 * on, col: '#5b4a3c' });
  });
  const x = Math.min(96 + k * 86 + 4, 96 + 3 * 86 + 64);   // 标记：鱼在色带里的位置（一点朱红短笔）
  withSeed(171, () => drawS(ctx, mk(qcurve(x - 6, 64, x + 6, 65, 1, 5), 13, VER, { prof: 'leaf', nb: 0, a: .9, rough: .35 }), seg(t, LEG_T0 + .2, LEG_T0 + .4)));
  ctx.globalAlpha = 1;
}
const TITLE = '一滴朱红', TX = 1340, TY = 236, TSTEP = 108, TFS = 80, SEALSZ = 166;
function drawTitle(t) {
  if (t < T.mist) return; screenT();
  const p = eo(seg(t, T.mist, T.seal)); ctx.save();
  ctx.beginPath(); ctx.rect(TX - 80, TY - 62, 160, (TSTEP * 4 + 14) * p); ctx.clip();
  ctx.font = `500 ${TFS}px "Noto Serif SC"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.shadowColor = rgba(PAP, .95); ctx.shadowBlur = 16; ctx.fillStyle = rgba(INK, .86);
  for (let i = 0; i < 4; i++) { ctx.fillText(TITLE[i], TX, TY + i * TSTEP); ctx.fillText(TITLE[i], TX, TY + i * TSTEP); }
  ctx.restore();
  if (t >= T.seal) {
    const u = seg(t, T.seal, T.seal + .14), s = 1 + .14 * (1 - eo(u)), sz = SEALSZ;
    ctx.save(); ctx.translate(TX, TY + TSTEP * 4 + 84); ctx.scale(s, s); ctx.rotate(-.025); ctx.globalAlpha = .92 * ss(seg(t, T.seal, T.seal + .05));
    ctx.drawImage(SEAL, -sz / 2 - 24, -sz / 2 - 24, sz + 48, sz + 48); ctx.restore(); ctx.globalAlpha = 1;
  }
}
function drawGhost(t) {   // 雾过后留在纸上的红莲淡影（≈0.2）
  if (t < T.mist || !LOTUS_SPR) return; const g = .2 * ss(seg(t, T.mist + .45, T.mist + 1.05)); if (g <= 0) return;
  const [cx, cy] = lotusCenter(); worldT(); ctx.translate(cx, cy); ctx.rotate(.18 + .012 * Math.sin(1.15 * t)); ctx.globalAlpha = g;
  ctx.drawImage(LOTUS_SPR.cv, LOTUS_SPR.x0, LOTUS_SPR.y0, LOTUS_SPR.w, LOTUS_SPR.h); ctx.globalAlpha = 1;
}
function drawVignette() { screenT(); ctx.fillStyle = VIGN; ctx.fillRect(0, 0, 1920, 1080); }

// ---------- render ----------
function render(t) {
  CAM = camAt(t); CAM._t = t;
  screenT(); ctx.globalAlpha = 1; ctx.fillStyle = PAP; ctx.fillRect(0, 0, 1920, 1080);
  drawPaper();
  drawPond(t); drawBands(t); drawBloom(t); drawWake(t);
  for (const ob of OBJ) drawObj(ob, t);
  drawLeapFx(t); drawKoi(t); drawDrop(t); drawLotus(t); drawDrips(t);
  drawMist(t); drawGhost(t); drawVignette();
  drawNotes(t); drawLegend(t); drawTitle(t);
  screenT();
}
window.render = render;

// ---------- 画内文字（readcheck） ----------
function textBox(txt, font, x, y, ls) { ctx.save(); ctx.font = font; if (ls) ctx.letterSpacing = ls; const w = ctx.measureText(txt).width; ctx.restore(); return [x, y - 30, x + w, y + 30]; }
window.TEXTS = t => {
  const out = []; CAM = camAt(t); CAM._t = t;
  if (t >= NOTE1.t0 + .15 && t < NOTE1.t1 - .4) { const P = note1Pos(); const b = textBox('朱砂一滴', '400 56px "Long Cang"', P.lx, P.ly); out.push({ id: 'note1', text: '朱砂一滴', x0: b[0], y0: b[1], x1: b[2], y1: b[3] }); const m = textBox('Ø 6 mm', '400 19px "IBM Plex Mono"', P.lx + 4, P.ly + 52, '3px'); out.push({ id: 'note1m', text: 'Ø 6 mm', x0: m[0], y0: m[1] + 18, x1: m[2], y1: m[3] - 18 }); }
  if (t >= NOTE2.t0 + .1 && t < NOTE2.t1 - .4) { const P = note2Pos(t); const b = textBox('锦鲤', '400 60px "Long Cang"', P.lx, P.ly); out.push({ id: 'note2', text: '锦鲤', x0: b[0], y0: b[1], x1: b[2], y1: b[3] }); }
  if (t >= LEG_T0 + .05 && t < LEG_T1 - .3) SEASONS.forEach((g, i) => { out.push({ id: 'leg' + i, text: g.name, x0: 106 + i * 86, y0: 110, x1: 150 + i * 86, y1: 166 }); out.push({ id: 'legm' + i, text: g.mono, x0: 98 + i * 86, y0: 168, x1: 170 + i * 86, y1: 184 }); });
  if (t >= T.mist) out.push({ id: 'title', text: TITLE, x0: TX - 44, y0: TY - 44, x1: TX + 44, y1: TY + TSTEP * 3 + 44 });
  if (t >= T.seal) out.push({ id: 'seal', text: '鲤', x0: TX - 83, y0: TY + TSTEP * 4 + 1, x1: TX + 83, y1: TY + TSTEP * 4 + 167 });
  return out;
};

// ---------- 事件（拟音由此驱动；时间全部取自 TL） ----------
function panAt(wx, wy, t) { const c = camAt(t); return clamp(((wx - c.x) * c.z) / 960 * .7, -.8, .8); }
function buildEV() {
  const E = [];
  E.push({ t: 0, type: 'fall', dur: T.drop });
  E.push({ t: T.drop, type: 'drop', hit: 'drop' }, { t: T.drop, type: 'soak', dur: 2.2 });
  E.push({ t: T.note1, type: 'write', dur: 1.0, n: 5, pan: .45, hit: 'note1' });
  E.push({ t: T.head, type: 'brush', dur: 1.3, g: .55, pan0: -.2, pan1: .4, hit: 'head' });
  E.push({ t: T.eye, type: 'eye', hit: 'eye' });
  TL.FLICKS.forEach((tk, i) => { const [x, y] = tailTip(tk); E.push({ t: tk, type: 'flick', g: tk < 7.5 ? .5 : .62, pan: panAt(x, y, tk), hit: i === 0 ? 'flick1' : null }); });
  ['leaf1', 'leaf2', 'leaf3', 'leaf4'].forEach(k => { const ob = OBJ.find(o => o.t0 === T[k]); E.push({ t: T[k], type: 'brush', dur: .6, g: .42, pan0: panAt(ob.wx - 150, 0, T[k]), pan1: panAt(ob.wx + 150, 0, T[k]), hit: k }); });
  E.push({ t: T.note2, type: 'write', dur: .7, n: 3, pan: .3, hit: 'note2' });
  E.push({ t: T.gear, type: 'gear', hit: 'gear' });
  for (const S0 of SEASONS) { E.push({ t: S0.t, type: 'band', season: S0.id, hit: S0.id }); E.push({ t: S0.t + .5, type: 'brush', dur: .4, g: .3, pan0: .2, pan1: .7, hit: S0.id + '2' }); }
  E.push({ t: T.spring - .5, type: 'amb', season: 'spring', dur: 1.8 }, { t: T.summer - .5, type: 'amb', season: 'summer', dur: 1.8 }, { t: T.autumn - .5, type: 'amb', season: 'autumn', dur: 1.8 }, { t: T.winter - .5, type: 'amb', season: 'winter', dur: 1.75 });
  E.push({ t: T.dive, type: 'dive', hit: 'dive' }, { t: T.hush, type: 'hush', dur: T.leap - T.hush, hit: 'hush' });
  E.push({ t: T.leap, type: 'leap', hit: 'leap' }, { t: T.burst, type: 'burst', hit: 'burst' }, { t: T.bloom, type: 'bloom', hit: 'bloom' });
  TL.DROPS.forEach((td, i) => E.push({ t: td, type: 'plink', i, pan: (hash(i * 7.3) - .5) * 1.2 }));
  E.push({ t: T.mist, type: 'mist', dur: 1.0, hit: 'mist' }, { t: T.mist, type: 'write', dur: .75, n: 6, pan: .35 });
  E.push({ t: T.seal, type: 'seal', pan: .35, hit: 'seal' });
  return E.sort((a, b) => a.t - b.t);
}

// ---------- init ----------
(async () => {
  PAPER_IMG = new Image(); PAPER_IMG.src = 'paper.png'; await PAPER_IMG.decode();
  PAPER_PAT = ctx.createPattern(PAPER_IMG, 'repeat');
  await Promise.all(['400 56px "Long Cang"', '500 80px "Noto Serif SC"', '700 128px "Noto Serif SC"', '400 19px "IBM Plex Mono"'].map(f => document.fonts.load(f, f.includes('Mono') ? 'Ø 6 mm' : f.includes('Long') ? '朱砂一滴锦鲤春夏秋冬' : '一滴朱红鲤')));
  VIGN = ctx.createRadialGradient(960, 540, 300, 960, 540, 1150); VIGN.addColorStop(0, 'rgba(70,50,30,0)'); VIGN.addColorStop(1, 'rgba(70,50,30,0.07)');
  build();
  // 红莲精灵（炸开完成后用）
  { const L2 = LOTUS.map(i => i.s); LOTUS_SPR = sprite2(L2, 2); }
  window.EV = buildEV();
  window.READY = true;
})();
