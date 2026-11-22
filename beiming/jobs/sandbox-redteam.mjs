// 五项红队逃逸探针与报告（A13）。
// 这个文件同时是探针本体：夹具把它原样拷进只读引擎目录，在沙箱里以 --probe 运行。
// 所以顶层只引 node 内置模块，隔离层在 runSandboxRedTeam 里按需引入。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns';
import process from 'node:process';
import { fork, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SENTINEL = 'bm-sandbox-redteam/0.1';
const DECOY_TAG = 'bm-redteam-decoy';
// 诱饵：起来说一声 ready，之后标准输入每来一行 ping 就回一行带本轮标记（argv[2]）的 pong，证明答话的还是它自己。
const DECOY_SOURCE = "process.stdout.write('ready\\n');"
  + "require('node:readline').createInterface({ input: process.stdin })"
  + ".on('line', (line) => { if (line === 'ping') process.stdout.write('pong:' + process.argv[2] + '\\n'); });"
  + 'setInterval(() => {}, 1000)';
const DECOY_PONG_MS = 2000;
// 同一进程里第几轮红队：randomUUID 给出相同的值（被桩掉，或截短后相撞）时，靠它让各轮的标记不同。
// 挂在 process 上而不是模块顶层：同一文件被加载成几份模块实例（?v=1、?v=2）时也共用一个序号。
const RUN_SEQ = Symbol.for('beiming.jobs.sandboxRedTeamSeq');
const canaryEnvKeys = (nonce) => ['API_KEY', 'AWS_SECRET_ACCESS_KEY'].map((name) => `BEIMING_REDTEAM_${nonce.replace('-', '_').toUpperCase()}_${name}`);
const SENSITIVE_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|^(?:AWS|SSH|GH|GITHUB|ANTHROPIC|OPENAI|GOOGLE|AZURE|DOCKER|NPM)_/i;

// expectedAttempts 是这一项该有的全部子尝试：判定时逐个核对，少一个这一项就不算数。
const ITEMS = [
  {
    id: 'cross_workspace_read', title: '读别的工作区目录',
    expectedAttempts: ['absolute-path', 'relative-path', 'planted-symlink-file', 'planted-symlink-dir', 'list-workspaces-root'],
  },
  {
    id: 'host_home_and_secrets', title: '读宿主机家目录与密钥',
    expectedAttempts: ['ssh-private-key', 'aws-credentials', 'real-home', 'real-home-ssh', 'real-home-aws', 'real-home-gnupg', 'real-home-config', 'env-secrets'],
  },
  {
    id: 'external_network', title: '连外网与非授权回环端口',
    expectedAttempts: ['loopback-tcp', 'loopback-http', 'external-tcp', 'dns-lookup'],
  },
  {
    id: 'cross_workspace_processes', title: '看到别的工作区的进程',
    expectedAttempts: ['ps-by-pid', 'ps-scan', 'proc-cmdline', 'proc-environ', 'signal-0', 'warm-process-residue'],
  },
  {
    id: 'readonly_image_write', title: '往只读根镜像与只读引擎目录里写文件',
    expectedAttempts: ['app-overwrite', 'app-create', 'root-create', 'sibling-create', 'host-home-create'],
  },
];

const BACKENDS = {
  'darwin-seatbelt': {
    boundary: 'macOS seatbelt（/usr/bin/sandbox-exec，系统已标为弃用）进程策略，不是 Linux 命名空间容器：没有 PID、挂载、网络命名空间，也没有 cgroup 限额（pids-limit 不生效）；根目录 / 下的目录名可以列出；给别的进程发信号被拒时返回 EPERM、进程不存在时返回 ESRCH，凭进程号能分辨进程在不在，但读不到它的命令行和环境变量；作业自己另起会话的后台进程在超时或结束后不会被回收（仍受同一份策略约束）。',
    layers: {
      cross_workspace_read: 'seatbelt 默认拒绝：file-read* 只放行本工作区、只读引擎目录与专属临时目录',
      host_home_and_secrets: 'seatbelt 默认拒绝读家目录；环境变量按固定白名单重建，不继承宿主机',
      external_network: 'seatbelt (deny network*)',
      cross_workspace_processes: 'seatbelt 只许执行 node，signal 与 process-info 只对自己；预热进程用后即毁',
      readonly_image_write: 'seatbelt 默认拒绝：file-write* 只放行本工作区与专属临时目录',
    },
  },
  oci: {
    boundary: 'Linux OCI 容器（docker 或 podman）：靠命名空间、capability 与只读根文件系统隔离，和宿主机共用内核，不防内核漏洞；没有另加用户命名空间与自定义 seccomp 配置，沿用运行时默认值。',
    layers: {
      cross_workspace_read: '挂载命名空间：只绑定挂载本工作区',
      host_home_and_secrets: '挂载命名空间里没有宿主机家目录；环境变量只有 --env 白名单',
      external_network: '--network=none：独立网络命名空间，只有容器自己的回环',
      cross_workspace_processes: 'PID 命名空间；预热进程用后即毁',
      readonly_image_write: '--read-only 根文件系统，/app 只读绑定挂载',
    },
  },
  portable: {
    boundary: '降级后端：没有内核级隔离（needs-oci-runtime），只做环境变量剥离、工作区路径边界与 U8 守卫；文件、网络、进程三类逃逸拦不住，不得用于对外服务。',
    layers: {
      cross_workspace_read: '无内核级拦截',
      host_home_and_secrets: '环境变量按固定白名单重建；文件读取无内核级拦截',
      external_network: '无内核级拦截',
      cross_workspace_processes: '预热进程用后即毁；进程可见性无内核级拦截',
      readonly_image_write: '无内核级拦截',
    },
  },
};

// 不认识的后端名（含 toString 这类原型链上的键）按没有内核级隔离的 portable 说明。
const backendInfo = (name) => (Object.hasOwn(BACKENDS, name) ? BACKENDS[name] : BACKENDS.portable);

// Windows 上 node 没有 SystemRoot 起不稳；它不是凭据。
const bareEnv = () => (process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {});

function fail(code) {
  return Object.assign(new Error(code), { code });
}

// ---------- 探针：在沙箱里跑。得手才返回数据，拿不到就抛带错误码的错。 ----------

function tcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (settle, value) => {
      socket.destroy();
      settle(value);
    };
    socket.setTimeout(1500, () => done(reject, fail('ETIMEDOUT')));
    socket.once('connect', () => done(resolve, 'connected'));
    socket.once('error', (error) => done(reject, error));
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false, timeout: 1500 }, (response) => {
      response.resume();
      resolve(`HTTP ${response.statusCode}`);
    });
    request.once('timeout', () => request.destroy(fail('ETIMEDOUT')));
    request.once('error', reject);
  });
}

