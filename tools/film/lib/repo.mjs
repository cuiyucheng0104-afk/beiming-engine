// 北冥仓库 · 出片编排 · 仓库与环境信息：仓库根、路径换算、git 提交与改动、工具版本指纹、内容哈希。
//   ROOT                       仓库根（由本文件位置推出，不依赖当前目录）
//   rel(p) / abs(r)            绝对路径 ↔ 仓库相对路径（一律用 / 分隔，跨平台可比）
//   gitInfo()                  { commit, short, dirty }；不是 git 检出时三者都是 null（run-id 用 nogit）
//   toolVersions(opts)         { node, playwright, browser, ffmpeg, python?, raea? }，写进 run.json 的 tools
//   sha256File(p) / hashTree(dir, { exclude }) / hashJson(v)   内容哈希；hashTree 按相对路径排序，跨机器稳定
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const rel = p => path.relative(ROOT, p).split(path.sep).join('/') || '.';
export const abs = r => path.resolve(ROOT, r);
export const posix = p => p.split(path.sep).join('/');

let gitCache = null;
export function gitInfo() {
  if (gitCache) return gitCache;
  const git = a => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const commit = git(['rev-parse', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0;
    gitCache = { commit, short: commit.slice(0, 8), dirty };
  } catch {
    gitCache = { commit: null, short: null, dirty: null };
  }
  return gitCache;
}

export function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

export const hashJson = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

// 同一进程内按 (路径, 大小, 修改时间) 记忆文件哈希，避免一次构建里反复读大文件
const memo = new Map();
export function fileHash(p) {
  const st = fs.statSync(p);
  const k = `${p}|${st.size}|${st.mtimeMs}`;
  if (!memo.has(k)) memo.set(k, sha256File(p));
  return memo.get(k);
}

const DEFAULT_SKIP = new Set(['node_modules', '.git', '__pycache__', '.DS_Store']);
// 目录树的内容哈希：列出全部文件（相对路径排序）与各自的 sha256；exclude 是相对 dir 的顶层名或路径前缀
export function hashTree(dir, { exclude = [] } = {}) {
  const h = crypto.createHash('sha256');
  if (!fs.existsSync(dir)) { h.update('missing'); return h.digest('hex'); }
  const skip = new Set(exclude.map(e => e.replace(/\/+$/, '')));
  const files = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (DEFAULT_SKIP.has(e.name)) continue;
      const r = prefix ? `${prefix}/${e.name}` : e.name;
      if (skip.has(r) || skip.has(e.name) && !prefix) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) files.push([r, p]);
    }
  };
  walk(dir, '');
  for (const [r, p] of files) h.update(`${r}\0${fileHash(p)}\n`);
  return h.digest('hex');
}

let versionsCache = null;
const firstLine = s => String(s || '').split('\n').map(l => l.trim()).find(Boolean) || null;
export function toolVersions({ python = null, raea = null } = {}) {
  if (!versionsCache) {
    const v = { node: process.version, playwright: null, browser: null, ffmpeg: null };
    try { v.playwright = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/playwright-core/package.json'), 'utf8')).version; } catch { /* 未安装 */ }
    try {
      const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find(x => x.name === 'chromium-headless-shell');
      v.browser = process.env.BEIMING_CHROME ? `BEIMING_CHROME=${path.basename(process.env.BEIMING_CHROME)}` : b ? `chromium-headless-shell ${b.browserVersion} (r${b.revision})` : null;
    } catch { /* 未安装 */ }
    try { v.ffmpeg = firstLine(execFileSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* 缺 ffmpeg 由预检报 */ }
    versionsCache = v;
  }
  const out = { ...versionsCache };
  if (python) {
    try { out.python = firstLine(execFileSync(python, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })) || null; } catch { out.python = null; }
  }
  if (raea) out.raea = raea;
  return out;
}

export function pythonBin() {
  return process.env.PYTHON || process.env.BEIMING_PY || (process.platform === 'win32' ? 'python' : 'python3');
}
