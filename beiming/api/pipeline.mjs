// 渲染、核验、交付三类作业真正干活的地方。全部经各组件的公共入口：
//   帧源 sources/blender（原生 cards-data 资产镜头）和 host/page 上的 three（cards-data 镜头）；
//   kernel/eval 的事件表与镜头输入；verify 的 L1、L2（纯函数门、包围盒核对门）、L3（谓词求值、防削弱）；
//   comp 的分流拼接、混音、编码、六件套；observe 的成片量测、联系表与切点条带。
// 帧落盘的布局（每个作业一个目录，在工作区 deliver/ 下，不进修订快照）：
//   <镜头>/layers/r###-f####/{color.f32, objectId.u32}   帧源写的层文件；终渲档另有 delivery.layers 点名的层（depth.f32、normal.f32）
//   <镜头>/f<全片帧号>.meta.json                          每帧元数据 meta/0.1
//   <镜头>/exr/l<镜头局部帧号>.exr                         场景线性颜色 R、G、B、A（comp 的输入）；终渲档另带 delivery.layers 点名的通道（depth.Z、normal.X…）
//   <镜头>/png/f<全片帧号>.png                             过显示变换的预览（联系表的输入）
// 给了镜头帧缓存（jobs/cache.mjs，A16）时每帧先按六项键查缓存：命中的帧把层文件还原到 <镜头>/layers/cache-f####/，不调帧源；
// 一个镜头全部命中就不为它起帧源会话；交付的 L2 纯函数门对这样的镜头照缓存里这一版过门的记录用。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright-core';
import { chromeArgs, chromeExecutable } from '../../engine/render/lib/gpu.mjs';
import { aggregateL5Votes, filterL5SuggestedPredicates, reviewFailure, validateReview } from './agents.mjs';
import { assetPaths } from './assets.mjs';
import { branchFilter, deliver as compDeliver, parseFps, runTool, tools as compTools, verifyDeliveryBundle } from '../comp/index.mjs';
import { parseCardRef, OVERLAY_CARD } from '../cards/runtime.mjs';
import { startSource as startPage } from '../host/page/host.mjs';
import { canonicalJson, checkCacheSeams, computeFrameCacheKey, seamSignature } from '../jobs/cache.mjs';
import { eventsTable, renderingOf, shotInput, shutterSubs } from '../kernel/eval/index.mjs';
import { audioLoudness, blackFreezeDup, buildContactSheet, buildCutStrips, cutYdif, deliverSpec } from '../observe/index.mjs';
import { caps as blenderCaps } from '../sources/blender/caps.mjs';
import { planRender as planBlender, startSource as startBlender } from '../sources/blender/host.mjs';
import { caps as threeCaps } from '../sources/three/caps.mjs';
import { planRender as planThree } from '../sources/three/plan.mjs';
import { readExr, writeExr } from '../verify/exr/exr.mjs';
import {
  checkL1, evaluateAssertion, evaluateFloor, guardPredicates, IOU_MIN, runPureFunctionGate, toVerdict, verifySampledBboxes,
} from '../verify/index.mjs';
import { diagnostic } from './envelope.mjs';
import { BEIMING, engineCodeDigest, liveCardsDigest, monotonicMs, threeCardDirs, VIEW_SHAPER } from './runtime.mjs';

const pad = (n, w = 4) => String(n).padStart(w, '0');
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
// cards-data 镜头不读入口文件；页面宿主只放行 beiming/ 里的目录，给它本组件的目录
const PAGE_FILM_DIR = join(BEIMING, 'api');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * 一个作业里用到的帧源：按需起，作业结束 stop。
 * renders 是 { 镜头: 次数 }：这个池开出的会话的 render 每调一次记一次（终渲、补渲、L2 的探针都算），一次没调的镜头不出现。
 */
export function sourcePool({ library, blenderBin, workspace }) {
  const blenders = new Map();
  const renders = {};
  let page = null;
  const counted = (src) => ({
    async open(input, env) {
      const session = await src.open(input, env);
      const render = session.render;
      session.render = function (...args) {
        renders[input.shot.id] = (renders[input.shot.id] ?? 0) + 1;
        return render.apply(this, args);
      };
      return session;
    },
  });
  async function start(source, device) {
    const lib = typeof library === 'function' ? library() : library;
    if (source === 'blender') {
      if (!blenderBin) throw coded('env.missing-tool', '这台服务器上没有 Blender：blender 镜头渲不了');
      if (!blenders.has(device)) {
        const cards = Object.values(lib).filter(({ card }) => card.id === 'camera.spline' || card.livesIn.includes('source:blender')).map(c => c.dir);
        blenders.set(device, await startBlender({ blenderBin, assets: assetPaths(workspace), cards, device }));
      }
      return blenders.get(device);
    }
    if (source === 'three') {
      page ??= await startPage({ cards: threeCardDirs(lib) }).catch((e) => { throw coded('env.missing-tool', `起不了无头浏览器：${String(e.message).split('\n')[0]}`); });
      return page;
    }
    throw coded('contract.unsupported-mode', `帧源 ${source} 这台服务器没接`);
  }
  return {
    renders,
    get: async (source, device = 'auto') => counted(await start(source, device)),
    async stop() {
      await Promise.allSettled([...Array.from(blenders.values(), b => b.stop()), page?.stop()]);
      blenders.clear();
      page = null;
    },
  };
}

const filmDirOf = (shot, filmDir) => (shot.source === 'three' ? PAGE_FILM_DIR : filmDir);

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function parseHexLinear(hex) {
  if (typeof hex !== 'string' || !/^#[0-9A-F]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(hex.slice(i + 1, i + 3), 16) / 255));
}

/** 颜色层（RGBA f32 交错、预乘）→ ffmpeg 要的平面 G、B、R、A；给了 paperLinear 时把透明区域叠到纸底上 */
function planar(buf, w, h, paperLinear = null) {
  const f = new Float32Array(buf.buffer, buf.byteOffset, w * h * 4);
  const n = w * h, out = new Float32Array(n * 4);
  if (paperLinear) {
    const [pr, pg, pb] = paperLinear;
    for (let i = 0; i < n; i++) {
      const inv = 1 - f[i * 4 + 3];
      out[i] = f[i * 4 + 1] + inv * pg; out[n + i] = f[i * 4 + 2] + inv * pb; out[2 * n + i] = f[i * 4] + inv * pr; out[3 * n + i] = 1;
    }
  } else {
    for (let i = 0; i < n; i++) {
      out[i] = f[i * 4 + 1]; out[n + i] = f[i * 4 + 2]; out[2 * n + i] = f[i * 4]; out[3 * n + i] = f[i * 4 + 3];
    }
  }
  return Buffer.from(out.buffer);
}

// 能随帧落盘的辅助层：层文件的类型和分量（输出通道契约 3.1；两个帧源的编号层都不带覆盖率）
const AUX = { objectId: ['u32', ['id']], depth: ['f32', ['Z']], normal: ['f32', ['X', 'Y', 'Z']] };
const auxFile = (name) => `${name}.${AUX[name][0]}`;

/** 一帧里点名的辅助层 → EXR 的通道 { 'depth.Z': 平面, … }，数就是层文件里的 */
function auxChannels(rec, names, n) {
  const out = {};
  for (const name of names) {
    const [type, components] = AUX[name], b = readFileSync(rec.files[auxFile(name)]);
    if (b.length !== n * components.length * 4) throw coded('contract.bad-value', `帧 ${rec.frame} 的 ${name} 层大小不对`);
    const data = new (type === 'u32' ? Uint32Array : Float32Array)(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    components.forEach((c, at) => { out[`${name}.${c}`] = components.length === 1 ? data : data.filter((_, i) => i % components.length === at); });
  }
  return out;
}

/**
 * 一个镜头渲好的帧：颜色转 EXR（场景线性，comp 的输入）和 PNG（过 comp 同一条显示变换，给联系表）。
 * EXR 由 verify/exr 的写入器写（ZIPS，32 位），verify/exr 的读取器读得回来（FFmpeg 的 EXR 编码器不写 pixelAspectRatio，那边读不了）；
 * 通道是 R、G、B、A，加上 embed（delivery.layers 点名的辅助层）的 <层>.<分量>，comp 和预览只读颜色。
 */
function convertShot(records, shot, { dir, fps, lutPath, paperLinear, embed = [] }) {
  if (!records.length) return;
  const { ffmpeg } = compTools();
  const [h, w] = records[0].shape;
  const seq = join(dir, 'seq');
  rmSync(seq, { recursive: true, force: true });
  mkdirSync(seq, { recursive: true });
  mkdirSync(join(dir, 'exr'), { recursive: true });
  mkdirSync(join(dir, 'png'), { recursive: true });
  for (const [i, r] of records.entries()) {
    const p = planar(readFileSync(r.color), w, h, paperLinear), n = w * h;
    const [G, B, R, A] = [0, 1, 2, 3].map((at) => new Float32Array(p.buffer, p.byteOffset + at * n * 4, n));
    writeFileSync(join(seq, `${pad(i)}.exr`), writeExr({ width: w, height: h, compression: 2, channels: { R, G, B, A, ...auxChannels(r, embed, n) } }));
  }
  const filter = branchFilter({ id: shot.id, colorRef: shot.colorRef, count: records.length, transfer: 'linear' }, { size: [w, h], fps: parseFps(fps), view: { lutPath, shaper: VIEW_SHAPER } });
  runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'image2', '-framerate', fps, '-start_number', '0', '-i', join(seq, '%04d.exr'),
    '-filter_complex', `[0:v]${filter},format=rgb24[o]`, '-map', '[o]', '-start_number', '0', join(seq, '%04d.png')], { what: '预览 PNG' });
  records.forEach((r, i) => {
    r.exr = join(dir, 'exr', `l${pad(r.frame - shot.in)}.exr`);
    r.png = join(dir, 'png', `f${pad(r.frame)}.png`);
    renameSync(join(seq, `${pad(i)}.exr`), r.exr);
    renameSync(join(seq, `${pad(i)}.png`), r.png);
  });
  rmSync(seq, { recursive: true, force: true });
}

