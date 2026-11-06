import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePlan, inspectPlan } from './work-plan.mjs';

const task = (id, extra = {}) => ({ id, title: id, ownerRole: 'owner', route: 'shared', status: 'planned', dependsOn: [], inputs: ['source'], writeScope: [`engine/${id}/`], outputs: ['result'], acceptance: ['verified'], evidence: [], ...extra });
const plan = tasks => ({ schemaVersion: 1, tasks });

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
test('published task cards match the canonical plan', () => {
  const p = JSON.parse(readFileSync(new URL('../docs/routes/work-plan.json', import.meta.url), 'utf8'));
  const doc = readFileSync(new URL('../docs/routes/work-breakdown.md', import.meta.url), 'utf8');
  assert.equal((doc.match(/^### T\d{2} · /gm) ?? []).length, p.tasks.length);
  for (const t of p.tasks) {
    const card = doc.split(`### ${t.id} · ${t.title}\n`)[1]?.split('\n### ')[0];
    assert.ok(card, t.id);
    assert.ok(card.includes(`路线：\`${t.route}\`；角色：${t.ownerRole}；状态：\`${t.status}\``), t.id);
    assert.ok(card.includes(`依赖：${t.dependsOn.join(', ') || '无'}。`), t.id);
    for (const field of ['inputs', 'writeScope', 'outputs', 'acceptance']) {
      for (const value of t[field]) assert.ok(card.includes(value), `${t.id}.${field}: ${value}`);
    }
  }
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
