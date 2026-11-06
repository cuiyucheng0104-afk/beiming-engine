// One state object -> one frame. The wall camera is an affine view of the wall plane (x, y, zoom); the floor is drawn
// by the compositor in perspective consistent with the wall base (floorMode 1) or top-down (floorMode 2).
// Glass is drawn three times through the same code: full (glass + lead + light mask), and 'proj' into the floor patch map.
import { mulberry, hash } from '/core/lib.js';
import { Pass } from './glass.js';
import { FLOOR, R_IN, R_OUT, PETALS, R_PET0, R_PET1, CARVE_Y, drawStone, drawTracery, drawOuter, drawQuarries, medallionClip } from './rose.js';
import { drawPhoenix, drawFlames } from './phoenix.js';

export const PMW = 3072, PMH = 2304;   // patch map at ~1.5 px per world unit, so the projected phoenix stays legible on the stones
export function camMatrix(cam) { return new DOMMatrix().translate(960, 540).scale(cam[2]).translate(-cam[0], -cam[1]); }
export function toScreen(cam, x, y) { return [960 + (x - cam[0]) * cam[2], 540 + (y - cam[1]) * cam[2]]; }
// perspective projection of a room point (X along wall, H above floor, Z out from the wall) to screen; matches the floor shader
export function proj3(cam, fl, X, H, Z) {
  const s = cam[2], dist = fl.camD - Z, yb = (FLOOR - cam[1]) * s + 540, y0 = yb - s * fl.eyeH;
  return [960 + (X - cam[0]) * s * fl.camD / dist, y0 + s * fl.camD * (fl.eyeH - H) / dist];
}
function hull(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  up.pop(); lo.pop(); return lo.concat(up);
}

// all window glass, through one Pass (full or proj). base = matrix for window space
function drawWindow(Pz, base, st) {
  Pz.setTransform(base);
  drawOuter(Pz, st.petalLit, { medLit: st.medLit });
  Pz.save(); Pz.setTransform(base); Pz.clip(medallionClip());
  drawQuarries(Pz, st.bgLit);
  const ph = st.phoenix;
  const mb = base.translate(0, 0);
  drawFlames(Pz, mb, st.flames);
  const pb = base.translate(ph.x, ph.y).scale(ph.s);
  drawPhoenix(Pz, pb, ph.pose, ph.o);
  // cracks (light pouring through) and mending leads (the scars)
  Pz.setTransform(base);
  for (const c of st.cracks || []) {
    if (c.grow <= 0) continue;
    const n = Math.max(2, Math.ceil(c.pts.length * Math.min(1, c.grow)));
    const pts = c.pts.slice(0, n), m = c.mend > 0 ? Math.max(1, Math.ceil(pts.length * Math.min(1, c.mend))) : 0;
    const path = q => { const p = new Path2D(); q.forEach((v, k) => k ? p.lineTo(v[0], v[1]) : p.moveTo(v[0], v[1])); return p; };
    if (m < pts.length) {   // open crack: white transmittance, lit by the crack channel
      const open = pts.slice(Math.max(0, m - 1)), pa = path(open);
      const g = Pz.g; g.lineJoin = 'round'; g.lineCap = 'round';
      if (Pz.mode === 'full') {
        g.strokeStyle = 'rgba(255,250,238,.96)'; g.lineWidth = c.w; g.stroke(pa);
        if (Pz.m) { Pz.m.strokeStyle = `rgb(${Math.round(255 * (st.crackSun ?? .5))},0,255)`; Pz.m.lineWidth = c.w * 1.6; Pz.m.lineCap = 'round'; Pz.m.lineJoin = 'round'; Pz.m.stroke(pa); }
        Pz.s.strokeStyle = 'rgba(20,20,24,.5)'; Pz.s.lineWidth = c.w * .35; Pz.s.stroke(pa);
      } else { g.save(); g.globalAlpha = .9; g.strokeStyle = '#fff'; g.lineWidth = c.w * 1.4; g.stroke(pa); g.restore(); }
    }
    if (m >= 2) { const pl = path(pts.slice(0, m)); Pz.lead(pl, c.lw || 3.4); }
    if (m >= 1 && c.mend < 1 && c.mend > 0) { const q = pts[m - 1]; Pz.solder(q[0], q[1], 3.6); }
    if (c.mend >= 1) Pz.solder(pts[pts.length - 1][0], pts[pts.length - 1][1], 2.8);   // one small joint at the far end only
  }
  Pz.restore();
}

