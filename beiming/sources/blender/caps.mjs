// Blender 帧源的能力声明。纯数据。version 是实际起的那个 Blender 的版本号，由宿主从进程里问出来再传进来。
// 落在帧源登记表 blender 一项之内：宿主、各输出的类型、运动模糊的做法、确定性分档和登记表相同；
// 作者模式和场景查询只列这个实现真的接上了的（声明了就必须装得起来、答得出来）。

/** 草稿档的输出不超过 960 × 540（每边及总像素数都不超）；超过时默认的缩放自动往下取，点名要更大的报错 */
export const DRAFT_MAX_SIZE = Object.freeze([960, 540]);
export const DRAFT_MAX_PIXELS = DRAFT_MAX_SIZE[0] * DRAFT_MAX_SIZE[1];

/** version 是 Blender 的版本号；library 是提供给帧源的卡（见 host.mjs 的 loadCards）：提供了卡，作者模式里才有「卡加数据」 */
export const caps = (version, library = {}) => ({
  format: 'caps/0.1',
  id: 'blender',
  version,
  language: 'python',
  hosts: ['cycles'],
  conformance: 'full',
  outputs: {
    color: { type: 'f32', transfer: 'linear', primaries: 'rec709', note: '场景线性，Cycles 渲成 32 位浮点 EXR 后直读，不过显示变换，HDR 级不截；分量 R、G、B、A' },
    meta: true,
    depth: { type: 'f32', note: '平面深度，米；sub = 0 关运动模糊和景深另渲，1 采样不抗锯齿；什么都没打到写 1e10' },
    objectId: { type: 'u32', note: 'sub = 0 关运动模糊和景深另渲，1 采样不抗锯齿；不带覆盖率；0 表示没打到任何实体' },
    normal: { type: 'f32', note: '相机空间的着色法线，长度 1；sub = 0 关运动模糊和景深另渲，1 采样；什么都没打到写 (0, 0, 0)' },
    motion: false,
  },
  sceneQuery: ['bbox3d', 'anchor', 'intersect', 'contact', 'belowGround'],
  motionBlur: { mode: 'native', auxAt: 'sub0', conflicts: ['motion'] },
  determinism: 'tolerance',
  draft: { kind: 'cycles-low', samples: 24, scale: 0.5, denoise: 'gpu' },
  final: { samples: 64, scale: 1, denoise: 'gpu' },
  granularity: 'frame',
  randomAccess: true,
  modes: Object.keys(library).length ? ['cards-data', 'build-script'] : ['build-script'],
  cost: { unit: 'gpu-second' },
  metaNull: ['stats.noise', 'texts', 'lights'],
});
