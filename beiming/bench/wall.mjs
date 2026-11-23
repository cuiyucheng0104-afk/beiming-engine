// 成片墙、原话账本五步流程与盲选页（B11，06 M2-7 & §8）：
//   1. 成片墙（Daily Film Wall）：buildFilmWall / renderFilmWallHtml
//   2. 原话账本（Verbatim Rejection Ledger）五步流程：
//      recordRejection -> translateRejection -> confirmRejectionTriage -> recordLedgerRead -> computeWeeklyRejectionStats
//      以及 loadLedgerState / renderLedgerHtml
//   3. 盲选页（Blind A/B Page）：createBlindSession / renderBlindPageHtml / recordBlindBallot / unblindBlindSession
// 口径约定：纯构建与计分函数不读墙钟、不调 Math.random；入参须为普通 JSON 对象与数组（不防调用方自造的 Proxy/getter），
// 严格防御丙类外部输入的 HTML XSS、媒体路径穿越与宿主绝对路径、非法候选谓词入模板及盲选来源标签泄露。细则见 DETAILS.md。
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isCalendarDate } from '../cards/status.mjs';
import { isPlainObject, withFileLock } from '../jobs/ledger.mjs';
import { checkExtra } from '../verify/predicates.mjs';
import { escapeHtml } from './board.mjs';
import { scanQuestionLeaks } from './validate-question.mjs';

export const WALL_FORMAT = 'bench-wall/0.1';
export const LEDGER_FORMAT = 'bench-rejection-ledger/0.1';
export const BLIND_PUBLIC_FORMAT = 'bench-blind-public/0.1';
export const BLIND_KEY_FORMAT = 'bench-blind-key/0.1';
export const BLIND_BALLOT_FORMAT = 'bench-blind-ballot/0.1';
export const BLIND_REPORT_FORMAT = 'bench-blind-report/0.1';
export const DEFAULT_MAX_DAILY = 5;
export const AGREEMENT_DISABLE_THRESHOLD = 0.6;
export const MISSED_LAYERS = Object.freeze(['L1', 'L2', 'L3', 'L4', 'L5']);

