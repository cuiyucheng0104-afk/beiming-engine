// 参考包契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是参考包清单（ref-pack/0.1）或参考包核对记录（ref-pack-check/0.1）；空数组表示没违反。
// RP1、RP2 的 denoised、RP8 只看清单，对单独的清单和记录里的 pack 都判；其余各条只看记录，记录里没出现的段不判。

// 抄自输出通道契约（PS）3.1 通道登记表：取法 sample 是 sub0 的通道名。那张表改了，这里跟着改。
const AUX = ['depth', 'objectId', 'normal', 'motion'];
// RP5 里按集合比的字段（和 RP1 一致）；seeds、files 的次序有含义（5.3），和其余字段一样逐项比。
const SET_KEYS = ['channels', 'auxSample'];
const FLOOR_KEYS = ['rerunBitExact', 'seedVsSeedPsnr', 'seedVsSeedFlipMean'];

const packOf = (obj) => (obj?.format === 'ref-pack/0.1' ? obj : obj?.format === 'ref-pack-check/0.1' ? obj.pack : undefined);
const onPack = (fn) => (obj) => { const p = packOf(obj); return p ? fn(p) : []; };
const onRecord = (fn) => (obj) => (obj?.format === 'ref-pack-check/0.1' ? fn(obj) : []);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

const sameSet = (a, b) => a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));

const raw = {
  RP1: onPack((p) => {
    const want = new Set(p.channels.filter((c) => AUX.includes(c)));
    const got = new Set(p.auxSample);
    return [
      ...[...want].filter((c) => !got.has(c)).map((c) => `参考包 ${p.ref} 的 channels 里有辅助层 ${c}，auxSample 里却没有`),
      ...[...got].filter((c) => !want.has(c)).map((c) => `参考包 ${p.ref} 的 auxSample 里有 ${c}，它不是 channels 里的辅助层`),
    ];
  }),

  RP2: (obj) => [
    ...onPack((p) => (p.denoised === false ? [] : [`参考包 ${p.ref} 的 denoised 是 ${p.denoised}`]))(obj),
    ...onRecord((r) => (r.colorTransfer === undefined || r.colorTransfer === 'linear' ? [] : [`量出来的 color 通道是 ${r.colorTransfer}，不是线性编码`]))(obj),
  ],

  RP3: onRecord((r) => {
    const empty = FLOOR_KEYS.filter((k) => r.pack.floor[k] === null);
    return empty.length && (r.judgings ?? []).length ? [`floor 的 ${empty.join('、')} 是 null，却当了 ${r.judgings.length} 次裁判`] : [];
  }),

  RP4: onRecord((r) => (r.judgings ?? []).flatMap((j, i) => {
    const f = r.pack.floor[j.metric];
    if (f === null) return []; // 归 RP3
    const want = f * j.k;
    return Math.abs(j.threshold - want) <= Math.abs(want) * 1e-9 ? [] : [`judgings[${i}] 的门槛是 ${j.threshold}，应是 floor.${j.metric} × k = ${want}`];
  })),

  RP5: onRecord((r) => {
    if (!r.previous || r.previous.ref !== r.pack.ref) return []; // ref 不同归 RP9
    const keys = new Set([...Object.keys(r.pack), ...Object.keys(r.previous)].filter((k) => k !== 'floor' && k !== 'ext'));
    return [...keys].filter((k) => !(SET_KEYS.includes(k) ? sameSet(r.pack[k], r.previous[k]) : deepEqual(r.pack[k], r.previous[k])))
      .map((k) => `同一个 ref ${r.pack.ref} 之前存的那份 ${k} 是 ${JSON.stringify(r.previous[k])}，现在是 ${JSON.stringify(r.pack[k])}`);
  }),

  RP6: onRecord((r) => (!r.stored || r.stored.address === r.stored.hash ? [] : [`存放地址 ${r.stored.address} 不等于包哈希 ${r.stored.hash}`])),

  RP7: onRecord((r) => (r.reads ?? []).filter((x) => x.reader === 'solver' && x.status !== 'denied')
    .map((x) => `做题的一方读参考包的结果是 ${x.status}`)),

  RP8: onPack((p) => {
    if (p.profile !== 'physical') return [];
    return [['clamp.direct', p.clamp.direct], ['clamp.indirect', p.clamp.indirect], ['filterGlossy', p.filterGlossy]]
      .filter(([, v]) => v !== 0).map(([k, v]) => `参考包 ${p.ref} 的渲染口径是 physical，${k} 却是 ${v}`);
  }),

  RP9: onRecord((r) => (!r.previous || r.previous.ref === r.pack.ref ? [] : [`previous 的 ref 是 ${r.previous.ref}，pack 的 ref 是 ${r.pack.ref}：previous 必须是用同一个 ref 存过的那份`])),
};

export const checks = raw;
