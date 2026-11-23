import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const digest = text => createHash('sha256').update(text).digest('hex');
const format = 'cards-sweep/0.1';
const invalid = message => Object.assign(new Error(message), { code: 'usage.bad-argument' });
const foreign = () => Object.assign(new Error('cells.json 不是完整的扫参产物'), { code: 'contract.bad-value' });

function directory(outDir) {
  if (typeof outDir !== 'string' || !outDir.trim() || outDir.includes('\0')) throw invalid('outDir 须为非空目录路径');
  const absolute = path.resolve(outDir);
  let dir = path.parse(absolute).root;
  for (const part of absolute.slice(dir.length).split(path.sep).filter(Boolean)) {
    dir = path.join(dir, part);
    let stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) {
      fs.mkdirSync(dir, { recursive: true });
      stat = fs.lstatSync(dir);
    }
    if (stat.isSymbolicLink() && process.platform === 'darwin' && ['/tmp', '/var', '/etc'].includes(dir)) {
      dir = fs.realpathSync(dir);
    } else if (!stat.isDirectory()) throw invalid('outDir 路径含符号链接或非目录项');
  }
  fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  return dir;
}

// 用同一文件描述符读取签名和摘要。只有通过核验的旧产物可以替换。
function checkTarget(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile()) throw invalid('cells.json 须为普通文件');
  const prior = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const prefix = `{"format":"${format}",`;
    const start = Buffer.alloc(prefix.length);
    fs.readSync(prior, start, 0, start.length, 0);
    if (start.toString() !== prefix) throw foreign();
    let record;
    try { record = JSON.parse(fs.readFileSync(prior, 'utf8')); } catch (error) {
      if (error instanceof SyntaxError) throw foreign();
      throw error;
    }
    const { format: previous, sha256, ...payload } = record;
    if (previous !== format || typeof payload.card !== 'string' || ![payload.columns, payload.rows, payload.cells].every(Array.isArray)
      || sha256 !== digest(JSON.stringify(payload))) throw foreign();
    return fs.fstatSync(prior);
  } finally { fs.closeSync(prior); }
}

export function prepareOutDir(outDir) {
  const dir = directory(outDir);
  checkTarget(path.join(dir, 'cells.json'));
  return dir;
}

export function encodeCells(card, columns, rows, cells) {
  const payload = { card, columns, rows, cells };
  const text = JSON.stringify({ format, ...payload, sha256: digest(JSON.stringify(payload)) }) + '\n';
  return { text, artifacts: { cellsPath: 'cells.json', sha256: digest(text) } };
}

function publishNew(temp, target) {
  try { fs.linkSync(temp, target); } catch (error) {
    if (!['ENOTSUP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
    fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL);
  }
}

export function writeCells(outDir, { text, artifacts }) {
  const dir = directory(outDir), target = path.join(dir, artifacts.cellsPath);
  const temp = path.join(dir, `.cells-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx');
  try {
    try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
    try { publishNew(temp, target); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const prior = checkTarget(target);
    const current = fs.lstatSync(target);
    if (!current.isFile() || prior?.dev !== current.dev || prior.ino !== current.ino || prior.ctimeMs !== current.ctimeMs) {
      throw invalid('cells.json 在写入期间发生变化');
    }
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
