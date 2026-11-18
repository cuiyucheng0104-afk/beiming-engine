// 帧源接口契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// F4、F10、F15 收单独的能力声明（caps/0.1）和核对记录（source-check/0.1）里的 caps，其余各条只收核对记录。
// 记录里没出现的段不判；实体清单、场景查询、镜头输入、层引用这些不带 format 的内嵌值和帧源登记表不归这些条文管，一律返回空数组。

const FULL_IDS = ['blender', 'three', 'core'];
const QUERY_LIMIT = 50;

/** 声明过的输出：outputs 里出现并且取值不是 false；lightgroup:<名> 看 lightgroup:* 这个键 */
const declared = (caps, name) => {
  const key = name.startsWith('lightgroup:') ? 'lightgroup:*' : name;
  return Object.hasOwn(caps.outputs, key) && caps.outputs[key] !== false;
};
const allDeclared = (caps, want) => want.every((n) => declared(caps, n));
const isExt = (caps) => caps.id.startsWith('ext.');
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const at = (r) => `第 ${r.shotFrame} 帧的 render`;
const failedWith = (x, code) => x.status === 'error' && x.code === code;
const outcome = (x) => `${x.status}${x.code ? `（${x.code}）` : ''}`;
/** 镜头条目的 host 和 mode 都在能力声明里 */
const modeDeclared = (caps, o) => caps.hosts.includes(o.host) && caps.modes.includes(o.mode);

