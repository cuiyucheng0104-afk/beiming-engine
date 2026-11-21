// 宿主量耗时用的单调时钟，全链路只有这一处读时钟。读数只许写进每帧元数据的 timing，不进状态、不进任何哈希。
export const monotonicMs = () => performance.now();
