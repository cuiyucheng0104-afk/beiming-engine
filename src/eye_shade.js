// src/eye_shade.js — 鲲眼珠着色器的共用片段（kun.js 与 kun_refine / kun_qinglv / kun_xuan / kun_bronze 共用）。
// 眼珠材质的片元钩子在“眼窝坐标”里画：d = normalize( vToonObj )，+Z 朝外；高光方向、眼睑边缘平面由 engine/form/eye.js
// 的 poseEyes 每帧写进 uniform（uCatch1 / uCatch2 / uLidU / uLidL）。各变体的虹膜、瞳孔、倒影各画各的，下面两样是共同的：
//   eyeCatch( d, c1, c2 )                   两个高光点（xyz = 方向，w = cos 半径），返回高光覆盖 0..1（抗锯齿边）
//   eyeLidLines( du, dl, front, lashW, lowW ) 上眼睑下沿的睫毛阴影带（中间粗、两头细，宽 lashW）与下眼睑上沿的细线（宽 lowW）
//                                           du / dl = d 到上 / 下眼睑边缘平面的有符号距离，front = 朝外程度；返回 vec2( lash, low )
// 用法：材质的 fragmentPars 末尾接上 EYE_GLSL（在 #include <common> 之后、全局作用域里）。
export const EYE_GLSL = /* glsl */`
float eyeCatch( vec3 d, vec4 c1, vec4 c2 ) {
  float a = dot( d, c1.xyz ), b = dot( d, c2.xyz );
  float fc = max( fwidth( a ), 1e-5 );
  return max( smoothstep( c1.w - fc, c1.w + fc, a ), smoothstep( c2.w - fc, c2.w + fc, b ) );
}
vec2 eyeLidLines( float du, float dl, float front, float lashW, float lowW ) {
  float fd = max( fwidth( du ), 1e-5 );
  float lash = ( 1.0 - smoothstep( lashW * front + 0.02 - fd, lashW * front + 0.02 + fd, - du ) ) * front;
  float low = ( 1.0 - smoothstep( lowW - fd, lowW + fd, - dl ) ) * front;
  return vec2( lash, low );
}
`;
