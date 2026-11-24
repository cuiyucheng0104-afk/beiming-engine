#!/usr/bin/env node
// 夜间加锁重建核验入口（tools/nightly/rebuild.mjs）：
// 启动真实页面宿主（beiming/host/page/host.mjs），对仓库带锁基准探针样片执行两次独立完整渲染，
// 调用 beiming/verify/controllability.mjs 的 runRebuildTest 逐帧逐位核对哈希并产出结构化 JSON 报告。
// 抽样前先按真实契约完整校验原始片子时间轴与实际渲染源锁；无头浏览器缺失或无法启动时直接 exit 3；
// 时间轴缺口、渲染源锁缺失、锁校验失败、渲染异常或任一帧哈希失配时 exit 1，绝不假绿。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
export const NIGHTLY_REBUILD_FORMAT = 'nightly-rebuild-report/0.1';
export const DEFAULT_FRAMES = 6;

const HELP = `北冥夜间加锁重建核验入口

用法：node tools/nightly/rebuild.mjs [--out <目录>] [--frames <N>] [--json] [--help]

选项：
  --out <目录>     输出结构化重建报告的目录（默认 out/nightly-rebuild）
  --frames <N>     抽检或完整渲染的总帧数（正整数，默认 6；最大为样片总帧数 107）
  --json           标准输出打印 JSON 报告
  --help, -h       打印本帮助信息

退出码：0 重建逐帧逐位一致；1 时间轴或渲染源锁不合规、哈希失配或渲染异常；2 命令行参数错误；3 无头浏览器缺失或无法启动`;

const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const loadRepoModule = (...segments) => {
  const target = path.join(REPO, ...segments);
  return import(pathToFileURL(target).href);
};

let contractsPromise = null;
function getContractValidator() {
  contractsPromise ??= loadRepoModule('beiming', 'kernel', 'contracts', 'validate.mjs').then((m) => m.loadContracts());
  return contractsPromise;
}

const N = '[^\\s，]+';
const NOT_PINNED_NON_RENDERING = Object.fromEntries(Object.entries({
  LK1: [`片子描述里有 ${N}，cards 里没有它绑的 ${N}`],
  LK8: [`predicates\\.base 引用了 ${N}，templates 里没有 ${N}`],
  LK9: [`style\\.view\\.scene 是 ${N}，view 里没有这个键`],
  LK10: ['片子描述有叠加层，cards 里没有 two-d\\.overlay'],
  D3: [`镜头 ${N} 的 ${N} 在锁文件 cards 里没有`, `资产 ${N} 在锁文件 assets 里没有`],
}).map(([id, list]) => [id, new RegExp(`^(?:${list.join('|')})$`)]));
const LK4_TOP_LEVEL_MISSING = /^镜头 ([^\s，]+) 的帧源 ([^\s，]+) 不在 sources 里$/;

function assetClashes(film, lock) {
  const stem = (ref) => ref.slice(0, ref.lastIndexOf('@') + 1);
  const pinned = Object.keys(lock.assets ?? {});
  return [...new Set([...(film.shots ?? []).flatMap((s) => Object.values(s.assets ?? {})), ...Object.values(film.assets ?? {})])]
    .filter((ref) => !pinned.includes(ref))
    .flatMap((ref) => pinned.filter((key) => stem(key) === stem(ref)).map((key) => `D3 资产 ${ref} 在锁里钉的是另一个版本 ${key}`));
}

function isAllowedPartialLockFinding(id, msg, film, allowPartialLock) {
  if (!allowPartialLock) return false;
  if (id === 'LK4') {
    // 绝不放行任何实际渲染源（renderingOf(shot)）缺失；仅允许带独立 renderer 的镜头顶层非出帧源缺失
    const m = LK4_TOP_LEVEL_MISSING.exec(msg);
    if (!m) return false;
    const shot = (film.shots ?? []).find((s) => s.id === m[1]);
    return Boolean(shot?.renderer && shot.source === m[2] && shot.renderer.source !== m[2]);
  }
  return Boolean(NOT_PINNED_NON_RENDERING[id]?.test(msg));
}

