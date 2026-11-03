// 卡通着色材质·精修版
// 与 toon.js 的关系：
//   · 共享同一个 TOON_SHARED（从 toon.js 引入）：正片里 setToonGlobals 改输出模式 / 墨线时钟 / 城市光，精修版材质同步生效
//   · 色板在 toon.js 的 PALETTE 上追加东方配色（玉白、朱砂、祥云米金、苔绿、龙须象牙…）
//   · 物体 ID 从 101 起编，避免与 toon.js 的材质撞号（屏幕空间描边靠 ID 分界）
// 新增（相对 toon.js）：
//   · 色阶更干脆：默认羽化 0.012 / 0.015（仍有 fwidth 兜底，逐帧导出不闪）
//   · 锈斑绘画感：斑块坐标可沿体轴拉长（像顺着身体刷的笔触）、边缘被高频噪声撕碎（干笔）、斑缘一圈积色（水彩的水渍边）、
//     斑外一圈飞白小点（甩笔）、斑心深色；铜绿（青绿）斑同样撕边
//   · 斑点成簇（簇掩膜），太远时自动淡出（不闪）
//   · 干笔笔触：沿给定方向拉长的噪声三档量化，轻微提亮 / 压暗
//   · 颜料颗粒：极细噪声，像素以下自动淡出
//   · 边缘光两色：外侧亮芯 + 内侧主色，内沿用噪声撕开（像笔触收笔）
//   · 植被笔触斑驳：三档（暗 / 中 / 亮黄绿），亮档偏黄，像一笔笔点上去的苔藓
//   · 主函数作用域里预留 toonRelief（vec2）：albedo 钩子算浮雕坡度，法线钩子拿去扰动法线（祥云纹浮雕用）
// 约定与 toon.js 相同：主光 = 第一盏投影平行光，只给方向和投影；颜色全部按色板绝对给定；保色板用 NoToneMapping。
import * as THREE from 'three';
import { PALETTE as PALETTE0, TOON_SHARED, setToonGlobals, tintFrom } from './toon.js';

export { TOON_SHARED, setToonGlobals, tintFrom };

// —— 色板：沿用原版，追加东方配色 ——
export const PALETTE = {
  ...PALETTE0,
  jade: '#DCECDB', jadeShade1: '#9DBFAF', jadeShade2: '#5E7E88',          // 玉白鳞点
  cinnabar: '#C9373B', cinnabarDeep: '#8E2235',                             // 朱砂（红珊瑚、眼角一抹红）
  cloudFill: '#EED39C', cloudLine: '#8C5E36', gold: '#D9B66C',              // 祥云纹：米金底、赭色线
  mossLit: '#C2D865', moss: '#8DB44E', mossDark: '#4F7E48', mossDeep: '#355F45',   // 苔藓三档 + 最暗
  whisker: '#EEDFBC', flower: '#FFF7EC', flowerHeart: '#F2C25A',          // 龙须象牙、小白花与花心
  iris: '#E9A43C', irisIn: '#F8D77E', irisRing: '#6E2A1C',                // 金瞳
  rimCore: '#FFF0D8', bark: '#6E5560', pineNeedle: '#3F6E4E',
};

const KUN_T1 = tintFrom(PALETTE.kunBase, PALETTE.kunShade1);
const KUN_T2 = tintFrom(PALETTE.kunBase, PALETTE.kunShade2);

