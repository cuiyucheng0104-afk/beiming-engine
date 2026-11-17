// TSL ID 通道（engine/offscreen/tsl/idpass.js）：ID 编码、同组共用 ID、实心遮挡、noId / visible、不挡线的物体、未支持语义显式抛错、渲完还原状态。
// 只需要 Dawn，不需要浏览器；拿不到 GPU 适配器时跳过。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { createIdPass } from '../../engine/offscreen/tsl/idpass.js';
import { createInk } from '../../engine/offscreen/tsl/ink.js';

const W = 128, H = 72;
let gpu = null, host = null, why = null;
before(async () => {
  try { gpu = await loadGpu(); host = await createHost({ gpu, width: W, height: H }); }
  catch (e) { if (!e.code?.startsWith('env.')) throw e; why = String(e.message).split('\n')[0]; }
});
after(() => host?.dispose());

// 五个物体沿 x 排开：0 左起 A、B（同组）、C（单独）、D（不描边遮挡物，在 C 前面）、E 在最右
function world(THREE) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x808080);
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  camera.position.set(0, 0, 14); camera.lookAt(0, 0, 0);
  const box = (x, z, userData, s = 1.2) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    m.position.set(x, 0, z); Object.assign(m.userData, userData); scene.add(m);
    return m;
  };
  const o = {
    A: box(-4.5, 0, { outline: true, outlineGroup: 'g', outlineWidth: 2, outlineAlpha: 0.5 }),
    B: box(-3.4, 0, { outline: true, outlineGroup: 'g', outlineWidth: 2, outlineAlpha: 0.5 }),
    C: box(-0.5, 0, { outline: true }),
    D: box(-0.1, 3, {}, 0.8),   // 不描边：实心遮挡 C 的右半部分
    E: box(3.5, 0, { outline: true }),
  };
  return { scene, camera, o };
}
const target = THREE => new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
// 读回一个物体中心的 (id, 线宽系数, 可见度)；ID = 低 11 位 + 高位 × 2048
async function probe(THREE, renderer, t, camera, obj, dx = 0) {
  const px = await renderer.readRenderTargetPixelsAsync(t, 0, 0, W, H);
  const v = obj.position.clone().add({ x: dx, y: 0, z: 0 }).project(camera);
  const x = Math.round((v.x * 0.5 + 0.5) * W - 0.5), y = Math.round((0.5 - v.y * 0.5) * H - 0.5), i = (y * W + x) * 4;
  const f = k => THREE.DataUtils.fromHalfFloat(px[i + k]);
  return { id: f(0) + f(1) * 2048, w: f(2), a: f(3) };
}

test('ID 编码：描边物体各一个 ID，同组共用一个，宽度与可见度原样写进 z、w；遮挡物与天空是 0', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE } = gpu, { renderer } = host, { scene, camera, o } = world(THREE), tg = target(THREE), ids = createIdPass({ THREE, TSL: gpu.TSL, renderer });
  try {
    assert.equal(ids.render(scene, camera, tg), 2);   // 返回最大线宽系数
    const [A, B, C, D, E] = await Promise.all(['A', 'B', 'C', 'D', 'E'].map(k => probe(THREE, renderer, tg, camera, o[k], k === 'C' ? -0.4 : 0)));
    assert.equal(A.id, B.id);                      // 同组
    assert.ok(A.id >= 1 && C.id >= 1 && E.id >= 1);
    assert.equal(new Set([A.id, C.id, E.id]).size, 3);
    assert.deepEqual([A.w, A.a], [2, 0.5]);
    assert.deepEqual([C.w, C.a], [1, 1]);
    assert.equal(D.id, 0);                         // 实心遮挡：D 自己的位置 ID = 0（C 的左半部分在 D 外面，仍是 C 的 ID）
    assert.deepEqual([D.w, D.a], [0, 0]);
    const px = await renderer.readRenderTargetPixelsAsync(tg, 0, 0, W, H);
    assert.equal(px[0] + px[1] + px[2] + px[3], 0);   // 左上角是天空：全 0（背景在 ID 图里被摘掉了）
  } finally { ids.dispose(); tg.dispose(); tg.depthTexture.dispose(); }
});

test('visible = false、材质 noId、加色物体：都不描边也不挡线（后面的描边物体照常出现）', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE } = gpu, { renderer } = host, { scene, camera, o } = world(THREE), tg = target(THREE), ids = createIdPass({ THREE, TSL: gpu.TSL, renderer });
  try {
    const hidden = async () => (await probe(THREE, renderer, tg, camera, o.D)).id;   // D 的位置上看到什么：遮挡时是 0，不挡时是它后面的 C
    ids.render(scene, camera, tg);
    assert.equal(await hidden(), 0, '先确认 D 在挡');
    o.D.visible = false;
    ids.render(scene, camera, tg);
    assert.ok(await hidden() >= 1, 'D 不可见后它的位置应该露出后面的 C');
    o.D.visible = true; o.D.material.userData.noId = true;
    ids.render(scene, camera, tg);
    assert.ok(await hidden() >= 1, 'D 的材质 noId 后不挡线');
    o.D.material.userData.noId = false; o.D.material.blending = THREE.AdditiveBlending; o.D.material.transparent = true;
    ids.render(scene, camera, tg);
    assert.ok(await hidden() >= 1, '加色物体 auto 判成不挡线');
  } finally { ids.dispose(); tg.dispose(); tg.depthTexture.dispose(); }
});

