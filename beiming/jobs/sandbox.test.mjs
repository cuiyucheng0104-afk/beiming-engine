import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
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
    backend: 'portable', tmpDir: path.join(base, 'tmp'),
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
    const plan = planSandboxExec(spec, { backend, tmpDir: os.tmpdir() });
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
  assert.deepEqual(Object.keys(seen.env).filter((key) => !allowed.has(key.toUpperCase()) && !allowed.has(key)), []);
});

test('A13-9 降级后端的红队报告如实判红：环境变量拦得住，文件这一类拦不住，不把它说成容器', async () => {
  await assert.rejects(runSandboxRedTeam({ ...OFFLINE, backend: 'portable' }), refuses('env.missing-tool'));
  const report = await runSandboxRedTeam({ ...OFFLINE, backend: 'portable', allowDegraded: true });
  assert.equal(report.backend, 'portable');
  assert.equal(report.isolation, 'needs-oci-runtime');
  assert.equal(report.ok, false);
  assert.deepEqual(report.items.map((item) => item.id), ITEM_IDS);
  assert.ok(report.items.every((item) => item.conclusive), JSON.stringify(report.items.map((item) => item.exitCode)));
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
    assert.ok(item.attempts.length >= 4 && item.blockedBy && item.command);
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
