// 服务端的数据目录：
//   <dataDir>/auth.json                令牌表（auth.mjs）
//   <dataDir>/state.json               片子与作业的计数器、作业 → 片子的对照
//   <dataDir>/films/<片子>/            工作区（jobs/workspace.mjs）：film.json、film.lock、shots/、assets/、rev、snapshots/、deliver/、jobs/
//   <dataDir>/meta/<片子>.json         服务器对这部片的记录：模板、资产、考题、作者模式、上一轮的修法、最近一次渲染与交付
//   <dataDir>/meta/<片子>.ledger.jsonl 账本：每次调用、每个作业一行
//   <dataDir>/view/agx-mhc.cube        agx-mhc 查找表（runtime.mjs）
// 写盘都是同步的：同一个进程里一次读改写不会被别的请求插进来。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openWorkspace } from '../jobs/index.mjs';
import { generateLock, serializeLock } from '../kernel/lock-gen.mjs';
import { createHash } from 'node:crypto';
import { assetPaths } from './assets.mjs';
import { ApiError } from './envelope.mjs';
import { lockContext } from './runtime.mjs';

const jsonText = (v) => `${JSON.stringify(v, null, 2)}\n`;

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function createStore(dataDir) {
  mkdirSync(join(dataDir, 'films'), { recursive: true });
  mkdirSync(join(dataDir, 'meta'), { recursive: true });
  const stateFile = join(dataDir, 'state.json');
  const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { format: 'api-state/0.1', films: 0, jobs: 0, jobFilm: {} });
  const updateState = (fn) => { const s = readState(); const out = fn(s); writeAtomic(stateFile, jsonText(s)); return out; };

  const filmDir = (id) => join(dataDir, 'films', id);
  const metaFile = (id) => join(dataDir, 'meta', `${id}.json`);
  const ledgerFile = (id) => join(dataDir, 'meta', `${id}.ledger.jsonl`);
  const workspaces = new Map();
  const locks = new Map();

  const store = {
    dataDir,
    filmDir,
    exists: (id) => typeof id === 'string' && /^[a-z][a-z0-9_-]*$/.test(id) && existsSync(metaFile(id)),
    workspace(id) {
      if (!workspaces.has(id)) workspaces.set(id, openWorkspace(filmDir(id)));
      return workspaces.get(id);
    },
    nextFilmId: () => updateState((s) => `f_${String(++s.films).padStart(3, '0')}`),
    nextJobId: (filmId) => updateState((s) => { const id = `j-${++s.jobs}`; s.jobFilm[id] = filmId; return id; }),
    filmOfJob: (jobId) => readState().jobFilm[jobId],
    readMeta: (id) => JSON.parse(readFileSync(metaFile(id), 'utf8')),
    writeMeta: (id, meta) => writeAtomic(metaFile(id), jsonText(meta)),
    updateMeta(id, fn) { const m = store.readMeta(id); fn(m); store.writeMeta(id, m); return m; },
    readFilm: (id) => JSON.parse(readFileSync(join(filmDir(id), 'film.json'), 'utf8')),
    rev: (id) => store.workspace(id).readRevision() ?? 0,
    ledger(id, entry) {
      const n = existsSync(ledgerFile(id)) ? readFileSync(ledgerFile(id), 'utf8').split('\n').filter(Boolean).length : 0;
      appendFileSync(ledgerFile(id), `${JSON.stringify({ seq: n + 1, ...entry })}\n`);
    },
    readLedger: (id) => (existsSync(ledgerFile(id)) ? readFileSync(ledgerFile(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    /** 每部片的写入排成一队（建片、改片、交文件、传资产） */
    serial(id, fn) {
      const prev = locks.get(id) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      locks.set(id, run.catch(() => {}));
      return run;
    },
  };

  /** 所有输入与正式锁一起提交；签锁或快照失败就恢复先前字节。 */
  store.commit = function commit(id, film, rev, { files = {}, library, lut }) {
    const root = filmDir(id);
    const touched = ['film.json', 'film.lock', ...Object.keys(files)];
    const backup = Object.fromEntries(touched.map((p) => [p, existsSync(join(root, p)) ? readFileSync(join(root, p)) : null]));
    const diagnostics = [];
    try {
      for (const [p, text] of Object.entries(files)) writeAtomic(join(root, p), text);
      writeAtomic(join(root, 'film.json'), jsonText(film));
      const assets = Object.fromEntries(Object.entries(assetPaths(root)).map(([ref, path]) => [ref, readFileSync(path)]));
      for (const owner of [film, ...film.shots]) for (const ref of Object.values(owner.assets ?? {})) {
        if (!Object.hasOwn(assets, ref)) throw new ApiError('contract.bad-value', `资产 ${ref} 未登记，请使用资产库或上传返回的引用`);
      }
      if (!lut) throw new ApiError('env.lock-required', '签锁缺少 agx-mhc 查找表，请安装 Blender 后重试');
      let lock;
      try { lock = generateLock(film, lockContext({ rev, library, lut, assets, film, filmDir: root })); }
      catch (e) { throw new ApiError('env.lock-required', `正式锁生成失败：${e.message.split('\n')[0]}`); }
      // 冻结锁以资产摘要锚定题目原文（包含全部必验断言），同修订快照保存对应字节。
      if (film.exam && existsSync(join(root, 'exam.json'))) {
        lock.assets[`asset:exam-${film.exam}@1`] = `sha256:${createHash('sha256').update(readFileSync(join(root, 'exam.json'))).digest('hex')}`;
      }
      const lockText = `${serializeLock(lock)}\n`;
      writeAtomic(join(root, 'film.lock'), lockText);
      store.workspace(id).commitRevision(rev);
      return { lock: lockText, diagnostics };
    } catch (e) {
      for (const [p, bytes] of Object.entries(backup)) {
        if (bytes === null) rmSync(join(root, p), { force: true });
        else writeFileSync(join(root, p), bytes);
      }
      throw e;
    }
  };

  return store;
}
