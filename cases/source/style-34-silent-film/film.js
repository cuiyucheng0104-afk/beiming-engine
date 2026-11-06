// 《追帽子》成片装配。每帧：镜头画调子 4:3 画面（+ 色彩遮罩：帽带一圈红）→ Redraw 上墨 → 光圈（在摄影机里，随画面一起被印）
// → FilmPost（银盐/棕调、颗粒、闪烁、抖动、划痕、烧边）→ 灰尘毛发 → 放进幕布之间的 4:3 片门。
// 角色与摄影机按"以拍为锚"的手摇采样（16/18 fps，undercrank 段 24 fps）；闪烁、抖动每个输出帧都变。
import { Redraw } from './engine/redraw.js';
import { FilmPost, damage } from './engine/film.js';
import { intertitle, iris, theatre, CARD_BG, CARD_FG } from './engine/cards.js';
import { setFrame, S as IS } from './engine/ink.js';
import { SEC, DUR as D, HIT, HITS, secAt, crank, at } from './timeline.js';
import * as SH from './shots.js';

export const DUR = D;
const W = 1920, H = 1080, FW = 1440, FH = 1080, GATE = { x: 240, y: 0, w: FW, h: FH };
const mk = () => { const c = document.createElement('canvas'); c.width = FW; c.height = FH; return c; };
const fc = mk(), fg = fc.getContext('2d'), mc = mk(), mg = mc.getContext('2d');
let RD = null, FP = null;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ss = x => { x = clamp(x); return x * x * (3 - 2 * x); };

// 分段胶片外观：str 损伤，sepia 暖度，fps 手摇采样，crank 放映速度感
function lookAt(t) {
  const s = secAt(t).name;
  if (s === 'WALK') return { str: .5, sepia: .3, fps: 16, crank: 1 };
  if (s === 'CHASE') return t < HIT.crank ? { str: .72, sepia: .15, fps: 18, crank: 1.25 } : { str: .95, sepia: .1, fps: 24, crank: 1.6 };
  if (s === 'CARD1') { const u = clamp((t - SEC.CARD1.t0) / SEC.CARD1.dur); return { str: .5 + .42 * u * u, sepia: .2 - .08 * u, fps: 16, crank: 1 + .25 * u * u }; }   // 减七震音渐强：闪烁与损伤一起加重
  if (s === 'SIL') return { str: .38, sepia: .3, fps: 16, crank: 1 };
  if (s === 'CARD2') return { str: .4, sepia: .34, fps: 16, crank: 1 };
  return { str: .34, sepia: .36, fps: 16, crank: 1 };
}

// 字幕卡（画内文字；思源宋体子集）
export const CARDS = {
  CARD1: { level: 1, text: '那顶帽子……', size: 128 },
  CARD2: { level: 2, text: '原来是猴子的', size: 132 },
};
function drawCard(g, spec, lt, name) {
  intertitle(g, FW, FH, { level: spec.level, lines: [] }, lt);
  g.save(); g.font = `900 ${spec.size}px "Noto Serif SC"`; g.fillStyle = CARD_FG; g.textAlign = 'center'; g.textBaseline = 'middle';
  const a = ss(lt / .18); g.globalAlpha = a;
  if (name === 'CARD2') {
    // 末字"的"在 settle 拍上回弹落定
    const txt = spec.text, head = txt.slice(0, -1), last = txt.slice(-1), wH = g.measureText(head).width, wL = g.measureText(last).width, x0 = FW / 2 - (wH + wL) / 2;
    g.textAlign = 'left'; g.fillText(head, x0, FH / 2);
    const st = HIT.settle - SEC.CARD2.t0, u = lt - st;
    const dy = u < 0 ? -26 * ss(lt / (st)) : -26 * Math.exp(-u * 9) * Math.cos(u * 26);
    const sc = u < 0 ? 1 : 1 + .12 * Math.exp(-u * 10);
    g.save(); g.translate(x0 + wH + wL / 2, FH / 2 + dy); g.scale(sc, sc); g.textAlign = 'center'; g.fillText(last, 0, 0); g.restore();
  } else {
    // 卡 1：逐字按拍落定（那=切点，顶/帽/子=第 1/2/3 拍，两个「…」=第 3.5 / 3.75 拍）。每个字提前 3 帧从上方落下、正好在拍点上落稳，再轻轻一沉
    const glyphs = ['那', '顶', '帽', '子', '…', '…'], lands = ['card1', 'c1ding', 'c1mao', 'c1zi', 'c1dots1', 'c1dots2'].map(k => HIT[k] - SEC.CARD1.t0);
    const sp = 6, ws = glyphs.map(c => g.measureText(c).width + sp), tot = ws.reduce((a, b) => a + b, 0) - sp;
    let xx = FW / 2 + 10 - tot / 2; g.textAlign = 'left'; g.globalAlpha = 1;
    glyphs.forEach((c, i) => {
      const L = lands[i], u = lt - L, pre = .125;
      if (u >= -pre || i === 0) {
        let dy = 0, a = 1, sc = 1;
        if (u < 0 && i > 0) { const v = 1 + u / pre; dy = -46 * (1 - v * v); a = v; sc = 1.18 - .18 * v; }
        else if (u >= 0 && u < .35) { dy = 7 * Math.exp(-u * 14) * Math.sin(u * 30); }
        g.save(); g.globalAlpha = a; g.translate(xx + (ws[i] - sp) / 2, FH / 2 + dy); g.scale(sc, sc); g.textAlign = 'center'; g.fillText(c, 0, 0); g.restore();
      }
      xx += ws[i];
    });
  }
  g.restore();
}
// readcheck 用：可见文字及其包围框（屏幕像素）
export function texts(t) {
  const s = secAt(t).name, c = CARDS[s]; if (!c) return [];
  const w = c.text.length * c.size * 1.02;
  return [{ id: s, text: c.text, x0: GATE.x + FW / 2 - w / 2, y0: FH / 2 - c.size * .6, x1: GATE.x + FW / 2 + w / 2, y1: FH / 2 + c.size * .6 }];
}

