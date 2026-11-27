// 渲染底盘的构建：渲染程序 core-render 从仓库里的 beiming/sources/core/path/ 编（cargo build --locked --release），
// 构建目录与编好的程序都放在仓库根被忽略的 out/chassis/ 下，不往源码目录里写东西。内核用 include_str! 直接读
// beiming/sources/core/shaders/ 下的五个着色器，仓库里只有那一份；编之前核对这一点。编好的程序按源码内容的摘要另存，
// 摘要没变就不重编；摘要变了，先清掉构建目录里内核这个包上次的产物再编（cargo 只看文件时间，见 freshTarget）。负对照要故意改错源码时，把源码拷到 out/ 下的临时目录里改、在那里编，不动工作树里被跟踪的文件。
// 上游 ThreeRT（MIT，版权人 Meshy LLC）只在场景入口上还用得着：按固定提交取到 out/chassis/ 的缓存，核对提交号，
// 只用它的场景打包工具、场景库、自带的测试脚本与素材根目录；渲染程序不从那里编。来源见 ../path/PROVENANCE.md。
// 缺工具（git、cargo、npm、网络）时抛出的错误带 .missing，测试据此跳过。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CORE = path.join(HERE, '..');
// 缓存放在仓库根的 out/（被 git 与 ESLint 忽略）：上游自带的脚本要是放在 beiming/sources/core/out/ 会被 ESLint 查到
export const OUT = path.join(CORE, '..', '..', '..', 'out', 'chassis');
/** 内核源码与它的预设 */
export const KERNEL = path.join(CORE, 'path');
export const PRESETS = path.join(KERNEL, 'presets');
export const SHADERS = ['microfacet.wgsl', 'util.wgsl', 'area_light.wgsl', 'ggx_tables.wgsl', 'imaging.wgsl'];
/** 进构建的东西（相对 beiming/sources/core/）：内核的清单、锁、工具链、源码、着色器、预设，加上五个移植的着色器与
 *  内核 include_str! 读的广义 Schlick 两张表的数据（path/src/lib.rs 的 ggx_gen_schlick_tables） */
const INPUTS = ['path/Cargo.toml', 'path/Cargo.lock', 'path/Cargo-oidn23.lock', 'path/rust-toolchain.toml', 'path/src', 'path/shaders', 'path/presets', ...SHADERS.map(f => `shaders/${f}`), 'shaders/ggx_gen_schlick.tables'];
const EXE = process.platform === 'win32' ? '.exe' : '';

export const COMMIT = 'c946cc96bdb08979224e851a7fc67a066b1b456b';
const REPO = 'https://github.com/meshy-dev/ThreeRT.git';
/** 上游按固定提交的检出：只给场景打包与上游自带的测试脚本用 */
export const UPSTREAM = path.join(OUT, `upstream-${COMMIT.slice(0, 7)}`);

export const missing = what => Object.assign(new Error(what), { missing: what });
const sha256 = data => createHash('sha256').update(data).digest('hex');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30, encoding: 'utf8', ...opts });
  if (r.error?.code === 'ENOENT') throw missing(`找不到 ${cmd}`);
  if (r.error) throw r.error;
  return r;
}

