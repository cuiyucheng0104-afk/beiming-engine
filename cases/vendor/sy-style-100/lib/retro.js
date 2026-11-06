/* ===== retro.js · 80s synthwave + VHS kit (from styles/12-synthwave) =====
   RETRO.init(stage, {valley}) -> { s (2D scene ctx), o (2D overlay ctx), K, W, H,
     valley(t, {z, sunY, bank, boost, roX, roY}) draws the neon valley into the scene target (if enabled),
     finish(t, glitch, {useCanvas}) composites scene (GL valley or the 2D scene canvas) + overlay through the VHS pass }
   Helpers: chrome(), neon(), palm(), star(), osd(). All coordinates in design px (1920x1080). */
(function () {
  const { clamp } = Reel;
  const NOISE = `
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x), f.y); }`;
  function init(stage, O = {}) {
    const RS = Reel.RS, W = Math.round(1920 * RS), H = Math.round(1080 * RS), K = W / 1920;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px'; stage.appendChild(cv);
    const G = Reel.GL(cv), gl = G.gl;
    const sceneT = G.target(W, H, {});
    const mk = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    const ovTex = mk(), scTex = mk();
    const ovc = document.createElement('canvas'); ovc.width = W; ovc.height = H; const o = ovc.getContext('2d');
    const scc = document.createElement('canvas'); scc.width = W; scc.height = H; const s = scc.getContext('2d');
    let valleyP = null;
    if (O.valley) valleyP = G.program(`#version 300 es
precision highp float; in vec2 uv; out vec4 oc;
uniform vec2 uRes, uJit; uniform float uT, uZ, uSunY, uBank, uBoost, uRoX, uRoY, uSunOn, uHue;
${NOISE}
float terrain(vec2 xz){
  float ax = abs(xz.x);
  float side = smoothstep(3., 11., ax);
  float n = vn(xz*vec2(.09,.07))*.62 + vn(xz*.21 + 3.)*.28 + vn(xz*.6 + 7.)*.1;
  return side*(n*11. + (ax - 3.)*.32) - .02;
}
vec3 sky(vec3 rd, vec2 p){
  float k = clamp(rd.y*2.2 + .05, 0., 1.);
  vec3 c = mix(vec3(1.,.36,.52), vec3(.45,.07,.45), smoothstep(0., .35, k));
  c = mix(c, vec3(.06,0.,.14), smoothstep(.3, 1., k));
  vec2 sp = floor(p*260.); float s = hash12(sp);
  if (s > .994) c += vec3(.9,.85,1.)*(.35 + .65*sin(uT*3. + s*60.))*smoothstep(.25, .6, k);
  vec2 sc = vec2(0., uSunY);
  vec2 q = vec2(rd.x/rd.z, rd.y/rd.z);
  float r = .29, d = length(q - sc);
  float yb = (sc.y - q.y)/r;
  float band = fract((q.y + uT*.02)*26.);
  float cut = yb > -.05 ? step(smoothstep(-.1, 1., yb)*.8, band) : 1.;
  vec3 sunC = mix(vec3(1.,.86,.25), vec3(1.,.15,.5), smoothstep(sc.y + r*.85, sc.y - r*.7, q.y));
  c += vec3(1.,.25,.55)*.45*exp(-max(d - r, 0.)*5.)*uSunOn;
  c = mix(c, sunC*1.15, smoothstep(r, r - .004, d)*cut*uSunOn);
  return c;
}
void main(){
  vec2 fc = gl_FragCoord.xy + uJit;
  vec2 p = (2.*fc - uRes)/uRes.y;
  float cb = cos(uBank), sb = sin(uBank);
  p = mat2(cb, -sb, sb, cb)*p;
  vec3 ro = vec3(uRoX, uRoY, uZ);
  vec3 rd = normalize(vec3(p.x, p.y - .16, 1.75 - uBoost*.35));
  vec3 col = sky(rd, p);
  float t = .2, hit = -1.;
  for (int i=0;i<110;i++){
    vec3 q = ro + rd*t;
    float dh = q.y - terrain(q.xz);
    if (dh < .003*t){ hit = t; break; }
    t += max(dh*.4, .012*t);
    if (t > 140.) break;
  }
  if (hit > 0.){
    vec3 q = ro + rd*hit;
    vec3 base = vec3(.05,.0,.1);
    float lw = .025 + hit*.0016;
    vec2 g = abs(fract(q.xz) - .5);
    float gx = smoothstep(lw, 0., .5 - g.x), gz = smoothstep(lw, 0., .5 - g.y);
    float glowx = exp(-(.5 - g.x)/(lw*3.)), glowz = exp(-(.5 - g.y)/(lw*3.));
    float lines = max(gx, gz), glow = max(glowx, glowz)*.35;
    float hgt = terrain(q.xz);
    vec3 lc = mix(vec3(1.,.2,.85), vec3(.2,.9,1.), smoothstep(2., 8., hgt));
    lc = mix(lc, mix(vec3(.2,.95,1.), vec3(.55,.4,1.), smoothstep(2., 8., hgt)), uHue);
    float fog = exp(-hit*.028);
    col = mix(col, base + lc*(lines*1.5 + glow)*(.35 + .65*fog), smoothstep(140., 30., hit));
    col = mix(col, vec3(1.,.3,.6)*.55, (1. - fog)*.55*smoothstep(10., 140., hit));
    float road = smoothstep(1.1, 1.0, abs(q.x))*step(hgt, .05);
    float dash = step(.5, fract(q.z*.25))*smoothstep(.06, .03, abs(q.x));
    col = mix(col, vec3(.08,.02,.14), road*.85);
    col += vec3(1.,.85,.4)*dash*road*fog*1.3;
    col += vec3(1.,.2,.8)*smoothstep(.06, .0, abs(abs(q.x) - 1.05))*road*fog*1.2;
  }
  oc = vec4(col, 1.);
}`);
    const vhs = G.program(`#version 300 es
precision highp float; in vec2 uv; out vec4 oc;
uniform sampler2D uS, uO, uC; uniform vec2 uRes; uniform float uT, uGl, uUseC, uFlipC, uVig;
${NOISE}
vec3 base(vec2 u){ return uUseC > .5 ? texture(uC, vec2(u.x, 1. - u.y)).rgb : texture(uS, u).rgb; }
vec3 comp(vec2 u){ vec4 ov = texture(uO, vec2(u.x, 1. - u.y)); vec3 s = base(u); return s*(1. - ov.a) + ov.rgb; }
void main(){
  vec2 u = uv;
  float fr = floor(uT*30.);
  float band = exp(-pow((u.y - (1. - fract(uT*.12)))/.025, 2.));
  u.x += (hash12(vec2(floor(u.y*240.), fr)) - .5)*.012*band;
  u.x += (vn(vec2(u.y*30., uT*4.)) - .5)*.0016;
  u.x += smoothstep(.04, .0, u.y)*(hash12(vec2(floor(u.y*300.), fr)) - .5)*.03;
  u.x += uGl*(hash12(vec2(floor(u.y*40.), fr)) - .5)*.06;
  float px = 1./uRes.x;
  vec3 a = comp(u), r = comp(u - vec2(px*3.5, 0.)), b = comp(u + vec2(px*3.5, 0.));
  vec3 c = vec3(r.r, a.g, b.b);
  vec3 sm = (comp(u + vec2(px*6., 0.)) + comp(u + vec2(px*12., 0.)))*.5;
  float L = dot(c, vec3(.3,.59,.11));
  c = mix(c, L + (sm - dot(sm, vec3(.3,.59,.11)))*1.05, .35);
  c += (hash12(gl_FragCoord.xy + fr*13.) - .5)*.07;
  c += band*.18*hash12(gl_FragCoord.xy*1.7 + fr);
  c *= .9 + .1*sin(gl_FragCoord.y*3.14159*.5);
  vec2 d = uv - .5; c *= 1. - uVig*smoothstep(.35, .85, length(d*vec2(1.,.8)));
  oc = vec4(c, 1.);
}`);
    function valley(t, P = {}) {
      const jit = Reel.jit || [0, 0];
      valleyP.use().set('uRes', [W, H]).set('uJit', [jit[0], -jit[1]]).set('uT', t).set('uZ', P.z ?? t * 9).set('uSunY', P.sunY ?? 0.05).set('uBank', P.bank ?? 0).set('uBoost', P.boost ?? 0)
        .set('uRoX', P.roX ?? Math.sin(t * 0.35) * 0.8).set('uRoY', P.roY ?? 1.45 + 0.15 * Math.sin(t * 0.8)).set('uSunOn', P.sunOn ?? 1).set('uHue', P.hue ?? 0).draw(sceneT);
    }
    function finish(t, glitch = 0, P = {}) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, ovTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ovc);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (P.useCanvas) { gl.bindTexture(gl.TEXTURE_2D, scTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scc); }
      vhs.use().set('uS', { tex: sceneT.tex, unit: 0 }).set('uO', { tex: ovTex, unit: 1 }).set('uC', { tex: scTex, unit: 2 }).set('uRes', [W, H]).set('uT', t).set('uGl', glitch).set('uUseC', P.useCanvas ? 1 : 0).set('uVig', P.vig ?? 0.55).draw(null);
    }
    // ---------- 2D helpers (ctx in device px; coordinates in design px) ----------
    function chrome(c, str, x, y, size, a, skew = -0.18, shine = -1, font = 'Inter') {
      if (a <= 0) return;
      c.save(); c.globalAlpha = Math.min(1, a); c.translate(x * K, y * K); c.transform(1, 0, skew, 1, 0, 0);
      const fs = size * K; c.font = `900 ${fs}px ${font}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      if ('letterSpacing' in c) c.letterSpacing = `${fs * 0.02}px`;
      for (let i = 10; i >= 1; i--) { c.fillStyle = `rgb(${40 + i * 6},0,${70 + i * 6})`; c.fillText(str, i * 0.8 * K * size / 170, i * 1.2 * K * size / 170); }
      c.lineJoin = 'round'; c.lineWidth = fs * 0.07; c.strokeStyle = '#ff63c8'; c.strokeText(str, 0, 0);
      const g = c.createLinearGradient(0, -fs * 0.42, 0, fs * 0.42);
      g.addColorStop(0, '#0b1b5c'); g.addColorStop(0.3, '#6fc3ff'); g.addColorStop(0.49, '#f2fbff'); g.addColorStop(0.5, '#3a1a3a'); g.addColorStop(0.56, '#a0335c'); g.addColorStop(0.78, '#ffb35a'); g.addColorStop(1, '#fff3c8');
      c.fillStyle = g; c.fillText(str, 0, 0);
      c.lineWidth = fs * 0.018; c.strokeStyle = 'rgba(255,255,255,.85)'; c.strokeText(str, 0, 0);
      if (shine > -0.2 && shine < 1.2) { c.globalCompositeOperation = 'source-atop'; const x0 = -fs * 3 + shine * fs * 6; const sg = c.createLinearGradient(x0, -fs, x0 + fs * 0.6, fs); sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, 'rgba(255,255,255,.85)'); sg.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = sg; c.fillRect(-fs * 4, -fs, fs * 8, fs * 2); }
      if ('letterSpacing' in c) c.letterSpacing = '0px';
      c.restore();
    }
    // neon tube text: glow + hot core; on = 0..1 (with flicker handled by caller)
    function neon(c, str, x, y, size, col, on, o2 = {}) {
      c.save(); c.translate(x * K, y * K); if (o2.rot) c.rotate(o2.rot);
      c.font = `${o2.wt ?? '700'} ${o2.italic ? 'italic ' : ''}${size * K}px ${o2.font ?? 'Lora'}`.replace('700 italic', 'italic 700'); c.textAlign = o2.align ?? 'center'; c.textBaseline = 'middle';
      if (o2.font && o2.italic) c.font = `italic ${o2.wt ?? 700} ${size * K}px ${o2.font}`;
      if ('letterSpacing' in c && o2.ls) c.letterSpacing = `${o2.ls * K}px`;
      // dead tube (visible when off)
      c.lineWidth = (o2.lw ?? size * 0.06) * K; c.strokeStyle = 'rgba(70,60,80,.55)'; c.strokeText(str, 0, 0);
      if (on > 0) {
        c.globalAlpha = on; c.shadowColor = col; c.shadowBlur = size * 0.35 * K; c.strokeStyle = col; c.lineWidth = (o2.lw ?? size * 0.06) * 1.5 * K; c.strokeText(str, 0, 0);
        c.shadowBlur = size * 0.1 * K; c.lineWidth = (o2.lw ?? size * 0.06) * 0.45 * K; c.strokeStyle = o2.core ?? '#fff4fb'; c.strokeText(str, 0, 0);
      }
      c.restore();
    }
    function palm(c, x, base, sc, lean) {
      c.save(); c.translate(x * K, base * K); c.scale(sc * K, sc * K); c.lineCap = 'round';
      const draw = (wd, col, blur) => { c.strokeStyle = col; c.shadowColor = '#ff2fa8'; c.shadowBlur = blur; c.lineWidth = 14 + wd; c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(lean * 40, -160, lean * 70, -300); c.stroke(); const tx = lean * 70, ty = -300; c.lineWidth = 10 + wd;
        for (let i = 0; i < 9; i++) { const a = -Math.PI / 2 + (i - 4) * 0.42; const L = 130 + (i % 2) * 30; c.beginPath(); c.moveTo(tx, ty); const ex = tx + Math.cos(a) * L, ey = ty + Math.sin(a) * L * 0.5 + 60; c.quadraticCurveTo(tx + Math.cos(a) * L * 0.6, ty + Math.sin(a) * L * 0.6 - 20, ex, ey); c.stroke(); } };
      draw(6, '#ff3fb4', 20); draw(0, '#12001e', 0); c.shadowBlur = 0; c.restore();
    }
    function star(c, x, y, r, a) { if (a <= 0 || r <= 0) return; c.save(); c.globalAlpha = a; c.translate(x * K, y * K); c.fillStyle = '#ffffff'; c.shadowColor = '#ffffff'; c.shadowBlur = 18 * K; c.beginPath(); for (let i = 0; i < 8; i++) { const an = i / 8 * Math.PI * 2, rr = (i % 2 ? 0.12 : 1) * r * K; c.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); } c.fill(); c.restore(); }
    function osd(c, t, left, date, blink = true, right = 'SP', tc = 0) {
      c.save(); c.font = `500 ${30 * K}px "DejaVu Sans Mono"`; c.fillStyle = 'rgba(255,255,255,.9)'; c.textBaseline = 'top'; c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 4 * K;
      if (!blink || Math.floor(t * 2) % 2) c.fillText(left, 90 * K, 70 * K);
      c.textAlign = 'right'; c.fillText(right, 1830 * K, 70 * K); c.textAlign = 'left';
      c.fillText(date, 90 * K, 980 * K); const s = Math.floor(t + tc); c.textAlign = 'right'; c.fillText(`00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, 1830 * K, 980 * K); c.restore();
    }
    return { s, o, K, W, H, gl, G, valley, finish, chrome, neon, palm, star, osd };
  }
  window.RETRO = { init };
})();
