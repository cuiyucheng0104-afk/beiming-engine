// time.seeded：每一帧一组带种子的随机数。纯函数：每次求值都从流的开头数到这一帧，不留跨帧的状态。
import { stream, streamName } from '../../../kernel/eval/rng.mjs';

/**
 * inputs：用到 seed（镜头种子）和 shot.id。params：purpose、object 拼成流名 <镜头种子>/<镜头>/<purpose>/<object>；count 每帧几个数。
 * 返回 { seeded: { values } }：values 是 count 个 [0, 1) 里的数，是这条流的第 f × count 到第 (f + 1) × count − 1 个（从 0 数）。
 * 一帧里面的各个子帧相位用同一组数，所以不随 sub 变。
 */
export function evaluate(inputs, params, f, sub) {
  const s = stream(streamName(inputs.seed, inputs.shot.id, `${params.purpose}/${params.object}`));
  for (let i = 0; i < f * params.count; i++) s.u32();
  return { seeded: { values: Array.from({ length: params.count }, () => s.next()) } };
}
