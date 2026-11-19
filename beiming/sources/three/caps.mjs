// three 帧源的能力声明。纯数据，页面和 node 两边都引用。
// 只声明这个实现真的交得出的东西：没实现的输出写 false，没实现的查询和作者模式不列。
// 凡是由帧源定的默认值都写在这里（默认的子帧采样数、两个档位的每像素采样数和缩放），出帧时不另定。

export const VERSION = '0.187.0';

export const caps = () => ({
  format: 'caps/0.1',
  id: 'three',
  version: VERSION,
  language: 'js',
  hosts: ['page'],
  conformance: 'full',
  outputs: {
    color: { type: 'f32', transfer: 'linear', primaries: 'rec709', note: '场景线性，预乘透明度；32 位浮点渲染目标逐子帧读回后在线性光里取平均' },
    meta: true,
    depth: { type: 'f32', note: '平面深度，米；不抗锯齿，取像素中心；什么都没打到写 1e10' },
    objectId: { type: 'u32', note: '不抗锯齿，取像素中心；不带覆盖率；0 表示没打到任何实体' },
    normal: { type: 'f32', note: '相机空间，插值后的着色法线，背面翻向相机，长度 1；什么都没打到写 (0, 0, 0)' },
    motion: false,
  },
  sceneQuery: [],
  // 默认的子帧采样数 8 是暂定的数：契约的登记表里这一格还没定
  motionBlur: { mode: 'accumulate', auxAt: 'sub0', samples: 8 },
  determinism: 'hash-same-machine',
  draft: { kind: 'scale', samples: 1, scale: 0.5 },
  final: { samples: 1, scale: 1 },
  granularity: 'frame',
  randomAccess: true,
  modes: ['native-code'],
  cost: { unit: 'gpu-second' },
  metaNull: ['stats.noise', 'lights'],
});
