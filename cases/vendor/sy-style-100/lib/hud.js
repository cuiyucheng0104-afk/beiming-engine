/* ===== hud.js · point-cloud + HUD kit (from styles/08-hud) =====
   HUD.cloud: PX/PY/PZ/PK arrays; HUD.add(x,y,z,k); HUD.cam = {x,y,z,yaw,pitch,roll,F,cx,cy};
   HUD.proj(x,y,z) -> [sx, sy, depth] in design px; HUD.points(colorFn, opt) draws additively;
   HUD.line / txt / corners / box helpers in design px; HUD.post(t, glitchAmt) = glitch + scanlines + vignette. */
(function () {
  const { clamp } = Reel;
  const H = {};
  H.h1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  H.init = (stage) => {
    const RS = Reel.RS; H.W = Math.round(1920 * RS); H.H = Math.round(1080 * RS); H.K = H.W / 1920;
    const cv = document.createElement('canvas'); cv.width = H.W; cv.height = H.H; cv.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px';
    stage.appendChild(cv); H.cv = cv; H.ctx = cv.getContext('2d');
    H.fx = document.createElement('canvas'); H.fx.width = H.W; H.fx.height = H.H; H.fctx = H.fx.getContext('2d');
    return H.ctx;
  };
  H.PX = []; H.PY = []; H.PZ = []; H.PK = [];
  H.add = (x, y, z, k = 0) => { H.PX.push(x); H.PY.push(y); H.PZ.push(z); H.PK.push(k); };
  H.cam = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, F: 1050, cx: 960, cy: 540 };
  H.proj = (x, y, z) => {
    const C = H.cam;
    const dx = x - C.x, dy = y - C.y, dz = z - C.z;
    const cy = Math.cos(C.yaw), sy = Math.sin(C.yaw);
    const rx = dx * cy - dz * sy; let rz = dx * sy + dz * cy;
    const cp = Math.cos(C.pitch), sp = Math.sin(C.pitch);
    const ry = dy * cp - rz * sp; rz = dy * sp + rz * cp;
    const cr = Math.cos(C.roll), sr = Math.sin(C.roll);
    const ux = rx * cr - ry * sr, uy = rx * sr + ry * cr;
    return [(C.cx ?? 960) + ux / rz * C.F, (C.cy ?? 540) - uy / rz * C.F, rz];
  };
  // colorFn(i, depth, screen) -> [cssPrefix 'rgba(r,g,b,', alpha, sizeMul] or null
  H.points = (colorFn, opt = {}) => {
    const ctx = H.ctx, K = H.K, n = H.PX.length, near = opt.near ?? 2, far = opt.far ?? 520;
    const clip = opt.clip;   // [x0,y0,x1,y1] design px
    const pw = Math.max(1, (opt.pw ?? 1.6) * K);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = opt.from || 0; i < (opt.to ?? n); i++) {
      const p = H.proj(H.PX[i], H.PY[i], H.PZ[i]);
      if (p[2] < near || p[2] > far) continue;
      if (clip) { if (p[0] < clip[0] || p[0] > clip[2] || p[1] < clip[1] || p[1] > clip[3]) continue; }
      else if (p[0] < -4 || p[0] > 1924 || p[1] < -4 || p[1] > 1084) continue;
      const c = colorFn(i, p[2], p);
      if (!c || c[1] <= 0.004) continue;
      const s = (p[2] < 40 ? pw * 2 : (p[2] < 90 ? pw * 1.4 : pw)) * (c[2] || 1);
      ctx.fillStyle = c[0] + Math.min(1, c[1]).toFixed(3) + ')';
      ctx.fillRect(p[0] * K, p[1] * K, s, s);
    }
    ctx.globalCompositeOperation = 'source-over';
  };
  H.CY = '#5ff6ff'; H.PINK = '#ff2e88'; H.AMB = '#ffc23d'; H.GRN = '#48ff9a';
  H.MONO = '"DejaVu Sans Mono", monospace';
  H.line = (x0, y0, x1, y1, col, w = 1.5, a = 1) => { const c = H.ctx, K = H.K; c.globalAlpha = a; c.strokeStyle = col; c.lineWidth = w * K; c.beginPath(); c.moveTo(x0 * K, y0 * K); c.lineTo(x1 * K, y1 * K); c.stroke(); c.globalAlpha = 1; };
  H.txt = (s, x, y, size, col, align = 'left', a = 1, font = H.MONO, weight = 500) => { const c = H.ctx, K = H.K; c.globalAlpha = a; c.fillStyle = col; c.font = `${weight} ${size * K}px ${font}`; c.textAlign = align; c.textBaseline = 'middle'; c.fillText(s, x * K, y * K); c.globalAlpha = 1; };
  H.corners = (x, y, w, h, l, col, wd = 2, a = 1) => { for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const cx = x + sx * w, cy = y + sy * h, dx = sx ? -l : l, dy = sy ? -l : l; H.line(cx, cy, cx + dx, cy, col, wd, a); H.line(cx, cy, cx, cy + dy, col, wd, a); } };
  H.rect = (x, y, w, h, col, a = 1, fill = false, wd = 1.5) => { const c = H.ctx, K = H.K; c.globalAlpha = a; if (fill) { c.fillStyle = col; c.fillRect(x * K, y * K, w * K, h * K); } else { c.strokeStyle = col; c.lineWidth = wd * K; c.strokeRect(x * K, y * K, w * K, h * K); } c.globalAlpha = 1; };
  H.post = (t, gAmt = 0, vig = 0.55, scan = 0.18) => {
    const ctx = H.ctx, W = H.W, Hh = H.H, K = H.K;
    if (gAmt > 0) {
      H.fctx.clearRect(0, 0, W, Hh); H.fctx.drawImage(H.cv, 0, 0);
      for (let i = 0; i < 9; i++) { const f = Math.floor(t * 30); const y = H.h1(i * 3 + f) * Hh, hh = (6 + H.h1(i * 7 + f) * 40) * K, off = (H.h1(i * 11 + f) - 0.5) * 120 * K * gAmt; ctx.drawImage(H.fx, 0, y, W, hh, off, y, W, hh); }
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35 * gAmt; ctx.drawImage(H.fx, 8 * K * gAmt, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    ctx.fillStyle = `rgba(0,0,0,${scan})`; for (let y = 0; y < Hh; y += 3) ctx.fillRect(0, y, W, 1);
    const vg = ctx.createRadialGradient(W / 2, Hh / 2, Hh * 0.35, W / 2, Hh / 2, Hh * 0.95); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${vig})`); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, Hh);
  };
  H.title = (t, t0, title, sub, y = 720) => {
    if (t <= t0) return; const ctx = H.ctx, K = H.K;
    const a = Reel.E.outCubic(clamp((t - t0) / 0.4)), jit = (1 - a) * 30;
    ctx.save(); ctx.font = `900 ${84 * K}px "Noto Sans CJK SC"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = a * 0.8; ctx.fillStyle = H.PINK; ctx.fillText(title, (960 - 4 - jit) * K, y * K); ctx.fillStyle = H.CY; ctx.fillText(title, (960 + 4 + jit) * K, y * K);
    ctx.globalAlpha = a; ctx.fillStyle = '#ffffff'; ctx.fillText(title, 960 * K, y * K);
    ctx.font = `600 ${26 * K}px "Noto Sans CJK SC"`; if ('letterSpacing' in ctx) ctx.letterSpacing = `${10 * K}px`; ctx.fillStyle = H.CY; ctx.fillText(sub, 960 * K, (y + 72) * K); if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.restore();
  };
  window.HUD = H;
})();
