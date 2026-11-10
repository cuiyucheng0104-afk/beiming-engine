// tools/repo-check/rules/spec/：spec 域的仓库规范检查（作品描述、审片记录、交付字样、阐述四节、镜像、资产锁、档位）。
// 规则按治理骨架的加载器约定写（tools/repo-check/core/loader.mjs：一个文件一条规则，默认导出 { id, title, run(ctx) }）。
//   node --test tests/production/repo-check-spec.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as film from '../../engine/production/film.js';
import * as review from '../../engine/production/review.js';
import { loadRules } from '../../tools/repo-check/core/loader.mjs';
import { createContext } from '../../tools/repo-check/core/context.mjs';
import { HUMAN, REPO, minimalFilm } from './helpers.mjs';

const RULES_DIR = join(REPO, 'tools', 'repo-check', 'rules');
const SPEC_IDS = ['spec.assets-lock', 'spec.claims', 'spec.films', 'spec.mirror', 'spec.profiles', 'spec.reviews', 'spec.templates', 'spec.treatment'];

async function specRules() {
  const { rules, problems } = await loadRules(RULES_DIR);
  return { rules: rules.filter(r => r.domain === 'spec'), problems: problems.filter(p => p.file.includes('/rules/spec/')) };
}

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

const codeOf = f => /^\[([a-z0-9-]+)\]/.exec(f.message)?.[1] ?? null;
const errCodes = list => list.filter(x => x.level === 'error').map(codeOf);

test('加载器约定：spec 的 8 条规则各一个文件，默认导出 { id, title, run }，没有加载问题', async () => {
  const { rules, problems } = await specRules();
  assert.deepEqual(problems, []);
  assert.deepEqual(rules.map(r => r.id).sort(), SPEC_IDS);
  for (const r of rules) { assert.ok(r.title); assert.equal(typeof r.run, 'function'); }
});

test('仓库现状：spec 域没有错误（node tools/repo-check.mjs --only spec --json）', () => {
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'repo-check.mjs'), '--only', 'spec', '--json'], { cwd: REPO, encoding: 'utf8', timeout: 240_000 });
  const env = JSON.parse(r.stdout);
  assert.equal(env.schemaVersion, 1);
  const mine = env.data.findings.filter(f => f.rule.startsWith('spec.'));
  assert.deepEqual(mine.filter(f => f.level === 'error'), [], JSON.stringify(mine.filter(f => f.level === 'error'), null, 1));
  assert.deepEqual(env.data.rules.filter(x => x.id.startsWith('spec.')).map(x => x.id).sort(), SPEC_IDS);
});

test('查出：不合格的 film.json、agent 自批的记录、没有依据的「已交付」、阐述缺小节', async () => {
  const { rules } = await specRules();
  const rule = id => rules.find(r => r.id === id);
  const good = minimalFilm();
  const selfApproved = review.buildReview({ film: film.validateFilm(minimalFilm({ id: 'self' }), { checkFiles: false }).film, pathBase: '.', gate: 'look', decision: 'approve', ...HUMAN, reviewer: { kind: 'ai', name: 'agent' }, reviewed: [{ path: 'x.png', sha256: 'a'.repeat(64) }] });
  const t = tempRepo({
    tfilm: { json: good, extra: { 'README.md': '# 测试片\n\n本片已交付，用户已认可。\n\n技术检查通过，未交付；「已交付」只能由 accepted 生成。\n', 'TREATMENT.md': '# 测试片\n\n## 10. 镜头表\n\n## 11. 节拍表\n' } },
    self: { json: minimalFilm({ id: 'self' }), extra: { 'review/look-2026-11-09.json': selfApproved } },
    broken: { json: minimalFilm({ id: 'broken', shots: [{ id: 'S1', in: 0, out: 40 }, { id: 'S2', in: 48, out: 96 }] }) },
  });
  try {
    const ctx = createContext({ root: t.root });
    const films = await rule('spec.films').run(ctx);
    assert.ok(errCodes(films).includes('shots-not-contiguous'), JSON.stringify(films));
    assert.ok(films.some(x => x.file === 'films/broken/film.json' && x.level === 'error'));
    assert.ok(films.every(x => x.file !== 'films/tfilm/film.json' || x.level !== 'error'));
    const reviews = await rule('spec.reviews').run(ctx);
    assert.ok(errCodes(reviews).includes('review-ai-decision'));
    assert.ok(reviews.some(x => x.file === 'films/self/review/look-2026-11-09.json'));
    const claims = (await rule('spec.claims').run(ctx)).filter(x => codeOf(x) === 'unbacked-claim');
    assert.deepEqual(claims.map(x => [x.file, x.line, x.excerpt]), [['films/tfilm/README.md', 3, '已交付'], ['films/tfilm/README.md', 3, '用户已认可']]);
    const tr = await rule('spec.treatment').run(ctx);
    const sections = tr.find(x => codeOf(x) === 'treatment-sections');
    assert.equal(sections.level, 'error');
    assert.match(sections.message, /cue map、声音设计/);
    assert.ok(tr.some(x => codeOf(x) === 'treatment-missing' && x.level === 'warn'));
  } finally { t.cleanup(); }
});

test('--staged：只看暂存区涉及的作品', async () => {
  const { rules } = await specRules();
  const t = tempRepo({
    a: { json: minimalFilm({ id: 'a', shots: [{ id: 'S1', in: 0, out: 40 }, { id: 'S2', in: 48, out: 96 }] }) },
    b: { json: minimalFilm({ id: 'b', shots: [{ id: 'S1', in: 0, out: 40 }, { id: 'S2', in: 48, out: 96 }] }) },
  });
  try {
    const ctx = createContext({ root: t.root, staged: new Set(['films/b/film.json']) });
    const out = await rules.find(r => r.id === 'spec.films').run(ctx);
    assert.deepEqual([...new Set(out.filter(x => x.level === 'error').map(x => x.file))], ['films/b/film.json']);
  } finally { t.cleanup(); }
});
