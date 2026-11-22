import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { CompError } from './stitch.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comp-sink-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'out.bin') };
}

const failed = (e) => e instanceof CompError && e.code === 'failure.ffmpeg';

// 子进程先产生半截文件，再等父进程放行，让 drain、abort 和提前退出的顺序可复现。
async function stalledEncoder(t, action) {
  const { openEncoderSink } = await import('./sink.mjs');
  const { dir, path } = fixture(t);
  const ready = join(dir, 'ready'), go = join(dir, 'go');
  const script = `const fs = require('node:fs');
    const [ready, go, tmp] = process.argv.slice(1);
    fs.writeFileSync(tmp, 'partial');
    fs.writeFileSync(ready + '.tmp', String(process.pid)); fs.renameSync(ready + '.tmp', ready);
    const timer = setInterval(() => { if (fs.existsSync(go)) { clearInterval(timer); ${action} } }, 5);`;
  const sink = openEncoderSink({ path, bin: process.execPath, args: ['-e', script, ready, go], timeoutMs: 20000 });
  t.after(() => sink.abort());
  while (!existsSync(ready)) await sleep(5, undefined, { signal: t.signal });
  const pid = Number(readFileSync(ready, 'utf8'));
  rmSync(ready);
  return { sink, dir, path, go, pid };
}

const countTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const assertReaped = (pid) => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

test('文件在 finish 后一次发布，abort 保留已有内容', async (t) => {
  const { openFileSink } = await import('./sink.mjs');
  const { dir, path } = fixture(t);
  const first = openFileSink({ path });
  await first.write(Buffer.alloc(256 * 1024, 1));
  assert.ok(!existsSync(path));
  await Promise.all([first.abort(), first.abort()]);
  assert.deepEqual(readdirSync(dir), []);
  writeFileSync(path, 'previous');
  const next = openFileSink({ path });
  await next.write(Buffer.from('complete'));
  assert.equal(readFileSync(path, 'utf8'), 'previous');
  await next.finish();
  await next.abort();
  assert.equal(readFileSync(path, 'utf8'), 'complete');
  const cancelled = openFileSink({ path });
  await cancelled.write(Buffer.from('partial'));
  await cancelled.abort();
  assert.equal(readFileSync(path, 'utf8'), 'complete');
  assert.deepEqual(readdirSync(dir), ['out.bin']);
});

for (const mode of ['abort', 'exit', 'drain']) {
  test(`写满真实管道后 ${mode}，回收子进程、定时器和临时文件`, { timeout: 10000 }, async (t) => {
    const timers = countTimers();
    const action = mode === 'exit' ? 'process.exit(9)' : 'process.stdin.pipe(fs.createWriteStream(tmp))';
    const { sink, dir, path, go, pid } = await stalledEncoder(t, action);
    const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
    let settled = false;
    const write = sink.write(bytes).finally(() => { settled = true; });
    const checked = mode === 'drain' ? write : assert.rejects(write, failed);
    await sleep(15);
    assert.equal(settled, false);
    assert.ok(!existsSync(path));
    if (mode === 'abort') await Promise.all([sink.abort(), sink.abort()]);
    else writeFileSync(go, '');
    await checked;
    if (mode === 'drain') {
      await sink.finish();
      assert.deepEqual(readFileSync(path), bytes);
    } else await assert.rejects(sink.finish(), failed);
    assertReaped(pid);
    rmSync(go, { force: true });
    assert.deepEqual(readdirSync(dir), mode === 'drain' ? ['out.bin'] : []);
    assert.equal(countTimers(), timers);
  });
}

test('并发 finish 和 abort 会拒绝在途写入，保留原成品', async (t) => {
  const { openFileSink } = await import('./sink.mjs');
  const { path, dir } = fixture(t);
  writeFileSync(path, 'original');
  const sink = openFileSink({ path });
  await Promise.all([
    assert.rejects(sink.write(Buffer.alloc(256 * 1024)), failed),
    assert.rejects(sink.finish(), failed),
    sink.abort(),
  ]);
  assert.equal(readFileSync(path, 'utf8'), 'original');
  assert.deepEqual(readdirSync(dir), ['out.bin']);
});

test('缺失编码器和超时分别给出登记的 CompError，目录内零残留', async (t) => {
  const { openEncoderSink } = await import('./sink.mjs');
  const { path, dir } = fixture(t);
  for (const [code, options] of [
    ['env.ffmpeg-missing', { bin: join(dir, 'absent'), args: [] }],
    ['timeout.ffmpeg', { bin: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], timeoutMs: 100 }],
  ]) {
    const sink = openEncoderSink({ path, ...options });
    await assert.rejects(sink.finish(), (e) => e instanceof CompError && e.code === code);
    assert.deepEqual(readdirSync(dir), []);
  }
});

test('合成收尾公共入口提供两种输出端和拟音库', async () => {
  const comp = await import('./index.mjs');
  assert.equal(typeof comp.openFileSink, 'function');
  assert.equal(typeof comp.openEncoderSink, 'function');
  assert.equal(typeof comp.FOLEY_VOICES, 'object');
});
