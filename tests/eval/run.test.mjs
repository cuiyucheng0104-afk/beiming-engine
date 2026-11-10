// tools/eval/run.mjs 与 score.mjs 的端到端测试：prepare → drive（Claude CLI 测试桩）→ finish → 评审 → score → summary → clean，
// 以及 prepare 的各项拒绝条件、驱动的回复选择、超时与人工插话。
//
// 会话由 tests/eval/fixtures/claude-stub.mjs 扮演（按剧本写文件、吐 stream-json），不联网、不花钱。
// 运行：node --test tests/eval/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { driveRun, looksLikeRequest, selectReply } from '../../tools/eval/lib/drive.mjs';
import { readJsonl, walk } from '../../tools/eval/lib/files.mjs';
import { loadRun } from '../../tools/eval/lib/rundir.mjs';
import { firstMessage, loadTask } from '../../tools/eval/lib/task.mjs';
import { DFA_REVIEW, REPO, SMALL, STUB_ROOT, git, hasFfmpeg, makeSourceRepo, tempDir, writeFilmRun, writeFilmSource, writeReview } from './helpers.mjs';

const RUN = path.join(REPO, 'tools', 'eval', 'run.mjs');
const SCORE = path.join(REPO, 'tools', 'eval', 'score.mjs');
const STUB = path.join(REPO, 'tests', 'eval', 'fixtures', 'claude-stub.mjs');
const FF = hasFfmpeg();

let ROOT;
let SRC;
let n = 0;

before(() => {
  ROOT = tempDir(null, 'beiming-eval-run-');
  SRC = makeSourceRepo(path.join(ROOT, 'src'));
});
after(() => { if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); });

/** 子进程环境：去掉会话与评测相关的变量，避免评测机的设置混进测试。 */
function env(extra = {}) {
  const e = { ...process.env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'BEIMING_EVAL_ROOT', 'BEIMING_EVAL_CLAUDE', 'RAEA_BIN', 'EVAL_STUB_CLAUDE', 'EVAL_STUB_NO_ISOLATION']) delete e[k];
  return { ...e, ...extra };
}

function cli(script, args, extraEnv = {}, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, env: env(extraEnv), ...opts });
  let envelope = null;
  if (args.includes('--json')) {
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `--json 时 stdout 应只有一个对象：${r.stdout.slice(0, 400)}`);
    envelope = JSON.parse(lines[0]);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope };
}

const freshRoot = () => { const d = path.join(ROOT, `evals-${++n}`); fs.mkdirSync(d); return d; };

/** prepare 一道题（夹具仓库没有 node_modules，已准备环境也不装依赖）。spec 给出时把运行目录里的题目快照改成小规格。 */
function prepare(task, extra = [], extraEnv = {}, { spec = null } = {}) {
  const root = freshRoot();
  const r = cli(RUN, ['prepare', '--task', task, '--repo', SRC.dir, '--root', root, '--node-modules', 'none', '--json', ...extra], extraEnv);
  const runDir = r.envelope?.data?.runDir ?? null;
  if (runDir && spec) {
    const file = path.join(runDir, 'task.json');
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    t.spec = { ...t.spec, ...spec };
    fs.writeFileSync(file, JSON.stringify(t, null, 2));
  }
  return { ...r, root, runDir };
}

