import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import {
  buildContainerSpec,
  detectSandboxBackend,
  enforceAuthorMode,
  planSandboxExec,
  resolveWorkspace,
  runInWorkspaceSandbox,
  validateContainerSpec,
  WarmProcessPool,
} from './sandbox.mjs';
import { formatRedTeamReport, runSandboxRedTeam } from './sandbox-redteam.mjs';

const ITEM_IDS = ['cross_workspace_read', 'host_home_and_secrets', 'external_network', 'cross_workspace_processes', 'readonly_image_write'];
// 测试里的外网目标用文档保留地址与保留域名，放开网络的变异也不会真的连出去。
const OFFLINE = { externalTarget: '192.0.2.1:443', dnsName: 'example.invalid' };
const seatbelt = detectSandboxBackend().backend === 'darwin-seatbelt';
const seatbeltOnly = { skip: seatbelt ? false : '本机没有可用的 sandbox-exec（不是 macOS，或已经在沙箱里）' };
const ociImage = process.env.BEIMING_SANDBOX_OCI_IMAGE;
// libuv 在 Windows 上起子进程时，这些变量没给就从父进程补（deps/uv/src/win/process.c 的 required_vars）。
const WIN_REQUIRED_VARS = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];

// 夹具路径故意不规范化：Windows 上 os.tmpdir() 是 8.3 短路径（RUNNER~1），被测代码要自己认出来。
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-a13-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(base, 'workspaces');
  const own = path.join(root, 'ws-a');
  const sibling = path.join(root, 'ws-b');
  const app = path.join(base, 'app');
  for (const dir of [own, sibling, app]) fs.mkdirSync(dir, { recursive: true });
  return { base, root, own, sibling, app, options: { workspacesRoot: root, workspaceDir: own, appDir: app, command: ['node', '/app/job.mjs'] } };
}

function trySymlink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

const refuses = (code) => (error) => error.code === code;

// 红队每一项该有的子尝试，测试自己留一份：探针和判定一起少了一个，这里对不上。
const EXPECTED_ATTEMPTS = {
  cross_workspace_read: ['absolute-path', 'relative-path', 'planted-symlink-file', 'planted-symlink-dir', 'list-workspaces-root'],
  host_home_and_secrets: ['ssh-private-key', 'aws-credentials', 'real-home', 'real-home-ssh', 'real-home-aws', 'real-home-gnupg', 'real-home-config', 'env-secrets'],
  external_network: ['loopback-tcp', 'loopback-http', 'external-tcp', 'dns-lookup'],
  cross_workspace_processes: ['ps-by-pid', 'ps-scan', 'proc-cmdline', 'proc-environ', 'signal-0', 'warm-process-residue'],
  readonly_image_write: ['app-overwrite', 'app-create', 'root-create', 'sibling-create', 'host-home-create'],
};

// 假沙箱：不起进程，照探针的输出格式交回「全部尝试都失败」，drop 里的子尝试不交。只用来测报告的判定。
// tamper 在交回之前改这一项的回执（attempts 可以整个换掉，code 是探针退出码）。
function fakeBlockedRun(drop = [], tamper = () => {}) {
  return async ({ command }) => {
    const item = command[3];
    const receipt = {
      item,
      code: 1,
      attempts: EXPECTED_ATTEMPTS[item]
        .filter((id) => id !== 'warm-process-residue' && !drop.includes(id))
        .map((id) => ({ id, payload: id, ok: false, code: 'EPERM' })),
    };
    await tamper(receipt, JSON.parse(command[4]));
    const stdout = `${JSON.stringify({ sentinel: 'bm-sandbox-redteam/0.1', item, control: true, attempts: receipt.attempts })}\n`;
    return { backend: 'darwin-seatbelt', isolation: 'seatbelt-process-policy', code: receipt.code, stdout, stderr: '' };
  };
}

// 宿主机环境里此刻挂着的红队诱饵：键以 BEIMING_REDTEAM_ 开头、值是夹具埋的随机标记。
const canaries = () => Object.entries(process.env).filter(([key, value]) => key.startsWith('BEIMING_REDTEAM_') && value.startsWith('bm-canary-')).sort();

