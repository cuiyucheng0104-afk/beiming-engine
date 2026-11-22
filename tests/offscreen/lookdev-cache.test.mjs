// WP5：lookdev 同帧快照跳过 scene 与 ink:ids，换帧失效；缓存结果与完整重渲逐字节相同；非白名单键 fail-closed 退回全量渲染；多时刻 sweep 仍命中缓存。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { createGpuTimer, attachGpuTimer, detachGpuTimer } from '../../engine/offscreen/gputimer.mjs';
import { LOOKDEV_CACHE_KEYS as LOOK_KEYS } from '../../engine/offscreen/tsl/look.js';
import { LOOKDEV_CACHE_KEYS as SWEEP_KEYS, canCacheLookdev } from '../../tools/lookdev/sweep.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/look-work.mjs`;
const SWEEP_CLI = path.join(ROOT, 'tools/lookdev/sweep.mjs');
const DEFAULTS = JSON.parse(readFileSync(`${ROOT}engine/style/beiming-original.v1.json`, 'utf8')).lookDefaults.params;
const W = 320, H = 180;

test('B3 白名单纯函数：look.js 与 sweep.mjs 共享同一组纯后期键，任意白名单外键 fail-closed', () => {
  assert.deepEqual([...SWEEP_KEYS].sort(), [...LOOK_KEYS].sort());
  for (const k of ['grade.exposure', 'fog.density', 'bloom.strength', 'kuwahara.radius', 'paper.strength', 'vignette', 'grain', 'outline.opacity']) {
    assert.equal(canCacheLookdev([{ kind: 'look', key: k, vals: [0, 1] }]), true, `${k} 应允许缓存`);
  }
  assert.equal(canCacheLookdev([{ kind: 'look', key: 'bg', vals: [0, 1] }]), false, '自定义键 bg 必须禁用缓存');
  assert.equal(canCacheLookdev([{ kind: 'look', key: 'grade.exposure', vals: [1, 1.5] }, { kind: 'look', key: 'bg', vals: [0, 1] }]), false, '混入白名单外键必须整次禁用');
  assert.equal(canCacheLookdev([{ kind: 'look', key: 'debug', vals: ['id', 'scene'] }]), false, 'debug 不在白名单内');
  assert.equal(canCacheLookdev([{ kind: 'look', key: 't', vals: [0, 1] }]), false, 't 不在白名单内');
  assert.equal(canCacheLookdev([{ kind: 'q', key: 'msaa', vals: ['0', '4'] }]), false, '仅有 --q 时无需跨格缓存');
  assert.equal(canCacheLookdev([{ kind: 'q', key: 'msaa', vals: ['0', '4'] }, { kind: 'look', key: 'grade.exposure', vals: [1, 1.5] }]), true, '--q 分组内纯后期键允许缓存');
});

