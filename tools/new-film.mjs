#!/usr/bin/env node
// 北冥仓库 · 新建作品：把路线模版复制成 films/<名字>/，替换 {{NAME}} / {{TITLE}}，生成 film.json v2，校验通过后才落盘，打印下一步命令。
//   node tools/new-film.mjs <路线> <名字> [--title 片名] [--profile 档位] [--dry-run] [--json]
//   npm run new -- <路线> <名字> [选项]
// 路线、模版位置、下一步命令都从路线注册表 routes/routes.json 读（tools/lib/routes.mjs）；命令约定见 docs/CLI.md。
//
// 做什么（全部先在内存里算好、自检通过，再写进 films/.new-* 暂存目录，校验通过后整体改名；中途失败或被中断不留半个目录）：
//   1. 复制模版的全部文件，包括点文件（如 B 模版的 .gitignore）；跳过 out/、node_modules/、__pycache__/、.DS_Store
//      与模版自己 .gitignore 里列出的生成物目录；不跟符号链接。
//   2. 文本文件里的 {{NAME}} 换成名字、{{TITLE}} 换成片名；替换后还残留 {{大写标识符}} 就退出 4、什么都不写。
//      占位符只认「两层花括号 + 大写标识符」，JSX 的 style={{ color: P.ink }} 不受影响。
//   3. film.json 升到 v2（附录 C6，与 engine/production/film.js 的 upgradeFilm 同口径）：id = 名字；
//      output 按交付档位（--profile > 模版声明 > 注册表默认 web-1080p24，D07）；没有镜头表时整片一个镜头 S1；
//      gates 三道闸（D08）；backend、audio、style、aigc、credits 取模版声明，模版是 v1 时用注册表的 templateDefaults 补齐；
//      v1 的 poster（秒）换成 posterFrame（帧）；模版里有 dur / fps / size（v1 写法）时保留为兼容镜像，数值按 output 重写。
//      档位帧率与模版不同时，镜头、事件、停顿、海报帧按帧率比例换算（按节拍写的事件无法换算，拒绝并说明）。
//   4. 模版带字体文件而同目录没有许可文本时：字体与仓库 fonts/ 里的同一份 → 附上 fonts/LICENSE.md；否则退出 4。
//   5. 有作品描述校验器 engine/production/film.js 时，在暂存目录上跑 `film.js check --json`：不过退出 4、不留目录；
//      校验器自身出错退出 1（不放过没校验的作品）；--dry-run 不写任何文件，也就不调用校验器。
//   6. 下一步命令取模版 film.json 的 next，没有就取注册表这条路线的 next（生成的 film.json 里不保留 next）。
// 不改模版、不渲染、不覆盖已有目录；--dry-run 不写仓库里的任何文件。
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli, sha256, suggest } from './lib/cli.mjs';
import { expandSteps, filmVars, formatStep, loadRegistry, readRegistry, validateRegistry } from './lib/routes.mjs';
import { DEFAULT_PROFILE, loadProfiles } from './lib/profiles.mjs';
import { filmJsonProblems, findPlaceholders, formatFilmJson, nameProblem, titleProblem } from './lib/filmspec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_NAMES = new Set(['out', 'node_modules', '.git', '__pycache__', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const SKIP_EXT = new Set(['.pyc']);
const FONT_EXT = new Set(['.woff', '.woff2', '.ttf', '.otf']);
const LICENSE_RE = /^(licen[cs]e|ofl|copying)/i;
const VALIDATOR = 'engine/production/film.js';
const VALIDATOR_TIMEOUT_MS = 60_000;
/** 暂存目录名带来的「id 与目录名不同」不是作品的问题。 */
const STAGING_NOISE = new Set(['id-dir-mismatch']);
const toPosix = p => p.split(path.sep).join('/');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => structuredClone(v);

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

