import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlan, inspectPlan, isEntryPoint } from './work-plan.mjs';

const task = (id, extra = {}) => ({ id, title: id, ownerRole: 'owner', route: 'shared', status: 'planned', dependsOn: [], inputs: ['source'], writeScope: [`engine/${id}/`], outputs: ['result'], acceptance: ['verified'], evidence: [], ...extra });
const plan = tasks => ({ schemaVersion: 1, tasks });
// Git for Windows checks text out with CRLF by default; the published documents must parse the same way.
const readDoc = rel => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const canonicalPlan = () => JSON.parse(readFileSync(new URL('../docs/routes/work-plan.json', import.meta.url), 'utf8'));

// "### Txx · 标题" followed by one "- 标签：值" line per field. Anything else inside a card is reported.
function parseCards(doc) {
  const text = doc.replace(/\r\n?/g, '\n');
  const heads = [...text.matchAll(/^### (T\d{2}) · (.+)$/gm)];
  return heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const body = text.slice(head.index + head[0].length, end).split(/\n## /)[0];
    const fields = new Map(), stray = [];
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      const m = /^- ([^：\s]+)：(.*)$/.exec(line);
      if (!m || fields.has(m[1])) stray.push(line);
      else fields.set(m[1], m[2]);
    }
    return { id: head[1], title: head[2].trim(), fields, stray };
  });
}

// Every field of a card must equal what work-plan.json says, in both directions.
function cardErrors(t, card) {
  const errors = [];
  const want = new Map([
    ['路线', `\`${t.route}\`；角色：${t.ownerRole}；状态：\`${t.status}\`。`],
    ['依赖', `${t.dependsOn.join(', ') || '无'}。`],
    ['输入', `${t.inputs.join('；')}。`],
    ['写入范围', `${t.writeScope.map(s => `\`${s}\``).join(', ')}。`],
    ['交付', `${t.outputs.join('；')}。`],
    ['验收', `${t.acceptance.join('；')}。`],
  ]);
  if (t.status === 'blocked') want.set('阻塞', `${t.blocker}。`);
  const labels = new Set([...want.keys(), '详细指引', ...(t.evidence.length ? ['证据'] : [])]);
  if (card.title !== t.title) errors.push(`${t.id}: 标题「${card.title}」≠「${t.title}」`);
  for (const line of card.stray) errors.push(`${t.id}: 卡片里有无法对应 JSON 字段的行：${line}`);
  for (const label of card.fields.keys()) if (!labels.has(label)) errors.push(`${t.id}: 多出字段「${label}」`);
  for (const label of labels) if (!card.fields.has(label)) errors.push(`${t.id}: 缺少字段「${label}」`);
  for (const [label, value] of want) {
    if (card.fields.has(label) && card.fields.get(label) !== value) errors.push(`${t.id}.${label}: 卡片「${card.fields.get(label)}」≠ JSON「${value}」`);
  }
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)。$/.exec(card.fields.get('详细指引') ?? '');
  if (!link) errors.push(`${t.id}.详细指引: 应为单个链接「[文件名](相对路径)。」`);
  else {
    const target = posix.normalize(posix.join('docs/routes', link[2]));
    if (target !== t.playbook) errors.push(`${t.id}.详细指引: 链接指向 ${target}，JSON playbook 是 ${t.playbook}`);
    if (link[1] !== posix.basename(t.playbook)) errors.push(`${t.id}.详细指引: 链接文字 ${link[1]} 应为 ${posix.basename(t.playbook)}`);
  }
  if (card.fields.has('证据')) {
    // Evidence is prose, but every recorded item must be cited as a code span, and every code span must be
    // a recorded item: a path or command verbatim (text before a full-width note), a commit as a >=7-char prefix.
    const spans = [...card.fields.get('证据').matchAll(/`([^`]+)`/g)].map(m => m[1]);
    const cites = (item, span) => item.startsWith('commit:')
      ? /^[0-9a-f]{7,}$/.test(span) && item.slice(7).startsWith(span)
      : item.split('（')[0].trim() === span;
    for (const item of t.evidence) if (!spans.some(span => cites(item, span))) errors.push(`${t.id}.证据: 卡片没有列出 ${item}`);
    for (const span of spans) if (!t.evidence.some(item => cites(item, span))) errors.push(`${t.id}.证据: 卡片列出的 ${span} 不在 JSON evidence 里`);
  }
  return errors;
}

