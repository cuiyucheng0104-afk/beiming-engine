import { checks } from './contracts/film/check.mjs';
import { getFilmRev } from './patch-apply.mjs';

const get = (o, k) => o != null && Object.hasOwn(o, k) ? o[k] : undefined;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const layersBySource = [['cardDefault', 'card-default'], ['templateOrToken', 'template'], ['film', 'film'], ['jobOverride', 'job']];
const EXPR = /^(?:cut\((0|[1-9]\d*)\)|event\(([a-z][a-z0-9-]*)\))(?: ([+-]) ([1-9]\d*))?$/;
const list = (o, k) => { const v = get(o, k); return Array.isArray(v) ? v : []; };
const byId = (items, id) => items.find(item => get(item, 'id') === id);
const byAs = (items, as) => items.find(item => get(item, 'as') === as);

// 时刻算式照 D 契约 5.3 展开成全片帧号；展开不了的返回 null
function expand(film, value, seen = new Set()) {
  if (typeof value === 'number') return value;
  const m = typeof value === 'string' ? EXPR.exec(value) : null;
  if (!m) return null;
  let base = Number(m[1]);
  if (m[1] === undefined) {
    const event = byId(list(film, 'events'), m[2]);
    if (!event || seen.has(m[2])) return null;
    base = expand(film, get(event, 'frame'), new Set(seen).add(m[2]));
    if (base === null) return null;
  }
  return m[3] === undefined ? base : m[3] === '+' ? base + Number(m[4]) : base - Number(m[4]);
}

// 一个时刻是不是直接或者经别的事件引用了事件 id
function refers(film, value, id, seen = new Set()) {
  const m = typeof value === 'string' ? EXPR.exec(value) : null;
  if (!m || m[2] === undefined || seen.has(m[2])) return false;
  return m[2] === id || refers(film, get(byId(list(film, 'events'), m[2]), 'frame'), id, new Set(seen).add(m[2]));
}

// D 契约 3.1 到 3.5 各表「单位」一栏不是「无」的字段
function contractUnit([p0, p1, p2, p3, p4]) {
  if (p0 === 'output') return get({ size: '像素', fps: '帧每秒', frames: '帧' }, p1);
  if (p0 === 'timeline') return get({ bpm: '拍每分钟', beatFrames: '帧' }, p1);
  if (p0 === 'shots') {
    if (p3 === undefined) return get({ in: '帧', out: '帧' }, p2);
    if (p2 === 'shutter') return get({ angleDeg: '度', samples: '次' }, p3);
    if (p2 === 'tiers') return p4 === 'samples' ? '次' : undefined;
    if (p2 === 'handles') return get({ head: '帧', tail: '帧' }, p3);
  }
  if (p0 === 'transitions') return p2 === 'at' ? '帧' : undefined;
  if (p0 === 'events') return p2 === 'frame' ? '帧' : undefined;
  if (p0 === 'overlays') return get({ in: '帧', out: '帧' }, p2);
  if (p0 === 'style' && p1 === 'colorScript') return p3 === 'tol' ? '色差' : undefined;
  if (p0 === 'audio') return p1 === 'narration' ? (p3 === 'at' ? '帧' : undefined) : get({ loudness: 'LUFS', truePeak: 'dBTP' }, p1);
}

// 两处 params 下面的参数单位不由片子描述契约定：照问的人给的、参数资料里的、卡文件参数表里的次序取
function paramUnit(film, parts, path, query, context, layerUnit) {
  let fromCard;
  if (parts[2] === 'cards' && parts.length === 6) {
    const use = get(byAs(list(byId(list(film, 'shots'), parts[1]), 'cards'), parts[3]), 'use');
    const cards = get(context, 'cards');
    const card = typeof use === 'string' ? get(cards, use) ?? get(cards, use.split('@')[0]) : undefined;
    fromCard = get(get(get(card, 'params'), parts[5]), 'unit');
  }
  return get(query, 'unit') ?? get(get(context, 'units'), path) ?? fromCard ?? layerUnit ?? '无';
}

