// 文字动效自测页：?test=kinetic，一页 12 格（4×3），每格一个动效，循环播放「入场 → 停留 → 出场」，格内标中文名。
// 可选参数：&fx=<名字> 只看一个、放大；&text=<要演示的字>；&hold=2 一拍二（24 fps）；&noblur=1 关模糊
// 出静帧：node engine/render/still.mjs . 0.8 1.2 2.4 3.9 --size 1280x720 --query test=kinetic --out out/lab/kinetic
import { EFFECTS, drawKinetic } from '../engine/overlay/kinetic.js';
import { loadFonts, fontSpec, createOverlay } from '../engine/overlay/text.js';
import { seg } from '../engine/core/math.js';
import { registerFonts, loadGlyphs } from '../routes/c-style/template/type.js';

const Q = new URLSearchParams(location.search);
const W = innerWidth, H = innerHeight;
const cv = document.createElement('canvas'); cv.width = W; cv.height = H; document.body.style.cssText = 'margin:0;background:#0b0d14'; document.body.appendChild(cv);
const ctx = cv.getContext('2d');
const url = f => new URL(`../fonts/${f}`, import.meta.url).href;
await loadFonts([['KN SC', url('NotoSansSC-var.woff2'), '300 500'], ['KN Lat', url('Barlow-400.woff2'), '400']]);
// 片名用 C 路线的整套马善政（7015 字，按码位分片，仓库里就有）：fonts/ 下的那份是《北冥》的冻结子集，缺字会掉到系统字体
await registerFonts([{ family: 'KN Title', manifest: 'routes/c-style/fonts/fonts.json' }]);

const names = Q.get('fx') && EFFECTS[Q.get('fx')] ? [Q.get('fx')] : Object.keys(EFFECTS);
const cols = names.length === 1 ? 1 : 4, rows = Math.ceil(names.length / cols), cw = W / cols, ch = H / rows;
const TEXT = Q.get('text') || '北冥有鱼 其名为鲲';
await loadGlyphs(TEXT, ['KN Title'], 400);
const IN = 1.6, HOLD = 1.0, OUT = 1.4;
const O = createOverlay({ ink: [236, 230, 215], glow: [255, 190, 90], halo: [0, 0, 0], fill: [0, 0, 0] });
const hold = Q.get('hold') ? +Q.get('hold') : undefined;

const size = Math.min(cw / (TEXT.length * 1.05), ch * 0.4);
const font = fontSpec(400, size, ['KN Title', 'KN SC']);
const mctx = document.createElement('canvas').getContext('2d'); mctx.font = font;
const glyphs = []; let x = 0;
[...TEXT].forEach((c, i) => { const w = c === ' ' ? size * 0.5 : mctx.measureText(c).width; glyphs.push({ ch: c, x, y: 0, w, line: 0, index: i }); x += w; });
const totalW = x;

window.DUR = IN + HOLD + OUT;
window.render = t => {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0b0d14'; ctx.fillRect(0, 0, W, H);
  names.forEach((name, k) => {
    const c = k % cols, r = Math.floor(k / cols), ox = c * cw, oy = r * ch;
    ctx.strokeStyle = '#242a3a'; ctx.lineWidth = 1; ctx.strokeRect(ox + 0.5, oy + 0.5, cw - 1, ch - 1);
    ctx.fillStyle = '#8f9ab8'; ctx.font = fontSpec(400, Math.max(12, ch * 0.075), ['KN SC']); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillText(`${EFFECTS[name].title}  ${name}`, ox + 10, oy + Math.max(12, ch * 0.075) + 6);
    const phase = t < IN + HOLD ? 'in' : 'out', p = phase === 'in' ? seg(t, 0, IN) : seg(t, IN + HOLD, IN + HOLD + OUT);
    const gx = ox + (cw - totalW) / 2, gy = oy + ch * 0.62;
    const gl = glyphs.map(g => ({ ...g, x: g.x + gx, y: gy }));
    ctx.save();
    drawKinetic(ctx, gl, { effect: name, p: t < IN + HOLD && t >= IN ? 1 : p, phase: t >= IN && t < IN + HOLD ? 'in' : phase, font, size, color: '#efe6d2', seed: 7, overlay: O, id: name, hold, fps: 24, dur: phase === 'in' ? IN : OUT, blur: !Q.get('noblur') });
    ctx.restore();
  });
};
window.render(0);
window.READY = true;
