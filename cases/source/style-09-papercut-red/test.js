// model sheet of every piece, drawn with the real engine (?test=pieces)
import { fillPaper, paperShadow, noShadow } from './engine/paper.js';
import * as PC from './engine/pieces.js';
export function test(g, kind) {
  g.setTransform(1, 0, 0, 1, 0, 0); fillPaper(g, 'rice', 0, 0, 1920, 1080);
  const put = (p, x, y, s, a = 0) => { g.save(); g.setTransform(s * Math.cos(a), s * Math.sin(a), -s * Math.sin(a), s * Math.cos(a), x, y); paperShadow(g, s, 1); g.drawImage(p.c, p.x0, p.y0, p.w, p.h); g.restore(); };
  const carp = PC.carpPiece(), fl = PC.flowerPieces(), ros = PC.rosettePieces(), fu = PC.fuPieces(), sc = PC.scissorsPieces(), gate = PC.gatePieces();
  if (kind === 'pieces') {
    put(fl.front, 300, 300, .7); put(carp, 300, 800, 1.1); put(ros.front, 900, 420, .6); put(fu.front, 1500, 220, 1);
    put(sc.A, 1500, 560, 1); put(sc.B, 1500, 560, 1);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#1b2448'; g.fillRect(1180, 700, 740, 380); g.restore();
    put(gate.front, 1550, 1060, .36);
  } else if (kind === 'carp') { put(carp, 960, 540, 3); }
  else if (kind === 'flower') { put(fl.front, 960, 540, 1.3); }
  else if (kind === 'rosette') { put(ros.front, 960, 540, .85); }
  else if (kind === 'gate') { g.save(); g.fillStyle = '#1b2448'; g.fillRect(0, 0, 1920, 1080); g.restore(); put(gate.front, 960, 1050, 1.0); }
}
