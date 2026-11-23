import { argumentsOf, vector } from './arguments.mjs';

// 世界坐标：Y 向上，相机看向本地 −Z；绕世界 Y 转 a，再绕本地 X 转 −e。
export function evaluate(inputs, params, f, sub = 0) {
  const p = argumentsOf(inputs, params, f, sub), target = vector(p.target);
  // 周期是 N 而不是 N−1。取模也让相隔整圈的姿态（含四元数的符号）一致。
  const deg = (p.startAzimuthDeg + 360 * p.turns * ((f + sub) / p.frames)) % 360;
  // 统一到 [−180,180)，并用 +0 消去反转整圈时取模产生的负零。
  const a = (deg >= 180 ? deg - 360 : deg < -180 ? deg + 360 : deg + 0) * Math.PI / 180;
  const e = p.elevationDeg * Math.PI / 180, h = p.distance * Math.cos(e);
  const pos = [target[0] + h * Math.sin(a), target[1] + p.distance * Math.sin(e), target[2] + h * Math.cos(a)];
  const sa = Math.sin(a / 2), ca = Math.cos(a / 2), se = Math.sin(e / 2), ce = Math.cos(e / 2);
  return { camera: { pos, quat: [-ca * se, sa * ce, sa * se, ca * ce], fovDeg: p.fovYDeg } };
}
