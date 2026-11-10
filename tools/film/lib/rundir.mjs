// 北冥仓库 · 出片编排 · 运行目录、作品锁与 latest 指针（附录 C4）。
//   <outRoot> = films/<名>/out（《北冥》样片由 build.sh 指到 out/beiming）
//   <outRoot>/<run-id>/            一次运行的全部产物：master.mp4 web.mp4 player.html run.json qa/report.json contact.jpg …
//   <outRoot>/<run-id>/work/       中间件（video.mp4 等）；work/tmp/ 是子进程的 TMPDIR，运行结束整体删除
//   <outRoot>/<run-id>/logs/       每一步的完整输出
//   <outRoot>/latest               指针文件：最近一次成功的完整出片（build）的 run-id；不用符号链接（兼容 Windows）
//   <outRoot>/latest-<kind>        各类运行（stills、animatic、render）最近一次成功的 run-id
//   <outRoot>/cache/               步骤缓存（按输入哈希）
//   <outRoot>/.lock                作品锁：同一作品同一时间只允许一次运行（旧脚本写固定路径，并行会互相覆盖）→ 退出码 5
// run-id = UTC 的 YYYYMMDD-HHMMSS-<提交前 8 位>[-dirty]；不是 git 检出时写 nogit；同一秒重名时加 -2、-3。
// 作品锁的做法（锁里记 pid、持锁进程不在或锁超过 12 小时没刷新就接管、长任务定时刷新）参照
// cases/vendor/lemo-opuscar/core/render/video.mjs@bebbbe1a（MIT，LemoLab）的输出锁思路，代码为本仓库重写，另加了主机名判断。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, FilmError } from './exit.mjs';
import { gitInfo, rel } from './repo.mjs';

const pad = n => String(n).padStart(2, '0');
export function stamp(d = new Date()) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function newRunId(d = new Date()) {
  const g = gitInfo();
  return `${stamp(d)}-${g.short || 'nogit'}${g.dirty ? '-dirty' : ''}`;
}

export const RUN_ID_RE = /^\d{8}-\d{6}-(?:[0-9a-f]{8}|nogit)(?:-dirty)?(?:-\d+)?$/;

export function createRunDir(outRoot, d = new Date()) {
  fs.mkdirSync(outRoot, { recursive: true });
  const base = newRunId(d);
  for (let i = 1; i < 100; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    const dir = path.join(outRoot, id);
    try {
      fs.mkdirSync(dir);
      for (const sub of ['work', 'logs']) fs.mkdirSync(path.join(dir, sub));
      return { id, dir, work: path.join(dir, 'work'), logs: path.join(dir, 'logs'), tmp: path.join(dir, 'work', 'tmp') };
    } catch (e) {
      if (e.code !== 'EEXIST') throw new FilmError(EXIT.RUN, 'run-dir', `无法创建运行目录 ${rel(dir)}：${e.message}`, '检查磁盘空间与目录权限');
    }
  }
  throw new FilmError(EXIT.BUSY, 'run-id-exhausted', `同一秒内已有 99 个运行目录：${base}`, '稍后再试');
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const LOCK_MAX_AGE = 12 * 3600 * 1000;        // 锁超过这么久没刷新：pid 多半已被别的进程复用，当作过期
const LOCK_REFRESH = 10 * 60 * 1000;          // 持锁期间每 10 分钟刷新一次修改时间（长片渲染不会被误判过期）

// 作品锁：原子创建 .lock（wx）；同机且（持锁进程已不在，或锁超过 12 小时没刷新）→ 视为过期并接管（写进 warnings）
export function acquireLock(outRoot, info, warnings = []) {
  fs.mkdirSync(outRoot, { recursive: true });
  const f = path.join(outRoot, '.lock');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), ...info });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(f, body, { flag: 'wx' });
      let released = false;
      const timer = setInterval(() => { try { const n = new Date(); fs.utimesSync(f, n, n); } catch { /* 已不在 */ } }, LOCK_REFRESH);
      timer.unref();
      return {
        file: f,
        release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          try { const cur = JSON.parse(fs.readFileSync(f, 'utf8')); if (cur.pid === process.pid) fs.rmSync(f, { force: true }); } catch { /* 已不在 */ }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw new FilmError(EXIT.RUN, 'lock', `无法创建作品锁 ${rel(f)}：${e.message}`);
      let cur = null, age = 0;
      try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); age = Date.now() - fs.statSync(f).mtimeMs; } catch { /* 坏锁当作过期 */ }
      const sameHost = cur && cur.host === os.hostname();
      if (cur && (!sameHost || (alive(cur.pid) && age < LOCK_MAX_AGE))) {
        throw new FilmError(EXIT.BUSY, 'film-busy', `作品 ${rel(path.dirname(outRoot))} 正在被另一次运行占用（${cur.command || '?'}，pid ${cur.pid}，${sameHost ? '本机' : cur.host}，开始于 ${cur.startedAt}）`,
          sameHost ? '等它结束再跑；确认它已不在时删掉 .lock' : '另一台机器在用同一检出：换各自的检出目录');
      }
      warnings.push({ code: 'stale-lock', message: `接管过期的作品锁（pid ${cur?.pid ?? '?'} ${cur && age >= LOCK_MAX_AGE ? `超过 12 小时没刷新` : '已不在'}）` });
      fs.rmSync(f, { force: true });
    }
  }
  throw new FilmError(EXIT.BUSY, 'film-busy', `拿不到作品锁 ${rel(f)}`);
}

export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function setLatest(outRoot, kind, runId) {
  writeAtomic(path.join(outRoot, `latest-${kind}`), runId + '\n');
  if (kind === 'build') writeAtomic(path.join(outRoot, 'latest'), runId + '\n');
}

export function readLatest(outRoot, kind = 'build') {
  const f = path.join(outRoot, kind === 'build' ? 'latest' : `latest-${kind}`);
  try {
    const id = fs.readFileSync(f, 'utf8').trim();
    return id && fs.existsSync(path.join(outRoot, id, 'run.json')) ? id : null;
  } catch { return null; }
}

// 列出 outRoot 下全部运行（新的在前），读各自 run.json 的摘要
export function listRuns(outRoot) {
  if (!fs.existsSync(outRoot)) return [];
  const out = [];
  for (const e of fs.readdirSync(outRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !RUN_ID_RE.test(e.name)) continue;
    const f = path.join(outRoot, e.name, 'run.json');
    let j = null;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 坏的或运行中 */ }
    out.push({ id: e.name, dir: path.join(outRoot, e.name), run: j });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}
