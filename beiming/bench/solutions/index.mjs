#!/usr/bin/env node
// B20：12 份公开考题的标准答案工程统一入口（film/3.0 契约校验、技术卡驱动成片渲染、真实读回判分与噪声地板量测）。
// 命令行：node beiming/bench/solutions/index.mjs verify [--id <id>] [--out <dir>] [--noise-floor]
import Ajv2020 from 'ajv/dist/2020.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checks as filmContractChecks } from '../../kernel/contracts/film/check.mjs';
import filmSchema from '../../kernel/contracts/film/schema/film.schema.json' with { type: 'json' };
import sourceRegistry from '../../kernel/contracts/source/source.json' with { type: 'json' };
import { scanQuestionLeaks } from '../validate-question.mjs';
import { hasMediaTools } from './media.mjs';
import { PIPELINES, ensureOutDir } from './renderers.mjs';

export const SOLUTION_FORMAT = 'bench-solution/0.1';
export { hasMediaTools };

const HERE = dirname(fileURLToPath(import.meta.url));
const QUESTIONS_ROOT = resolve(HERE, '../questions');

const REGISTRY = Object.freeze([
  { questionId: '1-1', slug: '01-1', group: 'level-1' },
  { questionId: '23-1', slug: '23-1', group: 'level-1' },
  { questionId: '28-1', slug: '28-1', group: 'level-1' },
  { questionId: '29-1', slug: '29-1', group: 'level-1' },
  { questionId: '23-2', slug: '23-2', group: 'level-2-a' },
  { questionId: '27-1', slug: '27-1', group: 'level-2-a' },
  { questionId: '29-2', slug: '29-2', group: 'level-2-a' },
  { questionId: '30-1', slug: '30-1', group: 'level-2-a' },
  { questionId: '15-2', slug: '15-2', group: 'level-2-b' },
  { questionId: '18-1', slug: '18-1', group: 'level-2-b' },
  { questionId: '18-2', slug: '18-2', group: 'level-2-b' },
  { questionId: '5-1', slug: '5-1', group: 'level-2-b' },
]);

export const SOLUTION_IDS = Object.freeze(REGISTRY.map((entry) => entry.questionId));

const BY_KEY = new Map();
for (const entry of REGISTRY) {
  BY_KEY.set(entry.questionId, entry);
  BY_KEY.set(entry.slug, entry);
}
BY_KEY.set('05-1', BY_KEY.get('5-1'));

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
const validateFilmSchema = ajv.compile(filmSchema);
const FILM_CHECK_IDS = ['D1', 'D2', 'D8', 'D10', 'D11', 'D12', 'D13', 'D14', 'D16', 'D17', 'D18', 'D19', 'D20'];

function resolveEntry(id) {
  if (typeof id !== 'string') throw new RangeError(`未登记的考题号：${String(id)}`);
  const entry = BY_KEY.get(id.trim());
  if (!entry) throw new RangeError(`未登记的考题号：${id}`);
  return entry;
}

/** 收集 film/3.0 中声明的全部技术卡名（去主版本号，含 shots[].cards 与全局卡槽位） */
function declaredCardsOf(film) {
  const names = new Set();
  const addRef = (ref) => {
    if (typeof ref !== 'string') return;
    const at = ref.lastIndexOf('@');
    names.add(at > 0 ? ref.slice(0, at) : ref);
  };
  for (const shot of film?.shots ?? []) {
    for (const card of shot?.cards ?? []) addRef(card?.use);
  }
  addRef(film?.delivery?.card);
  addRef(film?.audio?.card);
  addRef(film?.style?.view?.card);
  addRef(film?.style?.finish?.card);
  return [...names];
}

