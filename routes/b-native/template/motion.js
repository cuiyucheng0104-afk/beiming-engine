// {{TITLE}} · 浮标的 Idle 动作（纯函数，不 import 任何东西）：prop.js 用它在浏览器里摆姿态、导出成 GLB 的 Idle 片段；
// film.tsx 用同一个函数算灯在世界里的位置，把页面层的灯晕贴上去——动作只写一处，两边逐帧对得上。
// （film.tsx 不能 import prop.js：那里 import three，原生运行时打包不了；这里不 import 任何东西，两边都能用。）
//   idle(t, period)   → { floatY, rotX, rotZ, vaneY }   浮体起伏与摇摆、风标转角（弧度）
//   lampAt(t, period) → [x, y, z]                       灯心在道具局部坐标里的位置（道具根放在原点、不旋转时就是世界坐标）
export const LAMP_HEIGHT = 1.14;

export function idle(t, period = 3) {
  const a = 2 * Math.PI * t / period;
  return { floatY: 0.08 * Math.sin(a), rotX: 0.05 * Math.sin(a + 1.1), rotZ: 0.07 * Math.sin(a + 0.4), vaneY: a };
}

// 浮体先绕 Z 再绕 X 转（three 的 XYZ 欧拉：R = Rx·Ry·Rz），灯在浮体局部 (0, LAMP_HEIGHT, 0)
export function lampAt(t, period = 3) {
  const { floatY, rotX, rotZ } = idle(t, period), h = LAMP_HEIGHT;
  const x = -h * Math.sin(rotZ), y0 = h * Math.cos(rotZ);
  return [x, floatY + y0 * Math.cos(rotX), y0 * Math.sin(rotX)];
}
