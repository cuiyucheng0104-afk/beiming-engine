// 题库读取：evals/agent/tasks/<ID>.json（配置）+ <ID>.md（发给代理的原文）+ evals/agent/replies/<ID>.json。
//
// 原文取自 md 里「## 发给代理的原文」之后的第一个 ```text 代码块，逐字使用；task.context 不为空时，
// 第一条消息 = context + 空行 + 原文（背景说明由评测方补充，在任务书里单独标出）。
// 接口：EVALS_DIR、listTaskIds()、loadTask(id)、loadReplies(task)、firstMessage(task)、validateBank()

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalError, EXIT } from './cli.mjs';
import { readJson } from './files.mjs';
import { validate } from './schema.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const EVALS_DIR = path.join(REPO_ROOT, 'evals', 'agent');
const TASKS_DIR = path.join(EVALS_DIR, 'tasks');
const REPLIES_DIR = path.join(EVALS_DIR, 'replies');
const SCHEMA_DIR = path.join(EVALS_DIR, 'schema');

export const loadSchema = name => readJson(path.join(SCHEMA_DIR, `${name}.schema.json`), `schema ${name}`);

export function listTaskIds(dir = TASKS_DIR) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}

/** 从任务书 md 中取「发给代理的原文」代码块。 */
export function extractPrompt(markdown, file = '任务书') {
  const idx = markdown.indexOf('## 发给代理的原文');
  if (idx < 0) throw new EvalError('prompt-missing', `${file} 没有「## 发给代理的原文」一节`, { exitCode: EXIT.CONTRACT, hint: '按 evals/agent/tasks/DF-A.md 的格式补上' });
  const m = /```text\r?\n([\s\S]*?)\r?\n```/.exec(markdown.slice(idx));
  if (!m) throw new EvalError('prompt-missing', `${file} 的「发给代理的原文」下面没有 \`\`\`text 代码块`, { exitCode: EXIT.CONTRACT, hint: '原文放进 ```text … ``` 代码块里' });
  return m[1].replace(/\r\n/g, '\n');
}

/**
 * 读一道题。id 可以是题号（DF-A）或 task.json 路径。
 * 返回任务对象，附 _file、_prompt（原文）、_dir。
 */
export function loadTask(idOrPath, { tasksDir = TASKS_DIR } = {}) {
  const file = idOrPath.endsWith('.json') ? path.resolve(idOrPath) : path.join(tasksDir, `${idOrPath}.json`);
  if (!fs.existsSync(file)) {
    const ids = fs.existsSync(tasksDir) ? listTaskIds(tasksDir) : [];
    throw new EvalError('task-unknown', `没有这道题：${idOrPath}`, { exitCode: EXIT.USAGE, hint: `可用题号：${ids.join('、') || '（题库为空）'}` });
  }
  const task = readJson(file, '任务配置');
  const errors = validate(loadSchema('task'), task);
  if (errors.length) {
    throw new EvalError('task-invalid', `任务配置 ${file} 不合格：${errors.slice(0, 5).map(e => `${e.path || '$'} ${e.message}`).join('；')}`, { exitCode: EXIT.CONTRACT, hint: '按 evals/agent/schema/task.schema.json 修正' });
  }
  const dir = path.dirname(file);
  const md = path.join(dir, task.prompt);
  if (!fs.existsSync(md)) throw new EvalError('prompt-missing', `任务书 ${md} 不存在`, { exitCode: EXIT.CONTRACT });
  Object.defineProperty(task, '_file', { value: file, enumerable: false });
  Object.defineProperty(task, '_dir', { value: dir, enumerable: false });
  Object.defineProperty(task, '_prompt', { value: extractPrompt(fs.readFileSync(md, 'utf8'), md), enumerable: false });
  return task;
}

const EMPTY_REPLIES = task => ({ schemaVersion: 1, task: task.id, prompt: { approves: [], waives: [] }, replies: [], fallback: { text: null, max: 0 } });

/** 读脚本化回复；任务没有回复文件时返回空脚本（代理停下即结束）。 */
export function loadReplies(task, { repliesDir = null } = {}) {
  if (!task.replies) return EMPTY_REPLIES(task);
  const dir = repliesDir ?? path.join(path.dirname(task._dir ?? TASKS_DIR), 'replies');
  const file = path.join(dir, task.replies);
  const replies = readJson(file, '脚本化回复');
  const errors = validate(loadSchema('replies'), replies);
  if (errors.length) {
    throw new EvalError('replies-invalid', `回复文件 ${file} 不合格：${errors.slice(0, 5).map(e => `${e.path || '$'} ${e.message}`).join('；')}`, { exitCode: EXIT.CONTRACT, hint: '按 evals/agent/schema/replies.schema.json 修正' });
  }
  if (replies.task !== task.id) throw new EvalError('replies-invalid', `回复文件 ${file} 属于 ${replies.task}，不是 ${task.id}`, { exitCode: EXIT.CONTRACT });
  return replies;
}

/** 第一条用户消息（逐字）。 */
export function firstMessage(task) {
  return task.context ? `${task.context}\n\n${task._prompt}` : task._prompt;
}

/** 校验整个题库：每道题的配置、原文、回复都能读、互相引用一致。返回 [{ id, ok, errors }]。 */
export function validateBank({ tasksDir = TASKS_DIR } = {}) {
  return listTaskIds(tasksDir).map(id => {
    try {
      const task = loadTask(id, { tasksDir });
      const replies = loadReplies(task);
      const problems = [];
      if (task.id !== id) problems.push(`文件名 ${id}.json 与 id ${task.id} 不一致`);
      const gateNames = new Set([...(task.gates.required ?? []), ...(task.gates.recommended ?? [])].map(g => g.gate));
      for (const r of replies.replies) {
        for (const g of [...r.approves, ...r.waives]) if (!gateNames.has(g) && !(task.gates.forbidApprove ?? []).includes(g)) problems.push(`回复 ${r.id} 批准或豁免了任务里没有的闸门 ${g}`);
        if ((task.gates.forbidApprove ?? []).some(g => r.approves.includes(g))) problems.push(`回复 ${r.id} 批准了不允许批准的闸门`);
      }
      const md = fs.readFileSync(path.join(task._dir, task.prompt), 'utf8');
      const ctxIdx = md.indexOf('## 会话背景');
      if (ctxIdx >= 0) {
        const m = /```text\r?\n([\s\S]*?)\r?\n```/.exec(md.slice(ctxIdx));
        if (!m || m[1] !== task.context) problems.push('任务书「会话背景」代码块与 JSON 的 context 不一致');
      } else if (task.context) problems.push('JSON 有 context，但任务书里没有「## 会话背景」一节');
      if (task.kind === 'film' && !task.spec) problems.push('出片题必须有 spec');
      if (task.kind === 'film' && !task.filmId) problems.push('出片题必须有 filmId');
      if (task.filmId && !task.writeScope.includes(`films/${task.filmId}/`)) problems.push(`writeScope 应包含 films/${task.filmId}/`);
      return { id, ok: problems.length === 0, errors: problems };
    } catch (e) {
      return { id, ok: false, errors: [e.message] };
    }
  });
}
