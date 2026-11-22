import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { CompError, bad, tools } from './stitch.mjs';

const failure = (message) => new CompError('failure.ffmpeg', message);

// 拼接进程读 stdout，编码进程写 stdin。close 意味着进程和管道均已回收。
export function startPipe(bin, args, direction, controller, timeoutMs = 600000, expectedFrames) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw bad('timeoutMs 超出定时器范围');
  const input = direction === 'write';
  const child = spawn(bin, input ? [...args, '-progress', 'pipe:1'] : args, {
    stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let progress = '';
  if (input) child.stdout.setEncoding('utf8').on('data', (s) => { progress = (progress + s).slice(-4096); });
  const stream = input ? child.stdin : child.stdout;
  const kill = () => {
    stream.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  controller.signal.addEventListener('abort', kill, { once: true });
  const timer = setTimeout(() => controller.abort(CompError.toolTimeout(bin, timeoutMs)), timeoutMs);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (s) => { stderr = (stderr + s).slice(-4096); });
  child.once('error', (e) => controller.abort(CompError.toolUnavailable(bin, e)));
  stream.on('error', (e) => controller.abort(failure(`管道错误：${e.message}`)));
  child.once('exit', (code, signal) => {
    if (code !== 0 || (input && !stream.writableFinished)) {
      controller.abort(failure(`编码管道退出 ${code ?? signal}：${stderr.trim()}`));
    }
  });
  const closed = new Promise((done) => child.once('close', () => {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', kill);
    // 父端写完只代表管道接收了字节；等进程和 stdout 都关闭，再核对编码器自己的末次回报。
    if (input && !controller.signal.aborted) {
      const last = progress.split('progress=continue').at(-1).trim();
      const frames = /^frame=\s*(\d+)\r?$/m.exec(last)?.[1];
      if (!/(?:^|\n)progress=end$/.test(last)) controller.abort(failure('编码器未报告完成'));
      else if (expectedFrames !== undefined && Number(frames) !== expectedFrames) {
        controller.abort(failure(`编码器报告 ${frames ?? 0} 帧，预期 ${expectedFrames} 帧`));
      }
    }
    done();
  }));
  return { stream, closed };
}

function atomicSink(path, encoder) {
  if (typeof path !== 'string' || !path.length) throw bad('输出端需要目标 path');
  const target = resolve(path);
  const tmp = join(dirname(target), `.beiming-${randomUUID()}${extname(target)}`);
  const controller = new globalThis.AbortController();
  const { signal } = controller;
  let stream, closed;
  if (encoder) {
    ({ stream, closed } = startPipe(encoder.bin, [...encoder.args, tmp], 'write', controller, encoder.timeoutMs, encoder.expectedFrames));
  } else {
    stream = createWriteStream(tmp, { flags: 'wx' });
    stream.on('error', (e) => controller.abort(failure(`文件写入失败：${e.message}`)));
    signal.addEventListener('abort', () => stream.destroy(), { once: true });
    closed = new Promise((done) => stream.once('close', done));
  }
  let finishing, drain, published = false, hasInput = false;
  stream.once('close', () => {
    if (!stream.writableFinished) controller.abort(failure('输出管道提前关闭'));
  });
  // 即使调用方在两次 write 之间停顿，进程失败也会主动清理。
  let cleanupError;
  const reaped = closed.then(() => {
    if (signal.aborted) {
      try { rmSync(tmp, { force: true }); }
      catch (e) { cleanupError = failure(`清理临时输出失败：${e.message}`); }
    }
  });

  async function abort() {
    if (published) return;
    controller.abort(failure('输出已中止'));
    await reaped;
    if (cleanupError) throw cleanupError;
  }

  async function write(chunk) {
    if (finishing) throw failure('输出正在结束');
    try {
      signal.throwIfAborted();
      const writable = stream.write(chunk);
      hasInput ||= (typeof chunk === 'string' ? chunk.length : chunk.byteLength) > 0;
      if (!writable) {
        drain ??= once(stream, 'drain', { signal }).finally(() => { drain = undefined; });
        await drain;
      }
      signal.throwIfAborted();
    } catch (e) {
      controller.abort(failure(`写入失败：${e.message}`));
      await abort();
      throw signal.reason;
    }
  }

  async function publish() {
    try {
      if (drain) await drain;
      if (!signal.aborted) stream.end();
      await reaped;
      signal.throwIfAborted();
      // FFmpeg 在零帧时也可能成功写出容器头，须在回收进程后、替换成品前检查。
      if (encoder && (!hasInput || statSync(tmp).size === 0)) throw new Error('编码输入或产物为空');
      renameSync(tmp, target);
      published = true;
    } catch (e) {
      await reaped;
      rmSync(tmp, { force: true });
      throw signal.reason ?? failure(`发布输出失败：${e.message}`);
    }
  }

  return { write, finish: () => (finishing ??= publish()), abort };
}

export function openFileSink({ path }) {
  return atomicSink(path);
}

/** args 包含输入 pipe:0 和编码参数，输出文件名由 sink 追加。 */
export function openEncoderSink({ path, args, bin = tools().ffmpeg, timeoutMs, expectedFrames }) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw bad('编码输出端需要字符串参数数组 args');
  if (expectedFrames !== undefined && (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1)) throw bad('expectedFrames 须为正整数');
  return atomicSink(path, { bin, args, timeoutMs, expectedFrames });
}

export { openFileSink as openSink, openEncoderSink as startEncoderSink };
