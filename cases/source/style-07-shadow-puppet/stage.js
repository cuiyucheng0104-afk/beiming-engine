// Stage of 渔夫还珠: a dark teak frame around a 2400×1080 cloth (front layer, drawn through the camera), and the backs of
// the audience's heads (screen space, out of focus) for the closing pull-back.
import { hash } from '/core/lib.js';
export const CLOTH = [0, 0, 2400, 1080];

export function drawFrame(g, Cm, spill = 1) {
  g.save(); g.setTransform(...Cm);
  const wood = '#2b1509', wood2 = '#3d1f0e', brass = '#9a7238', red = '#6e1b10';
  // lintel with a lattice band and hanging tassels
  g.fillStyle = wood; g.fillRect(-700, -700, 3800, 700);
  g.fillStyle = wood2; g.fillRect(-260, -190, 2920, 150);
  g.strokeStyle = brass; g.lineWidth = 3;
  for (let x = -240; x < 2640; x += 64) { g.beginPath(); g.moveTo(x, -180); g.lineTo(x + 32, -115); g.lineTo(x, -50); g.lineTo(x - 32, -115); g.closePath(); g.stroke(); }
  g.beginPath(); g.moveTo(-260, -190); g.lineTo(2660, -190); g.moveTo(-260, -40); g.lineTo(2660, -40); g.stroke();
  g.fillStyle = red; g.fillRect(-260, -40, 2920, 40);
  for (let x = 160; x < 2400; x += 360) {          // tassels
    g.fillStyle = '#7a1c12'; g.beginPath(); g.moveTo(x - 10, 0); g.lineTo(x + 10, 0); g.lineTo(x + 13, 30); g.lineTo(x - 13, 30); g.closePath(); g.fill();
    g.fillStyle = brass; g.beginPath(); g.arc(x, 6, 9, 0, 7); g.fill();
  }
  // pillars
  for (const x of [-260, 2400]) {
    const gr = g.createLinearGradient(x, 0, x + 260, 0); gr.addColorStop(0, '#160904'); gr.addColorStop(.5, '#3a1b0c'); gr.addColorStop(1, '#160904');
    g.fillStyle = gr; g.fillRect(x, -700, 260, 2600);
    g.strokeStyle = brass; g.lineWidth = 2.5; g.strokeRect(x + 30, 80, 200, 920);
    for (let y = 140; y < 980; y += 120) { g.beginPath(); g.arc(x + 130, y, 22, 0, 7); g.stroke(); }
  }
  // stage lip
  g.fillStyle = wood; g.fillRect(-700, 1080, 3800, 900);
  g.fillStyle = red; g.fillRect(-260, 1080, 2920, 44);
  g.strokeStyle = brass; g.lineWidth = 2.5; g.beginPath(); g.moveTo(-260, 1124); g.lineTo(2660, 1124); g.stroke();
  // warm light spilling through the cloth onto the inner edges of the wood
  const sp = (x0, y0, x1, y1, w, h) => { const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, `rgba(255,170,90,${.34 * spill})`); gr.addColorStop(1, 'rgba(255,170,90,0)'); g.fillStyle = gr; g.fillRect(Math.min(x0, x1) - (w ? 0 : 0), Math.min(y0, y1), w, h); };
  sp(0, 1080, 0, 1150, 2400, 70); sp(0, 0, 0, -70, 2400, 70); sp(0, 0, -80, 0, 80, 1080); sp(2400, 0, 2480, 0, 80, 1080);
  g.restore();
}

// the audience: backs of heads along the bottom of the viewport, blurred, warm rim on top
export function drawAudience(g, a, t) {
  if (a <= 0) return;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = a; g.filter = 'blur(9px)';
  for (let i = 0; i < 9; i++) {
    const x = 90 + i * 225 + (hash(i) - .5) * 70, s = .8 + hash(i + 9) * .45, y = 1080 + 40 - s * 30 + Math.sin(t * .9 + i) * 3;
    g.fillStyle = '#120804';
    g.beginPath(); g.ellipse(x, y + 120 * s, 150 * s, 110 * s, 0, 0, 7); g.fill();       // shoulders
    g.beginPath(); g.ellipse(x, y - 30 * s, 72 * s, 88 * s, 0, 0, 7); g.fill();          // head
    if (i % 3 === 1) { g.beginPath(); g.ellipse(x - 10 * s, y - 112 * s, 26 * s, 22 * s, 0, 0, 7); g.fill(); }   // hair bun
    g.strokeStyle = 'rgba(255,170,95,.38)'; g.lineWidth = 5; g.beginPath(); g.ellipse(x, y - 30 * s, 70 * s, 86 * s, 0, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
  }
  g.restore();
}
