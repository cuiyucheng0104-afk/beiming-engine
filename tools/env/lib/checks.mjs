// 北冥仓库 · 环境检查项（doctor 与 preflight 共用）。每项返回统一结构：
//   {id, title, status: pass|warn|fail|info|skip, ok, required, found, expected, fix, detail}
//   ok = status 不是 fail；required 的项 fail 时 doctor 退出 3。fix 是可以直接复制执行的命令或一句明确的动作。
//
// 接口：loadSpec(root)、check 函数若干（见下方 export）、pf(map)（按平台取修复命令）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, which } from './proc.mjs';
import { resolvePython, pythonEnv, venvPython } from './python.mjs';
import { parseLock, pinsFor, sha256 } from './lockfile.mjs';
import { probeFfmpeg, missingComponents } from './ffmpeg.mjs';
import { headlessShell, resolveAngle, probeGpu, classifyRenderer, nvidiaSmi } from './browser.mjs';
import { findSh, shFix } from './sh.mjs';

export const loadSpec = root => JSON.parse(fs.readFileSync(path.join(root, 'tools/env/spec.json'), 'utf8'));
export const pf = (map, platform = process.platform) => (map ? map[platform] || map.linux || null : null);

export function mk(id, title, { status, required = true, found = null, expected = null, fix = null, detail = null, data } = {}) {
  return { id, title, status, ok: status !== 'fail', required, found, expected, fix, detail, ...(data === undefined ? {} : { data }) };
}

const cmpSemver = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1; }
  return 0;
};
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

// ── Node 与 npm 依赖 ──
export function checkNode(spec) {
  const v = process.versions.node;
  const ok = cmpSemver(v, spec.node.min) >= 0;
  const major = v.split('.')[0];
  return mk('node.version', 'Node.js 版本', {
    status: ok ? 'pass' : 'fail', found: v, expected: `>= ${spec.node.min}（推荐 ${spec.node.recommended}，见 .nvmrc）`,
    fix: ok ? null : pf(spec.node.fix),
    detail: ok && major !== spec.node.recommended ? `已验证的是 Node ${spec.node.recommended}；${major} 能用，出问题先换回 ${spec.node.recommended}` : null,
  });
}

export function checkNpm(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const lockPath = path.join(root, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return mk('npm.lock', 'npm 依赖与锁文件', { status: 'fail', found: '没有 package-lock.json', fix: '从仓库恢复 package-lock.json（git checkout -- package-lock.json）' });
  const lock = readJson(lockPath);
  const rootDeps = lock.packages?.['']?.dependencies || {};
  const declared = pkg.dependencies || {};
  const drift = Object.keys({ ...rootDeps, ...declared }).filter(k => rootDeps[k] !== declared[k]);
  if (drift.length) {
    return mk('npm.lock', 'npm 依赖与锁文件', { status: 'fail', found: `package.json 与 package-lock.json 不一致：${drift.join('、')}`, expected: '两者声明相同的依赖与版本',
      fix: '维护者在改依赖的提交里运行 npm install 更新 package-lock.json；使用者先 git pull 拿到一致的两份文件' });
  }
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(nm)) return mk('npm.lock', 'npm 依赖与锁文件', { status: 'fail', found: '没有 node_modules', expected: `${Object.keys(rootDeps).length} 个依赖按 package-lock.json 安装`, fix: 'npm ci' });
  const bad = [];
  for (const [key, meta] of Object.entries(lock.packages || {})) {
    if (!key.startsWith('node_modules/') || meta.dev || meta.optional) continue;
    const pj = path.join(root, key, 'package.json');
    let v = null;
    try { v = readJson(pj).version; } catch { /* 没装 */ }
    if (v !== meta.version) bad.push(`${key.slice(13)} ${v || '缺失'}（应为 ${meta.version}）`);
  }
  const linked = fs.lstatSync(nm).isSymbolicLink();
  return mk('npm.lock', 'npm 依赖与锁文件', {
    status: bad.length ? 'fail' : 'pass', found: bad.length ? bad.join('；') : `${Object.keys(rootDeps).length} 个依赖与 package-lock.json 一致${linked ? '（node_modules 是链接）' : ''}`,
    expected: '与 package-lock.json 一致', fix: bad.length ? (linked ? 'node_modules 是指向别处的链接：在它指向的检出里运行 npm ci，或删掉链接后在本仓库运行 npm ci' : 'npm ci') : null,
  });
}

