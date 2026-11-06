// 唯一时间源：130.909 BPM = 每拍正好 11 帧 @24fps，所有视觉事件都落在整拍 → 整帧
export const FPS = 24, FPB = 11;
export const BEAT = FPB / FPS;             // 0.458333 s
export const BPM = 60 / BEAT;              // 130.909
export const B = b => b * BEAT;            // 拍 → 秒（拍号从 0 起）
export const DUR = 478 / FPS;              // 19.9167 s（第 43.45 拍）

// 段落（起始拍）
export const SEC = {
  fall: 0,      // A 坠入：斜格 + 翻滚下字阶
  lens: 7,      // B1 窥镜巨圆
  file: 9,      // B2 〇 / 第〇号档案
  chase: 16,    // C 横移追逐
  freeze: 24,   // 定格（真静音）
  resume: 26,   // 恢复
  safe: 27,     // D 转盘
  title: 33,    // E 铜管长音 + 门开 + 片名
};

// 每个视觉事件 = 一个音乐拍点（拍号）。cuecheck.py 逐条核对
export const HIT = {
  open: 0,                 // 开场铜管一刀，斜线切入
  credit: 1,               // 「零点情报局」沿斜线滑入定死
  land1: 2, land2: 4, land3: 6,   // 翻滚着地
  lens: 7,                 // 硬切：巨圆
  turn: 8,                 // 圆中剪影转头
  match: 9,                // 圆 → 〇，「第」「号档案」定死
  role: 10,                // 「原著」弹出
  peek: 12,                // 帽檐探出
  rival: 13,               // 对手出现
  dive: 14,                // 特工纵身跳进〇
  push: 15,                // 冲进〇开始
  chase: 16,               // 追逐开始（〇内圈 = 新场的底）
  sw1: 20, sw2: 22, sw3: 23,   // 底色切换（间隔 4→2→1）
  freeze: 24,              // 定格
  blink: 25,               // 眨眼
  resume: 26,              // 恢复
  safe: 27,                // 硬切到保险箱 + 落地
  click1: 28, click2: 29, click3: 31,   // 转盘停格（减速）
  door: 33,                // 门开 + 长音（静默后第一声）
  title: 34,               // 片名拼定
  rivalIn: 38,             // 对手跑入
  skid: 40,                // 急停
  button: 41,              // 收尾短音 + 帽子弹起
  hatLand: 42,             // 帽子扣在「点」的〇上 → 全画面定格
};
export const T = Object.fromEntries(Object.entries(HIT).map(([k, b]) => [k, B(b)]));
