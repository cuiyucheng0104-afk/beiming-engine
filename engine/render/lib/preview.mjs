// 北冥引擎 · 本地带声分轨调片预览外壳（serve.mjs 专用中间件）：只在明确带 ?preview=1 的 HTML 页面请求上注入客户端模块，
// 不带 ?preview=1 的任何请求一律原样回退给 lib/server.mjs 的字节流服务，不碰渲染器（page.mjs / video.mjs / still.mjs）。
//
//   createPreviewMiddleware({ root, repoRoot }) → async (req, res, { root, port, allowed, done }) => boolean
//     · GET <页面>?preview=1         注入 <script type="module" src="/engine/render/lib/preview-client.mjs"></script>
//     · GET /_preview/state?dir=…    读取 film.json（时长、帧率、切点、事件）与现有混音 / 分轨 / QA 摘要
//     · POST /_preview/rebuild?dir=… 校验 Origin 与并发锁，调用 film mix（或样片 audio/build.mjs）快速重混声音并返回最新状态
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRequest } from './server.mjs';

export const PREVIEW_SCRIPT_SRC = '/engine/render/lib/preview-client.mjs';
export const PREVIEW_SCRIPT_TAG = `<script type="module" src="${PREVIEW_SCRIPT_SRC}"></script>`;

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_STEMS = ['vo', 'music', 'amb', 'fx', 'foley', 'ui'];
const REBUILD_TIMEOUT_MS = 120_000;

const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const mtimeOf = p => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const posNum = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const posInt = v => (Number.isInteger(v) && v > 0 ? v : null);

function within(child, parent) {
  const r = path.relative(parent, child);
  return r === '' || !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r));
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function readPointer(file) {
  try {
    const id = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0].trim();
    if (!id || id === '.' || id === '..' || /[/\\]/.test(id)) return null;
    return id;
  } catch { return null; }
}

/** 校验并解析相对 root 的影片目录：拒绝 ..（403）、点目录（404）与越界符号链接（403） */
export function resolveFilmDir(root, rawDir, allowed = [root]) {
  const s = String(rawDir ?? '').trim();
  if (s.includes('\0') || s.includes('\\')) return { errorStatus: 400, errorCode: 'bad_dir', message: '目录参数含非法字符' };
  if (s === '' || s === '.' || s === '/') return { filmDir: root, relDir: '.' };
  const rawSegs = s.split('/').filter(Boolean);
  if (rawSegs.some(seg => seg === '..')) return { errorStatus: 403, errorCode: 'forbidden', message: '不允许越出服务根目录' };
  const segs = rawSegs.filter(seg => seg !== '.');
  if (segs.some(seg => seg.startsWith('.'))) return { errorStatus: 404, errorCode: 'not_found', message: '不访问点文件或隐藏目录' };
  if (!segs.length) return { filmDir: root, relDir: '.' };
  const candidate = path.resolve(root, ...segs);
  if (!within(candidate, root)) return { errorStatus: 403, errorCode: 'forbidden', message: '不允许越出服务根目录' };
  const resolved = real(candidate);
  if (!resolved) return { errorStatus: 404, errorCode: 'not_found', message: `目录不存在：${segs.join('/')}` };
  if (!allowed.some(a => within(resolved, a))) return { errorStatus: 403, errorCode: 'forbidden', message: '目录链接越出允许范围' };
  if (!isDir(resolved)) return { errorStatus: 404, errorCode: 'not_found', message: `不是目录：${segs.join('/')}` };
  return { filmDir: resolved, relDir: segs.join('/') };
}

/** 把 root 内的真实文件转成带 ?v=<mtimeMs> 缓存破除参数的本地 URL；不在 root 内返回 null */
function toAssetUrl(root, allowed, absFile) {
  const r = real(absFile);
  if (!r || !within(r, root) || !allowed.some(a => within(r, a))) return null;
  let st;
  try { st = fs.statSync(r); } catch { return null; }
  if (!st.isFile()) return null;
  const relPath = path.relative(root, r).split(path.sep).filter(Boolean).map(encodeURIComponent).join('/');
  return `/${relPath}?v=${Math.trunc(st.mtimeMs)}`;
}

