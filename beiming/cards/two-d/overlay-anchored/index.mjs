// overlay.anchored 在合成一侧的实现：
// 1. 每一帧严格从传入的 frame-meta（meta/0.1）中读取三维实体或其命名锚点在屏幕上的投影坐标；
// 2. 闭式排版标签框 [x0, y0, x1, y1] 与三点折线引线 [[ax, ay], [ex, ey], [bx, by]]，并按 safeMarginPx 钳制在画幅安全区内；
// 3. 相机或零件运动时，二维标注自动跟随每帧锚点移动，无需改动任何二维代码；
// 4. 支持向 8 位直通透明度 RGBA 缓冲确定性绘制锚点圆点、折线引线与带边框标签底盒，并产出规范的 texts 与 readings。

const node = globalThis.process;
const isProxy = node?.versions?.node
  ? (node.getBuiltinModule?.('node:util/types') ?? await import('node:util/types')).isProxy
  : () => false;

const CALLOUT_ID_RE = /^[a-z][a-z0-9_-]*$/;
const ENTITY_NAME_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const ANCHOR_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

const fail = (message) => {
  throw Object.assign(new RangeError(`overlay.anchored：${message}`), { code: 'usage.bad-argument' });
};

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || isProxy(v) || Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function snapValue(what, v, depth = 0) {
  if (depth > 16) fail(`${what} 嵌套层级过深`);
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${what} 必须是有限数，给的是 ${v}`);
    return v;
  }
  if (typeof v !== 'object') fail(`${what} 类型不合法（${typeof v}）`);
  if (isProxy(v)) fail(`${what} 不能是 Proxy`);
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) fail(`${what} 必须是普通数组`);
    const props = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(props);
    const n = props.length?.value;
    if (!Number.isInteger(n) || keys.length !== n + 1) fail(`${what} 不能是稀疏数组或带额外属性`);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = props[i];
      if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail(`${what}[${i}] 必须是可枚举的自有数据属性`);
      out[i] = snapValue(`${what}[${i}]`, d.value, depth + 1);
    }
    return out;
  }
  if (!isPlainObject(v)) fail(`${what} 必须是普通对象`);
  const props = Object.getOwnPropertyDescriptors(v);
  const keys = Reflect.ownKeys(props);
  const out = {};
  for (const k of keys) {
    if (typeof k !== 'string') fail(`${what} 不能包含 Symbol 键`);
    const d = props[k];
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail(`${what}.${k} 不能是访问器或不可枚举属性`);
    out[k] = snapValue(`${what}.${k}`, d.value, depth + 1);
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
    fail(`${what} 必须写成 #RRGGBB，给的是 ${JSON.stringify(hex)}`);
  }
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toPixelPoint(pt, width, height) {
  if (!Array.isArray(pt) || pt.length !== 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
    fail('锚点 screen 坐标必须是 [x, y] 有限数对');
  }
  const [x, y] = pt;
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && (width > 1 || height > 1)) {
    // 若同时满足 [0, 1] 归一化范围且带小数（或严格 <= 1），只在明确是归一化时换算；
    // 为避免像素 (0,0) 或 (1,1) 歧义：只有当坐标非整数且在 (0, 1) 内时按归一化比例换算，否则直接视作像素坐标
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return [x * width, y * height];
    }
  }
  return [x, y];
}

function toPixelBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || box.some((v) => !Number.isFinite(v))) {
    fail('实体 bbox2d 必须是 [x0, y0, x1, y1] 有限数四元组');
  }
  const [x0, y0, x1, y1] = box;
  if (x1 < x0 || y1 < y0) fail(`实体 bbox2d 边界顺序有误：[${box.join(', ')}]`);
  if (x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1 && (x1 < 1 || y1 < 1 || !Number.isInteger(x0) || !Number.isInteger(y0))) {
    return [x0 * width, y0 * height, x1 * width, y1 * height];
  }
  return [x0, y0, x1, y1];
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
  if (!Array.isArray(size) || size.length !== 2 || !Number.isInteger(size[0]) || !Number.isInteger(size[1]) || size[0] < 16 || size[1] < 16) {
    fail('size 必须是 [width, height] 正整数像素尺寸（至少 16×16）');
  }
  const [width, height] = size;
  const entityName = callout.entity;
  const anchorName = callout.anchor;
  if (typeof entityName !== 'string' || !ENTITY_NAME_RE.test(entityName)) {
    fail(`callout.entity ${JSON.stringify(entityName)} 不合法`);
  }

  const entity = findEntityInMeta(frameMeta, entityName);
  if (!entity) {
    return { found: false, visible: false, x: 0, y: 0, source: 'missing' };
  }
  if (entity.visible === 0 || entity.visible === false || (entity.bbox2d === null && !entity.anchors)) {
    return { found: true, visible: false, x: 0, y: 0, source: 'hidden' };
  }

  if (anchorName !== undefined) {
    const rawAnchor = entity.anchors?.[anchorName] ?? frameMeta.anchors?.[`${entityName}.${anchorName}`] ?? frameMeta.anchors?.[anchorName];
    if (!rawAnchor) {
      fail(`实体 ${entityName} 在当前帧缺少所要求的锚点 ${JSON.stringify(anchorName)}`);
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

  if (isPlainObject(entity.anchors) && Array.isArray(entity.anchors.center?.screen)) {
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

/**
 * 卡主入口 create(ctx, params)
 */
export function create(rawCtx, rawParams = {}) {
  const ctx = snapValue('ctx', rawCtx);
  const params = snapValue('params', rawParams);
  if (!isPlainObject(ctx)) fail('ctx 必须是普通对象');
  checkAllowedKeys('ctx', ctx, ['size', 'shot', 'frames', 'fps']);
  if (!Array.isArray(ctx.size) || ctx.size.length !== 2 || !Number.isInteger(ctx.size[0]) || !Number.isInteger(ctx.size[1]) || ctx.size[0] < 64 || ctx.size[1] < 64) {
    fail('ctx.size 必须是 [width, height] 正整数像素尺寸（至少 64×64）');
  }
  const [width, height] = ctx.size;

  const shotFrames = ctx.shot?.frames ?? Infinity;
  if (ctx.shot !== undefined) {
    if (!isPlainObject(ctx.shot)) fail('ctx.shot 必须是普通对象');
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
  if (!(typeof safeMarginPx === 'number' && safeMarginPx >= 0 && safeMarginPx <= Math.min(width, height) / 3)) {
    fail(`safeMarginPx 不合法：${safeMarginPx}`);
  }
  if (!(typeof fontPx === 'number' && fontPx >= 8 && fontPx <= 96)) fail(`fontPx 必须在 [8, 96] 内，给的是 ${fontPx}`);
  if (!(typeof padPx === 'number' && padPx >= 2 && padPx <= 48)) fail(`padPx 必须在 [2, 48] 内，给的是 ${padPx}`);
  if (!(typeof dotRadiusPx === 'number' && dotRadiusPx >= 1 && dotRadiusPx <= 24)) fail(`dotRadiusPx 必须在 [1, 24] 内，给的是 ${dotRadiusPx}`);
  if (!(typeof strokePx === 'number' && strokePx >= 1 && strokePx <= 12)) fail(`strokePx 必须在 [1, 12] 内，给的是 ${strokePx}`);

  const inkRgb = parseHexColor('params.ink', params.ink ?? '#FFFFFF');
  const fillRgb = parseHexColor('params.fill', params.fill ?? '#101824');

  const seenIds = new Set();
  const callouts = rawCallouts.map((c, idx) => {
    if (!isPlainObject(c)) fail(`callouts[${idx}] 必须是普通对象`);
    checkAllowedKeys(`callouts[${idx}]`, c, ['id', 'entity', 'anchor', 'text', 'dx', 'dy', 'startFrame', 'endFrame']);
    if (typeof c.id !== 'string' || !CALLOUT_ID_RE.test(c.id)) {
      fail(`callouts[${idx}].id ${JSON.stringify(c.id)} 必须是小写字母开头的合法标识符`);
    }
    if (seenIds.has(c.id)) fail(`callouts 中存在重复的 id ${JSON.stringify(c.id)}`);
    seenIds.add(c.id);
    if (typeof c.entity !== 'string' || !ENTITY_NAME_RE.test(c.entity)) {
      fail(`callouts[${idx}].entity ${JSON.stringify(c.entity)} 不合法`);
    }
    if (c.anchor !== undefined && (typeof c.anchor !== 'string' || !ANCHOR_NAME_RE.test(c.anchor))) {
      fail(`callouts[${idx}].anchor ${JSON.stringify(c.anchor)} 不合法`);
    }
    if (typeof c.text !== 'string' || c.text.trim().length === 0) {
      fail(`callouts[${idx}].text 不能为空`);
    }
    const dx = c.dx ?? 72;
    const dy = c.dy ?? -48;
    const startFrame = c.startFrame ?? 0;
    const endFrame = c.endFrame ?? (Number.isFinite(shotFrames) ? shotFrames : 1000000);
    if (!Number.isInteger(startFrame) || startFrame < 0) fail(`callouts[${idx}].startFrame 必须是非负整数`);
    if (!Number.isInteger(endFrame) || endFrame <= startFrame || endFrame > shotFrames) {
      fail(`callouts[${idx}].endFrame (${endFrame}) 必须大于 startFrame (${startFrame}) 且不超过镜头帧数`);
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

  function resolveMetaForFrame(f, explicitMeta) {
    if (!Number.isInteger(f) || f < 0 || f >= shotFrames) {
      fail(`帧号 f 必须是镜头内的非负整数，给的是 ${f}`);
    }
    if (explicitMeta !== undefined) return snapValue('frameMeta', explicitMeta);
    if (Array.isArray(ctx.frames) && ctx.frames[f] !== undefined) return ctx.frames[f];
    if (isPlainObject(ctx.frames) && ctx.frames[String(f)] !== undefined) return ctx.frames[String(f)];
    fail(`第 ${f} 帧未传入 frameMeta，且 ctx.frames 中没有对应帧的元数据`);
  }

  function layout(f, explicitMeta) {
    const frameMeta = resolveMetaForFrame(f, explicitMeta);
    const items = [];
    const texts = [];
    const readings = { activeCount: 0 };

    for (const c of callouts) {
      if (f < c.startFrame || f >= c.endFrame) continue;
      const anchorInfo = resolveAnchorPoint(frameMeta, c, [width, height]);
      if (!anchorInfo.found || !anchorInfo.visible) continue;

      const ax = anchorInfo.x;
      const ay = anchorInfo.y;
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
      const elbowX = attachX + (boxCenterX >= ax ? -Math.min(18, Math.abs(attachX - ax) * 0.35) : Math.min(18, Math.abs(attachX - ax) * 0.35));
      const elbowY = attachY;

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

  function draw(f, rgba, explicitMeta) {
    if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || isProxy(rgba)) {
      fail('draw 的 rgba 必须是原生 Uint8Array 或 Uint8ClampedArray');
    }
    if (rgba.length !== width * height * 4) {
      fail(`draw 需要长度为 ${width} × ${height} × 4 的 RGBA 缓冲，实际长度 ${rgba.length}`);
    }
    const plan = layout(f, explicitMeta);
    for (const item of plan.items) {
      const [bx0, by0, bx1, by1] = item.bbox.map((v, i) => (i < 2 ? Math.max(0, Math.floor(v)) : Math.min(i % 2 ? height : width, Math.ceil(v))));
      const [lx0, ly0, lx1, ly1] = item.labelBox;
      const [[ax, ay], [ex, ey], [tx, ty]] = item.leader;

      for (let py = by0; py < by1; py++) {
        for (let px = bx0; px < bx1; px++) {
          const cx = px + 0.5;
          const cy = py + 0.5;

          // 1. 标签底盒与边框
          const inBox = cx >= lx0 && cx <= lx1 && cy >= ly0 && cy <= ly1;
          const inInner = cx >= lx0 + strokePx && cx <= lx1 - strokePx && cy >= ly0 + strokePx && cy <= ly1 - strokePx;
          if (inBox) {
            if (inInner) {
              blendPixel(rgba, width, height, px, py, fillRgb, 0.85);
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
    meta(f, explicitMeta) {
      const plan = layout(f, explicitMeta);
      return {
        texts: plan.texts,
        readings: plan.readings,
      };
    },
    dispose() {},
  };
}