export function checkPlaywright(root, spec) {
  const pj = path.join(root, 'node_modules', spec.playwright.package, 'package.json');
  let v = null, rev = null;
  try {
    v = readJson(pj).version;
    rev = readJson(path.join(path.dirname(pj), 'browsers.json')).browsers.find(b => b.name === spec.playwright.browser)?.revision;
  } catch { /* 没装 */ }
  const ok = v === spec.playwright.version && rev === spec.playwright.revision;
  return mk('playwright.core', 'playwright-core 版本', {
    status: ok ? 'pass' : 'fail', found: v ? `${v}（${spec.playwright.browser} r${rev}）` : '没装',
    expected: `${spec.playwright.version}（${spec.playwright.browser} r${spec.playwright.revision} / ${spec.playwright.browserVersion}）`,
    fix: ok ? null : 'npm ci', detail: ok ? null : '版本由 package-lock.json 固定；不要用 npx playwright install（会拉到别的版本）',
  });
}

export function checkHeadlessShell(root, spec, env = process.env) {
  const hs = headlessShell({ root, spec, env });
  const chrome = env.BEIMING_CHROME;
  if (chrome) {
    const exists = fs.existsSync(chrome);
    return mk('browser.headless-shell', '渲染用的浏览器', {
      status: exists ? 'warn' : 'fail', found: `BEIMING_CHROME=${chrome}${exists ? '' : '（文件不存在）'}`,
      expected: `锁定的 ${spec.playwright.browser} ${spec.playwright.browserVersion}`,
      fix: exists ? '交付渲染前取消 BEIMING_CHROME，改用锁定的浏览器（npm run setup 安装）' : '改正 BEIMING_CHROME 的路径，或取消它（用锁定的浏览器）',
      detail: exists ? '指定了别的浏览器：系统 Chrome 会自动升级，跨机器的像素一致性与金标准比对都不再成立' : null,
      data: { lockedInstalled: hs.installed, lockedDir: hs.dir },
    });
  }
  return mk('browser.headless-shell', '锁定的无头浏览器', {
    status: hs.installed ? 'pass' : 'fail', found: hs.installed ? hs.executable : hs.reason,
    expected: `${spec.playwright.browser} r${spec.playwright.revision}（${spec.playwright.browserVersion}）`,
    fix: hs.installed ? null : 'npm run setup（只装锁定版本；内网或国内网络先设 PLAYWRIGHT_DOWNLOAD_HOST 指向镜像）',
    detail: hs.installed ? null : '不要按 Playwright 横幅提示执行 npx playwright install：那会拉取别的 Playwright 版本与全部浏览器',
    data: { dir: hs.dir },
  });
}