/** 扫描分轨目录 stems/*.wav → { vo?, music?, amb?, fx?, foley?, ui?, ... }（只返回实际存在的分轨） */
function collectStems(root, allowed, stemsDir) {
  if (!isDir(stemsDir)) return {};
  let entries;
  try { entries = fs.readdirSync(stemsDir); } catch { return {}; }
  const rawMap = new Map();
  for (const name of entries.sort()) {
    if (name.startsWith('.') || path.extname(name).toLowerCase() !== '.wav') continue;
    const url = toAssetUrl(root, allowed, path.join(stemsDir, name));
    if (!url) continue;
    rawMap.set(path.basename(name, path.extname(name)).toLowerCase(), url);
  }
  const normalized = new Map();
  for (const [k, url] of rawMap) {
    const key = k === 'dialogue' && !rawMap.has('vo') ? 'vo' : k === 'sfx' && !rawMap.has('fx') ? 'fx' : k;
    if (!normalized.has(key)) normalized.set(key, url);
  }
  const out = {};
  for (const k of CANONICAL_STEMS) if (normalized.has(k)) out[k] = normalized.get(k);
  for (const [k, url] of normalized) if (!(k in out)) out[k] = url;
  return out;
}

/** 提炼 audio/qa.json（或 qa/report.json）为前端可直接展示的摘要 */
export function summarizeQa(qaObj) {
  if (!qaObj || typeof qaObj !== 'object') return null;
  const checks = Array.isArray(qaObj.checks) ? qaObj.checks : [];
  const audioChecks = checks.some(c => String(c?.id || '').startsWith('audio.'))
    ? checks.filter(c => String(c?.id || '').startsWith('audio.'))
    : checks;
  const hardFailures = Array.isArray(qaObj.summary?.hardFailures)
    ? qaObj.summary.hardFailures
    : audioChecks.filter(c => c?.status === 'fail').map(c => c.id);
  const ok = typeof qaObj.ok === 'boolean' ? qaObj.ok : hardFailures.length === 0;
  const pass = qaObj.summary?.pass ?? audioChecks.filter(c => c?.status === 'pass').length;
  const fail = qaObj.summary?.fail ?? audioChecks.filter(c => c?.status === 'fail').length;
  const warn = qaObj.summary?.warn ?? audioChecks.filter(c => c?.status === 'warn').length;
  return {
    ok,
    pass,
    fail,
    warn,
    hardFailures,
    failures: audioChecks.filter(c => c?.status === 'fail').map(c => ({
      id: String(c.id || ''),
      value: c.value ?? null,
      message: String(c.message || ''),
      hint: c.hint ? String(c.hint) : null,
    })),
    warnings: audioChecks.filter(c => c?.status === 'warn').map(c => ({
      id: String(c.id || ''),
      value: c.value ?? null,
      message: String(c.message || ''),
    })),
    verdict: typeof qaObj.verdict === 'string' ? qaObj.verdict : null,
  };
}

