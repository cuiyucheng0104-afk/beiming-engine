// 北冥仓库 · agent 护栏的命令行切分（只做静态切词，不执行任何东西）
// 做什么：把 Bash / PowerShell 命令行切成"简单命令"列表：每条有 words（去掉引号后的词）、
//         redirs（重定向，含写入目标）、sep（与下一条的连接符），另返回 subs：$(…)、`…`、<(…) 里的子脚本，
//         由调用方递归分析。heredoc 正文与 here-string 当数据跳过（提交说明里写 "git add -A" 不会误报）。
// 接口：parseBash(src) → { cmds, subs }；parsePwsh(src) → { cmds, subs }。
//       cmds 里还可能有 { group: 'open' | 'close' }，表示子 shell 的开始与结束（给 cd 追踪用）。
// 局限：这是保守的近似解析，不展开变量和通配符；无法静态判断的写法按"看不懂就不拦"处理，由权限规则与 pre-commit 兜底。

const BASH_WS = new Set([' ', '\t', '\r']);

/** 从 src[start] 处的 "$(" 或 "<(" / ">(" 的 "(" 之后开始，找到配对的 ")"，返回其下标（理解引号、嵌套与 heredoc）。 */
function scanParen(src, start) {
  let depth = 1;
  let i = start;
  const heredocs = [];
  let atWordStart = true;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; atWordStart = false; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j + 1; atWordStart = false; continue; }
    if (c === '"') { i = scanDouble(src, i + 1).end; atWordStart = false; continue; }
    if (c === '`') { i = scanBacktick(src, i + 1).end; atWordStart = false; continue; }
    if (c === '#' && atWordStart) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') {
      i++;
      i = skipHeredocBodies(src, i, heredocs);
      atWordStart = true;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const strip = src[i + 2] === '-';
      let j = i + (strip ? 3 : 2);
      while (BASH_WS.has(src[j])) j++;
      const { word, end } = readPlainWord(src, j);
      if (word) heredocs.push({ delim: word, strip });
      i = end; atWordStart = false; continue;
    }
    if (c === '$' && src[i + 1] === '(') { depth++; i += 2; atWordStart = true; continue; }
    if (c === '(') { depth++; i++; atWordStart = true; continue; }
    if (c === ')') { depth--; if (depth === 0) return i; i++; atWordStart = false; continue; }
    atWordStart = BASH_WS.has(c) || c === ';' || c === '|' || c === '&';
    i++;
  }
  return src.length;
}

/** 双引号内：返回 { text, end, subs }，end 指向收尾引号之后。 */
function scanDouble(src, i) {
  let text = '';
  const subs = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return { text, end: i + 1, subs };
    if (c === '\\' && i + 1 < src.length) {
      const n = src[i + 1];
      if (n === '\n') { i += 2; continue; }
      if ('$`"\\'.includes(n)) { text += n; i += 2; continue; }
      text += c; i++; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const end = scanParen(src, i + 2);
      subs.push(src.slice(i + 2, end));
      text += src.slice(i, end + 1);
      i = end + 1; continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      const end = src.indexOf('}', i + 2);
      const stop = end < 0 ? src.length : end + 1;
      text += src.slice(i, stop); i = stop; continue;
    }
    if (c === '`') {
      const r = scanBacktick(src, i + 1);
      subs.push(r.text);
      text += '`' + r.text + '`';
      i = r.end; continue;
    }
    text += c; i++;
  }
  return { text, end: src.length, subs };
}

function scanBacktick(src, i) {
  let text = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { text += src[i + 1]; i += 2; continue; }
    if (c === '`') return { text, end: i + 1 };
    text += c; i++;
  }
  return { text, end: src.length };
}

/** 读 heredoc 定界词（可带引号），返回去引号后的词。 */
function readPlainWord(src, i) {
  let word = '';
  while (i < src.length) {
    const c = src[i];
    if (BASH_WS.has(c) || c === '\n' || c === ';' || c === '|' || c === '&' || c === '<' || c === '>' || c === ')' || c === '(') break;
    if (c === "'") { const j = src.indexOf("'", i + 1); const e = j < 0 ? src.length : j; word += src.slice(i + 1, e); i = e + 1; continue; }
    if (c === '"') { const r = scanDouble(src, i + 1); word += r.text; i = r.end; continue; }
    if (c === '\\') { word += src[i + 1] ?? ''; i += 2; continue; }
    word += c; i++;
  }
  return { word, end: i };
}

