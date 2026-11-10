#!/usr/bin/env node
// 北冥 QA 门 · 命令入口：npm run qa -- <子命令>（注册前直接 node tools/qa/cli.mjs <子命令>）
//
//   delivery <成片>   交付规格：容器、完整解码、帧数、帧率 / CFR、尺寸、SAR、编码、像素格式、BT.709 tv、音轨、音画首尾、响度、真峰值、AIGC 标识
//   visual   <成片>   画面异常：黑场、静帧、闪帧、切点对照镜头表、跳帧、大面积闪烁、边缘露底、截断竖边
//   texts             文字：打开作品页面逐帧读 window.TEXTS，查越界、安全区、停留时长、对比度、缺字（cmap）
//   sync     <成片>   声画同步：作品描述的事件帧 vs 最终音轨的起音
//   report   <成片>   以上全部 → qa/report.json + report.md + contact.jpg
//   profiles          列出交付档位及来源
//   validate <报告>   校验一份 qa/report.json 的结构
//
// 退出码（附录 C1）：0 通过 / 1 运行失败 / 2 用法错误 / 3 环境缺失 / 4 硬门不通过 / 124 超时 / 130、143 收到信号。
// --json：stdout 只输出一个信封对象 { ok, exitCode, command, error, outputs, runJson, warnings, result }，日志走 stderr。
// --help：只打印用法，不读文件、不起进程。阈值与豁免的写法见 docs/quality/QA-GATE.md。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, QaError, usageError, parseArgs, envelope, log, installSignalHandlers, runCleanups } from './lib/cli-kit.mjs';
import { loadProfiles, resolveProfile, REPO_ROOT } from './lib/profiles.mjs';
import { findFilm, loadFilm, loadEvents, runDirOf, repoRootOf } from './lib/film.mjs';
import { collectWaivers, applyWaivers } from './lib/waivers.mjs';
import { buildReport, validateReport, toMarkdown, technicalAcceptanceFrom } from './lib/report.mjs';
import { requireFfmpeg } from './lib/proc.mjs';
import { sha256File } from './lib/probe.mjs';

const COMMON = {
  '--json': { type: 'boolean', desc: 'stdout 只输出一个 JSON 信封' },
  '--help': { type: 'boolean', alias: '-h', desc: '打印用法' },
  '--profile': { type: 'string', desc: '交付档位 id（缺省取 film.json 的 output.profile，再缺省 web-1080p24）' },
  '--profiles-file': { type: 'string', desc: '改用这份档位表（试验用；正式判定读 engine/production/profiles.json）' },
  '--film': { type: 'string', desc: '作品目录或 film.json；成片在 films/<名>/out/ 下时自动找' },
  '--waivers': { type: 'list', desc: '额外的豁免文件（JSON，可重复）' },
  '--out': { type: 'string', desc: '把结果写进这个目录' },
  '--timeout': { type: 'number', min: 1, desc: '单个外部进程的超时秒数（默认 600）' },
};
const pick = (...keys) => Object.fromEntries(keys.map(k => [k, COMMON[k]]));
const PAGE = {
  '--page': { type: 'string', desc: '页面目录（含 index.html）；缺省用作品目录' },
  '--step': { type: 'number', min: 1, desc: '每隔几帧采一次（默认 1，即逐帧）' },
  '--ready-timeout': { type: 'number', min: 1, desc: '等 window.READY 的秒数（默认 120）' },
  '--no-contrast': { type: 'boolean', desc: '跳过对比度（不截图，快）' },
};
const SUBS = {
  delivery: { args: '<成片>', pos: 1, options: pick('--json', '--help', '--profile', '--profiles-file', '--film', '--waivers', '--out', '--timeout') },
  visual: { args: '<成片>', pos: 1, options: pick('--json', '--help', '--profile', '--profiles-file', '--film', '--waivers', '--out', '--timeout') },
  texts: { args: '', pos: 0, options: { ...pick('--json', '--help', '--profile', '--profiles-file', '--film', '--waivers', '--out', '--timeout'), ...PAGE } },
  sync: { args: '<成片>', pos: 1, options: { ...pick('--json', '--help', '--profile', '--profiles-file', '--film', '--waivers', '--out', '--timeout'), '--events': { type: 'string', desc: '事件表（film.json 或 events.json）；缺省用作品描述的 events' } } },
  report: {
    args: '<成片>', pos: 1,
    options: {
      ...pick('--json', '--help', '--profile', '--profiles-file', '--film', '--waivers', '--out', '--timeout'), ...PAGE,
      '--events': { type: 'string', desc: '事件表（缺省用作品描述的 events）' },
      '--skip': { type: 'list', desc: '跳过的检查组：delivery,visual,texts,sync' },
      '--no-sheet': { type: 'boolean', desc: '不出联系表' },
    },
  },
  profiles: { args: '', pos: 0, options: pick('--json', '--help', '--profiles-file') },
  validate: { args: '<qa/report.json>', pos: 1, options: pick('--json', '--help') },
};
const DESC = {
  delivery: '交付规格（容器、解码、帧数、帧率、色彩、音轨、响度、AIGC 标识）',
  visual: '画面异常（黑场、静帧、闪帧、切点、跳帧、闪烁、露边）',
  texts: '文字（越界、安全区、停留时长、对比度、缺字）；需要页面与无头浏览器',
  sync: '声画同步（事件帧 vs 起音，按 craft/animation.md §5.7 的不对称容差）',
  report: '全部检查 → qa/report.json + report.md + contact.jpg',
  profiles: '列出交付档位、来源与关键数值',
  validate: '校验 qa/report.json 的结构（附录 C8）',
};

