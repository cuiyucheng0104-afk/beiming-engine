// 一次 render 的计划：要的输出交不交得出、生效的快门、子帧相位、输出尺寸。
// 纯函数，不碰渲染器，node 里能测。交不出的请求一律报错，不少交、不换一种交。
import { shutterSubs } from '../../kernel/eval/time.mjs';

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const AUX = ['depth', 'objectId', 'normal', 'motion'];

/** 声明过的输出：outputs 里出现并且取值不是 false；lightgroup:<名> 看 lightgroup:* 这个键 */
export const declared = (caps, name) => {
  const key = name.startsWith('lightgroup:') ? 'lightgroup:*' : name;
  return Object.hasOwn(caps.outputs, key) && caps.outputs[key] !== false;
};

/**
 * shot 是片子描述里的镜头条目，size 是全片画幅 [宽, 高]。
 * 返回 { angleDeg, shutterSamples, subs, size, pixelSamples, layers, aux }：layers 是这次要交的像素输出，aux 是里面有没有辅助层。
 */
export function planRender(caps, shot, size, tier, opts = {}, want) {
  if (!Array.isArray(want) || new Set(want).size !== want.length) throw new TypeError('want 必须是不重复的输出名数组');
  const missing = want.filter((n) => !declared(caps, n));
  if (missing.length) throw new SourceError('contract.unsupported-output', `这个帧源交不出：${missing.join('、')}`);

  const angleDeg = opts.shutter?.angleDeg ?? shot.shutter?.angleDeg ?? 0;
  // 镜头条目和这次调用都没给子帧采样数时由帧源定：开着快门取 8 个，不开取 1 个
  const shutterSamples = opts.shutter?.samples ?? shot.shutter?.samples ?? (angleDeg > 0 ? 8 : 1);
  if (angleDeg === 0 && shutterSamples > 1) throw new SourceError('contract.shutter-conflict', `快门角是 0，子帧采样数却是 ${shutterSamples}`);

  const preset = shot.tiers?.[tier] ?? {};
  const scale = opts.scale ?? preset.scale ?? (tier === 'draft' ? caps.draft.scale : 1);
  const pixelSamples = opts.samples ?? preset.samples ?? (tier === 'draft' ? caps.draft.samples : 1);
  if (!(scale > 0 && scale <= 1)) throw new RangeError(`scale 必须在 (0, 1]，给的是 ${scale}`);
  // shortcut: 每像素只取 1 个样本（没接多重采样），要更多就报错；颜色层要抗锯齿时再接
  if (pixelSamples !== 1) throw new SourceError(undefined, `这个帧源每像素只取 1 个样本，要的是 ${pixelSamples}`);

  return {
    angleDeg,
    shutterSamples,
    subs: shutterSubs(angleDeg, shutterSamples),
    size: [Math.max(1, Math.round(size[0] * scale)), Math.max(1, Math.round(size[1] * scale))],
    pixelSamples,
    // 没要颜色层就是「只要元数据」：不出像素
    layers: want.includes('color') ? want.filter((n) => n !== 'meta') : [],
    aux: want.includes('color') && want.some((n) => AUX.includes(n)),
  };
}
