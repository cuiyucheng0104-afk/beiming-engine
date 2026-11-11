// 北冥仓库 · agent 护栏日志
// 做什么：把"拒绝"和"附带提醒"的判定追加成一行 JSON 到 out/agent-guard/guard.jsonl（out/ 已被 .gitignore 忽略），
//         给审计与 agent 评测用（扫描是否有人尝试写快照、整树暂存等）。普通放行不记。
// 接口：appendLog(entry, { root, env }) —— 永不抛错；BEIMING_GUARD_LOG=off 关闭，=<路径> 改写到该文件（相对路径按仓库根）。
// 命令文本会截断到 400 字并遮住常见的密钥写法。单个日志超过 2 MiB 时轮换为 guard.jsonl.1。
import fs from 'node:fs';
import path from 'node:path';
import { LOG_ENV, DEFAULT_LOG } from './policy.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const SECRET = [
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bLTAI[0-9A-Za-z]{12,}\b/g,
  /((?:password|passwd|token|secret|api[_-]?key|access[_-]?key)\s*[=:]\s*)\S+/gi,
  /(Signature|OSSAccessKeyId|X-Amz-Signature|X-Amz-Credential)=[^&\s"']+/g,
];

export function redact(text, max = 400) {
  let s = String(text ?? '');
  for (const re of SECRET) s = s.replace(re, (m, p1) => (typeof p1 === 'string' && /[=:]\s*$/.test(p1) ? `${p1}***` : '***'));
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function logPath({ root, env = process.env }) {
  const v = String(env?.[LOG_ENV] ?? '').trim();
  if (/^(off|0|false|no|none)$/i.test(v)) return null;
  const p = v || DEFAULT_LOG;
  return path.isAbsolute(p) ? p : path.join(root, p);
}

export function appendLog(entry, { root, env = process.env } = {}) {
  try {
    const file = logPath({ root, env });
    if (!file) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch { /* 还没有日志 */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    return file;
  } catch {
    return null;
  }
}
