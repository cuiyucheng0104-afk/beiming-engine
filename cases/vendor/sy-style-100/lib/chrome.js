/* ===== chrome.js · liquid-metal studio kit (from styles/14-liquid) =====
   CHROME.make(stage, { map: 'float mapL(vec3 p){...}' GLSL, uniforms: 'extra GLSL uniforms', metal: [r,g,b] F0,
     rm: {post options}, floorTone }) -> rm.  The kit supplies: smooth SDF helpers (from rm.js), a dark studio
   (overhead softbox, cool + magenta strips, frontal bounce, movable sweep bar), chrome shading with one
   inter-reflection bounce, a glossy black floor with contact shadows and reflections, bounding-box march.
   Per-frame uniforms: uRo, uTa, uF (focal), uBMin/uBMax (bounds), uSweep (angle, strength), uIrid, uFade, uStep, uMetal. */
(function () {
  function make(stage, O) {
    const m = O.metal || [0.97, 0.955, 0.93];
    return Reel.RM(stage, Object.assign({ bloom: 0.42, th: 1.4, expo: 1.12, vig: 0.42, grain: 0.028, ca: 0.6, contrast: 1.04, sat: 1.04, bands: 8 }, O.rm || {}, {
      uniforms: `
uniform vec3 uRo, uTa; uniform vec2 uSweep; uniform vec3 uBMin, uBMax; uniform float uIrid, uFade, uStep, uF, uRoll; uniform vec3 uMetal;
${O.uniforms || ''}`,
      scene: `
${O.map}
vec3 nrm(vec3 p){ const vec2 k = vec2(1.,-1.)*.0008;
  return normalize(k.xyy*mapL(p+k.xyy) + k.yyx*mapL(p+k.yyx) + k.yxy*mapL(p+k.yxy) + k.xxx*mapL(p+k.xxx)); }
vec2 boxHit(vec3 ro, vec3 rd){ vec3 iv = 1./rd; vec3 t0 = (uBMin-ro)*iv, t1 = (uBMax-ro)*iv;
  vec3 a = min(t0,t1), b = max(t0,t1); return vec2(max(max(a.x,a.y),a.z), min(min(b.x,b.y),b.z)); }
float marchL(vec3 ro, vec3 rd, int steps){
  vec2 bb = boxHit(ro, rd); if (bb.y < max(bb.x, 0.)) return -1.;
  float t = max(bb.x, 0.);
  for (int i=0;i<140;i++){ if(i>=steps) break; float h = mapL(ro + rd*t); if (h < .0005 + .0007*t) return t; t += h*uStep; if (t > bb.y) break; }
  return -1.;
}
float rectL(vec3 r, vec3 c, vec3 up, vec2 hs, float soft){
  float cz = dot(r, c); if (cz <= 0.) return 0.;
  vec3 u = normalize(cross(up, c)), v = cross(c, u); vec2 q = vec2(dot(r,u), dot(r,v)) / cz;
  vec2 e = smoothstep(hs + soft, hs - soft, abs(q)); return e.x * e.y;
}
vec3 env(vec3 r){
  vec3 c = mix(vec3(.004,.004,.007), ${O.warm ? 'vec3(.026,.02,.014)' : 'vec3(.016,.014,.026)'}, smoothstep(-.25, .8, r.y));
  c += vec3(1.,.96,.9) * 2.6 * rectL(r, normalize(vec3(0.,1.,.4)), vec3(0.,0.,1.), vec2(.8,.36), .2);
  c += vec3(.7,.84,1.) * 2.4 * rectL(r, normalize(vec3(-1.,.25,.3)), vec3(0.,1.,0.), vec2(.075,.75), .06);
  c += ${O.warm ? 'vec3(1.,.62,.3)' : 'vec3(1.,.38,.9)'} * 2.1 * rectL(r, normalize(vec3(1.,.2,-.1)), vec3(0.,1.,0.), vec2(.065,.65), .06);
  { vec3 fc = normalize(vec3(-.12,.34,1.)); float cz = dot(r, fc);
    if (cz > 0.) { vec3 u = normalize(cross(vec3(0.,1.,0.), fc)), v = cross(fc, u); vec2 q = vec2(dot(r,u), dot(r,v)) / cz;
      vec2 e = smoothstep(vec2(.5,.36) + .12, vec2(.5,.36) - .12, abs(q));
      c += vec3(.92,.9,1.) * .85 * e.x * e.y * (.04 + .96 * smoothstep(-.3, .42, q.y)); } }
  c += ${O.warm ? 'vec3(.7,.45,.22)' : 'vec3(.38,.26,.9)'} * .5 * smoothstep(.3, 1., dot(r, normalize(vec3(0.,.25,-1.))));
  if (uSweep.y > 0.) { vec3 sd = normalize(vec3(sin(uSweep.x), .14, cos(uSweep.x)));
    c += vec3(1.,.98,.95) * uSweep.y * rectL(r, sd, vec3(0.,1.,0.), vec2(.03,1.2), .03); }
  return c;
}
vec3 backdrop(vec3 rd){
  vec3 c = mix(vec3(.0032,.0032,.0055), vec3(.0075,.0065,.013), smoothstep(-.1, .55, rd.y));
  float g = exp(-pow(length(rd.xz - normalize(-uRo.xz + vec2(1e-4))) / .55, 2.)) * smoothstep(-.1, .3, rd.y);
  return c + ${O.warm ? 'vec3(.026,.016,.008)' : 'vec3(.014,.009,.028)'} * g;
}
float floorShadow(vec3 p){
  vec3 L = normalize(vec3(0.,1.,.4)); float s = 1.;
  s *= clamp(mapL(p + L*.06) / .05, 0., 1.);
  s *= clamp(.25 + .75 * mapL(p + L*.28) / .25, 0., 1.);
  s *= clamp(.45 + .55 * mapL(p + L*.75) / .7, 0., 1.);
  return s;
}
vec3 floorBase(vec3 p){
  float r2 = dot(p.xz, p.xz);
  float mot = .82 + .18 * fbm(vec3(p.xz*1.3, 0.));
  return (vec3(.003,.003,.0045) + vec3(.021,.02,.027) * exp(-r2*.4) + vec3(.006,.004,.012) * exp(-r2*.09)) * mot * ${(O.floorTone || 1).toFixed(3)};
}
vec3 floorInReflection(vec3 p, vec3 r){
  float tf = -p.y / r.y; vec3 fp = p + r*tf;
  return floorBase(fp) * mix(.35, 1., floorShadow(fp)) * 1.6 + vec3(.05,.045,.06) * exp(-tf*1.2);
}
vec3 shadeChrome(vec3 p, vec3 rd, vec3 n, bool bounce){
  vec3 r = reflect(rd, n);
  float cosT = max(dot(n, -rd), 0.);
  float th = fbm(p*1.6 + vec3(0., uTime*.12, 0.))*1.1 + cosT*.6 + .18;
  vec3 tint = mix(vec3(1.), thinFilm(th)*1.2, uIrid * (.15 + .85 * pow(1. - cosT, 1.4)));
  vec3 F0 = uMetal * tint;
  vec3 F = F0 + (1. - F0) * pow(1. - cosT, 5.);
  vec3 refl;
  float t2 = bounce ? marchL(p + n*.012, r, 40) : -1.;
  if (t2 > 0.) { vec3 p2 = p + n*.012 + r*t2; vec3 n2 = nrm(p2); vec3 r2 = reflect(r, n2); refl = (r2.y < 0. ? floorInReflection(p2, r2) : env(r2)) * uMetal; }
  else { vec3 fl = r.y < .06 ? floorInReflection(p, vec3(r.x, min(r.y, -.02), r.z)) : vec3(0.); refl = mix(fl, env(r), smoothstep(-.12, .06, r.y)); }
  float ao = clamp(.45 + .55 * mapL(p + n*.14) / .14, 0., 1.);
  return refl * F * ao;
}
vec3 render(vec2 fc){
  vec2 uv = (2.*fc - uRes) / uRes.y;
  vec3 ro = uRo;
  vec3 rd = camMat(ro, uTa, uRoll) * normalize(vec3(uv, uF));
  float t = marchL(ro, rd, 120);
  float tf = rd.y < 0. ? -ro.y / rd.y : 1e9;
  vec3 col;
  if (t > 0. && t < tf) { vec3 p = ro + rd*t; col = shadeChrome(p, rd, nrm(p), true); gDepth = t; }
  else if (tf < 1e8) {
    vec3 p = ro + rd*tf; gDepth = tf;
    float sh = floorShadow(p);
    vec3 c = floorBase(p) * mix(.2, 1., sh);
    vec3 rr = reflect(rd, vec3(0.,1.,0.));
    float tr = marchL(p + vec3(0.,.002,0.), rr, 64);
    float fr = .05 + .95 * pow(1. - max(-rd.y, 0.), 5.);
    if (tr > 0.) { vec3 q = p + rr*tr; c += shadeChrome(q, rr, nrm(q), false) * mix(.3, .68, fr) * exp(-tr*.6); }
    else c += env(rr) * .022;
    col = mix(c, backdrop(rd), smoothstep(3.2, 9., length(p.xz)));
  } else { col = backdrop(rd); gDepth = 60.; }
  ${O.extra || ''}
  return col * uFade;
}`,
    }));
  }
  // set the common per-frame uniforms
  function common(rm, P) {
    rm.set('uRo', P.ro).set('uTa', P.ta).set('uF', P.f ?? 2.9).set('uRoll', P.roll ?? 0).set('uBMin', P.mn).set('uBMax', P.mx).set('uSweep', P.sweep || [0, 0]).set('uIrid', P.irid ?? 0.1).set('uFade', P.fade ?? 1).set('uStep', P.step ?? 0.8).set('uMetal', P.metal || [0.97, 0.955, 0.93]);
  }
  window.CHROME = { make, common };
})();
