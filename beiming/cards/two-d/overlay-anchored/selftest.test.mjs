import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { create, resolveAnchorPoint } from './index.mjs';

function makeFrameMeta(frame, entities, size = [1280, 720]) {
  return {
    format: 'meta/0.1',
    frame,
    shotFrame: frame,
    size,
    entities,
  };
}

test('overlay.anchored 自测：相机或主体移动时，不改一行二维代码，引线与标签框自动跟随每帧锚点平移', () => {
  const handle = create(
    { size: [1280, 720], shot: { in: 0, frames: 96 } },
    {
      callouts: [
        { id: 'fan-l', entity: 'gpu.fan_L', anchor: 'hub', text: 'DUAL AXIAL FAN L', dx: 80, dy: -45 },
        { id: 'body-core', entity: 'gpu.body', text: 'VAPOR CHAMBER', dx: -90, dy: 55 },
      ],
      safeMarginPx: 24,
    },
  );

  // 第 0 帧与第 24 帧：相机轨道旋转导致三维零件投影整体平移 (+140, -50)
  const metaF0 = makeFrameMeta(0, [
    {
      id: 1,
      name: 'gpu.fan_L',
      class: 'mesh',
      visible: 1,
      pxArea: 0.08,
      bbox2d: [380, 320, 460, 400],
      anchors: { hub: { world: [-0.06, 0, 0.025], screen: [420, 360] } },
    },
    {
      id: 2,
      name: 'gpu.body',
      class: 'mesh',
      visible: 1,
      pxArea: 0.2,
      bbox2d: [500, 300, 700, 440],
    },
  ]);

  const metaF24 = makeFrameMeta(24, [
    {
      id: 1,
      name: 'gpu.fan_L',
      class: 'mesh',
      visible: 1,
      pxArea: 0.08,
      bbox2d: [520, 270, 600, 350],
      anchors: { hub: { world: [-0.06, 0, 0.025], screen: [560, 310] } },
    },
    {
      id: 2,
      name: 'gpu.body',
      class: 'mesh',
      visible: 1,
      pxArea: 0.2,
      bbox2d: [640, 250, 840, 390],
    },
  ]);

  const plan0 = handle.object.layout(0, metaF0);
  const plan24 = handle.object.layout(24, metaF24);

  assert.equal(plan0.items.length, 2);
  assert.equal(plan24.items.length, 2);

  assert.deepEqual(plan0.items[0].anchorPoint, [420, 360]);
  assert.deepEqual(plan24.items[0].anchorPoint, [560, 310]);
  assert.equal(plan24.items[0].labelBox[0] - plan0.items[0].labelBox[0], 140);
  assert.equal(plan24.items[0].labelBox[1] - plan0.items[0].labelBox[1], -50);

  assert.deepEqual(plan0.items[1].anchorPoint, [600, 370]);
  assert.deepEqual(plan24.items[1].anchorPoint, [740, 320]);
  assert.equal(plan24.items[1].labelBox[0] - plan0.items[1].labelBox[0], 140);
  assert.equal(plan24.items[1].labelBox[1] - plan0.items[1].labelBox[1], -50);

  const m24 = handle.meta(24, metaF24);
  assert.equal(m24.texts.length, 2);
  assert.equal(m24.readings.activeCount, 2);
  assert.equal(m24.readings['fan-l.anchorX'], 560);
  assert.equal(m24.readings['fan-l.anchorY'], 310);
});