/* ---------------- 镜头帧缓存的键（A16，设计文档「缓存键」的六项） ---------------- */

// 不起帧源也拿得到的能力声明：确定性分档和两个档位的默认采样数（Blender 的版本号不影响这几项）
const SOURCE_CAPS = { three: () => threeCaps(), blender: () => blenderCaps('') };
const SOURCE_PLAN = { three: planThree, blender: planBlender };
const hexOf = (digest) => String(digest).replace(/^sha256:/, '');

/**
 * 帧源照这次请求该出的画幅 [宽, 高]：帧源自己的出帧计划（纯函数，不起帧源）算的，和它真出帧时用的是同一个函数。
 * 不是 film.output.size：草稿档默认按能力声明缩小，镜头条目的 tiers.<档位>.scale 也能改。算不出来（镜头条目有帧源才判得出的错）交 null
 */
function renderSize({ film, lock, shot, tier, want }) {
  try {
    return SOURCE_PLAN[shot.source](SOURCE_CAPS[shot.source](), shot, film.output.size, tier, {}, [...want, 'meta'], { shutterSamples: lock.shots?.[shot.id]?.shutterSamples }).size;
  } catch {
    return null;
  }
}

/** 浏览器构建的指纹：可执行文件的路径（Playwright 的路径带构建号）、大小和修改时间。只进哈希，不落盘 */
function browserBuild() {
  const bin = chromeExecutable() ?? chromium.executablePath();
  const st = statSync(bin, { throwIfNoEntry: false });
  return `${bin}|${st?.size ?? 0}|${st?.mtimeMs ?? 0}`;
}

// 帧源真出过帧之后才知道的那部分环境（显卡后端、显卡型号）记在缓存根目录的 devices.json：{ 帧源: { backend, gpu } }。
// 全部命中的镜头照这份记录算键，不必为了问环境去起浏览器或 Blender；真渲的帧报的不一样就改记录、照新环境重算键。
const deviceFile = (cache) => join(cache.root, 'devices.json');
function readDevices(cache) {
  try { return JSON.parse(readFileSync(deviceFile(cache), 'utf8')); } catch { return {}; }
}
function saveDevice(cache, source, device) {
  const tmp = `${deviceFile(cache)}.${randomUUID()}.tmp`;
  writeFileSync(tmp, jsonBytes({ ...readDevices(cache), [source]: device }));
  renameSync(tmp, deviceFile(cache));
}
const deviceOf = (source = {}) => ({ backend: String(source.backend ?? 'none'), gpu: String(source.gpu ?? 'none') });

/**
 * 一个镜头的缓存键输入：computeFrameCacheKey 的前五项，加上 determinism 和摊平的 tier、samples、size、subs、layers
 * （帧号由调用方逐帧填；比 jobs/cache.mjs 的 renderShotsWithCache 的镜头输入多一个 layers）。
 * events 是全片事件表；device 是帧源上次出帧时报的 { backend, gpu }，没出过帧不传；
 * engineDigest / cardsDigest 为当前作业开始时快照的实时引擎代码（含字体）与本镜头所用卡的磁盘摘要，未传时现算；engineRoot 供测试隔离引擎根目录。
 *   ① 镜头条目和它的起始帧，加上全片事件表（events.events：shotInput 把全片事件交给镜头与卡，任何事件变更都必须失效缓存）
 *      和用到的片级参数（帧率、风格 tokens、资产表、贴在这个镜头的叠加层、锁里的镜头种子）。
 *      起始帧必须进键：镜头代码和卡拿得到 ctx.shot.in（镜头契约 S10），time 类型的卡参数写整数是全片帧号，
 *      前面的镜头改长、这个镜头整体后移之后画面可以不一样，所以平移过的镜头重渲；
 *   ② 入口文件和它可能引用的工作区源码（shots/ 下不是别的镜头入口的文件），加上用到的资产在锁里的摘要；cards-data 镜头没有入口；
 *   ③ 镜头的 tracks 声明的摘要，没有写 'none'；④ 镜头的卡、叠加层卡和数据层的卡在锁里的版本与实现哈希；
 *   ⑤ 帧源与宿主、锁里的运行时版本与镜像加上按作业实时计算的引擎代码/字体/卡摘要、浏览器构建、显卡后端、系统、锁里声明的出片机器（lock.machine：机器类别、显卡驱动版本）与显卡；
 *   ⑥ 档位、采样数、画幅、快门子帧相位、这一档要帧源交的层（layersOf）。colorRef 在镜头条目里，已经在 ① 里。
 * shortcut: 镜头代码引用别的镜头的入口文件，这里看不出来；出现这种写法时把 shots/ 全部进键。
 */
/** 一档要帧源交、要随帧落盘的层：颜色和编号层总要；终渲档加上 delivery.layers 点名的通道（片子契约：终渲要落盘的通道） */
export const layersOf = (film, tier) => [...new Set(['color', 'objectId', ...(tier === 'final' ? film.delivery?.layers ?? [] : [])])].sort();

const OVERLAY_CARD_ID = parseCardRef(OVERLAY_CARD).name;

function shotCardIds(film, lock, shot) {
  const r = renderingOf(shot);
  const overlays = (film.overlays ?? []).filter((o) => o.shot === shot.id);
  const used = new Set([...(r.cards ?? shot.cards ?? []).map((c) => parseCardRef(c.use).name), ...(overlays.length ? [OVERLAY_CARD_ID] : [])]);
  const lockedData = Object.entries(lock.cards ?? {}).filter(([, c]) => c.impl?.includes('data')).map(([id]) => id);
  return [...new Set([...used, ...lockedData])];
}

