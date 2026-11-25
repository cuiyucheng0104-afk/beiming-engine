// post.lens-fx：冲击波环形折射扭曲、径向缩放拖影与边缘加强色散。
// 所有强度归零时（ringStrength=0, kick=0, fringe=0, shake=0）严格恒等（maxAbs = 0）。

export const VERTEX_SHADER = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = /* glsl */`
uniform sampler2D tC;
uniform vec2 uRes;
uniform vec2 uSmearCenter;
uniform vec4 uRing;
uniform vec4 uRingS;
uniform float uKick;
uniform float uFringe;
uniform float uShake;
uniform float uCaBase;
varying vec2 vUv;

void main() {
  bool activeFx = (uRing.w > 0.0) || (uKick > 1e-4) || (uFringe > 0.0) || (uShake > 1e-4) || (uCaBase > 0.0);
  if (!activeFx) {
    gl_FragColor = texelFetch(tC, ivec2(gl_FragCoord.xy), 0);
    return;
  }

  vec2 uv = vUv;
  vec2 q = uv - uSmearCenter;
  float r2 = dot(q, q);
  uv -= q * (r2 * uKick * 0.20);

  float asp = uRes.x / max(uRes.y, 1.0);
  if (uRing.w > 0.0) {
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

  float caK = uCaBase + min(uShake * 0.02, 0.0015) + 0.004 * uFringe;
  vec2 ca = q * r2 * caK;
  vec4 centerTex = texture2D(tC, uv);
  vec3 c = caK > 0.0
    ? vec3(texture2D(tC, uv - ca).r, centerTex.g, texture2D(tC, uv + ca).b)
    : centerTex.rgb;

  if (uKick > 0.2) {
    vec2 rb = q * (r2 * min(uKick - 0.2, 1.4) * 0.020);
    c = (
      c * 1.4 +
      texture2D(tC, uv - rb).rgb * 1.2 +
      texture2D(tC, uv - rb * 2.0).rgb * 0.9 +
      texture2D(tC, uv - rb * 3.0).rgb * 0.5
    ) * 0.25;
  }

  gl_FragColor = vec4(c, centerTex.a);
}
`;

export function normalizeLensState(state = {}) {
  const ringObj = state.ring && typeof state.ring === 'object' && !Array.isArray(state.ring) ? state.ring : null;
  const lensObj = state.lens && typeof state.lens === 'object' ? state.lens : state;
  const ring = ringObj ?? (lensObj.ring && typeof lensObj.ring === 'object' && !Array.isArray(lensObj.ring) ? lensObj.ring : null);
  return {
    ringCenterX: ring?.x ?? state.ringCenterX ?? 0.5,
    ringCenterY: ring?.y ?? state.ringCenterY ?? 0.5,
    ringRadius: ring?.radius ?? state.ringRadius ?? 0,
    ringWidth: Math.max(ring?.width ?? state.ringWidth ?? 0.05, 1e-4),
    ringStrength: ring?.strength ?? state.ringStrength ?? 0,
    ringSquash: Math.max(ring?.squash ?? state.ringSquash ?? 1, 1e-4),
    ringAngleDeg: ring?.angleDeg ?? state.ringAngleDeg ?? 0,
    kick: lensObj.kick ?? state.kick ?? 0,
    smearCenterX: state.smearCenterX ?? 0.5,
    smearCenterY: state.smearCenterY ?? 0.5,
    fringe: lensObj.fringe ?? state.fringe ?? 0,
    shake: state.shake ?? 0,
    caBase: state.caBase ?? 0,
  };
}

/** 判定镜头特效是否激活（全零返回 false，可走逐位恒等快路径） */
export function isLensFxActive(state = {}) {
  const s = normalizeLensState(state);
  return s.ringStrength > 0 || s.kick > 1e-4 || s.fringe > 0 || s.shake > 1e-4 || s.caBase > 0;
}

