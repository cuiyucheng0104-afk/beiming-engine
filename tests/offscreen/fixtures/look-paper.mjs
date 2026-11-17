// 图片纸纹对拍用的合成纸纹图：64×64 的确定性噪点（R 通道，均值约 0.5），行序自上而下（图片的行序）。纯函数，Node 与浏览器共用。
export const PAPER_TILE = 64;
export function paperTile() {
  const n = PAPER_TILE, px = new Uint8Array(n * n * 4);
  const hash = (x, y) => { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = Math.round(255 * (0.5 + (hash(x, y) - 0.5) * 0.3 + 0.08 * Math.sin((x + 2 * y) / 5)));
    px.set([v, v, v, 255], (y * n + x) * 4);
  }
  let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i] / 255;
  return { px, size: n, mid: s / (n * n) };
}