export function buildShotCacheInputs({ film, lock, shot, filmDir, tier, events = eventsTable(film), device, engineDigest, cardsDigest, engineRoot }) {
  const caps = SOURCE_CAPS[shot.source]?.();
  if (!caps) throw coded('contract.unsupported-mode', `帧源 ${shot.source} 这台服务器没接`);
  const r = renderingOf(shot), base = filmDirOf(shot, filmDir);
  const overlays = (film.overlays ?? []).filter((o) => o.shot === shot.id);

  const loadedFiles = [];
  if (typeof r.entry === 'string' && existsSync(join(base, r.entry))) {
    const others = new Set(film.shots.filter((x) => x.id !== shot.id).map((x) => renderingOf(x).entry));
    const shared = listDir(join(base, 'shots')).length
      ? readdirSync(join(base, 'shots'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
        .map((e) => relative(base, join(e.parentPath, e.name)).split(sep).join('/')).filter((p) => !others.has(p) && !p.includes('__pycache__'))
      : [];
    for (const path of [...new Set([r.entry, ...shared])]) {
      const bytes = readFileSync(join(base, path));
      loadedFiles.push({ path, sha256: sha256(bytes) });
    }
  }
  for (const ref of new Set([film.assets, shot.assets, r.assets].flatMap((a) => Object.values(a ?? {})))) {
    if (lock.assets?.[ref]) loadedFiles.push({ path: ref, sha256: hexOf(lock.assets[ref]) });
  }

  const used = new Set([...(r.cards ?? shot.cards ?? []).map((c) => parseCardRef(c.use).name), ...(overlays.length ? [OVERLAY_CARD_ID] : [])]);
  const cards = Object.entries(lock.cards ?? {}).filter(([id, c]) => used.has(id) || c.impl?.includes('data'))
    .map(([id, c]) => ({ id, version: c.version, sha256: c.sha256 }));

  const engineOpts = engineRoot ? { root: engineRoot, effective: true } : { effective: true };
  const cardOpts = engineRoot ? { root: engineRoot } : undefined;
  const codeDigest = engineDigest ?? engineCodeDigest(shot.source, engineOpts);
  const liveCards = cardsDigest ?? liveCardsDigest([...used, ...cards.map((c) => c.id)], cardOpts);

  const locked = lock.sources?.[shot.source] ?? {};
  const tracks = r.tracks ?? shot.tracks;
  const samples = (r.tiers ?? shot.tiers)?.[tier]?.samples;
  const shutter = r.shutter ?? shot.shutter ?? {};
  return {
    shot,
    events: events.events,
    film: { at: shot.in, fps: film.output.fps, tokens: film.style?.tokens ?? null, assets: film.assets ?? null, overlays, seed: lock.seeds?.[shot.id] ?? null },
    loadedFiles,
    tracksHash: tracks === undefined ? 'none' : `sha256:${sha256(canonicalJson(tracks))}`,
    cards,
    runtimeEnv: {
      source: `${shot.source}:${locked.host ?? 'none'}`,
      runtimeVersion: `${locked.version ?? 'none'} ${locked.image ?? 'none'} engine:${codeDigest} cards:${liveCards}`,
      browserBuild: shot.source === 'three' ? browserBuild() : 'none',
      gpuBackend: `${shot.source === 'three' ? chromeArgs().join(' ') : 'auto'} ${device?.backend ?? 'unprobed'}`,
      driver: `${process.platform} ${process.arch} ${release()} ${canonicalJson(lock.machine ?? null)} ${device?.gpu ?? 'unprobed'}`,
    },
    determinism: caps.determinism,
    tier,
    samples: Number.isSafeInteger(samples) && samples > 0 ? samples : caps[tier].samples,
    size: film.output.size,
    subs: shutterSubs(shutter.angleDeg ?? shutter.angle ?? 0, lock.shots?.[shot.id]?.shutterSamples ?? shutter.samples ?? 1),
    layers: layersOf(film, tier),
  };
}

/** buildShotCacheInputs 的结果加镜头局部帧号 → 这一帧的缓存条目 */
const entryFrom = ({ determinism, tier, samples, size, subs, layers, ...five }, frame) => computeFrameCacheKey({ ...five, renderSpec: { tier, samples, size, frame, subs, layers } });
// 页面帧源的场景参考镜头每帧另交的文件（sources/three/source.js：出了颜色就有 frame.exr，要了编号层就有宽高各两倍的 objectId2x）→ 每像素字节数，null 是不定长
const NATIVE = { 'frame.exr': null, 'objectId2x.u32': 16 };
/**
 * 原生 frame.exr 整个解得开、是这一帧的画幅，页面宿主该写的通道（host/page/host.mjs：color.R/G/B/A，要了的辅助层每个分量，要了编号层另有 objectId2x.coverage）
 * 一个不缺、类型和样本数都对。外层校验和只保证存进去的字节没变，不保证存的是个好文件；独立的层文件齐全也不说明这个文件里的通道齐全。
 * 辅助通道的数还要和层文件（layers，大小已经核过）里的一样：页面宿主写这个文件时辅助通道就是层文件里的数，对不上就是别的帧的文件
 */
function validNativeExr(bytes, w, h, aux, layers) {
  try {
    const exr = readExr(bytes);
    const has = (name, type = Float32Array) => exr.channels[name] instanceof type && exr.channels[name].length === w * h;
    const same = (name) => {
      const [type, components] = AUX[name], bytes = layers[auxFile(name)];
      const ArrayType = type === 'u32' ? Uint32Array : Float32Array;
      // 文件在缓存载荷中的偏移可能未对齐。
      const data = new ArrayType(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
      return components.every((component, at) => {
        const channel = `${name}.${component}`;
        if (!has(channel, ArrayType)) return false;
        return exr.channels[channel].every((value, i) => {
          const stored = data[i * components.length + at];
          return value === stored || (Number.isNaN(value) && Number.isNaN(stored));
        });
      });
    };
    return exr.width === w && exr.height === h && ['R', 'G', 'B', 'A'].every((c) => has(`color.${c}`))
      && aux.every(same) && (!aux.includes('objectId') || has('objectId2x.coverage'));
  } catch {
    return false;
  }
}

const ZERO_TIMING = Object.freeze({ stateMs: 0, renderMs: 0, readbackMs: 0 });
const digestsOf = (layers) => Object.fromEntries(Object.entries(layers).map(([name, bytes]) => [name, sha256(bytes)]));
const floatsOf = (buf) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));

/**
 * 渲一批帧。plan：[{ shot, frames: [全片帧号] }]。交回 { records, gpuSeconds, renderedFrames, cachedFrames, shots, versions }。
 * records 每项 { frame, shot, meta, metaPath, color, objectId, files, shape, exr, png }（路径是绝对路径），从缓存来的多一个 cached: true；
 * files 是这一帧颜色层之外的文件 { 文件名: 路径 }：辅助层，加上场景参考通路帧源另交的 frame.exr、objectId2x.u32。
 * 帧源要交的层见 layersOf：终渲档带上 delivery.layers 点名的通道，帧源交不出的通道由帧源报 contract.unsupported-output。
 * gpuSeconds 是帧源 render 调用的耗时之和（单调时钟），帧源在显卡上出帧；renderedFrames 只数真调了帧源的帧，cachedFrames 数缓存命中的帧，
 * shots 是每个镜头的 { shot, renderedFrames, cachedFrames, seam? }；
 * versions 是 { 镜头: { entry, hit } }（走了缓存的镜头才有）：entry 是这一版镜头的一个帧条目，hit 是这一轮是不是全部命中，给 layerL2 用。
 * cache 是 jobs/cache.mjs 的 openShotCache 句柄，不给就每帧都渲（和接缓存之前一样）。给了：
 *   命中的帧核过颜色层和每个辅助层的 SHA-256、要的层一层不缺、条目是这一帧的（见 restore）才用，坏了缺了、不是这一帧的当没命中重渲；元数据的 timing 记 0，别的原样；
 *   容差档帧源（determinism 是 tolerance）出的一段连续帧里混了几轮的帧时查接缝尖峰，有尖峰就让这个镜头这一版的缓存失效、把旧帧在这一轮重渲。
 * shortcut: 抽样帧（不连续）不查接缝，相邻帧差在抽样间隔上没有可比性；要查时改渲连续区间。
 */
export async function renderPlan({ film, lock, filmDir, tier, plan, outDir, pool, signal, lutPath, onFrame, cache, engineRoot }) {
  const events = eventsTable(film);
  const records = [], shots = [], versions = {};
  const want = layersOf(film, tier), aux = want.filter((name) => name !== 'color');
  const embed = tier === 'final' ? (film.delivery?.layers ?? []).filter((name) => name !== 'color') : [];
  const runId = randomUUID();
  const engineOpts = engineRoot ? { root: engineRoot, effective: true } : { effective: true };
  const cardOpts = engineRoot ? { root: engineRoot } : undefined;
  // 按作业计算一次本作业实际执行的帧源有效摘要与卡实时摘要：同一作业所有帧共享同一快照，下一作业立即重算，杜绝混帧与启动期陈旧快照
  const engineDigests = cache
    ? new Map([...new Set(plan.map(({ shot }) => shot.source))].map((source) => [source, engineCodeDigest(source, engineOpts)]))
    : null;
  const cardDigests = cache ? new Map() : null;
  if (cache) {
    for (const { shot } of plan) {
      try {
        cardDigests.set(shot.id, liveCardsDigest(shotCardIds(film, lock, shot), cardOpts));
      } catch { /* 非法卡引用交由 rekey / 帧源照常报错 */ }
    }
  }
  let gpuMs = 0;
  for (const { shot, frames } of plan) {
    signal?.throwIfAborted();
    const dir = join(outDir, shot.id);
    mkdirSync(dir, { recursive: true });
    const live = new Map(); // 这一轮真渲的帧：全片帧号 → 记录
    const native = shot.source === 'three' && shot.colorRef === 'scene';
    const size = cache ? renderSize({ film, lock, shot, tier, want }) : null;
    const seams = new Map(); // 全片帧号 → { runId, colorFloats }，查接缝用
    let mine, session, keyed = null, device = cache ? readDevices(cache)[shot.source] : undefined, seam;

    const rekey = () => {
      // 键算不出来（镜头条目里有帧源才判得出的错）就不走缓存，让帧源照常报它自己的错
      try {
        keyed = cache ? buildShotCacheInputs({
          film, lock, shot, filmDir, tier, events, device,
          engineDigest: engineDigests.get(shot.source),
          cardsDigest: cardDigests.get(shot.id),
          engineRoot,
        }) : null;
        if (keyed && frames.length) entryOf(frames[0]);
      } catch {
        keyed = null;
      }
    };
    const entryOf = (frame) => entryFrom(keyed, frame - shot.in);
    const cacheEntryOf = (entry) => ({ tier: entry.tier, shotId: entry.shotId, shotKey: entry.shotKey });
    const store = (frame, rec) => {
      const colorBytes = readFileSync(rec.color), colorFloats = seamSignature(floatsOf(colorBytes));
      const layers = Object.fromEntries(Object.entries(rec.files).map(([name, file]) => [name, readFileSync(file)]));
      // 存进去的元数据多记一项 cache：这一帧是照哪个键渲的、存的每一层的摘要（还原时核，交出去的元数据不带）
      const entry = entryOf(frame);
      cache.put(entry, { colorBytes, layers, meta: { ...rec.meta, cache: { key: entry.key, layers: digestsOf(layers) } }, seam: colorFloats, runId });
      rec.cacheEntry = cacheEntryOf(entry);
      seams.set(frame, { runId, colorFloats });
    };
    const render = async (frame) => {
      signal?.throwIfAborted();
      session ??= await (await pool.get(shot.source)).open(shotInput(film, shot.id, events), { lock, tier, workspace: join(dir, 'layers'), filmDir: filmDirOf(shot, filmDir) });
      const t0 = monotonicMs();
      const r = await session.render(frame - shot.in, {}, [...want, 'meta']);
      const elapsed = monotonicMs() - t0;
      gpuMs += elapsed;
      onFrame?.(elapsed / 1000);
      const metaPath = join(dir, `f${pad(frame)}.meta.json`);
      writeFileSync(metaPath, jsonBytes(r.meta));
      const { color, ...others } = r.layers;
      const files = Object.fromEntries([...Object.values(others), r.exr, r.objectId2x].filter(Boolean).map((l) => [basename(l.file), join(dir, 'layers', l.file)]));
      const rec = { frame, shot: shot.id, meta: r.meta, metaPath, color: join(dir, 'layers', color.file), objectId: join(dir, 'layers', r.layers.objectId.file), files, shape: color.shape };
      live.set(frame, rec);
      return rec;
    };
    /**
     * 查这一帧的缓存，命中就还原成层文件和元数据。键对、校验和对、条目自己和自己对得上，都不说明存进去的是这一帧，下面任一条不成立就当没命中：
     * 条目记的 cache 是这一帧的键和这几层的摘要（store 存的；别的版本、别的画幅、别的帧的载荷记的是它自己的键，偷换过的层摘要对不上。
     * 颜色层由元数据的 hash.color 管）；
     * 元数据的画幅是帧源照这次请求该出的（size，不照条目自己说的）、镜头、帧号、帧源、档位是这一帧的；颜色层的大小和摘要对得上；
     * 要的层一层不缺、大小对；页面帧源场景参考镜头带着原生文件（NATIVE），原生 EXR 过得了 validNativeExr
     */
    const restore = (frame) => {
      const entry = entryOf(frame), hit = cache.get(entry);
      if (!hit) return null;
      const { cache: made, ...m } = hit.meta;
      if (!size || m.format !== 'meta/0.1' || !isDeepStrictEqual(m.size, size)) return null;
      if (m.shot !== shot.id || m.frame !== frame || m.shotFrame !== frame - shot.in) return null;
      if (m.source?.id !== shot.source || m.source.tier !== tier || made?.key !== entry.key) return null;
      const [w, h] = size;
      if (hit.colorBytes.length !== w * h * 16 || m.hash?.color !== `sha256:${hit.colorSha256}`) return null;
      if (aux.some((name) => !AUX[name] || hit.layers?.[auxFile(name)]?.length !== w * h * 4 * AUX[name][1].length)) return null;
      if (native && Object.entries(NATIVE).some(([name, perPixel]) => !hit.layers?.[name]?.length || (perPixel && hit.layers[name].length !== w * h * perPixel))) return null;
      if (!isDeepStrictEqual(made.layers, digestsOf(hit.layers))) return null;
      if (native && !validNativeExr(hit.layers['frame.exr'], w, h, aux, hit.layers)) return null;
      const sub = join(dir, 'layers', `cache-f${pad(frame - shot.in)}`);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'color.f32'), hit.colorBytes);
      const files = Object.fromEntries(Object.entries(hit.layers).map(([name, bytes]) => [name, join(sub, basename(name))]));
      for (const [name, file] of Object.entries(files)) writeFileSync(file, hit.layers[name]);
      const meta = { ...m, film: film.id, timing: { ...ZERO_TIMING } };
      const metaPath = join(dir, `f${pad(frame)}.meta.json`);
      writeFileSync(metaPath, jsonBytes(meta));
      seams.set(frame, { runId: hit.runId, colorFloats: hit.seam });
      return { frame, shot: shot.id, meta, metaPath, color: join(sub, 'color.f32'), objectId: files['objectId.u32'], files, shape: [h, w, 4], cached: true, cacheEntry: cacheEntryOf(entry) };
    };

    try {
      rekey();
      let moved = false;
      pass: for (;;) {
        mine = [];
        for (const frame of frames) {
          signal?.throwIfAborted();
          const hit = live.get(frame) ?? (keyed && restore(frame));
          if (hit) { mine.push(hit); continue; }
          const rec = await render(frame);
          mine.push(rec);
          if (!keyed) continue;
          // 真渲的这一帧报的显卡后端与记录不一样：改记录，前面照旧环境查到的命中作废，照新环境从头再查（一个镜头只重查一次）
          const seen = deviceOf(rec.meta.source);
          const changed = !moved && !isDeepStrictEqual(seen, device);
          if (changed) { device = seen; saveDevice(cache, shot.source, seen); rekey(); moved = true; }
          store(frame, rec);
          if (changed) continue pass;
        }
        break;
      }
      const mixed = mine.some((rec) => rec.cached);
      if (keyed?.determinism === 'tolerance' && mixed && frames.every((f, i) => !i || f === frames[i - 1] + 1)) {
        const check = checkCacheSeams(frames.map((f) => seams.get(f)), { determinism: 'tolerance' });
        if (!check.ok) {
          cache.invalidateShot(entryOf(frames[0]));
          mine = [];
          for (const frame of frames) {
            const rec = live.get(frame) ?? await render(frame);
            store(frame, rec);
            mine.push(rec);
          }
          seam = 'rerendered';
        } else if (check.checked) seam = 'ok';
      }
    } finally {
      await session?.close();
    }
    const paperLinear = shot.source === 'three' && shot.colorRef === 'display' ? parseHexLinear(film.style?.tokens?.paper) : null;
    convertShot(mine, shot, { dir, fps: film.output.fps, lutPath, paperLinear, embed });
    records.push(...mine);
    if (keyed && frames.length) versions[shot.id] = { entry: entryOf(frames[0]), hit: live.size === 0 };
    shots.push({ shot: shot.id, renderedFrames: live.size, cachedFrames: mine.length - live.size, ...(seam ? { seam } : {}) });
  }
  const sum = (key) => shots.reduce((n, x) => n + x[key], 0);
  return { records, gpuSeconds: gpuMs / 1000, renderedFrames: sum('renderedFrames'), cachedFrames: sum('cachedFrames'), shots, versions };
}

