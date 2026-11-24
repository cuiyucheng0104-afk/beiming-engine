// blender.cycles 的自测。本机有 Blender 时实跑，没有时跳过（只跑单元测试的 CI、Windows 机器）。
// 一、在后台 Blender 里直接调 create：渲染器是 Cycles（不是 EEVEE）、快门从帧起点打开、降噪器是 OIDN 并放在显卡上、
//     反弹次数和间接光钳制照参数写；别的东西把渲染器改成 EEVEE 之后 apply 报错，不照常出帧。
// 二、经 Blender 帧源出例子片子 film-min 的 s01：草稿档低采样加降噪，降噪跑在显卡后端上（元数据 source.denoise 是 oidn-gpu）；
//     终稿档的每像素采样数是镜头 tiers.final.samples，同样开启 OIDN 降噪。渲染产物在系统临时目录里，跑完删掉。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findBlender, loadAssets, loadCards, startSource } from '../../../sources/blender/host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEIMING = resolve(HERE, '../../..');
const BLENDER = findBlender();
const DIRS = ['cards/camera/spline', 'cards/mechanism/blender-cycles', 'cards/mechanism/blender-state-keys'];

// 在后台 Blender 里装这张卡、调 create 和 apply，把场景设置打印成一行 JSON。不写字节码缓存：卡目录里多出文件会改掉卡的内容哈希
const PROBE = `
import sys
sys.dont_write_bytecode = True
import importlib.util, json, types
import bpy
path = sys.argv[sys.argv.index('--') + 1]
spec = importlib.util.spec_from_file_location('card_under_test', path)
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.motion_blur_position = 'CENTER'
handle = card.create(types.SimpleNamespace(hostScene=scene, bpy=bpy), {'bounces': 5, 'clampIndirect': 3.5})
r, c = scene.render, scene.cycles
out = {'members': sorted(handle), 'engine': r.engine, 'position': r.motion_blur_position, 'device': c.device, 'denoiser': c.denoiser,
       'denoiseOnGpu': c.denoising_use_gpu, 'bounces': c.max_bounces, 'clampIndirect': c.sample_clamp_indirect}
handle['apply'](0, 0.0)
r.engine = 'BLENDER_EEVEE'
try:
    handle['apply'](1, 0.0)
    out['eeveeRejected'] = False
except RuntimeError:
    out['eeveeRejected'] = True
handle['dispose']()
print('RESULT ' + json.dumps(out))
`;

/** 在后台 Blender 里跑一段 Python，交回它打印的 RESULT 那一行 */
async function inBlender(script, ...args) {
  const dir = await mkdtemp(join(tmpdir(), 'beiming-card-cycles-'));
  try {
    await writeFile(join(dir, 'probe.py'), script);
    const run = spawnSync(BLENDER, ['-b', '-noaudio', '--factory-startup', '--python', join(dir, 'probe.py'), '--', ...args], { encoding: 'utf8', timeout: 120000 });
    const line = run.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `Blender 没打印结果：${run.stderr.slice(-2000)}`);
    return JSON.parse(line.slice('RESULT '.length));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('blender.cycles 实跑', { concurrency: false }, () => {
  test('create：Cycles、帧起点快门、显卡上的 OIDN、参数照写；改成 EEVEE 后 apply 报错', { skip: !BLENDER && '本机没有 Blender', timeout: 180000 }, async () => {
    const got = await inBlender(PROBE, join(HERE, 'cycles.py'));
    assert.deepEqual(got, {
      members: ['apply', 'dispose'], engine: 'CYCLES', position: 'START', device: 'GPU', denoiser: 'OPENIMAGEDENOISE',
      denoiseOnGpu: true, bounces: 5, clampIndirect: 3.5, eeveeRejected: true,
    });
  });

  test('经帧源出帧：草稿档与终稿档降噪均跑在显卡上，终稿档取 tiers.final.samples', { skip: !BLENDER && '本机没有 Blender', timeout: 600000 }, async (t) => {
    const film = JSON.parse(await readFile(join(BEIMING, 'kernel/contracts/examples/film-min/film.json'), 'utf8'));
    const shot = film.shots.find((s) => s.id === 's01');
    const lib = await loadCards(DIRS), assets = await loadAssets();
    const root = await mkdtemp(join(tmpdir(), 'beiming-card-cycles-'));
    const src = await startSource({ blenderBin: BLENDER, cards: DIRS });
    try {
      const lock = {
        film: film.id, seeds: { s01: shot.seed }, shots: { s01: { shutterSamples: 1 } },
        sources: { blender: { version: src.caps().version, host: 'cycles' } },
        cards: Object.fromEntries(Object.entries(lib).map(([name, { card, sha256 }]) => [name, { version: card.version, impl: [...card.livesIn], sha256 }])),
        assets: { 'asset:rtx-card@1': assets['asset:rtx-card@1'].sha256 },
      };
      const input = { film: film.id, output: { size: film.output.size, fps: film.output.fps }, shot, tokens: film.style.tokens };
      const render = async (tier, scale) => {
        const session = await src.open(input, { lock, tier, workspace: join(root, tier), filmDir: BEIMING });
        try { return (await session.render(0, { scale }, ['color', 'meta'])).meta; } finally { await session.close(); }
      };
      const draft = await render('draft', 0.25);
      assert.equal(draft.source.samples, shot.tiers.draft.samples);
      if (src.device.backend === 'CPU') { t.skip('本机 Blender 没有可用的显卡后端，验不了降噪跑在显卡上'); return; }
      t.diagnostic(`后端 ${src.device.backend}（${src.device.gpu}），草稿档降噪 ${draft.source.denoise}`);
      assert.deepEqual([draft.source.backend, draft.source.denoise], [src.device.backend, 'oidn-gpu']);
      const final = await render('final', 0.125);
      assert.equal(final.source.samples, shot.tiers.final.samples);
      assert.deepEqual([final.source.backend, final.source.denoise], [src.device.backend, 'oidn-gpu']);
    } finally {
      await src.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