const LEDGER_EVENT_FORMAT = 'bench-rejection-event/0.1';
const CONTROLLED_ROUTE_PREFIX = /^\/(?:api|artifacts|media|blind|wall|films|refs)\//;
const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|mkv)(?:[?#].*)?$/i;
const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const FORBIDDEN_BLIND_WORDS = [
  'beiming',
  '北冥',
  'cycles',
  'blender',
  'reference',
  'raea',
  'threert',
  'gpt',
  'candidatea',
  'candidateb',
  'answerkey',
  'leftsource',
  'rightsource',
  'targetsource',
  'reviewerchoice',
];

/* ---------------- 基础校验与纯日历工具 ---------------- */

function bad(message, Type = TypeError, extra = {}) {
  const err = new Type(message);
  for (const [k, v] of Object.entries({ code: 'usage.bad-argument', exitCode: 2, ...extra })) {
    Object.defineProperty(err, k, { __proto__: null, value: v, enumerable: true, writable: true, configurable: true });
  }
  throw err;
}

const plainObj = (v, at) => (isPlainObject(v) ? v : bad(`${at} 必须是普通对象`));
const nonEmptyText = (v, at) => {
  if (typeof v !== 'string' || !v.isWellFormed() || v.trim().length === 0 || v.includes('\0')) {
    bad(`${at} 必须是非空字符串`);
  }
  return v;
};
const optText = (v, at) => (v === undefined || v === null ? null : nonEmptyText(v, at));
const safeInt = (v, at, min = 0) => {
  if (!Number.isSafeInteger(v) || v < min) bad(`${at} 必须是不小于 ${min} 的安全整数`, RangeError);
  return v;
};
const calendarDay = (v, at) => (isCalendarDate(v) ? v : bad(`${at} 必须是合法的 YYYY-MM-DD 日期`, RangeError));
const oneOf = (v, choices, at) => (choices.includes(v) ? v : bad(`${at} 只能是 ${choices.join(' / ')}`, RangeError));

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = freezeDeep(v);
  return Object.freeze(out);
}

/** 公历日期 -> 连续日序数（不经 Date，零时区/墙钟依赖）。 */
function dayNumber(date) {
  const [year, month, d] = date.split('-').map(Number);
  const y = month <= 2 ? year - 1 : year;
  const yearOfEra = y - Math.floor(y / 400) * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return Math.floor(y / 400) * 146097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
}

/** 连续日序数 -> YYYY-MM-DD。 */
function dateFromDayNumber(z) {
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = y + (m <= 2 ? 1 : 0);
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 解析并校验 ISO-8601 时间戳（必须含时区 Z 或 ±HH:MM），返回纳秒级纪元时刻与日期前缀。 */
function parseIsoTimestamp(value, at) {
  if (typeof value !== 'string' || !value.isWellFormed()) bad(`${at} 必须是 ISO-8601 时间戳字符串`);
  const m = ISO_TS_RE.exec(value);
  if (!m) bad(`${at} 必须是带时区的 ISO-8601 时间戳（如 2026-11-23T10:00:00Z）`, RangeError);
  const [, datePart, hhRaw, mmRaw, ssRaw, fracRaw = '', tzRaw, tzSign, tzHhRaw, tzMmRaw] = m;
  if (!isCalendarDate(datePart)) bad(`${at} 中的日历日期无效`, RangeError);
  const hh = Number(hhRaw), mm = Number(mmRaw), ss = Number(ssRaw);
  if (hh > 23 || mm > 59 || ss > 59) bad(`${at} 中的时分秒超出范围`, RangeError);
  let offsetSec = 0;
  if (tzRaw !== 'Z') {
    const tzH = Number(tzHhRaw), tzM = Number(tzMmRaw);
    if (tzH > 23 || tzM > 59) bad(`${at} 中的时区偏移超出范围`, RangeError);
    offsetSec = (tzSign === '-' ? -1 : 1) * (tzH * 3600 + tzM * 60);
  }
  const epochDays = BigInt(dayNumber(datePart) - 719468);
  const totalSec = epochDays * 86400n + BigInt(hh * 3600 + mm * 60 + ss - offsetSec);
  const nanos = BigInt(fracRaw.padEnd(9, '0'));
  return { raw: value, datePart, epochNs: totalSec * 1_000_000_000n + nanos };
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function seededBool(seed, index, salt = 'blind') {
  const digest = createHash('sha256').update(`${String(seed)}\0${salt}\0${index}`).digest();
  return (digest.readUInt32BE(0) & 1) === 1;
}

function normalizeSeed(seed, fallback) {
  if (seed === undefined) return String(fallback);
  if (typeof seed === 'number') {
    if (!Number.isSafeInteger(seed)) bad('seed 为数字时必须是安全整数', RangeError);
    return String(seed);
  }
  if (typeof seed === 'string' && seed.isWellFormed() && seed.length > 0) return seed;
  bad('seed 必须是非空字符串或安全整数');
}

const hasPrivateMarker = (s) => scanQuestionLeaks(String(s)).some((l) => l.code !== 'local-path');

function safeDecodePercentOnce(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    // 容错非法 % 序列：逐段解码合法的 UTF-8 百分号编码字节串，保留非法裸 %
    return str.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

function hasParentSegment(part) {
  if (!part) return false;
  for (const token of part.split(/[&;]/)) {
    for (const piece of token.split('=')) {
      const decoded = safeDecodePercentOnce(piece).normalize('NFKC');
      if (decoded.split(/[\\/]/).some((seg) => seg === '..')) return true;
    }
  }
  return false;
}

/**
 * 校验只读媒体路径：
 * - 允许相对路径（如 films/01/deliver.mp4）或受控站点路由前缀（/api/、/artifacts/、/media/、/blind/、/wall/、/films/、/refs/）；
 * - 严拒 `..` 穿越（含百分号编码、查询串与片段参数）、反斜杠、控制字符、空白、任意协议头（http/https/javascript/data/file 等）、`//` 外链、宿主系统绝对路径与盘符。
 */
export function checkSafeMediaUrl(url, at = 'mediaUrl') {
  if (typeof url !== 'string' || !url.isWellFormed() || url.length === 0) bad(`${at} 必须是非空字符串`);
  if (/[\p{Cc}\s\\]/u.test(url)) bad(`${at} 含有空白、控制字符或反斜杠`);
  if (url === '~' || url.startsWith('~/') || url.includes('//') || url.includes(':')) {
    bad(`${at} 不得使用外部协议、盘符、双斜杠或家目录路径`);
  }
  const variants = [url];
  let cur = url;
  for (let round = 0; round < 3 && cur.includes('%'); round += 1) {
    let next;
    try {
      next = decodeURIComponent(cur);
    } catch {
      bad(`${at} 百分号编码不合法`);
    }
    if (next === cur) break;
    variants.push(next);
    cur = next;
  }
  if (cur.includes('%')) bad(`${at} 不得多重百分号编码`);

  for (const candidate of variants) {
    const normalized = candidate.normalize('NFKC');
    for (const text of [candidate, normalized]) {
      if (/[\p{Cc}\s\\:]/u.test(text) || text.includes('//') || text === '~' || text.startsWith('~/')) {
        bad(`${at} 解码后含有非法路径字符或协议`);
      }
      if (hasPrivateMarker(text)) {
        bad(`${at} 含有受限私有标记`);
      }
      if (/(?:^|[/?#&=;,])\.{2}(?:[/?#&=;,]|$)/.test(text)) {
        bad(`${at} 含有路径穿越段`);
      }
      const hashIdx = text.indexOf('#');
      const beforeHash = hashIdx >= 0 ? text.slice(0, hashIdx) : text;
      const hashPart = hashIdx >= 0 ? text.slice(hashIdx + 1) : '';
      const queryIdx = beforeHash.indexOf('?');
      const queryPart = queryIdx >= 0 ? beforeHash.slice(queryIdx + 1) : '';
      if (hasParentSegment(queryPart) || hasParentSegment(hashPart)) {
        bad(`${at} 查询参数或片段含有路径穿越段`);
      }
      const cleanPath = beforeHash.slice(0, queryIdx >= 0 ? queryIdx : beforeHash.length);
      if (!cleanPath || cleanPath.endsWith('/')) bad(`${at} 必须指向具体媒体文件`);
      if (cleanPath.startsWith('/')) {
        if (!CONTROLLED_ROUTE_PREFIX.test(cleanPath)) {
          bad(`${at} 不得使用未受控的宿主绝对路径`);
        }
        const segs = cleanPath.slice(1).split('/');
        if (segs.some((seg) => seg === '' || seg === '.' || seg === '..')) bad(`${at} 含有非法路径段`);
      } else {
        const segs = cleanPath.split('/');
        const rest = segs[0] === '.' ? segs.slice(1) : segs;
        if (rest.length === 0 || rest.some((seg) => seg === '' || seg === '.' || seg === '..')) {
          bad(`${at} 含有路径穿越或空路径段`);
        }
      }
    }
  }
  return url;
}

function ensureRegularTarget(filePath, what) {
  const st = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (st && (st.isSymbolicLink() || !st.isFile())) {
    bad(`${what}目标文件必须是普通文件（不接受软链接或目录）`);
  }
}

function hasDuplicateJsonKeys(raw) {
  const open = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i);
    if (ch === 123 || ch === 91) open.push(ch === 123 ? new Set() : null);
    else if (ch === 125 || ch === 93) open.pop();
    else if (ch === 34) {
      const start = i;
      for (i += 1; i < raw.length && raw.charCodeAt(i) !== 34; i += 1) {
        if (raw.charCodeAt(i) === 92) i += 1;
      }
      let next = i + 1;
      while (next < raw.length && raw.charCodeAt(next) <= 32) next += 1;
      if (raw.charCodeAt(next) === 58 && open.at(-1)) {
        const key = JSON.parse(raw.slice(start, i + 1));
        if (open.at(-1).has(key)) return true;
        open.at(-1).add(key);
        i = next;
      }
    }
  }
  return false;
}

function checkControlledDir(dir, what) {
  nonEmptyText(dir, `${what}目录`);
  if (hasPrivateMarker(dir)) bad(`${what}目录路径含有私有标记，拒绝读写`);
  const resolved = path.resolve(dir);
  const existing = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) bad(`${what}目录必须是真实目录（不接受软链接或普通文件）`);
  } else {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function atomicWriteJson(filePath, data) {
  ensureRegularTarget(filePath, '快照');
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}`);
  fs.writeFileSync(tmpFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpFile, filePath);
}

/* ---------------- HTML 模板与安全转义 ---------------- */

class SafeHtml {
  constructor(html) {
    this.html = html;
  }
}

const rawHtml = (str) => new SafeHtml(str);

function renderPiece(value) {
  if (Array.isArray(value)) return value.map(renderPiece).join('');
  if (value instanceof SafeHtml) return value.html;
  if (value === null || value === undefined) return '暂无';
  return escapeHtml(value);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += renderPiece(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '暂无');
const num = (v, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '暂无');
const fmtMetric = (v, digits = 4) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '暂无';
  const scaled = Math.round(v * 10 ** digits) / 10 ** digits;
  return String(Number.isFinite(scaled) ? scaled : v);
};

const BASE_STYLE = `
:root{color-scheme:light dark;--line:#8885;--soft:#8882;--accent:#2563eb;--bad:#dc2626;--ok:#16a34a}
*{box-sizing:border-box}
body{font:15px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0 auto;padding:24px;max-width:1360px}
header{border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:20px}
h1{margin:0 0 4px;font-size:24px}h2{margin:28px 0 12px;font-size:18px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{margin:0 0 8px;font-size:16px}
.note{opacity:.78;font-size:13px;margin:4px 0}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:20px}
.card{border:1px solid var(--line);border-radius:8px;padding:12px 16px;background:var(--soft)}
.film-card,.pair-card{border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:18px}
.side-by-side{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin:12px 0}
.pane{border:1px solid var(--line);border-radius:8px;padding:10px}
video,img{width:100%;max-height:360px;object-fit:contain;background:#000;border-radius:6px;display:block}
.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px;margin-right:6px}
.badge-fail{border-color:var(--bad);color:var(--bad);font-weight:600}
.badge-ok{border-color:var(--ok);color:var(--ok);font-weight:600}
dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0}dt{opacity:.75}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
thead th{background:var(--soft)}
.actions{margin-top:12px;padding-top:10px;border-top:1px dashed var(--line);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=text],input[type=number]{padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
button{padding:5px 12px;border:1px solid var(--line);border-radius:6px;cursor:pointer;background:var(--soft);color:inherit}
pre.export-box{padding:10px;border:1px solid var(--line);border-radius:6px;overflow-x:auto;font-size:12px;min-height:40px;white-space:pre-wrap}
`;

function mediaElement(mediaUrl, kind, altText) {
  const isVideo = kind === 'clip' || kind === 'video' || (kind !== 'still' && VIDEO_EXT_RE.test(mediaUrl));
  if (isVideo) {
    return html`<video controls preload="metadata" src="${mediaUrl}"></video>`;
  }
  return html`<img loading="lazy" src="${mediaUrl}" alt="${altText}">`;
}

/* ---------------- 1. 成片墙（Daily Film Wall） ---------------- */

function extractTallyRate(t) {
  if (!isPlainObject(t)) return null;
  if (typeof t.rate === 'number' && Number.isFinite(t.rate)) {
    return {
      rate: t.rate,
      passed: Number.isSafeInteger(t.passed) ? t.passed : null,
      total: Number.isSafeInteger(t.total) ? t.total : null,
    };
  }
  if (Number.isSafeInteger(t.passed) && Number.isSafeInteger(t.total) && t.total > 0) {
    return { rate: t.passed / t.total, passed: t.passed, total: t.total };
  }
  return null;
}

function normalizeIndicator(raw, kind) {
  if (raw === undefined || raw === null) return { value: null, display: '暂无', detail: null };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) bad(`fourIndicators.${kind} 必须是有限数`, RangeError);
    const display = kind === 'speedAndCost' ? `${raw.toFixed(2)} 秒/秒成片` : pct(raw);
    return { value: raw, display, detail: null };
  }
  const o = plainObj(raw, `fourIndicators.${kind}`);
  if (Object.hasOwn(o, 'value') && Object.hasOwn(o, 'display') && Object.keys(o).every((k) => ['value', 'display', 'detail'].includes(k))) {
    if (o.value !== null && (typeof o.value !== 'number' || !Number.isFinite(o.value))) bad(`fourIndicators.${kind}.value 非法`, RangeError);
    return { value: o.value, display: nonEmptyText(o.display, `fourIndicators.${kind}.display`), detail: o.detail ?? null };
  }
  if (kind === 'ceiling') {
    let passed = 0, total = 0;
    if (isPlainObject(o.passRateByLevel)) {
      for (const item of Object.values(o.passRateByLevel)) {
        if (isPlainObject(item) && Number.isFinite(item.passed) && Number.isFinite(item.total)) {
          passed += item.passed;
          total += item.total;
        }
      }
    }
    const levelRate = total > 0 ? passed / total : null;
    const blindRate = isPlainObject(o.blindPick) && typeof o.blindPick.rate === 'number' && Number.isFinite(o.blindPick.rate)
      ? o.blindPick.rate
      : null;
    const parityVal = isPlainObject(o.parityHeadroom) && typeof o.parityHeadroom.minMargin === 'number' && Number.isFinite(o.parityHeadroom.minMargin)
      ? o.parityHeadroom.minMargin
      : null;
    const rulerEntries = [];
    if (isPlainObject(o.energyRulers)) {
      for (const [name, ruler] of Object.entries(o.energyRulers)) {
        if (typeof ruler === 'number' && Number.isFinite(ruler)) {
          rulerEntries.push({ name, mean: ruler });
        } else if (isPlainObject(ruler) && typeof ruler.mean === 'number' && Number.isFinite(ruler.mean)) {
          rulerEntries.push({ name, mean: ruler.mean });
        }
      }
    }
    const primary = levelRate ?? blindRate ?? parityVal ?? (rulerEntries.length ? rulerEntries[0].mean : null);
    const parts = [];
    if (levelRate !== null) parts.push(`考题通过 ${passed}/${total}（${pct(levelRate)}）`);
    if (blindRate !== null) parts.push(`盲选赢或平 ${pct(blindRate)}`);
    if (levelRate === null && blindRate === null) {
      if (parityVal !== null) parts.push(`对拍最小余量 ${fmtMetric(parityVal, 4)}`);
      if (rulerEntries.length > 0) {
        parts.push(`能量尺 ${rulerEntries.map((r) => `${r.name}=${fmtMetric(r.mean, 4)}`).join(' / ')}`);
      }
    }
    if (!parts.length) return { value: null, display: '暂无', detail: o };
    return { value: primary, display: parts.join(' · '), detail: o };
  }
  if (kind === 'unattended') {
    const rate = typeof o.rate === 'number' && Number.isFinite(o.rate) ? o.rate : null;
    if (rate === null) return { value: null, display: '暂无', detail: o };
    const prefix = Number.isSafeInteger(o.succeeded) && Number.isSafeInteger(o.total) ? `${o.succeeded}/${o.total} ` : '';
    return { value: rate, display: `${prefix}（${pct(rate)}）`.trim(), detail: o };
  }
  if (kind === 'speedAndCost') {
    const wallSec = typeof o.wallSecPerFilmSec === 'number' && Number.isFinite(o.wallSecPerFilmSec) ? o.wallSecPerFilmSec : null;
    const gpuSec = typeof o.gpuSecPerFilmSec === 'number' && Number.isFinite(o.gpuSecPerFilmSec) ? o.gpuSecPerFilmSec : null;
    const tokens = typeof o.tokensPerFilmSec === 'number' && Number.isFinite(o.tokensPerFilmSec) ? o.tokensPerFilmSec : null;
    if (wallSec === null && gpuSec === null && tokens === null) return { value: null, display: '暂无', detail: o };
    const parts = [];
    if (wallSec !== null) parts.push(`墙钟 ${num(wallSec, 2)}s/s`);
    if (gpuSec !== null) parts.push(`GPU ${num(gpuSec, 2)}s/s`);
    if (tokens !== null) parts.push(`${Math.round(tokens)} tok/s`);
    return { value: wallSec ?? gpuSec ?? tokens, display: parts.join(' · '), detail: o };
  }
  if (kind === 'controllability') {
    const gate = extractTallyRate(o.pureFunctionGate);
    const loc = extractTallyRate(o.locality);
    const exact = isPlainObject(o.rebuild) ? extractTallyRate(o.rebuild.exact) : null;
    const tol = isPlainObject(o.rebuild) ? extractTallyRate(o.rebuild.tolerance) : null;
    const legacy = isPlainObject(o.rebuild) ? extractTallyRate(o.rebuild.nightlyLegacy) : null;
    const rates = [gate, loc, exact, tol, legacy].filter((r) => r !== null).map((r) => r.rate);
    if (!rates.length) return { value: null, display: '暂无', detail: o };
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    const parts = [];
    if (gate !== null) parts.push(`纯函数门 ${pct(gate.rate)}`);
    if (loc !== null) parts.push(`局部性 ${pct(loc.rate)}`);
    if (exact !== null) parts.push(`同机重建 ${pct(exact.rate)}`);
    if (tol !== null) {
      parts.push(
        tol.passed !== null && tol.total !== null
          ? `跨机容差 ${tol.passed}/${tol.total}（${pct(tol.rate)}）`
          : `跨机容差 ${pct(tol.rate)}`,
      );
    }
    if (legacy !== null) parts.push(`旧作品夜间重建 ${pct(legacy.rate)}`);
    return { value: avg, display: parts.join(' · '), detail: o };
  }
  return { value: null, display: '暂无', detail: null };
}

function normalizeFourIndicators(scoreboard) {
  if (scoreboard === undefined || scoreboard === null) {
    return {
      ceiling: { value: null, display: '暂无', detail: null },
      unattended: { value: null, display: '暂无', detail: null },
      speedAndCost: { value: null, display: '暂无', detail: null },
      controllability: { value: null, display: '暂无', detail: null },
    };
  }
  const root = plainObj(scoreboard, 'scoreboard');
  const source = isPlainObject(root.fourIndicators) ? root.fourIndicators : root;
  return {
    ceiling: normalizeIndicator(source.ceiling, 'ceiling'),
    unattended: normalizeIndicator(source.unattended, 'unattended'),
    speedAndCost: normalizeIndicator(source.speedAndCost, 'speedAndCost'),
    controllability: normalizeIndicator(source.controllability, 'controllability'),
  };
}

function normalizeUnmeasurableList(listInput, at = 'unmeasurableDimensions') {
  if (listInput === undefined || listInput === null) return [];
  if (!Array.isArray(listInput)) bad(`${at} 必须是数组`);
  const seen = new Set();
  const out = [];
  listInput.forEach((item, idx) => {
    let normalized;
    if (typeof item === 'string') {
      normalized = { dimension: nonEmptyText(item, `${at}[${idx}]`), template: '*', reason: null };
    } else {
      const o = plainObj(item, `${at}[${idx}]`);
      normalized = {
        dimension: nonEmptyText(o.dimension, `${at}[${idx}].dimension`),
        template: o.template === undefined ? '*' : nonEmptyText(o.template, `${at}[${idx}].template`),
        reason: optText(o.reason, `${at}[${idx}].reason`),
      };
    }
    const key = `${normalized.template}\0${normalized.dimension}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
  });
  return out;
}

/**
 * 组装每日成片墙快照：
 * - 默认最多抽样 `maxDaily`（5）条成功片；当 `includeAllFailed !== false` 时，所有 `ok === false` 失败片全数保留并另列。
 */
export function buildFilmWall(options) {
  const opts = plainObj(options, 'buildFilmWall 入参');
  const date = calendarDay(opts.date, 'date');
  const maxDaily = opts.maxDaily === undefined ? DEFAULT_MAX_DAILY : safeInt(opts.maxDaily, 'maxDaily', 1);
  const includeAllFailed = opts.includeAllFailed === undefined ? true : Boolean(opts.includeAllFailed);
  if (opts.includeAllFailed !== undefined && typeof opts.includeAllFailed !== 'boolean') {
    bad('includeAllFailed 必须是布尔值');
  }
  const seed = normalizeSeed(opts.seed, `wall:${date}`);
  if (!Array.isArray(opts.films)) bad('films 必须是数组');

  const fourIndicators = normalizeFourIndicators(opts.scoreboard);
  const unmeasurableDimensions = normalizeUnmeasurableList(opts.unmeasurableDimensions);
  const seenIds = new Set();

  const normalizedFilms = opts.films.map((raw, i) => {
    const f = plainObj(raw, `films[${i}]`);
    const filmId = nonEmptyText(f.filmId, `films[${i}].filmId`);
    if (seenIds.has(filmId)) bad(`films 里存在重复的 filmId: ${filmId}`);
    seenIds.add(filmId);
    const filmDate = f.date === undefined ? date : calendarDay(f.date, `films[${i}].date`);
    const template = nonEmptyText(f.template, `films[${i}].template`);
    const mediaUrl = checkSafeMediaUrl(f.mediaUrl ?? f.videoUrl, `films[${i}].mediaUrl`);
    const mediaKind = f.mediaKind === undefined ? (VIDEO_EXT_RE.test(mediaUrl) ? 'video' : 'still') : oneOf(f.mediaKind, ['video', 'still', 'clip'], `films[${i}].mediaKind`);

    let reference = null;
    if (f.reference !== undefined && f.reference !== null) {
      const refObj = typeof f.reference === 'string' ? { mediaUrl: f.reference } : plainObj(f.reference, `films[${i}].reference`);
      const refUrl = checkSafeMediaUrl(refObj.mediaUrl ?? refObj.url, `films[${i}].reference.mediaUrl`);
      const refKind = refObj.kind === undefined ? (VIDEO_EXT_RE.test(refUrl) ? 'video' : 'still') : oneOf(refObj.kind, ['video', 'still', 'clip'], `films[${i}].reference.kind`);
      reference = {
        mediaUrl: refUrl,
        label: optText(refObj.label, `films[${i}].reference.label`) ?? '并排参考片',
        kind: refKind,
      };
    } else if (f.referenceUrl !== undefined && f.referenceUrl !== null) {
      const refUrl = checkSafeMediaUrl(f.referenceUrl, `films[${i}].referenceUrl`);
      reference = {
        mediaUrl: refUrl,
        label: optText(f.referenceLabel, `films[${i}].referenceLabel`) ?? '并排参考片',
        kind: VIDEO_EXT_RE.test(refUrl) ? 'video' : 'still',
      };
    }

    const ok = f.ok === undefined ? true : (typeof f.ok === 'boolean' ? f.ok : bad(`films[${i}].ok 必须是布尔值`));
    const reviewStatus = f.reviewStatus === undefined ? 'pending' : oneOf(f.reviewStatus, ['pending', 'approved', 'rejected'], `films[${i}].reviewStatus`);
    const rejectionVerbatim = f.rejectionVerbatim === undefined || f.rejectionVerbatim === null
      ? null
      : (typeof f.rejectionVerbatim === 'string' && f.rejectionVerbatim.isWellFormed() ? f.rejectionVerbatim : bad(`films[${i}].rejectionVerbatim 必须是合法字符串`));

    const ownDims = normalizeUnmeasurableList(f.unmeasurableDimensions, `films[${i}].unmeasurableDimensions`);
    const matchedDims = [
      ...unmeasurableDimensions.filter((d) => d.template === template || d.template === '*'),
      ...ownDims,
    ];
    const dedupDims = [];
    const dimKeys = new Set();
    for (const d of matchedDims) {
      if (!dimKeys.has(d.dimension)) {
        dimKeys.add(d.dimension);
        dedupDims.push(d);
      }
    }

    return {
      index: i,
      filmId,
      title: optText(f.title, `films[${i}].title`) ?? filmId,
      date: filmDate,
      template,
      mediaUrl,
      mediaKind,
      reference,
      ok,
      reviewStatus,
      rejectionVerbatim,
      fourIndicators: f.scoreboard !== undefined ? normalizeFourIndicators(f.scoreboard) : fourIndicators,
      unmeasurableDimensions: dedupDims,
    };
  });

  const forDate = normalizedFilms.filter((f) => f.date === date);
  const failed = forDate.filter((f) => !f.ok);
  const passed = forDate.filter((f) => f.ok);

  const sampleSubset = (items, limit) => {
    if (items.length <= limit) return items;
    return [...items]
      .map((item) => ({ item, rank: sha256Hex(`${seed}\0wall\0${item.index}:${item.filmId}`) }))
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.item.index - b.item.index))
      .slice(0, limit)
      .sort((a, b) => a.item.index - b.item.index)
      .map(({ item }) => item);
  };

  let chosen;
  let sampledPassedCount;
  if (includeAllFailed) {
    const sampledPassed = sampleSubset(passed, maxDaily);
    sampledPassedCount = sampledPassed.length;
    chosen = [...failed, ...sampledPassed].sort((a, b) => a.index - b.index);
  } else {
    chosen = sampleSubset(forDate, maxDaily);
    sampledPassedCount = chosen.filter((f) => f.ok).length;
  }

  const cleanFilms = chosen.map(({ index: _idx, ...rest }) => rest);
  return freezeDeep({
    format: WALL_FORMAT,
    date,
    seed,
    fourIndicators,
    unmeasurableDimensions,
    summary: {
      totalInput: normalizedFilms.length,
      totalForDate: forDate.length,
      shownCount: cleanFilms.length,
      failedCount: cleanFilms.filter((f) => !f.ok).length,
      sampledPassedCount,
      maxDaily,
      includeAllFailed,
    },
    films: cleanFilms,
  });
}

