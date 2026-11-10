// agent.githooks：给不走 Claude Code 的工具用的提交前检查能运行（差距 ENTRY-02）。
//   .githooks/pre-commit 首行是 #!/bin/sh、LF 换行、在 git 里是可执行文件（100755），检查逻辑 .githooks/pre-commit.mjs 在。
// Windows 上由 Git 自带的 sh 执行它；CRLF 会让 sh 报 "set: -: invalid option"，丢了可执行位 git 会静默跳过钩子。
import fs from 'node:fs';
import { finding, readOrNull } from './_shared.mjs';

const HOOK = '.githooks/pre-commit';
const IMPL = '.githooks/pre-commit.mjs';

export default {
  id: 'agent.githooks',
  title: '.githooks/pre-commit 首行 sh、LF、可执行，检查脚本存在',
  run(ctx) {
    const text = readOrNull(ctx, HOOK);
    if (text === null) return [finding('error', HOOK, `缺 ${HOOK}：不用 Claude Code 的工具没有提交前检查`, `从版本库恢复：git checkout -- .githooks`)];
    const out = [];
    if (!/^#!\s*\/(usr\/)?bin\/(env\s+)?(sh|bash)\b/.test(text)) out.push(finding('error', HOOK, `${HOOK} 第一行要是 #!/bin/sh`, 'Windows 上由 Git 自带的 sh 执行它，首行决定解释器'));
    if (text.includes('\r\n')) out.push(finding('error', HOOK, `${HOOK} 含 CRLF 换行：sh 会报 "set: -: invalid option" 之类的错`, '改回 LF（.gitattributes 已规定 eol=lf）'));
    if (!text.includes('pre-commit.mjs')) out.push(finding('error', HOOK, `${HOOK} 没有调用 ${IMPL}`, `恢复成 exec node "$hook_dir/pre-commit.mjs"`));
    if (!ctx.exists(IMPL)) out.push(finding('error', IMPL, `缺 ${IMPL}：pre-commit 的检查逻辑在这里`, `从版本库恢复：git checkout -- ${IMPL}`));
    const st = ctx.git(['ls-files', '-s', '--', HOOK]);
    if (st.ok && st.stdout.trim()) {
      if (!st.stdout.startsWith('100755')) out.push(finding('error', HOOK, `${HOOK} 在 git 里不是可执行文件（应为 100755）：git 会静默跳过不可执行的钩子`, `git update-index --chmod=+x ${HOOK}`));
    } else if (process.platform !== 'win32') {
      try {
        if (!(fs.statSync(ctx.abs(HOOK)).mode & 0o111)) out.push(finding('error', HOOK, `${HOOK} 没有可执行权限`, `chmod +x ${HOOK}`));
      } catch { /* 上面已报缺失 */ }
    }
    return out;
  },
};