/** 一帧的摘要：主角的屏占、可见比例、四边留白（画幅比例）和在不在 5% 安全框里；亮度分位 */
export function frameSummary(rec, shot) {
  const m = rec.meta;
  const heroName = shot?.roles?.hero;
  const e = (m.entities ?? []).find((x) => x.name === heroName) ?? (m.entities ?? []).find((x) => x.role === 'hero');
  let hero = null;
  if (e) {
    const [w, h] = m.size;
    const margin = Math.min(e.bbox2d[0] / w, e.bbox2d[1] / h, (w - e.bbox2d[2]) / w, (h - e.bbox2d[3]) / h);
    hero = { name: e.name, pxArea: r3(e.pxArea), visible: r3(e.visible), margin: r3(margin), inside: margin >= 0.05 };
  }
  const luma = m.stats?.luma ? { p1: r3(m.stats.luma.p1), p99: r3(m.stats.luma.p99) } : null;
  return { frame: rec.frame, shot: rec.shot, hero, luma };
}

/** 渲出来的帧要给验收和观测读：存成索引（路径相对工作区，带走缓存时的轻量版本键 cacheEntry） */
export function writeIndex(file, root, records, extra = {}) {
  const rel = (p) => relative(root, p).split(sep).join('/');
  const frames = records.map((r) => ({
    frame: r.frame, shot: r.shot, meta: rel(r.metaPath), color: rel(r.color), objectId: rel(r.objectId), shape: r.shape, exr: rel(r.exr), png: rel(r.png),
    ...(r.cacheEntry ? { cacheEntry: r.cacheEntry } : {}),
  }));
  writeFileSync(file, jsonBytes({ format: 'api-render-index/0.1', ...extra, frames }));
}