function loadRawProbeFixtures({ film: baseFilm, lock: baseLock } = {}) {
  const fixturesDir = path.join(REPO, 'beiming', 'kernel', 'conformance', 'fixtures');
  let rawFilm;
  let rawLock;
  try {
    rawFilm = baseFilm ?? JSON.parse(fs.readFileSync(path.join(fixturesDir, 'film.json'), 'utf8'));
    rawLock = baseLock ?? JSON.parse(fs.readFileSync(path.join(fixturesDir, 'lock.json'), 'utf8'));
  } catch (e) {
    throw Object.assign(new Error(`无法读取或解析探针样片与锁文件：${e.message}`), {
      code: 'rebuild.fixture-load-error',
      exitCode: 1,
    });
  }
  return { rawFilm, rawLock, fixturesDir };
}

function assertRawFilmTimeline(rawFilm) {
  if (!isPlainObj(rawFilm) || rawFilm.format !== 'film/3.0') {
    throw Object.assign(new Error('原始片子描述不是合法的 film/3.0 对象'), {
      code: 'rebuild.invalid-source-film',
      exitCode: 1,
    });
  }
  const total = rawFilm.output?.frames;
  if (!Number.isInteger(total) || total < 1) {
    throw Object.assign(new Error(`原始片子描述的 output.frames 非法：${String(total)}`), {
      code: 'rebuild.invalid-source-film',
      exitCode: 1,
    });
  }
  const shots = rawFilm.shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    throw Object.assign(new Error('原始片子描述缺少镜头列表'), {
      code: 'rebuild.invalid-source-film',
      exitCode: 1,
    });
  }
  const errors = [];
  if (shots[0]?.in !== 0) {
    errors.push(`第一个镜头 ${shots[0]?.id ?? '#0'} 的 in 是 ${shots[0]?.in}，不是 0`);
  }
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (!Number.isInteger(s?.in) || !Number.isInteger(s?.out) || !(s.in < s.out)) {
      errors.push(`镜头 ${s?.id ?? `#${i}`} 的 in ${s?.in} 不小于 out ${s?.out}`);
    }
    if (i > 0 && s?.in !== shots[i - 1]?.out) {
      errors.push(`镜头 ${s?.id ?? `#${i}`} 的 in 是 ${s?.in}，前一个镜头的 out 是 ${shots[i - 1]?.out}`);
    }
  }
  const last = shots.at(-1);
  if (last?.out !== total) {
    errors.push(`最后一个镜头 ${last?.id ?? ''} 的 out 是 ${last?.out}，output.frames 是 ${total}`);
  }
  if (errors.length > 0) {
    throw Object.assign(new Error(`原始片子描述时间轴不合 film/3.0 契约：${errors.join('；')}`), {
      code: 'rebuild.invalid-source-film',
      exitCode: 1,
    });
  }
}

/**
 * 读取并按指定帧数裁剪仓库锁定的探针样片与锁文件（beiming/kernel/conformance/fixtures/{film,lock}.json）。
 * 裁剪前先校验原始全量时间轴（起点、连续性、无缺口/重叠、总帧数边界），避免抽样改写掩盖原始缺口。
 */
