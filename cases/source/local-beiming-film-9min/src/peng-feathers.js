// Shared closed feather geometry; all colour comes from the original film palette.
import * as THREE from 'three';
import { clamp, lerp, ss, mulberry, TAU } from '../engine/core/math.js';
import { makeToonMaterial, bindToon, TOON_PRESETS, PALETTE } from './toon.js';
import { wireOutlines } from '../engine/stage/outline.js';
import { body as kunBody } from './kun.js';
import { pitchWave } from '../engine/form/bend.js';

const UP = new THREE.Vector3(0, 1, 0);
export const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Closed, asymmetric vane, +X root→tip, +Y upper surface, width along Z.
 * No alpha cards: identical triangles in beauty, shadow and outline passes.
 * Cross section has a raised rachis, a curved vane and a finite underside.
 */
export function featherGeometry(lod = 1, round = false) {
  const steps = Math.round(lerp(10, round ? 18 : 28, clamp(lod)));
  const p = [], uv = [], ix = [], ring = 12;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const w = 0.49 * (0.12 + 0.88 * ss(u / 0.18)) * Math.pow(Math.max(0.001, 1 - Math.pow(u, round ? 4 : 2.7)), round ? 0.52 : 0.8);
    const bend = 0.075 * u * u;
    for (let j = 0; j < ring; j++) {
      const a = j / ring * TAU, cross = Math.cos(a), top = Math.sin(a);
      const serration = 1 - 0.027 * (0.5 + 0.5 * Math.sin(i * 2.31 + (cross > 0 ? 0 : 1.3))) * ss(u / 0.2);
      const z = cross * w * (cross > 0 ? 0.83 : 1.05) * serration + bend;
      const y = 0.09 * Math.sin(Math.PI * u) + 0.07 * u * u
        + top * (0.018 + 0.048 * (1 - u)) * (0.35 + 0.65 * (1 - Math.abs(cross)));
      p.push(u, y, z); uv.push(u, cross);
    }
  }
  // Rings progress +X; this winding gives outward normals.
  for (let i = 0; i < steps; i++) for (let j = 0; j < ring; j++) {
    const a = i * ring + j, b = a + ring, c = i * ring + (j + 1) % ring, d = c + ring;
    ix.push(a, b, c, b, d, c);
  }
  for (const [i, reverse] of [[0, true], [steps, false]]) {
    const cap = p.length / 3, u = i / steps;
    p.push(u, 0.09 * Math.sin(Math.PI * u) + 0.07 * u * u, 0.075 * u * u); uv.push(u, 0);
    for (let j = 0; j < ring; j++) {
      const a = i * ring + j, b = i * ring + (j + 1) % ring;
      ix.push(...(reverse ? [a, b, cap] : [a, cap, b]));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('aFeather', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(ix); g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}

export function featherMatrix(position, direction, normal = UP, length = 1, width = 1) {
  const x = direction.clone().normalize();
  const y = normal.clone().addScaledVector(x, -normal.dot(x)).normalize();
  if (y.lengthSq() < 0.01) y.set(0, 0, 1).addScaledVector(x, -x.z).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x.multiplyScalar(length), y.multiplyScalar(width), z.multiplyScalar(width)).setPosition(position);
}

export function featherMaterial({ color = PALETTE.kunBase, gold = 0.2, tip = 0.22, outlineW = 0.72, ...extra } = {}) {
  return makeToonMaterial({
    ...TOON_PRESETS.kun, color, rustAmt: 0, algaeAmt: 0, spotAmt: 0,
    outlineW, ...extra,
    uniforms: {
      uFeatherGold: { value: new THREE.Color(PALETTE.window) },
      uFeatherPale: { value: new THREE.Color(PALETTE.kunRim) },
      uFeatherGoldAmount: { value: gold }, uFeatherTip: { value: tip },
    },
    vertexPars: 'attribute vec2 aFeather; varying vec2 vFeather;',
    vertexBegin: 'vFeather = aFeather;',
    fragmentPars: 'varying vec2 vFeather; uniform vec3 uFeatherGold, uFeatherPale; uniform float uFeatherGoldAmount, uFeatherTip;',
    fragmentAlbedo: /* glsl */`
    {
      float u = vFeather.x, v = vFeather.y, av = abs(v);
      float fw = max(fwidth(v), 0.001);
      float shaft = (1.0 - smoothstep(0.025, 0.025 + fw * 1.5, av))
        * smoothstep(0.06, 0.2, u) * (1.0 - smoothstep(0.86, 0.97, u));
      float q = (u - av * 0.12) * 34.0;
      float fq = max(fwidth(q), 0.001);
      float barbs = (1.0 - smoothstep(0.025, 0.025 + fq, abs(fract(q + 0.5) - 0.5)))
        * smoothstep(0.08, 0.2, av) * (1.0 - smoothstep(0.3, 0.9, fq));
      diffuseColor.rgb *= 1.0 - 0.065 * step(0.0, v);
      diffuseColor.rgb = mix(diffuseColor.rgb, uFeatherPale, smoothstep(0.72, 0.98, u) * uFeatherTip);
      diffuseColor.rgb = mix(diffuseColor.rgb, uFeatherGold, shaft * uFeatherGoldAmount);
      toonInk = max(toonInk, barbs * 0.17);
      toonInk = max(toonInk, shaft * (1.0 - uFeatherGoldAmount) * 0.27);
    }`,
  });
}

/**
 * Original Kun-local roots, +X head / +Y up. Parent group beside Kun under the
 * same world transform. t is the SAME clock passed to Kun.setPose (quantized
 * by its caller if required). No global TOON_SHARED mutation.
 * amount: 0 hidden → 1 full feathers; burst: 0 attached → 1 released veil.
 * Raise amount before burst; switch models behind the veil at burst≈0.5–0.6;
 * lower amount after release. Absolute t and controls make scrubbing stateless.
 */
export function createFeatherSwarm({ count = 200, seed = 20261105 } = {}) {
  count = clamp(Math.round(Number.isFinite(count) ? count : 200), 0, 4000);
  const random = mulberry(seed), group = new THREE.Group(); group.name = 'peng-feather-swarm';
  const geo = featherGeometry(0.3), mat = featherMaterial({ gold: 0.65, tip: 0.38, outlineW: 0.55 });
  const mesh = bindToon(new THREE.InstancedMesh(geo, mat, count), mat);
  mesh.name = 'peng-released-feathers'; mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); group.add(mesh);
  const data = Array.from({ length: count }, (_, i) => {
    const x = lerp(-205, 190, random()), phi = lerp(0.22, Math.PI - 0.22, random());
    return { root: kunBody.point(x, phi), normal: kunBody.normal(x, phi),
      phase: random() * TAU, angle: i * 2.399963229728653 + random() * 0.16,
      radius: lerp(0.45, 1, Math.sqrt(random())), length: lerp(14, 36, random()), width: lerp(5, 11, random()),
      spin: lerp(-1, 1, random()), tone: random() };
  });
  // This is Kun's original pitchWave and default uniforms, not an approximation.
  const { bend } = pitchWave('kun').js({ uKunAmp: { value: 15 }, uKunWave: { value: 0.8 },
    uKunOmega: { value: TAU / 5 }, uKunHalfL: { value: 300 } });
  const p = V(0, 0, 0), n = V(0, 0, 0), direction = V(0, 1, 0), q = new THREE.Quaternion();
  const scale = V(1, 1, 1), m = new THREE.Matrix4(), color = new THREE.Color();
  const base = new THREE.Color(PALETTE.kunBase), green = new THREE.Color(PALETTE.weedA);
  const pale = new THREE.Color(PALETTE.barnacle), blue = new THREE.Color(PALETTE.lavender);
  function setPose(t, { amount = 1, burst = 0 } = {}) {
    t = Number.isFinite(t) ? t : 0; amount = clamp(amount); burst = ss(clamp(burst));
    group.visible = amount > 0 && count > 0;
    const feathered = ss(amount), reveal = ss(amount / 0.18);
    // A brief dense veil at mid-burst covers the body before it disperses.
    // It is volume-based and does not assume any camera or screen direction.
    const veil = Math.pow(Math.sin(Math.PI * burst), 4);
    data.forEach((d, i) => {
      const [dy, theta] = bend(d.root.x, t), cs = Math.cos(theta), sn = Math.sin(theta);
      p.set(d.root.x - d.root.y * sn, dy + d.root.y * cs, d.root.z);
      n.set(d.normal.x * cs - d.normal.y * sn, d.normal.x * sn + d.normal.y * cs, d.normal.z);
      p.addScaledVector(n, -1.4);
      const a = d.angle + t * 0.22 + burst * d.spin * 1.1;
      // Broad, overlapping cylindrical veil; roots never teleport on release.
      p.x += burst * (Math.cos(a) * 95 * d.radius - 40);
      p.y += burst * (38 + 95 * d.radius + Math.sin(a) * 125 * d.radius) - veil * 120;
      p.z += burst * (Math.cos(a) * 170 * d.radius);
      direction.copy(n).add(V(-0.35, 0, 0)).normalize();
      q.setFromUnitVectors(V(1, 0, 0), direction);
      q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(
        d.phase + burst * Math.sin(t * 0.7 + d.phase),
        burst * (d.spin + Math.sin(t * 0.6 + d.phase) * 0.28),
        0.12 * Math.sin(t * 1.9 + d.phase) + burst * Math.sin(a) * 0.7,
      )));
      scale.set(d.length * reveal * lerp(0.8, 1.8, burst) * (1 + 2.8 * veil), d.width * reveal,
        d.width * reveal * lerp(0.16, 1, feathered) * lerp(1, 1.9, burst) * (1 + 4 * veil));
      m.compose(p, q, scale); mesh.setMatrixAt(i, m);
      color.copy(green).lerp(d.tone < 0.38 ? blue : pale, feathered);
      // Instance colours multiply the unchanged original material's base.
      color.r /= base.r; color.g /= base.g; color.b /= base.b;
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  wireOutlines(group); setPose(0, { amount: 0 });
  return { group, setPose };
}
