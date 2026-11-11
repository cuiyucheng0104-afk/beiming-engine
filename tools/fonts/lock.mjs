// 字体锁定清单（fonts/fonts.lock.json）的读取、校验、缓存位置与缓存状态；tools/fonts 的 fetch / subset 与 route-a 仓库规则共用。
//   validateLock(lock) → 问题列表                    纯函数：字段、OFL、sha256、https 镜像、许可文件路径
//   loadLock(file?) → lock                          读并校验清单；不合格抛 CliError（contract.*，退出码 4）
//   cacheDir(lock, override?, env?) → 绝对路径        --cache > 环境变量 BEIMING_FONT_CACHE > 清单的 cacheDir（相对仓库根）
//   cacheStatus(lock, dir, ids?) → [{ id, file, path, state: 'ok' | 'missing' | 'mismatch', sha256? }]
//   fontById(lock, id)                              没有这个 id → CliError（contract.unknown-font，列出可用 id）
//   licenseText(font) → 许可全文（按 LF）
//   await findFontPython({ python?, env? }) → { cmd, args, source, fontTools, env }
//       解释器按仓库统一顺序找（tools/env/lib/python.mjs：BEIMING_PYTHON → BEIMING_PY → PYTHON → .venv → python3 …；
//       --python 当作 BEIMING_PYTHON），再确认装了 fontTools 与 brotli；缺了抛 env.*（退出码 3）
//   sha256File(path)                               流式计算，大字体不整个读进内存
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError } from '../lib/cli.mjs';
import { resolvePython, pythonEnv } from '../env/lib/python.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LOCK_FILE = path.join(ROOT, 'fonts', 'fonts.lock.json');
const HEX64 = /^[0-9a-f]{64}$/;

/** 仓库相对、正斜杠（仓库外的路径原样返回绝对路径）。 */
export const rel = p => {
  const r = path.relative(ROOT, path.resolve(p));
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : path.resolve(p);
};

export function sha256File(file) {
  const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), b = Buffer.allocUnsafe(1 << 20);
  try { for (let n; (n = fs.readSync(fd, b, 0, b.length, null)) > 0;) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

export function validateLock(lock, { root = ROOT } = {}) {
  const p = [];
  if (!lock || lock.schema !== 'beiming.fonts-lock/1') p.push('schema 应为 beiming.fonts-lock/1');
  if (!Array.isArray(lock?.fonts) || !lock.fonts.length) { p.push('fonts 不能为空'); return p; }
  const ids = new Set();
  for (const f of lock.fonts) {
    const at = `fonts[${JSON.stringify(f?.id)}]`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(f?.id || '')) p.push(`${at} 的 id 要用小写字母、数字、连字符`);
    if (ids.has(f?.id)) p.push(`${at} 重复`);
    ids.add(f?.id);
    if (f?.license !== 'OFL-1.1') p.push(`${at} 只收 OFL-1.1 字体（现在是 ${JSON.stringify(f?.license)}）`);
    for (const k of ['family', 'version', 'file', 'copyright', 'licenseFile']) if (typeof f?.[k] !== 'string' || !f[k]) p.push(`${at} 缺 ${k}`);
    if (!HEX64.test(f?.sha256 || '')) p.push(`${at} 的 sha256 要是 64 位小写十六进制`);
    if (!Number.isInteger(f?.bytes) || f.bytes <= 0) p.push(`${at} 的 bytes 要是正整数`);
    if (!Array.isArray(f?.urls) || !f.urls.length || f.urls.some(u => !/^https:\/\//.test(u))) p.push(`${at} 的 urls 至少一个，且都是 https`);
    if (f?.file && (f.file.includes('/') || f.file.includes('\\'))) p.push(`${at} 的 file 只写文件名`);
    if (f?.licenseFile && !fs.existsSync(path.join(root, f.licenseFile))) p.push(`${at} 的许可文件 ${f.licenseFile} 不存在`);
    if (f?.licenseSha256 !== undefined && !HEX64.test(f.licenseSha256)) p.push(`${at} 的 licenseSha256 要是 64 位小写十六进制`);
  }
  return p;
}

export function loadLock(file = LOCK_FILE, { root = ROOT } = {}) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new CliError('contract.fonts-lock', `读不了字体锁定清单 ${rel(file)}：${e.message}`, '它应在 fonts/fonts.lock.json：git checkout -- fonts/fonts.lock.json 恢复');
  }
  const p = validateLock(lock, { root });
  if (p.length) throw new CliError('contract.fonts-lock', `字体锁定清单不合格：${p.join('；')}`, '按 fonts/fonts.lock.json 开头的说明修正（新字体：OFL、带 sha256 与 https 镜像）');
  return lock;
}