test('未支持的语义显式抛错（不静默画错），并且抛错后场景与渲染器状态原样还原', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE } = gpu, { renderer } = host, tg = target(THREE), ids = createIdPass({ THREE, TSL: gpu.TSL, renderer });
  const cases = {
    InstancedMesh: (scene, o) => { const m = new THREE.InstancedMesh(o.A.geometry, new THREE.MeshBasicMaterial(), 2); m.userData.outline = true; scene.add(m); },
    '多材质数组的 soft 遮挡': (scene, o) => { o.D.material.transparent = true; o.D.material = [o.D.material, o.D.material.clone()]; },
    '多材质数组': (scene, o) => { o.C.material = [o.C.material, o.C.material.clone()]; },
    'alpha 镂空': (scene, o) => { o.C.material.map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); o.C.material.alphaTest = 0.5; },
    outlineVertex: (scene, o) => { o.C.userData.outlineVertex = { head: '', body: '' }; },
    '材质顶点位移': (scene, o) => { o.C.material = Object.assign(new THREE.MeshBasicNodeMaterial(), { positionNode: gpu.TSL.positionLocal }); },
  };
  try {
    for (const [name, mutate] of Object.entries(cases)) {
      const { scene, camera, o } = world(THREE), bg = scene.background;
      mutate(scene, o);
      const before = [o.A, o.B, o.C, o.D, o.E].map(m => m.material);
      assert.throws(() => ids.render(scene, camera, tg), e => e.code === 'unsupported.outline' && /未支持/.test(e.message), name);
      assert.deepEqual([o.A, o.B, o.C, o.D, o.E].map(m => m.material), before, `${name}：材质没有还原`);
      assert.equal(scene.background, bg, `${name}：场景背景没有还原`);
    }
  } finally { ids.dispose(); tg.dispose(); tg.depthTexture.dispose(); }
});

test('渲完还原：渲染目标、清屏色与场景背景都回到调用前', async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE } = gpu, { renderer } = host, { scene, camera } = world(THREE), tg = target(THREE), ids = createIdPass({ THREE, TSL: gpu.TSL, renderer });
  try {
    const mine = new THREE.RenderTarget(8, 8);
    renderer.setRenderTarget(mine); renderer.setClearColor(0x336699, 0.5);
    ids.render(scene, camera, tg);
    assert.equal(renderer.getRenderTarget(), mine);
    const c = renderer.getClearColor(new THREE.Color());
    assert.equal(c.getHex(), 0x336699); assert.equal(renderer.getClearAlpha(), 0.5);
    assert.equal(scene.background.getHex(), 0x808080);
    renderer.setRenderTarget(null); mine.dispose();
  } finally { ids.dispose(); tg.dispose(); tg.depthTexture.dispose(); }
});

test('boilHold：同一拍内笔画逐字节不动，换拍就变；k、ss 缩放线宽（不透明度 0 则一点墨也没有）', { timeout: 120000 }, async t => {
  if (why) return t.skip(`离屏出片不可用：${why}`);
  const { THREE, TSL } = gpu, { renderer } = host, { scene, camera } = world(THREE);
  const ink = createInk({ THREE, TSL, renderer }, { width: W, height: H });
  const P = { width: 2.5, wobble: 1, boilHold: 2, warp: 60, pressure: 0.3, breakup: 0, inner: 0.6, silhouette: 0.12, depthThreshold: 0.03, near: 4, far: 80, farScale: 0.6, opacity: 1 };
  const draw = async (o = {}) => {
    ink.render({ scene, camera, p: P, t: 0, k: 1, ss: 1, fps: 24, ...o });
    return Buffer.from(await renderer.readRenderTargetPixelsAsync(ink.line, 0, 0, W, H));
  };
  const sum = b => { let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return s; };
  try {
    const f0 = await draw({ t: 0 }), f1 = await draw({ t: 1 / 24 }), f2 = await draw({ t: 2 / 24 });
    assert.ok(f0.equals(f1), '帧 0 与帧 1 同一拍，笔画应该逐字节相同');
    assert.ok(!f0.equals(f2), '帧 2 换拍，笔画应该变');
    assert.ok(sum(f0) > 0);
    assert.ok(sum(await draw({ k: 2 })) > sum(f0), 'k = 2 线更粗');
    assert.equal(sum(await draw({ p: { ...P, opacity: 0 } })), 0);
  } finally { ink.dispose(); }
});
