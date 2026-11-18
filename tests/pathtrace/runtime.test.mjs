// 北冥引擎 · D 路线（北冥光追，决定 D13）运行时、视锥投影、打包探针与真机 1 帧冒烟测试
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { runCli, sha256 } from '../../tools/lib/cli.mjs';
import {
  LOCK_PATH,
  command as runtimeCommand,
  detectPlatform,
  loadLock,
  probePathtraceGpu,
  resolvePathtrace,
} from '../../engine/pathtrace/runtime.mjs';
import {
  bundlePathtraceFilm,
  command as bundleCommand,
} from '../../engine/pathtrace/bundle.mjs';
import {
  MAX_WAFER_THICKNESS_M,
  createWaferHudMaterial,
  definePathtraceFilm,
  enforceWaferThickness,
  frameSeed,
  placeInCameraFrustum,
  projectBoxToPixels,
} from '../../engine/pathtrace/index.js';

function captureIo(env = {}) {
  let out = '';
  let err = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) { out += chunk.toString(); cb(); },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) { err += chunk.toString(); cb(); },
  });
  return {
    stdout,
    stderr,
    env,
    signals: false,
    setExitCode: false,
    readOut: () => out,
    readErr: () => err,
  };
}

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

function writeMockSdk(sdkDir) {
  const sceneDir = path.join(sdkDir, 'packages', 'scene', 'src');
  const gameplayDir = path.join(sdkDir, 'packages', 'gameplay', 'src');
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.mkdirSync(gameplayDir, { recursive: true });

  fs.writeFileSync(
    path.join(sceneDir, 'index.ts'),
    [
      'export class Color { r = 0; g = 0; b = 0; constructor(v: number = 0) { this.r = v; } }',
      'export class Scene { children: unknown[] = []; background: unknown = null; add(...xs: unknown[]) { this.children.push(...xs); return this; } }',
      'export class PerspectiveCamera {',
      '  fov: number; aspect: number; near: number; far: number;',
      '  position = { x: 0, y: 0, z: 5, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } };',
      '  up = { x: 0, y: 1, z: 0 };',
      '  target = { x: 0, y: 0, z: 0 };',
      '  constructor(fov = 45, aspect = 16 / 9, near = 0.05, far = 200) {',
      '    this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;',
      '  }',
      '  lookAt(x: number, y: number, z: number) { this.target = { x, y, z }; return this; }',
      '}',
      'export class PlaneGeometry { w: number; h: number; constructor(w = 1, h = 1) { this.w = w; this.h = h; } }',
      'export class Mesh {',
      '  geometry: unknown; material: unknown; visible = true; movable = false;',
      '  position = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } };',
      '  quaternion = { x: 0, y: 0, z: 0, w: 1, set(x: number, y: number, z: number, w: number) { this.x = x; this.y = y; this.z = z; this.w = w; } };',
      '  scale = { x: 1, y: 1, z: 1, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } };',
      '  constructor(geometry: unknown, material: unknown) { this.geometry = geometry; this.material = material; }',
      '}',
      'export class Texture { uri: string; constructor(uri: string) { this.uri = uri; } }',
    ].join('\n') + '\n',
  );

  fs.writeFileSync(
    path.join(gameplayDir, 'index.ts'),
    [
      'export function defineGame<T>(g: T): T { return g; }',
      'export function installNodeHost(g: unknown): unknown {',
      '  (globalThis as Record<string, unknown>).__threert = g;',
      '  return g;',
      '}',
    ].join('\n') + '\n',
  );
}

test('loadLock 读取并校验 runtime.lock.json 结构', async () => {
  const lock = loadLock();
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.license, 'MIT');
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  assert.ok(lock.platforms['linux-x64']);
  assert.match(lock.platforms['linux-x64'].binarySha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof lock.platforms['linux-x64'].oidn, 'boolean');
  assert.equal(path.basename(LOCK_PATH), 'runtime.lock.json');

  await withTempDir('bm-pt-lock-', async dir => {
    const badPath = path.join(dir, 'bad.lock.json');
    fs.writeFileSync(badPath, JSON.stringify({ schemaVersion: 1, version: '0.1.0', commit: 'short', platforms: {} }));
    assert.throws(
      () => loadLock(badPath),
      err => err.exitCode === 4 && String(err.code).startsWith('contract.'),
    );
  });
});

