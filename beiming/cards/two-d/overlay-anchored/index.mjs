// overlay.anchored 在合成一侧的实现：
// 1. 每一帧严格从传入的 frame-meta（meta/0.1）中按像素单位读取三维实体或其命名锚点在屏幕上的投影坐标，并核对画幅范围 [0, 宽] × [0, 高]；
// 2. 闭式排版标签框 [x0, y0, x1, y1] 与三点折线引线 [[ax, ay], [ex, ey], [bx, by]]，并按 safeMarginPx 钳制在画幅安全区内；
// 3. 相机或零件运动时，二维标注自动跟随每帧锚点移动，无需改动任何二维代码；
// 4. 支持向 8 位直通透明度 RGBA 缓冲确定性绘制锚点圆点、折线引线、带边框标签底盒以及复用 overlay.title 的文字字形，并产出规范的 texts 与 readings。

import { create as createOverlayTitle } from '../overlay-title/three.js';

const CALLOUT_ID_RE = /^[a-z][a-z0-9_-]*$/;
const ENTITY_NAME_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const ANCHOR_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

const ALLOWED_META_KEYS = Object.freeze([
  'format',
  'film',
  'shot',
  'frame',
  'shotFrame',
  'seed',
  'fps',
  'size',
  'colorRef',
  'units',
  'camera',
  'entities',
  'omittedParts',
  'lights',
  'events',
  'texts',
  'readings',
  'stats',
  'source',
  'timing',
  'origin',
  'hash',
  'anchors',
  'ext',
]);

const ALLOWED_ENTITY_KEYS = Object.freeze([
  'id',
  'name',
  'class',
  'role',
  'bbox2d',
  'bbox3d',
  'visible',
  'pxArea',
  'depth',
  'cards',
  'anchors',
  'motion',
  'count',
]);

const ALLOWED_CALLOUT_KEYS = Object.freeze([
  'id',
  'entity',
  'anchor',
  'text',
  'dx',
  'dy',
  'startFrame',
  'endFrame',
]);

const ALLOWED_ANCHOR_KEYS = Object.freeze(['world', 'screen', 'x', 'y']);

const TITLE_CAPTURE_THREE = {
  BufferGeometry: class {
    constructor() { this.attributes = {}; }
    setAttribute(name, attr) { this.attributes[name] = attr; }
    dispose() {}
  },
  Float32BufferAttribute: class {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  },
  Color: class {
    constructor(c) { this.c = c; }
  },
  MeshBasicMaterial: class {
    constructor(opts) { Object.assign(this, opts); }
    dispose() {}
  },
  Mesh: class {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; }
  },
};

const TITLE_GLYPH_CACHE = new Map();

function getTitleGlyphGrid(rawText) {
  let cached = TITLE_GLYPH_CACHE.get(rawText);
  if (cached) return cached;
  let normalized = [...String(rawText).toUpperCase()]
    .map((ch) => (/^[A-Z0-9 .:-]$/.test(ch) ? ch : '-'))
    .join('');
  if (!/[A-Z0-9.:-]/.test(normalized)) normalized = '-';
  const handle = createOverlayTitle(
    { THREE: TITLE_CAPTURE_THREE, size: [1, 1] },
    { text: normalized, enter: 0, settleFrames: 0, ink: '#FFFFFF', heightFrac: 1, distance: 1 },
  );
  const pos = handle.object.geometry.attributes.position.array;
  let minX = Infinity;
  let maxX = -Infinity;
  const rects = [];
  for (let i = 0; i < pos.length; i += 18) {
    const x0 = pos[i];
    const y0 = pos[i + 1];
    const x1 = pos[i + 3];
    const y1 = pos[i + 7];
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    rects.push([x0, y0, x1, y1]);
  }
  handle.dispose();
  const totalCols = Math.max(1, Math.round(maxX - minX));
  const totalRows = 7;
  const grid = new Uint8Array(totalCols * totalRows);
  for (const [x0, , , y1] of rects) {
    const col = Math.round(x0 - minX);
    const row = Math.round(3.5 - y1);
    if (col >= 0 && col < totalCols && row >= 0 && row < totalRows) {
      grid[row * totalCols + col] = 1;
    }
  }
  cached = { totalCols, totalRows, grid };
  TITLE_GLYPH_CACHE.set(rawText, cached);
  return cached;
}

