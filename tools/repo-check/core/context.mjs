// 北冥仓库 · 规范检查 · 上下文：规则拿到的 ctx。全部只读、带缓存；路径一律是仓库相对、正斜杠。
//   ctx.root                          被检查的仓库根（--root，默认本工具所在仓库）
//   ctx.rel(abs) / ctx.abs(rel)       绝对路径 ↔ 仓库相对路径
//   ctx.exists(rel) / ctx.isDir(rel)
//   ctx.read(rel) / ctx.readJson(rel) 读文本 / JSON（缓存；读不了抛错，框架会把它记成该规则的错误）
//   ctx.walk(rel, { dirs, files })    递归列目录（跳过 node_modules、.git、out、__pycache__、.venv、.cache、_site、_previews、
//                                     .claude/worktrees 与 tests/**/fixtures），返回相对路径数组，按字典序
//   ctx.mdFiles({ vendor })           全部 .md（默认不含 cases/vendor/）
//   ctx.git(args)                     { ok, stdout }；不是 git 检出或没有 git 时 ok = false
//   ctx.registry                      { registry: Registry | null, raw, error, diagnostics }（tools/lib/routes.mjs）
//   ctx.pkg                           package.json 对象（读不出来是 null）
//   ctx.inScope(rel)                  --staged 时只对暂存区涉及的文件为真；逐文件规则用它缩小范围
//   ctx.md                            tools/repo-check/core/markdown.mjs 的全部函数
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as md from './markdown.mjs';
import { readRegistry, validateRegistry, Registry } from '../../lib/routes.mjs';

const SKIP_NAMES = new Set(['node_modules', '.git', 'out', '__pycache__', '.venv', '.cache', '_site', '_previews']);
const toPosix = p => p.split(path.sep).join('/');

export function isSkipped(rel) {
  const segs = rel.split('/');
  if (segs.some(s => SKIP_NAMES.has(s))) return true;
  if (rel === '.claude/worktrees' || rel.startsWith('.claude/worktrees/')) return true;
  if (segs[0] === 'tests' && segs.includes('fixtures')) return true;
  return false;
}

export function createContext({ root, staged = null }) {
  const cache = new Map();
  const memo = (k, fn) => { if (!cache.has(k)) cache.set(k, fn()); return cache.get(k); };
  const abs = r => (r === '.' || r === '' ? root : path.join(root, ...r.split('/')));
  const rel = a => toPosix(path.relative(root, a)) || '.';
  const exists = r => fs.existsSync(abs(r));
  const isDir = r => { try { return fs.statSync(abs(r)).isDirectory(); } catch { return false; } };
  const read = r => memo(`read:${r}`, () => fs.readFileSync(abs(r), 'utf8'));
  const readJson = r => memo(`json:${r}`, () => JSON.parse(read(r)));

  function walk(start = '.', { dirs = false, files = true } = {}) {
    return memo(`walk:${start}:${dirs}:${files}`, () => {
      const out = [];
      const go = r => {
        let ents;
        try { ents = fs.readdirSync(abs(r), { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const child = r === '.' ? e.name : `${r}/${e.name}`;
          if (isSkipped(child)) continue;
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) { if (dirs) out.push(child); go(child); } else if (e.isFile() && files) out.push(child);
        }
      };
      if (start === '.' || isDir(start)) go(start);
      return out.sort();
    });
  }

  const mdFiles = ({ vendor = false } = {}) => walk('.').filter(f => f.toLowerCase().endsWith('.md') && (vendor || !f.startsWith('cases/vendor/')));

  function git(args) {
    return memo(`git:${args.join('\0')}`, () => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 });
      if (r.error || r.status !== 0) return { ok: false, stdout: '', stderr: r.stderr ?? String(r.error) };
      return { ok: true, stdout: r.stdout };
    });
  }

  const registry = memo('registry', () => {
    const { raw, error } = readRegistry(root);
    if (error) return { registry: null, raw: null, error, diagnostics: [] };
    const diagnostics = validateRegistry(raw, { root });
    let reg = null;
    try { reg = Array.isArray(raw?.routes) ? new Registry(raw) : null; } catch { reg = null; }
    return { registry: reg, raw, error: null, diagnostics };
  });

  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(abs('package.json'), 'utf8')); } catch { pkg = null; }

  return {
    root, abs, rel, exists, isDir, read, readJson, walk, mdFiles, git, md, pkg,
    registry,
    staged,
    inScope: r => !staged || staged.has(r),
    memo,
  };
}