/** 模版的时间与画幅：v2 读 output，v1 读 dur / fps / size。 */
function templateTiming(tpl, where) {
  const v2 = tpl.schemaVersion === 2;
  const fps = v2 ? tpl.output?.fps : tpl.fps;
  const frameCount = v2 ? tpl.output?.frameCount : (Number.isFinite(tpl.dur) && Number.isInteger(fps) ? Math.round(tpl.dur * fps) : undefined);
  if (!(Number.isInteger(fps) && fps > 0 && Number.isInteger(frameCount) && frameCount > 0)) {
    throw new CliError('contract.template', `${where} 读不出片长与帧率`, 'v1 写 dur（秒）与 fps，v2 写 output.frameCount 与 output.fps');
  }
  const size = v2 ? [tpl.output?.width, tpl.output?.height] : (Array.isArray(tpl.size) ? tpl.size : [undefined, undefined]);
  return { fps, frameCount, seconds: frameCount / fps, size, declaredProfile: v2 ? (tpl.output?.profile ?? tpl.deliveries?.[0]) : undefined };
}

/** 交付档位：--profile > 模版 v2 声明 > 注册表默认 > profiles.json 的 default。 */
function pickProfile({ opt, declared, registry, profiles }) {
  const id = opt ?? declared ?? registry.defaultProfile ?? profiles.defaultId ?? DEFAULT_PROFILE;
  const p = profiles.profiles.get(id);
  if (p) return { profile: p, from: opt ? '--profile' : declared ? '模版' : '注册表默认' };
  const ids = [...profiles.profiles.keys()];
  const s = suggest(id, ids);
  const msg = `交付档位「${id}」不存在；可用：${ids.join('、')}`;
  if (opt) throw new CliError('usage.bad-profile', msg, s ? `是不是想写 --profile ${s}？` : '档位定义见 engine/production/profiles.json（D07）');
  throw new CliError('contract.template', `模版声明的${msg}`, '改模版 film.json 的 output.profile，或用 --profile 指定');
}

/**
 * 帧率变了：镜头、事件、停顿、海报帧按比例换算到新帧率（四舍五入后首尾相接，最后一镜止于 frameCount）。
 * 按节拍（beat）写的事件要靠节拍表重算，这里不猜，直接拒绝。返回换算说明（给警告用）。
 */
function rescaleFrames(film, ratio, frameCount, where) {
  const f = x => Math.round(x * ratio);
  const notes = [];
  if (Array.isArray(film.events) && film.events.some(e => isObj(e) && e.beat !== undefined)) {
    throw new CliError('contract.template', `${where} 的事件按节拍（beat）写，换帧率后帧号要按节拍表重算，new-film 不自动换算`, '用与模版同帧率的档位新建；或建好后用 node engine/production/film.js retime 重排');
  }
  if (Array.isArray(film.shots)) {
    film.shots = film.shots.map(s => (isObj(s) ? { ...s, in: f(s.in), out: f(s.out) } : s));
    film.shots.forEach((s, i) => {
      s.in = i ? film.shots[i - 1].out : 0;
      if (i === film.shots.length - 1) s.out = frameCount;
      if (s.actorClockOrigin && isObj(s.actorClockOrigin)) for (const k of Object.keys(s.actorClockOrigin)) s.actorClockOrigin[k] = Math.min(f(s.actorClockOrigin[k]), s.in);
    });
    const empty = film.shots.find(s => !(s.out > s.in));
    if (empty) throw new CliError('contract.template', `换帧率后镜头 ${empty.id} 变成了空镜头`, '这个镜头太短：用与模版同帧率的档位新建');
    notes.push(`镜头表按 ×${ratio.toFixed(4)} 换算`);
  }
  if (Array.isArray(film.events)) {
    film.events = film.events.map(e => {
      if (!isObj(e) || !Number.isInteger(e.frame)) return e;
      const shot = film.shots?.find(s => s.id === e.shot);
      const lo = shot ? shot.in : 0, hi = shot ? shot.out - 1 : frameCount - 1;
      const frame = Math.min(Math.max(f(e.frame), lo), hi);
      const out = { ...e, frame };
      if (Number.isInteger(e.end)) out.end = Math.min(Math.max(f(e.end), frame + 1), frameCount);
      return out;
    });
    if (film.events.length) notes.push(`${film.events.length} 个事件的帧号按比例换算（落在所属镜头内）`);
  }
  if (Array.isArray(film.holds)) film.holds = film.holds.map(h => (isObj(h) ? { ...h, in: Math.min(f(h.in), frameCount - 1), out: Math.min(Math.max(f(h.out), f(h.in) + 1), frameCount) } : h));
  if (Number.isInteger(film.posterFrame)) film.posterFrame = Math.min(f(film.posterFrame), frameCount - 1);
  if (film.shots?.some(s => Array.isArray(s?.tracks) && s.tracks.some(t => Number.isInteger(t?.step) && t.step > 1))) notes.push('镜头里有一拍 n 的轨道：新帧率下画格节奏会变，切点要重新落在画格上');
  return notes;
}

