// route-c.template：C 模版只依赖仓库根的环境（不引用 $LIB、.venv、/core/），渲染路径不用 Math.random / Date.now / performance.now；
// 时间只写在 film.json（timeline.js 从它推导，不写死速度与打点）；页面声明 window.FPS；
// film.json 是 v2，写了 aigc 与 credits（每条有 what / owner / license / source，字体是 OFL）；
// film.js 的 FONTS 指向的字体文件或分片清单都在（按作品放在 films/<名字>/ 时的相对路径解析）。
// film.json 的通用格式（占位符、v1 兼容镜像与 output 一致）由 core.templates 查，这里不重复。
import fs from 'node:fs';
import path from 'node:path';
import { TPL, err, lineOf, ok, readLF, stripLineComments } from './_lib.mjs';

const BAD = [
  [/\$\{?LIB\b|\.venv\/bin\/python/, '引用了 $LIB 或 .venv：模版只能依赖仓库根的环境（Python 由 tools/env/py.mjs 选，Node 用根 node_modules）'],
  [/['"`(]\/core\//, '用了 /core/ 绝对路径：那是第三方风格库的目录，模版里没有'],
  [/Math\.random\s*\(/, '渲染路径用了 Math.random：随机一律用 engine/core/math.js 的 mulberry 种子随机'],
  [/Date\.now\s*\(|performance\.now\s*\(/, '用了墙钟（Date.now / performance.now）：画面只能是 t 的函数'],
];

export default {
  id: 'route-c.template',
  title: 'C 模版只依赖根环境、确定、单一时间源，film.json v2 带 aigc 与署名，字体都在',
  run(ctx) {
    if (!ctx.isDir(TPL)) return [err('C 模版缺失', TPL)];
    const out = [];
    for (const f of ctx.walk(TPL).filter(x => /\.(js|mjs|py|html|json|sh)$/.test(x))) {
      const src = stripLineComments(readLF(ctx, f));
      for (const [re, what] of BAD) if (re.test(src)) out.push({ ...err(`${path.posix.basename(f)}：${what}`, f), line: lineOf(readLF(ctx, f), re) });
    }
    const tl = `${TPL}/timeline.js`;
    if (ctx.exists(tl)) {
      const s = stripLineComments(readLF(ctx, tl));
      if (!/from\s+['"]\.\/film\.json['"]/.test(s)) out.push(err('timeline.js 没有从 film.json 读时间：时间只能写在 film.json 一处', tl));
      if (/\bbpm\s*:\s*\d/.test(s) || /\[\s*['"][A-Z]['"]\s*,\s*\d+\s*,\s*\d/.test(s)) out.push(err('timeline.js 里写死了速度或打点地址：挪到 film.json 的 tempo / cues', tl));
    } else out.push(err('C 模版缺 timeline.js（film.json → 打点与动作窗口的唯一换算处）', tl));
    const mj = `${TPL}/main.js`;
    if (ctx.exists(mj) && !/window\.FPS\s*=/.test(readLF(ctx, mj))) out.push(err('main.js 没有声明 window.FPS（渲染器按它量化与出片）', mj));

    const fj = `${TPL}/film.json`;
    if (ctx.exists(fj)) {
      let j = null;
      try { j = JSON.parse(readLF(ctx, fj)); } catch { /* core.templates 会报 */ }
      if (j) {
        if (j.schemaVersion !== 2) out.push(err('模版 film.json 要写成 v2（schemaVersion 2，附录 C6）', fj, '见 routes/c-style/template/README.md 的字段说明'));
        if (!j.aigc || typeof j.aigc.contains !== 'boolean' || !j.aigc.note) out.push(err('film.json 缺 aigc { contains, note }（D11）', fj));
        const credits = Array.isArray(j.credits) ? j.credits : [];
        if (!credits.length) out.push(err('film.json 缺 credits：字体与借鉴的方法要写明来源与许可', fj));
        for (const [i, c] of credits.entries()) for (const k of ['what', 'owner', 'license', 'source']) if (!c || !c[k]) out.push(err(`credits[${i}] 缺 ${k}`, fj));
        if (!credits.some(c => /OFL/.test(c?.license || ''))) out.push(err('credits 里没有字体（OFL）那一条', fj));
        if ('poster' in j) out.push(err('v2 不写 poster（秒）：海报写 posterFrame（整数帧）', fj));
      }
    }
    // FONTS 里的地址：作品在 films/<名字>/，'../../x' 即仓库根下的 x；'./x' 在作品目录里（即模版目录）
    const fl = `${TPL}/film.js`;
    if (ctx.exists(fl)) {
      const s = stripLineComments(readLF(ctx, fl));
      const refs = [...s.matchAll(/\b(?:manifest|src)\s*:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
      if (!refs.length) out.push(err('film.js 的 FONTS 里没有字体地址（manifest 或 src）', fl));
      for (const r of refs) {
        const rel = r.startsWith('../../') ? r.slice(6) : path.posix.join(TPL, r);
        if (!ctx.exists(rel)) out.push(err(`FONTS 指向的 ${r} 不存在（按 films/<名字>/ 解析为 ${rel}）`, fl));
        else if (rel.endsWith('.json')) {
          try {
            const m = JSON.parse(readLF(ctx, rel));
            for (const c of m.chunks || []) if (!fs.existsSync(path.join(ctx.abs(path.posix.dirname(rel)), c.file))) out.push(err(`字体清单 ${rel} 列的 ${c.file} 不存在`, rel));
          } catch (e) { out.push(err(`字体清单 ${rel} 读不出来（${e.message}）`, rel)); }
        }
      }
    }
    if (!out.length) out.push(ok('C 模版合格：只依赖根环境、确定、单一时间源，film.json v2，字体都在'));
    return out;
  },
};
