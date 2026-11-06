// 唯一时间源：速度、拍号、画面关键事件所在的拍。画面（film.js）、配乐与拟音（mix.py）、核对（cuecheck.py）都读这里。
// 96 BPM：一拍 = 0.625 s = 15 帧（24 fps），一小节 = 2.5 s = 60 帧 → 每个拍点都落在整帧上。
export const BPM = 96, FPS = 24;
export const BEAT = 60 / BPM, BAR = BEAT * 4;
export const BEATS = 31;                       // 7 小节 + 3 拍
export const DUR = BEATS * BEAT;               // 19.375 s
export const B = n => +(n * BEAT).toFixed(6);

// 关键画面事件 → 全局拍号（B0 = 0 s）
export const HIT = {
  ignite: 0,    // 黑场里一个热点亮起 → 种子点云
  hud: 1,       // HUD 角括号、左上标题卡入
  scan: 2,      // 扫描线开始自上而下读出种子
  sprout: 4,    // 种子读完（白闪）；种子线框开始缓动下落；琶音进入
  land: 6,      // 种子落到投影台中心（闷击）；扫描平面上行擦除种子 → 根与树干长出；对数拉远开始
  chip1: 6,     // 数据片：物种
  chip2: 8,     // 数据片：根深（琶音变十六分 = 加速）
  chip3: 10,    // 数据片：树高
  chip4: 11,    // 数据片：冠幅（叶簇点亮）
  whip: 12,     // 甩镜开始
  box: 13,      // 目标框放大出现
  lock: 14,     // 锁定年轮
  leader: 15,   // 引线到卡
  explode: 16,  // 局部爆炸
  ageRoll: 17,  // 树龄开始滚动
  moist: 18,    // 含水率落定
  close: 20,    // 年轮合拢，音乐半速（减速）
  freeze: 22,   // 冻结；真数字静默开始
  open: 24,     // 120 年定格；和弦打开（静默后第一声）
  beam: 26,     // 光束亮起
  crown: 28,    // 光波到达树冠
  echo: 30,     // 树冠里一颗新种子亮起
};
export const T = Object.fromEntries(Object.entries(HIT).map(([k, v]) => [k, B(v)]));
export const SILENCE = [[B(22), B(24)]];        // 真数字静默（含环境声）
export const SECTIONS = [
  { id: 'intro', b0: 0, b1: 4 }, { id: 'grow1', b0: 4, b1: 8 }, { id: 'grow2', b0: 8, b1: 12 },
  { id: 'lock', b0: 12, b1: 16 }, { id: 'explode', b0: 16, b1: 20 }, { id: 'hold', b0: 20, b1: 24 },
  { id: 'open', b0: 24, b1: 31 },
];
export function timelineJSON() {
  return { bpm: BPM, fps: FPS, beat: BEAT, bar: BAR, beats: BEATS, dur: DUR, hit: HIT, t: T, silence: SILENCE, sections: SECTIONS };
}