function usage(sub) {
  if (!sub) {
    return ['用法：node tools/qa/cli.mjs <子命令> [参数]（注册后：npm run qa -- <子命令>）', '',
      ...Object.entries(SUBS).map(([k, s]) => `  ${(k + ' ' + s.args).padEnd(28)} ${DESC[k]}`), '',
      '每个子命令都有 --help。退出码：0 通过、2 用法错误、3 环境缺失、4 硬门不通过、1 运行失败、124 超时。',
      '例：node tools/qa/cli.mjs report films/chendu/out/latest-run/master.mp4 --profile web-1080p24 --json',
      '说明：docs/quality/QA-GATE.md（每项检查的含义、阈值出处、怎么豁免）'].join('\n');
  }
  const s = SUBS[sub];
  const opts = Object.entries(s.options).map(([k, o]) => `  ${(k + (o.alias ? `, ${o.alias}` : '') + (o.type === 'boolean' ? '' : ' <值>')).padEnd(26)} ${o.desc}`);
  return [`用法：node tools/qa/cli.mjs ${sub} ${s.args}`.trim(), '', DESC[sub], '', '参数：', ...opts].join('\n');
}

// 被检查的仓库：成片 / 页面 / 作品描述所在的仓库（往上找 package.json + engine/），找不到就用本工具所在的仓库。
// 报告里的路径、已知问题台账、豁免目录、权威档位表都相对它。
let ROOT = REPO_ROOT;
const rel = p => {
  const r = path.relative(ROOT, path.resolve(p));
  return (r.startsWith('..') || path.isAbsolute(r) ? path.resolve(p) : r).split(path.sep).join('/');
};

function context(opts, input) {
  const store = loadProfiles({ root: ROOT, file: opts.profilesFile || null });
  const filmFile = findFilm({ film: opts.film, input });
  const film = filmFile ? loadFilm(filmFile) : null;
  if (film) film.relFile = rel(filmFile);
  const profile = resolveProfile(store, opts.profile, film);
  const { waivers, warnings: ww } = collectWaivers({ film, files: opts.waivers || [], root: ROOT });
  const warnings = [...store.warnings, ...profile.warnings, ...(film?.warnings || []).map(w => `作品描述：${w}`), ...ww];
  const timeoutMs = (opts.timeout || 600) * 1000;
  return { store, film, profile, waivers, warnings, timeoutMs };
}

function checkInput(p) {
  if (!p) throw usageError('缺少成片路径');
  if (!fs.existsSync(p)) throw new QaError('usage', `找不到文件：${p}`, { hint: '给出成片的路径（例如 films/<名>/out/<run-id>/master.mp4）', exitCode: EXIT.USAGE });
  if (!fs.statSync(p).isFile()) throw new QaError('usage', `${p} 不是文件`, { exitCode: EXIT.USAGE });
}

