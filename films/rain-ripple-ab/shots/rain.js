// 仅波纹盖印片元来自 use-shader-fx，按 MIT 使用，许可见 USE-SHADER-FX-LICENSE.txt。
// @provenance use-shader-fx@338e63427310a6b13947f68c5863e4cf4bbb62f1:packages/use-shader-fx/src/fxs/simulations/useRipple/shader/main.frag
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-FileCopyrightText: 2024 HASHIMOTO Takuma

// 共用北冥水面与雨滴。B 面用上游波纹贴片写入独立目标，再合成折射与波峰。
import * as THREE from 'three';
import { createFullscreen, renderTarget } from '../../../engine/look/pass.js';
import { buildWater, waterFrame } from '../water.js';
import { clamp, mulberry } from '../../../engine/core/math.js';

const impactPositions = {
  'drop-first': [.46, .51, 1],
  'drop-second': [.72, .66, .77],
  'drop-third': [.32, .33, 1.2],
  'drop-fourth': [.59, .41, .9],
  'drop-fifth': [.47, .63, .78],
};

const composeShader = /* glsl */`
uniform sampler2D waterMap, rippleMap;
uniform vec3 impacts[5];
uniform float strengths[5], frame;
uniform vec3 panel;
uniform vec2 panelSize;
varying vec2 vUv;

float hash(float n) { return fract(sin(n * 91.71) * 43758.5453); }
float streak(vec2 p, vec2 a, vec2 b, float width) {
  vec2 ab = b - a;
  float h = clamp(dot(p - a, ab) / dot(ab, ab), 0., 1.);
  return (1. - smoothstep(width * .3, width, length(p - a - ab * h))) * (.22 + .78 * (1. - h));
}

void main() {
  bool enhanced = gl_FragCoord.x >= panel.y;
  vec2 uv = (gl_FragCoord.xy - vec2(enhanced ? panel.y : panel.x, panel.z)) / panelSize;
  if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) {
    gl_FragColor = vec4(.00335, .0070, .0097, 1.);
    #include <colorspace_fragment>
    return;
  }

  vec3 field = texture2D(rippleMap, uv).rgb;
  vec2 shift = vec2(field.r - field.g, .33 * (field.g - field.r)) * .016;
  vec3 color = texture2D(waterMap, clamp(uv + (enhanced ? shift : vec2(0.)), .001, .999)).rgb;
  color *= 1. - .34 * dot(uv - vec2(.5, .61), uv - vec2(.5, .61));
  float gleam = exp(-pow((uv.x - .64 + uv.y * .07) * 4.8, 2.));
  float shimmer = .5 + .5 * sin(uv.y * 510. + sin(uv.x * 51.) * 1.9 + frame * .055);
  color += vec3(.051, .050, .027) * gleam * pow(shimmer, 7.) * (.34 + .66 * uv.y);

  float rain = 0.;
  for (int i = 0; i < 22; i++) {
    float seed = float(i) + 1.;
    float phase = fract(hash(seed) + frame * (.022 + hash(seed + 8.) * .032));
    vec2 p = vec2(hash(seed + 15.) + phase * .12, 1.14 - phase * 1.30);
    rain += streak(uv, p, p + vec2(-.016, .086) * (.4 + hash(seed + 76.)), .0016) * .22;
  }
  color += vec3(.24, .36, .40) * rain;

  for (int i = 0; i < 5; i++) {
    vec3 hit = impacts[i];
    float age = hit.z;
    float strength = strengths[i];
    float depth = mix(1.2, .75, hit.y);
    vec2 p = uv - hit.xy;
    if (age < 0. && age >= -10.) {
      float h = -age * .043;
      color += vec3(.65, .81, .79) * streak(p, vec2(-h * .17, h), vec2(-h * .17 - .014, h + .094), .005);
    }
    if (age >= 0. && age < 40.) {
      float d = length(p / vec2(1., .28));
      float radius = (.015 + .0046 * age) * depth * strength;
      float ring = 1. - smoothstep(.0018, .006, abs(d - radius));
      float fade = pow(1. - age / 40., 2.);
      color += vec3(.27, .48, .43) * ring * fade * .50;
      float flash = exp(-dot(p * vec2(52., 130.), p * vec2(52., 130.))) * exp(-age * .48);
      color += vec3(.76, .93, .80) * flash;
      if (age < 12.) {
        for (int j = 0; j < 7; j++) {
          float seed = float(j + 1);
          float t = age / 12.;
          vec2 spray = vec2((hash(seed + 9.) - .5) * .14 * t, (.041 + .082 * hash(seed)) * 4. * t * (1. - t));
          vec2 dp = (p - spray) * vec2(360., 220.);
          color += vec3(.44, .66, .60) * exp(-dot(dp, dp)) * (1. - t) * strength;
        }
      }
    }
  }
  if (enhanced) {
    color *= 1. - .54 * min(field.g, .9);
    color += vec3(.65, .87, .75) * field.b * .65;
    color += vec3(.60, .41, .19) * field.r * gleam * .28;
  }
  gl_FragColor = vec4(color, 1.);
  #include <colorspace_fragment>
}`;

