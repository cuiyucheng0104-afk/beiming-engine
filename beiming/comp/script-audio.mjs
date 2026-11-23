// 事件表驱动的 Python+numpy 程序化声音脚本工序：
// 自包含解析 Python 解释器，不经 shell 启动未修改的 .py 声音脚本（传 --events / --out 与 BEIMING_* 环境变量），
// 校验产出的 48 kHz WAV（声道、有限样本、与片长帧数一致）及可选伴随产物（report.json、stems/*.wav）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { SAMPLE_RATE, readWav } from './audio.mjs';
import { CompError, bad, parseFps } from './stitch.mjs';

export const DEFAULT_SCRIPT_TIMEOUT_MS = 600000;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 零陷阱校验：拒绝 Proxy、getter/setter 属性陷阱、非纯对象与循环引用。
 * 在读取属性值之前先检查描述符，确保恶意的 throwing getter 不会被触发。
 */
export function assertNoTraps(value, label = 'options', seen = new Set()) {
  if (types.isProxy(value)) throw bad(`${label} 不能是 Proxy`);
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw bad(`${label} 存在循环引用`);
  seen.add(value);

  const isArr = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (isArr) {
    if (proto !== Array.prototype) throw bad(`${label} 的原型链非法`);
  } else if (proto !== Object.prototype && proto !== null) {
    throw bad(`${label} 必须是纯对象`);
  }

  let cur = value;
  while (cur && cur !== Object.prototype && cur !== Array.prototype) {
    if (types.isProxy(cur)) throw bad(`${label} 原型链上不能有 Proxy`);
    const descs = Object.getOwnPropertyDescriptors(cur);
    for (const [k, d] of Object.entries(descs)) {
      if (d.get || d.set) throw bad(`${label}.${k} 不允许使用 getter/setter`);
    }
    for (const sym of Object.getOwnPropertySymbols(cur)) {
      const d = Object.getOwnPropertyDescriptor(cur, sym);
      if (d?.get || d?.set) throw bad(`${label}[${String(sym)}] 不允许使用 getter/setter`);
    }
    cur = Object.getPrototypeOf(cur);
  }

  if (isArr) {
    const ownKeys = Object.keys( Object.getOwnPropertyDescriptors(value));
    if (ownKeys.length !== value.length + 1) {
      throw bad(`${label} 包含稀疏数组空洞或多余属性`);
    }
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw bad(`${label}[${i}] 缺失（不允许稀疏数组）`);
      assertNoTraps(value[i], `${label}[${i}]`, seen);
    }
  } else {
    const descs = Object.getOwnPropertyDescriptors(value);
    for (const [k, d] of Object.entries(descs)) {
      assertNoTraps(d.value, `${label}.${k}`, seen);
    }
  }
  seen.delete(value);
}

export function assertPlainObject(value, label = 'options') {
  if (types.isProxy(value)) throw bad(`${label} 不能是 Proxy`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bad(`${label} 必须是非空纯对象`);
  }
  assertNoTraps(value, label);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw bad(`${label} 必须是不含空字节的非空字符串`);
  }
  return value;
}

function parseFpsRatio(fps, label = 'fps') {
  if (typeof fps === 'number') {
    if (!Number.isFinite(fps) || fps <= 0) throw bad(`${label} 必须是正有限数或 "分子/分母"`);
    return { num: fps, den: 1, scalar: fps, exactRatio: Number.isSafeInteger(fps) };
  }
  if (typeof fps === 'string') {
    const { num, den } = parseFps(fps);
    if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
      throw bad(`${label} 的分子与分母必须是正安全整数：${fps}`);
    }
    const scalar = num / den;
    if (!Number.isFinite(scalar) || scalar <= 0) {
      throw bad(`${label} 比值越界：${fps}`);
    }
    return { num, den, scalar, exactRatio: true };
  }
  throw bad(`${label} 必须是正有限数或 "分子/分母"`);
}

function repoVenvCandidates(root = REPO_ROOT) {
  const binFor = (dir) => (process.platform === 'win32'
    ? join(dir, '.venv', 'Scripts', 'python.exe')
    : join(dir, '.venv', 'bin', 'python'));
  const bins = [binFor(root)];
  const dotGit = join(root, '.git');
  try {
    if (existsSync(dotGit) && statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (m) {
        const mainRoot = resolve(resolve(root, m[1].trim()), '../../..');
        bins.push(binFor(mainRoot));
      }
    }
  } catch { /* 忽略工作树指针读取异常 */ }
  return [...new Set(bins)].filter((p) => existsSync(p));
}

