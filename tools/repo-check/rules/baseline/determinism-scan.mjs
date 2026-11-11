// baseline.determinism-scan：渲染路径不用不确定的 API（ORCH-08、QUAL-10）。
//   engine/ 浏览器端代码、films/**、路线模版里不许出现 Math.random / Date.now / performance.now / new Date / crypto.getRandomValues
//   （注释与字符串不算；只用于计时打日志的写法在同一行或上一行写 // determinism-ok: <理由>）。
//   存量登记 tools/baseline/determinism-allow.json 只减不增：登记过却已经扫不到的条目提示删掉。
import { scanFiles, listFiles, defaultTargets, loadAllow } from '../../../baseline/lib/scan.mjs';

const ALLOW = 'tools/baseline/determinism-allow.json';

export default {
  id: 'baseline.determinism-scan',
  title: '渲染路径不用不确定的 API（Math.random、Date.now、performance.now、new Date）',
  run(ctx) {
    const out = [];
    let allow = [];
    try { allow = ctx.exists(ALLOW) ? loadAllow(ctx.abs(ALLOW)) : []; } catch (e) { return [{ level: 'error', file: ALLOW, message: `读不出来（${e.message}）` }]; }
    const r = scanFiles(ctx.root, listFiles(ctx.root, defaultTargets(ctx.root)), allow);
    for (const e of r.errors) {
      out.push({ level: 'error', file: e.file, line: e.line, message: `${e.api}：渲染结果会随时间或随机数变化`, excerpt: e.text,
        hint: '改成由 t 与固定种子算出（engine/core 的 mulberry、createNoise*(seed)）；只用于计时打日志的写法在同一行写 // determinism-ok: <理由>' });
    }
    // 存量登记只减不增：扫默认范围加 src/，登记过却已经扫不到的条目提示删掉
    const all = scanFiles(ctx.root, listFiles(ctx.root, [...defaultTargets(ctx.root), 'src']), allow).findings;
    for (const a of allow) {
      if (!all.some(f => f.file === a.file && f.api === a.api && a.re.test(f.text))) out.push({ level: 'warn', file: ALLOW, message: `存量登记已失效（${a.file} 里扫不到 ${a.api}）`, hint: '删掉这一条' });
    }
    return out;
  },
};
