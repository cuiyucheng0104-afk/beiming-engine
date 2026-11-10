// 北冥仓库 · 出片编排 · 创作闸门记录（决定 D08：look → animatic → final）。
// 记录写在作品目录的 review/ 下，随作品源码提交（它们是审片证据，不是产物）：
//   review/<闸>-<UTC 时间>.json   一次审阅：{ schemaVersion, gate, decision: approved|changes-requested, reviewerKind: human|ai,
//                                  reviewer, quote（用户原话）, source（出处）, run{id,kind,dir}, files[{path,sha256}], issues[], recordedAt, recordedBy }
//   review/waivers.json           豁免：{ schemaVersion, waivers: [{ gate, reason, quote, source, kind: user|internal, recordedAt, recordedBy }] }
// 规则：
//   - 只有 reviewerKind = human 的 approved 记录算通过；agent 的代理审片可以记（reviewerKind = ai），但不放行任何闸。
//   - 豁免必须写理由；带 --quote 用户原话与 --source 出处的是 user 豁免，否则是 internal（只用于自检，不放行 --final）。
//   - 每道闸取时间最晚的一条有效记录（human 审阅或豁免）定状态：approved / waived / changes-requested / pending。
//   - 终渲（build --final）要求 film.json 里 required 的 look 与 animatic 都是 approved 或 user 豁免，否则退出码 4。
//   - 「已交付 / 用户已认可」只由 final 闸的 human approved 生成（run.json 的 status = accepted）。
// 写记录：P05 的闸门库（engine/production/review.js）导出 REVIEW_API_VERSION = 1 与通用的 recordReview(filmDir, rec)、
// recordWaivers(filmDir, list) 时转调它（rec 的字段就是上面这些，approve / reject / note 共用一个入口，不按动作分函数，
// 免得把「要修改」误记成「通过」）；否则用这里的内置实现。文件格式与加固计划 P05·M1 的描述一致（见 tools/film/README.md §6）。
// 读记录、判闸门一律用这里的实现（只认合格记录），与写入方是谁无关。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT, FilmError } from './exit.mjs';
import { ROOT, rel, sha256File } from './repo.mjs';
import { stamp } from './rundir.mjs';

export const GATES = ['look', 'animatic', 'final'];
export const GATE_KIND = { look: 'stills', animatic: 'animatic', final: 'build' };
export const GATE_LABEL = { look: '风格关键帧（look）', animatic: '动态预演（animatic）', final: '终渲成片（final）' };

let p05 = undefined;
export async function reviewLib() {
  if (p05 !== undefined) return p05;
  p05 = null;
  const f = path.join(ROOT, 'engine/production/review.js');
  if (fs.existsSync(f)) {
    try {
      const m = await import(pathToFileURL(f).href);
      if (m.REVIEW_API_VERSION === 1 && ['recordReview', 'recordWaivers'].every(k => typeof m[k] === 'function')) p05 = m;
    } catch { /* 坏模块按未提供处理 */ }
  }
  return p05;
}

const reviewDir = film => path.join(film.dir, 'review');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const filled = v => typeof v === 'string' && v.trim().length > 0;
// 一条审阅能不能算数：approve / reject 必须是 human、写明审阅人、用户原话（至少 2 个字）与出处；agent 的 note 只留证据
export function reviewProblems(j) {
  const p = [];
  if (j.decision === 'agent-note') { if (j.reviewerKind !== 'ai') p.push('agent-note 的 reviewerKind 应为 ai'); return p; }
  if (!['approved', 'changes-requested'].includes(j.decision)) p.push(`decision 不认识：${JSON.stringify(j.decision)}`);
  if (j.reviewerKind !== 'human') p.push(`reviewerKind 应为 human（收到 ${JSON.stringify(j.reviewerKind)}）`);
  if (!filled(j.reviewer)) p.push('缺审阅人');
  if (!(filled(j.quote) && j.quote.trim().length >= 2)) p.push('缺用户原话');
  if (!filled(j.source)) p.push('缺原话出处');
  return p;
}

export function readRecords(film) {
  const dir = reviewDir(film);
  if (!fs.existsSync(dir)) return { reviews: [], waivers: [], invalid: [] };
  const reviews = [], invalid = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const m = /^(look|animatic|final)-.+\.json$/.exec(name);
    if (!m) continue;
    const file = rel(path.join(dir, name));
    const j = readJson(path.join(dir, name));
    if (!j || j.gate !== m[1]) { invalid.push({ file, problems: [j ? `gate 与文件名不符（${JSON.stringify(j.gate)}）` : '不是合法 JSON'] }); continue; }
    const decision = j.decision === 'approve' ? 'approved' : j.decision;
    const problems = reviewProblems({ ...j, decision });
    if (problems.length) { invalid.push({ file, problems }); continue; }   // 不合格的记录不放行任何闸
    reviews.push({ ...j, decision, file });
  }
  const w = readJson(path.join(dir, 'waivers.json'));
  const waivers = [];
  for (const [i, x] of (Array.isArray(w?.waivers) ? w.waivers : []).entries()) {
    if (!x || x.revoked) continue;
    if (!['look', 'animatic'].includes(x.gate) || !filled(x.reason)) { invalid.push({ file: rel(path.join(dir, 'waivers.json')), problems: [`第 ${i + 1} 条豁免：${x.gate === 'final' ? 'final 闸不能豁免' : !filled(x.reason) ? '没有理由' : `gate 不认识（${JSON.stringify(x.gate)}）`}`] }); continue; }
    waivers.push({ ...x, kind: filled(x.quote) && filled(x.source) ? 'user' : 'internal' });
  }
  return { reviews, waivers, invalid };
}

