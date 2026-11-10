// 北冥仓库 · 派生代码检查：MIT 目录里的代码与 cases/vendor 两套上游快照逐段比对，找出「与上游雷同却没写来源头」的文件。
// 做法：去注释，标识符统一记成 I、字符串记成 S、数字按数值归一，保留关键字与运算符；
//       对记号序列取 K 元组哈希，把命中的位置按「对角线」（上游位置 − 本仓位置）串成连续片段。
//       改变量名、改空白、改引号都不影响结果；clamp 这类一两行的通用写法达不到阈值。
// 判定（对每个本仓文件，取与它最像的一个上游文件）：
//   error：最长连续相同片段 ≥ 200 个记号，或「与同一个上游文件相同的内容占本文件 ≥ 40%」且最长片段 ≥ 48 个记号；
//   warn ：最长片段 ≥ 90 个记号，或相同内容占比 ≥ 30% 且最长片段 ≥ 32 个记号——交人判断是派生还是通用写法；
//   已写来源头（LemoLab / lemo-opuscar / 肖雄 / sy-style-100 / @provenance 等）的文件不报。
// 接口：
//   tokenize(text, rel) → { toks: string[], lines: number[] }
//   findDerived(targets, vendor) → [{ file, vendor, run, coverage, level, lines:[起,止], vendorLines, attributed }]
//   levelOf({ run, coverage }) → 'error' | 'warn' | null
//   hasAttribution(text) / provenanceHeaderProblems(text) → 来源头是否齐全
// 方法参考：Schleimer 等《Winnowing: Local Algorithms for Document Fingerprinting》（SIGMOD 2003）的 K 元组指纹思路，未复制任何实现。
// SPDX-License-Identifier: MIT

export const K = 16;                 // 指纹窗口（记号数）
export const THRESHOLDS = Object.freeze({ errorRun: 200, errorCoverage: 0.4, errorCoverageRun: 48, warnRun: 90, warnCoverage: 0.3, warnCoverageRun: 32 });
export function levelOf({ run, coverage }, t = THRESHOLDS) {
  if (run >= t.errorRun || (coverage >= t.errorCoverage && run >= t.errorCoverageRun)) return 'error';
  if (run >= t.warnRun || (coverage >= t.warnCoverage && run >= t.warnCoverageRun)) return 'warn';
  return null;
}
const RANK = { error: 2, warn: 1 };

const CODE_RE = /\.(m?js|cjs|jsx|ts|tsx|py|glsl|vert|frag|wgsl|wesl|sh|html?)$/i;
export const isCode = rel => CODE_RE.test(rel);

const JS_KW = new Set(('break case catch class const continue debugger default delete do else export extends finally for function if ' +
  'import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set ' +
  'true false null undefined NaN Infinity Math').split(' '));
const PY_KW = new Set(('False None True and as assert async await break class continue def del elif else except finally for from ' +
  'global if import in is lambda nonlocal not or pass raise return try while with yield self np').split(' '));
const GLSL_KW = new Set(('uniform varying attribute in out inout const float int bool vec2 vec3 vec4 mat2 mat3 mat4 sampler2D void ' +
  'return if else for while discard precision highp mediump lowp struct').split(' '));

const langOf = rel => {
  const e = rel.toLowerCase();
  if (/\.py$/.test(e)) return 'py';
  if (/\.sh$/.test(e)) return 'sh';
  if (/\.(glsl|vert|frag|wgsl|wesl)$/.test(e)) return 'glsl';
  return 'js';
};

// 只取 HTML 里内联 <script> 的内容，避免标签骨架互相雷同。
function scriptsOf(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(html));) out.push({ start: m.index + m[0].indexOf('>') + 1, body: m[1] });
  return out;
}

