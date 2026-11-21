// L1 写入即检：结构、单位、色彩空间、片子描述契约里只读片子自己就能判的条文；未知键的改名修法；
// 镜头源码的墙钟和不带种子随机扫描；成本粗估。
// 结构照片子描述契约第 3 节逐层列键；路径照它的 5.4（数组按 id、卡实例按 as 寻址，不写下标）；
// 未知键的诊断照错误码表契约 5.5；修法照补丁契约（rename 只带 to，换数组用 set）。
// 修订号不写在片子描述里（片子描述契约 5.7），所以 rev 从 options 进、从返回值出，不往片子描述里加键。
import { readFileSync } from 'node:fs';
import { checkExtra, expandTime, parseFps, registeredTemplate, suggestKey } from './predicates.mjs';

// 帧源登记表：只拿来判镜头的 host、mode 在不在帧源声明的范围里
const SOURCES = JSON.parse(readFileSync(new URL('../kernel/contracts/source/source.json', import.meta.url), 'utf8')).sources;

/* ---------------- 位置与诊断 ---------------- */

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isInt = Number.isSafeInteger;
const show = (v) => JSON.stringify(v) ?? String(v);
const SEG_RE = /^[^/#\s]+$/;

// 位置 { at, sub }：at 是照 5.4 写得出来的路径（根是空串）；sub 不是 null 时，说明再往下已经寻址不到
// （不能寻址到项的数组里的项、没有合法标识的项、键名写不成路径段），at 停在最后一个写得出来的地方，sub 用文字说是哪儿
const ROOT = { at: '', sub: null };
const at = (path) => ({ at: path, sub: null });
function child(w, key) {
  if (w.sub !== null) return { at: w.at, sub: `${w.sub} 的 ${key}` };
  if (!SEG_RE.test(key)) return { at: w.at, sub: `键 ${show(key)}` };
  return { at: w.at ? `${w.at}/${key}` : key, sub: null };
}
/** 数组的第 i 项：id 是合法标识就按它寻址，是 null 就停在数组上、用文字说第几项 */
function itemAt(w, i, id) {
  if (w.sub === null && id !== null) return { at: `${w.at}/${id}`, sub: null };
  return { at: w.at, sub: `${w.sub === null ? '' : `${w.sub} 的`}第 ${i + 1} 项` };
}
const label = (w) => (w.sub === null ? w.at || '根' : `${w.at || '根'} ${w.sub}`);

const REGISTERED_CODES = new Set(['contract.unknown-key', 'contract.bad-value', 'usage.bad-argument']);
function mapDiagCode(rawCode) {
  if (REGISTERED_CODES.has(rawCode)) return rawCode;
  if (rawCode === 'l1.allowance-refused') return 'usage.bad-argument';
  return 'contract.bad-value';
}

/** 记一条诊断（信封契约 3.4 的形状）：code 一律为已登记码（满足 EN4），细分类别记在 evidence */
function diag(cx, severity, rawCode, w, message, more = {}) {
  const code = mapDiagCode(rawCode);
  cx.diags.push({
    code,
    layer: 'L1',
    severity,
    ...(w.at ? { at: w.at } : {}),
    message,
    ...(code !== rawCode ? { evidence: rawCode } : {}),
    ...(w.sub !== null ? { hint: w.sub } : {}),
    ...more,
  });
}
const err = (cx, code, w, message, more) => diag(cx, 'error', code, w, message, more);

/* ---------------- 结构表 ---------------- */

const ID_RE = /^[a-z][a-z0-9-]*$/;
const ALIAS_RE = /^[A-Za-z0-9_]+$/;
const FREE_KEY_RE = SEG_RE;
const COLOR_RE = /^#[0-9A-F]{6}$/;
const ENTITY_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const ASSET_REF_RE = /^asset:[a-z0-9][a-z0-9-]*@[1-9]\d*$/;
const CARD_REF_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@[1-9]\d*$/;
const SOURCE_RE = /^(?:blender|three|core|legacy-page|ext\.[a-z0-9][a-z0-9-]*)$/;
const ENTRY_RE = /^(?!\/)(?![\s\S]*(?:^|\/)\.\.(?:\/|$))[^\\:]+$/;
const TIME_EXPR_RE = /^(?:cut\((0|[1-9]\d*)\)|event\(([a-z][a-z0-9-]*)\))(?: [+-] [1-9]\d*)?$/;
const MODES = ['cards-data', 'build-script', 'native-code'];
const RESERVED = ['tracks', 'host'];

const idOk = (s) => ID_RE.test(s);
const shotIdOk = (s) => ID_RE.test(s) && s !== 'film';
const overlayIdOk = (s) => /^[a-z][a-z0-9]*$/.test(s) && !RESERVED.includes(s);
const asOk = (s) => ALIAS_RE.test(s) && !RESERVED.includes(s);

// 每个校验器 (值, 位置, 上下文) → 往上下文里记诊断
const leaf = (test, what, code = 'l1.value') => (v, w, cx) => { if (!test(v)) err(cx, code, w, `${label(w)} 必须是${what}，现在是 ${show(v)}`); };
const str = (test, what) => leaf((v) => typeof v === 'string' && (test instanceof RegExp ? test.test(v) : test(v)), what);
const oneOf = (...xs) => leaf((v) => xs.includes(v), `${xs.join('、')} 之一`);
// 帧：整数帧，秒只在入口换算一次；写成小数的是单位错
const frame = (min) => leaf((v) => isInt(v) && v >= min, `整数帧，≥ ${min}（帧，不收秒或小数）`, 'l1.unit');
const timeAt = leaf((v) => (isInt(v) && v >= 0) || (typeof v === 'string' && TIME_EXPR_RE.test(v)), '整数帧或时刻算式', 'l1.unit');
const seed = leaf((v) => isInt(v) && v >= 0 && v <= 4294967295, '[0, 4294967295] 的整数');
const num = (test, what, code = 'l1.value') => leaf((v) => typeof v === 'number' && Number.isFinite(v) && test(v), what, code);
const color = leaf((v) => typeof v === 'string' && COLOR_RE.test(v), '显示空间的 #RRGGBB（6 位十六进制，字母大写）', 'l1.color');
const bool = leaf((v) => typeof v === 'boolean', '布尔');
const any = () => {};
const count = leaf((x) => isInt(x) && x >= 1, '≥ 1 的整数');
/** 不能寻址到项的简单数组：整个当一个值判 */
const list = (test, what, { min = 0, unique = false } = {}) => leaf((v) => Array.isArray(v) && v.length >= min && v.every(test) && (!unique || new Set(v).size === v.length), what);

/** 没定义的键（错误码表契约 5.5）：寻址得到才带 rename 修法；寻址不到的只给 hint，at 停在写得出来的路径上 */
function unknownKey(cx, w, key, to) {
  const near = to ? `，最接近的键是 ${to}` : '';
  if (w.sub !== null) {
    err(cx, 'contract.unknown-key', w, `${label(w)} 里的 ${show(key)} 不是契约定义的键`, { hint: `${w.sub}里的键 ${show(key)} 没有定义${near}；这个位置不能按路径寻址，不带改名修法` });
    return;
  }
  if (!SEG_RE.test(key)) {
    err(cx, 'contract.unknown-key', w, `${label(w)} 的键 ${show(key)} 不是契约定义的键`, { hint: `键名 ${show(key)} 带 /、# 或空白，写不成路径，不带改名修法${near}` });
    return;
  }
  const p = child(w, key);
  if ((w.at === 'predicates' && to === 'base') || (w.at === '' && to === 'predicates')) {
    err(cx, 'contract.unknown-key', p, `${p.at} 不是契约定义的键`, { hint: `最接近的键是 ${to}；predicates/base 由服务器写入` });
    return;
  }
  err(cx, 'contract.unknown-key', p, `${p.at} 不是契约定义的键`, to ? { hint: `最接近的键是 ${to}`, fix: { op: 'rename', path: p.at, to, applicability: 'machine' } } : {});
}

/** 对象：fields 是 { 键: [必填, 校验器] }；不认的键报 contract.unknown-key */
function obj(fields) {
  const known = Object.keys(fields);
  return (v, w, cx) => {
    if (!isObj(v)) { err(cx, 'l1.type', w, `${label(w)} 必须是对象，现在是 ${show(v)}`); return; }
    for (const k of Object.keys(v)) {
      if (Object.hasOwn(fields, k)) fields[k][1](v[k], child(w, k), cx);
      else unknownKey(cx, w, k, suggestKey(k, known.filter((x) => !Object.hasOwn(v, x))));
    }
    for (const k of known) if (fields[k][0] && !Object.hasOwn(v, k)) err(cx, 'l1.missing', child(w, k), `${label(w)} 缺必填字段 ${k}`);
  };
}
const R = (f) => [true, f], O = (f) => [false, f];

/** 映射：键是自由键或别名（映射键本身不算未知键），值照 valueCheck */
const map = (keyRe, valueCheck = any) => (v, w, cx) => {
  if (!isObj(v)) { err(cx, 'l1.type', w, `${label(w)} 必须是对象，现在是 ${show(v)}`); return; }
  for (const k of Object.keys(v)) {
    if (!keyRe.test(k)) err(cx, 'l1.key', w, `${label(w)} 的键 ${show(k)} 写法不对`, { hint: `键要合 ${keyRe}` });
    valueCheck(v[k], child(w, k), cx);
  }
};

/** 项是对象的数组。idKey 给了就按它寻址并查重：标识缺了、写法不合、和前面的项重复的那一项寻址不到 */
const arr = (item, { idKey = null, ok = null, min = 0 } = {}) => (v, w, cx) => {
  if (!Array.isArray(v)) { err(cx, 'l1.type', w, `${label(w)} 必须是数组，现在是 ${show(v)}`); return; }
  if (v.length < min) err(cx, 'l1.value', w, `${label(w)} 至少 ${min} 项`);
  const ids = v.map((x) => idKey && isObj(x) && typeof x[idKey] === 'string' && ok(x[idKey]) ? x[idKey] : null);
  const seen = new Set(), duplicates = new Set();
  for (const id of ids) {
    if (id !== null && seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  for (const id of duplicates) err(cx, 'l1.duplicate-id', w, `${label(w)} 里不止一项的 ${idKey} 是 ${id}`);
  v.forEach((x, i) => item(x, itemAt(w, i, duplicates.has(ids[i]) ? null : ids[i]), cx));
};

const TIER = obj({ samples: O(count), scale: O(num((x) => x > 0 && x <= 1, '(0, 1] 的缩放')) });
const ASSETS = map(ALIAS_RE, str(ASSET_REF_RE, '资产引用 asset:<名>@<版本>'));
const CARD_REF = str(CARD_REF_RE, '卡的引用 <域>.<卡名>@<主版本>');
const SOURCE = str(SOURCE_RE, '帧源名（blender、three、core、legacy-page 或 ext.<名字>）');
const ENTRY = str(ENTRY_RE, '仓库里的相对路径（不以 / 开头，不含 ..、反斜杠、冒号）');
const NONEMPTY = str((s) => s.length > 0, '不空的字符串');

const SHOT = obj({
  id: R(str(shotIdOk, '小写字母开头的标识，不得是 film')), in: R(frame(0)), out: R(frame(1)), source: R(SOURCE), host: R(NONEMPTY),
  mode: R(oneOf(...MODES)), entry: O(ENTRY), colorRef: R(oneOf('scene', 'display')),
  seed: O(seed), assets: O(ASSETS),
  cards: O(arr(obj({ as: R(str(asOk, '实例名，不得是 tracks、host')), use: R(CARD_REF), params: R(map(FREE_KEY_RE)) }), { idKey: 'as', ok: asOk })),
  params: O(map(FREE_KEY_RE)),
  roles: O(obj({ hero: O(str(ENTITY_RE, '实体名')), mustSee: O(list((x) => typeof x === 'string' && ENTITY_RE.test(x), '不重复的实体名的数组', { unique: true })) })),
  shutter: O(obj({ angleDeg: R(num((x) => x >= 0 && x <= 360, '[0, 360] 度', 'l1.unit')), samples: O(count) })),
  tiers: O(obj({ draft: O(TIER), final: O(TIER) })),
  handles: O(obj({ head: R(frame(0)), tail: R(frame(0)) })),
  deliberate: O(arr(obj({ kind: R(oneOf('freeze', 'black')), in: R(frame(0)), out: R(frame(1)), why: R(NONEMPTY) }))),
  renderer: O(obj({ source: R(SOURCE), host: R(NONEMPTY), mode: R(oneOf(...MODES)), entry: O(ENTRY) })),
});

const channelName = /^(?:color|depth|objectId|normal|motion|denoiseAlbedo|denoiseNormal|lightgroup:[a-z0-9][a-z0-9-]*)$/;
const FILM = obj({
  format: R(oneOf('film/3.0')), id: R(str(/^[a-z][a-z0-9_-]*$/, '片子的标识')), seed: O(seed), title: O(NONEMPTY), exam: O(str(/^[1-9]\d*-[1-9]\d*$/, '题号 <套>-<题>')),
  output: R(obj({
    size: R(leaf((v) => Array.isArray(v) && v.length === 2 && v.every((x) => isInt(x) && x > 0), '[宽, 高]，正整数像素', 'l1.unit')),
    fps: R(leaf(parseFps, '"分子/分母" 的互质有理数（帧每秒）', 'l1.unit')),
    frames: R(frame(1)),
  })),
  timeline: O(obj({ bpm: O(num((x) => x > 0, '> 0（拍每分钟）', 'l1.unit')), beatFrames: O(frame(1)) })),
  assets: O(ASSETS),
  shots: R(arr(SHOT, { idKey: 'id', ok: shotIdOk, min: 1 })),
  transitions: O(arr(obj({ id: R(str(ID_RE, '标识')), at: R(frame(1)), type: R(oneOf('cut')) }), { idKey: 'id', ok: idOk })),
  events: O(arr(obj({ id: R(str(ID_RE, '标识')), frame: R(timeAt), shot: O(str(ID_RE, '镜头的 id')), audio: O(str(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/, '声音事件名')), sync: O(oneOf('onset', 'pcenter')) }), { idKey: 'id', ok: idOk })),
  overlays: O(arr(obj({
    id: R(str(overlayIdOk, '小写字母开头、只含小写字母和数字的标识，不得是 tracks、host')), shot: R(str(ID_RE, '镜头的 id')),
    anchor: R(str(/^(screen|[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*#[A-Za-z0-9_]+)$/, 'screen 或 <实体名>#<锚点名>')),
    pos: O(leaf((v) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && x >= 0 && x <= 1), '[u, v]，归一化 [0, 1]', 'l1.unit')),
    text: R(NONEMPTY), in: R(timeAt), out: R(timeAt),
  }), { idKey: 'id', ok: overlayIdOk })),
  style: R(obj({
    tokens: O(map(FREE_KEY_RE, color)),
    view: R(obj({ scene: R(str(/^[a-z0-9][a-z0-9-]*$/, '查找表名')), display: R(oneOf('srgb')), card: O(CARD_REF) })),
    colorScript: O(map(ID_RE, obj({ key: R(list((c) => typeof c === 'string' && COLOR_RE.test(c), '显示空间 #RRGGBB 的数组，至少一项', { min: 1 })), tol: R(num((x) => x >= 0, '≥ 0 的色差')) }))),
    finish: O(obj({ grain: O(num((x) => x >= 0 && x <= 1, '[0, 1]')), vignette: O(num((x) => x >= 0 && x <= 1, '[0, 1]')), card: O(CARD_REF) })),
  })),
  audio: O(obj({
    mode: O(oneOf('script', 'track', 'none')), loudness: O(num(() => true, '有限数（LUFS）', 'l1.unit')), truePeak: O(num(() => true, '有限数（dBTP）', 'l1.unit')),
    narration: O(arr(obj({ id: R(str(ID_RE, '标识')), at: R(timeAt), asset: R(str(ALIAS_RE, '资产别名')) }), { idKey: 'id', ok: idOk })), card: O(CARD_REF),
  })),
  predicates: R(obj({ base: R(checkBase), extra: O(checkExtras) })),
  delivery: R(obj({ master: R(str(/^[a-z0-9][a-z0-9-]*$/, '编码预设名')), web: O(bool), contact: O(bool), layers: O(list((x) => typeof x === 'string' && channelName.test(x), '不重复的通道名的数组', { unique: true })), card: O(CARD_REF) })),
});


function checkBase(v, w, cx) {
  if (!Array.isArray(v)) { err(cx, 'l1.type', w, `${label(w)} 必须是数组，现在是 ${show(v)}`); return; }
  if (new Set(v).size !== v.length) err(cx, 'l1.value', w, `${label(w)} 有重复项`);
  for (const r of v) {
    const m = typeof r === 'string' && r.match(/^(?:floor|template:([a-z][a-z0-9-]*))@([1-9]\d*)$/);
    if (!m) { err(cx, 'l1.value', w, `${label(w)} 的 ${show(r)} 不是 floor@<主版本> 或 template:<模板名>@<主版本>`); continue; }
    if (!registeredTemplate(m[1] ?? 'floor', Number(m[2]))) err(cx, 'predicate.unregistered', w, `${label(w)} 引用的 ${r} 没有登记`);
  }
}

/** 把一条断言里拼错的命名实参改成唯一的候选（引号里面的不动）；没得改时原样返回 */
function repairExtra(text) {
  let cur = text;
  for (let n = 0; n < 4; n++) {
    const e = checkExtra(cur).errors.find((x) => x.rename);
    if (!e) break;
    const next = cur.replace(new RegExp(`"[^"]*"|([(,]\\s*)${e.rename.from}(\\s*=)`, 'g'), (m, head, tail) => (head === undefined ? m : `${head}${e.rename.to}${tail}`));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** predicates.extra：逐项对登记表核。它是不能寻址到项的数组，命名实参拼错的修法是一条 set，把改好的整个数组写回去 */
function checkExtras(v, w, cx) {
  if (!Array.isArray(v)) { err(cx, 'l1.type', w, `${label(w)} 必须是数组，现在是 ${show(v)}`); return; }
  const repaired = v.map((x) => (typeof x === 'string' ? repairExtra(x) : x));
  const changed = repaired.some((x, i) => x !== v[i]);
  let fix = changed && w.sub === null ? { op: 'set', path: w.at, value: repaired, applicability: 'machine' } : null;
  v.forEach((x, i) => {
    for (const e of checkExtra(x).errors) {
      const more = {};
      if (e.hint) more.hint = e.hint;
      if (e.rename && fix && repaired[i] !== x) { more.fix = fix; fix = null; } // 整个数组只发一条修法，挂在第一条拼错的诊断上
      err(cx, e.evidence ?? e.code, w, `${label(w)} 第 ${i + 1} 项：${e.message}`, more);
    }
  });
}

/* ---------------- 跨字段的条文 ---------------- */

const objectsIn = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const isExt = (source) => typeof source === 'string' && source.startsWith('ext.');
const cardName = (ref) => ref.slice(0, ref.lastIndexOf('@'));
// 全片级的键绑的卡（片子描述契约 3.6）
const GLOBAL_CARDS = { 'style/view': 'comp.display', 'style/finish': 'comp.finish', delivery: 'deliver.encode', audio: 'audio.master' };

/** 一套 source、host、mode、entry（镜头自己的，或 renderer 的）：host 和 mode 在帧源登记的范围里，entry 有没有照 mode 定 */
function checkSourceSet(cx, who, set, w) {
  if (typeof set.source !== 'string') return;
  if (Object.hasOwn(SOURCES, set.source)) {
    const reg = SOURCES[set.source];
    if (typeof set.host === 'string' && !reg.hosts.includes(set.host)) err(cx, 'l1.source', w, `${who} 的宿主 ${set.host} 不在帧源 ${set.source} 的 hosts（${reg.hosts.join('、')}）里`);
    if (MODES.includes(set.mode) && !reg.modes.includes(set.mode)) err(cx, 'l1.source', w, `${who} 的作者模式 ${set.mode} 不在帧源 ${set.source} 的 modes（${reg.modes.join('、')}）里`);
  }
  if (isExt(set.source) || !MODES.includes(set.mode)) return;
  const has = set.entry !== undefined;
  if (set.mode === 'cards-data' && has) err(cx, 'l1.entry', w, `${who} 的 mode 是 cards-data，不得有 entry`);
  if (set.mode !== 'cards-data' && !has) err(cx, 'l1.entry', w, `${who} 的 mode 是 ${set.mode}，缺 entry`);
}

/** 片子描述契约里只读片子自己就能判的条文：D1、D2、D8、D11 到 D14、D16 到 D19（D10、D20 在结构表里判） */
function crossChecks(film, cx) {
  const shots = objectsIn(film.shots);
  const shotAt = (s, ...keys) => at(typeof s.id === 'string' && shotIdOk(s.id) ? ['shots', s.id, ...keys].join('/') : 'shots');
  const itemPath = (name, x, ok) => at(typeof x.id === 'string' && ok(x.id) ? `${name}/${x.id}` : name);
  const frames = isInt(film.output?.frames) ? film.output.frames : null;
  const filmAssets = isObj(film.assets) ? film.assets : {};

  // D1：镜头首尾相接，盖满全片
  const timed = shots.length > 0 && shots.length === film.shots.length && shots.every((s) => isInt(s.in) && isInt(s.out));
  if (timed) {
    let expect = 0;
    for (const s of shots) {
      if (s.in !== expect) err(cx, 'l1.shots', shotAt(s), `镜头 ${s.id} 的 in 是 ${s.in} 帧，应接在 ${expect} 帧`);
      if (s.in >= s.out) err(cx, 'l1.shots', shotAt(s), `镜头 ${s.id} 的 in ${s.in} 帧不小于 out ${s.out} 帧`);
      expect = s.out;
    }
    if (frames !== null && expect !== frames) err(cx, 'l1.shots', at('shots'), `镜头表止于 ${expect} 帧，output.frames 是 ${frames} 帧`);
  }
  const cuts = timed ? shots.slice(1).map((s) => s.in) : null;
  const shotIds = shots.map((s) => s.id);
  const shotOf = (id) => shots.find((s) => s.id === id);

  for (const s of shots) {
    // D19：deliberate 落在镜头里
    for (const d of objectsIn(s.deliberate)) {
      if (isInt(s.in) && isInt(s.out) && isInt(d.in) && isInt(d.out) && !(s.in <= d.in && d.in < d.out && d.out <= s.out)) {
        err(cx, 'l1.shots', shotAt(s, 'deliberate'), `镜头 ${s.id} 的 deliberate [${d.in}, ${d.out}) 不在镜头的 [${s.in}, ${s.out}) 内或不是 in < out`);
      }
    }
    // D11、D12
    checkSourceSet(cx, `镜头 ${s.id}`, s, shotAt(s));
    if (isObj(s.renderer)) checkSourceSet(cx, `镜头 ${s.id} 的 renderer`, s.renderer, shotAt(s, 'renderer'));
    // D17、D16：帧源是 ext.<名字> 的镜头
    if (isExt(s.source)) {
      if (MODES.includes(s.mode) && s.mode !== 'native-code') err(cx, 'l1.ext', shotAt(s, 'mode'), `镜头 ${s.id} 的帧源是 ${s.source}，mode 必须是 native-code，现在是 ${s.mode}`);
      if (s.entry !== undefined) err(cx, 'l1.ext', shotAt(s, 'entry'), `镜头 ${s.id} 的帧源是 ${s.source}，不得有 entry`);
      const piece = isObj(s.params) ? s.params.piece : undefined;
      if (piece === undefined) err(cx, 'l1.ext', shotAt(s), `镜头 ${s.id} 的帧源是 ${s.source}，缺 params.piece`);
      else if (typeof piece !== 'string' || (!Object.hasOwn(isObj(s.assets) ? s.assets : {}, piece) && !Object.hasOwn(filmAssets, piece))) {
        err(cx, 'l1.ref', shotAt(s, 'params', 'piece'), `镜头 ${s.id} 的 params.piece ${show(piece)} 在镜头和全片 assets 里都找不到`);
      }
    }
    // D8 前半、D18 后半
    const cards = objectsIn(s.cards);
    for (const c of cards) {
      if (typeof c.use === 'string' && Object.values(GLOBAL_CARDS).includes(cardName(c.use))) err(cx, 'l1.card', shotAt(s, 'cards'), `镜头 ${s.id} 的卡实例 ${c.as} 用了全片级的卡 ${c.use}`);
    }
    const names = cards.map((c) => c.as);
    for (const o of objectsIn(film.overlays)) {
      if (o.shot === s.id && names.includes(o.id)) err(cx, 'l1.duplicate-id', itemPath('overlays', o, overlayIdOk), `贴在镜头 ${s.id} 上的叠加层 ${o.id} 和这个镜头 cards 里的实例名相同`);
    }
  }
  // D8 后半：键里写了 card 时卡名必须是这个键绑的那张
  for (const [path, want] of Object.entries(GLOBAL_CARDS)) {
    const holder = path.split('/').reduce((cur, k) => (isObj(cur) ? cur[k] : undefined), film);
    if (isObj(holder) && typeof holder.card === 'string' && cardName(holder.card) !== want) err(cx, 'l1.card', at(`${path}/card`), `${path}/card 是 ${holder.card}，这个键绑的卡是 ${want}`);
  }

  // D2：引用的镜头、切点、事件都要有；事件的时刻不成环
  const events = objectsIn(film.events), overlays = objectsIn(film.overlays), narration = objectsIn(film.audio?.narration);
  const eventIds = events.map((e) => e.id);
  for (const e of events) if (typeof e.shot === 'string' && !shotIds.includes(e.shot)) err(cx, 'l1.ref', itemPath('events', e, idOk), `事件 ${e.id} 的 shot ${e.shot} 不是已定义的镜头`);
  for (const o of overlays) if (typeof o.shot === 'string' && !shotIds.includes(o.shot)) err(cx, 'l1.ref', itemPath('overlays', o, overlayIdOk), `叠加层 ${o.id} 的 shot ${o.shot} 不是已定义的镜头`);
  if (isObj(film.style?.colorScript)) {
    for (const k of Object.keys(film.style.colorScript)) if (!shotIds.includes(k)) err(cx, 'l1.ref', at('style/colorScript'), `style.colorScript 的键 ${show(k)} 不是已定义的镜头`);
  }
  const timeFields = [
    ...events.map((e) => [`事件 ${e.id} 的 frame`, e.frame, itemPath('events', e, idOk)]),
    ...overlays.flatMap((o) => [[`叠加层 ${o.id} 的 in`, o.in, itemPath('overlays', o, overlayIdOk)], [`叠加层 ${o.id} 的 out`, o.out, itemPath('overlays', o, overlayIdOk)]]),
    ...narration.map((n) => [`旁白 ${n.id} 的 at`, n.at, itemPath('audio/narration', n, idOk)]),
  ];
  // 时刻算式展开得出、引用都合法时才是整数，否则 null（展开不出的已经在下面这一段报过）
  const expand = (v) => {
    if (isInt(v)) return v;
    const m = typeof v === 'string' ? TIME_EXPR_RE.exec(v) : null;
    if (!m || (m[1] !== undefined && !(cuts ?? []).includes(Number(m[1])))) return null;
    return expandTime(v, film);
  };
  for (const [what, v, w] of timeFields) {
    const m = typeof v === 'string' ? TIME_EXPR_RE.exec(v) : null;
    if (!m) continue;
    if (m[1] !== undefined && cuts && !cuts.includes(Number(m[1]))) err(cx, 'l1.ref', w, `${what} 的 ${v} 里 ${m[1]} 不是切点`);
    if (m[2] !== undefined && !eventIds.includes(m[2])) err(cx, 'l1.ref', w, `${what} 的 ${v} 引用了没定义的事件 ${m[2]}`);
    else if (m[2] !== undefined && expandTime(v, film) === null) err(cx, 'l1.ref', w, `${what} 的 ${v} 展开不出：事件的时刻互相引用成了环，或者引用到展开不出的事件`);
  }

  // D13：展开后的时刻落在全片和所属镜头里
  if (frames !== null) {
    for (const e of events) {
      const f = expand(e.frame);
      if (f === null) continue;
      if (!(f >= 0 && f < frames)) err(cx, 'l1.range', itemPath('events', e, idOk), `事件 ${e.id} 展开在第 ${f} 帧，不在 [0, ${frames}) 内`);
      const shot = typeof e.shot === 'string' ? shotOf(e.shot) : null;
      if (shot && isInt(shot.in) && isInt(shot.out) && !(shot.in <= f && f < shot.out)) err(cx, 'l1.range', itemPath('events', e, idOk), `事件 ${e.id} 展开在第 ${f} 帧，不在镜头 ${shot.id} 的 [${shot.in}, ${shot.out}) 内`);
    }
    for (const n of narration) {
      const f = expand(n.at);
      if (f !== null && !(f >= 0 && f < frames)) err(cx, 'l1.range', itemPath('audio/narration', n, idOk), `旁白 ${n.id} 展开在第 ${f} 帧，不在 [0, ${frames}) 内`);
    }
  }
  for (const o of overlays) {
    const a = expand(o.in), b = expand(o.out);
    const shot = typeof o.shot === 'string' ? shotOf(o.shot) : null;
    if (a === null || b === null || !shot || !isInt(shot.in) || !isInt(shot.out)) continue;
    if (!(shot.in <= a && a < b && b <= shot.out)) err(cx, 'l1.range', itemPath('overlays', o, overlayIdOk), `叠加层 ${o.id} 展开成 [${a}, ${b})，不在镜头 ${shot.id} 的 [${shot.in}, ${shot.out}) 内或不是 in < out`);
  }
  // 叠加层的 pos：anchor 是 screen 时必填，否则不得出现（片子描述契约 3.5）
  for (const o of overlays) {
    if (typeof o.anchor !== 'string') continue;
    if (o.anchor === 'screen' && o.pos === undefined) err(cx, 'l1.missing', itemPath('overlays', o, overlayIdOk), `叠加层 ${o.id} 的 anchor 是 screen，缺 pos`);
    if (o.anchor !== 'screen' && o.pos !== undefined) err(cx, 'l1.value', itemPath('overlays', o, overlayIdOk), `叠加层 ${o.id} 的 anchor 不是 screen，不得有 pos`);
  }

  // D14：转场写在切点上，一个切点只有一个转场
  const transitions = objectsIn(film.transitions).filter((t) => isInt(t.at));
  const seenAt = new Set();
  for (const t of transitions) {
    if (cuts && !cuts.includes(t.at)) err(cx, 'l1.transition', itemPath('transitions', t, idOk), `转场 ${t.id} 写在第 ${t.at} 帧，那里不是切点`);
    if (seenAt.has(t.at)) err(cx, 'l1.transition', at('transitions'), `切点 ${t.at} 上写了不止一个转场`);
    seenAt.add(t.at);
  }
  // D16 前半：旁白的 asset 是全片 assets 里的别名
  for (const n of narration) if (typeof n.asset === 'string' && !Object.hasOwn(filmAssets, n.asset)) err(cx, 'l1.ref', itemPath('audio/narration', n, idOk), `旁白 ${n.id} 的 asset ${n.asset} 不是全片 assets 的别名`);
}

/* ---------------- 修法 ---------------- */

// 按标识寻址的数组（片子描述契约 5.4）：键是数组所在的键，值是拿来寻址的字段
const ADDRESSED = { shots: 'id', transitions: 'id', events: 'id', overlays: 'id', narration: 'id', cards: 'as' };

/** 照 5.4 的路径找到上一层和最后一段：{ parent, key }；路过寻址不到项的数组、或中间哪一段不存在，是 null */
function locate(film, path) {
  const segs = path.split('/');
  let cur = film;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (!isObj(cur) || !Object.hasOwn(cur, s)) return null;
    cur = cur[s];
    if (!Array.isArray(cur)) continue;
    if (!Object.hasOwn(ADDRESSED, s) || i + 1 >= segs.length - 1) return null;
    const want = segs[++i];
    cur = cur.find((x) => isObj(x) && x[ADDRESSED[s]] === want);
  }
  return isObj(cur) ? { parent: cur, key: segs[segs.length - 1] } : null;
}

/** 作用一条机器修法（补丁契约 5.2 的 rename 和 set），返回成没成 */
function applyFix(film, fix) {
  if (fix.applicability !== 'machine') return false;
  const loc = locate(film, fix.path);
  if (!loc) return false;
  const { parent, key } = loc;
  if (fix.op === 'set') { parent[key] = structuredClone(fix.value); return true; }
  if (fix.op !== 'rename' || !Object.hasOwn(parent, key) || Object.hasOwn(parent, fix.to)) return false;
  // 原位改名，键的次序不变
  const entries = Object.entries(parent);
  for (const k of Object.keys(parent)) delete parent[k];
  for (const [k, v] of entries) Object.defineProperty(parent, k === key ? fix.to : k, { value: v, enumerable: true, configurable: true, writable: true });
  return true;
}

/* ---------------- 源码扫描 ---------------- */

// 被找的名字一律拆开拼，本文件自己不出现连写的字面量。清单照时间键契约 5.3
const cat = (...parts) => parts.join('');
const WALL = 'wallClock', RAND = 'unseededRandom';
const DATE = cat('Da', 'te'), PERF = cat('perfor', 'mance'), MATH = cat('Ma', 'th'), CRYPTO = cat('cry', 'pto');
const RANDOM = cat('ran', 'dom'), TIME = cat('ti', 'me');
// 全局对象 → { 成员名: 哪一类 }
const JS_MEMBERS = {
  [DATE]: { now: WALL },
  [PERF]: { now: WALL, [cat(TIME, 'Origin')]: WALL },
  [MATH]: { [RANDOM]: RAND },
  [CRYPTO]: { [cat('get', 'Random', 'Values')]: RAND, [cat(RANDOM, 'UUID')]: RAND },
};
/** 唯一能豁免的调用：宿主读单调时钟量耗时（时间键契约 5.3 的白名单） */
export const MONOTONIC_CLOCK = [PERF, 'now'].join('.');

const JS_ID = '[A-Za-z_$][\\w$]*';
const HOSTS = '(?:globalThis|window|self|global)';
const QUOTE = '[\'"`]';
const lit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 取成员的写法：点号取、可选链、方括号里写字符串，都算 */
const memberSource = (object, prop) => `(?<![\\w$])${lit(object)}\\s*(?:\\??\\.\\s*${prop}\\b|(?:\\?\\.)?\\s*\\[\\s*(?<q>${QUOTE})${prop}\\k<q>\\s*\\])`;
const HOST_BRACKET = new RegExp(`${HOSTS}\\s*\\[\\s*(?<q>${QUOTE})(?<name>${Object.keys(JS_MEMBERS).join('|')})\\k<q>\\s*\\]`, 'g');
// 赋值号：不是 ==、=>，后面跟的名字整个就是被赋的值（后面不再取成员、不再调用）
const ASSIGN = '\\s*=(?![=>])\\s*';
const WHOLE = '(?![\\w$])(?!\\s*(?:\\?\\.|[.\\[(]))';
const NODE_MODULE = `${QUOTE}(?:node:)?(?<mod>${CRYPTO}|perf_hooks)${QUOTE}`;
const LOAD = '(?:await\\s+import|require)';

/** 解构或具名导入的清单 "a, b: c, d as e, f = 1" → [[原名, 本地名]] */
function bindings(listText) {
  const one = new RegExp(`^(${JS_ID})(?:\\s*(?::|\\bas\\b)\\s*(${JS_ID}))?`);
  return listText.split(',').map((part) => part.trim().match(one)).filter(Boolean).map((m) => [m[1], m[2] ?? m[1]]);
}

/**
 * JS 的命中 [{ kind, call, index }]。除了清单里的直接写法，还认：
 *   全局对象的别名（M = 那个对象）、从它解构出来的成员（{ 成员 } = 对象、{ 成员: 别名 } = 对象）、
 *   把成员赋给别的名字再调用、从全局对象上用方括号或解构取对象、从 node 的同名模块导入或 require 出来的成员。
 * 解构、导入那一处和之后每一次调用各记一次命中，call 一律写清单里的规范名。
 */
function scanJs(text) {
  // 把 全局对象['名字'] 换成等长的 名字，后面的规则按名字找；等长，所以下标和行号不变
  const src = text.replace(HOST_BRACKET, (m, ...rest) => rest.at(-1).name.padEnd(m.length));
  const found = new Map();
  const hit = (kind, call, index) => found.set(`${call}@${index}`, { kind, call, index });
  const each = (source, fn) => { for (const m of src.matchAll(new RegExp(source, 'g'))) fn(m); };
  const objects = new Map(Object.keys(JS_MEMBERS).map((n) => [n, n])); // 本地名 → 全局对象
  const functions = new Map(); // 本地名 → { kind, call }
  const bindMember = (object, prop, local, index) => {
    if (!Object.hasOwn(JS_MEMBERS[object], prop)) return;
    const f = { kind: JS_MEMBERS[object][prop], call: `${object}.${prop}` };
    functions.set(local, f);
    hit(f.kind, f.call, index);
  };
  // node 模块：具名导入、解构 require、整个模块的别名
  const fromModule = (m) => {
    for (const [name, local] of bindings(m.groups.list)) {
      if (m.groups.mod !== CRYPTO) { if (name === PERF) objects.set(local, PERF); continue; }
      if (name === cat('web', CRYPTO)) objects.set(local, CRYPTO);
      else bindMember(CRYPTO, name, local, m.index);
    }
  };
  const wholeModule = (m) => { if (m.groups.mod === CRYPTO) objects.set(m.groups.local, CRYPTO); };
  each(`import\\s*\\{(?<list>[^{}]*)\\}\\s*from\\s*${NODE_MODULE}`, fromModule);
  each(`\\{(?<list>[^{}]*)\\}${ASSIGN}${LOAD}\\s*\\(\\s*${NODE_MODULE}\\s*\\)`, fromModule);
  each(`import\\s+(?:\\*\\s*as\\s+)?(?<local>${JS_ID})\\s+from\\s*${NODE_MODULE}`, wholeModule);
  each(`(?<![\\w$])(?<local>${JS_ID})${ASSIGN}${LOAD}\\s*\\(\\s*${NODE_MODULE}\\s*\\)`, wholeModule);
  // 别名可以一层套一层，转到不再多出新的为止
  while (true) {
    const before = objects.size + functions.size;
    each(`\\{(?<list>[^{}]*)\\}${ASSIGN}${HOSTS}${WHOLE}`, (m) => { for (const [name, local] of bindings(m.groups.list)) if (Object.hasOwn(JS_MEMBERS, name)) objects.set(local, name); });
    for (const [local, object] of [...objects]) {
      const ref = `(?:${HOSTS}\\s*\\.\\s*)?${lit(local)}`;
      each(`(?<![\\w$])(?<to>${JS_ID})${ASSIGN}${ref}${WHOLE}`, (m) => objects.set(m.groups.to, object));
      each(`\\{(?<list>[^{}]*)\\}${ASSIGN}${ref}${WHOLE}`, (m) => { for (const [name, to] of bindings(m.groups.list)) bindMember(object, name, to, m.index); });
      for (const [prop, kind] of Object.entries(JS_MEMBERS[object])) {
        each(`(?<![\\w$])(?<to>${JS_ID})${ASSIGN}${memberSource(local, prop)}(?!\\s*\\()`, (m) => functions.set(m.groups.to, { kind, call: `${object}.${prop}` }));
      }
    }
    if (objects.size + functions.size === before) break;
  }
  for (const [local, object] of objects) {
    for (const [prop, kind] of Object.entries(JS_MEMBERS[object])) each(memberSource(local, prop), (m) => hit(kind, `${object}.${prop}`, m.index));
    if (object !== DATE) continue;
    // 不带参数构造（省掉括号也算）、不带 new 直接调用，读的都是当前时刻
    each(`\\bnew\\s+${lit(local)}(?![\\w$])(?!\\s*\\(\\s*[^)\\s])`, (m) => hit(WALL, `new ${DATE}`, m.index));
    each(`(?<!\\bnew\\s+)(?<![.\\w$])${lit(local)}\\s*\\(`, (m) => hit(WALL, `${DATE}()`, m.index));
  }
  for (const [local, f] of functions) {
    each(`(?<!\\bfunction\\s+)(?<![.\\w$])${lit(local)}\\s*(?:\\?\\.\\s*)?(?:\\.\\s*(?:call|apply)\\s*)?\\(`, (m) => hit(f.kind, f.call, m.index));
  }
  each(`\\b${TIME}\\s*\\.\\s*${TIME}\\s*\\(`, (m) => hit(WALL, `${TIME}.${TIME}`, m.index));
  return [...found.values()];
}

// Python 随机模块的模块级函数：共享一个全局状态，调了就不是带种子的命名流
const PY_FNS = [RANDOM, 'randint', 'randrange', 'uniform', 'choice', 'choices', 'shuffle', 'sample', 'gauss', 'normalvariate', 'getrandbits', 'triangular', 'betavariate', 'expovariate', 'randbytes', 'binomialvariate', 'gammavariate', 'lognormvariate', 'vonmisesvariate', 'paretovariate', 'weibullvariate'];
const PY_MONOTONIC = ['monotonic', 'monotonic_ns', 'perf_counter', 'perf_counter_ns'];
const PY_CLOCKS = [TIME, 'time_ns', ...PY_MONOTONIC];
const HOST_CLOCKS = new Set([MONOTONIC_CLOCK, ...PY_MONOTONIC.map((name) => `${TIME}.${name}`)]);
const PY_START = '(?:^|;)[ \\t]*';
const PY_NO_SEED = '\\(\\s*(?:(?:x\\s*=\\s*)?None\\s*,?\\s*)?\\)';

/**
 * Python 的命中 [{ kind, call, index }]。先认导入再按本地名找：
 *   import 模块 as 别名、from 模块 import 名字 [as 别名]（含括号里换行的清单和 *）；
 *   随机模块的模块级函数（取到就算，不必当场调用）、不带种子造的 Random 实例、SystemRandom（一律算）、时间模块读当前时刻。
 * 带显式种子的 Random(种子) 实例放过。call 一律写规范名（模块名.函数名）。
 */
function scanPy(text) {
  const found = new Map();
  const hit = (kind, call, index) => found.set(`${call}@${index}`, { kind, call, index });
  const each = (source, fn) => { for (const m of text.matchAll(new RegExp(source, 'gm'))) fn(m); };
  const randomModules = new Set([RANDOM]), timeModules = new Set([TIME]);
  const functions = new Map(), classes = new Map();
  each(`${PY_START}import[ \\t]+(?<list>[^\\n;#]+)`, (m) => {
    for (const part of m.groups.list.split(',')) {
      const [mod, as, local] = part.trim().split(/\s+/);
      if (as !== undefined && as !== 'as') continue;
      if (mod === RANDOM) randomModules.add(local ?? mod);
      if (mod === TIME) timeModules.add(local ?? mod);
    }
  });
  each(`${PY_START}from[ \\t]+(?<mod>${RANDOM}|${TIME})[ \\t]+import[ \\t]*(?<list>\\([^)]*\\)|[^\\n;#]+)`, (m) => {
    const listed = m.groups.list.replace(/[()]/g, ' ').split(',').map((p) => p.trim().split(/\s+/)).filter((p) => p[0]);
    const everything = m.groups.mod === RANDOM ? [...PY_FNS, 'Random', 'SystemRandom'] : PY_CLOCKS;
    const pairs = listed.some((p) => p[0] === '*') ? everything.map((n) => [n, n]) : listed.map((p) => [p[0], p[1] === 'as' && p[2] ? p[2] : p[0]]);
    for (const [name, local] of pairs) {
      if (m.groups.mod === TIME) { if (PY_CLOCKS.includes(name)) functions.set(local, { kind: WALL, call: `${TIME}.${name}` }); continue; }
      if (PY_FNS.includes(name)) functions.set(local, { kind: RAND, call: `${RANDOM}.${name}` });
      else if (name === 'Random' || name === 'SystemRandom') classes.set(local, name);
    }
  });
  for (const mod of randomModules) {
    const head = `(?<![\\w.])${lit(mod)}\\s*\\.\\s*`;
    for (const fn of PY_FNS) each(`${head}${fn}\\b`, (m) => hit(RAND, `${RANDOM}.${fn}`, m.index));
    each(`${head}SystemRandom\\b`, (m) => hit(RAND, `${RANDOM}.SystemRandom`, m.index));
    each(`${head}Random\\s*${PY_NO_SEED}`, (m) => hit(RAND, `${RANDOM}.Random()`, m.index));
  }
  for (const mod of timeModules) {
    for (const fn of PY_CLOCKS) each(`(?<![\\w.])${lit(mod)}\\s*\\.\\s*${fn}\\b`, (m) => hit(WALL, `${TIME}.${fn}`, m.index));
  }
  for (const [local, f] of functions) each(`(?<!\\bdef\\s+)(?<![\\w.])${lit(local)}\\s*\\(`, (m) => hit(f.kind, f.call, m.index));
  for (const [local, cls] of classes) {
    if (cls === 'Random') each(`(?<!\\bclass\\s+)(?<![\\w.])${lit(local)}\\s*${PY_NO_SEED}`, (m) => hit(RAND, `${RANDOM}.Random()`, m.index));
    else each(`(?<!\\bclass\\s+)(?<![\\w.])${lit(local)}\\s*\\(`, (m) => hit(RAND, `${RANDOM}.SystemRandom`, m.index));
  }
  return [...found.values()];
}

/** 一段源码的命中 [{ kind: 'wallClock' | 'unseededRandom', call, line }]，按出现的先后排；行号从 1 起。JS 的规则每个文件都扫，.py 文件再加 Python 的规则 */
export function scanSource(path, text) {
  if (typeof text !== 'string') throw new TypeError(`${path} 的源码必须是字符串`);
  const merged = new Map();
  for (const h of [...scanJs(text), ...(/\.py$/i.test(String(path)) ? scanPy(text) : [])]) merged.set(`${h.call}@${h.index}`, h);
  return [...merged.values()]
    .sort((a, b) => a.index - b.index || (a.call < b.call ? -1 : a.call > b.call ? 1 : 0))
    .map(({ kind, call, index }) => ({ kind, call, line: text.slice(0, index).split('\n').length }));
}

/**
 * 扫一组源码文件 { 相对路径: 源码 }。
 * options.scope：'shot'（默认，镜头文件）或 'host'（宿主文件）。豁免 allowed [{ path, call, line? }] 只在一种情形生效（时间键契约 5.3）：
 * 宿主文件里读单调时钟（JS 的 MONOTONIC_CLOCK 或 Python 的 monotonic、perf_counter 及其纳秒版本），写了 line 的只豁免那一行。镜头文件一律不豁免；不带种子的随机在哪儿都不豁免。
 * 返回 { files, wallClock, unseededRandom, allowed }，每项 { path, call, line }。
 */
export function scanShot(files, allowed = [], options = {}) {
  if (!isObj(files)) throw new TypeError('files 必须是 { 相对路径: 源码 }');
  const scope = options?.scope ?? 'shot';
  if (scope !== 'shot' && scope !== 'host') throw new Error(`scope 只收 shot、host，收到 ${scope}`);
  const rules = Array.isArray(allowed) ? allowed.filter(isObj) : [];
  const out = { files: Object.keys(files).sort(), wallClock: [], unseededRandom: [], allowed: [] };
  for (const path of out.files) {
    for (const h of scanSource(path, files[path])) {
      const exempt = scope === 'host' && h.kind === WALL && HOST_CLOCKS.has(h.call)
        && rules.some((a) => a.path === path && a.call === h.call && (a.line === undefined || a.line === h.line));
      out[exempt ? 'allowed' : h.kind].push({ path, call: h.call, line: h.line });
    }
  }
  return out;
}

/* ---------------- 成本 ---------------- */

// 每百万像素、每个采样的显卡秒数。粗估用的系数，没有实测出处，只用来排先后、挡住明显过大的作业
export const GPU_SECONDS_PER_MEGAPIXEL_SAMPLE = 0.002;

/** 终渲档的成本粗估：frames 是总帧数（帧），estimatedGpuSeconds 是显卡秒数（秒）。片子描述不成形的部分按 0 帧、缺省采样算 */
export function estimateCost(film) {
  const size = film?.output?.size;
  const [w, h] = Array.isArray(size) && size.length === 2 && size.every((x) => isInt(x) && x > 0) ? size : [0, 0];
  const perShot = objectsIn(film?.shots).map((s) => {
    const frames = isInt(s.in) && isInt(s.out) ? Math.max(0, s.out - s.in) : 0;
    const tier = isObj(s.tiers) && isObj(s.tiers.final) ? s.tiers.final : {};
    const scale = typeof tier.scale === 'number' && tier.scale > 0 && tier.scale <= 1 ? tier.scale : 1;
    const pixelSamples = isInt(tier.samples) && tier.samples >= 1 ? tier.samples : 1;
    const shutter = isObj(s.shutter) ? s.shutter : {};
    const subSamples = shutter.angleDeg > 0 && isInt(shutter.samples) && shutter.samples >= 1 ? shutter.samples : 1;
    const megapixels = Math.round(w * scale) * Math.round(h * scale) / 1e6;
    return { shot: s.id, frames, estimatedGpuSeconds: frames * megapixels * pixelSamples * subSamples * GPU_SECONDS_PER_MEGAPIXEL_SAMPLE };
  });
  return {
    frames: perShot.reduce((a, s) => a + s.frames, 0),
    estimatedGpuSeconds: perShot.reduce((a, s) => a + s.estimatedGpuSeconds, 0),
    perShot,
  };
}

/* ---------------- 入口 ---------------- */

const isLimited = (shot) => { const src = shot.renderer?.source ?? shot.source; return src === 'legacy-page' || isExt(src); };

function runChecks(film, shotSources, allowed) {
  const cx = { diags: [] };
  const scan = {};
  FILM(film, ROOT, cx);
  if (!isObj(film)) return { diags: cx.diags, scan };
  crossChecks(film, cx);
  if (!isObj(shotSources)) { err(cx, 'usage.bad-argument', ROOT, 'options.shotSources 必须是 { 镜头 id: { 相对路径: 源码 } }'); return { diags: cx.diags, scan }; }
  if (Array.isArray(allowed) ? allowed.length > 0 : allowed !== undefined && allowed !== null) {
    diag(cx, 'warning', 'l1.allowance-refused', ROOT, '镜头文件不收豁免：options.allowed 没有生效，扫到的墙钟和不带种子的随机照报', { hint: '豁免只给宿主文件里读单调时钟量耗时的那一处，用 scanShot(files, allowed, { scope: "host" })' });
  }
  for (const shotId of Object.keys(shotSources).sort()) {
    const shot = objectsIn(film.shots).find((s) => s.id === shotId);
    const files = shotSources[shotId];
    if (!shot || !shotIdOk(shotId)) { err(cx, 'usage.bad-argument', ROOT, `options.shotSources 的 ${show(shotId)} 不是片子里的镜头，源码没有扫`); continue; }
    const w = at(`shots/${shotId}`);
    if (!isObj(files) || !Object.values(files).every((t) => typeof t === 'string')) { err(cx, 'usage.bad-argument', w, `options.shotSources 里镜头 ${shotId} 的源码必须是 { 相对路径: 源码字符串 }`); continue; }
    if (isLimited(shot)) { // 合规档 limited 的第三方作品源码不静态扫，改判纯函数门（时间键契约 5.3）
      diag(cx, 'warning', 'l1.scan-skipped', w, `镜头 ${shotId} 是 limited 合规档，源码不扫，改判 L2 纯函数门`);
      continue;
    }
    const r = scanShot(files, [], { scope: 'shot' });
    scan[shotId] = r;
    for (const h of r.wallClock) err(cx, 'l1.wall-clock', w, `镜头 ${shotId} 的 ${h.path} 第 ${h.line} 行读墙钟 ${h.call}`, { hint: '时间只从帧号算；镜头代码里不读时钟' });
    for (const h of r.unseededRandom) err(cx, 'l1.unseeded-random', w, `镜头 ${shotId} 的 ${h.path} 第 ${h.line} 行用不带种子的随机 ${h.call}`, { hint: '改用 ctx.rng 的命名随机流' });
  }
  return { diags: cx.diags, scan };
}

/**
 * L1 写入即检。film 不是对象、里面有 null 之类不成形的输入，都转成诊断，不抛异常。
 * options：shotSources { 镜头 id: { 相对路径: 源码 } }；applyFixes 'none' | 'machine'；rev 读到的修订号（整数，默认 0）。
 * 镜头文件不收豁免：传了 options.allowed 只会多一条 warning，命中照报。
 * 返回 { ok, diagnostics, fixes, applied, film, rev, scan, cost }：
 *   diagnostics 每条 { code, layer: 'L1', severity: 'error' | 'warning', at?, message, hint?, fix? }，at 是照 5.4 写的路径，指不到具体路径时不写；
 *   fixes 是诊断里带的全部修法，每条都合补丁契约的修法形状（rename 只带 to；数组用 set 整个换）；
 *   applyFixes 是 'machine' 时 film 是作用了机器修法的副本、diagnostics 是作用之后重查的结果，作用了至少一条 rev 加 1。
 */
export function checkL1(film, options = {}) {
  const { shotSources = {}, applyFixes = 'none', allowed, rev = 0 } = isObj(options) ? options : {};
  let current = film;
  let { diags, scan } = runChecks(current, shotSources, allowed);
  const fixes = diags.filter((d) => d.fix).map((d) => d.fix);
  const applied = [];
  if (applyFixes === 'machine' && isObj(film) && fixes.some((f) => f.applicability === 'machine')) {
    current = structuredClone(film);
    for (const f of fixes) if (applyFix(current, f)) applied.push(f);
    if (applied.length) ({ diags, scan } = runChecks(current, shotSources, allowed));
    else current = film;
  }
  const usage = [];
  if (applyFixes !== 'none' && applyFixes !== 'machine') usage.push({ code: 'usage.bad-argument', layer: 'L1', severity: 'error', message: `options.applyFixes 只收 none、machine，收到 ${show(applyFixes)}` });
  if (!isInt(rev)) usage.push({ code: 'usage.bad-argument', layer: 'L1', severity: 'error', message: `options.rev 必须是整数，收到 ${show(rev)}` });
  const diagnostics = [...diags, ...usage];
  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics,
    fixes,
    applied,
    film: current,
    rev: applied.length && isInt(rev) ? rev + 1 : rev,
    scan,
    cost: estimateCost(current),
  };
}