// 原片元着色器的 uMap RGB 与 uOpacity 直出逻辑，许可全文见本作品目录。
const rippleFragment = /* glsl */`
precision highp float;
uniform sampler2D uMap;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 uv = vUv;
  vec3 color = texture2D(uMap, uv).rgb;
  gl_FragColor = vec4(color, uOpacity);
}`;

const rippleVertex = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`;

function dataTexture(width, height, sample) {
  const bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = sample((x + .5) / width, (y + .5) / height);
      bytes.set([...rgb.map(value => Math.round(clamp(value) * 255)), 255], (y * width + x) * 4);
    }
  }
  const map = new THREE.DataTexture(bytes, width, height, THREE.RGBAFormat);
  map.magFilter = map.minFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  return map;
}

function makeReflection() {
  const random = mulberry(1297);
  const bands = Array.from({ length: 6 }, () => random() * 6.28);
  return dataTexture(256, 128, (x, y) => {
    const bank = .39 + .14 * Math.sin(9 * x + bands[0]) + .075 * Math.sin(23 * x + bands[1])
      + .025 * Math.sin(48 * x + bands[2]);
    const hills = clamp((y - bank) * 9);
    const amber = Math.exp(-((x - .65) ** 2) * 53) * hills * .36;
    const cloud = .016 * Math.sin(24 * x + 8 * y + bands[3]) + .012 * Math.sin(39 * x - 22 * y + bands[4]);
    return [.035 + .09 * hills + amber + cloud, .067 + .19 * hills + amber * .58 + cloud, .075 + .17 * hills + amber * .25 + cloud];
  });
}

function makeStamp() {
  return dataTexture(256, 256, (u, v) => {
    const x = u * 2 - 1, y = v * 2 - 1;
    const angle = Math.atan2(y, x);
    const rough = Math.sin(angle * 7 + 1) * .014 + Math.sin(angle * 13) * .009;
    const r = Math.hypot(x, y) + rough;
    const band = (center, width) => Math.exp(-(((r - center) / width) ** 2));
    const profile = (offset, width) => band(.75 + offset, width) + .62 * band(.55 + offset, width)
      + .33 * band(.36 + offset, width);
    const sheen = .55 + .40 * Math.sin(angle + .7) + .14 * Math.sin(angle * 5);
    return [profile(0, .036), profile(-.068, .038), profile(.01, .027) * sheen];
  });
}

export function buildRain(renderer, timing) {
  const fx = createFullscreen(renderer);
  const colors = renderTarget(1, 1, { depthBuffer: true });
  const waves = renderTarget(1, 1);
  const world = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 25000);
  camera.position.set(0, 156, 360);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const water = buildWater({ sky: makeReflection(), skyRect: [0, -700, 1000, 1400], DW: 1000, DH: 1000 });
  world.add(water);

  const waveScene = new THREE.Scene();
  const waveCamera = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 2);
  waveCamera.position.z = 1;
  const quad = new THREE.PlaneGeometry(1, 1);
  const stamp = makeStamp();
  const impacts = timing.events.map(event => {
    const [x, y, strength] = impactPositions[event.id];
    const mesh = new THREE.Mesh(quad, new THREE.ShaderMaterial({
      vertexShader: rippleVertex, fragmentShader: rippleFragment,
      uniforms: { uMap: { value: stamp }, uOpacity: { value: 0 } },
      transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    }));
    mesh.position.set(x, y, 0);
    waveScene.add(mesh);
    return { ...event, x, y, strength, mesh };
  });
  const impactUniforms = impacts.map(({ x, y }) => new THREE.Vector3(x, y, -100));
  const compose = fx.material(composeShader, {
    waterMap: { value: colors.texture }, rippleMap: { value: waves.texture },
    impacts: { value: impactUniforms }, strengths: { value: impacts.map(impact => impact.strength) },
    frame: { value: 0 }, panel: { value: new THREE.Vector3() }, panelSize: { value: new THREE.Vector2() },
  });

  return {
    resize(width, height) {
      const panelWidth = Math.max(1, Math.round(width * .45));
      const panelHeight = Math.max(1, Math.round(height * .65));
      compose.uniforms.panel.value.set(Math.round(width * .04), Math.round(width * .51), Math.round(height * .12));
      compose.uniforms.panelSize.value.set(panelWidth, panelHeight);
      colors.setSize(panelWidth, panelHeight);
      waves.setSize(panelWidth, panelHeight);
      camera.aspect = panelWidth / panelHeight;
      camera.updateProjectionMatrix();
    },
    draw(frame) {
      const t = frame / timing.fps;
      waterFrame(water, camera, 1000, 1000, { t, held: Math.floor(frame / 2), sunAz: .12, sunUp: .12 });
      renderer.setRenderTarget(colors);
      renderer.render(world, camera);

      impacts.forEach(({ y, mesh, strength, frame: start }, i) => {
        const age = frame - start;
        impactUniforms[i].z = age;
        mesh.visible = age >= 0 && age < 45;
        if (!mesh.visible) return;
        const width = (.062 + .0136 * age) * strength * (1.2 - .45 * y);
        mesh.scale.set(width, width * .28, 1);
        mesh.material.uniforms.uOpacity.value = .87 * (1 - age / 45) ** 1.55;
      });
      renderer.setRenderTarget(waves);
      renderer.render(waveScene, waveCamera);
      compose.uniforms.frame.value = frame;
      fx.draw(compose, null);
    },
  };
}
