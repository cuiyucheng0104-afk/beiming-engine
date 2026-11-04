// 北冥引擎 · 纸纹：有外部纸纹图就用它（重复平铺，均值自动测出当中性点），否则程序化生成整屏一张。
// 程序化纸纹 = 1 像素颗粒 + 颗粒团 + 很淡的纸齿浮雕（左上来光）+ 大块斑驳 + 极淡的纤维；以 0.5 附近为中性、对比很低。
//
//   createPaper(fx, renderer, { url = null, refHeight = 1080 }?) → {
//     ready                 Promise：外部纸纹图载好（或确认没有）后 resolve
//     resize(w, h)          按输出尺寸重建程序化纸纹（下次 prepare 时生成）
//     prepare()             需要时生成程序化纸纹并量均值
//     layer(p) → { tex, strength, mid, w, h }   本帧用哪张纸纹、强度、中性亮度、平铺尺寸（像素）
//                p：{ strength, scale, tex, mid } 或空；tex 是自带贴图（优先于 url），mid 是它的中性亮度（默认 .5）
//     target                程序化纸纹的渲染目标
//     dispose()
//   }
// 程序化纸纹的颗粒尺度按 max(.5, 高度 / refHeight) 缩放，换分辨率看起来一样粗。

import * as THREE from 'three';
import { HASH_NOISE } from './glsl.js';

const PAPER_FS = /* glsl */`
${HASH_NOISE}
uniform float uK;
float fbm(vec2 p, uint s){ float a = 0., m = .5; for (int i = 0; i < 3; i++) { a += m * vnoise(p, s + uint(i) * 101u); p = p * 2.03 + vec2(17.1, 9.3); m *= .5; } return a / .875 - .5; }
float tooth(vec2 p){ return fbm(p / (4.5 * uK), 23u); }
void main(){
  vec2 p = gl_FragCoord.xy;
  float grain = h21(ivec2(p), 7u) - .5;                                     // 1 像素的纸面颗粒
  float g2 = vnoise(p / (1.7 * uK), 9u) - .5;                               // 2 像素左右的颗粒团
  float emb = (tooth(p + vec2(-1., 1.)) - tooth(p + vec2(1., -1.)));        // 纸齿浮雕（左上来光）
  float mott = fbm(p / (160. * uK), 37u);                                   // 大块斑驳（颜料吃纸不均）
  float fib = vnoise(vec2(p.x / 70., p.y / 2.5) * mat2(.96, .28, -.28, .96) / uK, 51u) - .5;   // 极淡的纤维
  float v = .5 + grain * .03 + g2 * .08 + emb * .5 + mott * .3 + fib * .05;
  gl_FragColor = vec4(v, v, v, 1.);
}`;

export function createPaper(fx, renderer, { url = null, refHeight = 1080 } = {}) {
  const mat = fx.material(PAPER_FS, { uK: { value: 1 } });
  let target = null, dirty = true, mid = .5, ext = null, extMid = .5;

  const ready = (async () => {
    if (!url) return;
    try {
      const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 64, 64);
      const d = g.getImageData(0, 0, 64, 64).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (d[i] * .2126 + d[i + 1] * .7152 + d[i + 2] * .0722) / 255;
      extMid = s / (d.length / 4);
      ext = new THREE.Texture(img); ext.wrapS = ext.wrapT = THREE.RepeatWrapping; ext.needsUpdate = true;
    } catch { ext = null; }   // 没有文件：用程序化纸纹
  })();

  function resize(w, h) {
    target?.dispose();
    target = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
    dirty = true;
  }

  function prepare() {
    if (!dirty) return;
    mat.uniforms.uK.value = Math.max(.5, target.height / refHeight);
    fx.draw(mat, target);
    // 量一下均值，叠加时以它为中性点
    const n = 128, buf = new Uint8Array(n * n * 4);
    renderer.readRenderTargetPixels(target, 0, 0, n, n, buf);
    let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i] / 255;
    mid = s / (n * n); dirty = false;
  }

  function layer(p) {
    const tex = p?.tex || ext;
    if (!tex) return { tex: target.texture, strength: p ? p.strength : 0, mid, w: target.width, h: target.height };
    const img = tex.image, sc = p?.scale ?? 1;
    return { tex, strength: p ? p.strength : 0, mid: p?.tex ? (p.mid ?? .5) : extMid, w: (img?.width || 1024) * sc, h: (img?.height || 1024) * sc };
  }

  return {
    ready, resize, prepare, layer,
    get target() { return target; },
    dispose() { target?.dispose(); mat.dispose(); ext?.dispose(); },
  };
}
