/* ===== inkwash.js · ink-on-xuan-paper kit (shading from styles/18-ink) =====
   INK.init(stage) -> { d (2D density canvas ctx, design px, device-scaled), K, W, H, clear(), stroke(), dab(),
   wash(), text(), seal(), frame(t, cam{x,y,z}) }.
   Paint into the density canvas additively: R = ink, G = pale wash, B = vermilion. The fragment shader turns
   it into ink on paper: capillary bleeding at the edges, pooled dark rims, dry-brush breakup, wash gradients,
   xuan paper fibres and mottling (tied to the painting's coordinates, so the paper moves with the camera). */
(function () {
  const { clamp, lerp } = Reel;
  function init(stage) {
    const RS = Reel.RS, W = Math.round(1920 * RS), H = Math.round(1080 * RS), K = W / 1920;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px'; stage.appendChild(cv);
    const G = Reel.GL(cv), gl = G.gl;
    const dc = document.createElement('canvas'); dc.width = W; dc.height = H; const d0 = dc.getContext('2d', { willReadFrequently: false });
    const tcv = document.createElement('canvas'); tcv.width = W; tcv.height = H; const d1 = tcv.getContext('2d');
    let d = d0;
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const tex2 = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex2);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const prog = G.program(`#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D uD, uTn; uniform vec3 uC1, uC2, uC3; uniform vec4 uScroll; uniform float uScrollOn; uniform vec2 uRes, uJit; uniform vec3 uCam; uniform float uT, uSeed, uDry, uBleed;
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<4;i++){ s+=a*vn(p); p=mat2(1.6,1.2,-1.2,1.6)*p+vec2(1.7,9.2); a*=.5; } return s/.94; }
vec3 paper(vec2 w){
  vec3 c = vec3(.957,.943,.91);
  c *= 1. - .035*smoothstep(.35, .9, fbm(w*.0022 + 7.));
  vec2 r1 = mat2(.8,.6,-.6,.8)*w, r2 = mat2(.5,-.87,.87,.5)*w;
  float fb = smoothstep(.86, .95, vn(r1*vec2(.008,.9))) + smoothstep(.88, .96, vn(r2*vec2(.007,.85) + 5.));
  c *= 1. - .014*fb; c *= 1. - .02*(vn(w*.45) - .5);
  return c;
}
void main(){
  vec2 fc = gl_FragCoord.xy + uJit;
  vec2 dc = vec2(fc.x, uRes.y - fc.y)*(1920./uRes.x);           // design px, y down
  vec2 w = (dc - vec2(960., 540.))/uCam.z + uCam.xy;             // painting coords (paper moves with the camera)
  vec2 t0 = vec2(dc.x, dc.y)/vec2(1920., 1080.);
  // capillary bleed: sample the density through a fibrous noise offset, and a soft ring around it
  vec2 nb = (vec2(fbm(w*.035), fbm(w*.035 + 5.3)) - .5)*uBleed*uCam.z;
  vec2 tuv = (dc + nb)/vec2(1920., 1080.);
  vec4 D = texture(uD, tuv);
  vec4 S = vec4(0.); for (int i=0;i<8;i++){ float a = float(i)*.785 + .3; S += texture(uD, tuv + vec2(cos(a), sin(a))*vec2(5.,5.)*uCam.z/vec2(1920.,1080.)*(1. + vn(w*.07 + float(i)))); } S /= 8.;
  float k = clamp(D.r, 0., 1.), soft = clamp(S.r, 0., 1.);
  float rim = clamp((k - soft)*2.2, 0., 1.)*smoothstep(.05, .4, k);            // pooled pigment at the edge of a wet stroke
  float halo = smoothstep(.02, .3, soft)*(1. - smoothstep(.02, .2, k))*.35;   // water halo beyond the stroke
  float dry = smoothstep(.58, .84, .5*vn(w*vec2(.05, .17)) + .5*vn(w*vec2(.17, .05) + 3.))*uDry*smoothstep(.15, .9, k)*(1. - smoothstep(.85, 1., k));
  float mott = .85 + .3*fbm(w*.02 + 3.);
  float ink = clamp(k*mott*(1. - .7*dry) + rim*.35 + halo*.25, 0., 1.);
  float wash = clamp(D.g*(.8 + .4*fbm(w*.01 + 9.)) + S.g*.2, 0., 1.);
  float red = clamp(D.b, 0., 1.)*(.85 + .15*vn(w*.5)) - .25*smoothstep(.72, .86, vn(w*.13 + 9.))*clamp(D.b, 0., 1.);
  vec3 col = paper(w);
  vec4 T = texture(uTn, tuv); vec4 T2 = texture(uTn, tuv + nb*.6/vec2(1920.,1080.));
  vec3 tn = clamp((T.rgb*.7 + T2.rgb*.3)*(.8 + .4*fbm(w*.012 + 2.)), 0., 1.);
  float tedge = clamp((T.r + T.g + T.b) - (T2.r + T2.g + T2.b), 0., 1.);
  col = mix(col, col*uC1, tn.r); col = mix(col, col*uC2, tn.g); col = mix(col, col*uC3, tn.b);
  col *= 1. - .12*tedge;
  vec3 inkC = vec3(.10,.095,.09);
  col = mix(col, mix(col, vec3(.45,.46,.48), .9), wash*.55);
  col = mix(col, inkC, ink*.94);
  col = mix(col, vec3(.78,.18,.13), clamp(red, 0., 1.)*.92);
  col *= 1. - .03*(vn(w*.9) - .5);
  col *= 1. - .07*smoothstep(.6, 1.35, length((dc - vec2(960.,540.))/vec2(960.,540.)));
  if (uScrollOn > 0.5){
    // a handscroll on a walnut table: silk mounting strips top and bottom, the table outside the unrolled paper
    float mt = 44.;
    float inY = step(uScroll.y, w.y)*step(w.y, uScroll.w), inX = step(uScroll.x, w.x)*step(w.x, uScroll.z);
    float silk = inY*inX*(1. - step(uScroll.y + mt, w.y)*step(w.y, uScroll.w - mt));
    vec3 sc = vec3(.62,.66,.68)*(.94 + .06*vn(w*vec2(.6,.08))) * (1. - .05*step(.5, fract((w.x + w.y)*.05)));
    col = mix(col, sc, silk);
    float edge = min(min(w.y - uScroll.y, uScroll.w - w.y), w.x - uScroll.x);
    col *= 1. - .06*inY*inX*exp(-max(edge, 0.)/6.);
    vec2 wr = vec2(w.x + 30.*fbm(vec2(w.y*.004, w.x*.0006)), w.y);
    float gx = wr.y*.006 + fbm(vec2(wr.x*.0007, wr.y*.004))*3.;
    float ring = smoothstep(.15, .85, abs(fract(gx) - .5)*2.);
    vec3 wood = mix(vec3(.16,.09,.05), vec3(.33,.20,.11), .35 + .45*ring*(.6 + .4*fbm(vec2(wr.x*.003, wr.y*.05))));
    wood *= .93 + .1*vn(vec2(wr.x*.02, wr.y*.6));
    wood += vec3(.05,.035,.02)*smoothstep(.75, .95, vn(vec2(wr.x*.004, wr.y*.18)));
    wood *= .75 + .35*smoothstep(1.6, .2, length((dc - vec2(960., 470.))/vec2(1200., 760.)));
    float dO = max(max(uScroll.y - w.y, w.y - uScroll.w), max(uScroll.x - w.x, w.x - uScroll.z));
    wood *= 1. - .55*exp(-max(dO, 0.)/(26.*uCam.z + 6.))*step(0., dO);
    col = mix(col, wood, 1. - inY*inX);
  }
  col += (hash12(fc + uSeed) - .5)/255.;
  o = vec4(clamp(col, 0., 1.), 1.);
}`);
    // ---- painting helpers (all coordinates in painting px; call within a camera transform set by begin()) ----
    let cam = { x: 960, y: 540, z: 1 };
    const camT = (g) => g.setTransform(K * cam.z, 0, 0, K * cam.z, (960 - cam.x * cam.z) * K, (540 - cam.y * cam.z) * K);
    function begin(c) { cam = c; for (const g of [d0, d1]) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'lighter'; camT(g); } d = d0; }
    // switch the target: 'ink' (R ink, G wash, B vermilion) or 'tint' (R = colour 1, G = colour 2, B = colour 3)
    function on(n) { d = n === 'tint' ? d1 : d0; return d; }
    function screen() { d0.setTransform(K, 0, 0, K, 0, 0); d1.setTransform(K, 0, 0, K, 0, 0); }
    function world() { camT(d0); camT(d1); }
    // mist / lifting: scale the existing pigment down inside a path (multiplies every channel by 1 - a)
    function lift(path, a, both = true) { for (const g of both ? [d0, d1] : [d]) { g.save(); g.globalCompositeOperation = 'source-over'; g.fillStyle = `rgba(0,0,0,${a})`; if (path) g.fill(path); else { g.setTransform(1, 0, 0, 1, 0, 0); g.fillRect(0, 0, W, H); } g.restore(); } }
    const col = (ch, a) => ch === 'r' ? `rgba(255,0,0,${a})` : ch === 'g' ? `rgba(0,255,0,${a})` : `rgba(0,0,255,${a})`;   // on the 'tint' target r/g/b = colour 1/2/3
    // a brush stroke along points [[x,y],...]: width w (px), taper in/out, amount a, progress p (0..1), dryness breakup
    function stroke(pts, w, a, p = 1, o = {}) {
      if (p <= 0 || pts.length < 2) return; const ch = o.ch || 'r';
      const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const tot = L[L.length - 1], end = tot * Math.min(1, p), step = Math.max(1.2, w * 0.07), af = 0.35 * Math.min(1, step / Math.max(1.2, w * 0.18));
      let i = 1;
      for (let s = 0; s <= end; s += step) {
        while (i < L.length - 1 && L[i] < s) i++;
        const u = (s - L[i - 1]) / Math.max(1e-6, L[i] - L[i - 1]); const x = lerp(pts[i - 1][0], pts[i][0], u), y = lerp(pts[i - 1][1], pts[i][1], u);
        const f = s / Math.max(1, tot); const tap = Math.min(1, f / (o.tin ?? 0.08)) * Math.min(1, (1 - f) / (o.tout ?? 0.25)); const pressure = (o.press ? o.press(f) : 1);
        const rw = w * (0.25 + 0.75 * Math.sqrt(Math.max(0, tap))) * pressure * (0.92 + 0.16 * Reel.hash(s * 0.37 + (o.seed || 0)));
        const dryCut = (o.dry || 0) * f; if (dryCut > 0 && Reel.hash(s * 0.91 + 3.1 + (o.seed || 0)) < dryCut * 0.6) continue;
        d.fillStyle = col(ch, a * (o.fade ? 1 - f * o.fade : 1) * af); d.beginPath(); d.arc(x, y, rw / 2, 0, 7); d.fill();
      }
    }
    // a soft dab (blot) or a wash area
    function dab(x, y, r, a, ch = 'r') { const g = d.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, col(ch, a)); g.addColorStop(0.7, col(ch, a * 0.6)); g.addColorStop(1, col(ch, 0)); d.fillStyle = g; d.beginPath(); d.arc(x, y, r, 0, 7); d.fill(); }
    function wash(path, a, ch = 'g') { d.fillStyle = col(ch, a); d.fill(path); }
    // calligraphy: a character written top-down with a ragged front
    function text(ch, x, y, size, p, o = {}) {
      if (p <= 0) return; d.save(); d.font = `${o.wt ?? 900} ${size}px ${o.font ?? '"Noto Serif CJK SC"'}`; d.textAlign = 'center'; d.textBaseline = 'middle';
      const top = y - size * 0.6, hgt = size * 1.2, front = top + hgt * Math.min(1, p);
      d.beginPath(); d.moveTo(x - size, top); for (let i = 0; i <= 12; i++) d.lineTo(x - size + i / 12 * size * 2, front + Math.sin(i * 1.7 + ch.charCodeAt(0)) * size * 0.06 * (p < 1 ? 1 : 0)); d.lineTo(x + size, top); d.closePath(); d.clip();
      d.fillStyle = col(o.ch || 'r', o.a ?? 1); d.fillText(ch, x, y); d.restore();
    }
    // carved seal: vermilion square with the characters knocked out
    function seal(chars, x, y, s, a = 1, rot = -0.03) {
      if (a <= 0) return; const c = document.createElement('canvas'); c.width = c.height = Math.ceil(s * K * cam.z * 1.2) + 4; const g = c.getContext('2d'); const S = c.width / 1.2;
      g.translate(c.width / 2, c.height / 2); g.fillStyle = '#0000ff'; g.beginPath(); g.roundRect(-S / 2, -S / 2, S, S, S * 0.07); g.fill(); g.globalCompositeOperation = 'destination-out'; g.font = `900 ${S * 0.42}px "Noto Serif CJK SC"`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const cs = [...chars]; if (cs.length <= 2) { g.fillText(cs[0], 0, -S * 0.22); if (cs[1]) g.fillText(cs[1], 0, S * 0.24); } else { g.font = `900 ${S * 0.36}px "Noto Serif CJK SC"`; g.fillText(cs[0], S * 0.22, -S * 0.2); g.fillText(cs[1], S * 0.22, S * 0.22); g.fillText(cs[2], -S * 0.22, -S * 0.2); if (cs[3]) g.fillText(cs[3], -S * 0.22, S * 0.22); }
      g.globalCompositeOperation = 'source-over'; d.save(); d.translate(x, y); d.rotate(rot); d.globalAlpha = a; d.drawImage(c, -s * 0.6, -s * 0.6, s * 1.2, s * 1.2); d.restore();
    }
    function frame(t, o = {}) {
      gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, dc);
      gl.bindTexture(gl.TEXTURE_2D, tex2); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tcv);
      const C1 = o.c1 || [0.62, 0.84, 0.72], C2 = o.c2 || [0.92, 0.72, 0.52], C3 = o.c3 || [0.6, 0.72, 0.86];
      const jit = Reel.jit || [0, 0];
      prog.use().set('uD', { tex, unit: 0 }).set('uTn', { tex: tex2, unit: 1 }).set('uC1', C1).set('uC2', C2).set('uC3', C3).set('uScroll', o.scroll || [0, 0, 0, 0]).set('uScrollOn', o.scroll ? 1 : 0).set('uRes', [W, H]).set('uJit', [jit[0], -jit[1]]).set('uCam', [cam.x, cam.y, cam.z]).set('uT', t).set('uSeed', Math.floor(t * 30) * 7.13 % 101).set('uDry', o.dry ?? 0.6).set('uBleed', o.bleed ?? 9);
      gl.enable(gl.SCISSOR_TEST); const bands = 6, bh = Math.ceil(H / bands);
      for (let b = 0; b < bands; b++) { gl.scissor(0, b * bh, W, bh); prog.draw(null); gl.finish(); }
      gl.disable(gl.SCISSOR_TEST);
    }
    return { get d() { return d; }, d0, d1, K, W, H, begin, on, screen, world, lift, stroke, dab, wash, text, seal, frame, col };
  }
  window.INK = { init };
})();