/** 声音：模版声明的优先；v1 模版按注册表默认补齐，并核对脚本文件在不在。 */
function pickAudio(tpl, route, files, warn) {
  if (tpl.audio !== undefined) return tpl.audio;
  const d = route.templateDefaults?.audio;
  if (!d) return undefined;
  if (d.mode === 'native') return { mode: tpl.native?.audio ? 'native' : 'none' };
  if (d.mode === 'script' && d.script && !files.has(d.script)) {
    warn('template.audio-missing', `注册表说声音脚本是 ${d.script}，但模版里没有这个文件：按无声片写 audio.mode = none`, '模版有声音就把脚本放进模版，或在模版 film.json 写 audio');
    return { mode: 'none' };
  }
  return clone(d);
}

/** 组装 film.json v2（键的顺序即文件里的顺序，与附录 C6 一致）。 */
function buildFilm({ tpl, timing, route, name, title, profile, profileFromOpt, frameCount, files, warn }) {
  const d = route.templateDefaults ?? {};
  const where = `${route.template}/film.json`;
  const v2 = tpl.schemaVersion === 2;
  const backend = tpl.backend ?? route.backend;
  if (Array.isArray(route.backends) && !route.backends.includes(backend)) {
    throw new CliError('contract.template', `${where} 的 backend ${JSON.stringify(backend)} 不在路线 ${route.id} 允许的 ${route.backends.join(' / ')} 里`, '改模版 film.json 的 backend（取值见 routes/routes.json 的 backends）');
  }
  const aigc = tpl.aigc ?? d.aigc;
  if (!aigc) throw new CliError('contract.template', `${where} 没有声明 aigc，注册表也没有补齐值`, '在模版 film.json 写 "aigc": { "contains": true|false, "note": "…" }（D11）');
  // 由下面逐项处理的键；v1 的 poster（秒）会换成 posterFrame，v2 模版里的 poster 原样带过去，由校验器指出模版写错了
  const consumed = new Set(['schemaVersion', '$comment', 'id', 'title', 'route', 'backend', 'output', 'deliveries', 'shots', 'events', 'holds',
    'drive', 'timeline', 'audio', 'style', 'assets', 'credits', 'aigc', 'gates', 'docs', 'methodRefs', 'native', 'cuecheck', 'posterFrame',
    'entry', 'notes', 'mirror', 'next', 'dur', 'fps', 'size', ...(v2 ? [] : ['poster'])]);
  const mirrors = ['dur', 'fps', 'size'].filter(k => k in tpl);
  const film = { schemaVersion: 2 };
  if (tpl.$comment !== undefined) film.$comment = tpl.$comment;
  else if (mirrors.length) film.$comment = `${mirrors.join(' / ')} 是 v1 兼容镜像：现有出片脚本还在读，数值与 output 一致；改时长或画幅时两处一起改（npm run check:repo 与 film.js check 会核对）`;
  Object.assign(film, { id: name, title, route: route.id, backend });
  film.output = { profile: profile.id, width: profile.width, height: profile.height, fps: profile.fps, frameCount };
  film.shots = Array.isArray(tpl.shots) && tpl.shots.length ? clone(tpl.shots) : [{ id: 'S1', in: 0, out: frameCount }];
  film.events = Array.isArray(tpl.events) ? clone(tpl.events) : [];
  for (const k of ['holds', 'drive', 'timeline']) if (tpl[k] !== undefined) film[k] = clone(tpl[k]);
  const audio = pickAudio(tpl, route, files, warn);
  if (audio !== undefined) film.audio = audio;
  film.deliveries = !profileFromOpt && Array.isArray(tpl.deliveries) && tpl.deliveries.length ? clone(tpl.deliveries) : [profile.id];
  const style = tpl.style ?? d.style;
  if (style !== undefined) film.style = clone(style);
  if (tpl.assets !== undefined) film.assets = clone(tpl.assets);
  film.credits = clone(tpl.credits ?? d.credits ?? []);
  film.aigc = clone(aigc);
  film.gates = tpl.gates ? clone(tpl.gates) : { look: 'required', animatic: 'required', final: 'required' };
  for (const k of ['docs', 'methodRefs', 'native', 'cuecheck', 'entry', 'notes']) if (tpl[k] !== undefined) film[k] = clone(tpl[k]);
  if (tpl.posterFrame !== undefined) film.posterFrame = tpl.posterFrame;
  // 模版自己的扩展字段原样带上（作品描述校验器会对不认识的字段给提示）
  for (const [k, v] of Object.entries(tpl)) if (!consumed.has(k)) film[k] = clone(v);

  const notes = [];
  if (profile.fps !== timing.fps) notes.push(...rescaleFrames(film, profile.fps / timing.fps, frameCount, where));
  // v1 的 poster 是秒：换成整数帧 posterFrame（与 film.js upgradeFilm 相同，四舍五入）
  if (!v2 && tpl.poster !== undefined) {
    if (typeof tpl.poster === 'number' && Number.isFinite(tpl.poster) && tpl.poster >= 0) {
      film.posterFrame = Math.min(Math.round(tpl.poster * profile.fps), frameCount - 1);
      notes.push(`海报 poster ${tpl.poster} 秒 → posterFrame ${film.posterFrame}`);
    } else warn('template.poster', `模版的 poster ${JSON.stringify(tpl.poster)} 不是秒数，没有迁移`, '模版改写成 posterFrame（整数帧）');
  }
  // v1 兼容镜像：模版里有才写，数值跟 output 走
  if ('dur' in tpl) film.dur = Number((frameCount / profile.fps).toFixed(6));
  if ('fps' in tpl) film.fps = profile.fps;
  if ('size' in tpl) film.size = [profile.width, profile.height];
  return { film, notes };
}