export function gateStatus(film) {
  const { reviews, waivers, invalid } = readRecords(film);
  const out = {};
  Object.defineProperty(out, 'invalid', { value: invalid, enumerable: false });
  for (const g of GATES) {
    const items = [
      ...reviews.filter(r => r.gate === g && r.reviewerKind === 'human').map(r => ({ t: r.recordedAt, state: r.decision === 'approved' ? 'approved' : 'changes-requested', by: r.reviewer, quote: r.quote, source: r.source, record: r.file, run: r.run?.id || null })),
      ...waivers.filter(x => x.gate === g).map(x => ({ t: x.recordedAt, state: 'waived', waiverKind: x.kind, by: x.recordedBy, quote: x.quote || null, source: x.source || null, reason: x.reason, record: rel(path.join(reviewDir(film), 'waivers.json')) })),
    ].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    const last = items.at(-1);
    out[g] = { required: film.gates[g] === 'required', state: last?.state || 'pending', ...(last ? { at: last.t, ...last } : {}), history: items.length, aiReviews: reviews.filter(r => r.gate === g && r.reviewerKind === 'ai').length };
    delete out[g].t;
  }
  return out;
}

export const passes = (s, { final = false } = {}) => s.state === 'approved' || (s.state === 'waived' && (!final || s.waiverKind === 'user'));

// 终渲前的闸门检查：返回放行依据；不满足时抛 FilmError(4)，信息里给出补记录的确切命令
export function assertFinalAllowed(film, status) {
  const blockers = ['look', 'animatic'].filter(g => film.gates[g] === 'required' && !passes(status[g], { final: true }));
  if (!blockers.length) return ['look', 'animatic'].map(g => ({ gate: g, state: status[g].state, record: status[g].record || null }));
  const desc = blockers.map(g => {
    const s = status[g];
    const why = s.state === 'pending' ? '没有审阅记录' : s.state === 'changes-requested' ? `用户要求修改（${s.at}）` : s.state === 'waived' ? '只有内部豁免（没有用户原话）' : s.state;
    return `${GATE_LABEL[g]}：${why}`;
  }).join('；');
  const d = film.relDir;
  const first = blockers[0];
  const make = first === 'look' ? `npm run film -- stills ${d}` : `npm run film -- animatic ${d}`;
  throw new FilmError(EXIT.CONTRACT, 'gate-blocked', `拒绝终渲：${desc}`,
    `按顺序过闸：先 ${make}，把产物给用户看，用户认可后按原话记录 npm run film -- review approve ${first} ${d} --quote "<用户原话>" --source "<出处>" --reviewer "<审阅人>"` +
    `${blockers.length > 1 ? `，再过 ${blockers.slice(1).join('、')}` : ''}；` +
    `用户明确说不用看时记豁免：npm run film -- review waive ${blockers.join(',')} ${d} --reason "<理由>" --quote "<用户原话>" --source "<出处>"。agent 不得自己批准，也不得替用户写原话`);
}

function uniqueFile(dir, base) {
  for (let i = 1; i < 100; i++) {
    const f = path.join(dir, i === 1 ? `${base}.json` : `${base}-${i}.json`);
    if (!fs.existsSync(f)) return f;
  }
  throw new FilmError(EXIT.BUSY, 'review-name', `review/ 下同名记录过多：${base}`);
}

export async function writeReview(film, rec) {
  const lib = await reviewLib();
  if (lib) return lib.recordReview(film.dir, { schemaVersion: 1, ...rec });
  const dir = reviewDir(film);
  fs.mkdirSync(dir, { recursive: true });
  const f = uniqueFile(dir, `${rec.gate}-${stamp(new Date(rec.recordedAt))}`);
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: 1, ...rec }, null, 2) + '\n', { flag: 'wx' });
  return rel(f);
}

export async function writeWaivers(film, list) {
  const lib = await reviewLib();
  if (lib) return lib.recordWaivers(film.dir, list);
  const dir = reviewDir(film);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'waivers.json');
  const cur = readJson(f);
  const waivers = Array.isArray(cur?.waivers) ? cur.waivers : [];
  waivers.push(...list);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, waivers }, null, 2) + '\n');
  fs.renameSync(tmp, f);
  return rel(f);
}

// 审阅要绑定被看的文件：记下它们的 sha256，事后能核对看的是哪一版
export function hashFiles(files) {
  return files.filter(f => f && fs.existsSync(f)).map(f => ({ path: rel(f), sha256: sha256File(f) }));
}
