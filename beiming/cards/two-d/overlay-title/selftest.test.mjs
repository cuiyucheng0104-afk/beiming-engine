// overlay.title 的自测（不起浏览器）：平面网格顶点、真字体锁定字形覆盖（含大小写英文、数字、中文片名与越界拒收）、文字框位置和大小、入场动效与纯函数摆法。实渲的核对在 cards/m1a-cards.test.mjs。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three-webgpu';
import { create } from './three.js';

const SIZE = [1920, 1080];
const params = { text: 'RTX 5090', enter: 12, settleFrames: 24, ink: '#F4F0E9', heightFrac: 0.12, distance: 1 };

/** 把卡交回的网格挂到一台竖直视场角 40 度的透视相机下面 */
function mounted(over = {}) {
  const camera = new THREE.PerspectiveCamera(40, SIZE[0] / SIZE[1], 0.1, 100);
  const handle = create({ THREE, size: SIZE }, { ...params, ...over });
  camera.add(handle.object);
  return { camera, handle, mesh: handle.object };
}
const pose = ({ handle, mesh }, f, sub = 0) => {
  handle.apply(f, sub);
  return { visible: mesh.visible, position: mesh.position.toArray(), scale: mesh.scale.toArray(), opacity: mesh.material.opacity };
};

test('overlay.title：交回正对相机的平面网格（4 顶点 2 三角形）和一个根实体', () => {
  const { handle, mesh } = mounted();
  assert.equal(mesh.geometry.attributes.position.count, 4);
  assert.deepEqual(Object.keys(handle), ['object', 'entities', 'apply', 'meta', 'dispose']);
  assert.deepEqual(handle.entities, { plane: { object: mesh, root: true } });
});