test('only completed dependencies unlock planned tasks; route includes shared work', () => {
  const p = plan([task('C00', { status: 'done', evidence: ['commit'] }), task('A01', { route: 'beiming', dependsOn: ['C00'] }), task('R01', { route: 'raea' }), task('A02', { dependsOn: ['A01'] }), task('C02', { status: 'blocked', blocker: 'missing asset' })]);
  assert.deepEqual(inspectPlan(p, 'beiming').ready.map(t => t.id), ['A01']);
});
test('reject unknown dependencies and cycles', () => {
  assert.match(validatePlan(plan([task('A01', { dependsOn: ['Z99'] })])).join(), /unknown dependency/);
  assert.match(validatePlan(plan([task('A01', { dependsOn: ['R01'] }), task('R01', { dependsOn: ['A01'] })])).join(), /Dependency cycle/);
});
test('completion requires evidence and completed prerequisites', () => {
  const errors = validatePlan(plan([task('C01'), task('A01', { status: 'done', dependsOn: ['C01'] })]));
  assert.match(errors.join(), /done requires evidence/);
  assert.match(errors.join(), /done before dependency/);
});
test('detect overlapping write scopes without confusing similar prefixes', () => {
  const p = plan([task('A01', { writeScope: ['engine/style/**'] }), task('R01', { writeScope: ['engine/style/native.js'] }), task('C01', { writeScope: ['engine/styles/new.js'] })]);
  assert.deepEqual(inspectPlan(p).conflicts.map(c => c.tasks), [['A01', 'R01']]);
});
test('reject outside paths, missing acceptance and duplicate ids', () => {
  const errors = validatePlan(plan([task('A01', { writeScope: ['../elsewhere'] }), task('A01', { acceptance: [] })]));
  assert.match(errors.join(), /inside the repository/);
  assert.match(errors.join(), /Duplicate id/);
  assert.match(errors.join(), /acceptance cannot be empty/);
});
test('reject malformed task collections and invalid routes', () => {
  assert.ok(validatePlan({ tasks: [] }).length);
  assert.ok(validatePlan(plan([null, task('A01', { dependsOn: 3 })])).length);
  assert.throws(() => inspectPlan(plan([task('C01')]), 'unknown'), /Unknown route/);
});
test('other-route active owners still block overlapping ready writes', () => {
  const p = plan([task('A01', { route: 'beiming', writeScope: ['README.md'] }), task('R01', { route: 'raea', status: 'in-progress', writeScope: ['**'] })]);
  const result = inspectPlan(p, 'beiming');
  assert.deepEqual(result.conflicts[0].tasks, ['A01', 'R01']);
  assert.deepEqual(result.conflicts[0].statuses, ['planned', 'in-progress']);
});
test('reject noncanonical scopes that would hide a write conflict', () => {
  for (const path of ['./engine/style', 'engine//style', 'engine/*/**', 'engine/./style', '/engine', 'C:/engine']) {
    assert.match(validatePlan(plan([task('A01', { writeScope: [path] })])).join(), /inside the repository/, path);
  }
  assert.deepEqual(validatePlan(plan([task('A01', { writeScope: ['engine/style/', 'engine/style/**', '**'] })])), []);
});
test('already active tasks retain their write conflict warning', () => {
  const p = plan([task('A01', { route: 'beiming', status: 'in-progress', writeScope: ['README.md'] }), task('R01', { route: 'raea', status: 'in-progress', writeScope: ['README.md'] })]);
  assert.deepEqual(inspectPlan(p, 'beiming').conflicts[0].tasks, ['A01', 'R01']);
});
test('route filtering explains unfinished cross-route dependencies and explicit blockers', () => {
  const p = plan([task('A01', { route: 'beiming', dependsOn: ['R01'] }), task('R01', { route: 'raea' }), task('C01', { status: 'blocked', blocker: 'missing asset' })]);
  const r = inspectPlan(p, 'beiming');
  assert.deepEqual(r.ready, []);
  assert.deepEqual(r.waiting[0].dependencies, [{ id: 'R01', route: 'raea', status: 'planned', title: 'R01' }]);
  assert.equal(r.waiting[1].blocker, 'missing asset');
});
test('case and Unicode aliases still conflict on shared Mac/Windows workspaces', () => {
  for (const scopes of [['README.md', 'readme.md'], ['docs/café.md', 'docs/cafe\u0301.md']]) {
    const p = plan([task('A01', { writeScope: [scopes[0]] }), task('R01', { status: 'in-progress', writeScope: [scopes[1]] })]);
    assert.equal(inspectPlan(p).conflicts.length, 1);
  }
});
test('blocked work retains ownership and requires a usable reason', () => {
  const p = plan([task('A01', { writeScope: ['README.md'] }), task('R01', { route: 'raea', status: 'blocked', blocker: 'awaiting asset', writeScope: ['README.md'] })]);
  assert.deepEqual(inspectPlan(p, 'beiming').conflicts[0].statuses, ['planned', 'blocked']);
  for (const blocker of [' ', 1, {}]) assert.match(validatePlan(plan([task('C01', { status: 'blocked', blocker })])).join(), /nonempty blocker/);
});

