#!/usr/bin/env node
// 北冥仓库 · 改动围栏硬门禁：自 --base 以来改动的每个文件必须落在 fence 内、forbidden 外，否则退出 1。
//   node tools/check-fence.mjs --base origin/main --fence 'tools/check-fence*' --fence 'docs/' --forbidden 'src/'
//   node tools/check-fence.mjs --base origin/main --contract <围栏文件> [--fence …] [--forbidden …]
//   npm run check:fence -- --base origin/main --fence …
// 逻辑照 cuiyucheng0104-afk/mission-orchestrator 的 scripts/check_fence.py（7688ddc）移植，零依赖。
//
// 改动集合（防逃逸）：回到仓库根（子目录里 ls-files 只列该子目录）；`git diff --name-only --no-renames -z <merge-base>`
// 覆盖已提交与未提交（--no-renames：把文件移出 forbidden 目录也算碰了它）；再加 `git ls-files --others --exclude-standard -z`
// 的未跟踪文件。路径一律 NUL 分隔；git 输出的文件路径原样使用（各平台都是 /，字面带 \ 的文件名不能当目录分隔），
// 只有用户给的模式才把 \ 归一成 /。再查 `git ls-files -v -z`：有 assume-unchanged（小写标记）或 skip-worktree（S）的文件会让 git diff
// 看不见改动，一律拦下（稀疏检出的仓库里 skip-worktree 很常见，会被拦：在完整检出里跑）。
// 匹配：`*` `**` 都能跨目录，`?` 一个字符，`[abc]` `[!abc]` 字符集；以 `/` 结尾（`src/`）只匹配该目录之下，
// 不误伤同级文件（`pkgs/*/` 不误伤 `pkgs/list.tsv`）；forbidden 优先于 fence。
// 契约文件只认块状列表（`fence:` 换行后跟 `- "项"`）；行内写法 `fence: [a, b]` 直接拒绝（否则 forbidden 会静默失效）；
// 不看缩进层级，同名键出现多次取并集；契约里一项可用逗号写多个模式（`"*.mp4, *.mov"`），所以契约里的路径不能带逗号。
// 看不到的：被 .gitignore 忽略的文件（git 不报告它们）。
// 契约文件缺失或写法不对（行内列表、键名大写或带引号、`-` 后漏空格、非法转义）、fence 为空或含 ⏳ 占位符、非法通配、隐藏改动、
// 越界、零改动：FAILED / EXPECTED / SAW 并退出 4（契约不通过，docs/CLI.md 第 1 节）；git 执行失败退出 1；用法错误退出 2（fail-closed）。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CliError, defineCommand, isMain, runCli, usageError } from './lib/cli.mjs';

const ITEM = /^-\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^#]*?))\s*(?:#.*)?$/;

const failure = (code, what, expected, saw, hint) => new CliError(code, `FAILED   ${what}\nEXPECTED ${expected}\nSAW      ${saw}`, hint);
/** 契约 / 闸门不通过（退出 4） */
const fail = (what, expected, saw, hint = '要扩范围先改围栏（--fence / 契约文件），不要绕过检查') => failure('contract.fence', what, expected, saw, hint);

/** 用户给的模式统一成正斜杠、去掉开头的 ./（git 输出的文件路径不能这样处理：Linux 上 `\` 是合法的文件名字符） */
export const normPattern = s => s.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/** fnmatch 风格的通配转正则：`*`、`**` 都跨目录；`?`；`[abc]`、`[!abc]`；其余字符按字面。 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { while (glob[i + 1] === '*') i++; re += '.*'; }
    else if (c === '?') re += '.';
    else if (c === '[') {
      let j = i + 1;
      if (glob[j] === '!') j++;
      if (glob[j] === ']') j++;
      while (j < glob.length && glob[j] !== ']') j++;
      if (j >= glob.length) { re += '\\['; continue; }
      let body = glob.slice(i + 1, j);
      const neg = body[0] === '!';
      if (neg) body = body.slice(1);
      re += `[${neg ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      i = j;
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  try { return new RegExp(`^${re}$`, 's'); } catch (e) { throw fail('fence', '合法的路径模式', `${glob}：${e.message}`); }
}

/** 以 / 结尾 = 只匹配该目录之下；不以 / 结尾 = 该路径本身或其下。 */
export function matches(file, pattern) {
  const pat = normPattern(pattern), p = pat.replace(/\/+$/, '');
  return globToRegExp(`${p}/*`).test(file) || (!pat.endsWith('/') && globToRegExp(p).test(file));
}

