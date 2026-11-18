// 镜头输入：这个镜头出片要读的片子内容，帧源接口 open 的第一个参数。纯函数，从片子描述算出来。

/** film 是片子描述，shotId 是镜头的标识。返回 { film, output: { size, fps }, shot }；镜头带 renderer 时出帧者那一套换到顶层。 */
export function shotInput(film, shotId) {
  const entry = film.shots.find((s) => s.id === shotId);
  if (!entry) throw new RangeError(`片子描述里没有镜头 ${shotId}`);
  const { renderer, ...rest } = entry;
  const shot = structuredClone(rest);
  if (renderer) {
    // 留作对照的那一套整个拿掉，不让它的 entry 之类漏到出帧者那一套里
    for (const k of ['source', 'host', 'mode', 'entry']) delete shot[k];
    Object.assign(shot, structuredClone(renderer));
  }
  return { film: film.id, output: { size: [...film.output.size], fps: film.output.fps }, shot };
}
