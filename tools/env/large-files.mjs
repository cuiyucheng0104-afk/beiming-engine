#!/usr/bin/env node
// 北冥仓库 · 大文件闸门（决定 D10）：跟踪文件超过 5 MiB 必须登记在 LARGE-FILES.allow，且 sha256 与大小一致。
//   node tools/env/large-files.mjs            检查（默认）；有违规 exit 4
//   node tools/env/large-files.mjs --update   刷新已登记文件的哈希与大小（替换已登记的大文件后用）；不添加新条目
//   node tools/env/large-files.mjs --init     仓库里还没有白名单时，按当前索引生成（只在落地 D10 时用一次）
//   --json                                    C2 信封
// 判定对象是 git 索引（即将提交的内容）：git add 之后、commit 之前就能拦住。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CliError, runCli, isMain } from './lib/cli.mjs';
import { ROOT } from './lib/python.mjs';
import { checkLargeFiles, readAllow, formatAllow, indexEntries, blobSha256 } from './lib/largefiles.mjs';

const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/env/spec.json'), 'utf8'));
const LIMIT = SPEC.storage.largeFileBytes, FILE = SPEC.storage.allowFile;

const HELP = `北冥仓库 · 大文件闸门（D10）

用法：
  node tools/env/large-files.mjs [--update | --init] [--root <目录>] [--json]

  （无参数）  检查 git 索引里超过 5 MiB 的文件是否都登记在 ${FILE}、哈希是否一致；有违规 exit 4
  --update    已登记的文件被有意替换后，刷新它们的哈希与大小（不会添加新条目）
  --init      还没有 ${FILE} 时按当前索引生成一份（落地 D10 时用一次；已存在则拒绝）
  --root      检查别的检出（默认本仓库）
  --json      stdout 只输出一个 JSON 对象（C2 信封）

新的大文件不要进 git：底板、采样、母版放 Release 或对象存储，仓库只存清单（地址、sha256、大小、许可、来源）；
渲染产物写在 films/<名>/out/ 下，永不提交。
退出码：0 通过；2 用法错误；4 有违规；1 运行失败（例如没有 git）。`;

if (isMain(import.meta.url)) {
  runCli({
    command: 'env:large-files', help: HELP,
    options: { update: { type: 'boolean' }, init: { type: 'boolean' }, root: { type: 'string' } },
    run: async (o) => {
      const root = path.resolve(o.root || ROOT);
      if (o.update && o.init) throw new CliError(EXIT.USAGE, 'usage', '--update 与 --init 不能同时用');
      const allowPath = path.join(root, FILE);
      if (o.init || o.update) {
        if (o.init && fs.existsSync(allowPath)) throw new CliError(EXIT.USAGE, 'usage', `${FILE} 已存在，--init 只在第一次落地时用`, '替换已登记的文件后用 --update');
        const entries = indexEntries(root).filter(e => e.size > LIMIT);
        const listed = o.update ? new Set(readAllow(root, FILE).entries.map(e => e.path)) : null;
        const keep = [];
        for (const e of entries) if (!listed || listed.has(e.path)) keep.push({ path: e.path, size: e.size, sha256: await blobSha256(root, e.blob) });
        const text = formatAllow(keep);
        fs.writeFileSync(allowPath, text);
        return { outputs: [{ path: FILE, sha256: null, kind: 'allowlist' }], entries: keep, human: `已写 ${FILE}：${keep.length} 个文件\n${keep.map(e => `  ${(e.size / 1048576).toFixed(1).padStart(6)} MiB  ${e.path}`).join('\n')}` };
      }
      const r = await checkLargeFiles({ root, threshold: LIMIT, allowFile: FILE });
      const lines = [`跟踪文件超过 ${LIMIT / 1048576} MiB 的有 ${r.large.length} 个；违规 ${r.violations.length} 个${r.stale.length ? `；白名单里已不需要的条目 ${r.stale.length} 个（${r.stale.join('、')}）` : ''}`];
      for (const v of r.violations) lines.push(`  FAIL ${v.path}：${v.reason}\n       修复：${v.fix}`);
      return {
        exitCode: r.ok ? EXIT.OK : EXIT.CONTRACT,
        error: r.ok ? null : { code: 'large-file', message: `${r.violations.length} 个大文件不合规：${r.violations.map(v => v.path).join('、')}`, hint: r.violations[0].fix },
        warnings: r.stale.map(p => `${FILE} 里的 ${p} 已不在索引中或不再超过阈值，可以删掉这一行`),
        largeFiles: r,
        human: lines.join('\n'),
      };
    },
  });
}
