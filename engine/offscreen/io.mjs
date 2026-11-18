// 北冥引擎 · 离屏出片 · 同源跨端 I/O、PNG 解码与 2D 画布/字体底座（浏览器 Chrome WebGPU 与 Node + Dawn 共用）：
// 顶层不静态 import 任何 node:* 或 @napi-rs/canvas，确保同一份作品模块在浏览器 ES Module 与 Node 中零分叉加载。
//   IS_NODE / REPO_URL                                 运行环境判别与仓库根 URL
//   resolveNodePath(ref, base)                         Node 侧把 URL / 仓库根路径 / 相对路径解析成本机绝对路径
//   resolveBrowserUrl(ref, base) / joinRef(dir, sub, base)   浏览器侧解析同源 URL 与子路径拼接
//   readBytes(ref, base) / readBytesSync(ref, base)    异步同源读字节（浏览器 fetch，Node fs）与 Node 同步读字节
//   readJson(ref, base) / readJsonSync(ref, base)      异步同源读 JSON 与 Node 同步读 JSON
//   decodeRgbaPng(bytes) / decodeRgbaPngSync(bytes)    8/16 位非隔行 PNG（色彩类型 0/2/3/4/6）→ RGBA8 Uint8Array（与 tools/plates/png.mjs 同口径）
//   decodeLayerPng(bytes) / decodeLayerPngSync(bytes)  8/16 位非隔行灰度/RGB/RGBA PNG → Uint8Array 或 Uint16Array（与 engine/look/layers.js 同口径）
//   loadCanvasIso()                                    Node 调 ./canvas.mjs（Skia + QA 探针），浏览器返回原生 <canvas> 工厂
//   loadFilmFontsIso(dirRef, base)                     Node 调 ./canvas.mjs 注册子集，浏览器调 engine/style/fonts.js 注册 FontFace
//   registerCanvasFontsIso(specs, { baseDir, base, glyphs })   C 路线单文件或分片 woff2 清单按码位跨端按需加载
import { loadFilmFonts as loadBrowserFilmFonts } from '../style/fonts.js';

export const IS_NODE = typeof globalThis.window === 'undefined'
  && typeof globalThis.process !== 'undefined'
  && !!(globalThis.process.versions && globalThis.process.versions.node);

export const REPO_URL = new globalThis.URL('../../', import.meta.url);

function nodeBuiltins() {
  const get = IS_NODE && globalThis.process.getBuiltinModule;
  if (!get) throw new Error('同步文件与 Node 原生模块只能在 Node ≥ 22.3 中调用；浏览器侧请改用异步同源接口');
  return {
    fs: get('node:fs'),
    path: get('node:path'),
    url: get('node:url'),
    zlib: get('node:zlib'),
  };
}

const asDirUrlStr = s => (String(s).endsWith('/') ? String(s) : `${s}/`);

export function resolveNodePath(ref, base) {
  const { fs, path, url } = nodeBuiltins();
  const repoRoot = url.fileURLToPath(REPO_URL);
  if (ref instanceof globalThis.URL) {
    if (ref.protocol === 'file:') return url.fileURLToPath(ref);
    throw new Error(`resolveNodePath 不支持非 file 协议 URL：${ref.href}`);
  }
  const str = String(ref ?? '');
  if (str.startsWith('file://')) return url.fileURLToPath(str);
  if (path.isAbsolute(str)) {
    if (fs.existsSync(str)) return str;
    if (str.startsWith('/') && !str.startsWith('//')) {
      const candidate = path.join(repoRoot, str.replace(/^\/+/, ''));
      if (fs.existsSync(candidate)) return candidate;
    }
    return str;
  }
  if (base !== undefined && base !== null) {
    if (base instanceof globalThis.URL || String(base).startsWith('file://')) {
      return url.fileURLToPath(new globalThis.URL(str, base));
    }
    return path.resolve(String(base), str);
  }
  const cwdAbs = path.resolve(str);
  if (fs.existsSync(cwdAbs)) return cwdAbs;
  const repoAbs = path.resolve(repoRoot, str);
  if (fs.existsSync(repoAbs)) return repoAbs;
  return cwdAbs;
}

