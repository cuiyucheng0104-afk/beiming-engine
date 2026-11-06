// 唯一时间源：节拍网格。30 fps，每拍正好 14 帧（BPM = 900/7 ≈ 128.57），半拍 7 帧。
// 所有画面事件、运镜关键帧、乐谱音符都用拍号 b 表示，bt(b) 换成秒（总是整帧）。
export const FPS = 30, FPB = 14, BPM = 60 * FPS / FPB, B = FPB / FPS;
export const bt = b => Math.round(b * FPB) / FPS;
export const DUR = 576 / FPS;            // 19.2 s = 40 拍 + 16 帧余韵
// 冻结：b24–b28 动作时间停住（相机照走）
export const FREEZE = [24, 28];
export const act = t => { const a = bt(FREEZE[0]), c = bt(FREEZE[1]); return t < a ? t : t < c ? a : t - (c - a); };
// 段落（拍）
export const SECS = [
  { id: 'office', b: 0 }, { id: 'drag', b: 8 }, { id: 'chase', b: 16 }, { id: 'freeze', b: 24 },
  { id: 'trash', b: 28 }, { id: 'spit', b: 32 }, { id: 'done', b: 36 }, { id: 'tail', b: 40 },
];
// 关键拍点：画面与音乐都从这里取
export const HIT = {
  title: 4,        // 推近落定在标题
  cursorIn: 5, hover: 7,
  press: 8, resist: 11, breakFree: 12, land1: 13, bang: 14,
  toastIn: 15.5, jump1: 16, land2: 17, swipe: 18, hop: 18.5, land3: 19,
  grab: 19.5, release: 20.5, stomp: 21, jump4: 22, lunge: 23,
  freeze: 24, unfreeze: 28, gulp: 29, bulge1: 30, bulge2: 31, bulge3: 31.5,
  spit: 32, land5: 34, look: 35, check: 36, zzz: 37.5, end: 40,
};
