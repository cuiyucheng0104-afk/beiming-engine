// conformance-filter：PR 改到帧源与一致性边界才排 5090 显卡队；改别处一律 false。CLI 从 stdin 读 git diff --name-only。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

test('路径原样比较：前导空格的顶层目录不是帧源目录，内部空格、中文、制表符照常命中', () => {
  assert.equal(classifyConformancePaths([' beiming/sources/three/source.js']).frame_sources_changed, false);
  for (const p of ['beiming/sources/three/材质.mjs', 'beiming/sources/three/a\tb.mjs', 'beiming/host/page/a b.mjs']) {
    assert.equal(classifyConformancePaths([p]).frame_sources_changed, true, JSON.stringify(p));
  }
});

test('真实 git 仓库：git diff -z --name-only --no-renames base...head | --null，与工作流同一条管道', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-i6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const hashBlob = content => {
    const r = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: content, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  // 直接写 Git 索引与对象库生成真实 commit（Windows NTFS 工作树不允许文件名含 \t 或字面 \，而 Git 树对象全平台原生支持）
  const commit = (files, msg) => {
    const hasHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    if (hasHead.status === 0) git('read-tree', 'HEAD');
    else git('read-tree', '--empty');
    const blob = hashBlob(`${msg}\n`);
    for (const f of files) git('update-index', '--add', '--cacheinfo', `100644,${blob},${f}`);
    const tree = git('write-tree');
    const commitArgs = ['commit-tree', tree, ...(hasHead.status === 0 ? ['-p', hasHead.stdout.trim()] : []), '-m', msg];
    const sha = git(...commitArgs);
    git('update-ref', 'HEAD', sha);
    return sha;
  };
  const classify = (base, head) => {
    const diff = spawnSync('git', ['diff', '-z', '--name-only', '--no-renames', `${base}...${head}`], { cwd: dir });
    assert.equal(diff.status, 0, String(diff.stderr));
    const r = spawnSync(process.execPath, [CLI, '--null'], { input: diff.stdout, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q', '-b', 'main');
  const base = commit(['README.md'], 'base');
  const cases = [
    [['beiming/sources/three/材质.mjs'], true],
    [['beiming/sources/three/a\tb.mjs'], true],
    [['beiming/host/page/a b.mjs'], true],
    [[' beiming/sources/a.mjs'], false],
    [['beiming\\sources\\notes.txt'], false],
    [['beiming/sources-notes/a.md', 'docs/a.md'], false],
  ];
  for (const [files, want] of cases) {
    git('update-ref', 'refs/heads/pr', base);
    git('symbolic-ref', 'HEAD', 'refs/heads/pr');
    assert.equal(classify(base, commit(files, JSON.stringify(files))), `frame_sources_changed=${want}\n`, JSON.stringify(files));
  }
  // 多提交 PR：第 1 个提交改帧源、第 2 个只改 README，三点差异仍要看到第 1 个
  git('update-ref', 'refs/heads/pr', base);
  git('symbolic-ref', 'HEAD', 'refs/heads/pr');
  commit(['beiming/calib/check.mjs'], 'c1');
  const head = commit(['README.md'], 'c2');
  assert.equal(classify(base, head), 'frame_sources_changed=true\n');
  assert.equal(classify('HEAD~1', head), 'frame_sources_changed=false\n', '只看最后一个提交会漏判：工作流不能拿 HEAD~1 当基准');
});


test('I6-R3-Red: Git --null 模式下根目录字面反斜杠文件 beiming\\sources\\notes.txt 不得误判为帧源目录', () => {
  assert.equal(classifyConformancePaths(['beiming\\sources\\notes.txt'], { gitNull: true }).frame_sources_changed, false);
});
