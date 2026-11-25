// fx.breath（source:three 落点）：组合 particle.premult、particle.soft、particle.minpx 的 Three.js 粒子构建器。

import { applyPremultBlending } from '../premult/three.js';
import { SOFT_DEPTH_GLSL } from '../soft/three.js';
import { MINPX_VERTEX_GLSL, pixelWorldFactor } from '../minpx/three.js';
import { evaluate as evaluateBreath } from './index.mjs';

function bad(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function assertNum(x, name, min = -Infinity, max = Infinity) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
    throw bad(`Invalid ${name}`);
  }
  return x;
}

export const BREATH_VERTEX_GLSL = /* glsl */ `
${MINPX_VERTEX_GLSL}
attribute float aSize;
attribute float aWeight;
attribute float aLife;
varying float vVZ;
varying float vWeight;
varying float vLife;
varying float vEnergyScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vVZ = mv.z;
  float sz = minPxWorldSize(aSize, mv.z, uMinPx, uPxK, vEnergyScale);
  vWeight = aWeight;
  vLife = aLife;
  gl_PointSize = max(1.0, sz / max(-mv.z * uPxK, 1e-5));
  gl_Position = projectionMatrix * mv;
}
`;

export const BREATH_FRAGMENT_GLSL = /* glsl */ `
${SOFT_DEPTH_GLSL}
uniform float uSoftness;
uniform float uAlphaOcc;
varying float vVZ;
varying float vWeight;
varying float vLife;
varying float vEnergyScale;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float radial = smoothstep(1.0, 0.0, length(q));
  float sft = softZ(vVZ, uSoftness);
  float w = radial * vWeight * vEnergyScale * sft;
  vec3 hot = mix(vec3(4.2, 2.3, 0.7), vec3(3.0, 0.62, 0.06), smoothstep(0.0, 0.3, vLife));
  vec3 emitCol = mix(hot, vec3(0.9, 0.06, 0.015), smoothstep(0.3, 0.85, vLife));
  vec3 smokeCol = vec3(0.18, 0.14, 0.12);
  float aOcc = clamp(uAlphaOcc * w * smoothstep(0.3, 0.9, vLife), 0.0, 1.0);
  gl_FragColor = vec4(emitCol * w + smokeCol * aOcc, aOcc);
}
`;

export function create(ctx, params = {}) {
  const THREE = ctx?.THREE;
  if (!THREE || typeof THREE.ShaderMaterial !== 'function') throw bad('Missing THREE in ctx');
  const spec = {
    count: 64,
    seed: 11,
    mouth: [-8.0, 1.5, 0.0],
    direction: [0.95, 0.1, 0.29],
    roar: 0.85,
    beam: 0.0,
    beamLengthM: 30.0,
    reach: 1.4,
    drag: 2.6,
    speedMps: 70.0,
    softnessM: 3.0,
    minPx: 1.25,
    ...(params?.spec ?? {}),
  };

  const count = assertNum(spec.count, 'spec.count', 1, 4096);
  assertNum(spec.drag, 'spec.drag', 1e-4, 50);
  const softnessM = assertNum(spec.softnessM ?? 3.0, 'spec.softnessM', 0.01, 100);
  const minPx = assertNum(spec.minPx ?? 1.25, 'spec.minPx', 0.25, 16);
  const size = Array.isArray(ctx?.size) && ctx.size.length === 2 ? ctx.size : [1920, 1080];
  const pxK = pixelWorldFactor(40, size[1]);

  const geometry = new THREE.BufferGeometry();
  const posArr = new Float32Array(count * 3);
  const sizeArr = new Float32Array(count);
  const weightArr = new Float32Array(count);
  const lifeArr = new Float32Array(count);

  const posAttr = new THREE.Float32BufferAttribute(posArr, 3);
  const sizeAttr = new THREE.Float32BufferAttribute(sizeArr, 1);
  const weightAttr = new THREE.Float32BufferAttribute(weightArr, 1);
  const lifeAttr = new THREE.Float32BufferAttribute(lifeArr, 1);

  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aSize', sizeAttr);
  geometry.setAttribute('aWeight', weightAttr);
  geometry.setAttribute('aLife', lifeAttr);

  const material = applyPremultBlending(
    new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        uNear: { value: 0.3 },
        uFar: { value: 4000 },
        uRes: { value: new THREE.Vector2(size[0], size[1]) },
        uSoftness: { value: softnessM },
        uMinPx: { value: minPx },
        uPxK: { value: pxK },
        uAlphaOcc: { value: 0.15 },
      },
      vertexShader: BREATH_VERTEX_GLSL,
      fragmentShader: BREATH_FRAGMENT_GLSL,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
    THREE,
  );

  const points = new THREE.Points(geometry, material);
  points.name = 'fx.breath.points';
  points.frustumCulled = false;
  const group = new THREE.Group();
  group.name = 'fx.breath';
  group.add(points);

  const evalCtx = {
    fps: ctx?.fps ?? 60,
    size,
    camera: ctx?.camera,
  };

  function syncFrame(f, sub = 0) {
    const out = evaluateBreath(evalCtx, { spec }, f, sub);
    for (let i = 0; i < count; i++) {
      const p = out.particles[i];
      if (p) {
        posArr[i * 3] = p.world[0];
        posArr[i * 3 + 1] = p.world[1];
        posArr[i * 3 + 2] = p.world[2];
        sizeArr[i] = p.sizeM;
        weightArr[i] = p.weight;
        lifeArr[i] = p.lifeNorm ?? 0;
      } else {
        posArr[i * 3] = 0;
        posArr[i * 3 + 1] = 0;
        posArr[i * 3 + 2] = 0;
        sizeArr[i] = 0;
        weightArr[i] = 0;
        lifeArr[i] = 1;
      }
    }
    posAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    weightAttr.needsUpdate = true;
    lifeAttr.needsUpdate = true;
    return out;
  }

  syncFrame(0, 0);

  return {
    object: group,
    points,
    material,
    uniforms: material.uniforms,
    entities: { plume: { object: group, root: true } },
    apply(f, sub = 0) {
      syncFrame(f, sub);
    },
    meta(f) {
      const out = evaluateBreath(evalCtx, { spec }, f, 0);
      return {
        readings: out.readings,
      };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
