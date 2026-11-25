#!/usr/bin/env node
// 北冥考题库离线核验与基准考试入口：
// 扫描并校验 beiming/bench/questions/ 下全部公开考题、参考读数夹具与公开投影，
// 并通过 beiming/bench/runner.mjs (runExamQuestion) 跑通离线基准做题与正负对照判分核验。
// 题库缺失、为空、题目/夹具不合规、全跳过无实跑或任一题正负对照未通过时均以非 0 退出码失败，绝不假绿。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  checkAssertion,
  evaluateAssertion,
  parseFps,
  scopeRange,
} from '../verify/predicates.mjs';
import {
  B6_NEGATIVE_KINDS,
  B6_QUESTION_IDS,
  buildPositiveBaseline,
  evaluateNegativeControl,
} from './negatives/level-2-b/run-b6.mjs';
import {
  argsOf as argsOfB2,
  readClosure,
  readFraming,
  readLayout,
  readNearest,
  readPixelBoxes,
  score as scoreLevel1,
} from './questions/level-1/evaluate-b2.mjs';
import { evaluate as evaluateLevel2a } from './questions/level-2-a/evaluate-b3.mjs';
import { score as scoreLevel2b } from './questions/level-2-b/evaluate-b4.mjs';
import { scoreLevel3, validLevel3Reading } from './questions/level-3/evaluate-b17.mjs';
import { runLevel3Controls } from './solutions/level-3/run-b17.mjs';
import { RESULT_FORMAT, runExamQuestion } from './runner.mjs';
import {
  projectPublicQuestion,
  scanQuestionLeaks,
  validateQuestion,
} from './validate-question.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
export const EXAM_REPORT_FORMAT = 'bench-exam-report/0.1';

const HELP = `北冥考题库离线考试核验入口

用法：node beiming/bench/exam.mjs [--out <目录>] [--json] [--dry-run] [--questions <题库目录>] [--help]

选项：
  --out <目录>        输出结构化考试报告的目录（默认 out/exam）
  --json              标准输出打印 JSON 报告
  --dry-run           仅执行题库、参考夹具与公开投影契约校验，不跑离线基准考试
  --questions <目录>  指定题库根目录（默认 beiming/bench/questions）
  --help, -h          打印本帮助信息

退出码：0 全部通过；1 离线考试未通过、负对照失守或全跳过无实跑；2 命令行参数错误；4 题库为空/缺题集或题目/夹具契约校验不通过`;

const LEVEL1_IDS = new Set(['29-1', '28-1', '23-1', '1-1']);
const LEVEL2A_IDS = new Set(['27-1', '29-2', '23-2', '30-1']);
const LEVEL2B_IDS = new Set(B6_QUESTION_IDS);
const LEVEL3_IDS = new Set(['3-1', '31-1', '1-2']);
const REQUIRED_QUESTION_SETS = Object.freeze([
  Object.freeze({ name: 'level-3', evaluator: 'evaluate-b17.mjs', ids: Object.freeze([...LEVEL3_IDS]) }),
  Object.freeze({ name: 'level-1', evaluator: 'evaluate-b2.mjs', ids: Object.freeze([...LEVEL1_IDS]) }),
  Object.freeze({ name: 'level-2-a', evaluator: 'evaluate-b3.mjs', ids: Object.freeze([...LEVEL2A_IDS]) }),
  Object.freeze({ name: 'level-2-b', evaluator: 'evaluate-b4.mjs', ids: Object.freeze([...LEVEL2B_IDS]) }),
]);
const CHANNELS = { none: 0, mono: 1, stereo: 2 };
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isFiniteArray = (v, minLen = 1) => Array.isArray(v) && v.length >= minLen && v.every(isFiniteNum);
const isIntPair = (v) => Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]);
const canonicalPath = (p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};

/** 递归收集目录下全部 .json 题目文件（按相对 POSIX 路径排序） */
export function discoverQuestionFiles(questionsDir) {
  if (typeof questionsDir !== 'string' || !questionsDir || !fs.existsSync(questionsDir)) return [];
  let st;
  try { st = fs.statSync(questionsDir); } catch { return []; }
  if (!st.isDirectory()) return [];
  const found = [];
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(abs);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(abs);
    }
  };
  walkDir(questionsDir);
  return found.sort((a, b) => {
    const ra = path.relative(questionsDir, a).split(path.sep).join('/');
    const rb = path.relative(questionsDir, b).split(path.sep).join('/');
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

function findEmptyQuestionSubdirs(questionsDir) {
  if (typeof questionsDir !== 'string' || !questionsDir || !fs.existsSync(questionsDir)) return [];
  let st;
  try { st = fs.statSync(questionsDir); } catch { return []; }
  if (!st.isDirectory()) return [];
  const empty = [];
  const walk = (dir) => {
    let hasJson = false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(abs)) hasJson = true;
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        hasJson = true;
      }
    }
    if (dir !== questionsDir && !hasJson) {
      empty.push(path.relative(questionsDir, dir).split(path.sep).join('/'));
    }
    return hasJson;
  };
  walk(questionsDir);
  return empty.sort();
}

const isDirPath = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};
const isFilePath = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

function checkRequiredQuestionSets({ questionsDir, entries, enforceBuiltinSets }) {
  const errors = [];
  const emptySubdirs = findEmptyQuestionSubdirs(questionsDir);
  const checkedSets = new Set();

  if (enforceBuiltinSets) {
    for (const set of REQUIRED_QUESTION_SETS) {
      checkedSets.add(set.name);
      const setDir = path.join(questionsDir, set.name);
      if (!isDirPath(setDir)) {
        errors.push(`缺少内置题集目录：${set.name}`);
        continue;
      }
      const evalFile = path.join(setDir, set.evaluator);
      if (!isFilePath(evalFile)) {
        errors.push(`内置题集 ${set.name} 缺少评分器：${set.evaluator}`);
      }
      const setEntries = entries.filter((e) => e.file.startsWith(`${set.name}/`));
      if (setEntries.length === 0) {
        errors.push(`内置题集 ${set.name} 为空（缺少全部 ${set.ids.length} 道题目：${set.ids.join('、')}）`);
        continue;
      }
      const presentIds = new Set(setEntries.map((e) => e.id).filter(Boolean));
      const missingIds = set.ids.filter((id) => !presentIds.has(id));
      if (missingIds.length > 0) {
        errors.push(`内置题集 ${set.name} 缺少必需题目：${missingIds.join('、')}`);
      }
    }
  }

  for (const relSub of emptySubdirs) {
    if (!checkedSets.has(relSub)) {
      errors.push(`题集子目录为空：${relSub}`);
    }
  }
  return errors;
}

function hasValidBaseSpec(spec) {
  return isPlainObj(spec)
    && ['width', 'height', 'fps', 'frames', 'audioChannels'].every((k) => isFiniteNum(spec[k]));
}

function sameDeliverableSpec(spec, deliverable) {
  if (!hasValidBaseSpec(spec) || !isPlainObj(deliverable)) return false;
  const rate = parseFps(deliverable.fps);
  if (!rate || !Array.isArray(deliverable.size) || deliverable.size.length !== 2) return false;
  const expectedFps = Number(rate.num) / Number(rate.den);
  return spec.width === deliverable.size[0]
    && spec.height === deliverable.size[1]
    && Math.abs(spec.fps - expectedFps) < 1e-9
    && spec.frames === deliverable.frames
    && Object.hasOwn(CHANNELS, deliverable.audio)
    && spec.audioChannels === CHANNELS[deliverable.audio];
}

function dropComparisonUnit(text) {
  const masked = text.replace(/"[^"]*"/g, (quoted) => `"${'_'.repeat(quoted.length - 2)}"`);
  const hit = /((?:>=|<=)\s*-?\d+(?:\.\d+)?|\bin\s*\[[^\][]*\])\s*(?:deg|mm|f|s)(?=\s*(?:@|$))/.exec(masked);
  return hit ? text.slice(0, hit.index + hit[1].length) + text.slice(hit.index + hit[0].length) : text;
}

function cmpHolds(value, cmp) {
  if (!cmp || !isFiniteNum(value)) return false;
  if (cmp.op === '>=') return value >= cmp.value;
  if (cmp.op === '<=') return value <= cmp.value;
  if (cmp.op === 'in') return value >= cmp.lo && value <= cmp.hi;
  return false;
}

/**
 * 基于真实量测证据逐条如实求值基础谓词（绝不按题面盲填 pass）：
 * - 已上线谓词（since: 0.1）直接交 verify/predicates.mjs 的 evaluateAssertion；
 * - planned 谓词（bbox_w / bbox_h / margin_lr / margin_tb / orbit_total / onset）
 *   从实际量测的逐帧包围盒、相机环绕角、音频起声帧号如实比对；
 * - 任何缺失证据、未支持谓词或互斥条件均如实返回 'fail'。
 */
