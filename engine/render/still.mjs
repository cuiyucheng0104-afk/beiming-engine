// 北冥引擎 · 渲静帧
//   node engine/render/still.mjs <影片目录> <t> [<t> ...] [--range a:b:step] [--size 1920x1040] [--query k=v] [--out out/stills] [--prefix s_]
// 时刻按秒写。--range 按整数下标生成 a、a+step、…（≤ b），不累加浮点误差，按算出的时刻原值渲（不取整到两位小数）；
//   文件名里的时刻能用两位小数精确表示时写两位（s_0.50.jpg），否则写到能精确表示的位数（s_0.0416667.jpg）。
//   直接写的时刻，文件名照写法保留（9.95 → s_9.95.jpg）。
// 步长为 0 / 负数 / 漏写、时刻不是数字、不认识的选项（例如拼错的 --sizee）都直接报错退出（码 2），不会死循环或乱出图。
// 页面报错时这一张不保留，以非零码退出。
import fs from 'fs';
import path from 'path';
import { openFilm, closeServer, takeSize } from './page.mjs';
import { takeOptions, parseTime, rangeTimes, UsageError } from './args.mjs';

const USAGE = '用法：node engine/render/still.mjs <影片目录> <t> ... [--range a:b:step] [--size WxH] [--query k=v] [--out out/stills] [--prefix s_]';
const args = process.argv.slice(2);
let dir, outDir, query, prefix, shots, w, h;
try {
  ({ w, h } = takeSize(args));
  const o = takeOptions(args, ['--out', '--query', '--prefix', '--range']);
  outDir = o['--out'] ?? 'out/stills'; query = o['--query'] ?? ''; prefix = o['--prefix'] ?? 's_';
  const [d, ...times] = args;
  dir = d;
  shots = times.map(s => ({ t: parseTime(s), label: s.trim() }));
  if (o['--range']) shots.push(...rangeTimes(o['--range']));
  if (!dir || !shots.length) throw new UsageError('缺少影片目录或时刻');
  const seen = new Set();
  for (const { label } of shots) {
    if (seen.has(label)) throw new UsageError(`时刻 ${label} 重复了：文件 ${prefix}${label}.jpg 会被覆盖`);
    seen.add(label);
  }
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message); console.error(USAGE); process.exit(2);
}

let film = null, exitCode = 0;
try {
  fs.mkdirSync(outDir, { recursive: true });
  film = await openFilm(dir, { w, h, query });
  for (const { t, label } of shots) {
    const t0 = Date.now();
    await film.page.evaluate(x => window.render(x), t);
    film.check();
    const file = path.join(outDir, `${prefix}${label}.jpg`);
    await film.page.screenshot({ path: file, type: 'jpeg', quality: 92 });
    try { film.check(); } catch (e) { fs.rmSync(file, { force: true }); throw e; }
    console.log(file, `${Date.now() - t0}ms`);
  }
} catch (e) {
  console.error('渲染失败：', e?.message ?? e);
  exitCode = e?.exitCode ?? 1;
} finally {
  await film?.close();
  await closeServer();
}
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 5000).unref();
