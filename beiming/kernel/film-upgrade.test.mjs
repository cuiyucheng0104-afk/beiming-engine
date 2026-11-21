// 片子描述升级器的自检：
//   一、仓库里三条路线的作品模版（a-webgl、c-style、d-pathtrace）升级之后过片子描述契约的结构和 D 各条，
//       片子 id、画幅、帧率、总帧数、镜头区间、切点、事件、节拍、采样数、画风令牌、最低谓词逐项对回旧描述；
//   二、仓库里别的 schemaVersion 2 作品描述（有就测，没有跳过）同样过契约，展开出来的事件表过事件表契约；
//   三、通用写法：标识改写和撞名、帧率换算、刻意画面按镜头切开、渲染分派的覆盖、没带过来的字段记进 left；
//   四、升级不了的输入抛带码的错，不交半截结果；函数不改入参，同样的输入交同样的结果。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadContracts } from './contracts/validate.mjs';
import { eventsTable } from './eval/input.mjs';
import { FilmUpgradeError, reportFilmUpgrade, upgradeFilmV2ToV3 } from './film-upgrade.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(resolve(REPO, rel), 'utf8'));
const { validate } = await loadContracts();

const TEMPLATES = ['a-webgl', 'c-style', 'd-pathtrace'].map((route) => ({ route, rel: `routes/${route}/template/film.json` }));
// 仓库里别的旧作品描述：成片、文档里的样板、测试夹具
const OTHER_V2 = [
  'docs/routes/templates/film.json', 'films/beiming-10s/film.json', 'films/chendu/film.json', 'films/du/film.json',
  'tests/production/fixtures/retime/film.json', 'tests/qa/fixtures/plates-page/film.json', 'tests/qa/fixtures/texts-page/film.json', 'tests/render/fixtures/shots/film.json',
];
const VARS = { NAME: 'demo-film', TITLE: '样片' };

/** 过契约：结构零错误、D 各条零违反 */
function assertValidFilm(film, what) {
  const r = validate(film);
  assert.equal(r.contract, 'film', `${what}：没有按片子描述契约判`);
  assert.deepEqual(r.schemaErrors, [], `${what}：结构不合`);
  assert.deepEqual(r.violations, {}, `${what}：违反了不变量`);
}
const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
const anyFrozen = (v) => v !== null && typeof v === 'object' && (Object.isFrozen(v) || Object.values(v).some(anyFrozen));
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof FilmUpgradeError && e.code === `film-upgrade.${code}`, `应该抛 film-upgrade.${code}`);
/** 一份最小的旧描述，镜头 [0,48) [48,120) */
const base = (over = {}) => ({
  schemaVersion: 2, id: 'gen', title: '通用', route: 'a', backend: 'three',
  output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 120 },
  shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 48, out: 120 }],
  ...over,
});

