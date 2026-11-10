// 命令约定的契约测试（docs/CLI.md、附录 C1–C3）：遍历 package.json 的每个脚本——
//   已接入命令约定库（目标文件用 tools/lib/cli.mjs 的 runCli，或 tools/lib/cli.py 的 run）的：
//     · 加 --help：退出 0，帮助打到 stdout（含「用法」与「退出码」），不产生任何文件改动；
//     · 加 --no-such-flag：退出 2；
//     · 加 --no-such-flag --json：stdout 只有一个可解析的 JSON 对象（附录 C2 信封：ok=false、exitCode=2、error.code=usage.unknown-option）；
//   还没接入的：必须登记在下面的 KNOWN_EXCEPTIONS 里（写明属主包与原因），不执行（它们的 --help 可能直接渲染或改文件）。
// 新脚本既没接入也没登记，测试失败。--help 与未知参数在一个沙盒副本里跑（复制 tools、routes、docs、engine 与 package.json），
// 前后逐文件比对；不碰真实仓库，也不受并行测试写 out/ 的干扰。另用 npm run 真跑一次 new -- --help，确认参数照样传到。
//   node --test tests/cli/contract.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SCRIPTS = PKG.scripts ?? {};

/** 还没接入命令约定库的脚本：属主包与原因（改造完成后从这里删掉，测试会自动开始验证它）。 */
export const KNOWN_EXCEPTIONS = Object.freeze({
  build: ['P06 出片编排', 'sh build.sh：--help 会直接重建《北冥》；改为 beiming:build 兼容壳'],
  stills: ['P04 渲染器', 'engine/render/still.mjs：--help 会渲出静帧（s_--help.jpg）'],
  video: ['P04 渲染器', 'engine/render/video.mjs：参数必须写在目录之后，--help 会被当成作品目录'],
  'video:4k': ['P04 渲染器', '同 video'],
  setup: ['P10 环境', 'npm install 与浏览器下载的串联；改为 tools/env/setup.mjs'],
  'raea:prepare': ['P14 B 路线', 'examples/raea 例片的准备脚本（旧名，保留一个版本）'],
  'raea:check': ['P14 B 路线', 'examples/raea/tools/render.mjs：缺 RAEA_BIN 时抛堆栈'],
  'raea:render': ['P14 B 路线', 'examples/raea/tools/render.mjs：拼错 --check-only 会直接开始原生渲染'],
  test: ['P09 测试与 CI', 'npm run 串联；改为 tools/run-tests.mjs'],
  'test:routes': ['P09 测试与 CI', 'cd tests && node --test 的串联'],
  'test:engine': ['P09 测试与 CI', 'node --test 的 glob'],
  'test:audio': ['P09 测试与 CI', 'python3 -m unittest 的串联'],
  'test:cases': ['P09 测试与 CI', 'python3 -m unittest'],
  'cases:check': ['P16 案例库', 'tools/casebook.py：argparse 已拒绝未知参数（退出 2），--json 信封未接入'],
  'cases:list': ['P16 案例库', '同 cases:check'],
  'site:build': ['作品站会话', 'tools/build-showcase.py：会重建 out/site（作品站维护）'],
  'site:serve': ['作品站会话', 'python3 -m http.server：本地预览'],
  'site:qa': ['作品站会话', 'tools/site-qa.mjs：-h / --help 合规，--json 信封未接入（作品站维护）'],
  'native:prepare': ['P14 B 路线', 'engine/native/prepare.mjs：--help 只打用法，但不拒绝未知参数，报错是原始堆栈（附录 C1 对齐在改造）'],
  'native:check': ['P14 B 路线', 'engine/render/native.mjs --check-only：--help 只打用法，但不拒绝未知参数；缺 RAEA_BIN 的退出码在改造'],
  'native:render': ['P14 B 路线', 'engine/render/native.mjs：不拒绝未知参数，拼错的选项会被忽略后直接开渲'],
  'native:bridge': ['P14 B 路线', 'engine/native/bridge/export.mjs：--help 只打用法，未知参数与 --json 未接入'],
  'native:sequence': ['P14 B 路线', 'engine/native/sequence.mjs：位置参数直接取用，没有 --help 与未知参数检查'],
  'c:styles': ['P15 C 路线', 'tools/c-styles.mjs：只认 --check，其他参数一律忽略'],
  'c:styles:check': ['P15 C 路线', '同 c:styles'],
  'c:events': ['P06 出片编排', 'engine/render/events.mjs：没有 --help，参数不校验（会写作品的 events.json）'],
  'c:build': ['P06 出片编排', 'engine/render/build.mjs：并入 npm run film -- build'],
});

/** 脚本 → { runner, file, args }：只认「node|python <文件> [参数]」这种单条命令。 */
export function parseScript(cmd) {
  if (/&&|\|\||;|\|/.test(cmd)) return null;
  const toks = cmd.trim().split(/\s+/);
  if (!['node', 'python', 'python3'].includes(toks[0]) || !toks[1] || toks[1].startsWith('-')) return null;
  return { runner: toks[0], file: toks[1], args: toks.slice(2) };
}

