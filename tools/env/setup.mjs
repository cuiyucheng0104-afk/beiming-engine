#!/usr/bin/env node
// 北冥仓库 · 一键建环境（npm run setup）：npm 依赖 → 锁定版本的无头浏览器 → 仓库内 Python 3.12 虚拟环境 → git 钩子。
//   npm run setup -- [--dry-run] [--json] [--skip-npm] [--skip-browser] [--skip-python] [--with-deps] [--recreate-venv] [--no-uv] [--python <解释器>] [--venv <目录>] [--no-hooks]
//
// 幂等：每一步先判断是否已经满足（npm 依赖与 package-lock.json 一致、headless shell r1243 已装全、.venv 与 requirements.lock 一致），
// 满足就跳过，所以第二次运行不下载任何东西。
//   npm      npm ci（node_modules 已一致时跳过；node_modules 是指向别处的链接时拒绝改动，避免清空别的检出）
//   浏览器   用本仓库的 playwright-core（1.63.0）安装它配套的 chromium-headless-shell，不会拉到更新的版本；Linux 加 --with-deps 时顺带装系统库（需要 sudo）
//   Python   有 uv：uv venv --python 3.12 .venv + uv pip sync --require-hashes --only-binary :all: --compile-bytecode requirements.lock；
//            没有 uv：找 Python 3.12 → python -m venv .venv → pip install --require-hashes --only-binary :all: -r requirements.lock；
//            装完导入一次 numpy / scipy / numba / soundfile / soxr / PIL（新环境第一次加载原生库要 30–60 秒，提前付掉）
//   钩子     仓库有 .githooks/ 时设 git config core.hooksPath .githooks
// 退出码：0 成功；2 用法错误；3 缺前置条件（Node 太旧、没有 uv 也没有 Python 3.12、拒绝改动链接的 node_modules）；1 某一步执行失败；124 超时；130/143 被中断（已结束子进程）。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CliError, runCli, isMain, log } from './lib/cli.mjs';
import { run, which, npmInvocation } from './lib/proc.mjs';
import { ROOT, probePython, venvPython } from './lib/python.mjs';
import { sha256 } from './lib/lockfile.mjs';
import * as C from './lib/checks.mjs';

const HELP = `北冥仓库 · 一键建环境（幂等，可重复运行）

用法：
  npm run setup -- [选项]
  node tools/env/setup.mjs [选项]

步骤（已满足的自动跳过）：
  1 npm      npm ci（node_modules 与 package-lock.json 不一致时）
  2 浏览器   安装 playwright-core 1.63.0 配套的 chromium-headless-shell r1243（不会拉更新的版本）
  3 Python   在仓库内建 .venv（Python 3.12）并按 requirements.lock 安装（带哈希校验，只用二进制轮子）；装完预先导入一次
  4 钩子     仓库有 .githooks/ 时设 core.hooksPath

选项：
  --dry-run          只列出每一步会做什么，不下载、不写文件
  --skip-npm / --skip-browser / --skip-python    跳过对应步骤
  --with-deps        （Linux）同时安装浏览器需要的系统库，要 sudo
  --recreate-venv    删除并重建 .venv（例如它不是 setup 建的、或 Python 版本不对）
  --no-uv            不用 uv，改用 python3.12 -m venv + pip（没有 uv 时自动如此）
  --python <解释器>  没有 uv 时用来建 .venv 的 Python 3.12（完整路径或命令名）
  --venv <目录>      虚拟环境建在别处（默认仓库根的 .venv；远程工作站按锁文件哈希共享时用）。
                     不在默认位置时，运行工具前设 BEIMING_PYTHON 指向它的解释器
  --no-hooks         不设 git 钩子
  --json             stdout 只输出一个 JSON 对象（C2 信封，steps 字段是每一步的结果）

镜像与离线：PLAYWRIGHT_DOWNLOAD_HOST（浏览器）、UV_DEFAULT_INDEX / PIP_INDEX_URL（PyPI）、npm_config_registry（npm）、
UV_PYTHON_INSTALL_MIRROR（uv 下载 Python）。详见 docs/ENVIRONMENT.md。
装完运行 npm run env:doctor 确认。
退出码：0 成功；2 用法错误；3 缺前置条件；1 某一步失败；124 超时；130/143 被中断。`;

const STAMP = '.beiming-setup.json';
const steps = [];
const step = (id, title) => {
  const s = { id, title, status: 'pending', detail: null, ms: 0, t0: Date.now() };
  steps.push(s);
  log(`== ${steps.length} ${title}`);
  return s;
};
const finishStep = (s, status, detail) => { s.status = status; s.detail = detail; s.ms = Date.now() - s.t0; delete s.t0; log(`   ${status === 'skipped' ? '跳过' : status === 'planned' ? '计划' : status === 'done' ? '完成' : '失败'}：${detail}`); };