async function envInfo() {
  const ff = await requireFfmpeg(['ebur128', 'extractplanes', 'scale', 'select', 'ametadata']);
  return { ffmpeg: ff.version, node: process.versions.node, platform: `${process.platform}-${process.arch}`, warnings: ff.warnings };
}

async function writeOut(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const outputs = [];
  for (const f of files) {
    const p = path.join(dir, f.name);
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, f.data);
    fs.renameSync(tmp, p);
    outputs.push({ path: rel(p), sha256: await sha256File(p), kind: f.kind });
  }
  return outputs;
}

async function runGroups(sub, opts, input) {
  const ctx = context(opts, input);
  const env = input || sub !== 'texts' ? await envInfo() : { node: process.versions.node, platform: `${process.platform}-${process.arch}`, warnings: [] };
  const warnings = [...ctx.warnings, ...env.warnings];
  const groups = sub === 'report' ? ['delivery', 'visual', 'texts', 'sync'].filter(g => !(opts.skip || []).includes(g)) : [sub];
  const bad = (opts.skip || []).filter(g => !['delivery', 'visual', 'texts', 'sync'].includes(g));
  if (bad.length) throw usageError(`--skip 只认 delivery,visual,texts,sync，收到 ${bad.join(',')}`);
  const checks = [], skipped = [], extra = {}, errors = [];
  let probe = null, facts = null, foi = [];
  for (const g of groups) {
    try {
      if (g === 'delivery') {
        const { runDelivery } = await import('./checks/delivery.mjs');
        log(`▶ delivery：${rel(input)}`);
        const r = await runDelivery({ input, profile: ctx.profile, film: ctx.film, timeoutMs: ctx.timeoutMs });
        checks.push(...r.checks); probe = r.probe; facts = r.facts;
        if (!probe) { log('  容器无法解析，其余检查跳过'); break; }
      } else if (g === 'visual') {
        const { runVisual } = await import('./checks/visual.mjs');
        log('▶ visual：解码分析画面');
        const r = await runVisual({ input, profile: ctx.profile, film: ctx.film, probe, timeoutMs: ctx.timeoutMs });
        checks.push(...r.checks); foi = [...new Set([...foi, ...r.framesOfInterest])]; extra.visualSeries = r.series;
      } else if (g === 'texts') {
        const pageDir = opts.page ? path.resolve(opts.page) : ctx.film?.dir;
        if (!pageDir || !fs.existsSync(path.join(pageDir, 'index.html'))) {
          const why = opts.page ? `${opts.page} 里没有 index.html` : '没有可打开的作品页面（B 路线原生片没有页面；页面型作品用 --page 或 --film 指定）';
          if (sub === 'texts') throw new QaError('usage', why, { exitCode: EXIT.USAGE });
          skipped.push({ group: 'texts', reason: why });
          continue;
        }
        const { runTexts } = await import('./checks/texts.mjs');
        log(`▶ texts：打开 ${rel(pageDir)}/index.html 逐帧读文字`);
        const r = await runTexts({ pageDir, root: repoRootOf(pageDir) || ROOT, profile: ctx.profile, film: ctx.film, step: opts.step || 1, readyTimeoutMs: (opts.readyTimeout || 120) * 1000, contrast: !opts.noContrast, timeoutMs: ctx.timeoutMs });
        checks.push(...r.checks); warnings.push(...r.warnings); extra.texts = r.summary;
        // 文字有问题的帧也进联系表（红框）
        for (const c of r.checks) for (const f of c.findings || []) if ((f.status === 'fail' || f.status === 'warn') && f.frames) foi.push(f.frames[0]);
        foi = [...new Set(foi)].sort((a, b) => a - b);
      } else if (g === 'sync') {
        // 事件表：--events 优先；作品描述没写 events 时，用作品目录里 C 路线导出的 events.json（engine/render/events.mjs）
        let evFile = opts.events ? path.resolve(opts.events) : null;
        if (!evFile && !(ctx.film?.events || []).length && ctx.film?.dir && fs.existsSync(path.join(ctx.film.dir, 'events.json'))) {
          evFile = path.join(ctx.film.dir, 'events.json');
          warnings.push(`作品描述没有 events，声画同步改用 ${rel(evFile)}`);
        }
        const events = evFile ? loadEvents(evFile, ctx.film?.fps || null) : (ctx.film?.events || []);
        if (!events.some(e => e.needsSound)) {
          const why = opts.events ? `${opts.events} 里没有要求有声的事件` : '作品描述没有要求有声的事件（events[].audio / sfx / cue）';
          if (sub === 'sync') throw new QaError('usage', why, { hint: '用 --events 指定事件表，或在 film.json 的 events 里给事件写 audio', exitCode: EXIT.USAGE });
          skipped.push({ group: 'sync', reason: why });
          continue;
        }
        const { runSync } = await import('./checks/sync.mjs');
        log(`▶ sync：${events.filter(e => e.needsSound).length} 个要求有声的事件`);
        const r = await runSync({ input, profile: ctx.profile, film: ctx.film, events, probe, timeoutMs: ctx.timeoutMs });
        checks.push(...r.checks);
      }
    } catch (e) {
      if (e instanceof QaError && (e.exitCode === EXIT.USAGE || sub !== 'report')) throw e;
      errors.push({ group: g, error: e });
      log(`  ${g} 没能完成：${e.message}`);
      const { CHECKS, makeCheck, notRun } = await import('./lib/checks.mjs');
      for (const id of Object.keys(CHECKS).filter(k => CHECKS[k].group === g)) checks.push(notRun(makeCheck(id), e.message, e.hint));
    }
  }
  if (sub === 'report') {
    const ki = await knownIssues(ctx.film);
    if (ki) checks.push(ki);
  }
  for (const c of checks) applyWaivers(c, ctx.waivers);
  const report = buildReport({
    film: ctx.film, input: input ? { path: rel(input), sha256: facts?.sha256 || await sha256File(input), bytes: facts?.size ?? fs.statSync(input).size } : null,
    profile: ctx.profile, checks, groups: groups.filter(g => !skipped.some(s => s.group === g)), skipped, warnings,
    env: { ffmpeg: env.ffmpeg ?? null, node: env.node, platform: env.platform }, extra: { ...extra, facts: facts || null, framesOfInterest: foi },
  });
  return { report, errors, ctx, probe, foi };
}

