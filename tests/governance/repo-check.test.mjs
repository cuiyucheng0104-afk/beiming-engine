// 仓库规范检查（tools/repo-check.mjs）的治理测试：
//   1. 按真实的 routes/routes.json 在临时目录里搭一个全部合格的小仓库，core 全部规则 exit 0；
//   2. tests/governance/fixtures/violations.json 里的每种违规：--only <规则> 报出该规则 id 的错误，exit 4，--json 信封可解析；
//   3. 本仓库：每条 core 规则都至少有一个违规夹具；--list 列出全部 core 规则；用法错误 exit 2；限期豁免与 --strict 的行为。
// 小仓库里的 AGENTS.md、CLAUDE.md 只在测试时生成（不入库：入库的嵌套指令文件会被 agent 当成真指令）。
//   node --test tests/governance
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = path.join(ROOT, 'tools/repo-check.mjs');
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/governance/fixtures/violations.json'), 'utf8')).cases;
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const SECTIONS = ['这条路线是什么', '最快上手', '一部作品的目录', '能力清单', '契约', '验收', '边界与常见坑', '参考作品'];

/** 一个 core 规则全部合格的小仓库：注册表照抄真实的，手册、模版、渲染器入口按注册表补齐。 */
function cleanRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-gov-'));
  made.push(dir);
  const w = (rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes/routes.json'), 'utf8'));
  w('routes/routes.json', `${JSON.stringify(reg, null, 2)}\n`);
  w('package.json', `${JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { new: 'node tools/new-film.mjs', 'check:repo': 'node tools/repo-check.mjs' } }, null, 2)}\n`);
  w('tools/new-film.mjs', '// 夹具占位：新建作品\n');
  w('tools/repo-check.mjs', '// 夹具占位：仓库规范检查\n');
  for (const r of Object.values(reg.renderers)) {
    if (/\.(mjs|js)$/.test(r.entry)) w(r.entry, `// 夹具占位：${r.title}\nexport {};\n`);
    else w(`${r.entry}/page.mjs`, `// 夹具占位：${r.title}\nexport {};\n`);
  }
  for (const r of reg.routes) {
    const body = SECTIONS.map(s => (s === '最快上手' ? `## ${s}\n\n\`\`\`sh\nnpm run new -- ${r.id} my-film --title 试映\n\`\`\`\n` : `## ${s}\n\n夹具内容。\n`)).join('\n');
    w(r.manual, `# ${r.label}\n\n${body}`);
    w(`${r.template}/film.json`, `${JSON.stringify({ route: r.id, title: '{{TITLE}}', dur: 3, fps: 24, size: [1920, 1080] }, null, 2)}\n`);
    w(`${r.template}/README.md`, `# {{TITLE}}\n\n夹具模版：${r.label}，复制到 films/{{NAME}}/。\n`);
  }
  w('routes/README.md', `# 三条路线 · 总指引\n\n## 选路线\n\n| 需求 | 路线 |\n|---|---|\n${reg.routes.map(r => `| ${r.chooseWhen} | [${r.label}](${r.slug}/README.md) |`).join('\n')}\n`);
  w('AGENTS.md', '# 夹具仓库入口\n\n先读[三条路线总指引](routes/README.md)。\n');
  w('CLAUDE.md', '@AGENTS.md\n');
  return dir;
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[/^\d+$/.test(k) ? Number(k) : k];
  o[keys.at(-1)] = value;
}

/** 按夹具描述改小仓库。 */
function mutate(dir, c) {
  const f = rel => path.join(dir, ...rel.split('/'));
  for (const [rel, text] of Object.entries(c.write ?? {})) { fs.mkdirSync(path.dirname(f(rel)), { recursive: true }); fs.writeFileSync(f(rel), text); }
  for (const [rel, text] of Object.entries(c.append ?? {})) fs.appendFileSync(f(rel), text);
  for (const [rel, [text, n]] of Object.entries(c.appendRepeat ?? {})) fs.appendFileSync(f(rel), text.repeat(n));
  for (const [rel, pairs] of Object.entries(c.replace ?? {})) {
    let s = fs.readFileSync(f(rel), 'utf8');
    for (const [from, to] of pairs) { assert.ok(s.includes(from), `夹具 ${c.title}：${rel} 里找不到「${from}」`); s = s.replace(from, to); }
    fs.writeFileSync(f(rel), s);
  }
  for (const rel of c.remove ?? []) fs.rmSync(f(rel), { recursive: true, force: true });
  for (const [rel, pairs] of Object.entries(c.patch ?? {})) {
    const j = JSON.parse(fs.readFileSync(f(rel), 'utf8'));
    for (const [dotted, value] of pairs) setPath(j, dotted, value);
    fs.writeFileSync(f(rel), `${JSON.stringify(j, null, 2)}\n`);
  }
  if (c.git) {
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0, '夹具要 git');
    git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture'); git('config', 'commit.gpgsign', 'false');
    git('add', '-A'); git('commit', '-qm', 'fixture');
  }
}

