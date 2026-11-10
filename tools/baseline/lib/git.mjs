// 北冥仓库 · 基线工具用到的 git 操作：解析提交、查像素相关路径是否有未提交改动、为旧提交开临时工作树。
//
//   PIXEL_PATHS                 会改变画面的路径（引擎、样片、自测页、素材、字体、页面入口、A / C 模版）
//   resolveCommit(root, ref)    → 完整 sha；不存在时抛 CliError（exit 2）
//   headCommit(root)            → { sha, short }
//   dirtyPixelPaths(root)       → 有未提交改动（含未跟踪文件）的像素相关路径列表
//   withWorktree(root, sha, { workDir, log }, fn)   在临时目录检出 sha（git worktree add --detach），
//                                 把 node_modules 链接到主工作树，跑 fn(dir)，结束（含出错、收到信号）一定删除
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CliError, EXIT, onCleanup, offCleanup } from './cli.mjs';

export const PIXEL_PATHS = ['engine', 'src', 'lab', 'assets', 'fonts', 'index.html',
  'routes/a-webgl/template', 'routes/c-style/template', 'tests/golden/fixtures', 'tools/baseline/sets.json'];

export function git(args, { cwd, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  } catch (e) {
    if (allowFail) return null;
    if (e.code === 'ENOENT') throw new CliError('no-git', '找不到 git 命令', { hint: '安装 git 并放进 PATH', exitCode: EXIT.ENV });
    throw new CliError('git-failed', `git ${args.join(' ')} 失败：${String(e.stderr || e.message).trim().split('\n')[0]}`, { exitCode: EXIT.FAIL });
  }
}

export function isGitRepo(root) { return git(['rev-parse', '--is-inside-work-tree'], { cwd: root, allowFail: true }) === 'true'; }

export function resolveCommit(root, ref) {
  const sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, allowFail: true });
  if (!sha) throw new CliError('bad-commit', `找不到提交 ${ref}`, { hint: '用 git log --oneline 查一个存在的提交（可写短 sha、分支或标签）', exitCode: EXIT.USAGE });
  return sha;
}
export function headCommit(root) {
  const sha = git(['rev-parse', 'HEAD'], { cwd: root, allowFail: true });
  return sha ? { sha, short: sha.slice(0, 7) } : { sha: null, short: 'nogit' };
}
export function dirtyPixelPaths(root) {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...PIXEL_PATHS], { cwd: root, allowFail: true });
  if (out == null) return [];
  return out.split('\0').filter(Boolean).map(l => l.slice(3)).filter(Boolean);
}

// 运行编号：YYYYMMDD-HHMMSS-<短提交>[-dirty]（附录 C4）
export function runId(root) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const { short } = headCommit(root);
  const dirty = dirtyPixelPaths(root).length > 0;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${short}${dirty ? '-dirty' : ''}`;
}

function linkNodeModules(root, dir) {
  const src = path.join(root, 'node_modules');
  if (!fs.existsSync(src)) {
    throw new CliError('no-node-modules', `主工作树没有 node_modules：${src}`, { hint: '在仓库根目录先跑 npm ci（或 npm run setup）', exitCode: EXIT.ENV });
  }
  fs.symlinkSync(fs.realpathSync(src), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

export async function withWorktree(root, sha, { workDir, log = () => {} } = {}, fn) {
  const base = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-golden-'));
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(fs.realpathSync(base), `${sha.slice(0, 12)}-${process.pid}`);
  const remove = () => {
    git(['worktree', 'remove', '--force', dir], { cwd: root, allowFail: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'prune'], { cwd: root, allowFail: true });
    if (!workDir) fs.rmSync(base, { recursive: true, force: true });
  };
  remove.sync = remove;
  log(`检出 ${sha.slice(0, 12)} 到临时工作树 ${dir}`);
  git(['worktree', 'add', '--detach', '--quiet', dir, sha], { cwd: root });
  onCleanup(remove);
  try {
    linkNodeModules(root, dir);
    return await fn(dir);
  } finally {
    offCleanup(remove);
    remove();
    log(`已删除临时工作树 ${sha.slice(0, 12)}`);
  }
}
