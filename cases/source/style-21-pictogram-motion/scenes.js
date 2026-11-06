// Scenes for 一天 · ONE DAY: cards, the lateral long take, the vertical row scroll, the push into a motif cell,
// grid transitions, the night card with the count-up slam, the HUD and motion blur. Everything is a function of t.
import { CARDS, CHAP, N, BEAT, NIGHT, WIN, bt } from './timeline.js';
const G = window.G, E = G.E, clamp = G.clamp, lerp = G.lerp, inv = G.inv, mix = G.mix, rgba = G.rgba, F = G.F;
const W = 1920, H = 1080, S = G.CELL, PAL = G.PAL;

// ───────── layout ─────────
const STAGE = { x: 600, y: 560, r: 380, U: 600, hipY: 610 };
const TX = 1110, TW = 720;
const lightFg = (pk) => PAL[pk].fg === G.CREAM;
const colorsFor = (pk) => {
  const P = PAL[pk], disc = discCol(pk);
  return { fg: P.fg, bg: disc, far: mix(P.fg, disc, 0.42), far2: mix(P.fg, disc, 0.62), acc: pk === 'ink' ? PAL.ink.accent : lightFg(pk) ? P.t[4] : P.deep, line: mix(P.fg, disc, 0.55) };
};
const discCol = (pk) => pk === 'ink' ? PAL.ink.t[3] : lightFg(pk) ? PAL[pk].t[0] : PAL[pk].t[4];
// timing compression per card length
const kOf = (c) => c.beats >= 4 ? 1 : c.beats >= 2 ? 0.7 : c.beats >= 1 ? 0.4 : 0.22;