/** 读回索引：records（绝对路径，带 meta） */
export function readIndex(file, root) {
  const idx = JSON.parse(readFileSync(file, 'utf8'));
  return { ...idx, records: idx.frames.map((f) => ({ ...f, metaPath: join(root, f.meta), meta: JSON.parse(readFileSync(join(root, f.meta), 'utf8')), color: join(root, f.color), objectId: join(root, f.objectId), exr: join(root, f.exr), png: join(root, f.png) })) };
}

/* ---------------- 验收 ---------------- */

/** 镜头文件：build-script / native-code 镜头的入口（相对片子目录） */
export function shotSources(film, filmDir) {
  const out = {};
  for (const s of film.shots ?? []) {
    const r = s.renderer ?? s;
    if (typeof r.entry === 'string' && existsSync(join(filmDir, r.entry))) out[s.id] = { [r.entry]: readFileSync(join(filmDir, r.entry), 'utf8') };
  }
  return out;
}

/** 考题给定的基础断言已过 question 契约，按基础项在 L3 求值。L1 的 extra 检查只针对作者追加的断言。 */
export function layerL1(film, filmDir, rev, question) {
  const required = new Set(question?.basePredicates);
  const extras = film.predicates?.extra;
  const separate = required.size && Array.isArray(extras);
  const input = separate ? { ...film, predicates: { ...film.predicates, extra: extras.filter(x => !required.has(x)) } } : film;
  const res = checkL1(input, { shotSources: filmDir ? shotSources(film, filmDir) : {}, rev });
  const diagnostics = res.diagnostics.map(d => {
    if (separate && d.fix?.op === 'set' && d.fix.path === 'predicates/extra') {
      let i = 0;
      d = { ...d, fix: { ...d.fix, value: extras.map(x => required.has(x) ? x : d.fix.value[i++]) } };
    }
    return diagnostic(d, { layer: 'L1' });
  });
  return { ok: res.ok, diagnostics, fixes: diagnostics.flatMap(d => d.fix ? [d.fix] : []), cost: res.cost };
}

/**
 * L2：每个镜头跑纯函数门（两帧，三种出帧次序）；全部记录跑编号层包围盒核对（IoU ≥ 0.95）。包围盒只读 records 的文件，先核，纯函数门后跑。
 * 一个镜头过了 L2 = 纯函数门过了，并且它的帧没有一张包围盒没过（没带帧号、对不上镜头的失败项算在每个镜头头上）。
 * cache 和 versions（renderPlan 交回的）在交付时给：这一轮全部命中、缓存里又有这一版镜头过了门的记录、记录认的帧（framesColorDigest：
 * 这个镜头全部帧的颜色摘要按帧序连起来的摘要）就是这一轮交出的帧，纯函数门照记录用（门的结论带 cached: true），不起帧源。
 * 要真跑的镜头开跑前先把旧记录盖成未过（门跑到一半断了也不留能复用的旧记录），过了 L2 才记下结论和帧的摘要。
 * 没过 L2 的镜头：这一版的帧和记录当场一起作废（cache.invalidateShot），下一次交付整镜重渲、重新过门；门照记录用的镜头有帧包围盒没过也一样。
 * 单独的核验作业只给 cache、不给 versions：每个镜头都真跑，不读记录、过了也不记；没过同样作废终渲档这一版，再加 records 所在的那一档（tier，核验作业给）。
 * records 里有、shots 没点名的镜头不跑纯函数门，但它的帧包围盒没过时同样作废。两个都不给就只跑门。
 */
