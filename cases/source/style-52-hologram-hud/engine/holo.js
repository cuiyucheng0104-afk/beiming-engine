// 全息线框引擎（本片版）：透视投影、生长键扫描（每顶点 g 值，可向上/向下/沿任意方向生长）、
// 整体缩放（种子 → 大树的尺度变化）、局部爆炸、Fresnel 实体面、景深雾、两级辉光。
// 纯 Canvas 2D，确定性：只依赖参数。
const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

export function prepModel(j) {
  for (const P of j.parts) for (const C of P.pieces) {
    C.v = Float32Array.from(C.v); C.e = Uint32Array.from(C.e); C.q = Uint32Array.from(C.q || []);
    C.g = C.g ? Float32Array.from(C.g) : null;
    C.part = P.id; C.n = C.v.length / 3; C.explode = C.explode || [0, 0, 0];
  }
  j.byId = Object.fromEntries(j.parts.map(P => [P.id, P]));
  return j;
}

// cam = { target:[x,y,z], yaw, pitch, dist, fov, cx, cy (屏幕像素), roll }
export function makeCamera(cam, W, H) {
  const { target: T, yaw, pitch, dist } = cam;
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const eye = [T[0] + dist * sy * cp, T[1] + dist * sp, T[2] + dist * cy * cp];
  let f = [T[0] - eye[0], T[1] - eye[1], T[2] - eye[2]]; const fl = Math.hypot(...f); f = f.map(x => x / fl);
  let r = [-f[2], 0, f[0]]; const rl = Math.hypot(...r); r = r.map(x => x / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const foc = (H / 2) / Math.tan((cam.fov || 0.6) / 2);
  const cx = cam.cx ?? W / 2, cyy = cam.cy ?? H / 2, roll = cam.roll || 0, cr = Math.cos(roll), sr = Math.sin(roll);
  const near = dist * 0.03;
  const project = (x, y, z, out) => {
    const dx = x - eye[0], dy = y - eye[1], dz = z - eye[2];
    const zc = dx * f[0] + dy * f[1] + dz * f[2];
    const xc = dx * r[0] + dy * r[1] + dz * r[2], yc = dx * u[0] + dy * u[1] + dz * u[2];
    const k = foc / Math.max(zc, near);
    const X = xc * k, Y = -yc * k;
    out[0] = cx + X * cr - Y * sr; out[1] = cyy + X * sr + Y * cr; out[2] = zc;
    return out;
  };
  return { project, eye, f, dist, foc, near };
}

export class Holo {
  constructor(W = 1920, H = 1080) {
    this.W = W; this.H = H;
    this.L = mk(W, H); this.G1 = mk(W / 4, H / 4); this.G2 = mk(W / 8, H / 8); this.F = mk(W, H);
    const pc = mk(1, 4), pg = pc.getContext('2d');
    pg.fillStyle = 'rgba(0,0,0,1)'; pg.fillRect(0, 0, 1, 2); pg.fillStyle = 'rgba(0,0,0,0.38)'; pg.fillRect(0, 2, 1, 2);
    this.scanPat = this.F.getContext('2d').createPattern(pc, 'repeat');
    this.tmp = new Float32Array(3);
  }
  // opts:
  //  hue, scale(绕原点整体缩放), offset([x,y,z] 缩放后平移)
  //  grow  { partOrPiece: front }：只画生长键 g < front 的部分（无 g 时用 y）；前沿 band 内为热边
  //  growBand 前沿热边宽度（生长键单位）
  //  explode { partOrPiece: 0–1 }，solid 0–1，wave {y, w}（世界高度，缩放后）
  //  focus / dim，gain，gainPart {part: k}，flash {part: 0–1}，hotPart {part: 0–1}
  //  points { partOrPiece: alpha }：额外画顶点点云；pointsOnly { partOrPiece: true }：只画点不画线
  //  fog [near, far]（相机深度），lineWidth，glow，alpha
  draw(ctx, model, cam, o = {}) {
    const { W, H } = this, L = this.L, g = L.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
    const C = makeCamera(cam, W, H), P = C.project, t3 = this.tmp;
    const hue = o.hue ?? 168, gain = o.gain ?? 1, solid = o.solid || 0, S0 = o.scale ?? 1, OF = o.offset || [0, 0, 0];
    const grow = o.grow || null, band = o.growBand ?? 0.03, wave = o.wave;
    const info = { bbox: {}, anchor: {}, project: P, cam: C };
    const [dN, dF] = o.fog || [C.dist - 1.1, C.dist + 1.1];
    const LV = 7;
    const paths = [], hot = [], fills = [];
    for (let i = 0; i < LV; i++) { paths.push(new Path2D()); hot.push(new Path2D()); fills.push(new Path2D()); }
    const dots = new Path2D(), pdots = [];
    for (let i = 0; i < LV; i++) pdots.push(new Path2D());
    const near = C.near * 1.05;
    for (const Pt of model.parts) {
      if (o.only && !o.only.includes(Pt.id)) continue;
      const focusMul = (o.focus && o.focus !== Pt.id ? (o.dim ?? 0.25) : 1) * (o.gainPart?.[Pt.id] ?? 1);
      let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
      const ptHot = (o.flash && o.flash[Pt.id] > 0.5) || (o.hotPart && o.hotPart[Pt.id] > 0.5);
      // 每个部件可单独压低实体面（solidPart）、光波面亮度（waveFillPart）、光波热线带宽（waveBandPart）
      const per = (m, id) => m ? (m[id] ?? m[Pt.id] ?? 1) : 1;
      for (const Pc of Pt.pieces) {
        const k = o.explode ? (o.explode[Pc.id] ?? o.explode[Pt.id] ?? 0) : 0;
        const solidP = solid * per(o.solidPart, Pc.id), waveFill = per(o.waveFillPart, Pc.id);
        const waveW = wave ? wave.w * per(o.waveBandPart, Pc.id) : 0;
        // squash [y0, s]：爆炸时把这一层压扁到原厚度的 (1 − s·k)，以 y0 为基准（年轮层 → 薄片，层间留缝）
        const sqY = Pc.squash ? Pc.squash[0] : 0, sqK = Pc.squash ? 1 - Pc.squash[1] * k : 1;
        const vis = Pc.internal ? clamp(k * 3) : 1;
        if (vis <= 0.001) continue;
        const front = grow ? (grow[Pc.id] ?? grow[Pt.id] ?? Infinity) : Infinity;
        if (front <= -1e8) continue;
        const ex = Pc.explode[0] * k, ey = Pc.explode[1] * k, ez = Pc.explode[2] * k;
        const n = Pc.n, V = Pc.v, G = Pc.g;
        const S = new Float32Array(n * 3), Y = new Float32Array(n), K = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const vy = sqK === 1 ? V[i * 3 + 1] : sqY + (V[i * 3 + 1] - sqY) * sqK;
          const x = (V[i * 3] + ex) * S0 + OF[0], y = (vy + ey) * S0 + OF[1], z = (V[i * 3 + 2] + ez) * S0 + OF[2];
          Y[i] = y; K[i] = G ? G[i] : V[i * 3 + 1];
          P(x, y, z, t3);
          S[i * 3] = t3[0]; S[i * 3 + 1] = t3[1]; S[i * 3 + 2] = t3[2];
          if (K[i] <= front && !Pc.internal && Pc.box !== false && t3[2] > near) {
            let bx = t3[0], by = t3[1];
            if (k) { P(V[i * 3] * S0 + OF[0], V[i * 3 + 1] * S0 + OF[1], V[i * 3 + 2] * S0 + OF[2], t3); bx = t3[0]; by = t3[1]; }
            if (bx < bx0) bx0 = bx; if (bx > bx1) bx1 = bx; if (by < by0) by0 = by; if (by > by1) by1 = by;
          }
        }
        const mulA = focusMul * vis * gain * (o.gainPiece?.[Pc.id] ?? 1);
        const pcHot = !!(o.hotPiece && o.hotPiece[Pc.id] > 0.5);   // 单个子件热边（爆炸时的目标年轮）
        const ptsA = o.points ? (o.points[Pc.id] ?? o.points[Pt.id] ?? 0) : 0;
        const onlyPts = o.pointsOnly && (o.pointsOnly[Pc.id] || o.pointsOnly[Pt.id]);
        if (ptsA > 0) {
          for (let i = 0; i < n; i++) {
            if (S[i * 3 + 2] <= near) continue;
            const fog = clamp(1 - (S[i * 3 + 2] - dN) / (dF - dN) * 0.75, 0.22, 1);
            const lv = Math.min(LV - 1, Math.floor(fog * ptsA * LV)); if (lv < 0) continue;
            pdots[lv].rect(S[i * 3] - 1.2, S[i * 3 + 1] - 1.2, 2.4, 2.4);
          }
        }
        if (!onlyPts) {
          const E = Pc.e;
          for (let j = 0; j < E.length; j += 2) {
            const a = E[j], b = E[j + 1];
            if (S[a * 3 + 2] <= near || S[b * 3 + 2] <= near) continue;
            let ka = K[a], kb = K[b];
            let x0 = S[a * 3], y0 = S[a * 3 + 1], x1 = S[b * 3], y1 = S[b * 3 + 1];
            let ya = Y[a], yb = Y[b];
            if (front < Infinity) {
              if (ka > front && kb > front) continue;
              if (ka > front || kb > front) {
                const tc = (front - ka) / (kb - ka);
                const xi = x0 + (x1 - x0) * tc, yi = y0 + (y1 - y0) * tc, yw = ya + (yb - ya) * tc;
                if (ka > front) { x0 = xi; y0 = yi; ka = front; ya = yw; } else { x1 = xi; y1 = yi; kb = front; yb = yw; }
                dots.rect(xi - 1.5, yi - 1.5, 3, 3);
              }
            }
            const zm = (S[a * 3 + 2] + S[b * 3 + 2]) / 2;
            const fog = clamp(1 - (zm - dN) / (dF - dN) * 0.75, 0.22, 1);
            const lv = Math.min(LV - 1, Math.floor(fog * mulA * LV));
            if (lv < 0 || fog * mulA < 0.03) continue;
            const ymid = (ya + yb) / 2;
            const isHot = (front < Infinity && Math.max(ka, kb) > front - band) || (Pc.hot && k > 0.02) || ptHot || pcHot || (wave && Math.abs(ymid - wave.y) < waveW);
            const tg = isHot ? hot[lv] : paths[lv];
            tg.moveTo(x0, y0); tg.lineTo(x1, y1);
          }
          if (solidP > 0) {
            const Q = Pc.q;
            for (let j = 0; j < Q.length; j += 4) {
              const a = Q[j], b = Q[j + 1], c = Q[j + 2], d = Q[j + 3];
              if (Math.max(K[a], K[b], K[c], K[d]) > front) continue;
              if (Math.min(S[a * 3 + 2], S[b * 3 + 2], S[c * 3 + 2], S[d * 3 + 2]) <= near) continue;
              const ax_ = S[a * 3], ay_ = S[a * 3 + 1], bx_ = S[b * 3], by_ = S[b * 3 + 1], cx_ = S[c * 3], cy_ = S[c * 3 + 1], dx_ = S[d * 3], dy_ = S[d * 3 + 1];
              const area = Math.abs((cx_ - ax_) * (dy_ - by_) - (dx_ - bx_) * (cy_ - ay_)) / 2;
              const e1 = Math.hypot(bx_ - ax_, by_ - ay_), e2 = Math.hypot(dx_ - ax_, dy_ - ay_);
              const facing = clamp(area / Math.max(1e-3, e1 * e2));
              let fr = 0.3 + 0.7 * Math.pow(1 - facing, 1.6);
              if (wave && waveFill > 0) { const ym = (Y[a] + Y[c]) / 2, dw = Math.abs(ym - wave.y); if (dw < wave.w * 2) fr += (1 - dw / (wave.w * 2)) * 0.9 * waveFill; }
              const lv = Math.min(LV - 1, Math.floor(fr * solidP * focusMul * vis * gain * LV));
              if (lv < 1) continue;
              const T = fills[lv];
              T.moveTo(ax_, ay_); T.lineTo(bx_, by_); T.lineTo(cx_, cy_); T.lineTo(dx_, dy_); T.closePath();
            }
          }
        }
      }
      if (bx1 > bx0) info.bbox[Pt.id] = [bx0, by0, bx1, by1];
      if (Pt.anchor) { const an = Pt.anchor; P(an[0] * S0 + OF[0], an[1] * S0 + OF[1], an[2] * S0 + OF[2], t3); info.anchor[Pt.id] = [t3[0], t3[1], t3[2]]; }
    }
    g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
    if (solid > 0) {
      const F = this.F, f = F.getContext('2d');
      f.globalCompositeOperation = 'source-over'; f.clearRect(0, 0, W, H);
      f.globalCompositeOperation = 'lighter';
      for (let i = 1; i < LV; i++) { f.fillStyle = `hsla(${hue},90%,${55 + i * 5}%,${0.1 + (i / LV) * 0.6})`; f.fill(fills[i]); }
      f.globalCompositeOperation = 'destination-in'; f.setTransform(1, 0, 0, 1, 0, (o.scanOffset || 0) % 4); f.fillStyle = this.scanPat; f.fillRect(0, -8, W, H + 16); f.setTransform(1, 0, 0, 1, 0, 0);
      f.globalCompositeOperation = 'source-over';
      g.drawImage(F, 0, 0);
    }
    const lw = o.lineWidth || 1.3;
    for (let i = 0; i < LV; i++) {
      const a = (i + 1) / LV;
      g.strokeStyle = `hsla(${hue},100%,${50 + a * 30}%,${0.06 + a * 0.84})`; g.lineWidth = lw * (0.7 + a * 0.5);
      g.stroke(paths[i]);
    }
    for (let i = 0; i < LV; i++) { const a = (i + 1) / LV; g.strokeStyle = `hsla(${hue},70%,92%,${0.35 + a * 0.65})`; g.lineWidth = lw * 1.3; g.stroke(hot[i]); }
    for (let i = 0; i < LV; i++) { const a = (i + 1) / LV; g.fillStyle = `hsla(${hue},80%,82%,${0.15 + a * 0.85})`; g.fill(pdots[i]); }
    if (grow) { g.fillStyle = `hsla(${hue},60%,96%,1)`; g.fill(dots); }
    g.globalCompositeOperation = 'source-over';
    this.composite(ctx, o.glow ?? 1, o.alpha ?? 1);
    return info;
  }
  composite(ctx, glow = 1, alpha = 1) {
    const { L, G1, G2, W, H } = this;
    const g1 = G1.getContext('2d'), g2 = G2.getContext('2d');
    g1.clearRect(0, 0, G1.width, G1.height); g1.filter = 'blur(3px)'; g1.drawImage(L, 0, 0, G1.width, G1.height); g1.filter = 'none';
    g2.clearRect(0, 0, G2.width, G2.height); g2.filter = 'blur(4px)'; g2.drawImage(L, 0, 0, G2.width, G2.height); g2.filter = 'none';
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85 * glow * alpha; ctx.drawImage(G1, 0, 0, W, H);
    ctx.globalAlpha = 0.7 * glow * alpha; ctx.drawImage(G2, 0, 0, W, H);
    ctx.globalAlpha = alpha; ctx.drawImage(L, 0, 0);
    ctx.restore();
  }
}

