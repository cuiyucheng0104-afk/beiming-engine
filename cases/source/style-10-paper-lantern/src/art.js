// 本片的纸雕图样：山、隧道拱廊、小火车、站屋、人影、站台。全部在米制画布上绘制（原点居中、y 向上）。
import { mulberry, TAU } from './lib.js';

export const FONT = { brush: '"MaShanZheng"' };
export const cut = (x, fn) => { x.save(); x.globalCompositeOperation = 'destination-out'; x.fillStyle = '#000'; x.strokeStyle = '#000'; fn(); x.restore(); };

// 起伏山脊：pts = [[x, y], …] 控制点（单调 x），之间用平滑曲线 + 细碎起伏；向下填满到 bottom
export function range(x, pts, o = {}) {
  const R = mulberry(o.seed || 1), ph = [R() * 9, R() * 9], amp = o.rough ?? .0016, bottom = o.bottom ?? -.3, step = .0015;
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
  const at = u => {   // 余弦插值
    let i = 0; while (i < pts.length - 2 && u > pts[i + 1][0]) i++;
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], f = Math.min(1, Math.max(0, (u - ax) / (bx - ax))), s = (1 - Math.cos(f * Math.PI)) / 2;
    return ay + (by - ay) * s;
  };
  x.beginPath(); x.moveTo(x0, bottom);
  for (let u = x0; u <= x1 + step; u += step) x.lineTo(u, at(u) + amp * (Math.sin(u * 140 + ph[0]) * .6 + Math.sin(u * 377 + ph[1]) * .4) * (o.flat && u > o.flat[0] && u < o.flat[1] ? .15 : 1));
  x.lineTo(x1, bottom); x.closePath(); x.fill();
  return at;
}

// 山体里的刻线（镂空细缝，让后层的光透出来）
export function carve(x, at, xa, xb, o = {}) {
  const lw = o.lw ?? .0006, R = mulberry(o.seed || 3);
  cut(x, () => {
    x.lineWidth = lw; x.lineCap = 'round';
    for (let k = 0; k < (o.n || 3); k++) {
      const dy = (o.dy ?? .012) * (k + 1), ph = R() * 9; x.beginPath(); let on = false;
      for (let u = xa; u <= xb; u += .002) {
        const y = at(u) - dy + .002 * Math.sin(u * 60 + ph);
        const ok = Math.sin(u * (o.f || 23) + ph * 3) > -.2;
        if (ok) { on ? x.lineTo(u, y) : x.moveTo(u, y); on = true; } else on = false;
      }
      x.stroke();
    }
  });
}

// 松树剪影
export function pine(x, cx, by, h, seed = 1) {
  const R = mulberry(seed), w = h * .42;
  x.fillRect(cx - h * .025, by, h * .05, h * .25);
  for (let i = 0; i < 4; i++) {
    const y0 = by + h * (.18 + i * .2), ww = w * (1 - i * .2) * (.9 + R() * .2);
    x.beginPath(); x.moveTo(cx - ww / 2, y0); x.lineTo(cx, y0 + h * .34); x.lineTo(cx + ww / 2, y0); x.closePath(); x.fill();
  }
}

// 草叶
export function grass(x, x0, x1, by, h, n, seed = 2) {
  const R = mulberry(seed);
  for (let i = 0; i < n; i++) {
    const px = x0 + (x1 - x0) * R(), hh = h * (.4 + R() * .8), lean = (R() - .5) * hh * .6, w = .0012 + R() * .0012;
    x.beginPath(); x.moveTo(px - w, by); x.quadraticCurveTo(px + lean * .3, by + hh * .6, px + lean, by + hh); x.quadraticCurveTo(px + lean * .3 + w * .4, by + hh * .55, px + w, by); x.fill();
  }
}

