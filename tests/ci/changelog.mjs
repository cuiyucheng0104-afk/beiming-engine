#!/usr/bin/env node
// 北冥仓库 · 更新日志工具：校验 CHANGELOG.md 的结构，按标签取出某一版的段落做 Release 说明。只读，除 --out 指定的文件外不写任何东西。
//   node tests/ci/changelog.mjs check [--file CHANGELOG.md] [--json]
//   node tests/ci/changelog.mjs notes <标签> [--file CHANGELOG.md] [--package package.json] [--footer 文件] [--out 文件] [--json]
//   node tests/ci/changelog.mjs notes --unreleased [--out 文件]          预览还没发布的部分
//
// 结构（Keep a Changelog 1.1.0 + 语义化版本 2.0.0）：
//   一个一级标题；第一个二级标题是 ## [Unreleased]；之后每一版 ## [X.Y.Z] - YYYY-MM-DD（可带 -rc.1 这类预发布号，可在末尾标 [YANKED]），
//   版本严格从新到旧；版本下的三级标题只能是 Added / Changed / Deprecated / Removed / Fixed / Security（规范的分类关键字，正文用中文）；
//   已发布的版本至少有一条条目；文末用 [版本]: 链接 给每个标题配比较或发布页链接（缺了只提示）。
// 标签与版本：v2.0.0 ↔ [2.0.0]；历史标签 v1.0 ↔ [1.0.0]（缺的位补 0）。--package 再核对 package.json 的 version 与标签一致。
// 退出码（附录 C1）：0 通过；2 用法错误；4 结构不合规、找不到对应版本、版本号与 package.json 不一致、文件不存在。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, EXIT, CliError, parseArgs, envelope, isMain, writeReport } from '../../tools/run-tests.mjs';

export const TYPES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const SEMVER = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

