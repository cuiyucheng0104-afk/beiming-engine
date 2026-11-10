// 北冥引擎 · 作品字体：读作品自己的字体子集清单 films/<名>/fonts/fonts.json（由 tools/fonts/subset.mjs 生成），
// 按清单注册 @font-face，并在画字之前核对字形覆盖——子集里没有的字直接抛 GlyphError（页面错误 → 渲染非零退出），
// 绝不让浏览器静默换成系统字体（不同机器字形不同，画风跑偏，见审计 TOOLS-13 / ENV-14）。
//
//   parseFontsManifest(json) → manifest          规范化清单：每个字族的 chars 换成码位集合 cps
//   missingChars(entry, text) → ['字', ...]      text 里不在该字族子集中的字（换行、制表符等控制字符不算）
//   await loadFilmFonts(baseUrl) → fonts          浏览器：读 <baseUrl>/fonts.json、加载每个子集（unicode-range = 子集覆盖范围）
//     fonts.entry(family)                         清单里的一项；没有这个字族 → GlyphError
//     fonts.assert(family, text, where)           缺字 → GlyphError，消息里列出缺的字、码位和修法
//     fonts.list                                  清单原样
// 清单字段（schemaVersion 1）：fonts[{ family, file, weight, style, chars, sha256, source{ id, version, license } }]
// 浏览器与 Node 通用（Node 只用前两个函数，给 QA 与工具核对 window.TEXTS）。

export class GlyphError extends Error {
  constructor(message) { super(message); this.name = 'GlyphError'; }
}

const isCtl = cp => cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
export const codepointsOf = text => [...new Set([...String(text).normalize('NFC')].map(c => c.codePointAt(0)).filter(cp => !isCtl(cp)))];
const hex = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

export function parseFontsManifest(json) {
  if (!json || json.schemaVersion !== 1 || !Array.isArray(json.fonts)) throw new GlyphError('fonts.json 不是 schemaVersion 1 的字体清单（重跑 node tools/fonts/subset.mjs <作品目录>）');
  const fonts = json.fonts.map(f => {
    if (!f.family || !f.file || typeof f.chars !== 'string') throw new GlyphError(`fonts.json 的字族项缺 family / file / chars：${JSON.stringify(f).slice(0, 120)}`);
    return { ...f, cps: new Set(codepointsOf(f.chars)) };
  });
  return { ...json, fonts };
}

export function missingChars(entry, text) {
  return codepointsOf(text).filter(cp => !entry.cps.has(cp)).map(cp => String.fromCodePoint(cp));
}

// CSS unicode-range：码位排序后合并相邻区间
export function unicodeRange(cps) {
  const s = [...cps].sort((a, b) => a - b), out = [];
  for (let i = 0; i < s.length;) {
    let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? hex(s[i]) : `${hex(s[i])}-${s[j].toString(16).toUpperCase()}`);
    i = j + 1;
  }
  return out.join(', ');
}

export async function loadFilmFonts(baseUrl) {
  const base = new URL(String(baseUrl).endsWith('/') ? baseUrl : `${baseUrl}/`);
  const where = new URL('fonts.json', base);
  const r = await fetch(where);
  if (!r.ok) throw new GlyphError(`找不到字体清单 ${where.pathname}（HTTP ${r.status}）：先跑 node tools/fonts/subset.mjs <作品目录> 生成本片的字体子集`);
  const M = parseFontsManifest(await r.json());
  await Promise.all(M.fonts.map(async f => {
    const face = new FontFace(f.family, `url(${new URL(f.file, base).href})`, {
      weight: String(f.weight ?? '400'), style: f.style || 'normal', display: 'block', unicodeRange: unicodeRange(f.cps),
    });
    try { await face.load(); } catch (e) { throw new GlyphError(`字体子集 ${f.file} 加载失败（${e.message || e}）：文件坏了或被删了，重跑 tools/fonts/subset.mjs`); }
    document.fonts.add(face);
  }));
  await document.fonts.ready;
  const entry = family => {
    const e = M.fonts.find(f => f.family === family);
    if (!e) throw new GlyphError(`字体清单里没有字族「${family}」：在 film.json 的 fonts 里声明它，再重跑 tools/fonts/subset.mjs`);
    return e;
  };
  return {
    list: M,
    entry,
    assert(family, text, where = '') {
      const miss = missingChars(entry(family), text);
      if (miss.length) throw new GlyphError(`缺字：${miss.map(c => `「${c}」${hex(c.codePointAt(0))}`).join('、')} 不在 ${family} 子集里${where ? `（${where}）` : ''}：把文字写进 film.json 的 texts 后重跑 node tools/fonts/subset.mjs <作品目录>`);
      return true;
    },
  };
}
