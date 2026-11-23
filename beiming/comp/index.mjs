// 合成收尾（comp）的统一入口：拼接与色彩分流、编码预设、事件混音与母带、交付六件套。
export * from './stitch.mjs';
export * from './encode.mjs';
export { openFileSink, openEncoderSink, openSink, startEncoderSink } from './sink.mjs';
export * from './audio.mjs';
export * from './script-audio.mjs';
export { FOLEY_VOICES } from './foley.mjs';
export * from './deliver.mjs';
export { bakeAgxLut, SHAPER } from './lut/bake-agx.mjs';
