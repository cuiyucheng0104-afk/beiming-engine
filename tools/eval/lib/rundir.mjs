// 评测运行目录（run.mjs prepare 建立，gates / score 读取）的布局与读取。
//
// <评测根>/<题号>/<运行号>/
//   meta.json        运行元数据（kind = beiming-eval-run；路径都相对本目录）
//   task.json        题目配置快照；replies.json 回复脚本快照；prompt.txt 第一条消息全文
//   baseline.json    开跑前的基线：git 状态与文件哈希、被忽略条目、渲染进程、临时目录内容、films/ 下已有作品
//   injections.jsonl 每一条发给代理的用户消息（第 0 条是任务书），含时间与审批含义
//   drive.json       驱动记录：各轮起止、退出码、停止原因、用量
//   worktree/        被测检出（git clone，已删除远端）
//   tmp/             会话的 TMPDIR / TMP / TEMP
//   session/         隔离的会话配置：config/（CLAUDE_CONFIG_DIR）、settings.json、mcp.json、COMMAND.txt
//   transcript/      turn-NN.jsonl（stream-json）、turn-NN.stderr.log、session/（复制来的会话 JSONL）
//   snapshots/       turn-NN.json：每轮结束时作品目录的文件清单与 film.json（「先看后做」、DF-M 同源时间的证据）
//   gates.json、artifacts.json、review/、review-sheet.json、score.json  由 finish / score 生成
// 接口：RUN_KIND、loadRun(dir)、filmDirOf(run)、newRunId(commit, attempt)、latestFilmRun(filmDir)、filmRenderRuns(filmDir)、
//       snapshotFilm(run, turn)、loadSnapshots(runDir)

import fs from 'node:fs';
import path from 'node:path';
import { EvalError, EXIT } from './cli.mjs';
import { readJson, readJsonIfExists, readJsonl, walk, writeJson } from './files.mjs';
import { validate } from './schema.mjs';
import { loadSchema } from './task.mjs';

export const RUN_KIND = 'beiming-eval-run';

