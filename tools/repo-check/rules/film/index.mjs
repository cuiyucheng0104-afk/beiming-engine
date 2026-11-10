#!/usr/bin/env node
// 北冥仓库 · 仓库规范检查 · 出片（film）这一组规则：只读，不渲染、不改文件。
// 由 tools/repo-check.mjs 的插件执行器加载（P02），也可以单独跑：
//   node tools/repo-check/rules/film/index.mjs [--json] [--only film.review-records,film.loadable]
// 规则（level = error 时不通过；warn 只提示）：
//   film.out-untracked     error  films/<名>/out/ 下的运行产物不得被 git 跟踪（决定 D10：渲染产物永不入库）
//   film.review-records    error  films/<名>/review/ 的闸门记录合乎 D08：approve / reject 必须是 human 审阅、带用户原话与出处；
//                                 agent 的审片只能是 agent-note；豁免要写理由，final 闸不能豁免，用户豁免要有原话与出处
//   film.loadable          error  films/<名>/film.json 能被出片编排读懂（路线、帧数、画幅、声音来源存在；A / C 有 index.html）
//   film.templates         error  三个模版的 film.json 替换占位符后能直接交给 npm run film -- build（模版接线改坏了会在这里暴露）
//   film.entrypoints       error  根目录 build.sh 只转调 tools/film/beiming.mjs，不再自己拼管线；
//                          warn   作品自带 build.sh 的，提示它绕过了运行目录、闸门与 QA
// 插件接口（与执行器约定，接口以 P02 的 tools/repo-check/core 为准，不一致时由执行器适配）：
//   export const meta = { domain, owner, version }
//   export const rules = [{ id, level, title, run(ctx) → [{ file, message, hint? }] }]   ctx = { root }
//   export async function runAll({ root, only }) → { ok, results: [{ id, level, title, findings }] }
// 单独运行时的退出码：0 没有 error · 2 用法错误 · 4 有 error。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../../..');
export const meta = { domain: 'film', owner: 'P06', version: 1 };

const posix = p => p.split(path.sep).join('/');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const GATES = ['look', 'animatic', 'final'];
const TEMPLATES = { a: 'routes/a-webgl/template', b: 'routes/b-native/template', c: 'routes/c-style/template' };

function tracked(root, prefix) {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', prefix], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch { return null; }
}

function filmDirs(root) {
  const d = path.join(root, 'films');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true })
    .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
    .map(e => path.join(d, e.name))
    .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

let specMod = null;
async function spec(root) {
  if (!specMod) specMod = await import(pathToFileURL(path.join(root, 'tools/film/lib/spec.mjs')).href);
  return specMod;
}