export function renderFilm(g, t) {
  RD = RD || new Redraw(FW, FH); FP = FP || new FilmPost(FW, FH);
  const sec = secAt(t), look = lookAt(t), frame = Math.floor(t * 24 + 1e-6);
  const ta = crank(t, look.fps);                        // 手摇采样后的时间
  for (const c of [fg, mg]) { c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none'; }
  mg.clearRect(0, 0, FW, FH);
  let src = fc, useMask = false;
  const card = CARDS[sec.name];
  if (card) {
    drawCard(fg, card, t - sec.t0, sec.name);
  } else {
    setFrame(ta, { boil: 1 }); IS.sepLine = .5;
    fg.fillStyle = '#fff'; fg.fillRect(0, 0, FW, FH);
    fg.save(); mg.save();
    if (sec.name === 'WALK' || sec.name === 'CHASE') SH.oner(fg, mg, ta); else SH.irisShot(fg, mg, ta);
    fg.restore(); mg.restore();
    src = RD.render(fc, { frame }); useMask = true;
  }
  const ir = irisAt(t, ta);
  if (ir) {
    if (src !== fc) { fg.setTransform(1, 0, 0, 1, 0, 0); fg.drawImage(src, 0, 0); src = fc; }
    iris(fg, FW, FH, ir.x, ir.y, ir.r, 5);
    mg.save(); mg.globalCompositeOperation = 'destination-in'; const gr = mg.createRadialGradient(ir.x, ir.y, Math.max(0, ir.r - 5), ir.x, ir.y, ir.r + 5); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); mg.fillStyle = gr; mg.fillRect(0, 0, FW, FH); mg.restore();
  }
  const fp = { frame, strength: look.str, sepia: look.sepia, crank: look.crank, exposure: 1 };
  if (card) fp.halation = 1.4;
  if (sec.name === 'CARD1') { let p = 0; for (const k of ['c1ding', 'c1mao', 'c1zi', 'c1dots1', 'c1dots2']) { const u = t - HIT[k]; if (u >= 0 && u < .2) p = Math.max(p, 1 - u / .2); } fp.exposure = 1 + .14 * p; }   // 每个字落定，银幕亮一下
  const dev = FP.render(src, fp, useMask ? mc : null);
  const curtain = 1 - ss((t - HIT.irisShut) / (HIT.curtain - HIT.irisShut));
  theatre(g, W, H, GATE, Math.max(.3, FP.mean), 1);
  const foot = ss((t - HIT.bow) / .6);                                         // 结尾：脚灯亮起，照着两侧的幕布
  if (foot > 0) footlights(g, foot, [[0, GATE.x], [GATE.x + FW, W]]);
  g.save(); g.beginPath(); g.roundRect(GATE.x, GATE.y, GATE.w, GATE.h, 22); g.clip();
  g.drawImage(dev, GATE.x, GATE.y);
  damage(g, GATE.x, GATE.y, FW, FH, frame, look.str);
  const e = g.createLinearGradient(GATE.x, 0, GATE.x + 18, 0); e.addColorStop(0, 'rgba(0,0,0,.85)'); e.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = e; g.fillRect(GATE.x, 0, 18, H);
  const e2 = g.createLinearGradient(GATE.x + FW, 0, GATE.x + FW - 18, 0); e2.addColorStop(0, 'rgba(0,0,0,.85)'); e2.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = e2; g.fillRect(GATE.x + FW - 18, 0, 18, H);
  g.restore();
  if (curtain < 1) curtainsOver(g, curtain, Math.max(.55, FP.mean));
}