test('overlay.anchored 自测：像素坐标不误当归一化放大、越界坐标与非法偏移被拒绝，且复用 overlay.title 绘制不同文字像素有变化', () => {
  const size = [320, 200];
  // 1. 合法像素坐标 [0.5, 0.5] 严格保持 [0.5, 0.5]，绝不放大为 [160, 100]
  const metaHalfPx = makeFrameMeta(0, [
    {
      id: 1,
      name: 'gpu.body',
      class: 'mesh',
      visible: 1,
      pxArea: 0.05,
      bbox2d: [0, 0, 1, 1],
      anchors: { pin: { world: [0, 0, 0], screen: [0.5, 0.5] } },
    },
  ], size);
  const resolved = resolveAnchorPoint(metaHalfPx, { entity: 'gpu.body', anchor: 'pin' }, size);
  assert.equal(resolved.x, 0.5);
  assert.equal(resolved.y, 0.5);

  // 2. 越界像素坐标（如 x=371）与非有限偏移（如 dx: {}）一律报 usage.bad-argument
  const metaOut = makeFrameMeta(0, [
    {
      id: 1,
      name: 'gpu.body',
      class: 'mesh',
      visible: 1,
      pxArea: 0.05,
      bbox2d: [100, 80, 140, 120],
      anchors: { pin: { world: [0, 0, 0], screen: [371, 100] } },
    },
  ], size);
  assert.throws(
    () => resolveAnchorPoint(metaOut, { entity: 'gpu.body', anchor: 'pin' }, size),
    (err) => err?.code === 'usage.bad-argument',
  );
  assert.throws(
    () => create({ size }, { callouts: [{ id: 'bad-dx', entity: 'gpu.body', text: 'CORE', dx: {} }] }),
    (err) => err?.code === 'usage.bad-argument',
  );

  // 3. 把 LEFT 换成 CORE 时，texts 改变且 RGBA 缓冲像素也随之改变
  const metaCenter = makeFrameMeta(0, [
    { id: 1, name: 'gpu.body', class: 'mesh', visible: 1, pxArea: 0.1, bbox2d: [120, 80, 160, 120] },
  ], size);
  const hLeft = create({ size }, { callouts: [{ id: 'tag', entity: 'gpu.body', text: 'LEFT', dx: 40, dy: -20 }] });
  const hCore = create({ size }, { callouts: [{ id: 'tag', entity: 'gpu.body', text: 'CORE', dx: 40, dy: -20 }] });
  const rgbaLeft = new Uint8Array(size[0] * size[1] * 4);
  const rgbaCore = new Uint8Array(size[0] * size[1] * 4);
  hLeft.object.draw(0, rgbaLeft, metaCenter);
  hCore.object.draw(0, rgbaCore, metaCenter);

  assert.equal(hLeft.meta(0, metaCenter).texts[0].text, 'LEFT');
  assert.equal(hCore.meta(0, metaCenter).texts[0].text, 'CORE');
  const hashLeft = createHash('sha256').update(rgbaLeft).digest('hex');
  const hashCore = createHash('sha256').update(rgbaCore).digest('hex');
  assert.notEqual(hashLeft, hashCore, '更换 LEFT -> CORE 时实际绘制的文字字形像素必须改变');

  // 4. 兼容含标准 ext 扩展字段的 meta/0.1
  const metaWithExt = {
    ...metaCenter,
    ext: { 'page.load': { steps: ['assets', 'tracks', 'create', 'collect'] } },
  };
  assert.equal(hLeft.object.layout(0, metaWithExt).texts[0].text, 'LEFT');
});

test('overlay.anchored 自测：靠近画幅边缘时标签框钳制在 safeMarginPx 安全区内，且过 L2 纯函数门', () => {
  const width = 320;
  const height = 180;
  const safeMarginPx = 16;
  const handle = create(
    { size: [width, height], shot: { in: 0, frames: 48 } },
    {
      callouts: [
        { id: 'edge-tag', entity: 'gpu.fan_R', text: 'RIGHT FAN', dx: 60, dy: -40 },
      ],
      safeMarginPx,
      fontPx: 14,
      padPx: 6,
    },
  );

  const edgeMeta = makeFrameMeta(10, [
    { id: 1, name: 'gpu.fan_R', class: 'mesh', visible: 1, pxArea: 0.05, bbox2d: [285, 15, 305, 35] },
  ], [width, height]);

  const plan = handle.object.layout(10, edgeMeta);
  const item = plan.items[0];
  assert.equal(item.clamped, true);
  assert.ok(item.labelBox[0] >= safeMarginPx);
  assert.ok(item.labelBox[1] >= safeMarginPx);
  assert.ok(item.labelBox[2] <= width - safeMarginPx);
  assert.ok(item.labelBox[3] <= height - safeMarginPx);

  const rgba = new Uint8Array(width * height * 4);
  const bbox = handle.object.draw(10, rgba, edgeMeta);
  const [bx0, by0, bx1, by1] = [Math.floor(bbox[0]), Math.floor(bbox[1]), Math.ceil(bbox[2]), Math.ceil(bbox[3])];

  let litCount = 0;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = (py * width + px) * 4;
      if (rgba[idx] || rgba[idx + 1] || rgba[idx + 2] || rgba[idx + 3]) {
        litCount++;
        assert.ok(px >= bx0 && px < bx1 && py >= by0 && py < by1);
      }
    }
  }
  assert.ok(litCount > 50, '绘制后应有非空亮像素');

  const frames = [0, 5, 15, 30];
  const metas = Object.fromEntries(
    frames.map((f) => [
      f,
      makeFrameMeta(f, [
        { id: 1, name: 'gpu.body', class: 'mesh', visible: 1, pxArea: 0.1, bbox2d: [200 + f * 8, 180 + f * 3, 360 + f * 8, 280 + f * 3] },
      ], [640, 360]),
    ]),
  );

  const l2Handle = create(
    { size: [640, 360], frames: metas },
    { callouts: [{ id: 'core', entity: 'gpu.body', text: 'CORE', dx: 48, dy: -32 }] },
  );

  const forward = frames.map((f) => l2Handle.object.layout(f));
  const reversed = [...frames].reverse().map((f) => l2Handle.object.layout(f)).reverse();
  const single = l2Handle.object.layout(15);

  assert.deepEqual(forward, reversed);
  assert.deepEqual(single, forward[2]);
});