/** 在运行目录上层（<filmDir>/out 或 out/beiming）里定位最新可用声音包：优先 out/latest，并兼顾 film mix 新生成的运行目录 */
function findBestRunBundle(root, allowed, outBase) {
  if (!isDir(outBase)) return null;
  const latestId = readPointer(path.join(outBase, 'latest'));
  const candidateIds = new Set();
  if (latestId) candidateIds.add(latestId);
  try {
    for (const entry of fs.readdirSync(outBase, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'cache' || entry.name === 'work') continue;
      candidateIds.add(entry.name);
    }
  } catch { /* 忽略不可读目录 */ }

  let latestBundle = null;
  let newestBundle = null;
  for (const id of candidateIds) {
    const runDir = path.join(outBase, id);
    const audioDir = path.join(runDir, 'audio');
    const mixFile = path.join(audioDir, 'mix.wav');
    const stems = collectStems(root, allowed, path.join(audioDir, 'stems'));
    const mixUrl = toAssetUrl(root, allowed, mixFile);
    if (!mixUrl && !Object.keys(stems).length) continue;
    const mtime = Math.max(mtimeOf(mixFile), mtimeOf(path.join(audioDir, 'stems')));
    const qaFile = [path.join(audioDir, 'qa.json'), path.join(runDir, 'qa', 'report.json')].find(isFile) || null;
    const bundle = { runDir, mixUrl, stems, qaFile, mtime };
    if (id === latestId) latestBundle = bundle;
    if (!newestBundle || bundle.mtime > newestBundle.mtime) newestBundle = bundle;
  }
  // out/latest 存在时优先取它；若后续跑过 film mix（不改 latest）产出了更新的运行目录，则取更新的那次
  if (latestBundle && (!newestBundle || newestBundle.mtime <= latestBundle.mtime)) return latestBundle;
  return newestBundle || latestBundle;
}

/** 探测直接放在 out/ 下的混音与分轨（含仓库根《北冥》样片 out/mix.wav + audio/stems/*.wav） */
function findDirectBundle(root, allowed, filmDir, isSampleRoot) {
  const outDir = path.join(filmDir, 'out');
  const mixFile = path.join(outDir, 'mix.wav');
  const mixUrl = toAssetUrl(root, allowed, mixFile);
  let stems = collectStems(root, allowed, path.join(outDir, 'stems'));
  let stemsMtime = mtimeOf(path.join(outDir, 'stems'));
  if (!Object.keys(stems).length && isSampleRoot) {
    stems = collectStems(root, allowed, path.join(filmDir, 'audio', 'stems'));
    stemsMtime = mtimeOf(path.join(filmDir, 'audio', 'stems'));
  }
  if (!mixUrl && !Object.keys(stems).length) return null;
  const qaCandidates = [
    path.join(outDir, 'qa.json'),
    path.join(outDir, 'mix.qa.json'),
    ...(isSampleRoot ? [path.join(filmDir, 'audio', 'check', 'qa.json')] : []),
  ];
  const qaFile = qaCandidates.find(isFile) || null;
  return { runDir: null, mixUrl, stems, qaFile, mtime: Math.max(mtimeOf(mixFile), stemsMtime) };
}

