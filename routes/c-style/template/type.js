// 字体：登记、按需加载、查缺字。缺字时浏览器会静默换成系统字体，换一台机器字形就变（交付一票否决项），所以这里只认登记过的网页字体。
//   registerFonts(specs) → Promise   specs 同 film.js 的 FONTS，每项二选一：
//       { family, src, weight? }        一个字体文件（作品自己的 OFL 子集放进作品目录，如 ./fonts/title.woff2，许可文件一并放进去）
//       { family, manifest }            分片字体清单（routes/c-style/fonts/fonts.json：每片一个 woff2 + unicode-range），
//                                       只登记不下载；loadGlyphs 按要画的字只取用得到的那几片
//     每个字体再按 50% 字号（size-adjust）登记一份"探针"副本，给 missingGlyphs 用。地址按页面地址解析，载不到直接抛错（渲染以非零退出）
//   loadGlyphs(text, families, weight) → Promise   把这些字在这些字体里要用到的分片（和探针）都下载好；setup 之前 await
//   missingGlyphs(text, family, weight) → [缺的字]
//       做法：同一个字分别用「字体」和「它的 50% 探针」量宽度。字体里有这个字时，探针画出来只有一半宽；
//       没有这个字时两边都退到同一个系统字体，宽度一样——于是"宽度相等"就是缺字。与平台装了哪些字体无关。
//       （不能拿"不存在的字体"当对照：实测无头 Chrome 里，网页字体缺字时退到的系统字体与未知字体名退到的不是同一个，
//         那种比法会把缺字误判成"有"。）
//   pickFont(text, families, weight) → { family, missing, tried }
//       按顺序取第一个"全部字都有"的字体；都不全时取缺字最少的那个（同样少取靠前的），missing 是它缺的字。
// 只在 setup 里调用（每个字量两次宽度，十个字以内远不到 1 ms）。
const PROBE = ' ·probe';
let ctx = null;

const cssUrl = u => `url("${String(u).replace(/["\\]/g, '\\$&')}")`;

function addFace(family, url, desc) {
  for (const [fam, extra] of [[family, {}], [family + PROBE, { sizeAdjust: '50%' }]]) {
    document.fonts.add(new FontFace(fam, cssUrl(url), { display: 'block', ...desc, ...extra }));
  }
}

export async function registerFonts(specs) {
  for (const s of specs) {
    if (s.manifest) {
      const at = new URL(s.manifest, document.baseURI);
      const r = await fetch(at);
      if (!r.ok) throw new Error(`字体清单载不到：${s.manifest}（HTTP ${r.status}）。作品要放在 films/<名字>/ 这一层，清单路径相对作品目录写`);
      const m = await r.json();
      for (const c of m.chunks) addFace(s.family, new URL(c.file, at).href, { weight: String(m.weight ?? 400), style: m.style ?? 'normal', unicodeRange: c.unicodeRange });
    } else if (s.src) {
      addFace(s.family, new URL(s.src, document.baseURI).href, { weight: String(s.weight ?? 400) });
    } else throw new Error(`字体 ${s.family} 要写 src（一个字体文件）或 manifest（分片清单）`);
  }
}

export async function loadGlyphs(text, families, weight = 400) {
  const t = [...new Set([...text])].join('') || ' ';
  for (const fam of families) {
    for (const f of [fam, fam + PROBE]) {
      try { await document.fonts.load(`${weight} 64px "${f}"`, t); } catch (e) {
        throw new Error(`字体 ${fam} 载不下来（${e && e.message || e}）：检查 FONTS 里的地址，或字体文件是否完整`);
      }
    }
  }
}

const width = (font, ch) => {
  ctx ??= document.createElement('canvas').getContext('2d');
  ctx.font = font;
  return ctx.measureText(ch).width;
};

export function missingGlyphs(text, family, weight = 400) {
  const miss = [];
  for (const ch of new Set([...text])) {
    if (/\s/u.test(ch)) continue;
    const a = width(`${weight} 64px "${family}", serif`, ch), b = width(`${weight} 64px "${family + PROBE}", serif`, ch);
    if (Math.abs(a - b) < 0.25) miss.push(ch);
  }
  return miss;
}

export function pickFont(text, families, weight = 400) {
  const tried = families.map(family => ({ family, missing: missingGlyphs(text, family, weight) }));
  const full = tried.find(f => !f.missing.length);
  const best = full || tried.reduce((a, b) => (b.missing.length < a.missing.length ? b : a));
  return { family: best.family, missing: best.missing, tried };
}
