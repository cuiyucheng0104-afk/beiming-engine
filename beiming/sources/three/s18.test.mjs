// S18：three 页面宿主的场景参考通路（04 §4.1、06 M1b-8）。成片落到 RGBA16F 目标、读回半浮点、送出浏览器落成 EXR；
// 2 倍超采样的编号层；锚点投到屏幕。纯函数部分不起浏览器；实渲部分起无头、静音的浏览器（起不了时跳过），
// 场景是 beiming/calib/ 的灰阶色卡和三个互相遮挡的方块（探针镜头 s18-probe.shot.js 照规格搭）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startSource } from '../../host/page/host.mjs';
import { placeAnchors } from '../../host/page/measure.js';
import { shotInput } from '../../kernel/eval/input.mjs';
import { readExr } from '../../verify/exr/exr.mjs';
import { coverage2x, float16ToFloat32 } from './source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const GRAY = await readJson(join(HERE, '../../calib/probe-gray-chart/scene.json'));
const OCCLUSION = await readJson(join(HERE, '../../calib/probe-occlusion/scene.json'));
const named = (id) => id.replaceAll('-', '_');
const CUBES = OCCLUSION.objects.map((o) => named(o.id));

const shot = (id, scene, more = {}) => ({ id, in: 0, out: 12, source: 'three', host: 'page', mode: 'native-code', entry: 's18-probe.shot.js', colorRef: 'scene', seed: 18, params: { scene }, ...more });
const film = (size) => ({
  format: 'film/3.0',
  id: 's18-probe',
  output: { size, fps: '24/1', frames: 12 },
  shots: [
    shot('gray', 'probe-gray-chart'),
    shot('gray-display', 'probe-gray-chart', { colorRef: 'display' }),
    shot('occ', 'probe-occlusion', { roles: { hero: CUBES[0], mustSee: CUBES.slice(1) } }),
    ...CUBES.map((only) => shot(`occ-${only}`, 'probe-occlusion', { params: { scene: 'probe-occlusion', only } })),
  ],
});

/** 起帧源跑 fn({ open, read })：open(镜头, 画幅) 开会话，read(层引用) 读层文件并核对哈希。起不了浏览器时跳过 */
async function withSource(t, fn) {
  let source;
  try { source = await startSource(); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-s18-'));
  try {
    await fn({
      open: (id, size = [640, 360]) => source.open(shotInput(film(size), id), { lock: null, tier: 'final', workspace, filmDir: HERE }),
      async read(ref) {
        const bytes = await readFile(join(workspace, ref.file));
        assert.equal(ref.hash, `sha256:${createHash('sha256').update(bytes).digest('hex')}`, ref.file);
        return bytes;
      },
    });
  } finally {
    await source.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}
const typed = (T, bytes) => new T(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));

// ---------- 纯函数 ----------

test('binary16 的位型解成数：正常数、次正常数、正负零、无穷、非数', () => {
  for (const [bits, want] of [[0x0000, 0], [0x3c00, 1], [0x4000, 2], [0x4c00, 16], [0xc000, -2], [0x3800, 0.5], [0x7bff, 65504], [0x0001, 2 ** -24], [0x03ff, 1023 * 2 ** -24], [0x0400, 2 ** -14], [0x2e66, 0.0999755859375], [0x7c00, Infinity], [0xfc00, -Infinity]]) {
    assert.equal(float16ToFloat32(bits), want, `0x${bits.toString(16)}`);
  }
  assert.ok(Object.is(float16ToFloat32(0x8000), -0));
  assert.ok(Number.isNaN(float16ToFloat32(0x7e00)));
});

test('2 倍超采样编号层的覆盖率：每个像素的 2×2 个子样本里编号和像素中心相同的占几成', () => {
  // 2 × 1 的画面：左像素编号 7、四个子样本里三个是 7；右像素编号 0（背景）、四个子样本里一个是 7
  const id2x = Uint32Array.from([7, 7, 0, 7, /* 第二行 */ 7, 0, 0, 0]);
  assert.deepEqual([...coverage2x(Uint32Array.from([7, 0]), id2x, [2, 1])], [0.75, 0.75]);
  // 子样本一个都对不上（细到落在子样本之间的东西）：0
  assert.deepEqual([...coverage2x(Uint32Array.from([3]), Uint32Array.from([0, 0, 0, 0]), [1, 1])], [0]);
});

test('锚点投到屏幕：按实体收好；写法不对、实体不认识、交了两次、坐标不是三个有限的数都报错', () => {
  // 相机在原点看向 −Z，竖直视场角 90 度，画面 200 × 100
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], proj = [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.002002, -1, 0, 0, -0.2002002, 0];
  const place = (pairs) => placeAnchors(view, proj, [200, 100], pairs, ['kit', 'kit.fan_L']);
  assert.deepEqual(place([['kit.fan_L#hub', [0, 0, -5]], ['kit#top', [0, 5, -5]], ['kit#origin', [2.5, 0, -5]]]), {
    'kit.fan_L': { hub: { world: [0, 0, -5], screen: [100, 50] } },
    kit: { top: { world: [0, 5, -5], screen: [100, 0] }, origin: { world: [2.5, 0, -5], screen: [125, 50] } },
  });
  assert.deepEqual(place([]), {});
  for (const pairs of [[['kit', [0, 0, -5]]], [['kit#', [0, 0, -5]]], [['kit#a#b', [0, 0, -5]]], [['nobody#hub', [0, 0, -5]]], [['kit#hub', [0, 0]]], [['kit#hub', [0, NaN, -5]]], [['kit#hub', '0,0,-5']], [['kit#hub', [0, 0, -5]], ['kit#hub', [1, 0, -5]]]]) {
    assert.throws(() => place(pairs), /锚点/, JSON.stringify(pairs));
  }
});

