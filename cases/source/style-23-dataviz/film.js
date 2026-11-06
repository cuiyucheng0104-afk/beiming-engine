// 地球的一秒 — the story: chart layers, notes, camera path, pencil performance. Deterministic render(t).
import * as E from './engine.js';
import { clamp, lerp, seg, ss, eio, eo, ei, hash, mulberry, monotone } from '/core/lib.js';
import * as TL from './timeline.js';
const { T, B, X0, X1, PW, AXY, DAYH, MARKS, K, RATE, LEVELS, MORPH, STEP_B } = TL;
const { W, H, P } = E;
const HAND = 'Caveat, "Ma Shan Zheng"', MONO = '"IBM Plex Mono", "Noto Sans SC"', SANS = '"Noto Sans SC"', SERIF = '"Noto Serif SC"';
const R0 = { birth: 11, bolt: 7 };
const FILL = { birth: P.ink, bolt: '#8A8174' };

// ---------- populations beyond the first second (fixed seeds) ----------
function population(kind, s0, s1, seed) {
  const n = Math.round(RATE[kind] * s1) - Math.round(RATE[kind] * s0), R = mulberry(seed);
  const sec = new Float32Array(n), v = new Float32Array(n);
  for (let i = 0; i < n; i++) { sec[i] = s0 + R() * (s1 - s0); v[i] = .06 + R() * .88; }
  return { sec, v, n };
}
const POP = {
  birth: [population('birth', 1, 60, 101), population('birth', 60, 3600, 102)],
  bolt: [population('bolt', 1, 60, 201), population('bolt', 60, 3600, 202)],
};

// ---------- geometry over time ----------
function lanes(t) {
  const m = eio(seg(t, T(MORPH[0]), T(MORPH[1]))), gw = eo(seg(t, T(20), T(21.2)));     // lanes grow as the second breaks open (≥ 360 px together through the switch)
  const h0 = lerp(110, 180, gw), hb = lerp(h0, DAYH.bolt, m), hh = lerp(h0, DAYH.birth, m);
  const boltBot = 180, boltTop = boltBot - hb, birthBot = boltTop - 50, birthTop = birthBot - hh;
  return { bolt: [boltTop, boltBot], birth: [birthTop, birthBot], m };
}
const xOf = (sec, F) => X0 + sec / F * PW;
const laneY = (L, kind, v) => L[kind][0] + v * (L[kind][1] - L[kind][0]);
const titleY = L => L.birth[0] - 150;
const rOf = (kind, F) => R0[kind] / Math.pow(F, .3);
const markPos = (m, t, F = 1, L = lanes(t)) => [xOf(m.sec, F), laneY(L, m.kind, m.v)];
const FIRST = { birth: MARKS.find(m => m.kind === 'birth'), bolt: MARKS.find(m => m.kind === 'bolt') };

