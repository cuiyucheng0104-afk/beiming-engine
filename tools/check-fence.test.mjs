// tools/check-fence.mjs（改动围栏硬门禁）的测试：在临时 git 仓库里跑真命令，覆盖通过、越界、forbidden 优先、
// --no-renames 防逃逸、未跟踪文件、子目录执行、零改动、空 fence、⏳ 占位符、行内写法、dir/ 不误伤同级、两种输入模式、反斜杠路径。
//   node --test tools/check-fence.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp, matches, parseContract } from './check-fence.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'check-fence.mjs');
// 在 git 钩子里跑测试时 GIT_DIR 等会劫持子进程的 git
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR)$/.test(k)));
const git = (cwd, ...a) => {
  const p = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-C', cwd, ...a], { encoding: 'utf8', env: ENV });
  assert.equal(p.status, 0, `git ${a.join(' ')}: ${p.stderr}`);
  return p.stdout;
};
const put = (repo, rel, body = '1\n') => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), body); };
const fence = (cwd, ...args) => {
  const p = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: ENV });
  return { code: p.status, out: p.stdout + p.stderr, stdout: p.stdout };
};
/** 基线提交（tag base）里有 src/a.js、migrations/001.sql、文档.md。 */
function mkRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'check-fence-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q');
  for (const f of ['src/a.js', 'migrations/001.sql', '文档.md']) put(repo, f);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'tag', 'base');
  return repo;
}
const ARGS = ['--base', 'base', '--fence', 'src/', '--fence', '*.md', '--forbidden', 'migrations/', '--forbidden', 'src/*/'];

test('合法改动（已提交 + 未提交 + 中文路径 + 未跟踪）放行', t => {
  const repo = mkRepo(t);
  put(repo, 'src/a.js', '2\n'); git(repo, 'commit', '-q', '-am', 'in fence');
  put(repo, '文档.md', '2\n'); put(repo, 'new.md');
  const r = fence(repo, ...ARGS);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /3 个改动文件/);
});

test('越界文件拦截，且输出 FAILED / EXPECTED / SAW', t => {
  const repo = mkRepo(t);
  put(repo, 'src/a.js', '2\n'); put(repo, 'other.txt');
  const r = fence(repo, ...ARGS);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAILED {3}fence\nEXPECTED .*\nSAW {6}other\.txt {2}← 不在 fence 内/);
  assert.doesNotMatch(r.out, /src\/a\.js {2}←/);
});