// ───────── figure layer (own buffer, masked before the text column) ─────────
const bufFig = G.canvas();
function poseOf(def, u) { return def.pose ? def.pose(u) : G.keyPose(def.keys, u, def.loop); }
function drawFigUnits(ctx, def, u, C) {
  const J = G.joints(poseOf(def, u));
  ctx.save();
  if (def.fig) { ctx.translate(def.fig.x || 0, def.fig.y || 0); if (def.fig.s) ctx.scale(def.fig.s, def.fig.s); }
  if (def.back) def.back(ctx, J, u, C);
  if (def.second) {
    const J2 = G.joints(def.second(u));
    ctx.save(); const o = def.secondX || [0, 0]; ctx.translate(o[0], o[1]);
    G.drawFigure(ctx, J2, C.far2, mix(C.far2, C.bg, 0.35)); ctx.restore();
  }
  G.drawFigure(ctx, J, C.fg, C.far);
  if (def.front) def.front(ctx, J, u, C);
  ctx.restore();
}
function stageFigure(ctx, c, u, C, asm = 1, dx = 0) {
  const def = window.POSES[c.pose];
  const f = bufFig.getContext('2d');
  f.setTransform(1, 0, 0, 1, 0, 0); f.globalCompositeOperation = 'source-over'; f.clearRect(0, 0, W, H);
  f.save(); f.translate(STAGE.x + dx, STAGE.hipY); f.scale(STAGE.U, STAGE.U);
  drawFigUnits(f, def, Math.max(0, u), C);
  f.restore();
  // keep the figure's environment out of the text column
  f.globalCompositeOperation = 'destination-in';
  const g = f.createLinearGradient(0, 0, W, 0), x1 = TX - 70, fd = 90;
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(x1 / W, 'rgba(0,0,0,1)'); g.addColorStop((x1 + fd) / W, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  f.fillStyle = g; f.fillRect(0, 0, W, H); f.globalCompositeOperation = 'source-over';
  if (asm >= 0.999) { ctx.drawImage(bufFig, 0, 0); return; }
  // assembly: horizontal bands slide into register from alternating sides
  const band = 54, k = 1 - E.oExp(asm);
  ctx.save();
  for (let yy = 0, j = 0; yy < H; yy += band, j++) {
    const dx = k * (j % 2 ? 1 : -1) * (90 + ((j * 37) % 5) * 40);
    ctx.globalAlpha = clamp(asm * 4);
    ctx.drawImage(bufFig, 0, yy, W, band, dx, yy, W, band);
  }
  ctx.restore();
}

// ───────── background, disc ─────────
function rowOffs(j, lt, seed, o = {}) {
  const sp = o.sp ?? 24, amp = o.amp ?? 20;
  return (j % 2 ? 1 : -1) * (lt * sp) + Math.sin(j * 1.7 + seed) * amp + (o.step ? o.step(j) : 0);
}
function patBg(ctx, pk, seed, lt, o = {}) {
  const pat = G.pattern(pk, seed, { spread: o.spread ?? 0.45, density: o.density ?? 0.45 });
  G.drawPattern(ctx, pat, o.offs || ((j) => rowOffs(j, lt, seed, o)));
}
function sun(ctx, x, y, r, col, lt) {
  G.disc(ctx, x, y, r, col);
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
  const sx = x - r * 1.6 + E.o3(inv(0.0, 1.6, lt)) * r * 3.2;
  const g = ctx.createLinearGradient(sx - r * 0.5, y - r, sx + r * 0.5, y + r);
  g.addColorStop(0, rgba('#ffffff', 0)); g.addColorStop(0.5, rgba('#ffffff', 0.09)); g.addColorStop(1, rgba('#ffffff', 0));
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}
// the planted "little sun" on the run card: the push flies into it
const HERO = { x: 990, y: 90, r: 58 };
function heroSun(ctx, pk, lt) {
  const P = PAL[pk], beat = lt / BEAT, pulse = 1 + 0.06 * Math.exp(-((beat % 1) * 6));
  ctx.save(); ctx.beginPath(); ctx.rect(HERO.x - S / 2, HERO.y - S / 2, S, S); ctx.clip();
  ctx.fillStyle = P.t[0]; ctx.fillRect(HERO.x - S / 2, HERO.y - S / 2, S, S);
  ctx.fillStyle = P.t[4];
  ctx.beginPath();
  for (let i = 0; i < 16; i++) { const a0 = (i / 16) * Math.PI * 2 + lt * 0.6; ctx.moveTo(HERO.x, HERO.y); ctx.arc(HERO.x, HERO.y, HERO.r * 1.42 * pulse, a0, a0 + Math.PI / 32); }
  ctx.fill();
  G.disc(ctx, HERO.x, HERO.y, HERO.r * 1.08, P.t[4]);
  G.disc(ctx, HERO.x, HERO.y, HERO.r, PAL.orange.t[1]);
  ctx.restore();
}

// ───────── text ─────────
const pad2 = (n) => String(n).padStart(2, '0');
function chip(ctx, text, x, y, col, bg, p) {
  if (p <= 0) return;
  ctx.save(); ctx.font = F.mono(18); ctx.letterSpacing = '3px';
  const w = ctx.measureText(text).width + 28;
  ctx.beginPath(); ctx.rect(x, y - 30, w * E.oExp(p), 44); ctx.clip();
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x, y - 30, w, 44, 22); ctx.fill();
  ctx.fillStyle = col; ctx.fillText(text, x + 14, y);
  ctx.restore();
}
function textBlock(ctx, c, lt, o = {}) {
  const P = PAL[c.pk], fg = P.fg, k = kOf(c) * (o.k || 1);
  const meta = `${c.clock}    ${pad2(c.n)} / ${N}`;
  if (o.meta !== false) {
    G.typeText(ctx, meta, TX, 330, F.mono(22), rgba(fg, 0.85), inv(0, 0.35 * k, lt), { ls: '4px', caret: false });
    G.hair(ctx, TX, 352, TW, rgba(fg, 0.35), E.oExp(inv(0, 0.45 * k, lt)), 2);
  }
  const px = G.fitFont(ctx, c.zh, 'zh', 900, 300, TW, -0.02);
  const pOut = o.out ?? 1;
  G.maskText(ctx, c.zh, TX - 6, 650, F.zh(900, px), fg, pOut < 1 ? pOut : inv(0, 0.5 * k, lt), { ls: (-0.02 * px) + 'px', dir: pOut < 1 ? -1 : 1 });
  G.maskText(ctx, c.en, TX, 752, F.en(900, 76), rgba(fg, 0.92), pOut < 1 ? pOut : inv(0.08 * k, 0.08 * k + 0.5 * k, lt), { ls: '-1px', dir: pOut < 1 ? -1 : 1 });
  if (o.chip !== false) {
    const ch = CHAP[c.ch], dark = !lightFg(c.pk);
    chip(ctx, `${ch.zh}  ${ch.en}`, TX, 842, dark ? P.t[4] : P.t[0], dark ? P.fg : G.CREAM, inv(0.2 * k, 0.2 * k + 0.4 * k, lt));
  }
}

