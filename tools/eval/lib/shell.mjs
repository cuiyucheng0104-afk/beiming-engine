// Bash 命令静态分析：从会话记录里的 Bash 调用推断 git 操作、写入目标、读取的文档与 cd。
//
// 这是判定 H3 / H4 的辅助证据，不执行任何命令。能识别：
//   - 引号、反斜杠转义、注释、here-doc（跳过正文）、$(…) 与反引号（递归分析）、子 shell 括号；
//   - 分隔符 && || ; | |& & 换行；重定向 > >> &> &>> >| <> >&file 与 fd 前缀（2>）；
//   - 前缀环境变量（A=1 cmd）与包装命令（sudo env command nohup time timeout nice exec xargs）；
//   - git 全局参数（-C 目录、-c 键=值、--git-dir、--work-tree、--no-pager）后的子命令；
//   - 写入：重定向目标、tee、cp/mv/rsync/install/ln、rm/mkdir/touch/chmod…、sed -i、perl -i、dd of=、
//     tar -C、unzip -d、curl -o、wget -O、git checkout/restore/rm/mv 的路径参数；
//   - 读取文档：cat、head、tail、sed -n、less、more、bat、nl 读到的文件与大致行数。
// 推断不了的（脚本内部写了什么）不报告；结论只作证据，最终状态以 git 与文件系统为准。
// 接口：analyzeShell(command, { cwd, home }) → { commands, git, writes, reads, cwd, executable, unparsed }

import path from 'node:path';
import { expandHome, homeDir } from './paths.mjs';

const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '\n', '(', ')']);
const WRITE_REDIRECTS = new Set(['>', '>>', '&>', '&>>', '>|', '<>']);

function matchParen(src, open) {
  // open 指向 '('；返回与之配对的 ')' 下标（考虑引号与嵌套）
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      i = j; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return src.length - 1;
}

/** 词法分析：返回 [{ t: 'word'|'op'|'subst', v }]。 */
export function lex(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let word = null;
  const heredocs = [];
  const push = () => { if (word !== null) { out.push({ t: 'word', v: word }); word = null; } };
  const add = s => { word = (word ?? '') + s; };
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      add(src[i + 1] ?? ''); i += 2; continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      add(src.slice(i + 1, end)); i = end + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n && '"\\$`\n'.includes(src[j + 1])) { s += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') { const k = matchParen(src, j + 1); out.push({ t: 'subst', v: src.slice(j + 2, k) }); s += '$(…)'; j = k + 1; continue; }
        s += src[j]; j++;
      }
      add(s); i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const k = matchParen(src, i + 1);
      out.push({ t: 'subst', v: src.slice(i + 2, k) });
      add('$(…)'); i = k + 1; continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      const end = j < 0 ? n : j;
      out.push({ t: 'subst', v: src.slice(i + 1, end) });
      add('`…`'); i = end + 1; continue;
    }
    if (c === '#' && word === null) {
      const j = src.indexOf('\n', i);
      i = j < 0 ? n : j; continue;
    }
    if (c === '\n') {
      push();
      out.push({ t: 'op', v: '\n' });
      i++;
      while (heredocs.length) {
        const { delim, strip } = heredocs.shift();
        for (;;) {
          if (i >= n) break;
          const j = src.indexOf('\n', i);
          const line = src.slice(i, j < 0 ? n : j);
          i = j < 0 ? n : j + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { push(); i++; continue; }
    if (c === '<' && src[i + 1] === '<') {
      if (src[i + 2] === '<') { push(); out.push({ t: 'op', v: '<<<' }); i += 3; continue; }
      push(); i += 2;
      let strip = false;
      if (src[i] === '-') { strip = true; i++; }
      while (src[i] === ' ' || src[i] === '\t') i++;
      let d = '';
      while (i < n && !/[\s;&|<>()]/.test(src[i])) { if (src[i] !== "'" && src[i] !== '"' && src[i] !== '\\') d += src[i]; i++; }
      heredocs.push({ delim: d, strip });
      out.push({ t: 'op', v: '<<' });
      out.push({ t: 'word', v: d, heredoc: true });
      continue;
    }
    if (c === '>' || c === '<') {
      // 单独的数字词紧挨着 > / < 是文件描述符（2>），不是参数
      let fd = '';
      if (word !== null && /^\d+$/.test(word)) { fd = word; word = null; } else push();
      let op = c;
      const next = src[i + 1];
      if (c === '>' && next === '>') op = '>>';
      else if (c === '>' && next === '|') op = '>|';
      else if (c === '>' && next === '&') op = '>&';
      else if (c === '<' && next === '&') op = '<&';
      else if (c === '<' && next === '>') op = '<>';
      i += op.length;
      out.push({ t: 'op', v: op, fd });
      continue;
    }
    if (c === '&') {
      push();
      if (src[i + 1] === '&') { out.push({ t: 'op', v: '&&' }); i += 2; continue; }
      if (src[i + 1] === '>') {
        if (src[i + 2] === '>') { out.push({ t: 'op', v: '&>>' }); i += 3; continue; }
        out.push({ t: 'op', v: '&>' }); i += 2; continue;
      }
      out.push({ t: 'op', v: '&' }); i++; continue;
    }
    if (c === '|') {
      push();
      if (src[i + 1] === '|') { out.push({ t: 'op', v: '||' }); i += 2; continue; }
      if (src[i + 1] === '&') { out.push({ t: 'op', v: '|&' }); i += 2; continue; }
      out.push({ t: 'op', v: '|' }); i++; continue;
    }
    if (c === ';') {
      push();
      if (src[i + 1] === ';') { out.push({ t: 'op', v: ';;' }); i += 2; continue; }
      out.push({ t: 'op', v: ';' }); i++; continue;
    }
    if (c === '(' || c === ')') { push(); out.push({ t: 'op', v: c }); i++; continue; }
    add(c); i++;
  }
  push();
  return out;
}

/** 把词法结果切成简单命令：[{ words, redirects:[{op,target,fd}], substs:[string] }]。 */
function simpleCommands(tokens) {
  const cmds = [];
  let cur = { words: [], redirects: [], substs: [] };
  const flush = () => { if (cur.words.length || cur.redirects.length) cmds.push(cur); cur = { words: [], redirects: [], substs: [] }; };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'subst') { cur.substs.push(tok.v); continue; }
    if (tok.t === 'op') {
      if (SEPARATORS.has(tok.v)) { flush(); continue; }
      const target = tokens[i + 1]?.t === 'word' ? tokens[++i].v : null;
      cur.redirects.push({ op: tok.v, target, fd: tok.fd ?? '' });
      continue;
    }
    if ((tok.v === '{' || tok.v === '}') && !cur.words.length) { flush(); continue; }
    cur.words.push(tok.v);
  }
  flush();
  return cmds;
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'nohup', 'time', 'exec', 'nice', 'ionice', 'stdbuf', 'caffeinate']);
// 包装命令里「后面跟一个值」的选项（sudo -u 用户、env -C 目录、nice -n 10…），跳过时连值一起跳
const WRAPPER_VALUE_OPTS = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '--class', '--classdata']),
  stdbuf: new Set(['-i', '-o', '-e']),
  caffeinate: new Set(['-t', '-w']),
  exec: new Set(['-a']),
};

