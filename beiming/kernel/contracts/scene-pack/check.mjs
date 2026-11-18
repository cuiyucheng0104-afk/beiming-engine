// 场景包契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是场景包清单（scene-pack/0.1）或场景包核对记录（scene-pack-check/0.1）。只看清单就能判的条文对单独的清单也照判；
// 要观测数据的条文只认核对记录。记录里没出现的段不判，内嵌值一律返回空数组。

const NODES = new Set(['bevel', 'ao', 'smoothstep', 'mix']);
const WIDTH = { mat16: 16, fovY: 1, focusDist: 1, fstop: 1, watts: 1 };

const packOf = (obj) => (obj?.format === 'scene-pack/0.1' ? obj : obj?.format === 'scene-pack-check/0.1' ? obj.pack : null);
const onPack = (fn) => (obj) => { const p = packOf(obj); return p ? fn(p, obj) : []; };
const onRecord = (fn) => (obj) => (obj?.format === 'scene-pack-check/0.1' ? fn(obj, obj.pack) : []);

/** 5.4 的左上 3×3 行列式，m1 到 m16 对应下标 0 到 15 */
const det3 = (m) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** 场景包清单里全部名叫 file 的字段的值 */
function fileRefs(node, out) {
  if (Array.isArray(node)) node.forEach((v) => fileRefs(v, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'file' && typeof v === 'string') out.push(v);
      else fileRefs(v, out);
    }
  }
  return out;
}

/** 一对一：键 a 只能配一个 b。返回配了不止一个 b 的 a */
function manyTo(pairs) {
  const seen = new Map();
  for (const [a, b] of pairs) seen.set(a, (seen.get(a) ?? new Set()).add(b));
  return [...seen].filter(([, bs]) => bs.size > 1).map(([a, bs]) => [a, [...bs]]);
}

