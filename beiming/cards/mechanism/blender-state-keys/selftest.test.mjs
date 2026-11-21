// blender.state-keys 的自测。本机有 Blender 时实跑，没有时跳过（只跑单元测试的 CI、Windows 机器）。
// 一、在后台 Blender 里直接调 create：tracks 的值是帧号的已知函数，apply(f, 0) 之后每个物体（相机连同镜头焦距）
//     正好在 f − 1、f、f + 1 有关键帧、线性插值、值就是 tracks 在那三帧的值，上一帧留下的关键帧不在了，场景停在第 f 帧；
//     sub 不是 0 时报错；dispose 之后动画清空。
// 二、L2 纯函数门：经 Blender 帧源出例子片子 film-min 的 s01（相机样条 + 这张卡写关键帧 + 快门角 180 度的原生运动模糊），
//     同一批帧按顺序、乱序、每帧单独开一次各渲一遍，颜色层逐位相同。用 CPU 渲：同一台机器上 CPU 渲的颜色层逐位可复现
//     （帧源接口契约 5.4），显卡渲两遍本来就不逐位相同，比不出跨帧状态。
// 三、关掉这张卡时同一帧开不开快门颜色层一样，开着它时不一样：原生运动模糊确实是这三帧关键帧驱动的。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findBlender, loadAssets, loadCards, startSource } from '../../../sources/blender/host.mjs';
import { runPureFunctionGate } from '../../../verify/l2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEIMING = resolve(HERE, '../../..');
const BLENDER = findBlender();
const DIRS = ['cards/camera/spline', 'cards/mechanism/blender-cycles', 'cards/mechanism/blender-state-keys'];

// 一个四元数相机、一个欧拉角物体；tracks.apply(t) 把它们摆到 t 的已知函数上。不写字节码缓存：卡目录里多出文件会改掉卡的内容哈希
const PROBE = `
import sys
sys.dont_write_bytecode = True
import importlib.util, json, math, types
import bpy
from bpy_extras import anim_utils
path = sys.argv[sys.argv.index('--') + 1]
spec = importlib.util.spec_from_file_location('card_under_test', path)
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.rotation_mode = 'QUATERNION'
box = bpy.data.objects.new('box', bpy.data.meshes.new('box'))
for o in (cam, box):
    scene.collection.objects.link(o)
calls = []

def apply(t, sub):
    calls.append([t, sub])
    cam.location = (0.1 * t, 2.0, -0.05 * t)
    cam.rotation_quaternion = (math.cos(0.01 * t), 0.0, 0.0, math.sin(0.01 * t))
    cam.data.lens = 30.0 + t
    box.location = (0.0, 0.0, 0.2 * t)
    box.rotation_euler = (0.0, 0.0, 0.03 * t)
    box.scale = (1.0, 1.0, 1.0 + 0.01 * t)

def keys(owner):
    data = owner.animation_data
    if data is None or data.action is None:
        return {}
    bag = anim_utils.action_get_channelbag_for_slot(data.action, data.action_slot)
    return {'%s[%d]' % (c.data_path, c.array_index): [[p.co[0], round(p.co[1], 6), p.interpolation] for p in c.keyframe_points] for c in bag.fcurves}

tracks = types.SimpleNamespace(objects=(cam, box), apply=apply)
handle = card.create(types.SimpleNamespace(tracks=tracks, bpy=bpy, hostScene=scene), {})
out = {'members': sorted(handle)}
handle['apply'](10, 0.0)
handle['apply'](40, 0.0)
out['calls'] = calls
out['cam'], out['lens'], out['box'] = keys(cam), keys(cam.data), keys(box)
out['restsAt'] = [round(cam.location[0], 6), round(cam.data.lens, 6), round(box.location[2], 6)]
scene.frame_set(40, subframe=0.5)
out['halfway'] = [round(cam.location[0], 6), round(box.location[2], 6)]
try:
    handle['apply'](41, 0.5)
    out['subRejected'] = False
except ValueError:
    out['subRejected'] = True
handle['dispose']()
out['afterDispose'] = [keys(cam), keys(cam.data), keys(box), len(bpy.data.actions)]
print('RESULT ' + json.dumps(out))
`;

/** 在后台 Blender 里跑一段 Python，交回它打印的 RESULT 那一行 */
async function inBlender(script, ...args) {
  const dir = await mkdtemp(join(tmpdir(), 'beiming-card-keys-'));
  try {
    await writeFile(join(dir, 'probe.py'), script);
    const run = spawnSync(BLENDER, ['-b', '-noaudio', '--factory-startup', '--python', join(dir, 'probe.py'), '--', ...args], { encoding: 'utf8', timeout: 120000 });
    const line = run.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `Blender 没打印结果：${run.stderr.slice(-2000)}`);
    return JSON.parse(line.slice('RESULT '.length));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** 例子片子 film-min 的 s01 和一份测试现算的锁 */
async function filmMin(version) {
  const film = JSON.parse(await readFile(join(BEIMING, 'kernel/contracts/examples/film-min/film.json'), 'utf8'));
  const shot = film.shots.find((s) => s.id === 's01');
  const lib = await loadCards(DIRS), assets = await loadAssets();
  const lock = {
    film: film.id, seeds: { s01: shot.seed }, shots: { s01: { shutterSamples: 1 } },
    sources: { blender: { version, host: 'cycles' } },
    cards: Object.fromEntries(Object.entries(lib).map(([name, { card, sha256 }]) => [name, { version: card.version, impl: [...card.livesIn], sha256 }])),
    assets: { 'asset:rtx-card@1': assets['asset:rtx-card@1'].sha256 },
  };
  return { film, shot, lock, input: { film: film.id, output: { size: film.output.size, fps: film.output.fps }, shot, tokens: film.style.tokens } };
}

const colorOf = async (workspace, ref) => {
  const bytes = await readFile(join(workspace, ref.file));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4).slice();
};