// 只交回带诱饵标记的行，不把宿主机的进程表带出沙箱；探针自己的命令行里也有标记，要排除。
function ps(args) {
  const result = spawnSync('ps', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  const lines = result.stdout.split('\n').filter((line) => line.includes(DECOY_TAG) && !line.includes('--probe'));
  if (!lines.length) throw fail(result.status ? `EXIT_${result.status}` : 'NOT_VISIBLE');
  return lines;
}

function readTagged(file, tag) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(tag)) throw fail('NOT_VISIBLE');
  return text;
}

const PROBES = {
  async cross_workspace_read(cfg, attempt) {
    await attempt('absolute-path', '按宿主机绝对路径读兄弟工作区的 secret.txt', () => fs.readFileSync(cfg.siblingSecret, 'utf8'));
    await attempt('relative-path', '从工作目录读 ../<兄弟工作区>/secret.txt', () => fs.readFileSync(`../${cfg.siblingName}/secret.txt`, 'utf8'));
    await attempt('planted-symlink-file', '读工作区里预先植入、指向兄弟 secret.txt 的符号链接', () => fs.readFileSync('escape-link', 'utf8'));
    await attempt('planted-symlink-dir', '经工作区里预先植入、指向兄弟工作区的目录链接读 secret.txt', () => fs.readFileSync('escape-dir/secret.txt', 'utf8'));
    await attempt('list-workspaces-root', '列上一级目录，找兄弟工作区的名字', () => {
      if (!fs.readdirSync('..').includes(cfg.siblingName)) throw fail('NOT_VISIBLE');
      return [cfg.siblingName];
    });
  },

  async host_home_and_secrets(cfg, attempt) {
    await attempt('ssh-private-key', '读模拟的宿主机家目录 .ssh/id_ed25519', () => fs.readFileSync(path.join(cfg.fakeHome, '.ssh', 'id_ed25519'), 'utf8'));
    await attempt('aws-credentials', '读模拟的宿主机家目录 .aws/credentials', () => fs.readFileSync(path.join(cfg.fakeHome, '.aws', 'credentials'), 'utf8'));
    // 真实家目录只报条目数，不把文件名带出沙箱。
    for (const name of ['', '.ssh', '.aws', '.gnupg', '.config']) {
      await attempt(`real-home${name ? `-${name.slice(1)}` : ''}`, `列真实的宿主机家目录 ~/${name}`, () => ({ entries: fs.readdirSync(path.join(cfg.realHome, name)).length }));
    }
    await attempt('env-secrets', '读环境变量里的密钥', () => {
      const keys = Object.keys(process.env).filter((key) => SENSITIVE_ENV.test(key));
      const homeIsHostHome = process.env.HOME === cfg.realHome;
      if (!keys.length && !homeIsHostHome) throw fail('STRIPPED');
      return { keys, homeIsHostHome, values: keys.filter((key) => key.startsWith('BEIMING_REDTEAM_')).map((key) => process.env[key]) };
    });
  },

  async external_network(cfg, attempt) {
    await attempt('loopback-tcp', '对宿主机回环上未授权的监听端口发起 TCP 连接', () => tcp('127.0.0.1', cfg.port));
    await attempt('loopback-http', '对同一端口发 HTTP GET', () => httpGet(`http://127.0.0.1:${cfg.port}/redteam`));
    await attempt('external-tcp', `对外网地址 ${cfg.externalHost}:${cfg.externalPort} 发起 TCP 连接`, () => tcp(cfg.externalHost, cfg.externalPort));
    await attempt('dns-lookup', `解析域名 ${cfg.dnsName}`, async () => {
      await dns.promises.lookup(cfg.dnsName);
      return 'resolved';
    });
  },

  async cross_workspace_processes(cfg, attempt) {
    const pid = String(cfg.decoyPid);
    await attempt('ps-by-pid', 'ps -o command= -p <诱饵进程号>', () => ps(['-o', 'command=', '-p', pid]));
    await attempt('ps-scan', 'ps -axo command= 找诱饵进程', () => ps(['-axo', 'command=']));
    await attempt('proc-cmdline', '读 /proc/<诱饵进程号>/cmdline', () => readTagged(`/proc/${pid}/cmdline`, DECOY_TAG));
    await attempt('proc-environ', '读 /proc/<诱饵进程号>/environ', () => readTagged(`/proc/${pid}/environ`, 'BM_DECOY_SECRET'));
    await attempt('signal-0', '给诱饵进程发 0 号信号', () => {
      process.kill(cfg.decoyPid, 0);
      return 'signalled';
    });
  },

  async readonly_image_write(cfg, attempt) {
    const app = process.env.BEIMING_APP;
    const write = (file) => {
      fs.writeFileSync(file, `tampered ${cfg.nonce}`);
      return 'written';
    };
    await attempt('app-overwrite', '改写只读引擎目录里的 engine.txt', () => write(path.join(app, 'engine.txt')));
    await attempt('app-create', '在只读引擎目录里新建文件', () => write(path.join(app, `planted-${cfg.nonce}.txt`)));
    await attempt('root-create', '在根文件系统的 /var/tmp 里新建文件', () => write(`/var/tmp/bm-redteam-${cfg.nonce}`));
    await attempt('sibling-create', '在兄弟工作区里新建文件', () => write(path.join(cfg.siblingDir, `planted-${cfg.nonce}.txt`)));
    await attempt('host-home-create', '在模拟的宿主机家目录里新建文件', () => write(path.join(cfg.fakeHome, `planted-${cfg.nonce}.txt`)));
  },
};

