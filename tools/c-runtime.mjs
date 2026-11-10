#!/usr/bin/env node
// C 路线 · 历史复刻运行时：按 cases/vendor/lock.json 固定的提交准备上游风格库的隔离运行环境，重跑 casebook 还原出的历史作品，
// 并给 SY 风格生成能交给 engine/render 的适配页。
// 不联网拉代码（只在 --venv 时用 pip 装 Python 包）、不改 cases/vendor 与 cases/source、不读写家目录（~/lemo-opuscar 不碰），
// 不运行上游自带的 setup.sh（它会把上游 main 拉下来 reset --hard，偏离固定快照）。
//
//   node tools/c-runtime.mjs setup [--python <解释器>] [--venv] [--music] [--force] [--dry-run] [--out <运行时目录>]
//       在 out/runtime/lemo-<提交前 8 位>/ 建 Lemo 运行时：
//         1 核对快照    cases/vendor/lemo-opuscar 逐文件对 lock.json 的 sha256 与大小，不符就停（退出码 4）
//         2 复制        只复制锁文件列出的文件；目录已在且清单一致时跳过（--force 重建）。先写临时目录，成功后改名
//         3 Node 依赖   上游 package-lock 锁的 playwright-core / three 与仓库根 node_modules 里的版本一致时，链接过去
//                       （Windows 用目录联接，不需要管理员）；不一致或仓库根没装就停（退出码 3）
//         4 Python      必需 numpy、scipy、soundfile；建议 soxr、PIL、fontTools，--music 时 numba 也必需。
//                       解释器按 --python → $PYTHON → $BEIMING_PY → python3 → python 找；--venv 时在运行时目录建 .venv，
//                       按上游 requirements.txt（--music 再加 requirements-music.txt）pip 安装（要联网）
//         5 写 .venv/bin/python 小脚本（转到选定的解释器，历史 build.sh 写死了这个路径）与 runtime.json
//   node tools/c-runtime.mjs status [--out <运行时目录>] [--verify]
//       只读：运行时在不在、提交与快照是否一致、Node 链接与 Python 依赖；--verify 逐文件重算 sha256
//   node tools/c-runtime.mjs build <还原目录> [--timeout 秒] [--dry-run] [--out <运行时目录>]
//       重跑还原出的历史作品（python3 tools/casebook.py restore <案例> --download --lemo out/runtime/lemo-bebbbe1a）：
//       把 build.sh 的 LIB= 指到运行时、"$LIB/.venv/bin/python" 换成选定的解释器，写成同目录的 build.c-runtime.sh，用 sh 运行；
//       跑完按 cases/catalog.json 记录的成片规格核对帧数、宽高、帧率（不符退出码 4），运行记录写 <还原目录>/out/c-runtime-run.json。
//       需要 sh（macOS / Linux 自带；Windows 装 Git for Windows 后 PowerShell 里也有）与 ffmpeg。--timeout 默认 3600，0 不限
//   node tools/c-runtime.mjs sy <编号|目录名> [--still 0.5,2] [--video] [--out <目录>]
//       SY 风格（__seek 契约）：在 out/runtime/sy-<提交前 8 位>/<目录>/ 生成适配页——<base> 指回只读快照，强制 ?render=1，
//       把 __duration / __fps / __seek 挂成 window.DUR / FPS / render，就绪后置 READY——再用 engine/render 渲静帧或整片
//   通用：--json 只在 stdout 输出一个结果对象（C2 信封）；--help 打印用法、不碰任何文件
// 退出码：0 成功；1 运行失败（历史脚本或渲染出错）；2 用法错误；3 环境或依赖缺失；4 核对不通过；5 运行时目录正被占用；
//         124 超时；130 / 143 收到 SIGINT / SIGTERM（子进程已结束）
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = { lemo: 'cases/vendor/lemo-opuscar', sy: 'cases/vendor/sy-style-100' };
const REQUIRED = ['numpy', 'scipy', 'soundfile'], RECOMMENDED = ['soxr', 'PIL', 'fontTools'], MUSIC = ['numba'];
const IS_WIN = process.platform === 'win32';

const USAGE = `用法：
  node tools/c-runtime.mjs setup [--python <解释器>] [--venv] [--music] [--force] [--dry-run] [--out <运行时目录>]
  node tools/c-runtime.mjs status [--out <运行时目录>] [--verify]
  node tools/c-runtime.mjs build <还原目录> [--timeout 秒] [--dry-run] [--out <运行时目录>]
  node tools/c-runtime.mjs sy <编号|目录名> [--still 0.5,2] [--video] [--out <目录>]
通用：--json（stdout 只输出一个结果对象）、--help
退出码：0 成功；1 运行失败；2 用法错误；3 环境或依赖缺失；4 核对不通过；5 运行时正被占用；124 超时；130/143 被中断
完整步骤见 routes/c-style/REPLICATE.md`;

export class Fail extends Error {
  constructor(code, message, hint = '') { super(message); this.exitCode = code; this.hint = hint; }
}
const CODE_NAME = { 1: 'failed', 2: 'usage', 3: 'environment', 4: 'check-failed', 5: 'busy', 124: 'timeout', 130: 'interrupted', 143: 'terminated' };

