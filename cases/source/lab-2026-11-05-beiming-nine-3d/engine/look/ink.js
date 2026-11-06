// 北冥引擎 · 屏幕空间手绘墨线：ID 图 + 深度 → 边缘（近的一侧拥有这条线）→ 笔画（圆头笔 + 域扭曲抖动 + 笔压 + 断线）。
// 抖动的种子 = floor(t * boilFps)，同一拍内线不动、换拍整体「沸腾」一次（boilFps 12 即一拍二）。
//
//   createInk(fx) → {
//     render({ ids, edge, line, camera, p, fog, fogColor, t, k, ss, maxWidth })
//       ids        ID 图渲染目标（createIdPass 的输出，带 depthTexture）
//       edge/line  边缘图（Nearest，HalfFloat）/ 笔画覆盖率图，和 ID 图同尺寸
//       p          墨线参数（见下）；fog：雾参数或 null（线在雾里按 fogFade 变淡）
//       k          像素缩放（输出高度 / 标定高度）；ss：ID 图相对输出的超采样倍数；maxWidth：场景里最大的线宽系数
//     dispose()
//   }
//
// 墨线参数 p（像素量按标定高度给，内部乘 k·ss）：
//   width 外轮廓线宽  wobble 抖动幅度  warp 抖动波长  boilFps 沸腾频率  pressure 笔压起伏（±比例）  breakup 断线阈值
//   inner 内部线相对外轮廓的粗细  silhouette 深度相对差大于它算外轮廓  depthThreshold 1/z 二阶差分的折痕阈值
//   near / far / farScale 线宽随深度变细的区间与远处系数  opacity 不透明度  fogFade 雾里变淡的程度
// 墨色叠加（color / tint / darken）在合成那一步，见 compose.js。

import * as THREE from 'three';
import { HASH_NOISE } from './glsl.js';
import { FOG_GLSL, fogUniforms, setFog } from './fog.js';

// 边缘检测：ID 跳变 + 深度断层 / 折痕；输出 (浓度, 半线宽, 深度差, 1)
const EDGE_FS = /* glsl */`
#include <packing>
${FOG_GLSL}
uniform sampler2D tId, tDepth;
uniform vec2 uRes;
uniform float uNear, uFar, uOrtho;
uniform float uHalfW, uDepthThr, uInner, uSil, uOpacity, uFogFade;
uniform vec3 uWD;    // x 近, y 远, z 远处线宽系数
float lz(ivec2 p){ float d = texelFetch(tDepth, p, 0).x; return uOrtho > .5 ? -orthographicDepthToViewZ(d, uNear, uFar) : -perspectiveDepthToViewZ(d, uNear, uFar); }
float gid(ivec2 p){ vec2 s = texelFetch(tId, p, 0).xy; return s.x + s.y * 2048.; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uRes) - 1;
  vec4 s0 = texelFetch(tId, p, 0);
  float id0 = s0.x + s0.y * 2048.;
  if (id0 < .5 || s0.w < .002) { gl_FragColor = vec4(0.); return; }
  float z0 = lz(p), iz0 = 1. / z0;
  float edge = 0., gap = 0.;
  // ① ID 跳变（4 邻域）。只有更近（或一样近）的一侧画线
  ivec2 N4[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int k = 0; k < 4; k++) {
    ivec2 q = clamp(p + N4[k], ivec2(0), mx);
    float idq = gid(q);
    if (abs(idq - id0) > .5) {
      float z = lz(q), rel = (z - z0) / z0;
      // 近的一侧拥有；两个部件互相穿插、深度几乎一样时，固定让 ID 大的一侧画，避免两边轮流画出锯齿双线
      if (rel > .002 || (rel > -.002 && id0 > idq)) { edge = 1.; gap = max(gap, rel); }
    }
  }
  // ② 深度断层 / 折痕：1/z 的二阶差分（平面上恒为 0，掠射的地面不会误报）；只在近的一侧出线
  ivec2 AX[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(1, 1), ivec2(1, -1));
  for (int k = 0; k < 4; k++) {
    float zp = lz(clamp(p + AX[k], ivec2(0), mx)), zm = lz(clamp(p - AX[k], ivec2(0), mx));
    float lap = (1. / zp + 1. / zm - 2. * iz0) / iz0;
    if (lap < -uDepthThr) { edge = 1.; gap = max(gap, max(zp, zm) / z0 - 1.); }
  }
  if (edge < .5) { gl_FragColor = vec4(0.); return; }
  // 线的浓淡：物体给的可见度（被半透明物体挡住会变小）× 雾
  vec2 uv = (vec2(p) + .5) / uRes;
  vec3 vp = viewPosAt(uv, texelFetch(tDepth, p, 0).x);
  vec3 wp = (uCamWorld * vec4(vp, 1.)).xyz;
  float f = fogAmount(length(vp), wp.y);
  float strength = clamp(s0.w, 0., 1.) * uOpacity * (1. - uFogFade * f);
  // 半线宽（ID 图像素）：基础 × 物体系数 × 随深度变细 × 内部线更细
  float hw = uHalfW * s0.z * mix(1., uWD.z, smoothstep(uWD.x, uWD.y, z0)) * (gap > uSil ? 1. : uInner);
  gl_FragColor = vec4(strength, hw, gap, 1.);
}`;

