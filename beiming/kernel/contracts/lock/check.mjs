// 锁文件契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// LK2、LK5 只看锁文件本身，锁文件（lock/1.0）和锁核对记录（lock-check/0.1）里的锁都判；
// 其余要片子描述或元数据观测的，只在锁核对记录里出现那一段时判。不归这条管的对象返回空数组。

// D 契约 3.6：全片级的键、绑的卡、是不是总算出现
const GLOBAL_KEYS = [
  { key: 'style.view', card: 'comp.display', always: true },
  { key: 'style.finish', card: 'comp.finish', always: false },
  { key: 'delivery', card: 'deliver.encode', always: true },
  { key: 'audio', card: 'audio.master', always: false },
];
const BUILTIN = ['time.timeline', 'time.events', 'time.seeded'];

const major = (v) => Number(String(v).split('.')[0]);
const refMajor = (ref) => Number(String(ref).slice(String(ref).lastIndexOf('@') + 1));
const at = (obj, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const has = (obj, k) => obj != null && Object.hasOwn(obj, k);
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

const lockOf = (obj) => (obj?.format === 'lock/1.0' ? obj : obj?.format === 'lock-check/0.1' ? obj.lock : undefined);
const onLock = (fn) => (obj) => { const lock = lockOf(obj); return lock ? fn(lock) : []; };
const onFilm = (fn) => (obj) => (obj?.format === 'lock-check/0.1' && obj.film ? fn(obj.lock, obj.film) : []);
const cardsOf = (lock) => Object.entries(lock.cards ?? {});

export const checks = {
  LK1: onFilm((lock, film) => [
    ...GLOBAL_KEYS.filter((g) => g.always || at(film, g.key) !== undefined).flatMap((g) => {
      const c = lock.cards?.[g.card];
      if (!c) return [`片子描述里有 ${g.key}，cards 里没有它绑的 ${g.card}`];
      const out = c.from === g.key ? [] : [`cards.${g.card} 的 from 是 ${c.from}，应该是 ${g.key}`];
      const ref = at(film, g.key)?.card;
      if (ref !== undefined && major(c.version) !== refMajor(ref)) out.push(`cards.${g.card} 锁的是 ${c.version}，${g.key}.card 指定的是 ${ref}`);
      return out;
    }),
    ...cardsOf(lock).flatMap(([name, c]) => {
      const g = GLOBAL_KEYS.find((x) => x.key === c.from);
      return g && name !== g.card ? [`cards.${name} 的 from 是 ${c.from}，这个键绑的卡是 ${g.card}`] : [];
    }),
  ]),

  LK2: onLock((lock) => cardsOf(lock).flatMap(([name, c]) => {
    const srcs = (c.impl ?? []).filter((i) => i.startsWith('source:')).map((i) => i.slice('source:'.length));
    if (!srcs.length) return [];
    const ok = srcs.some((s) => has(lock.sources, s)
      && c.verified?.host === lock.sources[s].host && c.verified?.source === lock.sources[s].version);
    return ok ? [] : [`cards.${name} 验在 ${c.verified?.host} ${c.verified?.source} 上，和它的落点帧源 ${srcs.join('、')} 锁的宿主和版本都对不上`];
  })),

  LK3: onFilm((lock, film) => {
    const shots = film.shots ?? [];
    const want = new Set(['film', ...shots.map((s) => s.id)]);
    const got = new Set(Object.keys(lock.seeds ?? {}));
    const out = sameSet(want, got) ? [] : [`seeds 的键是 ${[...got].join('、')}，应该是 ${[...want].join('、')}`];
    for (const s of shots) {
      if (s.seed !== undefined && s.seed !== lock.seeds?.[s.id]) out.push(`镜头 ${s.id} 的 seed 是 ${s.seed}，seeds 里是 ${lock.seeds?.[s.id]}`);
    }
    return out;
  }),

  LK4: onFilm((lock, film) => (film.shots ?? []).flatMap((s) => [s, ...(s.renderer ? [s.renderer] : [])].flatMap((p) => {
    const where = p === s ? `镜头 ${s.id}` : `镜头 ${s.id} 的 renderer`;
    if (!has(lock.sources, p.source)) return [`${where} 的帧源 ${p.source} 不在 sources 里`];
    return p.host === lock.sources[p.source].host ? [] : [`${where} 的宿主是 ${p.host}，sources.${p.source} 锁的是 ${lock.sources[p.source].host}`];
  }))),

  LK5: onLock((lock) => BUILTIN.filter((n) => !has(lock.cards, n)).map((n) => `cards 里没有内建卡 ${n}`)),

  LK6: (obj) => (obj?.format === 'lock-check/0.1' ? (obj.renders ?? []).flatMap((r, i) => {
    const src = obj.lock.sources ?? {};
    if (!has(src, r.renderer)) return [`renders[${i}] 的出帧者 ${r.renderer} 不在 sources 里`];
    return r.host === src[r.renderer].host && r.version === src[r.renderer].version ? []
      : [`renders[${i}] 是 ${r.renderer} ${r.host} ${r.version} 出的，锁的是 ${src[r.renderer].host} ${src[r.renderer].version}`];
  }) : []),

  LK7: onFilm((lock, film) => (lock.film === film.id ? [] : [`锁文件的 film 是 ${lock.film}，片子描述的 id 是 ${film.id}`])),

  LK8: onFilm((lock, film) => (film.predicates?.base ?? []).flatMap((ref) => {
    const [name, m] = ref.replace(/^template:/, '').split('@');
    if (!has(lock.templates, name)) return [`predicates.base 引用了 ${ref}，templates 里没有 ${name}`];
    return major(lock.templates[name]) === Number(m) ? [] : [`predicates.base 引用了 ${ref}，templates.${name} 锁的是 ${lock.templates[name]}`];
  })),

  LK9: onFilm((lock, film) => {
    const scene = film.style?.view?.scene;
    return scene === undefined || has(lock.view, scene) ? [] : [`style.view.scene 是 ${scene}，view 里没有这个键`];
  }),

  LK10: onFilm((lock, film) => {
    const out = [];
    if ((film.overlays ?? []).length >= 1) {
      const c = lock.cards?.['two-d.overlay'];
      if (!c) out.push('片子描述有叠加层，cards 里没有 two-d.overlay');
      else {
        if (c.from !== 'overlays') out.push(`cards.two-d.overlay 的 from 是 ${c.from}，应该是 overlays`);
        if (major(c.version) !== 1) out.push(`cards.two-d.overlay 锁的是 ${c.version}，第一段必须是 1`);
      }
    }
    for (const [name, c] of cardsOf(lock)) if (c.from === 'overlays' && name !== 'two-d.overlay') out.push(`cards.${name} 的 from 是 overlays，卡名必须是 two-d.overlay`);
    return out;
  }),

  LK11: onFilm((lock, film) => {
    const shots = film.shots ?? [];
    const want = new Set(shots.map((s) => s.id));
    const got = new Set(Object.keys(lock.shots ?? {}));
    const out = sameSet(want, got) ? [] : [`锁文件 shots 的键是 ${[...got].join('、')}，应该是 ${[...want].join('、')}`];
    for (const s of shots) {
      const n = s.shutter?.samples;
      if (n !== undefined && n !== lock.shots?.[s.id]?.shutterSamples) out.push(`镜头 ${s.id} 写的子帧采样数是 ${n}，锁文件记的是 ${lock.shots?.[s.id]?.shutterSamples}`);
    }
    return out;
  }),
};