async function knownIssues(film) {
  const { makeCheck, finding, settle } = await import('./lib/checks.mjs');
  const file = path.join(ROOT, 'docs/quality/known-issues.json');
  if (!film || !fs.existsSync(file)) return null;
  const c = makeCheck('known-issues.open', { expected: '没有未放行的 P0 / P1' });
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { finding(c, { key: 'parse', status: 'warn', message: `docs/quality/known-issues.json 读不出来：${e.message}` }); return settle(c); }
  const mine = (doc.issues || []).filter(i => i.film === film.id);
  c.value = mine.length ? mine.map(i => `${i.id}（${i.severity}，${i.status}）`).join('、') : '台账里没有本作品的条目';
  for (const i of mine.filter(x => x.status === 'open')) {
    finding(c, { key: i.id, target: i.id, status: ['P0', 'P1'].includes(i.severity) ? 'fail' : 'warn', message: `${i.id} ${i.title}（${i.severity}，未关闭）`, hint: i.regression?.command ? `修好后跑：${i.regression.command}` : null });
  }
  return settle(c);
}

// 报告默认写到：运行目录下的 qa/；成片在某个 out/ 目录里时写到同目录的 qa/<文件名>/；否则写到仓库根的 out/qa/<文件名>/
function defaultOutDir(input) {
  const run = runDirOf(input);
  if (run) return path.join(run, 'qa');
  const abs = path.resolve(input);
  const base = path.basename(abs).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'film';
  const root = repoRootOf(abs) || ROOT;
  const relDir = path.relative(root, path.dirname(abs));
  const inOut = !relDir.startsWith('..') && !path.isAbsolute(relDir) && relDir.split(path.sep).includes('out');
  return inOut ? path.join(path.dirname(abs), 'qa', base) : path.join(root, 'out', 'qa', base);
}