const posix = p => p.split(path.sep).join('/');
const rel = p => posix(path.relative(ROOT, p)) || '.';
const log = (...a) => console.error(...a);
const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sha256Text = t => crypto.createHash('sha256').update(t).digest('hex');

// ———————————————————————————— 快照与锁 ————————————————————————————
export function readLock() {
  const f = path.join(ROOT, 'cases/vendor/lock.json');
  if (!fs.existsSync(f)) throw new Fail(3, '缺少 cases/vendor/lock.json', '在完整检出的仓库根目录运行');
  const lock = JSON.parse(fs.readFileSync(f, 'utf8'));
  const repo = name => {
    const r = (lock.repositories || []).find(x => x.name === name);
    if (!r) throw new Fail(4, `cases/vendor/lock.json 里没有 ${name}`, '锁文件不完整：不要手改 lock.json，按 cases/vendor/README.md 重新导入快照');
    return r;
  };
  return { lemo: repo('lemo-opuscar'), sy: repo('sy-style-100') };
}
const manifestOf = files => sha256Text(files.map(f => `${f.path}\t${f.sha256}\t${f.size}\n`).sort().join(''));

// 逐文件核对快照：返回 [{ path, problem }]
function verifyVendor(lemo, { hash = true } = {}) {
  const base = path.join(ROOT, VENDOR.lemo), bad = [];
  for (const f of lemo.files) {
    const p = path.join(base, f.path);
    let st; try { st = fs.statSync(p); } catch { bad.push({ path: f.path, problem: '缺失' }); continue; }
    if (st.size !== f.size) { bad.push({ path: f.path, problem: `大小 ${st.size}，锁里是 ${f.size}` }); continue; }
    if (hash && sha256File(p) !== f.sha256) bad.push({ path: f.path, problem: 'sha256 与锁不符' });
  }
  return bad;
}

// ———————————————————————————— 运行时目录 ————————————————————————————
export function runtimeDir(lemo, out) {
  const d = path.resolve(out || path.join(ROOT, 'out', 'runtime', `lemo-${lemo.commit.slice(0, 8)}`));
  const home = os.homedir(), vendor = path.join(ROOT, 'cases');
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  if (inside(d, vendor)) throw new Fail(2, `运行时目录不能放在 cases/ 下（${rel(d)}）`, 'cases/ 是只读归档；用默认的 out/runtime/ 或别的空目录');
  if (d === home || inside(d, path.join(home, 'lemo-opuscar'))) throw new Fail(2, `运行时目录不能是家目录或 ~/lemo-opuscar（${d}）`, '隔离运行时不碰家目录；用默认的 out/runtime/');
  return d;
}

