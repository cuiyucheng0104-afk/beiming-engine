// 装载和出帧之前的计划：这个镜头装不装得了、要的输出交不交得出、生效的快门、子帧相位、输出尺寸。
// 纯函数，不碰渲染器，页面和 node 两边都引用。交不出的请求一律报带错误码的错，不少交、不换一种交。
import { checkInstanceNames, expandOverlays, implFor, parseCardRef, unfitReason } from '../../cards/runtime.mjs';
import { renderingOf } from '../../kernel/eval/input.mjs';
import { shutterSubs } from '../../kernel/eval/time.mjs';

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const AUX = ['depth', 'objectId', 'normal', 'motion'];
// 数据层的卡产出的轨道里，这个帧源有地方写的只有相机轨道
const WRITABLE_TRACKS = ['tracks.camera'];
const bad = (message) => new SourceError('usage.bad-argument', message);
// 报错消息里的值：{ toString: 0 }、无原型对象转不成字符串会抛原生 TypeError，丢掉 SourceError.code
const show = (v) => {
  try { return typeof v === 'string' ? JSON.stringify(v) : String(v); } catch { /* 转不成字符串 */ }
  // Symbol.toStringTag 的取值器也可能抛
  try { return Object.prototype.toString.call(v); } catch { return '<unprintable>'; }
};
// 显式写了 null 不能被 ?? 当成没写，悄悄退回默认值
const given = (obj, key) => {
  if (obj != null && Object.hasOwn(obj, key) && obj[key] === null) throw bad(`${key} 不能是 null`);
  return obj?.[key];
};
// opts、shutter 这类参数容器是纯数据：没写可以，写了就必须是普通对象（0n、字符串、数组、Date、Map 这类实例都不行，不然会悄悄退回默认值）。
// 普通对象只有两种：没有原型的，和原型是某个上下文的根 Object.prototype 的（根原型自己没有原型、自带 hasOwnProperty、constructor.prototype 指回自己）。
// 不拿本上下文的 Object.prototype 比，别的上下文（vm、iframe）造的 {} 也要认；Object.create(无原型字典)、class extends null 的实例多了一层原型，不认。
const own = (o, k) => Object.getOwnPropertyDescriptor(o, k)?.value;
const plain = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || (Object.getPrototypeOf(proto) === null && typeof own(proto, 'hasOwnProperty') === 'function' && own(proto, 'constructor')?.prototype === proto);
};
// 交回一份只有自有数据属性的快照，后面只读快照，页面宿主也拿它进页面：全程不执行调用方的取值器，node 和页面两边读到的是同一份。
// 原型上的值过页面序列化就丢了、Symbol 键和不认识的键两边都读不到，所以一律报错，不猜
const box = (v, name, keys) => {
  if (v === undefined) return v;
  let why = '必须是普通对象', snap;
  try {
    if (plain(v)) {
      const stray = Reflect.ownKeys(v).find((k) => !keys.includes(k)), d = Object.getOwnPropertyDescriptors(v);
      if (stray !== undefined) why = `不认识键 ${show(stray)}`;
      else if (keys.some((k) => (d[k] ? !Object.hasOwn(d[k], 'value') : k in v))) why = `的 ${keys.join('、')} 只能是自有的数据属性`;
      else snap = Object.fromEntries(Object.keys(d).filter((k) => d[k].value !== undefined).map((k) => [k, d[k].value]));
    }
  } catch { /* Proxy 的陷阱抛了：当成不是普通对象 */ }
  if (!snap) throw bad(`${name} ${why}，给的是 ${show(v)}`);
  return snap;
};
const OPT_KEYS = ['scale', 'samples', 'shutter'], SHUTTER_KEYS = ['angle', 'angleDeg', 'samples'];
const used = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === 'object' && Object.keys(v).length > 0);

/** 声明过的输出：outputs 里出现并且取值不是 false；lightgroup:<名> 看 lightgroup:* 这个键 */
export const declared = (caps, name) => {
  const key = name.startsWith('lightgroup:') ? 'lightgroup:*' : name;
  return Object.hasOwn(caps.outputs, key) && caps.outputs[key] !== false;
};

/**
 * 装载之前：input 是镜头输入，env 是运行环境，library 是起帧源时提供的卡 { 卡名: { card, sha256 } }（没提供就是空的）。
 * 装不了就报错，装得了返回 { seed, shutterSamples }：镜头种子，和锁文件里记的子帧采样数（没有锁文件时不出现）。
 * 一个卡实例装得了，要提供了这张卡、锁文件锁的版本和内容哈希就是提供的这一份、它有落在这个帧源或数据层的实现；
 * 数据层的卡还要它产出的轨道这个帧源都有地方写。叠加层展开成卡实例之后同样判。资产这个帧源还没接。
 */