export function loadSolutionSpec(id) {
  const entry = resolveEntry(id);
  const questionPath = join(QUESTIONS_ROOT, entry.group, `${entry.slug}.json`);
  const filmPath = join(HERE, entry.group, entry.slug, 'film.json');
  const question = JSON.parse(readFileSync(questionPath, 'utf8'));
  const film = JSON.parse(readFileSync(filmPath, 'utf8'));
  return {
    format: SOLUTION_FORMAT,
    id: entry.questionId,
    questionId: entry.questionId,
    slug: entry.slug,
    group: entry.group,
    questionPath,
    filmPath,
    question,
    film,
  };
}

export function loadSolutionFilm(id) {
  return loadSolutionSpec(id).film;
}

/**
 * 校验一份标准答案 film/3.0：
 * 1) Ajv2020 film.schema.json 结构校验；
 * 2) film/check.mjs 全部片子级契约不变量（D1、D2、D8、D10–D14、D16–D20）；
 * 3) 与对应考题 deliverable（size/fps/frames）与 needs 所需卡对齐；
 * 4) scanQuestionLeaks 零泄露门禁。
 */
export function validateSolutionFilm(idOrFilm) {
  let film;
  let question = null;
  let rawText = null;
  if (typeof idOrFilm === 'string') {
    const spec = loadSolutionSpec(idOrFilm);
    film = spec.film;
    question = spec.question;
    rawText = readFileSync(spec.filmPath, 'utf8');
  } else if (idOrFilm !== null && typeof idOrFilm === 'object' && !Array.isArray(idOrFilm)) {
    film = structuredClone(idOrFilm);
    if (typeof film.exam === 'string' && BY_KEY.has(film.exam)) {
      question = loadSolutionSpec(film.exam).question;
    }
  } else {
    throw new TypeError('validateSolutionFilm 需要题号字符串或 film/3.0 对象');
  }

  const schemaOk = validateFilmSchema(film);
  const schemaErrors = schemaOk ? [] : (validateFilmSchema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);

  const violations = {};
  if (schemaOk) {
    const ctx = { registries: { source: sourceRegistry }, schema: 'film.schema.json' };
    for (const checkId of FILM_CHECK_IDS) {
      const problems = filmContractChecks[checkId](film, ctx);
      if (problems.length) violations[checkId] = problems;
    }
  }

  const alignments = [];
  if (question) {
    const want = question.deliverable;
    const got = film.output;
    if (!got || got.size?.[0] !== want.size[0] || got.size?.[1] !== want.size[1]) {
      alignments.push(`output.size ${JSON.stringify(got?.size)} 与题面 deliverable.size ${JSON.stringify(want.size)} 不一致`);
    }
    if (got?.fps !== want.fps) {
      alignments.push(`output.fps ${JSON.stringify(got?.fps)} 与题面 deliverable.fps ${JSON.stringify(want.fps)} 不一致`);
    }
    if (got?.frames !== want.frames) {
      alignments.push(`output.frames ${JSON.stringify(got?.frames)} 与题面 deliverable.frames ${JSON.stringify(want.frames)} 不一致`);
    }
    if (film.exam !== question.id) {
      alignments.push(`film.exam ${JSON.stringify(film.exam)} 与题面 id ${JSON.stringify(question.id)} 不一致`);
    }
    const declared = new Set(declaredCardsOf(film));
    const missingCards = (question.needs ?? []).filter((card) => !declared.has(card));
    if (missingCards.length) {
      alignments.push(`film 缺少题面 needs 要求的卡：${missingCards.join('、')}`);
    }
  }

  const leaks = rawText !== null ? scanQuestionLeaks(rawText) : scanQuestionLeaks(film);
  const ok = schemaErrors.length === 0
    && Object.keys(violations).length === 0
    && alignments.length === 0
    && leaks.length === 0;

  return { ok, schemaErrors, violations, alignments, leaks, declaredCards: declaredCardsOf(film) };
}

