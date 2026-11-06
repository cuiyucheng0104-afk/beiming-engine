/* ===== collage-parts.js · reusable physical pieces for the collage kit =====
   All take the kit object (from CL.init) first. Each returns the placed piece (or array). */
(function () {
  const { clamp } = Reel;
  const P = {};
  // ransom-note letters, each on its own magazine chip on foam pads
  const SPEC = [
    { bg: '#161412', fg: '#ffc21f', f: 'S', wt: 900, s: 104, w: 126, h: 136, sides: 'cccc', z: 4.2, gloss: 0.5 },
    { bg: '#ebe4d0', fg: '#d42a1e', f: 'R', wt: 900, s: 112, w: 132, h: 142, sides: 'tctc', z: 5.6, gloss: 0.06, news: true },
    { bg: '#ff5a8c', fg: '#ffffff', f: 'S', wt: 900, s: 94, w: 118, h: 122, sides: 'cccc', z: 3.4, gloss: 0.12, slant: 1 },
    { bg: '#f8f6f0', fg: '#161412', f: 'R', wt: 900, s: 118, w: 136, h: 146, sides: 'tttt', z: 6.2, gloss: 0.55 },
    { bg: '#ffd23a', fg: '#161412', f: 'S', wt: 700, s: 100, w: 122, h: 130, sides: 'cccc', z: 4.0, gloss: 0.45 },
    { bg: '#ef4b3a', fg: '#fff3dc', f: 'R', wt: 700, s: 108, w: 126, h: 136, sides: 'ctcc', z: 5.0, gloss: 0.5 },
    { bg: '#f3ecdc', fg: '#2346cc', f: 'S', wt: 900, s: 116, w: 134, h: 142, sides: 'tttt', z: 4.6, gloss: 0.1, dots: true },
    { bg: '#161412', fg: '#ffffff', f: 'R', wt: 900, s: 122, w: 140, h: 150, sides: 'cccc', z: 6.0, gloss: 0.55, rule: true },
  ];
  // opt: {scale, gap, order (spec indices), t0, dt, from, seed, specs}
  P.ransom = (k, text, cx, y, t0, opt = {}) => {
    const ch = [...text], sc = opt.scale ?? 1, specs = opt.specs || SPEC, order = opt.order || ch.map((_, i) => i);
    const ws = ch.map((_, i) => specs[order[i] % specs.length].w * sc);
    const gap = (opt.gap ?? 8) * sc, tot = ws.reduce((a, b) => a + b, 0) + gap * (ch.length - 1);
    let x = cx - tot / 2; const out = [];
    ch.forEach((c, i) => {
      const sp = specs[order[i] % specs.length], w = sp.w * sc, h = sp.h * sc;
      const ol = k.outline(w, h, { sides: sp.sides, amp: 4 * sc, seed: (opt.seed ?? 40) + i, band: 5 * sc, cj: (sp.slant ? 9 : 4) * sc });
      const font = sp.f === 'S' ? k.SANS : k.SERIF;
      const pc = k.makePiece({ w, h, pad: 12, ol, core: '#f7f5ef', z: sp.z, gloss: sp.gloss, tooth: sp.news ? 0.3 : 0.1, edge: 0.3,
        paint: (g) => {
          g.fillStyle = sp.bg; g.fillRect(-10, -10, w + 20, h + 20);
          if (sp.news) { k.paperTex(g, w, h, { mott: 4, fib: 60, fl: 5 }); k.textBlock(g, 4, 4, w, h, 9 * sc, 12 * sc, 'rgba(40,36,30,.35)'); }
          if (sp.dots) { g.fillStyle = 'rgba(255,72,130,.55)'; for (let yy = 3; yy < h; yy += 6) for (let xx = (yy / 6 % 2) * 3 + 2; xx < w; xx += 6) { g.beginPath(); g.arc(xx, yy, 1.5, 0, 7); g.fill(); } }
          g.fillStyle = sp.fg; g.font = `${sp.wt} ${sp.s * sc}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(c, w / 2, h / 2 + sp.s * sc * 0.05);
          if (sp.rule) { g.fillStyle = '#e8352a'; g.fillRect(10, h - 14 * sc, w - 20, 5 * sc); }
          if (sp.gloss > 0.3) { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, 'rgba(255,255,255,.06)'); gr.addColorStop(1, 'rgba(0,0,0,.05)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
          g.textAlign = 'left';
        } });
      out.push(k.add(pc, x + w / 2, y + (k.hsh(i * 5.1 + (opt.seed ?? 0)) - 0.5) * 26 * sc, (k.hsh(i * 9.3 + (opt.seed ?? 0)) - 0.5) * 0.22, t0 + i * (opt.dt ?? 0.21), Object.assign({ from: [140, -170], frot: 0.18, lift: 75, dur: 0.38 }, opt.o || {})));
      x += w + gap;
    });
    return out;
  };
  // masking tape strip
  P.tape = (k, x, y, r, len, t0, opt = {}) => {
    const w = len, h = opt.h ?? 44, pts = [], rr = k.rr;
    for (let q = 0; q <= 8; q++) pts.push([q / 8 * w, rr(-0.6, 0.6)]);
    for (let q = 0; q <= 7; q++) pts.push([w + (q % 2 ? rr(2, 5) : rr(-3, 0)), q / 7 * h]);
    for (let q = 8; q >= 0; q--) pts.push([q / 8 * w, h + rr(-0.6, 0.6)]);
    for (let q = 7; q >= 0; q--) pts.push([(q % 2 ? rr(-5, -2) : rr(0, 3)), q / 7 * h]);
    const ol = { outer: pts, inner: pts, fib: [] }, col = opt.col || 'rgba(238,226,192,.74)';
    return k.add(k.makePiece({ w, h, pad: 8, ol, z: 0.28, gloss: 0.16, tooth: 0.1,
      paint: (g) => {
        g.fillStyle = col; g.fillRect(-6, -6, w + 12, h + 12);
        if (opt.stripe) { g.fillStyle = opt.stripe; for (let s = -h; s < w; s += 22) { g.beginPath(); g.moveTo(s, h); g.lineTo(s + 11, h); g.lineTo(s + 11 + h, 0); g.lineTo(s + h, 0); g.fill(); } }
        for (let q = 0; q < 70; q++) { g.fillStyle = k.R() < 0.5 ? 'rgba(160,140,100,.08)' : 'rgba(255,255,255,.12)'; g.fillRect(rr(0, w), rr(0, h), rr(8, 40), rr(0.4, 1.1)); }
        g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(0, h * 0.22, w, h * 0.16);
      }, relief: (p) => { p.fillStyle = 'rgb(0,0,0)'; } }), x, y, r, t0, Object.assign({ from: [rr(-120, 120), -200], frot: 0.3, lift: 70, conf: true, dur: 0.33 }, opt.o || {}));
  };
  // Dymo embossed label
  P.dymo = (k, txt, x, y, r, t0, opt = {}) => {
    const g0 = k.g2(k.mkc(4, 4)); g0.font = '700 24px "TeX Gyre Heros Cn"'; let ww = 26; const xs = [];
    for (const c of txt) { xs.push(ww); ww += g0.measureText(c).width + 4.2; } const w = ww + 22, h = 38;
    const ol = { outer: k.roundRect(w, h, 6), inner: [], fib: [] }; ol.inner = ol.outer;
    const c0 = opt.col || ['#d8352d', '#c42820', '#a51d17'];
    return k.add(k.makePiece({ w, h, pad: 10, ol, z: 1.5, gloss: 0.82, tooth: 0.0,
      paint: (g) => {
        const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, c0[0]); gr.addColorStop(0.5, c0[1]); gr.addColorStop(1, c0[2]); g.fillStyle = gr; g.fillRect(0, 0, w, h);
        g.font = '700 24px "TeX Gyre Heros Cn"'; g.textBaseline = 'middle';
        [...txt].forEach((c, q) => { g.fillStyle = `rgba(255,236,232,${0.8 + k.hsh(q) * 0.18})`; g.fillText(c, xs[q], h / 2 + 1 + (k.hsh(q * 3.3) - 0.5) * 1.6); });
      },
      relief: (p) => { p.filter = `blur(${0.9 * k.SS}px)`; p.font = '700 24px "TeX Gyre Heros Cn"'; p.textBaseline = 'middle'; p.fillStyle = `rgb(${Math.round(0.8 * k.ZS)},40,0)`; [...txt].forEach((c, q) => p.fillText(c, xs[q], h / 2 + 1 + (k.hsh(q * 3.3) - 0.5) * 1.6)); p.filter = 'none'; } }),
      x, y, r, t0, Object.assign({ from: [520, 60], frot: 0.1, lift: 90 }, opt.o || {}));
  };
  // typewriter text helper (drawn into a 2D context)
  P.type = (k, g, s, x, y, size, col = [24, 22, 26]) => {
    let q = 0;
    for (const ch of s) { const cj = /[　-鿿＀-￯]/.test(ch); g.font = cj ? `500 ${size - 2}px ${k.SERIF}` : `400 ${size}px "Courier 10 Pitch"`; g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.7 + k.hsh(q * 1.7 + y) * 0.28})`; g.textBaseline = 'alphabetic'; g.fillText(ch, x + (k.hsh(q * 5.3) - 0.5) * 0.6, y + (k.hsh(q * 3.1 + y) - 0.5) * 1.3); x += g.measureText(ch).width + (cj ? 1 : 0); q++; }
    return x;
  };
  // typed slip: lines [[text, size], ...]
  P.slip = (k, lines, x, y, w, h, r, t0, opt = {}) => {
    const ol = k.outline(w, h, { sides: opt.sides || 'cccc', cj: 2, amp: 6, seed: opt.seed ?? 7, band: 4 });
    return k.add(k.makePiece({ w, h, pad: 10, ol, core: opt.core, z: opt.z ?? 1.0, gloss: 0.05, tooth: 0.3, edge: 0.35,
      paint: (g) => {
        g.fillStyle = opt.bg || '#f5f2e8'; g.fillRect(-5, -5, w + 10, h + 10); k.paperTex(g, w, h, { mott: 4, fib: 90, fl: 5 });
        if (opt.ruled !== false) { g.strokeStyle = 'rgba(200,60,50,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 30); g.lineTo(w, 30); g.stroke(); }
        let yy = opt.y0 ?? 24; for (const [s, size, col] of lines) { P.type(k, g, s, opt.x0 ?? 34, yy, size, col); yy += size * 1.5 + 6; }
        if (opt.paint) opt.paint(g, w, h);
      } }), x, y, r, t0, Object.assign({ from: [0, 300], frot: -0.08 }, opt.o || {}));
  };
  // instax-style glossy print of an image/canvas on foam pads
  P.instax = (k, img, x, y, r, t0, opt = {}) => {
    const w = opt.w ?? 360, h = opt.h ?? 290, ih = h * 0.72;
    const ol = { outer: k.roundRect(w, h, 7), inner: [], fib: [] }; ol.inner = ol.outer;
    return k.add(k.makePiece({ w, h, pad: 16, ol, z: 5.5, gloss: 0.32, tooth: 0.06,
      paint: (g) => {
        const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#fbfaf6'); gr.addColorStop(1, '#efede6'); g.fillStyle = gr; g.fillRect(-5, -5, w + 10, h + 10);
        const iw = w - 36; const ar = img.width / img.height, tar = iw / ih; let sw = img.width, sh = img.height, sx = 0, sy = 0;
        if (ar > tar) { sw = img.height * tar; sx = (img.width - sw) / 2; } else { sh = img.width / tar; sy = (img.height - sh) / 2; }
        g.drawImage(img, sx, sy, sw, sh, 18, 18, iw, ih);
        g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(18, 18, iw, 1.2);
        if (opt.cap) { g.fillStyle = 'rgba(30,30,34,.88)'; g.font = `400 ${opt.capSize ?? 30}px "TeX Gyre Chorus"`; g.textBaseline = 'alphabetic'; g.fillText(opt.cap, 30, h - 22); }
        if (opt.capCN) { g.fillStyle = 'rgba(30,30,34,.85)'; g.font = `500 ${opt.capSize ?? 24}px ${k.SERIF}`; g.textBaseline = 'alphabetic'; g.fillText(opt.capCN, 30, h - 24); }
      },
      relief: (p) => { p.fillStyle = 'rgb(0,120,0)'; p.fillRect(18, 18, w - 36, ih); } }), x, y, r, t0, Object.assign({ from: [380, 330], frot: -0.16 }, opt.o || {}));
  };
  // a scissor-cut paper shape from a path function (cut construction paper)
  P.cut = (k, w, h, pathFn, col, x, y, r, t0, opt = {}) => {
    // sample the path into an outline polygon by rasterising a mask and walking its boundary is overkill: pathFn returns points
    const pts = pathFn(w, h).map(([px, py]) => [px + k.rr(-0.4, 0.4), py + k.rr(-0.4, 0.4)]);
    const ol = { outer: pts, inner: pts, fib: [] };
    return k.add(k.makePiece({ w, h, pad: opt.pad ?? 12, ol, z: opt.z ?? 0.8, gloss: opt.gloss ?? 0.03, tooth: opt.tooth ?? 0.62, edge: 0.45, cockle: opt.cockle,
      paint: (g) => { g.fillStyle = col; g.fillRect(-10, -10, w + 20, h + 20); k.paperTex(g, w, h, Object.assign({ mott: 10, ma: 0.05, fib: Math.round(w * h / 400), fl: 7, fc: ['rgba(255,255,255,.2)', 'rgba(0,0,0,.08)'], speck: 6 }, opt.tex || {})); if (opt.paint) opt.paint(g, w, h); },
      relief: opt.relief }), x, y, r, t0, Object.assign({ from: [0, -260], frot: 0.12 }, opt.o || {}));
  };
  // polygon helpers
  P.circle = (n = 72, jit = 1.2) => (w, h) => { const out = []; let kink = 0; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; if (i % 9 === 0) kink = (Reel.hash(i * 3.7 + w) - 0.5) * jit * 2; out.push([w / 2 + Math.cos(a) * (w / 2 + kink), h / 2 + Math.sin(a) * (h / 2 + kink)]); } return out; };
  P.blob = (n, seed, amp = 0.18) => (w, h) => { const out = []; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; const r = 1 + amp * (Reel.noise1(seed + Math.cos(a) * 1.3 + 5) * 0.8 + Reel.noise1(seed * 2 + Math.sin(a) * 2.1) * 0.5); out.push([w / 2 + Math.cos(a) * w / 2 * r * 0.86, h / 2 + Math.sin(a) * h / 2 * r * 0.86]); } return out; };
  window.CP = P;
})();
