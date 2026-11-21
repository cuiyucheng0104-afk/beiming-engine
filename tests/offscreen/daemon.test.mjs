// 离屏出片 · WP1.2 常驻渲染守护进程（engine/offscreen/daemon.mjs 与 cli.mjs --daemon 接入）：
// 协议、IPC 权限与崩溃恢复、LRU 与热重载、device.lost 自愈、以及与冷启动逐字节一致的真 GPU 回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from '../../engine/render/lib/ffmpeg.mjs';
import {
  defaultSocketPath,
  resolveDaemonTarget,
  computeWorkSignature,
  createDaemonServer,
  sendDaemonRequest,
} from '../../engine/offscreen/daemon.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'engine/offscreen/cli.mjs');
const WORK = 'lab/offscreen/ink.mjs';
const runCliSync = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180000, ...opts });
const tmp = () => mkdtempSync(join(tmpdir(), 'beiming-daemon-test-'));
const IS_WIN = process.platform === 'win32';
// Windows 只能用命名管道（文件路径 listen 会 EACCES）；类 Unix 用临时目录里的 socket 文件
const ipcPath = (dir, name) => (IS_WIN ? `\\\\.\\pipe\\beiming-test-${process.pid}-${dir.slice(-6)}-${name}` : join(dir, `${name}.sock`));

// ───────────────────────── 纯逻辑与协议单测（无需 GPU） ─────────────────────────

test('defaultSocketPath：按平台选择 Unix Domain Socket 或 Named Pipe，尊重 BEIMING_OFFSCREEN_SOCKET', () => {
  assert.equal(defaultSocketPath({ env: { BEIMING_OFFSCREEN_SOCKET: '/custom/a.sock' }, platform: 'linux' }), '/custom/a.sock');
  assert.equal(defaultSocketPath({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, platform: 'linux' }), '/run/user/1000/beiming-offscreen.sock');
  const win = defaultSocketPath({ env: {}, platform: 'win32', root: 'repo-root-placeholder' });
  assert.match(win, /^\\\\\.\\pipe\\beiming-offscreen-[0-9a-f]{8}$/);
  assert.ok(!/:\d+$/.test(win), '不监听 TCP 端口');
});

test('resolveDaemonTarget：默认 off；支持 CLI 参数与 BEIMING_OFFSCREEN_DAEMON，CLI 优先', () => {
  const defSock = defaultSocketPath({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, platform: 'linux' });
  const opt = { env: { XDG_RUNTIME_DIR: '/run/user/1000' }, platform: 'linux' };
  assert.deepEqual(resolveDaemonTarget(undefined, opt), { mode: 'off', socket: null });
  assert.deepEqual(resolveDaemonTarget('off', { ...opt, env: { ...opt.env, BEIMING_OFFSCREEN_DAEMON: '1' } }), { mode: 'off', socket: null });
  assert.deepEqual(resolveDaemonTarget(undefined, { ...opt, env: { ...opt.env, BEIMING_OFFSCREEN_DAEMON: '1' } }), { mode: 'auto', socket: defSock });
  assert.deepEqual(resolveDaemonTarget('auto', opt), { mode: 'auto', socket: defSock });
  assert.deepEqual(resolveDaemonTarget('on', opt), { mode: 'required', socket: defSock });
  assert.deepEqual(resolveDaemonTarget('/tmp/custom.sock', opt), { mode: 'required', socket: '/tmp/custom.sock' });
});

