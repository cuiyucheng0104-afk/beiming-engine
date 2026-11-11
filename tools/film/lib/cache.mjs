// 北冥仓库 · 出片编排 · 步骤缓存：某一步的输入哈希没变时直接复用上次的产物，不重跑。
//   <outRoot>/cache/<步骤>/<输入哈希>/   产物（与运行目录里的相对路径相同）+ manifest.json { step, key, runId, createdAt, files[], meta }
//   lookup(outRoot, step, key)              命中且文件齐全（大小一致）→ entry，否则 null
//   store(outRoot, step, key, runDir, files, meta)   把运行目录里的产物硬链接（不行就复制）进缓存；每步只留最近 KEEP 份
//   restore(entry, runDir)                  把缓存产物硬链接回本次运行目录；返回 meta
//   frameCache(outRoot, key)                逐帧缓存目录（render / stills 用）：<outRoot>/cache/frames/<key>/f000123.jpg
// 硬链接不占额外空间；跨卷或文件系统不支持时退回复制。缓存只是加速，删掉 out/cache/ 任何时候都安全。
import fs from 'node:fs';
import path from 'node:path';

const KEEP = 2;

export function linkOrCopy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.rmSync(dst, { force: true }); } catch { /* 无 */ }
  try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
}

export function lookup(outRoot, step, key) {
  const dir = path.join(outRoot, 'cache', step, key);
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
  if (m.key !== key || !Array.isArray(m.files)) return null;
  for (const f of m.files) {
    try { if (fs.statSync(path.join(dir, f.rel)).size !== f.size) return null; } catch { return null; }
  }
  return { dir, ...m };
}

export function store(outRoot, step, key, runDir, files, meta = {}, runId = null) {
  const root = path.join(outRoot, 'cache', step);
  const dir = path.join(root, key);
  const tmp = `${dir}.${process.pid}.partial`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const list = [];
  for (const r of files) {
    const src = path.join(runDir, r);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    linkOrCopy(src, path.join(tmp, r));
    list.push({ rel: r, size: fs.statSync(src).size });
  }
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ step, key, runId, createdAt: new Date().toISOString(), files: list, meta }, null, 1));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  // 每步只留最近 KEEP 份
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.endsWith('.partial'))
    .map(e => ({ p: path.join(root, e.name), t: fs.statSync(path.join(root, e.name)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const e of entries.slice(KEEP)) fs.rmSync(e.p, { recursive: true, force: true });
  return list;
}

export function restore(entry, runDir) {
  for (const f of entry.files) linkOrCopy(path.join(entry.dir, f.rel), path.join(runDir, f.rel));
  return entry.meta || {};
}

export function frameCacheDir(outRoot, key) {
  const dir = path.join(outRoot, 'cache', 'frames', key);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  fs.utimesSync(dir, now, now);
  // 帧缓存同样只留最近 KEEP 份（换了画幅 / 页面内容就是新的一份）
  const root = path.dirname(dir);
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())
    .map(e => ({ p: path.join(root, e.name), t: fs.statSync(path.join(root, e.name)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const e of entries.slice(KEEP + 1)) if (e.p !== dir) fs.rmSync(e.p, { recursive: true, force: true });
  return dir;
}