export function prepareLockedProbeFilm({
  film: baseFilm,
  lock: baseLock,
  frames = DEFAULT_FRAMES,
  size = null,
} = {}) {
  const { rawFilm, rawLock, fixturesDir } = loadRawProbeFixtures({ film: baseFilm, lock: baseLock });
  const maxFrames = Number.isInteger(rawFilm?.output?.frames) && rawFilm.output.frames > 0
    ? rawFilm.output.frames
    : 107;

  if (!Number.isInteger(frames) || frames < 1 || frames > maxFrames) {
    throw Object.assign(
      new RangeError(`frames 必须是 1 到 ${maxFrames} 之间的整数，收到 ${String(frames)}`),
      { code: 'usage.invalid-frames', exitCode: 2 },
    );
  }

  assertRawFilmTimeline(rawFilm);

  const film = structuredClone(rawFilm);
  const lock = structuredClone(rawLock);

  if (frames === maxFrames && !size) {
    return { film, lock, fixturesDir };
  }

  film.output = {
    ...film.output,
    size: size ?? (frames < maxFrames ? [160, 90] : film.output.size),
    frames,
  };

  if (frames < film.shots.length) {
    const keptShots = film.shots.slice(0, frames);
    const keptIds = new Set(keptShots.map((s) => s.id));
    keptShots.forEach((shot, idx) => {
      shot.in = idx;
      shot.out = idx + 1;
    });
    film.shots = keptShots;
    film.events = (film.events ?? [])
      .filter((e) => keptIds.has(e.shot))
      .map((e) => {
        const shot = keptShots.find((s) => s.id === e.shot);
        return { ...e, frame: shot.in };
      });
    for (const key of Object.keys(lock.seeds ?? {})) {
      if (key !== 'film' && !keptIds.has(key)) delete lock.seeds[key];
    }
    for (const key of Object.keys(lock.shots ?? {})) {
      if (!keptIds.has(key)) delete lock.shots[key];
    }
  } else {
    const count = film.shots.length;
    film.shots.forEach((shot, idx) => {
      shot.in = Math.floor((idx * frames) / count);
      shot.out = Math.floor(((idx + 1) * frames) / count);
    });
    film.events = (film.events ?? []).map((e) => {
      const shot = film.shots.find((s) => s.id === e.shot);
      if (!shot) return e;
      const mid = shot.in + Math.floor((shot.out - shot.in) / 2);
      return { ...e, frame: Math.min(shot.out - 1, Math.max(shot.in, mid)) };
    });
  }

  return { film, lock, fixturesDir };
}

