#!/usr/bin/env node
// 北冥仓库 · 带签名查询串的链接：清单与清理脚本（清理部分是草案，交案例库属主 P16 在第二波执行）。
//   node tools/compliance/signed-urls.mjs list [--json] [--md]          列出全部签名链接（只读，不输出签名与密钥值）
//   node tools/compliance/signed-urls.mjs list --md --out docs/rights/signed-urls.md   写出清单文档
//   node tools/compliance/signed-urls.mjs list --md --check docs/rights/signed-urls.md 核对清单文档是否最新（只读）
//   node tools/compliance/signed-urls.mjs strip [--path <通配>] [--write] [--patch-out <文件>] [--allow-dirty]
//     默认只演练：打印要改哪些文件、各去掉几处查询串，不写任何文件；加 --write 才原地改写。
//     只删除 URL 里从 ? 开始的查询串（Expires、OSSAccessKeyId、Signature 等），对象地址与文件其余字节原样保留，
//     JSON 仍然合法、换行符不变；重复执行没有副作用。改完输出「目录补丁」（每个文件的新 sha256 与大小），
//     由 casebook 工具据此更新 cases/catalog.json，否则 casebook check 会报校验和不符。
// D02 补充约定：这些链接属于第三方（MiniMax 的 OSS），签名已于 2026-11-04 前后过期，用户无法也无需轮换密钥，去掉查询串即可。
// 退出码（附录 C1）：0 成功；4 list --check 发现清单过期；2 用法错误（含目标文件有未提交改动）；3 不在 git 仓库；1 工具自身出错。
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EXIT, parseCli, runMain, wantsHelp, UsageError, EnvError } from './lib/cli.mjs';
import { listFiles, readEntry, lineIndex, gitLines } from './lib/repo.mjs';
import { signedUrlInfo } from './lib/patterns.mjs';
import { globToRegExp } from './lib/reuse.mjs';
import { REPO_ROOT } from './lib/scan.mjs';

const HELP = `北冥仓库 · 带签名查询串的链接：清单与清理（清理是草案，第二波由案例库属主执行）
用法：
  node tools/compliance/signed-urls.mjs list [--json] [--md] [--out <文件> | --check <文件>]
  node tools/compliance/signed-urls.mjs strip [--path <通配>] [--write] [--patch-out <文件>] [--allow-dirty] [--json]
选项：
  --md                 清单输出成 Markdown（默认是纯文本摘要）
  --out <文件>         把 Markdown 清单写到文件（只在 list --md 时可用）
  --check <文件>       核对该文件与当前清单一致，不一致退出码 4
  --path <通配>        strip 只处理匹配的文件，默认 cases/source/**
  --write              真正改写文件；不加时只演练
  --patch-out <文件>   把目录补丁（新 sha256 与大小）写成 JSON
  --allow-dirty        目标文件有未提交改动时也继续（默认拒绝，免得混进别的改动）
  --root <目录>        仓库根目录（默认为本工具所在仓库）
  --json               输出附录 C2 的 JSON 信封
  -h, --help           显示本帮助
退出码：0 成功；4 清单过期；2 用法错误；3 环境问题；1 工具自身出错。`;

const argv = process.argv.slice(2);
const json = argv.includes('--json');

