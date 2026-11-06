/* ===== plates.js · painted plywood plates in a paper studio (from styles/11-bauhaus) =====
   PLATES.make(stage, { shapes:[{type, p:[a,b,c], col}], palette:[[r,g,b],...], cyc:{fy, wz, rc, col}, rm:{...} })
   -> { frame(t, plates[], cam, dof) }.  Each frame plate = { c:[x,y,z], q:[x,y,z,w] (local->world),
   k (world units per shape unit), th (half thickness), vis }.  Plates are traced analytically: ray/slab
   + 2D SDF march on the face, plywood edges, area-light soft shadows, softbox reflections, cyc studio.
   Shape types: 0 rect(hx,hy,ang) 1 half-disc(r,side) 2 disc(r) 3 tri(r) 4 ring(r,w) 5 quarter(r) 6 dots(step,r)
   7 rounded rect(hx,hy,rad) 8 arch(hw,h) (a door/arch: rect with a round top). */
(function () {
  const { clamp } = Reel;
  function make(stage, O) {
    const SH = O.shapes, NP = SH.length;
    const RAD = SH.map((s) => { const [a, b] = s.p; return s.type === 0 || s.type === 7 ? Math.hypot(a, b) : s.type === 8 ? Math.hypot(a, b) : s.type === 6 ? a * 3 + b : a * 1.05 + 0.01; });
    const PA = new Float32Array(SH.flatMap((s) => [0, 0, 0, s.type])), PB = new Float32Array(SH.flatMap((s) => [s.p[0], s.p[1], s.p[2] || 0, s.col]));
    const pal = (O.palette || [[0.6, 0.026, 0.02], [0.8, 0.4, 0.01], [0.007, 0.045, 0.21], [0.012, 0.012, 0.012]]).slice(0, 8);
    while (pal.length < 8) pal.push([0.5, 0.5, 0.5]);
    const PAL = new Float32Array(pal.flatMap((c) => [c[0], c[1], c[2], 0]));
    const cyc = Object.assign({ fy: -6.5, wz: -2.7, rc: 2.2, col: [0.64, 0.585, 0.49] }, O.cyc || {});
    const L = O.light || {}; const ld = L.dir || [-0.42, 0.6, 0.68], ll = Math.hypot(...ld);
    const f = (v) => (+v).toFixed(4);
    const rm = Reel.RM(stage, Object.assign({ bloom: 0.1, th: 1.6, expo: 0.84, vig: 0.28, grain: 0.02, ca: 0.3, contrast: 1.08, sat: 1.14, bands: 6 }, O.rm || {}, {
      uniforms: `
#define NP ${NP}
uniform vec4 PA[NP]; uniform vec4 PB[NP]; uniform vec4 PAL[8];
uniform vec4 uC[NP], uQ[NP], uR[NP];   // centre + k ; rotation quaternion ; bound radius, visible, half thickness, -
uniform vec3 uRo, uTa; uniform float uRoll, uF;
uniform int uN, uIt;`,
      scene: `
const float FY = ${f(cyc.fy)}, WZ = ${f(cyc.wz)}, RC = ${f(cyc.rc)};
const vec3 CYC = vec3(${cyc.col.map(f).join(',')});
const vec3 LDIR = vec3(${f(ld[0] / ll)}, ${f(ld[1] / ll)}, ${f(ld[2] / ll)});
const float LANG = ${f(L.ang ?? 0.085)};
vec3 PCOL(float c){ return PAL[int(clamp(c, 0., 7.) + .5)].rgb; }
float box2(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d,0.)) + min(max(d.x,d.y),0.); }
float tri2(vec2 p, float r){ const float k = 1.7320508; p.x = abs(p.x) - r; p.y = p.y + r/k;
  if (p.x + k*p.y > 0.) p = vec2(p.x - k*p.y, -k*p.x - p.y)/2.; p.x -= clamp(p.x, -2.*r, 0.); return -length(p)*sign(p.y); }
float sdS(int i, vec2 q){
  vec4 b = PB[i]; float ty = PA[i].w;
  if (ty < .5) { float c = cos(b.z), s = sin(b.z); q = mat2(c,-s,s,c)*q; return box2(q, b.xy); }
  if (ty < 1.5) { float d = length(q) - b.x; return b.y < .5 ? max(d, -q.x) : b.y < 1.5 ? max(d, q.x) : b.y < 2.5 ? max(d, -q.y) : max(d, q.y); }
  if (ty < 2.5) return length(q) - b.x;
  if (ty < 3.5) return tri2(q, b.x);
  if (ty < 4.5) return abs(length(q) - b.x) - b.y;
  if (ty < 5.5) return max(length(q) - b.x, max(-q.x, -q.y));
  if (ty < 6.5) { float k = clamp(floor(q.x/b.x) + .5, -2.5, 2.5); return length(q - vec2(k*b.x, 0.)) - b.y; }
  if (ty < 7.5) { vec2 d = abs(q) - b.xy + b.z; return length(max(d,0.)) + min(max(d.x,d.y),0.) - b.z; }
  { float r = b.x; vec2 p = q - vec2(0., b.y*.5 - r); float d = box2(q + vec2(0., r*.5), vec2(b.x, b.y*.5 - r*.5)); return min(d, max(length(p) - r, -p.y)); }
}
mat3 qmat(vec4 q){ float x=q.x,y=q.y,z=q.z,w=q.w;
  return mat3(1.-2.*(y*y+z*z), 2.*(x*y+z*w), 2.*(x*z-y*w),  2.*(x*y-z*w), 1.-2.*(x*x+z*z), 2.*(y*z+x*w),  2.*(x*z+y*w), 2.*(y*z-x*w), 1.-2.*(x*x+y*y)); }
float hitP(int i, vec3 ro, vec3 rd, float tMax, out vec3 nw, out float edge){
  edge = 0.; nw = vec3(0.,0.,1.);
  vec4 C = uC[i], Rr = uR[i];
  vec3 oc = ro - C.xyz; float bb = dot(oc, rd), cc = dot(oc, oc) - Rr.x*Rr.x; float h = bb*bb - cc;
  if (h < 0. || -bb - sqrt(h) > tMax || Rr.y < .5) return -1.;
  mat3 Rw = qmat(uQ[i]); mat3 Ri = transpose(Rw);
  vec3 o = Ri*oc, d = Ri*rd; float k = C.w, TH = Rr.z;
  float dz = abs(d.z) < 1e-4 ? 1e-4 : d.z;
  float ta = (-TH - o.z)/dz, tb = (TH - o.z)/dz;
  float t0 = max(min(ta, tb), 1e-3), t1 = max(ta, tb);
  if (t1 < t0) return -1.;
  vec2 q = (o.xy + d.xy*t0)/k; float s = sdS(i, q);
  if (s <= 0.) { nw = Rw*vec3(0., 0., -sign(dz)); return t0; }
  float sp = length(d.xy)/k; if (sp < 1e-5) return -1.;
  float t = t0;
  for (int j=0;j<uIt;j++){ t += s/sp; if (t > t1) return -1.; q = (o.xy + d.xy*t)/k; s = sdS(i, q); if (s < 2e-4) break; }
  if (s > 2e-3) return -1.;
  vec2 g = normalize(vec2(sdS(i, q + vec2(1e-3, 0.)) - s, sdS(i, q + vec2(0., 1e-3)) - s));
  nw = Rw*vec3(g, 0.);
  edge = 1. + clamp((o.z + d.z*t)/TH*.5 + .5, 0., 1.);
  return t;
}
float hitCyc(vec3 ro, vec3 rd, out vec3 n){
  float tb = 1e9; n = vec3(0., 1., 0.);
  if (rd.z < 0.) { float t = (WZ - ro.z)/rd.z; vec3 p = ro + rd*t; if (p.y >= FY + RC && t > 0.) { tb = t; n = vec3(0.,0.,1.); } }
  if (rd.y < 0.) { float t = (FY - ro.y)/rd.y; vec3 p = ro + rd*t; if (p.z >= WZ + RC && t > 0. && t < tb) { tb = t; n = vec3(0.,1.,0.); } }
  vec2 c = vec2(FY + RC, WZ + RC), o = ro.yz - c, d = rd.yz;
  float a = dot(d,d), b = dot(o,d), cc = dot(o,o) - RC*RC, h = b*b - a*cc;
  if (h > 0. && a > 1e-6) { float t = (-b + sqrt(h))/a; vec3 p = ro + rd*t; if (t > 0. && t < tb && p.y <= c.x && p.z <= c.y) { tb = t; n = vec3(0., normalize(c - p.yz)); } }
  return tb;
}
float shadowAt(vec3 p){
  float sh = 1.; float tl = tan(LANG);
  for (int i=0;i<uN;i++){
    vec4 C = uC[i], Rr = uR[i]; if (Rr.y < .5) continue;
    vec3 pc = C.xyz - p; float along = dot(pc, LDIR); if (along < 0.) continue;
    if (length(pc - LDIR*along) > Rr.x + along*tl*1.5) continue;
    mat3 Ri = transpose(qmat(uQ[i]));
    vec3 o = Ri*(p - C.xyz), d = Ri*LDIR; if (abs(d.z) < 1e-3) continue;
    float t = -o.z/d.z; if (t < .02) continue;
    float s = sdS(i, (o.xy + d.xy*t)/C.w)*C.w;
    sh = min(sh, smoothstep(-1., 1., s/(t*tl)));
  }
  return sh;
}
float rectL(vec3 r, vec3 c, vec3 up, vec2 hs, float soft){
  float cz = dot(r, c); if (cz <= 0.) return 0.;
  vec3 u = normalize(cross(up, c)), v = cross(c, u); vec2 q = vec2(dot(r,u), dot(r,v))/cz;
  vec2 e = smoothstep(hs + soft, hs - soft, abs(q)); return e.x*e.y;
}
vec3 env(vec3 r){
  vec3 c = mix(vec3(.62,.6,.56), vec3(.9,.88,.84), smoothstep(-.3, .8, r.y));
  c += vec3(1.,.97,.92)*7.*rectL(r, LDIR, vec3(0.,1.,0.), vec2(.38,.28), .1);
  c += vec3(.9,.94,1.)*1.6*rectL(r, normalize(vec3(.8,.25,.55)), vec3(0.,1.,0.), vec2(.12,.5), .08);
  return c;
}
vec3 render(vec2 fc){
  vec2 uv = (2.*fc - uRes)/uRes.y;
  vec3 ro = uRo;
  vec3 rd = camMat(ro, uTa, uRoll)*normalize(vec3(uv, uF));
  float tBest = 1e9; vec3 nB = vec3(0.); float eB = 0.; int iB = -1;
  for (int i=0;i<uN;i++){ vec3 nw; float ed; float t = hitP(i, ro, rd, tBest, nw, ed); if (t > 0. && t < tBest) { tBest = t; nB = nw; eB = ed; iB = i; } }
  vec3 nc; float tc = hitCyc(ro, rd, nc);
  if (iB < 0 && tc > 1e8) { gDepth = 60.; return CYC*1.75; }
  bool plate = iB >= 0 && tBest < tc;
  float t = plate ? tBest : tc;
  vec3 p = ro + rd*t, n = plate ? nB : nc;
  if (dot(n, rd) > 0.) n = -n;
  gDepth = t;
  vec3 alb;
  if (plate) {
    if (eB > .5) { float layer = fract((eB - 1.)*5.); alb = mix(vec3(.62,.46,.28), vec3(.74,.58,.38), smoothstep(.0, .2, layer)*smoothstep(1., .8, layer)); alb *= .9 + .1*vnoise(p*vec3(40.,40.,4.)); }
    else { alb = PCOL(PB[iB].w); alb *= .97 + .05*vnoise(p*24.); }
  } else { alb = CYC; alb *= .985 + .03*vnoise(p*3.); }
  float sh = shadowAt(p + n*.002);
  float ndl = max(dot(n, LDIR), 0.);
  vec3 col0 = alb * vec3(1.,.96,.9) * 2.0 * ndl * sh;
  col0 += alb * vec3(.62,.66,.74) * .42 * (.55 + .45*n.y);
  col0 += alb * vec3(.95,.93,.9) * .3 * max(dot(n, normalize(vec3(.15,.1,1.))), 0.);
  col0 += alb * vec3(.82,.76,.66) * .16 * max(-n.y, 0.);
  if (plate) { float F = schlick(max(dot(n, -rd), 0.), .035); vec3 r = reflect(rd, n); col0 = col0*(1. - F) + env(r)*F*(eB > .5 ? .25 : 1.); }
  else col0 *= .9 + .18*exp(-dot(p.xy - vec2(-.6, .8), p.xy - vec2(-.6, .8))*.05);
  ${O.extra || ''}
  return col0;
}`,
    }));
    function frame(t, P, cam, dof = {}) {
      const UC = new Float32Array(NP * 4), UQ = new Float32Array(NP * 4), UR = new Float32Array(NP * 4);
      for (let i = 0; i < NP; i++) {
        const p = P[i] && P[i].vis ? P[i] : { vis: 0, c: [0, 0, 0], q: [0, 0, 0, 1], k: 1 };
        UC.set([p.c[0], p.c[1], p.c[2], p.k], i * 4); UQ.set(p.q || [0, 0, 0, 1], i * 4);
        UR.set([RAD[i] * p.k + (p.th ?? 0.028) + 0.06, p.vis ? 1 : 0, p.th ?? 0.028, 0], i * 4);
      }
      rm.setArr('uC', UC); rm.setArr('uQ', UQ); rm.setArr('uR', UR); rm.setArr('PA', PA); rm.setArr('PB', PB); rm.setArr('PAL', PAL);
      rm.set('uN', { __ints: true, v: NP }); rm.set('uIt', { __ints: true, v: 8 });
      rm.set('uRo', cam.ro).set('uTa', cam.ta).set('uRoll', cam.roll || 0).set('uF', cam.f);
      const focus = dof.focus ?? Math.hypot(cam.ro[0] - cam.ta[0], cam.ro[1] - cam.ta[1], cam.ro[2] - cam.ta[2]);
      rm.render(t, { focus, aperture: (dof.ap ?? 0) * 110, maxCoc: (dof.ap ?? 0) * 9 });
    }
    return { frame, rm, NP };
  }
  // quaternion helpers
  const Q = {
    axis: (ax, ay, az, a) => { const l = Math.hypot(ax, ay, az) || 1, s = Math.sin(a / 2); return [ax / l * s, ay / l * s, az / l * s, Math.cos(a / 2)]; },
    mul: (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]],
    slerp: (a, b, t) => { let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; let bb = b; if (d < 0) { d = -d; bb = b.map((v) => -v); } if (d > 0.9995) { const r = a.map((v, i) => v + (bb[i] - v) * t); const l = Math.hypot(...r); return r.map((v) => v / l); } const th = Math.acos(d), s = Math.sin(th); return a.map((v, i) => (v * Math.sin((1 - t) * th) + bb[i] * Math.sin(t * th)) / s); },
    I: [0, 0, 0, 1],
  };
  // world point -> screen (design px) for a camera {ro, ta, roll, f}
  function proj(cam, P) {
    const n = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const w = n(cam.ta.map((v, i) => v - cam.ro[i])), u = n(cr(w, [Math.sin(cam.roll || 0), Math.cos(cam.roll || 0), 0])), v = cr(u, w);
    const d = P.map((x, i) => x - cam.ro[i]); const z = dt(d, w);
    return [960 + dt(d, u) / z * cam.f * 540, 540 - dt(d, v) / z * cam.f * 540, z];
  }
  function orbit(ta, az, el, dist) { return [ta[0] + dist * Math.sin(az) * Math.cos(el), ta[1] + dist * Math.sin(el), ta[2] + dist * Math.cos(az) * Math.cos(el)]; }
  window.PLATES = { make, Q, proj, orbit };
})();
