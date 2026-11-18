// Kuwahara 对拍用的合成输入：色块 + 斜纹渐变 + 确定性噪点 + 灯点保护区（alpha = 保护量）。纯函数，Node 与浏览器共用，两边吃同一份字节。
// 行序自上而下（第 0 行在最上）。
export function kuwaharaInput(w, h) {
  const px = new Uint8Array(w * h * 4);
  const hash = (x, y) => { let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967295; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let r, g, b;
    if (x < w / 3) { r = 200; g = 90; b = 60; }
    else if (x < (2 * w) / 3) { r = 60 + (255 - 60) * (x + y) / (w + h); g = 140; b = 200 - 100 * (y / h); }
    else { r = 40; g = 60 + 150 * (y / h); b = 90; }
    const n = (hash(x, y) - 0.5) * 36;
    px[i] = r + n; px[i + 1] = g + n; px[i + 2] = b + n;
    const d = Math.hypot(x - 0.8 * w, y - 0.3 * h);
    px[i + 3] = d < 0.05 * w ? 255 : d < 0.09 * w ? Math.round(255 * (1 - (d - 0.05 * w) / (0.04 * w))) : 0;   // 灯点：中心全保护，向外 0
  }
  return px;
}

// 深度换半径对拍用的合成深度图：0..1 的透视深度（单通道 float，行序同上）。视距沿 x 从 5 铺到 100（跨过 farStart / farEnd 的过渡带），
// 右上角一块天空（深度 1，当作无穷远）。near / far 是相机近远面，与两边的相机一致。纯函数，Node 与浏览器共用。
export const KUWA_NEAR = 0.1, KUWA_FAR = 100;
export function kuwaharaDepth(w, h) {
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const z = 5 + 95 * (x / (w - 1));
    d[y * w + x] = x > 0.55 * w && y < 0.15 * h ? 1 : KUWA_FAR * (z - KUWA_NEAR) / (z * (KUWA_FAR - KUWA_NEAR));
  }
  return d;
}