function evaluateBasePredicate(text, film, measured) {
  const stripped = dropComparisonUnit(text);
  const checked = checkAssertion(stripped);
  if (checked.ok) {
    return evaluateAssertion(stripped, film, measured).status === 'pass' ? 'pass' : 'fail';
  }
  const onlyPlanned = Boolean(checked.assertion)
    && checked.errors.length > 0
    && checked.errors.every((e) => e.evidence === 'predicate.planned');
  if (!onlyPlanned) return 'fail';

  const a = checked.assertion;
  const bound = checked.bound;
  const range = scopeRange(a.scope, film);
  if (!range) return 'fail';

  if (a.name === 'bbox_w' || a.name === 'bbox_h' || a.name === 'margin_lr' || a.name === 'margin_tb') {
    const entityName = bound.entity?.kind === 'ident' ? bound.entity.name : null;
    if (!entityName || !a.cmp || !Array.isArray(measured?.frames)) return 'fail';
    const inRange = measured.frames.filter(
      (f) => Number.isInteger(f?.frame) && f.frame >= range[0] && f.frame < range[1],
    );
    if (inRange.length === 0) return 'fail';
    for (const f of inRange) {
      const size = f.meta?.size;
      if (!Array.isArray(size) || size.length !== 2 || !(size[0] > 0) || !(size[1] > 0)) return 'fail';
      const ent = Array.isArray(f.meta?.entities)
        ? f.meta.entities.find((e) => e?.name === entityName)
        : null;
      const box = ent?.bbox2d;
      if (!Array.isArray(box) || box.length !== 4 || !box.every(isFiniteNum)) return 'fail';
      const [x0, y0, x1, y1] = box;
      const [w, h] = size;
      let val;
      if (a.name === 'bbox_w') val = (x1 - x0) / w;
      else if (a.name === 'bbox_h') val = (y1 - y0) / h;
      else if (a.name === 'margin_lr') val = Math.min(x0, w - x1) / w;
      else val = Math.min(y0, h - y1) / h;
      if (!cmpHolds(val, a.cmp)) return 'fail';
    }
    return 'pass';
  }

  if (a.name === 'orbit_total') {
    const cam = bound.camera?.kind === 'ident' ? bound.camera.name : null;
    const subj = bound.subject?.kind === 'ident' ? bound.subject.name : null;
    if (!cam || !subj || !a.cmp) return 'fail';
    const key = `${cam}:${subj}`;
    const filmFrames = Number.isInteger(film?.output?.frames) ? film.output.frames : 0;
    const coversWholeFilm = a.scope.kind === 'all'
      || (filmFrames > 0 && range[0] === 0 && range[1] === filmFrames);
    if (coversWholeFilm) {
      if (!isPlainObj(measured?.orbitTotalDeg) || !Object.hasOwn(measured.orbitTotalDeg, key)) return 'fail';
      return cmpHolds(measured.orbitTotalDeg[key], a.cmp) ? 'pass' : 'fail';
    }
    const series = isPlainObj(measured?.orbitAnglesDeg) && Object.hasOwn(measured.orbitAnglesDeg, key)
      ? measured.orbitAnglesDeg[key]
      : null;
    if (!Array.isArray(series)) return 'fail';
    const inRange = series
      .filter((s) => Number.isInteger(s?.frame) && isFiniteNum(s?.deg) && s.frame >= range[0] && s.frame < range[1])
      .sort((x, y) => x.frame - y.frame);
    if (inRange.length === 0) return 'fail';
    let spanDeg = 0;
    for (let i = 1; i < inRange.length; i++) {
      spanDeg += Math.abs(inRange[i].deg - inRange[i - 1].deg);
    }
    return cmpHolds(spanDeg, a.cmp) ? 'pass' : 'fail';
  }

  if (a.name === 'onset') {
    const audioRef = bound.audio?.kind === 'ident' ? bound.audio.name : null;
    const evId = bound.event?.kind === 'ref' && bound.event.ref === 'event' ? bound.event.id : null;
    if (audioRef !== 'audio' || !evId || !isPlainObj(measured?.audioOnsets)) return 'fail';
    if (!Object.hasOwn(measured.audioOnsets, evId)) return 'fail';
    const frame = measured.audioOnsets[evId];
    return isFiniteNum(frame) && frame >= range[0] && frame < range[1] ? 'pass' : 'fail';
  }

  return 'fail';
}

function evaluateBasePredicates(question, film, measured) {
  return Object.fromEntries(
    (question.basePredicates ?? []).map((text) => [text, evaluateBasePredicate(text, film, measured)]),
  );
}

/* ---------------- 参考夹具结构与内容校验 ---------------- */

function validateRefData(question, data, refLabel) {
  const errors = [];
  const bad = (msg) => errors.push(`参考文件校验失败（${refLabel}）：${msg}`);
  if (!isPlainObj(data) || Object.keys(data).length === 0) {
    bad('必须是非空 JSON 对象');
    return errors;
  }
  if (typeof data.question !== 'string' || data.question !== question.id) {
    bad(`题号字段 question=${JSON.stringify(data.question)} 与题目 ${question.id} 不匹配`);
    return errors;
  }

  if (LEVEL3_IDS.has(question.id)) {
    if (data.kind !== 'reference' || !validLevel3Reading(question, data.readings)) bad('三级题缺少完整的逐帧参考量测');
    return errors;
  }

  const hasMotionEntries = (list, minLen) => Array.isArray(list)
    && list.length >= minLen
    && list.every((item) => isPlainObj(item)
      && ['scale', 'dx', 'dy', 'error', 'stillError'].every((k) => isFiniteNum(item[k])));

  if (LEVEL1_IDS.has(question.id)) {
    const expectedKind = question.id === '28-1' ? 'negative' : 'reference';
    if (data.kind !== expectedKind) bad(`kind 应为 ${expectedKind}，实际为 ${JSON.stringify(data.kind)}`);
    if (typeof data.source !== 'string' || !data.source.trim()) bad('缺少非空 source 说明');
    if (!isPlainObj(data.readings) || Object.keys(data.readings).length === 0) {
      bad('缺少非空 readings 量测对象');
      return errors;
    }
    if (!hasValidBaseSpec(data.readings.base?.spec)) bad('缺少合法的 readings.base.spec 规格读数');

    if (question.id === '29-1') {
      const le = data.readings['layout.edges'];
      const bandsOk = Array.isArray(le?.bands) && le.bands.length >= 1
        && le.bands.every((b) => isIntPair(b) && b[0] < b[1]);
      if (!isPlainObj(le) || !bandsOk
        || !isFiniteArray(le.edgeErrorsPx, 2 * le.bands.length)
        || !isFiniteArray(le.sideErrorsPx, 2 * le.bands.length)
        || !isFiniteNum(le.lineColorError) || le.lineColorError < 0) {
        bad('29-1 缺少合法的 readings["layout.edges"] 版式量测字段');
      }
    } else if (question.id === '28-1') {
      const mb = data.readings['meta.bbox-limits'];
      const lc = data.readings['loop.closure-psnr'];
      if (!isPlainObj(mb) || !['frames', 'maxW', 'minH', 'maxH', 'minMarginLr', 'minMarginTb'].every((k) => isFiniteNum(mb[k]))) {
        bad('28-1 缺少合法的 readings["meta.bbox-limits"] 字段');
      }
      if (!isPlainObj(lc) || !isFiniteNum(lc.closurePsnr) || !isFiniteNum(lc.adjacentPsnr)) {
        bad('28-1 缺少合法的 readings["loop.closure-psnr"] 字段');
      }
    } else if (question.id === '23-1') {
      const lc = data.readings['loop.closure-psnr'];
      if (!isPlainObj(lc) || !Number.isInteger(lc.nearest) || !isFiniteNum(lc.closurePsnr) || !isFiniteNum(lc.adjacentPsnr)) {
        bad('23-1 缺少合法的 readings["loop.closure-psnr"] 字段');
      }
      if (!Array.isArray(data.variants) || data.variants.length === 0) {
        bad('23-1 缺少非空 variants 变体参考数组');
      } else {
        data.variants.forEach((v, idx) => {
          if (!isPlainObj(v) || !isPlainObj(v.deliverable) || !Number.isInteger(v.deliverable.frames) || v.deliverable.frames < 2) {
            bad(`23-1 variants[${idx}] 缺少合法的 deliverable.frames`);
            return;
          }
          if (v.deliverable.size !== undefined && (!isIntPair(v.deliverable.size) || v.deliverable.size[0] <= 0 || v.deliverable.size[1] <= 0)) {
            bad(`23-1 variants[${idx}] deliverable.size 不合法`);
          }
          if (!isPlainObj(v.readings) || !hasValidBaseSpec(v.readings.base?.spec)) {
            bad(`23-1 variants[${idx}] 缺少合法的 readings.base.spec`);
            return;
          }
          const vlc = v.readings['loop.closure-psnr'];
          if (!isPlainObj(vlc) || !Number.isInteger(vlc.nearest) || !isFiniteNum(vlc.closurePsnr) || !isFiniteNum(vlc.adjacentPsnr)) {
            bad(`23-1 variants[${idx}] 缺少合法的 readings["loop.closure-psnr"] 字段`);
          }
        });
      }
    } else if (question.id === '1-1') {
      const ds = data.readings['deliver.spec'];
      const al = data.readings['audio.loudness'];
      const bf = data.readings['frame.black-freeze-dup'];
      if (!isPlainObj(ds) || !['width', 'height', 'fps', 'frames', 'audioChannels'].every((k) => isFiniteNum(ds[k]))
        || !['color_space', 'color_transfer', 'color_primaries'].every((k) => typeof ds[k] === 'string' && ds[k].length > 0)) {
        bad('1-1 缺少合法的 readings["deliver.spec"] 字段');
      }
      if (!isPlainObj(al) || !isFiniteNum(al.lufs) || !isFiniteNum(al.truePeakDbtp)) {
        bad('1-1 缺少合法的 readings["audio.loudness"] 字段');
      }
      if (!isPlainObj(bf) || !['blackFrames', 'freezeSegments', 'duplicateFrames'].every((k) => isFiniteNum(bf[k]))) {
        bad('1-1 缺少合法的 readings["frame.black-freeze-dup"] 字段');
      }
    }
    return errors;
  }

  if (question.id === '5-1') {
    if (!isFiniteNum(data.fps) || data.fps <= 0) bad('5-1 缺少合法的 fps');
    if (!Number.isInteger(data.frames) || data.frames <= 0) bad('5-1 缺少合法的 frames');
    if (!isPlainObj(data.musicAlign) || !['corr', 'stretch', 'offsetSec', 'trackSec', 'stepSec'].every((k) => isFiniteNum(data.musicAlign[k]))) {
      bad('5-1 缺少合法的 musicAlign 读数');
    }
    if (!Number.isInteger(data.hardCutFrame)) bad('5-1 缺少合法的 hardCutFrame');
    if (!isPlainObj(data.lowBand) || !['maxHz', 'medianDb', 'riseDb'].every((k) => isFiniteNum(data.lowBand[k]))
      || !isFiniteArray(data.lowBand.peakFrames, 1)) {
      bad('5-1 缺少合法的 lowBand.peakFrames 读数');
    }
  } else if (question.id === '18-1') {
    if (!isFiniteNum(data.fps) || data.fps <= 0) bad('18-1 缺少合法的 fps');
    if (!Number.isInteger(data.frames) || data.frames <= 0) bad('18-1 缺少合法的 frames');
    if (!isFiniteArray(data.narrationOnsetsSec, 1)) bad('18-1 缺少合法的 narrationOnsetsSec');
    if (!isFiniteArray(data.subtitleAppearSec, 1)) bad('18-1 缺少合法的 subtitleAppearSec');
    if (!isFiniteArray(data.sceneFadeFrames, 1)) bad('18-1 缺少合法的 sceneFadeFrames');
    if (!isPlainObj(data.scenePauses) || !isFiniteArray(data.scenePauses.leadSec, 1)
      || !isFiniteArray(data.scenePauses.tailSec, 1)
      || data.scenePauses.leadSec.length !== data.scenePauses.tailSec.length) {
      bad('18-1 缺少合法的 scenePauses.leadSec/tailSec');
    }
    const framesOk = Array.isArray(data.palette?.sceneFrames) && data.palette.sceneFrames.length >= 1
      && data.palette.sceneFrames.every((sf) => isPlainObj(sf) && Array.isArray(sf.colors) && sf.colors.length >= 1
        && sf.colors.every((pair) => Array.isArray(pair) && pair.length === 2
          && typeof pair[0] === 'string' && HEX_COLOR_RE.test(pair[0]) && isFiniteNum(pair[1])));
    if (!isPlainObj(data.palette) || !isFiniteNum(data.palette.binLevels) || data.palette.binLevels <= 0 || !framesOk) {
      bad('18-1 缺少合法的 palette.sceneFrames 色板读数');
    }
  } else if (question.id === '18-2') {
    if (!isFiniteNum(data.fps) || data.fps <= 0) bad('18-2 缺少合法的 fps');
    if (!isIntPair(data.sceneFrames) || !(data.sceneFrames[0] < data.sceneFrames[1])) {
      bad('18-2 缺少合法的 sceneFrames 场景帧范围');
    }
    if (!isFiniteNum(data.resolutionSec) || data.resolutionSec <= 0) bad('18-2 缺少合法的 resolutionSec');
    const movesOk = Array.isArray(data.moves) && data.moves.length >= 1
      && data.moves.every((m) => isPlainObj(m) && typeof m.cue === 'string' && m.cue.trim().length > 0
        && ['cueSec', 'leadSec', 'expectedStartSec', 'measuredStartSec', 'measuredEndSec'].every((k) => isFiniteNum(m[k])));
    if (!movesOk) bad('18-2 缺少合法的 moves 运镜读数数组');
  } else if (question.id === '15-2') {
    if (!isIntPair(data.size) || data.size[0] <= 0 || data.size[1] <= 0) bad('15-2 缺少合法的 size');
    if (!hasMotionEntries(data.locked, 2)) bad('15-2 缺少合法的 locked 正例镜头读数');
    if (!hasMotionEntries(data.drifting, 1)) bad('15-2 缺少合法的 drifting 反例镜头读数');
  } else if (LEVEL2A_IDS.has(question.id)) {
    if (data.kind !== 'constructed' && data.kind !== 'measured') {
      bad(`kind 应为 constructed 或 measured，实际为 ${JSON.stringify(data.kind)}`);
    }
    const exp = data.expect;
    const expectedPass = isPlainObj(exp) && typeof exp.basePass === 'boolean' && Array.isArray(exp.items)
      ? exp.basePass && exp.items.every((v) => v === true)
      : null;
    const expectedScore = isPlainObj(exp) && Array.isArray(exp.items) && Array.isArray(question.scoring)
      && exp.items.length === question.scoring.length
      ? question.scoring.reduce((sum, s, idx) => sum + (exp.items[idx] === true && isFiniteNum(s?.weight) ? s.weight : 0), 0)
      : NaN;
    if (!isPlainObj(exp) || typeof exp.pass !== 'boolean' || typeof exp.basePass !== 'boolean'
      || !isFiniteNum(exp.score) || !Array.isArray(exp.items)
      || exp.items.length !== (question.scoring?.length ?? 0)
      || !exp.items.every((v) => typeof v === 'boolean')
      || exp.pass !== expectedPass
      || !isFiniteNum(expectedScore) || Math.abs(exp.score - expectedScore) >= 1e-9) {
      bad(`${question.id} 缺少合法且自洽的 expect 预期判分对象`);
    }
    if (!Number.isInteger(data.width) || data.width <= 0 || !Number.isInteger(data.height) || data.height <= 0
      || !isFiniteNum(data.fps) || data.fps <= 0 || !Number.isInteger(data.frames) || data.frames <= 0) {
      bad(`${question.id} 缺少合法的 width/height/fps/frames 读数`);
    }
    if (question.id === '27-1') {
      if (!Array.isArray(data.cuts) || !isFiniteNum(data.loudnessLufs) || !isFiniteNum(data.truePeakDbtp)) {
        bad('27-1 缺少合法的 cuts/loudnessLufs/truePeakDbtp 读数');
      }
    } else if (question.id === '29-2') {
      if (typeof data.eventsFps !== 'string' || !Number.isInteger(data.eventsFrames)
        || !Array.isArray(data.clicks) || !Array.isArray(data.cuts)
        || !Array.isArray(data.onsetsMs) || data.onsetsMs.length === 0) {
        bad('29-2 缺少合法的 eventsFps/eventsFrames/clicks/cuts/onsetsMs 读数');
      }
    } else if (question.id === '23-2') {
      if (!Array.isArray(data.chaptersMs) || !Array.isArray(data.strongOnsetsMs) || data.strongOnsetsMs.length === 0
        || !isPlainObj(data.beat) || !Number.isInteger(data.beat.periodMs) || !Number.isInteger(data.beat.phaseMs)) {
        bad('23-2 缺少合法的 chaptersMs/strongOnsetsMs/beat 读数');
      }
    } else if (question.id === '30-1') {
      const validEventList = (list, allowEmpty = false) => Array.isArray(list)
        && (allowEmpty || list.length > 0)
        && Array.from(list, (e) => isPlainObj(e)
          && typeof e.id === 'string' && e.id.trim().length > 0
          && Number.isSafeInteger(e.frame) && e.frame >= 0 && e.frame < data.frames).every(Boolean)
        && new Set(list.map((e) => e.id)).size === list.length;
      const sameIds = (a, b) => {
        const ids = new Set(b.map((e) => e.id));
        return a.length === b.length && a.every((e) => ids.has(e.id));
      };
      const beatOk = validEventList(data.beatEvents) && validEventList(data.probeBeatEvents)
        && sameIds(data.beatEvents, data.probeBeatEvents);
      const beatIdSet = beatOk ? new Set(data.beatEvents.map((e) => e.id)) : new Set();
      const absOk = (data.absoluteEvents === undefined && data.probeAbsoluteEvents === undefined)
        || (validEventList(data.absoluteEvents, true)
          && validEventList(data.probeAbsoluteEvents, true)
          && sameIds(data.absoluteEvents, data.probeAbsoluteEvents)
          && !data.absoluteEvents.some((e) => beatIdSet.has(e.id)));
      if (!isFiniteNum(data.baseBpm) || data.baseBpm <= 0
        || !isFiniteNum(data.probeBpm) || data.probeBpm <= 0 || data.baseBpm === data.probeBpm
        || !beatOk || !absOk
        || !isFiniteNum(data.loudnessLufs) || !isFiniteNum(data.truePeakDbtp)) {
        bad('30-1 缺少合法的 baseBpm/probeBpm/beatEvents/probeBeatEvents/loudnessLufs/truePeakDbtp 读数');
      }
    }
  }

  return errors;
}

