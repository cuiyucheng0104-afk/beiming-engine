// 过程观测：从会话记录、运行目录和作品目录里取出计分要用的客观事实（不打分，打分在 score.mjs）。
//
//   entry        入口效率：第一条可执行命令之前读了几份 .md、多少行（北极星验收 #1、过程分「入口效率」）
//   firstStill   开跑到作品目录里出现第一张图片的秒数
//   renders      出过片的运行目录数（终渲次数）与出片类命令次数
//   errors       失败的工具调用；bypass 绕过检查的参数；background 后台命令
//   injections   发给代理的消息：脚本回复用了哪些、兜底几次、人工几次（人工干预 = 兜底 + 人工）
//   claims       「已交付 / 已认可」类字样；notes 作品说明里的已知问题与豁免
//   credits      film.json 的 credits 与 aigc；deliverables C4 规定的六件交付物
//   beats        film.json 里同时带声音与画面的事件数；usage 用量、轮次、墙钟
// 接口：observe(ctx, { delivery }) → 对象（写进 gates.json 的 observations）

import fs from 'node:fs';
import path from 'node:path';
import { scanFilmDir, scanText } from './claims.mjs';
import { readJsonIfExists, walk } from './files.mjs';
import { filmRenderRuns } from './rundir.mjs';

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const BYPASS = [/--no-verify\b/, /--skip-(qa|checks?|gates?)\b/, /--no-qa\b/, /--force\b/, /--gpu[= ]software-ok\b/, /\bBNE_ALLOW_VERSION=/, /--allow-network\b/];
const RENDER_CMD = /(\bfilm(\/cli\.mjs)?\b[^\n]*\b(build|render)\b|engine\/render\/(video|build|native|still)\.mjs|\bnpm run (film|build|video|stills|c:build|native:render|b:render)\b)/;
const NOT_A_RENDER = /(--help|-h\b|--dry-run|--check-only|--plan\b)/;

const lineCount = file => { try { return fs.readFileSync(file, 'utf8').split('\n').length; } catch { return null; } };

function entryEfficiency(ctx) {
  const main = ctx.actions.filter(a => a.actor === 'main');
  const firstExec = main.find(a => a.kind === 'bash' && a.bash?.executable);
  const limit = firstExec ? firstExec.seq : Infinity;
  const docs = new Map();
  for (const a of main) {
    if (a.seq >= limit) break;
    for (const p of a.paths) {
      if (p.rel === null || !/\.md$/i.test(p.rel)) continue;
      if (a.kind === 'read' && a.tool === 'Read') {
        const lines = a.readLines ?? lineCount(p.abs);
        docs.set(p.rel, Math.max(docs.get(p.rel) ?? 0, lines ?? 0));
      } else if (a.kind === 'bash' && p.write === false) {
        const total = lineCount(p.abs);
        const lines = p.lines !== null && p.lines !== undefined ? Math.min(p.lines, total ?? p.lines) : total;
        docs.set(p.rel, Math.max(docs.get(p.rel) ?? 0, lines ?? 0));
      }
    }
  }
  const docCount = docs.size;
  const lineTotal = [...docs.values()].reduce((s, n) => s + n, 0);
  return {
    firstExecutable: firstExec ? { seq: firstExec.seq, turn: firstExec.turn, command: firstExec.raw.slice(0, 200) } : null,
    docs: [...docs].map(([p, lines]) => ({ path: p, lines })),
    docCount,
    lineCount: lineTotal,
    budget: { docs: 3, lines: 300 },
    withinBudget: Boolean(firstExec) && docCount <= 3 && lineTotal <= 300,
  };
}

function runStart(ctx) {
  const t = Date.parse(ctx.run.drive?.startedAt ?? ctx.run.meta.startedAt ?? ctx.run.meta.createdAt ?? '');
  return Number.isFinite(t) ? t : null;
}

function firstStill(ctx) {
  if (!ctx.film.dir || !fs.existsSync(ctx.film.dir)) return null;
  const images = walk(ctx.film.dir, { skipDirs: new Set(['node_modules', 'cache']) }).filter(e => IMAGE_EXT.test(e.rel));
  if (!images.length) return { seconds: null, file: null, images: 0 };
  const first = images.reduce((a, b) => (a.mtimeMs <= b.mtimeMs ? a : b));
  const start = runStart(ctx);
  return { seconds: start === null ? null : Math.max(0, Math.round((first.mtimeMs - start) / 1000)), file: first.rel, images: images.length };
}

function injectionSummary(ctx) {
  const inj = ctx.run.injections;
  const byKind = {};
  for (const i of inj) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  const sent = new Set(inj.filter(i => i.kind === 'scripted').map(i => i.replyId));
  const required = (ctx.run.replies?.replies ?? []).filter(r => !r.optional);
  return {
    byKind,
    scriptedSent: [...sent],
    scriptedMissing: required.filter(r => !sent.has(r.id)).map(r => r.id),
    interventions: (byKind.fallback ?? 0) + (byKind.manual ?? 0),
    order: inj.filter(i => i.kind === 'scripted').map(i => ({ id: i.replyId, gate: i.gate, turn: i.turn, at: i.at })),
  };
}