// ---------- camera ----------
const zTrack = monotone([[4, 3.4], [5.4, 3.2], [6.3, 2.45], [8, 2.2], [10, 1.9], [12, 1.55], [14, 1.22], [16, 1.0]]);
const yTrack = monotone([[4, -62], [5.6, -62], [6.4, 12], [10, 14], [16, -10]]);
const phX = t => { let s = 0; for (let k = -4; k <= 4; k++) s += TL.playSec(t + k * .06); return X0 + PW * s / 9; };
const FULL = { x: 20, y: -10, zoom: 1.1, roll: 0 };
const OPEN0 = { x: -25, y: 66, zoom: 1.12 }, OPEN1 = { x: -20, y: 40, zoom: 1.22 };   // the empty second, axis near mid-frame
const CREEP = { x: 58, y: 4, zoom: 1.14 };                         // end of the slow push during total + silence
const PUNCH = { x: 380, y: 10, zoom: 1.5 }, PULL = { x: 60, y: -20, zoom: 1.035 };
function camera(t) {
  const b = t / B; let c;
  if (b < 4) { const k = eio(seg(b, 0, 4)); c = { x: lerp(OPEN0.x, OPEN1.x, k), y: lerp(OPEN0.y, OPEN1.y, k), zoom: lerp(OPEN0.zoom, OPEN1.zoom, k), roll: 0 }; }
  else if (b < 20) {
    const z = zTrack(Math.min(b, 16)), track = { x: phX(t) - .1 * W / z, y: yTrack(Math.min(b, 16)), zoom: z, roll: 0 };
    const early = 1 - ss(seg(b, 5.3, 6.4));                          // first fact: frame the dot and its note
    track.x = lerp(track.x, xOf(FIRST.birth.sec, 1) + 150, early);
    const p = clamp((t - T(4)) / (2 / 24));                          // punch-in over 2 frames on the first birth
    if (p < 1) { const s = ei(p); track.x = lerp(OPEN1.x, track.x, s); track.y = lerp(OPEN1.y, track.y, s); track.zoom = lerp(OPEN1.zoom, z, s); }
    const w = ss(seg(b, 14, 16.5));
    c = { x: lerp(track.x, FULL.x, w), y: lerp(track.y, FULL.y, w), zoom: lerp(track.zoom, FULL.zoom, w), roll: 0 };
    const cr = eio(seg(b, 16.5, 20));                                 // slow creep toward the hovering pencil: the wait is alive
    c.x = lerp(c.x, CREEP.x, cr); c.y = lerp(c.y, CREEP.y, cr); c.zoom = lerp(c.zoom, CREEP.zoom, cr);
    const sh = Math.exp(-(t - T(4)) / .12) * (t >= T(4) ? 9 : 0);    // decaying shake after the punch
    c.sx = sh * Math.sin(t * 91); c.sy = sh * Math.cos(t * 77);
  } else {
    // tap: 2-frame punch-in on the puncture, hold the pierced state half a beat, then the fast pull-out
    const pin = ei(clamp((t - T(20)) / (2 / 24))), k1 = eo(seg(b, 20.5, 21.5)), k2 = eio(seg(b, 22.4, 24.2)), k3 = eio(seg(b, 24.2, 26.5)), k4 = ss(seg(b, 26, 29));
    const hx = lerp(CREEP.x, PUNCH.x, pin), hy = lerp(CREEP.y, PUNCH.y, pin), hz = lerp(CREEP.zoom, PUNCH.zoom, pin);
    c = { x: lerp(lerp(hx, PULL.x, k1), 40, k2), y: lerp(lerp(hy, PULL.y, k1), -250, k2), zoom: lerp(lerp(lerp(hz, PULL.zoom, k1), .97, k2), .95, k4),
      roll: lerp(lerp(lerp(0, -.045, k1), -.06, k2), 0, k3) };
    const trem = (1 - k3) * (b < 24.2 ? 2.4 : 0);                    // small constant tremor during the rush
    let jolt = 0; STEP_B.forEach(b0 => { if (b >= b0) jolt += 11 * Math.exp(-(t - T(b0)) / .09); });
    c.sx = trem * Math.sin(t * 63) + jolt * Math.sin(t * 117); c.sy = trem * Math.cos(t * 71) + jolt * .6 * Math.cos(t * 101);
  }
  return c;
}

