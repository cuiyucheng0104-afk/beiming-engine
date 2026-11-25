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
  measureSolution,
  renderSolution,
  validateSolutionFilm,
} from './solutions/index.mjs';
import { runFfmpegSync } from './solutions/media.mjs';
import { ocrSubtitleLineFromGray, resolve30_1Events } from './solutions/renderers.mjs';

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
      assert.equal(nf.measurementCount, 4, `${nf.slug} measurementCount 应为 4`);
      assert.equal(nf.run1Measurements.length, 2, `${nf.slug} run1Measurements`);
      assert.equal(nf.run2Measurements.length, 2, `${nf.slug} run2Measurements`);
      assert.ok(Number.isFinite(nf.repeatMeasureDelta) && nf.repeatMeasureDelta >= 0, `${nf.slug} repeatMeasureDelta`);
      assert.ok(Number.isFinite(nf.repeatRenderDelta) && nf.repeatRenderDelta >= 0, `${nf.slug} repeatRenderDelta`);
      assert.ok(Number.isFinite(nf.noiseFloor) && nf.noiseFloor >= 0, `${nf.slug} noiseFloor`);
      for (const [label, v] of [
        ['first', nf.runs.first],
        ['repeatMeasure', nf.runs.repeatMeasure],
        ['secondRender', nf.runs.secondRender],
        ['secondRenderRepeatMeasure', nf.runs.secondRenderRepeatMeasure],
      ]) {
        assert.equal(v.pass, true, `${nf.slug} ${label}`);
        assert.equal(v.score, 1, `${nf.slug} ${label} score`);
      }
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