export function planOpen(caps, input, env, library = {}) {
  const { shot } = input, { source, host, mode } = renderingOf(shot);
  if (source !== caps.id) throw bad(`出这个镜头的帧源是 ${source}，不是 ${caps.id}`);
  if (!['draft', 'final'].includes(env.tier)) throw bad(`档位只能是 draft、final，给的是 ${env.tier}`);
  if (!caps.hosts.includes(host) || !caps.modes.includes(mode)) throw new SourceError('contract.unsupported-mode', `${caps.id} 帧源不支持宿主 ${host} 加作者模式 ${mode}`);
  // 用了卡：镜头条目的 cards、镜头输入的 overlays（叠加层展开成卡的实例）有一个不空就算；用了资产：镜头条目的 assets、镜头输入里全片的 assets，有一个不空就算
  const cards = used(shot.cards), overlays = used(input.overlays), assets = used(shot.assets) || used(input.assets);
  if (env.lock === null) {
    // 没有锁文件：种子只能来自镜头条目；卡（含叠加层展开出的卡）和资产的版本、哈希只有锁文件里有
    if (!Number.isInteger(shot.seed)) throw new SourceError('env.lock-required', `没有锁文件，镜头 ${shot.id} 又没写 seed`);
    if (cards || overlays || assets) throw new SourceError('env.lock-required', `没有锁文件，镜头 ${shot.id} 却用了${cards ? '卡' : overlays ? '叠加层' : '资产'}`);
  }
  const why = (use) => {
    const reason = unfitReason(library, env.lock, use, caps.id);
    if (reason) return reason;
    const { card } = library[parseCardRef(use).name];
    const stray = implFor(card, caps.id).livesIn === 'data' ? card.ports.out.filter((p) => !WRITABLE_TRACKS.includes(p.type)).map((p) => p.type) : [];
    return stray.length ? `卡 ${card.id} 产出的 ${stray.join('、')} 这个帧源没有地方写` : null;
  };
  const instances = env.lock === null ? [] : [...(shot.cards ?? []).map((c) => ({ ...c, what: '卡' })), ...expandOverlays(input.overlays).map((c) => ({ ...c, what: '叠加层' }))];
  // shortcut: 资产还没接（固定装载的第 1 步现在没有东西可载），带着锁文件来也装不了；接资产时在这里读锁里的版本和哈希
  const unfit = [...instances.map((c) => [c, why(c.use)]).filter(([, reason]) => reason).map(([c, reason]) => `${c.what} ${c.as}（${reason}）`), ...(assets ? ['资产（还没接）'] : [])];
  // 不少装一样照常装载
  if (unfit.length) throw new SourceError('contract.unsupported-input', `${caps.id} 帧源装不了：${unfit.join('；')}`);
  checkInstanceNames(instances.map((c) => c.as));
  if (env.lock === null) return { seed: shot.seed };
  if (env.lock.film !== undefined && env.lock.film !== input.film) throw bad(`锁文件是片子 ${env.lock.film} 的，不是 ${input.film}`);
  const lockedVer = env.lock.sources?.[caps.id]?.version;
  if (lockedVer !== undefined && lockedVer !== caps.version) throw new SourceError('contract.unsupported-input', `锁文件锁的 ${caps.id} 版本是 ${lockedVer}，当前帧源是 ${caps.version}`);
  const seed = env.lock.seeds?.[shot.id], shutterSamples = env.lock.shots?.[shot.id]?.shutterSamples;
  if (!Number.isInteger(seed) || !Number.isInteger(shutterSamples)) throw bad(`锁文件里没有镜头 ${shot.id} 的种子或子帧采样数`);
  return { seed, shutterSamples };
}

/** 快门角：angleDeg 是契约写法，angle 是兼容写法；两个都写又不相等报错。都没写返回 undefined */
export function shutterAngle(shutter) {
  const s = box(shutter, 'shutter', SHUTTER_KEYS), angleDeg = given(s, 'angleDeg'), angle = given(s, 'angle');
  if (angle !== undefined && angleDeg !== undefined && angle !== angleDeg) throw bad(`快门角 angle（${show(angle)}）和 angleDeg（${show(angleDeg)}）对不上`);
  return angleDeg ?? angle;
}

