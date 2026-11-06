import { clamp, seg, eo } from '/core/lib.js';
import * as UI from './ui.js';
import * as PX from './pixel.js';
import * as FM from './film.js';
import { bt, HIT, FPS } from './timeline.js';

const Q = new URLSearchParams(location.search);
const wL = document.getElementById('wL'), wD = document.getElementById('wD'), spr = document.getElementById('spr'), hudEl = document.getElementById('hud');
const mbg = document.getElementById('mbg'), mbw = document.getElementById('mbw');
window.DUR = FM.DUR;
window.EV = FM.EV.slice().sort((a, b) => a.t - b.t);

const tf = ([cx, cy, z]) => `translate(960px,540px) scale(${z}) translate(${-cx}px,${-cy}px)`;
let LAST = {};
function render(t) {
  const cam = FM.camAt(t), [cx, cy, z] = cam;
  const S = FM.deskState(t), D = FM.darkState(t);
  wL.innerHTML = UI.desk({ ...S, layer: 'L' }); wD.innerHTML = UI.desk({ ...S, layer: 'D' });
  const base = D.base === 'L' ? wL : wD, over = D.over ? (D.over === 'L' ? wL : wD) : null, other = base === wL ? wD : wL;
  base.style.zIndex = 1; base.style.visibility = ''; base.style.clipPath = '';
  if (over) { over.style.zIndex = 2; over.style.visibility = ''; } else { other.style.visibility = 'hidden'; other.style.clipPath = ''; }
  for (const el of [wL, wD, spr]) el.style.transform = tf(cam);
  // 锚点：量 DOM，换算回世界坐标
  const cache = {};
  const A = (key, fx = .5, fy = 0) => {
    const el = cache[key] !== undefined ? cache[key] : (cache[key] = wL.querySelector(`[data-a="${key}"]`));
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: (r.left + r.width * fx - 960) / z + cx, y: (r.top + r.height * fy - 540) / z + cy, w: r.width / z, h: r.height / z };
  };
  if (over) { const c = A(D.at, .5, .5) || { x: 960, y: 540 }; over.style.clipPath = `circle(${D.r.toFixed(1)}px at ${c.x.toFixed(1)}px ${c.y.toFixed(1)}px)`; }
  const cardFn = tt => FM.cardAt(tt, A, tq => FM.cursorAt(tq, A, cardFn));
  const cu = FM.cursorAt(t, A, cardFn);
  const C = FM.cardAt(t, A, tq => FM.cursorAt(tq, A, cardFn));
  // 卡片：放进两层世界里（深浅色各一份）
  let g = null, h = '';
  if (C && !C.hidden) {
    const W = FM.CARD.w, Hh = FM.CARD.h, px = PX.PX, f = C.feet, LH = C.LH * px;
    const left = f.x - W / 2, top = f.y - LH - Hh, ccx = f.x, ccy = top + Hh / 2;
    const s1 = 1 + C.sq * .55, s2 = 1 - C.sq, lift = C.lifted ? 1.035 : 1;
    const T = `translate(${ccx}px,${ccy}px) rotate(${C.rot}rad) translate(${-ccx}px,${-ccy}px) translate(${f.x}px,${f.y}px) scale(${C.sx * s1 * lift},${C.sy * s2 * lift}) translate(${-f.x}px,${-f.y}px)`;
    const card = UI.cardHTML({ done: C.done, alive: C.alive, lifted: C.lifted }, `left:${left}px;top:${top}px;width:${W}px;height:${Hh}px`);
    for (const L of [wL, wD]) L.insertAdjacentHTML('beforeend', `<div class="grp" style="transform:${T}">${card}</div>`);
    // 像素：腿、手、脸
    if (C.alive || C.seg === 'sit') {
      if (C.alive) h += PX.face(left + 20, top + 19, C.eyes, C.mouth);
      const bot = top + Hh;
      const lp = C.legs, la = lp === 'walkA' ? 'walkB' : lp === 'walkB' ? 'walkA' : lp;
      if (C.alive) { h += PX.leg(f.x - 150, bot, C.LH, lp, C.dir) + PX.leg(f.x + 150, bot, C.LH, la, C.dir); }
      else if (t < bt(36.5)) { const k = seg(t, bt(HIT.check), bt(36.5)); h += PX.leg(f.x - 150, bot, 0, k < .5 ? 'sit' : 'none') + PX.leg(f.x + 150, bot, 0, k < .5 ? 'sit' : 'none'); }
      const ph = Math.floor(t * 10);
      if (C.alive && C.arms !== 'none') { h += PX.arm(left, top + 33, -1, C.arms, ph) + PX.arm(left + W, top + 33, 1, C.arms, ph + 1); }
    }
    g = { T, left, top, W, Hh, f, ccx, ccy };
  }
  let props = '';
  // 道具与特效（不随卡片挤压）
  if (C && !C.hidden && g) {
    const { left, top, W, f } = g;
    if (t >= bt(HIT.bang) && t < bt(14.8)) props += PX.BANG(left - 34, top - 84, 1 - seg(t, bt(14.6), bt(14.8)));
    if (t >= bt(HIT.grab) && t < bt(HIT.release)) props += PX.SWEAT(left + W + 18, top - 30, 1);
    if (t >= bt(HIT.look) + .1 && t < bt(HIT.check)) props += PX.SWEAT(left - 34, top - 22 + seg(t, bt(HIT.look), bt(HIT.check)) * 14, 1);
    for (const [bb, seed] of [[HIT.land1, 1], [HIT.land2, 2], [HIT.land3, 3], [HIT.stomp, 4], [HIT.land5, 5]]) {
      const k = seg(t, bt(bb), bt(bb) + .42); if (k > 0 && k < 1) props += PX.dust(f.x, f.y, k, seed, 10);
    }
    if (t > bt(HIT.jump1) && t < bt(HIT.land2)) props += PX.speed(f.x, f.y - 60, 1, -.55, seg(t, bt(HIT.jump1), bt(HIT.land2)));
    if (t > bt(HIT.spit) && t < bt(33.5)) props += PX.speed(f.x, f.y - 60, -.8, -.4, seg(t, bt(HIT.spit), bt(33.5)));
    // zzz：锚定在「写周报」这一行的右上角，往右上斜着升；镜头拉远时像素格放大（全景时 2 倍）
    FM.ZZZ.forEach((bb, i) => {
      const k = (t - bt(bb)) / 1.25; if (!(k > 0 && k < 1)) return;
      const big = clamp(2.2 / z, 1, 2), s = (1 + i * .25) * big;
      props += PX.ZED(left + W + 12 + k * 40 * big, top + 8 - k * 18 * big, s, k < .15 ? k / .15 : k < .8 ? 1 : (1 - k) * 5);
    });
  }
  if (S.trash && S.trash.kick !== null) {
    const p = A('trash', 0, 0), T = S.trash;
    if (p) {
      const rim = p.y + p.h - 60 * T.sy, cxT = p.x + 42 + 10 * T.sx, ph = Math.floor(t * 16);
      const n0 = 2 + Math.round(T.kick * 9), jit = T.kick > .2 ? (ph % 2 ? PX.PX / 2 : -PX.PX / 2) : 0;
      const legUp = (n, flip) => [flip ? '.DDD' : 'DDD.', ...Array(n).fill('.OO.')];
      const nL = clamp(n0 + (ph % 4 < 2 ? 1 : 0), 2, 7), nR = clamp(n0 + (ph % 4 < 2 ? 0 : 1), 2, 7), pal = { O: PX.ORANGE, D: PX.ORANGE_D };
      props += PX.pixart(legUp(nL, false), cxT - 3.5 * PX.PX + jit, rim - (nL + 1) * PX.PX, pal);
      props += PX.pixart(legUp(nR, true), cxT + .5 * PX.PX - jit, rim - (nR + 1) * PX.PX, pal);
    }
  }
  // 挣脱时的像素爆散；吐出时的爆散
  if (g) { const k = seg(t, bt(HIT.breakFree), bt(HIT.breakFree) + .5); if (k > 0 && k < 1) props += PX.burst(g.left + 41, g.top + 40, k, 3, 22); }
  { const p = A('trash', .5, .3); const k = seg(t, bt(HIT.spit), bt(HIT.spit) + .55); if (p && k > 0 && k < 1) props += PX.burst(p.x, p.y, k, 9, 26); }
  { const p = A('toggle', .5, .5); const k = seg(t, bt(HIT.stomp), bt(HIT.stomp) + .5); if (p && k > 0 && k < 1) for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + .4; props += PX.SPARK(p.x + Math.cos(a) * (40 + k * 70), p.y + Math.sin(a) * (24 + k * 46), '#FFD23F', 1 - k); } }
  { const k = seg(t, bt(36.5), bt(36.5) + .4); if (g && k > 0 && k < 1) props += PX.burst(g.f.x, g.top + g.Hh, k, 5, 14); }
  // 光标：屏幕上恒定大小
  let cur = '';
  if (cu && cu.op > 0) {
    if (cu.ring > 0) cur += `<div class="ring" style="left:${cu.x - 26 * cu.ring / z * 1.6 - 4 / z}px;top:${cu.y - 26 * cu.ring / z * 1.6 - 4 / z}px;width:${(52 * cu.ring * 1.6 + 8) / z}px;height:${(52 * cu.ring * 1.6 + 8) / z}px;opacity:${(1 - cu.ring) * .8};border-width:${3 / z}px"></div>`;
    if ((cu.sp || 0) > 1400) for (let i = 1; i <= 3; i++) { const gq = FM.cursorAt(t - i * .014, A, cardFn); if (gq) cur += cursorSvg(gq.x, gq.y, 1, cu.op * .14 * (4 - i), z); }
    cur += cursorSvg(cu.x, cu.y, cu.sc, cu.op, z);
  }
  spr.innerHTML = (g ? `<div class="grp" style="transform:${g.T}">${h}</div>` : '') + props + cur;
  // 运动模糊：相机速度 → 各向异性高斯（只在甩镜时）
  const [px0, py0] = FM.camAt(t - 1 / FPS), vx = (cx - px0) * z, vy = (cy - py0) * z;
  // 软饱和：最快的两三帧才到 ~6.5 px，甩镜中段仍认得出窗口轮廓和橙色卡片
  const mbf = v => 7 * (1 - Math.exp(-Math.max(0, Math.abs(v) - 40) / 70)), bx = mbf(vx), by = mbf(vy);
  const mb = bx > .6 || by > .6; mbg.setAttribute('stdDeviation', `${bx.toFixed(2)} ${by.toFixed(2)}`); mbw.style.filter = mb && !Q.has('nomb') ? 'url(#mb)' : '';
  // HUD
  const Hs = FM.hudState(t); let hh = '';
  const scr = p => ({ x: (p.x - cx) * z + 960, y: (p.y - cy) * z + 540 });
  let cardScr = null; if (g) cardScr = scr({ x: g.ccx, y: g.ccy + 20 });
  if (Hs.spot > 0 && cardScr) hh += `<div class="spot" style="opacity:${Hs.spot};background:radial-gradient(ellipse 980px 560px at ${cardScr.x}px ${cardScr.y}px, transparent 52%, rgba(6,8,16,.78) 100%)"></div>`;
  if (Hs.flash > 0) hh += `<div class="flash" style="opacity:${Hs.flash * .85}"></div>`;
  if (Hs.pill > 0) hh += `<div class="pill" style="opacity:${Hs.pill};transform:translate(-50%,${(1 - Hs.pill) * 14}px)"><i></i>它跑了</div>`;
  if (Hs.dim > 0) hh += `<div class="dim" style="opacity:${Hs.dim}"></div>`;
  hudEl.innerHTML = hh;
  LAST = { t, cam, card: C && C.feet, cardScr, cu, bx, by, z, vx, vy };
  window.DBG = LAST;
  window.__A = A;
}
const cursorSvg = (x, y, sc, op, z) => { const s = 1.7 * sc / z;
  return `<svg class="cur" style="left:${x - 2 * s}px;top:${y - 2 * s}px;opacity:${op};filter:drop-shadow(0 ${2 / z}px ${3 / z}px rgba(0,0,0,.35))" width="${22 * s}" height="${30 * s}" viewBox="0 0 22 30"><path d="M2 2 L2 24 L7.5 18.5 L11 27 L15 25.2 L11.6 17 L19 17 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`; };

// readcheck：只报告必须读完的文字（片名、冻结标注）
window.TEXTS = t => {
  render(t); const out = [];
  const el = wL.querySelector('[data-a="title"]'); if (el) { const r = el.getBoundingClientRect(); if (r.right > 0 && r.left < 1920 && r.bottom > 0 && r.top < 1080) out.push({ id: 'title', text: '逃跑的周报', x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }); }
  const p = hudEl.querySelector('.pill'); if (p && +p.style.opacity > .9) { const r = p.getBoundingClientRect(); out.push({ id: 'pill', text: '它跑了', x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }); }
  return out;
};
window.render = render;
await document.fonts.load('500 20px "Noto Sans SC"'); await document.fonts.load('700 20px "Noto Sans SC"'); await document.fonts.load('500 16px Inter');
render(+(Q.get('t') || 0));
window.READY = true;