// 扫描平面：世界高度 y 处的投影环 + 刻度 + 屏幕光幕
export function drawScanPlane(ctx, cam, W, H, y, o = {}) {
  const C = makeCamera(cam, W, H), P = C.project, t = new Float32Array(3);
  const hue = o.hue ?? 168, R = o.r ?? 1, c = o.c || [0, 0, 0], a = o.alpha ?? 1;
  const pts = [];
  for (let i = 0; i <= 96; i++) { const th = i / 96 * TAU; P(c[0] + Math.cos(th) * R, y, c[2] + Math.sin(th) * R, t); pts.push([t[0], t[1]]); }
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
  ctx.fillStyle = `hsla(${hue},90%,60%,${0.07 * a})`; ctx.fill();
  ctx.strokeStyle = `hsla(${hue},80%,85%,${0.75 * a})`; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 72; i++) {
    const th = i / 72 * TAU + (o.rot || 0), r2 = R * (i % 6 ? 1.03 : 1.07);
    P(c[0] + Math.cos(th) * R, y, c[2] + Math.sin(th) * R, t); ctx.moveTo(t[0], t[1]);
    P(c[0] + Math.cos(th) * r2, y, c[2] + Math.sin(th) * r2, t); ctx.lineTo(t[0], t[1]);
  }
  ctx.strokeStyle = `hsla(${hue},80%,80%,${0.5 * a})`; ctx.lineWidth = 1; ctx.stroke();
  P(c[0], y, c[2], t); const yy = t[1];
  const gr = ctx.createLinearGradient(0, yy - 60, 0, yy + 60);
  gr.addColorStop(0, `hsla(${hue},90%,60%,0)`); gr.addColorStop(0.5, `hsla(${hue},90%,70%,${0.10 * a})`); gr.addColorStop(1, `hsla(${hue},90%,60%,0)`);
  ctx.fillStyle = gr; ctx.fillRect(0, yy - 60, W, 120);
  const gl = ctx.createLinearGradient(0, 0, W, 0);
  gl.addColorStop(0, `hsla(${hue},90%,80%,0)`); gl.addColorStop(0.5, `hsla(${hue},90%,85%,${0.55 * a})`); gl.addColorStop(1, `hsla(${hue},90%,80%,0)`);
  ctx.fillStyle = gl; ctx.fillRect(0, yy - 0.75, W, 1.5);
  ctx.restore();
  return yy;
}

