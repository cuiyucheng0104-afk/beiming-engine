// spec.claims：状态不是 accepted 的作品（D08：用户认可了这一版成片才是 accepted），作品目录里的说明文字不得写
// 「已交付」「用户已认可」一类说法；否定说法（「未经用户认可」）与引号里提到词本身（「已交付」只能由 accepted 生成）放行。
import { engineLibs, filmDirs, filmInScope, finding } from './_lib.mjs';

export default {
  id: 'spec.claims',
  title: '没有 accepted 的作品不写「已交付」「用户已认可」',
  async run(ctx) {
    const L = await engineLibs(ctx);
    const out = [];
    for (const dir of filmDirs(ctx)) {
      if (!filmInScope(ctx, dir)) continue;
      let s;
      try { s = L.state.filmStatus(ctx.abs(dir)); } catch { continue; }
      if (s.state === 'accepted') continue;
      for (const f of ctx.walk(dir).filter(x => /\.md$/i.test(x) && !x.startsWith(`${dir}/review/`))) {
        const text = ctx.read(f);
        for (const c of L.state.findUnbackedClaims(text, s)) {
          const line = text.slice(0, c.index).split('\n').length;
          out.push(finding('error', 'unbacked-claim', f, `「${c.claim}」没有依据：作品当前状态 ${s.state}（${s.label}）`,
            '只有 accepted（用户认可了这一版成片）才能写；现在写「技术检查通过，未经用户审看」，或先走完 ⛔4', { line, excerpt: c.claim }));
        }
      }
    }
    return out;
  },
};
