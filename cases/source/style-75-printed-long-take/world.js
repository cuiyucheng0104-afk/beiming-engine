// The world of 雪夜小站: a snow plain at night, a single line with a siding, telegraph poles, a small station with a
// platform, a tank engine and three wooden carriages; pine belts, a row of faceted mountains, the moon.
// Units are metres; the line runs along -z (forward), x = 0 is the main line, x = 4.4 the siding at the platform.
import * as THREE from 'three';
import { mulberry, clamp, lerp } from '/core/lib.js';
import { C, U, mtnMat, snowMat, railMat, skyMat, billboardMat, toonMat, woodMat, plankMat, concreteMat, inkMat, paperMat, hullMat, roofMat } from './look.js';
import { pineAtlas, moonCanvas, lampCanvas, frostCanvas, puffAtlas, lanternCanvas, LANT } from './textures.js';

export const SIDING = 4.4;
export const CAR = { x0: 3.0, x1: 5.8, y0: 1.0, y1: 3.75, win: { w: 1.0, h: .9, y: 2.7 } };
export const CARS = [[-13.8, -29.8], [-30.6, -46.6], [-47.4, -63.4]];   // [front z, back z]
export const LANTERN = { x: 3.2, y: 2.66, z: -16.45 };                     // hung just inside the window of car 1
export const POLE_X = -3.4;

export function canvasTex(c, mips = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  return t;
}

// ------------------------------------------------------------------ faceted mountains (the demo kit's cone)
function volcano(cx, cz, h, r, seed, crater = 0) {
  const R = mulberry(seed), pos = [], n = 16;
  const prof = [[1, 0], [.62, .22], [.36, .5], [.17, .78], [.06 + crater * .14, .95 - crater * .1]];
  const rings = prof.map(([rf, hf], k) => {
    const a0 = R() * .4, ring = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + i / n * Math.PI * 2 + (R() - .5) * .12 * (k > 0);
      const rr = r * rf * (1 + (R() - .5) * .1), hh = h * hf * (1 + (R() - .5) * .04 * (k > 0));
      ring.push([cx + Math.cos(a) * rr, k ? hh : -4, cz + Math.sin(a) * rr * .7]);
    }
    return ring;
  });
  const apex = [cx, h * (crater ? .86 : 1), cz];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, A = rings[k], B = rings[k + 1];
    tri(A[i], B[j], A[j]); tri(A[i], B[i], B[j]);
  }
  const top = rings[rings.length - 1];
  for (let i = 0; i < n; i++) tri(top[i], apex, top[(i + 1) % n]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(g, mtnMat);
}

// ------------------------------------------------------------------ instanced billboards (the demo kit)
export function billboards(count, mat, pivotBottom) {
  const base = new THREE.PlaneGeometry(1, 1); if (pivotBottom) base.translate(0, .5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2));
  g.setAttribute('aTile', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));
  g.setAttribute('aRot', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  g.instanceCount = count;
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false; return m;
}
export function fillBoards(mesh, list, cols, rows = 1) {
  const a = mesh.geometry.attributes;
  list.forEach(([x, y, z, w, h, v, rot = 0], i) => {
    a.aOff.array.set([x, y, z], i * 3); a.aSize.array.set([w, h], i * 2);
    a.aTile.array.set([(v % cols) / cols, (rows - 1 - Math.floor(v / cols)) / rows, 1 / cols, 1 / rows], i * 4); a.aRot.array[i] = rot;
  });
  mesh.geometry.instanceCount = list.length;
  for (const k in a) a[k].needsUpdate = true;
}

