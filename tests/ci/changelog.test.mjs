// tests/ci/changelog.mjs：Keep a Changelog 结构校验、版本号规范化与比较、按标签取 Release 说明、与 package.json 核对版本，
// 以及命令行的退出码（附录 C1）与 --json 信封（C2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseChangelog, releaseNotes, normalizeVersion, compareVersions, TYPES } from './changelog.mjs';
import { CliError, EXIT } from '../../tools/run-tests.mjs';
import { makeRepo, runNode, REPO } from './helpers.mjs';

const TOOL = path.join(REPO, 'tests/ci/changelog.mjs');
const GOOD = `# 更新日志

说明文字。

## [Unreleased]

### Added

- 新东西

## [2.0.0] - 2026-11-20

### Changed

- 引擎九层

### Removed

- 不兼容：旧接口

## [1.0.0] - 2026-11-04

### Added

- 首次发布

[Unreleased]: https://example.com/compare/v2.0.0...HEAD
[2.0.0]: https://example.com/compare/v1.0...v2.0.0
[1.0.0]: https://example.com/releases/tag/v1.0
`;

test('合规的更新日志：没有错误，统计版本与条目', () => {
  const p = parseChangelog(GOOD);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.title, '更新日志');
  assert.deepEqual(p.sections.map(s => [s.label, s.version, s.date, s.entries]), [
    ['Unreleased', null, null, 1], ['2.0.0', '2.0.0', '2026-11-20', 2], ['1.0.0', '1.0.0', '2026-11-04', 1],
  ]);
  assert.deepEqual(p.sections[1].types, { Changed: 1, Removed: 1 });
});