describe('三条路线的作品模版', () => {
  for (const { route, rel } of TEMPLATES) {
    const v2 = readJson(rel);

    test(`${route}：不给 options 也过契约`, () => {
      assertValidFilm(upgradeFilmV2ToV3(v2), rel);
    });

    test(`${route}：填了占位之后过契约，时间线和输出规格逐项相同`, () => {
      const { film, renamed } = reportFilmUpgrade(v2, { vars: VARS });
      assertValidFilm(film, rel);
      assert.equal(film.format, 'film/3.0');
      assert.equal(film.id, 'demo-film');
      assert.equal(film.title, '样片');
      assert.deepEqual(film.output, { size: [v2.output.width, v2.output.height], fps: `${v2.output.fps}/1`, frames: v2.output.frameCount });
      assert.deepEqual(film.predicates, { base: ['floor@1'] });
      assert.deepEqual(film.style.view, { scene: 'agx-mhc', display: 'srgb' });
      assert.deepEqual(film.audio, { mode: v2.audio.mode, loudness: v2.audio.targetLUFS, truePeak: v2.audio.truePeakDbTP });
      const old = v2.shots ?? [{ id: 's01', in: 0, out: v2.output.frameCount }];
      assert.deepEqual(film.shots.map((s) => [s.in, s.out]), old.map((s) => [s.in, s.out]), '镜头区间');
      assert.deepEqual(film.shots.map((s) => s.id), old.map((s) => renamed.shots[s.id] ?? s.id), '镜头的 id');
      // 每个切点一条硬切
      assert.deepEqual(film.transitions ?? [], old.slice(1).map((s) => ({ id: `cut-${s.in}`, at: s.in, type: 'cut' })));
      // 旧镜头条目里别的字段原样在 params 里
      old.forEach((s, i) => {
        for (const [key, value] of Object.entries(s)) if (!['id', 'in', 'out'].includes(key)) assert.deepEqual(film.shots[i].params[key], value, `镜头 ${s.id} 的 ${key}`);
        assert.equal(film.shots[i].params.route, v2.route);
        assert.equal(film.shots[i].params.backend, v2.backend);
      });
      // 旧事件的帧号、所属镜头、声音名
      (v2.events ?? []).forEach((e) => {
        const now = film.events.find((x) => x.id === (renamed.events[e.id] ?? e.id));
        assert.deepEqual(now, { id: now.id, frame: e.frame, shot: renamed.shots[e.shot] ?? e.shot, audio: e.audio }, `事件 ${e.id}`);
      });
      // 展开出来的事件表过事件表契约
      const table = validate(eventsTable(film));
      assert.deepEqual([table.schemaErrors, table.violations], [[], {}]);
    });
  }

  test('a-webgl：画风锁的色板进 style.tokens，没带过来的字段一个不漏记在 left', () => {
    const v2 = readJson('routes/a-webgl/template/film.json');
    // 模版的 style.lock 相对作品目录写；画风锁本身在仓库的 engine/style 里
    const lockRel = `engine/style/${v2.style.lock.split('/').at(-1)}`;
    const styleLock = readJson(lockRel);
    const { film, left } = reportFilmUpgrade(v2, { vars: VARS, styleLock });
    assertValidFilm(film, 'a-webgl 带画风令牌');
    const colors = styleLock.palette.colors;
    assert.ok(colors.length >= 20, `画风锁的色板只有 ${colors.length} 个颜色`);
    assert.equal(Object.keys(film.style.tokens).length, colors.length);
    for (const c of colors) assert.equal(film.style.tokens[c.id], c.hex.toUpperCase());
    assert.equal(film.delivery.web, true);
    assert.deepEqual(film.shots.map((s) => [s.source, s.host, s.mode, s.entry, s.colorRef]), Array(2).fill(['legacy-page', 'page', 'native-code', 'index.html', 'display']));
    assert.deepEqual(left, [
      'aigc', 'assets', 'audio/script', 'credits', 'deliveries',
      'events/sun-break/note', 'events/sun-break/visual', 'events/title-in/note', 'events/title-in/visual',
      'fonts', 'gates', 'next', 'output/profile', 'style/baseline', 'style/id', 'style/lock', 'style/note', 'style/version', 'texts',
    ]);
  });

  test('c-style：没有镜头表写成一个镜头，节拍表进 timeline，打点换成事件', () => {
    const { film, notes } = reportFilmUpgrade(readJson('routes/c-style/template/film.json'), { vars: VARS });
    assert.deepEqual(film.shots.map((s) => [s.id, s.in, s.out, s.entry]), [['s01', 0, 192, 'index.html']]);
    assert.equal(film.transitions, undefined);
    assert.deepEqual(film.timeline, { bpm: 90, beatFrames: 16 });
    // 90 拍每分钟、24 帧每秒，一拍 16 帧：[段落, 小节, 拍] → ((小节 − 1) × 4 + 拍 − 1) × 16
    assert.deepEqual(film.events, [
      { id: 'touch', frame: 0 }, { id: 's1', frame: 32 }, { id: 's2', frame: 48 },
      { id: 's3', frame: 64 }, { id: 'title', frame: 128 }, { id: 'seal', frame: 144 },
    ]);
    assert.ok(notes.some((n) => n.includes('没有镜头表')));
  });

  test('d-pathtrace：种子和采样数进全片种子和档位，入口文件照旧描述', () => {
    const film = upgradeFilmV2ToV3(readJson('routes/d-pathtrace/template/film.json'), { vars: VARS });
    assert.equal(film.seed, 2026);
    assert.deepEqual(film.shots.map((s) => [s.id, s.entry, s.tiers]), [
      ['s01', 'scene.ts', { draft: { samples: 4 }, final: { samples: 24 } }],
      ['s02', 'scene.ts', { draft: { samples: 4 }, final: { samples: 48 } }],
    ]);
    assert.deepEqual(film.shots[0].params.pathtrace, { preset: 'cinematic', denoise: 'auto', overlay: 'none' });
    assert.deepEqual(film.events.map((e) => [e.id, e.frame, e.shot, e.audio]), [['sweep-strike', 12, 's01', 'arc-sweep'], ['reveal-lock', 40, 's02', 'anvil-lock']]);
  });
});