function resolveRefPath(benchDir, ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const beimingRoot = path.resolve(benchDir, '..');
  const rel = ref.startsWith('beiming/') ? ref.slice('beiming/'.length) : ref;
  const abs = path.resolve(beimingRoot, rel);
  return abs.startsWith(beimingRoot + path.sep) ? abs : null;
}

function inspect30_1Sample(question, data) {
  if (!isPlainObj(data)
    || !Array.isArray(data.beatEvents) || data.beatEvents.length === 0
    || !Array.isArray(data.probeBeatEvents) || data.probeBeatEvents.length !== data.beatEvents.length) {
    return null;
  }
  const hitArgs = isPlainObj(question?.scoring?.[0]?.args) ? question.scoring[0].args : {};
  const followArgs = isPlainObj(question?.scoring?.[1]?.args) ? question.scoring[1].args : {};
  const minBeatEvents = Number.isInteger(hitArgs.minBeatEvents) && hitArgs.minBeatEvents > 0 ? hitArgs.minBeatEvents : 20;
  if (data.beatEvents.length < minBeatEvents) return null;

  const baseBpm = data.baseBpm;
  const probeBpm = data.probeBpm;
  const tolFrames = isFiniteNum(followArgs.tolFrames) && followArgs.tolFrames >= 0 ? Math.min(followArgs.tolFrames, 1) : 1;
  const minMovableRatio = isFiniteNum(followArgs.minMovableRatio) && followArgs.minMovableRatio > 0 ? followArgs.minMovableRatio : 0.5;
  const minPassFollowedRatio = isFiniteNum(followArgs.minMovedRatio) && followArgs.minMovedRatio > 0 ? followArgs.minMovedRatio : 1;
  if (!isFiniteNum(baseBpm) || !isFiniteNum(probeBpm) || baseBpm <= 0 || probeBpm <= 0 || baseBpm === probeBpm) {
    return null;
  }

  const reqIds = [...new Set([
    ...(Array.isArray(hitArgs.requiredEventIds) ? hitArgs.requiredEventIds : []),
    ...(Array.isArray(followArgs.requiredEventIds) ? followArgs.requiredEventIds : []),
  ].filter((id) => typeof id === 'string' && id.length > 0))];
  const baseIds = new Set(data.beatEvents.map((e) => e?.id));
  const probeById = new Map(data.probeBeatEvents.map((e) => [e?.id, e?.frame]));
  if (reqIds.some((id) => !baseIds.has(id) || !probeById.has(id))) return null;

  const ratio = baseBpm / probeBpm;
  const movableIds = new Set();
  const followedIds = new Set();
  let movableCount = 0;
  let followedCount = 0;
  let allStationary = true;
  for (const ev of data.beatEvents) {
    if (!isPlainObj(ev) || !probeById.has(ev.id)) return null;
    const baseFrame = ev.frame;
    const probeFrame = probeById.get(ev.id);
    const expectedFrame = Math.round(baseFrame * ratio);
    const lo = (baseFrame - 0.5) * ratio;
    const hi = (baseFrame + 0.5) * ratio;
    const disjoint = hi <= baseFrame - 0.5 + 1e-9 || lo >= baseFrame + 0.5 - 1e-9;
    const mustMove = Math.abs(expectedFrame - baseFrame) >= tolFrames + 1 || disjoint;
    if (mustMove) {
      movableCount++;
      movableIds.add(ev.id);
    }
    if (probeFrame !== baseFrame) allStationary = false;
    if (Math.abs(probeFrame - expectedFrame) <= tolFrames && (!mustMove || probeFrame !== baseFrame)) {
      followedCount++;
      followedIds.add(ev.id);
    }
  }
  const reqMovableOk = reqIds.length === 0
    || reqIds.filter((id) => movableIds.has(id)).length >= Math.ceil(reqIds.length * minMovableRatio);
  const enoughMovable = movableCount >= Math.ceil(data.beatEvents.length * minMovableRatio) && reqMovableOk;
  const followedRatio = followedCount / data.beatEvents.length;
  const reqFollowedRatio = reqIds.length === 0
    ? 1
    : reqIds.filter((id) => followedIds.has(id)).length / reqIds.length;
  const followsBpm = enoughMovable
    && followedRatio >= minPassFollowedRatio
    && reqFollowedRatio >= minPassFollowedRatio;
  return { baseBpm, probeBpm, enoughMovable, allStationary, followsBpm };
}

