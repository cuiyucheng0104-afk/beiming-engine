// 玄鲲专用卡通材质（在 toon.js 三渲二配方上加三样：金箔、墨玉光泽、丝绸透光）
// 和 toon.js 的关系：
//   · 全场共享参数 TOON_SHARED（输出模式 uToonPass、墨线时钟、城市光 / 天空光方向）直接从 toon.js 引用同一个对象，
//     合成代理照旧调 toon.js 的 setToonGlobals，本模块的材质一起生效 —— 换进正片只改 import。
//   · 分档、投影量化、Ap 背光边缘光、城市暖光、天空冷光、斑块噪声这些公式照搬 toon.js（三色 + 双羽化）。
//   · 物体 ID 从 4001 起编，避免和 toon.js 的材质撞号（撞号会让两物体之间的 ID 描边消失）。
// 新增（片元钩子 fragmentAlbedo 里可写的变量，默认 0）：
//   toonMetal  0..1  金箔：暖色阴影档（不发灰发蓝）+ 按反射方向分三档的“金面”（朝天亮、朝地暗）+ 硬边闪光
//   toonGloss  0..1  墨玉 / 漆面：反射天空的一条硬边亮带 + 主光硬边高光
//   toonTrans  0..1  丝绸：光在面的另一侧时透出暖光（两档量化），正对太阳方向再亮一档
//   diffuseColor.a   彩色通道的不透明度（透明材质用）；法线 / ID 通道里不起作用
// 透明材质（opts.translucent = true）：彩色通道正常混合、不写深度；法线 / ID 通道自动切成不混合、写深度
//   （在 material.onBeforeRender 里按 uToonPass 切换），ID 图不会被半透明污染，描边照常。
// 所有噪声是坐标的纯函数，没有时间和随机数；任意帧单独渲染结果一致。
import * as THREE from 'three';
import { TOON_SHARED, PALETTE, tintFrom, setToonGlobals } from './toon.js';
export { TOON_SHARED, PALETTE, tintFrom, setToonGlobals };

// —— 玄鲲色板 ——
export const XUAN = {
  jade: '#3a3956',        // 墨玉（玄青）：亮面
  jadeShade1: '#252541',
  jadeShade2: '#17172d',
  smoke: '#5d5a7e',       // 黑白交界的烟色过渡
  belly: '#ece8f1',       // 月白腹
  bellyShade1: '#b2abca',
  scaleGold: '#d9bd7c',   // 腹鳞淡金
  gold: '#e3b85a',        // 描金
  goldDeep: '#7a5422',    // 金里的勾线（赭）
  goldLight: '#fff0c2',   // 金的闪光
  cinnabar: '#e0452c',    // 朱砂
  silk: '#f3eff6',        // 月白绸
  silkHem: '#e7bd62',     // 绸边金
  sheen: '#7b7fa6',       // 墨玉反射天空的亮带
  ink: PALETTE.ink,
};

const T1 = tintFrom(XUAN.belly, XUAN.bellyShade1);

