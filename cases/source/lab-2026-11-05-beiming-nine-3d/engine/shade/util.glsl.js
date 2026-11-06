// 北冥引擎 · 着色器小工具（GLSL 源码片段）：抗锯齿阈值、细线、填充、远景淡出、无切线凹凸。
// 宽度都按 fwidth 取像素，逐帧导出不闪；拼进片元着色器的函数区即可。
//
//   SS_GLSL             float toonSS( a, b, x )     边界顺序任意的 smoothstep（a > b 时反向）
//   LUM_GLSL            float toonLum( vec3 )       线性亮度（Rec.709）
//   AA_GLSL             float toonAA( t, x )        x 越过 t 时 0→1，过渡宽约 1.5 像素
//   lineGlsl(lo, hi)    float toonLine( d, w )      细线：d = 到线中心的距离，w = 半线宽；内外沿各留 lo / hi 个 fwidth 的过渡
//   FILL_GLSL           float toonFill( d )         d < 0 为内的抗锯齿填充
//   FAR_GLSL            float toonFar( q, lo, hi )  坐标 q 每像素变化超过 lo 开始淡出，到 hi 完全消失（远景细节不出摩尔纹）
//   bumpGlsl(name)      vec3 name( surfPos, surfNorm, dHdxy, faceDir )  不依赖切线的凹凸（屏幕导数法，Mikkelsen 2010）；
//                       dHdxy = 高度沿屏幕 x / y 每像素的变化（单位同位置），σ 不归一化，坡度与距离无关
//   glf(x)              JS 数 → GLSL 浮点字面量（1 → '1.0'）

export const glf = x => Number.isInteger(x) ? x.toFixed(1) : String(x);

export const SS_GLSL = /* glsl */`
float toonSS( float a, float b, float x ) { float t = clamp( ( x - a ) / ( b - a ), 0.0, 1.0 ); return t * t * ( 3.0 - 2.0 * t ); }
`;

export const LUM_GLSL = /* glsl */`
float toonLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
`;

export const AA_GLSL = /* glsl */`
float toonAA( float t, float x ) { float a = max( fwidth( x ), 1e-4 ) * 0.75; return smoothstep( t - a, t + a, x ); }
`;

export const lineGlsl = (lo = 1, hi = lo) => {
  const k = v => v === 1 ? 'f' : `f * ${glf(v)}`;
  return /* glsl */`
float toonLine( float d, float w ) { float f = max( fwidth( d ), 1e-5 ); return 1.0 - smoothstep( w - ${k(lo)}, w + ${k(hi)}, abs( d ) ); }
`;
};

export const FILL_GLSL = /* glsl */`
float toonFill( float d ) { float f = max( fwidth( d ), 1e-5 ); return 1.0 - smoothstep( -f, f, d ); }
`;

export const FAR_GLSL = /* glsl */`
float toonFar( vec2 q, float lo, float hi ) { vec2 w = fwidth( q ); return 1.0 - smoothstep( lo, hi, max( w.x, w.y ) ); }
`;

export const bumpGlsl = (name = 'toonBump') => /* glsl */`
vec3 ${name}( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
  vec3 sx = dFdx( surfPos ), sy = dFdy( surfPos );
  vec3 r1 = cross( sy, surfNorm ), r2 = cross( surfNorm, sx );
  float det = dot( sx, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
  return normalize( abs( det ) * surfNorm - grad );
}
`;
