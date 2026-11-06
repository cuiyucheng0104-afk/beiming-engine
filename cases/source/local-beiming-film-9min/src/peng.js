// 《北冥》455–490s: a bird, with a keeled breast, raised neck, hooked bill,
// articulated remiges and fan tail. The original Kun is never modified.
import * as THREE from 'three';
import { clamp, lerp, ss, TAU } from '../engine/core/math.js';
import { profileBody, axisStations, ringsAt, loftRings, loftWing } from '../engine/form/loft.js';
import { makeToonMaterial, bindToon, PALETTE, TOON_PRESETS } from './toon.js';
import { wireOutlines } from '../engine/stage/outline.js';
import { featherGeometry, featherMatrix, featherMaterial, V } from './peng-feathers.js';
export { createFeatherSwarm } from './peng-feathers.js';

const UP = V(0, 1, 0);
// A short avian torso, not the 600-unit cetacean profile.
const torso = profileBody({
  xs: [-78, -64, -42, -12, 18, 40, 57, 70],
  top: [1, 13, 23, 30, 33, 32, 27, 17],
  bottom: [-7, -17, -28, -36, -36, -26, -10, 10],
  width: [5, 14, 23, 31, 32, 28, 18, 3], exp: [2, 2.15],
});

// Swept closed solid, including both caps; useful for neck, bill and talons.
function sweep(points, radii, segments, sides = 16) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => V(...p)), false, 'centripetal');
  const rings = [], tangent = V(1, 0, 0), z = V(0, 0, 1), y = V(0, 1, 0);
  for (let i = 0; i <= segments; i++) {
    const u = i / segments, p = curve.getPoint(u), r = u * (radii.length - 1);
    const k = Math.min(radii.length - 2, Math.floor(r)), f = r - k;
    const ry = lerp(radii[k][0], radii[k + 1][0], f), rz = lerp(radii[k][1], radii[k + 1][1], f);
    tangent.copy(curve.getTangent(u)); y.crossVectors(z, tangent).normalize();
    rings.push(Array.from({ length: sides }, (_, j) => p.clone()
      .addScaledVector(z, Math.cos(j / sides * TAU) * rz)
      .addScaledVector(y, Math.sin(j / sides * TAU) * ry)));
  }
  return loftRings(rings, { startCap: { p: curve.getPoint(0) }, endCap: { p: curve.getPoint(1) } });
}

/**
 * createPeng({lod=1}) → {group,setPose,fitShadow,outlineMeshes,length,wingspan}
 * +X head, +Y up, ±Z wings. wingspan=600 at neutral full spread.
 * lod ∈ [0.15,1] reduces tessellation/coverts, retaining primary silhouette.
 * setPose(t,{spread=1,flap=1,flight=1}={}): t seconds, sampled at 24 fps;
 * spread 0 furled/up → 1 extended; flap 0 glide → 1 full slow wingbeat;
 * flight 0 settles → 1 airborne pitch/heave/tucked feet. Controls clamp 0…1.
 * Animation lives under group: the caller retains group's position/rotation/
 * scale and owns the world-space ascent. No time accumulation or shared state.
 * Use local t=filmTime-455 for the climax. No TOON_SHARED writes.
 */
