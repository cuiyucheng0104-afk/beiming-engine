// 片子描述契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 收片子描述（film/3.0）、片子核对记录（film-check/0.1，判它的 film 和各观测段）和单独的 Explain。
// 记录里没出现的段不判；不归某条管的对象返回空数组。

const GLOBAL_CARDS = { 'style.view': 'comp.display', 'style.finish': 'comp.finish', delivery: 'deliver.encode', audio: 'audio.master' };
const LAYER_ORDER = ['card-default', 'template', 'film', 'job'];
const ID_ARRAYS = ['shots', 'transitions', 'events', 'overlays'];
// 5.4：这些数组不能寻址到项，路径止于数组本身
const TERMINAL_ARRAYS = [
  /^shots\/[^/]+\/roles\/mustSee$/, /^shots\/[^/]+\/deliberate$/, /^overlays\/[^/]+\/pos$/, /^predicates\/(base|extra)$/,
  /^style\/colorScript\/[^/]+\/key$/, /^delivery\/layers$/, /^output\/size$/,
];
const TOP_FIELDS = ['format', 'id', 'title', 'exam', 'output', 'timeline', 'assets', 'shots', 'transitions', 'events', 'overlays', 'style', 'audio', 'predicates', 'delivery'];
// 抄自帧源接口契约（F）3.4 的登记表，名单以那里为准。格子里列出了值的照列出的值判（带不带待定的注都一样）；
// null 是一个值都没列的格子，不判
const REGISTRY = {
  blender: { hosts: ['cycles'], modes: ['cards-data', 'build-script', 'native-code'] },
  three: { hosts: ['page'], modes: ['cards-data', 'build-script', 'native-code'] },
  core: { hosts: ['offscreen', 'headless-page'], modes: ['cards-data', 'build-script'] },
};
const EXPR = /^(?:cut\((0|[1-9]\d*)\)|event\(([a-z][a-z0-9-]*)\))(?: ([+-]) ([1-9]\d*))?$/;

const filmOf = (obj) => (obj?.format === 'film/3.0' ? obj : obj?.format === 'film-check/0.1' ? obj.film : null);
const onFilm = (fn) => (obj) => { const film = filmOf(obj); return film ? fn(film) : []; };
const onRecord = (fn) => (obj) => (obj?.format === 'film-check/0.1' ? fn(obj) : []);
const isExt = (source) => typeof source === 'string' && source.startsWith('ext.');
const cardName = (ref) => ref.slice(0, ref.lastIndexOf('@'));
const cutsOf = (film) => film.shots.slice(1).map((s) => s.in);
const shotOf = (film, id) => film.shots.find((s) => s.id === id);
const dupes = (list) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];

/** 片子里所有可以写时刻算式的地方：[说明, 值] */
function timeFields(film) {
  return [
    ...(film.events ?? []).map((e) => [`事件 ${e.id} 的 frame`, e.frame]),
    ...(film.overlays ?? []).flatMap((o) => [[`叠加层 ${o.id} 的 in`, o.in], [`叠加层 ${o.id} 的 out`, o.out]]),
    ...(film.audio?.narration ?? []).map((n) => [`旁白 ${n.id} 的 at`, n.at]),
  ];
}

/** 照 5.3 展开成整数；引用了没定义的东西或成环时返回 null（归 D2） */
function expand(film, value, seen = new Set()) {
  if (typeof value === 'number') return value;
  const m = EXPR.exec(value);
  if (!m) return null;
  let base;
  if (m[1] !== undefined) {
    base = Number(m[1]);
    if (!cutsOf(film).includes(base)) return null;
  } else {
    const ev = (film.events ?? []).find((e) => e.id === m[2]);
    if (!ev || seen.has(m[2])) return null;
    base = expand(film, ev.frame, new Set(seen).add(m[2]));
    if (base === null) return null;
  }
  return m[3] === undefined ? base : m[3] === '+' ? base + Number(m[4]) : base - Number(m[4]);
}

