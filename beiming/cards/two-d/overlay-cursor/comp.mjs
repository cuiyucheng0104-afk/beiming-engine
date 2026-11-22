// overlay.cursor 在合成一侧的实现：照点击表排光标的位置、下压和波纹，交给合成工具往成片上叠，并派生「点击之后几帧切画面」的事件条目。
// 合成宿主怎么用 Handle 还没有契约，这里定的用法写在卡文件的 ports.requires 里：ctx 带 size 和 shot；
// 合成工具逐帧调 Handle.object.draw(f, rgba) 叠光标，取 Handle.object.events 并进事件表，逐帧调 meta(f) 拿读数。
// 帧号照时间契约 5.8：点击表和 at、draw、meta 收的都是镜头局部帧号；只有交出去的事件条目和事件对是全片帧号（局部帧号 + shot.in）。
// 每一帧的摆法都是帧号的闭式函数，不带累计状态：任意帧单独求、乱序求结果相同。

const fail = (message) => { throw Object.assign(new RangeError(`overlay.cursor：${message}`), { code: 'usage.bad-argument' }); };
/** 最小加加速度的缓动：两头的速度和加速度都是 0 */
const ease = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
const PRESS_DEPTH = 0.25, RIPPLE_ALPHA = 0.6, CURSOR_ALPHA = 0.9;

/**
 * ctx：用到 size（[宽, 高]，像素）和 shot（{ in, frames }：镜头起始帧（全片帧号）和帧数；不带 shot 当从第 0 帧起、不限帧数）。
 * params.clicks：至少一项，每项 { id, frame, x, y }，frame 是镜头局部帧号（0 到镜头帧数 − 1），x、y 是画面宽高的几分之几（0 到 1，原点在左上角，y 向下）；
 * 帧号必须一个比一个大。写法不对的一律报 usage.bad-argument。
 * 光标在镜头第 0 帧从 (startX, startY) 出发，每次点击之前最多用 moveFrames 帧从上一个位置滑到这一个，正好在点击帧到位；其余时间停着。
 * 点击帧起 pressFrames 帧是下压（光标缩到 0.75 倍再线性放回），rippleFrames 帧是波纹（半径涨到 rippleFrac × 画面高，同时淡出）。
 * Handle.object：
 *   pairs    每项 { id, clickFrame, cutFrame }，全片帧号：clickFrame 是 shot.in + 点击的局部帧号，cutFrame − clickFrame 恒等于 cutDelayFrames。
 *   events   事件表条目（events/0.1 的 events[] 写法），全片帧号，已照「帧号升序、同帧按 id 的码点升序」排好：
 *            每次点击一条命名条目（id 是点击的 id，带 audio 和 sync: onset），一条切点条目（id 是 cut.<帧号>）。
 *   at(f)              镜头第 f 帧（局部帧号）的摆法 { x, y, scale, pressed, ripple, bbox }：x、y 像素；ripple 是 { radius, alpha } 或 null；
 *                      bbox 是 [x0, y0, x1, y1]（像素），把光标和波纹都框住。
 *   draw(f, rgba)      把镜头第 f 帧（局部帧号）的光标和波纹叠到 rgba（宽 × 高 × 4 个 8 位数，直通透明度）上，返回 bbox。
 * meta(f) 的 f 也是镜头局部帧号，交这一帧的读数 { x, y, pressed, ripple }（ripple 是波纹半径，像素，没有波纹是 0）。
 */