function git(...args) {
  const r = sh('git', ['-C', UPSTREAM, ...args]);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr.trim()}`);
  return r.stdout;
}

/** cargo 先找 PATH，再找 ~/.cargo/bin（rustup 的默认位置，常常没进 PATH） */
export function cargoPath() {
  if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0) return 'cargo';
  const home = path.join(os.homedir(), '.cargo', 'bin', `cargo${EXE}`);
  if (fs.existsSync(home)) return home;
  throw missing('找不到 cargo（PATH 与 ~/.cargo/bin 里都没有）：装 Rust（rustup），内核的 rust-toolchain.toml 指定 1.100.0');
}

/**
 * cargo 不许联网时（环境变量 CARGO_NET_OFFLINE 是 true 或 1）的参数：显式带 --offline，缺包就报错、不去 crates.io 取。
 * cargo 自己也认这个变量，这里再写一遍，是让每一处调用都看得出它不联网。清构建目录（cargo clean）用不着网络，一律带。
 */
export function cargoNet(args) {
  return /^(true|1)$/i.test(process.env.CARGO_NET_OFFLINE ?? '') || args[0] === 'clean' ? [args[0], '--offline', ...args.slice(1)] : args;
}

/** 上游的缓存在、提交号对、已跟踪的文件没被改过就直接用；不在时 allowFetch 为真才去取。对不上，拒绝往下走 */
export function ensureUpstream({ allowFetch = true } = {}) {
  if (!fs.existsSync(UPSTREAM)) {
    if (!allowFetch) throw missing(`没有上游的缓存（${UPSTREAM}，打场景包要用）：先运行一次 level2.mjs，或设 BEIMING_CHASSIS_E2E=1`);
    fs.mkdirSync(UPSTREAM, { recursive: true });
    try {
      git('init', '-q');
      git('remote', 'add', 'origin', REPO);
      try { git('fetch', '-q', '--depth', '1', 'origin', COMMIT); } catch (e) { throw missing(`取不到上游源码：${e.message}`); }
      git('checkout', '-q', 'FETCH_HEAD');
    } catch (e) {
      fs.rmSync(UPSTREAM, { recursive: true, force: true });
      throw e;
    }
  }
  // 不是 git 目录时 git -C 会找到外层仓库，提交号同样对不上，一样拒绝
  let head;
  try { head = git('rev-parse', 'HEAD').trim(); } catch (e) { throw new Error(`拒绝使用：${UPSTREAM} 不是一份完整的检出（${e.message}）；删掉这个目录重取`, { cause: e }); }
  if (head !== COMMIT) throw new Error(`拒绝使用：${UPSTREAM} 的提交是 ${head}，不是固定的 ${COMMIT}；删掉这个目录重取`);
  if (git('status', '--porcelain', '--untracked-files=no').trim()) throw new Error(`拒绝使用：${UPSTREAM} 里上游的文件被改过；删掉这个目录重取`);
  return UPSTREAM;
}

/** 按固定提交的 package-lock.json 装上游的 npm 依赖（打场景包要 esbuild 与它的工作区包），不跑安装脚本 */
export function ensureNodeModules() {
  const lock = sha256(fs.readFileSync(path.join(UPSTREAM, 'package-lock.json')));
  const stamp = path.join(UPSTREAM, 'node_modules', '.beiming-lock');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === lock) return;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = sh(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: UPSTREAM });
  if (r.status !== 0) throw missing(`npm ci 失败（网络或 npm）：${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  fs.writeFileSync(stamp, lock);
}

/** INPUTS 展开成文件（相对 beiming/sources/core/，排好序） */
function inputFiles() {
  const out = [];
  const walk = rel => {
    if (!fs.statSync(path.join(CORE, rel)).isDirectory()) { out.push(rel); return; }
    for (const name of fs.readdirSync(path.join(CORE, rel)).sort()) walk(`${rel}/${name}`);
  };
  INPUTS.forEach(walk);
  return out;
}

/** 五个移植的着色器在仓库里只有一份：内核从 ../../shaders/ 读，path/ 下没有同名文件 */
export function singleCopyProblems() {
  const gpu = fs.readFileSync(path.join(KERNEL, 'src', 'gpu.rs'), 'utf8');
  const copies = inputFiles().filter(f => f.startsWith('path/') && SHADERS.includes(path.basename(f)));
  return [
    ...SHADERS.filter(f => !gpu.includes(`include_str!("../../shaders/${f}")`)).map(f => `path/src/gpu.rs 没有从 ../../shaders/ 读 ${f}`),
    ...copies.map(f => `${f} 是 shaders/ 下同名着色器的副本`),
  ];
}

/** 进构建的全部文件内容（加上负对照的改错）的摘要：编好的程序按它命名 */
export function sourceKey(inject = []) {
  return sha256(JSON.stringify([inputFiles().map(f => [f, sha256(fs.readFileSync(path.join(CORE, f)))]), inject])).slice(0, 16);
}