test('resolvePathtrace 与 probePathtraceGpu 处理缺失、哈希不匹配（退出码 3）、有效缓存与跨平台设备探测', async () => {
  await withTempDir('bm-pt-rt-', async dir => {
    const plat = detectPlatform();
    const binContent = Buffer.from('mock-pathtrace-binary-v1\n', 'utf8');
    const goodHash = sha256(binContent);
    const mockLock = {
      schemaVersion: 1,
      upstream: 'ThreeRT (meshy-dev/ThreeRT)',
      commit: 'c946cc96bdb08979224e851a7fc67a066b1b456b',
      version: '0.1.1-test',
      license: 'MIT',
      platforms: {
        [plat]: {
          binary: 'bin/threert-render',
          binarySha256: goodHash,
          oidn: false,
        },
      },
    };

    // 1. 缺失可执行文件 -> 退出码 3
    await assert.rejects(
      () => resolvePathtrace({ env: { HOME: dir, USERPROFILE: dir }, cwd: dir, lock: mockLock, platform: plat }),
      err => err.exitCode === 3 && err.code === 'env.pathtrace-missing',
    );

    // 2. 放入篡改内容 -> 哈希不匹配退出码 3
    const cacheRoot = path.join(dir, '.cache', 'beiming', 'pathtrace', mockLock.version);
    const binPath = path.join(cacheRoot, 'bin', 'threert-render');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, 'corrupted-binary');

    await assert.rejects(
      () => resolvePathtrace({ env: { HOME: dir, USERPROFILE: dir }, cwd: dir, lock: mockLock, platform: plat }),
      err => err.exitCode === 3 && err.code === 'env.pathtrace-hash-mismatch',
    );

    // 3. 写入匹配哈希的二进制 -> verified = true
    fs.writeFileSync(binPath, binContent);
    const resolved = await resolvePathtrace({
      env: { HOME: dir, USERPROFILE: dir },
      cwd: dir,
      lock: mockLock,
      platform: plat,
    });
    assert.equal(resolved.exe, binPath);
    assert.equal(resolved.homeDir, cacheRoot);
    assert.equal(resolved.presetsDir, path.join(cacheRoot, 'presets'));
    assert.equal(resolved.sdkDir, path.join(cacheRoot, 'sdk'));
    assert.equal(resolved.binarySha256, goodHash);
    assert.equal(resolved.verified, true);
    assert.equal(resolved.oidn, false);

    // 4. 跨平台设备探测（用当前 node 原生可执行文件 + --import 预加载钩子，Linux / macOS / Windows 均不经 sh 或 .cmd）
    const hookPath = path.join(dir, 'gpu-info-hook.mjs');
    fs.writeFileSync(
      hookPath,
      'import path from "node:path";\n'
      + 'if (process.argv[1] && path.basename(process.argv[1]) === "info") {\n'
      + '  process.stdout.write(JSON.stringify({ adapter: "MockGPU", backend: "Vulkan", hwrt: true }) + "\\n");\n'
      + '  process.exit(0);\n'
      + '}\n',
    );
    const mockNodeOpts = [process.env.NODE_OPTIONS, `--import ${pathToFileURL(hookPath).href}`].filter(Boolean).join(' ');
    const probed = probePathtraceGpu(process.execPath, { env: { ...process.env, NODE_OPTIONS: mockNodeOpts } });
    assert.equal(probed.ok, true);
    assert.equal(probed.adapter, 'MockGPU');
    assert.equal(probed.hwrt, true);
  });
});

