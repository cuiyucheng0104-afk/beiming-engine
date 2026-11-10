// 创作闸门与作品状态机（决策 D08；计划 P05·M1；北极星验收第 5 条）。
// draft → look-approved → animatic-approved → rendered → qa-passed → accepted；只有 accepted 才能生成「已交付」。
// agent 不能自己批准：没有用户原话与出处的 approve / reject / waive 无效；final 不能豁免。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFilm } from '../../engine/production/film.js';
import { buildReview, gateVerdict, readReviews, validateReview, writeReview } from '../../engine/production/review.js';
import {
  GateError, assertDelivered, assertFinalAllowed, creativeAcceptanceOf, deliveryLabel, filmStatus, findUnbackedClaims, validateRunRecord,
} from '../../engine/production/state.js';
import { validateCreativeAcceptance as validateCreativeContract } from '../../engine/production/project.js';
import { buildReport, technicalAcceptanceFrom } from '../../tools/qa/lib/report.mjs';
import { HUMAN, minimalFilm, runFilm, tempFilm } from './helpers.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const codesOf = r => r.diagnostics.filter(d => d.level === 'error').map(d => d.code);

/** 记一条人工结论（库接口，等价于 film.js review）。 */
function record(dir, gate, decision, extra = {}) {
  const L = loadFilm(dir);
  const rec = buildReview({ film: L.film, pathBase: L.pathBase, gate, decision, ...HUMAN, ...extra });
  const v = validateReview(rec, { film: L.film });
  if (!v.ok) throw new Error(`记录不合格：${codesOf(v).join(', ')}`);
  return writeReview(dir, rec);
}

/** 机器 QA 的报告（tools/qa/lib/report.mjs 的 buildReport，与 node tools/qa/cli.mjs report 写出的同一形状）。 */
function qaReport(film, { ok = true, inputSha, profile = 'web-1080p24' } = {}) {
  return buildReport({
    film: { id: film.id, title: film.title, route: film.route, frameCount: film.output.frameCount },
    input: { path: 'web.mp4', sha256: inputSha },
    profile: { id: profile, source: 'engine/production/profiles.json' },
    checks: [{ id: 'delivery.size', group: 'delivery', title: '尺寸', severity: 'hard', status: ok ? 'pass' : 'fail', value: '1920×1080', expected: '1920×1080', evidence: {} }],
  });
}

/**
 * 写一次终渲：out/<run-id>/run.json + web.mp4 + latest 指针；qa 给出时写 qa/report.json。
 * evidence = 'run'（默认，相对运行目录 qa/report.json）或 'repo'（tools/qa 的写法：仓库相对路径，repoRoot 是临时目录的根）。
 */
function writeRun(dir, { runId = '20261110-120000-abc1234', status = 'rendered', kind = 'final', video = 'FAKE-MP4-BYTES', qa = null, film = minimalFilm(), evidence = 'run', root = null } = {}) {
  const runDir = join(dir, 'out', runId);
  mkdirSync(join(runDir, 'qa'), { recursive: true });
  writeFileSync(join(runDir, 'web.mp4'), video);
  const report = qa ? qaReport(film, { ok: qa.ok, inputSha: qa.sha ?? sha(video), profile: qa.profile }) : null;
  const reportPath = evidence === 'repo' ? join(dir, 'out', runId, 'qa', 'report.json').slice(root.length + 1).split(/[\\/]/).join('/') : 'qa/report.json';
  const run = {
    schemaVersion: 1, kind, status, projectId: film.id, shotId: 'film', route: film.route, backend: film.backend,
    sourceCommit: 'abc1234', actualDevice: 'Apple M5 Pro', actualGraphicsBackend: 'ANGLE-metal', actualEncoder: 'libx264',
    output: { path: 'web.mp4', sha256: sha(video), width: 1920, height: 1080, fps: 24, frames: film.output.frameCount, pixFmt: 'yuv420p' },
    technicalAcceptance: report?.ok && status === 'passed' ? technicalAcceptanceFrom(report, reportPath) : { status: 'not-run', evidence: [] },
    creativeAcceptance: { status: 'not-reviewed', reviews: [] },
  };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  if (report) writeFileSync(join(runDir, 'qa', 'report.json'), JSON.stringify(report, null, 1));
  writeFileSync(join(dir, 'out', 'latest'), `${runId}\n`);
  return { runDir, sha: sha(video), runId };
}

