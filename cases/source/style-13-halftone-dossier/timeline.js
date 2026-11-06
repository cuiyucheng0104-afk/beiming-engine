// 唯一时间源：画面（index.html）、事件（EV）、配乐与拟音（mix.py 读 timeline.json）、拍点核对（tools/cuecheck.py）都从这里取数
// 90 BPM 一拍 = 20 帧，120 BPM 一拍 = 15 帧（30 fps），所有拍点落在整帧上
export const FPS = 30;
export const DUR = 19.6;
export const SECS = [
  { id: 'cover',    t0: 0.0,  bpm: 90,  beats: 4.5, meter: 4, note: '封面，半拍弱起（第一强拍 = 拍 0.5）' },
  { id: 'exhibits', t0: 3.0,  bpm: 90,  beats: 9,   meter: 3, note: '证物，3/4 爵士华尔兹，每小节一件' },
  { id: 'board',    t0: 9.0,  bpm: 120, beats: 8,   meter: 4, note: '证物板，提速' },
  { id: 'hush',     t0: 13.0, bpm: 90,  beats: 1.5, meter: 0, note: '停顿（延长记号），静默' },
  { id: 'mug',      t0: 14.0, bpm: 90,  beats: 8.4, meter: 4, note: '嫌犯照 + 印章，减速回 90' },
];
const S = Object.fromEntries(SECS.map(s => [s.id, s]));
export const B = (id, beat) => S[id].t0 + beat * 60 / S[id].bpm;
export const secAt = t => { let s = SECS[0]; for (const x of SECS) if (t >= x.t0) s = x; return s; };

// 关键画面事件：[段, 拍]。画面里的"落定 / 撞击 / 到位"时刻都等于这里的时间
export const HIT = {
  key0: ['cover', 0], key1: ['cover', 0.25], key2: ['cover', 0.5], key3: ['cover', 0.75], key4: ['cover', 1], key5: ['cover', 1.25], key6: ['cover', 1.5],
  bell: ['cover', 4],            // 回车铃（跨过擦除，L-cut）
  wipe: ['exhibits', 0],         // 网点擦除完全覆盖 = 切
  hl1: ['exhibits', 0.5],        // "三件证物" 首字落定
  pin1: ['exhibits', 1], act1: ['exhibits', 2],
  pan2: ['exhibits', 3], pin2: ['exhibits', 4], act2: ['exhibits', 5],
  pan3: ['exhibits', 6], pin3: ['exhibits', 7], act3: ['exhibits', 8],
  pull: ['board', 0],            // 猛拉远到位 + 提速
  hl2: ['board', 1 / 3],         // "谁拿走了第13页？" 首字落定（三连音第二个，留够阅读时间）
  str1: ['board', 2], str2: ['board', 3], str3: ['board', 4],
  x1: ['board', 5], x2: ['board', 6], x3: ['board', 6 + 2 / 3], x4: ['board', 7], x5: ['board', 7 + 1 / 3], x6: ['board', 7 + 2 / 3],   // 四分 → 三连音加速（120 BPM 下三连音 = 5 帧，八分音符不落整帧，所以用三连音摇摆）
  swallow: ['board', 8],         // 网点吞满 → 静默
  flash1: ['mug', 0],            // 闪光揭晓（大特写）
  snap: ['mug', 1],              // 猛拉远到位 + 二次闪光
  plate: ['mug', 2], hl3: ['mug', 2.5], cap: ['mug', 3],
  cut: ['mug', 4],               // 音乐抽空
  stamp: ['mug', 5],             // 结案
  squawk: ['mug', 5.5], land: ['mug', 6.5], final: ['mug', 7],
};
export const T = Object.fromEntries(Object.entries(HIT).map(([k, [s, b]]) => [k, B(s, b)]));
