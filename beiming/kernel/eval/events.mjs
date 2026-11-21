// 片子描述契约 5.3 的整帧偏移文法。
const expression = /^(?:cut\((0|[1-9][0-9]*)\)|event\(([a-z][a-z0-9-]*)\))(?: ([+-]) ([1-9][0-9]*))?$/;

function fail(reason, detail) {
  throw Object.assign(new RangeError(`${reason}：${detail}`), { code: 'contract.bad-value', reason });
}

function frameNumber(value) {
  if (!Number.isSafeInteger(value)) fail('invalid_frame', `无法精确表示的整数帧 ${value}`);
  if (value < 0) fail('negative_frame', `展开得到 ${value} 帧`);
  return value;
}

function parse(value) {
  if (typeof value === 'number') return { frame: frameNumber(value) };
  if (typeof value !== 'string') fail('invalid_expression', '时刻必须是整数帧号或算式字符串');
  const match = expression.exec(value);
  if (!match) fail('invalid_expression', `时刻算式 ${value}`);
  const offset = frameNumber(Number(match[4] ?? 0));
  const signedOffset = match[3] === '-' ? -offset : offset;
  return match[1] === undefined
    ? { eventId: match[2], offset: signedOffset }
    : { cut: frameNumber(Number(match[1])), offset: signedOffset };
}

/** 展开每个命名事件一次。沿前向引用建栈，回程计算偏移。 */
export function expandEventFrames(film) {
  const shots = Object.create(null);
  const cuts = new Set();
  let previousOut = 0;
  for (const shot of film.shots) {
    if (shot.in !== previousOut || !Number.isSafeInteger(shot.out) || shot.out <= shot.in) {
      fail('invalid_shot_range', `镜头 ${shot.id} 的区间无效或未与前一镜头首尾相接`);
    }
    if (shot.in > 0) cuts.add(shot.in);
    shots[shot.id] = shot;
    previousOut = shot.out;
  }
  if (previousOut === 0 || previousOut !== film.output.frames) fail('invalid_shot_range', '镜头区间必须覆盖全片帧数');

  const terms = Object.create(null);
  const frames = Object.create(null);
  for (const event of film.events ?? []) {
    if (Object.hasOwn(terms, event.id)) fail('duplicate_event', event.id);
    terms[event.id] = parse(event.frame);
  }
  function resolve(term) {
    if (term.frame !== undefined) return term.frame;
    if (term.cut !== undefined) {
      if (!cuts.has(term.cut)) fail('undefined_cut', `${term.cut} 帧`);
      return frameNumber(term.cut + term.offset);
    }
    if (!Object.hasOwn(frames, term.eventId)) fail('undefined_event', term.eventId);
    return frameNumber(frames[term.eventId] + term.offset);
  }
  function shotOf(id) {
    if (!Object.hasOwn(shots, id)) fail('undefined_shot', id);
    return shots[id];
  }
  for (let id of Object.keys(terms)) {
    const path = new Set();
    while (!Object.hasOwn(frames, id)) {
      if (!Object.hasOwn(terms, id)) fail('undefined_event', id);
      if (path.has(id)) fail('event_cycle', [...path, id].join(' -> '));
      const term = terms[id];
      if (term.eventId === undefined) {
        frames[id] = resolve(term);
        break;
      }
      path.add(id);
      id = term.eventId;
    }
    for (const ref of [...path].reverse()) frames[ref] = resolve(terms[ref]);
  }
  for (const event of film.events ?? []) {
    const frame = frames[event.id];
    if (frame >= film.output.frames) fail('frame_out_of_range', `${event.id} 在全片第 ${frame} 帧`);
    if (Object.hasOwn(event, 'shot')) {
      const shot = shotOf(event.shot);
      if (frame < shot.in || frame >= shot.out) fail('frame_out_of_range', `${event.id} 越出镜头 ${shot.id}`);
    }
  }
  for (const overlay of film.overlays ?? []) {
    const start = resolve(parse(overlay.in));
    const end = resolve(parse(overlay.out));
    const shot = shotOf(overlay.shot);
    if (start >= end || start < shot.in || end > shot.out) {
      fail('frame_out_of_range', `叠加层 ${overlay.id} 的区间不在镜头 ${shot.id} 内或为空`);
    }
  }
  for (const line of film.audio?.narration ?? []) {
    const frame = resolve(parse(line.at));
    if (frame >= film.output.frames) fail('frame_out_of_range', `旁白 ${line.id} 在全片第 ${frame} 帧`);
  }
  return frames;
}
