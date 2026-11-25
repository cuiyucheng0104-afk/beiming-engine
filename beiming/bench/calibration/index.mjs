#!/usr/bin/env node
// B7（05 §6.5）：12 道公开考题容差校准五步引擎。
// 命令行：node beiming/bench/calibration/index.mjs run [--write] [--id <id>] [--as-of <YYYY-MM-DD>]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCalendarDate } from '../../cards/status.mjs';
import {
  buildPositiveBaseline as buildB5L1PositiveBaseline,
  evaluateNegativeControl as evaluateB5L1Negative,
} from '../negatives/level-1/run-b5-l1.mjs';
import {
  buildPositiveBaseline as buildB5L2aPositiveBaseline,
  evaluateNegativeControl as evaluateB5L2aNegative,
} from '../negatives/level-2-a/run-b5-l2a.mjs';
import {
  buildPositiveBaseline as buildB6PositiveBaseline,
  evaluateNegativeControl as evaluateB6Negative,
} from '../negatives/level-2-b/run-b6.mjs';
import { score as scoreLevel1 } from '../questions/level-1/evaluate-b2.mjs';
import { evaluate as evaluateLevel2a } from '../questions/level-2-a/evaluate-b3.mjs';
import {
  median,
  readCameraStatic,
  readHits,
  readSubtitleLag,
  score as scoreLevel2b,
} from '../questions/level-2-b/evaluate-b4.mjs';
import {
  SOLUTION_IDS,
  evaluateSolution,
  hasMediaTools,
  loadSolutionSpec,
  measureNoiseFloor,
} from '../solutions/index.mjs';
import { scanQuestionLeaks, validateQuestion } from '../validate-question.mjs';

export const CALIBRATION_RECORD_FORMAT = 'bench-calibration/0.1';
export const CALIBRATION_VERSION = 1;
export const DEFAULT_CALIBRATED_ON = '2026-11-25';
export const CALIBRATION_IDS = Object.freeze([...SOLUTION_IDS]);
export const NEGATIVE_KINDS = Object.freeze(['disable-card', 'shift-2f', 'random-beats']);
export { hasMediaTools };

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = resolve(HERE, '..');
const BEIMING_DIR = resolve(BENCH_DIR, '..');
const RECORDS_DIR = join(HERE, 'records');

const REGISTRY = Object.freeze([
  Object.freeze({
    questionId: '1-1',
    slug: '01-1',
    group: 'level-1',
    tier: 'strict',
    tierLabel: '严档',
    tierRationale: '严格交付基线（全片成片封装、响度与无黑帧/冻结），按严档定线',
  }),
  Object.freeze({
    questionId: '23-1',
    slug: '23-1',
    group: 'level-1',
    tier: 'strict',
    tierLabel: '严档',
    tierRationale: '作者原文件严格基线（360° 环绕与首尾闭环），按严档定线',
  }),
  Object.freeze({
    questionId: '28-1',
    slug: '28-1',
    group: 'level-1',
    tier: 'strict',
    tierLabel: '严档',
    tierRationale: '严格交付基线（全帧包围盒留白与首尾闭环），按严档定线',
  }),
  Object.freeze({
    questionId: '29-1',
    slug: '29-1',
    group: 'level-1',
    tier: 'strict',
    tierLabel: '严档',
    tierRationale: '作者原文件严格基线（三区通栏 0 像素误差与分隔线色值），按严档定线',
  }),
  Object.freeze({
    questionId: '23-2',
    slug: '23-2',
    group: 'level-2-a',
    tier: 'strict',
    tierLabel: '严档',
    tierRationale: '作者原文件严格基线（章节踩拍与强起音对齐），按严档定线',
  }),
  Object.freeze({
    questionId: '27-1',
    slug: '27-1',
    group: 'level-2-a',
    tier: 'strict',
    tierLabel: '严档',
    tierRationale: '严格交付基线（节拍网格切点与响度门限），按严档定线',
  }),
  Object.freeze({
    questionId: '29-2',
    slug: '29-2',
    group: 'level-2-a',
    tier: 'strict',
    tierLabel: '严档',
    tierRationale: '作者原文件严格基线（点击后 2 帧切点与配乐起音命中），按严档定线',
  }),
  Object.freeze({
    questionId: '30-1',
    slug: '30-1',
    group: 'level-2-a',
    tier: 'strict',
    tierLabel: '严档',
    tierRationale: '严格行为基线（80→96 BPM 重求值跟拍位移与命名时刻命中），按严档定线',
  }),
  Object.freeze({
    questionId: '15-2',
    slug: '15-2',
    group: 'level-2-b',
    tier: 'relaxed',
    tierLabel: '放宽档',
    tierRationale: '参考为平台重压版，机位锁死像素估测口径按放宽档管理并配逐帧矩阵硬约束',
  }),
  Object.freeze({
    questionId: '18-1',
    slug: '18-1',
    group: 'level-2-b',
    tier: 'relaxed',
    tierLabel: '放宽档',
    tierRationale: '参考为平台重压版，淡出/停顿/底色占比容差按放宽档管理并留安全余量',
  }),
  Object.freeze({
    questionId: '18-2',
    slug: '18-2',
    group: 'level-2-b',
    tier: 'relaxed',
    tierLabel: '放宽档',
    tierRationale: '参考为平台重压版，运镜提前量与帧容差按放宽档管理并由随机基线提升兜底',
  }),
  Object.freeze({
    questionId: '5-1',
    slug: '5-1',
    group: 'level-2-b',
    tier: 'strict',
    tierLabel: '严档',
    tierRationale: '严格声画对位基线（配乐拉伸与唯一硬切低频重击命中），按严档定线',
  }),
]);

export const STRICT_IDS = Object.freeze(REGISTRY.filter((e) => e.tier === 'strict').map((e) => e.questionId));
export const RELAXED_IDS = Object.freeze(REGISTRY.filter((e) => e.tier === 'relaxed').map((e) => e.questionId));
export const CALIBRATION_TIERS = Object.freeze({ strict: STRICT_IDS, relaxed: RELAXED_IDS });

const BY_KEY = new Map();
for (const entry of REGISTRY) {
  BY_KEY.set(entry.questionId, entry);
  BY_KEY.set(entry.slug, entry);
}
BY_KEY.set('05-1', BY_KEY.get('5-1'));

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function resolveEntry(id) {
  if (typeof id !== 'string') throw new RangeError(`未登记的校准考题号：${String(id)}`);
  const entry = BY_KEY.get(id.trim());
  if (!entry) throw new RangeError(`未登记的校准考题号：${id}`);
  return entry;
}

export function getCalibrationTier(id) {
  const entry = resolveEntry(id);
  return Object.freeze({
    questionId: entry.questionId,
    slug: entry.slug,
    group: entry.group,
    tier: entry.tier,
    tierLabel: entry.tierLabel,
    tierRationale: entry.tierRationale,
  });
}

/** 转为纯 JSON 数值（保留有限数；Infinity 显式标记为字符串 'Infinity'，避免 JSON.stringify 误转为 null）。 */
function jsonSafeValue(v) {
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return Object.is(v, -0) ? 0 : v;
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    return null;
  }
  if (Array.isArray(v)) return v.map(jsonSafeValue);
  if (isPlainObject(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, jsonSafeValue(val)]));
  }
  return v;
}

function roundNum(n, digits = 6) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return jsonSafeValue(n);
  const scale = 10 ** digits;
  const r = Math.round(n * scale) / scale;
  return Object.is(r, -0) ? 0 : r;
}

function parseFpsNumber(fps) {
  const [num, den] = String(fps).split('/').map(Number);
  return num / den;
}

function resolveRefAbs(refRel) {
  const normalized = refRel.startsWith('beiming/') ? refRel.slice('beiming/'.length) : refRel;
  const abs = resolve(BEIMING_DIR, normalized);
  const rel = relative(BEIMING_DIR, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RangeError(`参考路径越界：${refRel}`);
  }
  return { abs, normalized };
}