test('runtime.mjs 与 bundle.mjs 满足 CLI --help 无副作用与 --json 信封规范', async () => {
  const helpIo = captureIo();
  const helpCode = await runCli(runtimeCommand, ['--help'], helpIo);
  assert.equal(helpCode, 0);
  assert.match(helpIo.readOut(), /pathtrace-runtime/);
  assert.equal(helpIo.readErr(), '');

  const bundleHelpIo = captureIo();
  const bundleHelpCode = await runCli(bundleCommand, ['--help'], bundleHelpIo);
  assert.equal(bundleHelpCode, 0);
  assert.match(bundleHelpIo.readOut(), /pathtrace-bundle/);

  const badOptIo = captureIo();
  const badCode = await runCli(runtimeCommand, ['--unknown-flag', '--json'], badOptIo);
  assert.equal(badCode, 2);
  const badEnv = JSON.parse(badOptIo.readOut());
  assert.equal(badEnv.schemaVersion, 1);
  assert.equal(badEnv.ok, false);
  assert.equal(badEnv.exitCode, 2);
  assert.equal(badEnv.error.code, 'usage.unknown-option');

  await withTempDir('bm-pt-cli-', async dir => {
    const plat = detectPlatform();
    const binBuf = Buffer.from('mock-pt-exe', 'utf8');
    const lockFile = path.join(dir, 'lock.json');
    const cacheHome = path.join(dir, '.cache', 'beiming', 'pathtrace', '0.1.1-mock');
    const exePath = path.join(cacheHome, 'bin', 'threert-render');
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, binBuf);
    fs.writeFileSync(lockFile, JSON.stringify({
      schemaVersion: 1,
      upstream: 'ThreeRT (meshy-dev/ThreeRT)',
      commit: 'c946cc96bdb08979224e851a7fc67a066b1b456b',
      version: '0.1.1-mock',
      license: 'MIT',
      platforms: {
        [plat]: { binary: 'bin/threert-render', binarySha256: sha256(binBuf), oidn: false },
      },
    }));

    // status --json 在缺少 presets/sdk 时仍返回运行时哈希状态（ok: true）
    const statusIo = captureIo({ HOME: dir, USERPROFILE: dir });
    const stCode = await runCli(runtimeCommand, ['status', '--lock', lockFile, '--json'], statusIo);
    assert.equal(stCode, 0);
    const stJson = JSON.parse(statusIo.readOut());
    assert.equal(stJson.ok, true);
    assert.equal(stJson.data.verified, true);
    assert.equal(stJson.data.presetsReady, false);

    // check --json 在缺少 presets/sdk 时退出 3
    const chkFailIo = captureIo({ HOME: dir, USERPROFILE: dir });
    const chkFailCode = await runCli(runtimeCommand, ['check', '--lock', lockFile, '--json'], chkFailIo);
    assert.equal(chkFailCode, 3);
    const chkFailJson = JSON.parse(chkFailIo.readOut());
    assert.equal(chkFailJson.error.code, 'env.pathtrace-incomplete');

    // 补齐 presets 与 sdk 后 check --json 退出 0
    fs.mkdirSync(path.join(cacheHome, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(cacheHome, 'presets', 'cinematic.json'), '{}');
    fs.writeFileSync(path.join(cacheHome, 'presets', 'preview.json'), '{}');
    writeMockSdk(path.join(cacheHome, 'sdk'));

    const chkOkIo = captureIo({ HOME: dir, USERPROFILE: dir });
    const chkOkCode = await runCli(runtimeCommand, ['check', '--lock', lockFile, '--json'], chkOkIo);
    assert.equal(chkOkCode, 0);
    const chkOkJson = JSON.parse(chkOkIo.readOut());
    assert.equal(chkOkJson.ok, true);
    assert.equal(chkOkJson.data.presetsReady, true);
    assert.equal(chkOkJson.data.sdkReady, true);
  });
});