// —— 小火车：原点 = 车头前端、轨面；向 -x 延伸。返回窗口列表 [{x,y,w,h}]（车厢窗，按从前到后）——
export const TRAIN = { loco: .046, car: .04, gap: .003, len: .046 + .003 + .04 + .003 + .04 };
export function trainBody(x, o = {}) {
  const col = o.col || '#101833', dark = '#070b1a', wins = [], P = []; x.fillStyle = col;
  // 车头：锅炉 + 烟囱 + 司机室
  const L = -TRAIN.loco;
  x.beginPath(); x.roundRect(L + .016, .0045, .03, .014, .004); x.fill();                 // 锅炉
  x.fillRect(L + .002, .0045, .02, .024);                                                  // 司机室
  x.beginPath(); x.moveTo(L, .0285); x.lineTo(L + .024, .0285); x.lineTo(L + .022, .031); x.lineTo(L + .002, .031); x.fill(); // 顶
  x.beginPath(); x.moveTo(-.011, .018); x.lineTo(-.0055, .018); x.lineTo(-.004, .0275); x.lineTo(-.0125, .0275); x.fill();     // 烟囱
  x.beginPath(); x.moveTo(0, .004); x.lineTo(.0045, .0015); x.lineTo(0, .0015); x.fill();    // 排障器
  x.beginPath(); x.arc(-.024, .0185, .0028, Math.PI, 0); x.fill();                        // 汽包
  cut(x, () => x.fillRect(L + .006, .016, .009, .008));                                    // 司机室窗（洞）
  // 车轮
  x.fillStyle = dark;
  for (const k of [-.006, -.017, -.03, -.039]) { x.beginPath(); x.arc(k, .0045, k < -.025 ? .0035 : .0042, 0, TAU); x.fill(); }
  cut(x, () => { for (const k of [-.006, -.017]) { x.beginPath(); x.arc(k, .0045, .0013, 0, TAU); x.fill(); } });
  x.fillStyle = col;
  // 两节车厢
  for (let c = 0; c < 2; c++) {
    const R0 = L - TRAIN.gap - c * (TRAIN.car + TRAIN.gap), L0 = R0 - TRAIN.car;
    x.beginPath(); x.moveTo(L0, .005); x.lineTo(R0, .005); x.lineTo(R0, .022); x.quadraticCurveTo((L0 + R0) / 2, .0285, L0, .022); x.closePath(); x.fill();
    x.fillRect(R0, .008, TRAIN.gap, .002);                                                  // 车钩
    x.fillStyle = dark; for (const k of [.007, .033]) { x.beginPath(); x.arc(L0 + k, .0042, .0034, 0, TAU); x.fill(); } x.fillStyle = col;
    for (let i = 0; i < 3; i++) wins.push({ x: R0 - .007 - i * .0125 - .008, y: .0115, w: .008, h: .0075 });
  }
  cut(x, () => { for (const w of wins) { x.beginPath(); x.roundRect(w.x, w.y, w.w, w.h, .001); x.fill(); } });
  // 乘客剪影：第一节车厢第二扇窗（剩下的纸）
  const pw = wins[1];
  if (o.passenger !== false) { x.fillStyle = col; x.beginPath(); x.arc(pw.x + pw.w * .55, pw.y + pw.h * .62, .0017, 0, TAU); x.fill();
    x.beginPath(); x.moveTo(pw.x + pw.w * .2, pw.y); x.quadraticCurveTo(pw.x + pw.w * .55, pw.y + pw.h * .58, pw.x + pw.w * .9, pw.y); x.fill(); }
  return wins;
}

// —— 站屋：原点 = 屋前地面中心 ——
export const HOUSE = { w: .062, h: .042, win: { x: .009, y: .016, w: .013, h: .011 }, door: { x: -.016, y: 0, w: .015, h: .029 } };
export function houseBody(x, o = {}) {
  const { w, h } = HOUSE, col = o.col || '#2c3f6c', roof = o.roof || '#141f3d';
  x.fillStyle = col; x.fillRect(-w / 2, 0, w, h);
  x.fillStyle = roof; x.beginPath(); x.moveTo(-w / 2 - .007, h - .002); x.lineTo(w / 2 + .007, h - .002); x.lineTo(w / 2 - .006, h + .016); x.lineTo(-w / 2 + .006, h + .016); x.closePath(); x.fill();
  x.fillRect(w * .22, h + .008, .006, .016);                                                 // 烟囱
  x.fillRect(-w / 2 - .007, h - .004, w + .014, .003);
  const W = HOUSE.win, D = HOUSE.door;
  cut(x, () => { x.fillRect(W.x, W.y, W.w, W.h); x.fillRect(D.x, D.y, D.w, D.h); });
  x.fillStyle = roof; x.fillRect(W.x + W.w / 2 - .0006, W.y, .0012, W.h); x.fillRect(W.x, W.y + W.h / 2 - .0006, W.w, .0012);   // 窗棂
  x.fillRect(W.x - .001, W.y - .0015, W.w + .002, .0015);
  x.fillRect(D.x - .0012, D.y + D.h, D.w + .0024, .0018);                                    // 门楣
}

// —— 人影（等待的人）：原点 = 脚底中心，s = 身高；肩点 SHOULDER ——
export const SHOULDER = [[-.11, .74], [.11, .74]];
export function figureBody(x, s, col = '#0a0f22') {
  x.fillStyle = col;
  x.beginPath(); x.arc(0, s * .88, s * .085, 0, TAU); x.fill();                                // 头
  x.beginPath(); x.moveTo(-s * .05, s * .8); x.lineTo(s * .05, s * .8); x.lineTo(s * .06, s * .76); x.lineTo(-s * .06, s * .76); x.fill();
  x.beginPath(); x.moveTo(-s * .13, s * .76); x.quadraticCurveTo(0, s * .8, s * .13, s * .76);   // 肩
  x.lineTo(s * .12, s * .45); x.lineTo(s * .2, 0); x.lineTo(-s * .2, 0); x.lineTo(-s * .12, s * .45); x.closePath(); x.fill();
  // 围巾的尾巴
  x.beginPath(); x.moveTo(s * .04, s * .77); x.lineTo(s * .09, s * .6); x.lineTo(s * .06, s * .59); x.lineTo(s * .02, s * .76); x.fill();
}
// 手臂：原点 = 肩点，自然下垂指向 -y；长 s*.42
export function armShape(x, s, col = '#0a0f22') {
  x.fillStyle = col; const L = s * .42, w = s * .055;
  x.beginPath(); x.moveTo(-w, 0); x.quadraticCurveTo(0, w * 1.2, w, 0); x.lineTo(w * .7, -L * .92); x.quadraticCurveTo(0, -L - w * .6, -w * .7, -L * .92); x.closePath(); x.fill();
}

// 一朵蒸汽（纸片云）
export function puff(x, r, col = '#d6deee') {
  x.fillStyle = col; const R = mulberry(9);
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU, d = r * .45; x.beginPath(); x.arc(Math.cos(a) * d, Math.sin(a) * d * .7, r * (.45 + R() * .15), 0, TAU); x.fill(); }
  x.beginPath(); x.arc(0, 0, r * .6, 0, TAU); x.fill();
}
