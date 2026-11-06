// 按动圆珠笔代码模型的参数表（mm）：画面上所有数字的唯一来源（见 FACTS.md）。不依赖 three，node 也能读。
export const DIMS = {
  barrelR: 5.0,                 // 笔杆外径 Ø10
  front: { x0: 0, x1: 63 },     // 前杆（含螺纹段 55.5–63）
  rear: { x0: 58, x1: 136 },    // 后杆
  refill: { x0: 1.0, x1: 99.0, r: 1.5, ball: 0.35, collar: [20, 21.5] },   // 笔芯长 98 mm，球珠 Ø0.7
  spring: { seat: 8, turns: 12, coilR: 2.0, wireR: 0.2, free: 18 },          // 有效圈数 12，自由长 18 mm
  cam: { x0: 99, base: 107.5, teeth: 8, toothH: 2.2, r: 3.4, rIn: 1.7 },      // 8 齿，每次转一齿 = 45°
  plunger: { base: 112, x1: 151, stroke: 5, latch: 3 },                      // 行程 5 mm，锁定后笔尖伸出 3 mm
};
export const AXIS_Y = DIMS.barrelR;