function isPass30_1Sample(question, data) {
  const exp = data?.expect;
  if (!isPlainObj(exp) || exp.pass !== true || exp.basePass !== true
    || !isFiniteNum(exp.score) || Math.abs(exp.score - 1) >= 1e-9
    || !Array.isArray(exp.items) || exp.items.length !== 2 || exp.items[0] !== true || exp.items[1] !== true) {
    return false;
  }
  const info = inspect30_1Sample(question, data);
  return Boolean(info && info.followsBpm);
}

function isHardcoded30_1Sample(question, data) {
  const exp = data?.expect;
  if (!isPlainObj(exp) || exp.pass !== false || exp.basePass !== true
    || !isFiniteNum(exp.score) || exp.score < 0 || exp.score >= 1
    || !Array.isArray(exp.items) || exp.items.length !== 2 || exp.items[0] !== true || exp.items[1] !== false) {
    return false;
  }
  const info = inspect30_1Sample(question, data);
  return Boolean(info && info.enoughMovable && info.allStationary);
}

function validateRefs(question, benchDir) {
  const errors = [];
  const refs = question.refs ?? [];
  if ((LEVEL1_IDS.has(question.id) || LEVEL2A_IDS.has(question.id) || LEVEL2B_IDS.has(question.id) || LEVEL3_IDS.has(question.id)) && refs.length === 0) {
    errors.push(`题目 ${question.id} 缺少参考夹具声明（refs 为空）`);
    return errors;
  }
  const loadedRefs = [];
  for (const ref of refs) {
    const abs = resolveRefPath(benchDir, ref);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      errors.push(`参考文件不存在：${ref}`);
      continue;
    }
    let raw;
    let data;
    try {
      raw = fs.readFileSync(abs, 'utf8');
      data = JSON.parse(raw);
    } catch (e) {
      errors.push(`参考文件不是合法 JSON（${ref}）：${e.message}`);
      continue;
    }
    const rawLeaks = scanQuestionLeaks(raw);
    const objLeaks = scanQuestionLeaks(data);
    if (rawLeaks.length > 0 || objLeaks.length > 0) {
      errors.push(`参考文件存在泄露项（${ref}）：${rawLeaks.length + objLeaks.length} 处`);
    }
    const dataErrors = validateRefData(question, data, ref);
    errors.push(...dataErrors);
    if (dataErrors.length === 0) loadedRefs.push(data);
  }
  if (question.id === '30-1' && errors.length === 0) {
    const passSamples = loadedRefs.filter((d) => isPass30_1Sample(question, d));
    const hardcodedSamples = loadedRefs.filter((d) => isHardcoded30_1Sample(question, d));
    const hasPairedSamples = passSamples.some((p) => hardcodedSamples.some(
      (h) => p.baseBpm === h.baseBpm && p.probeBpm === h.probeBpm,
    ));
    if (!hasPairedSamples) {
      errors.push('题目 30-1 必须同时声明同 BPM 扰动对下的通过型参考样本与写死帧号失败型固定样本');
    }
  }
  return errors;
}

/* ---------------- 离线基准合成与真实量测 ---------------- */

