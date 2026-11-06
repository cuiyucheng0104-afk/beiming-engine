// 长袍类皮影（唐僧 / 村姑 / 老妇 / 老翁）：头、上身、下裳（到地）、两臂、道具；外加白骨（立 / 堆）、筋斗云、贬书
// 侧身朝右，枢轴在原点；整身的根在"地面脚下"（下裳底边中点），腰在 (0,-H0)
import { piece, drawPiece, fill, cut, cutLine, ink, within, smooth, poly, scalesOpen, lattice, coin, cloud, beads, beadLine, plum, waves, meander, DYE } from '/styles/shadow-puppet/demo/carve.js';
import { mul, T, R, S, ap, set, ik, camK } from './rig.js';
import { hash } from '/core/lib.js';

export const RJ = { neck: [6, -102], shF: [14, -96], shB: [0, -100], rod: [5, -104], elbow: [0, 50], wrist: [0, 46] };
export const RL = { UA: 50, FA: 46, HANDR: 12, H0: 238 };
const HK = 1.42;
const C2 = { pink: '#c24a5a', slate: '#34485a', robe: '#4f7478', bone: '#d6b479', paleJade: '#9cc3b4', lav: '#5e4a86' };
const scaled = (k, fn, dy = 12) => g => { g.scale(k, k); g.translate(0, dy); fn(g); };
const neck = (g, f = [8, -24], b = [-7, -18]) => { ink(g, 1.8, q => { q.moveTo(f[0], f[1]); q.quadraticCurveTo(f[0] - 1, -6, f[0] - 2, 6); q.moveTo(b[0], b[1]); q.quadraticCurveTo(b[0] + 1, -4, b[0] + 2, 6); }); };

// ================= 通用小件 =================
function sleeveUA(col, seed, wide = 0) {
  const sl = q => smooth(q, [[-12, -2], [12, -2], [13 + wide * .3, 50], [-11 - wide * .3, 50]]);
  return piece([-26, -18, 26, 62], g => {
    fill(g, col, sl); within(g, sl, () => { cloud(g, 0, 20, 6, 0, 1.3); cloud(g, 0, 38, 4.5, 2, 1.1, -1); });
    ink(g, 1.6, sl);
    const sh = q => q.arc(0, 0, 11, 0, 7); fill(g, col, sh); ink(g, 1.4, sh);
  }, { seed });
}
// 前臂（窄袖 + 袖口）
function sleeveFA(col, cuff, seed) {
  return piece([-16, -12, 16, 52], g => {
    fill(g, col, q => q.arc(0, 0, 9, 0, 7)); ink(g, 1.3, q => q.arc(0, 0, 9, 0, 7));
    const sl = q => smooth(q, [[-10, -3], [10, -3], [10.5, 36], [-9.5, 36]]);
    fill(g, col, sl); within(g, sl, () => cloud(g, 0, 16, 5, .4, 1.2)); ink(g, 1.5, sl);
    const cf = q => poly(q, [[-9.5, 34], [9.5, 34], [9.5, 46], [-9.5, 46]]);
    fill(g, cuff, cf); within(g, cf, () => meander(g, -9, 44, 9, 3.2, .9)); ink(g, 1.3, cf);
  }, { seed });
}
// 垂袖：挂在前臂中段，枢轴在上缘，永远朝下垂（世界方向），向身后展开
function drape(col, seed) {
  return piece([-50, -8, 22, 92], g => {
    const d = q => smooth(q, [[-8, -2], [12, -2], [14, 30], [8, 60], [-6, 78], [-24, 86], [-40, 84], [-36, 66], [-26, 44], [-16, 20]]);
    fill(g, col, d);
    within(g, d, () => { cloud(g, -10, 34, 8, .4, 1.5, -1); cloud(g, -24, 66, 6, 2, 1.3); for (let k = 0; k < 4; k++) cutLine(g, 1.3, q => { q.moveTo(4 - k * 6, 6 + k * 3); q.quadraticCurveTo(-2 - k * 7, 40 + k * 6, -12 - k * 7, 72 + k * 3); }); });
    ink(g, 1.6, d);
    fill(g, DYE.brown, q => smooth(q, [[-40, 84], [-24, 86], [-6, 78], [8, 60], [11, 64], [-4, 84], [-24, 92], [-42, 90]])); ink(g, 1.2, q => smooth(q, [[-40, 84], [-24, 86], [-6, 78], [8, 60], [11, 64], [-4, 84], [-24, 92], [-42, 90]]));
  }, { seed });
}
function hand(kind, seed = 40) {
  const K = 1.1;
  return piece([-20, -6, 26, 34], g => {
    g.scale(K, K);
    let f;
    if (kind === 'grip') f = q => smooth(q, [[-7, -1], [7, -1], [11, 7], [11, 17], [5, 22], [-5, 21], [-9, 12]]);
    else if (kind === 'flat') f = q => smooth(q, [[-6.5, -1], [6.5, -1], [8.5, 10], [9, 24], [5.5, 29], [2.5, 26], [1.5, 18], [-4, 22], [-7.5, 13]]);
    else if (kind === 'point') f = q => smooth(q, [[-7, -1], [7, -1], [10, 8], [9, 14], [11, 27], [8, 30], [5, 16], [0, 21], [-7, 13]]);
    else f = q => smooth(q, [[-7, -1], [7, -1], [12, 8], [13, 16], [8, 21], [-2, 22], [-8, 14]]);
    fill(g, DYE.skin, f);
    if (kind === 'grip') cut(g, q => { q.ellipse(1.5, 12.5, 2.6, 3.4, 0, 0, Math.PI * 2); });
    if (kind === 'flat') for (const y of [11, 16]) cutLine(g, .8, q => { q.moveTo(-4, y); q.lineTo(6, y - 1); });
    if (kind === 'fist') { cutLine(g, .8, q => { q.moveTo(3, 7); q.quadraticCurveTo(9, 10, 8, 17); }); }
    ink(g, 1.5, f);
  }, { seed });
}
const HANDS = () => ({ grip: hand('grip'), flat: hand('flat'), point: hand('point'), fist: hand('fist') });