export function resolveBrowserUrl(ref, base) {
  if (ref instanceof globalThis.URL) return ref;
  const str = String(ref ?? '');
  if (/^https?:\/\//i.test(str)) return new globalThis.URL(str);
  if (str.startsWith('/')) return new globalThis.URL(str.replace(/^\/+/, ''), REPO_URL);
  if (base !== undefined && base !== null) {
    const b = base instanceof globalThis.URL ? base : resolveBrowserUrl(base);
    return new globalThis.URL(str, b);
  }
  return new globalThis.URL(str, REPO_URL);
}

export function resolveBrowserDirUrl(dirRef, base) {
  const u = resolveBrowserUrl(dirRef, base);
  return u.href.endsWith('/') ? u : new globalThis.URL(`${u.href}/`);
}

export function joinRef(dirRef, sub, base) {
  const cleanSub = String(sub).replace(/^\/+/, '');
  if (IS_NODE) {
    const { path } = nodeBuiltins();
    const d = resolveNodePath(dirRef, base);
    return path.join(d, cleanSub);
  }
  return new globalThis.URL(cleanSub, resolveBrowserDirUrl(dirRef, base));
}

export function readBytesSync(ref, base) {
  const { fs } = nodeBuiltins();
  const file = resolveNodePath(ref, base);
  const buf = fs.readFileSync(file);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export async function readBytes(ref, base) {
  if (IS_NODE) {
    if (ref instanceof globalThis.URL && /^https?:$/i.test(ref.protocol)) {
      const r = await globalThis.fetch(ref);
      if (!r.ok) throw new Error(`读不到 ${ref.href}（HTTP ${r.status}）`);
      return new Uint8Array(await r.arrayBuffer());
    }
    if (typeof ref === 'string' && /^https?:\/\//i.test(ref)) {
      const r = await globalThis.fetch(ref);
      if (!r.ok) throw new Error(`读不到 ${ref}（HTTP ${r.status}）`);
      return new Uint8Array(await r.arrayBuffer());
    }
    return readBytesSync(ref, base);
  }
  const u = resolveBrowserUrl(ref, base);
  const r = await globalThis.fetch(u);
  if (!r.ok) throw new Error(`读不到 ${u.pathname}（HTTP ${r.status}）`);
  return new Uint8Array(await r.arrayBuffer());
}

export function readJsonSync(ref, base) {
  const { fs } = nodeBuiltins();
  const file = resolveNodePath(ref, base);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function readJson(ref, base) {
  if (IS_NODE && !(ref instanceof globalThis.URL && /^https?:$/i.test(ref.protocol)) && !(typeof ref === 'string' && /^https?:\/\//i.test(ref))) {
    return readJsonSync(ref, base);
  }
  const bytes = await readBytes(ref, base);
  return JSON.parse(new globalThis.TextDecoder('utf-8').decode(bytes));
}

// ── PNG 解码（纯 Uint8Array + DataView，Node 用 zlib.inflateSync，浏览器用 DecompressionStream('deflate')） ──
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

function parsePngChunks(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || PNG_SIG.some((b, i) => u8[i] !== b)) throw new Error('不是 PNG 文件（文件头不对）');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 8, ihdr = null, plte = null, trns = null, sawIend = false;
  const idat = [];
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    if (p + 12 + len > u8.length) throw new Error(`PNG 被截断（${type} 块不完整）`);
    const data = u8.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { sawIend = true; break; }
    p += 12 + len;
  }
  if (!sawIend) throw new Error('PNG 没有 IEND（文件不完整）');
  if (!ihdr || ihdr.length < 13) throw new Error('PNG 缺 IHDR');
  const hdv = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const width = hdv.getUint32(0), height = hdv.getUint32(4), depth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of idat) { joined.set(c, off); off += c.length; }
  return { width, height, depth, colorType, interlace, plte, trns, joined };
}

function inflateSyncNode(joined) {
  const { zlib } = nodeBuiltins();
  const buf = zlib.inflateSync(joined);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function inflateIso(joined) {
  if (IS_NODE) return inflateSyncNode(joined);
  const stream = new globalThis.Blob([joined]).stream().pipeThrough(new globalThis.DecompressionStream('deflate'));
  return new Uint8Array(await new globalThis.Response(stream).arrayBuffer());
}

function unfilterScanlines(raw, width, height, bpp) {
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error('PNG 像素数据不完整');
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = y * (stride + 1) + 1, cur = y * stride, prev = cur - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[cur + i - bpp] : 0;
      const b = y ? px[prev + i] : 0;
      const c = i >= bpp && y ? px[prev + i - bpp] : 0;
      const x = raw[line + i];
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) v = x + paeth(a, b, c);
      else throw new Error(`第 ${y} 行的滤波类型 ${f} 不合法`);
      px[cur + i] = v & 255;
    }
  }
  return px;
}

