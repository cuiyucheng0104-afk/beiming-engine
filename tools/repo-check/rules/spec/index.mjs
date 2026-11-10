#!/usr/bin/env node
// 仓库规范检查 · spec 域（工作包 P05：作品描述、时间轴、创作闸门、交付档位、共享资产）。只读，不改文件、不渲染。
// 给 tools/repo-check.mjs 的规则目录加载（插件约定见下），也可以单独跑：
//   node tools/repo-check/rules/spec/index.mjs [--root <仓库根>] [--only <规则 id,…>] [--json]
//   退出码：0 没有错误（可能有提示）；4 有错误；2 用法错误；1 检查本身出错
//
// 插件约定（框架按这个形状调用；框架改了形状，由框架属主适配，规则逻辑不动）：
//   export const domain = 'spec'
//   export const rules = [{ id, title, check(ctx) → Diagnostic[] }]     ctx = { root }
//   Diagnostic = { level: 'error' | 'warning', code, path（仓库相对）, message, hint }
//   export async function runRules(ctx, { only }) → { ok, results: [{ id, title, diagnostics }] }
//
// 规则：
//   spec.films           films/ 下每部作品的 film.json 过 engine/production/film.js 校验（v2；v1 自动升级读取只提示）
//   spec.templates       三条路线模版 routes/<路线>/template/film.json 按 --template 校验通过
//   spec.reviews         films/<名>/review/ 的审片记录都合格：没有 agent 自批、没有缺原话或出处的人工结论
//   spec.claims          状态不是 accepted 的作品，作品目录里的说明文字不得写「已交付」「用户已认可」一类说法
//   spec.treatment       作品的 TREATMENT.md 有镜头表、节拍表、cue map、声音设计四节（没有 TREATMENT.md 只提示）
//   spec.mirror          《北冥》镜像 films/beiming-10s 与冻结样片的源码、声音表一致
//   spec.assets-lock     共享资产的 sha256 与 engine/assets/assets.lock.json 一致（资产改了要更新锁文件）
//   spec.profiles        交付档位表 engine/production/profiles.json 合格，默认档是 web-1080p24（决策 D07）
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, '../../../..');
export const domain = 'spec';

const SKIP = new Set(['out', 'node_modules', '.git', 'review']);
const TREATMENT_SECTIONS = [['镜头表'], ['节拍表'], ['cue map'], ['声音设计']];
const ROUTE_TEMPLATES = ['routes/a-webgl/template', 'routes/b-native/template', 'routes/c-style/template'];

const toRel = (root, p) => relative(root, p).split(sep).join('/');
const d = (level, code, path, message, hint = '') => ({ level, code, path, message, hint });

/** 按仓库根动态加载本仓库的库（--root 指向别的检出时也用那份代码）。 */
async function libs(root) {
  const imp = rel => import(pathToFileURL(join(root, ...rel.split('/'))).href);
  const [film, state, review, assets] = await Promise.all([
    imp('engine/production/film.js'), imp('engine/production/state.js'), imp('engine/production/review.js'), imp('engine/assets/manifest.js'),
  ]);
  return { film, state, review, assets };
}

function filmDirs(root) {
  const base = join(root, 'films');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => join(base, e.name));
}

function mdFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) mdFiles(p, out);
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
  }
  return out;
}