function printHuman(report) {
  const W = { pass: '通过', fail: '不通过', warn: '注意', waived: '豁免' };
  const lines = [`${report.ok ? '✔ 机器检查通过' : '✘ 机器检查不通过'}　档位 ${report.profile.id}${report.input ? `　${report.input.path}` : ''}`];
  for (const c of report.checks) {
    lines.push(`  ${W[c.status].padEnd(4)} ${c.id.padEnd(22)} ${String(c.value ?? '').slice(0, 70)}`);
    for (const f of (c.findings || []).filter(x => x.status === 'fail' || x.status === 'warn').slice(0, 4)) lines.push(`         · ${f.message}`);
  }
  if (report.skipped.length) lines.push(`  未执行：${report.skipped.map(s => `${s.group}（${s.reason}）`).join('；')}`);
  for (const w of report.warnings) lines.push(`  提示：${w}`);
  process.stdout.write(lines.join('\n') + '\n');
}

async function main(argv) {
  const sub = argv[0];
  if (sub === undefined) { process.stderr.write(usage() + '\n'); return { code: EXIT.USAGE, command: 'qa', error: usageError('缺少子命令') }; }
  if (sub === '--help' || sub === '-h' || sub === 'help') { process.stdout.write(usage() + '\n'); return { code: EXIT.OK, command: 'qa', silent: true }; }
  if (!SUBS[sub]) throw usageError(`未知子命令 ${sub}`, `可用：${Object.keys(SUBS).join('、')}`);
  const spec = SUBS[sub];
  const { opts, positionals } = parseArgs(argv.slice(1), { options: spec.options, positionals: { min: 0, max: spec.pos, names: [spec.args] } });
  const command = `qa ${sub}`;
  if (opts.help) { process.stdout.write(usage(sub) + '\n'); return { code: EXIT.OK, command, silent: true }; }
  if (positionals.length < spec.pos) throw usageError(`缺少参数 ${spec.args}`, `node tools/qa/cli.mjs ${sub} --help`);

  ROOT = repoRootOf(positionals[0] || opts.page || opts.film || process.cwd()) || REPO_ROOT;
  if (sub === 'profiles') {
    const store = loadProfiles({ root: ROOT, file: opts.profilesFile || null });
    const list = [...store.profiles.values()].map(p => ({ id: p.id, label: p.label, source: p.source, width: p.width, height: p.height, fps: p.fps, pixFmt: p.video.pixFmt, color: `${p.video.colorRange}/${p.video.colorSpace}`, loudness: `${p.audio.integratedLufs}±${p.audio.lufsTolerance} LUFS`, truePeak: `≤${p.audio.truePeakMaxDbtp} dBTP` }));
    if (!opts.json) process.stdout.write(list.map(p => `${p.id.padEnd(24)} ${p.width}×${p.height} ${p.fps}fps ${p.color} ${p.loudness} ${p.truePeak}  来源 ${p.source}`).join('\n') + '\n');
    return { code: EXIT.OK, command, ok: true, result: { source: store.source, profiles: list }, warnings: [...store.warnings, ...new Set([...store.profiles.values()].flatMap(p => p.warnings))], json: opts.json };
  }
  if (sub === 'validate') {
    const f = positionals[0];
    if (!fs.existsSync(f)) throw new QaError('usage', `找不到 ${f}`, { exitCode: EXIT.USAGE });
    let doc;
    try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return { code: EXIT.GATE, command, ok: false, error: new QaError('report.invalid', `${f} 不是合法 JSON：${e.message}`), json: opts.json }; }
    const v = validateReport(doc);
    if (!opts.json) process.stdout.write(v.ok ? `✔ ${f} 结构合格\n` : `✘ ${f} 结构不合格：\n${v.errors.map(x => '  · ' + x).join('\n')}\n`);
    return { code: v.ok ? EXIT.OK : EXIT.GATE, command, ok: v.ok, result: v, json: opts.json, error: v.ok ? null : new QaError('report.invalid', v.errors[0]) };
  }

  const input = spec.pos ? positionals[0] : null;
  if (input) checkInput(input);
  const { report, errors, ctx, probe, foi } = await runGroups(sub, opts, input);
  const outputs = [];
  let outDir = opts.out ? path.resolve(opts.out) : null;
  if (sub === 'report') {
    outDir = outDir || defaultOutDir(input);
    const files = [];
    let sheet = null;
    if (!opts.noSheet && probe?.video) {
      try {
        const { contactSheet } = await import('./lib/sheet.mjs');
        sheet = await contactSheet({ input, probe, film: ctx.film, report, framesOfInterest: foi, timeoutMs: ctx.timeoutMs });
        files.push({ name: 'contact.jpg', data: sheet.jpeg, kind: 'qa-contact-sheet' });
        sheet.file = 'contact.jpg';
      } catch (e) { report.warnings.push(`联系表没出成：${e.message}`); sheet = null; }
    }
    report.contactSheet = sheet ? { file: 'contact.jpg', cells: sheet.cells } : null;
    const reportPath = rel(path.join(outDir, 'report.json'));
    report.technicalAcceptance = technicalAcceptanceFrom(report, reportPath);
    files.unshift({ name: 'report.json', data: JSON.stringify(report, null, 1) + '\n', kind: 'qa-report' }, { name: 'report.md', data: toMarkdown(report, { sheet }), kind: 'qa-markdown' });
    outputs.push(...await writeOut(outDir, files));
  } else if (outDir) {
    outputs.push(...await writeOut(outDir, [{ name: `${sub}.json`, data: JSON.stringify(report, null, 1) + '\n', kind: `qa-${sub}` }]));
  }
  if (!opts.json) printHuman(report);
  if (outputs.length && !opts.json) process.stdout.write(outputs.map(o => `  写出 ${o.path}`).join('\n') + '\n');
  const envErr = errors.find(e => e.error instanceof QaError && e.error.exitCode === EXIT.ENV);
  const tmo = errors.find(e => e.error instanceof QaError && e.error.exitCode === EXIT.TIMEOUT);
  const rt = errors.find(e => !(e.error instanceof QaError) || e.error.exitCode === EXIT.RUNTIME);
  const firstErr = envErr || tmo || rt;
  const code = envErr ? EXIT.ENV : tmo ? EXIT.TIMEOUT : rt ? EXIT.RUNTIME : report.ok ? EXIT.OK : EXIT.GATE;
  const runDir = input ? runDirOf(input) : null;
  const runJson = runDir && fs.existsSync(path.join(runDir, 'run.json')) ? rel(path.join(runDir, 'run.json')) : null;
  const gateErr = code === EXIT.GATE ? new QaError('qa.gate', `硬门不通过：${report.summary.hardFailures.join('、')}`, { hint: '先修「必须先修的问题」，再重跑同一条命令' }) : null;
  return { code, command, ok: code === EXIT.OK, result: report, outputs, runJson, warnings: report.warnings, error: firstErr ? Object.assign(firstErr.error, { message: `${firstErr.group}：${firstErr.error.message}` }) : gateErr, json: opts.json };
}

installSignalHandlers();
const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
let res;
try {
  res = await main(argv);
} catch (e) {
  const qe = e instanceof QaError ? e : new QaError('internal', `内部错误：${e.message}`, { hint: '这是 QA 工具本身的问题，请带上下面的堆栈报告给维护者', exitCode: EXIT.RUNTIME });
  if (!(e instanceof QaError)) process.stderr.write(`${e.stack}\n`);
  if (!wantJson) process.stderr.write(`错误：${qe.message}${qe.hint ? `\n下一步：${qe.hint}` : ''}\n`);
  res = { code: qe.exitCode, command: `qa ${argv[0] || ''}`.trim(), ok: false, error: qe, json: wantJson };
}
await runCleanups();
if (res.json || (wantJson && !res.silent)) {
  process.stdout.write(JSON.stringify(envelope({ ok: res.ok, exitCode: res.code, command: res.command, error: res.error, outputs: res.outputs, runJson: res.runJson, warnings: res.warnings, result: res.result })) + '\n');
} else if (res.error && res.code === EXIT.GATE && !res.silent) {
  process.stderr.write(`${res.error.message}${res.error.hint ? `\n下一步：${res.error.hint}` : ''}\n`);
}
process.exitCode = res.code;
