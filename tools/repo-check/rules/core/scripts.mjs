// core.scripts：package.json 有 new 与 check:repo；每个脚本用 node / python / sh 直接调用的文件都存在，
// 用 npm run 串起来的别的脚本也都在。脚本名、指向与实现方的总表见 docs/CLI.md（附录 C3）。
//   - 按 && || ; 切成几段，逐段跟踪 `cd <目录>`（后面的相对路径从那里算，如 test:routes 的 cd tests && node --test ../tools/x）；
//   - node --test 的每个参数都是测试文件或 glob（如 "engine/**/*.test.mjs"），glob 要至少匹配一个文件；
//   - node / python 的 -m、-c、-e 之后不是文件，不查。
import path from 'node:path';

const RUNNERS = new Set(['node', 'python', 'python3', 'sh', 'bash']);
const GLOB = /[*?[]/;
const unquote = t => t.replace(/^(['"])(.*)\1$/, '$2');

/** glob（只支持 * ** ? 与字符类）→ 正则。 */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') i++; re += '(?:.*/)?'; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') { const j = glob.indexOf(']', i); if (j > i) { re += glob.slice(i, j + 1); i = j; } else re += '\\['; }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** 一条脚本命令里直接调用的文件（相对仓库根）与用 npm run 引用的脚本名。 */
export function scriptTargets(cmd) {
  const files = [], runs = [];
  let cwd = '.';
  for (const part of String(cmd).split(/&&|\|\||;/)) {
    const toks = part.trim().split(/\s+/).filter(Boolean).map(unquote);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    const head = toks[i];
    if (head === 'cd' && toks[i + 1]) { cwd = path.posix.normalize(path.posix.join(cwd, toks[i + 1])); continue; }
    if (head === 'npm' && toks[i + 1] === 'run') {
      const name = toks.slice(i + 2).find(t => !t.startsWith('-'));
      if (name) runs.push(name);
      continue;
    }
    if (!RUNNERS.has(head)) continue;
    const isTest = head === 'node' && toks.includes('--test');
    for (i++; i < toks.length; i++) {
      const t = toks[i];
      if (t === '-m' || t === '-c' || t === '-e' || t === '--') break;
      if (t.startsWith('-')) continue;
      files.push(path.posix.normalize(path.posix.join(cwd, t)));
      if (!isTest) break;
    }
  }
  return { files, runs };
}

export default {
  id: 'core.scripts',
  title: 'package.json 的脚本都指向存在的文件与脚本，new 与 check:repo 在',
  run(ctx) {
    if (!ctx.pkg) return [{ level: 'error', file: 'package.json', message: 'package.json 读不出来' }];
    const scripts = ctx.pkg.scripts ?? {};
    const out = [];
    for (const s of ['new', 'check:repo']) if (!scripts[s]) out.push({ level: 'error', file: 'package.json', message: `scripts 缺少 "${s}"`, hint: '请集成者按 docs/CLI.md 的命令表登记' });
    const all = ctx.memo('scripts:all-files', () => ctx.walk('.'));
    for (const [name, cmd] of Object.entries(scripts)) {
      const { files, runs } = scriptTargets(cmd);
      for (const t of files) {
        if (t === '..' || t.startsWith('../')) { out.push({ level: 'error', file: 'package.json', message: `脚本 ${name} 调用的 ${t} 在仓库外`, excerpt: name }); continue; }
        if (GLOB.test(t)) {
          const re = globRe(t);
          if (!all.some(f => re.test(f))) out.push({ level: 'error', file: 'package.json', message: `脚本 ${name} 的 ${t} 一个文件也匹配不到`, hint: '改 glob，或恢复被删掉的测试', excerpt: name });
        } else if (!ctx.exists(t)) out.push({ level: 'error', file: 'package.json', message: `脚本 ${name} 调用的 ${t} 不存在`, hint: '改脚本指向，或恢复那个文件', excerpt: name });
      }
      for (const r of runs) if (!scripts[r]) out.push({ level: 'error', file: 'package.json', message: `脚本 ${name} 里的 npm run ${r} 不存在`, hint: '改成现有脚本名（docs/CLI.md 第 9 节）', excerpt: name });
    }
    if (!out.length) out.push({ level: 'info', message: `${Object.keys(scripts).length} 个脚本的目标文件与串联的脚本都在` });
    return out;
  },
};