/** 解析作品描述校验器的 --json 输出（附录 C2 信封；结果在 result 或 data 里）。 */
function parseValidator(r, fromRel, toRel) {
  const fix = s => (typeof s === 'string' ? s.split(fromRel).join(toRel) : s);
  let env = null;
  try { env = JSON.parse(r.stdout); } catch { env = null; }
  const body = env?.result ?? env?.data ?? null;
  const diagnostics = (Array.isArray(body?.diagnostics) ? body.diagnostics : [])
    .filter(x => x && !STAGING_NOISE.has(x.code))
    .map(x => ({ level: x.level === 'error' ? 'error' : 'warning', code: String(x.code ?? 'film-check'), path: fix(x.path ?? null), message: fix(String(x.message ?? '')), hint: fix(x.hint ?? null) || null }));
  return { env, diagnostics };
}

/**
 * 调作品描述校验器。target 是仓库相对的暂存目录（films/.new-*）；诊断里的暂存路径换回最终的 films/<名字>。
 * 返回 { status: passed|failed|error|skipped, … }，只读，不改任何文件。
 */
function runValidator({ target, fromRel, toRel, scope }) {
  const command = ['node', VALIDATOR, 'check', toRel, '--json'];
  if (!fs.existsSync(path.join(ROOT, VALIDATOR))) return { status: 'skipped', scope, reason: `${VALIDATOR} 还没有（作品描述包落地后自动启用）`, command, diagnostics: [] };
  const r = spawnSync(process.execPath, [path.join(ROOT, VALIDATOR), 'check', target, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: VALIDATOR_TIMEOUT_MS, maxBuffer: 16 << 20, env: { ...process.env, NO_COLOR: '1' },
  });
  const { env, diagnostics } = parseValidator(r, fromRel, toRel);
  const base = { scope, command, exitCode: r.status, diagnostics };
  if (r.error) return { ...base, status: 'error', reason: r.error.code === 'ETIMEDOUT' ? `超过 ${VALIDATOR_TIMEOUT_MS / 1000} 秒没有返回` : `没跑起来（${r.error.code ?? r.error.message}）` };
  if (r.status === 0) return { ...base, status: 'passed' };
  if (r.status === 4) return { ...base, status: 'failed', message: env?.error?.message ?? null };
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n');
  return { ...base, status: 'error', reason: `退出码 ${r.status}${env?.error?.message ? `：${env.error.message}` : tail ? `：${tail}` : ''}` };
}

