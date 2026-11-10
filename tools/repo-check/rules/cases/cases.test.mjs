// cases 域规则的测试：在临时目录里搭一个小仓库，用 node tools/repo-check.mjs --root <目录> --only <规则> --json 跑，
// 断言本域规则的状态与发现（只看本域：别的域的加载问题不影响这里的判定）。最后在真实仓库上跑 cases.rights 与 cases.commands。
//   node --test tools/repo-check/rules/cases/cases.test.mjs
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CHECK = path.join(ROOT, 'tools/repo-check.mjs');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function check(root, only) {
  const r = spawnSync(process.execPath, [CHECK, '--root', root, '--only', only, '--json'], { encoding: 'utf8', timeout: 120_000 });
  const env = JSON.parse(r.stdout);
  const rule = id => env.data.rules.find(x => x.id === id);
  const findings = id => env.data.findings.filter(f => f.rule === id);
  return { env, rule, findings };
}

const REGISTER = { schemaVersion: 1, updated: '2026-11-10', categories: [
  { id: 'R01', title: '客户材料', kind: 'client-material', match: { cases: ['client'] } },
  { id: 'R07', title: '鼓组采样（CC BY 4.0）', kind: 'open-license', match: { text: [{ path: 'CREDITS*', pattern: 'MuldjordKit' }] } },
] };
const rights = (clearance, register) => ({ clearance, register, owner: '待补', license: 'LicenseRef-Casebook-Archive', sourceUrl: null,
  attributionText: [], aiGenerated: { present: '待补', register: [], tools: '待补' }, evidence: [] });

function repo({ clientClearance = 'internal', drumsRegister = ['R07'], readme = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-cases-'));
  made.push(dir);
  const w = (rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const credits = 'Drums: "MuldjordKit" by Lars Muldjord, licensed under CC BY 4.0\n';
  w('cases/source/drums/CREDITS', credits);
  w('docs/rights/register.json', JSON.stringify(REGISTER, null, 2));
  w('cases/catalog.json', JSON.stringify({ version: 1, schemaVersion: 2, cases: [
    { id: 'client', group: 'ppt-stories', status: 'historical-render', title: '客户片', files: [], rights: rights(clientClearance, ['R01']) },
    { id: 'drums', group: 'styles', status: 'historical-render', title: '鼓', rights: rights('public', drumsRegister),
      files: [{ path: 'CREDITS', source: 'source/drums/CREDITS', sha256: 'x', size: credits.length }] },
  ], assets: {}, packs: [] }, null, 2));
  w('cases/README.md', `# 案例库\n\n${readme}\n`);
  w('docs/cases/casebook.md', '# 工具\n\n```bash\nnode tools/env/py.mjs tools/casebook.py check\n```\n');
  return dir;
}

test('cases.rights：权利字段与登记册的计算一致时通过', () => {
  const { rule, findings } = check(repo(), 'cases.rights');
  assert.equal(rule('cases.rights').status, 'pass', JSON.stringify(findings('cases.rights')));
});

test('cases.rights：漏登的类别、错的 clearance 都报错', () => {
  const { rule, findings } = check(repo({ clientClearance: 'public', drumsRegister: [] }), 'cases.rights');
  assert.equal(rule('cases.rights').status, 'fail');
  const text = findings('cases.rights').map(f => f.message).join('\n');
  assert.match(text, /R07 的案例与登记册计算不一致：catalog 漏了 drums/);
  assert.match(text, /client 的 rights\.clearance 是 public，按登记册应为 internal/);
});

test('cases.commands：直接用 python 调 casebook.py、写「本次」都报错，经 py.mjs 的写法通过', () => {
  let r = check(repo({ readme: '```bash\npython3 tools/casebook.py list\npython tools/casebook.py check\n```\n\n本次未重渲。' }), 'cases.commands');
  assert.equal(r.rule('cases.commands').status, 'fail');
  assert.deepEqual(r.findings('cases.commands').map(f => `${f.file}:${f.line}`), ['cases/README.md:4', 'cases/README.md:5', 'cases/README.md:8']);
  r = check(repo({ readme: '`npm run cases:check` 或 `node tools/env/py.mjs tools/casebook.py list`；2026-11-07 归档时未重渲。' }), 'cases.commands');
  assert.equal(r.rule('cases.commands').status, 'pass', JSON.stringify(r.findings('cases.commands')));
});

test('cases.index、cases.catalog：被检查的仓库没有 casebook.py 时只给提示，不判失败', () => {
  const { rule, findings } = check(repo(), 'cases.index,cases.catalog');
  for (const id of ['cases.index', 'cases.catalog']) {
    assert.notEqual(rule(id).status, 'fail', JSON.stringify(findings(id)));
    assert.match(findings(id)[0].message, /跳过：被检查的仓库里没有 tools\/casebook\.py/);
  }
});

test('本仓库：cases.rights 与 cases.commands 通过', () => {
  const { rule, findings } = check(ROOT, 'cases.rights,cases.commands');
  for (const id of ['cases.rights', 'cases.commands']) assert.equal(rule(id).status, 'pass', JSON.stringify(findings(id)).slice(0, 2000));
});
