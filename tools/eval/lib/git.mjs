// git 封装：被测检出的状态、与基线的差异、新提交、暂存区。
//
// 一律用参数数组调用（不经 shell），加 -c core.quotepath=false 让中文路径原样输出，用 -z 解析。
// 接口：git(args, { cwd, allowFail })、gitAvailable()、headCommit(cwd)、statusEntries(cwd)、
//       ignoredEntries(cwd)、diffNames(cwd, base)、commitsSince(cwd, base)、stagedNames(cwd)、
//       resolveCommit(repo, ref)

import { spawnSync } from 'node:child_process';
import { EvalError, EXIT } from './cli.mjs';

export function git(args, { cwd, allowFail = false, input } = {}) {
  const res = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, input, windowsHide: true,
  });
  if (res.error) {
    throw new EvalError('git-missing', `无法运行 git（${res.error.code ?? res.error.message}）`, { exitCode: EXIT.ENV, hint: '安装 git 并确认它在 PATH 里' });
  }
  if (res.status !== 0 && !allowFail) {
    throw new EvalError('git-failed', `git ${args.join(' ')} 失败（exit ${res.status}）：${(res.stderr || '').trim().split('\n')[0]}`, { exitCode: EXIT.RUN, hint: '检查该目录是否是 git 检出、提交号是否存在' });
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function gitAvailable() {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  return !res.error && res.status === 0;
}

export const headCommit = cwd => git(['rev-parse', 'HEAD'], { cwd }).stdout.trim();

export function resolveCommit(repo, ref) {
  const res = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo, allowFail: true });
  if (res.status !== 0) {
    throw new EvalError('commit-unknown', `在 ${repo} 里找不到提交 ${ref}`, { exitCode: EXIT.USAGE, hint: '用 git log 确认提交号，或先 git fetch' });
  }
  return res.stdout.trim();
}

function parsePorcelainZ(text) {
  const parts = text.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (!item) continue;
    const code = item.slice(0, 2);
    const p = item.slice(3);
    const entry = { code, path: p };
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') entry.origPath = parts[++i];
    entries.push(entry);
  }
  return entries;
}

/** 已跟踪改动与未跟踪文件（展开到文件），不含被忽略的。 */
export const statusEntries = cwd => parsePorcelainZ(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd }).stdout);

/** 被忽略的条目：整目录被忽略时只列目录（以 / 结尾），单个文件被忽略时列文件。 */
export function ignoredEntries(cwd) {
  return parsePorcelainZ(git(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all'], { cwd }).stdout)
    .filter(e => e.code === '!!')
    .map(e => ({ path: e.path, isDir: e.path.endsWith('/') }));
}

/** 相对基线提交（含已提交与未提交的改动，不含未跟踪文件）改了哪些路径。 */
export function diffNames(cwd, base) {
  const out = git(['diff', '--name-only', '-z', '--no-renames', base], { cwd }).stdout;
  return out.split('\0').filter(Boolean);
}

/** 基线之后的新提交（被测会话里做的提交）。 */
export function commitsSince(cwd, base) {
  const res = git(['log', '--format=%H%x09%s', `${base}..HEAD`], { cwd, allowFail: true });
  if (res.status !== 0) return [];
  return res.stdout.split('\n').filter(Boolean).map(line => {
    const [sha, ...rest] = line.split('\t');
    const files = git(['show', '--name-only', '--format=', '-z', sha], { cwd }).stdout.split('\0').filter(Boolean);
    return { sha, subject: rest.join('\t'), files };
  });
}

/** 暂存区里的路径。 */
export const stagedNames = cwd => git(['diff', '--cached', '--name-only', '-z', '--no-renames'], { cwd }).stdout.split('\0').filter(Boolean);