function readRuntime(dir) {
  const f = path.join(dir, 'runtime.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function lockDir(dir) {
  const lock = `${dir}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
  catch {
    const pid = +fs.readFileSync(lock, 'utf8') || 0;
    let alive = false; try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive && pid !== process.pid) throw new Fail(5, `运行时目录正被进程 ${pid} 准备（${rel(lock)}）`, '等它结束再试；确认那个进程已经不在了就删掉这个 .lock 文件');
    fs.writeFileSync(lock, String(process.pid));
  }
  return () => { try { fs.rmSync(lock, { force: true }); } catch { /* 已删 */ } };
}

// Node 依赖：上游锁定版本与仓库根已装版本对照
function nodeModulesPlan(lemo) {
  const upLock = path.join(ROOT, VENDOR.lemo, 'package-lock.json');
  const want = {};
  const pk = JSON.parse(fs.readFileSync(upLock, 'utf8')).packages || {};
  for (const [k, v] of Object.entries(pk)) if (k.startsWith('node_modules/') && !k.slice(13).includes('node_modules/')) want[k.slice(13)] = v.version;
  const rootNm = path.join(ROOT, 'node_modules'), have = {}, problems = [];
  for (const [name, version] of Object.entries(want)) {
    const pj = path.join(rootNm, name, 'package.json');
    have[name] = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')).version : null;
    if (have[name] !== version) problems.push(`${name}：上游锁定 ${version}，仓库根${have[name] ? `装的是 ${have[name]}` : '没装'}`);
  }
  return { rootNm, want, have, problems, commit: lemo.commit };
}

// Python：找解释器、查模块
const PROBE = `import json, sys, importlib
mods = {}
for m in sys.argv[1:]:
    try:
        x = importlib.import_module(m); mods[m] = str(getattr(x, '__version__', 'ok'))
    except Exception:
        mods[m] = None
print(json.dumps({'executable': sys.executable, 'version': sys.version.split()[0], 'modules': mods}))`;
function probePython(exe) {
  const r = spawnSync(exe, ['-I', '-c', PROBE, ...REQUIRED, ...RECOMMENDED, ...MUSIC], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; }
}
function findPython(explicit) {
  const tried = [];
  for (const c of [explicit, process.env.PYTHON, process.env.BEIMING_PY, IS_WIN ? 'python' : 'python3', IS_WIN ? 'py' : 'python'].filter(Boolean)) {
    if (tried.includes(c)) continue;
    tried.push(c);
    const p = probePython(c);
    if (p) return { exe: c, info: p, tried };
    if (c === explicit) throw new Fail(3, `--python ${c} 运行不了（不存在或不是 Python）`, '写 Python 解释器的完整路径，例如 /path/to/.venv/bin/python');
  }
  throw new Fail(3, `找不到可用的 Python（试过：${tried.join('、')}）`, '装 Python 3.11+，或用 --python 指定解释器，或设 PYTHON 环境变量');
}
const missingModules = (info, music) => ({
  required: [...REQUIRED, ...(music ? MUSIC : [])].filter(m => !info.modules[m]),
  recommended: [...RECOMMENDED, ...(music ? [] : MUSIC)].filter(m => !info.modules[m]),
});

function writeShim(dir, exe) {
  const bin = path.join(dir, '.venv', 'bin'), shim = path.join(bin, 'python');
  if (fs.existsSync(shim) && !fs.readFileSync(shim, 'utf8').startsWith('#!/bin/sh\n# c-runtime')) return;   // 真 venv 自带的，不动
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(shim, `#!/bin/sh\n# c-runtime：历史 build.sh 写死了 $LIB/.venv/bin/python，这里转到选定的解释器\nexec '${posix(exe).replace(/'/g, "'\\''")}' "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

function linkDir(target, at) {
  try { fs.rmSync(at, { recursive: false, force: true }); } catch { /* 不在 */ }
  if (fs.existsSync(at)) throw new Fail(1, `${at} 已存在且不是链接，没有覆盖`, '删掉运行时目录后用 --force 重建');
  fs.symlinkSync(target, at, IS_WIN ? 'junction' : 'dir');
}

// ———————————————————————————— setup / status ————————————————————————————
async function setup(o, env) {
  const { lemo } = readLock();
  const dir = runtimeDir(lemo, o.out);
  const manifest = manifestOf(lemo.files);
  log(`▶ 1/5 核对快照 ${VENDOR.lemo}（${lemo.files.length} 个文件，lemo-opuscar@${lemo.commit.slice(0, 7)}）`);
  const bad = verifyVendor(lemo);
  if (bad.length) throw new Fail(4, `快照与 lock.json 不一致（${bad.length} 处）：${bad.slice(0, 8).map(b => `${b.path}（${b.problem}）`).join('；')}${bad.length > 8 ? '……' : ''}`,
    'cases/vendor 是只读快照：用 git checkout -- cases/vendor 恢复，再跑 python3 tools/casebook.py check');
  const nm = nodeModulesPlan(lemo);
  if (nm.problems.length) throw new Fail(3, `Node 依赖与上游锁定的版本不一致：${nm.problems.join('；')}`, '在仓库根运行 npm ci（或 npm run setup）装好依赖；版本确实不同就等仓库升级后再复刻');
  const py = o.venv ? null : findPython(o.python);
  if (py) {
    const miss = missingModules(py.info, o.music);
    if (miss.required.length) throw new Fail(3, `${py.exe}（Python ${py.info.version}）缺少 ${miss.required.join('、')}`,
      `换一个装好这些包的解释器（--python），或加 --venv 在运行时目录里建虚拟环境并按上游 requirements 安装（要联网）`);
    if (miss.recommended.length) env.warnings.push(`Python 缺少建议的包 ${miss.recommended.join('、')}：用到它们的历史脚本会失败（${miss.recommended.includes('numba') ? '拨弦乐器 pluck.py 要 numba；' : ''}字体子集化要 fontTools）`);
  }
  const plan = { runtime: rel(dir), commit: lemo.commit, files: lemo.files.length, manifest, node: nm.have, python: py ? { executable: py.info.executable, version: py.info.version } : { venv: true } };
  env.result = plan;
  if (o.dryRun) { log('（--dry-run：只核对，不写文件）'); return 0; }

  const unlock = lockDir(dir);
  try {
    const cur = readRuntime(dir);
    const same = cur && cur.commit === lemo.commit && cur.manifest === manifest && !o.force && lemo.files.every(f => {
      try { return fs.statSync(path.join(dir, f.path)).size === f.size; } catch { return false; }
    });
    if (same) log(`▶ 2/5 ${rel(dir)} 已是这个提交的完整副本，跳过复制`);
    else {
      log(`▶ 2/5 复制到 ${rel(dir)}`);
      const tmp = `${dir}.tmp-${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      try {
        for (const f of lemo.files) {
          const src = path.join(ROOT, VENDOR.lemo, f.path), dst = path.join(tmp, f.path);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
          if (f.mode === '100755') fs.chmodSync(dst, 0o755);
        }
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(tmp, dir);
      } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
    }
    log(`▶ 3/5 node_modules → ${rel(nm.rootNm)}（${Object.entries(nm.have).map(([k, v]) => `${k}@${v}`).join('、')}）`);
    linkDir(nm.rootNm, path.join(dir, 'node_modules'));
    let pyInfo = py?.info, pyExe = py?.info.executable;
    if (o.venv) {
      log('▶ 4/5 建虚拟环境并安装上游 requirements（要联网）');
      const base = findPython(o.python);
      const venv = path.join(dir, '.venv');
      const mk = spawnSync(base.exe, ['-m', 'venv', venv], { stdio: ['ignore', 2, 2] });
      if (mk.status !== 0) throw new Fail(3, `${base.exe} -m venv 失败`, '换一个 Python 3.11+（--python），或不用 --venv、直接指定装好依赖的解释器');
      const vpy = IS_WIN ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
      const reqs = ['requirements.txt', ...(o.music ? ['requirements-music.txt'] : [])].flatMap(r => ['-r', path.join(dir, r)]);
      const pip = spawnSync(vpy, ['-m', 'pip', 'install', '--disable-pip-version-check', ...reqs], { stdio: ['ignore', 2, 2] });
      if (pip.status !== 0) throw new Fail(3, 'pip 安装上游 requirements 失败', '检查网络或代理后重跑；离线时不用 --venv，改用 --python 指向已装好 numpy、scipy、soundfile 的解释器');
      pyInfo = probePython(vpy); pyExe = vpy;
      if (!pyInfo) throw new Fail(3, `新建的虚拟环境 ${rel(vpy)} 运行不了`, '删掉运行时目录后重试');
    } else log(`▶ 4/5 Python：${pyExe}（${pyInfo.version}）`);
    writeShim(dir, pyExe);
    const record = {
      schemaVersion: 1, kind: 'lemo-opuscar', createdBy: 'tools/c-runtime.mjs',
      repository: lemo.repository, commit: lemo.commit, source: VENDOR.lemo, files: lemo.files.length, manifest,
      node: { modules: posix(nm.rootNm), versions: nm.have },
      python: { executable: posix(pyExe), version: pyInfo.version, modules: pyInfo.modules, venv: Boolean(o.venv) },
      env: { LEMO_OPUSCAR_HOME: posix(dir) },
    };
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(record, null, 1) + '\n');
    log(`▶ 5/5 写好 ${rel(path.join(dir, 'runtime.json'))}`);
    env.outputs.push({ path: rel(path.join(dir, 'runtime.json')), sha256: sha256File(path.join(dir, 'runtime.json')), kind: 'runtime-record' });
    log(`\n运行时就绪：${rel(dir)}\n下一步：python3 tools/casebook.py restore <案例> --download --lemo ${rel(dir)}\n        node tools/c-runtime.mjs build <还原目录>`);
    return 0;
  } finally { unlock(); }
}

function status(o, env) {
  const { lemo } = readLock();
  const dir = runtimeDir(lemo, o.out), rt = readRuntime(dir);
  const res = { runtime: rel(dir), exists: Boolean(rt), commit: rt?.commit || null, problems: [] };
  env.result = res;
  if (!rt) throw new Fail(3, `运行时不存在：${rel(dir)}`, '先运行 node tools/c-runtime.mjs setup');
  if (rt.commit !== lemo.commit) res.problems.push(`运行时的提交 ${rt.commit} 与 lock.json 的 ${lemo.commit} 不同`);
  if (rt.manifest !== manifestOf(lemo.files)) res.problems.push('运行时的文件清单与 lock.json 不同');
  const missing = lemo.files.filter(f => { try { return fs.statSync(path.join(dir, f.path)).size !== f.size; } catch { return true; } });
  if (missing.length) res.problems.push(`${missing.length} 个文件缺失或大小不对（如 ${missing[0].path}）`);
  if (o.verify) {
    const bad = lemo.files.filter(f => { try { return sha256File(path.join(dir, f.path)) !== f.sha256; } catch { return true; } });
    if (bad.length) res.problems.push(`${bad.length} 个文件的 sha256 与锁不符（如 ${bad[0].path}）`);
  }
  if (!fs.existsSync(path.join(dir, 'node_modules', 'playwright-core', 'package.json'))) res.problems.push('node_modules 链接失效');
  const py = probePython(rt.python.executable);
  res.python = py ? { executable: py.executable, version: py.version, missing: missingModules(py, false) } : null;
  if (!py) res.problems.push(`记录的 Python ${rt.python.executable} 运行不了`);
  else if (res.python.missing.required.length) res.problems.push(`Python 缺少 ${res.python.missing.required.join('、')}`);
  if (res.problems.length) throw new Fail(4, `运行时不可用：${res.problems.join('；')}`, '运行 node tools/c-runtime.mjs setup --force 重建');
  log(`运行时可用：${rel(dir)}（lemo-opuscar@${rt.commit.slice(0, 7)}，${rt.files} 个文件；Python ${py.version} ${py.executable}）`);
  return 0;
}

// ———————————————————————————— 子进程：超时、信号、整组结束 ————————————————————————————
function runChild(cmd, args, { cwd, env, timeout }) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true });
    child.stdout.on('data', d => process.stderr.write(d));
    child.stderr.on('data', d => process.stderr.write(d));
    let reason = null, timer = null;
    const kill = sig => {
      if (child.exitCode !== null) return;
      if (IS_WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else { try { process.kill(-child.pid, sig); } catch { /* 已退出 */ } }
    };
    const onSig = sig => () => { reason = sig; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); };
    const hInt = onSig('SIGINT'), hTerm = onSig('SIGTERM');
    process.on('SIGINT', hInt); process.on('SIGTERM', hTerm);
    if (timeout > 0) timer = setTimeout(() => { reason = 'timeout'; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); }, timeout * 1000);
    child.on('error', e => { reason = reason || 'spawn'; resolve({ code: 1, reason, error: e }); });
    child.on('close', code => {
      clearTimeout(timer); process.off('SIGINT', hInt); process.off('SIGTERM', hTerm);
      resolve({ code: code ?? 1, reason });
    });
  });
}
const exitFor = r => (r.reason === 'timeout' ? 124 : r.reason === 'SIGINT' ? 130 : r.reason === 'SIGTERM' ? 143 : r.code === 0 ? 0 : 1);

function findSh() {
  if (!IS_WIN) return 'sh';
  const w = spawnSync('where', ['sh'], { encoding: 'utf8' });
  const hit = (w.stdout || '').split(/\r?\n/).find(Boolean);
  if (hit) return hit.trim();
  for (const p of ['C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe']) if (fs.existsSync(p)) return p;
  throw new Fail(3, '找不到 sh：历史作品的 build.sh 是 POSIX shell 脚本', '装 Git for Windows（自带 sh），或在 WSL 里运行；新片不需要 sh');
}
function need(tool, args = ['-version']) {
  const r = spawnSync(tool, args, { stdio: 'ignore' });
  if (r.status !== 0) throw new Fail(3, `找不到 ${tool}`, `装好 ${tool} 并放进 PATH（FFmpeg ≥ 7，带 libx264、aac）`);
}

// ———————————————————————————— build ————————————————————————————
function probeVideo(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_packets', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const s = JSON.parse(r.stdout).streams?.[0]; if (!s) return null;
  const [a, b = 1] = String(s.r_frame_rate).split('/').map(Number);
  return { width: s.width, height: s.height, fps: +(a / b).toFixed(3), frames: +s.nb_read_packets };
}

export function rewriteBuild(text, runtime) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), notes = [];
  // 第一行"纯赋值"的 LIB=…（不是 LIB="$LIB" cmd 这种给单条命令设环境变量的写法，也不是 LIB=${LIB_OVERRIDE:-$LIB}; …）
  const i = lines.findIndex(l => /^\s*LIB=("[^"]*"|'[^']*'|[^\s;#'"]+)\s*(#.*)?$/.test(l) && !/^\s*LIB=["']?\$\{?LIB\b/.test(l));
  if (i < 0) throw new Fail(4, 'build.sh 里没有 LIB= 这一行，不是 Lemo 运行时上的历史作品', '这个目录不是用 casebook restore 还原的风格实验；按它自己的说明运行');
  const old = lines[i].replace(/^\s*LIB=/, '').replace(/\s*#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
  lines[i] = `LIB='${posix(runtime).replace(/'/g, "'\\''")}'   # c-runtime：原为 ${old}`;
  if (posix(old) !== posix(runtime)) notes.push(`LIB 原指 ${old}，改指隔离运行时`);
  let out = lines.join('\n'), n = 0;
  out = out.replace(/"?\$\{?LIB\}?\/\.venv\/bin\/python"?/g, () => { n++; return '"$C_RUNTIME_PY"'; });
  if (n) notes.push(`${n} 处 $LIB/.venv/bin/python 换成 $C_RUNTIME_PY`);
  const left = [...new Set(out.match(/@@[A-Za-z0-9_]+@@/g) || [])];
  if (left.length) throw new Fail(4, `build.sh 还有没替换的还原标记 ${left.join('、')}`, '按 casebook restore 的提示重新还原（例如 @@ROG_HOST@@ 要 --rog-host）；这类作品依赖仓库外的机器，不能在这里复刻');
  return { text: out, notes };
}

async function build(o, env) {
  if (!o.target) throw new Fail(2, 'build 要给还原目录', '先 python3 tools/casebook.py restore <案例> --download --lemo out/runtime/lemo-bebbbe1a，再把打印出的目录传给 build');
  const dir = path.resolve(o.target);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Fail(2, `还原目录不存在：${o.target}`);
  const reportF = path.join(dir, 'ARCHIVE-RESTORED.json'), buildF = path.join(dir, 'build.sh');
  if (!fs.existsSync(reportF) || !fs.existsSync(buildF)) throw new Fail(4, `${o.target} 不是 casebook 还原出的作品目录（缺 ARCHIVE-RESTORED.json 或 build.sh）`, '用 python3 tools/casebook.py restore <案例> --download 还原');
  const report = JSON.parse(fs.readFileSync(reportF, 'utf8'));
  if (report.sourceOnly) throw new Fail(4, `${report.case} 是 --source-only 还原的：缺图片、字体等二进制素材，不能出片`, `换个目录用 --download 重新还原：python3 tools/casebook.py restore ${report.case} --download --lemo out/runtime/lemo-bebbbe1a --out <新目录>`);
  if (report.unreplacedTokens?.length) throw new Fail(4, `还原时有标记没替换：${report.unreplacedTokens.map(u => `${u.file}（${u.tokens.join('、')}）`).join('；')}`, '这类作品依赖仓库外的机器或服务，按 ARCHIVE-RESTORED.json 的说明准备');
  const { lemo } = readLock();
  const rtDir = runtimeDir(lemo, o.out), rt = readRuntime(rtDir);
  if (!rt) throw new Fail(3, `隔离运行时不存在：${rel(rtDir)}`, '先运行 node tools/c-runtime.mjs setup');
  if (rt.commit !== lemo.commit) throw new Fail(4, `运行时的提交 ${rt.commit.slice(0, 7)} 与 lock.json 的 ${lemo.commit.slice(0, 7)} 不同`, '运行 node tools/c-runtime.mjs setup --force 按当前快照重建');
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'cases/catalog.json'), 'utf8'));
  const c = catalog.cases.find(x => x.id === report.case);
  const master = c?.artifacts?.find(a => a.role === 'master' && a.video);
  const { text, notes } = rewriteBuild(fs.readFileSync(buildF, 'utf8'), rtDir);
  const sh = findSh(); need('ffmpeg'); need('ffprobe');
  const py = rt.python.executable;
  const res = { case: report.case, dir: rel(dir), runtime: rel(rtDir), notes, expected: master ? { file: master.filename, ...master.video } : null };
  env.result = res;
  for (const n of notes) log(`注意：${n}`);
  if (o.dryRun) { res.script = text; log('（--dry-run：只核对与改写预览，不运行）'); return 0; }
  const script = path.join(dir, 'build.c-runtime.sh');
  fs.writeFileSync(script, text.endsWith('\n') ? text : text + '\n');
  log(`▶ 运行 ${rel(script)}（LIB=${rel(rtDir)}，Python ${py}）`);
  const t0 = Date.now();
  const childEnv = { ...process.env, LEMO_OPUSCAR_HOME: rtDir, C_RUNTIME_PY: py, PYTHONDONTWRITEBYTECODE: '1',
    RENDER_SLOT_DIR: process.env.RENDER_SLOT_DIR || path.join(rtDir, '.render-slots') };
  delete childEnv.LIB_OVERRIDE;   // 个别历史脚本用它改 LIB；复刻一律用隔离运行时
  const r = await runChild(sh, [posix(path.basename(script))], { cwd: dir, env: childEnv, timeout: o.timeout });
  const code = exitFor(r);
  res.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  if (code) {
    throw new Fail(code, code === 124 ? `历史脚本超过 ${o.timeout} 秒没结束，已停下` : code >= 130 ? '收到中断信号，历史脚本已停下' : `历史脚本以 ${r.code} 退出（${r.error ? r.error.message : '见上方日志'}）`,
      code === 1 ? '看日志里第一处报错：缺 Python 包就用 setup --python 换解释器；缺素材就确认还原时带了 --download；网络或外部服务相关的步骤按 ARCHIVE-RESTORED.json 的说明准备' : '');
  }
  // 核对成片：案例目录记录的规格
  const film = master ? path.join(dir, master.filename) : null;
  if (!film || !fs.existsSync(film)) throw new Fail(4, `脚本跑完但没找到成片 ${master ? master.filename : '（案例目录没记录成片文件名）'}`, '看 build.sh 最后几步写到了哪里');
  const got = probeVideo(film), want = master.video;
  const wantFps = (() => { const [a, b = 1] = String(want.fps).split('/').map(Number); return +(a / b).toFixed(3); })();
  res.output = { path: rel(film), sha256: sha256File(film), ...got };
  env.outputs.push({ path: rel(film), sha256: res.output.sha256, kind: 'video' });
  const diffs = [];
  if (!got) diffs.push('ffprobe 读不出画面');
  else {
    if (got.width !== want.width || got.height !== want.height) diffs.push(`尺寸 ${got.width}×${got.height}，应为 ${want.width}×${want.height}`);
    if (Math.abs(got.fps - wantFps) > 1e-3) diffs.push(`帧率 ${got.fps}，应为 ${wantFps}`);
    if (got.frames !== +want.frames) diffs.push(`帧数 ${got.frames}，应为 ${want.frames}`);
  }
  const record = { schemaVersion: 1, status: diffs.length ? 'failed' : 'passed', case: report.case, runtime: { dir: rel(rtDir), commit: rt.commit }, argv: process.argv.slice(1).map(a => (path.isAbsolute(a) ? rel(a) : a)),
    tools: { node: process.version, python: rt.python.version }, output: res.output, expected: { width: want.width, height: want.height, fps: wantFps, frames: +want.frames }, seconds: res.seconds, notes };
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  const runJson = path.join(dir, 'out', 'c-runtime-run.json');
  fs.writeFileSync(runJson, JSON.stringify(record, null, 1) + '\n');
  env.runJson = rel(runJson);
  if (diffs.length) throw new Fail(4, `成片与案例目录记录的规格不符：${diffs.join('；')}`, '对照 ARCHIVE-RESTORED.json 与 build.sh，看是不是换了帧率或尺寸');
  log(`\n复刻完成：${rel(film)}  ${got.width}×${got.height}  ${got.fps} fps  ${got.frames} 帧（与案例目录一致），用时 ${res.seconds} 秒`);
  return 0;
}