/** 扫描指定作品目录的时间轴描述、切点、事件、混音与分轨地址及 QA 摘要 */
export function scanFilmState({ root, repoRoot, filmDir, relDir, allowed = [root], hintRunDir = null }) {
  const isSampleRoot = relDir === '.' && (path.resolve(filmDir) === path.resolve(repoRoot) || isFile(path.join(filmDir, 'films', 'beiming-10s', 'film.json')));
  const ownFilmFile = path.join(filmDir, 'film.json');
  const mirrorFilmFile = path.join(filmDir, 'films', 'beiming-10s', 'film.json');
  const hasOwnFilm = isFile(ownFilmFile);
  const filmFile = hasOwnFilm ? ownFilmFile : (isSampleRoot && isFile(mirrorFilmFile) ? mirrorFilmFile : null);
  const rawFilm = filmFile ? readJsonSafe(filmFile) : null;

  const fps = posNum(rawFilm?.output?.fps) ?? posNum(rawFilm?.fps) ?? null;
  const frames = posInt(rawFilm?.output?.frameCount) ?? (posNum(rawFilm?.dur) && fps ? Math.round(rawFilm.dur * fps) : null);
  const dur = frames && fps ? frames / fps : (posNum(rawFilm?.dur) ?? null);
  const title = typeof rawFilm?.title === 'string' && rawFilm.title.trim() ? rawFilm.title.trim() : null;

  let shots = [];
  if (Array.isArray(rawFilm?.shots) && rawFilm.shots.length) {
    shots = rawFilm.shots
      .filter(s => s && Number.isInteger(s.in) && Number.isInteger(s.out) && s.out > s.in)
      .map((s, i) => ({ id: String(s.id ?? `S${i + 1}`), in: s.in, out: s.out, name: typeof s.name === 'string' ? s.name : null }))
      .sort((a, b) => a.in - b.in);
  } else if (frames) {
    shots = [{ id: 'S1', in: 0, out: frames, name: null }];
  }
  const cuts = shots.length > 1 ? shots.slice(1).map(s => s.in).filter(n => Number.isInteger(n) && n > 0) : [];

  const outBases = [];
  if (isSampleRoot) outBases.push(path.join(filmDir, 'out', 'beiming'));
  outBases.push(path.join(filmDir, 'out'));

  let runBundle = null;
  for (const b of outBases) {
    const cand = findBestRunBundle(root, allowed, b);
    if (cand && (!runBundle || cand.mtime > runBundle.mtime)) runBundle = cand;
  }
  const directBundle = findDirectBundle(root, allowed, filmDir, isSampleRoot);
  let chosen = runBundle;
  if (!chosen || (directBundle && directBundle.mtime > chosen.mtime)) chosen = directBundle;

  let qaFile = chosen?.qaFile || null;
  if (hintRunDir) {
    const hintedQa = [path.join(hintRunDir, 'audio', 'qa.json'), path.join(hintRunDir, 'qa', 'report.json')].find(isFile);
    if (hintedQa) qaFile = hintedQa;
  }
  const qaSummary = qaFile ? summarizeQa(readJsonSafe(qaFile)) : null;

  let events = [];
  if (Array.isArray(rawFilm?.events) && rawFilm.events.length) {
    events = rawFilm.events
      .filter(e => e && Number.isInteger(e.frame) && e.frame >= 0)
      .map(e => ({
        id: String(e.id ?? ''),
        frame: e.frame,
        t: fps ? +(e.frame / fps).toFixed(6) : null,
        shot: e.shot ?? null,
        label: String(e.desc || e.note || e.visual || e.audio || e.id || ''),
      }));
  } else {
    const evFile = [chosen?.runDir && path.join(chosen.runDir, 'events.json'), path.join(filmDir, 'events.json')].filter(Boolean).find(isFile);
    const rawEv = evFile ? readJsonSafe(evFile) : null;
    if (Array.isArray(rawEv)) {
      events = rawEv
        .filter(e => e && typeof e.t === 'number' && Number.isFinite(e.t) && e.t >= 0 && (e.cue || e.id))
        .map(e => ({
          id: String(e.cue || e.id || e.type || ''),
          frame: fps ? Math.round(e.t * fps) : null,
          t: +e.t.toFixed(6),
          shot: null,
          label: String(e.cue || e.id || e.type || ''),
        }));
    }
  }

  const canRebuild = Boolean(
    (hasOwnFilm && isFile(path.join(repoRoot, 'tools/film/cli.mjs')))
    || (isSampleRoot && isFile(path.join(repoRoot, 'tools/audio/build.mjs'))),
  );

  return {
    ok: true,
    dir: relDir,
    title,
    fps,
    frames,
    dur,
    shots,
    cuts,
    events,
    mixUrl: chosen?.mixUrl ?? null,
    stems: chosen?.stems ?? {},
    qaSummary,
    canRebuild,
  };
}

/** 在 HTML 文档的最后一个 </body> 前注入预览客户端脚本（无 </body> 则追加到末尾） */
export function injectPreviewScript(html) {
  if (html.includes(PREVIEW_SCRIPT_SRC)) return html;
  const re = /<\/body\s*>/gi;
  let match = null, m;
  while ((m = re.exec(html)) !== null) match = m;
  if (!match) return `${html}${PREVIEW_SCRIPT_TAG}`;
  return `${html.slice(0, match.index)}${PREVIEW_SCRIPT_TAG}${html.slice(match.index)}`;
}