// ---------- pencil performance (world tip, lift, flip) ----------
// a list of "stations": [t, x, y, lift]; between stations the tip hops in an arc.
function axisPath() { return [[X1 + 40, AXY], [X0 - 10, AXY]]; }
const tickX = i => X0 + PW * i / 4;
function stations(t) {
  const L = lanes(t), S = [];
  S.push([T(-1), X1 + 40, AXY, 0], [0, X1 + 40, AXY, 0]);
  K.ticks.forEach((b, i) => S.push([T(b), tickX(i), AXY + 14, 0]));
  MARKS.forEach(m => { const [x, y] = markPos(m, t, 1, L); S.push([m.t, x, y, 0]); });
  return S;
}
const HOVER = [X1 + 36, AXY + 2];                                 // up-right of the 1 秒 label: the label stays readable
function pencil(t, cam, ctx) {
  const b = t / B;
  let tip = null, lift = 0, flip = 0, screen = null, alpha = 1;
  flip = ss(seg(b, K.flip[0], K.flip[1]));
  if (b < K.axis[1]) { tip = ctx.axisTip; }
  else if (b >= K.noteBirth[0] && b < K.noteBirth[1]) tip = ctx.noteTip.birth;
  else if (b >= K.noteBolt[0] && b < K.noteBolt[1]) tip = ctx.noteTip.bolt;
  else if (b < 16) {
    const S = stations(t);
    let i = S.findIndex(s => s[0] > t); if (i < 0) i = S.length;
    const a = S[i - 1], c = S[i] || a;
    // after a note the hop starts where the writing ended
    let ax = a[1], ay = a[2], ta = a[0];
    if (b >= K.noteBirth[1] && a[0] < T(K.noteBirth[1]) && c[0] > T(K.noteBirth[1])) { [ax, ay] = ctx.noteEnd.birth; ta = T(K.noteBirth[1]); }
    if (b >= K.noteBolt[1] && a[0] < T(K.noteBolt[1]) && c[0] > T(K.noteBolt[1])) { [ax, ay] = ctx.noteEnd.bolt; ta = T(K.noteBolt[1]); }
    const gap = Math.max(1e-3, c[0] - ta), u = clamp((t - ta) / gap);
    const e = u < .2 ? 0 : ss((u - .2) / .8);                       // rebound, then travel
    tip = [lerp(ax, c[1], e), lerp(ay, c[2], e)];
    const hmax = Math.min(.9, gap * 1.3);
    lift = Math.sin(Math.PI * u) * hmax + (u < .2 ? .04 * Math.sin(u / .2 * Math.PI) : 0);
    if (b >= K.flip[0] - .25 && b < 6) lift = Math.max(lift, .55 * Math.sin(Math.PI * seg(b, K.flip[0] - .25, 6)));
    if (gap < .1) { tip[1] += Math.sin(t * 160) * 2.2; lift = Math.max(lift, .05); }   // seismograph tremble in the rush
  } else if (b < K.tap) {
    const last = MARKS[MARKS.length - 1], [lx, ly] = markPos(last, t);
    const u = ss(seg(b, 16, 17.2)), d = ss(seg(b, 19.4, 20));
    tip = [lerp(lx, HOVER[0], u), lerp(ly, HOVER[1], u)];
    lift = lerp(Math.sin(Math.PI * clamp(u)) * .7 + u * .55, 0, d);
    const hes = (.35 * seg(b, 17, 18) + .65 * seg(b, 18, 18.6)) * (1 - d), A = 4.4 / cam.zoom;   // hesitation: ~4–5 px tremor in the silence
    tip[0] += (Math.sin(t * 23) + .45 * Math.sin(t * 59 + 1)) * A * .75 * hes; tip[1] += (Math.cos(t * 31) + .4 * Math.sin(t * 47)) * A * .7 * hes;
    lift += .05 * hes * (1 + Math.sin(t * 13));                       // the shadow breathes with it
  } else if (b < K.flinch[1] + .05) {
    const k = eo(seg(b, K.flinch[0] + .06, K.flinch[1]));
    const s0 = E.w2s(cam, HOVER[0], HOVER[1]);
    screen = [lerp(s0[0], W + 260, k), lerp(s0[1], H + 160, k)]; lift = lerp(0, 1.2, k);
  } else if (b < K.back[0]) { alpha = 0; }
  else if (b < K.back[1]) {
    const k = eo(seg(b, K.back[0], K.back[1])), L = lanes(t), s1 = E.w2s(cam, X1 + 22, L.bolt[0] + 8);
    screen = [lerp(W + 300, s1[0], k), lerp(H + 220, s1[1], k)]; lift = lerp(1.1, 0, k);
  } else if (b < K.bracket[1]) tip = ctx.bracketTip;
  else if (b < K.ratio[0]) { const u = seg(b, K.bracket[1], K.ratio[0]); tip = [lerp(ctx.bracketTip[0], ctx.ratioA[0], ss(u)), lerp(ctx.bracketTip[1], ctx.ratioA[1], ss(u))]; lift = Math.sin(Math.PI * u) * .3; }
  else if (b < K.ratio[1]) tip = ctx.ratioTip;
  else if (b < K.strike[0]) {
    const u = seg(b, K.ratio[1], K.strike[0]);
    tip = [lerp(ctx.ratioEnd[0], ctx.strikeA[0], ss(u)), lerp(ctx.ratioEnd[1], ctx.strikeA[1], ss(u))]; lift = Math.sin(Math.PI * u) * .8;
  } else if (b < K.strike[1]) tip = ctx.strikeTip;
  else if (b < K.rewrite[0]) { const u = seg(b, K.strike[1], K.rewrite[0]); tip = [lerp(ctx.strikeB[0], ctx.rewA[0], ss(u)), lerp(ctx.strikeB[1], ctx.rewA[1], ss(u))]; lift = Math.sin(Math.PI * u) * .35; }
  else if (b < K.rewrite[1]) tip = ctx.rewTip;
  else if (b < K.exit[1] + .05) {
    const k = ei(seg(b, K.exit[0], K.exit[1])), s0 = E.w2s(cam, ...ctx.rewEnd);
    screen = [lerp(s0[0], W + 420, k), lerp(s0[1], H + 320, k)]; lift = lerp(.1 * seg(b, K.rewrite[1], K.exit[0]), 1.2, k);
  } else alpha = 0;
  if (alpha <= 0) return;
  const sp = screen || E.w2s(cam, tip[0], tip[1]);
  const s = clamp(.62 + .3 * cam.zoom, .7, 1.5);
  E.drawPencil(ctx.g, { tip: sp, s, lift, flip, ang: .62 + (b > 12 && b < 16 ? .14 : b >= 16 && b < 21 ? .18 * ss(seg(b, 16, 17.2)) : 0), alpha });
}