export async function renderSolution(id, outDir, opts = {}) {
  const spec = loadSolutionSpec(id);
  const pipeline = PIPELINES[spec.slug];
  if (!pipeline) throw new RangeError(`未实现标准答案渲染器：${spec.slug}`);
  if (typeof outDir !== 'string' || !outDir.trim()) throw new TypeError('renderSolution 需要有效的 outDir 目录路径');
  const targetDir = ensureOutDir(resolve(outDir));
  const t0 = Date.now();
  const result = await pipeline.render(spec.question, spec.film, targetDir, opts);
  const elapsedMs = Date.now() - t0;
  return {
    format: SOLUTION_FORMAT,
    questionId: spec.questionId,
    slug: spec.slug,
    filmPath: spec.filmPath,
    outDir: targetDir,
    ...result,
    elapsedMs,
  };
}

export async function measureSolution(id, rendered, opts = {}) {
  const spec = loadSolutionSpec(id);
  const pipeline = PIPELINES[spec.slug];
  if (!pipeline) throw new RangeError(`未实现标准答案量测器：${spec.slug}`);
  if (!rendered || typeof rendered !== 'object' || typeof rendered.deliverablePath !== 'string') {
    throw new TypeError('measureSolution 需要 renderSolution 返回的产物对象');
  }
  const t0 = Date.now();
  const result = await pipeline.measure(spec.question, spec.film, rendered, opts);
  const elapsedMs = Date.now() - t0;
  return {
    format: SOLUTION_FORMAT,
    questionId: spec.questionId,
    slug: spec.slug,
    ...result,
    elapsedMs,
  };
}

export async function evaluateSolution(id, outDir, opts = {}) {
  const rendered = await renderSolution(id, outDir, opts);
  const measured = await measureSolution(id, rendered, opts);
  return {
    format: SOLUTION_FORMAT,
    questionId: rendered.questionId,
    slug: rendered.slug,
    filmPath: rendered.filmPath,
    deliverablePath: rendered.deliverablePath,
    artifacts: rendered.artifacts,
    cardsUsed: rendered.cardsUsed,
    readings: measured.readings,
    basePredicates: measured.basePredicates,
    verdict: measured.verdict,
    probe: measured.probe,
    renderMs: rendered.elapsedMs,
    measureMs: measured.elapsedMs,
    totalMs: rendered.elapsedMs + measured.elapsedMs,
  };
}

