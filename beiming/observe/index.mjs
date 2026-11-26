// 感知组件的统一出口：像素与音视频读数、空间真值查询、联系表与切点条带、曲线摘要与时间遥测、画面比对与对齐拟合。
export * from './metrics/index.mjs';
export { beatOnsetHit } from './metrics/audio-onset.mjs';
export { pitchF0 } from './metrics/audio-pitch.mjs';
export { avSameFrame } from './metrics/av-same-frame.mjs';
export * from './query.mjs';
export {
  SUMMARY_TOKEN_LIMIT,
  STRIP_OFFSETS,
  WEAK_CUT,
  GHOST_RATIO,
  encodePng,
  pngSize,
  decodePng,
  drawLabel,
  resize,
  meanLuma,
  frameDiff,
  collectCuts,
  compactFrames,
  buildContactSheet,
  cutFlags,
  buildCutStrips,
} from './sheet.mjs';
export { curves } from './curves.mjs';
export { telemetry } from './telemetry.mjs';
export { compare } from './compare.mjs';
export { align } from './align.mjs';
