// 大文件闸门（D10，tools/env/lib/largefiles.mjs 与 tools/env/large-files.mjs）与 repo-check 的 env 域规则。
// 闸门在临时 git 仓库里测；规则的纯函数部分用夹具测，换行与 .gitattributes 规则直接对本仓库跑（只读）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkLargeFiles, readAllow, formatAllow } from '../../tools/env/lib/largefiles.mjs';
import { rules, createContext, runRules, envReadsInText, scanEnvReads, docEnvTable, dualShellFindings, pyViaNode } from '../../tools/repo-check/rules/env/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/env/spec.json'), 'utf8'));
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
  return r.stdout;
};
const sha = b => createHash('sha256').update(b).digest('hex');

test('大文件闸门：未登记的大文件、登记后内容变了都判违规；登记一致时通过；判定的是索引', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-large-test-'));
  try {
    git(dir, 'init', '-q');
    const LIMIT = 1024;                              // 测试用小阈值，判定逻辑与 5 MiB 相同
    const big = Buffer.alloc(4096, 7), small = Buffer.alloc(100, 1);
    fs.mkdirSync(path.join(dir, 'films', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'films', 'x', 'master.bin'), big);
    fs.writeFileSync(path.join(dir, 'small.txt'), small);
    // 只在工作区、没进索引：不算
    let r = await checkLargeFiles({ root: dir, threshold: LIMIT });
    assert.equal(r.ok, true);
    git(dir, 'add', '-A');
    r = await checkLargeFiles({ root: dir, threshold: LIMIT });
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.map(v => v.path), ['films/x/master.bin']);
    assert.match(r.violations[0].fix, /git rm --cached/);
    // 登记（sha256 + 大小）后通过
    fs.writeFileSync(path.join(dir, 'LARGE-FILES.allow'), formatAllow([{ path: 'films/x/master.bin', size: big.length, sha256: sha(big) }]));
    r = await checkLargeFiles({ root: dir, threshold: LIMIT });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(r.large[0].sha256, sha(big));
    // 内容被替换：违规，提示 --update
    fs.writeFileSync(path.join(dir, 'films', 'x', 'master.bin'), Buffer.alloc(4096, 8));
    git(dir, 'add', 'films/x/master.bin');
    r = await checkLargeFiles({ root: dir, threshold: LIMIT });
    assert.equal(r.ok, false);
    assert.match(r.violations[0].reason, /不一致/);
    assert.match(r.violations[0].fix, /--update/);
    // 白名单里已不在索引里的条目只提示
    git(dir, 'rm', '-q', '--cached', 'films/x/master.bin');
    r = await checkLargeFiles({ root: dir, threshold: LIMIT });
    assert.equal(r.ok, true);
    assert.deepEqual(r.stale, ['films/x/master.bin']);
    // 白名单格式错误
    fs.appendFileSync(path.join(dir, 'LARGE-FILES.allow'), 'not a valid line\n');
    assert.match(readAllow(dir).errors[0], /格式不对/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('本仓库：超过 5 MiB 的跟踪文件全部登记在 LARGE-FILES.allow，哈希一致', async () => {
  const r = await checkLargeFiles({ root: ROOT, threshold: SPEC.storage.largeFileBytes, allowFile: SPEC.storage.allowFile });
  assert.equal(r.ok, true, r.violations.map(v => `${v.path}：${v.reason}`).join('\n'));
  assert.deepEqual(r.stale, []);
  assert.ok(r.large.length >= 7);
});

test('large-files.mjs 命令：违规时 exit 4，信封带违规清单', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-large-cli-'));
  try {
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(SPEC.storage.largeFileBytes + 1, 3));
    git(dir, 'add', 'big.bin');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/env/large-files.mjs'), '--root', dir, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 4, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.error.code, 'large-file');
    assert.deepEqual(j.largeFiles.violations.map(v => v.path), ['big.bin']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('env 规则：本仓库的 .gitattributes 语义齐全、索引里没有 CRLF', async () => {
  const res = await runRules(createContext(ROOT), { only: ['env.gitattributes', 'env.eol'] });
  for (const r of res) assert.deepEqual(r.findings.filter(f => f.level === 'error'), [], r.id);
});

test('.gitattributes：cases/ 以外每个文本文件的检出换行都被固定（core.autocrlf=true 也不会变成 CRLF）', () => {
  const out = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files', '--eol', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 }).stdout;
  const loose = [];
  for (const rec of out.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [i, , ...rest] = rec.slice(0, tab).trim().split(/\s+/);
    const attr = rest.join(' ');
    const p = rec.slice(tab + 1);
    if (/^cases\/(source|vendor|licenses)\//.test(p) || i === 'i/-text' || i === 'i/none') continue;
    if (!/eol=(lf|crlf)/.test(attr) && !/-text/.test(attr)) loose.push(`${p}（${attr}）`);
  }
  assert.deepEqual(loose.slice(0, 10), []);
});

test('envReadsInText：按语言识别读取；sh 里先赋值的是脚本变量', () => {
  assert.deepEqual([...envReadsInText('const a = process.env.BEIMING_ANGLE; env.WORKERS; process.env["FFMPEG"]', 'js')].sort(), ['BEIMING_ANGLE', 'FFMPEG', 'WORKERS']);
  assert.deepEqual([...envReadsInText('os.environ.get("BEIMING_SAMPLES"); os.getenv("BNE_OUT"); os.environ["BNE_DUR"]', 'py')].sort(), ['BEIMING_SAMPLES', 'BNE_DUR', 'BNE_OUT']);
  // Python 文件里出现 JS 写法（测试夹具里的字符串）不算
  assert.deepEqual([...envReadsInText('s = "process.env.NOT_A_PY_READ"', 'py')], []);
  assert.deepEqual([...envReadsInText('PY=${PYTHON:-python3}\nFPS=24\necho ${FPS:-24}\n', 'sh')], ['PYTHON']);
});

test('代码里读到的环境变量都登记在 spec.json，且与 docs/ENVIRONMENT.md 的表一一对应', () => {
  const reads = scanEnvReads(createContext(ROOT));
  const registered = new Set(SPEC.envVars.map(v => v.name));
  const system = new Set(SPEC.systemVars);
  const unregistered = [...reads.keys()].filter(n => !registered.has(n) && !system.has(n));
  assert.deepEqual(unregistered, [], unregistered.map(n => `${n}：${[...reads.get(n)].join('、')}`).join('\n'));
  const doc = docEnvTable(fs.readFileSync(path.join(ROOT, 'docs/ENVIRONMENT.md'), 'utf8'));
  assert.deepEqual([...doc.keys()].sort(), [...registered].sort());
});

test('dualShellFindings：设变量的 bash 块要紧挨一个 powershell 块（前后都行）', () => {
  const bashSet = '```bash\nexport BEIMING_ANGLE=vulkan\n```\n';
  const ps = "```powershell\n$env:BEIMING_ANGLE = 'vulkan'\n```\n";
  assert.equal(dualShellFindings('d.md', bashSet + ps).length, 0);
  assert.equal(dualShellFindings('d.md', ps + bashSet).length, 0);
  assert.equal(dualShellFindings('d.md', bashSet + '正文\n```bash\nls\n```\n' + ps).length, 1);
  assert.equal(dualShellFindings('d.md', '```bash\nBEIMING_ANGLE=vulkan node x.mjs\n```\n').length, 1);
  assert.equal(dualShellFindings('d.md', '```bash\nnpm run setup\n```\n').length, 0);
});

test('pyViaNode：每一段开头的 python / python3 都换成 node tools/env/py.mjs', () => {
  assert.equal(pyViaNode('python3 tools/casebook.py check'), 'node tools/env/py.mjs tools/casebook.py check');
  assert.equal(pyViaNode('python3 -m a && python -m b'), 'node tools/env/py.mjs -m a && node tools/env/py.mjs -m b');
  assert.equal(pyViaNode('node x.mjs --python python3'), 'node x.mjs --python python3');
});

test('规则清单：每条都有 id、标题、级别；id 唯一且带 env. 前缀', () => {
  const ids = rules.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of rules) {
    assert.match(r.id, /^env\.[a-z-]+$/);
    assert.ok(r.title && ['error', 'warn'].includes(r.severity) && typeof r.run === 'function');
  }
});
