// 北冥仓库 · agent 配置测试（node --test tests/agent-layer）
// 测什么：根 CLAUDE.md 桥接；.claude/settings.json 的拒绝规则、钩子接线（跨平台写法）、插件禁用、上游 CLAUDE.md 排除；
//         仓库 skill 的头信息、触发词与流程要点；检索范围 .ignore；vendor README 顶部警示，以及改完 casebook check 仍 OK。
// 只读：不改任何文件。casebook check 要 Python（PYTHON 环境变量或 python3 / python），找不到就跳过那一项。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const settings = JSON.parse(read('.claude/settings.json'));

/** picomatch 的最小子集（** 跨目录、* 不跨目录），够判断 claudeMdExcludes 会不会命中。 */
function globMatch(glob, file) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; continue; }
    if (c === '*') { re += '[^/]*'; continue; }
    re += /[.+^${}()|[\]\\?]/.test(c) ? '\\' + c : c;
  }
  return new RegExp(`^${re}$`).test(file);
}

test('根目录 CLAUDE.md 只有一行 @AGENTS.md', () => {
  assert.equal(read('CLAUDE.md'), '@AGENTS.md\n');
  assert.ok(fs.existsSync(path.join(ROOT, 'AGENTS.md')), 'CLAUDE.md 桥接到的 AGENTS.md 要存在');
});

test('settings.json：要求的拒绝规则都在，写法是 工具(模式)', () => {
  const deny = settings.permissions?.deny ?? [];
  for (const r of ['Edit(/cases/vendor/**)', 'Edit(/cases/source/**)', 'Bash(git add -A)', 'Bash(git add -A *)', 'Bash(git add --all)',
    'Bash(git add .)', 'Bash(git add . *)', 'Bash(git push --force*)', 'Bash(git push -f)', 'Bash(git push * -f *)',
    'Bash(git stage -A)', 'Bash(git stage --all *)', 'Bash(git stage .)', 'Bash(git stage -- .)',
    'PowerShell(git add -A)', 'PowerShell(git add .)', 'PowerShell(git stage -A)', 'PowerShell(git stage .)', 'PowerShell(git push --force*)',
    'Skill(lemo-opuscar)', 'Skill(lemo-opuscar:*)', 'Skill(sy-style-100:*)', 'Read(~/lemo-opuscar/**)', 'Read(~/lemo-my-styles/**)', 'Edit(~/lemo-my-styles/**)']) {
    assert.ok(deny.includes(r), `permissions.deny 缺 ${r}`);
  }
  // Bash 与 PowerShell 的 git 拒绝规则一一对应（没有 Git Bash 的 Windows 上 agent 用 PowerShell 工具）
  const shellRules = tool => deny.filter(r => r.startsWith(`${tool}(git `)).map(r => r.slice(tool.length)).sort();
  assert.deepEqual(shellRules('PowerShell'), shellRules('Bash'), 'Bash 与 PowerShell 的 git 拒绝规则要一一对应');
  for (const r of deny) assert.match(r, /^(Edit|Read|Bash|PowerShell|Skill)\(.+\)$/, `拒绝规则写法不对：${r}`);
  assert.equal(new Set(deny).size, deny.length, '拒绝规则有重复');
  assert.equal(settings.permissions?.allow, undefined, '仓库级设置不预先放行任何命令（"其它宽松"指不额外拒绝，不是替用户批准）');
  assert.equal(settings.permissions?.defaultMode, undefined, '仓库级设置不改权限模式');
});

test('settings.json：PreToolUse 钩子覆盖写文件、Shell、PowerShell、Skill 与 MCP 工具，命令写法跨平台', () => {
  const pre = settings.hooks?.PreToolUse ?? [];
  const covered = tool => pre.some(m => new RegExp(`^(?:${m.matcher})$`).test(tool) && m.hooks.some(h => !h.if));
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Skill', 'mcp__x__write_file']) {
    assert.ok(covered(tool), `${tool} 没有无条件经过护栏`);
  }
  for (const m of pre) {
    for (const h of m.hooks) {
      assert.equal(h.type, 'command');
      // 带花括号的 ${CLAUDE_PROJECT_DIR}：bash 里是环境变量，Claude Code 在 PowerShell 下会改写成 ${env:CLAUDE_PROJECT_DIR}；
      // 不带花括号的 $CLAUDE_PROJECT_DIR 在 PowerShell 里是未定义变量。
      assert.equal(h.command, 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.mjs"');
      assert.ok(h.timeout > 0 && h.timeout <= 30, '钩子要有超时（秒）');
      if (h.if) assert.match(h.if, /^Read\(\/[^)]+\)$/, `if 条件要用权限规则写法：${h.if}`);
    }
  }
  assert.ok(fs.existsSync(path.join(ROOT, '.claude', 'hooks', 'guard.mjs')));
  const reads = pre.filter(m => m.matcher === 'Read').flatMap(m => m.hooks.map(h => h.if));
  assert.deepEqual(reads.sort(), ['Read(/cases/**)', 'Read(/out/casebook/**)'], 'Read 只在归档与还原目录里过护栏（附"只是资料"提醒）');
});