// 退出码：1 全部尝试失败，0 至少一次得手，3 连自己的工作区都读写不了（结论无效）。
async function probeMain(item, cfg) {
  const attempts = [];
  const attempt = async (id, payload, run) => {
    try {
      attempts.push({ id, payload, ok: true, code: 'OK', data: await run() });
    } catch (error) {
      attempts.push({ id, payload, ok: false, code: String(error.code ?? error.name) });
    }
  };
  let control;
  try {
    control = fs.readFileSync('own.txt', 'utf8') === cfg.own;
    fs.writeFileSync(`control-${item}.txt`, item);
    fs.writeFileSync(path.join(process.env.TMPDIR, 'control.txt'), item);
  } catch {
    control = false;
  }
  if (control) await PROBES[item](cfg, attempt);
  process.stdout.write(`${JSON.stringify({ sentinel: SENTINEL, item, control, attempts })}\n`);
  process.exitCode = !control ? 3 : attempts.some((entry) => entry.ok) ? 0 : 1;
}

// 预热进程的替身：记住别人给它的数据。干净的新进程里什么也没有。
function warmWorkerMain() {
  let memory = null;
  process.on('message', (message) => {
    if ('remember' in message) memory = message.remember;
    process.send({ memory });
  });
}

// ---------- 夹具与判定：在宿主机上跑。 ----------

