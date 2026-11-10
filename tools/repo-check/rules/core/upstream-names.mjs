// core.upstream-names（D04）：上游项目名（RAEA、两套风格库名）可以在技术说明、署名与许可说明里如实出现，
// 但不得用作我方的产品名、路线名、目录名或文件名。
//   a) 目录名：只有已有的内部目录 examples/raea、docs/raea 可以带上游名（上游项目名，内部目录沿用）；cases/vendor、cases/source 是只读归档，不查
//   b) 文件名：routes/、films/、tools/、engine/ 下的文件名不得带上游名
//   c) 正文（全部自有 Markdown，归档与决定书除外）：不得把上游名当我方的路线或产品，如「RAEA 原生路线」「RAEA 路线」
//      「RAEA 原生手册」「北冥 RAEA」「B · RAEA」；「基于 RAEA 原生运行时（<许可>）」这类技术与署名写法照常允许
//      （许可标识取自注册表的 upstream[].license，本文件不写死：MIT 目录的代码里出现 FSL 许可标识会被 comp.fsl-boundary 报出）
import { isArchive, isDecisionDoc, registryOf } from './_shared.mjs';

const INTERNAL_DIRS = new Set(['examples/raea', 'docs/raea']);
const NAME_ROOTS = ['routes', 'films', 'tools', 'engine'];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function upstreamNames(ctx) {
  const reg = registryOf(ctx);
  const names = new Set(['RAEA']);
  for (const r of reg?.routes ?? []) for (const u of r.upstream ?? []) if (u?.name) names.add(u.name);
  return [...names];
}

/** D04 的技术说明写法：「基于 RAEA 原生运行时（<注册表登记的许可>）」；注册表读不出来时指向许可说明页。 */
function runtimeCredit(ctx) {
  const u = (registryOf(ctx)?.routes ?? []).flatMap(r => r.upstream ?? []).find(x => x?.name === 'RAEA' && x.license);
  return `基于 RAEA 原生运行时（${u ? u.license : '许可见 docs/rights/fsl-boundary.md'}）`;
}

export default {
  id: 'core.upstream-names',
  title: '上游项目名只用于技术说明与署名，不当我方产品名、路线名、目录名',
  run(ctx) {
    const out = [];
    const names = upstreamNames(ctx);
    const nameRe = new RegExp(names.map(esc).join('|'), 'i');
    const dirRe = /raea/i;
    for (const d of ctx.walk('.', { dirs: true, files: false })) {
      if (isArchive(`${d}/`) || d === 'cases/vendor' || d === 'cases/source') continue;
      const base = d.split('/').pop();
      if (dirRe.test(base) && !INTERNAL_DIRS.has(d)) out.push({ level: 'error', file: d, message: `目录名 ${d}/ 含上游项目名`, hint: `新目录用我方名称（如 b-native）；可以带上游名的只有已有内部目录 ${[...INTERNAL_DIRS].join('、')}`, excerpt: base });
    }
    for (const top of NAME_ROOTS) for (const f of ctx.walk(top)) {
      if (!ctx.inScope(f)) continue;
      const base = f.split('/').pop();
      if (nameRe.test(base)) out.push({ level: 'error', file: f, message: `文件名 ${base} 含上游项目名`, hint: '文件名用我方名称；上游名写进文件内的技术说明或署名', excerpt: base });
    }
    const credit = runtimeCredit(ctx);
    const alt = names.map(esc).join('|');
    const product = new RegExp(`(?:${alt})\\s*(?:原生)?\\s*(?:路线|产品|品牌)|(?:${alt})\\s*原生手册|(?:北冥|BNE|\\bB)\\s*[·・]?\\s*(?:${alt})|(?:${alt})\\s*[·・]\\s*BNE`, 'i');
    for (const f of ctx.mdFiles()) {
      if (isArchive(f) || isDecisionDoc(f) || !ctx.inScope(f)) continue;
      const lines = ctx.md.maskCode(ctx.read(f)).split('\n');
      lines.forEach((l, i) => {
        const m = product.exec(l);
        if (m) out.push({ level: 'error', file: f, line: i + 1, message: `「${m[0]}」把上游项目名当成了我方的路线或产品名`, hint: `对外写「北冥原生 · BNE」；技术说明写「${credit}」（D04）`, excerpt: m[0] });
      });
    }
    return out;
  },
};