export async function layerL2({ film, lock, filmDir, shots, records, pool, scratch, signal, onGpu, cache, versions, tier, engineRoot }) {
  const diagnostics = [];
  const gates = [];
  const events = eventsTable(film);
  const framesData = records.map((r) => {
    const b = readFileSync(r.objectId);
    const [h, w] = r.shape;
    return { frame: r.frame, meta: r.meta, objectId: { width: w, height: h, data: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + w * h * 4)) } };
  });
  const bb = framesData.length ? verifySampledBboxes(framesData) : { ok: false, minIou: null, failures: [{ kind: 'no-samples' }] };
  const shotOfFrame = new Map(records.map((r) => [r.frame, r.shot]));
  const boxFailed = new Set(bb.failures.map((f) => shotOfFrame.get(f.frame))); // 归不到镜头的失败项记成 undefined
  const boxed = (shot) => !boxFailed.has(undefined) && !boxFailed.has(shot.id);
  const failedFrameSet = new Set(bb.failures.map((f) => f.frame).filter(Number.isInteger));
  const hasUnattributedBboxFailure = boxFailed.has(undefined);
  const toInvalidationEntry = (ce) => (
    ce && typeof ce === 'object' && typeof ce.tier === 'string' && typeof ce.shotId === 'string' && typeof ce.shotKey === 'string'
      ? { tier: ce.tier, shotId: ce.shotId, shotKey: ce.shotKey, key: typeof ce.key === 'string' ? ce.key : ce.shotKey }
      : null
  );
  const currentEntry = (shot, t) => {
    try { return entryFrom(buildShotCacheInputs({ film, lock, shot, filmDir, tier: t, events, device: readDevices(cache)[shot.source], engineRoot }), 0); } catch { return undefined; }
  };
  const fallbackEntries = (shot, version) => (
    version
      ? [version.entry]
      : [...new Set(['final', tier ?? 'final'])].map((t) => currentEntry(shot, t)).filter(Boolean)
  );
  // 没过 L2 的镜头要作废的条目：
  // - 包围盒失败（!boxed）：精准定位失败帧携带的 cacheEntry 作废，不误伤同镜头其他版本好帧；无 cacheEntry 时回退当前键；
  // - 纯函数门失败（!gateOk）：作废当前版本键以及记录中对应版本的 cacheEntry。
  const retire = (shot, { gateOk = true } = {}) => {
    if (!cache) return;
    const version = versions?.[shot.id];
    const entries = new Map();
    const addEntry = (e) => {
      const inv = toInvalidationEntry(e);
      if (inv) entries.set(`${inv.tier}\0${inv.shotId}\0${inv.shotKey}`, inv);
    };
    const shotRecords = records.filter((r) => r.shot === shot.id);
    if (!gateOk) {
      for (const e of fallbackEntries(shot, version)) addEntry(e);
      const curKeys = new Set([...entries.values()].map((e) => e.shotKey));
      for (const r of shotRecords) {
        const inv = toInvalidationEntry(r.cacheEntry);
        if (inv && curKeys.has(inv.shotKey)) addEntry(inv);
      }
    }
    if (!boxed(shot)) {
      if (version) addEntry(version.entry);
      if (hasUnattributedBboxFailure) {
        for (const e of fallbackEntries(shot, version)) addEntry(e);
        for (const r of shotRecords) addEntry(r.cacheEntry);
      } else {
        const badRecs = shotRecords.filter((r) => failedFrameSet.has(r.frame));
        let missingCacheEntry = badRecs.length === 0;
        const curDraft = !version && badRecs.some((r) => r.cacheEntry?.tier === 'draft') ? currentEntry(shot, 'draft') : undefined;
        for (const r of badRecs) {
          const inv = toInvalidationEntry(r.cacheEntry);
          if (inv) {
            addEntry(inv);
            if (curDraft && inv.tier === 'draft' && inv.shotKey === curDraft.shotKey) {
              addEntry(currentEntry(shot, 'final'));
            }
          } else {
            missingCacheEntry = true;
          }
        }
        if (missingCacheEntry) {
          for (const e of fallbackEntries(shot, version)) addEntry(e);
        }
      }
    }
    for (const inv of entries.values()) cache.invalidateShot(inv);
  };
  let gpuMs = 0;
  for (const shot of shots) {
    signal?.throwIfAborted();
    const frames = [shot.in, shot.out - 1];
    if (frames[0] === frames[1]) {
      gates.push({ shot: shot.id, status: 'skipped', reason: '纯函数门至少需要两帧' });
      if (!boxed(shot)) retire(shot, { gateOk: true });
      continue;
    }
    const version = cache ? versions?.[shot.id] : undefined;
    const framesColorDigest = version && sha256(records.filter((r) => r.shot === shot.id).map((r) => r.meta.hash?.color).join());
    const known = version?.hit ? cache.getShotVerification(version.entry) : undefined;
    if (known?.l2?.ok === true && known.l2.shot === shot.id && known.framesColorDigest === framesColorDigest) {
      gates.push({ ...known.l2, cached: true });
      if (!boxed(shot)) retire(shot, { gateOk: true });
      continue;
    }
    if (version) cache.putShotVerification(version.entry, { l2: { shot: shot.id, ok: false, status: 'running' } });
    const src = await pool.get(shot.source, 'cpu');
    let n = 0;
    const adapter = {
      open: async () => {
        const ws = join(scratch, `${shot.id}-gate-${n++}`);
        const s = await src.open(shotInput(film, shot.id, events), { lock, tier: 'draft', workspace: ws, filmDir: filmDirOf(shot, filmDir) });
        return {
          render: async (frame) => {
            signal?.throwIfAborted();
            const t0 = monotonicMs();
            const r = await s.render(frame - shot.in, {}, ['color']);
            const elapsed = monotonicMs() - t0;
            gpuMs += elapsed;
            onGpu?.(elapsed / 1000);
            const b = readFileSync(join(ws, r.layers.color.file));
            return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
          },
          close: () => s.close(),
        };
      },
    };
    const g = await runPureFunctionGate(adapter, frames, { compare: 'hash', seed: 1 });
    signal?.throwIfAborted(); // 门把出帧时的错都收成「没过」：作业被取消不是门的结论，不记、也不作废帧
    gates.push({ shot: shot.id, status: g.ok ? 'pass' : 'fail', ok: g.ok, bitExact: g.bitExact, frames: g.frames, mismatches: g.mismatches.length });
    if (!g.ok || !boxed(shot)) retire(shot, { gateOk: g.ok });
    else if (version) cache.putShotVerification(version.entry, { l2: gates.at(-1), framesColorDigest });
    if (!g.ok) {
      diagnostics.push(diagnostic({ code: 'contract.bad-value', layer: 'L2', at: `shots/${shot.id}`, message: `纯函数门没过：同一帧顺序渲、乱序渲、单独渲的颜色层不逐位相同（${g.mismatches.length} 处）`,
        atFrames: g.mismatches.map((m) => m.frame).filter(Number.isInteger), evidence: JSON.stringify(g.mismatches[0]).slice(0, 200), hint: '镜头里有跨帧状态或没带种子的随机：每帧只由时刻决定' }, { layer: 'L2' }));
    }
  }
  for (const shot of film.shots) if (!shots.includes(shot) && boxFailed.has(shot.id)) retire(shot, { gateOk: true });
  for (const f of bb.failures.slice(0, 5)) {
    diagnostics.push(diagnostic({ code: 'contract.bad-value', layer: 'L2', message: `包围盒核对没过：${f.kind}${f.name ? `（${f.name}）` : ''}${Number.isFinite(f.iou) ? `，IoU ${r3(f.iou)} < ${IOU_MIN}` : ''}`,
      ...(Number.isInteger(f.frame) ? { atFrames: [f.frame] } : {}), expected: `元数据 bbox2d 和编号层反算的包围盒 IoU ≥ ${IOU_MIN}` }, { layer: 'L2' }));
  }
  return { ok: gates.length > 0 && gates.every(g => g.ok || g.status === 'skipped') && bb.ok, gates, bbox: { ok: bb.ok, minIou: r3(bb.minIou), frames: framesData.length, failures: bb.failures.length }, diagnostics, gpuSeconds: gpuMs / 1000 };
}

const finiteAudio = (v, floor = -120) => (typeof v === 'number' ? (Number.isFinite(v) ? v : v === -Infinity ? floor : undefined) : undefined);

/** 成片量测：交付规格、响度、黑帧与冻结、切点（YDIF） */
export async function measureMaster(master) {
  const [spec, loud, bfd, cuts] = await Promise.all([deliverSpec(master), audioLoudness(master).catch(() => null), blackFreezeDup(master), cutYdif(master)]);
  const loudnessLufs = finiteAudio(loud?.value);
  const truePeakDbtp = finiteAudio(loud?.details?.truePeakDbtp);
  const audio = {
    ...(loudnessLufs !== undefined ? { loudnessLufs } : {}),
    ...(truePeakDbtp !== undefined ? { truePeakDbtp } : {}),
  };
  return {
    output: spec.value ? { size: [spec.value.width, spec.value.height], fps: spec.details.frameRate, frames: spec.value.frames, colorTag: spec.value.color_space } : undefined,
    blackFrames: bfd.details?.black, freezes: bfd.details?.freezes?.map(([a, b]) => ({ in: a, out: b + 1 })),
    ...(Object.keys(audio).length ? { audio } : {}),
    cuts: cuts.value,
  };
}