/** 构建写回公开考题 JSON 的四键 calibration 对象（严格遵守 question.schema.json additionalProperties: false）。 */
export function buildQuestionCalibrationField({ slug, tierLabel, calibratedOn = DEFAULT_CALIBRATED_ON, noiseFloor, version = CALIBRATION_VERSION }) {
  if (!Number.isFinite(noiseFloor) || noiseFloor < 0) {
    throw new RangeError(`noiseFloor 必须为有限非负数，收到：${String(noiseFloor)}`);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError(`version 必须为不小于 1 的整数，收到：${String(version)}`);
  }
  if (!isCalendarDate(calibratedOn)) {
    throw new RangeError(`calibratedOn 必须是 YYYY-MM-DD 日历日期，收到：${String(calibratedOn)}`);
  }
  return {
    status: 'calibrated',
    source: `B7 五步容差校准 v${version}（${tierLabel}，${calibratedOn}）：经标准答案 4 遍噪声地板、参考自检与 3 份标准负对照实测定线，细则见 bench/calibration/records/${slug}.json`,
    noiseFloor: roundNum(noiseFloor, 6),
    version,
  };
}

/* ---------------- 指标读数摘要提取（供 Step 3 负对照与 Step 4 定线使用） ---------------- */

function amplitudeFromPsnr(db) {
  if (db === Infinity) return 0;
  return 10 ** (-db / 20);
}

/** 提取某道题第 itemIndex 条判分项在给定读数与判定结果下的结构化实测读数。 */
function extractItemObservation(question, itemIndex, readings, verdict, opts = {}) {
  const item = question.scoring[itemIndex];
  const metric = item.metric;
  const args = item.args ?? {};
  const itemVerdict = verdict?.items?.[itemIndex];
  const pass = Boolean(itemVerdict?.pass);

  if (question.id === '1-1') {
    if (metric === 'deliver.spec') {
      const r = readings?.['deliver.spec'] ?? {};
      return {
        pass,
        width: r.width ?? null,
        height: r.height ?? null,
        fps: r.fps ?? null,
        frames: r.frames ?? null,
        audioChannels: r.audioChannels ?? null,
        colorMatch: ['color_space', 'color_transfer', 'color_primaries'].every((k) => r[k] === args.color),
      };
    }
    if (metric === 'audio.loudness') {
      const r = readings?.['audio.loudness'] ?? {};
      return {
        pass,
        lufs: roundNum(r.lufs ?? null, 4),
        truePeakDbtp: roundNum(r.truePeakDbtp ?? null, 4),
      };
    }
    if (metric === 'frame.black-freeze-dup') {
      const r = readings?.['frame.black-freeze-dup'] ?? {};
      return {
        pass,
        blackFrames: r.blackFrames ?? null,
        freezeSegments: r.freezeSegments ?? null,
        duplicateFrames: r.duplicateFrames ?? null,
      };
    }
  }

  if (question.id === '23-1') {
    const r = readings?.['loop.closure-psnr'] ?? {};
    if (args.expect !== undefined) {
      return {
        pass,
        nearest: r.nearest ?? null,
        expect: args.expect,
        deltaFrames: Number.isFinite(r.nearest) ? Math.abs(r.nearest - args.expect) : null,
      };
    }
    const closurePsnr = r.closurePsnr;
    const adjacentPsnr = r.adjacentPsnr;
    const adjAmp = typeof adjacentPsnr === 'number' ? amplitudeFromPsnr(adjacentPsnr) : null;
    const clsAmp = typeof closurePsnr === 'number' ? amplitudeFromPsnr(closurePsnr) : null;
    const rmseRatio = adjAmp !== null && clsAmp !== null
      ? (adjAmp === 0 ? (clsAmp === 0 ? 1 : Infinity) : clsAmp / adjAmp)
      : null;
    return {
      pass,
      closurePsnr: roundNum(closurePsnr ?? null, 4),
      adjacentPsnr: roundNum(adjacentPsnr ?? null, 4),
      rmseRatio: roundNum(rmseRatio, 4),
    };
  }

  if (question.id === '28-1') {
    if (metric === 'meta.bbox-limits') {
      const r = readings?.['meta.bbox-limits'] ?? {};
      return {
        pass,
        frames: r.frames ?? null,
        maxW: roundNum(r.maxW ?? null, 4),
        maxH: roundNum(r.maxH ?? null, 4),
        minMarginLr: roundNum(r.minMarginLr ?? null, 4),
        minMarginTb: roundNum(r.minMarginTb ?? null, 4),
      };
    }
    if (metric === 'loop.closure-psnr') {
      const r = readings?.['loop.closure-psnr'] ?? {};
      const diffDb = Number.isFinite(r.closurePsnr) && Number.isFinite(r.adjacentPsnr)
        ? r.closurePsnr - r.adjacentPsnr
        : (r.closurePsnr === Infinity ? Infinity : null);
      return {
        pass,
        closurePsnr: roundNum(r.closurePsnr ?? null, 4),
        adjacentPsnr: roundNum(r.adjacentPsnr ?? null, 4),
        closureMinusAdjacentDb: roundNum(diffDb, 4),
      };
    }
    if (metric === 'pixel.bbox') {
      const r = readings?.['pixel.bbox'] ?? {};
      return { pass, maxDiffPx: roundNum(r.maxDiffPx ?? null, 4) };
    }
  }

  if (question.id === '29-1') {
    const r = readings?.['layout.edges'] ?? {};
    if (args.maxEdgeErrorPx !== undefined) {
      const edgeMax = Array.isArray(r.edgeErrorsPx) && r.edgeErrorsPx.every(Number.isFinite) ? Math.max(...r.edgeErrorsPx) : null;
      const sideMax = Array.isArray(r.sideErrorsPx) && r.sideErrorsPx.every(Number.isFinite) ? Math.max(...r.sideErrorsPx) : null;
      return {
        pass,
        maxEdgeErrorPx: edgeMax,
        maxSideErrorPx: sideMax,
      };
    }
    return { pass, lineColorError: r.lineColorError ?? null };
  }

  if (question.id === '23-2') {
    const d = itemVerdict?.detail ?? {};
    if (args.event === 'chapter') {
      const maxOffBeatMs = Array.isArray(d.offBeatMs) && d.offBeatMs.length ? Math.max(...d.offBeatMs) : null;
      return {
        pass,
        chapters: d.chapters ?? null,
        maxOffBeatMs: roundNum(maxOffBeatMs, 4),
      };
    }
    return {
      pass,
      hits: d.hits ?? null,
      events: d.events ?? null,
      hitRate: roundNum(d.hitRate ?? null, 4),
    };
  }

  if (question.id === '27-1') {
    const d = itemVerdict?.detail ?? {};
    if (metric === 'cut.ydif') {
      return {
        pass,
        cuts: d.cuts ?? null,
        firstCut: d.firstCut ?? null,
        offGridCount: Array.isArray(d.offGrid) ? d.offGrid.length : null,
      };
    }
    return {
      pass,
      loudnessLufs: roundNum(d.loudnessLufs ?? null, 4),
      truePeakDbtp: roundNum(d.truePeakDbtp ?? null, 4),
    };
  }

  if (question.id === '29-2') {
    const d = itemVerdict?.detail ?? {};
    if (metric === 'cut.ydif') {
      return {
        pass,
        clicks: d.clicks ?? null,
        uncutCount: Array.isArray(d.uncut) ? d.uncut.length : null,
      };
    }
    const lift = Number.isFinite(d.hitRate) && Number.isFinite(d.randomBaseline) ? d.hitRate - d.randomBaseline : null;
    return {
      pass,
      hits: d.hits ?? null,
      events: d.events ?? null,
      hitRate: roundNum(d.hitRate ?? null, 4),
      randomBaseline: roundNum(d.randomBaseline ?? null, 4),
      lift: roundNum(lift, 4),
    };
  }

  if (question.id === '30-1') {
    const d = itemVerdict?.detail ?? {};
    if (metric === 'beat.onset-hit') {
      const lift = Number.isFinite(d.hitRate) && Number.isFinite(d.randomBaseline) ? d.hitRate - d.randomBaseline : null;
      return {
        pass,
        beatEventsCount: d.events ?? null,
        hitRate: roundNum(d.hitRate ?? null, 4),
        randomBaseline: roundNum(d.randomBaseline ?? null, 4),
        lift: roundNum(lift, 4),
        requiredHitRate: roundNum(d.requiredHitRate ?? null, 4),
      };
    }
    return {
      pass,
      movedRatio: roundNum(d.movedRatio ?? null, 4),
      movableRatio: roundNum(d.movableRatio ?? null, 4),
      requiredMovedRatio: roundNum(d.requiredMovedRatio ?? null, 4),
    };
  }

  if (question.id === '15-2') {
    if (metric === 'meta.camera-static') {
      const r = readings?.['meta.camera-static'] ?? {};
      const stat = readCameraStatic(r.cameras);
      return { pass, frames: stat.frames, changedAt: stat.changedAt };
    }
    const pairs = readings?.['motion.zoom-pan']?.pairs ?? [];
    const maxScaleDev = pairs.length ? Math.max(...pairs.map((p) => Math.abs((p?.scale ?? 1) - args.scale))) : null;
    const maxPanPx = pairs.length ? Math.max(...pairs.map((p) => Math.hypot(p?.dx ?? 0, p?.dy ?? 0))) : null;
    const maxErrorGap = pairs.length ? Math.max(...pairs.map((p) => Math.abs((p?.error ?? 0) - (p?.stillError ?? 0)))) : null;
    return {
      pass,
      pairCount: pairs.length,
      maxScaleDev: roundNum(maxScaleDev, 6),
      maxPanPx: roundNum(maxPanPx, 4),
      maxErrorGap: roundNum(maxErrorGap, 6),
    };
  }

  if (question.id === '18-1') {
    const r = readings?.[metric] ?? {};
    if (args.maxSubtitleLagSec !== undefined) {
      const perSec = parseFpsNumber(question.deliverable.fps);
      const span = opts.allowReferenceSpan === true && Array.isArray(args.refFrames)
        ? (args.refFrames[1] - args.refFrames[0]) / perSec
        : question.deliverable.frames / perSec;
      const stats = Array.isArray(r.appearSec) && Array.isArray(r.onsetsSec)
        ? readSubtitleLag(r.appearSec, r.onsetsSec, span, args.maxSubtitleLagSec)
        : { subtitleLagSec: null, hitRate: null, randomRate: null };
      const lift = Number.isFinite(stats.hitRate) && Number.isFinite(stats.randomRate) ? stats.hitRate - stats.randomRate : null;
      return {
        pass,
        subtitleLagSec: roundNum(stats.subtitleLagSec, 4),
        hitRate: roundNum(stats.hitRate, 4),
        randomRate: roundNum(stats.randomRate, 4),
        lift: roundNum(lift, 4),
      };
    }
    if (args.fadeFrames !== undefined) {
      const list = Array.isArray(r.fadeFrames) ? r.fadeFrames : [];
      const inRangeCount = list.filter((f) => f >= args.fadeFrames[0] && f <= args.fadeFrames[1]).length;
      return {
        pass,
        fadeCount: list.length,
        medianFadeFrames: roundNum(median(list), 4),
        inRangeCount,
      };
    }
    if (args.minLeadSec !== undefined) {
      const leads = Array.isArray(r.leadSec) ? r.leadSec : [];
      const tails = Array.isArray(r.tailSec) ? r.tailSec : [];
      return {
        pass,
        sceneCount: leads.length,
        medianLeadSec: roundNum(median(leads), 4),
        medianTailSec: roundNum(median(tails), 4),
      };
    }
    if (metric === 'color.palette') {
      const shares = Array.isArray(r.shares) ? r.shares : [];
      return {
        pass,
        sceneCount: shares.length,
        minShare: shares.length ? roundNum(Math.min(...shares), 4) : null,
        maxShare: shares.length ? roundNum(Math.max(...shares), 4) : null,
      };
    }
  }

  if (question.id === '18-2') {
    const r = readings?.['narration.timing'] ?? {};
    const events = Array.isArray(r.eventFrames) ? r.eventFrames : [];
    const marks = Array.isArray(r.markFrames) ? r.markFrames : [];
    const window = Array.isArray(r.range) && r.range.length === 2 ? r.range : [0, question.deliverable.frames];
    const expected = events.map((f, i) => f - (args.leadFrames?.[i] ?? 0));
    const stats = expected.length && marks.length ? readHits(expected, marks, window, args.tolFrames) : null;
    const pairedOffsets = expected.length === marks.length
      ? expected.map((f, i) => Math.abs(marks[i] - f))
      : stats?.offsetsFrames ?? [];
    const maxOffsetFrames = pairedOffsets.length && pairedOffsets.every(Number.isFinite) ? Math.max(...pairedOffsets) : null;
    const lift = stats && Number.isFinite(stats.randomRate) ? (stats.hitRate - stats.randomRate) : null;
    return {
      pass,
      moveCount: marks.length,
      maxOffsetFrames: roundNum(maxOffsetFrames, 4),
      hitRate: roundNum(stats?.hitRate ?? null, 4),
      randomRate: roundNum(stats?.randomRate ?? null, 4),
      lift: roundNum(lift, 4),
    };
  }

  if (question.id === '5-1') {
    if (metric === 'music.align') {
      const r = readings?.['music.align'] ?? {};
      return {
        pass,
        corr: roundNum(r.corr ?? null, 4),
        stretch: roundNum(r.stretch ?? null, 4),
        offsetSec: roundNum(r.offsetSec ?? null, 4),
      };
    }
    const r = readings?.['beat.onset-hit'] ?? {};
    const events = Array.isArray(r.eventFrames) ? r.eventFrames : [];
    const marks = Array.isArray(r.markFrames) ? r.markFrames : [];
    const window = Array.isArray(r.range) && r.range.length === 2 ? r.range : [0, question.deliverable.frames];
    const stats = events.length && marks.length ? readHits(events, marks, window, args.tolFrames) : null;
    const maxOffsetFrames = stats?.offsetsFrames?.every(Number.isFinite) ? Math.max(...stats.offsetsFrames) : null;
    const lift = stats && Number.isFinite(stats.randomRate) ? (stats.hitRate - stats.randomRate) : null;
    return {
      pass,
      eventCount: events.length,
      maxOffsetFrames: roundNum(maxOffsetFrames, 4),
      hitRate: roundNum(stats?.hitRate ?? null, 4),
      randomRate: roundNum(stats?.randomRate ?? null, 4),
      lift: roundNum(lift, 4),
    };
  }

  return { pass };
}

