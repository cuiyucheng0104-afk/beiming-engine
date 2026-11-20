// 镜头契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是一份镜头核对记录（shot-check/0.1），返回这条不变量下发现的问题；空数组表示没违反。
// 记录里没出现的段不判；不是核对记录的对象一律返回空数组。

const ENTITY_NAME = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const META_KEYS = new Set(['texts', 'anchors', 'readings']);

const onRecord = (fn) => (obj, ctx) => (obj?.format === 'shot-check/0.1' ? fn(obj, ctx) : []);

const raw = {
  S1: (rec) => {
    const seen = new Map();
    for (const e of rec.evaluations ?? []) {
      const k = `f=${e.f} sub=${e.sub}`;
      seen.set(k, (seen.get(k) ?? new Set()).add(e.digest));
    }
    return [...seen].filter(([, d]) => d.size > 1).map(([k]) => `镜头 ${rec.shot} 同一个时刻求出了不同的状态摘要：${k}`);
  },

  // 没有入口文件、或者没放观测点的镜头没有 buildCalls，不判
  S2: (rec) => (rec.buildCalls === undefined || rec.buildCalls === 1 ? [] : [`镜头 ${rec.shot} 的 buildCalls 是 ${rec.buildCalls}，必须是 1`]),

  S3: (rec) => [
    ...(rec.sources.length === 1 ? [] : [`镜头 ${rec.shot} 的 sources 有 ${rec.sources.length} 项：${rec.sources.join('、')}`]),
    ...(rec.languages.length === 1 ? [] : [`镜头 ${rec.shot} 的 languages 有 ${rec.languages.length} 项：${rec.languages.join('、')}`]),
  ],

  S4: (rec) => {
    const out = [];
    const all = new Set();
    for (const n of rec.entities) {
      if (!ENTITY_NAME.test(n)) out.push(`实体名写法不对：${n}`);
      if (all.has(n)) out.push(`实体名重复：${n}`);
      all.add(n);
    }
    const omittable = new Set(rec.omittable ?? []);
    for (const m of rec.metaEntities ?? []) {
      const names = new Set(m.names);
      for (const n of names) if (!all.has(n)) out.push(`第 ${m.f} 帧元数据里的实体 ${n} 不在 entities 里`);
      const missing = [...all].filter((n) => !names.has(n));
      const omitted = m.omittedParts ?? 0;
      if (missing.length !== omitted) out.push(`第 ${m.f} 帧元数据缺了 ${missing.length} 个实体，omittedParts 是 ${omitted}`);
      for (const n of missing) if (!omittable.has(n)) out.push(`第 ${m.f} 帧元数据缺的实体 ${n} 不在 omittable 里`);
    }
    return out;
  },

  S5: (rec) => (rec.patches ?? [])
    .filter((p) => p.hits === 0 && rec.build !== 'failed')
    .map((p) => `片段补丁 ${p.id} 命中 0 处，build 却是 ${rec.build}`),

  // 搭建的顺序不在这里判：归卡的运行时接口契约（CR）里管装载顺序的各条，用装载核对记录判
  S6: (rec) => (rec.mode === 'cards-data' && rec.entry !== undefined ? [`「卡加数据」模式的镜头 ${rec.shot} 带了入口文件 ${rec.entry}`] : []),

  S7: (rec) => [
    ...(rec.scan?.wallClock ?? []).map((h) => `镜头代码读了墙钟：${h.path} ${h.call}`),
    ...(rec.scan?.unseededRandom ?? []).map((h) => `镜头代码用了不带种子的随机：${h.path} ${h.call}`),
  ],

  S8: (rec) => (rec.metaKeys ?? []).filter((k) => !META_KEYS.has(k)).map((k) => `meta(f) 交了不许交的键：${k}`),

  S9: (rec) => {
    const declared = new Set(rec.declaredCards ?? []);
    // 一次构建只报一个码：取 cardUses 里第一个违反的项；同一项两种都犯算没声明那一种（5.8）
    for (const u of rec.cardUses ?? []) {
      const want = !declared.has(u.as) ? 'contract.undeclared-card'
        : (u.runtimeKeys ?? []).some((k) => (u.paramKeys ?? []).includes(k)) ? 'contract.runtime-shadows-param'
          : null;
      if (!want) continue;
      const what = want === 'contract.undeclared-card' ? `用了没声明的实例名 ${u.as}` : `实例 ${u.as} 的 runtime 键和卡参数同名`;
      return rec.build === 'failed' && rec.error === want ? [] : [`${what}，必须判构建失败并报 ${want}；build 是 ${rec.build}，error 是 ${rec.error ?? '没有'}`];
    }
    return [];
  },

  // want 里出现的每个字段，seen 里必须有并且相等；数组（size）按项比。want 里没有的字段不判（5.10）
  S10: (rec) => (rec.ctx ?? []).flatMap(({ want, seen }, i) => Object.keys(want)
    .filter((k) => JSON.stringify(seen[k]) !== JSON.stringify(want[k]))
    .map((k) => `镜头 ${rec.shot} 第 ${i + 1} 次装载交给镜头代码的 ctx.${k === 'shotIn' ? 'shot.in' : k} 是 ${JSON.stringify(seen[k]) ?? '没有'}，必须是 ${JSON.stringify(want[k])}`)),

  // 登记表在第二个参数的 registries.errors 里
  S11: (rec, { registries }) => (rec.error === undefined || registries.errors.codes.some((c) => c.code === rec.error)
    ? [] : [`镜头 ${rec.shot} 报的错误码 ${rec.error} 没有登记在错误码表里`]),
};

export const checks = Object.fromEntries(Object.entries(raw).map(([id, fn]) => [id, onRecord(fn)]));
