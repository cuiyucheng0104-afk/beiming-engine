// 《追帽子》唯一时间源：画面、配乐、拟音、拍点核对都读这里。
// 每段接在上一段之后；拍号在该段速度下计。所有拍点都是整帧（120=12帧/拍，144=10帧/拍，90=16帧/拍）。
export const FPS = 24;

// [name, bpm, beats, cue-sheet mood]
const SECS = [
  ['WALK',  120, 5,   'Allegretto rag（体面散步）'],
  ['CHASE', 144, 17,  'Hurry（追逐，b14 起 undercrank）'],
  ['CARD1',  90, 4,   'Misterioso（那顶帽子……）'],
  ['SIL',    90, 1.5, '静默（只有放映机）'],
  ['REVEAL', 90, 3,   'Scherzando 揭晓'],
  ['CARD2',  90, 4.5, 'Scherzando 主题（原来是猴子的）'],
  ['END',    90, 2.5, '收束：举帽、光圈合、幕合'],
];

export const SEC = {};
let t = 0;
for (const [name, bpm, beats, mood] of SECS) {
  const beat = 60 / bpm, dur = beat * beats;
  SEC[name] = { name, bpm, beats, beat, t0: t, t1: t + dur, dur, mood };
  t += dur;
}
export const DUR = +t.toFixed(4);
export const at = (name, b = 0) => SEC[name].t0 + b * SEC[name].beat;
export const secAt = tt => { for (const k in SEC) if (tt < SEC[k].t1 - 1e-9) return SEC[k]; return SEC.END; };
export const beatIn = (name, tt) => (tt - SEC[name].t0) / SEC[name].beat;

// 命名拍点：[段, 拍]。画面落在这些点上，配乐与拟音写在这些点上，cuecheck 逐一核对。
export const HITS = {
  start:    ['WALK', 0],
  tip:      ['WALK', 2],    // 举帽致意
  gust:     ['WALK', 3],    // 风卷走帽子
  land:     ['WALK', 4],    // 帽落地滚走 + 两帧回头
  run:      ['CHASE', 0],   // 下蹲起跑
  curb:     ['CHASE', 2],   // 帽子滚下路沿、跨过电车轨
  tramIn:   ['CHASE', 3],   // 电车入画；他踏进车道
  nearMiss: ['CHASE', 4],   // 后跳，电车擦鼻而过
  tramOut:  ['CHASE', 5],   // 车尾离开，他僵立
  hatWall:  ['CHASE', 6],   // 帽子被气流掀上墙头
  rung1:    ['CHASE', 7],
  rung2:    ['CHASE', 8],
  rung3:    ['CHASE', 9],
  grab:     ['CHASE', 10],  // 手合上，帽子刚跳过墙
  wobble:   ['CHASE', 11],  // 梯子晃
  fall:     ['CHASE', 12],  // 梯子翻过墙，他摔进小巷
  bark:     ['CHASE', 13],  // 狗醒，狂吠
  crank:    ['CHASE', 14],  // undercrank 追逐开始
  step2:    ['CHASE', 15],
  step3:    ['CHASE', 16],
  card1:    ['CARD1', 0],   // 切卡：「那」随切点落定
  c1ding:   ['CARD1', 1],   // 「顶」落定
  c1mao:    ['CARD1', 2],   // 「帽」落定
  c1zi:     ['CARD1', 3],   // 「子」落定
  c1dots1:  ['CARD1', 3.5], // 第一个「…」
  c1dots2:  ['CARD1', 3.75],// 第二个「…」
  silence:  ['SIL', 0],
  twitch:   ['SIL', 1],     // 帽子无声一抖
  reveal:   ['REVEAL', 0],  // 帽子抬起：猴子（静默后第一声）
  look:     ['REVEAL', 1],  // 光圈停半开，猴子看观众
  card2:    ['CARD2', 0],
  settle:   ['CARD2', 1],   // 卡 2 末字回弹落定
  bow:      ['END', 0],     // 猴子举帽致意（回声）
  irisShut: ['END', 1],     // 光圈闭合
  curtain:  ['END', 2],     // 幕布合拢
};
export const HIT = Object.fromEntries(Object.entries(HITS).map(([k, [s, b]]) => [k, +at(s, b).toFixed(6)]));

// 视觉切点（cuecheck 用 ffmpeg scdet 在成片里实测）
export const CUTS = ['card1', 'silence', 'card2', 'bow'];

// 手摇采样：以拍为锚的 16 fps（每拍起点必是一次采样，保证拍点上的姿势正好落在该帧）
export function crank(tt, fps) {
  const s = secAt(tt), lt = tt - s.t0, b = Math.floor(lt / s.beat + 1e-6), w = lt - b * s.beat;
  return s.t0 + b * s.beat + Math.floor(w * fps + 1e-6) / fps;
}
