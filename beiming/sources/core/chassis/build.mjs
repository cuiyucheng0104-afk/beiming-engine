// 渲染底盘的构建：按固定提交取 ThreeRT（MIT，2026 Meshy LLC）到仓库根被忽略的 out/chassis/ 缓存，核对提交号，打上 threert.patch，
// 把 beiming/sources/core/shaders/ 下的四个着色器原样拷进去并核对摘要，再用 cargo build --locked --release 编出
// threert-render。ThreeRT 源码只在缓存里，不进仓库。改过的源码树要和上次自己打出来的一模一样，否则拒绝往下走。
// 编好的程序按「提交号、补丁、着色器、注入」的摘要另存一份，摘要没变就不重编。缺工具（git、cargo、npm、网络）时
// 抛出的错误带 .missing，测试据此跳过。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(HERE, '..');
// 缓存放在仓库根的 out/（被 git 与 ESLint 忽略）：ThreeRT 自带的脚本要是放在 beiming/sources/core/out/ 会被 ESLint 查到
export const OUT = path.join(CORE, '..', '..', '..', 'out', 'chassis');
export const COMMIT = 'c946cc96bdb08979224e851a7fc67a066b1b456b';
const REPO = 'https://github.com/meshy-dev/ThreeRT.git';
export const SRC = path.join(OUT, `threert-${COMMIT.slice(0, 7)}`);
export const PATCH = path.join(HERE, 'threert.patch');
export const SHADERS = ['microfacet.wgsl', 'util.wgsl', 'area_light.wgsl', 'ggx_tables.wgsl'];
// 补丁里 gpu.rs 用 include_str! 从这里读我方着色器
const DEST = 'renderer/shaders/beiming';
const STAMP = `${SRC}.state.json`;

export const missing = what => Object.assign(new Error(what), { missing: what });
const sha256 = data => createHash('sha256').update(data).digest('hex');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30, encoding: 'utf8', ...opts });
  if (r.error?.code === 'ENOENT') throw missing(`找不到 ${cmd}`);
  if (r.error) throw r.error;
  return r;
}

function git(...args) {
  const r = sh('git', ['-C', SRC, ...args]);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr.trim()}`);
  return r.stdout;
}

/** cargo 先找 PATH，再找 ~/.cargo/bin（rustup 的默认位置，常常没进 PATH） */
export function cargoPath() {
  if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0) return 'cargo';
  const home = path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  if (fs.existsSync(home)) return home;
  throw missing('找不到 cargo（PATH 与 ~/.cargo/bin 里都没有）：装 Rust（rustup），ThreeRT 的 rust-toolchain.toml 指定 1.100.0');
}

/** 缓存在且提交号对就直接用；不在时 allowFetch 为真才去取。提交号对不上，拒绝往下走 */
export function ensureSource({ allowFetch = true } = {}) {
  if (!fs.existsSync(SRC)) {
    if (!allowFetch) throw missing(`没有 ThreeRT 源码缓存（${SRC}）：先运行一次 level2.mjs，或设 BEIMING_CHASSIS_E2E=1`);
    fs.mkdirSync(SRC, { recursive: true });
    try {
      git('init', '-q');
      git('remote', 'add', 'origin', REPO);
      try { git('fetch', '-q', '--depth', '1', 'origin', COMMIT); } catch (e) { throw missing(`取不到 ThreeRT 源码：${e.message}`); }
      git('checkout', '-q', 'FETCH_HEAD');
    } catch (e) {
      fs.rmSync(SRC, { recursive: true, force: true });
      throw e;
    }
  }
  // 不是 git 目录时 git -C 会找到外层仓库，提交号同样对不上，一样拒绝
  const head = git('rev-parse', 'HEAD').trim();
  if (head !== COMMIT) throw new Error(`拒绝编译：${SRC} 的提交是 ${head}，不是固定的 ${COMMIT}；删掉这个目录重取`);
  return SRC;
}

/** 源码树相对提交的全部改动（已跟踪文件的差异加上未跟踪文件的内容；node_modules、target、out 被 ThreeRT 自己忽略） */
function treeState() {
  const h = createHash('sha256').update(git('diff', 'HEAD', '--binary'));
  for (const f of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort()) h.update(`\0${f}\0`).update(fs.readFileSync(path.join(SRC, f)));
  return h.digest('hex');
}

/** 按固定提交的 package-lock.json 装 ThreeRT 的 npm 依赖（打场景包要 esbuild 与它的工作区包），不跑安装脚本 */
export function ensureNodeModules() {
  const lock = sha256(fs.readFileSync(path.join(SRC, 'package-lock.json')));
  const stamp = path.join(SRC, 'node_modules', '.beiming-lock');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === lock) return;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = sh(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: SRC });
  if (r.status !== 0) throw missing(`npm ci 失败（网络或 npm）：${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  fs.writeFileSync(stamp, lock);
}

