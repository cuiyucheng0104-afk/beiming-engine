// 目录归属表契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是一份目录归属表（ownership/0.1），返回这条不变量下发现的问题；空数组表示没违反。
// 别的对象一律返回空数组。

// 5.1 必有的归属条目
const REQUIRED = [
  ['.', 'integrator'], ['api', 'api'], ['jobs', 'jobs'], ['kernel', 'integrator'],
  ['kernel/contracts', 'integrator'], ['kernel/eval', 'kernel-eval'], ['sources', 'integrator'],
  ['sources/three', 'source-three'], ['sources/blender', 'source-blender'],
  ['sources/legacy-page', 'source-legacy-page'], ['sources/core', 'source-core'], ['host', 'host'],
  ['comp', 'comp'], ['observe', 'observe'], ['verify', 'verify'], ['cards', 'cards'],
  ['bench', 'bench'], ['harvest', 'harvest'], ['calib', 'calib'], ['crew', 'integrator'],
];

// 5.3 三条放置规则；covers 不出现按空集合算
const PLACEMENTS = [
  { what: 'card-file', where: 'cards', covers: [] },
  { what: 'builtin-impl', where: 'kernel/eval', covers: ['timeline', 'events', 'rng', 'interp'] },
  { what: 'data-card-impl', where: 'cards/<kind>/<name>', covers: [] },
];

const sameSet = (a, b) => new Set(a).size === new Set(b).size && [...new Set(a)].every((x) => b.includes(x));

/** 5.4：逐字符相同，或一条整段整段地是另一条的开头 */
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

const onTable = (fn) => (obj) => (obj?.format === 'ownership/0.1' ? fn(obj) : []);

const raw = {
  OW1: (t) => {
    const seen = new Set();
    const out = [];
    for (const e of t.entries ?? []) {
      if (seen.has(e.path)) out.push(`entries 里有两项的 path 都是 ${e.path}`);
      seen.add(e.path);
    }
    return out;
  },

  OW2: (t) => REQUIRED
    .filter(([path, owner]) => !(t.entries ?? []).some((e) => e.path === path && e.owner === owner))
    .map(([path, owner]) => `entries 里缺 path 是 ${path}、owner 是 ${owner} 的一项`),

  OW3: (t) => {
    const got = t.placements ?? [];
    if (got.length !== PLACEMENTS.length) return [`placements 有 ${got.length} 项，应该正好 ${PLACEMENTS.length} 项`];
    return PLACEMENTS.flatMap((want) => {
      const hits = got.filter((p) => p.what === want.what);
      if (hits.length !== 1) return [`placements 里 what 是 ${want.what} 的有 ${hits.length} 项，应该正好 1 项`];
      const p = hits[0];
      return [
        ...(p.where === want.where ? [] : [`placements 里 ${want.what} 的 where 是 ${p.where}，应该是 ${want.where}`]),
        ...(sameSet(p.covers ?? [], want.covers) ? [] : [`placements 里 ${want.what} 的 covers 是 ${JSON.stringify(p.covers ?? [])}，应该是 ${JSON.stringify(want.covers)}`]),
      ];
    });
  },

  OW4: (t) => {
    const pk = t.packages ?? [];
    const out = [];
    for (let i = 0; i < pk.length; i++) {
      for (let j = i + 1; j < pk.length; j++) {
        for (const a of pk[i].writes) {
          for (const b of pk[j].writes) {
            if (overlaps(a, b)) out.push(`工作包 ${pk[i].id} 的 ${a} 和工作包 ${pk[j].id} 的 ${b} 重叠`);
          }
        }
      }
    }
    return out;
  },
};

export const checks = Object.fromEntries(Object.entries(raw).map(([id, fn]) => [id, onTable(fn)]));