/** 去掉前缀环境变量与包装命令，返回 { env, name, args }。 */
function unwrap(words) {
  const env = {};
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
      const eq = words[i].indexOf('=');
      env[words[i].slice(0, eq)] = words[i].slice(eq + 1);
      i++;
    }
    const w = words[i];
    if (w === undefined) return { env, name: null, args: [] };
    const b = path.basename(w);
    if (WRAPPERS.has(b)) {
      i++;
      const valueOpts = WRAPPER_VALUE_OPTS[b] ?? new Set();
      while (i < words.length && words[i].startsWith('-')) { i += valueOpts.has(words[i]) ? 2 : 1; }
      continue;
    }
    if (b === 'timeout') { i++; while (i < words.length && words[i].startsWith('-')) i++; i++; continue; }
    if (b === 'xargs') { i++; while (i < words.length && words[i].startsWith('-')) i++; continue; }
    return { env, name: w, args: words.slice(i + 1) };
  }
}

/** 位置参数：跳过选项，以及 valueOpts 里那些「后面跟一个值」的选项的值。 */
const positional = (args, valueOpts = new Set()) => {
  const out = [];
  let rest = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (rest) { out.push(a); continue; }
    if (a === '--') { rest = true; continue; }
    if (a.startsWith('-') && a !== '-') { if (valueOpts.has(a)) k++; continue; }
    out.push(a);
  }
  return out;
};
const nonOptions = args => positional(args);

const GIT_ALL_ARGS = new Set(['-A', '--all', '.', './', ':/', ':', '*', '--no-ignore-removal']);