export async function checkGpu(root, spec, { env = process.env, gpuMode = 'software-ok', needWebgl = true } = {}) {
  const a = resolveAngle(spec, env);
  const out = [];
  if (!a.valid) {
    out.push(mk('gpu.angle', 'ANGLE 后端设置', { status: 'fail', found: `BEIMING_ANGLE=${a.angle}`, expected: a.allowed.join(' / '),
      fix: `改成合法值，例如 ${process.platform === 'darwin' ? 'metal' : 'vulkan（NVIDIA）'}；拼错时渲染器会悄悄落到默认后端或软件渲染` }));
    return out;
  }
  const nv = process.platform === 'darwin' ? { ok: false, gpus: [] } : await nvidiaSmi({ env });
  const recommend = process.platform === 'darwin' ? 'metal' : nv.ok ? 'vulkan' : process.platform === 'win32' ? 'd3d11（没有 NVIDIA；双显卡机先跑 node tools/rtx/gpucheck.mjs 对比）' : 'swiftshader（没有显卡的机器明确写出来，结果按软件渲染记录）';
  out.push(mk('gpu.angle', 'ANGLE 后端设置', { status: 'pass', required: false, found: `${a.angle}（${a.source}）`, expected: `本机推荐 ${recommend}`,
    detail: nv.ok ? `NVIDIA：${nv.gpus.map(g => `${g.name}（驱动 ${g.driver}，占用 ${g.util}%）`).join('；')}` : null }));
  const p = await probeGpu({ root, angle: a.angle, chrome: env.BEIMING_CHROME });
  if (!p.ok) {
    out.push(mk('browser.launch', '浏览器启动与 WebGL', { status: 'fail', found: p.error, fix: /没装/.test(p.error) ? 'npm run setup' : `换一个 ANGLE 后端再试（${process.platform === 'darwin' ? 'metal' : 'vulkan / d3d11 / gl'}），或运行 node tools/rtx/gpucheck.mjs 逐个后端对比`,
      detail: `用与 engine/render/page.mjs 相同的启动参数（--use-angle=${a.angle}）` }));
    return out;
  }
  if (!p.webgl2) {
    out.push(mk('browser.launch', '浏览器启动与 WebGL', { status: needWebgl ? 'fail' : 'warn', required: needWebgl, found: `浏览器 ${p.version} 能启动，但拿不到 WebGL2 上下文`,
      fix: `换 ANGLE 后端（BEIMING_ANGLE=${process.platform === 'darwin' ? 'metal' : 'vulkan'}），更新显卡驱动；A、B 路线必须有 WebGL2` }));
    return out;
  }
  out.push(mk('browser.launch', '浏览器启动与 WebGL', { status: p.shaderOk ? 'pass' : 'fail', found: `浏览器 ${p.version}，WebGL2 可用，${(p.ms / 1000).toFixed(1)} 秒`, fix: p.shaderOk ? null : '着色器编译失败：更新显卡驱动或换 ANGLE 后端' }));
  const kind = classifyRenderer(p.renderer, spec);
  const strict = gpuMode === 'required';
  let status = 'pass', fix = null, detail = null;
  if (kind === 'software') {
    status = strict ? 'fail' : 'warn';
    fix = process.platform === 'darwin' ? '检查是否在没有图形会话的环境（ssh、CI）里运行；本机直接运行应走 Metal' : nv.ok ? '设 BEIMING_ANGLE=vulkan 后重跑 doctor' : '这台机器没有可用的显卡：只做冒烟或 CI 用；交付渲染换到有 GPU 的机器（tools/remote）';
    detail = '软件渲染每帧 2–4 秒，画面与硬件渲染有细微差别；交付渲染加 --gpu required 让它直接失败';
  } else if (kind === 'integrated' && nv.ok) {
    status = strict ? 'fail' : 'warn';
    fix = '设 BEIMING_ANGLE=vulkan，让 WebGL 跑在 NVIDIA 独显上';
    detail = '有 NVIDIA 显卡，但 WebGL 落在核显上（Windows 默认 D3D11 的常见问题）';
  }
  out.push(mk('gpu.renderer', 'WebGL 实际使用的 GPU', { status, required: strict, found: `${p.renderer}（${p.vendor}）`, expected: strict ? '硬件 GPU（--gpu required）' : '硬件 GPU；软件渲染只告警', fix, detail,
    data: { kind, angle: a.angle, browser: p.version, maxTexture: p.maxTexture, args: p.args, argsSource: p.argsSource } }));
  return out;
}