function finishRgbaPng(meta, raw) {
  const { width: W, height: H, depth, colorType: ct, interlace, plte, trns } = meta;
  const ch = PNG_CHANNELS[ct];
  if (!ch) throw new Error(`不认识的 PNG 色彩类型 ${ct}`);
  if (interlace) throw new Error('不支持隔行扫描（Adam7）的 PNG：先另存为非隔行');
  if (depth !== 8 && depth !== 16) throw new Error(`不支持位深 ${depth}：先转成 8 位 PNG`);
  if (ct === 3 && !plte) throw new Error('索引色 PNG 缺 PLTE');
  const bpp = ch * depth / 8, stride = W * bpp;
  const px = unfilterScanlines(raw, W, H, bpp);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const rowOff = y * stride;
    for (let x = 0; x < W; x++) {
      const s = rowOff + x * bpp, o = (y * W + x) * 4;
      const v = k => px[s + k * (depth / 8)];   // 16 位取高字节（同 tools/plates/png.mjs）
      if (ct === 6) { out[o] = v(0); out[o + 1] = v(1); out[o + 2] = v(2); out[o + 3] = v(3); }
      else if (ct === 2) { out[o] = v(0); out[o + 1] = v(1); out[o + 2] = v(2); out[o + 3] = 255; }
      else if (ct === 0) { out[o] = out[o + 1] = out[o + 2] = v(0); out[o + 3] = 255; }
      else if (ct === 4) { out[o] = out[o + 1] = out[o + 2] = v(0); out[o + 3] = v(1); }
      else { const idx = px[s]; out[o] = plte[idx * 3]; out[o + 1] = plte[idx * 3 + 1]; out[o + 2] = plte[idx * 3 + 2]; out[o + 3] = trns && idx < trns.length ? trns[idx] : 255; }
    }
  }
  return { width: W, height: H, channels: 4, data: out };
}

function finishLayerPng(meta, raw) {
  const { width, height, depth, colorType: ctype, interlace } = meta;
  const chMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = chMap[ctype];
  if (!channels || (depth !== 8 && depth !== 16) || interlace !== 0) {
    throw new Error(`只支持 8 / 16 位非隔行的灰度、RGB、RGBA PNG（收到颜色类型 ${ctype}、${depth} 位、隔行=${interlace}）`);
  }
  const bpp = channels * depth / 8;
  const px = unfilterScanlines(raw, width, height, bpp);
  let data = px;
  if (depth === 16) {
    data = new Uint16Array(width * height * channels);
    for (let i = 0; i < data.length; i++) data[i] = (px[2 * i] << 8) | px[2 * i + 1];
  }
  return { width, height, channels, depth, data };
}

export function decodeRgbaPngSync(bytes) {
  const meta = parsePngChunks(bytes);
  return finishRgbaPng(meta, inflateSyncNode(meta.joined));
}

export async function decodeRgbaPng(bytes) {
  const meta = parsePngChunks(bytes);
  return finishRgbaPng(meta, await inflateIso(meta.joined));
}

export function decodeLayerPngSync(bytes) {
  const meta = parsePngChunks(bytes);
  return finishLayerPng(meta, inflateSyncNode(meta.joined));
}

export async function decodeLayerPng(bytes) {
  const meta = parsePngChunks(bytes);
  return finishLayerPng(meta, await inflateIso(meta.joined));
}