/** 目标文件用了命令约定库吗（Node：lib/cli.mjs + runCli；Python：tools/lib 的 cli + run）。 */
export function usesCliLib(file) {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { return false; }
  if (file.endsWith('.py')) return /from\s+cli\s+import/.test(src) && /\brun\(/.test(src);
  return /lib\/cli\.mjs['"]/.test(src) && /\brunCli\(/.test(src);
}

const plan = Object.entries(SCRIPTS).map(([name, cmd]) => {
  const parsed = parseScript(cmd);
  const compliant = !!parsed && usesCliLib(parsed.file);
  return { name, cmd, parsed, compliant, exception: KNOWN_EXCEPTIONS[name] ?? null };
});

// ───── 沙盒：脚本在副本里跑，前后逐文件比对 ─────
let sandboxDir = null;
after(() => { if (sandboxDir) fs.rmSync(sandboxDir, { recursive: true, force: true }); });
function sandbox() {
  if (sandboxDir) return sandboxDir;
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-contract-'));
  for (const d of ['tools', 'routes', 'docs', 'engine']) fs.cpSync(path.join(ROOT, d), path.join(sandboxDir, d), { recursive: true, filter: s => !/[\\/](node_modules|__pycache__|out)$/.test(s) });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(sandboxDir, 'package.json'));
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(sandboxDir, 'node_modules'), 'junction');
  return sandboxDir;
}
function snapshot(dir) {
  const out = new Map();
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.set(`${r}/`, 'dir'); walk(r); } else { const s = fs.statSync(path.join(dir, r)); out.set(r, `${s.size}:${s.mtimeMs}`); }
    }
  };
  walk('');
  return out;
}
function diff(a, b) {
  const changed = [];
  for (const [k, v] of b) if (a.get(k) !== v) changed.push(a.has(k) ? `改动 ${k}` : `新增 ${k}`);
  for (const k of a.keys()) if (!b.has(k)) changed.push(`删除 ${k}`);
  return changed;
}
const PY = [process.env.BEIMING_PY, process.env.PYTHON, 'python3', 'python'].filter(Boolean).find(c => spawnSync(c, ['-c', 'import sys'], { encoding: 'utf8' }).status === 0);
function runScript(s, extra) {
  const dir = sandbox();
  const exe = s.parsed.runner === 'node' ? process.execPath : PY;
  return spawnSync(exe, [s.parsed.file, ...s.parsed.args, ...extra], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, npm_lifecycle_event: s.name } });
}

test('package.json 的每个脚本：要么已接入命令约定库，要么登记为已知例外（写明属主包）', () => {
  const unclassified = plan.filter(s => !s.compliant && !s.exception).map(s => `${s.name}（${s.cmd}）`);
  assert.deepEqual(unclassified, [], '新脚本用 tools/lib/cli.mjs（或 cli.py）写；暂时做不到就在 KNOWN_EXCEPTIONS 登记属主与原因');
  for (const name of ['new', 'check:repo']) assert.ok(plan.find(s => s.name === name)?.compliant, `${name} 必须已接入`);
  const stale = Object.keys(KNOWN_EXCEPTIONS).filter(n => !(n in SCRIPTS) || plan.find(s => s.name === n)?.compliant);
  if (stale.length) console.log(`# 已知例外里这些脚本已改名、删除或接入：${stale.join('、')}（从 KNOWN_EXCEPTIONS 删掉）`);
});

for (const s of plan) {
  if (!s.compliant) {
    test(`${s.name}：已知例外，不执行`, { skip: s.exception ? `${s.exception[0]}：${s.exception[1]}` : '未登记（上一条测试会失败）' }, () => {});
    continue;
  }
  const pySkip = s.parsed.runner !== 'node' && !PY ? '没有 Python' : false;
  test(`${s.name}：--help 退出 0 且无副作用；未知参数退出 2；--json 输出单个信封对象`, { skip: pySkip }, () => {
    const dir = sandbox();
    const before = snapshot(dir);
    const help = runScript(s, ['--help']);
    assert.equal(help.status, 0, `${s.cmd} --help：${help.stderr}`);
    assert.match(help.stdout, /用法/);
    assert.match(help.stdout, /退出码/);
    assert.deepEqual(diff(before, snapshot(dir)), [], `${s.cmd} --help 不能改任何文件`);
    const bad = runScript(s, ['--no-such-flag']);
    assert.equal(bad.status, 2, `${s.cmd} --no-such-flag：${bad.stderr}`);
    assert.match(bad.stderr, /不认识的选项 --no-such-flag/);
    const json = runScript(s, ['--no-such-flag', '--json']);
    assert.equal(json.status, 2);
    let env;
    assert.doesNotThrow(() => { env = JSON.parse(json.stdout); }, `stdout 要是一个 JSON 对象：${json.stdout.slice(0, 200)}`);
    assert.ok(env && typeof env === 'object' && !Array.isArray(env));
    assert.equal(env.schemaVersion, 1);
    assert.equal(env.ok, false);
    assert.equal(env.exitCode, 2);
    assert.equal(typeof env.command, 'string');
    assert.equal(env.error.code, 'usage.unknown-option');
    assert.ok(Array.isArray(env.outputs) && Array.isArray(env.warnings));
    assert.deepEqual(diff(before, snapshot(dir)), [], `${s.cmd} 的用法错误不能改任何文件`);
  });
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const hasNpm = spawnSync(npm, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0;
test('经 npm run 调用时参数照样传到：npm run new -- --help', { skip: hasNpm ? false : '没有 npm' }, () => {
  const r = spawnSync(npm, ['run', '--silent', 'new', '--', '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /new-film：/);
});

test('docs/CLI.md 的命令清单列出了 package.json 的每个脚本', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/CLI.md'), 'utf8');
  const missing = Object.keys(SCRIPTS).filter(n => !doc.includes(`\`${n}\``));
  assert.deepEqual(missing, [], '在 docs/CLI.md 第 9 节登记这些脚本（指向、属主、状态）');
});