describe('仓库里别的旧作品描述', () => {
  for (const rel of OTHER_V2) {
    test(rel, { skip: existsSync(resolve(REPO, rel)) ? false : '仓库里没有这个文件' }, () => {
      const v2 = readJson(rel);
      const { film, renamed } = reportFilmUpgrade(v2);
      assertValidFilm(film, rel);
      assert.equal(film.output.frames, v2.output.frameCount);
      assert.deepEqual(film.shots.map((s) => [s.in, s.out]), v2.shots.map((s) => [s.in, s.out]));
      assert.equal((film.events ?? []).length, (v2.events ?? []).length);
      for (const e of v2.events ?? []) assert.equal(film.events.find((x) => x.id === (renamed.events[e.id] ?? e.id)).frame, e.frame, `事件 ${e.id} 的帧号`);
      const table = validate(eventsTable(film));
      assert.deepEqual([table.schemaErrors, table.violations], [[], {}]);
    });
  }
});

describe('通用写法', () => {
  test('标识改成小写连字符，撞名的加序号，事件跟着镜头的新名字走', () => {
    const { film, renamed } = reportFilmUpgrade(base({
      id: '10s-Film',
      shots: [{ id: 'S1', in: 0, out: 48 }, { id: 's1', in: 48, out: 96 }, { id: 'film', in: 96, out: 120 }],
      events: [{ id: 'a.Hit_1', frame: 50, shot: 's1', audio: 'ui_scan' }, { id: '9lives', frame: 0, shot: 'S1' }, { id: 'tail', frame: 100, shot: 'film' }],
    }));
    assertValidFilm(film, '改名');
    assert.equal(film.id, 'f-10s-film');
    assert.deepEqual(film.shots.map((s) => s.id), ['s1', 's1-2', 's-film']);
    assert.deepEqual(renamed.shots, { S1: 's1', s1: 's1-2', film: 's-film' });
    assert.deepEqual(film.events, [
      { id: 'a-hit-1', frame: 50, shot: 's1-2', audio: 'ui-scan' }, { id: 'e-9lives', frame: 0, shot: 's1' }, { id: 'tail', frame: 100, shot: 's-film' },
    ]);
  });

  test('帧率写成最简分数', () => {
    const fpsOf = (fps, frameCount = 120) => upgradeFilmV2ToV3(base({ output: { width: 1920, height: 1080, fps, frameCount } })).output.fps;
    assert.deepEqual([24, 23.976, 29.97, 59.94, 12.5, '60/2', '24000/1001', '25'].map((f) => fpsOf(f)), ['24/1', '24000/1001', '30000/1001', '60000/1001', '25/2', '30/1', '24000/1001', '25/1']);
    throwsCode(() => fpsOf(0), 'bad-fps');
    throwsCode(() => fpsOf('ntsc'), 'bad-fps');
  });

  test('只有旧的 dur、fps、size 时照它们算输出规格', () => {
    const film = upgradeFilmV2ToV3({ schemaVersion: 2, id: 'old', dur: 5, fps: 24, size: [1280, 720] });
    assertValidFilm(film, '兼容镜像');
    assert.deepEqual(film.output, { size: [1280, 720], fps: '24/1', frames: 120 });
    throwsCode(() => upgradeFilmV2ToV3({ schemaVersion: 2, id: 'old', dur: 5.01, fps: 24, size: [1280, 720] }), 'bad-frames');
  });

  test('刻意的静止和黑场按镜头切开，闪白没有位置记进 left', () => {
    const { film, left } = reportFilmUpgrade(base({
      qa: {
        intentional: [{ kind: 'freeze', from: 40, to: 60, reason: '定格' }, { kind: 'flash', from: 10, to: 12, reason: '闪白' }],
        blackouts: [{ from: 114, to: 120 }],
        safeArea: 'title',
      },
    }));
    assertValidFilm(film, '刻意画面');
    assert.deepEqual(film.shots[0].deliberate, [{ kind: 'freeze', in: 40, out: 48, why: '定格' }]);
    assert.deepEqual(film.shots[1].deliberate.map((d) => [d.kind, d.in, d.out]), [['freeze', 48, 60], ['black', 114, 120]]);
    assert.deepEqual(left.filter((p) => p.startsWith('qa')), ['qa/intentional/1', 'qa/safeArea']);
  });

  test('节拍表：一种速度写进 timeline，一拍不是整数帧就只写 bpm，几种速度不写', () => {
    const tl = (over) => reportFilmUpgrade(base(over));
    assert.deepEqual(tl({ timeline: { sections: [{ id: 'A', start: 0, bpm: 120, meter: 4 }] } }).film.timeline, { bpm: 120, beatFrames: 12 });
    assert.deepEqual(tl({ tempo: [{ id: 'A', t0: 0, bpm: 100, meter: 4 }] }).film.timeline, { bpm: 100 });
    const two = tl({ tempo: [{ id: 'A', t0: 0, bpm: 120, meter: 4 }, { id: 'B', t0: 2, bpm: 90, meter: 4 }], cues: { drop: ['B', 1, 2], pre: ['A', 2, 1, 0.5] } });
    assertValidFilm(two.film, '两段速度');
    assert.equal(two.film.timeline, undefined);
    // B 段从 2 秒（第 48 帧）起，90 拍每分钟一拍 16 帧，第 2 拍在第 64 帧；A 段 120 拍每分钟一拍 12 帧，第 2 小节第 1 拍后半拍在第 54 帧
    assert.deepEqual(two.film.events, [{ id: 'drop', frame: 64 }, { id: 'pre', frame: 54 }]);
    throwsCode(() => tl({ cues: { x: ['A', 1, 1] } }), 'bad-cue');
    throwsCode(() => tl({ tempo: [{ id: 'A', t0: 0, bpm: 120, meter: 4 }], cues: { late: ['A', 99, 1] } }), 'bad-cue');
  });

  test('声音：wav 写成 track，对帧方式只带 film/3.0 认识的，转场不是硬切时记一笔', () => {
    const { film, left, notes } = reportFilmUpgrade(base({
      shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 48, out: 120, transition: 'dissolve' }],
      events: [{ id: 'hit', frame: 48, sync: 'pcenter', audio: 'hit.low' }, { id: 'lips', frame: 60, sync: 'lip', audio: '!!' }],
      audio: { mode: 'wav', wav: 'mix.wav', targetLUFS: -16 },
    }));
    assertValidFilm(film, '声音');
    assert.deepEqual(film.audio, { mode: 'track', loudness: -16 });
    assert.deepEqual(film.events, [{ id: 'hit', frame: 48, audio: 'hit.low', sync: 'pcenter' }, { id: 'lips', frame: 60 }]);
    assert.deepEqual(left, ['audio/wav', 'events/lips/audio', 'events/lips/sync', 'output/profile']);
    assert.deepEqual(film.transitions, [{ id: 'cut-48', at: 48, type: 'cut' }]);
    assert.equal(film.shots[1].params.transition, 'dissolve');
    assert.ok(notes.some((n) => n.includes('dissolve')));
    assert.equal(upgradeFilmV2ToV3(base()).audio, undefined, '旧描述没有 audio 时不写');
  });

  test('options 覆盖渲染分派、令牌、谓词和交付', () => {
    const three = upgradeFilmV2ToV3(base(), { source: 'three', host: 'page', mode: 'build-script', entry: 'shots/build.js', colorRef: 'scene', sceneView: 'agx-base', master: 'h264-high', predicatesBase: ['floor@1', 'template:delivery-web@1'], tokens: { ink: '#1b1a22', paper: '#fff' }, id: 'f_gen', title: '新名' });
    assertValidFilm(three, '覆盖');
    assert.deepEqual(three.shots.map((s) => [s.source, s.host, s.mode, s.entry, s.colorRef]), Array(2).fill(['three', 'page', 'build-script', 'shots/build.js', 'scene']));
    assert.deepEqual([three.id, three.title, three.style, three.predicates, three.delivery], ['f_gen', '新名', { tokens: { ink: '#1B1A22', paper: '#FFFFFF' }, view: { scene: 'agx-base', display: 'srgb' } }, { base: ['floor@1', 'template:delivery-web@1'] }, { master: 'h264-high' }]);
    const cards = upgradeFilmV2ToV3(base(), { source: 'blender', host: 'cycles', mode: 'cards-data' });
    assertValidFilm(cards, '卡加数据');
    assert.ok(cards.shots.every((s) => !('entry' in s)));
    for (const [options, at] of [[{ source: 'ext.lab' }, 'options.source'], [{ mode: 'script' }, 'options.mode'], [{ colorRef: 'linear' }, 'options.colorRef'], [{ entry: '../x.js' }, 'options.entry'], [{ tokens: { ink: 'black' } }, 'options.tokens.ink'], [{ predicatesBase: ['floor'] }, 'options.predicatesBase'], [{ master: 'H264' }, 'options.master'], [{ sceneView: '' }, 'options.sceneView']]) {
      assert.throws(() => upgradeFilmV2ToV3(base(), options), (e) => e instanceof FilmUpgradeError && e.at === at, `${JSON.stringify(options)} 应该报在 ${at}`);
    }
  });
});

