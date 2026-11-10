// 北冥仓库 · agent 护栏判定测试（node --test tests/agent-layer）
// 测什么：.claude/hooks/lib/decide.mjs 对每类工具调用的放行 / 拒绝，规则 id 要对，拒绝理由要带"下一步"。
// 用假的家目录（不存在的临时路径），不读写真实家目录；只有符号链接一例会在系统临时目录建链接并在结束时删掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../../.claude/hooks/lib/decide.mjs';
import { RULES, ZONES, ALWAYS_DENY_RULES, isHomeRuntime } from '../../.claude/hooks/lib/policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME = path.join(os.tmpdir(), 'beiming-guard-test-home-does-not-exist');
const R = (...p) => path.join(ROOT, ...p);
const H = (...p) => path.join(HOME, ...p);
const POSIX_HOME = HOME.split(path.sep).join('/');

function run(tool, input, { env = {}, cwd = ROOT, root = ROOT, home = HOME, platform } = {}) {
  return decide({ tool_name: tool, tool_input: input, cwd }, { root, home, env, platform });
}
const bash = (command, opts) => run('Bash', { command }, opts);
const pwsh = (command, opts) => run('PowerShell', { command }, opts);
const write = (file_path, opts) => run('Write', { file_path, content: 'x' }, opts);

function expectDeny(d, rule, label) {
  assert.equal(d.decision, 'deny', `${label}：应拒绝，实际放行${d.context ? '（附提醒）' : ''}`);
  assert.equal(d.rule, rule, `${label}：规则应为 ${rule}，实际 ${d.rule}`);
  assert.match(d.reason, /北冥护栏拒绝/, `${label}：理由要以"北冥护栏拒绝"开头`);
  assert.match(d.reason, /下一步：\S/, `${label}：理由要给出下一步`);
}
function expectAllow(d, label) {
  assert.equal(d.decision, 'allow', `${label}：应放行，实际拒绝：${d.reason ?? ''}`);
}

test('写文件工具：受保护区域拒绝，作品目录放行', () => {
  const deny = [
    [R('cases', 'vendor', 'lemo-opuscar', 'AGENTS.md'), 'zone-vendor'],
    [R('cases', 'vendor', 'lemo-opuscar', 'films', 'my-film', 'index.html'), 'zone-vendor'],
    [R('cases', 'source', 'style-02-watercolor', 'main.js'), 'zone-source'],
    [R('src', 'main.js'), 'zone-src'],
    [R('LICENSE'), 'zone-license'],
    [R('cases', 'licenses', 'MIT.txt'), 'zone-license'],
    [R('LICENSES', 'MIT.txt'), 'zone-license'],
    [R('cases', 'catalog.json'), 'zone-catalog'],
    [R('.claude', 'settings.json'), 'zone-agent-layer'],
    [R('.claude', 'settings.local.json'), 'zone-agent-layer'],
    [R('.claude', 'hooks', 'guard.mjs'), 'zone-agent-layer'],
    [R('.githooks', 'pre-commit'), 'zone-agent-layer'],
    [R('films', 'demo', 'AGENTS.md'), 'nested-instructions'],
    [R('films', 'demo', 'CLAUDE.md'), 'nested-instructions'],
    [H('lemo-my-styles', 'watercolor', 'STYLE.md'), 'home-style-library'],
    [H('lemo-opuscar', 'styles', 'x', 'STYLE.md'), 'home-style-library'],
    [H('lemo-opuscar', '.venv', 'lib', 'site.py'), 'home-style-runtime'],
  ];
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    for (const [p, rule] of deny) expectDeny(run(tool, { file_path: p, old_string: 'a', new_string: 'b' }), rule, `${tool} ${p}`);
  }
  expectDeny(run('NotebookEdit', { notebook_path: R('src', 'x.ipynb'), new_source: '' }), 'zone-src', 'NotebookEdit src');
  for (const p of [R('films', 'demo', 'main.js'), R('films', 'demo', 'film.json'), R('films', 'demo', 'README.md'),
    R('engine', 'core', 'new-module.js'), R('lab', 'tests', 'x.html'), R('AGENTS.md'), R('docs', 'notes.md'),
    path.join(os.tmpdir(), 'scratch', 'a.txt')]) {
    expectAllow(write(p), `Write ${p}`);
  }
});

