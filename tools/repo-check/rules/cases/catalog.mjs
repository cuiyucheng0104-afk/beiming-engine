// cases.catalog：案例目录本身合格——schemaVersion 2 的字段（技术状态与用户认可分开、被否定的写明原因或「待补」、
// 权利字段齐全且与授权登记册一致）、templated 条目没有 originalSha256（COMP-05）、归档源文件与哈希一致（QUAL-16、CRAFT-11、COMP-06）。
// 判定交给 casebook.py check --rights（与 npm run check 的 cases 步骤同一个实现）；本规则把问题逐条转成发现。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import { runCasebook, notRun } from './_casebook.mjs';

export default {
  id: 'cases.catalog',
  title: '案例目录合格：字段、状态三分离、权利字段与登记册一致、源文件哈希',
  async run(ctx) {
    if (!ctx.exists('cases/catalog.json')) return [];
    const res = await runCasebook(ctx, ['check', '--rights']);
    if (!res.envelope) return notRun(res);
    const { exitCode, data, error } = res.envelope;
    const notices = (res.envelope.warnings ?? []).map(w => ({ level: 'warn', file: 'cases/catalog.json', message: w.message, hint: w.hint ?? undefined }));
    if (exitCode === 0) {
      return [...notices, { level: 'info', file: 'cases/catalog.json',
        message: `${data.records} 条记录、${data.uniqueSourceFiles} 个唯一源文件、${data.vendorFiles} 个 vendor 文件核对通过` }];
    }
    if (exitCode !== 4) throw new Error(`casebook.py check 退出码 ${exitCode}：${error?.message ?? ''}`);
    return [...notices, ...(data?.problems ?? [error?.message]).map(p => ({
      level: 'error', file: 'cases/catalog.json', message: String(p).split('\n')[0],
      hint: '详情：node tools/env/py.mjs tools/casebook.py check --rights；字段说明见 docs/cases/casebook.md',
    }))];
  },
};
