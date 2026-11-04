// 玄鲲专用卡通材质（在 toon.js 三渲二配方上加三样：金箔、墨玉光泽、丝绸透光）
// 和 toon.js 的关系：
//   · 全场共享参数 TOON_SHARED（输出模式 uToonPass、墨线时钟、城市光 / 天空光方向）直接从 toon.js 引用同一个对象，
//     合成代理照旧调 toon.js 的 setToonGlobals，本模块的材质一起生效 —— 换进正片只改 import。
//   · 分档、投影量化、Ap 背光边缘光、城市暖光、天空冷光、斑块噪声都用引擎 engine/shade（三色 + 双羽化）；
//     本变体分档的 fwidth 兜底取 1.5 像素、羽化下限 0.004，锈斑不带斑心。
//   · 物体 ID 从 4001 起编，避免和 toon.js 的材质撞号（撞号会让两物体之间的 ID 描边消失）。
// 新增（片元钩子 fragmentAlbedo 里可写的变量，默认 0）：
//   toonMetal  0..1  金箔：暖色阴影档（不发灰发蓝）+ 按反射方向分三档的“金面”（朝天亮、朝地暗）+ 硬边闪光
//   toonGloss  0..1  墨玉 / 漆面：反射天空的一条硬边亮带 + 主光硬边高光
//   toonTrans  0..1  丝绸：光在面的另一侧时透出暖光（两档量化），正对太阳方向再亮一档
//   diffuseColor.a   彩色通道的不透明度（透明材质用）；法线 / ID 通道里不起作用
// 透明材质（opts.translucent = true）、不进 ID 通道（opts.noId）都是引擎的通用开关。
// 所有噪声是坐标的纯函数，没有时间和随机数；任意帧单独渲染结果一致。
import * as THREE from 'three';
import { TOON_SHARED, PALETTE, tintFrom, setToonGlobals, filmToon } from './toon.js';
import { toonKind } from '../engine/shade/toon.js';
import { patchLayer } from '../engine/shade/surface.js';
import { NOISE_GLSL as ENGINE_NOISE } from '../engine/shade/noise.glsl.js';
import { SS_GLSL, lineGlsl, FILL_GLSL } from '../engine/shade/util.glsl.js';
import { vec3Of, colorOf } from '../engine/shade/patch.js';
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

// —— GLSL 函数区：引擎的确定性噪声 + 本变体用的抗锯齿细线 / 填充（kun_xuan 的钩子会调） ——
export const NOISE_GLSL = ENGINE_NOISE + SS_GLSL + lineGlsl(1) + FILL_GLSL;

// —— 本变体在引擎三档卡通上加的光照钩子 ——
const SHADE = {
  skyMask: ' * ( 1.0 - toonMetal )',
  // 金箔：按反射方向分三档（反射天空亮、反射地面暗），暗部只压一点、不发灰
  afterSky: /* glsl */`vec3 Rv = reflect( - V, N );
  if ( toonMetal > 0.0 ) {
    float ry = dot( Rv, skyV ) + en * 1.5;
    float fr0 = max( 0.02, fwidth( ry ) * 1.2 );
    float r1 = smoothstep( uMetR1 - fr0, uMetR1 + fr0, ry ), r2 = smoothstep( uMetR2 - fr0, uMetR2 + fr0, ry );
    vec3 cmet = alb * mix( mix( uMetS2, uMetS1, r1 ), uMetLit, r2 );
    cmet *= mix( 1.0, uMetShade, m1 );
    col = mix( col, cmet, toonMetal );
  }`,
  flatMask: ' * ( 1.0 - toonMetal )',
  afterFill: /* glsl */`if ( toonTrans > 0.0 ) {
    // 丝绸两档透光：扭过去的地方淡暖白（A），正对背光的地方桃金（B）；视线正对太阳再亮一档（hot）
    float back = - dot( N, L ) + en * 0.6;
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
  col = mix( col, uGlintColor, clamp( glint, 0.0, 1.0 ) );`,
  rimLitColor: 'mix( uRimLitColor, uGlintColor, toonMetal * 0.6 )',   // 金的受光边缘光更亮一点
};

const kind = toonKind({ name: 'toon-xuan', shared: TOON_SHARED, firstId: 4001, featherMin: 0.004, bandAA: 1.5,
  layers: [patchLayer({ core: false })],
  pars: /* glsl */`uniform vec3 uMetLit, uMetS1, uMetS2, uGlintColor; uniform float uMetR1, uMetR2, uMetShade, uGlintThr, uGlintAmt;
uniform vec3 uSheenColor, uGlossColor; uniform float uSheenThr, uSheenAmt, uGlossThr, uGlossAmt;
uniform vec3 uTransA, uTransB; uniform float uTransThr, uTransHot, uTransShadow;
`,
  glsl: lineGlsl(1) + FILL_GLSL,
  uniforms: o => ({
    uMetLit: { value: vec3Of(o.metLit) }, uMetS1: { value: vec3Of(o.metS1) }, uMetS2: { value: vec3Of(o.metS2) },
    uMetR1: { value: o.metR1 }, uMetR2: { value: o.metR2 }, uMetShade: { value: o.metShade },
    uGlintColor: { value: colorOf(o.glintColor) }, uGlintThr: { value: o.glintThr }, uGlintAmt: { value: o.glintAmt },
    uSheenColor: { value: colorOf(o.sheenColor) }, uSheenThr: { value: o.sheenThr }, uSheenAmt: { value: o.sheenAmt },
    uGlossColor: { value: colorOf(o.glossColor) }, uGlossThr: { value: o.glossThr }, uGlossAmt: { value: o.glossAmt },
    uTransA: { value: vec3Of(o.transA) }, uTransB: { value: vec3Of(o.transB) }, uTransThr: { value: o.transThr }, uTransHot: { value: o.transHot }, uTransShadow: { value: o.transShadow },
  }),
  vars: 'float toonMetal = 0.0, toonGloss = 0.0, toonTrans = 0.0;\n',
  shade: SHADE,
});

/**
 * makeXuanMaterial(opts) → THREE.MeshToonMaterial（已打补丁）。参数同 toon.js 的 makeToonMaterial，另加
 *   metLit / metS1 / metS2 / metR1 / metR2 / metShade / glintColor / glintThr / glintAmt   金箔
 *   sheenColor / sheenThr / sheenAmt / glossColor / glossThr / glossAmt                   墨玉光泽
 *   transA / transB / transThr / transHot / transShadow                                   丝绸透光
 *   translucent: true  彩色通道半透明（alpha 由钩子写 diffuseColor.a）；法线 / ID 通道自动不透明
 *   noId: true         不进法线 / ID 通道（屏幕描边、雾都不管它；细小物件用自身着色器画边）
 */
export const makeXuanMaterial = (opts = {}) => filmToon(kind, { ...XUAN_DEFAULTS, ...opts });
export const makeXuanDepthMaterial = kind.depth;
// 挂材质 + 投影深度材质 + 描边标记（与 toon.js 的 bindToon 相同约定）
export const bindXuan = kind.bind;
