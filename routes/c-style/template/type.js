// 字形覆盖：片名、印文用到的字是不是都在字体里。缺字时浏览器会静默换成系统字体，换一台机器字形就变（交付一票否决项）。
//   loadProbes(fonts) → Promise   fonts 同 film.js 的 FONTS（[族名, 地址, 字重]）：每个字体再按 50% 字号（size-adjust）
//                                 登记一份"探针"副本。main.js 在 setup 之前 await 它
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

export async function loadProbes(fonts) {
  await Promise.all(fonts.map(async ([family, url, weight]) => {
    const f = new FontFace(family + PROBE, `url("${String(url).replace(/["\\]/g, '\\$&')}")`, { weight, sizeAdjust: '50%', display: 'block' });
    document.fonts.add(f);
    await f.load();
  }));
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