// 找出全部签名链接：[{ file, line, start, end（查询串在文本里的位置）, host, params, expires, expired }]
export function findSignedUrls(root, { pathRe = null, now = Date.now() } = {}) {
  const { files } = listFiles(root);
  const out = [];
  const URL_RE = /https?:\/\/[^\s"'<>`\\)\]]+/g;
  for (const rel of files) {
    if (pathRe && !pathRe.test(rel)) continue;
    const e = readEntry(root, rel);
    if (e.text == null || !/https?:\/\//.test(e.text)) continue;
    const lineOf = lineIndex(e.text);
    URL_RE.lastIndex = 0;
    for (let m; (m = URL_RE.exec(e.text));) {
      const info = signedUrlInfo(m[0]);
      if (!info) continue;
      out.push({ file: rel, line: lineOf(m.index), start: m.index + info.queryStart, end: m.index + m[0].length, host: info.host,
        params: info.params, expires: info.expires ? info.expires.toISOString() : null, expired: info.expires ? info.expires.getTime() < now : null });
    }
  }
  return out;
}

const caseOf = f => (f.startsWith('cases/source/') ? f.split('/')[2] : f.startsWith('cases/vendor/') ? `vendor/${f.split('/')[2]}` : '（仓库主体）');

export function renderList(items) {
  const L = ['# 带签名查询串的链接清单', ''];
  L.push('> 本页由 `node tools/compliance/signed-urls.mjs list --md --out docs/rights/signed-urls.md` 生成，不要手改；`--check` 核对是否最新。清单不含签名、密钥与过期时间戳的原值。', '');
  L.push('这些链接来自历史配音的 TTS 原始响应（第三方 MiniMax 的 OSS 下载地址）。按 D02 的补充约定：签名已经过期，用户无法也无需轮换密钥，在新提交里去掉查询串即可，不改写历史。清理由案例库属主（P16）在第二波用 `node tools/compliance/signed-urls.mjs strip` 执行，步骤见 [README.md](README.md)「签名链接的清理」。', '');
  const hosts = [...new Set(items.map(i => i.host))].sort();
  const expired = items.filter(i => i.expired === true).length, live = items.filter(i => i.expired === false).length;
  const dates = items.map(i => i.expires).filter(Boolean).sort();
  L.push(`共 **${items.length}** 处，分布在 **${new Set(items.map(i => i.file)).size}** 个文件；已过期 ${expired} 处，未过期 ${live} 处，看不出有效期 ${items.length - expired - live} 处。`);
  if (dates.length) L.push(`有效期截止：最早 ${dates[0].slice(0, 10)}，最晚 ${dates[dates.length - 1].slice(0, 10)}（UTC）。`);
  L.push(`主机：${hosts.map(h => `\`${h}\``).join('、') || '无'}。`, '');
  const byCase = new Map();
  for (const i of items) { const c = caseOf(i.file); if (!byCase.has(c)) byCase.set(c, []); byCase.get(c).push(i); }
  L.push('| 案例 | 处数 | 文件数 | 参数 |', '|---|---|---|---|');
  for (const [c, arr] of [...byCase].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    L.push(`| \`${c}\` | ${arr.length} | ${new Set(arr.map(i => i.file)).size} | ${[...new Set(arr.flatMap(i => i.params))].join('、')} |`);
  }
  L.push('', '## 逐条清单', '');
  L.push('| 文件 | 行 | 主机 | 有效期至（UTC） |', '|---|---|---|---|');
  for (const i of [...items].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    L.push(`| \`${i.file}\` | ${i.line} | ${i.host} | ${i.expires ? i.expires.slice(0, 10) : '—'} |`);
  }
  L.push('');
  return L.join('\n');
}

function dirtyFiles(root, files) {
  if (!files.length) return [];
  const rows = gitLines(root, ['status', '--porcelain', '-z', '--', ...files]);
  if (rows == null) throw new EnvError('读不到 git 状态', '在仓库工作树里运行');
  return rows.join('\n').split('\0').filter(Boolean).map(r => r.slice(3));
}

