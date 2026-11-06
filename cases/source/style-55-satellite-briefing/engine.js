// Satellite briefing engine for 《后退的冰川》: a perspective camera around a spherical Earth, imagery
// plates sampled by lon/lat in one WebGL2 shader, and the same camera maths in JS for the annotation layer.
// One world -> screen function (project) serves every mark.

export const R = 6371.0088;
const D2R = Math.PI / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));

export function ecef(lat, lon, h = 0) {
  const p = lat * D2R, l = lon * D2R, r = R + h;
  return [r * Math.cos(p) * Math.cos(l), r * Math.cos(p) * Math.sin(l), r * Math.sin(p)];
}
function enu(lat, lon) {
  const p = lat * D2R, l = lon * D2R;
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const east = [-Math.sin(l), Math.cos(l), 0];
  return { up, east, north: cross(up, east) };
}
// look at (lat, lon) from distance d km; tilt from nadir; heading = direction the camera faces; lens shift sx, sy px
export function makeCamera({ lat, lon, d, tilt = 0, heading = 0, fov = 30, sx = 0, sy = 0 }, W = 1920, H = 1080) {
  const T = ecef(lat, lon, 0);
  const { up, east, north } = enu(lat, lon);
  const hd = heading * D2R, tl = tilt * D2R;
  const Hdir = add(mul(north, Math.cos(hd)), mul(east, Math.sin(hd)));
  const C = add(T, mul(add(mul(up, Math.cos(tl)), mul(Hdir, -Math.sin(tl))), d));
  const f = norm(sub(T, C));
  let u = norm(add(mul(Hdir, Math.cos(tl)), mul(up, Math.sin(tl))));
  u = norm(sub(u, mul(f, dot(u, f))));
  const r = norm(cross(f, u));
  const F = (H / 2) / Math.tan(fov * D2R / 2);
  const h = Math.hypot(C[0], C[1], C[2]) - R;
  return { C, f, u, r, F, W, H, sx, sy, Cc: mul(C, -1), c2: h * (2 * R + h), alt: h, d, tgt: { lat, lon } };
}
export function project(cam, lat, lon) {
  const P = ecef(lat, lon, 0), q = sub(P, cam.C), z = dot(q, cam.f);
  return [cam.W / 2 + cam.sx + cam.F * dot(q, cam.r) / z, cam.H / 2 + cam.sy - cam.F * dot(q, cam.u) / z, z > 0];
}
export function unproject(cam, x, y) {
  const nx = (x - cam.W / 2 - cam.sx) / cam.F, ny = -(y - cam.H / 2 - cam.sy) / cam.F;
  const d = norm(add(cam.f, add(mul(cam.r, nx), mul(cam.u, ny))));
  const b = dot(d, cam.Cc), disc = b * b - cam.c2;
  if (disc < 0) return null;
  const t = b - Math.sqrt(disc), Q = sub(mul(d, t), cam.Cc);
  return [Math.asin(Q[2] / R) / D2R, Math.atan2(Q[1], Q[0]) / D2R];
}
// ground km per screen pixel at the frame centre (nadir)
export const kmPerPx = cam => cam.d / cam.F;

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;

