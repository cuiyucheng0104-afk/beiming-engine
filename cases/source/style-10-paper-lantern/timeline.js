// 唯一时间源：拍点网格 + 每个事件落在哪一拍。画面（src/main.js）、配乐与拟音（mix.py 经 events.json）、核对（tools/cuecheck.py）都读这里。
// 96 BPM，4/4。第 6 小节渐慢（拍距 0.65 → 0.75），13.9 停车后延长记号（近静默），第 7 小节 15.0 回原速。
export const BPM = 96;
export const Q = 60 / BPM;            // 0.625 s 一拍
export const E8 = Q / 2;              // 0.3125 s 八分
export const DUR = 19.75;
export const FPS = 30;

// 拍点（秒）：k = 0..31
export const BEATS = [];
for (let k = 0; k <= 20; k++) BEATS.push(+(k * Q).toFixed(4));           // 0 … 12.5（第 1–5 小节 + 第 6 小节强拍）
BEATS.push(13.15, 13.9);                                                   // 渐慢
for (let k = 23; k <= 31; k++) BEATS.push(+(15 + (k - 23) * Q).toFixed(4)); // 15.0 起回原速
export const BAR = k => BEATS[k];                                          // 小节 n 的强拍 = BEATS[4(n-1)]（第 6 小节只有 3 拍 + 延长）

const e8 = (k, i) => +(BEATS[k] + i * E8).toFixed(4);

// 视觉/声音事件 —— 每一项都必须落在拍点或八分音上
export const HIT = {
  click: BEATS[2],                                  // 1.25 开关咔哒，光源亮
  layers: [0, 1, 2, 3, 4, 5].map(i => e8(4, i)),    // 2.5 起六层按八分依次透光
  train1: BEATS[8],                                 // 5.0 火车从最远层探出 + 远汽笛
  hop2: BEATS[10],                                  // 6.25 跳到第二层
  hop3: BEATS[12],                                  // 7.5 跳到近层
  tunnel: BEATS[14],                                // 8.75 进隧道
  windows: [0, 1, 2, 3, 4, 5].map(i => e8(16, i)),  // 10.0 起车窗一格一格亮
  exit: BEATS[20],                                  // 12.5 出隧道 + 汽笛
  brake: BEATS[21],                                 // 13.15 刹车
  stop: BEATS[22],                                  // 13.9 停车、音乐切断
  house: BEATS[23],                                 // 15.0 小屋窗亮（静默后第一声）
  door: BEATS[24],                                  // 15.625 门开
  arms: BEATS[25],                                  // 16.25 张开双臂
  title0: BEATS[26],                                // 16.875 纸条开始长
  title1: BEATS[27],                                // 17.5 纸条长成 + 盖印
  last: BEATS[29],                                  // 18.75 最后一个音
};

// 铁轨咔嗒：四分（5.0–6.25）→ 八分（6.25–10）→ 十六分（10–12.5）→ 渐慢（12.5–13.9）
export const CLACKS = (() => {
  const a = [];
  for (let t = 5.0; t < 6.25 - 1e-6; t += Q) a.push(+t.toFixed(4));
  for (let t = 6.25; t < 10 - 1e-6; t += E8) a.push(+t.toFixed(4));
  for (let t = 10; t < 12.5 - 1e-6; t += E8 / 2) a.push(+t.toFixed(4));
  a.push(12.5, 12.825, 13.15, 13.525, 13.9);       // 第 6 小节：八分音随渐慢拉宽
  return a;
})();

// 近静默区间
export const SILENCE = [HIT.stop + .35, HIT.house];