const fail = (message) => {
  throw Object.assign(new RangeError(`overlay.anchored：${message}`), { code: 'usage.bad-argument' });
};

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function validateRgbaBuffer(what, rgba, expectedLen) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray)) {
    fail(`${what} 必须是 Uint8Array 或 Uint8ClampedArray`);
  }
  if (rgba.length !== expectedLen) {
    fail(`${what} 需要长度为 ${expectedLen} 的 RGBA 缓冲，实际长度 ${rgba.length}`);
  }
}

function snapValue(what, v, depth = 0) {
  if (depth > 16) fail(`${what} 嵌套层级过深`);
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${what} 必须是有限数`);
    return v;
  }
  if (typeof v !== 'object') fail(`${what} 类型不合法（${typeof v}）`);
  if (Array.isArray(v)) {
    const n = v.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      if (!(i in v)) fail(`${what} 不能是稀疏数组`);
      out[i] = snapValue(`${what}[${i}]`, v[i], depth + 1);
    }
    return out;
  }
  if (!isPlainObject(v)) {
    fail(`${what} 必须是普通对象`);
  }
  if (Object.getOwnPropertySymbols(v).length > 0) fail(`${what} 不能包含 Symbol 键`);
  const out = {};
  for (const k of Object.keys(v)) {
    out[k] = snapValue(`${what}.${k}`, v[k], depth + 1);
  }
  return out;
}

function checkAllowedKeys(what, obj, allowed) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${what} 包含未声明的键 ${JSON.stringify(k)}`);
  }
}

function parseHexColor(what, hex) {
  if (typeof hex !== 'string' || !HEX_COLOR_RE.test(hex)) {
    fail(`${what} 必须写成 #RRGGBB`);
  }
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toPixelPoint(pt, width, height) {
  if (!Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number' || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
    fail('锚点 screen 坐标必须是 [x, y] 有限数对');
  }
  const [x, y] = pt;
  // 严格遵循 meta/0.1 第 5.2 节：screen 单位固定为像素，范围必须在画幅 [0, width] × [0, height] 内
  if (x < 0 || x > width || y < 0 || y > height) {
    fail(`锚点 screen 像素坐标 [${x}, ${y}] 超出当前画幅 [0, ${width}] × [0, ${height}]`);
  }
  return [x, y];
}

function toPixelBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || box.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    fail('实体 bbox2d 必须是 [x0, y0, x1, y1] 有限数四元组');
  }
  const [x0, y0, x1, y1] = box;
  if (x1 < x0 || y1 < y0) fail(`实体 bbox2d 边界顺序有误：[${box.join(', ')}]`);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  if (x1 < 0 || x0 > width || y1 < 0 || y0 > height || cx < 0 || cx > width || cy < 0 || cy > height) {
    fail(`实体 bbox2d [${box.join(', ')}] 超出当前画幅 [0, ${width}] × [0, ${height}]`);
  }
  return [x0, y0, x1, y1];
}

function validateFrameMetaObject(frameMeta, width, height) {
  if (!isPlainObject(frameMeta)) fail('frameMeta 必须是普通对象');
  checkAllowedKeys('frameMeta', frameMeta, ALLOWED_META_KEYS);
  if (frameMeta.format !== undefined && frameMeta.format !== 'meta/0.1') {
    fail(`frameMeta.format 必须是 "meta/0.1"`);
  }
  if (frameMeta.size !== undefined) {
    if (
      !Array.isArray(frameMeta.size)
      || frameMeta.size.length !== 2
      || frameMeta.size[0] !== width
      || frameMeta.size[1] !== height
    ) {
      fail(`frameMeta.size 与当前画幅 [${width}, ${height}] 不一致`);
    }
  }
  if (frameMeta.entities !== undefined && frameMeta.entities !== null) {
    if (Array.isArray(frameMeta.entities)) {
      for (let i = 0; i < frameMeta.entities.length; i++) {
        const e = frameMeta.entities[i];
        if (!isPlainObject(e)) fail(`frameMeta.entities[${i}] 必须是普通对象`);
        checkAllowedKeys(`frameMeta.entities[${i}]`, e, ALLOWED_ENTITY_KEYS);
      }
    } else if (isPlainObject(frameMeta.entities)) {
      for (const [k, e] of Object.entries(frameMeta.entities)) {
        if (!isPlainObject(e)) fail(`frameMeta.entities.${k} 必须是普通对象`);
        checkAllowedKeys(`frameMeta.entities.${k}`, e, ALLOWED_ENTITY_KEYS);
      }
    } else {
      fail('frameMeta.entities 必须是数组或普通对象');
    }
  }
  if (frameMeta.ext !== undefined) {
    if (!isPlainObject(frameMeta.ext)) fail('frameMeta.ext 必须是普通对象');
    for (const k of Object.keys(frameMeta.ext)) {
      if (!/^[a-z][a-z0-9-]*\.[A-Za-z0-9_.-]+$/.test(k)) {
        fail(`frameMeta.ext 键 ${JSON.stringify(k)} 不符合 "<namespace>.<key>" 格式`);
      }
    }
  }
}