export const rules = [
  {
    id: 'film.out-untracked', level: 'error', title: '运行产物不入库（films/<名>/out/）',
    run({ root }) {
      const files = tracked(root, 'films');
      if (files === null) return [];
      return files.filter(f => /^films\/[^/]+\/out\//.test(f)).map(f => ({ file: f, message: '运行产物被 git 跟踪了', hint: `git rm --cached -- '${f}'（文件留在磁盘上），产物只放运行目录` }));
    },
  },
  {
    id: 'film.review-records', level: 'error', title: '闸门记录合乎 D08（agent 不得自己批准）',
    async run({ root }) {
      const { reviewProblems } = await import(pathToFileURL(path.join(root, 'tools/film/lib/gates.mjs')).href);
      const out = [];
      for (const dir of filmDirs(root)) {
        const rd = path.join(dir, 'review');
        if (!fs.existsSync(rd)) continue;
        for (const name of fs.readdirSync(rd).sort()) {
          if (!name.endsWith('.json')) continue;
          const f = path.join(rd, name), file = posix(path.relative(root, f));
          let j;
          try { j = readJson(f); } catch (e) { out.push({ file, message: `不是合法 JSON：${e.message}` }); continue; }
          if (name === 'waivers.json') {
            const list = Array.isArray(j?.waivers) ? j.waivers : null;
            if (!list) { out.push({ file, message: '豁免台账要写成 { schemaVersion, waivers: [...] }' }); continue; }
            list.forEach((w, i) => {
              if (!w || !GATES.includes(w.gate)) out.push({ file, message: `第 ${i + 1} 条豁免的 gate 不认识：${JSON.stringify(w?.gate)}` });
              else if (w.gate === 'final') out.push({ file, message: `第 ${i + 1} 条豁免了 final 闸：终渲必须由用户看过成片后 approve，不能豁免` });
              if (!String(w?.reason || '').trim()) out.push({ file, message: `第 ${i + 1} 条豁免没有写理由` });
              if (w?.kind === 'user' && !(String(w.quote || '').trim() && String(w.source || '').trim())) out.push({ file, message: `第 ${i + 1} 条记为用户豁免，却缺用户原话或出处`, hint: '没有用户原话就只能是内部豁免（不放行 --final）' });
            });
            continue;
          }
          const m = /^(look|animatic|final)-.+\.json$/.exec(name);
          if (!m) { out.push({ file, message: 'review/ 下只放 <闸>-<时间>.json 与 waivers.json' }); continue; }
          if (j?.gate !== m[1]) out.push({ file, message: `文件名是 ${m[1]} 闸，记录里写的是 ${JSON.stringify(j?.gate)}` });
          const decision = j?.decision === 'approve' ? 'approved' : j?.decision;
          for (const problem of reviewProblems({ ...j, decision })) {
            out.push({ file, message: `${problem}：这条记录不放行任何闸`, hint: /human|ai/.test(problem) ? 'approve / reject 只记用户原话；agent 自己的结论用 npm run film -- review note' : '原话要能在会话里逐字找到' });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'film.loadable', level: 'error', title: '作品能被出片编排读懂（films/<名>/film.json）',
    async run({ root }) {
      const { loadFilm } = await spec(root);
      const out = [];
      for (const dir of filmDirs(root)) {
        const file = posix(path.relative(root, path.join(dir, 'film.json')));
        if (!fs.existsSync(path.join(dir, 'film.json'))) { out.push({ file, message: '作品目录没有 film.json' }); continue; }
        try {
          const f = loadFilm(dir);
          if (f.route !== 'b' && !fs.existsSync(path.join(f.pageDir, 'index.html')) && f.pageDir === f.dir) out.push({ file, message: '页面型作品（A / C）缺 index.html' });
        } catch (e) { out.push({ file, message: String(e.message).split('\n')[0], hint: e.hint || null }); }
      }
      return out;
    },
  },
  {
    id: 'film.templates', level: 'error', title: '模版替换占位符后能直接出片',
    async run({ root }) {
      const { parseFilm } = await spec(root);
      const out = [];
      for (const [route, rel] of Object.entries(TEMPLATES)) {
        const dir = path.join(root, rel), f = path.join(dir, 'film.json');
        if (!fs.existsSync(f)) { out.push({ file: `${rel}/film.json`, message: '模版缺 film.json' }); continue; }
        let raw;
        try { raw = JSON.parse(fs.readFileSync(f, 'utf8').split('{{NAME}}').join('tpl-check').split('{{TITLE}}').join('模版检查')); }
        catch (e) { out.push({ file: `${rel}/film.json`, message: `替换占位符后不是合法 JSON：${e.message}` }); continue; }
        try {
          const film = parseFilm(raw, { dir });
          if (film.route !== route) out.push({ file: `${rel}/film.json`, message: `route 是 ${film.route}，模版目录属于 ${route}` });
          if (route !== 'b' && !fs.existsSync(path.join(dir, 'index.html'))) out.push({ file: `${rel}/`, message: '页面型模版缺 index.html' });
        } catch (e) { out.push({ file: `${rel}/film.json`, message: String(e.message).split('\n')[0] }); }
      }
      return out;
    },
  },
  {
    id: 'film.entrypoints', level: 'error', title: '出片入口统一走 tools/film',
    run({ root }) {
      const out = [];
      const b = path.join(root, 'build.sh');
      if (fs.existsSync(b)) {
        const src = fs.readFileSync(b, 'utf8');
        if (!/tools\/film\/beiming\.mjs/.test(src)) out.push({ file: 'build.sh', message: '根目录 build.sh 应只转调 node tools/film/beiming.mjs（统一出片命令的《北冥》兼容壳）' });
        if (/engine\/render\/(video|still)\.mjs|mux\.sh/.test(src.replace(/^#.*$/gm, ''))) out.push({ file: 'build.sh', message: 'build.sh 又在自己调用渲染器 / 封装：出片步骤只能在 tools/film 与 engine/render/build.mjs 里' });
      }
      return out;
    },
  },
  {
    id: 'film.film-build-sh', level: 'warn', title: '作品自带 build.sh 会绕过运行目录、闸门与 QA',
    run({ root }) {
      return filmDirs(root).filter(d => fs.existsSync(path.join(d, 'build.sh'))).map(d => ({
        file: posix(path.relative(root, path.join(d, 'build.sh'))), message: '作品自带的 build.sh 绕过了统一出片命令（运行目录、run.json、闸门、机器 QA）',
        hint: `改用 npm run film -- build ${posix(path.relative(root, d))}`,
      }));
    },
  },
];

export async function runAll({ root = ROOT, only = null } = {}) {
  const results = [];
  for (const r of rules) {
    if (only && !only.includes(r.id)) continue;
    let findings;
    try { findings = await r.run({ root }); } catch (e) { findings = [{ file: null, message: `规则自身出错：${e.message}` }]; }
    results.push({ id: r.id, level: r.level, title: r.title, findings });
  }
  return { ok: results.every(r => r.level !== 'error' || !r.findings.length), results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a.includes('--help') || a.includes('-h')) {
    console.log(`用法：node tools/repo-check/rules/film/index.mjs [--json] [--only 规则,规则]\n规则：${rules.map(r => `${r.id}（${r.level}）`).join('、')}\n退出码：0 没有 error · 2 用法错误 · 4 有 error`);
    process.exit(0);
  }
  let only = null;
  const json = a.includes('--json');
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--json') continue;
    if (a[i] === '--only' && a[i + 1]) { only = a[++i].split(',').map(s => s.trim()).filter(Boolean); continue; }
    console.error(`不认识的参数：${a[i]}（可用：--json --only 规则,规则 --help）`); process.exit(2);
  }
  const bad = (only || []).filter(id => !rules.some(r => r.id === id));
  if (bad.length) { console.error(`没有这些规则：${bad.join('、')}；可用：${rules.map(r => r.id).join('、')}`); process.exit(2); }
  const r = await runAll({ only });
  if (json) process.stdout.write(JSON.stringify({ ok: r.ok, exitCode: r.ok ? 0 : 4, command: 'repo-check film', results: r.results }) + '\n');
  else {
    for (const x of r.results) {
      const mark = !x.findings.length ? '✓' : x.level === 'error' ? '✗' : '!';
      console.log(`${mark} ${x.id}  ${x.title}${x.findings.length ? `（${x.findings.length}）` : ''}`);
      for (const f of x.findings) console.log(`    ${f.file || ''}${f.file ? '：' : ''}${f.message}${f.hint ? `；${f.hint}` : ''}`);
    }
  }
  process.exit(r.ok ? 0 : 4);
}