// ================= 唐僧 =================
function tsHead() {
  return piece([-50 * HK, -130 * HK, 40 * HK, 70 * HK], scaled(HK, g => {
    // 飘带（毗卢帽后垂两条）
    for (const [dx, col] of [[0, DYE.red], [7, DYE.green]]) {
      const rb = q => smooth(q, [[-26 + dx, -74], [-20 + dx, -74], [-26 + dx, -30], [-34 + dx, 20], [-30 + dx, 44], [-40 + dx, 46], [-42 + dx, 16], [-34 + dx, -30]]);
      fill(g, col, rb); within(g, rb, () => { for (let y = -60; y < 40; y += 11) cutLine(g, 1.2, q => { q.moveTo(-40 + dx, y + 4); q.lineTo(-22 + dx, y); }); }); ink(g, 1.3, rb);
    }
    // 后脑轮廓（开脸：不上色）
    ink(g, 2.2, q => { smooth(q, [[-22, -72], [-27, -56], [-24, -36], [-14, -22], [-6, -12]], false); });
    // 大耳垂
    const ear = q => smooth(q, [[-3, -58], [-11, -58], [-13, -46], [-11, -32], [-6, -25], [-2, -30], [-4, -44]]);
    fill(g, DYE.skin, ear); cutLine(g, 1.1, q => { q.moveTo(-6, -54); q.quadraticCurveTo(-10, -46, -7, -38); }); ink(g, 1.5, ear);
    // 脸：侧面轮廓（额 → 鼻 → 唇 → 下巴 → 颌）
    ink(g, 2.3, q => smooth(q, [[15, -72], [20, -66], [22, -59], [24, -54], [29, -46], [25, -43], [26, -40], [24.5, -37.5], [26, -34.5], [23, -29], [18, -24.5], [10, -22], [4, -14]], false));
    neck(g, [6, -18], [-8, -16]);
    // 低垂的眼（慈悲）、细长眉
    ink(g, 1.6, q => { q.moveTo(11, -54.5); q.quadraticCurveTo(16, -57.5, 22.5, -55); });
    ink(g, .9, q => { q.moveTo(12, -54); q.quadraticCurveTo(16, -52.5, 21.5, -54.2); });
    g.beginPath(); g.arc(18.5, -54.6, 1.4, 0, 7); g.fillStyle = DYE.ink; g.fill();
    ink(g, 1.3, q => { q.moveTo(9, -60.5); q.quadraticCurveTo(16, -63.5, 24, -60.5); });
    ink(g, 1, q => { q.moveTo(17, -42); q.quadraticCurveTo(20, -44, 23, -41.5); });
    g.beginPath(); g.arc(24, -60, 1.3, 0, 7); g.fillStyle = DYE.red; g.fill();    // 眉间红点
    // 毗卢帽：帽箍 + 三瓣（侧面看见前、中、后三片）
    const base = q => smooth(q, [[-28, -66], [-6, -71], [18, -74], [20, -66], [-4, -63], [-27, -58]]);
    const petal = (cx, by, h, w, lean) => q => { q.moveTo(cx - w, by); q.quadraticCurveTo(cx - w * 1.1 + lean * .3, by - h * .55, cx + lean, by - h); q.quadraticCurveTo(cx + w * 1.1 + lean * .3, by - h * .55, cx + w, by); q.closePath(); };
    for (const [cx, by, h, w, lean] of [[-20, -64, 42, 11, -4], [-2, -68, 52, 12.5, 0], [14, -70, 42, 11, 4]]) {
      const pe = petal(cx, by, h, w, lean);
      fill(g, DYE.red, pe);
      const inner = petal(cx, by - 3, h - 8, w - 4.5, lean * .8); fill(g, DYE.gold, inner);
      within(g, inner, () => { cut(g, q => { q.arc(cx + lean * .4, by - h * .56, 3.6, 0, 7); }); cut(g, q => { q.ellipse(cx + lean * .2, by - h * .3, 3.4, 5.5, 0, 0, 7); }); beadLine(g, cx - w + 5, by - 4, cx + w - 5, by - 4, 1, 3.4); });
      ink(g, 1.2, inner); ink(g, 1.6, pe);
      g.beginPath(); g.arc(cx + lean, by - h - 3, 2.6, 0, 7); g.fillStyle = DYE.orange; g.fill(); ink(g, 1, q => q.arc(cx + lean, by - h - 3, 2.6, 0, 7));
    }
    fill(g, DYE.yellow, base); within(g, base, () => beadLine(g, -24, -63.5, 16, -70, 1.3, 5)); ink(g, 1.6, base);
  }), { seed: 41 });
}
function tsUpper() {
  const body = q => smooth(q, [[-25, 4], [-29, -40], [-29, -76], [-21, -96], [-6, -108], [8, -110], [20, -104], [28, -90], [33, -68], [33, -40], [29, -10], [27, 4]]);
  const kas = q => poly(q, [[-29, -84], [-18, -100], [-4, -104], [33, -46], [31, 4], [-25, 4], [-30, -40]]);
  return piece([-38, -124, 44, 10], g => {
    fill(g, DYE.yellow, body); within(g, body, () => lattice(g, -34, -120, 40, 6, 12, 2));
    // 袈裟：田相格（金条留皮，红格刻钱孔）
    fill(g, DYE.gold, kas);
    within(g, kas, () => { for (let y = -104; y < 6; y += 19) for (let x = -34 + ((y / 19) % 2 ? 8 : 0); x < 40; x += 17) { fill(g, DYE.red, q => q.rect(x + 1.5, y + 1.5, 14, 16)); coin(g, x + 8.5, y + 9.5, 3.4); } });
    ink(g, 1.6, kas);
    // 交领 + 袈裟金环
    fill(g, DYE.white, q => poly(q, [[-4, -108], [8, -110], [20, -84], [14, -82]])); ink(g, 1.2, q => poly(q, [[-4, -108], [8, -110], [20, -84], [14, -82]]));
    const ring = q => { q.arc(16, -72, 7.5, 0, 7); q.arc(16, -72, 4.5, 0, 7, true); };
    fill(g, DYE.yellow, ring); ink(g, 1.3, q => q.arc(16, -72, 7.5, 0, 7)); ink(g, 1, q => q.arc(16, -72, 4.5, 0, 7));
    ink(g, 2.2, body);
  }, { seed: 42 });
}
function tsLower() {
  const robe = q => smooth(q, [[-29, -4], [29, -4], [36, 80], [44, 170], [52, 238], [-44, 238], [-38, 170], [-33, 80]]);
  const kas = q => poly(q, [[-28, -4], [30, -4], [38, 110], [44, 192], [-34, 204], [-34, 90]]);
  return piece([-56, -10, 72, 246], g => {
    fill(g, DYE.yellow, robe); within(g, robe, () => { lattice(g, -60, -6, 70, 240, 12, 2); fill(g, DYE.brown, q => q.rect(-60, 220, 130, 20)); meander(g, -50, 234, 60, 5, 1.6); });
    fill(g, DYE.gold, kas);
    within(g, kas, () => { for (let y = -6, r = 0; y < 206; y += 21, r++) for (let x = -40 + (r % 2) * 9; x < 50; x += 18) { fill(g, DYE.red, q => q.rect(x + 1.5, y + 1.5, 15, 18)); coin(g, x + 9, y + 10.5, 3.6); } });
    ink(g, 1.7, kas);
    // 僧鞋：墨色云头
    const shoe = q => smooth(q, [[34, 226], [52, 224], [62, 230], [58, 240], [34, 240]]);
    fill(g, DYE.ink, shoe); cloud(g, 52, 232, 3.5, 0, 1); ink(g, 1.2, shoe, '#000');
    ink(g, 2.2, robe);
  }, { seed: 43 });
}
// ================= 村姑 =================
function girlHead() {
  return piece([-50 * HK, -110 * HK, 40 * HK, 26 * HK], scaled(HK, g => {
    // 发：墨色一整片 + 发髻 + 刻发丝
    const hair = q => smooth(q, [[20, -66], [12, -76], [-2, -80], [-18, -76], [-28, -64], [-30, -48], [-24, -32], [-14, -26], [-8, -34], [-6, -50], [2, -60], [14, -60]]);
    const bun = q => { q.arc(-24, -80, 15, 0, 7); };
    const knot = q => { q.arc(-31, -46, 9, 0, 7); };
    for (const s of [bun, knot, hair]) fill(g, DYE.ink, s);
    within(g, hair, () => { for (let k = 0; k < 9; k++) cutLine(g, .8, q => { q.moveTo(14 - k * 4, -74 + k); q.quadraticCurveTo(-8 - k * 2, -62 + k * 2, -16 - k, -36 + k); }); });
    within(g, bun, () => { for (let k = 0; k < 4; k++) cutLine(g, .8, q => { q.arc(-24, -80, 5 + k * 2.6, -2.6, .4); }); });
    ink(g, 1.1, q => { hair(q); bun(q); knot(q); }, '#000');
    // 发簪 + 红花
    ink(g, 2.4, q => { q.moveTo(-44, -90); q.lineTo(-6, -76); }, DYE.gold);
    fill(g, DYE.gold, q => { q.arc(-44, -90, 3.2, 0, 7); }); ink(g, 1, q => q.arc(-44, -90, 3.2, 0, 7));
    const fl = q => { q.arc(-12, -90, 7.5, 0, 7); }; fill(g, DYE.red, fl); plum(g, -12, -90, 3.2); ink(g, 1.2, fl);
    // 脸（开脸）
    ink(g, 2.2, q => smooth(q, [[17, -63], [20, -58], [21, -54], [25, -48.5], [22, -46], [23, -42], [21.5, -40], [22, -37.5], [19.5, -33.5], [14, -30.5], [6, -31], [2, -22], [2, -12]], false));
    neck(g, [4, -24], [-6, -26]);
    ink(g, 1.5, q => { q.moveTo(11, -52.5); q.quadraticCurveTo(16, -55.5, 21, -52.8); });
    ink(g, .8, q => { q.moveTo(12, -51.8); q.quadraticCurveTo(16, -50.5, 20, -52.2); });
    g.beginPath(); g.arc(17, -52.5, 1.5, 0, 7); g.fillStyle = DYE.ink; g.fill();
    ink(g, 1.1, q => { q.moveTo(10, -57.5); q.quadraticCurveTo(16, -60.5, 22, -58); });
    g.beginPath(); g.ellipse(21.5, -38.8, 1.8, 1, .2, 0, 7); g.fillStyle = DYE.red; g.fill();
    ink(g, 1.2, q => { q.moveTo(-2, -48); q.quadraticCurveTo(-7, -44, -3, -40); });
    fill(g, DYE.gold, q => { q.moveTo(-3, -39); q.lineTo(-1, -33); q.lineTo(-5, -33); q.closePath(); });
  }), { seed: 51 });
}
function girlUpper() {
  const body = q => smooth(q, [[-22, 4], [-25, -40], [-24, -76], [-17, -96], [-4, -106], [8, -108], [18, -102], [25, -88], [28, -66], [26, -38], [23, -10], [22, 4]]);
  return piece([-36, -124, 40, 10], g => {
    fill(g, DYE.teal, body); within(g, body, () => { lattice(g, -30, -80, 34, 6, 9, 1.8); fill(g, DYE.gold, q => q.rect(-30, -10, 64, 14)); meander(g, -26, 1, 30, 3.6, 1.1); });
    const cc = q => smooth(q, [[-20, -94], [-24, -84], [-14, -79], [-6, -86], [3, -77], [12, -86], [21, -79], [27, -88], [24, -100], [10, -110], [-6, -110]]);
    fill(g, DYE.white, cc); within(g, cc, () => { for (const [x, y, f] of [[-14, -89, 1], [3, -90, -1], [18, -91, 1]]) cloud(g, x, y, 4.6, 1, 1.2, f); }); ink(g, 1.5, cc);
    ink(g, 2, body);
  }, { seed: 52 });
}
function girlLower() {
  const sk = q => smooth(q, [[-24, -4], [24, -4], [30, 70], [38, 160], [46, 236], [-40, 236], [-34, 160], [-28, 70]]);
  return piece([-50, -10, 64, 244], g => {
    fill(g, C2.pink, sk);
    within(g, sk, () => {
      for (let k = 0; k < 7; k++) cutLine(g, 1.6, q => { q.moveTo(-18 + k * 7, 20); q.lineTo(-30 + k * 11.5, 226); });
      const pts = []; for (let k = 0; k < 16; k++) pts.push([-26 + (k * 29 % 60), 40 + (k * 47 % 170)]); for (const [x, y] of pts) plum(g, x, y, 3.2);
      fill(g, DYE.green, q => q.rect(-40, 214, 100, 24)); waves(g, -36, 222, 56, 236, 5, 1.2);
    });
    // 腰带 + 两条垂带
    const sash = q => poly(q, [[-25, -4], [25, -4], [26, 10], [-26, 10]]);
    fill(g, DYE.green, sash); within(g, sash, () => { for (let x = -20; x < 22; x += 8) coin(g, x, 3, 3); }); ink(g, 1.4, sash);
    for (const [x, l] of [[18, 118], [26, 100]]) { const rb = q => poly(q, [[x - 3.5, 8], [x + 3.5, 8], [x + 5, 8 + l], [x, 8 + l + 8], [x - 5, 8 + l]]); fill(g, DYE.green, rb); within(g, rb, () => { for (let y = 20; y < l; y += 12) cutLine(g, 1, q => { q.moveTo(x - 3, y); q.lineTo(x + 3, y + 3); }); }); ink(g, 1.2, rb); }
    const shoe = q => smooth(q, [[30, 228], [44, 226], [52, 231], [48, 239], [30, 239]]); fill(g, DYE.red, shoe); ink(g, 1.1, shoe);
    ink(g, 2, sk);
  }, { seed: 53 });
}
function basket() {
  return piece([-44, -6, 44, 78], g => {
    const hd = q => { q.moveTo(-30, 30); q.bezierCurveTo(-32, -8, 32, -8, 30, 30); q.lineTo(25, 30); q.bezierCurveTo(26, 0, -26, 0, -25, 30); q.closePath(); };
    fill(g, DYE.hide2, hd); ink(g, 1.3, hd);
    const bw = q => smooth(q, [[-40, 30], [40, 30], [34, 60], [22, 72], [-22, 72], [-34, 60]]);
    fill(g, DYE.hide2, bw); within(g, bw, () => { lattice(g, -44, 36, 44, 76, 7, 1.6); fill(g, DYE.brown, q => q.rect(-44, 30, 88, 7)); });
    ink(g, 1.6, bw);
    const cl = q => smooth(q, [[-36, 32], [-20, 20], [0, 16], [22, 20], [36, 32]]);
    fill(g, DYE.red, cl); coin(g, 0, 25, 4); ink(g, 1.2, cl);
  }, { seed: 54 });
}
// ================= 老妇 =================
function croneHead() {
  return piece([-46 * HK, -96 * HK, 40 * HK, 26 * HK], scaled(HK, g => {
    const hair = q => smooth(q, [[18, -64], [8, -74], [-6, -76], [-20, -70], [-28, -56], [-28, -40], [-18, -30], [-8, -38], [-4, -52], [4, -60]]);
    const bun = q => q.arc(-24, -70, 11, 0, 7);
    for (const s of [bun, hair]) fill(g, DYE.white, s);
    within(g, hair, () => { for (let k = 0; k < 8; k++) cutLine(g, .9, q => { q.moveTo(12 - k * 4, -70 + k); q.quadraticCurveTo(-8 - k * 2, -60 + k * 2, -14 - k, -36 + k); }); });
    within(g, bun, () => { for (let k = 0; k < 3; k++) cutLine(g, .9, q => q.arc(-24, -70, 4 + k * 2.6, -2.6, .6)); });
    ink(g, 1.4, q => { hair(q); bun(q); });
    // 抹额：墨色头带 + 翠玉
    const band = q => smooth(q, [[-26, -58], [-6, -66], [16, -68], [18, -61], [-4, -59], [-25, -51]]);
    fill(g, DYE.ink, band); within(g, band, () => beadLine(g, -20, -56, 10, -63, 1, 4.6)); ink(g, 1, band, '#000');
    const jd = q => q.ellipse(14, -64.5, 4.4, 3.6, 0, 0, 7); fill(g, DYE.jade, jd); ink(g, 1, jd);
    // 脸：鹰钩鼻、瘪嘴、翘下巴
    ink(g, 2.2, q => smooth(q, [[16, -60], [19, -55], [21, -51], [27, -44], [23, -41.5], [20, -40], [19, -37], [22, -32], [22, -28], [16, -25], [8, -26], [3, -16], [2, -8]], false));
    neck(g, [5, -22], [-8, -30]);
    ink(g, 1.3, q => { q.moveTo(11, -49.5); q.quadraticCurveTo(15, -51.5, 19.5, -49.5); });
    g.beginPath(); g.arc(15.5, -49.4, 1.3, 0, 7); g.fillStyle = DYE.ink; g.fill();
    ink(g, 1, q => { q.moveTo(19, -52); q.lineTo(22, -54); q.moveTo(19.5, -48.5); q.lineTo(22.5, -47.5); q.moveTo(11, -44); q.quadraticCurveTo(14, -38, 17, -35); q.moveTo(9, -52); q.quadraticCurveTo(14, -55, 19, -53.5); });
    ink(g, 1.1, q => { q.moveTo(-2, -46); q.quadraticCurveTo(-7, -42, -3, -37); });
  }), { seed: 61 });
}
function croneUpper() {
  const body = q => smooth(q, [[-26, 4], [-34, -30], [-40, -64], [-33, -90], [-17, -104], [2, -108], [16, -100], [25, -84], [28, -60], [27, -30], [24, 4]]);
  return piece([-48, -122, 40, 10], g => {
    fill(g, DYE.brown, body);
    within(g, body, () => { for (let y = -88, r = 0; y < 0; y += 13, r++) for (let x = -38 + (r % 2) * 7; x < 30; x += 14) coin(g, x, y, 4); });
    const pl = q => poly(q, [[2, -106], [10, -104], [24, -40], [22, 4], [14, 4], [16, -40]]);
    fill(g, DYE.gold, pl); within(g, pl, () => { for (let y = -96; y < 0; y += 12) cloud(g, 13 + y * -.09, y, 3.2, 0, 1); }); ink(g, 1.3, pl);
    fill(g, DYE.ink, q => smooth(q, [[-14, -104], [2, -110], [16, -100], [10, -96], [-10, -98]]));
    ink(g, 2.1, body);
  }, { seed: 62 });
}
function croneLower() {
  const sk = q => smooth(q, [[-26, -4], [26, -4], [32, 80], [38, 170], [42, 236], [-40, 236], [-34, 170], [-30, 80]]);
  return piece([-48, -10, 56, 244], g => {
    fill(g, C2.slate, sk);
    within(g, sk, () => { lattice(g, -46, -6, 50, 200, 11, 1.8); fill(g, DYE.ink, q => q.rect(-50, 200, 100, 40)); waves(g, -44, 210, 46, 236, 5.5, 1.3); });
    const shoe = q => smooth(q, [[26, 228], [40, 226], [48, 231], [44, 239], [26, 239]]); fill(g, DYE.ink, shoe); ink(g, 1, shoe, '#000');
    ink(g, 2, sk);
  }, { seed: 63 });
}
// ================= 老翁 =================
function elderHead() {
  return piece([-50 * HK, -100 * HK, 44 * HK, 60 * HK], scaled(HK, g => {
    // 方巾 + 后垂巾脚
    const tail = q => smooth(q, [[-22, -72], [-27, -70], [-34, -46], [-38, -26], [-33, -26], [-28, -46]]);
    fill(g, DYE.ink, tail); within(g, tail, () => { for (let y = -62; y < -30; y += 8) cutLine(g, .8, q => { q.moveTo(-35, y + 2); q.lineTo(-28, y); }); }); ink(g, 1, tail, '#000');
    const cap = q => smooth(q, [[18, -68], [16, -84], [4, -96], [-12, -98], [-24, -88], [-28, -68], [-6, -70]]);
    fill(g, DYE.ink, cap); within(g, cap, () => { cutLine(g, 1.2, q => { q.moveTo(-26, -74); q.quadraticCurveTo(-4, -78, 17, -74); }); for (let k = 0; k < 4; k++) cloud(g, -16 + k * 9, -86 + (k % 2) * 3, 3, k, .9, k % 2 ? 1 : -1); });
    ink(g, 1, cap, '#000');
    // 鬓发（白）
    const tem = q => smooth(q, [[-24, -68], [-6, -68], [-6, -50], [-16, -36], [-26, -44]]);
    fill(g, DYE.white, tem); within(g, tem, () => { for (let k = 0; k < 5; k++) cutLine(g, .8, q => { q.moveTo(-8 - k * 3.5, -66); q.lineTo(-12 - k * 3, -42); }); }); ink(g, 1.2, tem);
    // 脸
    ink(g, 2.2, q => smooth(q, [[17, -68], [20, -60], [22, -55], [28, -46], [24, -43]], false));
    ink(g, 1.3, q => { q.moveTo(12, -52); q.quadraticCurveTo(16, -54, 20, -52); });
    g.beginPath(); g.arc(16.2, -52, 1.3, 0, 7); g.fillStyle = DYE.ink; g.fill();
    // 白寿眉
    const brow = q => poly(q, [[8, -58], [14, -61], [20, -60], [26, -57], [30, -52], [24, -55.5], [18, -57], [12, -56]]);
    fill(g, DYE.white, brow); ink(g, 1, brow);
    // 长须：白色一整片，刻须丝
    const beard = q => smooth(q, [[24, -43], [26, -38], [22, -24], [26, -6], [22, 12], [26, 30], [16, 40], [12, 20], [6, 8], [2, -10], [0, -24], [6, -36], [14, -40]]);
    fill(g, DYE.white, beard);
    within(g, beard, () => { for (let k = 0; k < 7; k++) cutLine(g, 1, q => { q.moveTo(6 + k * 2.6, -34); q.bezierCurveTo(4 + k * 2.4, -10, 14 + k * 1.4, 4, 10 + k * 2, 34); }); });
    ink(g, 1.4, beard);
    neck(g, [4, -8], [-8, -22]);
    const mu = q => smooth(q, [[27, -42], [20, -38], [10, -40], [6, -35], [14, -34], [22, -35], [28, -37]]);
    fill(g, DYE.white, mu); ink(g, 1.1, mu);
    ink(g, 1.1, q => { q.moveTo(-2, -50); q.quadraticCurveTo(-7, -46, -3, -41); });
  }), { seed: 71 });
}
function elderUpper() {
  const body = q => smooth(q, [[-24, 4], [-28, -40], [-29, -76], [-21, -96], [-6, -108], [8, -110], [20, -104], [28, -90], [32, -68], [31, -40], [28, -10], [26, 4]]);
  return piece([-38, -124, 44, 10], g => {
    fill(g, C2.robe, body); within(g, body, () => { lattice(g, -34, -100, 40, 6, 10, 1.8); fill(g, DYE.brown, q => q.rect(-34, -12, 70, 14)); for (let x = -26; x < 30; x += 9) coin(g, x, -5, 3.2); });
    const col = q => poly(q, [[-4, -108], [8, -110], [22, -76], [15, -73]]);
    fill(g, DYE.white, col); ink(g, 1.2, col);
    ink(g, 2.1, body);
  }, { seed: 72 });
}
function elderLower() {
  const rb = q => smooth(q, [[-27, -4], [27, -4], [34, 80], [40, 170], [46, 236], [-42, 236], [-36, 170], [-31, 80]]);
  return piece([-50, -10, 62, 244], g => {
    fill(g, C2.robe, rb);
    within(g, rb, () => { lattice(g, -48, -6, 56, 214, 10, 1.8); fill(g, DYE.brown, q => q.rect(-50, 214, 110, 26)); meander(g, -40, 232, 46, 5, 1.5); });
    const shoe = q => smooth(q, [[30, 228], [46, 226], [55, 231], [51, 239], [30, 239]]); fill(g, DYE.ink, shoe); cloud(g, 46, 232, 3, 0, .9); ink(g, 1, shoe, '#000');
    ink(g, 2, rb);
  }, { seed: 73 });
}
// ================= 道具（世界坐标里画）=================
// 杖：G = 握点，a = 方向（0 = 向右），len = 握点以下长度，up = 握点以上长度
export function drawCane(g, K, G, a, len, up, kind = 'cane') {
  set(g, [1, 0, 0, 1, 0, 0]);
  const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux, w = (kind === 'staff' ? 3.6 : 2.8) * K;
  const A = [G[0] - ux * up * K, G[1] - uy * up * K], B = [G[0] + ux * len * K, G[1] + uy * len * K];
  g.beginPath(); g.moveTo(A[0] + nx * w, A[1] + ny * w); g.lineTo(B[0] + nx * w * .8, B[1] + ny * w * .8); g.lineTo(B[0] - nx * w * .8, B[1] - ny * w * .8); g.lineTo(A[0] - nx * w, A[1] - ny * w); g.closePath();
  g.fillStyle = kind === 'staff' ? DYE.brown : DYE.hide2; g.fill(); g.strokeStyle = DYE.ink; g.lineWidth = 1.2 * K; g.stroke();
  for (let s = .12; s < 1; s += kind === 'staff' ? .22 : .16) { const c = [A[0] + (B[0] - A[0]) * s, A[1] + (B[1] - A[1]) * s]; g.beginPath(); g.moveTo(c[0] + nx * w, c[1] + ny * w); g.lineTo(c[0] - nx * w, c[1] - ny * w); g.stroke(); }
  if (kind === 'cane') { g.beginPath(); g.arc(A[0] + nx * 7 * K, A[1] + ny * 7 * K, 7 * K, Math.atan2(-ny, -nx), Math.atan2(-ny, -nx) + Math.PI * 1.1); g.lineWidth = 5 * K; g.strokeStyle = DYE.ink; g.stroke(); g.lineWidth = 3 * K; g.strokeStyle = DYE.hide2; g.stroke(); }
  else { g.beginPath(); g.ellipse(A[0], A[1], 8 * K, 10 * K, a, 0, 7); g.fillStyle = DYE.brown; g.fill(); g.lineWidth = 1.3 * K; g.strokeStyle = DYE.ink; g.stroke(); cut2(g, A, 3 * K); }
}
function cut2(g, c, r) { g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(c[0], c[1], r, 0, 7); g.fill(); g.restore(); }
export function drawBeads(g, K, G, t = 0) {
  set(g, [1, 0, 0, 1, 0, 0]);
  const n = 14;
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, x = G[0] + Math.sin(a) * 9 * K + Math.sin(t * 2 + i) * .4 * K, y = G[1] + 16 * K + (1 - Math.cos(a)) * 14 * K; g.beginPath(); g.arc(x, y, 2.6 * K, 0, 7); g.fillStyle = i === 0 ? DYE.red : DYE.brown; g.fill(); g.lineWidth = .9 * K; g.strokeStyle = DYE.ink; g.stroke(); }
}

