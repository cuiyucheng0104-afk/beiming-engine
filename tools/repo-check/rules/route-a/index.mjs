#!/usr/bin/env node
// 仓库规范检查 · A 路线规则（北冥风格路线 · WebGL 三渲二）。只读，不渲染、不联网、不调 Python。
// 插件形状：export const rules = [{ id, title, check({ root, filmsDir?, template? }) → [{ level: 'error' | 'warn' | 'ok', message, file? }] }]；
// filmsDir / template 只给测试用（默认 <root>/films 与带上模版）。
// 治理骨架的执行器（tools/repo-check.mjs，P02）按目录加载 rules/<包域>/index.mjs；单独运行本文件也行：
//   node tools/repo-check/rules/route-a/index.mjs [--json]     有 error 时退出码 4（附录 C1：契约不通过）
// 规则：
//   route-a.style-registry   engine/style/registry.json 合格；每个登记版本的锁定文件存在、校验通过、预设齐全；userApproval 不越级
//   route-a.film-style       A 路线模版与 films/ 下 route = "a" 的作品：style 已登记、每镜 lookPreset 可解析且属于本片画风、
//                            lookOverrides 在 allowedOverrides 范围内（与页面里 strict 解析同一套代码）
//   route-a.film-timeline    film.json v2：镜头半开区间首尾相接覆盖 [0, frameCount)、事件帧落在所属镜头内、镜头模块文件存在
//   route-a.film-fonts       texts 用到的字族都在 fonts 里声明、source 在字体锁定清单里；作品（非模版）已生成子集且子集覆盖全部文字
//   route-a.fonts-lock       fonts/fonts.lock.json 合格；许可文件的 sha256 与清单一致
//   route-a.plates           assets/plates/plates.json 字段与文件头合格（不逐像素读，逐像素用 node tools/plates/check.mjs）
//   route-a.kun-variants     registry.json 的鲲变体表里的模块、材质、自测页文件都存在
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '../../../..');

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const relp = (root, f) => path.relative(root, f).split(path.sep).join('/');
const isTemplatePh = s => typeof s === 'string' && /\{\{[A-Z_]+\}\}/.test(s);

async function mods(root) {
  const imp = p => import(pathToFileURL(path.join(root, p)).href);
  return {
    style: await imp('engine/style/index.js'),
    fonts: await imp('engine/style/fonts.js'),
    lock: await imp('tools/fonts/lock.mjs'),
    plates: await imp('tools/plates/lib.mjs'),
  };
}

