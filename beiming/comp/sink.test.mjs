import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { setImmediate } from 'node:timers/promises';
import { deliver, encode, openEncoderSink, openFileSink, runTool, tools } from './index.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comp-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'out.mp4') };
}

const ffmpeg = tools().ffmpeg;
const hasFFmpeg = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 15000 }).status === 0;
const needFFmpeg = { skip: !hasFFmpeg && '需要 FFmpeg' };
const rawArgs = ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', '32x16', '-i', 'pipe:0', '-c:v', 'libx264'];

test('FFmpeg 输入两帧但仅编码一帧，即使正常结束也保留旧目标', needFFmpeg, async (t) => {
  const { dir, path } = fixture(t);
  writeFileSync(path, 'previous');
  const sink = openEncoderSink({ path, args: [...rawArgs, '-frames:v', '1'], expectedFrames: 2 });
  await sink.write(Buffer.alloc(32 * 16 * 1.5 * 2));
  await assert.rejects(sink.finish(), { name: 'CompError', code: 'failure.ffmpeg' });
  assert.deepEqual(readdirSync(dir), ['out.mp4']);
  assert.equal(readFileSync(path, 'utf8'), 'previous');
});

for (const mode of ['无 write', '零字节 write']) {
  test(`空编码 ${mode}，即使编码器成功写出文件头也保留旧成品`, async (t) => {
    const { dir, path } = fixture(t);
    writeFileSync(path, 'previous');
    const headerOnly = `const fs = require('node:fs'); fs.readFileSync(0); fs.writeFileSync(process.argv[1], 'header'); console.log('progress=end');`;
    const sink = openEncoderSink(hasFFmpeg ? { path, args: rawArgs } : { path, bin: process.execPath, args: ['-e', headerOnly] });
    if (mode === '零字节 write') await sink.write(Buffer.alloc(0));
    await assert.rejects(sink.finish(), { name: 'CompError', code: 'failure.ffmpeg' });
    assert.equal(readFileSync(path, 'utf8'), 'previous');
    assert.deepEqual(readdirSync(dir), ['out.mp4']);
  });
}

test('编码器消费输入并成功退出，零字节产物仍拒绝发布', async (t) => {
  const { dir, path } = fixture(t);
  const script = `const fs = require('node:fs'); fs.readFileSync(0); fs.writeFileSync(process.argv[1], ''); console.log('progress=end');`;
  const sink = openEncoderSink({ path, bin: process.execPath, args: ['-e', script] });
  await sink.write(Buffer.from([1]));
  await assert.rejects(sink.finish(), { name: 'CompError', code: 'failure.ffmpeg' });
  assert.deepEqual(readdirSync(dir), []);
});

test('M05 输入 EOF 后落盘半截并退出 9，首次输出与替换旧成品均零残留', async (t) => {
  const { dir, path } = fixture(t);
  const witness = fixture(t).path;
  const script = `const fs = require('node:fs');
    const [witness, tmp] = process.argv.slice(1);
    const bytes = fs.readFileSync(0);
    fs.writeFileSync(tmp, bytes.subarray(0, bytes.length / 2));
    fs.writeFileSync(witness, JSON.stringify({ partial: fs.statSync(tmp).size, pid: process.pid }));
    process.exitCode = 9;`;
  for (const existing of [false, true]) {
    if (existing) writeFileSync(path, 'previous');
    const sink = openEncoderSink({ path, bin: process.execPath, args: ['-e', script, witness] });
    await sink.write(Buffer.alloc(768));
    await assert.rejects(sink.finish(), { name: 'CompError', code: 'failure.ffmpeg', message: /退出.*9/ });
    const { partial, pid } = JSON.parse(readFileSync(witness, 'utf8'));
    assert.equal(partial, 384);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(readdirSync(dir), existing ? ['out.mp4'] : []);
    if (existing) assert.equal(readFileSync(path, 'utf8'), 'previous');
  }
});

for (const code of ['env.ffmpeg-missing', 'timeout.ffmpeg']) {
  test(`空输入遇到 ${code}，错误码、消息与提示同同步调用`, async (t) => {
    const { dir, path } = fixture(t);
    const bin = code === 'env.ffmpeg-missing' ? join(dir, 'absent') : process.execPath;
    const args = ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'];
    const timeoutMs = 150;
    let expected;
    assert.throws(() => runTool(bin, args, { timeoutMs }), (err) => {
      assert.equal(err.code, code);
      expected = { name: err.name, code, message: err.message, hint: err.hint };
      return true;
    });
    const sink = openEncoderSink({ path, bin, args, timeoutMs });
    await assert.rejects(sink.finish(), expected);
    assert.deepEqual(readdirSync(dir), []);
  });
}

for (const [entry, opts] of [[encode, { outputs: [] }], [deliver, { tier: 'final', hwEncoder: 'h264_nvenc' }]]) {
  test(`${entry.name} 工厂入口在前置参数校验失败时返回 rejected Promise`, async () => {
    assert.throws(() => entry(opts), { name: 'CompError', code: 'usage.bad-argument' });
    const result = entry({ ...opts, sinkFactory: openEncoderSink });
    assert.ok(result instanceof Promise);
    await assert.rejects(result, { name: 'CompError', code: 'usage.bad-argument' });
  });
}