// ── FFmpeg ──
export async function checkFfmpeg(spec, env = process.env, { full = true } = {}) {
  const bin = env.FFMPEG || 'ffmpeg';
  const p = await probeFfmpeg(bin, { full, env });
  const out = [];
  if (!p.ok) {
    out.push(mk('ffmpeg.version', 'FFmpeg', { status: 'fail', found: `${env.FFMPEG ? `FFMPEG=${env.FFMPEG}：` : ''}${p.error}`, expected: `FFmpeg ${spec.ffmpeg.minMajor} 以上，带 libx264、aac、loudnorm、ebur128`, fix: pf(spec.ffmpeg.fix) }));
    return { checks: out, probe: p };
  }
  const okVer = p.major !== null && p.major >= spec.ffmpeg.minMajor;
  out.push(mk('ffmpeg.version', 'FFmpeg 版本', { status: okVer ? 'pass' : 'fail', found: `${p.version}（主版本 ${p.major ?? '未知'}，libavcodec ${p.libavcodecMajor ?? '?'}）${p.path}`,
    expected: `>= ${spec.ffmpeg.minMajor}`, fix: okVer ? null : pf(spec.ffmpeg.fix) }));
  if (env.FFMPEG) {
    const onPath = which('ffmpeg', { env });
    if (!onPath || path.resolve(onPath) !== path.resolve(p.path)) {
      out.push(mk('ffmpeg.path', 'PATH 里的 ffmpeg', { status: 'warn', required: false, found: onPath || 'PATH 里没有 ffmpeg', expected: `与 FFMPEG=${env.FFMPEG} 相同`,
        fix: `把 ${path.dirname(p.path)} 加进 PATH`, detail: 'engine/render/video.mjs、mux.sh、build.sh 目前只从 PATH 调用 ffmpeg，不认 FFMPEG 变量' }));
    }
  }
  if (!full && !/--enable-libx264/.test(p.configuration)) {
    // 快速模式只看构建参数：没有 --enable-libx264 的构建（例如 Playwright 自带的 ffmpeg）不能出片
    out.push(mk('ffmpeg.components', 'FFmpeg 组件', { status: 'fail', found: '构建参数里没有 --enable-libx264', expected: 'libx264 编码器', fix: `换一个完整构建的 FFmpeg：${pf(spec.ffmpeg.fix)}` }));
  }
  if (full) {
    const miss = missingComponents(p, spec.ffmpeg);
    const x264 = /--enable-libx264/.test(p.configuration) || p.lists.encoders?.has('libx264');
    out.push(mk('ffmpeg.components', 'FFmpeg 组件', { status: miss.required.length ? 'fail' : miss.recommended.length ? 'warn' : 'pass',
      found: miss.required.length ? `缺必需组件：${miss.required.join('、')}` : miss.recommended.length ? `缺 QA 用组件：${miss.recommended.join('、')}` : '编码器、滤镜、封装格式齐全',
      expected: Object.entries(spec.ffmpeg.required).map(([k, v]) => `${k}: ${v.join(' ')}`).join('；'),
      fix: miss.required.length || miss.recommended.length ? `换一个完整构建的 FFmpeg：${pf(spec.ffmpeg.fix)}` : null,
      detail: !x264 ? '这个 ffmpeg 没有 libx264（Playwright 自带的 ffmpeg 就是这样），不能用来出片' : null }));
  }
  const fp = await probeFfmpeg(env.FFPROBE || 'ffprobe', { env });
  out.push(mk('ffprobe.version', 'ffprobe', { status: fp.ok && fp.major >= spec.ffmpeg.minMajor ? 'pass' : 'fail',
    found: fp.ok ? `${fp.version} ${fp.path}` : `${env.FFPROBE ? `FFPROBE=${env.FFPROBE}：` : ''}${fp.error}`, expected: `与 ffmpeg 同一套构建，>= ${spec.ffmpeg.minMajor}`,
    fix: fp.ok && fp.major >= spec.ffmpeg.minMajor ? null : pf(spec.ffmpeg.fix) }));
  return { checks: out, probe: p };
}

// ── Python ──
const PKG_SCRIPT = [
  'import json, sys, time, importlib, importlib.metadata as md',
  'req = json.loads(sys.stdin.read())',
  'inst = {}',
  'for n in req["names"]:',
  '    try: inst[n] = md.version(n)',
  '    except md.PackageNotFoundError: inst[n] = None',
  'imp = {}',
  'for m in req["imports"]:',
  '    t = time.perf_counter()',
  '    try:',
  '        importlib.import_module(m); imp[m] = {"ok": True, "sec": round(time.perf_counter() - t, 3)}',
  '    except Exception as e:',
  '        imp[m] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}',
  'opt = {}',
  'for m in req["optional"]:',
  '    import importlib.util as u',
  '    opt[m] = u.find_spec(m) is not None',
  'print(json.dumps({"installed": inst, "imports": imp, "optional": opt}))',
].join('\n');

