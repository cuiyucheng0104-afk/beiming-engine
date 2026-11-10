// route-c.styles-provenance：86 式每一式都写了来源@提交（与 cases/vendor/lock.json 一致）和 MIT 许可；
// STYLES.md 表里每一行风格都带来源与许可；两套库合计 Lemo 66 + SY 20。
import { C, err, ok, readLF } from './_lib.mjs';

export default {
  id: 'route-c.styles-provenance',
  title: '86 式每式都有来源@提交（对得上 vendor 锁）与 MIT 许可',
  run(ctx) {
    const sj = `${C}/styles.json`, sm = `${C}/STYLES.md`;
    if (!ctx.exists(sj)) return [err('styles.json 缺失', sj, '运行 node tools/c-styles.mjs')];
    if (!ctx.exists('cases/vendor/lock.json')) return [err('缺少 cases/vendor/lock.json，无法核对来源', 'cases/vendor/lock.json')];
    const lock = JSON.parse(readLF(ctx, 'cases/vendor/lock.json'));
    const short = Object.fromEntries((lock.repositories || []).map(r => [r.name, String(r.commit).slice(0, 7)]));
    const want = { lemo: `lemo-opuscar@${short['lemo-opuscar']}`, sy: `sy-style-100@${short['sy-style-100']}` };
    const data = JSON.parse(readLF(ctx, sj));
    const out = [], n = { lemo: 0, sy: 0 };
    for (const s of data.styles) {
      n[s.library] = (n[s.library] || 0) + 1;
      if (s.source !== want[s.library]) out.push(err(`${s.id} 的来源写成 ${s.source}，应为 ${want[s.library]}（cases/vendor/lock.json）`, sj, '重新生成：node tools/c-styles.mjs'));
      if (s.license !== 'MIT') out.push(err(`${s.id} 的许可写成 ${s.license}，两套风格库都是 MIT`, sj));
    }
    if (n.lemo !== 66 || n.sy !== 20) out.push(err(`styles.json 有 Lemo ${n.lemo} 种、SY ${n.sy} 种，应为 66 + 20 = 86`, sj, '快照变了就同步更新手册里的数字与本规则'));
    if (!ctx.exists(sm)) out.push(err('STYLES.md 缺失', sm, '运行 node tools/c-styles.mjs'));
    else {
      const rows = readLF(ctx, sm).split('\n').filter(l => /^\| `(lemo|sy)\//.test(l));
      if (rows.length !== data.styles.length) out.push(err(`STYLES.md 表里有 ${rows.length} 行风格，styles.json 有 ${data.styles.length} 式`, sm, '重新生成，不要手改'));
      for (const l of rows) {
        const id = /^\| `([^`]+)`/.exec(l)[1], lib = id.startsWith('lemo/') ? 'lemo' : 'sy';
        if (!l.includes(want[lib]) || !/· MIT \|/.test(l)) out.push(err(`STYLES.md 的 ${id} 一行缺来源@提交或许可`, sm, '重新生成，不要手改'));
      }
    }
    if (!out.length) out.push(ok(`86 式来源与许可齐全（${want.lemo}、${want.sy}，MIT）`));
    return out;
  },
};
