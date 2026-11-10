// route-b 规则的共用小工具（文件名以 _ 开头，加载器不当规则加载）。规则全部只读。
//   stripComments(text)   去掉 JS / TS 注释（注释里写「不要用 spawnSync」不算违规）；字符串里的 // 尽量保留
//   filmDirs(ctx)         B 路线的作品目录：模版、配方样张、例片，以及 films/<名字>/ 里 film.json 的 route 是 "b" 的
//   ENTRY_DIRS            B 路线 Node 代码所在的目录（入口与库）
export const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

export function filmDirs(ctx) {
  const dirs = ['routes/b-native/template', 'routes/b-native/recipes', 'examples/raea'].filter(d => ctx.isDir(d));
  if (ctx.isDir('films')) {
    for (const d of ctx.walk('films', { dirs: true, files: false }).filter(d => d.split('/').length === 2)) {
      try { if (String(ctx.readJson(`${d}/film.json`).route ?? '').toLowerCase() === 'b') dirs.push(d); } catch { /* 不是 B 作品或 film.json 不合法（core.films 会报） */ }
    }
  }
  return dirs;
}

export const nodeSources = (ctx, roots) => roots.flatMap(r => (r.endsWith('.mjs') ? (ctx.exists(r) ? [r] : []) : ctx.walk(r).filter(f => /\.(m?js|cjs)$/.test(f))));

export const B_CODE = ['engine/native', 'engine/render/native.mjs', 'examples/raea/tools'];
