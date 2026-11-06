// src/scene.js — 合成用的通用件（合成与渲染总监）
//   · 底板加载（plates.json + 贴图设置）
//   · 2D 底板变成 3D 场景里的面片：按「起始机位下的屏幕像素 + 深度」摆放（镜头 A 的推镜由真实透视产生视差）
//   · 穹顶面片：按 水平角 / 仰角 把底板贴在以相机为心的球面上（镜头 C 摇镜时天空、天际线不变形、不穿帮）
//   · 云片（底板局部裁切 + 软边遮罩）、抠像面片（彩色层 + 只写深度的遮罩层，让后期按深度区分笔触大小）
//   · 太阳辉光、投影到屏幕的工具
// 确定性：这里没有任何随机数与时间读取，全部由调用方传 t。
import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const ss = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export const ss5 = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };   // 更柔的起止（镜头用）
export const eio = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export const eo = x => 1 - Math.pow(1 - clamp(x), 3);
// 整数帧哈希 → [0,1)（一拍二抖动等用）
export const hashi = n => { let h = (n | 0) * 374761393 + 668265263; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return (h >>> 0) / 4294967296; };

// ───────────────────────── 底板 ─────────────────────────
export async function loadPlates(names) {
  const meta = await (await fetch('./assets/plates/plates.json')).json();
  const M = {}; for (const p of meta.plates) M[p.name] = p;
  const loader = new THREE.TextureLoader();
  const tex = {};
  await Promise.all(names.map(async n => {
    const t = await loader.loadAsync(M[n] ? M[n].url : `./assets/plates/${n}.png`);
    t.colorSpace = n === 'paper' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
    tex[n] = t;
  }));
  return { meta: M, tex };
}

// 底板材质：直通 alpha、透明、不写深度、不受雾和色调映射影响（底板本身已经画好了空气透视）
export function plateMat(map, { opacity = 1, depthTest = true, color = 0xffffff, blending = THREE.NormalBlending, side = THREE.FrontSide } = {}) {
  return new THREE.MeshBasicMaterial({ map, color, transparent: true, opacity, depthWrite: false, depthTest, toneMapped: false, fog: false, blending, side });
}
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
export function plate(map, order, o = {}) {
  const m = new THREE.Mesh(UNIT_PLANE, plateMat(map, o));
  m.renderOrder = order; m.frustumCulled = false;
  m.userData.outline = false;
  m.userData.aspect = map.image.width / map.image.height;
  return m;
}

// 在相机 cam（世界矩阵已更新）的视锥里，把面片放到屏幕像素 (cx, cy)、宽 wpx（高 hpx 不给就按图的宽高比）、沿视线深度 D
export function placeOnScreen(mesh, cam, W, H, cx, cy, wpx, D, hpx) {
  const hh = D * Math.tan(cam.fov * DEG / 2), hw = hh * cam.aspect;
  const x = (cx / W - 0.5) * 2 * hw, y = (0.5 - cy / H) * 2 * hh;
  const w = wpx / W * 2 * hw, h = hpx !== undefined ? hpx / H * 2 * hh : w / (mesh.userData.aspect || 1);
  mesh.position.set(x, y, -D).applyMatrix4(cam.matrixWorld);
  cam.getWorldQuaternion(mesh.quaternion);
  mesh.scale.set(w, h, 1);
  return mesh;
}
// 屏幕像素 + 深度 → 世界坐标（摆 3D 物体用）
export function screenToWorld(cam, W, H, cx, cy, D, out = new THREE.Vector3()) {
  const hh = D * Math.tan(cam.fov * DEG / 2), hw = hh * cam.aspect;
  return out.set((cx / W - 0.5) * 2 * hw, (0.5 - cy / H) * 2 * hh, -D).applyMatrix4(cam.matrixWorld);
}
// 世界坐标 → 屏幕像素（z 为到相机平面的距离，<0 表示在相机后面）
const _pv = new THREE.Vector3(), _pc = new THREE.Vector3();
export function project(cam, W, H, p) {
  _pc.copy(p).applyMatrix4(cam.matrixWorldInverse);
  _pv.copy(p).project(cam);
  return { x: (_pv.x * 0.5 + 0.5) * W, y: (0.5 - _pv.y * 0.5) * H, z: -_pc.z };
}

