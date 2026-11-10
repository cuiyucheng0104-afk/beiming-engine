// 北冥 QA · 字体字符覆盖：解析 TTF / OTF / TTC / WOFF / WOFF2 的 cmap 表，回答「这个字体里有没有这个字」。
// 缺字检查以 cmap 为准：document.fonts.check() 只说明字体有没有加载完，查不出子集字体缺字（缺的字浏览器会逐字退回系统字体）。
// 按 OpenType 规范（cmap 子表格式 0 / 4 / 6 / 10 / 12 / 13）与 W3C WOFF / WOFF2 规范自行实现，不依赖第三方库。
//
//   parseFont(buf)            → { format, cps: Set<码位>, tables: [标签] }；格式不认识抛错
//   parseUnicodeRange(str)    → [[lo, hi], ...]；空串或缺省 → [[0, 0x10FFFF]]
//   inRanges(cp, ranges)      → boolean
import zlib from 'node:zlib';

const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG',
  'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar',
  'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

function base128(b, pos) {
  let acc = 0;
  for (let i = 0; i < 5; i++) {
    const x = b[pos.p++];
    if (x === undefined) throw new Error('WOFF2 目录被截断');
    if (i === 0 && x === 0x80) throw new Error('WOFF2 UIntBase128 以 0x80 开头');
    if (acc > 0x1ffffff) throw new Error('WOFF2 UIntBase128 溢出');
    acc = acc * 128 + (x & 0x7f);
    if ((x & 0x80) === 0) return acc;
  }
  throw new Error('WOFF2 UIntBase128 超过 5 字节');
}
function u255(b, pos) {
  const c = b[pos.p++];
  if (c === 253) { const v = b.readUInt16BE(pos.p); pos.p += 2; return v; }
  if (c === 255) return b[pos.p++] + 253;
  if (c === 254) return b[pos.p++] + 506;
  return c;
}

function woff2Tables(b) {
  const flavor = b.toString('latin1', 4, 8);
  const numTables = b.readUInt16BE(12);
  const compLen = b.readUInt32BE(20);
  const pos = { p: 48 };
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const flags = b[pos.p++];
    let tag;
    if ((flags & 63) === 63) { tag = b.toString('latin1', pos.p, pos.p + 4); pos.p += 4; } else tag = WOFF2_TAGS[flags & 63];
    const version = (flags >> 6) & 3;
    const origLength = base128(b, pos);
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? base128(b, pos) : origLength;
    dir.push({ tag, length, transformed });
  }
  if (flavor === 'ttcf') {
    pos.p += 4;                                   // 集合版本
    const numFonts = u255(b, pos);
    for (let f = 0; f < numFonts; f++) {
      const n = u255(b, pos);
      pos.p += 4;                                 // 该字体的 flavor
      for (let k = 0; k < n; k++) u255(b, pos);
    }
  }
  const data = zlib.brotliDecompressSync(b.subarray(pos.p, pos.p + compLen));
  const out = [];
  let off = 0;
  for (const t of dir) {
    out.push({ tag: t.tag, data: t.transformed ? null : data.subarray(off, off + t.length) });
    off += t.length;
  }
  return { flavor, tables: out };
}

function woffTables(b) {
  const flavor = b.toString('latin1', 4, 8);
  const n = b.readUInt16BE(12);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 20;
    const tag = b.toString('latin1', o, o + 4);
    const off = b.readUInt32BE(o + 4), comp = b.readUInt32BE(o + 8), orig = b.readUInt32BE(o + 12);
    const raw = b.subarray(off, off + comp);
    out.push({ tag, data: comp < orig ? zlib.inflateSync(raw) : raw });
  }
  return { flavor, tables: out };
}

function sfntTables(b, base = 0) {
  const n = b.readUInt16BE(base + 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base + 12 + i * 16;
    const tag = b.toString('latin1', o, o + 4);
    const off = b.readUInt32BE(o + 8), len = b.readUInt32BE(o + 12);
    out.push({ tag, data: b.subarray(off, off + len) });
  }
  return out;
}