export function cacheDir(lock, override = null, env = process.env) {
  return path.resolve(ROOT, override || env.BEIMING_FONT_CACHE || lock.cacheDir || '.cache/fonts');
}

/** 缓存目录在 --json 信封与报告里的写法：仓库里写相对路径，仓库外不写本机绝对路径（$BEIMING_FONT_CACHE 或 <--cache>）。 */
export function cacheLabel(dir, { override = null, env = process.env } = {}) {
  const r = rel(dir);
  if (!path.isAbsolute(r)) return r;
  if (!override && env.BEIMING_FONT_CACHE && path.resolve(ROOT, env.BEIMING_FONT_CACHE) === path.resolve(dir)) return '$BEIMING_FONT_CACHE';
  return '<--cache>';
}

export function fontById(lock, id) {
  const f = lock.fonts.find(x => x.id === id);
  if (!f) throw new CliError('contract.unknown-font', `字体锁定清单里没有 ${JSON.stringify(id)}`, `可用：${lock.fonts.map(x => x.id).join('、')}；要新加字体先把它（OFL、带 sha256）登记进 fonts/fonts.lock.json`);
  return f;
}

export function cacheStatus(lock, dir, ids = null) {
  return lock.fonts.filter(f => !ids || ids.includes(f.id)).map(f => {
    const p = path.join(dir, f.file);
    if (!fs.existsSync(p)) return { id: f.id, file: f.file, path: p, state: 'missing' };
    const h = sha256File(p);
    return { id: f.id, file: f.file, path: p, state: h === f.sha256 ? 'ok' : 'mismatch', sha256: h };
  });
}

// 许可全文按 LF（Windows 检出可能换成 CRLF；作品里的副本一律写 LF）
export const licenseText = (f, { root = ROOT } = {}) => fs.readFileSync(path.join(root, f.licenseFile), 'utf8').replace(/\r\n/g, '\n');

const FT_PROBE = 'import fontTools, fontTools.subset, fontTools.varLib.instancer, brotli; print(fontTools.version)';

// 缺 fontTools 时的下一步：仓库锁文件已经收了 fonttools 就是 npm run setup；还没收（加固过渡期）就给出装进 .venv 的命令
export function fontToolsHint(root = ROOT) {
  let locked = false;
  try { locked = /^fonttools==/m.test(fs.readFileSync(path.join(root, 'requirements.lock'), 'utf8')); } catch { locked = false; }
  return locked
    ? '在仓库根目录运行 npm run setup（按 requirements.lock 装好 fonttools、brotli）；或设 BEIMING_PYTHON（也可加 --python）指向已装好它们的 Python 3.12'
    : '仓库的 requirements.lock 还没收 fonttools：先 npm run setup 建好 .venv，再 uv pip install --python .venv "fonttools>=4.60,<5" "brotli>=1.1,<2"（没有 uv 时 node tools/env/py.mjs -m pip install …）；或设 BEIMING_PYTHON 指向已装好它们的 Python 3.12';
}

export async function findFontPython({ python = null, env = process.env } = {}) {
  const e = python ? { ...env, BEIMING_PYTHON: python } : env;
  const py = await resolvePython({ env: e, want: '3.12' });
  if (!py.ok) throw new CliError('env.python-missing', `找不到可用的 Python：${py.error}`, py.hint || '在仓库根目录运行 npm run setup，或设 BEIMING_PYTHON 指向装了 fonttools 与 brotli 的解释器');
  const runEnv = pythonEnv(e);
  const r = spawnSync(py.cmd, [...py.args, '-c', FT_PROBE], { encoding: 'utf8', env: runEnv, timeout: 60_000, windowsHide: true });
  if (r.error || r.status !== 0) {
    const why = r.error ? (r.error.code || r.error.message) : ((r.stderr || '').trim().split('\n').pop() || `退出码 ${r.status}`);
    throw new CliError('env.python-fonttools', `解释器 ${py.executable || py.cmd}（来自 ${py.source}）缺子集化要用的 fontTools 或 brotli：${why}`, fontToolsHint());
  }
  return { cmd: py.cmd, args: py.args, source: py.source, executable: py.executable || py.cmd, fontTools: r.stdout.trim(), env: runEnv };
}