function check(args) {
  const r = spawnSync(process.execPath, [CHECK, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  let json = null;
  if (args.includes('--json')) json = JSON.parse(r.stdout);
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

const hasGit = spawnSync('git', ['--version']).status === 0;

test('合格的小仓库：core 全部规则通过（exit 0）', () => {
  const dir = cleanRepo();
  const r = check(['--root', dir, '--only', 'core', '--json']);
  assert.equal(r.code, 0, JSON.stringify(r.json?.data?.findings?.filter(f => f.level === 'error'), null, 2));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.summary.errors, 0);
});

for (const c of CASES) {
  test(`${c.rule}：${c.title}`, { skip: c.git && !hasGit ? '没有 git' : false }, () => {
    const dir = cleanRepo();
    mutate(dir, c);
    const r = check(['--root', dir, '--only', c.only ?? c.rule, '--json']);
    assert.equal(r.code, 4, `应以 4（契约不通过）退出：${r.err}`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'contract.repo-check');
    const errs = r.json.data.findings.filter(f => f.rule === c.rule && f.level === 'error');
    assert.ok(errs.length, `应报出 ${c.rule} 的错误，实际：${JSON.stringify(r.json.data.findings, null, 2)}`);
    assert.ok(errs.some(f => `${f.message}\n${f.excerpt ?? ''}`.includes(c.expect)), `${c.rule} 的错误里应有「${c.expect}」：${errs.map(f => f.message).join(' / ')}`);
    for (const f of errs) {
      assert.ok(f.message && typeof f.message === 'string');
      assert.ok(f.file === null || !path.isAbsolute(f.file), '报告里的路径是仓库相对路径');
    }
  });
}

test('每条 core 规则都至少有一个违规夹具；--list 列出它们', () => {
  const r = check(['--list', '--json']);
  assert.equal(r.code, 0);
  const core = r.json.data.rules.filter(x => x.domain === 'core').map(x => x.id);
  const covered = new Set(CASES.map(c => c.rule));
  assert.deepEqual(core.filter(id => !covered.has(id)), [], '新加的 core 规则要在 tests/governance/fixtures/violations.json 里补一个违规夹具');
  assert.ok(core.length >= 17);
});

test('用法错误 exit 2：未知的域或规则给出建议；--root 不是目录', () => {
  const r = check(['--only', 'core.link', '--json']);
  assert.equal(r.code, 2);
  assert.equal(r.json.error.code, 'usage.unknown-rule');
  assert.match(r.json.error.hint, /core\.links/);
  assert.equal(check(['--root', path.join(os.tmpdir(), 'no-such-dir-beiming'), '--json']).code, 2);
  assert.equal(check(['--no-such-flag']).code, 2);
});

test('限期豁免：命中的错误降为提示并标出属主，--strict 不降；不再命中的豁免要提示删掉', () => {
  const dir = cleanRepo();
  mutate(dir, { append: { 'AGENTS.md': '\n本仓库有两条路线。\n' } });
  const w = rel => path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(w('tools/repo-check/core/waivers.json')), { recursive: true });
  fs.writeFileSync(w('tools/repo-check/core/waivers.json'), JSON.stringify({ waivers: [
    { rule: 'core.terms', file: 'AGENTS.md', match: '两条路线', owner: 'PZ', reason: '根文档整合时改' },
    { rule: 'core.terms', file: 'ROUTES.md', owner: 'PZ', reason: '已经修好的旧问题' },
  ] }));
  const loose = check(['--root', dir, '--only', 'core.terms', '--json']);
  assert.equal(loose.code, 0, loose.err);
  const waived = loose.json.data.findings.find(f => f.rule === 'core.terms');
  assert.equal(waived.level, 'warn');
  assert.deepEqual(waived.waived, { owner: 'PZ', reason: '根文档整合时改' });
  assert.ok(loose.json.data.findings.some(f => f.rule === 'core.waivers' && /豁免不再命中/.test(f.message)), '过期豁免要提示');
  const strict = check(['--root', dir, '--only', 'core.terms', '--strict', '--json']);
  assert.equal(strict.code, 4);
});

test('本仓库：core 规则全部通过（存量问题有限期豁免）', () => {
  const r = check(['--only', 'core', '--json']);
  assert.equal(r.code, 0, JSON.stringify(r.json?.data?.findings?.filter(f => f.level === 'error'), null, 2));
});