// '1.0' → '1.0.0'；'v2.1.0-rc.1' → '2.1.0-rc.1'；不合法 → null
export function normalizeVersion(v) {
  const m = SEMVER.exec(String(v).replace(/^v/, ''));
  if (!m) return null;
  return `${+m[1]}.${+m[2]}.${+(m[3] ?? 0)}${m[4] ? `-${m[4]}` : ''}`;
}
// 语义化版本比较（预发布号低于正式版，按点分段比较）
export function compareVersions(a, b) {
  const pa = SEMVER.exec(normalizeVersion(a)), pb = SEMVER.exec(normalizeVersion(b));
  for (let i = 1; i <= 3; i++) if (+pa[i] !== +pb[i]) return +pa[i] - +pb[i];
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const x = pa[4].split('.'), y = pb[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
    if (nx && ny && +x[i] !== +y[i]) return +x[i] - +y[i];
    if (nx !== ny) return nx ? -1 : 1;
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

const validDate = d => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
};

// 解析 → { title, sections: [{label, version, date, yanked, line, body, types: {Added: n…}, entries}], links: {label: url}, errors, warnings }
export function parseChangelog(text) {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const errors = [], warnings = [], sections = [], links = {};
  let title = null, cur = null, inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], n = i + 1;
    if (/^```/.test(l)) { inFence = !inFence; if (cur) cur.bodyLines.push(l); continue; }
    if (inFence) { if (cur) cur.bodyLines.push(l); continue; }
    let m;
    if ((m = /^\[([^\]]+)\]:\s*(\S+)\s*$/.exec(l))) { links[m[1].toLowerCase()] = m[2]; continue; }
    if (/^# /.test(l)) { if (title) errors.push(`第 ${n} 行：只能有一个一级标题`); else title = l.slice(2).trim(); continue; }
    if ((m = /^## (.*)$/.exec(l))) {
      const h = /^\[([^\]]+)\](?:\s+-\s+(\S+))?(\s+\[YANKED\])?\s*$/.exec(m[1].trim());
      if (!h) { errors.push(`第 ${n} 行：二级标题要写成「## [Unreleased]」或「## [X.Y.Z] - YYYY-MM-DD」，现在是「${m[1]}」`); cur = null; continue; }
      cur = { label: h[1], version: null, date: h[2] || null, yanked: !!h[3], line: n, bodyLines: [], types: {}, entries: 0, curType: null };
      if (/^unreleased$/i.test(h[1])) {
        if (sections.length) errors.push(`第 ${n} 行：[Unreleased] 必须是第一个二级标题`);
        if (h[2]) errors.push(`第 ${n} 行：[Unreleased] 不写日期`);
      } else {
        cur.version = normalizeVersion(h[1]);
        if (!cur.version) errors.push(`第 ${n} 行：「${h[1]}」不是语义化版本号（X.Y.Z）`);
        if (!h[2]) errors.push(`第 ${n} 行：版本 ${h[1]} 缺日期（写成 ## [${h[1]}] - YYYY-MM-DD）`);
        else if (!validDate(h[2])) errors.push(`第 ${n} 行：日期「${h[2]}」不是合法的 YYYY-MM-DD`);
      }
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.bodyLines.push(l);
    if ((m = /^### (.*)$/.exec(l))) {
      const t = m[1].trim();
      if (!TYPES.includes(t)) errors.push(`第 ${n} 行：分类只能是 ${TYPES.join(' / ')}，现在是「${t}」`);
      else if (cur.types[t] !== undefined) errors.push(`第 ${n} 行：[${cur.label}] 里「${t}」出现了两次`);
      cur.curType = t; cur.types[t] = cur.types[t] ?? 0;
      continue;
    }
    if (/^[-*] \S/.test(l)) {
      if (!cur.curType) errors.push(`第 ${n} 行：条目要放在 ### 分类下面`);
      else { cur.types[cur.curType]++; cur.entries++; }
    }
  }
  if (!title) errors.push('缺一级标题（# 更新日志）');
  if (!sections.length || !/^unreleased$/i.test(sections[0].label)) errors.push('第一个二级标题必须是 ## [Unreleased]');
  const released = sections.filter(s => s.version);
  const seen = new Set();
  for (const s of released) {
    if (seen.has(s.version)) errors.push(`第 ${s.line} 行：版本 ${s.label} 重复`);
    seen.add(s.version);
    if (!s.entries) errors.push(`第 ${s.line} 行：已发布的版本 ${s.label} 没有任何条目`);
    for (const [t, c] of Object.entries(s.types)) if (!c) warnings.push(`第 ${s.line} 行：[${s.label}] 的「${t}」下没有条目`);
  }
  for (let i = 1; i < released.length; i++) {
    if (compareVersions(released[i - 1].version, released[i].version) <= 0) errors.push(`第 ${released[i].line} 行：版本要从新到旧排列（${released[i - 1].label} 应新于 ${released[i].label}）`);
    else if (released[i - 1].date && released[i].date && released[i - 1].date < released[i].date) warnings.push(`第 ${released[i].line} 行：${released[i - 1].label} 的日期早于更旧的 ${released[i].label}`);
  }
  for (const s of sections) if (!links[s.label.toLowerCase()]) warnings.push(`[${s.label}] 没有链接定义（文末写 [${s.label}]: <比较或发布页地址>）`);
  for (const s of sections) { s.body = s.bodyLines.join('\n').trim(); delete s.bodyLines; delete s.curType; }
  return { title, sections, links, errors, warnings };
}

// 取某一版的 Release 说明正文
export function releaseNotes(parsed, { tag = null, unreleased = false, footer = '' } = {}) {
  let sec;
  if (unreleased) sec = parsed.sections.find(s => /^unreleased$/i.test(s.label));
  else {
    const v = normalizeVersion(tag);
    if (!v) throw new CliError(EXIT.USAGE, 'usage.bad-value', `标签「${tag}」不是 v<主>.<次>.<修订> 形式`, '例如 v2.0.0、v2.1.0-rc.1');
    sec = parsed.sections.find(s => s.version === v);
    if (!sec) {
      const have = parsed.sections.filter(s => s.version).map(s => s.label).join('、') || '无';
      throw new CliError(EXIT.CONTRACT, 'CHANGELOG_SECTION_MISSING', `CHANGELOG.md 里没有 ${tag} 对应的段落「## [${v}] - YYYY-MM-DD」（现有：${have}）`,
        '先把 [Unreleased] 里的条目移到新版本标题下、写上日期并提交，再打标签');
    }
  }
  if (!sec.body.trim()) throw new CliError(EXIT.CONTRACT, 'CHANGELOG_EMPTY', `[${sec.label}] 段落是空的`, '写上本版的变更条目');
  const link = parsed.links[sec.label.toLowerCase()];
  const parts = [sec.body];
  if (link) parts.push(`完整变更：${link}`);
  if (footer.trim()) parts.push(footer.trim());
  return { section: sec, text: parts.join('\n\n') + '\n' };
}

const SPEC = {
  file: { type: 'string' }, package: { type: 'string' }, footer: { type: 'string' }, out: { type: 'string' },
  unreleased: { type: 'bool' }, json: { type: 'bool' }, report: { type: 'string' }, help: { type: 'bool', short: 'h' },
};
export const HELP = `北冥仓库 · 更新日志工具

用法：node tests/ci/changelog.mjs check [--file CHANGELOG.md] [--json]
      node tests/ci/changelog.mjs notes <标签> [--file CHANGELOG.md] [--package package.json] [--footer 文件] [--out 文件] [--json]
      node tests/ci/changelog.mjs notes --unreleased [--out 文件]

  check              校验结构（Keep a Changelog 1.1.0、语义化版本、从新到旧、分类关键字）
  notes <标签>       取出该版本的段落作为 Release 说明；v1.0 这类短标签按 1.0.0 匹配
  --package <文件>   同时核对 package.json 的 version 与标签一致（发布时用）
  --footer <文件>    在说明末尾附加一段（例如上游署名区块）；文件不存在就报错
  --out <文件>       写到文件（默认打印到 stdout）
  --json             stdout 只输出一个 JSON 对象（附录 C2 信封）
  -h, --help         显示本说明

退出码：0 通过；2 用法错误；4 结构不合规 / 找不到版本 / 与 package.json 不一致 / 文件不存在`;

export function main(argv = process.argv.slice(2)) {
  let opts;
  const warnings = [];
  const finish = (exitCode, extra = {}, error = null) => {
    const env = envelope({ exitCode, command: 'changelog', error, warnings, ...extra });
    if (opts?.json) process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    writeReport(opts?.report, env);
    if (error) process.stderr.write(`${error.message}${error.hint ? `\n${error.hint}` : ''}\n`);
    return exitCode;
  };
  try {
    opts = parseArgs(argv, SPEC, { positional: 2 });
    if (opts.help) { process.stdout.write(HELP + '\n'); return EXIT.OK; }
    const [cmd, tag] = opts._;
    if (!['check', 'notes'].includes(cmd)) throw new CliError(EXIT.USAGE, cmd ? 'usage.unknown-command' : 'usage.missing-argument', cmd ? `不认识的子命令「${cmd}」` : '缺子命令', '用 check 或 notes；--help 查看用法');
    if (cmd === 'check' && tag) throw new CliError(EXIT.USAGE, 'usage.bad-value', `check 不带位置参数（多了「${tag}」）`);
    if (cmd === 'notes' && !tag === !opts.unreleased) throw new CliError(EXIT.USAGE, 'usage.bad-value', 'notes 要给一个标签，或者 --unreleased（二选一）');
    const file = path.resolve(opts.file || path.join(ROOT, 'CHANGELOG.md'));
    if (!fs.existsSync(file)) throw new CliError(EXIT.CONTRACT, 'CHANGELOG_MISSING', `找不到 ${file}`, '仓库根目录应有 CHANGELOG.md（Keep a Changelog 格式）');
    const parsed = parseChangelog(fs.readFileSync(file, 'utf8'));
    warnings.push(...parsed.warnings);
    const versions = parsed.sections.filter(s => s.version).map(s => ({ version: s.version, date: s.date, entries: s.entries }));
    const unreleasedEntries = parsed.sections.find(s => /^unreleased$/i.test(s.label))?.entries ?? 0;
    if (parsed.errors.length) {
      for (const e of parsed.errors) process.stderr.write(`  ✗ ${e}\n`);
      throw new CliError(EXIT.CONTRACT, 'CHANGELOG_INVALID', `${path.basename(file)} 有 ${parsed.errors.length} 处结构问题`, '按上面列出的行号修改；格式见 https://keepachangelog.com/zh-CN/1.1.0/');
    }
    if (cmd === 'check') {
      for (const w of parsed.warnings) process.stderr.write(`  ! ${w}\n`);
      process.stderr.write(`  ✓ ${path.basename(file)} 结构合规：${versions.length} 个已发布版本，[Unreleased] 有 ${unreleasedEntries} 条\n`);
      return finish(EXIT.OK, { versions, unreleasedEntries });
    }
    // notes
    if (opts.package) {
      const pj = JSON.parse(fs.readFileSync(path.resolve(opts.package), 'utf8'));
      if (normalizeVersion(pj.version) !== normalizeVersion(tag)) {
        throw new CliError(EXIT.CONTRACT, 'VERSION_MISMATCH', `package.json 的 version 是 ${pj.version}，与标签 ${tag} 不一致`, `把 package.json 的 version 改成 ${normalizeVersion(tag)} 并提交，再在那个提交上打标签`);
      }
    }
    let footer = '';
    if (opts.footer) {
      if (!fs.existsSync(opts.footer)) throw new CliError(EXIT.CONTRACT, 'FOOTER_MISSING', `找不到 --footer 指定的 ${opts.footer}`);
      footer = fs.readFileSync(opts.footer, 'utf8');
    }
    const { section, text } = releaseNotes(parsed, { tag, unreleased: opts.unreleased, footer });
    const outputs = [];
    if (opts.out) {
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      fs.writeFileSync(path.resolve(opts.out), text);
      outputs.push({ path: opts.out, sha256: crypto.createHash('sha256').update(text).digest('hex'), kind: 'release-notes' });
      process.stderr.write(`  ✓ [${section.label}] 的说明已写到 ${opts.out}（${section.entries} 条）\n`);
    } else if (!opts.json) process.stdout.write(text);
    return finish(EXIT.OK, { outputs, version: section.version, date: section.date, notes: opts.json ? text : undefined });
  } catch (caught) {
    const e = caught instanceof CliError ? caught : new CliError(EXIT.FAIL, 'ERROR', caught.message);
    opts = opts || { json: argv.includes('--json') };
    return finish(e.exitCode, {}, e);
  }
}

if (isMain(import.meta.url)) process.exitCode = main();
