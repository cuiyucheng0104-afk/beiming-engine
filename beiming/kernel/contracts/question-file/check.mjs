// 题目文件格式契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是题目文件（question/0.1），返回这条不变量下发现的问题；空数组表示没违反。别的对象一律返回空数组。

const onQuestion = (fn) => (obj, ctx) => (obj?.format === 'question/0.1' ? fn(obj, ctx) : []);
// 谓词登记表契约 5.5：从断言开头到第一个 `(`、空格或结尾
const predicateName = (assertion) => /^[^( ]*/.exec(assertion)[0];

export const checks = {
  QF1: onQuestion((q) => {
    const sum = q.scoring.reduce((s, it) => s + it.weight, 0);
    return Math.abs(sum - 1) <= 1e-9 ? [] : [`scoring 的 weight 加起来是 ${sum}，不是 1`];
  }),

  // 登记表在第二个参数的 registries.predicates 里
  QF2: onQuestion((q, { registries }) => {
    const known = new Set(registries.predicates.predicates.map((p) => p.name));
    return q.basePredicates.flatMap((a, i) => {
      const name = predicateName(a);
      return [
        ...(a.includes(' ; ') ? [`basePredicates 第 ${i + 1} 项用 " ; " 连了不止一条断言`] : []),
        ...(known.has(name) ? [] : [`basePredicates 第 ${i + 1} 条的谓词名 ${JSON.stringify(name)} 没有在谓词登记表里登记`]),
      ];
    });
  }),
};
