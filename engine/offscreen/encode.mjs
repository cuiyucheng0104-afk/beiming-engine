// 北冥引擎 · 离屏出片 · FFmpeg 编码器：读回的 RGBA8 裸帧经管道交给 FFmpeg，编成有限范围 BT.709 yuv420p 的 H.264。
// 色彩换算与 x264 参数沿用页面渲染器（engine/render/lib/ffmpeg.mjs 的 COLOR.png、TAGS、x264Args），两条链路出的片标记一致。
//   encoderArgs({ width, height, fps, out, crf = 14, preset = 'medium' }) → string[]   FFmpeg 参数（不含 -y、-loglevel）
//   startEncoder(同上) → { write(pixels) → Promise<void>, finish() → Promise<void>, abort() → Promise<void> }
//     write：写一帧（Uint8Array 或 Buffer，width × height × 4 字节）；管道满时等它腾出来（背压）
//     finish：关上输入、等 FFmpeg 编完；abort：杀掉 FFmpeg、删掉输出
//     找不到 FFmpeg（没装、FFMPEG 指错）时抛 CliError('env.ffmpeg')（退出码 3）；启动后中途退出抛 CliError('failure.ffmpeg')（退出码 1，消息里带 FFmpeg 最后一行报错），并删掉输出，不挂住
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { COLOR, TAGS, x264Args, FFMPEG } from '../render/lib/ffmpeg.mjs';
import { CliError } from '../../tools/lib/cli.mjs';

export function encoderArgs({ width, height, fps, out, crf = 14, preset = 'medium' }) {
  return ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', '-',
    '-vf', COLOR.png, ...x264Args({ crf, preset }), ...TAGS, out];
}

const describe = r => (r.error ? `没能启动（${r.error.code ?? r.error.message}）` : r.signal ? `被信号 ${r.signal} 结束` : `退出码 ${r.code}`);
// 机器上没装 FFmpeg（或 FFMPEG 指错了）是环境问题，退出码 3；CI 的 windows-paths 任务就没有 FFmpeg
const noFfmpeg = (bin, error) => new CliError('env.ffmpeg', `FFmpeg 没能启动（${error.code ?? error.message}）：${bin}`, {
  hint: '装带 libx264 的 FFmpeg（npm run setup，或见 docs/ENVIRONMENT.md）；FFMPEG 环境变量可指定可执行文件',
  cause: error,
});

export function startEncoder(opts) {
  const { out } = opts;
  const bin = FFMPEG();
  let ff;
  try {
    ff = spawn(bin, ['-y', '-loglevel', 'error', ...encoderArgs(opts)], { stdio: ['pipe', 'ignore', 'pipe'] });
  } catch (e) { throw noFfmpeg(bin, e); }
  let tail = '';
  ff.stderr.setEncoding('utf8');
  ff.stderr.on('data', d => { tail = (tail + d).slice(-2000); });
  const exited = new Promise(r => { ff.once('close', (code, signal) => r({ code, signal })); ff.once('error', error => r({ error })); });
  ff.stdin.on('error', () => {});   // 中途退出时的 EPIPE：由 exited 报告
  const removeOut = () => { try { fs.rmSync(out, { force: true }); } catch { /* 删不掉也不掩盖原来的错误 */ } };
  const failure = async () => {
    const r = await exited;
    removeOut();
    if (r.error) return noFfmpeg(bin, r.error);
    const last = tail.trim().split('\n').at(-1);
    return new CliError('failure.ffmpeg', `FFmpeg 编码 ${out} 时${describe(r)}${last ? `：${last}` : ''}`, {
      hint: '运行 ffmpeg -version 确认可用（要带 libx264）；常见原因还有磁盘满、输出目录不可写',
    });
  };
  const gone = () => ff.exitCode !== null || ff.signalCode !== null || ff.stdin.destroyed || !ff.stdin.writable;
  return {
    async write(px) {
      const buf = Buffer.isBuffer(px) ? px : Buffer.from(px.buffer, px.byteOffset, px.byteLength);
      if (gone()) throw await failure();
      if (ff.stdin.write(buf)) return;
      let onDrain;
      const why = await Promise.race([new Promise(r => { onDrain = () => r('drain'); ff.stdin.once('drain', onDrain); }), exited.then(() => 'exit')]);
      ff.stdin.off('drain', onDrain);
      if (why === 'exit') throw await failure();
    },
    async finish() {
      ff.stdin.end();
      const r = await exited;
      if (r.error || r.code !== 0) throw await failure();
    },
    async abort() {
      try { ff.stdin.destroy(); } catch { /* 已关 */ }
      try { ff.kill('SIGKILL'); } catch { /* 已退出 */ }
      await exited;
      removeOut();
    },
  };
}