export const TOON_DEFAULTS = {
  color: PALETTE.kunBase,
  shade1: null, shade2: null,
  shade1Tint: KUN_T1, shade2Tint: KUN_T2,
  litTint: [1, 1, 1],
  step1: 0.56, feather1: 0.012,
  step2: 0.32, feather2: 0.015,
  shadowDepth: 0.5, castShade: 1,
  shadowLo: 0.44, shadowHi: 0.56,
  edgeNoise: 0.03, edgeNoiseScale: 0.06,
  rimColor: PALETTE.kunRim, rimAmt: 1, rimPower: 0.2, rimInside: 0.42, rimDirK: 0.3,
  rimColor2: null, rimCore: 0.12,                  // 背光边缘光的亮芯（null = 不画）与亮芯宽度（作用于 pow 之后的边缘量）
  rimLitColor: PALETTE.kunRim, rimLitAmt: 0, rimLitInside: 0.2, rimLitPower: 0.4, rimLitDirK: 0.3,
  rimLitColor2: null, rimLitCore: 0.1,
  rimBreak: 0, rimNoiseScale: 0.12,               // 边缘光内沿撕边幅度 / 频率（1/物体单位）
  cityColor: PALETTE.kunBelly, cityAmt: 0, cityStep: 0.45, cityStep2: 0.8, cityW1: 0.45, cityFlat: 0.6,
  skyTint: [0.8, 0.88, 1.18], skyAmt: 0,
  patchScale: 0.05, patchStretch: 1,              // 斑块频率；沿物体 X 轴的压缩（<1 = 沿 X 拉长）
  rustColor: PALETTE.rust, rustAmt: 0, rustThr: 0.1,
  rustBreak: 0, rustPool: 0, rustSpatter: 0, spatterScale: 9, rustDapple: 0,   // 撕边 / 积色边 / 甩点 / 海绵点
  algaeColor: '#5f7f74', algaeAmt: 0, algaeThr: 0.28,
  spotColor: PALETTE.ink, spotAmt: 0, spotThr: 0.5, spotScale: 6, spotCluster: 0,
  dabAmt: 0, dabScale: 1.2, dabWarm: 0.6,         // 植被斑驳；dabWarm：亮档往黄绿偏的程度
  strokeAmt: 0, strokeScale: 0.08, strokeDir: [1, 0, 0], strokeStretch: 0.85,   // 干笔笔触
  grainAmt: 0, grainScale: 0.9,                   // 颜料颗粒
  inkColor: PALETTE.ink,
  outlineW: 1, instanceId: true,
  side: THREE.FrontSide, fog: true,
};

