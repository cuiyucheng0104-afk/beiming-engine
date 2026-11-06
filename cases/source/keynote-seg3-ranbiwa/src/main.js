// 片段三入口：render(t) 确定性；A11–A12 用 2D 手卷取景，A13 同一张纸贴到三维书页上。
import { DUR, T, b, events } from './timeline.js';
import { initScroll, drawWorld, camX, shake, textsAt, G, WP, HP, TXT, BOX } from './scroll2d.js';
import { makeStage, KM, X, Z, HPG, PW, PH } from './stage3d.js';
import { clamp } from '/core/lib.js';

const q = new URLSearchParams(location.search);
const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image ' + src)); i.src = src; });
const M = '/@film/material/';
const cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

await Promise.all([document.fonts.load('70px MSZ', '中国奇谭'), document.fonts.load('500 27px NSC', '部位导演')]);
const IMG = {};
const list = { whale: 'P12_中国奇谭_鲸鱼主视觉.png', w0: 'P13_中国奇谭2_如何成为三条龙.png', w1: 'P13_中国奇谭2_耳中人.png', w2: 'P13_中国奇谭2_小雪.png', w3: 'P13_中国奇谭2_大贵人.png', lls: 'P14_浪浪山小妖怪_海报.png', rbw: 'P15_燃比娃_宣纸手绘.png',
  paper: 'web/paper.jpg', paperBack: 'web/paper_back.jpg', silk: 'web/silk.jpg', curtain: 'web/curtain.jpg', cloth: 'web/cloth.jpg' };
await Promise.all(Object.entries(list).map(async ([k, f]) => { IMG[k] = await load(M + encodeURI(f)); }));
// 棉布幕：取素材左侧无灯影的一块，去掉低频明暗只留织纹，再镜像拼成无缝纹理
{ const c = cv(760, 1000), x = c.getContext('2d'); x.drawImage(IMG.curtain, 80, 60, 760, 1000, 0, 0, 760, 1000);
  const d = x.getImageData(0, 0, 760, 1000), a = d.data, W = 760, H = 1000, bw = 60;
  // 局部均值（盒式模糊，步长取样）
  const lum = new Float32Array(W * H); for (let i = 0; i < W * H; i++) lum[i] = (a[i * 4] + a[i * 4 + 1] + a[i * 4 + 2]) / 3;
  const gw = Math.ceil(W / bw), gh = Math.ceil(H / bw), gm = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) { let s = 0, n = 0; for (let y = gy * bw; y < Math.min(H, gy * bw + bw); y += 3) for (let xx = gx * bw; xx < Math.min(W, gx * bw + bw); xx += 3) { s += lum[y * W + xx]; n++; } gm[gy * gw + gx] = s / n; }
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    const fx = Math.min(gw - 1.001, Math.max(0, xx / bw - .5)), fy = Math.min(gh - 1.001, Math.max(0, y / bw - .5)), ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy;
    const m = gm[iy * gw + ix] * (1 - u) * (1 - v) + gm[iy * gw + ix + 1] * u * (1 - v) + gm[(iy + 1) * gw + ix] * (1 - u) * v + gm[(iy + 1) * gw + ix + 1] * u * v;
    const i = (y * W + xx) * 4; for (let j = 0; j < 3; j++) a[i + j] = clamp(a[i + j] / m * 222, 0, 255);
  }
  x.putImageData(d, 0, 0);
  const t2 = cv(1520, 2000), y2 = t2.getContext('2d');
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { y2.save(); y2.translate(sx < 0 ? 1520 : 0, sy < 0 ? 2000 : 0); y2.scale(sx, sy); y2.drawImage(c, sx < 0 ? 0 : 0, 0); y2.restore(); }
  // 第二、三、四象限放到右/下
  const t3 = cv(1520, 2000), y3 = t3.getContext('2d');
  y3.drawImage(c, 0, 0); y3.save(); y3.translate(1520, 0); y3.scale(-1, 1); y3.drawImage(c, 0, 0); y3.restore();
  y3.save(); y3.translate(0, 2000); y3.scale(1, -1); y3.drawImage(c, 0, 0); y3.save(); y3.translate(1520, 0); y3.scale(-1, 1); y3.drawImage(c, 0, 0); y3.restore(); y3.restore();
  IMG.curtainTile = t3; }