/** 从事件 id 出发沿 event(x) 走，能不能回到自己 */
function returnsToSelf(film, id) {
  const stack = [id];
  const visited = new Set();
  while (stack.length) {
    const cur = stack.pop();
    const ev = (film.events ?? []).find((e) => e.id === cur);
    const m = ev && typeof ev.frame === 'string' ? EXPR.exec(ev.frame) : null;
    if (!m || m[2] === undefined) continue;
    if (m[2] === id) return true;
    if (!visited.has(m[2])) { visited.add(m[2]); stack.push(m[2]); }
  }
  return false;
}

/** 5.4 的文法加按标识寻址；返回问题，空数组表示合法 */
function pathProblems(film, path) {
  const seg = path.split('/');
  if (path.includes('#')) return ['含 #'];
  if (seg.some((s) => s === '')) return ['以 / 开头或结尾，或有空段'];
  if (!TOP_FIELDS.includes(seg[0])) return [`第一段 ${seg[0]} 不是片子描述的字段`];
  const out = [];
  const arrays = [...ID_ARRAYS.map((a) => [a, 1, film[a]]), ['audio', 2, film.audio?.narration]];
  for (const [name, at, items] of arrays) {
    if (seg[0] !== name || (name === 'audio' && seg[1] !== 'narration') || seg.length <= at) continue;
    if (!(items ?? []).some((it) => it.id === seg[at])) out.push(`${seg.slice(0, at).join('/')} 后面的 ${seg[at]} 不是某一项的 id`);
  }
  if (seg[0] === 'shots' && seg[2] === 'cards' && seg.length > 3) {
    const shot = shotOf(film, seg[1]);
    if (shot && !(shot.cards ?? []).some((c) => c.as === seg[3])) out.push(`镜头 ${seg[1]} 的 cards 里没有实例名 ${seg[3]}`);
  }
  for (const re of TERMINAL_ARRAYS) {
    for (let n = 1; n < seg.length; n++) if (re.test(seg.slice(0, n).join('/'))) out.push(`${seg.slice(0, n).join('/')} 不能寻址到项`);
  }
  return out;
}

/** 5.8 的「逐值相等」 */
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameValue(a[k], b[k]));
  }
  return a === b;
}

function explainProblems(ex) {
  const out = [];
  const rank = ex.layers.map((l) => LAYER_ORDER.indexOf(l.layer));
  rank.forEach((r, i) => { if (i > 0 && r < rank[i - 1]) out.push(`explain ${ex.path} 的第 ${i} 层 ${ex.layers[i].layer} 排在更强的 ${ex.layers[i - 1].layer} 后面`); });
  const valued = ex.layers.filter((l) => 'value' in l);
  if (!valued.length) out.push(`explain ${ex.path} 的 layers 没有一项带 value`);
  else if (!sameValue(ex.value, valued.at(-1).value)) out.push(`explain ${ex.path} 的 value 是 ${JSON.stringify(ex.value)}，最后一个带值的层给的是 ${JSON.stringify(valued.at(-1).value)}`);
  return out;
}

/** 写入里修订号对得上、路径命中的项必须以给定的码拒绝 */
const mustReject = (writes, match, code) => (writes ?? [])
  .filter((w) => w.rev === w.serverRev && match(w) && (w.outcome !== 'rejected' || w.code !== code))
  .map((w) => `${w.by} 对 ${w.path} 的写入结果是 ${w.outcome}${w.code ? `（${w.code}）` : ''}，应该以 ${code} 拒绝`);

/** 一套 source/host/mode/entry 的 D11、D12 判法 */
function capsProblems(who, set) {
  if (!Object.hasOwn(REGISTRY, set.source)) return []; // 登记表里没有的帧源不判
  const reg = REGISTRY[set.source];
  return [
    ...(reg.hosts && !reg.hosts.includes(set.host) ? [`${who} 的宿主 ${set.host} 不在帧源 ${set.source} 的 hosts 里`] : []),
    ...(reg.modes.includes(set.mode) ? [] : [`${who} 的作者模式 ${set.mode} 不在帧源 ${set.source} 的 modes 里`]),
  ];
}
function entryProblems(who, set) {
  if (isExt(set.source)) return [];
  const has = set.entry !== undefined;
  if (set.mode === 'cards-data' && has) return [`${who} 的 mode 是 cards-data，不得有 entry`];
  if (set.mode !== 'cards-data' && !has) return [`${who} 的 mode 是 ${set.mode}，缺 entry`];
  return [];
}

