// 每帧元数据契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// M1、M3、M9 判元数据核对记录（meta-check/0.1），其余判每帧元数据（meta/0.1）。
// 不归这条管的对象、记录里没出现的段一律返回空数组。

const HOST_FIVE = ['camera', 'entities', 'lights', 'stats', 'timing'];
const SHOT_PATHS = ['entities.*.anchors', 'texts', 'readings'];
const NULLABLE = new Set(['entities.*.visible', 'stats', 'hash.color', 'camera', 'entities', 'stats.noise', 'stats.tris', 'texts', 'lights']);
const WAIVED = new Set(['camera', 'entities']);
// 交每帧元数据的帧源里合规档是 limited 的只有它；ext.<名字> 不交每帧元数据（帧源接口契约 3.5）
const LIMITED_SOURCE = 'legacy-page';
// 帧源名，出处是帧源接口契约 3.1；和结构定义里 source.id、source.renderer 的模式相同
const SOURCE_NAME = /^(blender|three|core|legacy-page|ext\.[a-z0-9][a-z0-9-]*)$/;

/** 找出对象里每一个 null 的路径，数组下标写成 *；顶层 ext 不算 */
function nullPaths(node, path, out) {
  if (node === null) out.push(path);
  else if (Array.isArray(node)) node.forEach((v) => nullPaths(v, `${path}.*`, out));
  else if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (path === '' && k === 'ext') continue;
      nullPaths(v, path === '' ? k : `${path}.${k}`, out);
    }
  }
  return out;
}

const on = (format, fn) => (obj) => (obj?.format === format ? fn(obj) : []);

const checks = {
  M1: on('meta-check/0.1', (rec) => (rec.renders ?? []).flatMap((r) => [
    ...(r.metas === 1 ? [] : [`第 ${r.call} 次 render 交回了 ${r.metas} 份元数据`]),
    ...(r.colorCall === undefined || r.colorCall === r.call ? [] : [`第 ${r.call} 次 render 落盘的颜色层出自第 ${r.colorCall} 次调用`]),
  ])),

  M2: on('meta/0.1', (m) => {
    const o = m.origin ?? {};
    const host = new Set((o.host ?? []).filter((p) => p !== 'source'));
    const out = [];
    if (host.size !== HOST_FIVE.length || !HOST_FIVE.every((p) => host.has(p))) out.push(`origin.host 去掉 source 之后是 ${JSON.stringify([...host])}，不是这五项：${HOST_FIVE.join('、')}`);
    for (const p of o.shot ?? []) if (!SHOT_PATHS.includes(p)) out.push(`origin.shot 列了 ${p}，镜头代码只能写 ${SHOT_PATHS.join('、')}`);
    for (const p of o.kernel ?? []) if (p !== 'events') out.push(`origin.kernel 列了 ${p}，只能是 events`);
    return out;
  }),

  M3: on('meta-check/0.1', (rec) => (rec.renders ?? [])
    .filter((r) => r.metaBytes > 65536)
    .map((r) => `第 ${r.call} 次 render 的元数据有 ${r.metaBytes} 字节，超过 65536`)),

  // 可以声明类（stats.noise、stats.tris、texts、lights）的那一半不在这里判：元数据里没有出帧者的能力声明，见契约第 6 节
  M4: on('meta/0.1', (m) => nullPaths(m, '', []).flatMap((p) => {
    if (!NULLABLE.has(p)) return [`${p} 是 null，它不在可以是 null 的字段表里`];
    if (WAIVED.has(p) && m.source?.renderer !== LIMITED_SOURCE) return [`${p} 是 null，只有 legacy-page 交的每帧元数据可以这样，出帧者是 ${m.source?.renderer}`];
    return [];
  })),

  M5: on('meta/0.1', (m) => [
    ...(SOURCE_NAME.test(m.source?.renderer) ? [] : [`source.renderer 是 ${JSON.stringify(m.source?.renderer)}，不是帧源名`]),
    ...((m.origin?.host ?? []).includes('source') ? [] : ['origin.host 里没有 source']),
  ]),

  M6: on('meta/0.1', (m) => {
    const noColor = m.hash?.color === null;
    const out = [];
    if (noColor !== (m.stats === null)) out.push(`hash.color ${noColor ? '是' : '不是'} null，stats 却${m.stats === null ? '是' : '不是'} null`);
    if (noColor) for (const e of m.entities ?? []) if (e.visible !== null) out.push(`没出像素，实体 ${e.name} 的 visible 却是 ${e.visible}`);
    return out;
  }),

  M7: on('meta/0.1', (m) => (m.entities ?? [])
    .filter((e) => e.visible !== null && e.role === undefined)
    .map((e) => `实体 ${e.name} 没有 role，visible 却是 ${e.visible}`)),

  M8: on('meta/0.1', (m) => {
    const ents = m.entities ?? [];
    const dup = (key) => [...new Set(ents.map((e) => e[key]).filter((v, i, a) => a.indexOf(v) !== i))];
    return [
      ...ents.filter((e) => !(e.id >= 1)).map((e) => `实体 ${e.name} 的编号是 ${e.id}，必须 ≥ 1`),
      ...dup('id').map((id) => `实体编号 ${id} 重复`),
      ...dup('name').map((n) => `实体名 ${n} 重复`),
    ];
  }),

  M9: on('meta-check/0.1', (rec) => {
    const calls = (rec.renders ?? []).map((r) => r.call);
    return [...new Set(calls.filter((c, i) => calls.indexOf(c) !== i))].map((c) => `call ${c} 出现了不止一次`);
  }),
};

export { checks };
