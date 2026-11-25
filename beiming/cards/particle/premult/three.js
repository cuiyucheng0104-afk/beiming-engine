// particle.premult：单通道预乘混合着色器与材质配置。
// 同一渲染状态（OneFactor + OneMinusSrcAlphaFactor）内，片元输出 (rgb_emit + rgb_smoke * alpha_occ, alpha_occ)：
// - alpha_occ = 0 时为纯加光（C_out = C_dst + rgb_emit）；
// - alpha_occ > 0 时按 alpha_occ 遮挡背景并叠加自发光（C_out = C_dst * (1 - alpha_occ) + rgb_smoke * alpha_occ + rgb_emit）。

const HEX_RE = /^#([0-9a-f]{6})$/i;

function bad(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function assertVec(v, len, name, min = -Infinity, max = Infinity) {
  if (!Array.isArray(v) || v.length !== len || !v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max)) {
    throw bad(`Invalid ${name}`);
  }
}

function assertNum(x, name, min = -Infinity, max = Infinity) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
    throw bad(`Invalid ${name}`);
  }
  return x;
}

function parseLinearColor(c, name) {
  if (Array.isArray(c)) {
    assertVec(c, 3, name, 0);
    return [...c];
  }
  if (typeof c === 'string') {
    const m = HEX_RE.exec(c.trim());
    if (!m) throw bad(`Invalid ${name}`);
    const n = Number.parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  throw bad(`Invalid ${name}`);
}

export const PREMULT_VERTEX_GLSL = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const PREMULT_FRAGMENT_GLSL = /* glsl */ `
uniform vec3 uEmitColor;
uniform vec3 uSmokeColor;
uniform float uAlphaOcc;
uniform float uGain;
varying vec2 vUv;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float radial = smoothstep(1.0, 0.0, length(q));
  float aOcc = clamp(uAlphaOcc * radial, 0.0, 1.0);
  vec3 emitTerm = uEmitColor * uGain * radial;
  vec3 smokeTerm = uSmokeColor * aOcc;
  gl_FragColor = vec4(emitTerm + smokeTerm, aOcc);
}
`;

/** 计算单张片元的预乘输出 [r, g, b, a] = [rgb_emit + rgb_smoke * alpha_occ, alpha_occ] */
export function composePremultFragment(emitRgb, smokeRgb, alphaOcc) {
  assertVec(emitRgb, 3, 'emitRgb', 0);
  assertVec(smokeRgb, 3, 'smokeRgb', 0);
  const a = assertNum(alphaOcc, 'alphaOcc', 0, 1);
  return [
    emitRgb[0] + smokeRgb[0] * a,
    emitRgb[1] + smokeRgb[1] * a,
    emitRgb[2] + smokeRgb[2] * a,
    a,
  ];
}

/** 单步硬件混合：OneFactor * src + OneMinusSrcAlphaFactor * dst */
export function blendPremultStep(dstRgba, srcRgba) {
  assertVec(dstRgba, 4, 'dstRgba', 0);
  assertVec(srcRgba, 4, 'srcRgba', 0);
  assertNum(dstRgba[3], 'dstRgba[3]', 0, 1);
  const sa = assertNum(srcRgba[3], 'srcRgba[3]', 0, 1);
  const invA = 1 - sa;
  return [
    srcRgba[0] + dstRgba[0] * invA,
    srcRgba[1] + dstRgba[1] * invA,
    srcRgba[2] + dstRgba[2] * invA,
    sa + dstRgba[3] * invA,
  ];
}

/** 多片元按从后往前顺序依次做预乘混合 */
export function blendPremultChain(backgroundRgba, fragments) {
  assertVec(backgroundRgba, 4, 'backgroundRgba', 0);
  if (!Array.isArray(fragments)) throw bad('Invalid fragments');
  let acc = [...backgroundRgba];
  for (const frag of fragments) {
    acc = blendPremultStep(acc, frag);
  }
  return acc;
}

/** 将材质配置为单模式预乘加光兼半透明遮挡混合 */
export function applyPremultBlending(material, THREE) {
  if (!material || typeof material !== 'object' || !THREE) throw bad('Invalid material or THREE');
  material.premultipliedAlpha = true;
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendEquation = THREE.AddEquation;
  return material;
}

export function create(ctx, params = {}) {
  const THREE = ctx?.THREE;
  if (!THREE || typeof THREE.ShaderMaterial !== 'function') throw bad('Missing THREE in ctx');
  const emitRgb = parseLinearColor(params.emitColor ?? '#ff7a1a', 'emitColor');
  const smokeRgb = parseLinearColor(params.smokeColor ?? '#22262b', 'smokeColor');
  const alphaOcc = assertNum(params.alphaOcc ?? 0.35, 'alphaOcc', 0, 1);
  const gain = assertNum(params.gain ?? 1.0, 'gain', 0, 64);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 1, 3, 2]);

  const material = applyPremultBlending(
    new THREE.ShaderMaterial({
      uniforms: {
        uEmitColor: { value: new THREE.Vector3(...emitRgb) },
        uSmokeColor: { value: new THREE.Vector3(...smokeRgb) },
        uAlphaOcc: { value: alphaOcc },
        uGain: { value: gain },
      },
      vertexShader: PREMULT_VERTEX_GLSL,
      fragmentShader: PREMULT_FRAGMENT_GLSL,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
    THREE,
  );

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'particle.premult';
  mesh.frustumCulled = false;

  const sampleFrag = composePremultFragment(
    emitRgb.map((c) => c * gain),
    smokeRgb,
    alphaOcc,
  );

  return {
    object: mesh,
    material,
    uniforms: material.uniforms,
    entities: { quad: { object: mesh, root: true } },
    apply() {},
    meta() {
      return {
        readings: {
          alphaOcc,
          gain,
          outR: sampleFrag[0],
          outG: sampleFrag[1],
          outB: sampleFrag[2],
          outA: sampleFrag[3],
        },
      };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
