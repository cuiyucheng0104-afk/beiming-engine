// 《豹变》D 雾山 · 手绘卡片（第三轮返修 4 新增，PLAN WP-02 第 5 条）
//   画出来的东西用画：云、云海、山带、崖壁、暗岩、笔触都是 Magpie 手绘的透明底卡片，代码只管摆放、视差、调色和遮挡。
//   · 颜色层：透明混合、不写深度；按贴图 alpha 抠，可裁切（像素框）、水平翻转
//   · 调色：暗档 / 亮档分别乘色（uLoC / uHiC，按明度 0.25–0.75 过渡），整体乘 uMul、饱和 uSat，
//           雾：uHazeAmt 整体 + uHazeLow 从卡片下沿往上（雾吃山脚），可只吃下部 uHazeH（相对高度）
//   · 遮罩层（可选）：只写深度（alpha × op > uMaskThr），让 look 的雾、Kuwahara、描线、雨按真实深度处理
//   · 四边渐隐：uFade = 左、右、下、上（相对宽高），免得裁切边露出一条直线
import * as THREE from 'three';
import { GLSL } from './glsl.js';
import { lin3 } from './util.js';

const VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const FS = /* glsl */`
${GLSL}
uniform sampler2D uMap; uniform vec4 uCrop; uniform float uFlip, uOp, uSat, uBias, uA0, uA1, uHazeAmt, uHazeLow, uHazeH, uGrad;
uniform vec3 uMul, uLoC, uHiC, uHaze, uLift, uGradC; uniform vec4 uFade;
varying vec2 vUv;
void main(){
  vec2 q = vUv; if (uFlip > .5) q.x = 1. - q.x;
  vec2 uv = uCrop.xy + q * uCrop.zw;
  vec4 c = texture2D(uMap, uv, uBias);
  float a = smoothstep(uA0, uA1, c.a);
  a *= smoothstep(0., uFade.x + 1e-4, vUv.x) * smoothstep(1., 1. - uFade.y - 1e-4, vUv.x) * smoothstep(0., uFade.z + 1e-4, vUv.y) * smoothstep(1., 1. - uFade.w - 1e-4, vUv.y);
  a *= uOp;
  if (a < .004) discard;
  vec3 s = c.rgb; float l = lumS(s);
  s = mix(vec3(l), s, uSat);
  vec3 col = srgb2lin(s);
  col *= mix(uLoC, uHiC, smoothstep(.25, .75, l));
  col = col * uMul + uLift;
  // 竖向渐变染色（例如云底压暗青、云顶留金）：uGrad = 强度，按卡片高度从下往上
  col = mix(col, col * uGradC, uGrad * (1. - smoothstep(.0, .75, vUv.y)));
  float hz = clamp(uHazeAmt + uHazeLow * (1. - smoothstep(0., max(uHazeH, 1e-3), vUv.y)), 0., 1.);
  col = mix(col, uHaze, hz);
  gl_FragColor = vec4(col, a);
}`;
const FS_MASK = /* glsl */`
uniform sampler2D uMap; uniform vec4 uCrop; uniform float uFlip, uOp, uMaskThr; varying vec2 vUv;
void main(){ vec2 q = vUv; if (uFlip > .5) q.x = 1. - q.x; if (texture2D(uMap, uCrop.xy + q * uCrop.zw).a * uOp < uMaskThr) discard; gl_FragColor = vec4(0.); }`;

// 像素框（原图，y 向下）→ uCrop（u0, v0, du, dv；v 从下往上）
export const cropPx = (tex, x0, y0, x1, y1) => { const W = tex.image.width, H = tex.image.height; return [x0 / W, 1 - y1 / H, (x1 - x0) / W, (y1 - y0) / H]; };

export function card(tex, { order = 10, depth = false, crop = null, maskThr = .35, depthTest = true } = {}) {
  const u = {
    uMap: { value: tex }, uCrop: { value: new THREE.Vector4(0, 0, 1, 1) }, uFlip: { value: 0 }, uOp: { value: 1 }, uSat: { value: 1 }, uBias: { value: 0 },
    uA0: { value: .04 }, uA1: { value: .9 }, uHazeAmt: { value: 0 }, uHazeLow: { value: 0 }, uHazeH: { value: .35 }, uGrad: { value: 0 },
    uMul: { value: new THREE.Vector3(1, 1, 1) }, uLoC: { value: new THREE.Vector3(1, 1, 1) }, uHiC: { value: new THREE.Vector3(1, 1, 1) },
    uHaze: { value: lin3('#E6EEE6') }, uLift: { value: new THREE.Vector3() }, uGradC: { value: new THREE.Vector3(1, 1, 1) }, uFade: { value: new THREE.Vector4(0, 0, 0, 0) }, uMaskThr: { value: maskThr },
  };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, depthTest, side: THREE.DoubleSide }));
  m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false; m.userData.outlineOccluder = false; m.userData.u = u;
  if (depth) {
    const mk = new THREE.Mesh(m.geometry, new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS, fragmentShader: FS_MASK, colorWrite: false, depthWrite: true, side: THREE.DoubleSide }));
    mk.renderOrder = order - .5; mk.frustumCulled = false; mk.userData.outline = false; mk.userData.outlineOccluder = false; m.add(mk); m.userData.mask = mk;
  }
  m.userData.setCrop = cr => { u.uCrop.value.set(...cr); m.userData.aspect = (cr[2] * tex.image.width) / (cr[3] * tex.image.height); };
  m.userData.setCrop(crop || [0, 0, 1, 1]);
  return m;
}
// 调色：{ mul, lo, hi, haze, hazeAmt, hazeLow, hazeH, sat, op, grad, gradC, lift }（颜色用 #hex 或 [r,g,b] 线性）
const v3set = (v, x) => { if (typeof x === 'string') v.copy(lin3(x)); else v.set(x[0], x[1], x[2]); };
export function cardCol(m, o) {
  const u = m.userData.u;
  if (o.mul !== undefined) v3set(u.uMul.value, o.mul); if (o.lo !== undefined) v3set(u.uLoC.value, o.lo); if (o.hi !== undefined) v3set(u.uHiC.value, o.hi);
  if (o.haze !== undefined) v3set(u.uHaze.value, o.haze); if (o.gradC !== undefined) v3set(u.uGradC.value, o.gradC); if (o.lift !== undefined) v3set(u.uLift.value, o.lift);
  for (const [k, n] of [['hazeAmt', 'uHazeAmt'], ['hazeLow', 'uHazeLow'], ['hazeH', 'uHazeH'], ['sat', 'uSat'], ['op', 'uOp'], ['grad', 'uGrad'], ['bias', 'uBias']]) if (o[k] !== undefined) u[n].value = o[k];
  if (o.fade) u.uFade.value.set(...o.fade);
  if (o.flip !== undefined) u.uFlip.value = o.flip ? 1 : 0;
}
// 世界里正对相机的公告板（中心 pos、宽 w 米，高按裁切比例）
export function billCard(m, cam, pos, w, flipX = false) { m.position.copy(pos); m.quaternion.copy(cam.quaternion); m.scale.set(w, w / m.userData.aspect, 1); m.userData.u.uFlip.value = flipX ? 1 : 0; }
