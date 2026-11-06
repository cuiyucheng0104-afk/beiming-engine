// Materials: every surface is drawn as a scratchboard print — ink, paper, one red and a little warm yellow.
// Knife lines are fixed in world space (or in direction space for the sky) so they never slide with the camera.
import * as THREE from 'three';

THREE.ColorManagement.enabled = false;   // hex values are print inks, used as written

export const C = {
  ink: new THREE.Color('#16171b'), paper: new THREE.Color('#ede5cd'),
  red: new THREE.Color('#c4332b'), redShade: new THREE.Color('#7e2229'),
  yellow: new THREE.Color('#dfa443'), wood: new THREE.Color('#3a2f27'),
};
const v3 = c => new THREE.Vector3(c.r, c.g, c.b);
// shared uniforms: the light, the warmth of the sunrise
export const U = {
  uInk: { value: v3(C.ink) }, uPaper: { value: v3(C.paper) }, uYellow: { value: v3(C.yellow) },
  uL: { value: new THREE.Vector3(-0.92, 0.36, 0.3).normalize() },
  uWarm: { value: 0 }, uCam: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(1, .02, 0).normalize() },
};

export const GLSL_HASH = /* glsl */`
  float h11(float n){ return fract(sin(n*127.1+311.7)*43758.5453); }
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
`;
const VS_WORLD = `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`;

// ------------------------------------------------------------------ mountains: flat faces, carved shadow sides
export const carveMat = (scale = 1) => new THREE.ShaderMaterial({
  uniforms: { ...U, uScale: { value: scale } }, side: THREE.DoubleSide,
  vertexShader: VS_WORLD,
  fragmentShader: GLSL_HASH + `
    uniform vec3 uInk, uPaper, uYellow, uL; uniform float uWarm, uScale; varying vec3 vW;
    float scratches(vec3 p, vec3 n, float spacing, float density, float wmax, float seed){
      vec3 down = vec3(0.,-1.,0.);
      vec3 d = down - n*dot(down,n); float dl = length(d); d = dl > 1e-3 ? d/dl : vec3(0.,0.,1.);
      vec3 side = normalize(cross(n, d));
      float u = dot(p, d), s0 = dot(p, side) / spacing, id = floor(s0), cov = 0.;
      for (int k=-1; k<=1; k++){
        float i = id + float(k);
        float r1 = h11(i*1.13+seed), r2 = h11(i*2.71+seed+3.), r3 = h11(i*5.3+seed+7.), r4 = h11(i*9.1+seed+1.);
        float s = s0 - i - .5 - (r1-.5)*.6 - u*(r3-.5)*.35/spacing;
        float segL = spacing*(8.+r2*14.), uj = u/segL + r4*7., j = floor(uj), f = fract(uj);
        float on = step(1.-density, h11(j*3.7+i*.71+seed));
        float taper = smoothstep(0.,.08,f) * (1.-smoothstep(.35+.5*r2, .95, f));
        float w = wmax*(.35+.65*r1)*taper, aa = fwidth(s);
        cov = max(cov, on*(1.-smoothstep(w-aa, w+aa, abs(s))));
      }
      return cov;
    }
    void main(){
      vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
      float ndl = dot(n, uL);
      vec3 lit = mix(uPaper, mix(uPaper, uYellow, .35), uWarm*smoothstep(.3,.8,ndl));
      vec3 col;
      if (ndl > 0.12) { float k = scratches(vW*uScale, n, 3.2, .22*smoothstep(.55,.12,ndl), .07, 11.); col = mix(lit, uInk, k); }
      else { float dens = mix(.8, .3, smoothstep(.12,-.5,ndl)); float k = scratches(vW*uScale, n, 2.4, dens, .16, 3.); col = mix(uInk, uPaper, k*.95); }
      gl_FragColor = vec4(col, 1.);
    }`,
});
export const mtnMat = carveMat(1);

