// 北冥仓库 · film review：创作闸门的审阅记录（决定 D08）。只记录用户（或用户指定的审阅人）的原话；agent 不得自己批准。
//   approve <闸> <作品>   用户认可：--quote 原话 --source 出处 --reviewer 审阅人；绑定被审的那次运行与文件 sha256
//   reject  <闸> <作品>   用户要求修改：同上，--issues 记逐条意见（「72: 雾太浓；S2: 天色太亮」，开头的数字记成帧号）
//   waive   <闸,闸> <作品> 豁免：--reason 必填；--quote/--source 给了才是用户豁免（才放行 --final）
//   note    <闸> <作品>   agent 的代理审片记录（reviewerKind = ai），留证据但不放行任何闸
//   status  <作品>        各闸当前状态
// final 闸的 approve 会把那次终渲的 run.json 写成 accepted（技术验收已通过、记录完整时）——这是「已交付」的唯一来源。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError, usage } from '../lib/exit.mjs';
import { ROOT, rel } from '../lib/repo.mjs';
import { loadFilm } from '../lib/spec.mjs';
import { GATES, GATE_KIND, GATE_LABEL, gateStatus, writeReview, writeWaivers, hashFiles, reviewLib } from '../lib/gates.mjs';
import { readLatest, writeAtomic, listRuns, jobOf } from '../lib/rundir.mjs';
import { envelope } from '../lib/output.mjs';

export const reviewSpec = {
  positionals: [{ name: '动作', required: true }, { name: '闸', required: false }, { name: '作品目录', required: false }],
  options: {
    '--quote': { type: 'string', arg: '<用户原话>', help: '用户的原话，逐字（approve / reject 必填；waive 给了才是用户豁免）' },
    '--source': { type: 'string', arg: '<出处>', help: '原话出处：会话 / 日期 / 消息位置（与 --quote 一起给）' },
    '--reviewer': { type: 'string', arg: '<审阅人>', help: '谁看的（用户本人或用户指定的审阅人）' },
    '--reason': { type: 'string', arg: '<理由>', help: 'waive 的理由（必填）' },
    '--issues': { type: 'string', arg: '<意见>', help: '逐条意见，分号隔开；以帧号开头的条目记成帧号（72: 雾太浓）' },
    '--note': { type: 'string', arg: '<结论>', help: 'note 的代理审片结论' },
    '--run': { type: 'string', arg: '<run-id>', help: '被审的那次运行（默认该闸对应的最近一次：stills / animatic / build）' },
    '--events': { type: 'string', arg: '<id,id>', help: 'final：用户确认看到的事件 id（缺省取 film.json 的全部事件）' },
    '--style-ref': { type: 'string', arg: '<文件>', help: 'final：风格对照的依据（风格卡、style-lock、基线帧目录）' },
    '--out-root': { type: 'string', arg: '<目录>', help: '运行目录的上层（默认 <作品>/out）' },
  },
};

export const REVIEW_DOC = {
  summary: '创作闸门的审阅记录（决定 D08）：只记用户（或用户指定的审阅人）的原话，agent 不得自己批准',
  usage: [
    'npm run film -- review approve <look|animatic|final> <作品目录> --quote "<用户原话>" --source "<出处>" --reviewer "<审阅人>" [--run <run-id>] [--issues "…"]',
    'npm run film -- review reject  <look|animatic|final> <作品目录> --quote "<用户原话>" --source "<出处>" --reviewer "<审阅人>" [--issues "72: 雾太浓；S2: 天色太亮"]',
    'npm run film -- review waive   <look,animatic> <作品目录> --reason "<理由>" [--quote "<用户原话>" --source "<出处>"]',
    'npm run film -- review note    <look|animatic|final> <作品目录> --note "<代理审片结论>" [--issues "…"]',
    'npm run film -- review status  <作品目录>',
  ],
  description: [
    '三道闸（决定 D08）：look 风格关键帧（film stills）→ animatic 动态预演（film animatic）→ final 终渲（film build --final）。',
    '记录写在 <作品>/review/<闸>-<YYYY-MM-DD>[-n].json（随作品源码提交，格式同作品描述包 engine/production/review.js）。',
    '铁律：approve / reject / waive 只记用户（或用户指定的审阅人）说过的原话，原话要能在会话里逐字找到；agent 不得自己批准，',
    '也不得把「技术检查通过」写成「用户认可」。agent 自己的审片结论用 note（记成 comment，不放行任何闸）。',
    '没有用户原话的 waive 只记一条内部说明（comment），只用于自检，不放行终渲；final 闸不能豁免。',
    'final 闸 approve 后，那次终渲的 run.json 才会是 accepted——「已交付 / 用户已认可」只能由它生成。',
  ],
  examples: [
    'npm run film -- review approve look films/my-film --quote "这版颜色可以" --source "会话 2026-11-10 第 12 条" --reviewer 用户',
    'npm run film -- review status films/my-film',
  ],
  exitCodes: { 0: '成功', 2: '用法错误', 4: '没有可审的运行或记录不合格', 5: '作品正被另一次运行占用' },
};