/* ---------------- Step 2：参考夹具自检（纯离线可跑，零 FFmpeg 依赖） ---------------- */

function buildLevel2bRefReadings(question, refData) {
  if (question.id === '5-1') {
    return {
      positive: {
        'music.align': {
          corr: refData.musicAlign.corr,
          stretch: refData.musicAlign.stretch,
          offsetSec: refData.musicAlign.offsetSec,
        },
        'beat.onset-hit': {
          eventFrames: [refData.hardCutFrame],
          markFrames: refData.lowBand.peakFrames,
          range: [0, refData.frames],
        },
      },
      negatives: [],
      opts: undefined,
    };
  }
  if (question.id === '18-1') {
    const paletteArgs = question.scoring.find((s) => s.metric === 'color.palette')?.args;
    if (!paletteArgs || !HEX_COLOR_RE.test(paletteArgs.color)) {
      throw new Error('18-1 缺少合法的 color.palette 参数');
    }
    const bin = (ch) => Math.floor((ch * paletteArgs.binLevels) / 256);
    const target = [1, 3, 5].map((i) => bin(parseInt(paletteArgs.color.slice(i, i + 2), 16)));
    const shares = refData.palette.sceneFrames.map((sf) => sf.colors
      .filter(([hex]) => [1, 3, 5].every((i, idx) => bin(parseInt(hex.slice(i, i + 2), 16)) === target[idx]))
      .reduce((sum, [, share]) => sum + share, 0));
    return {
      positive: {
        'narration.timing': {
          appearSec: refData.subtitleAppearSec,
          onsetsSec: refData.narrationOnsetsSec,
          spanSec: refData.frames / refData.fps,
          fadeFrames: refData.sceneFadeFrames,
          leadSec: refData.scenePauses.leadSec,
          tailSec: refData.scenePauses.tailSec,
        },
        'color.palette': { shares },
      },
      negatives: [],
      opts: { allowReferenceSpan: true },
    };
  }
  if (question.id === '18-2') {
    return {
      positive: {
        'narration.timing': {
          eventFrames: refData.moves.map((m) => m.cueSec * refData.fps),
          markFrames: refData.moves.map((m) => Math.round(m.measuredStartSec * refData.fps)),
          range: refData.sceneFrames,
        },
      },
      negatives: [],
      opts: undefined,
    };
  }
  if (question.id === '15-2') {
    const baseStatic = buildB6PositiveBaseline('15-2').readings['meta.camera-static'];
    return {
      positive: {
        'meta.camera-static': baseStatic,
        'motion.zoom-pan': { pairs: refData.locked },
      },
      negatives: (refData.drifting ?? []).map((drift, idx) => ({
        label: `15-2-drifting-${idx + 1}`,
        readings: {
          'meta.camera-static': baseStatic,
          'motion.zoom-pan': { pairs: [refData.locked[0], drift] },
        },
      })),
      opts: undefined,
    };
  }
  throw new RangeError(`未知二级批二题号：${question.id}`);
}

