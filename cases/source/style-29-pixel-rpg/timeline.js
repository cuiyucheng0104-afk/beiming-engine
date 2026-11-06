// timeline.js — 全片唯一时间源。画面（main.js）、配乐与拟音（mix.py，经 timeline.json）、拍点核对（tools/cuecheck.py）都读这里。
// A 段：96 BPM 3/4（1 拍 = 15 帧）；B 段起：144 BPM 4/4（1 拍 = 10 帧，1 小节 = 40 帧）。所有拍点都是整帧，帧 = 秒 × 24。
export const FPS = 24;
export const A = { f0: 0, bpm: 96, meter: 3, fpb: 15, beats: 6 };
export const B = { f0: 90, bpm: 144, meter: 4, fpb: 10, bars: 10 };
export const fA = n => A.f0 + n * A.fpb;                       // A 段第 n 拍
export const fB = (bar, beat = 0) => B.f0 + bar * B.meter * B.fpb + beat * B.fpb;   // B 段 小节:拍（beat 可为 0.5 = 八分）
export const NFRAMES = 470;
export const DUR = NFRAMES / FPS;                               // 19.5833 s
export const sec = f => f / FPS;

// 视觉事件 → 落在哪一拍（cuecheck 用）
export const CUE = {
  open:      fA(0),
  step1:     fA(1), step2: fA(2), step3: fA(3),
  stop:      fA(4),     // 勇者停步，宝箱闪光
  push:      fA(5),     // ×2 快推，伸手
  chomp:     fB(0, 0),  // 咬合；速度 96→144
  swirl:     fB(0, 1),  // 遇敌漩涡开始
  battle:    fB(1, 0),  // 战斗画面
  msg1:      fB(1, 1),  // “宝箱怪 出现了！”打字落定
  cursor:    fB(2, 0),  // 光标出现
  tremble:   fB(3, 0),  // “它在发抖…”；光标停跳
  cur1:      fB(3, 1),  // 攻击→魔法
  cur2:      fB(3, 2),  // 魔法→对话
  select:    fB(3, 3),  // 选定“对话”
  heart:     fB(4, 2),  // 心跳 + 脸红 + 对话框
  line:      fB(5, 0),  // “……给你。”落定，▼
  spit:      fB(5, 0),  // 吐钥匙
  catch:     fB(5, 2),  // 接住；“获得 钥匙！”落定
  status:    fB(6, 0),  // 状态窗 + EXP
  hush:      fB(6, 3),  // 第二次静默
  levelup:   fB(7, 0),  // LEVEL UP!
  phrase2:   fB(8, 0),
  mosaic:    fB(8, 2),  // 马赛克峰值，切回地牢
  final:     fB(9, 0),  // 收束 + 冒心
};
// 真零静默窗口（帧）
export const SILENCE = [[fB(3, 3) + 3, fB(4, 2)], [fB(6, 3), fB(7, 0)]];
