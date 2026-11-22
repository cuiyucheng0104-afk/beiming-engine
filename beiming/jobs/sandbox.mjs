// 工作区隔离执行层（A13）。一份隔离规格，三种渲染：OCI 容器、macOS seatbelt 进程策略、没有内核隔离的降级子进程。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import { safePath } from './workspace.mjs';

export const AUTHOR_MODE = 'cards-data';

const workspaceIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
// 按白名单收数据文件：没列在这里的扩展名（脚本、可执行文件、没有扩展名的文件）一律拒收。
const dataExtensions = new Set([
  '.json', '.csv', '.tsv', '.txt', '.srt', '.vtt',
  '.png', '.jpg', '.jpeg', '.webp', '.exr', '.hdr',
  '.glb', '.gltf', '.bin',
  '.wav', '.mp3', '.ogg', '.flac', '.mp4', '.mov', '.webm',
  '.ttf', '.otf', '.woff2',
]);
const fixedEnv = Object.freeze({
  HOME: '/tmp/home',
  TMPDIR: '/tmp',
  LC_ALL: 'C',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  BEIMING_WORKSPACE: '/workspace',
  BEIMING_APP: '/app',
});
// 用 Map 不用对象：toString、constructor 这些原型链上的键查不出东西来。
const isolationOf = new Map([
  ['oci', 'oci-container'],
  ['darwin-seatbelt', 'seatbelt-process-policy'],
  ['portable', 'needs-oci-runtime'],
]);
const ociRuntimes = new Set(['docker', 'podman']);
// 本进程里已经出过合格规格的工作区根与引擎目录（规范化后），跨调用查互相包含用。
const trusted = { roots: new Set(), apps: new Set() };
// 不存在的根：拿它调 safePath 只做词法校验，查符号链接的那一步不会命中。
const noWorkspace = path.join(os.tmpdir(), `bm-u8-${randomUUID()}`);
const seatbeltBinary = '/usr/bin/sandbox-exec';
const outputCap = 8 * 1024 * 1024;

function codedError(code, message, details) {
  return Object.assign(new Error(message), { code }, details);
}