const REVIEW_STATUS_LABEL = { pending: '待看', approved: '过', rejected: '已打回' };

// 纯静态客户端交互脚本：零动态插值，仅读写受控 DOM 属性与 textContent，杜绝脚本上下文 XSS。
const WALL_UI_SCRIPT = `
document.addEventListener('click', function (ev) {
  var btn = ev.target.closest('button[data-wall-action]');
  if (!btn) return;
  var card = btn.closest('[data-film-id]');
  if (!card) return;
  var filmId = card.getAttribute('data-film-id') || '';
  var template = card.getAttribute('data-film-template') || '';
  var action = btn.getAttribute('data-wall-action');
  var statusEl = card.querySelector('[data-role="status-label"]');
  var outBox = document.getElementById('wall-decisions-json');
  window.__wallDecisions = window.__wallDecisions || {};
  var now = new Date().toISOString();
  if (action === 'approve') {
    window.__wallDecisions[filmId] = { filmId: filmId, template: template, decision: 'approved', at: now };
    if (statusEl) statusEl.textContent = '过';
  } else if (action === 'reject') {
    var startInput = card.querySelector('[name="frameStart"]');
    var endInput = card.querySelector('[name="frameEnd"]');
    var catInput = card.querySelector('[name="category"]');
    var verbInput = card.querySelector('[name="verbatim"]');
    var verbatim = verbInput ? verbInput.value : '';
    if (!verbatim || !verbatim.trim()) return;
    var s = Number(startInput && startInput.value ? startInput.value : 0);
    var e = Number(endInput && endInput.value ? endInput.value : s);
    var rawCat = catInput && catInput.value ? catInput.value.trim() : '';
    window.__wallDecisions[filmId] = {
      filmId: filmId,
      template: template,
      decision: 'rejected',
      frames: [s, e],
      category: rawCat ? rawCat : null,
      verbatim: verbatim,
      at: now
    };
    if (statusEl) statusEl.textContent = '已打回';
  }
  if (outBox) outBox.textContent = JSON.stringify(window.__wallDecisions, null, 2);
});
`;