const smallGraph = {
  size: [64, 32], fps: { num: 24, den: 1 }, frames: 4, label: 'v', filter: '[0:v]null[v]',
  inputs: [['-f', 'lavfi', '-i', 'testsrc2=size=64x32:rate=24', '-frames:v', '4']],
};

for (const code of ['failure.ffmpeg', 'timeout.ffmpeg']) {
  test(`上游 ${code} 能打断慢端写入并执行 abort`, needFFmpeg, async (t) => {
    const { path } = fixture(t);
    const broken = code === 'failure.ffmpeg';
    // 四帧后跟一个截断的包。用原速读取，让第一帧进慢端后 FFmpeg 才处理坏包。
    writeFileSync(path, Buffer.alloc(64 * 32 * 1.5 * 4 + 1));
    const input = broken
      ? ['-xerror', '-re', '-probesize', '32', '-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', '64x32', '-framerate', '4', '-i', path, '-threads:v', '1', '-flush_packets', '1']
      : ['-f', 'lavfi', '-i', 'testsrc2=size=64x32:rate=24'];
    const release = Promise.withResolvers();
    let writes = 0, aborts = 0;
    const job = encode({ graph: { ...smallGraph, inputs: [input] }, outputs: [{ preset: 'web' }], timeoutMs: broken ? 4000 : 500,
      sinkFactory: () => ({
        write() { writes++; return release.promise; },
        finish() { assert.fail('上游失败时调用了 finish'); },
        abort() { aborts++; release.resolve(); },
      }),
    });
    let timer;
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('上游已结束，仍在等慢端 write')), broken ? 5000 : 1500); });
      await assert.rejects(Promise.race([job, deadline]), { name: 'CompError', code });
    } finally {
      clearTimeout(timer);
      release.resolve();
      await job.catch(() => {});
    }
    assert.equal(writes, 1);
    assert.equal(aborts, 1);
  });
}

for (const method of ['write', 'finish']) {
  test(`双输出 ${method} 一路同步抛错时，已启动的另一路异步拒绝也被接收`, needFFmpeg, async () => {
    const pending = Promise.withResolvers();
    const aborted = [];
    const job = encode({ graph: smallGraph, outputs: [{ preset: 'preview' }, { preset: 'web' }], sinkFactory({ preset }) {
      return { write() {}, finish() {}, [method]() {
        if (preset === 'web') throw new Error('第二路同步失败');
        return pending.promise;
      }, abort() {
        aborted.push(preset);
        if (preset === 'preview') pending.reject(new Error('第一路异步拒绝'));
      } };
    } });
    await assert.rejects(job, { code: 'failure.ffmpeg', message: /第二路同步失败/ });
    assert.deepEqual(aborted, ['preview', 'web']);
    await setImmediate(); // node:test 会把本轮未处理的拒绝判为失败。
  });
}

async function checkBackpressure(t, slowPreset) {
  const { dir } = fixture(t);
  const go = join(dir, 'go');
  const outputs = ['preview', 'web'].map((preset) => ({ preset, path: join(dir, preset) }));
  const graph = { size: [640, 360], fps: { num: 24, den: 1 }, frames: 24, label: 'v',
    inputs: [['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=1']], filter: '[0:v]null[v]' };
  const script = `const fs = require('node:fs');
    const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) {
      clearInterval(timer); process.stdin.pipe(fs.createWriteStream(process.argv[2])).on('finish', () => console.log('frame=24\\nprogress=end'));
    } }, 5);`;
  let fastWrites = 0, slowWrites = 0, drained = 0;
  const blocked = Promise.withResolvers();
  const encoding = encode({ graph, outputs, timeoutMs: 10000, sinkFactory(spec) {
    assert.equal(spec.expectedFrames, graph.frames);
    if (spec.preset !== slowPreset) {
      const sink = openFileSink(spec);
      return { ...sink, write(chunk) { fastWrites++; return sink.write(chunk); } };
    }
    const sink = openEncoderSink({ ...spec, bin: process.execPath, args: ['-e', script, go] });
    return { ...sink, async write(chunk) {
      slowWrites++;
      const timer = setTimeout(blocked.resolve, 100);
      try { await sink.write(chunk); drained++; }
      finally { clearTimeout(timer); }
    } };
  } });
  let pausedAt;
  try {
    await Promise.race([blocked.promise, encoding.then(() => assert.fail('管道应在放行前写满'))]);
    pausedAt = fastWrites;
    assert.equal(fastWrites, slowWrites);
    assert.equal(fastWrites, drained + 1, '慢端尚有一块未 drain，快端已收到下一块');
  } finally {
    writeFileSync(go, '');
    await encoding;
  }
  assert.ok(fastWrites > pausedAt);
  assert.equal(drained, fastWrites);
  const bytes = readFileSync(outputs[0].path);
  assert.equal(bytes.length, 640 * 360 * 1.5 * 24);
  assert.deepEqual(readFileSync(outputs[1].path), bytes);
  t.diagnostic(`第 ${pausedAt} 块等待 drain，放行后两端收到 ${fastWrites} 块，共 ${bytes.length} 字节`);
}

for (const slowPreset of ['preview', 'web']) {
  test(`M21 双路分发等待 ${slowPreset} 端真实管道 drain 后才发送下一块`, { ...needFFmpeg, timeout: 15000 }, (t) => checkBackpressure(t, slowPreset));
}