test('结构问题逐条报出行号', () => {
  const cases = [
    [GOOD.replace('## [Unreleased]\n\n### Added\n\n- 新东西\n\n', ''), /第一个二级标题必须是 ## \[Unreleased\]/],
    [GOOD.replace('### Changed', '### 改动'), /分类只能是/],
    [GOOD.replace('## [2.0.0] - 2026-11-20', '## [2.0.0]'), /缺日期/],
    [GOOD.replace('2026-11-20', '2026-02-30'), /不是合法的 YYYY-MM-DD/],
    [GOOD.replace('## [2.0.0]', '## [0.9.0]'), /版本要从新到旧排列/],
    [GOOD.replace('## [2.0.0]', '## [1.0.0]'), /重复/],
    [GOOD.replace('## [2.0.0] - 2026-11-20', '## 2.0.0 - 2026-11-20'), /二级标题要写成/],
    [GOOD.replace('### Added\n\n- 首次发布', '- 首次发布'), /条目要放在 ### 分类下面/],
    [GOOD.replace('### Added\n\n- 首次发布', '### Added'), /没有任何条目/],
    [GOOD.replace('# 更新日志', '# 更新日志\n\n# 又一个'), /只能有一个一级标题/],
    [GOOD.replace('## [Unreleased]', '## [Unreleased] - 2026-11-21'), /\[Unreleased\] 不写日期/],
  ];
  for (const [text, re] of cases) {
    const { errors } = parseChangelog(text);
    assert.ok(errors.some(e => re.test(e)), `应报 ${re}，实际：${errors.join(' | ') || '无'}`);
  }
});

test('代码块里的 ## 与 ### 不当标题；CRLF 与 BOM 都能读', () => {
  const text = '﻿' + GOOD.replace('- 新东西', '- 新东西\n\n```md\n## [9.9.9] - 2099-01-01\n### 随便\n```').replace(/\n/g, '\r\n');
  const p = parseChangelog(text);
  assert.deepEqual(p.errors, []);
  assert.equal(p.sections.length, 3);
});

test('版本号：v1.0 与 1.0.0 等价，预发布号低于正式版', () => {
  assert.equal(normalizeVersion('v1.0'), '1.0.0');
  assert.equal(normalizeVersion('2.1.0-rc.1'), '2.1.0-rc.1');
  assert.equal(normalizeVersion('v2'), null);
  assert.equal(normalizeVersion('latest'), null);
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.ok(compareVersions('2.0.0-rc.1', '2.0.0') < 0);
  assert.ok(compareVersions('2.0.0-rc.2', '2.0.0-rc.10') < 0);
  assert.ok(compareVersions('2.0.0-alpha', '2.0.0-alpha.1') < 0);
  assert.equal(compareVersions('v1.0', '1.0.0'), 0);
  assert.deepEqual(TYPES, ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
});

test('按标签取 Release 说明：带比较链接与署名区块；找不到对应段落是契约错误（4）', () => {
  const p = parseChangelog(GOOD);
  const { text, section } = releaseNotes(p, { tag: 'v2.0.0', footer: '—— 署名区块 ——\n' });
  assert.equal(section.version, '2.0.0');
  assert.match(text, /^### Changed\n\n- 引擎九层/);
  assert.match(text, /完整变更：https:\/\/example\.com\/compare\/v1\.0\.\.\.v2\.0\.0/);
  assert.ok(text.trimEnd().endsWith('—— 署名区块 ——'));
  assert.equal(releaseNotes(p, { tag: 'v1.0' }).section.version, '1.0.0');
  assert.throws(() => releaseNotes(p, { tag: 'v3.0.0' }), e => e instanceof CliError && e.exitCode === EXIT.CONTRACT && /2\.0\.0、1\.0\.0/.test(e.message));
  assert.throws(() => releaseNotes(p, { tag: 'nightly' }), e => e instanceof CliError && e.exitCode === EXIT.USAGE);
  assert.match(releaseNotes(p, { unreleased: true }).text, /新东西/);
});

test('仓库自己的 CHANGELOG.md 合规，且有 [Unreleased] 与 [1.0.0]（对应标签 v1.0）', async () => {
  const r = await runNode(TOOL, ['check', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.unreleasedEntries > 0);
  assert.ok(r.json.versions.some(v => v.version === '1.0.0'));
  const n = await runNode(TOOL, ['notes', 'v1.0', '--json']);
  assert.equal(n.code, 0, n.stderr);
  assert.match(n.json.notes, /首次公开发布/);
});

test('命令行：--help 无副作用；子命令与参数错误 exit 2；版本号与 package.json 不一致 exit 4；--out 写文件并记哈希', async t => {
  const { root, cleanup } = makeRepo({ 'CHANGELOG.md': GOOD, 'package.json': JSON.stringify({ version: '2.0.0' }), 'footer.md': '署名\n' });
  t.after(cleanup);
  const help = await runNode(TOOL, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /用法：node tests\/ci\/changelog\.mjs check/);
  for (const bad of [[], ['publish'], ['check', 'v1'], ['notes'], ['notes', 'v1.0', '--unreleased'], ['check', '--nope']]) {
    const r = await runNode(TOOL, [...bad, '--file', path.join(root, 'CHANGELOG.md'), '--json']);
    assert.equal(r.code, 2, `${bad.join(' ')}：${r.stderr}`);
    assert.equal(r.json.error.code, 'USAGE');
  }
  const mismatch = await runNode(TOOL, ['notes', 'v1.0', '--file', path.join(root, 'CHANGELOG.md'), '--package', path.join(root, 'package.json'), '--json']);
  assert.equal(mismatch.code, 4);
  assert.equal(mismatch.json.error.code, 'VERSION_MISMATCH');
  const out = path.join(root, 'out', 'notes.md');
  const ok = await runNode(TOOL, ['notes', 'v2.0.0', '--file', path.join(root, 'CHANGELOG.md'), '--package', path.join(root, 'package.json'),
    '--footer', path.join(root, 'footer.md'), '--out', out, '--json']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.outputs.length, 1);
  assert.equal(ok.json.outputs[0].kind, 'release-notes');
  assert.match(fs.readFileSync(out, 'utf8'), /引擎九层[\s\S]*署名/);
  const missing = await runNode(TOOL, ['check', '--file', path.join(root, 'nope.md'), '--json']);
  assert.equal(missing.code, 4);
  assert.equal(missing.json.error.code, 'CHANGELOG_MISSING');
  const broken = makeRepo({ 'CHANGELOG.md': GOOD.replace('### Changed', '### 改动') });
  t.after(broken.cleanup);
  const b = await runNode(TOOL, ['check', '--file', path.join(broken.root, 'CHANGELOG.md'), '--json']);
  assert.equal(b.code, 4);
  assert.equal(b.json.error.code, 'CHANGELOG_INVALID');
  assert.match(b.stderr, /第 \d+ 行：分类只能是/);
});