test('写文件工具：大小写与 ./、.. 写法都归一（macOS / Windows 不区分大小写）', () => {
  expectDeny(write(path.join(ROOT, 'films', '..', 'cases', 'vendor', 'x.js')), 'zone-vendor', '.. 绕回 vendor');
  expectDeny(run('Write', { file_path: 'cases/vendor/x.js' }), 'zone-vendor', '相对路径');
  expectDeny(run('Write', { file_path: './src/a.js' }, { cwd: ROOT }), 'zone-src', './ 相对路径');
  expectDeny(run('Write', { file_path: R('Cases', 'Vendor', 'x.js') }, { platform: 'darwin' }), 'zone-vendor', 'macOS 大小写');
});

test('临时解锁：只解点名的区域，区域 id 不含 all', () => {
  expectAllow(write(R('src', 'main.js'), { env: { BEIMING_GUARD_UNLOCK: 'src' } }), 'BEIMING_GUARD_UNLOCK=src 后写 src');
  expectDeny(write(R('cases', 'vendor', 'x.js'), { env: { BEIMING_GUARD_UNLOCK: 'src' } }), 'zone-vendor', '解锁 src 不影响 vendor');
  expectDeny(write(R('src', 'main.js'), { env: { BEIMING_GUARD_UNLOCK: 'all' } }), 'zone-src', 'all 不是区域 id');
  expectAllow(write(R('films', 'x', 'AGENTS.md'), { env: { BEIMING_GUARD_UNLOCK: 'instructions' } }), '解锁 instructions');
});

test('本机临时工作树 .claude/worktrees/ 是另一份检出：不按本仓库区域判断', () => {
  expectAllow(write(R('.claude', 'worktrees', 'wt1', 'src', 'main.js')), 'worktrees 里的 src');
  expectAllow(bash('git reset --hard', { cwd: R('.claude', 'worktrees', 'wt1') }), 'worktrees 里 reset --hard');
});

test('git：整树暂存与强推在哪里都拒绝，而且不能解锁', () => {
  const always = [
    ['git add -A', 'git-add-all'], ['git add --all', 'git-add-all'], ['git add -A films/x', 'git-add-all'],
    ['git add .', 'git-add-dot'], ['git add -- .', 'git-add-dot'], ['git add *', 'git-add-dot'], ['git add :/', 'git-add-dot'],
    ['git add ./', 'git-add-dot'], ['git -C films/demo add -A', 'git-add-all'], [`git add ${ROOT}`, 'git-add-dot'],
    ['git push --force', 'git-push-force'], ['git push -f origin main', 'git-push-force'], ['git push origin +main', 'git-push-force'],
    ['git push --force-with-lease origin main', 'git-push-force'], ['git push --mirror', 'git-push-force'],
    ['cd films/demo && git add -A', 'git-add-all'], ['bash -c "git add -A"', 'git-add-all'], ['sh -c \'git push -f\'', 'git-push-force'],
    ['echo ok; git add .', 'git-add-dot'], ['rtk proxy git add -A', 'git-add-all'], ['env GIT_DIR=.git git add -A', 'git-add-all'],
  ];
  for (const [cmd, rule] of always) {
    expectDeny(bash(cmd), rule, cmd);
    expectDeny(bash(cmd, { env: { BEIMING_GUARD_UNLOCK: 'git' } }), rule, `${cmd}（解锁 git 后）`);
    expectDeny(bash(cmd, { cwd: os.tmpdir() }), rule, `${cmd}（在仓库外）`);
  }
  for (const r of ALWAYS_DENY_RULES) assert.ok(RULES[r], `ALWAYS_DENY_RULES 的 ${r} 要有说明`);
});