/** 运行号：YYYYMMDD-HHMMSS-<短提交>-a<尝试次数>（本地时间，与 C4 的 run-id 写法一致）。 */
export function newRunId(commit, attempt = 1, now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${String(commit).slice(0, 7)}-a${attempt}`;
}

export function loadRun(dir) {
  const runDir = path.resolve(dir);
  const metaFile = path.join(runDir, 'meta.json');
  if (!fs.existsSync(metaFile)) {
    throw new EvalError('run-missing', `${runDir} 不是评测运行目录（没有 meta.json）`, { exitCode: EXIT.USAGE, hint: '先用 node tools/eval/run.mjs prepare --task <题号> 建立运行目录' });
  }
  const meta = readJson(metaFile, '运行元数据');
  if (meta.kind !== RUN_KIND) throw new EvalError('run-invalid', `${metaFile} 的 kind 不是 ${RUN_KIND}`, { exitCode: EXIT.CONTRACT });
  const task = readJson(path.join(runDir, 'task.json'), '题目快照');
  const errors = validate(loadSchema('task'), task);
  if (errors.length) throw new EvalError('task-invalid', `题目快照不合格：${errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('；')}`, { exitCode: EXIT.CONTRACT });
  const replies = readJsonIfExists(path.join(runDir, 'replies.json')) ?? { replies: [], prompt: { approves: [], waives: [] }, fallback: { text: null, max: 0 } };
  const { records: injections, bad } = readJsonl(path.join(runDir, 'injections.jsonl'));
  const resolveIn = p => (p ? path.resolve(runDir, p) : null);
  return {
    dir: runDir,
    meta,
    task,
    replies,
    injections,
    injectionsBad: bad,
    hasInjections: fs.existsSync(path.join(runDir, 'injections.jsonl')),
    baseline: readJsonIfExists(path.join(runDir, 'baseline.json')),
    drive: readJsonIfExists(path.join(runDir, 'drive.json')),
    worktree: resolveIn(meta.worktree ?? 'worktree'),
    tmpDir: resolveIn(meta.tmp ?? 'tmp'),
    sessionDir: resolveIn(meta.session ?? 'session'),
    prompt: fs.existsSync(path.join(runDir, 'prompt.txt')) ? fs.readFileSync(path.join(runDir, 'prompt.txt'), 'utf8') : null,
  };
}

/** 作品目录：任务指定 filmId 时取 films/<id>；否则取基线之后新建的唯一作品目录（S1、DR-W）。 */
export function filmDirOf(run) {
  const films = path.join(run.worktree, 'films');
  if (run.task.filmId) return { id: run.task.filmId, dir: path.join(films, run.task.filmId), created: [] };
  const before = new Set(run.baseline?.films ?? []);
  const now = fs.existsSync(films) ? fs.readdirSync(films, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
  const created = now.filter(n => !before.has(n)).sort();
  return created.length ? { id: created[0], dir: path.join(films, created[0]), created } : { id: null, dir: null, created };
}

/**
 * 作品最近一次运行目录（附录 C4）：films/<名>/out/latest 指针文件优先（内容是运行号或相对路径），
 * 否则取 out/ 下名字最大的、含 run.json 或 mp4 的子目录。返回绝对路径或 null。
 */
export function latestFilmRun(filmDir) {
  if (!filmDir) return null;
  const out = path.join(filmDir, 'out');
  const pointer = path.join(out, 'latest');
  if (fs.existsSync(pointer) && fs.statSync(pointer).isFile()) {
    const text = fs.readFileSync(pointer, 'utf8').trim().split(/\r?\n/)[0]?.trim();
    if (text) {
      const candidates = [path.resolve(out, text), path.resolve(filmDir, text)];
      for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    }
  }
  if (!fs.existsSync(out)) return null;
  const dirs = fs.readdirSync(out, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'cache')
    .map(e => path.join(out, e.name))
    .filter(d => fs.existsSync(path.join(d, 'run.json')) || fs.readdirSync(d).some(f => f.endsWith('.mp4')))
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

/** films/<名>/out/ 下所有「出过片」的运行目录（含 mp4），用于统计终渲次数。 */
export function filmRenderRuns(filmDir) {
  const out = filmDir ? path.join(filmDir, 'out') : null;
  if (!out || !fs.existsSync(out)) return [];
  return fs.readdirSync(out, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'cache')
    .map(e => path.join(out, e.name))
    .filter(d => ['master.mp4', 'web.mp4'].some(f => fs.existsSync(path.join(d, f))))
    .sort();
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/**
 * 记一轮结束时作品目录的样子：文件清单（相对作品目录，最多 5000 条）、图片数、film.json 内容。
 * 写到 <运行目录>/snapshots/turn-NN.json；作品目录还不存在时也写（files 为空），方便看出「第几轮才建作品」。
 */
export function snapshotFilm(run, turn, now = new Date()) {
  const film = filmDirOf(run);
  const snap = { schemaVersion: 1, turn, at: now.toISOString(), filmId: film.id, files: [], truncated: false, images: 0, film: null };
  if (film.dir && fs.existsSync(film.dir)) {
    const all = walk(film.dir, { skipDirs: new Set(['node_modules', 'cache', '.git', '__pycache__']) });
    snap.truncated = all.length > 5000;
    snap.files = all.slice(0, 5000).map(e => ({ rel: e.rel, size: e.size, mtimeMs: Math.round(e.mtimeMs) }));
    snap.images = all.filter(e => IMAGE_RE.test(e.rel)).length;
    snap.film = readJsonIfExists(path.join(film.dir, 'film.json'));
  }
  const file = path.join(run.dir, 'snapshots', `turn-${String(turn).padStart(2, '0')}.json`);
  writeJson(file, snap);
  return file;
}

/** 读全部快照，按轮次排序。 */
export function loadSnapshots(runDir) {
  const dir = path.join(runDir, 'snapshots');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^turn-\d+\.json$/.test(f))
    .map(f => readJsonIfExists(path.join(dir, f))).filter(Boolean).sort((a, b) => a.turn - b.turn);
}
