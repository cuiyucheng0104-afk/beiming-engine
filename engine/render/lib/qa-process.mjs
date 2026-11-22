// 渲染与离线 QA 的媒体子进程共用超时、输出上限与清理登记。
import { spawn } from 'node:child_process';
import { QaError, EXIT } from './qa-error.mjs';

const children = new Set();
export function trackChild(cp) {
  children.add(cp);
  cp.once('exit', () => children.delete(cp));
  cp.once('error', () => children.delete(cp));
  return cp;
}
export function killChildren() {
  for (const cp of children) { try { cp.kill('SIGKILL'); } catch { /* 已退出 */ } }
  children.clear();
}

const ENV = { ffmpeg: 'FFMPEG', ffprobe: 'FFPROBE' };
export const tool = name => (ENV[name] && process.env[ENV[name]]) || name;

export const INSTALL_HINT = '安装 FFmpeg 7 或更新的版本（需带 libx264、aac、ebur128、loudnorm）：macOS 用 brew install ffmpeg，'
  + 'Windows 用 winget install Gyan.FFmpeg，Linux 用发行版的 ffmpeg 包；装在非标准位置时设环境变量 FFMPEG / FFPROBE 指向可执行文件';

export function run(cmd, args, { timeoutMs = 10 * 60 * 1000, onStdout = null, maxStdout = 512 << 20, stdin = null, signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let cp;
    try {
      cp = spawn(cmd, args, { stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, signal, killSignal: 'SIGKILL' });
    } catch (e) {
      reject(new QaError('env.tool-missing', `无法启动 ${cmd}：${e.message}`, { hint: INSTALL_HINT, exitCode: EXIT.ENV }));
      return;
    }
    trackChild(cp);
    const out = [];
    let outLen = 0, err = '', settled = false, overflow = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      try { cp.kill('SIGKILL'); } catch { /* 已退出 */ }
      done(reject, new QaError('timeout', `${cmd} 超过 ${Math.round(timeoutMs / 1000)} 秒没有结束，已终止`,
        { hint: '文件很长时用 --timeout 放宽（单位秒）；否则检查输入是否损坏', exitCode: EXIT.TIMEOUT }));
    }, timeoutMs);
    cp.on('error', e => {
      // 取消通知早于系统回收进程；等 close 再把渲染中断原因交给调用方。
      if (e.code === 'ABORT_ERR' && signal?.aborted) { clearTimeout(timer); return; }
      const missing = e.code === 'ENOENT';
      done(reject, new QaError(missing ? 'env.tool-missing' : 'runtime', missing ? `找不到 ${cmd}` : `${cmd} 启动失败：${e.message}`,
        { hint: missing ? INSTALL_HINT : null, exitCode: missing ? EXIT.ENV : EXIT.RUNTIME }));
    });
    cp.stdout.on('data', chunk => {
      if (onStdout) {
        try { onStdout(chunk); } catch (e) { try { cp.kill('SIGKILL'); } catch { /* 已退出 */ } done(reject, e); }
        return;
      }
      if (outLen + chunk.length > maxStdout) { overflow = true; return; }
      out.push(chunk); outLen += chunk.length;
    });
    cp.stderr.on('data', chunk => {
      err += chunk.toString('utf8');
      if (err.length > 8 << 20) err = err.slice(-(4 << 20));
    });
    cp.on('close', (code, exitSignal) => {
      if (signal?.aborted) { done(reject, signal.reason); return; }
      if (overflow) {
        done(reject, new QaError('runtime', `${cmd} 的输出超过 ${Math.round(maxStdout / 2 ** 20)} MB 上限`, { exitCode: EXIT.RUNTIME }));
        return;
      }
      done(resolve, { code: code ?? (exitSignal ? 128 : 1), signal: exitSignal, stdout: Buffer.concat(out), stderr: err });
    });
    if (stdin != null) { cp.stdin.on('error', () => {}); cp.stdin.end(stdin); }
  });
}

// 最后几行有用的 stderr（给错误信息用，避免把整页日志塞进报告）
export const tail = (s, n = 6) => String(s || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-n).join(' | ');
