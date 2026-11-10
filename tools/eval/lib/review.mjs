// 创作闸门记录（H6）：读作品目录里的审批 / 豁免记录，核对原话是否来自评测方真正发出的消息。
//
// 记录格式以 P05 M1 为准（films/<名>/review/<闸>-<日期>.json 与 review/waivers.json，也接受作品根目录的
// waivers.json）。P05 定稿前字段名可能变化，这里集中维护别名：
//   闸门  gate | stage                      决定  decision | status | action | verdict | result
//   原话  quote | userQuote | words | reviewerQuote | 原话 | reason（仅豁免）
//   来源  source | from
// 决定归一为 approve / waive / reject / other。
// 原话核对：NFKC 归一、去首尾引号、压缩空白后做子串匹配（「逐字找到」）；至少 2 个字。
// 接口：loadReviewRecords(filmDir)、normalizeQuote(s)、findQuote(quote, messages, predicate)、
//       gateAlias(name, aliases)

import fs from 'node:fs';
import path from 'node:path';

const GATE_KEYS = ['gate', 'stage'];
const DECISION_KEYS = ['decision', 'status', 'action', 'verdict', 'result'];
const QUOTE_KEYS = ['quote', 'userQuote', 'words', 'reviewerQuote', '原话'];
const SOURCE_KEYS = ['source', 'from'];

const pick = (obj, keys) => {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return null;
};

export function normalizeDecision(value) {
  const v = String(value ?? '').toLowerCase();
  if (/^(approve|approved|pass|passed|accept|accepted|ok|认可|通过|批准)$/.test(v)) return 'approve';
  if (/^(waive|waived|waiver|skip|skipped|豁免)$/.test(v)) return 'waive';
  if (/^(reject|rejected|revise|changes|changes-requested|request-changes|fail|failed|返修|不通过|否决)$/.test(v)) return 'reject';
  return 'other';
}

export function normalizeQuote(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/^[\s"'“”‘’「」『』《》]+|[\s"'“”‘’「」『』《》]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 原话 quote 是否逐字出现在某条满足 predicate 的消息里；返回命中的消息或 null。 */
export function findQuote(quote, messages, predicate = () => true) {
  const q = normalizeQuote(quote);
  if ([...q].length < 2) return null;
  for (const m of messages) {
    if (!predicate(m)) continue;
    if (normalizeQuote(m.text).replace(/\s+/g, ' ').includes(q)) return m;
  }
  return null;
}

function recordsFromValue(value, file, forcedDecision = null) {
  if (Array.isArray(value)) return value.flatMap(v => recordsFromValue(v, file, forcedDecision));
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.waivers)) return recordsFromValue(value.waivers, file, 'waive');
  if (Array.isArray(value.records)) return recordsFromValue(value.records, file, forcedDecision);
  const gates = value.gates ?? pick(value, GATE_KEYS);
  const decision = forcedDecision ?? normalizeDecision(pick(value, DECISION_KEYS));
  let quote = pick(value, QUOTE_KEYS);
  if (quote === null && decision === 'waive') quote = value.reason ?? null;
  const base = { file, decision, quote: quote === null ? null : String(quote), source: pick(value, SOURCE_KEYS), reviewer: value.reviewer ?? null, reviewerKind: value.reviewerKind ?? null, raw: value };
  return [].concat(gates ?? [null]).map(g => ({ ...base, gate: g === null ? null : String(g).toLowerCase() }));
}

/**
 * 读作品目录下的闸门记录。返回 { records, errors }。
 * 读：review/*.json（递归一层以内）、review/waivers.json、<作品>/waivers.json。
 */
export function loadReviewRecords(filmDir) {
  const records = [];
  const errors = [];
  const files = [];
  const reviewDir = path.join(filmDir, 'review');
  if (fs.existsSync(reviewDir)) {
    for (const e of fs.readdirSync(reviewDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.json')) files.push(path.join(reviewDir, e.name));
    }
  }
  const rootWaivers = path.join(filmDir, 'waivers.json');
  if (fs.existsSync(rootWaivers)) files.push(rootWaivers);
  for (const file of files.sort()) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      const isWaivers = path.basename(file) === 'waivers.json';
      records.push(...recordsFromValue(value, file, isWaivers ? 'waive' : null));
    } catch (e) {
      errors.push({ file, message: `不是合法 JSON：${e.message}` });
    }
  }
  return { records, errors };
}

/** 把记录里的闸门名映射到任务书里的标准名（aliases：{ 标准名: [别名…] }）。 */
export function gateAlias(name, aliases = {}) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  for (const [canon, list] of Object.entries(aliases)) {
    if (n === canon || list.map(s => s.toLowerCase()).includes(n)) return canon;
  }
  return n;
}