/** 渲染每日成片墙离线单页 HTML（零外网资源，全量转义）。 */
export function renderFilmWallHtml(wallInput) {
  const wall = plainObj(wallInput, 'wall');
  if (wall.format !== WALL_FORMAT) bad(`成片墙 format 必须是 ${WALL_FORMAT}`);
  calendarDay(wall.date, 'wall.date');
  if (!Array.isArray(wall.films)) bad('wall.films 必须是数组');
  const four = normalizeFourIndicators(wall.fourIndicators);
  const summary = plainObj(wall.summary ?? {}, 'wall.summary');

  const kpiHtml = html`<div class="kpi-grid">
    <div class="card"><h3>画面上限</h3><p>${four.ceiling.display}</p></div>
    <div class="card"><h3>无人值守成功率</h3><p>${four.unattended.display}</p></div>
    <div class="card"><h3>速度与成本</h3><p>${four.speedAndCost.display}</p></div>
    <div class="card"><h3>可控与可复现</h3><p>${four.controllability.display}</p></div>
  </div>`;

  const filmCards = wall.films.map((rawFilm, idx) => {
    const f = plainObj(rawFilm, `wall.films[${idx}]`);
    const filmId = nonEmptyText(f.filmId, `wall.films[${idx}].filmId`);
    const template = nonEmptyText(f.template, `wall.films[${idx}].template`);
    const title = optText(f.title, `wall.films[${idx}].title`) ?? filmId;
    const mediaUrl = checkSafeMediaUrl(f.mediaUrl, `wall.films[${idx}].mediaUrl`);
    const reviewStatus = oneOf(f.reviewStatus ?? 'pending', ['pending', 'approved', 'rejected'], `wall.films[${idx}].reviewStatus`);
    const filmFour = f.fourIndicators ? normalizeFourIndicators(f.fourIndicators) : four;
    const dims = normalizeUnmeasurableList(f.unmeasurableDimensions ?? [], `wall.films[${idx}].unmeasurableDimensions`);

    let refPane = html`<div class="pane"><h4>并排参考</h4><p class="note">暂无参考片</p></div>`;
    if (f.reference !== null && f.reference !== undefined) {
      const ref = plainObj(f.reference, `wall.films[${idx}].reference`);
      const refUrl = checkSafeMediaUrl(ref.mediaUrl, `wall.films[${idx}].reference.mediaUrl`);
      const refLabel = optText(ref.label, `wall.films[${idx}].reference.label`) ?? '并排参考片';
      refPane = html`<div class="pane">
        <h4>并排参考：${refLabel}</h4>
        ${mediaElement(refUrl, ref.kind, refLabel)}
        <p class="note"><a href="${refUrl}">打开参考媒体（${refUrl}）</a></p>
      </div>`;
    }

    const dimsHtml = dims.length
      ? html`<p class="note"><strong>判不了的维度（请人工把关）：</strong>${dims.map((d) => html`<span class="badge" title="${d.reason ?? ''}">${d.dimension}</span>`)}</p>`
      : html`<p class="note">判不了的维度：暂无额外登记</p>`;

    const prevReject = typeof f.rejectionVerbatim === 'string' && f.rejectionVerbatim.length > 0
      ? html`<p class="note"><strong>已记打回原话：</strong>${f.rejectionVerbatim}</p>`
      : rawHtml('');

    return html`<article class="film-card" data-film-id="${filmId}" data-film-template="${template}">
      <div>
        <span class="badge">${filmId}</span>
        <span class="badge">片型：${template}</span>
        ${f.ok === false ? html`<span class="badge badge-fail">构建/验证失败必看</span>` : html`<span class="badge badge-ok">成片候选</span>`}
        <span class="badge" data-role="status-label">${REVIEW_STATUS_LABEL[reviewStatus]}</span>
        <h3>${title}</h3>
      </div>
      <div class="side-by-side">
        <div class="pane">
          <h4>今日成片</h4>
          ${mediaElement(mediaUrl, f.mediaKind, title)}
          <p class="note"><a href="${mediaUrl}">打开成片媒体（${mediaUrl}）</a></p>
        </div>
        ${refPane}
      </div>
      <dl>
        <dt>画面上限</dt><dd>${filmFour.ceiling.display}</dd>
        <dt>无人值守成功率</dt><dd>${filmFour.unattended.display}</dd>
        <dt>速度与成本</dt><dd>${filmFour.speedAndCost.display}</dd>
        <dt>可控与可复现</dt><dd>${filmFour.controllability.display}</dd>
      </dl>
      ${dimsHtml}
      ${prevReject}
      <div class="actions">
        <button type="button" data-wall-action="approve">过</button>
        <label>起始帧 <input type="number" name="frameStart" min="0" value="0" style="width:76px"></label>
        <label>结束帧 <input type="number" name="frameEnd" min="0" value="0" style="width:76px"></label>
        <input type="text" name="category" placeholder="问题归类（可选）" style="width:150px">
        <input type="text" name="verbatim" placeholder="写一句话打回（原字入账）" style="flex:1;min-width:220px">
        <button type="button" data-wall-action="reject">一句话打回</button>
      </div>
    </article>`;
  });

  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>北冥每日成片墙 ${wall.date}</title>
<style>${rawHtml(BASE_STYLE)}</style>
</head>
<body>
<header>
  <h1>北冥每日成片墙</h1>
  <p class="note">日期 <time>${wall.date}</time> · 展示 ${summary.shownCount ?? wall.films.length} 条（失败必看 ${summary.failedCount ?? 0} 条，成功抽样 ${summary.sampledPassedCount ?? wall.films.length} 条）</p>
</header>
<main>
  <section><h2>看板四个核心指标</h2>${kpiHtml}</section>
  <section><h2>今日成片与并排参考</h2>${filmCards.length ? filmCards : html`<p class="note">今日暂无成片。</p>`}</section>
  <section><h2>本页审核回执导出（离线复制）</h2><pre id="wall-decisions-json" class="export-box">{}</pre></section>
</main>
<script>${rawHtml(WALL_UI_SCRIPT)}</script>
</body>
</html>
`.html;
}

/* ---------------- 2. 原话账本与「一句话打回」五步流程 ---------------- */

function parseJsonlEvents(eventsFile) {
  ensureRegularTarget(eventsFile, '账本事件日志');
  if (!fs.existsSync(eventsFile)) return [];
  const raw = fs.readFileSync(eventsFile, 'utf8');
  const events = [];
  for (const [idx, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad(`账本事件日志第 ${idx + 1} 行不是合法 JSON`);
    }
    if (hasDuplicateJsonKeys(line)) {
      bad(`账本事件日志第 ${idx + 1} 行含有重复 JSON 键`);
    }
    if (!isPlainObject(parsed) || parsed.format !== LEDGER_EVENT_FORMAT) {
      bad(`账本事件日志第 ${idx + 1} 行格式非法`);
    }
    events.push(parsed);
  }
  return events;
}

function materializeLedger(events) {
  const entryMap = new Map();
  const predicateMap = new Map();
  const dimensionMap = new Map();
  const readRecords = [];
  const weeklyMap = new Map();

  for (const ev of events) {
    if (ev.type === 'step-1-record') {
      entryMap.set(ev.entry.id, {
        ...ev.entry,
        frames: [...ev.entry.frames],
        step: 1,
        status: 'recorded',
        translation: null,
        triage: null,
        readByFilmIds: [],
        countedWeeks: [],
      });
    } else if (ev.type === 'step-2-translate') {
      const target = entryMap.get(ev.entryId);
      if (!target) bad(`账本事件引用了不存在的条目 ${ev.entryId}`);
      target.translation = { ...ev.translation };
      target.step = Math.max(target.step, 2);
      target.status = 'translated';
    } else if (ev.type === 'step-3-triage') {
      const target = entryMap.get(ev.entryId);
      if (!target) bad(`账本事件引用了不存在的条目 ${ev.entryId}`);
      target.triage = { ...ev.triage };
      if (ev.triage.category && !target.category) target.category = ev.triage.category;
      target.step = Math.max(target.step, 3);
      target.status = 'triaged';
      if (ev.triage.decision === 'add-predicate') {
        const pKey = `${ev.triage.template}\0${ev.triage.predicate}`;
        const existing = predicateMap.get(pKey);
        if (existing) {
          if (!existing.sourceEntryIds.includes(ev.entryId)) existing.sourceEntryIds.push(ev.entryId);
        } else {
          predicateMap.set(pKey, {
            entryId: ev.entryId,
            sourceEntryIds: [ev.entryId],
            template: ev.triage.template,
            predicate: ev.triage.predicate,
            missedLayer: target.translation?.missedLayer ?? null,
            reason: ev.triage.reason,
            curator: ev.triage.curator,
            at: ev.triage.at,
          });
        }
      } else if (ev.triage.decision === 'unmeasurable-dimension') {
        const dKey = `${ev.triage.template}\0${ev.triage.dimension}`;
        const existing = dimensionMap.get(dKey);
        if (existing) {
          if (!existing.sourceEntryIds.includes(ev.entryId)) existing.sourceEntryIds.push(ev.entryId);
        } else {
          dimensionMap.set(dKey, {
            entryId: ev.entryId,
            sourceEntryIds: [ev.entryId],
            template: ev.triage.template,
            dimension: ev.triage.dimension,
            reason: ev.triage.reason,
            curator: ev.triage.curator,
            at: ev.triage.at,
          });
        }
      }
    } else if (ev.type === 'step-4-read') {
      const rec = { ...ev.readRecord, entryIds: [...ev.readRecord.entryIds] };
      readRecords.push(rec);
      for (const id of rec.entryIds) {
        const target = entryMap.get(id);
        if (!target) continue;
        if (!target.readByFilmIds.includes(rec.filmId)) target.readByFilmIds.push(rec.filmId);
        if (target.step >= 3) {
          target.step = Math.max(target.step, 4);
          target.status = 'read-before-next-film';
        }
      }
    } else if (ev.type === 'step-5-weekly') {
      weeklyMap.set(ev.weekly.weekStart, ev.weekly);
      for (const id of ev.entryIdsInWeek ?? []) {
        const target = entryMap.get(id);
        if (!target) continue;
        if (!target.countedWeeks.includes(ev.weekly.weekStart)) target.countedWeeks.push(ev.weekly.weekStart);
        if (target.step >= 4) {
          target.step = 5;
          target.status = 'weekly-counted';
        }
      }
    } else {
      bad(`未知的账本事件类型: ${String(ev.type)}`);
    }
  }

  return {
    format: LEDGER_FORMAT,
    entries: [...entryMap.values()],
    predicateAdditions: [...predicateMap.values()],
    unmeasurableDimensions: [...dimensionMap.values()],
    readRecords,
    weeklyStats: [...weeklyMap.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0)),
  };
}

function flushLedgerSnapshots(dir, state) {
  atomicWriteJson(path.join(dir, 'entries.json'), state.entries);
  atomicWriteJson(path.join(dir, 'predicate-additions.json'), state.predicateAdditions);
  atomicWriteJson(path.join(dir, 'unmeasurable-dimensions.json'), state.unmeasurableDimensions);
  atomicWriteJson(path.join(dir, 'weekly-stats.json'), state.weeklyStats);
}

function mutateLedger(ledgerDir, mutator) {
  const dir = checkControlledDir(ledgerDir, '原话账本');
  const eventsPath = path.join(dir, 'events.jsonl');
  return withFileLock(eventsPath, (locked) => {
    const targetEventsFile = locked();
    const events = parseJsonlEvents(targetEventsFile);
    const current = materializeLedger(events);
    const { event, extraReadLine, selectResult } = mutator(current);
    const nextEvents = [...events, event];
    const nextState = materializeLedger(nextEvents);
    ensureRegularTarget(targetEventsFile, '账本事件日志');
    fs.appendFileSync(targetEventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    if (extraReadLine) {
      const readsFile = path.join(dir, 'reads.jsonl');
      ensureRegularTarget(readsFile, '读取记录日志');
      fs.appendFileSync(readsFile, `${JSON.stringify(extraReadLine)}\n`, 'utf8');
    }
    flushLedgerSnapshots(dir, nextState);
    return freezeDeep(selectResult(nextState));
  });
}

/** 从磁盘加载原话账本完整状态快照。 */
export function loadLedgerState(ledgerDir) {
  const dir = checkControlledDir(ledgerDir, '原话账本');
  const eventsPath = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    return freezeDeep(materializeLedger([]));
  }
  return withFileLock(eventsPath, (locked) => freezeDeep(materializeLedger(parseJsonlEvents(locked()))));
}

/**
 * 第 1 步：原话一字不改进账本（原文、时间、哪条片、片型、哪几帧）。
 */
export function recordRejection(ledgerDir, payload) {
  const p = plainObj(payload, 'recordRejection 入参');
  const filmId = nonEmptyText(p.filmId, 'filmId');
  const template = nonEmptyText(p.template, 'template');
  if (!Array.isArray(p.frames) || p.frames.length !== 2) {
    bad('frames 必须是 [start, end] 二元整数帧区间');
  }
  const start = safeInt(p.frames[0], 'frames[0]', 0);
  const end = safeInt(p.frames[1], 'frames[1]', 0);
  if (end < start) bad('frames[1] 不得小于 frames[0]', RangeError);

  if (typeof p.verbatim !== 'string' || !p.verbatim.isWellFormed() || p.verbatim.includes('\0') || p.verbatim.trim().length === 0) {
    bad('verbatim 原话必须是非空合法字符串');
  }
  // 严格保持 p.verbatim 原字不动，不做任何 trim / replace / slice
  const verbatim = p.verbatim;
  const category = optText(p.category, 'category');
  const author = optText(p.author, 'author');
  const ts = parseIsoTimestamp(p.at, 'at');

  return mutateLedger(ledgerDir, (current) => {
    const id = `rej-${String(current.entries.length + 1).padStart(4, '0')}`;
    const event = {
      format: LEDGER_EVENT_FORMAT,
      type: 'step-1-record',
      entry: {
        id,
        filmId,
        template,
        frames: [start, end],
        verbatim,
        category,
        author,
        at: ts.raw,
      },
    };
    return {
      event,
      selectResult: (next) => next.entries.find((e) => e.id === id),
    };
  });
}

/**
 * 第 2 步：审片代理把原话翻译成候选谓词，并回答「哪一层验证（L1–L5）本该拦住它」。
 */
export function translateRejection(ledgerDir, entryId, payload) {
  const id = nonEmptyText(entryId, 'entryId');
  const p = plainObj(payload, 'translateRejection 入参');
  const candidatePredicate = nonEmptyText(p.candidatePredicate, 'candidatePredicate');
  const missedLayer = oneOf(p.missedLayer, MISSED_LAYERS, 'missedLayer');
  const rationale = optText(p.rationale, 'rationale');
  const reviewer = optText(p.reviewer, 'reviewer');
  const ts = parseIsoTimestamp(p.at, 'at');
  const check = checkExtra(candidatePredicate);

  return mutateLedger(ledgerDir, (current) => {
    const target = current.entries.find((e) => e.id === id);
    if (!target) bad(`找不到打回条目 ${id}`);
    if (target.step >= 3) bad(`条目 ${id} 已完成第 3 步裁定，不可覆写第 2 步翻译`);
    const createdTs = parseIsoTimestamp(target.at, 'entry.at');
    if (ts.epochNs < createdTs.epochNs) bad('第 2 步翻译时间不得早于第 1 步打回时间', RangeError);

    const event = {
      format: LEDGER_EVENT_FORMAT,
      type: 'step-2-translate',
      entryId: id,
      translation: {
        candidatePredicate,
        candidateValid: check.ok,
        missedLayer,
        rationale,
        reviewer,
        at: ts.raw,
      },
    };
    return {
      event,
      selectResult: (next) => next.entries.find((e) => e.id === id),
    };
  });
}

/**
 * 第 3 步：出题代理确认分流：
 * - `add-predicate`：经 `beiming/verify/predicates.mjs` 的 `checkExtra` 严格核验通过后入片型模板增补表；
 * - `unmeasurable-dimension`：登记成「判不了的维度」，供成片墙显式标出交给人类导演。
 */
export function confirmRejectionTriage(ledgerDir, entryId, payload) {
  const id = nonEmptyText(entryId, 'entryId');
  const p = plainObj(payload, 'confirmRejectionTriage 入参');
  const decision = oneOf(p.decision, ['add-predicate', 'unmeasurable-dimension'], 'decision');
  const reason = optText(p.reason, 'reason');
  const category = optText(p.category, 'category');
  const curator = optText(p.curator, 'curator');
  const ts = parseIsoTimestamp(p.at, 'at');

  return mutateLedger(ledgerDir, (current) => {
    const target = current.entries.find((e) => e.id === id);
    if (!target) bad(`找不到打回条目 ${id}`);
    if (target.step < 2 || !target.translation) {
      bad(`条目 ${id} 尚未完成第 2 步候选谓词翻译，不能直接执行第 3 步`);
    }
    if (target.step >= 3 && target.triage) {
      bad(`条目 ${id} 已完成第 3 步确认，不可重复确认`);
    }
    const transTs = parseIsoTimestamp(target.translation.at, 'translation.at');
    if (ts.epochNs < transTs.epochNs) bad('第 3 步确认时间不得早于第 2 步翻译时间', RangeError);

    const template = p.template === undefined ? target.template : nonEmptyText(p.template, 'template');
    let predicate = null;
    let dimension = null;

    if (decision === 'add-predicate') {
      predicate = p.predicate === undefined
        ? target.translation.candidatePredicate
        : nonEmptyText(p.predicate, 'predicate');
      const verified = checkExtra(predicate);
      if (!verified.ok) {
        bad(
          `候选谓词未通过正式语法与登记表校验：${verified.errors.map((e) => e.message).join('；')}`,
          TypeError,
          { predicateErrors: verified.errors },
        );
      }
    } else {
      dimension = nonEmptyText(p.dimension, 'dimension');
    }

    const event = {
      format: LEDGER_EVENT_FORMAT,
      type: 'step-3-triage',
      entryId: id,
      triage: {
        decision,
        template,
        predicate,
        dimension,
        reason,
        category,
        curator,
        at: ts.raw,
      },
    };
    return {
      event,
      selectResult: (next) => next.entries.find((e) => e.id === id),
    };
  });
}

/**
 * 第 4 步：下一部同类型片动手前读取账本相关条目，并落盘不可遗漏的 `readRecord`。
 */
export function recordLedgerRead(ledgerDir, payload) {
  const p = plainObj(payload, 'recordLedgerRead 入参');
  const filmId = nonEmptyText(p.filmId, 'filmId');
  const template = nonEmptyText(p.template, 'template');
  const reader = optText(p.reader, 'reader');
  const ts = parseIsoTimestamp(p.at, 'at');

  return mutateLedger(ledgerDir, (current) => {
    const matchesTemplate = (tpl) => tpl === template || tpl === '*';
    const matchedEntries = current.entries.filter((e) => matchesTemplate(e.template));
    const matchedPredicates = current.predicateAdditions.filter((a) => matchesTemplate(a.template));
    const matchedDimensions = current.unmeasurableDimensions.filter((d) => matchesTemplate(d.template));
    const readId = `read-${String(current.readRecords.length + 1).padStart(4, '0')}`;
    const readRecord = {
      id: readId,
      filmId,
      template,
      reader,
      entryIds: matchedEntries.map((e) => e.id),
      predicateCount: matchedPredicates.length,
      unmeasurableCount: matchedDimensions.length,
      at: ts.raw,
    };
    const event = {
      format: LEDGER_EVENT_FORMAT,
      type: 'step-4-read',
      readRecord,
    };
    return {
      event,
      extraReadLine: readRecord,
      selectResult: (next) => ({
        readRecord,
        entries: next.entries.filter((e) => matchesTemplate(e.template)),
        predicateAdditions: next.predicateAdditions.filter((a) => matchesTemplate(a.template)),
        unmeasurableDimensions: next.unmeasurableDimensions.filter((d) => matchesTemplate(d.template)),
      }),
    };
  });
}

function categoryKeyOf(entry) {
  return entry.category
    ?? entry.triage?.predicate
    ?? entry.triage?.dimension
    ?? entry.translation?.candidatePredicate
    ?? entry.verbatim;
}

function buildWeeklyStatsFromEntries(entries, weekOf) {
  const targetDay = dayNumber(weekOf);
  const dow = ((targetDay % 7) + 7 + 2) % 7; // 0 = 周一 .. 6 = 周日
  const monday = targetDay - dow;
  const sunday = monday + 6;
  const weekStart = dateFromDayNumber(monday);
  const weekEnd = dateFromDayNumber(sunday);

  const inWeek = entries.filter((e) => {
    const d = dayNumber(parseIsoTimestamp(e.at, 'entry.at').datePart);
    return d >= monday && d <= sunday;
  });

  const groups = new Map();
  for (const e of inWeek) {
    const key = categoryKeyOf(e);
    const cur = groups.get(key) ?? { category: key, count: 0, entryIds: [] };
    cur.count += 1;
    cur.entryIds.push(e.id);
    groups.set(key, cur);
  }

  const byCategory = [...groups.values()]
    .map((g) => ({
      category: g.category,
      count: g.count,
      repeatedCount: Math.max(0, g.count - 1),
      entryIds: g.entryIds,
    }))
    .sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

  const totalRejections = inWeek.length;
  const uniqueCategories = byCategory.length;
  const repeatedRejections = byCategory.reduce((sum, g) => sum + g.repeatedCount, 0);
  const repeatedCategoryCount = byCategory.filter((g) => g.count >= 2).length;
  const entriesInRepeatedCategories = byCategory.filter((g) => g.count >= 2).reduce((sum, g) => sum + g.count, 0);
  const repeatRate = totalRejections === 0 ? null : repeatedRejections / totalRejections;

  return {
    stats: {
      weekOf,
      weekStart,
      weekEnd,
      totalRejections,
      uniqueCategories,
      repeatedRejections,
      repeatedCategoryCount,
      entriesInRepeatedCategories,
      repeatRate,
      byCategory,
      scoreboardMetric: {
        firstTimeCount: totalRejections - repeatedRejections,
        repeatCount: repeatedRejections,
        total: totalRejections,
        repeatRate,
      },
    },
    entryIdsInWeek: inWeek.map((e) => e.id),
  };
}

/**
 * 第 5 步：按自然周（周一至周日）统计每类打回次数与重复打回率，并持久化周汇总快照。
 */
export function computeWeeklyRejectionStats(ledgerDir, options) {
  const opts = plainObj(options, 'computeWeeklyRejectionStats 入参');
  const weekOf = calendarDay(opts.weekOf, 'weekOf');

  return mutateLedger(ledgerDir, (current) => {
    const { stats, entryIdsInWeek } = buildWeeklyStatsFromEntries(current.entries, weekOf);
    const event = {
      format: LEDGER_EVENT_FORMAT,
      type: 'step-5-weekly',
      weekly: stats,
      entryIdsInWeek,
    };
    return {
      event,
      selectResult: () => stats,
    };
  });
}

const STEP_LABELS = {
  1: '第 1 步：原话已入账',
  2: '第 2 步：已译候选谓词',
  3: '第 3 步：已确认分流',
  4: '第 4 步：下片开工已读',
  5: '第 5 步：已计入周报',
};

/** 渲染原话账本离线静态页 HTML（零脚本、零外网依赖、全量 HTML 转义）。 */
export function renderLedgerHtml(ledgerInput) {
  const state = typeof ledgerInput === 'string' ? loadLedgerState(ledgerInput) : plainObj(ledgerInput, 'ledgerState');
  if (state.format !== LEDGER_FORMAT) bad(`账本状态 format 必须是 ${LEDGER_FORMAT}`);
  const optArray = (v, name) => (v === undefined ? [] : Array.isArray(v) ? v : bad(`ledgerState.${name} 必须是数组`));
  const entries = Array.isArray(state.entries) ? state.entries : bad('ledgerState.entries 必须是数组');
  const predicates = optArray(state.predicateAdditions, 'predicateAdditions');
  const dimensions = optArray(state.unmeasurableDimensions, 'unmeasurableDimensions');
  const reads = optArray(state.readRecords, 'readRecords');
  const weekly = optArray(state.weeklyStats, 'weeklyStats');

  const entriesTable = html`<table>
    <thead><tr><th>编号</th><th>成片 / 片型 / 帧区间</th><th>人类原话（一字不改）</th><th>五步进度</th><th>候选谓词 &amp; 漏拦层</th><th>出题裁定</th></tr></thead>
    <tbody>${entries.map((e) => html`<tr>
      <td>${e.id}</td>
      <td>${e.filmId} · ${e.template} · [${e.frames?.[0] ?? 0}, ${e.frames?.[1] ?? 0}]</td>
      <td>${e.verbatim}</td>
      <td>${STEP_LABELS[e.step] ?? `步骤 ${e.step}`}</td>
      <td>${e.translation ? `${e.translation.candidatePredicate}（${e.translation.missedLayer}）` : '待翻译'}</td>
      <td>${e.triage ? (e.triage.decision === 'add-predicate' ? `入模板：${e.triage.predicate}` : `判不了维度：${e.triage.dimension}`) : '待确认'}</td>
    </tr>`)}</tbody>
  </table>`;

  const predTable = html`<table>
    <thead><tr><th>来源条目</th><th>片型</th><th>新增基础谓词</th><th>本该拦住的层</th><th>说明</th></tr></thead>
    <tbody>${predicates.map((p) => html`<tr><td>${p.entryId}</td><td>${p.template}</td><td><code>${p.predicate}</code></td><td>${p.missedLayer}</td><td>${p.reason}</td></tr>`)}</tbody>
  </table>`;

  const dimTable = html`<table>
    <thead><tr><th>来源条目</th><th>片型</th><th>判不了的维度</th><th>说明</th></tr></thead>
    <tbody>${dimensions.map((d) => html`<tr><td>${d.entryId}</td><td>${d.template}</td><td>${d.dimension}</td><td>${d.reason}</td></tr>`)}</tbody>
  </table>`;

  const readTable = html`<table>
    <thead><tr><th>读取单号</th><th>新片编号</th><th>片型</th><th>已读条目</th><th>读取时间</th></tr></thead>
    <tbody>${reads.map((r) => html`<tr><td>${r.id}</td><td>${r.filmId}</td><td>${r.template}</td><td>${Array.isArray(r.entryIds) && r.entryIds.length ? r.entryIds.join('、') : '无'}</td><td>${r.at}</td></tr>`)}</tbody>
  </table>`;

  const weeklyTable = html`<table>
    <thead><tr><th>自然周</th><th>总打回数</th><th>问题类别数</th><th>重复打回数</th><th>重复打回率</th></tr></thead>
    <tbody>${weekly.map((w) => html`<tr><td>${w.weekStart} 至 ${w.weekEnd}</td><td>${w.totalRejections}</td><td>${w.uniqueCategories}</td><td>${w.repeatedRejections}</td><td>${pct(w.repeatRate)}</td></tr>`)}</tbody>
  </table>`;

  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>北冥原话账本</title>
<style>${rawHtml(BASE_STYLE)}</style>
</head>
<body>
<header>
  <h1>北冥原话账本（「一句话打回」五步闭环）</h1>
  <p class="note">共 ${entries.length} 条原话记录 · ${predicates.length} 条入库基础谓词 · ${dimensions.length} 项人工把关维度 · ${reads.length} 次开工前读取</p>
</header>
<main>
  <section><h2>每周重复打回率（第 5 步）</h2>${weekly.length ? weeklyTable : html`<p class="note">暂无周统计记录。</p>`}</section>
  <section><h2>原话条目与五步状态（第 1–3 步）</h2>${entries.length ? entriesTable : html`<p class="note">暂无打回记录。</p>`}</section>
  <section><h2>片型基础谓词增补表</h2>${predicates.length ? predTable : html`<p class="note">暂无新增基础谓词。</p>`}</section>
  <section><h2>判不了的维度清单（交成片墙人工把关）</h2>${dimensions.length ? dimTable : html`<p class="note">暂无判不了的维度。</p>`}</section>
  <section><h2>下片开工前读取记录（第 4 步）</h2>${reads.length ? readTable : html`<p class="note">暂无读取记录。</p>`}</section>
</main>
</body>
</html>
`.html;
}