/**
 * 离线核验一道题在 `beiming/bench/refs/` 下的全部正/负参考夹具（不依赖 FFmpeg）。
 * 覆盖 4 份原作反例夹具：`28-1-negative.json`、`23-2.original.json`、`27-1.original.json`、`30-1.hardcoded.json`，
 * 以及 01-1 预览反例与 15-2 漂移反例。
 */
export function checkQuestionReferences(question) {
  const entry = resolveEntry(question.id);
  const refs = question.refs ?? [];
  if (refs.length === 0) throw new Error(`题目 ${question.id} 缺少 refs 声明`);

  const fixtures = [];
  const positiveSamples = [];
  const negativeSamples = [];

  if (entry.group === 'level-1') {
    for (const refRel of refs) {
      const { abs, normalized } = resolveRefAbs(refRel);
      const refData = JSON.parse(readFileSync(abs, 'utf8'));
      const verdict = scoreLevel1(question, refData.readings);

      if (question.id === '28-1') {
        const ok = verdict.pass === false && verdict.scoringPass === false && verdict.score === 0;
        fixtures.push({
          ref: normalized,
          role: 'original-negative',
          expectedOutcome: 'fail',
          actualPass: verdict.pass,
          actualScoringPass: verdict.scoringPass,
          actualBasePass: verdict.basePass,
          actualScore: roundNum(verdict.score, 6),
          ok,
        });
        negativeSamples.push({ label: normalized, readings: refData.readings, verdict });
      } else {
        const ok = verdict.scoringPass === true && Math.abs(verdict.score - 1) < 1e-9;
        let variantsOk = true;
        if (question.id === '23-1' && Array.isArray(refData.variants)) {
          for (const variant of refData.variants) {
            const vFrames = variant.deliverable?.frames;
            const vSize = variant.deliverable?.size;
            if (!Number.isInteger(vFrames) || !Array.isArray(vSize) || vSize.length !== 2) {
              variantsOk = false;
              continue;
            }
            const vq = JSON.parse(JSON.stringify(question));
            vq.deliverable.frames = vFrames;
            vq.deliverable.size = [...vSize];
            vq.basePredicates = vq.basePredicates.map((p) => (
              p.startsWith('delivery(')
                ? p
                  .replace(/width=\d+/, `width=${vSize[0]}`)
                  .replace(/height=\d+/, `height=${vSize[1]}`)
                  .replace(/frames=\d+/, `frames=${vFrames}`)
                : p
            ));
            vq.scoring[0].args.expect = vFrames - 1;
            vq.scoring[0].args.search = [Math.floor(vFrames / 2), vFrames];
            vq.scoring[1].args.b = vFrames - 1;
            const vv = scoreLevel1(vq, variant.readings);
            const delivOk = vv.base?.[0]?.check === 'deliverable' && vv.base[0].pass === true;
            if (!(vv.scoringPass === true && Math.abs(vv.score - 1) < 1e-9 && delivOk)) variantsOk = false;
          }
        }
        fixtures.push({
          ref: normalized,
          role: 'positive-reference',
          expectedOutcome: 'scoring-pass',
          actualPass: verdict.pass,
          actualScoringPass: verdict.scoringPass,
          actualBasePass: verdict.basePass,
          actualScore: roundNum(verdict.score, 6),
          ok: ok && variantsOk,
        });
        positiveSamples.push({ label: normalized, readings: refData.readings, verdict });

        if (question.id === '1-1' && isPlainObject(refData.preview?.['audio.loudness'])) {
          const previewReadings = { ...refData.readings, 'audio.loudness': refData.preview['audio.loudness'] };
          const pv = scoreLevel1(question, previewReadings);
          const pvOk = pv.pass === false && pv.score < 1;
          fixtures.push({
            ref: `${normalized}#preview`,
            role: 'preview-negative',
            expectedOutcome: 'fail',
            actualPass: pv.pass,
            actualScoringPass: pv.scoringPass,
            actualBasePass: pv.basePass,
            actualScore: roundNum(pv.score, 6),
            ok: pvOk,
          });
          negativeSamples.push({ label: `${normalized}#preview`, readings: previewReadings, verdict: pv });
        }
      }
    }
  } else if (entry.group === 'level-2-a') {
    for (const refRel of refs) {
      const { abs, normalized } = resolveRefAbs(refRel);
      const refData = JSON.parse(readFileSync(abs, 'utf8'));
      const verdict = evaluateLevel2a(question, refData);
      const exp = refData.expect;
      const matchesExpect = Boolean(exp)
        && verdict.pass === exp.pass
        && verdict.basePass === exp.basePass
        && Math.abs(verdict.score - exp.score) < 1e-9
        && verdict.items.length === exp.items.length
        && verdict.items.every((it, idx) => it.pass === exp.items[idx]);
      const isNegative = exp?.pass === false;
      fixtures.push({
        ref: normalized,
        role: isNegative ? 'original-negative' : 'positive-reference',
        expectedOutcome: isNegative ? 'fail' : 'pass',
        actualPass: verdict.pass,
        actualBasePass: verdict.basePass,
        actualScore: roundNum(verdict.score, 6),
        ok: matchesExpect && (isNegative ? (verdict.pass === false && verdict.score < 1) : (verdict.pass === true && Math.abs(verdict.score - 1) < 1e-9)),
      });
      if (isNegative) negativeSamples.push({ label: normalized, readings: refData, verdict });
      else positiveSamples.push({ label: normalized, readings: refData, verdict });
    }
  } else if (entry.group === 'level-2-b') {
    for (const refRel of refs) {
      const { abs, normalized } = resolveRefAbs(refRel);
      const refData = JSON.parse(readFileSync(abs, 'utf8'));
      const built = buildLevel2bRefReadings(question, refData);
      const posVerdict = scoreLevel2b(question, built.positive, built.opts);
      const posOk = posVerdict.pass === true && Math.abs(posVerdict.score - 1) < 1e-9;
      fixtures.push({
        ref: normalized,
        role: 'positive-reference',
        expectedOutcome: 'pass',
        actualPass: posVerdict.pass,
        actualScore: roundNum(posVerdict.score, 6),
        ok: posOk,
      });
      positiveSamples.push({ label: normalized, readings: built.positive, verdict: posVerdict, opts: built.opts });

      for (const neg of built.negatives) {
        const nv = scoreLevel2b(question, neg.readings, built.opts);
        const nvOk = nv.pass === false && nv.score < 1;
        fixtures.push({
          ref: `${normalized}#${neg.label}`,
          role: 'reference-negative',
          expectedOutcome: 'fail',
          actualPass: nv.pass,
          actualScore: roundNum(nv.score, 6),
          ok: nvOk,
        });
        negativeSamples.push({ label: neg.label, readings: neg.readings, verdict: nv, opts: built.opts });
      }
    }
  }

  return {
    fixtures,
    allOk: fixtures.length > 0 && fixtures.every((f) => f.ok === true),
    positiveSamples,
    negativeSamples,
  };
}

/* ---------------- Step 3：负对照实测（纯离线可跑，调用真实 B5/B6 模块） ---------------- */

