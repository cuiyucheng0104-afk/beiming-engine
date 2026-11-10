#!/usr/bin/env node
// 定调扫参：同一个镜头、同样的时刻，只改一两个参数，渲出无损 PNG 网格 + 每格参数 JSON + 离线对照页——
// 「调哪个参数得到什么效果」用图说话，不靠肉眼一张张试（审计 CRAFT-06；方法参考归档 lab-2026-11-05-tonal-40 的
// 固定场景、固定种子 8×5 网格，只借思路，没有复制代码）。流程见 routes/a-webgl/LOOKDEV.md「逐层扫参」。
//
// 两种参数，可以混用（格子 = 所有取值的笛卡尔积，最多 64 格）：
//   --look <路径>=<值,值,...>   后期参数，合并到每镜预设之上（作品页的 window.__LOOKDEV，见模版 main.js 头注释）。
//                              路径写 engine/look 的每帧参数，例如 kuwahara.radius=2,3,4、grade.warmth=0.12,0.2、paper.strength=0.08,0.14
//                              值按 JSON 解析（数字、true/false、null、[0.02,0.01,0.04] 这种数组要整个用引号包住）
//   --q <键>=<值,值,...>        页面查询参数（每个取值重开一次页面），例如自测页 lab/look.js 的 kr=3,5,7
// 产物（默认 <作品目录>/out/lookdev/<名字>/，同样的参数永远落在同一个目录，重跑覆盖）：
//   cell-<序号>-t<时刻>.png   每格每个时刻一张无损 PNG（截的是页面实际画面）
//   cells.json               每格的参数、时刻、文件、sha256，以及作品、源提交、尺寸
//   grid.png                 全部格子拼成的网格（行 = 格子，列 = 时刻；ffmpeg tile）
//   index.html               离线对照页：图 + 参数标签，直接用浏览器打开
// 退出码：0 成功；2 用法错误；3 缺 ffmpeg；1 页面报错或渲染失败（附录 C1）。--json 输出附录 C2 信封。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { runCli, CliError, EXIT, ROOT, rel, onCleanup } from './lib/cli.mjs';

const USAGE = `
用法：node tools/lookdev/sweep.mjs <作品目录> --t <时刻,...> (--look <路径>=<值,...> | --q <键>=<值,...>)... [选项]
  对同一个镜头只改一两个参数，渲出无损 PNG 网格、每格参数 JSON 与离线对照页（routes/a-webgl/LOOKDEV.md）。
  --t       时刻（秒），逗号分隔，最多 6 个；写成帧号要除以 fps，例如 102/24 写 4.25
  --look    后期参数（合并到每镜预设之上），可写多次；例：--look kuwahara.radius=2,3,4 --look paper.strength=0.08,0.14
  --q       页面查询参数（每个取值重开一次页面），可写多次；例：--q kr=3,5,7
  --size    渲染尺寸，默认 960x540（16:9 作品）；要和作品画幅比一致
  --query   每格都带的固定查询参数，例如 notext=1
  --thumb   网格里每格的宽度（像素），默认 480
  --name    产物子目录名（默认按参数自动生成）
  --out     产物目录（默认 <作品目录>/out/lookdev/<名字>）
  --json    stdout 只输出一个 JSON 对象
例：node tools/lookdev/sweep.mjs films/my-film --t 1.5,6.5 --look kuwahara.radius=2,3,4 --look grade.warmth=0.12,0.2 --query notext=1
`;

const MAX_CELLS = 64, MAX_TIMES = 6;

