// 鲲鹏将化 专用卡通材质（由 src/toon.js 复制改写；三色分档、投影量化、Ap 背光边缘光、城市暖光的算法与 toon.js 相同）
// 和 toon.js 的区别：
//   · 共享 uniform 直接用 toon.js 导出的 TOON_SHARED（同一个对象）：正片里 setToonGlobals({ pass, inkTime, … }) 对本材质同样生效，
//     换进正片只需把 import 从 './kun.js' 改成 './kun_peng.js'
//   · rest:true 时，物体空间噪声坐标取顶点属性 aRest（CPU 形变的网格用：纹样贴在静止形体上，不随摆动滑动）
//   · 新增「壁画风化」一层（敦煌壁画式斑驳）：褪色大斑（向地仗色靠）、干笔飞白小剥落、氧化暗斑、细碎点，全部是坐标的纯函数；
//     高频部分按屏幕频率自动淡出，远景不闪
//   · 钩子里可写 toonMuralP（风化噪声坐标）、toonMuralK（本像素风化量倍率）、toonInk、toonOverlay
//   · bindPeng 同时写 toon.js 的描边标记（outlineId/outlineWeight）和 look.js 的描边标记（outline/outlineWidth/outlinePerInstance）
// 约定同 toon.js：主光 = 场景里第一盏投影的平行光，只取方向和投影；颜色全部按色板给定；保色板请用 NoToneMapping。
import * as THREE from 'three';
import { TOON_SHARED, setToonGlobals, PALETTE } from './toon.js';
export { TOON_SHARED, setToonGlobals, PALETTE };

// —— 敦煌矿物色（sRGB）：石青、石绿、朱砂、赭石、土黄、月白；墨色沿用全片的深蓝灰 ——
export const PENG = {
  shiqing: '#2C5C9C', shiqingL: '#4F80C0', shiqingD: '#1F3F78',      // 石青（蓝铜矿）
  shilv: '#3E9A7C', shilvL: '#76BE9E', shilvD: '#2A6F60',            // 石绿（孔雀石）
  qinglv: '#3D8C92',                                                 // 青绿过渡
  zhusha: '#C7412E', zhushaL: '#E2683C', zhushaD: '#8E2A24',          // 朱砂
  zheshi: '#9C5530', tuhuang: '#D9A64C', tuhuangL: '#EBC57A',        // 赭石、土黄
  yuebai: '#EAE8DA', cream: '#F0E2C2', creamD: '#D9C29A',            // 月白、米白
  ground: '#E6D3AC', stain: '#4A3A4E', gold: '#D7A64A',             // 地仗色、氧化暗斑、描金
  ink: PALETTE.ink, rim: '#FFD3B0', rimPink: '#F2A0A6', city: '#F2A36B',
};

// 阴影色 / 基色（线性空间逐通道比值）→ 乘法色调
export function tintFrom(base, shade) {
  const b = new THREE.Color(base), s = new THREE.Color(shade);
  return new THREE.Vector3(s.r / Math.max(b.r, 1e-4), s.g / Math.max(b.g, 1e-4), s.b / Math.max(b.b, 1e-4));
}

// —— 默认参数：矿物色在逆光暗面里也要认得出颜色，所以阴影色调比 toon.js 的鲲浅、冷得少 ——
export const PENG_DEFAULTS = {
  color: '#ffffff',
  shade1: null, shade2: null,
  shade1Tint: [0.6, 0.64, 0.8], shade2Tint: [0.38, 0.41, 0.6],
  litTint: [1, 1, 1],
  step1: 0.53, feather1: 0.02,
  step2: 0.12, feather2: 0.03,
  shadowDepth: 0.5, castShade: 1,
  shadowLo: 0.42, shadowHi: 0.58,
  edgeNoise: 0.03, edgeNoiseScale: 0.06,
  rimColor: PENG.rimPink, rimAmt: 0.6, rimPower: 0.4, rimInside: 0.3, rimDirK: 0.5,
  rimLitColor: PENG.rim, rimLitAmt: 1, rimLitInside: 0.1, rimLitPower: 0.55, rimLitDirK: 0.55,
  cityColor: PENG.city, cityAmt: 0.85, cityStep: 0.6, cityStep2: 0.94, cityW1: 0.42, cityFlat: 0.5,
  skyTint: [0.82, 0.9, 1.15], skyAmt: 0.6, skyStep: 0.3,
  // 壁画风化
  muralAmt: 0, muralScale: 0.06, muralGround: PENG.ground, stainTint: [0.62, 0.55, 0.62],
  fleckThr: 0.42, fleckAmt: 0.55, fleckFreq: 8, chipThr: 0.36, chipAmt: 0.55, fadeAmt: 0.3, stainAmt: 0.4, dotAmt: 0.45,
  inkColor: PENG.ink,
  outlineW: 1, instanceId: true,
  rest: false,
  side: THREE.FrontSide, fog: true,
};

