// 卡运行库：卡的引用、参数、装载次序、加前缀、叠加层展开、锁文件里的卡条目对不对得上。
// 纯函数，不碰渲染库、不读文件；页面和 node 两边都引用（页面直接引这个文件，不经 index.mjs）。
// 条文出处：卡的运行时接口契约（CR）3.3、5.2、5.4、5.5；卡文件格式契约（CF）3.3；片子描述契约（D）5.3、5.11。

const REF = /^([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)@([1-9][0-9]*)$/;
// 时刻算式的文法照片子描述契约 5.3：cut(N) 或 event(x)，后面可以加减一个整帧偏移
const MOMENT = /^(?:cut\((0|[1-9][0-9]*)\)|event\(([a-z][a-z0-9-]*)\))(?: ([+-]) ([1-9][0-9]*))?$/;
const ENTITY_NAME = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const META_KEYS = ['texts', 'anchors', 'readings'];
// 这两个词在装载核对记录的次序里另有所指，不得当实例名
const RESERVED = ['tracks', 'host'];
const TEXTUAL = ['string', 'text', 'color', 'asset'];

/** 宿主把叠加层展开成卡实例时用的那张卡 */
export const OVERLAY_CARD = 'two-d.overlay@1';

const coded = (code, message) => Object.assign(new Error(message), { code });
const bad = (message) => coded('usage.bad-argument', message);
const majorOf = (version) => Number(String(version).split('.')[0]);

/** 卡的引用 <卡名>@<主版本> 拆成 { name, major } */
export function parseCardRef(use) {
  const m = typeof use === 'string' ? REF.exec(use) : null;
  if (!m) throw bad(`卡的引用必须写成 <卡名>@<主版本>，给的是 ${JSON.stringify(use)}`);
  return { name: m[1], major: Number(m[2]) };
}

/** 这张卡在某个帧源里用哪一份实现：先取落在这个帧源的，没有再取落在数据层的；都没有返回 undefined */
export const implFor = (card, sourceId) => card.impl.find((i) => i.livesIn === `source:${sourceId}`) ?? card.impl.find((i) => i.livesIn === 'data');

/**
 * 一个卡实例装不了的原因，装得了返回 null。library 是提供给帧源的卡 { 卡名: { card, sha256 } }，lock 是锁文件。
 * 装得了要四样都对上：提供了这张卡、主版本是引用里写的、锁文件锁的版本和内容哈希就是提供的这一份、它有落在这个帧源或数据层的实现。
 */
export function unfitReason(library, lock, use, sourceId) {
  const m = typeof use === 'string' ? REF.exec(use) : null;
  if (!m) return `卡的引用 ${JSON.stringify(use)} 不是 <卡名>@<主版本>`;
  const name = m[1], have = library[name], locked = lock?.cards?.[name];
  if (!have) return `没有提供卡 ${name}`;
  if (majorOf(have.card.version) !== Number(m[2])) return `提供的 ${name} 是 ${have.card.version}，引用的主版本是 ${m[2]}`;
  if (!locked) return `锁文件里没有卡 ${name}`;
  if (locked.version !== have.card.version || locked.sha256 !== have.sha256) return `提供的 ${name} 和锁文件锁的版本或内容哈希对不上`;
  const impl = implFor(have.card, sourceId);
  if (!impl) return `卡 ${name} 没有落在 source:${sourceId} 或 data 的实现`;
  return locked.impl?.includes(impl.livesIn) ? null : `锁文件里 ${name} 的落点没有 ${impl.livesIn}`;
}

/**
 * 时刻换成镜头局部帧号（T9）：整数是全片帧号；算式查镜头输入的事件表（已经展开成全片帧号）再加减偏移。都减去镜头的起始帧，不截断。
 * events 是事件表的 events 数组，shotIn 是镜头的起始帧。
 */
export function localFrame(value, events, shotIn) {
  if (Number.isInteger(value)) return value - shotIn;
  const m = typeof value === 'string' ? MOMENT.exec(value) : null;
  if (!m) throw bad(`时刻必须是全片帧号或时刻算式，给的是 ${JSON.stringify(value)}`);
  const hit = events.find((e) => (m[1] === undefined ? e.kind === 'named' && e.id === m[2] : e.kind === 'cut' && e.frame === Number(m[1])));
  if (!hit) throw bad(`时刻算式 ${value} 引用的事件或切点不在镜头输入的事件表里`);
  return hit.frame + (m[3] === '-' ? -1 : 1) * Number(m[4] ?? 0) - shotIn;
}

/**
 * 一个卡实例的参数：片子描述里写了的用写的，没写的用卡文件的默认值；类型是 time 的换成镜头局部帧号。
 * 写了卡文件里没有的参数、类型不对、数出了 range 都报错，不改成别的值照常装。
 * shortcut: time 类型的默认值当镜头局部帧号用（卡文件格式契约第 6 节这一项没定）；定成全片帧号时在这里减起始帧
 */
export function resolveParams(card, given = {}, { events = [], shotIn = 0 } = {}) {
  const unknown = Object.keys(given).filter((k) => !Object.hasOwn(card.params, k));
  if (unknown.length) throw bad(`卡 ${card.id} 没有参数 ${unknown.join('、')}`);
  const out = {};
  for (const [name, p] of Object.entries(card.params)) {
    const written = Object.hasOwn(given, name), v = written ? given[name] : p.default;
    if (p.type === 'time') { out[name] = written ? localFrame(v, events, shotIn) : v; continue; }
    const typed = p.type === 'number' ? Number.isFinite(v) : p.type === 'integer' ? Number.isInteger(v) : p.type === 'boolean' ? typeof v === 'boolean' : !TEXTUAL.includes(p.type) || typeof v === 'string';
    if (!typed) throw bad(`卡 ${card.id} 的参数 ${name} 类型是 ${p.type}，给的是 ${JSON.stringify(v)}`);
    if (p.range && !(p.range[0] <= v && v <= p.range[1])) throw bad(`卡 ${card.id} 的参数 ${name} 必须在 [${p.range[0]}, ${p.range[1]}]（${p.unit}），给的是 ${v}`);
    out[name] = structuredClone(v);
  }
  return out;
}

/** 镜头输入的叠加层各展开成一个卡实例：实例名是叠加层的 id，参数是条目去掉 id、shot 之后剩下的字段（D 契约 5.11） */
export const expandOverlays = (overlays = []) => overlays.map(({ id, shot, ...params }) => ({ as: id, use: OVERLAY_CARD, params }));

/** 实例名的检查：不得是 tracks、host，一个镜头里（卡和叠加层合起来）不得重复 */
export function checkInstanceNames(names) {
  const reserved = names.filter((n) => RESERVED.includes(n)), dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (reserved.length) throw bad(`实例名不得是 ${reserved.join('、')}`);
  if (dup.length) throw bad(`实例名 ${[...new Set(dup)].join('、')} 重复`);
}

/** 从各张卡的 ports.order 解出实例之间的先后要求 [先, 后]。instances 是 [{ as, card }]；ports.order 里的卡在这个镜头里没有实例时不出要求 */
export function orderPairs(instances) {
  const named = (cardName) => instances.filter((i) => i.card.id === cardName).map((i) => i.as);
  const pairs = [];
  for (const i of instances) {
    for (const name of i.card.ports.order.after) for (const first of named(name)) pairs.push([first, i.as]);
    for (const name of i.card.ports.order.before) for (const later of named(name)) pairs.push([i.as, later]);
  }
  return pairs.filter(([a, b], n) => pairs.findIndex(([x, y]) => x === a && y === b) === n);
}

/**
 * create 的排法（CR 契约 5.2）：每一步在「必须排在它前面的都已经排好」的实例里取书写顺序最靠前的。
 * 先后要求成环、或者提到了 names 里没有的名字，报 contract.order-cycle。
 */
export function createOrder(names, pairs) {
  const stray = pairs.flat().filter((n) => !names.includes(n));
  if (stray.length) throw coded('contract.order-cycle', `卡的先后要求提到了这个镜头里没有的实例 ${[...new Set(stray)].join('、')}`);
  const done = [], left = [...names];
  while (left.length) {
    const next = left.find((n) => pairs.every(([first, later]) => later !== n || done.includes(first)));
    if (next === undefined) throw coded('contract.order-cycle', `卡的先后要求成环，排不出次序：${left.join('、')}`);
    done.push(next);
    left.splice(left.indexOf(next), 1);
  }
  return done;
}

/**
 * Handle.entities 并进镜头时的名字（CR 契约 5.4）：相对名前面加 <as>.，带 root: true 的那个就叫 <as>。
 * 返回 [{ rel, name, object, root }]，次序和 Handle.entities 的键相同。带 root 的多于一个、拼出来的名字不合实体名的写法都报错。
 */
export function mergeEntities(as, entities = {}) {
  const rows = Object.entries(entities).map(([rel, v]) => {
    const root = v?.root === true;
    return { rel, root, object: root ? v.object : v, name: root ? as : `${as}.${rel}` };
  });
  if (rows.filter((r) => r.root).length > 1) throw new Error(`卡实例 ${as} 的 Handle.entities 里带 root 的实体多于一个`);
  const odd = rows.filter((r) => !ENTITY_NAME.test(r.name));
  if (odd.length) throw new Error(`卡实例 ${as} 带进来的实体名 ${odd.map((r) => r.name).join('、')} 不合实体名的写法`);
  return rows;
}

/**
 * Handle.meta(f) 的返回值并进镜头（CR 契约 5.4）：文字框的 id、读数的名字前面加 <as>.；没写 id 的文字框原样。
 * 返回 { texts, readings, anchors?, ids, merged }：ids 是卡交出的 id 和读数名，merged 是它们并进来之后的名字，一一对应。
 */
export function mergeMeta(as, extra = {}) {
  const stray = Object.keys(extra).filter((k) => !META_KEYS.includes(k));
  if (stray.length) throw new Error(`卡实例 ${as} 的 meta(f) 交了不许交的键：${stray.join('、')}`);
  const texts = (extra.texts ?? []).map((t) => (t.id === undefined ? { ...t } : { ...t, id: `${as}.${t.id}` }));
  const names = Object.keys(extra.readings ?? {});
  const ids = [...(extra.texts ?? []).filter((t) => t.id !== undefined).map((t) => t.id), ...names];
  return {
    texts,
    readings: Object.fromEntries(names.map((k) => [`${as}.${k}`, extra.readings[k]])),
    ...(extra.anchors ? { anchors: extra.anchors } : {}),
    ids,
    merged: ids.map((id) => `${as}.${id}`),
  };
}