/** 读契约文件里的 fence / forbidden 块状列表。 */
export function parseContract(text) {
  const out = { fence: [], forbidden: [] };
  let key = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const m = ITEM.exec(s);
    if (m && key) {
      const [, dq, sq, bare] = m;
      let item = dq ?? sq ?? bare;
      if (dq !== undefined) {
        try { item = JSON.parse(`"${dq}"`); } catch { throw fail('fence', '合法的双引号转义', `${s}（非法转义；路径里的反斜杠请用单引号或写成 /）`); }
      }
      out[key].push(...item.split(',').map(x => x.trim()).filter(Boolean));
    } else if (key && s.startsWith('-') && !/^-\s/.test(s)) {
      // `-"migrations/"` 这种漏了空格的写法若被当成别的行，forbidden 就静默失效
      throw fail('fence', '列表项写成 `- "路径"`（短横后面跟空格）', `畸形的列表项 \`${s}\``);
    } else if (!m) {
      const [name, ...rest] = s.split('#')[0].split(':');
      const bare = name.trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (bare in out && name.trim() !== bare) throw fail('fence', `键名写成小写无引号的 \`${bare}:\``, `\`${name.trim()}:\`（会被当成别的键，规则静默失效）`);
      key = bare in out ? bare : null;
      if (key && rest.join(':').trim()) {
        throw fail('fence', '块状列表（每项一行 `- "路径"`）', `不支持的行内写法 \`${s}\`（会被当成空列表，forbidden 整个失效）`);
      }
    }
  }
  return out;
}

