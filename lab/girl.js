// lab/girl.js — 镜头 B 人物层自测页（?test=girl）
// 背景：assets/ref/sky_test.png 裁一块亮的地平线区域，轻微虚焦（近景浅景深），随镜头做弱视差推进；
// 上面叠 drawGirl 画的人物层；再做一个「近似正片」的简易后期（bloom、暖调、暗角、可选颗粒），只用于自查。
// 查询参数：
//   bg=a（默认，地平线亮区）| b（整张天空）| c（平涂亮渐变，只看剪影）
//   post=0 关掉简易后期；grain=1 加颗粒；layer=1 只看人物层（棋盘格底）；debug=1 标锚点；cam=0 关掉推镜
import { drawGirl, drawGirlMotes, girlCamera, GIRL_SHOT } from '../src/girl.js';
import { mulberry } from '../engine/core/math.js';

const q = new URLSearchParams(location.search);
const W = innerWidth, H = innerHeight;
const cv = document.createElement('canvas'); cv.width = W; cv.height = H; document.body.appendChild(cv);
const ctx = cv.getContext('2d');
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const fig = mk(W, H), fctx = fig.getContext('2d');
const BW = Math.round(W / 4), BH = Math.round(H / 4);
const small = mk(BW, BH), sctx = small.getContext('2d', { willReadFrequently: true });

const img = new Image(); img.src = './assets/ref/sky_test.png'; await img.decode();

// 颗粒：6 张预生成噪点（固定种子），按帧轮换
const grains = [];
{ const rnd = mulberry(990331);
  for (let k = 0; k < 6; k++) { const c = mk(256, 256), g = c.getContext('2d'), im = g.createImageData(256, 256);
    for (let i = 0; i < im.data.length; i += 4) { const v = 128 + (rnd() - 0.5) * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
    g.putImageData(im, 0, 0); grains.push(c); } }

const BG = q.get('bg') || 'a';
function drawBg(t, cam) {
  ctx.save();
  // 天空离得远：只跟随镜头推进的 30%
  const z = 1 + (cam.zoom - 1) * 0.3, fx = cam.fx * W, fy = cam.fy * H;
  ctx.translate(fx, fy); ctx.scale(z, z); ctx.translate(-fx, -fy);
  if (BG === 'c') {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#8C86D4'); g.addColorStop(0.5, '#F2A6AA'); g.addColorStop(0.85, '#FFC27E'); g.addColorStop(1, '#FFD9B5');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } else {
    // a：取原图右侧、地平线附近的亮区；b：整张铺满
    const [sx, sy, sw] = BG === 'b' ? [0, 0, img.width] : [700, 250, 1074];
    const sh = sw * H / W;
    ctx.filter = 'blur(2.2px) brightness(1.06) saturate(1.05)';
    ctx.drawImage(img, sx, sy, sw, Math.min(sh, img.height - sy), 0, 0, W, Math.min(H, (img.height - sy) * W / sw));
    ctx.filter = 'none';
  }
  ctx.restore();
}

function post(frame) {
  // 简易 bloom：1/4 分辨率取亮部 → 模糊 → 滤色叠回
  sctx.clearRect(0, 0, BW, BH); sctx.drawImage(cv, 0, 0, BW, BH);
  const im = sctx.getImageData(0, 0, BW, BH), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255, k = Math.max(0, (l - 0.72) / 0.28);
    d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
  }
  sctx.putImageData(im, 0, 0);
  ctx.save(); ctx.globalCompositeOperation = 'screen';
  ctx.filter = 'blur(8px)'; ctx.globalAlpha = 0.6; ctx.drawImage(small, 0, 0, W, H);
  ctx.filter = 'blur(26px)'; ctx.globalAlpha = 0.55; ctx.drawImage(small, 0, 0, W, H);
  ctx.restore();
  // 暖调：柔光叠一层杏色
  ctx.save(); ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = 0.22; ctx.fillStyle = '#FFB070'; ctx.fillRect(0, 0, W, H); ctx.restore();
  // 暗角
  const vg = ctx.createRadialGradient(W * 0.55, H * 0.45, H * 0.35, W * 0.55, H * 0.45, W * 0.75);
  vg.addColorStop(0, 'rgba(40,30,70,0)'); vg.addColorStop(1, 'rgba(40,30,70,0.28)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  if (q.get('grain') === '1') {
    ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.07;
    ctx.fillStyle = ctx.createPattern(grains[frame % 6], 'repeat'); ctx.fillRect(0, 0, W, H); ctx.restore();
  }
}

window.DUR = GIRL_SHOT.dur;
window.render = (t) => {
  const tl = Math.max(0, Math.min(GIRL_SHOT.dur - 1e-6, t));
  const cam = q.get('cam') === '0' ? { zoom: 1, fx: 0.5, fy: 0.5 } : girlCamera(tl);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  if (q.get('layer') === '1') {
    for (let y = 0; y < H; y += 32) for (let x = 0; x < W; x += 32) { ctx.fillStyle = ((x + y) / 32) % 2 ? '#bbb' : '#eee'; ctx.fillRect(x, y, 32, 32); }
  } else drawBg(tl, cam);
  fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.clearRect(0, 0, W, H);
  drawGirl(fctx, tl, W, H, { cam: q.get('cam') === '0' ? false : cam, debug: q.get('debug') === '1' });
  // 光尘放在人物后面（只在天空里浮动，不在脸上起斑点）
  if (q.get('motes') !== '0' && q.get('layer') !== '1') drawGirlMotes(ctx, tl, W, H, { cam: q.get('cam') === '0' ? false : cam });
  ctx.drawImage(fig, 0, 0);
  if (q.get('post') !== '0' && q.get('layer') !== '1') post(Math.floor(t * 24 + 1e-6));
};
window.READY = true;
