// 北冥引擎 · 分层时钟：帧号、一拍一 / 二 / 三的量化、按帧取的确定性抖动。
// 三渲二里不同的东西走不同的帧率：镜头和雾 24 fps 平滑，角色一拍二，大型生物一拍三。
// 量化一律从整数帧号出发（f = frameOf(t)），避免 t*8 这类浮点乘法在边界上抖到相邻拍。
//   frameOf(t, fps)      时间 → 帧号（四舍五入）
//   hold(f, n)           一拍 n 的拍号：floor(f / n)，常作墨线沸腾、水波抖动的种子
//   heldTime(f, n, fps)  一拍 n 量化后的时间（秒）：同一拍内的帧取同一个姿态
//   tick(t, rate)        按每秒 rate 拍直接从时间取拍号（加 1e-6 防 t 落在拍边上被截掉）
//   snapTime(t, rate)    tick 对应的时间（秒），给只拿到 t 的绘制函数用
//   hashi(n)             整数 → [0, 1) 的哈希，同一拍取同一个随机值

export const frameOf = (t, fps = 24) => Math.round(t * fps);
export const hold = (f, n) => Math.floor(f / n);
export const heldTime = (f, n, fps = 24) => Math.floor(f / n) * n / fps;
export const tick = (t, rate) => Math.floor(t * rate + 1e-6);
export const snapTime = (t, rate) => tick(t, rate) / rate;

export const hashi = n => { let h = (n | 0) * 374761393 + 668265263; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return (h >>> 0) / 4294967296; };
