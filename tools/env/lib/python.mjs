// 北冥仓库 · 找 Python：所有工具用同一套顺序解析解释器，并给出统一的子进程环境。
//
// 查找顺序（第一个能运行的就用；显式指定的变量指向坏解释器时直接报错，不悄悄换下一个）：
//   1. BEIMING_PYTHON   正式名
//   2. BEIMING_PY       别名（C 路线 build.mjs 沿用）
//   3. PYTHON           旧写法（sh 入口、B 路线 prepare 沿用；node-gyp 也读它，所以排在仓库专用名之后）
//   4. <仓库>/.venv     npm run setup 建的虚拟环境（POSIX: .venv/bin/python；Windows: .venv\Scripts\python.exe）
//   5. python3 → python → py -3.12 → py -3（系统解释器，多半缺依赖，doctor 会指出）
//
// 接口：
//   ROOT                                   仓库根目录
//   venvPython(venvDir, platform)          虚拟环境里解释器的路径
//   candidates({env, root, platform})      按顺序列出候选 [{source, cmd, args, explicit}]
//   probePython(cmd, args, {env})          运行一次解释器取版本信息 → {ok, version:[x,y,z], executable, prefix, basePrefix, platform, machine, implementation, error}
//   resolvePython({env, root, platform, probe, want})
//       → {ok, cmd, args, source, version, executable, ..., tried:[...], error, hint}
//       want 例如 '3.12'：只影响提示，不影响选择（选择只看顺序，避免「同一台机器上不同命令选到不同解释器」）
//   pythonEnv(base, {root})                子进程环境：PYTHONUTF8=1、PYTHONIOENCODING=utf-8、PYTHONPATH 前置仓库根
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, which } from './proc.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function venvPython(venvDir, platform = process.platform) {
  return platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
}

export function candidates({ env = process.env, root = ROOT, platform = process.platform } = {}) {
  const list = [];
  for (const name of ['BEIMING_PYTHON', 'BEIMING_PY', 'PYTHON']) {
    const v = (env[name] || '').trim();
    if (v) list.push({ source: name, cmd: v, args: [], explicit: true });
  }
  const venv = venvPython(path.join(root, '.venv'), platform);
  if (fs.existsSync(path.join(root, '.venv'))) list.push({ source: '.venv', cmd: venv, args: [], explicit: true });
  list.push({ source: 'python3', cmd: 'python3', args: [], explicit: false });
  list.push({ source: 'python', cmd: 'python', args: [], explicit: false });
  if (platform === 'win32') {
    list.push({ source: 'py -3.12', cmd: 'py', args: ['-3.12'], explicit: false });
    list.push({ source: 'py -3', cmd: 'py', args: ['-3'], explicit: false });
  }
  return list;
}

const PROBE = [
  'import json, sys, platform',
  'print(json.dumps({"v": list(sys.version_info[:3]), "exe": sys.executable, "prefix": sys.prefix, "base": sys.base_prefix,',
  ' "platform": sys.platform, "machine": platform.machine(), "system": platform.system(), "impl": sys.implementation.name,',
  ' "os_name": __import__("os").name, "python_full_version": platform.python_version()}))',
].join('\n');

export async function probePython(cmd, args = [], { env = process.env, timeout = 15_000 } = {}) {
  // 名字（如 python3）先在 PATH 里解析成完整路径：Windows 上 spawn 不会替我们补 .exe 以外的扩展名
  const resolved = (cmd.includes('/') || cmd.includes('\\')) ? cmd : which(cmd, { env });
  if (!resolved) return { ok: false, error: `PATH 里没有 ${cmd}` };
  if (!fs.existsSync(resolved)) return { ok: false, error: `文件不存在：${resolved}` };
  const r = await run(resolved, [...args, '-c', PROBE], { env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, timeout });
  if (r.error) return { ok: false, error: `无法启动 ${resolved}：${r.error.code || r.error.message}` };
  if (r.timedOut) return { ok: false, error: `${resolved} 在 ${timeout / 1000} 秒内没有响应` };
  if (r.code !== 0) return { ok: false, error: `${resolved} 退出码 ${r.code}${r.stderr.trim() ? `：${r.stderr.trim().split('\n').pop()}` : '（Windows 上常见于应用商店的 python 占位程序）'}` };
  try {
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    return { ok: true, path: resolved, version: j.v, executable: j.exe, prefix: j.prefix, basePrefix: j.base, platform: j.platform, machine: j.machine, system: j.system, implementation: j.impl, osName: j.os_name, fullVersion: j.python_full_version };
  } catch {
    return { ok: false, error: `${resolved} 的输出看不懂：${r.stdout.slice(0, 200)}` };
  }
}

const cache = new Map();

export async function resolvePython({ env = process.env, root = ROOT, platform = process.platform, probe = probePython, want = null } = {}) {
  const key = JSON.stringify([root, platform, env.BEIMING_PYTHON, env.BEIMING_PY, env.PYTHON, env.PATH, want]);
  if (probe === probePython && cache.has(key)) return cache.get(key);
  const tried = [];
  let result = null;
  for (const c of candidates({ env, root, platform })) {
    const p = await probe(c.cmd, c.args, { env });
    tried.push({ source: c.source, cmd: [c.cmd, ...c.args].join(' '), ok: p.ok, error: p.ok ? null : p.error });
    if (p.ok) {
      result = { ok: true, cmd: p.path || c.cmd, args: c.args, source: c.source, ...p, versionString: p.version.join('.'), tried };
      break;
    }
    if (c.explicit) {
      const venvHint = c.source === '.venv'
        ? '仓库里的 .venv 坏了（常见原因：建它的 Python 被删或升级）。删掉 .venv 后重跑 npm run setup'
        : `${c.source} 指向的解释器不可用：改成能运行的 Python ${want || '3.12'} 的完整路径，或取消这个变量（让工具用 .venv）`;
      result = { ok: false, source: c.source, tried, error: `${c.source}=${c.cmd} 无法使用：${p.error}`, hint: venvHint };
      break;
    }
  }
  if (!result) {
    result = { ok: false, tried, error: '没有找到可用的 Python 解释器', hint: '在仓库根目录运行 npm run setup（会用 uv 或 Python 3.12 建 .venv）；只想指定已有解释器时设 BEIMING_PYTHON=<完整路径>' };
  }
  if (probe === probePython) cache.set(key, result);
  return result;
}

export function pythonEnv(base = process.env, { root = ROOT } = {}) {
  const sep = path.delimiter;
  const prev = base.PYTHONPATH ? base.PYTHONPATH.split(sep).filter(p => p && path.resolve(p) !== root) : [];
  return { ...base, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: [root, ...prev].join(sep) };
}
