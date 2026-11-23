// 验收核心统一出口：L1 写入即检、L2 纯函数门与包围盒核对门、谓词解析与 floor 1 版六条、防削弱守卫、带噪渲染的 Welch 检验；可控与可复现两项回归（局部性、加锁重建）。
export { checkL1, scanShot, scanSource, estimateCost, GPU_SECONDS_PER_MEGAPIXEL_SAMPLE, MONOTONIC_CLOCK } from './l1.mjs';
export * from './l2.mjs';
export * from './predicates.mjs';
export { welchTest, benjaminiHochberg, studentTwoSidedP } from './welch.mjs';
export * from './controllability.mjs';
