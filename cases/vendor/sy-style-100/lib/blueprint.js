/* ===== blueprint.js · living technical drawing -> real product (from styles/20-blueprint) =====
   BP.make(stage, { map, real, detail, uniforms, foc, floorY, env, bg }) -> { rm, set, render(t, cam, o) }
   map:    GLSL  vec2 obj(vec3 p)                   distance + part id (> 0) of the product in world space
   real:   GLSL  vec3 shadeReal(vec3 p, vec3 rd, vec3 n, float id)   the photographed material of each part
   detail: GLSL  float detail(vec3 p, vec3 n, float id, float px)    extra drawing lines (threads, grooves...)
   The drawing finds silhouettes (near misses of the ray) and creases (normal jumps) itself; a plotter reveal
   sweeps along an axis; a section plane can cut the parts (hatched in the drawing); a scan line turns the
   drawing into the real render. Overlay helpers: BP.overlay(stage) -> { ctx, begin, project, callout, dim, axis, title }. */
(function () {
  const { E, clamp, lerp } = Reel;
  function make(stage, o) {
    const FOC = o.foc || 4.0;
    const rm = Reel.RM(stage, Object.assign({
      bloom: 0.35, th: 1.2, expo: 1.0, vig: 0.3, grain: 0.02, ca: 0.4, contrast: 1.03, sat: 1.0, bands: 10,
      uniforms: `uniform vec3 uRo, uTa; uniform float uRoll, uScan, uFade, uRevA, uRevB; uniform vec3 uRevDir; uniform vec4 uBound; uniform vec4 uCut; uniform float uCutOn;
uniform vec2 uSweep; uniform float uFloorY, uFloorOn, uT;
${o.uniforms || ''}`,
      scene: `
${o.fns || ''}
${o.map}
vec2 objC(vec3 p){ vec2 d = obj(p); if (uCutOn > .5){ float pl = dot(p, uCut.xyz) - uCut.w; if (pl > d.x){ d.x = pl; } } return d; }
float mapS(vec3 p){ return objC(p).x; }
vec3 nrm(vec3 p){ const vec2 k = vec2(1.,-1.)*.0006; return normalize(k.xyy*mapS(p+k.xyy) + k.yyx*mapS(p+k.yyx) + k.yxy*mapS(p+k.yxy) + k.xxx*mapS(p+k.xxx)); }
vec2 sphHit(vec3 ro, vec3 rd){ vec3 oc = ro - uBound.xyz; float b = dot(oc, rd), c = dot(oc, oc) - uBound.w*uBound.w; float h = b*b - c; if (h < 0.) return vec2(1., -1.); h = sqrt(h); return vec2(-b - h, -b + h); }
vec4 marchBP(vec3 ro, vec3 rd, float px, out float gapT){
  float mw = 1e3; gapT = 0.; float idh = -1.;
  vec2 bb = sphHit(ro, rd); if (bb.y < max(bb.x, 0.)) return vec4(-1., -1., 1e3, 0.);
  float t = max(bb.x, 0.);
  for (int i=0;i<160;i++){
    vec2 h = objC(ro + rd*t);
    float w = h.x/(t*px);
    if (w < mw){ mw = w; gapT = t; }
    if (h.x < .0004*t){ idh = h.y; break; }
    t += h.x*.9; if (t > bb.y){ t = -1.; break; }
  }
  return vec4(t, idh, mw, 0.);
}
vec3 bpPaper(vec2 fc){
  vec2 uv = fc/uRes;
  vec3 c = mix(vec3(.0035,.026,.13), vec3(.008,.052,.25), smoothstep(1.2, .1, length((uv - vec2(.5,.55))*vec2(1.4,1.))));
  vec2 g = fc/(uRes.y/54.), gm = fc/(uRes.y/10.8);
  float minor = max(smoothstep(.06, 0., abs(fract(g.x)-.5) - .44), smoothstep(.06, 0., abs(fract(g.y)-.5) - .44));
  float major = max(smoothstep(.04, 0., abs(fract(gm.x)-.5) - .485), smoothstep(.04, 0., abs(fract(gm.y)-.5) - .485));
  c += vec3(.35,.5,1.)*(minor*.022 + major*.05);
  c *= .92 + .08*fbm2(fc*.02);
  return c;
}
${o.detail || 'float detail(vec3 p, vec3 n, float id, float px){ return 0.; }'}
vec3 blueprint(vec2 fc, vec3 ro, vec3 rd, float px){
  vec3 c = bpPaper(fc);
  float gapT; vec4 h = marchBP(ro, rd, px, gapT);
  float line = 0., hatch = 0.;
  float sil = smoothstep(1.7, .55, h.z);
  if (h.x < 0. || h.x - gapT > .25) line = max(line, sil);
  vec3 pref = h.x > 0. ? ro + rd*h.x : ro + rd*gapT;
  if (h.x > 0.){
    vec3 p = ro + rd*h.x; vec3 n = nrm(p);
    vec3 tA = normalize(cross(n, abs(n.y) < .9 ? vec3(0.,1.,0.) : vec3(1.,0.,0.))), tB = cross(n, tA);
    float o = h.x*px*2.2;
    float cr = min(dot(n, nrm(p + tA*o)), dot(n, nrm(p + tB*o)));
    line = max(line, smoothstep(.93, .7, cr));
    c += vec3(.1,.22,.6)*.07*(.5 + .5*dot(n, normalize(vec3(-.4,.6,.7))));
    line = max(line, detail(p, n, h.y, h.x*px));
    // section faces: 45-degree hatching
    if (uCutOn > .5 && abs(dot(p, uCut.xyz) - uCut.w) < .002){ vec2 sp = fc/(uRes.y/90.); hatch = smoothstep(.16, .04, abs(fract((sp.x + sp.y)*.5) - .5)); }
  }
  float xr = dot(pref, uRevDir);
  float reveal = smoothstep(uRevA, uRevA - .35, xr);
  float tip = exp(-pow((xr - uRevA + .12)/.1, 2.))*step(uRevA, uRevB);
  vec3 ink = vec3(.82,.88,1.);
  c = mix(c, ink + vec3(.6,1.,2.2)*tip, line*max(reveal, tip));
  c = mix(c, ink, hatch*.55*reveal);
  return c;
}
${o.real}
vec3 realRender(vec3 ro, vec3 rd){
  float gapT; vec4 h = marchBP(ro, rd, .001, gapT);
  float tf = uFloorOn > .5 && rd.y < 0. ? (uFloorY - ro.y)/rd.y : 1e9;
  vec3 bg = ${o.bg || 'mix(vec3(.006,.007,.009), vec3(.02,.022,.028), smoothstep(-.2, .5, rd.y)) + vec3(.05,.058,.075)*exp(-pow(length(rd.xy - vec2(.12,.08))/.42, 2.))'};
  if (h.x > 0. && h.x < tf){ gDepth = h.x; vec3 p = ro + rd*h.x; return shadeReal(p, rd, nrm(p), h.y); }
  if (tf < 1e8){
    vec3 p = ro + rd*tf; gDepth = tf;
    ${o.floor || `vec3 c = vec3(.012,.013,.016) + vec3(.05,.052,.06)*exp(-dot(p.xz - uBound.xz, p.xz - uBound.xz)*.3);
    vec3 rr = reflect(rd, vec3(0.,1.,0.)); float g2; vec4 h2 = marchBP(p, rr, .001, g2);
    if (h2.x > 0.){ vec3 q = p + rr*h2.x; c += shadeReal(q, rr, nrm(q), h2.y)*.14*exp(-(q.y - uFloorY)*2.); }
    return mix(c, bg, smoothstep(4., 12., length(p.xz - uBound.xz)));`}
  }
  gDepth = 40.; return bg;
}
vec3 render(vec2 fc){
  vec2 uv = (2.*fc - uRes)/uRes.y;
  vec3 ro = uRo; vec3 rd = camMat(ro, uTa, uRoll)*normalize(vec3(uv, ${FOC.toFixed(2)}));
  float px = 2./(uRes.y*${FOC.toFixed(2)});
  float sy = 1. - fc.y/uRes.y;
  vec3 col; float edge = uScan - sy;
  if (edge > .004) col = realRender(ro, rd);
  else if (edge < -.004){ col = blueprint(fc, ro, rd, px); gDepth = 12.; }
  else col = mix(blueprint(fc, ro, rd, px), realRender(ro, rd), smoothstep(-.004, .004, edge));
  col += vec3(.45,.8,1.)*2.6*exp(-pow(edge/.0035, 2.))*step(.0, uScan)*step(uScan, 1.);
  col += vec3(.25,.55,1.)*.35*exp(-max(-edge, 0.)/.05)*step(edge, 0.)*step(.0, uScan)*step(uScan, 1.);
  return col*uFade;
}`,
    }, o.rm || {}));
    return { rm, FOC };
  }
  // ---------- 2D overlay: callouts, dimensions, axes, title block ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  function overlay(stage, FOC) {
    const { ctx: oc, begin } = Reel.canvas2d(stage);
    const INK = '#eaf3ff';
    let M = null, RO = null;
    function camera(ro, ta, roll = 0) { const w = norm(sub(ta, ro)); let u = norm(cross(w, [Math.sin(roll), Math.cos(roll), 0])); const v = cross(u, w); M = { u, v, w }; RO = ro; }
    function project(P) { const d = sub(P, RO); const z = dot(d, M.w); return [960 + dot(d, M.u) / z * FOC * 540, 540 - dot(d, M.v) / z * FOC * 540, z]; }
    function dim(a, b, txt, off, k, o = {}) {
      if (k <= 0) return; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
      const A = [a[0] + nx * off, a[1] + ny * off], B = [b[0] + nx * off, b[1] + ny * off];
      oc.globalAlpha = k; oc.strokeStyle = INK; oc.fillStyle = INK; oc.lineWidth = 1.6; oc.setLineDash([]); oc.beginPath();
      oc.moveTo(a[0] + nx * 6 * Math.sign(off), a[1] + ny * 6 * Math.sign(off)); oc.lineTo(a[0] + nx * (off + 10 * Math.sign(off)), a[1] + ny * (off + 10 * Math.sign(off)));
      oc.moveTo(b[0] + nx * 6 * Math.sign(off), b[1] + ny * 6 * Math.sign(off)); oc.lineTo(b[0] + nx * (off + 10 * Math.sign(off)), b[1] + ny * (off + 10 * Math.sign(off)));
      const Mi = [lerp(A[0], B[0], 0.5), lerp(A[1], B[1], 0.5)], g = E.outCubic(k);
      oc.moveTo(lerp(Mi[0], A[0], g), lerp(Mi[1], A[1], g)); oc.lineTo(lerp(Mi[0], B[0], g), lerp(Mi[1], B[1], g)); oc.stroke();
      const ah = (P, Q) => { const ux = (Q[0] - P[0]) / L, uy = (Q[1] - P[1]) / L; oc.beginPath(); oc.moveTo(P[0], P[1]); oc.lineTo(P[0] + ux * 16 + uy * 5, P[1] + uy * 16 - ux * 5); oc.lineTo(P[0] + ux * 16 - uy * 5, P[1] + uy * 16 + ux * 5); oc.closePath(); oc.fill(); };
      if (g > 0.98) { ah(A, B); ah(B, A); }
      oc.save(); oc.translate(Mi[0] + nx * 22 * Math.sign(off), Mi[1] + ny * 22 * Math.sign(off)); let ang = Math.atan2(dy, dx); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI; oc.rotate(ang);
      oc.font = `500 ${o.size || 24}px "Latin Modern Mono", monospace`; oc.textAlign = 'center'; oc.textBaseline = 'middle'; oc.fillText(txt, 0, 0); oc.restore(); oc.globalAlpha = 1;
    }
    function callout(anchor, num, label, bx, by, side, k, sub2) {
      if (k <= 0) return; oc.globalAlpha = Math.min(1, k * 1.5); oc.strokeStyle = INK; oc.fillStyle = INK; oc.lineWidth = 1.4;
      const elbow = [bx + (side < 0 ? 60 : -60), by], g = E.outCubic(clamp(k * 1.3));
      oc.beginPath(); oc.arc(anchor[0], anchor[1], 5, 0, Math.PI * 2); oc.fill();
      oc.beginPath(); oc.moveTo(anchor[0], anchor[1]); oc.lineTo(lerp(anchor[0], elbow[0], g), lerp(anchor[1], elbow[1], g)); if (g > 0.99) oc.lineTo(bx, by); oc.stroke();
      if (g > 0.99) {
        oc.beginPath(); oc.arc(bx, by, 22, 0, Math.PI * 2); oc.stroke();
        oc.font = '600 22px "Latin Modern Mono", monospace'; oc.textAlign = 'center'; oc.textBaseline = 'middle'; oc.fillText(num, bx, by + 1);
        oc.font = '500 26px "Noto Sans CJK SC"'; oc.textAlign = side < 0 ? 'right' : 'left'; oc.fillText(label, bx + (side < 0 ? -36 : 36), by + (sub2 ? -12 : 1));
        if (sub2) { oc.globalAlpha *= 0.7; oc.font = '500 18px "Latin Modern Mono", monospace'; oc.fillText(sub2, bx + (side < 0 ? -36 : 36), by + 18); }
      }
      oc.globalAlpha = 1;
    }
    function axis(a, b, k) { if (k <= 0) return; oc.globalAlpha = k * 0.7; oc.strokeStyle = INK; oc.lineWidth = 1.2; oc.setLineDash([34, 8, 4, 8]); oc.beginPath(); oc.moveTo(a[0], a[1]); oc.lineTo(b[0], b[1]); oc.stroke(); oc.setLineDash([]); oc.globalAlpha = 1; }
    function title(k, lines, x = 1340, y = 900, w = 520) {
      if (k <= 0) return; const h = 132; oc.globalAlpha = k; oc.strokeStyle = INK; oc.fillStyle = INK; oc.lineWidth = 1.6;
      oc.strokeRect(x, y, w, h); oc.beginPath(); oc.moveTo(x, y + 52); oc.lineTo(x + w, y + 52); oc.moveTo(x, y + 92); oc.lineTo(x + w, y + 92); oc.moveTo(x + 280, y + 52); oc.lineTo(x + 280, y + h); oc.stroke();
      oc.font = '500 27px "Noto Sans CJK SC"'; oc.textAlign = 'left'; oc.textBaseline = 'middle'; oc.fillText(lines[0], x + 18, y + 27);
      oc.font = '500 17px "Latin Modern Mono", monospace'; oc.fillText(lines[1], x + 18, y + 72); oc.fillText(lines[2], x + 298, y + 72); oc.fillText(lines[3], x + 18, y + 112); oc.fillText(lines[4], x + 298, y + 112); oc.globalAlpha = 1;
    }
    return { ctx: oc, begin, camera, project, dim, callout, axis, title, INK };
  }
  window.BP = { make, overlay };
})();