test('完整一遍：draft → look → animatic → rendered → qa-passed → accepted，只有 accepted 得到「已交付」', () => {
  const t = tempFilm(minimalFilm(), { 'stills/look.png': 'LOOK-FRAME', 'preview/animatic.mp4': 'ANIMATIC' });
  try {
    let s = filmStatus(t.dir);
    assert.equal(s.state, 'draft');
    assert.equal(s.canFinal, false);
    assert.throws(() => assertFinalAllowed(t.dir), e => e instanceof GateError && e.exitCode === 4 && /look/.test(e.message) && /animatic/.test(e.message));

    record(t.dir, 'look', 'approve', { reviewed: [{ path: 'stills/look.png' }] });
    s = filmStatus(t.dir);
    assert.equal(s.state, 'look-approved');
    assert.equal(s.gates.look.status, 'approved');
    assert.throws(() => assertFinalAllowed(t.dir), e => /animatic/.test(e.message) && !/look（/.test(e.message));

    record(t.dir, 'animatic', 'approve', { quote: '节奏对了，可以终渲。', reviewed: [{ path: 'preview/animatic.mp4' }] });
    s = filmStatus(t.dir);
    assert.equal(s.state, 'animatic-approved');
    assert.equal(assertFinalAllowed(t.dir).canFinal, true);

    const run = writeRun(t.dir);
    s = filmStatus(t.dir);
    assert.equal(s.state, 'rendered');
    assert.equal(deliveryLabel(s), '已终渲，待机器 QA');

    writeRun(t.dir, { status: 'passed', qa: { ok: true } });
    s = filmStatus(t.dir);
    assert.equal(s.state, 'qa-passed');
    assert.equal(deliveryLabel(s), '技术检查通过，待用户审看成片');
    assert.throws(() => assertDelivered(t.dir), e => e instanceof GateError && /qa-passed/.test(e.message));
    assert.deepEqual(findUnbackedClaims('《测试片》已交付，用户已认可。', s).map(x => x.claim), ['已交付', '用户已认可']);
    assert.deepEqual(findUnbackedClaims('技术检查通过，未交付。', s), []);

    // 出片编排写 run.json 的 creativeAcceptance 用库函数生成：代理审片之后是 ai-reviewed，用户认可之后是 accepted
    const L = loadFilm(t.dir);
    const comment = buildReview({ film: L.film, pathBase: L.pathBase, gate: 'final', decision: 'comment', reviewer: { kind: 'ai', name: 'agent' }, summary: '代理检查通过', scores: { style: 8, avText: 8 }, reviewed: [{ path: `out/${run.runId}/web.mp4` }] });
    writeReview(t.dir, comment);
    assert.equal(creativeAcceptanceOf(t.dir, { runShas: [run.sha] }).status, 'ai-reviewed');
    record(t.dir, 'final', 'approve', { quote: '成片可以，交付吧。', reviewed: [{ path: `out/${run.runId}/web.mp4` }] });
    const ca = creativeAcceptanceOf(t.dir, { runShas: [run.sha] });
    assert.equal(ca.status, 'accepted');
    assert.deepEqual(ca.reviews.map(r => [r.reviewerKind, r.decision]), [['ai', 'comment'], ['human', 'approve']]);
    assert.equal(validateCreativeContract(ca).humanApproved, true);
    assert.deepEqual(validateCreativeContract(ca).diagnostics, []);
    assert.equal(creativeAcceptanceOf(t.dir, { runShas: ['0'.repeat(64)] }).status, 'not-reviewed');   // 别的成片：没人看过
    s = filmStatus(t.dir);
    assert.equal(s.state, 'accepted');
    assert.equal(deliveryLabel(s), '已交付 · 用户已认可');
    assert.equal(assertDelivered(t.dir).state, 'accepted');
    assert.deepEqual(findUnbackedClaims('已交付', s), []);
  } finally { t.cleanup(); }
});

