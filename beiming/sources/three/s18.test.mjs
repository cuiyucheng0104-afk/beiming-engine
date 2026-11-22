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
// 一致性夹具的片子：s01 是场景参考镜头，匀速方块带一颗亮度 50 的高光，180 度快门 8 个子帧
const FIXTURES = join(HERE, '../../kernel/conformance/fixtures');
const MOVING = await readJson(join(FIXTURES, 'film.json'));
// 相机搬到 (4, 0.5, −4)、朝 −X 看：右手边是 −Z。三个方块还在画面里
const EYE = [4, 0.5, -4];
const MOVED = { ...OCCLUSION, camera: { ...OCCLUSION.camera, positionM: EYE, lookAtM: [EYE[0] - 1, EYE[1], EYE[2]] } };
// 细条：竖直视场角 90 度、画面高 360，9 米外一米是 20 像素。细条宽 0.3 像素、高 40 像素，横向压在第 330 列像素的中心上（330.35 到 330.65），
// 2 倍编号层的子样本在 330.25 和 330.75，一个都打不到它；它后面 10 米处是一整面墙。编号照名字排：墙 1、占位的方块 2、细条 3
const STRIP = {
  camera: { positionM: [0, 0, 0], lookAtM: [0, 0, -1], upDir: [0, 1, 0], yFovDeg: 90, nearM: 0.1, farM: 100 },
  backgroundLinear: [0, 0, 0],
  objects: [
    { id: 'a-wall', shape: 'plane', sizeM: [60, 40], positionM: [0, 0, -10], emissionLinear: [0.2, 0.2, 0.2] },
    { id: 'b-box', shape: 'box', sizeM: [0.5, 0.5, 0.5], positionM: [-6, 0, -9], emissionLinear: [0.5, 0.5, 0.5] },
    { id: 'c-strip', shape: 'plane', sizeM: [0.015, 2], positionM: [0.525, 0, -9], emissionLinear: [1, 1, 1] },
  ],
};

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
    shot('occ-moved', null, { params: { spec: MOVED } }),
    shot('strip', null, { params: { spec: STRIP } }),
  ],
});