// ------------------------------------------------------------------ snow on the ground
// paper, with sparse wind-drift strokes along the drifts, grit and tufts near the lens so the near snow never goes blank,
// and the cleared bed of the line (where the rails run) a little busier with ballast stabs
export const snowMat = new THREE.ShaderMaterial({
  uniforms: { ...U },
  vertexShader: VS_WORLD,
  fragmentShader: GLSL_HASH + `
    uniform vec3 uInk, uPaper, uCam; varying vec3 vW;
    void main(){
      float dist = distance(vW, uCam);
      // drift strokes, running roughly across the line (east-west), irregular
      float v = vW.z*.21 + sin(vW.x*.019)*3. + sin(vW.x*.057+1.3)*.9;
      float row = floor(v); v += vW.x*(h11(row*7.3)-.5)*.04;
      row = floor(v); float f = fract(v)-.5 - (h11(row*2.2)-.5)*.5;
      float segs = vW.x/(1.4+h11(row)*3.2) + h11(row*3.1)*9.;
      float on = step(.93, h11(floor(segs)*1.7 + row*.37)) * smoothstep(0.,.12,fract(segs)) * (1.-smoothstep(.25,.7,fract(segs)));
      float w = (.015+.025*h11(floor(segs)+row))*on, aa = fwidth(v);
      float k = on*(1.-smoothstep(w-aa, w+aa, abs(f)));
      k *= 1.-smoothstep(120., 420., dist);
      // grit and tufts near the lens: short slanted stabs fixed in world space
      vec2 gc = floor(vW.xz/vec2(.55,.42)); vec2 gf = fract(vW.xz/vec2(.55,.42))-.5;
      float gr = h21(gc*1.71);
      float tuft = step(.9, gr) * (1.-smoothstep(.035, .06, abs(gf.x + gf.y*.6 - (gr-.95)*2.))) * step(abs(gf.y), .32);
      tuft *= 1.-smoothstep(9., 26., dist);
      k = max(k, tuft*.85);
      // the bed of the line: ballast stabs between and beside the rails (x in -1.6..1.6 around each track)
      float tx = min(abs(vW.x), abs(vW.x-4.4));
      float bed = 1.-smoothstep(1.2, 1.9, tx);
      vec2 bc = floor(vW.xz/vec2(.23,.19)); vec2 bf = fract(vW.xz/vec2(.23,.19))-.5;
      float bs = step(.8, h21(bc*2.13)) * step(max(abs(bf.x), abs(bf.y)*1.3), .2) * bed;
      bs *= 1.-smoothstep(25., 70., dist);
      k = max(k, bs*.9);
      // far snow: a few fence-post ticks so the plain is not empty from the air
      vec2 rc = floor(vW.xz/vec2(4.,1.6)); vec2 rf = fract(vW.xz/vec2(4.,1.6))-.5;
      float reed = step(.95, h21(rc*1.31)) * (1.-smoothstep(.04, .08, abs(rf.x+rf.y*.25))) * step(abs(rf.y), .4);
      reed *= smoothstep(60., 160., dist) * (1.-smoothstep(900., 1800., dist)) * step(.5, vn(vW.xz*.006));
      k = max(k, reed*.8);
      gl_FragColor = vec4(mix(uPaper, uInk, k*.92), 1.);
    }`,
});
// steel rails in moonlight: ink, a paper line of frost along the top of the head
export const railMat = new THREE.ShaderMaterial({
  uniforms: { ...U },
  vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: GLSL_HASH + `
    uniform vec3 uInk, uPaper; varying vec3 vW; varying vec3 vN;
    void main(){
      vec3 n = normalize(vN);
      if (n.y > .7) {   // the head: frost, broken now and then
        float br = step(.18, h11(floor(vW.z*.9)));
        gl_FragColor = vec4(mix(uInk, uPaper, br), 1.); return;
      }
      gl_FragColor = vec4(uInk, 1.);
    }`,
});
// ------------------------------------------------------------------ the sky: knife cuts in direction space
// night: sparse wind cuts and stab-cut stars; dawn: the sky is carved from the horizon up, line by line;
// day: dense horizontal cuts, still ink between them, so white mountains keep their weight.
export const skyMat = new THREE.ShaderMaterial({
  uniforms: { ...U, uNight: { value: new THREE.Vector3(.22, .75, .18) }, uFront: { value: -1 }, uStars: { value: 1 }, uDense: { value: 0 },
    tType1: { value: null }, uRect1: { value: new THREE.Vector4() }, uAmt1: { value: 0 },
    tType2: { value: null }, uRect2: { value: new THREE.Vector4() }, uAmt2: { value: 0 } },
  side: THREE.BackSide, depthWrite: false,
  vertexShader: VS_WORLD,
  fragmentShader: GLSL_HASH + `
    uniform vec3 uInk, uPaper, uYellow, uCam, uSun, uNight; uniform float uFront, uStars, uDense, uWarm; varying vec3 vW;
    uniform sampler2D tType1, tType2; uniform vec4 uRect1, uRect2; uniform float uAmt1, uAmt2;
    // a plate of carved type hung in direction space: the plate canvas carries its own ink block, paper rim and
    // paper letters (alpha 0 outside), redrawn by scene.js as the knife cuts each stroke
    vec3 typePlate(vec3 col, sampler2D tex, vec4 rect, float amt, float az, float el, float plate){
      vec2 uv = vec2((az - rect.x)/(rect.z - rect.x), (el - rect.y)/(rect.w - rect.y));
      if (amt <= 0. || uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) return col;
      vec4 p = texture2D(tex, uv);
      return mix(col, p.rgb, p.a*amt);
    }
    float lineRow(float el, float az, float rows, float prob, float seed, float wmul, float segMin, float segMax, out float rowEl){
      float v = el*rows; float row = floor(v);
      float ph = h11(row*1.7+seed)*6.28, amp = .18 + h11(row*3.1+seed)*.25, fr = 4. + h11(row*5.3+seed)*9.;
      v += sin(ph + az*fr)*amp;
      row = floor(v); float f = fract(v)-.5;
      rowEl = (row + .5)/rows;
      float segL = segMin + h11(row*2.9+seed)*(segMax-segMin);
      float s = az/segL + h11(row*7.7+seed)*9.; float j = floor(s), sf = fract(s);
      float on = step(1.-prob, h11(j*3.1+row*.71+seed));
      float taper = smoothstep(0.,.06,sf)*(1.-smoothstep(.55,.98,sf));
      float w = (.07 + .1*h11(j+row*1.3+seed))*wmul*taper*on;
      float aa = fwidth(v)*.9;
      return 1.-smoothstep(w-aa, w+aa, abs(f));
    }
    void main(){
      vec3 d = normalize(vW - uCam);
      float el = asin(clamp(d.y,-1.,1.)), az = atan(d.x, -d.z);
      if (el < -.004) { gl_FragColor = vec4(uPaper, 1.); return; }
      float re;
      // night wind cuts
      float kn = lineRow(el, az, 105., uNight.x, 0., uNight.y, .04, uNight.z, re) * (1.-uDense) * (1.-.55*smoothstep(.08, .5, el));
      // carved dawn / day: an engraver's sky. Straight parallel cuts, thick near the horizon and thin overhead,
      // so the tone is made by the width of the lines. Rows up to the front are cut; the newest row still runs left to right.
      float sunA0 = max(dot(normalize(d.xz), normalize(uSun.xz)), 0.);
      float glow0 = pow(sunA0, 24.) * (1.-smoothstep(.0, .3, el)) * uWarm;
      float rows = 260.;
      float v = el*rows + sin(az*2.3 + floor(el*rows)*1.7)*.06;
      float row = floor(v), f = fract(v)-.5;
      re = (row+.5)/rows;
      float cov = mix(.5, .1, smoothstep(.0, .36, el)) * mix(.85, 1., uDense) + glow0*.3;
      float segL = .5 + h11(row*2.9+21.)*1.1;
      float sg = az/segL + h11(row*7.7)*9.; float sj = floor(sg), sf = fract(sg);
      float on = step(.12, h11(sj*3.1+row*.71+21.));
      float taper = smoothstep(0.,.03,sf)*(1.-smoothstep(.9,1.,sf));
      float w = cov*.5*mix(.55, 1., taper)*on;
      float aa = fwidth(v)*.9;
      float kd = 1.-smoothstep(w-aa, w+aa, abs(f));
      float carved = step(re, uFront);
      float edge = step(uFront - 1./rows, re);
      float run = clamp((uFront - re)*rows, 0., 1.);
      float sweep = step(az, mix(-3.2, 3.2, run));
      kd *= carved * mix(1., sweep, edge);
      // stars, dimming as the day comes
      vec2 sc = vec2(az, el)*vec2(140., 140.); vec2 cid = floor(sc), cf = fract(sc)-.5;
      float sr = h21(cid), ss = mix(.1, .2, step(.92, h21(cid+3.)));
      float star = step(.965, sr) * step(max(abs(cf.x),abs(cf.y)*1.1), ss) * uStars * smoothstep(.0, .05, el);
      float k = max(max(kn, kd), star);
      // warm light near the sun: the cut lines catch it
      float sunA = max(dot(normalize(d.xz), normalize(uSun.xz)), 0.);
      float glow = pow(sunA, 26.) * (1.-smoothstep(.0, .3, el)) * uWarm;
      vec3 lineCol = mix(uPaper, uYellow, clamp(glow*1.3, 0., .85));
      vec3 col = mix(uInk, lineCol, k);
      col = typePlate(col, tType1, uRect1, uAmt1, az, el, 1.);
      col = typePlate(col, tType2, uRect2, uAmt2, az, el, 1.);
      gl_FragColor = vec4(col, 1.);
    }`,
});

