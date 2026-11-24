// 服务端的运行环境：卡库、外部工具（Blender、FFmpeg、无头浏览器）在不在、agx-mhc 查找表、签锁要的资源目录。
// 这里只认识环境，不认识请求。找不到的工具交回 null，由调用方报 env.missing-tool / env.ffmpeg-missing。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools as compTools, bakeAgxLut, SHAPER } from '../comp/index.mjs';
import { findBlender } from '../sources/blender/host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BEIMING = join(HERE, '..');
const REPO = join(BEIMING, '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 求值核与契约集的版本：kernel/eval 和契约目录没有导出版本常量，这里照卡文件验证记录里写的版本（0.1.0）
export const KERNEL_EVAL_VERSION = '0.1.0';
export const CONTRACTS_VERSION = '0.1.0';
export const THREE_VERSION = '0.187.0';
/** comp 分流拼接的对数整形参数（stitch 的写法），取自查找表烘焙的常数 */
export const VIEW_SHAPER = Object.freeze({ minEv: SHAPER.minStops, maxEv: SHAPER.maxStops, mid: SHAPER.midGray });

/** 读 beiming/cards 下的全部卡：{ 卡名: { card, dir（相对 beiming/）, files: { 相对路径: 字节 } } } */
export function loadCardLibrary() {
  const root = join(BEIMING, 'cards');
  const out = {};
  for (const p of readdirSync(root, { recursive: true }).filter((x) => String(x).endsWith('card.json')).sort()) {
    const abs = join(root, dirname(String(p)));
    const card = JSON.parse(readFileSync(join(abs, 'card.json'), 'utf8'));
    const files = {};
    for (const e of readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (e.isFile()) files[relative(abs, join(e.parentPath, e.name)).split(sep).join('/')] = readFileSync(join(e.parentPath, e.name));
    }
    out[card.id] = { card, dir: relative(BEIMING, abs).split(sep).join('/'), files };
  }
  return out;
}

let blenderCache;
let blenderEnvKey;
/** Blender：{ bin, version }；找不到是 null（按当前 BEIMING_BLENDER 环境变量缓存） */
export function blenderInfo() {
  const envKey = process.env.BEIMING_BLENDER ?? '';
  if (blenderCache !== undefined && blenderEnvKey === envKey) return blenderCache;
  blenderEnvKey = envKey;
  const bin = findBlender();
  if (!bin) return (blenderCache = null);
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60000 });
  const m = /Blender\s+(\d+\.\d+\.\d+)/.exec(r.stdout ?? '');
  blenderCache = m ? { bin, version: m[1] } : null;
  return blenderCache;
}

let ffmpegCache;
/** FFmpeg 和 ffprobe 都跑得起来才算有 */
export function hasFfmpeg() {
  if (ffmpegCache !== undefined) return ffmpegCache;
  const { ffmpeg, ffprobe } = compTools();
  ffmpegCache = [ffmpeg, ffprobe].every((bin) => spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 20000 }).status === 0);
  return ffmpegCache;
}

const SKIP_DIRS = new Set(['out', '__pycache__', '.git', 'node_modules']);
const isSkippedRuntimeFile = (name) => /\.test\./i.test(name) || /\.md$/i.test(name);
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function collectRuntimeFiles(dir, root, out = []) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name));
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collectRuntimeFiles(abs, root, out);
    } else if (e.isFile() || (e.isSymbolicLink() && statSync(abs, { throwIfNoEntry: false })?.isFile())) {
      if (!isSkippedRuntimeFile(e.name)) {
        out.push({ rel: relative(root, abs).split(sep).join('/'), abs });
      }
    }
  }
  return out;
}

function engineCodeDirs(source) {
  const dirs = ['beiming/kernel/eval', 'routes/c-style/fonts'];
  if (source === 'three') {
    dirs.push('beiming/sources/three', 'beiming/host/page');
  } else if (source === 'blender') {
    dirs.push('beiming/sources/blender');
  } else if (typeof source === 'string' && /^[a-zA-Z0-9_-]+$/.test(source)) {
    dirs.push(`beiming/sources/${source}`);
  }
  return dirs;
}

/**
 * 实时计算指定帧源依赖的引擎运行时代码与锁定字体摘要（严禁模块级/启动期缓存）。
 * 每次调用按 POSIX 相对路径确定性排序并同时哈希路径与内容，跳过测试、文档与产物目录。
 */
