// time.events：这一帧落了哪些事件、离前后两个事件各几帧。纯函数。

const KINDS = ['named', 'cut', 'any'];

/**
 * inputs.events：事件表换成镜头局部帧号之后的数组，每项 { id, kind, f, sub }；f 可以是负数，也可以不小于镜头帧数。
 * params.kind：看哪一类条目，named 是命名事件，cut 是切点，any 是两类都看。
 * 返回 { events: { hits, sinceFrames, untilFrames } }：hits 是正好落在第 f 帧的事件的 id（按 id 排序，不随 sub 变）；
 * sinceFrames 是这一刻（f + sub）离最近一个已经发生的事件几帧，untilFrames 是离下一个还没发生的事件几帧，没有就是 null。
 */
export function evaluate(inputs, params, f, sub) {
  if (!KINDS.includes(params.kind)) throw new RangeError(`time.events 的 kind 只能是 ${KINDS.join('、')}，给的是 ${params.kind}`);
  const t = f + sub, at = inputs.events.filter((e) => params.kind === 'any' || e.kind === params.kind).map((e) => ({ id: e.id, f: e.f, t: e.f + e.sub }));
  const past = at.filter((e) => e.t <= t).map((e) => t - e.t), ahead = at.filter((e) => e.t > t).map((e) => e.t - t);
  return { events: { hits: at.filter((e) => e.f === f).map((e) => e.id).sort(), sinceFrames: past.length ? Math.min(...past) : null, untilFrames: ahead.length ? Math.min(...ahead) : null } };
}
