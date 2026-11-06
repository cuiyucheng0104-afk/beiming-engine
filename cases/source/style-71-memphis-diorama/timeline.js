// 冰淇淋车 · 唯一时间源。画面（main.js）、事件（window.EV → events.json）、配乐与拟音（mix.py）、拍点核对（tools/cuecheck.py）都从这里取数。
// 一拍 = 30 帧 @60 fps（BPM 120），八分音符 = 15 帧：每个拍点、八分音符点都正好落在整数帧上，画面与音乐可以 0 ms 对齐。
export const FPS = 60;
export const BEAT = 30 / 60;                 // 0.5 s
export const BPM = 60 / BEAT;                // 120
export const b = (n) => n * BEAT;            // 拍号 → 秒
export const BAR0 = 6;                       // 乐队第 1 小节的下拍（b6）；小节线 b6, b10, b14 …

// 关键拍（拍号；可为 .5 八分音符）
export const CUE = {
  frameOpen: 0, frameFull: 2,
  truckBrake: 4, truckSquat: 5.5, truckStop: 6,          // 车刹停点头 = 乐队进
  wave1: 6, horn: 10, wave2: 10,                          // 两圈波浪
  push: 12.5,                                             // 推近车侧
  lidOut: 14, lidUp: 15,                                  // 侧板两步走：先外移，再升走
  cream: 16, cone: 18, sprinkle: 20, finished: 22,         // ①奶油 ②甜筒 ③撒糖 → 成品
  calloutsOut: 25, lidDown: 25.5, lidIn: 26,              // 侧板落回；b26 合上＝全曲停
  musicStop: 26, squatStart: 27, squatDeep: 29.5,         // 静默里蓄力
  pop: 30, wave3: 30,                                     // 静默后第一声：巨型冰淇淋弹出
  bounce1: 31, bounce2: 32, callout: 32,                  // 两次回弹；"今日限定"
  cadence: 36, close: 36, end: 38.5,
};
export const DUR = b(CUE.end);               // 19.25 s

export const SECS = [
  { id: 'intro', b0: 0, b1: 6 }, { id: 'wave', b0: 6, b1: 14 }, { id: 'cutaway', b0: 14, b1: 26 },
  { id: 'silence', b0: 26, b1: 30 }, { id: 'pop', b0: 30, b1: 34 }, { id: 'outro', b0: 34, b1: 38.5 },
];

// 波浪：从车停的位置出发，每 8 分音符走 WAVE_STEP 米；道具径向吸附到这些圆环上，所以每个道具都在 8 分音符上被波浪打到
export const TRUCK_STOP = [-1.0, 16.0];      // 车厢中心停在 (x, z)
export const WAVE_V = 24;                    // m/s
export const WAVE_STEP = WAVE_V * BEAT / 2;  // 6 m / 8 分音符
export const WAVES = [CUE.wave1, CUE.wave2, CUE.wave3];