function ask(child, message) {
  return new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('预热进程提前退出。')));
    child.send(message);
  });
}

// 工作区 B 用过的预热进程会不会再分给工作区 A：会的话 A 能读到 B 留在进程内存里的数据。
async function warmResidue(pool, secret) {
  try {
    const first = pool.acquire('workspace-b');
    await ask(first.process, { remember: secret });
    first.release();
    const second = pool.acquire('workspace-a');
    const { memory } = await ask(second.process, { recall: true });
    second.release();
    return memory;
  } finally {
    pool.close();
  }
}

// 一条子尝试的回执哪里不算数：要是普通对象、带 id 和自有的布尔值 ok；说自己被拦的，还要带非空的错误码（code 或 error）。
function receiptProblem(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !entry.id) return '不是带 id 的对象';
  if (!Object.hasOwn(entry, 'ok') || typeof entry.ok !== 'boolean') return '没有布尔值 ok';
  if (!entry.ok && ![entry.code, entry.error].some((reason) => typeof reason === 'string' && reason.length > 0)) return '说被拦却没有错误码';
  return null;
}

function mapStrings(value, map) {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]));
  return value;
}

/**
 * 在真实沙箱里逐项实测五类逃逸。run 默认是 runInWorkspaceSandbox；makePool 默认建 WarmProcessPool。
 * 判定不信探针自己的说法：读到的东西里有没有金丝雀、宿主机监听端口收没收到连接、只读目录变没变，都在宿主机这边核对。
 */