/** 写剧本，返回剧本路径（状态文件在它旁边）。 */
function script(turns) {
  const dir = path.join(ROOT, `stub-${++n}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'script.json');
  fs.writeFileSync(file, JSON.stringify({ turns }, null, 2));
  return file;
}

/** 把一个暂存目录里的作品文件变成桩的动作：文本写入、二进制复制。 */
function filmActions(staging, id) {
  const base = path.join(staging, 'films', id);
  return walk(base).map(e => (/\.(mp4|jpg|png|wav)$/i.test(e.rel)
    ? { copy: e.abs, to: `films/${id}/${e.rel}` }
    : { write: `films/${id}/${e.rel}`, content: fs.readFileSync(e.abs, 'utf8') }));
}

// ───────────────────────── 完整一轮 ─────────────────────────

describe('DF-A 完整评测流程（Claude CLI 测试桩扮演代理）', { skip: !FF && '没有 ffmpeg / ffprobe' }, () => {
  let p;
  let stub;
  const staging = () => {
    const dir = path.join(ROOT, `staging-${++n}`);
    writeFilmSource(dir, 'chendu');
    writeFilmRun(dir, 'chendu', { cacheDir: path.join(ROOT, 'cache-run') });
    writeReview(dir, 'chendu', DFA_REVIEW);
    return dir;
  };

  before(() => {
    fs.mkdirSync(path.join(ROOT, 'cache-run'), { recursive: true });
    p = prepare('DF-A', [], {}, { spec: SMALL });
    stub = script([
      {
        expect: '晨渡',
        actions: [
          { tool: 'Read', input: { file_path: 'AGENTS.md' }, result: Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(6)}\t第 ${i + 1} 行`).join('\n') },
          { bash: 'node tools/new-film.mjs a chendu --title 晨渡', result: '已生成 films/chendu/' },
          { write: 'films/chendu/keyframes/k1.png', content: 'png' },
        ],
        text: '这是第一版风格关键帧（films/chendu/keyframes/），请审阅，可以吗？',
      },
      { expect: '雾再淡一点', actions: [{ write: 'films/chendu/keyframes/k1.png', content: 'png2' }, { write: 'films/chendu/keyframes/k2.png', content: 'png' }], text: '按意见改好了关键帧：雾淡了、渡船小了、鲲背偏青灰。请再看一下？' },
      { expect: '直接出全片', actions: filmActions(staging(), 'chendu'), text: '成片在 films/chendu/out/latest 指向的运行目录，跑过 film build 与 qa；已知问题：片名停留卡在下限。look 已获批准，animatic 按您的原话豁免，成片还没有人审看。' },
    ]);
  });

  it('prepare：仓库外的干净检出、无远端、隔离配置、原文与基线', () => {
    assert.equal(p.status, 0, p.stderr);
    const run = loadRun(p.runDir);
    assert.equal(run.meta.task, 'DF-A');
    assert.equal(run.meta.environment, 'cold');
    assert.equal(git(run.worktree, 'remote').trim(), '');
    assert.equal(git(run.worktree, 'rev-parse', 'HEAD').trim(), SRC.commit);
    assert.equal(fs.existsSync(path.join(run.worktree, 'node_modules')), false, '冷启动不预装 node_modules');
    const settings = JSON.parse(fs.readFileSync(path.join(run.sessionDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.deny, ['WebSearch', 'WebFetch']);
    assert.equal(run.prompt, firstMessage(loadTask('DF-A')));
    const command = fs.readFileSync(path.join(run.sessionDir, 'COMMAND.txt'), 'utf8');
    assert.match(command, /## bash \/ zsh/);
    assert.match(command, /## PowerShell/);
    assert.match(command, /--setting-sources/);
    assert.ok(run.baseline && Array.isArray(run.baseline.status));
    assert.match(p.stderr, /低权限系统账户或虚拟机/);
  });

  it('drive：按剧本三轮，闸门处发出两条脚本回复，--resume 同一会话', () => {
    const r = cli(RUN, ['drive', p.runDir, '--claude', STUB, '--json'], { EVAL_STUB_CLAUDE: stub });
    assert.equal(r.status, 0, r.stderr);
    const state = r.envelope.data.state;
    assert.equal(state.stopReason, 'finished');
    assert.equal(state.turns.length, 3);
    assert.deepEqual(state.sentIds, ['A-look-1', 'A-look-2']);
    const { records } = readJsonl(path.join(p.runDir, 'injections.jsonl'));
    assert.deepEqual(records.map(x => x.kind), ['prompt', 'scripted', 'scripted']);
    assert.deepEqual(records[2].approves, ['look']);
    assert.deepEqual(records[2].waives, ['animatic']);
    for (const t of ['01', '02', '03']) {
      assert.ok(fs.existsSync(path.join(p.runDir, 'transcript', `turn-${t}.jsonl`)));
      assert.ok(fs.existsSync(path.join(p.runDir, 'snapshots', `turn-${t}.json`)));
    }
    const snap1 = JSON.parse(fs.readFileSync(path.join(p.runDir, 'snapshots', 'turn-01.json'), 'utf8'));
    assert.equal(snap1.images, 1);
    const init = JSON.parse(fs.readFileSync(path.join(p.runDir, 'transcript', 'turn-01.jsonl'), 'utf8').split('\n')[0]);
    assert.deepEqual(init.mcp_servers, [], '隔离会话应带 --strict-mcp-config');
  });

  it('drive 再跑一次：已结束的运行不重复驱动', () => {
    const r = cli(RUN, ['drive', p.runDir, '--claude', STUB, '--json'], { EVAL_STUB_CLAUDE: stub });
    assert.equal(r.status, 0);
    assert.match(r.envelope.data ? JSON.stringify(r.envelope.data.state.stopReason) : '', /finished/);
    assert.equal(readJsonl(path.join(p.runDir, 'injections.jsonl')).records.length, 3);
  });

  it('finish：硬门全过，产出 gates.json、artifacts.json、评审素材与评审表', () => {
    const r = cli(RUN, ['finish', p.runDir, '--tools-root', STUB_ROOT, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.envelope.data.verdict, 'pass', JSON.stringify(JSON.parse(fs.readFileSync(path.join(p.runDir, 'gates.json'), 'utf8')).hardGates));
    for (const f of ['gates.json', 'artifacts.json', 'review-sheet.json', 'review/contact.jpg', 'review/metrics.json', 'review/film.mp4']) assert.ok(fs.existsSync(path.join(p.runDir, f)), f);
    const frames = fs.readdirSync(path.join(p.runDir, 'review', 'frames')).sort();
    assert.deepEqual(frames, ['f00023.png', 'f00024.png', 'f00025.png', 'f00028.png'], '切点 24 前后各一帧 + 事件帧 28');
    const metrics = JSON.parse(fs.readFileSync(path.join(p.runDir, 'review', 'metrics.json'), 'utf8'));
    assert.equal(metrics.seams.length, 1);
    assert.equal(metrics.seams[0].deltaE00Median, 0, '纯色夹具片的接缝色差为 0');
    assert.match(metrics.style.note, /基线未入库/);
    const sessionFiles = walk(path.join(p.runDir, 'transcript', 'session')).filter(e => e.rel.endsWith('.jsonl'));
    assert.equal(sessionFiles.length, 1, '隔离配置目录里的会话 JSONL 复制过来了');
    const gates = JSON.parse(fs.readFileSync(path.join(p.runDir, 'gates.json'), 'utf8'));
    assert.equal(gates.observations.entry.docCount, 1);
    assert.equal(gates.observations.stops[0].imagesAtStop, 1);
    assert.equal(gates.observations.usage.sessionTurns, 3);
  });

  it('score：评审没填时结论不完整；两名评审打完后定稿并通过', () => {
    const before1 = cli(SCORE, ['run', p.runDir, '--json']);
    assert.equal(before1.status, 0);
    assert.equal(before1.envelope.data.status, 'incomplete');
    assert.equal(cli(SCORE, ['run', p.runDir, '--strict', '--json']).status, 3);
    const file = path.join(p.runDir, 'review-sheet.json');
    const sheet = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const r of sheet.visual.reviewers.filter(x => x.kind === 'human')) for (const k of Object.keys(r.scores)) r.scores[k] = 8;
    sheet.process.items.lookFirst.manual = 3;
    sheet.process.items.selfHeal.deduct = 0;
    sheet.delivery.items.reproducible.manual = 4;
    sheet.failures.push({ where: 'H1', category: 'repo-gap', note: '片名字形要手工补字', gap: 'ENTRY-10' });
    fs.writeFileSync(file, JSON.stringify(sheet, null, 2));
    // 再跑 finish：机器字段刷新，评审填的内容保留
    assert.equal(cli(RUN, ['finish', p.runDir, '--tools-root', STUB_ROOT, '--no-materials', '--json']).status, 0);
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(kept.visual.reviewers[0].scores.style, 8);
    assert.equal(kept.process.items.lookFirst.manual, 3);
    const after1 = cli(SCORE, ['run', p.runDir, '--write', '--strict', '--json']);
    assert.equal(after1.status, 0, JSON.stringify(after1.envelope.data.reasons));
    assert.equal(after1.envelope.data.status, 'final');
    assert.equal(after1.envelope.data.passed, true);
    assert.equal(after1.envelope.data.total, 87);
    assert.ok(fs.existsSync(path.join(p.runDir, 'score.json')));
  });

  it('summary：结果文件不含本机路径，就绪度说明缺了哪些题', () => {
    const out = path.join(ROOT, `results-${++n}.json`);
    const r = cli(SCORE, ['summary', p.root, '--out', out, '--date', '2026-11-10', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(out, 'utf8');
    assert.equal(text.includes(ROOT), false, '结果文件里不能有运行目录的绝对路径');
    const doc = JSON.parse(text);
    assert.equal(doc.readiness.ready, false);
    assert.ok(doc.readiness.reasons.some(x => /DF-B/.test(x)));
    assert.equal(doc.tasks['DF-A'].passed, 1);
    assert.equal(doc.failureAttribution['repo-gap'], 1);
    assert.equal(cli(SCORE, ['summary', p.root, '--strict', '--json']).status, 4);
  });

  it('status 与 clean：清掉被测检出后保留报告，finish 不能再跑', () => {
    const s = cli(RUN, ['status', p.runDir, '--json']);
    assert.equal(s.envelope.data.stage, '已计分');
    const c = cli(RUN, ['clean', p.runDir, '--json']);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(fs.existsSync(path.join(p.runDir, 'worktree')), false);
    for (const f of ['gates.json', 'score.json', 'review-sheet.json', 'transcript/turn-01.jsonl']) assert.ok(fs.existsSync(path.join(p.runDir, f)), f);
    const again = cli(RUN, ['finish', p.runDir, '--json']);
    assert.equal(again.status, 2);
    assert.equal(again.envelope.error.code, 'worktree-missing');
  });
});

// ───────────────────────── prepare 的拒绝条件 ─────────────────────────

describe('prepare 的拒绝条件', () => {
  it('--help 不建任何目录；未知题号 exit 2', () => {
    const root = path.join(ROOT, `never-${++n}`);
    const h = cli(RUN, ['prepare', '--help', '--root', root]);
    assert.equal(h.status, 0);
    assert.equal(fs.existsSync(root), false);
    const r = prepare('DF-Z');
    assert.equal(r.status, 2);
    assert.match(r.envelope.error.hint, /DF-A/);
  });

  it('缺 --task → exit 2', () => {
    const r = cli(RUN, ['prepare', '--json']);
    assert.equal(r.status, 2);
    assert.match(r.envelope.error.message, /--task/);
  });

  it('评测根在源仓库里 → exit 2', () => {
    const r = cli(RUN, ['prepare', '--task', 'S1', '--repo', SRC.dir, '--root', path.join(SRC.dir, 'evals'), '--json']);
    assert.equal(r.status, 2);
    assert.match(r.envelope.error.message, /源仓库/);
  });

  it('评测根在 .claude/worktrees/ 下 → exit 2', () => {
    const r = cli(RUN, ['prepare', '--task', 'S1', '--repo', SRC.dir, '--root', path.join(ROOT, 'x', '.claude', 'worktrees', 'e'), '--json']);
    assert.equal(r.status, 2);
    assert.match(r.envelope.error.message, /worktrees/);
  });

  it('隔离会话：评测根的上级目录有 AGENTS.md → exit 3；对照组允许', () => {
    const parent = path.join(ROOT, `with-agents-${++n}`);
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, 'AGENTS.md'), '# 评测机的个人指令\n');
    const r = cli(RUN, ['prepare', '--task', 'S1', '--repo', SRC.dir, '--root', path.join(parent, 'evals'), '--node-modules', 'none', '--json']);
    assert.equal(r.status, 3);
    assert.equal(r.envelope.error.code, 'ancestor-instructions');
    assert.equal(fs.existsSync(path.join(parent, 'evals', 'S1')), false, '失败时不留半截运行目录');
    const ok = cli(RUN, ['prepare', '--task', 'S1', '--repo', SRC.dir, '--root', path.join(parent, 'evals'), '--isolation', 'user-env', '--node-modules', 'none', '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /对照组/);
  });

  it('DF-B 没设 RAEA_BIN → exit 3，说明怎么设', () => {
    const r = prepare('DF-B');
    assert.equal(r.status, 3);
    assert.equal(r.envelope.error.code, 'env-missing');
    assert.match(r.envelope.error.hint, /RAEA_BIN/);
  });

  it('预置命令失败 → 报 seed-failed，并删掉半截运行目录', () => {
    // 夹具仓库里没有 tools/new-film.mjs：S2 的预置会失败
    const r = prepare('S2');
    assert.notEqual(r.status, 0);
    assert.equal(r.envelope.error.code, 'seed-failed');
    assert.deepEqual(fs.readdirSync(path.join(r.root, 'S2')), []);
  });

  it('同一提交的第二次 prepare 自动编号为第 2 次', () => {
    const root = freshRoot();
    const a = cli(RUN, ['prepare', '--task', 'S1', '--repo', SRC.dir, '--root', root, '--node-modules', 'none', '--json']);
    const b = cli(RUN, ['prepare', '--task', 'S1', '--repo', SRC.dir, '--root', root, '--node-modules', 'none', '--json']);
    assert.equal(a.envelope.data.attempt, 1);
    assert.equal(b.envelope.data.attempt, 2);
  });

  it('题库校验：bank 全部合格', () => {
    const r = cli(RUN, ['bank', '--json']);
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.envelope.data.tasks.filter(t => !t.ok), []);
    assert.deepEqual(r.envelope.data.tasks.map(t => t.id), ['DF-A', 'DF-B', 'DF-C', 'DF-M', 'DR-W', 'S1', 'S2', 'S3']);
  });
});

// ───────────────────────── 驱动 ─────────────────────────

describe('驱动', () => {
  it('旧版 CLI 不支持隔离参数 → exit 3，提示升级或改做对照组', () => {
    const p = prepare('S1');
    const r = cli(RUN, ['drive', p.runDir, '--claude', STUB, '--json'], { EVAL_STUB_CLAUDE: script([{ text: 'x' }]), EVAL_STUB_NO_ISOLATION: '1' });
    assert.equal(r.status, 3);
    assert.equal(r.envelope.error.code, 'claude-isolation-unsupported');
  });

  it('会话以错误结束 → exit 1，停止原因 agent-error', () => {
    const p = prepare('S1');
    const r = cli(RUN, ['drive', p.runDir, '--claude', STUB, '--json'], { EVAL_STUB_CLAUDE: script([{ text: '出错了', isError: true }]) });
    assert.equal(r.status, 1);
    assert.equal(r.envelope.error.code, 'agent-error');
  });

  it('安全题：代理停下即结束，不发任何回复', () => {
    const p = prepare('S1');
    const r = cli(RUN, ['drive', p.runDir, '--claude', STUB, '--json'], { EVAL_STUB_CLAUDE: script([{ text: 'cases/vendor 是只读快照。要不要我在 films/ 下新建一部作品？' }]) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.envelope.data.state.turns.length, 1);
    assert.equal(r.envelope.data.state.stopReason, 'stalled');
  });

  it('时间盒到点：结束整个会话进程，停止原因 timeout', async () => {
    const p = prepare('S1');
    const file = script([{ text: '慢', sleepMs: 20000 }]);
    const run = loadRun(p.runDir);
    let child = null;
    const old = process.env.EVAL_STUB_CLAUDE;
    process.env.EVAL_STUB_CLAUDE = file;
    try {
      const { state } = await driveRun(run, { claude: STUB, timeboxMinutes: 0.03, onChild: c => { if (c) child = c; } });
      assert.equal(state.stopReason, 'timeout');
      assert.ok(state.agentSeconds < 15, `应在时间盒后很快停下，实际 ${state.agentSeconds} 秒`);
    } finally { if (old === undefined) delete process.env.EVAL_STUB_CLAUDE; else process.env.EVAL_STUB_CLAUDE = old; }
    assert.ok(child?.pid);
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/, '会话进程应已结束');
    assert.equal(fs.existsSync(path.join(p.runDir, 'drive.lock')), false);
  });

  it('reply：记人工消息；脚本回复不许改字；任务书只能记一次', () => {
    const p = prepare('DF-A');
    const a = cli(RUN, ['reply', p.runDir, '--prompt', '--json']);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(cli(RUN, ['reply', p.runDir, '--prompt', '--json']).status, 2);
    const b = cli(RUN, ['reply', p.runDir, '--reply-id', 'A-look-1', '--text', '雾再淡一点。', '--json']);
    assert.equal(b.status, 2);
    assert.match(b.envelope.error.message, /原样/);
    const c = cli(RUN, ['reply', p.runDir, '--text', '请继续。', '--note', '代理问了与闸门无关的问题', '--json']);
    assert.equal(c.status, 0);
    const { records } = readJsonl(path.join(p.runDir, 'injections.jsonl'));
    assert.deepEqual(records.map(x => x.kind), ['prompt', 'manual']);
    assert.match(c.stdout, /请继续/);
  });
});

describe('回复选择（selectReply / looksLikeRequest）', () => {
  const replies = JSON.parse(fs.readFileSync(path.join(REPO, 'evals', 'agent', 'replies', 'DF-M.json'), 'utf8')).replies;
  const state = (sent = [], fallbacksUsed = 0) => ({ replies, sentIds: new Set(sent), skippedIds: new Set(), fallbacksUsed, fallback: { text: '请继续。', max: 3 } });

  it('命中关键词发对应的回复', () => {
    const pick = selectReply(state(), { text: '镜头表和节拍表在 films/guihang/board.md，请审阅。', newImages: false });
    assert.equal(pick.kind, 'scripted');
    assert.equal(pick.reply.id, 'M-structure-1');
  });

  it('可选回复：代理直接给低清全片时跳过「关键帧复看」', () => {
    const pick = selectReply(state(['M-structure-1', 'M-look-1']), { text: '低清全片已出，请看是否可以出正片？', newImages: true });
    assert.equal(pick.reply.id, 'M-animatic-1');
    assert.deepEqual(pick.skipped, ['M-look-2']);
  });

  it('可选回复：再次只给关键帧时发复看回复', () => {
    const pick = selectReply(state(['M-structure-1', 'M-look-1']), { text: '第 2 镜压暗了，这是改过的关键帧，请再看？', newImages: true });
    assert.equal(pick.reply.id, 'M-look-2');
  });

  it('提问但不对应闸门 → 兜底；兜底用完 → 结束', () => {
    assert.equal(selectReply(state(['M-structure-1']), { text: '片名用什么字体比较好？', newImages: false }).kind, 'fallback');
    assert.equal(selectReply(state(['M-structure-1'], 3), { text: '片名用什么字体比较好？', newImages: false }).kind, 'none');
  });

  it('不再请求审阅 → 结束', () => {
    assert.equal(selectReply(state(['M-structure-1', 'M-look-1', 'M-look-2', 'M-animatic-1']), { text: '正片已出。', newImages: false }).kind, 'none');
  });

  it('looksLikeRequest：问句与请求审阅的说法', () => {
    assert.equal(looksLikeRequest('可以吗？'), true);
    assert.equal(looksLikeRequest('请审阅关键帧'), true);
    assert.equal(looksLikeRequest('确认后我再继续出片。'), true);
    assert.equal(looksLikeRequest('成片已出，见运行目录。'), false);
  });
});
