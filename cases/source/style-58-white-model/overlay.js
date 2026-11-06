// 2D layer over the model: the identity label, one readout per layer in the left third, a pin anchored to the model
// through the camera. Every text that must be read registers itself (window.TEXTS → readcheck).
import { seg, ss, eo } from '/core/lib.js';

export const W = 1920, H = 1080;
const F = { sc3: '300 {}px SC', sc5: '500 {}px SC', num: '200 {}px IT', num4: '400 {}px IT', mono: '400 {}px PM' };
export const font = (k, px) => F[k].replace('{}', px);

export function makeOverlay(canvas) {
  const g = canvas.getContext('2d');
  let TX = [];
  const begin = () => { g.clearRect(0, 0, W, H); TX = []; };
  function txt(id, s, x, y, k, px, col, a = 1, o = {}) {
    if (a <= .001) return 0;
    g.save(); g.globalAlpha = a; g.font = font(k, px); g.fillStyle = col; g.textBaseline = 'alphabetic';
    g.letterSpacing = (o.ls || 0) + 'px';
    if (o.shadow) { g.shadowColor = 'rgba(0,0,0,.65)'; g.shadowBlur = o.shadow; }
    const w = g.measureText(s).width, xx = o.right ? x - w : x;
    g.fillText(s, xx, y); g.restore();
    if (id && a > .98) TX.push({ id, text: s, x0: xx, y0: y - px * .9, x1: xx + w, y1: y + px * .25 });
    return w;
  }
  const width = (s, k, px, ls = 0) => { g.save(); g.font = font(k, px); g.letterSpacing = ls + 'px'; const w = g.measureText(s).width; g.restore(); return w; };
  const env = (t, t0, t1, fin = .35, fout = .3) => Math.min(eo(seg(t, t0, t0 + fin)), 1 - ss(seg(t, t1 - fout, t1)));

  // soft dark field behind the left-third readouts
  function scrim(a) {
    if (a <= 0) return;
    const gr = g.createRadialGradient(330, 600, 40, 330, 600, 700);
    gr.addColorStop(0, `rgba(4,5,8,${.62 * a})`); gr.addColorStop(.55, `rgba(4,5,8,${.36 * a})`); gr.addColorStop(1, 'rgba(4,5,8,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }

  // a faint dark gradient under the identity label (top-left), so it reads over the plate and the water line
  function idScrim(a) {
    if (a <= 0) return;
    const gr = g.createRadialGradient(330, 70, 20, 330, 70, 520);
    gr.addColorStop(0, `rgba(3,4,7,${.62 * a})`); gr.addColorStop(.5, `rgba(3,4,7,${.4 * a})`); gr.addColorStop(1, 'rgba(3,4,7,0)');
    g.save(); g.fillStyle = gr; g.fillRect(0, 0, 900, 600); g.restore();
  }

  // readout: index + layer name, one figure (+unit), labels, one source line, an optional legend
  function readout(t, t0, t1, o) {
    const a = env(t, t0, t1); if (a <= 0) return;
    const k = eo(seg(t, t0, t0 + .5)), dy = (1 - k) * 22, X = 104, Y = 560 + dy;
    g.save(); g.globalAlpha = a; g.fillStyle = o.col; g.fillRect(X, Y - 124, 52 * k + 2, 2); g.restore();
    txt(o.id + 'i', o.idx, X, Y - 138, 'mono', 20, 'rgba(235,238,242,.72)', a, { ls: 2 });
    txt(o.id + 'n', o.name, X + 66, Y - 137, 'sc5', 24, '#eef1f4', a, { ls: 3 });
    const bigA = a * (o.bigA ?? 1);
    const w = txt(o.bigId === null ? null : o.id + 'b', o.big, X - 6, Y + 4, 'num', o.bigPx || 132, '#ffffff', bigA, { shadow: 18 });
    if (o.unit) txt(o.bigId === null ? null : o.id + 'u', o.unit, X + w + 8, Y + 4, 'num', 62, '#ffffff', bigA, { shadow: 12 });
    let y = Y + 56;
    for (const [lid, s, la] of o.labels || []) {
      const aa = a * (la ?? 1);
      txt(o.id + lid, s, X, y, 'sc5', 32, '#f4f5f6', aa, { shadow: 10 }); y += 46;
    }
    if (o.note) txt(o.id + 's', o.note, X, y - 6, 'sc3', 21, 'rgba(225,230,236,.8)', a, { ls: 1 });
    if (o.legend) o.legend(X, y + 26, a);
  }

  // pin: a hairline from a point on the model up to a tag on a dark plate
  function pin(t, t0, t1, p, o) {
    const a = env(t, t0, t1, .3, .3); if (a <= 0 || !p) return;
    const [x, y] = p;
    const L = (o.len || 110) * eo(seg(t, t0, t0 + .45)), x2 = x + (o.dx || 0), y2 = y - L;
    g.save(); g.globalAlpha = a;
    g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 4; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
    g.strokeStyle = o.col || '#ffffff'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
    g.fillStyle = o.col || '#ffffff'; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
    g.restore();
    const ta = a * seg(t, t0 + .15, t0 + .4), left = !!o.left;
    const lx = left ? x2 - 12 : x2 + 12;
    let w = width(o.text, 'sc5', 26); if (o.sub) w = Math.max(w, width(o.sub, 'mono', 20));
    g.save(); g.globalAlpha = ta * .62; g.fillStyle = '#05060a'; g.fillRect(left ? lx - w - 10 : lx - 10, y2 - 22, w + 20, o.sub ? 66 : 38); g.restore();
    txt(o.id, o.text, lx, y2 + 7, 'sc5', 26, '#ffffff', ta, { shadow: 10, right: left });
    if (o.sub) txt(o.id + 's', o.sub, lx, y2 + 36, 'mono', 20, o.subCol || 'rgba(240,242,245,.9)', ta, { shadow: 8, right: left });
  }

  return { g, begin, txt, width, env, scrim, idScrim, readout, pin, texts: () => TX };
}
