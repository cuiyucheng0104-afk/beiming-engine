// film.review-records：films/<名>/review/ 的审片记录合乎 D08（agent 不得自己批准）。
// 记录格式以作品描述包为准（engine/production/review.js）：approve / reject / waive 只能由人做（reviewer.kind = human），
// 带用户原话与出处 { kind, ref, at }；agent 只能写 comment；final 不能豁免；文件名 <闸>-<YYYY-MM-DD>[-n].json。
// 作品描述包在仓库里时用它的 validateReview 判定；否则用 tools/film/lib/gates.mjs 的同口径实现。
import fs from 'node:fs';
import { filmDirs, importFrom } from './_shared.mjs';

const NAME = /^(structure|look|animatic|final)-\d{4}-\d{2}-\d{2}(-\d+)?\.json$/;

export default {
  id: 'film.review-records',
  title: '审片记录合乎 D08：用户原话与出处齐全，agent 不得自己批准',
  async run(ctx) {
    let validate = null, by = 'tools/film/lib/gates.mjs';
    if (ctx.exists('engine/production/review.js')) {
      try { const m = await importFrom(ctx, 'engine/production/review.js'); if (typeof m.validateReview === 'function') { validate = r => m.validateReview(r).diagnostics.filter(d => d.level === 'error').map(d => d.message); by = 'engine/production/review.js'; } } catch { /* 用内置 */ }
    }
    if (!validate) { const g = await importFrom(ctx, 'tools/film/lib/gates.mjs'); validate = r => g.reviewProblems(r); }
    const out = [];
    let n = 0;
    for (const d of filmDirs(ctx)) {
      const dir = `${d}/review`;
      if (!ctx.isDir(dir)) continue;
      for (const name of fs.readdirSync(ctx.abs(dir)).sort()) {
        if (name.startsWith('.') || !name.endsWith('.json')) continue;
        const file = `${dir}/${name}`;
        if (!ctx.inScope(file)) continue;
        n++;
        if (name === 'waivers.json') { out.push({ level: 'error', file, message: '旧格式的豁免台账：豁免改为一条 decision = waive 的记录（review/<闸>-<日期>.json，带用户原话与出处）', hint: 'npm run film -- review waive <闸> <作品> --reason … --quote "<用户原话>" --source "<出处>"' }); continue; }
        if (!NAME.test(name)) { out.push({ level: 'error', file, message: 'review/ 下只放 <闸>-<YYYY-MM-DD>[-n].json', hint: '用 npm run film -- review … 生成记录，不要手写文件名' }); continue; }
        let rec;
        try { rec = ctx.readJson(file); } catch (e) { out.push({ level: 'error', file, message: `不是合法 JSON（${e.message}）` }); continue; }
        if (rec?.gate && rec.gate !== name.split('-')[0]) out.push({ level: 'error', file, message: `文件名是 ${name.split('-')[0]} 闸，记录里写的是 ${rec.gate}` });
        for (const p of validate(rec)) {
          out.push({ level: 'error', file, message: `${p}：这条记录不放行任何闸`, hint: /human|ai|agent|自己/.test(p) ? 'approve / reject / waive 只记用户原话；agent 自己的结论用 npm run film -- review note' : '原话要能在会话里逐字找到，出处写清会话与消息位置' });
        }
      }
    }
    if (!out.length) out.push({ level: 'info', message: n ? `${n} 条审片记录都合格（${by}）` : '还没有审片记录' });
    return out;
  },
};
