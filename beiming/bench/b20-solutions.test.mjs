// B20：12 份标准答案工程契约校验、技术卡驱动真实成片渲染与真实读回满分验证、噪声地板量测测试
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanQuestionLeaks } from './validate-question.mjs';
import {
  SOLUTION_FORMAT,
  SOLUTION_IDS,
  evaluateSolution,
  hasMediaTools,
  loadSolutionFilm,
  loadSolutionSpec,
  measureNoiseFloor,
  validateSolutionFilm,
} from './solutions/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOLUTIONS_DIR = join(HERE, 'solutions');
const BINARY_EXT_RE = /\.(mp4|mov|wav|png|jpe?g|mkv|webm)$/i;

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function requireOrSkipMedia(t) {
  if (hasMediaTools()) return true;
  const required = (process.env.BEIMING_REQUIRE ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (required.includes('ffmpeg')) {
    assert.fail('BEIMING_REQUIRE 包含 ffmpeg，但当前环境缺少 ffmpeg/ffprobe');
  }
  t.skip('缺少 ffmpeg/ffprobe');
  return false;
}

test('B20-1 结构与契约：12 份 film/3.0 全过 film.schema + filmChecks + deliverable/needs 对齐 + 零泄露', () => {
  assert.equal(SOLUTION_FORMAT, 'bench-solution/0.1');
  assert.equal(SOLUTION_IDS.length, 12);

  // 兼容 1-1 / 01-1 与 5-1 / 05-1 别名
  assert.equal(loadSolutionSpec('01-1').questionId, '1-1');
  assert.equal(loadSolutionSpec('1-1').slug, '01-1');
  assert.equal(loadSolutionSpec('05-1').questionId, '5-1');
  assert.equal(loadSolutionSpec('5-1').slug, '5-1');

  for (const id of SOLUTION_IDS) {
    const spec = loadSolutionSpec(id);
    assert.ok(existsSync(spec.filmPath), `缺少 film.json: ${spec.filmPath}`);
    const film = loadSolutionFilm(id);
    assert.equal(film.format, 'film/3.0');
    assert.equal(film.exam, spec.question.id);

    for (const check of [validateSolutionFilm(id), validateSolutionFilm(film)]) {
      assert.equal(check.ok, true, `${id} 校验未过: ${JSON.stringify(check)}`);
      assert.deepEqual(check.schemaErrors, []);
      assert.deepEqual(check.violations, {});
      assert.deepEqual(check.alignments, []);
      assert.deepEqual(check.leaks, []);
    }
  }
});

test('B20-2 契约守卫：错题号、规格不齐、全局卡误放镜头、缺 needs 卡与泄露串均被准确拒绝', () => {
  assert.throws(() => loadSolutionSpec('99-9'), RangeError);
  assert.throws(() => loadSolutionSpec(null), RangeError);
  assert.throws(() => validateSolutionFilm(123), TypeError);

  const base = loadSolutionFilm('28-1');
  const badFrames = { ...base, output: { ...base.output, frames: base.output.frames + 1 } };
  assert.equal(validateSolutionFilm(badFrames).ok, false);

  // D8：全局卡 deliver.encode 不允许写进 shots[].cards
  const badGlobal = structuredClone(base);
  badGlobal.shots[0].cards.push({ as: 'enc', use: 'deliver.encode@1', params: {} });
  const globalRes = validateSolutionFilm(badGlobal);
  assert.equal(globalRes.ok, false);
  assert.ok(Array.isArray(globalRes.violations.D8) && globalRes.violations.D8.length > 0);

  // 缺少题面 needs 要求的卡
  const missingCard = structuredClone(base);
  missingCard.shots[0].cards = missingCard.shots[0].cards.filter((c) => !c.use.startsWith('camera.fit'));
  const missingRes = validateSolutionFilm(missingCard);
  assert.equal(missingRes.ok, false);
  assert.ok(missingRes.alignments.some((m) => m.includes('camera.fit')));

  // 泄露门禁：裸 64 位十六进制哈希与本机路径均被拦截
  const badLeak = structuredClone(base);
  badLeak.title = `leak ${'a'.repeat(64)}`;
  assert.equal(validateSolutionFilm(badLeak).ok, false);
  assert.ok(validateSolutionFilm(badLeak).leaks.some((l) => l.code === 'bare-sha256'));

  // 仓库目录零二进制媒体残留且全文件通过泄露扫描
  const files = walkFiles(SOLUTIONS_DIR);
  for (const file of files) {
    assert.equal(BINARY_EXT_RE.test(file), false, `禁止提交二进制媒体文件: ${file}`);
    if (file.endsWith('.json')) {
      assert.deepEqual(scanQuestionLeaks(readFileSync(file, 'utf8')), [], file);
    }
  }
});

test('B20-3 真实渲染与真实读回：12 道公开题全部实渲 deliverable.mp4、过 ffprobe 规格核验并全满分通过', async (t) => {
  if (!requireOrSkipMedia(t)) return;
  const root = mkdtempSync(join(tmpdir(), 'beiming-b20-all-'));
  try {
    const results = new Array(SOLUTION_IDS.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < SOLUTION_IDS.length) {
        const idx = cursor++;
        const id = SOLUTION_IDS[idx];
        const spec = loadSolutionSpec(id);
        results[idx] = { spec, res: await evaluateSolution(id, join(root, spec.slug)) };
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    for (const { spec, res } of results) {
      const want = spec.question.deliverable;
      const [wantNum, wantDen] = want.fps.split('/').map(Number);

      assert.ok(existsSync(res.deliverablePath), `${spec.slug} 缺少 deliverable.mp4`);
      assert.ok(statSync(res.deliverablePath).size > 0, `${spec.slug} deliverable.mp4 为空`);

      // 与 runner.mjs 同口径的 ffprobe 规格核验
      assert.ok(res.probe, `${spec.slug} ffprobe 读回为空`);
      assert.equal(res.probe.width, want.size[0], `${spec.slug} width`);
      assert.equal(res.probe.height, want.size[1], `${spec.slug} height`);
      assert.ok(res.probe.fpsDen > 0 && res.probe.fpsNum * wantDen === wantNum * res.probe.fpsDen, `${spec.slug} fps`);
      assert.equal(res.probe.frames, want.frames, `${spec.slug} frames`);
      assert.equal(res.probe.audio, want.audio !== 'none', `${spec.slug} audio`);
      assert.equal(res.probe.color_space, 'bt709', `${spec.slug} color_space`);
      assert.equal(res.probe.color_transfer, 'bt709', `${spec.slug} color_transfer`);
      assert.equal(res.probe.color_primaries, 'bt709', `${spec.slug} color_primaries`);

      // 基础谓词与判分项全绿
      assert.equal(res.verdict.pass, true, `${spec.slug} 未通过: ${JSON.stringify(res.verdict)}`);
      assert.equal(res.verdict.score, 1, `${spec.slug} 非满分: ${res.verdict.score}`);
      assert.ok(res.basePredicates.every((p) => p.pass === true), `${spec.slug} 基础谓词失败: ${JSON.stringify(res.basePredicates)}`);

      // 真实调用的技术卡覆盖题面 needs
      for (const need of spec.question.needs) {
        assert.ok(res.cardsUsed.includes(need), `${spec.slug} cardsUsed 缺少 ${need}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, '临时渲染目录应已彻底清理');
  }
});

test('B20-4 噪声地板量测与 CLI verify：代表题同片复量与独立重渲均有限非负且二次重渲全满分', async (t) => {
  if (!requireOrSkipMedia(t)) return;
  const root = mkdtempSync(join(tmpdir(), 'beiming-b20-nf-'));
  try {
    const sampleIds = ['23-1', '28-1', '27-1', '15-2', '5-1'];
    const reports = await Promise.all(sampleIds.map((id) => measureNoiseFloor(id, join(root, id))));
    for (const nf of reports) {
      assert.equal(nf.format, SOLUTION_FORMAT);
      assert.ok(Number.isFinite(nf.repeatMeasureDelta) && nf.repeatMeasureDelta >= 0, `${nf.slug} repeatMeasureDelta`);
      assert.ok(Number.isFinite(nf.repeatRenderDelta) && nf.repeatRenderDelta >= 0, `${nf.slug} repeatRenderDelta`);
      assert.ok(Number.isFinite(nf.noiseFloor) && nf.noiseFloor >= 0, `${nf.slug} noiseFloor`);
      assert.equal(nf.runs.first.pass, true, `${nf.slug} first`);
      assert.equal(nf.runs.first.score, 1, `${nf.slug} first score`);
      assert.equal(nf.runs.repeatMeasure.pass, true, `${nf.slug} repeatMeasure`);
      assert.equal(nf.runs.repeatMeasure.score, 1, `${nf.slug} repeatMeasure score`);
      assert.equal(nf.runs.secondRender.pass, true, `${nf.slug} secondRender`);
      assert.equal(nf.runs.secondRender.score, 1, `${nf.slug} secondRender score`);
    }

    // CLI verify 单题冒烟
    const cli = spawnSync(process.execPath, [join(SOLUTIONS_DIR, 'index.mjs'), 'verify', '--id', '23-1'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].pass, true);
    assert.equal(parsed.results[0].score, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, '噪声地板临时目录应已彻底清理');
  }
});