/* ---------------- 3. 盲选页（Blind A/B Page） ---------------- */

function normalizeReviewerChoice(rawChoice, sourceA, sourceB, at) {
  if (rawChoice === undefined || rawChoice === null) return null;
  const c = nonEmptyText(rawChoice, at);
  if (c === 'tie') return 'tie';
  if (c === 'A' || c === 'candidateA' || c === sourceA) return sourceA;
  if (c === 'B' || c === 'candidateB' || c === sourceB) return sourceB;
  bad(`${at} 只能是 'A'、'B'、'tie' 或该组候选的 source 名`);
}

function normalizeLeakText(s) {
  return String(s).normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase();
}

function expandLeakVariants(value) {
  const str = String(value);
  const variants = [str];
  let cur = str;
  for (let round = 0; round < 5 && cur.includes('%'); round += 1) {
    const next = safeDecodePercentOnce(cur);
    if (next === cur) break;
    variants.push(next);
    cur = next;
  }
  const extra = [];
  for (const v of variants) {
    if (v.includes('+')) extra.push(v.replace(/\+/g, ' '));
  }
  return extra.length ? [...variants, ...extra] : variants;
}

function checkZeroBlindLeak(value, sensitiveTokens, at) {
  if (value === null || value === undefined) return;
  for (const variant of expandLeakVariants(value)) {
    const lower = normalizeLeakText(variant);
    for (const token of sensitiveTokens) {
      if (token && lower.includes(token)) {
        bad(`${at} 含有可能泄露盲选来源的标识，请使用已脱敏的中立名称`);
      }
    }
  }
}