function reviewNotes(ctx) {
  if (!ctx.film.dir) return null;
  const candidates = ['review.md', 'REVIEW.md', 'review/review.md', 'NOTES.md', 'delivery/README.md'].map(n => path.join(ctx.film.dir, n));
  const file = candidates.find(f => fs.existsSync(f));
  if (!file) return { file: null, hasKnownIssues: false, mentionsWaiver: false };
  const text = fs.readFileSync(file, 'utf8');
  return { file: path.relative(ctx.film.dir, file).split(path.sep).join('/'), hasKnownIssues: /已知问题|known issues/i.test(text), mentionsWaiver: /豁免|waive/i.test(text) };
}

function credits(ctx) {
  const film = ctx.film.dir ? readJsonIfExists(path.join(ctx.film.dir, 'film.json')) : null;
  if (!film) return null;
  const list = Array.isArray(film.credits) ? film.credits : [];
  const text = JSON.stringify(list);
  return {
    count: list.length,
    complete: list.filter(c => c && c.what && c.license && (c.source || c.owner)).length,
    hasFontLicense: /OFL/i.test(text),
    hasStyleSourceAtCommit: /@[0-9a-f]{7,40}\b/i.test(text),
    hasMit: /\bMIT\b/.test(text),
    hasRuntimeLicense: /FSL|ALv2|Apache/i.test(text),
    aigc: film.aigc ?? null,
  };
}

function deliverables(ctx, delivery) {
  const dir = delivery?.runDir;
  const names = ['master.mp4', 'web.mp4', 'player.html', 'run.json', 'qa/report.json', 'contact.jpg'];
  const present = Object.fromEntries(names.map(n => [n, Boolean(dir && fs.existsSync(path.join(dir, n)))]));
  return { runDir: dir ? path.relative(ctx.run.worktree, dir).split(path.sep).join('/') : null, present, count: Object.values(present).filter(Boolean).length, of: names.length };
}

function beats(ctx) {
  const film = ctx.film.dir ? readJsonIfExists(path.join(ctx.film.dir, 'film.json')) : null;
  if (!film || !Array.isArray(film.events)) return null;
  const synced = film.events.filter(e => e && e.audio && e.visual);
  return { events: film.events.length, audioVisual: synced.length, onBeat: film.events.filter(e => e && (e.beat !== undefined || e.onBeat === true)).length };
}

function usage(ctx) {
  const sum = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, apiTurns: 0 };
  for (const r of ctx.t.results) {
    const u = r.usage ?? {};
    sum.inputTokens += u.input_tokens ?? 0;
    sum.outputTokens += u.output_tokens ?? 0;
    sum.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    sum.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    sum.costUsd += r.costUsd ?? 0;
    sum.apiTurns += r.numTurns ?? 0;
  }
  sum.costUsd = Math.round(sum.costUsd * 10000) / 10000;
  const d = ctx.run.drive;
  return { ...sum, totalTokens: sum.inputTokens + sum.outputTokens + sum.cacheCreationTokens + sum.cacheReadTokens, sessionTurns: d?.turns?.length ?? ctx.t.results.length, wallClockSeconds: d?.agentSeconds ?? null, stopReason: d?.stopReason ?? null };
}

export function observe(ctx, { delivery }) {
  const bash = ctx.actions.filter(a => a.kind === 'bash');
  const renderCommands = bash.filter(a => RENDER_CMD.test(a.raw) && !NOT_A_RENDER.test(a.raw));
  const errors = {};
  for (const a of ctx.actions.filter(x => x.isError)) errors[a.tool] = (errors[a.tool] ?? 0) + 1;
  const claimHits = [...(ctx.film.dir ? scanFilmDir(ctx.film.dir).map(h => ({ where: h.rel, line: h.line, kind: h.kind, context: h.context })) : []),
    ...scanText(ctx.t.finalText).map(h => ({ where: '最后一条回复', line: h.line, kind: h.kind, context: h.context }))];
  return {
    entry: entryEfficiency(ctx),
    firstStill: firstStill(ctx),
    renders: { runDirs: filmRenderRuns(ctx.film.dir).length, commands: renderCommands.length, backgroundRenders: renderCommands.filter(a => a.background).length },
    errors: { total: Object.values(errors).reduce((s, n) => s + n, 0), byTool: errors },
    bypass: bash.filter(a => BYPASS.some(re => re.test(a.raw))).map(a => ({ seq: a.seq, command: a.raw.slice(0, 200) })),
    background: bash.filter(a => a.background).length,
    injections: injectionSummary(ctx),
    claims: { claims: claimHits.filter(h => h.kind === 'claim').length, hits: claimHits.slice(0, 20) },
    notes: reviewNotes(ctx),
    credits: credits(ctx),
    deliverables: deliverables(ctx, delivery),
    beats: beats(ctx),
    subagents: ctx.t.toolUses.filter(u => (u.tool === 'Task' || u.tool === 'Agent') && u.actor === 'main').length,
    usage: usage(ctx),
  };
}
