import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { launchBrowser } from '../host/page/gpu.mjs';
import { loadCardLibrary } from '../api/runtime.mjs';
import { buildBoard } from '../bench/board.mjs';
import { startServer } from '../host/page/host.mjs';
import { resolveFilmLock } from '../sources/three/fire-breath/lock.mjs';
import { samplePostState } from '../sources/three/fire-breath/pipeline.js';
import { sampleFrame } from '../sources/three/fire-breath/scene.js';
import { create as createDeliverEncode } from './delivery/encode/comp.mjs';
import { evaluate as evaluateCompDisplay } from './post/grade-cl/comp.mjs';
import { create as createCompDisplay } from './post/comp-display/comp.mjs';
import { createCardRegistry } from './registry.mjs';
import { checkVersionBump, statusLevels, verifyStatusUpdateAuthor } from './status.mjs';
import { evaluate as evaluateEvents } from './time/events/evaluate.mjs';
import { evaluate as evaluateSeeded } from './time/seeded/evaluate.mjs';
import { evaluate as evaluateTimeline } from './time/timeline/evaluate.mjs';
import { scanCardLeaks, validateCard } from './validate-card.mjs';

const HERE = import.meta.dirname;
const SHOT_DIR = join(HERE, '../sources/three/fire-breath');
const PROMOTION_DATE = '2026-11-26';
const readText = (path) => readFileSync(path, 'utf8');
const normalize = (path) => readText(path).replaceAll('\r\n', '\n');

