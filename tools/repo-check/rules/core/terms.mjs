// core.terms：入口口径与命名（D01、D04）。
//   a) 入口文档（tools/repo-check/rules/core/_shared.mjs 的 entryDocs）里不说「两条路线」「双路线」：路线是 A、B、C 三条（D01）
//   b) 不再用「历史代号」：改称「上游项目名（内部目录沿用）」（D04）；全部自有 Markdown 都查，归档与决定书除外
//   c) 产品名不带 RTX：如「北冥原生 · BNE · RTX 工具链」「北冥原生 · BNE（RTX 原生工具链）」（D04）
//   d) 「路线怎么选 / 如何选择 / 路线选择」这类选路线的标题只出现在 routes/README.md：判据只有一份
import { entryDocs, grepLines, isArchive, isDecisionDoc } from './_shared.mjs';

// 「A、B 两条路线的……」这类点名两条具体路线的写法不算
const TWO_ROUTES = /(?<![ABC]\s*[、与和及,，/]\s*[ABC]\s*的?\s*)两条(?:创作|执行|渲染)?路线|双路线/;
const LEGACY_CODENAME = /历史(?:工程)?代号/;
const RTX_PRODUCT = /北冥原生(?:路线)?\s*[·・]\s*BNE\s*(?:[·・]|[（(])\s*RTX|BNE\s*[·・]\s*RTX/;
const CHOOSER_HEADING = /路线(?:怎么|如何)?选择?|如何选择|选哪条路线/;
const CHOOSER_HOME = 'routes/README.md';

export default {
  id: 'core.terms',
  title: '入口口径：三条路线、上游项目名、产品名不带 RTX、选路线的判据只在 routes/README.md',
  run(ctx) {
    const out = [];
    for (const f of entryDocs(ctx)) {
      if (!ctx.inScope(f)) continue;
      for (const g of grepLines(ctx.md.maskCode(ctx.read(f)), TWO_ROUTES)) {
        out.push({ level: 'error', file: f, line: g.line, message: `「${g.excerpt}」：路线是 A、B、C 三条（D01）`, hint: '改成「三条路线」，或直接写 A / B / C 的名字；选路线的判据链到 routes/README.md', excerpt: g.excerpt });
      }
    }
    for (const f of ctx.mdFiles()) {
      if (isArchive(f) || isDecisionDoc(f) || !ctx.inScope(f)) continue;
      const text = ctx.md.maskCode(ctx.read(f));
      for (const g of grepLines(text, LEGACY_CODENAME)) {
        out.push({ level: 'error', file: f, line: g.line, message: `「${g.excerpt}」：D04 改称「上游项目名（内部目录沿用）」`, hint: '例：「目录名 examples/raea 沿用上游项目名 RAEA」', excerpt: g.excerpt });
      }
      for (const g of grepLines(text, RTX_PRODUCT)) {
        out.push({ level: 'error', file: f, line: g.line, message: `「${g.excerpt}」：产品名里不再带 RTX（D04）`, hint: '品牌名写「北冥原生 · BNE」；RTX 工作站是执行环境，写在环境说明里', excerpt: g.excerpt });
      }
      if (f === CHOOSER_HOME) continue;
      for (const h of ctx.md.headings(ctx.read(f))) {
        if (CHOOSER_HEADING.test(h.text)) out.push({ level: 'error', file: f, line: h.line, message: `标题「${h.text}」：选路线的判据只放在 ${CHOOSER_HOME}`, hint: `删掉这一节的判据，换成一行链接到 ${CHOOSER_HOME}`, excerpt: h.text });
      }
    }
    return out;
  },
};