const ACTIONS = ['approve', 'reject', 'waive', 'note', 'status'];

function parseIssues(raw) {
  if (!raw) return [];
  return raw.split(/[;；\n]/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^[Ff]?(\d+)\s*[:：]\s*(.+)$/.exec(s);
    const sh = /^([A-Za-z][\w-]*)\s*[:：]\s*(.+)$/.exec(s);
    return m ? { frame: Number(m[1]), note: m[2] } : sh ? { shot: sh[1], note: sh[2] } : { note: s };
  });
}

function findRun(film, outRoot, gate, runId) {
  const kind = GATE_KIND[gate];
  // final 闸审的是最近一次成功的终渲（工作版 build 不算）；其余闸取该类运行的 latest 指针
  const id = runId || (gate === 'final'
    ? listRuns(outRoot).find(x => jobOf(x.run) === 'build' && x.run?.final && ['passed', 'accepted'].includes(x.run?.status))?.id || null
    : readLatest(outRoot, kind));
  const cmd = { stills: 'stills', animatic: 'animatic', build: 'build' }[kind];
  if (!id) throw new FilmError(EXIT.CONTRACT, 'nothing-to-review', `${GATE_LABEL[gate]}没有可审的运行：还没有成功的 ${kind} 运行`, `先出给用户看的东西：npm run film -- ${cmd} ${film.relDir}${kind === 'build' ? ' --final' : ''}`);
  const dir = path.join(outRoot, id);
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')); } catch { throw new FilmError(EXIT.USAGE, 'run-unknown', `找不到运行 ${id}（${rel(dir)}/run.json）`); }
  if (jobOf(run) !== kind) throw new FilmError(EXIT.USAGE, 'run-kind', `运行 ${id} 是 ${jobOf(run)}，${GATE_LABEL[gate]}要审的是 ${kind}`);
  // look / animatic 审的是给用户看的东西：编排跑完（outcome = complete）就能审；final 审交付件，必须技术验收通过
  const viewable = gate === 'final' ? ['passed', 'accepted'].includes(run.status) : (run.outcome === 'complete' || ['passed', 'accepted'].includes(run.status));
  if (!viewable) throw new FilmError(EXIT.CONTRACT, 'run-not-passed', `运行 ${id} 的状态是 ${run.status}${run.outcome ? `（${run.outcome}）` : ''}，不能拿来审`, gate === 'final' ? '终渲要先过机器 QA 门；修好后重新终渲' : '先修好并重新出给用户看的东西');
  if (gate === 'final' && !run.final) throw new FilmError(EXIT.CONTRACT, 'final-needs-final-run', `运行 ${id} 不是终渲（没加 --final），final 闸只审终渲`, `npm run film -- build ${film.relDir} --final`);
  return { id, dir, run };
}

function reviewedFiles(gate, dir) {
  const p = n => path.join(dir, n);
  if (gate === 'look') {
    const s = p('stills');
    return [p('contact.jpg'), ...(fs.existsSync(s) ? fs.readdirSync(s).sort().map(n => path.join(s, n)) : [])];
  }
  if (gate === 'animatic') return [p('animatic.mp4'), p('contact.jpg')];
  return [p('master.mp4'), p('web.mp4'), p('contact.jpg')];
}

async function validateAccepted(body, film) {
  const p05 = path.join(ROOT, 'engine/production/film.js');
  const { validateRenderResult } = await import('../../../engine/production/project.js');
  const r = validateRenderResult(body, { expectedFrameCount: body.expected?.frames });
  return { ok: r.ok, diagnostics: r.diagnostics, validator: fs.existsSync(p05) ? 'engine/production/project.js（P05 的 validate-result 合入后改用它）' : 'engine/production/project.js' };
}

