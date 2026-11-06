// 《会用工具的海獭》唯一时间源：画面（index.html/main.js）、配乐与拟音（audio/mix.py）、拍点核对（tools/cuecheck.py）都读这里。
// 120 BPM：拍 = 0.5 s = 15 帧（30 fps），小节 = 2 s。所有剪切与关键动作落在半拍网格上；字幕块间隔 4 帧（0.1333 s）。
(function () {
const FPS = 30, BPM = 120, BEAT = 0.5, BAR = 2.0, CHUNK = 4 / 30;
const TL = {
  fps: FPS, bpm: BPM, beat: BEAT, bar: BAR, chunk: CHUNK, dur: 19.5,
  // 镜头（剪切点）
  shots: [
    { a: 0.0, b: 1.0, k: 'hook', cr: '照片 David Ledig / BLM · 公有领域' },
    { a: 1.0, b: 2.5, k: 'bite', cr: '照片 David Ledig / BLM · 公有领域' },
    { a: 2.5, b: 4.0, k: 'raft', cr: '照片 Lilian Carswell / USFWS · 公有领域' },
    { a: 4.0, b: 7.0, k: 'fig', cr: '图 K. W. Kenyon / USFWS · 1969 · 圈养个体' },
    { a: 7.0, b: 10.5, k: 'doc33', src: '美国内政部 生物报告 90(14) · 1990 · 第33页' },
    { a: 10.5, b: 14.0, k: 'wean', cr: '照片 Lilian Carswell / USFWS · 公有领域' },
    { a: 14.0, b: 15.5, k: 'doc35', src: '美国内政部 生物报告 90(14) · 1990 · 第35页' },
    { a: 15.5, b: 17.5, k: 'mompup', cr: '视频截帧 Lara Drizd / USFWS · 公有领域' },
    { a: 17.5, b: 19.5, k: 'raftout', cr: '照片 Lilian Carswell / USFWS · 公有领域' },
  ],
  // 字幕卡：zh 用 | 分块、{} 标黄色关键词；每块在 t0 + i*CHUNK 砸入
  caps: [
    { t0: 1.0, t1: 4.0, zh: '咬不动|怎么办？', en: 'Too hard to bite?' },
    { t0: 4.0, t1: 6.8333, zh: '它会用|{工具}', en: 'It uses a tool.' },
    { t0: 7.0, t1: 10.5, zh: '鲍鱼壳|{八成}带砸痕', en: '~80% of abalone shells were hit.' },
    { t0: 11.0 + 4 / 30, t1: 14.0, zh: '它|从{哪}学的？', en: 'Where did it learn?', quiet: true, hotAt: 12.5 },
    { t0: 14.0, t1: 17.5, zh: '女儿砸法|随{妈妈}', en: "Daughters use mom's method." },
  ],
  // 关键动作（画面）——每个都有拟音；music:true 的同时是配乐下锤点
  hits: {
    hook: 0.1,            // 第 4 帧：冲击推近 + 80% 黄块落下，0.45 s 滚到终值（0.55）
    hookKicker: 0.2333,   // “鲍鱼壳”砸入（第 7 帧）
    hookWord: 0.3667,     // “带砸痕”砸入（第 11 帧）
    chip: 1.0,            // 钩子数字缩成左上角数据条，留到 4.0
    chipOut: 4.0,
    bug: 0.5,             // 频道角标滑入
    punch: 4.5,           // Kenyon 图：推近到胸口
    circle: 4.5,          // 画圈 0.3 s
    label: 4.6,           // “石头”标签
    inset: 5.0,           // 2× 局部放大插图（0.3 s 弹出）
    cardIn: 6.8333,       // 纸页从右滑入（0.1667 s，7.0 落定）
    paper: 7.0,           // 纸页落定 + 来源标签
    mark33: [7.5, 7.7667, 8.0],   // 三行荧光笔
    numPop: 8.5,          // 开头那块 80% 从左上角飞回来，引线指向划线句，9.0 落定
    stamp: 9.0,           // 落定盖章
    freeze: 11.0,         // 定格
    brackets: 11.1,
    nudge: 12.5,          // 屏息中段：微推 + 角框收紧 + “哪”上黄块
    answer: 14.0,         // 静默后的第一声
    mark35: [14.5, 14.7667],
    pullout: 17.5,
  },
  music: {
    silences: [[11.0, 14.0]],     // 真静默（只有水声与问句的两下 tick）
    stopBeat: [6.5, 6.8333],      // 近静默：停一拍
    build: [10.0, 11.0],          // 军鼓加花加速
    jcut: [10.7, 17.25],          // 水声提前进
    swell: [13.5, 14.0],          // 静默尾巴：极轻的反向镲/气声，托住 14.0 的第一声
  },
};
if (typeof module !== 'undefined') module.exports = TL; else window.TL = TL;
})();