test('git：只改工作区的规则只管本仓库，BEIMING_GUARD_UNLOCK=git 可解锁', () => {
  const local = [
    ['git reset --hard', 'git-reset-hard'], ['git reset --hard origin/main', 'git-reset-hard'],
    ['git clean -fd', 'git-clean'], ['git clean -f -x', 'git-clean'],
    ['git checkout -f main', 'git-discard-all'], ['git checkout -- .', 'git-discard-all'], ['git restore .', 'git-discard-all'],
    ['git commit -am "x"', 'git-commit-all'], ['git commit --all -m x', 'git-commit-all'], ['git commit -m x --no-verify', 'git-no-verify'],
    ['git commit -n -m x', 'git-no-verify'], ['git add -f out/x.mp4', 'git-add-force'], ['git add -u', 'git-add-update'],
    ['git add --pathspec-from-file=list.txt', 'git-add-pathspec-file'], ['git filter-repo --path secret', 'git-history-rewrite'],
    ['git filter-branch --tree-filter x', 'git-history-rewrite'], ['git -c core.hooksPath=/dev/null commit -m x', 'git-hooks-bypass'],
    ['git config core.hooksPath /dev/null', 'git-hooks-path'], ['git config --unset core.hooksPath', 'git-hooks-path'],
  ];
  for (const [cmd, rule] of local) {
    expectDeny(bash(cmd), rule, cmd);
    expectAllow(bash(cmd, { env: { BEIMING_GUARD_UNLOCK: 'git' } }), `${cmd}（解锁 git 后）`);
    expectAllow(bash(cmd, { cwd: os.tmpdir() }), `${cmd}（在别的仓库里）`);
  }
  expectAllow(bash(`git -C ${os.tmpdir()} reset --hard`), 'git -C 别处 reset --hard');
});

test('git：删远端与全局改钩子路径在哪里都拒绝，可解锁', () => {
  for (const [cmd, rule] of [['git push origin --delete feature', 'git-push-delete'], ['git push origin :feature', 'git-push-delete'],
    ['git push --no-verify', 'git-no-verify'], ['git config --global core.hooksPath ~/hooks', 'git-hooks-path']]) {
    expectDeny(bash(cmd), rule, cmd);
    expectDeny(bash(cmd, { cwd: os.tmpdir() }), rule, `${cmd}（在仓库外）`);
    expectAllow(bash(cmd, { env: { BEIMING_GUARD_UNLOCK: 'git' } }), `${cmd}（解锁 git 后）`);
  }
});

test('git：日常写法放行（按文件名暂存、普通提交与推送、只读查询、启用本仓库钩子）', () => {
  for (const cmd of ['git status', 'git diff --cached', 'git log --oneline -5', 'git add films/demo/film.json films/demo/main.js',
    'git add -u films/demo/', 'git add -n .', 'git commit -m "feat: 新片 不要用 git add -A"', 'git push origin hard/P03',
    'git push --dry-run --force', 'git restore --staged films/demo/main.js', 'git restore films/demo/main.js', 'git checkout -b feat/x',
    'git switch main', 'git stash', 'git clean -n', 'git config core.hooksPath', 'git config core.hooksPath .githooks',
    'git config --local core.hooksPath .githooks', 'git config get core.hooksPath', 'git -c user.email=a@b.c commit -m x',
    "git commit -F - <<'EOF'\n不要 git add -A，也不要 git push --force\nEOF", 'git merge --ff-only routes-template', 'git worktree list']) {
    expectAllow(bash(cmd), cmd);
  }
});

