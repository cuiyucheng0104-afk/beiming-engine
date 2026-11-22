// 北冥 QA · 外部进程：调用 ffmpeg / ffprobe（参数数组、不经 shell，三平台一致），带超时、输出上限、子进程登记，
// 以及 FFmpeg 版本与滤镜的环境自检（D09：FFmpeg ≥ 7，需要 ebur128 等滤镜）。
//
//   tool('ffmpeg' | 'ffprobe')            可执行文件：环境变量 FFMPEG / FFPROBE 优先，否则在 PATH 里找
//   run(cmd, args, { timeoutMs, onStdout, maxStdout, stdin })   → { code, stdout: Buffer, stderr: string }
//        onStdout(chunk) 给了就流式交出 stdout、不在内存里攒；超时抛 QaError('timeout', exit 124)
//   requireFfmpeg(filters)                 版本与滤镜不满足时抛 QaError（exit 3），说明缺什么、怎么装
import { QaError, EXIT } from './cli-kit.mjs';
import { run, tool, tail, INSTALL_HINT } from '../../../engine/render/lib/qa-process.mjs';
export { run, tool, tail };

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
