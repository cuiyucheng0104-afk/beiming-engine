// 北冥 QA · 外部进程：调用 ffmpeg / ffprobe（参数数组、不经 shell，三平台一致），带超时、输出上限、子进程登记，
// 以及 FFmpeg 版本与滤镜的环境自检（D09：FFmpeg ≥ 7，需要 ebur128 等滤镜）。
//
//   tool('ffmpeg' | 'ffprobe')            可执行文件：环境变量 FFMPEG / FFPROBE 优先，否则在 PATH 里找
//   run(cmd, args, { timeoutMs, onStdout, maxStdout, stdin })   → { code, stdout: Buffer, stderr: string }
//        onStdout(chunk) 给了就流式交出 stdout、不在内存里攒；超时抛 QaError('timeout', exit 124)
//   requireFfmpeg(filters)                 版本与滤镜不满足时抛 QaError（exit 3），说明缺什么、怎么装
import { spawn } from 'node:child_process';
import { QaError, EXIT, trackChild } from './cli-kit.mjs';

const ENV = { ffmpeg: 'FFMPEG', ffprobe: 'FFPROBE' };
export const tool = name => (ENV[name] && process.env[ENV[name]]) || name;

const INSTALL_HINT = '安装 FFmpeg 7 或更新的版本（需带 libx264、aac、ebur128、loudnorm）：macOS 用 brew install ffmpeg，'
  + 'Windows 用 winget install Gyan.FFmpeg，Linux 用发行版的 ffmpeg 包；装在非标准位置时设环境变量 FFMPEG / FFPROBE 指向可执行文件';

export function run(cmd, args, { timeoutMs = 10 * 60 * 1000, onStdout = null, maxStdout = 512 << 20, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    let cp;
    try {
      cp = spawn(cmd, args, { stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
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
    cp.on('close', (code, signal) => {
      if (overflow) {
        done(reject, new QaError('runtime', `${cmd} 的输出超过 ${maxStdout >> 20} MB 上限`, { exitCode: EXIT.RUNTIME }));
        return;
      }
      done(resolve, { code: code ?? (signal ? 128 : 1), signal, stdout: Buffer.concat(out), stderr: err });
    });
    if (stdin != null) { cp.stdin.on('error', () => {}); cp.stdin.end(stdin); }
  });
}

// 最后几行有用的 stderr（给错误信息用，避免把整页日志塞进报告）
export const tail = (s, n = 6) => String(s || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-n).join(' | ');

let info = null;
export async function ffmpegInfo() {
  if (info) return info;
  const v = await run(tool('ffmpeg'), ['-hide_banner', '-version'], { timeoutMs: 30000 });
  if (v.code !== 0) throw new QaError('env.ffmpeg-broken', `ffmpeg -version 失败：${tail(v.stderr)}`, { hint: INSTALL_HINT, exitCode: EXIT.ENV });
  const first = v.stdout.toString('utf8').split(/\r?\n/)[0] || '';
  const m = /version\s+n?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(first);
  const version = m ? `${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}` : (first.split(/\s+/)[2] || 'unknown');
  const major = m ? +m[1] : null;
  const f = await run(tool('ffmpeg'), ['-hide_banner', '-filters'], { timeoutMs: 30000 });
  const filters = new Set();
  for (const line of f.stdout.toString('utf8').split(/\r?\n/)) {
    const mm = /^\s*[A-Z.|]{2,3}\s+(\w+)\s/.exec(line);
    if (mm) filters.add(mm[1]);
  }
  const p = await run(tool('ffprobe'), ['-hide_banner', '-version'], { timeoutMs: 30000 });
  if (p.code !== 0) throw new QaError('env.ffprobe-broken', `ffprobe -version 失败：${tail(p.stderr)}`, { hint: INSTALL_HINT, exitCode: EXIT.ENV });
  info = { version, major, filters, banner: first };
  return info;
}

export async function requireFfmpeg(needed = []) {
  const i = await ffmpegInfo();
  const warnings = [];
  if (i.major === null) warnings.push(`无法从「${i.banner}」读出 FFmpeg 主版本号（可能是夜间构建），按可用处理；D09 要求 ≥ 7`);
  else if (i.major < 7) {
    throw new QaError('env.ffmpeg-old', `FFmpeg ${i.version} 太旧，D09 要求 ≥ 7`, { hint: INSTALL_HINT, exitCode: EXIT.ENV });
  }
  const missing = needed.filter(n => !i.filters.has(n));
  if (missing.length) {
    throw new QaError('env.ffmpeg-filters', `当前 FFmpeg（${i.version}）缺少滤镜：${missing.join('、')}`, { hint: INSTALL_HINT, exitCode: EXIT.ENV });
  }
  return { ...i, warnings };
}
