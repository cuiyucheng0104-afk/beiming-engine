import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { tools, verifyDeliveryBundle } from '../comp/index.mjs';
import fixSchema from '../kernel/contracts/patch/schema/fix.schema.json' with { type: 'json' };
import verdictSchema from '../kernel/contracts/predicates/schema/verdict.schema.json' with { type: 'json' };
import { DEFAULT_MAX_ALIAS_EDGE, DEFAULT_MAX_NOISE_RESIDUAL } from '../verify/index.mjs';
import { estimateTokens, issueAccountToken, openApiText, ROUTES, startServer } from './index.mjs';
import { layerL3, measureMaster, writeVerification } from './pipeline.mjs';

const checkVerdict = new Ajv2020({ strict: false }).addSchema(fixSchema).compile(verdictSchema);

function pageMediaSkip() {
  const { ffmpeg, ffprobe } = tools();
  for (const [name, bin, args] of [['ffmpeg', ffmpeg, ['-version']], ['ffprobe', ffprobe, ['-version']]]) {
    if (!bin || spawnSync(bin, args, { stdio: 'ignore', timeout: 20000 }).status !== 0) return `缺少可执行的 ${name}`;
  }
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  if (spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 30000 }).status !== 0) return '无头浏览器不可执行';
  return false;
}

function encodeRawGray(filePath, width, height, frames, { fps = 24, crf = 16 } = {}) {
  const buf = Buffer.alloc(frames.length * width * height);
  for (let t = 0; t < frames.length; t++) buf.set(frames[t], t * width * height);
  const res = spawnSync('ffmpeg', [
    '-nostdin', '-hide_banner', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv',
    filePath,
  ], { input: buf });
  assert.equal(res.status, 0, res.stderr.toString());
}

function makeThinRodFrame(width, height, samples, { slope = 0.45, halfWidth = 0.75 } = {}) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (Math.abs(px - (width * 0.35 + slope * py)) < halfWidth) hit++;
        }
      }
      out[y * width + x] = Math.round(25 + (205 * hit) / (samples * samples));
    }
  }
  return out;
}

function makeSyntheticFilm(over = {}) {
  return {
    format: 'film/3.0',
    id: 'energy-gate-test',
    output: { size: [320, 180], fps: '24/1', frames: 12 },
    shots: [
      { id: 's01', in: 0, out: 12, source: 'three', host: 'page', mode: 'cards-data', colorRef: 'display', roles: { hero: 'title' } },
    ],
    style: { view: { scene: 'agx-mhc', display: 'srgb' }, tokens: { ink: '#F4F0E9' } },
    predicates: { base: ['floor@1'] },
    delivery: { master: 'h264-high', web: true, contact: true },
    ...over,
  };
}

function makeValidFrames(w = 320, h = 180) {
  const bbox = [80, 50, 240, 130];
  const pxArea = ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) / (w * h);
  return [0, 6, 11].map((frame) => ({
    frame,
    meta: {
      frame,
      size: [w, h],
      colorRef: 'display',
      entities: [{ id: 1, name: 'title', class: 'text', role: 'hero', bbox2d: bbox, visible: 1, pxArea }],
      texts: [],
    },
  }));
}

test('API 合同与 OpenAPI：observe-metrics 枚举含 noiseResidual 与 aliasEdge，openapi.json 逐字节一致', () => {
  const route = ROUTES.find((r) => r.id === 'observe-metrics');
  assert.ok(route);
  const itemsEnum = route.request.properties.metrics.items.enum;
  assert.ok(itemsEnum.includes('noiseResidual'));
  assert.ok(itemsEnum.includes('aliasEdge'));
  const disk = readFileSync(new URL('./openapi.json', import.meta.url), 'utf8');
  assert.equal(disk, openApiText());
});

