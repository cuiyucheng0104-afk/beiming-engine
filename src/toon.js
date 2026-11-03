// 卡通着色材质（三渲二配方第 2 层）
// 底材质 MeshToonMaterial + onBeforeCompile（three r170，锚点逐条 throw 校验）：
//   · 三色分档：基色 / 一档阴影 / 二档阴影，两道羽化（羽化 ≥ 0.015，另叠 fwidth 抗锯齿，逐帧导出不闪）
//   · 投影量化：getShadow 的返回值过 smoothstep，并把投影区强制压进阴影档
//   · Ap 背光边缘光（硬边），可选受光侧边缘光
//   · 物体空间确定性噪声：紫色锈斑（带深色斑心）、藻斑、深色小斑点；明暗交界线加噪声扰动，像笔触边缘
//   · 城市暖光自下而上补光（两档量化）、天空冷色补光（只进阴影档）
//   · 输出模式 TOON_SHARED.uToonPass：0 彩色；1 视空间法线 + 物体/实例 ID（给后期做屏幕空间描边）
// 约定：
//   · 主光 = 场景里第一盏投影的 DirectionalLight（three 会把投影灯排在前面）。灯只提供方向和投影，
//     颜色全部按色板绝对给定，不随灯光强度变；环境光、半球光对本材质无效。
//   · 色板颜色用 THREE.Color 转到线性工作空间；输出到屏幕时由 three 转回 sRGB。保色板请用 NoToneMapping。
//   · 所有噪声是坐标的纯函数，没有时间和随机数，任意帧单独渲染结果一致。
import * as THREE from 'three';

// —— 色板（导演定调 / 任务书给定） ——
export const PALETTE = {
  zenith: '#4F5BBF', lavender: '#9C8FD8', pink: '#F2A0A6', apricot: '#FFB26B',
  cloudShade: '#8E7CC3', cloudLit: '#F7A98F', city: '#4B4A8C', window: '#FFC46B',
  kunBase: '#6E7BA8', kunShade1: '#4E5888', kunShade2: '#343D69', kunRim: '#FFD3B0', kunBelly: '#F2A36B',
  barnacle: '#E9DCC9', barnacleShade: '#9A8FA8', weedA: '#5E8A5A', weedB: '#3E6B4A',
  coral: '#F07F86', anemone: '#FFF4EA', rust: '#7A5C9E', ink: '#2A2D52', hud: '#EAF6FF', hudAccent: '#9FE8FF',
};

// 阴影色 / 基色（线性空间逐通道比值）→ 乘法色调。实例色物体靠它让每个实例都有自己的三档色
export function tintFrom(base, shade) {
  const b = new THREE.Color(base), s = new THREE.Color(shade);
  return new THREE.Vector3(s.r / Math.max(b.r, 1e-4), s.g / Math.max(b.g, 1e-4), s.b / Math.max(b.b, 1e-4));
}
const KUN_T1 = tintFrom(PALETTE.kunBase, PALETTE.kunShade1);   // 约 (0.47, 0.48, 0.63)：变暗并偏冷
const KUN_T2 = tintFrom(PALETTE.kunBase, PALETTE.kunShade2);   // 约 (0.20, 0.23, 0.36)

// —— 全场共享的 uniform（所有 toon 材质引用同一个对象，改一处全场生效） ——
export const TOON_SHARED = {
  uToonPass: { value: 0 },                                         // 0 彩色；1 法线 + ID
  uInkTime: { value: 0 },                                          // 墨线抖动时钟，建议 floor(frame/2)
  uExposure: { value: 1 },                                         // 整体提亮（片尾日光）
  uCityDirW: { value: new THREE.Vector3(0, -1, 0) },               // 城市光“来自”的方向（世界空间，指向光源）
  uCityGain: { value: 1 },                                         // 城市暖光总开关 / 强度
  uSkyDirW: { value: new THREE.Vector3(0, 1, 0) },                 // 天空光来自的方向
  uSkyGain: { value: 1 },
  uKeyDirW: { value: new THREE.Vector3(-0.6, 0.15, 0.78).normalize() },  // 场景里没有平行光时的主光方向（指向光源）
};

