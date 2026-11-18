// 观测点：包在镜头代码外面，站在帧源和镜头代码之间，记下帧源实际对镜头代码做了什么。
// 它是测试工具的一部分，不是帧源的，也不是被测镜头代码的；记下的数经 meta(f) 的 readings 交出去（读数只能是数）。
// 记什么：build 跑了几次；每次 state 收到的 (f, sub)，以及场景停在那个状态时被画了几遍、各是哪一种；
// meta(f) 交回了哪些键；ctx.cards.use 被调了几次；ctx.rng 开出的流叫什么名字、出什么数。

export const RNG_DRAWS = 16;
// 两轮取数：开的流不一样多、取用的次序也不一样，同名的流必须还是同样的序列
export const RNG_RUNS = { a: ['probe/alpha', 'probe/beta'], b: ['probe/beta', 'probe/extra', 'probe/alpha'] };
const META_KEYS = ['texts', 'anchors', 'readings'];

/** 把 build 包上观测。一个页面里这个模块只装一次，builds 数的就是这个页面里 build 一共跑了几次 */
export function observed(build) {
  let builds = 0;
  return async function observedBuild(ctx) {
    builds += 1;
    let cardUses = 0, states = [], metaKeys = { other: 0 };
    const inner = await build({ ...ctx, cards: { use: (...args) => { cardUses += 1; return ctx.cards.use(...args); } } });

    const fixed = { 'obs.in': ctx.shot.in };
    for (const [run, order] of Object.entries(RNG_RUNS)) {
      const streams = order.map((arg) => ({ arg, s: ctx.rng(arg) }));
      streams.forEach(({ arg, s }, k) => { fixed[`obs.rng.${run}.${k}.name`] = s.name === `${ctx.seed}/${ctx.shot.id}/${arg}` ? 1 : 0; });
      for (let i = 0; i < RNG_DRAWS; i++) streams.forEach(({ s }, k) => { fixed[`obs.rng.${run}.${k}.${i}`] = s.u32(); });
    }

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
        const readings = { ...extra.readings, ...fixed, 'obs.builds': builds, 'obs.cardUses': cardUses, 'obs.states': states.length };
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
 * 返回 { builds, shotIn, cardUses, metaKeys, states: [{ f, sub, color, aux }], rng: [{ run, arg, nameOk, values }] }：
 * states 是上一次 meta(f) 之后 state 的每一次调用，按先后；metaKeys 是镜头代码的 meta(f) 交回过的键，不认识的键记作 unknown。
 */
export function readObservation(readings) {
  if (!readings || !('obs.builds' in readings)) return null;
  const r = (k) => readings[`obs.${k}`];
  return {
    builds: r('builds'),
    shotIn: r('in'),
    cardUses: r('cardUses'),
    metaKeys: [...META_KEYS.filter((k) => r(`meta.${k}`)), ...(r('meta.other') ? ['unknown'] : [])],
    states: Array.from({ length: r('states') }, (_, i) => ({ f: r(`state.${i}.f`), sub: r(`state.${i}.sub`), color: r(`state.${i}.color`), aux: r(`state.${i}.aux`) })),
    rng: Object.entries(RNG_RUNS).flatMap(([run, order]) => order.map((arg, k) => ({
      run, arg, nameOk: r(`rng.${run}.${k}.name`) === 1, values: Array.from({ length: RNG_DRAWS }, (_, i) => r(`rng.${run}.${k}.${i}`)),
    }))),
  };
}
