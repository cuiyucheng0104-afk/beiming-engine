/* ===== collage.js · the 09 paper-collage engine as a kit =====
   CL.init(stage, {seed}) builds the albedo/props/lift buffers and the GL lighting passes (height field,
   area-light soft shadows, AO, paper tooth, glossy window reflections, golden-hour gobo).
   Pieces: makePiece({...}) -> add(pc, x, y, rot, t0, {from, frot, lift, dur}) or {anim(t)->{x,y,rot,lift,s}};
   frame(t, cam{z,cx,cy}, light(k), hooks, post). Design px on a table that may be larger than the screen. */
(function () {
window.CL = { init(stage, OPT = {}) {
const { E, clamp, lerp, inv } = Reel;
const RS = Reel.RS, W = Math.round(1920 * RS), H = Math.round(1080 * RS), K = W / 1920;
const DBG = +(Reel.Q.get('dbg') || 0);
const R = Reel.rng(OPT.seed || 20261006);
const rr = (a, b) => a + (b - a) * R();
const n1 = Reel.noise1, n2 = Reel.noise2, hsh = Reel.hash;
const SS = 0.86;                 // sprite px per design px
const ZS = 255 / 16;             // props.R: 0..16 design px of height
const LMAX = 130;                // lift map range (design px)
const SANS = '"Noto Sans CJK SC"', SERIF = '"Noto Serif CJK SC"';
const mkc = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };
const g2 = (c) => c.getContext('2d', { willReadFrequently: true });   // CPU-backed canvases (fast in software)
const poly = (g, pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
const prc = (z, gloss, tooth) => `rgb(${Math.round(z * ZS)},${Math.round(gloss * 255)},${Math.round(tooth * 255)})`;
// ---------- buffers ----------
const ALB = mkc(W, H), PRP = mkc(W, H), LFT = mkc(W, H);
const ga = g2(ALB), gp = g2(PRP), gl2 = g2(LFT);
for (const g of [ga, gp, gl2]) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; }
const out = mkc(W, H); out.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px'; stage.appendChild(out);
const G = Reel.GL(out);
const tA = G.texture(W, H), tP = G.texture(W, H), tL = G.texture(W, H);
const HT = G.target(W, H, { float: true }), SH = G.target(W, H, { float: true });
const HD = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;`;
const pHeight = G.program(HD + `uniform sampler2D P, L; uniform float LMAX;
void main(){ float r = texture(P,uv).r*16.; o = vec4(r + texture(L,uv).r*LMAX, r, 0., 1.); }`);
const pShade = G.program(HD + `
uniform sampler2D A, P, HT;
uniform vec2 res; uniform float pxd, uK, elev, lr, dbg;
uniform vec3 cam, Ldir, Lc, Ac;
uniform float gob; uniform vec2 gobOff;
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2 grad2(vec2 i){ float a = hash12(i)*6.2832; return vec2(cos(a), sin(a)); }
float gnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(dot(grad2(i),f), dot(grad2(i+vec2(1,0)),f-vec2(1,0)),u.x), mix(dot(grad2(i+vec2(0,1)),f-vec2(0,1)), dot(grad2(i+vec2(1,1)),f-vec2(1,1)),u.x), u.y); }
const mat2 RA = mat2(.8,.6,-.6,.8), RB = mat2(.28,-.96,.96,.28);
float tooth(vec2 d){ return gnoise(d*.30)*.5 + gnoise(RA*d*.72+7.3)*.32 + gnoise(RB*d*1.6+3.1)*.18; }
float Ht(vec2 q){ return texture(HT,q).r; }
float fbmL(vec2 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*gnoise(p); p=RA*p*2.07+1.7; a*=.5; } return s; }
// golden-hour light through a window plant: dappled leaf shadows + one mullion, elongated along the light
float gobo(vec2 d, vec2 L2){
  vec2 Ld = normalize(vec2(L2.x, -L2.y));
  vec2 q = d + gobOff;
  float u = dot(q, Ld), v = dot(q, vec2(-Ld.y, Ld.x));
  float lf = fbmL(vec2(u*.0030, v*.0062) + vec2(3.1, 7.7)) + .10*gnoise(vec2(u, v)*.02);
  float leaf = 1. - smoothstep(-.06, .06, lf + .02);
  float reach = 1. - smoothstep(380., 980., q.x);
  float mull = 1. - smoothstep(16., 44., abs(v + 70.)) * smoothstep(-200., 300., -q.x + 900.);
  return 1. - gob * clamp(leaf*reach*.92 + (1.-mull)*.75, 0., .95);
}
float vis1(vec2 p, float hp, vec2 d){
  float m = -1.5, s = .8;
  for(int i=0;i<20;i++){
    float dh = Ht(p + d*(s/res)) - hp;
    m = max(m, dh*pxd/s);
    s *= 1.29;
  }
  return smoothstep(-lr, lr, elev - atan(m));
}
void main(){
  vec2 px = uv*res;
  vec4 pr = texture(P, uv);
  float hp = Ht(uv), hr = texture(HT,uv).g;
  vec2 e = 1./res;
  float hx = (texture(P,uv+vec2(e.x,0.)).r - texture(P,uv-vec2(e.x,0.)).r)*16.;
  float hy = (texture(P,uv+vec2(0.,e.y)).r - texture(P,uv-vec2(0.,e.y)).r)*16.;
  vec3 n = vec3(-hx*pxd*.5, -hy*pxd*.5, 1.);
  vec2 dc = (vec2(px.x, res.y-px.y)/uK - cam.xy)/cam.z;          // design coords (y down)
  float tth = pr.b;
  if (tth > .004) {
    float g0 = tooth(dc), gx = tooth(dc+vec2(.3,0.)), gy = tooth(dc+vec2(0.,.3));
    vec2 gg = vec2(gx-g0, gy-g0)/.3;
    n.xy += vec2(-gg.x, gg.y) * tth * 1.1;
  }
  n = normalize(n);
  vec2 L2 = normalize(Ldir.xy);
  float c1 = cos(.14), s1 = sin(.14);
  vec2 La = vec2(c1*L2.x - s1*L2.y, s1*L2.x + c1*L2.y), Lb = vec2(c1*L2.x + s1*L2.y, -s1*L2.x + c1*L2.y);
  float vis = (vis1(uv,hp,L2)*2. + vis1(uv,hp,La) + vis1(uv,hp,Lb))*.25;
  float occ = 0.;
  for(int i=0;i<8;i++){
    float a = float(i)*.7854 + .4; vec2 dd = vec2(cos(a), sin(a));
    occ += clamp((texture(HT,uv+dd*2.5/res).g-hr)*pxd/2.5*.55, 0., 1.);
    occ += clamp((texture(HT,uv+dd*9./res).g-hr)*pxd/9.*.9, 0., 1.);
  }
  float ao = 1. - occ/16.*.9;
  vec3 alb = pow(texture(A,uv).rgb, vec3(2.2));
  float gls = pr.g;
  bool metal = gls > .97;
  vec2 dcC = (res*.5/uK - cam.xy)/cam.z;
  vec3 V = normalize(vec3(dcC.x-dc.x, -(dcC.y-dc.y), 1900./cam.z));
  vec3 Rf = reflect(-V, n);
  float rough = mix(.55, .05, gls);
  float wnd = smoothstep(cos(lr*1.6 + rough), cos(max(lr*1.6 - rough, 0.)), dot(Rf, Ldir));
  float F = .04 + .96*pow(1. - max(dot(n, V), 0.), 5.);
  float ndl = max(dot(n, Ldir), 0.);
  float gb = gob > .001 ? gobo(dc, L2) : 1.;
  float fall = 1. + .2*clamp(dot((uv-.5)*vec2(res.x/res.y,1.), L2)*1.5, -1., 1.);
  vec3 col;
  if (metal) {
    col = alb*(Ac*(.35+.25*n.z)*ao + Lc*ndl*vis*.25) + alb*Lc*wnd*vis*1.6 + alb*Ac*.6*(.5+.5*Rf.z);
  } else {
    col = alb*(Lc*ndl*vis*fall*gb + Ac*(.5+.5*n.z)*ao);
    col += Lc*wnd*F*gls*vis*gb*5.;
    col += Ac*gls*.05*F;
  }
  if (dbg > .5) {
    if (dbg < 1.5) col = alb; else if (dbg < 2.5) col = pr.rgb; else if (dbg < 3.5) col = vec3(hp/12.);
    else if (dbg < 4.5) col = vec3(vis*ao); else col = n*.5+.5;
  }
  o = vec4(col, 1.);
}`);
const pPost = G.program(HD + `
uniform sampler2D S; uniform vec2 res; uniform float expo, seed, ca, vig, warm, dbg;
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14), 0., 1.); }
void main(){
  vec2 d = uv - .5;
  vec3 c = vec3(texture(S, uv - d*ca).r, texture(S, uv).g, texture(S, uv + d*ca).b);
  float soft = smoothstep(.12, .5, dot(d,d)) * 1.6;
  if (soft > .01) {
    vec3 acc = c; for (int i=0;i<8;i++){ float a = float(i)*.785+.39; acc += texture(S, uv + vec2(cos(a),sin(a))*soft/res).rgb; }
    c = acc/9.;
  }
  if (dbg > .5) { o = vec4(pow(clamp(c,0.,1.), vec3(1./2.2)), 1.); return; }
  float r2 = dot(d*vec2(1.5,1.), d*vec2(1.5,1.));
  c *= expo * (1. - vig*r2);
  c = aces(c);
  c = pow(c, vec3(1./2.2));
  float l = dot(c, vec3(.3,.59,.11));
  c += vec3(.016, .006, -.012) * smoothstep(.35, .95, l) * (1.+warm) + vec3(-.008, -.002, .012) * (1. - smoothstep(.0, .45, l));
  c = mix(vec3(l), c, 1.04);
  c += (hash12(uv*res + seed*91.7) - .5) * .02 + (hash12(floor(uv*res*.5) + seed*13.1) - .5) * .01;
  o = vec4(c, 1.);
}`);
// ---------- paper helpers ----------
function sprite(w, h, pad) { const c = mkc((w + pad * 2) * SS, (h + pad * 2) * SS); const g = g2(c); g.scale(SS, SS); g.translate(pad, pad); return [c, g]; }
function paperTex(g, w, h, o = {}) {
  const nm = o.mott ?? 16;
  for (let i = 0; i < nm; i++) {
    const x = R() * w, y = R() * h, r = (0.12 + R() * 0.4) * Math.max(w, h), dark = R() < 0.5;
    const gr = g.createRadialGradient(x, y, 0, x, y, r); const a = (o.ma ?? 0.035) * (0.5 + R());
    gr.addColorStop(0, dark ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(-10, -10, w + 20, h + 20);
  }
  const nf = o.fib ?? 150; g.lineCap = 'round';
  for (let i = 0; i < nf; i++) {
    const x = R() * w, y = R() * h, a = R() * 6.283, l = 2 + R() * (o.fl ?? 9);
    g.lineWidth = (o.fw ?? 0.6) * (0.6 + R() * 0.8);
    g.strokeStyle = o.fc ? o.fc[(R() * o.fc.length) | 0] : (R() < 0.5 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.12)');
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + rr(-2, 2), y + Math.sin(a) * l * 0.5 + rr(-2, 2), x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  const ns = o.speck ?? 12;
  for (let i = 0; i < ns; i++) { g.fillStyle = o.sc || 'rgba(40,30,20,.35)'; g.beginPath(); g.arc(R() * w, R() * h, 0.3 + R() * (o.sr ?? 0.8), 0, 7); g.fill(); }
}
// rectangle outline with torn ('t') or scissor-cut ('c') sides [top,right,bottom,left]; inner = print boundary
function outline(w, h, o = {}) {
  const sides = o.sides || 'tttt', amp = o.amp ?? 6, seed = o.seed ?? 1, band = o.band ?? 7, cj = o.cj ?? 2.5;
  const Cn = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => [x + rr(-cj, cj), y + rr(-cj, cj)]);
  const outer = [], inner = [], fib = [];
  for (let s = 0; s < 4; s++) {
    const [x0, y0] = Cn[s], [x1, y1] = Cn[(s + 1) % 4];
    const L = Math.hypot(x1 - x0, y1 - y0), tx = (x1 - x0) / L, ty = (y1 - y0) / L, nx = ty, ny = -tx;
    if (sides[s] === 'c') {
      outer.push([x0, y0]); inner.push([x0, y0]);
      const kinks = L > 220 ? 2 : 1;
      for (let k = 1; k <= kinks; k++) { const u = k / (kinks + 1) + rr(-0.06, 0.06), off = rr(-0.9, 0.9); const p = [x0 + tx * L * u + nx * off, y0 + ty * L * u + ny * off]; outer.push(p); inner.push(p); }
    } else {
      const N = Math.max(4, Math.round(L / 2.2));
      for (let i = 0; i < N; i++) {
        const u = i / N, taper = Math.pow(Math.sin(Math.PI * u), 0.3);
        const d = amp * taper * (n1(seed * 13.1 + s * 7.3 + u * L / 50) * 0.75 + n1(seed * 5.7 + s * 3.1 + u * L / 10) * 0.28) + rr(-0.5, 0.5) * amp * 0.16;
        const bx = x0 + tx * L * u + nx * d, by = y0 + ty * L * u + ny * d;
        outer.push([bx, by]);
        const bw = band > 0 ? clamp(n1(seed * 3.3 + s * 11 + u * L / 34) * band * 0.95 + band * 0.42, 0, band) * taper : 0;
        inner.push([bx - nx * bw, by - ny * bw]);
        if (R() < 0.55) fib.push([bx, by, nx, ny]);
      }
    }
  }
  return { outer, inner, fib };
}
function fibers(g, fib, col = 'rgba(250,248,240,.6)') {
  g.strokeStyle = col; g.lineCap = 'round';
  for (const [x, y, nx, ny] of fib) {
    const l = 0.8 + R() * 3.2, a = Math.atan2(ny, nx) + rr(-0.9, 0.9);
    g.lineWidth = 0.35 + R() * 0.5;
    g.beginPath(); g.moveTo(x - nx * 0.8, y - ny * 0.8); g.quadraticCurveTo(x + Math.cos(a) * l * 0.6 + rr(-0.6, 0.6), y + Math.sin(a) * l * 0.6 + rr(-0.6, 0.6), x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
}
/* make a piece: o = { w, h, pad, ol (outline), paint(g,w,h) inside outer, core (white core colour), z, gloss, tooth,
   relief(gp) extra props (drawn with 'lighter'), fib colour } -> sprites alb/prp/msk */
function makePiece(o) {
  const pad = o.pad ?? 16, { w, h } = o, ol = o.ol;
  const [A, a] = sprite(w, h, pad), [P, p] = sprite(w, h, pad), [M, m] = sprite(w, h, pad);
  a.save(); poly(a, ol.outer); a.clip();
  if (o.core) { a.fillStyle = o.core; a.fillRect(-pad, -pad, w + pad * 2, h + pad * 2); paperTex(a, w, h, { mott: 4, fib: 60, fl: 5, fc: ['rgba(0,0,0,.05)', 'rgba(255,255,255,.3)'] }); a.save(); poly(a, ol.inner); a.clip(); o.paint(a, w, h); a.restore(); }
  else o.paint(a, w, h);
  a.restore();
  if (ol.fib.length) fibers(a, ol.fib, o.fibCol);
  if (o.over) o.over(a, w, h);
  p.fillStyle = prc(o.z, o.gloss ?? 0.1, o.tooth ?? 0.3); poly(p, ol.outer); p.fill();
  if (o.innerGloss !== undefined) { p.save(); poly(p, ol.inner); p.clip(); p.fillStyle = prc(o.z, o.innerGloss, o.innerTooth ?? 0.08); p.fillRect(-pad, -pad, w + pad * 2, h + pad * 2); p.restore(); }
  if (o.cockle) { const [amt, n, r0, r1] = o.cockle; p.save(); poly(p, ol.outer); p.clip(); p.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) { const x = R() * w, y = R() * h, r = rr(r0, r1), gr = p.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgb(${Math.round(amt * ZS * rr(0.4, 1))},0,0)`); gr.addColorStop(1, 'rgb(0,0,0)'); p.fillStyle = gr; p.fillRect(x - r, y - r, r * 2, r * 2); }
    p.restore(); }
  if ((o.edge ?? 0.3) > 0) { p.save(); poly(p, ol.outer); p.clip(); p.globalCompositeOperation = 'lighter'; p.filter = `blur(${(2.2 * SS).toFixed(2)}px)`; p.lineWidth = 5; p.lineJoin = 'round'; p.strokeStyle = `rgb(${Math.round((o.edge ?? 0.3) * ZS)},0,0)`; poly(p, ol.outer); p.stroke(); p.restore(); }
  if (o.relief) { p.save(); poly(p, ol.outer); p.clip(); p.globalCompositeOperation = 'lighter'; o.relief(p, w, h); p.restore(); }
  m.fillStyle = '#fff'; poly(m, ol.outer); m.fill();
  return { alb: A, prp: P, msk: M, w, h, pad };
}
// corner curl relief: lifts one corner of a sheet by up to `amt` px
const curl = (cx, cy, r, amt) => (p) => { const gr = p.createRadialGradient(cx, cy, 0, cx, cy, r); gr.addColorStop(0, `rgb(${Math.round(amt * ZS)},10,0)`); gr.addColorStop(0.45, `rgb(${Math.round(amt * ZS * 0.32)},4,0)`); gr.addColorStop(1, 'rgb(0,0,0)'); p.fillStyle = gr; p.fillRect(cx - r, cy - r, r * 2, r * 2); };
// ---------- prints ----------
const IMG = {};
async function loadImgs(map) {
  await Promise.all(Object.entries(map).map(([n, src]) => new Promise((res) => { const im = new Image(); im.onload = res; im.onerror = res; im.src = src; IMG[n] = im; })));
}
function imgData(img, cw, ch, sx = 0, sy = 0, sw = img.width, sh = img.height) {
  const t = mkc(cw, ch), g = g2(t); g.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch); return g.getImageData(0, 0, cw, ch).data;
}
// halftone into rect (x,y,w,h): mode 'mono' (black on newsprint) or 'riso' (pink + blue, misregistered)
function halftone(g, img, x, y, w, h, mode) {
  const cw = 150, ch = Math.round(150 * h / w), d = imgData(img, cw, ch);
  const step = mode === 'riso' ? 6.4 : 4.4;
  const inks = mode === 'riso' ? [['rgba(255,72,130,.9)', 0.26, 0, [-1.1, 0.6]], ['rgba(36,78,206,.88)', 1.31, 1, [0.9, -0.5]]] : [['rgba(22,20,18,.95)', 0.785, 2, [0, 0]]];
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  for (const [ink, ang, ch_, off] of inks) {
    g.fillStyle = ink; if (mode === 'riso') g.globalCompositeOperation = 'multiply';
    const ca = Math.cos(ang), sa = Math.sin(ang), R2 = Math.hypot(w, h);
    for (let v = -R2; v < R2; v += step) for (let u = -R2; u < R2; u += step) {
      const px = w / 2 + u * ca - v * sa, py = h / 2 + u * sa + v * ca;
      if (px < -3 || py < -3 || px > w + 3 || py > h + 3) continue;
      const ix = clamp(Math.floor(px / w * cw), 0, cw - 1), iy = clamp(Math.floor(py / h * ch), 0, ch - 1), i = (iy * cw + ix) * 4;
      const L = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255;
      let k;
      if (mode === 'riso') { k = ch_ === 0 ? (1 - d[i + 1] / 255) * 0.55 + (1 - L) * 0.55 : (1 - d[i] / 255) * 0.5 + (1 - L) * 0.6; k = clamp((k - 0.32) * 1.7); }
      else k = clamp(Math.pow(clamp((1 - L) * 1.25 - 0.12), 1.05));
      const r = step * 0.6 * Math.sqrt(k) * (0.92 + 0.16 * hsh(u * 3.1 + v * 7.7));
      if (r > 0.22) { g.beginPath(); g.arc(x + px + off[0], y + py + off[1], r, 0, 7); g.fill(); }
    }
    g.globalCompositeOperation = 'source-over';
  }
  g.restore();
}
const POOL = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系很情者最立代想已通并提直题程展五果料象员位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处府';
const rtxt = (n) => { let s = ''; for (let i = 0; i < n; i++) s += POOL[(R() * POOL.length) | 0]; return s; };
function textBlock(g, x, y, w, h, size, lh, col, font = SERIF, wt = 400) {
  g.fillStyle = col; g.font = `${wt} ${size}px ${font}`; g.textBaseline = 'top'; g.textAlign = 'left';
  const per = Math.floor(w / size);
  for (let yy = y; yy < y + h - size; yy += lh) { const n = R() < 0.12 ? Math.floor(per * rr(0.3, 0.8)) : per; g.fillText(rtxt(n), x, yy); }
}
// ---------- the board ----------
let BOARD;
function buildBoard(o = {}) {
  const BW = o.w ?? 2040, BH = o.h ?? 1180, OX = o.x ?? -60, OY = o.y ?? -50, s = o.s ?? 0.72;
  const c = mkc(BW * s, BH * s), g = g2(c); g.scale(s, s);
  const A = BW * BH / (2040 * 1180);
  g.fillStyle = o.col || '#ad7845'; g.fillRect(0, 0, BW, BH);
  paperTex(g, BW, BH, Object.assign({ mott: Math.round(80 * A), ma: 0.05, fib: Math.round(16000 * A), fl: 13, fw: 0.9, fc: ['rgba(70,42,20,.24)', 'rgba(92,58,30,.2)', 'rgba(205,165,115,.2)', 'rgba(60,35,15,.13)', 'rgba(230,200,150,.12)'], speck: Math.round(700 * A), sc: 'rgba(48,28,12,.5)', sr: 1.0 }, o.tex || {}));
  if (o.paint) o.paint(g, BW, BH);
  BOARD = { c, x: OX, y: OY, w: BW, h: BH, tooth: o.tooth ?? 0.55, gloss: o.gloss ?? 0.05 };
}
// ---------- pieces ----------
const PIECES = [];
function add(pc, x, y, rot, t0, o = {}) { const P = Object.assign({ pc, x, y, rot, t0, from: [0, -260], frot: 0.12, lift: 110, dur: 0.42 }, o); PIECES.push(P); return P; }
function roundRect(w, h, r) { const pts = []; const q = 6; const cs = [[w - r, r, -Math.PI / 2], [w - r, h - r, 0], [r, h - r, Math.PI / 2], [r, r, Math.PI]]; for (const [cx, cy, a0] of cs) for (let k = 0; k <= q; k++) { const a = a0 + k / q * Math.PI / 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return pts; }
function inkTexture(c, seed, wear = 0.35) {
  const g = g2(c), id = g.getImageData(0, 0, c.width, c.height), d = id.data, w = c.width;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const x = (i / 4) % w, y = Math.floor(i / 4 / w);
    let k = 0.62 + 0.42 * n2(x * 0.22 + seed, y * 0.22) + 0.22 * n2(x * 0.9 + seed * 2, y * 0.9) - wear * Math.max(0, n2(x * 0.06 + seed, y * 0.06 + 5));
    if (hsh(x * 13.7 + y * 7.1 + seed) < 0.04) k *= 0.35;
    d[i + 3] = d[i + 3] * clamp(k);
  }
  g.putImageData(id, 0, 0);
}
const wetOf = (c) => { const k = mkc(c.width, c.height), g = g2(k); g.drawImage(c, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = 'rgb(0,255,0)'; g.fillRect(0, 0, k.width, k.height); return k; };
// rubber stamp from a draw function; returns {c, w, h, wet}
function makeStamp(w, h, draw, seed = 3.1, wear = 0.35) { const s = SS * 1.25, c = mkc(w * s, h * s), g = c.getContext('2d'); g.scale(s, s); draw(g, w, h); inkTexture(c, seed, wear); return { c, w, h, wet: wetOf(c) }; }
// ---------- paint-marker doodles ----------
const DOODLES = [];
function doodle(pts, t0, d, o = {}) { DOODLES.push(Object.assign({ pts, t0, d, col: 'rgba(250,249,244,.9)', col2: 'rgba(255,255,255,.55)', lw: 7.5, z: 0.35 }, o)); }
function drawDoodles(t) {
  for (const dd of DOODLES) {
    const pr = clamp((t - dd.t0) / dd.d); if (pr <= 0) continue;
    const n = Math.max(2, Math.ceil(dd.pts.length * pr));
    const path = (g) => { g.beginPath(); for (let k = 0; k < n; k++) { const [x, y] = dd.pts[k]; k ? g.lineTo(x, y) : g.moveTo(x, y); } };
    ga.save(); ga.lineCap = 'round'; ga.lineJoin = 'round';
    path(ga); ga.strokeStyle = dd.col; ga.lineWidth = dd.lw; ga.stroke();
    if (dd.col2) { path(ga); ga.strokeStyle = dd.col2; ga.lineWidth = dd.lw * 0.56; ga.stroke(); }
    ga.restore();
    gp.save(); gp.globalCompositeOperation = 'lighter'; gp.lineCap = 'round'; gp.lineJoin = 'round'; gp.filter = `blur(${(1.4 * K * camZ).toFixed(2)}px)`;
    path(gp); gp.strokeStyle = `rgb(${Math.round(dd.z * ZS)},90,0)`; gp.lineWidth = dd.lw * 0.87; gp.stroke();
    gp.restore();
  }
}

// ---------- timeline helpers ----------
let camZ = 1;
function pose(P, t) {
  if (P.t0 < 0) return { x: P.x, y: P.y, rot: P.rot, lift: 0 };
  const u = t - P.t0; if (u < -1e-6) return null;
  const p = clamp(u / P.dur);
  const mv = E.outCubic(clamp(p / 0.6)), ld = clamp((p - 0.25) / 0.75);
  return { x: P.x + P.from[0] * (1 - mv), y: P.y + P.from[1] * (1 - mv), rot: P.rot + P.frot * (1 - mv), lift: P.lift * (1 - E.inOutSine(ld)) };
}
// window light: k = 0 (afternoon) .. 1 (golden hour); o overrides the endpoints
function light(k, o = {}) {
  const az = lerp(o.az0 ?? -2.30, o.az1 ?? -2.84, k), el = lerp(o.el0 ?? 0.64, o.el1 ?? 0.38, k);
  const dx = Math.cos(az), dy = Math.sin(az), ce = Math.cos(el);
  const L = [dx * ce, -dy * ce, Math.sin(el)];
  const c0 = o.c0 || [2.55, 2.42, 2.25], c1 = o.c1 || [3.3, 2.55, 1.55], a0 = o.a0 || [0.36, 0.4, 0.5], a1 = o.a1 || [0.3, 0.33, 0.46];
  return { L, el, Lc: c0.map((v, i) => lerp(v, c1[i], k)), Ac: a0.map((v, i) => lerp(v, a1[i], k)), k, gob: o.gob ?? k };
}
const stampAt = (S, t, t0, x, y, r, sc = 1) => {
  if (t < t0) return;
  ga.save(); ga.translate(x, y); ga.rotate(r); ga.scale(sc, sc); ga.globalCompositeOperation = 'multiply'; ga.globalAlpha = 1; ga.drawImage(S.c, -S.w / 2, -S.h / 2, S.w, S.h); ga.restore();
  const wet = 1 - clamp((t - t0) / 1.6);
  if (wet > 0) { gp.save(); gp.translate(x, y); gp.rotate(r); gp.scale(sc, sc); gp.globalCompositeOperation = 'lighter'; gp.globalAlpha = wet * 0.55; gp.drawImage(S.wet, -S.w / 2, -S.h / 2, S.w, S.h); gp.restore(); }
};
// draw one piece at an explicit pose (for pieces the scene animates itself)
function putPiece(pc, x, y, rot, lift = 0, conf = false, sc = 1) {
  const s = (1 + lift / 1900) * sc, b = lift * 0.03 * K * camZ; const { alb, prp, msk, w, h, pad } = pc;
  const put = (g, spr, op, alpha = 1) => { g.save(); g.translate(x, y); g.rotate(rot); g.scale(s, s); if (op) g.globalCompositeOperation = op; g.globalAlpha = alpha; if (b > 0.35) g.filter = `blur(${b.toFixed(2)}px)`; g.drawImage(spr, -(w / 2 + pad), -(h / 2 + pad), w + pad * 2, h + pad * 2); g.restore(); };
  put(ga, alb); put(gp, prp, conf ? 'lighter' : null); if (lift > 0.5) put(gl2, msk, 'lighten', clamp(lift / LMAX));
}
/* frame(t, cam {z, cx, cy, jit, f}, Lt (from light()), hooks {under, mid, over}(t), post {expo, vig, ca, lr, warm, gobOff}) */
function frame(t, cam, Lt, hooks = {}, post = {}) {
  camZ = cam.z; const f12 = cam.f ?? Math.floor(t * 12 + 1e-6);
  const jx = (hsh(f12 * 1.37) - 0.5) * (cam.jit ?? 0.9), jy = (hsh(f12 * 2.71) - 0.5) * (cam.jit ?? 0.9);
  const ox = 960 - camZ * cam.cx + jx, oy = 540 - camZ * cam.cy + jy;
  for (const g of [ga, gp, gl2]) g.setTransform(K * camZ, 0, 0, K * camZ, ox * K, oy * K);
  ga.drawImage(BOARD.c, BOARD.x, BOARD.y, BOARD.w, BOARD.h);
  gp.fillStyle = prc(0, BOARD.gloss, BOARD.tooth); gp.fillRect(BOARD.x - 400, BOARD.y - 400, BOARD.w + 800, BOARD.h + 800);
  gl2.save(); gl2.setTransform(1, 0, 0, 1, 0, 0); gl2.fillStyle = '#000'; gl2.fillRect(0, 0, W, H); gl2.restore();
  if (hooks.under) hooks.under(t);
  for (const P of PIECES) {
    if (P.hide && P.hide(t)) continue;
    if (P.fn) { P.fn(t); continue; }
    const st = P.anim ? P.anim(t) : pose(P, t); if (!st) continue;
    putPiece(P.pc, st.x, st.y, st.rot, st.lift, P.conf, st.s ?? 1);
  }
  if (hooks.mid) hooks.mid(t);
  drawDoodles(t);
  if (hooks.over) hooks.over(t);
  G.upload(tA, ALB); G.upload(tP, PRP); G.upload(tL, LFT);
  pHeight.use().set('P', { tex: tP.tex, unit: 0 }).set('L', { tex: tL.tex, unit: 1 }).set('LMAX', LMAX).draw(HT);
  pShade.use().set('A', { tex: tA.tex, unit: 0 }).set('P', { tex: tP.tex, unit: 1 }).set('HT', { tex: HT.tex, unit: 2 })
    .set('res', [W, H]).set('pxd', K * camZ).set('uK', K).set('cam', [ox, oy, camZ]).set('Ldir', Lt.L).set('elev', Lt.el).set('lr', post.lr ?? 0.15)
    .set('Lc', Lt.Lc).set('Ac', Lt.Ac).set('gob', Lt.gob).set('gobOff', post.gobOff || [-(1 - Lt.k) * 520 + Math.sin(f12 * 0.9) * 5, Math.cos(f12 * 0.7) * 4]).set('dbg', DBG).draw(SH);
  const flick = 1 + (hsh(f12 * 4.13) - 0.5) * 0.035;
  pPost.use().set('S', { tex: SH.tex, unit: 0 }).set('res', [W, H]).set('expo', (post.expo ?? (0.7 + 0.08 * Lt.k)) * flick).set('seed', f12 % 97).set('ca', post.ca ?? 0.0016).set('vig', post.vig ?? 0.42)
    .set('warm', post.warm ?? Lt.k).set('dbg', DBG).draw(null);
}
return { R, rr, n1, n2, hsh, SS, ZS, LMAX, SANS, SERIF, mkc, g2, poly, prc, W, H, K, ga, gp, gl2, IMG, loadImgs, imgData, halftone, textBlock, rtxt, paperTex, outline, fibers, makePiece, curl, buildBoard, add, PIECES, roundRect, inkTexture, wetOf, makeStamp, doodle, DOODLES, pose, light, stampAt, putPiece, frame, camZ: () => camZ };
} };
})();