// ------------------------------------------------------------------ boxes with an ink hull
const E = .03;
function box(parent, w, h, d, x, y, z, mat, outline = true, ry = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.rotation.y = ry; parent.add(m);
  if (outline) { const o = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * E, h + 2 * E, d + 2 * E), hullMat); o.position.copy(m.position); o.rotation.y = ry; parent.add(o); }
  return m;
}
function cyl(parent, r, len, x, y, z, mat, axis = 'z', seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  if (axis === 'z') m.rotation.x = Math.PI / 2; if (axis === 'x') m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z); parent.add(m); return m;
}
// cast iron of the engine: ink, with paper bands cut across the lit side
const ironMat = new THREE.ShaderMaterial({
  uniforms: { ...U },
  vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `
    uniform vec3 uInk, uPaper, uL; varying vec3 vW; varying vec3 vN;
    float h11(float n){ return fract(sin(n*127.1+311.7)*43758.5453); }
    void main(){
      vec3 n = normalize(vN);
      if (n.y > .8) { gl_FragColor = vec4(uPaper, 1.); return; }   // snow lying on top
      float ndl = dot(n, uL);
      float v = vW.y*9. + sin(vW.z*1.7)*.15, f = abs(fract(v)-.5), aa = fwidth(v);
      float seg = step(.35, h11(floor(vW.z*1.3) + floor(v)*7.1));
      float w = ndl > .25 ? .16 : ndl > -.1 ? .06 : 0.;
      float k = seg*(1.-smoothstep(w-aa, w+aa, f));
      gl_FragColor = vec4(mix(uInk, uPaper, k*.9), 1.);
    }`,
});

// ------------------------------------------------------------------ the line
function tracks(scene) {
  const g = new THREE.Group();
  const rail = (x, z0, z1) => { const m = new THREE.Mesh(new THREE.BoxGeometry(.075, .15, z0 - z1), railMat); m.position.set(x, .2, (z0 + z1) / 2); g.add(m); };
  for (const s of [-1, 1]) rail(s * .72, 140, -700);
  for (const s of [-1, 1]) rail(SIDING + s * .72, 14, -140);
  // the siding joins the main line in a long gentle crossover (two short angled rails)
  // sleepers: half buried in snow; some show their ink sides, some only a paper hump
  const R = mulberry(77), slp = [];
  for (let z = 140; z > -700; z -= .68) slp.push([0, z + (R() - .5) * .04]);
  for (let z = 14; z > -140; z -= .68) slp.push([SIDING, z + (R() - .5) * .04]);
  const geo = new THREE.BoxGeometry(2.5, .14, .24);
  const inkS = new THREE.InstancedMesh(geo, woodMat, slp.length);
  const mtx = new THREE.Matrix4();
  slp.forEach(([x, z], i) => { mtx.makeTranslation(x + (R() - .5) * .05, .07 + (R() - .5) * .03, z); inkS.setMatrixAt(i, mtx); });
  g.add(inkS);
  scene.add(g);
  return g;
}

// ------------------------------------------------------------------ telegraph poles and their wires
function poles(scene, zs) {
  const g = new THREE.Group(), R = mulberry(31);
  const tops = [];
  for (const z of zs) {
    const h = 6.6 + (R() - .5) * .3, lean = (R() - .5) * .025;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(.09, .13, h, 10), woodMat);
    p.position.set(POLE_X, h / 2, z); p.rotation.z = lean; g.add(p);
    box(g, 1.7, .12, .12, POLE_X + lean * -h * .9, h - .45, z, woodMat, false);
    for (const dx of [-.7, 0, .7]) { const ins = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, .16, 8), paperMat); ins.position.set(POLE_X + dx + lean * -h * .9, h - .3, z); g.add(ins); }
    tops.push([POLE_X + lean * -h * .9, h - .22, z]);
  }
  // wires: sagging spans of thin ink between the crossarms (and on beyond the first and last pole)
  const wire = (a, b, dx) => {
    const n = 10, pts = [];
    for (let i = 0; i <= n; i++) { const u = i / n; pts.push(new THREE.Vector3(lerp(a[0], b[0], u) + dx, lerp(a[1], b[1], u) - Math.sin(u * Math.PI) * .32, lerp(a[2], b[2], u))); }
    const cv = new THREE.CatmullRomCurve3(pts);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(cv, 16, .018, 4, false), inkMat));
  };
  const all = [[tops[0][0], tops[0][1], tops[0][2] + 60], ...tops];
  for (let i = 0; i < all.length - 1; i++) for (const dx of [-.7, 0, .7]) wire(all[i], all[i + 1], dx);
  scene.add(g);
  return g;
}

