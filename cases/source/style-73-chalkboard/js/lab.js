// Check page (?lab=hz): every character's chalk strokes over LXGW WenKai (red, behind) on the same 100-unit box,
// to see proportions while authoring hz.js. ?lab=latin shows the single-line fonts. Not part of the film.
import { bake, drawStroke } from './chalk.js';
import { HZ } from './hz.js';
import { writeChar, writeLatin, loadSvgFont } from './hand.js';
export async function run(cv, W, H, Q) {
  const o = new OffscreenCanvas(W, H), x = o.getContext('2d');
  x.fillStyle = '#132219'; x.fillRect(0, 0, W, H);
  if (Q.get('lab') === 'ref') {                  // reference glyphs on a 100-unit grid, for reading stroke anchors
    await document.fonts.load('100px WenKaiRef');
    const chars = [...(Q.get('chars') || '勾股')], S = 900;
    chars.slice(0, 2).forEach((ch, i) => {
      const ox = 60 + i * 960, oy = 120;
      x.font = `${S}px WenKaiRef`; x.fillStyle = 'rgba(230,90,80,.7)'; x.textBaseline = 'alphabetic'; x.fillText(ch, ox, oy + S * .88);
      for (let k = 0; k <= 20; k++) { const v = k * S / 20; x.strokeStyle = k % 2 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.5)'; x.lineWidth = 1;
        x.beginPath(); x.moveTo(ox + v, oy); x.lineTo(ox + v, oy + S); x.moveTo(ox, oy + v); x.lineTo(ox + S, oy + v); x.stroke();
        if (k % 2 === 0) { x.fillStyle = '#fff'; x.font = '20px sans-serif'; x.fillText(String(k * 5), ox + v - 10, oy - 8); x.fillText(String(k * 5), ox - 46, oy + v + 7); } }
    });
  } else if (Q.get('lab') === 'latin') {
    let y = 120;
    for (const f of ['EMSDelight', 'EMSCasualHand']) {
      await loadSvgFont('fonts/' + f + '.svg');
      const s = writeLatin(f + ': An inch tall? Let an arrow fly. body <- bow 10 28', 40, y, 54, -5);
      s.forEach(st => { bake(st, 1.5); drawStroke(x, st, 1e9); }); y += 160;
    }
  } else {
    await document.fonts.load('100px WenKaiRef');
    const chars = [...(Q.get('chars') || Object.keys(HZ).join(''))], S = +(Q.get('size') || 200), cols = Math.floor(W / (S + 20));
    chars.forEach((ch, i) => {
      const ox = 10 + (i % cols) * (S + 20), oy = 10 + Math.floor(i / cols) * (S + 20);
      x.strokeStyle = 'rgba(200,180,110,.25)'; x.strokeRect(ox, oy, S, S);
      x.font = `${S}px WenKaiRef`; x.fillStyle = 'rgba(220,60,60,.45)'; x.textBaseline = 'alphabetic'; x.fillText(ch, ox, oy + S * .88);
      const st = writeChar(ch, ox + S / 2, oy + S / 2, S, -10, { hand: Q.get('hand') || 'teacher', seed: 3 });
      st.forEach(s => { bake(s, 1); drawStroke(x, s, 1e9); });
    });
  }
  const c = cv.getContext('2d'); c.drawImage(o, 0, 0);
  window.render = () => {};
}
