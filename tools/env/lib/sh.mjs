// 北冥仓库 · 过渡期找 POSIX sh：仓库里还有几个 sh 入口（见 docs/ENVIRONMENT.md「sh 入口盘点」），
// 在它们改成 Node 实现之前，Windows 上也要能找到 sh，而且不要求用户改 PATH。
//
// 查找顺序：BEIMING_SH（显式指定）→ PATH 里的 sh → （仅 Windows）Git for Windows 的 bin\sh.exe：
//   先从 PATH 里的 git.exe 反推安装目录（…\Git\cmd\git.exe → …\Git\bin\sh.exe），再看 %ProgramFiles%、%ProgramFiles(x86)%、%LOCALAPPDATA%\Programs 下的 Git。
// 只认 Git\bin\sh.exe，不认 Git\usr\bin\sh.exe：bin 下的是启动器，会把 MSYS 的 /usr/bin（sed、awk、grep…）放进脚本的 PATH；
// 直接用 usr\bin\sh.exe 时脚本里找不到这些工具。也不建议把 Git\usr\bin 加进系统 PATH（它的 find、sort 会盖掉 Windows 自带的同名程序）。
//
// 接口：
//   findSh({env, platform, exists, whichFn}) → {path, source} | {path: null, tried: [...]}（exists / whichFn 供测试替换）
//   shFix(platform)                 → 一句可执行的修复建议
import fs from 'node:fs';
import path from 'node:path';
import { which } from './proc.mjs';

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
export function findSh({ env = process.env, platform = process.platform, exists = isFile, whichFn = which } = {}) {
  const tried = [];
  const explicit = (env.BEIMING_SH || '').trim();
  if (explicit) {
    if (exists(explicit)) return { path: explicit, source: 'BEIMING_SH' };
    return { path: null, tried: [`BEIMING_SH=${explicit}（文件不存在）`], explicitBroken: true };
  }
  const onPath = whichFn('sh', { env, platform });
  if (onPath) return { path: onPath, source: 'PATH' };
  tried.push('PATH 里没有 sh');
  if (platform !== 'win32') return { path: null, tried };
  const win = path.win32;
  const roots = [];
  const git = whichFn('git', { env, platform });
  if (git) roots.push(win.normalize(win.join(win.dirname(git), '..')));   // …\Git\cmd\git.exe → …\Git
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA && win.join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) roots.push(win.join(base, 'Git'));
  }
  for (const r of [...new Set(roots)]) {
    const p = win.join(r, 'bin', 'sh.exe');
    if (exists(p)) return { path: p, source: `Git for Windows（${r}）` };
    tried.push(`${p} 不存在`);
  }
  return { path: null, tried };
}

export function shFix(platform = process.platform) {
  return platform === 'win32'
    ? '安装 Git for Windows：winget install --id Git.Git -e（工具会自己找到 Git\\bin\\sh.exe，不用改 PATH）；装在非默认位置时设 $env:BEIMING_SH = \'<Git 目录>\\bin\\sh.exe\''
    : platform === 'darwin' ? 'macOS 自带 /bin/sh：检查 PATH 是否被改坏（echo $PATH）' : '安装 dash 或 bash（sudo apt-get install dash）';
}