// —— GLSL：确定性噪声（与 toon.js 相同） ——
const NOISE_GLSL = /* glsl */`
vec3 toonHash33( vec3 p3 ) {
  p3 = fract( p3 * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yxx ) * p3.zyx ) * 2.0 - 1.0;
}
float toonHash13( vec3 p3 ) { p3 = fract( p3 * 0.1031 ); p3 += dot( p3, p3.zyx + 31.32 ); return fract( ( p3.x + p3.y ) * p3.z ); }
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
// 抗锯齿的细线：d = 到线的距离（任意单位），w = 半线宽（同单位）
float toonLine( float d, float w ) { float f = max( fwidth( d ), 1e-5 ); return 1.0 - smoothstep( w - 0.5 * f, w + 0.9 * f, abs( d ) ); }
// 屏幕频率淡出：坐标 q 每像素变化超过 lo 个单位开始淡，hi 完全淡出（细节在远景自动消失，避免摩尔纹）
float toonFar( vec2 q, float lo, float hi ) { vec2 w = fwidth( q ); return 1.0 - smoothstep( lo, hi, max( w.x, w.y ) ); }
`;

const FRAG_PARS = /* glsl */`
uniform vec3 uLitTint, uShade1Tint, uShade2Tint;
uniform float uStep1, uFeather1, uStep2, uFeather2, uShadowDepth, uCastShade, uShadowLo, uShadowHi;
uniform float uEdgeNoise, uEdgeNoiseScale;
uniform vec3 uRimColor; uniform float uRimAmt, uRimPower, uRimInside, uRimDirK;
uniform vec3 uRimLitColor; uniform float uRimLitAmt, uRimLitDirK, uRimLitInside, uRimLitPower;
uniform vec3 uCityColor; uniform float uCityAmt, uCityStep, uCityStep2, uCityW1, uCityFlat;
uniform vec3 uSkyTint; uniform float uSkyAmt, uSkyStep;
uniform float uMuralAmt, uMuralScale, uFleckThr, uFleckAmt, uFleckFreq, uChipThr, uChipAmt, uFadeAmt, uStainAmt, uDotAmt;
uniform vec3 uMuralGround, uStainTint;
uniform vec3 uInkColor; uniform float uObjectId, uOutlineW, uInstIdOn;
uniform float uToonPass, uInkTime, uExposure, uCityGain, uSkyGain;
uniform vec3 uCityDirW, uSkyDirW, uKeyDirW;
varying vec3 vToonObj;
flat varying float vToonInst;
float toonLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
${NOISE_GLSL}
`;

// 反照率阶段的开头：钩子之前的公共变量
const FRAG_ALBEDO_HEAD = /* glsl */`
vec3 toonBase = diffuseColor.rgb;
float toonInk = 0.0;            // 钩子可写：0..1，往墨线色混（光照之后）
vec4 toonOverlay = vec4( 0.0 ); // 钩子可写：不受光照的覆盖色（rgb, 量）
vec3 toonMuralP = vToonObj;     // 钩子可写：风化噪声坐标
float toonMuralK = 1.0;         // 钩子可写：本像素风化量倍率
`;