/** F 契约 5.5：要么是实体名，要么是「前缀加 .*」，后者不含前缀自己 */
const matches = (pattern, name) => (pattern.endsWith('.*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

export const checks = {
  // 带 dynamic 的包文件集合怎么数待定，现在照「全部 file 字段」数，dynamic[].files 不算在内
  SP1: onRecord((rec, pack) => {
    const out = [];
    if (rec.files) {
      const want = new Set(['pack.json', ...fileRefs(pack, [])]);
      const have = new Set(rec.files.map((f) => f.path));
      for (const p of have) if (!want.has(p)) out.push(`包目录里多了场景包清单没引用的文件：${p}`);
      for (const p of want) if (!have.has(p)) out.push(`场景包清单引用的文件不在包目录里：${p}`);
    }
    for (const k of ['skins', 'animations', 'morphTargets']) {
      if (rec.geometry && rec.geometry[k] !== 0) out.push(`几何文件的 ${k} 是 ${rec.geometry[k]}，必须是 0`);
    }
    return out;
  }),

  SP2: (obj) => {
    const pack = packOf(obj);
    if (!pack) return [];
    const u = pack.units ?? {};
    const out = [];
    if (u.meter !== 1) out.push(`units.meter 是 ${JSON.stringify(u.meter)}，必须是 1`);
    if (u.up !== 'Y') out.push(`units.up 是 ${JSON.stringify(u.up)}，必须是 "Y"`);
    if (u.hand !== 'right') out.push(`units.hand 是 ${JSON.stringify(u.hand)}，必须是 "right"`);
    if (obj.format === 'scene-pack-check/0.1') {
      for (const l of obj.exportLights ?? []) {
        if (l.packWatts !== l.sourceWatts) out.push(`灯 ${l.name} 导出后功率是 ${l.packWatts} 瓦，源场景是 ${l.sourceWatts} 瓦`);
      }
    }
    return out;
  },

  SP3: onRecord((rec) => (rec.tables?.frameInstances ?? []).flatMap((fi) => {
    const d = det3(fi.mat16);
    const flag = rec.tables.instances?.[fi.row]?.[3];
    const want = d < 0 ? 1 : 0;
    if (flag === undefined) return []; // 实例表这一段没出现，或者没有这一行：不判
    return flag === want ? [] : [`第 ${fi.frame} 帧实例表第 ${fi.row} 行的行列式是 ${d}，第四列是 ${flag}，必须是 ${want}`];
  })),

  SP4: onRecord((rec) => manyTo((rec.reads ?? []).map((r) => [`${r.table} 第 ${r.frame} 帧`, r.digest]))
    .map(([k]) => `${k} 读了几次，字节不一样`)),

  SP5: onPack((pack, obj) => {
    const unknown = (pack.materials ?? []).flatMap((m) => (m.pattern ?? []).filter((n) => !NODES.has(n.node)).map((n) => `材质 ${m.name} 的节点 ${n.node}`));
    if (!unknown.length) return [];
    const out = unknown.map((u) => `${u} 不在节点登记表里`);
    if (obj.format === 'scene-pack-check/0.1') {
      (obj.loads ?? []).forEach((l, i) => {
        if (l.status !== 'error' || l.code !== 'contract.unknown-node') out.push(`第 ${i} 次读入的结果是 ${l.status}${l.code ? ` ${l.code}` : ''}，必须报 contract.unknown-node`);
      });
    }
    return out;
  }),

  SP6: onRecord((rec) => {
    const t = rec.roundTrip;
    if (!t) return [];
    const out = [];
    if (t.after !== t.before) out.push(`读入再写出之后包哈希从 ${t.before} 变成了 ${t.after}`);
    if (t.locked !== undefined && t.locked !== t.before) out.push(`锁文件记的包哈希 ${t.locked} 不等于 ${t.before}`);
    return out;
  }),

  SP7: onRecord((rec) => (rec.normalProbes ?? []).flatMap((p) => {
    const flag = rec.tables?.instances?.[p.row]?.[3];
    const d = dot(p.used, p.raw);
    if (flag === 1 && !(d < 0)) return [`第 ${p.frame} 帧镜像实例第 ${p.row} 行的几何法线没有取反（used·raw = ${d}）`];
    if (flag === 0 && !(d > 0)) return [`第 ${p.frame} 帧实例第 ${p.row} 行的几何法线被取反了（used·raw = ${d}）`];
    return [];
  })),

  // frames.materials 的列词汇待定，宽度算不出：这张表的最后一维等实测，只比第一维和字节数
  SP8: onPack((pack, obj) => {
    const out = [];
    const ins = pack.instances;
    const n = ins.shape[0];
    if (!sameList(ins.shape, [n, 4])) out.push(`实例表的 shape 是 ${JSON.stringify(ins.shape)}，必须是 [实例数, 4]`);
    if (ins.names.length !== n) out.push(`instances.names 有 ${ins.names.length} 项，实例数是 ${n}`);
    if (ins.class.length !== n) out.push(`instances.class 有 ${ins.class.length} 项，实例数是 ${n}`);
    const fr = pack.frames;
    const width = (t) => (t.fields.every((f) => Object.hasOwn(WIDTH, f)) ? t.fields.reduce((s, f) => s + WIDTH[f], 0) : null);
    const want = {
      instances: [fr.count, n, width(fr.instances)],
      camera: [fr.count, width(fr.camera)],
      lights: [fr.count, pack.lights.length, width(fr.lights)],
    };
    for (const [k, w] of Object.entries(want)) {
      if (!sameList(fr[k].shape, w)) out.push(`frames.${k} 的 shape 是 ${JSON.stringify(fr[k].shape)}，必须是 ${JSON.stringify(w)}`);
    }
    if (fr.materials && fr.materials.shape[0] !== fr.count) out.push(`frames.materials 的第一维是 ${fr.materials.shape[0]}，帧数是 ${fr.count}`);
    if (obj.format === 'scene-pack-check/0.1' && obj.files) {
      const bytes = new Map(obj.files.map((f) => [f.path, f.bytes]));
      for (const t of [ins, fr.instances, fr.camera, fr.lights, fr.materials].filter(Boolean)) {
        const b = t.shape.reduce((s, v) => s * v, 1) * 4;
        if (bytes.has(t.file) && bytes.get(t.file) !== b) out.push(`${t.file} 是 ${bytes.get(t.file)} 字节，照 shape 必须是 ${b}`);
      }
    }
    return out;
  }),

  SP9: onRecord((rec, pack) => (rec.tables?.instances ?? []).flatMap((r, i) => [
    ...(r[0] < pack.geometry.meshes.length ? [] : [`实例表第 ${i} 行的网格下标 ${r[0]} 不小于网格数 ${pack.geometry.meshes.length}`]),
    ...(r[1] < pack.materials.length ? [] : [`实例表第 ${i} 行的材质下标 ${r[1]} 不小于材质数 ${pack.materials.length}`]),
    ...(r[2] >= 1 ? [] : [`实例表第 ${i} 行的实体编号是 ${r[2]}，必须不小于 1`]),
    ...(r[3] === 0 || r[3] === 1 ? [] : [`实例表第 ${i} 行的第四列是 ${r[3]}，必须是 0 或 1`]),
  ])),

  SP10: onRecord((rec, pack) => {
    const rows = rec.tables?.instances;
    if (!rows) return [];
    const pairs = rows.map((r, i) => [r[2], pack.instances.names[i]]);
    return [
      ...manyTo(pairs).map(([id, ns]) => `实体编号 ${id} 配了不止一个名字：${ns.join('、')}`),
      ...manyTo(pairs.map(([id, nm]) => [nm, id])).map(([nm, ids]) => `实体名 ${nm} 配了不止一个编号：${ids.join('、')}`),
    ];
  }),

  SP11: onPack((pack) => pack.geometry.meshes.flatMap((m) => ['position', 'cornerNormal']
    .filter((a) => !m.attrs.includes(a)).map((a) => `网格 ${m.name} 的 attrs 里没有 ${a}`))),

  SP12: onPack((pack) => pack.lights.flatMap((l) => (l.link ?? [])
    .filter((p) => !pack.instances.names.some((nm) => matches(p, nm)))
    .map((p) => `灯 ${l.name} 的链接 ${p} 一个实体名都配不到`))),

  SP13: onPack((pack) => pack.materials.flatMap((m) => {
    const outs = [];
    const bad = [];
    for (const [j, n] of (m.pattern ?? []).entries()) {
      for (const k of ['in', 'by']) if (k in n && !outs.includes(n[k])) bad.push(`材质 ${m.name} 第 ${j} 个节点的 ${k} 是 ${n[k]}，前面没有节点的 out 叫这个名字`);
      if ('out' in n) outs.push(n.out);
    }
    return bad;
  })),

  SP14: onPack((pack) => {
    const names = [...new Set(pack.instances.names)];
    return names.flatMap((a) => names.filter((b) => b.startsWith(`${a}.`)).map((b) => `实例表里有装配体 ${a}：${b} 以它加点开头`));
  }),

  SP15: onPack((pack) => manyTo(pack.instances.names.map((nm, i) => [nm, pack.instances.class[i]]))
    .map(([nm, cs]) => `实体 ${nm} 的各行 class 不同：${cs.join('、')}`)),

  SP16: onPack((pack) => {
    const f = pack.frames.camera.fields;
    return f.includes('focusDist') && f.includes('fstop') && !('sensorHeight' in pack.camera)
      ? ['相机表带 focusDist、fstop 两列，camera 里却没有 sensorHeight'] : [];
  }),
};

