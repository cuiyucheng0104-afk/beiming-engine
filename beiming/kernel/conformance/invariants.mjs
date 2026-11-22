// 历史回归守卫只检查传入的观测，不读工作树，也不启动渲染器。
import { createHash } from 'node:crypto';
import { scanText } from './scan.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const text = (x) => typeof x === 'string' && x.trim().length > 0;
const digest = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const record = (x) => x !== null && typeof x === 'object' && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const nat = (x) => Number.isSafeInteger(x) && x >= 0;
const posInt = (x) => nat(x) && x > 0;
const finite = Number.isFinite;
const unit = (x) => finite(x) && x >= 0 && x <= 1;
function need(condition, reason) { if (!condition) throw new Error(reason); }
function list(x, name, min = 1) {
  need(Array.isArray(x) && x.length >= min, `${name}: 需要至少有 ${min} 项的数组`);
  for (let i = 0; i < x.length; i++) need(Object.hasOwn(x, i), `${name}[${i}]: 缺少观测`);
  return x;
}
function rate(fps) {
  need(typeof fps === 'string' && /^[1-9]\d*\/[1-9]\d*$/.test(fps), 'fps: 需要正有理数，如 24000/1001');
  const parts = fps.split('/').map(Number);
  need(parts.every(posInt), 'fps: 分子与分母必须是安全整数');
  return parts;
}

function frameOrders({ sequential, shuffled, single }) {
  const reference = new Map();
  let last = -1;
  for (const r of list(sequential, 'sequential', 2)) {
    need(record(r) && nat(r.frame) && r.frame > last && digest(r.digest), 'sequential: 需要按递增帧号记录 SHA-256 摘要');
    reference.set(r.frame, r.digest);
    last = r.frame;
  }
  for (const [name, rows] of Object.entries({ shuffled, single })) {
    list(rows, name);
    const seen = new Set();
    for (const r of rows) {
      need(record(r) && nat(r.frame) && digest(r.digest), `${name}: 帧号或摘要无效`);
      need(!seen.has(r.frame) && reference.get(r.frame) === r.digest, `${name}: 帧 ${r.frame} 重复、未请求或与顺序渲染的摘要不同`);
      seen.add(r.frame);
    }
    need(seen.size === reference.size, `${name}: 未覆盖顺序渲染中的全部帧`);
  }
  need(shuffled.some((r, i) => r.frame !== sequential[i].frame), 'shuffled: 没有真正改变帧顺序');
}
function frameFixture() {
  const observe = (frame) => ({ frame, digest: sha(`sample:${frame}`) });
  return { sequential: [0, 1, 2].map(observe), shuffled: [2, 0, 1].map(observe), single: [0, 1, 2].map(observe) };
}

