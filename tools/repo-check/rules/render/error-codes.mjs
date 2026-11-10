// render.error-codes：渲染器代码里抛出的每个错误码都写进 engine/render/README.md「错误码」表，表里的退出码与前缀一致，
// 表里的码在代码（渲染器或命令约定库 tools/lib/cli.mjs）里确实存在。编排器按错误码细分失败（docs/CLI.md 第 4 节），
// 表与代码一不一致，agent 就会照着过时的码去分支（计划书 P04·R1、M06）。
import { README, CODE_RE, ownFiles, codesIn } from './_shared.mjs';
import { exitCodeFor } from '../../../lib/cli.mjs';

const SECTION = /^##\s+\d*\.?\s*错误码/;

/** README「错误码」一节表格里的码 → Map<码, {line, exit}> */
export function documentedCodes(text) {
  const lines = text.split('\n');
  const out = new Map();
  let inSection = false;
  lines.forEach((l, i) => {
    if (/^##\s/.test(l)) inSection = SECTION.test(l);
    if (!inSection || !l.startsWith('|')) return;
    const cells = l.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2) return;
    const exit = cells[1];
    for (const m of cells[0].matchAll(/`([^`]+)`/g)) if (CODE_RE.test(m[1])) out.set(m[1], { line: i + 1, exit });
  });
  return out;
}

export default {
  id: 'render.error-codes',
  title: '渲染器的错误码都写进 engine/render/README.md「错误码」表，退出码与前缀一致',
  run(ctx) {
    if (!ctx.exists(README)) return [{ level: 'error', file: README, message: '渲染器规格 engine/render/README.md 不存在', hint: '恢复它：错误码、页面约定、运行记录的口径都在这份规格里' }];
    const doc = documentedCodes(ctx.read(README));
    if (!doc.size) return [{ level: 'error', file: README, message: 'README 里没有「错误码」一节的表格', hint: '加一节「## 9. 错误码」，表头 | 错误码 | 退出码 | 什么时候 | 下一步 |' }];
    const used = codesIn(ctx, ownFiles(ctx));
    const lib = ctx.exists('tools/lib/cli.mjs') ? codesIn(ctx, ['tools/lib/cli.mjs']) : new Map();
    const out = [];
    for (const [code, where] of used) {
      if (doc.has(code)) continue;
      out.push({ level: 'error', file: where[0].file, line: where[0].line, message: `错误码 ${code} 没写进 ${README} 的「错误码」表`, hint: '在表里加一行：错误码、退出码、什么时候、下一步', excerpt: code });
    }
    for (const [code, { line, exit }] of doc) {
      const want = String(exitCodeFor(code));
      const exits = exit.split(/[\/、,，\s]+/).filter(Boolean);
      const okExit = code.startsWith('signal.') ? exits.includes(String(exitCodeFor(code))) || /130/.test(exit) : exits.includes(want);
      if (!okExit) out.push({ level: 'error', file: README, line, message: `错误码 ${code} 的退出码写成 ${exit}，按前缀应是 ${want}`, hint: '退出码由错误码前缀决定（docs/CLI.md 第 4 节）：改表，或改错误码的前缀', excerpt: code });
      if (!used.has(code) && !lib.has(code) && !code.startsWith('signal.')) {
        out.push({ level: 'warn', file: README, line, message: `表里的错误码 ${code} 在代码里找不到`, hint: '删掉这一行，或检查是不是改名了', excerpt: code });
      }
    }
    if (!out.length) out.push({ level: 'info', file: README, message: `渲染器用到的 ${used.size} 个错误码都在表里（表里共 ${doc.size} 个）` });
    return out;
  },
};
