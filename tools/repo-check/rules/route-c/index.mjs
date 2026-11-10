#!/usr/bin/env node
// 仓库规范检查 · 路线 C（北冥代码动画风格 · 86 式）的规则。只读，不渲染、不联网。
// 插件接口（给 tools/repo-check.mjs 的执行器）：
//   export const domain = 'route-c'
//   export const rules = [{ id, title, run(ctx) → [finding] }]     ctx = { root }（仓库根的绝对路径）
//   finding = { level: 'error' | 'warn', message, file?, hint? }    没问题返回 []
// 单独运行：node tools/repo-check/rules/route-c/index.mjs [--json] [--help]
//   退出码：0 全部通过（可以有 warn）；4 有 error（C1：核对不通过）；2 用法错误。--json 只在 stdout 输出一个结果对象（C2 信封）
// 规则：
//   route-c.styles-fresh       STYLES.md 与 styles.json 和生成器（tools/c-styles.mjs）的输出一致，数据本身没有矛盾
//   route-c.styles-provenance  86 式每一式都写了来源@提交（与 cases/vendor/lock.json 一致）和 MIT 许可；表里每行都带来源与许可
//   route-c.manual             C 手册按 D01 写定义、分"新片 / 历史复刻"、分三种情况说能不能交给 engine/render、警示不要运行 vendor 的
//                              setup.sh；不再出现"还原的源码不能用 engine/render 渲"的一概而论；手册里提到的风格 id 都在 styles.json 里
//   route-c.template           C 模版只依赖仓库根的环境（不引用 $LIB、.venv、/core/），渲染路径不用 Math.random / Date.now /
//                              performance.now；时间只写在 film.json（timeline.js 不写死速度与打点）；页面声明 window.FPS
//   route-c.replicate          历史复刻说明 REPLICATE.md 在，写了 c-runtime setup、restore --download，并警示 vendor 的 setup.sh
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export const domain = 'route-c';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '../../../..');
const C = 'routes/c-style';

const read = (root, r) => fs.readFileSync(path.join(root, r), 'utf8');
const has = (root, r) => fs.existsSync(path.join(root, r));
const err = (message, file, hint) => ({ level: 'error', message, ...(file ? { file } : {}), ...(hint ? { hint } : {}) });

async function stylesFresh({ root }) {
  const gen = await import(pathToFileURL(path.join(root, 'tools/c-styles.mjs')).href);
  let data;
  try { data = gen.collect(); } catch (e) { return [err(`生成器读数据源失败：${e.message}`, 'tools/c-styles.mjs', e.hint)]; }
  const out = data.problems.map(p => err(`风格数据矛盾：${p}`, 'cases/catalog.json', '核对快照（cases/vendor/lock.json）与案例目录'));
  const { md, json } = gen.render(data);
  for (const [f, txt] of [[gen.OUT_MD, md], [gen.OUT_JSON, json]]) {
    if (!has(root, f)) out.push(err(`${f} 缺失`, f, '运行 node tools/c-styles.mjs 生成'));
    else if (read(root, f) !== txt) out.push(err(`${f} 不是最新（与快照或案例目录不一致，或被手改过）`, f, '运行 node tools/c-styles.mjs 重新生成，不要手改'));
  }
  return out;
}

