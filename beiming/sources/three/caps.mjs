// three 帧源的能力声明。纯数据，页面和 node 两边都引用。
// 只声明这个实现真的交得出的东西：没实现的输出写 false，没实现的查询和作者模式不列。

export const VERSION = '0.187.0';

export const caps = () => ({
  format: 'caps/0.1',
  id: 'three',
  version: VERSION,
  language: 'js',
  hosts: ['page'],
  conformance: 'full',
  outputs: {
    color: { type: 'half', transfer: 'linear', primaries: 'rec709', note: '场景线性，半精度渲染目标逐子帧读回后在线性光里取平均；文件按 32 位浮点写' },
    meta: true,
    depth: { type: 'f32', note: '平面深度，米；不抗锯齿，取像素中心；背景写 0' },
    objectId: { type: 'u32', note: '不抗锯齿，取像素中心；不带覆盖率；背景是 0' },
    normal: { type: 'half', note: '相机空间，插值后的着色法线，长度 1；背景写 0' },
    motion: false,
  },
  sceneQuery: [],
  motionBlur: { mode: 'accumulate', auxAt: 'sub0' },
  determinism: 'hash-same-machine',
  draft: { kind: 'scale', samples: 1, scale: 0.5 },
  granularity: 'frame',
  randomAccess: true,
  modes: ['native-code'],
  cost: { unit: 'gpu-second' },
  metaNull: ['stats.noise', 'lights'],
});