/**
 * 保证构建目录 `target` 里内核这个包的产物是从摘要为 `key` 的源码编的。cargo 按文件时间判断要不要重编：源码的时间倒退时
 * （比如把一个较早的提交导出到编过较新提交的目录上，文件时间是提交时间），它认为什么都没变，留下的还是上一份源码的程序
 * 与测试。所以构建目录里记着上次编的是哪一份源码；不是这一份，就先清掉这个包的产物（两个编译档都清，依赖不动）。
 * 这一道只在用这份脚本构建时有效：回放加进它之前的提交时，要用现在的脚本，或用会更新文件时间的办法导出。
 */
export function freshTarget(target, key, cwd = KERNEL) {
  const stamp = path.join(target, '.beiming-source');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === key) return;
  // 构建目录还不存在就没有可清的：第一次编时依赖可能还没进 cargo 的缓存，不带网络的 clean 会因此失败
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(stamp, key);
    return;
  }
  // cargo clean -p 一次只清一个编译档的目录：库测试那一档（debug）与出程序的那一档（release）各清一次
  for (const profile of [[], ['--release']]) {
    const r = sh(cargoPath(), cargoNet(['clean', '--locked', ...profile, '-p', 'beiming-core-path']), { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CARGO_TARGET_DIR: target } });
    if (r.status !== 0) throw new Error(`清不掉内核上次编的产物：\n${r.stderr.split('\n').slice(-10).join('\n')}`);
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(stamp, key);
}

/** 带 OIDN 的构建档用的库：lib 目录（环境变量 BEIMING_OIDN_LIB；没设时从 Blender 找：BEIMING_BLENDER、macOS 的应用目录、PATH 里的
 *  blender，取它真实路径旁的库目录：macOS 是 Contents/Resources/lib，Linux 是可执行文件同级的 lib/）与 oidn-lock.json 里这个平台的一项 */
export const OIDN_LOCK = path.join(HERE, 'oidn-lock.json');
/**
 * 带 OIDN 的两档，按 cargo 特性名：oidn 链 Blender 5.2 自带的 OIDN 2.5（锁文件的顶层），oidn23 链 Blender 4.5 自带的 OIDN 2.3（锁文件的
 * oidn23 一项）。oidn23 不能和 oidn 写在同一份清单里（同名 crate 两个兼容版本、同一个 links），构建时把内核拷到 out/ 下，照
 * manifest 改清单、换上 lock 编（见 path/Cargo.toml 的说明）。
 */
export const OIDN_BUILDS = {
  oidn: { target: 'target-oidn' },
  oidn23: {
    target: 'target-oidn23',
    lock: 'path/Cargo-oidn23.lock',
    manifest: [
      { file: 'path/Cargo.toml', from: 'oidn = { version = "2.5", optional = true }', to: 'oidn = { version = "=2.3.3", optional = true }' },
      { file: 'path/Cargo.toml', from: 'oidn = ["dep:oidn"]', to: 'oidn23 = ["dep:oidn"]' },
    ],
  },
};

function oidnBuild(build) {
  if (!(build in OIDN_BUILDS)) throw new Error(`没有 ${build} 这个 OIDN 构建档（有：${Object.keys(OIDN_BUILDS).join('、')}）`);
  return OIDN_BUILDS[build];
}
const MAC_BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';