// ───────────────────────── 穹顶面片 ─────────────────────────
// 以原点为心、半径 R 的一块球面。水平角 yaw：0 = -Z 方向，正值向左（与相机 rotation.y 同号）；仰角 pitch 向上为正。
// uv：画面左 → 右 u 0 → 1，下 → 上 v 0 → 1（贴图上边在高处）。挂到一个 Group 上，Group 放在相机位置附近即可。
export function domeGeo(R, yawC, yawSpan, pitchLo, pitchHi, sx = 64, sy = 48) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= sy; j++) {
    const v = j / sy, pit = lerp(pitchLo, pitchHi, v), cp = Math.cos(pit), sp = Math.sin(pit);
    for (let i = 0; i <= sx; i++) {
      const u = i / sx, yaw = yawC + yawSpan * (0.5 - u);
      pos.push(-Math.sin(yaw) * cp * R, sp * R, -Math.cos(yaw) * cp * R);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
    const a = j * (sx + 1) + i, b = a + 1, c = a + sx + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
export function domePlate(map, order, R, yawC, yawSpan, pitchLo, pitchHi, o = {}) {
  const m = new THREE.Mesh(domeGeo(R, yawC, yawSpan, pitchLo, pitchHi), plateMat(map, { side: THREE.DoubleSide, ...o }));
  m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false;
  return m;
}

// ───────────────────────── 云片：底板的一块 + 软边遮罩 ─────────────────────────
// rect = [u0, v0, du, dv]（贴图 uv，v 向上）；soft = 椭圆遮罩从多大开始变软（0..1）
const CLOUD_VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const CLOUD_FS = /* glsl */`
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
export function cloudPuff(map, rect, { order = 5, opacity = 1, soft = 0.55, flip = false, tint = [1, 1, 1] } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, rect: { value: new THREE.Vector4(...rect) }, opacity: { value: opacity }, soft: { value: soft }, flip: { value: flip ? 1 : 0 }, tint: { value: new THREE.Vector3(...tint) } },
    vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, transparent: true, depthWrite: false, toneMapped: false,
  });
  const m = new THREE.Mesh(UNIT_PLANE, mat);
  m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false;
  m.userData.aspect = (map.image.width * rect[2]) / (map.image.height * rect[3]);
  return m;
}

// ───────────────────────── 抠像面片：彩色层 + 深度遮罩 ─────────────────────────
// 彩色层正常透明混合（边缘柔和）；深度遮罩只写深度（alpha > cut 处），让 Kuwahara 按深度给人物 / 鸽子用小笔触，背景用大笔触。
export function cutoutPlane(tex, { order = 10, cut = 0.5 } = {}) {
  const g = new THREE.Group();
  const color = new THREE.Mesh(UNIT_PLANE, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false, premultipliedAlpha: false }));
  color.renderOrder = order; color.frustumCulled = false; color.userData.outline = false;
  const mask = new THREE.Mesh(UNIT_PLANE, new THREE.MeshBasicMaterial({ map: tex, alphaTest: cut, colorWrite: false, depthWrite: true, fog: false }));
  mask.renderOrder = order - 0.5; mask.frustumCulled = false; mask.userData.outline = false; mask.userData.outlineOccluder = false;
  g.add(mask, color);
  g.userData.outline = false;
  return g;
}

// ───────────────────────── 太阳辉光 / 加色光斑 ─────────────────────────
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
    vertexShader: CLOUD_VS, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const m = new THREE.Mesh(UNIT_PLANE, mat);
  m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false;
  return m;
}

// 相机：Euler YXZ（先偏航后俯仰，不会出现斜着的地平线）
export function aimCamera(cam, pos, yaw, pitch, roll = 0) {
  cam.position.copy(pos);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(pitch, yaw, roll);
  cam.updateMatrixWorld(true);
}
// 方向：yaw（左正）、pitch（上正）→ 单位向量
export function dirOf(yaw, pitch, out = new THREE.Vector3()) {
  return out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

// 给鲲的描边网格接上 look.js 的 ID 图：把 toon 材质里的顶点形变（脊柱弯曲、海草摆动）原样交给 ID 图
export function wireOutlines(root, { alpha = 1, group = null } = {}) {
  root.traverse(o => {
    if (!o.isMesh || !o.userData.outline) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const op = mat?.userData?.toonOpts;
    if (op && (op.vertexPars || op.vertexBegin || op.vertexMainStart)) {
      o.userData.outlineVertex = {
        head: op.vertexPars || '',
        body: (op.vertexMainStart || '') + '\n' + (op.vertexBegin || ''),
        uniforms: mat.userData.toon,
      };
    }
    o.userData.outlineWidth = o.userData.outlineWeight ?? 1;
    o.userData.outlineAlpha = alpha;
    if (group && o.userData.outlineId !== undefined && group[o.userData.outlineId]) o.userData.outlineGroup = group[o.userData.outlineId];
  });
}
