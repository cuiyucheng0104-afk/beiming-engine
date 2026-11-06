// 灯塔守夜 · 唯一时间源。画面 (index.html)、配乐与拟音 (mix.py)、拍点核对 (tools/cuecheck.py) 都读这里。
// 76 BPM 标称：每拍恰好 19 帧 (24 fps) → 75.789 BPM，所有拍点（含按帧取整的十六分）都落在整帧上。
export const FPS = 24, FPB = 19;                       // frames per beat
export const BPM = 60 * FPS / FPB;                     // 75.789…
export const BEATS = 24, BAR = 4;
export const T = b => Math.round(b * FPB) / FPS;       // beat → seconds, frame-exact
export const DUR = T(BEATS);                           // 19.0 s

// key events, in beats
export const KB = {
  // S1 刻版：刀越刻越快 (1,1,½,½,½,¼ 拍) → U 刀扫天 → 刺刀雨点
  knife: [0, 1, 2, 2.5, 3, 3.5, 3.75],
  sky: 4, rain: [4.25, 4.5, 4.75],
  // S2 风暴
  cut2: 5, wave: [6, 8], snap: 8, creak: [5.5, 7, 9],
  spic: [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.75],    // 八分 → 四分 → 更稀：减速
  // S3 爬塔 + 静默 + 灯亮
  cut3: 10, rung: [10, 10.5, 11], grate: 11.25, silence: [11.5, 12],
  ignite: 12, burst: [12, 12.25, 12.5, 12.75],
  // S4 光束一拍一刀扫过海面
  cut4: 13, beam: [13, 14, 15],
  // S5 照到船，红版铺开又退回，船靠港
  boat_lit: 16, red_full: 17, dock: 18, red_back0: 18.5, red_back1: 19.5,
  // S6 揭纸 → 成品
  peel: 20, peel_end: 20.75, caption: 20.75, end: 24,
  // 成品上的星：逐颗点亮，各卡 ¼ 拍（b20.75 是题签压印，空开）
  star: [20.25, 20.5, 21, 21.25, 21.5, 21.75, 22, 22.25],
};

// shots, in beats
export const SHOTS = [
  { id: 'S1', b0: 0, b1: 5 },
  { id: 'S2', b0: 5, b1: 10 },
  { id: 'S3', b0: 10, b1: 13 },
  { id: 'S4', b0: 13, b1: 16 },
  { id: 'S5', b0: 16, b1: 20 },
  { id: 'S6', b0: 20, b1: 24 },
];

const toT = v => Array.isArray(v) ? v.map(T) : T(v);
export const K = Object.fromEntries(Object.entries(KB).map(([k, v]) => [k, toT(v)]));

export const TL = { fps: FPS, fpb: FPB, bpm: BPM, beats: BEATS, dur: DUR, beat_s: FPB / FPS, KB, K, shots: SHOTS.map(s => ({ ...s, t0: T(s.b0), t1: T(s.b1) })) };

// node timeline.js → timeline.json
if (typeof process !== 'undefined' && process.argv && /timeline\.js$/.test(process.argv[1] || '')) {
  const fs = await import('node:fs'), path = await import('node:path'), url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  fs.writeFileSync(path.join(here, 'timeline.json'), JSON.stringify(TL, null, 1));
  console.log('timeline.json: dur', DUR, 'bpm', BPM.toFixed(3));
}