// ================= 白骨 =================
function boneShapes(g, list, col = C2.bone, ow = 3.2) {
  // 先粗描墨线，再用骨色覆盖 → 只剩外轮廓
  const path = (q, b) => {
    if (b[0] === 'l') { const [, x0, y0, x1, y1, w] = b; const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
      q.moveTo(x0 + nx * w * .5, y0 + ny * w * .5); q.lineTo(x1 + nx * w * .5, y1 + ny * w * .5); q.lineTo(x1 - nx * w * .5, y1 - ny * w * .5); q.lineTo(x0 - nx * w * .5, y0 - ny * w * .5); q.closePath();
      for (const [x, y] of [[x0, y0], [x1, y1]]) for (const sd of [1, -1]) { const cx = x + nx * w * .42 * sd, cy = y + ny * w * .42 * sd, r = w * .5; q.moveTo(cx + r, cy); q.arc(cx, cy, r, 0, Math.PI * 2); } }
    else if (b[0] === 'c') { q.moveTo(b[1] + b[3], b[2]); q.arc(b[1], b[2], b[3], 0, 7); }
    else if (b[0] === 'e') { q.moveTo(b[1] + b[3], b[2]); q.ellipse(b[1], b[2], b[3], b[4], b[5] || 0, 0, 7); }
    else if (b[0] === 'p') smooth(q, b[1]);
  };
  g.save(); g.lineJoin = 'round';
  for (const b of list) { if (b[0] === 'r') continue; g.beginPath(); path(g, b); g.lineWidth = ow * 2; g.strokeStyle = DYE.ink; g.stroke(); }
  for (const b of list) { if (b[0] === 'r') { g.beginPath(); g.moveTo(b[1][0][0], b[1][0][1]); g.bezierCurveTo(...b[1][1], ...b[1][2], ...b[1][3]); g.lineWidth = b[2] + ow * 2; g.strokeStyle = DYE.ink; g.lineCap = 'round'; g.stroke(); } }
  for (const b of list) { if (b[0] === 'r') { g.beginPath(); g.moveTo(b[1][0][0], b[1][0][1]); g.bezierCurveTo(...b[1][1], ...b[1][2], ...b[1][3]); g.lineWidth = b[2]; g.strokeStyle = col; g.stroke(); } else { g.beginPath(); path(g, b); g.fillStyle = col; g.fill('nonzero'); } }
  g.restore();
}
function skullAt(g, x, y, s = 1, rot = 0) {
  g.save(); g.translate(x, y); g.rotate(rot); g.scale(s, s);
  const cr = q => smooth(q, [[-30, 4], [-34, -22], [-24, -42], [-2, -48], [20, -40], [30, -22], [32, -6], [34, 8], [28, 14], [30, 22], [24, 30], [8, 32], [-2, 24], [-14, 22], [-26, 16]]);
  g.beginPath(); cr(g); g.lineWidth = 4.8; g.strokeStyle = DYE.ink; g.stroke(); g.fillStyle = C2.bone; g.fill();
  const hole = (fn) => { g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.beginPath(); fn(g); g.fill(); g.restore(); g.beginPath(); fn(g); g.lineWidth = 2; g.strokeStyle = DYE.ink; g.stroke(); };
  hole(q => q.ellipse(14, -8, 9, 10, .1, 0, 7));
  hole(q => { q.moveTo(28, 2); q.lineTo(33, 12); q.lineTo(25, 11); q.closePath(); });
  g.lineWidth = 1.6; g.strokeStyle = DYE.ink; g.beginPath(); g.moveTo(4, 22); g.lineTo(30, 20);
  for (let k = 0; k < 6; k++) { g.moveTo(8 + k * 4, 16); g.lineTo(8 + k * 4, 28); } g.stroke();
  g.beginPath(); g.moveTo(-22, 4); g.quadraticCurveTo(-6, 8, 4, 2); g.stroke();
  g.restore();
}
// 立着的白骨（X 光 / 真身离布）：根在脚下，腰 (0,-238)
function skeleton() {
  return piece([-70, -470, 80, 14], g => {
    const L = [];
    // 脊柱
    for (let k = 0; k < 13; k++) { const y = -352 + k * 9.4, x = -6 + Math.sin(k / 12 * Math.PI) * -5; L.push(['e', x, y, 6.5, 3.8, 0]); }
    // 骨盆
    L.push(['p', [[-24, -250], [-6, -262], [14, -256], [26, -238], [18, -216], [4, -222], [-6, -212], [-20, -222]]]);
    // 腿
    L.push(['l', 2, -226, 6, -126, 11]); L.push(['l', 6, -122, 2, -22, 9]); L.push(['l', -8, -228, -10, -126, 10]); L.push(['l', -10, -122, -12, -22, 8]);
    L.push(['p', [[-6, -24], [8, -22], [28, -10], [34, -2], [28, 4], [-4, 4]]]);
    L.push(['p', [[-18, -24], [-6, -22], [8, -6], [10, 2], [-18, 4]]]);
    // 臂
    L.push(['l', 6, -338, 10, -268, 9]); L.push(['l', 10, -264, 24, -204, 7]); L.push(['l', -6, -336, -12, -266, 8]); L.push(['l', -12, -262, -8, -204, 6.5]);
    for (const [hx, hy] of [[24, -204], [-8, -204]]) for (let f = 0; f < 4; f++) L.push(['l', hx - 4 + f * 3, hy + 2, hx - 6 + f * 4.5, hy + 22 - Math.abs(f - 1.5) * 2, 2.6]);
    // 锁骨、肋骨
    L.push(['l', -8, -340, 22, -334, 5]);
    for (let k = 0; k < 6; k++) { const y = -334 + k * 15; L.push(['r', [[-8, y], [12, y - 12], [34 - k, y + 2], [30 - k * 1.5, y + 26 + k * 2]], 4.2 - k * .2]); }
    L.push(['l', 31, -330, 25, -232, 4.5]);
    boneShapes(g, L);
    skullAt(g, 6, -392, 1.08, .05);
  }, { seed: 81 });
}
// 一堆白骨（地上，脊骨上刻"白骨夫人"）：根在地面中点
function bonePile() {
  return piece([-190, -110, 190, 16], g => {
    const L = [['l', -150, -10, -40, -24, 10], ['l', -60, -6, 70, -34, 9], ['l', 20, -12, 150, -4, 10], ['l', 80, -38, 170, -60, 7], ['l', -170, -36, -100, -12, 7], ['l', -120, -46, -20, -60, 6]];
    for (let k = 0; k < 5; k++) L.push(['r', [[-10 + k * 16, -8], [-4 + k * 16, -52], [26 + k * 16, -64], [40 + k * 15, -40]], 4.4]);
    L.push(['p', [[92, -18], [110, -34], [132, -30], [140, -12], [120, 0], [100, -2]]]);
    boneShapes(g, L);
    // 脊骨：一条宽骨，刻字
    const sp = q => smooth(q, [[-108, -76], [34, -92], [40, -70], [-104, -56]]);
    g.beginPath(); sp(g); g.lineWidth = 5; g.strokeStyle = DYE.ink; g.stroke(); g.fillStyle = DYE.brown; g.fill();
    g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.font = '400 27px "Ma Shan Zheng"'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.translate(-36, -74); g.rotate(-.11); g.letterSpacing = '6px'; g.fillText('白骨夫人', 0, 1); g.restore();
    for (let k = 0; k < 9; k++) ink(g, 1.3, q => { const x = -96 + k * 15; q.moveTo(x, -60 - k * 1.7 + 3); q.lineTo(x + 1, -58 - k * 1.7 + 6); });
    skullAt(g, -150, -40, 1.05, -.35);
  }, { seed: 82 });
}
// ================= 筋斗云 / 贬书 =================
function cloudPiece() {
  return piece([-150, -70, 150, 60], g => {
    const cl = q => smooth(q, [[-140, 20], [-120, -8], [-92, -4], [-78, -36], [-40, -52], [-4, -34], [16, -58], [58, -60], [84, -30], [118, -34], [136, -6], [120, 26], [80, 40], [30, 32], [-20, 42], [-70, 34], [-110, 38]]);
    fill(g, C2.paleJade, cl);
    within(g, cl, () => {
      for (const [x, y, r, f] of [[-96, 14, 17, 1], [-50, -18, 22, -1], [-4, 8, 18, 1], [42, -26, 22, -1], [92, 2, 19, 1]]) { cloud(g, x, y, r, 1, 3, f); }
      ink(g, 7, cl, DYE.teal);
    });
    ink(g, 2.2, cl);
  }, { seed: 91, ss: 2 });
}
function paper() {
  return piece([-40, -52, 40, 52], g => {
    const pg = q => poly(q, [[-34, -46], [34, -46], [34, 46], [-34, 46]]);
    fill(g, DYE.white, pg);
    for (let k = 0; k < 5; k++) cutLine(g, 1.6, q => { const x = 22 - k * 11; q.moveTo(x, -36); q.lineTo(x, 20 + (k % 2) * 8); });
    fill(g, DYE.red, q => q.rect(-28, 22, 16, 16)); ink(g, 1.4, pg);
  }, { seed: 92 });
}

