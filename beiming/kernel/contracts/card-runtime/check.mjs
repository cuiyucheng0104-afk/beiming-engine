// 卡的运行时接口与装载顺序契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是卡核对记录（card-check/0.1）或装载核对记录（load-check/0.1），返回这条不变量下发现的问题；空数组表示没违反。
// 记录里没出现的段不判；不归这条管的对象一律返回空数组。

const META_KEYS = new Set(['texts', 'anchors', 'readings']);

const onFormat = (format, fn) => (obj) => (obj?.format === format ? fn(obj) : []);
const card = (fn) => onFormat('card-check/0.1', fn);
const load = (fn) => onFormat('load-check/0.1', fn);

/** f、sub 相同的观测里摘要不止一种的时刻 */
function mixedDigests(evaluations) {
  const seen = new Map();
  for (const e of evaluations ?? []) {
    const k = `f=${e.f} sub=${e.sub}`;
    seen.set(k, (seen.get(k) ?? new Set()).add(e.digest));
  }
  return [...seen].filter(([, d]) => d.size > 1).map(([k]) => k);
}

/** 5.2 的排法：每一步在前驱都已排好的卡里取书写顺序最靠前的；成环或提到 cards 以外的名字返回 null */
function declaredOrder(cards, pairs) {
  const known = new Set(cards);
  if (pairs.some(([a, b]) => !known.has(a) || !known.has(b))) return null;
  const done = new Set();
  const out = [];
  while (out.length < cards.length) {
    const next = cards.find((c) => !done.has(c) && pairs.every(([a, b]) => b !== c || done.has(a)));
    if (next === undefined) return null;
    done.add(next);
    out.push(next);
  }
  return out;
}

/** 5.2：先后要求排不出 create 次序（成环，或提到 cards 以外的名字） */
const unorderable = (rec) => declaredOrder(rec.cards, rec.orderPairs ?? []) === null;

/** 管装载顺序的各条：排不出次序的记录不判，只由 CR9 查 build（5.2） */
const ordered = (fn) => load((rec) => (unorderable(rec) ? [] : fn(rec)));

/** overlays 里和 cards 重名的名字（CR16） */
const clashes = (rec) => (rec.overlays ?? []).filter((o) => rec.cards.includes(o));

/** 5.3：除第一项外每个名字都必须在 createOrder 里，下标必须严格递增 */
function increasing(rec, order, first, label) {
  if (!order) return [];
  if (!order.length) return [`镜头 ${rec.shot} 的 ${label} 是空数组，第一项必须是 ${first}`];
  const out = order[0] === first ? [] : [`镜头 ${rec.shot} 的 ${label} 第一项是 ${order[0]}，必须是 ${first}`];
  let prev = -1;
  for (const name of order.slice(1)) {
    const i = rec.createOrder.indexOf(name);
    if (i < 0) out.push(`镜头 ${rec.shot} 的 ${label} 里 ${name} 不在 createOrder 里`);
    else if (i <= prev) out.push(`镜头 ${rec.shot} 的 ${label} 里 ${name} 没按 createOrder 的次序排`);
    if (i >= 0) prev = i;
  }
  return out;
}

const pureGate = (shape, what) => card((rec) => (rec.shape === shape
  ? mixedDigests(rec.evaluations).map((k) => `卡 ${rec.card} 的 ${what} 同一个时刻求出了不同的摘要：${k}`)
  : []));

