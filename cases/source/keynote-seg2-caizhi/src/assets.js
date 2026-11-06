// 素材加载与材质预处理（加载时一次性完成，之后每帧只取用）
import { mulberry } from '/core/lib.js';

export const cv = (w, h) => { const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h); return c; };

export function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image ' + src)); i.src = src; });
}

// 镜像拼接成 2 倍宽的无缝横向材质（世界坐标平铺用），可选整体调色（乘法，用于材质，不用于 IP 图）
// 横向无缝：裁掉边缘 40px 的瑕疵，再把尾部 X 像素与头部交叉淡化（周期 = 宽 - X），不做镜像（镜像会出现对称轴）
export function mirrored(img, tint, X = 420) {
  const m = 40, w = img.width - m * 2, h = img.height - m, P = w - X, c = cv(P, h), g = c.getContext('2d');
  g.drawImage(img, m, m / 2, w, h, 0, 0, w, h);          // 0..w（超出 P 的部分被裁）
  // 头部 0..X 与尾部 P..P+X 交叉淡化：头部画上尾部，alpha 从 1→0
  const tail = cv(X, h), tg = tail.getContext('2d'); tg.drawImage(img, m + P, m / 2, X, h, 0, 0, X, h);
  const mk = cv(X, h), mg = mk.getContext('2d'), gr = mg.createLinearGradient(0, 0, X, 0); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  mg.fillStyle = gr; mg.fillRect(0, 0, X, h); tg.globalCompositeOperation = 'destination-in'; tg.drawImage(mk, 0, 0);
  g.drawImage(tail, 0, 0);
  if (tint) { g.globalCompositeOperation = 'multiply'; g.fillStyle = tint; g.fillRect(0, 0, P, h); g.globalCompositeOperation = 'source-over'; }
  return c;
}

// 在屏幕上按世界坐标平铺一张横向无缝材质：screen x = wx - camX；纵向居中裁切
export function tileX(g, T, camX, x0 = 0, x1 = 1920, y0 = 0, y1 = 1080, scale = 1) {
  const tw = T.width, oy = (T.height - 1080 / scale) / 2;
  let wx = camX + x0, sx = x0;
  while (sx < x1) {
    let u = ((wx / scale) % tw + tw) % tw;
    const span = Math.min((tw - u) * scale, x1 - sx);
    g.drawImage(T, u, oy + y0 / scale, span / scale, (y1 - y0) / scale, sx, y0, span, y1 - y0);
    sx += span; wx += span;
  }
}

// 中性纹理颗粒（高通、去色，均值 128）：叠在 IP 图上 ≤12%，只带纹理不带颜色
export function neutralGrain(img, w = 1200, h = 720, blur = 6, gain = 3) {
  const a = cv(w, h), ga = a.getContext('2d'); ga.drawImage(img, 0, 0, w, h, 0, 0, w, h);
  const b = cv(w, h), gb = b.getContext('2d'); gb.filter = `blur(${blur}px)`; gb.drawImage(a, 0, 0);
  const A = ga.getImageData(0, 0, w, h), B = gb.getImageData(0, 0, w, h), d = A.data, e = B.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = .3 * d[i] + .55 * d[i + 1] + .15 * d[i + 2], m = .3 * e[i] + .55 * e[i + 1] + .15 * e[i + 2];
    const v = Math.max(0, Math.min(255, 128 + (l - m) * gain));
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ga.putImageData(A, 0, 0); return a;
}

// 程序化棉布：经纬 + 纤维 + 大尺度疏密（可平铺 1024）
export function clothTile(N = 1024, seed = 7) {
  const c = cv(N, N), g = c.getContext('2d'), I = g.createImageData(N, N), d = I.data, R = mulberry(seed);
  const nz = new Float32Array(128 * 128); for (let i = 0; i < nz.length; i++) nz[i] = R();
  const sm = (x, y) => { // 平铺 value noise（周期 128 格）
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const at = (a, b) => nz[((b & 127) * 128) + (a & 127)];
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const P = 2 * Math.PI / 3.2;   // 线距 3.2 px（N/3.2 须为整数：1024/3.2 = 320）
    const wx = Math.sin(x * P + sm(x / 8, y / 64) * 2.2), wy = Math.sin(y * P + sm(x / 64 + 40, y / 8) * 2.2);
    const th = .5 + .5 * wx * wy;
    const big = sm(x / 64, y / 64) - .5, fib = sm(x / 2, y / 24 + 9) - .5, slub = Math.max(0, sm(x / 3 + 70, y / 40) - .78) * 3;
    const k = 1 - .055 * th + .09 * big + .03 * fib - .05 * slub;
    d[(y * N + x) * 4] = 236 * k; d[(y * N + x) * 4 + 1] = 228 * k; d[(y * N + x) * 4 + 2] = 210 * k; d[(y * N + x) * 4 + 3] = 255;
  }
  g.putImageData(I, 0, 0); return c;
}

// 屏幕平铺一张方形可平铺纹理（世界锚定）
export function tile2(g, T, camX, x0, y0, x1, y1) {
  const N = T.width;
  for (let sy = y0 - (((y0) % N) + N) % N; sy < y1; sy += N) {
    const wx0 = camX + x0; let u = ((wx0 % N) + N) % N, sx = x0;
    while (sx < x1) { const span = Math.min(N - u, x1 - sx); g.drawImage(T, u, 0, span, N, sx, sy, span, N); sx += span; u = 0; }
  }
}