export const XUAN_DEFAULTS = {
  color: '#ffffff',
  shade1: null, shade2: null,
  shade1Tint: T1, shade2Tint: tintFrom(XUAN.belly, '#7d7699'),
  litTint: [1, 1, 1],
  step1: 0.53, feather1: 0.02,
  step2: 0.18, feather2: 0.03,
  shadowDepth: 0.5, castShade: 1,
  shadowLo: 0.42, shadowHi: 0.58,
  edgeNoise: 0.03, edgeNoiseScale: 0.06,
  rimColor: PALETTE.pink, rimAmt: 0.6, rimPower: 0.4, rimInside: 0.3, rimDirK: 0.5,
  rimLitColor: PALETTE.kunRim, rimLitAmt: 1, rimLitInside: 0.1, rimLitPower: 0.55, rimLitDirK: 0.55,
  cityColor: PALETTE.kunBelly, cityAmt: 0.9, cityStep: 0.6, cityStep2: 0.94, cityW1: 0.42, cityFlat: 0.55,
  skyTint: [0.8, 0.88, 1.18], skyAmt: 0.7,
  patchScale: 0.05,
  rustColor: PALETTE.rust, rustAmt: 0, rustThr: 0.1,
  algaeColor: '#5f7f74', algaeAmt: 0, algaeThr: 0.28,
  spotColor: PALETTE.ink, spotAmt: 0, spotThr: 0.5, spotScale: 6,
  dabAmt: 0, dabScale: 1.2,
  inkColor: PALETTE.ink,
  outlineW: 1, instanceId: true,
  side: THREE.FrontSide, fog: true,
  // 金箔（toonMetal）：三档反射色（乘法色调，线性空间）+ 硬边闪光
  metLit: [1.12, 1.04, 0.92], metS1: [0.66, 0.52, 0.36], metS2: [0.34, 0.24, 0.16],
  metR1: -0.25, metR2: 0.42, metShade: 0.8,
  glintColor: XUAN.goldLight, glintThr: 0.975, glintAmt: 1,
  // 墨玉（toonGloss）：反射天空的亮带 + 主光高光
  sheenColor: XUAN.sheen, sheenThr: 0.6, sheenAmt: 0.0,
  glossColor: '#b9bde0', glossThr: 0.992, glossAmt: 0.0,
  // 丝绸（toonTrans）：透射色调（乘基色）与阈值
  transA: [1.06, 0.98, 0.92], transB: [1.26, 0.97, 0.74], transThr: 0.06, transHot: 0.8, transShadow: 0.4,
  translucent: false,
};

export const XUAN_PRESETS = {
  // 身体：色在片元钩子里按区域给（墨玉 / 烟色 / 月白 / 金），这里只定分档和光
  body: { step1: 0.53, step2: 0.06, feather1: 0.006, feather2: 0.006, edgeNoise: 0.022, skyAmt: 0.75, cityAmt: 0.92, cityStep: 0.6, cityStep2: 0.94, cityW1: 0.42, cityFlat: 0.55,
    rimAmt: 0.6, rimColor: PALETTE.pink, rimPower: 0.4, rimInside: 0.3, rimDirK: 0.5,
    rimLitAmt: 1, rimLitColor: PALETTE.kunRim, rimLitPower: 0.55, rimLitInside: 0.1, rimLitDirK: 0.55,
    sheenAmt: 0.34, sheenThr: 0.72, glossAmt: 0.9 },
  gold: { step1: 0.5, step2: 0.18, skyAmt: 0.2, cityAmt: 0.7, cityFlat: 0.35, rimAmt: 0.55, rimInside: 0.4, rimLitAmt: 1, rimLitInside: 0.12, rimLitPower: 0.5, rimLitDirK: 0.5, edgeNoise: 0.02 },
  silk: { step1: 0.5, step2: 0.12, shade1Tint: tintFrom(XUAN.silk, '#c4bdd8'), shade2Tint: tintFrom(XUAN.silk, '#968db5'),
    skyAmt: 0.5, skyTint: [0.9, 0.93, 1.06], cityAmt: 0.75, cityStep: 0.45, cityStep2: 0.85, cityFlat: 0.45,
    rimAmt: 0.0, rimLitAmt: 0.6, rimLitInside: 0.2, rimLitPower: 0.5, rimLitDirK: 0.5, edgeNoise: 0.02, edgeNoiseScale: 0.05 },
};

