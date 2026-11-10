// 北冥仓库 · 规范检查 · Markdown 工具：给规则用的只读解析，保证报告的行号与原文一致。
//   maskCode(text)       把 ``` 围栏代码块与 `行内代码` 换成等长空白（保留换行），正文规则用它排除代码
//   maskFences(text)     只遮围栏代码块（标题、链接文字里的行内代码要保留时用）
//   links(text)          [{ target, line, label }]：行内链接 [x](y)、图片 ![x](y)、引用定义 [x]: y（代码里的不算）
//   headings(text)       [{ level, text, line, slug }]：ATX 标题（# …），slug 按 GitHub 的规则生成（重名加 -1、-2）
//   fences(text)         [{ lang, startLine, lines: [{ text, line }] }]：围栏代码块
//   inlineCode(text)     [{ code, line }]：行内代码（围栏外）
//   slugify(text)        GitHub 风格锚点：小写、去掉标点与符号、空格换成 -
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

function blank(s) { return s.replace(/[^\n]/g, ' '); }

/** 逐行扫描围栏；返回每行是否在围栏内（含围栏标记行）。 */
function fenceMap(lines) {
  const inside = new Array(lines.length).fill(false);
  let open = null;
  lines.forEach((l, i) => {
    const m = FENCE_RE.exec(l);
    if (open) {
      inside[i] = true;
      if (m && m[2][0] === open[0] && m[2].length >= open.length && !m[3].trim()) open = null;
    } else if (m) { inside[i] = true; open = m[2]; }
  });
  return inside;
}

export function maskFences(text) {
  const lines = text.split('\n');
  const inside = fenceMap(lines);
  return lines.map((l, i) => (inside[i] ? blank(l) : l)).join('\n');
}

export function maskCode(text) {
  return maskFences(text).replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, m => blank(m));
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

export function links(text) {
  const body = maskCode(text);
  const out = [];
  for (const m of body.matchAll(/!?\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
    out.push({ target: m[2].replace(/^<|>$/g, ''), line: lineAt(body, m.index), label: m[1] });
  }
  for (const m of body.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]*>|\S+)/gm)) {
    out.push({ target: m[2].replace(/^<|>$/g, ''), line: lineAt(body, m.index), label: m[1] });
  }
  return out;
}

export function slugify(raw) {
  const text = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

export function headings(text) {
  const lines = maskFences(text).split('\n');
  const seen = new Map();
  const out = [];
  lines.forEach((l, i) => {
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(l);
    if (!m || !m[2].trim()) return;
    const base = slugify(m[2]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ level: m[1].length, text: m[2].trim(), line: i + 1, slug: n ? `${base}-${n}` : base });
  });
  return out;
}

/** 文中显式锚点：<a name="x"> / id="x"。 */
export function explicitAnchors(text) {
  return [...text.matchAll(/<a\s+[^>]*(?:name|id)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
}

export function fences(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  lines.forEach((l, i) => {
    const m = FENCE_RE.exec(l);
    if (cur) {
      if (m && m[2][0] === cur.marker[0] && m[2].length >= cur.marker.length && !m[3].trim()) { out.push(cur); cur = null; }
      else cur.lines.push({ text: l, line: i + 1 });
    } else if (m) cur = { marker: m[2], lang: m[3].trim(), startLine: i + 1, lines: [] };
  });
  if (cur) out.push(cur);
  return out;
}

export function inlineCode(text) {
  const body = maskFences(text);
  return [...body.matchAll(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g)].map(m => ({ code: m[2].trim(), line: lineAt(body, m.index) }));
}
