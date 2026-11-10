// route-c.fonts：C 路线片名字体（routes/c-style/fonts/，马善政毛笔楷书分片）完好：每片 sha256、大小与清单一致，
// cmap 正好覆盖清单列出的码位，unicode-range 不重叠，OFL.txt 在。与 node routes/c-style/fonts/fetch.mjs --check 同一套核对。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { C, err, ok } from './_lib.mjs';

export default {
  id: 'route-c.fonts',
  title: 'C 路线片名字体分片完好（sha256、码位覆盖、OFL 许可）',
  async run(ctx) {
    const tool = `${C}/fonts/fetch.mjs`;
    if (!ctx.exists(tool)) return [err(`缺少 ${tool}`, tool)];
    const { verifyFonts, MANIFEST } = await import(pathToFileURL(path.join(ctx.root, tool)).href);
    const problems = verifyFonts(ctx.root);
    if (problems.length) return problems.map(p => err(`片名字体：${p}`, MANIFEST, '不要手改分片；完整检出仓库，或 node routes/c-style/fonts/fetch.mjs --fetch 重新生成后提交'));
    const m = JSON.parse(ctx.read(MANIFEST));
    return [ok(`${m.chunks.length} 片、${m.codepointCount} 个字（${m.family}，${m.license}）`)];
  },
};
