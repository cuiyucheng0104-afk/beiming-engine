// 北冥仓库 · agent 护栏的路径归一
// 做什么：把工具调用里的路径（POSIX 或 Windows、相对或绝对、~ / $HOME / %USERPROFILE%、经过符号链接）
//         归一成"相对仓库根的正斜杠路径"，并判断是否落在受保护区域或家目录的上游风格库副本里。
// 接口：pathApi(root)、caseInsensitive(platform, root)、expandHome(p, home)、
//       classifyPath(input, ctx) → { abs, inside, rel, zone, homeLib, homeRel, ci }。
//       ctx = { root, cwd, home, platform }；platform 缺省取 process.platform。
// 只读文件系统（realpath 最深的已存在祖先），不写任何东西。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_STYLE_DIRS, zoneOf } from './policy.mjs';

const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** 按仓库根的写法选 path.win32 或 path.posix，测试里可以在 macOS 上模拟 Windows 路径。 */
export function pathApi(root) {
  return typeof root === 'string' && WIN_ABS.test(root) ? path.win32 : path.posix;
}

/** 是否按大小写不敏感比较：Windows 与 macOS 的默认文件系统都不区分大小写。 */
export function caseInsensitive(platform = process.platform, root = '') {
  return platform === 'win32' || platform === 'darwin' || WIN_ABS.test(root);
}

/** 展开 ~、$HOME、${HOME}、$env:USERPROFILE、%USERPROFILE%；其他变量原样保留（无法静态求值）。 */
export function expandHome(p, home) {
  if (typeof p !== 'string' || !home) return p;
  const m = p.match(/^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOME%)(?=$|[\\/])/i);
  if (!m) return p;
  return home + p.slice(m[0].length);
}

/** 对本机风格的路径做 realpath：从最深的已存在祖先解析符号链接，再接上不存在的尾部。异常时原样返回。 */
function realpathLoose(abs, P) {
  if (P !== path) return abs;            // 模拟另一种平台的路径时不碰文件系统
  let cur = abs;
  const tail = [];
  for (let i = 0; i < 4096; i++) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return abs;
}

function relInside(P, base, target) {
  const r = P.relative(base, target);
  if (r === '') return '';
  if (r === '..' || r.startsWith('..' + P.sep) || r.startsWith('../') || P.isAbsolute(r)) return null;
  return r.split(P.sep).join('/');
}

/**
 * 归一一个路径。返回：
 *   abs      绝对路径（按仓库根的平台写法）
 *   inside   是否在仓库根之内（含根本身）
 *   rel      仓库相对路径（正斜杠；根本身是 ''）；不在仓库内为 null
 *   zone     命中的受保护区域（policy.ZONES 的一项）或 null
 *   homeLib  命中的家目录上游风格库目录名（如 'lemo-my-styles'）或 null
 *   homeRel  命中时相对家目录的路径（正斜杠，如 'lemo-opuscar/.venv/bin/python'），否则 null
 *   ci       是否按大小写不敏感比较
 */
export function classifyPath(input, ctx) {
  const root = ctx.root;
  const P = pathApi(root);
  const ci = caseInsensitive(ctx.platform ?? process.platform, root);
  const home = ctx.home ?? os.homedir();
  const cwd = ctx.cwd ? P.resolve(root, ctx.cwd) : root;
  // POSIX 仓库上也把反斜杠当分隔符：PowerShell 在 macOS / Linux 上同样接受 films\x\a.js；宁可多拦，不可漏拦。
  let raw = P === path.posix ? String(input).replace(/\\/g, '/') : String(input);
  // Windows 仓库上把 Git Bash / MSYS 写法 /c/work/x 换成 C:/work/x（Windows 上的 Bash 工具常这样写）
  if (P === path.win32) { const m = raw.match(/^\/([a-zA-Z])(?=\/|$)/); if (m) raw = `${m[1].toUpperCase()}:/${raw.slice(3)}`; }
  const expanded = expandHome(raw, home);
  const abs = P.resolve(cwd, expanded);
  const real = realpathLoose(abs, P);
  const rootReal = realpathLoose(P.resolve(root), P);

  // 原始写法与解析符号链接后的写法都算：任一落进受保护区域就按区域处理。
  const rels = [];
  for (const [base, target] of [[P.resolve(root), abs], [rootReal, real], [rootReal, abs], [P.resolve(root), real]]) {
    const r = relInside(P, base, target);
    if (r !== null && !rels.includes(r)) rels.push(r);
  }
  let rel = rels.length ? rels[0] : null;
  let zone = null;
  for (const r of rels) {
    const z = zoneOf(r, { ci });
    if (z) { zone = z; rel = r; break; }
  }

  // 家目录风格库：原始写法与解析符号链接后的写法都查；记下命中的库名与相对家目录的路径（判断解释器例外用）。
  let homeLib = null;
  let homeRel = null;
  const homes = [P.resolve(home), realpathLoose(P.resolve(home), P)];
  for (const h of homes) {
    for (const target of [abs, real]) {
      const r = relInside(P, h, target);
      if (!r) continue;
      const first = r.split('/')[0];
      const hit = HOME_STYLE_DIRS.find(d => (ci ? d.toLowerCase() === first.toLowerCase() : d === first));
      if (hit) { homeLib = hit; homeRel = r; break; }
    }
    if (homeLib) break;
  }
  return { abs, inside: rel !== null, rel, zone, homeLib, homeRel, ci };
}
