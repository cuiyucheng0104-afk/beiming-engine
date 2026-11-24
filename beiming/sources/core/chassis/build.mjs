// 渲染底盘的构建：渲染程序 core-render 从仓库里的 beiming/sources/core/path/ 编（cargo build --locked --release），
// 构建目录与编好的程序都放在仓库根被忽略的 out/chassis/ 下，不往源码目录里写东西。内核用 include_str! 直接读
// beiming/sources/core/shaders/ 下的四个着色器，仓库里只有那一份；编之前核对这一点。编好的程序按源码内容的摘要另存，
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
export const SHADERS = ['microfacet.wgsl', 'util.wgsl', 'area_light.wgsl', 'ggx_tables.wgsl'];
/** 进构建的东西（相对 beiming/sources/core/）：内核的清单、锁、工具链、源码、着色器、预设，加上四个移植的着色器 */
const INPUTS = ['path/Cargo.toml', 'path/Cargo.lock', 'path/rust-toolchain.toml', 'path/src', 'path/shaders', 'path/presets', ...SHADERS.map(f => `shaders/${f}`)];
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

/** 四个移植的着色器在仓库里只有一份：内核从 ../../shaders/ 读，path/ 下没有同名文件 */
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
 */
export function freshTarget(target, key, cwd = KERNEL) {
  const stamp = path.join(target, '.beiming-source');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === key) return;
  // cargo clean -p 一次只清一个编译档的目录：库测试那一档（debug）与出程序的那一档（release）各清一次
  for (const profile of [[], ['--release']]) {
    const r = sh(cargoPath(), ['clean', '--locked', ...profile, '-p', 'beiming-core-path'], { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CARGO_TARGET_DIR: target } });
    if (r.status !== 0) throw new Error(`清不掉内核上次编的产物：\n${r.stderr.split('\n').slice(-10).join('\n')}`);
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(stamp, key);
}

/**
 * 编出渲染程序，返回 { bin, key, shaders }。inject 是负对照用的故意改错：[{ file: 相对 beiming/sources/core/ 的路径, from, to }]，
 * from 必须恰好出现一次；有 inject 时在 out/ 下的拷贝里改和编，工作树不动。
 */
export function buildRenderer({ inject = [] } = {}) {
  const problems = singleCopyProblems();
  if (problems.length) throw new Error(`拒绝编译：${problems.join('；')}`);
  const files = inputFiles();
  const shaders = SHADERS.map(f => ({ file: `shaders/${f}`, sha256: sha256(fs.readFileSync(path.join(CORE, 'shaders', f))) }));
  const key = sourceKey(inject);
  const bin = path.join(OUT, 'bin', `core-render-${key}${EXE}`);
  if (fs.existsSync(bin)) return { bin, key, shaders, built: false };

  // 负对照另用一个构建目录：同一个包从两处源码编，共用一个目录时留下的程序是哪一处的说不清
  let root = CORE, target = path.join(OUT, 'target');
  if (inject.length) {
    root = path.join(OUT, 'inject', 'src');
    target = path.join(OUT, 'inject', 'target');
    fs.rmSync(root, { recursive: true, force: true });
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.copyFileSync(path.join(CORE, f), path.join(root, f));
    }
    for (const { file, from, to } of inject) {
      const p = path.join(root, file), text = fs.readFileSync(p, 'utf8');
      if (text.split(from).length !== 2) throw new Error(`注入：${file} 里「${from}」不是恰好出现一次`);
      fs.writeFileSync(p, text.replace(from, to));
    }
  }
  freshTarget(target, key, path.join(root, 'path'));
  const r = sh(cargoPath(), ['build', '--locked', '--release', '--bin', 'core-render'], { cwd: path.join(root, 'path'), stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CARGO_TARGET_DIR: target } });
  if (r.status !== 0) throw new Error(`内核编不过：\n${r.stderr.split('\n').slice(-40).join('\n')}`);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.copyFileSync(path.join(target, 'release', `core-render${EXE}`), `${bin}.tmp`);
  fs.renameSync(`${bin}.tmp`, bin);
  return { bin, key, shaders, built: true };
}
