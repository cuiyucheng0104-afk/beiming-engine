// 青铜古鲲的卡通着色（toon.js 的分支，三渲二配方第 2 层）
// 与 toon.js 相同：三色分档（两道羽化）、投影量化、Ap 背光边缘光 + 受光侧边缘光、城市暖光两档、天空冷光、物体空间确定性斑块。
// 新增：
//   · 钩子变量 toonLift（0..1）：把这一片从阴影档往亮档抬（玉、绿松石在逆光里也要“透”出来，像自带一点温润的光）
//   · 钩子变量 toonPassN / toonPassUse：描边通道写哪根法线（浮雕只管着色，不进屏幕描边，纹样的线由材质自己画）
//   · 钩子变量 toonRimN / toonRimUse：边缘光用哪根法线（默认用扰动后的法线；身体用原始法线，免得每条纹带都起亮边）
//   · bzPerturb：不依赖切线的凹凸（Mikkelsen 2010 屏幕导数法；σ 不归一化，坡度与距离无关）
// 共享 uniform 直接引用 toon.js 的 TOON_SHARED：正片里 setToonGlobals 切描边通道 / 推墨线时钟，青铜鲲同步生效。
// 确定性：所有噪声是坐标的纯函数，没有时间和随机数（墨线抖动只跟 uInkTime 走）。
import * as THREE from 'three';
import { TOON_SHARED, tintFrom, PALETTE } from './toon.js';
export { TOON_SHARED, tintFrom, PALETTE };

// —— 青铜色板（亮档颜色；阴影档由乘法色调统一压暗、偏冷） ——
export const BRONZE = {
  field: '#8fae76',      // 铜绿底（亮档）：偏橄榄的灰绿
  shade1: '#567c60',     // 一档阴影：橄榄灰绿（逆光里镜头看到的大多是这一档；和薰衣草色天空互补）
  shade2: '#33484c',     // 二档阴影：靛青灰
  band: '#b9b680',       // 凸起纹带：橄榄金（阴影档里也要比底子亮一档，纹样靠明度也读得出）
  copper: '#d29c60',     // 纹带磨亮的棱、鳍的刃口：铜色
  channel: '#46594a',    // 没镶嵌的凹槽：深铜绿
  dark: '#4b5d51',       // 深色铜锈
  bloom: '#9fc5b2',      // 粉绿色浮锈（偏青，和橄榄底拉开冷暖）
  rust: '#7c6b94',       // 紫色锈斑
  cuprite: '#9a6a52',    // 红褐色氧化亚铜小斑
  tq1: '#4fc4b1', tq2: '#3aa999', tq3: '#76d4c1', grout: '#2f5552',   // 绿松石三色 + 嵌缝
  jade: '#efe8d2', jade2: '#d8dcc5',
  lichen: '#d3d4a4', lichen2: '#b4b884',
  moss: ['#a3bf55', '#adc861', '#93b34c', '#b8cf6c', '#9bba58', '#8aad4a', '#c2d677'],
  fern: ['#84b24c', '#8fbd58', '#78a646', '#97c461'],
  flower: ['#fff8ee', '#fdf4f4', '#f7f2e4', '#fff3e2', '#f4f5ff', '#ffeef0'],
};
const BT1 = tintFrom(BRONZE.field, BRONZE.shade1), BT2 = tintFrom(BRONZE.field, BRONZE.shade2);

export const BRONZE_DEFAULTS = {
  color: BRONZE.field,
  shade1: null, shade2: null, shade1Tint: BT1, shade2Tint: BT2,
  litTint: [1, 1, 1],
  step1: 0.53, feather1: 0.02, step2: 0.1, feather2: 0.03,
  shadowDepth: 0.5, castShade: 1, shadowLo: 0.42, shadowHi: 0.58,
  edgeNoise: 0.03, edgeNoiseScale: 0.06,
  rimColor: PALETTE.pink, rimAmt: 0.6, rimPower: 0.4, rimInside: 0.3, rimDirK: 0.5,
  rimLitColor: PALETTE.kunRim, rimLitAmt: 1, rimLitInside: 0.1, rimLitPower: 0.55, rimLitDirK: 0.55,
  cityColor: PALETTE.kunBelly, cityAmt: 0.92, cityStep: 0.5, cityStep2: 0.9, cityW1: 0.42, cityFlat: 0.55,
  skyTint: [0.82, 0.92, 1.12], skyAmt: 0.75,
  patchScale: 0.05,
  rustColor: BRONZE.rust, rustAmt: 0, rustThr: 0.1,
  algaeColor: BRONZE.bloom, algaeAmt: 0, algaeThr: 0.28,
  spotColor: PALETTE.ink, spotAmt: 0, spotThr: 0.5, spotScale: 6,
  dabAmt: 0, dabScale: 1.2,
  inkColor: PALETTE.ink,
  outlineW: 1, instanceId: true,
  side: THREE.FrontSide, fog: true,
};