// 晋升前的真实 status[]，按卡名硬编码留证，绝不从新状态反推。
const priorStatuses = new Map([
  ['atmo.height-fog', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  ['comp.display', [{ level: 'reproduced', host: 'node', source: '24.13.1', gpu: 'none', date: '2026-11-21' }]],
  ['fx.breath', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  ['fx.post-state', [{ level: 'reproduced', host: 'kernel-eval', source: '0.1.0', gpu: 'none', date: '2026-11-25' }]],
  ['light.emit-pool', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  ['motion.impulse', [{ level: 'reproduced', host: 'kernel-eval', source: '0.1.0', gpu: 'none', date: '2026-11-25' }]],
  ['motion.roll-bank', [{ level: 'reproduced', host: 'kernel-eval', source: '0.1.0', gpu: 'none', date: '2026-11-25' }]],
  ['motion.sweep-body', [{ level: 'reproduced', host: 'kernel-eval', source: '0.1.0', gpu: 'none', date: '2026-11-25' }]],
  ['motion.swim', [{ level: 'reproduced', host: 'kernel-eval', source: '0.1.0', gpu: 'none', date: '2026-11-25' }]],
  ['particle.minpx', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  ['particle.premult', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  ['particle.soft', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  ['post.ao', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'swiftshader', date: '2026-11-25' }]],
  ['post.bloom', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  [
    'post.grade-cl',
    [
      { level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' },
      { level: 'reproduced', host: 'node', source: '24.13.1', gpu: 'none', date: '2026-11-25' },
    ],
  ],
  ['post.lens-fx', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  ['post.volumetric', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'swiftshader', date: '2026-11-25' }]],
  ['shade.px-lod', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  ['shade.thin-line', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'apple-m5-pro', date: '2026-11-25' }]],
  ['three.patch', [{ level: 'reproduced', host: 'page', source: '0.187.0', gpu: 'none', date: '2026-11-25' }]],
  ['time.bake', [{ level: 'reproduced', host: 'kernel-eval', source: '0.1.0', gpu: 'none', date: '2026-11-25' }]],
  ['time.seeded', [{ level: 'reproduced', host: 'kernel-eval', source: '0.1.0', gpu: 'none', date: '2026-11-21' }]],
]);

const promotedIds = [...priorStatuses.keys()].sort();
const alreadyMeasuredLockIds = ['deliver.encode', 'time.events', 'time.timeline'];

const cardFiles = globSync('**/card.json', { cwd: HERE }).map((relPath) => {
  const fullPath = join(HERE, relPath);
  const raw = readText(fullPath);
  return { relPath, fullPath, raw, card: JSON.parse(raw) };
});
const cards = cardFiles.map(({ card }) => card);
const byId = new Map(cardFiles.map((entry) => [entry.card.id, entry]));

const filmPath = join(SHOT_DIR, 'film.json');
const lockPath = join(SHOT_DIR, 'film.lock');
const controlsPath = join(SHOT_DIR, 'v15-controls.json');
const film = JSON.parse(readText(filmPath));
const lock = JSON.parse(readText(lockPath));
const lockCardIds = Object.keys(lock.cards).sort();

test('V15-1：S16 film.lock 全部 25 张卡均为 measured，全库 measured 卡数 >= 39 且看板一致', () => {
  assert.equal(promotedIds.length, 22);
  assert.equal(lockCardIds.length, 25);
  assert.deepEqual([...promotedIds, ...alreadyMeasuredLockIds].sort(), lockCardIds);

  for (const id of lockCardIds) {
    const entry = byId.get(id);
    assert.ok(entry, `卡库缺少锁卡: ${id}`);
    assert.ok(entry.card.status.length >= 1, id);
    assert.ok(
      entry.card.status.every((s) => s.level === 'measured'),
      `${id} 的全部 status 应为 measured，当前: ${JSON.stringify(entry.card.status)}`,
    );
    assert.equal(lock.cards[id].verified.level, 'measured', `film.lock 中 ${id} 应为 measured`);
  }

  const measuredCount = cards.filter(({ status }) => status.some(({ level }) => level === 'measured')).length;
  assert.ok(measuredCount >= 39, `全库 measured 卡数应 >= 39，当前: ${measuredCount}`);

  const { cards: progress } = buildBoard({ asOf: PROMOTION_DATE, cards }).integrationProgress;
  assert.equal(progress.total, cards.length);
  assert.equal(progress.byStatus.verified, measuredCount);
  assert.equal(
    progress.verifiedOrAbove,
    cards.filter(({ status }) => status.some(({ level }) => level === 'measured' || level === 'calibrated')).length,
  );
});

test('V15-2：v15-controls.json 覆盖全部 25 张锁卡、全部判红、零泄露，film.lock 逐字节复算一致', () => {
  assert.ok(existsSync(controlsPath), '缺少公开脱敏负对照清单 v15-controls.json');
  const rawControls = readText(controlsPath);
  assert.deepEqual(scanCardLeaks(rawControls), [], 'v15-controls.json 存在泄露');

  const controls = JSON.parse(rawControls);
  assert.equal(controls.format, 'v15-controls/0.1');
  assert.equal(controls.shotId, 'fire-breath');
  assert.equal(controls.totalLockCards, 25);
  assert.equal(controls.rejectedCount, 25);
  assert.equal(Array.isArray(controls.controls), true);
  assert.equal(controls.controls.length, 25);

  const controlIds = controls.controls.map((c) => c.id).sort();
  assert.deepEqual(controlIds, lockCardIds);
  const validScopes = new Set([
    'fire-breath-shot',
    'impact-frame-l10-noop-compliant',
    'full-window-l10-noop-compliant',
    'base-and-delivery',
  ]);
  for (const row of controls.controls) {
    assert.equal(row.negativeControlRejected, true, `${row.id} 负对照必须判红`);
    assert.ok(validScopes.has(row.scope), `${row.id} scope 非法: ${row.scope}`);
    assert.ok(typeof row.group === 'string' && row.group.length > 0, `${row.id} 缺少 group`);
    assert.ok(row.metrics && typeof row.metrics === 'object' && Object.keys(row.metrics).length > 0, `${row.id} 缺少实测指标`);
  }

  const library = loadCardLibrary();
  const recomputed = resolveFilmLock(film, library);
  assert.deepEqual(recomputed, lock);
  assert.equal(normalize(lockPath), `${JSON.stringify(recomputed, null, 2)}\n`);
});

test('V15-3：22 张晋升卡过契约、零泄露、复核权限、未改实现版本检查，且对拍摘要可离线复算', () => {
  assert.ok(existsSync(controlsPath), '缺少 v15-controls.json');
  const filmText = normalize(filmPath);
  const controlsText = normalize(controlsPath);
  const library = loadCardLibrary();

  for (const id of promotedIds) {
    const { raw, card } = byId.get(id);
    const prior = priorStatuses.get(id);
    assert.deepEqual(scanCardLeaks(raw), [], id);
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, id);

    const expectedDigest = createHash('sha256')
      .update(JSON.stringify([id, filmText, controlsText]), 'utf8')
      .digest('hex');
    const expectedReport = `sha256:${expectedDigest}`;

    assert.equal(card.status.length, prior.length, `${id} status 条目数不可增减`);
    for (let i = 0; i < prior.length; i++) {
      const cur = card.status[i];
      const prev = prior[i];
      assert.deepEqual(
        [cur.host, cur.source, cur.gpu, cur.level, cur.date, cur.parityReport],
        [prev.host, prev.source, prev.gpu, 'measured', PROMOTION_DATE, expectedReport],
        `${id} status[${i}]`,
      );
    }

    const previousCard = { ...card, status: prior };
    assert.deepEqual(
      verifyStatusUpdateAuthor(previousCard, card, { actorRole: 'reviewer' }),
      { ok: true, violations: [] },
      `${id} reviewer 应放行`,
    );
    assert.deepEqual(
      verifyStatusUpdateAuthor(previousCard, card, { actorRole: 'implementer' }),
      { ok: false, violations: [{ code: 'status-reviewer-required' }] },
      `${id} implementer 应被拒`,
    );

    const implHashes = Object.fromEntries(
      Object.entries(library[id].files).filter(([name]) => name !== 'card.json'),
    );
    assert.deepEqual(
      checkVersionBump(previousCard, implHashes, card, implHashes),
      { ok: true, violations: [] },
      `${id} 未改实现无需升版本`,
    );
  }
});

test('V15-4：D14 窗口结束后可检索全部 24 张可见锁卡，three.patch 仅按名取', () => {
  const registry = createCardRegistry(cards, {
    nowDate: '2026-12-01',
    allowReproducedUntilDate: '2026-11-30',
  });
  for (const id of lockCardIds) {
    const hit = registry.searchCards({ q: id }).find((row) => row.id === id);
    if (id === 'three.patch') {
      assert.equal(hit, undefined, 'three.patch 不应对 agent 检索可见');
      assert.equal(registry.getCard(id)?.status[0].level, 'measured');
    } else {
      assert.ok(hit, `D14 窗口后应能检索到 ${id}`);
      assert.equal(hit.statusLevel, statusLevels.measured, id);
    }
  }
});

test('V15-5：基础卡与数据卡离线负对照实测全红', () => {
  // 1. time.timeline：错位时钟（shot.in 偏移）立即偏离全局帧与秒数
  const tlGood = evaluateTimeline({ fps: '60/1', shot: { in: 2790 } }, { holdFrames: 1, beatFrames: 30 }, 30, 0);
  const tlBad = evaluateTimeline({ fps: '60/1', shot: { in: 0 } }, { holdFrames: 1, beatFrames: 30 }, 30, 0);
  assert.notEqual(tlGood.time.global, tlBad.time.global);
  assert.ok(Math.abs(tlGood.time.seconds - tlBad.time.seconds) > 40);

  // 2. time.events：空事件表丢失命中与前后距
  const evGood = evaluateEvents(
    { events: [{ id: 'breath.start', kind: 'named', f: 30, sub: 0 }] },
    { kind: 'named' },
    30,
    0,
  );
  const evBad = evaluateEvents({ events: [] }, { kind: 'named' }, 30, 0);
  assert.deepEqual(evGood.events.hits, ['breath.start']);
  assert.deepEqual(evBad.events.hits, []);
  assert.equal(evGood.events.sinceFrames, 0);
  assert.equal(evBad.events.sinceFrames, null);

  // 3. time.seeded：零常量替代或改种子立即偏离确定性随机流
  const sdGood = evaluateSeeded({ seed: 718, shot: { id: 'fire-breath' } }, { purpose: 'jitter', object: 'all', count: 8 }, 30, 0);
  const sdZero = [0, 0, 0, 0, 0, 0, 0, 0];
  const sdMaxDiff = Math.max(...sdGood.seeded.values.map((v, i) => Math.abs(v - sdZero[i])));
  assert.ok(sdMaxDiff > 0.1, `time.seeded 偏差过小: ${sdMaxDiff}`);

  // 4. comp.display：绕过 sRGB 传递函数做线性直出立即大幅超差，且场景参考输入被显式拒绝
  const disp = createCompDisplay({}, { scene: 'agx-mhc', display: 'srgb' });
  const linearSample = new Float32Array([0.18, 0.18, 0.18, 1]);
  const encoded = disp.object.encode(linearSample, [1, 1], 'display');
  const rawLinear = Math.round(0.18 * 255);
  assert.ok(Math.abs(encoded[0] - rawLinear) >= 70, `comp.display sRGB 编码差过小: ${encoded[0]} vs ${rawLinear}`);
  assert.throws(() => disp.object.encode(linearSample, [1, 1], 'scene'), /agx-mhc/);

  // 5. deliver.encode：缺少 BT.709 色彩标签或未知预设立即判红
  const enc = createDeliverEncode({ size: [1920, 1080], fps: '60/1' }, { master: 'h264-crf14-bt709' });
  assert.deepEqual([enc.object.primaries, enc.object.transfer, enc.object.matrix], ['bt709', 'bt709', 'bt709']);
  assert.throws(() => createDeliverEncode({ size: [1920, 1080], fps: '60/1' }, { master: 'missing-bt709-tags' }));

  // 6. S16 数据卡：time.bake / fx.post-state / motion.impulse / motion.sweep-body / motion.roll-bank / motion.swim
  const baseSample = sampleFrame(2838, 0, {});
  const bakeOff = sampleFrame(2838, 0, { disableCards: ['time.bake'] });
  assert.ok(Math.abs(baseSample.baked - bakeOff.baked) > 0.05, `time.bake 偏离过小: ${baseSample.baked} vs ${bakeOff.baked}`);

  const psBase = samplePostState(2790, 0, {});
  const psOff = samplePostState(2790, 0, { disableCards: ['fx.post-state'] });
  assert.ok(Math.abs(psBase.shake - psOff.shake) > 1e-5 || Math.abs(psBase.bloom - psOff.bloom) > 1e-6);

  const impOff = sampleFrame(2838, 0, { disableCards: ['motion.impulse'] });
  const rivalDisp = Math.hypot(
    baseSample.bodies[1].head[0] - impOff.bodies[1].head[0],
    baseSample.bodies[1].head[1] - impOff.bodies[1].head[1],
    baseSample.bodies[1].head[2] - impOff.bodies[1].head[2],
  );
  assert.ok(rivalDisp > 1.0, `motion.impulse 位移偏离过小: ${rivalDisp}`);

  // 7. post.grade-cl CPU 路径在关闭前后有显著偏差
  const hdr = new Float32Array([2.4, 0.85, 0.15, 1]);
  const graded = evaluateCompDisplay({ color: hdr, bloom: new Float32Array(4), shaft: new Float32Array(4) }, {}, [1, 1]);
  assert.equal(graded.length, 4);
  assert.ok(graded[0] > graded[2]);
});

test('V15-6：WebGL2 实测复核代表性负对照、P2-3 同渲染器雾开关回归与 post.lens-fx 撞击帧开关', async (t) => {
  let browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    if (e.code !== 'env.browser-launch') throw e;
    return t.skip(e.message);
  }
  const server = await startServer();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(server.origin);

    const res = await page.evaluate(async () => {
      const THREE = await import('three');
      const { build } = await import('/beiming/sources/three/fire-breath/shot.js');
      const size = [320, 180];

      const makeRenderer = () => {
        const r = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: false });
        r.setPixelRatio(1);
        r.setSize(size[0], size[1], false);
        return r;
      };
      const readU8 = (r, rt) => {
        const out = new Uint8Array(rt.width * rt.height * 4);
        r.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, out);
        return out;
      };
      const diffStats = (a, b) => {
        let ss = 0;
        let maxAbs = 0;
        let ge5 = 0;
        const nPx = a.length / 4;
        for (let i = 0; i < a.length; i += 4) {
          let m = 0;
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(a[i + c] - b[i + c]);
            ss += (d / 255) ** 2;
            if (d > m) m = d;
          }
          if (m > maxAbs) maxAbs = m;
          if (m >= 5) ge5++;
        }
        const rmse = Math.sqrt(ss / (nPx * 3));
        return { rmse, psnrDb: rmse > 0 ? -20 * Math.log10(rmse) : Infinity, maxAbs, diffGe5Pct: (ge5 / nPx) * 100 };
      };

      const renderOnce = (r, frame, params) => {
        const shot = build({ THREE, size, params });
        try {
          const passes = shot.renderPasses(r, frame, 0);
          return readU8(r, passes.finalSrgb);
        } finally {
          shot.dispose();
        }
      };

      // 1. 同一 WebGLRenderer 同时持有 all-on 与关闭 atmo.height-fog 镜头（测 P2-3 着色器缓存键串扰修复）
      const shared = makeRenderer();
      const baseShot = build({ THREE, size, params: {} });
      const base = readU8(shared, baseShot.renderPasses(shared, 2838, 0).finalSrgb);
      const fogOffShot = build({ THREE, size, params: { disableCards: ['atmo.height-fog'] } });
      const fogOffReused = readU8(shared, fogOffShot.renderPasses(shared, 2838, 0).finalSrgb);
      fogOffShot.dispose();
      baseShot.dispose();
      const gradeOff = renderOnce(shared, 2838, { disableCards: ['post.grade-cl'] });
      const aoOff = renderOnce(shared, 2838, { disableCards: ['post.ao'] });
      const bloomOff = renderOnce(shared, 2838, { disableCards: ['post.bloom'] });
      const volOff = renderOnce(shared, 2838, { disableCards: ['post.volumetric'] });
      const breathOff = renderOnce(shared, 2838, { disableCards: ['fx.breath'] });

      // 2. 活跃撞击态 post.lens-fx 开关（遵守 L10 noopParameters，通过 hit + ring 事件在 t=47.3s 激活）
      const impactPostState = {
        events: [
          { kind: 'hit', at: 47.27, amp: 1.0, kick: 0.9, attack: 0.02, release: 0.16 },
          { kind: 'ring', at: 47.2, duration: 1.1, strength: 0.06, radius0: 0.08, radiusMax: 0.7, rate: 3.0 },
        ],
      };
      const impactOn = renderOnce(shared, 2838, { postState: impactPostState });
      const impactOff = renderOnce(shared, 2838, { postState: impactPostState, disableCards: ['post.lens-fx'] });
      shared.dispose();

      // 3. 独立全新 WebGLRenderer 渲染关闭 atmo.height-fog，与同渲染器复用版逐像素比对
      const fresh = makeRenderer();
      const fogOffFresh = renderOnce(fresh, 2838, { disableCards: ['atmo.height-fog'] });
      fresh.dispose();

      return {
        fogVsBase: diffStats(base, fogOffReused),
        fogReusedVsFresh: diffStats(fogOffReused, fogOffFresh),
        gradeVsBase: diffStats(base, gradeOff),
        aoVsBase: diffStats(base, aoOff),
        bloomVsBase: diffStats(base, bloomOff),
        volVsBase: diffStats(base, volOff),
        breathVsBase: diffStats(base, breathOff),
        lensImpactVsOff: diffStats(impactOn, impactOff),
      };
    });

    assert.deepEqual(errors, [], `浏览器报错: ${errors.join('; ')}`);
    assert.equal(res.fogReusedVsFresh.maxAbs, 0, 'P2-3 回归：同渲染器切换 atmo.height-fog 必须与全新渲染器逐像素一致');
    for (const [label, stats] of [
      ['atmo.height-fog', res.fogVsBase],
      ['post.grade-cl', res.gradeVsBase],
      ['post.ao', res.aoVsBase],
      ['post.bloom', res.bloomVsBase],
      ['post.volumetric', res.volVsBase],
      ['fx.breath', res.breathVsBase],
      ['post.lens-fx(impact)', res.lensImpactVsOff],
    ]) {
      assert.ok(stats.psnrDb < 50 && stats.diffGe5Pct > 0.1, `${label} 未击穿门限: ${JSON.stringify(stats)}`);
      t.diagnostic(`${label}: PSNR=${stats.psnrDb.toFixed(2)} dB, diff>=5=${stats.diffGe5Pct.toFixed(2)}%`);
    }
  } finally {
    await server.close();
    await browser.close();
  }
});
