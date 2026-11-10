// tools/repo-check/rules/qa：在本仓库上全部通过；在临时仓库里故意写坏台账、豁免、档位、写死画幅，各自报错。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, tmp, cleanup, writeJson } from './helpers.mjs';
import { rules, runAll } from '../../tools/repo-check/rules/qa/index.mjs';

after(cleanup);

test('本仓库：QA 域规则全部通过', async () => {
  const res = await runAll({ root: ROOT });
  assert.deepEqual(res.filter(r => !r.ok).map(r => `${r.id}: ${r.findings.filter(f => f.level === 'error').map(f => f.message).join('；')}`), []);
  assert.deepEqual(res.map(r => r.id), rules.map(r => r.id));
});

test('写坏了就报：台账缺字段、agent 放行、agent 豁免、内置档位偏离 D07、检查代码写死画幅', async () => {
  const root = tmp();
  fs.cpSync(path.join(ROOT, 'tools/qa'), path.join(root, 'tools/qa'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/quality/waivers'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'docs/quality/QA-GATE.md'), path.join(root, 'docs/quality/QA-GATE.md'));
  writeJson(path.join(root, 'docs/quality/known-issues.json'), { issues: [
    { id: 'QA-A-001', title: 't', severity: 'P1', status: 'waived', film: 'x', symptom: 's', rootCause: 'r', evidence: 'e', owner: 'o', regression: { command: 'c' }, release: { approvedBy: 'Claude', quote: 'q', source: 's', date: 'd' } },
    { id: 'BAD', severity: 'P9', status: 'maybe', film: null },
  ] });
  writeJson(path.join(root, 'docs/quality/waivers/x.json'), { waivers: [{ check: 'texts.duration', reason: 'r', approvedBy: 'agent', quote: 'q', source: 's' }, { status: 'proposed', check: 'texts.contrast' }] });
  const prof = JSON.parse(fs.readFileSync(path.join(root, 'tools/qa/profiles.builtin.json'), 'utf8'));
  prof.defaults.audio.truePeakMaxDbtp = -2;
  delete prof.profiles['uhd-2160p24'];
  writeJson(path.join(root, 'tools/qa/profiles.builtin.json'), prof);
  fs.appendFileSync(path.join(root, 'tools/qa/checks/visual.mjs'), '\nexport const BAD = 1920;\n');
  const res = Object.fromEntries((await runAll({ root })).map(r => [r.id, r]));
  const msgs = id => res[id].findings.filter(f => f.level === 'error').map(f => f.message).join('\n');
  assert.equal(res['qa.known-issues'].ok, false);
  assert.match(msgs('qa.known-issues'), /agent 自己放行/);
  assert.match(msgs('qa.known-issues'), /severity 只能是/);
  assert.match(msgs('qa.known-issues'), /scope/);
  assert.equal(res['qa.waivers'].ok, false);
  assert.match(msgs('qa.waivers'), /agent 自己/);
  assert.equal(res['qa.builtin-profiles'].ok, false);
  assert.match(msgs('qa.builtin-profiles'), /uhd-2160p24/);
  assert.match(msgs('qa.builtin-profiles'), /真峰值上限/);
  assert.equal(res['qa.no-hardcoded-spec'].ok, false);
  assert.match(msgs('qa.no-hardcoded-spec'), /visual\.mjs/);
});

test('单独运行：--help exit 0；未知参数 exit 2；--json 输出一个信封', () => {
  const cli = path.join(ROOT, 'tools/repo-check/rules/qa/index.mjs');
  assert.equal(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, '--nope'], { encoding: 'utf8' }).status, 2);
  const r = spawnSync(process.execPath, [cli, '--json'], { encoding: 'utf8', cwd: ROOT });
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.exitCode, r.status);
});