// 统一设置共享参数：setToonGlobals({ cityDir:[x,y,z], cityGain, skyGain, exposure, inkTime, keyDir, pass })
export function setToonGlobals(g = {}) {
  const S = TOON_SHARED;
  if (g.cityDir) S.uCityDirW.value.set(...g.cityDir).normalize();
  if (g.skyDir) S.uSkyDirW.value.set(...g.skyDir).normalize();
  if (g.keyDir) S.uKeyDirW.value.set(...g.keyDir).normalize();
  for (const [k, u] of [['cityGain', 'uCityGain'], ['skyGain', 'uSkyGain'], ['exposure', 'uExposure'], ['inkTime', 'uInkTime'], ['pass', 'uToonPass']])
    if (g[k] !== undefined) S[u].value = g[k];
}

// —— 默认参数（供合成代理给渡船等其它物体复用：makeToonMaterial({ ...TOON_DEFAULTS, color: '#C04A3C' })） ——
// 分档在 hl = 0.5·N·L + 0.5 上做：hl > step1 为亮面；hl < step2 为二档暗部。
export const TOON_DEFAULTS = {
  color: PALETTE.kunBase,
  shade1: null, shade2: null,                 // 直接给阴影色（单色物体）；null 时用下面的乘法色调
  shade1Tint: KUN_T1, shade2Tint: KUN_T2,     // 实例色物体：阴影色 = 实例色 × 色调
  litTint: [1, 1, 1],
  step1: 0.56, feather1: 0.02,                // 亮 / 一档（作用于含投影的 hl）
  step2: 0.32, feather2: 0.03,                // 一档 / 二档（作用于原始 hl）
  shadowDepth: 0.5, castShade: 1,             // 投影压低 hl 的比例；投影区强制进阴影档
  shadowLo: 0.42, shadowHi: 0.58,             // 投影量化窗口（越窄越像色块）
  edgeNoise: 0.03, edgeNoiseScale: 0.06,      // 明暗交界线扰动幅度 / 频率（1/物体单位）
  rimColor: PALETTE.kunRim, rimAmt: 1, rimPower: 0.2, rimInside: 0.42, rimDirK: 0.3,       // Ap 背光边缘光
  rimLitColor: PALETTE.kunRim, rimLitAmt: 0, rimLitInside: 0.2, rimLitPower: 0.4, rimLitDirK: 0.3,   // 受光侧边缘光（默认关）
  cityColor: PALETTE.kunBelly, cityAmt: 0, cityStep: 0.45, cityStep2: 0.8, cityW1: 0.45, cityFlat: 0.6,  // 城市暖光：两档阈值作用于 N·(指向城市)
  skyTint: [0.8, 0.88, 1.18], skyAmt: 0,      // 天空冷光：阴影档里朝天的面改用 基色 × skyTint
  patchScale: 0.05,                           // 斑块频率（1/物体单位）
  rustColor: PALETTE.rust, rustAmt: 0, rustThr: 0.1,
  algaeColor: '#5f7f74', algaeAmt: 0, algaeThr: 0.28,
  spotColor: PALETTE.ink, spotAmt: 0, spotThr: 0.5, spotScale: 6,
  dabAmt: 0, dabScale: 1.2,                  // 笔触斑驳（植被用）：物体空间高频噪声量化成深浅两三档
  inkColor: PALETTE.ink,
  outlineW: 1, instanceId: true,              // 描边通道：法线长度 = 描边权重；instanceId=false 时整批实例同一个 ID（只画外轮廓）
  side: THREE.FrontSide, fog: true,
};