initScroll(IMG);

// 画布
const canv = { s1E: cv(1920, 1080), LA: cv(WP, HP), LE: cv(WP, HP), RA: cv(WP, HP), RE: cv(WP, HP), NL: cv(1170, 740), NB: cv(1170, 740), D: [] };
const ctx = c => c.getContext('2d', { willReadFrequently: false });

// 新一页（翻过之后的跨页）：同样的绫绢 + 宣纸画芯，淡墨远山
function newPage(c, mirror, seed) {
  const x = ctx(c), w = c.width, h = c.height, k = w / WP;
  x.save(); if (mirror) { x.translate(w, 0); x.scale(-1, 1); }
  const ps = x.createPattern(IMG.silk, 'repeat'); ps.setTransform(new DOMMatrix().scale(.9 * k)); x.fillStyle = ps; x.fillRect(0, 0, w, h);
  x.fillStyle = 'rgba(214,196,160,.18)'; x.fillRect(0, 0, w, h);
  const y0 = (HP / 2 - 540) * k, y1 = (HP / 2 + 540) * k;
  const pp = x.createPattern(IMG.paper, 'repeat'); pp.setTransform(new DOMMatrix().scale(1.3 * k)); x.fillStyle = pp; x.fillRect(0, y0, w, y1 - y0);
  x.fillStyle = '#cdbb94'; x.fillRect(0, y0 - 16 * k, w, 10 * k); x.fillRect(0, y1 + 6 * k, w, 10 * k);
  x.fillStyle = 'rgba(70,50,30,.55)'; x.fillRect(0, y0 - 2 * k, w, 2 * k); x.fillRect(0, y1, w, 2 * k);
  // 淡墨远山（清墨，晕开）
  x.save(); x.beginPath(); x.rect(0, y0, w, y1 - y0); x.clip(); x.filter = `blur(${6 * k}px)`;
  let r = seed;
  const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
  for (let layer = 0; layer < 2; layer++) {
    x.fillStyle = layer ? 'rgba(40,36,32,.10)' : 'rgba(40,36,32,.06)';
    x.beginPath(); x.moveTo(0, y1); let yy = y0 + (y1 - y0) * (.52 + layer * .12);
    for (let xx = 0; xx <= w; xx += 12 * k) { yy += (rnd() - .5) * 18 * k; yy = Math.min(Math.max(yy, y0 + (y1 - y0) * (.32 + layer * .1)), y0 + (y1 - y0) * (.7 + layer * .08)); x.lineTo(xx, yy); }
    x.lineTo(w, y1); x.closePath(); x.fill();
  }
  x.restore(); x.restore();
}
newPage(canv.NL, false, 7); newPage(canv.NB, true, 19);