function tryReal(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

// child 就是 parent 或在它里面。Windows 上跨盘符时 path.relative 给出绝对路径，按不在里面算。
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const overlaps = (a, b) => inside(a, b) || inside(b, a);
const isPlain = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const ownTrue = (object, key) => Object.hasOwn(object, key) && object[key] === true;

// 根目录与盘符卷根（/、D:\、D:/、D:）。Windows 上别的盘的卷根不包住家目录，靠「包住家目录」认不出来，按写法单独认；
// 用 path.win32 认，在 POSIX 上碰到 Windows 写法也一样拒收；先按 Windows 规则规范化，D://、D:/. 这类写法一并认出来。
function isVolumeRoot(dir) {
  if (typeof dir !== 'string' || dir === '') return false;
  const win = path.win32.normalize(dir);
  return path.parse(dir).root === dir || path.win32.parse(win).root.toLowerCase() === win.toLowerCase() || /^[A-Za-z]:[\\/]?$/.test(dir);
}

// 不该挂进沙箱的宿主机目录：卷根，包住家目录的（含家目录本身），和家目录下带点开头段的（.ssh、.aws、.config 这类配置与凭据目录）。
function hostSensitive(dir) {
  if (isVolumeRoot(dir)) return '不得是根目录或盘符卷根';
  const home = tryReal(os.homedir());
  if (inside(dir, home)) return '不得是根目录、家目录或包住家目录的目录';
  if (inside(home, dir) && path.relative(home, dir).split(path.sep).some((segment) => segment.startsWith('.'))) {
    return '不得在家目录下点开头的配置与凭据目录里';
  }
  return null;
}

/**
 * U8：对外服务只收「卡加数据」。构建脚本、原生代码、入口文件、调用方自带命令、非数据文件一律拒收。
 * 请求自己、request.shot、request.film.shots[] 里的每个镜头和它们的 renderer 都查：出帧用的是 renderer 那一套（film 契约 3.3）。
 * 只认普通对象的自有属性，从原型链继承来的 mode 不算数。给了 workspaceDir，文件清单连工作区里的符号链接一起查。
 */
export function enforceAuthorMode(request, workspaceDir = noWorkspace) {
  const refuse = (message, details) => {
    throw codedError('contract.unsupported-mode', message, details);
  };
  const checkModes = (target, where) => {
    if (!isPlain(target)) refuse(`${where} 必须是普通对象。`, { where });
    if (!Object.hasOwn(target, 'mode') || target.mode !== AUTHOR_MODE) {
      refuse(`对外服务只收「卡加数据」（cards-data）模式的作业，${where}.mode 不是。`, { where });
    }
    if (Object.hasOwn(target, 'entry')) refuse(`「卡加数据」模式的作业不得带入口文件（${where}.entry）。`, { where });
  };
  const checkShot = (shot, where) => {
    checkModes(shot, where);
    if (Object.hasOwn(shot, 'renderer')) checkModes(shot.renderer, `${where}.renderer`);
  };
  checkShot(request, 'request');
  if (Object.hasOwn(request, 'command')) refuse('不接受调用方指定的执行命令。');
  if (Object.hasOwn(request, 'shot')) checkShot(request.shot, 'request.shot');
  if (Object.hasOwn(request, 'film')) {
    const { film } = request;
    if (!isPlain(film) || !Object.hasOwn(film, 'shots') || !Array.isArray(film.shots) || !film.shots.length) {
      refuse('request.film 必须是带 shots 数组的片子描述。');
    }
    // entries() 连数组里的空位也走到。
    for (const [index, shot] of film.shots.entries()) checkShot(shot, `request.film.shots[${index}]`);
  }
  const files = Object.hasOwn(request, 'files') ? request.files : [];
  if (!Array.isArray(files)) refuse('files 必须是相对路径数组。');
  for (const file of files) {
    // safePath 的控制字符检查到 0x1f 为止，这里连 DEL（0x7f）一起先拒。
    // eslint-disable-next-line no-control-regex
    if (typeof file === 'string' && /[\x00-\x1f\x7f]/.test(file)) throw codedError('contract.bad-path', 'files 里的路径不得含控制字符（含 DEL）。');
    if (typeof file !== 'string' || !dataExtensions.has(path.posix.extname(file).toLowerCase())) {
      refuse(`只收数据文件，不收脚本或可执行文件：${String(file)}`, { path: file });
    }
    // 路径写法不对（.. 段、. 段、前导 /、反斜杠、控制字符、经过符号链接）报 contract.bad-path。
    safePath(workspaceDir, file);
  }
  return request;
}

/**
 * 认出一个工作区：规范化后必须是工作区根的直接子目录，自己不是符号链接，不是宿主机的敏感目录，
 * 工作区根也不和本进程已登记的工作区根、引擎目录互相包含。
 */
export function resolveWorkspace({ workspacesRoot, workspaceDir } = {}) {
  if (typeof workspacesRoot !== 'string' || typeof workspaceDir !== 'string' || !workspacesRoot || !workspaceDir) {
    throw codedError('usage.bad-argument', 'workspacesRoot 与 workspaceDir 必须是非空路径。');
  }
  const refuse = (message) => {
    throw codedError('contract.bad-path', message);
  };
  if (isVolumeRoot(workspacesRoot) || isVolumeRoot(workspaceDir)) refuse('工作区根与工作区都不得是根目录或盘符卷根。');
  if (workspaceDir.split(/[\\/]/).includes('..')) refuse('工作区路径不得含 .. 段。');
  // path.resolve 去掉结尾的分隔符：带着它 lstat 会跟过符号链接。
  const given = path.resolve(workspaceDir);
  const stat = fs.lstatSync(given, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) refuse('工作区必须是已存在的目录，不得是符号链接。');
  const root = fs.realpathSync.native(workspacesRoot);
  const dir = fs.realpathSync.native(given);
  // 换一种写法指到卷根的（<顶层目录>/.. 这类），规范化之后再认一次。
  if (isVolumeRoot(root)) refuse('工作区根不得是根目录或盘符卷根。');
  const workspaceId = path.relative(root, dir);
  if (path.dirname(dir) !== root || !workspaceIdPattern.test(workspaceId)) {
    refuse('工作区必须是工作区根的直接子目录，目录名只用小写字母、数字和连字符。');
  }
  const sensitive = hostSensitive(dir);
  if (sensitive) refuse(`工作区${sensitive}。`);
  // 工作区只能是根的直接子目录，所以根两两不互相包含，工作区也就两两不互相包含。
  if ([...trusted.roots].some((other) => other !== root && overlaps(other, root)) || [...trusted.apps].some((app) => overlaps(app, root))) {
    refuse('工作区根不得与本进程已登记的工作区根或引擎目录互相包含。');
  }
  return { root, dir, workspaceId };
}

/** 校验一份隔离规格，返回违例说明；空数组才合格。 */
export function validateContainerSpec(spec) {
  const bad = [];
  const need = (ok, message) => {
    if (!ok) bad.push(message);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  need(spec?.network === 'none', '网络必须是 none。');
  need(spec?.readOnlyRoot === true, '根文件系统必须只读。');
  need(same(spec?.capDrop, ['ALL']), '必须丢掉全部 capability。');
  need(same(spec?.securityOpt, ['no-new-privileges']), 'security-opt 只能是 no-new-privileges。');
  need(/^[1-9]\d*:\d+$/.test(spec?.user), '必须以非 root 用户运行。');
  need(Number.isInteger(spec?.pidsLimit) && spec.pidsLimit > 0 && spec.pidsLimit <= 4096, 'pids-limit 必须是 1 到 4096 的整数。');
  need(same(spec?.tmpfs, ['/tmp']), '只能有 /tmp 一个 tmpfs。');
  need(same(spec?.env, fixedEnv), '环境变量只能是固定白名单，不得带宿主机的变量。');
  need(spec?.workdir === '/workspace', '工作目录必须是 /workspace。');
  need(spec?.image === null || /^[a-z0-9][\w./:@-]*$/i.test(spec?.image), '镜像名不合法。');
  need(
    Array.isArray(spec?.command) && spec.command[0] === 'node' && spec.command.every((arg) => typeof arg === 'string'),
    '命令必须是以 node 开头的字符串数组。',
  );
  const mounts = Array.isArray(spec?.mounts) ? spec.mounts : [];
  const shape = mounts.map((mount) => [mount?.target, mount?.readOnly]);
  if (!same(shape, [['/workspace', false], ['/app', true]])) {
    bad.push('只能挂两处：本工作区到 /workspace（读写）、引擎目录到 /app（只读）。');
    return bad;
  }
  const [workspace, app] = mounts;
  // eslint-disable-next-line no-control-regex
  need(mounts.every((mount) => typeof mount.source === 'string' && !/[\x00-\x1f\x7f,"]/.test(mount.source)), '挂载源路径不得含逗号、引号或控制字符。');
  need(!mounts.some((mount) => isVolumeRoot(mount.source)), '挂载源不得是根目录或盘符卷根。');
  try {
    const resolved = resolveWorkspace({ workspacesRoot: spec.workspacesRoot, workspaceDir: workspace.source });
    need(
      resolved.root === spec.workspacesRoot && resolved.dir === workspace.source && resolved.workspaceId === spec.workspaceId,
      '/workspace 的挂载源必须是规范化后的本工作区目录。',
    );
    need(new RegExp(`^bm-ws-${resolved.workspaceId}-[a-f0-9]{8}$`).test(spec.containerName), '容器名必须绑定工作区标识。');
    const appDir = fs.realpathSync.native(app.source);
    need(appDir === app.source && fs.statSync(appDir).isDirectory(), '/app 的挂载源必须是规范化后的已有目录。');
    const sensitive = hostSensitive(appDir);
    need(!sensitive, `引擎目录${sensitive}。`);
    need(![resolved.root, ...trusted.roots].some((root) => overlaps(root, appDir)), '引擎目录不得与工作区根互相包含（含本进程已登记的工作区根）。');
  } catch (error) {
    bad.push(error.message);
  }
  return bad;
}

/** 给一个工作区生成一次性隔离规格：容器名每次不同，只挂这一个工作区和只读引擎目录。 */
export function buildContainerSpec({ workspacesRoot, workspaceDir, appDir, command, image = null } = {}) {
  const { root, dir, workspaceId } = resolveWorkspace({ workspacesRoot, workspaceDir });
  if (typeof appDir !== 'string' || !appDir) throw codedError('usage.bad-argument', 'appDir 必须是引擎运行时目录的路径。');
  // 规范化之前先认原始写法：POSIX 上当前目录里有叫 D: 的普通目录时，tryReal 会把 D:/ 解析成它。
  if (isVolumeRoot(appDir)) throw codedError('usage.bad-argument', 'appDir 不得是根目录或盘符卷根。');
  const uid = process.getuid?.();
  const spec = {
    format: 'workspace-sandbox/0.1',
    workspaceId,
    workspacesRoot: root,
    containerName: `bm-ws-${workspaceId}-${randomUUID().slice(0, 8)}`,
    image,
    network: 'none',
    readOnlyRoot: true,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges'],
    // 宿主机上本来就不是 root 时沿用它的 uid，读写挂进去的工作区才有权限。
    user: uid ? `${uid}:${process.getgid()}` : '65534:65534',
    pidsLimit: 256,
    tmpfs: ['/tmp'],
    mounts: [
      { source: dir, target: '/workspace', readOnly: false },
      { source: tryReal(appDir), target: '/app', readOnly: true },
    ],
    env: { ...fixedEnv },
    workdir: '/workspace',
    command,
  };
  const violations = validateContainerSpec(spec);
  if (violations.length) throw codedError('usage.bad-argument', `隔离规格不合格：${violations.join('')}`, { violations });
  trusted.roots.add(root);
  trusted.apps.add(spec.mounts[1].source);
  return spec;
}

function ociArgs(spec) {
  if (typeof spec.image !== 'string') throw codedError('usage.bad-argument', 'oci 后端必须给出带 node 的镜像名（image）。');
  return [
    'run', '--rm', '--name', spec.containerName,
    `--network=${spec.network}`,
    ...(spec.readOnlyRoot ? ['--read-only'] : []),
    ...spec.capDrop.map((cap) => `--cap-drop=${cap}`),
    ...spec.securityOpt.map((opt) => `--security-opt=${opt}`),
    '--user', spec.user,
    '--pids-limit', String(spec.pidsLimit),
    ...spec.tmpfs.flatMap((target) => ['--tmpfs', `${target}:rw,noexec,nosuid,nodev,size=256m`]),
    ...spec.mounts.flatMap((mount) => ['--mount', `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`]),
    '--workdir', spec.workdir,
    ...Object.entries(spec.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    spec.image,
    ...spec.command,
  ];
}

// 宿主机后端没有挂载命名空间：把规格里的容器内路径换成宿主机上的真实路径，node 换成当前这个 node。
function hostView(spec, tmpDir) {
  const pairs = [...spec.mounts.map((mount) => [mount.target, mount.source]), ['/tmp', tmpDir]];
  const map = (value) => {
    for (const [target, source] of pairs) {
      if (value === target) return source;
      if (value.startsWith(`${target}/`)) return path.join(source, value.slice(target.length + 1));
    }
    return value;
  };
  return {
    node: fs.realpathSync(process.execPath),
    args: spec.command.slice(1).map(map),
    env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, map(value)])),
    cwd: map(spec.workdir),
  };
}

function seatbeltProfile(spec, tmpDir, node) {
  const quote = JSON.stringify;
  const ancestors = new Set();
  for (const file of [...spec.mounts.map((mount) => mount.source), tmpDir, node]) {
    for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) ancestors.add(dir);
  }
  // Homebrew 的 node 是动态链接的，库和 OpenSSL 配置在它的前缀下面；官方包只依赖系统库。
  const brew = /^(.*)\/Cellar\/node[^/]*\//.exec(node)?.[1];
  const brewRead = brew ? ['Cellar', 'opt', 'etc'].map((name) => ` (subpath ${quote(`${brew}/${name}`)})`).join('') : '';
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    `(allow process-exec (literal ${quote(node)}))`,
    '(allow signal (target self))',
    '(allow process-info* (target self))',
    '(allow sysctl-read)',
    `(allow file-read* (literal "/") (literal ${quote(node)}) (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")${brewRead})`,
    '(allow file-write-data (literal "/dev/null"))',
    `(allow file-read-metadata ${[...ancestors].map((dir) => `(literal ${quote(dir)})`).join(' ')})`,
    ...spec.mounts.map((mount) => `(allow file-read*${mount.readOnly ? '' : ' file-write*'} (subpath ${quote(mount.source)}))`),
    `(allow file-read* file-write* (subpath ${quote(tmpDir)}))`,
    spec.network === 'none' ? '(deny network*)' : '(allow network*)',
  ].join('\n');
}

// 默认拒绝：后端名只认 isolationOf 里的三个；portable 没有内核级隔离，要调用方亲手写上 allowDegraded: true。
function admitBackend(backend, allowDegraded) {
  if (typeof backend !== 'string' || !isolationOf.has(backend)) {
    throw codedError('usage.bad-argument', `不认识的沙箱后端：${typeof backend === 'string' ? backend : typeof backend}`);
  }
  if (backend === 'portable' && allowDegraded !== true) {
    throw codedError('env.missing-tool', '本机没有可用的内核级隔离（docker、podman 或 sandbox-exec），拒绝执行工作区作业。');
  }
  return isolationOf.get(backend);
}

/** 把规格渲染成要起的进程（不执行、不校验规格）。宿主机后端要给专属临时目录 tmpDir；portable 要自有的 allowDegraded: true。 */
export function planSandboxExec(spec, options = {}) {
  const { backend, runtime = 'docker', tmpDir } = options;
  const isolation = admitBackend(backend, ownTrue(options, 'allowDegraded'));
  if (backend === 'oci') {
    if (!ociRuntimes.has(runtime)) throw codedError('usage.bad-argument', 'oci 后端的运行时只认 docker 与 podman。');
    return { backend, isolation, file: runtime, args: ociArgs(spec) };
  }
  if (typeof tmpDir !== 'string' || !tmpDir) throw codedError('usage.bad-argument', '宿主机后端必须给专属临时目录 tmpDir。');
  const view = hostView(spec, tmpDir);
  if (backend === 'darwin-seatbelt') {
    return {
      backend, isolation, file: seatbeltBinary,
      args: ['-p', seatbeltProfile(spec, tmpDir, view.node), view.node, ...view.args],
      env: view.env, cwd: view.cwd,
    };
  }
  // 普通宿主 node 子进程只给 portable，不当别的后端的兜底。
  if (backend !== 'portable') throw codedError('usage.bad-argument', `后端 ${backend} 没有渲染方式。`);
  // Windows 上没有 SystemRoot 时 node 的网络与随机数初始化会失败；它不是凭据。
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== 'win32') {
    return { backend, isolation, file: view.node, args: view.args, env: systemRoot ? { ...view.env, SystemRoot: systemRoot } : view.env, cwd: view.cwd };
  }
  // Windows 上 libuv 起子进程时，下面这些变量没给就从父进程补（deps/uv/src/win/process.c 的 required_vars），
  // 宿主机的家目录、临时目录和用户名会漏进去：逐个给成沙箱自己的值或中性值。系统目录与系统盘不是凭据，照宿主机的。
  const { HOME, TMPDIR } = view.env;
  const drive = path.win32.parse(HOME).root.replace(/[\\/]+$/, '');
  const env = {
    ...view.env,
    USERPROFILE: HOME, HOMEDRIVE: drive, HOMEPATH: HOME.slice(drive.length),
    TEMP: TMPDIR, TMP: TMPDIR,
    USERNAME: 'sandbox', USERDOMAIN: 'SANDBOX', LOGONSERVER: '\\\\SANDBOX',
    SystemRoot: systemRoot || 'C:\\Windows',
    WINDIR: process.env.WINDIR || systemRoot || 'C:\\Windows',
    SYSTEMDRIVE: process.env.SYSTEMDRIVE || 'C:',
  };
  return { backend, isolation, file: view.node, args: view.args, env, cwd: view.cwd };
}

