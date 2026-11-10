// tests/ci 的测试工具：在临时目录里搭一个小仓库（夹具在测试运行时生成，不入库，免得故意写坏的文件被 lint、语法检查扫到），
// 以及用子进程跑仓库里的命令并解析 --json 信封。不是测试文件（文件名不以 .test.mjs 结尾），run-tests 不会把它当测试跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePython } from '../../tools/run-tests.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RUN_TESTS = path.join(REPO, 'tools/run-tests.mjs');
export const CHECK_ALL = path.join(REPO, 'tools/check-all.mjs');
export const WIN = process.platform === 'win32';

// files: { '相对路径': 内容 }；返回临时仓库根（真实路径）与清理函数
export function makeRepo(files, { git = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-ci-')));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  if (git) {
    const g = (...a) => spawnSync('git', ['-C', root, ...a], { stdio: 'ignore' });
    g('init', '-q'); g('add', '-A');
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// 跑一个 Node 脚本，返回 { code, signal, stdout, stderr, json, ms }
export function runNode(script, args = [], { cwd = REPO, env = {}, timeoutMs = 120000 } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, GITHUB_ACTIONS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* 不是 JSON 模式 */ }
      resolve({ code, signal, stdout, stderr, json, ms: Date.now() - t0 });
    });
  });
}

let py;
export const python = () => (py === undefined ? (py = resolvePython(REPO)) : py);

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(fn, ms = 20000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
  return null;
}
