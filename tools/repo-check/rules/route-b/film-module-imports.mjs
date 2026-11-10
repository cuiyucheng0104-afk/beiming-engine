// route-b.film-module-imports：B 作品里被入口 film.tsx 引用的辅助模块（layout.js、motion.js…）不 import 作品目录之外的文件、
// 也不 import 包。原因（实测 canary.2）：原生运行时把作品模块复制到临时目录打包，只有入口的外部相对 import 会被改写，
// 辅助模块再 import ../../engine/… 打包失败（REFUSED couldn't bundle）。需要的引擎函数由 film.tsx 传进去。
import { posix } from 'node:path';
import { filmDirs, stripComments } from './_shared.mjs';

export default {
  id: 'route-b.film-module-imports',
  title: 'B 作品的辅助模块不 import 作品目录之外的文件',
  run(ctx) {
    const out = [];
    let checked = 0;
    for (const dir of filmDirs(ctx)) {
      let entry = 'film.tsx';
      try { entry = ctx.readJson(`${dir}/film.json`).native?.entry || entry; } catch { /* 用默认入口 */ }
      if (!ctx.exists(`${dir}/${entry}`)) continue;
      const local = [...ctx.read(`${dir}/${entry}`).matchAll(/from\s+['"](\.\/[^'"]+\.(?:m?js|tsx?))['"]/g)].map(m => posix.normalize(`${dir}/${m[1]}`));
      for (const f of local) {
        if (!ctx.exists(f)) continue;
        checked++;
        for (const m of stripComments(ctx.read(f)).matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) {
          const spec = m[1];
          if (spec.startsWith('.')) {
            const target = posix.normalize(posix.join(posix.dirname(f), spec));
            if (!target.startsWith(`${dir}/`)) out.push({ level: 'error', file: f, message: `import 了作品目录之外的 ${spec}：原生运行时打包时会 REFUSED`, hint: `辅助模块写成纯函数，需要的引擎函数由 ${entry} 传进来` });
          } else out.push({ level: 'error', file: f, message: `import 了包 ${spec}：作品的辅助模块要写成不依赖任何包的纯函数`, hint: `需要的函数由 ${entry} 传进来` });
        }
      }
    }
    if (!out.length) out.push({ level: 'info', message: `${checked} 个辅助模块只 import 作品目录里的文件` });
    return out;
  },
};