const raw = {
  F1: (rec) => (rec.renders ?? []).filter((r) => r.status === 'ok').flatMap((r) => {
    const out = [];
    if (rec.caps.outputs.meta === true && r.meta !== true) out.push(`${at(r)} 成功了却没交回元数据`);
    const expect = r.want.includes('color') ? r.want.filter((n) => n !== 'meta' && declared(rec.caps, n)) : [];
    if (!sameSet(r.layers, expect)) out.push(`${at(r)} 交回的 layers 是 [${r.layers.join(', ')}]，应该是 [${expect.join(', ')}]`);
    return out;
  }),

  F2: (rec) => (rec.renders ?? []).flatMap((r) => [
    ...(r.colorTransfer !== undefined && r.colorTransfer !== 'linear' ? [`${at(r)} 颜色层的 colorTransfer 是 ${r.colorTransfer}`] : []),
    ...(r.colorRef !== undefined && r.colorRef !== r.shotColorRef ? [`${at(r)} 元数据的 colorRef 是 ${r.colorRef}，镜头声明的是 ${r.shotColorRef}`] : []),
  ]),

  F3: (rec) => (rec.renders ?? [])
    .filter((r) => !allDeclared(rec.caps, r.want) && (r.status !== 'error' || r.code !== 'contract.unsupported-output'))
    .map((r) => `${at(r)} 要了没声明过的输出，结果是 ${r.status}${r.code ? `（${r.code}）` : ''}`),

  F5: (rec) => {
    const mb = rec.caps.motionBlur;
    if (mb.mode !== 'native') return [];
    return (rec.renders ?? [])
      .filter((r) => (r.shutterAngleDeg ?? 0) > 0 && allDeclared(rec.caps, r.want) && r.want.some((n) => (mb.conflicts ?? []).includes(n)))
      .filter((r) => r.status !== 'error' || r.code !== 'contract.output-conflict')
      .map((r) => `${at(r)} 开着原生运动模糊要了冲突的输出，结果是 ${r.status}${r.code ? `（${r.code}）` : ''}`);
  },

  F6: (rec) => (rec.failures ?? []).flatMap((x, i) => [
    ...(x.exitCode === undefined || x.exitCode === 0 ? [`failures[${i}]（${x.cause}）的退出码是 ${x.exitCode ?? '没退出'}`] : []),
    ...(x.elapsedMs > x.limitMs ? [`failures[${i}] 过了 ${x.elapsedMs} 毫秒才结束，时限是 ${x.limitMs} 毫秒`] : []),
  ]),

  F8: (rec) => (rec.queries ?? [])
    .filter((q) => !rec.caps.sceneQuery.includes(q.kind) && (q.status !== 'error' || q.code !== 'contract.unsupported-query'))
    .map((q) => `问了没声明的 ${q.kind} 查询，结果是 ${q.status}${q.code ? `（${q.code}）` : ''}`),

  F9: (rec) => (rec.queries ?? []).filter((q) => q.status === 'ok').flatMap((q) => {
    const out = [];
    const expect = Math.min(q.total, QUERY_LIMIT);
    if (q.returned !== expect) out.push(`${q.kind} 查询一共 ${q.total} 项，交回了 ${q.returned} 项，应该是 ${expect}`);
    if (q.total > QUERY_LIMIT ? q.truncated !== q.total - QUERY_LIMIT : q.truncated !== undefined) {
      out.push(`${q.kind} 查询一共 ${q.total} 项，truncated 是 ${q.truncated ?? '不出现'}`);
    }
    return out;
  }),

  F11: (rec) => {
    if (!rec.manifest) return [];
    const ents = rec.manifest.entities;
    const dup = (key) => ents.map((e) => e[key]).filter((v, i, a) => a.indexOf(v) !== i);
    return [
      ...dup('id').map((v) => `实体清单里编号 ${v} 重复`),
      ...dup('name').map((v) => `实体清单里名字 ${v} 重复`),
      ...(rec.metaEntities ?? []).flatMap((m) => m.entities
        .filter((e) => !ents.some((x) => x.id === e.id && x.name === e.name && x.class === e.class))
        .map((e) => `第 ${m.shotFrame} 帧元数据里的实体 ${e.name}（${e.id}，${e.class}）和实体清单对不上`)),
    ];
  },

  F12: (rec) => (rec.renders ?? [])
    .filter((r) => r.metaShutterAngleDeg !== undefined && r.metaShutterAngleDeg !== (r.shutterAngleDeg ?? 0))
    .map((r) => `${at(r)} 元数据的快门角是 ${r.metaShutterAngleDeg}，生效的是 ${r.shutterAngleDeg ?? 0}`),

  F13: (rec) => (rec.renders ?? [])
    .filter((r) => (r.shutterAngleDeg ?? 0) === 0 && r.shutterSamples > 1 && allDeclared(rec.caps, r.want))
    .filter((r) => r.status !== 'error' || r.code !== 'contract.shutter-conflict')
    .map((r) => `${at(r)} 快门角 0、子帧采样 ${r.shutterSamples}，结果是 ${r.status}${r.code ? `（${r.code}）` : ''}`),

  // host 或 mode 不在能力声明里的 open 归 F16
  F14: (rec) => (rec.opens ?? [])
    .filter((o) => !o.hasLock && modeDeclared(rec.caps, o) && (!o.hasSeed || o.usesCards || o.usesAssets))
    .filter((o) => !failedWith(o, 'env.lock-required'))
    .map((o) => `没有锁的 open（${o.hasSeed ? '' : '镜头没写种子'}${o.usesCards ? ' 用了卡' : ''}${o.usesAssets ? ' 用了资产' : ''}），结果是 ${outcome(o)}`),

  F16: (rec) => (rec.opens ?? [])
    .filter((o) => !modeDeclared(rec.caps, o) && !failedWith(o, 'contract.unsupported-mode'))
    .map((o) => `open 的宿主 ${o.host}、作者模式 ${o.mode} 不全在能力声明里，结果是 ${outcome(o)}`),

  F17: (rec) => (rec.renders ?? []).flatMap((r) => (r.layerRefs ?? []).flatMap((l) => [
    ...(l.sha256 !== l.fileSha256 ? [`${at(r)} 的 ${l.output} 层引用写的哈希不是层文件内容的哈希`] : []),
    ...(r.size && (l.shape[0] !== r.size[1] || l.shape[1] !== r.size[0])
      ? [`${at(r)} 的 ${l.output} 层引用的 shape 是 [${l.shape.join(', ')}]，这次输出是宽 ${r.size[0]}、高 ${r.size[1]}`] : []),
  ])),

  F18: (rec) => (rec.renders ?? [])
    .filter((r) => (r.unsupportedOpts ?? []).length > 0 && allDeclared(rec.caps, r.want) && !failedWith(r, 'contract.unsupported-option'))
    .map((r) => `${at(r)} 要了帧源交不出的 ${r.unsupportedOpts.join('、')}，结果是 ${outcome(r)}`),

  F19: (rec) => (rec.renders ?? [])
    .filter((r) => (r.unfitOutputs ?? []).some((n) => r.want.includes(n)) && allDeclared(rec.caps, r.want) && !failedWith(r, 'contract.unsupported-object'))
    .map((r) => `${at(r)} 的场景里有对象放不进要的输出，结果是 ${outcome(r)}`),
};

