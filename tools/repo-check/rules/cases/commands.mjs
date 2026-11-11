// cases.commands：案例库文档里的命令能在三个平台照抄执行，状态措辞有参照系（ENV-08、ENTRY-15）。
//   · 不写 python3 / python tools/casebook.py（Windows 没有 python3），写 node tools/env/py.mjs tools/casebook.py 或 npm run cases:*；
//   · 案例库的说明与生成文件里不出现「本次」（对后来的 agent 没有参照系，写日期或提交号）。
// 范围：cases/README.md、cases/INDEX.md、cases/NOTICES.md、cases/entries/*.md、docs/cases/*.md（归档源码 cases/source 与 vendor 不查）。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
const BARE = /(^|[\s`'"(])(python3?|py)(\s+-\S+)*\s+tools\/casebook\.py\b/;
const WORD = /本次/;

export default {
  id: 'cases.commands',
  title: '案例库文档的命令跨平台可照抄（经 tools/env/py.mjs），不用「本次」这类无参照系的措辞',
  run(ctx) {
    const files = [
      ...['cases/README.md', 'cases/INDEX.md', 'cases/NOTICES.md'].filter(f => ctx.exists(f)),
      ...ctx.walk('cases/entries').filter(f => f.endsWith('.md')),
      ...ctx.walk('docs/cases').filter(f => f.endsWith('.md')),
    ].filter(f => ctx.inScope(f));
    const out = [];
    for (const f of files) {
      ctx.read(f).split(/\r?\n/).forEach((line, i) => {
        if (BARE.test(line)) out.push({ level: 'error', file: f, line: i + 1, message: '直接用 python 调 casebook.py：Windows 上通常没有 python3，也绕过了仓库选定的解释器', hint: '改成 node tools/env/py.mjs tools/casebook.py …，或 npm run cases:check / cases:list', excerpt: line.trim().slice(0, 160) });
        if (WORD.test(line)) out.push({ level: 'error', file: f, line: i + 1, message: '「本次」没有参照系：后来的读者分不清是哪一次', hint: '写成带日期或提交号的事实，例如「2026-11-07 归档时未重渲」；生成的文件改生成器（tools/casebook.py index）', excerpt: line.trim().slice(0, 160) });
      });
    }
    return out;
  },
};