function provenance({ root }) {
  const out = [];
  if (!has(root, `${C}/styles.json`)) return [err('styles.json 缺失', `${C}/styles.json`, '运行 node tools/c-styles.mjs')];
  const lock = JSON.parse(read(root, 'cases/vendor/lock.json'));
  const short = Object.fromEntries((lock.repositories || []).map(r => [r.name, String(r.commit).slice(0, 7)]));
  const want = { lemo: `lemo-opuscar@${short['lemo-opuscar']}`, sy: `sy-style-100@${short['sy-style-100']}` };
  const data = JSON.parse(read(root, `${C}/styles.json`));
  const n = { lemo: 0, sy: 0 };
  for (const s of data.styles) {
    n[s.library] = (n[s.library] || 0) + 1;
    if (s.source !== want[s.library]) out.push(err(`${s.id} 的来源写成 ${s.source}，应为 ${want[s.library]}（cases/vendor/lock.json）`, `${C}/styles.json`));
    if (s.license !== 'MIT') out.push(err(`${s.id} 的许可写成 ${s.license}，两套风格库都是 MIT`, `${C}/styles.json`));
  }
  if (n.lemo !== 66 || n.sy !== 20) out.push(err(`styles.json 有 Lemo ${n.lemo} 种、SY ${n.sy} 种，应为 66 + 20 = 86`, `${C}/styles.json`, '快照变了就同步更新手册里的数字与本规则'));
  const rows = read(root, `${C}/STYLES.md`).split('\n').filter(l => /^\| `(lemo|sy)\//.test(l));
  if (rows.length !== data.styles.length) out.push(err(`STYLES.md 表里有 ${rows.length} 行风格，styles.json 有 ${data.styles.length} 式`, `${C}/STYLES.md`));
  for (const l of rows) {
    const id = /^\| `([^`]+)`/.exec(l)[1], lib = id.startsWith('lemo/') ? 'lemo' : 'sy';
    if (!l.includes(want[lib]) || !/· MIT \|/.test(l)) out.push(err(`STYLES.md 的 ${id} 一行缺来源@提交或许可`, `${C}/STYLES.md`, '重新生成，不要手改'));
  }
  return out;
}

function manual({ root }) {
  const f = `${C}/README.md`;
  if (!has(root, f)) return [err('C 路线手册缺失', f)];
  const md = read(root, f), out = [];
  const must = [
    [/不是第三个 GPU 后端/, '按 D01 写明定义：C 与 A 共用 engine/render，不是第三个 GPU 后端'],
    [/新片/, '要有"新片"用法'],
    [/历史复刻/, '要有"历史复刻"用法'],
    [/不要运行 vendor 自带的 `?setup\.sh`?/, '警示：不要运行 vendor 自带的 setup.sh（会把 ~/lemo-opuscar 拉到上游 main 并 reset --hard）'],
    [/自包含[\s\S]*\/core\/[\s\S]*__seek/, '分三种情况写历史页面能不能交给 engine/render：自包含的 Lemo、依赖 /core/ 的 Lemo、SY 的 __seek'],
    [/--source-only[^\n]*不能拿它判断/, '写明不要拿 --source-only 的还原结果判断能不能渲'],
    [/DIRECTOR\.md/, '链接上游的 DIRECTOR.md（注明 MIT 与作者）'],
    [/TECHNIQUE\.md/, '链接上游的 TECHNIQUE.md'],
  ];
  for (const [re, what] of must) if (!re.test(md)) out.push(err(`手册缺一条：${what}`, f));
  if (/还原(出来)?的源码不能直接用北冥的\s*`?engine\/render/.test(md)) out.push(err('手册还在一概而论地说"还原的源码不能用 engine/render 渲"（与实测矛盾：自包含的页面可以）', f));
  if (has(root, `${C}/styles.json`)) {
    const ids = new Set(JSON.parse(read(root, `${C}/styles.json`)).styles.map(s => s.id));
    for (const m of md.matchAll(/`((?:lemo|sy)\/[a-z0-9-]+)`/g)) if (!ids.has(m[1])) out.push(err(`手册提到的风格 ${m[1]} 不在 styles.json 里`, f, '改成 STYLES.md 里的编号'));
  }
  return out;
}

function template({ root }) {
  const t = `${C}/template`, out = [];
  if (!has(root, t)) return [err('C 模版缺失', t)];
  const files = fs.readdirSync(path.join(root, t)).filter(x => /\.(js|mjs|py|html|json|sh)$/.test(x));
  const bad = [
    [/\$\{?LIB\b|\.venv\/bin\/python/, '引用了 $LIB 或 .venv：模版只能依赖仓库根的环境（BEIMING_PY / 根 node_modules）'],
    [/['"`(]\/core\//, '用了 /core/ 绝对路径：那是第三方风格库的目录，模版里没有'],
    [/Math\.random\s*\(/, '渲染路径用了 Math.random：随机一律用 engine/core/math.js 的 mulberry 种子随机'],
    [/Date\.now\s*\(|performance\.now\s*\(/, '用了墙钟（Date.now / performance.now）：画面只能是 t 的函数'],
  ];
  for (const x of files) {
    const src = read(root, `${t}/${x}`).replace(/^\s*(\/\/|#).*$/gm, '');   // 注释里提到不算
    for (const [re, what] of bad) if (re.test(src)) out.push(err(`${x}：${what}`, `${t}/${x}`));
  }
  if (has(root, `${t}/timeline.js`)) {
    const tl = read(root, `${t}/timeline.js`).replace(/^\s*\/\/.*$/gm, '');
    if (!/from\s+['"]\.\/film\.json['"]/.test(tl)) out.push(err('timeline.js 没有从 film.json 读时间：时间只能写在 film.json 一处', `${t}/timeline.js`));
    if (/\bbpm\s*:\s*\d/.test(tl) || /\[\s*['"][A-Z]['"]\s*,\s*\d+\s*,\s*\d/.test(tl)) out.push(err('timeline.js 里写死了速度或打点地址：挪到 film.json 的 tempo / cues', `${t}/timeline.js`));
  }
  if (has(root, `${t}/main.js`) && !/window\.FPS\s*=/.test(read(root, `${t}/main.js`))) out.push(err('main.js 没有声明 window.FPS（渲染器按它量化与出片）', `${t}/main.js`));
  return out;
}

function replicate({ root }) {
  const f = `${C}/REPLICATE.md`;
  if (!has(root, f)) return [err('历史复刻说明缺失', f, '写清 c-runtime setup → restore --download → c-runtime build 的步骤')];
  const md = read(root, f), out = [];
  for (const [re, what] of [[/c-runtime\.mjs setup/, 'c-runtime setup 一步'], [/--download/, 'restore 要带 --download'],
    [/不要运行[^\n]*setup\.sh/, '不要运行 vendor 自带 setup.sh 的警示'], [/c-runtime\.mjs build/, 'c-runtime build 一步']]) {
    if (!re.test(md)) out.push(err(`REPLICATE.md 缺：${what}`, f));
  }
  return out;
}

export const rules = [
  { id: 'route-c.styles-fresh', title: 'STYLES.md / styles.json 与生成器一致', run: stylesFresh },
  { id: 'route-c.styles-provenance', title: '86 式每式都有来源@提交与许可', run: provenance },
  { id: 'route-c.manual', title: 'C 手册按 D01 与实测写清用法与边界', run: manual },
  { id: 'route-c.template', title: 'C 模版只依赖根环境、确定、单一时间源', run: template },
  { id: 'route-c.replicate', title: '历史复刻说明齐全', run: replicate },
];

export async function runAll(root = DEFAULT_ROOT) {
  const results = [];
  for (const r of rules) {
    let findings;
    try { findings = await r.run({ root }); } catch (e) { findings = [err(`规则本身出错：${e.message}`)]; }
    results.push({ id: r.id, title: r.title, findings });
  }
  return results;
}

async function main(argv) {
  const json = argv.includes('--json');
  const unknown = argv.filter(a => !['--json', '--help', '-h'].includes(a));
  const env = { ok: true, exitCode: 0, command: `repo-check route-c ${argv.join(' ')}`.trim(), error: null, outputs: [], runJson: null, warnings: [] };
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法：node tools/repo-check/rules/route-c/index.mjs [--json]\n只读检查 C 路线的风格索引、手册、模版与复刻说明；有错误退出码 4，用法错误 2。\n');
    return 0;
  }
  if (unknown.length) {
    env.ok = false; env.exitCode = 2; env.error = { code: 'usage', message: `不认识的参数 ${unknown.join(' ')}`, hint: '只接受 --json、--help' };
    if (json) process.stdout.write(JSON.stringify(env) + '\n'); else console.error(env.error.message);
    return 2;
  }
  const results = await runAll();
  const errors = results.flatMap(r => r.findings.filter(f => f.level === 'error').map(f => ({ rule: r.id, ...f })));
  env.warnings = results.flatMap(r => r.findings.filter(f => f.level === 'warn').map(f => `${r.id}：${f.message}`));
  env.result = results;
  if (errors.length) { env.ok = false; env.exitCode = 4; env.error = { code: 'check-failed', message: `${errors.length} 处不符合 C 路线规则`, hint: errors[0].hint || '按每条的说明改' }; }
  if (json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    for (const r of results) {
      const e = r.findings.filter(f => f.level === 'error');
      console.error(`${e.length ? '✗' : '✓'} ${r.id}  ${r.title}`);
      for (const f of r.findings) console.error(`    ${f.level === 'error' ? '✗' : '!'} ${f.message}${f.file ? `（${f.file}）` : ''}${f.hint ? `\n      下一步：${f.hint}` : ''}`);
    }
    console.error(errors.length ? `✗ ${errors.length} 处错误` : '✓ C 路线规则全部通过');
  }
  return env.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main(process.argv.slice(2));