test('placeInCameraFrustum、projectBoxToPixels、createWaferHudMaterial 与 frameSeed 精度及防冲灰契约', () => {
  const s0 = frameSeed(2026, 0);
  const s0Again = frameSeed(2026, 0);
  const s1 = frameSeed(2026, 1);
  assert.equal(s0, s0Again);
  assert.notEqual(s0, s1);
  assert.ok(Number.isInteger(s0) && s0 >= 0 && s0 <= 0xffffffff);

  const camera = {
    fov: 42,
    near: 0.05,
    position: { x: -0.6, y: 0.35, z: 5.2 },
    up: { x: 0, y: 1, z: 0 },
    target: { x: 0.1, y: 0.05, z: 0 },
  };
  const mesh = {
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };

  const targetBox = [144, 88, 460, 108];
  const placed = placeInCameraFrustum(mesh, camera, 1.2, targetBox, 1920, 1080);
  assert.ok(placed.scale[2] <= MAX_WAFER_THICKNESS_M);
  assert.ok(mesh.scale.z <= MAX_WAFER_THICKNESS_M);

  const roundTrip = projectBoxToPixels(mesh, camera, 1920, 1080);
  assert.ok(roundTrip);
  for (let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(roundTrip[i] - targetBox[i]) < 1e-3,
      `第 ${i} 维像素误差过大：期望 ${targetBox[i]}，实际 ${roundTrip[i]}`,
    );
  }

  // 摄影机后方的包围盒返回 null
  const behind = projectBoxToPixels({ min: [-1, -1, 12], max: [1, 1, 14] }, camera, 1920, 1080);
  assert.equal(behind, null);

  // 防冲灰 HUD 材质注入 o.base = vec3<f32>(0.0); o.specular = 0.0; 且强制薄晶片约束
  const hudMat = createWaferHudMaterial({ uri: 'hud.png' }, { boost: 40 });
  assert.equal(hudMat.emissiveIntensity, 40);
  assert.equal(hudMat.maxThickness, MAX_WAFER_THICKNESS_M);
  assert.match(hudMat.shader.fn.code, /o\.base\s*=\s*vec3(?:<f32>)?\(0\.0\)\s*;/);
  assert.match(hudMat.shader.fn.code, /o\.specular\s*=\s*0\.0\s*;/);

  const thickMesh = { scale: { x: 2, y: 1, z: 0.5 } };
  enforceWaferThickness(thickMesh);
  assert.equal(thickMesh.scale.z, MAX_WAFER_THICKNESS_M);

  // definePathtraceFilm 纯帧号探针契约
  const def = definePathtraceFilm(({ width, height }) => ({
    scene: {},
    camera,
    renderFrame(_f, ctx) {
      assert.equal(ctx.width, width);
      assert.equal(ctx.height, height);
    },
    textsAt(f) {
      return f < 4 ? [{ id: 'title', text: '北冥光追', box: [120, 80, 300, 64], alpha: 1, font: '600 42px "Noto Sans SC"' }] : [];
    },
  }));
  assert.equal(def.evaluation, 'absolute');
  const probed = def.probeFilm({
    film: {
      schemaVersion: 2,
      output: { width: 1920, height: 1080, fps: 24, frameCount: 8 },
      shots: [{ id: 'S01', in: 0, out: 8 }],
    },
  });
  assert.equal(probed.frames.length, 8);
  assert.equal(probed.summary.length, 1);
  assert.equal(probed.summary[0].frameCount, 4);
});