export async function checkPython(root, spec, { env = process.env, imports = true } = {}) {
  const out = [];
  const py = await resolvePython({ env, root, want: spec.python.version });
  if (!py.ok) {
    out.push(mk('python.interpreter', 'Python 解释器', { status: 'fail', found: py.error, expected: `Python ${spec.python.version}（仓库内 .venv）`, fix: `npm run setup（${py.hint}）` }));
    return { checks: out, py };
  }
  const want = spec.python.version.split('.').map(Number);
  const verOk = py.version[0] === want[0] && py.version[1] === want[1];
  const venvExists = fs.existsSync(path.join(root, spec.python.venv));
  const overridden = venvExists && py.source !== '.venv';
  out.push(mk('python.interpreter', 'Python 解释器', {
    status: verOk ? (overridden ? 'warn' : 'pass') : 'fail', found: `${py.versionString}，来自 ${py.source}：${py.executable}`,
    expected: `Python ${spec.python.version}.x（锁文件只覆盖 ${spec.python.version}）`,
    fix: !verOk ? (py.source === '.venv' ? '删掉 .venv 后重跑 npm run setup'
      : ['BEIMING_PYTHON', 'BEIMING_PY', 'PYTHON'].includes(py.source) ? `取消 ${py.source}（或改指 Python ${spec.python.version}），再运行 npm run setup`
        : 'npm run setup（在仓库内建 Python 3.12 的 .venv，之后所有工具自动用它）') : overridden ? `取消 ${py.source}，让工具用仓库的 .venv` : null,
    detail: overridden ? `${py.source} 覆盖了仓库的 .venv（node-gyp 等工具也会设 PYTHON）` : null,
    data: { source: py.source, executable: py.executable, venv: py.prefix !== py.basePrefix },
  }));
  if (!verOk || !imports) return { checks: out, py };
  const lockPath = path.join(root, spec.python.lock);
  const lock = parseLock(fs.readFileSync(lockPath, 'utf8'));
  const pins = pinsFor(lock, py);
  const r = await run(py.cmd, [...py.args, '-c', PKG_SCRIPT], {
    env: pythonEnv(env, { root }), timeout: 180_000,
    input: JSON.stringify({ names: pins.map(p => p.name), imports: spec.python.imports, optional: spec.python.optional.map(o => o.module) }),
  });
  let res = null;
  try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* 下面报错 */ }
  if (!res) {
    out.push(mk('python.packages', 'Python 依赖（requirements.lock）', { status: 'fail', found: `检查脚本失败：${r.timedOut ? '超时' : (r.stderr || '').trim().split('\n').pop() || `退出码 ${r.code}`}`, fix: 'npm run setup' }));
    return { checks: out, py };
  }
  const wrong = pins.filter(p => res.installed[p.name] !== p.version).map(p => `${p.name} ${res.installed[p.name] || '缺失'}（锁定 ${p.version}）`);
  const failedImports = Object.entries(res.imports).filter(([, v]) => !v.ok).map(([m, v]) => `${m}：${v.error}`);
  const slow = Object.values(res.imports).reduce((s, v) => s + (v.sec || 0), 0);
  out.push(mk('python.packages', 'Python 依赖（requirements.lock）', {
    status: wrong.length || failedImports.length ? 'fail' : 'pass',
    found: wrong.length || failedImports.length ? [...wrong, ...failedImports].join('；') : `${pins.length} 个包与锁文件一致；${spec.python.imports.join('、')} 可导入（${slow.toFixed(1)} 秒）`,
    expected: `${pins.length} 个包按 ${spec.python.lock} 安装`,
    fix: wrong.length || failedImports.length ? (py.source === '.venv' ? 'npm run setup' : `npm run setup，并取消 ${py.source}（让工具用 .venv）`) : null,
    detail: slow > spec.python.slowImportSeconds ? `首次导入用了 ${slow.toFixed(0)} 秒：新环境第一次加载原生库就是这么慢（macOS 上常见 30–60 秒），再跑一次会降到 1–2 秒` : null,
  }));
  for (const o of spec.python.optional) {
    out.push(mk(`python.optional.${o.module}`, `可选 Python 包 ${o.module}`, { status: res.optional[o.module] ? 'pass' : 'info', required: false,
      found: res.optional[o.module] ? '已安装' : '未安装', expected: o.purpose, fix: res.optional[o.module] ? null : `需要时：uv pip install --python "${venvPython(path.join(root, spec.python.venv))}" ${o.module}` }));
  }
  const cacheDir = env.NUMBA_CACHE_DIR || path.join(root, 'engine', 'audio');
  let writable = true;
  try { fs.accessSync(fs.existsSync(cacheDir) ? cacheDir : path.dirname(cacheDir), fs.constants.W_OK); } catch { writable = false; }
  out.push(mk('python.numba-cache', 'numba 编译缓存目录可写', { status: writable ? 'pass' : 'warn', required: false, found: cacheDir,
    fix: writable ? null : '设 NUMBA_CACHE_DIR=<可写目录>；不设时每次运行都要重新编译', detail: env.NUMBA_CACHE_DIR ? '来自 NUMBA_CACHE_DIR' : 'engine/audio/dsp.py 用 @njit(cache=True)，缓存写在 engine/audio/__pycache__' }));
  return { checks: out, py };
}