// 常用预设（tests 与 kun.js 用；合成代理也可直接拿去）
export const TOON_PRESETS = {
  generic: {},
  kun: { color: PALETTE.kunBase, shade1: PALETTE.kunShade1, shade2: PALETTE.kunShade2, step1: 0.53, step2: 0.17,
    rustAmt: 0.9, rustThr: 0.04, algaeAmt: 0.55, algaeColor: '#8fa69e', algaeThr: 0.3, spotAmt: 0.8,
    cityAmt: 0.92, cityStep: 0.6, cityStep2: 0.94, cityW1: 0.42, cityFlat: 0.55, skyAmt: 0.75,
    rimAmt: 0.6, rimColor: PALETTE.pink, rimPower: 0.4, rimInside: 0.3, rimDirK: 0.5,
    rimLitAmt: 1, rimLitColor: PALETTE.kunRim, rimLitPower: 0.55, rimLitInside: 0.1, rimLitDirK: 0.55 },
  barnacle: { color: '#ffffff', shade1Tint: tintFrom(PALETTE.barnacle, PALETTE.barnacleShade), shade2Tint: tintFrom(PALETTE.barnacle, '#6a6488'),
    step1: 0.5, step2: 0.18, rimAmt: 0.5, rimInside: 0.5, cityAmt: 0.6, cityFlat: 0.3, edgeNoise: 0.02, skyAmt: 0.5, skyTint: [0.85, 0.85, 0.98] },
  seaweed: { color: '#ffffff', shade1Tint: tintFrom('#8DB36A', PALETTE.weedA), shade2Tint: tintFrom('#8DB36A', PALETTE.weedB), step1: 0.5, step2: 0.14, dabAmt: 0.16, dabScale: 1.1,
    rimAmt: 0.5, rimColor: PALETTE.pink, rimInside: 0.4, rimLitAmt: 0.9, rimLitInside: 0.15, rimLitPower: 0.5, rimLitDirK: 0.5, rimPower: 0.3,
    cityAmt: 0.5, cityFlat: 0.25, edgeNoise: 0.04, skyAmt: 0.6, skyTint: [0.82, 0.95, 1.0] },
  coral: { color: '#ffffff', shade1Tint: [0.6, 0.45, 0.72], shade2Tint: [0.34, 0.24, 0.5], step1: 0.5, step2: 0.2, rimAmt: 0.5, rimInside: 0.45, rimLitAmt: 0.8, rimLitInside: 0.15, rimLitPower: 0.5, rimLitDirK: 0.5, cityAmt: 0.5, cityFlat: 0.3, skyAmt: 0.5, skyTint: [0.85, 0.8, 1.0] },
  shell: { color: '#ffffff', shade1Tint: [0.62, 0.55, 0.74], shade2Tint: [0.36, 0.32, 0.52], step1: 0.5, step2: 0.2, rimAmt: 0.5, rimInside: 0.5, cityAmt: 0.55, cityFlat: 0.35, skyAmt: 0.5, skyTint: [0.88, 0.86, 1.0] },
  anemone: { color: '#ffffff', shade1Tint: tintFrom(PALETTE.anemone, '#c4b4cf'), shade2Tint: tintFrom(PALETTE.anemone, PALETTE.barnacleShade),
    step1: 0.45, step2: 0.16, rimAmt: 0.4, rimInside: 0.55, cityAmt: 0.55, cityFlat: 0.3, skyAmt: 0.7, skyTint: [0.92, 0.92, 1.0] },
};

