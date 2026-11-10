// 仓库规范检查 · route-a 域的共享口径（以 _ 开头，不当规则加载）。A 路线 = 北冥风格路线 · WebGL 三渲二。
// 规则只读被检查仓库（ctx.root，--root 可以换成测试搭的小仓库）里的数据；校验逻辑用本仓库的纯函数（engine/style、tools/fonts、tools/plates），
// 与页面、出片工具同一套代码，不另写一份判据。
import { validateStyleLock, parseStyleRef, styleKey, StyleError } from '../../../../engine/style/index.js';

export const TEMPLATE = 'routes/a-webgl/template';
export const REGISTRY = 'engine/style/registry.json';

const hasPlaceholder = s => typeof s === 'string' && /\{\{[A-Z_]+\}\}/.test(s);
export { hasPlaceholder };

/** A 路线的作品：模版 + films/<名>/film.json 里 route 为 a 的作品 → [{ dir, file, film, template }]；读不了的 JSON 记在 bad 里。 */
export function aFilms(ctx) {
  return ctx.memo('route-a:films', () => {
    const list = [], bad = [];
    const add = (dir, template) => {
      const file = `${dir}/film.json`;
      if (!ctx.exists(file)) return;
      try { list.push({ dir, file, film: ctx.readJson(file), template }); } catch (e) { bad.push({ file, message: e.message }); }
    };
    if (ctx.isDir(TEMPLATE)) add(TEMPLATE, true);
    for (const f of ctx.walk('films')) {
      const m = /^films\/([^/]+)\/film\.json$/.exec(f);
      if (!m || m[1].startsWith('.')) continue;
      let film;
      try { film = ctx.readJson(f); } catch (e) { bad.push({ file: f, message: e.message }); continue; }
      if (film?.route === 'a' || film?.route === 'beiming' || film?.route === 'a-webgl') list.push({ dir: `films/${m[1]}`, file: f, film, template: false });
    }
    return { list, bad };
  });
}

/** --staged 时只查暂存区动到的作品；平时全查。 */
export const touched = (ctx, dir) => !ctx.staged || [...ctx.staged].some(f => f === dir || f.startsWith(`${dir}/`));

/** 被检查仓库里的画风登记表与锁定文件（缓存）→ { reg, error, styles: Map(key → { entry, doc, problems }) }。 */
export function styleData(ctx) {
  return ctx.memo('route-a:styles', () => {
    let reg;
    try { reg = ctx.readJson(REGISTRY); } catch (e) { return { reg: null, error: `读不了 ${REGISTRY}：${e.message}`, styles: new Map() }; }
    if (!reg || reg.schema !== 'beiming.style-registry/1' || !Array.isArray(reg.styles)) return { reg: null, error: `${REGISTRY} 不是 beiming.style-registry/1`, styles: new Map() };
    const styles = new Map();
    for (const s of reg.styles) {
      const key = `${s.id}@v${s.version}`, file = `engine/style/${s.file || ''}`;
      const rec = { entry: s, file, doc: null, problems: [] };
      if (!s.file || !ctx.exists(file)) rec.problems.push(`${key} 的锁定文件 ${s.file} 不存在`);
      else {
        try { rec.doc = ctx.readJson(file); } catch (e) { rec.problems.push(`${s.file} 不是合法 JSON：${e.message}`); }
        if (rec.doc) {
          for (const p of validateStyleLock(rec.doc)) rec.problems.push(`${s.file}：${p}`);
          if (rec.doc.styleId !== s.id || rec.doc.version !== `v${s.version}`) rec.problems.push(`${s.file} 写的是 ${rec.doc.styleId}@${rec.doc.version}，登记表说是 ${key}`);
        }
      }
      styles.set(key, rec);
    }
    return { reg, error: null, styles };
  });
}

/** 按 film.json 的 style 取锁定文件（与页面 loadStyle 同样严格：没登记、文件坏了都抛 StyleError）。 */
export function styleFor(ctx, ref) {
  const r = parseStyleRef(ref), key = styleKey(r), data = styleData(ctx);
  if (data.error) throw new StyleError('registry-bad', data.error);
  const rec = data.styles.get(key);
  if (!rec) throw new StyleError('unknown-style', `画风 ${key} 没有登记`, `已登记：${[...data.styles.keys()].join('、') || '（空）'}`);
  if (!rec.doc || rec.problems.length) throw new StyleError('style-invalid', `${key} 的锁定文件不合格：${rec.problems.join('；')}`);
  return { key, doc: rec.doc };
}
