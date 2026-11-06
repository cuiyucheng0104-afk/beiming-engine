// 景片：白虎岭。全部是刻出来的驴皮件，幕布大部分留白
// 左：石崖 + 歪脖子松 + "白虎岭"石碑；右：尖峭山脊（虎纹般的山纹）+ 枯树 + 半埋的小骷髅；底：刻纹地面条
import { piece, drawPiece, fill, cut, cutLine, ink, within, smooth, poly, cloud, beads, beadLine, plum, lattice, coin, strata, meander, cutTaper, DYE } from '/styles/shadow-puppet/demo/carve.js';
import { mulberry } from '/core/lib.js';
import { mul, T, S, set } from './rig.js';

export const groundY = x => 905 + 9 * Math.sin(x / 260) + 5 * Math.sin(x / 97 + 1);
const GB = 975;

// 山：一整片，沿山脊刻宽缝（虎纹），峰下云头孔
function mountain(pk, col, seed, stripe = 1) {
  const xs = pk.map(p => p[0]), x0 = Math.min(...xs) - 10, x1 = Math.max(...xs) + 10, y0 = Math.min(...pk.map(p => p[1])) - 10;
  const top = x => { for (let i = 0; i < pk.length - 1; i++) if (x >= pk[i][0] && x <= pk[i + 1][0]) { const u = (x - pk[i][0]) / (pk[i + 1][0] - pk[i][0]); return pk[i][1] + (pk[i + 1][1] - pk[i][1]) * u; } return 930; };
  return piece([x0, y0, x1, 940], g => {
    const m = q => poly(q, [...pk, [pk[pk.length - 1][0], 940], [pk[0][0], 940]]);
    fill(g, col, m);
    within(g, m, () => {
      const r = mulberry(seed);
      // 虎纹：顺山势的锥形宽缝，长短交错
      for (let k = 1; k <= 12; k++) for (let x = x0 + (k % 2) * 40; x < x1; x += 70 + r() * 50) {
        const L = 40 + r() * 70, pts = []; for (let j = 0; j <= 6; j++) { const xx = x + j / 6 * L; pts.push([xx, top(xx) + k * 19 + 6 * Math.sin(xx / 23 + k)]); }
        cutTaper(g, pts, 4 + 5 * stripe * r());
      }
      for (let i = 1; i < pk.length - 1; i++) if (pk[i][1] < pk[i - 1][1] && pk[i][1] < pk[i + 1][1]) { cloud(g, pk[i][0] - 10, pk[i][1] + 46, 10, r() * 6, 2.2, 1); }
      for (let k = 0; k < 8; k++) { const x = x0 + 30 + r() * (x1 - x0 - 60); plum(g, x, top(x) + 170 + r() * 50, 3.2); }
    });
    ink(g, 2.4, q => poly(q, pk, false));
  }, { ss: 1.4, seed });
}
// 松：扭干 + 几团扇形针叶
function pine() {
  return piece([-200, -330, 190, 20], g => {
    const tr = q => smooth(q, [[-16, 16], [-10, -60], [-26, -120], [-6, -170], [30, -200], [70, -230], [120, -250], [124, -238], [78, -214], [40, -184], [12, -150], [8, -100], [18, -40], [18, 16]]);
    fill(g, DYE.brown, tr); within(g, tr, () => { for (let k = 0; k < 12; k++) cutLine(g, 1.6, q => { const y = 6 - k * 16; q.moveTo(-14, y); q.quadraticCurveTo(0, y - 8, 14, y - 2); }); }); ink(g, 2, tr);
    const br = q => smooth(q, [[-18, -130], [-80, -170], [-140, -178], [-142, -168], [-84, -158], [-20, -116]]);
    fill(g, DYE.brown, br); ink(g, 1.6, br);
    for (const [x, y, r, a] of [[-150, -178, 52, -.2], [-80, -190, 44, .1], [10, -214, 50, 0], [90, -262, 56, .15], [150, -246, 40, .3], [40, -276, 42, -.1]]) {
      const fan = q => { q.moveTo(x - r, y + 6); q.quadraticCurveTo(x - r * .9, y - r * .7, x, y - r * .75); q.quadraticCurveTo(x + r * .9, y - r * .7, x + r, y + 6); q.quadraticCurveTo(x, y + 14, x - r, y + 6); q.closePath(); };
      fill(g, DYE.green, fan);
      within(g, fan, () => { for (let k = 0; k < 14; k++) { const aa = Math.PI + (k + .5) / 14 * Math.PI; cutLine(g, 2, q => { q.moveTo(x + Math.cos(aa) * r * .15, y + 4 + Math.sin(aa) * r * .1); q.lineTo(x + Math.cos(aa) * r * .92, y + 4 + Math.sin(aa) * r * .66); }); } });
      g.save(); g.beginPath(); fan(g); g.clip(); ink(g, 6, fan, DYE.jade); g.restore(); ink(g, 1.8, fan);
    }
  }, { ss: 1.6, seed: 101 });
}
// 枯树：黑褐的秃枝
function deadTree() {
  return piece([-170, -380, 170, 22], g => {
    const br = [[0, 0, -4, -200, 16, 7], [-2, -120, -90, -240, 8, 2.5], [0, -170, 80, -290, 7, 2], [-3, -200, -30, -350, 6, 1.5], [60, -250, 130, -270, 4, 1.5], [-60, -210, -140, -220, 4, 1.4], [-20, -300, -70, -340, 3, 1]];
    for (const [x0, y0, x1, y1, w0, w1] of br) {
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L, mx = (x0 + x1) / 2 + nx * 14, my = (y0 + y1) / 2 + ny * 14;
      const b = q => { q.moveTo(x0 + nx * w0, y0 + ny * w0); q.quadraticCurveTo(mx + nx * (w0 + w1) / 2, my + ny * (w0 + w1) / 2, x1 + nx * w1, y1 + ny * w1); q.lineTo(x1 - nx * w1, y1 - ny * w1); q.quadraticCurveTo(mx - nx * (w0 + w1) / 2, my - ny * (w0 + w1) / 2, x0 - nx * w0, y0 - ny * w0); q.closePath(); };
      fill(g, '#3d2012', b); ink(g, 1.3, b);
      if (w0 > 10) for (let k = 1; k < 8; k++) cutLine(g, 1.4, q => { const u = k / 8, x = x0 + dx * u, y = y0 + dy * u; q.moveTo(x - 6, y + 4); q.lineTo(x, y - 2); q.lineTo(x + 6, y + 4); });
    }
    fill(g, '#3d2012', q => smooth(q, [[-30, 18], [-16, -8], [16, -8], [32, 18]]));
  }, { ss: 1.6, seed: 102 });
}
// 石碑：刻"白虎岭"
function stele() {
  return piece([-50, -190, 50, 10], g => {
    const st = q => smooth(q, [[-34, 6], [-36, -150], [-24, -172], [0, -180], [24, -172], [36, -150], [34, 6]]);
    fill(g, '#6f6a5a', st);
    within(g, st, () => { cloud(g, -16, -160, 6, 0, 1.4, 1); cloud(g, 16, -160, 6, 3, 1.4, -1); });
    g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.font = '400 38px "Ma Shan Zheng"'; g.textAlign = 'center'; g.textBaseline = 'middle';
    ['白', '虎', '岭'].forEach((c, i) => g.fillText(c, 0, -118 + i * 40)); g.restore();
    ink(g, 2.2, st);
    const base = q => poly(q, [[-46, 0], [46, 0], [42, 12], [-42, 12]]); fill(g, '#4a4436', base); ink(g, 1.6, base);
  }, { ss: 2, seed: 103 });
}
// 小骷髅（半埋在枯树根下，伏笔）
function smallSkull() {
  return piece([-26, -24, 26, 6], g => {
    const cr = q => smooth(q, [[-20, 4], [-22, -12], [-12, -22], [4, -22], [16, -14], [22, -2], [18, 4]]);
    fill(g, '#dcc08a', cr); cut(g, q => q.ellipse(8, -9, 4.5, 5, 0, 0, 7)); cut(g, q => { q.moveTo(17, -4); q.lineTo(20, 2); q.lineTo(14, 2); q.closePath(); });
    for (let k = 0; k < 4; k++) cutLine(g, 1, q => { q.moveTo(2 + k * 4, 0); q.lineTo(2 + k * 4, 4); });
    ink(g, 1.8, cr);
  }, { ss: 2, seed: 104 });
}
// 地面条：刻纹 + 枯草
function ground() {
  const top = []; for (let x = -10; x <= 1930; x += 16) top.push([x, groundY(x)]);
  const gp = q => poly(q, top.concat([[1930, GB], [-10, GB]]));
  return piece([0, 870, 1920, GB + 4], g => {
    fill(g, '#8a5e30', gp);
    within(g, gp, () => {
      g.fillStyle = DYE.brown; g.fillRect(-10, GB - 22, 1940, 30);
      meander(g, 0, GB - 7, 1920, 6, 1.8);
      for (let x = 20; x < 1920; x += 38) coin(g, x, GB - 34, 5.5);
      const rr = mulberry(5);
      for (let x = 8; x < 1910; x += 20 + rr() * 26) { const y = groundY(x) + 3, h = 9 + rr() * 12; fill(g, DYE.yellow, q => poly(q, [[x - 5, y + 6], [x - 4, y - h], [x, y + 2], [x + 5, y - h * .7], [x + 7, y + 6]])); }
      for (let x = 30; x < 1900; x += 64) cloud(g, x, groundY(x) + 30, 6.5, x * .03, 1.5, (x / 64) % 2 ? 1 : -1);
    });
    ink(g, 2.4, q => poly(q, top, false), '#2e1a0c');
  }, { ss: 1.5, seed: 105 });
}
let SC = null;
export function buildScenery() {
  if (SC) return SC;
  const pkL = [[-20, 905], [30, 720], [90, 640], [150, 600], [210, 660], [260, 610], [320, 700], [390, 760], [440, 830], [480, 905]];
  const pkR = [[1360, 905], [1420, 800], [1480, 700], [1520, 740], [1590, 610], [1640, 660], [1700, 560], [1770, 650], [1830, 600], [1900, 700], [1950, 760], [1960, 905]];
  const pkR2 = [[1180, 905], [1260, 820], [1330, 780], [1400, 830], [1470, 800], [1520, 905]];
  SC = { mL: mountain(pkL, '#5f7f86', 3), mR: mountain(pkR, '#4d6f84', 5), mR2: mountain(pkR2, '#7b8f7c', 7, .6), pine: pine(), tree: deadTree(), stele: stele(), skull: smallSkull(), ground: ground() };
  return SC;
}
export function drawLand(g, C) {
  const S2 = buildScenery();
  g.save(); g.globalCompositeOperation = 'multiply';
  const at = (p, x = 0, y = 0, k = 1) => { set(g, mul(C, mul(T(x, y), S(k)))); drawPiece(g, p); };
  at(S2.mR); at(S2.mR2); at(S2.mL);
  at(S2.pine, 250, groundY(250) - 250, 1); at(S2.tree, 1600, groundY(1600) + 2, 1);
  at(S2.stele, 150, groundY(150) + 4, 1);
  at(S2.skull, 1650, groundY(1650) + 6, 1);
  at(S2.ground);
  g.restore();
}
