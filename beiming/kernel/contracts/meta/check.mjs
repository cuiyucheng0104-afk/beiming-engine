// 每帧元数据契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// M1、M3、M9、M11、M12、M13、M14、M17、M18、M19、M20 判元数据核对记录（meta-check/0.1），其余判每帧元数据（meta/0.1）。
// 不归这条管的对象、记录里没出现的段一律返回空数组。

const HOST_FIVE = ['camera', 'entities', 'lights', 'stats', 'timing'];
const SHOT_PATHS = ['entities.*.anchors', 'texts', 'readings'];
const NULLABLE = new Set(['entities.*.visible', 'stats', 'hash.color', 'camera', 'entities', 'stats.noise', 'stats.tris', 'texts', 'lights']);
const WAIVED = new Set(['camera', 'entities']);
// 交每帧元数据的帧源里合规档是 limited 的只有它；ext.<名字> 不交每帧元数据（帧源接口契约 3.5）
const LIMITED_SOURCE = 'legacy-page';
const CLIP = ['clipHigh', 'clipLow'];
// 容差的出处是契约 5.1（proj 四个数对算式的相对差）和 5.4（pxArea 对算式的绝对差）
const PROJ_REL_TOL = 1e-12;
const PX_AREA_TOL = 1e-12;

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
    ...(r.colorFileHash === undefined || r.metaHashColor === r.colorFileHash ? [] : [`第 ${r.call} 次 render 的元数据 hash.color 是 ${r.metaHashColor ?? 'null'}，交回的颜色层文件重算出的哈希是 ${r.colorFileHash}`]),
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

  // source.renderer 必填、是帧源名那一半只由结构定义判（契约 M5「怎么查」）
  M5: on('meta/0.1', (m) => ((m.origin?.host ?? []).includes('source') ? [] : ['origin.host 里没有 source'])),

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

  M10: on('meta/0.1', (m) => {
    if (m.stats === null || m.stats === undefined) return [];
    const want = m.colorRef === 'display';
    return CLIP.filter((k) => (m.stats[k] !== undefined) !== want)
      .map((k) => `colorRef 是 ${m.colorRef}，stats.${k} ${want ? '没出现' : '出现了'}`);
  }),

  M11: on('meta-check/0.1', (rec) => (rec.renders ?? []).filter((r) => r.metaShotFrame !== undefined).flatMap((r) => [
    ...(r.metaShotFrame === r.shotFrame ? [] : [`第 ${r.call} 次 render 请求的是局部第 ${r.shotFrame} 帧，元数据的 shotFrame 是 ${r.metaShotFrame}`]),
    ...(r.metaFrame === r.metaShotFrame + rec.start ? [] : [`第 ${r.call} 次 render 的元数据 frame 是 ${r.metaFrame}，shotFrame ${r.metaShotFrame} 加起始帧 ${rec.start} 应该是 ${r.metaShotFrame + rec.start}`]),
  ])),

  M12: on('meta-check/0.1', (rec) => (rec.renders ?? [])
    .filter((r) => r.metaSeed !== undefined && r.metaSeed !== rec.seed)
    .map((r) => `第 ${r.call} 次 render 的元数据 seed 是 ${r.metaSeed}，这个镜头生效的镜头种子是 ${rec.seed}`)),

  // colorShape 是 [高, 宽, 分量数]，metaSize 是 [宽, 高]；不乘缩放、不取整
  M13: on('meta-check/0.1', (rec) => (rec.renders ?? []).filter((r) => r.metaSize !== undefined && r.colorShape !== undefined).flatMap((r) => [
    ...(r.metaSize[0] === r.colorShape[1] ? [] : [`第 ${r.call} 次 render 的元数据 size 的宽是 ${r.metaSize[0]}，交回的颜色层宽 ${r.colorShape[1]}`]),
    ...(r.metaSize[1] === r.colorShape[0] ? [] : [`第 ${r.call} 次 render 的元数据 size 的高是 ${r.metaSize[1]}，交回的颜色层高 ${r.colorShape[0]}`]),
  ])),

  M14: on('meta-check/0.1', (rec) => (rec.renders ?? [])
    .filter((r) => r.metaTier !== undefined && r.metaTier !== r.tier)
    .map((r) => `第 ${r.call} 次 render 所在的会话档位是 ${r.tier}，元数据的 source.tier 是 ${r.metaTier}`)),

  // proj 是列主序；第 1 个数对的是写出来的第 6 个数，不是算式里的那个（契约 5.1）
  M15: on('meta/0.1', (m) => {
    const c = m.camera;
    if (c === null || c === undefined) return [];
    const [w, h] = m.size;
    return [
      [1, (c.proj[5] * h) / w, '第 6 个数乘以高再除以宽'],
      [6, 1 / Math.tan((c.fovYDeg * Math.PI) / 360), '1 ÷ tan(fovYDeg ÷ 2)'],
      [11, -(c.far + c.near) / (c.far - c.near), '−(far + near) ÷ (far − near)'],
      [15, (-2 * c.far * c.near) / (c.far - c.near), '−2 × far × near ÷ (far − near)'],
    ].filter(([n, want]) => !(Number.isFinite(want) && Math.abs(c.proj[n - 1] - want) <= PROJ_REL_TOL * Math.abs(want)))
      .map(([n, want, how]) => `camera.proj 的第 ${n} 个数是 ${c.proj[n - 1]}，照「${how}」算出来是 ${want}`);
  }),

  M16: on('meta/0.1', (m) => {
    const [w, h] = m.size;
    return (m.entities ?? []).flatMap((e) => {
      const [x0, y0, x1, y1] = e.bbox2d;
      const want = (Math.max(0, Math.min(x1, w) - Math.max(x0, 0)) * Math.max(0, Math.min(y1, h) - Math.max(y0, 0))) / (w * h);
      return Math.abs(e.pxArea - want) <= PX_AREA_TOL ? [] : [`实体 ${e.name} 的 pxArea 是 ${e.pxArea}，bbox2d 和画面求交的面积除以宽乘高是 ${want}`];
    });
  }),

  M17: on('meta-check/0.1', (rec) => (rec.renders ?? [])
    .filter((r) => r.metaSourceId !== undefined && r.metaSourceId !== rec.source)
    .map((r) => `第 ${r.call} 次 render 的元数据 source.id 是 ${r.metaSourceId}，镜头条目顶层的 source 是 ${rec.source}`)),

  M18: on('meta-check/0.1', (rec) => (rec.renders ?? [])
    .filter((r) => r.metaFilm !== undefined && r.metaFilm !== rec.film)
    .map((r) => `第 ${r.call} 次 render 的元数据 film 是 ${r.metaFilm}，片子描述的 id 是 ${rec.film}`)),

  M19: on('meta-check/0.1', (rec) => (rec.renders ?? [])
    .filter((r) => r.metaShot !== undefined && r.metaShot !== rec.shot)
    .map((r) => `第 ${r.call} 次 render 的元数据 shot 是 ${r.metaShot}，请求的镜头是 ${rec.shot}`)),

  // 帧率的写法是最简分数（时间键契约 3.2），所以逐字符比就是比数值
  M20: on('meta-check/0.1', (rec) => (rec.renders ?? [])
    .filter((r) => r.metaFps !== undefined && r.metaFps !== rec.fps)
    .map((r) => `第 ${r.call} 次 render 的元数据 fps 是 ${r.metaFps}，片子描述的 output.fps 是 ${rec.fps}`)),
};

export { checks };
