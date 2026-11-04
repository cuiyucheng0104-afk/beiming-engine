// 北冥引擎 · 底板面片：把 2D 手绘底板、2D 画布变成 3D 场景里的面片，镜头运动时由真实透视产生视差。
// 面片都是 1×1 的单位平面，大小和位置交给 camera.js 的 placeOnScreen 按屏幕像素摆；全部不参与描边（userData.outline = false）。
//
//   loadPlates(names, { dir, linear })     读 <dir>/plates.json + 贴图 → { meta, tex }；linear 里的名字按数据贴图读（不做 sRGB 解码）
//   plateMat(map, o) / plate(map, order, o) 底板材质 / 面片：直通 alpha、不写深度、不受雾和色调映射影响
//   plateCopy(map, { wrap })               贴图副本，可单独卷动 offset、设 repeat；wrap = 横向循环
//   tileRepeat(map, wpx, hpx)              横向循环贴图铺满 wpx×hpx 时不变形的重复次数
//   canvasLayer(w, h)                      2D 画布 + 它的 sRGB 贴图 → { canvas, ctx, tex }
//   cropPlate(map, rect, o)                底板的一块（uv 矩形）+ 椭圆软边，可翻转、染色（云片、雾团）
//   cutoutPlane(tex, { order, cut })       抠像面片：彩色层 + 只写深度的遮罩层，让后期按深度区分笔触大小
//   glowSprite(color, o)                   加色辉光斑（太阳、灯）：两层高斯 + 软边，squash 压扁
import * as THREE from 'three';

export async function loadPlates(names, { dir = './assets/plates', linear = [] } = {}) {
  const meta = await (await fetch(`${dir}/plates.json`)).json();
  const M = {}; for (const p of meta.plates) M[p.name] = p;
  const loader = new THREE.TextureLoader();
  const tex = {};
  await Promise.all(names.map(async n => {
    const t = await loader.loadAsync(M[n] ? M[n].url : `${dir}/${n}.png`);
    t.colorSpace = linear.includes(n) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
    tex[n] = t;
  }));
  return { meta: M, tex };
}

// 底板本身已经画好了空气透视，所以不吃雾、不做色调映射
export function plateMat(map, { opacity = 1, depthTest = true, color = 0xffffff, blending = THREE.NormalBlending, side = THREE.FrontSide } = {}) {
  return new THREE.MeshBasicMaterial({ map, color, transparent: true, opacity, depthWrite: false, depthTest, toneMapped: false, fog: false, blending, side });
}
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
const flat = (m, order) => { m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false; return m; };
export function plate(map, order, o = {}) {
  const m = flat(new THREE.Mesh(UNIT_PLANE, plateMat(map, o)), order);
  m.userData.aspect = map.image.width / map.image.height;
  return m;
}

export function plateCopy(map, { wrap = false } = {}) {
  const t = map.clone();
  if (wrap) t.wrapS = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
export const tileRepeat = (map, wpx, hpx) => wpx / (hpx * (map.image.width / map.image.height));

export function canvasLayer(w, h) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  return { canvas, ctx: canvas.getContext('2d'), tex };
}

// ── 裁切软边面片 ── rect = [u0, v0, du, dv]（贴图 uv，v 向上）；soft = 椭圆遮罩从多大开始变软（0..1）
const UV_VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const CROP_FS = /* glsl */`
uniform sampler2D map; uniform vec4 rect; uniform float opacity, soft, flip; uniform vec3 tint;
varying vec2 vUv;
void main(){
  vec2 q = vec2(flip > .5 ? 1. - vUv.x : vUv.x, vUv.y);
  vec4 c = texture2D(map, rect.xy + q * rect.zw);
  vec2 d = (vUv - .5) * 2.;
  float m = 1. - smoothstep(soft, 1., length(d * vec2(1., 1.15)));
  gl_FragColor = vec4(c.rgb * tint, c.a * m * opacity);
  #include <colorspace_fragment>
}`;
export function cropPlate(map, rect, { order = 5, opacity = 1, soft = 0.55, flip = false, tint = [1, 1, 1] } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, rect: { value: new THREE.Vector4(...rect) }, opacity: { value: opacity }, soft: { value: soft }, flip: { value: flip ? 1 : 0 }, tint: { value: new THREE.Vector3(...tint) } },
    vertexShader: UV_VS, fragmentShader: CROP_FS, transparent: true, depthWrite: false, toneMapped: false,
  });
  const m = flat(new THREE.Mesh(UNIT_PLANE, mat), order);
  m.userData.aspect = (map.image.width * rect[2]) / (map.image.height * rect[3]);
  return m;
}

// ── 抠像面片 ── 彩色层正常透明混合（边缘柔和）；遮罩层只在 alpha > cut 处写深度，后期的 Kuwahara 据此给前景小笔触、背景大笔触
export function cutoutPlane(tex, { order = 10, cut = 0.5 } = {}) {
  const g = new THREE.Group();
  const color = flat(new THREE.Mesh(UNIT_PLANE, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false, premultipliedAlpha: false })), order);
  const mask = flat(new THREE.Mesh(UNIT_PLANE, new THREE.MeshBasicMaterial({ map: tex, alphaTest: cut, colorWrite: false, depthWrite: true, fog: false })), order - 0.5);
  mask.userData.outlineOccluder = false;
  g.add(mask, color);
  g.userData.outline = false;
  return g;
}

// ── 加色辉光 ──
const GLOW_FS = /* glsl */`
uniform vec3 color; uniform float amt, core, squash;
varying vec2 vUv;
void main(){
  vec2 d = (vUv - .5) * 2.; d.y *= squash;
  float r = length(d);
  float g = exp(-r * r * 3.2) * .65 + exp(-r * r * 22.) * core + pow(max(1. - r, 0.), 3.) * .25;
  gl_FragColor = vec4(color * g * amt, 1.);
}`;
export function glowSprite(color, { order = 3, amt = 1, core = 1, squash = 1 } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, amt: { value: amt }, core: { value: core }, squash: { value: squash } },
    vertexShader: UV_VS, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  return flat(new THREE.Mesh(UNIT_PLANE, mat), order);
}
