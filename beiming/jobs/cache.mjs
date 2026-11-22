// 内容寻址帧缓存（A16）：一帧的键由设计文档「缓存键」的六项哈希在一起；容差档混用旧帧与新帧后查接缝尖峰。
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isPlainObject } from './ledger.mjs';
import { atomicWrite, makeDirectory, retrySharing, safePath } from './workspace.mjs';

const FORMAT = 'frame-cache/0.2';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000; // 毫秒
const SEAM_BINS = 64;
const TIERS = ['draft', 'final'];
const DETERMINISM = ['hash-same-machine', 'tolerance'];
const SPEC_KEYS = ['shot', 'events', 'film', 'loadedFiles', 'tracksHash', 'cards', 'runtimeEnv', 'renderSpec'];
const ENV_KEYS = ['source', 'runtimeVersion', 'browserBuild', 'gpuBackend', 'driver'];
const RENDER_KEYS = ['tier', 'samples', 'size', 'frame', 'subs'];

const sha256 = data => createHash('sha256').update(data).digest('hex');
const digest = value => `sha256:${sha256(canonicalJson(value))}`;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const isHex = value => matches(/^[a-f0-9]{64}$/, value);
const isDigest = value => matches(/^sha256:[a-f0-9]{64}$/, value);
const isShotId = value => matches(/^[a-z][a-z0-9-]*$/, value);
const isCount = value => Number.isSafeInteger(value) && value > 0;
const hasExactly = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const isUnique = values => new Set(values).size === values.length;
const sortedSubs = subs => [...subs].sort((a, b) => a - b || Number(Object.is(b, -0)) - Number(Object.is(a, -0)));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function need(ok, message) {
  if (!ok) throw new TypeError(message);
}

// 键序无关的规范化 JSON。写不成确定 JSON 的值（NaN、undefined、Map、循环引用）直接拒收，不让它们悄悄变成 null 或 {} 去撞键。
export function canonicalJson(value) {
  const open = new Set();
  function walk(node, at) {
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return JSON.stringify(node);
    if (typeof node === 'number') {
      need(Number.isFinite(node), `${at} 不是有限数。`);
      return Object.is(node, -0) ? '-0' : JSON.stringify(node);
    }
    need(Array.isArray(node) || isPlainObject(node), `${at} 不是 JSON 值。`);
    need(!open.has(node), `${at} 出现循环引用。`);
    open.add(node);
    const text = Array.isArray(node)
      ? `[${Array.from(node, (item, index) => walk(item, `${at}[${index}]`)).join(',')}]`
      : `{${Object.keys(node).sort().map(key => `${JSON.stringify(key)}:${walk(node[key], `${at}.${key}`)}`).join(',')}}`;
    open.delete(node);
    return text;
  }
  return walk(value, '$');
}

