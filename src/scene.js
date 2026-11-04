// src/scene.js — 合成用的通用件，已经搬进引擎；这里只按旧名字转出，给还在用旧路径的文件。
//   数学、缓动 → engine/core/math.js；帧哈希 → engine/core/clock.js
//   底板、裁切云片、抠像面片、辉光 → engine/stage/plates.js；穹顶 → engine/stage/dome.js
//   机位、屏幕像素 ↔ 世界坐标 → engine/stage/camera.js；描边接线 → engine/stage/outline.js
import { loadPlates as loadPlatesFrom } from '../engine/stage/plates.js';

export { clamp, lerp, seg, ss, eio, eo } from '../engine/core/math.js';
export { hashi } from '../engine/core/clock.js';
export { DEG, ss5, placeOnScreen, screenToWorld, project, aimCamera, dirOf } from '../engine/stage/camera.js';
export { plateMat, plate, cutoutPlane, glowSprite, cropPlate as cloudPuff } from '../engine/stage/plates.js';
export { domeGeo, domePlate } from '../engine/stage/dome.js';
export { wireOutlines } from '../engine/stage/outline.js';

// 本片的底板目录里，纸纹是数据贴图（不做 sRGB 解码）
export const loadPlates = names => loadPlatesFrom(names, { linear: ['paper'] });
