/* ===== morph.js · particle-morph kit (from styles/06-morph) =====
   MK.sample(draw, scale, depth)  -> Float32Array(N*3) points inside a 2D drawing, extruded in depth
   MK.frame(opts, eachParticle)   -> draws N glowing particles with a 3D camera and a glow composite
   eachParticle(i, out) must fill out = [x, y, z, r, g, b, alpha, size]; return false to skip. */
(function () {
  const { clamp, lerp } = Reel;
  const MK = {};
  let seed = 1234567; MK.rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  MK.N = 12000;
  MK.sample = (drawFn, scale, depth, opt = {}) => {
    const N = opt.n || MK.N, rnd = MK.rnd;
    const cw = opt.w || 1000, ch = opt.h || 520, cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.strokeStyle = '#fff'; drawFn(g, cw, ch);
    const d = g.getImageData(0, 0, cw, ch).data, pts = [], edge = [];
    const A = (x, y) => (x < 0 || y < 0 || x >= cw || y >= ch) ? 0 : d[(y * cw + x) * 4 + 3];
    for (let y = 0; y < ch; y += 2) for (let x = 0; x < cw; x += 2) if (A(x, y) > 128) {
      pts.push([x, y]);
      if (A(x - 3, y) < 128 || A(x + 3, y) < 128 || A(x, y - 3) < 128 || A(x, y + 3) < 128) edge.push([x, y]);
    }
    const out = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const p = (rnd() < (opt.edge ?? 0.38) && edge.length) ? edge[Math.floor(rnd() * edge.length)] : pts[Math.floor(rnd() * pts.length)];
      out[i * 3] = (p[0] + rnd() * 2 - cw / 2) * scale;
      out[i * 3 + 1] = -(p[1] + rnd() * 2 - ch / 2) * scale;
      out[i * 3 + 2] = (rnd() - 0.5) * depth;
    }
    return out;
  };
  MK.word = (txt, px = 300, font = '"Noto Sans CJK SC"', w = 900) => (g, cw, ch) => { g.font = `${w} ${px}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, cw / 2, ch / 2 + 10); };
  const nz = (x, y, z) => Math.sin(x * 1.7 + Math.sin(y * 2.3 + z)) * Math.cos(y * 1.3 - Math.sin(z * 1.9 + x));
  MK.curl = (x, y, z) => { const e = 0.08; return [nz(x, y + e, z) - nz(x, y - e, z), nz(x, y, z + e) - nz(x, y, z - e), nz(x + e, y, z) - nz(x - e, y, z)]; };
  function sprite(r, soft) { const c = document.createElement('canvas'); c.width = c.height = r * 2; const g = c.getContext('2d'); const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(soft, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, r * 2, r * 2); return c; }
  const tint = {};
  MK.tinted = (rgb, r = 8, soft = 0.22) => { const key = rgb.join(',') + r; if (tint[key]) return tint[key]; const s = sprite(r, soft); const g = s.getContext('2d'); g.globalCompositeOperation = 'source-atop'; g.fillStyle = `rgb(${rgb})`; g.fillRect(0, 0, r * 2, r * 2); tint[key] = s; return s; };
  MK.init = (stage, bgA = '#141a3a', bgB = '#05060f') => {
    const main = Reel.canvas2d(stage), glow = Reel.canvas2d(null);
    MK.main = main; MK.glow = glow; MK.bg = [bgA, bgB];
  };
  // cam: { yaw, pitch, roll, z (camera distance), F, cx, cy, tx, ty, tz (target offset) }
  MK.frame = (cam, n, each, opt = {}) => {
    const gl = MK.glow, ctx = gl.ctx; gl.begin(); ctx.clearRect(0, 0, 1920, 1080);
    ctx.globalCompositeOperation = 'lighter';
    const cy = Math.cos(cam.yaw || 0), sy = Math.sin(cam.yaw || 0), cp = Math.cos(cam.pitch || 0), sp = Math.sin(cam.pitch || 0);
    const cr = Math.cos(cam.roll || 0), sr = Math.sin(cam.roll || 0);
    const F = cam.F || 1150, camZ = cam.z || 7.2, CX = cam.cx ?? 960, CY = cam.cy ?? 520, tx = cam.tx || 0, ty = cam.ty || 0, tz = cam.tz || 0;
    const focus = cam.focus ?? camZ, dof = cam.dof ?? 2.6;
    const o = new Array(8);
    for (let i = 0; i < n; i++) {
      if (each(i, o) === false) continue;
      const x = o[0] - tx, y = o[1] - ty, z = o[2] - tz;
      const xr = x * cy + z * sy, zr = -x * sy + z * cy;
      const yr = y * cp - zr * sp, zz = y * sp + zr * cp;
      const d = camZ - zz; if (d < 0.25) continue;
      let px = F * xr / d, py = -F * yr / d;
      const rx = px * cr - py * sr, ry = px * sr + py * cr;
      px = CX + rx; py = CY + ry;
      if (px < -60 || px > 1980 || py < -60 || py > 1140) continue;
      const blur = Math.min(1, Math.abs(d - focus) / dof) * (o[8] ?? 1);
      const r = (1.25 + blur * 4.5) * o[7] * (F / d) / 160;
      ctx.globalAlpha = Math.min(1, o[6] * (1 - blur * 0.7));
      ctx.drawImage(MK.tinted([o[3] - (o[3] % 8), o[4] - (o[4] % 8), o[5] - (o[5] % 8)]), px - r * 2, py - r * 2, r * 4, r * 4);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    const m = MK.main.ctx; MK.main.begin();
    if (opt.bg !== false) {
      const bg = m.createRadialGradient(960, 520, 100, 960, 540, 1150); bg.addColorStop(0, MK.bg[0]); bg.addColorStop(1, MK.bg[1]);
      m.fillStyle = bg; m.fillRect(0, 0, 1920, 1080);
    }
    if (opt.under) opt.under(m);
    m.setTransform(1, 0, 0, 1, 0, 0); m.globalCompositeOperation = 'lighter';
    m.filter = `blur(${(14 * gl.k).toFixed(1)}px)`; m.globalAlpha = opt.glow ?? 0.85; m.drawImage(gl.cv, 0, 0);
    m.filter = `blur(${(4 * gl.k).toFixed(1)}px)`; m.globalAlpha = 0.6; m.drawImage(gl.cv, 0, 0);
    m.filter = 'none'; m.globalAlpha = 1; m.drawImage(gl.cv, 0, 0);
    m.globalCompositeOperation = 'source-over';
    MK.main.begin();
    return m;
  };
  MK.vignette = (m, a = 0.5) => { const v = m.createRadialGradient(960, 540, 500, 960, 540, 1200); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${a})`); m.fillStyle = v; m.fillRect(0, 0, 1920, 1080); };
  window.MK = MK;
})();