test('layerL3 语义：显式更严约束不重复、显式更松约束不能绕过默认门、无边缘跳过不拖垮 basePass、无成片量测不误触发', () => {
  const film = makeSyntheticFilm();
  const baseMeasured = {
    output: { size: [320, 180], fps: '24/1', frames: 12, colorTag: 'bt709' },
    blackFrames: [],
    freezes: [],
    cuts: [],
    frames: makeValidFrames(),
  };
  const entities = { s01: ['title'] };

  // 1. 无成片量测（如 deliver 前的 verify）：不触发默认画质门
  const preDeliver = layerL3({ film, measured: { frames: baseMeasured.frames }, question: null, entities });
  assert.equal(preDeliver.verdicts.some((v) => v.id === 'pred.noise_residual' || v.id === 'pred.alias_edge'), false);

  // 2. 纯色无边缘片：alias_edge 记为 conditionalSkips，不拖垮 basePass
  const flatRes = layerL3({
    film,
    measured: {
      ...baseMeasured,
      noiseResidual: { value: 0.05, status: 'ok', unit: 'code8' },
      aliasEdge: { value: 0, status: 'no-edges', unit: 'px' },
    },
    question: null,
    entities,
  });
  assert.equal(flatRes.ok, true);
  assert.equal(flatRes.basePass, true);
  const flatAlias = flatRes.verdicts.find((v) => v.id === 'pred.alias_edge');
  assert.equal(flatAlias.status, 'skipped');
  assert.ok(flatAlias.reason);
  for (const v of flatRes.verdicts) assert.ok(checkVerdict(v), JSON.stringify(checkVerdict.errors));

  // 3. film.predicates.extra 显式写更严阈值：base 默认门与 extra 独立生效，extra 越界判 ok=false，同时超默认门时 basePass 也必须为 false
  const strictFilm = makeSyntheticFilm({
    predicates: { base: ['floor@1'], extra: ['noise_residual(film) <= 1.0', 'alias_edge(film) <= 0.3'] },
  });
  const strictRes = layerL3({
    film: strictFilm,
    measured: {
      ...baseMeasured,
      noiseResidual: { value: 2.0, status: 'ok', unit: 'code8' },
      aliasEdge: { value: 0.5, status: 'ok', unit: 'px' },
    },
    question: null,
    entities,
  });
  assert.equal(strictRes.ok, false);
  assert.equal(strictRes.basePass, true);
  assert.equal(strictRes.verdicts.filter((v) => v.id === 'pred.noise_residual' && v.base).length, 1);
  assert.equal(strictRes.verdicts.filter((v) => v.id === 'pred.alias_edge' && v.base).length, 1);
  assert.equal(strictRes.verdicts.find((v) => v.id === 'pred.noise_residual' && !v.base).status, 'fail');
  assert.equal(strictRes.verdicts.find((v) => v.id === 'pred.alias_edge' && !v.base).status, 'fail');

  // 3b. R1 回归：当实测同时超过 extra 上限与默认 base 上限时，basePass 必须为 false（extra 不得遮蔽 base 违例）
  const bothFailRes = layerL3({
    film: makeSyntheticFilm({ predicates: { base: ['floor@1'], extra: ['alias_edge(film) <= 1'] } }),
    measured: {
      ...baseMeasured,
      aliasEdge: { value: 2.0, status: 'ok', unit: 'px' },
    },
    question: null,
    entities,
  });
  assert.equal(bothFailRes.ok, false);
  assert.equal(bothFailRes.basePass, false);
  assert.ok(bothFailRes.verdicts.some((v) => v.id === 'pred.alias_edge' && v.base && v.status === 'fail'));

  // 4. film.predicates.extra 试图写更松阈值：默认 L3 门仍拦截，不能借 extra 放宽
  const looseFilm = makeSyntheticFilm({
    predicates: { base: ['floor@1'], extra: ['noise_residual(film) <= 99', 'alias_edge(film) <= 99'] },
  });
  const looseRes = layerL3({
    film: looseFilm,
    measured: {
      ...baseMeasured,
      noiseResidual: { value: DEFAULT_MAX_NOISE_RESIDUAL + 1.5, status: 'ok', unit: 'code8' },
      aliasEdge: { value: DEFAULT_MAX_ALIAS_EDGE + 0.8, status: 'ok', unit: 'px' },
    },
    question: null,
    entities,
  });
  assert.equal(looseRes.ok, false);
  assert.equal(looseRes.basePass, false);
  assert.ok(looseRes.verdicts.some((v) => v.id === 'pred.noise_residual' && v.base && v.status === 'fail'));
  assert.ok(looseRes.verdicts.some((v) => v.id === 'pred.alias_edge' && v.base && v.status === 'fail'));

  // 5. question.basePredicates 显式声明同名谓词（含 @ all 与等价全片区间 @ [0,12)）：不重复添加默认条目
  const qRes = layerL3({
    film,
    measured: {
      ...baseMeasured,
      noiseResidual: { value: 0.8, status: 'ok', unit: 'code8' },
      aliasEdge: { value: 0.2, status: 'ok', unit: 'px' },
    },
    question: { basePredicates: ['noise_residual(film) <= 2.0'] },
    entities,
  });
  assert.equal(qRes.ok, true);
  assert.equal(qRes.verdicts.filter((v) => v.id === 'pred.noise_residual').length, 1);
  assert.equal(qRes.verdicts.filter((v) => v.id === 'pred.alias_edge').length, 1);

  const qAll = layerL3({
    film,
    measured: { ...baseMeasured, aliasEdge: { value: 0.8, status: 'ok', unit: 'px' } },
    question: { basePredicates: ['alias_edge(film) <= 1 @ all'] },
    entities,
  });
  const qRange = layerL3({
    film,
    measured: { ...baseMeasured, aliasEdge: { value: 0.8, status: 'ok', unit: 'px' } },
    question: { basePredicates: ['alias_edge(film) <= 1 @ [0,12)'] },
    entities,
  });
  assert.equal(qAll.ok, true);
  assert.equal(qRange.ok, true);
  assert.equal(qRange.verdicts.filter((v) => v.id === 'pred.alias_edge').length, 1);
});

