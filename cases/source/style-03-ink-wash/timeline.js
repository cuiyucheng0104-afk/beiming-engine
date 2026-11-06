// 唯一时间源：速度图（每拍的整数帧）+ 所有画面/声音事件挂在拍号上。
// 72 BPM 在 24 fps 下正好每拍 20 帧，所有拍点都是整数帧 → 画面与音乐 0 ms 偏差。
export const FPS = 24;
// 每一拍的起始帧 b0..b23（小节 4 加速、小节 6 减速）
export const BEATF = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 258, 274, 289, 301, 313, 325, 337, 352, 370, 394, 424];
export const ENDF = 456;
export const DUR = ENDF / FPS;            // 19.0 s

// 拍号（可带小数）→ 帧（拍内线性插值，取整）；→ 秒
export function bf(k) {
  const i = Math.floor(k), f = k - i;
  if (i >= BEATF.length - 1) { const a = BEATF[BEATF.length - 1]; return Math.round(a + f * (ENDF - a)); }
  return Math.round(BEATF[i] + f * (BEATF[i + 1] - BEATF[i]));
}
export const bt = k => bf(k) / FPS;
export const F = f => f / FPS;            // 帧 → 秒

// 段落
export const SEC = [
  { id: 'mtn', b: 0, name: '山' }, { id: 'void', b: 5, name: '留白生鹤' }, { id: 'hush', b: 10, name: '静默' },
  { id: 'fly', b: 11, name: '飞越' }, { id: 'bloom', b: 16, name: '墨晕' }, { id: 'night', b: 19, name: '夜·落枝' },
];

// 关键事件：名称 → 拍号（画面与配乐都从这里取时间）
export const HIT = {
  stroke: 1,        // 山脊一笔落定（笔从 0.583 s 入画，b1 收笔）
  far: 2,           // 清墨远山
  fall: 3,          // 飞白下拖成瀑（起笔）
  moss1: 4, moss2: 4.5, moss3: 4.75,
  pan: 5,           // 手卷横摇
  wash: 6,          // 淡墨烘天，鹤身留白
  wing1: 7, wing2: 7.5,
  neck: 8, crown: 8.5,
  raise: 9,         // 举翼（预备）
  leap: 9.5,        // 下扑起飞
  hush: 10,         // 静默开始
  cry: 11,          // 鹤唳 / 入画
  drop: 16,         // 墨滴落纸
  full: 19,         // 墨晕满幅，月出（高潮）
  branch: 20,       // 一笔松枝
  land: 21,         // 落枝
  seal: 22,         // 钤印
  turn: 22.5,       // 回首望月
  last: 23,         // 最后一声泛音
};
export const T = Object.fromEntries(Object.entries(HIT).map(([k, b]) => [k, bt(b)]));
export const WINGBEATS = [11, 12, 13, 14, 15, 16, 17, 18];   // 飞行中每拍一次下扑（翼最低点）
// 题款四字的书写区间（帧）
export const INSCR = [[373, 378], [378, 384], [384, 389], [389, 393]];
export const STROKE_IN = F(14);          // 山脊笔锋入画帧
