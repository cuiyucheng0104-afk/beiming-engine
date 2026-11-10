#!/usr/bin/env node
// 北冥仓库 · 新建作品：把路线模版复制成 films/<名字>/，替换 {{NAME}} / {{TITLE}}，生成 film.json v2，打印下一步命令。
//   node tools/new-film.mjs <路线> <名字> [--title 片名] [--profile 档位] [--dry-run] [--json]
//   npm run new -- <路线> <名字> [选项]
// 路线、模版位置、下一步命令都从路线注册表 routes/routes.json 读（tools/lib/routes.mjs）；命令约定见 docs/CLI.md。
//
// 做什么（全部在内存里先算好、自检通过才写盘，写盘先写临时目录再整体改名，中途失败或被中断不留半个目录）：
//   1. 复制模版的全部文件，包括点文件（如 B 模版的 .gitignore）；跳过 out/、node_modules/、__pycache__/、.DS_Store
//      与模版自己 .gitignore 里列出的生成物目录；不跟符号链接。
//   2. 文本文件里的 {{NAME}} 换成名字、{{TITLE}} 换成片名；替换后还残留 {{大写标识符}} 就退出 4、什么都不写。
//      占位符只认「两层花括号 + 大写标识符」，JSX 的 style={{ color: P.ink }} 不受影响。
//   3. film.json 升到 v2（附录 C6）：id = 名字；output 按交付档位（--profile > 模版声明 > 注册表默认 web-1080p24，D07）；
//      gates 三道闸（D08）；aigc、credits、audio 取模版声明，模版是 v1 时用注册表的 templateDefaults 补齐；
//      模版里有 dur / fps / size（v1 写法）时保留为兼容镜像，数值按 output 重写，供现有出片脚本读取。
//   4. 模版带字体文件而同目录没有许可文本时：字体与仓库 fonts/ 里的同一份 → 附上 fonts/LICENSE.md；否则退出 4。
//   5. 写盘后若有作品描述校验器 engine/production/film.js，调用 `node engine/production/film.js check films/<名字>`，不过即退出 4。
//   6. 下一步命令取模版 film.json 的 next，没有就取注册表这条路线的 next（生成的 film.json 里不保留 next）。
// 不改模版、不渲染、不覆盖已有目录；--dry-run 不写任何文件。
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, defineCommand, isMain, runCli, sha256, suggest } from './lib/cli.mjs';
import { expandSteps, filmVars, formatStep, loadRegistry, readRegistry, validateRegistry } from './lib/routes.mjs';
import { DEFAULT_PROFILE, loadProfiles } from './lib/profiles.mjs';
import { filmJsonProblems, findPlaceholders, nameProblem, titleProblem } from './lib/filmspec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_NAMES = new Set(['out', 'node_modules', '.git', '__pycache__', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const SKIP_EXT = new Set(['.pyc']);
const FONT_EXT = new Set(['.woff', '.woff2', '.ttf', '.otf']);
const LICENSE_RE = /^(licen[cs]e|ofl|copying)/i;
const VALIDATOR = 'engine/production/film.js';
const toPosix = p => p.split(path.sep).join('/');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** 读模版目录：[{ rel, abs, mode, buf }]，rel 用正斜杠。 */
function readTemplate(tplAbs, warn) {
  const skip = new Set(SKIP_NAMES);
  const gi = path.join(tplAbs, '.gitignore');
  if (fs.existsSync(gi)) {
    for (const line of fs.readFileSync(gi, 'utf8').split(/\r?\n/)) {
      const m = /^\/?([A-Za-z0-9_.-]+)\/?$/.exec(line.trim());
      if (m && !line.trim().startsWith('#')) skip.add(m[1]);
    }
  }
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const rel = toPosix(path.relative(tplAbs, abs));
      if (skip.has(e.name) || SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (e.isSymbolicLink()) { warn('template.symlink', `模版里的符号链接 ${rel} 没有复制`, '模版里放实体文件'); continue; }
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile()) continue;
      out.push({ rel, abs, mode: fs.statSync(abs).mode & 0o777, buf: fs.readFileSync(abs) });
    }
  };
  walk(tplAbs);
  return out;
}

function decodeText(buf) {
  if (buf.includes(0)) return null;
  try { return utf8.decode(buf); } catch { return null; }
}

