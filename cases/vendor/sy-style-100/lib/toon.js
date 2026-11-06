/* ===== toon.js · classic theatrical-cartoon toolkit (cel + painted background + film) =====
   Ink lines with thick/thin variation, cel shade crescents, tapered brush strokes, eyes/mouths/limbs,
   gouache background helpers, and a film finish (grain, gate weave, flicker, vignette). Needs core.js. */
(function () {
  const { clamp, lerp, E, hash, noise2 } = Reel;
  const T = {};
  T.LINE = '#1e1411';

  // ---------- keyframe track: keys [[t, v, ease?]] (ease shapes the segment arriving at that key) ----------
  T.trk = (t, keys) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const k = keys[i];
      if (t <= k[0]) { const p = keys[i - 1]; const u = (t - p[0]) / Math.max(1e-6, k[0] - p[0]); return lerp(p[1], k[1], (k[2] || E.inOutSine)(clamp(u))); }
    }
    return keys[keys.length - 1][1];
  };
  T.on2 = (t, fps = 15) => Math.floor(t * fps + 1e-6) / fps;   // animate "on twos"

  // ---------- paths ----------
  T.smooth = (pts, p = new Path2D()) => {
    const n = pts.length;
    p.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2);
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); }
    p.closePath(); return p;
  };
  // blob: ellipse with radius modulation r(θ) (θ=0 → +x, θ=π/2 → +y i.e. down)
  T.blob = (cx, cy, rx, ry, rf = null, n = 48, rot = 0) => {
    const pts = [], c = Math.cos(rot), s = Math.sin(rot);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, m = rf ? rf(a, i) : 1;
      const x = Math.cos(a) * rx * m, y = Math.sin(a) * ry * m;
      pts.push([cx + x * c - y * s, cy + x * s + y * c]);
    }
    return T.smooth(pts);
  };
  T.ell = (cx, cy, rx, ry, rot = 0) => { const p = new Path2D(); p.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2); return p; };
  T.poly = (pts, close = true) => { const p = new Path2D(); p.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]); if (close) p.closePath(); return p; };
  T.rrect = (x, y, w, h, r) => { const p = new Path2D(); p.roundRect(x, y, w, h, r); return p; };
  T.bez = (a, b, c, d, n = 16) => { const o = []; for (let i = 0; i <= n; i++) { const u = i / n, v = 1 - u; o.push([v * v * v * a[0] + 3 * v * v * u * b[0] + 3 * v * u * u * c[0] + u * u * u * d[0], v * v * v * a[1] + 3 * v * v * u * b[1] + 3 * v * u * u * c[1] + u * u * u * d[1]]); } return o; };
  T.qbez = (a, b, c, n = 14) => { const o = []; for (let i = 0; i <= n; i++) { const u = i / n, v = 1 - u; o.push([v * v * a[0] + 2 * v * u * b[0] + u * u * c[0], v * v * a[1] + 2 * v * u * b[1] + u * u * c[1]]); } return o; };
  // tube around a polyline, width profile wf(u) → closed path (limbs, tails, steam, brush strokes)
  T.tube = (pts, wf) => {
    const L = [], R = [], n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const w = wf(i / (n - 1)) / 2;
      L.push([pts[i][0] - dy * w, pts[i][1] + dx * w]); R.push([pts[i][0] + dy * w, pts[i][1] - dx * w]);
    }
    const p = new Path2D();
    p.moveTo(L[0][0], L[0][1]); for (let i = 1; i < n; i++) p.lineTo(L[i][0], L[i][1]);
    // round end caps
    const e = pts[n - 1], we = wf(1) / 2; if (we > 0.5) { const a0 = Math.atan2(L[n - 1][1] - e[1], L[n - 1][0] - e[0]); p.arc(e[0], e[1], we, a0, a0 - Math.PI, true); }
    for (let i = n - 1; i >= 0; i--) p.lineTo(R[i][0], R[i][1]);
    const s = pts[0], ws = wf(0) / 2; if (ws > 0.5) { const a0 = Math.atan2(R[0][1] - s[1], R[0][0] - s[0]); p.arc(s[0], s[1], ws, a0, a0 - Math.PI, true); }
    p.closePath(); return p;
  };
  // tapered ink stroke (brows, smile lines, action lines)
  T.taper = (ctx, pts, w, col = T.LINE, prof = (u) => Math.sin(Math.PI * clamp(u * 0.92 + 0.04))) => {
    ctx.fillStyle = col; ctx.fill(T.tube(pts, (u) => w * prof(u)));
  };

  // ---------- cel ink: thick/thin outline, flat fill, shade crescent, highlight ----------
  // o: { fill, shade, sh:[dx,dy] (shift of lit area, i.e. shade grows on the opposite side), lw, hi, hiSh, noLine }
  T.ink = (ctx, path, o) => {
    const lw = o.lw ?? 5;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (!o.noLine) {
      ctx.save(); ctx.strokeStyle = T.LINE; ctx.lineWidth = lw * 1.15; ctx.translate(lw * 0.32, lw * 0.42); ctx.stroke(path); ctx.restore();
    }
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(path); }
    if (o.shade) {
      const sh = o.sh || [-12, -14];
      ctx.save(); ctx.clip(path); ctx.fillStyle = o.shade; ctx.fill(path);
      ctx.translate(sh[0], sh[1]); ctx.fillStyle = o.fill; ctx.fill(path); ctx.restore();
    }
    if (o.hi) {
      const hs = o.hiSh || [10, 12];
      ctx.save(); ctx.clip(path); ctx.fillStyle = o.hi; ctx.fill(path); ctx.translate(hs[0], hs[1]); ctx.fillStyle = o.fill; ctx.globalCompositeOperation = 'source-over';
      // re-fill: highlight only on the upper-left rim
      ctx.restore();
    }
    if (!o.noLine) { ctx.strokeStyle = T.LINE; ctx.lineWidth = lw * 0.72; ctx.stroke(path); }
  };
  T.line = (ctx, path, lw = 4) => { ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = T.LINE; ctx.lineWidth = lw; ctx.stroke(path); };
  T.ptsPath = (pts) => { const p = new Path2D(); p.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]); return p; };

  // ---------- eyes ----------
  // e: { x, y, rx, ry, open (0..1), px, py (pupil -1..1), ps (pupil scale), lid (colour), happy (closed ^), sleepy (closed ‿), spark }
  T.eye = (ctx, e) => {
    const { x, y, rx, ry } = e;
    const open = clamp(e.open ?? 1);
    if (open < 0.06) {
      // closed: sleepy (droopy arc + lashes) or happy (^)
      const pts = e.happy ? T.qbez([x - rx, y + ry * 0.15], [x, y - ry * 0.75], [x + rx, y + ry * 0.15]) : T.qbez([x - rx, y], [x, y + ry * 0.55], [x + rx, y]);
      T.taper(ctx, pts, Math.max(5, rx * 0.32));
      if (!e.happy) for (let k = 0; k < 2; k++) { const u = 0.62 + k * 0.28, b = pts[Math.round(u * (pts.length - 1))]; T.taper(ctx, [b, [b[0] + rx * 0.18, b[1] + ry * 0.32]], 3.2); }
      return;
    }
    const P = T.ell(x, y, rx, ry);
    T.ink(ctx, P, { fill: '#fffdf6', lw: Math.max(3, rx * 0.17) });
    ctx.save(); ctx.clip(P);
    const ps = e.ps ?? 1, pr = rx * 0.52 * ps;
    const px = x + (e.px || 0) * rx * 0.42, py = y + (e.py || 0) * ry * 0.4 + ry * 0.12;
    ctx.fillStyle = '#16100d'; ctx.fill(T.ell(px, py, pr, pr * 1.18));
    ctx.fillStyle = '#ffffff'; ctx.fill(T.ell(px - pr * 0.35, py - pr * 0.45, pr * 0.32, pr * 0.36));
    if (e.spark) { ctx.fill(T.ell(px + pr * 0.38, py + pr * 0.42, pr * 0.16, pr * 0.16)); }
    // upper lid
    if (open < 0.999) {
      const ly = y - ry + (1 - open) * ry * 2.05;
      ctx.fillStyle = e.lid || '#8a5a3c';
      const lp = new Path2D(); lp.moveTo(x - rx * 1.3, y - ry * 1.4); lp.lineTo(x + rx * 1.3, y - ry * 1.4); lp.lineTo(x + rx * 1.3, ly - ry * 0.1); lp.quadraticCurveTo(x, ly + ry * 0.28, x - rx * 1.3, ly - ry * 0.1); lp.closePath();
      ctx.fill(lp);
      ctx.restore();
      ctx.save(); ctx.clip(P); T.taper(ctx, T.qbez([x - rx * 1.05, ly - ry * 0.06], [x, ly + ry * 0.24], [x + rx * 1.05, ly - ry * 0.06]), Math.max(3.4, rx * 0.2), T.LINE, () => 1);
    }
    ctx.restore();
  };

  // ---------- mouth (origin = centre of mouth line) ----------
  // m: { w, open (0..1+), smile (-1..1), round (0..1 → "O"), tongue, teeth, col }
  T.mouth = (ctx, x, y, m) => {
    const w = m.w, open = m.open || 0, sm = m.smile || 0, rd = m.round || 0;
    if (open < 0.04) {
      T.taper(ctx, T.qbez([x - w / 2, y - sm * w * 0.12], [x, y + sm * w * 0.32], [x + w / 2, y - sm * w * 0.12]), Math.max(4, w * 0.11));
      if (sm > 0.3) { // smile corners
        T.taper(ctx, [[x + w / 2 - 2, y - sm * w * 0.12 - 6], [x + w / 2 + 4, y - sm * w * 0.12 + 4]], 4);
      }
      return;
    }
    const hw = lerp(w / 2, w * 0.28, rd), h = open * w * 0.9;
    const p = new Path2D();
    const yc = y - sm * w * 0.1;
    p.moveTo(x - hw, yc);
    p.bezierCurveTo(x - hw * 0.5, y - h * 0.18 * (1 - sm) + sm * 4 - rd * h * 0.35, x + hw * 0.5, y - h * 0.18 * (1 - sm) + sm * 4 - rd * h * 0.35, x + hw, yc);
    p.bezierCurveTo(x + hw * (1 + rd * 0.2), yc + h * 0.85, x - hw * (1 + rd * 0.2), yc + h * 0.85, x - hw, yc);
    p.closePath();
    T.ink(ctx, p, { fill: '#5a1a1c', lw: Math.max(4, w * 0.09) });
    ctx.save(); ctx.clip(p);
    if (m.tongue !== false) { ctx.fillStyle = '#e0605e'; ctx.fill(T.ell(x + hw * 0.1, yc + h * 0.66, hw * 0.62, h * 0.32)); ctx.fillStyle = '#c84a4c'; ctx.fillRect(x + hw * 0.08 - 1.5, yc + h * 0.42, 3, h * 0.3); }
    if (m.teeth) { ctx.fillStyle = '#fffaf0'; ctx.fill(T.rrect(x - hw * 0.62, yc - h * 0.2, hw * 1.24, Math.min(h * 0.24, 22), 4)); }
    ctx.restore();
    ctx.strokeStyle = T.LINE; ctx.lineWidth = Math.max(3.5, w * 0.075); ctx.lineJoin = 'round'; ctx.stroke(p);
  };

  // ---------- limb: shoulder → (bend) → hand, as an inked tube ----------
  T.limb = (ctx, a, c, b, w0, w1, o) => {
    const pts = T.qbez(a, c, b, 14);
    T.ink(ctx, T.tube(pts, (u) => lerp(w0, w1, u)), o);
  };

  // ---------- text: cartoon title lettering (fill + thick outline + drop) ----------
  T.letter = (ctx, s, x, y, { size = 120, fill = '#fff3d6', line = '#3a1f14', drop = 'rgba(30,15,8,.55)', lw = 0.16, font = '"Noto Sans CJK SC"', weight = 900, rot = 0, sx = 1, sy = 1, align = 'center', alpha = 1 } = {}) => {
    ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sx, sy);
    ctx.font = `${weight} ${size}px ${font}`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.fillStyle = drop; ctx.strokeStyle = drop; ctx.lineWidth = size * lw; ctx.strokeText(s, size * 0.05, size * 0.07); ctx.fillText(s, size * 0.05, size * 0.07);
    ctx.strokeStyle = line; ctx.lineWidth = size * lw; ctx.strokeText(s, 0, 0);
    ctx.fillStyle = fill; ctx.fillText(s, 0, 0);
    ctx.restore();
  };

  // ---------- painted background helpers (run once in setup) ----------
  // mottled gouache texture (grey, centred on 128) for multiply/overlay
  T.paintTex = (w, h, seed = 1, { blot = 0.5, grain = 0.5, streak = 0.4, sc = 1 } = {}) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    const im = g.createImageData(w, h), d = im.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = x / sc, Y = y / sc;
      let v = noise2(X * 0.012 + seed, Y * 0.012) * 0.55 + noise2(X * 0.035 + seed * 3, Y * 0.035) * 0.3 + noise2(X * 0.09, Y * 0.09 + seed) * 0.15;
      v *= blot;
      v += (hash(x * 0.913 + y * 71.7 + seed) - 0.5) * 0.35 * grain;
      v += noise2(X * 0.004 + seed, Y * 0.22) * 0.25 * streak; // dry-brush streaks (horizontal)
      const q = 128 + v * 60;
      const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = q; d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0); return c;
  };
  // fill a path with a vertical gradient + soft darker edge (gouache wash look)
  T.wash = (ctx, path, top, bot, { edge = 0.22, edgeW = 10, y0 = 0, y1 = 1080, blur = 6 } = {}) => {
    const gr = ctx.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, top); gr.addColorStop(1, bot || top);
    ctx.fillStyle = gr; ctx.fill(path);
    if (edge > 0) {
      ctx.save(); ctx.clip(path); ctx.globalAlpha = edge; ctx.filter = `blur(${blur * (ctx.getTransform().a)}px)`;
      ctx.strokeStyle = 'rgba(40,20,10,1)'; ctx.lineWidth = edgeW; ctx.globalCompositeOperation = 'multiply'; ctx.stroke(path);
      ctx.restore();
    }
  };

  // ---------- film finish ----------
  T.film = (W, H) => {
    const grains = [];
    for (let k = 0; k < 6; k++) {
      const c = document.createElement('canvas'); c.width = W >> 1; c.height = H >> 1;
      const g = c.getContext('2d', { willReadFrequently: true }); const im = g.createImageData(c.width, c.height), d = im.data;
      for (let i = 0; i < d.length; i += 4) { const v = 128 + (hash(i * 0.37 + k * 911.3) - 0.5) * 120; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      g.putImageData(im, 0, 0); grains.push(c);
    }
    return {
      weave(t) { const f = Math.floor(t * 24); return [(hash(f * 1.7) - 0.5) * 2.2, (hash(f * 3.1 + 5) - 0.5) * 2.6]; },
      flicker(t) { return 1 + (hash(Math.floor(t * 24) * 7.7) - 0.5) * 0.035; },
      finish(ctx, t, { vig = 0.42, grain = 0.09, warm = 0.06, dust = true } = {}) {
        const f = Math.floor(t * 24);
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        const w = ctx.canvas.width, h = ctx.canvas.height;
        if (warm) { ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = warm * 4; ctx.fillStyle = '#ffb060'; ctx.fillRect(0, 0, w, h); }
        ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = grain; ctx.drawImage(grains[f % grains.length], 0, 0, w, h);
        ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 1;
        const vg = ctx.createRadialGradient(w / 2, h * 0.48, h * 0.35, w / 2, h / 2, h * 0.98);
        vg.addColorStop(0, 'rgba(255,255,255,1)'); vg.addColorStop(1, `rgba(${255 * (1 - vig) | 0},${235 * (1 - vig) | 0},${210 * (1 - vig) | 0},1)`);
        ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
        // dust specks / hairline scratches, a few frames only
        ctx.globalCompositeOperation = 'source-over';
        const n = dust ? Math.floor(hash(f * 13.1) * 3) : 0;
        for (let i = 0; i < n; i++) {
          const x = hash(f * 5.3 + i) * w, y = hash(f * 9.1 + i * 3) * h, r = (0.6 + hash(f + i * 7) * 1.6) * (w / 1920) * 2;
          ctx.fillStyle = hash(f * 2 + i) < 0.7 ? 'rgba(25,15,10,.55)' : 'rgba(255,250,235,.6)';
          ctx.beginPath(); ctx.ellipse(x, y, r, r * (0.5 + hash(i + f)), hash(f * i), 0, 7); ctx.fill();
        }
        if (dust && hash(f * 0.71) < 0.12) { const x = hash(f * 4.4) * w; ctx.fillStyle = 'rgba(255,248,230,.18)'; ctx.fillRect(x, 0, Math.max(1, w / 1600), h); }
        ctx.restore();
      },
    };
  };

  // iris (black frame with a round hole)
  T.iris = (ctx, cx, cy, r, W = 1920, H = 1080) => {
    if (r > 2400) return;
    const p = new Path2D(); p.rect(-50, -50, W + 100, H + 100); if (r > 0.5) p.arc(cx, cy, r, 0, Math.PI * 2, true);
    ctx.fillStyle = '#0c0807'; ctx.fill(p, 'evenodd');
  };

  // puffy dust / smoke cloud (cartoon), cel inked
  T.puff = (ctx, x, y, r, seed, a = 1, col = '#e9dcc4', sh = '#c9b493') => {
    if (r < 1 || a <= 0) return;
    ctx.save(); ctx.globalAlpha *= a;
    const p = T.blob(x, y, r, r * 0.86, (ang, i) => 1 + 0.14 * Math.sin(ang * 5 + seed * 3) + 0.06 * Math.sin(ang * 9 + seed), 40);
    T.ink(ctx, p, { fill: col, shade: sh, sh: [-r * 0.22, -r * 0.26], lw: Math.max(2.5, r * 0.07) });
    ctx.restore();
  };

  window.Toon = T;
})();
