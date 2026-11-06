// 港口集市 — 唯一时间源。画面、配乐、拟音、拍点核对都读这里（mix.py 读导出的 timeline.json）。
// 90 BPM，4/4；一拍 = 2/3 s = 60 fps 下 40 帧，四分之一拍 = 10 帧，所有拍点都是整数帧。
export const BPM = 90;
export const FPS = 60;
export const SPB = 60 / BPM;                // 每拍秒数
export const bt = b => b * SPB;             // 拍 → 秒
export const DUR_BEATS = 28.5;
export const DUR = bt(DUR_BEATS);           // 19.0 s

// 镜头（拍）
export const SHOTS = [
  { id: 'storm', a: 0, b: 12 },     // 0–8 s：雨中全景慢推 → 跟云横移（同一长镜头）
  { id: 'market', a: 12, b: 21 },   // 8–14 s：低近小摊 → 上升拉远 → 锁定 + 焦点转移
  { id: 'light', a: 21, b: DUR_BEATS },  // 14–19 s：灯塔半环绕 + 升高
];

// 集市摊灯点亮的拍（越点越快：隔 1 拍 → 半拍 → 四分之一拍）
export const POP_BEATS = [13, 14, 15, 16, 16.5, 17, 17.5, 18, 18.25, 18.5, 18.75];

// 关键事件（拍）。type 也是拟音 / 配乐的名字
export const CUES = {
  cardIn: 0.5,       // 章节牌落定
  lightning: 2,      // 闪电
  thunder: 3,        // 雷声
  cloudGo: 6,        // 云整体开走，章节牌开始淡出
  sunLH: 8,          // 第一缕暖光落到灯塔；长笛进
  rainHalf: 10,      // 雨只剩右半边
  cut1: 12,          // 剪切到小摊；雨硬停
  drip: 12.5,        // 最后一滴雨落在灯笼上
  festoon: 19,       // 集市上空整串彩灯 + 全城窗灯
  stop: 19.5,        // 硬停，进入近静默
  cut2: 21,          // 剪切到灯塔：点燃（全片最重要的一声）
  beam: 22,          // 光柱开始旋转
  sail: 23,          // 红帆扬起
  beamHit: 25,       // 光柱扫过帆船；横幅落定
  resolve: 27,       // 收束和弦
};
export const T = Object.fromEntries(Object.entries(CUES).map(([k, b]) => [k, bt(b)]));
export const POP_T = POP_BEATS.map(bt);
export const shotAt = t => SHOTS.find(s => t < bt(s.b)) || SHOTS[SHOTS.length - 1];

// 声音 / 核对事件表（window.EV 由它生成）
export function events() {
  const ev = [];
  for (const [k, b] of Object.entries(CUES)) ev.push({ t: bt(b), beat: b, type: k });
  POP_BEATS.forEach((b, i) => ev.push({ t: bt(b), beat: b, type: 'pop', i }));
  return ev.sort((a, b) => a.t - b.t);
}
