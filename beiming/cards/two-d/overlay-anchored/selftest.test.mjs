import assert from 'node:assert/strict';
import test from 'node:test';
import { create, resolveAnchorPoint } from './index.mjs';

function makeFrameMeta(frame, entities) {
  return {
    format: 'meta/0.1',
    frame,
    shotFrame: frame,
    size: [1280, 720],
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

  // 验证 fan-l 的锚点与标签框精确平移 (+140, -50)
  assert.deepEqual(plan0.items[0].anchorPoint, [420, 360]);
  assert.deepEqual(plan24.items[0].anchorPoint, [560, 310]);
  assert.equal(plan24.items[0].labelBox[0] - plan0.items[0].labelBox[0], 140);
  assert.equal(plan24.items[0].labelBox[1] - plan0.items[0].labelBox[1], -50);

  // 验证 body-core 从 bbox2d 中心取锚点，同样精确平移 (+140, -50)
  assert.deepEqual(plan0.items[1].anchorPoint, [600, 370]);
  assert.deepEqual(plan24.items[1].anchorPoint, [740, 320]);
  assert.equal(plan24.items[1].labelBox[0] - plan0.items[1].labelBox[0], 140);
  assert.equal(plan24.items[1].labelBox[1] - plan0.items[1].labelBox[1], -50);

  // meta(f) 交出规范的 texts 与 readings
  const m24 = handle.meta(24, metaF24);
  assert.equal(m24.texts.length, 2);
  assert.equal(m24.readings.activeCount, 2);
  assert.equal(m24.readings['fan-l.anchorX'], 560);
  assert.equal(m24.readings['fan-l.anchorY'], 310);
});

test('overlay.anchored 自测：靠近画幅边缘时标签框钳制在 safeMarginPx 安全区内，且绘制亮像素 100% 落在总包围盒内', () => {
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

  // 实体靠近右上角 (295, 25)，未钳制时标签框必出画
  const edgeMeta = {
    format: 'meta/0.1',
    frame: 10,
    shotFrame: 10,
    size: [width, height],
    entities: [
      { id: 1, name: 'gpu.fan_R', class: 'mesh', visible: 1, pxArea: 0.05, bbox2d: [285, 15, 305, 35] },
    ],
  };

  const plan = handle.object.layout(10, edgeMeta);
  assert.equal(plan.items.length, 1);
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
        assert.ok(
          px >= bx0 && px < bx1 && py >= by0 && py < by1,
          `亮像素 (${px}, ${py}) 超出返回的 bbox [${bx0}, ${by0}, ${bx1}, ${by1}]`,
        );
      }
    }
  }
  assert.ok(litCount > 50, '绘制后应有非空亮像素');
});

test('overlay.anchored 自测：L2 纯函数门（顺序 / 逆序 / 单帧逐位一致）与零陷阱拦截', () => {
  const frames = [0, 5, 15, 30];
  const metas = Object.fromEntries(
    frames.map((f) => [
      f,
      makeFrameMeta(f, [
        { id: 1, name: 'gpu.body', class: 'mesh', visible: 1, pxArea: 0.1, bbox2d: [200 + f * 8, 180 + f * 3, 360 + f * 8, 280 + f * 3] },
      ]),
    ]),
  );

  const handle = create(
    { size: [640, 360], frames: metas },
    { callouts: [{ id: 'core', entity: 'gpu.body', text: 'CORE', dx: 48, dy: -32 }] },
  );

  const forward = frames.map((f) => handle.object.layout(f));
  const reversed = [...frames].reverse().map((f) => handle.object.layout(f)).reverse();
  const single = handle.object.layout(15);

  assert.deepEqual(forward, reversed);
  assert.deepEqual(single, forward[2]);

  // 零陷阱校验
  let traps = 0;
  const proxyCtx = new Proxy({ size: [640, 360] }, {
    get() {
      traps++;
      return [640, 360];
    },
  });
  assert.throws(() => create(proxyCtx, {}), (err) => err?.code === 'usage.bad-argument');

  const getterMeta = {};
  Object.defineProperty(getterMeta, 'entities', {
    enumerable: true,
    get() {
      traps++;
      return [];
    },
  });
  assert.throws(
    () => resolveAnchorPoint(getterMeta, { entity: 'gpu.body' }, [640, 360]),
    (err) => err?.code === 'usage.bad-argument',
  );
  assert.equal(traps, 0);
});