// ── 2D 画布与字体跨端加载 ──
export function rangeCoversAny(unicodeRange, codepoints) {
  if (!codepoints) return true;
  for (const part of String(unicodeRange || '').split(',')) {
    const m = /U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?/.exec(part.trim());
    if (!m) continue;
    const lo = parseInt(m[1], 16), hi = m[2] ? parseInt(m[2], 16) : lo;
    for (const cp of codepoints) if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export async function loadCanvasIso() {
  if (IS_NODE) {
    const m = await import('./canvas.mjs');
    return m.loadCanvas();
  }
  return {
    createCanvas(w, h) {
      const c = globalThis.document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    },
  };
}

export async function loadFilmFontsIso(dirRef, base) {
  if (IS_NODE) {
    const m = await import('./canvas.mjs');
    return m.loadFilmFonts(resolveNodePath(dirRef, base));
  }
  const dirUrl = resolveBrowserDirUrl(dirRef, base);
  return loadBrowserFilmFonts(dirUrl.href);
}

export async function registerCanvasFontsIso(specs = [], { baseDir, base, glyphs = null } = {}) {
  const cps = glyphs !== null && glyphs !== undefined ? [...new Set([...String(glyphs)].map(ch => ch.codePointAt(0)))] : null;
  let chunksLoaded = 0, filesLoaded = 0;

  if (IS_NODE) {
    const { path } = nodeBuiltins();
    const { loadCanvas, recordRegisteredFont } = await import('./canvas.mjs');
    const { GlobalFonts } = await loadCanvas();
    const rootDir = baseDir !== undefined && baseDir !== null
      ? resolveNodePath(baseDir, base)
      : (base !== undefined && base !== null ? resolveNodePath('.', base) : globalThis.process.cwd());

    for (const s of specs) {
      if (!s?.family) throw new Error('registerCanvasFonts：每项字体必须给 family');
      if (s.manifest) {
        const mPath = resolveNodePath(s.manifest, rootDir);
        let m;
        try { m = readJsonSync(mPath); }
        catch (e) { throw new Error(`字体清单载不到：${s.manifest}（${e.message}）`, { cause: e }); }
        const mDir = path.dirname(mPath);
        for (const c of m.chunks || []) {
          if (!rangeCoversAny(c.unicodeRange, cps)) continue;
          const fPath = path.resolve(mDir, c.file);
          let ok;
          try { ok = !!GlobalFonts.registerFromPath(fPath, s.family); } catch { ok = false; }
          if (!ok) throw new Error(`字体分片注册失败：${fPath}（family=${s.family}）`);
          recordRegisteredFont({ file: fPath, family: s.family, weight: s.weight ?? c.weight ?? '400', style: s.style ?? c.style ?? 'normal', unicodeRange: c.unicodeRange ?? '' });
          chunksLoaded++;
        }
      } else if (s.src) {
        const fPath = resolveNodePath(s.src, rootDir);
        let ok;
        try { ok = !!GlobalFonts.registerFromPath(fPath, s.family); } catch { ok = false; }
        if (!ok) throw new Error(`字体文件注册失败：${fPath}（family=${s.family}）`);
        recordRegisteredFont({ file: fPath, family: s.family, weight: s.weight ?? '400', style: s.style ?? 'normal', unicodeRange: s.unicodeRange ?? '' });
        filesLoaded++;
      } else {
        throw new Error(`字体 ${s.family} 要写 src（一个字体文件）或 manifest（分片清单）`);
      }
    }
    return { chunksLoaded, filesLoaded };
  }

  // 浏览器侧：经 FontFace + document.fonts 加载单文件或按码位筛选的分片 woff2
  const rootUrl = baseDir !== undefined && baseDir !== null
    ? resolveBrowserDirUrl(baseDir, base)
    : (base !== undefined && base !== null ? resolveBrowserUrl('./', base) : REPO_URL);

  for (const s of specs) {
    if (!s?.family) throw new Error('registerCanvasFonts：每项字体必须给 family');
    if (s.manifest) {
      const mUrl = resolveBrowserUrl(s.manifest, rootUrl);
      let m;
      try { m = await readJson(mUrl); }
      catch (e) { throw new Error(`字体清单载不到：${s.manifest}（${e.message}）`, { cause: e }); }
      const mDirUrl = new globalThis.URL(asDirUrlStr(new globalThis.URL('./', mUrl).href));
      const faces = [];
      for (const c of m.chunks || []) {
        if (!rangeCoversAny(c.unicodeRange, cps)) continue;
        const fUrl = new globalThis.URL(c.file, mDirUrl);
        const desc = { weight: String(s.weight ?? c.weight ?? '400'), style: s.style ?? c.style ?? 'normal', display: 'block' };
        if (c.unicodeRange) desc.unicodeRange = c.unicodeRange;
        faces.push({ face: new globalThis.FontFace(s.family, `url(${fUrl.href})`, desc), file: fUrl.href });
      }
      await Promise.all(faces.map(async ({ face, file }) => {
        try { await face.load(); }
        catch (e) { throw new Error(`字体分片注册失败：${file}（family=${s.family}，${e.message || e}）`, { cause: e }); }
        globalThis.document.fonts.add(face);
        chunksLoaded++;
      }));
    } else if (s.src) {
      const fUrl = resolveBrowserUrl(s.src, rootUrl);
      const desc = { weight: String(s.weight ?? '400'), style: s.style ?? 'normal', display: 'block' };
      if (s.unicodeRange) desc.unicodeRange = s.unicodeRange;
      const face = new globalThis.FontFace(s.family, `url(${fUrl.href})`, desc);
      try { await face.load(); }
      catch (e) { throw new Error(`字体文件注册失败：${fUrl.href}（family=${s.family}，${e.message || e}）`, { cause: e }); }
      globalThis.document.fonts.add(face);
      filesLoaded++;
    } else {
      throw new Error(`字体 ${s.family} 要写 src（一个字体文件）或 manifest（分片清单）`);
    }
  }
  if (globalThis.document?.fonts?.ready) await globalThis.document.fonts.ready;
  return { chunksLoaded, filesLoaded };
}
