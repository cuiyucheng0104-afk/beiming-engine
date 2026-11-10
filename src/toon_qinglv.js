// 卡通着色材质 · 青绿仙山版（引擎三档卡通 + 本变体的钩子；只给 kun_qinglv.js 用）
// 和 toon.js 的关系：
//   · 全场共享的 uniform（TOON_SHARED：输出通道、墨线时钟、城市光 / 天空光方向……）直接引用 toon.js 那一份，
//     所以合成代理用 toon.js 的 setToonGlobals 切通道、调光，这里的材质同步生效（换进正片镜头 C：buildShotC({ makeKun }) 传 kun_qinglv.js 的 createKun，已在镜头 C 里跑通）。
//   · 物体 ID 从 301 开始编号，避免和 toon.js 的材质撞号。
// 相比 toon.js：锈斑是固有色乘 rustTint（保住色相）、藻斑量减半；多出来的钩子 / 变量：
//   fragmentBase      在斑块之前写 diffuseColor.rgb（固有色：石青→石绿渐变等），斑块叠在它上面
//   toonGold (vec4)   金线：rgb 金色、a 量。光照分档之后再混入，亮面用原色、暗面压暗 → 像金箔线，不随固有色偏色
//   toonGlow (vec3)   不受光照的加色（金眼微光等）
//   toonTrans (float) 透光量（半透明鳍）：逆光时加一层暖色透射光
//   toonSoftRim       0..1：边缘光乘的系数（瀑布、云这种自己要控制边缘光的物体）
// 约定同 toon.js：颜色按色板绝对给定、NoToneMapping、噪声是坐标的纯函数（任意帧单独渲染结果一致）。
import * as THREE from 'three';
import { TOON_SHARED, PALETTE, setToonGlobals, tintFrom } from './toon.js';
import { toonKind } from '../engine/shade/toon.js';
import { patchLayer } from '../engine/shade/surface.js';
import { lineGlsl } from '../engine/shade/util.glsl.js';
import { vec3Of, colorOf } from '../engine/shade/patch.js';
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
  fillColor: PALETTE.kunBelly, fillAmt: 0.6, fillStep: 0.55, fillStep2: 0.9, fillW1: 0.45, fillFlat: 0.5,
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

// —— 本变体在引擎三档卡通上加的光照钩子：金线（分档之后混入）、透光、不受光照的加色 ——
const kind = toonKind({ name: 'toon-qinglv', shared: TOON_SHARED, firstId: 301,
  layers: [patchLayer({ rust: 'tint', algaeK: 0.55 })],
  pars: 'uniform vec3 uGoldShade, uTransColor; uniform float uTransPow;\n',
  glsl: lineGlsl(0.75),
  uniforms: o => ({ uGoldShade: { value: vec3Of(o.goldShade) }, uTransColor: { value: colorOf(o.transColor) }, uTransPow: { value: o.transPow } }),
  vars: /* glsl */`vec4 toonGold = vec4( 0.0 );    // 钩子可写：金线（rgb, 量），按明暗档压暗
vec3 toonGlow = vec3( 0.0 );    // 钩子可写：不受光照的加色
float toonTrans = 0.0;          // 钩子可写：透光量
float toonSoftRim = 1.0;        // 钩子可写：边缘光系数
`,
  shade: {
    // 金线：亮档原色，暗档乘 uGoldShade；城市光照到的地方偏暖
    afterFill: /* glsl */`vec3 gold = mix( toonGold.rgb, toonGold.rgb * uGoldShade, m1 );
  gold = mix( gold, toonGold.rgb * vec3( 1.08, 0.86, 0.62 ), clamp( fillM, 0.0, 1.0 ) * 0.6 );
  col = mix( col, gold, clamp( toonGold.a, 0.0, 1.0 ) );`,
    rimScale: ' * toonSoftRim',
    // 透光：光从物体背后照过来（L 与 V 相背）时，薄的地方透出暖光（两档量化）
    afterRim: /* glsl */`float back = clamp( - dot( L, V ), 0.0, 1.0 );
  float tq = pow( back, uTransPow ) * toonTrans;
  float ftq = max( 0.02, fwidth( tq ) );
  col = mix( col, mix( col, uTransColor, 0.55 ), smoothstep( 0.18 - ftq, 0.18 + ftq, tq ) * 0.6 + smoothstep( 0.5 - ftq, 0.5 + ftq, tq ) * 0.25 );`,
    final: 'col += toonGlow;',
  },
});

/**
 * makeToonMaterial(opts) → THREE.MeshToonMaterial（已打补丁）。参数同 toon.js，另加：
 *   fragmentBase   斑块之前写固有色
 *   goldShade / transColor / transPow   见文件头
 *   outlineVertex  { head, body, uniforms }：给 look.js 的 ID 图用的同款顶点形变（bindToon 时挂到 mesh.userData）
 */
export const makeToonMaterial = (opts = {}) => kind.make({ ...TOON_DEFAULTS, ...opts });
// 挂材质 + 投影深度材质 + 描边标记（同 toon.js；另把 outlineVertex 挂到 userData 给 look.js 用）
export const bindToon = kind.bind;
