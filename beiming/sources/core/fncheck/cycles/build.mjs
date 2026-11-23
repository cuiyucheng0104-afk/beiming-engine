// 标准答案一侧：按固定标签取 Cycles 源码到被忽略的 out/ 缓存（只取内核与 util 两个目录，加宿主侧的预计算表
// scene/shader.tables 一个文件），核对提交号，
// 再把 ref.cpp 编成本机小程序。Cycles 源码（Apache-2.0，其中闭包文件是 BSD-3-Clause）只在缓存里，不进仓库。
// 缺工具（git、编译器、网络）时抛出的错误带 .missing，测试据此跳过。
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, '..', 'out');
export const TAG = 'v5.2.3';
export const COMMIT = 'e13b728c6880d3084d9d57c30031ed5df8b39dee';
const REPO = 'https://projects.blender.org/blender/blender.git';
const SRC = path.join(OUT, `blender-${TAG}`);
// 稀疏检出的范围（非锥形模式，才能只取单个文件）。改了这里，旧缓存缺的文件在下次 allowFetch 时补取
const SPARSE = ['/intern/cycles/kernel/', '/intern/cycles/util/', '/intern/cycles/scene/shader.tables'];

export const missing = what => Object.assign(new Error(what), { missing: what });

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30, ...opts });
  if (r.error?.code === 'ENOENT') throw missing(`找不到 ${cmd}`);
  if (r.error) throw r.error;
  return r;
}

function git(...args) {
  const r = sh('git', ['-C', SRC, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** 缓存在且提交号对就直接用；不在时 allowFetch 为真才去取。提交号对不上或缓存被改过，拒绝往下走 */
export function ensureSource({ allowFetch = true } = {}) {
  if (!fs.existsSync(SRC)) {
    if (!allowFetch) throw missing(`没有 Cycles 源码缓存（${SRC}）：先运行一次 run.mjs，或设 BEIMING_FNCHECK_E2E=1`);
    fs.mkdirSync(SRC, { recursive: true });
    try {
      git('init', '-q');
      git('remote', 'add', 'origin', REPO);
      git('sparse-checkout', 'set', '--no-cone', ...SPARSE);
      try { git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', `refs/tags/${TAG}`); } catch (e) { throw missing(`取不到 Cycles 源码：${e.message}`); }
      git('checkout', '-q', 'FETCH_HEAD');
    } catch (e) {
      fs.rmSync(SRC, { recursive: true, force: true });
      throw e;
    }
  }
  // 不是 git 目录时 git -C 会找到外层仓库，提交号同样对不上，一样拒绝
  const head = git('rev-parse', 'HEAD');
  if (head === COMMIT && !SPARSE.every(p => fs.existsSync(path.join(SRC, p)))) {
    if (!allowFetch) throw missing(`Cycles 源码缓存缺 ${SPARSE.join('、')} 里的文件：先运行一次 run.mjs，或设 BEIMING_FNCHECK_E2E=1`);
    try { git('sparse-checkout', 'set', '--no-cone', ...SPARSE); } catch (e) { throw missing(`补取 Cycles 源码失败：${e.message}`); }
  }
  if (head !== COMMIT) throw new Error(`拒绝编译：${SRC} 的提交是 ${head}，不是 ${TAG} 应有的 ${COMMIT}；删掉这个目录重取`);
  if (git('status', '--porcelain')) throw new Error(`拒绝编译：${SRC} 里的 Cycles 源码被改过；删掉这个目录重取`);
  return SRC;
}

/** 编出标准答案程序，返回可执行文件路径。按编译器、Cycles 提交号、选项与源文件内容缓存 */
export function buildRef(opts) {
  const src = ensureSource(opts);
  const cxx = process.env.CXX || (process.platform === 'darwin' ? 'clang++' : 'g++');
  const flags = [
    // C++20：Cycles 的 util/math_base.h 用了 std::popcount。-O2 不开任何改变浮点结果的选项（不开 fast-math）
    '-std=c++20', '-O2',
    // 禁止把 a*b+c 合成 FMA：不禁的话 arm64 与 x86-64 的结果差几个 ULP，GCC 的 GNU 方言默认还会合成
    '-ffp-contract=off',
    // x86-64 上 Cycles 的 util/optimization.h 无条件打开 SSE4.2 路径，Blender 自己也这样编；SSE4.2 不含 FMA
    ...(process.arch === 'x64' ? ['-msse4.2'] : []),
    // 这两个宏原本由 Cycles 的 CMake 注入
    '-DCCL_NAMESPACE_BEGIN=namespace ccl {', '-DCCL_NAMESPACE_END=}',
    `-I${path.join(HERE, 'shim')}`, `-I${path.join(src, 'intern', 'cycles')}`,
  ];
  const cpp = path.join(HERE, 'ref.cpp');
  const key = createHash('sha256').update([cxx, COMMIT, ...flags, fs.readFileSync(cpp, 'utf8'), fs.readFileSync(path.join(HERE, 'shim/tbb/spin_mutex.h'), 'utf8')].join('\0')).digest('hex').slice(0, 16);
  const bin = path.join(OUT, `cycles-ref-${key}`);
  if (!fs.existsSync(bin)) {
    const r = sh(cxx, [...flags, cpp, '-o', `${bin}.tmp`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`标准答案程序编不过（${cxx}）：\n${r.stderr}`);
    fs.renameSync(`${bin}.tmp`, bin);
  }
  return bin;
}

/** 跑一个函数：input 是每组 nIn 个 float32 的扁平数组，返回 count 个 float32 */
export function runRef(bin, id, input, count) {
  const r = sh(bin, [id], { input: Buffer.from(input.buffer, input.byteOffset, input.byteLength) });
  if (r.status !== 0) throw new Error(`标准答案程序 ${id} 退出码 ${r.status}：${r.stderr}`);
  if (r.stdout.length !== count * 4) throw new Error(`标准答案程序 ${id} 输出 ${r.stdout.length} 字节，应为 ${count * 4}`);
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length));
}