// 植被、玉的预设（实例色物体：color 白，阴影色 = 实例色 × 色调）
export const BRONZE_PRESETS = {
  bronze: {},
  moss: { color: '#ffffff', shade1Tint: tintFrom('#a3bf55', '#64925a'), shade2Tint: tintFrom('#a3bf55', '#3f6a52'), step1: 0.5, step2: 0.12,
    dabAmt: 0.16, dabScale: 0.9, rimAmt: 0.55, rimInside: 0.38, rimLitAmt: 1, rimLitInside: 0.06, rimLitPower: 0.6, rimLitDirK: 0.45, rimPower: 0.3, rimLitColor: '#fff0c8',
    cityAmt: 0.5, cityFlat: 0.25, edgeNoise: 0.05, skyAmt: 0.6, skyTint: [0.82, 0.97, 1.0] },
  fern: { color: '#ffffff', shade1Tint: tintFrom('#84b24c', '#76aa5e'), shade2Tint: tintFrom('#84b24c', '#5a8a58'), step1: 0.5, step2: 0.06,
    rimAmt: 0.45, rimInside: 0.45, rimLitAmt: 1, rimLitInside: 0.12, rimLitColor: '#fff0c8', rimLitPower: 0.5, rimLitDirK: 0.5, cityAmt: 0.45, cityFlat: 0.25, edgeNoise: 0.03, skyAmt: 0.5, skyTint: [0.85, 0.97, 1.0] },
  flower: { color: '#ffffff', shade1Tint: tintFrom('#fff8ee', '#c9bfd2'), shade2Tint: tintFrom('#fff8ee', '#9a8fae'),
    step1: 0.45, step2: 0.14, rimAmt: 0.35, rimInside: 0.55, cityAmt: 0.55, cityFlat: 0.3, skyAmt: 0.7, skyTint: [0.93, 0.93, 1.0] },
  jade: { color: BRONZE.jade, shade1: '#c3c9b8', shade2: '#8f9a96', step1: 0.5, step2: 0.12, feather1: 0.05,
    rimAmt: 0.5, rimInside: 0.45, rimLitAmt: 0.7, rimLitInside: 0.2, cityAmt: 0.75, cityFlat: 0.4, skyAmt: 0.6, skyTint: [0.94, 0.97, 1.02] },
};

// —— GLSL：确定性噪声（与 toon.js 相同的 Hoskins 哈希 + 梯度噪声 + 4 层 fbm） ——
const NOISE_GLSL = /* glsl */`
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
// 二维 Voronoi：x = 最近距离 F1，y = 次近 F2，z = 最近格子的哈希（0..1）
vec3 bzVor( vec2 p ) {
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
// 无切线凹凸（屏幕导数）。dHdxy = 高度在屏幕 x / y 方向每像素的变化（单位与位置相同）
vec3 bzPerturb( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
  vec3 sx = dFdx( surfPos ), sy = dFdy( surfPos );
  vec3 r1 = cross( sy, surfNorm ), r2 = cross( surfNorm, sx );
  float det = dot( sx, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
  return normalize( abs( det ) * surfNorm - grad );
}
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
varying vec3 vToonObj;
flat varying float vToonInst;
float toonLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
${NOISE_GLSL}
`;