async function validateSourceFilmAndLock(rawFilm, rawLock, { allowPartialLock, renderingOf }) {
  const { validate } = await getContractValidator();
  const { checks: filmChecks } = await loadRepoModule('beiming', 'kernel', 'contracts', 'film', 'check.mjs');

  if (!isPlainObj(rawFilm) || rawFilm.format !== 'film/3.0') {
    throw Object.assign(new Error('原始片子描述不是合法的 film/3.0 对象'), {
      code: 'rebuild.invalid-source-film',
      exitCode: 1,
    });
  }
  const filmVerdict = validate(rawFilm);
  const filmErrors = [...filmVerdict.schemaErrors, ...Object.values(filmVerdict.violations).flat()];
  if (filmErrors.length > 0) {
    throw Object.assign(new Error(`原始片子描述不合 film/3.0 契约：${filmErrors.join('；')}`), {
      code: 'rebuild.invalid-source-film',
      exitCode: 1,
    });
  }

  if (!isPlainObj(rawLock) || rawLock.format !== 'lock/1.0') {
    throw Object.assign(new Error('锁文件不是合法的 lock/1.0 对象'), {
      code: 'rebuild.invalid-lock',
      exitCode: 1,
    });
  }
  const lockVerdict = validate(rawLock);
  const lockErrors = [...lockVerdict.schemaErrors, ...Object.values(lockVerdict.violations).flat()];
  if (lockErrors.length > 0) {
    throw Object.assign(new Error(`锁文件不合 lock/1.0 契约：${lockErrors.join('；')}`), {
      code: 'rebuild.invalid-lock',
      exitCode: 1,
    });
  }

  // 逐镜头核验实际渲染源（renderingOf(shot)）必须全部在 lock.sources 中锁定且宿主一致，禁止以 allowPartialLock 放行
  const rendererLockErrors = [];
  for (const shot of rawFilm.shots) {
    const effective = renderingOf(shot);
    const srcName = effective?.source;
    const expectedHost = effective?.host;
    const pinned = isPlainObj(rawLock.sources) && Object.hasOwn(rawLock.sources, srcName) ? rawLock.sources[srcName] : null;
    if (!pinned) {
      rendererLockErrors.push(`LK4 镜头 ${shot.id} 的实际渲染源 ${srcName} 不在 lock.sources 中`);
    } else if (pinned.host !== expectedHost) {
      rendererLockErrors.push(`LK4 镜头 ${shot.id} 的实际渲染源 ${srcName} 宿主是 ${expectedHost}，lock.sources.${srcName} 锁的是 ${pinned.host}`);
    }
  }
  if (rendererLockErrors.length > 0) {
    throw Object.assign(new Error(`锁文件缺少实际渲染源版本锁：${rendererLockErrors.join('；')}`), {
      code: 'rebuild.missing-renderer-source-lock',
      exitCode: 1,
    });
  }

  // 在抽样裁剪前先对原始 (rawFilm, rawLock) 做完整跨文件核对
  const cross = validate({ format: 'lock-check/0.1', lock: rawLock, film: rawFilm });
  const found = Object.entries({
    ...cross.violations,
    D3: filmChecks.D3({ format: 'film-check/0.1', film: rawFilm, lock: rawLock }),
  }).flatMap(([id, list]) => list.map((m) => [id, m]));
  const fatal = [
    ...cross.schemaErrors,
    ...found.filter(([id, m]) => !isAllowedPartialLockFinding(id, m, rawFilm, allowPartialLock)).map(([id, m]) => `${id} ${m}`),
    ...assetClashes(rawFilm, rawLock),
  ];
  if (fatal.length > 0) {
    throw Object.assign(new Error(`原始锁和片子描述对不上：${fatal.join('；')}`), {
      code: 'rebuild.lock-mismatch',
      exitCode: 1,
    });
  }
}

async function renderFilmOnPageHost({ source, film, lock, filmDir, shotInput }) {
  if (source?.caps?.id) {
    const pinned = isPlainObj(lock?.sources) && Object.hasOwn(lock.sources, source.caps.id) ? lock.sources[source.caps.id] : null;
    if (!pinned) {
      throw Object.assign(new Error(`页面宿主帧源 ${source.caps.id} 未在 lock.sources 中锁定`), {
        code: 'rebuild.missing-renderer-source-lock',
      });
    }
    if (pinned.host !== source.caps.host || pinned.version !== source.caps.version) {
      throw Object.assign(
        new Error(`页面宿主帧源 ${source.caps.id}@${source.caps.version}/${source.caps.host} 与锁 ${pinned.version}/${pinned.host} 不一致`),
        { code: 'rebuild.renderer-source-mismatch' },
      );
    }
  }
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'beiming-nightly-rebuild-'));
  try {
    const frames = [];
    const deliverables = {};
    for (const shot of film.shots) {
      const shotWorkspace = path.join(workspace, shot.id);
      const session = await source.open(shotInput(film, shot.id), {
        lock,
        tier: 'final',
        workspace: shotWorkspace,
        filmDir,
      });
      try {
        for (let f = shot.in; f < shot.out; f++) {
          const rendered = await session.render(f - shot.in, {}, ['color']);
          const { color } = rendered.layers;
          const bytes = await fs.promises.readFile(path.join(shotWorkspace, color.file));
          const floatColor = new Float32Array(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
          );
          frames.push({
            frame: f,
            shot: shot.id,
            width: color.shape[1],
            height: color.shape[0],
            channels: color.shape[2],
            color: floatColor,
          });
          deliverables[`${shot.id}/f${String(f).padStart(4, '0')}.color.f32`] = color.hash;
        }
      } finally {
        await session.close();
      }
    }
    return { frames, deliverables };
  } finally {
    await fs.promises.rm(workspace, { recursive: true, force: true });
  }
}