test('lookdev 快照：重复帧 scene/ink:ids 为 0，输出逐字节等于完整重渲；换令牌或遇白名单外键立即重渲', { timeout: 120000 }, async t => {
  let host;
  try {
    const gpu = await loadGpu();
    globalThis.__LOOK = { defaults: DEFAULTS, p: { t: 0, grade: { exposure: 1.6 } }, ss: 1, msaa: 0 };
    host = await createHost({ gpu, width: W, height: H });
  } catch (e) {
    if (String(e.code).startsWith('env.')) return t.skip(`离屏出片不可用：${e.message}`);
    throw e;
  }
  const work = await host.load(FIXTURE);
  const draw = async (token, lookdev) => {
    globalThis.__OFFSCREEN_LOOKDEV_CACHE = token;
    globalThis.__LOOKDEV = lookdev;
    const timer = createGpuTimer(host.device);
    const marked = [], zeroed = [];
    const spy = {
      mark: l => { marked.push(l); timer.mark(l); },
      zero: l => { zeroed.push(l); timer.zero(l); },
    };
    attachGpuTimer(host.renderer, spy); timer.mark('pre');
    const pending = host.renderFrame(work, 0); timer.end();
    const px = Buffer.from(await pending);
    detachGpuTimer(host.renderer);
    const timing = await timer.read(); timer.dispose();
    return { px, marked, zeroed, spans: Object.fromEntries(timing.spans.map(s => [s.label, s.ms])) };
  };
  try {
    await draw(null, { grade: { exposure: 1.6 } });   // 预热与着色器编译
    const full = await draw(null, { grade: { exposure: 1.9 } });
    await draw(42, { grade: { exposure: 1.3 } });     // 建立快照
    const cached = await draw(42, { grade: { exposure: 1.9 } });
    assert.ok(cached.px.equals(full.px), '后期改参后的缓存帧与完整重渲逐字节相同');
    assert.equal(cached.spans.scene, 0, 'scene GPU 耗时为 0');
    assert.equal(cached.spans['ink:ids'], 0, 'ink:ids GPU 耗时为 0');
    assert.ok(cached.zeroed.includes('scene') && cached.zeroed.includes('ink:ids'), '缓存命中应记零跳过 scene 与 ink:ids');
    assert.ok(!cached.marked.includes('scene') && !cached.marked.includes('ink:ids'), '缓存命中不得再提交 scene 与 ink:ids');
    // 防御纵深：即便调用方强行带了相同令牌，__LOOKDEV 含白名单外键 bg 也必须 fail-closed 重渲
    const unsafe = await draw(42, { grade: { exposure: 1.9 }, bg: 1 });
    assert.ok(unsafe.marked.includes('scene') && unsafe.marked.includes('ink:ids'), '白名单外键必须强制重渲 scene 与 ink:ids');
    assert.ok(!unsafe.zeroed.includes('scene') && !unsafe.zeroed.includes('ink:ids'), '白名单外键不得跳过');
    const next = await draw(43, { grade: { exposure: 1.9 } });
    assert.ok(next.px.equals(full.px), '换帧后完整重渲仍逐字节相同');
    assert.ok(next.marked.includes('scene') && next.marked.includes('ink:ids'), '换令牌后 scene 与 ink:ids 必须重渲');
    assert.ok(!next.zeroed.includes('scene') && !next.zeroed.includes('ink:ids'), '换令牌后不得跳过');
  } finally {
    globalThis.__LOOK = undefined; globalThis.__LOOKDEV = null; globalThis.__OFFSCREEN_LOOKDEV_CACHE = null;
    detachGpuTimer(host.renderer); host.dispose();
  }
});