// —— GLSL：确定性噪声（Hoskins 无正弦哈希 + 梯度噪声 + 4 层 fbm），值域约 [-1, 1] ——
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
// 边界顺序任意的 smoothstep（GLSL 规范里 edge0 >= edge1 是未定义行为）
float toonSS( float a, float b, float x ) { float t = clamp( ( x - a ) / ( b - a ), 0.0, 1.0 ); return t * t * ( 3.0 - 2.0 * t ); }
float toonFbm( vec3 p ) {
  float s = 0.0, a = 0.5;
  for ( int k = 0; k < 4; k ++ ) { s += a * toonNoise( p ); p = p * 2.03 + vec3( 1.7, 9.2, 3.1 ); a *= 0.5; }
  return s;
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

// 表面斑块：紫色锈斑（深色斑心）、藻斑、小斑点。物体空间坐标 → 斑块贴在表面上，不随动画滑动
const FRAG_PATCHES = /* glsl */`
vec3 toonBase = diffuseColor.rgb;
float toonInk = 0.0;          // 钩子可写：0..1，往墨线色混
vec4 toonOverlay = vec4( 0.0 ); // 钩子可写：不受光照的覆盖色（rgb, 量）
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
  // 边缘光：Ap（背光侧，hlV 越小越亮）+ 受光侧；都是硬边
  float ndv = clamp( dot( N, V ), 0.0, 1.0 );
  float hlv = clamp( 0.5 * dot( N, L ) + 0.5, 0.0, 1.0 );
  float rp = pow( 1.0 - ndv, exp2( 3.0 * ( 1.0 - uRimPower ) ) ) + en * 0.8;          // 加噪声：边缘光内沿像笔触
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
  gl_FragColor = vec4( normal * uOutlineW * 0.5 + 0.5, toonId );
}
`;

const SHADOW_ANCHOR = 'return mix( 1.0, shadow, shadowIntensity );';
if (THREE.REVISION !== '170') console.warn(`toon.js 按 three r170 写，当前 r${THREE.REVISION}：锚点不匹配时会直接报错`);

function inject(src, anchor, code, mode = 'after') {
  if (!src.includes(anchor)) throw new Error(`toon.js：着色器锚点缺失「${anchor.slice(0, 60)}」（three r${THREE.REVISION}，本模块按 r170 写）`);
  const rep = mode === 'after' ? anchor + '\n' + code : mode === 'before' ? code + '\n' + anchor : code;
  return src.replace(anchor, () => rep);
}
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
const vec3Of = v => v instanceof THREE.Vector3 ? v.clone() : Array.isArray(v) ? new THREE.Vector3(...v) : new THREE.Vector3(v.x, v.y, v.z);
const colorOf = c => c instanceof THREE.Color ? c.clone() : new THREE.Color(c);

let _objectId = 1;
// 顶点钩子（vertex*）也给阴影深度材质用，保证投影跟着形变走
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
 * makeToonMaterial(opts) → THREE.MeshToonMaterial（已打补丁）
 * opts：TOON_DEFAULTS 里的任意键，另加
 *   uniforms        额外 uniform（可传共享对象，例如鲲的姿态时钟）
 *   defines         额外宏
 *   vertexPars / vertexMainStart / vertexBegin(改 transformed) / vertexNormal(改 objectNormal)
 *   fragmentPars / fragmentAlbedo(改 diffuseColor.rgb、toonInk、toonOverlay) / fragmentNormal(改 normal)
 *   objectId        描边用的物体 ID（默认自动递增）
 * 运行时调参：mat.userData.toon.uXxx.value = …；共享参数用 setToonGlobals。
 * 有顶点钩子时，用 bindToon(mesh, mat) 挂上同样形变的阴影深度材质。
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
  const key = 'toon-r170-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, o.vertexNormal, o.fragmentPars, o.fragmentAlbedo, o.fragmentNormal, JSON.stringify(defines)].join('§'));
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), defines);
    sh.vertexShader = vertexInject(sh.vertexShader, o, true);
    // 片元：参数 → 量化投影 → 斑块 → 法线钩子 → 卡通合成 → 输出模式
    const sm = THREE.ShaderChunk.shadowmap_pars_fragment;
    if (!sm.includes(SHADOW_ANCHOR)) throw new Error(`toon.js：投影量化锚点缺失（three r${THREE.REVISION}）：${SHADOW_ANCHOR}`);
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

// 阴影深度材质：带同样的顶点形变（弯曲、摆动），否则投影和形体对不上
export function makeToonDepthMaterial(mat) {
  const o = mat.userData.toonOpts || {};
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const u = mat.userData.toon;
  const key = 'toon-depth-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, JSON.stringify(o.defines || {})].join('§'));
  d.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), o.defines || {});
    sh.vertexShader = vertexInject(sh.vertexShader, { ...o, vertexNormal: '' }, false);
  };
  d.customProgramCacheKey = () => key;
  return d;
}

// 挂材质 + 投影深度材质 + 描边标记
export function bindToon(mesh, mat, { castShadow = true, receiveShadow = true, outline = true } = {}) {
  mesh.material = mat;
  const o = mat.userData.toonOpts || {};
  if (o.vertexPars || o.vertexBegin || o.vertexMainStart) mesh.customDepthMaterial = makeToonDepthMaterial(mat);
  mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
  mesh.userData.outline = outline;
  mesh.userData.outlineId = mat.userData.toon.uObjectId.value;
  mesh.userData.outlineWeight = mat.userData.toon.uOutlineW.value;
  mesh.userData.outlinePerInstance = !!mesh.isInstancedMesh && mat.userData.toon.uInstIdOn.value > 0.5;
  mesh.userData.instanced = !!mesh.isInstancedMesh;
  return mesh;
}