// 壁画风化（钩子之后、光照之前）
const FRAG_MURAL = /* glsl */`
if ( uMuralAmt > 0.0 && toonMuralK > 0.0 ) {
  vec3 Pm = toonMuralP * uMuralScale;
  float amt = uMuralAmt * toonMuralK;
  // 1) 褪色大斑：颜料层变薄，向地仗色靠（软边，分两档）
  float fn = toonFbm( Pm * 0.45 + vec3( 3.1, 7.7, 1.3 ) );
  float fa = max( fwidth( fn ), 1e-4 );
  float fade = 0.55 * smoothstep( 0.02 - fa, 0.02 + fa, fn ) + 0.45 * smoothstep( 0.22 - fa, 0.22 + fa, fn );
  diffuseColor.rgb = mix( diffuseColor.rgb, mix( diffuseColor.rgb, uMuralGround, 0.55 ), fade * uFadeAmt * amt );
  // 2) 干笔飞白：细碎小白点（高频两层，硬边）
  vec3 Q = Pm * uFleckFreq + vec3( 11.0, -4.0, 2.0 );
  float fl = 0.75 * toonNoise( Q ) + 0.45 * toonNoise( Q * 2.6 + 5.0 );
  float afl = max( fwidth( fl ), 1e-4 );
  float farK = 1.0 - smoothstep( 0.3, 0.75, length( fwidth( Q ) ) );
  float flake = smoothstep( uFleckThr - afl, uFleckThr + afl, fl ) * farK;
  // 2b) 剥落块：偶尔一块大些的，露出地仗
  vec3 Q2 = Pm * 1.5 + vec3( -7.0, 13.0, 5.0 );
  float ch = toonFbm( Q2 ) + 0.25 * toonNoise( Q2 * 4.0 );
  float ach = max( fwidth( ch ), 1e-4 );
  float chip = smoothstep( uChipThr - ach, uChipThr + ach, ch );
  diffuseColor.rgb = mix( diffuseColor.rgb, uMuralGround, max( flake * uFleckAmt, chip * uChipAmt ) * amt );
  // 3) 氧化暗斑（铅丹 / 铅白变色那种发暗的斑）
  float sn = toonFbm( Pm * 0.8 + vec3( 21.0, 3.0, 9.0 ) );
  float sa = max( fwidth( sn ), 1e-4 );
  float stain = smoothstep( 0.3 - sa, 0.3 + sa, sn ) * ( 1.0 - flake ) * ( 1.0 - chip );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uStainTint, stain * uStainAmt * amt );
  // 4) 细碎点：深浅两种
  vec3 D = Pm * uFleckFreq * 1.9 + vec3( 57.0 );
  float dn = toonNoise( D ), da = max( fwidth( dn ), 1e-4 );
  float farD = 1.0 - smoothstep( 0.3, 0.7, length( fwidth( D ) ) );
  float dk = smoothstep( 0.62 - da, 0.62 + da, dn ) * farD, dl = smoothstep( 0.62 - da, 0.62 + da, - dn ) * farD;
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.55, 0.5, 0.6 ), dk * uDotAmt * amt );
  diffuseColor.rgb = mix( diffuseColor.rgb, uMuralGround, dl * uDotAmt * 0.6 * amt );
}
`;