/** 交付档位：--profile > 模版 v2 声明 > 注册表默认。 */
function pickProfile({ opt, tpl, registry, profiles }) {
  const declared = tpl.schemaVersion === 2 ? (tpl.output?.profile ?? tpl.deliveries?.[0]) : undefined;
  const id = opt ?? declared ?? registry.defaultProfile ?? DEFAULT_PROFILE;
  const p = profiles.profiles.get(id);
  if (p) return { profile: p, from: opt ? '--profile' : declared ? '模版' : '注册表默认' };
  const ids = [...profiles.profiles.keys()];
  const s = suggest(id, ids);
  const msg = `交付档位「${id}」不存在；可用：${ids.join('、')}`;
  if (opt) throw new CliError('usage.bad-profile', msg, s ? `是不是想写 --profile ${s}？` : '档位定义见 engine/production/profiles.json（D07）');
  throw new CliError('contract.template', `模版声明的${msg}`, '改模版 film.json 的 output.profile，或用 --profile 指定');
}

/** 组装 film.json v2（键的顺序即文件里的顺序）。 */
function buildFilm({ tpl, route, name, title, profile, profileFromOpt, frameCount, dur }) {
  const d = route.templateDefaults ?? {};
  const known = new Set(['schemaVersion', 'id', 'title', 'route', 'backend', 'output', 'deliveries', 'shots', 'events', 'audio',
    'style', 'assets', 'credits', 'aigc', 'gates', 'next', 'dur', 'fps', 'size']);
  const extras = Object.fromEntries(Object.entries(tpl).filter(([k]) => !known.has(k)));
  const audio = tpl.audio ?? (d.audio ? { ...d.audio, targetLUFS: profile.targetLUFS, truePeakDbTP: profile.truePeakDbTP } : undefined);
  const aigc = tpl.aigc ?? d.aigc;
  if (!aigc) throw new CliError('contract.template', `模版 ${route.template}/film.json 没有声明 aigc，注册表也没有补齐值`, '在模版 film.json 写 "aigc": { "contains": true|false, "note": "…" }（D11）');
  const film = {
    schemaVersion: 2,
    id: name,
    title,
    route: route.id,
    backend: tpl.backend ?? route.backend,
    output: { profile: profile.id, width: profile.width, height: profile.height, fps: profile.fps, frameCount },
    deliveries: !profileFromOpt && Array.isArray(tpl.deliveries) && tpl.deliveries.length ? tpl.deliveries : [profile.id],
  };
  if (tpl.shots) film.shots = tpl.shots;
  if (tpl.events) film.events = tpl.events;
  if (audio) film.audio = audio;
  if (tpl.style) film.style = tpl.style;
  if (tpl.assets) film.assets = tpl.assets;
  film.credits = tpl.credits ?? d.credits ?? [];
  film.aigc = aigc;
  film.gates = tpl.gates ?? { look: 'required', animatic: 'required', final: 'required' };
  Object.assign(film, extras);
  // v1 兼容镜像：模版里有才写，数值跟 output 走
  if ('dur' in tpl) film.dur = dur;
  if ('fps' in tpl) film.fps = profile.fps;
  if ('size' in tpl) film.size = [profile.width, profile.height];
  return film;
}