export function create(ctx, params) {
  const [width, height] = ctx.size, clicks = params.clicks, delay = params.cutDelayFrames;
  const shotIn = ctx.shot?.in ?? 0, shotFrames = ctx.shot?.frames ?? Infinity;
  if (!Array.isArray(clicks) || clicks.length < 1) fail('clicks 要是至少有一次点击的数组');
  if (!Number.isSafeInteger(delay) || delay < 0) fail(`cutDelayFrames 要是非负整数帧数，给的是 ${delay}`);
  // 按下标走，稀疏数组的空位也拦得下
  for (let i = 0; i < clicks.length; i++) {
    const c = clicks[i];
    if (c === null || typeof c !== 'object') fail(`第 ${i} 次点击要写成 { id, frame, x, y }`);
    if (typeof c.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(c.id)) fail(`点击的 id ${JSON.stringify(c.id)} 要是小写字母开头的小写字母、数字、连字符`);
    if (!Number.isSafeInteger(c.frame) || c.frame < 0 || c.frame >= shotFrames) fail(`点击 ${c.id} 的 frame 要是镜头局部帧号（0 到镜头帧数 − 1 的整数），给的是 ${c.frame}`);
    for (const axis of ['x', 'y']) if (!(Number.isFinite(c[axis]) && c[axis] >= 0 && c[axis] <= 1)) fail(`点击 ${c.id} 的 ${axis} 要是 0 到 1 的数（画面的几分之几），给的是 ${c[axis]}`);
    if (i && c.frame <= clicks[i - 1].frame) fail(`点击 ${c.id} 的帧号 ${c.frame} 不在上一次点击（第 ${clicks[i - 1].frame} 帧）之后`);
    if (clicks.findIndex((o) => o.id === c.id) !== i) fail(`点击的 id ${c.id} 重复`);
  }
  const pairs = clicks.map((c) => ({ id: c.id, clickFrame: shotIn + c.frame, cutFrame: shotIn + c.frame + delay }));
  // id 只有 ASCII，按码元比就是按码点比
  const events = pairs.flatMap((p) => [
    { id: p.id, frame: p.clickFrame, sub: 0, kind: 'named', from: 'film', audio: params.audio, sync: 'onset' },
    { id: `cut.${p.cutFrame}`, frame: p.cutFrame, sub: 0, kind: 'cut', from: 'film' },
  ]).sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : 1));

  const radius = params.sizeFrac * height, rippleMax = params.rippleFrac * height, ring = Math.max(1.5, radius * 0.15);
  if (!/^#[0-9a-f]{6}$/i.test(params.ink)) fail(`ink 要写成 #RRGGBB，给的是 ${JSON.stringify(params.ink)}`);
  const ink = [1, 3, 5].map((i) => parseInt(params.ink.slice(i, i + 2), 16));
  const stops = [{ frame: 0, x: params.startX, y: params.startY }, ...clicks];

  const at = (frame) => {
    // 这一帧正朝哪次点击去：第一个帧号不小于这一帧的；都过了就停在最后一次点击的位置
    let i = stops.findIndex((s, k) => k && s.frame >= frame);
    if (i < 0) i = stops.length - 1;
    const to = stops[i], from = stops[Math.max(0, i - 1)], depart = Math.max(from.frame, to.frame - params.moveFrames);
    const t = frame >= to.frame ? 1 : frame <= depart ? 0 : ease((frame - depart) / (to.frame - depart));
    const x = (from.x + (to.x - from.x) * t) * width, y = (from.y + (to.y - from.y) * t) * height;
    const last = clicks.findLast((c) => c.frame <= frame), age = last ? frame - last.frame : Infinity;
    const pressed = age < params.pressFrames, scale = pressed ? 1 - PRESS_DEPTH * (1 - age / params.pressFrames) : 1;
    const k = age / params.rippleFrames, ripple = age < params.rippleFrames ? { radius: rippleMax * (1 - (1 - k) ** 3), alpha: RIPPLE_ALPHA * (1 - k) } : null;
    const reach = Math.max(radius * scale, ripple ? ripple.radius + ring / 2 : 0) + 1;
    return { x, y, scale, pressed, ripple, bbox: [x - reach, y - reach, x + reach, y + reach] };
  };

  const draw = (frame, rgba) => {
    if (rgba.length !== width * height * 4) fail(`draw 要 ${width} × ${height} × 4 个数的 RGBA 缓冲，给的长度是 ${rgba.length}`);
    const s = at(frame), r = radius * s.scale;
    const [x0, y0, x1, y1] = s.bbox.map((v, i) => Math.max(0, Math.min(i % 2 ? height : width, i < 2 ? Math.floor(v) : Math.ceil(v))));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const d = Math.hypot(px + 0.5 - s.x, py + 0.5 - s.y), cover = (edge) => Math.max(0, Math.min(1, edge - d + 0.5));
        const disc = CURSOR_ALPHA * cover(r), wave = s.ripple ? s.ripple.alpha * Math.min(cover(s.ripple.radius + ring / 2), 1 - cover(s.ripple.radius - ring / 2)) : 0;
        const a = disc + wave * (1 - disc);
        if (a <= 0) continue;
        const i = (py * width + px) * 4, da = rgba[i + 3] / 255, out = a + da * (1 - a);
        for (let c = 0; c < 3; c++) rgba[i + c] = Math.round((ink[c] * a + rgba[i + c] * da * (1 - a)) / out);
        rgba[i + 3] = Math.round(out * 255);
      }
    }
    return s.bbox;
  };

  return {
    object: { pairs, events, at, draw },
    meta(f) {
      const s = at(f);
      return { readings: { x: s.x, y: s.y, pressed: s.pressed ? 1 : 0, ripple: s.ripple?.radius ?? 0 } };
    },
    dispose() {},
  };
}
