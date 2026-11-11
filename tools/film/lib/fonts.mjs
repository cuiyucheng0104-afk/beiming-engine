// 北冥仓库 · 出片编排 · 本片字体子集核对（字体工具 tools/fonts 归 A 路线包 P12）。
//   fontsCheck(film) → null（不适用：B 路线或 film.json 没写 fonts）| { ok: true, message } | { ok: false, exitCode, code, message, hint }
// film.json 写了 fonts（字族 → fonts/fonts.lock.json 里锁定的 OFL 字体）的页面作品（A 路线模版）只用本片的字体子集 films/<名>/fonts/：
// 子集还没生成、覆盖不了 texts、文件被改或原始字体换了，页面一打开就报错。出片在开运行目录之前用 tools/fonts/subset.mjs --check
// 的同一段代码（readFilm → plan → checkExisting：不要 Python、不起进程、不写文件）核对，不合格就退出码 4 并给出生成命令，
// 而不是等到页面探测才以「页面错误」退出码 1 失败。film check 把它列为一项。
// 生成子集是作者的一步（写进作品目录、随作品提交），出片命令只核对、不代跑：产物只写运行目录（附录 C4）。
import path from 'node:path';
import { loadLock } from '../../fonts/lock.mjs';
import { readFilm, plan, checkExisting } from '../../fonts/subset.mjs';
import { EXIT } from './exit.mjs';

export function fontsCheck(film) {
  if (film.route === 'b' || !Array.isArray(film.raw?.fonts) || !film.raw.fonts.length) return null;
  const fix = `node tools/fonts/subset.mjs ${film.relDir}`;
  try {
    const stale = checkExisting(path.join(film.dir, 'fonts'), plan(loadLock(), readFilm(film.dir).fam));
    if (!stale.length) return { ok: true, message: `本片字体子集覆盖 film.json 的全部文字（${film.relDir}/fonts）` };
    return { ok: false, exitCode: EXIT.CONTRACT, code: 'fonts-stale', message: `本片字体子集没生成或已过期：${stale.join('；')}`, hint: `先生成：${fix}（改了 film.json 的 texts 或 fonts 都要重跑）` };
  } catch (e) {
    // 字体工具抛的是命令约定库的错误（contract.* 退出码 4）：film.json 的 fonts / texts 写法或字体锁定清单不合格
    return { ok: false, exitCode: e.exitCode || EXIT.RUN, code: 'fonts-spec', message: `本片字体声明不合格：${e.message}`, hint: e.hint || 'node tools/fonts/subset.mjs --help 看写法' };
  }
}
