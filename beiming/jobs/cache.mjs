// 内容寻址帧缓存（A16）：一帧的键由设计文档「缓存键」的六项哈希在一起；容差档混用旧帧与新帧后查接缝尖峰。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isPlainObject } from './ledger.mjs';
import { atomicWrite, makeDirectory, safePath } from './workspace.mjs';

const FORMAT = 'frame-cache/0.1';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000; // 毫秒
const SEAM_BINS = 64;
const TIERS = ['draft', 'final'];
const DETERMINISM = ['hash-same-machine', 'tolerance'];
const SPEC_KEYS = ['shot', 'events', 'loadedFiles', 'tracksHash', 'cards', 'runtimeEnv', 'renderSpec'];
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
      return JSON.stringify(node);
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
  const { shot, events = null, loadedFiles, tracksHash, cards, runtimeEnv, renderSpec } = spec;

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

  const picture = { tier, samples, size, subs: [...subs].sort((a, b) => a - b) };
  const components = {
    shot: digest({ entry, frames, events }),
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
  return Array.from({ length: bins }, (_, bin) => {
    const to = Math.floor((bin + 1) * values.length / bins);
    let sum = 0;
    let count = 0;
    for (let index = Math.floor(bin * values.length / bins); index < to; index += 1) {
      if (Number.isFinite(values[index])) {
        sum += values[index];
        count += 1;
      }
    }
    return count ? sum * scale / count : 0;
  });
}

export function openShotCache(cacheDir) {
  const root = makeDirectory(cacheDir);

  function fileOf(entry) {
    need(isPlainObject(entry) && isDigest(entry.key) && isDigest(entry.shotKey) && isShotId(entry.shotId) && TIERS.includes(entry.tier),
      '缓存条目必须是 computeFrameCacheKey 的返回值。');
    return safePath(root, `${entry.tier}/shot-${entry.shotId}/${entry.shotKey.slice(7, 23)}/${entry.key.slice(7)}.frame`);
  }

  // 一个条目一个文件：一行 JSON 文件头加颜色层字节，改名一步到位，不会出现头和颜色层对不上的中间态。
  function put(entry, { colorBytes, meta = {}, seam } = {}) {
    const file = fileOf(entry);
    need(colorBytes instanceof Uint8Array && colorBytes.length > 0, '颜色层必须是非空的 Buffer 或 Uint8Array。');
    need(isPlainObject(meta), '元数据必须是纯对象。');
    const { timing, ...stable } = meta; // timing 是那一次渲染的耗时，复用的帧没有花这个时间
    const header = canonicalJson({ format: FORMAT, key: entry.key, colorSha256: sha256(colorBytes), meta: stable, ...(seam && { seam }) });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, Buffer.concat([Buffer.from(`${header}\n`), colorBytes]), { stagingParent: root });
  }

  // 读回时重算颜色层的哈希；对不上的条目删掉并算未命中。
  function get(entry) {
    const file = fileOf(entry);
    let raw;
    try {
      raw = fs.readFileSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
    let header;
    const split = raw.indexOf(0x0a);
    const colorBytes = raw.subarray(split + 1);
    try {
      header = JSON.parse(raw.subarray(0, Math.max(split, 0)).toString('utf8'));
    } catch {
      header = undefined;
    }
    if (header?.format !== FORMAT || header.key !== entry.key || header.colorSha256 !== sha256(colorBytes) || !isPlainObject(header.meta)) {
      fs.rmSync(file, { force: true });
      return undefined;
    }
    try {
      fs.utimesSync(file, new Date(), new Date()); // 命中算「最近用过」，prune 按它取舍
    } catch {
      // 只读的共享缓存改不了时间，不影响命中
    }
    return { colorBytes, colorSha256: header.colorSha256, meta: header.meta, seam: header.seam };
  }

  function list(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  const modified = file => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;

  // 保留策略（设计文档「中间产物留多久」）：草稿由调用方在作业结束时清，终稿每个镜头只留最近用过的一版，超过期限的都删。
  function prune({ maxAgeMs = WEEK_MS, clearDraft = false, now = Date.now() } = {}) {
    need(Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && Number.isFinite(now), '清理期限无效。');
    let removed = 0;
    for (const tier of TIERS) {
      for (const shot of list(path.join(root, tier)).filter(item => item.isDirectory())) {
        const versions = list(path.join(root, tier, shot.name)).filter(item => item.isDirectory()).map(version => {
          const dir = path.join(root, tier, shot.name, version.name);
          const files = list(dir).filter(item => item.isFile()).map(item => path.join(dir, item.name)).map(file => ({ file, at: modified(file) }));
          return { dir, files, latest: files.reduce((latest, item) => Math.max(latest, item.at), 0) };
        });
        const latest = versions.reduce((value, version) => Math.max(value, version.latest), 0);
        for (const version of versions) {
          const whole = tier === 'draft' ? clearDraft : version.latest < latest;
          for (const { file, at } of version.files) {
            if (!whole && now - at <= maxAgeMs) continue;
            fs.rmSync(file, { force: true });
            removed += 1;
          }
          try {
            fs.rmdirSync(version.dir);
          } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
          }
        }
      }
    }
    // 写到一半就退出的进程留下的暂存目录
    for (const item of list(root)) {
      const staging = path.join(root, item.name);
      if (item.name.startsWith('.write-') && now - modified(staging) > maxAgeMs) fs.rmSync(staging, { recursive: true, force: true });
    }
    return { removed };
  }

  return Object.freeze({ root, get, put, prune });
}

