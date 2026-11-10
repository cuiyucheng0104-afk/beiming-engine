// 北冥仓库 · 确定性静态扫描：渲染路径里不许出现会让「同一个 t 画出不同的图」的写法。
//   Math.random、Date.now、performance.now、new Date、crypto.getRandomValues
// 注释与字符串里的字样不算。允许的两种情况：
//   1) 同一行或上一行写 `// determinism-ok: <理由>`（例如只用于计时打日志）
//   2) tools/baseline/determinism-allow.json 里登记的存量问题（写明理由与谁来修），只减不增
//
//   scanFiles(root, files, allow) → { findings: [{ file, line, col, api, text, allowed, reason? }], errors, allowedCount }
//   defaultTargets(root)          → 默认扫描范围：engine 下浏览器端代码 + films/** + routes 模版（不含 Node 端工具、out/、node_modules）
//   listFiles(root, rels)         → 展开目录，只取 .js .mjs .ts .tsx .html
import fs from 'node:fs';
import path from 'node:path';

export const APIS = [
  { api: 'Math.random', re: /\bMath\s*\.\s*random\b/g },
  { api: 'Date.now', re: /\bDate\s*\.\s*now\b/g },
  { api: 'performance.now', re: /\bperformance\s*\.\s*now\b/g },
  { api: 'new Date', re: /\bnew\s+Date\b/g },
  { api: 'crypto.getRandomValues', re: /\bgetRandomValues\b/g },
];
const EXT = new Set(['.js', '.mjs', '.ts', '.tsx', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'out', '.git', '__pycache__', 'tools']);
// engine 下跑在 Node 里的部分（渲染驱动、生产契约、原生桥）不在浏览器渲染路径上
const NODE_SIDE = [/^engine\/render\//, /^engine\/production\//, /^engine\/native\/bridge\//, /^engine\/native\/[^/]+\.mjs$/, /^engine\/audio\//];

// 把注释、字符串字面量替换成空格（保留换行与列号），只留代码
export function stripCode(src) {
  let out = '', i = 0, state = 'code', quote = '';
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += '\n'; } else out += ' '; i++; continue; }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    // 字符串：模版字符串里的 ${…} 当代码看
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (quote === '`' && c === '$' && n === '{') {
      let depth = 1, j = i + 2;
      while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      out += '  ' + stripCode(src.slice(i + 2, j - 1)) + ' '; i = j; continue;
    }
    if (c === quote) { state = 'code'; out += ' '; i++; continue; }
    out += c === '\n' ? '\n' : ' '; i++;
  }
  return out;
}

// HTML 只看 <script> 里的内容（其余替换成空格，保留行号）
function scriptOnly(html) {
  let out = '', last = 0;
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const start = m.index + m[0].indexOf(m[1]);
    out += html.slice(last, start).replace(/[^\n]/g, ' ') + m[1];
    last = start + m[1].length;
  }
  return out + html.slice(last).replace(/[^\n]/g, ' ');
}

export function listFiles(root, rels) {
  const out = [];
  const walk = abs => {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isFile()) { if (EXT.has(path.extname(abs).toLowerCase())) out.push(abs); return; }
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))) continue;
      walk(path.join(abs, e.name));
    }
  };
  for (const r of rels) walk(path.join(root, r));
  return [...new Set(out)].map(f => path.relative(root, f).split(path.sep).join('/'))
    .filter(r => !NODE_SIDE.some(re => re.test(r))).sort();
}

export function defaultTargets(root) {
  const t = ['engine'];
  if (fs.existsSync(path.join(root, 'films'))) t.push('films');
  for (const r of ['routes/a-webgl/template', 'routes/b-native/template', 'routes/c-style/template']) if (fs.existsSync(path.join(root, r))) t.push(r);
  return t;
}

export function loadAllow(file) {
  if (!fs.existsSync(file)) return [];
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (j.allow || []).map(a => ({ ...a, re: new RegExp(a.match) }));
}

export function scanFiles(root, files, allow = []) {
  const findings = [];
  for (const rel of files) {
    const raw = fs.readFileSync(path.join(root, rel), 'utf8');
    const src = rel.endsWith('.html') ? scriptOnly(raw) : raw;
    const code = stripCode(src).split('\n'), lines = raw.split('\n');
    code.forEach((line, i) => {
      for (const { api, re } of APIS) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          const text = (lines[i] || '').trim();
          const ok = /determinism-ok\s*:\s*\S/.test(lines[i] || '') || /determinism-ok\s*:\s*\S/.test(lines[i - 1] || '');
          const a = allow.find(x => x.file === rel && x.api === api && x.re.test(text));
          findings.push({ file: rel, line: i + 1, col: m.index + 1, api, text: text.slice(0, 160), allowed: ok || !!a, ...(a ? { reason: a.reason, owner: a.owner } : ok ? { reason: '行内 determinism-ok' } : {}) });
        }
      }
    });
  }
  const errors = findings.filter(f => !f.allowed);
  return { findings, errors, allowedCount: findings.length - errors.length, files: files.length };
}