function parseAxis(spec, kind) {
  const i = spec.indexOf('=');
  if (i <= 0 || i === spec.length - 1) throw new CliError(EXIT.USAGE, 'bad-axis', `--${kind} ${spec} 写法不对`, `写成 --${kind} <名字>=<值,值,...>`);
  const key = spec.slice(0, i).trim(), raw = spec.slice(i + 1);
  if (kind === 'look' && !/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)*$/.test(key)) throw new CliError(EXIT.USAGE, 'bad-axis', `--look 的路径 ${key} 不对`, '写成 kuwahara.radius 这样的点分路径');
  const vals = splitValues(raw).map(v => {
    if (kind === 'q') return v;
    try { return JSON.parse(v); } catch { throw new CliError(EXIT.USAGE, 'bad-value', `--look ${key} 的取值 ${v} 不是合法 JSON`, '数字直接写，数组用引号包住整个参数，例如 --look "grade.lift=[0.02,0.01,0.04],[0.05,0.04,0.05]"'); }
  });
  if (!vals.length) throw new CliError(EXIT.USAGE, 'bad-axis', `--${kind} ${key} 没有取值`);
  return { kind, key, vals };
}
// 逗号分隔，但方括号里的逗号不拆（数组取值）
function splitValues(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function setPath(obj, key, v) {
  const parts = key.split('.'); let o = obj;
  for (const p of parts.slice(0, -1)) o = (o[p] ??= {});
  o[parts.at(-1)] = v;
  return obj;
}
function product(axes) {
  let combos = [[]];
  for (const a of axes) combos = combos.flatMap(c => a.vals.map(v => [...c, { ...a, v }]));
  return combos;
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
function sourceCommit() {
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

await runCli({
  command: 'lookdev:sweep',
  usage: USAGE,
  spec: { t: 'list', look: 'list-raw', q: 'list-raw', size: 'string', query: 'string', thumb: 'number', name: 'string', out: 'string' },
  async main({ opts, args, out, log }) {
    if (args.length !== 1) throw new CliError(EXIT.USAGE, 'usage', args.length ? `只接受一个作品目录，收到 ${args.length} 个` : '缺作品目录', '例如 node tools/lookdev/sweep.mjs films/my-film --t 1.5 --look kuwahara.radius=2,3,4');
    const dir = path.resolve(args[0]);
    if (!fs.existsSync(path.join(dir, 'index.html'))) throw new CliError(EXIT.USAGE, 'not-a-film', `${rel(dir)} 下没有 index.html`, '给作品目录（films/<名>）或仓库根（. ，配合 --q test=<自测页>）');
    const times = opts.t.map(Number);
    if (!times.length || times.some(t => !Number.isFinite(t) || t < 0)) throw new CliError(EXIT.USAGE, 'bad-times', `--t 要给非负的秒数，收到 ${opts.t.join(',') || '（空）'}`);
    if (times.length > MAX_TIMES) throw new CliError(EXIT.USAGE, 'too-many-times', `--t 最多 ${MAX_TIMES} 个时刻，收到 ${times.length} 个`);
    const axes = [...opts.look.map(s => parseAxis(s, 'look')), ...opts.q.map(s => parseAxis(s, 'q'))];
    if (!axes.length) throw new CliError(EXIT.USAGE, 'no-axis', '至少给一个 --look 或 --q', '例：--look kuwahara.radius=2,3,4');
    const combos = product(axes);
    if (combos.length > MAX_CELLS) throw new CliError(EXIT.USAGE, 'too-many-cells', `一共 ${combos.length} 格，超过上限 ${MAX_CELLS}`, '一次只扫一两个参数，分几轮扫');
    const m = /^(\d+)x(\d+)$/.exec(opts.size || '960x540');
    if (!m || +m[1] % 2 || +m[2] % 2 || +m[1] < 64 || +m[2] < 64) throw new CliError(EXIT.USAGE, 'bad-size', `--size ${opts.size} 不对`, '写成 960x540 这样的偶数宽高');
    const [w, h] = [+m[1], +m[2]];
    const thumb = opts.thumb ?? 480;
    if (!(Number.isInteger(thumb) && thumb >= 64 && thumb % 2 === 0)) throw new CliError(EXIT.USAGE, 'bad-thumb', `--thumb 要是 ≥64 的偶数，收到 ${opts.thumb}`);
    const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true });
    if (ff.error || ff.status !== 0) throw new CliError(EXIT.ENV, 'no-ffmpeg', '找不到 ffmpeg（拼网格要用）', '装 FFmpeg ≥ 7 并放进 PATH（docs/decisions D09）');

    const spec = { film: rel(dir), times, axes: axes.map(({ kind, key, vals }) => ({ kind, key, vals })), size: [w, h], query: opts.query || '' };
    const name = opts.name || `sweep-${sha256(JSON.stringify(spec)).slice(0, 10)}`;
    if (!/^[\w.-]+$/.test(name)) throw new CliError(EXIT.USAGE, 'bad-name', `--name ${name} 只能用字母、数字、点、连字符、下划线`);
    const outDir = path.resolve(opts.out || path.join(dir, 'out', 'lookdev', name));
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (/^cell-\d+-t[\d.]+\.png$/.test(f)) fs.rmSync(path.join(outDir, f));   // 只清本工具的旧产物

    const { openFilm, closeServer } = await import('../../engine/render/page.mjs');
    let film = null;
    onCleanup(async () => { if (film) await film.close(); await closeServer(); });

    // 按「查询参数」分组：同一组只开一次页面，组内换 window.__LOOKDEV
    const groups = new Map();
    combos.forEach((c, i) => {
      const qs = c.filter(a => a.kind === 'q').map(a => `${encodeURIComponent(a.key)}=${encodeURIComponent(a.v)}`);
      const query = [opts.query, ...qs].filter(Boolean).join('&');
      if (!groups.has(query)) groups.set(query, []);
      groups.get(query).push(i);
    });
    const cells = new Array(combos.length);
    for (const [query, idxs] of groups) {
      film = await openFilm(dir, { w, h, query, handleSignals: false });
      for (const i of idxs) {
        const lookdev = {};
        for (const a of combos[i]) if (a.kind === 'look') setPath(lookdev, a.key, a.v);
        await film.page.evaluate(ld => { window.__LOOKDEV = Object.keys(ld).length ? ld : null; }, lookdev);
        const shots = [];
        for (const t of times) {
          await Promise.race([film.page.evaluate(async t => { await window.render(t); }, t), film.failed]);
          film.check();
          const file = path.join(outDir, `cell-${String(i).padStart(3, '0')}-t${t}.png`);
          const buf = await film.page.screenshot({ type: 'png' });
          fs.writeFileSync(file, buf);
          shots.push({ t, file: path.basename(file), sha256: sha256(buf) });
          out(file, 'lookdev-cell');
        }
        cells[i] = { index: i, params: Object.fromEntries(combos[i].map(a => [`${a.kind}:${a.key}`, a.v])), lookdev, query, shots };
        log(`格 ${i + 1}/${combos.length}  ${combos[i].map(a => `${a.key}=${JSON.stringify(a.v)}`).join('  ')}`);
      }
      await film.close(); film = null;
    }
    await closeServer();

    // 网格：行 = 格子，列 = 时刻
    const list = cells.flatMap(c => c.shots.map(s => path.join(outDir, s.file)));
    const grid = path.join(outDir, 'grid.png');
    const th = Math.round(thumb * h / w / 2) * 2;
    const inputs = list.flatMap(f => ['-i', f]);
    const filt = list.map((_, k) => `[${k}:v]scale=${thumb}:${th}:flags=area[s${k}]`).join(';') + ';' + list.map((_, k) => `[s${k}]`).join('') +
      `xstack=inputs=${list.length}:layout=${list.map((_, k) => `${(k % times.length) * thumb}_${Math.floor(k / times.length) * th}`).join('|')}[g]`;
    const r = list.length === 1
      ? spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', list[0], '-vf', `scale=${thumb}:${th}:flags=area`, '-frames:v', '1', grid], { encoding: 'utf8', windowsHide: true })
      : spawnSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filt, '-map', '[g]', '-frames:v', '1', grid], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
    if (r.status !== 0) throw new CliError(EXIT.RUN, 'grid-failed', `拼网格失败：${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
    out(grid, 'lookdev-grid');

    const meta = { schemaVersion: 1, tool: 'tools/lookdev/sweep.mjs', sourceCommit: sourceCommit(), ...spec, thumb, cells };
    const cj = path.join(outDir, 'cells.json');
    fs.writeFileSync(cj, JSON.stringify(meta, null, 2) + '\n');
    out(cj, 'lookdev-cells');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>扫参 ${esc(name)}</title>
<style>body{margin:24px;background:#16161c;color:#ddd;font:14px/1.5 system-ui,sans-serif}table{border-collapse:collapse}td,th{padding:6px;border:1px solid #333;vertical-align:top}img{width:${thumb}px;display:block}code{color:#ffd28a}</style></head><body>
<h1>扫参 ${esc(name)}</h1><p>作品 <code>${esc(spec.film)}</code> · 源提交 <code>${esc(meta.sourceCommit || '未知')}</code> · ${w}×${h} · 固定查询 <code>${esc(spec.query || '无')}</code></p>
<table><tr><th>参数</th>${times.map(t => `<th>t = ${t} s</th>`).join('')}</tr>
${cells.map(c => `<tr><td>${Object.entries(c.params).map(([k, v]) => `<code>${esc(k)} = ${esc(JSON.stringify(v))}</code>`).join('<br>')}</td>${c.shots.map(s => `<td><a href="${esc(s.file)}"><img src="${esc(s.file)}" alt=""></a></td>`).join('')}</tr>`).join('\n')}
</table></body></html>\n`;
    const hp = path.join(outDir, 'index.html');
    fs.writeFileSync(hp, html);
    out(hp, 'lookdev-gallery');
    log(`✓ ${cells.length} 格 × ${times.length} 个时刻 → ${rel(outDir)}（打开 index.html 对照）`);
    return { dir: rel(outDir), cells: cells.length, times: times.length };
  },
});