// ---------- text registry (for readcheck) ----------
let REG = null;
function reg(id, text, cam, x0, y0, x1, y1) {
  if (!REG) return;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => E.w2s(cam, p[0], p[1]));
  REG.push({ id, text, x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) });
}

// ---------- counters ----------
function fmt(v) {
  if (v < 10000) return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (v / 1e4).toFixed(1) + ' 万';
}

// ---------- the film ----------
export function renderFilm(g, t) {

  const b = t / B, cam = camera(t), L = lanes(t), F = TL.scaleF(t), lvl = TL.levelAt(t);
  const settled = Math.abs(Math.log(F) - Math.log(LEVELS[lvl].F)) < 1e-6;
  E.drawPaper(g, cam, { dots: .9 });
  E.applyCam(g, cam);
  const ctx = { g, noteTip: {}, noteEnd: {} };

  // --- title (the chart's own headline) ---
  const ty = titleY(L), tAlpha = 1 - seg(cam.zoom, 1.3, 1.45);
  if (tAlpha > 0) {
    const tw = E.setType(g, '地球的一秒', 0, ty, { size: 72, font: SERIF, weight: 700, color: P.ink, align: 'center', alpha: tAlpha });
    reg('title', '地球的一秒', cam, -tw / 2, ty - 66, tw / 2, ty + 10);
    g.save(); g.font = `700 72px ${SERIF}`; const w3 = g.measureText('地球的').width; g.restore();
    ctx.strikeA = [-tw / 2 + w3 - 8, ty - 25]; ctx.strikeB = [tw / 2 + 10, ty - 27];
    if (b >= K.strike[0]) ctx.strikeTip = E.pencilStroke(g, [ctx.strikeA, [(ctx.strikeA[0] + ctx.strikeB[0]) / 2, ty - 27], ctx.strikeB],
      { color: P.red, width: 4.2, progress: ss(seg(b, K.strike[0], K.strike[1])), seed: 41, wobble: .5 });
    const rx = (ctx.strikeA[0] + ctx.strikeB[0]) / 2 - 64, ry = ty - 88;
    ctx.rewA = [rx, ry - 20];
    if (b >= K.rewrite[0]) {
      const r = E.handText(g, '一天', rx, ry, { size: 80, color: P.red, font: HAND, weight: 400, progress: seg(b, K.rewrite[0], K.rewrite[1]), zoom: cam.zoom });
      ctx.rewTip = r.tip; ctx.rewEnd = [r.left + r.w, ry - 20];
      reg('rewrite', '一天', cam, rx, ry - 70, rx + r.w, ry + 14);
    } else { ctx.rewEnd = [rx + 120, ry - 20]; }
  }

  // --- lane labels ---
  const lab = (k, txt, i) => {
    const p = seg(b, K.labels[i], K.labels[i] + .5); if (p <= 0) return;
    const y = (L[k][0] + L[k][1]) / 2 + 9;
    const w = E.setType(g, txt, X0 - 30, y, { size: 26, font: SANS, weight: 500, color: P.inkSoft, align: 'right', progress: p, rise: 6 });
    if (p >= 1) reg('lab_' + k, txt, cam, X0 - 30 - w, y - 26, X0 - 30, y + 6);
  };
  lab('birth', '出生', 0); lab('bolt', '闪电', 1);

  // --- axis + ticks ---
  ctx.axisTip = E.pencilStroke(g, axisPath(), { color: P.ink, width: 2.2, progress: eio(seg(b, K.axis[0], K.axis[1])), seed: 3, wobble: .35 });
  K.ticks.forEach((tb, i) => {
    const p = seg(b, tb, tb + .2); if (p <= 0) return;
    E.pencilStroke(g, [[tickX(i), AXY], [tickX(i), AXY + 14]], { color: P.ink, width: 1.8, progress: p, seed: 10 + i, passes: 1 });
    // tick labels: the level they belong to, typeset again on each ratchet step
    let lv = lvl, since = lvl ? b - STEP_B[lvl - 1] : b - tb;
    const txt = LEVELS[lv].ticks[i], prog = lv ? clamp(since / .3) : clamp(since / .35);
    const w = E.setType(g, txt, tickX(i), AXY + 46, { size: 23, font: MONO, color: i === 4 ? P.ink : P.inkSoft, align: 'center', progress: prog, rise: 6 });
    if (prog >= 1 && (lv === 0 || lv === 3)) reg('tick' + i, txt, cam, tickX(i) - w / 2, AXY + 26, tickX(i) + w / 2, AXY + 52);
  });

  // --- playhead: dashed hairline + running clock ---
  const phA = seg(b, 3.6, 4) * (1 - seg(b, 16.2, 16.8));
  if (phA > 0) {
    const px = X0 + PW * TL.playSec(t);
    g.save(); g.globalAlpha = .45 * phA; g.strokeStyle = P.inkSoft; g.lineWidth = 1 / Math.max(1, cam.zoom * .7); g.setLineDash([5, 6]);
    g.beginPath(); g.moveTo(px, AXY - 4); g.lineTo(px, L.birth[0] - 16); g.stroke(); g.restore();
    E.setType(g, TL.playSec(t).toFixed(2) + ' 秒', px, AXY + 84, { size: 17, font: MONO, color: P.inkSoft, align: 'center', alpha: .85 * phA });
  }

  // --- data: the first second (one mark = one fact) ---
  for (const m of MARKS) {
    if (t < m.t) continue;
    const [x, y] = markPos(m, t, F, L), r = rOf(m.kind, F), fresh = t - m.t;
    const gap = T(Math.min(...[MARKS[MARKS.indexOf(m) + 1], MARKS[MARKS.indexOf(m) - 1]].filter(Boolean).map(k => Math.abs(k.b - m.b))));
    if (r * cam.zoom > 1.3) E.dataDot(g, x, y, r, FILL[m.kind], { fresh, ripple: gap >= .1 ? 1 : 0, ringW: m.kind === 'birth' ? 1.6 : 1.2, ring: P.ink });
    else { g.fillStyle = FILL[m.kind]; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
  }

  // --- data: the rest of the minute / hour (explicit dots), and the day as an equal-density tone ---
  if (F > 1.0001) {
    const toneFrom = F >= 86399 ? 60 : 3600;
    for (const kind of ['birth', 'bolt']) {
      const r = rOf(kind, F), rz = Math.max(r, .5 / cam.zoom);
      g.fillStyle = FILL[kind]; g.beginPath();
      for (const pop of POP[kind]) {
        const { sec, v, n } = pop; if (sec[0] >= toneFrom && pop === POP[kind][1]) continue;
        const L0 = L[kind][0], Lh = L[kind][1] - L[kind][0];
        for (let i = 0; i < n; i++) {
          const s = sec[i]; if (s > F || s >= toneFrom) continue;
          const x = X0 + s / F * PW, y = L0 + v[i] * Lh;
          if (rz * cam.zoom > 1.6) { g.moveTo(x + rz, y); g.arc(x, y, rz, 0, Math.PI * 2); } else g.rect(x - rz, y - rz, 2 * rz, 2 * rz);
        }
      }
      g.fill();
      if (F > toneFrom) {                                              // beyond that: too many to resolve, drawn as tone
        const xa = xOf(toneFrom, F), xb = xOf(Math.min(F, 86400), F), [ya, yb] = L[kind];
        const dens = RATE[kind] / ((PW / F) * (yb - ya)), own = 1 - Math.exp(-dens * Math.PI * rOf(kind, F) ** 2), tone = lerp(own, .56, L.m);
        toneBlock(g, xa, ya, xb, yb, tone, kind);
      }
    }
  }
  // outlines of the final blocks (area ∝ count, equal density)
  if (L.m > 0) for (const kind of ['birth', 'bolt']) {
    const [ya, yb] = L[kind];
    E.pencilStroke(g, [[X0, yb], [X0, ya], [X1, ya], [X1, yb]], { color: P.ink, width: 1.5, progress: L.m, seed: kind === 'birth' ? 61 : 62, passes: 1, wobble: .3 });
  }

  // --- pinned notes (data space), fade when the second is broken open ---
  const nf = 1 - seg(b, K.notesFade[0], K.notesFade[1]);
  const note = (kind, txt, color, kb, dx, base, seed) => {
    if (b < kb[0] || nf <= 0) return;
    const m = FIRST[kind], [x, y] = markPos(m, t, F, L), r = rOf(kind, F), dy = L[kind][0] + base - y;
    const u = seg(b, kb[0], kb[1]), uRing = seg(u, 0, .22), uLead = seg(u, .22, .4), uText = seg(u, .4, 1);
    g.save(); g.globalAlpha = nf;
    let tip = E.pencilStroke(g, E.ringPath(x, y, r + 9, seed), { color, width: 1.6, progress: uRing, seed, passes: 1 });
    const ta = [x + dx - 6, y + dy + 4], tb = [x + (dx > 0 ? r + 8 : -r - 8) * .7, y + (dy < 0 ? -r - 8 : r + 8) * .7];
    if (uLead > 0) tip = E.leader(g, ta, tb, { color, progress: uLead, seed: seed + 1 });
    let res = null;
    if (uText > 0) { res = E.handText(g, txt, x + dx, y + dy, { size: kind === 'birth' ? 36 : 32, color, font: HAND, weight: 400, progress: uText, zoom: cam.zoom }); tip = res.tip; }
    g.restore();
    ctx.noteTip[kind] = tip; ctx.noteEnd[kind] = res ? [res.left + res.w, y + dy - 10] : tip;
    if (res && uText > 0 && nf >= 1) reg('note_' + kind, txt, cam, x + dx, y + dy - 36, x + dx + res.w, y + dy + 8);
  };
  note('birth', '1 个婴儿出生', P.blue, K.noteBirth, 40, -26, 21);
  note('bolt', '1 道闪电', P.red, K.noteBolt, 34, -13, 31);
  if (!ctx.noteEnd.birth) { const [x, y] = markPos(FIRST.birth, t, F, L); ctx.noteEnd.birth = [x + 200, y - 72]; }
  if (!ctx.noteEnd.bolt) { const [x, y] = markPos(FIRST.bolt, t, F, L); ctx.noteEnd.bolt = [x + 150, y - 64]; }

  // --- counters (printed tally, right of each lane) ---
  for (const kind of ['birth', 'bolt']) {
    const y = kind === 'bolt' ? lerp((L.bolt[0] + L.bolt[1]) / 2 + 10, L.bolt[0] + 44, L.m) : (L[kind][0] + L[kind][1]) / 2 + 10, x = X1 + 40;
    let txt, per = '', isSet = false;
    if (b < K.settle) { const n = MARKS.filter(m => m.kind === kind && m.t <= t).length; if (!n) continue; txt = String(n); }
    else if (lvl === 0) { txt = String(RATE[kind]); per = LEVELS[0].per; isSet = true; }
    else { txt = fmt(RATE[kind] * F); per = LEVELS[lvl].per; isSet = settled; }
    const p = b < K.settle ? 1 : lvl === 0 ? clamp((b - K.settle) / .4) : 1;
    const w = E.setType(g, txt, x, y, { size: 32, font: MONO, weight: 500, color: P.ink, progress: p, rise: lvl === 0 && b >= K.settle ? 8 : 0 });
    if (per) E.setType(g, per, x + w + 8, y, { size: 20, font: SANS, weight: 500, color: P.inkSoft, progress: p });
    if (isSet && p >= 1 && (lvl === 0 || lvl === 3)) reg('count_' + kind, txt + per, cam, x, y - 30, x + w + 60, y + 6);
  }

  // --- the verdict: lightning is about ten times the births (44 / 4.2 = 10.5) ---
  if (b >= K.bracket[0]) {
    const [ya, yb] = L.bolt, bx = X1 + 22;
    const path = E.bracketPath(ya + 8, yb - 8, bx, 16).map(([a, c]) => [c, a]);
    ctx.bracketTip = E.pencilStroke(g, path, { color: P.red, width: 2.2, progress: eio(seg(b, K.bracket[0], K.bracket[1])), seed: 71, passes: 2, wobble: .4 });
    const ny = (ya + yb) / 2 + 30, nx = X1 + 56;
    ctx.ratioA = [nx, ny - 16];
    if (b >= K.ratio[0]) {
      const r = E.handText(g, '约 10 倍', nx, ny, { size: 50, color: P.red, font: HAND, weight: 400, progress: seg(b, K.ratio[0], K.ratio[1]), zoom: cam.zoom });
      ctx.ratioTip = r.tip; ctx.ratioEnd = [r.left + r.w, ny - 16];
      reg('ratio', '约 10 倍', cam, nx, ny - 46, nx + r.w, ny + 12);
    }
  }
  if (b >= K.tap) scar(g, HOVER[0], HOVER[1], t - T(K.tap));
  pencil(t, cam, ctx);
}

// the broken frame: where the pencil went through the paper. Torn at the tap, kept as a scar to the end.
const SCAR = (() => {
  const R = mulberry(909), hole = [], creases = [], flaps = [];
  for (let i = 0; i < 18; i++) {                                      // torn star: sharp fibre points between bitten notches
    const a = i / 18 * Math.PI * 2 + (R() - .5) * .12, r = i % 2 ? 9 + R() * 4 : 17 + R() * 10;
    hole.push([Math.cos(a) * r, Math.sin(a) * r * .9]);
  }
  for (const deg of [-158, -112, -64, -20, 22, 58, 86]) {            // pressure creases; none toward the lower-left (the 1 秒 / 1 天 label)
    const a = deg * Math.PI / 180 + (R() - .5) * .1, L = 34 + R() * 16;
    creases.push([a, 22, L]);
  }
  for (let i = 0; i < 4; i++) { const a = (i / 4 + .06 + R() * .06) * Math.PI * 2, w = .32 + R() * .12; flaps.push([a, w]); }
  return { hole, creases, flaps };
})();
function scar(g, x, y, age) {
  const k = clamp(age / (2 / 24)), open = eo(k), S = .3 + .7 * open;  // tears open over 2 frames, then stays
  g.save(); g.translate(x, y); g.scale(1.25, 1.25);
  const sm = g.createRadialGradient(0, 0, 10, 0, 0, 58);             // graphite bruise + dent around the wound
  sm.addColorStop(0, 'rgba(58,55,51,.22)'); sm.addColorStop(.55, 'rgba(58,55,51,.08)'); sm.addColorStop(1, 'rgba(58,55,51,0)');
  g.fillStyle = sm; g.globalAlpha = open; g.beginPath(); g.arc(0, 0, 58, 0, Math.PI * 2); g.fill();
  g.lineCap = 'round';
  for (const [a, r0, L] of SCAR.creases) {                            // a crease = shadow line + paper highlight beside it
    const c = Math.cos(a), s = Math.sin(a), r1 = r0 + (L - r0) * open;
    g.lineWidth = 1.3; g.strokeStyle = 'rgba(110,102,92,.55)'; g.beginPath(); g.moveTo(c * r0, s * r0); g.lineTo(c * r1, s * r1); g.stroke();
    g.lineWidth = 1.1; g.strokeStyle = 'rgba(255,253,248,.9)'; g.beginPath(); g.moveTo(c * r0 - s * 1.3, s * r0 + c * 1.3); g.lineTo(c * r1 - s * 1.3, s * r1 + c * 1.3); g.stroke();
  }
  g.globalAlpha = 1;
  g.beginPath(); SCAR.hole.forEach(([a, b], i) => i ? g.lineTo(a * S, b * S) : g.moveTo(a * S, b * S)); g.closePath();
  g.fillStyle = '#E9E2D4'; g.fill();                                   // torn fibre rim (paper edge, slightly darker)
  g.lineWidth = 1; g.strokeStyle = 'rgba(110,102,92,.8)'; g.stroke();
  g.beginPath(); SCAR.hole.forEach(([a, b], i) => i ? g.lineTo(a * S * .72, b * S * .72) : g.moveTo(a * S * .72, b * S * .72)); g.closePath();
  g.fillStyle = '#2A2420'; g.fill();                                   // the dark beneath the sheet
  for (const [a, w] of SCAR.flaps) {                                  // paper tongues pushed down into the hole, in shade
    const r0 = 15 * S, r1 = 4 * S;
    g.beginPath(); g.moveTo(Math.cos(a - w) * r0, Math.sin(a - w) * r0); g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a + w) * r0, Math.sin(a + w) * r0); g.closePath();
    g.fillStyle = '#B9AE9C'; g.fill(); g.lineWidth = .9; g.strokeStyle = 'rgba(43,39,35,.6)'; g.stroke();
  }
  g.restore();
}


