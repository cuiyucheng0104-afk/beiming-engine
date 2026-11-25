// post.grade-cl 在 three 帧源里的实现：全屏终混调色与显示变换通道（支持与 fx.post-state 和可选镜头特效联动）。

export const VERTEX_SHADER = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = /* glsl */`
uniform sampler2D tC;
uniform sampler2D tB;
uniform sampler2D tG;
uniform sampler2D tS;
uniform vec3 uShaftC;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform vec2 uRes;
uniform vec4 uRing;
uniform vec4 uRingS;
uniform float uBloom;
uniform float uGod;
uniform float uExp;
uniform float uFade;
uniform float uVignette;
uniform float uCaBase;
uniform float uTime;
uniform float uShake;
uniform float uFlash;
uniform float uKick;
uniform float uFringe;
uniform float uSaturation;
uniform float uContrast;
uniform float uInvGamma;
uniform float uGrain;
uniform float uDitherMode;
uniform float uUseLensFx;
uniform float uHasBloom;
uniform float uHasGod;
uniform float uHasShaft;
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 aces(vec3 c) {
  const mat3 I = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 O = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  c = I * (c / 0.6);
  c = RRTAndODTFit(c);
  return clamp(O * c, 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec2 q = uv - 0.5;
  float r2 = dot(q, q);
  uv -= q * (r2 * uKick * 0.20);

  bool fx2 = uUseLensFx > 0.5;
  float asp = uRes.x / max(uRes.y, 1.0);
  if (fx2 && uRing.w > 0.0) {
    vec2 d = (vUv - uRing.xy) * vec2(asp, 1.0);
    vec2 e = vec2(d.x * uRingS.y + d.y * uRingS.z, -d.x * uRingS.z + d.y * uRingS.y);
    e.x /= max(uRingS.x, 1e-4);
    float rr = length(e);
    float x = (rr - uRing.z) / max(uRingS.w, 1e-4);
    float face = abs(e.x) / max(rr, 1e-4);
    vec2 dir = d / max(length(d), 1e-4);
    dir.x /= asp;
    uv -= dir * (x * exp(-x * x) * uRing.w * (0.25 + 0.75 * face));
  }

  float caK = fx2
    ? (uCaBase + min(uShake * 0.02, 0.0015) + 0.004 * uFringe)
    : (uCaBase + min(uShake * 0.02 + uKick * 0.012, 0.010));
  vec2 ca = q * r2 * caK;
  vec3 c = vec3(
    texture2D(tC, uv - ca).r,
    texture2D(tC, uv).g,
    texture2D(tC, uv + ca).b
  );

  if (fx2 && uKick > 0.2) {
    vec2 rb = q * (r2 * min(uKick - 0.2, 1.4) * 0.020);
    c = (
      c * 1.4 +
      texture2D(tC, uv - rb).rgb * 1.2 +
      texture2D(tC, uv - rb * 2.0).rgb * 0.9 +
      texture2D(tC, uv - rb * 3.0).rgb * 0.5
    ) * 0.25;
  }

  vec3 b = uHasBloom > 0.5 ? texture2D(tB, uv).rgb : vec3(0.0);
  vec3 g = uHasGod > 0.5 ? texture2D(tG, uv).rgb : vec3(0.0);
  float sh = 0.0;
  if (uHasShaft > 0.5) {
    vec2 st = 4.0 / max(uRes, vec2(1.0));
    sh = (
      texture2D(tS, uv + st).r +
      texture2D(tS, uv - st).r +
      texture2D(tS, uv + st * vec2(1.0, -1.0)).r +
      texture2D(tS, uv + st * vec2(-1.0, 1.0)).r
    ) * 0.25;
  }
  c = max(mix(c, b, uBloom) + g * uGod * vec3(1.0, 0.72, 0.46) + sh * uShaftC, 0.0);
  c += b * uFlash * 0.25;
  c *= uExp * (1.0 - uVignette * smoothstep(0.10, 0.75, r2 * 1.25));
  c = aces(c);

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c += uShadowTint * (1.0 - l) + uHighlightTint * l;
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  c = pow(max(c, 0.0), vec3(uInvGamma));

#ifdef GRADE_DITHER_TRIANGULAR
  float ts = fract(uTime) * 19.37;
  float g1 = fract(52.9829189 * fract(dot(gl_FragCoord.xy + ts, vec2(0.06711056, 0.00583715))));
  float g2 = fract(52.9829189 * fract(dot(gl_FragCoord.xy + vec2(17.0, 31.0) + ts, vec2(0.06711056, 0.00583715))));
  c += (g1 - g2) * uGrain;
#else
  float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 91.7, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) * uGrain;
#endif
  gl_FragColor = vec4(clamp(c * uFade, 0.0, 1.0), 1.0);
}
`;

function buildDefines(mode) {
  return mode === 'triangular' ? { GRADE_DITHER_TRIANGULAR: '' } : {};
}

