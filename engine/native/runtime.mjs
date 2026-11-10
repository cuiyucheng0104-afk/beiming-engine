#!/usr/bin/env node
// 北冥引擎 · 原生层 · 运行时锁定与获取：外部原生运行时（上游项目名 RAEA，FSL-1.1-ALv2）不随仓库分发，
// 这里按 engine/native/runtime.lock.json 核对版本与哈希，并在用户明确接受许可后把官方发行包装到本机缓存。
//
//   node engine/native/runtime.mjs status [--json]       读 RAEA_BIN：版本、平台、可执行文件 sha256 是否与锁一致（不启动 GPU）
//   node engine/native/runtime.mjs hash [--json]         打印 RAEA_BIN 的可执行文件与 VERSION 哈希（给维护者补齐锁里 null 的平台）
//   node engine/native/runtime.mjs fetch --accept-license [--platform macos-arm64|windows-x64|linux-x64] [--dest 目录] [--from 本地归档]
//        从锁里的官方发行地址下载归档（或用 --from 指定已下载的归档），校验归档 sha256 → 解包到
//        <缓存>/beiming/raea/<版本>/<平台>/ → 校验可执行文件 sha256 → 打印 RAEA_BIN 应设的值。不传 --accept-license 拒绝执行（exit 2）。
//        缓存位置：XDG_CACHE_HOME 或 ~/.cache（Windows 用 %LOCALAPPDATA%）。
//
// 代码里：resolveRuntime({ allowVersion }) → { exe, version, platform, binarySha256, lock, entry, verified, problems }
//   exe 是 RAEA_BIN 按调用者当前目录解析后的绝对路径（相对路径也可，之后所有调用都用它）；
//   verified：true 哈希与锁一致；'unlocked' 该平台锁里还没有哈希；'allowed' 用 BNE_ALLOW_VERSION 放行的未验证版本。
//   版本不符、哈希不符、文件缺失 / 不可执行 → exit 3（env.*）。
// 退出码：0 · 2 用法（含未接受许可）· 3 运行时缺失或不合格 · 124 下载 / 解包超时。
import { access, constants, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EXIT, bind, exitWith, fail, log, runQuick, sha256File, warn } from './cli.mjs';
import { defineCommand, isMain, runCli } from '../../tools/lib/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOCK_PATH = join(HERE, 'runtime.lock.json');
export const loadLock = async () => JSON.parse(await readFile(LOCK_PATH, 'utf8'));