function footlights(g, k, spans) {
  g.save(); g.beginPath(); for (const [a, b] of spans) g.rect(a, 0, b - a, H); g.clip(); g.globalCompositeOperation = 'screen';
  const fl = g.createRadialGradient(W / 2, H + 140, 60, W / 2, H + 140, 1300);
  fl.addColorStop(0, `rgba(255,175,115,${.62 * k})`); fl.addColorStop(.55, `rgba(190,80,55,${.3 * k})`); fl.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fl; g.fillRect(0, 0, W, H); g.restore();
}
function curtainsOver(g, open, spill) {
  const cover = (1 - open) * (W / 2 + 10);
  if (cover < 1) return;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  theatre(x, W, H, { x: W / 2, y: 0, w: 0, h: H }, spill, 1);
  g.save();
  g.drawImage(c, 0, 0, W / 2, H, cover - W / 2, 0, W / 2, H);
  g.drawImage(c, W / 2, 0, W / 2, H, W - cover, 0, W / 2, H);
  g.save(); g.beginPath(); g.rect(0, 0, cover, H); g.rect(W - cover, 0, cover, H); g.clip();
  g.globalCompositeOperation = 'screen';
  const fl = g.createRadialGradient(W / 2, H + 120, 60, W / 2, H + 120, 1250);
  fl.addColorStop(0, 'rgba(255,175,115,.62)'); fl.addColorStop(.55, 'rgba(190,80,55,.28)'); fl.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fl; g.fillRect(0, 0, W, H); g.restore();
  for (const [x0, dir] of [[cover, -1], [W - cover, 1]]) { const gr = g.createLinearGradient(x0, 0, x0 + dir * 60, 0); gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(Math.min(x0, x0 + dir * 60), 0, 60, H); }
  g.restore();
}

// 光圈：静默里收向帽子 → 揭晓时停在半开（猴子看观众）→ 结尾闭合到帽子（胶片坐标，经 shots 的世界→胶片函数）
function irisAt(t, ta) {
  const full = 1900, half = 400;
  if (t >= SEC.SIL.t0 && t < SEC.REVEAL.t1) {
    const [x, y] = SH.irisTarget(ta);
    const k = ss((t - SEC.SIL.t0) / (HIT.twitch - SEC.SIL.t0));                 // 一拍内收到帽子
    let r = full - (full - 300) * k;
    if (t >= HIT.reveal) r = 300 + 190 * ss((t - HIT.reveal) / .25) - 90 * ss((t - HIT.look) / .3);   // 揭晓时张开，看观众时收到半开并停住
    return { x, y, r };
  }
  if (t >= SEC.END.t0) {
    const [x, y] = SH.irisTarget(ta);
    const r = lerp(half, 64, ss((t - (HIT.bow + .25)) / (HIT.irisShut - HIT.bow - .25)));   // 收到只剩帽带那一点红，幕布合上
    return { x, y: y - (half - r) * .55 * 0, r };
  }
  return null;
}

// 声音 / 拍点事件：命名拍点 + 由动作推出的拟音（脚步、梯级、狗爪）
export function events() {
  const ev = [];
  for (const k in SEC) ev.push({ t: SEC[k].t0, type: 'section', name: k });
  for (const k in HIT) ev.push({ t: HIT[k], type: 'hit', name: k });
  // 走路脚步：120 BPM 每拍一步，致意前
  for (let tt = 0; tt < HIT.tip - .01; tt += .5) ev.push({ t: +tt.toFixed(6), type: 'step', kind: 'walk' });
  // 追逐跑步：起跑到踏进车道、从电车后面冲向梯子，每半拍一步
  const half = SEC.CHASE.beat / 2;
  for (let b = 0; b < 6.5; b += .5) { const tt = at('CHASE', b); if (tt < HIT.tramIn) ev.push({ t: +tt.toFixed(6), type: 'step', kind: 'run' }); }
  for (let b = 6.5; b < 7; b += .5) ev.push({ t: +at('CHASE', b).toFixed(6), type: 'step', kind: 'run' });
  // undercrank 追逐：人和狗每半拍一步
  for (let b = 14; b < 17; b += .5) { ev.push({ t: +at('CHASE', b).toFixed(6), type: 'step', kind: 'dash' }); ev.push({ t: +(at('CHASE', b) + half / 2).toFixed(6), type: 'paw' }); }
  return ev.sort((a, b) => a.t - b.t);
}
