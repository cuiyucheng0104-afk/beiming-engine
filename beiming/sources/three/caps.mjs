// three 帧源的能力声明。纯数据，页面和 node 两边都引用。
// 只声明这个实现真的交得出的东西：没实现的输出写 false，没实现的查询（intersect、contact）和作者模式不列。
// 凡是由帧源定的默认值都写在这里（默认的子帧采样数、两个档位的每像素采样数和缩放），出帧时不另定。
// library 是起帧源时提供的卡 { 卡名: { card, sha256 } }：提供了卡才声明「卡加数据」模式，没有卡可装时这个模式一个镜头也搭不出来。

import { listThreeHosts, SourceError, THREE_HOSTS } from './hosts.mjs';

export const VERSION = '0.187.0';

const CAPS_OPT_KEYS = ['experimentalHosts', 'mainline', 'mainlineAcceptance', 'exam'];

export const caps = (library = {}, opts = {}) => {
  if (opts !== undefined) {
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new SourceError('usage.bad-argument', 'caps 的 opts 必须是普通对象');
    }
    for (const k of Object.keys(opts)) {
      if (!CAPS_OPT_KEYS.includes(k)) throw new SourceError('usage.bad-argument', `caps 的 opts 不认识键 ${k}`);
      if (opts[k] !== undefined && typeof opts[k] !== 'boolean') {
        throw new SourceError('usage.bad-argument', `caps 的 opts.${k} 必须是布尔值`);
      }
    }
  }
  const hosts = listThreeHosts({
    allowExperimental: opts?.experimentalHosts === true,
    mainline: opts?.mainline,
    mainlineAcceptance: opts?.mainlineAcceptance,
    exam: opts?.exam,
  });
  const experimental = hosts.includes('offscreen');
  return {
    format: 'caps/0.1',
    id: 'three',
    version: VERSION,
    language: 'js',
    hosts,
    conformance: 'full',
    outputs: {
      color: { type: 'f32', transfer: 'linear', primaries: 'rec709', note: '场景线性，预乘透明度；逐子帧读回后在线性光里取平均。显示参考镜头从 32 位浮点目标读回；场景参考镜头（colorRef: scene）从 RGBA16F（16 位半浮点）目标读回，另落成线性 EXR，这一层只有半浮点精度' },
      meta: true,
      depth: { type: 'f32', note: '平面深度，米；不抗锯齿，取像素中心；什么都没打到写 1e10' },
      objectId: { type: 'u32', note: '不抗锯齿，取像素中心；不带覆盖率；0 表示没打到任何实体' },
      normal: { type: 'f32', note: '相机空间，插值后的着色法线，背面翻向相机，长度 1；什么都没打到写 (0, 0, 0)' },
      motion: false,
    },
    sceneQuery: ['bbox3d', 'anchor', 'belowGround'],
    // 默认的子帧采样数 8：帧源接口契约 3.4 登记表里 three 的这一格
    motionBlur: { mode: 'accumulate', auxAt: 'sub0', samples: 8 },
    determinism: 'hash-same-machine',
    draft: { kind: 'scale', samples: 1, scale: 0.5 },
    final: { samples: 1, scale: 1 },
    granularity: 'frame',
    randomAccess: true,
    modes: Object.keys(library).length ? ['cards-data', 'native-code'] : ['native-code'],
    cost: { unit: 'gpu-second' },
    metaNull: ['stats.noise', 'lights'],
    ...(experimental ? { ext: { 'three.hosts': structuredClone(THREE_HOSTS) } } : {}),
  };
};