export function platformKey(platform = process.platform, arch = process.arch) {
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  return `${os}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}

const NO_BIN_HINT = '把 RAEA_BIN 设为原生运行时可执行文件的完整路径（安装包要保留 bin/ 与 share/）；没装就运行 node engine/native/runtime.mjs fetch --accept-license';

export async function resolveRuntime({ env = process.env, cwd = process.cwd(), lock } = {}) {
  lock ??= await loadLock();
  const raw = env.RAEA_BIN;
  if (!raw) throw fail(EXIT.ENV, 'no-runtime', '没有设置 RAEA_BIN（原生运行时不随仓库分发）', NO_BIN_HINT);
  const exe = resolve(cwd, raw);
  try { await access(exe, process.platform === 'win32' ? constants.F_OK : constants.X_OK); }
  catch { throw fail(EXIT.ENV, 'bad-runtime', `RAEA_BIN 指向的文件不存在或不可执行：${exe}`, process.platform === 'darwin' ? '检查路径；macOS 上被隔离的下载包先运行 xattr -dr com.apple.quarantine <安装目录>' : NO_BIN_HINT); }
  let real = exe;
  try { real = await realpath(exe); } catch { /* 用 exe */ }
  const versionFile = resolve(dirname(real), '../share/raea/VERSION');
  let version;
  try { version = (await readFile(versionFile, 'utf8')).trim(); }
  catch { throw fail(EXIT.ENV, 'bad-runtime', `找不到运行时版本声明 ${versionFile}`, '安装包要完整保留 bin/ 与 share/ 两个目录'); }
  const platform = platformKey(), entry = lock.platforms?.[platform] ?? null;
  const allow = env.BNE_ALLOW_VERSION;
  if (version !== lock.version && version !== allow) {
    throw fail(EXIT.ENV, 'runtime-version', `已验证的运行时版本是 ${lock.version}，RAEA_BIN 是 ${version}`, `换回 ${lock.version}；新版本要先重跑 routes/b-native/README.md「验收」一节，再用 BNE_ALLOW_VERSION=${version} 临时放行`);
  }
  const binarySha256 = await sha256File(real);
  let verified;
  const problems = [];
  if (version !== lock.version) { verified = 'allowed'; warn(`运行时 ${version} 是用 BNE_ALLOW_VERSION 放行的未验证版本，哈希不做核对`); }
  else if (!entry?.binarySha256) { verified = 'unlocked'; warn(`runtime.lock.json 里 ${platform} 还没有可执行文件哈希（实测值 ${binarySha256.slice(0, 12)}…）：用 node engine/native/runtime.mjs hash 补齐`); }
  else if (entry.binarySha256 !== binarySha256) {
    throw fail(EXIT.ENV, 'runtime-hash', `RAEA_BIN 的 sha256 ${binarySha256} 与锁定值 ${entry.binarySha256} 不符（同名版本被替换或被改动过）`, '重新获取：node engine/native/runtime.mjs fetch --accept-license，再把 RAEA_BIN 指向它打印的路径');
  } else verified = true;
  return { exe, real, version, versionFile, platform, binarySha256, lock, entry, verified, problems };
}

function cacheRoot() {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'beiming');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'beiming');
}

async function download(url, file, timeoutMs) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' }).catch(e => {
    throw fail(e.name === 'TimeoutError' ? EXIT.TIMEOUT : EXIT.ENV, 'download', `下载失败：${url}（${e.message}）`, '检查网络；也可以手动下载后用 --from <归档> 安装');
  });
  if (!r.ok) throw fail(EXIT.ENV, 'download', `下载失败：${url}（HTTP ${r.status}）`, '确认发行页仍在；也可以手动下载后用 --from <归档> 安装');
  await mkdir(dirname(file), { recursive: true });
  const out = createWriteStream(file);
  for await (const chunk of r.body) if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
  await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
}

async function findBinary(dir, name) {
  const want = name.split('/').pop();
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === want && p.split(/[\\/]/).slice(-2, -1)[0] === 'bin') return p;
    }
  }
  return null;
}

async function cmdFetch(a) {
  const lock = await loadLock();
  if (!a['accept-license']) {
    throw fail(EXIT.USAGE, 'license', `原生运行时以 ${lock.license} 许可发布，安装前要先阅读并接受：${lock.licenseUrl}`,
      '本仓库只把它用作内部制作层（自制影片、向客户交付成片），不分发运行时、不复制其源码；同意后加 --accept-license 重试');
  }
  const platform = a.platform || platformKey(), entry = lock.platforms[platform];
  if (!entry) throw fail(EXIT.USAGE, 'platform', `锁里没有平台 ${platform}`, `可用：${Object.keys(lock.platforms).join('、')}`);
  const dest = resolve(a.dest || join(cacheRoot(), 'raea', lock.version, platform));
  const archive = a.from ? resolve(a.from) : join(dest, '..', entry.archive);
  if (!a.from) { log(`下载 ${lock.downloadBase}${entry.archive}（约 ${(entry.size / 1e6).toFixed(0)} MB）……`); await download(lock.downloadBase + entry.archive, archive, 30 * 60 * 1000); }
  if (!existsSync(archive)) throw fail(EXIT.USAGE, 'no-archive', `找不到归档 ${archive}`);
  const archiveSha = await sha256File(archive);
  if (entry.sha256 && archiveSha !== entry.sha256) throw fail(EXIT.ENV, 'archive-hash', `归档 sha256 ${archiveSha} 与锁定值 ${entry.sha256} 不符`, '删掉这个归档重新下载；仍不符说明上游重打了同名包，先停下来核对');
  if (!entry.sha256) warn(`锁里 ${platform} 没有归档哈希；本次实测 ${archiveSha}，核对上游发行页的 .sha256 后再补进 runtime.lock.json`);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  log(`解包到 ${dest} ……`);
  const t = runQuick('tar', ['-xf', archive, '-C', dest], { timeoutMs: 10 * 60 * 1000, label: 'tar 解包' });
  if (t.status !== 0) throw fail(EXIT.ENV, 'extract', `解包失败：${t.stderr.trim()}`, 'Windows 10 及以上自带 tar（bsdtar）可解 zip；更旧的系统请手动解压后用 RAEA_BIN 指向 bin/raea.exe');
  const exe = await findBinary(dest, entry.binary);
  if (!exe) throw fail(EXIT.ENV, 'extract', `解包后找不到 ${entry.binary}`, '归档结构与锁里登记的不同：核对上游发行页');
  const binSha = await sha256File(exe);
  if (entry.binarySha256 && binSha !== entry.binarySha256) throw fail(EXIT.ENV, 'runtime-hash', `可执行文件 sha256 ${binSha} 与锁定值不符`);
  log(`已安装 ${lock.version}（${platform}）。设置：`);
  log(process.platform === 'win32' ? `  $env:RAEA_BIN = '${exe}'` : `  export RAEA_BIN="${exe}"`);
  // 运行时装在仓库外：信封的 outputs 只列仓库内产物，可执行文件路径放在 data（给人设 RAEA_BIN 用）
  return { data: { exe, archiveSha256: archiveSha, binarySha256: binSha, platform, version: lock.version } };
}

async function cmdStatus(a, hashOnly = false) {
  const lock = await loadLock();
  const r = await resolveRuntime({ lock });
  const versionSha = await sha256File(r.versionFile);
  if (hashOnly) {
    log(`平台 ${r.platform}，版本 ${r.version}`);
    log(`  binarySha256  ${r.binarySha256}`);
    log(`  VERSION sha256 ${versionSha}`);
    log('补锁：把 binarySha256 填进 engine/native/runtime.lock.json 对应平台；归档哈希用 shasum -a 256 / Get-FileHash 计算发行包得到。');
  } else {
    log(`运行时 ${r.version}（${r.platform}）：${r.exe}`);
    log(`  可执行文件 sha256 ${r.binarySha256.slice(0, 16)}…  ${r.verified === true ? '与 runtime.lock.json 一致' : r.verified === 'unlocked' ? '该平台尚未锁定' : '未验证版本（BNE_ALLOW_VERSION）'}`);
  }
  return { data: { exe: r.exe, version: r.version, platform: r.platform, verified: r.verified, binarySha256: r.binarySha256, versionSha256: versionSha } };
}

export const command = defineCommand({
  name: 'native:runtime',
  summary: '原生运行时（上游项目名 RAEA，FSL-1.1-ALv2）的核对、哈希与获取；运行时不随仓库分发',
  usage: [
    'node engine/native/runtime.mjs status [--json]',
    'node engine/native/runtime.mjs hash [--json]',
    'node engine/native/runtime.mjs fetch --accept-license [--platform <平台>] [--dest <目录>] [--from <归档>] [--json]',
  ],
  description: [
    '  status  核对 RAEA_BIN：版本、平台、可执行文件 sha256 与 engine/native/runtime.lock.json 是否一致（不启动 GPU）',
    '  hash    打印 RAEA_BIN 的哈希（给维护者补齐锁里还是 null 的平台）',
    '  fetch   从锁里的官方发行地址获取并校验运行时；本仓库只把它用作内部制作层（决定 D03），不分发运行时、不复制其源码，',
    '          必须显式 --accept-license。边界见 docs/rights/fsl-boundary.md',
  ],
  positionals: [{ name: 'sub', label: '<status|hash|fetch>', describe: '子命令' }],
  options: {
    'accept-license': { type: 'boolean', describe: 'fetch：已阅读并接受上游 FSL-1.1-ALv2 许可' },
    platform: { type: 'string', arg: '<平台>', choices: ['macos-arm64', 'windows-x64', 'linux-x64'], describe: 'fetch：要获取的平台（默认本机）' },
    dest: { type: 'string', arg: '<目录>', describe: 'fetch：解包目录（默认 <缓存>/beiming/raea/<版本>/<平台>/）' },
    from: { type: 'string', arg: '<归档>', describe: 'fetch：用已下载的发行归档，不联网' },
  },
  exitCodes: { 0: '成功', 2: '用法错误或未接受许可', 3: '运行时缺失、版本或哈希不符', 124: '下载 / 解包超时' },
  examples: ['node engine/native/runtime.mjs status', 'node engine/native/runtime.mjs fetch --accept-license'],
  async run(ctx) {
    bind(ctx);
    const a = { ...ctx.opts };
    const sub = ctx.args.sub;
    if (sub === 'fetch') return cmdFetch(a);
    if (sub === 'status') return cmdStatus(a);
    if (sub === 'hash') return cmdStatus(a, true);
    throw fail(EXIT.USAGE, 'bad-subcommand', `未知子命令 ${sub}`, '可用：status、hash、fetch');
  },
});

if (isMain(import.meta.url)) await exitWith(runCli(command));