function findEntityInMeta(frameMeta, entityName) {
  const entities = frameMeta.entities;
  if (Array.isArray(entities)) {
    return entities.find((e) => e && e.name === entityName) ?? null;
  }
  if (isPlainObject(entities)) {
    if (entities[entityName]) return entities[entityName];
  }
  return null;
}

/**
 * 从单帧元数据 frameMeta（meta/0.1 或兼容结构）中提取 callout 指向的屏幕像素锚点。
 */
export function resolveAnchorPoint(rawFrameMeta, rawCallout, rawSize = [1280, 720]) {
  const frameMeta = snapValue('frameMeta', rawFrameMeta);
  const callout = snapValue('callout', rawCallout);
  const size = snapValue('size', rawSize);
  if (!isPlainObject(frameMeta)) fail('frameMeta 必须是普通对象');
  if (!isPlainObject(callout)) fail('callout 必须是普通对象');
  checkAllowedKeys('callout', callout, ALLOWED_CALLOUT_KEYS);
  if (!Array.isArray(size) || size.length !== 2 || !Number.isInteger(size[0]) || !Number.isInteger(size[1]) || size[0] < 16 || size[1] < 16) {
    fail('size 必须是 [width, height] 正整数像素尺寸（至少 16×16）');
  }
  const [width, height] = size;
  validateFrameMetaObject(frameMeta, width, height);

  const entityName = callout.entity;
  const anchorName = callout.anchor;
  if (typeof entityName !== 'string' || !ENTITY_NAME_RE.test(entityName)) {
    fail('callout.entity 不合法');
  }
  if (anchorName !== undefined && (typeof anchorName !== 'string' || !ANCHOR_NAME_RE.test(anchorName))) {
    fail('callout.anchor 不合法');
  }
  if (callout.id !== undefined && (typeof callout.id !== 'string' || !CALLOUT_ID_RE.test(callout.id))) {
    fail('callout.id 不合法');
  }
  if (callout.text !== undefined && (typeof callout.text !== 'string' || callout.text.trim().length === 0)) {
    fail('callout.text 不能为空');
  }
  if (callout.dx !== undefined && (typeof callout.dx !== 'number' || !Number.isFinite(callout.dx))) {
    fail('callout.dx 必须是有限数');
  }
  if (callout.dy !== undefined && (typeof callout.dy !== 'number' || !Number.isFinite(callout.dy))) {
    fail('callout.dy 必须是有限数');
  }
  if (callout.startFrame !== undefined && (!Number.isInteger(callout.startFrame) || callout.startFrame < 0)) {
    fail('callout.startFrame 必须是非负整数');
  }
  if (callout.endFrame !== undefined && (!Number.isInteger(callout.endFrame) || callout.endFrame < 1)) {
    fail('callout.endFrame 必须是正整数');
  }

  const entity = findEntityInMeta(frameMeta, entityName);
  if (!entity) {
    return { found: false, visible: false, x: 0, y: 0, source: 'missing' };
  }
  if (entity.visible === 0 || entity.visible === false || (entity.bbox2d === null && !entity.anchors)) {
    return { found: true, visible: false, x: 0, y: 0, source: 'hidden' };
  }

  if (anchorName !== undefined) {
    if (entity.anchors !== undefined && !isPlainObject(entity.anchors)) {
      fail(`实体 ${entityName}.anchors 必须是普通对象`);
    }
    const rawAnchor = entity.anchors?.[anchorName] ?? frameMeta.anchors?.[`${entityName}.${anchorName}`] ?? frameMeta.anchors?.[anchorName];
    if (!rawAnchor) {
      fail(`实体 ${entityName} 在当前帧缺少所要求的锚点 ${JSON.stringify(anchorName)}`);
    }
    if (!Array.isArray(rawAnchor)) {
      if (!isPlainObject(rawAnchor)) fail(`锚点 ${entityName}.${anchorName} 必须是数组或普通对象`);
      checkAllowedKeys(`anchor(${entityName}.${anchorName})`, rawAnchor, ALLOWED_ANCHOR_KEYS);
    }
    const screenPt = Array.isArray(rawAnchor)
      ? rawAnchor
      : Array.isArray(rawAnchor.screen)
        ? rawAnchor.screen
        : (typeof rawAnchor.x === 'number' && typeof rawAnchor.y === 'number' ? [rawAnchor.x, rawAnchor.y] : null);
    if (!screenPt) fail(`锚点 ${entityName}.${anchorName} 缺少合法的 screen 坐标`);
    const [x, y] = toPixelPoint(screenPt, width, height);
    return { found: true, visible: true, x, y, source: `anchor:${anchorName}` };
  }

  if (isPlainObject(entity.anchors) && isPlainObject(entity.anchors.center) && Array.isArray(entity.anchors.center.screen)) {
    checkAllowedKeys(`anchor(${entityName}.center)`, entity.anchors.center, ALLOWED_ANCHOR_KEYS);
    const [x, y] = toPixelPoint(entity.anchors.center.screen, width, height);
    return { found: true, visible: true, x, y, source: 'anchor:center' };
  }

  if (!Array.isArray(entity.bbox2d)) {
    return { found: true, visible: false, x: 0, y: 0, source: 'no-bbox2d' };
  }
  const [x0, y0, x1, y1] = toPixelBox(entity.bbox2d, width, height);
  return {
    found: true,
    visible: true,
    x: (x0 + x1) / 2,
    y: (y0 + y1) / 2,
    source: 'bbox2d-center',
  };
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function blendPixel(rgba, width, height, px, py, rgb, alpha) {
  if (alpha <= 0 || px < 0 || py < 0 || px >= width || py >= height) return;
  const a = Math.max(0, Math.min(1, alpha));
  const idx = (py * width + px) * 4;
  const da = rgba[idx + 3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c++) {
    rgba[idx + c] = Math.round((rgb[c] * a + rgba[idx + c] * da * (1 - a)) / outA);
  }
  rgba[idx + 3] = Math.round(outA * 255);
}

function sampleTextGlyph(text, lx0, ly0, lx1, ly1, strokePx, padPx, cx, cy) {
  const insetX = Math.max(strokePx + 1, Math.min(padPx, (lx1 - lx0) * 0.15));
  const insetY = Math.max(strokePx + 1, Math.min(padPx, (ly1 - ly0) * 0.18));
  const tx0 = lx0 + insetX;
  const tx1 = lx1 - insetX;
  const ty0 = ly0 + insetY;
  const ty1 = ly1 - insetY;
  if (tx1 <= tx0 || ty1 <= ty0) return false;
  if (cx < tx0 || cx >= tx1 || cy < ty0 || cy >= ty1) return false;

  const { totalCols, totalRows, grid } = getTitleGlyphGrid(text);
  const col = Math.floor(((cx - tx0) / (tx1 - tx0)) * totalCols);
  const row = Math.floor(((cy - ty0) / (ty1 - ty0)) * totalRows);
  if (col < 0 || col >= totalCols || row < 0 || row >= totalRows) return false;
  return grid[row * totalCols + col] === 1;
}

/**
 * 卡主入口 create(ctx, params)
 */
export function create(rawCtx, rawParams = {}) {
  if (!isPlainObject(rawCtx)) fail('ctx 必须是普通对象');
  const framesFn = typeof rawCtx.frames === 'function' ? rawCtx.frames : null;
  const ctx = snapValue('ctx', framesFn ? { ...rawCtx, frames: undefined } : rawCtx);
  const params = snapValue('params', rawParams);
  checkAllowedKeys('ctx', ctx, ['size', 'shot', 'frames', 'fps']);
  if (!Array.isArray(ctx.size) || ctx.size.length !== 2 || !Number.isInteger(ctx.size[0]) || !Number.isInteger(ctx.size[1]) || ctx.size[0] < 64 || ctx.size[1] < 64) {
    fail('ctx.size 必须是 [width, height] 正整数像素尺寸（至少 64×64）');
  }
  const [width, height] = ctx.size;

  const shotFrames = ctx.shot?.frames ?? Infinity;
  if (ctx.shot !== undefined) {
    if (!isPlainObject(ctx.shot)) fail('ctx.shot 必须是普通对象');
    checkAllowedKeys('ctx.shot', ctx.shot, ['in', 'frames', 'id']);
    if (ctx.shot.in !== undefined && (!Number.isInteger(ctx.shot.in) || ctx.shot.in < 0)) fail('ctx.shot.in 必须是非负整数');
    if (ctx.shot.frames !== undefined && (!Number.isInteger(ctx.shot.frames) || ctx.shot.frames < 1)) fail('ctx.shot.frames 必须是正整数');
  }

  if (!isPlainObject(params)) fail('params 必须是普通对象');
  checkAllowedKeys('params', params, ['callouts', 'safeMarginPx', 'fontPx', 'padPx', 'dotRadiusPx', 'strokePx', 'ink', 'fill']);

  const rawCallouts = params.callouts;
  if (!Array.isArray(rawCallouts) || rawCallouts.length < 1) {
    fail('params.callouts 必须是至少含一项标注的数组');
  }

  const safeMarginPx = params.safeMarginPx ?? 24;
  const fontPx = params.fontPx ?? 18;
  const padPx = params.padPx ?? 8;
  const dotRadiusPx = params.dotRadiusPx ?? 4;
  const strokePx = params.strokePx ?? 2;
  if (!(typeof safeMarginPx === 'number' && Number.isFinite(safeMarginPx) && safeMarginPx >= 0 && safeMarginPx <= Math.min(width, height) / 3)) {
    fail('safeMarginPx 不合法');
  }
  if (!(typeof fontPx === 'number' && Number.isFinite(fontPx) && fontPx >= 8 && fontPx <= 96)) fail('fontPx 必须在 [8, 96] 内');
  if (!(typeof padPx === 'number' && Number.isFinite(padPx) && padPx >= 2 && padPx <= 48)) fail('padPx 必须在 [2, 48] 内');
  if (!(typeof dotRadiusPx === 'number' && Number.isFinite(dotRadiusPx) && dotRadiusPx >= 1 && dotRadiusPx <= 24)) fail('dotRadiusPx 必须在 [1, 24] 内');
  if (!(typeof strokePx === 'number' && Number.isFinite(strokePx) && strokePx >= 1 && strokePx <= 12)) fail('strokePx 必须在 [1, 12] 内');

  const inkRgb = parseHexColor('params.ink', params.ink ?? '#FFFFFF');
  const fillRgb = parseHexColor('params.fill', params.fill ?? '#101824');

  const seenIds = new Set();
  const callouts = rawCallouts.map((c, idx) => {
    if (!isPlainObject(c)) fail(`callouts[${idx}] 必须是普通对象`);
    checkAllowedKeys(`callouts[${idx}]`, c, ALLOWED_CALLOUT_KEYS);
    if (typeof c.id !== 'string' || !CALLOUT_ID_RE.test(c.id)) {
      fail(`callouts[${idx}].id 必须是小写字母开头的合法标识符`);
    }
    if (seenIds.has(c.id)) fail(`callouts 中存在重复的 id ${JSON.stringify(c.id)}`);
    seenIds.add(c.id);
    if (typeof c.entity !== 'string' || !ENTITY_NAME_RE.test(c.entity)) {
      fail(`callouts[${idx}].entity 不合法`);
    }
    if (c.anchor !== undefined && (typeof c.anchor !== 'string' || !ANCHOR_NAME_RE.test(c.anchor))) {
      fail(`callouts[${idx}].anchor 不合法`);
    }
    if (typeof c.text !== 'string' || c.text.trim().length === 0) {
      fail(`callouts[${idx}].text 不能为空`);
    }
    const dx = c.dx ?? 72;
    const dy = c.dy ?? -48;
    if (typeof dx !== 'number' || !Number.isFinite(dx)) {
      fail(`callouts[${idx}].dx 必须是有限数`);
    }
    if (typeof dy !== 'number' || !Number.isFinite(dy)) {
      fail(`callouts[${idx}].dy 必须是有限数`);
    }
    const startFrame = c.startFrame ?? 0;
    const endFrame = c.endFrame ?? (Number.isFinite(shotFrames) ? shotFrames : 1000000);
    if (!Number.isInteger(startFrame) || startFrame < 0) fail(`callouts[${idx}].startFrame 必须是非负整数`);
    if (!Number.isInteger(endFrame) || endFrame <= startFrame || endFrame > shotFrames) {
      fail(`callouts[${idx}].endFrame 必须大于 startFrame 且不超过镜头帧数`);
    }
    return {
      id: c.id,
      entity: c.entity,
      ...(c.anchor !== undefined ? { anchor: c.anchor } : {}),
      text: c.text,
      dx,
      dy,
      startFrame,
      endFrame,
    };
  });

  function resolveMetaForFrame(rawFrame, explicitMeta) {
    const f = snapValue('frame', rawFrame);
    if (!Number.isInteger(f) || f < 0 || f >= shotFrames) {
      fail('帧号 f 必须是镜头内的非负整数');
    }
    let metaObj;
    if (explicitMeta !== undefined) {
      metaObj = snapValue('frameMeta', explicitMeta);
    } else if (framesFn) {
      metaObj = snapValue('frameMeta', framesFn(f));
    } else if (Array.isArray(ctx.frames) && ctx.frames[f] !== undefined) {
      metaObj = ctx.frames[f];
    } else if (isPlainObject(ctx.frames) && ctx.frames[String(f)] !== undefined) {
      metaObj = ctx.frames[String(f)];
    } else {
      fail(`第 ${f} 帧未传入 frameMeta，且 ctx.frames 中没有对应帧的元数据`);
    }
    validateFrameMetaObject(metaObj, width, height);
    return { f, frameMeta: metaObj };
  }

  function layout(rawFrame, explicitMeta) {
    const { f, frameMeta } = resolveMetaForFrame(rawFrame, explicitMeta);
    const items = [];
    const texts = [];
    const readings = { activeCount: 0 };

    for (const c of callouts) {
      if (f < c.startFrame || f >= c.endFrame) continue;
      const anchorInfo = resolveAnchorPoint(frameMeta, c, [width, height]);
      if (!anchorInfo.found || !anchorInfo.visible) continue;

      const ax = Math.max(0, Math.min(width, anchorInfo.x));
      const ay = Math.max(0, Math.min(height, anchorInfo.y));
      const charCount = [...c.text].length;
      const boxW = Math.min(width - 2 * safeMarginPx, Math.round(charCount * fontPx * 0.62 + padPx * 2));
      const boxH = Math.min(height - 2 * safeMarginPx, Math.round(fontPx + padPx * 2));

      const rawAttachX = ax + c.dx;
      const rawAttachY = ay + c.dy;
      const rawX0 = c.dx >= 0 ? rawAttachX : rawAttachX - boxW;
      const rawY0 = rawAttachY - boxH / 2;

      const minX = safeMarginPx;
      const minY = safeMarginPx;
      const maxX = width - safeMarginPx - boxW;
      const maxY = height - safeMarginPx - boxH;

      const x0 = Math.max(minX, Math.min(maxX, rawX0));
      const y0 = Math.max(minY, Math.min(maxY, rawY0));
      const x1 = x0 + boxW;
      const y1 = y0 + boxH;
      const clamped = Math.abs(x0 - rawX0) > 1e-6 || Math.abs(y0 - rawY0) > 1e-6;

      const boxCenterX = (x0 + x1) / 2;
      const attachX = boxCenterX >= ax ? x0 : x1;
      const attachY = (y0 + y1) / 2;
      const rawElbowX = attachX + (boxCenterX >= ax ? -Math.min(18, Math.abs(attachX - ax) * 0.35) : Math.min(18, Math.abs(attachX - ax) * 0.35));
      const elbowX = Math.max(safeMarginPx, Math.min(width - safeMarginPx, rawElbowX));
      const elbowY = Math.max(safeMarginPx, Math.min(height - safeMarginPx, attachY));

      const leader = [
        [ax, ay],
        [elbowX, elbowY],
        [attachX, attachY],
      ];

      const reach = Math.max(dotRadiusPx, strokePx) + 1;
      const itemBbox = [
        Math.max(0, Math.min(x0 - strokePx, ax - reach, elbowX - reach)),
        Math.max(0, Math.min(y0 - strokePx, ay - reach, elbowY - reach)),
        Math.min(width, Math.max(x1 + strokePx, ax + reach, elbowX + reach)),
        Math.min(height, Math.max(y1 + strokePx, ay + reach, elbowY + reach)),
      ];

      const labelBox = [x0, y0, x1, y1];
      items.push({
        id: c.id,
        entity: c.entity,
        ...(c.anchor !== undefined ? { anchor: c.anchor } : {}),
        text: c.text,
        anchorPoint: [ax, ay],
        labelBox,
        leader,
        clamped,
        bbox: itemBbox,
      });

      texts.push({
        id: c.id,
        text: c.text,
        bbox2d: labelBox,
      });

      readings.activeCount++;
      readings[`${c.id}.anchorX`] = ax;
      readings[`${c.id}.anchorY`] = ay;
      readings[`${c.id}.boxX0`] = x0;
      readings[`${c.id}.boxY0`] = y0;
      readings[`${c.id}.clamped`] = clamped ? 1 : 0;
    }

    const unionBbox = items.length === 0
      ? [0, 0, 0, 0]
      : [
        Math.min(...items.map((it) => it.bbox[0])),
        Math.min(...items.map((it) => it.bbox[1])),
        Math.max(...items.map((it) => it.bbox[2])),
        Math.max(...items.map((it) => it.bbox[3])),
      ];

    return {
      frame: f,
      items,
      texts,
      readings,
      bbox: unionBbox,
    };
  }

  function draw(rawFrame, rgba, explicitMeta) {
    const f = snapValue('frame', rawFrame);
    validateRgbaBuffer('rgba', rgba, width * height * 4);
    const plan = layout(f, explicitMeta);
    for (const item of plan.items) {
      const [bx0, by0, bx1, by1] = item.bbox.map((v, i) => (i < 2 ? Math.max(0, Math.floor(v)) : Math.min(i % 2 ? height : width, Math.ceil(v))));
      const [lx0, ly0, lx1, ly1] = item.labelBox;
      const [[ax, ay], [ex, ey], [tx, ty]] = item.leader;

      for (let py = by0; py < by1; py++) {
        for (let px = bx0; px < bx1; px++) {
          const cx = px + 0.5;
          const cy = py + 0.5;

          // 1. 标签底盒、边框与 5×7 点阵文字字形
          const inBox = cx >= lx0 && cx <= lx1 && cy >= ly0 && cy <= ly1;
          const inInner = cx >= lx0 + strokePx && cx <= lx1 - strokePx && cy >= ly0 + strokePx && cy <= ly1 - strokePx;
          if (inBox) {
            if (inInner) {
              blendPixel(rgba, width, height, px, py, fillRgb, 0.85);
              if (sampleTextGlyph(item.text, lx0, ly0, lx1, ly1, strokePx, padPx, cx, cy)) {
                blendPixel(rgba, width, height, px, py, inkRgb, 0.98);
              }
            } else {
              blendPixel(rgba, width, height, px, py, inkRgb, 0.95);
            }
          }

          // 2. 折线引线与锚点圆点
          const dSeg1 = distToSegment(cx, cy, ax, ay, ex, ey);
          const dSeg2 = distToSegment(cx, cy, ex, ey, tx, ty);
          const dLine = Math.min(dSeg1, dSeg2);
          const dDot = Math.hypot(cx - ax, cy - ay);

          const lineCover = Math.max(0, Math.min(1, strokePx * 0.5 - dLine + 0.5));
          const dotCover = Math.max(0, Math.min(1, dotRadiusPx - dDot + 0.5));
          const lineAlpha = Math.max(lineCover * 0.9, dotCover * 0.95);
          if (lineAlpha > 0) {
            blendPixel(rgba, width, height, px, py, inkRgb, lineAlpha);
          }
        }
      }
    }
    return plan.bbox;
  }

  return {
    object: {
      callouts,
      layout,
      at: layout,
      draw,
    },
    meta(rawFrame, explicitMeta) {
      const plan = layout(rawFrame, explicitMeta);
      return {
        texts: plan.texts,
        readings: plan.readings,
      };
    },
    dispose() {},
  };
}
