// spec.profiles：交付档位表 engine/production/profiles.json 合格（决策 D07：默认 web-1080p24，六个档位齐全），
// 而且机器 QA（tools/qa/lib/profiles.mjs）读它时不需要任何兜底：字段写法与 QA 对齐，QA 报告不会因为缺字段逐项标 warn。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { engineLibs, finding } from './_lib.mjs';

const FILE = 'engine/production/profiles.json';
export const D07_PROFILES = Object.freeze(['web-1080p24', 'master-1080p24', 'uhd-2160p24', 'vertical-1080x1920-30', 'broadcast-1080p25', 'beiming-1040p24']);

export default {
  id: 'spec.profiles',
  title: '交付档位表合格（D07），QA 读它不需要兜底',
  async run(ctx) {
    const L = await engineLibs(ctx);
    let P;
    try { P = L.film.loadProfiles({ file: ctx.abs(FILE), fresh: true }); } catch (error) { return [finding('error', error.code ?? 'profiles-invalid', FILE, error.message, error.hint)]; }
    const out = [];
    if (P.default !== 'web-1080p24') out.push(finding('error', 'profile-default', FILE, `默认档是 ${P.default}，决策 D07 定为 web-1080p24`));
    for (const id of D07_PROFILES) if (!P.profiles[id]) out.push(finding('error', 'profile-missing', FILE, `缺少决策 D07 的档位 ${id}`));
    const qaLib = path.join(ctx.root, 'tools', 'qa', 'lib', 'profiles.mjs');
    if (fs.existsSync(qaLib)) {
      const { loadProfiles } = await import(pathToFileURL(qaLib).href);
      const store = loadProfiles({ root: ctx.root });   // 不给 file：QA 按默认位置读，提示里的路径是仓库相对的
      for (const w of store.warnings) out.push(finding('error', 'profile-qa-fallback', FILE, `机器 QA 读档位表时要兜底：${w}`));
      for (const p of store.profiles.values()) {
        for (const w of p.warnings) out.push(finding('error', 'profile-qa-fallback', FILE, `机器 QA 读档位 ${p.id} 时要兜底：${w}`, '按 tools/qa/lib/profiles.mjs 的 adapt 认得的写法补字段（engine/production/README.md §3）'));
      }
    }
    if (!out.length) out.push({ level: 'info', message: `${Object.keys(P.profiles).length} 个交付档位合格，机器 QA 直接读取、没有兜底项` });
    return out;
  },
};
