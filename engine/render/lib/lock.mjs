// 北冥引擎 · 输出锁：同一个输出文件同一时刻只允许一次渲染写（<输出>.lock）。
// 方法借鉴 cases/vendor/lemo-opuscar/core/render/video.mjs@bebbbe1（<out>.lock 记 pid、过期接管），这里是独立实现：
//   - 用 open(…, 'wx') 原子创建；锁里写 { pid, host, started, argv, nonce }，每 30 秒刷新一次修改时间（心跳）
//   - 已有锁：同一台机器上 pid 还活着且心跳在 5 分钟内 → RenderError 退出码 5（资源忙），提示换 --out 或等它结束；
//     pid 已不在、或心跳过期（进程卡死、pid 被别的进程复用）→ 视为残留：先原子改名再重建，两个进程同时接管也只有一个成功
//   - 释放时只删自己的锁（nonce 对得上才删），进程退出（含异常、信号）时自动释放
//   acquireLock(target, { argv }) → release()
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { RenderError, EXIT } from './cli.mjs';

const HEARTBEAT_MS = 30000, STALE_MS = 5 * 60 * 1000;
export const lockPath = target => `${target}.lock`;

export const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;   // kill(0) 会打到整个进程组，必须拦住
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const readLock = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const mtime = file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

export function acquireLock(target, { argv = process.argv.slice(1), now = Date.now } = {}) {
  const file = lockPath(target);
  const nonce = randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date(now()).toISOString(), argv, nonce });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return arm(file, nonce);
    } catch (e) {
      if (e.code !== 'EEXIST') throw new RenderError('lock-io', `建不了输出锁 ${file}：${e.message}`, { exitCode: EXIT.ENV, hint: '输出目录要可写' });
    }
    const other = readLock(file);
    const fresh = now() - mtime(file) < STALE_MS;
    const sameHost = other?.host === os.hostname();
    const owned = other && fresh && (sameHost ? alive(other.pid) : true);
    if (owned) {
      throw new RenderError('output-locked', `另一次渲染（pid ${other.pid}，${other.started} 开始）正在写 ${target}`, {
        exitCode: EXIT.BUSY,
        hint: `给这次渲染换一个 --out，或等它结束；确认没有渲染在跑（崩溃留下的锁）就删掉 ${file}`,
      });
    }
    // 残留的锁：原子改名后删掉，再重试创建（只有改名成功的进程有机会接管）
    const tomb = `${file}.stale-${process.pid}-${now()}`;
    try { fs.renameSync(file, tomb); fs.rmSync(tomb, { force: true }); } catch {}
  }
  throw new RenderError('output-locked', `输出锁 ${file} 争用太激烈，没能取得`, { exitCode: EXIT.BUSY, hint: '同一个 --out 只能有一次渲染' });
}

function arm(file, nonce) {
  const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(file, t, t); } catch {} }, HEARTBEAT_MS);
  beat.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    process.removeListener('exit', release);
    if (readLock(file)?.nonce === nonce) { try { fs.rmSync(file, { force: true }); } catch {} }
  };
  process.on('exit', release);
  return release;
}
