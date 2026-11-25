// 镜头输入：这个镜头出片要读的片子内容，帧源接口 open 的第一个参数。纯函数，从片子描述算出来。

import { expandEventFrames } from './events.mjs';

/** 非枚举考题上下文标记：不污染冻结 shot-input.schema.json 的可枚举键，仅供宿主机内部策略拦截读取。 */
export const SHOT_INPUT_EXAM = Symbol.for('beiming.eval.exam');

/** 出帧用的那一套：镜头条目带 renderer 对象时是它里面的 source、host、mode、entry，不带时是条目顶层的这四样。 */
export const renderingOf = (shot) => shot.renderer ?? shot;

/**
 * 事件表：把片子描述的事件和切点展开成全片帧号，命名条目在前、切点条目在后各写一项，再按帧号、标识排序。
 * 轨道条目（到位、爆发、震动）要从数据轨道里取，这里没有。
 */
export function eventsTable(film) {
  const frames = expandEventFrames(film);
  const named = (film.events ?? []).map((e) => {
    return { id: e.id, frame: frames[e.id], sub: 0, ...(e.shot ? { shot: e.shot } : {}), kind: 'named', from: 'film', ...(e.audio ? { audio: e.audio, sync: e.sync ?? 'onset' } : {}) };
  });
  // 除第一个之外，每个镜头的起始帧是一个切点
  const cuts = film.shots.slice(1).map((s) => ({ id: `cut.${s.in}`, frame: s.in, sub: 0, kind: 'cut', from: 'film' }));
  const events = [...named, ...cuts].sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { format: 'events/0.1', film: film.id, fps: film.output.fps, frames: film.output.frames, events };
}

/**
 * film 是片子描述，shotId 是镜头的标识，events 是已经展开成全片帧号的事件表（没有就不传）。
 * 返回 { film, output: { size, fps }, shot, assets?, events?, overlays?, tokens? }：镜头条目原样（带 renderer 时也原样带着）；
 * assets 是全片的资产表，overlays 是贴在这个镜头上的叠加层条目，片子里没有就不出现。
 */
export function shotInput(film, shotId, events) {
  const entry = film.shots.find((s) => s.id === shotId);
  if (!entry) throw new RangeError(`片子描述里没有镜头 ${shotId}`);
  const overlays = (film.overlays ?? []).filter((o) => o.shot === shotId);
  const out = structuredClone({
    film: film.id,
    output: { size: film.output.size, fps: film.output.fps },
    shot: entry,
    ...(film.assets ? { assets: film.assets } : {}),
    ...(events ? { events } : {}),
    ...(overlays.length ? { overlays } : {}),
    ...(film.style?.tokens ? { tokens: film.style.tokens } : {}),
  });
  if (film.exam) {
    Object.defineProperty(out, SHOT_INPUT_EXAM, {
      value: structuredClone(film.exam),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return out;
}
