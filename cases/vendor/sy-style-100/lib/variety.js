/* ===== variety.js · variety-show caption kit (from styles/15-variety) =====
   VAR.init(stage) -> { g (2D ctx over the footage), K, W, H, vText, sticker, burst, spark, subtitle, pill,
   popIn, popOut, punch, arrowLabel, clear() }.  vText = multi-stroke gradient type with extrusion and gloss;
   sticker = emoji with a die-cut white border; all coordinates in design px. */
(function () {
  const { E, clamp } = Reel;
  function init(stage) {
    const RS = Reel.RS, W = Math.round(1920 * RS), H = Math.round(1080 * RS), K = W / 1920;
    const ov = document.createElement('canvas'); ov.width = W; ov.height = H; ov.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px'; stage.appendChild(ov);
    const g = ov.getContext('2d');
    const lay = document.createElement('canvas'); lay.width = W; lay.height = H; const gl = lay.getContext('2d');
    const FONT = '"Noto Sans CJK SC"';
    function vText(str, x, y, size, o = {}) {
      const { fill = ['#fff7a8', '#ffb21e'], s1 = '#3a1060', s2 = '#ffffff', s3 = null, depth = 10, depthCol = '#22083a', rot = 0, sc = 1, alpha = 1, weight = 900, gloss = true, spacing = 0, align = 'center' } = o;
      if (sc <= 0.001 || alpha <= 0.001) return;
      gl.clearRect(0, 0, W, H); gl.save(); gl.translate(x * K, y * K); gl.rotate(rot); gl.scale(sc, sc);
      const fs = size * K; gl.font = `${weight} ${fs}px ${FONT}`; gl.textAlign = align; gl.textBaseline = 'middle'; gl.lineJoin = 'round'; gl.miterLimit = 2;
      if ('letterSpacing' in gl) gl.letterSpacing = (spacing * K).toFixed(1) + 'px';
      const w1 = fs * 0.34, w2 = fs * 0.2, w3 = fs * 0.075;
      gl.strokeStyle = depthCol; gl.lineWidth = w1; for (let i = depth; i >= 1; i -= 1) gl.strokeText(str, i * 0.55 * K, i * 0.9 * K);
      gl.strokeStyle = s1; gl.lineWidth = w1; gl.strokeText(str, 0, 0); gl.strokeStyle = s2; gl.lineWidth = w2; gl.strokeText(str, 0, 0);
      if (s3) { gl.strokeStyle = s3; gl.lineWidth = w3; gl.strokeText(str, 0, 0); }
      const gr = gl.createLinearGradient(0, -fs * 0.5, 0, fs * 0.5); gr.addColorStop(0, fill[0]); gr.addColorStop(0.55, fill[1]); gr.addColorStop(1, fill[2] || fill[1]); gl.fillStyle = gr; gl.fillText(str, 0, 0);
      if (gloss) { gl.globalCompositeOperation = 'source-atop'; const hg = gl.createLinearGradient(0, -fs * 0.5, 0, fs * 0.1); hg.addColorStop(0, 'rgba(255,255,255,.55)'); hg.addColorStop(1, 'rgba(255,255,255,0)'); gl.fillStyle = hg; gl.fillRect(-fs * 12, -fs * 0.6, fs * 24, fs * 0.62); }
      if ('letterSpacing' in gl) gl.letterSpacing = '0px';
      gl.restore(); g.save(); g.globalAlpha = alpha; g.drawImage(lay, 0, 0); g.restore();
    }
    const cache = {};
    function sticker(em, x, y, size, rot = 0, sc = 1, alpha = 1) {
      if (sc <= 0.001) return; const key = em + size; let c = cache[key];
      if (!c) {
        const s = Math.ceil(size * K * 1.5), pad = Math.ceil(size * K * 0.12);
        const e = document.createElement('canvas'); e.width = e.height = s + pad * 2; const ec = e.getContext('2d'); ec.font = `${size * K}px "Noto Color Emoji"`; ec.textAlign = 'center'; ec.textBaseline = 'middle'; ec.fillText(em, e.width / 2, e.height / 2 + size * K * 0.06);
        const m = document.createElement('canvas'); m.width = m.height = e.width; const mc = m.getContext('2d'); mc.drawImage(e, 0, 0); mc.globalCompositeOperation = 'source-in'; mc.fillStyle = '#fff'; mc.fillRect(0, 0, m.width, m.height);
        c = document.createElement('canvas'); c.width = c.height = e.width; const cc = c.getContext('2d'); cc.shadowColor = 'rgba(0,0,0,.35)'; cc.shadowBlur = pad * 0.8; cc.shadowOffsetY = pad * 0.3;
        for (let a = 0; a < 16; a++) cc.drawImage(m, Math.cos(a / 16 * Math.PI * 2) * pad * 0.8, Math.sin(a / 16 * Math.PI * 2) * pad * 0.8);
        cc.shadowColor = 'transparent'; cc.drawImage(e, 0, 0); cache[key] = c;
      }
      g.save(); g.globalAlpha = alpha; g.translate(x * K, y * K); g.rotate(rot); g.scale(sc, sc); g.drawImage(c, -c.width / 2, -c.height / 2); g.restore();
    }
    function burst(x, y, r0, r1, n, rot, alpha, cols = ['rgba(255,236,120,', 'rgba(255,255,255,']) {
      g.save(); g.translate(x * K, y * K); g.rotate(rot);
      for (let i = 0; i < n; i++) { const a0 = i / n * Math.PI * 2, a1 = a0 + Math.PI / n * 0.9; g.fillStyle = cols[i % 2] + alpha + ')'; g.beginPath(); g.moveTo(Math.cos(a0) * r0 * K, Math.sin(a0) * r0 * K); g.lineTo(Math.cos(a0) * r1 * K, Math.sin(a0) * r1 * K); g.lineTo(Math.cos(a1) * r1 * K, Math.sin(a1) * r1 * K); g.lineTo(Math.cos(a1) * r0 * K, Math.sin(a1) * r0 * K); g.fill(); }
      g.restore();
    }
    function spark(x, y, r, col, rot = 0) { if (r <= 0) return; g.save(); g.translate(x * K, y * K); g.rotate(rot); g.fillStyle = col; g.beginPath(); for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2, rr = (i % 2 ? 0.22 : 1) * r * K; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.fill(); g.restore(); }
    function subtitle(str, alpha, y = 985) { if (alpha <= 0) return; g.save(); g.globalAlpha = alpha; g.font = `700 ${46 * K}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.strokeStyle = 'rgba(0,0,0,.85)'; g.lineWidth = 9 * K; g.strokeText(str, 960 * K, y * K); g.fillStyle = '#fff'; g.fillText(str, 960 * K, y * K); g.restore(); }
    function pill(str, x, y, col = 'rgba(255,92,72,.95)', emoji = null, h = 64, size = 34) {
      g.save(); g.font = `900 ${size * K}px ${FONT}`; const w = g.measureText(str).width + (emoji ? 110 : 60) * K;
      g.fillStyle = col; g.beginPath(); g.roundRect(x * K, y * K, w, h * K, h * K / 2); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 4 * K; g.stroke();
      g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(str, x * K + (emoji ? 84 : 30) * K, (y + h / 2 + 1) * K); g.restore();
      if (emoji) sticker(emoji, x + 40, y + h / 2, 40, -0.1, 1);
      return w / K;
    }
    // freeze-frame annotation: dot + elbow line + boxed label
    function arrowLabel(str, ax, ay, lx, ly, p, col = '#ffe23a') {
      if (p <= 0) return; const q = E.outCubic(clamp(p * 1.6)), mx = lx, my = ay + (ly - ay) * 0;
      g.save(); g.strokeStyle = '#fff'; g.lineWidth = 5 * K; g.lineCap = 'round'; g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 6 * K;
      g.beginPath(); g.arc(ax * K, ay * K, 10 * K * q, 0, 7); g.fillStyle = col; g.fill(); g.stroke();
      g.beginPath(); g.moveTo(ax * K, ay * K); const ex = ax + (lx - ax) * q, ey = ay + (ly - ay) * q; g.lineTo(ex * K, ey * K); g.stroke();
      const a2 = clamp((p - 0.4) / 0.4); if (a2 > 0) { g.font = `900 ${44 * K}px ${FONT}`; const w = g.measureText(str).width + 40 * K, h = 70 * K, bx = lx * K - (lx < ax ? w : 0), by = ly * K - h / 2; g.globalAlpha = a2; g.fillStyle = col; g.beginPath(); g.roundRect(bx, by, w, h, 14 * K); g.fill(); g.stroke(); g.shadowBlur = 0; g.fillStyle = '#1a1a1a'; g.textBaseline = 'middle'; g.fillText(str, bx + 20 * K, ly * K + 2 * K); }
      g.restore();
    }
    const popIn = (t, t0, d = 0.32) => (t < t0 ? 0 : E.outBack(clamp((t - t0) / d), 2.2));
    const popOut = (t, t1, d = 0.18) => 1 - E.inQuad(clamp((t - t1) / d));
    const punch = (t, t0, amt) => (t < t0 ? 0 : amt * Math.exp(-(t - t0) * 7));
    const clear = () => g.clearRect(0, 0, W, H);
    return { g, K, W, H, FONT, vText, sticker, burst, spark, subtitle, pill, arrowLabel, popIn, popOut, punch, clear };
  }
  window.VAR = { init };
})();