/** Blender 的可执行文件：BEIMING_BLENDER 写了只认它，否则 macOS 的应用目录、PATH 里的 blender；找不到是 null */
export function findBlender(env = process.env) {
  const candidates = env.BEIMING_BLENDER ? [env.BEIMING_BLENDER] : [MAC_BLENDER, ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(d => path.join(d, 'blender'))];
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

function blenderLibDir(env = process.env) {
  if (env.BEIMING_OIDN_LIB) return env.BEIMING_OIDN_LIB;
  const bin = findBlender(env);
  if (!bin) return null;
  const real = fs.realpathSync(bin);
  return process.platform === 'darwin' ? path.join(path.dirname(real), '..', 'Resources', 'lib') : path.join(path.dirname(real), 'lib');
}

/**
 * 核对 OIDN 库：目录里全部 libOpenImageDenoise* 与 libtbb*（链接照它指向的内容）与锁文件这个平台的一项逐个比 sha256，多、少、
 * 对不上都抛 env 类的错（.missing，退出码 3）：缺库报 env.missing-tool；库都在、但有 sha256 对不上或多出锁文件里没有的库报
 * env.lib-mismatch（帧源接口契约 5.15：不得换一份库照常出帧）。返回 { dir, platform, entry }。构建前与运行带 OIDN 的程序前都要过这一道。
 */
export function verifyOidnLibs(env = process.env, build = 'oidn') {
  oidnBuild(build);
  const platform = `${process.platform}-${process.arch}`;
  const lock = JSON.parse(fs.readFileSync(OIDN_LOCK, 'utf8'));
  const entry = (build === 'oidn' ? lock : lock[build])?.platforms?.[platform];
  if (!entry) throw Object.assign(missing(`oidn-lock.json 里没有 ${platform} 这个平台的库（构建档 ${build}）`), { code: 'env.missing-tool' });
  const dir = blenderLibDir(env);
  if (!dir || !fs.existsSync(dir)) throw Object.assign(missing(`找不到 OIDN 的库目录（${dir ?? '没找到 Blender'}）：设 BEIMING_OIDN_LIB 指向 Blender 的 lib 目录，或 BEIMING_BLENDER 指向 Blender ${entry.blender}`), { code: 'env.missing-tool' });
  const have = fs.readdirSync(dir).filter(f => /^lib(OpenImageDenoise|tbb)/.test(f)).sort();
  const absent = Object.keys(entry.files).filter(f => !have.includes(f)).map(f => `缺 ${f}`);
  const problems = [
    ...absent,
    ...have.filter(f => !(f in entry.files)).map(f => `锁文件里没有 ${f}`),
    ...have.filter(f => f in entry.files && sha256(fs.readFileSync(path.join(dir, f))) !== entry.files[f]).map(f => `${f} 的 sha256 对不上`),
  ];
  if (problems.length) throw Object.assign(missing(`OIDN 库与 oidn-lock.json（${platform}，Blender ${entry.blender} 自带的 OIDN ${entry.oidn}）对不上：${problems.join('；')}（目录 ${dir}）`), { code: absent.length ? 'env.missing-tool' : 'env.lib-mismatch' });
  return { dir, platform, entry, build };
}

/**
 * 带 OIDN 的构建档（默认档不变）：核对库之后 `cargo rustc --features <build>`，OIDN_DIR 设成库目录的上一级（oidn crate 2.5.1 与
 * 2.3.3 的构建脚本都认它，把 $OIDN_DIR/lib 加进链接路径、链接 OpenImageDenoise；不走 pkg-config，不开 bundled），只给 core-render
 * 这一个程序加 rpath 指向库目录，运行时不靠 DYLD_LIBRARY_PATH / LD_LIBRARY_PATH。构建目录另用 out/chassis/target-oidn（oidn23 是
 * target-oidn23，源码拷在 out/chassis/oidn23/）；程序名的摘要把构建档与锁文件的这一项算进去，与默认档分开存。
 * 返回 { bin, key, shaders, built, oidn: { dir, platform, build } }。
 */
export function buildOidnRenderer(env = process.env, build = 'oidn') {
  const spec = oidnBuild(build);
  const lib = verifyOidnLibs(env, build);
  if (path.basename(lib.dir) !== 'lib') throw Object.assign(missing(`OIDN 的库目录要叫 lib（oidn crate 链接 $OIDN_DIR/lib）：${lib.dir}`), { code: 'env.missing-tool' });
  const problems = singleCopyProblems();
  if (problems.length) throw new Error(`拒绝编译：${problems.join('；')}`);
  const shaders = SHADERS.map(f => ({ file: `shaders/${f}`, sha256: sha256(fs.readFileSync(path.join(CORE, 'shaders', f))) }));
  const key = sourceKey([{ build, oidn: lib.platform, files: lib.entry.files }]);
  const bin = path.join(OUT, 'bin', `core-render-${key}${EXE}`);
  const oidn = { dir: lib.dir, platform: lib.platform, build };
  if (fs.existsSync(bin)) return { bin, key, shaders, built: false, oidn };
  const target = path.join(OUT, spec.target);
  const root = spec.manifest ? stage(path.join(OUT, build), spec.manifest, spec.lock) : CORE;
  freshTarget(target, key, path.join(root, 'path'));
  const r = sh(cargoPath(), cargoNet(['rustc', '--locked', '--release', '--features', build, '--bin', 'core-render', '--', '-C', `link-arg=-Wl,-rpath,${lib.dir}`]),
    { cwd: path.join(root, 'path'), stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CARGO_TARGET_DIR: target, OIDN_DIR: path.dirname(lib.dir) } });
  if (r.status !== 0) throw new Error(`带 OIDN 的内核编不过：\n${r.stderr.split('\n').slice(-40).join('\n')}`);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.copyFileSync(path.join(target, 'release', `core-render${EXE}`), `${bin}.tmp`);
  fs.renameSync(`${bin}.tmp`, bin);
  return { bin, key, shaders, built: true, oidn };
}

