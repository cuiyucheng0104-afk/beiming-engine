// 新沉淀的画法在真浏览器（Canvas 2D）里的行为：engine/paint/brushwork.js（毛笔起收笔、飞白、洇墨）与
// engine/paint/xuan.js（宣纸）、engine/look/paper.js 的 canvasPaper。给 A、C 路线当笔触与纸感的底层用，所以锁住：
//   · 确定性：同样的参数在新画布上画两次逐像素相同（任意帧可单独重渲）；
//   · 不弄脏调用方的画布状态（变换、不透明度、合成方式、滤镜、填充色）；
//   · 飞白只挖这一笔自己的墨、露出底下的纸，笔头不受影响；洇墨只在笔画外面加一圈淡墨；
//   · 按 g 的变换画（2 倍画布 + scale(2) 与 1 倍画布的墨迹位置一致）；
//   · 宣纸：同种子同纸、四边无缝、纸色均值贴近 tone；canvasPaper 量出的中性点是合成实际取样的 R 通道均值。
// 运行：node --test tests/engine/paint.browser.test.mjs（没装 headless shell 时整组跳过）
import test from 'node:test';
import assert from 'node:assert/strict';
import { open, HEAD, TAIL } from './lib/browser.mjs';

let B = null;
test.before(async () => { B = await open(); });
test.after(async () => { if (B && !B.skip) await B.close(); });
const btest = (title, fn) => test(title, async t => { if (B.skip) return t.skip(B.skip); await fn(t); });

const page = body => HEAD + `
import { createBrush } from '/engine/paint/brushwork.js';
import { xuanPaper } from '/engine/paint/xuan.js';
import { canvasPaper } from '/engine/look/paper.js';
import { createNoise2D } from '/engine/core/noise.js';
import { mulberry } from '/engine/core/math.js';
const mk = (w, h, fill = '#f2ebdb') => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); if (fill) { g.fillStyle = fill; g.fillRect(0, 0, w, h); } return [c, g]; };
const px = (g, w, h) => g.getImageData(0, 0, w, h).data;
const hash = a => { let h = 2166136261; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619); return (h >>> 0).toString(16); };
const line = (x0, y0, x1, y1, n = 60, pr = () => 0.55) => Array.from({ length: n + 1 }, (_, i) => { const u = i / n; return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, pr(u)]; });
// 区域 [x0, x1) × [y0, y1) 的平均亮度（0..255）
const lum = (d, w, x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; } return s / n; };
${body}
` + TAIL;

btest('毛笔：同样的参数画两次逐像素相同；不改调用方画布的状态', async () => {
  const pg = await B.page('brush-det', page(`
const run = () => { const [c, g] = mk(640, 200); const brush = createBrush(createNoise2D(mulberry(17)));
  g.translate(4, 2); g.globalAlpha = 0.9; g.globalCompositeOperation = 'multiply'; g.fillStyle = '#123456'; g.filter = 'none';
  const before = { t: g.getTransform().toString(), a: g.globalAlpha, op: g.globalCompositeOperation, fs: g.fillStyle, f: g.filter };
  const r = brush.stroke(g, line(40, 100, 600, 90), { size: 44, entry: 'hidden', exit: 'return', dry: 0.6, bleed: 0.4, seed: 3, jit: 1.5, step: 7 });
  const after = { t: g.getTransform().toString(), a: g.globalAlpha, op: g.globalCompositeOperation, fs: g.fillStyle, f: g.filter };
  return { h: hash(px(g, 640, 200)), before, after, len: r.length, n: r.spine.length }; };
window.RESULT = [run(), run()];`), { w: 64, h: 64 });
  try {
    const [a, b] = await pg.result();
    assert.equal(a.h, b.h, '两次逐像素相同');
    assert.deepEqual(a.after, a.before, '画完画布状态与画之前一样');
    assert.ok(Math.abs(a.len - 560) < 15 && a.n > 50, `笔长 ${a.len}`);
  } finally { await pg.close(); }
});

btest('毛笔飞白：只在笔画后段露出底下的纸，笔头与不枯的笔一样；洇墨只加在笔画外面', async () => {
  const pg = await B.page('brush-dry', page(`
const W = 700, H = 160, pts = line(40, 80, 660, 80);
const draw = o => { const [c, g] = mk(W, H); createBrush(createNoise2D(mulberry(5))).stroke(g, pts, { size: 50, entry: 'hidden', exit: 'return', press: 0, fade: 0, seed: 2, ...o }); return px(g, W, H); };
const wet = draw({}), dry = draw({ dry: 0.85, dryFrom: 0.4 }), bleed = draw({ bleed: 0.8 });
const band = (d, x0, x1) => lum(d, W, x0, 66, x1, 94);         // 沿笔画中线的一条带
window.RESULT = {
  headWet: band(wet, 60, 250), headDry: band(dry, 60, 250), tailWet: band(wet, 470, 640), tailDry: band(dry, 470, 640),
  paper: lum(wet, W, 0, 0, W, 12), outsideWet: lum(wet, W, 200, 40, 500, 48), outsideBleed: lum(bleed, W, 200, 40, 500, 48),
  coreWet: band(wet, 250, 450), coreBleed: band(bleed, 250, 450),
};`), { w: 64, h: 64 });
  try {
    const r = await pg.result();
    assert.ok(Math.abs(r.headDry - r.headWet) < 0.5, `笔头不枯：${r.headWet.toFixed(1)} vs ${r.headDry.toFixed(1)}`);
    assert.ok(r.tailDry > r.tailWet + 15, `后段露白：湿笔 ${r.tailWet.toFixed(1)} → 枯笔 ${r.tailDry.toFixed(1)}`);
    assert.ok(r.tailDry < r.paper - 20, `露白是一道道细丝，不是整段挖空（纸 ${r.paper.toFixed(1)}）`);
    assert.ok(r.outsideBleed < r.outsideWet - 3, `洇墨在笔画外面加了一圈淡墨：${r.outsideWet.toFixed(1)} → ${r.outsideBleed.toFixed(1)}`);
    assert.ok(Math.abs(r.coreBleed - r.coreWet) < 0.5, '笔身本身不变');
  } finally { await pg.close(); }
});

