// 《大坝》唯一时间源。画面 (index.html)、配乐与拟音 (mix.py，经 events.json)、拍点核对 (cuecheck.py) 都读这里。
// 120 BPM：1 拍 = 0.5 s，1 小节 = 2 s，16 分音符 = 0.125 s = 3 帧（24 fps），所以网格上的每个点都是整帧。
export const BPM = 120, BEAT = 60 / BPM, FPS = 24;
export const b = n => n * BEAT;                       // 拍 → 秒

// 段落起点（拍）
export const SEC = { doc: 0, chart: 6, count: 16, build: 24, silence: 28, hit: 30, end: 39 };
export const DUR = b(SEC.end);                        // 19.5 s

// 段落内的事件（拍）
export const CUE = {
  docLand: 1,            // 文件页砸落（0→1 拍红带与文件沿轴滑入）
  markA: 1, markB: 1.75, // 红马克笔划过那一行
  block: 2,              // 红块 "221 米" 砸出
  jump: 4,               // 跳切 1.2× + 闪白
  wipe: 5.5,             // 红色擦除带 5.5→6
  turn: 6,               // 纸底图表；那一行转下来变成地平线
  bar1: 6.5,             // 墨柱 日均 3,500 长出 6.5→7.5（翻页后半拍就开始长，不留空画面）
  bar2: 9,               // 红柱 最多一天 5,218 长出 9→10
  num2: 10,              // "5,218 人" 砸出
  tilt: 11,              // 镜头沿红柱上摇 + 铜管动机
  rollIn: 15,            // 定音鼓滚奏进入数众人
  titleCell: 16,         // 格子墙：标题格"建坝的人"
  count: 23,             // "21,000 人" 落定
  silence: 28,           // 一切切断
  rivet: 28.5,           // 一颗红铆钉（几乎无声）
  hit: 30,               // 最重一击：坝 + 红"坝"
  eng: 31,               // HOOVER DAM · 1931–1935
  numH: 32,              // "221 米"
  restamp: 34,           // 红底重盖 "21,000 人"
  restamp2: 36,          // 红带再砸一次 + 坝体窗口闪白一帧（减速里的落点）
  end: 38,               // 一颗红铆钉钉在最后（收在铆钉重音上，之后只剩余响）
};
// 数众人：11 个影像格，1 拍 → 1/2 拍 → 1/4 拍加速
export const CELLS = [17, 18, 19, 20, 20.5, 21, 21.5, 22, 22.25, 22.5, 22.75];
// 人搭结构：8 刀，A=人 / B=混凝土块交替，1 拍 → 1/2 → 1/4 加速；每刀垒起坝体的一层
export const FLOORS = [24, 25, 26, 26.5, 27, 27.25, 27.5, 27.75];

export const secs = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, b(v)]));