function meanAbsDiff(a, b) {
  need((ArrayBuffer.isView(a) || Array.isArray(a)) && a.length > 0 && a.constructor === b?.constructor && a.length === b.length,
    '接缝检查的每一帧都要带同样类型、同样长度的 colorFloats。');
  const scale = a instanceof Uint8Array || a instanceof Uint8ClampedArray ? 1 / 255 : 1;
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index]);
  return sum * scale / a.length;
}

// frames 是一个镜头按帧序排好的全部帧：{ fromCache, colorFloats }。返回的 spikes[].frame 是数组下标，也就是镜头局部帧号。
// 只在容差档、并且旧帧与新帧相邻时才查：交界处的帧间差明显高出不在交界上的帧间差，就是接缝尖峰。
export function checkCacheSeams(frames, { determinism, seamFactor = 3, minSpikeFloor = 0.015 } = {}) {
  need(DETERMINISM.includes(determinism), `determinism 只能是 ${DETERMINISM.join(' 或 ')}。`);
  need(Array.isArray(frames) && frames.every(frame => isPlainObject(frame) && typeof frame.fromCache === 'boolean'), '每一帧都要带布尔值 fromCache。');
  need(Number.isFinite(seamFactor) && seamFactor > 0 && Number.isFinite(minSpikeFloor) && minSpikeFloor >= 0, '接缝阈值无效。');
  const seams = [];
  for (let frame = 1; frame < frames.length; frame += 1) {
    if (frames[frame].fromCache !== frames[frame - 1].fromCache) seams.push(frame);
  }
  if (determinism !== 'tolerance' || seams.length === 0) return { ok: true, checked: false, spikes: [] };

  const diffs = frames.map((frame, index) => (index ? meanAbsDiff(frames[index - 1].colorFloats, frame.colorFloats) : 0));
  // shortcut: 基准取整个镜头的中位数，快慢悬殊的镜头在快的那段交界会误报（代价是多重渲一次，不会漏放）；误报多了改成只看交界附近几帧
  const calm = diffs.filter((_, frame) => frame > 0 && !seams.includes(frame)).sort((a, b) => a - b);
  const baseline = calm.length ? (calm[(calm.length - 1) >> 1] + calm[calm.length >> 1]) / 2 : 0;
  const threshold = Math.max(minSpikeFloor, seamFactor * baseline);
  // 写成「不小于等于」：算不出来的帧差（NaN）也按尖峰处理
  const spikes = seams.filter(frame => !(diffs[frame] <= threshold)).map(frame => ({ frame, diff: diffs[frame], baseline, threshold }));
  return { ok: spikes.length === 0, checked: true, spikes };
}