function computeBlindLayoutDigest(session) {
  const dl = session.decisionLine;
  const canonical = {
    sessionId: session.sessionId,
    decisionLine: {
      minWinsOrTies: dl.minWinsOrTies,
      totalPairs: dl.totalPairs,
      committedAt: dl.committedAt,
      ...(dl.alpha !== undefined ? { alpha: dl.alpha } : {}),
      ...(dl.beta !== undefined ? { beta: dl.beta } : {}),
      ...(dl.note !== undefined ? { note: dl.note } : {}),
    },
    pairs: session.pairs.map((p) => ({
      pairId: p.pairId,
      kind: p.kind,
      left: p.left.mediaUrl,
      right: p.right.mediaUrl,
    })),
  };
  return `sha256:${sha256Hex(JSON.stringify(canonical))}`;
}

/**
 * 创建确定性左右随机的盲选会话：
 * 返回严格信息隔离的 `{ publicSession, answerKey }`。
 */
export function createBlindSession(options) {
  const opts = plainObj(options, 'createBlindSession 入参');
  const sessionId = nonEmptyText(opts.sessionId, 'sessionId');
  const purpose = opts.purpose === undefined ? 'equivalence' : nonEmptyText(opts.purpose, 'purpose');
  const createdTs = parseIsoTimestamp(opts.createdAt, 'createdAt');
  const seed = opts.seed === undefined ? randomBytes(16).toString('hex') : normalizeSeed(opts.seed);

  if (!Array.isArray(opts.pairs) || opts.pairs.length === 0) {
    bad('pairs 必须是非空数组');
  }

  if (!isPlainObject(opts.decisionLine)) {
    bad('decisionLine（前置判定线）必须在创建盲选会话前提供');
  }
  const dl = opts.decisionLine;
  const committedTs = parseIsoTimestamp(dl.committedAt, 'decisionLine.committedAt');
  if (committedTs.epochNs > createdTs.epochNs) {
    bad('decisionLine.committedAt 不得晚于盲选会话创建时间 createdAt', RangeError);
  }

  const targetSource = nonEmptyText(dl.targetSource, 'decisionLine.targetSource');
  const totalPairs = dl.totalPairs === undefined ? opts.pairs.length : safeInt(dl.totalPairs, 'decisionLine.totalPairs', 1);
  if (totalPairs !== opts.pairs.length) {
    bad(`decisionLine.totalPairs (${totalPairs}) 必须等于 pairs 数量 (${opts.pairs.length})`, RangeError);
  }

  const rawThresholds = [dl.minTargetWinsOrTies, dl.minCandidateWinsOrTies, dl.minWinsOrTies].filter((v) => v !== undefined);
  if (rawThresholds.length === 0) {
    bad('decisionLine 必须指定 minTargetWinsOrTies（或 minCandidateWinsOrTies / minWinsOrTies）');
  }
  const minWinsOrTies = safeInt(rawThresholds[0], 'decisionLine.minWinsOrTies', 1);
  if (minWinsOrTies > totalPairs) {
    bad('decisionLine 胜平门槛不得超过总组数 totalPairs', RangeError);
  }
  if (rawThresholds.some((v) => v !== minWinsOrTies)) {
    bad('decisionLine 中多个门槛别名的值不一致');
  }

  const alpha = dl.alpha === undefined ? null : (typeof dl.alpha === 'number' && dl.alpha >= 0 && dl.alpha <= 1 ? dl.alpha : bad('decisionLine.alpha 必须在 [0, 1] 内', RangeError));
  const beta = dl.beta === undefined ? null : (typeof dl.beta === 'number' && dl.beta >= 0 && dl.beta <= 1 ? dl.beta : bad('decisionLine.beta 必须在 [0, 1] 内', RangeError));
  const note = optText(dl.note, 'decisionLine.note');

  const sensitiveTokens = new Set([
    ...FORBIDDEN_BLIND_WORDS,
    normalizeLeakText(targetSource),
  ]);

  const seenOriginalIds = new Set();
  const parsedPairs = opts.pairs.map((rawPair, i) => {
    const p = plainObj(rawPair, `pairs[${i}]`);
    const originalId = p.id === undefined ? `input-${i + 1}` : nonEmptyText(p.id, `pairs[${i}].id`);
    if (seenOriginalIds.has(originalId)) bad(`pairs 存在重复的 id: ${originalId}`);
    seenOriginalIds.add(originalId);

    const kind = p.kind === undefined ? 'still' : oneOf(p.kind, ['still', 'clip'], `pairs[${i}].kind`);
    const candA = plainObj(p.candidateA, `pairs[${i}].candidateA`);
    const candB = plainObj(p.candidateB, `pairs[${i}].candidateB`);
    const sourceA = nonEmptyText(candA.source, `pairs[${i}].candidateA.source`);
    const sourceB = nonEmptyText(candB.source, `pairs[${i}].candidateB.source`);
    if (sourceA === sourceB) bad(`pairs[${i}] 两侧候选的 source 不得相同`);
    if (sourceA !== targetSource && sourceB !== targetSource) {
      bad(`pairs[${i}] 必须包含判定线指定的 targetSource (${targetSource})`);
    }
    const labelA = optText(candA.label, `pairs[${i}].candidateA.label`);
    const labelB = optText(candB.label, `pairs[${i}].candidateB.label`);
    const urlA = checkSafeMediaUrl(candA.mediaUrl, `pairs[${i}].candidateA.mediaUrl`);
    const urlB = checkSafeMediaUrl(candB.mediaUrl, `pairs[${i}].candidateB.mediaUrl`);
    if (urlA === urlB) bad(`pairs[${i}] 两侧媒体路径不得相同`);

    sensitiveTokens.add(normalizeLeakText(sourceA));
    sensitiveTokens.add(normalizeLeakText(sourceB));
    if (labelA) sensitiveTokens.add(normalizeLeakText(labelA));
    if (labelB) sensitiveTokens.add(normalizeLeakText(labelB));

    const reviewerChoice = normalizeReviewerChoice(p.reviewerChoice, sourceA, sourceB, `pairs[${i}].reviewerChoice`);
    let reviewerPerspectives = null;
    if (p.reviewerPerspectives !== undefined && p.reviewerPerspectives !== null) {
      const rp = plainObj(p.reviewerPerspectives, `pairs[${i}].reviewerPerspectives`);
      reviewerPerspectives = {};
      for (const [pName, pChoice] of Object.entries(rp)) {
        nonEmptyText(pName, 'perspectiveName');
        reviewerPerspectives[pName] = normalizeReviewerChoice(pChoice, sourceA, sourceB, `pairs[${i}].reviewerPerspectives.${pName}`);
      }
    }

    return { originalId, kind, sourceA, sourceB, labelA, labelB, urlA, urlB, reviewerChoice, reviewerPerspectives };
  });

  // 公开面零泄露核查：sessionId、purpose、note 与所有媒体路径均不得含任何来源名或标签
  checkZeroBlindLeak(sessionId, sensitiveTokens, 'sessionId');
  checkZeroBlindLeak(purpose, sensitiveTokens, 'purpose');
  checkZeroBlindLeak(note, sensitiveTokens, 'decisionLine.note');
  parsedPairs.forEach((p, i) => {
    checkZeroBlindLeak(p.urlA, sensitiveTokens, `pairs[${i}].candidateA.mediaUrl`);
    checkZeroBlindLeak(p.urlB, sensitiveTokens, `pairs[${i}].candidateB.mediaUrl`);
  });

  const padWidth = Math.max(2, String(parsedPairs.length).length);
  const publicPairs = [];
  const keyPairs = [];

  parsedPairs.forEach((p, i) => {
    const pairId = `pair-${String(i + 1).padStart(padWidth, '0')}`;
    const swap = seededBool(seed, i, `blind:${sessionId}`);
    const leftMedia = swap ? p.urlB : p.urlA;
    const rightMedia = swap ? p.urlA : p.urlB;
    const leftSource = swap ? p.sourceB : p.sourceA;
    const rightSource = swap ? p.sourceA : p.sourceB;

    publicPairs.push({
      index: i + 1,
      pairId,
      kind: p.kind,
      left: { slot: 'left', slotId: `${pairId}-L`, mediaUrl: leftMedia },
      right: { slot: 'right', slotId: `${pairId}-R`, mediaUrl: rightMedia },
    });

    keyPairs.push({
      index: i + 1,
      pairId,
      originalId: p.originalId,
      kind: p.kind,
      leftSource,
      rightSource,
      leftLabel: swap ? p.labelB : p.labelA,
      rightLabel: swap ? p.labelA : p.labelB,
      reviewerChoice: p.reviewerChoice,
      ...(p.reviewerPerspectives ? { reviewerPerspectives: p.reviewerPerspectives } : {}),
    });
  });

  const publicDecisionLine = {
    minWinsOrTies,
    totalPairs,
    committedAt: committedTs.raw,
    ...(alpha !== null ? { alpha } : {}),
    ...(beta !== null ? { beta } : {}),
    ...(note !== null ? { note } : {}),
  };

  const layoutDigest = computeBlindLayoutDigest({
    sessionId,
    decisionLine: publicDecisionLine,
    pairs: publicPairs,
  });

  const publicSession = freezeDeep({
    format: BLIND_PUBLIC_FORMAT,
    sessionId,
    purpose,
    createdAt: createdTs.raw,
    decisionLine: publicDecisionLine,
    layoutDigest,
    pairs: publicPairs,
  });

  const answerKey = freezeDeep({
    format: BLIND_KEY_FORMAT,
    sessionId,
    seed,
    createdAt: createdTs.raw,
    layoutDigest,
    decisionLine: {
      ...publicDecisionLine,
      targetSource,
    },
    pairs: keyPairs,
  });

  return Object.freeze({ publicSession, answerKey });
}