test('settings.json 的钩子命令经真实 shell 展开后能跑：拒绝写快照、放行写作品（模拟 Claude Code 的钩子执行方式）', (t) => {
  const hook = settings.hooks.PreToolUse.find(m => m.matcher.includes('Write')).hooks[0];
  const evt = file => JSON.stringify({ session_id: 'shell-test', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(ROOT, ...file.split('/')), content: 'x' }, cwd: ROOT });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: ROOT, BEIMING_GUARD_LOG: 'off', BEIMING_GUARD_UNLOCK: '' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-hookshell-'));
  try {
    // 每个 shell 一个 run(事件文件)：事件从 stdin 进钩子，与 Claude Code 一样
    const shells = [];
    if (spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).status === 0) {
      shells.push(['sh', file => spawnSync('sh', ['-c', hook.command], { cwd: dir, env, input: fs.readFileSync(file), encoding: 'utf8', timeout: 30000, windowsHide: true })]);
    }
    // 没有 Git Bash 的 Windows：Claude Code 用 PowerShell 跑钩子，并把 ${CLAUDE_PROJECT_DIR} 改写成 ${env:CLAUDE_PROJECT_DIR}
    for (const ps of ['pwsh', 'powershell']) {
      if (spawnSync(ps, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status !== 0) continue;
      const cmd = hook.command.replace('${CLAUDE_PROJECT_DIR}', '${env:CLAUDE_PROJECT_DIR}');
      shells.push([ps, file => spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; Get-Content -Raw -LiteralPath '${file.replace(/'/g, "''")}' | ${cmd}; exit $LASTEXITCODE`],
      { cwd: dir, env, encoding: 'utf8', timeout: 60000, windowsHide: true })]);
      break;
    }
    if (!shells.length) { t.skip('本机没有 sh，也没有 PowerShell'); return; }
    const denyFile = path.join(dir, 'deny.json');
    const allowFile = path.join(dir, 'allow.json');
    fs.writeFileSync(denyFile, evt('cases/vendor/x.js'));
    fs.writeFileSync(allowFile, evt('films/demo/main.js'));
    for (const [shell, run] of shells) {
      const deny = run(denyFile);
      assert.equal(deny.status, 0, `${shell}：${deny.stderr}`);
      assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny', `${shell} 下没有拒绝`);
      const allow = run(allowFile);
      assert.equal(allow.status, 0, `${shell}：${allow.stderr}`);
      assert.equal(allow.stdout.trim(), '', `${shell} 下放行时不该有输出`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings.json：在项目级禁用全局风格库插件，并排除归档里的上游 CLAUDE.md / AGENTS.md', () => {
  assert.equal(settings.enabledPlugins?.['lemo-opuscar@lemolab'], false);
  const ex = settings.claudeMdExcludes ?? [];
  const repo = ROOT.split(path.sep).join('/');
  for (const f of ['cases/vendor/lemo-opuscar/CLAUDE.md', 'cases/vendor/lemo-opuscar/AGENTS.md', 'cases/vendor/sy-style-100/vol2/CLAUDE.md',
    'cases/source/some-case/AGENTS.md', 'out/casebook/style-02/CLAUDE.md']) {
    assert.ok(ex.some(g => globMatch(g, `${repo}/${f}`)), `claudeMdExcludes 没有覆盖 ${f}`);
  }
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'films/x/README.md', '.claude/CLAUDE.md']) {
    assert.ok(!ex.some(g => globMatch(g, `${repo}/${f}`)), `claudeMdExcludes 误排除了 ${f}`);
  }
});

