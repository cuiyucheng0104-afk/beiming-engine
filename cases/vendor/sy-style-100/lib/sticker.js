/* ===== sticker.js · vinyl sticker kit (from styles/07-sticker) =====
   ST.make(draw, w, h, border) -> sticker sprite (die-cut white border, silhouette for shadow/gloss)
   ST.draw(ctx, st, t, K)       -> slap-down animation with lift shadow, squash and a gloss sweep
   Art helpers: ST.emoji, ST.label, ST.num, ST.note, ST.burst, ST.title, ST.img (custom). */
(function () {
  const { E, clamp, lerp } = Reel;
  const SANS = '"Noto Sans CJK SC"';
  const S = {};
  let K = 1;
  S.setK = (k) => { K = k; };
  S.make = (drawFn, w, h, border = 18) => {
    const pad = border + 6;
    const c = document.createElement('canvas'); c.width = Math.round((w + pad * 2) * K); c.height = Math.round((h + pad * 2) * K);
    const g = c.getContext('2d'); g.scale(K, K); g.translate(pad, pad);
    const art = document.createElement('canvas'); art.width = c.width; art.height = c.height;
    const a = art.getContext('2d'); a.scale(K, K); a.translate(pad, pad); drawFn(a, w, h);
    const sil = document.createElement('canvas'); sil.width = c.width; sil.height = c.height;
    const s = sil.getContext('2d'); s.drawImage(art, 0, 0); s.globalCompositeOperation = 'source-in'; s.fillStyle = '#ffffff'; s.fillRect(0, 0, c.width, c.height);
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (border > 0) {
      for (let i = 0; i < 24; i++) { const an = i / 24 * Math.PI * 2; g.drawImage(sil, Math.cos(an) * border * K, Math.sin(an) * border * K); }
      for (let i = 0; i < 12; i++) { const an = i / 12 * Math.PI * 2; g.drawImage(sil, Math.cos(an) * border * 0.5 * K, Math.sin(an) * border * 0.5 * K); }
    }
    g.drawImage(art, 0, 0);
    const all = document.createElement('canvas'); all.width = c.width; all.height = c.height;
    const al = all.getContext('2d'); al.drawImage(c, 0, 0); al.globalCompositeOperation = 'source-in'; al.fillStyle = '#000'; al.fillRect(0, 0, c.width, c.height);
    return { c, all, w: w + pad * 2, h: h + pad * 2 };
  };
  S.emoji = (em, size) => (g, w, h) => { g.font = `${size}px "Noto Color Emoji"`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(em, w / 2, h / 2 + size * 0.06); };
  S.label = (txt, bg, fg, size, font = SANS) => (g, w, h) => { g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, w, h, h / 2); g.fill(); g.fillStyle = fg; g.font = `900 ${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, w / 2, h / 2 + 2); };
  S.num = (n, bg) => (g, w, h) => { g.fillStyle = bg; g.beginPath(); g.arc(w / 2, h / 2, w / 2, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = `900 ${w * 0.62}px Inter`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), w / 2, h / 2 + 3); };
  S.title = (txt, bg = '#ffde4a', fg = '#1b1b1b', r = 26) => (g, w, h) => { g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, w, h, r); g.fill(); g.fillStyle = fg; g.font = `900 ${h * 0.56}px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, w / 2, h / 2 + 4); };
  S.burst = (txt, bg = '#ff4d2e', fg = '#fff6d6', fs = 0.2) => (g, w, h) => {
    g.fillStyle = bg; g.beginPath();
    for (let i = 0; i < 28; i++) { const a = i / 28 * Math.PI * 2, r = (i % 2 ? 0.78 : 1) * w / 2; g.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r * (h / w)); }
    g.fill(); g.fillStyle = fg; g.font = `900 ${w * fs}px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    txt.split('\n').forEach((l, i, a) => g.fillText(l, w / 2, h / 2 + 6 + (i - (a.length - 1) / 2) * w * fs * 1.15));
  };
  S.note = (txt, bg = '#fff3a3', size = 46, font = '"Noto Serif CJK SC"') => (g, w, h) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(0,0,0,.06)'; g.fillRect(0, 0, w, 26);
    g.fillStyle = '#2b2b2b'; g.font = `700 ${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    txt.split('\n').forEach((l, i, a) => g.fillText(l, w / 2, h / 2 + 10 + (i - (a.length - 1) / 2) * size * 1.35));
  };
  S.round = (txt, sub, bg, fg = '#fff') => (g, w, h) => { g.fillStyle = bg; g.beginPath(); g.arc(w / 2, h / 2, w / 2, 0, 7); g.fill(); g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 6; g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 16, 0, 7); g.stroke();
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `900 ${w * 0.2}px ${SANS}`; g.fillText(txt, w / 2, h / 2 - (sub ? w * 0.06 : 0)); if (sub) { g.font = `700 ${w * 0.085}px ${SANS}`; g.fillText(sub, w / 2, h / 2 + w * 0.15); } };
  let glossC = null;
  // st: { s, x, y, rot, t0, land?, from? }  (world units; ctx already transformed)
  S.draw = (ctx, st, t, opt = {}) => {
    const u = t - st.t0; if (u < 0) return;
    const land = st.land || 0.22;
    let lift, sc;
    if (u < land) { const v = u / land; lift = 1 - E.inQuad(v); sc = lerp(st.big || 1.35, 1.0, E.inQuad(v)); }
    else { const v = u - land; lift = 0; sc = 1 - 0.06 * Math.exp(-v * 18) * Math.cos(v * 40); }
    if (st.peel != null) { lift = Math.max(lift, st.peel); sc *= 1 + st.peel * 0.08; }
    const rot = st.rot + (u < land ? (1 - u / land) * (st.spin ?? 0.25) : 0) + (st.peel ? st.peel * 0.2 : 0);
    const fx = st.from ? lerp(st.from[0], st.x, E.outCubic(clamp(u / land))) : st.x, fy = st.from ? lerp(st.from[1], st.y, E.outCubic(clamp(u / land))) : st.y;
    const { c, all, w, h } = st.s;
    const sw = w * sc, sh = h * sc;
    ctx.save(); ctx.translate(fx, fy); ctx.rotate(rot);
    ctx.globalAlpha = (opt.shadow ?? 0.38) - 0.18 * lift;
    ctx.filter = `blur(${(4 + lift * 16) * K}px)`;
    ctx.drawImage(all, -sw / 2 + 6 + lift * 40, -sh / 2 + 10 + lift * 55, sw, sh);
    ctx.filter = 'none'; ctx.globalAlpha = 1;
    ctx.drawImage(c, -sw / 2, -sh / 2, sw, sh);
    // gloss sweep
    if (!glossC) { glossC = document.createElement('canvas'); glossC.width = 1400; glossC.height = 1400; }
    if (all.width <= glossC.width && all.height <= glossC.height) {
      const tg = glossC.getContext('2d'); tg.setTransform(1, 0, 0, 1, 0, 0); tg.clearRect(0, 0, all.width, all.height);
      tg.drawImage(all, 0, 0); tg.globalCompositeOperation = 'source-in';
      const p = clamp(u / 0.9), c0 = clamp(-0.2 + p * 1.2);
      const gr = tg.createLinearGradient(0, 0, all.width, all.height);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(Math.max(0, c0 - 0.12), 'rgba(255,255,255,0)'); gr.addColorStop(c0, 'rgba(255,255,255,.5)'); gr.addColorStop(Math.min(1, c0 + 0.1), 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      tg.fillStyle = gr; tg.fillRect(0, 0, all.width, all.height); tg.globalCompositeOperation = 'source-over';
      ctx.drawImage(glossC, 0, 0, all.width, all.height, -sw / 2, -sh / 2, sw, sh);
    }
    // corner lift highlight (vinyl)
    ctx.restore();
  };
  S.marker = (g, pts, prog, seed = 0, col = 'rgba(255,255,255,.92)', lw = 9, head = true) => {
    if (prog <= 0) return;
    const [x0, y0, x1, y1, bend = -90] = pts; const mx = (x0 + x1) / 2, my = (y0 + y1) / 2 + bend;
    g.save(); g.strokeStyle = col; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); const N = 30;
    for (let i = 0; i <= N * Math.min(prog, 1); i++) { const u = i / N; const x = (1 - u) * (1 - u) * x0 + 2 * u * (1 - u) * mx + u * u * x1, y = (1 - u) * (1 - u) * y0 + 2 * u * (1 - u) * my + u * u * y1; const j = Math.sin(u * 17 + seed) * 2; i ? g.lineTo(x + j, y - j) : g.moveTo(x, y); }
    g.stroke();
    if (head && prog >= 1) { const a = Math.atan2(y1 - my, x1 - mx); g.beginPath(); g.moveTo(x1 - Math.cos(a - 0.5) * 38, y1 - Math.sin(a - 0.5) * 38); g.lineTo(x1, y1); g.lineTo(x1 - Math.cos(a + 0.5) * 38, y1 - Math.sin(a + 0.5) * 38); g.stroke(); }
    g.restore();
  };
  S.SANS = SANS;
  window.ST = S;
})();
