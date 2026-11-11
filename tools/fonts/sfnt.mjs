// 字体文件读取（只读、纯 Node、无依赖）：TTF / OTF（sfnt）、WOFF（zlib）、WOFF2（brotli）的表目录，
// 解出 cmap（字符覆盖）、name（家族名、版本、版权）、head（版本号）、fvar（可变轴）、OS/2（字重）。
// 给 tools/fonts 的覆盖检查用：子集化之前查原字体缺不缺字，子集化之后复核产物，QA 也可以拿它查 window.TEXTS 的缺字。
//
//   readFont(buf) → { format, tables: Map(tag → Buffer) }      format = 'sfnt' | 'woff' | 'woff2'
//   fontInfo(buf) → { format, family, subfamily, fullName, version, revision, copyright, license, licenseUrl,
//                    weightClass, axes: [{ tag, min, def, max }], cmap: Set(码位), tables: [tag] }
//   cmapOf(tableBuf) → Set(码位)                              只收映射到非 0 字形的码位（格式 0/4/6/12/13）
// WOFF2 的 glyf/loca 是变换过的，这里不还原（不需要）；cmap、name、head、fvar、OS/2 在 WOFF2 里都不变换。
import zlib from 'node:zlib';

const tagOf = (b, o) => b.toString('latin1', o, o + 4);
const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC',
  'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar',
  'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

class FontError extends Error {}

function base128(b, st) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const x = b[st.o++];
    if (i === 0 && x === 0x80) throw new FontError('WOFF2 UIntBase128 以 0x80 开头');
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) return v;
  }
  throw new FontError('WOFF2 UIntBase128 超过 5 字节');
}

export function readFont(buf) {
  if (buf.length < 12) throw new FontError('文件太短，不是字体');
  const sig = tagOf(buf, 0), tables = new Map();
  if (sig === 'wOF2') {
    const n = buf.readUInt16BE(12), comp = buf.readUInt32BE(20);
    const st = { o: 48 }, dir = [];
    for (let i = 0; i < n; i++) {
      const flags = buf[st.o++], idx = flags & 0x3f;
      let tag;
      if (idx === 0x3f) { tag = tagOf(buf, st.o); st.o += 4; } else tag = WOFF2_TAGS[idx];
      const tv = (flags >> 6) & 3, orig = base128(buf, st);
      const transformed = (tag === 'glyf' || tag === 'loca') ? tv !== 3 : tv !== 0;
      const len = transformed ? base128(buf, st) : orig;
      dir.push({ tag, len, transformed });
    }
    if (buf.readUInt32BE(4) === 0x74746366) throw new FontError('暂不支持 WOFF2 字体集合（TTC）');
    const data = zlib.brotliDecompressSync(buf.subarray(st.o, st.o + comp));
    let off = 0;
    for (const t of dir) { if (!t.transformed) tables.set(t.tag, data.subarray(off, off + t.len)); off += t.len; }
    return { format: 'woff2', tables };
  }
  if (sig === 'wOFF') {
    const n = buf.readUInt16BE(12);
    for (let i = 0; i < n; i++) {
      const e = 44 + i * 20, tag = tagOf(buf, e), off = buf.readUInt32BE(e + 4), cl = buf.readUInt32BE(e + 8), ol = buf.readUInt32BE(e + 12);
      const raw = buf.subarray(off, off + cl);
      tables.set(tag, cl < ol ? zlib.inflateSync(raw) : raw);
    }
    return { format: 'woff', tables };
  }
  const ver = buf.readUInt32BE(0);
  if (!(ver === 0x00010000 || sig === 'OTTO' || sig === 'true')) throw new FontError(`不认识的字体格式（开头 ${JSON.stringify(sig)}）`);
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const e = 12 + i * 16, tag = tagOf(buf, e), off = buf.readUInt32BE(e + 8), len = buf.readUInt32BE(e + 12);
    tables.set(tag, buf.subarray(off, off + len));
  }
  return { format: 'sfnt', tables };
}