export const TOON_PRESETS = {
  generic: {},
  // 鲲身：在原版基础上色阶更干脆、锈斑撕边甩点、边缘光两色
  kun: { color: PALETTE.kunBase, shade1: PALETTE.kunShade1, shade2: PALETTE.kunShade2, step1: 0.53, step2: 0.17,
    rustAmt: 0.85, rustThr: 0.06, rustBreak: 0.1, rustPool: 0.8, rustSpatter: 0.9, spatterScale: 8.5, patchStretch: 0.62, rustDapple: 0.16,
    algaeAmt: 0.6, algaeColor: '#7FA69A', algaeThr: 0.27,
    spotAmt: 0.55, spotThr: 0.42, spotCluster: 1, spotColor: '#3A3466',
    strokeAmt: 0.075, strokeScale: 0.11, strokeStretch: 0.86, grainAmt: 0.04, grainScale: 0.75,
    cityAmt: 0.92, cityStep: 0.6, cityStep2: 0.94, cityW1: 0.42, cityFlat: 0.55, skyAmt: 0.75,
    rimAmt: 0.75, rimColor: PALETTE.pink, rimColor2: '#FFC9B0', rimCore: 0.16, rimPower: 0.42, rimInside: 0.27, rimDirK: 0.5,
    rimLitAmt: 1, rimLitColor: PALETTE.kunRim, rimLitColor2: PALETTE.rimCore, rimLitCore: 0.14, rimLitPower: 0.58, rimLitInside: 0.08, rimLitDirK: 0.55,
    rimBreak: 0.09, rimNoiseScale: 0.09 },
  jade: { color: '#ffffff', shade1Tint: tintFrom(PALETTE.jade, PALETTE.jadeShade1), shade2Tint: tintFrom(PALETTE.jade, PALETTE.jadeShade2),
    step1: 0.5, step2: 0.16, rimAmt: 0.55, rimInside: 0.45, rimColor: PALETTE.pink, cityAmt: 0.6, cityFlat: 0.3, edgeNoise: 0.02, skyAmt: 0.55, skyTint: [0.86, 0.92, 1.0],
    rimLitAmt: 0.9, rimLitColor: PALETTE.rimCore, rimLitInside: 0.12, rimLitPower: 0.5, rimLitDirK: 0.5 },
  moss: { color: '#ffffff', shade1Tint: tintFrom(PALETTE.moss, PALETTE.mossDark), shade2Tint: tintFrom(PALETTE.moss, PALETTE.mossDeep), step1: 0.5, step2: 0.15,
    dabAmt: 0.2, dabScale: 0.55, dabWarm: 0.7,
    rimAmt: 0.55, rimColor: PALETTE.pink, rimInside: 0.4, rimLitAmt: 0.95, rimLitColor: '#FFE7B5', rimLitInside: 0.12, rimLitPower: 0.5, rimLitDirK: 0.5, rimPower: 0.3, rimBreak: 0.12, rimNoiseScale: 0.6,
    cityAmt: 0.5, cityFlat: 0.25, edgeNoise: 0.05, skyAmt: 0.55, skyTint: [0.8, 0.94, 1.02] },
  grass: { color: '#ffffff', shade1Tint: tintFrom('#8DB44E', '#4F7E48'), shade2Tint: tintFrom('#8DB44E', '#355F45'), step1: 0.5, step2: 0.14,
    rimAmt: 0.5, rimColor: PALETTE.pink, rimInside: 0.4, rimLitAmt: 0.9, rimLitColor: '#FFE7B5', rimLitInside: 0.15, rimLitPower: 0.5, rimLitDirK: 0.5, rimPower: 0.3,
    cityAmt: 0.5, cityFlat: 0.25, edgeNoise: 0.04, skyAmt: 0.6, skyTint: [0.82, 0.95, 1.0] },
  coral: { color: '#ffffff', shade1Tint: [0.58, 0.36, 0.55], shade2Tint: [0.34, 0.2, 0.42], step1: 0.5, step2: 0.2, rimAmt: 0.55, rimInside: 0.45, rimColor: '#FFB7A0',
    rimLitAmt: 0.9, rimLitColor: '#FFD9B8', rimLitInside: 0.15, rimLitPower: 0.5, rimLitDirK: 0.5, cityAmt: 0.5, cityFlat: 0.3, skyAmt: 0.45, skyTint: [0.82, 0.78, 1.0] },
  flower: { color: '#ffffff', shade1Tint: tintFrom(PALETTE.flower, '#C9BBD6'), shade2Tint: tintFrom(PALETTE.flower, PALETTE.barnacleShade),
    step1: 0.42, step2: 0.14, rimAmt: 0.35, rimInside: 0.55, cityAmt: 0.55, cityFlat: 0.3, skyAmt: 0.7, skyTint: [0.93, 0.93, 1.0] },
  whisker: { color: PALETTE.whisker, shade1: '#D2B3A2', shade2: '#93788F', step1: 0.52, step2: 0.18,
    rimAmt: 0.7, rimColor: PALETTE.pink, rimColor2: '#FFE2CC', rimCore: 0.1, rimInside: 0.35, rimPower: 0.4, rimDirK: 0.5,
    rimLitAmt: 1, rimLitColor: PALETTE.rimCore, rimLitInside: 0.1, rimLitPower: 0.55, rimLitDirK: 0.5,
    cityAmt: 0.75, cityFlat: 0.45, cityStep: 0.5, cityStep2: 0.9, skyAmt: 0.5, skyTint: [0.88, 0.9, 1.05] },
  bark: { color: PALETTE.bark, shade1: '#4C3D57', shade2: '#2E2A47', step1: 0.52, step2: 0.18, strokeAmt: 0.12, strokeScale: 0.5, strokeDir: [0, 1, 0],
    rimAmt: 0.5, rimColor: PALETTE.pink, rimInside: 0.4, rimLitAmt: 0.9, rimLitColor: '#FFD9B0', rimLitInside: 0.15, rimLitPower: 0.5, rimLitDirK: 0.5,
    cityAmt: 0.5, cityFlat: 0.35, skyAmt: 0.4 },
  needle: { color: '#ffffff', shade1Tint: tintFrom('#4E8456', '#2F5B47'), shade2Tint: tintFrom('#4E8456', '#223F3E'), step1: 0.5, step2: 0.18,
    dabAmt: 0.22, dabScale: 0.7, dabWarm: 0.55,
    rimAmt: 0.55, rimColor: PALETTE.pink, rimInside: 0.4, rimLitAmt: 0.95, rimLitColor: '#FFE2B0', rimLitInside: 0.12, rimLitPower: 0.5, rimLitDirK: 0.5, rimBreak: 0.1, rimNoiseScale: 0.5,
    cityAmt: 0.45, cityFlat: 0.3, edgeNoise: 0.05, skyAmt: 0.5, skyTint: [0.8, 0.92, 1.05] },
};

