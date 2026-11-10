// 北冥仓库 · 大文件闸门（决定 D10）：跟踪文件超过 5 MiB 必须列在 LARGE-FILES.allow 且 sha256 一致。
// 判定对象是 git 索引里的 blob（即将提交的内容），所以 pre-commit、CI 与本地检查口径相同；工作区里未暂存的改动不算。
//
// 接口：
//   indexEntries(root)             → [{path, blob, size, mode}]（不含符号链接与子模块）
//   blobSha256(root, blob)         → Promise<hex>，流式计算，不把文件读进内存
//   readAllow(root, file)          → {entries: [{sha256, size, path, line}], errors: [...]}
//   formatAllow(entries)           → 文件文本（带说明头）
//   checkLargeFiles({root, threshold, allowFile}) → Promise<{ok, threshold, large: [...], violations: [{path, size, reason, fix}], stale: [...]}>
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ALLOW_HEADER = [
  '# 北冥仓库 · 允许入库的大文件（超过 5 MiB）白名单。依据：docs/decisions/2026-11-10-industrial-baseline.md D10。',
  '# 只列 D10 生效时已经在库里的文件。新的大文件不进 git：底板、采样、母版放 Release 或对象存储，仓库只存清单（地址、sha256、大小、许可、来源）；渲染产物永不入库。',
  '# 格式：sha256  字节数  路径（相对仓库根，用 / 分隔）。替换已列文件后运行 node tools/env/large-files.mjs --update 刷新哈希；这个命令不会添加新条目。',
  '# 检查：node tools/env/large-files.mjs（repo-check 的 env.large-files 规则做同样的判定）。',
];

function git(root, args, opts = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20, windowsHide: true, ...opts });
  if (r.error) throw new Error(`无法运行 git（${r.error.code || r.error.message}）：大文件检查需要 git`);
  if (r.status !== 0) throw new Error(`git ${args[0]} 失败：${(r.stderr || '').trim()}`);
  return r.stdout;
}

export function indexEntries(root) {
  const out = git(root, ['-c', 'core.quotepath=off', 'ls-files', '-s', '-z']);
  const rows = out.split('\0').filter(Boolean).map(l => {
    const tab = l.indexOf('\t');
    const [mode, blob] = l.slice(0, tab).split(' ');
    return { mode, blob, path: l.slice(tab + 1) };
  }).filter(r => r.mode !== '120000' && r.mode !== '160000');
  if (!rows.length) return [];
  const uniq = [...new Set(rows.map(r => r.blob))];
  const sizes = new Map();
  const check = git(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: uniq.join('\n') + '\n' });
  for (const line of check.split('\n')) { const [o, s] = line.split(' '); if (o && s) sizes.set(o, +s); }
  return rows.map(r => ({ ...r, size: sizes.get(r.blob) ?? 0 }));
}

export function blobSha256(root, blob) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const c = spawn('git', ['cat-file', 'blob', blob], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stdout.on('data', d => h.update(d));
    c.stderr.on('data', d => { err += d; });
    c.on('error', reject);
    c.on('close', code => (code === 0 ? resolve(h.digest('hex')) : reject(new Error(`git cat-file 失败：${err.trim()}`))));
  });
}

export function readAllow(root, file = 'LARGE-FILES.allow') {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return { entries: [], errors: [`${file} 不存在`], missing: true };
  const entries = [], errors = [];
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^([0-9a-f]{64})\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) { errors.push(`${file}:${i + 1} 格式不对（应为「sha256  字节数  路径」）：${line}`); return; }
    entries.push({ sha256: m[1], size: +m[2], path: m[3].trim(), line: i + 1 });
  });
  return { entries, errors };
}

export function formatAllow(entries) {
  const body = [...entries].sort((a, b) => a.path.localeCompare(b.path)).map(e => `${e.sha256}  ${String(e.size).padStart(9)}  ${e.path}`);
  return [...ALLOW_HEADER, ...body].join('\n') + '\n';
}

export async function checkLargeFiles({ root, threshold = 5 * 1024 * 1024, allowFile = 'LARGE-FILES.allow' } = {}) {
  const allow = readAllow(root, allowFile);
  const byPath = new Map(allow.entries.map(e => [e.path, e]));
  const entries = indexEntries(root);
  const tracked = new Set(entries.map(e => e.path));
  const large = entries.filter(e => e.size > threshold);
  const violations = [...allow.errors.filter(() => !allow.missing).map(m => ({ path: allowFile, size: 0, reason: m, fix: '按文件头说明的格式改正' }))];
  for (const e of large) {
    const a = byPath.get(e.path);
    const mib = (e.size / 1048576).toFixed(1);
    if (!a) {
      violations.push({ path: e.path, size: e.size, reason: `${mib} MiB，超过 ${(threshold / 1048576).toFixed(0)} MiB 且不在 ${allowFile} 里`,
        fix: `git rm --cached "${e.path}"，把文件放到 Release 或对象存储，仓库里只留清单（地址、sha256、大小、许可、来源）；渲染产物放 films/<名>/out/（不提交）` });
      continue;
    }
    const sha = await blobSha256(root, e.blob);
    e.sha256 = sha;
    if (sha !== a.sha256 || e.size !== a.size) {
      violations.push({ path: e.path, size: e.size, reason: `内容与 ${allowFile} 第 ${a.line} 行登记的不一致（登记 ${a.size} 字节，现在 ${e.size} 字节）`,
        fix: '确认是有意替换（例如按决定 D05 重渲 media）后运行 node tools/env/large-files.mjs --update；否则恢复原文件' });
    }
  }
  const stale = allow.entries.filter(a => !tracked.has(a.path) || (entries.find(e => e.path === a.path)?.size ?? 0) <= threshold).map(a => a.path);
  return { ok: violations.length === 0, threshold, large: large.map(e => ({ path: e.path, size: e.size, sha256: e.sha256 || null })), violations, stale, allowMissing: !!allow.missing };
}
