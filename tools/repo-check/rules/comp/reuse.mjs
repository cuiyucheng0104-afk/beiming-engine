// 仓库规范检查 · 合规规则 comp.reuse：REUSE 许可覆盖。
// 实现在 tools/compliance/（与 node tools/compliance/scan.mjs --only reuse 结果一致）；本文件只按 repo-check 的规则约定导出。
// 历史归档区（cases/source、cases/vendor）的发现只给提示、不阻塞；人工豁免见 tools/compliance/allowlist.json。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import { compRule } from '../../../compliance/lib/repo-check.mjs';

const rule = compRule('comp.reuse');
export const { id, title, run } = rule;
export default rule;
