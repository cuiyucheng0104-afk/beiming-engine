// tests/film 共用的小工具：在仓库根跑出片命令、建临时作品（放仓库外，films/ 里只留链接）、比对目录前后。
//   runCli(args, { env, input }) → { code, stdout, stderr, json }   json = stdout 解析出的单个对象（--json 时）
//   makeWork(route, { title }) → { name, rel, dir, real, cleanup() }
//     A / C：作品本体放在 FILM_TEST_ROOT（默认系统临时目录下的 beiming-film-tests-<pid>），films/<名> 是指向它的链接
//            （Windows 用目录联接，不需要管理员权限）；B：原生运行时按真实路径打包，作品必须真实位于 films/ 下，结束时删除
//     FILM_TEST_KEEP=1 时不删作品本体，方便事后看产物
//   snapshotDir(dir) → Set(名字)   newEntries(before, dir) → 新出现的名字
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLI = path.join(ROOT, 'tools/film/cli.mjs');
export const QA_STUB = path.join(ROOT, 'tests/film/fixtures/qa-stub.mjs');
export const TEST_ROOT = path.resolve(process.env.FILM_TEST_ROOT || path.join(os.tmpdir(), `beiming-film-tests-${process.pid}`));

export function runCli(args, { env = {}, timeout = 600000 } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout, env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
  let json = null;
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  if (lines.length === 1) { try { json = JSON.parse(lines[0]); } catch { /* 不是 JSON */ } }
  return { code: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', json, lines };
}

let seq = 0;
export function makeWork(route, { title = '自检短片' } = {}) {
  const name = `p06t-${route}-${process.pid}-${++seq}`;
  const rel = `films/${name}`;
  const inRepo = path.join(ROOT, rel);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/new-film.mjs'), route, name, '--title', title], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`new-film 失败：${r.stderr || r.stdout}`);
  let real = inRepo;
  if (route !== 'b') {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    real = path.join(TEST_ROOT, name);
    fs.renameSync(inRepo, real);
    fs.symlinkSync(real, inRepo, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return {
    name, rel, dir: inRepo, real,
    cleanup() {
      if (route !== 'b') {
        removeLink(inRepo);
        if (!process.env.FILM_TEST_KEEP) fs.rmSync(real, { recursive: true, force: true });
      } else if (process.env.FILM_TEST_KEEP) {
        fs.mkdirSync(TEST_ROOT, { recursive: true });
        fs.cpSync(inRepo, path.join(TEST_ROOT, name), { recursive: true });
        fs.rmSync(inRepo, { recursive: true, force: true });
      } else fs.rmSync(inRepo, { recursive: true, force: true });
    },
  };
}

// 删链接本身（不碰链接指向的目录）：POSIX 符号链接用 unlink，Windows 目录联接用 rmdir
export function removeLink(p) {
  try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') { try { fs.rmdirSync(p); } catch { /* 已不在 */ } } }
}

// 测完收尾：删掉各命令专用的空 TMPDIR（tmp-*），TEST_ROOT 空了就一并删；FILM_TEST_KEEP=1 时全部保留
export function cleanupTestRoot() {
  if (process.env.FILM_TEST_KEEP || !fs.existsSync(TEST_ROOT)) return;
  for (const n of fs.readdirSync(TEST_ROOT)) if (n.startsWith('tmp-')) fs.rmSync(path.join(TEST_ROOT, n), { recursive: true, force: true });
  try { fs.rmdirSync(TEST_ROOT); } catch { /* 还有别的东西（用户指定的目录）就留着 */ }
}

export const snapshotDir = dir => new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
export const newEntries = (before, dir) => [...snapshotDir(dir)].filter(n => !before.has(n));

// git status（含未跟踪文件），去掉指定前缀（测试作品自己的链接或目录）
export function gitStatus(excludePrefixes = []) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean).filter(l => !excludePrefixes.some(p => l.slice(3).startsWith(p)));
}

export const hasTool = cmd => spawnSync(cmd, ['-version'], { encoding: 'utf8' }).status === 0;