/** 纯函数计算单点经径向 kick 与冲击波折射后的采样 UV */
export function computeLensUv(u0, v0, aspect, state = {}) {
  const s = normalizeLensState(state);
  const qx = u0 - s.smearCenterX;
  const qy = v0 - s.smearCenterY;
  const r2 = qx * qx + qy * qy;
  let u = u0 - qx * (r2 * s.kick * 0.20);
  let v = v0 - qy * (r2 * s.kick * 0.20);

  if (s.ringStrength > 0) {
    const rad = (s.ringAngleDeg * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const dx = (u0 - s.ringCenterX) * aspect;
    const dy = v0 - s.ringCenterY;
    const ex = (dx * cosA + dy * sinA) / s.ringSquash;
    const ey = -dx * sinA + dy * cosA;
    const rr = Math.hypot(ex, ey);
    const x = (rr - s.ringRadius) / s.ringWidth;
    const face = Math.abs(ex) / Math.max(rr, 1e-4);
    const dl = Math.max(Math.hypot(dx, dy), 1e-4);
    const mag = x * Math.exp(-x * x) * s.ringStrength * (0.25 + 0.75 * face);
    u -= (dx / dl / aspect) * mag;
    v -= (dy / dl) * mag;
  }
  return [u, v];
}

function sampleRgba(data, w, h, u, v, topDown, out) {
  const uc = u < 0 ? 0 : u > 1 ? 1 : u;
  const vc = v < 0 ? 0 : v > 1 ? 1 : v;
  let fx = uc * w - 0.5;
  let fy = (topDown ? (1 - vc) : vc) * h - 0.5;
  if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
  if (fy < 0) fy = 0; else if (fy > h - 1) fy = h - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  out[0] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
  out[1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
  out[2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
  out[3] = data[i00 + 3] * w00 + data[i10 + 3] * w10 + data[i01 + 3] * w01 + data[i11 + 3] * w11;
}

/**
 * 纯 CPU 镜头特效参考求值器（RGBA Float32Array）。
 * 所有强度为 0 时直接返回输入拷贝，误差 maxAbs === 0。
 */
export function evaluateLensFx(rgba, width, height, state = {}, { origin = 'top-left' } = {}) {
  if (!(rgba instanceof Float32Array) || rgba.length !== width * height * 4) {
    throw Object.assign(new RangeError('post.lens-fx 需要长度 width*height*4 的 Float32Array'), { code: 'usage.bad-argument' });
  }
  const s = normalizeLensState(state);
  if (!isLensFxActive(s)) {
    return new Float32Array(rgba);
  }

  const topDown = origin !== 'bottom-left';
  const out = new Float32Array(rgba.length);
  const asp = width / height;
  const rad = (s.ringAngleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const caK = s.caBase + Math.min(s.shake * 0.02, 0.0015) + 0.004 * s.fringe;
  const smearActive = s.kick > 0.2;
  const smearK = smearActive ? Math.min(s.kick - 0.2, 1.4) * 0.020 : 0;

  const t0 = [0, 0, 0, 1];
  const tR = [0, 0, 0, 1];
  const tB = [0, 0, 0, 1];
  const tS = [0, 0, 0, 1];

  for (let row = 0; row < height; row++) {
    const v0 = topDown ? (height - 0.5 - row) / height : (row + 0.5) / height;
    const qy = v0 - s.smearCenterY;
    const qy2 = qy * qy;
    for (let col = 0; col < width; col++) {
      const u0 = (col + 0.5) / width;
      const qx = u0 - s.smearCenterX;
      const r2 = qx * qx + qy2;

      let u = u0 - qx * (r2 * s.kick * 0.20);
      let v = v0 - qy * (r2 * s.kick * 0.20);

      if (s.ringStrength > 0) {
        const dx = (u0 - s.ringCenterX) * asp;
        const dy = v0 - s.ringCenterY;
        const ex = (dx * cosA + dy * sinA) / s.ringSquash;
        const ey = -dx * sinA + dy * cosA;
        const rr = Math.hypot(ex, ey);
        const x = (rr - s.ringRadius) / s.ringWidth;
        const face = Math.abs(ex) / Math.max(rr, 1e-4);
        const dl = Math.max(Math.hypot(dx, dy), 1e-4);
        const mag = x * Math.exp(-x * x) * s.ringStrength * (0.25 + 0.75 * face);
        u -= (dx / dl / asp) * mag;
        v -= (dy / dl) * mag;
      }

      sampleRgba(rgba, width, height, u, v, topDown, t0);
      let cr = t0[0], cg = t0[1], cb = t0[2];
      if (caK > 0) {
        const cax = qx * r2 * caK;
        const cay = qy * r2 * caK;
        sampleRgba(rgba, width, height, u - cax, v - cay, topDown, tR);
        sampleRgba(rgba, width, height, u + cax, v + cay, topDown, tB);
        cr = tR[0];
        cb = tB[2];
      }

      if (smearActive) {
        const rbx = qx * r2 * smearK;
        const rby = qy * r2 * smearK;
        sampleRgba(rgba, width, height, u - rbx, v - rby, topDown, tS);
        const s1r = tS[0], s1g = tS[1], s1b = tS[2];
        sampleRgba(rgba, width, height, u - 2 * rbx, v - 2 * rby, topDown, tS);
        const s2r = tS[0], s2g = tS[1], s2b = tS[2];
        sampleRgba(rgba, width, height, u - 3 * rbx, v - 3 * rby, topDown, tS);
        cr = (cr * 1.4 + s1r * 1.2 + s2r * 0.9 + tS[0] * 0.5) * 0.25;
        cg = (cg * 1.4 + s1g * 1.2 + s2g * 0.9 + tS[1] * 0.5) * 0.25;
        cb = (cb * 1.4 + s1b * 1.2 + s2b * 0.9 + tS[2] * 0.5) * 0.25;
      }

      const idx = (row * width + col) * 4;
      out[idx] = cr;
      out[idx + 1] = cg;
      out[idx + 2] = cb;
      out[idx + 3] = t0[3];
    }
  }
  return out;
}

export function create(ctx, params = {}) {
  const { THREE, size = [1920, 1080] } = ctx;
  if (!THREE) throw Object.assign(new TypeError('post.lens-fx 需要 ctx.THREE'), { code: 'usage.bad-argument' });

  const init = normalizeLensState(params);
  const rad0 = (init.ringAngleDeg * Math.PI) / 180;
  const uniforms = {
    tC: { value: null },
    uRes: { value: new THREE.Vector2(size[0], size[1]) },
    uSmearCenter: { value: new THREE.Vector2(init.smearCenterX, init.smearCenterY) },
    uRing: { value: new THREE.Vector4(init.ringCenterX, init.ringCenterY, init.ringRadius, init.ringStrength) },
    uRingS: { value: new THREE.Vector4(init.ringSquash, Math.cos(rad0), Math.sin(rad0), init.ringWidth) },
    uKick: { value: init.kick },
    uFringe: { value: init.fringe },
    uShake: { value: init.shake },
    uCaBase: { value: init.caBase },
  };

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'post.lens-fx';
  mesh.frustumCulled = false;

  let current = { ...init };

  function setState(st = {}) {
    current = normalizeLensState({ ...current, ...st });
    const rad = (current.ringAngleDeg * Math.PI) / 180;
    uniforms.uSmearCenter.value.set(current.smearCenterX, current.smearCenterY);
    uniforms.uRing.value.set(current.ringCenterX, current.ringCenterY, current.ringRadius, current.ringStrength);
    uniforms.uRingS.value.set(current.ringSquash, Math.cos(rad), Math.sin(rad), current.ringWidth);
    uniforms.uKick.value = current.kick;
    uniforms.uFringe.value = current.fringe;
    uniforms.uShake.value = current.shake;
    uniforms.uCaBase.value = current.caBase;
  }

  return {
    object: mesh,
    uniforms,
    setState,
    setSize(w, h) {
      uniforms.uRes.value.set(w, h);
    },
    isActive() {
      return isLensFxActive(current);
    },
    apply(_f, _sub = 0, state = null) {
      if (state) setState(state);
    },
    meta() {
      return {
        readings: {
          active: isLensFxActive(current) ? 1 : 0,
          kick: current.kick,
          fringe: current.fringe,
          ringStrength: current.ringStrength,
        },
      };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