// 遮住注释与普通字符串。保留方括号里的属性名和模板插值里的代码，再交给同一个扫描器。
function codeForScan(source) {
  let i = 0;
  function quoted(q) {
    const start = i++;
    let expressions = '';
    while (i < source.length) {
      const c = source[i++];
      if (c === '\\') i++;
      else if (c === q) {
        const raw = source.slice(start, i);
        return /^(['"`])[\w$]+\1$/.test(raw) ? raw : ` "" ${expressions} `;
      } else if (q === '`' && c === '$' && source[i] === '{') { i++; expressions += ` ${code(true)} `; }
    }
    throw new Error('源码字符串未闭合');
  }
  function code(interpolation = false) {
    let out = '', depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (source.startsWith('//', i) || (c === '#' && !/[\w.$]/.test(source[i - 1] ?? ''))) {
        while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
        out += ' ';
      } else if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        need(end !== -1, '源码注释未闭合'); i = end + 2; out += ' ';
      } else if ('\'"`'.includes(c)) out += quoted(c);
      else {
        i++;
        if (interpolation && c === '}' && depth === 0) return out;
        if (c === '{') depth++;
        if (c === '}') depth--;
        out += c;
      }
    }
    need(!interpolation, '模板插值未闭合');
    return out;
  }
  return code();
}
function seeded({ source, seed }) {
  need(nat(seed) && text(source), '需要显式整数种子和非空渲染源码');
  const code = codeForScan(source);
  need(text(code), '没有可扫描的渲染代码');
  const hit = scanText(code).find(({ kind }) => kind === 'unseededRandom');
  need(!hit, `渲染源码使用未播种随机源：${hit?.call}`);
  // 宿主随机 API 由 scanText 判；另查直接调用的无参随机函数与模块级随机函数。
  need(!/(?<![\w$.])random\s*(?:\(\s*\)|\.\s*(?:random|randint|randrange|uniform|choice|shuffle)\s*\()/.test(code), '直接调用了没有显式种子的随机函数');
}
function integerFrames({ fps, frames, shots, events }) {
  rate(fps);
  need(posInt(frames), 'frames: 总帧数必须是正整数');
  let end = 0;
  for (const shot of list(shots, 'shots')) {
    need(record(shot) && nat(shot.in) && posInt(shot.out) && shot.in === end && shot.out > shot.in, `shots: 本镜头必须从第 ${end} 帧开始，且结束帧不包含在内`);
    end = shot.out;
  }
  need(end === frames, '末镜头的结束位置必须等于总帧数');
  for (const f of list(events, 'events', 0)) need(nat(f) && f < frames, 'event: 事件帧号必须是片内整数');
}
const tags = { color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', color_range: 'tv' };
function colorTags(stream) {
  for (const [key, value] of Object.entries(tags)) need(stream[key] === value, `${key} 应为 ${value}`);
}
function loudness({ inputLufs, linearGain, outputLufs, truePeakDbtp }) {
  need([inputLufs, linearGain, outputLufs, truePeakDbtp].every(finite) && linearGain > 0, '需要实测 LUFS、dBTP 以及大于零的线性增益');
  const predicted = inputLufs + 20 * Math.log10(linearGain);
  need(Math.abs(predicted - outputLufs) <= 0.100001, '输出实测响度与应用整段增益后相差超过 0.1 LU');
  need(outputLufs >= -15 && outputLufs <= -13, '母带实测响度不在 [-15, -13] LUFS 内');
  need(truePeakDbtp <= -1, '母带实测真峰值超过 -1 dBTP');
}
function tailFrame({ fps, targetFrames, sampleRate, audioSamples, deliveredFrames, lastFrame }) {
  const [n, d] = rate(fps);
  need(posInt(targetFrames) && posInt(sampleRate) && nat(audioSamples), '需要目标帧数、采样率和音频样本数');
  need(BigInt(audioSamples) * BigInt(n) < BigInt(targetFrames) * BigInt(d) * BigInt(sampleRate), '音频没有短于画面，未覆盖短音轨情形');
  need(deliveredFrames === targetFrames && lastFrame === targetFrames - 1, '解码画面的帧数或末帧不符');
}
function cleanup({ timeoutMs, elapsedMs, exitCode, remainingChildren, partialOutputs }) {
  need(finite(timeoutMs) && timeoutMs > 0 && finite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= timeoutMs, '失败进程没有在超时前退出');
  need(posInt(exitCode) && exitCode <= 255, '失败进程应以非零退出码返回');
  need(list(remainingChildren, 'remainingChildren', 0).length === 0, '失败后有子进程存活');
  need(list(partialOutputs, 'partialOutputs', 0).length === 0, '失败后仍有半截产物');
}

const cacheAxes = ['runtimeBuild', 'gpuBackend', 'sourceHash'];
function cacheKey({ runs }) {
  list(runs, 'runs', 5);
  const byInput = new Map(), byKey = new Map(), changed = new Set();
  let repeated = false;
  for (const r of runs) {
    need(record(r) && text(r.runtimeBuild) && text(r.gpuBackend) && digest(r.sourceHash) && digest(r.key), '缓存探针缺运行时、后端、源码摘要或缓存键');
    const input = JSON.stringify(cacheAxes.map((axis) => r[axis]));
    need(!byKey.has(r.key) || byKey.get(r.key) === input, '输入变化却复用旧缓存键');
    need(!byInput.has(input) || byInput.get(input) === r.key, '相同输入得到不同缓存键');
    if (byInput.has(input)) repeated = true;
    byInput.set(input, r.key);
    byKey.set(r.key, input);
    const diff = cacheAxes.filter((axis) => r[axis] !== runs[0][axis]);
    if (diff.length === 1) changed.add(diff[0]);
  }
  need(repeated && changed.size === cacheAxes.length, '需要完全相同输入的复跑，以及分别只改变一个缓存输入的观测');
}
function cacheFixture() {
  const base = ['runtime-1', 'metal', sha('source one')];
  return { runs: [base, base, ['runtime-2', base[1], base[2]], [base[0], 'vulkan', base[2]], [base[0], base[1], sha('source two')]]
    .map(([runtimeBuild, gpuBackend, sourceHash]) => ({ runtimeBuild, gpuBackend, sourceHash, key: sha(JSON.stringify([runtimeBuild, gpuBackend, sourceHash])) })) };
}

const lengths = ['grainPx', 'outlinePx', 'haloPx'];
function scaledStyle({ samples }) {
  list(samples, 'samples', 2);
  const heights = new Set();
  for (const s of samples) {
    need(record(s) && posInt(s.width) && posInt(s.height), '风格观测的目标画幅无效');
    heights.add(s.height);
    const base = samples[0], scale = s.height / base.height;
    need(Math.abs(s.width / base.width - scale) < 1e-9, '风格探针应比较同一宽高比的不同分辨率');
    for (const key of lengths) {
      need(finite(s[key]) && s[key] > 0 && Math.abs(s[key] - base[key] * scale) < 1e-6, `${key}: 像素长度未按目标画幅比例缩放`);
    }
  }
  need(heights.size >= 2, '风格探针至少需要两个不同分辨率');
}
function glyphs({ drawnText, notdefDigest, probe }) {
  need(text(drawnText) && digest(notdefDigest), '需要实测文字与探针缺字位图摘要');
  const chars = [...drawnText];
  need(list(probe, 'probe').length === chars.length, '实测字形数与文本码点数不符');
  probe.forEach((r, i) => {
    need(record(r) && r.codePoint === chars[i].codePointAt(0), `字形 ${i} 的码点不符`);
    need(posInt(r.glyphIndex) && digest(r.bitmapDigest) && r.bitmapDigest !== notdefDigest, `字符 ${chars[i]} 缺字或与回退字形的位图相同`);
  });
}
function multiband({ lowPower, highPower, detectedWindow }) {
  list(lowPower, 'lowPower', 2);
  need(list(highPower, 'highPower').length === lowPower.length, '各频带的时间窗数不一致');
  need([...lowPower, ...highPower].every((p) => finite(p) && p >= 0), '频带功率必须是非负有限数');
  const rise = 10 ** (8 / 10); // 功率比用 10 的对数，不用振幅的 20。
  const onset = highPower.findIndex((p, i) => i > 0 && p > 0 && p >= highPower[i - 1] * rise);
  need(onset > 0, '探针中未检出高频起音');
  const i = onset;
  need(lowPower[i] > highPower[i] && (lowPower[i] + highPower[i]) / (lowPower[i - 1] + highPower[i - 1]) < rise, '探针的全频信号没有掩蔽高频提示音');
  need(detectedWindow === onset, `实测高频起音在第 ${onset} 个时间窗，与检测报告不符`);
}
function readableText({ caption, fps, alpha, foregroundY, backgroundY, width, height, box }) {
  const [n, d] = rate(fps);
  need(text(caption) && list(alpha, 'alpha').every(unit), '需要非空文字及 [0,1] 内的逐帧不透明度');
  const peak = alpha.reduce((a, b) => Math.max(a, b), 0);
  need(peak > 0, '文字全程不可见');
  // 每个汉字算一单位；其余字母或数字按连续串计数。
  const units = (caption.match(/\p{Script=Han}/gu) ?? []).length + (caption.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length;
  need(units > 0, '文字没有可计数的阅读单位');
  let run = 0, longest = 0;
  for (const a of alpha) { run = a >= 0.9 * peak ? run + 1 : 0; longest = Math.max(longest, run); }
  const minFrames = Math.ceil(Math.max(80, 12 * units) * n / (100 * d));
  need(longest >= minFrames, `文字完全可见只有连续 ${longest} 帧，需要 ${minFrames} 帧`);
  need(unit(foregroundY) && unit(backgroundY), '前景与背景的实测相对亮度必须在 [0,1] 内');
  const ratio = (Math.max(foregroundY, backgroundY) + 0.05) / (Math.min(foregroundY, backgroundY) + 0.05);
  need(ratio >= 3, `文字对比度 ${ratio.toFixed(2)}:1 低于 3:1`);
  need(posInt(width) && posInt(height) && list(box, 'box').length === 4 && box.every(finite), '需要画幅尺寸与实测文字框 [x,y,width,height]');
  const [x, y, w, h] = box, portrait = height > width;
  need(w > 0 && h > 0 && x >= width * (portrait ? 0.06 : 0.05) && x + w <= width * (portrait ? 0.88 : 0.95) &&
    y >= height * (portrait ? 0.08 : 0.05) && y + h <= height * (portrait ? 0.82 : 0.95), '文字框超出安全区');
}

function baseline({ baselineMachine, baselinePlatform, baselinePath, approvedReferencePath, runs }) {
  need(text(baselineMachine) && text(baselinePlatform) && /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(baselinePlatform), '需要基线机器标识与系统-后端平台键');
  need(baselinePath === `tests/golden/${baselinePlatform}/manifest.json`, '回归基线未按平台键分开存放');
  need(text(approvedReferencePath) && /^docs\/style-baselines\/[\w-]+@v\d+\/[\w-]+\.json$/.test(approvedReferencePath), '认可参照不得与回归基线混放');
  const tiers = new Set();
  for (const r of list(runs, 'runs', 2)) {
    need(record(r) && text(r.machine) && text(r.platform) && /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(r.platform), '实测记录缺少机器或平台键');
    const same = r.machine === baselineMachine && r.platform === baselinePlatform;
    const tier = same ? 'hash-same-machine' : 'tolerance';
    need(r.tier === tier, `${r.machine}/${r.platform} 应使用 ${tier} 档`);
    tiers.add(tier);
    if (same) need(digest(r.baselineHash) && r.actualHash === r.baselineHash, '同机回归的像素摘要不一致');
    // 跨平台门限采用 core / templates 集合标定的 SSIM、PSNR 与差异占比。
    else need(unit(r.ssim) && r.ssim >= 0.985 && finite(r.psnrDb) && r.psnrDb >= 40 && unit(r.fracAbove2) && r.fracAbove2 <= 0.05, '跨平台实测超出 core 集合容差');
  }
  need(tiers.size === 2, '必须同时覆盖同机哈希档与跨机容差档');
}

const exitCodes = new Map(Object.entries({ failure: 1, usage: 2, env: 3, contract: 4, busy: 5, timeout: 124 }));
const dottedCode = (s) => text(s) && /^[a-z]+\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(s) && exitCodes.has(s.split('.')[0]);
function envelope(e, name) {
  need(record(e) && e.format === 'envelope/0.1', `${name}: 需要 envelope/0.1 信封`);
  need(nat(e.exitCode) && e.ok === (e.exitCode === 0), `${name}: ok 与 exitCode 不一致`);
  if (e.ok) need(e.error === null, `${name}: 成功信封必须写 error: null`);
  else {
    need(record(e.error) && dottedCode(e.error.code) && text(e.error.message), `${name}: 错误码无效或缺少错误消息`);
    const prefix = e.error.code.split('.')[0];
    need(e.exitCode === exitCodes.get(prefix), `${name}: 前缀 ${prefix}. 要求退出码 ${exitCodes.get(prefix)}`);
    need(!Object.hasOwn(e.error, 'hint') || text(e.error.hint), `${name}: 错误提示格式无效`);
  }
  need(record(e.data), `${name}: data 必须是对象`);
  need(record(e.cost) && nat(e.cost.tokens) && [e.cost.gpuSeconds, e.cost.wallMs].every((v) => finite(v) && v >= 0), `${name}: token 数、GPU 秒数或墙钟毫秒数无效`);
  for (const o of list(e.outputs, `${name}.outputs`, 0)) need(record(o) && text(o.kind) && text(o.url) && (!Object.hasOwn(o, 'sha256') || digest(o.sha256)), `${name}: 产物引用无效`);
  for (const d of list(e.diagnostics, `${name}.diagnostics`, 0)) need(record(d) && dottedCode(d.code) && text(d.message), `${name}: 诊断记录无效`);
  for (const a of list(e.next, `${name}.next`, 0)) need(record(a) && text(a.verb) && text(a.why), `${name}: 下一步动作无效`);
}
function uniformEnvelope({ cli, http, processExitCode }) {
  envelope(cli, 'cli');
  envelope(http, 'http');
  need(processExitCode === cli.exitCode, '进程退出码与 CLI 信封不符');
  need(cli.exitCode === http.exitCode && cli.error?.code === http.error?.code, '同一操作在 CLI 与 HTTP 返回不同结果');
}
function envelopeFixture() {
  const e = { format: 'envelope/0.1', ok: false, exitCode: 4, error: { code: 'contract.unknown-key', message: '未知字段' },
    outputs: [], diagnostics: [], data: {}, cost: { tokens: 0, gpuSeconds: 0, wallMs: 1 }, next: [] };
  return { cli: e, http: globalThis.structuredClone(e), processExitCode: 4 };
}
function statusEvidence({ generated, technicalPassed, userApproved, artifactHash, qa, review }) {
  need([generated, technicalPassed, userApproved].every((v) => typeof v === 'boolean'), '需要生成、技检和认可三个独立布尔值');
  need((artifactHash === null || digest(artifactHash)) && generated === (artifactHash !== null), '生成状态与产物证据不符');
  if (qa !== null) need(record(qa) && generated && qa.artifactHash === artifactHash && nat(qa.exitCode), '机器 QA 没有有效检查这份产物');
  need(technicalPassed === (qa !== null && qa.exitCode === 0), '机器 QA 不支持所报技术状态');
  if (review !== null) {
    need(record(review) && generated && review.artifactHash === artifactHash && review.role === 'user' && text(review.reviewer) &&
      !/(?:agent|claude|codex|chatgpt|bot\d*$|代理|机器人)/iu.test(review.reviewer) && text(review.quote) && text(review.source) &&
      ['approved', 'rejected'].includes(review.decision), '该版本的认可须有用户身份、原话和出处，代理不可自批');
  }
  need(userApproved === (review?.decision === 'approved'), '不能从产物或机器 QA 推断用户认可');
}
const relativeFile = (s) => text(s) && !/[\\:*?[\]\p{Cc}]/u.test(s) && !s.startsWith('-') && s.split('/').every((p) => p && p !== '.' && p !== '..' && p !== '.git');
function staging({ addArgs, staged, renderedHashes }) {
  list(addArgs, 'addArgs');
  need(list(renderedHashes, 'renderedHashes', 0).every(digest), '渲染产物清单必须使用 SHA-256 摘要');
  const outputs = new Set(renderedHashes);
  const paths = addArgs[0] === '--' ? addArgs.slice(1) : addArgs;
  need(paths.length > 0 && paths.every(relativeFile), 'git add 必须按相对文件名暂存，不接受选项、目录或模式');
  const remaining = new Set(paths);
  for (const f of list(staged, 'staged')) {
    need(record(f) && relativeFile(f.path) && remaining.delete(f.path), '条目未显式点名或已重复暂存');
    need(nat(f.bytes) && f.bytes <= 5 * 1024 * 1024, `${f.path}: 文件大小缺失或超过 5 MiB`);
    // D10 禁渲染产物，不禁后缀：从交付清单按内容识别改名、移出 out 的产物。
    need(digest(f.sha256) && f.kind === 'source' && !outputs.has(f.sha256) && !/^(?:out\/|films\/[^/]+\/out\/)/.test(f.path), `${f.path}: 暂存文件缺少摘要、属于输出目录或命中渲染产物清单`);
  }
  need(remaining.size === 0, '指定文件与实际暂存清单不一致');
}
function history({ isShallow, requiredCommits, resolvedCommits }) {
  need(isShallow === false, '基线溯源需要完整 Git 历史，拒绝浅克隆或未知状态');
  const oid = (s) => typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
  need(list(resolvedCommits, 'resolvedCommits').every(oid) && list(requiredCommits, 'requiredCommits').every(oid), '需要基线引用与 Git 解析得到的完整提交标识');
  const found = new Set(resolvedCommits);
  for (const commit of requiredCommits) need(found.has(commit), `基线提交 ${commit} 未能解析`);
}

// 每次创建独立夹具，负例只改变一项观测。
const definitions = [
  ['stateless-frame-eval', '顺序、乱序与隔离求值的逐帧摘要一致', frameOrders, frameFixture, (x) => { x.single[1].digest = sha('previous frame leaked'); }],
  ['seeded-rng-only', '渲染路径只使用显式播种的随机源', seeded, () => ({ seed: 23, source: 'const grain = ctx.rng("grain"); grain();' }), (x) => { x.source += ' Math.' + 'random();'; }],
  ['integer-frame-timebase', '以有理帧率和连续的整数帧区间为时间源', integerFrames, () => ({ fps: '24000/1001', frames: 48, shots: [{ in: 0, out: 24 }, { in: 24, out: 48 }], events: [0, 24, 47] }), (x) => { x.shots[1].in++; }],
  ['bt709-tv-color-tags', '交付流的四项标签完整声明有限范围 BT.709', colorTags, () => ({ ...tags }), (x) => { x.color_range = 'pc'; }],
  ['measured-loudness-gain', '实测响度符合整段线性增益，母带响度与真峰值均达标', loudness, () => ({ inputLufs: -20, linearGain: 10 ** (6 / 20), outputLufs: -14, truePeakDbtp: -1.5 }), (x) => { x.linearGain = 1; }],
  ['preserve-tail-frame-short-audio', '短音轨封装不吞画面末帧', tailFrame, () => ({ fps: '24/1', targetFrames: 24, audioSamples: 46000, sampleRate: 48000, deliveredFrames: 24, lastFrame: 23 }), (x) => { x.deliveredFrames--; }],
  ['bounded-failure-cleanup', '失败在超时前非零退出且清理子进程和半截产物', cleanup, () => ({ timeoutMs: 5000, elapsedMs: 65, exitCode: 1, remainingChildren: [], partialOutputs: [] }), (x) => { x.partialOutputs.push('frame.partial'); }],
  ['content-addressed-cache-key', '缓存键覆盖运行时构建、显卡后端与源码摘要', cacheKey, cacheFixture, (x) => { x.runs[4].key = x.runs[0].key; }],
  ['resolution-scaled-stylization', '颗粒、轮廓与光晕的像素尺度随分辨率变化', scaledStyle, () => ({ samples: [{ width: 1920, height: 1080, grainPx: 1, outlinePx: 2, haloPx: 8 }, { width: 3840, height: 2160, grainPx: 2, outlinePx: 4, haloPx: 16 }] }), (x) => { x.samples[1].haloPx = 8; }],
  ['probe-font-missing-glyph', '逐字检查探针读回的字形和缺字位图', glyphs, () => ({ drawnText: '甲乙', notdefDigest: sha('probe tofu'), probe: [...'甲乙'].map((c, i) => ({ codePoint: c.codePointAt(0), glyphIndex: i + 1, bitmapDigest: sha(`ink:${c}`) })) }), (x) => { x.probe[1].bitmapDigest = x.notdefDigest; }],
  ['multiband-onset-detection', '分频带检测低频铺底下的高频提示音起音', multiband, () => ({ lowPower: [10, 10, 10, 10], highPower: [0.01, 0.01, 0.16, 0.15], detectedWindow: 2 }), (x) => { x.detectedWindow = -1; }],
  ['text-dwell-contrast-bounds', '文字满足停留时长、对比度和安全区要求', readableText, () => ({ caption: '下一站', fps: '24/1', alpha: Array(20).fill(1), foregroundY: 0.8, backgroundY: 0.05, width: 1920, height: 1080, box: [200, 100, 600, 90] }), (x) => { x.alpha[10] = 0; }],
  ['platform-tiered-baseline-split', '同机比哈希、跨机比容差；认可参照与回归基线分开', baseline, () => ({ baselineMachine: 'station-a', baselinePlatform: 'darwin-metal', baselinePath: 'tests/golden/darwin-metal/manifest.json', approvedReferencePath: 'docs/style-baselines/original@v1/darwin-metal.json', runs: [
    { machine: 'station-a', platform: 'darwin-metal', tier: 'hash-same-machine', baselineHash: sha('pixels'), actualHash: sha('pixels') },
    { machine: 'station-b', platform: 'win-vulkan', tier: 'tolerance', ssim: 0.99, psnrDb: 45, fracAbove2: 0.01 }] }), (x) => { x.approvedReferencePath = x.baselinePath; }],
  ['uniform-envelope-exit-codes', 'CLI 与 HTTP 使用同一信封，错误码前缀决定退出码', uniformEnvelope, envelopeFixture, (x) => { x.http.exitCode = 2; }],
  ['three-way-status-separation', '已生成、技检通过、用户认可各有独立证据', statusEvidence, () => ({ generated: true, technicalPassed: true, userApproved: false, artifactHash: sha('artifact'), qa: { artifactHash: sha('artifact'), exitCode: 0 }, review: null }), (x) => { x.userApproved = true; }],
  ['explicit-staging-no-media-commit', '显式按文件名暂存，拒绝渲染产物和超限文件', staging, () => ({ addArgs: ['--', 'film/shot.mjs'], staged: [{ path: 'film/shot.mjs', bytes: 360, kind: 'source', sha256: sha('source file') }], renderedHashes: [sha('rendered frame')] }), (x) => { x.addArgs = ['-A']; }],
  ['full-git-history-required', '完整历史能解析基线所引用的源提交', history, () => ({ isShallow: false, requiredCommits: ['a'.repeat(40)], resolvedCommits: ['a'.repeat(40), 'b'.repeat(40)] }), (x) => { x.isShallow = true; }],
];
export const INVARIANTS = Object.freeze(definitions.map(([slug, title], i) => Object.freeze({ id: `INV-${String(i + 1).padStart(2, '0')}`, slug, title })));
const byId = new Map(INVARIANTS.map(({ id }, i) => [id, definitions[i]]));
function definition(id) { need(byId.has(id), '未知的不变量编号'); return byId.get(id); }
export function makeValidInvariantFixture(id) { return definition(id)[3](); }
export function makeViolatingInvariantFixture(id) {
  const fixture = makeValidInvariantFixture(id);
  definition(id)[4](fixture);
  return fixture;
}
export function checkInvariant(id, fixture) {
  try {
    const [, , check] = definition(id);
    need(record(fixture), '需要一个观测对象');
    check(fixture);
    return { id, ok: true };
  } catch (error) { return { id, ok: false, reason: error.message }; }
}
export function runInvariantSuite(cases) {
  const rows = Array.isArray(cases) && cases.length
    ? Array.from(cases, (c) => checkInvariant(c?.id, c?.fixture))
    : [{ id: null, ok: false, reason: '至少需要一个不变量用例' }];
  const failed = rows.filter((r) => !r.ok).length;
  return { ok: failed === 0, passed: rows.length - failed, failed, rows };
}