// ------------------------------------------------------------------ billboards
// mode 0: cylindrical (trees, standing cranes), feet at the pivot; mode 1: spherical, centred, rotated on screen.
export function billboardMat(tex, mode, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { tMap: { value: tex }, ...U, uTint: { value: 0 } },
    vertexShader: `
      attribute vec3 aOff; attribute vec2 aSize; attribute vec4 aTile; attribute float aRot;
      varying vec2 vUv; varying vec3 vW;
      void main(){
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        ${mode === 0 ? 'right = normalize(vec3(right.x,0.,right.z)); up = vec3(0.,1.,0.);' : ''}
        vec2 q = position.xy*aSize; float c = cos(aRot), s = sin(aRot);
        q = vec2(c*q.x - s*q.y, s*q.x + c*q.y);
        vec3 p = aOff + right*q.x + up*q.y;
        vUv = aTile.xy + uv*aTile.zw; vW = p;
        gl_Position = projectionMatrix*viewMatrix*vec4(p,1.);
      }`,
    fragmentShader: `
      uniform sampler2D tMap; uniform vec3 uYellow, uCam, uSun; uniform float uTint, uWarm; varying vec2 vUv; varying vec3 vW;
      void main(){
        vec4 c = texture2D(tMap, vUv, -1.6); if (c.a < .42) discard;   // sharper mips keep thin sprites alive far away
        ${opts.fade ? `if (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453) > smoothstep(${opts.fade[0].toFixed(1)}, ${opts.fade[1].toFixed(1)}, distance(vW, uCam))) discard;` : ''}
        float l = dot(c.rgb, vec3(.33));
        vec3 col = c.rgb;
        ${opts.warm ? 'col = mix(col, mix(col, uYellow, .35), uWarm*uTint*smoothstep(.5,.8,l)*smoothstep(-.1,.6,dot(normalize(vW.xz-uCam.xz), normalize(uSun.xz))));' : ''}
        gl_FragColor = vec4(col, 1.);
      }`,
    side: THREE.DoubleSide,
    ...(opts.transparentDepth ? { depthWrite: false } : {}),
  });
}
// flat-shaded props (bridge, hut, fence, sign) with ink hulls
export function toonMat(lit, shade) {
  return new THREE.ShaderMaterial({
    uniforms: { uLit: { value: v3(lit) }, uShade: { value: v3(shade) }, uL: U.uL },
    vertexShader: `varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform vec3 uLit, uShade, uL; varying vec3 vN;
      void main(){ gl_FragColor = vec4(dot(normalize(vN), uL) > .05 ? uLit : uShade, 1.); }`,
  });
}
// wood: dark boards with paper grain cuts along the board
export const woodMat = new THREE.ShaderMaterial({
  uniforms: { ...U },
  vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: GLSL_HASH + `
    uniform vec3 uInk, uPaper, uL; varying vec3 vW; varying vec3 vN;
    void main(){
      vec3 n = normalize(vN);
      if (n.y > .7) { gl_FragColor = vec4(uPaper, 1.); return; }   // snow on top
      float along = abs(n.x) > abs(n.z) ? vW.z : vW.x;
      float v = vW.y*7. + sin(along*1.3)*.3, row = floor(v), f = fract(v)-.5;
      float segs = along*(.8+h11(row)) + h11(row*2.)*5.;
      float on = step(.55, h11(floor(segs)+row*3.)) * smoothstep(0.,.1,fract(segs))*(1.-smoothstep(.4,.9,fract(segs)));
      float aa = fwidth(v), lit = dot(n, uL) > .05 ? 1. : .45;
      float k = on*(1.-smoothstep(.06*lit-aa, .06*lit+aa, abs(f)));
      gl_FragColor = vec4(mix(uInk, uPaper, k*.8), 1.);
    }`,
});
// concrete in moonlight: lit faces paper with the formwork lines cut in ink, shadow faces ink with paper lines
export const concreteMat = new THREE.ShaderMaterial({
  uniforms: { ...U },
  vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: GLSL_HASH + `
    uniform vec3 uInk, uPaper, uL; varying vec3 vW; varying vec3 vN;
    float ln(float v, float w){ float f = abs(fract(v)-.5), a = fwidth(v); return 1.-smoothstep(w-a, w+a, f); }
    void main(){
      vec3 n = normalize(vN);
      if (n.y > .7) { gl_FragColor = vec4(uPaper, 1.); return; }
      float along = abs(n.x) > abs(n.z) ? vW.z : vW.x;
      // courses of cut stone: horizontal joints every 0.42 m, staggered vertical joints
      float fy = fract(vW.y/.42), row = floor(vW.y/.42);
      float joints = max(ln(vW.y/.42 + .5, .035), ln(along/.9 + h11(row)*.5 + .5, .03) * step(.12, fy) * step(fy, .88));
      if (dot(n, uL) <= 0.) {   // the shadow face: ink, diagonal hatching, paper joints
        float hatch = ln((along + vW.y*.8)*7., .16);
        gl_FragColor = vec4(mix(uInk, uPaper, max(joints*.85, hatch*.4)), 1.); return;
      }
      // the lit face: paper, ink joints, chisel marks thicker toward the waterline, a frozen splash band at the bottom
      vec2 cc = vec2(along, vW.y)*vec2(9., 14.); vec2 ci = floor(cc), cf = fract(cc)-.5;
      float chis = step(.74 - .22*smoothstep(1.4, -.6, vW.y), h21(ci)) * (1.-smoothstep(.05, .09, abs(cf.x - cf.y*.6)));
      float k = max(joints*.95, chis*.8);
      float ice = smoothstep(-.4, -.25, vW.y) * (1.-smoothstep(.0, .3 + .25*h11(floor(along*6.)), vW.y));
    
      gl_FragColor = vec4(mix(uPaper, uInk, k), 1.);
    }`,
});
// carriage planks: an ink field; tongue-and-groove seams cut in paper, broken, thicker on the lit side; a paper belt
// moulding under and over the windows; short grain nicks. Top faces carry snow.
export const plankMat = new THREE.ShaderMaterial({
  uniforms: { ...U },
  vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: GLSL_HASH + `
    uniform vec3 uInk, uPaper, uL; varying vec3 vW; varying vec3 vN;
    void main(){
      vec3 n = normalize(vN);
      if (n.y > .7) { gl_FragColor = vec4(uPaper, 1.); return; }
      if (n.y < -.7) { gl_FragColor = vec4(uInk, 1.); return; }
      float along = abs(n.x) > abs(n.z) ? vW.z : vW.x;
      float lit = dot(n, uL) > .05 ? 1. : 0.;
      // inside a carriage it is dark: only a few nicks catch the light
      bool inside = (vW.x < 4.4 && n.x > .5) || (vW.x > 4.4 && vW.x < 6. && n.x < -.5);
      if (inside) { vec2 ic = floor(vec2(along*5., vW.y*9.)); float ik = step(.985, h21(ic)) * step(abs(fract(vW.y*9.)-.5), .08);
        gl_FragColor = vec4(mix(uInk, uPaper, ik*.7), 1.); return; }
      // vertical seams every 11 cm, cut in short broken lengths
      float s = along/.11, sf = abs(fract(s)-.5), sa = fwidth(s);
      float sid = floor(s), seg = floor(vW.y*2.2 + h11(sid)*4.);
      float on = step(lit > .5 ? .62 : .85, h11(seg*3.1 + sid*.71));
      float sw = lit > .5 ? .032 : .022;
      float k = on*(1.-smoothstep(sw-sa, sw+sa, sf));
      // belt mouldings
      float ya = fwidth(vW.y);
      for (int i=0;i<3;i++){ float yy = i==0 ? 2.18 : i==1 ? 3.24 : 1.12; k = max(k, (1.-smoothstep(.012-ya, .012+ya, abs(vW.y-yy)))*(.4+.6*lit)); }
      // grain nicks
      vec2 gc = floor(vec2(along*9., vW.y*26.)); vec2 gf = fract(vec2(along*9., vW.y*26.))-.5;
      float nick = step(.965 - .02*lit, h21(gc)) * (1.-smoothstep(.06, .12, abs(gf.y))) * step(abs(gf.x), .45);
      k = max(k, nick*.9);
      gl_FragColor = vec4(mix(uInk, uPaper, k*.92), 1.);
    }`,
});
export const inkMat = new THREE.MeshBasicMaterial({ color: C.ink });
export const paperMat = new THREE.MeshBasicMaterial({ color: C.paper });
export const hullMat = new THREE.MeshBasicMaterial({ color: C.ink, side: THREE.BackSide });
// snow on a roof (carriage, canopy, station, cab): paper with sparse drift strokes running along the roof, snow ridges
// blown into short ink lines, and a few slanted stabs near the lens, so a roof the camera rises past never goes blank.
// Cuts are spaced in metres (world space) and fade to paper once a quarter of a row falls inside one pixel.
export const roofMat = new THREE.ShaderMaterial({
  uniforms: { ...U },
  vertexShader: VS_WORLD,
  fragmentShader: GLSL_HASH + `
    uniform vec3 uInk, uPaper, uCam; varying vec3 vW;
    void main(){
      float dist = distance(vW, uCam);
      float v = vW.x*4.6 + sin(vW.z*.37 + vW.x*.8)*.45;
      float row = floor(v), f = fract(v)-.5 - (h11(row*2.7)-.5)*.4;
      float segs = vW.z/(.7+h11(row)*1.9) + h11(row*3.1)*9.;
      float sf = fract(segs);
      float on = step(.46, h11(floor(segs)*1.7 + row*.37)) * smoothstep(0.,.08,sf) * (1.-smoothstep(.3,.85,sf));
      float w = (.035 + .07*h11(floor(segs)+row*1.3))*on, aa = fwidth(v);
      float k = on*(1.-smoothstep(w-aa, w+aa, abs(f)));
      k *= 1.-smoothstep(.22, .5, aa);
      vec2 gc = floor(vW.xz/vec2(.32,.27)); vec2 gf = fract(vW.xz/vec2(.32,.27))-.5;
      float gr = h21(gc*1.37);
      float stab = step(.88, gr) * (1.-smoothstep(.04, .075, abs(gf.x*.7 + gf.y - (gr-.94)*2.))) * step(abs(gf.x), .3);
      stab *= 1.-smoothstep(10., 24., dist);
      k = max(k, stab);
      gl_FragColor = vec4(mix(uPaper, uInk, step(.5, k)), 1.);
    }`,
});
