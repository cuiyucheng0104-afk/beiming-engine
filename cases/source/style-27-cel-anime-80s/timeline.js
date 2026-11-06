// 追电车的夏天 —— 唯一时间源（画面、配乐、拟音、拍点核对都读这里）
// 每拍正好 13 帧（24 fps）→ 110.77 BPM：所有拍点都落在帧格上，画面与音乐 0 ms 偏差。
export const FPS = 24;
export const FPB = 13;                       // frames per beat (constant sections)
export const BPM = 60 * FPS / FPB;           // 110.769…
export const SPB = FPB / FPS;                // 0.5417 s

// 速度图（帧）：b0–b18 恒速；b18→b19 16 帧，b19→b20 19 帧（渐慢）；b20 后 24 帧总休止；C 起恢复恒速
export const F18 = 18 * FPB, F19 = F18 + 16, F20 = F19 + 19, FC = F20 + 24;
// beat → frame（允许小数拍，渐慢段线性插值每拍内部）
export function bf(b) {
  if (b <= 18) return b * FPB;
  if (b <= 19) return F18 + (b - 18) * 16;
  if (b <= 20) return F19 + (b - 19) * 19;
  return F20 + (b - 20) * 19;              // 只在需要 b20 之后的细分时用（休止段）
}
export const bt = b => bf(b) / FPS;          // beat → seconds
export const C = FC / FPS;                   // 接帽（the catch）
export const df = n => FC + n * FPB;         // 接帽后第 n 拍 → frame
export const dt = n => df(n) / FPS;          // → seconds
export const END_F = df(13) + 6;             // 片尾帧数
export const DUR = END_F / FPS;

// 镜头（帧边界）
export const SHOTS = [
  ['coast', 0, bf(8)],         // S1 大远景横摇
  ['side', bf(8), bf(12)],     // S2 侧向跟拍
  ['bust', bf(12), bf(14)],    // S3 胸像推镜 + 速度线
  ['eyes', bf(14), bf(16)],    // S4 眼睛大特写
  ['hat', bf(16), F20],        // S5 帽飞，跟摇上仰
  ['freeze', F20, FC],         // S6 定格静默
  ['catch', FC, df(6)],        // S7 接帽 + 光带
  ['sunset', df(6), END_F],    // S8 首尾呼应
];
export function shotAt(t) {
  const f = Math.round(t * FPS);
  for (const s of SHOTS) if (f >= s[1] && f < s[2]) return s;
  return SHOTS[SHOTS.length - 1];
}

// 画面事件：每个都写明它卡在哪一拍（cuecheck 会核对）
export const CUES = {
  bellOff:    { beat: 6,  f: bf(6) },           // 画外电车铃（J-cut）
  tramIn:     { beat: 7,  f: bf(7) },           // 电车车头入画
  cutSide:    { beat: 8,  f: bf(8) },
  lookBack:   { beat: 10, f: bf(10) },          // 回头看电车
  standUp:    { beat: 11, f: bf(11) },          // 站起来蹬
  cutBust:    { beat: 12, f: bf(12) },
  cutEyes:    { beat: 14, f: bf(14) },
  narrow:     { beat: 15, f: bf(15) },          // 眯眼 + 眼中星芒
  hatOff:     { beat: 16, f: bf(16) },          // 切 S5 + 草帽被掀起（冲击帧）
  apex:       { beat: 18, f: bf(18) },          // 帽子到太阳前，开始渐慢
  freeze:     { beat: 20, f: F20 },             // 定格 + 音乐切断
  reach:      { beat: 'C-9f', f: FC - 9 },      // 无声伸手（休止中，不对拍）
  catch:      { beat: 'C', f: FC },             // 接住！全片最重要的声音
  band1:      { beat: 'C+1', f: df(1) },
  smile:      { beat: 'C+2', f: df(2) },
  band2:      { beat: 'C+3', f: df(3) },
  band3:      { beat: 'C+5', f: df(5) },
  cutSunset:  { beat: 'C+6', f: df(6) },        // 白闪切 S8
  title:      { beat: 'C+7', f: df(7) },        // 标题落定
  stop:       { beat: 'C+8', f: df(8) },        // 少女在路边停下、单脚撑地
  bellFar1:   { beat: 'C+10', f: df(10) },
  bellFar2:   { beat: 'C+10.5', f: FC + Math.round(10.5 * FPB) },
  glint:      { beat: 'C+12', f: df(12) },      // 标题星芒
};
// 音乐拍点（全部帧对齐）——给 cuecheck 与 score.py
export function musicBeats() {
  const out = [];
  for (let b = 0; b <= 20; b++) out.push({ id: 'b' + b, f: bf(b) });
  for (let n = 0; n <= 13; n++) out.push({ id: 'C+' + n, f: df(n) });
  out.push({ id: 'C+10.5', f: FC + Math.round(10.5 * FPB) });
  return out;
}
export const TL = { FPS, FPB, BPM, SPB, F18, F19, F20, FC, END_F, DUR, SHOTS, CUES };
