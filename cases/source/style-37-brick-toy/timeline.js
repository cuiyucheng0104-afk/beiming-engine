// 唯一时间源：118 BPM 节拍网格。所有剪切、动作落定、配乐音符、拟音都从这里取时间。
// 网格量化到 24 fps 帧：beat 的时刻 = round(b·60/118·24)/24，于是画面事件和声音都落在同一帧上（0 ms 偏差），
// 平均速度仍是 118 BPM，单拍误差 ≤ ±21 ms（相当于演奏者的自然人性化）。
export const BPM = 118, FPS = 24, ANIM_FPS = 12;
export const SPB = 60 / BPM;                         // 0.508475 s
export const B = b => Math.round(b * SPB * FPS) / FPS;   // 拍 → 秒（帧对齐）
export const DUR = 19.25;
// 定格：角色和砖块按 12 fps 步进（on twos）；相机/焦点 24 fps 平滑
export const q = t => Math.floor(t * ANIM_FPS + 1e-6) / ANIM_FPS;
// 相对某个事件起点步进（事件落点本身是精确帧）
export const qr = (t, t0) => t < t0 ? t : t0 + Math.floor((t - t0) * ANIM_FPS + 1e-6) / ANIM_FPS;

// 镜头（在拍点上切）
export const SHOTS = [
  { id: 'S1', b0: 0, name: 'rack' },     // 微距跟焦：杯子 → 小屋
  { id: 'S2', b0: 4, name: 'door' },     // 小人视线高度横移
  { id: 'S3', b0: 8, name: 'tip' },      // 桌震、杯倒（手持 + 摇）
  { id: 'S4', b0: 12, name: 'wave' },    // 水撞屋，崩塌
  { id: 'S5', b0: 16, name: 'alone' },   // 静默大全景
  { id: 'S6', b0: 20, name: 'orbit' },   // 环绕拼船
  { id: 'S7', b0: 29, name: 'reveal' },  // 跟拍 → 摇臂拉远
];
export const shotAt = t => { let s = SHOTS[0]; for (const x of SHOTS) if (t >= B(x.b0)) s = x; return s; };
export const shotSpan = s => { const i = SHOTS.indexOf(s); return [B(s.b0), i + 1 < SHOTS.length ? B(SHOTS[i + 1].b0) : DUR]; };

// 关键动作拍点
export const HIT = {
  focus: 2,          // 跟焦落在「家」字砖
  step1: 4, step2: 5, step3: 6,    // 出门三步
  stretch: 7,        // 伸懒腰 V 字
  bump: 8,           // 桌子一震
  wobble: 9,         // 杯子晃
  tip: 10,           // 杯子翻倒开始
  cupLand: 11,       // 杯口砸到桌面，水涌出
  wave: 12,          // 水浪撞屋 → 崩塌
  raft: 14,          // 小人落到屋顶板上
  silence: 16,       // 音乐全停
  drip: 17,          // 一滴水
  first: 18,         // 第一声咔哒（全片最重要的声音）
  chord: 28,         // 「家」字砖插上桅杆 → 大和弦
  hop: 29,           // 小人跳上船
  row: [30, 32, 34], // 三桨
  end: 36,           // 拉远停住 + 钢片琴叮
};

// 重建：每个落点（拍号）和落下的零件（id 见 house.js）。二分 → 四分 → 八分 → 十六分：加速
export const BUILD = [
  [18, ['floor']],
  [20, ['L1b']], [21, ['L2b']], [22, ['L1sL', 'L1sR']], [23, ['L3b']],
  [24, ['L4b']], [24.5, ['L2sL', 'L2sR']], [25, ['R3', 'rud']], [25.5, ['L1fL', 'L1fR']],
  [26, ['L2fL', 'wR', 'wL']], [26.5, ['ch0']], [27, ['ch1']], [27.25, ['ch2']], [27.5, ['ch3']], [27.75, ['step']],
  [28, ['tile']],
];

// 锚定步进：12 fps 的"张"从下一个锚点（拍点）往回数，于是每个关键姿势恰好落在锚点那一帧；
// 锚点之后从锚点往前数。anchors 需升序。
export function qa(t, anchors) {
  let prev = null, next = null;
  for (const a of anchors) { if (a <= t + 1e-9) prev = a; else { next = a; break; } }
  if (next !== null) { const s = next - Math.ceil((next - t) * ANIM_FPS - 1e-6) / ANIM_FPS; return prev !== null ? Math.max(s, prev) : s; }
  if (prev !== null) return prev + Math.floor((t - prev) * ANIM_FPS + 1e-6) / ANIM_FPS;
  return q(t);
}
