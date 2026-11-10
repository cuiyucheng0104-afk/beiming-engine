// 舞台机位：三个场景（hero / layers / idle）各自给出一组“机位参数”，相机在参数空间里平滑过渡。
//
// 机位参数 shot = { yaw, pitch, roll, size, fov, ax, ay, ref }
//   yaw / pitch   绕鲲的方位角 / 仰角（弧度）。yaw = 0：相机在鲲的 -Z 侧看过去，头（+X）在画面左边；yaw > 0 往鲲头前方转
//   size          鲲的“画面宽度”：体长投影到画面上占参考画幅宽度的比例（按 ±体长/2 估算，不含透视缩短）
//   fov           参考画幅的竖直视角（度）
//   ax, ay        鲲的视觉中心落在参考画幅的哪个位置（NDC，-1..1；用镜头平移实现，不改透视）
//   ref           参考画幅宽高比；实际画布宽高比不同时按 CSS object-fit: cover（居中）裁切，
//                 这样首屏海报（横 16:9、竖 3:4）用 cover 铺满时与实时画面逐像素对齐（天空也按同样的方式裁，见 stage.js）
// 场景函数 (aspect, progress, t) → shot；t 是舞台时钟（秒），用于缓慢漂移（t = 0 时漂移为 0，首帧与海报一致）。
import * as THREE from 'three';

const DEG = Math.PI / 180;
export const KUN_HALF = 330;                       // 体长一半（含尾鳍），机位距离按它估算
export const KUN_CENTER = new THREE.Vector3(-10, 38, 0);   // 鲲（含背上仙岛）的视觉中心，鲲局部坐标

const lerp = (a, b, k) => a + (b - a) * k;
const smooth = k => k * k * (3 - 2 * k);
// 从 0 起、初速度为 0 的缓慢漂移（首帧位置与速度都是 0，之后在 ±1 附近慢慢摆）
const drift = (t, w, ph = 0) => (Math.sin(w * t + ph) - Math.sin(ph)) * (1 - Math.exp(-t * 0.8));

// —— 首屏：鲲在右上大半、头朝左，缓慢游动；参考画幅横屏 16:9、竖屏 3:4，与两张海报一致 ——
// 竖屏参考画幅是 3:4（FINAL-15）：比它窄的画面（所有手机、竖拿的平板）按 cover 只裁左右，竖直方向的构图不变，
// 鲲在画高里的位置对每台竖屏设备都一样。以前是 9:16：比 9:16 宽的竖屏（360×640 一类、平板）会裁上下，
// 鲲按宽高比放大、往上下两头撑开，须子压到题签（首屏文案在矮手机上从 42% 高度起排），平板上仙山顶进导航栏。
// 现在鲲（含仙岛、须子，漂移与游动全程）落在画高约 10%–40% 之间：上面让开 56px 的导航，下面让开 42% 处的题签。
// 比 3:4 还宽的竖屏（0.75–1：拉窄的桌面窗口、展开的折叠屏）仍按 cover 裁上下，宽高比 0.9 时仙山顶到画面 2.4% 处，进了导航栏
function hero(aspect, p, t) {
  const portrait = aspect <= 0.999;   // 与首屏海报 <source media="(max-aspect-ratio: 999/1000)"> 一致
  const k = smooth(Math.min(1, Math.max(0, p)));   // 往下滚出首屏时，相机略微抬高后退
  const base = portrait
    ? { ref: 3 / 4, fov: 34, size: 0.614, ax: 0.0375, ay: 0.532, yaw: 28.5 * DEG, pitch: 5.7 * DEG, roll: 1.7 * DEG }
    : { ref: 16 / 9, fov: 30, size: 0.67, ax: 0.43, ay: 0.25, yaw: 27.5 * DEG, pitch: 5.7 * DEG, roll: 1.7 * DEG };
  return {
    ...base,
    yaw: base.yaw + 0.035 * drift(t, 0.11) - 0.06 * k,
    pitch: base.pitch + 0.02 * drift(t, 0.083, 1.1) + 0.05 * k,
    size: base.size * (1 + 0.025 * drift(t, 0.07, 0.4)) * (1 - 0.12 * k),
    ay: base.ay + 0.06 * k,
  };
}