export const rules = [
  {
    id: 'spec.films',
    title: 'films/ 下每部作品的 film.json 通过校验',
    async check({ root, L }) {
      const out = [];
      for (const dir of filmDirs(root)) {
        const rel = toRel(root, dir);
        if (!existsSync(join(dir, 'film.json'))) { out.push(d('error', 'film-json-missing', rel, `${rel}/film.json 缺失：每部作品根目录要有 film.json`, '新建作品用 node tools/new-film.mjs <a|b|c> <名字>')); continue; }
        let r;
        try { r = L.film.loadFilm(dir); } catch (error) { out.push(d('error', error.code ?? 'film-json-invalid', `${rel}/film.json`, error.message, error.hint ?? '')); continue; }
        for (const x of r.diagnostics) {
          if (x.level === 'error') out.push(d('error', x.code, `${rel}/film.json:${x.path}`, x.message, x.hint));
          else if (['v1-upgraded', 'asset-changed', 'route-alias', 'orphan-time-field'].includes(x.code)) out.push(d('warning', x.code, `${rel}/film.json:${x.path}`, x.message, x.hint));
        }
      }
      return out;
    },
  },
  {
    id: 'spec.templates',
    title: '三条路线模版的 film.json 按 --template 校验通过',
    async check({ root, L }) {
      const out = [];
      for (const t of ROUTE_TEMPLATES) {
        if (!existsSync(join(root, ...t.split('/'), 'film.json'))) { out.push(d('error', 'template-missing', t, `${t}/film.json 缺失`)); continue; }
        const r = L.film.loadFilm(join(root, ...t.split('/')), { template: true });
        for (const x of r.diagnostics) {
          if (x.level === 'error') out.push(d('error', x.code, `${t}/film.json:${x.path}`, x.message, x.hint));
          else if (x.code === 'v1-upgraded') out.push(d('warning', x.code, `${t}/film.json`, '模版还是 v1：迁到 film.json v2（加 output.profile、shots、credits、aigc）', x.hint));
        }
      }
      return out;
    },
  },
  {
    id: 'spec.reviews',
    title: '审片记录都合格：agent 不能自己批准，人工结论必须有原话与出处',
    async check({ root, L }) {
      const out = [];
      for (const dir of filmDirs(root)) {
        if (!existsSync(join(dir, 'review'))) continue;
        const rel = toRel(root, dir);
        let film = null;
        try { film = L.film.loadFilm(dir).film; } catch { /* spec.films 会报 */ }
        const r = L.review.readReviews(dir, { film });
        for (const x of r.diagnostics) out.push(d(x.level, x.code, `${rel}/${x.path}`, x.message, x.hint));
        for (const rec of r.records) {
          if (rec.valid) continue;
          for (const x of rec.diagnostics.filter(y => y.level === 'error')) out.push(d('error', x.code, `${rel}/review/${rec.name}:${x.path}`, x.message, x.hint || '无效的记录不算数；用 film.js review 重新记录用户原话'));
        }
      }
      return out;
    },
  },
  {
    id: 'spec.claims',
    title: '没有 accepted 的作品不写「已交付」「用户已认可」',
    async check({ root, L }) {
      const out = [];
      for (const dir of filmDirs(root)) {
        let s;
        try { s = L.state.filmStatus(dir); } catch { continue; }
        if (s.state === 'accepted') continue;
        for (const f of mdFiles(dir)) {
          const text = readFileSync(f, 'utf8');
          for (const c of L.state.findUnbackedClaims(text, s)) {
            const line = text.slice(0, c.index).split('\n').length;
            out.push(d('error', 'unbacked-claim', `${toRel(root, f)}:${line}`, `「${c.claim}」没有依据：作品当前状态 ${s.state}（${s.label}）`, '只有 accepted（用户认可了这一版成片）才能写；现在写「技术检查通过，未经用户审看」，或先走完 ⛔4'));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'spec.treatment',
    title: 'TREATMENT.md 有镜头表、节拍表、cue map、声音设计四节',
    async check({ root }) {
      const out = [];
      for (const dir of filmDirs(root)) {
        const rel = toRel(root, dir);
        let raw = null;
        try { raw = JSON.parse(readFileSync(join(dir, 'film.json'), 'utf8')); } catch { /* spec.films 会报 */ }
        if (raw?.mirror) continue;   // 镜像作品描述的是冻结样片，阐述在它自己的文档里
        const p = join(dir, 'TREATMENT.md');
        if (!existsSync(p)) { out.push(d('warning', 'treatment-missing', rel, `${rel} 没有 TREATMENT.md`, '复制 routes/directing/templates/TREATMENT.md，按节填写（小样按开头的必填表）')); continue; }
        const heads = readFileSync(p, 'utf8').replace(/```[\s\S]*?```/g, '').split('\n').filter(l => /^#{2,3}\s/.test(l)).map(l => l.toLowerCase());
        const missing = TREATMENT_SECTIONS.filter(names => !names.some(n => heads.some(h => h.includes(n)))).map(n => n[0]);
        if (missing.length) out.push(d('error', 'treatment-sections', `${rel}/TREATMENT.md`, `缺少小节：${missing.join('、')}`, '镜头表、节拍表、cue map 从 film.json 导出（node engine/production/film.js expect / export），不手抄'));
      }
      return out;
    },
  },
  {
    id: 'spec.mirror',
    title: '《北冥》镜像与冻结样片一致',
    async check({ root, L }) {
      const dir = join(root, 'films', 'beiming-10s');
      if (!existsSync(join(dir, 'mirror-check.mjs'))) return [];
      const m = await import(pathToFileURL(join(dir, 'mirror-check.mjs')).href);
      let film;
      try { film = L.film.assertValidFilm(L.film.loadFilm(dir), 'films/beiming-10s/film.json'); } catch (error) { return [d('error', error.code ?? 'mirror-film', 'films/beiming-10s/film.json', error.message, error.hint ?? '')]; }
      const r = m.checkMirror(film, m.readSources(root), { root });
      return r.diagnostics.map(x => d(x.level, x.code, `films/beiming-10s:${x.path}`, x.message, x.hint || '确认样片源码是否被改过；镜像只描述样片现状'));
    },
  },
  {
    id: 'spec.assets-lock',
    title: '共享资产的 sha256 与锁文件一致',
    async check({ root, L }) {
      const lock = L.assets.readLock(join(root, 'engine', 'assets', 'assets.lock.json'));
      if (!lock) return [d('error', 'assets-lock-missing', 'engine/assets/assets.lock.json', '资产锁文件缺失', 'node engine/assets/manifest.js lock --write')];
      const next = L.assets.buildLock({ root });
      const out = [];
      for (const [id, v] of Object.entries(next.assets)) {
        const old = lock.assets?.[id];
        if (!old) out.push(d('error', 'asset-unlocked', 'engine/assets/assets.lock.json', `资产 ${id} 不在锁文件里`, 'node engine/assets/manifest.js lock --write'));
        else if (old.sha256 !== v.sha256) {
          const changed = Object.keys(v.files).filter(f => old.files?.[f] !== v.files[f]);
          out.push(d('error', 'asset-changed', 'engine/assets/assets.lock.json', `资产 ${id} 改了（${changed.join('、') || '文件集合变了'}）但锁文件没更新：用到它的作品缓存失效、认可过的风格帧要复核`, '确认是有意改动后：node engine/assets/manifest.js lock --write'));
        }
      }
      for (const id of Object.keys(lock.assets ?? {})) if (!next.assets[id]) out.push(d('warning', 'asset-lock-stale', 'engine/assets/assets.lock.json', `锁文件里的 ${id} 已不在注册表里`, 'node engine/assets/manifest.js lock --write'));
      return out;
    },
  },
  {
    id: 'spec.profiles',
    title: '交付档位表合格，默认档 web-1080p24',
    async check({ L }) {
      let P;
      try { P = L.film.loadProfiles({ fresh: true }); } catch (error) { return [d('error', error.code ?? 'profiles-invalid', 'engine/production/profiles.json', error.message, error.hint ?? '')]; }
      const out = [];
      if (P.default !== 'web-1080p24') out.push(d('error', 'profile-default', 'engine/production/profiles.json', `默认档是 ${P.default}，决策 D07 定为 web-1080p24`));
      for (const id of ['web-1080p24', 'master-1080p24', 'uhd-2160p24', 'vertical-1080x1920-30', 'broadcast-1080p25', 'beiming-1040p24']) {
        if (!P.profiles[id]) out.push(d('error', 'profile-missing', 'engine/production/profiles.json', `缺少决策 D07 的档位 ${id}`));
      }
      return out;
    },
  },
];

export async function runRules(ctx = {}, { only = null } = {}) {
  const root = resolve(ctx.root ?? DEFAULT_ROOT);
  const L = ctx.L ?? await libs(root);
  const results = [];
  for (const r of rules) {
    if (only && !only.includes(r.id)) continue;
    let diagnostics;
    try { diagnostics = await r.check({ root, L }); } catch (error) {
      diagnostics = [d('error', 'rule-crashed', r.id, `检查本身出错：${error.message}`, '按报错修好对应文件再跑；仍然出错就是检查的问题，报给 P05')];
    }
    results.push({ id: r.id, title: r.title, diagnostics });
  }
  return { ok: !results.some(x => x.diagnostics.some(y => y.level === 'error')), results };
}

// ───────────────────────── 命令行 ─────────────────────────

const HELP = `node tools/repo-check/rules/spec/index.mjs [--root <仓库根>] [--only <规则 id,…>] [--json]
  spec 域的仓库规范检查（作品描述、闸门、档位、资产），只读。规则：
${rules.map(r => `  ${r.id.padEnd(18)} ${r.title}`).join('\n')}
退出码：0 没有错误；4 有错误；2 用法错误；1 检查本身出错`;

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${HELP}\n`); return 0; }
  const json = argv.includes('--json');
  const opts = { root: DEFAULT_ROOT, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') continue;
    if (a === '--root' || a === '--only') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return usage(`${a} 后面要跟一个值`, json);
      if (a === '--root') opts.root = resolve(v); else opts.only = v.split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }
    return usage(`未知参数 ${a}`, json);
  }
  if (opts.only) { const bad = opts.only.filter(id => !rules.some(r => r.id === id)); if (bad.length) return usage(`没有规则 ${bad.join('、')}`, json); }
  if (!existsSync(join(opts.root, 'engine', 'production', 'film.js'))) return usage(`${opts.root} 不像本仓库的根（找不到 engine/production/film.js）`, json);
  const r = await runRules({ root: opts.root }, { only: opts.only });
  const errors = r.results.flatMap(x => x.diagnostics.filter(y => y.level === 'error'));
  const warnings = r.results.flatMap(x => x.diagnostics.filter(y => y.level === 'warning'));
  const exitCode = r.ok ? 0 : 4;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: r.ok, exitCode, command: 'repo-check spec', error: errors[0] ? { code: errors[0].code, message: errors[0].message, hint: errors[0].hint } : null, outputs: [], runJson: null, warnings: warnings.map(w => `${w.path}：${w.message}`), result: r }, null, 2)}\n`);
  } else {
    const lines = [];
    for (const x of r.results) {
      const e = x.diagnostics.filter(y => y.level === 'error').length, w = x.diagnostics.length - e;
      lines.push(`${e ? '✗' : '✓'} ${x.id}  ${x.title}${e || w ? `（${e} 个错误，${w} 个提示）` : ''}`);
      for (const y of x.diagnostics) lines.push(`    ${y.level === 'error' ? '✗' : '!'} [${y.code}] ${y.path}：${y.message}${y.hint ? `\n      → ${y.hint}` : ''}`);
    }
    lines.push(`${errors.length} 个错误，${warnings.length} 个提示`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return exitCode;
}

function usage(message, json) {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, exitCode: 2, command: 'repo-check spec', error: { code: 'usage', message, hint: '看 --help' }, outputs: [], runJson: null, warnings: [], result: null }, null, 2)}\n`);
  else process.stderr.write(`${message}\n${HELP}\n`);
  return 2;
}

const direct = (() => { try { return Boolean(process.argv[1]) && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url; } catch { return false; } })();
if (direct) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`检查本身出错：${error?.stack ?? error}`); process.exitCode = 1; });

