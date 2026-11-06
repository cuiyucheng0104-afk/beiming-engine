// 竖排题字与小字。
// 题字：Ma Shan Zheng 字形作为墨的"形"，用一张按笔势（自上而下、由左至右的斜扫 + 纤维噪声）排好的书写顺序场
// 逐步显出：前沿处的墨更湿（进湿墨层，被合成器洇开、积墨），写过的部分是焦墨（干墨层）。
import { cv } from './assets.js';
import { clamp, vnoise } from '/core/lib.js';

const cache = {};
function glyphCanvas(ch, size, font = 'MaShanZheng') {
  const k = ch + size + font; if (cache[k]) return cache[k];
  const pad = Math.ceil(size * .25), c = cv(size + pad * 2, size + pad * 2), g = c.getContext('2d');
  g.font = `${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#000';
  g.fillText(ch, c.width / 2, c.height / 2 + size * .04);
  // 书写顺序场（0..1）：斜向笔势 + 噪声；存为灰度供逐帧阈值
  const W = c.width, H = c.height, ord = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (y - pad) / size, v = (x - pad) / size;
    ord[y * W + x] = clamp(.72 * u + .28 * v * (.6 + .4 * Math.sin(u * 6.2)) + .05 * (vnoise(x * .21 + y * .07) - .5), 0, 1);
  }
  const s = cv(W, H), m = cv(W, H);
  return (cache[k] = { c, ord, pad, s, m, sg: s.getContext('2d'), mg: m.getContext('2d'), last: -1 });
}

// 写一个字：q 书写进度（0..1）；L {wet, dry}（屏幕坐标 2D 上下文）；x,y 为字心屏幕坐标
export function writeChar(L, ch, size, x, y, q, o = {}) {
  if (q <= 0) return;
  const G = glyphCanvas(ch, size, o.font);
  const W = G.c.width, H = G.c.height;
  if (G.last !== q) {
    G.last = q;
    // 遮罩：已写到的部分（软边 .04）
    const im = G.mg.createImageData(W, H), d = im.data, ord = G.ord;
    for (let i = 0, p = 3; i < ord.length; i++, p += 4) { const e = (q * 1.08 - ord[i]) / .04; d[p] = e <= 0 ? 0 : e >= 1 ? 255 : e * 255; }
    G.mg.putImageData(im, 0, 0);
    G.sg.clearRect(0, 0, W, H); G.sg.globalCompositeOperation = 'source-over'; G.sg.drawImage(G.c, 0, 0);
    G.sg.globalCompositeOperation = 'destination-in'; G.sg.drawImage(G.m, 0, 0); G.sg.globalCompositeOperation = 'source-over';
  }
  const X = x - W / 2, Y = y - H / 2, a = o.alpha ?? 1;
  L.dry.globalAlpha = .9 * a; L.dry.drawImage(G.s, X, Y);
  // 湿晕：写的时候更湿，写完后湿气收干到一层淡晕
  const wetK = (o.wet ?? .5) * (q < 1 ? 1 : 1) * a;
  L.wet.globalAlpha = clamp(wetK); L.wet.drawImage(G.s, X, Y);
  L.dry.globalAlpha = 1; L.wet.globalAlpha = 1;
}

// 竖排一列：chars 字符串，每字在 [t0,t1] 写，字距 size*1.06
export function column(L, str, size, x, y, prog, o = {}) {
  const n = str.length;
  for (let i = 0; i < n; i++) writeChar(L, str[i], size, x, y + size * .5 + i * size * 1.06, prog[i] ?? 0, o);
}

// 压上幕布式出现（皮影题字语法）：从大而虚到清晰，k 0..1
export function pressChar(g, ch, size, x, y, k, color = '#000', alpha = 1) {
  if (k <= 0) return;
  const G = glyphCanvas(ch, size);
  const s = 1 + .14 * (1 - k), bl = 14 * (1 - k);
  g.save(); g.globalAlpha = clamp(alpha * (.25 + .75 * k)); g.filter = bl > .3 ? `blur(${bl.toFixed(1)}px)` : 'none';
  g.translate(x, y); g.scale(s, s); g.drawImage(G.c, -G.c.width / 2, -G.c.height / 2); g.restore();
}

// 小字（Noto Serif SC 500，灰墨 #5A534A）：竖排或横排；k 0..1 洇出（模糊→清晰）
export function smallText(g, str, size, x, y, k, o = {}) {
  if (k <= 0) return;
  g.save(); g.globalAlpha = clamp(k) * (o.alpha ?? 1); g.fillStyle = o.color ?? '#5A534A';
  const bl = 2.4 * (1 - clamp(k)); g.filter = bl > .2 ? `blur(${bl.toFixed(1)}px)` : 'none';
  g.font = `500 ${size}px NotoSerifSC`; g.textBaseline = 'middle';
  if (o.vertical) {
    g.textAlign = 'center';
    let yy = y + size * .5;
    for (const ch of str) {
      if ('《》'.includes(ch)) { g.save(); g.translate(x, yy); g.rotate(Math.PI / 2); g.fillText(ch, 0, 0); g.restore(); }
      else if ('、'.includes(ch)) g.fillText(ch, x + size * .32, yy - size * .32);
      else g.fillText(ch, x, yy);
      yy += size * 1.18;
    }
  } else { g.textAlign = o.align ?? 'left'; g.fillText(str, x, y); }
  g.restore();
}
export function smallBox(str, size, x, y, o = {}) {   // 给 readcheck 的文字框
  const n = [...str].length;
  if (o.vertical) return [x - size * .6, y, x + size * .6, y + n * size * 1.18];
  const w = n * size * 1.02; const x0 = o.align === 'center' ? x - w / 2 : x; return [x0, y - size * .6, x0 + w, y + size * .6];
}