const FS = `#version 300 es
precision highp float; precision highp sampler2D;
out vec4 o;
uniform vec2 uRes; uniform vec2 uShift; uniform float uF;
uniform vec3 uR, uU, uFw, uCc; uniform float uC2;
uniform sampler2D t0, t1, t2, t3, t4, t5;       // outer (Blue Marble), region, detail A, detail B, map field, 2026 ice
uniform vec4 b0, b1, b2;                         // bboxes (w, s, e, n): outer, region, detail (map + ice share it)
uniform float a2;                                // detail opacity
uniform float uScan, uScanDir, uGlow;            // time scan front (latitude), +1 = north->south
uniform float uGrey, uIce, uIceLift, uOther;     // grade; colour return progress; lift; dim everything not ice
uniform float uDetail, uClarity, uContrast, uExpo, uDim;
uniform float uPaint;                            // opening: a scan paints the frame in from black (screen y, px)
uniform float uMap, uPrint, uTear;               // printed map: alpha, print front (lat, map north of it), tear front (lat, map north of it)
uniform float uCorr;                             // dim outside the measured corridor (0..1)
uniform vec4 uCorrBox;
uniform float uHaze, uDenoise, uCorrClar, uBlend;                           // corridor ellipse: lon, lat, rx, ry (degrees)
const float RE = 6371.0088;

float lum(vec3 c){ return dot(c, vec3(.299, .587, .114)); }
vec2 uvOf(vec4 b, vec2 ll){ return vec2((ll.y - b.x) / (b.z - b.x), (b.w - ll.x) / (b.w - b.y)); }
float inside(vec2 uv, float f){ vec2 e = smoothstep(vec2(0.), vec2(f), uv) * smoothstep(vec2(0.), vec2(f), 1. - uv); return e.x * e.y; }
vec4 samp(sampler2D t, vec2 uv, float cw){
  // cw: inside the measured corridor while it is measured -> despeckle (the fjord's bright melange flickers at this
  // altitude) and raise local contrast at the mid scales instead
  vec3 c = texture(t, uv).rgb; vec3 c1 = texture(t, uv, 1.6).rgb; float l = lum(c);
  float m1 = lum(c1), m2 = lum(texture(t, uv, 4.0).rgb), m3 = lum(texture(t, uv, 6.5).rgb);
  float dn = uDenoise * cw;
  float l0 = mix(l, min(l, m1 + .05), dn * .8);               // single-pixel glints clamp to their neighbourhood (the plate is pre-cleaned)
  float d = l0 + uDetail * ((0.7 - .6 * dn) * (l0 - m1) + (0.45 + .5 * dn) * (m1 - m2));
  d = m3 + (d - m3) * (1. + uClarity + uCorrClar * cw);
  return vec4(c, d);
}
float corrW = 0.;
vec4 ground(vec2 ll, out float glow, out float iceM, out float iceO){
  glow = 0.; iceM = 0.; iceO = 1.; corrW = 0.;
  vec4 col = vec4(.03, .04, .05, .04);
  vec2 u0 = uvOf(b0, ll); float w0 = inside(u0, .02);
  if (w0 > 0.) col = mix(col, samp(t0, u0, 0.), w0);
  vec2 u1 = uvOf(b1, ll); float w1 = inside(u1, .05);
  if (w1 > 0.) { vec4 c1 = samp(t1, u1, 0.); w1 *= smoothstep(.02, .08, lum(c1.rgb) + .3 * step(.001, lum(c1.rgb))); col = mix(col, c1, w1); }
  vec2 u2 = uvOf(b2, ll); float w2 = inside(u2, .03) * a2;
  if (w2 > 0.) {
    vec4 ic = texture(t5, u2); float cw = 1. - smoothstep(.22, .45, ic.b);   // within ~1.3-2.7 km of the flowline
    vec4 A = samp(t2, u2, cw), B = samp(t3, u2, cw);
    float fw = max(fwidth(ll.x), 1e-7);
    float s = uScanDir * (ll.x - uScan);                       // > 0 north of the scan: the new date is already painted
    float k = max(smoothstep(-fw * 40., fw * 40., s), uBlend);   // uBlend: a plain blend to B (the cleaned plate only)
    col = mix(col, mix(A, B, k), w2);
    glow = uGlow * w2 * .16 * exp(-abs(s) / (fw * 60.)) ;
    iceM = ic.r * w2; iceO = ic.g; corrW = cw * w2;
  }
  return col;
}
vec3 grade(vec4 c, float iceM, float iceO, vec2 ll){
  float d = clamp((c.a - 0.04) / 0.86, 0., 1.);
  d = (1. - exp(-1.9 * d)) / (1. - exp(-1.9));
  d = d * d * (3. - 2. * d) * .30 + d * .70;
  d = pow(d, 1.1);
  d = clamp((d - .5) * uContrast + .5, 0., 1.);
  vec3 grey = mix(vec3(.026, .036, .046), vec3(.63, .655, .668), d);
  grey += (c.rgb - lum(c.rgb)) * 0.13;
  // colour returns: only the 2026 ice, spreading from today's front up-glacier
  float rev = iceM * (1. - smoothstep(uIce - .06, uIce, iceO));
  float g = uGrey * (1. - rev);
  vec3 tc = c.rgb;
  vec3 iceTc = max(mix(vec3(lum(tc)), tc, 1.45), 0.) * 1.04;        // the plate's own hue, chroma lifted to read in the grey: no tint, no cyan shift
  tc = mix(tc, iceTc, uIceLift * rev);
  vec3 col = mix(tc, grey, g);
  col *= 1. - uOther * (1. - rev) * .42;
  // the measured corridor stays bright, the rest dims a little
  col *= 1. - uCorr * .5 * (1. - corrW);
  return col;
}
// ---- the printed map: paper, glacier ice with blue form lines, ink edge, graticule, halftone
float hsh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hsh(i), hsh(i + vec2(1, 0)), f.x), mix(hsh(i + vec2(0, 1)), hsh(i + vec2(1, 1)), f.x), f.y); }
float paper(vec2 q, float px){
  float L = log2(1. / (px * 2.6)), f0 = floor(L), t = L - f0;
  float a = vn(q * exp2(f0)), b = vn(q * exp2(f0 + 1.)), c = vn(q * exp2(f0 - 2.) * vec2(1., 4.));
  return mix(a, b, t) * .75 + c * .25;
}
vec3 mapLayer(vec2 ll, out float a){
  vec2 u = uvOf(b2, ll);
  float inb = inside(u, .01);
  vec3 f = texture(t4, u).rgb;
  float din = f.r * 3., dout = f.g * 3., sd = din - dout;   // km, + inside the 1986 ice
  float fw = max(fwidth(sd), 1e-4);
  float ice = smoothstep(-fw, fw, sd);
  vec2 q = (ll - vec2(61., -147.)).yx * vec2(.48, 1.);
  float px = max(fwidth(ll.x), 1e-8);
  float g = paper(q, px);
  vec3 land = vec3(.90, .86, .76) * (.88 + .14 * g);
  land *= mix(1., .70 + .40 * f.b, .55);                   // relief shading
  vec3 icec = vec3(.975, .985, .99) * (.95 + .06 * g);     // glacier: paper white, blue form lines
  vec3 c = mix(land, icec, ice);
  float fl = 0.;                                            // form lines inside the ice, the glacier convention
  for (int k = 1; k <= 6; k++) { float dk = .18 * float(k) * float(k) + .12 * float(k);
    fl = max(fl, (1. - smoothstep(fw * .4, fw * 1.8, abs(din - dk))) * (1. - float(k) / 8.) * ice); }
  c = mix(c, vec3(.42, .62, .86), fl * .6);
  vec2 sc = gl_FragCoord.xy * .7071; vec2 hp = fract(vec2(sc.x + sc.y, sc.x - sc.y) / 4.2) - .5;
  c *= mix(1., .95 + .08 * smoothstep(.36, .30, length(hp)), ice);
  float grat = 0.;                                          // graticule every 0.1 degree, faded red-brown
  vec2 gq = abs(fract(vec2(ll.x * 10., ll.y * 10.) + .5) - .5) / vec2(fwidth(ll.x * 10.), fwidth(ll.y * 10.));
  grat = 1. - smoothstep(.5, 1.4, min(gq.x, gq.y));
  c = mix(c, vec3(.62, .40, .32), grat * .55);
  float edge = 1. - smoothstep(fw * 1.0, fw * 2.6, abs(sd));
  float dashm = step(.35, fract((ll.x * 61. + ll.y * 29.) * 140.));       // glacier edge: a fine broken blue line
  c = mix(c, vec3(.16, .38, .70), edge * .95 * mix(1., dashm, .6));
  a = uMap * inb * step(uPrint, ll.x) * smoothstep(uTear, uTear + fwidth(ll.x) * 3., ll.x);
  return c;
}
vec3 shade(vec2 frag){
  vec2 n = (frag - uRes * .5 - uShift * vec2(1., -1.)) / uF;
  vec3 dir = normalize(uFw + n.x * uR + n.y * uU);
  float b = dot(dir, uCc), disc = b * b - uC2;
  if (disc < 0.) return vec3(.02, .03, .04);
  float t = b - sqrt(disc);
  vec3 Q = t * dir - uCc;
  vec2 ll = vec2(degrees(asin(clamp(Q.z / RE, -1., 1.))), degrees(atan(Q.y, Q.x)));
  float gl, im, io;
  vec4 c = ground(ll, gl, im, io);
  vec3 col = grade(c, im, io, ll);
  col += gl * vec3(.80, .90, 1.);
  float dist = t - uC2 / (2. * RE);
  col = mix(col, mix(vec3(.30, .38, .46), vec3(.22, .24, .26), uGrey), uHaze * (1. - exp(-max(dist, 0.) / 260.)));
  if (uMap > .001) {
    float ma; vec3 mc = mapLayer(ll, ma);
    col = mix(col, mc, ma);
    float fwl = fwidth(ll.x);
    float dl = ll.x - uTear;                                  // the scanner bar's light on the torn edge
    col += vec3(.95, .97, 1.) * .65 * exp(-max(dl, 0.) / (fwl * 18.)) * step(0., dl) * step(uTear, 89.) * step(-89., uTear) * uMap;
    float dp = uPrint - ll.x;                                 // the print head's light while it prints
    col += vec3(.95, .97, 1.) * .35 * exp(-max(dp, 0.) / (fwl * 14.)) * step(0., dp) * step(uPrint, 89.) * step(-89., uPrint) * uMap;
  }
  return col;
}
void main(){
  vec2 frag = gl_FragCoord.xy;
  vec3 col = shade(frag) * uExpo;
  vec2 q = frag / uRes - .5; col *= 1. - .34 * dot(q, q) * 1.2;
  // opening: rows above the paint line are black, a soft swath leads it
  float yy = uRes.y - frag.y;
  float pa = smoothstep(uPaint + 30., uPaint - 30., yy);
  col = col * pa + vec3(.75, .85, 1.) * .22 * exp(-abs(yy - uPaint) / 40.) * step(yy, uPaint + 60.) * step(-1., uRes.y + 80. - uPaint);
  col *= (1. - uDim);
  o = vec4(max(col, 0.), 1.);
}`;

