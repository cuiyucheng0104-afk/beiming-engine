// 探针镜头，测试工具的一部分（s3.test.mjs 用），不是给片子用的：照 ctx.params 在二维讲解舞台上搭任意元素。
// params：elements 是 two-d.js 的元素声明，只是过得了 JSON 的写法：canvas2d 不带 draw，改带 fill [底色, 左上角那一格的颜色]（不写就是透明的画布）、
// clip [x, y, 宽, 高]（画字之前设的裁剪区）和 label { id, text, font, at: [x, y] }（墨色的一段字），三样都可以不写；
// opacity 是按帧号取的数组（可以故意放不是数的东西）。另有 css、fonts、background 原样交给舞台。
// trials 为真时先在页面里把 TRIALS 的坏声明（过不了 JSON 的也在里面）各试装一遍，结果记进 readings，再照常搭 elements。
import { countingHandler, earlyHits, earlyOptions } from './s3-proxy.probe.js';
import { createTwoDStage } from './two-d.js';

const INK = '#1E1B18';

const ONE = { kind: 'dom', html: '<p data-entity="t">x</p>' }, HOLE = [ONE];
HOLE.length = 2;
const FONT = new URL('../../../fonts/NotoSansSC-var.woff2', import.meta.url).href;
const DRAWN = { kind: 'canvas2d', name: 'c', rect: [1, 1, 20, 20], draw() {} }, GONE = Proxy.revocable([DRAWN], {});
GONE.revoke();
/** 包一层 13 种陷阱全转发并计数的活 Proxy，hit() 记一次触发 */
const liveProxy = (target, hit) => new Proxy(target, countingHandler(hit));
/** 带空槽的数组：只有 entries 里的下标有值 */
const sparse = (length, entries) => Object.assign(Array(length), entries);
const sized = (size) => (ctx) => ({ ...ctx, size });
/** 在 size、THREE 之前加一个可枚举 diagnostic 访问器的普通 ctx */
const diagCtx = (ctx, hit) => {
  const out = {};
  Object.defineProperty(out, 'diagnostic', { enumerable: true, get: () => { hit(); return 1; } });
  return Object.assign(out, { size: ctx.size, THREE: ctx.THREE });
};
// 名字: [该报的错误码, opts（写成 (hit) => ... 时按次现造并计陷阱/访问器次数）, ctx（不写就用真的；写成 (ctx, hit) => ... 是从真的改出来的）]。
// font、dup 装到一半才查得出、该经 Promise 报，fine、ctxDiagOk 是写对了的对照，其余都该在调用当场抛
const TRIALS = {
  slot: ['usage.bad-argument', { elements: Array(1) }],
  hole: ['usage.bad-argument', { elements: HOLE }],
  getter: ['usage.bad-argument', { elements: Object.defineProperty([], 0, { get: () => ONE, enumerable: true }) }],
  noCtx: ['usage.bad-argument', { elements: [ONE] }, null],
  noOpts: ['usage.bad-argument', null],
  // 活 Proxy（七个位置，全挂 13 种 Reflect 转发陷阱）：调用当场抛且陷阱计数严格为 0
  proxy: ['usage.bad-argument', (hit) => ({ elements: liveProxy([DRAWN], hit) })],
  swap: ['usage.bad-argument', { elements: new Proxy([DRAWN], { get: (t, k, r) => (k === '0' ? { ...DRAWN, name: 'second' } : Reflect.get(t, k, r)) }) }],
  trap: ['usage.bad-argument', { elements: new Proxy([DRAWN], { getOwnPropertyDescriptor() { throw new Error('陷阱里抛的'); } }) }],
  revoked: ['usage.bad-argument', { elements: GONE.proxy }],
  item: ['usage.bad-argument', (hit) => ({ elements: [liveProxy(DRAWN, hit)] })],
  rectProxy: ['usage.bad-argument', (hit) => ({ elements: [{ ...DRAWN, rect: liveProxy([1, 1, 20, 20], hit) }] })],
  rectHole: ['usage.bad-argument', { elements: [{ ...DRAWN, rect: sparse(4, { 1: 1, 2: 20, 3: 20 }) }] }],
  fontsProxy: ['usage.bad-argument', (hit) => ({ elements: [DRAWN], fonts: liveProxy([{ family: 'Probe', url: FONT }], hit) })],
  // 画幅：缺宽、缺高、高是访问器、是活 Proxy；ctx、opts 自己是活 Proxy；普通 ctx 带前置 diagnostic 访问器
  sizeHole: ['usage.bad-argument', { elements: [DRAWN] }, sized(sparse(2, { 1: 160 }))],
  sizeTail: ['usage.bad-argument', { elements: [DRAWN] }, sized(sparse(2, { 0: 320 }))],
  sizeGetter: ['usage.bad-argument', { elements: [DRAWN] }, sized(Object.defineProperty([320], 1, { get: () => 160, enumerable: true }))],
  sizeProxy: ['usage.bad-argument', { elements: [DRAWN] }, (ctx, hit) => ({ ...ctx, size: liveProxy([320, 160], hit) })],
  ctxProxy: ['usage.bad-argument', { elements: [DRAWN] }, (ctx, hit) => liveProxy(ctx, hit)],
  optsProxy: ['usage.bad-argument', (hit) => liveProxy({ elements: [DRAWN] }, hit)],
  ctxDiagNull: ['usage.bad-argument', null, diagCtx],
  ctxDiagOk: [null, { elements: [DRAWN] }, diagCtx],
  early: ['usage.bad-argument', earlyOptions],
  fine: [null, { elements: [DRAWN] }],
  // 第一款字体登记上了，第二款取不到
  font: ['usage.bad-argument', { elements: [ONE], fonts: [{ family: 'Probe', url: FONT }, { family: 'Gone', url: `${FONT}.gone.woff2` }] }],
  // 第一层排好、画好了，第二层的实体和它重名
  dup: ['contract.bad-value', { elements: [ONE, ONE], fonts: [{ family: 'Probe', url: FONT }] }],
};

