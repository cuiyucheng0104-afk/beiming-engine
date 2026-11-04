// 北冥引擎 · 空气透视雾（屏幕空间）：按深度重建视空间 / 世界坐标，雾量随真实距离和世界高度变化（越低越浓）。
// 墨线的边缘检测也用同一套公式让线在雾里变淡，所以雾的 GLSL 和 uniform 单独导出。
//
//   FOG_GLSL                     float fogAmount(dist, worldY)、vec3 fogColor(dirW)、vec3 viewPosAt(uv, depth)
//   fogUniforms()                上面这段要的 uniform 表
//   setFog(u, fog, camera, fallbackColor)   填 uniform；fog 为空 = 关（只更新相机矩阵）
//   createFogPass(fx) → { render(src, depthTex, fog, camera, target, fallbackColor) }   fx：createFullscreen 的返回
//
// fog 参数：{ color, colorHigh, density, start, max, baseHeight, falloff, cutoff, sky }
//   color / colorHigh  低处 / 高处（按视线仰角）雾色；没写 colorHigh 用 color，都没写用 fallbackColor
//   density .02  start 0  max 1     指数雾的密度、起始距离、最大浓度
//   baseHeight 0  falloff 0         高度衰减：worldY 高于 baseHeight 后按 exp(-Δy/falloff) 变稀；0 = 不按高度
//   cutoff 1e9                      更远的不加雾（给远处底板留原色）
//   sky 0                           清屏处（天空）的浓度系数

import * as THREE from 'three';
import { linVec } from './params.js';

export const FOG_GLSL = /* glsl */`
uniform vec4 uFogA;   // x 密度, y 起始距离, z 最大浓度, w 开关
uniform vec4 uFogB;   // x 基准高度, y 高度衰减(0=不按高度), z 截止距离(更远的不加雾,给远处底板留原色), w 天空(清屏处)浓度
uniform vec3 uFogLow, uFogHigh;   // 低处 / 高处（按视线仰角）雾色，线性
float fogAmount(float dist, float worldY){
  if (uFogA.w < .5 || dist > uFogB.z) return 0.;
  float dens = uFogA.x;
  if (uFogB.y > 0.) dens *= exp(-max(worldY - uFogB.x, 0.) / uFogB.y);
  return (1. - exp(-dens * max(dist - uFogA.y, 0.))) * uFogA.z;
}
vec3 fogColor(vec3 dirW){ return mix(uFogLow, uFogHigh, smoothstep(-.05, .35, dirW.y)); }
uniform mat4 uProjInv, uCamWorld;
vec3 viewPosAt(vec2 uv, float d){ vec4 v = uProjInv * vec4(uv * 2. - 1., d * 2. - 1., 1.); return v.xyz / v.w; }`;

export const fogUniforms = () => ({
  uFogA: { value: new THREE.Vector4() }, uFogB: { value: new THREE.Vector4() }, uFogLow: { value: new THREE.Vector3() }, uFogHigh: { value: new THREE.Vector3() },
  uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
});

export function setFog(u, fog, camera, fallbackColor = '#ffffff') {
  u.uProjInv.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
  if (!fog) { u.uFogA.value.set(0, 0, 0, 0); return; }
  u.uFogA.value.set(fog.density ?? .02, fog.start ?? 0, fog.max ?? 1, 1);
  u.uFogB.value.set(fog.baseHeight ?? 0, fog.falloff ?? 0, fog.cutoff ?? 1e9, fog.sky ?? 0);
  linVec(fog.color ?? fallbackColor, u.uFogLow.value); linVec(fog.colorHigh ?? fog.color ?? fallbackColor, u.uFogHigh.value);
}

const FOG_FS = /* glsl */`
${FOG_GLSL}
uniform sampler2D tColor, tDepth;
varying vec2 vUv;
void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  vec3 vp = viewPosAt(vUv, min(d, .9999999));
  vec3 wp = (uCamWorld * vec4(vp, 1.)).xyz;
  vec3 dirW = normalize((uCamWorld * vec4(vp, 0.)).xyz);
  float f = d >= .9999999 ? uFogB.w * uFogA.z : fogAmount(length(vp), wp.y);
  gl_FragColor = vec4(mix(col, fogColor(dirW), f), 1.);
}`;

export function createFogPass(fx) {
  const mat = fx.material(FOG_FS, { ...fogUniforms(), tColor: { value: null }, tDepth: { value: null } });
  return {
    render(src, depthTex, fog, camera, target, fallbackColor) {
      const u = mat.uniforms; u.tColor.value = src; u.tDepth.value = depthTex; setFog(u, fog, camera, fallbackColor);
      fx.draw(mat, target);
    },
    dispose() { mat.dispose(); },
  };
}
