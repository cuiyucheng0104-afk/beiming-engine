// 仓库规范检查「画面基线」域（tools/repo-check/rules/baseline/）的测试：node --test tests/golden/repo-check-baseline.test.mjs
// 一律通过框架入口跑：node tools/repo-check.mjs --only baseline [--root <目录>] --json（与 CI、npm run check:repo 同一条路）。
// 正例：本仓库 baseline 域 0 个错误；反例：在系统临时目录搭一个最小仓库（不在 git 里，规则退回目录遍历），逐条造错，规则必须抓到。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHECK = path.join(ROOT, 'tools/repo-check.mjs');
const RULES = ['baseline.approvals', 'baseline.determinism-scan', 'baseline.manifests', 'baseline.media-provenance', 'baseline.no-render-products', 'baseline.references', 'baseline.sets'];

function check(root) {
  const r = spawnSync(process.execPath, [CHECK, '--only', 'baseline', ...(root ? ['--root', root] : []), '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  let j;
  assert.doesNotThrow(() => { j = JSON.parse(r.stdout); }, `--json 时 stdout 要是一个 JSON 对象：${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`);
  const mine = j.data.findings.filter(f => f.rule.startsWith('baseline.'));
  // 别的域的规则文件加载失败（core.loader）时整次检查退出 1，那不归本域管：这时只看本域的发现
  const foreign = j.data.findings.some(f => f.rule === 'core.loader' && !/rules\/baseline\//.test(f.file || ''));
  const expect = foreign ? 1 : mine.some(f => f.level === 'error') ? 4 : 0;
  return { code: r.status, expect, j, findings: mine, errors: id => mine.filter(f => f.rule === id && f.level === 'error') };
}

test('规则按框架约定加载：baseline 域 7 条，--list 列得出', () => {
  const r = spawnSync(process.execPath, [CHECK, '--list', '--json'], { cwd: ROOT, encoding: 'utf8' });
  const ids = JSON.parse(r.stdout).data.rules.filter(x => x.domain === 'baseline').map(x => x.id).sort();
  assert.deepEqual(ids, RULES);
});

test('本仓库：画面基线规则 0 个错误', () => {
  const { j, findings } = check(null);
  const ran = j.data.rules.map(x => x.id);
  for (const id of RULES) assert.ok(ran.includes(id), `${id} 没有运行`);
  assert.deepEqual(findings.filter(f => f.level === 'error').map(f => `${f.rule} ${f.file || ''} ${f.message}`), []);
});

// 最小仓库：集合定义、darwin-metal 的 lab 基线、审批记录、认可参照与它的关键帧登记（只有 keyframes.json，没有 PNG：PNG 不入库），
// 再放一个假 media 文件和它的来源记录
function miniRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-rule-'));
  const cp = rel => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.cpSync(path.join(ROOT, rel), path.join(d, rel), { recursive: true }); };
  cp('tools/baseline/sets.json');
  cp('tools/baseline/determinism-allow.json');
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/golden/darwin-metal/manifest.json'), 'utf8'));
  const lab = real.sets.lab;
  fs.mkdirSync(path.join(d, 'tests/golden/darwin-metal'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tests/golden/darwin-metal/manifest.json'), JSON.stringify({ ...real, sets: { lab } }, null, 1));
  cp('docs/style-baselines/beiming-original@v1');
  fs.rmSync(path.join(d, 'docs/style-baselines/beiming-original@v1/keyframes'), { recursive: true, force: true });   // 本机若有旧工具留下的 PNG，不带进来
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
    const refDir = path.join(d, 'docs/style-baselines/beiming-original@v1');
    assert.ok(fs.existsSync(path.join(refDir, 'keyframes.json')) && !fs.existsSync(path.join(refDir, 'keyframes')), '前提：关键帧登记在、PNG 不在');
    const clean = check(d);
    assert.deepEqual(clean.findings.filter(f => f.level === 'error').map(f => `${f.rule} ${f.message}`), [], '没造错之前应当 0 个错误（关键帧 PNG 不在不算错）');
    assert.equal(clean.code, clean.expect);
    const mf = path.join(d, 'tests/golden/darwin-metal/manifest.json');
    const orig = fs.readFileSync(mf, 'utf8');
    const edit = fn => { const j = JSON.parse(orig); fn(j); fs.writeFileSync(mf, JSON.stringify(j)); };

    // 1 手改清单里一帧的哈希 → 摘要对不上
    edit(j => { j.sets.lab.frames[0].pixelSha256 = 'f'.repeat(64); });
    let r = check(d);
    assert.equal(r.code, r.expect);
    assert.ok([1, 4].includes(r.code));
    assert.ok(r.errors('baseline.manifests').some(e => /framesDigest/.test(e.message)));

    // 2 清单换了（摘要自洽）却没有审批记录
    edit(j => { const m = j.sets.lab; m.frames.pop(); m.frameCount--; m.framesDigest = digestOf(m); });
    assert.ok(check(d).errors('baseline.approvals').some(e => /没有对应的审批记录/.test(e.message)));

    // 3 待审批的候选入了库 → 必须先 approve
    edit(j => { const m = j.sets.lab; m.status = 'candidate'; m.approval = null; m.source.pixelTree = 'a'.repeat(64); m.source.pixelPaths = ['engine']; });
    assert.ok(check(d).errors('baseline.manifests').some(e => /候选/.test(e.message) && /approve/.test(e.hint)));

    // 4 目录名不是平台键；清单里有本机绝对路径
    fs.writeFileSync(mf, orig);
    fs.mkdirSync(path.join(d, 'tests/golden/mac'));
    fs.writeFileSync(path.join(d, 'tests/golden/mac/manifest.json'), orig);
    edit(j => { j.sets.lab.env.note = '/Users/someone/x'; });
    r = check(d);
    assert.ok(r.errors('baseline.manifests').some(e => /不是平台键/.test(e.message)));
    assert.ok(r.errors('baseline.manifests').some(e => /本机绝对路径/.test(e.message)));
    fs.rmSync(path.join(d, 'tests/golden/mac'), { recursive: true });
    fs.writeFileSync(mf, orig);

    // 5 基线目录里入库了 PNG；风格基线目录里放了图；认可参照的关键帧 PNG 入了库（D10：同样不许）
    fs.writeFileSync(path.join(d, 'tests/golden/frame.png'), 'x');
    fs.writeFileSync(path.join(refDir, 'extra.jpg'), 'x');
    fs.mkdirSync(path.join(refDir, 'keyframes'));
    fs.writeFileSync(path.join(refDir, 'keyframes/wide.png'), 'x');
    const nr = check(d).errors('baseline.no-render-products');
    assert.equal(nr.length, 3);
    assert.ok(nr.some(e => /keyframes\/wide\.png$/.test(e.file) && /关键帧 PNG 入库/.test(e.message) && /golden\.mjs keyframes/.test(e.hint)));
    fs.rmSync(path.join(d, 'tests/golden/frame.png'));
    fs.rmSync(path.join(refDir, 'extra.jpg'));
    fs.rmSync(path.join(refDir, 'keyframes'), { recursive: true });

    // 6 media 文件换了、来源记录没更新；多一个没记录的 media 文件
    fs.writeFileSync(path.join(d, 'media/a.bin'), 'changed');
    fs.writeFileSync(path.join(d, 'media/b.bin'), 'new');
    const pe = check(d).errors('baseline.media-provenance').map(e => e.message).join('\n');
    assert.match(pe, /旧的 sha256/); assert.match(pe, /没有这个文件的来源记录/);
    fs.writeFileSync(path.join(d, 'media/a.bin'), 'media'); fs.rmSync(path.join(d, 'media/b.bin'));

    // 7 认可参照缺 README、目录名不合规
    fs.renameSync(path.join(d, 'docs/style-baselines/beiming-original@v1/README.md'), path.join(d, 'x.md'));
    fs.mkdirSync(path.join(d, 'docs/style-baselines/bad-name'));
    const re = check(d).errors('baseline.references').map(e => e.message).join('\n');
    assert.match(re, /缺 README/); assert.match(re, /<名>@v<版本>/);
    fs.renameSync(path.join(d, 'x.md'), path.join(d, 'docs/style-baselines/beiming-original@v1/README.md'));
    fs.rmdirSync(path.join(d, 'docs/style-baselines/bad-name'));

    // 8 关键帧登记：像素哈希被手改、帧编号不在参照里 → 错误；只写了名字与帧编号的草稿 → 提示（不算错）
    const kfFile = path.join(refDir, 'keyframes.json');
    const kfOrig = fs.readFileSync(kfFile, 'utf8');
    const editKf = fn => { const j = JSON.parse(kfOrig); fn(j); fs.writeFileSync(kfFile, JSON.stringify(j)); };
    editKf(j => { j.keyframes[0].pixelSha256 = '0'.repeat(64); j.keyframes[1].frame = 'film@1x1#t=0'; });
    const ke = check(d).errors('baseline.references').map(e => e.message).join('\n');
    assert.match(ke, /登记的像素哈希与认可参照清单/); assert.match(ke, /不在认可参照/);
    editKf(j => { delete j.platformKey; delete j.commit; j.keyframes = j.keyframes.map(k => ({ name: k.name, frame: k.frame })); });
    const draft = check(d);
    assert.equal(draft.errors('baseline.references').length, 0);
    assert.ok(draft.findings.some(f => f.rule === 'baseline.references' && f.level === 'warn' && /草稿/.test(f.message)));
    fs.writeFileSync(kfFile, kfOrig);

    // 9 新作品的渲染代码用了 Math.random
    fs.mkdirSync(path.join(d, 'films/x'), { recursive: true });
    fs.writeFileSync(path.join(d, 'films/x/main.js'), 'window.render = t => { const a = Math.random(); };\n');
    const de = check(d).errors('baseline.determinism-scan');
    assert.ok(de.some(e => /Math\.random/.test(e.message) && e.file === 'films/x/main.js' && e.line === 1));
    fs.rmSync(path.join(d, 'films'), { recursive: true });

    // 10 集合定义坏了
    fs.writeFileSync(path.join(d, 'tools/baseline/sets.json'), '{"schema": "nope"}');
    assert.equal(check(d).errors('baseline.sets').length, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// 与 tools/baseline/lib/manifest.mjs 的 framesDigest 同一公式（测试里直接算，免得测试依赖被测模块的私有细节）
function digestOf(m) {
  const lines = m.frames.map(f => `${f.id}\t${f.width}x${f.height}\t${f.pixelSha256}\n`).sort();
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}