test('Shell：写入受保护区域的各种写法都拒绝', () => {
  const cases = [
    ['echo x > cases/vendor/lemo-opuscar/a.txt', 'zone-vendor'], ['echo x >> src/main.js', 'zone-src'],
    ['cat a | tee cases/source/x/y.js', 'zone-source'], ['rm -rf cases', 'zone-vendor'], ['rm -rf .', 'zone-vendor'],
    ['rm -rf src/', 'zone-src'], ['rm LICENSE', 'zone-license'], ['cp a.js cases/vendor/sy-style-100/', 'zone-vendor'],
    ['mv films/x/a.js src/a.js', 'zone-src'], ['mv cases/vendor/lemo-opuscar/AGENTS.md /tmp/', 'zone-vendor'],
    ["sed -i '' 's/a/b/' src/main.js", 'zone-src'], ["perl -pi -e 's/a/b/' cases/catalog.json", 'zone-catalog'],
    ['mkdir -p cases/vendor/lemo-opuscar/films/my-film', 'zone-vendor'], ['touch cases/vendor/lemo-opuscar/out', 'zone-vendor'],
    ['find cases/vendor -name "*.js" -delete', 'zone-vendor'], ['find . -name x.js -exec rm {} \\;', 'zone-vendor'],
    ['tar -xf a.tar -C cases/vendor', 'zone-vendor'], ['unzip pack.zip -d cases/source', 'zone-source'],
    ['curl -o cases/vendor/x.js https://example.com/x.js', 'zone-vendor'], ['node engine/render/still.mjs films/x --out src/x.png', 'zone-src'],
    ['echo $(rm -rf src)', 'zone-src'], ['(cd cases && rm -rf vendor)', 'zone-vendor'], ['cd cases/vendor; rm -rf lemo-opuscar', 'zone-vendor'],
    ['chmod -R 777 cases/vendor', 'zone-vendor'], ['git rm -r cases/vendor/sy-style-100', 'zone-vendor'],
    ['git checkout HEAD~1 -- src/main.js', 'zone-src'], ['ln -s ../x cases/vendor/link', 'zone-vendor'],
    ['echo x > films/demo/CLAUDE.md', 'nested-instructions'], ['echo {} > .claude/settings.local.json', 'zone-agent-layer'],
  ];
  for (const [cmd, rule] of cases) expectDeny(bash(cmd), rule, cmd);
});

test('Shell：作品目录、out/、临时目录的写入与只读命令放行', () => {
  for (const cmd of ['mkdir -p films/demo && echo x > films/demo/notes.md', 'rm -rf films/demo/out', 'rm -rf out/casebook/style-02',
    'node engine/render/still.mjs films/demo --out films/demo/out/s.png', 'npm run new -- c demo --title 演示',
    'cp cases/vendor/lemo-opuscar/styles/x/demo/pal.js films/demo/pal.js', 'cat cases/vendor/lemo-opuscar/styles/x/STYLE.md',
    'rg window.render cases/vendor', 'grep -rn READY cases/source | head', 'find cases/vendor -name STYLE.md',
    'find . -name "*.js" -exec grep -l READY {} +', 'python3 tools/casebook.py restore style-02 --out out/casebook',
    'ls cases/vendor', 'echo "rm -rf src" > films/demo/note.txt', 'ffmpeg -i films/demo/out/a.mp4 -f null -',
    `echo x > ${path.join(os.tmpdir(), 'a.txt')}`, 'cd films/demo && node main.js']) {
    expectAllow(bash(cmd), cmd);
  }
});

test('递归操作的起点只是包含只读区域时：拒绝并说清"会连带"，限定到自己的目录就放行', () => {
  for (const cmd of ['find . -name "*.pyc" -delete', 'rm -rf .', 'git clean -fd cases', 'chmod -R 755 .']) {
    const d = bash(cmd);
    assert.equal(d.decision, 'deny', cmd);
    assert.match(d.reason, /会连带只读区域/, `${cmd} 的理由要说明会连带只读区域`);
    assert.match(d.reason, /限定在自己的目录/, `${cmd} 的下一步要建议缩小范围`);
  }
  const inside = write(R('cases', 'vendor', 'x.js'));
  assert.doesNotMatch(inside.reason, /会连带/, '目标本身在区域里时不说"连带"');
  for (const cmd of ['find films -name "*.pyc" -delete', 'git clean -fd films/demo/out', 'git clean -fdx out/', 'rm -rf films/demo/out out/stills']) {
    expectAllow(bash(cmd), cmd);
  }
  expectDeny(bash('git clean -fdx'), 'git-clean', 'git clean 不带路径');
  expectDeny(bash('git clean -fd .'), 'git-clean', 'git clean 仓库根');
});