// ───────── one card at rest (its own coordinates) ─────────
function drawCard(ctx, c, lt, o = {}) {
  const P = PAL[c.pk], C = colorsFor(c.pk), k = kOf(c);
  ctx.fillStyle = P.t[1]; ctx.fillRect(-300, -300, W + 600, H + 600);
  patBg(ctx, c.pk, c.n * 31 + 7, lt);
  if (c.push) heroSun(ctx, c.pk, lt);
  const noAsm = o.asm === false || c.n === 1;
  const discIn = noAsm ? 1 : E.o5(inv(0, 0.35 * k, lt));
  sun(ctx, STAGE.x, STAGE.y, STAGE.r * lerp(0.82, 1, discIn), discCol(c.pk), lt);
  const u = lt / BEAT;
  stageFigure(ctx, c, u, C, noAsm ? 1 : inv(0, 0.42 * k, lt));
  textBlock(ctx, c, lt + (o.textLead || 0));
}

// ───────── night card: sleep + count-up slam ─────────
const NC = CARDS[N - 1];
function nightCam(b) {   // b = absolute beat
  let s = 1 + 0.07 * E.io(inv(NIGHT.stop, NIGHT.slam, b));
  if (b >= NIGHT.slam) {
    const d = b - NIGHT.slam;
    s = lerp(1.07, 1.0, E.io(inv(0.5, NIGHT.end - NIGHT.slam, d))) + 0.06 * (1 - E.oExp(d / 1.2));
  }
  return s;
}
const bufReel = G.canvas(360, 360);
// a slot reel: val is continuous (0..10). The window shows exactly one glyph (asc tall); neighbours sit a full glyph + gap away,
// so at rest nothing else shows. Motion blur is a vertical box smear along the reel only (speed in digits per frame), never a ghost copy.
function rollDigit(ctx, x, y, w, val, col, speed) {
  const asc = ctx.measureText('0').actualBoundingBoxAscent, pad = 8, step = asc + 2 * pad + 18;
  const winH = asc + 2 * pad, top = y - asc - pad;
  const rc = bufReel.getContext('2d'); rc.setTransform(1, 0, 0, 1, 0, 0); rc.globalAlpha = 1; rc.globalCompositeOperation = 'source-over';
  rc.clearRect(0, 0, bufReel.width, bufReel.height);
  rc.font = ctx.font; rc.letterSpacing = '0px'; rc.fillStyle = col; rc.textAlign = 'center';
  const L = Math.min(0.45, Math.max(0, speed) * 0.35);         // ~126° shutter, capped so the reel still reads as digits
  const n = L > 0.015 ? Math.max(4, Math.ceil(L * 24)) : 1;
  rc.globalCompositeOperation = 'lighter'; rc.globalAlpha = 1 / n;   // exact average of the sub-positions
  const by = pad + asc, cx = w / 2 + 20;
  for (let i = 0; i < n; i++) {
    const v = val - (n > 1 ? L * (i / (n - 1) - 0.5) : 0), d0 = Math.floor(v), f = v - d0;
    for (let k = -1; k <= 1; k++) {
      const yy = by + (f - k) * step;
      if (yy < -2 || yy - asc > winH + 2) continue;
      rc.fillText(String(((d0 + k) % 10 + 10) % 10), cx, yy);
    }
  }
  ctx.drawImage(bufReel, 0, 0, w + 40, winH, x - 20, top, w + 40, winH);
}
const CX = TX;
function countValue(b) { const p = inv(NIGHT.count0, NIGHT.count1, b); return 99 * Math.pow(p, 1.7); }   // in hundredths
function drawNight(ctx, lt) {
  const c = NC, P = PAL.ink, C = colorsFor('ink'), b = NIGHT.stop + lt / BEAT, u = lt / BEAT;
  const slam = b >= NIGHT.slam, ds = b - NIGHT.slam;
  // camera: slow push → punch on the slam → slow pull back
  const s = nightCam(b);
  ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2);
  ctx.fillStyle = P.t[1]; ctx.fillRect(-300, -300, W + 600, H + 600);
  const seed = 707;
  // rows stop one by one after the slam, snapping to the quarter-cell grid
  const offs = (j) => {
    const jj = ((j % 6) + 6) % 6, tStop = bt(NIGHT.rowsStop[jj] - NIGHT.stop);
    const live = (tt) => rowOffs(j, tt, seed, { sp: 24 });
    if (lt < tStop) return live(lt) + (slam ? S / 4 * Math.exp(-ds * 3) * (j % 2 ? 1 : -1) : 0);
    const v0 = live(tStop), snap = Math.round(v0 / (S / 4)) * (S / 4);
    return lerp(v0, snap, E.oExp((lt - tStop) / 0.15));
  };
  patBg(ctx, 'ink', seed, lt, { offs, spread: 0.55 });
  if (slam) {   // the slam: the pattern flashes to full contrast, then settles
    const a = 1 - E.o3(ds / 1.6);
    if (a > 0.003) { ctx.save(); ctx.globalAlpha = a; patBg(ctx, 'ink', seed + 1, lt, { offs, spread: 1, density: 0.6 }); ctx.restore(); }
  }
  // the horizontal poses (sit on the bed edge, lie down) move the stage outward, so knees and feet stay clear of the counter (STYLE §6)
  const sdx = -120 * E.io(inv(NIGHT.close + 0.4, NIGHT.lie0, b));
  sun(ctx, STAGE.x + sdx, STAGE.y, STAGE.r * lerp(0.82, 1, E.o5(inv(0, 0.3, lt))), discCol('ink'), lt);
  // a small gold moon rises behind the disc while the count rolls
  const mk = E.o5(inv(NIGHT.lie0, NIGHT.slam, b));
  if (mk > 0) { G.disc(ctx, STAGE.x + sdx + 250, STAGE.y - 250 - 30 * mk, 54 * mk, P.accent); G.disc(ctx, STAGE.x + sdx + 274, STAGE.y - 268 - 30 * mk, 48 * mk, discCol('ink')); }
  stageFigure(ctx, c, u, C, 1, sdx);
  // text column
  const fg = P.fg, gold = P.accent;
  const outP = 1 - E.i3(inv(NIGHT.lie0, NIGHT.lie0 + 0.25, b));   // the title is gone on b30.25 (a 16th) before the counter rises into its place
  const metaTxt = slam ? '06:30  →  23:00' : `${c.clock}    ${pad2(c.n)} / ${N}`;
  G.typeText(ctx, metaTxt, TX, 330, F.mono(22), rgba(fg, 0.85), slam ? inv(0, 0.2, ds * BEAT) : inv(0, 0.3, lt), { ls: '4px', caret: false });
  G.hair(ctx, TX, 352, TW, rgba(fg, 0.35), E.oExp(inv(0, 0.4, lt)), 2);
  if (outP > 0) textBlock(ctx, c, lt, { chip: false, meta: false, out: b < NIGHT.lie0 ? 1 : outP });
  if (b < NIGHT.lie0 + 0.3) { ctx.save(); ctx.globalAlpha = 1 - inv(NIGHT.lie0, NIGHT.lie0 + 0.3, b); chip(ctx, `${CHAP.night.zh}  ${CHAP.night.en}`, TX, 842, P.t[0], fg, inv(0.2, 0.6, lt)); ctx.restore(); }
  // the counter
  const base = 800;
  if (b >= NIGHT.count0 + 0.25 && !slam) {
    const pin = inv(NIGHT.count0 + 0.25, NIGHT.count0 + 0.75, b);
    const v = countValue(b), dv = (countValue(b + 0.05) - v) / (0.05 * BEAT) / 24;   // hundredths per frame
    ctx.save();
    ctx.beginPath(); ctx.rect(TX - 20, base - 330, W - TX, 400); ctx.clip();
    ctx.translate(0, (1 - E.oExp(pin)) * 360);
    const fpx = 230; ctx.font = F.en(900, fpx); ctx.letterSpacing = '0px';
    const dw = ctx.measureText('0').width, pw = ctx.measureText('.').width;
    ctx.fillStyle = gold; ctx.textAlign = 'left'; ctx.fillText('0', CX, base); ctx.fillText('.', CX + dw, base);
    const carry = Math.max(0, (v % 10) - 9), tens = Math.floor(v / 10) + carry;
    rollDigit(ctx, CX + dw + pw, base, dw, tens, gold, 0);   // the tens wheel steps crisply on each carry
    rollDigit(ctx, CX + 2 * dw + pw, base, dw, v % 10, gold, dv);
    ctx.font = F.zh(900, 150); ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.fillText('天', CX + 3 * dw + pw + 24, base);
    ctx.restore();
  }
  if (slam) {
    const sc = 1 + 0.42 * (1 - E.oExp(ds / 0.32)), fpx = 540;
    ctx.save(); ctx.font = F.en(900, fpx);
    const w1 = ctx.measureText('1').width;
    ctx.translate(TX + w1 / 2, base); ctx.scale(sc, sc);
    ctx.fillStyle = gold; ctx.textAlign = 'center'; ctx.fillText('1', 0, 0);
    ctx.restore();
    ctx.save(); ctx.font = F.en(900, 230); const dw = ctx.measureText('0').width, pw = ctx.measureText('.').width;
    const xFrom = CX + 3 * dw + pw + 24, xTo = TX + w1 + 40;
    ctx.font = F.zh(900, 260); ctx.fillStyle = fg;
    ctx.fillText('天', lerp(xFrom, xTo, E.oExp(ds / 0.3)), base);
    ctx.restore();
    G.maskText(ctx, 'ONE DAY', TX + 6, 905, F.en(900, 76), rgba(fg, 0.92), inv(0.3, 1.2, ds), { ls: '2px' });
  }
  ctx.restore();
}

