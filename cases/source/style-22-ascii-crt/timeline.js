// whale.exe 的唯一时间源：画面（main.js）、配乐（score.py）、拟音（mix.py）、拍点核对（tools/cuecheck.py）都读这里。
// 速度：每拍正好 13 帧 @24fps → 110.769 BPM（分镜要求 110 BPM，取最近的整帧速度，整拍事件全部落在帧上）。
export const FPS = 24;
export const BEAT_FRAMES = 13;
export const BEAT = BEAT_FRAMES / FPS;          // 0.541667 s
export const BPM = 60 / BEAT;                   // 110.769
export const BAR = 4 * BEAT;                    // 4/4
export const b = n => n * BEAT;                 // 拍 → 秒
export const fb = n => Math.round(n * BEAT_FRAMES) / FPS;   // 非整拍（16 分等）→ 吸附到最近的帧

// 关键事件（单位：拍）
export const CUE = {
  power: 0,      // CRT 开机：点→线→面
  type0: 1,      // 人手开始敲 ./whale.exe
  enter: 4,      // 回车，音乐进入
  out0: 4.25,    // 机器打出句子
  shatter: 10,   // 句子碎成字粒
  sea: 12,       // 海完整，滚屏开始
  pull0: 16,     // 拉远开始
  song: 20,      // 远处鲸歌
  drop: 22,      // 数字零静默
  breach: 24,    // 鲸跃出：静默后第一声
  apex: 26,      // 顶点，喷水（琥珀）
  cyan: 28,      // 水柱变冰青：唯一第二色，唯一大三和弦
  land: 29,      // 鲸落回海里
  log: 31,       // LOG：whale.exe 后面打出 exited 0
  bel: 32,       // BEL
  off: 35,       // 关机
  dot: 36,       // 收成亮点
};
export const DUR = 19.875;                       // 477 帧；亮点余辉留到最后一帧

// 人手敲击：./whale.exe 每个键的拍位（16 分/32 分网格上的不均匀分组：快、停、快、长停、快）
export const TYPING = [
  ['.', 1.0], ['/', 1.25], ['w', 1.5], ['h', 1.75],
  ['a', 2.5], ['l', 2.75], ['e', 3.0],
  ['.', 3.5], ['e', 3.625], ['x', 3.75], ['e', 3.875],
];
export const OUT_DT = 1 / 8;                    // 机器打字：32 分音符/字（句子是"台词"，按音符值放慢）
export const LOG_DT = 1 / 16;                   // LOG 机器速打：64 分/字

// 音乐小节表（score.py 用）
export const SECTIONS = [
  { id: 'boot', b0: 0, b1: 4 },
  { id: 'line', b0: 4, b1: 10 },
  { id: 'form', b0: 10, b1: 12 },
  { id: 'sea', b0: 12, b1: 16 },
  { id: 'pull', b0: 16, b1: 22 },
  { id: 'hush', b0: 22, b1: 24 },
  { id: 'breach', b0: 24, b1: 28 },
  { id: 'cyan', b0: 28, b1: 32 },
  { id: 'exit', b0: 32, b1: 36.69 },
];
