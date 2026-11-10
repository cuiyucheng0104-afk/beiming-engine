// 北冥仓库 · REUSE 覆盖检查（按 REUSE 规范 3.3 的 REUSE.toml 写法离线复核，不需要安装 reuse 工具）。
// 检查四件事：每个文件都能查到许可与版权；用到的许可在 LICENSES/ 里有全文；LICENSES/ 里没有用不上的许可；
//             LICENSES/ 的文件名是合法的 SPDX 标识或 LicenseRef-*。
// 与官方 reuse lint 的差别：只支持 REUSE.toml（不读 .reuse/dep5 与 .license 旁注文件）；许可表达式只拆标识、不校验 SPDX 官方清单。
// 接口：
//   parseReuseToml(text) → { version, annotations: [{ path: [glob], precedence, copyright: [..], license }] }，语法不支持时抛错并给出行号
//   globToRegExp(glob)：* 不跨目录，** 跨目录，\* 是字面星号
//   headerInfo(text) → { licenses: [表达式], copyrights: [..] }：按 reuse 的做法在全文找 SPDX 标签，跳过 reuse 忽略块（开始、结束两个标记之间）的内容
//   reuseReport({ root, files, read }) → { problems: [{ level, file, message, hint }], stats }
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';

// reuse 规范明确忽略的文件：许可文件本身、REUSE.toml、LICENSES/ 目录、.git 等。
const IGNORED = [/^LICEN[CS]E([-.].*)?$/, /^COPYING([-.].*)?$/, /^REUSE\.toml$/, /\.license$/, /\.spdx(\.json)?$/];
export const isReuseIgnored = rel => rel.startsWith('LICENSES/') || rel.startsWith('.reuse/') || IGNORED.some(re => re.test(rel.split('/').pop()));

// ── TOML 子集：注释、[[annotations]]、key = "..." / '...' / 整数 / 字符串数组（可跨行）──
export function parseReuseToml(text) {
  const doc = { version: null, annotations: [] };
  let cur = doc;   // 顶层或当前 annotations 表
  const lines = text.split(/\r?\n/);
  let i = 0;
  const fail = (msg) => { throw new Error(`REUSE.toml 第 ${i + 1} 行：${msg}（检查器只支持注释、[[annotations]]、字符串、整数与字符串数组）`); };
  const parseString = (s, pos) => {
    const q = s[pos];
    if (q === "'") { const e = s.indexOf("'", pos + 1); if (e < 0) fail('单引号字符串没有闭合'); return [s.slice(pos + 1, e), e + 1]; }
    let out = '', j = pos + 1;
    for (; j < s.length && s[j] !== '"'; j++) {
      if (s[j] === '\\') {
        const n = s[++j];
        const map = { n: '\n', t: '\t', '"': '"', '\\': '\\', r: '\r' };
        if (n in map) out += map[n];
        else if (n === 'u') { out += String.fromCodePoint(parseInt(s.slice(j + 1, j + 5), 16)); j += 4; }
        else fail(`不支持的转义 \\${n}`);
      } else out += s[j];
    }
    if (s[j] !== '"') fail('双引号字符串没有闭合');
    return [out, j + 1];
  };
  const stripComment = s => {
    let inS = null;
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (inS) { if (c === '\\' && inS === '"') j++; else if (c === inS) inS = null; }
      else if (c === '"' || c === "'") inS = c;
      else if (c === '#') return s.slice(0, j);
    }
    return s;
  };
  for (; i < lines.length; i++) {
    const raw = stripComment(lines[i]).trim();
    if (!raw) continue;
    if (raw === '[[annotations]]') { cur = {}; doc.annotations.push(cur); continue; }
    if (raw.startsWith('[')) fail(`不支持的表头 ${raw}`);
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(raw);
    if (!m) fail(`看不懂这一行：${raw}`);
    const key = m[1];
    let rest = m[2];
    let value;
    if (rest.startsWith('[')) {
      // 数组可以跨多行，收集到右括号为止
      let buf = rest;
      while (!/\]\s*$/.test(stripComment(buf).trim())) {
        i++;
        if (i >= lines.length) fail('数组没有闭合');
        buf += '\n' + stripComment(lines[i]);
      }
      const body = stripComment(buf).trim().slice(1, -1);
      value = [];
      let p = 0;
      while (p < body.length) {
        const c = body[p];
        if (/[\s,]/.test(c)) { p++; continue; }
        if (c !== '"' && c !== "'") fail('数组里只能放字符串');
        const [s, np] = parseString(body, p);
        value.push(s); p = np;
      }
    } else if (rest.startsWith('"') || rest.startsWith("'")) {
      const [s, np] = parseString(rest, 0);
      if (rest.slice(np).trim()) fail('字符串后面有多余内容');
      value = s;
    } else if (/^-?\d+$/.test(rest)) value = Number(rest);
    else fail(`不支持的取值 ${rest}`);
    if (key in cur) fail(`重复的键 ${key}`);
    cur[key] = value;
  }
  doc.version = doc.version ?? null;
  doc.annotations = doc.annotations.map((a, k) => {
    const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
    const known = new Set(['path', 'precedence', 'SPDX-FileCopyrightText', 'SPDX-License-Identifier']);
    for (const key of Object.keys(a)) if (!known.has(key)) throw new Error(`REUSE.toml 第 ${k + 1} 个 [[annotations]]：不认识的键 ${key}`);
    const precedence = a.precedence || 'closest';
    if (!['closest', 'aggregate', 'override'].includes(precedence)) throw new Error(`REUSE.toml 第 ${k + 1} 个 [[annotations]]：precedence 只能是 closest / aggregate / override`);
    if (!arr(a.path).length) throw new Error(`REUSE.toml 第 ${k + 1} 个 [[annotations]]：缺 path`);
    return { path: arr(a.path), precedence, copyright: arr(a['SPDX-FileCopyrightText']), license: arr(a['SPDX-License-Identifier']), regexps: arr(a.path).map(globToRegExp) };
  });
  return doc;
}

