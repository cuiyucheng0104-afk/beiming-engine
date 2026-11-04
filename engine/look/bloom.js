// 北冥引擎 · bloom：软阈值预滤（4×4 盒）→ 13 抽头下采样 mip 链 → 帐篷上采样逐级混回（radius 决定大光晕的权重）。
// 阈值比的是线性 HDR 的最大通道。最后一步只取上采样的模糊结果，不混入半分辨率的清晰亮部（bloom 是光晕，不是提亮）。
//
//   createBloom(fx, { levels = 7, minSize = 8 }?) → {
//     resize(w, h)          按源图尺寸建 mip 链：从 w/2 × h/2 起逐级减半，最多 levels 级，短边不小于 minSize
//     render(src, p) → 光晕纹理；mip 链为空时返回 null
//                           p：{ threshold, knee, radius }（strength / tint 在调色那一步乘）
//     dispose()
//   }

import * as THREE from 'three';
import { renderTarget } from './pass.js';

const PRE_FS = /* glsl */`
uniform sampler2D tIn; uniform vec2 uTexel; uniform float uThr, uKnee;
varying vec2 vUv;
void main(){
  vec2 o = uTexel;   // 源图像素；四个双线性采样合成 4×4 盒
  vec3 c = (texture2D(tIn, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tIn, vUv + vec2(o.x, -o.y)).rgb
          + texture2D(tIn, vUv + vec2(-o.x, o.y)).rgb + texture2D(tIn, vUv + vec2(o.x, o.y)).rgb) * .25;
  float l = max(c.r, max(c.g, c.b));
  float k = max(uKnee, 1e-4);
  float soft = clamp(l - uThr + k, 0., 2. * k); soft = soft * soft / (4. * k);
  float w = max(soft, l - uThr) / max(l, 1e-4);
  gl_FragColor = vec4(c * w, 1.);
}`;
const DOWN_FS = /* glsl */`
uniform sampler2D tIn; uniform vec2 uTexel;
varying vec2 vUv;
vec3 s(vec2 o){ return texture2D(tIn, vUv + o * uTexel).rgb; }
void main(){
  vec3 c = s(vec2(0)) * .125;
  c += (s(vec2(-2, -2)) + s(vec2(2, -2)) + s(vec2(-2, 2)) + s(vec2(2, 2))) * .03125;
  c += (s(vec2(0, -2)) + s(vec2(-2, 0)) + s(vec2(2, 0)) + s(vec2(0, 2))) * .0625;
  c += (s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1))) * .125;
  gl_FragColor = vec4(c, 1.);
}`;
const UP_FS = /* glsl */`
uniform sampler2D tLow, tCur; uniform vec2 uTexel; uniform float uRadius;
varying vec2 vUv;
vec3 s(vec2 o){ return texture2D(tLow, vUv + o * uTexel).rgb; }
void main(){
  vec3 t = s(vec2(0)) * 4.;
  t += (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.;
  t += s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1));
  gl_FragColor = vec4(mix(texture2D(tCur, vUv).rgb, t / 16., uRadius), 1.);
}`;

export function createBloom(fx, { levels = 7, minSize = 8 } = {}) {
  const pre = fx.material(PRE_FS, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() }, uThr: { value: .7 }, uKnee: { value: .2 } });
  const down = fx.material(DOWN_FS, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const up = fx.material(UP_FS, { tLow: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: .6 } });
  let W = 0, H = 0, lv = [];
  const free = () => { for (const l of lv) { l.down.dispose(); l.up.dispose(); } lv = []; };

  function resize(w, h) {
    free(); W = w; H = h;
    let bw = W >> 1, bh = H >> 1;
    while (lv.length < levels && Math.min(bw, bh) >= minSize) { lv.push({ w: bw, h: bh, down: renderTarget(bw, bh), up: renderTarget(bw, bh) }); bw >>= 1; bh >>= 1; }
  }

  function render(src, p) {
    if (!lv.length) return null;
    const pr = pre.uniforms; pr.tIn.value = src; pr.uTexel.value.set(1 / W, 1 / H); pr.uThr.value = p.threshold; pr.uKnee.value = p.knee;
    fx.draw(pre, lv[0].down);
    for (let i = 1; i < lv.length; i++) {
      const d = down.uniforms; d.tIn.value = lv[i - 1].down.texture; d.uTexel.value.set(1 / lv[i - 1].w, 1 / lv[i - 1].h);
      fx.draw(down, lv[i].down);
    }
    let low = lv[lv.length - 1].down;
    for (let i = lv.length - 2; i >= 0; i--) {
      const u = up.uniforms; u.tLow.value = low.texture; u.tCur.value = lv[i].down.texture;
      u.uTexel.value.set(1 / lv[i + 1].w, 1 / lv[i + 1].h); u.uRadius.value = i === 0 ? 1 : p.radius;
      fx.draw(up, lv[i].up); low = lv[i].up;
    }
    return low.texture;
  }

  return { resize, render, dispose() { free(); pre.dispose(); down.dispose(); up.dispose(); } };
}
