// tests/production 共用的夹具：临时作品目录（系统临时目录里，测试结束删除）、最小 v2 作品、命令行调用。
// 不是测试文件（没有 .test. 字样），node --test 的 glob 不会把它当测试跑。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const FILM_CLI = join(REPO, 'engine', 'production', 'film.js');
export const clone = v => structuredClone(v);
export const codes = r => r.diagnostics.map(d => d.code);
export const errors = r => r.diagnostics.filter(d => d.level === 'error').map(d => d.code);
export const warnings = r => r.diagnostics.filter(d => d.level === 'warning').map(d => d.code);

/** 最小合格的 v2 作品：C 路线、默认档、两镜 [0,48) [48,96)、一个事件。 */
export function minimalFilm(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'tfilm',
    title: '测试片',
    route: 'c',
    backend: 'canvas',
    output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 96 },
    shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 48, out: 96 }],
    events: [{ id: 'a.hit', frame: 60, shot: 'S2', audio: 'hit', visual: '落点' }],
    audio: { mode: 'none' },
    credits: [],
    aigc: { contains: false },
    ...overrides,
  };
}

/**
 * 在系统临时目录里建一个作品目录 <tmp>/<id>/：写 film.json、index.html 与 extra 里的文件。
 * 返回 { root, dir, file, cleanup }；调用方在 finally 里 cleanup()。
 */
export function tempFilm(film = minimalFilm(), extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'beiming-p05-'));
  const dir = join(root, film.id && /^[a-z0-9-]+$/.test(film.id) ? film.id : 'film');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'film.json');
  writeFileSync(file, typeof film === 'string' ? film : `${JSON.stringify(film, null, 2)}\n`);
  if (!('index.html' in extra)) writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>t</title>\n');
  for (const [rel, text] of Object.entries(extra)) {
    if (text === null) continue;
    const p = join(dir, ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }
  return { root, dir, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 跑 node engine/production/film.js …；返回 { status, stdout, stderr, json }（加 --json 时解析 stdout）。 */
export function runFilm(args, { cwd = REPO, env = {} } = {}) {
  const r = spawnSync(process.execPath, [FILM_CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { json = undefined; } }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** 用户原话的人工记录参数（测试用；真实记录照录用户原话）。 */
export const HUMAN = Object.freeze({
  quote: '风格帧可以，就按这个方向做。',
  source: { kind: 'session', ref: '测试会话第 3 条消息', at: '2026-11-10T10:00:00+08:00' },
  reviewer: { kind: 'human', name: '用户' },
  recordedBy: { kind: 'ai', name: 'agent' },
});