export function globToRegExp(glob) {
  let re = '';
  for (let j = 0; j < glob.length; j++) {
    const c = glob[j];
    if (c === '\\' && glob[j + 1] === '*') { re += '\\*'; j++; }
    else if (c === '*' && glob[j + 1] === '*') { re += '.*'; j++; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// 许可表达式里的标识：拆掉 AND / OR / WITH 与括号。
export function licenseIds(expr) {
  return expr.replace(/[()]/g, ' ').split(/\s+/).filter(t => t && !/^(AND|OR|WITH)$/i.test(t));
}

// 与 reuse 一样在全文里找标签；忽略块（开始标记到结束标记之间）的内容不算。标记与标签都用拼接写法，免得本文件自己被当成声明。
const TAG_LIC = new RegExp('SPDX-' + 'License-Identifier:[ \\t]*(.*?)[ \\t]*(?:\\*/|-->|"\\s*$|\'\\s*$|\\s*$)', 'gm');
const TAG_CR = new RegExp('(?:SPDX-' + 'FileCopyrightText:|SPDX-' + 'SnippetCopyrightText:)[ \\t]*(.*?)[ \\t]*(?:\\*/|-->|$)', 'gm');
const IGNORE_BLOCK = new RegExp('REUSE-' + 'IgnoreStart[\\s\\S]*?(?:REUSE-' + 'IgnoreEnd|$)', 'g');
export function headerInfo(text) {
  const t = text.replace(IGNORE_BLOCK, '');
  const licenses = [], copyrights = [];
  for (const m of t.matchAll(TAG_LIC)) if (m[1]) licenses.push(m[1].trim());
  for (const m of t.matchAll(TAG_CR)) if (m[1]) copyrights.push(m[1].trim());
  return { licenses, copyrights };
}

const ID_OK = /^(LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.+-]*)$/;

export function reuseReport({ root, files, read }) {
  const problems = [];
  const err = (file, message, hint) => problems.push({ level: 'error', file, message, hint });
  const tomlPath = path.join(root, 'REUSE.toml');
  if (!fs.existsSync(tomlPath)) {
    err('REUSE.toml', '仓库根目录没有 REUSE.toml：无法按路径查到许可', '按 docs/rights/licensing.md 补上 REUSE.toml');
    return { problems, stats: null };
  }
  let doc;
  try { doc = parseReuseToml(fs.readFileSync(tomlPath, 'utf8')); } catch (e) {
    err('REUSE.toml', e.message, '照 REUSE 规范 3.3 的写法改；只用字符串、整数和字符串数组');
    return { problems, stats: null };
  }
  if (doc.version !== 1) err('REUSE.toml', `version 应为 1，现在是 ${doc.version}`, '第一行写 version = 1');
  const licDir = path.join(root, 'LICENSES');
  const licFiles = fs.existsSync(licDir) ? fs.readdirSync(licDir).filter(f => !f.startsWith('.')) : [];
  const available = new Map();   // 标识 → 文件名
  for (const f of licFiles) {
    const id = f.replace(/\.[^.]+$/, '');
    if (!ID_OK.test(id) || !/\.(txt|md)$/i.test(f)) err(`LICENSES/${f}`, `LICENSES/ 里的文件名不是合法许可标识：${f}`, '文件名写成 <SPDX 标识>.txt，自定义许可写成 LicenseRef-<名字>.txt');
    available.set(id, f);
  }
  const used = new Map();        // 标识 → 首个用到它的文件
  const useId = (expr, file) => { for (const id of licenseIds(expr)) if (!used.has(id)) used.set(id, file); };
  let covered = 0, viaHeader = 0;
  const uncovered = [];
  for (const rel of files) {
    if (isReuseIgnored(rel)) continue;
    let ann = null;
    for (const a of doc.annotations) if (a.regexps.some(re => re.test(rel))) ann = a;   // 后写的条目优先
    let hdr = { licenses: [], copyrights: [] };
    if (!ann || ann.precedence !== 'override') {
      const e = read(rel);
      if (e && e.text != null) hdr = headerInfo(e.text);
    }
    let lic = [], cr = [];
    if (ann && ann.precedence === 'override') { lic = ann.license; cr = ann.copyright; }
    else if (ann && ann.precedence === 'aggregate') { lic = [...ann.license, ...hdr.licenses]; cr = [...ann.copyright, ...hdr.copyrights]; }
    else { lic = hdr.licenses.length ? hdr.licenses : (ann ? ann.license : []); cr = hdr.copyrights.length ? hdr.copyrights : (ann ? ann.copyright : []); }
    if (hdr.licenses.length) viaHeader++;
    for (const l of lic) useId(l, rel);
    if (lic.length && cr.length) covered++;
    else uncovered.push({ rel, missing: [!lic.length && '许可', !cr.length && '版权'].filter(Boolean).join('与') });
  }
  // 未覆盖的文件按目录归并，避免一次刷几百行
  const groups = new Map();
  for (const u of uncovered) {
    const dir = u.rel.includes('/') ? u.rel.split('/').slice(0, 2).join('/') : u.rel;
    const g = groups.get(dir) || { n: 0, sample: u.rel, missing: u.missing };
    g.n++; groups.set(dir, g);
  }
  for (const [dir, g] of groups) err(g.sample, `${g.n} 个文件查不到${g.missing}信息（${dir}${g.n > 1 ? ' 等' : ''}）`, '在 REUSE.toml 里给这些路径加一条 [[annotations]]，或在文件头写 SPDX 许可与版权行');
  for (const [id, file] of used) if (!available.has(id)) err(file, `用到的许可 ${id} 在 LICENSES/ 里没有全文`, `把 ${id} 的许可全文放到 LICENSES/${id}.txt`);
  for (const [id, f] of available) if (!used.has(id)) err(`LICENSES/${f}`, `LICENSES/${f} 没有任何文件用到`, '删掉它，或在 REUSE.toml 里给用到它的路径标上');
  return { problems, stats: { files: files.length, covered, viaHeader, uncovered: uncovered.length, licenses: [...used.keys()].sort() } };
}