// ───────── HUD (fixed to the screen) ─────────
function hud(ctx, ci, b) {
  const c = CARDS[ci], P = PAL[c.pk], fg = P.fg;
  let fade = 1;
  const outA = NIGHT.hudOut[0], outB = NIGHT.hudOut[1];
  ctx.save();
  ctx.font = '500 17px "DM Mono", "Noto Sans SC"'; ctx.letterSpacing = '3px';
  const ta = b >= outB ? 0 : b >= outA ? 1 - inv(outA + 0.9, outB, b) : 1;
  ctx.fillStyle = rgba(fg, 0.8 * ta); ctx.textAlign = 'left';
  ctx.fillText('一天  ·  ONE DAY', 64, 76);
  ctx.textAlign = 'right';
  const ch = CHAP[c.ch]; ctx.fillText(`${ch.zh}  ·  ${ch.en}`, W - 64, 76);
  const x0 = 64, x1 = W - 64, y = H - 58;
  for (let i = 1; i <= N; i++) {
    const x = lerp(x0, x1, (i - 1) / (N - 1));
    const done = i < c.n, now = i === c.n;
    let a = now ? 1 : done ? 0.75 : 0.28;
    if (b >= outA) a *= 1 - inv(outA + (i - 1) * 0.06, outA + (i - 1) * 0.06 + 0.25, b);   // ticks out, one by one
    if (a <= 0.002) continue;
    ctx.fillStyle = rgba(fg, a);
    ctx.fillRect(Math.round(x) - (now ? 3 : 1), y - (now ? 16 : 6), now ? 6 : 2, now ? 22 : 12);
  }
  ctx.restore();
}