test('B20-5 R1/R2 回归守卫：18-1 全帧像素 OCR 与单帧篡改/截短、30-1 实渲 BPM 基线与时间卡联动、15-2 ffprobe 规格门禁', async (t) => {
  if (!requireOrSkipMedia(t)) return;
  const root = mkdtempSync(join(tmpdir(), 'beiming-b20-r1-'));
  try {
    // 1) 18-1：实心矩形覆盖字幕区、清空字幕区、抹坏单字或仅篡改单帧（第 26 帧 Scene -> Zcene）均必须被真实像素 OCR 拦下
    const r18 = await renderSolution('18-1', join(root, '18-1-orig'));
    const solidBarMp4 = join(root, '18-1-solidbar.mp4');
    runFfmpegSync([
      '-i', r18.deliverablePath,
      '-vf', 'drawbox=x=0:y=950:w=1920:h=86:color=0xF5F2E9@1:t=fill,drawbox=x=792:y=960:w=336:h=48:color=0x1A1714@1:t=fill',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv',
      '-c:a', 'copy', solidBarMp4,
    ]);
    const m18Bar = await measureSolution('18-1', { ...r18, deliverablePath: solidBarMp4 });
    assert.equal(m18Bar.verdict.pass, false, '18-1 实心墨迹块覆盖字幕区必须判不过');
    assert.equal(
      m18Bar.basePredicates.find((p) => p.predicate.includes('text_matches')).pass,
      false,
      '18-1 实心块必须令 text_matches(copy) 判 fail',
    );

    const corruptMp4 = join(root, '18-1-corrupt.mp4');
    runFfmpegSync([
      '-i', r18.deliverablePath,
      '-vf', 'drawbox=x=950:y=970:w=24:h=32:color=0xF5F2E9@1:t=fill',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv',
      '-c:a', 'copy', corruptMp4,
    ]);
    const m18Corrupt = await measureSolution('18-1', { ...r18, deliverablePath: corruptMp4 });
    assert.equal(m18Corrupt.verdict.pass, false, '18-1 损坏单个字形必须判不过');
    assert.equal(
      m18Corrupt.basePredicates.find((p) => p.predicate.includes('text_matches')).pass,
      false,
      '18-1 单字损坏必须令 text_matches(copy) 判 fail',
    );
    assert.deepEqual(ocrSubtitleLineFromGray(new Uint8Array(1920 * 1080).fill(245), 1920, 1080), []);

    // R2-1：18-1 仅篡改第 26 帧字幕（Scene -> Zcene），其余帧保持 Scene，全帧覆查必须抓出第 26 帧并判 pass === false
    const frame26ZceneMp4 = join(root, '18-1-frame26-zcene.mp4');
    const zceneFilter = [
      "drawbox=x=744:y=972:w=20:h=28:color=0xF5F2E9@1:t=fill:enable='eq(n,26)'",
      "drawbox=x=744:y=972:w=20:h=4:color=0x1A1714@1:t=fill:enable='eq(n,26)'",
      "drawbox=x=760:y=976:w=4:h=4:color=0x1A1714@1:t=fill:enable='eq(n,26)'",
      "drawbox=x=756:y=980:w=4:h=4:color=0x1A1714@1:t=fill:enable='eq(n,26)'",
      "drawbox=x=752:y=984:w=4:h=4:color=0x1A1714@1:t=fill:enable='eq(n,26)'",
      "drawbox=x=748:y=988:w=4:h=4:color=0x1A1714@1:t=fill:enable='eq(n,26)'",
      "drawbox=x=744:y=992:w=4:h=4:color=0x1A1714@1:t=fill:enable='eq(n,26)'",
      "drawbox=x=744:y=996:w=20:h=4:color=0x1A1714@1:t=fill:enable='eq(n,26)'",
    ].join(',');
    runFfmpegSync([
      '-i', r18.deliverablePath,
      '-vf', zceneFilter,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv',
      '-c:a', 'copy', frame26ZceneMp4,
    ]);
    const m18Frame26 = await measureSolution('18-1', { ...r18, deliverablePath: frame26ZceneMp4 });
    assert.equal(m18Frame26.verdict.pass, false, '18-1 仅篡改第 26 帧 Scene -> Zcene 必须判 pass === false');
    const textPred26 = m18Frame26.basePredicates.find((p) => p.predicate.includes('text_matches'));
    assert.equal(textPred26.pass, false, '18-1 第 26 帧篡改必须令 text_matches(copy) @ all 判 fail');
    assert.equal(textPred26.detail.counterexampleFrame, 26, '反例帧必须精确定位到第 26 帧');
    assert.deepEqual(textPred26.detail.measured.ocr, ['Zcene one opens cleanly']);

    // R2-3：18-1 截短为 899 帧后必须优雅返回 pass === false 与 probe.frames === 899，严禁抛未捕获异常
    const short899Mp4 = join(root, '18-1-short899.mp4');
    runFfmpegSync([
      '-i', r18.deliverablePath,
      '-frames:v', '899',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv',
      '-c:a', 'alac', '-shortest', short899Mp4,
    ]);
    const m18Short = await measureSolution('18-1', { ...r18, deliverablePath: short899Mp4 });
    assert.equal(m18Short.probe.frames, 899, '18-1 截短成片应实测 899 帧');
    assert.equal(m18Short.verdict.pass, false, '18-1 截短为 899 帧必须优雅判 pass === false');
    assert.equal(
      m18Short.basePredicates.find((p) => p.predicate.startsWith('delivery(')).pass,
      false,
      '18-1 截短为 899 帧必须令 delivery 谓词判 fail',
    );

    // 2) 30-1：time.timeline / time.events / time.envelope 串联求值随 80 -> 96 BPM 联动且 title_enter 固定第 48 帧
    const ev80 = resolve30_1Events({ bpm: 80, fpsFraction: '24/1', frames: 2160 });
    const ev96 = resolve30_1Events({ bpm: 96, fpsFraction: '24/1', frames: 2160 });
    assert.deepEqual(ev80.beatEvents.map((e) => e.frame), Array.from({ length: 20 }, (_, i) => (i + 1) * 72));
    assert.deepEqual(ev96.beatEvents.map((e) => e.frame), Array.from({ length: 20 }, (_, i) => (i + 1) * 60));
    assert.deepEqual(ev80.absoluteEvents, [{ id: 'title_enter', frame: 48 }]);
    assert.deepEqual(ev96.absoluteEvents, [{ id: 'title_enter', frame: 48 }]);
    assert.throws(() => resolve30_1Events({ bpm: 0, fpsFraction: '24/1', frames: 2160 }), RangeError);
    assert.throws(() => resolve30_1Events({ bpm: 80, fpsFraction: null, frames: 2160 }), RangeError);

    // R2-2：30-1 工程改为 96 BPM 渲染后，基线事件必须反映实渲第 60 帧并判 pass === false
    const film30Bpm96 = structuredClone(loadSolutionFilm('30-1'));
    film30Bpm96.timeline.bpm = 96;
    const r30Bpm96 = await renderSolution('30-1', join(root, '30-1-bpm96'), { film: film30Bpm96 });
    const evDoc96 = JSON.parse(readFileSync(r30Bpm96.artifacts.eventsPath, 'utf8'));
    assert.equal(evDoc96.bpm, 96, '30-1 改 96 BPM 后落盘 events.json.bpm 应为 96');
    assert.equal(evDoc96.beatEvents[0].frame, 60, '30-1 改 96 BPM 后落盘首事件应为第 60 帧');
    const m30Bpm96 = await measureSolution('30-1', r30Bpm96, { film: film30Bpm96 });
    assert.equal(m30Bpm96.verdict.pass, false, '30-1 工程改为 96 BPM 渲染必须判 pass === false');
    assert.equal(m30Bpm96.readings.beatEvents[0].frame, 60, '30-1 基线读数必须反映工程实渲首事件第 60 帧');

    // 3) 15-2：错帧率 24/1 必须由 ffprobe 实测出 fps=24 并判 pass === false；多出音轨亦被拦下
    const r15 = await renderSolution('15-2', join(root, '15-2-orig'));
    const fps24Mp4 = join(root, '15-2-24fps.mp4');
    runFfmpegSync([
      '-i', r15.deliverablePath,
      '-vf', 'setpts=N/(24*TB)',
      '-r', '24/1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-g', '1', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv',
      fps24Mp4,
    ]);
    const m15BadFps = await measureSolution('15-2', { ...r15, deliverablePath: fps24Mp4 });
    assert.equal(m15BadFps.probe.fps, 24, '15-2 错帧率片应由 ffprobe 实测出 24 fps');
    assert.equal(m15BadFps.probe.fpsNum, 24);
    assert.equal(m15BadFps.probe.fpsDen, 1);
    assert.equal(m15BadFps.basePredicates[0].pass, false, '15-2 错帧率必须令 delivery 谓词失败');
    assert.equal(m15BadFps.verdict.pass, false, '15-2 错帧率必须判 pass === false');

    const audioMp4 = join(root, '15-2-with-audio.mp4');
    runFfmpegSync([
      '-i', r15.deliverablePath,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'copy', '-c:a', 'alac', '-shortest', audioMp4,
    ]);
    const m15Audio = await measureSolution('15-2', { ...r15, deliverablePath: audioMp4 });
    assert.equal(m15Audio.probe.audio, true);
    assert.equal(m15Audio.verdict.pass, false, '15-2 无声题混入音轨必须判 pass === false');
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, 'R1 回归临时目录应已彻底清理');
  }
});
