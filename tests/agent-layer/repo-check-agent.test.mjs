// 北冥仓库 · 规范检查 agent 规则测试（node --test tests/agent-layer）
// 测什么：tools/repo-check/rules/agent/ 在真实仓库上全过；每条规则在对应的违规夹具上给出自己的规则 id；
//         单独入口 run.mjs 的 --help / --list / --only / --json / 退出码符合附录 C1、C2。
// 夹具建在系统临时目录，结束时删掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rules, runAgentRules, isInstructionFile, domain } from '../../tools/repo-check/rules/agent/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN = path.join(ROOT, 'tools', 'repo-check', 'rules', 'agent', 'run.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-agent-rules-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let seq = 0;

function put(dir, rel, content) {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}
const copy = (dir, rel) => put(dir, rel, fs.readFileSync(path.join(ROOT, ...rel.split('/'))));

/** 一个能让全部 agent 规则通过的最小夹具（不是 git 仓库，文件清单显式传给规则）。 */
function fixture() {
  const dir = path.join(TMP, `fx-${++seq}`);
  for (const rel of ['.claude/settings.json', '.claude/hooks/guard.mjs', '.ignore', 'cases/vendor/README.md',
    'tools/repo-check/rules/agent/instruction-files.json', '.githooks/pre-commit', '.githooks/pre-commit.mjs']) copy(dir, rel);
  fs.chmodSync(path.join(dir, '.githooks', 'pre-commit'), 0o755);
  put(dir, 'AGENTS.md', '# 规则\n');
  put(dir, 'CLAUDE.md', '@AGENTS.md\n');
  put(dir, '.claude/skills/beiming-film/SKILL.md', '---\nname: beiming-film\ndescription: 在北冥仓库里做动画、短片与风格化渲染时的入口流程\n---\n\n读 `AGENTS.md`。\n');
  put(dir, 'cases/vendor/demo/a.txt', 'x');
  put(dir, 'cases/vendor/lock.json', JSON.stringify({ version: 1, repositories: [{ name: 'demo', path: 'vendor/demo', files: [{ path: 'a.txt', gitBlob: '0', sha256: '0', size: 1 }] }] }));
  const wl = { schemaVersion: 1, files: ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.claude/skills/beiming-film/SKILL.md'].map(p => ({ path: p, role: 'x' })) };
  put(dir, 'tools/repo-check/rules/agent/instruction-files.json', JSON.stringify(wl));
  return dir;
}
const files = dir => {
  const out = [];
  const walk = (sub) => {
    for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel); else out.push(rel);
    }
  };
  walk('');
  return out;
};
const check = (dir, only) => runAgentRules({ root: dir, files: files(dir) }, { only });
const ids = findings => [...new Set(findings.filter(f => f.level === 'error').map(f => f.rule))].sort();

test('插件接口：domain、rules[{id,title,severity,run,check}]、默认导出', async () => {
  assert.equal(domain, 'agent');
  for (const r of rules) {
    assert.match(r.id, /^agent\.[a-z-]+$/);
    assert.ok(r.title && typeof r.run === 'function' && r.check === r.run && r.severity === 'error');
  }
  const mod = await import('../../tools/repo-check/rules/agent/index.mjs');
  assert.equal(mod.default, rules);
});

test('真实仓库：agent 规则全部通过', () => {
  const findings = runAgentRules(ROOT);
  assert.deepEqual(findings, [], findings.map(f => `${f.rule}：${f.message}`).join('\n'));
});

test('最小夹具全部通过（夹具本身是对的）', () => {
  assert.deepEqual(check(fixture()), []);
});

test('agent.instruction-files：子目录指令文件与白名单不一致', () => {
  const dir = fixture();
  put(dir, 'films/demo/AGENTS.md', '# x\n');
  put(dir, 'engine/core/CLAUDE.md', '@AGENTS.md\n');
  put(dir, 'routes/x/.claude-plugin/plugin.json', '{}');
  fs.rmSync(path.join(dir, '.claude', 'skills', 'beiming-film'), { recursive: true });
  const f = check(dir, ['agent.instruction-files']);
  assert.deepEqual(ids(f), ['agent.instruction-files']);
  const msg = f.map(x => x.message).join('\n');
  for (const p of ['films/demo/AGENTS.md', 'engine/core/CLAUDE.md', 'routes/x/.claude-plugin/plugin.json']) assert.match(msg, new RegExp(p.replace(/\./g, '\\.')));
  assert.match(msg, /白名单登记了 \.claude\/skills\/beiming-film\/SKILL\.md/);
  for (const [p, want] of [['a/AGENTS.md', true], ['a/agents.md', true], ['x/SKILL.md', true], ['x/DIRECTOR.md', true], ['.claude/settings.local.json', true],
    ['.claude/commands/x.md', true], ['.mcp.json', true], ['x/README.md', false], ['films/x/main.js', false], ['.claude/hooks/README.md', false]]) {
    assert.equal(isInstructionFile(p), want, p);
  }
});