export async function reviewCommand(opts, positionals) {
  const [action, gateArg, dirArg] = positionals;
  if (!ACTIONS.includes(action)) throw usage(`review 的动作只能是 ${ACTIONS.join(' / ')}，收到「${action}」`);
  const filmArg = action === 'status' ? gateArg : dirArg;
  if (action === 'status' && dirArg) throw usage('review status 只要 <作品目录>');
  if (!filmArg) throw usage(`缺少参数：${action === 'status' ? '作品目录' : '闸 与 作品目录'}`, `例：npm run film -- review ${action === 'status' ? 'status films/my-film' : `${action} look films/my-film`}`);
  const film = loadFilm(filmArg);
  const outRoot = opts.outRoot ? path.resolve(opts.outRoot) : path.join(film.dir, 'out');
  const lib = await reviewLib();
  const warnings = lib ? [] : [{ code: 'review-builtin', message: '闸门记录由编排器内置实现写入（engine/production/review.js 尚未提供 recordReview / recordWaivers），格式见 tools/film/README.md §6' }];

  if (action === 'status') {
    const st = gateStatus(film);
    const human = GATES.map(g => `${GATE_LABEL[g].padEnd(14)} ${st[g].required ? '必审' : '可选'}  ${({ approved: '已通过', waived: `已豁免（${st[g].waiverKind === 'user' ? '用户' : '内部'}）`, 'changes-requested': '要修改', pending: '待审' })[st[g].state]}${st[g].at ? `  ${st[g].at}` : ''}${st[g].by ? `  ${st[g].by}` : ''}${st[g].quote ? `  「${st[g].quote}」` : ''}`).join('\n');
    return { env: envelope({ command: 'film review status', outputs: [], warnings, data: { film: film.relDir, gates: st } }), human };
  }

  const gates = action === 'waive' ? String(gateArg).split(',').map(s => s.trim()).filter(Boolean) : [gateArg];
  for (const g of gates) if (!GATES.includes(g)) throw usage(`闸只能是 ${GATES.join(' / ')}，收到「${g}」`);
  if ((opts.quote && !opts.source) || (!opts.quote && opts.source)) throw usage('--quote 与 --source 要一起给：原话和它的出处缺一不可');
  const at = new Date().toISOString();

  if (action === 'waive') {
    if (gates.includes('final')) throw usage('final 闸不能豁免：终渲必须由用户看过成片后 approve');
    if (!opts.reason) throw usage('waive 要写 --reason <理由>');
    const list = gates.map(g => ({ gate: g, reason: opts.reason, quote: opts.quote || null, source: opts.source || null, kind: opts.quote ? 'user' : 'internal', recordedAt: at, recordedBy: 'tools/film/cli.mjs review waive' }));
    const file = await writeWaivers(film, list);
    if (!opts.quote) warnings.push({ code: 'waiver-internal', message: '没有 --quote / --source：这是内部豁免，只用于自检，不放行 --final' });
    return { env: envelope({ command: 'film review waive', outputs: [{ path: file, sha256: null, kind: 'waivers' }], warnings, data: { gates, kind: list[0].kind } }), human: `已记豁免：${gates.join('、')}（${list[0].kind === 'user' ? '用户豁免' : '内部豁免，不放行 --final'}）→ ${file}` };
  }

  const gate = gates[0];
  if (action === 'note') {
    if (!opts.note) throw usage('note 要写 --note <代理审片结论>');
    const rec = { gate, decision: 'agent-note', reviewerKind: 'ai', reviewer: opts.reviewer || 'agent', quote: null, source: null, note: opts.note, issues: parseIssues(opts.issues), run: null, files: [], recordedAt: at, recordedBy: 'tools/film/cli.mjs review note' };
    try { const r = findRun(film, outRoot, gate, opts.run); rec.run = { id: r.id, kind: r.run.kind, dir: rel(r.dir) }; rec.files = hashFiles(reviewedFiles(gate, r.dir)); } catch { /* 代理审片可以不绑定运行 */ }
    const file = await writeReview(film, rec);
    return { env: envelope({ command: 'film review note', outputs: [{ path: file, sha256: null, kind: 'review' }], warnings, data: { gate, decision: rec.decision } }), human: `已记代理审片（不放行任何闸）→ ${file}` };
  }

  if (!opts.quote || !opts.source) throw usage(`${action} 要给 --quote "<用户原话>" 与 --source "<出处>"`, 'approve / reject 只能记录用户（或用户指定的审阅人）说过的原话；agent 自己的结论用 review note');
  if (!opts.reviewer) throw usage(`${action} 要给 --reviewer "<审阅人>"（用户本人或用户指定的人）`);
  if (opts.quote.trim().length < 2) throw usage('--quote 太短：要逐字写用户的原话');
  if ((opts.events || opts.styleRef) && gate !== 'final') throw usage('--events / --style-ref 只用于 final 闸');
  if (opts.events && film.events.length) {
    const ids = new Set(film.events.map(e => e.id));
    const bad = opts.events.split(',').map(x => x.trim()).filter(x => x && !ids.has(x));
    if (bad.length) throw usage(`--events 里有 film.json 事件表没有的 id：${bad.join('、')}`, `可用：${[...ids].join('、')}`);
  }
  if (opts.styleRef && !fs.existsSync(path.resolve(opts.styleRef))) throw usage(`--style-ref 指的文件不存在：${opts.styleRef}`, '给风格卡、style-lock 或基线帧的路径（相对当前目录）');
  const r = findRun(film, outRoot, gate, opts.run);
  const rec = {
    gate, decision: action === 'approve' ? 'approved' : 'changes-requested', reviewerKind: 'human', reviewer: opts.reviewer,
    quote: opts.quote, source: opts.source, issues: parseIssues(opts.issues), run: { id: r.id, kind: r.run.kind, dir: rel(r.dir) },
    files: hashFiles(reviewedFiles(gate, r.dir)), recordedAt: at, recordedBy: `tools/film/cli.mjs review ${action}`,
  };
  const file = await writeReview(film, rec);
  const outputs = [{ path: file, sha256: null, kind: 'review' }];
  let human = `已记 ${GATE_LABEL[gate]}：${action === 'approve' ? '通过' : '要修改'}（${opts.reviewer}：「${opts.quote}」）→ ${file}`;
  let accepted = null;

  if (gate === 'final') {
    // 把那次终渲的 run.json 写成用户认可；status = accepted 还要求技术验收已通过、校验器认可
    const f = path.join(r.dir, 'run.json');
    const body = JSON.parse(fs.readFileSync(f, 'utf8'));
    const review = { reviewerKind: 'human', reviewer: opts.reviewer, quote: opts.quote, source: opts.source, decision: rec.decision, record: file, recordedAt: at, issues: rec.issues };
    const ca = body.creativeAcceptance || {};
    ca.reviews = [...(ca.reviews || []), review];
    if (action === 'approve') {
      ca.status = 'accepted';
      // 用户确认看到的事件：作品声明了事件表时只认表里的 id；没有事件表时记用户说的可见事件（原样文字）
      const declared = film.events.map(e => e.id).filter(Boolean);
      const ev = opts.events ? opts.events.split(',').map(s => s.trim()).filter(Boolean) : declared;
      ca.events = ev.map(id => ({ id, declared: declared.includes(id), confirmedBy: opts.reviewer, record: file }));
      if (opts.styleRef) ca.styleComparison = [{ against: opts.styleRef, by: opts.reviewer, record: file }];
      ca.issues = rec.issues;
      body.creativeAcceptance = ca;
      const tech = body.technicalAcceptance?.status;
      if (tech === 'passed') {
        const trial = { ...body, status: 'accepted' };
        const v = await validateAccepted(trial, film);
        if (v.ok) { body.status = 'accepted'; accepted = true; }
        else {
          accepted = false;
          warnings.push({ code: 'accepted-incomplete', message: `用户认可已记下，但运行还不能标为 accepted：${v.diagnostics.map(d => d.message).join('；')}（补 --style-ref <风格对照依据> 或 --events 后再 approve 一次）` });
        }
      } else {
        accepted = false;
        warnings.push({ code: 'accepted-without-technical', message: `用户认可已记下，但这次终渲的技术验收是 ${tech}：机器 QA 通过前不能称「已交付」` });
      }
    } else { ca.status = 'rejected'; body.creativeAcceptance = ca; }
    writeAtomic(f, JSON.stringify(body, null, 2) + '\n');
    outputs.push({ path: rel(f), sha256: null, kind: 'run-json' });
    if (accepted) human += `\n运行 ${r.id} 已标为 accepted：可以称「已交付（用户已认可）」。`;
    else if (action === 'approve') human += `\n运行 ${r.id} 还不是 accepted（见警告），不要对外称「已交付」。`;
  }
  if (warnings.length) human += '\n' + warnings.map(w => `[警告] ${w.message}`).join('\n');
  return { env: envelope({ command: `film review ${action}`, outputs, runJson: gate === 'final' ? rel(path.join(r.dir, 'run.json')) : null, warnings, data: { gate, decision: rec.decision, run: r.id, accepted } }), human };
}
