// 北冥仓库 · 合规扫描主流程（只读）：把 patterns / provenance / reuse / rights 各项检查跑一遍，统一成发现列表。
// 发现的形状：{ rule, level: 'error'|'warn', zone: 'tree'|'archive', blocking, file, line, message, hint, meta? }
//   tree 区（仓库主体）按规则给 error / warn；archive 区（cases/source、cases/vendor）一律 warn 且 blocking=false——
//   历史归档与第三方快照只报告不阻塞，清理由案例库属主（P16）在后续波次执行。
// 接口：
//   RULES：全部规则 { id, title, hint, kind }
//   scanRepository({ root, staged, only, now, allowlistPath }) → { findings, suppressed, stats, problems }
//     同一进程里同样的参数只扫一次（规范检查的各条 comp 规则共用一次扫描结果）。
//   resolveRuleIds(list) → 规范化的规则 id（允许省略 comp. 前缀），未知 id 抛错。
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, readEntry, zoneOf, lineIndex, gitLines } from './repo.mjs';
import { CONTENT_RULES, NAME_RULE, checkFileName, isPersonalEmail, maskEmail } from './patterns.mjs';
import { findDerived, isCode, provenanceHeaderProblems } from './provenance.mjs';
import { reuseReport } from './reuse.mjs';
import { loadAllowlist, applyAllowlist } from './allowlist.mjs';
import { rightsReport } from './rights.mjs';
import { UsageError } from './cli.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_ALLOWLIST = 'tools/compliance/allowlist.json';
// D02 补充约定：2026-11-10 起的新提交一律用 GitHub noreply 邮箱；之前的公开历史不改写，只报告。
export const NOREPLY_SINCE = '2026-11-10T00:00:00+08:00';

const PROVENANCE = { id: 'comp.provenance', title: '派生代码缺来源头', kind: 'provenance',
  hint: '在文件头写 SPDX 许可行、上游版权行与 @provenance（写法见 docs/rights/licensing.md「派生代码的来源头」）；人工判定为通用写法的，写进允许清单并说明理由' };
const REUSE = { id: 'comp.reuse', title: 'REUSE 许可覆盖', kind: 'reuse', hint: '见 docs/rights/licensing.md' };
const LICENSE = { id: 'comp.license-file', title: '根 LICENSE 是标准 MIT 正文', kind: 'license',
  hint: 'LICENSE 只放标准 MIT 正文（GitHub 才能识别为 MIT）；适用范围写在 docs/rights/licensing.md 与 REUSE.toml' };
const RIGHTS = { id: 'comp.rights-register', title: '授权登记册与案例目录一致', kind: 'rights',
  hint: '运行 node tools/compliance/rights-inventory.mjs --write 重新生成 docs/rights/register.md；新增的第三方或客户素材先在 docs/rights/register.json 登记' };
export const RULES = [
  ...CONTENT_RULES.map(r => ({ id: r.id, title: r.title, hint: r.hint, kind: 'content' })),
  { ...NAME_RULE, kind: 'name' }, PROVENANCE, REUSE, LICENSE, RIGHTS,
];

export function resolveRuleIds(list) {
  if (!list || !list.length) return null;
  const ids = new Set(RULES.map(r => r.id));
  return list.flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean).map(s => {
    const id = s.startsWith('comp.') ? s : `comp.${s}`;
    if (!ids.has(id)) throw new UsageError(`没有这条规则：${s}`, `可选：${[...ids].map(x => x.slice(5)).join('、')}`);
    return id;
  });
}

const cache = new Map();