test('computeWorkSignature：文件不变时签名稳定，改动内容或 mtime 后立即变化', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'work.mjs');
    writeFileSync(f, 'export function build(){ return { render(){} }; }\n');
    const s1 = computeWorkSignature(f);
    const s2 = computeWorkSignature(f);
    assert.equal(s1, s2);
    writeFileSync(f, 'export function build(){ return { render(){ /* changed */ } }; }\n');
    const s3 = computeWorkSignature(f);
    assert.notEqual(s3, s1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('IPC 权限 0600、陈旧 socket 崩溃恢复、重复启动报 busy.daemon、空闲超时优雅退出', { timeout: 30000 }, async () => {
  const dir = tmp();
  const sock = ipcPath(dir, 'd');
  try {
    // 1. 制造一个上次崩溃残留的死 socket 文件（命名管道没有文件残留，Windows 跳过这一步）
    if (!IS_WIN) await new Promise((resolve, reject) => {
      const dead = net.createServer();
      dead.once('error', reject);
      dead.listen(sock, () => {
        // 强关 socket 但保留路径，模拟进程被 SIGKILL 后的残留文件
        dead.close(() => {
          writeFileSync(sock, '');
          resolve();
        });
      });
    });
    if (!IS_WIN) assert.equal(existsSync(sock), true);

    // 2. 启动 daemon：应自动清理陈旧残留并监听，权限 0600
    const mockRuntime = {
      adapter: { vendor: 'mock', architecture: null, description: 'mock-gpu' },
      software: false,
      deviceResets: 0,
      async execute(method) {
        if (method === 'probe') return { data: { ok: true }, outputs: [], warnings: [] };
        throw new Error(`unexpected ${method}`);
      },
      stats() { return { cachedWorks: 0, maxCachedWorks: 4, cacheHits: 0, cacheMisses: 0, deviceResets: 0 }; },
      dispose() {},
    };
    const srv = await createDaemonServer({ socketPath: sock, idleTimeoutSec: 0, runtime: mockRuntime });
    try {
      if (!IS_WIN) {
        assert.equal(statSync(sock).mode & 0o777, 0o600, 'Unix socket 权限必须严格为 0600');
      }
      // 3. 存活期间重复启动同一 socket 必须拒绝（busy.daemon）
      await assert.rejects(
        () => createDaemonServer({ socketPath: sock, idleTimeoutSec: 0, runtime: mockRuntime }),
        err => err?.code === 'busy.daemon',
      );
      // 4. stats RPC 正常返回
      const st = await sendDaemonRequest(sock, 'stats', {});
      assert.equal(st.ok, true);
      assert.equal(st.data.socket, sock);
      // 5. shutdown RPC 优雅退出并清理 socket
      const sd = await sendDaemonRequest(sock, 'shutdown', {});
      assert.equal(sd.ok, true);
      await srv.closed;
      if (!IS_WIN) assert.equal(existsSync(sock), false, '退出后应清理 socket 文件');
    } finally {
      await srv.close();
    }

    // 6. 空闲超时自动退出
    const sock2 = ipcPath(dir, 'idle');
    const srv2 = await createDaemonServer({ socketPath: sock2, idleTimeoutSec: 0.15, runtime: mockRuntime });
    await srv2.closed;
    if (!IS_WIN) assert.equal(existsSync(sock2), false, '空闲超时后应自动清理 socket');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('device.lost 故障隔离与自动重建：当前作业返 failure.gpu，下次请求自动恢复成功', { timeout: 30000 }, async () => {
  const dir = tmp();
  const sock = ipcPath(dir, 'lost');
  try {
    let deviceSeq = 0;
    let triggerLost = null;
    let disposedHosts = 0;
    const mockGpu = { THREE: {}, TSL: {} };
    const makeDevice = () => {
      const id = ++deviceSeq;
      let lostResolve;
      const lost = new Promise(r => { lostResolve = r; });
      const listeners = new Set();
      triggerLost = msg => lostResolve({ reason: 'unknown', message: msg });
      return {
        id,
        lost,
        adapterInfo: { vendor: 'mock', architecture: null, description: `mock-${id}` },
        addEventListener(type, fn) { if (type === 'uncapturederror') listeners.add(fn); },
        removeEventListener(type, fn) { if (type === 'uncapturederror') listeners.delete(fn); },
        destroy() {},
      };
    };
    const fakeCreateHost = async ({ device, width, height, fps }) => ({
      device, width, height, fps,
      async load(file) { return { file, render() {}, dispose() {} }; },
      dispose() { disposedHosts++; },
    });
    let callCount = 0;
    const srv = await createDaemonServer({
      socketPath: sock,
      idleTimeoutSec: 0,
      maxCachedWorks: 2,
      loadGpuFn: async () => mockGpu,
      requestDeviceFn: async () => makeDevice(),
      createHostFn: fakeCreateHost,
      execJobFn: async ({ method, host }) => {
        callCount++;
        if (callCount === 1) {
          triggerLost('simulated GPU hang');
          await new Promise(r => setImmediate(r));
          const err = new Error('GPU 设备丢失');
          err.code = 'failure.gpu';
          throw err;
        }
        return { data: { method, deviceId: host.device.id }, outputs: [], warnings: [], humanLines: [] };
      },
    });
    try {
      const r1 = await sendDaemonRequest(sock, 'probe', { file: join(ROOT, WORK), width: 320, height: 180, fps: 24, query: '' });
      assert.equal(r1.ok, false);
      assert.equal(r1.error.code, 'failure.gpu');
      const r2 = await sendDaemonRequest(sock, 'probe', { file: join(ROOT, WORK), width: 320, height: 180, fps: 24, query: '' });
      assert.equal(r2.ok, true, JSON.stringify(r2.error));
      assert.equal(r2.data.deviceId, 2, '应在 device.lost 后自动重建新 GPUDevice');
      assert.ok(disposedHosts >= 1, '旧缓存宿主应已释放');
      const st = await sendDaemonRequest(sock, 'stats', {});
      assert.ok(st.data.deviceResets >= 1);
    } finally {
      await srv.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('LRU 作品池上限：超过 maxCachedWorks 淘汰最久未用宿主并调用 dispose()', { timeout: 30000 }, async () => {
  const dir = tmp();
  const sock = ipcPath(dir, 'lru');
  try {
    const disposed = [];
    const mockGpu = { THREE: {}, TSL: {} };
    const makeDevice = () => ({
      lost: new Promise(() => {}),
      adapterInfo: { vendor: 'mock', architecture: null, description: 'mock-lru' },
      addEventListener() {},
      removeEventListener() {},
      destroy() {},
    });
    const fakeCreateHost = async ({ device, width, height, fps }) => {
      const tag = `${width}x${height}`;
      return {
        device, width, height, fps,
        isFaulted: () => false,
        async load(file) { return { file, render() {}, dispose() {} }; },
        dispose() { disposed.push(tag); },
      };
    };
    const srv = await createDaemonServer({
      socketPath: sock,
      idleTimeoutSec: 0,
      maxCachedWorks: 2,
      loadGpuFn: async () => mockGpu,
      requestDeviceFn: async () => makeDevice(),
      createHostFn: fakeCreateHost,
      execJobFn: async ({ host }) => ({ data: { size: `${host.width}x${host.height}` }, outputs: [], warnings: [], humanLines: [] }),
    });
    try {
      const f = join(ROOT, WORK);
      // 载入 A(320x180)、B(640x360)，再复用 A 令 B 成为最久未用，再载入 C(1280x720) → 必须淘汰 B
      await sendDaemonRequest(sock, 'probe', { file: f, width: 320, height: 180, fps: 24, query: '' });
      await sendDaemonRequest(sock, 'probe', { file: f, width: 640, height: 360, fps: 24, query: '' });
      await sendDaemonRequest(sock, 'probe', { file: f, width: 320, height: 180, fps: 24, query: '' });
      await sendDaemonRequest(sock, 'probe', { file: f, width: 1280, height: 720, fps: 24, query: '' });
      assert.deepEqual(disposed, ['640x360'], '应精确淘汰最久未用的 640x360 并调用 dispose()');
      const st = (await sendDaemonRequest(sock, 'stats', {})).data;
      assert.equal(st.cachedWorks, 2);
      assert.equal(st.cacheHits, 1);
      assert.equal(st.cacheMisses, 3);
    } finally {
      await srv.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('未开守护进程时：--daemon <不存在socket> 报 env.daemon-unavailable（退出 3）', () => {
  const dir = tmp();
  const missingSock = ipcPath(dir, 'nope');
  try {
    const r = runCliSync(['probe', WORK, '--daemon', missingSock, '--json']);
    assert.equal(r.status, 3, r.stderr);
    assert.equal(JSON.parse(r.stdout).error.code, 'env.daemon-unavailable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────── 真实 GPU 端到端回归 ─────────────────────────

const probeGpu = spawnSync(process.execPath, ['--input-type=module', '-e',
  "try { const { loadGpu } = await import('./engine/offscreen/load.mjs'); const { createHost } = await import('./engine/offscreen/host.mjs'); (await createHost({ gpu: await loadGpu(), width: 64, height: 64 })).dispose(); } catch(e) { console.error(e.message); process.exitCode=e.code?.startsWith('env.')?3:1; }"],
{ cwd: ROOT, encoding: 'utf8', timeout: 60000 });
const noGpu = probeGpu.status === 3 && `离屏出片不可用：${probeGpu.stderr.trim()}`;
const ffmpegOk = spawnSync(FFMPEG(), ['-version'], { stdio: 'ignore' }).status === 0;
const noEncode = noGpu || (!ffmpegOk && '没有 FFmpeg');

async function waitForSocket(sock, timeoutMs = 15000) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1000000n;
  while (process.hrtime.bigint() < deadline) {
    try {
      const res = await sendDaemonRequest(sock, 'stats', {}, { timeoutMs: 1000 });
      if (res.ok) return res;
    } catch { /* 尚未就绪 */ }
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error(`等待守护进程就绪超时：${sock}`);
}

test('真实 GPU：常驻渲染与冷启动逐字节相同（MP4 + PNG）、缓存命中、文件改动热失效、默认路径不受影响', { skip: noEncode, timeout: 240000 }, async () => {
  const dir = tmp();
  const sock = ipcPath(dir, 'live');
  // 临时作品文件放在仓库内 lab/offscreen/ 下（符合 resolveWork 仓库内约束），finally 清理
  const hotWorkRel = `lab/offscreen/.daemon-hot-test-${process.pid}.mjs`;
  const hotWorkAbs = join(ROOT, hotWorkRel);
  const writeHotWork = hex => writeFileSync(hotWorkAbs,
    `export function build({ THREE, TSL, width, height, pipeline }) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(${hex});
  const cam = new THREE.PerspectiveCamera(45, width / height, 0.1, 10); cam.position.z = 2;
  const post = pipeline(TSL.pass(scene, cam));
  return { render() { post.render(); }, dispose() {} };
}\n`);
  let daemonProc = null;
  try {
    // 1. 冷启动基线（--daemon off）
    const coldMp4 = join(dir, 'cold.mp4');
    const coldStills = join(dir, 'cold-stills');
    const rColdV = runCliSync(['render', WORK, '--out', coldMp4, '--frames', '0:6', '--size', '320x180', '--mode', 'pro', '--json']);
    assert.equal(rColdV.status, 0, rColdV.stderr);
    const rColdS = runCliSync(['stills', WORK, '--out', coldStills, '--frames', '0,3', '--size', '320x180', '--json']);
    assert.equal(rColdS.status, 0, rColdS.stderr);

    // 2. 启动常驻守护进程
    daemonProc = spawn(process.execPath, [CLI, 'daemon', '--socket', sock, '--max-cached-works', '2', '--idle-timeout', '120'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForSocket(sock);

    // 3. 经 daemon 出 MP4（首次 miss + 二次 hit）与 PNG，逐字节对齐冷启动
    const hotMp4A = join(dir, 'hot-a.mp4');
    const hotMp4B = join(dir, 'hot-b.mp4');
    const hotStills = join(dir, 'hot-stills');
    const rHot1 = runCliSync(['render', WORK, '--out', hotMp4A, '--frames', '0:6', '--size', '320x180', '--mode', 'pro', '--daemon', sock, '--json']);
    assert.equal(rHot1.status, 0, rHot1.stderr);
    const rHot2 = runCliSync(['render', WORK, '--out', hotMp4B, '--frames', '0:6', '--size', '320x180', '--mode', 'pro', '--daemon', sock, '--json']);
    assert.equal(rHot2.status, 0, rHot2.stderr);
    const rHotS = runCliSync(['stills', WORK, '--out', hotStills, '--frames', '0,3', '--size', '320x180', '--daemon', sock, '--json']);
    assert.equal(rHotS.status, 0, rHotS.stderr);

    assert.equal(readFileSync(hotMp4A).equals(readFileSync(coldMp4)), true, 'daemon 首次 MP4 必须与冷启动逐字节相同');
    assert.equal(readFileSync(hotMp4B).equals(readFileSync(coldMp4)), true, 'daemon 热复用 MP4 必须与冷启动逐字节相同');
    assert.equal(readFileSync(join(hotStills, 'f000000.png')).equals(readFileSync(join(coldStills, 'f000000.png'))), true, 'daemon PNG f0 必须与冷启动逐字节相同');
    assert.equal(readFileSync(join(hotStills, 'f000003.png')).equals(readFileSync(join(coldStills, 'f000003.png'))), true, 'daemon PNG f3 必须与冷启动逐字节相同');

    // 检查缓存命中计数
    const st1 = runCliSync(['daemon', '--socket', sock, '--action', 'status', '--json']);
    assert.equal(st1.status, 0, st1.stderr);
    const st1Data = JSON.parse(st1.stdout).data;
    assert.ok(st1Data.cacheHits >= 2, `期望至少 2 次缓存命中，实际 ${st1Data.cacheHits}`);

    // 4. 修改作品文件后，下一次请求必须立刻反映新代码
    writeHotWork('0xff0000');
    const hotS1 = join(dir, 'hotwork-red');
    const hotS2 = join(dir, 'hotwork-blue');
    const rh1 = runCliSync(['stills', hotWorkRel, '--out', hotS1, '--frames', '0', '--size', '64x64', '--daemon', sock, '--json']);
    assert.equal(rh1.status, 0, rh1.stderr);
    writeHotWork('0x0000ff');
    const rh2 = runCliSync(['stills', hotWorkRel, '--out', hotS2, '--frames', '0', '--size', '64x64', '--daemon', sock, '--json']);
    assert.equal(rh2.status, 0, rh2.stderr);
    assert.notEqual(
      JSON.parse(rh1.stdout).data.frameHashes[0],
      JSON.parse(rh2.stdout).data.frameHashes[0],
      '修改作品文件后，daemon 必须失效旧缓存并渲染新画面',
    );

    // 5. 不传 --daemon（默认 off）时，不走 daemon
    const jobsBefore = JSON.parse(runCliSync(['daemon', '--socket', sock, '--action', 'status', '--json']).stdout).data.jobsCompleted;
    const rDef = runCliSync(['probe', WORK, '--size', '320x180', '--json']);
    assert.equal(rDef.status, 0, rDef.stderr);
    const jobsAfter = JSON.parse(runCliSync(['daemon', '--socket', sock, '--action', 'status', '--json']).stdout).data.jobsCompleted;
    assert.equal(jobsAfter, jobsBefore, '未显式启用 --daemon 时不能暗中走守护进程');

    // 6. --daemon auto 连不上时自动退回冷启动
    const rAuto = runCliSync(['probe', WORK, '--size', '320x180', '--daemon', 'auto', '--json'], {
      env: { ...process.env, BEIMING_OFFSCREEN_SOCKET: ipcPath(dir, 'absent') },
    });
    assert.equal(rAuto.status, 0, rAuto.stderr);
    assert.equal(JSON.parse(rAuto.stdout).ok, true);

    // 7. 优雅停止 daemon
    const rStop = runCliSync(['daemon', '--socket', sock, '--action', 'stop', '--json']);
    assert.equal(rStop.status, 0, rStop.stderr);
    const exitCode = await new Promise(resolve => {
      if (daemonProc.exitCode !== null) resolve(daemonProc.exitCode);
      else daemonProc.once('exit', code => resolve(code));
    });
    assert.equal(exitCode, 0);
    if (!IS_WIN) assert.equal(existsSync(sock), false);
  } finally {
    if (daemonProc && daemonProc.exitCode === null) daemonProc.kill('SIGKILL');
    rmSync(hotWorkAbs, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
