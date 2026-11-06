// Page: every frame is Canvas 2D (wall, slates, chalk, sliding cells, wipe, wet streak, light), then a WebGL2 post
// pass (camera motion blur, vignette, grade). window.render(t) depends on t only.
import { clamp, lerp } from '/core/lib.js';
import { bake, drawStroke, n1 } from './chalk.js';
import { installDeposit, grainTile } from './r2d.js';
import { Post } from './post.js';
import { loadSvgFont } from './hand.js';
import { bakeWall, bakeSlate, paintGrid, WALL, PW, BH } from './stage.js';
import { drawFront } from './props.js';

const Q = new URLSearchParams(location.search), W = innerWidth, H = innerHeight;
const cv = document.getElementById('c');
cv.width = W; cv.height = H;
await loadSvgFont('fonts/EMSDelight.svg');
await loadSvgFont('fonts/EMSCasualHand.svg', 'child');
installDeposit();

if (Q.has('lab')) { await import('./lab.js').then(m => m.run(cv, W, H, Q)); }
else {
  const { build } = await import('./film.js');
  const F = build(W, H);
  for (const s of F.S) bake(s, s.o.R || 2);
  window.DUR = F.DUR; window.EV = F.EV;

  // ───────── static pictures: wall, two fixed panels (seam at x 3200), the painted grids for the lesson's name
  const WALLI = bakeWall();
  const FL = bakeSlate(PW, BH, 81, true), FR = bakeSlate(PW, BH, 71, true);
  { const c = FR.cv.getContext('2d'); c.save(); c.translate(-PW, 0); for (const g of F.GRIDS) paintGrid(c, g.x, g.y, g.size); c.restore(); }
  const TILE = grainTile();

  // ───────── cells: each one a sprite cut from the finished orange fill of its square (board units, centred)
  const CELL_R = 2;
  for (const c of F.CELLS) {
    const half = F.U / 2, m = 6, sz = Math.ceil((F.U + 2 * m) * CELL_R);
    const o = new OffscreenCanvas(sz, sz), x = o.getContext('2d');
    x.scale(CELL_R, CELL_R); x.translate(half + m - c.src[0], half + m - c.src[1]);
    x.beginPath(); x.rect(c.src[0] - half + F.GAP, c.src[1] - half + F.GAP, F.U - 2 * F.GAP, F.U - 2 * F.GAP); x.clip();
    for (const s of F.S) if (s.fill === c.from) drawStroke(x, s, 1e9);
    c.sprite = o; c.sp = { w: (F.U + 2 * m), half: half + m };
  }

  const post = new Post(cv, W, H);
  const main = new OffscreenCanvas(W, H), mx = main.getContext('2d');
  const la = new OffscreenCanvas(W, H), lx = la.getContext('2d');
  const PAT = mx.createPattern(TILE, 'repeat');
  const KS = W / 1920;
  const view = c0 => { const c = { ...c0, s: c0.s * KS }; return { ...c, m: [c.s, 0, 0, c.s, W / 2 - c.cx * c.s, H / 2 - c.cy * c.s], toScreen: (x, y) => [W / 2 + (x - c.cx) * c.s, H / 2 + (y - c.cy) * c.s], W, H }; };

  // ───────── the wet streak: a low-res wetness map along the cloth's path (baked once). A pixel is wet once the
  // cloth has passed it; it dries back as a threshold rises through the wetness, edges and thin parts first.
  const WT = F.wet, WS = 8;                                   // board units per map pixel
  const WMW = Math.ceil((WT.box[2] - WT.box[0]) / WS), WMH = Math.ceil((WT.box[3] - WT.box[1]) / WS);
  const WMAP = new Float32Array(WMW * WMH), WPASS = new Float32Array(WMW * WMH).fill(1e9);
  {
    const P = F.wipe.path, cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const L = cum[cum.length - 1], r = F.wipe.w / 2;
    for (let j = 0; j < WMH; j++) for (let i = 0; i < WMW; i++) {
      const x = WT.box[0] + (i + .5) * WS, y = WT.box[1] + (j + .5) * WS;
      let best = 1e9, bs = 0;
      for (let k = 0; k < P.length - 1; k++) {
        const ax = P[k][0], ay = P[k][1], dx = P[k + 1][0] - ax, dy = P[k + 1][1] - ay, ll = dx * dx + dy * dy || 1;
        const u = clamp(((x - ax) * dx + (y - ay) * dy) / ll), d = Math.hypot(x - ax - dx * u, y - ay - dy * u);
        if (d < best) { best = d; bs = cum[k] + u * Math.sqrt(ll); }
      }
      if (best > r * 1.05) continue;
      const q = j * WMW + i, core = 1 - Math.pow(best / (r * 1.05), 2);                      // wettest along the cloth's centre
      const nz = .62 * n1(x / 90 + n1(y / 70, 2) * 2.5, 1) + .38 * n1(x / 31 + y / 47, 5);  // uneven moisture
      WMAP[q] = clamp(core * .7 + nz * .45 * clamp(core * 2.5) - .08);                     // the noise fades out at the band's edge
      WPASS[q] = F.wipe.t0 + (F.wipe.t1 - F.wipe.t0) * bs / L;
    }
  }
  const wetC = new OffscreenCanvas(WMW, WMH), wcx = wetC.getContext('2d'), wimg = wcx.createImageData(WMW, WMH);
  const wetL = new OffscreenCanvas(W, H), wlx = wetL.getContext('2d');
  function drawWet(ctx, t, v) {
    if (t < F.wipe.t0 || t > WT.t1 + .2) return;
    const th = lerp(-.05, 1.08, Math.pow(clamp((t - WT.t0) / (WT.t1 - WT.t0)), .85));     // the drying threshold
    const d = wimg.data;
    for (let q = 0; q < WMAP.length; q++) {
      const w = WMAP[q]; let a = 0;
      if (w > 0 && t >= WPASS[q]) { const e = (w - th) / .22; a = e <= 0 ? 0 : e >= 1 ? 1 : e * e * (3 - 2 * e); a *= clamp((t - WPASS[q]) / .06); }
      d[4 * q] = 0; d[4 * q + 1] = 12; d[4 * q + 2] = 7; d[4 * q + 3] = Math.round(a * 255);
    }
    wcx.putImageData(wimg, 0, 0);
    wlx.setTransform(1, 0, 0, 1, 0, 0); wlx.clearRect(0, 0, W, H);
    wlx.setTransform(...v.m); wlx.filter = `blur(${Math.max(4, 30 * v.s)}px)`; wlx.imageSmoothingQuality = 'high';
    wlx.drawImage(wetC, WT.box[0], WT.box[1], WMW * WS, WMH * WS); wlx.filter = 'none';
    // the damp paint: darker, with a faint cool sheen from the window, strongest near the top of the board
    wlx.setTransform(1, 0, 0, 1, 0, 0); wlx.globalCompositeOperation = 'source-in';
    const [, gy0] = v.toScreen(0, 0), [, gy1] = v.toScreen(0, BH);
    const g = wlx.createLinearGradient(0, gy0, 0, gy1); g.addColorStop(0, 'rgba(14,30,24,.62)'); g.addColorStop(.5, 'rgba(0,10,6,.5)'); g.addColorStop(1, 'rgba(0,10,6,.42)');
    wlx.fillStyle = g; wlx.fillRect(0, 0, W, H); wlx.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(wetL, 0, 0); ctx.restore();
  }

  const wipePath = t => {
    const w = F.wipe; if (t <= w.t0) return null;
    const P = w.path, n = Math.max(2, Math.round(P.length * clamp((t - w.t0) / (w.t1 - w.t0))));
    const p = new Path2D(); P.slice(0, n).forEach(([x, y], i) => i ? p.lineTo(x, y) : p.moveTo(x, y));
    return p;
  };

  // a cell at time t: position, angle, lift (scale), and a short smear along its motion
  function drawCell(ctx, c, t) {
    const st = F.cellAt(c, t);
    if (st.ghost > 0) {                                        // a thin, even haze where it was (it has been lifted off)
      ctx.save(); ctx.globalAlpha = .07 * st.ghost; ctx.translate(c.src[0], c.src[1]);
      ctx.drawImage(c.sprite, -c.sp.half, -c.sp.half, c.sp.w, c.sp.w); ctx.restore();
    }
    const draw = (x, y, a, k, al) => {
      ctx.save(); ctx.globalAlpha = al; ctx.translate(x, y); ctx.rotate(a); ctx.scale(k, k);
      ctx.drawImage(c.sprite, -c.sp.half, -c.sp.half, c.sp.w, c.sp.w); ctx.restore();
    };
    if (st.moving) {
      const p = F.cellAt(c, t - 1 / 60), sp = Math.hypot(st.x - p.x, st.y - p.y);
      if (sp > 4) for (let i = 3; i >= 1; i--) { const u = i / 4; draw(lerp(st.x, p.x, u * 1.6), lerp(st.y, p.y, u * 1.6), lerp(st.a, p.a, u), st.k, .16); }
    }
    draw(st.x, st.y, st.a, st.k, 1);
  }

  function frame(t) {
    const c = F.camAt(t), v = view(c);
    mx.setTransform(1, 0, 0, 1, 0, 0); mx.globalCompositeOperation = 'source-over'; mx.globalAlpha = 1; mx.filter = 'none';
    mx.fillStyle = '#000'; mx.fillRect(0, 0, W, H);
    mx.setTransform(...v.m); mx.imageSmoothingQuality = 'high';
    mx.drawImage(WALLI.cv, WALL[0], WALL[1], WALL[2], WALL[3]);
    mx.drawImage(FL.cv, -FL.m, 0, FL.cv.width, BH);
    mx.drawImage(FR.cv, PW - FR.m, 0, FR.cv.width, BH);
    drawWet(mx, t, v);
    // the proof: its own layer, so the one wipe can take it off the slate
    lx.setTransform(1, 0, 0, 1, 0, 0); lx.clearRect(0, 0, W, H); lx.filter = 'none'; lx.globalCompositeOperation = 'source-over'; lx.globalAlpha = 1;
    lx.setTransform(...v.m); lx.imageSmoothingQuality = 'high';
    const cellsOn = t >= F.T.cells;
    for (const s of F.S) {
      if (!s.wiped || t <= s.t0 || (cellsOn && s.fill)) continue;
      if (s.fill) { const r = F.SQ[s.fill]; lx.save(); lx.beginPath(); lx.rect(r[0] + 6, r[1] + 6, r[2] - r[0] - 12, r[3] - r[1] - 12); lx.clip(); drawStroke(lx, s, t); lx.restore(); }
      else drawStroke(lx, s, t);
    }
    if (cellsOn) { for (const cl of F.CELLS) if (!F.cellAt(cl, t).moving) drawCell(lx, cl, t); for (const cl of F.CELLS) if (F.cellAt(cl, t).moving) drawCell(lx, cl, t); }
    const hp = wipePath(t);
    if (hp) {
      lx.globalCompositeOperation = 'destination-out'; lx.filter = `blur(${Math.max(1, 22 * v.s)}px)`; lx.lineCap = 'round'; lx.lineJoin = 'round'; lx.lineWidth = F.wipe.w; lx.strokeStyle = '#000';
      lx.stroke(hp); lx.globalCompositeOperation = 'source-over'; lx.filter = 'none';
    }
    mx.setTransform(1, 0, 0, 1, 0, 0); mx.drawImage(la, 0, 0);
    if (hp) {                                                  // the cloth leaves a very thin, even haze
      mx.save(); mx.setTransform(...v.m); mx.filter = `blur(${Math.max(1, 14 * v.s)}px)`;
      mx.strokeStyle = 'rgba(160,176,168,.022)'; mx.lineCap = 'round'; mx.lineJoin = 'round'; mx.lineWidth = F.wipe.w * .9; mx.stroke(hp); mx.restore();
    }
    // the conclusion, kept
    mx.setTransform(...v.m);
    for (const s of F.S) if (!s.wiped && t > s.t0) drawStroke(mx, s, t);
    // slate micro grain where it can be seen
    if (v.s / KS > .6) {
      mx.save(); mx.beginPath(); mx.rect(0, 0, 6400, BH); mx.clip();
      PAT.setTransform(new DOMMatrix([.25, 0, 0, .25, 0, 0])); mx.globalCompositeOperation = 'soft-light'; mx.globalAlpha = Math.min(.2, (v.s / KS - .6) * .3);
      mx.fillStyle = PAT; mx.fillRect(0, 0, 6400, BH); mx.restore();
    }
    // afternoon light from the windows on the left: a soft falloff and a faint warm patch low on the left
    mx.save(); mx.setTransform(...v.m);
    const lg = mx.createLinearGradient(-1500, 0, 7900, 0); lg.addColorStop(0, 'rgb(255,250,240)'); lg.addColorStop(.45, 'rgb(236,236,232)'); lg.addColorStop(1, 'rgb(196,198,200)');
    mx.globalCompositeOperation = 'multiply'; mx.fillStyle = lg; mx.fillRect(-1500, -1500, 9400, 4900);
    mx.globalCompositeOperation = 'screen'; mx.filter = `blur(${Math.max(3, 40 * v.s)}px)`;
    const pane = (x, y, w, h, a) => { mx.fillStyle = `rgba(255,212,150,${a})`; mx.beginPath(); mx.moveTo(x, y); mx.lineTo(x + w, y + w * .28); mx.lineTo(x + w, y + w * .28 + h); mx.lineTo(x, y + h); mx.closePath(); mx.fill(); };
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) pane(-260 + i * 400, 1060 + j * 330 + i * 400 * .28, 360, 300, .06 - i * .016);
    mx.restore();
    // the chalk's front: a few bright grains where the writing is now (no glow)
    for (const s of F.S) {
      if (t <= s.t0 || t >= s.t1 || s.kind === 'side') continue;
      const p = s.at(s.prog(t) * s.len);
      drawFront(mx, t, v, p[0], p[1], s.color, Math.min(s.w, 9), .5);
    }
    return c;
  }

  window.render = t => {
    const c = frame(t);
    const tp = t - .5 / 30, pc = F.camAt(tp), k = pc.s / c.s;
    const bl = [k, 0, 0, 0, k, 0, W / 2 - k * W / 2 + pc.s * KS * (c.cx - pc.cx), H / 2 - k * H / 2 + pc.s * KS * (c.cy - pc.cy), 1];
    post.draw(main, bl, t, .3);
  };
  window.TEXTS = t => {
    const v = view(F.camAt(t)), out = [];
    for (const q of F.TX) {
      if (t < q.t0 || t >= q.t1) continue;
      const [a, b] = v.toScreen(q.box[0], q.box[1]), [d, e] = v.toScreen(q.box[2], q.box[3]);
      out.push({ id: q.id, text: q.text, x0: a, y0: b, x1: d, y1: e });
    }
    return out;
  };
  window.F = F;
  window.render(+(Q.get('t') || 0));
}
window.READY = true;