test('从归档复制代码时放行，但附上署名提醒', () => {
  const d = bash('cp cases/vendor/lemo-opuscar/styles/x/demo/pal.js films/demo/pal.js');
  expectAllow(d, '复制 vendor 代码');
  assert.match(d.context ?? '', /CREDITS/, '要提醒在 CREDITS 里写来源与许可');
});

test('在归档里运行上游代码：拒绝（会把产物写进快照，setup.sh 还会改家目录的库）', () => {
  for (const cmd of ['cd cases/vendor/lemo-opuscar && node make.js', 'node cases/vendor/lemo-opuscar/core/render.js',
    'sh cases/vendor/lemo-opuscar/setup.sh deps', 'bash cases/vendor/sy-style-100/tools/build.sh', './cases/vendor/lemo-opuscar/setup.sh',
    'python3 cases/source/style-02/sound.py', 'cd cases/source/x && npm install', 'make -C cases/vendor/sy-style-100',
    'source cases/vendor/lemo-opuscar/env.sh']) {
    expectDeny(bash(cmd), 'archive-exec', cmd);
  }
  expectAllow(bash('cd cases/vendor/lemo-opuscar && node make.js', { env: { BEIMING_GUARD_UNLOCK: 'vendor' } }), '解锁 vendor 后');
});

test('家目录风格库：读写都拒绝；~/lemo-opuscar/.venv 只许当解释器执行', () => {
  const py = `${POSIX_HOME}/lemo-opuscar/.venv/bin/python`;
  for (const cmd of ['cat ~/lemo-opuscar/AGENTS.md', 'ls ~/lemo-my-styles', 'cd ~/lemo-opuscar && git pull',
    `cat ${POSIX_HOME}/lemo-opuscar/README.md`, 'cat $HOME/lemo-my-styles/README.md', 'cp -r ~/lemo-opuscar/styles films/x/',
    'git clone https://github.com/lemomo-ai/lemo-opuscar ~/lemo-opuscar', 'git clone https://github.com/lemomo-ai/lemo-opuscar.git /tmp/x',
    `${py} ~/lemo-opuscar/tools/directory/build.py`, 'LEMO=~/lemo-opuscar node x.mjs']) {
    expectDeny(bash(cmd), 'home-style-library', cmd);
  }
  for (const cmd of [`${py} -m pip install numpy`, `${POSIX_HOME}/lemo-opuscar/.venv/bin/pip install -U scipy`,
    `${py} -m pip uninstall -y numba`, `echo x > ${POSIX_HOME}/lemo-opuscar/.venv/pyvenv.cfg`]) {
    expectDeny(bash(cmd), 'home-style-runtime', cmd);
  }
  for (const cmd of [`PYTHON=${py} node tools/x.mjs`, `${py} tools/casebook.py check`, `${py} -m unittest discover -s tools`,
    `${py} -m pip list`, `env PYTHON=${py} python3 -V`, `PYTHON=~/lemo-opuscar/.venv/bin/python sh build.sh`]) {
    expectAllow(bash(cmd), cmd);
  }
  assert.equal(isHomeRuntime('lemo-opuscar/.venv/bin/python'), true);
  assert.equal(isHomeRuntime('lemo-opuscar/.venvx/bin/python'), false);
  assert.equal(isHomeRuntime('lemo-opuscar/styles/x'), false);
  expectDeny(run('Read', { file_path: H('lemo-my-styles', 'README.md') }), 'home-style-library', 'Read 家目录风格库');
  expectDeny(run('Grep', { pattern: 'x', path: H('lemo-opuscar') }), 'home-style-library', 'Grep 家目录风格库');
});

