// route-a.plates：底板登记表 assets/plates/plates.json 的字段与文件头合格（边策略必填、AI 底板有逐张来源链、原图尺寸与放大方法对得上、
// 登记尺寸与 PNG 一致、纹素密度不低于 0.6）。不逐像素读（快）；四边 alpha 的逐像素检查用 node tools/plates/check.mjs。
import path from 'node:path';
import { checkPlates, loadProfiles } from '../../../plates/lib.mjs';

const FILE = 'assets/plates/plates.json';

export default {
  id: 'route-a.plates',
  title: '底板登记表的字段、来源链与文件头合格',
  run(ctx) {
    if (!ctx.exists(FILE) || (ctx.staged && ![...ctx.staged].some(f => f.startsWith('assets/plates/')))) return [];
    const r = checkPlates(path.join(ctx.root, ...FILE.split('/')), { decode: false, profiles: loadProfiles(ctx.root) });
    const out = [
      ...r.errors.map(m => ({ level: 'error', file: FILE, message: m, hint: '字段见 assets/plates/plates.schema.json；逐张核对 node tools/plates/check.mjs' })),
      ...r.warnings.map(m => ({ level: 'warn', file: FILE, message: m })),
    ];
    if (!r.errors.length) out.push({ level: 'info', file: FILE, message: `${r.plates.length} 张底板字段与文件头合格（逐像素检查：node tools/plates/check.mjs）` });
    return out;
  },
};
