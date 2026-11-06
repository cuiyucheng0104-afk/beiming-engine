/* Helpers: CLAY.drop(t, t0, h, dur) -> { y, sq, on } a fall with a squash on landing and a little bounce. */
/* ===== clay.js · plasticine stop-motion kit (shading from styles/19-clay) =====
   CLAY.make(stage, { n, floor, decal, extraMap, extraAlbedo, rm }) -> { set(objs), render(t, cam, o), rm, decal }
   A scene is a list of clay objects, each { t: type, p: [x,y,z], r: [yaw,pitch,roll], s: [a,b,c,d], c: '#hex' | [r,g,b],
   g: group (objects with the same group melt together with radius k), k, gloss, fp (fingerprints), sq (squash) }.
   Types: 0 ellipsoid(rx,ry,rz)  1 round box(hx,hy,hz,round)  2 capsule(r, halfLen, taper)  3 torus(R, r)
          4 round cylinder(r, halfH, round)  5 cone frustum(rBottom, halfH, rTop, round)  6 heart(size, thick, round)
          7 star(R, inner, thick, round)  8 arc tube(R, r, angle)  9 drop/teardrop(r, h)  10 decal sign = round box with
          the decal canvas printed on its +z face.
   The kit supplies the floor (clay mat or wooden board), a painted backdrop card with fairy-light bokeh, boiling
   surfaces that change every drawing, fingerprints, wrap lighting with warm subsurface, soft shadows and AO. */
