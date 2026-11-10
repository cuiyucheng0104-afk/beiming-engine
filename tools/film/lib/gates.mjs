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
// P05 的闸门库（engine/production/review.js）导出 REVIEW_API_VERSION = 1 与 approve / waive / gateStatus 时转调它；
// 在那之前用这里的内置实现，文件格式与加固计划 P05·M1 的描述一致（见 tools/film/README.md「闸门记录」）。
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
      if (m.REVIEW_API_VERSION === 1 && ['approve', 'waive', 'gateStatus'].every(k => typeof m[k] === 'function')) p05 = m;
    } catch { /* 坏模块按未提供处理 */ }
  }
  return p05;
}

const reviewDir = film => path.join(film.dir, 'review');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function readRecords(film) {
  const dir = reviewDir(film);
  if (!fs.existsSync(dir)) return { reviews: [], waivers: [] };
  const reviews = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const m = /^(look|animatic|final)-.+\.json$/.exec(name);
    if (!m) continue;
    const j = readJson(path.join(dir, name));
    if (!j || j.gate !== m[1]) continue;
    const decision = j.decision === 'approve' ? 'approved' : j.decision;
    reviews.push({ ...j, decision, file: rel(path.join(dir, name)) });
  }
  const w = readJson(path.join(dir, 'waivers.json'));
  const waivers = (Array.isArray(w?.waivers) ? w.waivers : []).filter(x => x && GATES.includes(x.gate) && !x.revoked)
    .map(x => ({ ...x, kind: x.quote && x.source ? 'user' : (x.kind === 'user' ? 'user' : 'internal') }));
  return { reviews, waivers };
}

export function gateStatus(film) {
  const { reviews, waivers } = readRecords(film);
  const out = {};
  for (const g of GATES) {
    const items = [
      ...reviews.filter(r => r.gate === g && r.reviewerKind !== 'ai').map(r => ({ t: r.recordedAt, state: r.decision === 'approved' ? 'approved' : 'changes-requested', by: r.reviewer, quote: r.quote, source: r.source, record: r.file, run: r.run?.id || null })),
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
  throw new FilmError(EXIT.CONTRACT, 'gate-blocked', `拒绝终渲：${desc}`,
    `先把预演给用户看，用户认可后记录：node tools/film/cli.mjs review approve ${blockers.at(-1)} ${d} --quote "<用户原话>" --source "<出处>" --reviewer "<审阅人>"；` +
    `用户明确说不看时记豁免：node tools/film/cli.mjs review waive ${blockers.join(',')} ${d} --reason "<理由>" --quote "<用户原话>" --source "<出处>"。agent 不得自己批准`);
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
  if (lib) return lib.approve(film.dir, rec.gate, rec);
  const dir = reviewDir(film);
  fs.mkdirSync(dir, { recursive: true });
  const f = uniqueFile(dir, `${rec.gate}-${stamp(new Date(rec.recordedAt))}`);
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: 1, ...rec }, null, 2) + '\n', { flag: 'wx' });
  return rel(f);
}

export async function writeWaivers(film, list) {
  const lib = await reviewLib();
  if (lib) return lib.waive(film.dir, list.map(x => x.gate), list[0]);
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
