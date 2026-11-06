// 北冥引擎 · 后期调试视图：把一张中间缓冲画到屏幕 / 目标上看。
//
//   DEBUG_VIEWS            可选的视图名
//   createDebugView(fx) → {
//     render(mode, buffers, camera, target)
//       mode     'id'（ID 按色相）| 'depth'（对数深度）| 'edge'（强度/半线宽/深度差）| 'line'（墨线，白底黑线）
//                | 'bloom'（×4 提亮）| 'paper' | 'kuwahara' | 'scene'（线性 HDR 原样）；其它 = buffers.kuwahara
//       buffers  { id, depth, edge, line, bloom, paper, kuwahara, scene }：各视图对应的纹理
//     dispose()
//   }

const DEBUG_FS = /* glsl */`
#include <packing>
uniform sampler2D tA; uniform int uMode; uniform float uNear, uFar, uScale;
varying vec2 vUv;
vec3 hue(float x){ return clamp(abs(fract(x + vec3(0., 2., 1.) / 3.) * 6. - 3.) - 1., 0., 1.); }
void main(){
  vec4 a = texture2D(tA, vUv);
  vec3 c = a.rgb;
  if (uMode == 1) { float id = a.x + a.y * 2048.; c = id < .5 ? vec3(0.) : hue(fract(id * .61803)) * (.5 + .5 * a.w); }     // id
  else if (uMode == 2) { float z = -perspectiveDepthToViewZ(a.x, uNear, uFar); c = vec3(1. - clamp(log(z) / log(uFar), 0., 1.)); }  // 深度
  else if (uMode == 3) { c = vec3(a.x, a.y / 6., a.z); }          // 边缘：强度 / 半线宽 / 深度差
  else if (uMode == 4) { c = vec3(1. - a.r); }                    // 线
  else if (uMode == 5) { c = a.rgb * uScale; }                     // bloom / 线性图
  else if (uMode == 6) { c = a.rrr; }                              // 纸纹
  gl_FragColor = vec4(c, 1.);
}`;

const MODES = { id: 1, depth: 2, edge: 3, line: 4, bloom: 5, paper: 6, kuwahara: 0, scene: 5 };
export const DEBUG_VIEWS = Object.keys(MODES);

export function createDebugView(fx) {
  const mat = fx.material(DEBUG_FS, { tA: { value: null }, uMode: { value: 0 }, uNear: { value: .1 }, uFar: { value: 100 }, uScale: { value: 1 } });
  function render(mode, buffers, camera, target) {
    const d = mat.uniforms; d.uNear.value = camera.near; d.uFar.value = camera.far;
    const known = Object.hasOwn(MODES, mode);
    d.tA.value = known ? buffers[mode] : buffers.kuwahara; d.uMode.value = known ? MODES[mode] : 0;
    d.uScale.value = mode === 'bloom' ? 4 : 1;
    fx.draw(mat, target);
  }
  return { render, dispose() { mat.dispose(); } };
}
