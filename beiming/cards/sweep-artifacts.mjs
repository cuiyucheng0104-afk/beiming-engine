import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const digest = text => createHash('sha256').update(text).digest('hex');
const format = 'cards-sweep/0.1';
const invalid = message => Object.assign(new Error(message), { code: 'usage.bad-argument' });

function directory(outDir) {
  if (typeof outDir !== 'string' || !outDir.trim()) throw invalid('outDir 须为非空目录路径');
  const input = path.sep === '\\' ? outDir.replaceAll('/', path.sep) : outDir;
  const absolute = path.isAbsolute(input) ? input : process.cwd() + path.sep + input;
  let dir = path.parse(absolute).root;
  for (const part of absolute.slice(dir.length).split(path.sep)) {
    if (!part || part === '.') continue;
    dir = path.join(dir, part);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) fs.mkdirSync(dir, { recursive: true });
    else if (!stat.isDirectory()) throw invalid('outDir 路径含符号链接或非目录项');
  }
  return dir;
}

export function encodeCells(card, columns, rows, cells) {
  const payload = { card, columns, rows, cells };
  const text = JSON.stringify({ format, ...payload, sha256: digest(JSON.stringify(payload)) }) + '\n';
  return { text, artifacts: { cellsPath: 'cells.json', sha256: digest(text) } };
}

export function writeCells(outDir, { text, artifacts }) {
  const dir = directory(outDir), target = path.join(dir, artifacts.cellsPath);
  const temp = path.join(dir, `.cells-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx');
  try {
    try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
    // 首次发布用硬链接原子占位，别的写入者先创建的文件会得到 EEXIST。
    try { fs.linkSync(temp, target); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(target).isFile()) throw invalid('cells.json 须为普通文件');
    const prefix = `{"format":"${format}",`;
    const start = Buffer.alloc(prefix.length);
    const prior = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      fs.readSync(prior, start, 0, start.length, 0);
      if (start.toString() !== prefix) throw invalid('cells.json 已由其他工具占用');
      const { format: previous, sha256, ...payload } = JSON.parse(fs.readFileSync(prior, 'utf8'));
      if (previous !== format || ![payload.columns, payload.rows, payload.cells].every(Array.isArray)
        || sha256 !== digest(JSON.stringify(payload))) throw invalid('cells.json 不是完整的扫参产物');
    } finally { fs.closeSync(prior); }
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
