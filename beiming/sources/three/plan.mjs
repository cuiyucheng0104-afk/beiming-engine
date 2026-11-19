// 装载和出帧之前的计划：这个镜头装不装得了、要的输出交不交得出、生效的快门、子帧相位、输出尺寸。
// 纯函数，不碰渲染器，页面和 node 两边都引用。交不出的请求一律报带错误码的错，不少交、不换一种交。
import { renderingOf } from '../../kernel/eval/input.mjs';
import { shutterSubs } from '../../kernel/eval/time.mjs';

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const AUX = ['depth', 'objectId', 'normal', 'motion'];
const bad = (message) => new SourceError('usage.bad-argument', message);
const used = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === 'object' && Object.keys(v).length > 0);

/** 声明过的输出：outputs 里出现并且取值不是 false；lightgroup:<名> 看 lightgroup:* 这个键 */
export const declared = (caps, name) => {
  const key = name.startsWith('lightgroup:') ? 'lightgroup:*' : name;
  return Object.hasOwn(caps.outputs, key) && caps.outputs[key] !== false;
};

/**
 * 装载之前：input 是镜头输入，env 是运行环境。装不了就报错，装得了返回 { seed, shutterSamples }：
 * 镜头种子，和锁文件里记的子帧采样数（没有锁文件时不出现）。
 */
export function planOpen(caps, input, env) {
  const { shot } = input, { source, host, mode } = renderingOf(shot);
  if (source !== caps.id) throw bad(`出这个镜头的帧源是 ${source}，不是 ${caps.id}`);
  if (!['draft', 'final'].includes(env.tier)) throw bad(`档位只能是 draft、final，给的是 ${env.tier}`);
  if (!caps.hosts.includes(host) || !caps.modes.includes(mode)) throw new SourceError('contract.unsupported-mode', `${caps.id} 帧源不支持宿主 ${host} 加作者模式 ${mode}`);
  // 用了资产：镜头条目的 assets、镜头输入里全片的 assets，有一个不空就算
  const cards = used(shot.cards), assets = used(shot.assets) || used(input.assets);
  if (env.lock === null) {
    // 没有锁文件：种子只能来自镜头条目；卡和资产的版本、哈希只有锁文件里有
    if (!Number.isInteger(shot.seed)) throw new SourceError('env.lock-required', `没有锁文件，镜头 ${shot.id} 又没写 seed`);
    if (cards || assets) throw new SourceError('env.lock-required', `没有锁文件，镜头 ${shot.id} 却用了${cards ? '卡' : '资产'}`);
  }
  // shortcut: 卡、资产、叠加层这条链路都还没接（叠加层要展开成卡实例），带着锁文件来也装不了：报错，不少装一样照常装载；接卡时在这里读锁里的版本和哈希
  const unfit = [cards && '卡', assets && '资产', used(input.overlays) && '叠加层'].filter(Boolean);
  if (unfit.length) throw new SourceError('contract.unsupported-input', `${caps.id} 帧源还没接${unfit.join('、')}`);
  if (env.lock === null) return { seed: shot.seed };
  const seed = env.lock.seeds?.[shot.id], shutterSamples = env.lock.shots?.[shot.id]?.shutterSamples;
  if (!Number.isInteger(seed) || !Number.isInteger(shutterSamples)) throw bad(`锁文件里没有镜头 ${shot.id} 的种子或子帧采样数`);
  return { seed, shutterSamples };
}

/**
 * 一次 render 的计划。shot 是镜头条目，size 是画幅 [宽, 高]，locked 是 planOpen 的返回值。
 * 返回 { angleDeg, shutterSamples, subs, size, pixelSamples, layers, aux }：layers 是这次要交的像素输出，aux 是里面有没有辅助层。
 * 取值次序：这次调用 → 锁文件 → 镜头条目 → 能力声明。
 */
export function planRender(caps, shot, size, tier, opts = {}, want, locked = {}) {
  if (!Array.isArray(want) || want.some((n) => typeof n !== 'string') || new Set(want).size !== want.length) throw bad('want 必须是不重复的输出名数组');
  const missing = want.filter((n) => !declared(caps, n));
  if (missing.length) throw new SourceError('contract.unsupported-output', `这个帧源交不出：${missing.join('、')}`);

  const angleDeg = opts.shutter?.angleDeg ?? shot.shutter?.angleDeg ?? 0;
  if (!(angleDeg >= 0 && angleDeg <= 360)) throw bad(`快门角必须在 [0, 360] 度，给的是 ${angleDeg}`);
  const shutterSamples = opts.shutter?.samples ?? locked.shutterSamples ?? shot.shutter?.samples ?? (angleDeg === 0 ? 1 : caps.motionBlur.samples);
  if (!Number.isInteger(shutterSamples) || shutterSamples < 1) throw bad(`子帧采样数必须是不小于 1 的整数，给的是 ${shutterSamples}`);
  if (angleDeg === 0 && shutterSamples > 1) throw new SourceError('contract.shutter-conflict', `快门角是 0，子帧采样数却是 ${shutterSamples}`);

  const preset = shot.tiers?.[tier] ?? {};
  const scale = opts.scale ?? preset.scale ?? caps[tier].scale;
  const pixelSamples = opts.samples ?? preset.samples ?? caps[tier].samples;
  if (!(scale > 0 && scale <= 1)) throw bad(`scale 必须在 (0, 1]，给的是 ${scale}`);
  if (!Number.isInteger(pixelSamples) || pixelSamples < 1) throw bad(`每像素采样数必须是不小于 1 的整数，给的是 ${pixelSamples}`);
  // shortcut: 每像素只取 1 个样本（没接多重采样），要更多就报错；颜色层要抗锯齿时再接
  if (pixelSamples !== 1) throw new SourceError('contract.unsupported-option', `这个帧源每像素只取 1 个样本，要的是 ${pixelSamples}`);

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