// ------------------------------------------------------------------ the station
function station(scene, W) {
  const g = new THREE.Group();
  // the platform: cut stone with snow on it
  box(g, 5.8, .95, 64, 9.1, .475, -31, concreteMat);
  box(g, .3, .06, 64, 6.35, .98, -31, paperMat, false);
  // the canopy over the platform on cast posts
  for (let z = -6; z >= -58; z -= 6.5) box(g, .16, 3.4, .16, 10.2, .95 + 1.7, z, ironMat, false);
  box(g, 5.2, .16, 56, 10.0, 4.4, -32, woodMat);
  box(g, 5.4, .22, 56.4, 10.0, 4.6, -32, roofMat, true);          // snow on the canopy
  for (let i = 0; i < 40; i++) { const z = -4.5 - i * 1.4, L = .1 + ((i * 37) % 11) / 30; const c = new THREE.Mesh(new THREE.ConeGeometry(.03, L, 5), paperMat); c.rotation.x = Math.PI; c.position.set(7.4, 4.32 - L / 2, z); g.add(c); }
  // the station house: wooden walls, a gabled roof of snow, ink windows
  box(g, 6.6, 4.2, 16, 15.6, 2.1, -26, woodMat);
  const hw = 3.6, hd = 8.4, ry0 = 4.2, ry1 = 6.6;
  const roof = new THREE.BufferGeometry();
  const v = [-hw, ry0, -hd, -hw, ry0, hd, 0, ry1, hd, -hw, ry0, -hd, 0, ry1, hd, 0, ry1, -hd,
    hw, ry0, -hd, 0, ry1, -hd, 0, ry1, hd, hw, ry0, -hd, 0, ry1, hd, hw, ry0, hd];
  roof.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); roof.computeVertexNormals();
  const rm = new THREE.Mesh(roof, roofMat); rm.position.set(15.6, 0, -26); g.add(rm);
  const eave = box(g, 7.4, .12, 17, 15.6, 4.18, -26, inkMat, false);
  for (const z of [-21, -26, -31]) box(g, .06, 1.2, .9, 12.28, 2.2, z, inkMat, false);
  box(g, .08, .8, 1.1, 12.28, 2.0 + 1.6, -26, paperMat, false);
  // a chimney with a thread of smoke is left out: the only smoke is the engine's
  // lamps on posts along the platform edge: warm yellow light
  W.lamps = [];
  for (const z of [-3, -15, -27, -39, -51]) { box(g, .08, 3.2, .08, 7.0, .95 + 1.6, z, ironMat, false); box(g, .3, .36, .3, 7.0, 3.95, z, inkMat, false); W.lamps.push([7.0, 3.95, z - .01]); }
  scene.add(g);
  const lampTex = canvasTex(lampCanvas());
  const lm = billboards(W.lamps.length + 3, billboardMat(lampTex, 1), false);
  fillBoards(lm, [...W.lamps.map(([x, y, z]) => [x - .2, y, z, 1.1, 1.1, 0]), [12.25, 2.3, -21, .9, .9, 0], [12.25, 2.3, -31, .9, .9, 0], [3.0, 1.0, -3.95, .7, .7, 0]], 1, 1);
  scene.add(lm); W.lampMesh = lm;
  return g;
}