// ———————————————————————————— sy：适配页 ————————————————————————————
export function syAdapter(html, dir) {
  const base = `<base href="/${VENDOR.sy}/styles/${dir}/">`;
  const force = `<script>/* 北冥适配：SY 的 Reel.scene 只在 ?render=1 时进入逐帧模式（否则按墙钟循环播放），这里在它加载前补上 */`
    + `if(!/[?&]render=/.test(location.search))history.replaceState(null,'',location.origin+location.pathname+'?render=1&rs=1');</script>`;
  const shim = `<script>/* 北冥适配：__duration / __fps / __seek → window.DUR / FPS / render，第 0 秒画好后置 READY（engine/render/page.mjs 的页面约定） */`
    + `(function(){var w=function(){if(typeof window.__seek!=='function')return setTimeout(w,5);`
    + `window.DUR=window.__duration;window.FPS=window.__fps;window.render=function(t){return window.__seek(t)};`
    + `Promise.resolve(window.__seek(0)).then(function(){window.READY=true},function(e){setTimeout(function(){throw e})})};w()})();</script>`;
  const head = /<head[^>]*>/i.exec(html);
  let out = head ? html.slice(0, head.index + head[0].length) + base + force + html.slice(head.index + head[0].length) : base + force + html;
  const body = out.toLowerCase().lastIndexOf('</body>');
  out = body >= 0 ? out.slice(0, body) + shim + out.slice(body) : out + shim;
  return out;
}

