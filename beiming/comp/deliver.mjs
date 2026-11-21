// 交付六件套：拼接 → 混音母带 → 编码（母版、网页一次出）→ 联系表 → 锁文件副本 → run.json → report.json。
//   master.mp4  母版成片（h264-crf14-bt709，带音轨）
//   web.mp4     网页成片（web 档，带音轨，faststart）
//   contact.png 全片抽样联系表
//   report.json 交付核对报告：逐项核对结果，以及另外五件的字节数与 sha256（交付清单）
//   run.json    运行参数与分步摘要（路径换成占位符，同样的输入逐位相同）
//   film.lock   锁文件副本
// run.json 锚定交付配置与报告正文，报告清单反向记录完整运行记录的哈希。
// delivery.web、delivery.contact 不出现等于不出（片子描述契约 3.5），这时对应的那一件不出、清单里也不列。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { checkContract, masterAudio, measureLoudness, mixEvents, readEvents } from './audio.mjs';
import { encode, isFaststart, probeMedia } from './encode.mjs';
import { CompError, bad, escapeFilterValue, parseFps, runTool, stitchGraph, tools } from './stitch.mjs';

export const PIECES = Object.freeze({
  master: 'master.mp4', web: 'web.mp4', contact: 'contact.png', report: 'report.json', run: 'run.json', lock: 'film.lock',
});
export const CONTACT = Object.freeze({ columns: 4, rows: 3, thumbWidth: 320 });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileEntry = (path) => {
  const buf = readFileSync(path);
  return { bytes: buf.length, sha256: sha256(buf) };
};
const mismatch = (message) => new CompError('contract.delivery-mismatch', message);

/** 应该有哪几件（不含 report.json 自己） */
export function expectedPieces(delivery = {}) {
  return [PIECES.master, ...(delivery.web ? [PIECES.web] : []), ...(delivery.contact ? [PIECES.contact] : []), PIECES.run, PIECES.lock];
}

/** 联系表抽哪几帧：把全片等分成 n 段，取每段中间那一帧（全片帧号） */
export function contactFrames(frames, n = CONTACT.columns * CONTACT.rows) {
  const k = Math.min(n, frames);
  return Array.from({ length: k }, (_, i) => Math.floor(((2 * i + 1) * frames) / (2 * k)));
}

function contactSheet(master, out, frames, { timeoutMs } = {}) {
  const picks = contactFrames(frames);
  const select = picks.map((f) => `eq(n\\,${f})`).join('+');
  const filter = `select=${select},scale=${CONTACT.thumbWidth}:-2:in_range=tv:in_color_matrix=bt709:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24,tile=${CONTACT.columns}x${CONTACT.rows}`;
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', master, '-vf', filter, '-fps_mode', 'passthrough',
    '-frames:v', '1', '-update', '1', '-bitexact', '-map_metadata', '-1', out];
  runTool(tools().ffmpeg, args, { timeoutMs, what: '联系表' });
  return { picks, args };
}