function cloneFrame(frame) {
  const Ctor = frame?.color?.constructor;
  const colorCopy = ArrayBuffer.isView(frame?.color)
    ? new Ctor(frame.color.buffer.slice(frame.color.byteOffset, frame.color.byteOffset + frame.color.byteLength))
    : Array.isArray(frame?.color)
      ? [...frame.color]
      : frame?.color;
  return { ...frame, color: colorCopy };
}

/**
 * 执行夜间加锁重建核验。
 * @param {object} [options]
 * @param {string|null} [options.outDir] 报告输出目录（默认 out/nightly-rebuild，传 null 不写盘）
 * @param {number} [options.frames] 渲染总帧数（默认 6）
 * @param {[number, number]} [options.size] 画幅尺寸覆盖
 * @param {object} [options.film] 自定义片子描述
 * @param {object} [options.lock] 自定义锁对象
 * @param {string} [options.filmDir] 页面宿主放行的镜头目录
 * @param {string} [options.tier] runRebuildTest 档位（默认 'hash-same-machine'）
 * @param {boolean} [options.allowPartialLock] 是否允许非渲染辅助锁项未钉全（默认 true；实际渲染源锁始终强制校验）
 * @param {boolean} [options.browserOk] 显式覆盖无头浏览器探测结果（供负对照测试注入）
 * @param {Function} [options.startSource] 自定义帧源启动函数（供测试注入）
 * @param {Function} [options.renderLocked] 自定义加锁渲染函数（供测试注入）
 * @param {Function} [options.perturb] 渲染扰动钩子 (film, info) => void（供负对照测试注入）
 */
