// 北冥 A 路线模版水面材质（routes/a-webgl/template/world.js）。保留天空倒影、碎波和日光，去掉孤峰反射。
import * as THREE from 'three';
import { project } from '../../engine/stage/camera.js';

const WATER_VS = `varying vec3 vW; varying vec4 vClip;
void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vClip = projectionMatrix * viewMatrix * w; gl_Position = vClip; }`;
const WATER_FS = `
uniform vec3 uNear, uMid, uFar, uSun, uCam; uniform float uTime, uSunAz, uSunUp, uSeed, uHeld, uSkyFlip;
uniform sampler2D uSky; uniform vec4 uSkyRect; uniform vec3 uView;   // 天空底板在设计稿上的矩形 (左, 上, 宽, 高)；(设计宽, 设计高, 地平线 y)
varying vec3 vW; varying vec4 vClip;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21) + uSeed); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
void main(){
  vec3 d = vW - uCam; float dist = length(d.xz);
  float k = smoothstep(80., 4500., dist);                 // 0 近 → 1 远
  vec3 body = mix(uNear, uMid, smoothstep(0., .6, k));    // 看进水里的颜色：近暗远亮
  // 波纹：r1 长涌、r2 碎波，随 uTime 流动（一拍一）；r3 只给倒影的扰动，随拍号 uHeld 跳（一拍二）
  float r1 = vn(vec2(vW.x * .004, vW.z * .06 + uTime * .1));
  float r2 = vn(vec2(vW.x * .018 + 7., vW.z * .22 - uTime * .25));
  float r3 = vn(vec2(vW.x * .045 + 3., vW.z * .5 + uHeld * 1.7));
  // 地平线镜像：屏幕上离地平线 below 像素的点，倒影取天空里地平线以上 below 像素处的颜色；越近被波纹拉得越碎
  vec2 ndc = vClip.xy / vClip.w;
  vec2 px = vec2((ndc.x * .5 + .5) * uView.x, (.5 - ndc.y * .5) * uView.y);
  float below = max(0., px.y - uView.z), wob = (r2 - .5) * .8 + (r3 - .5) * .7;
  float my = uView.z - below * (1. + .45 * wob * (1. - .6 * k)), mx = px.x + (r3 - .5) * 16. * (1. - k);
  vec2 suv = vec2((mx - uSkyRect.x) / uSkyRect.z, 1. - (my - uSkyRect.y) / uSkyRect.w);
  if (uSkyFlip > .5) suv.x = 1. - suv.x;
  vec3 sky = texture2D(uSky, clamp(suv, vec2(.002), vec2(.998))).rgb;
  float fr = mix(.38, .88, smoothstep(.0, .65, k));       // 反射比例：远处近乎镜面，近处看得进水里（菲涅耳的画法近似）
  vec3 col = mix(body, sky * mix(vec3(.74, .72, .88), vec3(.94, .93, .98), k), fr);
  // 碎波：横向短条的亮与暗（不是贯穿整幅的长线），越远越密越淡
  float lite = smoothstep(.7, .88, r1 * .45 + r2 * .55) * smoothstep(.4, .7, r3);
  float dark = smoothstep(.64, .86, 1. - (r1 * .55 + r2 * .45)) * smoothstep(.3, .6, r3);
  float fade = 1. - k * .7;
  col = mix(col, mix(uMid, uFar, .55) * 1.12, lite * .4 * fade);
  col = mix(col, body * .82, dark * .38 * fade);
  // 太阳倒影：方位接近太阳的一条竖带，近宽远窄，碎成横向的闪；日出后才亮（uSunUp 0→1）
  float az = atan(d.x, -d.z);
  float band = exp(-pow((az - uSunAz) / (.005 + .05 * (1. - k)), 2.));
  float glit = smoothstep(.48, .78, vn(vec2(vW.x * .06, vW.z * .55 + uTime * .9))) * smoothstep(.3, .6, r3);
  col += uSun * band * (.22 + 1.15 * glit) * uSunUp * (.55 + .45 * k);
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;
// sky：天空底板贴图（loadPlate 读的那张）；skyRect：它在起始机位下摆在设计稿上的矩形 [左, 上, 宽, 高]（与 placeOnScreen 同一组数）
export function buildWater({ sky, skyRect, DW, DH }) {
  const flip = sky.repeat.x < 0 ? 1 : 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNear: { value: new THREE.Color('#29484a') }, uMid: { value: new THREE.Color('#648b83') }, uFar: { value: new THREE.Color('#c2c6a2') },
      uSun: { value: new THREE.Color('#ffa45c') }, uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 }, uSunAz: { value: 0 }, uSunUp: { value: 0 }, uSeed: { value: 0.37 }, uHeld: { value: 0 },
      uSky: { value: sky }, uSkyFlip: { value: flip }, uSkyRect: { value: new THREE.Vector4(...skyRect) }, uView: { value: new THREE.Vector3(DW, DH, DH * 0.7) },
    },
    vertexShader: WATER_VS, fragmentShader: WATER_FS, toneMapped: false, fog: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), mat);
  m.userData.outline = false;      // 水面不描边（否则地平线会被描成一条墨线）
  m.receiveShadow = false;
  return m;
}
// 每帧更新水面：相机位置、时间、拍号、地平线（水平方向无穷远处在屏幕上的 y，倒影按它镜像）
const _hz = new THREE.Vector3();
export function waterFrame(water, cam, DW, DH, { t, held, sunAz, sunUp }) {
  const u = water.material.uniforms;
  u.uCam.value.copy(cam.position); u.uTime.value = t; u.uHeld.value = held; u.uSunAz.value = sunAz; u.uSunUp.value = sunUp;
  const fwd = cam.getWorldDirection(_hz); fwd.y = 0; fwd.normalize();
  u.uView.value.z = project(cam, DW, DH, fwd.multiplyScalar(1e7).add(cam.position)).y;
}
