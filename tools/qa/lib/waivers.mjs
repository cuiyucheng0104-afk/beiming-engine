// 北冥 QA · 豁免：一条豁免只放行一项检查里的某个对象（文字、事件、帧区间），必须写明谁批准、原话、出处。
// agent 不得自己批准（D08）；approvedBy 写成 agent / AI / 助手 这类的豁免一律无效并报 warning。
// 刻意设计的静帧、黑场、闪白不是豁免，写在 film.json 的 qa.intentional（见 docs/quality/QA-GATE.md）。
//
//   collectWaivers({ film, files, root })  → { waivers, warnings }：film.json 的 qa.waivers、--waivers 文件、docs/quality/waivers/<作品 id>.json
//   validateWaiver(w)                       → 问题列表（空 = 合格）
//   applyWaivers(check, waivers)            给 check.findings 里匹配的 fail / warn 标上 waived，并重算 check.status
//   statusOf(findings)                      fail > warn > waived > pass
import fs from 'node:fs';
import path from 'node:path';

export const WAIVER_DIR = 'docs/quality/waivers';
const AGENT = /^(agent|ai|claude|assistant|bot|gpt|codex|代理|助手|智能体|机器人)\b/i;

export function validateWaiver(w) {
  const probs = [];
  if (!w || typeof w !== 'object') return ['豁免必须是对象'];
  if (typeof w.check !== 'string' || !w.check) probs.push('缺 check（要放行的检查 id，如 texts.duration）');
  for (const k of ['reason', 'approvedBy', 'quote', 'source']) {
    if (typeof w[k] !== 'string' || !w[k].trim()) probs.push(`缺 ${k}`);
  }
  if (typeof w.approvedBy === 'string' && AGENT.test(w.approvedBy.trim())) probs.push('approvedBy 不能是 agent 自己：豁免只能由用户或集成负责人批准（D08）');
  if (w.frames !== undefined && !(Array.isArray(w.frames) && w.frames.length === 2 && w.frames.every(Number.isInteger) && w.frames[1] > w.frames[0])) {
    probs.push('frames 要写成 [起帧, 止帧) 的整数半开区间');
  }
  return probs;
}

function readList(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(doc) ? doc : Array.isArray(doc.waivers) ? doc.waivers : [];
}

export function collectWaivers({ film = null, files = [], root }) {
  const warnings = [];
  const out = [];
  const take = (list, origin) => {
    for (const w of list) {
      const probs = validateWaiver(w);
      if (probs.length) { warnings.push(`忽略 ${origin} 里的一条豁免（${w?.check || '?'}）：${probs.join('；')}`); continue; }
      out.push({ ...w, origin });
    }
  };
  if (film?.qa?.waivers?.length) take(film.qa.waivers, film.file ? path.relative(root, film.file).split(path.sep).join('/') : 'film.json');
  if (film?.id) {
    const f = path.join(root, WAIVER_DIR, `${film.id}.json`);
    if (fs.existsSync(f)) {
      try { take(readList(f), `${WAIVER_DIR}/${film.id}.json`); } catch (e) { warnings.push(`${WAIVER_DIR}/${film.id}.json 读不出来：${e.message}`); }
    }
  }
  for (const f of files) {
    try { take(readList(f), f); } catch (e) { warnings.push(`豁免文件 ${f} 读不出来：${e.message}`); }
  }
  return { waivers: out, warnings };
}

const overlaps = (a, b) => a && b && a[0] < b[1] && b[0] < a[1];
function matches(w, checkId, f) {
  const c = w.check.endsWith('.*') ? checkId.startsWith(w.check.slice(0, -1)) : w.check === checkId;
  if (!c) return false;
  if (w.target !== undefined && w.target !== '*' && w.target !== f.target) return false;
  if (w.frames && f.frames && !overlaps(w.frames, f.frames)) return false;
  if (w.frames && !f.frames) return false;
  return true;
}

export function statusOf(findings, fallback = 'pass') {
  if (findings.some(f => f.status === 'fail')) return 'fail';
  if (findings.some(f => f.status === 'warn')) return 'warn';
  if (findings.some(f => f.status === 'waived')) return 'waived';
  return fallback;
}

export function applyWaivers(check, waivers) {
  const used = [];
  for (const f of check.findings || []) {
    if (f.status !== 'fail' && f.status !== 'warn') continue;
    const w = waivers.find(x => matches(x, check.id, f));
    if (!w) continue;
    f.waivedFrom = f.status;
    f.status = 'waived';
    f.waiver = { check: w.check, target: w.target ?? null, frames: w.frames ?? null, reason: w.reason, approvedBy: w.approvedBy, quote: w.quote, source: w.source, date: w.date ?? null, origin: w.origin };
    if (!used.includes(w)) used.push(w);
  }
  if (used.length) {
    check.waiver = used.map(w => ({ check: w.check, target: w.target ?? null, approvedBy: w.approvedBy, source: w.source, origin: w.origin }));
    if (check.status !== 'error') check.status = statusOf(check.findings, check.status === 'fail' || check.status === 'warn' ? 'waived' : check.status);
  }
  return check;
}