export async function runNightlyRebuild(options = {}) {
  const startedAt = Date.now();
  const outDir = options.outDir === null ? null : path.resolve(options.outDir ?? path.join(REPO, 'out/nightly-rebuild'));
  const tier = options.tier ?? 'hash-same-machine';
  const allowPartialLock = options.allowPartialLock ?? true;

  const writeOut = (report) => {
    if (!outDir) return [];
    fs.mkdirSync(outDir, { recursive: true });
    const reportFile = path.join(outDir, 'report.json');
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return [reportFile];
  };

  const failReport = (exitCode, code, message, extra = {}) => {
    const report = {
      format: NIGHTLY_REBUILD_FORMAT,
      ok: false,
      pass: false,
      exitCode,
      command: 'tools/nightly/rebuild.mjs',
      wallMs: Date.now() - startedAt,
      frames: [],
      outputs: [],
      ...extra,
      error: { code, message, ...(extra.hint ? { hint: extra.hint } : {}) },
      createdAt: new Date().toISOString(),
    };
    delete report.hint;
    report.outputs = writeOut(report);
    return report;
  };

  const {
    runRebuildTest,
    compareFramePair,
    buildControllabilityRow,
    appendControllabilityRow,
  } = await loadRepoModule('beiming', 'verify', 'controllability.mjs');
  const { renderingOf, shotInput } = await loadRepoModule('beiming', 'kernel', 'eval', 'input.mjs');

  let prepared;
  try {
    const { rawFilm, rawLock } = loadRawProbeFixtures({ film: options.film, lock: options.lock });
    const requestedFrames = options.frames ?? DEFAULT_FRAMES;
    const maxFrames = Number.isInteger(rawFilm?.output?.frames) && rawFilm.output.frames > 0
      ? rawFilm.output.frames
      : 107;
    if (!Number.isInteger(requestedFrames) || requestedFrames < 1 || requestedFrames > maxFrames) {
      throw Object.assign(
        new RangeError(`frames 必须是 1 到 ${maxFrames} 之间的整数，收到 ${String(requestedFrames)}`),
        { code: 'usage.invalid-frames', exitCode: 2 },
      );
    }
    await validateSourceFilmAndLock(rawFilm, rawLock, { allowPartialLock, renderingOf });
    prepared = prepareLockedProbeFilm({
      film: rawFilm,
      lock: rawLock,
      frames: requestedFrames,
      size: options.size ?? null,
    });
  } catch (e) {
    return failReport(e.exitCode ?? 1, e.code ?? 'usage.bad-argument', e.message);
  }

  const { film, lock, fixturesDir } = prepared;
  const filmDir = options.filmDir ?? fixturesDir;

  if (!options.renderLocked) {
    let hasBrowser = options.browserOk;
    if (hasBrowser === undefined && !options.startSource && !process.env.BEIMING_CHROME) {
      const browserMod = await loadRepoModule('tests', 'ci', 'browser.mjs');
      hasBrowser = Boolean(browserMod.browserOk);
    }
    if (hasBrowser === false) {
      return failReport(
        3,
        'env.browser-missing',
        '无头浏览器不可用（playwright chromium-headless-shell 未安装），夜间重建不能跳过当绿灯',
        {
          filmId: film.id ?? null,
          tier,
          hint: '运行 ./node_modules/.bin/playwright-core install chromium-headless-shell 安装无头浏览器',
        },
      );
    }
  }

  const startSourceFn = options.startSource
    ?? (await loadRepoModule('beiming', 'host', 'page', 'host.mjs')).startSource;

  const capturedRuns = new Map();
  let browserLaunchError = null;

  const defaultRenderLocked = async (filmCopy, lockCopy, info) => {
    let source;
    try {
      source = await startSourceFn();
    } catch (e) {
      browserLaunchError = e;
      throw e;
    }
    try {
      if (typeof options.perturb === 'function') {
        options.perturb(filmCopy, info);
      }
      return await renderFilmOnPageHost({ source, film: filmCopy, lock: lockCopy, filmDir, shotInput });
    } finally {
      await source.stop();
    }
  };

  const baseRenderLocked = options.renderLocked ?? defaultRenderLocked;
  const wrappedRenderLocked = async (filmCopy, lockCopy, info) => {
    const out = await baseRenderLocked(filmCopy, lockCopy, info);
    const list = Array.isArray(out) ? out : Array.isArray(out?.frames) ? out.frames : null;
    if (list) {
      capturedRuns.set(info.run, list.map(cloneFrame));
    }
    return out;
  };

  let rebuildReport;
  try {
    rebuildReport = await runRebuildTest({
      film,
      lock,
      tier,
      allowPartialLock,
      renderLocked: wrappedRenderLocked,
    });
  } catch (e) {
    const isBrowserErr = browserLaunchError !== null;
    const exitCode = isBrowserErr ? 3 : 1;
    return failReport(
      exitCode,
      isBrowserErr ? 'env.browser-launch-failed' : (e.code ?? 'rebuild.execution-error'),
      isBrowserErr ? `无头浏览器或 three 页面宿主启动失败：${e.message}` : e.message,
      { filmId: film?.id ?? null, tier },
    );
  }

  const run1Frames = capturedRuns.get(1) ?? [];
  const run2Frames = capturedRuns.get(2) ?? [];
  const frameSummaries = [];
  for (let f = 0; f < rebuildReport.totalFrames; f++) {
    const a = run1Frames[f];
    const b = run2Frames[f];
    if (a && b) {
      const cmp = compareFramePair(a, b);
      frameSummaries.push({
        frame: f,
        shot: a.shot ?? b.shot ?? null,
        width: a.width,
        height: a.height,
        identical: cmp.identical,
        sha256Run1: `sha256:${cmp.sha256A}`,
        sha256Run2: `sha256:${cmp.sha256B}`,
        psnrDb: Number.isFinite(cmp.psnrDb) ? cmp.psnrDb : null,
        maxAbsDiff: cmp.maxAbsDiff,
        gt5Pixels: cmp.gt5Pixels,
        fracGt5: cmp.fracGt5,
      });
    }
  }

  const recordedAt = new Date().toISOString();
  const controllabilityRow = buildControllabilityRow({
    filmId: film.id,
    recordedAt,
    film,
    rebuild: rebuildReport,
  });

  const pass = Boolean(rebuildReport.pass && controllabilityRow.overallPass);
  const exitCode = pass ? 0 : 1;
  const report = {
    format: NIGHTLY_REBUILD_FORMAT,
    ok: pass,
    pass,
    exitCode,
    command: 'tools/nightly/rebuild.mjs',
    filmId: rebuildReport.filmId,
    tier: rebuildReport.tier,
    lockCheck: rebuildReport.lockCheck,
    totalFrames: rebuildReport.totalFrames,
    identicalFrames: rebuildReport.identicalFrames,
    failedFrames: [...rebuildReport.failedFrames],
    mismatchedDeliverables: [...rebuildReport.mismatchedDeliverables],
    wallMs: Date.now() - startedAt,
    frames: frameSummaries,
    rebuild: rebuildReport,
    controllabilityRow,
    outputs: [],
    error: pass
      ? null
      : {
          code: `rebuild.${rebuildReport.reason}`,
          message: `加锁重建未通过（reason=${rebuildReport.reason}，一致帧 ${rebuildReport.identicalFrames}/${rebuildReport.totalFrames}，失配帧 [${rebuildReport.failedFrames.join(', ')}]，失配交付件 [${rebuildReport.mismatchedDeliverables.join(', ')}]）`,
        },
    createdAt: recordedAt,
  };

  const outputs = writeOut(report);
  if (outDir) {
    const jsonlFile = path.join(outDir, 'controllability.jsonl');
    await appendControllabilityRow(jsonlFile, controllabilityRow);
    outputs.push(jsonlFile);
  }
  report.outputs = outputs;
  return report;
}