async function must(s, cmd, args, { timeout, cwd = ROOT, env = process.env, what, shell = false }) {
  log(`   $ ${[cmd, ...args].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  const r = await run(cmd, args, { cwd, env, timeout, tee: true, group: true, shell });
  if (r.timedOut) throw Object.assign(new CliError(EXIT.TIMEOUT, 'timeout', `${what}超时（${timeout / 60000} 分钟）`, '检查网络后重跑 npm run setup；已完成的步骤会跳过'), { step: s });
  if (r.error || r.code !== 0) {
    throw Object.assign(new CliError(EXIT.FAIL, 'step-failed', `${what}失败（${r.error ? r.error.code || r.error.message : `退出码 ${r.code}`}）：${r.tail.slice(-3).join(' / ')}`,
      '看上面的输出；网络问题设镜像（见 docs/ENVIRONMENT.md「镜像与离线」）后重跑 npm run setup'), { step: s });
  }
  return r;
}

async function stepNpm(o, spec) {
  const s = step('npm', 'npm 依赖（package-lock.json）');
  if (o['skip-npm']) return finishStep(s, 'skipped', '--skip-npm');
  const c = C.checkNpm(ROOT);
  if (c.ok) return finishStep(s, 'skipped', c.found);
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm) && fs.lstatSync(nm).isSymbolicLink()) {
    throw Object.assign(new CliError(EXIT.ENV, 'linked-node-modules', `node_modules 是指向 ${fs.realpathSync(nm)} 的链接，且与锁文件不一致：${c.found}`,
      '在它指向的检出里运行 npm ci，或删掉这个链接后重跑 npm run setup；setup 不会清空别处的 node_modules'), { step: s });
  }
  if (o['dry-run']) return finishStep(s, 'planned', `npm ci（原因：${c.found}）`);
  const npm = npmInvocation();
  if (!npm) throw Object.assign(new CliError(EXIT.ENV, 'npm-missing', '找不到 npm', C.pf(spec.node.fix)), { step: s });
  await must(s, npm.cmd, [...npm.args, 'ci', '--no-audit', '--no-fund'], { timeout: 15 * 60_000, what: 'npm ci ', shell: npm.shell });
  const again = C.checkNpm(ROOT);
  if (!again.ok) throw Object.assign(new CliError(EXIT.FAIL, 'step-failed', `npm ci 之后依赖仍不一致：${again.found}`, '删掉 node_modules 后重跑 npm run setup'), { step: s });
  finishStep(s, 'done', again.found);
}

async function stepBrowser(o, spec) {
  const s = step('browser', `无头浏览器（${spec.playwright.browser} r${spec.playwright.revision}）`);
  if (o['skip-browser']) return finishStep(s, 'skipped', '--skip-browser');
  const env = { ...process.env };
  delete env.BEIMING_CHROME;
  const c = C.checkHeadlessShell(ROOT, spec, env);
  const withDeps = o['with-deps'] && process.platform === 'linux';
  if (c.ok && !withDeps) return finishStep(s, 'skipped', `已安装：${c.found}`);
  const cli = path.join(ROOT, 'node_modules', spec.playwright.package, 'cli.js');
  const args = [cli, 'install', ...(withDeps ? ['--with-deps'] : []), spec.playwright.browser];
  if (o['dry-run']) return finishStep(s, 'planned', `node ${path.relative(ROOT, cli)} ${args.slice(1).join(' ')}（安装到 ${c.data?.dir ?? '默认位置'}）`);
  if (!fs.existsSync(cli)) throw Object.assign(new CliError(EXIT.ENV, 'playwright-missing', 'node_modules 里没有 playwright-core', '先完成 npm 步骤（不要加 --skip-npm）'), { step: s });
  await must(s, process.execPath, args, { timeout: 20 * 60_000, env, what: '下载无头浏览器' });
  const again = C.checkHeadlessShell(ROOT, spec, env);
  if (!again.ok) throw Object.assign(new CliError(EXIT.FAIL, 'step-failed', `安装后仍找不到浏览器：${again.found}`, '删掉上面提到的目录后重跑 npm run setup'), { step: s });
  finishStep(s, 'done', again.found);
}

const sameVersion = (p, want) => p.ok && `${p.version[0]}.${p.version[1]}` === want;

async function baseInterpreter(o, spec) {
  const list = o.python ? [[o.python, []]] : [['python3.12', []], ['python3', []], ['python', []], ...(process.platform === 'win32' ? [['py', ['-3.12']]] : [])];
  const tried = [];
  for (const [cmd, args] of list) {
    const p = await probePython(cmd, args);
    tried.push(`${[cmd, ...args].join(' ')}：${p.ok ? p.version.join('.') : p.error}`);
    if (sameVersion(p, spec.python.version)) return { cmd: p.path, args, version: p.version.join('.') };
  }
  return { tried };
}

async function venvState(venv, spec, lockSha) {
  if (!fs.existsSync(venv)) return { exists: false };
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(path.join(venv, STAMP), 'utf8')); } catch { /* 不是 setup 建的，或旧版 */ }
  const p = await probePython(venvPython(venv));
  return { exists: true, ours: !!stamp, stamp, probe: p, versionOk: sameVersion(p, spec.python.version), lockOk: stamp?.state === 'ok' && stamp.lockSha256 === lockSha };
}

async function verifyVenv(venv, spec) {
  const env = { ...process.env, BEIMING_PYTHON: venvPython(venv) };
  delete env.BEIMING_PY; delete env.PYTHON;
  const r = await C.checkPython(ROOT, spec, { env, imports: true });
  return r.checks.find(c => c.id === 'python.packages') || r.checks.find(c => c.id === 'python.interpreter');
}

async function stepPython(o, spec) {
  const s = step('python', `Python ${spec.python.version} 虚拟环境（${o.venv || spec.python.venv}，按 ${spec.python.lock}）`);
  if (o['skip-python']) return finishStep(s, 'skipped', '--skip-python');
  const venv = o.venv ? path.resolve(o.venv) : path.join(ROOT, spec.python.venv);
  const venvName = o.venv ? venv : spec.python.venv;
  const lockPath = path.join(ROOT, spec.python.lock);
  const lockSha = sha256(fs.readFileSync(lockPath));
  let st = await venvState(venv, spec, lockSha);
  if (st.exists && st.versionOk && st.lockOk && !o['recreate-venv']) {
    const v = await verifyVenv(venv, spec);
    if (v.ok) return finishStep(s, 'skipped', `已与锁文件一致：${v.found}`);
  }
  const uv = o['no-uv'] ? null : which('uv');
  const base = uv ? null : await baseInterpreter(o, spec);
  if (!uv && !base.cmd) {
    throw Object.assign(new CliError(EXIT.ENV, 'python-missing', `没有 uv，也没有找到 Python ${spec.python.version}（试过：${base.tried.join('；')}）`,
      `二选一：装 uv（推荐，setup 会自动取 Python ${spec.python.version}）：${C.pf(spec.python.uvFix)}；或装 Python ${spec.python.version}：${C.pf(spec.python.pythonFix)}。装完重跑 npm run setup`), { step: s });
  }
  const recreate = st.exists && (o['recreate-venv'] || !st.versionOk || (!st.probe?.ok));
  if (recreate && !st.ours && !o['recreate-venv']) {
    throw Object.assign(new CliError(EXIT.ENV, 'foreign-venv', `${venvName} 已存在但不能用（${st.probe?.ok ? `Python ${st.probe.version.join('.')}` : st.probe?.error}），而且不是 setup 建的`,
      `确认里面没有要保留的东西后加 --recreate-venv 重跑；或把它改名保留（例如改成 .venv-old）`), { step: s });
  }
  const plan = [];
  if (!st.exists || recreate) plan.push(uv ? `uv venv --python ${spec.python.version} ${venvName}` : `${base.cmd} -m venv ${venvName}`);
  const exact = !st.exists || recreate || st.ours;
  plan.push(uv ? `uv pip ${exact ? 'sync' : 'install -r'} ${spec.python.lock} --require-hashes --only-binary :all: --compile-bytecode` : `pip install --require-hashes --only-binary :all: -r ${spec.python.lock}`);
  if (o['dry-run']) return finishStep(s, 'planned', `${recreate ? `删除并重建 ${venvName}；` : ''}${plan.join('；')}`);

  const env = { ...process.env, UV_NO_PROGRESS: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
  delete env.VIRTUAL_ENV;
  if (recreate) fs.rmSync(venv, { recursive: true, force: true });
  if (!st.exists || recreate) {
    if (uv) await must(s, uv, ['venv', '--python', spec.python.version, venv], { timeout: 10 * 60_000, env, what: `建 Python ${spec.python.version} 虚拟环境` });
    else await must(s, base.cmd, [...base.args, '-m', 'venv', venv], { timeout: 5 * 60_000, env, what: '建虚拟环境（python -m venv）' });
  }
  const py = venvPython(venv);
  const writeStamp = state => { try { fs.writeFileSync(path.join(venv, STAMP), JSON.stringify({ state, lockSha256: lockSha, python: spec.python.version, installer: uv ? 'uv' : 'pip', at: new Date().toISOString() }, null, 2) + '\n'); } catch { /* 只读的旧环境 */ } };
  if (exact) writeStamp('installing');
  if (uv) {
    await must(s, uv, ['pip', exact ? 'sync' : 'install', '--python', py, '--require-hashes', '--only-binary', ':all:', '--compile-bytecode', ...(exact ? [lockPath] : ['-r', lockPath])], { timeout: 20 * 60_000, env, what: '按锁文件安装 Python 依赖' });
  } else {
    await must(s, py, ['-m', 'pip', 'install', '--require-hashes', '--only-binary', ':all:', '-r', lockPath], { timeout: 20 * 60_000, env, what: '按锁文件安装 Python 依赖（pip）' });
  }
  log('   预先导入一次（新环境第一次加载原生库较慢，之后 1–2 秒）…');
  const v = await verifyVenv(venv, spec);
  if (!v.ok) throw Object.assign(new CliError(EXIT.FAIL, 'step-failed', `装完核对没通过：${v.found}`, '加 --recreate-venv 重跑；仍失败时把这段输出连同平台信息报给维护者'), { step: s });
  if (exact) writeStamp('ok');
  st = await venvState(venv, spec, lockSha);
  finishStep(s, 'done', `${uv ? 'uv' : 'pip'}：${v.found}${v.detail ? `；${v.detail}` : ''}`);
}

async function stepHooks(o) {
  const s = step('hooks', 'git 钩子（.githooks）');
  if (o['no-hooks']) return finishStep(s, 'skipped', '--no-hooks');
  if (!fs.existsSync(path.join(ROOT, '.githooks'))) return finishStep(s, 'skipped', '仓库里还没有 .githooks/');
  const cur = await run('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT });
  if (cur.error) return finishStep(s, 'skipped', '没有 git');
  if (cur.stdout.trim() === '.githooks') return finishStep(s, 'skipped', 'core.hooksPath 已是 .githooks');
  if (o['dry-run']) return finishStep(s, 'planned', 'git config core.hooksPath .githooks');
  await must(s, 'git', ['config', 'core.hooksPath', '.githooks'], { timeout: 10_000, what: '设置 git 钩子' });
  finishStep(s, 'done', 'core.hooksPath = .githooks（提交前运行仓库规范检查）');
}

export async function setup(o = {}) {
  const spec = C.loadSpec(ROOT);
  const node = C.checkNode(spec);
  if (!node.ok) throw new CliError(EXIT.ENV, 'node-too-old', `Node ${node.found} 太旧，需要 ${node.expected}`, node.fix);
  await stepNpm(o, spec);
  await stepBrowser(o, spec);
  await stepPython(o, spec);
  await stepHooks(o);
}

if (isMain(import.meta.url)) {
  runCli({
    command: 'setup', help: HELP,
    options: {
      'dry-run': { type: 'boolean' }, 'skip-npm': { type: 'boolean' }, 'skip-browser': { type: 'boolean' }, 'skip-python': { type: 'boolean' },
      'with-deps': { type: 'boolean' }, 'recreate-venv': { type: 'boolean' }, 'no-uv': { type: 'boolean' }, python: { type: 'string' }, 'no-hooks': { type: 'boolean' },
      venv: { type: 'string' },
    },
    run: async (o) => {
      const t0 = Date.now();
      try {
        await setup(o);
      } catch (e) {
        if (e.step && e.step.status === 'pending') { e.step.status = 'failed'; e.step.detail = e.message; e.step.ms = Date.now() - (e.step.t0 || Date.now()); delete e.step.t0; }
        e.steps = steps;
        throw Object.assign(e, { extra: { steps } });
      }
      const seconds = +((Date.now() - t0) / 1000).toFixed(1);
      const ran = steps.filter(s => s.status === 'done').map(s => s.id);
      return {
        steps, seconds, dryRun: !!o['dry-run'],
        human: `${o['dry-run'] ? '演练完成（没有改动任何东西）' : '环境就绪'}：${steps.map(s => `${s.id} ${({ done: '完成', skipped: '跳过', planned: '计划' })[s.status] || s.status}`).join('，')}；用时 ${seconds} 秒。${ran.length || o['dry-run'] ? '' : '（全部已满足，没有下载）'}\n下一步：npm run env:doctor`,
      };
    },
  });
}
