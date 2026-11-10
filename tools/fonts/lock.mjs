// 字体锁定清单（fonts/fonts.lock.json）的读取、校验、缓存位置与缓存状态；tools/fonts 的 fetch / subset 共用。
//   loadLock() → lock                   读并校验清单；不合格抛 CliError（退出码 4）
//   cacheDir(lock, override?) → 绝对路径  --cache > 环境变量 BEIMING_FONT_CACHE > 清单的 cacheDir（相对仓库根）
//   cacheStatus(lock, dir, ids?) → [{ id, file, path, state: 'ok' | 'missing' | 'mismatch', sha256? }]
//   fontById(lock, id)                  没有这个 id → CliError（退出码 4，列出可用 id）
//   findPython(override?) → { cmd, args, version }   找装了 fontTools 与 brotli 的 Python（顺序见 pythonCandidates）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, EXIT, CliError, sha256File } from '../lookdev/lib/cli.mjs';

export const LOCK_FILE = path.join(ROOT, 'fonts', 'fonts.lock.json');
const HEX64 = /^[0-9a-f]{64}$/;

export function validateLock(lock) {
  const p = [];
  if (!lock || lock.schema !== 'beiming.fonts-lock/1') p.push('schema 应为 beiming.fonts-lock/1');
  if (!Array.isArray(lock?.fonts) || !lock.fonts.length) { p.push('fonts 不能为空'); return p; }
  const ids = new Set();
  for (const f of lock.fonts) {
    const at = `fonts[${JSON.stringify(f.id)}]`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(f.id || '')) p.push(`${at} 的 id 要用小写字母、数字、连字符`);
    if (ids.has(f.id)) p.push(`${at} 重复`); ids.add(f.id);
    if (f.license !== 'OFL-1.1') p.push(`${at} 只收 OFL-1.1 字体（现在是 ${JSON.stringify(f.license)}）`);
    for (const k of ['family', 'version', 'file', 'copyright', 'licenseFile']) if (typeof f[k] !== 'string' || !f[k]) p.push(`${at} 缺 ${k}`);
    if (!HEX64.test(f.sha256 || '')) p.push(`${at} 的 sha256 要是 64 位小写十六进制`);
    if (!Number.isInteger(f.bytes) || f.bytes <= 0) p.push(`${at} 的 bytes 要是正整数`);
    if (!Array.isArray(f.urls) || !f.urls.length || f.urls.some(u => !/^https:\/\//.test(u))) p.push(`${at} 的 urls 至少一个，且都是 https`);
    if (f.file && (f.file.includes('/') || f.file.includes('\\'))) p.push(`${at} 的 file 只写文件名`);
    if (f.licenseFile && !fs.existsSync(path.join(ROOT, f.licenseFile))) p.push(`${at} 的许可文件 ${f.licenseFile} 不存在`);
  }
  return p;
}

export function loadLock(file = LOCK_FILE) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new CliError(EXIT.CONTRACT, 'lock-unreadable', `读不了字体锁定清单 ${file}：${e.message}`, '它应在 fonts/fonts.lock.json，别移动或手改成非法 JSON');
  }
  const p = validateLock(lock);
  if (p.length) throw new CliError(EXIT.CONTRACT, 'lock-invalid', `字体锁定清单不合格：${p.join('；')}`, '按 fonts/fonts.lock.json 开头的说明修正');
  return lock;
}

export function cacheDir(lock, override) {
  const d = override || process.env.BEIMING_FONT_CACHE || lock.cacheDir || '.cache/fonts';
  return path.resolve(ROOT, d);
}

export function fontById(lock, id) {
  const f = lock.fonts.find(x => x.id === id);
  if (!f) throw new CliError(EXIT.CONTRACT, 'unknown-font', `字体锁定清单里没有 ${JSON.stringify(id)}`, `可用：${lock.fonts.map(x => x.id).join('、')}；要新加字体先把它（OFL、带 sha256）登记进 fonts/fonts.lock.json`);
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

// 许可全文按 LF 比对（Windows 检出可能换成 CRLF）
export function licenseText(f) {
  const txt = fs.readFileSync(path.join(ROOT, f.licenseFile), 'utf8').replace(/\r\n/g, '\n');
  return txt;
}

// 解释器查找顺序与仓库统一约定一致（加固计划 P10 的 tools/env/py.mjs）：--python > PYTHON > BEIMING_PYTHON >
// BEIMING_PY（旧名，保留一个版本）> 仓库根 .venv > python3 > python > py -3。
export function pythonCandidates(override, env = process.env, platform = process.platform) {
  const tries = [];
  if (override) tries.push([override]);
  for (const k of ['PYTHON', 'BEIMING_PYTHON', 'BEIMING_PY']) if (env[k]) tries.push([env[k]]);
  const venv = platform === 'win32' ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) tries.push([venv]);
  tries.push(['python3'], ['python']);
  if (platform === 'win32') tries.push(['py', '-3']);
  return tries;
}

export function findPython(override) {
  const tries = pythonCandidates(override);
  const probe = 'import fontTools, fontTools.subset, brotli; print(fontTools.version)';
  const seen = [];
  for (const [cmd, ...pre] of tries) {
    const r = spawnSync(cmd, [...pre, '-c', probe], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r.status === 0) return { cmd, args: pre, version: r.stdout.trim() };
    seen.push(`${[cmd, ...pre].join(' ')}：${r.error ? r.error.code || r.error.message : (r.stderr || '').trim().split('\n').pop()}`);
  }
  throw new CliError(EXIT.ENV, 'python-missing', `找不到装了 fontTools 与 brotli 的 Python（试过：${seen.join('；')}）`,
    '装好仓库的 Python 依赖（fonttools、brotli），或设环境变量 PYTHON 指向装好的解释器（也可加 --python）');
}