describe('升级不了的输入和纯函数', () => {
  test('不是 schemaVersion 2、时间线不衔接、事件出界、标识重复，各报各的码', () => {
    throwsCode(() => upgradeFilmV2ToV3(null), 'not-v2');
    throwsCode(() => upgradeFilmV2ToV3({ route: 'b', title: '旧', dur: 3, fps: 24, size: [1920, 1080] }), 'not-v2');
    throwsCode(() => upgradeFilmV2ToV3(base({ id: '！！' })), 'bad-id');
    throwsCode(() => upgradeFilmV2ToV3(base({ output: { width: 1920, height: 0, fps: 24, frameCount: 120 } })), 'bad-size');
    throwsCode(() => upgradeFilmV2ToV3(base({ output: { width: 1920, height: 1080, fps: 24, frameCount: 0 } })), 'bad-frames');
    throwsCode(() => upgradeFilmV2ToV3(base({ shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 50, out: 120 }] })), 'bad-timeline');
    throwsCode(() => upgradeFilmV2ToV3(base({ shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 48, out: 100 }] })), 'bad-timeline');
    throwsCode(() => upgradeFilmV2ToV3(base({ shots: [{ id: 'S1', in: 4, out: 120 }] })), 'bad-timeline');
    throwsCode(() => upgradeFilmV2ToV3(base({ shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S1', in: 48, out: 120 }] })), 'bad-id');
    throwsCode(() => upgradeFilmV2ToV3(base({ events: [{ id: 'late', frame: 120 }] })), 'bad-event');
    throwsCode(() => upgradeFilmV2ToV3(base({ events: [{ id: 'off', frame: 50, shot: 'S1' }] })), 'bad-event');
    throwsCode(() => upgradeFilmV2ToV3(base({ events: [{ id: 'lost', frame: 50, shot: 'S9' }] })), 'bad-event');
    throwsCode(() => upgradeFilmV2ToV3(base({ entry: 'shots\\index.html' })), 'bad-entry');
    throwsCode(() => upgradeFilmV2ToV3(base({ entry: '/index.html' })), 'bad-entry');
    throwsCode(() => upgradeFilmV2ToV3(base({ output: { width: 1920, height: 1080, fps: 1e-9, frameCount: 120 } })), 'bad-fps');
    assert.equal(upgradeFilmV2ToV3(base({ output: { width: 1920, height: 1080, fps: 0.0001, frameCount: 120 } })).output.fps, '1/10000');
  });

  test('不改入参，结果不和入参共用对象，两次结果相同', () => {
    for (const rel of [...TEMPLATES.map((t) => t.rel), 'films/beiming-10s/film.json'].filter((r) => existsSync(resolve(REPO, r)))) {
      const v2 = readJson(rel);
      const frozen = deepFreeze(structuredClone(v2));
      // 不给 vars：给了 vars 时入参先整份抄过一遍，查不出共用
      const first = reportFilmUpgrade(frozen);
      assert.deepEqual(frozen, v2, `${rel}：入参变了`);
      assert.deepEqual(reportFilmUpgrade(frozen), first, `${rel}：两次结果不同`);
      // 入参整个冻住了：结果里只要有一个冻住的对象，就是把入参的对象原样带了出来
      assert.equal(anyFrozen(first), false, `${rel}：结果里带着入参的对象`);
    }
  });
});
