// 真实扩散的显影遮罩。
// 在粗网格上以"带纸纤维噪声的各向异性速度场"跑 Dijkstra，得到每个像素被墨/颜料前沿到达的时间（0..1），
// 再双线性放大到显示分辨率并叠加细纤维噪声。每帧按进度 p 取阈值：p 以 √t 推进（扩散律），前沿处有一圈潮线。
import { mulberry, vnoise } from '/core/lib.js';

function n2(x, y, s) { // 2D value noise from 1D helper
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const h = (a, b2) => { const v = Math.sin((a * 127.1 + b2 * 311.7 + s * 74.7)) * 43758.5453; return v - Math.floor(v); };
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v) + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
}
function fbm(x, y, s) { let a = 0, w = .5; for (let i = 0; i < 4; i++) { a += w * n2(x, y, s + i * 17); x *= 2.03; y *= 2.03; w *= .5; } return a; }

// 二叉堆
class Heap { constructor() { this.k = []; this.v = []; }
  push(key, val) { const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; }
  pop() { const k = this.k, v = this.v, top = v[0], last = k.pop(), lv = v.pop(); const n = k.length;
    if (n) { let i = 0; while (true) { let l = 2 * i + 1; if (l >= n) break; const r = l + 1; if (r < n && k[r] < k[l]) l = r; if (k[l] >= last) break; k[i] = k[l]; v[i] = v[l]; i = l; } k[i] = last; v[i] = lv; }
    return top; }
  get size() { return this.k.length; } }

// opts: w,h（显示尺寸 px），cell（网格 px），seeds [[x,y,t0]]（局部 px，t0 起始延迟），
// aniso [ax, ay]（方向速度倍率），grain（细噪声幅度），seed，fib（纤维尺度）
export function arrival(o) {
  const cell = o.cell ?? 4, gw = Math.ceil(o.w / cell) + 1, gh = Math.ceil(o.h / cell) + 1, N = gw * gh;
  const sp = new Float32Array(N), T = new Float32Array(N).fill(1e9);
  const s = o.seed ?? 1, fib = o.fib ?? 1;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const x = i * cell, y = j * cell;
    // 纸纤维：拉长的噪声（水平纤维 + 斜纤维）+ 大尺度湿度斑
    // 宣纸：大尺度湿度（决定指状渗流的通道）+ 中尺度纤维团 + 细纤维（略带方向）
    const m = fbm(x / 150, y / 150, s + 3), f = fbm(x * fib / 38, y * fib / 38, s), fb = fbm((x * .9 + y * .4) * fib / 9, (y * .9 - x * .4) * fib / 40, s + 9);
    sp[j * gw + i] = Math.max(.08, .14 + 2.4 * Math.pow(m, 2.6) + .45 * Math.pow(f, 1.5) + .18 * fb + (o.bias ? o.bias(x, y) : 0));
  }
  const H = new Heap();
  for (const [sx, sy, t0] of o.seeds) { const i = Math.round(sx / cell), j = Math.round(sy / cell); if (i < 0 || j < 0 || i >= gw || j >= gh) continue; const id = j * gw + i; T[id] = Math.min(T[id], t0 || 0); H.push(T[id], id); }
  const ax = (o.aniso ?? [1, 1])[0], ay = (o.aniso ?? [1, 1])[1];
  // 16 邻域（含"马步"），减轻网格造成的八边形/方块感；方向速度按分量混合
  const NB = [];
  for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1], [2, 1], [1, 2], [2, -1], [1, -2]]) for (const sg of [1, -1]) {
    const a = (Math.abs(di) * ax + Math.abs(dj) * ay) / (Math.abs(di) + Math.abs(dj)); NB.push([di * sg, dj * sg, a]);
  }
  while (H.size) {
    const id = H.pop(), t = T[id]; const i = id % gw, j = (id / gw) | 0;
    for (const [di, dj, a] of NB) {
      const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= gw || nj >= gh) continue;
      const nid = nj * gw + ni, d = Math.hypot(di, dj) * cell;
      const mid = ((j + (dj >> 1)) * gw + (i + (di >> 1)));
      const v = (sp[id] + sp[nid] + (Math.abs(di) + Math.abs(dj) > 2 ? sp[mid] : sp[nid])) / 3 * a;
      const nt = t + d / v;
      if (nt < T[nid]) { T[nid] = nt; H.push(nt, nid); }
    }
  }
  let mx = 0; for (let k = 0; k < N; k++) if (T[k] < 1e8 && T[k] > mx) mx = T[k];
  // 放大到显示分辨率 + 细纤维噪声
  const W = Math.ceil(o.w), Hh = Math.ceil(o.h), A = new Float32Array(W * Hh), g = o.grain ?? .012, R = mulberry(s * 977 + 3);
  const noise = new Float32Array(64 * 64); for (let k = 0; k < noise.length; k++) noise[k] = R() - .5;
  for (let y = 0; y < Hh; y++) {
    const gy = y / cell, j0 = Math.min(gh - 2, Math.floor(gy)), fy = gy - j0;
    for (let x = 0; x < W; x++) {
      const gx = x / cell, i0 = Math.min(gw - 2, Math.floor(gx)), fx = gx - i0;
      const a00 = T[j0 * gw + i0], a10 = T[j0 * gw + i0 + 1], a01 = T[(j0 + 1) * gw + i0], a11 = T[(j0 + 1) * gw + i0 + 1];
      let v = ((a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy) / mx;
      v += g * (noise[(y & 63) * 64 + (x & 63)] + .6 * Math.sin(x * .9 + y * .13 + noise[((y >> 2) & 63) * 64 + ((x >> 3) & 63)] * 6));
      A[y * W + x] = v;
    }
  }
  return { w: W, h: Hh, A };
}

// 每帧：p（进度，可 >1），wdt（软边宽），返回 {mask canvas（alpha=显影）, band canvas（alpha=潮线）}
export function makeMasker(F, o = {}) {
  const mc = document.createElement('canvas'); mc.width = F.w; mc.height = F.h;
  const bc = document.createElement('canvas'); bc.width = F.w; bc.height = F.h;
  const mx = mc.getContext('2d'), bx = bc.getContext('2d');
  const mi = mx.createImageData(F.w, F.h), bi = bx.createImageData(F.w, F.h);
  const md = mi.data, bd = bi.data, A = F.A, n = F.w * F.h;
  let lastP = -1;
  const wdt = o.wdt ?? .03, bandW = o.bandW ?? .035, bandA = o.bandA ?? .55;
  return function (p) {
    if (p === lastP) return { mask: mc, band: bc };
    lastP = p;
    const full = p >= 1 + wdt + bandW * 2;
    for (let k = 0, q = 0; k < n; k++, q += 4) {
      const d = p - A[k];
      const m = d <= 0 ? 0 : d >= wdt ? 1 : d / wdt;
      md[q + 3] = m * 255;
      if (!full && d > -wdt * .3) {
        const e = (d - bandW * .5) / bandW; const bnd = Math.exp(-e * e) * bandA;
        bd[q + 3] = bnd * 255;
      } else bd[q + 3] = 0;
    }
    mx.putImageData(mi, 0, 0); bx.putImageData(bi, 0, 0);
    return { mask: mc, band: bc };
  };
}

// 扩散律进度：u∈[0,1] → p∈[0, pmax]
export const diffuse = (u, pmax = 1.1) => pmax * Math.sqrt(Math.max(0, Math.min(1, u)));
