// 《落成之夜》唯一时间源。144 BPM，4/4，1 拍 = 0.41667 s = 整 10 帧（24 fps）。
// 画面（film.js）、配乐（music/score.py）、拟音（mix.py）、拍点核对（tools/cuecheck.py）都读这里（经 tools/dump_timeline.mjs → timeline.json）。
export const BPM = 144, FPS = 24;
export const B = 60 / BPM;                 // 一拍（秒）
export const BAR = 4 * B;
export const bt = b => b * B;              // 拍 → 秒
export const DUR_BEATS = 46;
export const DUR = DUR_BEATS * B;          // 19.1667 s

// 段落（拍）
export const SEC = { A: 0, B: 10, C: 20, D: 27.5, E: 32, END: 46 };

// 楼层：拍 → 标签（指针逐格上升：二分 → 四分 → 八分，分拍加速）
export const FLOORS = [
  [10, '1'], [12, '10'], [14, '20'], [15, '30'], [16, '40'], [17, '50'],
  [18, '60'], [18.5, '70'], [19, '80'], [19.5, '90'], [20, '顶'],
];

// 关键拍点（拍）。每一项都在画面里有一个可见动作，在配乐里有一个音乐事件
export const HIT = {
  ignite: 0,          // 地基金点点燃
  unfold: 4,          // 立面从中轴向两侧展开（单簧管滑音落点 + 铜管和弦）
  step1: 5, step2: 6, step3: 7,   // 三级退台
  ray0: 8, ray1: 8.5, ray2: 9, ray3: 9.5,   // 楼冠日芒（中 → 两侧）
  cutDial: 10,        // 匹配剪：日芒 → 表盘
  ding: 20,           // 指针到“顶”，电梯叮
  latch1: 22, latch2: 23,   // 门闩一响、二响
  doorsOpen: 24,      // 双门对开（全奏）
  doorsStop: 26,      // 门到底回弹
  cutoff: 27,         // 乐队切断
  rocket: 29,         // 火箭升空
  burst1: 32, burst2: 34, burst3: 36,   // 三朵烟花（递进）
  lock: 40,           // 万花筒咬合成徽章，1929 落定
  sheen: 42,          // 光泽扫过
  final: 44,          // 全部灯泡亮起，收尾
};
// b36–b40 每个八分音符一记“机械咬合”星火（满）
export const SPARKS = [36.5, 37, 37.5, 38, 38.5, 39, 39.5];
