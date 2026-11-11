// 作品描述库不依赖机器 QA（tools/qa）也能用。新建作品的联调沙盒（tests/cli/new-film.test.mjs）只复制 engine/、tools/lib、routes/，
// 评测的判定工具（tools/eval 的 --tools-root）也可能指向只装了引擎的检出。在这样的检出里：
//   - check / expect 照常（只依赖作品描述本身与 tools/lib）；status / gate / review 照常；
//   - 凡要认 QA 报告的地方一律不放行：validate-result 退出 3（env.qa-validator-missing），状态停在 rendered，不会误判 qa-passed；
//   - 同一部作品放在完整检出里，状态是 qa-passed（对照组），证明差别只来自少了校验器。
//   node --test tests/production/standalone.test.mjs
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadFilm } from '../../engine/production/film.js';
import { buildReview, writeReview } from '../../engine/production/review.js';
import { QA_VALIDATOR, filmStatus } from '../../engine/production/state.js';
import { buildReport, technicalAcceptanceFrom } from '../../tools/qa/lib/report.mjs';
import { HUMAN, REPO, minimalFilm } from './helpers.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const RUN_ID = '20261110-120000-abc1234';
const VIDEO = 'FAKE-MP4-BYTES';
let SBX = null;

/** 只有引擎的检出：engine/、tools/lib、routes/、package.json，共享素材 assets/ 用目录链接；没有 tools/qa。 */
before(() => {
  SBX = mkdtempSync(join(tmpdir(), 'beiming-p05-noqa-'));
  for (const d of ['engine', 'routes', join('tools', 'lib')]) cpSync(join(REPO, d), join(SBX, d), { recursive: true, filter: s => !/[\\/](node_modules|__pycache__|out)$/.test(s) });
  writeFileSync(join(SBX, 'package.json'), readFileSync(join(REPO, 'package.json')));
  symlinkSync(join(REPO, 'assets'), join(SBX, 'assets'), 'junction');
});
after(() => { if (SBX) rmSync(SBX, { recursive: true, force: true }); });

/** 在沙盒里跑 film.js（沙盒自己的那一份，不是本检出的）。 */
function sbxFilm(args) {
  const r = spawnSync(process.execPath, [join('engine', 'production', 'film.js'), ...args], { cwd: SBX, encoding: 'utf8', timeout: 60_000 });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { json = undefined; } }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/**
 * 在 root/films/<id>/ 写一部「look 与 animatic 已认可、终渲已出、机器 QA 通过」的作品：
 * 审片记录用本检出的库写（与 film.js review 同一函数），QA 报告用 tools/qa 的 buildReport 写（与 node tools/qa/cli.mjs report 同一形状）。
 */
function qaPassedFilm(root, id) {
  const film = minimalFilm({ id });
  const dir = join(root, 'films', id);
  mkdirSync(join(dir, 'stills'), { recursive: true });
  mkdirSync(join(dir, 'preview'), { recursive: true });
  writeFileSync(join(dir, 'film.json'), `${JSON.stringify(film, null, 2)}\n`);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>t</title>\n');
  writeFileSync(join(dir, 'stills', 'look.png'), 'LOOK-FRAME');
  writeFileSync(join(dir, 'preview', 'animatic.mp4'), 'ANIMATIC');
  const L = loadFilm(dir);
  assert.equal(L.ok, true, JSON.stringify(L.diagnostics));
  writeReview(dir, buildReview({ film: L.film, pathBase: L.pathBase, gate: 'look', decision: 'approve', ...HUMAN, reviewed: [{ path: 'stills/look.png' }] }));
  writeReview(dir, buildReview({ film: L.film, pathBase: L.pathBase, gate: 'animatic', decision: 'approve', ...HUMAN, quote: '节奏对了，可以终渲。', reviewed: [{ path: 'preview/animatic.mp4' }] }));
  const runDir = join(dir, 'out', RUN_ID);
  mkdirSync(join(runDir, 'qa'), { recursive: true });
  writeFileSync(join(runDir, 'web.mp4'), VIDEO);
  const report = buildReport({
    film: { id, title: film.title, route: film.route, frameCount: film.output.frameCount },
    input: { path: 'web.mp4', sha256: sha(VIDEO) },
    profile: { id: 'web-1080p24', source: 'engine/production/profiles.json' },
    checks: [{ id: 'delivery.size', group: 'delivery', title: '尺寸', severity: 'hard', status: 'pass', value: '1920×1080', expected: '1920×1080', evidence: {} }],
  });
  const run = {
    schemaVersion: 1, kind: 'final', status: 'passed', projectId: id, shotId: 'film', route: film.route, backend: film.backend,
    sourceCommit: 'abc1234', actualDevice: 'Apple M5 Pro', actualGraphicsBackend: 'ANGLE-metal', actualEncoder: 'libx264',
    output: { path: 'web.mp4', sha256: sha(VIDEO), width: 1920, height: 1080, fps: 24, frames: film.output.frameCount, pixFmt: 'yuv420p' },
    technicalAcceptance: technicalAcceptanceFrom(report, 'qa/report.json'),
    creativeAcceptance: { status: 'not-reviewed', reviews: [] },
  };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  writeFileSync(join(runDir, 'qa', 'report.json'), JSON.stringify(report, null, 1));
  writeFileSync(join(dir, 'out', 'latest'), `${RUN_ID}\n`);
  return { dir, rel: `films/${id}`, runJson: `films/${id}/out/${RUN_ID}/run.json` };
}

