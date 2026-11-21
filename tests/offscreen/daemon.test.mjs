// 离屏出片 · WP1.2 常驻渲染守护进程（engine/offscreen/daemon.mjs 与 cli.mjs --daemon 接入）：
// 协议、IPC 权限与崩溃恢复、LRU 与热重载、device.lost 自愈、以及与冷启动逐字节一致的真 GPU 回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, lstatSync, realpathSync, existsSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FFMPEG } from '../../engine/render/lib/ffmpeg.mjs';
import * as D from '../../engine/offscreen/daemon.mjs';
import { filmFps, setFilmFps } from '../../engine/core/clock.js';
import { loadFilmFonts } from '../../engine/offscreen/canvas.mjs';
import { attachGpuTimer } from '../../engine/offscreen/gputimer.mjs';

const { defaultSocketPath, resolveDaemonTarget, computeWorkSignature, createDaemonServer, sendDaemonRequest } = D;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'engine/offscreen/cli.mjs');
const WORK = 'lab/offscreen/ink.mjs';
const runCliSync = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180000, ...opts });
const tmp = () => mkdtempSync(join(tmpdir(), 'beiming-daemon-test-'));
const IS_WIN = process.platform === 'win32';
// Windows 只能用命名管道（文件路径 listen 会 EACCES）；类 Unix 用临时目录里的 socket 文件
const ipcPath = (dir, name) => (IS_WIN ? `\\\\.\\pipe\\beiming-test-${process.pid}-${dir.slice(-6)}-${name}` : join(dir, `${name}.sock`));

const mockRuntime = () => ({
  adapter: { vendor: 'mock', architecture: null, description: 'mock-gpu' },
  software: false,
  async execute(method) {
    if (method === 'probe') return { data: { ok: true }, outputs: [], warnings: [] };
    throw new Error(`unexpected ${method}`);
  },
  stats() { return { cachedWorks: 0, maxCachedWorks: 4, cacheHits: 0, cacheMisses: 0, deviceResets: 0 }; },
  dispose() {},
});

// 子进程 listen 后被 SIGKILL：留下一个真正的、没人监听的 socket 文件（模拟守护进程崩溃）
async function staleSocket(p) {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(p)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', c => reject(new Error(`stale 子进程提前退出 ${c}`))); });
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
}

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
    // 1. 制造一个上次崩溃残留的死 socket（命名管道没有文件残留，Windows 跳过这一步）
    if (!IS_WIN) {
      await staleSocket(sock);
      assert.equal(lstatSync(sock).isSocket(), true);
    }

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

// ───────────────────────── 复核问题回归（#1–#4） ─────────────────────────