// 六项缺一不可：没有轨道写 'none'，没有卡写 []，环境里不适用的项写 'none'。
export function computeFrameCacheKey(spec) {
  need(isPlainObject(spec) && Object.keys(spec).every(key => SPEC_KEYS.includes(key)), `缓存键输入只能有 ${SPEC_KEYS.join('、')}。`);
  const { shot, events = null, film = null, loadedFiles, tracksHash, cards, runtimeEnv, renderSpec } = spec;
  need(film === null || isPlainObject(film), 'film 必须是本镜头使用的片级参数对象。');

  need(isPlainObject(shot) && isShotId(shot.id), '第 1 项 shot 必须是带合法 id 的镜头条目。');
  const { in: start, out: end, ...entry } = shot;
  need(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start, '第 1 项 shot 的 in、out 必须是整数帧，out 大于 in。');
  // 交给镜头代码和卡的只有镜头局部帧号，所以进键的是帧数而不是全片位置：前面的镜头改长，这个镜头照样命中。
  const frames = end - start;

  need(Array.isArray(loadedFiles) && loadedFiles.every(file => isPlainObject(file) && isHex(file.sha256) &&
    typeof file.path === 'string' && file.path !== '' && !/^\/|\\|(^|\/)\.\.?(\/|$)/.test(file.path)) &&
    isUnique(loadedFiles.map(file => file.path)), '第 2 项 loadedFiles 必须是不重复的 { path: 相对路径, sha256 } 列表。');
  need(tracksHash === 'none' || isDigest(tracksHash), "第 3 项 tracksHash 必须是 'sha256:…'，没有轨道写 'none'。");
  need(Array.isArray(cards) && cards.every(card => isPlainObject(card) && typeof card.id === 'string' && card.id !== '' &&
    matches(/^\d+\.\d+\.\d+$/, card.version) && isHex(card.sha256)) &&
    isUnique(cards.map(card => card.id)), '第 4 项 cards 必须是不重复的 { id, version: 三段版本, sha256 } 列表。');
  need(hasExactly(runtimeEnv, ENV_KEYS) && ENV_KEYS.every(key => typeof runtimeEnv[key] === 'string' && runtimeEnv[key] !== ''),
    `第 5 项 runtimeEnv 必须正好有 ${ENV_KEYS.join('、')} 五个非空字符串。`);
  need(hasExactly(renderSpec, RENDER_KEYS), `第 6 项 renderSpec 必须正好有 ${RENDER_KEYS.join('、')}。`);
  const { tier, samples, size, frame, subs } = renderSpec;
  need(TIERS.includes(tier) && isCount(samples) && Array.isArray(size) && size.length === 2 && size.every(isCount) &&
    Array.isArray(subs) && subs.length > 0 && subs.every(Number.isFinite), '第 6 项 renderSpec 的档位、采样数、尺寸或 sub 采样集无效。');
  need(Number.isSafeInteger(frame) && frame >= 0 && frame < frames, '第 6 项 renderSpec.frame 必须是落在镜头内的局部帧号。');

  const picture = { tier, samples, size, subs: sortedSubs(subs) };
  const components = {
    shot: digest({ entry, frames, events, film }),
    loadedFiles: digest(loadedFiles.map(file => ({ path: file.path, sha256: file.sha256 })).sort((a, b) => byText(a.path, b.path))),
    tracks: tracksHash,
    cards: digest(cards.map(card => ({ id: card.id, version: card.version, sha256: card.sha256 })).sort((a, b) => byText(a.id, b.id))),
    runtimeEnv: digest(runtimeEnv),
    renderSpec: digest({ ...picture, frame }),
  };
  return {
    key: digest({ format: FORMAT, ...components }),
    // 除帧号外都相同的帧属于镜头的同一版，清理时按版取舍
    shotKey: digest({ format: FORMAT, ...components, renderSpec: digest(picture) }),
    shotId: shot.id,
    tier,
    components,
  };
}

// 把一帧压成最多 64 段的均值，随条目存下：命中旧帧时不用解码颜色层就能比相邻帧。
function seamSignature(values) {
  need((ArrayBuffer.isView(values) || Array.isArray(values)) && values.length > 0, 'colorFloats 必须是非空的数值数组。');
  const scale = values instanceof Uint8Array || values instanceof Uint8ClampedArray ? 1 / 255 : 1;
  const bins = Math.min(SEAM_BINS, values.length);
  const signature = [];
  for (let bin = 0; bin < bins; bin += 1) {
    const from = Math.floor(bin * values.length / bins);
    const to = Math.floor((bin + 1) * values.length / bins);
    let sum = 0;
    for (let index = from; index < to; index += 1) sum += values[index];
    if (!Number.isFinite(sum)) return undefined;
    signature.push(sum * scale / (to - from));
  }
  return signature;
}

