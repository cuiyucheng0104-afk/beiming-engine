// 卡通着色材质（三渲二配方第 2 层）·《北冥》的色板、预设与全场共享参数
// 算法在 engine/shade/toon.js（三色分档 + 投影量化 + 边缘光 + 下方补光 / 天空冷光）与 surface.js 的斑块层
// （紫色锈斑带深色斑心、藻斑、深色小斑点、植被斑驳）；这里给出本片的色板、默认值、预设，以及全场共享参数。
// 约定：主光 = 场景里第一盏投影的 DirectionalLight，只给方向和投影，颜色全部按色板绝对给定；
// 色板颜色用 THREE.Color 转到线性工作空间，保色板请用 NoToneMapping；所有噪声是坐标的纯函数。
// 其它变体（toon_refine / qinglv / xuan / bronze / peng）共享这里的 TOON_SHARED，只各自换参数、表面层和光照钩子。
import * as THREE from 'three';
import { makeToonShared, setToonShared, tintFrom, toonKind } from '../engine/shade/toon.js';
import { patchLayer } from '../engine/shade/surface.js';

export { tintFrom };

// —— 色板（导演定调 / 任务书给定） ——
export const PALETTE = {
  zenith: '#4F5BBF', lavender: '#9C8FD8', pink: '#F2A0A6', apricot: '#FFB26B',
  cloudShade: '#8E7CC3', cloudLit: '#F7A98F', city: '#4B4A8C', window: '#FFC46B',
  kunBase: '#6E7BA8', kunShade1: '#4E5888', kunShade2: '#343D69', kunRim: '#FFD3B0', kunBelly: '#F2A36B',
  barnacle: '#E9DCC9', barnacleShade: '#9A8FA8', weedA: '#5E8A5A', weedB: '#3E6B4A',
  coral: '#F07F86', anemone: '#FFF4EA', rust: '#7A5C9E', ink: '#2A2D52', hud: '#EAF6FF', hudAccent: '#9FE8FF',
};

const KUN_T1 = tintFrom(PALETTE.kunBase, PALETTE.kunShade1);   // 约 (0.47, 0.48, 0.63)：变暗并偏冷
const KUN_T2 = tintFrom(PALETTE.kunBase, PALETTE.kunShade2);   // 约 (0.20, 0.23, 0.36)

// —— 全场共享的 uniform（所有 toon 材质引用同一个对象，改一处全场生效） ——
// uToonPass 输出模式、uInkTime 墨线抖动时钟（建议 floor(frame/2)）、uExposure 整体提亮（片尾日光）、
// 下方补光 fill（本片里是城市灯海的暖光）、天空光、无平行光时的主光方向
export const TOON_SHARED = makeToonShared({ fillDir: [0, -1, 0], skyDir: [0, 1, 0], keyDir: [-0.6, 0.15, 0.78] });

// 统一设置共享参数：setToonGlobals({ fillDir:[x,y,z], fillGain, skyGain, exposure, inkTime, keyDir, pass })
export const setToonGlobals = (g = {}) => setToonShared(TOON_SHARED, g);

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
  fillColor: PALETTE.kunBelly, fillAmt: 0, fillStep: 0.45, fillStep2: 0.8, fillW1: 0.45, fillFlat: 0.6,  // 下方补光（城市暖光）：两档阈值作用于 N·(指向光源)
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
    fillAmt: 0.92, fillStep: 0.6, fillStep2: 0.94, fillW1: 0.42, fillFlat: 0.55, skyAmt: 0.75,
    rimAmt: 0.6, rimColor: PALETTE.pink, rimPower: 0.4, rimInside: 0.3, rimDirK: 0.5,
    rimLitAmt: 1, rimLitColor: PALETTE.kunRim, rimLitPower: 0.55, rimLitInside: 0.1, rimLitDirK: 0.55 },
  barnacle: { color: '#ffffff', shade1Tint: tintFrom(PALETTE.barnacle, PALETTE.barnacleShade), shade2Tint: tintFrom(PALETTE.barnacle, '#6a6488'),
    step1: 0.5, step2: 0.18, rimAmt: 0.5, rimInside: 0.5, fillAmt: 0.6, fillFlat: 0.3, edgeNoise: 0.02, skyAmt: 0.5, skyTint: [0.85, 0.85, 0.98] },
  seaweed: { color: '#ffffff', shade1Tint: tintFrom('#8DB36A', PALETTE.weedA), shade2Tint: tintFrom('#8DB36A', PALETTE.weedB), step1: 0.5, step2: 0.14, dabAmt: 0.16, dabScale: 1.1,
    rimAmt: 0.5, rimColor: PALETTE.pink, rimInside: 0.4, rimLitAmt: 0.9, rimLitInside: 0.15, rimLitPower: 0.5, rimLitDirK: 0.5, rimPower: 0.3,
    fillAmt: 0.5, fillFlat: 0.25, edgeNoise: 0.04, skyAmt: 0.6, skyTint: [0.82, 0.95, 1.0] },
  coral: { color: '#ffffff', shade1Tint: [0.6, 0.45, 0.72], shade2Tint: [0.34, 0.24, 0.5], step1: 0.5, step2: 0.2, rimAmt: 0.5, rimInside: 0.45, rimLitAmt: 0.8, rimLitInside: 0.15, rimLitPower: 0.5, rimLitDirK: 0.5, fillAmt: 0.5, fillFlat: 0.3, skyAmt: 0.5, skyTint: [0.85, 0.8, 1.0] },
  shell: { color: '#ffffff', shade1Tint: [0.62, 0.55, 0.74], shade2Tint: [0.36, 0.32, 0.52], step1: 0.5, step2: 0.2, rimAmt: 0.5, rimInside: 0.5, fillAmt: 0.55, fillFlat: 0.35, skyAmt: 0.5, skyTint: [0.88, 0.86, 1.0] },
  anemone: { color: '#ffffff', shade1Tint: tintFrom(PALETTE.anemone, '#c4b4cf'), shade2Tint: tintFrom(PALETTE.anemone, PALETTE.barnacleShade),
    step1: 0.45, step2: 0.16, rimAmt: 0.4, rimInside: 0.55, fillAmt: 0.55, fillFlat: 0.3, skyAmt: 0.7, skyTint: [0.92, 0.92, 1.0] },
};

// —— 材质：算法在 engine/shade（三档分档、投影量化、边缘光、补光、斑块层）；这里只给本片的默认值与 ID 段 ——
const kind = toonKind({ name: 'toon', shared: TOON_SHARED, firstId: 1, layers: [patchLayer()] });

/**
 * makeToonMaterial(opts) → THREE.MeshToonMaterial（已打补丁）
 * opts：TOON_DEFAULTS 里的任意键，另加 engine/shade/toon.js 的钩子（uniforms / defines / vertex* / fragment* / objectId…）
 * 运行时调参：mat.userData.toon.uXxx.value = …；共享参数用 setToonGlobals。
 * 有顶点钩子时，用 bindToon(mesh, mat) 挂上同样形变的阴影深度材质。
 */
export const makeToonMaterial = (opts = {}) => kind.make({ ...TOON_DEFAULTS, ...opts });
export const bindToon = kind.bind;
