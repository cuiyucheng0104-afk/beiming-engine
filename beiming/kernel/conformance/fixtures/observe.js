// 观测点：包在镜头代码外面，站在帧源和镜头代码之间，记下帧源实际对镜头代码做了什么。
// 它是测试工具的一部分，不是帧源的，也不是被测镜头代码的；记下的东西经 meta(f) 的 readings 交出去。
// 读数只能是数，字符串按字符码摊开：<键>.n 是长度，<键>.<i> 是第 i 个字符码。
// 记什么：build 跑了几次；每次 state 收到的 (f, sub)，以及场景停在那个状态时被画了几遍、各是哪一种；
// meta(f) 收到的帧号、交回了哪些键；ctx.cards.use 每次调用传的实例名和 runtime 的键；ctx.rng 开出的流叫什么名字、出什么数；
// ctx.events 里有哪些事件、各是第几帧；build 收到的 ctx 里的 seed、fps、frames、size、shot.in、shot.id 各是什么。

export const RNG_DRAWS = 16;
// 两轮取数：开的流不一样多、取用的次序也不一样，同名的流必须还是同样的序列
export const RNG_RUNS = { a: ['probe/alpha', 'probe/beta'], b: ['probe/beta', 'probe/extra', 'probe/alpha'] };
const META_KEYS = ['texts', 'anchors', 'readings'];
const putText = (out, key, text) => { out[`${key}.n`] = text.length; for (let i = 0; i < text.length; i++) out[`${key}.${i}`] = text.charCodeAt(i); };
const getText = (readings, key) => String.fromCharCode(...Array.from({ length: readings[`${key}.n`] }, (_, i) => readings[`${key}.${i}`]));

/** 把 build 包上观测。一个页面里这个模块只装一次，builds 数的就是这个页面里 build 一共跑了几次 */
export function observed(build) {
  let builds = 0;
  return async function observedBuild(ctx) {
    builds += 1;
    let states = [], metaKeys = { other: 0 };
    const cardUses = [];
    // 转交给镜头代码的是挂在宿主那个 ctx 上面的一层：只换掉 cards，宿主给的别的项（不可枚举的、原型上的）一样不丢。
    // 每次调用先记下传进来的实例名和 runtime 的键，再转给宿主；宿主报错照常往外抛
    const use = (as, runtime, ...rest) => { cardUses.push({ as: String(as), runtimeKeys: Object.keys(runtime ?? {}) }); return ctx.cards.use(as, runtime, ...rest); };
    const inner = await build(Object.create(ctx, { cards: { value: { use }, enumerable: true } }));

    const fixed = {};
    // 这几个值在宿主给的原对象上读，原样交出去；ctx 里没有、或者不是这种东西的那一项不写。shotIn 读的是 ctx.shot.in，shot 是 ctx.shot.id
    for (const k of ['seed', 'frames']) if (typeof ctx[k] === 'number') fixed[`obs.ctx.${k}`] = ctx[k];
    if (typeof ctx.shot?.in === 'number') fixed['obs.ctx.shotIn'] = ctx.shot.in;
    if (typeof ctx.shot?.id === 'string') putText(fixed, 'obs.shot', ctx.shot.id);
    if (typeof ctx.fps === 'string') putText(fixed, 'obs.ctx.fps', ctx.fps);
    if (Array.isArray(ctx.size) && ctx.size.every((v) => typeof v === 'number')) { fixed['obs.ctx.size.n'] = ctx.size.length; ctx.size.forEach((v, i) => { fixed[`obs.ctx.size.${i}`] = v; }); }
    for (const [run, order] of Object.entries(RNG_RUNS)) {
      const streams = order.map((arg) => ({ arg, s: ctx.rng(arg) }));
      // 流名原样交出去：是帧源里的宿主展开的那个，不在这里替它判对错
      streams.forEach(({ s }, k) => putText(fixed, `obs.rng.${run}.${k}.name`, String(s.name)));
      for (let i = 0; i < RNG_DRAWS; i++) streams.forEach(({ s }, k) => { fixed[`obs.rng.${run}.${k}.${i}`] = s.u32(); });
    }

    const events = Object.entries(ctx.events);
    fixed['obs.events'] = events.length;
    events.forEach(([id, f], i) => { putText(fixed, `obs.event.${i}.id`, id); fixed[`obs.event.${i}.f`] = f; });

    // 场景每被画一遍记一笔：镜头自己的材质还在就是颜色，被换成别的材质就是辅助层
    const own = new Set(), meshes = [];
    inner.scene.traverse((o) => { if (o.isMesh) { meshes.push(o); own.add(o.material); } });
    inner.scene.onBeforeRender = () => {
      const now = states.at(-1);
      if (now) now[meshes.every((m) => own.has(m.material)) ? 'color' : 'aux'] += 1;
    };

    return {
      ...inner,
      state(f, sub) {
        states.push({ f, sub, color: 0, aux: 0 });
        return inner.state(f, sub);
      },
      meta(f) {
        const extra = inner.meta(f) ?? {};
        for (const k of Object.keys(extra)) { if (META_KEYS.includes(k)) metaKeys[k] = 1; else metaKeys.other += 1; }
        const readings = { ...extra.readings, ...fixed, 'obs.builds': builds, 'obs.cardUses': cardUses.length, 'obs.states': states.length };
        // 这次 meta 收到的帧号：不是数就不写
        if (typeof f === 'number') readings['obs.metaF'] = f;
        cardUses.forEach((c, i) => {
          putText(readings, `obs.card.${i}.as`, c.as);
          readings[`obs.card.${i}.keys`] = c.runtimeKeys.length;
          c.runtimeKeys.forEach((k, j) => putText(readings, `obs.card.${i}.key.${j}`, k));
        });
        for (const k of [...META_KEYS, 'other']) readings[`obs.meta.${k}`] = metaKeys[k] ?? 0;
        states.forEach((s, i) => { for (const k of ['f', 'sub', 'color', 'aux']) readings[`obs.state.${i}.${k}`] = s[k]; });
        states = [];
        return { ...extra, readings };
      },
    };
  };
}