// ── 仓库与磁盘 ──
export async function checkGitEol(root) {
  const attrs = fs.existsSync(path.join(root, '.gitattributes'));
  const r = await run('git', ['-c', 'core.quotepath=off', 'ls-files', '--eol', '-z'], { cwd: root, timeout: 30_000 });
  if (r.error || r.code !== 0) return mk('git.eol', '工作区换行', { status: 'skip', required: false, found: '不是 git 检出（或没有 git），跳过' });
  const bad = [];
  for (const rec of r.stdout.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [i, w, attr] = rec.slice(0, tab).trim().split(/\s+/);
    const p = rec.slice(tab + 1);
    if (w === 'w/crlf' && i !== 'i/crlf' && !/^cases\/(source|vendor|licenses)\//.test(p) && !/eol=crlf/.test(attr || '')) bad.push(p);
  }
  const shBad = bad.filter(p => p.endsWith('.sh'));
  return mk('git.eol', '工作区换行', {
    status: bad.length ? 'fail' : attrs ? 'pass' : 'warn',
    found: bad.length ? `${bad.length} 个文本文件被检出成 CRLF${shBad.length ? `（含 ${shBad.slice(0, 3).join('、')} 等 sh 脚本，sh 会报 set: -: invalid option）` : ''}，例：${bad.slice(0, 3).join('、')}` : attrs ? 'cases/ 归档以外没有 CRLF' : '没有 CRLF，但仓库缺 .gitattributes（别的机器上用 autocrlf=true 克隆仍会出问题）',
    expected: '文本文件一律 LF（.gitattributes 固定）',
    fix: bad.length ? '先提交或 git stash 本地改动，然后：git config core.autocrlf false && git rm -r -q --cached . && git reset --hard' : attrs ? null : '更新到带 .gitattributes 的提交',
  });
}

export function checkDisk(root, spec) {
  let free = null;
  try { const s = fs.statfsSync(root); free = s.bavail * s.bsize; } catch { /* 老系统没有 statfs */ }
  if (free === null) return mk('disk.free', '磁盘剩余空间', { status: 'skip', required: false, found: '无法读取' });
  const gib = free / 2 ** 30;
  const status = gib < spec.disk.failBelowGiB ? 'fail' : gib < spec.disk.warnBelowGiB ? 'warn' : 'pass';
  return mk('disk.free', '磁盘剩余空间（仓库所在盘）', { status, found: `${gib.toFixed(1)} GiB`, expected: `>= ${spec.disk.warnBelowGiB} GiB（低于 ${spec.disk.failBelowGiB} GiB 判失败）`,
    fix: status === 'pass' ? null : '清理 out/ 与 films/*/out/ 里的旧产物，或把仓库放到空间充足的盘', detail: '4K 逐帧渲染与分段编码需要较多临时空间' });
}

export function checkWritable(root) {
  let ok = true;
  try { fs.accessSync(root, fs.constants.W_OK); } catch { ok = false; }
  return mk('repo.writable', '仓库目录可写', { status: ok ? 'pass' : 'fail', found: root, fix: ok ? null : '换到有写权限的位置检出仓库' });
}

export function checkFonts(root, spec) {
  const out = [];
  const miss = [], lfs = [];
  for (const f of spec.fonts.files) {
    const p = path.join(root, spec.fonts.dir, f);
    if (!fs.existsSync(p)) { miss.push(f); continue; }
    const head = fs.readFileSync(p).subarray(0, 40).toString('latin1');
    if (head.startsWith('version https://git-lfs')) lfs.push(f);
  }
  out.push(mk('fonts.repo', '仓库字体子集', { status: miss.length || lfs.length ? 'fail' : 'pass',
    found: miss.length ? `缺少 ${miss.join('、')}` : lfs.length ? `${lfs.join('、')} 是 LFS 指针，不是字体` : `${spec.fonts.files.length} 个字体文件齐全`,
    fix: miss.length || lfs.length ? 'git checkout -- fonts/（或重新克隆）' : null }));
  if (process.platform === 'linux') {
    const fc = which('fc-list');
    return (async () => {
      let n = null;
      if (fc) { const r = await run(fc, [':lang=zh', 'family'], { timeout: 10_000 }); n = r.code === 0 ? r.stdout.split('\n').filter(Boolean).length : null; }
      out.push(mk('fonts.system-cjk', '系统中文字体（缺字回退用）', { status: n ? 'pass' : 'warn', required: false, found: fc ? `${n ?? 0} 个中文字体族` : '没有 fc-list', fix: n ? null : spec.fonts.linuxCjkFix }));
      return out;
    })();
  }
  return out;
}

export function checkSh(spec, root, env = process.env) {
  const sh = findSh({ env });
  const present = spec.shEntrypoints.filter(p => fs.existsSync(path.join(root, p.path)));
  const onPath = sh.source === 'PATH';
  const status = !present.length ? 'pass' : !sh.path ? 'fail' : onPath || sh.source === 'BEIMING_SH' ? 'pass' : 'warn';
  return mk('shell.sh', 'POSIX sh（过渡期：出片封装仍要用）', {
    status, found: sh.path ? `${sh.path}（${sh.source}）` : `没有 sh：${sh.tried.join('；')}`,
    expected: present.length ? `仍在用的 sh 入口：${present.map(p => p.path).join('、')}` : '已无 sh 入口',
    fix: !sh.path ? shFix() : status === 'warn' ? `PATH 里没有 sh：直接调用 sh 的入口（${present.filter(p => p.spawnedBy?.length).flatMap(p => p.spawnedBy).join('、') || '各 sh 入口'}）在它们改成 Node 之前仍要它在 PATH 里，当前窗口执行 $env:Path += ';${path.win32.dirname(sh.path)}'` : null,
    detail: present.length ? `这些 sh 入口改成 Node 实现后（见 docs/ENVIRONMENT.md「sh 入口盘点」），这一项不再必需` : null,
    data: { sh: sh.path, source: sh.source || null, entrypoints: present.map(p => p.path) },
  });
}

export function checkEnvVars(spec, env = process.env) {
  const known = new Map(spec.envVars.map(v => [v.name, v]));
  const set = [], unknown = [];
  for (const [k, v] of Object.entries(env)) {
    const mask = /KEY|TOKEN|SECRET|PASSWORD/i.test(k) ? '（已隐藏）' : v;
    if (known.has(k)) set.push(`${k}=${mask}`);
    else if (spec.envPrefixes.some(p => k.startsWith(p))) unknown.push(k);
  }
  const near = k => [...known.keys()].filter(n => n !== k && (n.startsWith(k.slice(0, 8)) || k.startsWith(n.slice(0, 8)))).slice(0, 2);
  return mk('env.vars', '生效的环境变量', { status: unknown.length ? 'warn' : 'info', required: false,
    found: set.length ? set.join('；') : '没有设置任何仓库相关变量（全部用默认值）',
    fix: unknown.length ? `检查是否拼错：${unknown.map(k => `${k}${near(k).length ? `（是不是 ${near(k).join(' / ')}？）` : ''}`).join('；')}` : null,
    detail: '完整的变量表见 docs/ENVIRONMENT.md「环境变量」', data: { set: set.map(s => s.split('=')[0]), unknown } });
}

export function checkSamples(env = process.env) {
  const s = env.BEIMING_SAMPLES;
  if (!s) return mk('audio.samples', '配乐采样库（可选）', { status: 'info', required: false, found: '未设 BEIMING_SAMPLES：配乐用 audio/score_cache.npz 缓存', detail: '只有 sh audio/build.sh --score 重渲配乐才需要' });
  const ok = fs.existsSync(s) && fs.statSync(s).isDirectory();
  return mk('audio.samples', '配乐采样库（可选）', { status: ok ? 'pass' : 'warn', required: false, found: s, fix: ok ? null : '改正 BEIMING_SAMPLES 指向采样库目录，或取消它' });
}

// ── B 路线 ──
export function raeaValidatedVersion(root, spec) {
  try {
    const src = fs.readFileSync(path.join(root, spec.raea.versionSource), 'utf8');
    const m = new RegExp(spec.raea.versionPattern).exec(src);
    if (m) return m[1];
  } catch { /* 用备用值 */ }
  return spec.raea.fallbackVersion;
}

export async function checkRaea(root, spec, { env = process.env, required = true } = {}) {
  const want = raeaValidatedVersion(root, spec);
  const bin = env.RAEA_BIN;
  const base = { required, expected: `原生运行时 ${want}（或 BNE_ALLOW_VERSION 放行的版本）` };
  if (!bin) return mk('raea.runtime', 'B 路线原生运行时', { ...base, status: required ? 'fail' : 'info', found: '没有设 RAEA_BIN',
    fix: process.platform === 'win32' ? "$env:RAEA_BIN = 'D:\\beiming\\tools\\raea\\bin\\raea.exe'（换成你的安装位置；运行时不随仓库分发，见 THIRD-PARTY.md）" : 'export RAEA_BIN=/opt/raea/bin/raea（换成你的安装位置；运行时不随仓库分发，见 THIRD-PARTY.md）' });
  let real;
  try { real = fs.realpathSync(bin); } catch { return mk('raea.runtime', 'B 路线原生运行时', { ...base, status: 'fail', found: `RAEA_BIN=${bin} 不存在`, fix: '改成运行时可执行文件的完整路径（安装包要保留 bin/ 与 share/）' }); }
  if (process.platform !== 'win32') { try { fs.accessSync(real, fs.constants.X_OK); } catch { return mk('raea.runtime', 'B 路线原生运行时', { ...base, status: 'fail', found: `${real} 不可执行`, fix: `chmod +x "${real}"` }); } }
  const vf = path.resolve(path.dirname(real), spec.raea.versionFile);
  let version = null;
  try { version = fs.readFileSync(vf, 'utf8').trim(); } catch { /* 缺版本文件 */ }
  if (!version) return mk('raea.runtime', 'B 路线原生运行时', { ...base, status: 'fail', found: `缺 ${vf}`, fix: '安装包不完整：重新解压完整发行包（保留 bin/ 与 share/raea/VERSION）' });
  const allowed = version === want || version === env.BNE_ALLOW_VERSION;
  const digest = sha256(fs.readFileSync(real));
  return mk('raea.runtime', 'B 路线原生运行时', { ...base, status: allowed ? 'pass' : 'fail', found: `${version}（${real}，sha256 ${digest.slice(0, 16)}…）`,
    fix: allowed ? null : `换回已验证的 ${want}；确实要用 ${version} 时先按 routes/b-native/README.md 重跑验收，再设 BNE_ALLOW_VERSION=${version}`,
    data: { version, path: real, sha256: digest } });
}

// ── C 路线 ──
export async function checkCases(root, env = process.env, { required = true } = {}) {
  const py = await resolvePython({ env, root });
  if (!py.ok) return mk('cases.snapshot', 'C 路线案例库与风格库快照', { status: 'fail', required, found: py.error, fix: 'npm run setup' });
  const r = await run(py.cmd, [...py.args, path.join(root, 'tools', 'casebook.py'), 'check'], { cwd: root, env: pythonEnv(env, { root }), timeout: 180_000 });
  const msg = (r.stdout + r.stderr).trim().split('\n').pop() || '';
  return mk('cases.snapshot', 'C 路线案例库与风格库快照', { status: r.code === 0 ? 'pass' : 'fail', required, found: msg.slice(0, 300),
    fix: r.code === 0 ? null : /Checksum|blob/i.test(msg) ? '归档文件的字节被改了（多半是换行被转换）：git config core.autocrlf false 后重新检出 cases/' : '按报错修复；不要就地改 cases/source、cases/vendor' });
}

export { venvPython, os };