export function engineCodeDigest(source, { root = REPO } = {}) {
  const src = typeof source === 'string' ? source : '';
  const dirs = engineCodeDirs(src);
  const filesByRel = new Map();
  const h = createHash('sha256');
  h.update(`engine-code-digest/1\0source:${src}\0`);
  for (const dir of dirs) {
    const absDir = join(root, dir);
    const exists = Boolean(statSync(absDir, { throwIfNoEntry: false })?.isDirectory());
    h.update(`dir:${dir}\0${exists ? 'present' : 'missing'}\0`);
    if (exists) {
      for (const item of collectRuntimeFiles(absDir, root)) filesByRel.set(item.rel, item.abs);
    }
  }
  for (const rel of [...filesByRel.keys()].sort(byCodePoint)) {
    const bytes = readFileSync(filesByRel.get(rel));
    h.update(`file:${rel}\0${bytes.length}\0`);
    h.update(bytes);
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

function findCardDirs(cardsRoot, wanted) {
  const found = new Map();
  if (!wanted.size || !statSync(cardsRoot, { throwIfNoEntry: false })?.isDirectory()) return found;
  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name));
    const hasCardJson = entries.some((e) => e.name === 'card.json'
      && (e.isFile() || (e.isSymbolicLink() && statSync(join(dir, e.name), { throwIfNoEntry: false })?.isFile())));
    if (hasCardJson) {
      try {
        const card = JSON.parse(readFileSync(join(dir, 'card.json'), 'utf8'));
        if (typeof card?.id === 'string' && wanted.has(card.id)) {
          const list = found.get(card.id) ?? [];
          list.push(dir);
          found.set(card.id, list);
        }
      } catch { /* 忽略无关目录中无法解析的 card.json */ }
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
    }
  }
  walk(cardsRoot);
  return found;
}

/**
 * 按次实时哈希给定 cardIds 在 beiming/cards/ 对应目录的非测试运行时文件（不缓存、不扫描无关卡）。
 * 找不到的合成测试卡名确定性标记为 missing。
 */
export function liveCardsDigest(cardIds, { root = REPO } = {}) {
  const ids = [...new Set([...(cardIds ?? [])].filter((id) => typeof id === 'string' && id.length > 0))].sort(byCodePoint);
  const h = createHash('sha256');
  h.update('live-cards-digest/1\0');
  if (!ids.length) {
    h.update('empty\0');
    return `sha256:${h.digest('hex')}`;
  }
  const found = findCardDirs(join(root, 'beiming', 'cards'), new Set(ids));
  for (const id of ids) {
    const dirs = found.get(id);
    if (!dirs?.length) {
      h.update(`card:${id}\0missing\0`);
      continue;
    }
    h.update(`card:${id}\0present\0`);
    const filesByRel = new Map();
    for (const dir of dirs) {
      for (const item of collectRuntimeFiles(dir, root)) filesByRel.set(item.rel, item.abs);
    }
    for (const rel of [...filesByRel.keys()].sort(byCodePoint)) {
      const bytes = readFileSync(filesByRel.get(rel));
      h.update(`file:${rel}\0${bytes.length}\0`);
      h.update(bytes);
      h.update('\0');
    }
  }
  return `sha256:${h.digest('hex')}`;
}

/** 页面宿主用的 three 构建产物与实时引擎/字体代码摘要（锁里 sources.three.image） */
export function threeImage(opts = {}) {
  const root = opts?.root ?? REPO;
  const file = join(root, 'node_modules/three-webgpu/build/three.module.js');
  const upstream = existsSync(file) ? sha256(readFileSync(file)) : sha256(Buffer.from(`three ${THREE_VERSION}`));
  const code = engineCodeDigest('three', { root });
  return `sha256:${sha256(Buffer.from(`three\0${THREE_VERSION}\0${upstream}\0${code}\0`))}`;
}

/** Blender 的运行环境与实时引擎/字体代码摘要（锁里 sources.blender.image） */
export function blenderImage(version, opts = {}) {
  const root = opts?.root ?? REPO;
  const base = sha256(Buffer.from(`blender ${version} cycles`));
  const code = engineCodeDigest('blender', { root });
  return `sha256:${sha256(Buffer.from(`blender\0${version}\0${base}\0${code}\0`))}`;
}

