// 卡通着色材质·精修版
// 与 toon.js 的关系：
//   · 共享同一个 TOON_SHARED（从 toon.js 引入）：正片里 setToonGlobals 改输出模式 / 墨线时钟 / 城市光，精修版材质同步生效
//   · 色板在 toon.js 的 PALETTE 上追加东方配色（玉白、朱砂、祥云米金、苔绿、龙须象牙…）
//   · 物体 ID 从 101 起编，避免与 toon.js 的材质撞号（屏幕空间描边靠 ID 分界）
// 相对 toon.js 的差别（算法都在引擎里，这里只选开关和参数）：
//   · 色阶更干脆：默认羽化 0.012 / 0.015（羽化下限 0.01，仍有 fwidth 兜底，逐帧导出不闪）
//   · 表面层换成 engine/shade/surface.js 的 paintLayer：锈斑沿体轴拉长、撕边、积色边、甩点、海绵点、斑心；铜绿斑撕边；
//     斑点成簇；干笔笔触；颜料颗粒；植被三档斑驳（亮档偏黄绿）——远处自动淡出
//   · 边缘光两色（rimCore）：外侧亮芯 + 内侧主色，内沿用噪声撕开（像笔触收笔）
//   · 主函数作用域里预留 toonRelief（vec2）：albedo 钩子算浮雕坡度，法线钩子拿去扰动法线（祥云纹浮雕用）
// 约定与 toon.js 相同：主光 = 第一盏投影平行光，只给方向和投影；颜色全部按色板绝对给定；保色板用 NoToneMapping。
import * as THREE from 'three';
import { PALETTE as PALETTE0, TOON_SHARED, setToonGlobals, tintFrom, filmToon } from './toon.js';
import { toonKind } from '../engine/shade/toon.js';
import { paintLayer } from '../engine/shade/surface.js';

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

// —— 材质：引擎三档卡通 + 双色边缘光（rimCore）+ 绘画感表面层（paintLayer）；物体 ID 从 101 起 ——
const kind = toonKind({ name: 'toon-refine', shared: TOON_SHARED, firstId: 101, featherMin: 0.01, rimCore: true, layers: [paintLayer],
  vars: 'vec2 toonRelief = vec2( 0.0 );  // 钩子可写：浮雕坡度（给法线钩子用）\n' });

/**
 * makeToonMaterial(opts) → THREE.MeshToonMaterial（已打补丁），参数同 toon.js，另加本文件 TOON_DEFAULTS 里的新键
 * 钩子：vertexPars / vertexMainStart / vertexBegin / vertexNormal / fragmentPars / fragmentAlbedo / fragmentNormal
 * fragmentAlbedo 里可写 diffuseColor.rgb、toonInk、toonOverlay、toonRelief；fragmentNormal 里可改 normal
 */
export const makeToonMaterial = (opts = {}) => filmToon(kind, { ...TOON_DEFAULTS, ...opts });
export const makeToonDepthMaterial = kind.depth;

// 挂材质 + 投影深度材质 + 描边标记（userData 同时写 toon.js 的 outlineWeight 和 look.js 的 outlineWidth）
export function bindToon(mesh, mat, opts) {
  kind.bind(mesh, mat, opts);
  mesh.userData.outlineWidth = mesh.userData.outlineWeight;
  return mesh;
}