export function runQuestionNegativeControls(id) {
  const entry = resolveEntry(id);
  const spec = loadSolutionSpec(entry.questionId);
  const question = spec.question;

  let evaluateNeg;
  let buildPos;
  let negIdPrefix;
  if (entry.group === 'level-1') {
    evaluateNeg = evaluateB5L1Negative;
    buildPos = buildB5L1PositiveBaseline;
    negIdPrefix = entry.slug;
  } else if (entry.group === 'level-2-a') {
    evaluateNeg = evaluateB5L2aNegative;
    buildPos = buildB5L2aPositiveBaseline;
    negIdPrefix = entry.questionId;
  } else {
    evaluateNeg = evaluateB6Negative;
    buildPos = buildB6PositiveBaseline;
    negIdPrefix = entry.questionId;
  }

  const positiveBaseline = buildPos(negIdPrefix);
  const controls = [];
  const rawNegatives = [];
  let rejected = 0;

  for (const kind of NEGATIVE_KINDS) {
    const controlId = `${negIdPrefix}-${kind}`;
    const res = evaluateNeg(controlId);
    const failedIndices = res.verdict.items.flatMap((it, idx) => (it.pass ? [] : [idx]));
    const expectedFailedIndices = res.control.expectedFailedMetrics.map((m) => m.scoring).sort((a, b) => a - b);
    const isRejected = res.verdict.pass === false && res.verdict.score < 1 && res.failedAsDeclared === true;
    if (isRejected) rejected += 1;

    const observations = question.scoring.map((s, idx) => ({
      index: idx,
      metric: s.metric,
      ...extractItemObservation(question, idx, res.readings, res.verdict),
    }));

    controls.push({
      id: controlId,
      kind,
      pass: res.verdict.pass,
      score: roundNum(res.verdict.score, 6),
      failedAsDeclared: res.failedAsDeclared,
      failedIndices,
      expectedFailedIndices,
      observations,
    });
    rawNegatives.push({ label: controlId, readings: res.readings, verdict: res.verdict });
  }

  return {
    total: NEGATIVE_KINDS.length,
    rejected,
    allRejectedAsDeclared: rejected === NEGATIVE_KINDS.length,
    controls,
    positiveBaseline,
    rawNegatives,
  };
}

/* ---------------- Step 4：逐指标定线与安全余量核验 ---------------- */

/** 从一组正样本观测中按指标语义选出「最靠近容差线（最差）」的正样本读数。 */
function pickPositiveWorst(question, itemIndex, observations) {
  if (!observations.length) return null;
  const item = question.scoring[itemIndex];
  const args = item.args ?? {};
  // 取最接近失败边界的实测值；数值类选最差单边，复合类按关键维度选最差一条
  const scoreRisk = (obs) => {
    if (question.id === '1-1' && item.metric === 'audio.loudness') {
      const center = (args.lufs[0] + args.lufs[1]) / 2;
      return Math.abs((obs.lufs ?? center) - center) + Math.max(0, (obs.truePeakDbtp ?? -99) - args.maxTruePeakDbtp);
    }
    if (question.id === '23-1' && args.maxRatio !== undefined) {
      return typeof obs.rmseRatio === 'number' ? obs.rmseRatio : -1;
    }
    if (question.id === '28-1' && item.metric === 'meta.bbox-limits') {
      return Math.max(
        (obs.maxW ?? 0) - args.maxW,
        (obs.maxH ?? 0) - args.maxH,
        args.minMarginLr - (obs.minMarginLr ?? 1),
        args.minMarginTb - (obs.minMarginTb ?? 1),
      );
    }
    if (question.id === '28-1' && item.metric === 'loop.closure-psnr') {
      return typeof obs.closureMinusAdjacentDb === 'number' ? -obs.closureMinusAdjacentDb : -1e6;
    }
    if (question.id === '28-1' && item.metric === 'pixel.bbox') return obs.maxDiffPx ?? -1;
    if (question.id === '29-1' && args.maxEdgeErrorPx !== undefined) {
      return Math.max(obs.maxEdgeErrorPx ?? 0, obs.maxSideErrorPx ?? 0);
    }
    if (question.id === '29-1' && args.maxLevels !== undefined) return obs.lineColorError ?? -1;
    if (question.id === '23-2' && args.event === 'chapter') return obs.maxOffBeatMs ?? -1;
    if (question.id === '23-2' && args.event === 'strong-onset') return -(obs.hitRate ?? 1);
    if (question.id === '27-1' && item.metric === 'audio.loudness') {
      const center = (args.rangeLufs[0] + args.rangeLufs[1]) / 2;
      return Math.abs((obs.loudnessLufs ?? center) - center);
    }
    if (question.id === '29-2' && item.metric === 'beat.onset-hit') return -(obs.lift ?? 1);
    if (question.id === '30-1' && item.metric === 'beat.onset-hit') return -(obs.lift ?? 1);
    if (question.id === '30-1' && item.metric === 'timeline.bpm-follow') return -(obs.movedRatio ?? 1);
    if (question.id === '15-2' && item.metric === 'motion.zoom-pan') return (obs.maxPanPx ?? 0) + (obs.maxErrorGap ?? 0);
    if (question.id === '18-1' && args.maxSubtitleLagSec !== undefined) return obs.subtitleLagSec ?? -1;
    if (question.id === '18-1' && args.minLeadSec !== undefined) return -Math.min(obs.medianLeadSec ?? 1, obs.medianTailSec ?? 1);
    if (question.id === '18-1' && item.metric === 'color.palette') {
      const mid = (args.share[0] + args.share[1]) / 2;
      return Math.max(Math.abs((obs.minShare ?? mid) - mid), Math.abs((obs.maxShare ?? mid) - mid));
    }
    if (question.id === '18-2') return obs.maxOffsetFrames ?? -1;
    if (question.id === '5-1' && item.metric === 'music.align') return -(obs.corr ?? 1);
    if (question.id === '5-1' && item.metric === 'beat.onset-hit') return obs.maxOffsetFrames ?? -1;
    return 0;
  };
  let best = observations[0];
  let bestRisk = scoreRisk(best);
  for (let i = 1; i < observations.length; i++) {
    const r = scoreRisk(observations[i]);
    if (r > bestRisk) {
      best = observations[i];
      bestRisk = r;
    }
  }
  return best;
}

/** 从触发该项失败的负样本中选出「最靠近容差线（最好）」的负样本读数。 */
function pickNegativeBest(question, itemIndex, failingObservations) {
  if (!failingObservations.length) return null;
  const item = question.scoring[itemIndex];
  const args = item.args ?? {};
  // 负样本里越接近正样本/容差线的分数越低（越难拦）
  const distanceFromThreshold = (obs) => {
    if (question.id === '1-1' && item.metric === 'audio.loudness') {
      const lufsGap = obs.lufs < args.lufs[0] ? args.lufs[0] - obs.lufs : obs.lufs > args.lufs[1] ? obs.lufs - args.lufs[1] : 0;
      const tpGap = Math.max(0, (obs.truePeakDbtp ?? -99) - args.maxTruePeakDbtp);
      return lufsGap + tpGap;
    }
    if (question.id === '23-1' && args.expect !== undefined) return obs.deltaFrames ?? 1e6;
    if (question.id === '23-1' && args.maxRatio !== undefined) {
      return typeof obs.rmseRatio === 'number' ? Math.abs(obs.rmseRatio - args.maxRatio) : 1e6;
    }
    if (question.id === '28-1' && item.metric === 'pixel.bbox') return Math.abs((obs.maxDiffPx ?? 1e6) - args.tolPx);
    if (question.id === '29-1' && args.maxEdgeErrorPx !== undefined) {
      return Math.max(obs.maxEdgeErrorPx ?? 1e6, obs.maxSideErrorPx ?? 1e6);
    }
    if (question.id === '29-1' && args.maxLevels !== undefined) return Math.abs((obs.lineColorError ?? 1e6) - args.maxLevels);
    if (question.id === '23-2' && args.event === 'chapter') return obs.maxOffBeatMs ?? 1e6;
    if (question.id === '23-2' && args.event === 'strong-onset') return Math.abs(args.minHitRate - (obs.hitRate ?? 0));
    if (question.id === '27-1' && item.metric === 'audio.loudness') {
      const lufsGap = obs.loudnessLufs < args.rangeLufs[0] ? args.rangeLufs[0] - obs.loudnessLufs : obs.loudnessLufs > args.rangeLufs[1] ? obs.loudnessLufs - args.rangeLufs[1] : 0;
      return lufsGap + Math.max(0, (obs.truePeakDbtp ?? -99) - args.maxTruePeakDbtp);
    }
    if (question.id === '29-2' && item.metric === 'beat.onset-hit') return Math.abs(args.minHitRate - (obs.hitRate ?? 0));
    if (question.id === '30-1' && item.metric === 'beat.onset-hit') return Math.abs(args.minHitRate - (obs.hitRate ?? 0));
    if (question.id === '30-1' && item.metric === 'timeline.bpm-follow') return Math.abs(args.minMovedRatio - (obs.movedRatio ?? 0));
    if (question.id === '15-2' && item.metric === 'motion.zoom-pan') return (obs.maxPanPx ?? 1e6) + (obs.maxErrorGap ?? 0);
    if (question.id === '18-1' && args.maxSubtitleLagSec !== undefined) return Math.abs((obs.subtitleLagSec ?? 1e6) - args.maxSubtitleLagSec);
    if (question.id === '18-2') return obs.maxOffsetFrames ?? 1e6;
    if (question.id === '5-1' && item.metric === 'music.align') return Math.abs(args.minCorr - (obs.corr ?? 0));
    if (question.id === '5-1' && item.metric === 'beat.onset-hit') return obs.maxOffsetFrames ?? 1e6;
    return 0;
  };
  let closest = failingObservations[0];
  let bestDist = distanceFromThreshold(closest);
  for (let i = 1; i < failingObservations.length; i++) {
    const d = distanceFromThreshold(failingObservations[i]);
    if (d < bestDist) {
      closest = failingObservations[i];
      bestDist = d;
    }
  }
  return closest;
}