const probeCache = new Map();

function probeInterpreter(cmd, prefixArgs, env, requireNumpy) {
  const pathKey = env?.PATH ?? process.env.PATH ?? '';
  const cacheKey = `${cmd}\0${prefixArgs.join(' ')}\0${requireNumpy ? 'np' : 'sys'}\0${pathKey}`;
  if (probeCache.has(cacheKey)) return probeCache.get(cacheKey);
  const code = requireNumpy ? 'import sys, numpy; print(sys.executable)' : 'import sys; print(sys.executable)';
  const r = spawnSync(cmd, [...prefixArgs, '-c', code], {
    env: { ...process.env, ...(env ?? {}), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    shell: false,
    windowsHide: true,
    timeout: 15000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exe = !r.error && r.status === 0 ? (r.stdout || '').trim().split(/\r?\n/).pop() || cmd : null;
  const res = { ok: Boolean(exe), executable: exe, error: r.error, status: r.status, stderr: r.stderr || '' };
  if (res.ok) probeCache.set(cacheKey, res);
  return res;
}

/**
 * 解析可用的 Python 解释器路径（自包含，不引用 tools/**）。
 * 查找顺序：explicitPython → BEIMING_PYTHON → BEIMING_PY → PYTHON → 仓库 .venv → /opt/homebrew/bin/python3.14 → python3 → python。
 */
export function resolvePython(explicitPython) {
  let explicit;
  let customEnv;
  if (explicitPython !== undefined) {
    if (types.isProxy(explicitPython)) throw bad('python 参数不能是 Proxy');
    if (typeof explicitPython === 'string') {
      explicit = assertNonEmptyString(explicitPython, 'python');
    } else if (explicitPython !== null && typeof explicitPython === 'object' && !Array.isArray(explicitPython)) {
      assertPlainObject(explicitPython, 'resolvePython 选项');
      if (explicitPython.python !== undefined) explicit = assertNonEmptyString(explicitPython.python, 'python');
      if (explicitPython.env !== undefined) {
        assertPlainObject(explicitPython.env, 'env');
        customEnv = explicitPython.env;
      }
    } else {
      throw bad('python 参数必须是非空字符串或配置对象');
    }
  }

  const env = customEnv ? { ...process.env, ...customEnv } : process.env;

  if (explicit !== undefined) {
    const p = probeInterpreter(explicit, [], env, false);
    if (!p.ok) {
      throw new CompError('env.python-missing', `指定的 Python 解释器不可用：${explicit}`, '检查 python 路径是否存在且可执行');
    }
    return (explicit.includes('/') || explicit.includes('\\')) ? resolve(explicit) : p.executable;
  }

  for (const name of ['BEIMING_PYTHON', 'BEIMING_PY', 'PYTHON']) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.includes('\0')) {
      throw bad(`环境变量 ${name} 非法`);
    }
    const candidate = raw.trim();
    const p = probeInterpreter(candidate, [], env, false);
    if (!p.ok) {
      throw new CompError('env.python-missing', `${name}=${candidate} 指向的 Python 解释器不可用`, `设置有效的 ${name} 或取消该变量`);
    }
    return (candidate.includes('/') || candidate.includes('\\')) ? resolve(candidate) : p.executable;
  }

  const candidates = [
    ...repoVenvCandidates().map((c) => [c, []]),
    ...(existsSync('/opt/homebrew/bin/python3.14') ? [['/opt/homebrew/bin/python3.14', []]] : []),
    ...(existsSync('/opt/homebrew/bin/python3') ? [['/opt/homebrew/bin/python3', []]] : []),
    ['python3', []],
    ['python', []],
    ...(process.platform === 'win32' ? [['py', ['-3.12']], ['py', ['-3']]] : []),
  ];

  for (const requireNumpy of [true, false]) {
    for (const [cmd, prefix] of candidates) {
      const p = probeInterpreter(cmd, prefix, env, requireNumpy);
      if (p.ok) return p.executable;
    }
  }

  throw new CompError('env.python-missing', '找不到可用的 Python 解释器', '运行 npm run setup 建立 .venv 或设置 BEIMING_PYTHON');
}

function parseWavHeader(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new CompError('failure.audio-script', '声音脚本产出的文件不是有效的 RIFF WAVE');
  }
  const riffSize = buf.readUInt32LE(4);
  if (riffSize < 36 || 8 + riffSize > buf.length) {
    throw new CompError('failure.audio-script', `WAV RIFF 声明长度（${8 + riffSize}）超出文件实际字节数（${buf.length}），文件已截断`);
  }
  const riffEnd = 8 + riffSize;
  let at = 12, fmt = null, data = null, decodeEnd = riffEnd;
  while (at < riffEnd) {
    if (at + 8 > riffEnd || at + 8 > buf.length) {
      throw new CompError('failure.audio-script', 'WAV 子块头部不完整，文件已截断');
    }
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (body + size > riffEnd || body + size > buf.length) {
      throw new CompError('failure.audio-script', `WAV ${id.trim()} 数据块截断：声明 ${size} 字节，实际仅余 ${Math.min(riffEnd, buf.length) - body} 字节`);
    }
    if (id === 'fmt ') {
      if (fmt) throw new CompError('failure.audio-script', 'WAV 含重复 fmt 段');
      if (size < 16) throw new CompError('failure.audio-script', 'WAV fmt 段损坏');
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const blockAlign = buf.readUInt16LE(body + 12);
      const bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe) {
        if (size < 40) throw new CompError('failure.audio-script', 'WAV extensible fmt 段损坏');
        format = buf.readUInt16LE(body + 24);
      }
      fmt = { format, channels, sampleRate, blockAlign, bits };
    } else if (id === 'data') {
      if (!fmt) throw new CompError('failure.audio-script', 'WAV data 段不能出现在 fmt 段之前');
      if (data) throw new CompError('failure.audio-script', 'WAV 含重复 data 段');
      data = buf.subarray(body, body + size);
      decodeEnd = body + size;
    }
    at = body + size + (size & 1);
  }
  if (!fmt || !data) throw new CompError('failure.audio-script', 'WAV 缺 fmt 或 data 段');
  if (fmt.sampleRate !== SAMPLE_RATE) {
    throw new CompError('failure.audio-script', `声音脚本产出的 WAV 采样率是 ${fmt.sampleRate} Hz，要求 ${SAMPLE_RATE} Hz`);
  }
  if (fmt.channels !== 1 && fmt.channels !== 2) {
    throw new CompError('failure.audio-script', `声音脚本产出的 WAV 声道数是 ${fmt.channels}，只收 1 或 2 声道`);
  }
  const supported = (fmt.format === 1 && (fmt.bits === 16 || fmt.bits === 24 || fmt.bits === 32))
    || (fmt.format === 3 && fmt.bits === 32);
  if (!supported) {
    throw new CompError('failure.audio-script', `WAV 的样本格式不支持（格式码 ${fmt.format}，${fmt.bits} 位）`);
  }
  const frameBytes = fmt.channels * (fmt.bits / 8);
  if (fmt.blockAlign !== frameBytes) {
    throw new CompError('failure.audio-script', `WAV blockAlign (${fmt.blockAlign}) 与声道×位深 (${frameBytes}) 不符`);
  }
  if (data.length <= 0 || data.length % frameBytes !== 0) {
    throw new CompError('failure.audio-script', `WAV data 段字节数（${data.length}）不是完整采样帧（${frameBytes} 字节）的整数倍或为空`);
  }
  return { ...fmt, riffEnd, decodeEnd };
}

