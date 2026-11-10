// 仓库规范检查「画面基线」规则的测试：node --test tests/golden/repo-check-baseline.test.mjs
// 正例：本仓库 0 个错误；反例：在系统临时目录搭一个最小仓库（不在 git 里，规则退回目录遍历），逐条造错，规则必须抓到。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rules, runRules, domain } from '../../tools/repo-check/rules/baseline/index.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RULE = path.join(ROOT, 'tools/repo-check/rules/baseline/index.mjs');
const errorsOf = (results, id) => results.find(r => r.id === id).findings.filter(f => f.level === 'error');

test('插件约定：domain、rules[{id, title, check}]', () => {
  assert.equal(domain, 'baseline');
  assert.ok(rules.length >= 7);
  for (const r of rules) { assert.match(r.id, /^baseline\.[a-z-]+$/); assert.equal(typeof r.title, 'string'); assert.equal(typeof r.check, 'function'); }
});

test('本仓库：画面基线规则 0 个错误；单独运行 exit 0，--json 信封可解析，--help 无副作用', () => {
  const res = runRules(ROOT);
  const errs = res.flatMap(r => r.findings.filter(f => f.level === 'error').map(f => `${r.id} ${f.file || ''} ${f.message}`));
  assert.deepEqual(errs, []);
  const r = spawnSync(process.execPath, [RULE, '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.ok, true); assert.equal(j.exitCode, 0); assert.equal(j.command, 'repo-check:baseline');
  const h = spawnSync(process.execPath, [RULE, '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(h.status, 0); assert.match(h.stdout, /用法/);
  const bad = spawnSync(process.execPath, [RULE, '--nope', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.equal(JSON.parse(bad.stdout.trim()).error.code, 'usage');
});

// 搭一个最小仓库：复制集合定义、一份清单、审批记录、认可参照，再放一个假 media 文件和它的来源记录
function miniRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-rule-'));
  const cp = rel => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(d, rel)); };
  cp('tools/baseline/sets.json');
  cp('tools/baseline/determinism-allow.json');
  cp('tests/golden/manifests/darwin-metal/lab.json');
  cp('docs/style-baselines/beiming-original@v1/darwin-metal.json');
  cp('docs/style-baselines/beiming-original@v1/README.md');
  const lab = JSON.parse(fs.readFileSync(path.join(d, 'tests/golden/manifests/darwin-metal/lab.json'), 'utf8'));
  const ref = JSON.parse(fs.readFileSync(path.join(d, 'docs/style-baselines/beiming-original@v1/darwin-metal.json'), 'utf8'));
  const appr = [
    { at: 'x', kind: 'golden-baseline', set: 'lab', platformKey: 'darwin-metal', by: '测试', reason: '测试', commit: lab.source.commit, after: lab.framesDigest },
    { at: 'x', kind: 'style-reference', referenceId: 'beiming-original@v1', set: 'beiming-original-v1', platformKey: 'darwin-metal', by: '测试', reason: '测试', commit: ref.source.commit, after: ref.framesDigest },
  ];
  fs.writeFileSync(path.join(d, 'tests/golden/approvals.jsonl'), appr.map(a => JSON.stringify(a)).join('\n') + '\n');
  fs.mkdirSync(path.join(d, 'media'));
  fs.writeFileSync(path.join(d, 'media/a.bin'), 'media');
  const sha = crypto.createHash('sha256').update('media').digest('hex');
  fs.writeFileSync(path.join(d, 'docs/style-baselines/media-provenance.json'), JSON.stringify({ schema: 'beiming-media-provenance/v1', files: [{ path: 'media/a.bin', sha256: sha, sourceCommit: null, sourceState: '测试', command: 'echo', status: 'test' }] }));
  fs.mkdirSync(path.join(d, 'engine/core'), { recursive: true });
  fs.writeFileSync(path.join(d, 'engine/core/ok.js'), '// 只依赖参数\nexport const f = (t, seed) => Math.sin(t * seed);\n');
  return d;
}

test('最小仓库是干净的；逐条造错，各规则都抓得到', () => {
  const d = miniRepo();
  try {
    const clean = runRules(d).flatMap(r => r.findings.filter(f => f.level === 'error').map(f => `${r.id} ${f.message}`));
    assert.deepEqual(clean, [], '没造错之前应当 0 个错误');

    // 1 手改清单里一帧的哈希 → 清单摘要对不上
    const mf = path.join(d, 'tests/golden/manifests/darwin-metal/lab.json');
    const orig = fs.readFileSync(mf, 'utf8');
    const m = JSON.parse(orig); m.frames[0].pixelSha256 = 'f'.repeat(64);
    fs.writeFileSync(mf, JSON.stringify(m));
    assert.ok(errorsOf(runRules(d), 'baseline.manifests').some(e => /framesDigest/.test(e.message)));
    fs.writeFileSync(mf, orig);

    // 2 清单换了（摘要变了）却没有审批记录
    const m2 = JSON.parse(orig); m2.frames.pop(); m2.frameCount--;
    m2.framesDigest = digestOf(m2);   // 摘要自洽，只是没有审批记录
    fs.writeFileSync(mf, JSON.stringify(m2));
    assert.ok(errorsOf(runRules(d), 'baseline.approvals').some(e => /没有对应的审批记录/.test(e.message)));
    fs.writeFileSync(mf, orig);

    // 3 基线目录里入库了 PNG
    fs.writeFileSync(path.join(d, 'tests/golden/frame.png'), 'x');
    assert.equal(errorsOf(runRules(d), 'baseline.no-render-products').length, 1);
    fs.rmSync(path.join(d, 'tests/golden/frame.png'));

    // 4 media 文件换了、来源记录没更新；多一个没记录的 media 文件
    fs.writeFileSync(path.join(d, 'media/a.bin'), 'changed');
    fs.writeFileSync(path.join(d, 'media/b.bin'), 'new');
    const pe = errorsOf(runRules(d), 'baseline.media-provenance').map(e => e.message).join('\n');
    assert.match(pe, /旧的 sha256/); assert.match(pe, /没有这个文件的来源记录/);
    fs.writeFileSync(path.join(d, 'media/a.bin'), 'media'); fs.rmSync(path.join(d, 'media/b.bin'));

    // 5 认可参照缺 README、目录名不合规
    fs.renameSync(path.join(d, 'docs/style-baselines/beiming-original@v1/README.md'), path.join(d, 'x.md'));
    fs.mkdirSync(path.join(d, 'docs/style-baselines/bad-name'));
    const re = errorsOf(runRules(d), 'baseline.references').map(e => e.message).join('\n');
    assert.match(re, /缺 README/); assert.match(re, /<名>@v<版本>/);
    fs.renameSync(path.join(d, 'x.md'), path.join(d, 'docs/style-baselines/beiming-original@v1/README.md'));
    fs.rmdirSync(path.join(d, 'docs/style-baselines/bad-name'));

    // 6 新作品的渲染代码用了 Math.random
    fs.mkdirSync(path.join(d, 'films/x'), { recursive: true });
    fs.writeFileSync(path.join(d, 'films/x/main.js'), 'window.render = t => { const a = Math.random(); };\n');
    assert.ok(errorsOf(runRules(d), 'baseline.determinism-scan').some(e => /Math\.random/.test(e.message)));
    fs.rmSync(path.join(d, 'films'), { recursive: true });

    // 7 集合定义坏了
    fs.writeFileSync(path.join(d, 'tools/baseline/sets.json'), '{"schema": "nope"}');
    assert.equal(errorsOf(runRules(d), 'baseline.sets').length, 1);

    // 单独运行：有错误时 exit 4
    const r = spawnSync(process.execPath, [RULE, '--root', d, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 4, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim()).error.code, 'rule-violation');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// 与 tools/baseline/lib/manifest.mjs 的 framesDigest 同一公式（测试里直接算，免得测试依赖被测模块的私有细节）
function digestOf(m) {
  const lines = m.frames.map(f => `${f.id}\t${f.width}x${f.height}\t${f.pixelSha256}\n`).sort();
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}