const fmtDiag = x => `[${x.code}] ${x.path ? `${x.path}：` : ''}${x.message}${x.hint ? `（${x.hint}）` : ''}`;

/** 校验结果 → 异常（不通过；信封的 data 带上生成结果与全部诊断）或警告（通过但有提示）。 */
function settleValidation(v, ctx, data) {
  const dirRel = data.film.dir;
  if (v.status === 'failed') {
    const errs = v.diagnostics.filter(x => x.level === 'error');
    const head = errs.length ? errs.slice(0, 6).map(fmtDiag).join('；') + (errs.length > 6 ? '……' : '') : (v.message ?? '校验器没有给出诊断');
    throw new CliError('contract.film-check', `生成的 ${dirRel}/film.json 没通过 ${VALIDATOR} check（${errs.length} 个错误）：${head}`,
      { hint: `这是模版或注册表的问题：按诊断改 ${data.route.template}/ 或 routes/routes.json 的 templateDefaults 后重跑（这次什么都没写）；--dry-run --json 可看生成的 film.json`, data });
  }
  if (v.status === 'error') {
    throw new CliError('failure.film-check', `作品描述校验器 ${VALIDATOR} 自身出错，无法确认作品合格：${v.reason}`,
      { hint: `单独跑 ${v.command.join(' ')} 看完整输出；修好校验器再重跑（这次什么都没写）`, data });
  }
  if (v.status === 'skipped') ctx.log.info(`作品描述校验：跳过（${v.reason}）`);
  for (const x of v.diagnostics.filter(d => d.level === 'warning')) ctx.warn(`film-check.${x.code}`, `${x.path ? `${x.path}：` : ''}${x.message}`, x.hint);
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
  const where = `${route.template}/film.json`;
  const fjEntry = planned.find(f => f.rel === 'film.json');
  if (!fjEntry) throw new CliError('contract.template', `${where} 不存在`, '跑 npm run check:repo 查看模版问题');
  let tpl;
  try { tpl = JSON.parse(fjEntry.replacedText); } catch (e) {
    throw new CliError('contract.template', `${where} 不是合法 JSON（${e.message}）`, '修好模版后重跑；npm run check:repo 会给出位置');
  }
  if (!isObj(tpl)) throw new CliError('contract.template', `${where} 顶层不是对象`, '修好模版后重跑');
  if (tpl.route !== route.id) throw new CliError('contract.template', `${where} 的 route 是 ${JSON.stringify(tpl.route)}，注册表里这条路线的 id 是 "${route.id}"`, '模版 film.json 的 route 要写注册表 id');
  if (tpl.schemaVersion !== undefined && tpl.schemaVersion !== 2) throw new CliError('contract.template', `${where} 的 schemaVersion 是 ${JSON.stringify(tpl.schemaVersion)}：只认 2（v1 不写）`, '模版 film.json 按附录 C6 写');
  const timing = templateTiming(tpl, where);
  const profiles = loadProfiles(ROOT);
  for (const w of profiles.warnings) ctx.warn('profile.source', w);
  const { profile, from } = pickProfile({ opt: opts.profile, declared: timing.declaredProfile, registry, profiles });
  if (profile.reserved) ctx.warn('profile.reserved', `档位 ${profile.id}：${profile.reserved}`, `新作品用 ${registry.defaultProfile ?? DEFAULT_PROFILE}`);
  const exact = timing.seconds * profile.fps;
  const frameCount = Math.round(exact);
  if (Math.abs(exact - frameCount) > 1e-6) ctx.warn('film.frames-rounded', `片长 ${timing.seconds} 秒 × ${profile.fps} fps 不是整数帧，按 ${frameCount} 帧`, '把片长改成帧数的整数倍');
  const dur = Number((frameCount / profile.fps).toFixed(6));
  if (timing.size[0] !== undefined && (timing.size[0] !== profile.width || timing.size[1] !== profile.height)) {
    ctx.warn('template.size-changed', `模版画幅 ${timing.size.join('×')} 与档位 ${profile.id} 的 ${profile.width}×${profile.height} 不同，已按档位写 film.json`, '构图按新画幅摆：先跑下一步的关键帧命令看一眼');
  }
  const rels = new Set(planned.map(f => f.rel));
  const { film, notes } = buildFilm({ tpl, timing, route, name: args.name, title, profile, profileFromOpt: !!opts.profile, frameCount, files: rels, warn: ctx.warn });
  if (timing.fps !== profile.fps) {
    ctx.warn('template.fps-changed', `模版帧率 ${timing.fps} 与档位 ${profile.id} 的 ${profile.fps} fps 不同：${notes.filter(n => !n.startsWith('海报')).join('；') || '片长按秒数换算'}`,
      '页面或声音脚本里按旧帧率写死的节拍、一拍 n、切点要一起改；作品描述校验器会核对页面里的 FPS / DUR 常量');
  }
  const problems = filmJsonProblems(film, { mode: 'film', routeIds: registry.ids, dirName: args.name });
  if (problems.length) throw new CliError('contract.film-json', `生成的 film.json 不合格：${problems.join('；')}`, '这是模版或 new-film 的问题：附上命令报告给维护者');
  const filmText = formatFilmJson(film);
  fjEntry.out = Buffer.from(filmText, 'utf8');

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
    film: { dir: dirRel, id: film.id, title, route: route.id, backend: film.backend, profile: profile.id, profileFrom: from, width: profile.width, height: profile.height, fps: profile.fps, frameCount, durationSeconds: dur },
    route: { id: route.id, slug: route.slug, brand: route.brand, manual: route.manual, template: route.template, via: hit.via },
    profileSource: profiles.source,
    files: fileList.map(f => ({ ...f, action: opts['dry-run'] ? 'create' : 'created' })),
    filmJson: film,
    notes,
    next: steps.map(s => ({ stage: s.stage, title: s.title, argv: s.argv, env: s.env, requires: s.requires, output: s.output, display: s.command, notes: s.notes })),
    validation: null,
  };

  const summary = () => {
    const lines = [];
    lines.push(`${opts['dry-run'] ? '（演练，没有写盘）将新建' : '已新建'} ${dirRel}/（${route.label}，模版 ${route.template}）`);
    lines.push(`  片名 ${title} · ${dur} 秒 · ${frameCount} 帧 · ${profile.fps} fps · ${profile.width}×${profile.height} · 档位 ${profile.id}（${from}）· film.json v2`);
    const v = data.validation;
    lines.push(`  作品描述校验：${v.status === 'passed' ? `通过（${VALIDATOR} check）` : `跳过（${v.reason}）`}`);
    if (opts['dry-run']) for (const f of fileList) lines.push(`  + ${f.path}（${f.size} 字节）`);
    else lines.push(`  写入 ${fileList.length} 个文件`);
    lines.push('下一步（在仓库根目录执行）：');
    steps.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.title}`, `     ${s.command}`);
      for (const n of s.notes) lines.push(`     ${n}`);
    });
    lines.push(`路线手册：${route.manual}；产物只写到 ${dirRel}/out/（不提交）。`);
    return lines.join('\n');
  };

  if (opts['dry-run']) {
    // 演练不写任何文件（连暂存目录也不建）：校验器要在仓库里的作品目录上跑（../../ 引用的共享素材按仓库解析），正式生成时才调用
    data.validation = { status: 'skipped', scope: 'none', reason: '演练不写盘，没有调用校验器；正式生成时先在暂存目录里校验，不过就不落盘', command: ['node', VALIDATOR, 'check', dirRel, '--json'], diagnostics: [] };
    ctx.out(summary());
    return { data };
  }

  // 写盘：暂存目录 → 校验 → 整体改名
  const filmsDir = path.join(ROOT, 'films');
  const createdFilmsDir = !fs.existsSync(filmsDir);
  const stagingName = `.new-${args.name}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const tmp = path.join(filmsDir, stagingName);
  const cleanup = () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (createdFilmsDir) { try { fs.rmdirSync(filmsDir); } catch { /* 不空就留着 */ } }
  };
  const unregister = ctx.onCleanup(cleanup);
  try {
    try {
      fs.mkdirSync(tmp, { recursive: true });
      for (const f of all) {
        const target = path.join(tmp, ...f.rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.out);
        try { fs.chmodSync(target, f.mode); } catch { /* Windows 上权限位无意义 */ }
      }
    } catch (e) {
      throw new CliError('failure.io', `写 ${dirRel} 失败：${e.message}`, '检查磁盘空间与目录权限后重跑（这次没有留下半个目录）');
    }
    // 5 作品描述校验器（在暂存目录上，文件、路径、页面时间常量一起查）
    data.validation = runValidator({ target: `films/${stagingName}`, fromRel: `films/${stagingName}`, toRel: dirRel, scope: 'full' });
    settleValidation(data.validation, ctx, data);
    try { fs.renameSync(tmp, dst); } catch (e) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(e.code) && fs.existsSync(dst)) throw new CliError('usage.exists', `${dirRel} 刚被别的进程建好了：不覆盖`, '换个名字重跑');
      throw new CliError('failure.io', `把暂存目录改名为 ${dirRel} 失败：${e.message}`, '检查目录权限后重跑（这次没有留下半个目录）');
    }
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    unregister();
  }

  const outputs = fileList.map(f => ({ path: f.path, sha256: f.sha256, kind: f.path.endsWith('/film.json') ? 'film-json' : 'file' }));
  ctx.out(summary());
  return { data, outputs };
}