/** 把 TRIALS 各试一遍。每种五个读数：sync 调用当场抛的（1 是该报的错误码，-1 是别的，0 没抛）、late 交回的 Promise 失败带的（同上）、nodes 和 fonts 事后页面多出来的节点数、字体数，traps 陷阱/无关访问器被触发的次数 */
async function runTrials(ctx) {
  const readings = {}, count = () => [document.querySelectorAll('*').length, document.fonts.size];
  for (const [name, [code, opts, at = ctx]] of Object.entries(TRIALS)) {
    const before = count(), hit = (err) => (err.code === code ? 1 : -1);
    let sync = 0, late = 0, traps = 0;
    const bump = () => { traps++; };
    try {
      const targetCtx = typeof at === 'function' ? at(ctx, bump) : at;
      const targetOpts = typeof opts === 'function' ? opts(bump) : opts;
      await createTwoDStage(targetCtx, targetOpts).then((stage) => stage.dispose(), (err) => { late = hit(err); });
    } catch (err) { sync = hit(err); }
    const after = count();
    Object.assign(readings, { [`${name}.sync`]: sync, [`${name}.late`]: late, [`${name}.nodes`]: after[0] - before[0], [`${name}.fonts`]: after[1] - before[1], [`${name}.traps`]: traps });
  }
  return { ...readings, earlyHits, ...await declarationReadings(ctx) };
}