/** 换行之后：依次跳过登记过的 heredoc 正文，返回正文之后的下标。 */
function skipHeredocBodies(src, i, heredocs) {
  while (heredocs.length) {
    const { delim, strip } = heredocs.shift();
    for (;;) {
      if (i >= src.length) return src.length;
      let nl = src.indexOf('\n', i);
      if (nl < 0) nl = src.length;
      let line = src.slice(i, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (strip) line = line.replace(/^\t+/, '');
      i = nl + 1;
      if (line === delim) break;
    }
  }
  return i;
}

/**
 * 切分 Bash（及 sh / zsh 的常见写法）。
 * @returns {{cmds: Array<{words:string[], redirs:{op:string,target:string}[], sep:string|null}|{group:string}>, subs:string[]}}
 */
export function parseBash(src) {
  src = String(src ?? '');
  const cmds = [];
  const subs = [];
  let words = [];
  let redirs = [];
  let cur = '';
  let has = false;
  let pending = null;            // 等待目标词的重定向
  const heredocs = [];
  let i = 0;

  const pushWord = () => {
    if (!has) return;
    if (pending) {
      if (pending.op === '<<' || pending.op === '<<-') heredocs.push({ delim: cur, strip: pending.op === '<<-' });
      else if (pending.op === '>&' || pending.op === '<&') { if (!/^(\d+|-)$/.test(cur)) redirs.push({ op: pending.op, target: cur }); }
      else if (pending.op !== '<<<') redirs.push({ op: pending.op, target: cur });
      pending = null;
    } else if (cur === '{' || cur === '}') {
      // 当前 shell 里的命令组：不影响 cd 追踪
    } else {
      words.push(cur);
    }
    cur = ''; has = false;
  };
  const endCmd = (sep) => {
    pushWord();
    if (words.length || redirs.length) cmds.push({ words, redirs, sep });
    words = []; redirs = [];
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\\') {
      if (n === '\n') { i += 2; continue; }
      if (n === undefined) { i++; continue; }
      cur += n; has = true; i += 2; continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const e = j < 0 ? src.length : j;
      cur += src.slice(i + 1, e); has = true; i = e + 1; continue;
    }
    if (c === '$' && n === "'") {
      let j = i + 2; let text = '';
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          const m = src[j + 1];
          text += m === 'n' ? '\n' : m === 't' ? '\t' : m; j += 2; continue;
        }
        text += src[j]; j++;
      }
      cur += text; has = true; i = j + 1; continue;
    }
    if (c === '"' || (c === '$' && n === '"')) {
      const r = scanDouble(src, i + (c === '$' ? 2 : 1));
      cur += r.text; has = true; subs.push(...r.subs); i = r.end; continue;
    }
    if (c === '`') {
      const r = scanBacktick(src, i + 1);
      subs.push(r.text); cur += '`' + r.text + '`'; has = true; i = r.end; continue;
    }
    if (c === '$' && n === '(') {
      const end = scanParen(src, i + 2);
      subs.push(src.slice(i + 2, end));
      cur += src.slice(i, end + 1); has = true; i = end + 1; continue;
    }
    if (c === '$' && n === '{') {
      let depth = 1; let j = i + 2;
      while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      cur += src.slice(i, j); has = true; i = j; continue;
    }
    if ((c === '<' || c === '>') && n === '(') {
      const end = scanParen(src, i + 2);
      subs.push(src.slice(i + 2, end));
      cur += '<(…)'; has = true; i = end + 1; continue;
    }
    if (c === '#' && !has) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (BASH_WS.has(c)) { pushWord(); i++; continue; }
    if (c === '\n') {
      endCmd('\n'); i++;
      i = skipHeredocBodies(src, i, heredocs);
      continue;
    }
    if (c === ';') { endCmd(';'); i += n === ';' ? 2 : 1; continue; }
    if (c === '&' && n === '&') { endCmd('&&'); i += 2; continue; }
    if (c === '|' && n === '|') { endCmd('||'); i += 2; continue; }
    if (c === '|') { endCmd('|'); i += n === '&' ? 2 : 1; continue; }
    if (c === '&' && n === '>') {
      pushWord();
      const op = src[i + 2] === '>' ? '&>>' : '&>';
      pending = { op }; i += op.length; continue;
    }
    if (c === '&') { endCmd('&'); i++; continue; }
    if (c === '(' && !has) { endCmd(null); cmds.push({ group: 'open' }); i++; continue; }
    if (c === ')') { endCmd(null); cmds.push({ group: 'close' }); i++; continue; }
    if (c === '<' || c === '>') {
      if (has && /^\d+$/.test(cur) && !pending) { cur = ''; has = false; } else pushWord();
      let op;
      if (c === '>') op = n === '>' ? '>>' : n === '|' ? '>|' : n === '&' ? '>&' : '>';
      else op = n === '<' ? (src[i + 2] === '<' ? '<<<' : src[i + 2] === '-' ? '<<-' : '<<') : n === '>' ? '<>' : n === '&' ? '<&' : '<';
      pending = { op }; i += op.length; continue;
    }
    cur += c; has = true; i++;
  }
  endCmd(null);
  return { cmds, subs };
}

