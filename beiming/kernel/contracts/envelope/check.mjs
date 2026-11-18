// 信封契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是一份信封（envelope/0.1），返回这条不变量下发现的问题；空数组表示没违反。
// 别的对象不归这些条文管，一律返回空数组。

const onEnvelope = (fn) => (obj, ctx) => (obj?.format === 'envelope/0.1' ? fn(obj, ctx) : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const raw = {
  EN1: (env) => (env.ok === (env.exitCode === 0) ? [] : [`exitCode 是 ${env.exitCode}，ok 却是 ${env.ok}`]),

  EN2: (env) => {
    if (env.exitCode === 0) return env.error === null ? [] : ['exitCode 是 0，error 却不是 null'];
    return isObject(env.error) ? [] : [`exitCode 是 ${env.exitCode}，error 却是 ${JSON.stringify(env.error)}`];
  },

  // 错误码表由校验器从 errors/errors.json 读出来，放在第二个参数的 registries.errors 里
  EN3: (env, { registries }) => {
    if (!isObject(env.error)) return [];
    const hit = registries.errors.prefixes.find((p) => env.error.code.startsWith(p.prefix));
    if (!hit) return []; // 前缀不在表里：本条不判，这种码一定没登记，归 EN4
    return hit.exitCode === env.exitCode ? [] : [`error.code ${env.error.code} 的前缀对到退出码 ${hit.exitCode}，信封的 exitCode 是 ${env.exitCode}`];
  },

  EN4: (env, { registries }) => {
    const known = new Set(registries.errors.codes.map((c) => c.code));
    return [...(isObject(env.error) ? [['error.code', env.error.code]] : []), ...env.diagnostics.map((d, i) => [`diagnostics 第 ${i + 1} 条的 code`, d.code])]
      .filter(([, code]) => !known.has(code))
      .map(([where, code]) => `${where} ${code} 没有在错误码表里登记`);
  },
};

export const checks = Object.fromEntries(Object.entries(raw).map(([id, fn]) => [id, onEnvelope(fn)]));