test('published task cards match the canonical plan field by field', () => {
  const p = canonicalPlan();
  assert.deepEqual(validatePlan(p), []);
  const cards = parseCards(readDoc('../docs/routes/work-breakdown.md'));
  assert.deepEqual(cards.map(c => c.id), p.tasks.map(t => t.id), 'task cards must list exactly the JSON tasks, in order');
  const byId = new Map(cards.map(c => [c.id, c]));
  assert.deepEqual(p.tasks.flatMap(t => cardErrors(t, byId.get(t.id))), []);
});
test('card comparison catches drift that a substring search let through', () => {
  const t = task('T05', { title: '校准', writeScope: ['lab/x/', 'docs/y/'], evidence: ['docs/y/a.md', 'node --test tests/a.test.mjs（3 项通过）', 'commit:c16f0b7880ae128ce8ef270395d2d80a7f36f715'], playbook: 'docs/routes/beiming-style.md' });
  const good = ['### T05 · 校准', '', '- 路线：`shared`；角色：owner；状态：`planned`。', '- 依赖：无。', '- 输入：source。',
    '- 写入范围：`lab/x/`, `docs/y/`。', '- 交付：result。', '- 验收：verified。',
    '- 证据：`docs/y/a.md`；`node --test tests/a.test.mjs` 3 项通过；提交 `c16f0b7`。', '- 详细指引：[beiming-style.md](beiming-style.md)。', ''].join('\n');
  const errorsFor = doc => cardErrors(t, parseCards(doc)[0]);
  assert.deepEqual(errorsFor(good), []);
  assert.deepEqual(errorsFor(good.replace(/\n/g, '\r\n')), []);
  const drift = {
    'scope dropped (still named in the evidence line)': good.replace('`lab/x/`, ', ''),
    'scope added from another task': good.replace('`docs/y/`。', '`docs/y/`, `engine/style/`。'),
    'playbook changed': good.replace('[beiming-style.md](beiming-style.md)', '[raea-native.md](raea-native.md)'),
    'evidence missing': good.replace('；提交 `c16f0b7`', ''),
    'evidence not in JSON': good.replace('`docs/y/a.md`', '`docs/y/a.md`、`docs/y/b.md`'),
    'status drift': good.replace('`planned`', '`done`'),
    'acceptance split differently': good.replace('- 验收：verified。', '- 验收：verified；extra。'),
    'stray line': good.replace('- 交付：result。', '- 交付：result。\n另外写入 `engine/`。'),
  };
  for (const [name, doc] of Object.entries(drift)) assert.notDeepEqual(errorsFor(doc), [], name);
});
test('the table of work that can start now, when present, matches routes:next', () => {
  const doc = readDoc('../docs/routes/work-breakdown.md');
  const section = doc.split(/^## /m).find(s => /^[^\n]*(并行|可领取|可以开始)/.test(s));
  const listed = section ? [...section.matchAll(/^\|\s*(T\d{2})\s*\|/gm)].map(m => m[1]) : [];
  if (!listed.length) return;      // the page may defer to `npm run routes:next` instead of keeping a table
  assert.deepEqual([...listed].sort(), inspectPlan(canonicalPlan()).ready.map(t => t.id).sort());
});
test('CLI still validates when started through a symlink, junction or /tmp alias', t => {
  const dir = mkdtempSync(join(tmpdir(), 'work-plan-'));
  try {
    const link = join(dir, 'tools');
    try { symlinkSync(dirname(fileURLToPath(import.meta.url)), link, 'junction'); } catch (error) { t.skip(`links unavailable: ${error.code}`); return; }
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify(plan([task('T01', { status: 'done', dependsOn: ['T99'] })])));
    const run = (...args) => spawnSync(process.execPath, [join(link, 'work-plan.mjs'), ...args], { encoding: 'utf8' });
    const broken = run('--check', '--file', bad);
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    assert.match(broken.stderr, /done requires evidence/);
    assert.match(broken.stderr, /unknown dependency T99/);
    assert.equal(run('--bogus').status, 1);
    const ok = run('--check');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /计划有效/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('entry-point detection compares real paths', () => {
  assert.equal(isEntryPoint(undefined), false);
  assert.equal(isEntryPoint('/no/such/work-plan.mjs'), false);
  assert.equal(isEntryPoint(fileURLToPath(new URL('./work-plan.mjs', import.meta.url)), new URL('./work-plan.mjs', import.meta.url).href), true);
});
test('shot template uses numeric global-frame origins and in-range events', () => {
  const shot = JSON.parse(readFileSync(new URL('../docs/routes/templates/shot.json', import.meta.url), 'utf8'));
  for (const id of shot.actorTracks) {
    const origin = shot.actorClockOrigin[id];
    assert.ok(Number.isInteger(origin) && origin >= 0 && origin <= shot.inFrame, id);
    assert.ok(Number.isFinite((shot.inFrame + 12 - origin) / 24), id);
  }
  assert.ok(shot.visibleEvents.every(e => Number.isInteger(e.atFrame) && e.atFrame >= shot.inFrame && e.atFrame < shot.outFrame));
});