function parseGit(args, cwd, resolve) {
  let i = 0;
  let gitCwd = cwd;
  while (i < args.length) {
    const a = args[i];
    if (a === '-C') { gitCwd = resolve(args[i + 1] ?? '.', gitCwd); i += 2; continue; }
    if (a === '-c') { i += 2; continue; }
    if (/^--(git-dir|work-tree|namespace|exec-path)(=|$)/.test(a)) { i += a.includes('=') ? 1 : 2; continue; }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  const sub = args[i] ?? null;
  const rest = args.slice(i + 1);
  const op = { sub, args: rest, cwd: gitCwd };
  if (sub === 'add') {
    op.all = rest.some(a => GIT_ALL_ARGS.has(a) || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(a));
    op.force = rest.some(a => a === '-f' || a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
  }
  if (sub === 'commit') op.all = rest.some(a => a === '-a' || a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a));
  op.destructive = (sub === 'reset' && rest.includes('--hard'))
    || (sub === 'clean' && rest.some(a => /^-[a-zA-Z]*f/.test(a)))
    || (sub === 'checkout' && (rest.includes('.') || rest.includes('--')))
    || (sub === 'restore' && rest.length > 0)
    || sub === 'stash';
  return op;
}

/**
 * 分析一条 Bash 命令。
 * @param {string} command
 * @param {{ cwd: string, home?: string }} options cwd 为执行前的工作目录（绝对路径）
 */
export function analyzeShell(command, { cwd, home = homeDir() } = {}) {
  const result = { commands: [], git: [], writes: [], reads: [], cwd, executable: false, unparsed: false };
  if (typeof command !== 'string' || !command.trim()) return result;
  let tokens;
  try { tokens = lex(command); } catch { result.unparsed = true; return result; }
  const resolve = (p, base) => {
    const e = expandHome(p, home);
    return path.isAbsolute(e) || /^[A-Za-z]:[\\/]/.test(e) ? path.normalize(e) : path.resolve(base, e);
  };
  let curCwd = cwd;
  const write = (p, via) => {
    if (!p || /^\/dev\//.test(p) || p === '-' || /^\d+$/.test(p) || p.includes('$(…)')) return;
    result.writes.push({ path: resolve(p, curCwd), via, raw: p });
  };
  const read = (p, via, lines = null) => {
    if (!p || p === '-' || /^\/dev\//.test(p)) return;
    result.reads.push({ path: resolve(p, curCwd), via, lines, raw: p });
  };

  for (const sc of simpleCommands(tokens)) {
    for (const inner of sc.substs) {
      const sub = analyzeShell(inner, { cwd: curCwd, home });
      result.git.push(...sub.git);
      result.writes.push(...sub.writes);
      result.reads.push(...sub.reads);
      result.executable ||= sub.executable;
    }
    for (const r of sc.redirects) {
      if (WRITE_REDIRECTS.has(r.op) || (r.op === '>&' && r.target && !/^(\d+|-)$/.test(r.target))) write(r.target, `重定向 ${r.fd}${r.op}`);
      if (r.op === '<' && r.target) read(r.target, '重定向 <');
    }
    const unwrapped = unwrap(sc.words);
    const { env, name } = unwrapped;
    let { args } = unwrapped;
    result.commands.push({ name, args, env, redirects: sc.redirects });
    if (!name) continue;
    const base = path.basename(name).replace(/\.exe$/i, '');
    const plain = nonOptions(args);

    if (base === 'cd' || base === 'pushd') { curCwd = resolve(plain[0] ?? home, curCwd); continue; }
    if (base === 'git') {
      const op = parseGit(args, curCwd, resolve);
      result.git.push(op);
      if (['checkout', 'restore', 'rm', 'mv'].includes(op.sub)) {
        const dd = op.args.indexOf('--');
        const paths = dd >= 0 ? op.args.slice(dd + 1) : nonOptions(op.args).slice(op.sub === 'checkout' ? 1 : 0);
        for (const p of paths) write(resolve(p, op.cwd), `git ${op.sub}`);
      }
      continue;
    }
    if (['tee'].includes(base)) { for (const p of plain) write(p, 'tee'); continue; }
    if (['cp', 'rsync', 'install', 'ln', 'scp', 'ditto'].includes(base)) {
      const t = args.findIndex(a => a === '-t' || a === '--target-directory');
      if (t >= 0 && args[t + 1]) write(args[t + 1], base);
      else { const te = args.find(a => a.startsWith('--target-directory=')); if (te) write(te.split('=')[1], base); else if (plain.length >= 2) write(plain[plain.length - 1], base); }
      continue;
    }
    if (base === 'mv') { for (const p of plain) write(p, 'mv'); continue; }
    if (['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'touch', 'mkdir', 'mktemp'].includes(base)) {
      if (base === 'mktemp') continue;
      for (const p of plain) write(p, base);
      continue;
    }
    if (['chmod', 'chown', 'chgrp'].includes(base)) { for (const p of plain.slice(1)) write(p, base); continue; }
    if (base === 'sed') {
      // BSD / macOS 的 sed -i 后面单独跟一个备份后缀（'' 或 .bak）；GNU 的 -i 不带值。后缀不能当成脚本或文件
      const bsdSuffix = args.findIndex((a, k) => a === '-i' && k + 1 < args.length && (args[k + 1] === '' || /^\.[\w~-]*$/.test(args[k + 1])));
      if (bsdSuffix >= 0) args = [...args.slice(0, bsdSuffix + 1), ...args.slice(bsdSuffix + 2)];
      const inPlace = args.some(a => a.startsWith('--in-place') || (/^-[a-zA-Z]*i/.test(a) && !a.startsWith('--')));
      const hasScriptOpt = args.some(a => a === '-e' || a === '-f' || a.startsWith('--expression') || a.startsWith('--file'));
      const pos = positional(args, new Set(['-e', '-f', '--expression', '--file', '-l', '--line-length']));
      const files = hasScriptOpt ? pos : pos.slice(1);
      if (inPlace) { for (const p of files) write(p, 'sed -i'); continue; }
      if (args.includes('-n')) {
        const script = hasScriptOpt ? null : pos[0];
        const m = script && /^(\d+)(?:,(\d+))?p$/.exec(script);
        const lines = m ? (m[2] ? Number(m[2]) - Number(m[1]) + 1 : 1) : null;
        for (const p of files) read(p, 'sed -n', lines);
      }
      continue;
    }
    if (base === 'perl') {
      if (args.some(a => /^-[a-zA-Z]*i/.test(a) && !a.startsWith('--'))) {
        const hasE = args.some(a => /^-[a-zA-Z]*[eE]$/.test(a));
        const pos = positional(args, new Set(['-e', '-E', '-pe', '-ne', '-pie', '-I', '-M', '-m']));
        for (const p of hasE ? pos : pos.slice(1)) write(p, 'perl -i');
      }
      continue;
    }
    if (base === 'dd') { for (const a of args) if (a.startsWith('of=')) write(a.slice(3), 'dd of='); continue; }
    if (base === 'tar') {
      if (args.some(a => /^-?[a-zA-Z]*x/.test(a))) {
        const c = args.findIndex(a => a === '-C' || a === '--directory');
        write(c >= 0 ? args[c + 1] : '.', 'tar -x');
      }
      continue;
    }
    if (base === 'unzip') { const d = args.indexOf('-d'); write(d >= 0 ? args[d + 1] : '.', 'unzip'); continue; }
    if (base === 'curl') { const o = args.findIndex(a => a === '-o' || a === '--output'); if (o >= 0) write(args[o + 1], 'curl -o'); continue; }
    if (base === 'wget') { const o = args.findIndex(a => a === '-O' || a === '--output-document'); if (o >= 0) write(args[o + 1], 'wget -O'); continue; }
    if (['cat', 'less', 'more', 'bat', 'nl'].includes(base)) { for (const p of plain) read(p, base); continue; }
    if (base === 'head' || base === 'tail') {
      let lines = 10;
      args.forEach((a, k) => {
        if ((a === '-n' || a === '--lines') && /^\d+$/.test(args[k + 1] ?? '')) lines = Number(args[k + 1]);
        else if (/^-n\d+$/.test(a)) lines = Number(a.slice(2));
        else if (/^-\d+$/.test(a)) lines = Number(a.slice(1));
        else if (a.startsWith('--lines=')) lines = Number(a.split('=')[1]);
      });
      for (const p of positional(args, new Set(['-n', '--lines', '-c', '--bytes']))) read(p, base, lines);
      continue;
    }
    if (isExecutable(base, name, args)) result.executable = true;
  }
  result.cwd = curCwd;
  return result;
}

const RUNNERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'py', 'pwsh', 'powershell', 'uv', 'deno', 'bun']);
const PROBE_ARGS = new Set(['--version', '-v', '-V', 'version', '--help', '-h', 'help']);

/** 「可执行命令」：调用仓库工具或脚本的命令；只查版本 / 帮助不算。 */
function isExecutable(base, name, args) {
  const probe = args.length > 0 && args.every(a => PROBE_ARGS.has(a));
  if (RUNNERS.has(base)) return args.length > 0 && !probe;
  if (base === 'sh' || base === 'bash' || base === 'zsh') return nonOptions(args).length > 0;
  if (name.includes('/') && !name.startsWith('/usr/') && !name.startsWith('/bin/')) return !probe;
  return false;
}