/** 调作品描述校验器（若已存在）。返回 { status: passed|failed|skipped, … }。 */
function runValidator(dirRel) {
  if (!fs.existsSync(path.join(ROOT, VALIDATOR))) return { status: 'skipped', reason: `${VALIDATOR} 还没有（作品描述包落地后自动启用）` };
  const r = spawnSync(process.execPath, [VALIDATOR, 'check', dirRel], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 << 20 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
  if (r.error) return { status: 'skipped', reason: `校验器没跑起来（${r.error.code ?? r.error.message}）`, output };
  if (r.status === 0) return { status: 'passed', exitCode: 0 };
  if (r.status === EXIT.USAGE || r.status === EXIT.ENVIRONMENT) return { status: 'skipped', reason: `校验器的调用方式或环境不符（exit ${r.status}）`, exitCode: r.status, output };
  return { status: 'failed', exitCode: r.status, output };
}

async function run(ctx) {
  const { opts, args } = ctx;
  const registry = loadRegistry(ROOT);
  const hit = registry.resolve(args.route);
  if (!hit) {
    const s = suggest(String(args.route).toLowerCase(), registry.allTokens());
    throw new CliError('usage.unknown-route', `未知路线「${args.route}」：只能是 ${registry.describeIds()}`,
      `${s ? `是不是想写 ${s}？` : ''}路线怎么选见 routes/README.md`);
  }
  const route = hit.route;
  if (hit.via === 'alias') ctx.warn('route.alias', `「${args.route}」是旧路线名或目录名，已按路线 ${route.id} 处理`, `以后直接写 ${route.id}`);
  const np = nameProblem(args.name);
  if (np) throw new CliError('usage.bad-name', `作品名「${args.name}」不合法：${np}`, '例：dawn-test、kun-2；片名用 --title 另给');
  const title = opts.title ?? args.name;
  const tp = titleProblem(title);
  if (tp) throw new CliError('usage.bad-title', `片名「${title}」不合法：${tp}`, '例：--title 破晓');

  const dirRel = `films/${args.name}`;
  const dst = path.join(ROOT, 'films', args.name);
  if (fs.existsSync(dst)) throw new CliError('usage.exists', `${dirRel} 已存在：不覆盖已有作品`, '换个名字，或先确认那个目录不再需要再自己处理');
  const tplAbs = path.join(ROOT, route.template);

  // 1–2 读模版、替换占位符、查残留
  const files = readTemplate(tplAbs, ctx.warn);
  const residual = [];
  const planned = files.map(f => {
    const text = decodeText(f.buf);
    if (text === null) return { ...f, out: f.buf, text: false };
    const replaced = text.split('{{NAME}}').join(args.name).split('{{TITLE}}').join(title);
    for (const ph of findPlaceholders(replaced)) residual.push(`${f.rel}:${ph.line} {{${ph.name}}}`);
    return { ...f, out: replaced === text ? f.buf : Buffer.from(replaced, 'utf8'), text: true, replacedText: replaced };
  });
  if (residual.length) {
    throw new CliError('contract.placeholder', `模版 ${route.template} 替换后仍有未知占位符：${residual.slice(0, 8).join('、')}${residual.length > 8 ? '……' : ''}`,
      '模版只允许 {{NAME}} 与 {{TITLE}}；修好模版后重跑（这次什么都没写）');
  }

  // 3 film.json v2
  const fjEntry = planned.find(f => f.rel === 'film.json');
  if (!fjEntry) throw new CliError('contract.template', `${route.template}/film.json 不存在`, '跑 npm run check:repo 查看模版问题');
  let tpl;
  try { tpl = JSON.parse(fjEntry.replacedText); } catch (e) {
    throw new CliError('contract.template', `${route.template}/film.json 不是合法 JSON（${e.message}）`, '修好模版后重跑；npm run check:repo 会给出位置');
  }
  if (tpl.route !== route.id) throw new CliError('contract.template', `${route.template}/film.json 的 route 是 ${JSON.stringify(tpl.route)}，注册表里这条路线的 id 是 "${route.id}"`, '模版 film.json 的 route 要写注册表 id');
  const profiles = loadProfiles(ROOT);
  for (const w of profiles.warnings) ctx.warn('profile.source', w);
  const { profile, from } = pickProfile({ opt: opts.profile, tpl, registry, profiles });
  if (profile.reserved) ctx.warn('profile.reserved', `档位 ${profile.id}：${profile.reserved}`, `新作品用 ${registry.defaultProfile ?? DEFAULT_PROFILE}`);
  const tplFps = tpl.schemaVersion === 2 ? tpl.output?.fps : tpl.fps;
  const tplDur = tpl.schemaVersion === 2 ? (tpl.output?.frameCount ?? 0) / (tpl.output?.fps || 1) : tpl.dur;
  if (!(typeof tplDur === 'number' && tplDur > 0 && Number.isFinite(tplDur))) throw new CliError('contract.template', `${route.template}/film.json 读不出片长`, 'v1 写 dur（秒），v2 写 output.frameCount 与 output.fps');
  const exact = tplDur * profile.fps;
  const frameCount = Math.round(exact);
  if (Math.abs(exact - frameCount) > 1e-6) ctx.warn('film.frames-rounded', `片长 ${tplDur} 秒 × ${profile.fps} fps 不是整数帧，按 ${frameCount} 帧`, '把片长改成帧数的整数倍');
  const dur = Number((frameCount / profile.fps).toFixed(6));
  const tplSize = tpl.schemaVersion === 2 ? [tpl.output?.width, tpl.output?.height] : tpl.size;
  if (Array.isArray(tplSize) && (tplSize[0] !== profile.width || tplSize[1] !== profile.height)) {
    ctx.warn('template.size-changed', `模版画幅 ${tplSize.join('×')} 与档位 ${profile.id} 的 ${profile.width}×${profile.height} 不同，已按档位写 film.json`, '构图按新画幅摆：先跑下一步的关键帧命令看一眼');
  }
  if (tplFps && tplFps !== profile.fps) ctx.warn('template.fps-changed', `模版帧率 ${tplFps} 与档位 ${profile.id} 的 ${profile.fps} fps 不同`, '检查模版里按旧帧率写的节拍、一拍二等时间');
  const film = buildFilm({ tpl, route, name: args.name, title, profile, profileFromOpt: !!opts.profile, frameCount, dur });
  const problems = filmJsonProblems(film, { mode: 'film', routeIds: registry.ids, dirName: args.name });
  if (problems.length) throw new CliError('contract.film-json', `生成的 film.json 不合格：${problems.join('；')}`, '这是模版或 new-film 的问题：附上命令报告给维护者');
  fjEntry.out = Buffer.from(`${JSON.stringify(film, null, 2)}\n`, 'utf8');

  // 4 字体许可
  const repoFonts = new Map();
  const fontsDir = path.join(ROOT, 'fonts');
  if (fs.existsSync(fontsDir)) for (const f of fs.readdirSync(fontsDir)) if (FONT_EXT.has(path.extname(f).toLowerCase())) repoFonts.set(sha256(fs.readFileSync(path.join(fontsDir, f))), f);
  const extra = [];
  for (const f of planned.filter(x => FONT_EXT.has(path.extname(x.rel).toLowerCase()))) {
    const dir = path.posix.dirname(f.rel);
    if (planned.some(x => path.posix.dirname(x.rel) === dir && LICENSE_RE.test(path.posix.basename(x.rel))) || extra.some(x => path.posix.dirname(x.rel) === dir)) continue;
    if (repoFonts.has(sha256(f.buf)) && fs.existsSync(path.join(fontsDir, 'LICENSE.md'))) {
      extra.push({ rel: `${dir === '.' ? '' : `${dir}/`}LICENSE.md`, mode: 0o644, out: fs.readFileSync(path.join(fontsDir, 'LICENSE.md')) });
      ctx.warn('font.license-added', `模版字体 ${f.rel} 与 fonts/${repoFonts.get(sha256(f.buf))} 是同一份，已在同目录附上 fonts/LICENSE.md（OFL）`, null);
    } else {
      throw new CliError('contract.font-license', `模版字体 ${route.template}/${f.rel} 旁边没有许可文本`, '在模版同目录放许可（如 OFL.txt），或改用仓库 fonts/ 里的字体');
    }
  }
  const all = [...planned, ...extra].map(f => ({ rel: f.rel, mode: f.mode, out: f.out }));
  const fileList = all.map(f => ({ path: `${dirRel}/${f.rel}`, sha256: sha256(f.out), size: f.out.length }));

  // 6 下一步命令
  const vars = filmVars({ dir: dirRel, name: args.name, dur, fps: profile.fps, width: profile.width, height: profile.height });
  const steps = expandSteps(Array.isArray(tpl.next) && tpl.next.length ? tpl.next : route.next, vars).map(s => ({ ...s, ...formatStep(s) }));

  const data = {
    dryRun: !!opts['dry-run'],
    film: { dir: dirRel, id: film.id, title, route: route.id, profile: profile.id, profileFrom: from, width: profile.width, height: profile.height, fps: profile.fps, frameCount, durationSeconds: dur },
    route: { id: route.id, slug: route.slug, brand: route.brand, manual: route.manual, template: route.template, via: hit.via },
    profileSource: profiles.source,
    files: fileList.map(f => ({ ...f, action: opts['dry-run'] ? 'create' : 'created' })),
    filmJson: film,
    next: steps.map(s => ({ stage: s.stage, title: s.title, argv: s.argv, env: s.env, requires: s.requires, output: s.output, display: s.command, notes: s.notes })),
    validation: null,
  };

  const summary = () => {
    const lines = [];
    lines.push(`${opts['dry-run'] ? '（演练，没有写盘）将新建' : '已新建'} ${dirRel}/（${route.label}，模版 ${route.template}）`);
    lines.push(`  片名 ${title} · ${dur} 秒 · ${frameCount} 帧 · ${profile.fps} fps · ${profile.width}×${profile.height} · 档位 ${profile.id}（${from}）· film.json v2`);
    if (opts['dry-run']) for (const f of fileList) lines.push(`  + ${f.path}（${f.size} 字节）`);
    else lines.push(`  写入 ${fileList.length} 个文件`);
    lines.push(`下一步（在仓库根目录执行）：`);
    steps.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.title}`, `     ${s.command}`);
      for (const n of s.notes) lines.push(`     ${n}`);
    });
    lines.push(`路线手册：${route.manual}；产物只写到 ${dirRel}/out/（不提交）。`);
    return lines.join('\n');
  };

  if (opts['dry-run']) {
    data.validation = { status: 'skipped', reason: '演练模式不写盘，没有调用校验器' };
    ctx.out(summary());
    return { data };
  }

  // 写盘：临时目录 → 整体改名
  const filmsDir = path.join(ROOT, 'films');
  const createdFilmsDir = !fs.existsSync(filmsDir);
  const tmp = path.join(filmsDir, `.new-${args.name}-${process.pid}-${randomBytes(3).toString('hex')}`);
  const cleanup = () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (createdFilmsDir) { try { fs.rmdirSync(filmsDir); } catch { /* 不空就留着 */ } }
  };
  const unregister = ctx.onCleanup(cleanup);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of all) {
      const target = path.join(tmp, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.out);
      try { fs.chmodSync(target, f.mode); } catch { /* Windows 上权限位无意义 */ }
    }
    try { fs.renameSync(tmp, dst); } catch (e) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(e.code) && fs.existsSync(dst)) throw new CliError('usage.exists', `${dirRel} 刚被别的进程建好了：不覆盖`, '换个名字重跑');
      throw e;
    }
  } catch (e) {
    cleanup();
    unregister();
    if (e instanceof CliError) throw e;
    throw new CliError('failure.io', `写 ${dirRel} 失败：${e.message}`, '检查磁盘空间与目录权限后重跑（这次没有留下半个目录）');
  }
  unregister();

  // 5 作品描述校验器
  data.validation = runValidator(dirRel);
  if (data.validation.status === 'skipped') ctx.log.info(`作品描述校验：跳过（${data.validation.reason}）`);
  const outputs = fileList.map(f => ({ path: f.path, sha256: f.sha256, kind: f.path.endsWith('/film.json') ? 'film-json' : 'file' }));
  if (data.validation.status === 'failed') {
    return {
      data, outputs,
      error: { code: 'contract.film-check', message: `${dirRel} 已生成，但没通过 ${VALIDATOR} check（exit ${data.validation.exitCode}）：\n${data.validation.output}`, hint: `按上面的诊断修 ${dirRel}/film.json，再跑 node ${VALIDATOR} check ${dirRel}` },
    };
  }
  ctx.out(summary());
  return { data, outputs };
}

export const command = defineCommand({
  name: 'new-film',
  summary: '从路线模版新建一部作品：复制 routes/<路线>/template 到 films/<名字>/，生成 film.json v2，打印下一步命令',
  usage: ['node tools/new-film.mjs <路线> <名字> [--title 片名] [--profile 档位] [--dry-run] [--json]', 'npm run new -- <路线> <名字> [选项]'],
  description: () => {
    const { raw } = readRegistry(ROOT);
    const ok = raw && !validateRegistry(raw).length;
    const routes = ok ? raw.routes.map(r => `  ${r.id}  ${r.label}（旧名 ${r.aliases.join('、')}）→ 模版 ${r.template}`) : ['  （路线注册表 routes/routes.json 读不出来，先跑 npm run check:repo）'];
    return ['路线（来自 routes/routes.json，怎么选见 routes/README.md）：', ...routes, '',
      '不改模版、不渲染、不覆盖已有目录；--dry-run 不写任何文件。产物只写到 films/<名字>/out/（不提交）。'];
  },
  positionals: [
    { name: 'route', label: '<路线>', describe: 'a / b / c（也接受旧名与目录名，会提示改写）' },
    { name: 'name', label: '<名字>', describe: '作品名：小写字母、数字、连字符；同时是目录名与 film.json 的 id' },
  ],
  options: {
    title: { type: 'string', arg: '<片名>', describe: '片名，默认等于名字；不能含 " \' ` \\ < >', example: '破晓' },
    profile: { type: 'string', arg: '<档位>', describe: '交付档位，默认取模版声明的，否则 web-1080p24（D07）', example: 'vertical-1080x1920-30' },
    'dry-run': { type: 'boolean', describe: '只列出将要写的文件与下一步命令，不写盘' },
  },
  examples: [
    'node tools/new-film.mjs a dawn-test --title 破晓',
    'node tools/new-film.mjs c ink-note --title 墨记 --dry-run --json',
    'npm run new -- b buoy --profile web-1080p24',
  ],
  exitCodes: { 0: '成功', 1: '写盘失败', 2: '用法错误（路线、名字、片名、档位不合法，或目标目录已存在）', 4: '模版、注册表或生成的 film.json 不合格', 130: '被 Ctrl+C 中断，已清理', 143: '被终止，已清理' },
  run,
});

if (isMain(import.meta.url)) await runCli(command);
