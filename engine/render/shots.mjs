// 北冥引擎 · 按镜头渲染与镜头缓存（渲染器 v2 · R4，规格见 engine/render/README.md「镜头缓存」）
//   node engine/render/shots.mjs <影片目录> [--shots S2,S3] [--out out/video.mp4] [--cache <目录>] [--force] [--json] …   完整选项：--help
// 需要 film.json v2 的镜头表 shots: [{ id, in, out, module }]（帧号含头不含尾）。每个镜头渲成一段无声 H.264（块的切法与
// video.mjs 渲整片时完全相同），存进缓存 <影片>/out/cache/shots/<镜头>.<键>.mp4 与同名 .json；给了 --out 就按镜头表的顺序
// 拼成一部（复制，不重编码），核对总帧数。
// 缓存键 = sha256(渲染器版本、画幅、帧率、档位、截图与编码参数、URL 参数、film.json 里与画面有关的作品级字段、这个镜头在
//   film.json 里的条目与它的事件、页面实际加载过的本地文件的内容哈希——减去别的镜头独有的模块（lib/deps.mjs）)。
//   键没变就跳过（0 帧重渲）；只改了镜头 B 的模块就只重渲 B；改了某个镜头的 out 帧，只重渲它和后面接着的那个镜头。
//   film.json 本身不按整份文件算（否则改一个镜头所有镜头都失效）：作品级字段与本镜头字段分别进键。
// 中途停下（Ctrl-C、kill）后再跑一次：已完成的镜头命中缓存，只补渲剩下的；拼出来的成片与一次跑完逐帧相同。
// 失败语义、退出码、GPU 策略、页面约定与 video.mjs 相同。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openFilm, locateFilm, closeServer, ROOT } from './page.mjs';
import { runCli, RenderError, UsageError, EXIT } from './lib/cli.mjs';
import { preflight, COLOR, TAGS, x264Args, probe } from './lib/ffmpeg.mjs';
import { acquireLock } from './lib/lock.mjs';
import { acquireSlot, guardGpu, slotCount } from './lib/slots.mjs';
import { environment, baseRecord, writeRecord, sha256File, selfCheck, repoPath, sha256 } from './lib/record.mjs';
import { readFilm, shotsByIds } from './lib/film.mjs';
import { planFilmChunks, renderRange, concatChunks } from './lib/chunks.mjs';
import { shotExclusions } from './lib/deps.mjs';
import { SPEC as VIDEO, resolveOutputSpec, decideFps, rendererFingerprint } from './video.mjs';

const pick = keys => Object.fromEntries(keys.map(k => [k, VIDEO.options[k]]));
export const SPEC = {
  command: 'engine/render/shots.mjs',
  usage: 'node engine/render/shots.mjs <影片目录> [--shots S2,S3] [--out <成片.mp4>] [选项]',
  summary: ['按 film.json 的镜头表逐镜头渲染并缓存；键没变的镜头跳过，只重渲受影响的镜头；给 --out 时拼成一部。'],
  positionals: { min: 1, max: 1, names: ['影片目录'] },
  options: {
    '--shots': { type: 'list', arg: 'S1,S2', desc: '只渲这些镜头（默认全部）' },
    '--out': { type: 'string', arg: '<文件.mp4>', desc: '把选中的镜头按镜头表顺序拼成一部（不写就只更新缓存）' },
    '--cache': { type: 'string', arg: '<目录>', desc: '镜头缓存目录（默认 <影片>/out/cache/shots）' },
    '--force': { type: 'flag', desc: '不看缓存，选中的镜头全部重渲' },
    ...pick(['--profile', '--size', '--fps', '--any-fps', '--workers', '--chunk', '--query', '--fast', '--crf', '--preset', '--gpu', '--angle',
      '--allow-network', '--lenient-assets', '--allow-gl-errors', '--ready-timeout', '--frame-timeout', '--settle', '--progress',
      '--slots', '--no-wait', '--wait-timeout', '--no-guard', '--run-json', '--json']),
  },
  examples: [
    'node engine/render/shots.mjs films/x --out films/x/out/video.mp4          渲所有镜头（命中缓存的跳过）并拼成一部',
    'node engine/render/shots.mjs films/x --shots S2 --force                  只重渲 S2',
  ],
};