/** Node 和页面使用同一批声明。分别记录同步校验、异步装载、属性描述符和陷阱计数。 */
export async function declarationReadings(host) {
  const readings = {};
  async function probe(place, form, badOpts = false) {
    let hits = 0;
    const bump = () => { hits++; };
    const ctx = { get diagnostic() { bump(); return 1; } };
    const item = { ...DRAWN, rect: [...DRAWN.rect] }, font = { family: 'Probe', url: FONT };
    const opts = { elements: [item], fonts: place === 'font' ? [font] : [] };
    const args = { ctx, opts }, size = [...host.size];
    const slots = { ctx: [args, 'ctx'], size: [ctx, 'size'], opts: [args, 'opts'], elements: [opts, 'elements'], item: [opts.elements, 0], rect: [item, 'rect'], fonts: [opts, 'fonts'], font: [opts.fonts, 0] };
    const [owner, key] = slots[place];
    const target = place === 'size' ? size : owner[key];
    const accessor = { get: bump, set: bump, enumerable: true, configurable: true };
    if (form === 'live' || form === 'revoked') {
      const handler = countingHandler(bump);
      if (form === 'live') owner[key] = new Proxy(target, handler);
      else {
        const pair = Proxy.revocable(target, handler);
        pair.revoke();
        owner[key] = pair.proxy;
      }
    } else if (form === 'inherited') {
      Object.setPrototypeOf(target, Object.create(Object.getPrototypeOf(target), { stack: accessor }));
    } else {
      const data = { value: Array.isArray(target) ? 1 : 'keep', writable: true, enumerable: true, configurable: form !== 'fixed' };
      Object.defineProperty(target, 'stack', form === 'accessor' ? accessor : data);
    }
    // 两个访问器都排在真正要读的字段前面。
    if (!Object.hasOwn(ctx, 'size')) ctx.size = size;
    ctx.THREE = host.THREE;
    const proto = Object.getPrototypeOf(target);
    const descriptors = () => [Object.getOwnPropertyDescriptor(target, 'stack'), Object.getOwnPropertyDescriptor(proto, 'stack'), Object.getOwnPropertyDescriptor(ctx, 'diagnostic')];
    const before = descriptors();
    let sync = 0, late = 0;
    try {
      await createTwoDStage(args.ctx, badOpts ? null : args.opts).then((stage) => stage.dispose(), () => { late = 1; });
    } catch (err) { sync = err.code === 'usage.bad-argument' ? 1 : -1; }
    const after = descriptors();
    const kept = before.every((d, i) => d === after[i] || (d && after[i] && Reflect.ownKeys(d).every((k) => Object.is(d[k], after[i][k]))));
    const id = `${place}.${form}${badOpts ? '.badOpts' : ''}`;
    readings[`${id}.kept`] = Number(kept && Object.getPrototypeOf(target) === proto);
    readings[`${id}.sync`] = sync;
    readings[`${id}.late`] = late;
    readings[`${id}.hits`] = hits;
  }
  for (const place of ['ctx', 'size', 'opts', 'elements', 'item', 'rect', 'fonts', 'font']) {
    for (const form of ['data', 'accessor', 'fixed', 'inherited']) await probe(place, form);
    if (place !== 'font') for (const form of ['live', 'revoked']) await probe(place, form);
  }
  await probe('ctx', 'accessor', true);
  return readings;
}

export function build(ctx) {
  const { elements, trials, ...rest } = ctx.params;
  if (trials) return runTrials(ctx).then(async (readings) => { const stage = await stageOf(ctx, elements, rest); return { ...stage, meta: (f) => ({ ...stage.meta(f), readings }) }; });
  return stageOf(ctx, elements, rest);
}

function stageOf(ctx, elements, rest) {
  return createTwoDStage(ctx, {
    ...rest,
    elements: elements.map(({ fill, clip, label, opacity, ...e }) => ({
      ...e,
      ...(opacity && { opacity: (f) => opacity[f] }),
      ...(e.kind === 'canvas2d' && {
        draw(c, { width, height, text }) {
          if (fill) {
            c.fillStyle = fill[0];
            c.fillRect(0, 0, width, height);
            c.fillStyle = fill[1];
            c.fillRect(0, 0, width / 2, height / 2);
          }
          if (clip) {
            c.beginPath();
            c.rect(...clip);
            c.clip();
          }
          if (!label) return;
          c.fillStyle = INK;
          c.font = label.font;
          text(label.id, label.text, ...label.at);
        },
      }),
    })),
  });
}
