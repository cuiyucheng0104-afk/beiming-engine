// cases.index：案例卡、cases/INDEX.md、画廊数据与 NOTICES 署名段由 catalog 生成，没被手改、没有过期（GAP-05、ENTRY-15）。
// 判定交给 node tools/env/py.mjs tools/casebook.py index --check（同一个生成器），本规则只把结果转成发现。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import { runCasebook, notRun } from './_casebook.mjs';

export default {
  id: 'cases.index',
  title: '案例卡、INDEX.md、画廊数据与署名段是 catalog 的最新生成结果',
  async run(ctx) {
    if (!ctx.exists('cases/catalog.json')) return [];
    const res = await runCasebook(ctx, ['index', '--check']);
    if (!res.envelope) return notRun(res);
    const { exitCode, data, error } = res.envelope;
    if (exitCode === 0) return [{ level: 'info', file: 'cases/INDEX.md', message: `生成的 ${data?.files ?? '全部'} 个文件都是最新的` }];
    if (exitCode !== 4) throw new Error(`casebook.py index --check 退出码 ${exitCode}：${error?.message ?? ''}`);
    const hint = '不要手改这些文件：改 cases/catalog.json（或作品站的 works-meta.json）后运行 node tools/env/py.mjs tools/casebook.py index';
    return [
      ...(data?.stale ?? []).map(file => ({ level: 'error', file, message: '与 catalog 生成的内容不一致（手改过，或 catalog 改了没重新生成）', hint })),
      ...(data?.extra ?? []).map(file => ({ level: 'error', file, message: '案例卡没有对应的 catalog 记录', hint: '删掉它，或在 cases/catalog.json 里补上这个案例' })),
    ];
  },
};
