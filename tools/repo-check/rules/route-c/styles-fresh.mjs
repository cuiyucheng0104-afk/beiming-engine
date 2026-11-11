// route-c.styles-fresh：STYLES.md 与 styles.json 和生成器（tools/c-styles.mjs）的输出逐字一致，数据本身没有矛盾。
// 生成器从被检查仓库（ctx.root）里导入，读的也是那个仓库的快照与案例目录。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { err, ok, readLF } from './_lib.mjs';

export default {
  id: 'route-c.styles-fresh',
  title: 'C 路线的风格索引 STYLES.md / styles.json 与生成器一致，数据没有矛盾',
  async run(ctx) {
    if (!ctx.exists('tools/c-styles.mjs')) return [err('缺少风格索引生成器 tools/c-styles.mjs', 'tools/c-styles.mjs')];
    const gen = await import(pathToFileURL(path.join(ctx.root, 'tools/c-styles.mjs')).href);
    let data;
    try { data = gen.collect(); } catch (e) { return [err(`生成器读数据源失败：${e.message}`, 'tools/c-styles.mjs', e.hint || '在完整检出的仓库根目录运行；不要删 cases/vendor 与 cases/catalog.json')]; }
    const out = data.problems.map(p => err(`风格数据矛盾：${p}`, 'cases/catalog.json', '核对快照（cases/vendor/lock.json）与案例目录'));
    const { md, json } = gen.render(data);
    for (const [f, txt] of [[gen.OUT_MD, md], [gen.OUT_JSON, json]]) {
      if (!ctx.exists(f)) out.push(err(`${f} 缺失`, f, '运行 node tools/c-styles.mjs 生成'));
      else if (readLF(ctx, f) !== txt) out.push(err(`${f} 不是最新（与快照或案例目录不一致，或被手改过）`, f, '运行 node tools/c-styles.mjs 重新生成，不要手改'));
    }
    if (!out.length) out.push(ok(`${data.styles.length} 式（Lemo ${data.counts.lemo} + SY ${data.counts.sy}）与生成器一致`));
    return out;
  },
};