export class Engine {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.p = p; gl.useProgram(p);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.U = {}; this.tex = {};
    for (let i = 0; i < 6; i++) gl.uniform1i(gl.getUniformLocation(p, 't' + i), i);
  }
  u(n) { return this.U[n] ?? (this.U[n] = this.gl.getUniformLocation(this.p, n)); }
  upload(name, img, mip = true) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    if (mip && this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    this.tex[name] = t;
  }
  draw(S) {
    const gl = this.gl, c = S.cam;
    gl.viewport(0, 0, c.W, c.H);
    gl.uniform2f(this.u('uRes'), c.W, c.H); gl.uniform2f(this.u('uShift'), c.sx, c.sy); gl.uniform1f(this.u('uF'), c.F);
    gl.uniform3f(this.u('uR'), ...c.r); gl.uniform3f(this.u('uU'), ...c.u); gl.uniform3f(this.u('uFw'), ...c.f);
    gl.uniform3f(this.u('uCc'), ...c.Cc); gl.uniform1f(this.u('uC2'), c.c2);
    const bind = (i, n) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.tex[n]); };
    bind(0, 'bmng'); bind(1, 'ctx'); bind(2, S.A); bind(3, S.B || S.A); bind(4, 'mapfield'); bind(5, 'ice26');
    gl.uniform4f(this.u('b0'), ...S.box.bmng); gl.uniform4f(this.u('b1'), ...S.box.ctx); gl.uniform4f(this.u('b2'), ...S.box.det);
    const f = (n, v) => gl.uniform1f(this.u(n), v);
    f('a2', S.a2); f('uScan', S.scan ?? -90); f('uScanDir', 1); f('uGlow', S.glow ?? 0);
    f('uGrey', S.grey); f('uIce', S.ice ?? -1); f('uIceLift', S.iceLift ?? 0); f('uOther', S.other ?? 0);
    f('uDetail', S.detail ?? .8); f('uClarity', S.clarity ?? .4); f('uContrast', S.contrast ?? 1); f('uExpo', S.expo ?? 1); f('uDim', S.dim ?? 0);
    f('uPaint', S.paint ?? 2000); f('uMap', S.map ?? 0); f('uPrint', S.print ?? -90); f('uTear', S.tear ?? -90);
    f('uCorr', S.corr ?? 0); f('uDenoise', S.denoise ?? 0); f('uBlend', S.blend ?? 0); f('uCorrClar', S.corrClar ?? 0); f('uHaze', S.haze ?? 0); gl.uniform4f(this.u('uCorrBox'), ...(S.corrBox || [0, 0, 1, 1]));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