/** 递归展开读数中的有限数值指标为扁平键值表（跳过 base/spec 静态规格与原始矩阵大数组） */
function flattenNumericMetrics(value, prefix = '', out = {}) {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out[prefix] = value;
    else if (value === Infinity) out[prefix] = Infinity;
    return out;
  }
  if (Array.isArray(value)) {
    // 跳过 300 帧相机矩阵原始数组与非数值事件对象表（它们通过标量读数反映）
    if (value.length > 64) return out;
    for (let i = 0; i < value.length; i++) {
      flattenNumericMetrics(value[i], `${prefix}[${i}]`, out);
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'base' || k === 'shots' || k === 'cameras' || k === 'spec') continue;
      flattenNumericMetrics(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

function diffNumericMaps(a, b) {
  const byMetric = {};
  let maxDelta = 0;
  for (const key of Object.keys(a)) {
    if (!Object.hasOwn(b, key)) continue;
    const va = a[key], vb = b[key];
    const delta = va === vb ? 0 : (Number.isFinite(va) && Number.isFinite(vb) ? Math.abs(va - vb) : NaN);
    if (!Number.isFinite(delta)) continue;
    byMetric[key] = delta;
    if (delta > maxDelta) maxDelta = delta;
  }
  return { maxDelta, byMetric };
}

/**
 * 执行容差校准第 1 步（噪声地板量测）：
 * 1) 同一份成片量两遍 → repeatMeasureDelta；
 * 2) 独立重渲第二份成片再量一遍 → repeatRenderDelta；
 * 3) 汇总全部有限数值读数的最大自然抖动 noiseFloor。
 */
export async function measureNoiseFloor(id, outDir, opts = {}) {
  const spec = loadSolutionSpec(id);
  if (typeof outDir !== 'string' || !outDir.trim()) throw new TypeError('measureNoiseFloor 需要有效的 outDir 目录路径');
  const root = ensureOutDir(resolve(outDir));
  const dirA = join(root, 'run-a');
  const dirB = join(root, 'run-b');

  const renderA = await renderSolution(spec.questionId, dirA, opts);
  const measA1 = await measureSolution(spec.questionId, renderA, opts);
  const measA2 = await measureSolution(spec.questionId, renderA, opts);

  const renderB = await renderSolution(spec.questionId, dirB, opts);
  const measB = await measureSolution(spec.questionId, renderB, opts);

  const flatA1 = flattenNumericMetrics(measA1.readings);
  const flatA2 = flattenNumericMetrics(measA2.readings);
  const flatB = flattenNumericMetrics(measB.readings);

  const repMeasure = diffNumericMaps(flatA1, flatA2);
  const repRender = diffNumericMaps(flatA1, flatB);
  const noiseFloor = Math.max(repMeasure.maxDelta, repRender.maxDelta);

  return {
    format: SOLUTION_FORMAT,
    questionId: spec.questionId,
    slug: spec.slug,
    noiseFloor,
    repeatMeasureDelta: repMeasure.maxDelta,
    repeatRenderDelta: repRender.maxDelta,
    repeatMeasureByMetric: repMeasure.byMetric,
    repeatRenderByMetric: repRender.byMetric,
    runs: {
      first: measA1.verdict,
      repeatMeasure: measA2.verdict,
      secondRender: measB.verdict,
    },
  };
}

/* ---------------- CLI：verify ---------------- */

async function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'verify') {
    process.stderr.write('用法：node beiming/bench/solutions/index.mjs verify [--id <id>] [--out <dir>] [--noise-floor]\n');
    return 2;
  }
  let targetId = null;
  let outBase = null;
  let doNoiseFloor = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--id') targetId = rest[++i];
    else if (rest[i] === '--out') outBase = rest[++i];
    else if (rest[i] === '--noise-floor') doNoiseFloor = true;
    else {
      process.stderr.write(`未知参数：${rest[i]}\n`);
      return 2;
    }
  }
  const ids = targetId ? [resolveEntry(targetId).questionId] : [...SOLUTION_IDS];
  const ownTmp = !outBase;
  const workRoot = ownTmp ? mkdtempSync(join(tmpdir(), 'beiming-b20-')) : resolve(outBase);
  const summary = new Array(ids.length);
  let allPass = true;
  let missingMedia = false;
  try {
    const concurrency = Math.min(4, ids.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const idx = cursor++;
        const qid = ids[idx];
        const check = validateSolutionFilm(qid);
        if (!check.ok) {
          allPass = false;
          summary[idx] = { id: qid, pass: false, contract: check };
          continue;
        }
        if (!hasMediaTools()) {
          missingMedia = true;
          return;
        }
        const subDir = join(workRoot, resolveEntry(qid).slug);
        const res = await evaluateSolution(qid, subDir);
        let nf = null;
        if (doNoiseFloor) {
          nf = await measureNoiseFloor(qid, join(workRoot, `${resolveEntry(qid).slug}-nf`));
        }
        const pass = res.verdict.pass === true && res.verdict.score === 1;
        if (!pass) allPass = false;
        summary[idx] = {
          id: res.questionId,
          slug: res.slug,
          pass,
          score: res.verdict.score,
          renderMs: res.renderMs,
          measureMs: res.measureMs,
          totalMs: res.totalMs,
          ...(nf ? { noiseFloor: nf.noiseFloor, repeatMeasureDelta: nf.repeatMeasureDelta, repeatRenderDelta: nf.repeatRenderDelta } : {}),
        };
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (missingMedia) {
      process.stderr.write('缺少 ffmpeg/ffprobe，无法执行真实成片渲染与读回\n');
      return 3;
    }
    process.stdout.write(`${JSON.stringify({ format: SOLUTION_FORMAT, ok: allPass, results: summary }, null, 2)}\n`);
    return allPass ? 0 : 1;
  } finally {
    if (ownTmp) rmSync(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
