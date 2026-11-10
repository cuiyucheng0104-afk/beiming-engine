// 北冥仓库 · 合规扫描的文件来源：列出要扫的文件、判断所在区域、按需读取内容。只读，不写任何文件。
// 接口：
//   listFiles(root, { staged }) → { files: [相对路径（正斜杠）], source: 'git'|'git-index'|'walk' }
//     默认取 git 已跟踪文件（git ls-files -z）；staged 时只取暂存区里新增或改动的文件；
//     不是 git 仓库时退回目录遍历（跳过 .git、node_modules、out、.venv、__pycache__）。
//   readEntry(root, rel, { staged }) → { text|null, binary, size, skipped? }：二进制或过大文件 text 为 null。
//   zoneOf(rel) → 'archive'（cases/source、cases/vendor：历史归档与第三方快照，只报告不阻塞）| 'tree'
//   gitLines(root, args) → 字符串数组：给历史邮箱检查等少量只读 git 查询用。
// 路径一律用正斜杠的仓库相对路径，Windows 与 macOS / Linux 输出一致。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { EnvError } from './cli.mjs';

export const ARCHIVE_PREFIXES = ['cases/source/', 'cases/vendor/'];
const WALK_SKIP = new Set(['.git', 'node_modules', 'out', '.venv', '__pycache__', '.cache']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.psd', '.exr', '.hdr',
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz', '.tgz', '.xz', '.7z', '.rar', '.bz2', '.zst',
  '.npz', '.npy', '.bin', '.glb', '.ktx2', '.basis', '.pdf', '.pptx', '.docx', '.xlsx', '.key', '.numbers', '.pages',
  '.wasm', '.so', '.dylib', '.dll', '.exe', '.class', '.jar', '.pyc', '.blend', '.fbx', '.usdz', '.p12', '.pfx']);
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;

export function zoneOf(rel) {
  return ARCHIVE_PREFIXES.some(p => rel.startsWith(p)) ? 'archive' : 'tree';
}

function isGitRepo(root) {
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') return null;   // 没装 git
  return r.status === 0 && r.stdout.trim() === 'true';
}

function gitZ(root, args) {
  const out = execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean);
}

export function gitLines(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function walk(root, dir = '', out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (WALK_SKIP.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export function listFiles(root, { staged = false } = {}) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new EnvError(`仓库根目录不存在：${root}`, '用 --root 指向仓库根目录，或在仓库里运行');
  }
  const git = isGitRepo(root);
  if (staged) {
    if (!git) throw new EnvError('--staged 需要 git 仓库与 git 命令', '在仓库工作树里运行，或去掉 --staged 扫全部文件');
    return { files: gitZ(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).sort(), source: 'git-index' };
  }
  if (git) return { files: gitZ(root, ['ls-files', '-z']).sort(), source: 'git' };
  return { files: walk(root).sort(), source: 'walk' };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// 暂存区内容用一次 git cat-file --batch 取回，避免逐文件起进程。
const stagedCache = new Map();
function loadStaged(root, rels) {
  const key = root;
  if (stagedCache.has(key)) return stagedCache.get(key);
  const input = rels.map(r => `:${r}`).join('\n') + '\n';
  const r = spawnSync('git', ['-C', root, 'cat-file', '--batch'], { input, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new EnvError('读取暂存区内容失败（git cat-file --batch）', '确认 git 可用，或去掉 --staged');
  const buf = r.stdout;
  const map = new Map();
  let pos = 0;
  for (const rel of rels) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing')) { map.set(rel, null); continue; }
    const size = Number(header.split(' ')[2]);
    map.set(rel, buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  stagedCache.set(key, map);
  return map;
}

export function readEntry(root, rel, { staged = false, stagedList = null } = {}) {
  const ext = path.extname(rel).toLowerCase();
  let buf;
  if (staged) {
    buf = loadStaged(root, stagedList || [rel]).get(rel);
    if (buf == null) return { text: null, binary: false, size: 0, skipped: 'missing' };
  } else {
    const abs = path.join(root, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { return { text: null, binary: false, size: 0, skipped: 'missing' }; }
    if (st.isSymbolicLink()) return { text: null, binary: false, size: 0, skipped: 'symlink' };
    if (BINARY_EXT.has(ext)) return { text: null, binary: true, size: st.size };
    if (st.size > MAX_TEXT_BYTES) return { text: null, binary: false, size: st.size, skipped: 'too-large' };
    buf = fs.readFileSync(abs);
  }
  if (BINARY_EXT.has(ext) || looksBinary(buf)) return { text: null, binary: true, size: buf.length };
  if (buf.length > MAX_TEXT_BYTES) return { text: null, binary: false, size: buf.length, skipped: 'too-large' };
  return { text: buf.toString('utf8'), binary: false, size: buf.length };
}

// 行号：按 \n 计数（\r\n 与 \n 都能对上）。
export function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return pos => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}