test('bundlePathtraceFilm 使用隔离模拟 SDK 打包 scene.ts（同时兼容 index.js 与 index.ts 导入）并导出 events / timeline / texts.json', async () => {
  await withTempDir('bm-pt-bundle-', async dir => {
    const sdkDir = path.join(dir, 'sdk');
    writeMockSdk(sdkDir);

    for (const ext of ['index.js', 'index.ts']) {
      const filmDir = path.join(dir, `film-${ext.replace('.', '-')}`);
      fs.mkdirSync(filmDir, { recursive: true });
      const engineIndexRel = path.relative(filmDir, path.resolve(LOCK_PATH, '..', ext)).split(path.sep).join('/');

      const filmJson = {
        schemaVersion: 2,
        id: 'unit-pt',
        title: '光追单元测例',
        route: 'd',
        backend: 'pathtrace',
        entry: 'scene.ts',
        output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 12 },
        shots: [
          { id: 'S01', in: 0, out: 6 },
          { id: 'S02', in: 6, out: 12 },
        ],
        events: [
          { id: 'hit.open', frame: 0, shot: 'S01', audio: 'sub' },
          { id: 'hit.cut', frame: 6, shot: 'S02', audio: 'impact' },
        ],
        pathtrace: { preset: 'cinematic', spp: 16, animaticSpp: 4, denoise: 'auto', seed: 2026 },
      };
      fs.writeFileSync(path.join(filmDir, 'film.json'), JSON.stringify(filmJson, null, 2));

      const sceneTs = [
        'import { Mesh, PerspectiveCamera, PlaneGeometry, Scene, Texture } from "@threert/scene";',
        `import { createWaferHudMaterial, definePathtraceFilm, frameSeed, placeInCameraFrustum, projectBoxToPixels } from ${JSON.stringify(engineIndexRel)};`,
        '',
        'export default definePathtraceFilm(({ width, height }) => {',
        '  const scene = new Scene();',
        '  const camera = new PerspectiveCamera(42, width / height, 0.05, 100);',
        '  camera.position.set(0, 0, 5);',
        '  camera.lookAt(0, 0, 0);',
        '  const hudMat = createWaferHudMaterial(new Texture("hud.png"), { boost: 30 });',
        '  const card = new Mesh(new PlaneGeometry(1, 1), hudMat);',
        '  scene.add(card);',
        '  return {',
        '    scene,',
        '    camera,',
        '    renderFrame(frame, ctx) {',
        '      const jitter = (frameSeed(ctx.seed, frame) % 5) * 0.0001;',
        '      card.visible = !ctx.hideTexts;',
        '      placeInCameraFrustum(card, camera, 1.0 + jitter, [160, 96, 360, 72], width, height);',
        '    },',
        '    textsAt(frame, ctx) {',
        '      const box = projectBoxToPixels(card, camera, width, height);',
        '      if (!box || frame < 2) return [];',
        '      return [{ id: "hud.main", text: `SHOT-${ctx.shot}`, box, alpha: 1, font: "600 32px \\"Barlow Condensed\\"" }];',
        '    },',
        '  };',
        '});',
      ].join('\n');
      fs.writeFileSync(path.join(filmDir, 'scene.ts'), sceneTs);

      const outDir = path.join(dir, `run-out-${ext.replace('.', '-')}`);
      const res = await bundlePathtraceFilm({ filmDir, sdkDir, probeOut: outDir });
      assert.ok(fs.existsSync(res.bundlePath), ext);
      assert.ok(fs.existsSync(res.eventsPath), ext);
      assert.ok(fs.existsSync(res.timelinePath), ext);
      assert.ok(fs.existsSync(res.textsPath), ext);

      const ev = JSON.parse(fs.readFileSync(res.eventsPath, 'utf8'));
      assert.equal(ev.dur, 0.5);
      assert.equal(ev.ev.length, 2);

      const tl = JSON.parse(fs.readFileSync(res.timelinePath, 'utf8'));
      assert.equal(tl.frameCount, 12);
      assert.equal(tl.shots.length, 2);

      const texts = JSON.parse(fs.readFileSync(res.textsPath, 'utf8'));
      assert.equal(texts.frames.length, 12);
      assert.equal(texts.frames[0].items.length, 0);
      assert.equal(texts.frames[3].items.length, 1);
      assert.equal(texts.frames[3].items[0].text, 'SHOT-S01');
      assert.equal(texts.frames[8].items[0].text, 'SHOT-S02');
      assert.equal(texts.summary.length, 2);
      assert.ok(Math.abs(texts.frames[3].items[0].box[0] - 160) < 0.5);
    }
  });
});

