// 错误码表契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是错误码表（errors/0.1）；别的对象一律返回空数组。

// 5.1 的前缀对退出码表，ER2 拿它比
const PREFIX_TABLE = { 'usage.': 2, 'env.': 3, 'contract.': 4, 'busy.': 5, 'timeout.': 124, 'failure.': 1, 'auth.': 4 };

const on = (fn) => (obj) => (obj?.format === 'errors/0.1' ? fn(obj) : []);

const checks = {
  ER1: on((t) => (t.codes ?? [])
    .filter((c) => !(t.prefixes ?? []).some((p) => c.code.startsWith(p.prefix)))
    .map((c) => `错误码 ${c.code} 不以 prefixes 里任何一个前缀开头`)),

  ER2: on((t) => {
    const got = t.prefixes ?? [];
    const want = Object.keys(PREFIX_TABLE);
    const out = [];
    if (got.length !== want.length) out.push(`prefixes 有 ${got.length} 项，5.1 表是 ${want.length} 项`);
    for (const p of want) if (!got.some((g) => g.prefix === p)) out.push(`prefixes 里缺 ${p}`);
    for (const g of got) {
      if (!Object.hasOwn(PREFIX_TABLE, g.prefix)) out.push(`prefixes 里多了 ${g.prefix}`);
      else if (g.exitCode !== PREFIX_TABLE[g.prefix]) out.push(`前缀 ${g.prefix} 的退出码是 ${g.exitCode}，5.1 表是 ${PREFIX_TABLE[g.prefix]}`);
    }
    return out;
  }),

  ER3: on((t) => {
    const codes = (t.codes ?? []).map((c) => c.code);
    return [...new Set(codes.filter((c, i) => codes.indexOf(c) !== i))].map((c) => `错误码 ${c} 登记了不止一次`);
  }),
};

export { checks };