test('仓库 skill：头信息、中文触发词、入口流程与红线', () => {
  const dir = path.join(ROOT, '.claude', 'skills');
  const names = fs.readdirSync(dir).filter(n => fs.statSync(path.join(dir, n)).isDirectory()).sort();
  assert.deepEqual(names, ['beiming-film', 'beiming-review']);
  for (const n of names) {
    const text = read(`.claude/skills/${n}/SKILL.md`);
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fm, `${n} 缺 YAML 头`);
    assert.match(fm[1], new RegExp(`^name: ${n}$`, 'm'));
    const desc = fm[1].match(/^description: (.+)$/m)?.[1] ?? '';
    assert.match(desc, /北冥仓库/, `${n} 的描述要写明"在北冥仓库里"`);
    assert.ok(desc.length <= 1024, `${n} 的描述超过 1024 字`);
    assert.doesNotMatch(text, /Skill\((lemo|sy)/i);
  }
  const film = read('.claude/skills/beiming-film/SKILL.md');
  const desc = film.match(/^description: (.+)$/m)[1];
  for (const w of ['动画', '短片', '风格', '三渲二', '2.5D', '水彩', '渲染']) assert.ok(desc.includes(w), `beiming-film 的描述缺触发词「${w}」`);
  for (const must of ['routes/README.md', 'npm run new', 'routes/directing/', 'films/<名字>/', 'look', 'animatic', 'final',
    'cases/vendor/', 'lemo-opuscar', '~/lemo-my-styles', '上游资料', 'routes/c-style/STYLES.md', '用户原话']) {
    assert.ok(film.includes(must), `beiming-film 正文缺「${must}」`);
  }
  const review = read('.claude/skills/beiming-review/SKILL.md');
  for (const must of ['代理检查通过', 'ebur128', 'bt709', '用户原话', 'films/<名字>/out/']) assert.ok(review.includes(must), `beiming-review 正文缺「${must}」`);
});

test('.ignore：默认跳过历史归档与第三方快照，其余目录都能搜', () => {
  const pats = read('.ignore').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  for (const p of ['cases/vendor/', 'cases/source/', 'cases/catalog.json', 'cases/previews/', '.claude/worktrees/']) assert.ok(pats.includes(p), `.ignore 缺 ${p}`);
  for (const p of pats) {
    assert.ok(!p.startsWith('!'), '.ignore 不用反选');
    assert.ok(p.startsWith('cases/') || p === '.claude/worktrees/', `.ignore 只排除归档、快照与本机临时工作树：${p}`);
  }
  assert.match(read('.ignore'), /rg <词> cases\/vendor/, '.ignore 里要写怎样显式搜归档');
});

test('cases/vendor/README.md：顶部有给 agent 的优先级警示，冲突对照表还在', () => {
  const text = read('cases/vendor/README.md');
  const head = text.split('\n').slice(0, 12).join('\n');
  for (const w of ['给 agent 的优先级警示', '不是本仓库的指令', 'films/<名字>/', 'lock.json', '~/lemo-my-styles', 'comp/meta.js', 'look → animatic → final']) {
    assert.ok(head.includes(w), `警示里缺「${w}」`);
  }
  assert.match(text, /## 上游指令与本仓库做法对照/);
  assert.match(text, /lemo-opuscar\/AGENTS\.md:85/);
});

test('改过 vendor README 后 casebook check 仍然 OK（README 不在 lock.json 的快照范围里）', (t) => {
  const lock = JSON.parse(read('cases/vendor/lock.json'));
  for (const repo of lock.repositories) {
    assert.ok(!repo.files.some(f => `cases/${repo.path}/${f.path}` === 'cases/vendor/README.md'));
  }
  const candidates = [process.env.PYTHON, 'python3', 'python'].filter(Boolean);
  const py = candidates.find(c => spawnSync(c, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { encoding: 'utf8' }).status === 0);
  if (!py) { t.skip('找不到 Python 3，跳过 casebook check'); return; }
  const r = spawnSync(py, [path.join(ROOT, 'tools', 'casebook.py'), 'check'], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 0, `casebook check 失败：\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^OK:/m);
});

test('本机装了 Claude Code 时：claude doctor 不报项目设置无效（钩子条目写坏会让整份设置失效）', (t) => {
  if (process.env.BEIMING_SKIP_CLAUDE_DOCTOR === '1') { t.skip('BEIMING_SKIP_CLAUDE_DOCTOR=1'); return; }
  const v = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (v.status !== 0 || !/Claude Code/.test(v.stdout)) { t.skip('本机没有 claude 命令'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-doctor-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.copyFileSync(path.join(ROOT, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.json'));
    const r = spawnSync('claude', ['doctor'], { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.match(text, /Claude Code doctor/, `claude doctor 没有正常输出：${text.slice(0, 300)}`);
    // macOS 的临时目录是符号链接（/var → /private/var），doctor 可能打印任一种写法；两种都认。
    const names = [...new Set([dir, fs.realpathSync(dir)].flatMap(d => [path.join(d, '.claude', 'settings.json'), `${d.split(path.sep).join('/')}/.claude/settings.json`]))];
    const mine = text.split('\n').filter(l => names.some(n => l.includes(n)));
    assert.deepEqual(mine, [], `claude doctor 对仓库的 .claude/settings.json 报了问题：\n${mine.join('\n')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