function makeTempFilePath(dir) {
  return join(
    dir,
    `.beiming-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * 运行事件表驱动的 Python 程序化声音脚本并核验产出的 48 kHz WAV。
 * opts:
 *   script          .py 脚本路径（必填）
 *   events          事件表对象或 JSON 文件路径（必填）
 *   outPath         输出 WAV 路径（与 workDir 二选一或同时提供）
 *   workDir         工作目录（与 outPath 二选一或同时提供）
 *   args            附加命令行参数 string[]
 *   python          显式 Python 解释器路径
 *   cwd             子进程工作目录
 *   env             附加环境变量纯对象
 *   timeoutMs       超时毫秒数（正整数，默认 600000）
 *   expectedFrames  期望视频帧数（可选，提供时核对 WAV 样本数）
 *   fps             视频帧率（"分子/分母" 或正数，提供 expectedFrames 时必填或从事件表读取）
 */
export function runAudioScript(opts) {
  assertPlainObject(opts, 'runAudioScript 选项');

  const rawScript = assertNonEmptyString(opts.script, 'script');
  if (!/\.py$/i.test(rawScript.trim())) {
    throw bad(`声音脚本必须是 .py 文件：${rawScript}`);
  }
  const scriptPath = resolve(rawScript);
  if (!existsSync(scriptPath)) throw bad(`声音脚本不存在：${rawScript}`);
  let scriptStat;
  try { scriptStat = statSync(scriptPath); } catch (err) { throw bad(`无法访问声音脚本 ${rawScript}：${err.message}`); }
  if (!scriptStat.isFile()) throw bad(`声音脚本路径不是普通文件：${rawScript}`);
  if (process.platform !== 'win32' && (scriptStat.mode & 0o444) === 0) {
    throw bad(`声音脚本无读取权限：${rawScript}`);
  }
  let scriptBytes;
  try {
    scriptBytes = readFileSync(scriptPath);
  } catch (err) {
    throw bad(`无法读取声音脚本 ${rawScript}：${err.message}`);
  }

  if (opts.events === undefined || opts.events === null) {
    throw bad('events 必须提供事件表对象或 JSON 路径');
  }

  let workDir;
  let outWavPath;
  if (opts.workDir !== undefined) {
    workDir = resolve(assertNonEmptyString(opts.workDir, 'workDir'));
  }
  if (opts.outPath !== undefined) {
    outWavPath = resolve(assertNonEmptyString(opts.outPath, 'outPath'));
    if (!workDir) workDir = dirname(outWavPath);
  } else if (workDir) {
    outWavPath = join(workDir, 'script-audio.wav');
  } else {
    throw bad('runAudioScript 需要提供 outPath 或 workDir');
  }

  const extraArgs = [];
  if (opts.args !== undefined) {
    if (!Array.isArray(opts.args)) throw bad('args 必须是字符串数组');
    assertNoTraps(opts.args, 'args');
    for (let i = 0; i < opts.args.length; i++) {
      if (!Object.hasOwn(opts.args, i)) throw bad(`args[${i}] 缺失（不允许稀疏数组）`);
      extraArgs.push(assertNonEmptyString(opts.args[i], `args[${i}]`));
    }
  }

  if (opts.python !== undefined) assertNonEmptyString(opts.python, 'python');

  let explicitCwd = null;
  if (opts.cwd !== undefined) {
    explicitCwd = resolve(assertNonEmptyString(opts.cwd, 'cwd'));
    if (!existsSync(explicitCwd) || !statSync(explicitCwd).isDirectory()) {
      throw bad(`cwd 目录不存在：${opts.cwd}`);
    }
  }

  const customEnv = {};
  if (opts.env !== undefined) {
    assertPlainObject(opts.env, 'env');
    for (const [k, v] of Object.entries(opts.env)) {
      if (k.includes('\0')) throw bad('env 键名不能含空字节');
      if (v === undefined) continue;
      if (typeof v !== 'string' || v.includes('\0')) throw bad(`env.${k} 必须是不含空字节的字符串`);
      customEnv[k] = v;
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw bad('timeoutMs 必须是有限正整数');
  }

  if (opts.expectedFrames !== undefined && opts.frames !== undefined && opts.expectedFrames !== opts.frames) {
    throw bad('expectedFrames 与 frames 不一致');
  }
  const expectedFrames = opts.expectedFrames ?? opts.frames;
  if (expectedFrames !== undefined && (!Number.isSafeInteger(expectedFrames) || expectedFrames <= 0)) {
    throw bad('expectedFrames 必须是正整数');
  }

  let explicitFps = null;
  if (opts.fps !== undefined) {
    explicitFps = parseFpsRatio(opts.fps, 'fps');
  }

  let externalEventsPath = null;
  let eventsObj;
  let eventsBytes;
  if (typeof opts.events === 'string') {
    const rawEvents = assertNonEmptyString(opts.events, 'events');
    externalEventsPath = resolve(rawEvents);
    let eventsStat;
    try { eventsStat = statSync(externalEventsPath); } catch {
      throw bad(`事件表文件不存在：${rawEvents}`);
    }
    if (!eventsStat.isFile()) {
      throw bad(`事件表路径不是普通文件：${rawEvents}`);
    }
    if (process.platform !== 'win32' && (eventsStat.mode & 0o444) === 0) {
      throw bad(`事件表文件无读取权限：${rawEvents}`);
    }
    try {
      eventsBytes = readFileSync(externalEventsPath);
      eventsObj = JSON.parse(eventsBytes.toString('utf8'));
    } catch (err) {
      throw bad(`无法解析事件表 JSON ${rawEvents}：${err.message}`);
    }
    if (eventsObj === null || typeof eventsObj !== 'object' || Array.isArray(eventsObj)) {
      throw bad(`事件表必须是 JSON 对象：${rawEvents}`);
    }
  } else if (typeof opts.events === 'object' && !Array.isArray(opts.events)) {
    assertPlainObject(opts.events, 'events');
    eventsObj = opts.events;
    let serialized;
    try {
      serialized = `${JSON.stringify(eventsObj, null, 2)}\n`;
    } catch (err) {
      throw bad(`事件表无法序列化为 JSON：${err.message}`);
    }
    eventsBytes = Buffer.from(serialized, 'utf8');
  } else {
    throw bad('events 必须是事件表纯对象或 JSON 文件路径');
  }

  const resolvedFps = explicitFps ?? (eventsObj.fps !== undefined ? parseFpsRatio(eventsObj.fps, 'events.fps') : null);
  let expectedSamples = null;
  let sampleTolerance = 0;
  if (expectedFrames !== undefined) {
    if (!resolvedFps) throw bad('指定 expectedFrames 时必须提供 fps');
    const rawExpected = (expectedFrames * SAMPLE_RATE * resolvedFps.den) / resolvedFps.num;
    if (!Number.isFinite(rawExpected) || rawExpected <= 0) {
      throw bad(`根据 expectedFrames (${expectedFrames}) 与 fps 计算出的预期样本数非法`);
    }
    expectedSamples = Math.round(rawExpected);
    if (!Number.isSafeInteger(expectedSamples) || expectedSamples <= 0) {
      throw bad(`预期样本数越界：${expectedSamples}`);
    }
    if (resolvedFps.exactRatio) {
      const exactNum = BigInt(expectedFrames) * BigInt(SAMPLE_RATE) * BigInt(resolvedFps.den);
      sampleTolerance = exactNum % BigInt(resolvedFps.num) === 0n ? 0 : 1;
    } else {
      sampleTolerance = Math.abs(rawExpected - expectedSamples) < 1e-9 ? 0 : 1;
    }
  }

  const framesForEnv = expectedFrames ?? eventsObj.frames ?? eventsObj.total_frames;
  const fpsForEnv = opts.fps ?? eventsObj.fps;

  const python = resolvePython({ python: opts.python, env: customEnv });
  const scriptSha256 = sha256(scriptBytes);
  const eventsSha256 = sha256(eventsBytes);

  const outDir = dirname(outWavPath);
  const outBase = basename(outWavPath).replace(/\.wav$/i, '') || basename(outWavPath);
  const publishedEventsPath = externalEventsPath
    ?? (outBase === 'script-audio' ? join(workDir, 'script-events.json') : join(workDir, `script-events-${outBase}.json`));
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const stagingDir = mkdtempSync(join(workDir, '.beiming-audio-script-'));
  try {
    let eventsPath = externalEventsPath;
    if (!eventsPath) {
      eventsPath = join(stagingDir, 'script-events.json');
      writeFileSync(eventsPath, eventsBytes);
    }
    const stagedOutWav = join(stagingDir, basename(outWavPath));
    const spawnArgs = [scriptPath, '--events', eventsPath, '--out', stagedOutWav, ...extraArgs];
    const recordedArgs = [
      scriptPath,
      '--events',
      publishedEventsPath,
      '--out',
      outWavPath,
      ...extraArgs,
    ];
    const childEnv = {
      ...process.env,
      ...customEnv,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
      BEIMING_EVENTS: eventsPath,
      BEIMING_AUDIO_OUT: stagedOutWav,
      ...(framesForEnv !== undefined ? { BEIMING_FRAMES: String(framesForEnv) } : {}),
      ...(fpsForEnv !== undefined ? { BEIMING_FPS: String(fpsForEnv) } : {}),
    };

    const r = spawnSync(python, spawnArgs, {
      cwd: explicitCwd ?? stagingDir,
      env: childEnv,
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderr = r.stderr ? r.stderr.toString('utf8') : '';
    if (r.error?.code === 'ETIMEDOUT') {
      throw new CompError('failure.audio-script', `声音脚本超时（超过 ${timeoutMs} 毫秒未结束，已终止）：${basename(scriptPath)}`);
    }
    if (r.error) {
      throw new CompError('env.python-missing', `无法运行 Python（${python}）：${r.error.code ?? r.error.message}`);
    }
    if (r.status !== 0) {
      const tail = stderr.trim().split('\n').slice(-5).join(' | ');
      throw new CompError('failure.audio-script', `声音脚本 ${basename(scriptPath)} 退出码 ${r.status ?? r.signal}${tail ? `：${tail}` : ''}`);
    }

    if (!existsSync(stagedOutWav) || !statSync(stagedOutWav).isFile()) {
      throw new CompError('failure.audio-script', `声音脚本 ${basename(scriptPath)} 退出码为 0 但未生成输出 WAV`);
    }

    const rawWavBytes = readFileSync(stagedOutWav);
    const fmt = parseWavHeader(rawWavBytes);
    const wavBytes = rawWavBytes.subarray(0, fmt.riffEnd);
    let wav;
    try {
      wav = readWav(wavBytes.subarray(0, fmt.decodeEnd));
    } catch (err) {
      throw new CompError('failure.audio-script', `声音脚本产出的 WAV 解析失败：${err.message}`);
    }

    const samples = wav.left.length;
    if (samples <= 0) {
      throw new CompError('failure.audio-script', '声音脚本产出的 WAV 样本数为 0');
    }
    for (let i = 0; i < samples; i++) {
      if (!Number.isFinite(wav.left[i]) || !Number.isFinite(wav.right[i])) {
        throw new CompError('failure.audio-script', `声音脚本产出的 WAV 在样本 ${i} 处含非有限值（NaN / Infinity）`);
      }
    }
    if (expectedSamples !== null && Math.abs(samples - expectedSamples) > sampleTolerance) {
      throw new CompError(
        'failure.audio-script',
        `声音脚本产出的 WAV 样本数 ${samples} 与片长预期 ${expectedSamples} 不符（帧数 ${expectedFrames}）`,
      );
    }

    let report = null;
    let reportBytesToPublish = null;
    const stagedReportPath = join(stagingDir, 'report.json');
    if (existsSync(stagedReportPath)) {
      if (!statSync(stagedReportPath).isFile()) {
        throw new CompError('failure.audio-script', '声音脚本产出的 report.json 不是普通文件');
      }
      const rawReportBytes = readFileSync(stagedReportPath);
      try {
        report = JSON.parse(rawReportBytes.toString('utf8'));
      } catch (err) {
        throw new CompError('failure.audio-script', `声音脚本产出的 report.json 解析失败：${err.message}`);
      }
      if (report && typeof report === 'object' && !Array.isArray(report)) {
        if (typeof report.file === 'string' && resolve(report.file) === resolve(stagedOutWav)) {
          report.file = outWavPath;
        }
        if (typeof report.events === 'string' && resolve(report.events) === resolve(eventsPath)) {
          report.events = publishedEventsPath;
        }
      }
      reportBytesToPublish = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    const stagedStemsDir = join(stagingDir, 'stems');
    const stagedStemEntries = [];
    if (existsSync(stagedStemsDir)) {
      if (!statSync(stagedStemsDir).isDirectory()) {
        throw new CompError('failure.audio-script', '声音脚本产出的 stems 不是目录');
      }
      const stemFiles = readdirSync(stagedStemsDir)
        .filter((f) => f.toLowerCase().endsWith('.wav'))
        .sort();
      for (const f of stemFiles) {
        const stemFile = join(stagedStemsDir, f);
        if (statSync(stemFile).isFile()) {
          stagedStemEntries.push({ name: f, bytes: readFileSync(stemFile) });
        }
      }
    }

    const targetReportPath = join(outDir, 'report.json');
    const stemsRootDir = join(outDir, 'stems');
    const targetStemsDir = join(stemsRootDir, outBase);

    // 事务性发布前先核验所有目标路径合法性（不提前改写旧 WAV，也不残留临时文件）
    if (existsSync(outWavPath) && statSync(outWavPath).isDirectory()) {
      throw new CompError('failure.audio-script', `输出 WAV 目标路径是目录：${outWavPath}`);
    }
    if (reportBytesToPublish !== null && existsSync(targetReportPath) && statSync(targetReportPath).isDirectory()) {
      throw new CompError('failure.audio-script', `伴随报告目标路径是目录：${targetReportPath}`);
    }
    if (!externalEventsPath && existsSync(publishedEventsPath) && statSync(publishedEventsPath).isDirectory()) {
      throw new CompError('failure.audio-script', `事件表目标路径是目录：${publishedEventsPath}`);
    }
    if (stagedStemEntries.length > 0) {
      if (existsSync(stemsRootDir) && !statSync(stemsRootDir).isDirectory()) {
        throw new CompError('failure.audio-script', `分轨目录路径已存在且不是目录：${stemsRootDir}`);
      }
      if (existsSync(targetStemsDir) && !statSync(targetStemsDir).isDirectory()) {
        throw new CompError('failure.audio-script', `分轨子目录路径已存在且不是目录：${targetStemsDir}`);
      }
      for (const { name } of stagedStemEntries) {
        const destStem = join(targetStemsDir, name);
        if (existsSync(destStem) && statSync(destStem).isDirectory()) {
          throw new CompError('failure.audio-script', `分轨目标文件已存在且是目录：${destStem}`);
        }
      }
    }

    const pendingRenames = [];
    const stems = [];
    try {
      if (stagedStemEntries.length > 0) {
        mkdirSync(targetStemsDir, { recursive: true });
        for (const { name, bytes } of stagedStemEntries) {
          const destStem = join(targetStemsDir, name);
          const tmpStem = makeTempFilePath(targetStemsDir);
          writeFileSync(tmpStem, bytes);
          pendingRenames.push([tmpStem, destStem]);
          stems.push(destStem);
        }
      }
      if (reportBytesToPublish !== null) {
        const tmpReport = makeTempFilePath(outDir);
        writeFileSync(tmpReport, reportBytesToPublish);
        pendingRenames.push([tmpReport, targetReportPath]);
      }
      if (!externalEventsPath) {
        const tmpEvents = makeTempFilePath(workDir);
        writeFileSync(tmpEvents, eventsBytes);
        pendingRenames.push([tmpEvents, publishedEventsPath]);
      }
      const tmpWav = makeTempFilePath(outDir);
      writeFileSync(tmpWav, wavBytes.subarray(0, fmt.riffEnd));
      pendingRenames.push([tmpWav, outWavPath]);

      for (const [tmpPath, destPath] of pendingRenames) {
        renameSync(tmpPath, destPath);
      }
    } catch (err) {
      for (const [tmpPath] of pendingRenames) {
        rmSync(tmpPath, { recursive: true, force: true });
      }
      if (err instanceof CompError) throw err;
      throw new CompError('failure.audio-script', `发布声音脚本产物失败：${err.message}`);
    }

    // 清理该输出之前遗留但本次未产出的旧伴随产物
    if (reportBytesToPublish === null) {
      try {
        if (existsSync(targetReportPath) && statSync(targetReportPath).isFile()) {
          rmSync(targetReportPath, { force: true });
        }
      } catch { /* 忽略清理异常 */ }
    }
    if (stagedStemEntries.length === 0) {
      rmSync(targetStemsDir, { recursive: true, force: true });
      try {
        if (existsSync(stemsRootDir) && statSync(stemsRootDir).isDirectory() && readdirSync(stemsRootDir).length === 0) {
          rmSync(stemsRootDir, { recursive: true, force: true });
        }
      } catch { /* 忽略并发目录非空 */ }
    } else {
      const keepNames = new Set(stagedStemEntries.map((e) => e.name));
      try {
        for (const existing of readdirSync(targetStemsDir)) {
          if (!keepNames.has(existing)) {
            rmSync(join(targetStemsDir, existing), { recursive: true, force: true });
          }
        }
      } catch { /* 忽略清理异常 */ }
    }

    return {
      path: outWavPath,
      sha256: sha256(wavBytes),
      bytes: wavBytes.length,
      sampleRate: SAMPLE_RATE,
      channels: fmt.channels,
      samples,
      durationSec: samples / SAMPLE_RATE,
      wav,
      report,
      stems,
      python,
      scriptSha256,
      eventsSha256,
      args: recordedArgs,
    };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