export function scanRepository({ root = REPO_ROOT, staged = false, only = null, now = Date.now(), allowlistPath = DEFAULT_ALLOWLIST } = {}) {
  root = path.resolve(root);
  const key = JSON.stringify({ root, staged, only, allowlistPath });
  if (cache.has(key)) return cache.get(key);
  const want = id => !only || only.includes(id);
  const { files, source } = listFiles(root, { staged });
  const texts = new Map();
  const read = rel => {
    if (texts.has(rel)) return texts.get(rel);
    const e = readEntry(root, rel, { staged, stagedList: staged ? files : null });
    texts.set(rel, e);
    return e;
  };
  const findings = [];
  // archivePolicy=false：问题出在我们自己维护的元数据上（REUSE.toml、登记册），不因文件在归档区而降级。
  const add = (rule, f, { archivePolicy = true } = {}) => {
    const zone = zoneOf(f.file);
    const level = zone === 'archive' && archivePolicy ? 'warn' : f.level;
    findings.push({ rule: rule.id, level, zone, blocking: level === 'error', file: f.file, line: f.line ?? null, message: f.message,
      hint: f.hint || rule.hint, ...(f.meta ? { meta: f.meta } : {}), ...(f._text ? { _text: f._text } : {}) });
  };
  const stats = { files: files.length, source, textFiles: 0, binaryFiles: 0, skipped: 0 };

  // 1) 文件名与内容规则
  const contentRules = CONTENT_RULES.filter(r => want(r.id));
  for (const rel of files) {
    if (want(NAME_RULE.id)) for (const p of checkFileName(rel)) add(NAME_RULE, { file: rel, ...p });
    if (!contentRules.length) continue;
    const e = read(rel);
    if (e.text == null) { if (e.binary) stats.binaryFiles++; else stats.skipped++; continue; }
    stats.textFiles++;
    const lineOf = lineIndex(e.text);
    const hits = contentRules.map(r => ({ r, hs: r.scan(e.text, rel, { now }) }));
    // 签名链接里的 AccessKeyId 只按「签名链接」报一次，不再按「密钥」重复报。
    const urlSpans = (hits.find(x => x.r.id === 'comp.signed-urls') || { hs: [] }).hs.map(h => [h.index, h.index + h.length]);
    for (const { r, hs } of hits) {
      for (const h of hs) {
        if (r.id === 'comp.secrets' && urlSpans.some(([a, b]) => h.index >= a && h.index < b)) continue;
        add(r, { file: rel, line: lineOf(h.index), level: h.level, message: h.message, meta: h.meta, _text: e.text.slice(h.index, h.index + Math.min(h.length, 200)) });
      }
    }
  }

  // 2) 个人邮箱：公开历史只报告；D02 之后的新提交仍用个人邮箱则阻断；当前 git 配置是个人邮箱给提示
  if (want('comp.personal-email') && !staged && source === 'git') {
    const log = gitLines(root, ['log', '--format=%h%x09%ae%x09%ce%x09%cI']) || [];
    const old = [], fresh = [];
    for (const row of log) {
      const [h, ae, ce, cd] = row.split('\t');
      if (!isPersonalEmail(ae) && !isPersonalEmail(ce)) continue;
      (Date.parse(cd) >= Date.parse(NOREPLY_SINCE) ? fresh : old).push(h);
    }
    const rule = RULES.find(r => r.id === 'comp.personal-email');
    if (old.length) findings.push({ rule: rule.id, level: 'warn', zone: 'history', blocking: false, file: '(git 历史)', line: null,
      message: `已公开的历史里有 ${old.length} 个提交的作者或提交者是个人邮箱（D02：不改写历史，只报告）`,
      hint: '新提交改用 GitHub noreply 邮箱；在 GitHub 设置里打开「Keep my email addresses private」与「Block command line pushes that expose my email」（由用户本人操作）' });
    if (fresh.length) findings.push({ rule: rule.id, level: 'error', zone: 'history', blocking: true, file: '(git 历史)', line: null,
      message: `${NOREPLY_SINCE.slice(0, 10)} 之后仍有 ${fresh.length} 个提交用个人邮箱：${fresh.slice(0, 5).join(' ')}${fresh.length > 5 ? ' …' : ''}`,
      hint: '这些提交还没公开时，用 git commit --amend --reset-author（或 rebase）改成 noreply 邮箱后再推送；已推送的按 D02 不改写' });
    const cfg = gitLines(root, ['config', 'user.email']);
    if (cfg && cfg[0] && isPersonalEmail(cfg[0])) findings.push({ rule: rule.id, level: 'warn', zone: 'config', blocking: false, file: '(git config)', line: null,
      message: `当前 git 配置的提交邮箱是个人邮箱（${maskEmail(cfg[0])}）：照这样提交会再次公开它`,
      hint: '提交时加 git -c user.email=<id>+<用户名>@users.noreply.github.com，或由用户本人把全局配置改成 noreply' });
  }

  // 3) 派生代码：仓库主体的代码与 cases/vendor 快照比对；带 @provenance 的文件检查来源头是否完整
  if (want(PROVENANCE.id)) {
    const targets = [], vendor = [];
    const vendorFiles = staged ? listFiles(root).files.filter(f => f.startsWith('cases/vendor/')) : files.filter(f => f.startsWith('cases/vendor/'));
    for (const rel of files) {
      if (zoneOf(rel) !== 'tree' || !isCode(rel)) continue;
      const e = read(rel);
      if (e.text == null) continue;
      targets.push({ rel, text: e.text });
      for (const p of provenanceHeaderProblems(e.text)) add(PROVENANCE, { file: rel, line: 1, level: 'error', message: `来源头不完整：${p}` });
      const tag = /@provenance\s+([\w.-]+)@([0-9a-f]{7,40}):(\S+)/.exec(e.text.slice(0, 6000));
      if (tag) {
        const vendorRel = `cases/vendor/${tag[1]}/${tag[3].replace(/#.*$/, '')}`;
        if (!fs.existsSync(path.join(root, vendorRel))) add(PROVENANCE, { file: rel, line: 1, level: 'warn', message: `@provenance 指向的上游文件在快照里找不到：${vendorRel}` });
      }
    }
    for (const rel of vendorFiles) {
      if (!isCode(rel)) continue;
      const e = staged ? readEntry(root, rel) : read(rel);
      if (e.text != null) vendor.push({ rel, text: e.text });
    }
    stats.provenance = { targets: targets.length, vendor: vendor.length };
    for (const d of findDerived(targets, vendor)) {
      if (d.attributed) continue;
      add(PROVENANCE, { file: d.file, line: d.lines[0], level: d.level,
        message: `与上游 ${d.vendor}:${d.vendorLines[0]}–${d.vendorLines[1]} 连续 ${d.run} 个记号相同（第 ${d.lines[0]}–${d.lines[1]} 行；与该文件相同的内容占本文件 ${Math.round(d.coverage * 100)}%），文件头没有来源说明`,
        meta: { vendor: d.vendor, run: d.run, coverage: d.coverage, lines: d.lines, vendorLines: d.vendorLines } });
    }
  }

  // 4) REUSE 覆盖（只在扫全部文件时做；暂存区模式只看本次改动，不做全仓覆盖统计）
  if (want(REUSE.id) && !staged) {
    const rep = reuseReport({ root, files, read });
    for (const p of rep.problems) add(REUSE, { ...p }, { archivePolicy: false });
    stats.reuse = rep.stats;
  }

  // 5) 根 LICENSE：标准 MIT 正文、版权人与 REUSE.toml 一致
  if (want(LICENSE.id) && !staged) for (const p of licenseProblems(root)) add(LICENSE, p);

  // 6) 授权登记册：docs/rights/register.md 与 register.json、cases/catalog.json 一致
  if (want(RIGHTS.id) && !staged) {
    const rep = rightsReport({ root });
    for (const p of rep.problems) add(RIGHTS, p, { archivePolicy: false });
    stats.rights = rep.stats;
  }

  // 7) 允许清单
  const list = loadAllowlist(allowlistPath && path.resolve(root, allowlistPath));
  const problems = list.problems.map(p => ({ rule: 'comp.allowlist', level: p.level, zone: 'tree', blocking: p.level === 'error', file: allowlistPath, line: null, message: p.message, hint: p.hint }));
  const { kept, suppressed, unused, expired } = applyAllowlist(findings, list, now);
  for (const e of expired) problems.push({ rule: 'comp.allowlist', level: 'error', zone: 'tree', blocking: true, file: allowlistPath, line: null,
    message: `允许清单第 ${e.index + 1} 条（${e.rule} ${e.path}）已于 ${e.expires} 过期，豁免失效`, hint: '问题修好了就删掉这条；还需要豁免就重新判定并改 expires' });
  if (!only) for (const e of unused) problems.push({ rule: 'comp.allowlist', level: 'warn', zone: 'tree', blocking: false, file: allowlistPath, line: null,
    message: `允许清单第 ${e.index + 1} 条（${e.rule} ${e.path}）已经没有匹配的发现`, hint: '删掉这条，保持清单最小' });
  const strip = f => { const { _text, ...rest } = f; return rest; };
  const all = [...kept, ...problems].map(strip);
  all.sort((a, b) => (b.blocking - a.blocking) || a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const result = { root, findings: all, suppressed: suppressed.map(strip), stats };
  cache.set(key, result);
  return result;
}

// LICENSE 与 LICENSES/MIT.txt 去掉版权行、压平空白后应完全一致
export function licenseProblems(root) {
  const out = [];
  const lic = path.join(root, 'LICENSE');
  const std = path.join(root, 'LICENSES', 'MIT.txt');
  if (!fs.existsSync(lic)) return [{ file: 'LICENSE', level: 'error', message: '仓库根目录没有 LICENSE' }];
  if (!fs.existsSync(std)) return [{ file: 'LICENSES/MIT.txt', level: 'error', message: 'LICENSES/MIT.txt 缺失，无法核对根 LICENSE' }];
  const norm = t => t.replace(/^\s*Copyright.*$/gim, '').replace(/\s+/g, ' ').trim();
  const a = fs.readFileSync(lic, 'utf8'), b = fs.readFileSync(std, 'utf8');
  if (norm(a) !== norm(b)) out.push({ file: 'LICENSE', line: 1, level: 'error', message: 'LICENSE 不是标准 MIT 正文（多了或少了内容），GitHub 会把仓库许可识别成 Other' });
  const holder = (/^\s*Copyright \(c\)\s*\d{4}(?:-\d{4})?\s+(.+?)\s*$/im.exec(a) || [])[1];
  if (!holder) out.push({ file: 'LICENSE', line: 3, level: 'error', message: 'LICENSE 缺少版权行（Copyright (c) <年份> <权利人>）' });
  const toml = path.join(root, 'REUSE.toml');
  if (holder && fs.existsSync(toml) && !fs.readFileSync(toml, 'utf8').includes(holder)) {
    out.push({ file: 'LICENSE', line: 3, level: 'warn', message: `LICENSE 的权利人「${holder}」没有出现在 REUSE.toml 的版权行里`, hint: '两处写同一个法律主体；权利人变更时一起改' });
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.license !== 'MIT') out.push({ file: 'package.json', level: 'warn', message: `package.json 的 license 是 ${pkg.license}，与根 LICENSE（MIT）不一致` });
  } catch { /* 没有 package.json 不算合规问题 */ }
  return out;
}
