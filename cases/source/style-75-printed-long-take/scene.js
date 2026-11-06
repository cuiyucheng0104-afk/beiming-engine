// 雪夜小站 — Printed Long Take. One unbroken move: down the line through the snow, through the engine's steam, along a
// wooden carriage to one dark window where a red lantern wakes; two beats of stillness; a great bell, the camera rises,
// and 归 is cut into the night sky as a plate of type. Everything is a function of t; timeline.js is the only clock.
import * as THREE from 'three';
import { mulberry, clamp, lerp, ss, eio, seg, track, hash } from '/core/lib.js';
import { C, U, skyMat, GLSL_HASH } from './look.js';
import { buildWorld, canvasTex, LANTERN, POLE_X } from './world.js';
import { lanternCanvas, LANT } from './textures.js';
import { plateCanvas, plateInfo, PLATE } from './props.js';
import { T, CUES, B } from './timeline.js';

const Q = new URLSearchParams(location.search);
const W_ = 1920, H_ = 1080, SS = 2, DEG = Math.PI / 180;
window.DUR = T.DUR;

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(W_, H_, false);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);
const rtA = new THREE.WebGLRenderTarget(W_ * SS, H_ * SS, { samples: 4 });
const scene = new THREE.Scene(); scene.background = C.ink;
const camera = new THREE.PerspectiveCamera(34, W_ / H_, .08, 9000);
const projScale = () => H_ * SS / (2 * Math.tan(camera.fov * Math.PI / 360));

// ================================================================ the camera: one take, written as explicit motion
// A 0–5 low glide at 7 m/s · B 5–8 accelerating to 13 m/s into the steam · C 8–10 braking along the carriage, turning
// to the window · D 10–13 a slow push · E 13–15 locked · F 15–19.9 back off, crane up, tilt up, pull back, ease into a hold
const dirOf = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
const AZW = 60 * DEG;   // the look onto the lantern's window, a three-quarter angle
function glide(t) {
  let z;
  if (t < 5) z = 63 - 7 * t;
  else if (t < 8) { const u = t - 5; z = 28 - 7 * u - u * u; }
  else { const u = clamp((t - 8) / 2); z = -2 - 13 * (1 - (1 - u) * (1 - u)); }
  const x = lerp(0, .74, ss(seg(t, 6.8, 10)));
  const y = t < 8 ? lerp(1.35, 1.9, ss(seg(t, 4, 8))) : lerp(1.9, 2.66, ss(seg(t, 8, 10)));
  const az = lerp(0, AZW, ss(seg(t, 8.15, 10)));
  const el = t < 8 ? lerp(-5.5, -3.5, ss(seg(t, 4, 8))) * DEG : lerp(-3.5, 0, ss(seg(t, 8, 10))) * DEG;
  const fov = t < 8 ? lerp(36, 34, ss(seg(t, 5, 8))) : lerp(34, 30, ss(seg(t, 8, 10)));
  return { e: [x, y, z], az, el, fov };
}
const E10 = glide(10).e;
const PUSH = .6;
const eyeD = t => { const d = dirOf(AZW, 0), k = PUSH * ss(seg(t, 10, 13)); return [E10[0] + d.x * k, E10[1], E10[2] + d.z * k]; };
const E13 = eyeD(13);
const RISE = track([
  [13, [...E13, AZW / DEG, 0, 30]],
  [15, [...E13, AZW / DEG, 0, 30]],
  // the bell: first the camera backs away from the window (the lantern stays in the lower third and in sight),
  // keeping near the roof line so no carriage roof fills the lens; only then the crane climbs and the tilt opens the sky
  [15.55, [E13[0] - 1.1, E13[1] + .3, E13[2] + .6, 59, -.8, 31]],
  [16.2, [-5.5, 4.4, -9.0, 49, 5.5, 37]],
  [17.0, [-21.5, 8.2, 3.2, 46.5, 6.0, 39]],
  [17.6, [-26.5, 8.7, 7.0, 44.6, 6.6, 40]],
  [19.9, [-29.0, 9.0, 8.9, 43.6, 6.85, 40.8]],
]);
function camAt(t) {
  if (t < 10) return glide(t);
  if (t < 13) return { e: eyeD(t), az: AZW, el: 0, fov: 30 };
  const r = RISE(t);
  return { e: r.slice(0, 3), az: r[3] * DEG, el: r[4] * DEG, fov: r[5] };
}
function applyCam(c) {
  camera.position.set(...c.e);
  const d = dirOf(c.az, c.el);
  camera.lookAt(c.e[0] + d.x, c.e[1] + d.y, c.e[2] + d.z);
  if (camera.fov !== c.fov) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}

