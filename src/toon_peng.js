// 鲲鹏将化 专用卡通材质（三色分档、投影量化、Ap 背光边缘光、城市暖光都用引擎 engine/shade，与 toon.js 相同）
// 和 toon.js 的区别：
//   · 共享 uniform 直接用 toon.js 导出的 TOON_SHARED（同一个对象）：正片里 setToonGlobals({ pass, inkTime, … }) 对本材质同样生效，
//     换进正片只需把 import 从 './kun.js' 改成 './kun_peng.js'
//   · rest:true 时，物体空间噪声坐标取顶点属性 aRest（CPU 形变的网格用：纹样贴在静止形体上，不随摆动滑动）
//   · 表面层换成引擎的「壁画风化」muralLayer（敦煌壁画式斑驳）：褪色大斑（向地仗色靠）、干笔飞白小剥落、氧化暗斑、细碎点，
//     全部是坐标的纯函数；高频部分按屏幕频率自动淡出，远景不闪。没有锈斑 / 藻斑那一层
//   · 钩子里可写 toonMuralP（风化噪声坐标）、toonMuralK（本像素风化量倍率）、toonInk、toonOverlay
//   · bindPeng 同时写 toon.js 的描边标记（outlineId/outlineWeight）和 look.js 的描边标记（outline/outlineWidth/outlinePerInstance）
// 约定同 toon.js：主光 = 场景里第一盏投影的平行光，只取方向和投影；颜色全部按色板给定；保色板请用 NoToneMapping。
import * as THREE from 'three';
import { TOON_SHARED, setToonGlobals, PALETTE, tintFrom } from './toon.js';
import { toonKind } from '../engine/shade/toon.js';
import { muralLayer } from '../engine/shade/surface.js';
import { HASH13_GLSL } from '../engine/shade/noise.glsl.js';
import { lineGlsl, FAR_GLSL } from '../engine/shade/util.glsl.js';
export { TOON_SHARED, setToonGlobals, PALETTE, tintFrom };

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
  fillColor: PENG.city, fillAmt: 0.85, fillStep: 0.6, fillStep2: 0.94, fillW1: 0.42, fillFlat: 0.5,
  skyTint: [0.82, 0.9, 1.15], skyAmt: 0.6, skyStep: 0.3,
  // 壁画风化
  muralAmt: 0, muralScale: 0.06, muralGround: PENG.ground, stainTint: [0.62, 0.55, 0.62],
  fleckThr: 0.42, fleckAmt: 0.55, fleckFreq: 8, chipThr: 0.36, chipAmt: 0.55, fadeAmt: 0.3, stainAmt: 0.4, dotAmt: 0.45,
  inkColor: PENG.ink,
  outlineW: 1, instanceId: true,
  rest: false,
  side: THREE.FrontSide, fog: true,
};

// —— 材质：引擎三档卡通 + 壁画风化层（muralLayer）；天空冷光阈值做成参数；物体 ID 从 501 起（与 toon.js 的 ID 段错开） ——
// 形变都在 CPU 上做（rest: true 时纹样贴在静止形体 aRest 上），所以不挂阴影深度材质
const kind = toonKind({ name: 'toon-peng', shared: TOON_SHARED, firstId: 501, depth: false, skyStepUniform: true,
  layers: [muralLayer], glsl: HASH13_GLSL + lineGlsl(0.5, 0.9) + FAR_GLSL });

/**
 * makePengMaterial(opts) → THREE.MeshToonMaterial（已打补丁）
 * opts：PENG_DEFAULTS 里的任意键，另加
 *   uniforms / defines / vertexPars / vertexBegin（只用来传 varying，不要改 transformed：本鲲的形变都在 CPU 上做）
 *   fragmentPars / fragmentAlbedo（改 diffuseColor.rgb、toonInk、toonOverlay、toonMuralP、toonMuralK）
 *   objectId（描边 ID，默认自动递增）
 * 着色器函数区另有 toonHash13、toonLine（细线）、toonFar（远景淡出），给钩子用
 */
export const makePengMaterial = (opts = {}) => kind.make({ ...PENG_DEFAULTS, ...opts });

// 挂材质 + 描边标记（toon.js 测试页的屏幕描边、look.js 的 ID 图描边两套都认）
export function bindPeng(mesh, mat, opts) {
  kind.bind(mesh, mat, opts);
  mesh.userData.outlineWidth = Math.max(0.35, mesh.userData.outlineWeight);
  return mesh;
}