// ───────── transitions between locked cards ─────────
const bufA = G.canvas(), bufB = G.canvas();
function composite(ctx, type, p, A, B, info) {
  if (type === 'rows') {
    ctx.drawImage(A, 0, 0);
    for (let j = 0; j < 6; j++) {
      const pj = E.ioExp(clamp(p * 1.5 - j * 0.1));
      const dir = j % 2 ? 1 : -1;
      ctx.drawImage(A, 0, j * S, W, S, dir * W * 0.25 * pj, j * S, W, S);
      ctx.drawImage(B, 0, j * S, W, S, -dir * W * (1 - pj), j * S, W, S);
    }
  } else if (type === 'cols') {
    const cw = 240;
    ctx.drawImage(A, 0, 0);
    for (let i = 0; i < 8; i++) {
      const pj = E.ioExp(clamp(p * 1.5 - i * 0.07));
      const dir = i % 2 ? 1 : -1;
      ctx.drawImage(B, i * cw, 0, cw, H, i * cw, -dir * H * (1 - pj), cw, H);
    }
  } else if (type === 'quarter') {
    ctx.drawImage(A, 0, 0);
    ctx.save(); ctx.beginPath();
    for (let j = 0; j < 6; j++) for (let i = 0; i < 11; i++) {
      const d = (i + j) * 0.03;
      const r = S * 1.42 * E.o3(clamp((p - d) / 0.5));
      if (r <= 0) continue;
      const corner = (i + j) % 4;
      const cx = i * S + (corner === 1 || corner === 2 ? S : 0), cy = j * S + (corner >= 2 ? S : 0);
      ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    }
    ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore();
  } else if (type === 'iris') {
    ctx.drawImage(A, 0, 0);
    const r = 1350 * E.ioExp(p);
    ctx.save(); ctx.beginPath(); ctx.arc(info.x, info.y, r, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore();
    G.ring(ctx, info.x, info.y, r, 26 * (1 - p) + 2, info.ring);
  } else if (type === 'flip') {
    const cols = 11, rows = 6;
    ctx.drawImage(B, 0, 0);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const d = ((i * 0.6 + j) / (cols * 0.6 + rows)) * 0.45;
      const pc = clamp((p - d) / 0.5);
      if (pc >= 1) continue;
      const src = pc < 0.5 ? A : B;
      const sx = Math.max(0.02, Math.abs(Math.cos(pc * Math.PI)));
      const x = i * S, y = j * S, w = S * sx;
      if (pc > 0) { ctx.fillStyle = PAL[info.pkB].t[0]; ctx.fillRect(x, y, S, S); }
      ctx.drawImage(src, x, y, S, S, x + (S - w) / 2, y, w, S);
    }
  }
}