test('PowerShell：同样的规则（cmdlet、别名、Windows 路径分隔符）', () => {
  for (const [cmd, rule] of [['git add -A', 'git-add-all'], ['git add .', 'git-add-dot'], ['git push -f', 'git-push-force'],
    ['Remove-Item -Recurse -Force cases\\vendor', 'zone-vendor'], ['ri src\\main.js', 'zone-src'],
    ['Set-Content -Path src\\main.js -Value x', 'zone-src'], ['"x" | Out-File cases\\catalog.json', 'zone-catalog'],
    ['New-Item -ItemType File -Path films\\demo\\AGENTS.md', 'nested-instructions'],
    ['Copy-Item a.js -Destination cases\\vendor\\a.js', 'zone-vendor'], ['Move-Item LICENSE old.txt', 'zone-license'],
    ['Expand-Archive p.zip -DestinationPath cases\\source', 'zone-source'], ['echo x > src\\a.js', 'zone-src'],
    ['Invoke-WebRequest https://e.com/x -OutFile cases\\vendor\\x', 'zone-vendor'], ['git reset --hard', 'git-reset-hard'],
    ['Get-Content $env:USERPROFILE\\lemo-my-styles\\README.md', 'home-style-library']]) {
    expectDeny(pwsh(cmd, { home: HOME }), rule, `PowerShell ${cmd}`);
  }
  for (const cmd of ['git add films\\demo\\main.js', 'New-Item -ItemType Directory films\\demo', 'Get-Content cases\\vendor\\README.md',
    "git commit -m '不用 git add -A'", '$env:PYTHON = "python"; node tools\\new-film.mjs c demo']) {
    expectAllow(pwsh(cmd), `PowerShell ${cmd}`);
  }
});

test('模拟 Windows 仓库路径：盘符、反斜杠、大小写都归一', () => {
  const opts = { root: 'C:\\work\\beiming', cwd: 'C:\\work\\beiming', home: 'C:\\Users\\tester', platform: 'win32' };
  expectDeny(write('C:\\work\\beiming\\cases\\vendor\\x.js', opts), 'zone-vendor', 'Windows vendor');
  expectDeny(write('c:/WORK/Beiming/Src/main.js', opts), 'zone-src', 'Windows 大小写与正斜杠');
  expectAllow(write('C:\\work\\beiming\\films\\demo\\main.js', opts), 'Windows 作品目录');
  expectDeny(pwsh('Remove-Item -Recurse C:\\work\\beiming\\cases\\source', opts), 'zone-source', 'PowerShell 绝对路径');
  expectDeny(pwsh('Get-ChildItem $env:USERPROFILE\\lemo-opuscar', opts), 'home-style-library', 'PowerShell 家目录变量');
  expectAllow(pwsh('& $env:USERPROFILE\\lemo-opuscar\\.venv\\Scripts\\python.exe tools\\casebook.py check', opts), 'Windows 解释器例外');
});

