// 北冥仓库 · film new：转调 tools/new-film.mjs（治理骨架维护）新建作品，成功后给出 film 的下一步命令。
// 参数在这里先按同一套规则严格解析（未知选项退出码 2），再原样交给 new-film；new-film 的 --json 信封里的
// outputs、warnings、error 原样转交，data 另加 next（统一出片命令的下一步）。成败只看它的退出码，不解析中文输出。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from '../lib/exit.mjs';
import { ROOT } from '../lib/repo.mjs';
import { exec } from '../lib/proc.mjs';
import { envelope } from '../lib/output.mjs';

const NEW = path.join(ROOT, 'tools/new-film.mjs');

export const newSpec = {
  positionals: [{ name: '路线', describe: 'a / b / c（怎么选见 routes/README.md）', required: true }, { name: '名字', describe: '作品名：小写字母、数字、连字符', required: true }],
  options: {
    '--title': { type: 'string', arg: '<片名>', help: '片名，默认等于名字' },
    '--profile': { type: 'string', arg: '<档位>', help: '交付档位，默认取模版声明的，否则 web-1080p24（D07）' },
    '--dry-run': { type: 'bool', help: '只列出将要写的文件与 film.json，不写任何文件' },
    '--check-timeout': { type: 'int', min: 1, arg: '<秒>', help: '作品描述校验器的超时（默认 60 秒）' },
  },
};

export const NEW_DOC = {
  summary: '新建作品：转调 node tools/new-film.mjs（把 routes/<路线>/template 复制到 films/<名字>/ 并生成 film.json v2）',
  usage: ['npm run film -- new <a|b|c> <名字> [--title 片名] [--profile 档位] [--dry-run] [--json]'],
  description: [
    '之后的顺序：',
    '  npm run film -- check    films/<名字>         只读检查',
    '  npm run film -- stills   films/<名字>         风格关键帧 → 用户看 → review approve look',
    '  npm run film -- animatic films/<名字>         动态预演 → 用户看 → review approve animatic',
    '  npm run film -- build    films/<名字> --final 终渲 → 用户看 → review approve final',
  ],
  examples: ['npm run film -- new c my-film --title 晨渡'],
  exitCodes: { 0: '成功', 2: '用法错误（含目标已存在）', 3: '缺环境', 4: '模版或作品描述不合格' },
};

export function nextCommands(dir) {
  return [
    `npm run film -- check ${dir}`,
    `npm run film -- stills ${dir}`,
    `npm run film -- animatic ${dir}`,
    `npm run film -- build ${dir} --final`,
  ];
}

export async function newCommand(opts, positionals) {
  if (!fs.existsSync(NEW)) throw new FilmError(EXIT.ENV, 'new-film-missing', 'tools/new-film.mjs 不存在', '检查仓库是否完整');
  const [route, name] = positionals;
  const pass = [route, name];
  if (opts.title !== undefined) pass.push('--title', opts.title);
  if (opts.profile !== undefined) pass.push('--profile', opts.profile);
  if (opts.dryRun) pass.push('--dry-run');
  if (opts.checkTimeout !== undefined) pass.push('--check-timeout', String(opts.checkTimeout));
  const r = await exec(process.execPath, [NEW, ...pass, '--json'], { cwd: ROOT, quiet: true, timeoutSec: 180, label: 'tools/new-film.mjs', okCodes: [0, 1, 2, 3, 4, 124], sweep: false });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 下面按失败处理 */ }
  for (const w of j?.warnings || []) process.stderr.write(`警告[${w.code}]：${w.message}\n${w.hint ? `提示：${w.hint}\n` : ''}`);
  const dir = j?.data?.film?.dir || `films/${name}`;
  if (r.code !== 0 || !j?.ok) {
    const e = j?.error;
    const fe = new FilmError(r.code || EXIT.RUN, e?.code || 'new-failed', e?.message || (r.stderr.trim().split('\n')[0] || `new-film 退出码 ${r.code}`), e?.hint || '加 --help 看 new-film 的用法');
    fe.warnings = j?.warnings || [];
    throw fe;
  }
  const next = opts.dryRun ? [] : nextCommands(dir);
  const human = [
    opts.dryRun ? `演练：将新建 ${dir}（${j.data.film.title}，${j.data.route?.brand || route}）` : `已新建 ${dir}（${j.data.film.title}，${j.data.route?.brand || route}）`,
    `  档位 ${j.data.film.profile} · ${j.data.film.width}×${j.data.film.height}@${j.data.film.fps} · ${j.data.film.frameCount} 帧`,
    ...(next.length ? ['下一步（统一出片命令）：', ...next.map(c => `  ${c}`)] : []),
  ].join('\n');
  return { env: envelope({ command: 'film new', outputs: j.outputs || [], warnings: j.warnings || [], data: { ...j.data, next } }), human };
}