// ---------- 实渲 ----------

test('HDR 灰阶：场景参考镜头的颜色落到 RGBA16F、读回半浮点、落成 EXR，从盘上读回各级相对误差不超过 2%，大于 1 的不截', async (t) => {
  await withSource(t, async ({ open, read }) => {
    const session = await open('gray');
    const r = await session.render(0, {}, ['color']);
    // 既有的层文件不动：32 位浮点目标读回，0.1 就是 0.1 取单精度
    const f32 = typed(Float32Array, await read(r.layers.color));
    assert.equal(r.meta.hash.color, r.layers.color.hash);
    assert.deepEqual(Object.keys(r), ['meta', 'layers', 'exr']);
    assert.deepEqual(r.exr.channels, ['color.A', 'color.B', 'color.G', 'color.R']);
    const exr = readExr(await read(r.exr), { requiredChannels: r.exr.channels });
    assert.deepEqual([exr.width, exr.height], [640, 360]);

    const patches = GRAY.expected.filter((e) => e.kind === 'patchColor');
    assert.equal(patches.length, 31);
    let worst = 0;
    for (const p of patches) {
      const at = Math.floor(p.pixelPx[1]) * 640 + Math.floor(p.pixelPx[0]);
      ['R', 'G', 'B'].forEach((c, k) => {
        const got = exr.channels[`color.${c}`][at], want = p.valueLinear[k];
        if (want === 0) return assert.equal(got, 0, `${p.objectId} ${c}`);
        const err = Math.abs(got - want) / want;
        worst = Math.max(worst, err);
        assert.ok(err <= p.toleranceRatio, `${p.objectId} ${c}：读回 ${got}，规格 ${want}，相对误差 ${err}`);
      });
      assert.equal(exr.channels['color.A'][at], 1, p.objectId);
    }
    t.diagnostic(`HDR 灰阶 EXR 读回的最大相对误差 ${worst.toExponential(2)}`);
    // 最亮的四级是 2、4、8、16：半浮点里正好表示得出，读回一点不差
    const hdr = patches.filter((p) => p.valueLinear[0] > 1).map((p) => exr.channels['color.R'][Math.floor(p.pixelPx[1]) * 640 + Math.floor(p.pixelPx[0])]);
    assert.deepEqual(hdr, [2, 4, 8, 16]);
    assert.ok(r.meta.stats.luma.p99 > 1, '场景参考镜头的亮度统计不截到 1');

    // EXR 里的数真的过了一道半浮点：个个都是 binary16 表示得出的数（单精度的尾数低 13 位是 0），和 32 位层差不到半浮点的一级；
    // 0.1 这一级两边不相等（32 位层是 0.1 取单精度，半浮点表示不出它）
    const bits = new Uint32Array(1), one = new Float32Array(bits.buffer);
    let differ = 0;
    ['R', 'G', 'B', 'A'].forEach((c, k) => {
      const plane = exr.channels[`color.${c}`];
      for (let i = 0; i < plane.length; i++) {
        one[0] = plane[i];
        if (bits[0] & 0x1fff) assert.fail(`color.${c}[${i}] = ${plane[i]} 不是半浮点表示得出的数`);
        const full = f32[i * 4 + k];
        if (plane[i] !== full) differ++;
        if (Math.abs(plane[i] - full) > Math.abs(full) * 2 ** -10) assert.fail(`color.${c}[${i}]：EXR ${plane[i]} 和 32 位层 ${full} 差得超过半浮点的一级`);
      }
    });
    assert.ok(differ > 0);
    const tenth = patches.find((p) => p.objectId === 'ldr-01'), at = Math.floor(tenth.pixelPx[1]) * 640 + Math.floor(tenth.pixelPx[0]);
    assert.equal(f32[at * 4], Math.fround(0.1));
    assert.notEqual(exr.channels['color.R'][at], Math.fround(0.1));

    // 逐子帧平均之后再落 RGBA16F：不动的场景两个子帧的平均就是它自己，EXR 逐位相同
    const blurred = await session.render(0, { shutter: { angleDeg: 180, samples: 2 } }, ['color']);
    assert.equal(blurred.exr.hash, r.exr.hash);
    // 只要元数据：不出像素，也不落 EXR
    assert.deepEqual(Object.keys(await session.render(0, {}, ['meta'])), ['meta', 'layers']);
    await session.close();

    // 显示参考镜头不走这条通路
    const display = await open('gray-display');
    assert.deepEqual(Object.keys(await display.render(0, {}, ['color', 'objectId'])), ['meta', 'layers']);
    await display.close();
  });
});

