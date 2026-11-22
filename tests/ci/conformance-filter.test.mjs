// conformance-filter：PR 改到帧源与一致性边界才排 5090 显卡队；改别处一律 false。CLI 从 stdin 读 git diff --name-only。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { FRAME_SOURCE_PREFIXES, classifyConformancePaths } from './conformance-filter.mjs';

const CLI = path.join(REPO, 'tests/ci/conformance-filter.mjs');

test('改到帧源与一致性边界的路径判 true，并列出命中的路径', () => {
  for (const p of [
    'beiming/sources/three/source.mjs', 'beiming/host/page/host.mjs', 'beiming/kernel/conformance/suite.mjs',
    'beiming/kernel/contracts/source/CONTRACT.md', 'beiming/kernel/contracts/meta/check.mjs', 'beiming/calib/check.mjs',
    './beiming/calib/README.md', 'beiming\\host\\page\\host.mjs',
  ]) {
    const r = classifyConformancePaths(['docs/README.md', p]);
    assert.equal(r.frame_sources_changed, true, p);
    assert.equal(r.matched.length, 1, p);
  }
  assert.equal(FRAME_SOURCE_PREFIXES.length, 6);
});

test('不改帧源的 PR 严格判 false（不排显卡队）；前缀相近的路径不误判', () => {
  const others = [
    'beiming/api/server.mjs', 'beiming/jobs/queue.mjs', 'beiming/comp/x.mjs', 'beiming/observe/curves.mjs',
    'beiming/verify/l1.mjs', 'beiming/cards/a.md', 'docs/routes/README.md', 'site/index.html',
    'beiming/sources-notes/a.md', 'beiming/hostile.mjs', 'beiming/calibration/x', 'beiming/kernel/conformance-old/x',
    'beiming/kernel/contracts/source-pack/x', 'beiming/kernel/contracts/metadata/x', 'beiming/kernel/contracts/shot/CONTRACT.md',
    'beiming/sources', 'x/beiming/sources/a.mjs', '',
  ];
  assert.deepEqual(classifyConformancePaths(others), { frame_sources_changed: false, matched: [] });
  assert.deepEqual(classifyConformancePaths([]), { frame_sources_changed: false, matched: [] });
});

test('CLI：stdin 逐行读路径，stdout 只有一行 frame_sources_changed=<bool>（直接追加进 GITHUB_OUTPUT）', () => {
  const run = input => spawnSync(process.execPath, [CLI], { input, encoding: 'utf8' });
  const yes = run('docs/a.md\r\nbeiming/sources/three/x.mjs\n');
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(yes.stdout, 'frame_sources_changed=true\n');
  assert.match(yes.stderr, /beiming\/sources\/three\/x\.mjs/);
  const no = run('beiming/api/server.mjs\nsite/index.html\n');
  assert.equal(no.status, 0, no.stderr);
  assert.equal(no.stdout, 'frame_sources_changed=false\n');
  assert.equal(run('').stdout, 'frame_sources_changed=false\n');
});