test('沙盒真的没有 tools/qa；本检出有（前提）', () => {
  assert.equal(existsSync(join(SBX, 'tools', 'qa')), false);
  assert.deepEqual(readdirSync(join(SBX, 'tools')), ['lib']);
  assert.equal(QA_VALIDATOR.available, true, '本检出应带机器 QA 的报告校验器');
});

test('没有 tools/qa：check 照常（模版与作品），expect 照常', () => {
  for (const tpl of ['routes/a-webgl/template', 'routes/b-native/template', 'routes/c-style/template']) {
    const r = sbxFilm(['check', tpl, '--template', '--json']);
    assert.equal(r.status, 0, `${tpl}：${r.stdout}${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.ok(Array.isArray(r.json.data.diagnostics));
  }
  const f = qaPassedFilm(SBX, 'noqa-check');
  const c = sbxFilm(['check', f.rel, '--json']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(c.json.data.summary.frameCount, 96);
  const e = sbxFilm(['expect', f.rel, '--json']);
  assert.equal(e.status, 0, e.stdout + e.stderr);
  assert.deepEqual(e.json.data.cuts.map(x => x.frame), [48]);
});

test('没有 tools/qa：QA 报告一律不放行——状态停在 rendered（完整检出里同一部作品是 qa-passed），validate-result 退出 3', () => {
  // 对照组：完整检出（本测试进程加载的库带校验器）
  const full = mkdtempSync(join(tmpdir(), 'beiming-p05-full-'));
  try {
    const ref = qaPassedFilm(full, 'with-qa');
    assert.equal(filmStatus(ref.dir).state, 'qa-passed');
  } finally { rmSync(full, { recursive: true, force: true }); }

  const f = qaPassedFilm(SBX, 'noqa-state');
  const s = sbxFilm(['status', f.rel, '--json']);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.equal(s.json.data.state, 'rendered', '少了校验器不能算 QA 通过');
  const miss = s.json.data.diagnostics.find(d => d.code === 'qa-validator-missing');
  assert.ok(miss, JSON.stringify(s.json.data.diagnostics));
  assert.equal(miss.level, 'error');
  assert.match(miss.message, /tools\/qa\/lib\/report\.mjs/);
  assert.match(s.json.data.nextRequired, /机器 QA/);

  const v = sbxFilm(['validate-result', f.runJson, '--json']);
  assert.equal(v.status, 3, v.stdout + v.stderr);
  assert.equal(v.json.ok, false);
  assert.equal(v.json.error.code, 'env.qa-validator-missing');
  assert.match(v.json.error.hint, /完整的仓库检出/);
  assert.equal(v.json.runJson, f.runJson);

  // 闸门照常：能不能终渲只看审片记录；能不能写「已交付」卡在 QA 这一步，提示指向它
  assert.equal(sbxFilm(['gate', f.rel, 'final']).status, 0);
  const d = sbxFilm(['gate', f.rel, 'deliver', '--json']);
  assert.equal(d.status, 4);
  assert.equal(d.json.error.code, 'contract.gate-closed');
  assert.match(d.json.error.hint, /^机器 QA/);
});

test('没有 tools/qa：review 照常记录（审片记录不依赖机器 QA）', () => {
  const f = qaPassedFilm(SBX, 'noqa-review');
  const r = sbxFilm(['review', f.rel, '--gate', 'structure', '--decision', 'approve', '--file', `${f.rel}/index.html`,
    '--quote', '就按第二个结构来。', '--source-ref', '测试会话第 2 条消息', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.json.data.file, /^films\/noqa-review\/review\/structure-\d{4}-\d{2}-\d{2}\.json$/);
  const s = sbxFilm(['status', f.rel, '--json']);
  assert.equal(s.json.data.gates.structure.status, 'approved');
  assert.ok(!s.json.data.next.some(n => n.startsWith('（建议）')), '结构确认记过之后不再建议');
});
