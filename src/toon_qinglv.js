// 卡通着色材质 · 青绿仙山版（从 src/toon.js 复制改写，算法相同；只给 kun_qinglv.js 用）
// 和 toon.js 的关系：
//   · 全场共享的 uniform（TOON_SHARED：输出通道、墨线时钟、城市光 / 天空光方向……）直接引用 toon.js 那一份，
//     所以合成代理用 toon.js 的 setToonGlobals 切通道、调光，这里的材质同步生效（换进正片只改 import）。
//   · 物体 ID 从 301 开始编号，避免和 toon.js 的材质撞号。
// 相比 toon.js 多出来的钩子 / 变量：
//   fragmentBase      在斑块之前写 diffuseColor.rgb（固有色：石青→石绿渐变等），斑块叠在它上面
//   toonGold (vec4)   金线：rgb 金色、a 量。光照分档之后再混入，亮面用原色、暗面压暗 → 像金箔线，不随固有色偏色
//   toonGlow (vec3)   不受光照的加色（金眼微光等）
//   toonTrans (float) 透光量（半透明鳍）：逆光时加一层暖色透射光
//   toonSoftRim       0..1：边缘光乘的系数（瀑布、云这种自己要控制边缘光的物体）
// 约定同 toon.js：颜色按色板绝对给定、NoToneMapping、噪声是坐标的纯函数（任意帧单独渲染结果一致）。
import * as THREE from 'three';
import { TOON_SHARED, PALETTE, setToonGlobals, tintFrom } from './toon.js';
export { TOON_SHARED, PALETTE, setToonGlobals, tintFrom };

