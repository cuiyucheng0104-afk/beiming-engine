// 北冥引擎 · 运行记录 run.json（RenderResult v1 扩展，加固计划附录 C8）：每次渲染都写，失败时也写。
// 渲染器只写实测事实（status 为 rendered / failed）；technicalAcceptance 一律 not-run（交给 QA 判定），
// creativeAcceptance 一律 not-reviewed（交给人工评审）。写完用 engine/production/project.js 的 validateRenderResult 自检，
// 结果记进 selfCheck（只提示、不影响退出码：校验器的口径由作品描述包维护）。
//   environment(root)          { sourceCommit, dirty, tools{ node, playwright, three, ffmpeg }, host{ platform, arch, release, cpus, memGB } }
//   runId(env, date)           YYYYMMDD-HHMMSS-<短提交>[-dirty]（附录 C4）
//   baseRecord({...})          记录骨架
//   writeRecord(file, record)  原子写（先写 .tmp 再改名），返回路径
//   sha256File(file)           流式计算
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? r.stdout : null;
}

export function environment(root, { ffmpegVersion = null } = {}) {
  const head = git(root, ['rev-parse', 'HEAD']);
  const status = head === null ? null : git(root, ['status', '--porcelain', '--untracked-files=normal']);
  return {
    sourceCommit: head ? head.trim() : null,
    dirty: status === null ? null : status.trim().length > 0,
    tools: {
      node: process.version,
      playwright: readJson(path.join(root, 'node_modules', 'playwright-core', 'package.json'))?.version ?? null,
      three: readJson(path.join(root, 'node_modules', 'three', 'package.json'))?.version ?? null,
      ffmpeg: ffmpegVersion,
    },
    host: { platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length, memGB: +(os.totalmem() / 2 ** 30).toFixed(1) },
  };
}

export function runId(env, date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${env.sourceCommit ? env.sourceCommit.slice(0, 7) : 'nogit'}${env.dirty ? '-dirty' : ''}`;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/** 仓库相对路径（POSIX 分隔符）；在仓库外就写绝对路径 */
export function repoPath(root, p) {
  const r = path.relative(root, path.resolve(p));
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : path.resolve(p);
}

export function baseRecord({ command, argv, env, projectId, shotId = 'film', route = null, backend = 'page' }) {
  return {
    schemaVersion: 1,
    kind: 'render-run',
    status: 'running',
    command,
    projectId, shotId, route, backend,
    sourceCommit: env.sourceCommit, dirty: env.dirty,
    argv,
    tools: env.tools,
    host: env.host,
    actualDevice: null,
    actualGraphicsBackend: null,
    actualEncoder: null,
    softwareFallback: null,
    output: null,
    timing: {},
    warnings: [],
    error: null,
    technicalAcceptance: { status: 'not-run', evidence: [] },
    creativeAcceptance: { status: 'not-reviewed', reviews: [], events: [], styleComparison: [], issues: [] },
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

export function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 1) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

/** 用作品描述包的校验器自检（存在才调）：{ validator, ok, diagnostics } */
export async function selfCheck(root, record, { expectedFrameCount } = {}) {
  const file = path.join(root, 'engine', 'production', 'project.js');
  if (!fs.existsSync(file)) return { validator: null, ok: null, diagnostics: [] };
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.validateRenderResult !== 'function') return { validator: null, ok: null, diagnostics: [] };
    const r = mod.validateRenderResult(record, { expectedFrameCount });
    return { validator: 'engine/production/project.js#validateRenderResult', ok: r.ok, diagnostics: r.diagnostics ?? [] };
  } catch (e) {
    return { validator: 'engine/production/project.js#validateRenderResult', ok: null, diagnostics: [{ code: 'validator-crashed', path: '$', message: String(e?.message ?? e) }] };
  }
}