// film.json 里与画面无关、不进缓存键的作品级字段（时间由各镜头自己的 in / out 进键）
const NON_PICTURE = new Set(['shots', 'events', 'audio', 'gates', 'credits', 'deliveries', 'aigc', 'review', 'reviews', 'notes', 'status', 'schemaVersion']);
const stable = v => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
const fileHash = rel => { try { return createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); } catch { return null; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function main({ opts, args, explicit, log, signal, cleanup, setRunJson }) {
  cleanup(closeServer);
  const dir = args[0];
  const { rel: filmRel } = locateFilm(dir);
  const film = readFilm(dir);
  if (!film?.shots?.length) throw new UsageError(`${dir}/film.json 没有镜头表`, 'shots.mjs 要 film.json v2 的 shots: [{ id, in, out, module }]；整片渲染用 video.mjs');
  const selected = opts['--shots'] ? shotsByIds(film, opts['--shots']).sort((x, y) => x.in - y.in) : [...film.shots].sort((x, y) => x.in - y.in);
  const { size: { w, h }, fps: fpsReq, profile } = resolveOutputSpec({ opts, explicit, film });
  const intermediate = opts['--fast'] ? 'jpeg' : 'png';
  const cache = path.resolve(opts['--cache'] ?? path.join(dir, 'out', 'cache', 'shots'));
  const out = opts['--out'] ? path.resolve(opts['--out']) : null;
  const ff = preflight();
  fs.mkdirSync(cache, { recursive: true });
  cleanup(acquireLock(path.join(cache, 'shots')));
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); cleanup(acquireLock(out)); }
  const runJsonPath = path.resolve(opts['--run-json'] ?? (out ? `${out}.run.json` : path.join(cache, 'shots.run.json')));
  setRunJson(repoPath(ROOT, runJsonPath));
  const env = environment(ROOT, { ffmpegVersion: ff.version });
  const record = baseRecord({ command: 'shots', argv: process.argv.slice(1).map(a => (path.isAbsolute(a) ? repoPath(ROOT, a) : a)), env,
    projectId: film.id, shotId: selected.length === film.shots.length ? 'film' : selected.map(s => s.id).join(','), route: film.route, backend: film.backend ?? 'page' });
  record.profile = profile ? { id: profile.id, source: profile.source } : null;
  const t0 = Date.now();
  const live = new Set();
  const killAll = () => { for (const p of live) { try { p.kill('SIGKILL'); } catch {} } };
  process.on('exit', killAll);
  cleanup(() => process.removeListener('exit', killAll));
  let workDir = null;
  const finish = async (status, extra = {}) => {
    Object.assign(record, extra, { status, finishedAt: new Date().toISOString(), warnings: log.warnings });
    record.timing.totalSeconds = +((Date.now() - t0) / 1000).toFixed(2);
    record.selfCheck = await selfCheck(ROOT, record, { expectedFrameCount: record.output?.frames });
    writeRecord(runJsonPath, record);
  };
  writeRecord(runJsonPath, record);
  try {
    const slot = await acquireSlot({ slots: opts['--slots'] ?? slotCount(), wait: !opts['--no-wait'], timeoutMs: (opts['--wait-timeout'] ?? 1800) * 1000, signal, log });
    cleanup(slot);
    record.sharedGpu = await guardGpu({ enabled: !opts['--no-guard'], wait: !opts['--no-wait'], timeoutMs: (opts['--wait-timeout'] ?? 1800) * 1000, signal, log });
    const openOptions = {
      w, h, query: opts['--query'], gpu: opts['--gpu'], angle: opts['--angle'], allowNetwork: Boolean(opts['--allow-network']),
      lenientAssets: Boolean(opts['--lenient-assets']), allowGlErrors: Boolean(opts['--allow-gl-errors']), log,
      render: { fps: fpsReq, profile: profile?.id ?? null, frameCount: film.output?.frameCount ?? null },
    };
    if (opts['--ready-timeout']) openOptions.readyTimeoutMs = opts['--ready-timeout'] * 1000;
    const probeFilm = await openFilm(dir, { ...openOptions, handleSignals: false, signal });
    let handed = false;
    try {
      const FPS = decideFps({ requested: fpsReq, pageFps: probeFilm.contract.pageFps, anyFps: Boolean(opts['--any-fps']), log });
      const TOTAL = Math.round(probeFilm.contract.dur * FPS);
      if (Number.isInteger(film.output?.frameCount) && film.output.frameCount !== TOTAL) {
        throw new RenderError('contract-frame-count', `页面时长 ${probeFilm.contract.dur} 秒 × ${FPS} fps = ${TOTAL} 帧，与 film.json 的 ${film.output.frameCount} 帧不一致`, { exitCode: EXIT.CONTRACT });
      }
      for (const s of film.shots) if (s.out > TOTAL) throw new RenderError('film-shots', `镜头 ${s.id} 的 out=${s.out} 超出片长 ${TOTAL} 帧`, { exitCode: EXIT.CONTRACT });
      const crf = opts['--crf'] ?? profile?.video?.crf ?? 14, preset = opts['--preset'] ?? profile?.video?.preset ?? 'medium';
      const outputs = [{ kind: 'master', vf: COLOR[intermediate], args: [...x264Args({ crf, preset }), ...TAGS] }];
      const settle = opts['--settle'] === 'auto' ? (probeFilm.info.angle === 'vulkan' ? 'raf2' : 'none') : opts['--settle'];
      const filmLevel = stable(Object.fromEntries(Object.entries(film.raw).filter(([k]) => !NON_PICTURE.has(k))));
      const base = { r: rendererFingerprint(), w, h, FPS, profile: profile?.id ?? null, intermediate, outputs: outputs.map(x => [x.vf, x.args]), q: opts['--query'], settle, chunk: opts['--chunk'] ?? 'auto', filmLevel };
      const events = Array.isArray(film.raw.events) ? film.raw.events : [];
      const filmJsonRel = repoPath(ROOT, film.file);
      const exclusions = shotExclusions(ROOT, filmRel, film.shots);
      const keyOf = (s, deps) => sha256(JSON.stringify({
        base, shot: stable(s.raw), events: events.filter(e => e?.shot === s.id || (Number.isInteger(e?.frame) && e.frame >= s.in && e.frame < s.out)).map(stable),
        deps: [...deps].sort().map(p => [p, fileHash(p)]),
      }));
      Object.assign(record, {
        actualDevice: probeFilm.info.renderer || null, actualGraphicsBackend: `ANGLE ${probeFilm.info.angle}`, softwareFallback: probeFilm.info.software, gpu: probeFilm.info, page: probeFilm.contract,
        actualEncoder: `libx264 crf ${crf} preset ${preset}（${intermediate === 'png' ? '无损 PNG 截图' : 'JPEG q95 截图'} → yuv420p 有限范围 BT.709）`,
        render: { fps: FPS, width: w, height: h, workers: opts['--workers'], intermediate, settle, renderer: base.r },
      });
      record.tools.browser = probeFilm.info.browserVersion;

      // 1) 哪些镜头命中缓存
      const plan = [];
      for (const s of selected) {
        const meta = readJson(path.join(cache, `${s.id}.json`));
        let hit = false;
        if (meta && !opts['--force'] && meta.key && Array.isArray(meta.deps)) {
          const key = keyOf(s, meta.deps);
          const clip = path.join(cache, `${s.id}.${key.slice(0, 12)}.mp4`);
          hit = key === meta.key && fs.existsSync(clip) && (await probe(clip, { signal }).then(p => p.video?.frames === s.out - s.in).catch(() => false));
          if (hit) plan.push({ s, hit, clip, key, meta });
        }
        if (!hit) plan.push({ s, hit: false });
      }
      const misses = plan.filter(p => !p.hit);
      for (const p of plan) log.info(`${p.s.id}  [${p.s.in}, ${p.s.out})  ${p.hit ? '命中缓存，跳过' : opts['--force'] ? '强制重渲' : '要渲'}`);

      // 2) 渲没命中的镜头（所有镜头的块放进同一个队列）
      let rendered = null;
      if (misses.length) {
        const chunks = misses.flatMap(p => planFilmChunks(p.s.in, p.s.out, { shots: [p.s], chunk: opts['--chunk'] ?? 'auto', fps: FPS }));
        workDir = fs.mkdtempSync(path.join(cache, '.work-'));
        handed = true;
        const total = chunks.reduce((n, [a, b]) => n + (b - a), 0);
        let last = 0;
        rendered = await renderRange({
          dir, query: opts['--query'], w, h, fps: FPS, chunks, workers: opts['--workers'], intermediate, outputs, workDir, openOptions,
          firstFilm: probeFilm, signal, live, settle, frameTimeoutMs: opts['--frame-timeout'] ? opts['--frame-timeout'] * 1000 : undefined,
          onProgress: ({ done }) => {
            if (opts['--progress'] === 'none' || (Date.now() - last < 2000 && done < total)) return;
            last = Date.now();
            log.progress({ done, total }, `渲染 ${done}/${total} 帧（${Math.round((100 * done) / total)}%）`);
          },
        });
        const loaded = [...rendered.deps].filter(([, st]) => st < 400).map(([p]) => p).filter(p => p !== filmJsonRel);
        for (const p of misses) {
          const deps = loaded.filter(f => !exclusions.get(p.s.id)?.has(f));
          const key = keyOf(p.s, deps);
          const mine = chunks.map((c, i) => [c, rendered.files.master[i]]).filter(([[a, b]]) => a >= p.s.in && b <= p.s.out).map(([, f]) => f);
          const clip = path.join(cache, `${p.s.id}.${key.slice(0, 12)}.mp4`);
          await concatChunks(mine, clip, { expectFrames: p.s.out - p.s.in, signal, live, workDir });
          for (const old of fs.readdirSync(cache)) if (old.startsWith(`${p.s.id}.`) && old.endsWith('.mp4') && path.join(cache, old) !== clip) fs.rmSync(path.join(cache, old), { force: true });
          const hashes = Array.from({ length: p.s.out - p.s.in }, (_, k) => rendered.hashMap.get(p.s.in + k) ?? null);
          const meta = { key, shot: p.s.raw, frames: p.s.out - p.s.in, deps, hashes, sha256: await sha256File(clip), renderedAt: new Date().toISOString() };
          fs.writeFileSync(path.join(cache, `${p.s.id}.json.tmp`), JSON.stringify(meta, null, 1));
          fs.renameSync(path.join(cache, `${p.s.id}.json.tmp`), path.join(cache, `${p.s.id}.json`));
          Object.assign(p, { clip, key, meta });
        }
      } else {
        await probeFilm.close();
        handed = true;
      }
      record.shots = plan.map(p => ({ id: p.s.id, in: p.s.in, out: p.s.out, cached: p.hit, key: p.key.slice(0, 12), clip: repoPath(ROOT, p.clip), deps: p.meta.deps.length }));
      record.render.renderedFrames = rendered?.stats.renderedFrames ?? 0;
      record.render.perFrameMs = rendered?.stats.perFrameMs ?? null;
      record.network = { allowed: Boolean(opts['--allow-network']), external: rendered?.external ?? [] };
      const outputs2 = await Promise.all(plan.map(async p => ({ path: repoPath(ROOT, p.clip), sha256: p.meta.sha256 ?? await sha256File(p.clip), kind: 'shot', shot: p.s.id, cached: p.hit })));

      // 3) 拼成一部
      if (out) {
        workDir ??= fs.mkdtempSync(path.join(cache, '.work-'));
        const frames = plan.reduce((n, p) => n + (p.s.out - p.s.in), 0);
        const pr = await concatChunks(plan.map(p => p.clip), out, { expectFrames: frames, signal, live, workDir });
        const sha = await sha256File(out);
        record.output = { path: repoPath(ROOT, out), sha256: sha, width: pr.video.width, height: pr.video.height, fps: pr.video.fps, frames: pr.video.frames, duration: +(pr.video.frames / FPS).toFixed(6), codec: pr.video.codec, pixFmt: pr.video.pixFmt, color: pr.video.color };
        record.frameHashes = { algo: `sha256/16 of ${intermediate} capture`, first: plan[0].s.in, values: plan.flatMap(p => p.meta.hashes) };
        outputs2.push({ path: repoPath(ROOT, out), sha256: sha, kind: 'video' });
      }
      await finish('rendered');
      log.info(`完成：${plan.length} 个镜头（命中缓存 ${plan.filter(p => p.hit).length} 个，渲了 ${record.render.renderedFrames} 帧）${out ? `，拼成 ${repoPath(ROOT, out)}` : ''}  ${record.timing.totalSeconds}s`);
      return { outputs: outputs2.map(({ path: p, sha256: s, kind }) => ({ path: p, sha256: s, kind })), extra: { shots: record.shots } };
    } finally {
      if (!handed) await probeFilm.close();
    }
  } catch (e) {
    await finish('failed', { error: { code: e.code ?? 'internal', message: String(e.message), hint: e.hint ?? null, exitCode: e.exitCode ?? 1 } }).catch(() => {});
    throw e;
  } finally {
    killAll();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await runCli(SPEC, main);