// 改这个参数会影响哪些镜头、哪些帧。能照片子描述算到帧的（叠加层、旁白）给到帧，别的给到整个镜头。
function affectsOf(film, parts, context) {
  const shots = list(film, 'shots').filter(isObj);
  const inside = frame => shots.filter(s => get(s, 'in') <= frame && frame < get(s, 'out'));
  const [p0, p1, p2] = parts;
  if (p0 === 'shots' && p1 !== undefined) return { hit: shots.filter(s => get(s, 'id') === p1) };
  if (p0 === 'style' && p1 === 'colorScript' && p2 !== undefined) return { hit: shots.filter(s => get(s, 'id') === p2) };
  if (p0 === 'style' && p1 === 'view' && (p2 === 'scene' || p2 === 'display')) {
    return { hit: shots.filter(s => get(s, 'colorRef') === p2), none: `没有 colorRef 是 ${p2} 的镜头` };
  }
  if (p0 === 'overlays' && p1 !== undefined) {
    const overlay = byId(list(film, 'overlays'), p1);
    const range = [expand(film, get(overlay, 'in')), expand(film, get(overlay, 'out'))];
    return { hit: shots.filter(s => get(s, 'id') === get(overlay, 'shot')), ...(range[0] !== null && range[0] < range[1] ? { range } : {}) };
  }
  if (p0 === 'events' && p1 !== undefined) {
    const owner = event => {
      const shot = get(event, 'shot'), frame = expand(film, get(event, 'frame'));
      return shot !== undefined ? shots.filter(s => get(s, 'id') === shot) : frame === null ? [] : inside(frame);
    };
    const hit = new Set(owner(byId(list(film, 'events'), p1)));
    for (const event of list(film, 'events')) if (refers(film, get(event, 'frame'), p1)) for (const s of owner(event)) hit.add(s);
    for (const overlay of list(film, 'overlays')) {
      if (refers(film, get(overlay, 'in'), p1) || refers(film, get(overlay, 'out'), p1)) for (const s of shots) if (get(s, 'id') === get(overlay, 'shot')) hit.add(s);
    }
    for (const line of list(get(film, 'audio'), 'narration')) {
      const at = expand(film, get(line, 'at'));
      if (at !== null && refers(film, get(line, 'at'), p1)) for (const s of shots) if (get(s, 'out') > at) hit.add(s);
    }
    const cards = get(context, 'cards');
    for (const s of shots) for (const c of list(s, 'cards')) {
      const use = get(c, 'use'), params = get(c, 'params');
      if (!isObj(params)) continue;
      const def = typeof use === 'string' && isObj(cards) ? get(cards, use) ?? get(cards, use.split('@')[0]) : undefined;
      const schemaParams = get(def, 'params');
      for (const [k, val] of Object.entries(params)) {
        if ((schemaParams === undefined || get(get(schemaParams, k), 'type') === 'time') && refers(film, val, p1)) hit.add(s);
      }
    }
    return { hit: shots.filter(s => hit.has(s)) };
  }
  if (p0 === 'transitions' && p1 !== undefined) {
    const at = get(byId(list(film, 'transitions'), p1), 'at');
    return { hit: shots.filter(s => get(s, 'in') === at || get(s, 'out') === at) };
  }
  if (p0 === 'audio' && p1 === 'narration' && p2 !== undefined) {
    const at = expand(film, get(byId(list(get(film, 'audio'), 'narration'), p2), 'at'));
    if (at !== null) {
      const hit = shots.filter(s => get(s, 'out') > at);
      return { hit, ...(hit.length ? { range: [at, get(hit.at(-1), 'out')] } : {}) };
    }
  }
  return { hit: shots };
}

