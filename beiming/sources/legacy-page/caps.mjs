// legacy-page 帧源的能力声明。纯数据。旧页面作品只交得出显示参考的颜色层和带文字框的元数据：
// 合规档 limited（帧源接口契约 3.5），camera、entities 写 null，辅助层和场景查询一样都不声明。

// 帧源版本：对应页面约定 v1（engine/render/page.mjs 的 CONTRACT_VERSION）
export const VERSION = '1.0.0';
// 旧作品锁定的渲染库：three r170（页面里的 importmap，基线清单 env.three）
export const THREE_VERSION = '0.170.0';

export const caps = () => ({
  format: 'caps/0.1',
  id: 'legacy-page',
  version: VERSION,
  language: 'js',
  hosts: ['page'],
  conformance: 'limited',
  outputs: {
    color: { type: 'f32', transfer: 'linear', primaries: 'rec709', note: '显示参考：8 位 sRGB 截图按 IEC 61966-2-1 分段传递函数解码成线性，透明度恒为 1' },
    meta: true,
    depth: false,
    objectId: false,
    normal: false,
    motion: false,
  },
  sceneQuery: [],
  // 页面 render(t) 能取任意时刻，所以按子帧时刻逐张截图、在线性光里平均；默认只取 1 个子帧，和旧作品出片一致
  motionBlur: { mode: 'accumulate', auxAt: 'sub0', samples: 1 },
  determinism: 'hash-same-machine',
  draft: { kind: 'scale', samples: 1, scale: 0.5 },
  final: { samples: 1, scale: 1 },
  granularity: 'frame',
  randomAccess: true,
  modes: ['native-code'],
  cost: { unit: 'gpu-second' },
  metaNull: ['stats.noise', 'stats.tris'],
});