// 逐镜头、逐帧先查缓存，没命中才调 renderFrame 并写回。shots 的每一项是 computeFrameCacheKey 的前五项，
// 加上 determinism 和摊平的 tier、samples、size、subs；帧号由这里按镜头局部帧号逐帧填。
// renderFrame({ shot, frame, tier, samples, size, subs }) 返回 { colorBytes, meta, colorFloats? }。
// 颜色层不留在内存里：出片时按返回的 frames[].entry 用 cache.get 取。
export async function renderShotsWithCache({ shots, cache, renderFrame, rerenderOnSeamSpike = true, seamFactor, minSpikeFloor, signal } = {}) {
  need(Array.isArray(shots) && shots.length > 0 && shots.every(item => isPlainObject(item) && isPlainObject(item.shot)), 'shots 必须是非空的镜头输入列表。');
  need(isUnique(shots.map(item => item.shot.id)), '镜头 id 不能重复。');
  need(typeof cache?.get === 'function' && typeof cache.put === 'function' && typeof renderFrame === 'function', '需要 cache 与 renderFrame。');

  const done = [];
  for (const { shot, determinism, tier, samples, size, subs, ...keyed } of shots) {
    need(DETERMINISM.includes(determinism), `镜头 ${shot.id} 的 determinism 只能是 ${DETERMINISM.join(' 或 ')}。`);
    const totalFrames = shot.out - shot.in;
    need(isCount(totalFrames), `镜头 ${shot.id} 的 in、out 无效。`);
    let renderedFrames = 0;
    async function render(frame, entry) {
      signal?.throwIfAborted();
      const { colorBytes, colorFloats, meta } = await renderFrame({ shot, frame, tier, samples, size, subs });
      const seam = colorFloats === undefined ? undefined : seamSignature(colorFloats);
      cache.put(entry, { colorBytes, meta, seam });
      renderedFrames += 1;
      return { frame, fromCache: false, entry, colorFloats: seam };
    }

    const frames = [];
    for (let frame = 0; frame < totalFrames; frame += 1) {
      const entry = computeFrameCacheKey({ shot, ...keyed, renderSpec: { tier, samples, size, frame, subs } });
      const hit = cache.get(entry);
      frames.push(hit ? { frame, fromCache: true, entry, colorFloats: hit.seam } : await render(frame, entry));
    }

    const mixed = frames.some(frame => frame.fromCache) && frames.some(frame => !frame.fromCache);
    let seamCheck = determinism === 'tolerance' && mixed && frames.some(frame => !frame.colorFloats)
      ? { ok: false, checked: false, spikes: [], reason: '有帧没带 colorFloats，查不了接缝' }
      : checkCacheSeams(frames, { determinism, seamFactor, minSpikeFloor });
    if (!seamCheck.ok && rerenderOnSeamSpike) {
      // 新渲的帧不用再渲：把复用的旧帧也重渲并替换缓存，整个镜头就都出自这一轮
      for (const [index, old] of frames.entries()) {
        if (old.fromCache) frames[index] = await render(old.frame, old.entry);
      }
      seamCheck = { ...seamCheck, ok: true, rerendered: true };
    }
    const cachedFrames = frames.filter(frame => frame.fromCache).length;
    done.push({ shotId: shot.id, totalFrames, cachedFrames, renderedFrames, seamCheck,
      frames: frames.map(({ frame, fromCache, entry }) => ({ frame, fromCache, entry })) });
  }
  const sum = field => done.reduce((total, item) => total + item[field], 0);
  return { ok: done.every(item => item.seamCheck.ok), shots: done,
    totalFrames: sum('totalFrames'), totalRenderedFrames: sum('renderedFrames'), totalCachedFrames: sum('cachedFrames') };
}
