// 时间换算：镜头局部帧号到全片帧号、hold、快门窗口里的子帧相位。
// 纯函数，不依赖渲染库；页面和 node 两边都引用。时间一律是整数帧，子帧相位在 [0, 1)。

const int = (v, min, what) => {
  if (!Number.isInteger(v) || v < min) throw new RangeError(`${what} 必须是不小于 ${min} 的整数，给的是 ${v}`);
  return v;
};

/** 镜头局部帧号换成全片帧号。 */
export const globalFrame = (f, shotIn) => int(f, 0, '镜头局部帧号') + int(shotIn, 0, '镜头起始帧');

/** 把 f 压到不超过它的最近一个 n 的倍数。一拍二是 hold(f, 2)。 */
export const hold = (f, n) => int(f, 0, 'f') - (f % int(n, 1, 'n'));

/**
 * 一帧的子帧采样相位。快门在帧起点打开，窗口是 [0, 快门角 ÷ 360)；
 * 采样在窗口里居中分层：第 i 个取 (i + 0.5) ÷ 个数 × 窗口长度，所以拖影中点正好在窗口中点。
 * 快门角是 0 时只有 sub = 0。
 */
export function shutterSubs(angleDeg, samples) {
  if (!(angleDeg >= 0 && angleDeg <= 360)) throw new RangeError(`快门角必须在 [0, 360] 度，给的是 ${angleDeg}`);
  int(samples, 1, '子帧采样数');
  return Array.from({ length: samples }, (_, i) => ((i + 0.5) / samples) * (angleDeg / 360));
}
