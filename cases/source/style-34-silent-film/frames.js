// 测试与风格帧场景（不进成片）：?scene=frames.heads
import { drawFigure, P0 } from './engine/figure.js';
import { setFrame } from './engine/ink.js';
import { Redraw } from './engine/redraw.js';
import { GENT } from './chars.js';
const mk = () => { const c = document.createElement('canvas'); c.width = 1440; c.height = 1080; return c; };
let RD = null; const fc = mk(), fg = fc.getContext('2d');
export function heads(g, t) {
  RD = RD || new Redraw(1440, 1080); setFrame(0);
  fg.setTransform(1, 0, 0, 1, 0, 0); fg.fillStyle = '#eee'; fg.fillRect(0, 0, 1440, 1080);
  const exprs = [{ open: .8 }, { open: 1.4, brow: 1.3, browA: .5, mouthOpen: .5, mouthW: .7 }];
  [[90, 0, 0], [90, 0, 1], [75, -.7, 0], [90, .25, 1], [90, -1.25, 1], [40, 0, 0]].forEach(([yaw, ht, e], i) => {
    const p = P0(); p.headTurn = ht; p.expr = exprs[e];
    drawFigure(fg, GENT, { x: 140 + i * 230, ground: 1060, scale: 130, yaw, pose: p, t: 0 });
  });
  g.drawImage(RD.render(fc, { frame: 0 }), 240, 0);
}
