// 重动词：渲染、核验、交付三类作业的执行器，加上观测（空间查询、联系表与切点条带、成片量测）和审片。
// 作业经 jobs 的队列和调度器跑：执行器从这个修订的快照读 film.json、film.lock 和镜头文件，产物写进工作区 deliver/<作业号>/。
// 作业的结论写成 deliver/<作业号>/outcome.json（队列自己只留一句失败原因，错误码留不住），服务端照它拼信封。
// 渲出来的帧按档位并进一份索引 deliver/frames-<档位>.json（只留当前修订的），观测和核验都读它。
// 镜头帧缓存在 deliver/.shot-cache（不进修订快照，跨修订、跨作业复用）：没改的镜头再渲、再交付时不调帧源（交付的 L2 纯函数门也照缓存里的记录用）。
// 帧源池数着每个镜头的 render 被调了几次，记在结论和账本行的 sourceRenders。
// 计时只用单调时钟量耗时（记成本用），不进任何产物的内容。
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadQueue, openShotCache } from '../jobs/index.mjs';
import { audioLoudness, blackFreezeDup, buildContactSheet, buildCutStrips, cutScene, cutYdif, deliverSpec, query } from '../observe/index.mjs';
import { artifactUrl } from './client.mjs';
import { ROUTES } from './contract.mjs';
import { ApiError, diagnostic, isRegistered } from './envelope.mjs';
import {
  deliverBundle, entitiesOf, frameSummary, layerL1, layerL2, layerL3, layerL5, measureMaster, readIndex, renderPlan, reviewMaterials,
  sourcePool, writeIndex, writeVerification,
} from './pipeline.mjs';
import { blenderInfo, ensureLut, monotonicMs } from './runtime.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'stopped']);
const METRICS = { deliverSpec, audioLoudness, blackFreezeDup, cutYdif, cutScene };
// 切点条带要的邻帧：切点前 3 帧到切点后 2 帧（observe 的 STRIP_OFFSETS）
const CUT_BEFORE = 3, CUT_AFTER = 2;
// 一张联系表的格宽（像素）
const SHEET_CELL = 160;

const jsonText = (v) => `${JSON.stringify(v, null, 2)}\n`;
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const span = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

const bad = (message, extra) => new ApiError('usage.bad-argument', message, extra);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v ?? null);