function git(cwd, ...args) {
  const p = spawnSync('git', ['-C', cwd, ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (p.error || p.status !== 0) {
    throw failure('failure.git', `git ${args.join(' ')}`, '命令成功', (p.error?.message ?? p.stderr.toString('utf8')).trim() || `退出码 ${p.status}`, '确认 --repo 是 git 工作树、--base 是存在的分支或提交');
  }
  return p.stdout.toString('utf8').split('\0').filter(Boolean);
}

// rev-parse / merge-base 输出以换行结尾（-z 的列表输出没有）
const git1 = (...a) => git(...a)[0].trim();

export const command = defineCommand({
  name: 'check-fence',
  summary: '改动围栏硬门禁：自 --base 以来改动的文件必须都在 fence 内、forbidden 外',
  usage: ['node tools/check-fence.mjs --base <基准> (--fence <模式>… [--forbidden <模式>…] | --contract <文件>) [--repo <目录>] [--json]'],
  description: ['已提交、未提交与未跟踪的改动都查（.gitignore 忽略的文件 git 看不到，查不了）。forbidden 优先于 fence；`dir/` 只匹配目录之下。',
    '--contract 与 --fence / --forbidden 可同时给，取并集。契约文件只认块状 YAML 列表，行内写法、大写或带引号的键名、`-` 后漏空格都会被拒绝。',
    '用 git update-index --assume-unchanged / --skip-worktree 藏起来的改动 git diff 看不到，一律拦下（稀疏检出里 skip-worktree 很常见，请在完整检出里跑）。'],
  options: {
    base: { type: 'string', arg: '<基准>', describe: '基准分支或提交（必填；与 HEAD 取 merge-base 后比较）', example: 'origin/main' },
    contract: { type: 'string', arg: '<文件>', describe: '含 fence: / forbidden: 块状列表的契约文件' },
    fence: { type: 'list', arg: '<模式>', describe: '允许改动的路径模式，可重复' },
    forbidden: { type: 'list', arg: '<模式>', describe: '禁止改动的路径模式，可重复；优先于 fence' },
    repo: { type: 'string', arg: '<目录>', describe: '被检查的 git 工作树（默认当前目录；子目录也行，会回到仓库根）', default: '.' },
  },
  examples: ["node tools/check-fence.mjs --base origin/main --fence 'tools/' --fence 'docs/' --forbidden 'src/'", 'node tools/check-fence.mjs --base origin/main --contract contract.yaml'],
  exitCodes: { 0: '全部合规', 1: 'git 执行失败或内部错误', 2: '用法错误', 4: '契约不通过：越界、碰 forbidden、围栏没填或写法不对、零改动、有隐藏改动' },
  async run(ctx) {
    const { base: baseRef, contract, repo } = ctx.opts;
    if (!baseRef) throw usageError('missing-option', '缺少 --base', '例：--base origin/main');
    let fence = [...ctx.opts.fence], forbidden = [...ctx.opts.forbidden];
    if (contract) {
      let text;
      try { text = readFileSync(contract, 'utf8'); } catch (e) { throw fail('fence', '契约文件存在且可读', `${contract}：${e.code ?? e.message}`); }
      const c = parseContract(text);
      fence = [...c.fence, ...fence]; forbidden = [...c.forbidden, ...forbidden];
    }
    if (!fence.length || [...fence, ...forbidden].some(f => f.startsWith('⏳'))) {
      throw fail('fence', '已填写真实路径的 fence（--fence 或契约的 fence:），且没有 ⏳ 占位符', fence.length ? `${fence.join(' ')}（含占位符）` : '空');
    }
    for (const p of [...fence, ...forbidden]) matches('', p); // 非法通配现在就报，不等到某个文件碰上
    const root = git1(repo, 'rev-parse', '--show-toplevel');
    const base = git1(root, 'merge-base', baseRef, 'HEAD');
    const changed = [...new Set([
      ...git(root, 'diff', '--name-only', '--no-renames', '-z', base),
      ...git(root, 'ls-files', '--others', '--exclude-standard', '-z'),
    ])].sort();
    // assume-unchanged（小写标记）与 skip-worktree（S）让 git diff 看不到改动：不管改没改都当作围栏不通过
    const hidden = git(root, 'ls-files', '-v', '-z').filter(e => /^[a-zS]$/.test(e[0]) && e[1] === ' ').map(e => `${e.slice(2)}  ← ${e[0] === 'S' ? 'skip-worktree' : 'assume-unchanged'}`);
    if (hidden.length) {
      throw fail('fence', '没有被 assume-unchanged / skip-worktree 隐藏的文件', hidden.join('\n         '),
        '解除：git update-index --no-assume-unchanged <文件> 或 --no-skip-worktree <文件>；稀疏检出请换完整检出再跑');
    }
    if (!changed.length) throw fail('fence', '相对 --base 至少有一个改动文件', `0 个改动（base=${base.slice(0, 7)}，--base 写错了？）`);

    const bad = [];
    for (const f of changed) {
      const hit = forbidden.find(p => matches(f, p));
      if (hit) bad.push(`${f}  ← forbidden: ${hit}`);
      else if (!fence.some(p => matches(f, p))) bad.push(`${f}  ← 不在 fence 内`);
    }
    if (bad.length) throw fail('fence', '所有改动落在 fence 内且不碰 forbidden（要扩范围先改围栏）', bad.join('\n         '));
    ctx.out(`[check-fence] OK：${changed.length} 个改动文件全部在 fence 内（base=${base.slice(0, 7)}）`);
    return { data: { base, changed } };
  },
});

if (isMain(import.meta.url)) await runCli(command);
