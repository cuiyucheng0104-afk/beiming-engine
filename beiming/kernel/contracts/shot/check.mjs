// 镜头契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是一份镜头核对记录（shot-check/0.1），返回这条不变量下发现的问题；空数组表示没违反。
// 记录里没出现的段不判；不是核对记录的对象一律返回空数组。

const ENTITY_NAME = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const META_KEYS = new Set(['texts', 'anchors', 'readings']);

const onRecord = (fn) => (obj) => (obj?.format === 'shot-check/0.1' ? fn(obj) : []);

const raw = {
  S1: (rec) => {
    const seen = new Map();
    for (const e of rec.evaluations ?? []) {
      const k = `f=${e.f} sub=${e.sub}`;
      seen.set(k, (seen.get(k) ?? new Set()).add(e.digest));
    }
    return [...seen].filter(([, d]) => d.size > 1).map(([k]) => `镜头 ${rec.shot} 同一个时刻求出了不同的状态摘要：${k}`);
  },

  S2: (rec) => (rec.buildCalls === 1 ? [] : [`镜头 ${rec.shot} 的 buildCalls 是 ${rec.buildCalls}，必须是 1`]),

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

  // 后一半「搭建的顺序按 CR 契约判」不在镜头核对记录里，归装载核对记录（CR）判
  S6: (rec) => (rec.mode === 'cards-data' && rec.entry !== undefined ? [`「卡加数据」模式的镜头 ${rec.shot} 带了入口文件 ${rec.entry}`] : []),

  S7: (rec) => [
    ...(rec.scan?.wallClock ?? []).map((h) => `镜头代码读了墙钟：${h.path} ${h.call}`),
    ...(rec.scan?.unseededRandom ?? []).map((h) => `镜头代码用了不带种子的随机：${h.path} ${h.call}`),
  ],

  S8: (rec) => (rec.metaKeys ?? []).filter((k) => !META_KEYS.has(k)).map((k) => `meta(f) 交了不许交的键：${k}`),

  S9: (rec) => {
    const out = [];
    const uses = rec.cardUses ?? [];
    const declared = new Set(rec.declaredCards ?? []);
    const undeclared = uses.filter((u) => !declared.has(u.as));
    if (undeclared.length && !(rec.build === 'failed' && rec.error === 'contract.undeclared-card')) {
      out.push(`用了没声明的实例名 ${undeclared.map((u) => u.as).join('、')}，build 是 ${rec.build}，error 是 ${rec.error ?? '没有'}`);
    }
    const shadow = uses.filter((u) => (u.runtimeKeys ?? []).some((k) => (u.paramKeys ?? []).includes(k)));
    if (shadow.length && !(rec.build === 'failed' && rec.error === 'contract.runtime-shadows-param')) {
      out.push(`实例 ${shadow.map((u) => u.as).join('、')} 的 runtime 键和卡参数同名，build 是 ${rec.build}，error 是 ${rec.error ?? '没有'}`);
    }
    return out;
  },
};

export const checks = Object.fromEntries(Object.entries(raw).map(([id, fn]) => [id, onRecord(fn)]));