const skipMedia = pageMediaSkip();

test('端到端：合规真成片过 deliver L3 门、POST /observe/metrics 查两把尺子，带噪与 1x 锯齿负对照被 L3 门拦下且 report.ok === false', { skip: skipMedia, timeout: 300000 }, async () => {
  const tempVar = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
  const prevTemp = process.env[tempVar];
  const root = mkdtempSync(join(tmpdir(), 'beiming-energy-api-'));
  process.env[tempVar] = root;
  const account = issueAccountToken(root);
  const api = await startServer({ dataDir: root, port: 0, reviewer: null });

  const call = async (method, path, token, body, expected = 200) => {
    const res = await fetch(api.url + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const env = JSON.parse(text);
    if (expected !== null) {
      assert.equal(res.status, expected, `${method} ${path}: ${text}`);
      assert.equal(env.ok, expected === 200, `${method} ${path}: ${text}`);
    }
    return { env, text, status: res.status };
  };

  const runDeliver = async (filmId, token) => {
    let { env } = await call('POST', `/v1/films/${filmId}/deliver`, token, { wait: 30 }, null);
    while (['queued', 'running'].includes(env.data.status)) {
      ({ env } = await call('GET', `/v1/jobs/${env.data.job}?wait=30`, token, undefined, null));
    }
    const full = env.outputs?.find((o) => o.kind === 'response');
    if (full) {
      const res = await fetch(api.url + full.url, { headers: { authorization: `Bearer ${token}` } });
      env = await res.json();
    }
    return env;
  };

  try {
    // 1. 合规真渲染成片过 deliver L3 门
    const created = (await call('POST', '/v1/films', account, {
      template: 'title',
      text: 'BEIMING',
      output: { size: [640, 360], fps: '24/1', frames: 12 },
    })).env.data;
    const base = `/v1/films/${created.film}`;

    const deliverEnv = await runDeliver(created.film, created.token);
    assert.equal(deliverEnv.ok, true, JSON.stringify(deliverEnv));
    assert.equal(deliverEnv.data.status, 'succeeded');
    assert.equal(deliverEnv.data.layers.L3.ok, true);
    assert.equal(deliverEnv.data.layers.L3.basePass, true);
    assert.deepEqual(deliverEnv.data.failed, []);

    const bundleDir = join(root, 'films', created.film, 'deliver', deliverEnv.data.job, 'bundle');
    const report = JSON.parse(readFileSync(join(bundleDir, 'report.json'), 'utf8'));
    assert.equal(report.ok, true);
    assert.equal(report.verification.ok, true);
    const noiseVerdict = report.verification.verdicts.find((v) => v.id === 'pred.noise_residual');
    const aliasVerdict = report.verification.verdicts.find((v) => v.id === 'pred.alias_edge');
    assert.equal(noiseVerdict?.status, 'pass');
    assert.equal(noiseVerdict?.base, true);
    assert.ok(typeof noiseVerdict?.value === 'number' && noiseVerdict.value <= DEFAULT_MAX_NOISE_RESIDUAL);
    assert.equal(aliasVerdict?.status, 'pass');
    assert.equal(aliasVerdict?.base, true);
    assert.ok(typeof aliasVerdict?.value === 'number' && aliasVerdict.value <= DEFAULT_MAX_ALIAS_EDGE);
    for (const v of report.verification.verdicts) assert.ok(checkVerdict(v), JSON.stringify(checkVerdict.errors));

    // 2. POST /observe/metrics 查询两把尺子，带细节且在 600 token 预算内
    const { env: metricsEnv, text: metricsText } = await call('POST', `${base}/observe/metrics`, created.token, {
      metrics: ['noiseResidual', 'aliasEdge'],
    });
    assert.ok(estimateTokens(metricsText) <= 600, `observe-metrics tokens=${estimateTokens(metricsText)}`);
    assert.equal(metricsEnv.data.expectedCount, 2);
    assert.equal(metricsEnv.data.actualCount, 2);
    const nrItem = metricsEnv.data.items.find((i) => i.metric === 'noiseResidual');
    const aeItem = metricsEnv.data.items.find((i) => i.metric === 'aliasEdge');
    assert.equal(nrItem.unit, 'code8');
    assert.equal(nrItem.details.status, 'ok');
    assert.equal(nrItem.details.sampledFrames, 12);
    assert.equal(nrItem.details.totalFrames, 12);
    assert.ok(nrItem.value <= DEFAULT_MAX_NOISE_RESIDUAL);

    assert.equal(aeItem.unit, 'px');
    assert.equal(aeItem.details.status, 'ok');
    assert.equal(aeItem.details.flickerUnit, 'code8');
    assert.equal(aeItem.details.sampledFrames, 12);
    assert.ok(aeItem.value <= DEFAULT_MAX_ALIAS_EDGE);

    // 3. 真视频负对照 A：noise=alls=8 加噪视频经真实 measureMaster -> layerL3 -> writeVerification 拦下
    const noisyFile = join(root, 'neg-noisy.mp4');
    const mkNoisy = spawnSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=24:d=0.5',
      '-vf', 'noise=alls=8:allf=t',
      '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv',
      noisyFile,
    ]);
    assert.equal(mkNoisy.status, 0, mkNoisy.stderr.toString());

    const noisyMeasured = await measureMaster(noisyFile);
    assert.equal(noisyMeasured.noiseResidual.status, 'ok');
    assert.ok(noisyMeasured.noiseResidual.value > DEFAULT_MAX_NOISE_RESIDUAL, `noisy=${noisyMeasured.noiseResidual.value}`);

    const synthFilm = makeSyntheticFilm();
    const noisyL3 = layerL3({
      film: synthFilm,
      measured: { ...noisyMeasured, blackFrames: [], freezes: [], cuts: [], frames: makeValidFrames() },
      question: null,
      entities: { s01: ['title'] },
    });
    assert.equal(noisyL3.ok, false);
    assert.equal(noisyL3.basePass, false);
    const noisyPred = noisyL3.verdicts.find((v) => v.id === 'pred.noise_residual');
    assert.equal(noisyPred?.status, 'fail');
    assert.ok(noisyPred.value > DEFAULT_MAX_NOISE_RESIDUAL);
    assert.match(noisyPred.expected, new RegExp(String(DEFAULT_MAX_NOISE_RESIDUAL)));
    const noisyDiag = noisyL3.diagnostics.find((d) => d.message.includes('noise_residual'));
    assert.ok(noisyDiag, JSON.stringify(noisyL3.diagnostics));
    assert.ok(noisyDiag.value > DEFAULT_MAX_NOISE_RESIDUAL);
    assert.ok(noisyDiag.expected);
    assert.ok(noisyDiag.hint);

    const noisyBundle = join(root, 'bundle-noisy');
    cpSync(bundleDir, noisyBundle, { recursive: true });
    writeVerification(noisyBundle, {
      format: 'api-verification/0.1',
      rev: 1,
      tier: 'final',
      ok: false,
      layers: { L1: { ok: true, errors: 0 }, L2: { ok: true }, L3: { ok: noisyL3.ok, basePass: noisyL3.basePass, summary: noisyL3.summary } },
      verdicts: noisyL3.verdicts,
      L5: { status: 'not-run', opinions: [] },
      diagnostics: noisyL3.diagnostics,
    });
    const noisyReport = JSON.parse(readFileSync(join(noisyBundle, 'report.json'), 'utf8'));
    assert.equal(noisyReport.ok, false);
    assert.equal(noisyReport.verification.ok, false);
    assert.ok(verifyDeliveryBundle(noisyBundle).files['report.json']);

    // 4. 真视频负对照 B：1x 点采样锯齿斜细杆视频经真实 measureMaster -> layerL3 -> writeVerification 拦下
    const aliasedFile = join(root, 'neg-aliased.mp4');
    const aliasedFrame = makeThinRodFrame(320, 180, 1, { slope: 0.45, halfWidth: 0.75 });
    encodeRawGray(aliasedFile, 320, 180, Array.from({ length: 12 }, () => aliasedFrame));

    const aliasedMeasured = await measureMaster(aliasedFile);
    assert.equal(aliasedMeasured.aliasEdge.status, 'ok');
    assert.ok(aliasedMeasured.aliasEdge.value > DEFAULT_MAX_ALIAS_EDGE, `aliased=${aliasedMeasured.aliasEdge.value}`);

    const aliasedL3 = layerL3({
      film: synthFilm,
      measured: { ...aliasedMeasured, blackFrames: [], freezes: [], cuts: [], frames: makeValidFrames() },
      question: null,
      entities: { s01: ['title'] },
    });
    assert.equal(aliasedL3.ok, false);
    assert.equal(aliasedL3.basePass, false);
    const aliasedPred = aliasedL3.verdicts.find((v) => v.id === 'pred.alias_edge');
    assert.equal(aliasedPred?.status, 'fail');
    assert.ok(aliasedPred.value > DEFAULT_MAX_ALIAS_EDGE);
    assert.match(aliasedPred.expected, new RegExp(String(DEFAULT_MAX_ALIAS_EDGE)));
    const aliasedDiag = aliasedL3.diagnostics.find((d) => d.message.includes('alias_edge'));
    assert.ok(aliasedDiag, JSON.stringify(aliasedL3.diagnostics));
    assert.ok(aliasedDiag.value > DEFAULT_MAX_ALIAS_EDGE);
    assert.ok(aliasedDiag.expected);
    assert.ok(aliasedDiag.hint);

    const aliasedBundle = join(root, 'bundle-aliased');
    cpSync(bundleDir, aliasedBundle, { recursive: true });
    writeVerification(aliasedBundle, {
      format: 'api-verification/0.1',
      rev: 1,
      tier: 'final',
      ok: false,
      layers: { L1: { ok: true, errors: 0 }, L2: { ok: true }, L3: { ok: aliasedL3.ok, basePass: aliasedL3.basePass, summary: aliasedL3.summary } },
      verdicts: aliasedL3.verdicts,
      L5: { status: 'not-run', opinions: [] },
      diagnostics: aliasedL3.diagnostics,
    });
    const aliasedReport = JSON.parse(readFileSync(join(aliasedBundle, 'report.json'), 'utf8'));
    assert.equal(aliasedReport.ok, false);
    assert.equal(aliasedReport.verification.ok, false);

    // 5. 端到端 HTTP deliver 拦截：写更严 alias_edge(film) <= 0.05 时，deliver 本身返回 ok: false 且 report.ok === false
    const curFilm = (await call('GET', `${base}/film`, created.token)).env.data;
    await call('PUT', `${base}/film`, created.token, {
      format: 'patch/0.1',
      rev: curFilm.rev,
      ops: [{ op: 'set', path: 'predicates/extra', value: ['alias_edge(film) <= 0.05'] }],
    });
    const strictDeliver = await runDeliver(created.film, created.token);
    assert.equal(strictDeliver.ok, false);
    assert.equal(strictDeliver.data.layers.L3.ok, false);
    assert.ok(strictDeliver.data.failed.includes('pred.alias_edge'));
    assert.ok(strictDeliver.diagnostics.some((d) => d.message.includes('alias_edge') && d.expected && d.hint));
    const strictBundle = join(root, 'films', created.film, 'deliver', strictDeliver.data.job, 'bundle');
    const strictReport = JSON.parse(readFileSync(join(strictBundle, 'report.json'), 'utf8'));
    assert.equal(strictReport.ok, false);
    assert.equal(strictReport.verification.ok, false);
    assert.equal(strictReport.verification.verdicts.filter((v) => v.id === 'pred.alias_edge' && v.base).length, 1);
    assert.equal(strictReport.verification.verdicts.filter((v) => v.id === 'pred.alias_edge' && !v.base && v.status === 'fail').length, 1);
    for (const v of strictReport.verification.verdicts) assert.ok(checkVerdict(v), JSON.stringify(checkVerdict.errors));

    // 6. R1 回归：6x64 合法小画幅调 measureMaster 不得静默丢弃 noiseResidual
    const smallMp4 = join(root, 'small-6x64.mp4');
    const rSmall = spawnSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=gray:s=6x64:r=24', '-frames:v', '3',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', smallMp4,
    ]);
    assert.equal(rSmall.status, 0, String(rSmall.stderr));
    const smallMeasured = await measureMaster(smallMp4);
    assert.ok(Object.hasOwn(smallMeasured, 'noiseResidual'));
    assert.equal(smallMeasured.noiseResidual.status, 'ok');
  } finally {
    await api.close();
    if (prevTemp === undefined) delete process.env[tempVar];
    else process.env[tempVar] = prevTemp;
    rmSync(root, { recursive: true, force: true });
  }
});
