// SPDX-License-Identifier: MIT
// Portions Copyright (c) 2014 David Hoskins — Hash without Sine（MIT，https://www.shadertoy.com/view/4djSRW），许可原文见本注释末尾
// 北冥引擎 · 着色器噪声（GLSL 源码片段）：确定性哈希、梯度噪声、fbm、二维 Voronoi。
// 全部是坐标的纯函数，没有时间和随机数，任意帧单独渲染结果一致。拼进片元着色器的函数区即可。
//
//   NOISE_GLSL           vec3 toonHash33( vec3 )  无正弦哈希 → [-1, 1]³
//                        float toonNoise( vec3 )  梯度噪声（五次插值）→ 约 [-1, 1]
//                        float toonFbm( vec3 )    4 层 fbm（倍频 2.03，每层错开）
//   HASH13_GLSL          float toonHash13( vec3 ) → [0, 1)
//   voronoiGlsl(name)    vec3 name( vec2 p )：x = 最近距离 F1，y = 次近 F2，z = 最近格子的哈希（0..1）；依赖 NOISE_GLSL
//
// 来源：toonHash33、toonHash13 的公式逐字取自 David Hoskins 的 Hash without Sine（hash33、hash13；toonHash33 另把结果映射到 [-1, 1]）；
//   toonNoise、toonFbm、voronoiGlsl 是本仓库自己写的。
// @provenance hash-without-sine (David Hoskins, 2014) https://www.shadertoy.com/view/4djSRW
// David Hoskins 部分的许可（MIT 原文，按其要求随这些部分一起分发）：
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//   The above copyright notice and this permission notice shall be included in all copies or substantial portions
//   of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
//   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.

export const NOISE_GLSL = /* glsl */`
vec3 toonHash33( vec3 p3 ) {
  p3 = fract( p3 * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yxx ) * p3.zyx ) * 2.0 - 1.0;
}
float toonNoise( vec3 p ) {
  vec3 i = floor( p ), f = fract( p );
  vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  float n000 = dot( toonHash33( i ), f );
  float n100 = dot( toonHash33( i + vec3( 1.0, 0.0, 0.0 ) ), f - vec3( 1.0, 0.0, 0.0 ) );
  float n010 = dot( toonHash33( i + vec3( 0.0, 1.0, 0.0 ) ), f - vec3( 0.0, 1.0, 0.0 ) );
  float n110 = dot( toonHash33( i + vec3( 1.0, 1.0, 0.0 ) ), f - vec3( 1.0, 1.0, 0.0 ) );
  float n001 = dot( toonHash33( i + vec3( 0.0, 0.0, 1.0 ) ), f - vec3( 0.0, 0.0, 1.0 ) );
  float n101 = dot( toonHash33( i + vec3( 1.0, 0.0, 1.0 ) ), f - vec3( 1.0, 0.0, 1.0 ) );
  float n011 = dot( toonHash33( i + vec3( 0.0, 1.0, 1.0 ) ), f - vec3( 0.0, 1.0, 1.0 ) );
  float n111 = dot( toonHash33( i + vec3( 1.0 ) ), f - vec3( 1.0 ) );
  return 1.6 * mix( mix( mix( n000, n100, u.x ), mix( n010, n110, u.x ), u.y ),
                    mix( mix( n001, n101, u.x ), mix( n011, n111, u.x ), u.y ), u.z );
}
float toonFbm( vec3 p ) {
  float s = 0.0, a = 0.5;
  for ( int k = 0; k < 4; k ++ ) { s += a * toonNoise( p ); p = p * 2.03 + vec3( 1.7, 9.2, 3.1 ); a *= 0.5; }
  return s;
}
`;

export const HASH13_GLSL = /* glsl */`
float toonHash13( vec3 p3 ) { p3 = fract( p3 * 0.1031 ); p3 += dot( p3, p3.zyx + 31.32 ); return fract( ( p3.x + p3.y ) * p3.z ); }
`;

export const voronoiGlsl = (name = 'toonVoronoi2') => /* glsl */`
vec3 ${name}( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for ( int y = - 1; y <= 1; y ++ ) for ( int x = - 1; x <= 1; x ++ ) {
    vec2 g = vec2( float( x ), float( y ) );
    vec3 h = toonHash33( vec3( i + g, 7.0 ) ) * 0.5 + 0.5;
    vec2 o = g + 0.15 + 0.7 * h.xy - f;
    float d = dot( o, o );
    if ( d < f1 ) { f2 = f1; f1 = d; id = h.z; } else if ( d < f2 ) { f2 = d; }
  }
  return vec3( sqrt( f1 ), sqrt( f2 ), id );
}
`;
