// 北冥引擎 · 运行记录 run.json（RenderResult v1 扩展，加固计划附录 C8）：每次渲染都写，失败时也写。
// 渲染器只写实测事实：status 只写 running（stage 记到哪一步：rendering 渲染中、rendered 已出片待 QA）或 failed；
// passed / accepted 由 QA 门与人工评审之后的出片编排改写。technicalAcceptance 一律 not-run（交给 QA 判定），
// creativeAcceptance 一律 not-reviewed（交给人工评审）。写完用作品描述包的校验器自检（engine/production/film.js 落地后
// 优先用它，否则 project.js 的 validateRenderResult），结果记进 selfCheck（只提示、不影响退出码：口径由作品描述包维护）。
//   environment(root)          { sourceCommit, dirty, tools{ node, playwright, three, ffmpeg }, host{ platform, arch, release, cpus, memGB } }
//   runId(env, date)           YYYYMMDD-HHMMSS-<短提交>[-dirty]（附录 C4）
//   writeLatest(outRoot, id)   写指针文件 <outRoot>/latest（内容是运行号，不用符号链接；附录 C4）
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

const inside = r => r !== '' && !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r));
/** 最近一个存在的上级目录的真实路径，再接上不存在的那一截（文件还没写出来时也能比） */
function realish(p) {
  const rest = [];
  for (let a = path.resolve(p); ; a = path.dirname(a)) {
    try { return path.join(fs.realpathSync(a), ...rest.reverse()); } catch {}
    if (path.dirname(a) === a) return path.resolve(p);
    rest.push(path.basename(a));
  }
}
/**
 * 仓库相对路径（POSIX 分隔符）：先按字面比，不在仓库里再按真实路径比（macOS 的 /var → /private/var、符号链接、
 * Windows 目录联接进来的路径也认得出）；真的在仓库外才写绝对路径。
 */
export function repoPath(root, p) {
  const abs = path.resolve(p);
  let r = path.relative(root, abs);
  if (!inside(r)) r = path.relative(realish(root), realish(abs));
  return inside(r) ? r.split(path.sep).join('/') : (r === '' ? '.' : abs);
}

export function baseRecord({ command, argv, env, projectId, shotId = 'film', route = null, backend = 'page' }) {
  return {
    schemaVersion: 1,
    kind: 'render-run',
    status: 'running',
    stage: 'rendering',
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

/** 写 <outRoot>/latest 指针（原子写；内容是运行号加换行） */
export function writeLatest(outRoot, id) {
  fs.mkdirSync(outRoot, { recursive: true });
  const file = path.join(outRoot, 'latest'), tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${id}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** 用作品描述包的校验器自检（存在才调）：{ validator, ok, diagnostics } */
export async function selfCheck(root, record, { expectedFrameCount } = {}) {
  const candidates = [['film.js', ['validateRenderResult', 'validateResult']], ['project.js', ['validateRenderResult']]];
  for (const [name, fns] of candidates) {
    const file = path.join(root, 'engine', 'production', name);
    if (!fs.existsSync(file)) continue;
    let mod;
    try { mod = await import(pathToFileURL(file).href); } catch (e) {
      return { validator: `engine/production/${name}`, ok: null, diagnostics: [{ code: 'validator-crashed', path: '$', message: String(e?.message ?? e) }] };
    }
    const fn = fns.find(f => typeof mod[f] === 'function');
    if (!fn) continue;
    const id = `engine/production/${name}#${fn}`;
    try {
      const r = mod[fn](record, { expectedFrameCount });
      return { validator: id, ok: r?.ok ?? null, diagnostics: r?.diagnostics ?? [] };
    } catch (e) {
      return { validator: id, ok: null, diagnostics: [{ code: 'validator-crashed', path: '$', message: String(e?.message ?? e) }] };
    }
  }
  return { validator: null, ok: null, diagnostics: [] };
}