test('agent 不能自己批准：AI 的 approve / waive、没有原话、占位符原话、没有出处的记录都无效', () => {
  const t = tempFilm(minimalFilm(), { 'stills/look.png': 'LOOK' });
  try {
    const L = loadFilm(t.dir);
    const base = { film: L.film, pathBase: L.pathBase, gate: 'look', decision: 'approve', ...HUMAN, reviewed: [{ path: 'stills/look.png' }] };
    const check = over => codesOf(validateReview(buildReview({ ...base, ...over }), { film: L.film }));
    assert.ok(check({ reviewer: { kind: 'ai', name: 'agent' } }).includes('review-ai-decision'));
    assert.ok(check({ decision: 'waive', reviewer: { kind: 'ai', name: 'agent' } }).includes('review-ai-decision'));
    assert.ok(check({ quote: undefined }).includes('review-quote-missing'));
    for (const q of ['用户原话', '{{QUOTE}}', '（用户认可）', 'TODO', '代理检查通过', '…']) assert.ok(check({ quote: q }).includes('review-quote-placeholder'), q);
    assert.ok(check({ source: undefined }).includes('review-source-missing'));
    assert.ok(check({ source: { kind: 'session', ref: '待补', at: '2026-11-10T10:00:00+08:00' } }).includes('review-source-ref'));
    assert.ok(check({ source: { kind: 'session', ref: '会话', at: '昨天' } }).includes('review-source-at'));
    assert.ok(check({ reviewed: [] }).includes('review-files-missing'));
    // AI 的代理审片只能写 comment，永远推不动状态
    const comment = buildReview({ ...base, decision: 'comment', reviewer: { kind: 'ai', name: 'agent' }, quote: undefined, source: undefined, summary: '代理检查通过：切点 ±1 帧无跳帧', scores: { style: 8, camera: 7 } });
    assert.deepEqual(codesOf(validateReview(comment, { film: L.film })), []);
    writeReview(t.dir, comment);
    // 手工塞进去的 AI 批准记录：读得到，但无效，不算数
    mkdirSync(join(t.dir, 'review'), { recursive: true });
    writeFileSync(join(t.dir, 'review', 'look-2026-11-09.json'), JSON.stringify(buildReview({ ...base, reviewer: { kind: 'ai', name: 'agent' } })));
    const s = filmStatus(t.dir);
    assert.equal(s.state, 'draft');
    assert.equal(s.gates.look.status, 'missing');
    assert.equal(s.gates.look.comments, 1);
    assert.deepEqual(s.gates.look.invalid, ['look-2026-11-09.json']);
  } finally { t.cleanup(); }
});

test('豁免：用户原话可以跳过 look / animatic，final 不能豁免', () => {
  const t = tempFilm(minimalFilm());
  try {
    record(t.dir, 'look', 'waive', { quote: '不用看风格帧了，直接按北冥原版来。' });
    assert.equal(filmStatus(t.dir).state, 'look-approved');
    record(t.dir, 'animatic', 'waive', { quote: '预演也跳过，直接出成片。' });
    const s = filmStatus(t.dir);
    assert.equal(s.gates.animatic.status, 'waived');
    assert.equal(s.canFinal, true);
    const L = loadFilm(t.dir);
    const fin = buildReview({ film: L.film, pathBase: L.pathBase, gate: 'final', decision: 'waive', ...HUMAN });
    assert.ok(codesOf(validateReview(fin, { film: L.film })).includes('review-final-waive'));
  } finally { t.cleanup(); }
});

