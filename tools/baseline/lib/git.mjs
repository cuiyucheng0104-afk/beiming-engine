// 北冥仓库 · 基线工具用到的 git 操作：解析提交、查像素相关路径是否有未提交改动、把旧提交的页面导出成临时快照。
//
//   PIXEL_PATHS                 会改变画面的路径（引擎、样片、自测页、素材、字体、页面入口、A / C 模版、C 模版运行时读的片名字体）。
//                                 模版在运行时按 ../../<路径> 读到的仓库文件都必须在这里，否则 --against 等现渲旧提交的快照里缺文件
//                                 （tests/golden/units.test.mjs 扫两个模版核对）
//   resolveCommit(root, ref)    → 完整 sha；不存在时抛 CliError（exit 2）
//   commitExists(root, sha)     → 本仓库里有没有这个提交（浅克隆、CI 的合并提交可能没有）
//   pixelTreeDigest(root, sha, paths)  → 提交里这些路径的内容摘要（git ls-tree 的模式、对象号、路径取 sha256）。
//                                 两个提交在这些路径上逐字节相同 ⇔ 摘要相同；核对时不需要原提交在本地（CI 的合并提交合入后就找不到了）
//   headCommit(root)            → { sha, short }
//   dirtyPixelPaths(root)       → 有未提交改动（含未跟踪文件）的像素相关路径列表
//   exportPaths(root, sha, paths, dest)   把提交 sha 里这些路径的文件原样写到 dest（git ls-tree + cat-file，只读仓库）；
//                                 返回写了几个文件、多少字节。按 blob 原字节写，不做换行转换，三平台得到同样的页面
//   withSnapshot(root, sha, { workDir, log, paths }, fn)   在临时目录导出 sha 的像素相关路径（再加 paths），
//                                 把 node_modules 链接到主工作树，跑 fn(dir)，结束（含出错、收到信号）一定删除。
//                                 不建 git worktree、不改仓库的任何状态：只导出渲染要用的约 60 MB，而不是整个检出
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CliError, EXIT, onCleanup, offCleanup } from './cli.mjs';

export const PIXEL_PATHS = ['engine', 'src', 'lab', 'assets', 'fonts', 'index.html',
  'routes/a-webgl/template', 'routes/c-style/template', 'routes/c-style/fonts', 'tests/golden/fixtures', 'tools/baseline/sets.json'];

export function git(args, { cwd, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  } catch (e) {
    if (allowFail) return null;
    if (e.code === 'ENOENT') throw new CliError('env.no-git', '找不到 git 命令', { hint: '安装 git 并放进 PATH', exitCode: EXIT.ENV });
    throw new CliError('failure.git', `git ${args.join(' ')} 失败：${String(e.stderr || e.message).trim().split('\n')[0]}`, { exitCode: EXIT.FAIL });
  }
}

export function isGitRepo(root) { return git(['rev-parse', '--is-inside-work-tree'], { cwd: root, allowFail: true }) === 'true'; }

export function resolveCommit(root, ref) {
  const sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, allowFail: true });
  if (!sha) throw new CliError('usage.bad-commit', `找不到提交 ${ref}`, { hint: '用 git log --oneline 查一个存在的提交（可写短 sha、分支或标签）', exitCode: EXIT.USAGE });
  return sha;
}
export function commitExists(root, sha) {
  return !!sha && git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: root, allowFail: true }) != null;
}
export function pixelTreeDigest(root, sha, paths) {
  const want = [...new Set(paths)].sort();
  let out;
  try {
    out = execFileSync('git', ['ls-tree', '-r', '-z', sha, '--', ...want], { cwd: root, maxBuffer: 64 << 20, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new CliError('failure.git', `git ls-tree ${sha.slice(0, 12)} 失败：${String(e.stderr || e.message).trim().split('\n')[0]}`, { exitCode: EXIT.FAIL });
  }
  return crypto.createHash('sha256').update(want.join('\n') + '\0').update(out).digest('hex');
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
    throw new CliError('env.no-node-modules', `主工作树没有 node_modules：${src}`, { hint: '在仓库根目录先跑 npm ci（或 npm run setup）', exitCode: EXIT.ENV });
  }
  fs.symlinkSync(fs.realpathSync(src), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

// git ls-tree -r -z -l：<mode> <type> <object> <size>\t<path>
function listBlobs(root, sha, paths) {
  const out = execFileSync('git', ['ls-tree', '-r', '-z', '-l', sha, '--', ...paths], { cwd: root, maxBuffer: 64 << 20, windowsHide: true });
  const blobs = [];
  for (const rec of out.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, obj, size] = rec.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob') continue;   // 子模块（commit）不导出
    blobs.push({ mode, obj, size: Number(size), path: rec.slice(tab + 1) });
  }
  return blobs;
}

export function exportPaths(root, sha, paths, dest) {
  const blobs = listBlobs(root, sha, paths);
  let files = 0, bytes = 0;
  // 分批走 git cat-file --batch（每批不超过 64 MiB），不把整棵树读进内存
  for (let i = 0; i < blobs.length;) {
    const batch = [];
    let sum = 0;
    while (i < blobs.length && (batch.length === 0 || sum + blobs[i].size <= (64 << 20))) { sum += blobs[i].size; batch.push(blobs[i++]); }
    const out = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root, input: batch.map(b => b.obj).join('\n') + '\n', maxBuffer: sum + batch.length * 128 + (1 << 20), windowsHide: true,
    });
    let off = 0;
    for (const b of batch) {
      const nl = out.indexOf(10, off);
      const head = out.toString('utf8', off, nl).split(' ');
      if (head[0] !== b.obj || head[1] !== 'blob') throw new CliError('failure.git', `git cat-file 读 ${b.path} 时返回了意外的内容：${head.join(' ')}`, { exitCode: EXIT.FAIL });
      const size = Number(head[2]);
      const data = out.subarray(nl + 1, nl + 1 + size);
      off = nl + 1 + size + 1;
      if (b.mode === '120000') continue;   // 符号链接：页面不该依赖它，跳过
      const file = path.join(dest, ...b.path.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      files++; bytes += size;
    }
  }
  return { files, bytes };
}

export async function withSnapshot(root, sha, { workDir, log = () => {}, paths = [] } = {}, fn) {
  const base = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-golden-'));
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(fs.realpathSync(base), `${sha.slice(0, 12)}-${process.pid}`);
  const remove = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!workDir) fs.rmSync(base, { recursive: true, force: true });
  };
  remove.sync = remove;
  onCleanup(remove);
  try {
    const want = [...new Set([...PIXEL_PATHS.filter(p => p !== 'tools/baseline/sets.json'), ...paths])];
    const t0 = Date.now();
    const { files, bytes } = exportPaths(root, sha, want, dir);
    if (!files) throw new CliError('contract.empty-snapshot', `提交 ${sha.slice(0, 12)} 里没有任何像素相关文件`, { hint: '换一个包含 engine/、src/ 的提交', exitCode: EXIT.CONTRACT });
    log(`导出 ${sha.slice(0, 12)} 的页面快照：${files} 个文件，${(bytes / 1048576).toFixed(1)} MiB，${((Date.now() - t0) / 1000).toFixed(1)} 秒 → ${dir}`);
    linkNodeModules(root, dir);
    return await fn(dir);
  } finally {
    offCleanup(remove);
    remove();
    log(`已删除快照 ${sha.slice(0, 12)}`);
  }
}
