// particle.minpx：按屏幕像素定最小尺寸护栏与二维面积能量守恒补偿。
// 正确透视投影公式：
//   pxK = 2 * tan(fovY / 2) / viewportHeight
//   minWorldSize = minPx * depth * pxK
//   clampedWorldSize = max(worldSize, minWorldSize)
//   origPx = worldSize / (depth * pxK), clampedPx = max(origPx, minPx)
//   energyScale = (origPx / clampedPx)^2 = (worldSize / clampedWorldSize)^2

function bad(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function assertNum(x, name, min = -Infinity, max = Infinity) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
    throw bad(`Invalid ${name}`);
  }
  return x;
}

export const MINPX_VERTEX_GLSL = /* glsl */ `
uniform float uMinPx;
uniform float uPxK;
float minPxWorldSize(float worldSize, float viewZ, float minPx, float pxK, out float energyScale) {
  float depth = max(-viewZ, 1e-4);
  float minWorld = minPx * depth * pxK;
  float clampedWorld = max(worldSize, minWorld);
  float ratio = clamp(worldSize / max(clampedWorld, 1e-8), 0.0, 1.0);
  energyScale = ratio * ratio;
  return clampedWorld;
}
`;

export const MINPX_FRAGMENT_GLSL = /* glsl */ `
varying float vEnergyScale;
void main() {
  gl_FragColor = vec4(vec3(vEnergyScale), vEnergyScale);
}
`;

/** 单位深度（1 米）处每屏幕像素对应的世界高度：2 * tan(fovY / 2) / viewportHeight */
export function pixelWorldFactor(fovYDeg, viewportHeight) {
  const fov = assertNum(fovYDeg, 'fovYDeg');
  const h = assertNum(viewportHeight, 'viewportHeight');
  if (!(fov > 0 && fov < 180)) throw bad('fovYDeg must be in (0, 180)');
  if (!(h > 0)) throw bad('viewportHeight must be positive');
  const fovRad = (fov * Math.PI) / 180;
  return (2 * Math.tan(fovRad * 0.5)) / h;
}

/** 计算给定世界尺寸与深度下的最小像素钳制及二维能量守恒补偿系数 */
export function computeMinPxClamp({
  worldSize,
  depth,
  minPx = 1.25,
  fovYDeg = 40,
  viewportHeight = 1080,
} = {}) {
  const wSize = assertNum(worldSize, 'worldSize');
  const z = assertNum(depth, 'depth');
  const mPx = assertNum(minPx, 'minPx');
  if (!(wSize > 0)) throw bad('worldSize must be positive');
  if (!(z > 0)) throw bad('depth must be positive');
  if (!(mPx > 0)) throw bad('minPx must be positive');
  const pxK = pixelWorldFactor(fovYDeg, viewportHeight);
  const minWorldSize = mPx * z * pxK;
  const origPx = wSize / (z * pxK);
  const clamped = origPx < mPx;
  const clampedPx = Math.max(origPx, mPx);
  const clampedWorldSize = Math.max(wSize, minWorldSize);
  const linearRatio = origPx / clampedPx;
  const energyScale = linearRatio * linearRatio;
  const origAreaEnergy = origPx * origPx;
  return {
    pxK,
    minWorldSize,
    clampedWorldSize,
    origPx,
    clampedPx,
    clamped,
    linearRatio,
    energyScale,
    conservedEnergy: clampedPx * clampedPx * energyScale,
    uncompensatedEnergy: clampedPx * clampedPx,
    linearOnlyEnergy: clampedPx * clampedPx * linearRatio,
    origAreaEnergy,
  };
}

/** 对比正确透视投影 + 平方能量守恒写法与三种常见错误反例（未补偿、仅一维线性衰减、写死深度常数） */
export function compareMinPxStrategies({
  worldSize,
  depth,
  minPx = 1.5,
  fovYDeg = 40,
  viewportHeight = 1080,
  magicDepthRatio = 0.00062,
} = {}) {
  const res = computeMinPxClamp({ worldSize, depth, minPx, fovYDeg, viewportHeight });
  const magic = assertNum(magicDepthRatio, 'magicDepthRatio', 1e-8);
  const magicWorldFloor = depth * magic;
  const magicClampedWorld = Math.max(worldSize, magicWorldFloor);
  const magicActualPx = magicClampedWorld / (depth * res.pxK);
  return {
    correct: {
      clampedPx: res.clampedPx,
      energyScale: res.energyScale,
      totalEnergy: res.conservedEnergy,
      energyInflationRatio: res.conservedEnergy / res.origAreaEnergy,
    },
    uncompensated: {
      clampedPx: res.clampedPx,
      energyScale: 1.0,
      totalEnergy: res.uncompensatedEnergy,
      energyInflationRatio: res.uncompensatedEnergy / res.origAreaEnergy,
    },
    linearOnly: {
      clampedPx: res.clampedPx,
      energyScale: res.linearRatio,
      totalEnergy: res.linearOnlyEnergy,
      energyInflationRatio: res.linearOnlyEnergy / res.origAreaEnergy,
    },
    hardcodedMagic: {
      actualPx: magicActualPx,
      targetMinPx: minPx,
      pxError: Math.abs(magicActualPx - minPx),
    },
  };
}

export function create(ctx, params = {}) {
  const THREE = ctx?.THREE;
  if (!THREE || typeof THREE.ShaderMaterial !== 'function') throw bad('Missing THREE in ctx');
  const minPx = assertNum(params.minPx ?? 1.25, 'minPx');
  if (!(minPx > 0)) throw bad('minPx must be positive');
  const fovYDeg = assertNum(params.fovYDeg ?? 40, 'fovYDeg');
  const baseSizeM = assertNum(params.baseSizeM ?? 0.08, 'baseSizeM');
  if (!(baseSizeM > 0)) throw bad('baseSizeM must be positive');
  const viewportHeight = Array.isArray(ctx?.size) && ctx.size.length === 2 ? ctx.size[1] : 1080;
  const pxK = pixelWorldFactor(fovYDeg, viewportHeight);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 1, 3, 2]);

  const vertexShader = /* glsl */ `
${MINPX_VERTEX_GLSL}
uniform float uBaseSizeM;
varying float vEnergyScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sz = minPxWorldSize(uBaseSizeM, mv.z, uMinPx, uPxK, vEnergyScale);
  mv.xy += position.xy * sz;
  gl_Position = projectionMatrix * mv;
}
`;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMinPx: { value: minPx },
      uPxK: { value: pxK },
      uBaseSizeM: { value: baseSizeM },
    },
    vertexShader,
    fragmentShader: MINPX_FRAGMENT_GLSL,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'particle.minpx';
  mesh.frustumCulled = false;

  const farProbe = computeMinPxClamp({
    worldSize: baseSizeM,
    depth: 250,
    minPx,
    fovYDeg,
    viewportHeight,
  });

  return {
    object: mesh,
    material,
    uniforms: material.uniforms,
    entities: { quad: { object: mesh, root: true } },
    apply() {},
    meta() {
      return {
        readings: {
          minPx,
          pxK,
          farClampedPx: farProbe.clampedPx,
          farEnergyScale: farProbe.energyScale,
        },
      };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