// ------------------------------------------------------------------ the tank engine, facing the camera, front at z -4.2
function engine(scene) {
  const g = new THREE.Group(), x = SIDING;
  box(g, 2.7, .3, 10, x, .95, -9.2, ironMat);                         // frame
  box(g, 2.9, .35, .3, x, 1.1, -4.25, ironMat);                       // buffer beam
  for (const s of [-1, 1]) cyl(g, .2, .5, x + s * .9, 1.1, -3.9, ironMat, 'z', 12);   // buffers
  cyl(g, .95, 5.6, x, 2.15, -7.6, ironMat, 'z', 24);                 // boiler
  cyl(g, 1.02, .9, x, 2.15, -5.0, ironMat, 'z', 24);                 // smokebox
  { const d = new THREE.Mesh(new THREE.CircleGeometry(.96, 24), inkMat); d.position.set(x, 2.15, -4.54); d.rotation.y = Math.PI; g.add(d);
    const r = new THREE.Mesh(new THREE.RingGeometry(.9, .96, 24), paperMat); r.position.set(x, 2.15, -4.53); r.rotation.y = Math.PI; g.add(r); }
  cyl(g, .26, 1.3, x, 3.6, -5.3, ironMat, 'y', 14);                  // chimney
  cyl(g, .34, .14, x, 4.28, -5.3, paperMat, 'y', 14);                // snow on its lip
  cyl(g, .38, .6, x, 3.35, -7.8, ironMat, 'y', 14);                  // dome
  for (const s of [-1, 1]) box(g, .8, 1.5, 4.6, x + s * 1.15, 1.95, -8.3, woodMat);   // side tanks (snow on top)
  box(g, 2.8, 3.0, 2.6, x, 2.6, -11.6, woodMat);                     // cab
  box(g, 3.1, .18, 3.0, x, 4.15, -11.6, roofMat, true);             // cab roof under snow
  box(g, .06, .7, .8, x - 1.42, 3.0, -11.0, inkMat, false);          // cab window
  for (const s of [-1, 1]) for (const z of [-6.3, -8.5, -10.7]) { cyl(g, .62, .14, x + s * 1.38, .62, z, inkMat, 'x', 18); cyl(g, .5, .16, x + s * 1.38, .62, z, ironMat, 'x', 18); }
  box(g, .14, .14, 4.4, x - 1.48, .62, -8.5, paperMat, false);       // coupling rod, frosted
  scene.add(g);
  return g;
}

// ------------------------------------------------------------------ the carriages: wooden bodies with real window openings
// the near (-x) side is what the camera passes; the far side looks onto the platform. Both have openings, so through
// the lit window the platform shows beyond, a frame within the frame.
function carriage(scene, z0, z1, idx, W) {
  const g = new THREE.Group(), { x0, x1, y0, y1, win } = CAR, L = z0 - z1, zc = (z0 + z1) / 2, t = .08;
  const yb = win.y - win.h / 2, yt = win.y + win.h / 2;
  const near = [], far = [];
  for (let k = 0; ; k++) { const z = z0 - 2.65 - k * 1.75; if (z < z1 + 1.4) break; near.push(z); far.push(z - .875); }
  W.windows.push(...near.map(z => [x0, win.y, z, idx]));
  const wall = (x, centres) => {
    box(g, t, yb - y0, L, x, (y0 + yb) / 2, zc, plankMat, false);                 // under the windows (its top is the sill: snow)
    box(g, t, y1 - yt, L, x, (yt + y1) / 2, zc, plankMat, false);                 // over the windows
    const edges = [z0, ...centres.flatMap(c => [c + win.w / 2, c - win.w / 2]), z1];
    for (let i = 0; i < edges.length; i += 2) { const a = edges[i], b = edges[i + 1]; if (a - b > .01) box(g, t, win.h, a - b, x, win.y, (a + b) / 2, plankMat, false); }
    // paper frames: a thin cut line around each opening
    for (const c of centres) {
      const sx = x < 4 ? x - t / 2 - .006 : x + t / 2 + .006;
      for (const [w, h, dy, dz] of [[.035, win.w + .07, win.h / 2 + .017, 0], [.035, win.w + .07, -win.h / 2 - .017, 0]]) box(g, .012, w, h, sx, win.y + dy, c + dz, paperMat, false);
      for (const dz of [win.w / 2 + .017, -win.w / 2 - .017]) box(g, .012, win.h + .07, .035, sx, win.y, c + dz, paperMat, false);
      box(g, .14, .05, win.w + .1, x < 4 ? x - .06 : x + .06, yb - .02, c, paperMat, false);   // snow on the sill
    }
  };
  wall(x0, near); wall(x1, far);
  // ends, floor, ceiling (ink inside)
  box(g, x1 - x0, y1 - y0, t, (x0 + x1) / 2, (y0 + y1) / 2, z0, plankMat, false);
  box(g, x1 - x0, y1 - y0, t, (x0 + x1) / 2, (y0 + y1) / 2, z1, plankMat, false);
  box(g, x1 - x0, .06, L, (x0 + x1) / 2, y0 + .03, zc, inkMat, false);
  box(g, x1 - x0, .06, L, (x0 + x1) / 2, y1 - .03, zc, inkMat, false);
  // seat backs in the dark: ink on ink, a paper edge on top
  for (let z = z0 - 1.6; z > z1 + 1; z -= 1.75) for (const sx of [x0 + .5, x1 - .5]) { box(g, .5, .7, .08, sx, 1.75, z, inkMat, false); box(g, .5, .025, .08, sx, 2.11, z, paperMat, false); }
  // the roof: a low arc under snow, an ink eave
  const arc = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, L + .2, 24, 1, false, -Math.PI / 2, Math.PI), roofMat);
  arc.rotation.x = -Math.PI / 2; arc.scale.set(1, 1, .3); arc.position.set((x0 + x1) / 2, y1, zc);
  g.add(arc);
  box(g, x1 - x0 + .2, .1, L + .2, (x0 + x1) / 2, y1 + .02, zc, inkMat, false);
  // underframe, bogies, wheels
  box(g, x1 - x0 - .3, .35, L - 1, (x0 + x1) / 2, y0 - .2, zc, inkMat, false);
  for (const bz of [z0 - 2.4, z1 + 2.4]) for (const dz of [-.8, .8]) for (const s of [-1, 1]) cyl(g, .42, .1, SIDING + s * .72, .45, bz + dz, inkMat, 'x', 16);
  // the gangway to the next car
  box(g, 1.4, 2.2, .8, (x0 + x1) / 2, 2.1, z1 - .4, inkMat, false);
  scene.add(g);
  return g;
}

