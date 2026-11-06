// 把 timeline.js 导出成 JSON，给配乐 / 混音 / 核对脚本用
import * as TL from '../timeline.js';
const beats = TL.BEATF.map((f, i) => ({ b: i, f, t: f / TL.FPS }));
console.log(JSON.stringify({ fps: TL.FPS, dur: TL.DUR, endf: TL.ENDF, beatf: TL.BEATF, beats, hit: TL.HIT, T: TL.T, wingbeats: TL.WINGBEATS, inscr: TL.INSCR }, null, 1));
