// tests/ci/windows-paths.mjs 的工具函数：CRLF 统计只看已跟踪的文本文件、跳过 cases/；别名的建立与删除只动链接本身，
// 绝不递归进目标目录（删错一次就是删掉整个仓库）。完整检查由 CI 的 windows-paths job 跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { crlfFiles, makeAlias, removeAlias } from './windows-paths.mjs';
import { makeRepo, runNode, REPO } from './helpers.mjs';

const hasGit = spawnSync('git', ['--version']).status === 0;

test('--help 只打印用法、exit 0', async () => {
  const r = await runNode(path.join(REPO, 'tests/ci/windows-paths.mjs'), ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /用法：node tests\/ci\/windows-paths\.mjs/);
});

test('crlfFiles：只报已跟踪的文本文件里的 CRLF，cases/ 与二进制扩展名不算；不是 git 检出时返回 null', { skip: !hasGit && '没有 git' }, t => {
  const { root, cleanup } = makeRepo({
    '.gitattributes': '* -text\n',   // 夹具里关掉换行转换，保证写进去的 CRLF 原样留在工作区
    'a.sh': 'echo 1\r\necho 2\r\n', 'b.md': '一行\n', 'tools/c.mjs': 'x\r\n', 'cases/old/d.js': 'y\r\n', 'img.png': 'p\r\n',
  }, { git: true });
  t.after(cleanup);
  fs.writeFileSync(path.join(root, 'untracked.js'), 'z\r\n');
  assert.deepEqual(crlfFiles(root).sort(), ['a.sh', 'tools/c.mjs']);
  const plain = makeRepo({ 'x.md': 'a\r\n' });
  t.after(plain.cleanup);
  assert.equal(crlfFiles(plain.root), null);
});

test('makeAlias / removeAlias：别名能当目录用；删除只去掉链接，目标原样保留；不是链接时拒绝删除', t => {
  const { root, cleanup } = makeRepo({ 'tools/x.txt': '原文\n' });
  t.after(cleanup);
  const link = makeAlias(root);
  assert.match(path.basename(link.alias), /北冥 别名/);
  assert.equal(fs.readFileSync(path.join(link.alias, 'tools', 'x.txt'), 'utf8'), '原文\n');
  removeAlias(link);
  assert.equal(fs.existsSync(link.alias), false);
  assert.equal(fs.existsSync(link.base), false);
  assert.equal(fs.readFileSync(path.join(root, 'tools', 'x.txt'), 'utf8'), '原文\n', '目标目录不能被动到');
  removeAlias(link);   // 再删一次：已经没有了，不报错
  const fake = { base: path.join(root, 'tools'), alias: path.join(root, 'tools') };
  assert.throws(() => removeAlias(fake), /不是链接，拒绝删除/);
  assert.equal(fs.existsSync(path.join(root, 'tools', 'x.txt')), true);
});