const filmChecks = {
  D1: (film) => {
    const s = film.shots;
    return [
      ...(s[0].in === 0 ? [] : [`第一个镜头 ${s[0].id} 的 in 是 ${s[0].in}，不是 0`]),
      ...s.filter((x) => !(x.in < x.out)).map((x) => `镜头 ${x.id} 的 in ${x.in} 不小于 out ${x.out}`),
      ...s.slice(1).filter((x, i) => x.in !== s[i].out).map((x) => `镜头 ${x.id} 的 in 是 ${x.in}，前一个镜头的 out 是 ${s[s.indexOf(x) - 1].out}`),
      ...(s.at(-1).out === film.output.frames ? [] : [`最后一个镜头 ${s.at(-1).id} 的 out 是 ${s.at(-1).out}，output.frames 是 ${film.output.frames}`]),
    ];
  },

  D2: (film) => {
    const ids = film.shots.map((s) => s.id);
    const eventIds = (film.events ?? []).map((e) => e.id);
    const cuts = cutsOf(film);
    const out = [
      ...(film.events ?? []).filter((e) => e.shot !== undefined && !ids.includes(e.shot)).map((e) => `事件 ${e.id} 的 shot ${e.shot} 不是已定义的镜头`),
      ...(film.overlays ?? []).filter((o) => !ids.includes(o.shot)).map((o) => `叠加层 ${o.id} 的 shot ${o.shot} 不是已定义的镜头`),
      ...Object.keys(film.style?.colorScript ?? {}).filter((k) => !ids.includes(k)).map((k) => `style.colorScript 的键 ${k} 不是已定义的镜头`),
    ];
    for (const [what, v] of timeFields(film)) {
      const m = typeof v === 'string' ? EXPR.exec(v) : null;
      if (!m) continue;
      if (m[1] !== undefined && !cuts.includes(Number(m[1]))) out.push(`${what} 的 ${v} 里 ${m[1]} 不是切点`);
      if (m[2] !== undefined && !eventIds.includes(m[2])) out.push(`${what} 的 ${v} 引用了没定义的事件 ${m[2]}`);
    }
    for (const e of film.events ?? []) if (returnsToSelf(film, e.id)) out.push(`事件 ${e.id} 的 frame 展开时回到了自己`);
    return out;
  },

  D8: (film) => {
    const banned = Object.values(GLOBAL_CARDS);
    const keyed = { 'style.view': film.style?.view, 'style.finish': film.style?.finish, delivery: film.delivery, audio: film.audio };
    return [
      ...film.shots.flatMap((s) => (s.cards ?? []).filter((c) => banned.includes(cardName(c.use))).map((c) => `镜头 ${s.id} 的卡实例 ${c.as} 用了全片级的卡 ${c.use}`)),
      ...Object.entries(keyed)
        .filter(([key, v]) => v?.card !== undefined && cardName(v.card) !== GLOBAL_CARDS[key])
        .map(([key, v]) => `${key}.card 是 ${v.card}，这个键绑的卡是 ${GLOBAL_CARDS[key]}`),
    ];
  },

  D10: (film) => [...ID_ARRAYS.map((a) => [a, film[a]]), ['audio.narration', film.audio?.narration]]
    .flatMap(([name, items]) => dupes((items ?? []).map((it) => it.id)).map((id) => `${name} 里有不止一项的 id 是 ${id}`)),

  D11: (film) => film.shots.flatMap((s) => [
    ...capsProblems(`镜头 ${s.id}`, s),
    ...(s.renderer ? capsProblems(`镜头 ${s.id} 的 renderer`, s.renderer) : []),
  ]),

  D12: (film) => film.shots.flatMap((s) => [
    ...entryProblems(`镜头 ${s.id}`, s),
    ...(s.renderer ? entryProblems(`镜头 ${s.id} 的 renderer`, s.renderer) : []),
  ]),

  D13: (film) => {
    const out = [];
    const frames = film.output.frames;
    for (const e of film.events ?? []) {
      const f = expand(film, e.frame);
      if (f === null) continue;
      if (!(f >= 0 && f < frames)) out.push(`事件 ${e.id} 展开在第 ${f} 帧，不在 [0, ${frames}) 内`);
      const shot = e.shot !== undefined ? shotOf(film, e.shot) : null;
      if (shot && !(shot.in <= f && f < shot.out)) out.push(`事件 ${e.id} 展开在第 ${f} 帧，不在镜头 ${shot.id} 的 [${shot.in}, ${shot.out}) 内`);
    }
    for (const n of film.audio?.narration ?? []) {
      const f = expand(film, n.at);
      if (f !== null && !(f >= 0 && f < frames)) out.push(`旁白 ${n.id} 展开在第 ${f} 帧，不在 [0, ${frames}) 内`);
    }
    for (const o of film.overlays ?? []) {
      const [a, b] = [expand(film, o.in), expand(film, o.out)];
      const shot = shotOf(film, o.shot);
      if (a === null || b === null || !shot) continue;
      if (!(shot.in <= a && a < b && b <= shot.out)) out.push(`叠加层 ${o.id} 展开成 [${a}, ${b})，不在镜头 ${shot.id} 的 [${shot.in}, ${shot.out}) 内或不是 in < out`);
    }
    return out;
  },

  D14: (film) => {
    const cuts = cutsOf(film);
    const at = (film.transitions ?? []).map((t) => t.at);
    return [
      ...(film.transitions ?? []).filter((t) => !cuts.includes(t.at)).map((t) => `转场 ${t.id} 写在第 ${t.at} 帧，那里不是切点`),
      ...dupes(at).map((f) => `切点 ${f} 上写了不止一个转场`),
    ];
  },

  D16: (film) => {
    const filmAssets = film.assets ?? {};
    return [
      ...(film.audio?.narration ?? []).filter((n) => !Object.hasOwn(filmAssets, n.asset)).map((n) => `旁白 ${n.id} 的 asset ${n.asset} 不是全片 assets 的别名`),
      ...film.shots
        .filter((s) => isExt(s.source) && s.params?.piece !== undefined && !Object.hasOwn(s.assets ?? {}, s.params.piece) && !Object.hasOwn(filmAssets, s.params.piece))
        .map((s) => `镜头 ${s.id} 的 params.piece ${s.params.piece} 在镜头和全片 assets 里都找不到`),
    ];
  },
  // 卡参数里类型是 asset 的值要有卡文件才判得了；判定函数只收传进来的对象，这一半不判

  D17: (film) => film.shots.filter((s) => isExt(s.source)).flatMap((s) => [
    ...(s.mode === 'native-code' ? [] : [`镜头 ${s.id} 的帧源是 ${s.source}，mode 却是 ${s.mode}`]),
    ...(s.entry === undefined ? [] : [`镜头 ${s.id} 的帧源是 ${s.source}，不得有 entry`]),
    ...(s.params?.piece === undefined ? [`镜头 ${s.id} 的帧源是 ${s.source}，缺 params.piece`] : []),
  ]),

  // 叠加层和叠加层之间的重复归 D10，这里只比卡实例和卡实例、叠加层和卡实例
  D18: (film) => [
    ...film.shots.flatMap((s) => {
      const as = (s.cards ?? []).map((c) => c.as);
      const overlayIds = [...new Set((film.overlays ?? []).filter((o) => o.shot === s.id).map((o) => o.id))];
      return [
        ...dupes(as).map((n) => `镜头 ${s.id} 的 cards 里实例名 ${n} 不止一个`),
        ...overlayIds.filter((id) => as.includes(id)).map((id) => `贴在镜头 ${s.id} 上的叠加层 ${id} 和这个镜头 cards 里的实例名相同`),
      ];
    }),
    ...(film.overlays ?? []).filter((o) => o.id.includes('-')).map((o) => `叠加层 ${o.id} 的 id 带连字符`),
  ],

  D19: (film) => film.shots.flatMap((s) => (s.deliberate ?? [])
    .filter((d) => !(s.in <= d.in && d.in < d.out && d.out <= s.out))
    .map((d) => `镜头 ${s.id} 的 deliberate [${d.in}, ${d.out}) 不在镜头的 [${s.in}, ${s.out}) 内或不是 in < out`)),
};