async function sy(o, env) {
  if (!o.target) throw new Fail(2, 'sy 要给风格编号或目录名，例如 18 或 18-ink');
  const { sy: lock } = readLock();
  const stylesDir = path.join(ROOT, VENDOR.sy, 'styles');
  const dirs = fs.readdirSync(stylesDir).filter(d => fs.existsSync(path.join(stylesDir, d, 'index.html')));
  const key = o.target.replace(/^sy[/-]/i, '');
  const dir = dirs.find(d => d === key) || dirs.find(d => d.split('-')[0] === key.padStart(2, '0'));
  if (!dir) throw new Fail(2, `SY 里没有 ${o.target}`, `可选：${dirs.join('、')}`);
  const base = path.resolve(o.out || path.join(ROOT, 'out', 'runtime', `sy-${lock.commit.slice(0, 8)}`));
  const page = path.join(base, dir);
  const r = posix(path.relative(ROOT, page));
  if (r.startsWith('..') || path.isAbsolute(r) || r.startsWith('cases/')) throw new Fail(2, `适配页要放在仓库内、cases/ 以外（收到 ${page}）`, 'engine/render 只服务仓库根；用默认的 out/runtime/');
  const html = fs.readFileSync(path.join(stylesDir, dir, 'index.html'), 'utf8');
  fs.mkdirSync(page, { recursive: true });
  fs.writeFileSync(path.join(page, 'index.html'), syAdapter(html, dir));
  fs.writeFileSync(path.join(page, 'ADAPTER.md'), `# SY ${dir} 的适配页（生成物）\n\n由 \`node tools/c-runtime.mjs sy ${dir}\` 生成：页面原样取自只读快照 \`${VENDOR.sy}/styles/${dir}/\`（sy-style-100@${lock.commit.slice(0, 7)}，MIT，肖雄 XIAOXIONG），只加了 \`<base>\`、强制 \`?render=1\` 和把 \`__seek\` 挂成 \`render(t)\` 的两段脚本。不要提交；方法与署名见 routes/c-style/STYLES.md。\n`);
  env.outputs.push({ path: rel(path.join(page, 'index.html')), sha256: sha256File(path.join(page, 'index.html')), kind: 'adapter-page' });
  const res = { style: `sy/${dir}`, page: rel(page), source: `sy-style-100@${lock.commit.slice(0, 7)}`, license: 'MIT' };
  env.result = res;
  env.warnings.push('SY 页面用本机字体名（Noto CJK、Inter 等），不随库分发：换机器字形会变；也未经北冥的确定性核对');
  log(`适配页：${rel(page)}/index.html`);
  const node = process.execPath, size = ['--size', '1920x1080'];
  if (o.still.length) {
    const r1 = await runChild(node, [path.join(ROOT, 'engine/render/still.mjs'), page, ...o.still.map(String), ...size, '--out', path.join(page, 'out', 'stills')], { cwd: ROOT, env: process.env, timeout: o.timeout });
    if (exitFor(r1)) throw new Fail(exitFor(r1), `静帧渲染失败（退出码 ${r1.code}）`, '看上方日志；WebGL 风格在软件渲染下会很慢，检查 BEIMING_ANGLE');
    for (const t of o.still) { const f = fs.readdirSync(path.join(page, 'out', 'stills')).find(x => x === `s_${t}.jpg`); if (f) env.outputs.push({ path: rel(path.join(page, 'out', 'stills', f)), sha256: sha256File(path.join(page, 'out', 'stills', f)), kind: 'still' }); }
  }
  if (o.video) {
    const vid = path.join(page, 'out', 'video.mp4');
    const r2 = await runChild(node, [path.join(ROOT, 'engine/render/video.mjs'), page, ...size, '--out', vid], { cwd: ROOT, env: process.env, timeout: o.timeout });
    if (exitFor(r2)) throw new Fail(exitFor(r2), `整片渲染失败（退出码 ${r2.code}）`, '看上方日志');
    res.output = { path: rel(vid), ...probeVideo(vid) };
    env.outputs.push({ path: rel(vid), sha256: sha256File(vid), kind: 'video' });
  }
  if (!o.still.length && !o.video) log(`下一步：node engine/render/still.mjs ${rel(page)} 0.5 --size 1920x1080，或 node tools/c-runtime.mjs sy ${dir} --video`);
  return 0;
}

