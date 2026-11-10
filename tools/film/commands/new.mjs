// 北冥仓库 · film new：转调 tools/new-film.mjs（P02 维护）新建作品，成功后给出 film 的下一步命令。
// new-film 支持 --json 时原样转交它的信封；不支持时由这里包成附录 C2 的信封（不靠解析它的中文输出判断成败，只看退出码）。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from '../lib/exit.mjs';
import { ROOT, rel } from '../lib/repo.mjs';
import { exec } from '../lib/proc.mjs';
import { envelope } from '../lib/output.mjs';

const NEW = path.join(ROOT, 'tools/new-film.mjs');

export const NEW_HELP = `用法：npm run film -- new <a|b|c> <名字> [--title 标题] [--json]
转调 node tools/new-film.mjs（把 routes/<路线>/template 复制到 films/<名字>/）；其余参数原样交给它。
之后的顺序：
  npm run film -- check   films/<名字>        只读检查
  npm run film -- stills  films/<名字>        风格关键帧 → 用户看 → review approve look
  npm run film -- animatic films/<名字>       动态预演 → 用户看 → review approve animatic
  npm run film -- build   films/<名字> --final 终渲 → 用户看 → review approve final`;

export function nextCommands(dir) {
  return [
    `npm run film -- check ${dir}`,
    `npm run film -- stills ${dir}`,
    `npm run film -- animatic ${dir}`,
    `npm run film -- build ${dir} --final`,
  ];
}

let jsonSupport = null;
async function newFilmSpeaksJson() {
  if (jsonSupport !== null) return jsonSupport;
  try {
    const r = await exec(process.execPath, [NEW, '--help'], { cwd: ROOT, quiet: true, timeoutSec: 30, sweep: false, label: 'new-film --help' });
    jsonSupport = /--json/.test(r.stdout + r.stderr);
  } catch { jsonSupport = false; }
  return jsonSupport;
}

export async function newCommand(rawArgs, { json }) {
  if (!fs.existsSync(NEW)) throw new FilmError(EXIT.ENV, 'new-film-missing', 'tools/new-film.mjs 不存在', '检查仓库是否完整');
  const pass = rawArgs.filter(a => a !== '--json');
  const native = json && await newFilmSpeaksJson();
  let r;
  try {
    r = await exec(process.execPath, [NEW, ...pass, ...(native ? ['--json'] : [])], { cwd: ROOT, quiet: true, timeoutSec: 120, label: 'tools/new-film.mjs', okCodes: [0, 1, 2, 3, 4], sweep: false });
  } catch (e) { throw e; }
  const text = (r.stdout + r.stderr).trim();
  const name = pass.filter(a => !a.startsWith('--'))[1];
  const ti = pass.indexOf('--title');
  const dirRel = name ? rel(path.join(ROOT, 'films', name)) : null;
  if (native) {
    let j = null;
    try { j = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1)); } catch { /* 下面按普通输出处理 */ }
    if (j && typeof j === 'object' && 'ok' in j) {
      return { env: { ...j, command: 'film new', next: r.code === 0 && dirRel ? nextCommands(dirRel) : j.next }, human: null, exitCode: r.code, passthrough: true };
    }
  }
  if (r.code !== 0) {
    const first = text.split('\n').filter(Boolean)[0] || `new-film 退出码 ${r.code}`;
    const code = r.code === 2 || r.code === 1 ? (/(已存在|不覆盖)/.test(text) ? EXIT.USAGE : r.code) : r.code;
    throw new FilmError(code, 'new-failed', first, text.split('\n').filter(Boolean).slice(1, 3).join(' ') || '加 --help 看 new-film 的用法');
  }
  const outputs = [];
  if (dirRel && fs.existsSync(path.join(ROOT, dirRel, 'film.json'))) outputs.push({ path: `${dirRel}/film.json`, sha256: null, kind: 'film-json' });
  const human = `${text}\n下一步（统一出片命令）：\n${nextCommands(dirRel || 'films/<名字>').map(c => `  ${c}`).join('\n')}`;
  return { env: envelope({ command: 'film new', outputs, data: { film: dirRel, title: ti >= 0 ? pass[ti + 1] : name, next: dirRel ? nextCommands(dirRel) : [], newFilmOutput: text } }), human, exitCode: 0 };
}
