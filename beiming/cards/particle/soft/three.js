// particle.soft：软粒子深度淡出片元模块与 Three.js 材质辅助。
// 正线性深度下 fade = clamp((sceneDepth - particleDepth) / softness, 0, 1)；
// 右手系相机看向 -Z 的视图空间下 myViewZ = -particleDepth、sceneViewZ = -sceneDepth，
// 故 myViewZ - sceneViewZ === sceneDepth - particleDepth，两种写法代数恒等。

function bad(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function assertNum(x, name, min = -Infinity, max = Infinity) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
    throw bad(`Invalid ${name}`);
  }
  return x;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export const SOFT_DEPTH_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform float uNear, uFar;
uniform vec2 uRes;
float sceneZ() {
  float d = texture2D(tDepth, gl_FragCoord.xy / uRes).x;
  return (uNear * uFar) / ((uFar - uNear) * d - uFar);
}
float softZ(float myViewZ, float soft) {
  return clamp((myViewZ - sceneZ()) / soft, 0.0, 1.0);
}
float softDepthFade(float sceneDepth, float particleDepth, float soft) {
  return clamp((sceneDepth - particleDepth) / soft, 0.0, 1.0);
}
`;

export const SOFT_VERTEX_GLSL = /* glsl */ `
varying vec2 vUv;
varying float vVZ;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vVZ = mv.z;
  vUv = position.xy + 0.5;
  gl_Position = projectionMatrix * mv;
}
`;

export const SOFT_FRAGMENT_GLSL = /* glsl */ `
${SOFT_DEPTH_GLSL}
uniform float uSoftness;
varying vec2 vUv;
varying float vVZ;
void main() {
  float fade = softZ(vVZ, uSoftness);
  gl_FragColor = vec4(vec3(fade), fade);
}
`;

/** 从 [0, 1] 透视深度缓冲采样值反解正线性深度 sceneDepth 与负视图坐标 sceneViewZ */
export function linearizePerspectiveDepth(depthSample, near, far) {
  const d = assertNum(depthSample, 'depthSample', 0, 1);
  const n = assertNum(near, 'near', 1e-6);
  const f = assertNum(far, 'far', 1e-6);
  if (!(n < f)) throw bad('near must be strictly less than far');
  const sceneViewZ = -(n * f) / ((1 - d) * f + d * n);
  return {
    sceneDepth: -sceneViewZ,
    sceneViewZ,
  };
}

/** 按正线性深度差计算软粒子衰减因子 clamp((sceneDepth - particleDepth) / softness, 0, 1) */
export function computeSoftDepthFade(sceneDepth, particleDepth, softness) {
  const sd = assertNum(sceneDepth, 'sceneDepth', 0);
  const pd = assertNum(particleDepth, 'particleDepth', 0);
  const s = assertNum(softness, 'softness');
  if (!(s > 0)) throw bad('softness must be positive');
  return clamp01((sd - pd) / s);
}

/** 按相机视图空间负 Z（myViewZ <= 0, sceneViewZ <= 0）计算软粒子衰减因子 clamp((myViewZ - sceneViewZ) / softness, 0, 1) */
export function computeSoftViewZ(myViewZ, sceneViewZ, softness) {
  const mz = assertNum(myViewZ, 'myViewZ');
  const sz = assertNum(sceneViewZ, 'sceneViewZ');
  const s = assertNum(softness, 'softness');
  if (!(s > 0)) throw bad('softness must be positive');
  return clamp01((mz - sz) / s);
}

/** 从二维视图 Z 缓冲（负值）按屏幕像素坐标采样软粒子衰减系数 */
export function sampleSoftViewZ(vzBuffer, baseOffset, width, height, xPx, yPx, myViewZ, softness) {
  if (!vzBuffer || typeof vzBuffer.length !== 'number') throw bad('Invalid vzBuffer');
  const off = assertNum(baseOffset, 'baseOffset', 0);
  const w = assertNum(width, 'width', 1);
  const h = assertNum(height, 'height', 1);
  const x = assertNum(xPx, 'xPx');
  const y = assertNum(yPx, 'yPx');
  const mz = assertNum(myViewZ, 'myViewZ');
  const s = assertNum(softness, 'softness');
  if (!(s > 0)) throw bad('softness must be positive');
  const ix = Math.max(0, Math.min(w - 1, Math.floor(x)));
  const iy = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const sceneVZ = vzBuffer[off + iy * w + ix];
  return clamp01((mz - sceneVZ) / s);
}

export function create(ctx, params = {}) {
  const THREE = ctx?.THREE;
  if (!THREE || typeof THREE.ShaderMaterial !== 'function') throw bad('Missing THREE in ctx');
  const softnessM = assertNum(params.softnessM ?? 3.0, 'softnessM');
  if (!(softnessM > 0)) throw bad('softnessM must be positive');
  const nearM = assertNum(params.nearM ?? 0.3, 'nearM', 1e-4);
  const farM = assertNum(params.farM ?? 4000, 'farM', 1e-3);
  if (!(nearM < farM)) throw bad('nearM must be less than farM');
  const size = Array.isArray(ctx?.size) && ctx.size.length === 2 ? ctx.size : [1920, 1080];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 1, 3, 2]);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      tDepth: { value: null },
      uNear: { value: nearM },
      uFar: { value: farM },
      uRes: { value: new THREE.Vector2(size[0], size[1]) },
      uSoftness: { value: softnessM },
    },
    vertexShader: SOFT_VERTEX_GLSL,
    fragmentShader: SOFT_FRAGMENT_GLSL,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'particle.soft';
  mesh.frustumCulled = false;

  return {
    object: mesh,
    material,
    uniforms: material.uniforms,
    entities: { quad: { object: mesh, root: true } },
    apply() {},
    meta() {
      return {
        readings: {
          softnessM,
          nearM,
          farM,
          sampleHalfFade: computeSoftDepthFade(10 + softnessM * 0.5, 10, softnessM),
        },
      };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
