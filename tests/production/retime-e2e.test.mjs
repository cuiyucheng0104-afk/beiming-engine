// 端到端（北极星验收第 4 条，画面一侧）：只改 film.json 里一个镜头的 out，不改代码——
// 真的用渲染器（engine/render/video.mjs）出片、用机器 QA（tools/qa visual）检出切点，切点跟着 film.json 走；
// QA 期望（film.js expect）同步变化；拿旧成片对新的 film.json 核对，切点检查不通过（说明检查不是摆设）。
// 夹具页面 tests/production/fixtures/retime/index.html 只用 engine/production/timeline.js 的 pageTiming 读时间。
// 需要 FFmpeg 与 Playwright 的无头浏览器（npm run setup）；缺了整组跳过。
// 夹具复制到仓库的 out/.p05-e2e-*（渲染器只认仓库内的影片目录；out/ 被 .gitignore 忽略），测试结束删除。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { REPO, runFilm } from './helpers.mjs';

const has = cmd => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
const browserOk = (() => { try { return Boolean(process.env.BEIMING_CHROME) || existsSync(chromium.executablePath()); } catch { return false; } })();
const skip = !has('ffmpeg') || !has('ffprobe') ? '没有 FFmpeg / ffprobe' : !browserOk ? '没有 Playwright 浏览器（npm run setup）' : false;

const node = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000, ...opts });

/** 渲染影片目录 filmDir：320×180、2 段并行，成片写到 outDir/<name>.mp4；返回成片路径。 */
function render(filmDir, outDir, name) {
  const out = join(outDir, `${name}.mp4`);
  const r = node(['engine/render/video.mjs', relative(REPO, filmDir), '--size', '320x180', '--workers', '2', '--out', relative(REPO, out)]);
  assert.equal(r.status, 0, `渲染失败：${r.stdout}\n${r.stderr}`);
  return out;
}

/** 机器 QA 的切点检查：返回 { status, detected 切点帧 }。 */
function qaCuts(video, filmDir) {
  const r = node(['tools/qa/cli.mjs', 'visual', relative(REPO, video), '--film', relative(REPO, filmDir), '--json']);
  const env = JSON.parse(r.stdout);
  const report = env.result ?? env.data;
  const cuts = report.checks.find(c => c.id === 'visual.cuts');
  assert.ok(cuts, `QA 报告里没有 visual.cuts：${r.stdout.slice(0, 400)}`);
  return { status: cuts.status, cuts, freeze: report.checks.find(c => c.id === 'visual.freeze')?.status };
}

test('只改一个镜头的 out：渲染出的切点、QA 检出的切点、QA 期望都跟着 film.json 走，不改页面代码', { skip, timeout: 600_000 }, () => {
  const outRoot = join(REPO, 'out'), createdOut = !existsSync(outRoot);
  mkdirSync(outRoot, { recursive: true });
  const work = mkdtempSync(join(outRoot, '.p05-e2e-'));
  const film = join(work, 'retime');
  try {
    cpSync(join(REPO, 'tests', 'production', 'fixtures', 'retime'), film, { recursive: true });
    const page = readFileSync(join(film, 'index.html'), 'utf8');
    assert.doesNotMatch(page.replace(/\/\/.*$/gm, ''), /\b\d+(\.\d+)?\s*\*?\s*(s|sec|秒)\b|[<>]=?\s*\d+\.\d+/, '页面代码里不应写死秒数');

    // 1. 原始切点 [48, 72]
    const before = render(film, work, 'before');
    const q0 = qaCuts(before, film);
    assert.equal(q0.status, 'pass', JSON.stringify(q0.cuts));
    assert.notEqual(q0.freeze, 'fail', '镜头里有移动的竖条，不应判静帧');
    const e0 = runFilm(['expect', film, '--json']).json.data;
    assert.deepEqual(e0.cuts.map(c => c.frame), [48, 72]);

    // 2. 只改 film.json：S1 的出点 48 → 60（ripple），后面的镜头与事件整体后移
    const r = runFilm(['retime', film, '--shot', 'S1', '--out', '60', '--write', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const e1 = runFilm(['expect', film, '--json']).json.data;
    assert.deepEqual(e1.cuts.map(c => c.frame), [60, 84]);
    assert.equal(e1.video.frameCount, 132);
    assert.equal(e1.events.find(e => e.id === 's3.mark').frame, 108);
    assert.equal(readFileSync(join(film, 'index.html'), 'utf8'), page, '页面代码没有被改');

    // 3. 旧成片对新的作品描述：切点对不上，QA 不通过（检查是真的在比）
    assert.equal(qaCuts(before, film).status, 'fail');

    // 4. 重新渲染：画面切点跟着 film.json 到了 [60, 84]，帧数 132，QA 通过
    const after = render(film, work, 'after');
    const frames = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', after], { encoding: 'utf8' }).stdout.trim();
    assert.equal(Number(frames), 132);
    const q1 = qaCuts(after, film);
    assert.equal(q1.status, 'pass', JSON.stringify(q1.cuts));
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (createdOut) { try { rmdirSync(outRoot); } catch { /* 别的进程在用 out/，留着 */ } }
  }
});