const OPS = ['>>>=', '===', '!==', '**=', '<<=', '>>=', '>>>', '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '**',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '//', '::'];

// 返回 { toks: string[], lines: number[] }，lines[i] 是第 i 个记号所在行号（1 起）。
export function tokenize(text, rel) {
  const lang = langOf(rel);
  if (/\.html?$/i.test(rel)) {
    const toks = [], lines = [];
    for (const s of scriptsOf(text)) {
      const base = text.slice(0, s.start).split('\n').length - 1;
      const t = tokenizeCode(s.body, 'js');
      for (let i = 0; i < t.toks.length; i++) { toks.push(t.toks[i]); lines.push(t.lines[i] + base); }
    }
    return { toks, lines };
  }
  return tokenizeCode(text, lang);
}

function tokenizeCode(src, lang) {
  const kw = lang === 'py' ? PY_KW : lang === 'glsl' ? GLSL_KW : JS_KW;
  const hashComment = lang === 'py' || lang === 'sh';
  const toks = [], lines = [];
  let i = 0, line = 1;
  const n = src.length;
  const push = (t) => { toks.push(t); lines.push(line); };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    // 注释
    if (hashComment && c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (!hashComment && c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (!hashComment && c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    // 字符串（含 Python 三引号与 JS 模板串）
    if (c === '"' || c === "'" || c === '`') {
      const triple = lang === 'py' && src.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      i += q.length;
      while (i < n && !src.startsWith(q, i)) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') { line++; if (!triple && c !== '`') break; }
        i++;
      }
      i += q.length;
      push('S');
      continue;
    }
    // 数字
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      if (c === '0' && /[xXbBoO]/.test(src[i + 1] || '')) { j += 2; while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++; push(src.slice(i, j).toLowerCase()); i = j; continue; }
      while (j < n && /[0-9._eE]/.test(src[j])) { if ((src[j] === 'e' || src[j] === 'E') && /[+-]/.test(src[j + 1] || '')) j++; j++; }
      const raw = src.slice(i, j).replace(/_/g, '');
      const v = Number(raw);
      push(Number.isFinite(v) ? String(v) : raw);
      while (j < n && /[nfFuUlL]/.test(src[j])) j++;   // 1n、1.0f、10u
      i = j; continue;
    }
    // 标识符 / 关键字
    if (/[A-Za-z_$À-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$À-￿]/.test(src[j])) j++;
      const w = src.slice(i, j);
      push(kw.has(w) ? w : 'I');
      i = j; continue;
    }
    // 运算符与标点
    let op = c;
    for (const o of OPS) if (src.startsWith(o, i)) { op = o; break; }
    push(op);
    i += op.length;
  }
  return { toks, lines };
}

// 32 位 FNV-1a 记号窗口哈希（位置无关，只看内容）
function hashWindow(toks, start) {
  let h = 0x811c9dc5;
  for (let t = start; t < start + K; t++) {
    const s = toks[t];
    for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); }
    h ^= 0x1f; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const ATTR_RE = /LemoLab|lemo-opuscar|XIAOXIONG|肖雄|sy-style-100|@provenance|Portions Copyright|派生自|改写自/i;
export function hasAttribution(text) {
  return ATTR_RE.test(text.slice(0, 6000));
}
// 带 @provenance 标记的文件必须同时写许可标识与版权行，否则来源头不完整。
const LIC_TAG = new RegExp('SPDX-' + 'License-Identifier:');
const CR_TAG = new RegExp('SPDX-' + 'FileCopyrightText:|Copyright \\(c\\)|Portions Copyright', 'i');
export function provenanceHeaderProblems(text) {
  const head = text.slice(0, 6000);
  if (!/@provenance/.test(head)) return [];
  const probs = [];
  if (!LIC_TAG.test(head)) probs.push('缺许可标识行');
  if (!CR_TAG.test(head)) probs.push('缺上游版权行');
  return probs;
}

// targets：[{ rel, text }]（本仓要查的代码）；vendor：[{ rel, text }]（上游快照）。
export function findDerived(targets, vendor, { thresholds = THRESHOLDS, maxHitsPerHash = 40 } = {}) {
  // 1) 给本仓代码建 K 元组索引（量小）
  const T = targets.map(t => ({ ...t, ...tokenize(t.text, t.rel) }));
  const index = new Map();
  T.forEach((t, fi) => {
    for (let p = 0; p + K <= t.toks.length; p++) {
      const h = hashWindow(t.toks, p);
      let arr = index.get(h);
      if (!arr) index.set(h, (arr = []));
      if (arr.length < maxHitsPerHash) arr.push(fi, p);
    }
  });
  // 2) 流式扫描上游快照，记录命中（本仓文件, 上游文件, 本仓位置, 上游位置）
  const pairs = new Map();   // key = fi*100000+vi → [rp, vp, rp, vp, ...]
  const V = [];
  vendor.forEach((v, vi) => {
    const toks = tokenize(v.text, v.rel).toks;
    V.push(v);
    for (let p = 0; p + K <= toks.length; p++) {
      const arr = index.get(hashWindow(toks, p));
      if (!arr) continue;
      for (let a = 0; a < arr.length; a += 2) {
        const fi = arr[a], rp = arr[a + 1];
        const rt = T[fi].toks;              // 哈希碰撞复核：逐记号比一遍
        let same = true;
        for (let k = 0; k < K; k++) if (rt[rp + k] !== toks[p + k]) { same = false; break; }
        if (!same) continue;
        const key = fi * 100000 + vi;
        let hits = pairs.get(key);
        if (!hits) pairs.set(key, (hits = []));
        hits.push(rp, p);
      }
    }
  });
  // 3) 同一对文件里，按对角线把相邻命中串成连续片段；算最长片段与覆盖率
  const best = new Map();    // fi → 级别最高、片段最长的一条
  for (const [key, hits] of pairs) {
    const fi = Math.floor(key / 100000), vi = key % 100000;
    const byDiag = new Map();
    for (let h = 0; h < hits.length; h += 2) {
      const d = hits[h + 1] - hits[h];
      let arr = byDiag.get(d);
      if (!arr) byDiag.set(d, (arr = []));
      arr.push(hits[h]);
    }
    let top = null;
    const covered = new Set();
    for (const [d, rps] of byDiag) {
      rps.sort((a, b) => a - b);
      let s = rps[0], e = rps[0];
      const flush = () => {
        const len = e - s + K;
        if (len >= 2 * K) for (let x = s; x < s + len; x++) covered.add(x);
        if (!top || len > top.run) top = { run: len, rs: s, re: s + len - 1, vs: s + d, ve: s + d + len - 1 };
      };
      for (let k = 1; k < rps.length; k++) {
        if (rps[k] - e <= 2) e = rps[k];
        else { flush(); s = e = rps[k]; }
      }
      flush();
    }
    const t = T[fi];
    const coverage = Math.round((covered.size / Math.max(1, t.toks.length)) * 100) / 100;
    const level = levelOf({ run: top.run, coverage }, thresholds);
    if (!level) continue;
    const cur = best.get(fi);
    if (cur && (RANK[cur.level] > RANK[level] || (cur.level === level && cur.run >= top.run))) continue;
    const vl = tokenize(V[vi].text, V[vi].rel).lines;
    best.set(fi, {
      file: t.rel, vendor: V[vi].rel, run: top.run, coverage, level,
      lines: [t.lines[top.rs], t.lines[Math.min(top.re, t.lines.length - 1)]],
      vendorLines: [vl[top.vs], vl[Math.min(top.ve, vl.length - 1)]],
      attributed: hasAttribution(t.text),
    });
  }
  return [...best.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || b.run - a.run || a.file.localeCompare(b.file));
}
