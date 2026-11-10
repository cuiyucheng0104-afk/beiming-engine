// 北冥引擎 · 纸纹：有外部纸纹图就用它（重复平铺，均值自动测出当中性点），否则程序化生成整屏一张。
// 程序化纸纹 = 1 像素颗粒 + 颗粒团 + 很淡的纸齿浮雕（左上来光）+ 大块斑驳 + 极淡的纤维；以 0.5 附近为中性、对比很低。
//
//   createPaper(fx, renderer, { url = null, refHeight = 1080 }?) → {
//     ready                 Promise：外部纸纹图载好（或确认没有）后 resolve；给了 url 却加载失败（文件不存在、不是图片、
//                           跨域读不到像素）就 reject，错误信息带上地址——不再悄悄换成程序化纸纹（换了画面质感就变了）
//     resize(w, h)          按输出尺寸重建程序化纸纹（下次 prepare 时生成）
//     prepare()             需要时生成程序化纸纹并量均值（整幅均匀取 128×128 个点在 GPU 上平均，再读回 16×16：
//                           任何尺寸都量得到、换分辨率中性点不漂；以前只读左下角 128×128，画面不到 128 像素时读不到、中性点成 0）
//     layer(p, kp = 1, k = kp) → { tex, strength, mid, w, h, anchor }   本帧用哪张纸纹、强度、中性亮度、平铺尺寸（像素）、锚点
//                p：{ strength, scale, tex, mid, scaleMode, anchor } 或空；tex 是自带贴图（优先于 url），mid 是它的中性亮度（默认 .5）
//                kp：整数像素倍率（look 按 round(输出高度 / refHeight) 给，原生 4K 为 2）：图片纸纹按 1 图像像素 = kp 输出像素平铺，
//                    换分辨率纸纹相对画面一样大；1080 附近 kp = 1，和原来一样
//                k：连续倍率 输出高度 / refHeight（look 给）
//                scaleMode  'pixel'（默认，按上面的整数倍 kp 平铺）| 'refHeight'（平铺尺寸乘连续的 k：1440、竖屏等不是整数倍的
//                           画幅上纸纹相对画面也一样大）。只对图片纸纹起作用，程序化纸纹本来就按 refHeight 缩放
//                anchor     纸纹跟着画面里的一点走（推拉摇移时纸不再"钉在玻璃上"），默认关：
//                           { pos: [x, y], origin: [x0, y0], zoom }——锚点此刻的屏幕位置、铺纸那一帧的位置（实际像素，左上为原点）、
//                           此刻相对铺纸那一帧的缩放。纸纹点 = (像素 − pos) / zoom + origin。用 paperAnchor(now, ref) 从两次
//                           screenAnchor（engine/stage/camera.js）的结果算。配可平铺的图片纸纹；程序化纸纹挪动时会在画面宽高处露接缝
//     target                程序化纸纹的渲染目标
//     dispose()
//   }
//   paperAnchor(now, ref) → anchor   now / ref = { x, y, s }（screenAnchor 的结果：屏幕位置与锚点处一段长度的像素长）
// 程序化纸纹的颗粒尺度按 max(.5, 高度 / refHeight) 缩放，换分辨率看起来一样粗；图片纸纹按 layer 的 kp 放大平铺。

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

// 均值：16×16 的格子，每格在纸纹上均匀取 8×8 个点
const MEAN_N = 16;
const MEAN_FS = /* glsl */`
uniform sampler2D tIn;
varying vec2 vUv;
void main(){
  vec2 c0 = floor(vUv * ${MEAN_N}.);
  float s = 0.;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) s += texture2D(tIn, (c0 + (vec2(float(i), float(j)) + .5) / 8.) / ${MEAN_N}.).r;
  gl_FragColor = vec4(vec3(s / 64.), 1.);
}`;

