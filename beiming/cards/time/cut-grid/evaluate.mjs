// time.cut-grid：把拍点或镜头时长对到网格上，交出切点。纯函数，不留跨帧的状态。

const KINDS = ['cuts', 'durations'], ORIGINS = ['shot', 'film'];
const bad = (message) => { throw Object.assign(new RangeError(`time.cut-grid：${message}`), { code: 'usage.bad-argument' }); };

/**
 * inputs：用到 shot.in（镜头起始帧，全片帧号）。
 * params.origin：marks、startFrame、endFrame、offsetFrames 这些帧号从哪儿数起。shot（默认，不写也是它）是镜头局部帧号，从 shot.in 数起，
 *   和传进来的 f 同一个零点；film 是全片帧号。交出去的 frames、end、events 不管哪种都是全片帧号（shot 时加上 shot.in）。
 * params.marks：marksAre 是 cuts 时是想切的位置（帧号，从小到大，可以带小数）；是 durations 时是各镜头的时长（帧，都大于 0），
 *   切点取时长的累加，最后一个累加是片尾、不是切点。
 * 每个位置对到最近的网格点 offsetFrames + k × gridFrames（正好在两格中间时取后一格）；离上一个切点（第一个离 startFrame）不到 minShotFrames 的，
 *   往后挪到够长的第一个网格点，所以切点一个不少、严格递增。endFrame 大于 0 时最后一个镜头也要够长，放不下就报错；是 0 时不管片尾。
 * f 是镜头局部帧号，sub 是子帧相位 [0, 1)。gridFrames、minShotFrames 不是大于 0 的整数，offsetFrames、startFrame、endFrame 不是不小于 0 的整数，
 *   origin 写了别的值，都报 usage.bad-argument。
 * 返回 { cuts: { frames, end, events, shot, sinceFrames, untilFrames } }：frames 是切点的全片帧号；end 是片尾帧号（endFrame，
 *   没给时 durations 取对到网格的总长，cuts 是 null）；events 是事件表里的切点条目；shot 是这一刻（f + sub）在第几个镜头（从 0 起）；
 *   sinceFrames 是离上一个切点（没有就是 startFrame）几帧，untilFrames 是离下一个切点几帧，没有就是 null；这一刻是全片第 shot.in + f + sub 帧。
 */
export function evaluate(inputs, params, f, sub) {
  for (const k of ['gridFrames', 'minShotFrames']) if (!Number.isInteger(params[k]) || params[k] < 1) bad(`${k} 要是大于 0 的整数，给的是 ${params[k]}`);
  for (const k of ['offsetFrames', 'startFrame', 'endFrame']) if (!Number.isInteger(params[k]) || params[k] < 0) bad(`${k} 要是不小于 0 的整数，给的是 ${params[k]}`);
  const origin = params.origin ?? 'shot';
  if (!ORIGINS.includes(origin)) bad(`origin 只能是 ${ORIGINS.join('、')}，给的是 ${origin}`);
  const { gridFrames: grid, minShotFrames: minShot, startFrame, endFrame } = params, phase = params.offsetFrames % grid;
  if (!KINDS.includes(params.marksAre)) throw new RangeError(`time.cut-grid 的 marksAre 只能是 ${KINDS.join('、')}，给的是 ${params.marksAre}`);
  const durations = params.marksAre === 'durations', marks = params.marks;
  if (marks.some((m, i) => !Number.isFinite(m) || (durations ? m <= 0 : m < 0 || m < marks[i - 1]))) {
    throw new RangeError(`time.cut-grid 的 marks ${durations ? '是时长，每个都要大于 0' : '是切的位置，要从小到大、不小于 0'}`);
  }
  let total = startFrame;
  const raw = durations ? marks.map((d) => (total += d)).slice(0, -1) : marks;
  const snap = (x) => phase + Math.round((x - phase) / grid) * grid, up = (x) => phase + Math.ceil((x - phase) / grid) * grid;
  const frames = [];
  let prev = startFrame;
  for (const x of raw) frames.push(prev = Math.max(snap(x), up(prev + minShot)));
  const end = endFrame > 0 ? endFrame : durations ? Math.max(snap(total), up(prev + minShot)) : null;
  if (end !== null && prev + minShot > end) throw new RangeError(`time.cut-grid：${frames.length + 1} 个镜头每个至少 ${minShot} 帧，在第 ${end} 帧之前放不下`);
  // 上面都在 origin 的坐标里算；base 是这个坐标的零点在全片第几帧，t 是这一刻在这个坐标里的位置
  const base = origin === 'film' ? 0 : inputs.shot.in, t = inputs.shot.in + f + sub - base;
  const past = frames.filter((c) => c <= t), next = frames[past.length], film = frames.map((c) => c + base);
  return {
    cuts: {
      frames: film, end: end === null ? null : end + base, events: film.map((frame) => ({ id: `cut.${frame}`, frame, sub: 0, kind: 'cut', from: 'film' })),
      shot: past.length, sinceFrames: t - (past.at(-1) ?? startFrame), untilFrames: next === undefined ? null : next - t,
    },
  };
}