test('符号链接指进受保护区域：按解析后的真实路径拒绝', (t) => {
  if (process.platform === 'win32') { t.skip('Windows 建符号链接需要特权'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-guard-link-'));
  try {
    fs.symlinkSync(R('src'), path.join(dir, 'src-link'));
    expectDeny(write(path.join(dir, 'src-link', 'main.js')), 'zone-src', '经符号链接写 src');
    expectDeny(bash(`echo x > ${path.join(dir, 'src-link', 'main.js')}`), 'zone-src', 'Shell 经符号链接写 src');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Skill：全局第三方风格库 skill 拒绝；其他视频类全局 skill 放行并提醒；仓库 skill 放行', () => {
  for (const s of ['lemo-opuscar', 'lemo-opuscar:lemo-opuscar', 'LEMO-OPUSCAR:x', 'sy-style-100', 'sy-style-100:sy-style-100', '/lemo-opuscar:lemo-opuscar']) {
    expectDeny(run('Skill', { skill: s }), 'skill-upstream-style-library', `Skill ${s}`);
  }
  for (const s of ['make-a-video', 'code-video', 'painted-animation', 'remotion-video-creation', 'hyperframes', 'anidoodle:anidoodle',
    'claude-animation:claude-animation', 'motion-graphics-music-video:motion-graphics-music-video', 'title-sequence-3d', 'slideshow']) {
    const d = run('Skill', { skill: s });
    expectAllow(d, `Skill ${s}`);
    assert.match(d.context ?? '', /beiming-film/, `Skill ${s} 要提醒先用 beiming-film`);
  }
  for (const s of ['beiming-film', 'beiming-review', 'superpowers:brainstorming']) {
    const d = run('Skill', { skill: s });
    expectAllow(d, `Skill ${s}`);
    assert.equal(d.context, undefined, `Skill ${s} 不需要提醒`);
  }
});

test('Read：归档里的上游指令文件放行但附"只是资料"的提醒；普通文件不提醒', () => {
  for (const p of [R('cases', 'vendor', 'lemo-opuscar', 'AGENTS.md'), R('cases', 'vendor', 'sy-style-100', 'SKILL.md'),
    R('cases', 'vendor', 'lemo-opuscar', 'DIRECTOR.md'), R('cases', 'vendor', 'lemo-opuscar', 'plugin', '.claude-plugin', 'plugin.json'),
    R('out', 'casebook', 'style-02', 'AGENTS.md')]) {
    const d = run('Read', { file_path: p });
    expectAllow(d, `Read ${p}`);
    assert.match(d.context ?? '', /不是本仓库的指令/, `Read ${p} 要附提醒`);
  }
  for (const p of [R('cases', 'vendor', 'lemo-opuscar', 'styles', 'x', 'STYLE.md'), R('routes', 'README.md'), R('src', 'main.js')]) {
    const d = run('Read', { file_path: p });
    expectAllow(d, `Read ${p}`);
    assert.equal(d.context, undefined, `Read ${p} 不需要提醒`);
  }
});

test('MCP 工具：按参数里的路径与命令做同样的判断', () => {
  expectDeny(run('mcp__plugin_desktop-commander_desktop-commander__write_file', { path: R('cases', 'vendor', 'x.js'), content: 'x' }), 'zone-vendor', 'MCP write_file');
  expectDeny(run('mcp__plugin_desktop-commander_desktop-commander__move_file', { source: R('src', 'main.js'), destination: R('films', 'x', 'main.js') }), 'zone-src', 'MCP move_file 源');
  expectDeny(run('mcp__plugin_desktop-commander_desktop-commander__start_process', { command: 'git add -A' }), 'git-add-all', 'MCP start_process');
  expectDeny(run('mcp__plugin_desktop-commander_desktop-commander__read_file', { path: H('lemo-my-styles', 'README.md') }), 'home-style-library', 'MCP 读家目录风格库');
  expectAllow(run('mcp__plugin_desktop-commander_desktop-commander__read_file', { path: R('cases', 'vendor', 'README.md') }), 'MCP 读 vendor README');
  expectAllow(run('mcp__plugin_desktop-commander_desktop-commander__write_file', { path: R('films', 'x', 'a.md'), content: 'x' }), 'MCP 写作品');
});

test('其他工具与空输入：放行，不抛错', () => {
  for (const [tool, input] of [['WebFetch', { url: 'https://example.com' }], ['TodoWrite', {}], ['Bash', {}], ['Write', {}], ['Bash', { command: '' }],
    ['Bash', { command: 'echo "未闭合' }], ['PowerShell', { command: '@"\n未闭合' }], ['Skill', {}], ['Read', {}]]) {
    expectAllow(run(tool, input), `${tool} ${JSON.stringify(input)}`);
  }
});

test('每条规则与区域都有原因和下一步，拒绝理由不含本机绝对路径之外的东西', () => {
  for (const [id, r] of Object.entries(RULES)) {
    assert.ok(r.title && r.title.length > 10, `${id} 缺原因`);
    assert.ok(r.next && r.next.length > 5, `${id} 缺下一步`);
  }
  for (const z of ZONES) {
    assert.ok(z.title && z.next && z.unlock, `区域 ${z.id} 缺说明`);
    assert.ok(z.prefixes.every(p => p.endsWith('/')) && z.files.every(f => !f.endsWith('/')), `区域 ${z.id} 的写法不对`);
  }
  const d = write(R('cases', 'vendor', 'x.js'));
  assert.match(d.reason, /films\/<名字>\//, 'vendor 的拒绝理由要指向 films/<名字>/');
});
