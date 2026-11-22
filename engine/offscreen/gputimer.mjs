// 北冥引擎 · 离屏出片 · GPU 分段计时：three 每次 render() 结束都会立刻提交命令，在两次提交之间插一个只写时间戳的空计算通道，
// 就能按队列顺序把一帧的 GPU 时间切成若干段，不碰 three 的内部。只用 WebGPU 标准 API，浏览器与 Node + Dawn 同源（不 import node:*）。
//   createGpuTimer(device, { capacity = 128 }) → timer；设备没有 timestamp-query 时返回 null
//     timer.mark(label)    从这里开始算 label 这一段，直到下一个 mark 或 end
//     timer.end()          这一帧的最后一个时间戳
//     await timer.read()   → spansFrom 的结果 { spans: [{ label, ms }], totalMs, clamped }，读完清空，接着计下一帧
//   attachGpuTimer(renderer, timer) / detachGpuTimer(renderer)
//   markGpu(renderer, label)   look.js、ink.js、film.mjs 在各遍之前调用；渲染器没挂计时器时什么也不做（不改画面，只多一次 WeakMap 查找）
// 段的读数是 GPU 时间线上相邻两个标记之差：GPU 在等 CPU 提交的空闲也算在前一段里；部分实现会量化时间戳（防计时侧信道），很短的段读数不准。
const timers = new WeakMap();

export const attachGpuTimer = (renderer, timer) => { timers.set(renderer, timer); };
export const detachGpuTimer = renderer => { timers.delete(renderer); };
export function markGpu(renderer, label) { timers.get(renderer)?.mark(label); }
// 结构上没提交任何 GPU 工作的段显式记 0，避免两个空时间戳之间的量化间隔被误报成渲染耗时
export function markGpuZero(renderer, label) { timers.get(renderer)?.zero(label); }

/** labels[i] 那一段 = ticks[i+1] − ticks[i]（纳秒，BigInt）；labels 末尾必须是 end() 写的 null。倒退的时间戳记 0 并计数 */
export function spansFrom(labels, ticks) {
  if (labels.length !== ticks.length) throw new RangeError(`标记 ${labels.length} 个、时间戳 ${ticks.length} 个，对不上`);
  if (labels.at(-1) !== null) throw new Error('最后一个标记必须是 end()');
  const byLabel = new Map();
  let clamped = 0;
  for (let i = 0; i < labels.length - 1; i++) {
    let ns = ticks[i + 1] - ticks[i];
    if (ns < 0n) { ns = 0n; clamped++; }
    byLabel.set(labels[i], (byLabel.get(labels[i]) ?? 0) + Number(ns) / 1e6);
  }
  const spans = [...byLabel].map(([label, ms]) => ({ label, ms }));
  return { spans, totalMs: spans.reduce((a, s) => a + s.ms, 0), clamped };
}

export function createGpuTimer(device, { capacity = 128 } = {}) {
  if (!device?.features?.has('timestamp-query')) return null;
  const querySet = device.createQuerySet({ type: 'timestamp', count: capacity });
  const resolveBuf = device.createBuffer({ size: capacity * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: capacity * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let labels = [], zeroLabels = [];
  const write = label => {
    if (labels.length >= capacity) throw new RangeError(`一帧最多 ${capacity} 个标记`);
    const enc = device.createCommandEncoder();
    enc.beginComputePass({ timestampWrites: { querySet, beginningOfPassWriteIndex: labels.length } }).end();
    device.queue.submit([enc.finish()]);
    labels.push(label);
  };
  return {
    mark: label => write(String(label)),
    zero: label => zeroLabels.push(String(label)),
    end: () => write(null),
    async read() {
      const n = labels.length;
      const withZeros = result => {
        const done = zeroLabels; zeroLabels = [];
        for (const label of done) if (!result.spans.some(s => s.label === label)) result.spans.push({ label, ms: 0 });
        return result;
      };
      if (!n) return withZeros({ spans: [], totalMs: 0, clamped: 0 });
      const enc = device.createCommandEncoder();
      enc.resolveQuerySet(querySet, 0, n, resolveBuf, 0);
      enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, n * 8);
      device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ, 0, n * 8);
      const ticks = [...new BigUint64Array(readBuf.getMappedRange(0, n * 8).slice(0))];
      readBuf.unmap();
      const done = labels; labels = [];
      return withZeros(spansFrom(done, ticks));
    },
    dispose() { querySet.destroy(); resolveBuf.destroy(); readBuf.destroy(); },
  };
}