test('overlay.title：支持大写、小写英文与中文片名；落定之后文字框高 129.6 像素（画面高的 0.12）、上下左右居中', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} 应是 ${b}`);
  const widths = {};
  for (const text of ['北冥', 'RTX 5090', 'Hello World']) {
    const m = mounted({ text });
    pose(m, 60);
    const [{ id, text: got, bbox2d: [x0, y0, x1, y1] }] = m.handle.meta(60).texts;
    assert.deepEqual([id, got], ['line', text]);
    close(y1 - y0, 129.6);
    close((y0 + y1) / 2, 540);
    close((x0 + x1) / 2, 960);
    widths[text] = x1 - x0;
    assert.ok(widths[text] > 129.6);
    m.handle.dispose();
  }
  assert.ok(widths['北冥'] < widths['RTX 5090'] && widths['RTX 5090'] < widths['Hello World']);
  const clipped = create({ THREE, size: [640, 360] }, { ...params, text: 'Hello World', heightFrac: 0.35 });
  const cam = new THREE.PerspectiveCamera(40, 640 / 360, 0.1, 100);
  cam.add(clipped.object);
  clipped.apply(60, 0);
  const [cx0, cy0, cx1, cy1] = clipped.meta(60).texts[0].bbox2d;
  assert.ok(cx0 === 0 && cx1 === 640 && cy0 >= 0 && cy1 <= 360);
  clipped.dispose();
});

test('overlay.title：平面离相机 distance 米，字高按视场角换成米', () => {
  const m = mounted(), { position, scale } = pose(m, 60);
  assert.deepEqual(position, [0, 0, -1]);
  const worldH = 0.12 * 2 * Math.tan((20 * Math.PI) / 180);
  assert.ok(Math.abs(scale[0] - worldH) < 1e-12 && scale[0] === scale[1] && scale[2] === 1);
  const far = pose(mounted({ distance: 4 }), 60);
  assert.ok(far.position[2] === -4 && Math.abs(far.scale[0] - 4 * worldH) < 1e-12);
});

test('overlay.title：入场前不画也不交文字框；入场支持 rise/settle/fade 三种纯函数动效；落定之后每一帧的摆法相同', () => {
  const m = mounted();
  assert.equal(pose(m, 11).visible, false);
  assert.equal(pose(m, 12).visible, false);
  assert.deepEqual(m.handle.meta(12), { texts: [] });
  const mid = pose(m, 24);
  assert.ok(mid.visible && mid.opacity === 0.875 && mid.position[1] < 0);
  assert.ok(m.handle.meta(24).texts[0].bbox2d[1] > m.handle.meta(60).texts[0].bbox2d[1]);
  const settled = pose(m, 36);
  assert.deepEqual([settled.opacity, settled.position[1]], [1, 0]);
  for (const f of [37, 42, 119]) assert.deepEqual(pose(m, f), settled);
  assert.deepEqual(pose(m, 41, 0.75), settled);

  const settleMid = pose(mounted({ motion: 'settle' }), 24);
  assert.ok(settleMid.visible && settleMid.opacity === 0.875 && settleMid.scale[0] < settled.scale[0] && settleMid.position[1] < 0);
  assert.deepEqual(pose(mounted({ motion: 'settle' }), 36), settled);

  const fadeMid = pose(mounted({ motion: 'fade' }), 24);
  assert.ok(fadeMid.visible && fadeMid.opacity === 0.875 && fadeMid.position[1] === 0);
  assert.deepEqual(pose(mounted({ motion: 'fade' }), 36), settled);
});

test('overlay.title：settle-drift 入场阶段与 settle 一致且单调，落定后确定性连续微漂移不静止且文字框始终在安全画幅内', () => {
  const m = mounted({ motion: 'settle-drift' });
  const ref = mounted({ motion: 'settle' });
  assert.equal(pose(m, 12).visible, false);
  assert.deepEqual(m.handle.meta(12), { texts: [] });

  let prev = pose(m, 13);
  assert.deepEqual(prev, pose(ref, 13));
  for (let f = 14; f <= 36; f++) {
    const cur = pose(m, f);
    assert.deepEqual(cur, pose(ref, f), `入场帧 ${f} 应与 settle 完全一致`);
    assert.ok(cur.opacity > prev.opacity && cur.scale[0] > prev.scale[0] && cur.position[1] > prev.position[1]);
    prev = cur;
  }

  const baseH = prev.scale[0];
  for (let f = 37; f <= 120; f++) {
    const cur = pose(m, f);
    assert.equal(cur.visible, true);
    assert.equal(cur.opacity, 1);
    assert.ok(cur.scale[0] !== prev.scale[0] || cur.position[1] !== prev.position[1], `落定后相邻帧 ${f - 1}->${f} 不得静止`);
    assert.ok(Math.abs(cur.scale[0] - baseH) <= 0.03 * baseH + 1e-12);
    assert.ok(cur.position[1] >= -1e-12 && cur.position[1] <= 0.08 * baseH + 1e-12);
    const [x0, y0, x1, y1] = m.handle.meta(f).texts[0].bbox2d;
    assert.ok(x0 >= SIZE[0] * 0.05 && x1 <= SIZE[0] * 0.95 && y0 >= SIZE[1] * 0.05 && y1 <= SIZE[1] * 0.95);
    prev = cur;
  }

  // 纯函数：打乱顺序求值再回到同一时刻，结果逐位一致
  const target = pose(m, 53, 0.25);
  const targetMeta = m.handle.meta(53);
  pose(m, 105, 0.75);
  pose(m, 14, 0.5);
  pose(m, 8);
  assert.deepEqual(pose(m, 53, 0.25), target);
  assert.deepEqual(m.handle.meta(53), targetMeta);
  m.handle.dispose();
  ref.handle.dispose();
});

test('overlay.title：摆法只由时刻定：先摆别的帧再回来，结果相同', () => {
  const m = mounted(), first = pose(m, 20, 0.25);
  pose(m, 90);
  pose(m, 3);
  assert.deepEqual(pose(m, 20, 0.25), first);
});

test('overlay.title：锁定字体覆盖外的生僻字或表情报错；空白或未知动效报错；没挂在透视相机下面报错', () => {
  assert.throws(() => mounted({ text: '北冥𪚥' }), /字形表/);
  assert.throws(() => mounted({ text: 'RTX 🚀' }), /字形表/);
  assert.throws(() => mounted({ text: '  ' }), /亮点|墨迹/);
  assert.throws(() => mounted({ motion: 'spin' }), /动效/);
  const loose = create({ THREE, size: SIZE }, params);
  assert.throws(() => loose.apply(0, 0), /透视相机/);
});

test('overlay.title：光栅化纹理全幅填充纯白 RGB 保预乘边缘色，小字号按像素中心命中过滤游程且不污染字体集', async () => {
  const { readFileSync } = await import('node:fs');
  const fontsDir = new URL('../../../../routes/c-style/fonts/', import.meta.url);
  const saved = Object.fromEntries(['window', 'document', 'FontFace', 'location', 'fetch'].map((k) => [k, globalThis[k]]));
  const fontSet = new Set();
  globalThis.window = {};
  globalThis.location = new URL('http://127.0.0.1/');
  globalThis.FontFace = class MockFontFace {
    constructor(family, bytes, desc) { this.family = family; this.bytes = bytes; this.desc = desc; }
    async load() { return this; }
  };
  globalThis.fetch = async (url) => {
    const name = new URL(url).pathname.split('/').pop();
    const buf = readFileSync(new URL(name, fontsDir));
    return {
      ok: true,
      json: async () => JSON.parse(buf.toString('utf8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
  globalThis.document = {
    fonts: { add: (f) => fontSet.add(f), delete: (f) => fontSet.delete(f), get size() { return fontSet.size; }, ready: Promise.resolve() },
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 1,
        height: 1,
        getContext() {
          let buf = null;
          const ensure = () => { buf ??= new Uint8ClampedArray(canvas.width * canvas.height * 4); return buf; };
          return {
            measureText: () => ({ width: 40 }),
            fillText(ch, cx) {
              if (ch === ' ') return;
              const d = ensure(), w = canvas.width;
              for (let dy = 0; dy < 72; dy++) {
                for (let dx = 0; dx < 36; dx++) {
                  const k = ((20 + dy) * w + cx + dx) * 4;
                  d[k] = 255; d[k + 1] = 255; d[k + 2] = 255; d[k + 3] = dx === 0 ? 64 : 220;
                }
              }
              // 最底第 79 行放一条仅落入 [183.51, 183.60]、不命中任何像素中心 (y+0.5) 的亚像素墨迹尖
              for (let dx = 0; dx < 36; dx++) {
                const k = ((20 + 79) * w + cx + dx) * 4;
                d[k] = 255; d[k + 1] = 255; d[k + 2] = 255; d[k + 3] = 96;
              }
            },
            getImageData: () => ({ data: ensure() }),
          };
        },
      };
      return canvas;
    },
  };
  try {
    const { create: createBrowser } = await import(new URL('./three.js?browser-mock', import.meta.url));
    const cam = new THREE.PerspectiveCamera(40, 640 / 360, 0.1, 100);
    const h = createBrowser({ THREE, size: [640, 360] }, { ...params, text: 'Hello World', enter: 2, settleFrames: 6, ink: '#ffffff', heightFrac: 0.02 });
    assert.equal(fontSet.size, 0);
    cam.add(h.object);
    h.apply(8, 0);
    const texData = h.object.material.map.image.data;
    let zeroAlpha = 0, inkAlpha = 0;
    for (let i = 0; i < texData.length; i += 4) {
      assert.deepEqual([texData[i], texData[i + 1], texData[i + 2]], [255, 255, 255]);
      if (texData[i + 3] === 0) zeroAlpha++; else inkAlpha++;
    }
    assert.ok(zeroAlpha > 0 && inkAlpha > 0);
    assert.deepEqual(h.object.material.color.toArray(), [1, 1, 1]);
    const [, y0, , y1] = h.meta(8).texts[0].bbox2d.map(Math.round);
    assert.deepEqual([y0, y1], [176, 183]);
    h.dispose();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
    }
  }
});