/**
 * 从一份元数据的 readings 里把观测读出来。没有观测时返回 null。
 * 返回 { builds, shot?, metaF?, cardUses: [{ as, runtimeKeys }], metaKeys, states: [{ f, sub, color, aux }], rng: [{ run, arg, name, values }], events: [{ id, f }], ctx: { seed?, fps?, frames?, shotIn?, size? } }：
 * ctx 是 build 收到的 ctx 里读到的五个值，没读到的那一项不出现；shot 是 ctx.shot.id，metaF 是这次 meta 收到的帧号，没读到就不出现；
 * cardUses 是到这次 meta 为止镜头代码对 ctx.cards.use 的每一次调用，按先后；
 * states 是上一次 meta(f) 之后 state 的每一次调用，按先后；metaKeys 是镜头代码的 meta(f) 交回过的键，不认识的键记作 unknown；
 * rng 的 name 是镜头代码从 ctx.rng 拿到的流名；events 是镜头代码在 ctx.events 里看到的每一项。
 */
export function readObservation(readings) {
  if (!readings || !('obs.builds' in readings)) return null;
  const r = (k) => readings[`obs.${k}`];
  return {
    builds: r('builds'),
    ...(r('shot.n') === undefined ? {} : { shot: getText(readings, 'obs.shot') }),
    ...(r('metaF') === undefined ? {} : { metaF: r('metaF') }),
    cardUses: Array.from({ length: r('cardUses') }, (_, i) => ({
      as: getText(readings, `obs.card.${i}.as`),
      runtimeKeys: Array.from({ length: r(`card.${i}.keys`) }, (_, j) => getText(readings, `obs.card.${i}.key.${j}`)),
    })),
    metaKeys: [...META_KEYS.filter((k) => r(`meta.${k}`)), ...(r('meta.other') ? ['unknown'] : [])],
    states: Array.from({ length: r('states') }, (_, i) => ({ f: r(`state.${i}.f`), sub: r(`state.${i}.sub`), color: r(`state.${i}.color`), aux: r(`state.${i}.aux`) })),
    rng: Object.entries(RNG_RUNS).flatMap(([run, order]) => order.map((arg, k) => ({
      run, arg, name: getText(readings, `obs.rng.${run}.${k}.name`), values: Array.from({ length: RNG_DRAWS }, (_, i) => r(`rng.${run}.${k}.${i}`)),
    }))),
    events: Array.from({ length: r('events') }, (_, i) => ({ id: getText(readings, `obs.event.${i}.id`), f: r(`event.${i}.f`) })),
    ctx: {
      ...(r('ctx.seed') === undefined ? {} : { seed: r('ctx.seed') }),
      ...(r('ctx.fps.n') === undefined ? {} : { fps: getText(readings, 'obs.ctx.fps') }),
      ...(r('ctx.frames') === undefined ? {} : { frames: r('ctx.frames') }),
      ...(r('ctx.shotIn') === undefined ? {} : { shotIn: r('ctx.shotIn') }),
      ...(r('ctx.size.n') === undefined ? {} : { size: Array.from({ length: r('ctx.size.n') }, (_, i) => r(`ctx.size.${i}`)) }),
    },
  };
}
