// 路面电车（侧面，车头朝右）：原点 = 车头下方轨面；车身向左延伸 L
import { cel, path, poly, line, rgba, mix, TAU, LWK } from './cel.js';

export const TRAM_L = 900, TRAM_H = 352;
export function tram(g, e, P, o = {}) {
  const L = TRAM_L, rim = o.rim, lit = o.lit || 0, ph = o.ph || 0, sky = o.sky || ['#9fd0f0', '#4f8cc8'];
  const top = { f: P.tramTop.f, s: P.tramTop.s, h: P.tramTop.h, l: P.tramTop.l, lw: 2.2, rim };
  const low = { f: P.tramLow.f, s: P.tramLow.s, h: P.tramLow.h, l: P.tramLow.l, lw: 2.2, rim };
  // 转向架 + 车轮
  for (const bx of [-150, -L + 150]) {
    cel(g, poly([[bx - 90, -62], [bx + 90, -62], [bx + 80, -24], [bx - 80, -24]]), { f: P.dark.f, s: P.dark.s, so: [0, -6], l: P.dark.l, lw: 1.8 });
    for (const wx of [-50, 50]) {
      const w = new Path2D(); w.arc(bx + wx, -26, 26, 0, TAU);
      cel(g, w, { f: P.dark.s, l: P.dark.l, lw: 1.6, h: P.dark.h, hi: [[[bx + wx - 4, -48], [bx + wx + 10, -44], [bx + wx, -36]]] });
      const a = (o.wheelA || 0) + wx; line(g, [[bx + wx, -26], [bx + wx + Math.cos(a) * 20, -26 + Math.sin(a) * 20]], P.chrome.s, 3);
    }
  }
  // 车身下半（绿）
  const body = path([[-L, -64, 1], [-6, -64, 1], [10, -110], [14, -180, 1], [-L + 6, -180, 1], [-L - 8, -150], [-L - 6, -90]], true);
  cel(g, body, { ...low, so: [0, -16], ho: [0, 6] });
  // 车身上半（奶油色）+ 车顶
  const up = path([[-L + 6, -182, 1], [14, -182, 1], [6, -300], [-30, -332], [-L + 30, -336], [-L - 6, -300]], true);
  cel(g, up, { ...top, so: [0, 14], ho: [0, -6] });
  cel(g, path([[-L + 24, -336, 1], [-24, -334, 1], [-50, -352], [-L + 50, -354]], true), { f: mix(P.tramTop.s, P.dark.f, .3), l: P.tramTop.l, lw: 1.8 });
  // 红色腰线
  g.fillStyle = P.frame.f; g.fill(poly([[-L, -186], [14, -186], [14, -178], [-L, -178]]));
  // 侧窗：天空反射 + 斜高光；点灯时变成暖黄并进发光板
  const winTop = -300, winBot = -204;
  for (let k = 0; k < 8; k++) {
    const x0 = -L + 60 + k * 100, x1 = x0 + 78;
    if (k === 3) {   // 车门
      cel(g, poly([[x0 - 6, -310], [x1 + 6, -310], [x1 + 6, -66], [x0 - 6, -66]]), { f: P.tramLow.s, l: P.tramLow.l, lw: 1.8 });
      const dw = poly([[x0 + 4, -296], [x1 - 4, -296], [x1 - 4, -200], [x0 + 4, -200]]);
      g.fillStyle = lit ? '#ffd890' : sky[1]; g.fill(dw); line(g, [[x0 + 4, -296], [x1 - 4, -296], [x1 - 4, -200], [x0 + 4, -200]], P.tramWin.l, 1.6, true);
      continue;
    }
    const W = poly([[x0, winTop], [x1, winTop], [x1, winBot], [x0, winBot]]);
    g.save(); g.clip(W);
    const gr = g.createLinearGradient(0, winTop, 0, winBot);
    if (lit) { gr.addColorStop(0, '#ffe6a8'); gr.addColorStop(1, '#ffb868'); }
    else { gr.addColorStop(0, sky[0]); gr.addColorStop(1, sky[1]); }
    g.fillStyle = gr; g.fillRect(x0, winTop, x1 - x0, winBot - winTop);
    // 乘客剪影（几个）
    if ((k * 7) % 3 !== 0) { g.fillStyle = rgba(lit ? '#7a3a3a' : '#1c2a40', lit ? .8 : .35); g.beginPath(); g.ellipse(x0 + 40, -238, 13, 15, 0, 0, TAU); g.fill(); g.fillRect(x0 + 24, -224, 32, 30); }
    if (!lit) { g.fillStyle = rgba('#ffffff', .45); g.fill(poly([[x0 + 10 + ph, winBot], [x0 + 28 + ph, winBot], [x0 + 58 + ph, winTop], [x0 + 40 + ph, winTop]])); }
    g.restore();
    line(g, [[x0, winTop], [x1, winTop], [x1, winBot], [x0, winBot]], P.tramWin.l, 1.8, true);
    if (lit && e) { e.fillStyle = rgba('#ffc070', .55); e.fillRect(x0, winTop, x1 - x0, winBot - winTop); }
  }
  // 车头前窗
  const fw = path([[-40, -300, 1], [2, -296], [8, -204, 1], [-40, -204, 1]], true);
  g.fillStyle = lit ? '#ffd090' : sky[1]; g.fill(fw); line(g, fw, P.tramWin.l, 1.8);
  // 行先牌（背光透过）："海岸线"
  const sx = -120, sy = -326;
  cel(g, poly([[sx, sy], [sx + 100, sy], [sx + 100, sy + 22], [sx, sy + 22]]), { f: '#1a1c28', l: '#08080c', lw: 1.5 });
  for (const [ctx, pass] of [[g, 0], [e, 1]]) {
    if (!ctx) continue;
    ctx.save(); ctx.font = '700 18px NSC'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (pass) { ctx.fillStyle = 'rgba(255,240,190,.9)'; ctx.fillRect(sx + 4, sy + 3, 92, 16); }
    ctx.fillStyle = pass ? '#ffffff' : '#fff6d8'; ctx.fillText('海岸线', sx + 50, sy + 12);
    ctx.restore();
  }
  // 车头灯
  cel(g, poly([[2, -120], [16, -122], [16, -100], [4, -100]]), { f: '#fff8e0', l: P.chrome.l, lw: 1.4 });
  if (e) { const gx = 18, gy = -111; const gr = e.createRadialGradient(gx, gy, 0, gx, gy, 60); gr.addColorStop(0, 'rgba(255,248,220,.95)'); gr.addColorStop(1, 'rgba(255,230,180,0)'); e.fillStyle = gr; e.beginPath(); e.arc(gx, gy, 60, 0, TAU); e.fill(); }
  // 受电弓
  const px = -L / 2, py = -352;
  line(g, [[px - 60, py], [px - 10, py - 70], [px - 50, py - 120]], P.dark.f, 4);
  line(g, [[px + 60, py], [px + 10, py - 70], [px + 50, py - 120]], P.dark.f, 4);
  line(g, [[px - 80, py - 120], [px + 80, py - 120]], P.dark.f, 5);
  // 车侧号码牌
  g.fillStyle = P.tramTop.f; g.fillRect(-L + 40, -150, 60, 26); line(g, [[-L + 40, -150], [-L + 100, -150], [-L + 100, -124], [-L + 40, -124]], P.tramLow.l, 1.4, true);
  g.fillStyle = P.tramLow.l; g.font = 'italic 900 20px Kanit'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('305', -L + 70, -137);
}
