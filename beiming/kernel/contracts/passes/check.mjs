// 输出通道契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是通道声明（passes/0.1）或通道核对记录（passes-check/0.1）。PS1 的名字要求对两种都判；
// 「七个固定通道齐全」、PS2 到 PS6 只看核对记录。记录里没出现的段不判，别的对象一律返回空数组。

const RGB = ['R', 'G', 'B'];
const XYZ = ['X', 'Y', 'Z'];
const row = (names, types, colorSpace, sample) => ({
  components: names.map((name, i) => ({ name, type: types[i] ?? types[0] })),
  colorSpace, sample, antialiased: sample === 'accumulate',
});
// 3.1 通道登记表
const REGISTRY = {
  color: row([...RGB, 'A'], ['f32'], 'scene-linear-rec709', 'accumulate'),
  depth: row(['Z'], ['f32'], 'none', 'sub0'),
  objectId: row(['id', 'coverage'], ['u32', 'f32'], 'none', 'sub0'),
  normal: row(XYZ, ['f32'], 'none', 'sub0'),
  motion: row(['X', 'Y'], ['f32'], 'none', 'sub0'),
  denoiseAlbedo: row(RGB, ['f32'], 'scene-linear-rec709', 'accumulate'),
  denoiseNormal: row(XYZ, ['f32'], 'none', 'accumulate'),
};
const LIGHTGROUP = row(RGB, ['f32'], 'scene-linear-rec709', 'accumulate');
const FIXED = Object.keys(REGISTRY);
// 3.1 的八个光路通道：可选，不算固定通道，属性和分灯组的那一行相同
const LIGHT_PATHS = ['diffuseDirect', 'diffuseIndirect', 'glossyDirect', 'glossyIndirect', 'transmissionDirect', 'transmissionIndirect', 'emission', 'environment'];
const isLightgroup = (name) => /^lightgroup:[a-z0-9][a-z0-9-]*$/.test(name);
const registryRow = (name) => (Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : isLightgroup(name) || LIGHT_PATHS.includes(name) ? LIGHTGROUP : null);

const sameComponents = (a, b) => a.length === b.length && a.every((c, i) => c.name === b[i].name && c.type === b[i].type);
/** 两项通道的四个属性逐个比，返回不相等的字段名 */
const diffFields = (a, b) => [
  ...(sameComponents(a.components, b.components) ? [] : ['components']),
  ...['colorSpace', 'sample', 'antialiased'].filter((k) => a[k] !== b[k]),
];
const sameNumbers = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const isTable = (obj) => obj?.format === 'passes/0.1';
const isRecord = (obj) => obj?.format === 'passes-check/0.1';

function namesOk(channels, who) {
  const names = channels.map((c) => c.name);
  return [
    ...names.filter((n) => !registryRow(n)).map((n) => `${who}的通道名 ${n} 不在登记表里`),
    ...[...new Set(names.filter((n, i) => names.indexOf(n) !== i))].map((n) => `${who}的通道名 ${n} 重复了`),
  ];
}

export const checks = {
  PS1: (obj) => {
    if (isTable(obj)) return namesOk(obj.channels, '通道声明');
    if (!isRecord(obj)) return [];
    return obj.sides.flatMap((s) => {
      const names = s.table.channels.map((c) => c.name);
      return [
        ...namesOk(s.table.channels, `${s.producer} `),
        ...FIXED.map((f) => [f, names.filter((n) => n === f).length])
          .filter(([, k]) => k !== 1)
          .map(([f, k]) => `${s.producer} 的声明里固定通道 ${f} 出现了 ${k} 次`),
      ];
    });
  },

  PS2: (obj) => (isRecord(obj) ? obj.sides.flatMap((s) => s.table.channels.flatMap((c) => {
    const r = registryRow(c.name);
    return r ? diffFields(c, r).map((k) => `${s.producer} 的通道 ${c.name} 的 ${k} 和登记表不同`) : [];
  })) : []),

  PS3: (obj) => {
    if (!isRecord(obj)) return [];
    const core = obj.sides.find((s) => s.producer === 'core');
    const oracle = obj.sides.find((s) => s.producer === 'oracle');
    if (!core || !oracle) return [];
    // 只比通道名的集合；同名通道的字段相等归 PS2
    const a = new Set(core.table.channels.map((c) => c.name));
    const b = new Set(oracle.table.channels.map((c) => c.name));
    return [
      ...[...a].filter((n) => !b.has(n)).map((n) => `通道 ${n} 只有 core 有，oracle 没有`),
      ...[...b].filter((n) => !a.has(n)).map((n) => `通道 ${n} 只有 oracle 有，core 没有`),
    ];
  },

  PS4: (obj) => (isRecord(obj) ? (obj.pixels ?? []).flatMap((p) => {
    const at = `${p.producer} 的像素 (${p.x}, ${p.y})`;
    return [
      ...(p.out.depth === p.aux.depth ? [] : [`${at} 交出的 depth 是 ${p.out.depth}，辅助样本是 ${p.aux.depth}`]),
      ...(p.out.id === p.aux.id ? [] : [`${at} 交出的 id 是 ${p.out.id}，辅助样本是 ${p.aux.id}`]),
      ...['normal', 'motion']
        .filter((k) => p.out[k] !== undefined && !(p.aux[k] && sameNumbers(p.out[k], p.aux[k])))
        .map((k) => `${at} 交出的 ${k} 是 [${p.out[k]}]，辅助样本是 [${p.aux[k] ?? '没有'}]`),
    ];
  }) : []),

  PS5: (obj) => (isRecord(obj) ? (obj.pixels ?? []).flatMap((p) => {
    const k = p.samples.filter((s) => s.id === p.aux.id).length;
    const n = p.samples.length;
    return Math.abs(p.out.coverage - k / n) <= 0.000001 ? [] : [`${p.producer} 的像素 (${p.x}, ${p.y}) 交出的 coverage 是 ${p.out.coverage}，样本数出来是 ${k}/${n}`];
  }) : []),

  PS6: (obj) => {
    if (!isRecord(obj)) return [];
    const producers = obj.sides.map((s) => s.producer);
    return [
      ...[...new Set(producers.filter((p, i) => producers.indexOf(p) !== i))].map((p) => `sides 里 ${p} 出现了不止一次`),
      ...(obj.pixels ?? []).filter((p) => !producers.includes(p.producer))
        .map((p) => `像素 (${p.x}, ${p.y}) 的 producer 是 ${p.producer}，sides 里没有它`),
    ];
  },
};
