// 核心帧源的能力声明。纯数据。version 是内核源码的内容摘要（chassis/build.mjs 的 sourceKey，编好的渲染程序按它命名），由宿主传进来。
// 落在帧源登记表 core 一项之内：输出类型、运动模糊的做法和登记表相同；宿主、作者模式、场景查询、输出只列这个实现真的接上了的
// （声明了就必须装得起来、答得出来）。登记表里还是「待探针」的 determinism 照本机实测填，见 README.md「确定性」。

/** 宿主只有一种：node 里起渲染程序 core-render 离屏出帧（登记表里的 headless-page 没接） */
export const HOST = 'offscreen';

export const caps = (version) => ({
  format: 'caps/0.1',
  id: 'core',
  version,
  language: 'wgsl',
  hosts: [HOST],
  conformance: 'full',
  input: 'scene-pack/0.1',
  solvers: ['path'],
  channels: 'passes/0.1',
  outputs: {
    color: { type: 'f32', transfer: 'linear', primaries: 'rec709', note: '场景线性，不降噪的样本均值；分量 R、G、B、A，RGB 已预乘 A；背景对相机不可见时什么都没打到的样本 A 与 RGB 记 0' },
    meta: true,
    depth: { type: 'f32', note: '平面深度，米；辅助样本（sub = 0、针孔、像素中心，一个）；什么都没打到写 1e10' },
    objectId: { type: 'u32', note: '辅助样本打到的实体编号，0 表示没打到；覆盖率另放在同目录的 objectId.coverage.f32（形状相同，f32），层引用只带 id 一个分量' },
    normal: { type: 'f32', note: '相机空间（看 −Z、Y 向上）的着色法线，背对相机的翻向相机；辅助样本；什么都没打到写 (0, 0, 0)' },
    motion: false,
    denoiseAlbedo: { type: 'f32', note: 'Cycles 降噪特征的反照率：相机首次命中处漫反射类闭包的反照率之和，样本均值；不跟反射、不按粗糙度加权（Cycles 默认两样都开），上游顶替的闭包取底色' },
    denoiseNormal: { type: 'f32', note: 'Cycles 降噪特征的相机空间（看 +Z、Y 向上），世界法线样本均值换过去，不归一' },
    'lightgroup:*': false,
    // 输出通道契约 3.1 的八个光路通道是可选的，内核还没出这几层：照实写交不出
    diffuseDirect: false,
    diffuseIndirect: false,
    glossyDirect: false,
    glossyIndirect: false,
    transmissionDirect: false,
    transmissionIndirect: false,
    emission: false,
    environment: false,
  },
  sceneQuery: ['bbox3d', 'belowGround'],
  // 内核没有运动模糊：生效的快门角大于 0 的 render 报 contract.unsupported-option
  motionBlur: { mode: 'native', auxAt: 'sub0' },
  determinism: 'hash-same-machine',
  // 颜色层是不降噪的样本均值，所以两档都不写 denoise
  draft: { kind: 'path-low', samples: 24, scale: 0.5 },
  // 终稿档还没过门，open 时 env.tier 是 final 就报错；这一格是结构必填，数照登记表的例子
  final: { samples: 64, scale: 1 },
  granularity: 'frame',
  randomAccess: true,
  // 镜头条目的 entry 指向一个场景包；卡加数据没接
  modes: ['build-script'],
  cost: { unit: 'gpu-second' },
  // 灯在元数据里写 null；噪声不估
  metaNull: ['stats.noise', 'lights'],
});