const onRecord = (fn) => (obj) => (obj?.format === 'source-check/0.1' ? fn(obj) : []);
/** 单独的能力声明，或核对记录里的 caps；别的对象是 null */
const capsOf = (obj) => (obj?.format === 'caps/0.1' ? obj : obj?.format === 'source-check/0.1' ? obj.caps : null);

// ext.<名字> 按 3.5 整条免掉；randomAccess 一半两种对象都判，digest 一半只有核对记录有。
// 容差档的几句现在是对帧源的要求，记录里没有判它们要用的量，这里只查 randomAccess（见 5.4）
const F4 = (obj) => {
  const caps = capsOf(obj);
  if (!caps || isExt(caps)) return [];
  const out = caps.randomAccess === true ? [] : [`能力声明的 randomAccess 是 ${caps.randomAccess}`];
  if (caps.determinism !== 'hash-same-machine') return out;
  const byFrame = new Map();
  for (const o of obj.orderRuns ?? []) byFrame.set(o.shotFrame, (byFrame.get(o.shotFrame) ?? new Set()).add(o.digest));
  for (const [f, digests] of byFrame) if (digests.size > 1) out.push(`哈希档的帧源，第 ${f} 帧各种渲法的 digest 不相同`);
  return out;
};

const F10 = (obj) => {
  const caps = capsOf(obj);
  if (!caps) return [];
  const want = FULL_IDS.includes(caps.id) ? 'full' : 'limited';
  return caps.conformance === want ? [] : [`帧源 ${caps.id} 的合规档是 ${caps.conformance}，应该是 ${want}`];
};

// 登记表（registries.source，本目录的 source.json）是上限；逐字段的「之内」见 3.4。登记表里没有的帧源不查
const F15 = (obj, { registries }) => {
  const caps = capsOf(obj);
  const all = registries.source.sources;
  if (!caps || !Object.hasOwn(all, caps.id)) return [];
  const reg = all[caps.id];
  const out = [];
  for (const key of ['hosts', 'modes', 'sceneQuery']) {
    for (const v of caps[key]) if (!reg[key].includes(v)) out.push(`能力声明的 ${key} 里有 ${v}，登记表里 ${caps.id} 没有`);
  }
  for (const [name, v] of Object.entries(caps.outputs)) {
    if (name === 'meta' || v === false) continue;
    const type = Object.hasOwn(reg.outputs, name) ? reg.outputs[name] : false;
    if (type === false) out.push(`能力声明声明了输出 ${name}，登记表里 ${caps.id} 交不出它`);
    else if (v.type !== type) out.push(`输出 ${name} 的 type 是 ${v.type}，登记表是 ${type}`);
  }
  if (caps.motionBlur.mode !== reg.motionBlur.mode) out.push(`motionBlur.mode 是 ${caps.motionBlur.mode}，登记表是 ${reg.motionBlur.mode}`);
  if (reg.determinism !== undefined && caps.determinism !== reg.determinism) out.push(`determinism 是 ${caps.determinism}，登记表是 ${reg.determinism}`);
  return out;
};

export const checks = {
  ...Object.fromEntries(Object.entries(raw).map(([id, fn]) => [id, onRecord(fn)])),
  F4,
  F10,
  F15,
};