const SCALE_MODES = ['pixel', 'refHeight'];
const finite2 = v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
// 锚点参数：没给 = null（走默认着色器，旧输出逐像素不变）；给了就校验
function anchorOf(a) {
  if (a === undefined || a === null || a === false) return null;
  const zoom = a.zoom ?? 1;
  if (!finite2(a.pos) || !finite2(a.origin ?? a.pos) || !(Number.isFinite(zoom) && zoom > 0)) {
    throw new TypeError(`纸纹 anchor 要写成 { pos: [x, y], origin: [x0, y0], zoom > 0 }，收到 ${JSON.stringify(a)}`);
  }
  return { pos: a.pos, origin: a.origin ?? a.pos, zoom };
}
// layer 的返回值只在给了锚点时带 anchor 字段（没有锚点时与以前的对象逐字段相同）
const withAnchor = (o, a) => (a ? { ...o, anchor: a } : o);
export function paperAnchor(now, ref) {
  for (const [k, v] of [['now', now], ['ref', ref]]) {
    if (!v || ![v.x, v.y, v.s].every(Number.isFinite) || !(v.s > 0)) throw new TypeError(`paperAnchor：${k} 要是 { x, y, s > 0 }（screenAnchor 的结果），收到 ${JSON.stringify(v)}`);
  }
  return { pos: [now.x, now.y], origin: [ref.x, ref.y], zoom: now.s / ref.s };
}

export function createPaper(fx, renderer, { url = null, refHeight = 1080 } = {}) {
  const mat = fx.material(PAPER_FS, { uK: { value: 1 } });
  const meanMat = fx.material(MEAN_FS, { tIn: { value: null } });
  let target = null, meanT = null, dirty = true, mid = .5, ext = null, extMid = .5;

  const ready = (async () => {
    if (!url) return;
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error(`纸纹图加载失败：${url}（文件不存在或不是图片）。检查路径（相对页面）；不想用外部纸纹就别传 paperUrl，引擎会用程序化纸纹`));
      im.src = url;
    });
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 64, 64);
    let d;
    try { d = g.getImageData(0, 0, 64, 64).data; }
    catch (e) { throw new Error(`纸纹图读不到像素：${url}（${e && e.message || e}；跨域图片要和页面同源）`); }
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (d[i] * .2126 + d[i + 1] * .7152 + d[i + 2] * .0722) / 255;
    extMid = s / (d.length / 4);
    ext = new THREE.Texture(img); ext.wrapS = ext.wrapT = THREE.RepeatWrapping; ext.needsUpdate = true;
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
    // 量整幅的均值，叠加时以它为中性点
    // 8 位目标：哪台设备都能渲、能读回（各格的取整误差在 256 格上互相抵消）
    meanT ??= new THREE.WebGLRenderTarget(MEAN_N, MEAN_N, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    meanMat.uniforms.tIn.value = target.texture; fx.draw(meanMat, meanT);
    const buf = new Uint8Array(MEAN_N * MEAN_N * 4);
    renderer.readRenderTargetPixels(meanT, 0, 0, MEAN_N, MEAN_N, buf);
    let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i] / 255;
    mid = s / (MEAN_N * MEAN_N); dirty = false;
  }

  function layer(p, kp = 1, k = kp) {
    const tex = p?.tex || ext, anchor = anchorOf(p?.anchor);
    if (p?.scaleMode !== undefined && p.scaleMode !== null && !SCALE_MODES.includes(p.scaleMode)) {
      throw new TypeError(`纸纹 scaleMode 只能是 ${SCALE_MODES.join(' / ')}，收到 ${JSON.stringify(p.scaleMode)}`);
    }
    if (!tex) return withAnchor({ tex: target.texture, strength: p ? p.strength : 0, mid, w: target.width, h: target.height }, anchor);
    const img = tex.image, sc = (p?.scale ?? 1) * (p?.scaleMode === 'refHeight' ? k : kp);
    return withAnchor({ tex, strength: p ? p.strength : 0, mid: p?.tex ? (p.mid ?? .5) : extMid, w: (img?.width || 1024) * sc, h: (img?.height || 1024) * sc }, anchor);
  }

  return {
    ready, resize, prepare, layer,
    get target() { return target; },
    get mid() { return mid; },
    dispose() { target?.dispose(); meanT?.dispose(); mat.dispose(); meanMat.dispose(); ext?.dispose(); },
  };
}