function validatePublicBlindSession(sessionInput) {
  const s = plainObj(sessionInput, 'publicSession');
  if (s.format !== BLIND_PUBLIC_FORMAT) bad(`publicSession.format 必须是 ${BLIND_PUBLIC_FORMAT}`);
  const allowedTop = ['format', 'sessionId', 'purpose', 'createdAt', 'decisionLine', 'layoutDigest', 'pairs'];
  if (!Object.keys(s).every((k) => allowedTop.includes(k))) {
    bad('publicSession 含有未授权字段（严禁混入答案或来源键）');
  }
  nonEmptyText(s.sessionId, 'publicSession.sessionId');
  nonEmptyText(s.purpose, 'publicSession.purpose');
  const createdTs = parseIsoTimestamp(s.createdAt, 'publicSession.createdAt');
  const dl = plainObj(s.decisionLine, 'publicSession.decisionLine');
  const allowedDl = ['minWinsOrTies', 'totalPairs', 'committedAt', 'alpha', 'beta', 'note'];
  if (!Object.keys(dl).every((k) => allowedDl.includes(k))) {
    bad('publicSession.decisionLine 含有未授权字段（严禁包含 targetSource）');
  }
  const committedTs = parseIsoTimestamp(dl.committedAt, 'publicSession.decisionLine.committedAt');
  if (committedTs.epochNs > createdTs.epochNs) {
    bad('publicSession.decisionLine.committedAt 晚于 createdAt', RangeError);
  }
  if (!Array.isArray(s.pairs) || s.pairs.length === 0) bad('publicSession.pairs 必须是非空数组');
  safeInt(dl.minWinsOrTies, 'publicSession.decisionLine.minWinsOrTies', 1);
  if (dl.totalPairs !== s.pairs.length) bad('publicSession.decisionLine.totalPairs 与 pairs 长度不符', RangeError);

  const leakSet = new Set(FORBIDDEN_BLIND_WORDS);
  checkZeroBlindLeak(s.sessionId, leakSet, 'publicSession.sessionId');
  checkZeroBlindLeak(s.purpose, leakSet, 'publicSession.purpose');
  checkZeroBlindLeak(dl.note, leakSet, 'publicSession.decisionLine.note');

  s.pairs.forEach((rawPair, i) => {
    const p = plainObj(rawPair, `publicSession.pairs[${i}]`);
    if (!Object.keys(p).every((k) => ['index', 'pairId', 'kind', 'left', 'right'].includes(k))) {
      bad(`publicSession.pairs[${i}] 含有未授权字段`);
    }
    nonEmptyText(p.pairId, `publicSession.pairs[${i}].pairId`);
    oneOf(p.kind, ['still', 'clip'], `publicSession.pairs[${i}].kind`);
    checkZeroBlindLeak(p.pairId, leakSet, `publicSession.pairs[${i}].pairId`);
    for (const side of ['left', 'right']) {
      const slot = plainObj(p[side], `publicSession.pairs[${i}].${side}`);
      if (!Object.keys(slot).every((k) => ['slot', 'slotId', 'mediaUrl'].includes(k))) {
        bad(`publicSession.pairs[${i}].${side} 含有未授权字段`);
      }
      nonEmptyText(slot.slotId, `publicSession.pairs[${i}].${side}.slotId`);
      checkSafeMediaUrl(slot.mediaUrl, `publicSession.pairs[${i}].${side}.mediaUrl`);
      checkZeroBlindLeak(slot.mediaUrl, leakSet, `publicSession.pairs[${i}].${side}.mediaUrl`);
    }
  });
  const layoutDigest = computeBlindLayoutDigest(s);
  if (s.layoutDigest !== undefined) {
    const givenDigest = nonEmptyText(s.layoutDigest, 'publicSession.layoutDigest');
    if (givenDigest !== layoutDigest) {
      bad('publicSession.layoutDigest 与公开槽位排布不一致');
    }
  }
  return { session: s, committedTs, layoutDigest };
}

// 盲选页纯静态脚本：零插值，仅收集 left/right/tie 投票供离线导出。
const BLIND_UI_SCRIPT = `
function updateBlindBallot() {
  var sessionEl = document.querySelector('[data-blind-session-id]');
  if (!sessionEl) return;
  var voterEl = document.getElementById('blind-voter');
  var votes = {};
  var radios = document.querySelectorAll('input[type="radio"][data-pair-id]:checked');
  for (var i = 0; i < radios.length; i++) {
    votes[radios[i].getAttribute('data-pair-id')] = radios[i].value;
  }
  var out = document.getElementById('blind-ballot-json');
  if (out) {
    var payload = {
      sessionId: sessionEl.getAttribute('data-blind-session-id'),
      voter: voterEl ? voterEl.value : '',
      submittedAt: new Date().toISOString(),
      votes: votes
    };
    var digest = sessionEl.getAttribute('data-blind-layout-digest');
    if (digest) payload.layoutDigest = digest;
    out.textContent = JSON.stringify(payload, null, 2);
  }
}
document.addEventListener('change', updateBlindBallot);
document.addEventListener('input', updateBlindBallot);
`;

