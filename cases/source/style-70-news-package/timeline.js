// 《本周天气》唯一时间源：120 BPM 拍网格，t = T0 + k·SPB（k 可为 0.25 的倍数 = 16 分音符）。
// main.js 的所有动画落点、window.EV 的所有声音事件、mix.py 的所有乐句都从这里取数。
window.TL = (() => {
  const BPM = 120, T0 = 0.25, SPB = 60 / BPM, FPS = 24;
  const B = k => Math.round((T0 + k * SPB) * 10000) / 10000;
  // 关键拍点（k）：每个剪切、关键动作、文字落定
  const K = {
    slam: 0, letters: [0.5, 0.75, 1.0, 1.25], wordmark: 2, glint: 3, fly: 3.5, bugLand: 4.5,
    wipeRundown: 5, rows: [6, 7, 8], hl: 9, wk: 10, next1: 11, dim: 12,
    wipeTyphoon: 13, strapIn: 13.5, eyebrow: 14, name: 15, sonar: 16,
    cutSpec: 17, title: 17.5, thr: 18, bar: 19, badge: 19.5, cells: [20, 20.25, 20.5, 20.75], stamp1: 21, chipIn: 18.5, chip: 22,
    press: 21.5,            // 中心气压读数（JMA 905 hPa）从遮罩推上，k20.5 起计数
    wipeRecap1: 23, tick1: 24,
    cutCold: 25, measure: 26, cutAurora: 27, label: 28,
    wipeRecap2: 29, tick3: 29.5,   // 第 2、3 行同拍打勾
    next2: 30,              // 串联单插入追加条「寒潮后续」+ NEXT
    wipeBoard: 31,          // 音乐在此整体抽空：k31–k33 = 1 s 静默
    tremble: 32,            // 静默中的牌面轻颤（无声）
    flip: 33,               // 全片最重一击
    settle: [33.5, 33.75, 34], delta: 34, stamp2: 35, rule: 36,
    end: 37,                // 角标闪光 + 「本周三条 · 已播完」收束条推入（属和弦）
    doneTicks: [37.25, 37.5, 37.75],
    button: 38,             // 收束：三格同时亮起 + 光带 + D 大调齐奏
    dur: 39,
  };
  const WIPE = 0.3;         // 竖向色带擦除时长：色带在 [B(k)-0.3, B(k)] 扫过，k 为落点
  return { BPM, T0, SPB, FPS, B, K, WIPE, DUR: B(K.dur) };
})();