/** 纯 JS 确定性解析式 AgX 对数整形三维查找表（无 Blender 裸机环境兜底，输入已在 SHAPER 对数域 [0, 1]）。 */
export function analyticAgxCube(gridSize = 33) {
  const curve = (t) => {
    const x = Math.min(1, Math.max(0, t));
    const x2 = x * x;
    const x4 = x2 * x2;
    return Math.min(1, Math.max(0, 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232));
  };
  const step = 1 / (gridSize - 1);
  const table = Array.from({ length: gridSize }, (_, i) => curve(i * step).toFixed(6));
  const lines = ['TITLE "agx-mhc"', `LUT_3D_SIZE ${gridSize}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let b = 0; b < gridSize; b++) {
    for (let g = 0; g < gridSize; g++) {
      for (let r = 0; r < gridSize; r++) lines.push(`${table[r]} ${table[g]} ${table[b]}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * agx-mhc 查找表：有 Blender（或已有正式表）时读写 dataDir/view/agx-mhc.cube（65³ OCIO 烘焙）；
 * 无 Blender 且尚无正式表时将纯 JS 兜底表单独写到 agx-mhc.fallback.cube，绝不污染正式表路径，恢复 Blender 后自动烘正式 65³ 表。
 */
const lutPromises = new Map();
export function ensureLut(dataDir) {
  const b = blenderInfo();
  const realPath = join(dataDir, 'view', 'agx-mhc.cube');
  if (b || existsSync(realPath)) {
    if (!lutPromises.has(realPath)) {
      lutPromises.set(realPath, (async () => {
        if (!existsSync(realPath)) {
          mkdirSync(dirname(realPath), { recursive: true });
          await bakeAgxLut({ blenderBin: b.bin, gridSize: 65, outPath: realPath });
        }
        return { path: realPath, sha256: `sha256:${sha256(readFileSync(realPath))}`, fallback: false };
      })().catch((e) => { lutPromises.delete(realPath); throw e; }));
    }
    return lutPromises.get(realPath);
  }
  const fbPath = join(dataDir, 'view', 'agx-mhc.fallback.cube');
  if (!lutPromises.has(fbPath)) {
    lutPromises.set(fbPath, (async () => {
      if (!existsSync(fbPath)) {
        mkdirSync(dirname(fbPath), { recursive: true });
        const tmp = `${fbPath}.tmp`;
        writeFileSync(tmp, analyticAgxCube());
        renameSync(tmp, fbPath);
      }
      return { path: fbPath, sha256: `sha256:${sha256(readFileSync(fbPath))}`, fallback: true };
    })().catch((e) => { lutPromises.delete(fbPath); throw e; }));
  }
  return lutPromises.get(fbPath);
}

/**
 * 签锁要的资源目录（kernel/lock-gen.mjs 的 context）。缺 Blender 时 blender 帧源不进目录，片子用到它签锁会失败。
 * lut 是 ensureLut 的结果（可以是 null：没有查找表签不了锁）。
 */
export function lockContext({ rev, library, lut, assets, machine = { class: 'local', driver: process.platform }, root }) {
  const opts = root ? { root } : undefined;
  const sources = { three: { version: THREE_VERSION, host: 'page', image: threeImage(opts) } };
  const b = blenderInfo();
  if (b) sources.blender = { version: b.version, host: 'cycles', image: blenderImage(b.version, opts) };
  const compVer = library['comp.display']?.card?.status?.find((s) => s.host === 'node')?.source ?? process.versions.node;
  const sameMinor = (a, c) => typeof a === 'string' && typeof c === 'string' && a.split('.').slice(0, 2).join('.') === c.split('.').slice(0, 2).join('.');
  return {
    issuer: 'server', contracts: CONTRACTS_VERSION, rev, machine, sources,
    cards: Object.fromEntries(Object.entries(library).map(([id, { card, files }]) => {
      const status = b && card.livesIn.includes('source:blender') && !card.status.some((s) => s.host === 'cycles' && s.source === b.version)
        && card.status.some((s) => s.host === 'cycles' && sameMinor(s.source, b.version))
        ? [...card.status, { ...card.status.find((s) => s.host === 'cycles'), source: b.version }]
        : card.status;
      return [id, { version: card.version, impl: [...card.livesIn], files, status }];
    })),
    tools: { data: { host: 'kernel-eval', version: KERNEL_EVAL_VERSION }, comp: { host: 'node', version: compVer } },
    assets, view: lut ? { 'agx-mhc': readFileSync(lut.path) } : {}, templates: { floor: '1.0.0' },
  };
}

/** 交给 three 帧源的卡目录：落点在 three 的卡，加相机样条（数据卡里唯一在 three 有地方写的） */
export const threeCardDirs = (library) => Object.values(library)
  .filter(({ card }) => card.livesIn.includes('source:three') || card.id === 'camera.spline').map((c) => c.dir).sort();

export const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