test('agent.vendor-films 与 agent.vendor-inventory：快照里的作品目录、产物与多出的文件', () => {
  const dir = fixture();
  put(dir, 'cases/vendor/demo/films/my-film/index.html', '<html>');
  put(dir, 'cases/vendor/demo/out/a.mp4', 'x');
  put(dir, 'cases/vendor/demo/NEW.md', 'x');
  put(dir, 'cases/vendor/demo/.DS_Store', 'x');
  const f = check(dir, ['agent.vendor-films', 'agent.vendor-inventory']);
  assert.deepEqual(ids(f), ['agent.vendor-films', 'agent.vendor-inventory']);
  const inv = f.filter(x => x.rule === 'agent.vendor-inventory').map(x => x.message).join('\n');
  assert.match(inv, /films\//);
  assert.match(inv, /NEW\.md/);
  assert.doesNotMatch(inv, /DS_Store/, '系统杂项文件不报');
});

test('agent.claude-bridge：缺失或多写了规则', () => {
  const dir = fixture();
  put(dir, 'CLAUDE.md', '@AGENTS.md\n另一套规则\n');
  assert.deepEqual(ids(check(dir, ['agent.claude-bridge'])), ['agent.claude-bridge']);
  fs.rmSync(path.join(dir, 'CLAUDE.md'));
  assert.deepEqual(ids(check(dir, ['agent.claude-bridge'])), ['agent.claude-bridge']);
});

test('agent.guard-config：拒绝规则、钩子接线、插件禁用、排除项缺一不可', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const mutate = [
    s => { s.permissions.deny = s.permissions.deny.filter(r => r !== 'Bash(git add -A)'); },
    s => { s.hooks.PreToolUse = s.hooks.PreToolUse.filter(m => m.matcher === 'Read'); },
    s => { s.enabledPlugins = {}; },
    s => { s.claudeMdExcludes = []; },
  ];
  for (const m of mutate) {
    const dir = fixture();
    const s = structuredClone(base);
    m(s);
    put(dir, '.claude/settings.json', JSON.stringify(s));
    assert.deepEqual(ids(check(dir, ['agent.guard-config'])), ['agent.guard-config']);
  }
  const dir = fixture();
  put(dir, '.claude/settings.json', '{ 坏 JSON');
  assert.match(check(dir, ['agent.guard-config'])[0].message, /不是合法 JSON/);
});

test('agent.skills：缺 YAML 头、名字与目录不符、引用的路径不存在', () => {
  const dir = fixture();
  put(dir, '.claude/skills/beiming-film/SKILL.md', '---\nname: other\ndescription: 太短\n---\n读 `routes/nope.md`。\n');
  const msg = check(dir, ['agent.skills']).map(x => x.message).join('\n');
  assert.match(msg, /应与目录名 beiming-film 相同/);
  assert.match(msg, /description 太短/);
  assert.match(msg, /routes\/nope\.md 不存在/);
});

test('agent.search-scope：.ignore 缺排除项，或把该搜的目录也排除了', () => {
  const dir = fixture();
  put(dir, '.ignore', 'cases/source/\nengine/\n');
  const msg = check(dir, ['agent.search-scope']).map(x => x.message).join('\n');
  assert.match(msg, /没有排除 cases\/vendor/);
  assert.match(msg, /engine/);
  fs.rmSync(path.join(dir, '.ignore'));
  assert.deepEqual(ids(check(dir, ['agent.search-scope'])), ['agent.search-scope']);
});

test('agent.githooks：缺文件、CRLF、首行不是 sh', () => {
  const dir = fixture();
  put(dir, '.githooks/pre-commit', '#!/bin/sh\r\nexec node x\r\n');
  assert.match(check(dir, ['agent.githooks']).map(x => x.message).join('\n'), /CRLF/);
  put(dir, '.githooks/pre-commit', 'node x\n');
  assert.match(check(dir, ['agent.githooks']).map(x => x.message).join('\n'), /第一行/);
  fs.rmSync(path.join(dir, '.githooks'), { recursive: true });
  assert.match(check(dir, ['agent.githooks'])[0].message, /缺 \.githooks\/pre-commit/);
});

test('agent.vendor-warning：vendor README 顶部没有优先级警示', () => {
  const dir = fixture();
  put(dir, 'cases/vendor/README.md', '# 完整风格基座快照\n\n说明。\n');
  assert.deepEqual(ids(check(dir, ['agent.vendor-warning'])), ['agent.vendor-warning']);
});

test('run.mjs：--help 与 --list exit 0、--only 未知规则 exit 2、违规 exit 4、--json 是统一信封', () => {
  const run = (args) => spawnSync(process.execPath, [RUN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agent\.instruction-files/);
  assert.equal(run(['--list']).status, 0);
  const list = JSON.parse(run(['--list', '--json']).stdout);
  assert.equal(list.rules.length, rules.length);
  const bad = run(['--only', 'agent.nope', '--json']);
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error.code, 'usage');
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(run(['--root']).status, 2);
  assert.equal(run(['--root', path.join(TMP, 'missing')]).status, 3);
  const ok = run(['--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const o = JSON.parse(ok.stdout);
  for (const k of ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings', 'findings']) assert.ok(k in o, `信封缺 ${k}`);
  const dir = fixture();
  put(dir, 'films/demo/AGENTS.md', '# x\n');
  const v = run(['--root', dir, '--json']);
  assert.equal(v.status, 4);
  assert.ok(JSON.parse(v.stdout).findings.some(f => f.rule === 'agent.instruction-files'));
});