// 三道门
const DOORTXT = [['角色叙事', '这个角色为什么适合场景？'], ['美术语言', '哪些视觉特点值得保留？'], ['内容共创', '有什么故事值得一起讲？']];
const DSZ = [[.27, .165], [.235, .124], [.20, .085]];
DSZ.forEach(([wm, hm], i) => {
  const PX = 6000, w = Math.round(wm * PX), h = Math.round(hm * PX), c = cv(w, h), x = ctx(c);
  const LH = 300, pw = Math.round(w * .13), ey = 34;
  const shape = new Path2D(), ox0 = 8 + pw, ox1 = w - 8 - pw, oy0 = LH + 18, ry = Math.min(120, (h - oy0) * .45);
  shape.moveTo(0, 0); shape.quadraticCurveTo(w * .12, ey * 1.25, w * .3, ey); shape.lineTo(w * .7, ey); shape.quadraticCurveTo(w * .88, ey * 1.25, w, 0);
  shape.lineTo(w - 14, LH); shape.lineTo(w - 8, LH); shape.lineTo(w - 8, h); shape.lineTo(ox1, h); shape.lineTo(ox1, oy0 + ry);
  shape.bezierCurveTo(ox1, oy0 + ry * .1, (ox0 + ox1) / 2 + (ox1 - ox0) * .3, oy0, (ox0 + ox1) / 2, oy0);
  shape.bezierCurveTo((ox0 + ox1) / 2 - (ox1 - ox0) * .3, oy0, ox0, oy0 + ry * .1, ox0, oy0 + ry);
  shape.lineTo(ox0, h); shape.lineTo(8, h); shape.lineTo(8, LH); shape.lineTo(14, LH); shape.closePath();
  x.save(); x.clip(shape);
  const pp = x.createPattern(IMG.paper, 'repeat'); pp.setTransform(new DOMMatrix().scale(1.1)); x.fillStyle = pp; x.fillRect(0, 0, w, h);
  x.fillStyle = 'rgba(250,244,230,.25)'; x.fillRect(0, 0, w, h);
  // 淡墨晕边
  x.save(); x.filter = 'blur(22px)'; x.strokeStyle = 'rgba(70,60,50,.35)'; x.lineWidth = 40; x.stroke(shape); x.restore();
  x.strokeStyle = 'rgba(55,45,38,.75)'; x.lineWidth = 5; x.stroke(shape);
  // 门楣下的横枋线
  x.strokeStyle = 'rgba(55,45,38,.55)'; x.lineWidth = 3; x.beginPath(); x.moveTo(18, LH - 4); x.lineTo(w - 18, LH - 4); x.stroke();
  // 中缝折痕
  const g = x.createLinearGradient(w / 2 - 14, 0, w / 2 + 14, 0); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(.48, 'rgba(60,50,40,.12)'); g.addColorStop(.52, 'rgba(255,255,255,.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(w / 2 - 14, 0, 28, h);
  x.restore();
  // 文字
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '128px MSZ'; x.fillStyle = '#1d1a17'; x.fillText(DOORTXT[i][0], w / 2, ey + 112);
  x.font = '500 56px NSC'; x.fillStyle = '#5A534A'; x.fillText(DOORTXT[i][1], w / 2, ey + 212);
  canv.D.push(c);
});

const S = await makeStage(IMG, canv);

// 右页（旧灯箱，静态，全亮的样子；亮度由材质控制）
drawWorld(ctx(canv.RA), ctx(canv.RE), [G, -HP / 2, WP, HP], { t: 0, cam: 0, relit: true });
S.pages.RA.needsUpdate = S.pages.RE.needsUpdate = true;
let leftStatic = false;

window.DUR = DUR;
window.EV = events();
window.render = t => {
  const s2 = t >= T.lamp;
  if (!s2) {
    const c = camX(t), s = shake(t);
    drawWorld(null, ctx(canv.s1E), [c + s[0] - 960, s[1] - 540, 1920, 1080], { t, cam: c + s[0] });
    S.tex1.needsUpdate = true;
  } else if (t < T.leafLand + .05 || !leftStatic) {
    drawWorld(ctx(canv.LA), ctx(canv.LE), [G - WP, -HP / 2, WP, HP], { t, cam: camX(T.lamp) });
    S.pages.LA.needsUpdate = S.pages.LE.needsUpdate = true;
    leftStatic = t >= T.leafLand + .05;
  }
  S.update(t); S.render();
};
// 画面上每段文字的框（readcheck）
window.TEXTS = t => {
  if (t < T.lamp) return textsAt(t, camX(t), shake(t));
  const out = [];
  if (t < T.leafStart) for (const x of TXT) if (x.id.match(/rbw/)) {
    const pts = [[x.x0, x.y0], [x.x1, x.y1]].map(([wx, wy]) => S.project(X(wx), HPG, Z(wy)));
    out.push({ id: x.id, text: x.text, x0: pts[0][0], y0: pts[0][1], x1: pts[1][0], y1: pts[1][1] });
  }
  S.DOORS.forEach((d, i) => {
    if (t < T.doors[i] + .1) return;
    const z = d.z, y0 = HPG + d.H - .006, y1 = HPG + d.H - .05, hw = d.W * .4;
    const a = S.project(-hw, y0, z), bb = S.project(hw, y1, z);
    out.push({ id: 'door' + i, text: DOORTXT[i].join('｜'), x0: a[0], y0: a[1], x1: bb[0], y1: bb[1] });
  });
  return out;
};
if (q.has('t')) window.render(+q.get('t'));
window.READY = true;
