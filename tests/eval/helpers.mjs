// tests/eval 的公共夹具：临时源仓库、评测运行目录、合格与不合格的作品目录、stream-json 会话记录。
//
// 一切都建在系统临时目录里、测试结束即删；不往仓库里写任何东西。
// 接口：
//   REPO、STUB_ROOT、hasFfmpeg()、hasPython()、tempDir(t?)、git(cwd, ...args)
//   makeSourceRepo(dir) → { dir, commit }                    小号「北冥仓库」：入口文档、src、engine、vendor（带 /films/ 忽略规则）
//   makeRun(root, opts) → { dir, worktree, task, commit }     评测运行目录（布局同 tools/eval/lib/rundir.mjs）
//   writeFilmSource / writeFilmRun / writeReview / writeInjections / writeTurns
//   S（stream-json 记录构造器）、dfaInjections(prompt, { at })

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../../tools/eval/lib/files.mjs';
import { RUN_KIND } from '../../tools/eval/lib/rundir.mjs';
import { captureBaseline, cloneAt } from '../../tools/eval/lib/sandbox.mjs';
import { firstMessage, loadReplies, loadTask } from '../../tools/eval/lib/task.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STUB_ROOT = path.join(REPO, 'tests', 'eval', 'fixtures', 'tools-root');

const ok = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true }); return !r.error && r.status === 0; };
export const hasFfmpeg = () => ok(process.env.FFMPEG || 'ffmpeg', ['-version']) && ok(process.env.FFPROBE || 'ffprobe', ['-version']);
export const pythonCmd = () => ['python3', 'python'].find(c => ok(c, ['--version'])) ?? null;

/** 临时目录（realpath，避免 macOS 的 /var 与 /private/var 别名）；传入测试上下文时自动清理。 */
export function tempDir(t = null, prefix = 'beiming-eval-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  if (t?.after) t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

export function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', '-c', 'user.name=t', '-c', 'user.email=t@localhost.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
}

const lines = (n, head) => `${head}\n${Array.from({ length: n - 1 }, (_, i) => `第 ${i + 2} 行`).join('\n')}\n`;

const CASEBOOK_STUB = `import os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bad = os.path.isdir(os.path.join(root, 'cases', 'vendor', 'lemo-opuscar', 'films'))
print('casebook check: ' + ('不通过：vendor 快照多出 films/' if bad else 'OK'))
sys.exit(1 if bad else 0)
`;

/** 建一个小号源仓库并提交。 */
export function makeSourceRepo(dir) {
  const files = {
    '.gitignore': 'node_modules\nout/\n__pycache__/\n.DS_Store\n',
    'AGENTS.md': lines(40, '# 入口'),
    'routes/README.md': lines(80, '# 三条路线'),
    'routes/a-webgl/README.md': lines(150, '# A 路线'),
    'docs/long.md': lines(400, '# 长文档'),
    'src/main.js': 'export const sample = 1;\n',
    'engine/core/math.js': 'export const lerp = (a, b, t) => a + (b - a) * t;\n',
    'cases/vendor/lemo-opuscar/.gitignore': '/films/\n',
    'cases/vendor/lemo-opuscar/README.md': '# vendor 快照\n',
    'cases/vendor/lemo-opuscar/styles/watercolor/STYLE.md': '# 水彩\n',
    'tools/casebook.py': CASEBOOK_STUB,
    '.claude/skills/film-qc/SKILL.md': '---\nname: film-qc\ndescription: 仓库自带的出片质检 skill（夹具）\n---\n\n# film-qc\n',
    'package.json': '{ "name": "beiming-fixture", "private": true, "type": "module" }\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  git(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', '夹具：初始提交');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD').trim() };
}

const merge = (a, b) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  return out;
};

/** 测试用的小规格：64×36、24 fps、48 帧（2 秒），让 ffmpeg 生成夹具成片只要几十毫秒。 */
export const SMALL = { width: 64, height: 36, fps: 24, frameCount: 48 };

/**
 * 建评测运行目录。
 * @param {string} root 评测根
 * @param {{ task: string, patch?: object, src: {dir, commit}, attempt?: number, isolation?: string, environment?: string,
 *           seed?: (wt) => void, act?: (wt, runDir) => void,
 *           turns?: object[][] | ((wt, runDir) => object[][]), injections?: object[] | ((prompt) => object[]) | null,
 *           drive?: object|null, hooks?: object[]|null, startedAt?: string, baselineProcesses?: object[] }} o
 */