btest('毛笔按调用方的变换画：2 倍画布 + scale(2) 的墨迹包围盒是 1 倍画布的 2 倍', async () => {
  const pg = await B.page('brush-xf', page(`
const box = (k) => { const W = 400 * k, H = 120 * k, [c, g] = mk(W, H, null); g.setTransform(k, 0, 0, k, 0, 0);
  createBrush(createNoise2D(mulberry(9))).stroke(g, line(30, 60, 370, 60), { size: 30, entry: 'exposed', exit: 'exposed' });
  const d = px(g, W, H); let x0 = W, x1 = 0, y0 = H, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1]; };
window.RESULT = [box(1), box(2)];`), { w: 64, h: 64 });
  try {
    const [a, b] = await pg.result();
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(b[i] - 2 * a[i]) <= 3, `包围盒 ${a} ×2 ≈ ${b}`);
  } finally { await pg.close(); }
});

btest('宣纸：同种子同纸、换种子不同；四边无缝；纸色均值贴近 tone；canvasPaper 的中性点 = R 通道均值', async () => {
  const pg = await B.page('xuan', page(`
const W = 384, H = 256, tone = [242, 235, 219];
const a = xuanPaper({ width: W, height: H, seed: 3, tone }), b = xuanPaper({ width: W, height: H, seed: 3, tone }), c = xuanPaper({ width: W, height: H, seed: 4, tone });
const da = px(a.getContext('2d'), W, H), db = px(b.getContext('2d'), W, H), dc = px(c.getContext('2d'), W, H);
// 接缝：最右一列与最左一列、最下一行与最上一行之差，不超过画面内部任意相邻两列 / 两行之差的最大值
// （帘纹的横纹按周期正好落在第 0 行的上沿，这类「线正骑在像素边界上」的相邻行本来就是内部差值最大的一档）
const colDiff = (d, x0, x1) => { let s = 0; for (let y = 0; y < H; y++) { const i = (y * W + x0) * 4, j = (y * W + x1) * 4; s += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]); } return s / H; };
const rowDiff = (d, y0, y1) => { let s = 0; for (let x = 0; x < W; x++) { const i = (y0 * W + x) * 4, j = (y1 * W + x) * 4; s += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]); } return s / W; };
const mean = ch => { let s = 0; for (let i = ch; i < da.length; i += 4) s += da[i]; return s / (W * H); };
const P = canvasPaper(a);
const small = document.createElement('canvas'); small.width = small.height = 64; small.getContext('2d').drawImage(a, 0, 0, 64, 64);
const sd = small.getContext('2d').getImageData(0, 0, 64, 64).data; let r = 0; for (let i = 0; i < sd.length; i += 4) r += sd[i] / 255;
let maxCol = 0, maxRow = 0; for (let x = 0; x < W - 1; x++) maxCol = Math.max(maxCol, colDiff(da, x, x + 1)); for (let y = 0; y < H - 1; y++) maxRow = Math.max(maxRow, rowDiff(da, y, y + 1));
window.RESULT = { same: hash(da) === hash(db), differ: hash(da) !== hash(dc), seamX: colDiff(da, W - 1, 0), seamY: rowDiff(da, H - 1, 0), maxCol, maxRow,
  mean: [mean(0), mean(1), mean(2)], tone, mid: P.mid, midRef: r / 4096, strength: P.strength, wrap: P.tex.wrapS };`), { w: 64, h: 64 });
  try {
    const r = await pg.result();
    assert.ok(r.same, '同种子同纸'); assert.ok(r.differ, '换种子不同');
    assert.ok(r.seamX <= r.maxCol * 1.05 && r.seamY <= r.maxRow * 1.05, `接缝 ${r.seamX.toFixed(2)} / ${r.seamY.toFixed(2)}，内部相邻最大 ${r.maxCol.toFixed(2)} / ${r.maxRow.toFixed(2)}`);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(r.mean[k] - r.tone[k]) < 6, `通道 ${k} 均值 ${r.mean[k].toFixed(1)} vs tone ${r.tone[k]}`);
    assert.ok(Math.abs(r.mid - r.midRef) < 1e-9 && r.mid > 0.85 && r.mid < 1, `canvasPaper.mid ${r.mid}`);
    assert.equal(r.strength, 0.12, '默认强度取正片的 0.12（乘法混合，见 engine/look/compose.js）');
    assert.equal(r.wrap, 1000, '平铺（RepeatWrapping）');
  } finally { await pg.close(); }
});
