// 卡文件格式契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是一份卡文件（card/0.1），返回这条不变量下发现的问题；空数组表示没违反。
// 别的对象（不带 format 的内嵌值等）不归这些条文管，一律返回空数组。

const params = (card) => Object.entries(card.params ?? {});
const isPath = (s) => typeof s === 'string' && /[/\\]/.test(s);

/** 参数里某个键必须且只能在指定类型上出现 */
const onlyOnType = (card, key, type) => params(card).flatMap(([name, p]) => {
  if (p.type === type && !(key in p)) return [`参数 ${name} 的 type 是 ${type}，却没带 ${key}`];
  if (p.type !== type && key in p) return [`参数 ${name} 的 type 是 ${p.type}，却带了 ${key}`];
  return [];
});

const onCard = (fn) => (obj, ctx) => (obj?.format === 'card/0.1' ? fn(obj, ctx) : []);

const raw = {
  CF1: (card) => {
    const impl = (card.impl ?? []).map((i) => i.livesIn);
    const top = new Set(card.livesIn ?? []);
    const out = impl.filter((l, i) => impl.indexOf(l) !== i).map((l) => `impl 里有两项的 livesIn 都是 ${l}`);
    const implSet = new Set(impl);
    for (const l of top) if (!implSet.has(l)) out.push(`顶层 livesIn 有 ${l}，impl 里没有这个落点的卡的入口`);
    for (const l of implSet) if (!top.has(l)) out.push(`impl 里有落点 ${l}，顶层 livesIn 里没有`);
    return out;
  },

  CF2: (card) => (card.impl ?? []).flatMap((i, n) => {
    const want = i.livesIn === 'data' ? 'evaluate' : i.livesIn === 'comp' || i.livesIn?.startsWith('source:') ? 'create' : null;
    return want && i.shape !== want ? [`impl[${n}] 落点是 ${i.livesIn}，shape 是 ${i.shape}，应该是 ${want}`] : [];
  }),

  CF3: (card) => (card.impl ?? [])
    .filter((i) => i.livesIn === 'data' && !(i.entry?.startsWith('kernel/eval/') || i.entry?.startsWith(`cards/${card.kind}/`)))
    .map((i) => `落点是 data 的卡的入口 ${i.entry} 不在 kernel/eval/ 或 cards/${card.kind}/ 之下`),

  CF4: (card) => params(card)
    .filter(([, p]) => p.type === 'number' || p.type === 'integer')
    .flatMap(([name, p]) => {
      if (!Array.isArray(p.range)) return [`参数 ${name} 的 type 是 ${p.type}，却没带 range`];
      const [lo, hi] = p.range;
      // 先看类型：直接比的话 "0.8"、true 会被当成数混过去
      if (typeof p.default !== 'number') return [`参数 ${name} 的 type 是 ${p.type}，default ${JSON.stringify(p.default)} 却不是数`];
      return lo <= p.default && p.default <= hi ? [] : [`参数 ${name} 的 default 是 ${p.default}，不在 range [${lo}, ${hi}] 里`];
    }),

  CF5: (card) => onlyOnType(card, 'space', 'color'),

  CF6: (card) => {
    const seen = new Set();
    return (card.status ?? []).flatMap((s, i) => {
      const key = JSON.stringify([s.host, s.source, s.gpu]);
      if (seen.has(key)) return [`status[${i}] 的 host、source、gpu（${s.host}、${s.source}、${s.gpu}）和前面某一项相同`];
      seen.add(key);
      return [];
    });
  },

  CF7: (card) => [
    ...['studied', 'lab'].filter((k) => card.provenance && k in card.provenance).map((k) => `出现了覆盖层的键 provenance.${k}`),
    ...(card.verify?.parity && 'truth' in card.verify.parity ? ['出现了覆盖层的键 verify.parity.truth'] : []),
    ...(card.ablation ?? []).flatMap((a, i) => ('lab' in a ? [`出现了覆盖层的键 ablation[${i}].lab`] : [])),
    ...(card.priors ?? []).flatMap((p, i) => ('source' in p ? [`出现了覆盖层的键 priors[${i}].source`] : [])),
  ],

  // 取谓词名照 PR 契约 5.5：从断言开头到第一个 `(`、空格或结尾；登记表在第二个参数的 registries.predicates 里。
  // ` ; ` 是 PR 契约 5.5 里把几条断言连成一个模板条目的写法，卡的断言一项只写一条，不许带
  CF8: (card, { registries }) => {
    const known = new Set(registries.predicates.predicates.map((p) => p.name));
    return (card.verify?.predicates ?? []).flatMap((expr) => [
      ...(expr.includes(' ; ') ? [`verify.predicates 里的 ${JSON.stringify(expr)} 带了 " ; "，一项只能写一条断言`] : []),
      ...(known.has(/^[^( ]*/.exec(expr)[0]) ? [] : [`verify.predicates 里的断言 ${JSON.stringify(expr)} 的谓词名没有在谓词登记表里登记`]),
    ]);
  },

  CF9: (card) => onlyOnType(card, 'schema', 'data'),

  CF10: (card) => params(card)
    .filter(([, p]) => p.type === 'string' && isPath(p.default))
    .map(([name, p]) => `参数 ${name} 的 type 是 string，default ${JSON.stringify(p.default)} 是文件路径`),

  CF11: (card) => params(card).flatMap(([name, p]) => {
    const out = [];
    const deg = name.endsWith('Deg');
    if (deg && p.unit !== 'deg') out.push(`参数 ${name} 以 Deg 结尾，unit 却是 ${p.unit}`);
    if (!deg && p.unit === 'deg') out.push(`参数 ${name} 的 unit 是 deg，名字却不以 Deg 结尾`);
    if (p.unit === 'rad') out.push(`参数 ${name} 的 unit 是 rad`);
    return out;
  }),
};

export const checks = Object.fromEntries(Object.entries(raw).map(([id, fn]) => [id, onCard(fn)]));