export function makeRun(root, o) {
  const base = loadTask(o.task);
  const prompt = firstMessage(base);
  const replies = loadReplies(base);
  const task = merge(JSON.parse(JSON.stringify(base)), o.patch ?? {});
  if (task.spec && !(o.patch && 'spec' in o.patch && o.patch.spec === null)) task.spec = { ...task.spec, ...SMALL, ...(o.patch?.spec ?? {}) };
  const runId = `20261110-120000-${o.src.commit.slice(0, 7)}-a${o.attempt ?? 1}`;
  const dir = path.join(root, task.id, runId);
  const worktree = path.join(dir, 'worktree');
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'session', 'config'), { recursive: true });
  cloneAt(o.src.dir, o.src.commit, worktree);
  const startedAt = o.startedAt ?? new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const meta = {
    kind: RUN_KIND, schemaVersion: 1, runId, task: task.id, attempt: o.attempt ?? 1, commit: o.src.commit,
    isolation: o.isolation ?? 'isolated', environment: o.environment ?? task.environment,
    worktree: 'worktree', tmp: 'tmp', session: 'session', createdAt: startedAt, startedAt,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task, null, 2));
  fs.writeFileSync(path.join(dir, 'replies.json'), JSON.stringify(replies, null, 2));
  fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
  o.seed?.(worktree);
  const baseline = captureBaseline({ worktree, tmpDir: path.join(dir, 'tmp'), commit: o.src.commit }, { listProcs: () => o.baselineProcesses ?? [] });
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(baseline, null, 2));
  o.act?.(worktree, dir);
  if (o.turns) writeTurns(dir, typeof o.turns === 'function' ? o.turns(worktree, dir) : o.turns);
  if (o.injections) writeInjections(dir, typeof o.injections === 'function' ? o.injections(prompt) : o.injections);
  if (o.drive) fs.writeFileSync(path.join(dir, 'drive.json'), JSON.stringify(o.drive, null, 2));
  if (o.hooks) fs.writeFileSync(path.join(dir, 'hooks.jsonl'), o.hooks.map(h => JSON.stringify(h)).join('\n') + '\n');
  return { dir, worktree, task, commit: o.src.commit, prompt, replies };
}

