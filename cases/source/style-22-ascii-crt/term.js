// 字符网格引擎：VT323（拉丁，1:2 字格）+ 思源黑体子集（中文，全角方格，占两格宽）。
// 约定：scene 画布以 'lighter' 叠加；R 通道 = 琥珀荧光强度，G 通道 = 冰青（唯一第二色）强度；上色在 crt.js。
export const W = 1920, H = 1080;
const GS = 160, GW = GS * .4, GH = GS * .8, BASE = GS * .64;     // 拉丁图集字格 64×128
const CS = 128;                                                   // 中文图集方格 128×128
const PAD = 4;
export const LATIN = []; for (let c = 32; c < 127; c++) LATIN.push(String.fromCharCode(c));
export const CJK = [...'海很深鲸在唱歌就绪运行退出'];
export let AT = null;

function tintAll(white, w, h) {
  const t = col => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    x.drawImage(white, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = col; x.fillRect(0, 0, w, h); return c; };
  return { red: t('#ff0000'), green: t('#00ff00'), black: t('#000000') };
}

export async function initTerm() {
  await document.fonts.load(`${GS}px VT323`);
  await document.fonts.load(`400 ${CS}px "SC"`, '海很深鲸在唱歌');
  await document.fonts.load(`900 ${CS}px "SC"`, '海很深鲸在唱歌');
  // —— 拉丁 ——
  const LC = 16, lr = Math.ceil(LATIN.length / LC);
  const lw = LC * (GW + PAD * 2), lh = lr * (GH + PAD * 2);
  const lat = document.createElement('canvas'); lat.width = lw; lat.height = lh;
  const g = lat.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.font = `${GS}px VT323`; g.lineJoin = 'round'; g.lineWidth = 2.2;
  const lpos = {};
  LATIN.forEach((ch, i) => {
    const x = (i % LC) * (GW + PAD * 2) + PAD, y = Math.floor(i / LC) * (GH + PAD * 2) + PAD; lpos[ch] = [x, y];
    g.save(); g.beginPath(); g.rect(x, y, GW, GH); g.clip(); g.fillText(ch, x, y + BASE); g.strokeText(ch, x, y + BASE); g.restore();
  });
  // —— 中文：两档字重（常 400 / 粗 900），全角方格 ——
  const cw = CJK.length * (CS + PAD * 2), chh = 2 * (CS + PAD * 2);
  const cj = document.createElement('canvas'); cj.width = cw; cj.height = chh;
  const c = cj.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#fff'; c.strokeStyle = '#fff'; c.lineJoin = 'round'; c.textAlign = 'center'; c.textBaseline = 'middle';
  const cpos = [{}, {}], cov = [{}, {}];
  [400, 900].forEach((wt, k) => {
    c.font = `${wt} ${CS * .86}px "SC"`; c.lineWidth = k ? 1.6 : 2.4;
    CJK.forEach((ch, i) => {
      const x = i * (CS + PAD * 2) + PAD, y = k * (CS + PAD * 2) + PAD; cpos[k][ch] = [x, y];
      c.save(); c.beginPath(); c.rect(x, y, CS, CS); c.clip(); c.fillText(ch, x + CS / 2, y + CS * .53); c.strokeText(ch, x + CS / 2, y + CS * .53); c.restore();
    });
  });
  const d = c.getImageData(0, 0, cw, chh).data;
  for (let k = 0; k < 2; k++) for (const ch of CJK) {
    const [x, y] = cpos[k][ch]; let s = 0;
    for (let j = 0; j < CS; j++) for (let i = 0; i < CS; i++) s += d[((y + j) * cw + x + i) * 4 + 3];
    cov[k][ch] = s / 255 / (CS * CS);
  }
  AT = { L: { ...tintAll(lat, lw, lh), pos: lpos }, C: { ...tintAll(cj, cw, chh), pos: cpos }, cov };
  return AT;
}

