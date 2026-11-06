// 图版管理：按分段声明的 uses 预载贴图与深度；对外是 P 接口（分段模块拿到的 api.P）。
// 图版编号：pNN = 现在段刻线版（2×，着色器 2×2 超采样）；iNN = 闪回水墨原画；eNN = 现在段亮度均衡彩色原图（过渡取亮度用）。
// 深度一律 assets/depth/dNN.png（NN 同图号）。
import { W, H, normCam } from './gl.js';

const BASE = '/@film/assets/';
const urlOf = id => id[0] === 'p' ? `${BASE}plates/${id}.png` : id[0] === 'i' ? `${BASE}ink/${id}.jpg` : `${BASE}plates/p${id.slice(1)}_eq.jpg`;
async function bitmap(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('缺素材 ' + url);
  return createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

export function createPlates(G) {
  const tex = {}, depth = {}, dcpu = {};
  const DW = 480, DH = 270;
  async function load(id) {
    if (tex[id]) return;
    const n = id.slice(1);
    const [b, d] = await Promise.all([bitmap(urlOf(id)), depth[n] ? null : bitmap(`${BASE}depth/d${n}.png`)]);
    tex[id] = G.upload(b, true); b.close?.();
    if (d) {
      depth[n] = G.upload(d, false);
      const oc = new OffscreenCanvas(DW, DH), cx = oc.getContext('2d'); cx.drawImage(d, 0, 0, DW, DH);
      const px = cx.getImageData(0, 0, DW, DH).data, a = new Float32Array(DW * DH);
      for (let i = 0; i < a.length; i++) a[i] = px[i * 4] / 255;
      dcpu[n] = a; d.close?.();
    }
  }
  const depthAt = (id, ix, iy) => {
    const a = dcpu[id.slice(1)]; if (!a) return 0;
    const x = Math.max(0, Math.min(DW - 1, ix / W * DW)), y = Math.max(0, Math.min(DH - 1, iy / H * DH));
    return a[(y | 0) * DW + (x | 0)];
  };
  // 局部隆起系数（与着色器同式；c.ha = 0 时恒为 1）
  const bumpF = (c, ix, iy, D) => {
    if (!c.ha) return 1;
    const bx = (ix - c.hx) / c.hr, by = (iy - c.hy) / c.hr, t = Math.min(1, Math.max(0, (D - 0.62) / 0.2));
    return 1 + c.ha * Math.exp(-(bx * bx + by * by)) * (1 - t * t * (3 - 2 * t));
  };
  // 图坐标 → 屏幕坐标（w 不给就查深度图）
  const toScreen = (id, cam, ix, iy, w) => {
    const c = normCam(cam), D = depthAt(id, ix, iy); w = (w ?? D) * c.depth;
    const s = c.zoom * (1 + c.push * w) * bumpF(c, ix, iy, D);
    return [(ix - c.cx) * s + c.sx * w + W / 2, (iy - c.cy) * s + c.sy * w + H / 2, s];
  };
  // 屏幕坐标 → 图坐标（与着色器同样的 3 次反向迭代）
  const toImage = (id, cam, x, y) => {
    const c = normCam(cam), Q = [x - W / 2, y - H / 2];
    let I = [c.cx + Q[0] / c.zoom, c.cy + Q[1] / c.zoom];
    for (let k = 0; k < 3; k++) {
      const D = depthAt(id, I[0], I[1]), w = c.depth * D, s = c.zoom * (1 + c.push * w) * bumpF(c, I[0], I[1], D);
      I = [c.cx + (Q[0] - c.sx * w) / s, c.cy + (Q[1] - c.sy * w) / s];
    }
    return I;
  };
  // 画面四角是否会露出图外（返回露出的像素数，>0 时 dev 模式会在控制台警告）
  const overflow = (id, cam) => {
    let worst = 0;
    for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, 0], [W / 2, H], [0, H / 2], [W, H / 2]]) {
      const [ix, iy] = toImage(id, cam, x, y);
      worst = Math.max(worst, -ix, ix - W, -iy, iy - H);
    }
    return worst;
  };
  let warned = new Set();
  // 画一张图版。opts 见 ARCH.md §4.2
  function draw(id, cam, o = {}) {
    if (!tex[id]) throw new Error(`图版 ${id} 没有预载：在分段模块的 uses 里写上它`);
    const c = normCam(cam);
    if (!o.allowEdge && !warned.has(id) && overflow(id, c) > 2) { warned.add(id); console.warn(`[P] ${id} 相机露出图外 ${overflow(id, c).toFixed(0)}px，加大 zoom 或减小 sx/sy`); }
    G.drawPlate(tex[id], depth[id.slice(1)], { cam: c, alpha: o.alpha ?? 1, ss: id[0] === 'p' ? 2 : 1, lod: o.lod ?? 0, blob: o.blob, mask: o.mask, tone: o.tone ?? (id[0] === 'i' ? INKTONE : null) });
  }
  return { load, draw, toScreen, toImage, depthAt, overflow, has: id => !!tex[id] };
}
// 闪回水墨图的默认调子：轻微去饱和，让原画的米黄与宣纸合拍（不改构图、不重画）
export const INKTONE = { gain: 1.0, desat: 0.35, inkDark: 0 };