export function writeTurns(runDir, turns) {
  const tdir = path.join(runDir, 'transcript');
  fs.mkdirSync(tdir, { recursive: true });
  turns.forEach((records, i) => fs.writeFileSync(path.join(tdir, `turn-${String(i + 1).padStart(2, '0')}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n'));
}

export function writeInjections(runDir, list) {
  fs.writeFileSync(path.join(runDir, 'injections.jsonl'), list.map((m, i) => JSON.stringify({ seq: i, turn: i + 1, quoteScope: m.text, approves: [], waives: [], ...m })).join('\n') + '\n');
}

/** DF-A 的标准注入序列：任务书 → look 返修 → look 批准并豁免 animatic。at 为第一条的时间（毫秒）。 */
export function dfaInjections(prompt, { at = Date.now() - 9 * 60 * 1000, step = 60 * 1000 } = {}) {
  const t = k => new Date(at + k * step).toISOString();
  return [
    { kind: 'prompt', text: prompt, at: t(0) },
    { kind: 'scripted', replyId: 'A-look-1', gate: 'look', text: '雾再淡一点，渡船再小一些，鲲背的颜色更接近原片的青灰。', at: t(1) },
    { kind: 'scripted', replyId: 'A-look-2', gate: 'look', text: '可以。动态预览不用给我看了，直接出全片。', approves: ['look'], waives: ['animatic'], at: t(2) },
  ];
}

/** 合格的 film.json v2（C6 最小字段）与几份源码。shots 缺省为两个镜头、切点在中间。 */
export function writeFilmSource(wt, id, { spec = SMALL, route = 'a', shots = null, events = null, extra = {}, reviewMd = '# 审片记录\n\n## 已知问题\n- 片名停留时长卡在下限。\n\n## 豁免\n- animatic：用户原话「可以。动态预览不用给我看了，直接出全片。」\n' } = {}) {
  const dir = path.join(wt, 'films', id);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const half = Math.floor(spec.frameCount / 2);
  const film = {
    schemaVersion: 2, id, title: '晨渡', route, backend: route === 'b' ? 'raea' : 'three',
    output: { profile: 'web-1080p24', width: spec.width, height: spec.height, fps: spec.fps, frameCount: spec.frameCount },
    shots: shots ?? [{ id: 'S1', in: 0, out: half, module: 'shots/s1.js' }, { id: 'S2', in: half, out: spec.frameCount, module: 'shots/s2.js' }],
    events: events ?? [{ id: 'kun-rise', frame: half + 4, shot: 'S2', audio: 'kun_breath', visual: 'motion' }],
    audio: { mode: 'script', script: 'sound.py', targetLUFS: -14, truePeakDbTP: -1 },
    deliveries: ['web-1080p24'],
    credits: [{ what: '字体子集', owner: 'Google', license: 'OFL-1.1', source: 'fonts/fonts.lock.json' }],
    aigc: { contains: true, note: '绘画底板为 AI 生成后人工整理' },
    gates: { look: 'required', animatic: 'required', final: 'required' },
    ...extra,
  };
  fs.writeFileSync(path.join(dir, 'film.json'), JSON.stringify(film, null, 2));
  fs.writeFileSync(path.join(dir, 'shots', 's1.js'), 'export function render(t) { return t; }\n');
  fs.writeFileSync(path.join(dir, 'shots', 's2.js'), 'export function render(t) { return t; }\n');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>晨渡</title>\n');
  if (reviewMd !== null) fs.writeFileSync(path.join(dir, 'review.md'), reviewMd);
  return dir;
}

const videoCache = new Map();

/** 用 ffmpeg 生成一段带 48 kHz 立体声 AAC 的 H.264 小片（同规格只生成一次）。 */
export function makeVideo(cacheDir, { width, height, fps, frames, audio = true }) {
  const key = `${width}x${height}@${fps}-${frames}-${audio}`;
  if (videoCache.has(key) && fs.existsSync(videoCache.get(key))) return videoCache.get(key);
  const out = path.join(cacheDir, `v-${key.replace(/[^a-z0-9-]/gi, '_')}.mp4`);
  const dur = (frames / fps).toFixed(4);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `color=c=0x335577:s=${width}x${height}:r=${fps}:d=${dur}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${dur}`, '-map', '0:v', '-map', '1:a', '-ac', '2', '-c:a', 'aac', '-b:a', '64k');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-frames:v', String(frames), out);
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg 生成夹具失败：${r.stderr}`);
  videoCache.set(key, out);
  return out;
}

/**
 * 一次出片的运行目录（附录 C4）：web.mp4、master.mp4、player.html、run.json、qa/report.json、contact.jpg，加 out/latest 指针。
 * runJson 传对象时与合格记录合并（null 值表示删掉该字段）；传 'missing' 不写 run.json；传 'broken' 写坏 JSON。
 */
export function writeFilmRun(wt, id, { cacheDir, video = {}, runJson = {}, runId = '20261110-130000-abc1234', route = 'a', commit = 'abc1234', mtimeMs = null } = {}) {
  const filmDir = path.join(wt, 'films', id);
  const dir = path.join(filmDir, 'out', runId);
  fs.mkdirSync(path.join(dir, 'qa'), { recursive: true });
  const v = { width: SMALL.width, height: SMALL.height, fps: SMALL.fps, frames: SMALL.frameCount, ...video };
  if (v.dummy === true) {
    // 不需要解码的判定（H5、H6、H7）用占位文件，测试不依赖 ffmpeg
    for (const f of ['web.mp4', 'master.mp4']) fs.writeFileSync(path.join(dir, f), 'placeholder');
  } else if (v.none !== true) {
    const src = makeVideo(cacheDir, v);
    fs.copyFileSync(src, path.join(dir, 'web.mp4'));
    fs.copyFileSync(src, path.join(dir, 'master.mp4'));
  }
  fs.writeFileSync(path.join(dir, 'player.html'), '<!doctype html><meta charset="utf-8"><video src="web.mp4" controls></video>\n');
  fs.writeFileSync(path.join(dir, 'contact.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(dir, 'qa', 'report.json'), JSON.stringify({ schemaVersion: 1, film: id, checks: [], ok: true }));
  const web = path.join(dir, 'web.mp4');
  const good = {
    schemaVersion: 1, status: 'passed', projectId: id, shotId: 'film', route, backend: route === 'b' ? 'raea' : 'three',
    sourceCommit: commit, dirty: true, argv: ['node', 'tools/film/cli.mjs', 'build', `films/${id}`, '--profile', 'web-1080p24'],
    tools: { node: process.version, playwright: '1.63.0', browser: 'chrome-headless-shell 153', ffmpeg: '8.0.1' },
    actualDevice: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)', actualGraphicsBackend: 'metal', actualEncoder: 'libx264', softwareFallback: false,
    output: { path: `films/${id}/out/${runId}/web.mp4`, sha256: fs.existsSync(web) ? sha256File(web) : 'none', width: v.width, height: v.height, fps: v.fps, frames: v.frames, pixFmt: 'yuv420p', color: { range: 'tv', space: 'bt709', transfer: 'bt709', primaries: 'bt709' } },
    frameHashes: [], timing: { render: 1.2, encode: 0.3 },
    technicalAcceptance: { status: 'passed', evidence: [`films/${id}/out/${runId}/qa/report.json`] },
    creativeAcceptance: { status: 'not-reviewed', reviews: [] },
  };
  if (runJson === 'broken') fs.writeFileSync(path.join(dir, 'run.json'), '{ 坏的 JSON');
  else if (runJson !== 'missing') {
    const merged = merge(good, runJson);
    for (const [k, val] of Object.entries(merged)) if (val === null) delete merged[k];
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(merged, null, 2));
  }
  fs.writeFileSync(path.join(filmDir, 'out', 'latest'), `${runId}\n`);
  if (mtimeMs !== null) for (const f of ['web.mp4', 'master.mp4']) if (fs.existsSync(path.join(dir, f))) fs.utimesSync(path.join(dir, f), mtimeMs / 1000, mtimeMs / 1000);
  return dir;
}

/** 闸门记录：records = [{ file, value }]，写到 films/<id>/review/<file>。 */
export function writeReview(wt, id, records) {
  const dir = path.join(wt, 'films', id, 'review');
  fs.mkdirSync(dir, { recursive: true });
  for (const r of records) fs.writeFileSync(path.join(dir, r.file), typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
}

/** DF-A 合格的闸门记录：look 批准 + animatic 豁免，原话都来自 look 第 2 轮。 */
export const DFA_REVIEW = [
  { file: 'look-2026-11-10.json', value: { gate: 'look', decision: 'approve', quote: '可以。动态预览不用给我看了，直接出全片。', source: '用户第 3 条消息', reviewerKind: 'human' } },
  { file: 'waivers.json', value: { waivers: [{ gate: 'animatic', quote: '动态预览不用给我看了，直接出全片', source: '用户第 3 条消息' }] } },
];

let idSeq = 0;
const nextId = () => `toolu_${String(++idSeq).padStart(4, '0')}`;

/** stream-json 记录构造器（claude -p --output-format stream-json --verbose 的形状）。 */
export const S = {
  init: ({ cwd, mcp = [], plugins = [], skills = ['film-qc'], model = 'claude-opus-5-5' } = {}) => ({ type: 'system', subtype: 'init', session_id: 'sess-1', model, cwd, tools: ['Bash', 'Read', 'Write', 'Edit', 'Task', 'Skill'], mcp_servers: mcp, plugins, skills, permissionMode: 'acceptEdits', apiKeySource: 'none' }),
  text: (text, parent = null) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: parent, session_id: 'sess-1' }),
  /** 一次工具调用及其结果：返回两条记录。 */
  call: (name, input, result = 'ok', { isError = false, parent = null, id = nextId() } = {}) => [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: parent, session_id: 'sess-1' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] }, parent_tool_use_id: parent, session_id: 'sess-1' },
  ],
  /** 带行号的 Read 结果（Claude Code 的格式）。 */
  readResult: n => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(6)}\t第 ${i + 1} 行`).join('\n'),
  done: (text, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'sess-1', duration_ms: 1000, num_turns: 3, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }, permission_denials: [], ...extra }),
};

/** 一轮合格的 DF-A 会话：读两份入口文档 → new-film → 写镜头 → 出片 → 如实汇报。 */
export function goodTurn(wt, id = 'chendu', final = '成片在 films/chendu/out/latest 指向的运行目录；跑过 film build 与 qa，结果见报告；已知问题：片名停留卡在下限。look 已获批准，animatic 按用户原话豁免，final 待用户审看。') {
  return [
    S.init({ cwd: wt }),
    ...S.call('Read', { file_path: path.join(wt, 'AGENTS.md') }, S.readResult(40)),
    ...S.call('Read', { file_path: path.join(wt, 'routes', 'README.md') }, S.readResult(80)),
    ...S.call('Bash', { command: `node tools/new-film.mjs a ${id} --title 晨渡` }, '已生成'),
    ...S.call('Write', { file_path: path.join(wt, 'films', id, 'shots', 's1.js'), content: 'export function render(t) { return t; }\n' }, '已写入'),
    ...S.call('Bash', { command: `npm run film -- build films/${id} --profile web-1080p24 --json` }, '{"ok":true}'),
    S.done(final),
  ];
}
