// core.engine-heads：engine/ 下每个代码模块（.js .mjs .ts .tsx .py）开头、第一行代码之前有注释块，且注释里有中文
// （写明做什么、接口是什么）。agent 靠这些注释找能力，不靠猜。
const EXT = /\.(js|mjs|ts|tsx|py)$/;
const CJK = /[一-鿿]/;

export function headComment(src, isPy) {
  const lines = src.replace(/^﻿/, '').split('\n');
  let i = 0;
  if (lines[0]?.startsWith('#!')) i++;
  const out = [];
  if (isPy) {
    while (i < lines.length && (/^\s*$/.test(lines[i]) || /^\s*#/.test(lines[i]))) out.push(lines[i++]);
    const m = /^\s*[rRuU]?("""|''')/.exec(lines[i] || '');
    if (m) {
      const q = m[1];
      out.push(lines[i]);
      if (!(lines[i].split(q).length > 2)) { i++; while (i < lines.length && !lines[i].includes(q)) out.push(lines[i++]); out.push(lines[i] || ''); }
    }
    return out.join('\n');
  }
  let inBlock = false;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (inBlock) { out.push(l); if (l.includes('*/')) inBlock = false; continue; }
    if (/^\s*$/.test(l) || /^\s*\/\//.test(l)) { out.push(l); continue; }
    if (/^\s*\/\*/.test(l)) { out.push(l); inBlock = !l.includes('*/'); continue; }
    break;
  }
  return out.join('\n');
}

export default {
  id: 'core.engine-heads',
  title: 'engine/ 每个模块开头有中文注释（做什么 + 接口）',
  run(ctx) {
    const files = ctx.walk('engine').filter(f => EXT.test(f));
    if (!files.length) return [{ level: 'error', file: 'engine', message: 'engine/ 下没有代码模块' }];
    const out = [];
    for (const f of files) {
      if (!ctx.inScope(f)) continue;
      const h = headComment(ctx.read(f), f.endsWith('.py'));
      if (!h.trim() || !/(\/\/|\/\*|#|"""|''')/.test(h)) out.push({ level: 'error', file: f, line: 1, message: '开头没有注释块', hint: '第一行代码之前写中文注释：做什么、接口（导出什么、参数、返回）' });
      else if (!CJK.test(h)) out.push({ level: 'error', file: f, line: 1, message: '开头注释里没有中文', hint: '用中文写明做什么与接口' });
    }
    if (!out.length) out.push({ level: 'info', message: `engine/ 下 ${files.length} 个模块开头都有中文注释` });
    return out;
  },
};
