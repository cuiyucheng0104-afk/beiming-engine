// 唯一时间源：节拍网格（全部为整数帧 @24fps）。画面、配乐、拟音、核对脚本都读这里。
export const FPS = 24;
// fpb = 每拍帧数：11 → 130.9 BPM，10 → 144 BPM，9 → 160 BPM
const RAW = [
  { id: 's0',   kind: 'stage', fpb: 11, beats: 2, key: 'C' },   // 闹钟响，舞台亮，按钮，推入电视
  { id: 'g1',   kind: 'game',  fpb: 11, beats: 6, key: 'C', cmd: '接住！', medium: 'crayon' },
  { id: 's1',   kind: 'stage', fpb: 11, beats: 2, key: 'C' },
  { id: 'g2',   kind: 'game',  fpb: 11, beats: 5, key: 'D', cmd: '躲开！', medium: 'pixel' },
  { id: 's2',   kind: 'stage', fpb: 11, beats: 2, key: 'D' },
  { id: 'g3',   kind: 'game',  fpb: 11, beats: 6, key: 'E', cmd: '刷牙！', medium: 'riso' },
  { id: 's3',   kind: 'stage', fpb: 11, beats: 4, key: 'E' },   // ✓ + SPEED UP!
  { id: 'g4',   kind: 'game',  fpb: 10, beats: 4, key: 'F', cmd: '关灯！', medium: 'ink' },
  { id: 's4',   kind: 'stage', fpb: 10, beats: 4, key: 'F' },   // ✓ + 灯灭 + 静默
  { id: 'boss', kind: 'game',  fpb: 9,  beats: 6, key: 'G', cmd: '接住＋关灯！', medium: 'boss' },
  { id: 'end',  kind: 'stage', fpb: 9,  beats: 4, key: 'G' },
];
let f = 0;
export const SEGS = RAW.map(s => { const o = { ...s, f0: f, t0: f / FPS, bpm: 60 * FPS / s.fpb, spb: s.fpb / FPS }; f += s.fpb * s.beats; o.f1 = f; o.t1 = f / FPS; return o; });
export const NF = f, DUR = f / FPS;
export const S = Object.fromEntries(SEGS.map(s => [s.id, s]));
// 某段第 i 拍（可为小数）所在帧 / 秒
export const bf = (id, i) => S[id].f0 + Math.round(i * S[id].fpb * 1000) / 1000;
export const bt = (id, i) => bf(id, i) / FPS;
export function segAt(t) { const fr = t * FPS; for (const s of SEGS) if (fr < s.f1) return s; return SEGS[SEGS.length - 1]; }
// 全片节拍列表（音乐用）
export const BEATS = SEGS.flatMap(s => [...Array(s.beats)].map((_, i) => ({ seg: s.id, i, f: s.f0 + i * s.fpb, t: (s.f0 + i * s.fpb) / FPS, bpm: s.bpm })));

// 转场：推入 6 帧（到达在下一段第 0 拍），缩回 8 帧（到达在舞台段第 0 拍）
export const PUSH = 6, SHRINK = 8;

// 关键拍点（段, 拍）——画面在这里落，音乐在这里打
export const HIT = {
  ring:      ['s0', 0], s0_button: ['s0', 1],
  g1_cmd:    ['g1', 0], g1_wobble: ['g1', 1], g1_drop: ['g1', 2], g1_run: ['g1', 2], g1_catch: ['g1', 4], g1_cheer: ['g1', 5],
  s1_stamp:  ['s1', 0], s1_button: ['s1', 1],
  g2_cmd:    ['g2', 0], g2_dash: ['g2', 1], g2_zip: ['g2', 2], g2_pour: ['g2', 3], g2_drip: ['g2', 4],
  s2_stamp:  ['s2', 0], s2_crack: ['s2', 1],
  g3_cmd:    ['g3', 0], g3_b1: ['g3', 1], g3_b2: ['g3', 2], g3_b3: ['g3', 3], g3_b4: ['g3', 4], g3_shine: ['g3', 5],
  s3_stamp:  ['s3', 0], s3_speed: ['s3', 1], s3_out: ['s3', 3],
  g4_cmd:    ['g4', 0], g4_crouch: ['g4', 1], g4_slap: ['g4', 2], g4_dark: ['g4', 3],
  s4_stamp:  ['s4', 0], s4_cut: ['s4', 1], s4_hb1: ['s4', 2], s4_hb2: ['s4', 3],
  boss_slam: ['boss', 0], boss_cmd: ['boss', 1], boss_bonk: ['boss', 2], boss_catch: ['boss', 3], boss_slap: ['boss', 4], boss_dark: ['boss', 5],
  end_snap:  ['end', 0], end_ring: ['end', 0], end_yawn: ['end', 1], end_sleep: ['end', 2], end_last: ['end', 3],
};
export const hf = k => bf(...HIT[k]);
export const ht = k => bt(...HIT[k]);