// ───────── spans ─────────
const IDX = (pose) => CARDS.findIndex((c) => c.pose === pose);
const iSub = IDX('subway'), iBike = IDX('bike'), iShower = IDX('shower'), iNight = N - 1;
const TRACK = [iSub, iSub + 1, iSub + 2, iSub + 3];            // subway, type, meet, lunch
const STACK = [iBike - 1, iBike, iBike + 1, iBike + 2, iBike + 3];   // lunch, bike, shop, cook, wash
const cardAt = (t) => { let i = 0; while (i < N - 1 && CARDS[i + 1].t0 <= t + 1e-9) i++; return i; };
const HALF = 0.5 / 24;
const winOf = (c) => c.tin === 'whip' ? WIN.whip : c.tin === 'scroll' ? WIN.scroll : c.tin === 'push' ? WIN.push : c.tin === 'iris' ? WIN.iris :
  c.mode === 'flash' ? (c.tin === 'cols' ? [WIN.flash[0] - HALF, WIN.flash[1] - HALF] : WIN.flash) : WIN.card;
const trackX = (t) => TRACK.slice(1).reduce((a, i) => a + E.ioExp(inv(CARDS[i].t0 + WIN.whip[0], CARDS[i].t0 + WIN.whip[1], t)), 0);
const stackY = (t) => STACK.slice(1).reduce((a, i) => a + E.ioExp(inv(CARDS[i].t0 + WIN.scroll[0], CARDS[i].t0 + WIN.scroll[1], t)), 0);
const T_TRACK0 = CARDS[iSub].t0, T_STACK0 = CARDS[iBike].t0 + WIN.scroll[0], T_STACK1 = CARDS[iShower].t0 + WIN.flash[0];

