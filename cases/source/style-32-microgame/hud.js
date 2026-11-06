// 指令词 / 角标 / 一次性横幅 / 引信计时器（屏幕空间）
import { INK, PAL, star } from './toon.js';
import { clamp, lerp, eo, ei, eio, back } from '/core/lib.js';

function fancy(c, text, size, font, { drop = PAL.magenta, burst = PAL.gold, burstR = 1, rot = 0, fill = '#fff' } = {}) {
  const m = font.match(/^(\d+) (.*)$/); c.font = m ? `${m[1]} ${size}px ${m[2]}` : `${size}px ${font}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  const w = c.measureText(text).width;
  if (burst) { // 爆炸底
    c.save(); c.rotate(rot); c.beginPath(); star(c, 0, 0, Math.max(w * .42, size * .62) * burstR, Math.max(w * .62, size * .95) * burstR, 14);
    c.fillStyle = burst; c.fill(); c.lineWidth = 8; c.strokeStyle = INK; c.lineJoin = 'round'; c.stroke(); c.restore();
  }
  c.transform(1, 0, -.1, 1, 0, 0); // 斜体 ≈ −6°
  c.lineJoin = 'round';
  c.lineWidth = size * .17; c.strokeStyle = INK; c.strokeText(text, size * .07, size * .09);
  c.fillStyle = drop; c.fillText(text, size * .07, size * .09);
  c.lineWidth = size * .13; c.strokeText(text, 0, 0);
  c.fillStyle = fill; c.fillText(text, 0, 0);
  return w;
}

// 指令词：f 为相对指令起始的帧数；hold 帧后缩到左上角标签；out 帧起飞出
export function command(c, text, f, { hold = 9, out = 1e9, size = 220, font = '900 NSC', y0 = 470 } = {}) {
  if (f < 0) return null;
  const slam = [1.9, .92, 1.0];
  let s = f < 3 ? slam[Math.floor(f)] : 1, x = 960, y = y0, rot = f * .02;
  const tg = clamp((f - hold) / 5), tgE = eio(tg);
  const tx = 175 + text.length * 22, ty = 112;
  x = lerp(x, tx, tgE); y = lerp(y, ty, tgE); s *= lerp(1, .36, tgE);
  let a = 1;
  if (f >= out) { const o = clamp((f - out) / fly); y -= ei(o) * 300; x -= ei(o) * 200; a = 1 - o; if (o >= 1) return null; }
  c.save(); c.globalAlpha = a; c.translate(x, y); c.rotate(-.06); c.scale(s, s);
  fancy(c, text, size, font, { rot, burstR: lerp(1, .8, tgE) });
  c.restore();
  const hw = text.length * size * .5 * s;
  return { id: 'cmd', text, x0: x - hw, y0: y - size * .6 * s, x1: x + hw, y1: y + size * .6 * s };
}

// 一次性横幅：砸入 → 停留 → 飞出（不变成角标）
export function banner(c, text, f, { out = 22, fly = 6, size = 250, font = 'TitanOne', drop = PAL.cyan, burst = PAL.magenta, x = 960, y = 520, burstR = .78 } = {}) {
  if (f < 0) return null;
  const slam = [2.1, .9, 1.04, 1];
  let s = f < 4 ? slam[Math.floor(f)] : 1 + .02 * Math.sin(f * .9), dx = 0, dy = 0, a = 1, rot = 0;
  if (f >= out) { const o = clamp((f - out) / fly); dx = ei(o) * 1400; dy = -ei(o) * 500; rot = o * .5; a = 1 - o * .3; if (o >= 1) return null; }
  c.save(); c.globalAlpha = a; c.translate(x + dx, y + dy); c.rotate(-.07 + rot); c.scale(s, s);
  fancy(c, text, size, font, { drop, burst, rot: f * .05, burstR });
  c.restore();
  return { id: 'banner', text, x0: x + dx - 600 * s, y0: y + dy - 160 * s, x1: x + dx + 600 * s, y1: y + dy + 160 * s };
}

// 引信：beats 个绳结，每拍火花正好经过一个结；p = 已过拍数（小数）
export function fuse(c, beats, p, { y = 1018, x0 = 240, x1 = 1680, frozen = false } = {}) {
  const kx = i => lerp(x0, x1, i / beats);
  const sx = kx(clamp(p, 0, beats));
  c.save();
  // 未燃部分：麻绳
  c.lineCap = 'round';
  c.lineWidth = 26; c.strokeStyle = INK; c.beginPath(); c.moveTo(sx, y); c.lineTo(x1, y); c.stroke();
  c.lineWidth = 15; c.strokeStyle = '#e8b45a'; c.stroke();
  c.lineWidth = 4; c.strokeStyle = '#a8742a'; c.beginPath();
  for (let x = sx; x < x1; x += 22) { c.moveTo(x, y - 7); c.lineTo(x + 12, y + 7); } c.stroke();
  // 已燃部分：焦黑细线
  c.lineWidth = 6; c.strokeStyle = 'rgba(26,11,46,.7)'; c.beginPath(); c.moveTo(x0, y); c.lineTo(sx, y); c.stroke();
  // 绳结
  for (let i = 1; i <= beats; i++) { const x = kx(i); if (x < sx - 2) continue;
    c.fillStyle = '#e8b45a'; c.strokeStyle = INK; c.lineWidth = 6; c.beginPath(); c.arc(x, y, 19, 0, Math.PI * 2); c.fill(); c.stroke(); }
  // 终点爆竹
  c.fillStyle = PAL.fail; c.strokeStyle = INK; c.lineWidth = 7; c.beginPath(); c.roundRect(x1 + 14, y - 40, 54, 80, 10); c.fill(); c.stroke();
  // 火花（逐帧闪）
  if (p < beats) {
    const fl = frozen ? 1 : 1 + .25 * Math.sin(p * 47);
    c.fillStyle = PAL.gold; c.strokeStyle = INK; c.lineWidth = 5;
    c.beginPath(); star(c, sx, y, 14 * fl, 38 * fl, 8, p * 9); c.fill(); c.stroke();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(sx, y, 9, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}