export async function runSandboxRedTeam({
  run, makePool, backend, runtime, image, allowDegraded = false, externalTarget = '1.1.1.1:443', dnsName = 'example.com',
} = {}) {
  const sandbox = await import('./sandbox.mjs');
  const execute = run ?? sandbox.runInWorkspaceSandbox;
  const self = fileURLToPath(import.meta.url);
  const pool = (makePool ?? ((spawnWorker) => new sandbox.WarmProcessPool({ spawn: spawnWorker })))(
    () => fork(self, ['--warm-worker'], { env: bareEnv(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  );

  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-redteam-')));
  // 本轮标记 = 进程级序号 + 完整 UUID（不截短）：夹具目录、/var/tmp 下的探测文件和环境变量键都带它。
  // process.env 就是在途登记表：键已经在场（别的轮次、别的模块实例或调用方自己的）就换下一个序号，选中后在 try 的第一句同步占位。
  const uuid = String(randomUUID()).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  let nonce;
  do nonce = `${process[RUN_SEQ] = (process[RUN_SEQ] ?? 0) + 1}-${uuid}`; while (canaryEnvKeys(nonce).some((key) => Object.hasOwn(process.env, key)));
  const canary = Object.fromEntries(
    ['own', 'sibling', 'sshKey', 'awsKey', 'envKey', 'envAws', 'decoyArg', 'decoyEnv', 'residue'].map((name) => [name, `bm-canary-${randomUUID()}`]),
  );
  const leaked = (data) => {
    const text = JSON.stringify(data ?? null);
    return Object.entries(canary).some(([name, value]) => name !== 'own' && text.includes(value));
  };
  const root = path.join(base, 'workspaces');
  const siblingName = `ws-b-${nonce}`;
  const own = path.join(root, `ws-a-${nonce}`);
  const sibling = path.join(root, siblingName);
  const app = path.join(base, 'app');
  const fakeHome = path.join(base, 'host-home');
  const realHome = os.homedir();
  const rootFile = `/var/tmp/bm-redteam-${nonce}`;
  // 键名带本轮标记：同一进程里重叠的两轮各用各的键，也不占调用方自己设的同名变量。两个键名都要命中 SENSITIVE_ENV。
  const [envKey, envAws] = canaryEnvKeys(nonce);
  const hostEnv = { [envKey]: canary.envKey, [envAws]: canary.envAws };
  const hostEnvIntact = () => Object.entries(hostEnv).every(([key, value]) => process.env[key] === value);
  const server = http.createServer((request, response) => response.end('ok'));
  const fixtureErrors = [];
  let connections = 0;
  let decoy;

  try {
    // 从选键到这里没有 await：占位是原子的，别的轮次选键时已经看得到这两个键。
    Object.assign(process.env, hostEnv);
    for (const dir of [own, sibling, app, path.join(fakeHome, '.ssh'), path.join(fakeHome, '.aws')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(own, 'own.txt'), canary.own);
    fs.writeFileSync(path.join(sibling, 'secret.txt'), canary.sibling);
    fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_ed25519'), canary.sshKey);
    fs.writeFileSync(path.join(fakeHome, '.aws', 'credentials'), canary.awsKey);
    fs.writeFileSync(path.join(app, 'engine.txt'), 'engine');
    fs.copyFileSync(self, path.join(app, 'probe.mjs'));
    // 植不进去（Windows 上没有建符号链接的权限）要记下来：对应的尝试没有真打到靶子上，这一项不能算拦住。
    for (const [attempt, name, target, type] of [
      ['planted-symlink-file', 'escape-link', path.join('..', siblingName, 'secret.txt')],
      // Windows 的目录联接只认绝对目标。
      ['planted-symlink-dir', 'escape-dir', process.platform === 'win32' ? sibling : path.join('..', siblingName), 'junction'],
    ]) {
      try {
        fs.symlinkSync(target, path.join(own, name), type);
      } catch (error) {
        fixtureErrors.push({ item: 'cross_workspace_read', text: `${attempt}: ${String(error.code ?? error.name)}` });
      }
    }
    server.on('connection', () => {
      connections += 1;
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    // 诱饵起来先在标准输出上说一声，宿主机听到并确认进程在，才算就绪。
    decoy = spawn(process.execPath, ['-e', DECOY_SOURCE, DECOY_TAG, canary.decoyArg], {
      cwd: sibling, env: { ...bareEnv(), BM_DECOY_SECRET: canary.decoyEnv }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const decoyLines = readline.createInterface({ input: decoy.stdout });
    // 进程号可能被别的进程顶替，0 号信号说了不算：先认宿主机手里的子进程状态与退出事件。
    let decoyExited = false;
    for (const event of ['exit', 'close']) decoy.once(event, () => { decoyExited = true; });
    // 往已经退出的诱饵写 ping 会报 EPIPE：没人接的 error 事件会把宿主机进程带崩。
    decoy.stdin.on('error', () => { decoyExited = true; });
    const decoyAlive = () => {
      if (decoyExited || decoy.exitCode !== null || decoy.signalCode !== null) return false;
      try {
        process.kill(decoy.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // 退出通知可能晚到（Windows 上由线程池异步投回），等多久都有时间窗：宿主机亲自 ping 一次，只认带本轮标记的 pong。
    // 写不进去、标准输出断了、退出、超时，哪一种都算它不在了；已经退出的或顶替它进程号的进程回不出这一行。
    const decoyAnswers = async () => {
      if (!decoyAlive()) return false;
      let timer;
      try {
        return await new Promise((resolve) => {
          const dead = () => resolve(false);
          timer = setTimeout(dead, DECOY_PONG_MS);
          decoyLines.on('line', (line) => { if (line === `pong:${canary.decoyArg}`) resolve(true); });
          decoyLines.once('close', dead);
          for (const event of ['exit', 'close', 'error']) decoy.once(event, dead);
          decoy.stdin.once('error', dead);
          decoy.stdin.write('ping\n', (error) => { if (error) dead(); });
        });
      } finally {
        clearTimeout(timer);
      }
    };
    const decoyGone = (when) => fixtureErrors.push({ item: 'cross_workspace_processes', text: `诱饵进程${when}` });
    const ready = await new Promise((resolve) => {
      decoyLines.once('line', (line) => resolve(line === 'ready'));
      decoy.once('error', () => resolve(false));
      decoy.once('exit', () => resolve(false));
    });
    if (!ready || !decoyAlive()) decoyGone('没起来');

    const [externalHost, externalPort] = externalTarget.split(':');
    const cfg = {
      own: canary.own, nonce, siblingName, siblingDir: sibling, siblingSecret: path.join(sibling, 'secret.txt'), fakeHome, realHome,
      port: server.address().port, externalHost, externalPort: Number(externalPort), dnsName, decoyPid: decoy.pid,
    };
    const evidence = {
      external_network: () => (connections ? `宿主机监听端口收到 ${connections} 个连接` : null),
      readonly_image_write: () => {
        const found = [];
        if (fs.readFileSync(path.join(app, 'engine.txt'), 'utf8') !== 'engine') found.push('engine.txt 被改写');
        if (fs.readdirSync(app).length !== 2) found.push('引擎目录里多了文件');
        for (const file of [rootFile, path.join(sibling, `planted-${nonce}.txt`), path.join(fakeHome, `planted-${nonce}.txt`)]) {
          if (fs.existsSync(file)) found.push(`沙箱外多了文件 ${path.basename(file)}`);
        }
        return found.join('') || null;
      },
    };

    const items = [];
    let used;
    for (const { id, title, expectedAttempts } of ITEMS) {
      // 环境变量诱饵要在这一项实测的前后两端都原样挂在宿主机上：不在的话，探针回的「没读到」什么也说明不了。
      const envPlanted = id !== 'host_home_and_secrets' || hostEnvIntact();
      const result = await execute({
        request: { mode: 'cards-data' }, workspacesRoot: root, workspaceDir: own, appDir: app,
        command: ['node', '/app/probe.mjs', '--probe', id, JSON.stringify(cfg)],
        backend, runtime, image, allowDegraded, timeoutMs: 30_000,
      });
      used = result;
      if (id === 'host_home_and_secrets' && !(envPlanted && hostEnvIntact())) fixtureErrors.push({ item: id, text: '宿主机环境变量诱饵缺失或被改写' });
      let parsed = null;
      try {
        parsed = JSON.parse(result.stdout.split('\n').find((line) => line.includes(SENTINEL)));
      } catch {
        parsed = null;
      }
      const receipts = Array.isArray(parsed?.attempts) ? parsed.attempts : [];
      const receiptErrors = [];
      if (parsed && !Array.isArray(parsed.attempts)) receiptErrors.push('attempts 不是数组');
      const attempts = receipts.map((entry, index) => {
        const problem = receiptProblem(entry);
        if (problem) receiptErrors.push(`${typeof entry?.id === 'string' && entry.id ? entry.id : `第 ${index + 1} 条`}: ${problem}`);
        return { id: entry?.id, payload: entry?.payload, code: entry?.code ?? entry?.error, escaped: entry?.ok === true || leaked(entry?.data) };
      });
      // 探针的约定：全被拦退出 1，有一次得手退出 0。退出码和明细对不上（含被信号杀掉的 null），这份回执不可信。
      const expectedExit = receipts.some((entry) => entry?.ok === true) ? 0 : 1;
      if (parsed?.control === true && result.code !== expectedExit) receiptErrors.push(`探针退出码 ${result.code} 与明细矛盾（按明细应是 ${expectedExit}）`);
      if (id === 'cross_workspace_processes') {
        // 探针跑完、清理之前再确认一次：诱饵中途退出的话，「看不到它」什么也说明不了。
        if (!(await decoyAnswers()) && !fixtureErrors.some((entry) => entry.item === id)) decoyGone('在探针跑完之后答不上宿主机的 ping（已退出、卡死或进程号被顶替）');
        const memory = await warmResidue(pool, canary.residue);
        attempts.push({
          id: 'warm-process-residue', payload: '工作区 B 用过的预热进程再分给工作区 A，读它内存里留下的数据',
          code: memory === null ? 'CLEAN' : 'RESIDUE', escaped: memory !== null,
        });
      }
      const hostEvidence = evidence[id]?.() ?? null;
      const missingAttempts = expectedAttempts.filter((expected) => !attempts.some((entry) => entry.id === expected));
      const failedFixtures = fixtureErrors.filter((entry) => entry.item === id).map((entry) => entry.text);
      // 结论有效要四样齐：探针在自己的工作区里读写正常、每条回执完整并且和退出码自洽、预期的子尝试一个不少、攻击夹具都建起来并且活到最后。
      const conclusive = parsed?.control === true && parsed.item === id && !receiptErrors.length
        && !missingAttempts.length && !failedFixtures.length;
      const escaped = attempts.some((entry) => entry.escaped) || hostEvidence !== null;
      items.push({
        id, title,
        command: `node /app/probe.mjs --probe ${id} <夹具参数>`,
        exitCode: result.code,
        conclusive,
        escaped,
        blocked: conclusive && !escaped,
        blockedBy: backendInfo(result.backend).layers[id],
        hostEvidence,
        missingAttempts,
        receiptErrors,
        fixtureErrors: failedFixtures,
        attempts,
      });
    }

    const blocked = items.filter((item) => item.blocked).length;
    const report = {
      format: 'sandbox-redteam/0.1',
      generatedAt: new Date().toISOString(),
      platform: `${process.platform} ${os.release()} ${process.arch}`,
      node: process.version,
      backend: used.backend,
      isolation: used.isolation,
      boundary: backendInfo(used.backend).boundary,
      ok: blocked === ITEMS.length,
      blocked,
      total: ITEMS.length,
      items,
    };
    // 报告不带本机路径：夹具目录与真实家目录换成占位符。
    return mapStrings(report, (text) => text.replaceAll(base, '<夹具>').replaceAll(realHome, '<宿主机家目录>'));
  } finally {
    // 选键时两个键都不在场，删掉就是恢复原状。
    for (const key of Object.keys(hostEnv)) delete process.env[key];
    decoy?.kill('SIGKILL');
    pool.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(rootFile, { force: true });
    // Windows 上刚杀掉的诱饵进程还占着它的工作目录，多等几次。
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10 });
  }
}

/** 把报告写成 Markdown：每件一条，带命令、退出码、拦截层和后端边界。 */
export function formatRedTeamReport(report) {
  const mark = (item) => (!item.conclusive ? '结论无效' : item.escaped ? '是' : '否');
  const lines = [
    '# 工作区沙箱红队逃逸实测报告',
    '',
    `- 结论：${report.blocked}/${report.total} 项逃逸尝试被拦${report.ok ? '' : '，判红'}`,
    `- 实测后端：\`${report.backend}\`（隔离级别 \`${report.isolation}\`）`,
    `- 平台：${report.platform}，Node ${report.node}`,
    `- 时间：${report.generatedAt}`,
    `- 后端边界：${report.boundary}`,
    '- 探针退出码：1 是全部尝试失败，0 是至少一次得手，3 是沙箱里连自己的工作区都读写不了（结论无效）。',
    '- 一项算拦住，要它预期的子尝试全部跑到并且全部失败；少跑一个、回执不完整或与退出码矛盾、攻击夹具没建起来或没活到最后，都是结论无效。',
    '',
    '| # | 逃逸尝试 | 命令 | 退出码 | 拦截层 | 逃逸 |',
    '|---|---|---|---|---|---|',
    ...report.items.map((item, index) => `| ${index + 1} | ${item.title}（\`${item.id}\`） | \`${item.command}\` | ${item.exitCode} | ${item.blockedBy} | ${mark(item)} |`),
  ];
  for (const [index, item] of report.items.entries()) {
    lines.push('', `## ${index + 1} ${item.title}`, '', '| 载荷 | 实测错误码 | 逃逸 |', '|---|---|---|');
    for (const entry of item.attempts) lines.push(`| ${entry.payload}（\`${entry.id}\`） | \`${entry.code}\` | ${entry.escaped ? '是' : '否'} |`);
    lines.push('', `宿主机一侧的核对：${item.hostEvidence ?? '没有发现逃逸痕迹'}。`);
    if (item.missingAttempts?.length) lines.push('', `结论无效，少跑了子尝试：${item.missingAttempts.map((id) => `\`${id}\``).join('、')}。`);
    if (item.receiptErrors?.length) lines.push('', `结论无效，回执不完整或自相矛盾：${item.receiptErrors.map((text) => `\`${text}\``).join('、')}。`);
    if (item.fixtureErrors?.length) lines.push('', `结论无效，攻击夹具没建起来：${item.fixtureErrors.map((text) => `\`${text}\``).join('、')}。`);
  }
  return `${lines.join('\n')}\n`;
}

async function cli() {
  const { values } = parseArgs({
    options: {
      json: { type: 'string' }, md: { type: 'string' }, backend: { type: 'string' }, runtime: { type: 'string' }, image: { type: 'string' },
      'allow-degraded': { type: 'boolean', default: false },
    },
  });
  const report = await runSandboxRedTeam({ backend: values.backend, runtime: values.runtime, image: values.image, allowDegraded: values['allow-degraded'] });
  const markdown = formatRedTeamReport(report);
  if (values.json) fs.writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  if (values.md) fs.writeFileSync(values.md, markdown);
  else process.stdout.write(markdown);
  process.exitCode = report.ok ? 0 : 4;
}

// 被别的模块引入时不是入口：argv[1] 可能根本不是文件，认不出来就按不是入口算。
function isEntry() {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  if (process.argv[2] === '--probe') await probeMain(process.argv[3], JSON.parse(process.argv[4]));
  else if (process.argv[2] === '--warm-worker') warmWorkerMain();
  else {
    await cli().catch((error) => {
      process.stderr.write(`${error.code ?? 'failure'}: ${error.message}\n`);
      process.exitCode = String(error.code).startsWith('env.') ? 3 : 1;
    });
  }
}
