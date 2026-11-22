// time.cut-grid：把拍点或镜头时长对到网格上，交出切点。纯函数，不留跨帧的状态。

const KINDS = ['cuts', 'durations'];

/**
 * inputs：用到 shot.in（镜头起始帧，全片帧号）。
 * params.marks：marksAre 是 cuts 时是想切的位置（全片帧号，从小到大，可以带小数）；是 durations 时是各镜头的时长（帧，都大于 0），
 *   切点取时长的累加，最后一个累加是片尾、不是切点。
 * 每个位置对到最近的网格点 offsetFrames + k × gridFrames（正好在两格中间时取后一格）；离上一个切点（第一个离 startFrame）不到 minShotFrames 的，
 *   往后挪到够长的第一个网格点，所以切点一个不少、严格递增。endFrame 大于 0 时最后一个镜头也要够长，放不下就报错；是 0 时不管片尾。
 * f 是镜头局部帧号，sub 是子帧相位 [0, 1)。
 * 返回 { cuts: { frames, end, events, shot, sinceFrames, untilFrames } }：frames 是切点的全片帧号；end 是片尾帧号（endFrame，
 *   没给时 durations 取对到网格的总长，cuts 是 null）；events 是事件表里的切点条目；shot 是这一刻（f + sub）在第几个镜头（从 0 起）；
 *   sinceFrames 是离上一个切点（没有就是 startFrame）几帧，untilFrames 是离下一个切点几帧，没有就是 null。
 */
export function evaluate(inputs, params, f, sub) {
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
  const t = inputs.shot.in + f + sub, past = frames.filter((c) => c <= t), next = frames[past.length];
  return {
    cuts: {
      frames, end, events: frames.map((frame) => ({ id: `cut.${frame}`, frame, sub: 0, kind: 'cut', from: 'film' })),
      shot: past.length, sinceFrames: t - (past.at(-1) ?? startFrame), untilFrames: next === undefined ? null : next - t,
    },
  };
}