export function cmapOf(t) {
  const n = t.readUInt16BE(2), recs = [];
  for (let i = 0; i < n; i++) recs.push({ pid: t.readUInt16BE(4 + i * 8), eid: t.readUInt16BE(6 + i * 8), off: t.readUInt32BE(8 + i * 8) });
  const rank = r => (r.pid === 3 && r.eid === 10) || (r.pid === 0 && (r.eid === 4 || r.eid === 6)) ? 0 : (r.pid === 3 && r.eid === 1) || r.pid === 0 ? 1 : 9;
  const out = new Set();
  for (const r of recs.filter(r => rank(r) < 9).sort((a, b) => rank(a) - rank(b))) addSubtable(t, r.off, out);
  return out;
}
function addSubtable(t, o, out) {
  const fmt = t.readUInt16BE(o);
  if (fmt === 0) { for (let c = 0; c < 256; c++) if (t[o + 6 + c]) out.add(c); return; }
  if (fmt === 4) {
    const segX2 = t.readUInt16BE(o + 6), seg = segX2 / 2;
    const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < seg; s++) {
      const end = t.readUInt16BE(ends + s * 2), start = t.readUInt16BE(starts + s * 2);
      const delta = t.readInt16BE(deltas + s * 2), roAt = ranges + s * 2, ro = t.readUInt16BE(roAt);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xffff;
        else { const gi = roAt + ro + (c - start) * 2; g = gi + 1 < t.length ? t.readUInt16BE(gi) : 0; if (g) g = (g + delta) & 0xffff; }
        if (g) out.add(c);
      }
    }
    return;
  }
  if (fmt === 6) { const first = t.readUInt16BE(o + 6), cnt = t.readUInt16BE(o + 8); for (let i = 0; i < cnt; i++) if (t.readUInt16BE(o + 10 + i * 2)) out.add(first + i); return; }
  if (fmt === 12 || fmt === 13) {
    const groups = t.readUInt32BE(o + 12);
    for (let i = 0; i < groups; i++) {
      const g = o + 16 + i * 12, a = t.readUInt32BE(g), b = t.readUInt32BE(g + 4), sg = t.readUInt32BE(g + 8);
      for (let c = a; c <= b; c++) if (fmt === 13 ? sg : sg + (c - a)) out.add(c);
    }
  }
}

function names(t) {
  const count = t.readUInt16BE(2), so = t.readUInt16BE(4), got = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12, pid = t.readUInt16BE(r), eid = t.readUInt16BE(r + 2), lang = t.readUInt16BE(r + 4), id = t.readUInt16BE(r + 6);
    const len = t.readUInt16BE(r + 8), off = t.readUInt16BE(r + 10), raw = t.subarray(so + off, so + off + len);
    let s = null, pri = 9;
    if (pid === 3 && (eid === 1 || eid === 10)) { s = raw.swap16 ? Buffer.from(raw).swap16().toString('utf16le') : ''; pri = lang === 0x409 ? 0 : 1; }
    else if (pid === 1 && eid === 0) { s = raw.toString('latin1'); pri = 2; }
    if (s !== null && (!(id in got) || got[id].pri > pri)) got[id] = { s, pri };
  }
  return Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.s]));
}

export function fontInfo(buf) {
  const { format, tables } = readFont(buf);
  const nm = tables.has('name') ? names(tables.get('name')) : {};
  const head = tables.get('head'), os2 = tables.get('OS/2'), fvar = tables.get('fvar');
  const axes = [];
  if (fvar) {
    const ao = fvar.readUInt16BE(4), ac = fvar.readUInt16BE(8), as = fvar.readUInt16BE(10);
    for (let i = 0; i < ac; i++) { const a = ao + i * as; axes.push({ tag: tagOf(fvar, a), min: fvar.readInt32BE(a + 4) / 65536, def: fvar.readInt32BE(a + 8) / 65536, max: fvar.readInt32BE(a + 12) / 65536 }); }
  }
  return {
    format, family: nm[16] || nm[1] || null, subfamily: nm[17] || nm[2] || null, fullName: nm[4] || null, version: nm[5] || null,
    revision: head ? Math.round(head.readInt32BE(4) / 65536 * 1000) / 1000 : null,
    copyright: nm[0] || null, license: nm[13] || null, licenseUrl: nm[14] || null,
    weightClass: os2 ? os2.readUInt16BE(4) : null, axes,
    cmap: tables.has('cmap') ? cmapOf(tables.get('cmap')) : new Set(), tables: [...tables.keys()].sort(),
  };
}