test('forbidden 优先于 fence（fence 的通配也匹配它）', t => {
  const repo = mkRepo(t);
  put(repo, 'migrations/说明.md');
  const r = fence(repo, ...ARGS);
  assert.equal(r.code, 1);
  assert.match(r.out, /migrations\/说明\.md {2}← forbidden: migrations\//);
});

test('把文件移出 forbidden 目录也算碰了它（--no-renames）', t => {
  const repo = mkRepo(t);
  git(repo, 'mv', 'migrations/001.sql', 'src/001.sql');
  const r = fence(repo, ...ARGS);
  assert.equal(r.code, 1);
  assert.match(r.out, /migrations\/001\.sql {2}← forbidden/);
});

test('未跟踪文件越界拦截；子目录里执行仍抓到仓库别处的未跟踪文件', t => {
  const repo = mkRepo(t);
  put(repo, 'src/a.js', '2\n'); put(repo, 'other.txt');
  for (const cwd of [repo, join(repo, 'src')]) {
    const r = fence(cwd, ...ARGS);
    assert.equal(r.code, 1, cwd);
    assert.match(r.out, /other\.txt/);
  }
  assert.equal(fence(repo, ...ARGS, '--repo', join(repo, 'src')).code, 1);
});

test('dir/ 只匹配目录之下，不误伤同级文件：src/*/ 禁子目录、放过 src/a.js', t => {
  const repo = mkRepo(t);
  put(repo, 'src/a.js', '2\n');
  assert.equal(fence(repo, ...ARGS).code, 0);
  put(repo, 'src/vendor/v.js');
  const r = fence(repo, ...ARGS);
  assert.equal(r.code, 1);
  assert.match(r.out, /src\/vendor\/v\.js {2}← forbidden: src\/\*\//);
});

test('零改动（HEAD 当 base）不能当作通过', t => {
  const repo = mkRepo(t);
  const r = fence(repo, ...ARGS.map(a => (a === 'base' ? 'HEAD' : a)));
  assert.equal(r.code, 1);
  assert.match(r.out, /0 个改动/);
});

test('空 fence、没给围栏、⏳ 占位符都拦', t => {
  const repo = mkRepo(t);
  put(repo, 'src/a.js', '2\n');
  for (const args of [['--base', 'base'], ['--base', 'base', '--forbidden', 'migrations/'], ['--base', 'base', '--fence', '⏳ 待填'], ['--base', 'base', '--fence', 'src/', '--fence', '⏳ 待填']]) {
    const r = fence(repo, ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.out, /FAILED {3}fence/);
  }
});

test('缺 --base 是用法错误（2），git 失败（base 不存在）退出 1', t => {
  const repo = mkRepo(t);
  assert.equal(fence(repo, '--fence', 'src/').code, 2);
  const r = fence(repo, '--base', 'no-such-ref', '--fence', 'src/');
  assert.equal(r.code, 1);
  assert.match(r.out, /FAILED {3}git merge-base/);
  assert.equal(fence(tmpdir(), '--base', 'base', '--fence', 'src/', '--repo', join(tmpdir(), 'no-such-dir-check-fence')).code, 1);
});

test('契约文件模式：块状列表通过、越界拦截；与 CLI 参数取并集', t => {
  const repo = mkRepo(t);
  const contract = join(repo, '..', `contract-${Date.now()}.yaml`);
  t.after(() => rmSync(contract, { force: true }));
  writeFileSync(contract, 'constraints:\n  fence:\n    - "src/"   # 注释\n    - \'*.md\'\n  forbidden:\n    - migrations/\n    - "src/*/"\ndone_when:\n  - "x"\n');
  put(repo, 'src/a.js', '2\n'); put(repo, '文档.md', '2\n');
  assert.equal(fence(repo, '--base', 'base', '--contract', contract).code, 0);
  put(repo, 'other.txt');
  assert.match(fence(repo, '--base', 'base', '--contract', contract).out, /other\.txt/);
  assert.equal(fence(repo, '--base', 'base', '--contract', contract, '--fence', 'other.txt').code, 0);
  assert.equal(fence(repo, '--base', 'base', '--contract', contract, '--fence', 'other.txt', '--forbidden', 'other.txt').code, 1);
});

test('契约文件：缺失、空 fence、⏳、行内列表写法都拦（行内写法不让 forbidden 静默失效）', t => {
  const repo = mkRepo(t);
  put(repo, 'src/a.js', '2\n');
  const dir = mkdtempSync(join(tmpdir(), 'check-fence-c-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = join(dir, 'c.yaml');
  assert.match(fence(repo, '--base', 'base', '--contract', c).out, /契约文件存在且可读/);
  const cases = {
    空: 'constraints:\n  forbidden:\n    - "x/"\n',
    占位符: 'fence:\n  - "⏳ 待填"\n',
    混合占位符: 'fence:\n  - "src/"\n  - "⏳ 待填"\n',
    行内: 'fence:\n  - "src/"\nforbidden: ["src/"]\n',
    行内fence: 'fence: [src/]\n',
  };
  for (const [name, body] of Object.entries(cases)) {
    writeFileSync(c, body);
    const r = fence(repo, '--base', 'base', '--contract', c);
    assert.equal(r.code, 1, name);
  }
  writeFileSync(c, cases.行内);
  assert.match(fence(repo, '--base', 'base', '--contract', c).out, /行内写法/);
});

test('--json：失败时信封 ok:false、exitCode 1，成功时 data 里有改动列表', t => {
  const repo = mkRepo(t);
  put(repo, 'src/a.js', '2\n');
  const ok = JSON.parse(fence(repo, ...ARGS, '--json').stdout);
  assert.deepEqual([ok.ok, ok.data.changed], [true, ['src/a.js']]);
  put(repo, 'other.txt');
  const bad = JSON.parse(fence(repo, ...ARGS, '--json').stdout);
  assert.deepEqual([bad.ok, bad.exitCode, bad.error.code], [false, 1, 'failure.fence']);
});

// ───── 纯函数 ─────
test('matches：通配、dir/、反斜杠路径与模式规范化', () => {
  const yes = [['src/a/b.js', 'src/'], ['src/a/b.js', 'src'], ['src/a.js', 'src/*.js'], ['a/b/c.md', '*.md'], ['a/b/c.md', '**/c.md'],
    ['x1.js', 'x?.js'], ['x1.js', 'x[0-9].js'], ['x1.js', 'x[!a-z].js'], ['src\\a\\b.js', 'src/'], ['src/a/b.js', 'src\\'], ['src/a.js', './src/'], ['a.b', 'a.b'], ['a[1.js', 'a[1.js']];
  const no = [['src/a.js', 'src/*/'], ['pkgs/list.tsv', 'pkgs/*/'], ['srcx/a.js', 'src/'], ['src', 'src/'], ['axb', 'a.b'], ['x1.js', 'x[a-z].js'], ['x1.js', 'x[!0-9].js'], ['dir/a.js', 'src/']];
  for (const [f, p] of yes) assert.ok(matches(f, p), `${f} ~ ${p}`);
  for (const [f, p] of no) assert.ok(!matches(f, p), `${f} !~ ${p}`);
  assert.ok(matches('pkgs/x/list.tsv', 'pkgs/*/'));
  assert.ok(globToRegExp('a*').test('a/b'));
});

test('parseContract：双引号转义、单引号、裸项、逗号拆分、同名键并集、注释；行内写法抛错', () => {
  const c = parseContract('fence:\n  - "a\\"b/"\n  - \'c d/\'\n  - e/ # 注释\n  - "*.mp4, *.mov"\n# fence:\nforbidden:\n  - f/\nfence:\n  - g/\n');
  assert.deepEqual(c.fence, ['a"b/', 'c d/', 'e/', '*.mp4', '*.mov', 'g/']);
  assert.deepEqual(c.forbidden, ['f/']);
  assert.throws(() => parseContract('forbidden: [a/]\n'), /行内写法/);
  assert.throws(() => parseContract('fence: a/\n'), /行内写法/);
  assert.deepEqual(parseContract('fence:  # 空\n'), { fence: [], forbidden: [] });
});