const bufS = [G.canvas(), G.canvas()];
function renderTo(buf, c, lt, o) { const x = buf.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; drawCard(x, c, lt, o); return buf; }

// returns the card index whose HUD is shown
function frame(ctx, t) {
  t = clamp(t, 0, CARDS[N - 1].t1 - 1e-6);
  const i = cardAt(t), c = CARDS[i], b = t / BEAT;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
  // 1) push into the little sun (last 6 frames of the run card)
  const sub = CARDS[iSub];
  if (t >= sub.t0 + WIN.push[0] && t < sub.t0) {
    const run = CARDS[iSub - 1], p = inv(sub.t0 + WIN.push[0], sub.t0, t), e = E.i3(p);
    const sMax = Math.hypot(W, H) / 2 / HERO.r, s = Math.exp(Math.log(sMax) * e);
    const pos = [lerp(HERO.x, W / 2, E.io3(p)), lerp(HERO.y, H / 2, E.io3(p))];
    renderTo(bufA, run, t - run.t0, { asm: false });
    ctx.save(); ctx.translate(pos[0], pos[1]); ctx.scale(s, s); ctx.translate(-HERO.x, -HERO.y); ctx.drawImage(bufA, 0, 0); ctx.restore();
    const r = HERO.r * s, sB = Math.min(1, r / (Math.hypot(W, H) / 2));
    renderTo(bufB, sub, 0, { asm: false });
    ctx.save(); ctx.beginPath(); ctx.arc(pos[0], pos[1], r, 0, Math.PI * 2); ctx.clip();
    ctx.translate(pos[0], pos[1]); ctx.scale(sB, sB); ctx.translate(-W / 2, -H / 2); ctx.drawImage(bufB, 0, 0); ctx.restore();
    return p < 0.6 ? iSub - 1 : iSub;
  }
  // 2) the lateral long take
  if (t >= T_TRACK0 && t < T_STACK0) {
    const cx = trackX(t) * W, k0 = Math.floor(cx / W);
    for (let k = k0; k <= Math.min(k0 + 1, TRACK.length - 1); k++) {
      const cc = CARDS[TRACK[k]], ox = k * W - cx;
      if (ox <= -W || ox >= W) continue;
      ctx.save(); ctx.translate(Math.round(ox), 0); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip(); drawCard(ctx, cc, t - cc.t0, { asm: false, textLead: cc.tin === 'whip' ? 0.42 : 0 }); ctx.restore();   // stations of the long take: their type has landed by the time the camera does (on the beat)
    }
    // a rail line runs through every station of the take
    ctx.fillStyle = rgba(G.CREAM, 0.22); ctx.fillRect(0, 960, W, 3);
    for (let x = -((cx * 1.0) % 120); x < W; x += 120) ctx.fillRect(x, 975, 60, 3);
    return TRACK[Math.min(TRACK.length - 1, Math.round(cx / W))];
  }
  // 3) the vertical row scroll: bands of one grid row, bottom rows lead
  if (t >= T_STACK0 && t < T_STACK1) {
    const y = stackY(t), k0 = Math.min(STACK.length - 1, Math.floor(y + 1e-9));
    const cA = CARDS[STACK[k0]], cB = CARDS[STACK[Math.min(k0 + 1, STACK.length - 1)]];
    renderTo(bufS[0], cA, t - cA.t0, { asm: false });
    const moving = y - k0 > 1e-6 || STACK.slice(1).some((ii) => Math.abs(t - CARDS[ii].t0) < 0.2);
    if (!moving) { ctx.drawImage(bufS[0], 0, 0); return STACK[k0]; }
    renderTo(bufS[1], cB, t - cB.t0, { asm: false });
    for (let j = 0; j < 6; j++) {
      const yj = stackY(t + (2.5 - j) * 0.018) - k0, dy = clamp(yj, 0, 1) * H;
      ctx.save(); ctx.beginPath(); ctx.rect(0, j * S, W, S); ctx.clip();
      ctx.drawImage(bufS[0], 0, -dy); ctx.drawImage(bufS[1], 0, H - dy);
      ctx.restore();
    }
    return y - k0 < 0.5 ? STACK[k0] : STACK[Math.min(k0 + 1, STACK.length - 1)];
  }
  // 4) grid transitions around the cut into card k
  for (const k of [i, i + 1]) {
    if (k <= 0 || k >= N) continue;
    const cb = CARDS[k], ca = CARDS[k - 1];
    if (!['rows', 'cols', 'flip', 'quarter', 'iris'].includes(cb.tin)) continue;
    const w = winOf(cb);
    if (t < cb.t0 + w[0] || t >= cb.t0 + w[1]) continue;
    const p = inv(cb.t0 + w[0], cb.t0 + w[1], t);
    renderTo(bufA, ca, t - ca.t0, {});
    const xb = bufB.getContext('2d'); xb.setTransform(1, 0, 0, 1, 0, 0);
    if (cb.mode === 'night') drawNight(xb, Math.max(0, t - cb.t0)); else drawCard(xb, cb, Math.max(0, t - cb.t0), {});
    composite(ctx, cb.tin, p, bufA, bufB, { x: STAGE.x, y: STAGE.hipY - 120, ring: PAL.ink.accent, pkB: cb.pk });
    return p < 0.5 ? k - 1 : k;
  }
  // 5) a card at rest
  if (c.mode === 'night') drawNight(ctx, t - c.t0); else drawCard(ctx, c, t - c.t0, {});
  return i;
}

