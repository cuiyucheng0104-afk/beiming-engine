// time.envelope：起、保持、落三段直线的包络。纯函数，按 f + sub 现算。

/**
 * params（帧，at 是镜头局部帧号）：at 起点；attackFrames 用几帧从 0 升到 1；holdFrames 在 1 上停几帧；releaseFrames 用几帧落回 0。
 * 返回 { envelope: { value } }：value 在 [0, 1]，没有单位。at 之前和落完之后是 0；attackFrames 是 0 时在 at 这一刻直接是 1。
 */
export function evaluate(inputs, params, f, sub) {
  const t = f + sub - params.at, { attackFrames: a, holdFrames: h, releaseFrames: r } = params;
  const value = t < 0 ? 0 : t < a ? t / a : t <= a + h ? 1 : t < a + h + r ? 1 - (t - a - h) / r : 0;
  return { envelope: { value } };
}