// —— GLSL：确定性噪声（与 toon.js 相同：Hoskins 无正弦哈希 + 梯度噪声 + 4 层 fbm） ——
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
float toonSS( float a, float b, float x ) { float t = clamp( ( x - a ) / ( b - a ), 0.0, 1.0 ); return t * t * ( 3.0 - 2.0 * t ); }
float toonFbm( vec3 p ) {
  float s = 0.0, a = 0.5;
  for ( int k = 0; k < 4; k ++ ) { s += a * toonNoise( p ); p = p * 2.03 + vec3( 1.7, 9.2, 3.1 ); a *= 0.5; }
  return s;
}
// 抗锯齿的“线”：d 为到线中心的距离，w 为半宽（同单位）
float toonLine( float d, float w ) { float f = max( fwidth( d ), 1e-5 ); return 1.0 - smoothstep( w - f, w + f, abs( d ) ); }
// 抗锯齿的“内部”：d < 0 为内
float toonFill( float d ) { float f = max( fwidth( d ), 1e-5 ); return 1.0 - smoothstep( -f, f, d ); }
`;

const FRAG_PARS = /* glsl */`
uniform vec3 uLitTint, uShade1Tint, uShade2Tint;
uniform float uStep1, uFeather1, uStep2, uFeather2, uShadowDepth, uCastShade, uShadowLo, uShadowHi;
uniform float uEdgeNoise, uEdgeNoiseScale;
uniform vec3 uRimColor; uniform float uRimAmt, uRimPower, uRimInside, uRimDirK;
uniform vec3 uRimLitColor; uniform float uRimLitAmt, uRimLitDirK, uRimLitInside, uRimLitPower;
uniform vec3 uCityColor; uniform float uCityAmt, uCityStep, uCityStep2, uCityW1, uCityFlat;
uniform vec3 uSkyTint; uniform float uSkyAmt;
uniform float uPatchScale;
uniform vec3 uRustColor; uniform float uRustAmt, uRustThr;
uniform vec3 uAlgaeColor; uniform float uAlgaeAmt, uAlgaeThr;
uniform vec3 uSpotColor; uniform float uSpotAmt, uSpotThr, uSpotScale;
uniform vec3 uInkColor; uniform float uObjectId, uOutlineW, uInstIdOn, uDabAmt, uDabScale;
uniform float uToonPass, uInkTime, uExposure, uCityGain, uSkyGain;
uniform vec3 uCityDirW, uSkyDirW, uKeyDirW;
uniform vec3 uMetLit, uMetS1, uMetS2, uGlintColor; uniform float uMetR1, uMetR2, uMetShade, uGlintThr, uGlintAmt;
uniform vec3 uSheenColor, uGlossColor; uniform float uSheenThr, uSheenAmt, uGlossThr, uGlossAmt;
uniform vec3 uTransA, uTransB; uniform float uTransThr, uTransHot, uTransShadow;
varying vec3 vToonObj;
flat varying float vToonInst;
float toonLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
${NOISE_GLSL}
`;

const FRAG_PATCHES = /* glsl */`
vec3 toonBase = diffuseColor.rgb;
float toonInk = 0.0;
vec4 toonOverlay = vec4( 0.0 );
float toonMetal = 0.0, toonGloss = 0.0, toonTrans = 0.0;
if ( uDabAmt > 0.0 ) {
  vec3 Q = vToonObj * uDabScale;
  float d1 = toonNoise( Q ), d2 = toonNoise( Q * 2.3 + 17.0 );
  float a1 = max( fwidth( d1 ), 1e-4 ) * 0.8, a2 = max( fwidth( d2 ), 1e-4 ) * 0.8;
  float q = 0.55 * smoothstep( 0.12 - a1, 0.12 + a1, d1 ) + 0.45 * smoothstep( 0.22 - a2, 0.22 + a2, d2 );
  diffuseColor.rgb *= mix( 1.0 - uDabAmt, 1.0 + 0.7 * uDabAmt, q );
}
if ( uRustAmt + uAlgaeAmt + uSpotAmt > 0.0 ) {
  vec3 P = vToonObj * uPatchScale;
  vec3 w = vec3( toonNoise( P * 0.6 + 1.3 ), toonNoise( P * 0.6 + 7.1 ), toonNoise( P * 0.6 + 13.7 ) );
  float nR = toonFbm( P + w * 0.9 );
  float aR = max( fwidth( nR ), 1e-4 ) * 0.8;
  float rust = smoothstep( uRustThr - aR, uRustThr + aR, nR );
  diffuseColor.rgb = mix( diffuseColor.rgb, uRustColor, rust * uRustAmt );
  float nA = toonFbm( P * 1.6 - w * 0.7 + 31.0 );
  float aA = max( fwidth( nA ), 1e-4 ) * 0.8;
  float alg = smoothstep( uAlgaeThr - aA, uAlgaeThr + aA, nA ) * ( 1.0 - rust );
  diffuseColor.rgb = mix( diffuseColor.rgb, uAlgaeColor, alg * uAlgaeAmt );
  float nS = toonNoise( vToonObj * uPatchScale * uSpotScale + w * 0.4 + 57.0 );
  float aS = max( fwidth( nS ), 1e-4 ) * 0.8;
  float spot = smoothstep( uSpotThr - aS, uSpotThr + aS, nS );
  diffuseColor.rgb = mix( diffuseColor.rgb, uSpotColor, spot * uSpotAmt );
}
`;

// 卡通光照合成（替换 meshtoon 里 outgoingLight 那一行）
const FRAG_SHADE = /* glsl */`
vec3 outgoingLight;
{
  vec3 N = normal;
  vec3 V = geometryViewDir;
  vec3 L;
  #if NUM_DIR_LIGHTS > 0
    L = directionalLights[ 0 ].direction;
  #else
    L = normalize( ( viewMatrix * vec4( uKeyDirW, 0.0 ) ).xyz );
  #endif
  float att = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow toonKs = directionalLightShadows[ 0 ];
    att = receiveShadow ? getShadow( directionalShadowMap[ 0 ], toonKs.shadowMapSize, toonKs.shadowIntensity, toonKs.shadowBias, toonKs.shadowRadius, vDirectionalShadowCoord[ 0 ] ) : 1.0;
  #endif
  vec3 alb = diffuseColor.rgb;
  float en = toonNoise( vToonObj * uEdgeNoiseScale + 101.0 ) * uEdgeNoise;
  float ndl = dot( N, L );
  // 三色分档（半兰伯特 + 两道羽化）
  float hl = 0.5 * ndl + 0.5 + en;
  float hlS = hl * mix( 1.0 - uShadowDepth, 1.0, att );
  float f1 = max( uFeather1, fwidth( hlS ) * 1.5 );
  float m1 = clamp( ( uStep1 - hlS ) / f1 + 0.5, 0.0, 1.0 );
  m1 = max( m1, uCastShade * ( 1.0 - att ) );
  float f2 = max( uFeather2, fwidth( hl ) * 1.5 );
  float m2 = clamp( ( uStep2 - hl ) / f2 + 0.5, 0.0, 1.0 );
  vec3 col = mix( alb * uLitTint, mix( alb * uShade1Tint, alb * uShade2Tint, m2 ), m1 );
  // 天空冷色补光：只进阴影档里朝天的面
  vec3 skyV = normalize( ( viewMatrix * vec4( uSkyDirW, 0.0 ) ).xyz );
  float sk = dot( N, skyV );
  float fsk = max( 0.02, fwidth( sk ) );
  float skyM = smoothstep( 0.3 - fsk, 0.3 + fsk, sk + en ) * m1 * uSkyAmt * uSkyGain;
  col = mix( col, alb * uSkyTint, clamp( skyM, 0.0, 1.0 ) * ( 1.0 - toonMetal ) );
  // 金箔：按反射方向分三档（反射天空亮、反射地面暗），暗部只压一点、不发灰
  vec3 Rv = reflect( - V, N );
  if ( toonMetal > 0.0 ) {
    float ry = dot( Rv, skyV ) + en * 1.5;
    float fr0 = max( 0.02, fwidth( ry ) * 1.2 );
    float r1 = smoothstep( uMetR1 - fr0, uMetR1 + fr0, ry ), r2 = smoothstep( uMetR2 - fr0, uMetR2 + fr0, ry );
    vec3 cm = alb * mix( mix( uMetS2, uMetS1, r1 ), uMetLit, r2 );
    cm *= mix( 1.0, uMetShade, m1 );
    col = mix( col, cm, toonMetal );
  }
  // 城市暖光：自下而上，两档量化
  vec3 cityV = normalize( ( viewMatrix * vec4( uCityDirW, 0.0 ) ).xyz );
  float cn = dot( N, cityV ) + en * 0.6;
  float fc = max( 0.015, fwidth( cn ) * 1.2 );
  float cm2 = uCityW1 * smoothstep( uCityStep - fc, uCityStep + fc, cn ) + ( 1.0 - uCityW1 ) * smoothstep( uCityStep2 - fc, uCityStep2 + fc, cn );
  cm2 *= uCityAmt * uCityGain;
  float lr = clamp( toonLum( alb ) / max( toonLum( toonBase ), 1e-4 ), 0.0, 1.4 );
  vec3 warm = mix( alb * uCityColor * 2.4, uCityColor * mix( 1.0, lr, 0.55 ), uCityFlat * ( 1.0 - toonMetal ) );
  col = mix( col, warm, clamp( cm2, 0.0, 1.0 ) );
  // 丝绸透光：光在这一面的背后 → 透出暖光；视线正对太阳再亮一档
  if ( toonTrans > 0.0 ) {
    // 两档透光：扭过去的地方淡暖白（A），正对背光的地方桃金（B）；视线正对太阳再亮一档（hot）
    float back = - ndl + en * 0.6;
    float ft = max( 0.02, fwidth( back ) * 1.2 );
    float tr1 = smoothstep( uTransThr - ft, uTransThr + ft, back );
    float tr1b = smoothstep( 0.45 - ft, 0.45 + ft, back );
    float va = dot( - V, L ) + en * 0.5;
    float fv = max( 0.02, fwidth( va ) * 1.2 );
    float tr2 = smoothstep( uTransHot - fv, uTransHot + fv, va ) * tr1b;
    vec3 tc = mix( alb * uTransA, alb * uTransB, tr1b );
    tc = mix( tc, alb * vec3( 1.42, 1.26, 1.04 ), tr2 * 0.6 );
    col = mix( col, tc, tr1 * toonTrans * mix( uTransShadow, 1.0, att ) );
  }
  // 墨玉 / 漆面：反射天空的一条硬边亮带 + 主光硬边高光
  vec3 H = normalize( L + V );
  float nh = dot( N, H ) + en * 0.15;
  float fh = max( 0.003, fwidth( nh ) * 1.2 );
  if ( toonGloss > 0.0 ) {
    float rs = dot( Rv, skyV ) + en * 2.0 + toonNoise( vToonObj * 0.03 + 21.0 ) * 0.16;
    float fs = max( 0.02, fwidth( rs ) * 1.2 );
    float sheen = smoothstep( uSheenThr - fs, uSheenThr + fs, rs ) * toonGloss * uSheenAmt;
    col = mix( col, uSheenColor * mix( 1.0, lr, 0.4 ), clamp( sheen, 0.0, 1.0 ) );
    float gl = smoothstep( uGlossThr - fh, uGlossThr + fh, nh ) * toonGloss * uGlossAmt * att;
    col = mix( col, uGlossColor, clamp( gl, 0.0, 1.0 ) );
  }
  float glint = smoothstep( uGlintThr - fh, uGlintThr + fh, nh ) * toonMetal * uGlintAmt * att;
  col = mix( col, uGlintColor, clamp( glint, 0.0, 1.0 ) );
  // 边缘光：Ap（背光侧）+ 受光侧；硬边。金的边缘光更亮一点
  float ndv = clamp( dot( N, V ), 0.0, 1.0 );
  float hlv = clamp( 0.5 * ndl + 0.5, 0.0, 1.0 );
  float rp = pow( 1.0 - ndv, exp2( 3.0 * ( 1.0 - uRimPower ) ) ) + en * 0.8;
  float fr = max( 0.012, fwidth( rp ) * 1.2 );
  float tAp = uRimInside + uRimDirK * hlv;
  float ap = smoothstep( tAp - fr, tAp + fr, rp ) * uRimAmt;
  float rq = pow( 1.0 - ndv, exp2( 3.0 * ( 1.0 - uRimLitPower ) ) ) + en * 0.8;
  float fq = max( 0.012, fwidth( rq ) * 1.2 );
  float tLit = uRimLitInside + uRimLitDirK * ( 1.0 - hlv );
  float rl = smoothstep( tLit - fq, tLit + fq, rq ) * uRimLitAmt * att;
  col = mix( col, uRimColor * mix( 1.0, lr, 0.35 ), clamp( ap, 0.0, 1.0 ) );
  col = mix( col, mix( uRimLitColor, uGlintColor, toonMetal * 0.6 ), clamp( rl, 0.0, 1.0 ) );
  col = mix( col, uInkColor, clamp( toonInk, 0.0, 1.0 ) );
  col = mix( col, toonOverlay.rgb, clamp( toonOverlay.a, 0.0, 1.0 ) );
  outgoingLight = col * uExposure + totalEmissiveRadiance;
}
`;

const FRAG_PASS = /* glsl */`
#ifdef XUAN_NO_ID
if ( uToonPass > 0.5 ) discard;          // 不进法线 / ID 通道：屏幕描边不画它（边由自身着色器画）
#endif
if ( uToonPass > 0.5 ) {
  float toonId = fract( uObjectId * 0.7548776662 + vToonInst * uInstIdOn * 0.5698402910 + 0.137 );
  gl_FragColor = vec4( normal * uOutlineW * 0.5 + 0.5, toonId );
}
`;

const SHADOW_ANCHOR = 'return mix( 1.0, shadow, shadowIntensity );';

function inject(src, anchor, code, mode = 'after') {
  if (!src.includes(anchor)) throw new Error(`toon_xuan.js：着色器锚点缺失「${anchor.slice(0, 60)}」（three r${THREE.REVISION}，本模块按 r170 写）`);
  const rep = mode === 'after' ? anchor + '\n' + code : mode === 'before' ? code + '\n' + anchor : code;
  return src.replace(anchor, () => rep);
}
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
const vec3Of = v => v instanceof THREE.Vector3 ? v.clone() : Array.isArray(v) ? new THREE.Vector3(...v) : new THREE.Vector3(v.x, v.y, v.z);
const colorOf = c => c instanceof THREE.Color ? c.clone() : new THREE.Color(c);

let _objectId = 4001;
function vertexInject(src, o, withToonVaryings) {
  let s = src;
  s = inject(s, '#include <common>', (withToonVaryings ? 'varying vec3 vToonObj;\nflat varying float vToonInst;\n' : '') + (o.vertexPars || ''));
  s = inject(s, 'void main() {', o.vertexMainStart || '');
  if (s.includes('#include <beginnormal_vertex>') && o.vertexNormal) s = inject(s, '#include <beginnormal_vertex>', o.vertexNormal);
  s = inject(s, '#include <begin_vertex>', (withToonVaryings ? 'vToonObj = position + float( gl_InstanceID ) * vec3( 1.618, 2.718, 3.1416 );\n' : '') + (o.vertexBegin || ''));
  if (withToonVaryings) s = inject(s, '#include <project_vertex>', 'vToonInst = float( gl_InstanceID );');
  return s;
}

/**
 * makeXuanMaterial(opts) → THREE.MeshToonMaterial（已打补丁）。参数同 toon.js 的 makeToonMaterial，另加
 *   metLit / metS1 / metS2 / metR1 / metR2 / metShade / glintColor / glintThr / glintAmt   金箔
 *   sheenColor / sheenThr / sheenAmt / glossColor / glossThr / glossAmt                   墨玉光泽
 *   transA / transB / transThr / transHot / transShadow                                   丝绸透光
 *   translucent: true  彩色通道半透明（alpha 由钩子写 diffuseColor.a）；法线 / ID 通道自动不透明
 *   noId: true         不进法线 / ID 通道（屏幕描边、雾都不管它；细小物件用自身着色器画边）
 */
export function makeXuanMaterial(opts = {}) {
  const o = { ...XUAN_DEFAULTS, ...opts };
  const base = colorOf(o.color);
  const t1 = o.shade1 ? tintFrom(o.color, o.shade1) : vec3Of(o.shade1Tint);
  const t2 = o.shade2 ? tintFrom(o.color, o.shade2) : vec3Of(o.shade2Tint);
  const mat = new THREE.MeshToonMaterial({ color: base, side: o.side, fog: o.fog, transparent: !!o.translucent, opacity: 1 });
  const u = {
    uLitTint: { value: vec3Of(o.litTint) }, uShade1Tint: { value: t1 }, uShade2Tint: { value: t2 },
    uStep1: { value: o.step1 }, uFeather1: { value: Math.max(0.004, o.feather1) }, uStep2: { value: o.step2 }, uFeather2: { value: Math.max(0.004, o.feather2) },
    uShadowDepth: { value: o.shadowDepth }, uCastShade: { value: o.castShade }, uShadowLo: { value: o.shadowLo }, uShadowHi: { value: o.shadowHi },
    uEdgeNoise: { value: o.edgeNoise }, uEdgeNoiseScale: { value: o.edgeNoiseScale },
    uRimColor: { value: colorOf(o.rimColor) }, uRimAmt: { value: o.rimAmt }, uRimPower: { value: o.rimPower }, uRimInside: { value: o.rimInside }, uRimDirK: { value: o.rimDirK },
    uRimLitColor: { value: colorOf(o.rimLitColor) }, uRimLitAmt: { value: o.rimLitAmt }, uRimLitDirK: { value: o.rimLitDirK }, uRimLitInside: { value: o.rimLitInside }, uRimLitPower: { value: o.rimLitPower },
    uCityColor: { value: colorOf(o.cityColor) }, uCityAmt: { value: o.cityAmt }, uCityStep: { value: o.cityStep }, uCityStep2: { value: o.cityStep2 }, uCityW1: { value: o.cityW1 }, uCityFlat: { value: o.cityFlat },
    uSkyTint: { value: vec3Of(o.skyTint) }, uSkyAmt: { value: o.skyAmt },
    uPatchScale: { value: o.patchScale },
    uRustColor: { value: colorOf(o.rustColor) }, uRustAmt: { value: o.rustAmt }, uRustThr: { value: o.rustThr },
    uAlgaeColor: { value: colorOf(o.algaeColor) }, uAlgaeAmt: { value: o.algaeAmt }, uAlgaeThr: { value: o.algaeThr },
    uSpotColor: { value: colorOf(o.spotColor) }, uSpotAmt: { value: o.spotAmt }, uSpotThr: { value: o.spotThr }, uSpotScale: { value: o.spotScale },
    uInkColor: { value: colorOf(o.inkColor) }, uObjectId: { value: o.objectId ?? _objectId++ },
    uOutlineW: { value: o.outlineW }, uInstIdOn: { value: o.instanceId ? 1 : 0 }, uDabAmt: { value: o.dabAmt }, uDabScale: { value: o.dabScale },
    uMetLit: { value: vec3Of(o.metLit) }, uMetS1: { value: vec3Of(o.metS1) }, uMetS2: { value: vec3Of(o.metS2) },
    uMetR1: { value: o.metR1 }, uMetR2: { value: o.metR2 }, uMetShade: { value: o.metShade },
    uGlintColor: { value: colorOf(o.glintColor) }, uGlintThr: { value: o.glintThr }, uGlintAmt: { value: o.glintAmt },
    uSheenColor: { value: colorOf(o.sheenColor) }, uSheenThr: { value: o.sheenThr }, uSheenAmt: { value: o.sheenAmt },
    uGlossColor: { value: colorOf(o.glossColor) }, uGlossThr: { value: o.glossThr }, uGlossAmt: { value: o.glossAmt },
    uTransA: { value: vec3Of(o.transA) }, uTransB: { value: vec3Of(o.transB) }, uTransThr: { value: o.transThr }, uTransHot: { value: o.transHot }, uTransShadow: { value: o.transShadow },
    ...TOON_SHARED, ...(o.uniforms || {}),
  };
  const defines = { ...(o.defines || {}), ...(o.noId ? { XUAN_NO_ID: 1 } : {}) };
  const key = 'toon-xuan-r170-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, o.vertexNormal, o.fragmentPars, o.fragmentAlbedo, o.fragmentNormal, JSON.stringify(defines)].join('§'));
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), defines);
    sh.vertexShader = vertexInject(sh.vertexShader, o, true);
    const sm = THREE.ShaderChunk.shadowmap_pars_fragment;
    if (!sm.includes(SHADOW_ANCHOR)) throw new Error(`toon_xuan.js：投影量化锚点缺失（three r${THREE.REVISION}）`);
    let f = sh.fragmentShader;
    f = inject(f, '#include <common>', FRAG_PARS + (o.fragmentPars || ''));
    f = inject(f, '#include <shadowmap_pars_fragment>', sm.replaceAll(SHADOW_ANCHOR, 'return mix( 1.0, smoothstep( uShadowLo, uShadowHi, shadow ), shadowIntensity );'), 'replace');
    f = inject(f, '#include <color_fragment>', FRAG_PATCHES + (o.fragmentAlbedo || ''));
    f = inject(f, '#include <normal_fragment_maps>', o.fragmentNormal || '');
    f = inject(f, 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', FRAG_SHADE, 'replace');
    f = inject(f, '#include <dithering_fragment>', FRAG_PASS);
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => key;
  mat.userData.toon = u;
  mat.userData.toonOpts = o;
  if (o.translucent) {
    // 彩色通道：正常混合、不写深度（排在不透明物体之后，按物体深度从远到近画）
    // 法线 / ID 通道：不混合、写深度（ID 图里它是实心的，描边和雾照常）
    mat.forceSinglePass = true;   // 双面透明默认会画两遍（背面、正面）并强制重编，这里不需要
    mat.depthWrite = false;
    mat.onBeforeRender = () => {
      const idPass = TOON_SHARED.uToonPass.value > 0.5;
      mat.blending = idPass ? THREE.NoBlending : THREE.NormalBlending;
      mat.depthWrite = idPass;
    };
  }
  return mat;
}

export function makeXuanDepthMaterial(mat) {
  const o = mat.userData.toonOpts || {};
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const u = mat.userData.toon;
  const key = 'toon-xuan-depth-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, JSON.stringify(o.defines || {})].join('§'));
  d.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), o.defines || {});
    sh.vertexShader = vertexInject(sh.vertexShader, { ...o, vertexNormal: '' }, false);
  };
  d.customProgramCacheKey = () => key;
  return d;
}

// 挂材质 + 投影深度材质 + 描边标记（与 toon.js 的 bindToon 相同约定）
export function bindXuan(mesh, mat, { castShadow = true, receiveShadow = true, outline = true } = {}) {
  mesh.material = mat;
  const o = mat.userData.toonOpts || {};
  if (o.vertexPars || o.vertexBegin || o.vertexMainStart) mesh.customDepthMaterial = makeXuanDepthMaterial(mat);
  mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
  mesh.userData.outline = outline;
  mesh.userData.outlineId = mat.userData.toon.uObjectId.value;
  mesh.userData.outlineWeight = mat.userData.toon.uOutlineW.value;
  mesh.userData.outlinePerInstance = !!mesh.isInstancedMesh && mat.userData.toon.uInstIdOn.value > 0.5;
  mesh.userData.instanced = !!mesh.isInstancedMesh;
  return mesh;
}