test('[#1] --socket 指向普通文件或符号链接：拒绝启动（用法错误），文件原样保留', { skip: IS_WIN && '命名管道没有文件路径' }, async () => {
  const dir = tmp();
  try {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'important data');
    const link = join(dir, 'link.sock');
    symlinkSync(victim, link);
    for (const p of [victim, link]) {
      const r = runCliSync(['daemon', '--socket', p, '--idle-timeout', '1', '--json']);
      assert.equal(r.status, 2, `${p}\n${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).error.code, 'usage.bad-socket-path');
    }
    await assert.rejects(() => createDaemonServer({ socketPath: victim, idleTimeoutSec: 0, runtime: mockRuntime() }), e => e.code === 'usage.bad-socket-path');
    assert.equal(readFileSync(victim, 'utf8'), 'important data', '普通文件必须原样保留');
    assert.equal(lstatSync(link).isSymbolicLink(), true, '符号链接必须原样保留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('[#3] 默认路径：无 XDG_RUNTIME_DIR 时落在当前用户专属子目录；Windows 管道名带用户成分', () => {
  assert.equal(defaultSocketPath({ env: {}, platform: 'linux', tmpdir: '/tmp', uid: 1000 }), '/tmp/beiming-offscreen-1000/daemon.sock');
  const a = defaultSocketPath({ env: {}, platform: 'win32', root: 'r', user: 'alice' });
  const b = defaultSocketPath({ env: {}, platform: 'win32', root: 'r', user: 'bob' });
  assert.match(a, /^\\\\\.\\pipe\\beiming-offscreen-[0-9a-f]{8}$/);
  assert.notEqual(a, b, '不同用户的默认管道名必须不同');
});

test('[#3] 服务端：父目录必须是本人所有、非符号链接、0700，否则拒绝；不存在时按 0700 新建', { skip: IS_WIN && 'Windows 没有 POSIX 属主与权限位' }, async () => {
  const dir = tmp();
  try {
    const open = join(dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    await assert.rejects(() => createDaemonServer({ socketPath: join(open, 'd.sock'), idleTimeoutSec: 0, runtime: mockRuntime() }), e => e.code === 'usage.unsafe-socket-dir');
    assert.equal(existsSync(join(open, 'd.sock')), false, '0755 目录里不能先 bind');
    const real = join(dir, 'real');
    mkdirSync(real, { mode: 0o700 });
    const ln = join(dir, 'ln');
    symlinkSync(real, ln);
    await assert.rejects(() => createDaemonServer({ socketPath: join(ln, 'd.sock'), idleTimeoutSec: 0, runtime: mockRuntime() }), e => e.code === 'usage.unsafe-socket-dir');
    assert.throws(() => D.assertPrivateSocketDir(real, { uid: process.getuid() + 1 }), e => e.code === 'usage.unsafe-socket-dir', '属主不是当前用户必须拒绝');
    // 二轮复核 #3：父目录是悬空符号链接或普通文件时，create: true 也必须报 usage.unsafe-socket-dir（exit 2），不能先 mkdirSync 报 EEXIST
    const dangling = join(dir, 'dangling-dir');
    symlinkSync(join(dir, 'nonexistent-target'), dangling);
    assert.throws(() => D.assertPrivateSocketDir(dangling, { create: true }), e => e.code === 'usage.unsafe-socket-dir' && e.exitCode === 2);
    await assert.rejects(() => createDaemonServer({ socketPath: join(dangling, 'd.sock'), idleTimeoutSec: 0, runtime: mockRuntime() }), e => e.code === 'usage.unsafe-socket-dir' && e.exitCode === 2);
    const regularFile = join(dir, 'not-a-dir');
    writeFileSync(regularFile, 'plain');
    assert.throws(() => D.assertPrivateSocketDir(regularFile, { create: true }), e => e.code === 'usage.unsafe-socket-dir' && e.exitCode === 2);
    await assert.rejects(() => createDaemonServer({ socketPath: join(regularFile, 'd.sock'), idleTimeoutSec: 0, runtime: mockRuntime() }), e => e.code === 'usage.unsafe-socket-dir' && e.exitCode === 2);
    D.assertPrivateSocketDir(real);
    const fresh = join(dir, 'fresh', 'sub');
    const srv = await createDaemonServer({ socketPath: join(fresh, 'd.sock'), idleTimeoutSec: 0, runtime: mockRuntime() });
    try {
      assert.equal(statSync(fresh).mode & 0o777, 0o700);
      assert.equal(statSync(join(fresh, 'd.sock')).mode & 0o777, 0o600);
    } finally { await srv.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('[#3] 客户端：连接前校验 socket 与父目录属主为当前用户，不信任冒充的 socket', { skip: IS_WIN && 'Windows 没有 POSIX 属主', timeout: 30000 }, async () => {
  const dir = tmp();
  const sock = ipcPath(dir, 'trust');
  const srv = await createDaemonServer({ socketPath: sock, idleTimeoutSec: 0, runtime: mockRuntime() });
  try {
    assert.equal((await sendDaemonRequest(sock, 'stats', {})).ok, true);
    await assert.rejects(() => sendDaemonRequest(sock, 'stats', {}, { uid: process.getuid() + 1 }), e => e.code === 'env.daemon-untrusted');
    const fake = join(dir, 'fake.sock');
    writeFileSync(fake, '');
    await assert.rejects(() => sendDaemonRequest(fake, 'stats', {}), e => e.code === 'env.daemon-untrusted');
    // 二轮复核 #4：独立覆盖父目录属主校验 ds.uid !== uid（socket 属主是本人，父目录真实非软链但属主非本人，如 /tmp）
    const myUid = process.getuid();
    const pubDir = [realpathSync(tmpdir()), '/tmp'].find(d => {
      try {
        const s = lstatSync(d);
        return s.isDirectory() && !s.isSymbolicLink() && s.uid !== myUid;
      } catch { return false; }
    });
    if (pubDir) {
      const pubSock = join(pubDir, `beiming-trust-parent-${process.pid}-${Date.now()}.sock`);
      const pubSrv = net.createServer();
      try {
        await new Promise((resolve, reject) => { pubSrv.once('error', reject); pubSrv.listen(pubSock, resolve); });
        assert.equal(lstatSync(pubSock).uid, myUid, '前置条件：临时 socket 属主应是当前用户');
        assert.notEqual(lstatSync(pubDir).uid, myUid, '前置条件：父目录属主应非当前用户');
        assert.throws(() => D.assertTrustedSocket(pubSock), e => e.code === 'env.daemon-untrusted');
        await assert.rejects(() => sendDaemonRequest(pubSock, 'stats', {}), e => e.code === 'env.daemon-untrusted');
      } finally {
        await new Promise(r => pubSrv.close(() => r()));
        rmSync(pubSock, { force: true });
      }
    }
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('[二轮 #1] 陈旧 socket 与全新路径并发抢启动：只允许一个成功、不误删胜方活 socket、败方 EADDRINUSE 返 busy.daemon（exit 5）', { timeout: 30000 }, async () => {
  const dir = tmp();
  const makeTaggedRuntime = tag => ({
    ...mockRuntime(),
    stats() { return { tag, cachedWorks: 0, maxCachedWorks: 4, cacheHits: 0, cacheMisses: 0, deviceResets: 0 }; },
  });
  try {
    // 1. 全新路径并发抢启动：败方返 busy.daemon（exitCode 5），胜方正常提供服务
    const freshSock = ipcPath(dir, 'race-fresh');
    const freshTags = ['A', 'B'];
    const freshRes = await Promise.allSettled(
      freshTags.map(tag => createDaemonServer({ socketPath: freshSock, idleTimeoutSec: 0, runtime: makeTaggedRuntime(tag) })),
    );
    const freshWins = freshRes.map((r, i) => ({ r, tag: freshTags[i] })).filter(x => x.r.status === 'fulfilled');
    const freshFails = freshRes.filter(r => r.status === 'rejected').map(r => r.reason);
    try {
      assert.equal(freshWins.length, 1, `全新路径并发应恰好 1 个成功，实际 ${freshWins.length}`);
      assert.equal(freshFails.length, 1);
      assert.equal(freshFails[0].code, 'busy.daemon', `EADDRINUSE 应转为 busy.daemon，实际：${freshFails[0]?.code} / ${freshFails[0]?.message}`);
      assert.equal(freshFails[0].exitCode, 5);
      const st = await sendDaemonRequest(freshSock, 'stats', {});
      assert.equal(st.ok, true);
      assert.equal(st.data.tag, freshWins[0].tag);
    } finally {
      for (const w of freshWins) await w.r.value.close();
    }

    // 2. 类 Unix 陈旧 socket 并发抢启动（多轮）：启动短锁串行化 probe→unlink→listen，避免 ext4 inode 复用导致误删胜方活 socket
    if (!IS_WIN) {
      assert.equal(existsSync(`${freshSock}.lock`), false, '启动完成后不应残留 .lock 文件');
      for (let round = 0; round < 5; round++) {
        const staleSock = ipcPath(dir, `race-stale-${round}`);
        await staleSocket(staleSock);
        assert.equal(lstatSync(staleSock).isSocket(), true);
        const staleTags = ['W1', 'W2', 'W3'];
        const staleRes = await Promise.allSettled(
          staleTags.map(tag => createDaemonServer({ socketPath: staleSock, idleTimeoutSec: 0, runtime: makeTaggedRuntime(tag) })),
        );
        const staleWins = staleRes.map((r, i) => ({ r, tag: staleTags[i] })).filter(x => x.r.status === 'fulfilled');
        const staleFails = staleRes.filter(r => r.status === 'rejected').map(r => r.reason);
        try {
          assert.equal(staleWins.length, 1, `第 ${round + 1} 轮陈旧 socket 并发抢启动应恰好 1 个成功（不出现孤儿实例），实际 ${staleWins.length}`);
          assert.equal(staleFails.length, 2);
          for (const err of staleFails) {
            assert.equal(err.code, 'busy.daemon', `败方应返 busy.daemon，实际：${err?.code} / ${err?.message}`);
            assert.equal(err.exitCode, 5);
          }
          assert.equal(existsSync(`${staleSock}.lock`), false, '并发抢启动结束后不应残留 .lock 文件');
          const st = await sendDaemonRequest(staleSock, 'stats', {});
          assert.equal(st.ok, true);
          assert.equal(st.data.tag, staleWins[0].tag, '当前监听者必须是唯一胜方（无孤儿实例）');
        } finally {
          for (const w of staleWins) await w.r.value.close();
        }
      }

      // 3. 死进程残留的 .lock 文件自动恢复；.lock 为符号链接时拒绝启动且不删除
      const deadChild = spawnSync(process.execPath, ['-e', '']);
      assert.ok(deadChild.pid > 0);
      const recoverSock = ipcPath(dir, 'recover-lock');
      writeFileSync(`${recoverSock}.lock`, `${deadChild.pid}:1\n`);
      const recovered = await createDaemonServer({ socketPath: recoverSock, idleTimeoutSec: 0, runtime: makeTaggedRuntime('R') });
      try {
        assert.equal(existsSync(`${recoverSock}.lock`), false);
        assert.equal((await sendDaemonRequest(recoverSock, 'stats', {})).data.tag, 'R');
      } finally { await recovered.close(); }

      const badLockSock = ipcPath(dir, 'symlink-lock');
      const target = join(dir, 'keep.txt');
      writeFileSync(target, 'keep');
      symlinkSync(target, `${badLockSock}.lock`);
      await assert.rejects(
        () => createDaemonServer({ socketPath: badLockSock, idleTimeoutSec: 0, runtime: makeTaggedRuntime('X') }),
        e => e.code === 'usage.bad-socket-path' && e.exitCode === 2,
      );
      assert.equal(lstatSync(`${badLockSock}.lock`).isSymbolicLink(), true, '符号链接 .lock 必须原样保留');
      assert.equal(readFileSync(target, 'utf8'), 'keep');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('[二轮 #2] --daemon <相对路径> --socket <同一相对路径> 归一化后一致，不误报 conflicting-socket', () => {
  assert.deepEqual(
    resolveDaemonTarget('./d.sock', { env: {}, platform: 'linux', cwd: '/work/sub', socket: '/work/sub/d.sock' }),
    { mode: 'required', socket: '/work/sub/d.sock' },
  );
  assert.deepEqual(
    resolveDaemonTarget('./d.sock', { env: {}, platform: 'linux', cwd: '/work/sub', socket: './d.sock' }),
    { mode: 'required', socket: '/work/sub/d.sock' },
  );
  assert.throws(
    () => resolveDaemonTarget('./a.sock', { env: {}, platform: 'linux', cwd: '/work/sub', socket: './b.sock' }),
    e => e.code === 'usage.conflicting-socket' && e.exitCode === 2,
  );
  assert.deepEqual(
    resolveDaemonTarget('\\\\.\\pipe\\beiming-same', { env: {}, platform: 'win32', socket: '\\\\.\\pipe\\beiming-same' }),
    { mode: 'required', socket: '\\\\.\\pipe\\beiming-same' },
  );
  // 经 CLI 传同一相对路径（--daemon ./same.sock --socket ./same.sock）：应尝试连接解析后的绝对路径，而非报 usage.conflicting-socket
  const dir = tmp();
  const env = { ...process.env };
  delete env.BEIMING_OFFSCREEN_DAEMON;
  delete env.BEIMING_OFFSCREEN_SOCKET;
  try {
    const r = runCliSync(['probe', join(ROOT, WORK), '--daemon', './same.sock', '--socket', './same.sock', '--json'], { cwd: dir, env });
    assert.equal(r.status, 3, `应因 socket 不存在退出 3，而非 conflicting-socket：\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    const e = JSON.parse(r.stdout).error;
    assert.equal(e.code, 'env.daemon-unavailable');
    assert.ok(e.message.includes(join(dir, 'same.sock')), `应包含归一化后的绝对路径：${e.message}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('[#4] --daemon on --socket <路径> 连 --socket 指定的路径；只给 --socket 不开 daemon 报用法错误', () => {
  assert.deepEqual(resolveDaemonTarget('on', { env: {}, platform: 'linux', socket: '/x/y.sock' }), { mode: 'required', socket: '/x/y.sock' });
  assert.deepEqual(resolveDaemonTarget('auto', { env: {}, platform: 'linux', socket: '/x/y.sock' }), { mode: 'auto', socket: '/x/y.sock' });
  const dir = tmp();
  const sock = ipcPath(dir, 'cli');
  const env = { ...process.env };
  delete env.BEIMING_OFFSCREEN_DAEMON;
  delete env.BEIMING_OFFSCREEN_SOCKET;
  try {
    const r = runCliSync(['probe', WORK, '--daemon', 'on', '--socket', sock, '--json'], { env });
    assert.equal(r.status, 3, r.stderr);
    const e = JSON.parse(r.stdout).error;
    assert.equal(e.code, 'env.daemon-unavailable');
    assert.ok(e.message.includes(sock), `应连 --socket 指定的路径：${e.message}`);
    const r2 = runCliSync(['probe', WORK, '--socket', sock, '--json'], { env });
    assert.equal(r2.status, 2, r2.stderr);
    assert.equal(JSON.parse(r2.stdout).error.code, 'usage.socket-without-daemon');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('[#2] 热重载只给作品侧模块带 ?v：engine/* 单实例（filmFps 与守护进程一致、canvas / gputimer 同一份），作品本地依赖照样热更新', { timeout: 30000 }, async () => {
  const dir = tmp();
  const sock = ipcPath(dir, 'refs');
  const tag = `${process.pid}`;
  const helperAbs = join(ROOT, `lab/offscreen/.daemon-ref-helper-${tag}.mjs`);
  const workAbs = [1, 2].map(i => join(ROOT, `lab/offscreen/.daemon-ref-work${i}-${tag}.mjs`));
  const workSrc = `import { filmFps } from '../../engine/core/clock.js';
import { loadFilmFonts } from '../../engine/offscreen/canvas.mjs';
import { attachGpuTimer } from '../../engine/offscreen/gputimer.mjs';
import { V } from './.daemon-ref-helper-${tag}.mjs';
export function build() {
  return { render() {}, get dur() { globalThis.__DAEMON_REFS = { loadFilmFonts, attachGpuTimer, V }; return filmFps(); } };
}
`;
  writeFileSync(helperAbs, "export const V = 'a';\n");
  for (const f of workAbs) writeFileSync(f, workSrc);
  // 与 host.load 同样的导入方式（带 ?v=<sig>），不需要 GPU
  const createHostFn = async ({ device, width, height, fps }) => ({
    device, width, height, fps, isFaulted: () => false,
    async load(file, { cacheBust } = {}) {
      const u = pathToFileURL(file);
      if (cacheBust) u.searchParams.set('v', String(cacheBust));
      const mod = await import(u.href);
      const work = await mod.build({});
      Object.defineProperty(work, '__module', { value: mod });
      return work;
    },
    dispose() {},
  });
  const srv = await createDaemonServer({
    socketPath: sock, idleTimeoutSec: 0, maxCachedWorks: 4,
    loadGpuFn: async () => ({ THREE: {}, TSL: {} }),
    requestDeviceFn: async () => ({ lost: new Promise(() => {}), adapterInfo: {}, addEventListener() {}, removeEventListener() {}, destroy() {} }),
    createHostFn,
  });
  try {
    for (const f of workAbs) {
      const r = await sendDaemonRequest(sock, 'probe', { file: f, width: 64, height: 36, fps: 30, query: '' });
      assert.equal(r.ok, true, JSON.stringify(r.error));
      assert.equal(r.data.dur, 30, '作品读到的 filmFps() 必须是守护进程刚设的 30（engine/core/clock.js 单实例）');
      assert.equal(globalThis.__DAEMON_REFS.loadFilmFonts, loadFilmFonts, 'canvas.mjs 必须单实例（字体注册去重跨作品生效）');
      assert.equal(globalThis.__DAEMON_REFS.attachGpuTimer, attachGpuTimer, 'gputimer.mjs 必须单实例（profile --daemon 才有分段）');
      assert.equal(globalThis.__DAEMON_REFS.V, 'a');
    }
    writeFileSync(helperAbs, "export const V = 'bb';\n");
    const r = await sendDaemonRequest(sock, 'probe', { file: workAbs[0], width: 64, height: 36, fps: 30, query: '' });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(globalThis.__DAEMON_REFS.V, 'bb', '作品本地依赖改动后必须热更新');
  } finally {
    await srv.close();
    setFilmFps(24);
    assert.equal(filmFps(), 24);
    for (const f of [helperAbs, ...workAbs]) rmSync(f, { force: true });
    rmSync(dir, { recursive: true, force: true });
    delete globalThis.__DAEMON_REFS;
  }
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

test('[#2] 真实 GPU：offscreen profile --daemon 的分段与 --daemon off 相同', { skip: noGpu, timeout: 180000 }, async () => {
  const dir = tmp();
  const sock = ipcPath(dir, 'prof');
  const proc = spawn(process.execPath, [CLI, 'daemon', '--socket', sock, '--idle-timeout', '120'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    await waitForSocket(sock);
    const args = ['profile', 'films/chendu/offscreen.mjs', '--frames', '0,48', '--size', '320x180', '--json'];
    const labels = r => JSON.parse(r.stdout).data.passes.map(p => p.label).sort();
    const cold = runCliSync([...args, '--daemon', 'off']);
    assert.equal(cold.status, 0, cold.stderr);
    const hot = runCliSync([...args, '--daemon', sock]);
    assert.equal(hot.status, 0, hot.stderr);
    assert.ok(labels(cold).length > 1);
    assert.deepEqual(labels(hot), labels(cold));
    assert.equal(runCliSync(['daemon', '--socket', sock, '--action', 'stop', '--json']).status, 0);
    await new Promise(r => (proc.exitCode !== null ? r() : proc.once('exit', r)));
  } finally {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

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
