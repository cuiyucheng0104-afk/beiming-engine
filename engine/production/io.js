// 北冥引擎 · 作品记录的文件读写（Node 专用）：原子写、独占新建、sha256、JSON 读取与稳定排版。
// film.js、review.js、state.js 共用；不依赖它们，避免循环引用。
//
//   REPO_ROOT                        本模块所在仓库的根（engine/production 往上两级）
//   sha256File(path) / sha256Text(s) 十六进制 sha256
//   readJsonFile(path)               → { ok: true, value, text } | { ok: false, code: 'not-found'|'unreadable'|'json-invalid', message }
//                                    （自动去掉 Windows 记事本写入的 UTF-8 BOM）
//   atomicWrite(path, text)          同目录临时文件 + rename：不会留下半截文件；Windows 上被占用时短暂重试
//   createExclusive(dir, names, text)按顺序试 names，第一个不存在的名字原子地写入（硬链接，不支持时退回 wx 打开），返回实际路径
//   formatJson(value, { width })     稳定排版：放得下一行的对象 / 数组写成一行，否则逐项展开；只动空白，不动内容
//   writeJsonAtomic(path, value)     formatJson + atomicWrite，返回 { path, sha256 }
//   cleanupTemps()                   删掉本进程还没收尾的临时文件（命令行入口在 SIGINT / SIGTERM 时调用）
//   toPosix(p) / repoRelative(abs)   记录里的路径一律用正斜杠
// 库本身不注册信号处理器（不抢调用方的清理顺序），只在正常退出时兜底删除临时文件。
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const toPosix = p => String(p).split(sep).join('/');
export function repoRelative(absPath, root = REPO_ROOT) {
  const r = relative(root, absPath);
  return r && !r.startsWith('..') && !/^[A-Za-z]:/.test(r) ? toPosix(r) : null;
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, code: 'not-found', message: `文件不存在：${path}` };
    if (error.code === 'EISDIR') return { ok: false, code: 'not-found', message: `这是目录，不是文件：${path}` };
    return { ok: false, code: 'unreadable', message: `读取失败（${error.code ?? error.message}）：${path}` };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch (error) {
    return { ok: false, code: 'json-invalid', message: `不是合法 JSON（${error.message}）：${path}` };
  }
}

// ───────────────────────── 临时文件 ─────────────────────────

const temps = new Set();
let exitHooked = false;
export function cleanupTemps() {
  for (const p of temps) { try { unlinkSync(p); } catch { /* 已删 */ } }
  temps.clear();
}
function track(path) {
  temps.add(path);
  if (!exitHooked) { exitHooked = true; process.once('exit', cleanupTemps); }
  return path;
}
const tempIn = (dir, stem) => join(dir, `.${stem}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);

function writeDurable(path, text, flag) {
  const fd = openSync(path, flag);
  try {
    writeSync(fd, text);
    try { fsyncSync(fd); } catch { /* 部分文件系统不支持 fsync */ }
  } finally {
    closeSync(fd);
  }
}

function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; } catch (error) {
      const retryable = process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code) && attempt < 8;
      if (!retryable) throw error;
      const until = Date.now() + 25 * (attempt + 1);
      while (Date.now() < until) { /* 等杀毒或索引进程放手 */ }
    }
  }
}

export function atomicWrite(path, text) {
  const tmp = track(tempIn(dirname(path), basename(path)));
  try {
    writeDurable(tmp, text, 'wx');
    renameRetry(tmp, path);
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 忽略 */ }
    temps.delete(tmp);
  }
  return path;
}

export function createExclusive(dir, names, text) {
  const tmp = track(tempIn(dir, 'new'));
  try {
    writeDurable(tmp, text, 'wx');
    for (const name of names) {
      const target = join(dir, name);
      try {
        linkSync(tmp, target);   // 目标已存在时 EEXIST：原子、不覆盖
        return target;
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        if (['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EINVAL'].includes(error.code)) {
          try { writeDurable(target, text, 'wx'); return target; } catch (e2) { if (e2.code === 'EEXIST') continue; throw e2; }
        }
        throw error;
      }
    }
    throw Object.assign(new Error(`${dir} 下这些名字都已被占用：${names.slice(0, 3).join('、')}…`), { code: 'EEXIST' });
  } finally {
    try { unlinkSync(tmp); } catch { /* 已删 */ }
    temps.delete(tmp);
  }
}

// ───────────────────────── 稳定排版 ─────────────────────────

function compact(v) {
  if (Array.isArray(v)) return v.length ? `[${v.map(compact).join(', ')}]` : '[]';
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    return keys.length ? `{ ${keys.map(k => `${JSON.stringify(k)}: ${compact(v[k])}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v ?? null);
}

export function formatJson(value, { width = 160 } = {}) {
  const fmt = (v, indent, prefix, top) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
    const c = compact(v);
    if (!top && indent + prefix + c.length <= width) return c;
    const pad = ' '.repeat(indent + 2), end = ' '.repeat(indent);
    if (Array.isArray(v)) return v.length ? `[\n${v.map(x => pad + fmt(x, indent + 2, 0, false)).join(',\n')}\n${end}]` : '[]';
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    if (!keys.length) return '{}';
    return `{\n${keys.map(k => { const key = JSON.stringify(k); return `${pad}${key}: ${fmt(v[k], indent + 2, key.length + 2, false)}`; }).join(',\n')}\n${end}}`;
  };
  return `${fmt(value, 0, 0, true)}\n`;
}

export function writeJsonAtomic(path, value) {
  const text = formatJson(value);
  atomicWrite(path, text);
  return { path, sha256: sha256Text(text) };
}
