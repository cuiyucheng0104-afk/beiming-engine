// 北冥引擎 · 离屏出片 · 流水线读回：渲第 n 帧、发起读回，不等它完成就渲下一帧，GPU 不必停下来等 CPU 取像素。
//   renderFrames({ host, work, from, to, inflight = 3, format = 'rgba', onFrame }) → Promise<void>
//     渲 [from, to) 的每一帧，按顺序调用 onFrame(f, pixels)；format 为 'rgba'（默认）或 'yuv420p'（GPU 侧转 BT.709 tv）。
//   renderFrameList({ host, work, frames, inflight = 3, format = 'rgba', onFrame }) → Promise<void>
//     按离散帧号数组 frames 流水线渲染读回（给 offscreen stills 抽关键帧用）。
//   作品可选 stateKey(f) → string | null：仅 yuv420p 下，相邻帧非 null key 相同就复用上一帧已发起的 YUV 读回；缺省、RGBA 与 null 不变。
export async function renderFrameList({ host, work, frames, inflight = 3, format = 'rgba', onFrame }) {
  if (!(inflight >= 1)) throw new RangeError(`inflight 要 ≥ 1，收到 ${inflight}`);
  if (format !== 'rgba' && format !== 'yuv420p') throw new RangeError(`format 只能是 rgba 或 yuv420p，收到 ${format}`);
  const queue = [];
  let prevKey = null, prevYuv = null;
  const drain = async () => { const { f, p } = queue.shift(); await onFrame(f, await p); };
  try {
    for (const f of frames) {
      const key = format === 'yuv420p' && typeof work.stateKey === 'function' ? work.stateKey(f) : null;
      let p;
      if (typeof key === 'string' && key === prevKey && prevYuv) {
        p = prevYuv;
      } else {
        p = format === 'yuv420p' ? host.renderFrameYuv(work, f) : host.renderFrame(work, f);
        prevKey = key; prevYuv = p;
      }
      p.catch(() => {});   // 后帧可能比当前 onFrame 更早失败，必须立刻接住，仍由 drain 按顺序抛出
      queue.push({ f, p });
      if (queue.length >= inflight) await drain();
    }
    while (queue.length) await drain();
  } finally {
    for (const { p } of queue) p.catch(() => {});
  }
}

export async function renderFrames({ host, work, from, to, inflight = 3, format = 'rgba', onFrame }) {
  if (!(inflight >= 1)) throw new RangeError(`inflight 要 ≥ 1，收到 ${inflight}`);
  const list = [];
  for (let f = from; f < to; f++) list.push(f);
  return renderFrameList({ host, work, frames: list, inflight, format, onFrame });
}