export const TOON_DEFAULTS = {
  color: '#ffffff',
  shade1: null, shade2: null,
  shade1Tint: [0.62, 0.66, 0.82], shade2Tint: [0.34, 0.38, 0.6],
  litTint: [1, 1, 1],
  step1: 0.53, feather1: 0.02,
  step2: 0.2, feather2: 0.03,
  shadowDepth: 0.5, castShade: 1,
  shadowLo: 0.42, shadowHi: 0.58,
  edgeNoise: 0.03, edgeNoiseScale: 0.06,
  rimColor: PALETTE.pink, rimAmt: 0.6, rimPower: 0.4, rimInside: 0.3, rimDirK: 0.5,
  rimLitColor: PALETTE.kunRim, rimLitAmt: 0.9, rimLitInside: 0.12, rimLitPower: 0.55, rimLitDirK: 0.55,
  cityColor: PALETTE.kunBelly, cityAmt: 0.6, cityStep: 0.55, cityStep2: 0.9, cityW1: 0.45, cityFlat: 0.5,
  skyTint: [0.82, 0.92, 1.12], skyAmt: 0.6,
  patchScale: 0.05,
  rustTint: [0.66, 0.72, 0.96], rustAmt: 0, rustThr: 0.1,   // 锈斑：固有色乘这个色调（偏冷偏深，保住色相）
  algaeColor: '#9fd8b8', algaeAmt: 0, algaeThr: 0.28,
  spotColor: PALETTE.ink, spotAmt: 0, spotThr: 0.5, spotScale: 6,
  dabAmt: 0, dabScale: 1.2,
  inkColor: PALETTE.ink,
  goldShade: [0.6, 0.5, 0.58],                // 金线在暗档里乘的色调（偏冷、压暗，但保持“金”）
  transColor: '#ffcf9e', transPow: 2.0,       // 透光色、逆光指数
  outlineW: 1, instanceId: true,
  side: THREE.FrontSide, fog: true,
};

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
// 抗锯齿细线：d 为到线的距离（任意单位），w 为半线宽（同单位）
float toonLine( float d, float w ) { float f = max( fwidth( d ), 1e-5 ); return 1.0 - smoothstep( w - f * 0.75, w + f * 0.75, abs( d ) ); }
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
uniform vec3 uRustTint; uniform float uRustAmt, uRustThr;
uniform vec3 uAlgaeColor; uniform float uAlgaeAmt, uAlgaeThr;
uniform vec3 uSpotColor; uniform float uSpotAmt, uSpotThr, uSpotScale;
uniform vec3 uInkColor; uniform float uObjectId, uOutlineW, uInstIdOn, uDabAmt, uDabScale;
uniform vec3 uGoldShade, uTransColor; uniform float uTransPow;
uniform float uToonPass, uInkTime, uExposure, uCityGain, uSkyGain;
uniform vec3 uCityDirW, uSkyDirW, uKeyDirW;
varying vec3 vToonObj;
flat varying float vToonInst;
float toonLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
${NOISE_GLSL}
`;

const FRAG_DECL = /* glsl */`
float toonInk = 0.0;            // 钩子可写：0..1，往墨线色混
vec4 toonOverlay = vec4( 0.0 ); // 钩子可写：不受光照的覆盖色（rgb, 量）
vec4 toonGold = vec4( 0.0 );    // 钩子可写：金线（rgb, 量），按明暗档压暗
vec3 toonGlow = vec3( 0.0 );    // 钩子可写：不受光照的加色
float toonTrans = 0.0;          // 钩子可写：透光量
float toonSoftRim = 1.0;        // 钩子可写：边缘光系数
`;

const FRAG_PATCHES = /* glsl */`
vec3 toonBase = diffuseColor.rgb;
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
  diffuseColor.rgb *= mix( vec3( 1.0 ), uRustTint, rust * uRustAmt );
  diffuseColor.rgb *= mix( vec3( 1.0 ), uRustTint * 0.86, core * uRustAmt * 0.55 );
  float nA = toonFbm( P * 1.6 - w * 0.7 + 31.0 );
  float aA = max( fwidth( nA ), 1e-4 ) * 0.8;
  float alg = smoothstep( uAlgaeThr - aA, uAlgaeThr + aA, nA ) * ( 1.0 - rust );
  diffuseColor.rgb = mix( diffuseColor.rgb, uAlgaeColor, alg * uAlgaeAmt * 0.55 );
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
  // 金线：亮档原色，暗档乘 uGoldShade；城市光照到的地方偏暖
  vec3 gold = mix( toonGold.rgb, toonGold.rgb * uGoldShade, m1 );
  gold = mix( gold, toonGold.rgb * vec3( 1.08, 0.86, 0.62 ), clamp( cm, 0.0, 1.0 ) * 0.6 );
  col = mix( col, gold, clamp( toonGold.a, 0.0, 1.0 ) );
  float ndv = clamp( dot( N, V ), 0.0, 1.0 );
  float hlv = clamp( 0.5 * dot( N, L ) + 0.5, 0.0, 1.0 );
  float rp = pow( 1.0 - ndv, exp2( 3.0 * ( 1.0 - uRimPower ) ) ) + en * 0.8;
  float fr = max( 0.012, fwidth( rp ) * 1.2 );
  float tAp = uRimInside + uRimDirK * hlv;
  float ap = smoothstep( tAp - fr, tAp + fr, rp ) * uRimAmt * toonSoftRim;
  float rq = pow( 1.0 - ndv, exp2( 3.0 * ( 1.0 - uRimLitPower ) ) ) + en * 0.8;
  float fq = max( 0.012, fwidth( rq ) * 1.2 );
  float tLit = uRimLitInside + uRimLitDirK * ( 1.0 - hlv );
  float rl = smoothstep( tLit - fq, tLit + fq, rq ) * uRimLitAmt * att * toonSoftRim;
  col = mix( col, uRimColor * mix( 1.0, lr, 0.35 ), clamp( ap, 0.0, 1.0 ) );
  col = mix( col, uRimLitColor, clamp( rl, 0.0, 1.0 ) );
  // 透光：光从物体背后照过来（L 与 V 相背）时，薄的地方透出暖光（两档量化）
  float back = clamp( - dot( L, V ), 0.0, 1.0 );
  float tq = pow( back, uTransPow ) * toonTrans;
  float ftq = max( 0.02, fwidth( tq ) );
  col = mix( col, mix( col, uTransColor, 0.55 ), smoothstep( 0.18 - ftq, 0.18 + ftq, tq ) * 0.6 + smoothstep( 0.5 - ftq, 0.5 + ftq, tq ) * 0.25 );
  col = mix( col, uInkColor, clamp( toonInk, 0.0, 1.0 ) );
  col = mix( col, toonOverlay.rgb, clamp( toonOverlay.a, 0.0, 1.0 ) );
  col += toonGlow;
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
  if (!src.includes(anchor)) throw new Error(`toon_qinglv.js：着色器锚点缺失「${anchor.slice(0, 60)}」（three r${THREE.REVISION}，本模块按 r170 写）`);
  const rep = mode === 'after' ? anchor + '\n' + code : mode === 'before' ? code + '\n' + anchor : code;
  return src.replace(anchor, () => rep);
}
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
const vec3Of = v => v instanceof THREE.Vector3 ? v.clone() : Array.isArray(v) ? new THREE.Vector3(...v) : new THREE.Vector3(v.x, v.y, v.z);
const colorOf = c => c instanceof THREE.Color ? c.clone() : new THREE.Color(c);