export function openShotCache(cacheDir) {
  const lstat = file => fs.lstatSync(file, { throwIfNoEntry: false });
  const requested = path.resolve(cacheDir);
  need(!lstat(requested)?.isSymbolicLink(), '缓存根目录不得是符号链接。');
  const root = makeDirectory(requested);
  const checkRoot = () => need(lstat(root)?.isDirectory(), '缓存根目录消失或被替换为符号链接。');

  // 缓存有独立的目录布局；只在已验证的父目录下清理占错位置的节点，不沿链接递归。
  function child(parent, name, directory) {
    const file = path.join(parent, name);
    const stat = lstat(file);
    if (stat && !(directory ? stat.isDirectory() : stat.isFile())) {
      fs.rmSync(file, { force: true, recursive: stat.isDirectory() });
    }
    return safePath(parent, name);
  }

  function fileOf(entry) {
    checkRoot();
    need(isPlainObject(entry) && isDigest(entry.key) && isDigest(entry.shotKey) && isShotId(entry.shotId) && TIERS.includes(entry.tier),
      '缓存条目必须是 computeFrameCacheKey 的返回值。');
    let dir = root;
    for (const name of [entry.tier, `shot-${entry.shotId}`, entry.shotKey.slice(7)]) dir = child(dir, name, true);
    return child(dir, `${entry.key.slice(7)}.frame`, false);
  }

  // 一个条目一个文件：一行 JSON 文件头加颜色层字节，改名一步到位，不会出现头和颜色层对不上的中间态。
  const validSeam = seam => seam === undefined || (Array.isArray(seam) && seam.length > 0 && seam.length <= SEAM_BINS && seam.every(Number.isFinite));
  const validRun = id => typeof id === 'string' && id.length > 0;
  function put(entry, { colorBytes, meta = {}, seam, runId = randomUUID() } = {}) {
    const file = fileOf(entry);
    need(colorBytes instanceof Uint8Array && colorBytes.length > 0, '颜色层必须是非空的 Buffer 或 Uint8Array。');
    need(isPlainObject(meta) && validSeam(seam) && validRun(runId), '元数据、接缝特征或写入轮次无效。');
    const { timing, ...stable } = meta;
    const colorSha256 = sha256(colorBytes);
    const fields = { format: FORMAT, key: entry.key, colorSha256, meta: stable, runId, ...(seam && { seam }) };
    const header = canonicalJson({ ...fields, headerSha256: sha256(canonicalJson(fields)) });
    const bytes = Buffer.concat([Buffer.from(`${header}\n`), colorBytes]);
    for (let attempt = 0; ; attempt++) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        atomicWrite(file, bytes, { stagingParent: root });
        break;
      } catch (error) {
        // 并发失效/清理可能刚移走父目录；只补一次，持续的 I/O 故障交给调用方。
        if (error.code !== 'ENOENT' || attempt > 0) throw error;
        fileOf(entry);
      }
    }
    return { colorSha256 };
  }

  // 共享冲突的退避期间，别的写者可能已在同一路径原子发布了新帧：每次删除前重验身份，只删快照里的那个文件。
  const stamp = file => fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  function removeSame(file, snap) {
    let removed = false;
    retrySharing(file, () => {
      const now = stamp(file);
      if (!now || !snap || now.ino !== snap.ino || now.size !== snap.size || now.mtimeNs !== snap.mtimeNs || now.ctimeNs !== snap.ctimeNs) return;
      try {
        fs.unlinkSync(file);
        removed = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }, 5);
    return removed;
  }

  // 头部和颜色必须来自同一次读取；调用方以后再取颜色时用返回的摘要核对。
  function get(entry) {
    const file = fileOf(entry);
    const snap = stamp(file);
    let raw;
    try {
      raw = retrySharing(file, () => fs.readFileSync(file), 12);
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
    const split = raw.indexOf(0x0a);
    const colorBytes = raw.subarray(split + 1);
    let fields;
    try {
      const { headerSha256, ...body } = JSON.parse(raw.subarray(0, Math.max(split, 0)).toString('utf8'));
      if (body.format === FORMAT && body.key === entry.key && isPlainObject(body.meta) && validRun(body.runId) && validSeam(body.seam) &&
          headerSha256 === sha256(canonicalJson(body)) && colorBytes.length && body.colorSha256 === sha256(colorBytes)) fields = body;
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)) throw error;
    }
    if (!fields) {
      removeSame(file, snap);
      return undefined;
    }
    try {
      fs.utimesSync(file, new Date(), new Date()); // 命中算「最近用过」，prune 按它取舍
    } catch {
      // 只读的共享缓存改不了时间，不影响命中
    }
    const { colorSha256, meta, seam, runId } = fields;
    return { colorBytes, colorSha256, meta, seam, runId };
  }

  function list(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  const modified = file => lstat(file)?.mtimeMs ?? 0;

  // 保留策略（设计文档「中间产物留多久」）：草稿由调用方在作业结束时清，终稿每个镜头只留最近用过的一版，超过期限的都删。
  function prune({ maxAgeMs = WEEK_MS, clearDraft = false, now = Date.now() } = {}) {
    need(Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && Number.isFinite(now), '清理期限无效。');
    checkRoot();
    let removed = 0;
    for (const tier of TIERS) {
      for (const shot of list(child(root, tier, true)).filter(item => item.isDirectory())) {
        const versions = list(path.join(root, tier, shot.name)).filter(item => item.isDirectory()).map(version => {
          const dir = path.join(root, tier, shot.name, version.name);
          const files = list(dir).filter(item => item.isFile()).map(item => path.join(dir, item.name)).map(file => {
            const snap = stamp(file);
            return { file, snap, at: snap ? Number(snap.mtimeNs) / 1e6 : 0 };
          });
          return { dir, files, latest: files.reduce((latest, item) => Math.max(latest, item.at), 0) };
        });
        versions.sort((a, b) => b.latest - a.latest || byText(a.dir, b.dir));
        for (const version of versions) {
          const whole = tier === 'draft' ? clearDraft : version !== versions[0];
          for (const { file, snap, at } of version.files) {
            if (!whole && now - at <= maxAgeMs) continue;
            if (removeSame(file, snap)) removed += 1;
          }
          try {
            retrySharing(version.dir, () => fs.rmdirSync(version.dir), 5);
          } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
          }
        }
      }
    }
    // 写到一半就退出的进程留下的暂存目录
    for (const item of list(root)) {
      const staging = path.join(root, item.name);
      if (item.name.startsWith('.write-') && now - modified(staging) > Math.max(maxAgeMs, 60_000)) fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
    }
    return { removed };
  }

  function invalidateShot(entry) {
    const version = path.dirname(fileOf(entry));
    const retired = path.join(root, `.write-retired-${randomUUID()}`);
    try {
      retrySharing(version, () => fs.renameSync(version, retired));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    // 重试只能看到全空或新版本；删除中断留下的暂存由 prune 回收。
    fs.rmSync(retired, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
  return Object.freeze({ root, get, put, prune, invalidateShot });
}

function meanAbsDiff(a, b) {
  need((ArrayBuffer.isView(a) || Array.isArray(a)) && a.length > 0 && a.constructor === b?.constructor && a.length === b.length,
    '接缝检查的每一帧都要带同样类型、同样长度的 colorFloats。');
  const scale = a instanceof Uint8Array || a instanceof Uint8ClampedArray ? 1 / 255 : 1;
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index]);
  return sum * scale / a.length;
}