(function () {
  const { clamp } = Reel;
  const hex = (c) => Array.isArray(c) ? c : [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255].map((v) => Math.pow(v, 2.2));
  function quat(yaw = 0, pitch = 0, roll = 0) {
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
    // q = qYaw(y) * qPitch(x) * qRoll(z)
    const a = [0, sy, 0, cy], b = [sp, 0, 0, cp], c = [0, 0, sr, cr];
    const m = (q, r) => [q[3] * r[0] + q[0] * r[3] + q[1] * r[2] - q[2] * r[1], q[3] * r[1] - q[0] * r[2] + q[1] * r[3] + q[2] * r[0], q[3] * r[2] + q[0] * r[1] - q[1] * r[0] + q[2] * r[3], q[3] * r[3] - q[0] * r[0] - q[1] * r[1] - q[2] * r[2]];
    return m(m(a, b), c);
  }
  function make(stage, o = {}) {
    const N = o.n || 24;
    const decalCv = document.createElement('canvas'); decalCv.width = (o.decalSize || [1024, 512])[0]; decalCv.height = (o.decalSize || [1024, 512])[1]; const decal = decalCv.getContext('2d');
    const rm = Reel.RM(stage, Object.assign({
      bloom: 0.3, th: 1.15, expo: 0.92, vig: 0.48, grain: 0.03, ca: 0.4, contrast: 1.14, sat: 1.1, bands: 12,
      uniforms: `
#define NOBJ ${N}
uniform vec4 uOP[NOBJ], uOQ[NOBJ], uOS[NOBJ], uOC[NOBJ], uOX[NOBJ], uOM[NOBJ]; uniform vec4 uBound;
uniform float uN;
uniform vec3 uRo, uTa; uniform float uFov, uRoll, uFrame, uFlick;
uniform vec3 uLdir, uKey, uSky0, uSky1, uFloorC, uBulb;
uniform float uFloorType, uBackZ, uBulbs, uBulbY;
uniform sampler2D uDecal;
${o.uniforms || ''}`,
      scene: `
bool gCheap = false;
vec3 qrot(vec4 q, vec3 v){ return v + 2.*cross(q.xyz, cross(q.xyz, v) + q.w*v); }
float boil(vec3 p, float a){ return (vnoise(p*7.3 + uFrame*1.37) - .5)*a + (vnoise(p*3.1 + 4.2 + uFrame*.31) - .5)*a*1.2; }
float sdHeart2(vec2 p){ p.x = abs(p.x); if (p.y + p.x > 1.) return sqrt(dot(p - vec2(.25,.75), p - vec2(.25,.75))) - sqrt(2.)/4.;
  vec2 a = p - vec2(0.,1.), b = p - .5*max(p.x + p.y, 0.); return sqrt(min(dot(a,a), dot(b,b)))*sign(p.x - p.y); }
float sdStar2(vec2 p, float r, float rf){ const vec2 k1 = vec2(.809016994375, -.587785252292); const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x); p -= 2.*max(dot(k1,p),0.)*k1; p -= 2.*max(dot(k2,p),0.)*k2; p.x = abs(p.x); p.y -= r;
  vec2 ba = rf*vec2(-k1.y,k1.x) - vec2(0,1); float h = clamp(dot(p,ba)/dot(ba,ba), 0., r); return length(p - ba*h)*sign(p.y*ba.x - p.x*ba.y); }
float sdCone(vec3 p, float r1, float h, float r2){ vec2 q = vec2(length(p.xz), p.y); vec2 k1 = vec2(r2, h), k2 = vec2(r2 - r1, 2.*h);
  vec2 ca = vec2(q.x - min(q.x, (q.y < 0.) ? r1 : r2), abs(q.y) - h); vec2 cb = q - k1 + k2*clamp(dot(k1 - q, k2)/dot(k2,k2), 0., 1.);
  float s = (cb.x < 0. && ca.y < 0.) ? -1. : 1.; return s*sqrt(min(dot(ca,ca), dot(cb,cb))); }
float objD(int i, vec3 p, out vec3 q){
  vec4 P = uOP[i], S = uOS[i], X = uOX[i];
  q = qrot(vec4(-uOQ[i].xyz, uOQ[i].w), p - P.xyz);
  float sq = X.w; q.y /= sq; q.xz *= sqrt(sq);
  int ty = int(P.w + .5); float d;
  if (ty == 0) d = sdEllipsoid(q, S.xyz);
  else if (ty == 1 || ty == 10) d = sdRoundBox(q, S.xyz, S.w);
  else if (ty == 2) { float h = clamp(q.y/(2.*S.y) + .5, 0., 1.); d = sdCapsule(q, vec3(0.,-S.y,0.), vec3(0.,S.y,0.), S.x*mix(1., S.z, h)); }
  else if (ty == 3) d = sdTorus(q, S.xy);
  else if (ty == 4) d = sdRoundCylinder(q, S.x, S.z, S.y);   // (JS passes radius/2 and halfH - round)
  else if (ty == 5) d = sdCone(q, S.x, S.y, S.z) - S.w;
  else if (ty == 6) { d = extrude(sdHeart2(q.xy/S.x + vec2(0.,.55))*S.x, q.z, S.y) - S.z; }
  else if (ty == 7) { d = extrude(sdStar2(q.xy, S.x, S.y), q.z, S.z) - S.w; }
  else if (ty == 11) { d = extrude(abs(sdStar2(q.xy, S.x, S.y)) - S.w, q.z, S.z) - .004; }
  else if (ty == 8) { float a = atan(q.y, q.x); float am = clamp(a, -S.z, S.z); vec3 c = vec3(cos(am)*S.x, sin(am)*S.x, 0.); d = length(q - c) - S.y; }
  else { d = smin(sdEllipsoid(q - vec3(0., S.x*.3, 0.), vec3(S.x, S.x*.95, S.x)), sdCapsule(q, vec3(0.,S.x*.3,0.), vec3(0.,S.y,0.), S.x*.08), S.x*.9); }
  return d*min(sq, 1.);
}
float fingerprint(vec3 q, float seed){
  vec3 c = floor(q*5. + seed); vec3 f = q*5. + seed - c; vec3 cp = hash33(c);
  float r = length(f - cp)*.2 + (vnoise(q*18.) - .5)*.012;
  return sin(r*260.)*smoothstep(.13, .03, r)*smoothstep(.45, .7, vnoise(q*6. + seed));
}
// objects; returns distance and object index (for the albedo)
// per-ray candidate lists: only objects whose bounding sphere the ray (or a neighbourhood) touches are evaluated
int gC[32]; int gNC = 0;
void cullRay(vec3 ro, vec3 rd, float tmax){ gNC = 0; int n = int(uN + .5);
  for (int i=0;i<NOBJ;i++){ if (i >= n) break; float R = uOX[i].y + uOX[i].x + .04; vec3 oc = uOP[i].xyz - ro; float tc = dot(oc, rd);
    float d2 = dot(oc, oc) - tc*tc; if (tc > -R && tc < tmax + R && d2 < R*R && gNC < 32){ gC[gNC] = i; gNC++; } } }
void cullNear(vec3 p, float rad){ gNC = 0; int n = int(uN + .5);
  for (int i=0;i<NOBJ;i++){ if (i >= n) break; float R = uOX[i].y + uOX[i].x + rad; if (length(uOP[i].xyz - p) < R && gNC < 32){ gC[gNC] = i; gNC++; } } }
vec2 objects(vec3 p, float best){
  float db = length(p - uBound.xyz) - uBound.w; if (db > .06) return vec2(db, -9.);
  vec2 r = vec2(1e3, -1.); float gd = 1e3, gid = -1.; float gi = -1.;
  for (int j=0;j<32;j++){
    if (j >= gNC) break;
    int i = gC[j];
    vec4 X = uOX[i];
    if (X.y <= 0.) continue;
    float g = uOC[i].w;
    if (g != gid){ if (gd < r.x) r = vec2(gd, gi); gd = 1e3; gid = g; }
    float bnd = length(p - uOP[i].xyz) - X.y;
    if (bnd > min(best, min(r.x, gd)) + X.x + .02){ continue; }
    vec3 q; float d = objD(i, p, q);
    if (d < .04 && !gCheap && uOX[i].z < 2.){ d += boil(q*1.3 + float(i)*3.1, .010*clamp(.22/X.y, .3, 1.)); if (mod(uOM[i].x, 1000.) < 99.) d += fingerprint(q, float(i))*.0009; }
    if (X.x > 0. && gd < 1e2){ float h = clamp(.5 + .5*(gd - d)/X.x, 0., 1.); if (d < gd) gi = float(i); gd = mix(gd, d, h) - X.x*h*(1. - h); }
    else if (d < gd){ gd = d; gi = float(i); }
  }
  if (gd < r.x) r = vec2(gd, gi);
  return r;
}
${o.extraMapFns || ''}
// objects + bulbs + custom geometry (the floor and backdrop are analytic planes, intersected directly)
vec2 mapO(vec3 p){
  vec2 r = vec2(1e3, -5.);
  if (uBulbs > .5 && p.z + uBackZ < 1.2){
    for (int i=0;i<9;i++){ float fi = float(i); vec3 lp = vec3(-3.6 + fi*.9, uBulbY - .3*sin(fi*.85 + .3) - .2*sin(fi*2.1), -uBackZ + .5);
      float b = length(p - lp) - .06; if (b < r.x) r = vec2(b, -3.); }
  }
  ${o.extraMap || ''}
  vec2 ob = objects(p, r.x); if (ob.x < r.x) r = ob;
  return r;
}
float mapS(vec3 p){ return mapO(p).x; }
vec3 nrm(vec3 p, float t){ vec2 k = vec2(1.,-1.)*(.0006 + .0002*t);
  return normalize(k.xyy*mapS(p+k.xyy) + k.yyx*mapS(p+k.yyx) + k.yxy*mapS(p+k.yxy) + k.xxx*mapS(p+k.xxx)); }
float shadow(vec3 ro){ float res = 1., t = .02, ph = 1e10; gCheap = true;
  for (int i=0;i<34;i++){ vec2 hm = mapO(ro + uLdir*t); float h = hm.x; if (hm.y > -8.5 && h < 1e2){ float y = h*h/(2.*ph); float dd = sqrt(max(h*h - y*y, 0.)); res = min(res, 8.*dd/max(1e-4, t - y)); ph = h; } t += clamp(h, .012, .16); if (res < .002 || t > 4.) break; }
  gCheap = false; return smoothstep(0., 1., clamp(res, 0., 1.)); }
float ao(vec3 p, vec3 n){ float o = 0., s = 1.; gCheap = true; for (int i=0;i<4;i++){ float h = .02 + .08*float(i); vec3 q = p + n*h; vec2 hm = mapO(q); o += (h - min(hm.y > -8.5 ? hm.x : 1e3, q.y))*s; s *= .7; } gCheap = false; return clamp(1. - 2.4*o, 0., 1.); }
vec3 objAlbedo(int i, vec3 p, out float gloss, out float seam){
  // blend the colours of melted neighbours in the same group
  vec3 q; float d0 = objD(i, p, q); vec3 c = uOC[i].rgb; gloss = uOX[i].z; seam = 1.;
  int n = int(uN + .5); float g = uOC[i].w;
  if (uOX[i].x > 0.){ float wsum = 1.; vec3 acc = c; float d1 = 1e3;
    for (int j=0;j<NOBJ;j++){ if (j >= n) break; if (j == i || uOC[j].w != g || uOX[j].y <= 0.) continue; vec3 qj; float dj = objD(j, p, qj); float w = exp(-max(dj - d0, 0.)*90.)*.999; acc += uOC[j].rgb*w; wsum += w; d1 = min(d1, dj); }
    c = acc/wsum; seam = smoothstep(0., .02, abs(d1 - d0) + .003); }
  if (int(uOP[i].w + .5) == 10){ vec2 uv = vec2(.5 + q.x/(2.*uOS[i].x), .5 - q.y/(2.*uOS[i].y)); if (q.z > uOS[i].z*.5 && uv.x > 0. && uv.x < 1. && uv.y > 0. && uv.y < 1.){ vec4 dc = texture(uDecal, uv); c = mix(c, pow(dc.rgb, vec3(2.2)), dc.a); } }
  int pat = int(mod(uOM[i].x, 100.) + .5);
  if (pat == 1){ vec3 cc = floor(q*38.); vec3 f = fract(q*38.) - .5; float dd = length(f + (hash33(cc) - .5)*.4); c = mix(c, uOM[i].yzw, smoothstep(.2, .12, dd)*step(.55, hash13(cc))); }
  else if (pat == 2){ c = mix(c, uOM[i].yzw, step(.5, fract(q.y*9. + q.x*3.))); }
  else if (pat == 3){ vec3 cc = floor(q*9.); float dd = length(fract(q*9.) - .5 - (hash33(cc) - .5)*.4); c = mix(c, uOM[i].yzw, smoothstep(.3, .24, dd)*step(.45, hash13(cc + 3.))); }
  else if (pat == 4){ vec2 g = floor(q.xz*6.); c = mix(c, uOM[i].yzw, mod(g.x + g.y, 2.)); }
  else if (pat == 5){ vec2 g = abs(fract(q.xz*5.) - .5); float ln = smoothstep(.47, .49, max(g.x, g.y)); vec2 g2 = abs(fract(q.xz*1.) - .5); ln = max(ln, smoothstep(.485, .495, max(g2.x, g2.y))); c = mix(c, uOM[i].yzw, ln*.8); }
  ${o.extraAlbedo || ''}
  return c;
}
vec3 shade(vec3 p, vec3 rd, vec2 h, float t){
  float m = h.y;
  if (m > -3.5 && m < -2.5) return uBulb*5.;
  vec3 n = m > -1.5 && m < -.5 ? vec3(0.,1.,0.) : (m > -2.5 && m < -1.5 ? vec3(0.,0.,1.) : nrm(p, t));
  if (m > -1.5 && m < -.5 && uFloorType < .5){ vec2 e = vec2(.01, 0.); float h0 = vnoise2(p.xz*2.1)*.02 + vnoise2(p.xz*7.3 + uFrame*1.37)*.008;
    n = normalize(vec3(-(vnoise2((p.xz + e.xy)*2.1)*.02 + vnoise2((p.xz + e.xy)*7.3 + uFrame*1.37)*.008 - h0)/e.x, 1., -(vnoise2((p.xz + e.yx)*2.1)*.02 + vnoise2((p.xz + e.yx)*7.3 + uFrame*1.37)*.008 - h0)/e.x)); }
  float gloss = .0, seam = 1.; vec3 a; bool clay = true;
  if (m > -1.5 && m < -.5){
    if (uFloorType < .5) a = uFloorC*mix(.9, 1.06, smoothstep(.3, .7, vnoise2(p.xz*3.)))*(.92 + .12*vnoise(p*20.));
    else { float g = p.z*7. + 1.2*vnoise2(p.xz*vec2(.35,1.5)) + .4*vnoise2(p.xz*vec2(1.,6.)); float ring = smoothstep(.0, .6, fract(g))*smoothstep(1., .75, fract(g));
      a = mix(uFloorC*.86, uFloorC*1.05, ring)*(.93 + .08*vnoise2(p.xz*vec2(4.,70.)));
      a *= 1. - .35*smoothstep(.965, .99, fract(p.z*1.6));                  // plank joints
      clay = false; gloss = .25; }
  } else if (m > -2.5 && m < -1.5){
    vec3 s = mix(uSky1, uSky0, smoothstep(-.2, 3.2, p.y)); s *= .94 + .1*vnoise(vec3(p.xy*vec2(1.5,8.), 5.)); a = s; clay = false;
    return a*(.85 + .25*smoothstep(4.5, 0., length(p.xy - vec2(0.,1.2))))*uFlick;
  } else if (m >= 0.) a = objAlbedo(int(m + .5), p, gloss, seam);
  ${o.extraShade || 'else a = vec3(.8);'}
  if (clay){
    vec3 mp = p*46. + uFrame*.73;
    n = normalize(n + .045*(vec3(vnoise(mp), vnoise(mp + 7.1), vnoise(mp + 13.7)) - .5));
    a *= .94 + .12*vnoise(p*5.5);
    a *= 1. - .3*smoothstep(.93, .97, vnoise(p*95.))*step(.4, dot(a, vec3(.33)));
  }
  cullRay(p, uLdir, 4.); float sh = shadow(p + n*.025);
  cullNear(p, .4); float oc = ao(p, n);
  float ndl = dot(n, uLdir), wrap = clamp((ndl + .45)/1.45, 0., 1.);
  vec3 key = uKey*uFlick;
  vec3 col = a*key*mix(clamp(ndl, 0., 1.), wrap, .55)*sh;
  float sss = smoothstep(-.4, .1, ndl)*(1. - smoothstep(.1, .55, ndl));
  col += a*a*vec3(1.,.5,.35)*sss*.55*(.4 + .6*sh)*(clay ? 1. : .2);
  col += a*mix(uSky0, vec3(.6,.7,.9), .5)*.3*oc*(.55 + .45*n.y);
  col += a*vec3(.7,.78,.95)*.28*oc*clamp(dot(n, normalize(vec3(.8,.35,.6))), 0., 1.);
  col += a*uBulb*.5*oc*pow(clamp(dot(n, normalize(vec3(.4,.5,-.8))), 0., 1.), 2.);
  col += a*uFloorC*.25*oc*clamp(-n.y*.6 + .4, 0., 1.);
  col *= mix(.6, 1., seam);
  vec3 hv = normalize(uLdir - rd);
  float gl = gloss > .9 ? pow(max(dot(n, hv), 0.), 120.)*5. : pow(max(dot(n, hv), 0.), 22.)*(.14 + gloss*.4);
  if (m >= 0. && uOM[int(m + .5)].x >= 999.) gl *= .15;          // matte objects (printed plaques): almost no sheen
  col += vec3(1.,.96,.9)*gl*sh*uFlick;
  float fr = pow(1. - max(dot(n, -rd), 0.), 4.);
  col += vec3(.75,.82,.95)*fr*(gloss > .9 ? .45 : .07)*oc;
  if (gloss > 2.5) col += a*(gloss - 2.5)*2.;   // emissive (candle flames, lamps)
  return col;
}
vec3 render(vec2 fc){
  vec2 uv = (2.*fc - uRes)/uRes.y;
  vec3 ro = uRo, rd = camMat(ro, uTa, uRoll)*normalize(vec3(uv, uFov));
  float tF = rd.y < 0. ? -ro.y/rd.y : 1e4, tB = rd.z < 0. ? (-uBackZ - ro.z)/rd.z : 1e4;
  float tP = min(min(tF, tB), 30.);
  float t = .05; vec2 h = vec2(0.); bool hit = false;
  cullRay(ro, rd, tP);
  for (int i=0;i<130;i++){ h = mapO(ro + rd*t); if (h.x < .0005*t){ hit = true; break; } t += h.x*.92; if (t > tP) break; }
  if (!hit){ t = tP; h = vec2(0., tF < tB ? -1. : -2.); }
  gDepth = t;
  return shade(ro + rd*t, rd, h, t);
}`,
    }, o.rm || {}));
    // decal texture
    const gl = rm.canvas.getContext('webgl2');
    let dtex = null;
    function uploadDecal() {
      if (!dtex) { dtex = gl.createTexture(); }
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, dtex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, decalCv);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.activeTexture(gl.TEXTURE0);
    }
    const A = { OP: new Float32Array(N * 4), OQ: new Float32Array(N * 4), OS: new Float32Array(N * 4), OC: new Float32Array(N * 4), OX: new Float32Array(N * 4), OM: new Float32Array(N * 4) };
    function set(objs) {
      for (const k in A) A[k].fill(0);
      let n = 0; const bmin = [1e3, 1e3, 1e3], bmax = [-1e3, -1e3, -1e3];
      for (const ob of objs) {
        if (!ob || ob.hide || n >= N) continue;
        const s = (ob.s || [0.2, 0.2, 0.2, 0.02]).concat([0, 0, 0, 0]).slice(0, 4); const q = quat(...(ob.r || [0, 0, 0])); const c = hex(ob.c || '#cccccc');
        const sz = ob.scale ?? 1; if (sz <= 0.001) continue;
        const ss = s.map((v) => v * sz); const T = ob.t;
        if (T === 2 || T === 8) ss[2] = s[2]; if (T === 7 || T === 11) ss[1] = s[1];
        if (T === 4) { ss[0] = ss[0] * 0.5; ss[1] = Math.max(0.001, ss[1] - ss[2]); }
        const hy = Math.hypot;
        let bound = T === 0 ? Math.max(ss[0], ss[1], ss[2]) : T === 1 || T === 10 ? hy(ss[0], ss[1], ss[2]) : T === 2 ? ss[1] + ss[0] * Math.max(1, ss[2]) : T === 3 ? ss[0] + ss[1] :
          T === 4 ? hy(s[0] * sz, s[1] * sz) : T === 5 ? Math.max(ss[0], ss[1], ss[2]) * 1.42 + ss[3] : T === 6 ? ss[0] * 1.35 + ss[1] + ss[2] : T === 7 || T === 11 ? ss[0] + ss[2] + ss[3] : T === 8 ? ss[0] + ss[1] : Math.max(ss[0], ss[1]) + ss[0];
        bound = (ob.bound ?? bound + 0.03) * Math.max(ob.sq || 1, 1 / Math.sqrt(ob.sq || 1));
        const pc = hex(ob.pc || '#ffffff'); A.OM.set([(ob.pat || 0) + (ob.fp === false ? 100 : 0) + (ob.matte ? 1000 : 0), ...pc], n * 4);
        bmin[0] = Math.min(bmin[0], ob.p[0] - bound); bmin[1] = Math.min(bmin[1], ob.p[1] - bound); bmin[2] = Math.min(bmin[2], ob.p[2] - bound);
        bmax[0] = Math.max(bmax[0], ob.p[0] + bound); bmax[1] = Math.max(bmax[1], ob.p[1] + bound); bmax[2] = Math.max(bmax[2], ob.p[2] + bound);
        A.OP.set([ob.p[0], ob.p[1], ob.p[2], ob.t], n * 4); A.OQ.set(q, n * 4); A.OS.set(ss, n * 4);
        A.OC.set([...c, ob.g ?? (100 + n)], n * 4); A.OX.set([ob.k || 0, bound, ob.gloss ?? 0.12, ob.sq || 1], n * 4);
        n++;
      }
      const cen = n ? bmin.map((v, i) => (v + bmax[i]) / 2) : [0, -50, 0]; const rad = n ? Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) / 2 + 0.05 : 0.01;
      rm.set('uOP', A.OP).set('uOQ', A.OQ).set('uOS', A.OS).set('uOC', A.OC).set('uOX', A.OX).set('uOM', A.OM).set('uN', n).set('uBound', [...cen, rad]);
      return n;
    }
    let decalDirty = true;
    return {
      rm, decal, decalCv, quat, hex,
      markDecal() { decalDirty = true; },
      set,
      render(t, cam, p = {}) {
        if (decalDirty) { uploadDecal(); decalDirty = false; }
        const f12 = Math.floor(t * 12 + 1e-6);
        const flick = 1 + (((Math.sin(f12 * 91.7) * 43758.5) % 1 + 1) % 1 - 0.5) * 0.035;
        const g = rm.canvas.getContext('webgl2');
        rm.set('uRo', cam.p).set('uTa', cam.a).set('uFov', cam.fov || 3.0).set('uRoll', cam.roll || 0).set('uFrame', f12 % 64).set('uFlick', flick)
          .set('uLdir', p.ldir || norm([-0.55, 0.78, 0.42])).set('uKey', p.key || [2.7, 2.43, 2.1]).set('uSky0', hex(p.sky0 || '#7aa6cf')).set('uSky1', hex(p.sky1 || '#f3d2b0'))
          .set('uFloorC', hex(p.floor || '#3f7a2a')).set('uBulb', p.bulb || [1, 0.78, 0.45]).set('uFloorType', p.floorType || 0).set('uBackZ', p.backZ ?? 3.6).set('uBulbs', p.bulbs === false ? 0 : 1).set('uBulbY', p.bulbY ?? 2.5);
        rm.set('uDecal', { __ints: true, v: 5 });
        g.activeTexture(g.TEXTURE5); g.bindTexture(g.TEXTURE_2D, dtex); g.activeTexture(g.TEXTURE0);
        rm.render(t, { focus: p.focus || 4, aperture: p.aperture ?? 110, maxCoc: p.maxCoc ?? 20 });
      },
    };
  }
  const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  function drop(t, t0, h = 1.5, dur = 0.28) {
    const u = t - t0; if (u < 0) return { y: h, sq: 1, on: false };
    if (u < dur) return { y: h * (1 - (u / dur) * (u / dur)), sq: 1.08, on: true };
    const v = u - dur;
    if (v < 0.17) return { y: 0, sq: 1 - 0.28 * Math.sin(v / 0.17 * Math.PI), on: true };
    if (v < 0.42) { const w = (v - 0.17) / 0.25; return { y: 0.12 * h / 1.5 * 4 * w * (1 - w), sq: 1 + 0.08 * Math.sin(w * Math.PI), on: true }; }
    if (v < 0.55) return { y: 0, sq: 1 - 0.08 * Math.sin((v - 0.42) / 0.13 * Math.PI), on: true };
    return { y: 0, sq: 1, on: true };
  }
  window.CLAY = { make, quat, hex, norm, drop };
})();
