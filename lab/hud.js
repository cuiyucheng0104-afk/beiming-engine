// 显示层 + 片名自测页：?test=hud
// 背景用 assets/ref/sky_test.png，配假的鲲身/眼睛与导航折线，HUD 画在单独一张透明 canvas 上（模拟最终合成：最上层、不过后期）。
// 可选参数：&theme=neutral（青白配色）  &boxes=1（画出 TEXTS 报告的文字方框）  &skel=1（片名骨架叠图，校骨架用）  &perf=1（量 JS 侧耗时）
// 出 8 张静帧：node engine/render/still.mjs . 5.2 5.6 6.3 7.4 8.2 8.95 9.4 9.95 --query test=hud --out out/lab/hud
import { loadHUDFonts, drawHUD, drawTitle, textsAt, setHUDTheme, __TITLE_SKEL, __titleLayout } from '../src/hud.js';
import { eio } from '../engine/core/math.js';

const Q = new URLSearchParams(location.search);
const W = innerWidth, H = innerHeight;
// &cpu=1：HUD 画布改用 willReadFrequently（软件光栅），仅调试读像素用。确定性请走截图路径查（在页面里反复 getImageData 会让 Chrome 中途切换光栅方式，抗锯齿前后不同，会误报）
const mk = (z, o) => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.style.cssText = `position:absolute;left:0;top:0;z-index:${z}`; document.body.appendChild(c); return c.getContext('2d', o); };
const bctx = mk(1), hctx = mk(2, Q.get('cpu') ? { willReadFrequently: true } : undefined);
setHUDTheme(Q.get('theme') || 'mono');

const bg = new Image(); bg.src = './assets/ref/sky_test.png'; await bg.decode();
await loadHUDFonts();

// 背景按 cover 铺满
const sc = Math.max(W / bg.width, H / bg.height), bw = bg.width * sc, bh = bg.height * sc;

// 假数据：眼睛 5.0–6.4 停在右上，6.4–8.6 随鲲从右向左滑走
function fakeS(t) {
  const u = eio((t - 6.4) / 2.2);
  const eye = { x: (0.64 - 0.95 * u) * W, y: (0.34 - 0.05 * u) * H, r: 0.065 * H };
  const nav = [[0.60, 1.05], [0.55, 0.88], [0.47, 0.67], [0.38, 0.55], [0.28, 0.555], [0.205, 0.70]].map(([x, y]) => ({ x: x * W, y: y * H }));
  const head = { yaw: 0.006 * Math.sin(2 * Math.PI * 0.21 * t), pitch: 0.004 * Math.sin(2 * Math.PI * 0.27 * t + 1.3) };
  return { eye: eye.x > -2 * eye.r ? eye : null, nav, head };
}
// 假的鲲：一大块深蓝灰身体 + 眼睛 + 一圈藤壶，只为看 HUD 在暗色上的可读性
function fakeKun(t, s) {
  if (!s.eye) return;
  const { x, y, r } = s.eye;
  bctx.save();
  bctx.fillStyle = '#4E5888'; bctx.beginPath(); bctx.ellipse(x + 5.2 * r, y - 0.6 * r, 7.5 * r, 3.2 * r, -0.08, 0, 7); bctx.fill();
  bctx.fillStyle = '#343D69'; bctx.beginPath(); bctx.ellipse(x + 5.2 * r, y + 1.6 * r, 7.0 * r, 1.2 * r, -0.08, 0, 7); bctx.fill();
  bctx.fillStyle = '#F2A36B'; bctx.globalAlpha = 0.55; bctx.beginPath(); bctx.ellipse(x + 5.2 * r, y + 2.3 * r, 6.4 * r, 0.6 * r, -0.08, 0, 7); bctx.fill(); bctx.globalAlpha = 1;
  for (let i = 0; i < 14; i++) { const a = i / 14 * 6.283; bctx.fillStyle = '#E9DCC9'; bctx.beginPath(); bctx.arc(x + Math.cos(a) * r * 1.25, y + Math.sin(a) * r * 1.05, r * 0.14, 0, 7); bctx.fill(); }
  bctx.fillStyle = '#2A2D52'; bctx.beginPath(); bctx.ellipse(x, y, r, r * 0.8, 0, 0, 7); bctx.fill();
  bctx.fillStyle = '#FFD3B0'; bctx.beginPath(); bctx.arc(x - r * 0.25, y - r * 0.25, r * 0.16, 0, 7); bctx.fill();
  bctx.restore();
}

window.DUR = 10;
window.render = t => {
  const s = fakeS(t);
  bctx.drawImage(bg, (W - bw) / 2, (H - bh) / 2, bw, bh);
  if (t >= 5 && t < 9) fakeKun(t, s);
  hctx.clearRect(0, 0, W, H);
  drawHUD(hctx, t, W, H, s);
  drawTitle(hctx, t, W, H);
  if (Q.get('boxes')) {
    hctx.save(); hctx.strokeStyle = '#ff2d55'; hctx.lineWidth = 1; hctx.font = '14px sans-serif'; hctx.fillStyle = '#ff2d55';
    for (const b of textsAt(t, W, H)) { hctx.strokeRect(b.x0 + .5, b.y0 + .5, b.x1 - b.x0, b.y1 - b.y0); hctx.fillText(`${b.id}: ${b.text}`, b.x0, b.y1 + 16); }
    hctx.restore();
  }
  if (Q.get('skel')) {                      // 片名骨架叠图（与 hud.js 的 titleLayout 一致）
    const L = __titleLayout(W, H), F = L.F, yc = L.glyphs[0][2];
    L.glyphs.map(g => [g[0], g[1]]).forEach(([ch, x0]) => __TITLE_SKEL[ch].forEach((st, i) => {
      hctx.strokeStyle = `hsl(${i * 47},90%,45%)`; hctx.lineWidth = 2; hctx.beginPath();
      st.forEach(([u, v], j) => j ? hctx.lineTo(x0 + u * F, yc + v * F) : hctx.moveTo(x0 + u * F, yc + v * F)); hctx.stroke();
      hctx.fillStyle = hctx.strokeStyle; hctx.font = '13px sans-serif'; hctx.fillText(String(i + 1), x0 + st[0][0] * F + 3, yc + st[0][1] * F - 3);
    }));
  }
};
window.TEXTS = t => textsAt(t, W, H);

// &perf=1：量 JS 侧耗时（不含 GPU 光栅化），结果用 console.warn 打到 still.mjs 的输出里。
// 确定性另走真实截图路径查：别在页面里对画布 getImageData 求哈希，
// Chrome 读回几次后会把画布从 GPU 切到 CPU 光栅，前后抗锯齿不同，会误报「不一致」。
if (Q.get('perf')) {
  let t0 = performance.now(); drawTitle(hctx, 9.5, W, H); const pre = performance.now() - t0;   // 首次调用含片名预计算
  const frames = [];
  for (let f = 120; f < 240; f++) {
    const t = f / 24, s = fakeS(t);
    t0 = performance.now(); hctx.clearRect(0, 0, W, H); drawHUD(hctx, t, W, H, s); drawTitle(hctx, t, W, H); frames.push(performance.now() - t0);
  }
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length, max = Math.max(...frames);
  console.warn(`[perf] 片名预计算 ${pre.toFixed(1)} ms；drawHUD+drawTitle 每帧平均 ${avg.toFixed(2)} ms，最慢 ${max.toFixed(2)} ms（第 120–239 帧，JS 侧）`);
}
window.READY = true;