// 有轮次记录时，出自不同轮次的相邻帧就是交界；旧调用方只比较本次命中标记。
export function checkCacheSeams(frames, { determinism, seamFactor = 3, minSpikeFloor = 0.015 } = {}) {
  need(DETERMINISM.includes(determinism), `determinism 只能是 ${DETERMINISM.join(' 或 ')}。`);
  need(Array.isArray(frames) && frames.every(isPlainObject), '接缝检查需要镜头帧列表。');
  const hasRuns = frames.some(frame => frame.runId !== undefined);
  need(frames.every(frame => hasRuns ? typeof frame.runId === 'string' && frame.runId.length : typeof frame.fromCache === 'boolean'),
    '每帧必须都有 runId，或全部使用旧接口的 fromCache。');
  need(Number.isFinite(seamFactor) && seamFactor > 0 && Number.isFinite(minSpikeFloor) && minSpikeFloor >= 0, '接缝阈值无效。');
  const seams = new Set();
  const source = hasRuns ? 'runId' : 'fromCache';
  for (let frame = 1; frame < frames.length; frame += 1) {
    if (frames[frame][source] !== frames[frame - 1][source]) seams.add(frame);
  }
  if (determinism !== 'tolerance' || !seams.size) return { ok: true, checked: false, spikes: [] };
  if (frames.some(frame => !frame.colorFloats?.length || frame.colorFloats.length !== frames[0].colorFloats?.length)) {
    return { ok: false, checked: false, spikes: [], reason: '接缝特征缺失或长度不一致' };
  }

  const diffs = frames.map((frame, index) => (index ? meanAbsDiff(frames[index - 1].colorFloats, frame.colorFloats) : 0));
  // shortcut: 全镜非交界中位数不能描述每段运动速度；需要局部判别时换用邻域基准。
  const calm = diffs.filter((_, frame) => frame > 0 && !seams.has(frame)).sort((a, b) => a - b);
  const baseline = calm.length ? (calm[(calm.length - 1) >> 1] + calm[calm.length >> 1]) / 2 : 0;
  const threshold = Math.max(minSpikeFloor, seamFactor * baseline);
  // 写成「不小于等于」：算不出来的帧差（NaN）也按尖峰处理
  const spikes = [...seams].filter(frame => !(diffs[frame] <= threshold)).map(frame => ({ frame, diff: diffs[frame], baseline, threshold }));
  return { ok: spikes.length === 0, checked: true, spikes };
}