export const command = defineCommand({
  name: 'new-film',
  summary: '从路线模版新建一部作品：复制 routes/<路线>/template 到 films/<名字>/，生成并校验 film.json v2，打印下一步命令',
  usage: ['node tools/new-film.mjs <路线> <名字> [--title 片名] [--profile 档位] [--dry-run] [--json]', 'npm run new -- <路线> <名字> [选项]'],
  description: () => {
    const { raw } = readRegistry(ROOT);
    const ok = raw && !validateRegistry(raw).length;
    const routes = ok ? raw.routes.map(r => `  ${r.id}  ${r.label}（旧名 ${r.aliases.join('、')}）→ 模版 ${r.template}`) : ['  （路线注册表 routes/routes.json 读不出来，先跑 npm run check:repo）'];
    return ['路线（来自 routes/routes.json，怎么选见 routes/README.md）：', ...routes, '',
      `有作品描述校验器 ${VALIDATOR} 时，生成的作品先在暂存目录里校验，通过才落到 films/<名字>/。`,
      '不改模版、不渲染、不覆盖已有目录；--dry-run 不写仓库里的任何文件。产物只写到 films/<名字>/out/（不提交）。'];
  },
  positionals: [
    { name: 'route', label: '<路线>', describe: 'a / b / c（也接受旧名与目录名，会提示改写）' },
    { name: 'name', label: '<名字>', describe: '作品名：小写字母、数字、连字符；同时是目录名与 film.json 的 id' },
  ],
  options: {
    title: { type: 'string', arg: '<片名>', describe: '片名，默认等于名字；不能含 " \' ` \\ < >', example: '破晓' },
    profile: { type: 'string', arg: '<档位>', describe: '交付档位，默认取模版声明的，否则 web-1080p24（D07）', example: 'vertical-1080x1920-30' },
    'dry-run': { type: 'boolean', describe: '只列出将要写的文件、film.json 与下一步命令，不写任何文件（也不调用校验器）' },
  },
  examples: [
    'node tools/new-film.mjs a dawn-test --title 破晓',
    'node tools/new-film.mjs c ink-note --title 墨记 --dry-run --json',
    'npm run new -- b buoy --profile web-1080p24',
  ],
  exitCodes: { 0: '成功', 1: '写盘失败或作品描述校验器自身出错', 2: '用法错误（路线、名字、片名、档位不合法，或目标目录已存在）', 4: '模版、注册表或生成的 film.json 不合格（含校验器 check 不通过）', 130: '被 Ctrl+C 中断，已清理', 143: '被终止，已清理' },
  run,
});

if (isMain(import.meta.url)) await runCli(command);