/**
 * 命令行的快门参数：--shutter <快门角，度> 和 --samples <子帧采样数>，交回 RenderOpts 的 { shutter: { angleDeg?, samples? } }，
 * 没给的不出现；别的参数不管。值域由 planRender 判（快门角 0 配多个采样报 contract.shutter-conflict）。
 * 注意这里的 --samples 是子帧采样数，不是 RenderOpts.samples（每像素采样数）。
 */
const FLAGS = new Map([['--shutter', 'angleDeg'], ['--samples', 'samples']]);
export function parseShutterArgs(argv) {
  const shutter = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const key = FLAGS.get(flag);
    if (!key) continue;
    const raw = inline ?? argv[++i];
    if (raw === undefined || raw.trim() === '' || !Number.isFinite(Number(raw))) throw bad(`${flag} 要一个数，给的是 ${raw}`);
    shutter[key] = Number(raw);
  }
  return Object.keys(shutter).length ? { shutter } : {};
}

/**
 * 一次 render 的计划。shot 是镜头条目，size 是画幅 [宽, 高]，locked 是 planOpen 的返回值。
 * 返回 { angleDeg, shutterSamples, subs, size, pixelSamples, auxSub, layers, aux, renderOpts }：layers 是这次要交的像素输出，aux 是里面有没有辅助层，
 * renderOpts 是判过的 opts 的纯数据快照（只有调用方写了的键），页面宿主拿它而不是调用方的原对象进页面。
 * 取值次序：这次调用 → 锁文件 → 镜头条目 → 能力声明。
 */
export function planRender(caps, shot, size, tier, opts = {}, want, locked = {}) {
  if (!Array.isArray(want) || want.some((n) => typeof n !== 'string') || new Set(want).size !== want.length) throw bad('want 必须是不重复的输出名数组');
  const missing = want.filter((n) => !declared(caps, n));
  if (missing.length) throw new SourceError('contract.unsupported-output', `这个帧源交不出：${missing.join('、')}`);

  const o = box(opts, 'opts', OPT_KEYS);
  const optShutter = box(given(o, 'shutter'), 'shutter', SHUTTER_KEYS), shotShutter = box(given(shot, 'shutter'), 'shutter', SHUTTER_KEYS);
  const angleDeg = shutterAngle(optShutter) ?? shutterAngle(shotShutter) ?? 0;
  // 只认有限的 number：'0'、false 这类会被 >= 隐式转换放过去
  if (typeof angleDeg !== 'number' || !(angleDeg >= 0 && angleDeg <= 360)) throw bad(`快门角必须是 [0, 360] 里的数（度），给的是 ${show(angleDeg)}`);
  const shutterSamples = given(optShutter, 'samples') ?? locked.shutterSamples ?? given(shotShutter, 'samples') ?? (angleDeg === 0 ? 1 : caps.motionBlur.samples);
  if (!Number.isInteger(shutterSamples) || shutterSamples < 1) throw bad(`子帧采样数必须是不小于 1 的整数，给的是 ${show(shutterSamples)}`);
  if (angleDeg === 0 && shutterSamples > 1) throw new SourceError('contract.shutter-conflict', `快门角是 0，子帧采样数却是 ${shutterSamples}`);

  const preset = shot.tiers?.[tier] ?? {};
  const scale = given(o, 'scale') ?? preset.scale ?? caps[tier].scale;
  const pixelSamples = given(o, 'samples') ?? preset.samples ?? caps[tier].samples;
  if (typeof scale !== 'number' || !(scale > 0 && scale <= 1)) throw bad(`scale 必须在 (0, 1]，给的是 ${show(scale)}`);
  if (!Number.isInteger(pixelSamples) || pixelSamples < 1) throw bad(`每像素采样数必须是不小于 1 的整数，给的是 ${show(pixelSamples)}`);
  // shortcut: 每像素只取 1 个样本（没接多重采样），要更多就报错；颜色层要抗锯齿时再接
  if (pixelSamples !== 1) throw new SourceError('contract.unsupported-option', `这个帧源每像素只取 1 个样本，要的是 ${pixelSamples}`);

  return {
    angleDeg,
    shutterSamples,
    subs: shutterSubs(angleDeg, shutterSamples),
    size: [Math.max(1, Math.round(size[0] * scale)), Math.max(1, Math.round(size[1] * scale))],
    pixelSamples,
    // 辅助层和元数据固定取 sub = 0（快门窗口 [f, f + angleDeg / 360) 的起点），不累积
    auxSub: 0,
    // 没要颜色层就是「只要元数据」：不出像素
    layers: want.includes('color') ? want.filter((n) => n !== 'meta') : [],
    aux: want.includes('color') && want.some((n) => AUX.includes(n)),
    renderOpts: { ...o, ...(optShutter && { shutter: optShutter }) },
  };
}