describe('blender.state-keys 实跑', { concurrency: false }, () => {
  test('create：apply(f) 只在 f − 1、f、f + 1 留线性关键帧，值是 tracks 在这三帧的值；sub 不是 0 报错；dispose 清空', { skip: !BLENDER && '本机没有 Blender', timeout: 180000 }, async () => {
    const got = await inBlender(PROBE, join(HERE, 'keys.py'));
    assert.deepEqual(got.members, ['apply', 'dispose']);
    // 第 40 帧：先求第 40 帧（取旋转的参考），再依次 39、40、41，最后停回 40
    assert.deepEqual(got.calls.slice(5), [[40, 0], [39, 0], [40, 0], [41, 0], [40, 0]]);
    const L = (v) => [39, 40, 41].map((t) => [t, Math.round(v(t) * 1e6) / 1e6, 'LINEAR']);
    assert.deepEqual(got.cam['location[0]'], L((t) => 0.1 * t));
    assert.deepEqual(got.cam['location[2]'], L((t) => -0.05 * t));
    assert.deepEqual(got.cam['rotation_quaternion[3]'], L((t) => Math.sin(0.01 * t)));
    assert.deepEqual(got.lens['lens[0]'], L((t) => 30 + t));
    assert.deepEqual(got.box['location[2]'], L((t) => 0.2 * t));
    assert.deepEqual(got.box['rotation_euler[2]'], L((t) => 0.03 * t));
    assert.deepEqual(got.box['scale[2]'], L((t) => 1 + 0.01 * t));
    // 第 10 帧写的关键帧一个都不留
    for (const curves of [got.cam, got.lens, got.box]) for (const [path, points] of Object.entries(curves)) assert.deepEqual(points.map((p) => p[0]), [39, 40, 41], path);
    assert.deepEqual(got.restsAt, [4, 70, 8]);
    // 线性插值：快门窗口里的第 40.5 帧正好在中间
    assert.deepEqual(got.halfway, [4.05, 8.1]);
    assert.equal(got.subRejected, true);
    assert.deepEqual(got.afterDispose, [{}, {}, {}, 0]);
  });

  test('L2 纯函数门：film-min s01 单帧、乱序、顺序重渲，CPU 渲的颜色层逐位相同', { skip: !BLENDER && '本机没有 Blender', timeout: 900000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'beiming-card-keys-'));
    const src = await startSource({ blenderBin: BLENDER, cards: DIRS, device: 'cpu' });
    try {
      assert.equal(src.device.backend, 'CPU');
      const { input, lock } = await filmMin(src.caps().version);
      const env = { lock, tier: 'draft', workspace: root, filmDir: BEIMING };
      const adapter = {
        async open() {
          const session = await src.open(input, env);
          return {
            async render(f) {
              const { meta, layers } = await session.render(f, { scale: 0.125 }, ['color', 'meta']);
              assert.equal(meta.camera.shutterAngleDeg, 180);
              return colorOf(root, layers.color);
            },
            close: () => session.close(),
          };
        },
      };
      const gate = await runPureFunctionGate(adapter, [0, 90, 179], { compare: 'hash', seed: 7802 });
      t.diagnostic(`纯函数门：${gate.ok ? '过' : '不过'}，乱序次序 ${gate.orders.shuffled.join('、')}`);
      assert.deepEqual([gate.ok, gate.bitExact, gate.mismatches], [true, true, []]);
    } finally {
      await src.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('快门运动模糊由这张卡驱动：关掉它开不开快门一样，开着它不一样', { skip: !BLENDER && '本机没有 Blender', timeout: 900000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'beiming-card-keys-'));
    const src = await startSource({ blenderBin: BLENDER, cards: DIRS, device: 'cpu' });
    try {
      const { input, lock } = await filmMin(src.caps().version);
      const frame = async (shot, angleDeg) => {
        const session = await src.open({ ...input, shot }, { lock, tier: 'final', workspace: root, filmDir: BEIMING });
        try {
          const { layers } = await session.render(90, { scale: 0.25, samples: 16, shutter: { angleDeg } }, ['color']);
          return colorOf(root, layers.color);
        } finally { await session.close(); }
      };
      // 透明度之差的总和：相机在动，开快门之后轮廓边上的像素透明度变了
      const alphaDiff = (a, b) => { let s = 0; for (let i = 3; i < a.length; i += 4) s += Math.abs(a[i] - b[i]); return s; };
      const withKeys = input.shot, withoutKeys = { ...input.shot, cards: input.shot.cards.filter((c) => c.use !== 'blender.state-keys@1') };
      assert.equal(alphaDiff(await frame(withoutKeys, 180), await frame(withoutKeys, 0)), 0);
      assert.ok(alphaDiff(await frame(withKeys, 180), await frame(withKeys, 0)) > 1);
    } finally {
      await src.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