// ------------------------------------------------------------------ build everything
export function buildWorld(scene, opts) {
  const W = { windows: [] };
  W.sky = new THREE.Mesh(new THREE.SphereGeometry(8000, 64, 32), skyMat); W.sky.renderOrder = -10; scene.add(W.sky);
  W.moon = new THREE.Mesh(new THREE.PlaneGeometry(520, 520), new THREE.MeshBasicMaterial({ map: canvasTex(moonCanvas()), transparent: true, depthWrite: false }));
  W.moon.renderOrder = -9; scene.add(W.moon);

  W.ground = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000, 1, 1), snowMat);
  W.ground.rotation.x = -Math.PI / 2; scene.add(W.ground);

  // mountains: a row of faceted cones far down the line and to its right
  const R = mulberry(2027), mt = new THREE.Group(); scene.add(mt);
  const ring = (az, d, h, seed, crater = 0) => mt.add(volcano(Math.sin(az) * d, -Math.cos(az) * d, h, h * (2.4 + (seed % 5) * .2), seed, crater));
  const D = Math.PI / 180;
  ring(-34 * D, 2600, 210, 11); ring(-12 * D, 3000, 300, 12); ring(8 * D, 2500, 170, 13, .6); ring(26 * D, 2800, 340, 14);
  ring(45 * D, 2400, 240, 15); ring(58 * D, 3100, 400, 16, .3); ring(74 * D, 2600, 210, 17); ring(92 * D, 2900, 260, 18, .7);
  for (let i = 0; i < 14; i++) { const az = (-60 + i * 12 + (R() - .5) * 6) * D, h = 70 + R() * 60; ring(az, 1700 + R() * 300, h, 100 + i, R() < .4 ? .7 : 0); }
  const band = new THREE.Mesh(new THREE.RingGeometry(1350, 1500, 96, 1), inkMat); band.rotation.x = -Math.PI / 2; band.position.y = .3; scene.add(band);

  W.tracks = tracks(scene);
  W.poles = poles(scene, opts.poleZ);
  W.station = station(scene, W);
  W.engine = engine(scene);
  W.cars = CARS.map(([a, b], i) => carriage(scene, a, b, i, W));
  // window frost on the near side of car 1 (the lantern's window)
  const ft = canvasTex(frostCanvas());
  W.frost = new THREE.Mesh(new THREE.PlaneGeometry(CAR.win.w, CAR.win.h), new THREE.MeshBasicMaterial({ map: ft, transparent: true, alphaTest: .4 }));
  W.frost.position.set(CAR.x0 - .045, CAR.win.y, LANTERN.z); W.frost.rotation.y = -Math.PI / 2; scene.add(W.frost);

  // the lantern: a canvas redrawn as it wakes
  W.lanternCanvas = lanternCanvas(null, { wick: 0, rows: 0, done: 0 });
  W.lanternTex = canvasTex(W.lanternCanvas);
  const lh = .62, lw = lh * LANT.W / LANT.H;
  W.lantern = new THREE.Mesh(new THREE.PlaneGeometry(lw, lh), new THREE.MeshBasicMaterial({ map: W.lanternTex, transparent: true, alphaTest: .35, depthWrite: true }));
  W.lantern.position.set(LANTERN.x, LANTERN.y + .02, LANTERN.z); W.lantern.rotation.y = -1.05; scene.add(W.lantern);

  // pine belts: ink bands at every distance; the camera's path is kept clear
  const clear = opts.clear || [];
  const onPath = (x, z) => clear.some(([cx, cz, r]) => (cx - x) ** 2 + (cz - z) ** 2 < r * r);
  const pines = [], put = (x, z, hMul = 1) => { if (onPath(x, z)) return; if (x > -6 && x < 22 && z < 30 && z > -75) return; const h = (9 + R() * 6) * hMul; pines.push([x, 0, z, h * .5, h, Math.floor(R() * 8)]); };
  // a belt along the far side of the plain, across the line
  for (let i = 0; i < 520; i++) { const x = -700 + R() * 1400, z = -330 - R() * 60 - Math.sin(x * .004) * 40; put(x, z, 1.2); }
  for (let i = 0; i < 420; i++) { const x = -1100 + R() * 2200, z = -760 - R() * 90 + Math.sin(x * .003) * 70; put(x, z, 1.8); }
  // a grove on the left of the line, and a belt behind the station
  for (let i = 0; i < 160; i++) { const x = -38 - Math.pow(R(), .7) * 70, z = 70 - R() * 160; put(x, z, .95); }
  for (let i = 0; i < 200; i++) { const x = 40 + R() * 90, z = 30 - R() * 180; put(x, z, 1.05); }
  for (let i = 0; i < 160; i++) { const a = (35 + R() * 40) * D, d = 120 + R() * 140; put(Math.sin(a) * d, -Math.cos(a) * d, 1.1); }
  W.pines = billboards(pines.length, billboardMat(canvasTex(pineAtlas()), 0), true); fillBoards(W.pines, pines, 8); scene.add(W.pines);
  // low snow fence posts on the right of the line: a foreground of ink ticks
  for (let z = 70; z > 14; z -= 2.2) { const h = .7 + ((z * 13) % 7) / 20; box(scene, .09, h, .09, 7.5 + Math.sin(z) * .2, h / 2, z, woodMat, false); }

  // steam: puff billboards, placed each frame by scene.js
  W.puffs = billboards(160, billboardMat(canvasTex(puffAtlas()), 1, { transparentDepth: true }), false);
  W.puffs.renderOrder = 5; scene.add(W.puffs);

  // falling snow: square paper stabs fixed in the world
  const NS = 2600, sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NS * 3), 3));
  sg.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(NS), 1));
  W.snow = new THREE.Points(sg, new THREE.ShaderMaterial({
    uniforms: { uProj: { value: opts.proj }, uPaper: U.uPaper },
    vertexShader: `attribute float aS; uniform float uProj; varying float vA; void main(){ vec4 mv = viewMatrix*vec4(position,1.); float px = aS*uProj/-mv.z; vA = smoothstep(.45, 1.4, -mv.z); gl_PointSize = -mv.z > .45 ? clamp(px, 2.2, 22.) : 0.; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uPaper; varying float vA; void main(){ vec2 q = abs(gl_PointCoord-.5); if (max(q.x, q.y) > .42) discard; if (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453) > vA) discard; gl_FragColor = vec4(uPaper,1.); }`,
  }));
  W.snow.frustumCulled = false; W.snow.renderOrder = 6; scene.add(W.snow);
  W.snowSeed = (() => { const r = mulberry(1212), o = []; for (let i = 0; i < NS; i++) o.push([r(), r(), r(), .022 + r() * .03, r()]); return o; })();
  return W;
}