const fixOfResult = (r) => (r.fixes ?? []).find((f) => f && typeof f.path === 'string');

/**
 * L3：floor@1（加题目自带的基础谓词）逐条求值、predicates.extra 逐条求值、防削弱守卫。
 * measured 是 { frames: [{ frame, meta }], ...成片量测 }。question 是考题（可以是 null）。entities 是 { 镜头: [实体名] }。
 */
export function layerL3({ film, measured, question, entities }) {
  const diagnostics = [];
  const verdicts = [];
  const add = (result, base) => {
    const v = toVerdict(result, { base });
    if (v.value === null || (typeof v.value === 'number' && !Number.isFinite(v.value))) delete v.value;
    verdicts.push(v);
    if (result.status === 'fail') {
      const fix = fixOfResult(result);
      diagnostics.push(diagnostic({ code: 'contract.bad-value', layer: 'L3', message: `${result.predicate} 判不过`, ...(v.atFrames ? { atFrames: v.atFrames } : {}),
        ...(v.value !== undefined ? { value: v.value } : {}), ...(result.expected ? { expected: String(result.expected) } : {}), ...(fix ? { fix, at: fix.path } : {}) }, { layer: 'L3' }));
    }
  };
  const conditionalSkips = new Set();
  for (const item of evaluateFloor(film, measured)) {
    if (item.status === 'skipped' && !item.results.length) {
      const v = { id: `pred.${item.expr.split('(')[0]}`, layer: 'L3', status: 'skipped', base: true, reason: item.reason };
      conditionalSkips.add(v);
      verdicts.push(v);
    }
    for (const r of item.results) add(r, true);
  }
  const required = new Set(question?.basePredicates ?? []);
  let requiredPass = true;
  for (const text of required) {
    const result = evaluateAssertion(text, film, measured);
    add(result, true);
    if (result.status !== 'pass') requiredPass = false;
    if (result.status === 'skipped') diagnostics.push(diagnostic({ layer: 'L3', message: `考题必验断言 ${text} 缺少证据`, hint: result.reason }));
  }
  for (const text of film.predicates?.extra ?? []) if (!required.has(text)) add(evaluateAssertion(text, film, measured), false);
  const guard = guardPredicates(film, question ? { base: question.basePredicates } : null, { entities });
  for (const v of guard.violations) {
    const fix = v.fixes?.[0];
    diagnostics.push(diagnostic({ code: v.path === 'predicates/base' ? 'auth.base-readonly' : 'contract.bad-value', layer: 'L3', at: v.path, message: `防削弱：${v.code}：${v.message}`, ...(v.hint ? { hint: v.hint } : {}), ...(fix ? { fix } : {}) }, { layer: 'L3' }));
  }
  for (const u of guard.unverified) diagnostics.push(diagnostic({ code: 'contract.bad-value', layer: 'L3', severity: 'warning', at: u.path, message: u.message }, { layer: 'L3', severity: 'warning' }));
  const base = verdicts.filter((v) => v.base);
  const count = (list, s) => list.filter((v) => v.status === s).length;
  return {
    ok: requiredPass && !verdicts.some((v) => v.status === 'fail') && guard.ok,
    basePass: requiredPass && count(base, 'fail') === 0 && guard.ok && !base.some(v => v.status === 'skipped' && !conditionalSkips.has(v)),
    summary: { base: `${count(base, 'pass')}/${base.length}`, baseFail: count(base, 'fail'), skipped: count(verdicts, 'skipped'), extra: `${count(verdicts.filter((v) => !v.base), 'pass')}/${verdicts.filter((v) => !v.base).length}`, guard: guard.ok ? 'pass' : 'fail' },
    verdicts, diagnostics,
  };
}

/** 帧元数据里每个镜头交出的实体名（给防削弱守卫核 hero） */
export const entitiesOf = (records) => {
  const out = {};
  for (const r of records) {
    out[r.shot] ??= new Set();
    for (const e of r.meta.entities ?? []) out[r.shot].add(e.name);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].filter(Boolean)]));
};

/* ---------------- 审片（L5） ---------------- */

/**
 * 审片的输入：需求原文、联系表、切点条带、声音量测表。reviewer 没配置时 status 是 not-run，写明原因；
 * 配置了就交给它，意见原样带回；L5 只是意见，不改硬门的判定。
 */
export async function layerL5({
  reviewer,
  brief,
  images,
  loudness,
  film,
  filmId = null,
  candidates = [],
  question = null,
  budgetCheck = null,
  maxTokens = null,
  signal = null,
}) {
  if (!reviewer) return { status: 'not-run', reason: '服务器没有配置异族视觉审片模型（BEIMING_REVIEW_ENDPOINT、BEIMING_REVIEW_API_KEY、BEIMING_REVIEW_MODEL）', opinions: [], suggestedPredicates: [], overridesHardGates: false };
  const resolvedFilmId = filmId ?? film?.id ?? null;
  let res = null;
  try {
    res = await reviewer.review({
      brief,
      images,
      loudness,
      film: { id: resolvedFilmId ?? film?.id, output: film.output, shots: (film.shots ?? []).map((s) => ({ id: s.id, in: s.in, out: s.out })) },
      filmId: resolvedFilmId,
      candidates,
      ...(typeof budgetCheck === 'function' ? { budgetCheck } : {}),
      ...(maxTokens !== null && maxTokens !== undefined ? { maxTokens } : {}),
      ...(signal ? { signal } : {}),
    });
    if (Array.isArray(res?.ballots)) {
      const invalidBallots = Array.isArray(res.invalidBallots) ? res.invalidBallots : [];
      if (res.ballots.length === 0) {
        if (invalidBallots.length === 0 && res.stoppedReason && res.stoppedReason !== 'budget.check-error') {
          return {
            status: 'not-run',
            reason: `审片因预算或中止条件未发票（${res.stoppedReason}）`,
            stoppedReason: res.stoppedReason,
            ...(res.model ? { model: res.model } : {}),
            totalBallots: 0,
            ...(Number.isSafeInteger(res.plannedBallots) ? { plannedBallots: res.plannedBallots } : {}),
            opinions: [],
            suggestedPredicates: [],
            usage: res.usage ?? null,
            overridesHardGates: false,
          };
        }
        return {
          status: 'failed',
          reason: invalidBallots[0]?.reason || (res.stoppedReason ? `审片已停止（${res.stoppedReason}），未获得有效选票` : '所有审片选票均无效'),
          ...(res.stoppedReason ? { stoppedReason: res.stoppedReason } : {}),
          ...(res.model ? { model: res.model } : {}),
          totalBallots: 0,
          ...(Number.isSafeInteger(res.plannedBallots) ? { plannedBallots: res.plannedBallots } : {}),
          ...(invalidBallots.length ? { invalidBallots } : {}),
          opinions: [],
          suggestedPredicates: [],
          usage: res.usage ?? null,
          overridesHardGates: false,
        };
      }
      const aggregated = aggregateL5Votes(res.ballots, {
        totalFrames: film?.output?.frames,
        film,
        question,
        candidates,
      });
      return {
        status: 'ok',
        model: res.model,
        ...aggregated,
        ...(Number.isSafeInteger(res.plannedBallots) ? { plannedBallots: res.plannedBallots } : {}),
        ...(invalidBallots.length ? { invalidBallots } : {}),
        ...(res.stoppedReason ? { stoppedReason: res.stoppedReason } : {}),
        usage: res.usage ?? null,
        overridesHardGates: false,
      };
    }
    const validated = validateReview(res, film?.output?.frames);
    const filtered = filterL5SuggestedPredicates(validated.suggestedPredicates, {
      film,
      question,
      ...(Number.isSafeInteger(film?.output?.frames) ? { totalFrames: film.output.frames } : {}),
    });
    return {
      status: 'ok',
      model: res.model,
      ...validated,
      suggestedPredicates: filtered.suggestedPredicates,
      validatedExtraPredicates: filtered.validatedExtraPredicates,
      rejectedPredicates: filtered.rejectedPredicates,
      usage: res.usage ?? null,
      overridesHardGates: false,
    };
  } catch (e) {
    const rawUsage = res?.usage ?? e?.usage ?? null;
    const usage = rawUsage && typeof rawUsage === 'object'
      ? {
        inputTokens: rawUsage.inputTokens ?? 0,
        outputTokens: rawUsage.outputTokens ?? 0,
        totalTokens: rawUsage.totalTokens ?? ((rawUsage.inputTokens ?? 0) + (rawUsage.outputTokens ?? 0)),
      }
      : null;
    const invalidBallots = Array.isArray(res?.invalidBallots) && res.invalidBallots.length ? res.invalidBallots : null;
    return {
      status: 'failed',
      reason: reviewFailure(e),
      ...(res?.stoppedReason ? { stoppedReason: res.stoppedReason } : {}),
      ...(invalidBallots ? { invalidBallots } : {}),
      opinions: [],
      suggestedPredicates: [],
      ...(usage ? { usage } : {}),
      overridesHardGates: false,
    };
  }
}