// A 路线的作品：模版 + films/*（film.json 的 route 为 a）。filmsDir 可以换成别处（测试用仓库外的临时目录）
function aFilms(root, filmsDir = path.join(root, 'films'), template = true) {
  const out = template ? [{ dir: path.join(root, 'routes/a-webgl/template'), template: true }] : [];
  const fd = filmsDir;
  if (fs.existsSync(fd)) for (const e of fs.readdirSync(fd, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const fj = path.join(fd, e.name, 'film.json');
    if (!fs.existsSync(fj)) continue;
    try { if (readJson(fj).route === 'a') out.push({ dir: path.join(fd, e.name), template: false }); } catch { /* 不是合法 JSON 由治理骨架的通用规则报 */ }
  }
  return out;
}

export const rules = [
  {
    id: 'route-a.style-registry', title: '画风注册表',
    async check({ root }) {
      const { style } = await mods(root), F = [];
      const regFile = path.join(root, 'engine/style/registry.json');
      let reg;
      try { reg = readJson(regFile); } catch (e) { return [{ level: 'error', message: `读不了 engine/style/registry.json：${e.message}`, file: 'engine/style/registry.json' }]; }
      if (reg.schema !== 'beiming.style-registry/1' || !Array.isArray(reg.styles)) return [{ level: 'error', message: 'registry.json 不是 beiming.style-registry/1', file: 'engine/style/registry.json' }];
      for (const s of reg.styles) {
        const k = `${s.id}@v${s.version}`, f = path.join(root, 'engine/style', s.file || '');
        if (!s.file || !fs.existsSync(f)) { F.push({ level: 'error', message: `${k} 的锁定文件 ${s.file} 不存在`, file: 'engine/style/registry.json' }); continue; }
        let doc;
        try { doc = readJson(f); } catch (e) { F.push({ level: 'error', message: `${s.file} 不是合法 JSON：${e.message}`, file: relp(root, f) }); continue; }
        for (const p of style.validateStyleLock(doc)) F.push({ level: 'error', message: `${s.file}：${p}`, file: relp(root, f) });
        if (doc.styleId !== s.id || doc.version !== `v${s.version}`) F.push({ level: 'error', message: `${s.file} 写的是 ${doc.styleId}@${doc.version}，登记表说是 ${k}`, file: relp(root, f) });
        for (const p of s.lookPresets || []) if (!doc.lookPresets?.[p]) F.push({ level: 'error', message: `登记表说 ${k} 有预设 ${p}，锁定文件里没有`, file: relp(root, f) });
        for (const p of Object.keys(doc.lookPresets || {})) if (!(s.lookPresets || []).includes(p)) F.push({ level: 'warn', message: `${s.file} 有预设 ${p}，登记表的 lookPresets 没列出`, file: 'engine/style/registry.json' });
        if (s.userApproval !== doc.status?.userApproval) F.push({ level: 'error', message: `${k} 的认可状态不一致：登记表 ${s.userApproval}，锁定文件 ${doc.status?.userApproval}`, file: 'engine/style/registry.json' });
        for (const b of s.baselineFrames || []) if (!fs.existsSync(path.join(root, b))) F.push({ level: 'error', message: `${k} 的基准帧 ${b} 不存在`, file: 'engine/style/registry.json' });
        if (!F.some(x => x.level === 'error')) F.push({ level: 'ok', message: `${k}：锁定文件合格，${Object.keys(doc.lookPresets || {}).length} 个预设` });
      }
      for (const c of reg.candidates || []) {
        if (!c.file || !fs.existsSync(path.join(root, 'engine/style', c.file))) F.push({ level: 'error', message: `候选 ${c.id} 的文件 ${c.file} 不存在`, file: 'engine/style/registry.json' });
        if (c.userApproval && c.userApproval !== 'none') F.push({ level: 'error', message: `候选 ${c.id} 写了认可状态 ${c.userApproval}：候选是实验，认可了就该登记成正式版本`, file: 'engine/style/registry.json' });
      }
      return F;
    },
  },
  {
    id: 'route-a.film-style', title: '作品的画风与 lookPreset',
    async check({ root, filmsDir, template: withTpl }) {
      const { style } = await mods(root), F = [];
      for (const { dir, template } of aFilms(root, filmsDir, withTpl)) {
        const fj = path.join(dir, 'film.json'), rf = relp(root, fj);
        let film; try { film = readJson(fj); } catch (e) { F.push({ level: 'error', message: `${rf} 不是合法 JSON：${e.message}`, file: rf }); continue; }
        if (film.schemaVersion !== 2) { F.push({ level: template ? 'error' : 'warn', message: `${rf} 不是 film.json v2（附录 C6），画风与 lookPreset 无法核对`, file: rf }); continue; }
        let st, key;
        try { const ref = style.parseStyleRef(film.style); st = style.loadStyleSync(ref); key = style.styleKey(ref); }
        catch (e) { F.push({ level: 'error', message: `${rf} 的 style：${e.message}`, file: rf }); continue; }
        let bad = 0;
        for (const s of film.shots || []) {
          try {
            const p = style.parseLookPreset(s.lookPreset);
            if (style.styleKey(p) !== key) throw new Error(`属于 ${style.styleKey(p)}，不是本片画风 ${key}`);
            style.resolveLook(st, p.preset, s.lookOverrides || {}, { strict: true });
          } catch (e) { bad++; F.push({ level: 'error', message: `${rf} 镜头 ${s.id} 的 lookPreset ${JSON.stringify(s.lookPreset)}：${e.message}`, file: rf }); }
        }
        if (!bad) F.push({ level: 'ok', message: `${rf}：画风 ${key}，${(film.shots || []).length} 个镜头的 lookPreset 都可解析` });
      }
      return F;
    },
  },
  {
    id: 'route-a.film-timeline', title: '镜头表与事件表',
    async check({ root, filmsDir, template: withTpl }) {
      const F = [];
      for (const { dir } of aFilms(root, filmsDir, withTpl)) {
        const fj = path.join(dir, 'film.json'), rf = relp(root, fj);
        let film; try { film = readJson(fj); } catch { continue; }
        if (film.schemaVersion !== 2) continue;
        const n0 = F.length, N = film.output?.frameCount, shots = film.shots || [];
        if (!(Number.isInteger(N) && N > 0)) F.push({ level: 'error', message: `${rf}：output.frameCount 要是正整数`, file: rf });
        let at = 0;
        for (const s of shots) {
          if (!(Number.isInteger(s.in) && Number.isInteger(s.out) && s.out > s.in)) { F.push({ level: 'error', message: `${rf} 镜头 ${s.id}：in / out 要是整数帧且 out > in`, file: rf }); continue; }
          if (s.in !== at) F.push({ level: 'error', message: `${rf} 镜头 ${s.id} 从第 ${s.in} 帧开始，上一镜到第 ${at} 帧为止（镜头要首尾相接）`, file: rf });
          at = s.out;
          if (!s.module || !fs.existsSync(path.join(dir, s.module))) F.push({ level: 'error', message: `${rf} 镜头 ${s.id} 的模块 ${s.module} 不存在`, file: rf });
        }
        if (Number.isInteger(N) && at !== N) F.push({ level: 'error', message: `${rf}：镜头表到第 ${at} 帧结束，output.frameCount 是 ${N}`, file: rf });
        for (const e of film.events || []) {
          const s = shots.find(x => x.id === e.shot);
          if (!Number.isInteger(e.frame)) F.push({ level: 'error', message: `${rf} 事件 ${e.id} 的 frame 要是整数帧`, file: rf });
          else if (!s) F.push({ level: 'error', message: `${rf} 事件 ${e.id} 指向不存在的镜头 ${e.shot}`, file: rf });
          else if (e.frame < s.in || e.frame >= s.out) F.push({ level: 'error', message: `${rf} 事件 ${e.id} 在第 ${e.frame} 帧，不在镜头 ${s.id} 的 [${s.in}, ${s.out}) 里`, file: rf });
        }
        if (F.length === n0) F.push({ level: 'ok', message: `${rf}：${shots.length} 个镜头首尾相接覆盖 [0, ${N})，${(film.events || []).length} 个事件都落在所属镜头里` });
      }
      return F;
    },
  },
  {
    id: 'route-a.film-fonts', title: '作品字体与缺字',
    async check({ root, filmsDir, template: withTpl }) {
      const { lock, fonts } = await mods(root), F = [];
      let L; try { L = lock.loadLock(); } catch (e) { return [{ level: 'error', message: e.message, file: 'fonts/fonts.lock.json' }]; }
      for (const { dir, template } of aFilms(root, filmsDir, withTpl)) {
        const fj = path.join(dir, 'film.json'), rf = relp(root, fj);
        let film; try { film = readJson(fj); } catch { continue; }
        if (film.schemaVersion !== 2 || !Array.isArray(film.texts) || !film.texts.length) continue;
        const n0 = F.length, fam = new Map((film.fonts || []).map(f => [f.family, f]));
        for (const f of fam.values()) if (!L.fonts.some(x => x.id === f.source)) F.push({ level: 'error', message: `${rf} 字族 ${f.family} 的 source ${f.source} 不在 fonts/fonts.lock.json 里`, file: rf });
        for (const t of film.texts) if (!fam.has(t.font)) F.push({ level: 'error', message: `${rf} 文字 ${t.id} 用了没声明的字族 ${t.font}`, file: rf });
        if (!template) {
          const mf = path.join(dir, 'fonts', 'fonts.json');
          if (!fs.existsSync(mf)) F.push({ level: 'error', message: `${relp(root, dir)} 还没生成字体子集：node tools/fonts/subset.mjs ${relp(root, dir)}`, file: rf });
          else {
            let M; try { M = fonts.parseFontsManifest(readJson(mf)); } catch (e) { F.push({ level: 'error', message: `${relp(root, mf)}：${e.message}`, file: relp(root, mf) }); continue; }
            for (const t of film.texts) {
              if (isTemplatePh(t.text)) { F.push({ level: 'error', message: `${rf} 文字 ${t.id} 还是占位符`, file: rf }); continue; }
              const e = M.fonts.find(x => x.family === t.font);
              const miss = e ? fonts.missingChars(e, t.text) : [...t.text];
              if (miss.length) F.push({ level: 'error', message: `${rf} 文字 ${t.id} 缺字 ${miss.join('')}（子集过期：重跑 node tools/fonts/subset.mjs ${relp(root, dir)}）`, file: rf });
            }
            for (const e of M.fonts) {
              const p = path.join(dir, 'fonts', e.file);
              if (!fs.existsSync(p)) F.push({ level: 'error', message: `${relp(root, mf)} 列的 ${e.file} 不存在`, file: relp(root, mf) });
              else if (e.sha256 && crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') !== e.sha256) F.push({ level: 'error', message: `${e.file} 与清单记的 sha256 不一致（被改过）`, file: relp(root, mf) });
            }
          }
        }
        if (F.length === n0) F.push({ level: 'ok', message: `${rf}：${film.texts.length} 条文字的字族都已声明${template ? '' : '，子集覆盖全部文字'}` });
      }
      return F;
    },
  },
  {
    id: 'route-a.fonts-lock', title: '字体锁定清单',
    async check({ root }) {
      const { lock } = await mods(root), F = [];
      let L; try { L = lock.loadLock(); } catch (e) { return [{ level: 'error', message: e.message, file: 'fonts/fonts.lock.json' }]; }
      for (const f of L.fonts) {
        const p = path.join(root, f.licenseFile);
        const txt = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
        const h = crypto.createHash('sha256').update(txt).digest('hex');
        if (f.licenseSha256 && h !== f.licenseSha256) F.push({ level: 'error', message: `${f.licenseFile} 的 sha256 与清单不一致（许可全文被改过）`, file: f.licenseFile });
      }
      if (!F.length) F.push({ level: 'ok', message: `fonts/fonts.lock.json：${L.fonts.length} 款 OFL 字体，许可全文都对得上` });
      return F;
    },
  },
  {
    id: 'route-a.plates', title: '底板登记表',
    async check({ root }) {
      const { plates } = await mods(root);
      const r = plates.checkPlates(path.join(root, 'assets/plates/plates.json'), { decode: false, profiles: plates.loadProfiles(root) });
      const F = [...r.errors.map(m => ({ level: 'error', message: m, file: 'assets/plates/plates.json' })), ...r.warnings.map(m => ({ level: 'warn', message: m, file: 'assets/plates/plates.json' }))];
      if (!r.errors.length) F.push({ level: 'ok', message: `assets/plates/plates.json：${r.plates.length} 张底板字段与文件头合格（逐像素检查：node tools/plates/check.mjs）` });
      return F;
    },
  },
  {
    id: 'route-a.kun-variants', title: '鲲变体表',
    async check({ root }) {
      const F = [];
      let reg; try { reg = readJson(path.join(root, 'engine/style/registry.json')); } catch { return F; }
      const items = reg.variants?.kun?.items || [];
      for (const v of items) {
        for (const k of ['module', 'toon']) if (v[k] && !fs.existsSync(path.join(root, v[k]))) F.push({ level: 'error', message: `鲲变体「${v.label}」的 ${k} ${v[k]} 不存在`, file: 'engine/style/registry.json' });
        if (v.test && !fs.existsSync(path.join(root, 'lab', `${v.test}.js`))) F.push({ level: 'error', message: `鲲变体「${v.label}」的自测页 lab/${v.test}.js 不存在`, file: 'engine/style/registry.json' });
      }
      if (reg.variants?.kun?.sheet && !fs.existsSync(path.join(root, reg.variants.kun.sheet))) F.push({ level: 'error', message: `变体对照图 ${reg.variants.kun.sheet} 不存在`, file: 'engine/style/registry.json' });
      if (!F.length) F.push({ level: 'ok', message: `鲲变体表：${items.length} 项的模块、材质、自测页都在` });
      return F;
    },
  },
];

export async function runRules(root = DEFAULT_ROOT, ctx = {}) {
  const out = [];
  for (const r of rules) {
    try { for (const f of await r.check({ root, ...ctx })) out.push({ rule: r.id, ...f }); }
    catch (e) { out.push({ rule: r.id, level: 'error', message: `规则本身出错：${e.message}` }); }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法：node tools/repo-check/rules/route-a/index.mjs [--json]\n  A 路线的仓库规范检查（画风注册表、作品的 lookPreset、镜头表与事件表、字体、底板登记表、鲲变体表）。\n  只读。有 error 时退出码 4；--json 输出附录 C2 信封，data 里是逐条结果。\n');
    process.exit(0);
  }
  const unknown = argv.filter(a => a !== '--json');
  if (unknown.length) { const m = `不认识的参数 ${unknown.join(' ')}`; if (json) process.stdout.write(JSON.stringify({ ok: false, exitCode: 2, command: 'repo-check:route-a', error: { code: 'usage', message: m, hint: '用 --help 看用法' }, outputs: [], runJson: null, warnings: [], data: null }) + '\n'); else process.stderr.write(`错误：${m}\n`); process.exit(2); }
  const res = await runRules();
  const errs = res.filter(r => r.level === 'error'), code = errs.length ? 4 : 0;
  if (json) process.stdout.write(JSON.stringify({ ok: !code, exitCode: code, command: 'repo-check:route-a', error: code ? { code: 'route-a-failed', message: `${errs.length} 项不合格`, hint: '按每条的说明修正' } : null, outputs: [], runJson: null, warnings: res.filter(r => r.level === 'warn').map(r => r.message), data: res }) + '\n');
  else for (const r of res) process.stderr.write(`${r.level === 'ok' ? '✓' : r.level === 'warn' ? '提示' : '✗'} [${r.rule}] ${r.message}\n`);
  process.exit(code);
}