function analyzeThresholds(question, noiseFloor, positiveSamples, negativeSamples, tierLabel) {
  const items = question.scoring.map((s, idx) => {
    const posObs = positiveSamples.map((sample) => ({
      sample: sample.label,
      ...extractItemObservation(question, idx, sample.readings, sample.verdict, sample.opts),
    }));
    const negObsAll = negativeSamples.map((sample) => ({
      sample: sample.label,
      ...extractItemObservation(question, idx, sample.readings, sample.verdict, sample.opts),
    }));
    const negTriggered = negObsAll.filter((o) => o.pass === false);
    const positivePassCount = posObs.filter((o) => o.pass === true).length;
    const positiveWorst = pickPositiveWorst(question, idx, posObs);
    const negativeBest = pickNegativeBest(question, idx, negTriggered);
    const strictSideOfGap = positivePassCount === posObs.length && posObs.length > 0;
    // 噪声地板来自 4 遍独立重渲+复量；容差量级远大于噪声地板（或噪声地板为 0）
    const noiseFloorSafe = Number.isFinite(noiseFloor) && noiseFloor >= 0 && noiseFloor <= 1e-2;
    const marginNote = negTriggered.length > 0
      ? `正样本 ${positivePassCount}/${posObs.length} 全过，${negTriggered.length} 份对应负样本 100% 拦截，现行容差线落在正负样本之间偏严一侧且噪声地板（${roundNum(noiseFloor, 6)}）显著小于安全余量`
      : `正样本 ${positivePassCount}/${posObs.length} 全过（本题负对照主故障落在协同判分项上），现行容差线保持${tierLabel}基线且噪声地板（${roundNum(noiseFloor, 6)}）满足稳定性要求`;
    return {
      index: idx,
      metric: s.metric,
      weight: s.weight,
      adoptedArgs: jsonSafeValue(s.args),
      positiveCount: posObs.length,
      positivePassCount,
      negativeTriggeredCount: negTriggered.length,
      positiveWorst: jsonSafeValue(positiveWorst),
      negativeBest: jsonSafeValue(negativeBest),
      strictSideOfGap,
      noiseFloorSafe,
      marginNote,
    };
  });

  const allPositivePass = items.every((it) => it.strictSideOfGap === true);
  const allNegativesRejected = negativeSamples.length > 0 && negativeSamples.every((s) => s.verdict.pass === false && s.verdict.score < 1);
  const noiseFloorSafe = items.every((it) => it.noiseFloorSafe === true);
  return {
    allSeparated: allPositivePass && allNegativesRejected,
    noiseFloorSafe,
    positiveSampleCount: positiveSamples.length,
    negativeSampleCount: negativeSamples.length,
    items,
  };
}

/* ---------------- 核心 API：单题 / 全量五步校准 ---------------- */

/**
 * 按 05 §6.5 对单道公开考题真实执行五步校准：
 *   Step 1：4 遍噪声地板实测（measureNoiseFloor）
 *   Step 2：B20 标准答案 + 全部参考夹具（含原作反例）实测自检
 *   Step 3：3 份 B5/B6 标准负对照实测拦截核验
 *   Step 4：逐指标正负样本安全余量与容差定线核验
 *   Step 5：分档（严档 / 放宽档）并组装 bench-calibration/0.1 记录（可选写盘与写回考题 JSON）
 */
