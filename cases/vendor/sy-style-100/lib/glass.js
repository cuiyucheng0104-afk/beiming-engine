/* ===== glass.js · the 10 liquid-glass engine as a kit =====
   GLS.init(stage, {ns}) -> { b (wallpaper 2D ctx, device px), u (UI 2D ctx over the glass), K, W, H,
   draw(t, shapes, orb) }. A shape = { c:[x,y], h:[hx,hy], r, k (smooth-union radius), frost, bev, on }.
   The wallpaper is refracted through every shape (lens bevel, RGB split, frost, rim speculars, shadow). */
(function () {
window.GLS = { init(stage, OPT = {}) {
const { clamp } = Reel;
const NS = OPT.ns || 10;
const RS = Reel.RS, W = Math.round(1920 * RS), H = Math.round(1080 * RS), K = W / 1920;
const bg = document.createElement('canvas'); bg.width = W; bg.height = H; const b = bg.getContext('2d');
const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
cv.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px';
stage.appendChild(cv);
const G = Reel.GL(cv);
const gl = G.gl;
const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
const prog = G.program(`#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D uBg; uniform vec2 uRes, uJit; uniform float uK, uT;
uniform vec4 uS[${NS}];     // shape: centre xy (design px, y down), half size xy
uniform vec4 uP[${NS}];     // corner radius, blend k, frost, bevel radius (0 = hidden)
uniform vec4 uOrb;          // magnifier orb: centre xy, radius, strength
float sdRR(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
float smin(float a, float b, float k){ float h = max(k - abs(a - b), 0.)/k; return min(a, b) - h*h*k*.25; }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
// distance to the glass (design px), plus the frost of the nearest shape
float gBev = 34.;
float sdGlass(vec2 p, out float frost){
  float d = 1e4; frost = 0.; gBev = 34.;
  for (int i=0;i<${NS};i++){
    if (uP[i].w < .5) continue;
    float s = sdRR(p - uS[i].xy, uS[i].zw, min(uP[i].x, min(uS[i].z, uS[i].w)));
    float wgt = clamp(.5 - (s - d)/max(uP[i].y, 8.), 0., 1.);
    frost = mix(frost, uP[i].z, wgt); gBev = mix(gBev, uP[i].w, wgt);
    d = uP[i].y > .5 ? smin(d, s, uP[i].y) : min(d, s);
  }
  return d;
}
vec3 bgAt(vec2 p){ return texture(uBg, p/vec2(1920., 1080.)).rgb; }
vec3 frosted(vec2 p, float r){
  if (r < .5) return bgAt(p);
  vec3 c = vec3(0.); float w = 0.;
  for (int i=0;i<12;i++){ float a = float(i)*2.39996, rr = sqrt((float(i) + .5)/12.)*r; vec2 q = p + vec2(cos(a), sin(a))*rr; c += bgAt(q); w += 1.; }
  return c/w;
}
void main(){
  vec2 fc = gl_FragCoord.xy + uJit;
  vec2 p = vec2(fc.x, uRes.y - fc.y)/uK;            // design px, y down
  float frost;
  float d = sdGlass(p, frost);
  vec3 col = bgAt(p);
  // soft shadow under the glass
  float fs;
  float ds = sdGlass(p - vec2(0., 18.), fs);
  if (d > 0.) col *= 1. - .2*exp(-max(ds, 0.)/30.)*smoothstep(-20., 6., d);
  if (d < 1.5){
    float e = 1.;
    float f2;
    vec2 g = vec2(sdGlass(p + vec2(e, 0.), f2) - sdGlass(p - vec2(e, 0.), f2), sdGlass(p + vec2(0., e), f2) - sdGlass(p - vec2(0., e), f2))/(2.*e);
    float gl2 = length(g); vec2 nrm = gl2 > 1e-4 ? g/gl2 : vec2(0.);
    float f3; sdGlass(p, f3);
    float Rb = gBev;
    float tt = clamp(-d/Rb, 0., 1.);
    float bend = min(Rb, 40.)*1.5*pow(1. - tt, 2.4);           // lens bevel: strongest at the rim
    vec2 off = -nrm*bend;
    off += -nrm*3.;                                            // gentle magnification across the surface
    // the orb is a magnifier: content in the middle is enlarged, compressed toward the rim
    vec2 oq = p - uOrb.xy; float orr = length(oq)/max(uOrb.z, 1.);
    if (uOrb.w > 0. && orr < 1.05){
      float wq = uOrb.w*smoothstep(1.05, .9, orr);
      vec2 mag = -oq*.45*(1. - orr*orr);
      off = mix(off, mag - nrm*26.*pow(1. - clamp(-d/26., 0., 1.), 2.), wq);
    }
    float disp = .09*pow(1. - tt, 1.4);
    vec3 rc;
    float fr = frost;
    rc.r = frosted(p + off*(1. + disp), fr).r;
    rc.g = frosted(p + off, fr).g;
    rc.b = frosted(p + off*(1. - disp), fr).b;
    // body: a slight milky tint, brighter at the top, plus edge sheen
    rc = mix(rc, vec3(1.), .025 + .04*fr/6.);
    rc *= 1.06;
    float sheen = pow(1. - tt, 3.);
    rc += vec3(1.)*.07*sheen;
    rc *= 1. - .22*sheen*smoothstep(-.2, .8, dot(nrm, vec2(0., 1.)));       // darker rim at the bottom (inner shade)
    rc += vec3(1.)*.06*smoothstep(.0, -1., dot(nrm, vec2(0., 1.)))*(1. - tt);   // top gloss
    // specular rims: key from the upper left, a fainter internal one opposite
    vec2 L = normalize(vec2(-.6, -.8));
    float rim = smoothstep(4., 0., -d)*smoothstep(-1.5, 0., -d - .5);
    float rim1 = smoothstep(2.6, .2, abs(d + 1.4));
    rc += vec3(1.)*rim1*(.18 + 1.1*pow(max(dot(-nrm, L), 0.), 2.));
    rc += vec3(1.)*rim1*.45*pow(max(dot(nrm, L), 0.), 3.);
    if (uOrb.w > 0. && orr < 1.){                                // glossy highlight + thick-glass ring on the orb
      vec2 hq = oq/uOrb.z - vec2(-.38, -.46);
      rc += vec3(1.)*.55*uOrb.w*smoothstep(.3, .0, length(hq*vec2(1., 1.6)) - .05);
      rc *= 1. - .12*uOrb.w*smoothstep(.75, .97, orr);
    }
    float a = smoothstep(.75, -.75, d);                          // antialiased edge
    col = mix(col, rc, a);
  }
  col += (hash12(fc + uT*60.) - .5)/255.;
  o = vec4(col, 1.);
}`);
const ui = document.createElement('canvas'); ui.width = W; ui.height = H;
ui.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px';
stage.appendChild(ui);
const u = ui.getContext('2d');
function draw(t, S, orb = [0, 0, 0, 0]) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bg);
  const S4 = new Float32Array(NS * 4), P4 = new Float32Array(NS * 4);
  S.slice(0, NS).forEach((s, i) => { S4.set([s.c[0], s.c[1], Math.max(s.h[0], 0.01), Math.max(s.h[1], 0.01)], i * 4); P4.set([s.r, s.k || 0, s.frost ?? 1, (s.on ?? 1) && s.h[0] > 0.5 && s.h[1] > 0.5 ? Math.max(s.bev ?? 30, 1) : 0], i * 4); });
  const jit = Reel.jit || [0, 0];
  prog.use().set('uBg', { tex, unit: 0 }).set('uRes', [W, H]).set('uJit', [jit[0], -jit[1]]).set('uK', K).set('uT', t);
  gl.uniform4fv(gl.getUniformLocation(prog.pr, 'uS'), S4); gl.uniform4fv(gl.getUniformLocation(prog.pr, 'uP'), P4);
  gl.uniform4fv(gl.getUniformLocation(prog.pr, 'uOrb'), new Float32Array(orb));
  prog.draw(null);
}
const rr = (c, x, y, w, h, r) => { c.beginPath(); c.roundRect(x * K, y * K, w * K, h * K, r * K); };
const text = (c, s, x, y, size, col, o = {}) => { c.save(); c.globalAlpha = o.a ?? 1; c.fillStyle = col; c.font = `${o.wt ?? 600} ${size * K}px ${o.font ?? '"Noto Sans CJK SC"'}`; c.textAlign = o.align ?? 'center'; c.textBaseline = o.base ?? 'middle'; if (o.ls && 'letterSpacing' in c) c.letterSpacing = `${o.ls * K}px`; c.fillText(s, x * K, y * K); c.restore(); };
return { b, u, bg, K, W, H, NS, draw, rr, text };
} };
})();