// 外层资料按完整参数路径索引。值为 { from, value, unit? }，令牌引用为 { from, token }。
// query 可直接给路径，或给 { path, unit }：unit 只对两处 params 下面的参数起作用，契约定了单位的字段照契约。
// context.rev 是手里这份片子描述的修订号；不给时读补丁入口交回的片子上记的那一个。知道修订号时写进片子层的 from。
// 交回的对象可枚举的字段正好是 D 契约 3.7 的 Explain，直接序列化就合 explain.schema.json；
// 胜出的层另挂在不可枚举的 winnerLayer 上：cardDefault、templateOrToken、film、jobOverride 之一。
export function explainParam(film, query, context = {}) {
  const path = typeof query === 'string' ? query : get(query, 'path');
  if (typeof path !== 'string' || !/^[^/#\s]+(?:\/[^/#\s]+)*$/u.test(path)) throw new TypeError('参数路径不合法');
  const parts = path.split('/');
  // 只照 JSON 的结构走：对象按自有键，按标识寻址的数组按标识，走到标量或别的数组就停，不读字符串、数组自带的属性
  let explicit = film;
  for (const [i, key] of parts.entries()) {
    if (Array.isArray(explicit)) {
      const cards = i === 3 && parts[0] === 'shots' && parts[2] === 'cards';
      const identified = i === 1 && ['shots', 'events', 'transitions', 'overlays'].includes(parts[0]) ||
        i === 2 && parts[0] === 'audio' && parts[1] === 'narration';
      if (!cards && !identified || identified && /^[0-9]+$/.test(key)) throw new TypeError('数组路径不合法');
      explicit = explicit.find(v => get(v, cards ? 'as' : 'id') === key);
      if (!explicit) throw new TypeError(`条目标识不存在 ${key}`);
    } else if (isObj(explicit)) {
      explicit = get(explicit, key);
    } else if (explicit === undefined) {
      break;
    } else {
      throw new TypeError(`${parts.slice(0, i).join('/')} 是标量，下面没有 ${key} 这个键`);
    }
  }
  const problems = checks.D5({ format: 'film-check/0.1', film, paths: [{ use: 'explain.path', path }] });
  if (problems.length) throw new TypeError(problems[0]);
  const knownRev = get(context, 'rev') ?? getFilmRev(film);
  const hasRev = Number.isSafeInteger(knownRev) && knownRev >= 0;
  const customFilmFrom = get(get(get(context, 'film'), path), 'from');
  if (customFilmFrom !== undefined && (typeof customFilmFrom !== 'string' || !customFilmFrom)) {
    throw new TypeError('来源 from 必须是不空的字符串');
  }
  const filmFrom = customFilmFrom
    ? (hasRev && !new RegExp(`\\brev\\s*${knownRev}\\b`).test(customFilmFrom) ? `rev ${knownRev}，${customFilmFrom}` : customFilmFrom)
    : (hasRev ? `rev ${knownRev}，film.json` : 'film.json');
  const layers = [];
  let winnerLayer, value, layerUnit;
  for (const [source, layer] of layersBySource) {
    const record = source === 'film'
      ? { value: explicit, from: filmFrom }
      : get(get(context, source), path);
    if (!record) continue;
    const rawFrom = get(record, 'from');
    if (rawFrom !== undefined && (typeof rawFrom !== 'string' || !rawFrom)) {
      throw new TypeError('来源 from 必须是不空的字符串');
    }
    const token = get(record, 'token');
    const supplied = token === undefined ? get(record, 'value') : get(get(get(film, 'style'), 'tokens'), token);
    if (token !== undefined && supplied === undefined) throw new TypeError(`找不到画风令牌 ${token}`);
    const entry = { layer, from: rawFrom ?? source };
    if (supplied != null) {
      value = supplied;
      winnerLayer = source;
      entry.value = supplied;
      layerUnit = get(record, 'unit') ?? layerUnit;
    }
    layers.push(entry);
  }
  if (winnerLayer === undefined) throw new TypeError(`参数没有生效值 ${path}`);
  const { hit, range, none } = affectsOf(film, parts, context);
  // Explain 的 frameRange 要求起 < 止，写不出「一帧都不影响」
  if (!hit.length) throw new TypeError(`参数 ${path} 现在不影响任何镜头${none ? `：${none}` : ''}`);
  const free = parts[0] === 'shots' && (parts[2] === 'params' && parts.length > 3 || parts[2] === 'cards' && parts[4] === 'params' && parts.length > 5);
  const unit = free ? paramUnit(film, parts, path, query, context, layerUnit) : contractUnit(parts) ?? '无';
  if (typeof unit !== 'string' || !unit) throw new TypeError('单位必须是不空的字符串');
  const coupling = get(get(context, 'coupling'), path) ?? [];
  if (!Array.isArray(coupling) || coupling.some(v => typeof v !== 'string' || !v)) {
    throw new TypeError('耦合项必须是不空的字符串数组');
  }
  const shotIds = hit.map(s => get(s, 'id'));
  const frameRange = range ?? [get(hit[0], 'in'), get(hit.at(-1), 'out')];
  if (shotIds.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) || new Set(shotIds).size !== shotIds.length ||
      !Number.isSafeInteger(frameRange[0]) || !Number.isSafeInteger(frameRange[1]) || frameRange[0] < 0 || frameRange[0] >= frameRange[1]) {
    throw new TypeError('影响范围不满足 Explain 结构约束');
  }
  const out = structuredClone({
    path, value, unit, layers,
    coupling,
    affects: { shots: shotIds, frameRange },
  });
  return Object.defineProperty(out, 'winnerLayer', { value: winnerLayer });
}