/** 剥除错误消息里的文件系统路径（含带空格目录）、URL 与令牌，保留可诊断的业务失败原因。 */
export function sanitizeErrorText(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.split(/\r?\n\s+at\s+/)[0].replace(/\s+/g, ' ').trim();
  if (!text) return '';
  for (const envKey of ['FFMPEG', 'FFPROBE', 'BEIMING_BLENDER', 'BEIMING_CHROME']) {
    const val = process.env[envKey];
    if (val && val.length > 2) text = text.split(val).join('[路径]');
  }
  text = text
    .replace(/(?:https?|file|wss?|ftp):\/\/[^\s"'`，。；）)<>]+/gi, '[地址]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [已脱敏]')
    .replace(/\bbm[aw]_[0-9a-f]{16,}\b/gi, '[令牌]')
    .replace(/\b(?:sk|pk|rk|key|tok|token)[-_][A-Za-z0-9._-]{8,}\b/gi, '[令牌]')
    .replace(/\b[0-9a-f]{24,}\b/gi, '[摘要]')
    .replace(/[A-Za-z]:\\(?:[^\s"'`，。；）):\\]+(?: [\w.-]+)*\\)*[^\s"'`，。；）):\\]*/g, '[路径]')
    .replace(/(?<=^|[\s：:(（'"`])\/(?!v1\/)(?:[^/\s"'`，。；）):]+(?: [\w.-]+)*\/)+[^/\s"'`，。；）):]*(?: [\w.-]+)*/g, '[路径]')
    .replace(/(?<=^|[\s：:(（'"`])(?:\.\.?\/|beiming\/)[^\s"'`，。；）):]+/g, '[路径]');
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** 草稿档默认抽哪些帧：每个镜头的首、中、尾帧，加上落在镜头里的切点邻帧（够出切点条带） */
export function samplePlan(film, shots) {
  const cuts = (film.transitions ?? []).map((t) => t.at);
  return shots.map((shot) => {
    const set = new Set([shot.in, Math.floor((shot.in + shot.out - 1) / 2), shot.out - 1]);
    for (const c of cuts) for (let f = c - CUT_BEFORE; f <= c + CUT_AFTER; f++) if (f >= shot.in && f < shot.out) set.add(f);
    return { shot: shot.id, frames: [...set].sort((a, b) => a - b) };
  });
}

/** 一次渲染要出哪些帧：[{ shot: 镜头 id, frames: [全片帧号] }]。点了帧就按帧分到镜头；没点时草稿档抽样、终渲档全出 */
export function planOf(film, { shots, frames, tier }) {
  const wanted = shots?.length
    ? [...new Set(shots)].map((id) => film.shots.find((s) => s.id === id) ?? (() => { throw bad(`镜头 ${id} 不在片子里`, { hint: `片子里的镜头：${film.shots.map((s) => s.id).join('、')}` }); })())
    : film.shots;
  if (frames?.length) {
    const want = [...new Set(frames)].sort((a, b) => a - b);
    const plan = wanted.map((shot) => ({ shot: shot.id, frames: want.filter((f) => f >= shot.in && f < shot.out) })).filter((p) => p.frames.length);
    const covered = new Set(plan.flatMap((p) => p.frames));
    const lost = want.filter((f) => !covered.has(f));
    if (lost.length) throw bad(`帧 ${lost.join('、')} 不在要渲的镜头里`, { hint: `frames 是全片帧号，0 到 ${film.output.frames - 1}` });
    return plan;
  }
  return tier === 'final' ? wanted.map((shot) => ({ shot: shot.id, frames: span(shot.in, shot.out) })) : samplePlan(film, wanted);
}

/**
 * 建这台服务器的重动词。store 是数据目录，library 是卡库，reviewer 是审片适配器（可以是 null），scheduler 不给就用 jobs 的默认调度器。
 * 交回 { submit, view, wait, cancel, cancelAll, observeQuery, observeSheet, observeMetrics, review }。
 */
export function createWork({ store, library, reviewer, scheduler }) {
  const queues = new Map();
  const running = new Map();
  const progress = new Map();
  const waiters = new Set();
  // 产物引用每次从合同里 artifacts 那一行的路径模板推出：改合同路径，签发的引用跟着变。
  const url = (id, rel) => artifactUrl(ROUTES, id, rel);
  const deliverDir = (id) => join(store.filmDir(id), 'deliver');
  const jobDir = (id, jobId) => join(deliverDir(id), jobId);
  const output = (id, kind, rel) => ({ kind, url: url(id, rel), sha256: sha256File(join(deliverDir(id), rel)) });
  const shotCache = (id) => openShotCache(join(deliverDir(id), '.shot-cache'));

  /* ---------------- 帧的索引 ---------------- */

  const indexFile = (id, tier) => join(deliverDir(id), `frames-${tier}.json`);

  /** 读一档的帧：{ rev, tier, records }；没渲过是 null */
  function framesOf(id, tier) {
    const file = indexFile(id, tier);
    return existsSync(file) ? readIndex(file, store.filmDir(id)) : null;
  }

  /** 新渲的帧并进索引：同一个修订的旧帧留着（同帧号的换成新的），换了修订就整份换掉 */
  function mergeFrames(id, tier, rev, records) {
    const prior = framesOf(id, tier);
    const keep = prior?.rev === rev ? prior.records.filter((r) => !records.some((n) => n.frame === r.frame)) : [];
    writeIndex(indexFile(id, tier), store.filmDir(id), [...keep, ...records].sort((a, b) => a.frame - b.frame), { rev, tier });
  }

  /** 观测读哪一档：点了就那一档；没点取修订号新的那一档，一样新取终渲 */
  function pickFrames(id, tier) {
    const found = (tier ? [tier] : ['final', 'draft']).map((t) => framesOf(id, t)).filter(Boolean).sort((a, b) => b.rev - a.rev);
    if (!found.length) throw bad(tier ? `${tier} 档还没有渲过帧` : '还没有渲过帧', { hint: '先 POST render（draft 档默认抽每个镜头的首中尾帧和切点邻帧）', next: [{ verb: `POST /v1/films/${id}/render`, why: '先渲帧' }] });
    return found[0];
  }

  /** 这部片交付过的成片：{ job, rev, dir, master }；没交付过是 null */
  function delivered(id) {
    const last = store.readMeta(id).lastDeliver;
    if (!last) return null;
    const dir = join(store.filmDir(id), last.dir);
    return existsSync(join(dir, 'master.mp4')) ? { ...last, dir, master: join(dir, 'master.mp4') } : null;
  }

  /* ---------------- 作业 ---------------- */

  function queue(id) {
    if (!queues.has(id)) queues.set(id, loadQueue(store.filmDir(id), { handlers, ...(scheduler ? { scheduler } : {}) }));
    return queues.get(id);
  }

  /**
   * 执行器的共同外壳：读快照里的片子和锁，起帧源池，跑完写 outcome.json 和账本。
   * run 交回结论 { ok, data, outputs, diagnostics, next, code?, message?, hint? }；ok 是 false 表示作业跑完了但闸门没过。
   * run 抛异常是作业失败：只记公开错误码和阶段。取消也保存累计成本和账本。
   */
  const handler = (name, run) => async (cx) => {
    const { job, signal, snapshot } = cx;
    const { film: id, rev } = job.payload;
    const dir = jobDir(id, job.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // frames 只数真调了帧源的帧，cachedFrames 数缓存命中的帧
    const acc = { gpuSeconds: 0, frames: 0, cachedFrames: 0, tokens: 0, start: monotonicMs() };
    progress.set(job.id, acc);
    const pool = sourcePool({ library, workspace: snapshot.dir, blenderBin: blenderInfo()?.bin });
    let outcome, crash;
    try {
      const film = JSON.parse(readFileSync(join(snapshot.dir, 'film.json'), 'utf8'));
      const lockFile = join(snapshot.dir, 'film.lock');
      if (!existsSync(lockFile)) throw new ApiError('env.lock-required', `修订 ${rev} 没有 film.lock`);
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      const lut = await ensureLut(store.dataDir);
      if (lut?.fallback && film.shots.some(shot => (shot.colorRef ?? 'scene') === 'scene')) {
        throw new ApiError('env.lock-required', '场景参考镜头需要 Blender 烘焙的正式 agx-mhc 查找表');
      }
      if (lut && lock.view?.['agx-mhc'] && lock.view['agx-mhc'] !== lut.sha256 && film.shots.some(shot => (shot.colorRef ?? 'scene') === 'scene')) {
        throw new ApiError('env.lock-required', '当前查找表与修订锁不一致，请重新提交片子签发正式锁');
      }
      // Blender 的脚本加载器可能写 __pycache__。让它读取本次作业的副本，保留修订快照的字节清单。
      let inputSnapshot = cx.snapshot;
      if (film.shots.some(shot => shot.source === 'blender')) {
        const input = join(cx.intermediateDir, 'input');
        cpSync(inputSnapshot.dir, input, { recursive: true });
        inputSnapshot = { ...inputSnapshot, dir: input };
      }
      const meta = store.readMeta(id);
      const examFile = join(snapshot.dir, 'exam.json');
      if (film.exam && existsSync(examFile)) {
        if (lock.assets[`asset:exam-${film.exam}@1`] !== `sha256:${sha256File(examFile)}`) throw new ApiError('env.lock-required', '考题材料与修订锁不一致');
        meta.question = JSON.parse(readFileSync(examFile, 'utf8'));
      }
      outcome = await run({ ...cx, snapshot: inputSnapshot, id, rev, dir, pool, acc, film, lock, lockFile, lutPath: lut?.path, meta });
    } catch (e) {
      crash = true;
      const known = isRegistered(e?.code);
      const code = known ? e.code : 'contract.bad-value';
      const toolMissing = code === 'env.ffmpeg-missing'
        ? '环境缺少可执行的 FFmpeg 或 ffprobe'
        : code === 'env.missing-tool'
          ? '环境缺少所需的外部渲染或烘焙工具'
          : '';
      const detail = toolMissing || sanitizeErrorText(e?.message);
      const message = e instanceof ApiError
        ? detail || e.message
        : detail
          ? `${name} 组件执行失败（${code}）：${detail}`
          : `${name} 组件执行失败（${known ? e.code : '组件异常'}）`;
      const hint = sanitizeErrorText(e?.hint)
        || (code === 'env.ffmpeg-missing' ? '请在服务端安装 FFmpeg 与 ffprobe 并配置可执行路径后重试' : '')
        || (code === 'env.missing-tool' ? '请在服务端安装对应的外部渲染工具（Blender 或无头浏览器）后重试' : '')
        || (code === 'contract.delivery-mismatch' && /母带不达标|响度|真峰值/.test(detail)
          ? '声轨响度/真峰值未达标：调整片长、音频事件，或设 audio/mode 为 none 后重试'
          : undefined);
      const next = Array.isArray(e?.next) ? e.next : code.startsWith('contract.') ? [{ verb: `PUT /v1/films/${id}/film`, why: '按失败原因调整片子或规格后重试' }] : [];
      outcome = {
        ok: false, crashed: true, code, message,
        ...(hint ? { hint } : {}),
        data: {},
        diagnostics: detail ? [diagnostic({ code, layer: name === 'deliver' ? 'L3' : 'L1', message: detail, ...(hint ? { hint } : {}) })] : [],
        next,
      };
    } finally {
      await pool.stop();
    }
    const wallMs = Math.round(monotonicMs() - acc.start);
    if (signal.aborted) outcome = { ok: true, data: { canceled: true } };
    outcome.cost = { tokens: acc.tokens, gpuSeconds: r3(acc.gpuSeconds), wallMs };
    outcome.frames = acc.frames;
    outcome.cachedFrames = acc.cachedFrames;
    outcome.sourceRenders = pool.renders;
    writeFileSync(join(dir, 'outcome.json'), jsonText(outcome));
    store.ledger(id, { step: `job.${name}`, job: job.id, rev, status: signal.aborted ? (signal.reason === 'preempted' ? 'stopped' : 'canceled') : crash ? 'failed' : 'succeeded', ok: !signal.aborted && outcome.ok, wallMs, gpuSeconds: r3(acc.gpuSeconds), tokens: 0, modelTokens: acc.tokens, frames: acc.frames, renderedFrames: acc.frames, cachedFrames: acc.cachedFrames, sourceRenders: pool.renders });
    progress.delete(job.id);
    if (crash && !signal.aborted) throw new Error(outcome.message);
    return { ok: outcome.ok };
  };

  const shotsOf = (film, plan) => plan.map((p) => ({ shot: film.shots.find((s) => s.id === p.shot), frames: p.frames }));

  /** 渲一批帧并进索引，记显卡秒和帧数。交回 { records, cache, versions }：cache 是这一批的缓存账 { renderedFrames, cachedFrames, shots }，versions 给 layerL2 */
  async function renderInto(cx, tier, plan, sub) {
    const { film, lock, snapshot, dir, pool, signal, lutPath, acc, id, rev } = cx;
    const { records, gpuSeconds, versions, ...cache } = await renderPlan({ film, lock, filmDir: snapshot.dir, tier, plan: shotsOf(film, plan), outDir: join(dir, sub), pool, signal, lutPath,
      cache: shotCache(id),
      onFrame(seconds) { acc.gpuSeconds += seconds; acc.frames++; },
    });
    acc.cachedFrames += cache.cachedFrames;
    mergeFrames(id, tier, rev, records);
    return { records, cache, versions };
  }

  const gatesOf = (l1, l2, l3) => ({
    L1: { ok: l1.ok, errors: l1.diagnostics.filter((d) => d.severity === 'error').length },
    ...(l2 ? { L2: { ok: l2.ok, gates: l2.gates, bbox: l2.bbox } } : {}),
    ...(l3 ? { L3: { ok: l3.ok, basePass: l3.basePass, summary: l3.summary } } : {}),
  });
  // 判不过的排前面，带修法的再靠前
  const ordered = (diags) => [...diags].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error') || Number(Boolean(b.fix)) - Number(Boolean(a.fix)));
  const briefVerdict = (v) => ({ id: v.id, status: v.status, base: v.base, ...(v.status === 'fail' && v.atFrames ? { atFrames: v.atFrames } : {}),
    ...(v.status === 'fail' && v.expected ? { expected: v.expected } : {}), ...(v.status === 'skipped' && v.reason ? { reason: v.reason } : {}) });

  const handlers = {
    render: handler('render', async (cx) => {
      const { job, step, film, id, rev } = cx;
      const { tier, plan } = job.payload;
      const { records, cache } = await step('render', () => renderInto(cx, tier, plan, 'frames'));
      const expected = plan.reduce((n, p) => n + p.frames.length, 0);
      const items = records.map((r) => frameSummary(r, film.shots.find((s) => s.id === r.shot)));
      return {
        ok: true,
        data: { rev, tier, expectedCount: expected, actualCount: items.length, ...cache, items, png: `${job.id}/frames/<镜头>/png/f<四位帧号>.png` },
        outputs: [{ kind: 'frames-index', url: url(id, `frames-${tier}.json`) }],
        next: [{ verb: `POST /v1/films/${id}/observe/query`, why: '问主角在画面里的位置和留白' }, { verb: `POST /v1/films/${id}/verify`, why: '跑 L1–L3' }],
      };
    }),

    verify: handler('verify', async (cx) => {
      const { job, step, film, lock, snapshot, pool, signal, id, rev, meta, intermediateDir, acc } = cx;
      const { tier, shots } = job.payload;
      const l1 = await step('l1', () => layerL1(film, snapshot.dir, rev, meta.question));
      if (!l1.ok) {
        return { ok: false, code: 'contract.bad-value', message: 'L1 没过：片子描述有错，L2、L3 没有跑', data: { rev, tier, layers: gatesOf(l1) }, diagnostics: ordered(l1.diagnostics),
          next: [{ verb: `PUT /v1/films/${id}/film`, why: '照诊断改片子' }] };
      }
      // L3 的空间谓词要每个镜头都有抽样帧：当前修订没渲过的镜头在这里补渲
      const have = framesOf(id, tier);
      const sampled = new Set(have?.rev === rev ? have.records.map((r) => r.shot) : []);
      const missing = film.shots.filter((s) => !sampled.has(s.id));
      if (missing.length) await step('sample', () => renderInto(cx, tier, samplePlan(film, missing), 'frames'));
      const records = framesOf(id, tier).records;
      const gateShots = film.shots.filter((s) => !shots?.length || shots.includes(s.id));
      const l2 = await step('l2', async () => {
        const res = await layerL2({ film, lock, filmDir: snapshot.dir, shots: gateShots, records, pool, scratch: join(intermediateDir, 'l2'), signal, onGpu(seconds) { acc.gpuSeconds += seconds; } });
        return res;
      });
      const done = delivered(id);
      const master = done?.rev === rev ? done.master : null;
      const l3 = await step('l3', async () => layerL3({
        film, question: meta.question, entities: entitiesOf(records),
        measured: { frames: records.map((r) => ({ frame: r.frame, meta: r.meta })), ...(master ? await measureMaster(master) : {}) },
      }));
      const pass = l2.ok && l3.ok;
      const failed = l3.verdicts.filter((v) => v.status === 'fail').map((v) => v.id);
      const data = {
        rev, tier, layers: gatesOf(l1, l2, l3), failed, sampledFrames: records.length, master: Boolean(master),
        ...(master ? {} : { note: '成片量测类的谓词（delivery、loudness、cut_at）要交付之后才判：deliver 会自动再跑一遍' }),
        verdicts: l3.verdicts.map(briefVerdict),
      };
      const diagnostics = ordered([...l1.diagnostics, ...l2.diagnostics, ...l3.diagnostics]);
      if (!pass) {
        return { ok: false, code: 'contract.bad-value', message: `核验没过：${[!l2.ok && 'L2', !l3.ok && 'L3'].filter(Boolean).join('、')}`, data, diagnostics,
          next: [{ verb: `PUT /v1/films/${id}/film`, why: '照诊断和修法改，再渲再验' }] };
      }
      return { ok: true, data, diagnostics, next: [{ verb: `POST /v1/films/${id}/observe/sheet`, why: '看联系表和切点条带' }, { verb: `POST /v1/films/${id}/deliver`, why: '终渲出六件套' }] };
    }),

    deliver: handler('deliver', async (cx) => {
      const { job, step, film, lock, lockFile, snapshot, pool, signal, id, rev, dir, lutPath, meta, intermediateDir, acc } = cx;
      const plan = film.shots.map((s) => ({ shot: s.id, frames: span(s.in, s.out) }));
      const { records, cache, versions } = await step('render', () => renderInto(cx, 'final', plan, 'frames'));
      const bundle = await step('comp', () => deliverBundle({ film, lock: lockFile, records, lutPath, outDir: join(dir, 'bundle') }));
      const master = join(bundle.dir, 'master.mp4');
      const l1 = layerL1(film, snapshot.dir, rev, meta.question);
      // 这一轮全部命中、这一版又过过门的镜头照缓存里的记录用，不起帧源；单独的核验作业（上面的 verify）每次真跑
      const l2 = await step('l2', async () => {
        const res = await layerL2({ film, lock, filmDir: snapshot.dir, shots: film.shots, records, pool, scratch: join(intermediateDir, 'l2'), signal, onGpu(seconds) { acc.gpuSeconds += seconds; },
          cache: shotCache(id), versions });
        return res;
      });
      const l3 = await step('l3', async () => layerL3({
        film, question: meta.question, entities: entitiesOf(records),
        measured: { frames: records.map((r) => ({ frame: r.frame, meta: r.meta })), ...(await measureMaster(master)) },
      }));
      const l4 = await step('l4', () => ({ status: 'not-run', reason: '未提供可量测的 ref-pack', compChecks: { pointer: '#/checks', count: bundle.report.checks.length, ok: bundle.report.ok } }));
      const l5 = await step('l5', async () => {
        const images = reviewer ? reviewMaterials({ master, fps: film.output.fps, film, outDir: join(dir, 'review') }) : [];
        return layerL5({ reviewer, brief: meta.brief ?? meta.question?.brief ?? '', images, loudness: bundle.report.loudness ?? null, film });
      });
      acc.tokens += l5.usage?.totalTokens ?? 0;
      const pass = l1.ok && l2.ok && l3.ok;
      const diagnostics = ordered([...l1.diagnostics, ...l2.diagnostics, ...l3.diagnostics]);
      const verified = await step('report', () => writeVerification(bundle.dir, {
        format: 'api-verification/0.1', rev, tier: 'final', ok: pass, layers: { ...gatesOf(l1, l2, l3), L4: l4, L5: l5 }, verdicts: l3.verdicts, L5: l5, diagnostics,
      }));
      const names = Object.keys(verified.files);
      const kinds = { 'master.mp4': 'master', 'web.mp4': 'web', 'contact.png': 'contact', 'report.json': 'report', 'run.json': 'run', 'film.lock': 'lock' };
      if (names.length !== 6 || Object.keys(kinds).some(n => !Object.hasOwn(verified.files, n))) {
        throw new ApiError('contract.delivery-mismatch', '交付产物没有齐备六件');
      }
      store.updateMeta(id, (m) => { m.lastDeliver = { job: job.id, rev, dir: `deliver/${job.id}/bundle`, ok: pass }; });
      // 保留策略：终稿每个镜头只留最近用过的一版，放了七天的条目清掉；清不动不影响已经出齐的六件套
      try { shotCache(id).prune(); } catch { /* 下一次交付再清 */ }
      // 收获钩子：基础谓词全过才触发；M1a 的收获不出候选，只在账本和记录里留一笔
      let harvest = { triggered: false, reason: '基础谓词没有全过' };
      if (pass && l3.basePass) {
        harvest = { triggered: true, candidates: 0 };
        store.updateMeta(id, (m) => { m.harvest = { job: job.id, rev, candidates: [] }; });
        store.ledger(id, { step: 'harvest-hook', job: job.id, rev, ok: true, wallMs: 0, gpuSeconds: 0, tokens: 0, modelTokens: 0, frames: 0 });
      }
      const data = {
        rev, expectedCount: 6, actualCount: names.length, items: names, deliveredFrames: records.length, ...cache, layers: gatesOf(l1, l2, l3),
        failed: l3.verdicts.filter((v) => v.status === 'fail').map((v) => v.id), review: { status: l5.status, ...(l5.reason ? { reason: l5.reason } : {}) }, harvest,
      };
      const outputs = names.map((n) => ({ kind: kinds[n] ?? 'file', url: url(id, `${job.id}/bundle/${n}`), sha256: verified.files[n].sha256 }));
      if (!pass) {
        return { ok: false, code: 'contract.bad-value', message: `六件套出了，但硬门没过：${[!l2.ok && 'L2', !l3.ok && 'L3'].filter(Boolean).join('、')}（详见 report.json 的 verification）`, data, outputs, diagnostics,
          next: [{ verb: `PUT /v1/films/${id}/film`, why: '照诊断改，再交付' }] };
      }
      return { ok: true, data, outputs, diagnostics, next: [{ verb: `POST /v1/films/${id}/review`, why: 'L5 审片意见（只是意见）' }, { verb: `GET /v1/films/${id}/ledger`, why: '看这部片花了多少' }] };
    }),
  };

  /** 提交作业并开跑：kind 是 render | verify | deliver，payload 进作业记录。交回作业号 */
  function submit(id, kind, payload) {
    const tier = payload.tier;
    const lane = kind === 'verify' ? 'verify' : tier === 'final' ? 'final' : 'draft';
    const jobId = store.nextJobId(id);
    const q = queue(id);
    q.enqueue({ id: jobId, kind: lane, handler: kind, payload: { film: id, ...payload }, rev: payload.rev });
    const done = q.runJob(jobId).then(() => {
      // 排队时取消不会进入执行器，仍然留下这次作业的终态账目。
      if (q.getJob(jobId).status === 'canceled' && !existsSync(join(jobDir(id, jobId), 'outcome.json'))) {
        store.ledger(id, { step: `job.${kind}`, job: jobId, rev: payload.rev, status: 'canceled', ok: false, wallMs: 0, gpuSeconds: 0, tokens: 0, modelTokens: 0, frames: 0 });
      }
    });
    running.set(jobId, done);
    done.then(() => running.delete(jobId), () => running.delete(jobId));
    return jobId;
  }

  // 委托作业：编排进程只发 HTTP、不占显存，所以不进 GPU 调度器（否则它等自己触发的 render/deliver 子作业会自死锁）。
  // 队列跑作业必经调度器，它的 stopped 也只留给抢占，所以委托作业照 job/0.1 的字段自己写 jobs/<作业号>/job.json（路径取自队列的 jobFile），
  // 读、等、取消已停下的作业都走队列的 getJob，和普通作业一条路；重启后碰到磁盘仍在 running 的委托作业会自动收敛成 stopped（interrupted）。
  const delegates = new Map();

  /** 进程重启后遗留在磁盘的 running 委托作业已无编排闭包，立即收敛成 stopped（interrupted）并补齐结论。 */
  function recoverDelegate(id, jobId) {
    const q = queue(id);
    const job = q.getJob(jobId);
    if (job.handler !== 'delegate' || TERMINAL.has(job.status) || running.has(jobId)) return job;
    const file = q.jobFile(jobId);
    const open = job.steps.filter((s) => s.attempt === job.attempt && !s.endEvent).at(-1);
    const append = (type, details) => {
      const seq = (job.events.at(-1)?.seq ?? 0) + 1;
      job.events.push({ seq, attempt: job.attempt, type, ...details });
      return seq;
    };
    if (open) {
      open.status = 'stopped';
      open.endEvent = append('step-end', { name: open.name, status: 'stopped' });
    }
    job.status = 'stopped';
    append('stopped', { reason: 'interrupted' });
    const dir = jobDir(id, jobId);
    const outFile = join(dir, 'outcome.json');
    if (!existsSync(outFile)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(outFile, jsonText({
        ok: true,
        data: { stoppedReason: 'interrupted', bestRev: job.payload?.rev ?? store.rev(id) },
        outputs: [],
        next: [{ verb: `GET /v1/films/${id}/ledger`, why: '看这部片花了多少' }],
        cost: { tokens: 0, gpuSeconds: 0, wallMs: 0 },
        frames: 0,
      }));
    }
    if (!store.readLedger(id).some((r) => r.step === 'job.delegate' && r.job === jobId)) {
      store.ledger(id, { step: 'job.delegate', job: jobId, rev: job.payload?.rev ?? store.rev(id), status: 'stopped', ok: true, wallMs: 0, gpuSeconds: 0, tokens: 0, modelTokens: 0, frames: 0 });
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, jsonText(job));
    renameSync(`${file}.tmp`, file);
    return job;
  }

  /** 提交委托作业：run({ signal, onTokens }) 交回编排结论 { status, stoppedReason?, stoppedAt?, failedAt?, bestRev, cost, outputs }。交回作业号 */
  function submitDelegate(id, run) {
    const jobId = store.nextJobId(id);
    const file = queue(id).jobFile(jobId);
    const job = { format: 'job/0.1', id: jobId, request: { kind: 'delegate', vramMB: 0 }, handler: 'delegate', payload: { film: id, rev: store.rev(id) }, keep: 'none',
      status: 'running', attempt: 1, events: [], steps: [] };
    const event = (type, details) => job.events.push({ seq: job.events.length + 1, attempt: 1, type, ...details });
    const save = () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, jsonText(job)); renameSync(`${file}.tmp`, file); };
    const finish = (status, reason) => {
      const step = job.steps[0];
      step.status = status === 'succeeded' || status === 'failed' ? status : 'stopped';
      step.endEvent = event('step-end', { name: step.name, status: step.status });
      job.status = status;
      event(status, reason && { reason });
      save();
    };
    event('queued');
    event('running');
    job.steps.push({ name: 'orchestrate', attempt: 1, startEvent: event('step-start', { name: 'orchestrate' }) });
    save();
    const controller = new AbortController();
    const acc = { gpuSeconds: 0, frames: 0, tokens: 0, start: monotonicMs() };
    delegates.set(jobId, controller);
    progress.set(jobId, acc);
    const done = (async () => {
      let res;
      try {
        res = await run({ signal: controller.signal, onTokens: (n) => { if (Number.isFinite(n) && n > 0) acc.tokens += Math.round(n); } });
      } catch (e) { res = { status: 'failed', message: sanitizeErrorText(e?.message) || '委托编排失败' }; }
      try {
        if (controller.signal.aborted) res = { ...res, status: 'canceled' };
        else if (!TERMINAL.has(res?.status)) res = { status: 'failed', message: '委托编排没有交回结论' };
        const { status, cost = {}, delegateTokens = cost.tokens ?? 0, outputs = [], message, ...data } = res;
        const wallMs = Math.round(monotonicMs() - acc.start);
        const outcome = status === 'failed'
          ? { ok: false, code: 'contract.bad-value', message: message ?? `委托出片没有完成（${data.failedAt ?? '未知步骤'}）`, data, outputs, next: [{ verb: `GET /v1/films/${id}/ledger`, why: '看花了多少、停在哪' }] }
          : { ok: true, data, outputs, next: [{ verb: `GET /v1/films/${id}/ledger`, why: '看这部片花了多少' }] };
        outcome.cost = { tokens: cost.tokens ?? 0, gpuSeconds: r3(cost.gpuSeconds ?? 0), wallMs };
        outcome.frames = 0;
        mkdirSync(jobDir(id, jobId), { recursive: true });
        writeFileSync(join(jobDir(id, jobId), 'outcome.json'), jsonText(outcome));
        store.ledger(id, { step: 'job.delegate', job: jobId, rev: data.bestRev ?? job.payload.rev, status, ok: outcome.ok, wallMs, gpuSeconds: 0, tokens: 0, modelTokens: delegateTokens, frames: 0 });
        if (status === 'failed') job.error = outcome.message;
        finish(status, status === 'canceled' ? 'canceled' : data.stoppedReason);
      } catch (e) {
        // 结论、账本或记录写不了盘：记录尽量收在 failed，等的人才不会一直轮询。这个 promise 没人接，不能 reject。
        try {
          if (TERMINAL.has(job.status)) save();
          // 结论可能已经写下、账本没写上：删掉它，免得 failed 的记录配一份说成功的结论
          else { job.error = sanitizeErrorText(e?.message) || '委托结论落盘失败'; finish('failed'); rmSync(join(jobDir(id, jobId), 'outcome.json'), { force: true }); }
        } catch { /* 盘还是写不了：记录留在 running */ }
      } finally {
        delegates.delete(jobId);
        progress.delete(jobId);
      }
    })();
    running.set(jobId, done);
    done.then(() => running.delete(jobId));
    return jobId;
  }

  const statusOf = (id, jobId) => recoverDelegate(id, jobId).status;

  /** 等：until 是 'done'（到终态）或 'change'（状态变了）；最多等 seconds 秒 */
  function wait(id, jobId, seconds, until = 'done') {
    const first = statusOf(id, jobId);
    if (TERMINAL.has(first) || !(seconds > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = () => { clearTimeout(deadline); clearInterval(poll); waiters.delete(stop); resolve(); };
      const deadline = setTimeout(stop, seconds * 1000);
      // 每 40 毫秒看一次作业记录
      const poll = setInterval(() => {
        const now = statusOf(id, jobId);
        if (TERMINAL.has(now) || (until === 'change' && now !== first)) stop();
      }, 40);
      waiters.add(stop);
    });
  }

  /** 作业现在的样子：{ job, terminal, base（状态、阶段、最近 5 条事件、累计成本）, outcome（结论，没有是 null） } */
  function view(id, jobId) {
    const job = recoverDelegate(id, jobId);
    const terminal = TERMINAL.has(job.status);
    const open = job.steps.filter((s) => s.attempt === job.attempt && !s.endEvent).at(-1);
    const file = join(jobDir(id, jobId), 'outcome.json');
    const outcome = terminal && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const live = progress.get(jobId);
    const cost = outcome
      ? { gpuSeconds: outcome.cost.gpuSeconds, wallMs: outcome.cost.wallMs, tokens: outcome.cost.tokens, frames: outcome.frames }
      : { gpuSeconds: r3(live?.gpuSeconds ?? 0), wallMs: live ? Math.round(monotonicMs() - live.start) : 0, tokens: live?.tokens ?? 0, frames: live?.frames ?? 0 };
    const events = job.events.slice(-5).map((e) => ({ seq: e.seq, type: e.type, ...(e.name ? { name: e.name } : {}), ...(e.status ? { status: e.status } : {}), ...(e.reason ? { reason: e.reason } : {}) }));
    return {
      job, terminal, outcome,
      base: { job: jobId, verb: job.handler, status: job.status, stage: terminal ? null : open?.name ?? null, rev: job.payload.rev, events, cost,
        eventCounts: { expectedCount: job.events.length, actualCount: events.length },
        ...(!outcome?.data?.items ? { expectedCount: job.events.length, actualCount: events.length } : {}) },
    };
  }

  /** 取消：没到终态的发取消信号并等它停下；已经到终态的原样交回 */
  async function cancel(id, jobId) {
    const q = queue(id);
    const job = recoverDelegate(id, jobId);
    const del = delegates.get(jobId);
    const cancelChildren = () => Promise.all([...running.keys()]
      .filter((otherId) => otherId !== jobId && store.filmOfJob(otherId) === id && !delegates.has(otherId))
      .map((otherId) => cancel(id, otherId)));
    if (del) {
      del.abort();
      await Promise.all([running.get(jobId), cancelChildren()]);
      // 再扫一遍：覆盖在 del.abort() 发出瞬间刚落进队列的子作业。
      await cancelChildren();
    } else {
      if (!TERMINAL.has(job.status)) await Promise.resolve().then(() => q.cancelJob(jobId)).catch(() => undefined);
      await running.get(jobId);
    }
    return q.getJob(jobId).status;
  }

  /** 关服务时：放掉所有在等的长轮询，取消还在跑的作业 */
  async function cancelAll() {
    for (const stop of [...waiters]) stop();
    await Promise.all([...running.keys()].map((jobId) => cancel(store.filmOfJob(jobId), jobId)));
  }

  /* ---------------- 观测 ---------------- */

  /** 空间查询：对渲出来的帧的元数据问 entities | framing | texts | stats */
  function observeQuery(id, { type, target, frame, tier }) {
    const idx = pickFrames(id, tier);
    const rev = store.rev(id);
    const res = query(idx.records.map((r) => r.meta), { type, target, ...(frame !== undefined ? { frame } : {}) });
    if (!res.ok) {
      throw bad(res.error.message, { hint: res.error.hint ?? `渲过的帧：${idx.records.map((r) => r.frame).join('、')}`, data: { renderedRev: idx.rev, tier: idx.tier } });
    }
    const { ok: _ok, ...answer } = res;
    for (const [key, total] of [['entities', 'totalEntities'], ['texts', 'totalTexts'], ['frames', 'totalFrames']]) {
      if (!(key in answer)) continue;
      answer.expectedCount = answer[total] ?? 0;
      answer.actualCount = answer[key]?.length ?? 0;
    }
    return { data: { ...answer, tier: idx.tier, renderedRev: idx.rev, ...(idx.rev !== rev ? { stale: true, rev } : {}) }, frames: idx.records.length };
  }

  /**
   * 联系表与切点条带。当前修订交付过就从成片取（每一帧都有）；否则用渲出来的预览帧：
   * 帧号照全片帧号标，没渲的帧不进表；切点条带只出六个邻帧都渲过的切点，别的切点记进 missingCuts。
   */
  function observeSheet(id, { cuts = false, count = 12, tier }) {
    const film = store.readFilm(id), rev = store.rev(id);
    const done = delivered(id);
    const fromMaster = done?.rev === rev && !tier;
    const idx = fromMaster ? null : pickFrames(id, tier);
    const tag = fromMaster ? `rev${rev}-master` : `rev${idx.rev}-${idx.tier}`;
    const relDir = `sheets/${tag}`;
    const outDir = join(deliverDir(id), relDir);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    let source, have;
    if (fromMaster) {
      source = { video: done.master, fps: film.output.fps };
      have = new Set(span(0, film.output.frames));
    } else {
      const byFrame = new Map(idx.records.map((r) => [r.frame, r.png]));
      const last = Math.max(...byFrame.keys());
      // observe 按「帧号 → 第几个文件」取帧：没渲的帧号用一张渲过的垫位，下面只点渲过的帧号，垫位的不会被读到
      source = { frames: span(0, last + 1).map((f) => byFrame.get(f) ?? idx.records[0].png), start: 0 };
      have = new Set(byFrame.keys());
    }
    const all = [...have].sort((a, b) => a - b);
    const n = Math.min(count, all.length);
    const pick = n === 1 ? [all[0]] : Array.from({ length: n }, (_, i) => all[Math.round((i * (all.length - 1)) / (n - 1))]);
    const sheet = buildContactSheet({ ...source, pick: [...new Set(pick)], out: join(outDir, 'contact.png'), cellWidth: SHEET_CELL });
    if (!sheet.ok) throw new ApiError(sheet.error.code, sheet.error.message, { hint: sheet.error.hint });
    const files = [`${relDir}/contact.png`];
    const data = {
      source: fromMaster ? 'master' : 'frames', tier: fromMaster ? 'final' : idx.tier, renderedRev: fromMaster ? rev : idx.rev, ...(!fromMaster && idx.rev !== rev ? { stale: true, rev } : {}),
      contact: { file: 'contact.png', grid: sheet.summary.grid, cell: sheet.summary.cell, frames: sheet.cells.map((c) => c.frame) },
    };
    if (cuts) {
      const at = (film.transitions ?? []).map((t) => t.at);
      const ready = at.filter((c) => span(c - CUT_BEFORE, c + CUT_AFTER + 1).every((f) => have.has(f)));
      data.expectedCount = at.length;
      data.actualCount = 0;
      data.items = [];
      if (ready.length) {
        const strips = buildCutStrips({ ...source, cuts: ready, outDir: join(outDir, 'cuts'), cellWidth: SHEET_CELL });
        if (!strips.ok) throw new ApiError(strips.error.code, strips.error.message, { hint: strips.error.hint });
        data.items = strips.summary.cuts.map((c) => ({ cut: c.cut, cutDiff: c.cutDiff, postDiff: c.postDiff, flags: c.flags }));
        data.actualCount = data.items.length;
        for (const c of ready) files.push(`${relDir}/cuts/cut-${c}.png`);
      }
      const lost = at.filter((c) => !ready.includes(c));
      if (lost.length) data.missingCuts = lost.map((c) => ({ cut: c, need: [c - CUT_BEFORE, c + CUT_AFTER] }));
    }
    const outputs = files.map((rel, i) => output(id, i ? 'cut-strip' : 'contact', rel));
    return { data, outputs, frames: sheet.cells.length, images: files.map((rel, i) => ({ name: i ? 'cut' : 'contact', path: join(deliverDir(id), rel) })) };
  }

  /** 成片量测：交付规格、响度、黑帧与冻结、切点。要先交付过 */
  async function observeMetrics(id, { metrics }) {
    const done = delivered(id);
    if (!done) throw bad('还没有成片：成片量测要先交付', { hint: '先 POST deliver', next: [{ verb: `POST /v1/films/${id}/deliver`, why: '终渲出成片' }] });
    const names = metrics?.length ? [...new Set(metrics)] : Object.keys(METRICS);
    const items = [];
    for (const name of names) {
      const m = await METRICS[name](done.master).catch((e) => { throw new ApiError('failure.ffmpeg', `成片量测 ${name} 失败`); });
      if (m.value === null && m.details?.code === 'tool-missing') throw new ApiError('env.ffmpeg-missing', `找不到 ${m.details.tool ?? 'ffmpeg'}：量测 ${name} 跑不了`, { hint: '在服务器上装 FFmpeg（带 ffprobe）' });
      items.push({ metric: name, unit: m.unit, value: m.value, ...(m.details ? { details: m.details } : {}) });
    }
    const rev = store.rev(id);
    return {
      data: { expectedCount: names.length, actualCount: items.length, items, masterRev: done.rev, ...(done.rev !== rev ? { stale: true, rev } : {}) },
      outputs: [{ kind: 'master', url: url(id, `${done.job}/bundle/master.mp4`) }],
    };
  }

  /* ---------------- 审片 ---------------- */

  /**
   * L5 审片。没配置审片模型：status 是 not-run，写明原因，不取材料。配置了：当前修订交付过就从成片取联系表、切点条带和响度表，
   * 否则用渲出来的预览帧出联系表（没有声音量测）。结果写到 deliver/review/rev-<修订号>.json。L5 只是意见，不改硬门的判定。
   */
  async function review(id, { brief }) {
    const film = store.readFilm(id), rev = store.rev(id), meta = store.readMeta(id);
    const relDir = `review/rev-${rev}`;
    const outDir = join(deliverDir(id), relDir);
    mkdirSync(outDir, { recursive: true });
    let images = [], loudness = null, material = 'none';
    if (reviewer) {
      const done = delivered(id);
      if (done?.rev === rev) {
        images = reviewMaterials({ master: done.master, fps: film.output.fps, film, outDir });
        loudness = JSON.parse(readFileSync(join(done.dir, 'report.json'), 'utf8')).loudness ?? null;
        material = 'master';
      } else {
        const renderedRev = pickFrames(id).rev;
        if (renderedRev !== rev) throw bad('审片材料已过期，请先重渲当前修订', { data: { renderedRev, rev }, hint: '先 POST render，再 POST review' });
        images = observeSheet(id, { cuts: true, count: 12 }).images;
        material = 'frames';
      }
    }
    const l5 = await layerL5({ reviewer, brief: brief ?? meta.brief ?? meta.question?.brief ?? '', images, loudness, film });
    const record = { format: 'api-review/0.1', film: id, rev, material, images: images.map((i) => i.name), ...l5 };
    writeFileSync(join(outDir, 'review.json'), jsonText(record));
    const opinions = l5.opinions ?? [];
    return {
      data: {
        status: l5.status, ...(l5.reason ? { reason: l5.reason } : {}), ...(l5.model ? { model: l5.model } : {}), rev, material, overridesHardGates: false,
        expectedCount: opinions.length, actualCount: opinions.length, items: opinions, suggestedPredicates: l5.suggestedPredicates ?? [],
      },
      outputs: [output(id, 'review', `${relDir}/review.json`)],
      tokens: l5.usage?.totalTokens ?? 0,
      diagnostics: l5.status === 'failed' ? [diagnostic({ code: 'env.missing-tool', layer: 'L5', severity: 'warning', message: `审片模型没调通：${l5.reason}` }, { layer: 'L5', severity: 'warning' })] : [],
    };
  }

  return { submit, submitDelegate, view, wait, cancel, cancelAll, observeQuery, observeSheet, observeMetrics, review };
}