const raw = {
  CR1: card((rec) => (rec.entries.length === 1 && rec.entries[0] === rec.shape
    ? [] : [`卡 ${rec.card} 的 entries 是 ${JSON.stringify(rec.entries)}，必须正好是 ["${rec.shape}"]`])),

  CR2: card((rec) => {
    const want = { create: 'cards.use', evaluate: 'tracks' }[rec.shape];
    return rec.calledVia === want ? [] : [`卡 ${rec.card} 的形状是 ${rec.shape}，calledVia 却是 ${rec.calledVia}`];
  }),

  CR3: card((rec) => {
    if (rec.shape !== 'create') return rec.handle ? [`evaluate 形状的卡 ${rec.card} 带了 handle`] : [];
    if (!rec.handle) return [`create 形状的卡 ${rec.card} 没有 handle`];
    return rec.handle.members.includes('dispose') ? [] : [`卡 ${rec.card} 的 Handle 没有 dispose`];
  }),

  CR4: pureGate('create', 'apply'),

  CR5: card((rec) => (rec.handle?.metaKeys ?? []).filter((k) => !META_KEYS.has(k))
    .map((k) => `卡 ${rec.card} 的 Handle.meta 交了不许交的键：${k}`)),

  CR6: card((rec) => {
    const h = rec.handle;
    if (!h?.merged) return [];
    if (h.prefix === undefined) return [`卡 ${rec.card} 的 handle.merged 出现了但没有 handle.prefix`];
    const ents = h.entities ?? [];
    const roots = new Set(h.roots ?? []);
    const out = ents.length === h.merged.length ? [] : [`卡 ${rec.card} 的 handle.merged 有 ${h.merged.length} 项，handle.entities 有 ${ents.length} 项`];
    ents.forEach((e, i) => {
      const want = roots.has(e) ? h.prefix : `${h.prefix}.${e}`;
      if (i < h.merged.length && h.merged[i] !== want) out.push(`卡 ${rec.card} 的实体 ${e} 并进镜头叫 ${h.merged[i]}，必须是 ${want}`);
    });
    return out;
  }),

  CR7: pureGate('evaluate', 'evaluate'),

  CR8: ordered((rec) => (JSON.stringify(rec.steps) === '["assets","tracks","create","collect"]'
    ? [] : [`镜头 ${rec.shot} 的搭建次序是 ${rec.steps.join('、')}`])),

  CR9: load((rec) => {
    const want = declaredOrder(rec.cards, rec.orderPairs ?? []);
    if (!want) return rec.build === 'failed' ? [] : [`镜头 ${rec.shot} 的 orderPairs 成环或提到了 cards 以外的名字，排不出 create 次序，build 却是 ${rec.build}`];
    if (clashes(rec).length) return []; // 重名归 CR16
    const overlays = new Set(rec.overlays ?? []);
    const got = rec.createOrder.filter((n) => !overlays.has(n));
    return JSON.stringify(got) === JSON.stringify(want) ? [] : [`镜头 ${rec.shot} 的 create 次序是 ${got.join('、')}，按 5.2 应是 ${want.join('、')}`];
  }),

  CR10: ordered((rec) => increasing(rec, rec.applyOrder, 'tracks', 'applyOrder')),

  CR11: ordered((rec) => increasing(rec, rec.metaOrder, 'host', 'metaOrder')),

  CR12: load((rec) => {
    if (!rec.camera) return [];
    const want = rec.camera.tracksHasCamera ? 'tracks' : 'card';
    return rec.camera.from === want ? [] : [`镜头 ${rec.shot} 的 tracksHasCamera 是 ${rec.camera.tracksHasCamera}，相机却取自 ${rec.camera.from}`];
  }),

  CR13: card((rec) => ((rec.handle?.roots?.length ?? 0) > 1 ? [`卡 ${rec.card} 的 Handle 有 ${rec.handle.roots.length} 个 root 实体：${rec.handle.roots.join('、')}`] : [])),

  CR14: card((rec) => {
    const h = rec.handle;
    if (!h?.mergedMetaIds) return [];
    if (h.prefix === undefined) return [`卡 ${rec.card} 的 handle.mergedMetaIds 出现了但没有 handle.prefix`];
    const ids = h.metaIds ?? [];
    const out = ids.length === h.mergedMetaIds.length ? [] : [`卡 ${rec.card} 的 handle.mergedMetaIds 有 ${h.mergedMetaIds.length} 项，handle.metaIds 有 ${ids.length} 项`];
    ids.forEach((id, i) => {
      const want = `${h.prefix}.${id}`;
      if (i < h.mergedMetaIds.length && h.mergedMetaIds[i] !== want) out.push(`卡 ${rec.card} 的 ${id} 并进镜头叫 ${h.mergedMetaIds[i]}，必须是 ${want}`);
    });
    return out;
  }),

  CR15: ordered((rec) => {
    const overlays = rec.overlays ?? [];
    if (!overlays.length || clashes(rec).length) return []; // 重名归 CR16
    const cards = new Set(rec.cards);
    const lastCard = rec.createOrder.reduce((m, n, i) => (cards.has(n) ? i : m), -1);
    const out = [];
    for (const o of overlays) {
      const i = rec.createOrder.indexOf(o);
      if (i < 0) out.push(`镜头 ${rec.shot} 的叠加层 ${o} 不在 createOrder 里`);
      else if (i < lastCard) out.push(`镜头 ${rec.shot} 的叠加层 ${o} 装在了镜头自己的卡前面`);
    }
    const got = rec.createOrder.filter((n) => overlays.includes(n));
    const want = overlays.filter((o) => rec.createOrder.includes(o));
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`镜头 ${rec.shot} 的叠加层 create 次序是 ${got.join('、')}，必须是 ${want.join('、')}`);
    return out;
  }),

  CR16: load((rec) => clashes(rec).map((o) => `镜头 ${rec.shot} 的叠加层 ${o} 和 cards 里的实例名重名`)),

  CR17: card((rec) => {
    const ents = new Set(rec.handle?.entities ?? []);
    return (rec.handle?.roots ?? []).filter((r) => !ents.has(r)).map((r) => `卡 ${rec.card} 的 handle.roots 里的 ${r} 不在 handle.entities 里`);
  }),
};

export const checks = raw;