function pngSize(buf) {
  if (buf.toString('latin1', 1, 4) !== 'PNG') return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** 参数里的绝对路径换成占位符，run.json 不带本机路径、同样的输入逐位相同 */
function placeholders(args, map) {
  return args.map((a) => {
    let s = String(a);
    for (const [from, to] of map) if (from) s = s.split(from).join(to);
    return s;
  });
}

function check(list, id, ok, expected, actual) {
  list.push({ id, ok: Boolean(ok), expected, actual });
}

function videoChecks(list, tag, p, film) {
  const { size, fps, frames } = film.output;
  const { num, den } = parseFps(fps);
  check(list, `${tag}.codec`, p.video.codec === 'h264', 'h264', p.video.codec);
  check(list, `${tag}.pix_fmt`, p.video.pixFmt === 'yuv420p', 'yuv420p', p.video.pixFmt);
  check(list, `${tag}.color_range`, p.video.colorRange === 'tv', 'tv', p.video.colorRange);
  check(list, `${tag}.color_space`, p.video.colorSpace === 'bt709', 'bt709', p.video.colorSpace);
  check(list, `${tag}.color_primaries`, p.video.colorPrimaries === 'bt709', 'bt709', p.video.colorPrimaries);
  check(list, `${tag}.color_transfer`, p.video.colorTransfer === 'bt709', 'bt709', p.video.colorTransfer);
  check(list, `${tag}.size`, p.video.width === size[0] && p.video.height === size[1], size, [p.video.width, p.video.height]);
  check(list, `${tag}.rate`, p.video.rate === `${num}/${den}`, `${num}/${den}`, p.video.rate);
  check(list, `${tag}.frames`, p.video.frames === frames, frames, p.video.frames);
  const seconds = (frames * den) / num;
  check(list, `${tag}.duration`, Math.abs(p.video.duration - seconds) <= (0.5 * den) / num, seconds, p.video.duration);
}

/**
 * 出交付六件套。
 * opts：
 *   film      片子描述（film/3.0）
 *   events    展开后的事件表（events/0.1）或其 JSON 路径
 *   lock      锁文件对象，或锁文件路径（原样复制字节）
 *   frames    { 镜头 id: { pattern, start?, kind?, transfer? } }：每个镜头的帧序列
 *   view      { lutPath, shaper: { minEv, maxEv, mid } }：场景参考镜头的显示变换
 *   outDir    输出目录
 *   tier      'final'（默认）| 'draft' | 'preview'
 *   颗粒使用已校验锁内的逐镜头种子。
 *   tracks    外部 WAV 音轨 [{ path, at, gainDb }]；bed：'silence' | 'room'
 * 返回 { dir, files: { 名字: { bytes, sha256 } }, report }
 */
export function deliver(opts) {
  const { film, frames, view = {}, tier = 'final', tracks = [], bed: bedKind = 'silence', timeoutMs } = opts;
  if (tier === 'final' && opts.hwEncoder !== undefined) throw bad(`终渲不收显卡编码器 ${opts.hwEncoder}`);
  checkContract(film, 'film/3.0');
  const events = readEvents(opts.events, film);
  const delivery = film.delivery ?? {};
  if (delivery.master !== 'h264-crf14-bt709') throw bad(`母版编码预设 ${delivery.master} 不认识：母版只收 h264-crf14-bt709`);
  let lock = opts.lock, lockBytes;
  if (typeof lock === 'string') {
    try {
      lockBytes = readFileSync(lock);
      lock = JSON.parse(lockBytes.toString('utf8'));
    } catch (err) { throw bad(`无法读取锁文件：${err.message}`); }
  }
  checkContract({ format: 'lock-check/0.1', film, lock }, 'lock-check/0.1');
  lockBytes ??= jsonBytes(lock);
  const seed = lock.seeds.film;

  const hasScene = film.shots.some((s) => s.colorRef === 'scene');
  let lut = null;
  if (hasScene) {
    if (!view.lutPath) throw bad(`有场景参考镜头，要显式给 style.view.scene（${film.style.view.scene}）对应的 .cube 查找表 view.lutPath`);
    lut = { name: film.style.view.scene, file: basename(view.lutPath), sha256: `sha256:${sha256(readFileSync(view.lutPath))}` };
    const locked = lock.view?.[film.style.view.scene];
    if (locked !== lut.sha256) throw mismatch(`查找表 ${lut.name} 的哈希 ${lut.sha256} 和锁文件里的 ${locked} 不同`);
  }

  const shots = film.shots.map((s) => {
    const seq = frames?.[s.id];
    if (!seq) throw bad(`缺镜头 ${s.id} 的帧序列`);
    return { ...seq, id: s.id, in: s.in, out: s.out, colorRef: s.colorRef };
  });
  const graph = stitchGraph({
    shots, size: film.output.size, fps: film.output.fps, view, finish: film.style?.finish, transitions: film.transitions ?? [], shotSeeds: lock.seeds,
  });

  const destination = resolve(opts.outDir);
  if (existsSync(destination) && readdirSync(destination).length) throw bad('交付输出目录必须为空');
  mkdirSync(dirname(destination), { recursive: true });
  const work = mkdtempSync(join(dirname(destination), '.beiming-comp-'));
  const dir = join(work, 'out');
  try {
    mkdirSync(dir);
    const steps = [];
    // 1. 声音
    const audioCfg = film.audio;
    const mode = audioCfg ? (audioCfg.mode ?? 'script') : 'none';
    if (mode === 'track' && tracks.length === 0) throw bad('audio.mode 是 track，要传外部音轨 tracks');
    let mastered = null;
    if (mode !== 'none') {
      const mix = mixEvents(events, { mode, bed: bedKind, tracks });
      mastered = masterAudio(mix, work, { loudness: audioCfg.loudness ?? -14, truePeak: audioCfg.truePeak ?? -1, timeoutMs });
      steps.push({ step: 'audio', mode, bed: mode === 'track' ? 'silence' : bedKind, sampleRate: 48000, channels: 2, samples: mix.length, placements: mix.placements,
        passes: mastered.passes, ceilingDbtp: mastered.ceilingDb, silent: mastered.silent });
    } else {
      steps.push({ step: 'audio', mode: 'none' });
    }
    // 2. 编码
    const outputs = [{ preset: delivery.master, path: join(dir, PIECES.master) }];
    if (delivery.web) outputs.push({ preset: 'web', path: join(dir, PIECES.web) });
    const args = encode({ graph, outputs, audioPath: mastered?.path, tier, hwEncoder: opts.hwEncoder, timeoutMs });
    const subst = [[dir, '<out>'], [work, '<work>'],
      ...(view.lutPath ? [[escapeFilterValue(view.lutPath), `<lut:${lut?.file}>`], [view.lutPath, `<lut:${lut?.file}>`]] : []),
      ...shots.map((s) => [s.pattern, `<frames:${s.id}>`])];
    steps.push({ step: 'encode', outputs: outputs.map((o) => ({ preset: o.preset, file: basename(o.path) })), args: placeholders(args, subst) });
    // 3. 联系表
    if (delivery.contact) {
      const c = contactSheet(join(dir, PIECES.master), join(dir, PIECES.contact), film.output.frames, { timeoutMs });
      steps.push({ step: 'contact', frames: c.picks, grid: [CONTACT.columns, CONTACT.rows], args: placeholders(c.args, subst) });
    }
    // 4. 锁文件副本
    writeFileSync(join(dir, PIECES.lock), lockBytes);

    // 核对
    const checks = [];
    const probes = {};
    for (const o of outputs) {
      const name = basename(o.path);
      const p = probeMedia(o.path, { timeoutMs });
      probes[name] = p;
      videoChecks(checks, name, p, film);
      if (mastered) {
        check(checks, `${name}.audio`, p.audio?.codec === 'aac' && p.audio.sampleRate === 48000 && p.audio.channels === 2,
          { codec: 'aac', sampleRate: 48000, channels: 2 }, p.audio && { codec: p.audio.codec, sampleRate: p.audio.sampleRate, channels: p.audio.channels });
      }
    }
    if (delivery.web) check(checks, 'web.mp4.faststart', isFaststart(readFileSync(join(dir, PIECES.web))), true, isFaststart(readFileSync(join(dir, PIECES.web))));
    let loud = null;
    if (mastered && !mastered.silent) {
      loud = measureLoudness(join(dir, PIECES.master), { timeoutMs });
      const target = audioCfg.loudness ?? -14, peak = audioCfg.truePeak ?? -1;
      check(checks, 'master.mp4.loudness', loud.integrated >= target - 1 && loud.integrated <= target + 1, [target - 1, target + 1], loud.integrated);
      check(checks, 'master.mp4.true_peak', loud.truePeak <= peak, `<= ${peak}`, loud.truePeak);
    }
    if (delivery.contact) {
      const size = pngSize(readFileSync(join(dir, PIECES.contact)));
      check(checks, 'contact.png.size', size && size[0] === CONTACT.columns * CONTACT.thumbWidth, CONTACT.columns * CONTACT.thumbWidth, size?.[0] ?? null);
    }
    check(checks, 'film.lock.film', lock.film === film.id, film.id, lock.film);

    const run = {
      format: 'comp-run/0.1', film: film.id, rev: lock.rev ?? null, tier, seed,
      output: film.output, view: { scene: film.style?.view?.scene ?? null, display: film.style?.view?.display ?? null, lut, shaper: view.shaper ?? null },
      finish: { grain: film.style?.finish?.grain ?? 0, vignette: film.style?.finish?.vignette ?? 0, filters: graph.shotFilters },
      transitions: film.transitions ?? [], shots: graph.shots.map((s) => ({ id: s.id, in: s.in, out: s.out, colorRef: s.colorRef, kind: s.kind, transfer: s.transfer, start: s.start })),
      ffmpeg: ffmpegVersion(timeoutMs), steps,
    };

    const files = {};
    for (const name of expectedPieces(delivery).filter((n) => n !== PIECES.run)) files[name] = fileEntry(join(dir, name));
    const report = {
      format: 'comp-report/0.1', film: film.id, delivery: { master: delivery.master, web: Boolean(delivery.web), contact: Boolean(delivery.contact) },
      ok: checks.every((c) => c.ok), checks, probes, loudness: loud, files,
    };
    if (!report.ok) {
      throw mismatch(`交付核对不过：${checks.filter((c) => !c.ok).map((c) => `${c.id}（要 ${JSON.stringify(c.expected)}，实际 ${JSON.stringify(c.actual)}）`).join('；')}`);
    }
    run.delivery = report.delivery;
    run.reportBodySha256 = sha256(jsonBytes(report));
    writeFileSync(join(dir, PIECES.run), jsonBytes(run));
    files[PIECES.run] = fileEntry(join(dir, PIECES.run));
    writeFileSync(join(dir, PIECES.report), jsonBytes(report));
    // 同文件系统内一次发布。并发交付已填满目标目录时，rename 会拒绝覆盖。
    renameSync(dir, destination);
    files[PIECES.report] = fileEntry(join(destination, PIECES.report));
    return { dir: destination, files, report };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function ffmpegVersion(timeoutMs) {
  const { stdout } = runTool(tools().ffmpeg, ['-hide_banner', '-version'], { timeoutMs, what: 'ffmpeg 版本' });
  return /version\s+(\S+)/.exec(stdout.toString('utf8'))?.[1] ?? 'unknown';
}

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** 默认交叉核验报告与运行记录。历史报告需要调用方保存的完整报告摘要。 */
export function verifyDeliveryBundle(dir, { reportSha256 } = {}) {
  const reportPath = join(dir, PIECES.report);
  if (!existsSync(reportPath)) throw mismatch(`缺 ${PIECES.report}`);
  const reportBytes = readFileSync(reportPath);
  if (reportSha256 && sha256(reportBytes) !== reportSha256) throw mismatch(`${PIECES.report} 的 sha256 不对`);
  let report;
  try { report = JSON.parse(reportBytes.toString('utf8')); } catch { throw mismatch(`${PIECES.report} 不是 JSON`); }
  if (report?.format !== 'comp-report/0.1' || !report.files) throw mismatch(`${PIECES.report} 不是交付核对报告`);
  const runPath = join(dir, PIECES.run);
  if (!existsSync(runPath)) throw mismatch(`缺 ${PIECES.run}`);
  let run;
  try { run = JSON.parse(readFileSync(runPath, 'utf8')); } catch { throw mismatch('run.json 不是 JSON'); }
  if (run?.format !== 'comp-run/0.1') throw mismatch('run.json 格式不符');
  if (run.reportBodySha256 !== undefined) {
    const body = { ...report, files: { ...report.files } };
    delete body.files[PIECES.run];
    const bodySha256 = sha256(jsonBytes(body));
    body.files[PIECES.run] = fileEntry(runPath);
    if (!jsonBytes(body).equals(reportBytes) || bodySha256 !== run.reportBodySha256) throw mismatch('report.json 完整性校验失败');
    if (JSON.stringify(run.delivery) !== JSON.stringify(report.delivery)) throw mismatch('交付配置与运行记录不符');
  } else if (!reportSha256) throw mismatch('缺报告摘要，历史交付需要 reportSha256');
  const expected = expectedPieces(run.delivery ?? report.delivery);
  if (Object.keys(report.files).length !== expected.length || !report.ok) throw mismatch('交付清单不符');
  const files = {};
  for (const name of expected) {
    const want = report.files[name];
    if (!want) throw mismatch(`交付清单里没有 ${name}`);
    const p = join(dir, name);
    if (!existsSync(p)) throw mismatch(`缺 ${name}`);
    const got = fileEntry(p);
    if (got.bytes !== want.bytes) throw mismatch(`${name} 的字节数 ${got.bytes} 和清单里的 ${want.bytes} 不同`);
    if (got.sha256 !== want.sha256) throw mismatch(`${name} 的 sha256 和清单里的不同`);
    files[name] = got;
  }
  files[PIECES.report] = { bytes: reportBytes.length, sha256: sha256(reportBytes) };
  return { files };
}
