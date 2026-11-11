// film.entrypoints：出片入口统一走 tools/film。根目录 build.sh 只是《北冥》样片的兼容壳（转调 tools/film/beiming.mjs），
// 不得重新自己拼渲染、封装管线；作品自带 build.sh 的给提示（它绕过运行目录、闸门、run.json 与机器 QA）。
import { filmDirs } from './_shared.mjs';

export default {
  id: 'film.entrypoints',
  title: '出片入口统一走 tools/film（build.sh 只是兼容壳）',
  run(ctx) {
    const out = [];
    if (ctx.exists('build.sh') && ctx.inScope('build.sh')) {
      const src = ctx.read('build.sh');
      if (!/tools\/film\/beiming\.mjs/.test(src)) out.push({ level: 'error', file: 'build.sh', message: '根目录 build.sh 应只转调 node tools/film/beiming.mjs（统一出片命令的《北冥》兼容壳）' });
      const code = src.replace(/^\s*#.*$/gm, '');
      if (/engine\/render\/(video|still)\.mjs|mux\.sh|ffmpeg|ffprobe/.test(code)) out.push({ level: 'error', file: 'build.sh', message: 'build.sh 又在自己调用渲染器、封装或 ffmpeg：出片步骤只能在 tools/film 与 engine/render/build.mjs 里', hint: '改 tools/film/beiming.mjs 或出片链的步骤' });
    }
    for (const d of filmDirs(ctx)) {
      const f = `${d}/build.sh`;
      if (ctx.exists(f) && ctx.inScope(f)) out.push({ level: 'warn', file: f, message: '作品自带的 build.sh 绕过了统一出片命令（运行目录、run.json、闸门、机器 QA）', hint: `改用 npm run film -- build ${d}` });
    }
    return out;
  },
};