/**
 * 编出渲染程序，返回 { bin, key, shaders }。patch 为假时编原样的 ThreeRT（对照用）。inject 是负对照用的故意改错：
 * [{ file: 拷进去之后的相对路径, from, to }]，from 必须恰好出现一次。
 */
export function buildRenderer({ allowFetch = true, patch = true, inject = [] } = {}) {
  ensureSource({ allowFetch });
  const shaders = SHADERS.map(f => ({ file: `shaders/${f}`, repo: sha256(fs.readFileSync(path.join(CORE, 'shaders', f))) }));
  const patchText = patch ? fs.readFileSync(PATCH) : null;
  const key = sha256(JSON.stringify([COMMIT, patchText && sha256(patchText), patch && shaders.map(s => s.repo), inject])).slice(0, 16);
  const bin = path.join(OUT, 'threert-bin', `threert-render-${key}${process.platform === 'win32' ? '.exe' : ''}`);
  const st = fs.existsSync(STAMP) ? JSON.parse(fs.readFileSync(STAMP, 'utf8')) : null;
  const state = treeState();
  const clean = state === sha256('');
  if (!clean && st?.state !== state) throw new Error(`拒绝编译：${SRC} 里的 ThreeRT 源码被改过（不是本脚本上次打出来的样子）；删掉这个目录重取`);
  // 拷进去的着色器摘要在编的时候记在程序旁边，命中缓存时照记录报
  if (fs.existsSync(bin) && fs.existsSync(`${bin}.json`)) return { bin, key, shaders: JSON.parse(fs.readFileSync(`${bin}.json`, 'utf8')), built: false };
  const copied = () => (patch ? SHADERS.map(f => sha256(fs.readFileSync(path.join(SRC, DEST, f)))) : []);

  if (st?.key !== key) {
    git('checkout', '-q', '-f', 'HEAD', '--', '.');
    fs.rmSync(path.join(SRC, DEST), { recursive: true, force: true });
    if (patch) {
      git('apply', '--whitespace=nowarn', PATCH);
      fs.mkdirSync(path.join(SRC, DEST), { recursive: true });
      for (const f of SHADERS) fs.copyFileSync(path.join(CORE, 'shaders', f), path.join(SRC, DEST, f));
      const got = copied();
      shaders.forEach((s, k) => { if (got[k] !== s.repo) throw new Error(`拷进 ThreeRT 的 ${s.file} 与仓库里的摘要不同`); });
    }
    for (const { file, from, to } of inject) {
      const p = path.join(SRC, file), text = fs.readFileSync(p, 'utf8');
      if (text.split(from).length !== 2) throw new Error(`注入：${file} 里「${from}」不是恰好出现一次`);
      fs.writeFileSync(p, text.replace(from, to));
    }
    fs.writeFileSync(STAMP, JSON.stringify({ key, state: treeState() }));
  }
  const r = sh(cargoPath(), ['build', '--locked', '--release', '--bin', 'threert-render'], { cwd: path.join(SRC, 'renderer'), stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) throw new Error(`ThreeRT 编不过：\n${r.stderr.split('\n').slice(-40).join('\n')}`);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'renderer', 'target', 'release', path.basename(bin).replace(`-${key}`, '')), `${bin}.tmp`);
  fs.renameSync(`${bin}.tmp`, bin);
  const got = patch ? shaders.map((s, k) => ({ ...s, copied: copied()[k] })) : [];
  fs.writeFileSync(`${bin}.json`, JSON.stringify(got));
  return { bin, key, shaders: got, built: true };
}