// 把家目录换成夹具里的假家目录（os.homedir() 在 POSIX 上读 HOME，在 Windows 上读 USERPROFILE）。
function fakeHome(t, base) {
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

test('A13-Red 工作区容器隔离规格、空进程预热池与五项红队逃逸套件存在且五项全拦', async () => {
  assert.equal(typeof buildContainerSpec, 'function');
  assert.equal(typeof validateContainerSpec, 'function');
  assert.equal(typeof WarmProcessPool, 'function');
  assert.equal(typeof runInWorkspaceSandbox, 'function');
  assert.equal(typeof runSandboxRedTeam, 'function');
});

test('A13-1 U8 守卫只收「卡加数据」：构建脚本、原生代码、入口文件、自带命令与非数据文件一律拒收', () => {
  const ok = { mode: 'cards-data', files: ['film.json', 'assets/hero.glb', 'audio/bed.WAV'] };
  assert.equal(enforceAuthorMode(ok), ok);
  const rejected = [
    undefined,
    {},
    { mode: 'build-script' },
    { mode: 'native-code' },
    { mode: 'cards-data', entry: 'shots/s01.js' },
    { mode: 'cards-data', command: ['sh', '-c', 'id'] },
    { mode: 'cards-data', files: 'film.json' },
    { mode: 'cards-data', files: ['build.mjs'] },
    { mode: 'cards-data', files: ['tools/run.py'] },
    { mode: 'cards-data', files: ['bin\\evil.exe'] },
    { mode: 'cards-data', files: ['Makefile'] },
    { mode: 'cards-data', files: ['data.json:evil.sh'] },
    { mode: 'cards-data', files: ['data.json '] },
    { mode: 'cards-data', files: [42] },
  ];
  for (const request of rejected) {
    assert.throws(() => enforceAuthorMode(request), refuses('contract.unsupported-mode'), JSON.stringify(request));
  }
});

test('A13-2 工作区只认工作区根的直接子目录：根本身、嵌套目录、根外目录、.. 段与符号链接都拒收', (t) => {
  const { base, root, own, sibling } = fixture(t);
  const resolved = resolveWorkspace({ workspacesRoot: root, workspaceDir: own });
  assert.equal(resolved.workspaceId, 'ws-a');
  assert.equal(resolved.root, fs.realpathSync.native(root));
  assert.equal(resolved.dir, fs.realpathSync.native(own));
  assert.equal(resolveWorkspace({ workspacesRoot: root, workspaceDir: `${own}${path.sep}` }).workspaceId, 'ws-a');

  fs.mkdirSync(path.join(own, 'nested'));
  fs.mkdirSync(path.join(root, 'Bad_Name'));
  fs.writeFileSync(path.join(root, 'file'), '');
  const bad = [
    root,
    base,
    path.join(own, 'nested'),
    path.join(root, 'Bad_Name'),
    path.join(root, 'file'),
    path.join(root, 'missing'),
    `${own}${path.sep}..${path.sep}ws-b`,
    `${own}\\..\\ws-b`,
  ];
  for (const workspaceDir of bad) {
    assert.throws(() => resolveWorkspace({ workspacesRoot: root, workspaceDir }), refuses('contract.bad-path'), workspaceDir);
  }
  assert.throws(() => resolveWorkspace({ workspacesRoot: root }), refuses('usage.bad-argument'));
  // 工作区根设成家目录的上一级时，家目录会被当成工作区挂进去。
  const home = fs.realpathSync.native(os.homedir());
  assert.throws(() => resolveWorkspace({ workspacesRoot: path.dirname(home), workspaceDir: home }), refuses('contract.bad-path'));

  const link = path.join(root, 'ws-link');
  if (trySymlink(sibling, link, 'junction')) {
    assert.throws(() => resolveWorkspace({ workspacesRoot: root, workspaceDir: link }), refuses('contract.bad-path'));
    assert.throws(() => resolveWorkspace({ workspacesRoot: root, workspaceDir: `${link}${path.sep}` }), refuses('contract.bad-path'));
  }
});

test('A13-3 Windows 8.3 短路径与反斜杠：同一目录的另一种写法认成同一个工作区，挂载源一律是规范化后的真实路径', (t) => {
  const { base, root, own, app, options } = fixture(t);
  const real = { root: fs.realpathSync.native(root), own: fs.realpathSync.native(own), app: fs.realpathSync.native(app) };
  const sources = (spec) => spec.mounts.map((mount) => mount.source);

  // 夹具用的是没规范化的 os.tmpdir()：在 Windows 运行器上它就是 RUNNER~1 这样的 8.3 短路径。
  assert.deepEqual(sources(buildContainerSpec(options)), [real.own, real.app]);

  // 别名目录模拟 8.3 短名：父级换一种写法，指的还是同一个目录。
  const alias = path.join(base, 'WORKSP~1');
  if (trySymlink(root, alias, 'junction')) {
    for (const [workspacesRoot, workspaceDir] of [[alias, path.join(alias, 'ws-a')], [alias, own], [root, path.join(alias, 'ws-a')]]) {
      const spec = buildContainerSpec({ ...options, workspacesRoot, workspaceDir });
      assert.equal(spec.workspaceId, 'ws-a');
      assert.equal(spec.workspacesRoot, real.root);
      assert.deepEqual(sources(spec), [real.own, real.app]);
      assert.deepEqual(validateContainerSpec(spec), []);
    }
  }

  if (process.platform === 'win32') {
    const forward = (file) => file.replaceAll('\\', '/');
    const spec = buildContainerSpec({ ...options, workspacesRoot: forward(root), workspaceDir: forward(own), appDir: forward(app) });
    assert.deepEqual(sources(spec), [real.own, real.app]);
    assert.ok(sources(spec).every((source) => source.includes('\\') && !source.includes('~')));
  }

  // 宿主机后端把容器内路径换成本机路径，分隔符跟着平台走。
  const plan = planSandboxExec(buildContainerSpec({ ...options, command: ['node', '/app/lib/job.mjs', '/workspace/film.json', '/tmp/out'] }), {
    backend: 'portable', allowDegraded: true, tmpDir: path.join(base, 'tmp'),
  });
  assert.deepEqual(plan.args, [path.join(real.app, 'lib', 'job.mjs'), path.join(real.own, 'film.json'), path.join(base, 'tmp', 'out')]);
  assert.equal(plan.cwd, real.own);
  assert.equal(plan.env.HOME, path.join(base, 'tmp', 'home'));
  assert.equal(plan.env.BEIMING_APP, real.app);
});

test('A13-4 隔离规格：一次性容器、无网络、只读根、丢全部 capability、非 root，只挂本工作区与只读引擎目录，不带宿主机环境变量', (t) => {
  const { options } = fixture(t);
  process.env.BM_A13_HOST_TOKEN = 'host-secret-value';
  t.after(() => delete process.env.BM_A13_HOST_TOKEN);

  const spec = buildContainerSpec({ ...options, image: 'node:24-slim' });
  assert.deepEqual(validateContainerSpec(spec), []);
  assert.match(spec.containerName, /^bm-ws-ws-a-[a-f0-9]{8}$/);
  assert.notEqual(buildContainerSpec(options).containerName, spec.containerName);

  const { file, args, isolation } = planSandboxExec(spec, { backend: 'oci', runtime: 'podman' });
  assert.equal(file, 'podman');
  assert.equal(isolation, 'oci-container');
  for (const flag of ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit', '--user']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.doesNotMatch(args[args.indexOf('--user') + 1], /^0:/);
  assert.equal(args[args.indexOf('--name') + 1], spec.containerName);
  assert.deepEqual(args.filter((arg) => arg.startsWith('type=bind')), [
    `type=bind,source=${spec.mounts[0].source},target=/workspace`,
    `type=bind,source=${spec.mounts[1].source},target=/app,readonly`,
  ]);
  assert.equal(args[args.indexOf('--tmpfs') + 1].split(':')[0], '/tmp');
  assert.deepEqual(args.slice(args.indexOf('node:24-slim')), ['node:24-slim', 'node', '/app/job.mjs']);
  assert.deepEqual(args.filter((arg, index) => args[index - 1] === '--env').map((pair) => pair.split('=')[0]),
    ['HOME', 'TMPDIR', 'LC_ALL', 'PATH', 'BEIMING_WORKSPACE', 'BEIMING_APP']);
  for (const backend of ['oci', 'darwin-seatbelt', 'portable']) {
    const plan = planSandboxExec(spec, { backend, allowDegraded: true, tmpDir: os.tmpdir() });
    assert.ok(!JSON.stringify([plan.args, plan.env ?? {}]).includes('host-secret-value'), backend);
    assert.ok(!Object.keys(plan.env ?? {}).some((key) => /TOKEN|KEY|SECRET|^AWS_|^SSH_/.test(key)), backend);
  }
  assert.throws(() => planSandboxExec(buildContainerSpec(options), { backend: 'oci' }), refuses('usage.bad-argument'));
  assert.throws(() => planSandboxExec(spec, { backend: 'chroot' }), refuses('usage.bad-argument'));
});

test('A13-5 规格校验：去掉任何一条防线都判不合格', (t) => {
  const { options, sibling, root, base } = fixture(t);
  const home = fs.realpathSync.native(os.homedir());
  const mutations = {
    放开网络: (spec) => { spec.network = 'host'; },
    根文件系统可写: (spec) => { spec.readOnlyRoot = false; },
    留着capability: (spec) => { spec.capDrop = []; },
    关掉seccomp: (spec) => { spec.securityOpt.push('seccomp=unconfined'); },
    用root跑: (spec) => { spec.user = '0:0'; },
    不限进程数: (spec) => { spec.pidsLimit = 0; },
    多一个tmpfs: (spec) => { spec.tmpfs.push('/run'); },
    带进宿主机环境变量: (spec) => { spec.env.AWS_SECRET_ACCESS_KEY = 'x'; },
    挂上兄弟工作区: (spec) => { spec.mounts.push({ source: fs.realpathSync.native(sibling), target: '/sibling', readOnly: true }); },
    挂上DockerSocket: (spec) => { spec.mounts.push({ source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false }); },
    挂上家目录: (spec) => { spec.mounts.push({ source: home, target: '/home', readOnly: true }); },
    换成兄弟工作区: (spec) => { spec.mounts[0].source = fs.realpathSync.native(sibling); },
    换成整个工作区根: (spec) => { spec.mounts[0].source = fs.realpathSync.native(root); },
    引擎目录可写: (spec) => { spec.mounts[1].readOnly = false; },
    引擎目录包住工作区根: (spec) => { spec.mounts[1].source = fs.realpathSync.native(base); },
    引擎目录是家目录: (spec) => { spec.mounts[1].source = home; },
    容器名不绑工作区: (spec) => { spec.containerName = 'bm-ws-ws-b-00000000'; },
    镜像名夹带选项: (spec) => { spec.image = '--privileged'; },
    换掉可执行文件: (spec) => { spec.command = ['sh', '-c', 'id']; },
    换工作目录: (spec) => { spec.workdir = '/'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const spec = buildContainerSpec(options);
    mutate(spec);
    assert.notDeepEqual(validateContainerSpec(spec), [], name);
  }
  assert.notDeepEqual(validateContainerSpec(undefined), []);
  // 建规格时同样把关：引擎目录包住工作区根、放在工作区里、或者不存在，都不出规格。
  for (const appDir of [base, path.join(root, 'ws-b'), path.join(base, 'missing'), '/']) {
    assert.throws(() => buildContainerSpec({ ...options, appDir }), refuses('usage.bad-argument'), appDir);
  }
});

test('A13-6 预热池：进程预热时不绑工作区，借给一个工作区用一次就销毁，绝不回到池里', () => {
  const spawned = [];
  const destroyed = [];
  const pool = new WarmProcessPool({
    size: 2,
    spawn: (...args) => {
      assert.deepEqual(args, [], '预热时不得带任何工作区信息');
      spawned.push({ id: spawned.length });
      return spawned.at(-1);
    },
    destroy: (child) => destroyed.push(child),
  }).warm();
  assert.equal(pool.idle, 2);

  const first = pool.acquire('ws-a');
  assert.equal(first.process, spawned[0]);
  assert.equal(pool.idle, 1);
  first.release();
  first.release();
  assert.deepEqual(destroyed, [spawned[0]], '归还即销毁，重复归还不重复销毁');
  assert.equal(pool.idle, 2);

  const seen = new Set([first.process]);
  for (const workspaceId of ['ws-b', 'ws-a', 'ws-c', 'ws-a']) {
    const lease = pool.acquire(workspaceId);
    assert.ok(!seen.has(lease.process), `${workspaceId} 借到了别人用过的进程`);
    seen.add(lease.process);
    lease.release();
  }
  assert.equal(destroyed.length, 5);

  const held = pool.acquire('ws-a');
  pool.close();
  assert.equal(pool.idle, 0);
  held.release();
  assert.equal(pool.idle, 0, '关池之后不再补进程');
  assert.equal(destroyed.length, spawned.length);

  assert.throws(() => pool.acquire('../ws-b'), refuses('usage.bad-argument'));
  assert.throws(() => new WarmProcessPool({}), refuses('usage.bad-argument'));
});

test('A13-7 执行入口：先过 U8 守卫；没有内核级隔离默认拒跑', async (t) => {
  const { options } = fixture(t);
  await assert.rejects(runInWorkspaceSandbox({ ...options, request: { mode: 'build-script' } }), refuses('contract.unsupported-mode'));
  await assert.rejects(runInWorkspaceSandbox({ ...options }), refuses('contract.unsupported-mode'));
  await assert.rejects(runInWorkspaceSandbox({ ...options, request: { mode: 'cards-data' }, backend: 'portable' }), refuses('env.missing-tool'));
  await assert.rejects(runInWorkspaceSandbox({ ...options, request: { mode: 'cards-data' }, timeoutMs: 0 }), refuses('usage.bad-argument'));
});

test('A13-8 降级后端真跑：环境变量剥干净、容器内路径换成本机路径，结果如实标 needs-oci-runtime', async (t) => {
  const { options, app, own } = fixture(t);
  process.env.BM_A13_HOST_TOKEN = 'host-secret-value';
  t.after(() => delete process.env.BM_A13_HOST_TOKEN);
  fs.writeFileSync(path.join(app, 'job.mjs'), [
    "import fs from 'node:fs';",
    "fs.writeFileSync('out.json', JSON.stringify({ cwd: process.cwd(), env: process.env, arg: process.argv[2] }));",
    "fs.writeFileSync(process.env.TMPDIR + '/scratch.txt', 'x');",
    "console.log('done');",
  ].join('\n'));
  const result = await runInWorkspaceSandbox({
    ...options, command: ['node', '/app/job.mjs', '/workspace/film.json'], request: { mode: 'cards-data' }, backend: 'portable', allowDegraded: true,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'done');
  assert.equal(result.isolation, 'needs-oci-runtime');
  assert.equal(result.workspaceId, 'ws-a');
  const seen = JSON.parse(fs.readFileSync(path.join(own, 'out.json'), 'utf8'));
  const realOwn = fs.realpathSync.native(own);
  assert.equal(fs.realpathSync.native(seen.cwd), realOwn);
  assert.equal(seen.arg, path.join(realOwn, 'film.json'));
  assert.equal(seen.env.BM_A13_HOST_TOKEN, undefined);
  assert.equal(seen.env.BEIMING_WORKSPACE, realOwn);
  assert.notEqual(seen.env.HOME, os.homedir());
  assert.ok(!fs.existsSync(seen.env.TMPDIR), '专属临时目录跑完要删掉');
  const allowed = new Set(['HOME', 'TMPDIR', 'LC_ALL', 'PATH', 'BEIMING_WORKSPACE', 'BEIMING_APP', 'SYSTEMROOT', '__CF_USER_TEXT_ENCODING']);
  // Windows 上 libuv 起子进程时，required_vars 里没给的变量会从父进程补进去：这些键要在，值要是沙箱自己的。
  if (process.platform === 'win32') {
    for (const key of WIN_REQUIRED_VARS) allowed.add(key);
    allowed.add('TMP');
    assert.deepEqual([seen.env.USERPROFILE, seen.env.TEMP, seen.env.USERNAME], [seen.env.HOME, seen.env.TMPDIR, 'sandbox']);
  }
  assert.deepEqual(Object.keys(seen.env).filter((key) => !allowed.has(key.toUpperCase()) && !allowed.has(key)), []);
});

test('A13-8b win32 的降级后端把 libuv 会自动继承的变量逐个盖成沙箱自己的值或中性值，宿主机的家目录与用户名不透传', (t) => {
  const { options } = fixture(t);
  const spec = buildContainerSpec(options);
  const tmpDir = path.join(os.tmpdir(), 'bm-a13-plan');
  const plan = (platform) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      return planSandboxExec(spec, { backend: 'portable', tmpDir, allowDegraded: true }).env;
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  };
  const env = plan('win32');
  const upper = Object.keys(env).map((key) => key.toUpperCase());
  assert.deepEqual(WIN_REQUIRED_VARS.filter((key) => !upper.includes(key)), [], 'libuv 的 required_vars 少盖一个就会从宿主机继承');
  assert.equal(new Set(upper).size, upper.length, 'Windows 的变量名不分大小写，不能重复');
  assert.deepEqual([env.USERPROFILE, env.HOMEDRIVE + env.HOMEPATH, env.TEMP, env.TMP], [env.HOME, env.HOME, env.TMPDIR, env.TMPDIR]);
  assert.deepEqual([env.USERNAME, env.USERDOMAIN, env.LOGONSERVER], ['sandbox', 'SANDBOX', '\\\\SANDBOX']);
  assert.deepEqual([env.HOME, env.TMPDIR], [path.join(tmpDir, 'home'), tmpDir]);
  // 别的平台照旧，一个 Windows 变量也不多。
  assert.deepEqual(Object.keys(plan('linux')).filter((key) => key !== 'SystemRoot').sort(), Object.keys(spec.env).sort());
});

test('A13-9 降级后端的红队报告如实判红：环境变量拦得住，文件这一类拦不住，不把它说成容器', async () => {
  await assert.rejects(runSandboxRedTeam({ ...OFFLINE, backend: 'portable' }), refuses('env.missing-tool'));
  const report = await runSandboxRedTeam({ ...OFFLINE, backend: 'portable', allowDegraded: true });
  assert.equal(report.backend, 'portable');
  assert.equal(report.isolation, 'needs-oci-runtime');
  assert.equal(report.ok, false);
  assert.deepEqual(report.items.map((item) => item.id), ITEM_IDS);
  assert.ok(report.items.every((item) => item.conclusive || item.fixtureErrors.length), JSON.stringify(report.items.map((item) => item.exitCode)));
  const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
  assert.equal(byId.cross_workspace_read.escaped, true);
  assert.equal(byId.readonly_image_write.escaped, true);
  assert.equal(byId.host_home_and_secrets.attempts.find((entry) => entry.id === 'env-secrets').escaped, false);
  assert.equal(byId.cross_workspace_processes.attempts.find((entry) => entry.id === 'warm-process-residue').escaped, false);
  assert.match(report.boundary, /needs-oci-runtime/);
  assert.match(formatRedTeamReport(report), /判红/);
});

test('A13-10 macOS seatbelt 真跑：五项逃逸尝试全部被拦，报告逐项留痕且不带本机路径', seatbeltOnly, async () => {
  const report = await runSandboxRedTeam(OFFLINE);
  assert.equal(report.backend, 'darwin-seatbelt');
  assert.equal(report.isolation, 'seatbelt-process-policy');
  assert.deepEqual(report.items.map((item) => item.id), ITEM_IDS);
  for (const item of report.items) {
    assert.equal(item.conclusive, true, `${item.id} 结论无效，退出码 ${item.exitCode}`);
    assert.equal(item.escaped, false, `${item.id} 逃逸：${JSON.stringify(item.attempts)}`);
    assert.equal(item.exitCode, 1);
    assert.ok(item.blockedBy && item.command);
    assert.deepEqual(item.attempts.map((entry) => entry.id), EXPECTED_ATTEMPTS[item.id]);
    assert.deepEqual([item.blocked, item.missingAttempts, item.fixtureErrors], [true, [], []]);
  }
  assert.deepEqual([report.ok, report.blocked, report.total], [true, 5, 5]);
  assert.match(report.boundary, /不是 Linux 命名空间容器/);
  const text = JSON.stringify(report) + formatRedTeamReport(report);
  assert.ok(!text.includes(os.homedir()) && !text.includes(fs.realpathSync.native(os.tmpdir())), '报告里不得有本机路径');
  assert.equal(formatRedTeamReport(report).split('\n').filter((line) => /^\| \d \|/.test(line)).length, 5);
});

// 负向变异：按被改坏的规格真起一个 seatbelt 沙箱（绕过 runInWorkspaceSandbox 里的校验），红队必须检出逃逸。
function weakened(mutate) {
  return async ({ request, backend, runtime, allowDegraded, timeoutMs, ...specOptions }) => {
    enforceAuthorMode(request);
    const spec = buildContainerSpec(specOptions);
    mutate(spec, specOptions);
    assert.notDeepEqual(validateContainerSpec(spec), [], '被改坏的规格必须过不了静态校验');
    const tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-a13-weak-')));
    fs.mkdirSync(path.join(tmpDir, 'home'));
    const plan = planSandboxExec(spec, { backend: 'darwin-seatbelt', tmpDir });
    try {
      return await new Promise((resolve) => {
        execFile(plan.file, plan.args, { env: plan.env, cwd: plan.cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
          resolve({ backend: plan.backend, isolation: plan.isolation, code: error ? error.code : 0, stdout, stderr });
        });
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

const MUTATIONS = {
  放开网络: { item: 'external_network', mutate: (spec) => { spec.network = 'host'; } },
  漏剥离宿主机环境变量: { item: 'host_home_and_secrets', mutate: (spec) => { spec.env = { ...process.env, ...spec.env }; } },
  挂上兄弟工作区让软链通到别的工作区: {
    item: 'cross_workspace_read',
    mutate: (spec) => {
      const sibling = fs.readdirSync(spec.workspacesRoot).find((name) => name.startsWith('ws-b-'));
      spec.mounts.push({ source: path.join(spec.workspacesRoot, sibling), target: '/sibling', readOnly: true });
    },
  },
  把只读引擎目录挂成可写: { item: 'readonly_image_write', mutate: (spec) => { spec.mounts[1].readOnly = false; } },
};

for (const [name, { item, mutate }] of Object.entries(MUTATIONS)) {
  test(`A13-11 负向变异「${name}」：红队在 ${item} 上检出逃逸并判红`, seatbeltOnly, async () => {
    const report = await runSandboxRedTeam({ ...OFFLINE, run: weakened(mutate) });
    const hit = report.items.find((entry) => entry.id === item);
    assert.equal(hit.escaped, true, JSON.stringify(hit));
    assert.equal(report.ok, false);
    assert.ok(report.blocked < 5);
    for (const other of report.items.filter((entry) => entry.id !== item)) {
      assert.equal(other.escaped, false, `变异只该打穿 ${item}，${other.id} 也逃逸了：${JSON.stringify(other.attempts)}`);
    }
  });
}

test('A13-12 负向变异「复用脏预热进程」：工作区 B 用过的进程再分给工作区 A，红队读到残留并判红', async () => {
  // 坏池：归还不销毁，下一个工作区借到同一个进程。
  const dirtyPool = (spawnWorker) => {
    let child;
    return {
      acquire: () => ({ process: (child ??= spawnWorker()), release() {} }),
      close: () => child?.kill('SIGKILL'),
    };
  };
  const options = seatbelt ? OFFLINE : { ...OFFLINE, backend: 'portable', allowDegraded: true };
  const report = await runSandboxRedTeam({ ...options, makePool: dirtyPool });
  const processes = report.items.find((item) => item.id === 'cross_workspace_processes');
  const residue = processes.attempts.find((entry) => entry.id === 'warm-process-residue');
  assert.deepEqual([residue.code, residue.escaped], ['RESIDUE', true]);
  assert.equal(processes.escaped, true);
  assert.equal(report.ok, false);
});

test('A13-13 OCI 容器真跑（要给 BEIMING_SANDBOX_OCI_IMAGE）：五项逃逸尝试全部被拦', {
  skip: ociImage ? false : '没有设 BEIMING_SANDBOX_OCI_IMAGE（带 node 的本地镜像名），不拉镜像、不真跑容器',
}, async () => {
  const report = await runSandboxRedTeam({ ...OFFLINE, backend: 'oci', runtime: process.env.BEIMING_SANDBOX_OCI_RUNTIME, image: ociImage });
  assert.equal(report.isolation, 'oci-container');
  assert.deepEqual(report.items.filter((item) => !item.conclusive || item.escaped), []);
  assert.equal(report.ok, true);
});

test('A13-14 U8 守卫查到镜头里：shot、shot.renderer、film.shots[] 的 mode 与 entry 都查，只认普通对象的自有属性', () => {
  const shot = { id: 's01', source: 'three', mode: 'cards-data' };
  const ok = { mode: 'cards-data', shot: { ...shot, renderer: { source: 'three', host: 'page', mode: 'cards-data' } }, film: { shots: [shot, { ...shot, id: 's02' }] } };
  assert.equal(enforceAuthorMode(ok), ok);
  assert.equal(enforceAuthorMode(JSON.parse(JSON.stringify(ok))).mode, 'cards-data');

  const inherit = (proto, own = {}) => Object.assign(Object.create(proto), own);
  class Request { mode = 'cards-data'; }
  const rejected = {
    'shot.mode 是 native-code': { mode: 'cards-data', shot: { ...shot, mode: 'native-code' } },
    'shot.mode 没写': { mode: 'cards-data', shot: { id: 's01' } },
    'shot.entry 出现': { mode: 'cards-data', shot: { ...shot, entry: 'shots/s01.js' } },
    'shot.entry 是 undefined 也算出现': { mode: 'cards-data', shot: { ...shot, entry: undefined } },
    'shot.renderer.mode 是 native-code': { mode: 'cards-data', shot: { ...shot, renderer: { mode: 'native-code' } } },
    'shot.renderer.mode 没写': { mode: 'cards-data', shot: { ...shot, renderer: { source: 'three' } } },
    'shot.renderer.entry 出现': { mode: 'cards-data', shot: { ...shot, renderer: { mode: 'cards-data', entry: 'build.mjs' } } },
    'shot.renderer 不是对象': { mode: 'cards-data', shot: { ...shot, renderer: 'native-code' } },
    'shot 不是对象': { mode: 'cards-data', shot: 'cards-data' },
    'shot 是数组': { mode: 'cards-data', shot: [shot] },
    '请求顶层的 renderer': { mode: 'cards-data', renderer: { mode: 'build-script', entry: 'make.js' } },
    'film.shots[] 里有 build-script': { mode: 'cards-data', film: { shots: [shot, { ...shot, mode: 'build-script', entry: 'make.js' }] } },
    'film.shots[] 里镜头的 renderer 是 native-code': { mode: 'cards-data', film: { shots: [{ ...shot, renderer: { mode: 'native-code', entry: 'a.js' } }] } },
    'film.shots[] 有空位': { mode: 'cards-data', film: { shots: [shot, null] } },
    'film.shots 不是数组': { mode: 'cards-data', film: { shots: { 0: shot } } },
    'film.shots 是空的': { mode: 'cards-data', film: { shots: [] } },
    'film 没有 shots': { mode: 'cards-data', film: {} },
    'film 不是对象': { mode: 'cards-data', film: 'film.json' },
    '请求的 mode 从原型链继承': Object.create({ mode: 'cards-data' }),
    '请求是类实例': new Request(),
    '请求是数组': Object.assign([], { mode: 'cards-data' }),
    '镜头的 mode 从原型链继承': { mode: 'cards-data', shot: inherit({ mode: 'cards-data' }, { id: 's01' }) },
    'renderer 的 mode 从原型链继承': { mode: 'cards-data', shot: { ...shot, renderer: inherit({ mode: 'cards-data' }) } },
    'film 的 shots 从原型链继承': { mode: 'cards-data', film: inherit({ shots: [shot] }) },
    'film.shots[] 里镜头的 mode 从原型链继承': { mode: 'cards-data', film: { shots: [inherit({ mode: 'cards-data' })] } },
  };
  for (const [name, request] of Object.entries(rejected)) {
    assert.throws(() => enforceAuthorMode(request), refuses('contract.unsupported-mode'), name);
  }
  // Object.prototype 被污染时，普通对象也会「继承」到 mode：照样只认自有属性。
  try {
    Object.defineProperty(Object.prototype, 'mode', { value: 'cards-data', configurable: true });
    for (const request of [{}, { mode: 'cards-data', shot: {} }, { mode: 'cards-data', shot: { ...shot, renderer: {} } }, { mode: 'cards-data', film: { shots: [{}] } }]) {
      assert.throws(() => enforceAuthorMode(request), refuses('contract.unsupported-mode'), JSON.stringify(request));
    }
  } finally {
    delete Object.prototype.mode;
  }
});

test('A13-15 U8 文件清单按工作区相对路径校验：.. 段、. 段、前导 /、反斜杠、控制字符（含 DEL）与经过符号链接的路径都拒收', async (t) => {
  const { options, own, sibling } = fixture(t);
  for (const file of ['../a.json', 'data/../../a.json', './a.json', 'data/./a.json', '/etc/a.json', 'data//a.json', 'data/a.json/',
    'data\\a.json', 'data:a.json', 'a\r.json', 'a\n.json', 'a\u0000.json', 'nul.json',
    'a\u001f.json', 'a\u007f.json', '\u007f.json', 'data\u007f/a.json', 'a.json\u007f', 'a.json\n']) {
    assert.throws(() => enforceAuthorMode({ mode: 'cards-data', files: [file] }), refuses('contract.bad-path'), JSON.stringify(file));
  }
  assert.throws(() => enforceAuthorMode(Object.assign(Object.create({ files: [] }), { mode: 'cards-data' })), refuses('contract.unsupported-mode'));

  // 清单里的路径在词法上没毛病，却经过工作区里一个指向兄弟工作区的目录链接：执行入口对着真实工作区再查一遍。
  fs.writeFileSync(path.join(sibling, 'secret.json'), '{}');
  if (trySymlink(sibling, path.join(own, 'escape-dir'), 'junction')) {
    const request = { mode: 'cards-data', files: ['escape-dir/secret.json'] };
    assert.equal(enforceAuthorMode(request), request);
    assert.throws(() => enforceAuthorMode(request, own), refuses('contract.bad-path'));
    await assert.rejects(runInWorkspaceSandbox({ ...options, request, backend: 'portable', allowDegraded: true }), refuses('contract.bad-path'));
  }
});

test('A13-16 后端名默认拒绝：只认三个自有名字，原型链上的键与未知字符串在规划和执行两处都报错；portable 要亲手写 allowDegraded: true', async (t) => {
  const { base, options } = fixture(t);
  const spec = buildContainerSpec({ ...options, image: 'node:24-slim' });
  const tmpDir = path.join(base, 'tmp');
  const request = { mode: 'cards-data' };
  fs.writeFileSync(path.join(options.appDir, 'job.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('ran.txt', 'x');\n");
  const ran = () => fs.existsSync(path.join(options.workspaceDir, 'ran.txt'));

  for (const backend of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'chroot', 'OCI', 'portable ', '', null, 0, ['portable'], { toString: () => 'oci' }]) {
    const name = JSON.stringify(backend) ?? String(backend);
    assert.throws(() => planSandboxExec(spec, { backend, tmpDir, allowDegraded: true }), refuses('usage.bad-argument'), name);
    await assert.rejects(runInWorkspaceSandbox({ ...options, request, backend, allowDegraded: true }), refuses('usage.bad-argument'), name);
  }
  assert.throws(() => planSandboxExec(spec, { tmpDir, allowDegraded: true }), refuses('usage.bad-argument'));

  // allowDegraded 必须是调用方自己写上的布尔值 true：真值、字符串、从原型链继承来的都不算。
  for (const allowDegraded of [undefined, false, 1, 'true', {}, []]) {
    assert.throws(() => planSandboxExec(spec, { backend: 'portable', tmpDir, allowDegraded }), refuses('env.missing-tool'), String(allowDegraded));
    await assert.rejects(runInWorkspaceSandbox({ ...options, request, backend: 'portable', allowDegraded }), refuses('env.missing-tool'), String(allowDegraded));
  }
  const inherited = Object.assign(Object.create({ allowDegraded: true }), { backend: 'portable', tmpDir });
  assert.throws(() => planSandboxExec(spec, inherited), refuses('env.missing-tool'));
  await assert.rejects(
    runInWorkspaceSandbox(Object.assign(Object.create({ allowDegraded: true }), { ...options, request, backend: 'portable' })),
    refuses('env.missing-tool'),
  );
  assert.equal(ran(), false, '被拒的后端不得起过作业进程');

  // oci 的运行时只认 docker 与 podman，别的可执行文件不当容器运行时起。
  for (const runtime of ['sh', '/bin/sh', 'toString', '']) {
    assert.throws(() => planSandboxExec(spec, { backend: 'oci', runtime }), refuses('usage.bad-argument'), runtime);
  }
  assert.equal(planSandboxExec(spec, { backend: 'portable', tmpDir, allowDegraded: true }).isolation, 'needs-oci-runtime');
});

test('A13-17 挂载源不得含控制字符；工作区根之间、工作区根与引擎目录之间跨调用也不得互相包含', (t) => {
  const { base, options } = fixture(t);
  const spec = buildContainerSpec(options);
  for (const char of ['\r', '\n', '\t', '\u0000', '\u001b', '\u007f', ',', '"']) {
    const bad = structuredClone(spec);
    bad.mounts[1].source += `${char}x`;
    assert.ok(validateContainerSpec(bad).some((message) => /控制字符/.test(message)), JSON.stringify(char));
  }
  // 真有这样一个目录时（Windows 的文件名里放不进回车，建不出来就跳过）。
  const crRoot = path.join(base, 'work\rspaces');
  const made = (() => {
    try {
      fs.mkdirSync(path.join(crRoot, 'ws-a'), { recursive: true });
      return true;
    } catch {
      return false;
    }
  })();
  if (made) {
    assert.throws(() => buildContainerSpec({ ...options, workspacesRoot: crRoot, workspaceDir: path.join(crRoot, 'ws-a') }),
      (error) => error.code === 'usage.bad-argument' && /控制字符/.test(error.message));
  }

  // 父根先登记：再把它的一个工作区当成工作区根，两个可写挂载就一个套一个。
  const nestedRoot = options.workspaceDir;
  fs.mkdirSync(path.join(nestedRoot, 'nested'));
  assert.throws(() => buildContainerSpec({ ...options, workspacesRoot: nestedRoot, workspaceDir: path.join(nestedRoot, 'nested') }), refuses('contract.bad-path'));
  assert.throws(() => resolveWorkspace({ workspacesRoot: nestedRoot, workspaceDir: path.join(nestedRoot, 'nested') }), refuses('contract.bad-path'));
  // 子根先登记：再用包住它的目录当工作区根，同样拒收。
  const outer = path.join(base, 'outer');
  const inner = path.join(outer, 'tenant', 'spaces');
  fs.mkdirSync(path.join(inner, 'ws-a'), { recursive: true });
  buildContainerSpec({ ...options, workspacesRoot: inner, workspaceDir: path.join(inner, 'ws-a') });
  assert.throws(() => buildContainerSpec({ ...options, workspacesRoot: outer, workspaceDir: path.join(outer, 'tenant') }), refuses('contract.bad-path'));
  assert.throws(() => buildContainerSpec({ ...options, workspacesRoot: path.join(outer, 'tenant'), workspaceDir: inner }), refuses('contract.bad-path'));
  // 用过的引擎目录不能再当工作区根（它的子目录会被挂成可写）；登记过的工作区根也不能再当引擎目录。
  fs.mkdirSync(path.join(options.appDir, 'ws-x'));
  assert.throws(() => buildContainerSpec({ ...options, workspacesRoot: options.appDir, workspaceDir: path.join(options.appDir, 'ws-x'), appDir: path.join(base, 'outer') }), refuses('contract.bad-path'));
  assert.throws(() => buildContainerSpec({ ...options, appDir: path.join(inner, 'ws-a') }), refuses('usage.bad-argument'));
  // 没被拒的照旧能用：同一个根重复登记、互不包含的另一个根。
  assert.equal(buildContainerSpec(options).workspaceId, 'ws-a');
  assert.equal(buildContainerSpec({ ...options, workspaceDir: path.join(options.workspacesRoot, 'ws-b') }).workspaceId, 'ws-b');
});

test('A13-18 引擎目录与工作区都不得是根目录、家目录或家目录下点开头的配置与凭据目录', (t) => {
  const { base, options } = fixture(t);
  const home = fakeHome(t, base);
  const dirs = ['.ssh', '.aws', '.config', '.gnupg', '.claude', '.kube', path.join('.config', 'gcloud'), path.join('projects', '.secrets', 'engine'), path.join('projects', 'engine')];
  for (const dir of dirs) fs.mkdirSync(path.join(home, dir), { recursive: true });

  for (const dir of ['', ...dirs.slice(0, -1)]) {
    assert.throws(() => buildContainerSpec({ ...options, appDir: path.join(home, dir) }), refuses('usage.bad-argument'), `appDir=~/${dir}`);
    const spec = buildContainerSpec(options);
    spec.mounts[1].source = fs.realpathSync.native(path.join(home, dir));
    assert.notDeepEqual(validateContainerSpec(spec), [], `mounts[1].source=~/${dir}`);
  }
  for (const appDir of [path.parse(base).root, path.dirname(home)]) {
    assert.throws(() => buildContainerSpec({ ...options, appDir }), refuses('usage.bad-argument'), appDir);
  }
  // 家目录下不带点开头段的普通目录照旧能当引擎目录。
  assert.deepEqual(validateContainerSpec(buildContainerSpec({ ...options, appDir: path.join(home, 'projects', 'engine') })), []);

  // 工作区同理：~/.config 当工作区根时，~/.config/gcloud 会被挂成可写。
  assert.throws(() => resolveWorkspace({ workspacesRoot: path.join(home, '.config'), workspaceDir: path.join(home, '.config', 'gcloud') }), refuses('contract.bad-path'));
  assert.throws(() => resolveWorkspace({ workspacesRoot: path.dirname(home), workspaceDir: home }), refuses('contract.bad-path'));
});

test('A13-19 红队报告的完整性：子尝试少跑一个、攻击夹具没建起来，这一项都判结论无效并判红', async (t) => {
  // 假沙箱不读软链：先让建软链一律成功，没有建符号链接权限的 Windows 上结果也一样。
  const symlink = t.mock.method(fs, 'symlinkSync', () => {});
  const full = await runSandboxRedTeam({ ...OFFLINE, run: fakeBlockedRun() });
  assert.deepEqual([full.ok, full.blocked, full.total], [true, 5, 5]);
  for (const item of full.items) {
    assert.deepEqual(item.attempts.map((entry) => entry.id), EXPECTED_ATTEMPTS[item.id], item.id);
    assert.deepEqual([item.conclusive, item.escaped, item.blocked, item.missingAttempts, item.fixtureErrors], [true, false, true, [], []], item.id);
  }

  // 每一项各抽掉最后一个子尝试：只有这一项失效，其余四项照旧。
  for (const [id, expected] of Object.entries(EXPECTED_ATTEMPTS)) {
    const dropped = expected.filter((attempt) => attempt !== 'warm-process-residue').at(-1);
    const report = await runSandboxRedTeam({ ...OFFLINE, run: fakeBlockedRun([dropped]) });
    const hit = report.items.find((item) => item.id === id);
    assert.deepEqual([hit.conclusive, hit.blocked, hit.missingAttempts], [false, false, [dropped]], id);
    assert.deepEqual([report.ok, report.blocked], [false, 4], id);
    assert.match(formatRedTeamReport(report), new RegExp(`结论无效[^]*${dropped}`), id);
  }
  // 预热进程残留这一条是宿主机一侧补的：池子不肯借进程时不能悄悄少一条。
  const noPool = await runSandboxRedTeam({ ...OFFLINE, run: fakeBlockedRun(), makePool: () => ({ acquire() { throw new Error('池坏了'); }, close() {} }) })
    .then((report) => report.items.find((item) => item.id === 'cross_workspace_processes'), (error) => error);
  assert.ok(noPool instanceof Error || noPool.blocked === false, '预热池这一条没跑成时不得算拦住');

  // 软链夹具建不起来：两条软链尝试没有真打到靶子上，读别的工作区这一项证据不足。
  symlink.mock.mockImplementation(() => {
    throw Object.assign(new Error('没有建符号链接的权限'), { code: 'EPERM' });
  });
  const report = await runSandboxRedTeam({ ...OFFLINE, run: fakeBlockedRun() });
  const read = report.items.find((item) => item.id === 'cross_workspace_read');
  assert.deepEqual(read.fixtureErrors, ['planted-symlink-file: EPERM', 'planted-symlink-dir: EPERM']);
  assert.deepEqual([read.conclusive, read.blocked, read.escaped], [false, false, false]);
  assert.deepEqual([report.ok, report.blocked], [false, 4]);
  assert.match(formatRedTeamReport(report), /夹具没建起来[^]*planted-symlink-file: EPERM/);
});

test('A13-20 红队回执的完整性：子尝试缺 ok、被拦却没有错误码、探针退出码与明细矛盾，这一项都判结论无效并判红', async (t) => {
  t.mock.method(fs, 'symlinkSync', () => {});
  const id = 'external_network';
  const judge = async (tamper) => {
    const report = await runSandboxRedTeam({ ...OFFLINE, run: fakeBlockedRun([], (receipt) => (receipt.item === id ? tamper(receipt) : undefined)) });
    return { report, hit: report.items.find((item) => item.id === id) };
  };
  const first = (change) => (receipt) => { receipt.attempts[0] = change(receipt.attempts[0]); };

  const broken = {
    'ok 与 code 都没有': first(({ id: attempt, payload }) => ({ id: attempt, payload })),
    '没有 ok': first(({ ok, ...rest }) => rest),
    'ok 是字符串': first((entry) => ({ ...entry, ok: 'false' })),
    'ok 是 0': first((entry) => ({ ...entry, ok: 0 })),
    'ok 是 null': first((entry) => ({ ...entry, ok: null })),
    '被拦却没有错误码': first(({ code, ...rest }) => rest),
    '错误码是空串': first((entry) => ({ ...entry, code: '' })),
    '错误码不是字符串': first((entry) => ({ ...entry, code: 13 })),
    '回执是 null': first(() => null),
    '回执是数组': first((entry) => [entry]),
    '回执是字符串': first(() => 'loopback-tcp'),
    'attempts 不是数组': (receipt) => { receipt.attempts = Object.fromEntries(receipt.attempts.map((entry) => [entry.id, entry])); },
    '明细全是被拦，退出码却是 0': (receipt) => { receipt.code = 0; },
    '退出码是 null（被信号杀掉）': (receipt) => { receipt.code = null; },
    '退出码没给': (receipt) => { receipt.code = undefined; },
    '退出码是 2': (receipt) => { receipt.code = 2; },
    '退出码是字符串 1': (receipt) => { receipt.code = '1'; },
    '有子尝试得手，退出码却是 1': first((entry) => ({ ...entry, ok: true, code: 'OK' })),
  };
  for (const [name, tamper] of Object.entries(broken)) {
    const { report, hit } = await judge(tamper);
    assert.deepEqual([hit.conclusive, hit.blocked], [false, false], name);
    assert.ok(hit.receiptErrors.length, name);
    assert.deepEqual([report.ok, report.blocked], [false, 4], name);
    assert.match(formatRedTeamReport(report), /结论无效，回执不完整或自相矛盾/, name);
    for (const other of report.items.filter((item) => item.id !== id)) assert.deepEqual([other.blocked, other.receiptErrors], [true, []], `${name}: ${other.id}`);
  }

  // 自洽的回执照旧：错误原因写在 error 里也算数；得手一次并且退出码是 0，结论有效、判逃逸。
  const viaError = await judge(first(({ code, ...rest }) => ({ ...rest, error: code })));
  assert.deepEqual([viaError.hit.conclusive, viaError.hit.blocked, viaError.hit.receiptErrors, viaError.report.ok], [true, true, [], true]);
  const escaped = await judge((receipt) => {
    receipt.attempts[0] = { ...receipt.attempts[0], ok: true, code: 'OK' };
    receipt.code = 0;
  });
  assert.deepEqual([escaped.hit.conclusive, escaped.hit.escaped, escaped.hit.blocked, escaped.report.ok], [true, true, false, false]);
});

test('A13-21 进程隔离的诱饵要全程活着：起来时宿主机确认它在，探针跑完再确认一次，中途退出这一项判结论无效并判红', async (t) => {
  t.mock.method(fs, 'symlinkSync', () => {});
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const killDecoy = async (pid) => {
    process.kill(pid, 'SIGKILL');
    for (let tries = 0; alive(pid) && tries < 500; tries += 1) await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert.equal(alive(pid), false, '诱饵没杀掉');
  };
  // 宿主机这边认不出来的三种失效：退出通知还没投递、进程号检查恒真（被顶替），或者进程还在却已经卡死。只有答不上 ping 这一条露馅。
  const silence = {
    killed: killDecoy,
    // 刚杀掉就返回，不等退出通知投递；从这一刻起进程号检查恒真。
    pidReused: (pid) => {
      process.kill(pid, 'SIGKILL');
      return t.mock.method(process, 'kill', () => true);
    },
    // 冻住：退出事件永远不来，0 号信号照样发得出去（Windows 没有 SIGSTOP）。
    frozen: (pid) => { process.kill(pid, 'SIGSTOP'); },
  };

  // 对照：不动诱饵时，每一项开跑的时候它都活着，五项全拦。
  const seen = [];
  const full = await runSandboxRedTeam({ ...OFFLINE, run: fakeBlockedRun([], (receipt, cfg) => { seen.push(Number.isInteger(cfg.decoyPid) && alive(cfg.decoyPid)); }) });
  assert.deepEqual(seen, [true, true, true, true, true]);
  assert.equal(full.ok, true);

  // 诱饵在进程隔离那一项的探针跑着的时候退出，或者更早就退出：回执照样写着全拦（signal-0 报 ESRCH 也是「失败」），不能算数。
  // 后两种宿主机手里的子进程状态和 0 号信号都说它还在：探针跑完宿主机亲自 ping 它，回不出带本轮标记的 pong 就不算数。
  for (const [when, how] of [
    ['cross_workspace_processes', 'killed'], ['cross_workspace_read', 'killed'], ['cross_workspace_processes', 'pidReused'],
    ...(process.platform === 'win32' ? [] : [['cross_workspace_processes', 'frozen']]),
  ]) {
    let reuse;
    const report = await runSandboxRedTeam({
      ...OFFLINE,
      run: fakeBlockedRun([], async (receipt, cfg) => {
        if (receipt.item === when) reuse = await silence[how](cfg.decoyPid);
      }),
    }).finally(() => reuse?.mock.restore());
    const name = `${when}，${how}`;
    const hit = report.items.find((item) => item.id === 'cross_workspace_processes');
    assert.match(hit.fixtureErrors.join(), /诱饵/, name);
    assert.deepEqual([hit.conclusive, hit.blocked], [false, false], name);
    assert.deepEqual([report.ok, report.blocked], [false, 4], name);
    assert.deepEqual(report.items.filter((item) => !item.blocked).map((item) => item.id), ['cross_workspace_processes'], name);
    assert.match(formatRedTeamReport(report), /夹具没建起来[^]*诱饵/, name);
  }
});

test('A13-22 根目录与盘符卷根（/、D:\\、D:/、D:）不得当工作区根、工作区或引擎目录：别的盘的卷根不包住家目录，也单独拒收', (t) => {
  const { base, options } = fixture(t);
  const volume = (code) => (error) => error.code === code && /卷根/.test(error.message);
  for (const root of ['D:\\', 'D:/', 'D:', 'd:\\', 'z:/', 'C:\\', '/', path.parse(base).root]) {
    assert.throws(() => buildContainerSpec({ ...options, appDir: root }), volume('usage.bad-argument'), `appDir=${root}`);
    for (const index of [0, 1]) {
      const spec = buildContainerSpec(options);
      spec.mounts[index].source = root;
      assert.ok(validateContainerSpec(spec).some((message) => /卷根/.test(message)), `mounts[${index}].source=${root}`);
    }
    assert.throws(() => resolveWorkspace({ workspacesRoot: options.workspacesRoot, workspaceDir: root }), volume('contract.bad-path'), `workspaceDir=${root}`);
    assert.throws(() => resolveWorkspace({ workspacesRoot: root, workspaceDir: `${root}${/[\\/]$/.test(root) ? '' : path.sep}ws-a` }), volume('contract.bad-path'), `workspacesRoot=${root}`);
    assert.throws(() => buildContainerSpec({ ...options, workspacesRoot: root }), volume('contract.bad-path'), `build workspacesRoot=${root}`);
  }
  // POSIX 上当前目录里真有叫 D: 的普通目录时，规范化会把 D:/ 解析成它：原始写法要在规范化之前就拒（Windows 上建不出这种目录）。
  if (process.platform !== 'win32') {
    const cwd = process.cwd();
    for (const dir of [path.join('D:', 'ws-a'), 'D:\\']) fs.mkdirSync(path.join(base, dir), { recursive: true });
    process.chdir(base);
    try {
      for (const root of ['D:', 'D:/', 'D:\\', 'D://', 'D:/.']) {
        assert.throws(() => buildContainerSpec({ ...options, appDir: root }), volume('usage.bad-argument'), `当前目录有同名目录时 appDir=${root}`);
        assert.throws(() => resolveWorkspace({ workspacesRoot: root, workspaceDir: path.join('D:', 'ws-a') }), volume('contract.bad-path'), `当前目录有同名目录时 workspacesRoot=${root}`);
      }
    } finally {
      process.chdir(cwd);
    }
  }
  // 换一种写法指到卷根（/private/.. 这类）：规范化之后再认一次，卷根下面的顶层目录不当工作区。
  const real = fs.realpathSync.native(base);
  const top = path.parse(real).root;
  const first = path.join(top, path.relative(top, real).split(path.sep)[0]);
  assert.throws(() => resolveWorkspace({ workspacesRoot: `${first}${path.sep}..`, workspaceDir: first }), volume('contract.bad-path'));
  // 没被拒的照旧能用。
  assert.deepEqual(validateContainerSpec(buildContainerSpec(options)), []);
});

test('A13-23 环境变量诱饵每轮一套专属键：两轮重叠互不踩踏、调用方同名变量原样留着；诱饵缺失或被改写这一项判结论无效并判红', async (t) => {
  t.mock.method(fs, 'symlinkSync', () => {});
  // 调用方自己预置的同名变量：红队不得覆盖，也不得在收尾时删掉。
  const preset = { BEIMING_REDTEAM_API_KEY: 'caller-own-api-key', BEIMING_REDTEAM_AWS_SECRET_ACCESS_KEY: 'caller-own-aws-key' };
  const saved = Object.fromEntries(Object.keys(preset).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, preset);
  const presetIntact = () => assert.deepEqual(Object.fromEntries(Object.keys(preset).map((key) => [key, process.env[key]])), preset);

  // 六审的复现：A 建好夹具，B 整轮跑完并清理，再回到 A 跑 host_home_and_secrets。
  let mine;
  let during;
  let reportB;
  const reportA = await runSandboxRedTeam({
    ...OFFLINE,
    run: fakeBlockedRun([], async (receipt) => {
      if (receipt.item === 'cross_workspace_read') {
        mine = canaries();
        reportB = await runSandboxRedTeam({ ...OFFLINE, run: fakeBlockedRun() });
      }
      if (receipt.item === 'host_home_and_secrets') during = canaries();
    }),
  });
  assert.equal(mine.length, 2, 'A 开跑时自己的两个环境变量诱饵都在');
  assert.deepEqual(during, mine, 'B 清理之后 A 的诱饵原样还在');
  assert.ok(mine.every(([key]) => !Object.hasOwn(preset, key) && /KEY|SECRET/.test(key)), 'A 的诱饵用专属键名，不占调用方的固定键');
  assert.deepEqual([reportA.ok, reportA.blocked, reportB.ok, reportB.blocked], [true, 5, true, 5]);
  assert.deepEqual(canaries(), [], '两轮收尾后不留诱饵');
  presetIntact();

  // 诱饵在这一项实测的前后任何一端不在或被改写：探针回的「没读到」什么也说明不了。
  const id = 'host_home_and_secrets';
  const first = 'cross_workspace_read';
  let taken;
  const spoil = {
    实测期间删掉: (item) => { if (item === id) delete process.env[canaries()[0][0]]; },
    实测期间改写: (item) => { if (item === id) process.env[canaries()[0][0]] = 'tampered'; },
    实测开始之前就删掉: (item) => { if (item === first) delete process.env[canaries()[0][0]]; },
    // 起探针的那一刻诱饵不在，事后才补回去：只有实测之前的那一次核对认得出来。
    实测开始之前删掉又在实测期间补回去: (item) => {
      if (item === first) {
        [taken] = canaries();
        delete process.env[taken[0]];
      }
      if (item === id) process.env[taken[0]] = taken[1];
    },
  };
  for (const [name, how] of Object.entries(spoil)) {
    const report = await runSandboxRedTeam({ ...OFFLINE, run: fakeBlockedRun([], (receipt) => how(receipt.item)) });
    const hit = report.items.find((item) => item.id === id);
    assert.match(hit.fixtureErrors.join(), /环境变量诱饵/, name);
    assert.deepEqual([hit.conclusive, hit.blocked, hit.escaped], [false, false, false], name);
    assert.deepEqual([report.ok, report.blocked], [false, 4], name);
    assert.deepEqual(report.items.filter((item) => !item.blocked).map((item) => item.id), [id], name);
    assert.match(formatRedTeamReport(report), /夹具没建起来[^]*环境变量诱饵/, name);
    assert.deepEqual(canaries(), [], `${name}：收尾后不留诱饵`);
    presetIntact();
  }
});

// 两轮交错：A 建夹具、B 建夹具、A 先收尾、B 再核对并收尾。teamA、teamB 是两轮各自用的 runSandboxRedTeam。
async function interleaved(t, teamA, teamB, beforeB = () => {}) {
  t.mock.method(fs, 'symlinkSync', () => {});
  // 只顶掉每轮取的第一个 UUID（本轮标记），金丝雀照旧各取各的随机值。
  const real = crypto.randomUUID;
  let forced;
  t.mock.method(crypto, 'randomUUID', (...args) => {
    const value = forced ?? real(...args);
    forced = undefined;
    return value;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const first = 'cross_workspace_read';
  const hex = (uuid) => uuid.replaceAll('-', '').toUpperCase();
  const prefix = ['deadbeef-1111-4111-8111-111111111111', 'deadbeef-2222-4222-8222-222222222222'];

  for (const [name, uuidA, uuidB] of [['七审的复现：前 8 位相同', ...prefix], ['randomUUID 被桩成同一个值', prefix[0], prefix[0]]]) {
    let builtB;
    const bBuilt = new Promise((resolve) => { builtB = resolve; });
    let runB;
    let mineA;
    let both;
    let afterA;
    const nonces = [];
    forced = uuidA;
    const runA = teamA({
      ...OFFLINE,
      run: fakeBlockedRun([], async (receipt, cfg) => {
        if (receipt.item !== first) return;
        nonces.push(cfg.nonce);
        mineA = canaries();
        forced = uuidB;
        beforeB();
        runB = teamB({
          ...OFFLINE,
          run: fakeBlockedRun([], async (inner, cfgB) => {
            if (inner.item !== first) return;
            nonces.push(cfgB.nonce);
            both = canaries();
            builtB();
            // A 先整轮跑完并收尾，B 才接着往下实测。
            await runA;
            afterA = canaries();
          }),
        });
        await Promise.race([bBuilt, runB]);
      }),
    });
    const reportA = await runA;
    const reportB = await runB;

    const mineB = both.filter(([key]) => !mineA.some(([taken]) => taken === key));
    assert.deepEqual([mineA.length, mineB.length, both.length], [2, 2, 4], `${name}：两轮在途时各有两个键，互不相同`);
    assert.ok(mineA.every(([key]) => key.includes(hex(uuidA))) && mineB.every(([key]) => key.includes(hex(uuidB))), `${name}：键名带完整的本轮 UUID`);
    assert.deepEqual(afterA, mineB, `${name}：A 收尾之后 B 的两个在途诱饵原样还在`);
    assert.deepEqual([reportA.ok, reportA.blocked, reportB.ok, reportB.blocked], [true, 5, true, 5], name);
    assert.equal(new Set(nonces).size, 2, `${name}：夹具目录与探测文件用的本轮标记也不相同`);
    assert.deepEqual(canaries(), [], `${name}：两轮都结束后宿主环境不留诱饵`);
  }
}

test('A13-24 两轮交错（A 建夹具、B 建夹具、A 先收尾、B 再核对并收尾）：UUID 前 8 位相同乃至整个相同，两轮的诱饵键与夹具名也不相交', (t) => interleaved(t, runSandboxRedTeam, runSandboxRedTeam));

test('A13-25 同一进程里把同一文件加载成两份模块实例（?case=a、?case=b）再交错两轮：UUID 整个相同、进程级序号被拨回去，诱饵键与夹具名也不相交', async (t) => {
  // 八审的复现：两份实例各有各的模块顶层状态，却共用 process.env。
  const [a, b] = await Promise.all(['a', 'b'].map((name) => import(`./sandbox-redteam.mjs?case=${name}`)));
  assert.notEqual(a.runSandboxRedTeam, b.runSandboxRedTeam, '确实是两份模块实例');
  await interleaved(t, a.runSandboxRedTeam, b.runSandboxRedTeam);
  // 序号被拨回去、B 的头一个候选和 A 在途的标记一模一样也不撞：选键时实查 process.env，在场的键不会被第二轮选中。
  const seq = Symbol.for('beiming.jobs.sandboxRedTeamSeq');
  assert.equal(typeof process[seq], 'number', '进程级序号挂在 process 上');
  await interleaved(t, a.runSandboxRedTeam, b.runSandboxRedTeam, () => { process[seq] -= 1; });
});

// 一个 Worker 里跑一轮红队（A13-26）。Worker 有自己的 process 对象和模块实例，开了 SHARE_ENV 才和主线程共用 process.env。
// 取到本轮标记用的 UUID 之后停在屏障上，等两个 Worker 都到齐再一起放行去抢序号；夹具建好后报一声，等主线程放行才往下实测。
const WORKER_ROUND = `
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const EXPECTED_ATTEMPTS = workerData.attempts;
const fakeBlockedRun = ${fakeBlockedRun};
// sandbox.mjs 加载时自己先取一个 UUID：等它加载完再顶掉 randomUUID，这一轮取的第一个才是本轮标记。
import(new URL('./sandbox.mjs', workerData.url).href).then(async () => {
  const real = crypto.randomUUID;
  let calls = 0;
  crypto.randomUUID = (...args) => {
    calls += 1;
    if (calls === 1) return workerData.uuid;
    if (calls === 2) {
      parentPort.postMessage({ at: 'barrier' });
      Atomics.wait(workerData.gate, 0, 0, 10000);
    }
    return real(...args);
  };
  require('node:fs').symlinkSync = () => {};
  require('node:module').syncBuiltinESMExports();
  const { runSandboxRedTeam } = await import(workerData.url);
  const report = await runSandboxRedTeam({
    ...workerData.offline,
    run: fakeBlockedRun([], async (receipt, cfg) => {
      if (receipt.item !== 'cross_workspace_read') return;
      parentPort.postMessage({ at: 'built', nonce: cfg.nonce });
      await new Promise((resolve) => parentPort.once('message', resolve));
    }),
  });
  parentPort.postMessage({ at: 'done', report });
});
`;

test('A13-26 同一进程里两个开了 SHARE_ENV 的 Worker 同时选键：UUID 整个相同、各自的进程级序号都从 1 起算，两轮也各占一个序号，诱饵键不相交', async (t) => {
  // 九审的复现：两个 Worker 的 PID 相同、process 对象各一份，却共用 process.env。
  const uuid = 'deadbeef-3333-4333-8333-333333333333';
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const claimsRoot = path.join(os.tmpdir(), `bm-redteam-claims-${process.pid}`);
  const workerData = { url: new URL('./sandbox-redteam.mjs', import.meta.url).href, uuid, gate, attempts: EXPECTED_ATTEMPTS, offline: OFFLINE };
  const teams = ['A', 'B'].map(() => {
    const worker = new Worker(WORKER_ROUND, { eval: true, env: SHARE_ENV, workerData });
    const at = Object.fromEntries(['barrier', 'built', 'done'].map((stage) => [stage, new Promise((resolve, reject) => {
      worker.on('message', (message) => { if (message.at === stage) resolve(message); });
      worker.once('error', reject);
    })]));
    return { worker, at };
  });
  t.after(() => Promise.all(teams.map(({ worker }) => worker.terminate())));
  const [a, b] = teams;

  // 整套流程先走完再断言：中途失败就停的话，没收尾的那一轮会把诱饵留在共用的环境里。
  await Promise.all(teams.map(({ at }) => at.barrier));
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  const [builtA, builtB] = await Promise.all(teams.map(({ at }) => at.built));
  const both = canaries();
  a.worker.postMessage('go');
  const reportA = (await a.at.done).report;
  const afterA = canaries();
  b.worker.postMessage('go');
  const reportB = (await b.at.done).report;

  const hex = uuid.replaceAll('-', '');
  assert.deepEqual([builtA.nonce, builtB.nonce].sort(), [`1-${hex}`, `2-${hex}`], '两轮的序号是 1 和 2');
  const mineB = both.filter(([key]) => key.startsWith(`BEIMING_REDTEAM_${builtB.nonce.replace('-', '_').toUpperCase()}_`));
  assert.deepEqual([both.length, mineB.length], [4, 2], '两轮在途时共 4 个诱饵键，各占两个');
  assert.deepEqual(afterA, mineB, 'A 收尾之后 B 的两个在途诱饵原样还在');
  assert.deepEqual([reportA.ok, reportA.blocked, reportB.ok, reportB.blocked], [true, 5, true, 5]);
  assert.deepEqual(canaries(), [], '两轮都结束后宿主环境不留诱饵');
  assert.equal(fs.existsSync(claimsRoot), false, '临时目录下不留序号占位目录');
});

test('A13-27 调用方自己占着下一个候选序号的键名：红队让出这个序号换下一个，调用方的值原样留着，占位目录不留', async (t) => {
  t.mock.method(fs, 'symlinkSync', () => {});
  const uuid = 'deadbeef-4444-4444-8444-444444444444';
  const hex = uuid.replaceAll('-', '');
  const real = crypto.randomUUID;
  let forced = uuid;
  t.mock.method(crypto, 'randomUUID', (...args) => {
    const value = forced ?? real(...args);
    forced = undefined;
    return value;
  });
  syncBuiltinESMExports();
  const next = (process[Symbol.for('beiming.jobs.sandboxRedTeamSeq')] ?? 0) + 1;
  const presetKey = `BEIMING_REDTEAM_${next}_${hex.toUpperCase()}_API_KEY`;
  process.env[presetKey] = 'caller-own';
  t.after(() => {
    delete process.env[presetKey];
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  let nonce;
  const report = await runSandboxRedTeam({ ...OFFLINE, run: fakeBlockedRun([], (receipt, cfg) => { nonce = cfg.nonce; }) });
  assert.equal(nonce, `${next + 1}-${hex}`, '跳过被占的序号');
  assert.deepEqual([report.ok, report.blocked], [true, 5]);
  assert.equal(process.env[presetKey], 'caller-own', '调用方的值没被覆盖，收尾也没被删');
  assert.deepEqual(canaries(), [], '收尾后不留诱饵');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), `bm-redteam-claims-${process.pid}`)), false, '让出的序号和本轮的序号都不留占位目录');
});

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function forceKillPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已退出则忽略
  }
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const promptLimitMs = process.platform === 'win32' ? 3900 : 3000;

test('A13-28 超时收尾：子进程继承标准输出与标准错误阻塞时，仍按 timeoutMs 及时返回并清理子进程', async (t) => {
  const { options, app } = fixture(t);
  let childPid = null;
  t.after(() => forceKillPid(childPid));
  fs.writeFileSync(path.join(app, 'job.mjs'), [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    'console.log(JSON.stringify({ pid: child.pid }));',
    'setTimeout(() => {}, 60000);',
  ].join('\n'));

  const start = Date.now();
  const result = await runInWorkspaceSandbox({
    ...options,
    request: { mode: 'cards-data' },
    backend: 'portable',
    allowDegraded: true,
    timeoutMs: 1500,
  });
  const elapsed = Date.now() - start;
  const line = result.stdout.trim().split('\n')[0];
  childPid = line ? JSON.parse(line).pid : null;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < promptLimitMs, `超时收尾耗时 ${elapsed}ms，超过上限 ${promptLimitMs}ms`);
  assert.ok(Number.isInteger(childPid) && childPid > 1, `应记录子进程号，实得：${result.stdout}`);
  assert.equal(isPidAlive(childPid), false, `超时后子进程 ${childPid} 应已终止`);
});

test('A13-29 超时收尾：独立会话后代进程继承标准输出与标准错误时，仍按 timeoutMs 及时返回并终止后代进程', async (t) => {
  const { options, app } = fixture(t);
  let grandchildPid = null;
  t.after(() => forceKillPid(grandchildPid));
  fs.writeFileSync(path.join(app, 'job.mjs'), [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    'child.unref();',
    'console.log(JSON.stringify({ pid: child.pid }));',
    'setTimeout(() => {}, 60000);',
  ].join('\n'));

  const start = Date.now();
  const result = await runInWorkspaceSandbox({
    ...options,
    request: { mode: 'cards-data' },
    backend: 'portable',
    allowDegraded: true,
    timeoutMs: 1500,
  });
  const elapsed = Date.now() - start;
  const line = result.stdout.trim().split('\n')[0];
  grandchildPid = line ? JSON.parse(line).pid : null;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < promptLimitMs, `超时收尾耗时 ${elapsed}ms，超过上限 ${promptLimitMs}ms`);
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1, `应记录后代进程号，实得：${result.stdout}`);
  assert.equal(isPidAlive(grandchildPid), false, `超时后独立会话后代进程 ${grandchildPid} 应已终止`);
});

test('A13-30 退出后清理：正常退出前派生的独立会话后台进程不会滞留或在返回后继续写入工作区（portable 与 darwin-seatbelt）', async (t) => {
  const cases = [{ backend: 'portable', allowDegraded: true }];
  if (seatbelt) cases.push({ backend: 'darwin-seatbelt' });

  for (const cfg of cases) {
    const { options, app, own } = fixture(t);
    let backgroundPid = null;
    t.after(() => forceKillPid(backgroundPid));
    fs.writeFileSync(path.join(app, 'job.mjs'), [
      "import path from 'node:path';",
      "import { spawn } from 'node:child_process';",
      "const target = path.join(process.env.BEIMING_WORKSPACE, 'delayed.txt');",
      'const code = `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(target)}, "delayed"); }, 1500); setTimeout(() => {}, 8000);`;',
      'try {',
      "  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });",
      '  child.unref();',
      '  console.log(JSON.stringify({ spawned: true, pid: child.pid }));',
      '} catch (error) {',
      '  console.log(JSON.stringify({ spawned: false, code: error.code }));',
      '}',
    ].join('\n'));

    const result = await runInWorkspaceSandbox({
      ...options,
      request: { mode: 'cards-data' },
      timeoutMs: 10000,
      ...cfg,
    });
    assert.equal(result.code, 0, `${cfg.backend}: ${result.stderr}`);
    assert.equal(result.timedOut, false, cfg.backend);
    const info = JSON.parse(result.stdout.trim());
    backgroundPid = info.pid ?? null;

    if (cfg.backend === 'darwin-seatbelt') {
      assert.equal(info.spawned, false, 'darwin-seatbelt 不应允许派生后台子进程');
      assert.equal(info.code, 'EPERM');
    } else {
      assert.equal(info.spawned, true, 'portable 夹具应能拉起后台进程以验证回收');
      assert.ok(Number.isInteger(backgroundPid) && backgroundPid > 1);
    }

    await pause(2500);
    assert.equal(fs.existsSync(path.join(own, 'delayed.txt')), false, `${cfg.backend}: 返回后工作区不应出现延迟写入文件`);
    if (backgroundPid !== null) {
      assert.equal(isPidAlive(backgroundPid), false, `${cfg.backend}: 返回后后台进程 ${backgroundPid} 应已终止`);
    }
  }
});

test('A13-31 退出后管道收尾：主进程正常退出而子进程仍占用标准输出时，保留主进程输出并及时返回、清理子进程', async (t) => {
  const { options, app } = fixture(t);
  let childPid = null;
  t.after(() => forceKillPid(childPid));
  fs.writeFileSync(path.join(app, 'job.mjs'), [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    'child.unref();',
    'console.log(JSON.stringify({ ok: true, pid: child.pid }));',
  ].join('\n'));

  const start = Date.now();
  const result = await runInWorkspaceSandbox({
    ...options,
    request: { mode: 'cards-data' },
    backend: 'portable',
    allowDegraded: true,
    timeoutMs: 10000,
  });
  const elapsed = Date.now() - start;
  const info = JSON.parse(result.stdout.trim());
  childPid = info.pid;

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(info.ok, true);
  assert.ok(elapsed < promptLimitMs, `正常退出收尾耗时 ${elapsed}ms，超过上限 ${promptLimitMs}ms`);
  assert.equal(isPidAlive(childPid), false, `主进程退出后子进程 ${childPid} 应已终止`);
});

test('A13-32 macOS seatbelt 超时收尾与工作线程兼容：超时按时结束且 worker_threads 正常运行', seatbeltOnly, async (t) => {
  const { options, app } = fixture(t);
  fs.writeFileSync(path.join(app, 'hang.mjs'), 'setTimeout(() => {}, 60000);\n');
  const start = Date.now();
  const timed = await runInWorkspaceSandbox({
    ...options,
    command: ['node', '/app/hang.mjs'],
    request: { mode: 'cards-data' },
    backend: 'darwin-seatbelt',
    timeoutMs: 1500,
  });
  const elapsed = Date.now() - start;
  assert.equal(timed.timedOut, true);
  assert.ok(elapsed < promptLimitMs, `seatbelt 超时耗时 ${elapsed}ms，超过上限 ${promptLimitMs}ms`);

  fs.writeFileSync(path.join(app, 'worker.mjs'), [
    "import { Worker } from 'node:worker_threads';",
    "const worker = new Worker('require(\"node:worker_threads\").parentPort.postMessage(42)', { eval: true });",
    "worker.on('message', (value) => console.log(JSON.stringify({ value })));",
  ].join('\n'));
  const ok = await runInWorkspaceSandbox({
    ...options,
    command: ['node', '/app/worker.mjs'],
    request: { mode: 'cards-data' },
    backend: 'darwin-seatbelt',
    timeoutMs: 10000,
  });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.timedOut, false);
  assert.deepEqual(JSON.parse(ok.stdout.trim()), { value: 42 });
});

test('A13-33 并发清理隔离与大输出保真：超时作业的清理不波及并行正常作业，且大块标准输出完整保留', async (t) => {
  const { options, app } = fixture(t);
  let detachedPid = null;
  t.after(() => forceKillPid(detachedPid));

  fs.writeFileSync(path.join(app, 'timeout-job.mjs'), [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    'child.unref();',
    'console.log(JSON.stringify({ pid: child.pid }));',
    'setTimeout(() => {}, 60000);',
  ].join('\n'));
  const expectedPayload = 'B'.repeat(512 * 1024);
  fs.writeFileSync(path.join(app, 'normal-job.mjs'), [
    'setTimeout(() => {',
    `  process.stdout.write(${JSON.stringify(expectedPayload)});`,
    '}, 1800);',
  ].join('\n'));

  const [timed, normal] = await Promise.all([
    runInWorkspaceSandbox({
      ...options,
      command: ['node', '/app/timeout-job.mjs'],
      request: { mode: 'cards-data' },
      backend: 'portable',
      allowDegraded: true,
      timeoutMs: 1200,
    }),
    runInWorkspaceSandbox({
      ...options,
      command: ['node', '/app/normal-job.mjs'],
      request: { mode: 'cards-data' },
      backend: 'portable',
      allowDegraded: true,
      timeoutMs: 10000,
    }),
  ]);

  const line = timed.stdout.trim().split('\n')[0];
  detachedPid = line ? JSON.parse(line).pid : null;
  assert.equal(timed.timedOut, true);
  assert.ok(Number.isInteger(detachedPid) && detachedPid > 1);
  assert.equal(isPidAlive(detachedPid), false, `超时作业的后代 ${detachedPid} 应已终止`);

  assert.equal(normal.code, 0, normal.stderr);
  assert.equal(normal.timedOut, false);
  assert.equal(normal.stdout.length, expectedPayload.length, '正常作业的大块标准输出不应被截断');
  assert.ok(normal.stdout === expectedPayload, '正常作业的大块标准输出内容应完整一致');
});

test('A13-34 POSIX 跨代独立会话后代清理：中间进程先退出后，第三代后台进程仍被按专属临时目录标记回收', {
  skip: process.platform === 'win32' ? '仅 POSIX 按作业专属临时目录环境变量回收跨代孤儿进程' : false,
}, async (t) => {
  const { options, app } = fixture(t);
  let leafPid = null;
  t.after(() => forceKillPid(leafPid));

  fs.writeFileSync(path.join(app, 'double-fork.mjs'), [
    "import { spawnSync } from 'node:child_process';",
    "const mid = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore' }); g.unref(); process.stdout.write(String(g.pid));`;",
    "const res = spawnSync(process.execPath, ['-e', mid], { encoding: 'utf8' });",
    'console.log(JSON.stringify({ pid: Number(res.stdout.trim()) }));',
  ].join('\n'));

  const result = await runInWorkspaceSandbox({
    ...options,
    command: ['node', '/app/double-fork.mjs'],
    request: { mode: 'cards-data' },
    backend: 'portable',
    allowDegraded: true,
    timeoutMs: 10000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.timedOut, false);
  leafPid = JSON.parse(result.stdout.trim()).pid;
  assert.ok(Number.isInteger(leafPid) && leafPid > 1);
  assert.equal(isPidAlive(leafPid), false, `跨代独立会话后台进程 ${leafPid} 应已终止`);
});

test('A13-35 独立 CLI 顶层 await 超时结算：无额外事件循环句柄时超时正常返回且清理临时目录', async (t) => {
  const { base, root, own, app } = fixture(t);
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const sandboxModulePath = fileURLToPath(new URL('./sandbox.mjs', import.meta.url));

  fs.writeFileSync(path.join(app, 'sleep.mjs'), 'setTimeout(() => {}, 6000);\n');
  fs.writeFileSync(path.join(app, 'child-pipe.mjs'), [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    'console.log(JSON.stringify({ pid: child.pid }));',
    'setTimeout(() => {}, 60000);',
  ].join('\n'));
  fs.writeFileSync(path.join(app, 'detached-pipe.mjs'), [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    'child.unref();',
    'console.log(JSON.stringify({ pid: child.pid }));',
    'setTimeout(() => {}, 60000);',
  ].join('\n'));

  const cliScript = [
    "import { pathToFileURL } from 'node:url';",
    'const [modulePath, payloadJson] = process.argv.slice(2);',
    'const payload = JSON.parse(payloadJson);',
    'const { runInWorkspaceSandbox } = await import(pathToFileURL(modulePath).href);',
    'const result = await runInWorkspaceSandbox(payload);',
    'process.stdout.write(JSON.stringify({ timedOut: result.timedOut, code: result.code, signal: result.signal, stdout: result.stdout }));',
  ].join('\n');

  const cases = [
    { label: 'portable-sleep', backend: 'portable', allowDegraded: true, script: '/app/sleep.mjs', hasChildPid: false },
    { label: 'portable-child-pipe', backend: 'portable', allowDegraded: true, script: '/app/child-pipe.mjs', hasChildPid: true },
    { label: 'portable-detached-pipe', backend: 'portable', allowDegraded: true, script: '/app/detached-pipe.mjs', hasChildPid: true },
  ];
  if (seatbelt) {
    cases.push({ label: 'seatbelt-sleep', backend: 'darwin-seatbelt', allowDegraded: false, script: '/app/sleep.mjs', hasChildPid: false });
  }

  for (const item of cases) {
    const payload = {
      request: { mode: 'cards-data' },
      backend: item.backend,
      ...(item.allowDegraded ? { allowDegraded: true } : {}),
      workspacesRoot: root,
      workspaceDir: own,
      appDir: app,
      command: ['node', item.script],
      timeoutMs: 1200,
    };
    const cli = spawnSync(
      process.execPath,
      ['--input-type=module', '-', sandboxModulePath, JSON.stringify(payload)],
      {
        input: cliScript,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot },
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.equal(cli.status, 0, `${item.label} 独立 CLI 应以退出码 0 结束，stderr=${cli.stderr}`);
    const parsed = JSON.parse(cli.stdout.trim());
    assert.equal(parsed.timedOut, true, `${item.label} 应返回 timedOut: true`);
    if (item.hasChildPid) {
      const firstLine = (parsed.stdout || '').trim().split('\n')[0];
      const childPid = firstLine ? JSON.parse(firstLine).pid : null;
      t.after(() => forceKillPid(childPid));
      assert.ok(Number.isInteger(childPid) && childPid > 1, `${item.label} 应记录后代 PID`);
      assert.equal(isPidAlive(childPid), false, `${item.label} 超时返回后后代 PID ${childPid} 应已终止`);
    }
    const leaked = fs.readdirSync(tmpRoot).filter((name) => name.startsWith('bm-sandbox-'));
    assert.deepEqual(leaked, [], `${item.label} 超时收尾后不应在临时目录残留 bm-sandbox-*`);
  }
});


