// 服务端的运行环境：卡库、外部工具（Blender、FFmpeg、无头浏览器）在不在、agx-mhc 查找表、签锁要的资源目录。
// 这里只认识环境，不认识请求。找不到的工具交回 null，由调用方报 env.missing-tool / env.ffmpeg-missing。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** 页面宿主用的 three 构建产物的摘要（锁里 sources.three.image） */
export function threeImage() {
  const file = join(REPO, 'node_modules/three-webgpu/build/three.module.js');
  return `sha256:${sha256(existsSync(file) ? readFileSync(file) : Buffer.from(`three ${THREE_VERSION}`))}`;
}

/** Blender 的运行环境摘要：没有容器镜像时取「Blender 版本 + cycles」这段描述的摘要 */
export const blenderImage = (version) => `sha256:${sha256(Buffer.from(`blender ${version} cycles`))}`;

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
export function lockContext({ rev, library, lut, assets, machine = { class: 'local', driver: process.platform } }) {
  const sources = { three: { version: THREE_VERSION, host: 'page', image: threeImage() } };
  const b = blenderInfo();
  if (b) sources.blender = { version: b.version, host: 'cycles', image: blenderImage(b.version) };
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