/** 编号层里编号是 id 的像素的包围盒；像素 (i, j) 占 [i, i + 1) × [j, j + 1)，scale 倍超采样的换回输出像素 */
function boxOfId(ids, [w, h], id, scale) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (ids[y * w + x] !== id) continue;
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x + 1); box[3] = Math.max(box[3], y + 1);
  }
  return box.map((v) => v / scale);
}
function iou(a, b) {
  const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const inter = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  return inter / (area(a) + area(b) - inter);
}

test('三个互相遮挡的方块：元数据包围盒对单独渲的 2 倍编号层反算的交并比不低于 0.95；可见比例、深度、锚点、相机对规格', async (t) => {
  await withSource(t, async ({ open, read }) => {
    const [W, H] = [640, 360], cam = OCCLUSION.camera, focal = H / 2 / Math.tan(cam.yFovDeg * Math.PI / 360);
    const session = await open('occ');
    const r = await session.render(0, {}, ['color', 'depth', 'objectId', 'normal']);
    await session.close();
    const { meta } = r, entity = (name) => meta.entities.find((e) => e.name === name);

    // 相机：在原点看向 −Z，矩阵列主序
    assert.deepEqual(meta.camera.world, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    assert.deepEqual([meta.camera.fovYDeg, meta.camera.near, meta.camera.far, meta.camera.shutterAngleDeg], [cam.yFovDeg, cam.nearM, cam.farM, 0]);
    assert.ok(Math.abs(meta.camera.proj[5] - 1 / Math.tan(cam.yFovDeg * Math.PI / 360)) < 1e-12 && Math.abs(meta.camera.proj[0] - meta.camera.proj[5] * H / W) < 1e-12);
    assert.deepEqual(Object.keys(meta.stats), ['luma', 'noise', 'tris']);
    assert.equal(meta.stats.tris, 36);

    // 实体：包围盒、深度范围、锚点对规格
    for (const o of OCCLUSION.objects) {
      const e = entity(named(o.id)), want = OCCLUSION.expected.find((x) => x.kind === 'projectedBox' && x.objectId === o.id);
      [...want.boxMinPx, ...want.boxMaxPx].forEach((v, k) => assert.ok(Math.abs(e.bbox2d[k] - v) < 1e-3, `${o.id} bbox2d[${k}] ${e.bbox2d[k]} 对 ${v}`));
      e.bbox3d.forEach((v, k) => assert.ok(Math.abs(v - (o.positionM[k % 3] + (k < 3 ? -0.25 : 0.25))) < 1e-12, `${o.id} bbox3d[${k}]`));
      assert.ok(Math.abs(e.depth[0] - (-o.positionM[2] - 0.25)) < 1e-12 && Math.abs(e.depth[1] - (-o.positionM[2] + 0.25)) < 1e-12);
      const [x, y, z] = o.positionM, screen = [W / 2 + focal * x / -z, H / 2 - focal * y / -z];
      assert.deepEqual(Object.keys(e.anchors), ['center']);
      assert.deepEqual(e.anchors.center.world, o.positionM);
      e.anchors.center.screen.forEach((v, k) => assert.ok(Math.abs(v - screen[k]) < 1e-9, `${o.id} 锚点 ${v} 对 ${screen[k]}`));
    }
    // 可见比例：近的没被挡，中、远各被挡掉一块（探针表第 10 行：近 1.0、中 0.766、远 0.343）
    const visible = CUBES.map((name) => entity(name).visible);
    assert.equal(visible[0], 1);
    assert.ok(Math.abs(visible[1] - 0.766) < 0.03 && Math.abs(visible[2] - 0.343) < 0.03, `可见比例 ${visible.join('、')}`);

    // EXR 带上同一帧的辅助层，和层文件逐位相同；编号是整数、不串号
    assert.deepEqual(r.exr.channels, ['color.A', 'color.B', 'color.G', 'color.R', 'depth.Z', 'normal.X', 'normal.Y', 'normal.Z', 'objectId.id', 'objectId2x.coverage']);
    const exr = readExr(await read(r.exr), { requiredChannels: r.exr.channels });
    const depth = typed(Float32Array, await read(r.layers.depth)), ids = typed(Uint32Array, await read(r.layers.objectId)), normal = typed(Float32Array, await read(r.layers.normal));
    assert.deepEqual(exr.channels['depth.Z'], depth);
    assert.deepEqual(exr.channels['objectId.id'], ids);
    ['X', 'Y', 'Z'].forEach((c, k) => assert.deepEqual(exr.channels[`normal.${c}`], normal.filter((_, i) => i % 3 === k)));
    const idOf = Object.fromEntries(meta.entities.map((e) => [e.name, e.id]));
    for (const hit of OCCLUSION.expected.filter((x) => x.kind === 'pixelHits')) {
      const at = Math.floor(hit.pixelPx[1]) * W + Math.floor(hit.pixelPx[0]), first = hit.hits[0];
      assert.equal(ids[at], first ? idOf[named(first.objectId)] : 0, `像素 ${hit.pixelPx}`);
      if (first) assert.ok(Math.abs(depth[at] - first.planeDepthM) / first.planeDepthM <= hit.toleranceRatio, `像素 ${hit.pixelPx} 的深度 ${depth[at]}`);
      else assert.equal(depth[at], 1e10);
    }

    // 2 倍超采样的编号层：宽高各两倍，点采样，只有实体的编号和 0；覆盖率是 2×2 个子样本里和像素中心同号的占比
    assert.deepEqual(Object.keys(r), ['meta', 'layers', 'exr', 'objectId2x']);
    assert.deepEqual([r.objectId2x.shape, r.objectId2x.components], [[2 * H, 2 * W, 1], ['id']]);
    const id2x = typed(Uint32Array, await read(r.objectId2x));
    assert.deepEqual([...new Set(id2x)].sort(), [0, 1, 2, 3]);
    const coverage = exr.channels['objectId2x.coverage'];
    assert.deepEqual(coverage, coverage2x(ids, id2x, [W, H]));
    const mid = 220 * W + 250;
    assert.deepEqual([ids[mid], coverage[mid]], [idOf.cube_near, 1]);
    assert.ok(coverage.some((v) => v > 0 && v < 1), '方块的边上有覆盖率不满的像素');

    // 交并比：元数据的包围盒不计遮挡，所以拿每个方块单独渲的编号层去反算（探针表第 10 行）
    for (const name of CUBES) {
      const solo = await open(`occ-${name}`);
      const s = await solo.render(0, {}, ['color', 'objectId']);
      await solo.close();
      assert.deepEqual(s.meta.entities.map((e) => e.name), [name]);
      const got = iou(entity(name).bbox2d, boxOfId(typed(Uint32Array, await read(s.objectId2x)), [2 * W, 2 * H], 1, 2));
      const coarse = iou(entity(name).bbox2d, boxOfId(typed(Uint32Array, await read(s.layers.objectId)), [W, H], 1, 1));
      t.diagnostic(`${name} 交并比：2 倍编号层 ${got.toFixed(4)}，1 倍编号层 ${coarse.toFixed(4)}`);
      assert.ok(got >= 0.95, `${name} 的交并比 ${got}`);
    }
  });
});

// 只量不设门：读数进探针表（beiming/calib/table/README.md），这台机器换了、链路改了就重量一遍
test('实测每秒几帧：场景参考通路（颜色层加 RGBA16F 读回落 EXR）连渲多帧', async (t) => {
  await withSource(t, async ({ open }) => {
    for (const [size, n] of [[[640, 360], 10], [[1920, 1080], 5]]) {
      const session = await open('gray', size);
      // 头一帧带着编译着色器的开销，不计
      const warm = await session.render(0, {}, ['color']);
      const t0 = performance.now(), timing = { renderMs: 0, readbackMs: 0 };
      for (let f = 1; f <= n; f++) {
        const r = await session.render(f, {}, ['color']);
        assert.ok(r.exr.file.endsWith('.exr'));
        for (const k of Object.keys(timing)) timing[k] += r.meta.timing[k] / n;
      }
      const fps = n / ((performance.now() - t0) / 1000);
      await session.close();
      assert.ok(Number.isFinite(fps) && fps > 0);
      t.diagnostic(`${size.join('×')} 连渲 ${n} 帧：每秒 ${fps.toFixed(1)} 帧（render 调用到层文件和 EXR 落盘）；页面里每帧渲染 ${timing.renderMs.toFixed(1)} 毫秒、读回 ${timing.readbackMs.toFixed(1)} 毫秒；${warm.meta.source.gpu}`);
    }
  });
});
