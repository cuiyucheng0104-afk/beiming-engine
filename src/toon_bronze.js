// 青铜古鲲的卡通着色（三渲二配方第 2 层：引擎 engine/shade 的三档卡通 + 本变体的钩子）
// 与 toon.js 相同：三色分档（两道羽化）、投影量化、Ap 背光边缘光 + 受光侧边缘光、城市暖光两档、天空冷光、物体空间确定性斑块。
// 新增：
//   · 钩子变量 toonLift（0..1）：把这一片从阴影档往亮档抬（玉、绿松石在逆光里也要“透”出来，像自带一点温润的光）
//   · 钩子变量 toonPassN / toonPassUse：描边通道写哪根法线（浮雕只管着色，不进屏幕描边，纹样的线由材质自己画）
//   · 钩子变量 toonRimN / toonRimUse：边缘光用哪根法线（默认用扰动后的法线；身体用原始法线，免得每条纹带都起亮边）
//   · bzPerturb：不依赖切线的凹凸（引擎 bumpGlsl：屏幕导数法；σ 不归一化，坡度与距离无关）；bzVor：二维 Voronoi
// 共享 uniform 直接引用 toon.js 的 TOON_SHARED：正片里 setToonGlobals 切描边通道 / 推墨线时钟，青铜鲲同步生效。
// 确定性：所有噪声是坐标的纯函数，没有时间和随机数（墨线抖动只跟 uInkTime 走）。
import * as THREE from 'three';
import { TOON_SHARED, tintFrom, PALETTE } from './toon.js';
import { toonKind } from '../engine/shade/toon.js';
import { patchLayer } from '../engine/shade/surface.js';
import { voronoiGlsl } from '../engine/shade/noise.glsl.js';
import { bumpGlsl } from '../engine/shade/util.glsl.js';
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
  fillColor: PALETTE.kunBelly, fillAmt: 0.92, fillStep: 0.5, fillStep2: 0.9, fillW1: 0.42, fillFlat: 0.55,
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
    fillAmt: 0.5, fillFlat: 0.25, edgeNoise: 0.05, skyAmt: 0.6, skyTint: [0.82, 0.97, 1.0] },
  fern: { color: '#ffffff', shade1Tint: tintFrom('#84b24c', '#76aa5e'), shade2Tint: tintFrom('#84b24c', '#5a8a58'), step1: 0.5, step2: 0.06,
    rimAmt: 0.45, rimInside: 0.45, rimLitAmt: 1, rimLitInside: 0.12, rimLitColor: '#fff0c8', rimLitPower: 0.5, rimLitDirK: 0.5, fillAmt: 0.45, fillFlat: 0.25, edgeNoise: 0.03, skyAmt: 0.5, skyTint: [0.85, 0.97, 1.0] },
  flower: { color: '#ffffff', shade1Tint: tintFrom('#fff8ee', '#c9bfd2'), shade2Tint: tintFrom('#fff8ee', '#9a8fae'),
    step1: 0.45, step2: 0.14, rimAmt: 0.35, rimInside: 0.55, fillAmt: 0.55, fillFlat: 0.3, skyAmt: 0.7, skyTint: [0.93, 0.93, 1.0] },
  jade: { color: BRONZE.jade, shade1: '#c3c9b8', shade2: '#8f9a96', step1: 0.5, step2: 0.12, feather1: 0.05,
    rimAmt: 0.5, rimInside: 0.45, rimLitAmt: 0.7, rimLitInside: 0.2, fillAmt: 0.75, fillFlat: 0.4, skyAmt: 0.6, skyTint: [0.94, 0.97, 1.02] },
};

// —— 本变体在引擎三档卡通上加的钩子：抬档（toonLift）、边缘光法线（toonRimN）、描边通道法线（toonPassN） ——
// 物体 ID 从 5000 起，避开 toon.js 的自增 ID（同场景里两套材质的描边 ID 不撞）
const kind = toonKind({ name: 'toon-bronze', shared: TOON_SHARED, firstId: 5001, layers: [patchLayer()],
  glsl: voronoiGlsl('bzVor') + bumpGlsl('bzPerturb'),
  vars: /* glsl */`float toonLift = 0.0;
vec3 toonPassN = vec3( 0.0, 0.0, 1.0 ); float toonPassUse = 0.0;
vec3 toonRimN = vec3( 0.0, 0.0, 1.0 ); float toonRimUse = 0.0;
`,
  shade: {
    rimNormal: 'normalize( mix( N, toonRimN, toonRimUse ) )',
    bands: /* glsl */`m1 *= 1.0 - clamp( toonLift, 0.0, 1.0 ) * 0.6;
  m2 *= 1.0 - clamp( toonLift, 0.0, 1.0 );`,
    passPre: 'vec3 toonPN = normalize( mix( normal, toonPassN, toonPassUse ) );',
    passNormal: 'toonPN',
  },
});

/**
 * makeBronzeToon(opts) → THREE.MeshToonMaterial（已打补丁）。参数同 toon.js 的 makeToonMaterial：
 *   BRONZE_DEFAULTS 里的任意键；uniforms / defines；vertexPars / vertexMainStart / vertexBegin / vertexNormal；
 *   fragmentPars / fragmentAlbedo（改 diffuseColor.rgb、toonInk、toonOverlay、toonLift）/ fragmentNormal（改 normal、toonPassN、toonRimN）
 * 着色器函数区另有 bzVor（二维 Voronoi）、bzPerturb（无切线凹凸），给钩子用
 */
export const makeBronzeToon = (opts = {}) => kind.make({ ...BRONZE_DEFAULTS, ...opts });
// 阴影深度材质：带同样的顶点形变（弯曲、摆动），投影才跟形体对得上
export const makeBronzeDepth = kind.depth;
// 挂材质 + 投影深度材质 + 描边标记（与 toon.js 的 bindToon 约定一致）
export const bindBronze = kind.bind;
