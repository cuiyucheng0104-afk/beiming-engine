// 北冥引擎 · 分层时钟：帧号、一拍一 / 二 / 三的量化、按帧取的确定性抖动。
// 三渲二里不同的东西走不同的帧率：镜头和雾逐帧平滑，角色一拍二，大型生物一拍三。
// 量化一律从整数帧号出发（f = frameOf(t)），避免 t*8 这类浮点乘法在边界上抖到相邻拍。
//
// 影片帧率：frameOf / heldTime / holdAt / heldAt 不写 fps 时取 filmFps()。它默认是 REF_FPS = 24，
//   engine/stage/film.js 开片时用 setFilmFps() 设成这部片的渲染帧率（渲染器注入的 window.__RENDER.fps，或页面声明的 fps）。
//   「一拍 n」的定义是每张画停 n 个输出帧：25 / 30 fps 下一拍二就是每张停 2 帧、一拍三停 3 帧，不会出现 2、3 帧交替
//   （每秒的张数随帧率变：30 fps 的一拍二是每秒 15 张）。24 fps 下下面每个函数的数值与改动前逐位相同。
//   tick / snapTime 按「每秒几张」取拍，与影片帧率无关：rate 整除影片帧率时每张停整数帧（24 fps 下 12 = 一拍二、
//   8 = 一拍三），不整除时必然 2、3 帧交替——要按「一拍 n」写、并且换帧率也成立，就用 hold / heldTime / holdAt / heldAt。
//
//   REF_FPS                  24：引擎的参考帧率（《北冥》与现有页面都按它编写）
//   filmFps()                当前影片帧率（默认 24）
//   setFilmFps(fps)          设影片帧率（正的有限数，否则抛 TypeError）；返回设好的值。一部片只在开片时设一次
//   frameOf(t, fps)          时间 → 帧号（四舍五入）
//   hold(f, n)               一拍 n 的拍号：floor(f / n)，常作墨线沸腾、水波抖动的种子
//   heldTime(f, n, fps)      一拍 n 量化后的时间（秒）：同一拍内的帧取同一个姿态
//   holdAt(t, n, fps)        = hold(frameOf(t, fps), n)：只拿得到秒的绘制函数取一拍 n 的拍号
//   heldAt(t, n, fps)        = heldTime(frameOf(t, fps), n, fps)：同上，返回量化后的秒
//   holdFrames(sec, fps)     「每张画停 sec 秒」换成整数帧：max(1, round(sec × fps))（.5 进位）。按秒想节奏时先换成帧再用 hold
//   tick(t, rate)            按每秒 rate 拍直接从时间取拍号（加 1e-6 防 t 落在拍边上被截掉）
//   snapTime(t, rate)        tick 对应的时间（秒），给只拿到 t 的绘制函数用
//   hashi(n)                 整数 → [0, 1) 的哈希，同一拍取同一个随机值

export const REF_FPS = 24;
let FILM_FPS = REF_FPS;

const describe = v => (typeof v === 'string' ? JSON.stringify(v) : `${String(v)}（${typeof v}）`);

export const filmFps = () => FILM_FPS;
export function setFilmFps(fps) {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    throw new TypeError(`setFilmFps：帧率要是正的有限数，收到 ${describe(fps)}`);
  }
  FILM_FPS = fps;
  return fps;
}

export const frameOf = (t, fps = FILM_FPS) => Math.round(t * fps);
export const hold = (f, n) => Math.floor(f / n);
export const heldTime = (f, n, fps = FILM_FPS) => Math.floor(f / n) * n / fps;
export const holdAt = (t, n, fps = FILM_FPS) => Math.floor(Math.round(t * fps) / n);
export const heldAt = (t, n, fps = FILM_FPS) => Math.floor(Math.round(t * fps) / n) * n / fps;
export const holdFrames = (sec, fps = FILM_FPS) => Math.max(1, Math.round(sec * fps));
export const tick = (t, rate) => Math.floor(t * rate + 1e-6);
export const snapTime = (t, rate) => tick(t, rate) / rate;

export { hashi } from './math.js';