function paintRgba(width, height, bg, rects = []) {
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1, color] of [[0, 0, width, height, bg], ...rects]) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) rgba.set(color, (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

function synthesize29Readings(question, { shiftTopPx = 0, dividerColor = [0xCB, 0xFB, 0x03] } = {}) {
  const W = 1080;
  const H = 1350;
  const total = 600;
  const bg = [9, 9, 6];
  const panel = [128, 110, 90];
  const frame = paintRgba(W, H, bg, [
    [0, 44 + shiftTopPx, W, 652, panel],
    [0, 673, W, 677, dividerColor],
    [0, 698, W, 1306, panel],
  ]);
  const layoutArgs = argsOfB2(question, 'layout.edges');
  const canMeasure = typeof layoutArgs.background === 'string' && HEX_COLOR_RE.test(layoutArgs.background)
    && isFiniteNum(layoutArgs.backgroundTol) && isFiniteNum(layoutArgs.rowFill)
    && Array.isArray(layoutArgs.bands) && isIntPair(layoutArgs.coreRows)
    && typeof layoutArgs.color === 'string' && HEX_COLOR_RE.test(layoutArgs.color);
  const layout = canMeasure
    ? readLayout(frame, layoutArgs, [W, H])
    : { bands: null, edgeErrorsPx: null, sideErrorsPx: null, lineColorError: null };

  const entities = [];
  if (Array.isArray(layout.bands) && layout.bands.length === 3
    && Array.isArray(layout.sideErrorsPx) && layout.sideErrorsPx.length === 6
    && layout.sideErrorsPx.every(isFiniteNum)) {
    const names = ['panel_top', 'divider', 'panel_bottom'];
    names.forEach((name, idx) => {
      const [y0, y1] = layout.bands[idx];
      const leftErr = layout.sideErrorsPx[idx * 2];
      const rightErr = layout.sideErrorsPx[idx * 2 + 1];
      entities.push({ name, bbox2d: [leftErr, y0, W - rightErr, y1] });
    });
  }

  const film = { output: { size: [W, H], fps: '30/1', frames: total }, shots: [{ id: 's01', in: 0, out: total }] };
  const meta = { size: [W, H], entities };
  const measured = {
    output: { size: [W, H], fps: '30/1', frames: total, colorTag: 'bt709' },
    blackFrames: [],
    freezes: [],
    frames: Array.from({ length: total }, (_, idx) => ({ frame: idx, meta })),
  };
  return {
    base: {
      spec: { width: W, height: H, fps: 30, frames: total, audioChannels: 0 },
      predicates: evaluateBasePredicates(question, film, measured),
    },
    'layout.edges': layout,
  };
}

function synthesize28OrbitReadings(question) {
  const W = 1920;
  const H = 824;
  const total = 288;
  const grey = [110, 108, 108];
  const boxAt = (k, height = 560) => {
    const angle = (2 * Math.PI * k) / total;
    const half = Math.round(300 + 50 * Math.cos(angle));
    return [960 - half, (H - height) / 2, 960 + half, (H + height) / 2];
  };
  const frameAt = (k, box = boxAt(k)) => {
    const stripe = 960 + Math.round(200 * Math.sin((2 * Math.PI * k) / total));
    return paintRgba(W, H, grey, [
      [...box, [30, 30, 40]],
      [stripe - 20, box[1] + 40, stripe + 20, box[3] - 40, [200, 180, 160]],
    ]);
  };
  const boxes = Array.from({ length: total }, (_, k) => boxAt(k));
  const samples = [0, 72, 144, 216].map((k) => ({ frame: frameAt(k), box: boxes[k] }));
  const film = { output: { size: [W, H], fps: '24/1', frames: total }, shots: [{ id: 's01', in: 0, out: total }] };
  const measured = {
    output: { size: [W, H], fps: '24/1', frames: total, colorTag: 'bt709' },
    blackFrames: [],
    freezes: [],
    cuts: [],
    orbitTotalDeg: { 'camera:subject': 360 },
    orbitAnglesDeg: {
      'camera:subject': Array.from({ length: total }, (_, k) => ({ frame: k, deg: (k * 360) / total })),
    },
    frames: boxes.map((bbox2d, frame) => ({ frame, meta: { size: [W, H], entities: [{ name: 'subject', bbox2d }] } })),
  };
  return {
    base: {
      spec: { width: W, height: H, fps: 24, frames: total, audioChannels: 0 },
      predicates: evaluateBasePredicates(question, film, measured),
    },
    'meta.bbox-limits': readFraming(boxes, [W, H]),
    'loop.closure-psnr': readClosure(frameAt(0), frameAt(total - 1), frameAt(1)),
    'pixel.bbox': readPixelBoxes(samples, '#6E6C6C', 16),
  };
}

function synthesize23TurntableReadings(question, totalDegrees = 360) {
  const W = 720;
  const H = 1080;
  const total = 72;
  const turn = (degrees) => {
    const rgba = new Uint8Array(64 * 8 * 4).fill(255);
    for (let i = 0; i < 64 * 8; i++) {
      rgba.fill(Math.round(128 + 100 * Math.sin((2 * Math.PI * (i % 64)) / 64 + (degrees * Math.PI) / 180)), i * 4, i * 4 + 3);
    }
    return { width: 64, height: 8, rgba };
  };
  const frameAt = (k) => turn((k * totalDegrees) / total);
  const search = argsOfB2(question, 'loop.closure-psnr')?.search ?? [36, 72];
  const film = { output: { size: [W, H], fps: '24/1', frames: total }, shots: [{ id: 's01', in: 0, out: total }] };
  const measured = {
    output: { size: [W, H], fps: '24/1', frames: total, colorTag: 'bt709' },
    blackFrames: [],
    freezes: [],
    cuts: [],
    orbitTotalDeg: { 'camera:subject': totalDegrees },
    orbitAnglesDeg: {
      'camera:subject': Array.from({ length: total }, (_, k) => ({ frame: k, deg: (k * totalDegrees) / total })),
    },
  };
  return {
    base: {
      spec: { width: W, height: H, fps: 24, frames: total, audioChannels: 0 },
      predicates: evaluateBasePredicates(question, film, measured),
    },
    'loop.closure-psnr': {
      ...readNearest(frameAt, search),
      ...readClosure(frameAt(0), frameAt(total - 1), frameAt(1)),
    },
  };
}

function build01BaselineFromRef(question, refData) {
  const spec = refData.readings['deliver.spec'] ?? {};
  const audio = refData.readings['audio.loudness'] ?? {};
  const frames = refData.readings['frame.black-freeze-dup'] ?? {};
  const tags = new Set(['color_space', 'color_transfer', 'color_primaries'].map((tag) => spec[tag]));
  const fpsText = `${spec.fps}/1`;
  const film = {
    output: { size: [spec.width, spec.height], fps: fpsText, frames: spec.frames },
    shots: [{ id: 's01', in: 0, out: spec.frames }],
  };
  const measured = {
    output: { size: [spec.width, spec.height], fps: fpsText, frames: spec.frames, colorTag: tags.size === 1 ? [...tags][0] : null },
    blackFrames: frames.blackFrames === 0 ? [] : null,
    freezes: frames.freezeSegments === 0 ? [] : null,
    audio: { loudnessLufs: audio.lufs, truePeakDbtp: audio.truePeakDbtp },
  };
  return {
    ...refData.readings,
    base: {
      spec: refData.readings.base.spec,
      predicates: evaluateBasePredicates(question, film, measured),
    },
  };
}

function buildLevel2bRefVerdict(question, refData, posReadings) {
  if (question.id === '5-1') {
    const readings = {
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
    };
    const v = scoreLevel2b(question, readings);
    return v.pass === true && Math.abs(v.score - 1) < 1e-9;
  }
  if (question.id === '18-1') {
    const paletteArgs = question.scoring.find((s) => s.metric === 'color.palette')?.args;
    if (!paletteArgs || typeof paletteArgs.color !== 'string' || !HEX_COLOR_RE.test(paletteArgs.color) || !isFiniteNum(paletteArgs.binLevels)) {
      return false;
    }
    const bin = (ch) => Math.floor((ch * paletteArgs.binLevels) / 256);
    const target = [1, 3, 5].map((i) => bin(parseInt(paletteArgs.color.slice(i, i + 2), 16)));
    const shares = refData.palette.sceneFrames.map((sf) => sf.colors
      .filter(([hex]) => [1, 3, 5].every((i, idx) => bin(parseInt(hex.slice(i, i + 2), 16)) === target[idx]))
      .reduce((sum, [, share]) => sum + share, 0));
    const readings = {
      'narration.timing': {
        appearSec: refData.subtitleAppearSec,
        onsetsSec: refData.narrationOnsetsSec,
        spanSec: refData.frames / refData.fps,
        fadeFrames: refData.sceneFadeFrames,
        leadSec: refData.scenePauses.leadSec,
        tailSec: refData.scenePauses.tailSec,
      },
      'color.palette': { shares },
    };
    const v = scoreLevel2b(question, readings, { allowReferenceSpan: true });
    return v.pass === true && Math.abs(v.score - 1) < 1e-9;
  }
  if (question.id === '18-2') {
    const readings = {
      'narration.timing': {
        eventFrames: refData.moves.map((m) => m.cueSec * refData.fps),
        markFrames: refData.moves.map((m) => Math.round(m.measuredStartSec * refData.fps)),
        range: refData.sceneFrames,
      },
    };
    const v = scoreLevel2b(question, readings);
    return v.pass === true && Math.abs(v.score - 1) < 1e-9;
  }
  if (question.id === '15-2') {
    const posRef = scoreLevel2b(question, {
      'meta.camera-static': posReadings['meta.camera-static'],
      'motion.zoom-pan': { pairs: refData.locked },
    });
    const negAllRejected = refData.drifting.every((d) => scoreLevel2b(question, {
      'meta.camera-static': posReadings['meta.camera-static'],
      'motion.zoom-pan': { pairs: [refData.locked[0], d] },
    }).pass === false);
    return posRef.pass === true && Math.abs(posRef.score - 1) < 1e-9 && negAllRejected;
  }
  return false;
}

function buildLevel2bBaseEvidence(questionId, posReadings) {
  if (questionId === '5-1') {
    const spec = { width: 1920, height: 1080, fps: 24, frames: 720, audioChannels: 2 };
    const film = { output: { size: [1920, 1080], fps: '24/1', frames: 720 }, shots: [{ id: 's01', in: 0, out: 624 }, { id: 's02', in: 624, out: 720 }] };
    const measured = {
      output: { size: [1920, 1080], fps: '24/1', frames: 720, colorTag: 'bt709' },
      blackFrames: [],
      freezes: [],
      cuts: posReadings['beat.onset-hit']?.eventFrames ?? [],
    };
    return { spec, film, measured };
  }
  if (questionId === '18-1') {
    const spec = { width: 1920, height: 1080, fps: 30, frames: 900, audioChannels: 2 };
    const appearSec = posReadings['narration.timing']?.appearSec ?? [];
    const overlays = appearSec.map((sec, idx) => {
      const start = Math.round(sec * 30);
      const next = idx + 1 < appearSec.length ? Math.round(appearSec[idx + 1] * 30) : 900;
      const end = Math.max(start + 1, Math.min(900, next));
      return { id: `sub-${idx}`, shot: 's01', text: `block-${idx}`, in: start, out: end };
    });
    const frames = overlays.map((o) => ({
      frame: o.in,
      meta: { size: [1920, 1080], texts: [{ text: o.text }] },
      ocr: [{ text: o.text }],
    }));
    const film = { output: { size: [1920, 1080], fps: '30/1', frames: 900 }, shots: [{ id: 's01', in: 0, out: 900 }], overlays };
    const measured = {
      output: { size: [1920, 1080], fps: '30/1', frames: 900, colorTag: 'bt709' },
      blackFrames: [],
      freezes: [],
      frames,
    };
    return { spec, film, measured };
  }
  if (questionId === '18-2') {
    const spec = { width: 1920, height: 1080, fps: 30, frames: 600, audioChannels: 2 };
    const evFrames = posReadings['narration.timing']?.eventFrames ?? [];
    const audioOnsets = {};
    if (isFiniteNum(evFrames[0])) audioOnsets.cue_a = evFrames[0];
    if (isFiniteNum(evFrames[1])) audioOnsets.cue_b = evFrames[1];
    const film = { output: { size: [1920, 1080], fps: '30/1', frames: 600 }, shots: [{ id: 's01', in: 0, out: 600 }] };
    const measured = {
      output: { size: [1920, 1080], fps: '30/1', frames: 600, colorTag: 'bt709' },
      blackFrames: [],
      freezes: [],
      audioOnsets,
    };
    return { spec, film, measured };
  }
  if (questionId === '15-2') {
    const spec = { width: 1080, height: 608, fps: 30, frames: 300, audioChannels: 0 };
    const cameras = posReadings['meta.camera-static']?.cameras ?? [];
    const allStatic = cameras.length > 0 && cameras.every((c) => JSON.stringify(c.world) === JSON.stringify(cameras[0].world));
    const film = { output: { size: [1080, 608], fps: '30/1', frames: 300 }, shots: [{ id: 's01', in: 0, out: 300 }] };
    const measured = {
      output: { size: [1080, 608], fps: '30/1', frames: 300, colorTag: 'bt709' },
      blackFrames: [],
      freezes: [],
      cuts: [],
      orbitTotalDeg: allStatic ? { 'camera:scene': 0 } : {},
      orbitAnglesDeg: allStatic
        ? { 'camera:scene': Array.from({ length: 300 }, (_, k) => ({ frame: k, deg: 0 })) }
        : {},
    };
    return { spec, film, measured };
  }
  return null;
}

function buildLevel1VariantQuestion(question, variant) {
  if (!isPlainObj(variant?.deliverable)) return null;
  const vq = JSON.parse(JSON.stringify(question));
  Object.assign(vq.deliverable, variant.deliverable);
  const frames = vq.deliverable?.frames;
  if (!Number.isInteger(frames) || frames < 2) return null;
  const half = Math.floor(frames / 2);
  const last = frames - 1;
  for (const item of vq.scoring ?? []) {
    if (item.metric !== 'loop.closure-psnr' || !isPlainObj(item.args)) continue;
    if (Array.isArray(item.args.search) && Number.isInteger(item.args.expect)) {
      item.args.search = [half, frames];
      item.args.expect = last;
    }
    if (Number.isInteger(item.args.b)) {
      item.args.b = last;
    }
  }
  return validateQuestion(vq).ok ? vq : null;
}

function verifyLevel1Variants(question, refData) {
  const variants = Array.isArray(refData.variants) ? refData.variants : [];
  if (question.id === '23-1' && variants.length === 0) return false;
  for (const variant of variants) {
    const variantQ = buildLevel1VariantQuestion(question, variant);
    if (!variantQ) return false;
    const verdict = scoreLevel1(variantQ, variant.readings);
    const deliverableOk = verdict.base?.[0]?.check === 'deliverable'
      && verdict.base[0].pass === true;
    const hasPreds = isPlainObj(variant.readings?.base?.predicates);
    const expectBasePass = hasPreds ? true : (variantQ.basePredicates?.length ?? 0) === 0;
    const variantOk = verdict.scoringPass === true
      && Math.abs(verdict.score - 1) < 1e-9
      && deliverableOk
      && verdict.basePass === expectBasePass
      && verdict.pass === expectBasePass;
    if (!variantOk) return false;
  }
  return true;
}

/**
 * 针对单道公开考题运行离线正对照与负对照判分核验。
 * 返回 { pass, controlsOk, positiveScore, negativeControlsChecked, negativeControlsRejected, predicates, metrics, detail }。
 */
export function evaluateOfflineQuestion({ question, benchDir = HERE }) {
  const beimingRoot = path.resolve(benchDir, '..');
  const failOutcome = (detail) => ({
    pass: false,
    controlsOk: false,
    positiveScore: 0,
    negativeControlsChecked: 0,
    negativeControlsRejected: 0,
    predicates: {},
    metrics: {},
    detail,
  });

  if (LEVEL3_IDS.has(question.id)) {
    try {
      if (question.refs?.length !== 1) return failOutcome('三级题须声明一份完整的参考夹具');
      const ref = JSON.parse(fs.readFileSync(resolveRefPath(benchDir, question.refs[0]), 'utf8'));
      const errors = validateRefData(question, ref, question.refs[0]);
      if (errors.length) return failOutcome(errors.join('；'));
      const refOk = scoreLevel3(question, ref.readings).pass;
      const { positive, negatives } = runLevel3Controls(question);
      const rejected = Object.values(negatives).filter(v => !v.pass && v.score < 1).length;
      const checked = Object.keys(negatives).length;
      const controlsOk = refOk && checked > 0 && rejected === checked;
      const evidence = pass => ({ pass, basis: 'offline-eval-b17' });
      return {
        pass: controlsOk && positive.pass && positive.score === 1,
        controlsOk, positiveScore: controlsOk ? positive.score : 0,
        negativeControlsChecked: checked, negativeControlsRejected: rejected,
        predicates: Object.fromEntries(positive.base.map(item => [item.predicate, evidence(item.pass)])),
        metrics: Object.fromEntries(positive.items.map(item => [item.metric, evidence(controlsOk && item.pass)])),
        detail: !refOk ? '三级题参考读数未通过' : !controlsOk ? `负对照只拦截 ${rejected}/${checked}` : positive.pass ? 'ok' : '标准答案未通过',
      };
    } catch (err) {
      return failOutcome(`三级工程离线核验失败：${err.message}`);
    }
  }

  if (LEVEL1_IDS.has(question.id)) {
    const refRel = question.refs?.[0];
    const refAbs = refRel ? path.resolve(beimingRoot, refRel) : null;
    if (!refAbs || !refAbs.startsWith(beimingRoot + path.sep) || !fs.existsSync(refAbs)) {
      return failOutcome(`缺少参考夹具 ${refRel ?? '(未声明)'}`);
    }
    let refData;
    try {
      refData = JSON.parse(fs.readFileSync(refAbs, 'utf8'));
    } catch (e) {
      return failOutcome(`参考夹具无法解析（${refRel}）：${e.message}`);
    }
    const refErrors = validateRefData(question, refData, refRel);
    if (refErrors.length > 0) return failOutcome(refErrors.join('；'));

    let posVerdict;
    let refOk = true;
    let negChecked = 0;
    let negRejected = 0;

    if (question.id === '28-1') {
      const negVerdict = scoreLevel1(question, refData.readings);
      negChecked++;
      if (negVerdict.pass === false && negVerdict.score === 0) negRejected++;
      posVerdict = scoreLevel1(question, synthesize28OrbitReadings(question));
    } else if (question.id === '29-1') {
      // 29-1 参考夹具实测带双声道且无逐帧元数据：在真实 B2 评分器下必须得满分(score=1, scoringPass=true)且如实 basePass=false/pass=false
      const rawRefVerdict = scoreLevel1(question, refData.readings);
      refOk = rawRefVerdict.scoringPass === true
        && Math.abs(rawRefVerdict.score - 1) < 1e-9
        && rawRefVerdict.basePass === false
        && rawRefVerdict.pass === false;
      posVerdict = scoreLevel1(question, synthesize29Readings(question));
      const shiftedNeg = scoreLevel1(question, synthesize29Readings(question, { shiftTopPx: 1, dividerColor: [0xCB, 0xFB - 5, 0x03] }));
      negChecked++;
      if (shiftedNeg.pass === false && shiftedNeg.score < 1) negRejected++;
    } else if (question.id === '23-1') {
      const rawRefVerdict = scoreLevel1(question, refData.readings);
      const mainRefOk = rawRefVerdict.scoringPass === true
        && Math.abs(rawRefVerdict.score - 1) < 1e-9
        && rawRefVerdict.base?.[0]?.check === 'deliverable'
        && rawRefVerdict.base[0].pass === true
        && rawRefVerdict.basePass === false
        && rawRefVerdict.pass === false;
      refOk = mainRefOk && verifyLevel1Variants(question, refData);
      posVerdict = scoreLevel1(question, synthesize23TurntableReadings(question, 360));
      const underNeg = scoreLevel1(question, synthesize23TurntableReadings(question, 350));
      negChecked++;
      if (underNeg.pass === false && underNeg.score < 1) negRejected++;
    } else {
      // 1-1：直接用真实参考读数经 verify/predicates 逐条求值基础谓词
      const rawRefVerdict = scoreLevel1(question, refData.readings);
      refOk = rawRefVerdict.scoringPass === true && Math.abs(rawRefVerdict.score - 1) < 1e-9;
      posVerdict = scoreLevel1(question, build01BaselineFromRef(question, refData));
      if (isPlainObj(refData.preview?.['audio.loudness'])) {
        const previewReadings = build01BaselineFromRef(question, {
          ...refData,
          readings: { ...refData.readings, 'audio.loudness': refData.preview['audio.loudness'] },
        });
        const previewNeg = scoreLevel1(question, previewReadings);
        negChecked++;
        if (previewNeg.pass === false && previewNeg.score < 1) negRejected++;
      }
    }

    const emptyNeg = scoreLevel1(question, {});
    negChecked++;
    if (emptyNeg.pass === false && emptyNeg.score === 0) negRejected++;

    const posOk = refOk
      && posVerdict.pass === true
      && posVerdict.scoringPass === true
      && posVerdict.basePass === true
      && Math.abs(posVerdict.score - 1) < 1e-9;
    const negOk = negChecked > 0 && negRejected === negChecked;
    const controlOk = Boolean(refOk && negOk);
    const allOk = posOk && negOk;

    const predicates = Object.fromEntries(
      (question.basePredicates ?? []).map((text) => {
        const hit = posVerdict.base?.find((b) => b.check === text);
        return [text, { pass: Boolean(hit?.pass), basis: 'offline-eval-b2' }];
      }),
    );
    const metrics = {};
    for (const s of question.scoring) {
      const matching = posVerdict.items.filter((item) => item.metric === s.metric);
      metrics[s.metric] = controlOk
        ? {
            pass: Boolean(matching.length > 0 && matching.every((item) => item.pass)),
            basis: 'offline-eval-b2',
          }
        : {
            pass: false,
            basis: 'offline-eval-b2-control-mismatch',
          };
    }
    return {
      pass: allOk,
      controlsOk: controlOk,
      positiveScore: controlOk ? posVerdict.score : 0,
      negativeControlsChecked: negChecked,
      negativeControlsRejected: negRejected,
      predicates,
      metrics,
      detail: allOk
        ? 'ok'
        : !refOk
          ? `参考夹具在 B2 评分器下未满足预期口径（${refRel}）`
          : !posOk
            ? `正对照未通过（score=${posVerdict.score}，basePass=${posVerdict.basePass}，scoringPass=${posVerdict.scoringPass}）`
            : `负对照未全部拦截（${negRejected}/${negChecked}）`,
    };
  }

  if (LEVEL2B_IDS.has(question.id)) {
    const refRel = question.refs?.[0];
    const refAbs = refRel ? path.resolve(beimingRoot, refRel) : null;
    if (!refAbs || !refAbs.startsWith(beimingRoot + path.sep) || !fs.existsSync(refAbs)) {
      return failOutcome(`缺少参考夹具 ${refRel ?? '(未声明)'}`);
    }
    let refData;
    try {
      refData = JSON.parse(fs.readFileSync(refAbs, 'utf8'));
    } catch (e) {
      return failOutcome(`参考夹具无法解析（${refRel}）：${e.message}`);
    }
    const refErrors = validateRefData(question, refData, refRel);
    if (refErrors.length > 0) return failOutcome(refErrors.join('；'));

    const pos = buildPositiveBaseline(question.id);
    // 必须把实际加载的 question 对象交给正式 B4 评分器，禁止静默回读仓库默认题
    const posVerdict = scoreLevel2b(question, pos.readings);
    const refOk = buildLevel2bRefVerdict(question, refData, pos.readings);
    const baseEvidence = buildLevel2bBaseEvidence(question.id, pos.readings);
    const specOk = Boolean(baseEvidence) && sameDeliverableSpec(baseEvidence.spec, question.deliverable);
    const predMap = baseEvidence ? evaluateBasePredicates(question, baseEvidence.film, baseEvidence.measured) : {};
    const basePass = specOk && (question.basePredicates ?? []).every((text) => predMap[text] === 'pass');

    const posOk = posVerdict.pass === true && Math.abs(posVerdict.score - 1) < 1e-9 && refOk && basePass;
    let negChecked = 0;
    let negRejected = 0;
    for (const kind of B6_NEGATIVE_KINDS) {
      negChecked++;
      const neg = evaluateNegativeControl(`${question.id}-${kind}`);
      const negVerdict = scoreLevel2b(question, neg.readings);
      const expectedFailed = neg.control.expectedFailedMetrics.map(({ scoring }) => scoring).sort((a, b) => a - b).join();
      const actualFailed = negVerdict.items.flatMap((item, idx) => (item.pass ? [] : [idx])).join();
      if (negVerdict.pass === false && negVerdict.score < 1 && neg.failedAsDeclared === true && actualFailed === expectedFailed) {
        negRejected++;
      }
    }
    const negOk = negChecked === B6_NEGATIVE_KINDS.length && negRejected === negChecked;
    const controlOk = Boolean(refOk && negOk);
    const allOk = posOk && negOk;

    const predicates = Object.fromEntries(
      (question.basePredicates ?? []).map((text) => [text, { pass: predMap[text] === 'pass', basis: 'offline-eval-b4' }]),
    );
    const metrics = {};
    for (const s of question.scoring) {
      const matching = posVerdict.items.filter((item) => item.metric === s.metric);
      metrics[s.metric] = controlOk
        ? {
            pass: Boolean(matching.length > 0 && matching.every((item) => item.pass)),
            basis: 'offline-eval-b4',
          }
        : {
            pass: false,
            basis: 'offline-eval-b4-control-mismatch',
          };
    }
    return {
      pass: allOk,
      controlsOk: controlOk,
      positiveScore: controlOk ? posVerdict.score : 0,
      negativeControlsChecked: negChecked,
      negativeControlsRejected: negRejected,
      predicates,
      metrics,
      detail: allOk
        ? 'ok'
        : !refOk
          ? `参考夹具在 B4 评分器下未通过（${refRel}）`
          : !basePass
            ? `基础规格或基础谓词未通过（specOk=${specOk}）`
            : !posOk
              ? `正对照未通过（score=${posVerdict.score}，pass=${posVerdict.pass}）`
              : `B6 负对照未全部按声明拦截（${negRejected}/${negChecked}）`,
    };
  }

  if (LEVEL2A_IDS.has(question.id)) {
    const refs = question.refs ?? [];
    if (refs.length === 0) return failOutcome(`题目 ${question.id} 缺少参考夹具`);
    let posRefData = null;
    let posVerdict = null;
    let refOk = true;
    let hasHardcodedNeg = false;
    let negChecked = 0;
    let negRejected = 0;

    for (const refRel of refs) {
      const refAbs = resolveRefPath(benchDir, refRel);
      if (!refAbs || !fs.existsSync(refAbs)) return failOutcome(`缺少参考夹具 ${refRel}`);
      let refData;
      try {
        refData = JSON.parse(fs.readFileSync(refAbs, 'utf8'));
      } catch (e) {
        return failOutcome(`参考夹具无法解析（${refRel}）：${e.message}`);
      }
      const refErrors = validateRefData(question, refData, refRel);
      if (refErrors.length > 0) return failOutcome(refErrors.join('；'));

      const verdict = evaluateLevel2a(question, refData);
      const exp = refData.expect;
      const matchesExpect = verdict.pass === exp.pass
        && verdict.basePass === exp.basePass
        && Math.abs(verdict.score - exp.score) < 1e-9
        && verdict.items.length === exp.items.length
        && verdict.items.every((it, idx) => it.pass === exp.items[idx]);
      if (!matchesExpect) refOk = false;

      if (exp.pass === true) {
        posRefData = refData;
        posVerdict = verdict;
      } else {
        negChecked++;
        const followArgs = isPlainObj(question?.scoring?.[1]?.args) ? question.scoring[1].args : {};
        if (question.id === '30-1'
          && isHardcoded30_1Sample(question, refData)
          && refData.baseBpm === followArgs.baseBpm
          && refData.probeBpm === followArgs.probeBpm) {
          hasHardcodedNeg = true;
        }
        if (matchesExpect && verdict.pass === false && verdict.score < 1) negRejected++;
      }
    }

    if (!posRefData || !posVerdict) {
      return failOutcome(`题目 ${question.id} 缺少通过型参考夹具`);
    }
    if (question.id === '30-1' && !hasHardcodedNeg) {
      return failOutcome('题目 30-1 缺少写死帧号固定负对照夹具');
    }

    // 额外合成负对照（切点偏移 / 落拍错位 / 写死帧号 / 漏交命名事件 / 空读数）
    const synthNegs = [{}];
    if (question.id === '27-1') {
      synthNegs.push({
        ...posRefData,
        cuts: posRefData.cuts.map((c, idx) => (idx === 0 ? c + 1 : c)),
      });
    } else if (question.id === '29-2') {
      synthNegs.push(
        { ...posRefData, cuts: posRefData.cuts.map((c) => c + 1) },
        { ...posRefData, clicks: posRefData.clicks.map((c) => Math.max(0, c - 10)) },
      );
    } else if (question.id === '23-2') {
      synthNegs.push({
        ...posRefData,
        chaptersMs: posRefData.chaptersMs.map((ms) => ms + 250),
      });
    } else if (question.id === '30-1') {
      const hitArgs = isPlainObj(question.scoring?.[0]?.args) ? question.scoring[0].args : {};
      const hitBpm = isFiniteNum(hitArgs.bpm) && hitArgs.bpm > 0 ? hitArgs.bpm : posRefData.baseBpm;
      const phaseFrames = isFiniteNum(hitArgs.phaseFrames) ? hitArgs.phaseFrames : 0;
      const periodFrames = (posRefData.fps * 60) / hitBpm;
      const halfPeriod = Number.isFinite(periodFrames) && periodFrames >= 4 ? periodFrames / 2 : 9;
      const offBeatEvents = posRefData.beatEvents.map((e, idx) => ({
        id: e.id,
        frame: (((Math.round((idx + 1) * periodFrames + phaseFrames + halfPeriod) % posRefData.frames) + posRefData.frames) % posRefData.frames),
      }));
      synthNegs.push(
        {
          ...posRefData,
          beatEvents: offBeatEvents,
          probeBeatEvents: offBeatEvents.map((e) => ({
            id: e.id,
            frame: Math.min(posRefData.frames - 1, Math.max(0, Math.round(e.frame * (posRefData.baseBpm / posRefData.probeBpm)))),
          })),
        },
        {
          ...posRefData,
          probeBeatEvents: posRefData.beatEvents.map((e) => ({ ...e })),
        },
      );
      const reqIds = (question.scoring ?? [])
        .flatMap((s) => (Array.isArray(s?.args?.requiredEventIds) ? s.args.requiredEventIds : []))
        .filter((id) => typeof id === 'string' && id.length > 0);
      const baseIdSet = new Set(posRefData.beatEvents.map((e) => e.id));
      const targetId = [...reqIds].reverse().find((id) => baseIdSet.has(id))
        ?? posRefData.beatEvents[posRefData.beatEvents.length - 1]?.id;
      if (targetId) {
        const usedIds = new Set([
          ...posRefData.beatEvents.map((e) => e.id),
          ...(posRefData.absoluteEvents ?? []).map((e) => e.id),
        ]);
        let replacementId = 'other_event';
        let suffix = 1;
        while (usedIds.has(replacementId)) replacementId = `other_event_${suffix++}`;
        synthNegs.push({
          ...posRefData,
          beatEvents: posRefData.beatEvents.map((e) => (e.id === targetId ? { ...e, id: replacementId } : e)),
          probeBeatEvents: posRefData.probeBeatEvents.map((e) => (e.id === targetId ? { ...e, id: replacementId } : e)),
        });
      }
    }
    for (const negReading of synthNegs) {
      negChecked++;
      const nv = evaluateLevel2a(question, negReading);
      if (nv.pass === false && nv.score < 1) negRejected++;
    }

    const posOk = refOk
      && posVerdict.pass === true
      && posVerdict.basePass === true
      && Math.abs(posVerdict.score - 1) < 1e-9;
    const negOk = negChecked > 0 && negRejected === negChecked;
    const controlOk = Boolean(refOk && negOk);
    const allOk = posOk && negOk;

    const predicates = Object.fromEntries(
      (question.basePredicates ?? []).map((text) => {
        const hit = posVerdict.base?.find((b) => b.predicate === text);
        return [text, { pass: Boolean(hit?.pass), basis: 'offline-eval-b3' }];
      }),
    );
    const metrics = {};
    for (const s of question.scoring) {
      const matching = posVerdict.items.filter((item) => item.metric === s.metric);
      metrics[s.metric] = controlOk
        ? {
            pass: Boolean(matching.length > 0 && matching.every((item) => item.pass)),
            basis: 'offline-eval-b3',
          }
        : {
            pass: false,
            basis: 'offline-eval-b3-control-mismatch',
          };
    }
    return {
      pass: allOk,
      controlsOk: controlOk,
      positiveScore: controlOk ? posVerdict.score : 0,
      negativeControlsChecked: negChecked,
      negativeControlsRejected: negRejected,
      predicates,
      metrics,
      detail: allOk
        ? 'ok'
        : !refOk
          ? `参考夹具在 B3 评分器下未满足预期口径`
          : !posOk
            ? `正对照未通过（score=${posVerdict.score}，basePass=${posVerdict.basePass}）`
            : `负对照未全部拦截（${negRejected}/${negChecked}）`,
    };
  }

  return failOutcome(`题号 ${question.id} 尚未接入离线核验器`);
}

/**
 * 运行考题库校验与离线考试核验。
 * @param {object} [options]
 * @param {string} [options.questionsDir] 题库目录（默认 beiming/bench/questions）
 * @param {string} [options.benchDir] bench 根目录（默认 beiming/bench）
 * @param {string|null} [options.outDir] 报告输出目录（传 null 不落盘）
 * @param {boolean} [options.dryRun] 仅校验题库与夹具结构
 * @param {string} [options.evalRoot] runner 隔离运行根目录（必须在仓库外；默认使用系统临时目录并自动清理）
 * @param {Record<string, Function>} [options.evaluators] 自定义单题离线核验器（供测试注入正反例）
 */
export async function runExam(options = {}) {
  const benchDir = path.resolve(options.benchDir ?? HERE);
  const defaultQuestionsDir = path.join(benchDir, 'questions');
  const questionsDir = path.resolve(options.questionsDir ?? defaultQuestionsDir);
  const enforceBuiltinSets = options.requireBuiltinSets
    ?? (canonicalPath(questionsDir) === canonicalPath(defaultQuestionsDir));
  const outDir = options.outDir === null ? null : path.resolve(options.outDir ?? path.join(REPO, 'out/exam'));
  const dryRun = Boolean(options.dryRun);
  const evaluators = options.evaluators ?? null;
  const startedAt = Date.now();

  const files = discoverQuestionFiles(questionsDir);
  const writeOut = (report) => {
    if (!outDir) return [];
    fs.mkdirSync(outDir, { recursive: true });
    const reportFile = path.join(outDir, 'report.json');
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return [reportFile];
  };

  if (files.length === 0) {
    const baseReport = {
      format: EXAM_REPORT_FORMAT,
      ok: false,
      exitCode: 4,
      command: 'beiming/bench/exam.mjs',
      dryRun,
      questionsDir,
      wallMs: Date.now() - startedAt,
      summary: {
        totalQuestions: 0,
        validQuestions: 0,
        invalidQuestions: 0,
        evaluatedQuestions: 0,
        skippedQuestions: 0,
        passedQuestions: 0,
        failedQuestions: 0,
        negativeControlsChecked: 0,
        negativeControlsRejected: 0,
      },
      questions: [],
      outputs: [],
      error: {
        code: 'contract.empty-question-set',
        message: `题库目录为空或不存在：${questionsDir}`,
        hint: '确认 beiming/bench/questions/ 下存在公开考题 JSON 文件',
      },
      createdAt: new Date().toISOString(),
    };
    baseReport.outputs = writeOut(baseReport);
    return baseReport;
  }

  const seenIds = new Map();
  const entries = [];
  for (const file of files) {
    const relFile = path.relative(questionsDir, file).split(path.sep).join('/');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      entries.push({ file: relFile, absFile: file, id: null, level: null, valid: false, errors: [`无法读取文件：${e.message}`] });
      continue;
    }
    const rawVerdict = validateQuestion(raw);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* validateQuestion 已捕获 parseError */ }
    const objVerdict = parsed ? validateQuestion(parsed) : rawVerdict;
    const errors = [];
    if (!rawVerdict.ok || !objVerdict.ok) {
      if (rawVerdict.parseError) errors.push(rawVerdict.parseError);
      if (rawVerdict.leaks?.length) errors.push(`泄露 ${rawVerdict.leaks.length} 处`);
      if (rawVerdict.schemaErrors?.length) errors.push(`结构错误 ${rawVerdict.schemaErrors.length} 处`);
      for (const [rule, list] of Object.entries(rawVerdict.violations ?? {})) {
        errors.push(`${rule}: ${list.join('；')}`);
      }
    }
    if (parsed && errors.length === 0) {
      if (seenIds.has(parsed.id)) {
        errors.push(`题号 ${parsed.id} 与 ${seenIds.get(parsed.id)} 重复`);
      } else {
        seenIds.set(parsed.id, relFile);
      }
      try {
        const pub = projectPublicQuestion(parsed);
        if ('ext' in pub) errors.push('公开投影未剥离私有 ext 字段');
      } catch (e) {
        errors.push(`公开投影失败：${e.message}`);
      }
      errors.push(...validateRefs(parsed, benchDir));
    }
    entries.push({
      file: relFile,
      absFile: file,
      id: parsed?.id ?? null,
      level: parsed?.level ?? null,
      question: parsed,
      valid: errors.length === 0,
      errors,
    });
  }

  const missingSetErrors = checkRequiredQuestionSets({
    questionsDir,
    entries,
    enforceBuiltinSets,
  });
  const hasMissingSets = missingSetErrors.length > 0;
  const hasInvalidEntries = entries.some((entry) => !entry.valid);
  const contractFailed = hasMissingSets || hasInvalidEntries;

  const ownTempRoot = !dryRun && !contractFailed && !options.evalRoot
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-exam-'))
    : null;
  const evalRoot = options.evalRoot ? path.resolve(options.evalRoot) : ownTempRoot;

  const questionReports = [];
  let negativeControlsChecked = 0;
  let negativeControlsRejected = 0;

  try {
    for (const entry of entries) {
      if (!entry.valid) {
        questionReports.push({
          file: entry.file,
          id: entry.id,
          level: entry.level,
          valid: false,
          status: 'invalid',
          pass: false,
          score: 0,
          negativeControlsChecked: 0,
          negativeControlsRejected: 0,
          errors: entry.errors,
        });
        continue;
      }

      if (contractFailed) {
        questionReports.push({
          file: entry.file,
          id: entry.id,
          level: entry.level,
          valid: true,
          status: 'skipped-contract-error',
          pass: false,
          score: 0,
          negativeControlsChecked: 0,
          negativeControlsRejected: 0,
          errors: [],
        });
        continue;
      }

      if (dryRun) {
        const expectedSkip = Boolean(entry.question.flags?.expectedFail);
        questionReports.push({
          file: entry.file,
          id: entry.id,
          level: entry.level,
          valid: true,
          status: expectedSkip ? 'expected-fail' : 'validated',
          pass: !expectedSkip,
          score: expectedSkip ? 0 : 1,
          negativeControlsChecked: 0,
          negativeControlsRejected: 0,
          errors: [],
        });
        continue;
      }

      const customEval = evaluators && Object.hasOwn(evaluators, entry.id) ? evaluators[entry.id] : null;
      const checkOutcomeControls = (out) => {
        if (!isPlainObj(out)) return false;
        const ctrlField = out.controlsOk === undefined ? true : out.controlsOk;
        if (ctrlField !== true) return false;
        const hasChecked = out.negativeControlsChecked !== undefined;
        const hasRejected = out.negativeControlsRejected !== undefined;
        if (!hasChecked && !hasRejected) return true;
        return Number.isInteger(out.negativeControlsChecked)
          && Number.isInteger(out.negativeControlsRejected)
          && out.negativeControlsChecked > 0
          && out.negativeControlsRejected === out.negativeControlsChecked;
      };
      let evalOutcome = null;
      const runResult = await runExamQuestion({
        questionFile: entry.absFile,
        evalRoot,
        solver: async ({ worktreeDir, questionFile }) => {
          const projected = JSON.parse(fs.readFileSync(questionFile, 'utf8'));
          if (projected.id !== entry.id) throw new Error(`公开投影题号不匹配：${projected.id} !== ${entry.id}`);
          fs.writeFileSync(
            path.join(worktreeDir, 'submission.json'),
            `${JSON.stringify({ questionId: entry.id, mode: 'offline-exam', cost: { gpuSeconds: 0 } }, null, 2)}\n`,
            'utf8',
          );
          return { tokens: 0, turns: 1, toolCalls: 0, gpuSeconds: 0 };
        },
        judge: async ({ question }) => {
          evalOutcome = customEval
            ? await customEval({ question, questionFile: entry.absFile, benchDir })
            : evaluateOfflineQuestion({ question, questionFile: entry.absFile, benchDir });
          const controlsOk = checkOutcomeControls(evalOutcome);
          const rawPreds = isPlainObj(evalOutcome?.predicates) ? evalOutcome.predicates : {};
          const rawMetrics = isPlainObj(evalOutcome?.metrics) ? evalOutcome.metrics : {};
          const judgedTrue = (table, key) => {
            const v = Object.hasOwn(table, key) ? table[key] : null;
            return v === true || v?.pass === true;
          };
          const wouldFakePass = !evalOutcome?.pass
            && (question.basePredicates ?? []).every((p) => judgedTrue(rawPreds, p))
            && (question.scoring ?? []).every((s) => judgedTrue(rawMetrics, s.metric));
          const metrics = controlsOk && !wouldFakePass
            ? rawMetrics
            : Object.fromEntries(
                (question.scoring ?? []).map((s) => [
                  s.metric,
                  {
                    pass: false,
                    basis: rawMetrics[s.metric]?.basis ?? (controlsOk ? 'offline-eval-failed' : 'offline-eval-control-mismatch'),
                  },
                ]),
              );
          return {
            predicates: rawPreds,
            metrics,
            cost: { gpuSeconds: 0 },
          };
        },
      });

      const expectedSkip = Boolean(entry.question.flags?.expectedFail) && runResult.status === 'expected-fail';
      if (expectedSkip) {
        questionReports.push({
          file: entry.file,
          id: entry.id,
          level: entry.level,
          valid: true,
          status: 'expected-fail',
          pass: false,
          score: runResult.score,
          runId: runResult.runId,
          negativeControlsChecked: 0,
          negativeControlsRejected: 0,
          errors: [],
        });
        continue;
      }

      const rawNegChecked = evalOutcome?.negativeControlsChecked;
      const rawNegRejected = evalOutcome?.negativeControlsRejected;
      const negChecked = Number.isInteger(rawNegChecked) && rawNegChecked >= 0 ? rawNegChecked : 0;
      const negRejected = Number.isInteger(rawNegRejected) && rawNegRejected >= 0 ? rawNegRejected : 0;
      negativeControlsChecked += negChecked;
      negativeControlsRejected += negRejected;

      const controlsOk = checkOutcomeControls(evalOutcome);
      const runnerOk = runResult.format === RESULT_FORMAT && fs.existsSync(runResult.resultFile) && runResult.pass === true;
      const evalOk = Boolean(evalOutcome?.pass) && controlsOk;
      const pass = runnerOk && evalOk;
      const errors = [];
      if (!pass) {
        if (runResult.error) errors.push(runResult.error);
        if (evalOutcome?.detail && evalOutcome.detail !== 'ok') errors.push(evalOutcome.detail);
        if (!errors.length) errors.push(`runner 状态 ${runResult.status}，得分 ${runResult.score}`);
      }

      questionReports.push({
        file: entry.file,
        id: entry.id,
        level: entry.level,
        valid: true,
        status: pass ? runResult.status : 'fail',
        pass,
        score: runResult.score,
        runId: runResult.runId,
        negativeControlsChecked: negChecked,
        negativeControlsRejected: negRejected,
        errors,
      });
    }
  } finally {
    if (ownTempRoot) {
      fs.rmSync(ownTempRoot, { recursive: true, force: true });
    }
  }

  const totalQuestions = questionReports.length;
  const validQuestions = questionReports.filter((q) => q.valid).length;
  const invalidQuestions = totalQuestions - validQuestions;
  const skippedQuestions = questionReports.filter((q) => q.status === 'expected-fail').length;
  const evaluatedQuestions = dryRun || contractFailed
    ? 0
    : questionReports.filter((q) => q.valid && q.status !== 'expected-fail').length;
  const passedQuestions = questionReports.filter((q) => q.pass).length;
  const failedQuestions = questionReports.filter((q) => !q.pass && q.status !== 'expected-fail' && q.status !== 'skipped-contract-error').length;
  const noEvaluated = !dryRun && !contractFailed && invalidQuestions === 0 && evaluatedQuestions === 0;
  const ok = totalQuestions > 0 && invalidQuestions === 0 && !hasMissingSets && failedQuestions === 0 && !noEvaluated;
  const exitCode = ok ? 0 : (invalidQuestions > 0 || hasMissingSets) ? 4 : 1;

  const report = {
    format: EXAM_REPORT_FORMAT,
    ok,
    exitCode,
    command: 'beiming/bench/exam.mjs',
    dryRun,
    questionsDir,
    wallMs: Date.now() - startedAt,
    summary: {
      totalQuestions,
      validQuestions,
      invalidQuestions,
      evaluatedQuestions,
      skippedQuestions,
      passedQuestions,
      failedQuestions,
      negativeControlsChecked,
      negativeControlsRejected,
    },
    missingQuestionSets: missingSetErrors,
    questions: questionReports,
    outputs: [],
    error: ok
      ? null
      : invalidQuestions > 0
        ? {
            code: 'contract.question-invalid',
            message: `${invalidQuestions} 道考题或参考夹具未通过契约校验`,
            hint: '检查 questions[].errors 中的失败原因',
          }
        : hasMissingSets
          ? {
              code: 'contract.missing-question-set',
              message: missingSetErrors.join('；'),
              hint: '确认 beiming/bench/questions/ 下全部内置题集目录及题目文件完整存在',
            }
          : noEvaluated
            ? {
                code: 'exam.no-evaluated-questions',
                message: `整场考试实际执行并计分的题目数为 0（共 ${skippedQuestions} 题全部为 expected-fail 跳过），禁止假绿`,
                hint: '确认题库包含至少一道可执行评测的公开考题',
              }
            : {
                code: 'exam.verification-failed',
                message: `${failedQuestions} 道考题未通过离线考试核验`,
                hint: '检查 questions[].errors 中的失败原因',
              },
    createdAt: new Date().toISOString(),
  };
  report.outputs = writeOut(report);
  return report;
}