// 卡通光照合成（与 toon.js 相同）
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
  float hl = 0.5 * dot( N, L ) + 0.5 + en;
  float hlS = hl * mix( 1.0 - uShadowDepth, 1.0, att );
  float f1 = max( uFeather1, fwidth( hlS ) * 1.2 );
  float m1 = clamp( ( uStep1 - hlS ) / f1 + 0.5, 0.0, 1.0 );
  m1 = max( m1, uCastShade * ( 1.0 - att ) );
  float f2 = max( uFeather2, fwidth( hl ) * 1.2 );
  float m2 = clamp( ( uStep2 - hl ) / f2 + 0.5, 0.0, 1.0 );
  vec3 col = mix( alb * uLitTint, mix( alb * uShade1Tint, alb * uShade2Tint, m2 ), m1 );
  vec3 skyV = normalize( ( viewMatrix * vec4( uSkyDirW, 0.0 ) ).xyz );
  float sk = dot( N, skyV );
  float fsk = max( 0.02, fwidth( sk ) );
  float skyM = smoothstep( uSkyStep - fsk, uSkyStep + fsk, sk + en ) * m1 * uSkyAmt * uSkyGain;
  col = mix( col, alb * uSkyTint, clamp( skyM, 0.0, 1.0 ) );
  vec3 cityV = normalize( ( viewMatrix * vec4( uCityDirW, 0.0 ) ).xyz );
  float cn = dot( N, cityV ) + en * 0.6;
  float fc = max( 0.015, fwidth( cn ) * 1.2 );
  float cm = uCityW1 * smoothstep( uCityStep - fc, uCityStep + fc, cn ) + ( 1.0 - uCityW1 ) * smoothstep( uCityStep2 - fc, uCityStep2 + fc, cn );
  cm *= uCityAmt * uCityGain;
  float lr = clamp( toonLum( alb ) / max( toonLum( toonBase ), 1e-4 ), 0.0, 1.4 );
  vec3 warm = mix( alb * uCityColor * 2.4, uCityColor * mix( 1.0, lr, 0.55 ), uCityFlat );
  col = mix( col, warm, clamp( cm, 0.0, 1.0 ) );
  float ndv = clamp( dot( N, V ), 0.0, 1.0 );
  float hlv = clamp( 0.5 * dot( N, L ) + 0.5, 0.0, 1.0 );
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
  gl_FragColor = vec4( normal * uOutlineW * 0.5 + 0.5, toonId );
}
`;

const SHADOW_ANCHOR = 'return mix( 1.0, shadow, shadowIntensity );';
function inject(src, anchor, code, mode = 'after') {
  if (!src.includes(anchor)) throw new Error(`toon_peng.js：着色器锚点缺失「${anchor.slice(0, 60)}」（three r${THREE.REVISION}，本模块按 r170 写）`);
  const rep = mode === 'after' ? anchor + '\n' + code : mode === 'before' ? code + '\n' + anchor : code;
  return src.replace(anchor, () => rep);
}
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
const vec3Of = v => v instanceof THREE.Vector3 ? v.clone() : Array.isArray(v) ? new THREE.Vector3(...v) : new THREE.Vector3(v.x, v.y, v.z);
const colorOf = c => c instanceof THREE.Color ? c.clone() : new THREE.Color(c);

let _objectId = 501;   // 与 toon.js 的 ID 段错开
function vertexInject(src, o) {
  let s = src;
  s = inject(s, '#include <common>', 'varying vec3 vToonObj;\nflat varying float vToonInst;\n' + (o.rest ? 'attribute vec3 aRest;\n' : '') + (o.vertexPars || ''));
  s = inject(s, '#include <begin_vertex>',
    (o.rest ? 'vToonObj = aRest;\n' : 'vToonObj = position + float( gl_InstanceID ) * vec3( 1.618, 2.718, 3.1416 );\n') + (o.vertexBegin || ''));
  s = inject(s, '#include <project_vertex>', 'vToonInst = float( gl_InstanceID );');
  return s;
}

/**
 * makePengMaterial(opts) → THREE.MeshToonMaterial（已打补丁）
 * opts：PENG_DEFAULTS 里的任意键，另加
 *   uniforms / defines / vertexPars / vertexBegin（只用来传 varying，不要改 transformed：本鲲的形变都在 CPU 上做）
 *   fragmentPars / fragmentAlbedo（改 diffuseColor.rgb、toonInk、toonOverlay、toonMuralP、toonMuralK）
 *   objectId（描边 ID，默认自动递增）
 */
export function makePengMaterial(opts = {}) {
  const o = { ...PENG_DEFAULTS, ...opts };
  const base = colorOf(o.color);
  const t1 = o.shade1 ? tintFrom(o.color, o.shade1) : vec3Of(o.shade1Tint);
  const t2 = o.shade2 ? tintFrom(o.color, o.shade2) : vec3Of(o.shade2Tint);
  const mat = new THREE.MeshToonMaterial({ color: base, side: o.side, fog: o.fog, transparent: !!o.transparent, opacity: o.opacity ?? 1 });
  const u = {
    uLitTint: { value: vec3Of(o.litTint) }, uShade1Tint: { value: t1 }, uShade2Tint: { value: t2 },
    uStep1: { value: o.step1 }, uFeather1: { value: Math.max(0.015, o.feather1) }, uStep2: { value: o.step2 }, uFeather2: { value: Math.max(0.015, o.feather2) },
    uShadowDepth: { value: o.shadowDepth }, uCastShade: { value: o.castShade }, uShadowLo: { value: o.shadowLo }, uShadowHi: { value: o.shadowHi },
    uEdgeNoise: { value: o.edgeNoise }, uEdgeNoiseScale: { value: o.edgeNoiseScale },
    uRimColor: { value: colorOf(o.rimColor) }, uRimAmt: { value: o.rimAmt }, uRimPower: { value: o.rimPower }, uRimInside: { value: o.rimInside }, uRimDirK: { value: o.rimDirK },
    uRimLitColor: { value: colorOf(o.rimLitColor) }, uRimLitAmt: { value: o.rimLitAmt }, uRimLitDirK: { value: o.rimLitDirK }, uRimLitInside: { value: o.rimLitInside }, uRimLitPower: { value: o.rimLitPower },
    uCityColor: { value: colorOf(o.cityColor) }, uCityAmt: { value: o.cityAmt }, uCityStep: { value: o.cityStep }, uCityStep2: { value: o.cityStep2 }, uCityW1: { value: o.cityW1 }, uCityFlat: { value: o.cityFlat },
    uSkyTint: { value: vec3Of(o.skyTint) }, uSkyAmt: { value: o.skyAmt }, uSkyStep: { value: o.skyStep },
    uMuralAmt: { value: o.muralAmt }, uMuralScale: { value: o.muralScale }, uMuralGround: { value: colorOf(o.muralGround) }, uStainTint: { value: vec3Of(o.stainTint) },
    uFleckThr: { value: o.fleckThr }, uFleckAmt: { value: o.fleckAmt }, uFleckFreq: { value: o.fleckFreq }, uChipThr: { value: o.chipThr }, uChipAmt: { value: o.chipAmt },
    uFadeAmt: { value: o.fadeAmt }, uStainAmt: { value: o.stainAmt }, uDotAmt: { value: o.dotAmt },
    uInkColor: { value: colorOf(o.inkColor) }, uObjectId: { value: o.objectId ?? _objectId++ },
    uOutlineW: { value: o.outlineW }, uInstIdOn: { value: o.instanceId ? 1 : 0 },
    ...TOON_SHARED, ...(o.uniforms || {}),
  };
  const defines = o.defines || {};
  const key = 'peng-r170-v1|' + strHash([o.rest, o.vertexPars, o.vertexBegin, o.fragmentPars, o.fragmentAlbedo, JSON.stringify(defines)].join('§'));
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), defines);
    sh.vertexShader = vertexInject(sh.vertexShader, o);
    const sm = THREE.ShaderChunk.shadowmap_pars_fragment;
    if (!sm.includes(SHADOW_ANCHOR)) throw new Error(`toon_peng.js：投影量化锚点缺失（three r${THREE.REVISION}）：${SHADOW_ANCHOR}`);
    let f = sh.fragmentShader;
    f = inject(f, '#include <common>', FRAG_PARS + (o.fragmentPars || ''));
    f = inject(f, '#include <shadowmap_pars_fragment>', sm.replaceAll(SHADOW_ANCHOR, 'return mix( 1.0, smoothstep( uShadowLo, uShadowHi, shadow ), shadowIntensity );'), 'replace');
    f = inject(f, '#include <color_fragment>', FRAG_ALBEDO_HEAD + (o.fragmentAlbedo || '') + FRAG_MURAL);
    f = inject(f, 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', FRAG_SHADE, 'replace');
    f = inject(f, '#include <dithering_fragment>', FRAG_PASS);
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => key;
  mat.userData.toon = u;
  mat.userData.toonOpts = o;
  return mat;
}

// 挂材质 + 描边标记（toon.js 测试页的屏幕描边、look.js 的 ID 图描边两套都认）
export function bindPeng(mesh, mat, { castShadow = true, receiveShadow = true, outline = true, perInstance } = {}) {
  mesh.material = mat;
  mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
  const w = mat.userData.toon.uOutlineW.value;
  const per = perInstance ?? (!!mesh.isInstancedMesh && mat.userData.toon.uInstIdOn.value > 0.5);
  Object.assign(mesh.userData, {
    outline, outlineId: mat.userData.toon.uObjectId.value, outlineWeight: w, outlineWidth: Math.max(0.35, w),
    outlinePerInstance: per, instanced: !!mesh.isInstancedMesh,
  });
  return mesh;
}