const tex = (set, chan) => chan === 1 ? set.green : chan === 2 ? set.black : set.red;
// 拉丁字形：左上角 (x,y)，字格宽 cw（高 2cw）；a 亮度 0..2；chan 0 琥珀 / 1 冰青 / 2 黑（反白挖字）
export function glyphL(g, ch, x, y, cw, a = 1, chan = 0) {
  if (ch === ' ' || a <= .004) return; const p = AT.L.pos[ch]; if (!p) return;
  const T = tex(AT.L, chan);
  g.globalAlpha = Math.min(1, a); g.drawImage(T, p[0], p[1], GW, GH, x, y, cw, cw * 2);
  if (a > 1) { g.globalAlpha = Math.min(1, a - 1); g.drawImage(T, p[0], p[1], GW, GH, x, y, cw, cw * 2); }
}
// 中文字形：方格边长 s；bold 1 用 900 字重
export function glyphC(g, ch, x, y, s, a = 1, chan = 0, bold = 0) {
  if (ch === ' ' || a <= .004) return; const p = AT.C.pos[bold][ch]; if (!p) return;
  const T = tex(AT.C, chan);
  g.globalAlpha = Math.min(1, a); g.drawImage(T, p[0], p[1], CS, CS, x, y, s, s);
  if (a > 1) { g.globalAlpha = Math.min(1, a - 1); g.drawImage(T, p[0], p[1], CS, CS, x, y, s, s); }
}
// 混排一行：拉丁占 1 格（cw），中文占 2 格（2cw 见方）；返回总格数
export function line(g, str, x, y, cw, a = 1, chan = 0, bold = 0) {
  let col = 0;
  for (const ch of str) {
    if (AT.C.pos[0][ch]) { glyphC(g, ch, x + col * cw, y, cw * 2, a, chan, bold); col += 2; }
    else { glyphL(g, ch, x + col * cw, y, cw, a, chan); col += 1; }
  }
  return col;
}
export const cols = str => [...str].reduce((n, ch) => n + (CJK.includes(ch) ? 2 : 1), 0);
// 反白：实心块 + 黑字挖出（画布不透明黑底，挖字＝画黑字形）
export function inverse(g, str, x, y, cw, a = 1, chan = 0) {
  const n = cols(str);
  g.globalAlpha = Math.min(1, a); g.fillStyle = chan ? '#00ff00' : '#ff0000';
  g.fillRect(x, y + cw * .1, n * cw, cw * 1.8);
  g.globalCompositeOperation = 'source-over'; line(g, str, x, y, cw, 1, 2); g.globalCompositeOperation = 'lighter';
}
export function cursor(g, x, y, cw, a = 1, chan = 0) {
  if (a <= .004) return;
  g.globalAlpha = Math.min(1, a); g.fillStyle = chan ? '#00ff00' : '#ff0000';
  g.fillRect(x + cw * .06, y + cw * .22, cw * .88, cw * 1.56);
}

// 密度表：句子里的字按实测墨量 × 暗/常/粗 三档排序，去掉近似重复
export function makeRamp(chars) {
  const set = [...new Set([...chars])].filter(c => c !== ' ');
  const lv = [{ ch: ' ', a: 0, v: 0, bold: 0 }];
  const mx = Math.max(...set.map(c => AT.cov[1][c]));
  for (const ch of set) {
    lv.push({ ch, a: .42, bold: 0, v: AT.cov[0][ch] / mx * .42 });
    lv.push({ ch, a: .72, bold: 0, v: AT.cov[0][ch] / mx * .72 });
    lv.push({ ch, a: 1.0, bold: 1, v: AT.cov[1][ch] / mx * 1.0 });
  }
  lv.sort((p, q) => p.v - q.v);
  const out = [lv[0]];
  for (const l of lv.slice(1)) { if (l.v - out[out.length - 1].v > .016) out.push(l); else if (l.a > out[out.length - 1].a) out[out.length - 1] = l; }
  return out;
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + .5) / 16 - .5);
export function pick(ramp, L, i, j, dither = .6) {
  const n = ramp.length - 1;
  let h = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453; h -= Math.floor(h);
  const x = L * n + (BAYER[(j & 3) * 4 + (i & 3)] * .5 + (h - .5) * .5) * dither * 1.6;
  return ramp[Math.max(0, Math.min(n, Math.round(x)))];
}