export function createPeng({ lod = 1 } = {}) {
  lod = clamp(Number.isFinite(lod) ? lod : 1, 0.15, 1);
  const group = new THREE.Group(); group.name = 'peng';
  const rig = new THREE.Group(); rig.name = 'peng-flight-rig'; group.add(rig);
  const outlineMeshes = [], wings = [], featherRows = [], fingers = [], tailFeathers = [];
  const shortGeo = featherGeometry(lod, true), longGeo = featherGeometry(lod);
  const mat = (color = PALETTE.kunBase, extra = {}) => makeToonMaterial({
    ...TOON_PRESETS.kun, color, rustAmt: 0, algaeAmt: 0, spotAmt: 0, ...extra,
  });
  const bodyMat = mat(), headMat = mat(PALETTE.lavender);
  const coverMat = featherMaterial({ color: PALETTE.kunBase, gold: 0.14, tip: 0.12 });
  const midMat = featherMaterial({ color: PALETTE.lavender, gold: 0.35, tip: 0.28 });
  const flightMat = featherMaterial({ color: PALETTE.kunBase, gold: 0.55, tip: 0.35, outlineW: 0.9 });
  const paleMat = featherMaterial({ color: PALETTE.barnacle, gold: 0.45, tip: 0.12 });
  const goldMat = mat(PALETTE.window, { shade1: PALETTE.apricot, shade2: PALETTE.kunShade2, fillAmt: 0.25, skyAmt: 0.2 });
  const inkMat = mat(PALETTE.ink, { shade1: PALETTE.ink, shade2: PALETTE.kunShade2, rimAmt: 0.2, rimLitAmt: 0.25, fillAmt: 0 });
  function add(parent, geo, material, name, core = false) {
    const mesh = bindToon(new THREE.Mesh(geo, material), material); mesh.name = name;
    if (core) mesh.userData.outlineGroup = rig; // per-bird identity, safe with multiple Pengs
    outlineMeshes.push(mesh); parent.add(mesh); return mesh;
  }
  function batch(parent, items, material, name, geometry = shortGeo) {
    const mesh = bindToon(new THREE.InstancedMesh(geometry, material, items.length), material);
    mesh.name = name; items.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
    parent.add(mesh); outlineMeshes.push(mesh); return mesh;
  }
  function ellipsoid(parent, position, scale, material, name, core = false) {
    const mesh = add(parent, new THREE.SphereGeometry(1, Math.round(20 + lod * 16), Math.round(12 + lod * 10)), material, name, core);
    mesh.position.copy(position); mesh.scale.copy(scale); return mesh;
  }
  function row(parent, items, material, name, side = 0, phase = 0, geometry = shortGeo) {
    const pivot = new THREE.Group(); pivot.name = name + '-pivot'; parent.add(pivot);
    batch(pivot, items, material, name, geometry); featherRows.push({ pivot, side, phase }); return pivot;
  }

  const bodyGeo = loftRings(ringsAt(torso.point, axisStations(-78, 70, Math.round(30 + lod * 32)), Math.round(24 + lod * 24)),
    { startCap: { p: V(-79, -3, 0) }, endCap: { p: V(71, 14, 0) } });
  add(rig, bodyGeo, bodyMat, 'peng-keeled-breast', true);
  add(rig, sweep([[38, 9, 0], [60, 23, 0], [76, 44, 0], [96, 51, 0]], [[26, 23], [22, 19], [15, 14], [13, 13]], 24), headMat, 'peng-raised-neck', true);
  const head = new THREE.Group(); head.position.set(99, 52, 0); head.name = 'peng-head-pivot'; rig.add(head);
  ellipsoid(head, V(0, 0, 0), V(24, 18, 16), headMat, 'peng-skull', true);
  add(head, sweep([[13, -2, 0], [28, -1, 0], [43, -7, 0], [46, -17, 0], [40, -22, 0]],
    [[9, 10], [8, 7.5], [5.8, 4.3], [3, 2.4], [0.24, 0.24]], 24), goldMat, 'peng-hooked-upper-bill');
  add(head, sweep([[14, -9, 0], [29, -11, 0], [37, -13, 0]], [[3.2, 7], [2.2, 4], [0.2, 0.2]], 12), inkMat, 'peng-lower-bill');
  for (const side of [-1, 1]) {
    ellipsoid(head, V(22, 0, side * 7.3), V(2.4, 0.85, 0.7), inkMat, 'peng-nostril');
    const eye = new THREE.Group(); eye.name = 'peng-golden-eye-' + side;
    eye.position.set(10.7, 3.6, side * 13.6); eye.rotation.y = side > 0 ? 0.25 : Math.PI - 0.25; head.add(eye);
    ellipsoid(eye, V(0, 0, 0), V(6.2, 4.2, 1.7), inkMat, 'peng-eye-socket');
    ellipsoid(eye, V(0.7, 0, 1.3), V(3.25, 3.1, 1.45), goldMat, 'peng-gold-iris');
    ellipsoid(eye, V(0.85, 0, 2.55), V(1.22, 2.15, 0.42), inkMat, 'peng-pupil');
    const catchMat = mat(PALETTE.anemone, { rimAmt: 0, rimLitAmt: 0, fillAmt: 0, shade1: PALETTE.kunRim });
    ellipsoid(eye, V(0, 1.25, 2.95), V(0.66, 0.66, 0.23), catchMat, 'peng-eye-catch');
    add(head, sweep([[-2, 6, side * 13.6], [9, 7.5, side * 15.4], [18, 4.7, side * 11]],
      [[1.5, 1.8], [2.2, 2.6], [0.3, 0.3]], 12, 12), headMat, 'peng-brow');
    const cheek = [];
    for (let i = 0; i < 6; i++) cheek.push(featherMatrix(V(3 - i * 2, 0.5 - i * 2, side * (14 - i * 0.7)),
      V(-1, -0.18 - i * 0.03, side * 0.1), V(0, 0.25, side), 23 + i * 1.4, 7.5));
    batch(head, cheek, paleMat, 'peng-cheek-feathers');
  }
  const crest = [];
  for (let i = -2; i <= 2; i++) crest.push(featherMatrix(V(-6, 14, i * 3.1), V(-1, 0.43 + 0.04 * (2 - Math.abs(i)), i * 0.1), UP, 34 + 12 * (1 - Math.abs(i) / 3), 7.5));
  row(head, crest, midMat, 'peng-swept-crest');

  // Shingled breast, scapulars and neck ruff. The solid torso closes every gap.
  const bodyFeathers = [];
  for (let r = 0; r < 6; r++) {
    const x = 54 - r * 20, num = Math.round(lerp(10, 17, lod));
    for (let j = 0; j < num; j++) {
      const phi = (j + (r % 2) * 0.5) / num * TAU, p = torso.point(x, phi), n = torso.normal(x, phi);
      p.addScaledVector(n, -0.8);
      const d = V(-1, 0, 0).addScaledVector(n, n.x).normalize().addScaledVector(n, 0.12);
      bodyFeathers.push(featherMatrix(p, d, n, 30 + 6 * Math.sin(r), 12.5));
    }
  }
  batch(rig, bodyFeathers, coverMat, 'peng-body-plumage');
  const ruff = [];
  for (let r = 0; r < 3; r++) for (let j = 0; j < 13; j++) {
    const a = (j + r * 0.5) / 13 * TAU, x = 84 - r * 10, cy = 44 - r * 8, rad = 14 + r * 3.5;
    const n = V(-0.3, Math.sin(a), Math.cos(a)).normalize();
    ruff.push(featherMatrix(V(x, cy + Math.sin(a) * rad, Math.cos(a) * rad), V(-0.85, -0.5, Math.cos(a) * 0.12), n, 27 + r * 3, 10.5));
  }
  batch(rig, ruff, midMat, 'peng-neck-ruff');

  const armPlan = t => ({ le: 18 + 27 * Math.sin(t * Math.PI) - 26 * t, c: 48 - 13 * t, th: 13 - 7 * t, camber: 2, y: 0 });
  const handPlan = t => ({ le: 6 - t * 23, c: 36 - 15 * t, th: 7 - 4.5 * t, camber: 1, y: 0 });
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group(), hand = new THREE.Group();
    shoulder.name = 'peng-shoulder-' + side; hand.name = 'peng-wrist-' + side;
    shoulder.position.set(17, 19, side * 23); hand.position.set(-8, 0, side * 138);
    rig.add(shoulder); shoulder.add(hand); wings.push({ side, shoulder, hand });
    ellipsoid(shoulder, V(1, -1, 0), V(28, 17, 23), bodyMat, 'peng-shoulder-mantle', true);
    add(shoulder, loftWing({ nS: 24, nC: 16, span0: -side * 12, span1: side * 145, plan: armPlan }), bodyMat, 'peng-inner-wing');
    add(hand, loftWing({ nS: 16, nC: 14, span0: -side * 17, span1: side * 60, plan: handPlan }), bodyMat, 'peng-hand');

    // Long secondaries: a continuous overlapping sail with scalloped free tips.
    const secondaries = [];
    for (let i = 0; i < 15; i++) {
      const t = (i + 0.25) / 15, p = armPlan(t);
      secondaries.push(featherMatrix(V(p.le - 24, 0.8 + i * 0.12, side * t * 138),
        V(-1, -0.015, side * (0.09 + t * 0.16)), UP, 68 + 18 * Math.sin(t * 2.3), 21));
    }
    row(shoulder, secondaries, flightMat, 'peng-secondaries-' + side, side, 1.4, longGeo);
    // Three overlapping upper tiers and two underwing tiers. Separate pivots
    // move only a fraction of a degree, keeping layer ordering throughout flight.
    for (const up of [-1, 1]) for (let r = 0; r < 3; r++) {
      const items = [], num = Math.round(lerp(10, 17 - r, lod));
      for (let i = 0; i < num; i++) {
        const t = (i + 0.35 + 0.35 * (r % 2)) / num, p = armPlan(t), cf = 0.08 + r * 0.24;
        items.push(featherMatrix(V(p.le - cf * p.c, up * (5.5 + (2 - r) * 1.25), side * (t * 138)),
          V(-1, -up * 0.015, side * 0.2), V(0, up, 0), 29 + r * 15, 16 + r * 2));
      }
      row(shoulder, items, r === 1 ? midMat : coverMat, 'peng-coverts-' + side + '-' + up + '-' + r, side, r * 0.7 + up);
    }
    // Eleven individually fanned primary pivots; stable count even at low LOD.
    for (let i = 0; i < 11; i++) {
      const k = i / 10, angle = lerp(0.29, 1.12, k);
      const pivot = new THREE.Group(); pivot.name = 'peng-primary-pivot-' + side + '-' + i;
      pivot.position.set(-10 - 20 * k, -0.2 + i * 0.38, side * (3 + 49 * k)); hand.add(pivot);
      const mesh = add(pivot, longGeo, flightMat, 'peng-primary-' + side + '-' + i);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(featherMatrix(V(0, 0, 0), V(-Math.cos(angle), -0.012, side * Math.sin(angle)), UP,
        100 + 24 * Math.sin(k * Math.PI * 0.85), lerp(23, 19, k)));
      fingers.push({ pivot, side, k });
    }
    for (const up of [-1, 1]) for (let r = 0; r < 2; r++) {
      const items = [];
      for (let i = 0; i < 8; i++) {
        const t = (i + 0.3) / 8, p = handPlan(t);
        items.push(featherMatrix(V(p.le - 10 - r * 13, up * (6 + (1 - r) * 1.4), side * (t * 61 - 5)),
          V(-1, 0, side * (0.35 + t * 0.45)), V(0, up, 0), 33 + r * 16, 17));
      }
      row(hand, items, r ? midMat : coverMat, 'peng-hand-coverts-' + side + '-' + up + '-' + r, side, r + 2);
    }
    // Alula on the leading wrist, crucial to the unmistakable raptor silhouette.
    const alula = [];
    for (let i = 0; i < 3; i++) alula.push(featherMatrix(V(5 + i * 2, 3.5, side * (6 + i * 5)), V(0.38, 0.08, side), UP, 26 - i * 3, 10));
    batch(hand, alula, midMat, 'peng-alula-' + side);
  }

  const tail = new THREE.Group(); tail.position.set(-66, -1, 0); tail.name = 'peng-tail-pivot'; rig.add(tail);
  for (let i = -6; i <= 6; i++) {
    const k = i / 6, pivot = new THREE.Group(); pivot.name = 'peng-tail-feather-pivot-' + i;
    pivot.position.set(0, 3 - Math.abs(k) * 2, k * 8); tail.add(pivot);
    const mesh = add(pivot, longGeo, i % 3 === 0 ? midMat : flightMat, 'peng-tail-feather-' + i);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(featherMatrix(V(0, 0, 0), V(-1, -0.025, 0), UP, 164 - Math.abs(k) * 29, 23));
    tailFeathers.push({ pivot, k });
  }
  const tailCoverts = [];
  for (let i = -4; i <= 4; i++) tailCoverts.push(featherMatrix(V(6, 7, i * 3), V(-1, 0, i * 0.08), UP, 60 - Math.abs(i) * 4, 15));
  batch(tail, tailCoverts, coverMat, 'peng-tail-coverts');

  const legs = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Group(); leg.name = 'peng-tucked-leg-' + side; leg.position.set(-12, -25, side * 16); rig.add(leg); legs.push(leg);
    ellipsoid(leg, V(-2, -7, 0), V(15, 13, 10), bodyMat, 'peng-thigh');
    add(leg, sweep([[0, -10, 0], [-11, -20, 0], [-16, -25, 0]], [[4, 3.8], [2.8, 2.7], [2, 2]], 12, 10), goldMat, 'peng-tarsus');
    for (let i = -1; i <= 1; i++) {
      add(leg, sweep([[-16, -24, i * 2], [-4, -29, i * 4], [0, -34, i * 4], [-6, -35, i * 3]],
        [[1.6, 1.6], [1.4, 1.4], [0.9, 0.9], [0.12, 0.12]], 14, 8), inkMat, 'peng-curved-talon');
    }
  }

  function setPose(t, { spread = 1, flap = 1, flight = 1 } = {}) {
    t = Math.round((Number.isFinite(t) ? t : 0) * 24) / 24;
    spread = ss(clamp(spread)); flap = clamp(flap); flight = clamp(flight);
    const ph = TAU * t / 5.5;
    // Broad power stroke / delayed wrist recovery; low amplitude feather follow-through.
    const beat = Math.sin(ph) + 0.12 * Math.sin(2 * ph - 0.4);
    rig.position.y = flight * (3.4 * Math.sin(ph - 0.8) + 1.3 * Math.sin(t * 0.73));
    rig.rotation.set(0.012 * flight * Math.sin(t * 0.6), 0, flight * (0.055 + 0.022 * Math.sin(ph - 0.5)));
    head.rotation.z = -rig.rotation.z * 0.65 + 0.01 * flight * Math.sin(t * 0.8);
    for (const w of wings) {
      const lift = 0.04 + (1 - spread) * 0.96 + beat * 0.46 * flap * (0.25 + 0.75 * spread);
      w.shoulder.rotation.set(-w.side * lift, -w.side * (1 - spread) * 0.39, -0.025 * flap * Math.cos(ph));
      w.hand.rotation.set(-w.side * flap * (0.14 * Math.sin(ph - 0.7)),
        -w.side * ((1 - spread) * 0.48 + flap * 0.065 * (1 - Math.sin(ph))), 0);
    }
    for (const f of fingers) {
      f.pivot.rotation.set(f.side * 0.012 * flight * Math.sin(ph - f.k * 1.5),
        -f.side * ((1 - spread) * f.k * 0.21 + flight * 0.012 * Math.sin(ph - f.k)),
        0.008 * flight * Math.sin(t * 1.5 - f.k * 2));
    }
    for (const r of featherRows) r.pivot.rotation.x = r.side * flight * 0.0035 * Math.sin(ph - r.phase);
    tail.rotation.set(0.018 * flight * Math.sin(ph - 1), 0.025 * flight * Math.sin(t * 0.65), -0.045 + 0.035 * flight * Math.sin(ph - 1.1));
    for (const f of tailFeathers) f.pivot.rotation.y = f.k * (0.22 + spread * 0.43) + 0.008 * flight * Math.sin(ph - Math.abs(f.k));
    for (const leg of legs) leg.rotation.z = -0.28 * flight;
  }

  // Normalize the neutral span once; all geometry and all LODs keep the same size.
  setPose(0, { spread: 1, flap: 0, flight: 0 });
  group.updateMatrixWorld(true);
  const neutral = new THREE.Box3().setFromObject(group), neutralSize = neutral.getSize(V(0, 0, 0));
  rig.scale.setScalar(600 / neutralSize.z);
  const length = neutralSize.x * rig.scale.x;
  const bounds = new THREE.Box3(), sphere = new THREE.Sphere(), centre = V(0, 0, 0), lightPos = V(0, 0, 0), targetPos = V(0, 0, 0), dir = V(0, 0, 0);
  function fitShadow(light, { size = 2048 } = {}) {
    group.updateWorldMatrix(true, true); bounds.setFromObject(group); bounds.getBoundingSphere(sphere);
    centre.copy(sphere.center); const radius = sphere.radius * 1.06;
    light.getWorldPosition(lightPos); light.target.getWorldPosition(targetPos);
    dir.subVectors(lightPos, targetPos); if (dir.lengthSq() < 1e-8) dir.set(0.5, 0.8, 0.6); dir.normalize();
    lightPos.copy(centre).addScaledVector(dir, radius * 3);
    targetPos.copy(centre);
    if (light.parent) light.parent.worldToLocal(lightPos);
    if (light.target.parent) light.target.parent.worldToLocal(targetPos);
    light.position.copy(lightPos); light.target.position.copy(targetPos);
    light.updateWorldMatrix(true, false); light.target.updateWorldMatrix(true, false);
    Object.assign(light.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: radius, far: radius * 5 });
    light.shadow.camera.updateProjectionMatrix();
    size = Math.max(128, Math.round(size));
    if (light.shadow.mapSize.x !== size || light.shadow.mapSize.y !== size) {
      light.shadow.mapSize.set(size, size); light.shadow.map?.dispose(); light.shadow.map = null;
    }
    light.shadow.normalBias = 0.22 * group.matrixWorld.getMaxScaleOnAxis();
    light.shadow.bias = -0.000035; light.shadow.radius = 1.5; light.castShadow = true;
  }
  wireOutlines(group); setPose(0);
  return { group, setPose, fitShadow, outlineMeshes, length, wingspan: 600 };
}