/**
 * 把进构建的文件拷到 root 下（相对路径不变），照 inject（[{ file, from, to }]，from 必须恰好出现一次）改；给了 lock（相对
 * beiming/sources/core/ 的文件）就拿它换掉拷过去的 path/Cargo.lock。返回 root。工作树不动。
 */
export function stage(root, inject, lock) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const f of inputFiles()) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(CORE, f), path.join(root, f));
  }
  for (const { file, from, to } of inject) {
    const p = path.join(root, file), text = fs.readFileSync(p, 'utf8');
    if (text.split(from).length !== 2) throw new Error(`注入：${file} 里「${from}」不是恰好出现一次`);
    fs.writeFileSync(p, text.replace(from, to));
  }
  if (lock) fs.copyFileSync(path.join(CORE, lock), path.join(root, 'path', 'Cargo.lock'));
  return root;
}

/**
 * 编出渲染程序，返回 { bin, key, shaders }。inject 是负对照用的故意改错：[{ file: 相对 beiming/sources/core/ 的路径, from, to }]，
 * from 必须恰好出现一次；有 inject 时在 out/ 下的拷贝里改和编，工作树不动。
 */
export function buildRenderer({ inject = [] } = {}) {
  const problems = singleCopyProblems();
  if (problems.length) throw new Error(`拒绝编译：${problems.join('；')}`);
  const shaders = SHADERS.map(f => ({ file: `shaders/${f}`, sha256: sha256(fs.readFileSync(path.join(CORE, 'shaders', f))) }));
  const key = sourceKey(inject);
  const bin = path.join(OUT, 'bin', `core-render-${key}${EXE}`);
  if (fs.existsSync(bin)) return { bin, key, shaders, built: false };

  // 负对照另用一个构建目录：同一个包从两处源码编，共用一个目录时留下的程序是哪一处的说不清
  let root = CORE, target = path.join(OUT, 'target');
  if (inject.length) {
    root = stage(path.join(OUT, 'inject', 'src'), inject);
    target = path.join(OUT, 'inject', 'target');
  }
  freshTarget(target, key, path.join(root, 'path'));
  const r = sh(cargoPath(), cargoNet(['build', '--locked', '--release', '--bin', 'core-render']), { cwd: path.join(root, 'path'), stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CARGO_TARGET_DIR: target } });
  if (r.status !== 0) throw new Error(`内核编不过：\n${r.stderr.split('\n').slice(-40).join('\n')}`);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.copyFileSync(path.join(target, 'release', `core-render${EXE}`), `${bin}.tmp`);
  fs.renameSync(`${bin}.tmp`, bin);
  return { bin, key, shaders, built: true };
}
