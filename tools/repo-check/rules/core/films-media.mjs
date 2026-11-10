// core.films-media：films/ 只提交源码与描述，不提交渲染产物（D10、ENTRY-07）。
//   - git 跟踪的 films/** 里不能有音视频（mp4 mov mkv webm avi wav aac m4a flac mp3 y4m exr）、帧序列目录（frames/、stills/）、
//     out/ 与 media/ 下的文件，也不能有大于 5 MiB 的文件；
//   - 没被忽略、还没提交的这类文件报提示：git add 时会被带进仓库，产物应写到 films/<名字>/out/。
// 不是 git 检出时跳过。
import fs from 'node:fs';

const MEDIA_EXT = /\.(mp4|mov|mkv|webm|avi|wav|aac|m4a|flac|mp3|y4m|exr)$/i;
const PRODUCT_DIR = /^films\/[^/]+\/(?:.*\/)?(out|media|frames|stills)\//;
const MAX = 5 * 1024 * 1024;

function why(ctx, f) {
  if (MEDIA_EXT.test(f)) return '音视频文件';
  if (PRODUCT_DIR.test(f)) return '渲染或准备阶段的产物目录';
  try { if (fs.statSync(ctx.abs(f)).size > MAX) return '大于 5 MiB 的文件（D10：放 Release 或对象存储，仓库只存清单）'; } catch { /* 已删除 */ }
  return null;
}

export default {
  id: 'core.films-media',
  title: 'films/ 不提交音视频、帧序列与大文件',
  run(ctx) {
    const tracked = ctx.git(['ls-files', '-z', '--', 'films']);
    if (!tracked.ok) return [{ level: 'info', message: '不是 git 检出（或没有 git），跳过' }];
    const out = [];
    for (const f of tracked.stdout.split('\0').filter(Boolean)) {
      const w = why(ctx, f);
      if (w) out.push({ level: 'error', file: f, message: `已被 git 跟踪的${w}`, hint: `git rm --cached ${f}；产物只写到 films/<名字>/out/（不提交）`, excerpt: f });
    }
    const loose = ctx.git(['ls-files', '-z', '--others', '--exclude-standard', '--', 'films']);
    if (loose.ok) for (const f of loose.stdout.split('\0').filter(Boolean)) {
      const w = why(ctx, f);
      if (w) out.push({ level: 'warn', file: f, message: `没被 .gitignore 忽略的${w}：git add 时会被带进仓库`, hint: '把它移到 films/<名字>/out/；或请集成者在 .gitignore 加 films/** 的媒体规则', excerpt: f });
    }
    return out;
  },
};
