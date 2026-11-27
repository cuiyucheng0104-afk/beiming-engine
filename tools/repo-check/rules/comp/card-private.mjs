// 公开技术卡的私有来源门禁与暂存区扫描共用实现。
import { compRule } from '../../../compliance/lib/repo-check.mjs';

const rule = compRule('comp.card-private');
export const { id, title, run } = rule;
export default rule;
