// timeline.js — 全片唯一时间源。画面（main.js）、配乐/拟音（mix.py 读 events.json）、核对（tools/cuecheck.py）都用这里的数字。
// 一拍 = 13 帧 = 13/24 s（≈110.8 BPM，分镜原定 112 BPM 的最近整帧速度），所以每个拍点都正好落在帧上。
export const FPS = 24, BF = 13, B = BF / FPS;
export const bt = b => b * B;                 // 拍 → 秒
export const DUR = 474 / FPS;                 // 19.75 s（最后一拍 b35 之后留笑声尾巴）

// 镜头表：[起始拍, id]
export const SHOTS = [
  [0, 'aisle'],      // 1  横移跟拍走廊
  [6, 'door'],       // 2  同机位中景：开门 #1
  [8, 'tallCU'],     // 2a 高瘦反应近景
  [9, 'door'],       // 2b 关门 #1（切回即砸门）→ 开门 #2
  [11, 'shortCU'],   // 3  甩镜到矮胖反应
  [12, 'hesitate'],  // 4  关门 #2 + 慢推 + 犹豫
  [14, 'insert'],    // 5  开门 #3：冰冻宇宙特写 + 震
  [16, 'react'],     // 6  双人反应近景
  [17, 'dead'],      // 7  死寂，极慢推
  [21, 'suck'],      // 8  吸气 + 急推
  [23, 'wipe'],      // 9  旋涡划像
  [24, 'inside'],    // 10 冰冻宇宙内部
  [27, 'belt'],      // 11 收银台：落上传送带，静默 2
  [29, 'scan'],      // 12 扫码特写：哔、哔
  [32, 'end'],       // 13 收尾后拉
];

// 关键拍点（画面事件 = 音乐拍点）
export const HIT = {
  theremin: 2, truckStop: 4, point: 4, grab: 6, open1: 7, cutTall: 8, slam1: 9, open2: 10, whip: 11, slam2: 12,
  shrug: 13, open3: 14, react: 16, cut1: 17, gulp: 19, inhale: 21, lift: 22, wipe: 23, inside: 24,
  freeze: 25, spit: 26, land: 27, cut2: 27, pickup: 29, beep1: 30, beep2: 31, total: 32, laugh: 32, pop: 34, blink: 35,
};

// 配乐段落（拍）
export const SECTIONS = [
  { id: 'A_muzak', b0: 0, b1: 6 }, { id: 'B_doors', b0: 6, b1: 17 }, { id: 'C_dead', b0: 17, b1: 21 },
  { id: 'D_suck', b0: 21, b1: 27 }, { id: 'E_quiet', b0: 27, b1: 30 }, { id: 'F_beep', b0: 30, b1: 36.46 },
];