// tone block: ink at the equal-density tone, broken up by a paper-coloured grain (world space)
let _gt = null;
function grainPat(g) {
  if (_gt) return _gt;
  const S = 192, c = new OffscreenCanvas(S, S), q = c.getContext('2d'), R = mulberry(77);
  for (let i = 0; i < 2600; i++) { q.fillStyle = `rgba(246,243,236,${.35 + R() * .5})`; const s = .7 + R() * 1.1; q.fillRect(R() * S, R() * S, s, s); }
  return (_gt = c);
}
// the tone is a field of dots whose coverage equals the tone: still "many marks", just too many to count
const _lat = new Map();
function lattice(tone, col) {
  const q = Math.round(clamp(tone) * 20) / 20, key = q + col;
  if (_lat.has(key)) return _lat.get(key);
  const S = 4, PITCH = 7, N = 16, c = new OffscreenCanvas(N * PITCH * S, N * PITCH * S), x = c.getContext('2d'), R = mulberry(5);
  const r = Math.min(3.6, Math.sqrt(q * PITCH * PITCH / Math.PI)) * S;
  x.fillStyle = col;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const cx = (i + .5 + (R() - .5) * .22) * PITCH * S, cy = (j + .5 + (R() - .5) * .22) * PITCH * S, rr = r * (.9 + R() * .2);
    for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) { x.beginPath(); x.arc(cx + ox * N * PITCH * S, cy + oy * N * PITCH * S, rr, 0, Math.PI * 2); x.fill(); }
  }
  _lat.set(key, c); return c;
}
function toneBlock(g, xa, ya, xb, yb, tone, kind) {
  if (xb <= xa) return;
  const pat = g.createPattern(lattice(tone, '#3A3530'), 'repeat'); pat.setTransform(new DOMMatrix().scale(.25));
  g.save(); g.beginPath(); g.rect(xa, ya, xb - xa, yb - ya); g.clip();
  g.fillStyle = pat; g.fillRect(xa, ya, xb - xa, yb - ya);
  g.fillStyle = g.createPattern(grainPat(g), 'repeat'); g.globalAlpha = .35; g.fillRect(xa, ya, xb - xa, yb - ya); g.restore();
}

// every readable text at t (renders into a scratch canvas to collect the registry)
let _scratch = null;
export function texts(t) {
  if (!_scratch) _scratch = new OffscreenCanvas(W, H).getContext('2d');
  REG = []; renderFilm(_scratch, t); const out = REG; REG = null; return out;
}