let _objectId = 301;
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
 * makeToonMaterial(opts) → THREE.MeshToonMaterial（已打补丁）。参数同 toon.js，另加：
 *   fragmentBase   斑块之前写固有色
 *   goldShade / transColor / transPow   见文件头
 *   outlineVertex  { head, body, uniforms }：给 look.js 的 ID 图用的同款顶点形变（bindToon 时挂到 mesh.userData）
 */
export function makeToonMaterial(opts = {}) {
  const o = { ...TOON_DEFAULTS, ...opts };
  const base = colorOf(o.color);
  const t1 = o.shade1 ? tintFrom(o.color, o.shade1) : vec3Of(o.shade1Tint);
  const t2 = o.shade2 ? tintFrom(o.color, o.shade2) : vec3Of(o.shade2Tint);
  const mat = new THREE.MeshToonMaterial({ color: base, side: o.side, fog: o.fog,
    transparent: !!o.transparent, opacity: o.opacity ?? 1, map: o.map || null, depthWrite: o.depthWrite ?? true });
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
    uRustTint: { value: vec3Of(o.rustTint) }, uRustAmt: { value: o.rustAmt }, uRustThr: { value: o.rustThr },
    uAlgaeColor: { value: colorOf(o.algaeColor) }, uAlgaeAmt: { value: o.algaeAmt }, uAlgaeThr: { value: o.algaeThr },
    uSpotColor: { value: colorOf(o.spotColor) }, uSpotAmt: { value: o.spotAmt }, uSpotThr: { value: o.spotThr }, uSpotScale: { value: o.spotScale },
    uInkColor: { value: colorOf(o.inkColor) }, uObjectId: { value: o.objectId ?? _objectId++ },
    uOutlineW: { value: o.outlineW }, uInstIdOn: { value: o.instanceId ? 1 : 0 }, uDabAmt: { value: o.dabAmt }, uDabScale: { value: o.dabScale },
    uGoldShade: { value: vec3Of(o.goldShade) }, uTransColor: { value: colorOf(o.transColor) }, uTransPow: { value: o.transPow },
    ...TOON_SHARED, ...(o.uniforms || {}),
  };
  const defines = o.defines || {};
  const key = 'toonql-r170-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, o.vertexNormal, o.fragmentPars, o.fragmentBase, o.fragmentAlbedo, o.fragmentNormal, JSON.stringify(defines)].join('§'));
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), defines);
    sh.vertexShader = vertexInject(sh.vertexShader, o, true);
    const sm = THREE.ShaderChunk.shadowmap_pars_fragment;
    if (!sm.includes(SHADOW_ANCHOR)) throw new Error(`toon_qinglv.js：投影量化锚点缺失（three r${THREE.REVISION}）：${SHADOW_ANCHOR}`);
    let f = sh.fragmentShader;
    f = inject(f, '#include <common>', FRAG_PARS + (o.fragmentPars || ''));
    f = inject(f, '#include <shadowmap_pars_fragment>', sm.replaceAll(SHADOW_ANCHOR, 'return mix( 1.0, smoothstep( uShadowLo, uShadowHi, shadow ), shadowIntensity );'), 'replace');
    f = inject(f, '#include <color_fragment>', FRAG_DECL + (o.fragmentBase || '') + FRAG_PATCHES + (o.fragmentAlbedo || ''));
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
  const key = 'toonql-depth-v1|' + strHash([o.vertexPars, o.vertexMainStart, o.vertexBegin, JSON.stringify(o.defines || {})].join('§'));
  d.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    Object.assign(sh.defines || (sh.defines = {}), o.defines || {});
    sh.vertexShader = vertexInject(sh.vertexShader, { ...o, vertexNormal: '' }, false);
  };
  d.customProgramCacheKey = () => key;
  return d;
}

// 挂材质 + 投影深度材质 + 描边标记（同 toon.js；另把 outlineVertex 挂到 userData 给 look.js 用）
export function bindToon(mesh, mat, { castShadow = true, receiveShadow = true, outline = true } = {}) {
  mesh.material = mat;
  const o = mat.userData.toonOpts || {};
  if (castShadow && (o.vertexPars || o.vertexBegin || o.vertexMainStart)) mesh.customDepthMaterial = makeToonDepthMaterial(mat);
  mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
  mesh.userData.outline = outline;
  mesh.userData.outlineId = mat.userData.toon.uObjectId.value;
  mesh.userData.outlineWeight = mat.userData.toon.uOutlineW.value;
  mesh.userData.outlinePerInstance = !!mesh.isInstancedMesh && mat.userData.toon.uInstIdOn.value > 0.5;
  mesh.userData.instanced = !!mesh.isInstancedMesh;
  if (o.outlineVertex) mesh.userData.outlineVertex = o.outlineVertex;
  return mesh;
}