test('认可之后改了切点：animatic 认可自动失效（stale），终渲被拒并说出差异；只改事件只提示', () => {
  const t = tempFilm(minimalFilm(), { 'p.mp4': 'P' });
  try {
    record(t.dir, 'look', 'approve', { reviewed: [{ path: 'p.mp4' }] });
    record(t.dir, 'animatic', 'approve', { reviewed: [{ path: 'p.mp4' }] });
    assert.equal(filmStatus(t.dir).canFinal, true);
    const r = runFilm(['retime', t.dir, '--shot', 'S1', '--out', '60', '--write', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const s = filmStatus(t.dir);
    assert.equal(s.gates.animatic.status, 'stale');
    assert.match(s.gates.animatic.reason, /S1 \[0, 48\) → \[0, 60\)/);
    assert.equal(s.state, 'look-approved');
    assert.throws(() => assertFinalAllowed(t.dir), e => /animatic（stale/.test(e.message));
    const g = runFilm(['gate', t.dir, 'final', '--json']);
    assert.equal(g.status, 4);
    assert.equal(g.json.ok, false);
    assert.equal(g.json.error.code, 'contract.gate-closed');
    // 再给用户看一次并认可，就恢复
    record(t.dir, 'animatic', 'approve', { quote: '新节奏也可以。', reviewed: [{ path: 'p.mp4' }] });
    assert.equal(filmStatus(t.dir).canFinal, true);
    // 只挪事件、不动切点：认可仍有效，但提示告诉用户
    const f = JSON.parse(readFileSync(t.file, 'utf8'));
    f.events[0].frame = 70;
    writeFileSync(t.file, JSON.stringify(f, null, 2));
    const s2 = filmStatus(t.dir);
    assert.equal(s2.gates.animatic.status, 'approved');
    assert.equal(s2.gates.animatic.eventsChanged, true);
  } finally { t.cleanup(); }
});

test('look 认可冻结风格版本：风格升版后认可失效', () => {
  const film = minimalFilm({ route: 'a', backend: 'three', style: { id: 'beiming-original', version: 1 } });
  const t = tempFilm(film, { 'f.png': 'F' });
  try {
    record(t.dir, 'look', 'approve', { reviewed: [{ path: 'f.png' }] });
    assert.equal(filmStatus(t.dir).gates.look.status, 'approved');
    const f = JSON.parse(readFileSync(t.file, 'utf8'));
    f.style.version = 2;
    writeFileSync(t.file, JSON.stringify(f, null, 2));
    const s = filmStatus(t.dir);
    assert.equal(s.gates.look.status, 'stale');
    assert.equal(s.state, 'draft');
  } finally { t.cleanup(); }
});

test('绕过闸门的终渲不计入状态；用户认可的不是这一版成片也不算 accepted', () => {
  const t = tempFilm(minimalFilm(), { 'p.mp4': 'P' });
  try {
    writeRun(t.dir, { status: 'passed', qa: { ok: true } });
    let s = filmStatus(t.dir);
    assert.equal(s.state, 'draft');
    assert.ok(s.diagnostics.some(d => d.code === 'render-bypassed-gate'));
    record(t.dir, 'look', 'approve', { reviewed: [{ path: 'p.mp4' }] });
    record(t.dir, 'animatic', 'approve', { reviewed: [{ path: 'p.mp4' }] });
    assert.equal(filmStatus(t.dir).state, 'qa-passed');
    record(t.dir, 'final', 'approve', { reviewed: [{ path: 'p.mp4' }] });   // 看的是预演，不是成片
    s = filmStatus(t.dir);
    assert.equal(s.state, 'qa-passed');
    assert.equal(s.gates.final.status, 'stale');
    // QA 报告查的不是这次的成片：不算 qa-passed
    writeRun(t.dir, { status: 'rendered', qa: { ok: true, sha: 'f'.repeat(64) } });
    s = filmStatus(t.dir);
    assert.equal(s.state, 'rendered');
    assert.ok(s.diagnostics.some(d => d.code === 'qa-input-stale'));
  } finally { t.cleanup(); }
});

test('运行记录按严格口径校验：passed 要指向 ok = true 的 QA 报告，accepted 要有人工认可', () => {
  const t = tempFilm(minimalFilm());
  try {
    const { runDir } = writeRun(t.dir, { status: 'passed', qa: { ok: true } });
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    const L = loadFilm(t.dir);
    assert.deepEqual(codesOf(validateRunRecord(run, { film: L.film, runDir })), []);
    const cmdOnly = structuredClone(run); cmdOnly.technicalAcceptance.evidence = ['ffprobe -count_frames web.mp4'];
    assert.ok(codesOf(validateRunRecord(cmdOnly, { film: L.film, runDir })).includes('technical-evidence-not-qa'));
    const failed = structuredClone(run); failed.technicalAcceptance.evidence = ['qa/missing.json'];
    assert.ok(codesOf(validateRunRecord(failed, { film: L.film, runDir })).includes('technical-evidence-unparseable'));
    const selfAccepted = structuredClone(run);
    Object.assign(selfAccepted, { status: 'accepted', creativeAcceptance: { status: 'accepted', reviews: [{ reviewerKind: 'ai', reviewer: 'agent', decision: 'comment', summary: '很好' }] } });
    assert.ok(codesOf(validateRunRecord(selfAccepted, { film: L.film, runDir })).includes('creative-accepted-without-human'));
    const legacy = structuredClone(run);
    Object.assign(legacy, { status: 'accepted', creativeAcceptance: { status: 'accepted', events: ['x'], styleComparison: ['y'] } });
    assert.ok(codesOf(validateRunRecord(legacy, { film: L.film, runDir })).includes('creative-accepted-without-human'));
    const human = structuredClone(run);
    Object.assign(human, { status: 'accepted', creativeAcceptance: { status: 'accepted', reviews: [{ reviewerKind: 'human', reviewer: '用户', decision: 'approve', quote: '可以。', source: { kind: 'session', ref: '会话第 9 条', at: '2026-11-10T12:00:00+08:00' } }] } });
    assert.deepEqual(codesOf(validateRunRecord(human, { film: L.film, runDir })), []);
    const wrongFrames = structuredClone(run); wrongFrames.output.frames = 95;
    assert.ok(codesOf(validateRunRecord(wrongFrames, { film: L.film, runDir })).includes('run-output-mismatch'));
  } finally { t.cleanup(); }
});

test('记录只增不改：同一天同一道闸第二条记录写成 -2，原文件不被覆盖', () => {
  const t = tempFilm(minimalFilm());
  try {
    const a = record(t.dir, 'look', 'waive', { quote: '跳过风格帧。' });
    const before = readFileSync(a.path, 'utf8');
    const b = record(t.dir, 'look', 'reject', { quote: '改主意了，还是要看风格帧。', rejectedOn: ['style'], mustChange: '先出三张风格帧' });
    assert.notEqual(a.path, b.path);
    assert.match(b.path, /look-\d{4}-\d{2}-\d{2}-2\.json$/);
    assert.equal(readFileSync(a.path, 'utf8'), before);
    // 最后一条有效的人工结论说了算：reject 之后 look 不通过
    const s = filmStatus(t.dir);
    assert.equal(s.gates.look.status, 'rejected');
    assert.equal(s.state, 'draft');
    assert.equal(readdirSync(join(t.dir, 'review')).filter(n => !n.startsWith('.')).length, 2);
    const recs = readReviews(t.dir, { film: loadFilm(t.dir).film });
    assert.equal(gateVerdict(recs.records, 'look', loadFilm(t.dir).film).status, 'rejected');
  } finally { t.cleanup(); }
});

test('命令行：review 原样记录用户原话与所看文件的 sha256；不合格的记录不写文件；--dry-run 不写', () => {
  const t = tempFilm(minimalFilm(), { 'stills/a.png': 'STILL-A' });
  try {
    const bad = runFilm(['review', t.dir, '--gate', 'look', '--decision', 'approve', '--reviewer-kind', 'ai', '--quote', '可以', '--source-ref', '会话第 2 条', '--file', join(t.dir, 'stills', 'a.png'), '--json']);
    assert.equal(bad.status, 4);
    assert.equal(bad.json.error.code, 'contract.review-ai-decision');
    assert.equal(existsSync(join(t.dir, 'review')), false);
    const dry = runFilm(['review', t.dir, '--gate', 'look', '--decision', 'approve', '--quote', '就这个方向。', '--source-ref', '会话第 2 条', '--file', join(t.dir, 'stills', 'a.png'), '--dry-run', '--json']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(existsSync(join(t.dir, 'review')), false);
    const ok = runFilm(['review', t.dir, '--gate', 'look', '--decision', 'approve', '--quote', '就这个方向。', '--source-ref', '会话第 2 条', '--file', join(t.dir, 'stills', 'a.png'), '--shot', 'S1=pass', '--shot', 'S2=note:天空再亮一点', '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.json.outputs.length, 1);
    const rec = JSON.parse(readFileSync(join(t.dir, ...ok.json.outputs[0].path.split('/').slice(-2)), 'utf8'));
    assert.equal(rec.quote, '就这个方向。');
    assert.equal(rec.reviewer.kind, 'human');
    assert.equal(rec.recordedBy.kind, 'ai');
    assert.deepEqual(rec.reviewed, [{ path: 'stills/a.png', sha256: sha('STILL-A') }]);
    assert.deepEqual(rec.shots, [{ id: 'S1', verdict: 'pass' }, { id: 'S2', verdict: 'note', note: '天空再亮一点' }]);
    assert.equal(ok.json.data.status.state, 'look-approved');
    const usage = runFilm(['review', t.dir, '--gate', 'storyboard', '--decision', 'approve']);
    assert.equal(usage.status, 2);
  } finally { t.cleanup(); }
});

test('给出片编排（P06）的库路径：没有 animatic 认可时终渲被拒（exit 4）；recordReview 记下原话与文件 sha256 后放行', async () => {
  const { recordReview } = await import('../../engine/production/state.js');
  const t = tempFilm(minimalFilm(), { 'stills/look.png': 'LOOK-PNG' });
  try {
    assert.throws(() => assertFinalAllowed(t.dir), e => e instanceof GateError && e.exitCode === 4);
    const look = recordReview(t.dir, { gate: 'look', decision: 'approve', ...HUMAN, reviewed: [{ path: 'stills/look.png' }] });
    assert.equal(look.status.state, 'look-approved');
    const rec = JSON.parse(readFileSync(look.path, 'utf8'));
    assert.equal(rec.quote, HUMAN.quote);
    assert.equal(rec.reviewed[0].sha256, sha('LOOK-PNG'));
    assert.throws(() => recordReview(t.dir, { gate: 'animatic', decision: 'waive', ...HUMAN, reviewer: { kind: 'ai', name: 'agent' } }), e => e.code === 'review-ai-decision' && e.exitCode === 4);
    assert.throws(() => recordReview(t.dir, { gate: 'animatic', decision: 'waive', ...HUMAN, quote: '用户原话' }), e => e.code === 'review-quote-placeholder');
    const dry = recordReview(t.dir, { gate: 'animatic', decision: 'waive', ...HUMAN, quote: '预演不用看了，直接出。' }, { dryRun: true });
    assert.equal(dry.path, null);
    assert.throws(() => assertFinalAllowed(t.dir), e => e.exitCode === 4);
    recordReview(t.dir, { gate: 'animatic', decision: 'waive', ...HUMAN, quote: '预演不用看了，直接出。' });
    assert.equal(assertFinalAllowed(t.dir).canFinal, true);
  } finally { t.cleanup(); }
});

test('交付字样检查：引号里提到词本身、否定说法放行；直接声称的才算', () => {
  assert.deepEqual(findUnbackedClaims('只有 accepted 才能写「已交付」。', 'draft'), []);
  assert.deepEqual(findUnbackedClaims('本片未交付', 'draft'), []);
  for (const t of ['这条不是用户认可', '未经用户认可', '没有用户认可的记录', '不算已验收', '不能写已交付']) assert.deepEqual(findUnbackedClaims(t, 'draft'), [], t);
  assert.deepEqual(findUnbackedClaims('用户认可了', 'draft').map(x => x.claim), ['用户认可']);
  assert.deepEqual(findUnbackedClaims('本片已交付', 'qa-passed').map(x => x.claim), ['已交付']);
  assert.deepEqual(findUnbackedClaims('本片已交付', 'accepted'), []);
});

test('review/waivers.json：命令行之外录入的豁免也算数，按 decision = waive 校验；记录时间不能早于用户说话的时间', () => {
  const t = tempFilm(minimalFilm());
  try {
    mkdirSync(join(t.dir, 'review'), { recursive: true });
    const w = (over = {}) => ({ gate: 'animatic', quote: '预演不用给我看了，直接出全片。', source: { kind: 'session', ref: '会话第 3 条', at: '2026-11-10T10:00:00+08:00' }, reviewer: { kind: 'human', name: '用户' }, recordedBy: { kind: 'ai', name: 'agent' }, at: '2026-11-10T10:01:00+08:00', ...over });
    writeFileSync(join(t.dir, 'review', 'waivers.json'), JSON.stringify({ schemaVersion: 1, waivers: [w(), w({ gate: 'final', at: '2026-11-10T10:02:00+08:00' })] }));
    record(t.dir, 'look', 'waive', { quote: '风格帧不用看了。' });
    const s = filmStatus(t.dir);
    assert.equal(s.gates.animatic.status, 'waived');
    assert.equal(s.gates.animatic.record.file, 'waivers.json#1');
    assert.equal(s.canFinal, true);
    // final 不能豁免：waivers.json 里的那条无效，并报出位置
    assert.ok(s.diagnostics.some(d => d.code === 'review-final-waive' && d.path.startsWith('review/waivers.json#2')));
    // 记录时间早于用户说话的时间：无效
    const early = buildReview({ film: loadFilm(t.dir).film, pathBase: t.dir, gate: 'look', decision: 'waive', ...HUMAN, source: { ...HUMAN.source, at: '2099-01-01T00:00:00+08:00' } });
    assert.ok(codesOf(validateReview(early, { film: loadFilm(t.dir).film })).includes('review-at-before-quote'));
    // 写成别的决定、不是数组：判错
    writeFileSync(join(t.dir, 'review', 'waivers.json'), JSON.stringify({ waivers: [w({ decision: 'approve' })] }));
    assert.ok(filmStatus(t.dir).diagnostics.some(d => d.code === 'review-waivers-decision'));
    writeFileSync(join(t.dir, 'review', 'waivers.json'), JSON.stringify({ waivers: 'animatic' }));
    assert.ok(filmStatus(t.dir).diagnostics.some(d => d.code === 'review-waivers-invalid'));
  } finally { t.cleanup(); }
});

test('记录字段与验收题库 H6 对齐：gate、decision、quote、source、at；旧记录的 recordedAt 仍能读，提示改名', () => {
  const t = tempFilm(minimalFilm(), { 'stills/a.png': 'A' });
  try {
    const r = record(t.dir, 'look', 'approve', { reviewed: [{ path: 'stills/a.png' }] });
    const rec = JSON.parse(readFileSync(r.path, 'utf8'));
    for (const k of ['gate', 'decision', 'quote', 'source', 'at']) assert.ok(rec[k] !== undefined, k);
    assert.equal(rec.recordedAt, undefined);
    const legacy = { ...rec, recordedAt: rec.at }; delete legacy.at;
    const v = validateReview(legacy, { film: loadFilm(t.dir).film });
    assert.equal(v.ok, true);
    assert.ok(v.diagnostics.some(d => d.code === 'review-legacy-field'));
    assert.ok(codesOf(validateReview({ ...rec, recordedAt: rec.at }, { film: loadFilm(t.dir).film })).includes('review-at'));
  } finally { t.cleanup(); }
});

test('技术证据写成仓库相对路径（tools/qa 的写法）也认；报告结构按机器 QA 的 validateReport 判', () => {
  const t = tempFilm(minimalFilm());
  try {
    const { runDir } = writeRun(t.dir, { status: 'passed', qa: { ok: true }, evidence: 'repo', root: t.root });
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    assert.match(run.technicalAcceptance.evidence[0], /^tfilm\/out\/20261110-120000-abc1234\/qa\/report\.json$/);
    const L = loadFilm(t.dir);
    assert.deepEqual(codesOf(validateRunRecord(run, { film: L.film, runDir, repoRoot: t.root })), []);
    // 手写的报告缺了机器 QA 要求的字段：结构不合格
    const report = JSON.parse(readFileSync(join(runDir, 'qa', 'report.json'), 'utf8'));
    delete report.checks[0].expected;
    writeFileSync(join(runDir, 'qa', 'report.json'), JSON.stringify(report));
    const s = filmStatus(t.dir);
    assert.ok(s.diagnostics.some(d => d.code === 'qa-report-invalid' && /expected/.test(d.path)));
  } finally { t.cleanup(); }
});