// ---------------------------------------------------------------- the poles: placed so that one leaves the frame on each beat
// (the left edge of the frame, the moment the whoosh peaks); solved against the camera itself
const POLE_Z = T.poles.map(tb => {
  // the middle of the pole (y = 3 m) on the left edge of the frame at the beat: bisection against a camera set from camAt
  const c = camAt(tb), cam = new THREE.PerspectiveCamera(c.fov, W_ / H_, .08, 9000), d = dirOf(c.az, c.el);
  cam.position.set(...c.e); cam.lookAt(c.e[0] + d.x, c.e[1] + d.y, c.e[2] + d.z); cam.updateMatrixWorld();
  const sx = z => new THREE.Vector3(POLE_X, 3, z).project(cam).x;   // -1 = left edge
  let lo = c.e[2] - 60, hi = c.e[2] - 1;                               // far: x > -1, near: x < -1
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (sx(m) > -1) lo = m; else hi = m; }
  return (lo + hi) / 2;
});
// path clearance for the pines
const CLEAR = (() => { const o = []; for (let t = 0; t <= T.DUR; t += .1) { const c = camAt(t); o.push([c.e[0], c.e[2], 14]); } return o; })();

const fontFace = await new FontFace('NotoSerifSC', 'url(./fonts/NotoSerifSC-700-gui.woff2)', { weight: '700' }).load();
document.fonts.add(fontFace);
const W = buildWorld(scene, { poleZ: POLE_Z, clear: CLEAR, proj: projScale() });

