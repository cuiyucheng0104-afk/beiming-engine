// spec.reviews：films/<名>/review/ 的审片记录都合格（决策 D08）：agent 不能自己批准、否决或豁免；
// approve / reject / waive 必须有用户原话与出处；approve 要列出所看文件的 sha256；final 不能豁免。无效的记录不算数。
import { diagToFinding, engineLibs, filmDirs, finding } from './_lib.mjs';

export default {
  id: 'spec.reviews',
  title: '审片记录都合格：agent 不能自己批准，人工结论必须有用户原话与出处',
  async run(ctx) {
    const L = await engineLibs(ctx);
    const out = [];
    let n = 0;
    for (const dir of filmDirs(ctx)) {
      if (!ctx.isDir(`${dir}/review`)) continue;
      const files = ctx.walk(`${dir}/review`);
      if (!files.some(f => ctx.inScope(f)) && !ctx.inScope(`${dir}/film.json`)) continue;
      let film = null;
      try { film = L.film.loadFilm(ctx.abs(dir)).film; } catch { /* spec.films 会报 */ }
      const r = L.review.readReviews(ctx.abs(dir), { film });
      for (const d of r.diagnostics) out.push(finding(d.level, d.code, `${dir}/${d.path}`, d.message, d.hint));
      for (const rec of r.records) {
        n++;
        if (rec.valid) continue;
        for (const d of rec.diagnostics.filter(y => y.level === 'error')) {
          out.push(diagToFinding({ ...d, hint: d.hint || '无效的记录不算数：用 node engine/production/film.js review 重新记录用户原话' }, `${dir}/review/${rec.name}`));
        }
      }
    }
    if (!out.length) out.push({ level: 'info', message: n ? `${n} 条审片记录都合格` : '还没有审片记录' });
    return out;
  },
};