// 笔画：以边缘像素为圆心画圆头笔，查找坐标做低频域扭曲（抖动）；SR = 搜索半径（编译期常量）
const STROKE_FS = /* glsl */`
${HASH_NOISE}
uniform sampler2D tEdge;
uniform vec2 uRes;
uniform float uWobble, uWarp, uPressure, uBreakup, uSeed;
void main(){
  vec2 c = gl_FragCoord.xy;
  uint sd = uint(uSeed) * 7919u + 13u;
  vec2 q = c;
  if (uWobble > 0.) {
    vec2 a = c / uWarp;
    q += (vec2(vnoise(a, sd), vnoise(a + 31.7, sd + 1u)) * 2. - 1.) * uWobble;
    vec2 b = c / (uWarp * .31);
    q += (vec2(vnoise(b, sd + 2u), vnoise(b + 13.1, sd + 3u)) * 2. - 1.) * uWobble * .3;
  }
  // 笔压：沿线粗细起伏（低频噪声，和沸腾同一个种子）
  float pr = uPressure > 0. ? 1. + uPressure * (vnoise(q / (uWarp * .45), sd + 5u) * 2. - 1.) : 1.;
  ivec2 b0 = ivec2(floor(q)), mx = ivec2(uRes) - 1;
  float cov = 0.;
  for (int j = -SR; j <= SR; j++) {
    for (int i = -SR; i <= SR; i++) {
      ivec2 e = b0 + ivec2(i, j);
      if (any(lessThan(e, ivec2(0))) || any(greaterThan(e, mx))) continue;
      vec4 E = texelFetch(tEdge, e, 0);
      if (E.x <= 0.) continue;
      float d = length(q - (vec2(e) + .5));
      cov = max(cov, clamp(E.y * pr + .5 - d, 0., 1.) * E.x);
    }
  }
  if (uBreakup > 0.) cov *= smoothstep(uBreakup - .1, uBreakup + .1, vnoise(q / (uWarp * .6), sd + 9u));
  gl_FragColor = vec4(cov, 0., 0., 1.);
}`;

export function createInk(fx) {
  const edgeMat = fx.material(EDGE_FS, { ...fogUniforms(), tId: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uNear: { value: .1 }, uFar: { value: 100 }, uOrtho: { value: 0 },
    uHalfW: { value: 2 }, uDepthThr: { value: .03 }, uInner: { value: .6 }, uSil: { value: .12 }, uOpacity: { value: 1 }, uFogFade: { value: 1 }, uWD: { value: new THREE.Vector3() } });
  const strokeMats = new Map();   // 搜索半径是编译期常量，按需要编译几个变体
  const strokeMat = R => {
    if (!strokeMats.has(R)) strokeMats.set(R, fx.material(STROKE_FS, { tEdge: { value: null }, uRes: { value: new THREE.Vector2() }, uWobble: { value: 1 }, uWarp: { value: 60 }, uPressure: { value: 0 }, uBreakup: { value: 0 }, uSeed: { value: 0 } }, { SR: R }));
    return strokeMats.get(R);
  };

  function render({ ids, edge, line, camera, p, fog, fogColor, t, k, ss, maxWidth }) {
    const LW = ids.width, LH = ids.height;
    const e = edgeMat.uniforms;
    e.tId.value = ids.texture; e.tDepth.value = ids.depthTexture; e.uRes.value.set(LW, LH);
    e.uNear.value = camera.near; e.uFar.value = camera.far; e.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
    const hw = p.width * .5 * k * ss;
    e.uHalfW.value = hw; e.uDepthThr.value = p.depthThreshold; e.uInner.value = p.inner; e.uSil.value = p.silhouette;
    e.uOpacity.value = p.opacity; e.uFogFade.value = fog ? p.fogFade : 0; e.uWD.value.set(p.near, p.far, p.farScale);
    setFog(e, fog, camera, fogColor);
    fx.draw(edgeMat, edge);
    const R = Math.min(8, Math.max(2, Math.ceil(hw * maxWidth * (1 + p.pressure) + 1)));
    const sm = strokeMat(R), s = sm.uniforms;
    s.tEdge.value = edge.texture; s.uRes.value.set(LW, LH);
    s.uWobble.value = p.wobble * k * ss; s.uWarp.value = p.warp * k * ss; s.uPressure.value = p.pressure; s.uBreakup.value = p.breakup;
    s.uSeed.value = Math.floor(t * p.boilFps + 1e-6) % 100000;
    fx.draw(sm, line);
  }

  return {
    render,
    dispose() { edgeMat.dispose(); for (const m of strokeMats.values()) m.dispose(); },
  };
}
