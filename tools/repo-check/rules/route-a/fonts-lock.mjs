// route-a.fonts-lock：字体锁定清单 fonts/fonts.lock.json 合格（只收 OFL-1.1、sha256、https 镜像、许可文件在），
// 许可全文的 sha256 与清单一致（子集化时随字体复制进作品，许可文本被改过就不能再分发）。决定 D10：字体本体不进 git。
import fs from 'node:fs';
import { validateLock } from '../../../fonts/lock.mjs';
import { sha256 } from '../../../lib/cli.mjs';

const LOCK = 'fonts/fonts.lock.json';

export default {
  id: 'route-a.fonts-lock',
  title: '字体锁定清单合格，OFL 许可全文与清单记的 sha256 一致',
  run(ctx) {
    if (!ctx.exists(LOCK)) return [];
    let lock;
    try { lock = ctx.readJson(LOCK); } catch (e) { return [{ level: 'error', file: LOCK, message: `不是合法 JSON：${e.message}` }]; }
    const out = validateLock(lock, { root: ctx.root }).map(m => ({ level: 'error', file: LOCK, message: m, hint: '格式见文件开头的 $comment；新字体只收 OFL-1.1，带 sha256 与 https 镜像' }));
    for (const f of lock.fonts || []) {
      if (!f.licenseFile || !ctx.exists(f.licenseFile) || !f.licenseSha256) continue;
      const txt = fs.readFileSync(ctx.abs(f.licenseFile), 'utf8').replace(/\r\n/g, '\n');
      if (sha256(txt) !== f.licenseSha256) out.push({ level: 'error', file: f.licenseFile, message: '许可全文的 sha256 与清单不一致（被改过）', hint: `从上游 ${f.source?.repo || ''} 恢复原文` });
    }
    if (!out.length) out.push({ level: 'info', file: LOCK, message: `${lock.fonts.length} 款 OFL 字体，许可全文都对得上` });
    return out;
  },
};
