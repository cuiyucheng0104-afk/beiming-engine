// 北冥引擎 · bloom：软阈值预滤（4×4 盒）→ 13 抽头下采样 mip 链 → 帐篷上采样逐级混回（radius 决定大光晕的权重）。
// 阈值比的是线性 HDR 的最大通道。最后一步只取上采样的模糊结果，不混入半分辨率的清晰亮部（bloom 是光晕，不是提亮）。
//
//   createBloom(fx, { levels = 7, minSize = 8, refHeight = 0 }?) → {
//     resize(w, h)          按源图尺寸建 mip 链：从 w/2 × h/2 起逐级减半，最多 levels + skip 级，短边不小于 minSize
//     render(src, p) → 光晕纹理（取自第 skip 级）；mip 链为空时返回 null
//                           p：{ threshold, knee, radius }（strength / tint 在调色那一步乘）
//     dispose()
//   }
// 换分辨率光晕一致：mip 链每级是绝对像素，refHeight（像素量的标定高度）给了时，skip = round(log2(h / refHeight))，
// 高分辨率先用 2×2 盒子平均降 skip 级（不做阈值，相当于先缩到标定分辨率），再从第 skip 级起走同样的预滤、mip 链和上采样，
// 结果也从第 skip 级取（原生 4K 对 1080 标定为 1）。各级相对画面的尺度与标定分辨率一致；
// h 在标定高度附近（skip = 0）时和原来逐像素相同。refHeight 不给 = 0 = 不缩放（旧行为）。

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
const BOX_FS = /* glsl */`
uniform sampler2D tIn;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(texture2D(tIn, vUv).rgb, 1.); }`;   // 半分辨率处一次双线性 = 2×2 盒子平均
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

export function createBloom(fx, { levels = 7, minSize = 8, refHeight = 0 } = {}) {
  const pre = fx.material(PRE_FS, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() }, uThr: { value: .7 }, uKnee: { value: .2 } });
  const down = fx.material(DOWN_FS, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const up = fx.material(UP_FS, { tLow: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: .6 } });
  const box = fx.material(BOX_FS, { tIn: { value: null } });
  let W = 0, H = 0, lv = [], skip = 0;
  const free = () => { for (const l of lv) { l.down.dispose(); l.up?.dispose(); } lv = []; };

  function resize(w, h) {
    free(); W = w; H = h;
    const want = refHeight > 0 && h > 0 ? Math.max(0, Math.round(Math.log2(h / refHeight))) : 0;
    let bw = W >> 1, bh = H >> 1;
    while (lv.length < levels + want && Math.min(bw, bh) >= minSize) {
      lv.push({ w: bw, h: bh, down: renderTarget(bw, bh), up: lv.length >= want ? renderTarget(bw, bh) : null }); bw >>= 1; bh >>= 1;
    }
    skip = Math.min(want, Math.max(0, lv.length - 1));
    for (let i = skip; i < lv.length; i++) lv[i].up ??= renderTarget(lv[i].w, lv[i].h);   // 链比预想的短：起始级前移
  }

  function render(src, p) {
    if (!lv.length) return null;
    let tex = src, tw = W, th = H;
    for (let i = 0; i < skip; i++) { box.uniforms.tIn.value = tex; fx.draw(box, lv[i].down); tex = lv[i].down.texture; tw = lv[i].w; th = lv[i].h; }
    const pr = pre.uniforms; pr.tIn.value = tex; pr.uTexel.value.set(1 / tw, 1 / th); pr.uThr.value = p.threshold; pr.uKnee.value = p.knee;
    fx.draw(pre, lv[skip].down);
    for (let i = skip + 1; i < lv.length; i++) {
      const d = down.uniforms; d.tIn.value = lv[i - 1].down.texture; d.uTexel.value.set(1 / lv[i - 1].w, 1 / lv[i - 1].h);
      fx.draw(down, lv[i].down);
    }
    let low = lv[lv.length - 1].down;
    for (let i = lv.length - 2; i >= skip; i--) {
      const u = up.uniforms; u.tLow.value = low.texture; u.tCur.value = lv[i].down.texture;
      u.uTexel.value.set(1 / lv[i + 1].w, 1 / lv[i + 1].h); u.uRadius.value = i === skip ? 1 : p.radius;
      fx.draw(up, lv[i].up); low = lv[i].up;
    }
    return low.texture;
  }

  return { resize, render, get skip() { return skip; }, get levels() { return lv.length; }, dispose() { free(); pre.dispose(); down.dispose(); up.dispose(); box.dispose(); } };
}