function cmapCoverage(d, cps) {
  const n = d.readUInt16BE(2);
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const pid = d.readUInt16BE(4 + i * 8), eid = d.readUInt16BE(6 + i * 8), off = d.readUInt32BE(8 + i * 8);
    const unicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10));
    if (!unicode || seen.has(off) || off + 4 > d.length) continue;
    seen.add(off);
    const fmt = d.readUInt16BE(off);
    if (fmt === 4) {
      const segX2 = d.readUInt16BE(off + 6), seg = segX2 / 2;
      const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ros = deltas + segX2;
      for (let s = 0; s < seg; s++) {
        const end = d.readUInt16BE(ends + 2 * s), start = d.readUInt16BE(starts + 2 * s);
        const delta = d.readInt16BE(deltas + 2 * s), ro = d.readUInt16BE(ros + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const at = ros + 2 * s + ro + 2 * (c - start);
            g = at + 2 <= d.length ? d.readUInt16BE(at) : 0;
            if (g) g = (g + delta) & 0xffff;
          }
          if (g) cps.add(c);
        }
      }
    } else if (fmt === 12 || fmt === 13) {
      const groups = d.readUInt32BE(off + 12);
      for (let g = 0; g < groups; g++) {
        const o = off + 16 + g * 12;
        const start = d.readUInt32BE(o), end = Math.min(d.readUInt32BE(o + 4), 0x10ffff), gid = d.readUInt32BE(o + 8);
        for (let c = start; c <= end; c++) if ((fmt === 13 ? gid : gid + c - start) !== 0) cps.add(c);
      }
    } else if (fmt === 0) {
      for (let c = 0; c < 256; c++) if (d[off + 6 + c]) cps.add(c);
    } else if (fmt === 6) {
      const first = d.readUInt16BE(off + 6), count = d.readUInt16BE(off + 8);
      for (let k = 0; k < count; k++) if (d.readUInt16BE(off + 10 + 2 * k)) cps.add(first + k);
    } else if (fmt === 10) {
      const first = d.readUInt32BE(off + 12), count = d.readUInt32BE(off + 16);
      for (let k = 0; k < count; k++) if (d.readUInt16BE(off + 20 + 2 * k)) cps.add(first + k);
    }
  }
}

export function parseFont(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (b.length < 12) throw new Error('字体文件太短');
  const sig = b.toString('latin1', 0, 4);
  let format, groups;
  if (sig === 'wOF2') { const r = woff2Tables(b); format = 'woff2'; groups = [r.tables]; }
  else if (sig === 'wOFF') { const r = woffTables(b); format = 'woff'; groups = [r.tables]; }
  else if (sig === 'ttcf') {
    format = 'ttc';
    const nf = b.readUInt32BE(8);
    groups = [];
    for (let i = 0; i < nf; i++) groups.push(sfntTables(b, b.readUInt32BE(12 + 4 * i)));
  } else if (sig === 'OTTO' || sig === 'true' || b.readUInt32BE(0) === 0x00010000) {
    format = sig === 'OTTO' ? 'otf' : 'ttf';
    groups = [sfntTables(b)];
  } else throw new Error(`不认识的字体格式（文件头 ${JSON.stringify(sig)}）`);
  const cps = new Set();
  const tags = new Set();
  for (const tables of groups) {
    for (const t of tables) {
      tags.add(t.tag);
      if (t.tag === 'cmap' && t.data) cmapCoverage(Buffer.from(t.data), cps);
    }
  }
  if (!tags.has('cmap')) throw new Error('字体里没有 cmap 表');
  return { format, cps, tables: [...tags] };
}

export function parseUnicodeRange(str) {
  if (!str || !String(str).trim()) return [[0, 0x10ffff]];
  const out = [];
  for (const part of String(str).split(',')) {
    const m = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!m) continue;
    if (m[1].includes('?')) out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'f'), 16)]);
    else out.push([parseInt(m[1], 16), m[2] ? parseInt(m[2], 16) : parseInt(m[1], 16)]);
  }
  return out.length ? out : [[0, 0x10ffff]];
}
export const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