// 表面斑块（与 toon.js 相同），另声明青铜钩子要用的变量
const FRAG_PATCHES = /* glsl */`
vec3 toonBase = diffuseColor.rgb;
float toonInk = 0.0;
vec4 toonOverlay = vec4( 0.0 );
float toonLift = 0.0;
vec3 toonPassN = vec3( 0.0, 0.0, 1.0 ); float toonPassUse = 0.0;
vec3 toonRimN = vec3( 0.0, 0.0, 1.0 ); float toonRimUse = 0.0;
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
  float core = smoothstep( uRustThr + 0.17 - aR, uRustThr + 0.17 + aR, nR );
  diffuseColor.rgb = mix( diffuseColor.rgb, uRustColor, rust * uRustAmt );
  diffuseColor.rgb = mix( diffuseColor.rgb, uRustColor * vec3( 0.55, 0.5, 0.62 ), core * uRustAmt * 0.75 );
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

// 卡通光照合成（与 toon.js 相同，另加 toonLift / toonRimN）
const FRAG_SHADE = /* glsl */`
vec3 outgoingLight;
{
  vec3 N = normal;
  vec3 NR = normalize( mix( N, toonRimN, toonRimUse ) );
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
  float hl = 0.5 * dot( N, L ) + 0.5 + en;
  float hlS = hl * mix( 1.0 - uShadowDepth, 1.0, att );
  float f1 = max( uFeather1, fwidth( hlS ) * 1.2 );
  float m1 = clamp( ( uStep1 - hlS ) / f1 + 0.5, 0.0, 1.0 );
  m1 = max( m1, uCastShade * ( 1.0 - att ) );
  float f2 = max( uFeather2, fwidth( hl ) * 1.2 );
  float m2 = clamp( ( uStep2 - hl ) / f2 + 0.5, 0.0, 1.0 );
  m1 *= 1.0 - clamp( toonLift, 0.0, 1.0 ) * 0.6;
  m2 *= 1.0 - clamp( toonLift, 0.0, 1.0 );
  vec3 col = mix( alb * uLitTint, mix( alb * uShade1Tint, alb * uShade2Tint, m2 ), m1 );
  vec3 skyV = normalize( ( viewMatrix * vec4( uSkyDirW, 0.0 ) ).xyz );
  float sk = dot( N, skyV );
  float fsk = max( 0.02, fwidth( sk ) );
  float skyM = smoothstep( 0.3 - fsk, 0.3 + fsk, sk + en ) * m1 * uSkyAmt * uSkyGain;
  col = mix( col, alb * uSkyTint, clamp( skyM, 0.0, 1.0 ) );
  vec3 cityV = normalize( ( viewMatrix * vec4( uCityDirW, 0.0 ) ).xyz );
  float cn = dot( N, cityV ) + en * 0.6;
  float fc = max( 0.015, fwidth( cn ) * 1.2 );
  float cm = uCityW1 * smoothstep( uCityStep - fc, uCityStep + fc, cn ) + ( 1.0 - uCityW1 ) * smoothstep( uCityStep2 - fc, uCityStep2 + fc, cn );
  cm *= uCityAmt * uCityGain;
  float lr = clamp( toonLum( alb ) / max( toonLum( toonBase ), 1e-4 ), 0.0, 1.4 );
  vec3 warm = mix( alb * uCityColor * 2.4, uCityColor * mix( 1.0, lr, 0.55 ), uCityFlat );
  col = mix( col, warm, clamp( cm, 0.0, 1.0 ) );
  float ndv = clamp( dot( NR, V ), 0.0, 1.0 );
  float hlv = clamp( 0.5 * dot( NR, L ) + 0.5, 0.0, 1.0 );
  float rp = pow( 1.0 - ndv, exp2( 3.0 * ( 1.0 - uRimPower ) ) ) + en * 0.8;
  float fr = max( 0.012, fwidth( rp ) * 1.2 );
  float tAp = uRimInside + uRimDirK * hlv;
  float ap = smoothstep( tAp - fr, tAp + fr, rp ) * uRimAmt;
  float rq = pow( 1.0 - ndv, exp2( 3.0 * ( 1.0 - uRimLitPower ) ) ) + en * 0.8;
  float fq = max( 0.012, fwidth( rq ) * 1.2 );
  float tLit = uRimLitInside + uRimLitDirK * ( 1.0 - hlv );
  float rl = smoothstep( tLit - fq, tLit + fq, rq ) * uRimLitAmt * att;
  col = mix( col, uRimColor * mix( 1.0, lr, 0.35 ), clamp( ap, 0.0, 1.0 ) );
  col = mix( col, uRimLitColor, clamp( rl, 0.0, 1.0 ) );
  col = mix( col, uInkColor, clamp( toonInk, 0.0, 1.0 ) );
  col = mix( col, toonOverlay.rgb, clamp( toonOverlay.a, 0.0, 1.0 ) );
  outgoingLight = col * uExposure + totalEmissiveRadiance;
}
`;

const FRAG_PASS = /* glsl */`
if ( uToonPass > 0.5 ) {
  float toonId = fract( uObjectId * 0.7548776662 + vToonInst * uInstIdOn * 0.5698402910 + 0.137 );
  vec3 toonPN = normalize( mix( normal, toonPassN, toonPassUse ) );
  gl_FragColor = vec4( toonPN * uOutlineW * 0.5 + 0.5, toonId );
}
`;

const SHADOW_ANCHOR = 'return mix( 1.0, shadow, shadowIntensity );';
function inject(src, anchor, code, mode = 'after') {
  if (!src.includes(anchor)) throw new Error(`toon_bronze.js：着色器锚点缺失「${anchor.slice(0, 60)}」（three r${THREE.REVISION}，本模块按 r170 写）`);
  const rep = mode === 'after' ? anchor + '\n' + code : mode === 'before' ? code + '\n' + anchor : code;
  return src.replace(anchor, () => rep);
}
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
const vec3Of = v => v instanceof THREE.Vector3 ? v.clone() : Array.isArray(v) ? new THREE.Vector3(...v) : new THREE.Vector3(v.x, v.y, v.z);
const colorOf = c => c instanceof THREE.Color ? c.clone() : new THREE.Color(c);

// 物体 ID 从 5000 起，避开 toon.js 的自增 ID（同场景里两套材质的描边 ID 不撞）
let _objectId = 5001;
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
 * makeBronzeToon(opts) → THREE.MeshToonMaterial（已打补丁）。参数同 toon.js 的 makeToonMaterial：
 *   BRONZE_DEFAULTS 里的任意键；uniforms / defines；vertexPars / vertexMainStart / vertexBegin / vertexNormal；
 *   fragmentPars / fragmentAlbedo（改 diffuseColor.rgb、toonInk、toonOverlay、toonLift）/ fragmentNormal（改 normal、toonPassN、toonRimN）
 */
export function makeBronzeToon(opts = {}) {
  const o = { ...BRONZE_DEFAULTS, ...opts };
  const base = colorOf(o.color);
  const t1 = o.shade1 ? tintFrom(o.color, o.shade1) : vec3Of(o.shade1Tint);
  const t2 = o.shade2 ? tintFrom(o.color, o.shade2) : vec3Of(o.shade2Tint);
  const mat = new THREE.MeshToonMaterial({ color: base, side: o.side, fog: o.fog, transparent: !!o.transparent, opacity: o.opacity ?? 1, vertexColors: !!o.vertexColors });
  const u = {
    uLitTint: { value: vec3Of(o.litTint) }, uShade1Tint: { value: t1 }, uShade2Tint: { value: t2 },
    uStep1: { value: o.step1 }, uFeather1: { value: Math.max(0.015, o.feather1) }, uStep2: { value: o.step2 }, uFeather2: { value: Math.max(0.015, o.feather2) },
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
    ...TOON_SHARED, ...(o.uniforms || {}),
  };
  const defines = o.defines || {};
  const key = 'toon-bronze-r170-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, o.vertexNormal, o.fragmentPars, o.fragmentAlbedo, o.fragmentNormal, JSON.stringify(defines)].join('§'));
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), defines);
    sh.vertexShader = vertexInject(sh.vertexShader, o, true);
    const sm = THREE.ShaderChunk.shadowmap_pars_fragment;
    if (!sm.includes(SHADOW_ANCHOR)) throw new Error(`toon_bronze.js：投影量化锚点缺失（three r${THREE.REVISION}）`);
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
  return mat;
}

// 阴影深度材质：带同样的顶点形变（弯曲、摆动），投影才跟形体对得上
export function makeBronzeDepth(mat) {
  const o = mat.userData.toonOpts || {};
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: o.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide });
  const u = mat.userData.toon;
  const key = 'toon-bronze-depth-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, JSON.stringify(o.defines || {})].join('§'));
  d.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), o.defines || {});
    sh.vertexShader = vertexInject(sh.vertexShader, { ...o, vertexNormal: '' }, false);
  };
  d.customProgramCacheKey = () => key;
  return d;
}

// 挂材质 + 投影深度材质 + 描边标记（与 toon.js 的 bindToon 约定一致）
export function bindBronze(mesh, mat, { castShadow = true, receiveShadow = true, outline = true } = {}) {
  mesh.material = mat;
  const o = mat.userData.toonOpts || {};
  if (o.vertexPars || o.vertexBegin || o.vertexMainStart) mesh.customDepthMaterial = makeBronzeDepth(mat);
  mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
  mesh.userData.outline = outline;
  mesh.userData.outlineId = mat.userData.toon.uObjectId.value;
  mesh.userData.outlineWeight = mat.userData.toon.uOutlineW.value;
  mesh.userData.outlinePerInstance = !!mesh.isInstancedMesh && mat.userData.toon.uInstIdOn.value > 0.5;
  mesh.userData.instanced = !!mesh.isInstancedMesh;
  return mesh;
}