// —— 拆层：桌面鲲在右侧 7/12 栏（中心约 0.708 画宽），手机在上半屏；随 progress 缓慢环绕 ——
function layers(aspect, p, t) {
  const portrait = aspect <= 1;   // 与海报的 CSS 媒体查询 (max-aspect-ratio: 1/1) 一致
  const k = Math.min(1, Math.max(0, p));
  const yaw = lerp(34, -18, smooth(k)) * DEG + 0.02 * drift(t, 0.1);
  const pitch = lerp(14, 6, k) * DEG + 0.015 * drift(t, 0.08, 0.7);
  if (portrait) {
    // 上 55vh：中心在画高约 0.28 处；体长约占画宽的 0.95
    return { ref: aspect, fov: 34, size: 0.95, ax: 0.0, ay: 0.44, yaw, pitch, roll: 0 };
  }
  // 12 栏：左 5 栏文字，右 7 栏放鲲；中心 x = (5/12 + 7/24) → NDC 0.417
  return { ref: aspect, fov: 30, size: 0.58, ax: 0.417, ay: 0.02, yaw, pitch, roll: 0 };
}

// —— 待机：安静的侧身远景，不跟鼠标 ——
function idle(aspect, p, t) {
  const portrait = aspect <= 1;   // 与海报的 CSS 媒体查询 (max-aspect-ratio: 1/1) 一致
  return {
    ref: aspect, fov: 30, size: portrait ? 0.8 : 0.5, ax: portrait ? 0 : 0.25, ay: portrait ? 0.3 : 0.08,
    yaw: 12 * DEG + 0.03 * drift(t, 0.06), pitch: 5 * DEG + 0.015 * drift(t, 0.05, 0.9), roll: 0,
  };
}

export const SCENES = { hero, layers, idle };
export const POINTER_SCENES = new Set(['hero', 'layers']);

const KEYS = ['yaw', 'pitch', 'roll', 'size', 'fov', 'ax', 'ay', 'ref'];
export const blendShot = (a, b, k, out = {}) => { for (const key of KEYS) out[key] = lerp(a[key], b[key], k); return out; };
export const copyShot = (a, out = {}) => { for (const key of KEYS) out[key] = a[key]; return out; };

const _dir = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();

/**
 * 把机位参数落到相机上：位置、朝向、视角、镜头平移（cover 裁切到实际画幅）。
 * center：鲲视觉中心的世界坐标；pointer：{ x, y } -1..1（已平滑），par：视差强度（0 关）
 */
export function applyShot(camera, shot, aspect, center, pointer, par = 1) {
  // cover 裁切：实际画幅比参考画幅窄 → 裁左右（竖直视角不变，横向锚点按比例放大）；宽 → 裁上下（竖直视角收窄）
  const ref = shot.ref;
  let tanV = Math.tan(shot.fov * DEG / 2), ax = shot.ax, ay = shot.ay;
  if (aspect >= ref) { tanV *= ref / aspect; ay *= aspect / ref; }
  else ax *= ref / aspect;
  const tanH = Math.tan(shot.fov * DEG / 2) * ref;          // 参考画幅的水平半视角正切
  const dist = KUN_HALF / (shot.size * tanH);

  _dir.set(Math.sin(shot.yaw) * Math.cos(shot.pitch), Math.sin(shot.pitch), -Math.cos(shot.yaw) * Math.cos(shot.pitch));
  camera.position.copy(center).addScaledVector(_dir, dist);
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  if (shot.roll) camera.rotateZ(shot.roll);
  // 鼠标视差：相机在自己的平面里平移一点、仍看着鲲的中心 → 头、尾、仙岛之间有真实的视差
  if (par && pointer) {
    _right.setFromMatrixColumn(camera.matrix, 0); _up.setFromMatrixColumn(camera.matrix, 1);
    camera.position.addScaledVector(_right, pointer.x * dist * 0.035 * par).addScaledVector(_up, pointer.y * dist * 0.022 * par);
    camera.lookAt(center);
    if (shot.roll) camera.rotateZ(shot.roll);
  }
  camera.fov = 2 * Math.atan(tanV) / DEG;
  camera.aspect = aspect;
  camera.near = Math.max(5, dist - 900); camera.far = dist + 1600;
  camera.updateProjectionMatrix();
  // 镜头平移：所有深度统一平移 (ax, ay) 个 NDC 单位
  const e = camera.projectionMatrix.elements;
  e[8] = -ax; e[9] = -ay;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.updateMatrixWorld(true);
  return dist;
}

/** 鼠标对应的视线目标：相机位置沿相机平面偏移，鲲的金眼转向它（指针在中央时正视镜头） */
export function gazeTarget(camera, pointer, dist, out = new THREE.Vector3()) {
  _right.setFromMatrixColumn(camera.matrixWorld, 0); _up.setFromMatrixColumn(camera.matrixWorld, 1);
  return out.copy(camera.position).addScaledVector(_right, pointer.x * dist * 0.55).addScaledVector(_up, pointer.y * dist * 0.4);
}
