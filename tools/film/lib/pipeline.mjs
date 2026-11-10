// 北冥仓库 · 出片编排 · 步骤执行器：按顺序跑具名步骤，支持 --from / --to、输入哈希命中缓存时跳过、逐步计时与日志。
// 步骤定义（页面型路线的在 engine/render/build.mjs，B 原生的在 tools/film/lib/native-steps.mjs，三条路线共用的交付步骤在 tools/film/lib/deliver.mjs）：
//   { id, title, when?(ctx) → bool | 不跑的原因字符串, key?(ctx) → 输入哈希, outputs?(ctx) → { 产物名: 运行目录相对路径 },
//     run(ctx) → meta?, restored?(ctx, meta), cacheHit?(ctx, key) → { runId } | null, cacheStore?(ctx, key) }
//   key 给出时：命中缓存 → 硬链接产物回本次运行目录、跳过 run；未命中 → run 之后把 outputs 存进缓存（meta 一并存）
//   ctx.art[产物名] = 绝对路径（run 或缓存恢复之后自动填）；ctx.meta[步骤] = run 返回值或缓存里的 meta
// --from X：X 及之后强制重跑；X 之前带输入哈希的步骤必须能从缓存恢复（否则用法错误，说明哪一步缺缓存），
//           不带输入哈希的轻步骤（页面探测、原生预检、取帧、联系表）照常重跑
// --to X：跑完 X 就停（不更新 latest 指针）
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from './exit.mjs';
import * as cache from './cache.mjs';

export function stepIds(steps) { return steps.map(s => s.id); }

export function checkStepName(steps, name, flag) {
  if (name && !steps.some(s => s.id === name)) {
    throw new FilmError(EXIT.USAGE, 'step-unknown', `${flag} ${name}：这条出片链没有这一步`, `可用步骤（按顺序）：${stepIds(steps).join(' → ')}`);
  }
}

export async function runSteps(ctx, steps, { from = null, to = null, noCache = false } = {}) {
  checkStepName(steps, from, '--from');
  checkStepName(steps, to, '--to');
  const ids = stepIds(steps);
  const iFrom = from ? ids.indexOf(from) : 0, iTo = to ? ids.indexOf(to) : ids.length - 1;
  if (iTo < iFrom) throw new FilmError(EXIT.USAGE, 'step-order', `--to ${to} 在 --from ${from} 之前`, `步骤顺序：${ids.join(' → ')}`);
  for (let i = 0; i <= iTo; i++) {
    const s = steps[i];
    const rec = { id: s.id, title: s.title, status: 'pending', seconds: 0 };
    ctx.steps.push(rec);
    const why = s.when ? s.when(ctx) : true;
    if (why !== true) { rec.status = 'skipped'; rec.reason = typeof why === 'string' ? why : '不适用'; ctx.log(`· ${s.title}：跳过（${rec.reason}）`); continue; }
    const forced = noCache || i >= iFrom && !!from;
    const t0 = Date.now();
    ctx.currentStep = s.id;
    let key = null;
    if (s.key) key = await s.key(ctx);
    if (key && !forced) {
      // 自带缓存判定的步骤（产物不在运行目录里，例如 B 的 media/）用 cacheHit；其余走通用的运行目录产物缓存
      const hit = s.cacheHit ? s.cacheHit(ctx, key) : cache.lookup(ctx.outRoot, s.id, key);
      if (hit) {
        const meta = s.cacheHit ? (hit.meta || {}) : cache.restore(hit, ctx.run.dir);
        fillArt(ctx, s);
        ctx.meta[s.id] = meta;
        if (s.restored) await s.restored(ctx, meta);
        rec.status = 'cached'; rec.key = key; rec.from = hit.runId || null; rec.seconds = +((Date.now() - t0) / 1000).toFixed(2);
        ctx.log(`· ${s.title}：输入没变，复用 ${hit.runId || '上次'} 的结果`);
        continue;
      }
    }
    // --from 之前、带输入哈希的步骤必须能复用；没有输入哈希的（探测、预检这类轻步骤）照常重跑
    if (i < iFrom && key) {
      throw new FilmError(EXIT.USAGE, 'from-needs-cache', `--from ${from} 要求前面的「${s.title}」（${s.id}）能复用缓存，但它的输入变了或缓存已清`, `去掉 --from 整条重跑：node tools/film/cli.mjs build ${ctx.film.relDir}`);
    }
    ctx.log(`▶ ${s.title}`);
    rec.status = 'running';
    try {
      const meta = await s.run(ctx);
      ctx.meta[s.id] = meta || {};
      fillArt(ctx, s);
      rec.status = 'done';
      if (key && s.cacheStore) { s.cacheStore(ctx, key); rec.key = key; }
      else if (key && s.outputs) {
        const files = Object.values(s.outputs(ctx)).flat().filter(r => fs.existsSync(path.join(ctx.run.dir, r)));
        cache.store(ctx.outRoot, s.id, key, ctx.run.dir, files, meta || {}, ctx.run.id);
        rec.key = key;
      }
    } catch (e) {
      rec.status = 'failed';
      rec.error = e?.message ? String(e.message).split('\n')[0].slice(0, 500) : String(e);
      throw e;
    } finally {
      rec.seconds = +((Date.now() - t0) / 1000).toFixed(2);
      ctx.timing[s.id] = rec.seconds;
    }
  }
  ctx.currentStep = null;
  return { complete: iTo === ids.length - 1 };
}

function fillArt(ctx, s) {
  if (!s.outputs) return;
  for (const [k, r] of Object.entries(s.outputs(ctx))) {
    const list = Array.isArray(r) ? r : [r];
    const absList = list.map(x => path.join(ctx.run.dir, x)).filter(p => fs.existsSync(p));
    if (absList.length) ctx.art[k] = Array.isArray(r) ? absList : absList[0];
  }
}
