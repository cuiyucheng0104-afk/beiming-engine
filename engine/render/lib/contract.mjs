// 北冥引擎 · 页面约定 v1 的文字报告核对：window.TEXTS(t) 返回的条目（附录 C5；完整约定见 engine/render/README.md「页面约定」）。
// 推荐写法：[{ text, box: [x, y, w, h], alpha, font }]——box 是画布像素（左上角与宽高），alpha 是这一刻的实际不透明度（0–1），
// font 是 CSS 字体串（与 ctx.font 同写法）。早先的写法 { id, text, x0, y0, x1, y1 } 仍然认（换算成 box），但会提示补 alpha 与 font：
// QA 门（tools/qa 的 texts 检查）要用 alpha 判停留与对比度、用 font 查缺字。
// 渲染器默认不调用 TEXTS（它若有副作用会改变后面的画面）；still.mjs --texts 才在每张截完图后读一次。
//   checkTexts(result, { w, h }) → { entries: [{ id?, text, box, alpha, font }] | null, problems: [中文说明…] }
//     result 是页面里求值的结果：{ missing: true } | { error } | { value }

const finite = v => typeof v === 'number' && Number.isFinite(v);

export function checkTexts(result, { w = null, h = null } = {}) {
  if (!result || result.missing) return { entries: null, problems: ['页面没有 window.TEXTS（页面约定 v1 推荐：返回该时刻画面上的文字与方框）'] };
  if (result.error) return { entries: null, problems: [`window.TEXTS(t) 抛错：${result.error}`] };
  const v = result.value;
  if (!Array.isArray(v)) return { entries: null, problems: [`window.TEXTS(t) 应返回数组，收到 ${v === null ? 'null' : typeof v}`] };
  const problems = [], entries = [];
  let legacy = 0, noAlpha = 0, noFont = 0;
  v.forEach((e, i) => {
    if (!e || typeof e !== 'object') { problems.push(`第 ${i + 1} 条不是对象`); return; }
    if (typeof e.text !== 'string' || !e.text) problems.push(`第 ${i + 1} 条缺 text（要写画面上的字）`);
    let box = null;
    if (Array.isArray(e.box) && e.box.length === 4 && e.box.every(finite)) box = e.box;
    else if ([e.x0, e.y0, e.x1, e.y1].every(finite)) { box = [e.x0, e.y0, e.x1 - e.x0, e.y1 - e.y0]; legacy++; }
    else problems.push(`第 ${i + 1} 条（${String(e.text ?? '').slice(0, 12)}）缺方框：写 box: [x, y, w, h]`);
    if (box && (box[2] < 0 || box[3] < 0)) problems.push(`第 ${i + 1} 条的方框宽高是负数：${JSON.stringify(box)}`);
    if (box && w && h && (box[0] + box[2] < 0 || box[1] + box[3] < 0 || box[0] > w || box[1] > h)) problems.push(`第 ${i + 1} 条（${String(e.text ?? '').slice(0, 12)}）的方框整个在画面外：${JSON.stringify(box)}`);
    if (e.alpha === undefined) noAlpha++;
    else if (!(finite(e.alpha) && e.alpha >= 0 && e.alpha <= 1)) problems.push(`第 ${i + 1} 条的 alpha 要是 0–1 的数，收到 ${JSON.stringify(e.alpha)}`);
    if (e.font === undefined) noFont++;
    else if (typeof e.font !== 'string' || !e.font.trim()) problems.push(`第 ${i + 1} 条的 font 要是 CSS 字体串，收到 ${JSON.stringify(e.font)}`);
    entries.push({ ...(e.id !== undefined ? { id: e.id } : {}), text: e.text ?? null, box, alpha: e.alpha ?? null, font: e.font ?? null });
  });
  if (legacy) problems.push(`${legacy} 条用的是旧写法 x0/y0/x1/y1：改成 box: [x, y, w, h]`);
  if (noAlpha) problems.push(`${noAlpha} 条缺 alpha（这一刻的实际不透明度 0–1；QA 用它判停留时长与对比度）`);
  if (noFont) problems.push(`${noFont} 条缺 font（CSS 字体串；QA 用它查缺字）`);
  return { entries, problems };
}
