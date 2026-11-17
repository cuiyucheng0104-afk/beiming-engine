// 离屏出片 M6 T4 单测：
// 1) tools/baseline/determinism.mjs 支持 --renderer offscreen 与纯 webgpu 作品自动选用（核对单帧新宿主/乱序/顺序流水线/同卡并发四路一致，坏作品 exit 4）；
// 2) tools/lookdev/sweep.mjs 支持 --renderer offscreen 与纯 webgpu 作品自动选用（扫 --look 与 --q 笛卡尔积网格，免浏览器）；
// 3) tools/env/doctor.mjs 输出 offscreen.deps 与 offscreen.gpu 体检项。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DET_CLI = path.join(ROOT, 'tools/baseline/determinism.mjs');
const SWEEP_CLI = path.join(ROOT, 'tools/lookdev/sweep.mjs');
const DOC_CLI = path.join(ROOT, 'tools/env/doctor.mjs');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let skipGpu = null;
try {
  await import('@napi-rs/canvas');
  const gpu = await loadGpu();
  const h = await createHost({ gpu, width: 32, height: 32, fps: 24 });
  h.dispose();
} catch (e) {
  skipGpu = e.message;
}

const noChromeEnv = { ...process.env, BEIMING_CHROME: '/nonexistent/no-browser' };

test('determinism.mjs：纯 webgpu 作品自动走离屏四路比对通过；故意累加上一帧状态的作品报 exit 4', { skip: skipGpu || false }, t => {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const goodDir = fs.mkdtempSync(path.join(ROOT, 'out/bm-det-good-'));
  const badDir = fs.mkdtempSync(path.join(ROOT, 'out/bm-det-bad-'));
  const repDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-det-rep-'));
  t.after(() => {
    fs.rmSync(goodDir, { recursive: true, force: true });
    fs.rmSync(badDir, { recursive: true, force: true });
    fs.rmSync(repDir, { recursive: true, force: true });
  });

  const inkUrl = pathToFileURL(path.join(ROOT, 'lab/offscreen/ink.mjs')).href;
  fs.writeFileSync(path.join(goodDir, 'offscreen.mjs'), `import { build as ink } from ${JSON.stringify(inkUrl)};\nexport const DUR = 1;\nexport function build(ctx) { return { dur: 1, ...ink(ctx) }; }\n`);
  fs.writeFileSync(path.join(goodDir, 'film.json'), JSON.stringify({
    schemaVersion: 2, id: 'det-good', title: '确定性合格', route: 'c', backend: 'webgpu',
    output: { profile: 'web-1080p24', width: 64, height: 36, fps: 24, frameCount: 24 },
    shots: [{ id: 'S1', in: 0, out: 12 }, { id: 'S2', in: 12, out: 24 }],
    events: [], aigc: { contains: false, note: 't' }, credits: [],
  }, null, 2));

  const rGood = spawnSync(process.execPath, [DET_CLI, goodDir, '--size', '64x36', '--seams', '--workers', '2', '--random', '2', '--no-scan', '--gpu', 'any', '--out', path.join(repDir, 'good'), '--json'], { cwd: ROOT, env: noChromeEnv, encoding: 'utf8' });
  assert.equal(rGood.status, 0, rGood.stderr);
  const jGood = JSON.parse(rGood.stdout);
  assert.equal(jGood.ok, true);
  assert.ok(jGood.data.frames >= 4);

  // 坏作品：用模块闭包计数器累加旋转，导致单帧新宿主（第 1 次调用）与顺序渲染（第 f+1 次调用）像素不同
  fs.writeFileSync(path.join(badDir, 'offscreen.mjs'), `
export const DUR = 0.5;
export function build({ THREE, width: W, height: H }) {
  let calls = 0;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 10);
  cam.position.set(0, 0, 3);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xdd6633 }));
  scene.add(mesh);
  return {
    dur: 0.5,
    render(_f) {
      calls++;
      mesh.rotation.y = calls * 0.35;
      scene.background = new THREE.Color(0x112233);
      arguments[0];
    },
  };
}
`);
  // 补上 renderer.render 调用
  fs.writeFileSync(path.join(badDir, 'offscreen.mjs'), `
export const DUR = 0.5;
export function build({ THREE, renderer, width: W, height: H }) {
  let calls = 0;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x112233);
  const cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 10);
  cam.position.set(0, 0, 3);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xdd6633 }));
  scene.add(mesh);
  return {
    dur: 0.5,
    render() {
      calls++;
      mesh.rotation.y = calls * 0.35;
      renderer.render(scene, cam);
    },
  };
}
`);
  fs.writeFileSync(path.join(badDir, 'film.json'), JSON.stringify({
    schemaVersion: 2, id: 'det-bad', title: '确定性违规', route: 'c', backend: 'webgpu',
    output: { profile: 'web-1080p24', width: 64, height: 36, fps: 24, frameCount: 12 },
    shots: [{ id: 'S1', in: 0, out: 12 }],
    events: [], aigc: { contains: false, note: 't' }, credits: [],
  }, null, 2));

  const rBad = spawnSync(process.execPath, [DET_CLI, badDir, '--size', '64x36', '--frames', '0,5', '--no-scan', '--gpu', 'any', '--out', path.join(repDir, 'bad'), '--json'], { cwd: ROOT, env: noChromeEnv, encoding: 'utf8' });
  assert.equal(rBad.status, 4, rBad.stderr);
  const jBad = JSON.parse(rBad.stdout);
  assert.equal(jBad.error.code, 'contract.nondeterministic');
  assert.ok(jBad.data.bad.includes(5));
});

test('lookdev/sweep.mjs：--renderer offscreen 在无浏览器环境下扫出不同参数格、拼出 grid.png 与对照页', { skip: !hasFfmpeg ? '没有 FFmpeg' : (skipGpu || false) }, t => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-sweep-off-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const r = spawnSync(process.execPath, [
    SWEEP_CLI, 'films/chendu', '--renderer', 'offscreen',
    '--t', '0.5', '--look', 'vignette=0,0.45', '--query', 'msaa=0&notext=1',
    '--size', '160x90', '--thumb', '160', '--out', outDir, '--json',
  ], { cwd: ROOT, env: noChromeEnv, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.data.cells, 2);
  const cells = JSON.parse(fs.readFileSync(path.join(outDir, 'cells.json'), 'utf8'));
  assert.notEqual(cells.cells[0].shots[0].sha256, cells.cells[1].shots[0].sha256, '不同 vignette 参数产出的 PNG 哈希应不同');
  assert.equal(fs.existsSync(path.join(outDir, 'grid.png')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'index.html')), true);
});

test('env/doctor.mjs：包含 offscreen.deps（以及非 --quick 下的 offscreen.gpu）检查项，字段合规', () => {
  const rQuick = spawnSync(process.execPath, [DOC_CLI, '--quick', '--json'], { cwd: ROOT, encoding: 'utf8' });
  const jq = JSON.parse(rQuick.stdout);
  const dep = jq.checks.find(c => c.id === 'offscreen.deps');
  assert.ok(dep, 'doctor --quick 应包含 offscreen.deps 检查项');
  assert.equal(dep.required, false);
  for (const k of ['id', 'ok', 'required', 'found', 'fix', 'status']) assert.ok(k in dep, `offscreen.deps 缺 ${k}`);
});