// ================= 角色定义 =================
let D = null;
export function build() {
  if (D) return D;
  const H = HANDS();
  D = {
    tang: { head: tsHead(), upper: tsUpper(), lower: tsLower(), ua: sleeveUA(DYE.yellow, 44, 6), fa: sleeveFA(DYE.yellow, DYE.brown, 45), drape: drape(DYE.yellow, 46), H },
    girl: { head: girlHead(), upper: girlUpper(), lower: girlLower(), ua: sleeveUA(C2.pink, 55), fa: sleeveFA(C2.pink, DYE.white, 56), H, basket: basket() },
    crone: { head: croneHead(), upper: croneUpper(), lower: croneLower(), ua: sleeveUA(C2.slate, 64), fa: sleeveFA(C2.slate, DYE.ink, 65), H },
    elder: { head: elderHead(), upper: elderUpper(), lower: elderLower(), ua: sleeveUA(DYE.hide2, 74, 4), fa: sleeveFA(DYE.hide2, DYE.white, 75), drape: drape(DYE.hide2, 76), H },
    skeleton: skeleton(), pile: bonePile(), cloud: cloudPiece(), paper: paper()
  };
  return D;
}
export const RREST = { x: 0, y: 0, rot: 0, lean: 0, head: 0, fT: [8, 98], bT: [-4, 100], bendF: 1, bendB: 1, hF: 0, hB: 0, handF: 'fist', handB: 'fist', flip: 1, sc: 1, fall: 0, fallDir: 1 };