// —— GLSL：确定性噪声（与 toon.js 相同的哈希与梯度噪声） ——
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
// 抗锯齿阈值：x 越过 t 时 0→1，过渡宽度取 1 像素
float toonAA( float t, float x ) { float a = max( fwidth( x ), 1e-4 ) * 0.75; return smoothstep( t - a, t + a, x ); }
`;

const FRAG_PARS = /* glsl */`
uniform vec3 uLitTint, uShade1Tint, uShade2Tint;
uniform float uStep1, uFeather1, uStep2, uFeather2, uShadowDepth, uCastShade, uShadowLo, uShadowHi;
uniform float uEdgeNoise, uEdgeNoiseScale;
uniform vec3 uRimColor, uRimColor2; uniform float uRimAmt, uRimPower, uRimInside, uRimDirK, uRimCore, uRimCoreOn;
uniform vec3 uRimLitColor, uRimLitColor2; uniform float uRimLitAmt, uRimLitDirK, uRimLitInside, uRimLitPower, uRimLitCore, uRimLitCoreOn;
uniform float uRimBreak, uRimNoiseScale;
uniform vec3 uCityColor; uniform float uCityAmt, uCityStep, uCityStep2, uCityW1, uCityFlat;
uniform vec3 uSkyTint; uniform float uSkyAmt;
uniform float uPatchScale, uPatchStretch;
uniform vec3 uRustColor; uniform float uRustAmt, uRustThr, uRustBreak, uRustPool, uRustSpatter, uSpatterScale, uRustDapple;
uniform vec3 uAlgaeColor; uniform float uAlgaeAmt, uAlgaeThr;
uniform vec3 uSpotColor; uniform float uSpotAmt, uSpotThr, uSpotScale, uSpotCluster;
uniform float uDabAmt, uDabScale, uDabWarm;
uniform float uStrokeAmt, uStrokeScale, uStrokeStretch; uniform vec3 uStrokeDir;
uniform float uGrainAmt, uGrainScale;
uniform vec3 uInkColor; uniform float uObjectId, uOutlineW, uInstIdOn;
uniform float uToonPass, uInkTime, uExposure, uCityGain, uSkyGain;
uniform vec3 uCityDirW, uSkyDirW, uKeyDirW;
varying vec3 vToonObj;
flat varying float vToonInst;
float toonLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
${NOISE_GLSL}
`;

// 表面：植被斑驳 / 干笔 / 颗粒 / 锈斑（撕边、积色、甩点、斑心）/ 铜绿 / 成簇斑点。全部是物体空间坐标的纯函数
const FRAG_PATCHES = /* glsl */`
vec3 toonBase = diffuseColor.rgb;
float toonInk = 0.0;            // 钩子可写：0..1，往墨线色混
vec4 toonOverlay = vec4( 0.0 ); // 钩子可写：不受光照的覆盖色（rgb, 量）
vec2 toonRelief = vec2( 0.0 );  // 钩子可写：浮雕坡度（给法线钩子用）
float toonPx = max( length( fwidth( vToonObj ) ), 1e-5 );   // 一个像素覆盖的物体单位
if ( uDabAmt > 0.0 ) {
  // 植被斑驳：两层噪声三档量化 → 暗 / 中 / 亮（亮档偏黄绿），像一笔笔点上去的苔藓
  vec3 Q = vToonObj * uDabScale;
  float d1 = toonNoise( Q ), d2 = toonNoise( Q * 2.2 + 17.0 );
  float fade = 1.0 - smoothstep( 0.5, 1.2, toonPx * uDabScale * 2.2 );
  float dark = 1.0 - toonAA( -0.18, d1 );
  float lit = toonAA( 0.24, d2 ) * ( 1.0 - dark );
  vec3 warm = mix( vec3( 1.0 ), vec3( 1.13, 1.12, 0.78 ), uDabWarm );
  diffuseColor.rgb *= mix( vec3( 1.0 ), mix( vec3( 1.0 - uDabAmt * 1.3 ), warm * ( 1.0 + uDabAmt * 0.6 ), lit ), max( dark, lit ) * fade );
}
if ( uStrokeAmt > 0.0 ) {
  // 干笔笔触：沿 uStrokeDir 拉长的噪声 → 三档（压暗 / 不动 / 提亮）
  vec3 Q = vToonObj * uStrokeScale;
  vec3 sd = normalize( uStrokeDir );
  Q -= sd * dot( Q, sd ) * uStrokeStretch;
  float n = toonNoise( Q + 5.3 );
  float fade = 1.0 - smoothstep( 0.35, 0.9, toonPx * uStrokeScale * 3.0 );
  float s = toonAA( 0.32, n ) - toonAA( 0.32, - n );
  diffuseColor.rgb *= 1.0 + uStrokeAmt * s * fade;
}
if ( uGrainAmt > 0.0 ) {
  float g = toonNoise( vToonObj * uGrainScale + 91.0 );
  float fade = 1.0 - smoothstep( 0.25, 0.7, toonPx * uGrainScale );
  diffuseColor.rgb *= 1.0 + uGrainAmt * g * fade;
}
if ( uRustAmt + uAlgaeAmt + uSpotAmt > 0.0 ) {
  vec3 P = vToonObj * uPatchScale;
  P.x *= uPatchStretch;
  vec3 w = vec3( toonNoise( P * 0.6 + 1.3 ), toonNoise( P * 0.6 + 7.1 ), toonNoise( P * 0.6 + 13.7 ) );
  float hf = toonNoise( vToonObj * uPatchScale * vec3( 5.0 * uPatchStretch, 7.5, 7.5 ) + 3.1 );   // 撕边用的高频
  float hfFade = 1.0 - smoothstep( 0.4, 1.1, toonPx * uPatchScale * 7.5 );
  // 紫色锈斑：撕边 + 积色边 + 斑心 + 斑外甩点
  float hf2 = toonNoise( vToonObj * uPatchScale * vec3( 15.0 * uPatchStretch, 19.0, 19.0 ) + 11.0 );   // 海绵点（斑驳）
  float hf2Fade = 1.0 - smoothstep( 0.4, 1.0, toonPx * uPatchScale * 19.0 );
  float nR = toonFbm( P + w * 0.9 ) + hf * uRustBreak * hfFade + hf2 * uRustDapple * hf2Fade;
  float rust = toonAA( uRustThr, nR );
  float pool = rust * ( 1.0 - toonAA( uRustThr + 0.055, nR ) );
  float core = toonAA( uRustThr + 0.19, nR + hf * 0.05 * hfFade );
  float sp = toonNoise( vToonObj * uPatchScale * uSpatterScale * vec3( uPatchStretch, 1.0, 1.0 ) + 77.0 );
  float spBand = toonSS( uRustThr - 0.16, uRustThr - 0.02, nR ) * ( 1.0 - rust );
  float spFade = 1.0 - smoothstep( 0.35, 0.9, toonPx * uPatchScale * uSpatterScale );
  float spat = toonAA( 0.32, sp ) * spBand * spFade * uRustSpatter;
  vec3 rustC = mix( uRustColor, uRustColor * vec3( 1.14, 1.1, 1.06 ), toonAA( 0.28, hf2 ) * hf2Fade );   // 斑里一层浅色洗
  diffuseColor.rgb = mix( diffuseColor.rgb, rustC, clamp( rust + spat, 0.0, 1.0 ) * uRustAmt );
  diffuseColor.rgb = mix( diffuseColor.rgb, uRustColor * vec3( 0.74, 0.68, 0.84 ), pool * uRustPool * uRustAmt );
  diffuseColor.rgb = mix( diffuseColor.rgb, uRustColor * vec3( 0.55, 0.5, 0.62 ), core * uRustAmt * 0.72 );
  // 铜绿（青绿）斑：撕边
  float nA = toonFbm( P * 1.6 - w * 0.7 + 31.0 ) + hf * 0.05 * hfFade;
  float alg = toonAA( uAlgaeThr, nA ) * ( 1.0 - rust );
  diffuseColor.rgb = mix( diffuseColor.rgb, uAlgaeColor, alg * uAlgaeAmt );
  // 深色小斑点：成簇（低频簇掩膜），太小时淡出
  float nS = toonNoise( vToonObj * uPatchScale * uSpotScale * vec3( uPatchStretch, 1.0, 1.0 ) + w * 0.4 + 57.0 );
  float cl = mix( 1.0, toonSS( 0.05, 0.35, toonNoise( P * 1.7 + 41.0 ) ), uSpotCluster );
  float sFade = 1.0 - smoothstep( 0.45, 1.0, toonPx * uPatchScale * uSpotScale );
  float spot = toonAA( uSpotThr, nS ) * cl * sFade;
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
  // 三色分档（半兰伯特 + 两道羽化；羽化取 max(给定值, 1.2 像素)）
  float hl = 0.5 * dot( N, L ) + 0.5 + en;
  float hlS = hl * mix( 1.0 - uShadowDepth, 1.0, att );
  float f1 = max( uFeather1, fwidth( hlS ) * 1.2 );
  float m1 = clamp( ( uStep1 - hlS ) / f1 + 0.5, 0.0, 1.0 );
  m1 = max( m1, uCastShade * ( 1.0 - att ) );
  float f2 = max( uFeather2, fwidth( hl ) * 1.2 );
  float m2 = clamp( ( uStep2 - hl ) / f2 + 0.5, 0.0, 1.0 );
  vec3 col = mix( alb * uLitTint, mix( alb * uShade1Tint, alb * uShade2Tint, m2 ), m1 );
  // 天空冷色补光：只进阴影档里朝天的面
  vec3 skyV = normalize( ( viewMatrix * vec4( uSkyDirW, 0.0 ) ).xyz );
  float sk = dot( N, skyV );
  float fsk = max( 0.02, fwidth( sk ) );
  float skyM = smoothstep( 0.3 - fsk, 0.3 + fsk, sk + en ) * m1 * uSkyAmt * uSkyGain;
  col = mix( col, alb * uSkyTint, clamp( skyM, 0.0, 1.0 ) );
  // 城市暖光：自下而上，两档量化
  vec3 cityV = normalize( ( viewMatrix * vec4( uCityDirW, 0.0 ) ).xyz );
  float cn = dot( N, cityV ) + en * 0.6;
  float fc = max( 0.015, fwidth( cn ) * 1.2 );
  float cm = uCityW1 * smoothstep( uCityStep - fc, uCityStep + fc, cn ) + ( 1.0 - uCityW1 ) * smoothstep( uCityStep2 - fc, uCityStep2 + fc, cn );
  cm *= uCityAmt * uCityGain;
  float lr = clamp( toonLum( alb ) / max( toonLum( toonBase ), 1e-4 ), 0.0, 1.4 );
  vec3 warm = mix( alb * uCityColor * 2.4, uCityColor * mix( 1.0, lr, 0.55 ), uCityFlat );
  col = mix( col, warm, clamp( cm, 0.0, 1.0 ) );
  // 边缘光：Ap（背光侧）+ 受光侧；硬边；内沿用噪声撕开；外侧一道亮芯
  float ndv = clamp( dot( N, V ), 0.0, 1.0 );
  float hlv = clamp( 0.5 * dot( N, L ) + 0.5, 0.0, 1.0 );
  float rn = uRimBreak > 0.0 ? toonNoise( vToonObj * uRimNoiseScale + 211.0 ) * uRimBreak : 0.0;
  float rimBase = 1.0 - ndv;
  float rp = pow( rimBase, exp2( 3.0 * ( 1.0 - uRimPower ) ) ) + en * 0.8 + rn;
  float fr = max( 0.012, fwidth( rp ) * 1.2 );
  float tAp = uRimInside + uRimDirK * hlv;
  float ap = smoothstep( tAp - fr, tAp + fr, rp ) * uRimAmt;
  float ap2 = smoothstep( tAp + uRimCore - fr, tAp + uRimCore + fr, rp - rn * 0.6 ) * uRimAmt * uRimCoreOn;
  float rq = pow( rimBase, exp2( 3.0 * ( 1.0 - uRimLitPower ) ) ) + en * 0.8 + rn;
  float fq = max( 0.012, fwidth( rq ) * 1.2 );
  float tLit = uRimLitInside + uRimLitDirK * ( 1.0 - hlv );
  float rl = smoothstep( tLit - fq, tLit + fq, rq ) * uRimLitAmt * att;
  float rl2 = smoothstep( tLit + uRimLitCore - fq, tLit + uRimLitCore + fq, rq - rn * 0.6 ) * uRimLitAmt * att * uRimLitCoreOn;
  col = mix( col, uRimColor * mix( 1.0, lr, 0.35 ), clamp( ap, 0.0, 1.0 ) );
  col = mix( col, uRimColor2, clamp( ap2, 0.0, 1.0 ) );
  col = mix( col, uRimLitColor, clamp( rl, 0.0, 1.0 ) );
  col = mix( col, uRimLitColor2, clamp( rl2, 0.0, 1.0 ) );
  col = mix( col, uInkColor, clamp( toonInk, 0.0, 1.0 ) );
  col = mix( col, toonOverlay.rgb, clamp( toonOverlay.a, 0.0, 1.0 ) );
  outgoingLight = col * uExposure + totalEmissiveRadiance;
}
`;

const FRAG_PASS = /* glsl */`
if ( uToonPass > 0.5 ) {
  float toonId = fract( uObjectId * 0.7548776662 + vToonInst * uInstIdOn * 0.5698402910 + 0.137 );
  gl_FragColor = vec4( normal * uOutlineW * 0.5 + 0.5, toonId );
}
`;

const SHADOW_ANCHOR = 'return mix( 1.0, shadow, shadowIntensity );';
if (THREE.REVISION !== '170') console.warn(`toon_refine.js 按 three r170 写，当前 r${THREE.REVISION}：锚点不匹配时会直接报错`);

function inject(src, anchor, code, mode = 'after') {
  if (!src.includes(anchor)) throw new Error(`toon_refine.js：着色器锚点缺失「${anchor.slice(0, 60)}」（three r${THREE.REVISION}，本模块按 r170 写）`);
  const rep = mode === 'after' ? anchor + '\n' + code : mode === 'before' ? code + '\n' + anchor : code;
  return src.replace(anchor, () => rep);
}
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
const vec3Of = v => v instanceof THREE.Vector3 ? v.clone() : Array.isArray(v) ? new THREE.Vector3(...v) : new THREE.Vector3(v.x, v.y, v.z);
const colorOf = c => c instanceof THREE.Color ? c.clone() : new THREE.Color(c);

let _objectId = 101;   // 与 toon.js（从 1 起编）错开
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
 * makeToonMaterial(opts) → THREE.MeshToonMaterial（已打补丁），参数同 toon.js，另加本文件 TOON_DEFAULTS 里的新键
 * 钩子：vertexPars / vertexMainStart / vertexBegin / vertexNormal / fragmentPars / fragmentAlbedo / fragmentNormal
 * fragmentAlbedo 里可写 diffuseColor.rgb、toonInk、toonOverlay、toonRelief；fragmentNormal 里可改 normal
 */
export function makeToonMaterial(opts = {}) {
  const o = { ...TOON_DEFAULTS, ...opts };
  const base = colorOf(o.color);
  const t1 = o.shade1 ? tintFrom(o.color, o.shade1) : vec3Of(o.shade1Tint);
  const t2 = o.shade2 ? tintFrom(o.color, o.shade2) : vec3Of(o.shade2Tint);
  const mat = new THREE.MeshToonMaterial({ color: base, side: o.side, fog: o.fog,
    transparent: !!o.transparent, opacity: o.opacity ?? 1, map: o.map || null });
  const u = {
    uLitTint: { value: vec3Of(o.litTint) }, uShade1Tint: { value: t1 }, uShade2Tint: { value: t2 },
    uStep1: { value: o.step1 }, uFeather1: { value: Math.max(0.01, o.feather1) }, uStep2: { value: o.step2 }, uFeather2: { value: Math.max(0.01, o.feather2) },
    uShadowDepth: { value: o.shadowDepth }, uCastShade: { value: o.castShade }, uShadowLo: { value: o.shadowLo }, uShadowHi: { value: o.shadowHi },
    uEdgeNoise: { value: o.edgeNoise }, uEdgeNoiseScale: { value: o.edgeNoiseScale },
    uRimColor: { value: colorOf(o.rimColor) }, uRimColor2: { value: colorOf(o.rimColor2 || o.rimColor) }, uRimCoreOn: { value: o.rimColor2 ? 1 : 0 }, uRimCore: { value: o.rimCore },
    uRimAmt: { value: o.rimAmt }, uRimPower: { value: o.rimPower }, uRimInside: { value: o.rimInside }, uRimDirK: { value: o.rimDirK },
    uRimLitColor: { value: colorOf(o.rimLitColor) }, uRimLitColor2: { value: colorOf(o.rimLitColor2 || o.rimLitColor) }, uRimLitCoreOn: { value: o.rimLitColor2 ? 1 : 0 }, uRimLitCore: { value: o.rimLitCore },
    uRimLitAmt: { value: o.rimLitAmt }, uRimLitDirK: { value: o.rimLitDirK }, uRimLitInside: { value: o.rimLitInside }, uRimLitPower: { value: o.rimLitPower },
    uRimBreak: { value: o.rimBreak }, uRimNoiseScale: { value: o.rimNoiseScale },
    uCityColor: { value: colorOf(o.cityColor) }, uCityAmt: { value: o.cityAmt }, uCityStep: { value: o.cityStep }, uCityStep2: { value: o.cityStep2 }, uCityW1: { value: o.cityW1 }, uCityFlat: { value: o.cityFlat },
    uSkyTint: { value: vec3Of(o.skyTint) }, uSkyAmt: { value: o.skyAmt },
    uPatchScale: { value: o.patchScale }, uPatchStretch: { value: o.patchStretch },
    uRustColor: { value: colorOf(o.rustColor) }, uRustAmt: { value: o.rustAmt }, uRustThr: { value: o.rustThr },
    uRustBreak: { value: o.rustBreak }, uRustPool: { value: o.rustPool }, uRustSpatter: { value: o.rustSpatter }, uSpatterScale: { value: o.spatterScale }, uRustDapple: { value: o.rustDapple },
    uAlgaeColor: { value: colorOf(o.algaeColor) }, uAlgaeAmt: { value: o.algaeAmt }, uAlgaeThr: { value: o.algaeThr },
    uSpotColor: { value: colorOf(o.spotColor) }, uSpotAmt: { value: o.spotAmt }, uSpotThr: { value: o.spotThr }, uSpotScale: { value: o.spotScale }, uSpotCluster: { value: o.spotCluster },
    uDabAmt: { value: o.dabAmt }, uDabScale: { value: o.dabScale }, uDabWarm: { value: o.dabWarm },
    uStrokeAmt: { value: o.strokeAmt }, uStrokeScale: { value: o.strokeScale }, uStrokeStretch: { value: o.strokeStretch }, uStrokeDir: { value: vec3Of(o.strokeDir) },
    uGrainAmt: { value: o.grainAmt }, uGrainScale: { value: o.grainScale },
    uInkColor: { value: colorOf(o.inkColor) }, uObjectId: { value: o.objectId ?? _objectId++ },
    uOutlineW: { value: o.outlineW }, uInstIdOn: { value: o.instanceId ? 1 : 0 },
    ...TOON_SHARED, ...(o.uniforms || {}),
  };
  const defines = o.defines || {};
  const key = 'toon-refine-r170-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, o.vertexNormal, o.fragmentPars, o.fragmentAlbedo, o.fragmentNormal, JSON.stringify(defines)].join('§'));
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), defines);
    sh.vertexShader = vertexInject(sh.vertexShader, o, true);
    const sm = THREE.ShaderChunk.shadowmap_pars_fragment;
    if (!sm.includes(SHADOW_ANCHOR)) throw new Error(`toon_refine.js：投影量化锚点缺失（three r${THREE.REVISION}）：${SHADOW_ANCHOR}`);
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

export function makeToonDepthMaterial(mat) {
  const o = mat.userData.toonOpts || {};
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const u = mat.userData.toon;
  const key = 'toon-refine-depth-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, JSON.stringify(o.defines || {})].join('§'));
  d.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), o.defines || {});
    sh.vertexShader = vertexInject(sh.vertexShader, { ...o, vertexNormal: '' }, false);
  };
  d.customProgramCacheKey = () => key;
  return d;
}

// 挂材质 + 投影深度材质 + 描边标记（userData 同时写 toon.js 的 outlineWeight 和 look.js 的 outlineWidth）
export function bindToon(mesh, mat, { castShadow = true, receiveShadow = true, outline = true } = {}) {
  mesh.material = mat;
  const o = mat.userData.toonOpts || {};
  if (o.vertexPars || o.vertexBegin || o.vertexMainStart) mesh.customDepthMaterial = makeToonDepthMaterial(mat);
  mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
  mesh.userData.outline = outline;
  mesh.userData.outlineId = mat.userData.toon.uObjectId.value;
  mesh.userData.outlineWeight = mat.userData.toon.uOutlineW.value;
  mesh.userData.outlineWidth = mat.userData.toon.uOutlineW.value;
  mesh.userData.outlinePerInstance = !!mesh.isInstancedMesh && mat.userData.toon.uInstIdOn.value > 0.5;
  mesh.userData.instanced = !!mesh.isInstancedMesh;
  return mesh;
}
