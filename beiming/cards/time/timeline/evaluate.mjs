// time.timeline：把一个时刻换成几种时间读数。纯函数，不留跨帧的状态。
import { globalFrame, hold } from '../../../kernel/eval/time.mjs';

/**
 * inputs：用到 fps（"分子/分母"，帧每秒）和 shot.in（镜头起始帧，全片帧号）。
 * params：holdFrames 每几帧压成一格（1 是不压，2 是一拍二）；beatFrames 一拍几帧。
 * f 是镜头局部帧号，sub 是子帧相位 [0, 1)。
 * 返回 { time: { local, held, global, seconds, beat } }：local 是 f + sub（帧）；held 是压住的局部帧号（整数帧，不随 sub 变）；
 * global 是全片时刻（帧，带子帧相位）；seconds 是全片时刻换成秒；beat 是全片时刻换成拍（从 0 起）。
 */
export function evaluate(inputs, params, f, sub) {
  const [num, den] = inputs.fps.split('/').map(Number), global = globalFrame(f, inputs.shot.in) + sub;
  return { time: { local: f + sub, held: hold(f, params.holdFrames), global, seconds: (global * den) / num, beat: global / params.beatFrames } };
}