// 长袍皮影：pose.y = 地面；opt.explode = {u, seed}（散架：各片沿各自轨迹飞落）
export function drawRobed(g, Cam, who, pose, opt = {}) {
  const Dd = build(), P = Dd[who], p = { ...RREST, ...pose }, K0 = camK(Cam);
  const fa = p.fall * Math.PI / 2 * p.fallDir;
  const M0 = mul(T(p.x, p.y - Math.sin(p.fall * Math.PI / 2) * 30), mul(R(fa), mul(S(p.flip * p.sc, p.sc), R(p.rot))));
  const Wm = mul(M0, T(0, -RL.H0)), U = mul(Wm, R(p.lean)), Mh = mul(U, mul(T(...RJ.neck), R(p.head)));
  const [aF1, aF2] = ik(RJ.shF, [RJ.shF[0] + p.fT[0], RJ.shF[1] + p.fT[1]], RL.UA, RL.FA + RL.HANDR, p.bendF);
  const [aB1, aB2] = ik(RJ.shB, [RJ.shB[0] + p.bT[0], RJ.shB[1] + p.bT[1]], RL.UA, RL.FA + RL.HANDR, p.bendB);
  const arm = (sh, a1, a2, hA) => { const Mu = mul(U, mul(T(...RJ[sh]), R(a1))), Mf = mul(Mu, mul(T(...RJ.elbow), R(a2 - a1))), Mhd = mul(Mf, mul(T(...RJ.wrist), R(hA || 0))); return [Mu, Mf, Mhd]; };
  const [MuB, MfB, MhB] = arm('shB', aB1, aB2, p.hB), [MuF, MfF, MhF] = arm('shF', aF1, aF2, p.hF);
  const K = K0 * p.sc;
  const ex = opt.explode;
  const X = (M, id) => {           // 散架位移（世界 → 屏幕：先在屏幕里平移，再绕片枢轴转）
    let S2 = mul(Cam, M);
    if (!ex) return S2;
    const u = ex.u, r = k => hash(id * 17.3 + k * 3.1 + (ex.seed || 0));
    const vx = (r(1) - .5) * 520, vy = -160 - r(2) * 260, w = (r(3) - .5) * 9;
    const dx = vx * u, dy = vy * u + 900 * u * u;
    S2 = mul(S2, R(w * u));
    S2[4] += dx * K0; S2[5] += dy * K0; return S2;
  };
  const dp = (M, pc, id) => { set(g, X(M, id)); drawPiece(g, pc); };
  g.save(); g.globalCompositeOperation = 'multiply';
  // 画序：后臂 → 后手道具 → 下裳 → 上身 → 头 → 前臂 → 前手道具 → 前手
  const drM = (Mf, sw) => { const q = ap(Mf, 0, 24); return mul(T(q[0], q[1]), mul(S(p.flip * p.sc, p.sc), R(sw))); };
  if (P.drape) dp(drM(MfB, p.swB || 0), P.drape, 11);
  dp(MuB, P.ua, 1); dp(MfB, P.fa, 2);
  const GB = ap(mul(Cam, MhB), 1.9, 16);
  if (who === 'elder' && !ex) drawBeads(g, K, GB, opt.t || 0);
  dp(MhB, P.H[p.handB], 3);
  dp(Wm, P.lower, 4); dp(U, P.upper, 5); dp(Mh, P.head, 6);
  if (P.drape) dp(drM(MfF, p.swF || 0), P.drape, 12);
  dp(MuF, P.ua, 7); dp(MfF, P.fa, 8);
  const SF = X(MhF, 9), GF = ap(SF, 1.9, 16), fl = p.flip;
  const dirW = (a) => Math.atan2(Math.sin(a), Math.cos(a) * fl);        // 角色朝向下的方向 → 世界方向
  if (who === 'girl' && p.basket !== false) { const Mb = mul(mul(T(GF[0], GF[1]), R((p.basketA || 0) * fl)), S(K * fl, K)); set(g, mul(Mb, T(0, -2))); drawPiece(g, P.basket); }
  if (who === 'crone' && p.cane !== false) drawCane(g, K, GF, dirW(p.caneA ?? 1.42), p.caneLen ?? 196, 14, 'cane');
  if (who === 'elder' && p.cane !== false) drawCane(g, K, GF, dirW(p.caneA ?? 1.5), p.caneLen ?? 200, 70, 'staff');
  set(g, SF); drawPiece(g, P.H[(who === 'crone' || who === 'elder') && p.cane !== false ? 'grip' : p.handF]);
  g.restore();
  const Cm = M => mul(Cam, M);
  const riv = ex ? [] : [ap(Cm(U), ...RJ.neck), ap(Cm(U), ...RJ.shB), ap(Cm(U), ...RJ.shF), ap(Cm(Wm), 0, 0), ap(Cm(MuB), ...RJ.elbow), ap(Cm(MfB), ...RJ.wrist), ap(Cm(MuF), ...RJ.elbow), ap(Cm(MfF), ...RJ.wrist)];
  const rods = [ap(Cm(U), ...RJ.rod), ap(Cm(MhB), 0, 8), ap(Cm(MhF), 0, 8)];
  return { rods, riv, K, head: ap(Cm(Mh), 8, -60 * HK), hand: GF, waist: ap(Cm(Wm), 0, 0), root: ap(Cm(M0), 0, 0), M0: Cm(M0) };
}
// 白骨（立）：与长袍皮影同一根变换，叠在身体里
export function drawSkeleton(g, Cam, pose) {
  const p = { ...RREST, ...pose }, fa = p.fall * Math.PI / 2 * p.fallDir;
  const M0 = mul(Cam, mul(T(p.x, p.y), mul(R(fa), mul(S(p.flip * p.sc, p.sc), R(p.rot)))));
  g.save(); g.globalCompositeOperation = 'multiply'; set(g, M0); drawPiece(g, build().skeleton); g.restore();
  return ap(M0, 0, -300);
}
export function drawPile(g, Cam, x, y, sc = 1) { const M = mul(Cam, mul(T(x, y), S(sc))); g.save(); g.globalCompositeOperation = 'multiply'; set(g, M); drawPiece(g, build().pile); g.restore(); }
export function drawCloudP(g, Cam, x, y, sc = 1, rot = 0, flip = 1) { const M = mul(Cam, mul(T(x, y), mul(R(rot), S(sc * flip, sc)))); g.save(); g.globalCompositeOperation = 'multiply'; set(g, M); drawPiece(g, build().cloud); g.restore(); }
export function drawPaper(g, Cam, x, y, rot = 0, sc = 1) { const M = mul(Cam, mul(T(x, y), mul(R(rot), S(sc)))); g.save(); g.globalCompositeOperation = 'multiply'; set(g, M); drawPiece(g, build().paper); g.restore(); }
