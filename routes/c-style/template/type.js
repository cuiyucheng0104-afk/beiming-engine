// 字形覆盖：片名用到的字是不是都在字体里。缺字时浏览器会静默换成系统字体，换一台机器字形就变（交付一票否决项）。
//   missingGlyphs(text, family, weight) → [缺的字]
//       做法：同一个字、同一字号，分别用「目标字体, serif」和「不存在的字体, serif」画到小画布上逐像素比较；
//       两张一样，说明目标字体里没有这个字（画出来的是同一个系统回退字体）。与平台装了哪些字体无关。
//       必须左对齐、字母基线对齐：居中或 middle 基线会按"第一个字体"的度量摆位置，回退字形的位置就不同，比较会失灵。
//   pickFont(text, families, weight) → { family, missing, tried }
//       按顺序取第一个"全部字都有"的字体；都不全时取缺字最少的那个（同样少取靠前的），missing 是它缺的字。
// 只在 setup 里调用（每个字两次 48×48 绘制，十个字以内约 1 ms）。
const NO_SUCH = '__bm_no_such_font__';
let cv = null;

function pixels(font, ch) {
  cv ??= document.createElement('canvas');
  cv.width = cv.height = 56;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, 56, 56); g.font = font; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = '#000';
  g.fillText(ch, 4, 44);
  return g.getImageData(0, 0, 56, 56).data;
}

export function missingGlyphs(text, family, weight = 400) {
  const miss = [];
  for (const ch of new Set([...text])) {
    if (/\s/u.test(ch)) continue;
    const a = pixels(`${weight} 44px "${family}", serif`, ch), b = pixels(`${weight} 44px "${NO_SUCH}", serif`, ch);
    let same = true;
    for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) { same = false; break; }
    if (same) miss.push(ch);
  }
  return miss;
}

export function pickFont(text, families, weight = 400) {
  const tried = families.map(family => ({ family, missing: missingGlyphs(text, family, weight) }));
  const full = tried.find(f => !f.missing.length);
  const best = full || tried.reduce((a, b) => (b.missing.length < a.missing.length ? b : a));
  return { family: best.family, missing: best.missing, tried };
}