/** 探测本机能用的后端。macOS 上先试跑一次 sandbox-exec：已经在沙箱里时它起不来。 */
export function detectSandboxBackend() {
  const works = (file, args) => spawnSync(file, args, { stdio: 'ignore' }).status === 0;
  if (process.platform === 'darwin' && works(seatbeltBinary, ['-p', '(version 1)(allow default)', '/usr/bin/true'])) {
    return { backend: 'darwin-seatbelt' };
  }
  if (process.platform === 'linux') {
    for (const runtime of ['docker', 'podman']) {
      if (works(runtime, ['--version'])) return { backend: 'oci', runtime };
    }
  }
  return { backend: 'portable' };
}

function collect(plan, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, { env: plan.env, cwd: plan.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = { stdout: '', stderr: '' };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // shortcut: 只杀主进程，宿主机后端上作业另起会话的后台进程留着（仍在策略内）；对外服务用 oci 后端，停容器时一并清掉。
      child.kill('SIGKILL');
      onTimeout();
    }, timeoutMs);
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8').on('data', (chunk) => {
        // 超过上限的输出丢掉，作业刷屏不拖垮宿主进程。
        if (out[name].length < outputCap) out[name] += chunk;
      });
    }
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? codedError('env.missing-tool', `找不到沙箱后端的可执行文件：${plan.file}`) : error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, ...out });
    });
  });
}

