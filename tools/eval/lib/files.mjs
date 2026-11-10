// 文件工具：读写 JSON / JSONL、原子写、sha256、递归列举、受保护的删除。
//
// 接口：readJson、readJsonIfExists、writeJson（先写 .partial 再改名）、appendJsonl、readJsonl、
//       sha256File、walk(dir, { skipDirs, includeDirs })、listEntries、removeTree(dir, guardRoot)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EvalError, EXIT } from './cli.mjs';
import { isInside } from './paths.mjs';

export function readJson(file, what = 'JSON 文件') {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new EvalError('file-missing', `读不到${what}：${file}（${e.code ?? e.message}）`, { exitCode: EXIT.USAGE, hint: '检查路径是否正确' });
  }
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    throw new EvalError('json-invalid', `${what}不是合法 JSON：${file}（${e.message}）`, { exitCode: EXIT.CONTRACT, hint: '修正该文件的 JSON 语法后重跑' });
  }
}

export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/** 原子写 JSON：写 <file>.partial 后改名，避免中断留下半截文件。 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.partial`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

/** 读 JSONL：返回 { records, bad }，坏行计数而不中断（会话记录可能被截断）。 */
export function readJsonl(file) {
  const records = [];
  let bad = 0;
  if (!fs.existsSync(file)) return { records, bad };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { records.push(JSON.parse(s)); } catch { bad++; }
  }
  return { records, bad };
}

export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

export const sha256Text = text => crypto.createHash('sha256').update(text).digest('hex');

/**
 * 递归列举文件（不跟随符号链接）。返回 [{ abs, rel, size, mtimeMs, isDir }]，rel 用 / 分隔。
 * skipDirs：目录名集合（如 node_modules、.git）。
 */
export function walk(dir, { skipDirs = new Set(['.git', 'node_modules']), includeDirs = false, base = dir } = {}, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      if (includeDirs) {
        const st = fs.lstatSync(abs);
        out.push({ abs, rel, size: 0, mtimeMs: st.mtimeMs, isDir: true });
      }
      walk(abs, { skipDirs, includeDirs, base }, out);
    } else if (e.isFile()) {
      const st = fs.lstatSync(abs);
      out.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs, isDir: false });
    }
  }
  return out;
}

/** 列出目录第一层（不存在返回空数组）。 */
export function listEntries(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** 删除目录树；只允许删 guardRoot 之内的路径，防止误删。 */
export function removeTree(target, guardRoot) {
  if (!fs.existsSync(target)) return false;
  if (!isInside(guardRoot, target) || path.resolve(target) === path.resolve(guardRoot)) {
    throw new EvalError('unsafe-remove', `拒绝删除 ${target}：不在 ${guardRoot} 之内`, { exitCode: EXIT.RUN, hint: '这是评测工具的保护；确认路径后手工处理' });
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  return true;
}