const recordChecks = {
  D3: (rec) => {
    if (!rec.lock) return [];
    const cards = rec.lock.cards ?? {};
    const assets = rec.lock.assets ?? {};
    return [
      ...rec.film.shots.flatMap((s) => (s.cards ?? []).flatMap((c) => {
        const name = cardName(c.use);
        const major = Number(c.use.slice(c.use.lastIndexOf('@') + 1));
        if (!Object.hasOwn(cards, name)) return [`镜头 ${s.id} 的 ${c.use} 在锁文件 cards 里没有`];
        return Number(cards[name].version.split('.')[0]) === major ? [] : [`镜头 ${s.id} 的 ${c.use} 和锁文件的版本 ${cards[name].version} 主版本不同`];
      })),
      ...[...rec.film.shots.flatMap((s) => Object.values(s.assets ?? {})), ...Object.values(rec.film.assets ?? {})]
        .filter((ref) => !Object.hasOwn(assets, ref)).map((ref) => `资产 ${ref} 在锁文件 assets 里没有`),
    ];
  },

  D4: (rec) => {
    const locks = rec.locks ?? [];
    return [
      ...locks.filter((l) => l.writer !== 'server').map((l) => `修订号 ${l.rev} 的锁是 ${l.writer} 写的`),
      ...[...new Set(locks.map((l) => l.rev))].filter((r) => new Set(locks.filter((l) => l.rev === r).map((l) => l.digest)).size > 1)
        .map((r) => `修订号 ${r} 的锁读到了不同的摘要`),
    ];
  },

  D5: (rec) => [
    ...(rec.paths ?? []).map((p) => [`${p.use} 的路径`, p.path]),
    ...(rec.writes ?? []).map((w) => ['写入的路径', w.path]),
    ...(rec.explains ?? []).map((e) => ['explain 的路径', e.path]),
  ].flatMap(([what, path]) => pathProblems(rec.film, path).map((p) => `${what} ${path}：${p}`)),

  D6: (rec) => (rec.writes ?? []).filter((w) => w.rev !== w.serverRev)
    .filter((w) => w.outcome !== 'rejected' || w.code !== 'busy.rev-conflict' || w.latestRev !== w.serverRev)
    .map((w) => `对 ${w.path} 的写入带修订号 ${w.rev}，服务器是 ${w.serverRev}，结果是 ${w.outcome}${w.code ? `（${w.code}）` : ''}，latestRev 是 ${w.latestRev}`),

  // predicates/base/ 开头的路径不合 5.4（寻址到了数组里的项），归 D5，这里不判
  D7: (rec) => mustReject(rec.writes, (w) => w.by === 'agent' && w.path === 'predicates/base', 'auth.base-readonly'),

  D9: (rec) => (rec.explains ?? []).flatMap(explainProblems),

  // 不看 by：服务器也不得改。writes 只记片子创建之后的写入
  D15: (rec) => mustReject(rec.writes, (w) => w.path === 'id' || w.path === 'exam', 'contract.immutable-key'),
};

const isExplain = (obj) => obj?.format === undefined && Array.isArray(obj?.layers) && obj?.affects !== undefined;

export const checks = {
  ...Object.fromEntries(Object.entries(filmChecks).map(([id, fn]) => [id, onFilm(fn)])),
  ...Object.fromEntries(Object.entries(recordChecks).map(([id, fn]) => [id, onRecord(fn)])),
  D9: (obj) => (isExplain(obj) ? explainProblems(obj) : onRecord(recordChecks.D9)(obj)),
};