await runMain('compliance.signed-urls', async () => {
  if (wantsHelp(argv)) return { exitCode: EXIT.OK, text: HELP };
  const { values, positionals } = parseCli(argv, {
    options: { json: { type: 'boolean' }, md: { type: 'boolean' }, out: { type: 'string' }, check: { type: 'string' }, path: { type: 'string' },
      write: { type: 'boolean' }, 'patch-out': { type: 'string' }, 'allow-dirty': { type: 'boolean' }, root: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true, maxPositionals: 1,
  });
  const cmd = positionals[0] || 'list';
  if (!['list', 'strip'].includes(cmd)) throw new UsageError(`不认识的子命令 ${cmd}`, '子命令只有 list 与 strip');
  const root = values.root ? path.resolve(values.root) : REPO_ROOT;
  if (cmd === 'list') {
    if (values.write || values['patch-out'] || values.path || values['allow-dirty']) throw new UsageError('--write、--patch-out、--path、--allow-dirty 只用于 strip');
    if ((values.out || values.check) && !values.md) throw new UsageError('--out 与 --check 要和 --md 一起用');
    if (values.out && values.check) throw new UsageError('--out 与 --check 只能二选一');
    const items = findSignedUrls(root);
    const md = renderList(items);
    const outputs = [];
    let exitCode = EXIT.OK, error = null;
    if (values.out) {
      fs.writeFileSync(path.resolve(root, values.out), md);
      outputs.push({ path: values.out, sha256: crypto.createHash('sha256').update(md).digest('hex'), kind: 'doc' });
    }
    if (values.check) {
      const f = path.resolve(root, values.check);
      const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') : null;
      if (cur !== md) { exitCode = EXIT.CONTRACT; error = { code: 'stale', message: `${values.check} 与当前仓库不一致`, hint: `重新生成：node tools/compliance/signed-urls.mjs list --md --out ${values.check}` }; }
    }
    const safe = items.map(({ start, end, ...rest }) => rest);
    const text = values.md && !values.out && !values.check ? md
      : `${items.length} 处签名链接，${new Set(items.map(i => i.file)).size} 个文件${values.out ? `；已写入 ${values.out}` : ''}${values.check ? (error ? `；${error.message}` : '；清单是最新的') : ''}`;
    return { exitCode, error, outputs, result: { count: items.length, items: safe }, text };
  }
  // strip（草案）
  if (values.md || values.out || values.check) throw new UsageError('--md、--out、--check 只用于 list');
  const pathRe = globToRegExp(values.path || 'cases/source/**');
  const items = findSignedUrls(root, { pathRe });
  const byFile = new Map();
  for (const i of items) { if (!byFile.has(i.file)) byFile.set(i.file, []); byFile.get(i.file).push(i); }
  const files = [...byFile.keys()].sort();
  if (values.write && !values['allow-dirty']) {
    const dirty = dirtyFiles(root, files);
    if (dirty.length) throw new UsageError(`${dirty.length} 个目标文件有未提交的改动（如 ${dirty[0]}）`, '先提交或撤销这些文件的改动，或确认无误后加 --allow-dirty');
  }
  const patch = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const buf = fs.readFileSync(abs);
    const text = buf.toString('utf8');
    let out = '', pos = 0;
    for (const i of byFile.get(rel).sort((a, b) => a.start - b.start)) { out += text.slice(pos, i.start); pos = i.end; }
    out += text.slice(pos);
    const next = Buffer.from(out, 'utf8');
    if (/\.json$/i.test(rel)) JSON.parse(out);   // 改完必须仍是合法 JSON，否则直接报错、不写
    const sha = b => crypto.createHash('sha256').update(b).digest('hex');
    patch.push({ file: rel, source: rel.startsWith('cases/') ? rel.slice('cases/'.length) : rel, removed: byFile.get(rel).length,
      oldSha256: sha(buf), newSha256: sha(next), oldSize: buf.length, newSize: next.length });
    if (values.write) fs.writeFileSync(abs, next);
  }
  const outputs = [];
  if (values['patch-out']) {
    const body = JSON.stringify({ schemaVersion: 1, note: '按 source 找到 cases/catalog.json 里引用该文件的全部条目，把 sha256 与 size 改成新值', files: patch }, null, 2) + '\n';
    fs.writeFileSync(path.resolve(values['patch-out']), body);
    outputs.push({ path: values['patch-out'], sha256: crypto.createHash('sha256').update(body).digest('hex'), kind: 'patch' });
  }
  const text = [
    `${values.write ? '已改写' : '演练（未写文件）'}：${files.length} 个文件，共去掉 ${items.length} 处查询串`,
    ...patch.slice(0, 10).map(p => `  ${p.file}  -${p.removed} 处  ${p.oldSize}→${p.newSize} 字节`),
    patch.length > 10 ? `  …另有 ${patch.length - 10} 个文件（--json 看全部）` : '',
    values.write ? '下一步：用目录补丁更新 cases/catalog.json 的 sha256 与 size，再跑 python tools/casebook.py check 与 node tools/compliance/scan.mjs --only signed-urls' : '确认无误后加 --write 执行（建议同时加 --patch-out 保存目录补丁）',
  ].filter(Boolean).join('\n');
  return { exitCode: EXIT.OK, outputs, result: { written: !!values.write, files: patch }, text };
}, { json });
