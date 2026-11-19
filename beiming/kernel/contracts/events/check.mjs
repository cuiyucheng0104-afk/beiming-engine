// 事件表契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 收两种对象：事件表（events/0.1）和事件核对记录（events-check/0.1）。EV1 到 EV3 判事件表本身
// （核对记录里判它的 events 段），EV7 的前一半（frame 落在 [0, frames) 内）也是；
// EV4 到 EV6 和 EV7 里带 shot 的那一半要对着片子描述判，只在核对记录带 film 段时判。

/** 5.2：逐字符按码点比，短的前缀在前 */
function cmpId(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

const EXPR = /^(?:cut\((0|[1-9]\d*)\)|event\(([^()\s]+)\))(?: ([+-]) ([1-9]\d*))?$/;

/** D 契约 5.3：把整数或时刻算式展开成全片帧号；展开不了返回 undefined */
function expand(film, v, seen = new Set()) {
  if (Number.isInteger(v)) return v;
  const m = typeof v === 'string' ? EXPR.exec(v) : null;
  if (!m) return undefined;
  let base;
  if (m[1] !== undefined) base = Number(m[1]);
  else {
    const ev = (film.events ?? []).find((e) => e.id === m[2]);
    if (!ev || seen.has(m[2])) return undefined;
    base = expand(film, ev.frame, new Set(seen).add(m[2]));
    if (base === undefined) return undefined;
  }
  if (m[3] === undefined) return base;
  return m[3] === '+' ? base + Number(m[4]) : base - Number(m[4]);
}

const tableOf = (o) => (o?.format === 'events/0.1' ? o : o?.format === 'events-check/0.1' ? o.events : null);
const onTable = (fn) => (o) => {
  const t = tableOf(o);
  return t ? fn(t.events ?? []) : [];
};
const onFilm = (fn) => (o) => (o?.format === 'events-check/0.1' && o.film ? fn(o.events, o.film) : []);
const sameOpt = (a, b, k) => (k in a) === (k in b) && a[k] === b[k];

export const checks = {
  EV1: onTable((evs) => evs.slice(1).flatMap((b, i) => {
    const a = evs[i];
    return a.frame < b.frame || (a.frame === b.frame && cmpId(a.id, b.id) < 0)
      ? [] : [`事件条目 ${a.id}（第 ${a.frame} 帧）排在了 ${b.id}（第 ${b.frame} 帧）前面`];
  })),

  EV2: onTable((evs) => {
    const seen = new Set();
    return evs.flatMap((e) => {
      const dup = seen.has(e.id);
      seen.add(e.id);
      return dup ? [`事件条目的 id ${e.id} 重复`] : [];
    });
  }),

  EV3: onTable((evs) => evs
    .filter((e) => (['named', 'cut'].includes(e.kind) ? 'film' : 'tracks') !== e.from)
    .map((e) => `事件条目 ${e.id} 的 kind 是 ${e.kind}，from 却是 ${e.from}`)),

  EV4: onFilm((table, film) => {
    const named = table.events.filter((e) => e.kind === 'named');
    const src = film.events ?? [];
    const out = [];
    for (const ev of src) if (!named.some((e) => e.id === ev.id)) out.push(`片子描述的事件 ${ev.id} 没有对应的命名条目`);
    for (const e of named) if (!src.some((ev) => ev.id === e.id)) out.push(`命名条目 ${e.id} 在片子描述的 events 里没有`);
    for (const ev of src) {
      const e = named.find((x) => x.id === ev.id);
      if (!e) continue;
      const f = expand(film, ev.frame);
      // 展开不了说明片子描述违反 D2，求值核本该拒收；交了事件表就算对不上
      if (f === undefined) out.push(`事件 ${ev.id} 的 frame ${JSON.stringify(ev.frame)} 展开不了（片子描述违反 D 契约 D2），求值核必须拒收，却交出了事件表`);
      else if (e.frame !== f) out.push(`命名条目 ${e.id} 的 frame 是 ${e.frame}，事件的 frame ${JSON.stringify(ev.frame)} 展开是 ${f}`);
      if (e.sub !== 0) out.push(`命名条目 ${e.id} 的 sub 是 ${e.sub}，应该是 0`);
      if (!sameOpt(e, ev, 'shot')) out.push(`命名条目 ${e.id} 的 shot 是 ${e.shot ?? '没有'}，事件的是 ${ev.shot ?? '没有'}`);
      if (!sameOpt(e, ev, 'audio')) out.push(`命名条目 ${e.id} 的 audio 是 ${e.audio ?? '没有'}，事件的是 ${ev.audio ?? '没有'}`);
      if ('audio' in e && e.sync !== (ev.sync ?? 'onset')) out.push(`命名条目 ${e.id} 的 sync 是 ${e.sync ?? '没有'}，应该是 ${ev.sync ?? 'onset'}`);
    }
    return out;
  }),

  EV5: onFilm((table, film) => {
    const cuts = new Set((film.shots ?? []).slice(1).map((s) => s.in));
    const entries = table.events.filter((e) => e.kind === 'cut');
    const got = new Set(entries.map((e) => e.frame));
    const out = [];
    for (const c of cuts) if (!got.has(c)) out.push(`第 ${c} 帧的切点没有切点条目`);
    for (const f of got) if (!cuts.has(f)) out.push(`切点条目在第 ${f} 帧，片子描述在这里没有切点`);
    if (got.size !== entries.length) out.push('有两个切点条目的 frame 相等');
    for (const e of entries) {
      if (e.id !== `cut.${e.frame}`) out.push(`切点条目 ${e.id} 的 id 应该是 cut.${e.frame}`);
      if (e.sub !== 0) out.push(`切点条目 ${e.id} 的 sub 是 ${e.sub}，应该是 0`);
      if ('shot' in e) out.push(`切点条目 ${e.id} 带了 shot`);
    }
    return out;
  }),

  EV6: onFilm((table, film) => [
    ...(table.film === film.id ? [] : [`事件表的 film 是 ${table.film}，片子描述的 id 是 ${film.id}`]),
    ...(table.fps === film.output?.fps ? [] : [`事件表的 fps 是 ${table.fps}，片子描述的 output.fps 是 ${film.output?.fps}`]),
    ...(table.frames === film.output?.frames ? [] : [`事件表的 frames 是 ${table.frames}，片子描述的 output.frames 是 ${film.output?.frames}`]),
  ]),

  EV7: (o) => {
    const table = tableOf(o);
    if (!table) return [];
    const film = o.format === 'events-check/0.1' ? o.film : undefined;
    return (table.events ?? []).flatMap((e) => {
      const out = [];
      if (!(e.frame >= 0 && e.frame < table.frames)) out.push(`事件条目 ${e.id} 的 frame ${e.frame} 不在 [0, ${table.frames}) 内`);
      if (film && 'shot' in e) {
        const s = (film.shots ?? []).find((x) => x.id === e.shot);
        if (!s) out.push(`事件条目 ${e.id} 的 shot ${e.shot} 不是片子描述里的镜头`);
        else if (!(s.in <= e.frame && e.frame < s.out)) out.push(`事件条目 ${e.id} 在第 ${e.frame} 帧，不在镜头 ${s.id} 的 [${s.in}, ${s.out}) 内`);
      }
      return out;
    });
  },
};