/** 起帧源跑 fn({ open, read })：open(镜头, 画幅, 片子, 片子所在目录) 开会话，read(层引用) 读层文件并核对哈希。起不了浏览器时跳过 */
async function withSource(t, fn) {
  let source;
  try { source = await startSource(); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-s18-'));
  try {
    await fn({
      open: (id, size = [640, 360], from = film(size), filmDir = HERE) => source.open(shotInput(from, id), { lock: null, tier: 'final', workspace, filmDir }),
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
  // 四个子样本（左上、右上、左下、右下）各算各的：只中一个是 0.25，哪一个都一样；只差左下一个是 0.75
  for (const sub of [[7, 0, 0, 0], [0, 7, 0, 0], [0, 0, 7, 0], [0, 0, 0, 7]]) assert.deepEqual([...coverage2x(Uint32Array.from([7]), Uint32Array.from(sub), [1, 1])], [0.25], sub.join());
  assert.deepEqual([...coverage2x(Uint32Array.from([7]), Uint32Array.from([7, 7, 0, 7]), [1, 1])], [0.75]);
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
    // 场景真的画进了 RGBA16F 目标，上面挂着 32 位浮点的深度纹理（探针镜头在颜色那一遍的 onBeforeRender 里看的）
    assert.deepEqual(r.meta.readings, { 'target.halfFloat': 1, 'target.depthTexture': 1, 'target.depthFloat': 1 });
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

    // EXR 里的数真的过了一道半浮点：个个都是 binary16 表示得出的数（单精度的尾数低 13 位是 0）。
    // 层文件 color 是各子帧从同一张 RGBA16F 目标读回、解成数之后的平均：一个子帧、没有后期链时和 EXR 逐个相等
    const bits = new Uint32Array(1), one = new Float32Array(bits.buffer);
    ['R', 'G', 'B', 'A'].forEach((c, k) => {
      const plane = exr.channels[`color.${c}`];
      for (let i = 0; i < plane.length; i++) {
        one[0] = plane[i];
        if (bits[0] & 0x1fff) assert.fail(`color.${c}[${i}] = ${plane[i]} 不是半浮点表示得出的数`);
        if (plane[i] !== f32[i * 4 + k]) assert.fail(`color.${c}[${i}]：EXR ${plane[i]} 和层文件 ${f32[i * 4 + k]} 不相等`);
      }
    });
    // 0.1 这一级半浮点表示不出：两边都是离它最近的那个半浮点数，不是 0.1 取单精度
    const tenth = patches.find((p) => p.objectId === 'ldr-01'), at = Math.floor(tenth.pixelPx[1]) * 640 + Math.floor(tenth.pixelPx[0]);
    assert.equal(f32[at * 4], 0.0999755859375);
    assert.equal(exr.channels['color.R'][at], 0.0999755859375);

    // 逐子帧平均之后再落 RGBA16F：不动的场景两个子帧的平均就是它自己，EXR 逐位相同
    const blurred = await session.render(0, { shutter: { angleDeg: 180, samples: 2 } }, ['color']);
    assert.equal(blurred.exr.hash, r.exr.hash);
    // 只要元数据：不出像素，也不落 EXR
    assert.deepEqual(Object.keys(await session.render(0, {}, ['meta'])), ['meta', 'layers']);
    await session.close();

    // 显示参考镜头不走这条通路：照旧画进 32 位浮点目标，不挂深度纹理
    const display = await open('gray-display');
    const shown = await display.render(0, {}, ['color', 'objectId']);
    assert.deepEqual(Object.keys(shown), ['meta', 'layers']);
    assert.deepEqual(shown.meta.readings, { 'target.halfFloat': 0, 'target.depthTexture': 0, 'target.depthFloat': 0 });
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

test('相机不在原点、转了向：元数据的相机矩阵和锚点的屏幕坐标照这台相机算', async (t) => {
  await withSource(t, async ({ open }) => {
    const [W, H] = [640, 360], focal = H / 2 / Math.tan(MOVED.camera.yFovDeg * Math.PI / 360);
    const session = await open('occ-moved');
    // 只要元数据的调用也交锚点
    const { meta } = await session.render(0, {}, ['meta']);
    await session.close();
    // 相机到世界，列主序：右 (0, 0, −1)，上 (0, 1, 0)，背后 (1, 0, 0)，位置
    [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, ...EYE, 1].forEach((v, k) => assert.ok(Math.abs(meta.camera.world[k] - v) < 1e-12, `camera.world[${k}] ${meta.camera.world[k]} 对 ${v}`));
    for (const o of OCCLUSION.objects) {
      // 手算：平面深度是沿 −X 的距离，右手边是 −Z
      const [x, y, z] = o.positionM, depth = EYE[0] - x, screen = [W / 2 + focal * (EYE[2] - z) / depth, H / 2 - focal * (y - EYE[1]) / depth];
      const { center } = meta.entities.find((e) => e.name === named(o.id)).anchors;
      assert.deepEqual(center.world, o.positionM);
      center.screen.forEach((v, k) => assert.ok(Math.abs(v - screen[k]) < 1e-9, `${o.id} 锚点 ${v} 对 ${screen[k]}`));
      assert.ok(screen[0] > 0 && screen[0] < W && screen[1] > 0 && screen[1] < H, `${o.id} 应在画面里`);
    }
  });
});

test('压在像素中心上的细条：编号层取像素中心的编号，不是 2×2 个子样本的平均；2 倍编号层打不到它，覆盖率 0', async (t) => {
  await withSource(t, async ({ open, read }) => {
    const W = 640;
    const session = await open('strip');
    const r = await session.render(0, {}, ['color', 'objectId']);
    await session.close();
    assert.deepEqual(r.meta.entities.map((e) => [e.name, e.id]), [['a_wall', 1], ['b_box', 2], ['c_strip', 3]]);
    const ids = typed(Uint32Array, await read(r.layers.objectId)), id2x = typed(Uint32Array, await read(r.objectId2x));
    const exr = readExr(await read(r.exr), { requiredChannels: r.exr.channels });
    // 细条占第 330 列的第 160 到 199 行，一共 40 个像素，别处没有
    const strip = [];
    ids.forEach((v, i) => { if (v === 3) strip.push(i); });
    assert.deepEqual(strip, Array.from({ length: 40 }, (_, k) => (160 + k) * W + 330));
    assert.deepEqual(exr.channels['objectId.id'], ids);
    assert.ok(!id2x.includes(3), '2 倍编号层的子样本打不到细条');
    for (const i of strip) {
      const y = Math.floor(i / W), x = i % W, at = 2 * y * 2 * W + 2 * x;
      // 四个子样本都落在墙上（编号 1）：平均是 1，像素中心是 3
      assert.deepEqual([id2x[at], id2x[at + 1], id2x[at + 2 * W], id2x[at + 2 * W + 1]], [1, 1, 1, 1]);
      assert.equal(exr.channels['objectId2x.coverage'][i], 0);
    }
    assert.equal(ids[180 * W + 329], 1);
    assert.equal(ids[180 * W + 331], 1);
  });
});

test('运动的高光、8 个子帧：EXR 里是各子帧在 RGBA16F 目标里的数线性平均之后的成片，不是头一个子帧', async (t) => {
  await withSource(t, async ({ open, read }) => {
    const session = await open('s01', undefined, MOVING, FIXTURES);
    const red = async (opts) => {
      const r = await session.render(24, opts, ['color']);
      const f32 = typed(Float32Array, await read(r.layers.color));
      return { exr: readExr(await read(r.exr), { requiredChannels: r.exr.channels }).channels['color.R'], f32: f32.filter((_, i) => i % 4 === 0) };
    };
    // 镜头条目：180 度快门、8 个子帧，第 k 个子帧在 sub = (2k + 1) / 32；单独渲它用快门角 720 × sub、1 个采样
    const blur = await red({}), subs = [];
    for (let k = 0; k < 8; k++) subs.push(await red({ shutter: { angleDeg: 22.5 * (2 * k + 1), samples: 1 } }));
    await session.close();
    let apart = 0, smeared = 0;
    for (let i = 0; i < blur.exr.length; i++) {
      // 单个子帧的 EXR 就是 RGBA16F 目标里的数；8 个半浮点数在双精度里求和、除以 8 都不丢位
      const mean = subs.reduce((sum, x) => sum + x.exr[i], 0) / 8;
      if (blur.f32[i] !== Math.fround(mean)) assert.fail(`像素 ${i}：层文件 ${blur.f32[i]}，各子帧平均 ${mean}`);
      if (Math.abs(blur.exr[i] - mean) > Math.abs(mean) * 2 ** -10) assert.fail(`像素 ${i}：EXR ${blur.exr[i]}，各子帧平均 ${mean}`);
      apart = Math.max(apart, Math.abs(blur.exr[i] - subs[0].exr[i]));
      if (mean > 1 && mean < 49) smeared++;
    }
    t.diagnostic(`EXR 和头一个子帧最大差 ${apart}；高光拖影上亮度在 1 到 49 之间的像素 ${smeared} 个`);
    assert.ok(apart > 10 && smeared > 10);
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

test('S18-R2-Red: 锚点投影在非单位相机位姿下精确且落在相机平面 (w=0) 时明确报错拒绝非有限坐标', () => {
  // 透视投影矩阵（fov=90°, aspect=2, near=1, far=100）：P[0]=0.5, P[5]=1, P[10]=-101/99, P[11]=-1, P[14]=-200/99, P[15]=0
  const proj = [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -101 / 99, -1, 0, 0, -200 / 99, 0];
  // 相机位于 (3,1,2) 并绕 Y 轴逆时针转 90°（世界->相机 view 矩阵列主序：vx=-z+2, vy=y-1, vz=x-3）
  const view = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 2, -1, -3, 1];
  const moved = placeAnchors(view, proj, [80, 40], [['hero#tip', [-1, 2, 1]]], ['hero']);
  assert.ok(Math.abs(moved.hero.tip.screen[0] - 45) < 1e-6 && Math.abs(moved.hero.tip.screen[1] - 15) < 1e-6);

  // 原点单位相机下，[0,0,0] 与 [1,0,0] 落在相机平面 w=0，必须明确抛错拒绝，绝不返回 [NaN,NaN] 或 [Infinity,NaN]
  const idView = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.throws(() => placeAnchors(idView, proj, [80, 40], [['hero#zero', [0, 0, 0]]], ['hero']), /hero#zero/);
  assert.throws(() => placeAnchors(idView, proj, [80, 40], [['hero#plane', [1, 0, 0]]], ['hero']), /hero#plane/);
  // 相机后面的（w 小于 0）照样做透视除法：右后方一米的点 w = −1，落点是穿过相机镜像到左边的 (20, 20)
  assert.deepEqual(placeAnchors(idView, proj, [80, 40], [['hero#back', [1, 0, 1]]], ['hero']).hero.back.screen, [20, 20]);
});

test('S18-R3-Red: 渲染目标超出 GPU 上限时报错，不把读不回的全零写成覆盖率 0', async (t) => {
  await withSource(t, async ({ open, read }) => {
    // 画面高 4、竖直视场角 90 度：10 米外的墙上一个像素 5 米见方，墙宽 60 米，每行正中 12 个像素的中心和它们的 2 倍子样本都打在墙上
    const render = async (w) => {
      const session = await open('strip', [w, 4]);
      try { return await session.render(0, {}, ['color', 'objectId']); } finally { await session.close(); }
    };
    // 这台机器的上限从报错里读：主目标一边 70000，哪种显卡都放不下
    const over = await render(70000).then(() => assert.fail('70000×4 的主目标应该报错'), (e) => e);
    const limit = Number(over.message.match(/渲染目标 70000×4 超出这台机器的 GPU 上限 (\d+)/)?.[1]);
    assert.ok(limit >= 2048 && limit < 70000 && limit % 2 === 0, over.message);

    // 2 倍编号目标正好顶到上限：照常出帧，墙上的像素覆盖率是 1
    const w = limit / 2;
    const r = await render(w);
    const exr = readExr(await read(r.exr), { requiredChannels: r.exr.channels });
    const wall = [];
    exr.channels['objectId.id'].forEach((v, i) => { if (v === 1) wall.push(i); });
    assert.deepEqual(wall, [0, 1, 2, 3].flatMap((y) => Array.from({ length: 12 }, (_, k) => y * w + w / 2 - 6 + k)));
    assert.deepEqual(wall.map((i) => exr.channels['objectId2x.coverage'][i]), wall.map(() => 1));

    // 再宽一个像素：主目标放得下，2 倍编号目标超限。以前那张目标的帧缓冲不完整，读回的全零被写成墙上覆盖率 0
    await assert.rejects(render(w + 1), new RegExp(`2 倍编号目标 ${limit + 2}×8 超出这台机器的 GPU 上限 ${limit}`));
  });
});