/** 渲染盲选页离线单页 HTML（绝对零来源标识、零答案泄露、零外链）。 */
export function renderBlindPageHtml(publicSessionInput) {
  const { session, layoutDigest } = validatePublicBlindSession(publicSessionInput);
  const dl = session.decisionLine;

  const pairCards = session.pairs.map((p) => html`<article class="pair-card">
    <h3>第 ${p.index} 组（<code>${p.pairId}</code>）</h3>
    <div class="side-by-side">
      <div class="pane">
        <h4>左侧候选（<code>${p.left.slotId}</code>）</h4>
        ${mediaElement(p.left.mediaUrl, p.kind, p.left.slotId)}
      </div>
      <div class="pane">
        <h4>右侧候选（<code>${p.right.slotId}</code>）</h4>
        ${mediaElement(p.right.mediaUrl, p.kind, p.right.slotId)}
      </div>
    </div>
    <div class="actions">
      <label><input type="radio" name="vote-${p.pairId}" data-pair-id="${p.pairId}" value="left"> 左侧更好</label>
      <label><input type="radio" name="vote-${p.pairId}" data-pair-id="${p.pairId}" value="tie"> 分不出</label>
      <label><input type="radio" name="vote-${p.pairId}" data-pair-id="${p.pairId}" value="right"> 右侧更好</label>
    </div>
  </article>`);

  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>盲选页 ${session.sessionId}</title>
<style>${rawHtml(BASE_STYLE)}</style>
</head>
<body data-blind-session-id="${session.sessionId}" data-blind-layout-digest="${layoutDigest}">
<header>
  <h1>双盲对比页</h1>
  <p class="note">会话 <code>${session.sessionId}</code> · 共 ${session.pairs.length} 组 · 左右位置随机分配且不标来源 · 前置判定线锁定于 <time>${dl.committedAt}</time>（需赢或平至少 ${dl.minWinsOrTies} / ${dl.totalPairs} 组）</p>
  ${dl.note ? html`<p class="note">${dl.note}</p>` : rawHtml('')}
</header>
<main>
  <section>
    <label>评审人标识 <input id="blind-voter" type="text" placeholder="输入评审人代号"></label>
  </section>
  <section><h2>逐组盲选</h2>${pairCards}</section>
  <section><h2>盲选选票 JSON（离线导出交揭盲器）</h2><pre id="blind-ballot-json" class="export-box">{}</pre></section>
</main>
<script>${rawHtml(BLIND_UI_SCRIPT)}</script>
</body>
</html>
`.html;
}

function normalizeVotes(votesInput, expectedPairIds) {
  const expectedSet = new Set(expectedPairIds);
  const voteMap = new Map();
  if (Array.isArray(votesInput)) {
    votesInput.forEach((item, idx) => {
      const o = plainObj(item, `votes[${idx}]`);
      const pairId = nonEmptyText(o.pairId, `votes[${idx}].pairId`);
      const choice = oneOf(o.choice, ['left', 'right', 'tie'], `votes[${idx}].choice`);
      if (!expectedSet.has(pairId)) bad(`votes 含有未知的 pairId: ${pairId}`);
      if (voteMap.has(pairId)) bad(`votes 重复提交了 ${pairId}`);
      voteMap.set(pairId, choice);
    });
  } else {
    const o = plainObj(votesInput, 'votes');
    for (const [pairId, choice] of Object.entries(o)) {
      if (!expectedSet.has(pairId)) bad(`votes 含有未知的 pairId: ${pairId}`);
      voteMap.set(pairId, oneOf(choice, ['left', 'right', 'tie'], `votes.${pairId}`));
    }
  }
  for (const id of expectedPairIds) {
    if (!voteMap.has(id)) bad(`votes 缺少对 ${id} 的投票`);
  }
  return Object.fromEntries(expectedPairIds.map((id) => [id, voteMap.get(id)]));
}

/**
 * 记录并校验人类盲选投票：
 * - 强制核对 `submittedAt >= decisionLine.committedAt`；
 * - `ballotStore` 支持传受控磁盘目录路径（追加写入 `ballots.jsonl`）或内存数组。
 */
export function recordBlindBallot(ballotStore, publicSessionInput, ballotInput) {
  const { session, committedTs, layoutDigest } = validatePublicBlindSession(publicSessionInput);
  const b = plainObj(ballotInput, 'ballot');
  if (b.sessionId !== undefined && b.sessionId !== session.sessionId) {
    bad('ballot.sessionId 与盲选会话不匹配');
  }
  if (b.layoutDigest !== undefined && b.layoutDigest !== layoutDigest) {
    bad('ballot.layoutDigest 与盲选会话槽位排布不匹配');
  }
  const voter = nonEmptyText(b.voter, 'voter');
  const submittedTs = parseIsoTimestamp(b.submittedAt, 'submittedAt');
  if (submittedTs.epochNs < committedTs.epochNs) {
    bad('投票提交时间 submittedAt 早于前置判定线锁定时间 committedAt，判定违规无效', RangeError);
  }
  const expectedIds = session.pairs.map((p) => p.pairId);
  const votes = normalizeVotes(b.votes, expectedIds);

  const ballot = freezeDeep({
    format: BLIND_BALLOT_FORMAT,
    sessionId: session.sessionId,
    layoutDigest,
    voter,
    submittedAt: submittedTs.raw,
    votes,
  });

  if (typeof ballotStore === 'string') {
    const dir = checkControlledDir(ballotStore, '盲选选票');
    const ballotsFile = path.join(dir, 'ballots.jsonl');
    withFileLock(ballotsFile, (locked) => {
      const target = locked();
      ensureRegularTarget(target, '盲选选票日志');
      fs.appendFileSync(target, `${JSON.stringify(ballot)}\n`, 'utf8');
    });
  } else if (Array.isArray(ballotStore)) {
    ballotStore.push(ballot);
  } else {
    bad('ballotStore 必须是受控目录路径字符串或数组');
  }

  return ballot;
}

/**
 * 使用分离保存的 `answerKey` 对盲选选票揭盲：
 * - 汇总每方胜出数、`tie`（分不出）数，并按前置判定线给出通过/未通过结论；
 * - 统计审片模型与人类的一致率 `agreementRate`，当 `< 0.6` 时置 `disablePerspective: true`（06 §8.2）。
 */
export function unblindBlindSession(publicSessionInput, answerKeyInput, ballotInput) {
  const { session, committedTs, layoutDigest } = validatePublicBlindSession(publicSessionInput);
  const key = plainObj(answerKeyInput, 'answerKey');
  if (key.format !== BLIND_KEY_FORMAT) bad(`answerKey.format 必须是 ${BLIND_KEY_FORMAT}`);
  if (key.sessionId !== session.sessionId) bad('answerKey.sessionId 与 publicSession.sessionId 不匹配');
  const keyDigest = nonEmptyText(key.layoutDigest, 'answerKey.layoutDigest');
  if (keyDigest !== layoutDigest) {
    bad('answerKey.layoutDigest 与 publicSession 槽位排布不一致（禁止使用重排前的旧答案键揭盲）');
  }

  const keyDl = plainObj(key.decisionLine, 'answerKey.decisionLine');
  const keyCommittedTs = parseIsoTimestamp(keyDl.committedAt, 'answerKey.decisionLine.committedAt');
  if (keyCommittedTs.epochNs !== committedTs.epochNs || keyDl.minWinsOrTies !== session.decisionLine.minWinsOrTies) {
    bad('publicSession 与 answerKey 的前置判定线不一致');
  }
  const targetSource = nonEmptyText(keyDl.targetSource, 'answerKey.decisionLine.targetSource');
  if (!Array.isArray(key.pairs) || key.pairs.length !== session.pairs.length) {
    bad('answerKey.pairs 数量与 publicSession.pairs 不一致');
  }

  const b = plainObj(ballotInput, 'ballot');
  if (b.sessionId !== undefined && b.sessionId !== session.sessionId) {
    bad('ballot.sessionId 与盲选会话不匹配');
  }
  if (b.layoutDigest !== undefined && b.layoutDigest !== layoutDigest) {
    bad('ballot.layoutDigest 与盲选会话槽位排布不匹配');
  }
  const voter = nonEmptyText(b.voter, 'ballot.voter');
  const submittedTs = parseIsoTimestamp(b.submittedAt, 'ballot.submittedAt');
  if (submittedTs.epochNs < committedTs.epochNs) {
    bad('ballot.submittedAt 早于前置判定线锁定时间 committedAt', RangeError);
  }
  const expectedIds = session.pairs.map((p) => p.pairId);
  const votes = normalizeVotes(b.votes, expectedIds);

  const winsBySource = {};
  let targetWins = 0;
  let opponentWins = 0;
  let ties = 0;
  let evaluatedPairs = 0;
  let agreedPairs = 0;
  const perspectiveStats = new Map();

  const perPair = session.pairs.map((pubPair, i) => {
    const kp = plainObj(key.pairs[i], `answerKey.pairs[${i}]`);
    if (kp.pairId !== pubPair.pairId) bad(`answerKey.pairs[${i}].pairId 与 publicSession 不匹配`);
    const leftSource = nonEmptyText(kp.leftSource, `answerKey.pairs[${i}].leftSource`);
    const rightSource = nonEmptyText(kp.rightSource, `answerKey.pairs[${i}].rightSource`);
    winsBySource[leftSource] ??= 0;
    winsBySource[rightSource] ??= 0;

    const humanVote = votes[pubPair.pairId];
    const winnerSource = humanVote === 'left' ? leftSource : humanVote === 'right' ? rightSource : 'tie';
    let targetOutcome;
    if (winnerSource === 'tie') {
      ties += 1;
      targetOutcome = 'tie';
    } else if (winnerSource === targetSource) {
      targetWins += 1;
      winsBySource[winnerSource] += 1;
      targetOutcome = 'win';
    } else {
      opponentWins += 1;
      winsBySource[winnerSource] += 1;
      targetOutcome = 'loss';
    }

    const reviewerChoice = kp.reviewerChoice ?? null;
    let agreedWithHuman = null;
    if (reviewerChoice !== null) {
      evaluatedPairs += 1;
      agreedWithHuman = reviewerChoice === winnerSource;
      if (agreedWithHuman) agreedPairs += 1;
    }

    if (isPlainObject(kp.reviewerPerspectives)) {
      for (const [pName, pChoice] of Object.entries(kp.reviewerPerspectives)) {
        if (pChoice === null || pChoice === undefined) continue;
        const st = perspectiveStats.get(pName) ?? { evaluatedPairs: 0, agreedPairs: 0 };
        st.evaluatedPairs += 1;
        if (pChoice === winnerSource) st.agreedPairs += 1;
        perspectiveStats.set(pName, st);
      }
    }

    return {
      pairId: pubPair.pairId,
      originalId: kp.originalId ?? pubPair.pairId,
      leftSource,
      rightSource,
      humanVote,
      winnerSource,
      targetOutcome,
      reviewerChoice,
      agreedWithHuman,
    };
  });

  const totalPairs = perPair.length;
  const targetWinsOrTies = targetWins + ties;
  const targetWinOrTieRate = targetWinsOrTies / totalPairs;
  const passed = targetWinsOrTies >= keyDl.minWinsOrTies;

  const agreementRate = evaluatedPairs > 0 ? agreedPairs / evaluatedPairs : null;
  const disablePerspective = agreementRate !== null && agreementRate < AGREEMENT_DISABLE_THRESHOLD;

  const byPerspective = Object.fromEntries(
    [...perspectiveStats.entries()].map(([pName, st]) => {
      const rate = st.evaluatedPairs > 0 ? st.agreedPairs / st.evaluatedPairs : null;
      return [pName, {
        evaluatedPairs: st.evaluatedPairs,
        agreedPairs: st.agreedPairs,
        agreementRate: rate,
        threshold: AGREEMENT_DISABLE_THRESHOLD,
        disablePerspective: rate !== null && rate < AGREEMENT_DISABLE_THRESHOLD,
      }];
    }),
  );

  return freezeDeep({
    format: BLIND_REPORT_FORMAT,
    sessionId: session.sessionId,
    voter,
    submittedAt: submittedTs.raw,
    decisionLine: key.decisionLine,
    targetSource,
    totalPairs,
    targetWins,
    opponentWins,
    ties,
    targetWinsOrTies,
    targetWinOrTieRate,
    winsBySource,
    passed,
    equivalencePassed: passed,
    agreementRate,
    disablePerspective,
    reviewerAgreement: {
      evaluatedPairs,
      agreedPairs,
      agreementRate,
      threshold: AGREEMENT_DISABLE_THRESHOLD,
      disablePerspective,
      byPerspective,
    },
    boardBlindPicks: perPair.map((p) => ({ pairId: p.pairId, outcome: p.targetOutcome })),
    pairs: perPair,
  });
}