// 投影台：地面同心环 + 刻度 + 放射线（相机透视）；R 为整体半径
export function drawPad(ctx, cam, W, H, o = {}) {
  const C = makeCamera(cam, W, H), P = C.project, t = new Float32Array(3);
  const hue = o.hue ?? 168, a = o.alpha ?? 1, rot = o.rot || 0, y = o.y ?? 0, c = o.c || [0, 0, 0], R = o.R ?? 1;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const ring = (r, al, w = 1, dash = 0) => {
    ctx.beginPath(); let pen = false;
    for (let i = 0; i <= 160; i++) {
      const th = i / 160 * TAU; P(c[0] + Math.cos(th) * r * R, y, c[2] + Math.sin(th) * r * R, t);
      if (t[2] <= C.near * 1.05) { pen = false; continue; }
      pen ? ctx.lineTo(t[0], t[1]) : ctx.moveTo(t[0], t[1]); pen = true;
    }
    ctx.setLineDash(dash ? [dash, dash * 1.6] : []);
    ctx.strokeStyle = `hsla(${hue},80%,70%,${al * a})`; ctx.lineWidth = w; ctx.stroke();
  };
  ring(1.05, 0.55, 1.4); ring(1.12, 0.3, 1, 6); ring(0.7, 0.18, 1); ring(0.35, 0.12, 1); ring(1.45, 0.14, 1); ring(2.1, 0.07, 1);
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let i = 0; i < 120; i++) {
    const th = i / 120 * TAU + rot, big = i % 10 === 0, r0 = 1.05 * R, r1 = (big ? 1.2 : 1.1) * R;
    P(c[0] + Math.cos(th) * r0, y, c[2] + Math.sin(th) * r0, t); if (t[2] <= C.near * 1.05) continue; const x0 = t[0], y0 = t[1];
    P(c[0] + Math.cos(th) * r1, y, c[2] + Math.sin(th) * r1, t); if (t[2] <= C.near * 1.05) continue;
    ctx.moveTo(x0, y0); ctx.lineTo(t[0], t[1]);
  }
  ctx.strokeStyle = `hsla(${hue},80%,78%,${0.5 * a})`; ctx.lineWidth = 1; ctx.stroke();
  for (let i = 0; i < 24; i++) {
    const th = i / 24 * TAU + rot * 0.25;
    P(c[0] + Math.cos(th) * 1.2 * R, y, c[2] + Math.sin(th) * 1.2 * R, t); if (t[2] <= C.near * 1.05) continue; const x0 = t[0], y0 = t[1];
    P(c[0] + Math.cos(th) * 2.4 * R, y, c[2] + Math.sin(th) * 2.4 * R, t); if (t[2] <= C.near * 1.05) continue;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(t[0], t[1]);
    ctx.strokeStyle = `hsla(${hue},70%,60%,${0.08 * a})`; ctx.stroke();
  }
  if (o.pulse > 0) ring(1.05 + o.pulse * 0.9, 0.5 * (1 - o.pulse), 2);
  ctx.restore();
}

function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); return c; }