function drainRequest(req, maxBytes = 65536) {
  return new Promise(resolve => {
    let seen = 0;
    req.on('data', chunk => {
      seen += chunk.length;
      if (seen > maxBytes) req.resume();
    });
    req.on('end', resolve);
    req.on('error', resolve);
  });
}

function runProcess(exe, args, { cwd, timeoutMs = REBUILD_TIMEOUT_MS }) {
  return new Promise(resolve => {
    const child = spawn(exe, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', timedOut = false, killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => { if (stdout.length < (8 << 20)) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { if (stderr.length < (2 << 20)) stderr += chunk.toString('utf8'); });
    child.on('error', err => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`.trim(), timedOut: false });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function stderrExcerpt(text, maxChars = 1200) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '';
  return cleaned.length <= maxChars ? cleaned : `…${cleaned.slice(-maxChars)}`;
}

function sendJson(done, method, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  done(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ...extraHeaders }, method === 'HEAD' ? undefined : body);
}

export function createPreviewMiddleware({ root, repoRoot } = {}) {
  const ROOT = real(root);
  if (!ROOT) throw new Error(`预览服务根不存在：${root}`);
  const REPO = repoRoot ? (real(repoRoot) ?? path.resolve(repoRoot)) : ROOT;
  const repoClient = path.join(REPO, 'engine/render/lib/preview-client.mjs');
  const clientFile = isFile(repoClient) ? repoClient : path.join(SELF_DIR, 'preview-client.mjs');
  const inflight = new Set();

  return async function previewMiddleware(req, _res, { port, allowed, done }) {
    const rawUrl = String(req.url || '/');
    const qPos = rawUrl.indexOf('?');
    const rawPath = (qPos >= 0 ? rawUrl.slice(0, qPos) : rawUrl).split('#')[0];
    const rawQuery = qPos >= 0 ? rawUrl.slice(qPos + 1).split('#')[0] : '';
    let pathname;
    try { pathname = decodeURIComponent(rawPath); } catch { return false; }
    const query = new URLSearchParams(rawQuery);

    // 1. 预览客户端 ES 模块：即便 --root 指向子目录（如 films/du）也能直接加载
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === PREVIEW_SCRIPT_SRC && isFile(clientFile)) {
      const buf = fs.readFileSync(clientFile);
      done(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': buf.length }, req.method === 'HEAD' ? undefined : buf);
      return true;
    }

    // 2. GET /_preview/state?dir=<relDir>
    if (pathname === '/_preview/state') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(done, req.method, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
        return true;
      }
      const resolved = resolveFilmDir(ROOT, query.get('dir') ?? '', allowed);
      if (resolved.errorStatus) {
        sendJson(done, req.method, resolved.errorStatus, { ok: false, error: resolved.errorCode, message: resolved.message });
        return true;
      }
      const state = scanFilmState({ root: ROOT, repoRoot: REPO, filmDir: resolved.filmDir, relDir: resolved.relDir, allowed });
      sendJson(done, req.method, 200, state);
      return true;
    }

    // 3. POST /_preview/rebuild?dir=<relDir>
    if (pathname === '/_preview/rebuild') {
      if (req.method !== 'POST') {
        sendJson(done, req.method, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
        return true;
      }
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const o = String(origin);
        if (o !== `http://127.0.0.1:${port}` && o !== `http://localhost:${port}`) {
          sendJson(done, req.method, 403, { ok: false, error: 'bad_origin', message: 'Origin 不匹配本机预览服务地址' });
          return true;
        }
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        sendJson(done, req.method, 403, { ok: false, error: 'bad_origin', message: '拒绝跨站请求' });
        return true;
      }
      await drainRequest(req);
      const resolved = resolveFilmDir(ROOT, query.get('dir') ?? '', allowed);
      if (resolved.errorStatus) {
        sendJson(done, req.method, resolved.errorStatus, { ok: false, error: resolved.errorCode, message: resolved.message });
        return true;
      }
      const { filmDir, relDir } = resolved;
      if (inflight.has(relDir)) {
        sendJson(done, req.method, 409, { ok: false, error: 'busy', message: '正在重混声音，请等待当前任务完成' });
        return true;
      }

      const hasFilmJson = isFile(path.join(filmDir, 'film.json'));
      const filmCli = path.join(REPO, 'tools/film/cli.mjs');
      const sampleAudioCli = path.join(REPO, 'tools/audio/build.mjs');
      const isSampleRoot = relDir === '.' && (path.resolve(filmDir) === path.resolve(REPO) || isFile(path.join(filmDir, 'films', 'beiming-10s', 'film.json')));
      let args;
      if (hasFilmJson && isFile(filmCli)) {
        args = [filmCli, 'mix', filmDir, '--gpu', 'software-ok', '--no-cache', '--json'];
      } else if (isSampleRoot && isFile(sampleAudioCli)) {
        args = [sampleAudioCli, '--json'];
      } else {
        sendJson(done, req.method, 404, { ok: false, error: 'no_target', message: '当前目录没有可重混的 film.json 或 tools/audio/build.mjs' });
        return true;
      }

      inflight.add(relDir);
      try {
        const res = await runProcess(process.execPath, args, { cwd: REPO, timeoutMs: REBUILD_TIMEOUT_MS });
        let parsed = null;
        try { parsed = JSON.parse(res.stdout.trim()); } catch { parsed = null; }
        const hintRunDir = typeof parsed?.data?.runDir === 'string'
          ? path.resolve(REPO, parsed.data.runDir)
          : (typeof parsed?.runJson === 'string' ? path.dirname(path.resolve(REPO, parsed.runJson)) : null);
        const state = scanFilmState({ root: ROOT, repoRoot: REPO, filmDir, relDir, allowed, hintRunDir });
        if (res.timedOut) {
          sendJson(done, req.method, 504, {
            ...state,
            ok: false,
            error: 'rebuild_timeout',
            message: '重混声音超过 120 秒未结束',
            stderr: stderrExcerpt(res.stderr),
          });
          return true;
        }
        if (res.code === 0 && parsed?.ok !== false) {
          sendJson(done, req.method, 200, { ...state, ok: true, rebuilt: true });
          return true;
        }
        const status = res.code === 4 ? 422 : 500;
        sendJson(done, req.method, status, {
          ...state,
          ok: false,
          error: res.code === 4 ? 'qa_failed' : 'rebuild_failed',
          exitCode: res.code,
          message: parsed?.error?.message || (res.code === 4 ? '声音门禁或声画拍点核对未通过' : `重混声音失败（退出码 ${res.code}）`),
          hint: parsed?.error?.hint || null,
          stderr: stderrExcerpt(res.stderr),
        });
        return true;
      } finally {
        inflight.delete(relDir);
      }
    }

    // 4. HTML ?preview=1 注入：仅当 GET 且查询参数明确含 preview=1、无 Range 时注入客户端脚本
    if (req.method === 'GET' && query.get('preview') === '1' && !req.headers.range) {
      const x = resolveRequest(ROOT, req.url, allowed);
      if (x.status) return false;
      let file = x.file;
      let st;
      try { st = fs.statSync(file); } catch { return false; }
      if (st.isDirectory()) {
        const idx = path.join(file, 'index.html');
        const realIdx = real(idx);
        if (!realIdx || !allowed.some(a => within(realIdx, a))) return false;
        try { st = fs.statSync(realIdx); file = realIdx; } catch { return false; }
      }
      if (!st.isFile()) return false;
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.html' && ext !== '.htm') return false;
      const html = fs.readFileSync(file, 'utf8');
      const injected = injectPreviewScript(html);
      const body = Buffer.from(injected, 'utf8');
      done(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length }, body);
      return true;
    }

    return false;
  };
}