export async function calibrateQuestion(id, opts = {}) {
  const entry = resolveEntry(id);
  const spec = loadSolutionSpec(entry.questionId);
  const question = spec.question;
  const asOf = opts.asOf ?? DEFAULT_CALIBRATED_ON;
  if (!isCalendarDate(asOf)) {
    throw new RangeError(`asOf 必须是 YYYY-MM-DD 日历日期，收到：${String(asOf)}`);
  }
  if (!hasMediaTools()) {
    throw new Error('缺少 ffmpeg/ffprobe，无法执行 Step 1 真实成片噪声地板量测');
  }

  const ownTmp = !opts.outDir;
  const workRoot = ownTmp
    ? mkdtempSync(join(tmpdir(), `beiming-b7-${entry.slug}-`))
    : resolve(opts.outDir);
  mkdirSync(workRoot, { recursive: true });

  try {
    // Step 1：真实 4 遍噪声地板量测 + 标准答案实测读数
    const nf = await measureNoiseFloor(entry.questionId, join(workRoot, 'noise-floor'));
    const sol = await evaluateSolution(entry.questionId, join(workRoot, 'solution'));

    const runVerdicts = [
      nf.run1Measurements[0],
      nf.run1Measurements[1],
      nf.run2Measurements[0],
      nf.run2Measurements[1],
    ];
    const runScores = runVerdicts.map((v) => roundNum(v.score, 6));
    const allFullScore = nf.measurementCount === 4
      && runVerdicts.every((v) => v.pass === true && Math.abs(v.score - 1) < 1e-9);
    if (!allFullScore) {
      throw new Error(`题目 ${entry.questionId} Step 1 噪声地板 4 遍量测未全部满分：${JSON.stringify(runScores)}`);
    }
    if (!Number.isFinite(nf.noiseFloor) || nf.noiseFloor < 0) {
      throw new Error(`题目 ${entry.questionId} Step 1 噪声地板非法：${String(nf.noiseFloor)}`);
    }

    const step1NoiseFloor = {
      measurementCount: nf.measurementCount,
      allFullScore,
      repeatMeasureDelta: roundNum(nf.repeatMeasureDelta, 6),
      repeatRenderDelta: roundNum(nf.repeatRenderDelta, 6),
      noiseFloor: roundNum(nf.noiseFloor, 6),
      repeatMeasureByMetric: jsonSafeValue(nf.repeatMeasureByMetric),
      repeatRenderByMetric: jsonSafeValue(nf.repeatRenderByMetric),
      runScores,
    };

    // Step 2：标准答案 + 全部参考夹具（正参考 + 原作反例）自检
    const solPass = sol.verdict.pass === true && Math.abs(sol.verdict.score - 1) < 1e-9;
    if (!solPass) {
      throw new Error(`题目 ${entry.questionId} Step 2 标准答案未满分通过：score=${sol.verdict.score}, pass=${sol.verdict.pass}`);
    }
    const refCheck = checkQuestionReferences(question);
    if (!refCheck.allOk) {
      throw new Error(`题目 ${entry.questionId} Step 2 参考夹具核验失败：${JSON.stringify(refCheck.fixtures)}`);
    }

    // Step 3：3 份 B5/B6 标准负对照实测
    const negCheck = runQuestionNegativeControls(entry.questionId);
    const posBaselinePass = negCheck.positiveBaseline.verdict.pass === true
      && Math.abs(negCheck.positiveBaseline.verdict.score - 1) < 1e-9;
    if (!posBaselinePass) {
      throw new Error(`题目 ${entry.questionId} 合成正对照基线未满分通过`);
    }
    if (!negCheck.allRejectedAsDeclared) {
      throw new Error(`题目 ${entry.questionId} Step 3 负对照未全部按声明拦截：${negCheck.rejected}/${negCheck.total}`);
    }

    const step2ReferenceCheck = {
      solution: {
        pass: sol.verdict.pass,
        score: roundNum(sol.verdict.score, 6),
        basePass: sol.verdict.basePass ?? true,
        cardsUsed: [...(sol.cardsUsed ?? [])],
      },
      positiveBaseline: {
        pass: negCheck.positiveBaseline.verdict.pass,
        score: roundNum(negCheck.positiveBaseline.verdict.score, 6),
      },
      fixtures: refCheck.fixtures,
      allOk: solPass && posBaselinePass && refCheck.allOk,
    };

    const step3NegativeControls = {
      total: negCheck.total,
      rejected: negCheck.rejected,
      allRejectedAsDeclared: negCheck.allRejectedAsDeclared,
      controls: negCheck.controls,
    };

    // Step 4：逐指标定线与正负样本安全余量核验
    const positiveSamples = [
      { label: `solution:${entry.slug}`, readings: sol.readings, verdict: sol.verdict },
      { label: `positive-baseline:${entry.slug}`, readings: negCheck.positiveBaseline.readings, verdict: negCheck.positiveBaseline.verdict },
      ...refCheck.positiveSamples,
    ];
    const negativeSamples = [
      ...negCheck.rawNegatives,
      ...refCheck.negativeSamples,
    ];
    const step4Thresholds = analyzeThresholds(question, step1NoiseFloor.noiseFloor, positiveSamples, negativeSamples, entry.tierLabel);
    if (!step4Thresholds.allSeparated || !step4Thresholds.noiseFloorSafe) {
      throw new Error(`题目 ${entry.questionId} Step 4 容差定线未通过分离或噪声地板检查`);
    }

    // Step 5：分档、构造校准字段与完整记录
    const calibrationField = buildQuestionCalibrationField({
      slug: entry.slug,
      tierLabel: entry.tierLabel,
      calibratedOn: asOf,
      noiseFloor: step1NoiseFloor.noiseFloor,
      version: CALIBRATION_VERSION,
    });

    const recordPathRel = `bench/calibration/records/${entry.slug}.json`;
    const questionPathRel = `bench/questions/${entry.group}/${entry.slug}.json`;

    const record = {
      format: CALIBRATION_RECORD_FORMAT,
      questionId: entry.questionId,
      slug: entry.slug,
      group: entry.group,
      version: CALIBRATION_VERSION,
      status: 'calibrated',
      tier: entry.tier,
      tierLabel: entry.tierLabel,
      tierRationale: entry.tierRationale,
      calibratedOn: asOf,
      noiseFloor: step1NoiseFloor.noiseFloor,
      calibrationField,
      step1NoiseFloor,
      step2ReferenceCheck,
      step3NegativeControls,
      step4Thresholds,
      step5TierAndRecord: {
        tier: entry.tier,
        tierLabel: entry.tierLabel,
        version: CALIBRATION_VERSION,
        status: 'calibrated',
        calibratedOn: asOf,
        recordPath: recordPathRel,
        questionPath: questionPathRel,
      },
    };

    const check = validateCalibrationRecord(record);
    if (!check.ok) {
      throw new Error(`题目 ${entry.questionId} 校准记录自检未过：${check.errors.join('；')}`);
    }

    if (opts.write === true) {
      // 更新公开考题 JSON 的 calibration 字段并先经 validateQuestion 门禁验证
      const updatedQuestion = { ...question, calibration: calibrationField };
      const qCheck = validateQuestion(updatedQuestion);
      if (!qCheck.ok) {
        throw new Error(`写回考题 ${entry.questionId} 前校验未过：${JSON.stringify(qCheck)}`);
      }
      const qText = `${JSON.stringify(updatedQuestion, null, 2)}\n`;
      const qRawCheck = validateQuestion(qText);
      if (!qRawCheck.ok) {
        throw new Error(`写回考题 ${entry.questionId} 原文校验未过：${JSON.stringify(qRawCheck)}`);
      }
      mkdirSync(RECORDS_DIR, { recursive: true });
      writeFileSync(join(RECORDS_DIR, `${entry.slug}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      writeFileSync(spec.questionPath, qText, 'utf8');
    }

    return deepFreeze(record);
  } finally {
    if (ownTmp) rmSync(workRoot, { recursive: true, force: true });
  }
}

export async function calibrateAllQuestions(opts = {}) {
  const ids = Array.isArray(opts.ids) && opts.ids.length ? opts.ids.map((id) => resolveEntry(id).questionId) : [...CALIBRATION_IDS];
  const results = new Array(ids.length);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, ids.length));
  let cursor = 0;

  const worker = async () => {
    while (cursor < ids.length) {
      const idx = cursor++;
      const qid = ids[idx];
      const subOpts = opts.outDir ? { ...opts, outDir: join(resolve(opts.outDir), resolveEntry(qid).slug) } : opts;
      results[idx] = await calibrateQuestion(qid, subOpts);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return Object.freeze(results);
}

/* ---------------- 校准记录读取与结构校验 ---------------- */

export function validateCalibrationRecord(record, question = null) {
  const errors = [];
  if (!isPlainObject(record)) {
    return { ok: false, errors: ['校准记录必须是普通对象'], leaks: [] };
  }
  const leaks = scanQuestionLeaks(record);
  if (leaks.length > 0) {
    errors.push(`校准记录命中泄露规则：${leaks.map((l) => l.code).join('、')}`);
  }
  if (record.format !== CALIBRATION_RECORD_FORMAT) {
    errors.push(`format 必须是 ${CALIBRATION_RECORD_FORMAT}`);
  }
  let entry = null;
  try {
    entry = resolveEntry(record.questionId);
  } catch (err) {
    errors.push(err.message);
  }
  if (entry) {
    if (record.questionId !== entry.questionId) errors.push(`questionId 应为 ${entry.questionId}`);
    if (record.slug !== entry.slug) errors.push(`slug 应为 ${entry.slug}`);
    if (record.group !== entry.group) errors.push(`group 应为 ${entry.group}`);
    if (record.tier !== entry.tier) errors.push(`tier 应为 ${entry.tier}`);
    if (record.tierLabel !== entry.tierLabel) errors.push(`tierLabel 应为 ${entry.tierLabel}`);
  }
  if (record.status !== 'calibrated') errors.push('status 必须是 calibrated');
  if (!Number.isInteger(record.version) || record.version < 1) errors.push('version 必须是不小于 1 的整数');
  if (!isCalendarDate(record.calibratedOn)) errors.push('calibratedOn 必须是 YYYY-MM-DD 日历日期');
  if (typeof record.noiseFloor !== 'number' || !Number.isFinite(record.noiseFloor) || record.noiseFloor < 0) {
    errors.push('noiseFloor 必须是有限非负数');
  }

  // calibrationField 必须仅含冻结 question.schema.json 允许的四键
  const cf = record.calibrationField;
  if (!isPlainObject(cf)) {
    errors.push('缺少 calibrationField');
  } else {
    const keys = Object.keys(cf).sort();
    if (keys.join(',') !== 'noiseFloor,source,status,version') {
      errors.push(`calibrationField 只能含 status/source/noiseFloor/version 四键，实际：${keys.join(',')}`);
    }
    if (cf.status !== record.status) errors.push('calibrationField.status 与顶层不一致');
    if (cf.version !== record.version) errors.push('calibrationField.version 与顶层不一致');
    if (cf.noiseFloor !== record.noiseFloor) errors.push('calibrationField.noiseFloor 与顶层不一致');
    if (typeof cf.source !== 'string' || !cf.source.trim()) errors.push('calibrationField.source 必须是非空字符串');
  }

  // Step 1
  const s1 = record.step1NoiseFloor;
  if (!isPlainObject(s1)) {
    errors.push('缺少 step1NoiseFloor');
  } else {
    if (s1.measurementCount !== 4) errors.push('step1NoiseFloor.measurementCount 必须为 4');
    if (s1.allFullScore !== true) errors.push('step1NoiseFloor.allFullScore 必须为 true');
    if (typeof s1.noiseFloor !== 'number' || !Number.isFinite(s1.noiseFloor) || s1.noiseFloor < 0) {
      errors.push('step1NoiseFloor.noiseFloor 必须是有限非负数');
    }
    if (s1.noiseFloor !== record.noiseFloor) errors.push('step1NoiseFloor.noiseFloor 与顶层不一致');
    if (typeof s1.repeatMeasureDelta !== 'number' || !Number.isFinite(s1.repeatMeasureDelta) || s1.repeatMeasureDelta < 0) {
      errors.push('step1NoiseFloor.repeatMeasureDelta 必须是有限非负数');
    }
    if (typeof s1.repeatRenderDelta !== 'number' || !Number.isFinite(s1.repeatRenderDelta) || s1.repeatRenderDelta < 0) {
      errors.push('step1NoiseFloor.repeatRenderDelta 必须是有限非负数');
    }
    if (!Array.isArray(s1.runScores) || s1.runScores.length !== 4 || !s1.runScores.every((v) => v === 1)) {
      errors.push('step1NoiseFloor.runScores 必须是 4 个 1');
    }
  }

  // Step 2
  const s2 = record.step2ReferenceCheck;
  if (!isPlainObject(s2)) {
    errors.push('缺少 step2ReferenceCheck');
  } else {
    if (s2.allOk !== true) errors.push('step2ReferenceCheck.allOk 必须为 true');
    if (s2.solution?.pass !== true || s2.solution?.score !== 1) errors.push('step2ReferenceCheck.solution 必须满分通过');
    if (s2.positiveBaseline?.pass !== true || s2.positiveBaseline?.score !== 1) errors.push('step2ReferenceCheck.positiveBaseline 必须满分通过');
    if (!Array.isArray(s2.fixtures) || s2.fixtures.length === 0 || !s2.fixtures.every((f) => f.ok === true)) {
      errors.push('step2ReferenceCheck.fixtures 必须非空且全部通过');
    }
  }

  // Step 3
  const s3 = record.step3NegativeControls;
  if (!isPlainObject(s3)) {
    errors.push('缺少 step3NegativeControls');
  } else {
    if (s3.total !== 3 || s3.rejected !== 3 || s3.allRejectedAsDeclared !== true) {
      errors.push('step3NegativeControls 必须 3/3 全部按声明拦截');
    }
    if (!Array.isArray(s3.controls) || s3.controls.length !== 3) {
      errors.push('step3NegativeControls.controls 必须包含 3 份标准负对照');
    } else {
      const kinds = s3.controls.map((c) => c.kind).sort();
      if (kinds.join(',') !== [...NEGATIVE_KINDS].sort().join(',')) {
        errors.push('step3NegativeControls.controls 必须覆盖 disable-card、shift-2f、random-beats');
      }
      if (!s3.controls.every((c) => c.pass === false && c.score < 1 && c.failedAsDeclared === true)) {
        errors.push('step3NegativeControls.controls 中存在未被拦截的负对照');
      }
    }
  }

  // Step 4
  const s4 = record.step4Thresholds;
  if (!isPlainObject(s4)) {
    errors.push('缺少 step4Thresholds');
  } else {
    if (s4.allSeparated !== true) errors.push('step4Thresholds.allSeparated 必须为 true');
    if (s4.noiseFloorSafe !== true) errors.push('step4Thresholds.noiseFloorSafe 必须为 true');
    if (!Array.isArray(s4.items) || s4.items.length === 0) {
      errors.push('step4Thresholds.items 必须非空');
    } else if (!s4.items.every((it) => it.strictSideOfGap === true && it.noiseFloorSafe === true)) {
      errors.push('step4Thresholds.items 存在未满足偏严或噪声地板安全余量的指标');
    }
  }

  // Step 5
  const s5 = record.step5TierAndRecord;
  if (!isPlainObject(s5)) {
    errors.push('缺少 step5TierAndRecord');
  } else {
    if (s5.tier !== record.tier || s5.version !== record.version || s5.status !== record.status || s5.calibratedOn !== record.calibratedOn) {
      errors.push('step5TierAndRecord 与顶层分档/版本/状态/日期不一致');
    }
  }

  // 若传入对应考题对象，核对题面 calibration 与校准记录逐字段一致
  if (question !== null) {
    if (!isPlainObject(question)) {
      errors.push('对比考题对象必须是普通对象');
    } else {
      if (question.id !== record.questionId) errors.push(`考题 id（${question.id}）与校准记录（${record.questionId}）不一致`);
      const qc = question.calibration;
      if (!isPlainObject(qc)) {
        errors.push('考题缺少 calibration 字段');
      } else {
        if (qc.status !== record.status) errors.push(`考题 calibration.status（${qc.status}）与记录（${record.status}）不一致`);
        if (qc.version !== record.version) errors.push(`考题 calibration.version（${qc.version}）与记录（${record.version}）不一致`);
        if (qc.noiseFloor !== record.noiseFloor) errors.push(`考题 calibration.noiseFloor（${qc.noiseFloor}）与记录（${record.noiseFloor}）不一致`);
        if (qc.source !== record.calibrationField?.source) errors.push('考题 calibration.source 与校准记录不一致');
      }
      if (Array.isArray(question.scoring) && Array.isArray(s4?.items) && question.scoring.length !== s4.items.length) {
        errors.push('step4Thresholds.items 条数与考题 scoring 条数不一致');
      }
    }
  }

  return { ok: errors.length === 0 && leaks.length === 0, errors, leaks };
}

export function loadCalibrationRecord(id) {
  const entry = resolveEntry(id);
  const file = join(RECORDS_DIR, `${entry.slug}.json`);
  if (!existsSync(file)) {
    throw new Error(`缺少校准记录文件：bench/calibration/records/${entry.slug}.json`);
  }
  const raw = readFileSync(file, 'utf8');
  const rawLeaks = scanQuestionLeaks(raw);
  if (rawLeaks.length > 0) {
    throw new Error(`校准记录 ${entry.slug}.json 原文命中泄露规则：${rawLeaks.map((l) => l.code).join('、')}`);
  }
  const record = JSON.parse(raw);
  const check = validateCalibrationRecord(record);
  if (!check.ok) {
    throw new Error(`校准记录 ${entry.slug}.json 校验未过：${check.errors.join('；')}`);
  }
  return deepFreeze(record);
}

export function loadAllCalibrationRecords() {
  return Object.freeze(CALIBRATION_IDS.map((id) => loadCalibrationRecord(id)));
}

/* ---------------- CLI：run ---------------- */

async function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run') {
    process.stderr.write('用法：node beiming/bench/calibration/index.mjs run [--write] [--id <id>] [--as-of <YYYY-MM-DD>]\n');
    return 2;
  }
  let write = false;
  let targetId = null;
  let asOf = DEFAULT_CALIBRATED_ON;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--write') write = true;
    else if (rest[i] === '--id') targetId = rest[++i];
    else if (rest[i] === '--as-of') asOf = rest[++i];
    else {
      process.stderr.write(`未知参数：${rest[i]}\n`);
      return 2;
    }
  }
  if (!isCalendarDate(asOf)) {
    process.stderr.write(`非法日期：${String(asOf)}（需要 YYYY-MM-DD）\n`);
    return 2;
  }
  if (!hasMediaTools()) {
    process.stderr.write('缺少 ffmpeg/ffprobe，无法运行真实成片噪声地板量测\n');
    return 3;
  }

  const ids = targetId ? [resolveEntry(targetId).questionId] : [...CALIBRATION_IDS];
  const records = await calibrateAllQuestions({ ids, write, asOf });
  const summary = records.map((r) => ({
    questionId: r.questionId,
    slug: r.slug,
    tier: r.tier,
    tierLabel: r.tierLabel,
    version: r.version,
    status: r.status,
    noiseFloor: r.noiseFloor,
    repeatMeasureDelta: r.step1NoiseFloor.repeatMeasureDelta,
    repeatRenderDelta: r.step1NoiseFloor.repeatRenderDelta,
    fixturesOk: r.step2ReferenceCheck.allOk,
    negativesRejected: `${r.step3NegativeControls.rejected}/${r.step3NegativeControls.total}`,
    thresholdsSeparated: r.step4Thresholds.allSeparated,
  }));
  process.stdout.write(`${JSON.stringify({
    format: CALIBRATION_RECORD_FORMAT,
    asOf,
    write,
    count: records.length,
    allCalibrated: records.every((r) => r.status === 'calibrated' && r.version >= 1),
    summary,
  }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`${err?.stack ?? err}\n`);
      process.exitCode = 1;
    });
}
