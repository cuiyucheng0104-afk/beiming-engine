// 《十二秒》 Archive Light Table. render(t) for the whole film.
// One table, one camera. World units = pixels of the first-flight plate texture (4000 px = 18 cm, the 5x7 plate).
// Picture: one WebGL2 fragment shader (light table, glass negative, backlit telegram, loupe, photograph space).
// Marks, readings and cards: a 2D canvas above, through the same world -> screen functions.
import { HIT, DUR, TICKS, SOUNDER, BEAT, BEATS } from './timeline.js';

const W = 1920, H = 1080;
const ORANGE = '#ff5a1f', INK = '#15171a', PAPER = 'rgba(246,246,242,0.96)';

// ---------------- helpers ----------------
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const ss = x => x * x * (3 - 2 * x);
const eio = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const eo = x => 1 - Math.pow(1 - x, 3);
const lerp = (a, b, x) => a + (b - a) * x;
const bt = n => n * BEAT;
function track(keys) {                               // monotone cubic through [t, v]
  const n = keys.length, d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((keys[i + 1][1] - keys[i][1]) / (keys[i + 1][0] - keys[i][0]));
  for (let i = 0; i < n; i++) m.push(i === 0 || i === n - 1 ? 0 : (d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return t => {
    if (t <= keys[0][0]) return keys[0][1];
    if (t >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 0; while (t > keys[i + 1][0]) i++;
    const h = keys[i + 1][0] - keys[i][0], u = (t - keys[i][0]) / h, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * keys[i][1] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * keys[i + 1][1] + (u3 - u2) * h * m[i + 1];
  };
}
const track2 = k => { const x = track(k.map(q => [q[0], q[1][0]])), y = track(k.map(q => [q[0], q[1][1]])); return t => [x(t), y(t)]; };
const rot = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [c * v[0] - s * v[1], s * v[0] + c * v[1]]; };

// ---------------- the table ----------------
const IT = {
  p1: { c: [2000, 1441.5], r: 0, k: 1, size: [4000, 2883] },        // first-flight glass negative (5x7 in)
  tg: { c: [6950, 1430], r: 1.6, k: 2.0, size: [2400, 1553] },      // the telegram (about 8.5 x 5.5 in)
};
const toW = (it, p) => { const o = rot([(p[0] - it.size[0] / 2) * it.k, (p[1] - it.size[1] / 2) * it.k], it.r * Math.PI / 180); return [it.c[0] + o[0], it.c[1] + o[1]]; };
// plate facts (texture px): horizon, the Flyer, Wilbur, the rail end, the ruler on the ground plane
const HZ = 1232, P1H = 2883;
const FLY = [1248, 880, 3296, 1440], WIL = [3400, 1150, 3640, 1536];
const NF = (1488 - HZ) / (P1H - HZ), NW = (1505 - HZ) / (P1H - HZ);
const RAIL0 = [2440, 1484], VP = [4620, HZ], D0 = 184.2;              // rail end (lift-off), vanishing point of the rail
const rulerAt = ft => { const s = 1 / (1 + ft / D0); return [VP[0] + (RAIL0[0] - VP[0]) * s, VP[1] + (RAIL0[1] - VP[1]) * s]; };
const SKID = [2300, 1390], SKIDG = [2300, 1487];                      // skid bottom and the rail board beneath it
// telegram line (texture px): "Success four flights"
const TG_SUCC = [48, 1150, 690, 1212];

const L1W = [2330, 1230], L2W = [2330, 1230], LENS_RW = 900, MAG = 2.5;
const SIDE_C = [4650, 2220];

// ---------------- camera ----------------
const CAM = [
  [0.0, [3500, 2650], 0.185, -5.0],
  [HIT.drop1, [2390, 1300], 0.27, -1.2],
  [HIT.dive1, L1W, 0.285, -0.8],
  [HIT.inLens, L1W, 0.95, 0],
  [HIT.rise1, L1W, 0.95, 0],
  [HIT.lift1, [2900, 1520], 0.34, 0.6],
  [HIT.glideEnd, SIDE_C, 0.175, 0],
  [HIT.cardsOut, [SIDE_C[0] - 40, SIDE_C[1] - 10], 0.178, 0],
  [HIT.drop2, [2380, 1300], 0.27, -0.6],
  [HIT.enter, L2W, 1.45, 0],
  [DUR, L2W, 1.5, 0],
];
const camC = track2(CAM.map(k => [k[0], k[1]])), camLZ = track(CAM.map(k => [k[0], Math.log(k[2])])), camR = track(CAM.map(k => [k[0], k[3]]));
const camAt = t => ({ c: camC(t), z: Math.exp(camLZ(t)), th: camR(t) * Math.PI / 180 });
function w2s(w, cam) { const d = rot([(w[0] - cam.c[0]) * cam.z, (w[1] - cam.c[1]) * cam.z], cam.th); return [W / 2 + d[0], H / 2 + d[1]]; }

// ---------------- the two dives ----------------
function dive(lw, tDrop, tLift, keysS, keysC) {
  const s0 = camAt(tDrop).z * MAG, s1 = camAt(tLift).z * MAG;
  return { lw, tDrop, tLift, S: track([[tDrop, s0], ...keysS, [tLift, s1]]), C: track2([[tDrop, lw], ...keysC, [tLift, lw]]) };
}
const D1 = dive(L1W, HIT.drop1, HIT.lift1,
  [[HIT.dive1, 0.72], [HIT.inLens, 1.0], [HIT.ruler, 1.0], [HIT.count, 1.12], [HIT.rise1, 1.12]],
  [[HIT.dive1, L1W], [HIT.inLens, [2520, 1300]], [HIT.ruler, [2560, 1310]], [HIT.count, [2800, 1350]], [HIT.rise1, [2800, 1350]]]);
const D2 = dive(L2W, HIT.drop2, DUR + 1,
  [[HIT.enter, 0.80], [DUR, 0.86]],
  [[HIT.enter, [2470, 1235]], [DUR, [2510, 1235]]]);
const DIVES = [D1, D2];

function light(t) {                                   // ballast starter: two flickers, then on
  if (t >= HIT.lightOn) return clamp(0.55 + 0.45 * seg(t, HIT.lightOn, HIT.lightOn + 0.09), 0, 1);
  const f1 = Math.exp(-Math.max(0, t - 0.03) / 0.07) * (t >= 0 ? 1 : 0);
  const f2 = t >= HIT.flick2 ? 0.85 * Math.exp(-Math.max(0, t - HIT.flick2 - 0.03) / 0.08) : 0;
  return clamp(0.10 + 0.9 * Math.max(f1, f2), 0, 1);
}

function shot(t) {
  const cam = camAt(t);
  let dv = null; for (const d of DIVES) if (t >= d.tDrop - 0.4 && t <= d.tLift + 0.4) dv = d;
  const st = { cam, t, on: 0, A: 0, lift: 1, ls: [0, 0], R: 0, S: 1, ic: [0, 0], k: 0.16, mode: 0, enter: 0, sh: [0, 0], dz: 0, fly: [0, 0], wil: [0, 0], dev: 0, dive: dv };
  if (dv) {
    const inn = seg(t, dv.tDrop - 0.4, dv.tDrop), out = seg(t, dv.tLift, dv.tLift + 0.4);
    st.on = 1; st.A = eo(inn) * (1 - ss(out)); st.lift = 1 + 0.35 * (1 - eo(inn)) + 0.35 * eo(out);
    st.ls = w2s(dv.lw, cam); st.R = LENS_RW * cam.z * st.lift;
    const tt = clamp(t, dv.tDrop, dv.tLift);
    st.S = dv.S(tt); st.ic = dv.C(tt);
    if (t < dv.tDrop || t > dv.tLift) st.S = cam.z * MAG * st.lift;
  }
  if (dv === D1) {
    st.k = 0.16 * (1 - ss(seg(t, HIT.dive1, HIT.inLens - 0.6))) + 0.16 * ss(seg(t, HIT.rise1, HIT.lift1));
    st.dev = t < HIT.develop ? 0 : (t < HIT.devDone ? 1.2 * eio(seg(t, HIT.develop, HIT.devDone)) : 1.3);
  }
  if (dv === D2) {
    st.mode = 1; st.dev = 1.3;
    st.k = 0.16 * (1 - ss(seg(t, HIT.drop2 + 0.2, HIT.enter - 0.2)));
    st.enter = ss(seg(t, HIT.drop2 + 0.3, HIT.enter));
    const p = ss(seg(t, HIT.drop2 + 0.4, DUR));
    st.sh = [-220 * p, -90 * p]; st.dz = 0.42 * p;
    const f = eio(seg(t, HIT.drop2 + 0.5, DUR + 0.6));
    st.fly = [-46 * f, -14 * f]; st.wil = [-6 * f, 0];
  }
  return st;
}
const REF_ST = shot(HIT.count), REF_R = REF_ST.R, REF_LS = REF_ST.ls;   // the lens while the reading is laid out
// inside the lens: world -> screen, through the same forward mapping as the shader
// (shader: q = dl / (1 + k rho^2), rho = |dl| / R; here we invert it for the green channel, so marks stay on the photograph
// while the lens barrel comes back on the rise)
function int2s(w, st) {
  const q = rot([(w[0] - st.ic[0]) * st.S, (w[1] - st.ic[1]) * st.S], st.cam.th);
  const qn = Math.hypot(q[0], q[1]), R = Math.max(st.R, 1);
  let r = qn;
  if (st.k > 0 && qn > 0) for (let i = 0; i < 8; i++) r = qn * (1 + st.k * (r / R) * (r / R));
  const f = qn > 0 ? r / qn : 1;
  return [st.ls[0] + q[0] * f, st.ls[1] + q[1] * f];
}

// ---------------- WebGL ----------------
const cv = document.getElementById('gl');
const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
const ov = document.getElementById('ov').getContext('2d');
const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D tP1, tP1m, tP1b, tFly, tWil, tTg;
uniform vec4 uTg;
uniform vec2 uCam; uniform float uZ, uRot, uT, uLight;
uniform vec2 uLensC; uniform float uLensR, uLensOn, uLensA, uLift;
uniform vec2 uIntC; uniform float uS, uK, uDev, uEnter, uDz, uMode;
uniform vec2 uSh, uFly, uWil;
uniform float uTgLit, uTgDim, uP1Glow;
out vec4 o;
const float NF = ${NF.toFixed(5)}, NW = ${NW.toFixed(5)}, HZ = ${HZ}., P1H = ${P1H}.;
const vec4 FLY = vec4(${FLY.join('.,')}.), WIL = vec4(${WIL.join('.,')}.);
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
vec2 rot(vec2 v, float a){ float c=cos(a), s=sin(a); return vec2(c*v.x-s*v.y, s*v.x+c*v.y); }
// explicit-gradient reads: the lens branches would otherwise pick wrong mips at their seams
vec4 tg(sampler2D t, vec2 uv, float fpx){ vec2 sz = vec2(textureSize(t, 0)); vec2 f = vec2(fpx)/sz; return textureGrad(t, uv, vec2(f.x, 0.), vec2(0., f.y)); }
bool inside(vec2 uv){ return uv.x > 0. && uv.y > 0. && uv.x < 1. && uv.y < 1.; }
float band(vec2 px, vec4 b, float p, float fe){
  float ex = smoothstep(b.x - 30., b.x + 10., px.x) * (1. - smoothstep(mix(b.x, b.z, p) - 10., mix(b.x, b.z, p) + 40., px.x));
  float ey = smoothstep(b.y - fe, b.y + fe*0.33, px.y) * (1. - smoothstep(b.w - fe*0.33, b.w + fe, px.y));
  return ex * ey * step(0.001, p);
}
vec3 lightTable(vec2 w){
  vec2 lo = vec2(-7000., -4200.), hi = vec2(12500., 7600.);
  vec2 d = min(w - lo, hi - w); float e = min(d.x, d.y);
  vec2 cd = (w - vec2(2600., 1700.)) / vec2(14000., 9500.);
  float L = (1. - 0.14*dot(cd, cd)) + (vn(w*0.015) - 0.5)*0.010 + (vn(w*0.0021) - 0.5)*0.012;
  vec3 lit = vec3(0.966, 0.976, 0.988)*L*uLight + vec3(0.075, 0.078, 0.085)*(1. - uLight);
  vec3 frame = vec3(0.33, 0.34, 0.35) + 0.05*vn(vec2(w.x*0.002, w.y*0.4)) - 0.14*smoothstep(0., 260., e + 260.);
  vec3 desk = vec3(0.055, 0.058, 0.062) + 0.012*vn(w*0.003);
  return e > 0. ? lit : (e > -260. ? frame : desk);
}
vec3 paper(vec3 L, vec3 tex, float lit, float dim){
  vec3 base = L * tex * 1.03 + vec3(0.025)*(1. - uLight);
  vec3 ink = L * pow(tex, vec3(1.6)) * 1.2;
  return mix(base * mix(1., 0.6, dim), ink, lit);
}
vec3 negative(vec3 L, float pos, float m, float dev, vec3 col){
  float T = 0.035 + 0.90*pow(clamp(1. - pos, 0., 1.), 1.25);
  vec3 neg = L*T*vec3(0.98, 0.93, 0.84);
  float pc = clamp((pos - 0.06)/(0.95 - 0.06), 0., 1.); pc = pc*pc*(3. - 2.*pc)*0.55 + pc*0.45;
  vec3 posc = mix(vec3(0.05, 0.045, 0.04), vec3(0.985, 0.978, 0.958), pc) * (0.25 + 0.75*uLight);
  return mix(col, mix(neg, posc, dev), m);
}
float nP1(vec2 p){ return max(0., (p.y - HZ) / (P1H - HZ)); }
vec2 parallax(vec2 pf){                       // flat point -> source point in the photograph space (fixed point iteration)
  vec2 d = pf - uIntC, p = pf;
  for (int i=0;i<4;i++){ float n = nP1(p) - NF; p = uIntC + (d - uSh*uEnter*n) / (1. + uDz*uEnter*n); }
  return p;
}
float speck(vec2 p, float cell, float thr){
  vec2 g = floor(p/cell), f = p/cell - g;
  if (h21(g) < thr) return 0.;
  vec2 c = vec2(.2) + .6*vec2(h21(g+3.1), h21(g+7.7)); float r = .05 + .12*h21(g+1.3);
  return smoothstep(r, r*.35, length(f - c));
}
vec3 scene(vec2 w, bool interior, float dev, float fp){
  vec3 L = lightTable(w), col = L;
  vec2 tsz = vec2(textureSize(tTg, 0));
  vec2 u = (rot(w - uTg.xy, -uTg.z)/uTg.w + tsz*0.5)/tsz;
  if (inside(u)){
    vec2 px = u*tsz;
    float lit = band(px, vec4(${TG_SUCC.join('.,')}.), uTgLit, 16.);
    vec3 pt = tg(tTg, u, fp/uTg.w).rgb;
    float edge = min(min(u.x, 1. - u.x)*tsz.x, min(u.y, 1. - u.y)*tsz.y);
    col = paper(L, pt, lit, uTgDim * (1. - lit));
    col *= 1. + 0.05*exp(-edge/18.)*uLight;     // paper glows warm at its edge
  }
  vec2 uv1 = w / vec2(4000., P1H);
  if (inside(uv1)){
    float m = tg(tP1m, uv1, fp).r, pos;
    if (interior && uMode > 0.5 && uEnter > 0.){
      vec2 pb = parallax(w);
      pos = tg(tP1b, pb / vec2(4000., P1H), fp).r;
      vec2 fu = (w - uFly - FLY.xy) / (FLY.zw - FLY.xy);
      if (inside(fu)){ vec2 la = tg(tFly, fu, fp).ra; pos = pos*(1. - la.y) + la.x; }
      vec2 d = w - uIntC;
      vec2 pw = uIntC + (d - uSh*uEnter*(NW - NF)) / (1. + uDz*uEnter*(NW - NF)) - uWil;
      vec2 wu = (pw - WIL.xy) / (WIL.zw - WIL.xy);
      if (inside(wu)){ vec2 la = tg(tWil, wu, fp).ra; pos = pos*(1. - la.y) + la.x; }
      float n = nP1(pb);                       // wind over the sand
      float hz = vn(pb*vec2(0.002, 0.0075) + vec2(-uT*0.7, 0.)) * vn(pb*0.0009 + vec2(-uT*0.25, 3.));
      pos += uEnter*0.05*(hz - 0.25)*smoothstep(0., 0.08, n)*(1. - n);
      m = mix(m, 1., uEnter);
    } else pos = tg(tP1, uv1, fp).r;
    col = negative(L, pos, m, interior ? dev : 0., col);
    col *= 1. + uP1Glow*0.06;
  }
  float dd = speck(w, 70., 0.955)*0.5 + speck(w + 31., 19., 0.975)*0.35;
  col *= 1. - dd*(interior ? (1. - uEnter) : 0.8)*0.6;
  return col;
}
void main(){
  vec2 s = vec2(gl_FragCoord.x, 1080. - gl_FragCoord.y);
  vec2 w = uCam + rot(s - vec2(960., 540.), -uRot) / uZ;
  vec2 dl = s - uLensC; float r = length(dl), rho = r / max(uLensR, 1.);
  vec3 table = scene(w, false, 0., 1. / uZ);
  vec3 col = table;
  if (uLensOn > .5){
    vec2 sd = s - (uLensC + vec2(26., 34.)*(uLift - 1.)*uLensR/120.);
    float sr = length(sd)/uLensR;
    vec3 under = table * (1. - 0.22*(uLift - 1.)/0.35*uLensA*smoothstep(1.55, 1.05, sr));
    vec3 lc;
    if (rho < 1.0){
      float dev = uDev >= 1.25 ? 1. : 1. - smoothstep(uDev - 0.14, uDev, rho);
      vec3 c3;
      for (int i=0;i<3;i++){
        float k = uK*(1. + float(i-1)*0.10);
        vec2 q = dl / (1. + k*rho*rho) * (1. - float(i-1)*0.004*uK/0.16);
        vec2 wi = uIntC + rot(q, -uRot) / uS;
        c3[i] = scene(wi, true, dev, 1. / uS)[i];
      }
      lc = c3;
      float front = (uDev > 0.01 && uDev < 1.15) ? exp(-pow((rho - uDev)/0.024, 2.)) : 0.;
      lc += vec3(1.0, 0.60, 0.33)*0.26*front*smoothstep(0.03, 0.3, uDev);
      lc *= 1. - 0.30*smoothstep(0.78, 1.0, rho)*(1. - uEnter);
      vec2 hp = dl/uLensR - vec2(-0.38, -0.46); lc += vec3(0.06)*exp(-dot(hp,hp)*7.)*(1. - uEnter);
      vec2 hp2 = dl/uLensR - vec2(0.42, 0.50); lc += vec3(0.025)*exp(-dot(hp2,hp2)*14.)*(1. - uEnter);
    } else if (rho < 1.065){
      float u = (rho - 1.0)/0.065; vec2 nd = dl / max(r, 1.);
      float lit = max(0., dot(nd, normalize(vec2(-0.55, -0.83))));
      float bev = exp(-pow((u - 0.18)/0.09, 2.))*0.9 + exp(-pow((u - 0.85)/0.07, 2.))*0.5;
      lc = vec3(0.040, 0.042, 0.046) + vec3(0.62, 0.64, 0.66)*pow(lit, 5.)*bev + 0.05*bev + vn(vec2(atan(dl.y, dl.x)*180., u*4.))*0.02;
    } else if (rho < 1.30){
      float u = (rho - 1.065)/0.235;
      vec2 s2 = uLensC + dl*(0.955 + 0.045*u);
      vec2 w2 = uCam + rot(s2 - vec2(960., 540.), -uRot) / uZ;
      lc = scene(w2, false, 0., 1. / uZ)*0.93 + 0.035*uLight;
      lc *= 1. - 0.45*exp(-pow(u/0.05, 2.));
      lc += vec3(0.20, 0.21, 0.22)*exp(-pow((u - 0.93)/0.035, 2.))*uLight;
      lc *= 1. - 0.25*exp(-pow((u - 1.0)/0.015, 2.));
    } else {
      lc = under * (1. - (0.07*exp(-pow((rho - 1.31)/0.05, 2.)) + 0.03*exp(-pow((rho - 1.3)/0.25, 2.)))*(2. - uLift));
    }
    col = mix(under, lc, uLensA);
  }
  vec2 sv = (s - vec2(960., 540.)) / vec2(1100., 760.);
  col *= 1. - 0.10*dot(sv, sv);
  float g = h21(s + fract(uT*24.*0.6180339)*vec2(311.7, 217.3)) - 0.5;
  col += g*(0.016 + 0.016*uEnter);
  o = vec4(clamp(col, 0., 1.), 1.);
}`;
function shd(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
const prog = gl.createProgram();
gl.attachShader(prog, shd(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, shd(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const aLoc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
const U = n => gl.getUniformLocation(prog, n);
function tex(unit, src, mip = true) {
  const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  if (mip) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic'); if (mip && ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  return t;
}
const img = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('missing ' + src)); i.src = src; });

// ---------------- overlay ----------------
let TXT = [];
function text(c, id, s, x, y, font, color, opt = {}) {
  c.font = font; c.fillStyle = color; c.textBaseline = 'alphabetic'; c.textAlign = opt.align || 'left';
  c.fillText(s, x, y);
  if (id && c.globalAlpha > 0.6) {
    const m = c.measureText(s), wdt = m.width, x0 = opt.align === 'right' ? x - wdt : opt.align === 'center' ? x - wdt / 2 : x;
    const tf = c.getTransform(), p0 = tf.transformPoint({ x: x0, y: y - m.actualBoundingBoxAscent }), p1 = tf.transformPoint({ x: x0 + wdt, y: y + m.actualBoundingBoxDescent });
    TXT.push({ id, text: opt.full || s, x0: Math.min(p0.x, p1.x), y0: Math.min(p0.y, p1.y), x1: Math.max(p0.x, p1.x), y1: Math.max(p0.y, p1.y) });
  }
  c.textAlign = 'left';
  return c.measureText(s).width;
}
function dot(c, p, r = 3.5, col = ORANGE) { c.fillStyle = col; c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2); c.fill(); }
function ring(c, p, r, k, lw = 2.2) { c.strokeStyle = ORANGE; c.lineWidth = lw; c.beginPath(); c.arc(p[0], p[1], r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); c.stroke(); }
function plate(c, x, y, w, h, a = 1) { c.fillStyle = `rgba(14,15,17,${0.74 * a})`; c.beginPath(); c.roundRect(x, y, w, h, 3); c.fill(); }
function line(c, a, b2, lw = 2, col = ORANGE) { c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b2[0], b2[1]); c.stroke(); }

// item tags: anchor dot, short leader, number, name, catalogue id (world-anchored, scale with the table)
const TAGS = [
  { it: 'p1', at: [140, -150], t0: HIT.tag1, no: '01', zh: '玻璃负片', id2: 'LC-W86-35' },
  { it: 'tg', at: [60, -140], t0: HIT.lift1 + 0.35, no: '02', zh: '电报', id2: 'mcc.061' },
];
function tags(c, t, st) {
  for (const g of TAGS) {
    const a = eo(seg(t, g.t0, g.t0 + 0.35)) * (1 - seg(t, HIT.drop2 + 0.1, HIT.drop2 + 0.5));
    if (a <= 0) continue;
    const it = IT[g.it];
    const anchor = toW(it, [0, 0]);
    const p = w2s([anchor[0] + g.at[0] * it.k, anchor[1] + g.at[1] * it.k], st.cam);
    const pa = w2s([anchor[0] + g.at[0] * it.k, anchor[1] + 24 * it.k], st.cam);
    c.save(); c.globalAlpha = a;
    dot(c, pa, 4); line(c, pa, [pa[0], lerp(pa[1], p[1] + 8, eo(seg(t, g.t0, g.t0 + 0.3)))], 1.6);
    c.translate(p[0], p[1]); c.rotate(st.cam.th);
    const sc = clamp(st.cam.z / 0.25, 0.8, 1.25); c.scale(sc, sc);
    c.beginPath(); c.rect(-6, -40, 520 * eo(seg(t, g.t0, g.t0 + 0.35)), 60); c.clip();
    let x = 8; x += text(c, null, g.no, x, 0, '500 24px PM', ORANGE) + 14;
    x += text(c, g.it + '-zh', g.zh, x, 0, '500 24px SC', INK) + 14;
    text(c, g.it + '-id', g.id2, x, 0, '400 20px PM', 'rgba(21,23,26,0.72)');
    c.restore();
  }
}

// measuring on the photograph (inside the lens, flat mapping)
function measure(c, t, st) {
  const fade = 1 - seg(t, HIT.rise1, HIT.rise1 + 0.3);
  if (fade <= 0) return;
  c.save(); c.globalAlpha = fade;
  c.beginPath(); c.arc(st.ls[0], st.ls[1], st.R * 0.985, 0, Math.PI * 2); c.clip();
  // the ruler: a hairline drawn out along the ground plane, ticks landing one by one
  const draw = eo(seg(t, HIT.ruler, HIT.ruler + 0.45));
  const lastFt = TICKS.filter(k => t >= bt(k[1])).map(k => k[0]).pop();
  const reach = Math.max(lastFt ?? 0, 0);
  const pS = int2s(rulerAt(0), st), pE = int2s(rulerAt(lerp(0, 120, draw)), st);
  line(c, pS, pE, 2.2, 'rgba(21,23,26,0.85)');
  for (const [ft, bb] of TICKS) {
    const k = seg(t, bt(bb) - 0.02, bt(bb) + 0.12); if (k <= 0) continue;
    const p = int2s(rulerAt(ft), st), s = 1 / (1 + ft / D0), major = ft % 20 === 0, len = (major ? 26 : 13) * s * k;
    line(c, [p[0], p[1]], [p[0], p[1] - len - 4 * s], major ? 2.6 : 1.8);
    if (major && ft > 0 && ft < 120) text(c, null, String(ft), p[0], p[1] - len - 12, `500 ${Math.round(14 + 10 * s)}px PM`, 'rgba(21,23,26,0.85)', { align: 'center' });
  }
  if (t >= HIT.ruler) dot(c, pS, 5);
  // lift-off caliper: skid bottom to the rail board beneath
  const kb = eo(seg(t, HIT.bracket, HIT.bracket + 0.35));
  if (kb > 0) {
    const a = int2s(SKID, st), g = int2s(SKIDG, st), m = [a[0], lerp(g[1], a[1], kb)];
    line(c, g, m, 2.4); line(c, [g[0] - 12, g[1]], [g[0] + 12, g[1]], 2.4);
    if (kb > 0.95) line(c, [a[0] - 12, a[1]], [a[0] + 12, a[1]], 2.4);
    c.save(); c.globalAlpha = fade * kb;
    plate(c, a[0] - 116, (a[1] + g[1]) / 2 - 26, 96, 48);
    text(c, 'gap', '离地', a[0] - 104, (a[1] + g[1]) / 2 + 10, '500 28px SC', 'rgba(250,250,247,0.97)');
    c.restore();
  }
  c.restore();
  // the reading: a caption plate held in the lens, counting with the ticks, landing on 120.
  // It belongs to the lens: when the loupe rises it shrinks and travels with the rim and is cut by it.
  const ka = eo(seg(t, HIT.ruler, HIT.ruler + 0.4)) * fade;
  if (ka > 0) {
    const x = 1250, y = 770;
    c.save(); c.globalAlpha = ka;
    const s = st.R / REF_R, oxy = [st.ls[0] - REF_LS[0] * s, st.ls[1] - REF_LS[1] * s];
    c.beginPath(); c.arc(st.ls[0], st.ls[1], st.R * 0.985, 0, Math.PI * 2); c.clip();
    c.setTransform(s, 0, 0, s, oxy[0], oxy[1]);
    c.beginPath(); c.rect(x - 4, y - 80, 470 * eo(seg(t, HIT.ruler, HIT.ruler + 0.4)), 230); c.clip();
    plate(c, x, y - 70, 420, 200);
    text(c, 'm-lbl', '飞行距离', x + 24, y - 32, '500 24px SC', 'rgba(250,250,247,0.9)');
    const shown = reach;
    const landed = t >= HIT.count;
    c.save(); if (landed) { c.shadowColor = 'rgba(255,90,31,0.55)'; c.shadowBlur = 18 * (1 - seg(t, HIT.count, HIT.count + 0.8)); }
    const wN = text(c, 'm-num', String(shown), x + 24, y + 62, '500 96px PM', landed ? ORANGE : 'rgba(250,250,247,0.97)', { full: '120' });
    c.restore();
    text(c, 'm-unit', '英尺', x + 34 + wN, y + 60, '500 32px SC', 'rgba(250,250,247,0.9)');
    text(c, 'm-src', '示意 · 题名所记', x + 24, y + 108, '400 22px SC', 'rgba(232,232,228,0.75)');
    c.restore();
  }
}

// two records, side by side: screen-fixed caption cards with leaders to their objects
let CROP_FLY = null, CROP_TG = null;
function card(c, t, o) {
  const k = eo(seg(t, o.t0, o.t0 + 0.35)) * (1 - ss(seg(t, HIT.cardsOut, HIT.cardsOut + 0.3)));   // gone within half a beat of the glide
  if (k <= 0) return;
  const out = eo(seg(t, HIT.cardsOut, HIT.cardsOut + 0.3));
  c.save();
  c.globalAlpha = Math.min(1, k * 1.6);
  // leader from the object anchor to the card's top edge
  const pa = o.anchor, top = [o.x + 40, o.y];
  // on the wipe the leader is reeled back into its anchor together with the card (no orphan lines)
  dot(c, pa, 5); line(c, pa, [pa[0], lerp(pa[1], top[1] - 30, eo(seg(t, o.t0, o.t0 + 0.25)) * (1 - out))], 1.8);
  if (t > o.t0 + 0.2 && out < 1) {
    c.save(); c.globalAlpha *= (1 - out) * (1 - out);
    line(c, [pa[0], top[1] - 30], [top[0], top[1] - 30], 1.8), line(c, [top[0], top[1] - 30], top, 1.8);
    c.restore();
  }
  c.beginPath();
  const wv = o.w * eo(seg(t, o.t0, o.t0 + 0.35)) * (1 - out);
  c.rect(o.x - 2, o.y - 2, wv + 4 * (1 - out), o.h + 4); c.clip();       // the wipe leaves no sliver behind
  plate(c, o.x, o.y, o.w, o.h);
  c.save(); c.globalAlpha *= (1 - out) * (1 - out); c.fillStyle = ORANGE; c.fillRect(o.x, o.y, 3, o.h); c.restore();
  text(c, o.id + '-lbl', o.label, o.x + 26, o.y + 40, '500 22px SC', 'rgba(250,250,247,0.82)');
  text(c, o.id + '-cat', o.cat, o.x + 26 + c.measureText(o.label).width + 12, o.y + 40, '400 20px PM', ORANGE);
  // crop of the source
  c.save(); c.globalAlpha *= 0.96 * (1 - 0.5 * o.dim); o.crop(c, o.x + 26, o.y + 58, 300, 96); c.restore();
  c.strokeStyle = 'rgba(250,250,247,0.25)'; c.lineWidth = 1; c.strokeRect(o.x + 26, o.y + 58, 300, 96);
  text(c, o.id + '-src', o.src, o.x + 26, o.y + 196, '400 30px PM', 'rgba(240,240,236,0.92)');
  c.save(); c.globalAlpha *= 1 - 0.3 * o.dim; o.reading(c, o.x + 356, o.y + 136); c.restore();
  c.restore();
}
function cards(c, t, st) {
  if (t < HIT.light12 - 0.05 || t > HIT.cardsOut + 0.4) return;
  // the cards are laid on the table: once the camera glides away at cardsOut they travel with it (the same
  // world -> screen change as the objects), so card, leader and anchor never come apart while they wipe out
  const cam0 = camAt(Math.min(t, HIT.cardsOut)), cam1 = st.cam;
  const A = w2s(toW(IT.p1, [2300, 1300]), cam0), B = w2s(toW(IT.tg, [360, 1215]), cam0);
  c.save();
  if (t > HIT.cardsOut) {
    const s = cam1.z / cam0.z, a = cam1.th - cam0.th, cs = Math.cos(a) * s, sn = Math.sin(a) * s;
    const o = w2s(cam0.c, cam1);                       // the screen centre at cardsOut, seen now
    c.setTransform(cs, sn, -sn, cs, o[0] - (cs * W / 2 - sn * H / 2), o[1] - (sn * W / 2 + cs * H / 2));
  }
  const lit = t >= HIT.light12, dimB = seg(t, HIT.dimB, HIT.dimB + 0.4);
  card(c, t, {
    id: 'A', t0: HIT.light12, x: 110, y: 700, w: 820, h: 214, anchor: A, dim: 0,
    label: '底片题名', cat: 'LC-W86-35', src: '“120 feet in 12 seconds”',
    crop: (c2, x, y, w, h) => { if (CROP_FLY) c2.drawImage(CROP_FLY, 0, 0, CROP_FLY.width, CROP_FLY.width * h / w, x, y, w, h); },
    reading: (c2, x, y) => {
      const g = 1 - seg(t, HIT.light12, HIT.light12 + 1.2);
      c2.save(); c2.shadowColor = 'rgba(255,90,31,0.7)'; c2.shadowBlur = 8 + 26 * g;
      const wN = text(c2, 'A-num', '12', x, y, '500 112px PM', lit ? ORANGE : PAPER);
      c2.restore();
      text(c2, 'A-unit', '秒', x + wN + 10, y - 4, '500 52px SC', PAPER);
      text(c2, 'A-first', '第一次', x + 4, y - 96, '500 24px SC', 'rgba(250,250,247,0.82)');
    },
  });
  card(c, t, {
    id: 'B', t0: HIT.cardB, x: 1010, y: 700, w: 800, h: 214, anchor: B, dim: dimB,
    label: '电报', cat: 'mcc.061', src: '“Success four flights”',
    crop: (c2, x, y, w, h) => { if (CROP_TG) { c2.fillStyle = 'rgb(247,241,226)'; c2.fillRect(x, y, w, h); c2.drawImage(CROP_TG, x, y + 20, w, 56); } },   // level-stretched line (tools/prep.py)
    reading: (c2, x, y) => {
      text(c2, 'B-num', '四次飞行', x, y - 14, '500 62px SC', PAPER);
      text(c2, 'B-note', '未记第一次', x + 4, y - 96, '400 22px SC', 'rgba(250,250,247,0.7)');
    },
  });
  c.restore();
}

function overlay(t, st) {
  const c = ov; TXT = [];
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
  const lensClip = () => { if (st.on && st.A > 0.5) { c.beginPath(); c.rect(0, 0, W, H); c.arc(st.ls[0], st.ls[1], st.R * 1.31, 0, Math.PI * 2, true); c.clip('evenodd'); } };
  c.save(); lensClip(); tags(c, t, st);
  // the telegram line, underlined on the table
  const ul = eo(seg(t, HIT.underline, HIT.underline + 0.45)) * (1 - seg(t, HIT.cardsOut, HIT.cardsOut + 0.3));
  if (ul > 0) {
    const a = w2s(toW(IT.tg, [TG_SUCC[0], TG_SUCC[3] + 6]), st.cam), b2 = w2s(toW(IT.tg, [lerp(TG_SUCC[0], TG_SUCC[2], ul), TG_SUCC[3] + 6]), st.cam);
    line(c, a, b2, 2.6);
  }
  c.restore();
  // loupe readout while it develops
  if (st.dive === D1) {
    const la = seg(t, HIT.drop1 - 0.1, HIT.drop1 + 0.15) * (1 - seg(t, HIT.devDone + 0.5, HIT.devDone + 0.8));
    if (la > 0) {
      const ang = -0.95, r0 = Math.min(st.R * 1.02, 470), s0 = shot(HIT.drop1), r1 = s0.R * 1.34 + 150;
      const a = [st.ls[0] + Math.cos(ang) * r0, st.ls[1] + Math.sin(ang) * r0], b2 = [s0.ls[0] + Math.cos(ang) * r1, s0.ls[1] + Math.sin(ang) * r1];
      c.save(); c.globalAlpha = la;
      line(c, a, b2, 2); line(c, b2, [b2[0] + 40, b2[1]], 2);
      plate(c, b2[0] + 48, b2[1] - 38, 210, 92);
      text(c, 'x25', '×2.5', b2[0] + 64, b2[1] - 2, '500 30px PM', ORANGE);
      text(c, 'negpos', '负像 → 正像', b2[0] + 64, b2[1] + 36, '400 24px SC', PAPER);
      c.restore();
    }
    if (t > HIT.ruler - 0.1) measure(c, t, st);
  }
  cards(c, t, st);
  // the end: one line over the photograph
  const kt = eo(seg(t, HIT.title, HIT.title + 0.3));
  if (kt > 0) {
    // set in the bright sky above the wing (dark ink on light air), with a faint local lift under it so the
    // serif never fights the haze texture
    const x = 132, y = 212;
    c.save(); c.globalAlpha = Math.min(1, kt * 2.5);
    const gl2 = c.createRadialGradient(x + 150, y - 12, 20, x + 150, y - 12, 380);
    gl2.addColorStop(0, 'rgba(252,252,249,0.30)'); gl2.addColorStop(0.55, 'rgba(252,252,249,0.14)'); gl2.addColorStop(1, 'rgba(252,252,249,0)');
    c.save(); c.globalAlpha *= kt; c.setTransform(1, 0, 0, 0.55, 0, (y - 12) * 0.45); c.fillStyle = gl2; c.fillRect(x - 260, y - 400, 820, 800); c.restore();
    c.beginPath(); c.rect(x - 10, y - 110, 640 * kt, 200); c.clip();
    c.fillStyle = ORANGE; c.fillRect(x, y - 92, 64 * kt, 3);
    text(c, 'title', '十二秒', x - 4, y, '600 76px SS', INK);
    text(c, 'date', '1903.12.17', x, y + 50, '500 26px PM', 'rgba(21,23,26,0.8)');
    c.restore();
  }
}

// ---------------- events (sound) ----------------
const EV = [];
const ev = (beat, type, extra = {}) => EV.push({ t: +bt(beat).toFixed(5), beat, type, ...extra });
ev(BEATS.flick1, 'starter'); ev(BEATS.flick2, 'starter', { g: 0.7 }); ev(BEATS.lightOn, 'lighton');
ev(BEATS.tag1, 'tag');
ev(BEATS.drop1, 'loupe');
ev(BEATS.develop, 'develop');
ev(BEATS.dive1, 'push', { dur: bt(BEATS.inLens - BEATS.dive1) });
ev(BEATS.ruler, 'ruler');
for (const [ft, bb] of TICKS) ev(bb, 'tick', { ft });
ev(BEATS.bracket, 'caliper');
ev(BEATS.count, 'land');
ev(BEATS.rise1, 'rise', { dur: bt(BEATS.lift1 - BEATS.rise1) });
ev(BEATS.lift1, 'lift');
ev(BEATS.lift1, 'glide', { dur: bt(BEATS.glideEnd - BEATS.lift1) });
ev(BEATS.light12, 'light12'); ev(BEATS.light12, 'card');
ev(BEATS.cardB, 'card', { g: 0.8 });
ev(BEATS.underline, 'pen');
for (const [bb, n] of SOUNDER) ev(bb, 'sounder', { len: bt(n * 0.25) });
ev(BEATS.cardsOut, 'wipe'); ev(BEATS.cardsOut, 'glide', { dur: bt(BEATS.drop2 - BEATS.cardsOut) });
ev(BEATS.drop2, 'loupe', { g: 0.85 });
ev(BEATS.drop2, 'rim', { dur: bt(BEATS.enter - BEATS.drop2) });
ev(BEATS.enter, 'place');
ev(BEATS.title, 'title');
EV.sort((a, b) => a.t - b.t);

// ---------------- render ----------------
let ready = false;
function render(t) {
  const st = shot(t), cam = st.cam;
  gl.viewport(0, 0, W, H);
  gl.uniform2f(U('uCam'), cam.c[0], cam.c[1]); gl.uniform1f(U('uZ'), cam.z); gl.uniform1f(U('uRot'), cam.th);
  gl.uniform1f(U('uT'), t); gl.uniform1f(U('uLight'), light(t));
  gl.uniform2f(U('uLensC'), st.ls[0], st.ls[1]); gl.uniform1f(U('uLensR'), st.R); gl.uniform1f(U('uLensOn'), st.on); gl.uniform1f(U('uLensA'), st.A); gl.uniform1f(U('uLift'), st.lift);
  gl.uniform2f(U('uIntC'), st.ic[0], st.ic[1]); gl.uniform1f(U('uS'), st.S); gl.uniform1f(U('uK'), st.k);
  gl.uniform1f(U('uDev'), st.dev); gl.uniform1f(U('uEnter'), st.enter); gl.uniform1f(U('uDz'), st.dz); gl.uniform1f(U('uMode'), st.mode);
  gl.uniform2f(U('uSh'), st.sh[0], st.sh[1]); gl.uniform2f(U('uFly'), st.fly[0], st.fly[1]); gl.uniform2f(U('uWil'), st.wil[0], st.wil[1]);
  gl.uniform4f(U('uTg'), IT.tg.c[0], IT.tg.c[1], IT.tg.r * Math.PI / 180, IT.tg.k);
  const lit = eo(seg(t, HIT.underline, HIT.underline + 0.5)) * (1 - seg(t, HIT.cardsOut, HIT.cardsOut + 0.4));
  gl.uniform1f(U('uTgLit'), lit); gl.uniform1f(U('uTgDim'), 0.8 * lit);
  gl.uniform1f(U('uP1Glow'), Math.exp(-Math.max(0, t - HIT.light12) / 0.5) * (t >= HIT.light12 ? 1 : 0) * (t < HIT.cardsOut ? 1 : 0));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  overlay(t, st);
}

async function load() {
  await document.fonts.load('500 24px SC'); await document.fonts.load('400 24px SC'); await document.fonts.load('600 76px SS');
  await document.fonts.load('500 24px PM'); await document.fonts.load('400 20px PM');
  const [p1, p1m, p1b, fly, wil, tgI, crop, cropTg] = await Promise.all(['tex/p1.jpg', 'tex/p1_mask.png', 'tex/p1_bg.jpg', 'tex/p1_fly.png', 'tex/p1_wil.png', 'tex/tg.jpg', 'tex/crop_fly.jpg', 'tex/crop_tg.jpg'].map(img));
  const bind = [['tP1', p1], ['tP1m', p1m], ['tP1b', p1b], ['tFly', fly], ['tWil', wil], ['tTg', tgI]];
  bind.forEach(([n, im], i) => { tex(i, im); gl.uniform1i(U(n), i); });
  CROP_FLY = crop; CROP_TG = cropTg;
  ready = true;
}
window.DUR = DUR;
window.EV = EV;
window.render = t => { if (ready) render(t); };
window.TEXTS = t => { window.render(t); return TXT; };
window.SHOT = t => { const s = shot(t); return { ls: s.ls, R: s.R, S: s.S, ic: s.ic, z: s.cam.z, c: s.cam.c }; };
load().then(() => { window.render(0); window.READY = true; });
