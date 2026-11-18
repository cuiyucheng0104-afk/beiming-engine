// 北冥引擎 · 离屏出片 · 流水线读回：渲第 n 帧、发起读回，不等它完成就渲第 n+1 帧，GPU 不必停下来等 CPU 取像素。
//   renderFrames({ host, work, from, to, inflight = 3, onFrame }) → Promise<void>
//     渲 [from, to) 的每一帧，按帧号顺序调用 onFrame(f, pixels)；同时在途的帧数不超过 inflight；
//     onFrame 返回的 Promise 会被等待（编码器跟不上时渲染随之放慢）。inflight 不是 ≥ 1 的数 → RangeError
// 为什么能复用同一个渲染目标：three r187 的读回在返回 Promise 之前就把拷贝命令提交进队列，WebGPU 队列按提交顺序执行，
// 第 n 帧的拷贝一定排在第 n+1 帧的渲染之前（tests/offscreen/host.test.mjs 用在途 1 帧对 3 帧逐字节核对）。
export async function renderFrames({ host, work, from, to, inflight = 3, onFrame }) {
  if (!(inflight >= 1)) throw new RangeError(`inflight 要 ≥ 1，收到 ${inflight}`);
  const queue = [];
  const drain = async () => { const { f, p } = queue.shift(); await onFrame(f, await p); };
  try {
    for (let f = from; f < to; f++) {
      const p = host.renderFrame(work, f);
      p.catch(() => {});   // 后帧可能比当前 onFrame 更早失败，必须立刻接住，仍由 drain 按顺序抛出
      queue.push({ f, p });
      if (queue.length >= inflight) await drain();
    }
    while (queue.length) await drain();
  } finally {
    // 中途出错时，还在途的读回照样会完成或失败：接住它们，免得变成未处理的拒绝
    for (const { p } of queue) p.catch(() => {});
  }
}