// moments that need motion blur
function isFast(t) {
  for (const c of CARDS) {
    if (c.n === 1) continue;
    const w = winOf(c);
    if (t >= c.t0 + w[0] - 0.03 && t < c.t0 + w[1] + 0.03) return true;
  }
  const ds = t - bt(NIGHT.slam);
  return ds >= 0 && ds < 0.15;
}
const bufSub = G.canvas(), T_SLAM = bt(NIGHT.slam);
export function renderFrame(ctx, t) {
  const b = t / BEAT;
  if (!isFast(t)) { const ci = frame(ctx, t); ctx.setTransform(1, 0, 0, 1, 0, 0); hud(ctx, ci, b); return; }
  const inWin = (c) => t >= c.t0 + winOf(c)[0] - 0.03 && t < c.t0 + winOf(c)[1] + 0.03;
  const whip = CARDS.find((c) => c.tin === 'whip' && inWin(c));
  // whip pans: only the beat frame (the fastest) carries the smear; its neighbours are nearly at rest and stay sharp
  if (whip && Math.abs(t - whip.t0) > HALF) { const ci = frame(ctx, t); ctx.setTransform(1, 0, 0, 1, 0, 0); hud(ctx, ci, b); return; }
  const big = whip || CARDS.some((c) => c.tin === 'push' && inWin(c));
  const n = whip ? 15 : big ? 9 : 5, shutter = 0.5 / 24, sc = bufSub.getContext('2d');
  let ci = 0;
  for (let k = 0; k < n; k++) {
    sc.setTransform(1, 0, 0, 1, 0, 0);
    let tk = t - shutter / 2 + (shutter * k) / (n - 1);
    if (t >= T_SLAM) tk = Math.max(tk, T_SLAM);
    if (whip) tk = t + (shutter / 2) * k / (n - 1);   // the beat frame's shutter opens on the beat: the smear trails into the new station
    const r = frame(sc, tk); if (k === (n >> 1)) ci = r;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1 / (k + 1); ctx.drawImage(bufSub, 0, 0);
  }
  ctx.globalAlpha = 1; hud(ctx, ci, b);
}

// texts on screen (for readcheck): the card whose HUD shows
export function texts(t) {
  const out = [], i = cardAt(t), c = CARDS[i];
  out.push({ id: 'hud', text: '一天  ·  ONE DAY', x0: 64, y0: 58, x1: 330, y1: 82 });
  if (c.mode !== 'night' || t < bt(NIGHT.lie0)) out.push({ id: 'title' + c.n, text: c.zh + ' ' + c.en, x0: TX, y0: 380, x1: TX + TW, y1: 770 });
  if (c.mode === 'night' && t >= bt(NIGHT.slam)) out.push({ id: 'slam', text: '1 天 ONE DAY', x0: TX, y0: 330, x1: TX + TW, y1: 880 });
  return out;
}
