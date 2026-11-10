// 合规工具测试的公共件：临时 git 仓库、运行命令行、拼接敏感样例。
// 测试里的样例（假令牌、假路径、假地址）一律在运行时拼出来：源码里不出现完整形态，免得仓库自己的合规扫描扫到测试文件。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const j = (...parts) => parts.join('');
export const hasGit = spawnSync('git', ['--version']).status === 0;

// files：{ 相对路径: 内容(string|Buffer) }；commit 为真时 git init 并提交（作者用 example.com 地址）
export function mkRepo(files, { commit = true, prefix = 'beiming-comp-' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  if (commit) {
    git(dir, ['init', '-q']);
    git(dir, ['add', '--', ...Object.keys(files)]);
    git(dir, ['commit', '-q', '-m', 'fixture']);
  }
  return dir;
}

export function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
}

export const rm = dir => fs.rmSync(dir, { recursive: true, force: true });

export function runCli(script, args = [], { cwd = REPO, env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(REPO, script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// stdout 必须是且只是一个 JSON 对象（附录 C2）
export function parseEnvelope(stdout) {
  const text = stdout.trim();
  const obj = JSON.parse(text);
  if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) throw new Error('stdout 不是 JSON 对象');
  return obj;
}

// 记下仓库工作区状态，用来证明 --help 之类的调用没有副作用
export const worktreeState = dir => spawnSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout;