// 逐镜头、逐帧先查缓存，没命中才调 renderFrame 并写回。shots 的每一项是 computeFrameCacheKey 的前五项，
// 加上 determinism 和摊平的 tier、samples、size、subs；帧号由这里按镜头局部帧号逐帧填。
// renderFrame({ shot, frame, tier, samples, size, subs }) 返回 { colorBytes, meta, colorFloats? }。
// 颜色层不留在内存里：出片时再取 cache.get(entry)，核对返回记录的 colorSha256。
export async function renderShotsWithCache({ shots, cache, renderFrame, filmId, rerenderOnSeamSpike = true, seamFactor, minSpikeFloor, signal } = {}) {
  need(Array.isArray(shots) && shots.length > 0 && shots.every(item => isPlainObject(item) && isPlainObject(item.shot)), 'shots 必须是非空的镜头输入列表。');
  need(isUnique(shots.map(item => item.shot.id)), '镜头 id 不能重复。');
  need(typeof cache?.get === 'function' && typeof cache.put === 'function' && typeof cache.invalidateShot === 'function' && typeof renderFrame === 'function', '需要 cache 与 renderFrame。');
  need(filmId === undefined || (typeof filmId === 'string' && filmId.length > 0), 'filmId 必须是非空字符串。');
  const runId = randomUUID();
  const done = [];
  for (const { shot, determinism, tier, samples, size, subs, ...keyed } of shots) {
    need(DETERMINISM.includes(determinism), `镜头 ${shot.id} 的 determinism 只能是 ${DETERMINISM.join(' 或 ')}。`);
    const totalFrames = shot.out - shot.in;
    need(isCount(totalFrames), `镜头 ${shot.id} 的 in、out 无效。`);
    let renderedFrames = 0;
    const position = frame => ({ shot: shot.id, shotFrame: frame, frame: shot.in + frame, ...(filmId !== undefined && { film: filmId }) });
    async function render(frame, entry) {
      signal?.throwIfAborted();
      const { colorBytes, colorFloats, meta = {} } = await renderFrame({ shot, frame, tier, samples, size, subs: sortedSubs(subs) });
      signal?.throwIfAborted();
      const seam = colorFloats === undefined ? undefined : seamSignature(colorFloats);
      const { colorSha256 } = cache.put(entry, { colorBytes, meta, seam, runId });
      renderedFrames += 1;
      return { frame, fromCache: false, entry, colorFloats: seam, runId, colorSha256, meta: { ...meta, ...position(frame) } };
    }

    const frames = [];
    for (let frame = 0; frame < totalFrames; frame += 1) {
      signal?.throwIfAborted();
      const entry = computeFrameCacheKey({ shot, ...keyed, renderSpec: { tier, samples, size, frame, subs } });
      const hit = cache.get(entry);
      if (!hit) {
        frames.push(await render(frame, entry));
      } else {
        const { film, ...stable } = hit.meta;
        const meta = { ...stable, ...position(frame), timing: { stateMs: 0, renderMs: 0, readbackMs: 0 } };
        frames.push({ frame, fromCache: true, entry, colorFloats: hit.seam, runId: hit.runId, colorSha256: hit.colorSha256, meta });
      }
    }

    let seamCheck = checkCacheSeams(frames, { determinism, seamFactor, minSpikeFloor });
    if (!seamCheck.ok && rerenderOnSeamSpike) {
      // 先使本版本的所有帧失效，再写第一帧；即使修复中断也不能留下已知有问题的交界。
      cache.invalidateShot(frames[0].entry);
      for (const [index, old] of frames.entries()) frames[index] = await render(old.frame, old.entry);
      seamCheck = { ...seamCheck, ok: true, rerendered: true };
    }
    const cachedFrames = frames.filter(frame => frame.fromCache).length;
    done.push({ shotId: shot.id, totalFrames, cachedFrames, renderedFrames, seamCheck,
      frames: frames.map(({ colorFloats, ...record }) => record) });
  }
  const sum = field => done.reduce((total, item) => total + item[field], 0);
  return { ok: done.every(item => item.seamCheck.ok), shots: done,
    totalFrames: sum('totalFrames'), totalRenderedFrames: sum('renderedFrames'), totalCachedFrames: sum('cachedFrames') };
}
