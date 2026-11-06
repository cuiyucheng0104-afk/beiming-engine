// 镂空字皮影牌（片名 / 片尾）+ 说书人字幕题板
import { piece, fill, cut, cutLine, ink, within, smooth, poly, cloud, lattice, coin, meander, DYE } from '/styles/shadow-puppet/demo/carve.js';

function plaque(w, h, lines, seal) {
  return piece([-w / 2 - 30, -h / 2 - 30, w / 2 + 30, h / 2 + 30], g => {
    const outer = q => { const r = 26; q.moveTo(-w / 2 + r, -h / 2); q.lineTo(w / 2 - r, -h / 2); q.quadraticCurveTo(w / 2 + 14, -h / 2 - 14, w / 2, -h / 2 + r); q.lineTo(w / 2, h / 2 - r); q.quadraticCurveTo(w / 2 + 14, h / 2 + 14, w / 2 - r, h / 2); q.lineTo(-w / 2 + r, h / 2); q.quadraticCurveTo(-w / 2 - 14, h / 2 + 14, -w / 2, h / 2 - r); q.lineTo(-w / 2, -h / 2 + r); q.quadraticCurveTo(-w / 2 - 14, -h / 2 - 14, -w / 2 + r, -h / 2); q.closePath(); };
    fill(g, '#3a1a10', outer);
    const band = q => { outer(q); q.rect(-w / 2 + 26, -h / 2 + 26, w - 52, h - 52); };
    fill(g, DYE.red, band);
    within(g, band, () => { meander(g, -w / 2 + 30, -h / 2 + 20, w / 2 - 30, 5, 1.6); meander(g, -w / 2 + 30, h / 2 - 7, w / 2 - 30, 5, 1.6); for (let y = -h / 2 + 40; y < h / 2 - 30; y += 22) { coin(g, -w / 2 + 13, y, 6); coin(g, w / 2 - 13, y, 6); } });
    for (const [x, y] of [[-w / 2 + 13, -h / 2 + 13], [w / 2 - 13, -h / 2 + 13], [-w / 2 + 13, h / 2 - 13], [w / 2 - 13, h / 2 - 13]]) { fill(g, DYE.green, q => q.arc(x, y, 20, 0, 7)); cloud(g, x, y, 12, 0, 2, 1); ink(g, 2, q => q.arc(x, y, 20, 0, 7)); }
    ink(g, 2.5, outer); ink(g, 1.8, q => q.rect(-w / 2 + 26, -h / 2 + 26, w - 52, h - 52));
    // 镂空字（刻穿，灯光从字里透出来）
    g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const L of lines) { g.font = L.font; g.letterSpacing = (L.ls || 0) + 'px'; g.fillText(L.text, L.x || 0, L.y); }
    g.restore();
    // 刻字连筋（镂空字要留的皮筋）
    for (const L of lines) if (L.bars) for (let k = 0; k < L.bars; k++) { const x = -w / 2 + 80 + (k + .5) * (w - 160) / L.bars; ink(g, 2.2, q => { q.moveTo(x, L.y - L.size * .42); q.lineTo(x + 5, L.y + L.size * .42); }, '#3a1a10'); }
    // 朱印（印文刻穿）
    if (seal) { const sx = w / 2 - 140, sy = -h / 2 + 46; fill(g, '#b3261b', q => q.rect(sx, sy, 84, 84)); g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.font = '400 36px "Ma Shan Zheng"'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(seal[0], sx + 42, sy + 24); g.fillText(seal[1], sx + 42, sy + 60); g.restore(); ink(g, 2, q => q.rect(sx, sy, 84, 84)); }
  }, { ss: 2, seed: 120 });
}
let P = null;
export function buildPlaques() {
  if (P) return P;
  P = {
    title: plaque(1120, 400, [
      { text: '三打白骨精', font: '400 170px "Ma Shan Zheng"', y: -26, ls: 26, size: 170, bars: 5 },
      { text: '西游记   皮影戏', font: '400 50px "Ma Shan Zheng"', y: 124, ls: 10, size: 50 }], '悟空'),
    end: plaque(1120, 420, [
      { text: '三打白骨精', font: '400 130px "Ma Shan Zheng"', y: -52, ls: 22, size: 130, bars: 5 },
      { text: '全 剧 终', font: '400 62px "Ma Shan Zheng"', y: 100, ls: 16, size: 62 }], '皮影')
  };
  return P;
}
// 字幕：说书人题板——黑漆窄木牌 + 细金线 + 朱红"说"字印；正文马善政楷书
export function drawSub(g, text, a = 1, slide = 0) {
  if (!text || a <= 0) return;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = a;
  g.font = '400 46px "Ma Shan Zheng"'; g.letterSpacing = '3px';
  const tw = g.measureText(text).width, seal = 46, padL = 22, padR = 36, gap = 20;
  const w = padL + seal + gap + tw + padR, h = 72, x = 960 - w / 2, y = 1080 - 58 - h + slide * 18;
  g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 18; g.shadowOffsetY = 4;
  const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, 'rgba(46,22,14,.93)'); gr.addColorStop(.5, 'rgba(30,14,9,.93)'); gr.addColorStop(1, 'rgba(22,10,7,.93)');
  g.fillStyle = gr; rr(g, x, y, w, h, 6); g.fill(); g.shadowColor = 'transparent';
  g.strokeStyle = 'rgba(168,129,63,.8)'; g.lineWidth = 1.5; rr(g, x + 6, y + 6, w - 12, h - 12, 3); g.stroke();
  const sx = x + padL, sy = y + (h - seal) / 2;
  g.fillStyle = '#b3261b'; rr(g, sx, sy, seal, seal, 4); g.fill();
  g.strokeStyle = 'rgba(255,220,190,.55)'; g.lineWidth = 1.2; rr(g, sx + 3.5, sy + 3.5, seal - 7, seal - 7, 2); g.stroke();
  g.letterSpacing = '0px'; g.font = '400 34px "Ma Shan Zheng"'; g.fillStyle = '#f6dcc0'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('说', sx + seal / 2, sy + seal / 2 + 2);
  g.letterSpacing = '3px'; g.font = '400 46px "Ma Shan Zheng"'; g.fillStyle = '#f3e2bf'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(text, sx + seal + gap, y + h / 2 + 2);
  g.restore();
}
function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