/**
 * 在一次性沙箱里跑一个工作区的作业：先过 U8 守卫，再认后端，生成并校验隔离规格，然后按后端执行。
 * 后端名不在三个之列立即报错。没有内核级隔离的 portable 后端默认拒跑；自有的 allowDegraded: true 只给本机调试用，
 * 结果的 isolation 是 needs-oci-runtime。
 */
export async function runInWorkspaceSandbox(options = {}) {
  const { request, backend, runtime, timeoutMs = 600_000, ...specOptions } = options;
  enforceAuthorMode(request);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw codedError('usage.bad-argument', 'timeoutMs 必须是正整数毫秒。');
  const allowDegraded = ownTrue(options, 'allowDegraded');
  const chosen = backend === undefined ? detectSandboxBackend() : { backend, runtime };
  admitBackend(chosen.backend, allowDegraded);
  const spec = buildContainerSpec(specOptions);
  // 文件清单对着真实工作区再查一遍：不得经过工作区里的符号链接。
  enforceAuthorMode(request, spec.mounts[0].source);
  const tmpDir = chosen.backend === 'oci' ? undefined : fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-sandbox-')));
  try {
    if (tmpDir) fs.mkdirSync(path.join(tmpDir, 'home'));
    const plan = planSandboxExec(spec, { ...chosen, tmpDir, allowDegraded });
    const result = await collect(plan, timeoutMs, () => {
      // 杀掉 docker 客户端不等于停掉容器。
      if (plan.backend === 'oci') spawnSync(plan.file, ['kill', spec.containerName], { stdio: 'ignore' });
    });
    return { backend: plan.backend, isolation: plan.isolation, workspaceId: spec.workspaceId, containerName: spec.containerName, ...result };
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * 干净空进程预热池。spawn() 不带任何参数：预热时没有工作区可绑，进程里也就没有任何工作区的数据。
 * 一个进程只借给一个工作区用一次，归还即销毁，再补一个新的；用过的进程不会回到池里。
 */
export class WarmProcessPool {
  #idle = [];
  #spawn;
  #destroy;
  #size;
  #closed = false;

  constructor({ size = 1, spawn: spawnProcess, destroy = (child) => child.kill('SIGKILL') } = {}) {
    if (typeof spawnProcess !== 'function' || !Number.isInteger(size) || size < 0) {
      throw codedError('usage.bad-argument', '预热池要给 spawn 函数和非负整数 size。');
    }
    this.#spawn = spawnProcess;
    this.#destroy = destroy;
    this.#size = size;
  }

  get idle() {
    return this.#idle.length;
  }

  warm() {
    while (!this.#closed && this.#idle.length < this.#size) this.#idle.push(this.#spawn());
    return this;
  }

  acquire(workspaceId) {
    if (!workspaceIdPattern.test(workspaceId)) throw codedError('usage.bad-argument', '借预热进程要给工作区标识。');
    const child = this.#idle.shift() ?? this.#spawn();
    let released = false;
    return {
      workspaceId,
      process: child,
      release: () => {
        if (released) return;
        released = true;
        this.#destroy(child);
        this.warm();
      },
    };
  }

  close() {
    this.#closed = true;
    for (const child of this.#idle.splice(0)) this.#destroy(child);
  }
}