export function parseRebuildArgs(argv) {
  const opts = {
    outDir: path.join(REPO, 'out/nightly-rebuild'),
    frames: DEFAULT_FRAMES,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--out') {
      const val = argv[++i];
      if (!val || val.startsWith('-')) {
        throw Object.assign(new Error('--out 需要指定目录路径'), { exitCode: 2, code: 'usage.missing-out' });
      }
      opts.outDir = path.resolve(val);
    } else if (arg === '--frames') {
      const val = argv[++i];
      if (!val || !/^\d+$/.test(val)) {
        throw Object.assign(new Error('--frames 需要指定正整数'), { exitCode: 2, code: 'usage.invalid-frames' });
      }
      opts.frames = Number.parseInt(val, 10);
    } else {
      throw Object.assign(new Error(`未知参数：${arg}`), { exitCode: 2, code: 'usage.unknown-option' });
    }
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseRebuildArgs(argv);
  } catch (e) {
    const code = e.exitCode ?? 2;
    const errObj = {
      format: NIGHTLY_REBUILD_FORMAT,
      ok: false,
      pass: false,
      exitCode: code,
      command: 'tools/nightly/rebuild.mjs',
      error: { code: e.code ?? 'usage.bad-args', message: e.message, hint: '运行 node tools/nightly/rebuild.mjs --help 查看用法' },
    };
    process.stdout.write(`${JSON.stringify(errObj, null, 2)}\n`);
    process.stderr.write(`${e.message}\n`);
    return code;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const report = await runNightlyRebuild({
    outDir: opts.outDir,
    frames: opts.frames,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.stderr.write(`夜间重建未通过（exit ${report.exitCode}）：${report.error?.message ?? '原因不明'}\n`);
  } else {
    process.stderr.write(
      `夜间重建通过（${report.filmId}）：${report.identicalFrames}/${report.totalFrames} 帧逐位一致，耗时 ${report.wallMs} ms\n`,
    );
  }
  return report.exitCode;
}

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const code = await main();
  process.exit(code);
}