test('B3 + B1 + N1 端到端 sweep.mjs：白名单外 --look bg 禁用快照逐字节一致；白名单内 --t 0,0.04 --look outline.opacity=0,1 逐字节一致', { timeout: 180000 }, async t => {
  try {
    const gpu = await loadGpu();
    (await createHost({ gpu, width: 32, height: 32 })).dispose();
  } catch (e) {
    if (String(e.code).startsWith('env.')) return t.skip(`离屏出片不可用：${e.message}`);
    throw e;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-lookdev-b3-'));
  const filmDir = path.join(tmp, 'film');
  fs.mkdirSync(filmDir, { recursive: true });
  const toonUrl = new URL('../../engine/offscreen/tsl/toon.js', import.meta.url).href;
  const lookUrl = new URL('../../engine/offscreen/tsl/look.js', import.meta.url).href;
  const mergeUrl = new URL('../../engine/style/index.js', import.meta.url).href;
  fs.writeFileSync(path.join(filmDir, 'film.json'), JSON.stringify({ id: 'b3-test', backend: 'webgpu', output: { fps: 24 } }));
  fs.writeFileSync(path.join(filmDir, 'offscreen.mjs'), `
import { toonKind } from ${JSON.stringify(toonUrl)};
import { createLook } from ${JSON.stringify(lookUrl)};
import { mergeParams } from ${JSON.stringify(mergeUrl)};
export function build({ THREE, TSL, renderer, width: W, height: H, pipeline }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
  const kind = toonKind({ THREE, TSL }, { name: 'b3-mrt' }), mat = kind.make({ color: '#7D78B8' });
  const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), mat);
  kind.bind(box, mat, { outline: true }); scene.add(box);
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0 });
  const post = pipeline(look.output);
  return {
    render(f) {
      box.rotation.y = f * 0.35;
      const bg = globalThis.__LOOKDEV?.bg;
      scene.background = new THREE.Color(bg === 1 ? 0xc04020 : 0x203050);
      const base = { t: f / 24, outline: { opacity: 1 }, kuwahara: false, paper: false, bloom: false, vignette: 0, grain: 0 };
      look.render(scene, camera, globalThis.__LOOKDEV ? mergeParams(base, globalThis.__LOOKDEV) : base);
      post.render();
    },
    dispose() { look.dispose(); },
  };
}
`);

  const runSweep = (name, args) => {
    const outDir = path.join(tmp, name);
    const r = spawnSync(process.execPath, [SWEEP_CLI, filmDir, '--renderer', 'offscreen', '--size', '128x72', '--out', outDir, ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(r.status, 0, `sweep ${name} 失败：\n${r.stderr}\n${r.stdout}`);
    return outDir;
  };
  try {
    // 1) 白名单外键 --look bg=0,1：必须 fail-closed 重渲，组合与单独跑逐字节一致，且 cell0 !== cell1
    const bgBoth = runSweep('bg-both', ['--t', '0', '--look', 'bg=0,1']);
    const bg0 = runSweep('bg-0', ['--t', '0', '--look', 'bg=0']);
    const bg1 = runSweep('bg-1', ['--t', '0', '--look', 'bg=1']);
    const pBoth0 = readFileSync(path.join(bgBoth, 'cell-000-t0.png'));
    const pBoth1 = readFileSync(path.join(bgBoth, 'cell-001-t0.png'));
    assert.ok(!pBoth0.equals(pBoth1), 'bg=0 与 bg=1 画面必须不同（不得沿用旧快照）');
    assert.ok(pBoth0.equals(readFileSync(path.join(bg0, 'cell-000-t0.png'))), 'bg=0 与单独跑逐字节相同');
    assert.ok(pBoth1.equals(readFileSync(path.join(bg1, 'cell-000-t0.png'))), 'bg=1 与单独跑逐字节相同');

    // 2) 白名单内键 + 多时刻 --t 0,0.04 --look outline.opacity=0,1（覆盖 B1 切态、B3 outline 白名单与 N1 外层 times 遍历）
    const olBoth = runSweep('ol-both', ['--t', '0,0.04', '--look', 'outline.opacity=0,1']);
    for (const [ci, op] of [[0, 0], [1, 1]]) {
      for (const tv of ['0', '0.04']) {
        const solo = runSweep(`ol-${ci}-${tv}`, ['--t', tv, '--look', `outline.opacity=${op}`]);
        const got = readFileSync(path.join(olBoth, `cell-00${ci}-t${tv}.png`));
        const exp = readFileSync(path.join(solo, `cell-000-t${tv}.png`));
        assert.ok(got.equals(exp), `outline.opacity=${op} t=${tv} 组合扫参与单独跑逐字节相同`);
      }
    }
    assert.ok(
      !readFileSync(path.join(olBoth, 'cell-000-t0.png')).equals(readFileSync(path.join(olBoth, 'cell-001-t0.png'))),
      't=0 下 outline.opacity=1 必须实际绘出墨线（与 opacity=0 不同）',
    );
    assert.ok(
      !readFileSync(path.join(olBoth, 'cell-000-t0.04.png')).equals(readFileSync(path.join(olBoth, 'cell-001-t0.04.png'))),
      't=0.04 下 outline.opacity=1 必须实际绘出墨线（与 opacity=0 不同）',
    );
    // 验证 cells.json 与产物顺序契约未因外层 times 遍历而改变
    const meta = JSON.parse(readFileSync(path.join(olBoth, 'cells.json'), 'utf8'));
    assert.deepEqual(meta.cells.map(c => c.index), [0, 1]);
    assert.deepEqual(meta.cells[0].shots.map(s => s.t), [0, 0.04]);
    assert.deepEqual(meta.cells[1].shots.map(s => s.t), [0, 0.04]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