export function create(ctx, params = {}) {
  const { THREE, size = [1920, 1080] } = ctx;
  if (!THREE) throw Object.assign(new TypeError('post.grade-cl 需要 ctx.THREE'), { code: 'usage.bad-argument' });

  const shadowTint = params.shadowTint ?? [-0.002, 0.003, 0.012];
  const highlightTint = params.highlightTint ?? [0.014, 0.006, -0.010];
  const shaftColor = params.shaftColor ?? [0, 0, 0];
  const ring = params.ring ?? [0.5, 0.5, 0, 0];
  const ringS = params.ringShape ?? [1, 1, 0, 0.05];
  const mode0 = params.ditherMode ?? 'hash';

  const uniforms = {
    tC: { value: null },
    tB: { value: null },
    tG: { value: null },
    tS: { value: null },
    uShaftC: { value: new THREE.Vector3(shaftColor[0], shaftColor[1], shaftColor[2]) },
    uShadowTint: { value: new THREE.Vector3(shadowTint[0], shadowTint[1], shadowTint[2]) },
    uHighlightTint: { value: new THREE.Vector3(highlightTint[0], highlightTint[1], highlightTint[2]) },
    uRes: { value: new THREE.Vector2(size[0], size[1]) },
    uRing: { value: new THREE.Vector4(ring[0], ring[1], ring[2], ring[3]) },
    uRingS: { value: new THREE.Vector4(ringS[0], ringS[1], ringS[2], ringS[3]) },
    uBloom: { value: params.bloom ?? 0.06 },
    uGod: { value: params.god ?? 0.55 },
    uExp: { value: params.exposure ?? 1.0 },
    uFade: { value: params.fade ?? 1.0 },
    uVignette: { value: params.vignette ?? 0.42 },
    uCaBase: { value: params.caBase ?? 0.006 },
    uTime: { value: params.time ?? 0.0 },
    uShake: { value: params.shake ?? 0.0 },
    uFlash: { value: params.flash ?? 0.0 },
    uKick: { value: params.kick ?? 0.0 },
    uFringe: { value: params.fringe ?? 0.0 },
    uSaturation: { value: params.saturation ?? 1.06 },
    uContrast: { value: params.contrast ?? 0.44 },
    uInvGamma: { value: 1.0 / (params.gamma ?? 2.2) },
    uGrain: { value: mode0 === 'none' ? 0.0 : (params.grain ?? 0.018) },
    uUseLensFx: { value: 0.0 },
    uHasBloom: { value: 1.0 },
    uHasGod: { value: 0.0 },
    uHasShaft: { value: 0.0 },
  };

  function syncFlags() {
    uniforms.uHasBloom.value = uniforms.tB.value ? 1.0 : 0.0;
    uniforms.uHasGod.value = uniforms.tG.value ? 1.0 : 0.0;
    uniforms.uHasShaft.value = uniforms.tS.value ? 1.0 : 0.0;
    const active = uniforms.uFringe.value > 0
      || uniforms.uRing.value.w > 0
      || uniforms.uKick.value > 1e-4
      || uniforms.uShake.value > 0.075;
    uniforms.uUseLensFx.value = active ? 1.0 : 0.0;
  }

  // 全屏大三角形避免对角缝，与单通道后期对齐
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: buildDefines(mode0),
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'post.grade-cl';
  mesh.frustumCulled = false;
  mesh.onBeforeRender = syncFlags;

  function setState(st = {}) {
    if (st.exposure !== undefined) uniforms.uExp.value = st.exposure;
    if (st.bloom !== undefined) uniforms.uBloom.value = st.bloom;
    if (st.god !== undefined) uniforms.uGod.value = st.god;
    if (st.ca !== undefined) uniforms.uCaBase.value = st.ca;
    if (st.caBase !== undefined) uniforms.uCaBase.value = st.caBase;
    if (st.vignette !== undefined) uniforms.uVignette.value = st.vignette;
    if (st.flash !== undefined) uniforms.uFlash.value = st.flash;
    if (st.fade !== undefined) uniforms.uFade.value = st.fade;
    if (st.shake !== undefined) uniforms.uShake.value = st.shake;
    if (st.time !== undefined) uniforms.uTime.value = st.time;
    if (st.grain !== undefined) uniforms.uGrain.value = st.grain;
    if (st.ditherMode !== undefined) {
      if (st.ditherMode === 'none') uniforms.uGrain.value = 0;
      const next = buildDefines(st.ditherMode);
      if (Boolean(material.defines?.GRADE_DITHER_TRIANGULAR !== undefined) !== Boolean(next.GRADE_DITHER_TRIANGULAR !== undefined)) {
        material.defines = next;
        material.needsUpdate = true;
      }
    }
    if (Array.isArray(st.shaftColor)) uniforms.uShaftC.value.set(st.shaftColor[0], st.shaftColor[1], st.shaftColor[2]);
    const lens = st.lens ?? st;
    if (lens.kick !== undefined) uniforms.uKick.value = lens.kick;
    if (lens.fringe !== undefined) uniforms.uFringe.value = lens.fringe;
    if (lens.ring && typeof lens.ring === 'object' && !Array.isArray(lens.ring)) {
      const r = lens.ring;
      uniforms.uRing.value.set(r.x ?? 0.5, r.y ?? 0.5, r.radius ?? 0, r.strength ?? 0);
      const rad = ((r.angleDeg ?? 0) * Math.PI) / 180;
      uniforms.uRingS.value.set(r.squash ?? 1, Math.cos(rad), Math.sin(rad), r.width ?? 0.05);
    }
    syncFlags();
  }

  return {
    object: mesh,
    uniforms,
    setState,
    setSize(w, h) {
      uniforms.uRes.value.set(w, h);
    },
    apply(f, sub = 0, state = null) {
      const fps = typeof ctx.fps === 'number' && ctx.fps > 0 ? ctx.fps : 60;
      uniforms.uTime.value = (f + sub) / fps;
      if (state) setState(state);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
