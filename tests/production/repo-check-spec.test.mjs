// tools/repo-check/rules/spec：spec 域的仓库规范检查（作品描述、审片记录、交付字样、阐述四节、镜像、资产锁、档位）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as film from '../../engine/production/film.js';
import * as state from '../../engine/production/state.js';
import * as review from '../../engine/production/review.js';
import * as assets from '../../engine/assets/manifest.js';
import { domain, rules, runRules } from '../../tools/repo-check/rules/spec/index.mjs';
import { HUMAN, REPO, minimalFilm } from './helpers.mjs';

const L = { film, state, review, assets };
const CLI = join(REPO, 'tools', 'repo-check', 'rules', 'spec', 'index.mjs');

/** 临时仓库根：films/<id>/ 下放 film.json、index.html 与 extra 文件。 */
function tempRepo(films) {
  const root = mkdtempSync(join(tmpdir(), 'beiming-spec-'));
  for (const [id, { json, extra = {} }] of Object.entries(films)) {
    const dir = join(root, 'films', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'film.json'), typeof json === 'string' ? json : JSON.stringify(json, null, 2));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    for (const [rel, text] of Object.entries(extra)) {
      mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...rel.split('/')), typeof text === 'string' ? text : JSON.stringify(text));
    }
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const byRule = r => Object.fromEntries(r.results.map(x => [x.id, x.diagnostics]));
const errCodes = list => list.filter(x => x.level === 'error').map(x => x.code);

test('插件形状：domain、rules[{ id, title, check }]、runRules；仓库现状没有错误', async () => {
  assert.equal(domain, 'spec');
  for (const r of rules) { assert.match(r.id, /^spec\.[a-z-]+$/); assert.equal(typeof r.check, 'function'); assert.ok(r.title); }
  const r = await runRules({ root: REPO });
  assert.equal(r.ok, true, JSON.stringify(r.results.flatMap(x => x.diagnostics.filter(y => y.level === 'error')), null, 1));
});

test('查出：不合格的 film.json、agent 自批的记录、没有依据的「已交付」、阐述缺小节', async () => {
  const good = minimalFilm();
  const selfApproved = review.buildReview({ film: film.validateFilm(minimalFilm({ id: 'self' }), { checkFiles: false }).film, pathBase: '.', gate: 'look', decision: 'approve', ...HUMAN, reviewer: { kind: 'ai', name: 'agent' }, reviewed: [{ path: 'x.png', sha256: 'a'.repeat(64) }] });
  const t = tempRepo({
    tfilm: { json: good, extra: { 'README.md': '# 测试片\n\n本片已交付，用户已认可。\n\n技术检查通过，未交付。\n', 'TREATMENT.md': '# 测试片\n\n## 10. 镜头表\n\n## 11. 节拍表\n' } },
    self: { json: minimalFilm({ id: 'self' }), extra: { 'review/look-2026-11-09.json': selfApproved } },
    broken: { json: minimalFilm({ id: 'broken', shots: [{ id: 'S1', in: 0, out: 40 }, { id: 'S2', in: 48, out: 96 }] }) },
  });
  try {
    const r = await runRules({ root: t.root, L }, { only: ['spec.films', 'spec.reviews', 'spec.claims', 'spec.treatment'] });
    assert.equal(r.ok, false);
    const m = byRule(r);
    assert.ok(errCodes(m['spec.films']).includes('shots-not-contiguous'));
    assert.ok(m['spec.films'].some(x => x.path.startsWith('films/broken/film.json')));
    assert.ok(errCodes(m['spec.reviews']).includes('review-ai-decision'));
    const claims = m['spec.claims'].filter(x => x.code === 'unbacked-claim');
    assert.deepEqual(claims.map(x => x.path), ['films/tfilm/README.md:3', 'films/tfilm/README.md:3']);
    assert.ok(errCodes(m['spec.treatment']).includes('treatment-sections'));
    assert.match(m['spec.treatment'].find(x => x.code === 'treatment-sections').message, /cue map、声音设计/);
    assert.ok(m['spec.treatment'].some(x => x.code === 'treatment-missing' && x.level === 'warning'));
  } finally { t.cleanup(); }
});

test('命令行：一致 exit 0，--json 信封；参数错 exit 2；--help 不跑检查', () => {
  const run = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000 });
  const ok = run(['--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const env = JSON.parse(ok.stdout);
  assert.deepEqual(Object.keys(env).slice(0, 7), ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings']);
  assert.equal(env.result.results.length, rules.length);
  assert.equal(run(['--only', 'spec.nope']).status, 2);
  assert.equal(run(['--bogus']).status, 2);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /spec\.claims/);
});