export function parseExamArgs(argv) {
  const opts = { outDir: path.join(REPO, 'out/exam'), json: false, dryRun: false, questionsDir: path.join(HERE, 'questions'), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--out') {
      const val = argv[++i];
      if (!val || val.startsWith('-')) throw Object.assign(new Error('--out 需要指定目录路径'), { exitCode: 2, code: 'usage.missing-out' });
      opts.outDir = path.resolve(val);
    } else if (arg === '--questions') {
      const val = argv[++i];
      if (!val || val.startsWith('-')) throw Object.assign(new Error('--questions 需要指定题库目录路径'), { exitCode: 2, code: 'usage.missing-questions' });
      opts.questionsDir = path.resolve(val);
    } else {
      throw Object.assign(new Error(`未知参数：${arg}`), { exitCode: 2, code: 'usage.unknown-option' });
    }
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseExamArgs(argv);
  } catch (e) {
    const code = e.exitCode ?? 2;
    const errObj = {
      format: EXAM_REPORT_FORMAT,
      ok: false,
      exitCode: code,
      command: 'beiming/bench/exam.mjs',
      error: { code: e.code ?? 'usage.bad-args', message: e.message, hint: '运行 node beiming/bench/exam.mjs --help 查看用法' },
    };
    process.stdout.write(`${JSON.stringify(errObj, null, 2)}\n`);
    process.stderr.write(`${e.message}\n`);
    return code;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const report = await runExam({
    questionsDir: opts.questionsDir,
    outDir: opts.outDir,
    dryRun: opts.dryRun,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.stderr.write(`考试核验未通过（exit ${report.exitCode}）：${report.error?.message ?? '原因不明'}\n`);
  } else {
    const skipNote = report.summary.skippedQuestions > 0 ? `，跳过 ${report.summary.skippedQuestions} 题` : '';
    process.stderr.write(
      `考试核验通过：共 ${report.summary.totalQuestions} 题（通过 ${report.summary.passedQuestions} 题${skipNote}，拦截负对照 ${report.summary.negativeControlsRejected}/${report.summary.negativeControlsChecked} 份）\n`,
    );
  }
  return report.exitCode;
}

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const code = await main();
  process.exit(code);
}
