// 仓库规范检查的 comp 规则：按 P02 的规则约定导出 { id, title, run(ctx) }，发现的形状是 { level, file, line?, message, hint }。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RULES } from '../../tools/compliance/lib/scan.mjs';
import { toRepoCheck } from '../../tools/compliance/lib/repo-check.mjs';
import { REPO, j, hasGit, mkRepo, rm } from './helpers.mjs';

const DIR = path.join(REPO, 'tools/repo-check/rules/comp');
const load = async f => import(pathToFileURL(path.join(DIR, f)).href);

test('每条合规规则都有一个规则文件，导出 id、title、run 与 default', async () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.mjs')).sort();
  assert.deepEqual(files.map(f => `comp.${f.replace(/\.mjs$/, '')}`).sort(), RULES.map(r => r.id).sort());
  for (const f of files) {
    const m = await load(f);
    assert.equal(typeof m.id, 'string');
    assert.equal(typeof m.title, 'string');
    assert.equal(typeof m.run, 'function');
    assert.equal(m.default.id, m.id);
    assert.equal(m.default.run, m.run);
  }
});

test('规则在临时仓库上运行：发现的形状对，阻断与提示分得清，归档区合并成一条', { skip: !hasGit }, async () => {
  const token = j('AK', 'IA', 'QWERTYUIOPASDFGH');
  const url = j('https://b.oss.aliyuncs.com/a.mp3?Expires=1762300000&OSS', 'AccessKeyId=', 'abc', '&Signature=xyz');
  const dir = mkRepo({
    'src/a.js': `const k = "${token}";\n`,
    'cases/source/c1/a.json': `{"u":"${url}"}\n`,
    'cases/source/c1/b.json': `{"u":"${url}"}\n`,
    'cases/source/c2/a.json': `{"u":"${url}"}\n`,
  });
  try {
    const secrets = await load('secrets.mjs');
    const out = secrets.run({ root: dir, files: ['ignored'], extra: true });
    assert.equal(out.length, 1);
    assert.deepEqual(Object.keys(out[0]).sort(), ['file', 'hint', 'level', 'line', 'message']);
    assert.equal(out[0].level, 'error');
    assert.equal(out[0].file, 'src/a.js');
    assert.ok(!out[0].message.includes(token));
    const signed = (await load('signed-urls.mjs')).run({ root: dir });
    assert.deepEqual(signed.map(x => [x.level, x.file]), [['warn', 'cases/source/c1'], ['warn', 'cases/source/c2']]);
    assert.match(signed[0].message, /历史归档区有 2 处/);
    assert.match(signed[0].hint, /--scope archive/);
  } finally { rm(dir); }
});

test('toRepoCheck：只取本规则的发现，没有行号时不带 line', () => {
  const out = toRepoCheck([
    { rule: 'comp.reuse', zone: 'tree', level: 'warn', file: 'a', line: null, message: 'm', hint: 'h' },
    { rule: 'comp.secrets', zone: 'tree', level: 'error', file: 'b', line: 3, message: 'm', hint: 'h' },
  ], 'comp.reuse');
  assert.deepEqual(out, [{ level: 'warn', file: 'a', message: 'm', hint: 'h' }]);
});

test('本仓库：comp 规则没有阻断级发现（待修豁免见 tools/compliance/allowlist.json）', async () => {
  let errors = [];
  for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.mjs'))) {
    const m = await load(f);
    errors = errors.concat(m.run({ root: REPO }).filter(x => x.level === 'error').map(x => `${m.id} ${x.file}:${x.line || ''} ${x.message}`));
  }
  assert.deepEqual(errors, []);
});
