// 谓词登记表契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// PR1 到 PR6 判谓词登记表（predicates/0.1），PR7 判登记成 verdict.schema.json 的判定条目（内嵌值，认对象看第二个参数的 schema）；不归这条管的对象返回空数组。

// 5.6 表里 floor 1 版的六条 expr，次序就是表里的次序
const FLOOR_V1 = [
  'delivery(output)',
  'loudness(film) in [-15,-13] ; true_peak(film) <= -1',
  'cut_at(shots) ; no_cut',
  'inside_frame(hero, margin=0.05)',
  'visible(hero) >= 0.5',
  'text_matches(copy)',
];

const isTable = (obj) => obj?.format === 'predicates/0.1';
const preds = (t) => t.predicates ?? [];
const registered = (t, name) => preds(t).filter((p) => p.name === name);

/** 逐个模板条目的 uses 里查到的登记项：[{ tpl, i, name, pred }] */
const usedPreds = (t, tplFilter, itemFilter) => (t.templates ?? []).filter(tplFilter).flatMap((tpl) =>
  (tpl.items ?? []).flatMap((it, i) => (itemFilter(it) ? (it.uses ?? []).flatMap((name) =>
    registered(t, name).map((pred) => ({ tpl, i, name, pred }))) : [])));

const onTable = (fn) => (obj) => (isTable(obj) ? fn(obj) : []);

export const checks = {
  PR1: onTable((t) => {
    const seen = new Set();
    return preds(t).filter((p) => (seen.has(p.name) ? true : (seen.add(p.name), false)))
      .map((p) => `谓词 ${p.name} 登记了不止一次`);
  }),

  PR2: onTable((t) => preds(t).flatMap((p) => [
    ...['params', 'reads', 'requires', 'since'].filter((k) => !(k in p)).map((k) => `谓词 ${p.name} 缺 ${k}`),
    ...(Array.isArray(p.reads) && p.reads.length < 1 ? [`谓词 ${p.name} 的 reads 是空数组`] : []),
  ])),

  PR3: onTable((t) => (t.templates ?? []).flatMap((tpl) => (tpl.items ?? []).flatMap((it, i) =>
    (it.uses ?? []).filter((name) => registered(t, name).length === 0)
      .map((name) => `模板 ${tpl.name} 第 ${i + 1} 条的 uses 里的 ${name} 没有登记`)))),

  PR4: onTable((t) => (t.templates ?? [])
    .filter((tpl) => tpl.name === 'floor' && Number(String(tpl.version).split('.')[0]) === 1)
    .flatMap((tpl) => {
      const items = tpl.items ?? [];
      if (items.length !== FLOOR_V1.length) return [`模板 floor ${tpl.version} 有 ${items.length} 条，必须正好 6 条`];
      return items.flatMap((it, i) => (it.expr === FLOOR_V1[i] ? [] : [`模板 floor ${tpl.version} 第 ${i + 1} 条的 expr 是 ${it.expr}，必须是 ${FLOOR_V1[i]}`]));
    })),

  PR5: onTable((t) => usedPreds(t, (tpl) => tpl.name === 'floor', () => true)
    .filter(({ pred }) => pred.since !== '0.1')
    .map(({ tpl, i, name, pred }) => `模板 floor ${tpl.version} 第 ${i + 1} 条用的 ${name} 的 since 是 ${pred.since}`)),

  PR6: onTable((t) => usedPreds(t, () => true, (it) => it.limited === true)
    .filter(({ pred }) => (pred.requires ?? []).some((r) => r === 'meta' || r === 'objectId'))
    .map(({ tpl, i, name, pred }) => `模板 ${tpl.name} 第 ${i + 1} 条 limited 是 true，它用的 ${name} 的 requires 是 ${JSON.stringify(pred.requires)}`)),

  PR7: (obj, { schema } = {}) => (schema === 'verdict.schema.json' && obj.status === 'skipped' && !('reason' in obj)
    ? [`判定条目 ${obj.id} 的 status 是 skipped，没带 reason`] : []),
};
