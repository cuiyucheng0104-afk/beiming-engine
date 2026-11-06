import { drawText } from './font.js';
import { HANZI } from './hanzi.js';
export async function proof(){
await document.fonts.load('200px Ref', '按下芯片扬声器叮咚');
const c = document.getElementById('c'), g = c.getContext('2d');
const CH = Object.keys(HANZI);
window.DUR = 1; window.render = () => {
  g.fillStyle = '#05190F'; g.fillRect(0, 0, 1920, 1080);
  const S = 190, cap = S * 10 / 12;
  CH.forEach((ch, i) => {
    const x = 20 + i * 210, y = 40;
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    for (let k = 0; k <= 12; k++) { g.beginPath(); g.moveTo(x + k * S / 12, y); g.lineTo(x + k * S / 12, y + S); g.stroke(); g.beginPath(); g.moveTo(x, y + k * S / 12); g.lineTo(x + S, y + k * S / 12); g.stroke(); }
    g.fillStyle = 'rgba(120,200,255,0.35)'; g.font = `${S}px Ref`; g.textBaseline = 'top'; g.fillText(ch, x, y + S * 0.02);
    g.strokeStyle = '#F2EEE1'; drawText(g, ch, x, y + S / 12 * 1, cap, { weight: 0.1 });
    drawText(g, ch, x + 20, 300, 150, { weight: 0.15 });
  });
  g.strokeStyle = '#F2EEE1';
  drawText(g, '按下 PUSH  芯片 CHIP  扬声器 SPEAKER', 40, 560, 60, {});
  drawText(g, '叮咚 DING-DONG  叮  咚', 40, 700, 110, {});
  drawText(g, '叮咚  按下  芯片  扬声器', 40, 900, 24, {});
};
window.READY = true;

}