const MAX_REVIEW_KEYFRAMES = 4;

/** 按镜头中点挑选审片原尺寸关键帧帧号（多镜头时均匀上限 4 帧，去重升序） */
export function reviewKeyframeNumbers(film, maxCount = MAX_REVIEW_KEYFRAMES) {
  const totalFrames = Number.isSafeInteger(film?.output?.frames) && film.output.frames > 0 ? film.output.frames : null;
  const clamp = (f) => (totalFrames !== null ? Math.min(totalFrames - 1, Math.max(0, f)) : Math.max(0, f));
  const mids = [];
  for (const shot of film?.shots ?? []) {
    if (Number.isSafeInteger(shot?.in) && Number.isSafeInteger(shot?.out) && shot.out > shot.in) {
      mids.push(clamp(Math.floor((shot.in + shot.out - 1) / 2)));
    }
  }
  let unique = [...new Set(mids)].sort((a, b) => a - b);
  if (!unique.length && totalFrames !== null) {
    unique = [Math.floor((totalFrames - 1) / 2)];
  }
  const limit = Number.isSafeInteger(maxCount) && maxCount > 0 ? maxCount : MAX_REVIEW_KEYFRAMES;
  if (unique.length <= limit) return unique;
  if (limit === 1) return [unique[Math.floor((unique.length - 1) / 2)]];
  const picked = Array.from({ length: limit }, (_, i) => unique[Math.round((i * (unique.length - 1)) / (limit - 1))]);
  return [...new Set(picked)];
}

/** 审片材料：联系表 + 切点条带 + 未缩放原尺寸关键帧（从成片按镜头中点取，最多 4 帧） */
export function reviewMaterials({ master, fps, film, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const images = [];
  const sheet = buildContactSheet({ video: master, fps, out: join(outDir, 'contact.png'), count: 12, cellWidth: 160 });
  if (sheet.ok) images.push({ name: 'contact', path: sheet.outputs[0] });
  if ((film.transitions ?? []).length) {
    const strips = buildCutStrips({ video: master, fps, transitions: film.transitions, outDir: join(outDir, 'cuts') });
    if (strips.ok) for (const p of strips.outputs ?? []) images.push({ name: 'cut', path: p });
  }
  const keyFrames = reviewKeyframeNumbers(film);
  if (keyFrames.length) {
    const kfDir = join(outDir, 'keyframes');
    rmSync(kfDir, { recursive: true, force: true });
    mkdirSync(kfDir, { recursive: true });
    try {
      const { ffmpeg } = compTools();
      const rawFps = fps ?? film?.output?.fps;
      const rate = typeof rawFps === 'number' && Number.isFinite(rawFps) && rawFps > 0
        ? String(rawFps)
        : (() => { const p = parseFps(rawFps); return `${p.num}/${p.den}`; })();
      const select = keyFrames.map((n) => `eq(n\\,${n})`).join('+');
      runTool(ffmpeg, [
        '-hide_banner', '-nostdin', '-v', 'error', '-y',
        '-i', master,
        '-map', '0:v:0',
        '-vf', `fps=fps=${rate},select=${select}`,
        '-fps_mode', 'passthrough',
        '-frames:v', String(keyFrames.length),
        '-c:v', 'png',
        '-start_number', '0',
        join(kfDir, 'tmp-%04d.png'),
      ], { what: '原尺寸审片关键帧' });
      for (let i = 0; i < keyFrames.length; i++) {
        const src = join(kfDir, `tmp-${pad(i)}.png`);
        if (!existsSync(src)) continue;
        const name = `keyframe-f${keyFrames[i]}`;
        const dest = join(kfDir, `${name}.png`);
        renameSync(src, dest);
        images.push({ name, path: dest });
      }
    } catch {
      // 抽帧失败时清理临时目录，不阻断已产出的联系表与切点条带
      rmSync(kfDir, { recursive: true, force: true });
    }
  }
  return images;
}

/* ---------------- 交付 ---------------- */

/** 六件套：final 档全部帧的 EXR 序列 → comp.deliver */
export function deliverBundle({ film, lock, records, lutPath, outDir }) {
  const frames = {};
  for (const shot of film.shots) {
    const mine = records.filter((r) => r.shot === shot.id);
    if (mine.length !== shot.out - shot.in) throw coded('contract.delivery-mismatch', `镜头 ${shot.id} 终渲帧数 ${mine.length}，应为 ${shot.out - shot.in}`);
    frames[shot.id] = { pattern: join(mine[0].exr, '..', 'l%04d.exr'), start: 0, kind: 'exr', transfer: 'linear' };
  }
  return compDeliver({ film, events: eventsTable(film), lock, frames, view: { lutPath, shaper: VIEW_SHAPER }, outDir, tier: 'final' });
}

/**
 * 把 L2–L5 的复核写进 report.json 的 verification 键，同时对齐顶层 ok 与 verification.ok 并紧邻写出
 * unresolvedReviewOpinions（成立 L5 审片意见条数），再照 comp 的完整性规则重新锚定：
 * run.json 的 reportBodySha256 换成新报告正文（不含 run.json 那一项）的摘要，报告里 run.json 的字节数与摘要跟着更新。
 * 写完用 comp 的 verifyDeliveryBundle 自查一遍。
 */
export function writeVerification(dir, verification) {
  const rawReport = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const l5Opinions = Array.isArray(verification?.L5?.opinions)
    ? verification.L5.opinions
    : (Array.isArray(verification?.layers?.L5?.opinions) ? verification.layers.L5.opinions : []);
  const unresolvedReviewOpinions = l5Opinions.length;
  const {
    format,
    film,
    delivery,
    ok: prevOk,
    unresolvedReviewOpinions: _prevUnresolved,
    checks,
    probes,
    loudness,
    files,
    verification: _prevVerification,
    ...rest
  } = rawReport;
  const filesWithoutRun = { ...files };
  delete filesWithoutRun['run.json'];
  const report = {
    ...(format !== undefined ? { format } : {}),
    ...(film !== undefined ? { film } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    ok: Boolean(prevOk && verification?.ok !== false),
    unresolvedReviewOpinions,
    ...(checks !== undefined ? { checks } : {}),
    ...(probes !== undefined ? { probes } : {}),
    ...(loudness !== undefined ? { loudness } : {}),
    files: filesWithoutRun,
    ...rest,
    verification,
  };
  run.reportBodySha256 = sha256(jsonBytes(report));
  const runBytes = jsonBytes(run);
  writeFileSync(join(dir, 'run.json'), runBytes);
  report.files = { ...filesWithoutRun, 'run.json': { bytes: runBytes.length, sha256: sha256(runBytes) } };
  writeFileSync(join(dir, 'report.json'), jsonBytes(report));
  return verifyDeliveryBundle(dir);
}


export const listDir = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