// ---------------------------------------------------------------- the print pass (the demo kit's printMat, without peel and subtitles)
const printMat = new THREE.ShaderMaterial({
  uniforms: { tA: { value: rtA.texture }, uT: { value: 0 }, uWhite: { value: 0 }, uPaper: U.uPaper, uInk: U.uInk, uShake: { value: new THREE.Vector2() } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }`,
  fragmentShader: GLSL_HASH + `
    uniform sampler2D tA; uniform float uT, uWhite; uniform vec3 uPaper, uInk; uniform vec2 uShake; varying vec2 vUv;
    float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*vn(p); p*=2.03; a*=.5; } return s; }
    void main(){
      vec2 uv = vUv + uShake;
      vec3 c = texture2D(tA, uv).rgb;
      float lum = dot(c, vec3(.299,.587,.114));
      float dark = 1. - smoothstep(.18, .55, lum);
      float tf = floor(uT*12.)/12.;
      float fib = fbm(uv*vec2(700.,420.));
      c *= 1. + (fib-.5)*.06*(1.-dark);
      float mot = fbm(uv*vec2(46.,26.) + 3.);
      c += dark*(mot-.5)*.05;
      float b = fbm(vec2(uv.x*4.2 + tf*.06, uv.y*2.2 - tf*.02) + 11.);
      b = smoothstep(.5, .78, b) * smoothstep(.62, 1., uv.y);
      c += dark*b*.07;
      // through the steam: the picture is eaten by horizontal paper cuts (never all of it: ink rows stay)
      if (uWhite > 0.) {
        float row = floor(uv.y*120.), f = abs(fract(uv.y*120.)-.5);
        float r = h11(row*1.7), run = vn(vec2(uv.x*3. + r*20., row*.37));
        // binary: a row of the picture is either still there or already paper (no half-eaten grey bars)
        float w = step(.125, uWhite*1.8 - r*.5 - run*.5 + (.5-f)*.3);
        c = mix(c, uPaper*(1. + (fib-.5)*.05), w);
        // the steam is a paper field carrying ink cuts: horizontal knife dashes streaming past the lens
        // each dash switches on whole once the whiteout passes its own threshold: ink or paper, never a half-mix
        float rr = floor(uv.y*64.), ff = abs(fract(uv.y*64.)-.5);
        float sx = uv.x*(3. + h11(rr*2.3)*5.) + uT*(2.5 + h11(rr)*3.) + h11(rr*7.7)*11.;
        float on = step(.62, h11(floor(sx)*1.37 + rr*.91)) * step(.3, h11(rr*4.1));
        float tp = smoothstep(0., .08, fract(sx)) * (1. - smoothstep(.35 + .4*h11(rr*9.), .95, fract(sx)));
        float wd = (.08 + .22*h11(rr*5.3 + floor(sx)))*tp*(1. + 6.*(.6 - uWhite));   // the dashes are thinnest on the peak frame: the white lands on the beat
        float a = step(.01 + .14*h11(rr*3.7 + floor(sx)*.53), uWhite);
        c = mix(c, uInk, on * step(ff, wd) * a);
      }
      c *= 1. + (h11(tf*13.7)-.5)*.03;
      vec2 q = uv-.5; c *= 1. - dot(q,q)*.1;
      gl_FragColor = vec4(c, 1.);
    }`,
  depthTest: false, depthWrite: false,
});
const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), printMat));

// ================================================================ steam
// a standing bank around the engine (it has been breathing all night), and one puff per chuff: a pop at the chimney
// and two jets from the cylinder cocks blown across the main line, where the camera will pass
const ENG = { chim: [4.4, 4.45, -5.3], cock: [3.0, .75, -5.6] };
const BANK = (() => {
  const R = mulberry(808), L = [];
  for (let i = 0; i < 26; i++) L.push({ x: lerp(-1.5, 7.5, R()), y: .6 + Math.pow(R(), 1.5) * 4.2, z: lerp(-8, -1.2, R()), s: 2.2 + R() * 2.6, v: Math.floor(R() * 4), ph: R() * 6 });
  for (let i = 0; i < 8; i++) L.push({ x: 4.4 + (R() - .5) * 2, y: 5 + R() * 4, z: -5.3 + (R() - .5) * 3, s: 2.5 + R() * 2.5, v: Math.floor(R() * 4), ph: R() * 6, up: 1 });
  return L;
})();
function placeSteam(t) {
  const list = [], R = mulberry(9090);
  for (const b of BANK) {
    const br = .9 + .1 * Math.sin(t * .7 + b.ph);
    const y = b.up ? b.y + ((t * .35 + b.ph) % 3) : b.y + Math.sin(t * .3 + b.ph) * .2;
    list.push([b.x + Math.sin(t * .2 + b.ph) * .4 - (b.up ? t * .15 % 2 : 0), y, b.z, b.s * br, b.s * br * .8, b.v, Math.sin(b.ph) * .08]);
  }
  T.chuffs.forEach((tc, i) => {
    const age = t - tc; if (age < 0) return;
    const k = 1 + i * .12;   // later chuffs come harder
    // the chimney pop: a puff that rises and drifts back over the train
    if (age < 6) {
      const s = (1.3 + age * 2.2) * k;
      list.push([ENG.chim[0] - age * .6, ENG.chim[1] + .4 + age * 1.7 - age * age * .05, ENG.chim[2] + age * .4, s, s * .85, i % 4, Math.sin(i * 1.7) * .1]);
    }
    // the cock jets: low, fast, across the line toward -x, slowing and spreading
    if (age < 5) for (let j = 0; j < 3; j++) {
      const sp = 7.5 * (1 - Math.exp(-age * 1.4)) / 1.4 * (1 + j * .25), s = (.9 + age * 1.6 + j * .4) * k;
      list.push([ENG.cock[0] - sp, ENG.cock[1] + .2 + age * .35 + j * .3, ENG.cock[2] + j * 1.1 + age * .5, s, s * .7, (i + j) % 4, (j - 1) * .08]);
    }
  });
  // keep the puffs that would sit right on the lens out of the picture (the whiteout carries the pass instead)
  const cp = camera.position;
  const out = list.filter(p => Math.hypot(p[0] - cp.x, p[1] - cp.y, p[2] - cp.z) > p[3] * .7 + .8);
  fillBoardsN(W.puffs, out);
}
function fillBoardsN(mesh, list) {
  const a = mesh.geometry.attributes, n = Math.min(list.length, a.aRot.count);
  for (let i = 0; i < n; i++) {
    const [x, y, z, w, h, v, rot] = list[i];
    a.aOff.array.set([x, y, z], i * 3); a.aSize.array.set([w, h], i * 2);
    a.aTile.array.set([(v % 2) / 2, (1 - Math.floor(v / 2)) / 2, .5, .5], i * 4); a.aRot.array[i] = rot;
  }
  mesh.geometry.instanceCount = n;
  for (const k in a) a[k].needsUpdate = true;
}
const whiteAt = t => t < T.whiteIn || t > T.whiteOut ? 0 : t < T.whitePeak ? ss(seg(t, T.whiteIn, T.whitePeak)) * .6 : (1 - ss(seg(t, T.whitePeak, T.whiteOut))) * .6;

// ================================================================ falling snow, fixed in the world, wrapped round the camera
function placeSnow(t) {
  const P = W.snow.geometry.attributes.position.array, S = W.snow.geometry.attributes.aS.array, cp = camera.position;
  const SX = 28, SY = 16, SZ = 28;
  W.snowSeed.forEach(([a, b, c, s, ph], i) => {
    let x = a * SX + Math.sin(t * .6 + ph * 6) * .3 - t * .35, y = b * SY - t * (.7 + s * 8), z = c * SZ + t * .1;
    x -= SX * Math.round((x - cp.x) / SX); y -= SY * Math.round((y - cp.y - 2) / SY); z -= SZ * Math.round((z - cp.z) / SZ);
    P[i * 3] = x; P[i * 3 + 1] = Math.max(y, .02); P[i * 3 + 2] = z; S[i] = y > .02 ? s : 0;
  });
  W.snow.geometry.attributes.position.needsUpdate = W.snow.geometry.attributes.aS.needsUpdate = true;
  W.snow.material.uniforms.uProj.value = projScale();
}

// ================================================================ one red waking
// far away the lantern keeps a minimum size: a red stab with a paper ring, sitting on the window, never under ~6 px
const redGeo = new THREE.BufferGeometry();
redGeo.setAttribute('position', new THREE.Float32BufferAttribute([LANTERN.x - .3, LANTERN.y - .02, LANTERN.z], 3));
const redMark = new THREE.Points(redGeo, new THREE.ShaderMaterial({
  uniforms: { uProj: { value: projScale() }, uMin: { value: 7 * SS }, uOn: { value: 0 }, uRed: { value: new THREE.Vector3(C.red.r, C.red.g, C.red.b) }, uPaper: U.uPaper },
  vertexShader: `uniform float uProj, uMin, uOn; void main(){ vec4 mv = viewMatrix*vec4(position,1.); float px = .34*uProj/-mv.z; gl_PointSize = uOn > .5 ? max(px, uMin)*1.4 : 0.; gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 uRed, uPaper; void main(){ vec2 q = (gl_PointCoord-.5)*vec2(1., .82); float r = length(q); if (r > .5) discard; gl_FragColor = vec4(r < .36 ? uRed : uPaper, 1.); }`,
}));
redMark.frustumCulled = false; redMark.renderOrder = 7; scene.add(redMark);
let lantKey = '';
function lanternState(t) {
  return { wick: t >= T.wick ? 1 : 0, rows: t >= T.body ? Math.max(1 / 16, clamp((t - T.body) / (T.bodyEnd - T.body))) : 0, done: t >= T.done ? Math.max(.35, clamp((t - T.done) / .25)) : 0 };
}
function updateLantern(t) {
  const st = lanternState(t), rowsQ = Math.ceil(st.rows * 16) / 16;   // whole rows only
  const key = [st.wick, rowsQ, st.done.toFixed(2)].join();
  if (key === lantKey) return; lantKey = key;
  lanternCanvas(W.lanternCanvas, { ...st, rows: rowsQ }); W.lanternTex.needsUpdate = true;
}

// ================================================================ the plate of type in the sky
const PL = { az: 34.5 * DEG, el: 12.6 * DEG, h: 13.6 * DEG };
const plateRect = (k = 1) => { const hw = PL.h / 2 / Math.cos(PL.el) * k, hh = PL.h / 2 * k; return [PL.az - hw, PL.el - hh, PL.az + hw, PL.el + hh]; };
const plateC = plateCanvas(null, { block: 0, strokes: [], press: 0 });
const plateTex = canvasTex(plateC);
skyMat.uniforms.tType1.value = plateTex; skyMat.uniforms.uAmt1.value = 0;
let plateKey = '';
function plateState(t) {
  return {
    block: t >= T.block ? 1 : 0,
    strokes: T.knives.map(tk => t >= tk ? (t - tk < .1 ? .999 : 1) : 0),   // a stab of the knife on the beat; chips fly for three frames   // the knife's first bite shows on the beat frame
    press: t >= T.press ? 1 : 0,
  };
}
function updatePlate(t) {
  const st = plateState(t), key = [st.block, ...st.strokes.map(v => v.toFixed(2)), st.press].join();
  // the block lands: it arrives a little large and settles in a tenth of a second
  const land = clamp((t - T.block) / .1);   // 0 on the beat → 1 three frames later
  skyMat.uniforms.uRect1.value.set(...plateRect(t >= T.block ? 1 + .06 * (1 - land) * (1 - land) : 1));
  skyMat.uniforms.uAmt1.value = st.block;
  if (key === plateKey) return; plateKey = key;
  plateCanvas(plateC, st); plateTex.needsUpdate = true;
}

// ================================================================ sky, moon, light
const MOON = dirOf(-22 * DEG, 8.5 * DEG);
function setSky() {
  skyMat.uniforms.uFront.value = -1; skyMat.uniforms.uStars.value = 1; skyMat.uniforms.uDense.value = 0;
  U.uWarm.value = 0;
  U.uL.value.set(-0.5, 0.42, 0.75).normalize();   // the moon behind the camera's left shoulder lights the faces toward +z, -x
  W.moon.position.copy(camera.position).addScaledVector(MOON, 7000); W.moon.lookAt(camera.position);
  W.sky.position.copy(camera.position);
  U.uCam.value.copy(camera.position);
}

// ================================================================ render
let CAM = null;
window.render = (t) => {
  const c = CAM = camAt(t);
  if (Q.get('cam')) { const v = Q.get('cam').split(',').map(Number); c.e = v.slice(0, 3); c.az = v[3] * DEG; c.el = v[4] * DEG; c.fov = v[5] || c.fov; }
  applyCam(c);
  setSky();
  placeSteam(t); placeSnow(t);
  updateLantern(t); updatePlate(t);
  redMark.material.uniforms.uProj.value = projScale();
  redMark.material.uniforms.uOn.value = t >= T.body && camera.position.distanceTo(W.lantern.position) > 26 ? 1 : 0;   // far enough that the stab and the lantern are the same size: no visible swap
  renderer.setRenderTarget(rtA); renderer.render(scene, camera);
  printMat.uniforms.uT.value = t;
  printMat.uniforms.uWhite.value = whiteAt(t);
  // the block lands: one frame of shake (the only one in the film; STYLE §5 allows one frame for an impact)
  const hit = t >= T.block - 1e-6 && t < T.block + 1 / 30 - 1e-6;
  printMat.uniforms.uShake.value.set(hit ? .0016 : 0, hit ? -.0024 : 0);
  renderer.setRenderTarget(null); renderer.render(postScene, postCam);
};

// ================================================================ reading check: the one word, with its screen box
const toScreen = v => { const p = v.clone().project(camera); return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight, p.z]; };
window.TEXTS = (t) => {
  if (t < T.hold || !(skyMat.uniforms.uAmt1.value > 0)) return [];
  const [S, b] = [PLATE.S, plateInfo().box], r = plateRect(1);
  const u0 = b[0] / S, u1 = b[2] / S, v0 = 1 - b[3] / S, v1 = 1 - b[1] / S;   // canvas y down → elevation up
  const pts = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]].map(([u, v]) => dirOf(lerp(r[0], r[2], u), lerp(r[1], r[3], v)).multiplyScalar(1000).add(camera.position));
  const s = pts.map(toScreen); if (s.some(p => p[2] > 1 || p[2] < -1)) return [];
  return [{ id: 'plate-gui', text: PLATE.ch, x0: Math.min(...s.map(p => p[0])), y0: Math.min(...s.map(p => p[1])), x1: Math.max(...s.map(p => p[0])), y1: Math.max(...s.map(p => p[1])) }];
};
// the screen position of the lantern and of the plate, for the checks (tools/)
window.PROBE = (t) => { window.render(t); const l = toScreen(new THREE.Vector3(LANTERN.x, LANTERN.y, LANTERN.z)); const tx = window.TEXTS(t); return { lantern: l, plate: tx[0] || null, cam: CAM }; };

// ================================================================ events for the sound (every one on the grid in timeline.js)
window.EV = (() => {
  const E = [], add = (t, type, o = {}) => E.push({ t: +t.toFixed(4), type, ...o });
  add(0, 'start'); add(T.bellFar, 'bellFar');
  T.poles.forEach((t, i) => add(t, 'pole', { i }));
  T.chuffs.forEach((t, i) => add(t, 'chuff', { i }));
  add(T.whiteIn, 'steamIn'); add(T.whitePeak, 'whitePeak'); add(T.whiteOut, 'steamOut');
  add(T.creak, 'creak');
  add(T.wick, 'wick'); add(T.body, 'body'); add(T.done, 'done');
  add(T.silence[0], 'silence'); add(T.bell, 'bell');
  add(T.block, 'block'); T.knives.forEach((t, i) => add(t, 'knife', { i })); add(T.press, 'press');
  add(T.DUR, 'end');
  return E.sort((a, b) => a.t - b.t);
})();
window.CUES = CUES.map(([n, b]) => ({ n, b, t: B(b) }));
// for tools/probe.mjs: where each pole is on screen at its beat (0 = the left edge of the frame)
window.CHECK = {
  poles: () => T.poles.map((t, i) => { window.render(t); const s = toScreen(new THREE.Vector3(POLE_X, 3, POLE_Z[i])); return { t, x: s[0] }; }),
  puffs: (t) => { window.render(t); return W.puffs.geometry.instanceCount; },
  tasselBox: (t) => { window.render(t); W.lantern.updateMatrixWorld();
    const lw = W.lantern.geometry.parameters.width, lh = W.lantern.geometry.parameters.height, L = LANT;
    const P = [[L.cx - 40, L.cy + L.ry + 26], [L.cx + 40, L.cy + L.ry + 26], [L.cx - 40, L.H], [L.cx + 40, L.H]].map(([x, y]) => toScreen(W.lantern.localToWorld(new THREE.Vector3((x / L.W - .5) * lw, (.5 - y / L.H) * lh, 0))));
    return [Math.min(...P.map(p => p[0])), Math.min(...P.map(p => p[1])), Math.max(...P.map(p => p[0])), Math.max(...P.map(p => p[1]))]; },
  plateBox: (t) => { window.render(t); const r = plateRect(1), m = .25;
    const pts = [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]].map(([a, e]) => toScreen(dirOf(a, e).multiplyScalar(1000).add(camera.position)));
    return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]; },
};
window.render(0);
window.READY = true;