// ———————————————————————————— 命令行 ————————————————————————————
export function parse(argv) {
  const o = { cmd: null, json: false, help: false, target: null, python: null, venv: false, music: false, force: false, dryRun: false,
    out: null, verify: false, timeout: 3600, still: [], video: false };
  const a = [...argv];
  const val = x => { const v = a.shift(); if (v === undefined || v.startsWith('--')) throw new Fail(2, `选项 ${x} 缺少取值`); return v; };
  const allow = { setup: ['--python', '--venv', '--music', '--force', '--dry-run', '--out'], status: ['--out', '--verify'],
    build: ['--timeout', '--dry-run', '--out'], sy: ['--still', '--video', '--out', '--timeout'] };
  while (a.length) {
    const x = a.shift();
    if (x === '--json') { o.json = true; continue; }
    if (x === '--help' || x === '-h') { o.help = true; continue; }
    if (!x.startsWith('-')) {
      if (!o.cmd) { if (!allow[x]) throw new Fail(2, `不认识的子命令 ${x}（可用：${Object.keys(allow).join('、')}）`); o.cmd = x; continue; }
      if ((o.cmd === 'build' || o.cmd === 'sy') && !o.target) { o.target = x; continue; }
      throw new Fail(2, `多余的参数 ${x}`);
    }
    if (!o.cmd) { if (o.help) continue; throw new Fail(2, `选项 ${x} 要写在子命令后面`); }
    if (!allow[o.cmd].includes(x)) throw new Fail(2, `${o.cmd} 不认识选项 ${x}（可用：${allow[o.cmd].join(' ')}）`);
    if (x === '--python') o.python = val(x);
    else if (x === '--out') o.out = val(x);
    else if (x === '--timeout') { const v = val(x); if (!/^\d+$/.test(v)) throw new Fail(2, `--timeout 要非负整数（秒），收到 ${v}`); o.timeout = +v; }
    else if (x === '--still') {
      const v = val(x);
      o.still = v.split(',').map(s => s.trim()).filter(Boolean);
      if (!o.still.length || o.still.some(s => !/^\d+(\.\d+)?$/.test(s))) throw new Fail(2, `--still 要写成逗号分隔的秒数，例如 0.5,2（收到 ${v}）`);
    } else if (x === '--venv') o.venv = true;
    else if (x === '--music') o.music = true;
    else if (x === '--force') o.force = true;
    else if (x === '--dry-run') o.dryRun = true;
    else if (x === '--verify') o.verify = true;
    else if (x === '--video') o.video = true;
  }
  if (!o.cmd && !o.help) throw new Fail(2, '缺少子命令');
  if (o.venv && o.python && o.cmd === 'setup') { /* --venv 时 --python 是建虚拟环境用的基础解释器 */ }
  return o;
}

export async function main(argv) {
  const env = { ok: true, exitCode: 0, command: `c-runtime ${argv.join(' ')}`.trim(), error: null, outputs: [], runJson: null, warnings: [] };
  let o = null;
  try {
    o = parse(argv);
    if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
    const fn = { setup, status, build, sy }[o.cmd];
    env.exitCode = await fn(o, env);
  } catch (e) {
    const code = e instanceof Fail ? e.exitCode : 1;
    env.ok = false; env.exitCode = code;
    env.error = { code: CODE_NAME[code] || 'failed', message: e.message, hint: e.hint || '' };
    if (!o?.json) { log(`c-runtime：${e.message}`); if (e.hint) log(`下一步：${e.hint}`); if (code === 2) log(USAGE); }
  }
  for (const w of env.warnings) if (!o?.json) log(`提示：${w}`);
  if (o?.json || (!o && argv.includes('--json'))) process.stdout.write(JSON.stringify(env) + '\n');
  return env.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main(process.argv.slice(2));