/**
 * 切分 PowerShell（Windows 上 Claude Code 的 PowerShell 工具）。规则比 Bash 简单：
 * '…'（'' 转义）、"…"（反引号转义，$(…) 子表达式）、@'…'@ / @"…"@ here-string 当数据；
 * ; | && || 换行 { } ( ) 都当命令分隔；# 与 <# … #> 注释；> >> 2> *> 重定向。
 */
export function parsePwsh(src) {
  src = String(src ?? '');
  const cmds = [];
  const subs = [];
  let words = [];
  let redirs = [];
  let cur = '';
  let has = false;
  let pending = null;
  let i = 0;
  const pushWord = () => {
    if (!has) return;
    if (pending) { if (!/^&\d$/.test(cur)) redirs.push({ op: pending.op, target: cur }); pending = null; }
    else words.push(cur);
    cur = ''; has = false;
  };
  const endCmd = (sep) => {
    pushWord();
    if (words.length || redirs.length) cmds.push({ words, redirs, sep });
    words = []; redirs = [];
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '`') {
      if (n === '\n') { i += 2; continue; }
      if (n === '\r' && src[i + 2] === '\n') { i += 3; continue; }
      cur += n ?? ''; has = true; i += 2; continue;
    }
    if (c === '@' && (n === "'" || n === '"') && (src[i + 2] === '\n' || src[i + 2] === '\r')) {
      const close = '\n' + n + '@';
      const j = src.indexOf(close, i + 2);
      const e = j < 0 ? src.length : j + close.length;
      cur += '<here-string>'; has = true; i = e; continue;
    }
    if (c === "'") {
      let j = i + 1; let text = '';
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { text += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        text += src[j]; j++;
      }
      cur += text; has = true; i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let text = '';
      while (j < src.length) {
        const d = src[j];
        if (d === '`' && j + 1 < src.length) { text += src[j + 1]; j += 2; continue; }
        if (d === '"' && src[j + 1] === '"') { text += '"'; j += 2; continue; }
        if (d === '"') break;
        if (d === '$' && src[j + 1] === '(') {
          const end = scanPwshParen(src, j + 2);
          subs.push(src.slice(j + 2, end));
          text += src.slice(j, end + 1); j = end + 1; continue;
        }
        text += d; j++;
      }
      cur += text; has = true; i = j + 1; continue;
    }
    if (c === '$' && n === '(') {
      const end = scanPwshParen(src, i + 2);
      subs.push(src.slice(i + 2, end));
      cur += src.slice(i, end + 1); has = true; i = end + 1; continue;
    }
    if (c === '<' && n === '#') { const j = src.indexOf('#>', i + 2); i = j < 0 ? src.length : j + 2; continue; }
    if (c === '#' && !has) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(); i++; continue; }
    if (c === '\n' || c === ';' || c === '{' || c === '}' || c === '(' || c === ')') { endCmd(c === '\n' ? '\n' : ';'); i++; continue; }
    if (c === '&' && n === '&') { endCmd('&&'); i += 2; continue; }
    if (c === '|' && n === '|') { endCmd('||'); i += 2; continue; }
    if (c === '|') { endCmd('|'); i++; continue; }
    if (c === '>' || ((c === '*' || /\d/.test(c)) && n === '>' && !has)) {
      pushWord();
      let j = i;
      if (c !== '>') j++;
      const op = src[j + 1] === '>' ? '>>' : '>';
      j += op.length;
      if (src[j] === '&') {            // 2>&1 之类：流合并，没有文件
        i = j + 2; continue;
      }
      pending = { op }; i = j; continue;
    }
    cur += c; has = true; i++;
  }
  endCmd(null);
  return { cmds, subs };
}

function scanPwshParen(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '`') { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j + 1; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '`' ? 2 : 1;
      i = j + 1; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return src.length;
}