const SHAFT_PANES = (() => {
  const out = [{ c: [0, 0], r: R_IN, tint: [1, .62, .38], key: 'med' }];
  PETALS.forEach((p, i) => { const rc = (R_PET0 + R_PET1) / 2; out.push({ c: [Math.cos(p.a) * rc, Math.sin(p.a) * rc], r: 62, tint: i % 2 ? [1, .5, .42] : [.45, .6, 1], key: i }); });
  return out;
})();

export function renderScene(Lc, L, comp, st) {
  const { G, S, R, O, P, M: Mk } = Lc;
  for (const c of [G, S, R, O, Mk]) { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, 1920, 1080); }
  const cam = st.cam, M = camMatrix(cam);
  const hw = 960 / cam[2], hh = 540 / cam[2], view = [cam[0] - hw, cam[1] - hh, cam[0] + hw, cam[1] + hh];
  const top = st.floorMode === 2;
  const fl = st.floor;
  if (!top) {
    drawStone(S, M, view, { carve: st.carve });
    if (view[1] < R_OUT && view[3] > -R_OUT && view[0] < R_OUT && view[2] > -R_OUT) {
      const Pz = new Pass(G, S, 'full', Mk);
      drawWindow(Pz, M, st);
      drawTracery(S, M);
    }
  }
  // floor patch map: the window projected by parallel sunlight
  let pmRect = [0, 0, 1, 1];
  if ((st.floorMode || 0) > 0 && st.sunI > 0) {
    const [rx, rz, rw, rh] = st.pm; pmRect = st.pm;
    P.setTransform(1, 0, 0, 1, 0, 0); P.fillStyle = '#000'; P.fillRect(0, 0, PMW, PMH);
    const kx = PMW / rw, ky = PMH / rh, sx = st.sx, sz = st.sz;
    // window (x, y) -> floor (X = x + (FLOOR - y) sx, Z = (FLOOR - y) sz) -> patch-map pixels
    const PM = new DOMMatrix([kx, 0, -sx * kx, -sz * ky, (FLOOR * sx - rx) * kx, (FLOOR * sz - rz) * ky]);
    const Pp = new Pass(P, P, 'proj');
    drawWindow(Pp, PM, st);
    drawTracery(P, PM, true);
    P.setTransform(1, 0, 0, 1, 0, 0);
    P.filter = `blur(${st.pmBlur ?? 2.5}px)`; P.globalCompositeOperation = 'copy'; P.drawImage(L.P, 0, 0); P.filter = 'none'; P.globalCompositeOperation = 'source-over';
  }
  // light shafts and dust in the air between window and floor
  if (!top && st.sunI > 0 && (st.raysK ?? 1) > 0) {
    R.globalCompositeOperation = 'lighter';
    SHAFT_PANES.forEach((pn, i) => {
      const li0 = pn.key === 'med' ? st.medLit[0] : st.petalLit(st.groupOf(pn.key))[0], li = Math.max(0, (li0 - .17) / .83); if (li <= .02) return;
      const ring = [], N = 18;
      for (let k = 0; k < N; k++) {
        const a = k / N * Math.PI * 2, x = pn.c[0] + Math.cos(a) * pn.r, y = pn.c[1] + Math.sin(a) * pn.r, H = FLOOR - y;
        ring.push(proj3(cam, fl, x, H, 0), proj3(cam, fl, x + H * st.sx, 0, H * st.sz));
      }
      const hl = hull(ring);
      const top0 = proj3(cam, fl, pn.c[0], FLOOR - pn.c[1], 0), H = FLOOR - pn.c[1], bot = proj3(cam, fl, pn.c[0] + H * st.sx, 0, H * st.sz);
      const flick = .75 + .25 * Math.sin(i * 2.7 + st.time * .6 + hash(i) * 6);
      const I = li * st.sunI * .028 * flick * (st.raysK ?? 1) * (pn.key === 'med' ? 1.3 : 1);
      const gr = R.createLinearGradient(top0[0], top0[1], bot[0], bot[1]);
      const col = m => `rgba(${Math.round(255 * Math.min(1, pn.tint[0] * st.sunCol[0] * I * m))},${Math.round(255 * Math.min(1, pn.tint[1] * st.sunCol[1] * I * m))},${Math.round(255 * Math.min(1, pn.tint[2] * st.sunCol[2] * I * m))},1)`;
      gr.addColorStop(0, col(.05)); gr.addColorStop(.18, col(.6)); gr.addColorStop(.42, col(1)); gr.addColorStop(1, col(.35));
      R.fillStyle = gr; R.beginPath(); hl.forEach((q, k) => k ? R.lineTo(q[0], q[1]) : R.moveTo(q[0], q[1])); R.closePath(); R.fill();
      const rnd = mulberry(77 + i);
      for (let k = 0; k < 40; k++) {   // dust motes drifting in the shaft
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * pn.r, v = (rnd() + st.time * .03 * (.5 + rnd())) % 1;
        const x = pn.c[0] + Math.cos(a) * rr, y = pn.c[1] + Math.sin(a) * rr, Hh = FLOOR - y;
        const p = proj3(cam, fl, x + Hh * st.sx * v + Math.sin(st.time * .7 + k) * 6, Hh * (1 - v) + Math.cos(st.time * .5 + k * 1.7) * 5, Hh * st.sz * v);
        const tw = .5 + .5 * Math.sin(st.time * 2.2 + k * 3.1), A = li * st.sunI * .12 * tw * (st.raysK ?? 1), r = (.8 + rnd() * 1.5) * Math.sqrt(cam[2]);
        R.fillStyle = `rgba(${Math.round(255 * Math.min(1, A))},${Math.round(240 * Math.min(1, A))},${Math.round(210 * Math.min(1, A))},1)`;
        R.beginPath(); R.arc(p[0], p[1], r, 0, 7); R.fill();
      }
    });
    // the haze in front of the carved band thins as the inscription is gilded, so the letters read through the shafts
    const ck = st.carve ? Math.min(1, st.carve.gild) : 0;
    if (ck > 0) {
      const a = toScreen(cam, -600, CARVE_Y - 90), z = toScreen(cam, 600, CARVE_Y + 90);
      const gr = R.createLinearGradient(0, a[1], 0, z[1]);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(.25, `rgba(0,0,0,${.68 * ck})`); gr.addColorStop(.75, `rgba(0,0,0,${.68 * ck})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      R.globalCompositeOperation = 'destination-out'; R.fillStyle = gr; R.fillRect(a[0], a[1], z[0] - a[0], z[1] - a[1]);
    }
    R.globalCompositeOperation = 'source-over';
  }
  // weld sparks: short bright streaks flying from the solder point
  if (!top && st.sparks && st.sparks.length) {
    R.globalCompositeOperation = 'lighter'; R.setTransform(M); R.lineCap = 'round';
    for (const sp of st.sparks) {
      const rnd = mulberry(500 + sp.seed * 13), u = sp.u;
      for (let k = 0; k < 16; k++) {
        const a = rnd() * Math.PI * 2, v = 40 + rnd() * 90, r0 = v * u * .55, r1 = r0 + 6 + 10 * (1 - u), g = 140 * u * u * rnd();
        const x0 = sp.x + Math.cos(a) * r0, y0 = sp.y + Math.sin(a) * r0 + g * .3, x1 = sp.x + Math.cos(a) * r1, y1 = sp.y + Math.sin(a) * r1 + g * .3 + 2;
        const A = (1 - u) * (1 - u);
        R.strokeStyle = `rgba(${255 * A | 0},${210 * A | 0},${140 * A | 0},1)`; R.lineWidth = 2.2 / Math.max(.6, cam[2]) * 1.6; R.beginPath(); R.moveTo(x0, y0); R.lineTo(x1, y1); R.stroke();
      }
    }
    R.setTransform(1, 0, 0, 1, 0, 0); R.globalCompositeOperation = 'source-over';
  }
  if (st.overlay) st.overlay(O, M);
  const mI = st.medLit[0] * st.sunI, oI = st.outerAvg * st.sunI;
  const lancets = [{ rect: [-R_OUT, -R_OUT, R_OUT, R_OUT], I: oI * .8 }, { rect: [-R_IN, -R_IN, R_IN, R_IN], I: mI * .6 }, { rect: [0, 0, 0, 0], I: 0 }, { rect: [0, 0, 0, 0], I: 0 }, { rect: [-R_IN, -R_IN, R_IN, R_IN], I: st.fireI * .5 }];
  comp.render(L, {
    cam, sunI: st.sunI, sunCol: st.sunCol, fireI: st.fireI, fireCol: st.fireCol, crackI: st.crackI,
    skyI: st.skyI, skyCol: st.skyCol, amb: st.amb, ambCol: st.ambCol, haze: st.haze ?? .55, raysK: 1, lancets, pts: st.pts || [],
    sweep: st.sweep, floorMode: st.floorMode || 0, floorY: FLOOR, camD: fl.camD, eyeH: fl.eyeH, patchK: st.patchK ?? 1.2, pmRect, topCam: st.topCam, pmSoft: st.pmSoft ?? 1,
    expo: st.expo ?? 1.1, bloom: st.bloom ?? .55, thr: st.thr ?? .5, vign: st.vign ?? .4, sat: st.sat ?? 1.1, contrast: st.contrast ?? .12, fade: st.fade || 0, tint: st.tint, time: st.time || 0,
  });
}
