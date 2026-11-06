// 角色测试：?test=model（设定表）| rider（骑车动作条）
import { W, H, LWK } from './cel.js';
import { PAL } from './pal.js';
import { head, hat, bust, rider, hatOnHead } from './girl.js';
function cell(g, x, y, w, h, label, fn) {
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.fillStyle = '#e6e2ea'; g.fillRect(x, y, w, h); fn(); g.restore();
  g.strokeStyle = '#8a8494'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
  g.fillStyle = '#3a3448'; g.font = 'italic 900 24px Kanit'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(label, x + 14, y + 10);
}
export function test(g, e, t, name) {
  g.fillStyle = '#cfcad6'; g.fillRect(0, 0, W, H);
  if (name === 'model') {
    const P = PAL.day;
    [['Q', 'q', 'determined'], ['SIDE', 'side', 'resolve'], ['FRONT', 'front', 'neutral']].forEach(([lab, view, expr], i) => cell(g, i * 480, 0, 480, 600, lab, () => {
      g.translate(i * 480 + 250, 300); g.scale(1.2, 1.2); bust(g, P, { view }); head(g, P, { view, expr, wind: .3 }); hatOnHead(g, P, view, {}); }));
    // hat turnaround
    cell(g, 1440, 0, 480, 600, 'HAT', () => { [[.25, 0], [.85, 0], [-.5, .4]].forEach(([q, r], k) => { g.save(); g.translate(1680, 120 + k * 170); hat(g, P, { q, rot: r, s: .8 }); g.restore(); }); });
    [['DETERMINED', 'determined'], ['RESOLVE', 'resolve'], ['UPWARD', 'upward'], ['SMILE', 'smileopen']].forEach(([lab, expr], i) => cell(g, i * 480, 600, 480, 480, lab, () => {
      g.translate(i * 480 + 240, 600 + 250); g.scale(1.25, 1.25); head(g, P, { view: 'q', expr, wind: .3 }); }));
  }
  if (name === 'rider') {
    for (let k = 0; k < 4; k++) cell(g, k * 480, 0, 480, 540, 'CRANK ' + k, () => { g.translate(k * 480 + 240, 520); g.scale(.62, .62); rider(g, PAL.gold, { crank: k * Math.PI / 2, wheelA: k, speed: .5, ph: k / 4 }); });
    const conf = [['STAND', { stand: 1, crank: 1 }], ['TURN .5', { turn: .5 }], ['TURN 1', { turn: 1, hairWind: .2 }], ['HAT LIFT', { lift: .6, stand: 1 }]];
    conf.forEach(([lab, o], k) => cell(g, k * 480, 540, 480, 540, lab, () => { g.translate(k * 480 + 240, 1060); g.scale(.62, .62); rider(g, PAL.gold, { crank: .5, wheelA: 0, speed: .5, ph: .3, ...o }); }));
  }
}
