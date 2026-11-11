// tests/render 共用的工具：跑渲染脚本并等它退出（超时就杀整组判失败）、记下它的所有子孙进程以便事后确认没有残留、
// 跳过条件（没有 FFmpeg / 浏览器）、临时目录、迷你仓库（把 engine/render 复制到临时目录，影片放进去，不碰本仓库）。
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FIX = 'tests/render/fixtures';
export const posix = process.platform !== 'win32';
const has = cmd => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
const browserOk = (() => { try { return Boolean(process.env.BEIMING_CHROME) || existsSync(chromium.executablePath()); } catch { return false; } })();
/** 整组跳过的原因（false = 不跳过） */
export const skip = !has('ffmpeg') || !has('ffprobe') ? '没有 FFmpeg / ffprobe' : !browserOk ? '没有 Playwright 浏览器（npm run setup）' : false;

export const tmp = (prefix = 'beiming-render-') => mkdtempSync(join(tmpdir(), prefix));
export const segs = dir => (existsSync(dir) ? readdirSync(dir).filter(n => n.startsWith('.segs-') || n.endsWith('.lock') || n.includes('.partial')) : []);

function descendants(pid) {
  const out = [];
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    let kids = [];
    try { kids = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch {}
    for (const k of kids) { out.push(k); stack.push(k); }
  }
  return out;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * 跑一个 node 脚本；env 默认带 BEIMING_GPU=software-ok（CI 没有 GPU）。返回 { code, signal, log, stdout, stderr, ms, leftovers }。
 * leftovers：运行期间出现过、退出 3 秒后仍活着的子孙进程（POSIX 上才统计）。
 */
export function run(script, args, { env = {}, timeout = 30000, onStart, cwd = ROOT } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, BEIMING_GPU: 'software-ok', ...env }, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    const seen = new Set();
    const poll = posix ? setInterval(() => { for (const k of descendants(p.pid)) seen.add(k); }, 100) : null;
    const timer = setTimeout(() => { try { process.kill(posix ? -p.pid : p.pid, 'SIGKILL'); } catch {} }, timeout);
    onStart?.(p, () => descendants(p.pid));
    p.on('exit', async (code, signal) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      const ms = Date.now() - t0;
      let leftovers = [];
      for (let i = 0; i < 30; i++) { leftovers = [...seen].filter(alive); if (!leftovers.length) break; await new Promise(r => setTimeout(r, 100)); }
      for (const k of leftovers) { try { process.kill(k, 'SIGKILL'); } catch {} }
      resolve({ code, signal, stdout, stderr, log: stdout + stderr, ms, leftovers });
    });
  });
}

export const probe = (file, entries) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', entries,
  '-of', 'default=nw=1', file], { encoding: 'utf8' });
export const frames = file => Number(/nb_read_packets=(\d+)/.exec(probe(file, 'stream=nb_read_packets'))?.[1]);
export const framemd5 = file => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8' })
  .split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim());

/** 渲染器运行要用到的仓库目录（迷你仓库照这份清单复制）：渲染器自身、命令约定库、FFmpeg 定位、AIGC 标识 */
export const RENDERER_DIRS = ['engine/render', 'tools/lib', 'tools/env/lib', 'tools/compliance/lib'];

/**
 * 迷你仓库：<临时>/repo/ 下复制 RENDERER_DIRS + node_modules（链接到本仓库的）+ films/<名字>（复制夹具）。
 * 改夹具、建链接、写 out/ 都在临时目录里，不碰本仓库。返回 { base, repo, film, script(name) }。
 */
export function miniRepo(fixture, name = 'film') {
  const base = tmp('beiming-mini-');
  const repo = join(base, 'repo');
  for (const d of RENDERER_DIRS) cpSync(join(ROOT, d), join(repo, d), { recursive: true, filter: s => !/[\\/](node_modules|__pycache__)$/.test(s) });
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'junction');
  const film = join(repo, 'films', name);
  if (fixture) cpSync(join(ROOT, FIX, fixture), film, { recursive: true });
  return { base, repo, film, script: n => join(repo, 'engine/render', n), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
