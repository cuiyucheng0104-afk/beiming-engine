// 云海浮标 · 机位与版式（纯数据 + 纯函数，不 import 运行时）：film.tsx 用它摆东西，tests/native 用 engine/native/view.js
// 投影核对——片名不压主体、在安全区里，云海面片的两端（mist_low 是横向四方连续图，端头是硬切口）始终在画外。
// 改这里的数字后跑：node --test tests/native（在仓库根目录）。
//   layout({ W, H, DUR }) → { shots, subject, mists, title(chars), backdrop }
//     shots     一个镜头：缓推（ss 缓动），机位瞄在主体左侧，主体落在右三分线
//     subject   主体（浮标）的世界包围盒顶点：用来算屏幕框
//     mists     两层云海：远层在主体后、向左漂；近层压住主体底座、向右漂——前后层夹住主体，视差反向
//     title(n)  n 个字的片名框（像素）：左上天空里，字高 = 0.089·H，离左边 0.078·W、离上边 0.17·H（避开平台界面区 120/1080）
//     backdrop  二维天空底板的铺法：按画面高铺满（原图 3548×1774），每秒向左漂 6·H/1080 像素
export function layout({ W, H, DUR }) {
  const K = H / 1080;
  const shots = [{ until: DUR, eye: [[-2.6, 1.55, 7.2], [-1.55, 1.25, 5.4]], at: [[-1.25, 0.95, 0], [-0.95, 0.9, 0]], fov: 32, ease: 'ss' }];
  const subject = [];
  for (const x of [-0.52, 0.52]) for (const y of [-0.5, 1.6]) for (const z of [-0.52, 0.52]) subject.push([x, y, z]);
  const mistAspect = 3512 / 1448;
  const mists = [
    { name: 'mist-back', position: [-1, 0.25, -6], width: 34, aspect: mistAspect, drift: [-0.10, 0, 0] },
    { name: 'mist-front', position: [0.4, -0.55, 1.6], width: 16, aspect: mistAspect, drift: [0.12, 0, 0] },
  ];
  const size = Math.round(96 * K), left = Math.round(0.078 * W), top = Math.round(0.17 * H);
  const title = n => ({ left, top, size, letterSpacing: Math.round(0.14 * size), box: [left, top, left + n * size * 1.14, top + size * 1.6] });
  const plateH = H + 60 * K, plateW = Math.round(plateH * 3548 / 1774);
  const backdrop = { x: (W - plateW) / 2, y: -30 * K, width: plateW, height: plateH, drift: [-6 * K, 0] };
  return { shots, subject, mists, title, backdrop };
}