test('真机 GPU 1 帧冒烟（当本地缓存运行时与 GPU 可用时执行，产物写临时目录并自动清理）', async t => {
  let rt;
  try {
    rt = await resolvePathtrace();
  } catch {
    t.skip('本地未安装光追运行时缓存，跳过真机 1 帧冒烟');
    return;
  }
  if (!fs.existsSync(path.join(rt.presetsDir, 'preview.json')) || !fs.existsSync(path.join(rt.sdkDir, 'packages', 'scene'))) {
    t.skip('本地光追缓存缺少 presets 或 sdk，跳过真机 1 帧冒烟');
    return;
  }
  const gpu = probePathtraceGpu(rt.exe);
  if (!gpu.ok) {
    t.skip(`当前环境无可用 Vulkan/Metal/DX12 光追设备（${gpu.error}），跳过真机 1 帧冒烟`);
    return;
  }

  let cleanedDir = '';
  await withTempDir('bm-pt-gpu-smoke-', async dir => {
    cleanedDir = dir;
    const filmDir = path.join(dir, 'smoke-film');
    fs.mkdirSync(filmDir, { recursive: true });
    const engineIndexRel = path.relative(filmDir, path.resolve(LOCK_PATH, '..', 'index.js')).split(path.sep).join('/');

    fs.writeFileSync(path.join(filmDir, 'film.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'gpu-smoke',
      title: '光追单帧冒烟',
      route: 'd',
      backend: 'pathtrace',
      entry: 'scene.ts',
      output: { profile: 'web-1080p24', width: 320, height: 180, fps: 24, frameCount: 2 },
      shots: [{ id: 'S01', in: 0, out: 2 }],
      events: [],
      pathtrace: { preset: 'preview', spp: 2, animaticSpp: 2, denoise: 'auto', seed: 2026 },
    }, null, 2));

    fs.writeFileSync(path.join(filmDir, 'scene.ts'), [
      'import { BoxGeometry, Color, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, RectAreaLight, Scene } from "@threert/scene";',
      `import { definePathtraceFilm } from ${JSON.stringify(engineIndexRel)};`,
      '',
      'export default definePathtraceFilm(({ width, height }) => {',
      '  const scene = new Scene();',
      '  scene.background = new Color(0x0a0e17);',
      '  const floor = new Mesh(new PlaneGeometry(12, 12), new MeshStandardMaterial({ color: 0x1e2636, roughness: 0.2, metalness: 0.85 }));',
      '  floor.rotation.x = -Math.PI * 0.5;',
      '  floor.position.set(0, -0.8, 0);',
      '  scene.add(floor);',
      '  const monolith = new Mesh(new BoxGeometry(1.1, 1.4, 0.5), new MeshStandardMaterial({ color: 0xd8e6f5, roughness: 0.18, metalness: 0.92 }));',
      '  monolith.movable = true;',
      '  scene.add(monolith);',
      '  const key = new RectAreaLight(new Color(0xf0f6ff), 120, 4.0, 2.5);',
      '  key.position.set(1.8, 2.2, 3.4);',
      '  key.lookAt(0, 0, 0);',
      '  scene.add(key);',
      '  const camera = new PerspectiveCamera(42, width / height, 0.05, 80);',
      '  camera.position.set(0, 0.25, 4.2);',
      '  camera.lookAt(0, 0, 0);',
      '  camera.setManualExposure(4.5);',
      '  scene.add(camera);',
      '  return {',
      '    scene,',
      '    camera,',
      '    renderFrame(frame) {',
      '      monolith.rotation.y = 0.35 + frame * 0.1;',
      '    },',
      '  };',
      '});',
    ].join('\n'));

    const bundled = await bundlePathtraceFilm({ filmDir, sdkDir: rt.sdkDir, probeOut: path.join(dir, 'out') });
    const outPng = path.join(dir, 'frame_000000.png');
    const jobLine = JSON.stringify({
      id: 1,
      game: bundled.bundlePath,
      assets: filmDir,
      room: 'gpu-smoke',
      seed: 2026,
      state: { frame: 0 },
      seq: 1,
      time: 0,
      spp: 2,
      preset: 'preview',
      width: 320,
      height: 180,
      out: outPng,
    }) + '\n';

    const proc = spawnSync(rt.exe, ['serve', '--presets', rt.presetsDir], {
      input: jobLine,
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(proc.status, 0, `threert-render serve 退出异常：${proc.stderr || proc.stdout}`);
    const lines = proc.stdout.trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    const jobRes = lines.find(x => x.id === 1);
    assert.ok(jobRes?.ok, `单帧光追作业失败：${JSON.stringify(jobRes)}`);

    const pngBuf = fs.readFileSync(outPng);
    assert.deepEqual([...pngBuf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(pngBuf.readUInt32BE(16), 320);
    assert.equal(pngBuf.readUInt32BE(20), 180);
    assert.ok(pngBuf.length > 512);
  });

  assert.equal(fs.existsSync(cleanedDir), false, '临时渲染目录应已彻底清理');
});
