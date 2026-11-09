#!/usr/bin/env node
// 北冥仓库 · 新建作品：把 routes/<路线>/template 复制到 films/<名字>/，替换占位符 {{NAME}} / {{TITLE}}，打印下一步命令。
//   node tools/new-film.mjs <a|b|c> <名字> [--title 标题]
//   npm run new -- <a|b|c> <名字> [--title 标题]
// 只做"复制 + 替换"，不改模版、不渲染、不覆盖已有目录。路线与模版的对应：
//   a → routes/a-webgl/template    北冥风格路线 · WebGL 三渲二
//   b → routes/b-native/template   北冥原生 · BNE
//   c → routes/c-style/template    北冥代码动画风格 · 86 式
// 名字：小写字母 / 数字 / 连字符，字母或数字开头（同时是目录名和 URL 段）；不得含内部工程代号。
// 标题：任意文字，但不能含 " \ ` < > 和换行（会直接写进 JSON / HTML / 脚本注释）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROUTES = {
  a: { dir: 'routes/a-webgl', name: '北冥风格路线 · WebGL 三渲二' },
  b: { dir: 'routes/b-native', name: '北冥原生 · BNE' },
  c: { dir: 'routes/c-style', name: '北冥代码动画风格 · 86 式' },
};
export const PLACEHOLDERS = ['NAME', 'TITLE'];
export const INTERNAL_CODENAMES = [/raea/i];
const TEXT_EXT = new Set(['.md', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.css', '.py', '.sh', '.txt',
  '.glsl', '.wgsl', '.wesl', '.toml', '.yaml', '.yml', '.svg']);
const SKIP = new Set(['out', 'node_modules', '.DS_Store', '__pycache__']);

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const USAGE = '用法：node tools/new-film.mjs <a|b|c> <名字> [--title 标题]\n  例：node tools/new-film.mjs a dawn-test --title 破晓';

function parseArgs(argv) {
  const args = [...argv];
  let title = null;
  const i = args.indexOf('--title');
  if (i >= 0) { title = args[i + 1]; if (title === undefined) die('--title 后面要跟标题\n' + USAGE); args.splice(i, 2); }
  if (args.includes('-h') || args.includes('--help')) { console.log(USAGE); process.exit(0); }
  const [route, name, ...rest] = args;
  if (!route || !name || rest.length) die(USAGE);
  return { route: route.toLowerCase(), name, title: title ?? name };
}

function copyTree(src, dst, map, out = []) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { copyTree(s, d, map, out); continue; }
    if (!e.isFile()) continue;   // 不跟符号链接
    if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      let txt = fs.readFileSync(s, 'utf8');
      for (const [k, v] of Object.entries(map)) txt = txt.split(`{{${k}}}`).join(v);
      fs.writeFileSync(d, txt);
      const left = txt.match(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g);
      if (left) out.push(`${path.relative(ROOT, d)}：仍有未知占位符 ${[...new Set(left)].join(' ')}`);
    } else {
      fs.copyFileSync(s, d);
    }
    fs.chmodSync(d, fs.statSync(s).mode & 0o777);
  }
  return out;
}

// 下一步命令：从复制出来的 README.md 里取反引号里的命令（sh / node / npm / python 开头）
function nextSteps(dir, readme) {
  const cmds = [];
  if (fs.existsSync(readme)) {
    for (const m of fs.readFileSync(readme, 'utf8').matchAll(/`([^`\n]+)`/g)) {
      const c = m[1].trim();
      if (/^(\w+=\S+\s+)*(sh|node|npm|npx|python3?)\s/.test(c) && !c.includes('...') && !cmds.includes(c)) cmds.push(c);
    }
  }
  if (!cmds.length) {
    const fj = path.join(dir, 'film.json');
    const f = fs.existsSync(fj) ? JSON.parse(fs.readFileSync(fj, 'utf8')) : {};
    cmds.push(`（模版 README 里没有写命令）读 ${path.relative(ROOT, readme)}；film.json：${JSON.stringify(f)}`);
  }
  return cmds;
}

function main() {
  const { route, name, title } = parseArgs(process.argv.slice(2));
  const R = ROUTES[route];
  if (!R) die(`未知路线「${route}」：只能是 a（${ROUTES.a.name}）、b（${ROUTES.b.name}）、c（${ROUTES.c.name}）\n${USAGE}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64) die(`名字「${name}」不合法：只用小写字母、数字、连字符，字母或数字开头，最长 64 个字符`);
  if (INTERNAL_CODENAMES.some(re => re.test(name))) die(`名字「${name}」含内部工程代号：新作品目录用对外名称（见 routes/README.md「仓库地图」）`);
  if (/["\\`<>\r\n]/.test(title) || !title.trim()) die(`标题「${title}」不合法：不能为空，不能含 " \\ \` < > 或换行`);

  const tpl = path.join(ROOT, R.dir, 'template');
  if (!fs.existsSync(tpl)) die(`${R.dir}/template 不存在：「${R.name}」的模版还没就绪，先看 ${R.dir}/README.md`, 1);
  if (!fs.existsSync(path.join(tpl, 'film.json'))) die(`${R.dir}/template/film.json 缺失：模版不完整，运行 npm run check:repo 查看详情`, 1);
  const dst = path.join(ROOT, 'films', name);
  if (fs.existsSync(dst)) die(`films/${name} 已存在：不覆盖已有作品，换个名字或先手动处理该目录`, 1);

  const warn = copyTree(tpl, dst, { NAME: name, TITLE: title });
  const fj = JSON.parse(fs.readFileSync(path.join(dst, 'film.json'), 'utf8'));
  console.log(`已新建 films/${name}/（${R.name}，来自 ${R.dir}/template）`);
  console.log(`  标题 ${fj.title} · ${fj.dur} 秒 · ${fj.fps} fps · ${(fj.size || []).join('×')}`);
  for (const w of warn) console.log(`  [提示] ${w}`);
  console.log('下一步（在仓库根目录）：');
  for (const c of nextSteps(dst, path.join(dst, 'README.md'))) console.log(`  ${c}`);
  console.log(`  npm run check:repo        改完后跑一遍仓库规范检查`);
  console.log(`路线手册：${R.dir}/README.md；成片与中间文件写到 films/${name}/out/（已被 .gitignore 忽略，不提交）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
