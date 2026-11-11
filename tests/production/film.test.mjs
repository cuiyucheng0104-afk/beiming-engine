// film.json v2：校验器、v1 升级、交付档位、路线专属段（计划 P05·M0，附录 C6 / C7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AIGC_KINDS, AIGC_MARK, effectiveProfile, ffprobeExpect, getProfile, intentionalRanges, loadFilm, loadProfiles, matchProfile, migrateV2, qaExpectations, upgradeFilm, validateFilm,
} from '../../engine/production/film.js';
import { REPO, clone, errors, minimalFilm, tempFilm, warnings } from './helpers.mjs';

const v = (film, opts = {}) => validateFilm(film, { checkFiles: false, ...opts });

test('最小 v2 作品通过，并补齐默认值（gates 全开、deliveries = 渲染档、音频目标取档位）', () => {
  const r = v(minimalFilm());
  assert.deepEqual(errors(r), []);
  assert.equal(r.film.drive, 'picture');
  assert.deepEqual(r.film.gates, { look: 'required', animatic: 'required', final: 'required' });
  assert.deepEqual(r.film.deliveries, ['web-1080p24']);
  assert.equal(r.film.audio.targetLUFS, -14);
  assert.equal(r.film.audio.truePeakDbTP, -1);
  assert.equal(r.film.entry, 'index.html');
});

test('镜头表：半开区间、首尾相接、正好覆盖 [0, frameCount)', () => {
  const gap = minimalFilm(); gap.shots[1].in = 50;
  assert.ok(errors(v(gap)).includes('shots-not-contiguous'));
  const overlap = minimalFilm(); overlap.shots[1].in = 40;
  assert.ok(errors(v(overlap)).includes('shots-not-contiguous'));
  const short = minimalFilm(); short.shots[1].out = 90;
  assert.ok(errors(v(short)).includes('shots-coverage'));
  const empty = minimalFilm(); empty.shots[0].out = 0; empty.shots[1].in = 0;
  assert.ok(errors(v(empty)).includes('shot-empty'));
  const seconds = minimalFilm(); seconds.shots[0].out = 2.0001; seconds.shots[1].in = 2.0001;
  assert.ok(errors(v(seconds)).includes('shot-frame-invalid'));
  const dup = minimalFilm(); dup.shots[1].id = 'S1'; dup.events[0].shot = 'S1';
  assert.ok(errors(v(dup)).includes('shot-id-duplicate'));
  const none = minimalFilm({ shots: [] });
  assert.ok(errors(v(none)).includes('shots-missing'));
  // 镜头起点必须从 0 开始
  const late = minimalFilm(); late.shots[0].in = 1;
  assert.ok(errors(v(late)).includes('shots-not-contiguous'));
});

test('事件：落在所属镜头里、在片长之内、id 唯一、end 在 frame 之后', () => {
  const outside = minimalFilm(); outside.events[0].frame = 10;
  const r = v(outside);
  assert.ok(errors(r).includes('event-outside-shot'));
  assert.match(r.diagnostics.find(d => d.code === 'event-outside-shot').message, /落在 S1/);
  const range = minimalFilm(); range.events[0].frame = 96;
  assert.ok(errors(v(range)).includes('event-out-of-range'));
  const unknown = minimalFilm(); unknown.events[0].shot = 'S9';
  assert.ok(errors(v(unknown)).includes('event-shot-unknown'));
  const dup = minimalFilm(); dup.events.push({ ...dup.events[0] });
  assert.ok(errors(v(dup)).includes('event-id-duplicate'));
  const end = minimalFilm(); end.events[0].end = 60;
  assert.ok(errors(v(end)).includes('event-end-invalid'));
  const frac = minimalFilm(); frac.events[0].frame = 60.5;
  assert.ok(errors(v(frac)).includes('event-frame-invalid'));
  const silent = minimalFilm(); delete silent.events[0].audio; delete silent.events[0].visual;
  assert.ok(warnings(v(silent)).includes('event-empty'));
});

test('节拍：三种写法都能校验，事件的 beat 与 frame 必须同源', () => {
  const f = minimalFilm({ drive: 'beat', timeline: { sections: [{ id: 'A', start: 0, bpm: 120, meter: 4 }] } });
  f.events[0] = { id: 'a.hit', frame: 60, beat: 5, shot: 'S2', audio: 'hit' };   // 120 BPM @24 = 12 帧一拍：第 5 拍 = 60
  assert.deepEqual(errors(v(f)), []);
  f.events[0].frame = 61;
  assert.ok(errors(v(f)).includes('event-beat-mismatch'));
  const beatsForm = minimalFilm({ timeline: { beats: [0, 12, 24, 36, 48, 60, 72, 84] } });
  beatsForm.events[0].beat = 5;
  assert.deepEqual(errors(v(beatsForm)), []);
  const barsForm = minimalFilm({ timeline: { bars: [[12, 12, 12, 12], [12, 12, 12, 12]] } });
  barsForm.events[0].beat = 5;
  assert.deepEqual(errors(v(barsForm)), []);
  const both = minimalFilm({ timeline: { beats: [0, 12], bars: [[12]] } });
  assert.ok(errors(v(both)).includes('timeline-invalid'));
  const offFrame = minimalFilm({ timeline: { sections: [{ id: 'A', start: 0, bpm: 100, meter: 4 }] } });   // 14.4 帧一拍
  assert.ok(warnings(v(offFrame)).includes('beats-off-frame'));
  const noTl = minimalFilm({ drive: 'beat' });
  assert.ok(errors(v(noTl)).includes('timeline-missing'));
  const beatNoTl = minimalFilm(); beatNoTl.events[0].beat = 5;
  assert.ok(errors(v(beatNoTl)).includes('event-beat-without-timeline'));
});

test('没有消费者的时间字段判错；未知字段只警告', () => {
  for (const [where, mutate] of [
    ['顶层 poster', f => { f.poster = 2.5; }],
    ['顶层 duration', f => { f.duration = 4; }],
    ['镜头里的 t0', f => { f.shots[0].t0 = 0; }],
    ['事件里的 t', f => { f.events[0].t = 2.5; }],
    ['output.duration', f => { f.output.duration = 4; }],
    ['刻意画面里的 t0', f => { f.qa = { intentional: [{ kind: 'black', from: 0, to: 2, reason: '片头黑场', t0: 0 }] }; }],
  ]) {
    const f = minimalFilm(); mutate(f);
    assert.ok(errors(v(f)).includes('orphan-time-field'), where);
  }
  // 不只认固定名单：最后一段是时间单位、t 加大写或数字开头、「动词 + 时刻 / 长度」的写法，不管写在哪一层都判错
  const LEVELS = {
    顶层: (f, k, val) => { f[k] = val; },
    镜头: (f, k, val) => { f.shots[1][k] = val; },
    事件: (f, k, val) => { f.events[0][k] = val; },
    output: (f, k, val) => { f.output[k] = val; },
    刻意画面: (f, k, val) => { f.qa = { intentional: [{ kind: 'black', from: 0, to: 2, reason: '片头黑场', [k]: val }] }; },
    豁免: (f, k, val) => { f.qa = { waivers: [{ check: 'texts.duration', frames: [0, 12], reason: '片名短闪', approvedBy: '用户', quote: '片名闪一下就行。', source: '会话第 5 条', [k]: val }] }; },
  };
  for (const key of ['startSec', 'durationMs', 'holdSec', 'delaySec', 'fadeFrames', 'tStart', 'endSec', 'timeMs', 'beatSec', 'startTime', 'fadeIn', 'cutAt', 'inPoint', 'frameCount', 'tempo', 'fps']) {
    for (const [level, put] of Object.entries(LEVELS)) {
      if (level === 'output' && ['fps', 'frameCount'].includes(key)) continue;   // output 的 fps / frameCount 是正经字段
      if (level === '顶层' && key === 'fps') continue;                            // 顶层 fps 是 v1 兼容镜像（与 output 不一致另判 legacy-mirror-mismatch）
      if (level === '顶层' && key === 'tempo') continue;                          // 顶层 tempo 是 C 路线的节拍段落表（见下一条用例）
      const f = minimalFilm(); put(f, key, 1.5);
      const r = v(f);
      const d = r.diagnostics.find(x => x.code === 'orphan-time-field');
      assert.ok(d && d.level === 'error', `${level}的 ${key}`);
      assert.doesNotMatch(d.hint, /holds/, '提示不再指向已废弃的顶层 holds');
    }
  }
  // 提示按所在的层指到正确的地方
  const hintOf = mutate => { const f = minimalFilm(); mutate(f); return v(f).diagnostics.find(x => x.code === 'orphan-time-field').hint; };
  assert.match(hintOf(f => { f.startTime = 1.5; }), /qa\.intentional\[\]\.from \/ to、qa\.waivers\[\]\.frames/);
  assert.match(hintOf(f => { f.shots[0].holdSec = 2; }), /镜头的时间只有 in \/ out/);
  assert.match(hintOf(f => { f.events[0].startSec = 2; }), /事件的时间只有 frame 与 end/);
  assert.match(hintOf(f => { f.output.durationMs = 4000; }), /output\.frameCount \/ output\.fps/);
  assert.match(hintOf(f => { f.qa = { intentional: [{ kind: 'black', from: 0, to: 2, reason: 'x', endSec: 1 }] }; }), /from \/ to/);
  // 不像时间的未知字段只警告：切段之后 items、endCard、fadeColor、startScale、offsetX 都不是时间；布尔值装不下时间
  for (const [key, val] of [['items', 3], ['endCard', '片尾卡'], ['fadeColor', '#000000'], ['startScale', 1.2], ['offsetX', 12], ['format', 'mp4'], ['fadeIn', true]]) {
    const f = minimalFilm(); f.shots[0][key] = val;
    const r = v(f);
    assert.deepEqual(errors(r), [], key);
    assert.ok(warnings(r).includes('unknown-field'), key);
  }
  const typo = minimalFilm({ titel: 'x' });
  const r = v(typo);
  assert.deepEqual(errors(r), []);
  assert.ok(warnings(r).includes('unknown-field'));
  // 兼容镜像 dur / fps / size：与 output 一致时只提示，不一致判错
  assert.ok(warnings(v(minimalFilm({ dur: 4, fps: 24, size: [1920, 1080] }))).includes('legacy-mirror'));
  assert.ok(errors(v(minimalFilm({ dur: 5 }))).includes('legacy-mirror-mismatch'));
});

test('C 路线的节拍写法 tempo + cues：与页面同一公式，段落起点与打点要落整帧、在片长内；与 timeline 只能写一种', async () => {
  const { createTempo } = await import('../../engine/core/tempo.js');
  const TEMPO = [{ id: 'A', t0: 0, bpm: 90, meter: 4 }];   // 90 BPM @24 = 每拍 16 帧
  const c = (cues, extra = {}) => minimalFilm({ tempo: clone(TEMPO), cues, ...extra });
  const good = c({ touch: ['A', 1, 1], s1: ['A', 1, 3], half: ['A', 1, 2, 0.5], land: ['A', 2, 1] });   // 0、32、24、64 帧
  const r = v(good);
  assert.deepEqual(errors(r), []);
  assert.ok(!warnings(r).includes('unknown-field'), 'tempo / cues 是登记过的字段');
  // 与页面 timeline.js 的换算相同：A 段第 3 小节第 1 拍 = 8 拍 × 16 帧 = 第 128 帧（秒按 6 位小数取整，所以整帧判定留 1e-4 帧的容差）
  assert.ok(Math.abs(createTempo(TEMPO, { fps: 24 }).at('A', 3, 1) * 24 - 128) < 1e-4);
  // C 模版本身：同一公式下每个打点都落整帧、在片长内
  const tpl = JSON.parse(readFileSync(join(REPO, 'routes', 'c-style', 'template', 'film.json'), 'utf8'));
  const tempo = createTempo(tpl.tempo, { fps: tpl.output.fps });
  for (const [k, a] of Object.entries(tpl.cues)) {
    const x = tempo.at(...a) * tpl.output.fps;
    assert.ok(Math.abs(x - Math.round(x)) < 1e-4 && x < tpl.output.frameCount, k);
  }
  // 打点不落整帧（第 1 拍的 1/3 = 5.33 帧）、超出片长（96 帧 = 6 拍）、段落不存在、拍号超出小节、写法不对
  assert.ok(errors(v(c({ x: ['A', 1, 1, 1 / 3] }))).includes('cue-off-frame'));
  assert.ok(errors(v(c({ x: ['A', 2, 3] }))).includes('cue-out-of-range'));
  assert.ok(errors(v(c({ x: ['B', 1, 1] }))).includes('cue-section-unknown'));
  assert.ok(errors(v(c({ x: ['A', 1, 5] }))).includes('cue-invalid'));
  for (const bad of [['A'], ['A', 0, 1], ['A', 1.5], ['A', 1, 1, 1], 'A:1:1', { id: 'A' }]) assert.ok(errors(v(c({ x: bad }))).includes('cue-invalid'), JSON.stringify(bad));
  // 段落表：起点不落整帧、不递增、id 重复、速度与拍号不对
  const tempoErr = t => errors(v(minimalFilm({ tempo: t })));
  assert.ok(tempoErr([{ id: 'A', t0: 0.01, bpm: 90, meter: 4 }]).includes('tempo-off-frame'));
  assert.ok(tempoErr([{ id: 'A', t0: 1, bpm: 90, meter: 4 }, { id: 'B', t0: 0.5, bpm: 90, meter: 4 }]).includes('tempo-invalid'));
  assert.ok(tempoErr([{ id: 'A', t0: 0, bpm: 90, meter: 4 }, { id: 'A', t0: 2, bpm: 90, meter: 4 }]).includes('tempo-invalid'));
  assert.ok(tempoErr([{ id: 'A', t0: 0, bpm: 0, meter: 4 }]).includes('tempo-invalid'));
  assert.ok(tempoErr([{ id: 'A', t0: 0, bpm: 90, meter: 3.5 }]).includes('tempo-invalid'));
  assert.ok(tempoErr([]).includes('tempo-invalid'));
  // 段落里只认 id / t0 / t1 / bpm / meter / note：别的时间字段照样判没有消费者
  assert.ok(tempoErr([{ id: 'A', t0: 0, bpm: 90, meter: 4, startSec: 0 }]).includes('orphan-time-field'));
  // 两种节拍写法只能用一种；没有 tempo 的 cues 换算不出时间；drive = beat 时 tempo 也算节拍表
  assert.ok(errors(v(c({ x: ['A', 1, 1] }, { timeline: { sections: [{ id: 'A', start: 0, bpm: 90, meter: 4 }] } }))).includes('tempo-duplicate'));
  assert.ok(errors(v(minimalFilm({ cues: { x: ['A', 1, 1] } }))).includes('cues-without-tempo'));
  assert.deepEqual(errors(v(c({ x: ['A', 1, 1] }, { drive: 'beat' }))), []);
});

test('模版可以不写镜头表（new-film 生成作品时补整片一个镜头 S1）；作品必须写', () => {
  const tpl = minimalFilm({ id: '{{NAME}}', title: '{{TITLE}}', events: [] });
  delete tpl.shots;
  const r = v(tpl, { template: true });
  assert.deepEqual(errors(r), []);
  assert.deepEqual(r.film.shots, [{ id: 'S1', in: 0, out: 96 }]);
  assert.ok(r.notes.some(n => /整片一个镜头 S1 \[0, 96\)/.test(n)), r.notes.join('；'));
  const film = minimalFilm({ events: [] });
  delete film.shots;
  assert.ok(errors(v(film)).includes('shots-missing'));
});

test('交付档位：必须存在、画幅帧率与档位一致；《北冥》专用档对新作品只是提示', () => {
  assert.ok(errors(v(minimalFilm({ output: { profile: 'web-4k', width: 1920, height: 1080, fps: 24, frameCount: 96 } }))).includes('profile-unknown'));
  assert.ok(errors(v(minimalFilm({ output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 25, frameCount: 96 } }))).includes('output-profile-mismatch'));
  assert.ok(errors(v(minimalFilm({ output: { width: 1920, height: 1080, fps: 24, frameCount: 96 } }))).includes('profile-missing'));
  assert.ok(errors(v(minimalFilm({ output: { profile: 'web-1080p24', width: 1921, height: 1080, fps: 24, frameCount: 96 } }))).includes('output-dimension-odd'));
  const bm = v(minimalFilm({ output: { profile: 'beiming-1040p24', width: 1920, height: 1040, fps: 24, frameCount: 96 } }));
  assert.deepEqual(errors(bm), []);
  assert.ok(warnings(bm).includes('profile-reserved'));
  // 交付清单：帧率或画幅比不同的档位不能从同一份描述直接出
  assert.ok(errors(v(minimalFilm({ deliveries: ['web-1080p24', 'broadcast-1080p25'] }))).includes('delivery-fps-mismatch'));
  assert.ok(errors(v(minimalFilm({ deliveries: ['web-1080p24', 'vertical-1080x1920-30'] }))).some(c => c === 'delivery-fps-mismatch' || c === 'delivery-aspect-mismatch'));
  assert.deepEqual(errors(v(minimalFilm({ deliveries: ['web-1080p24', 'master-1080p24', 'uhd-2160p24'] }))), []);
  // 混音目标落在档位窗口外
  assert.ok(errors(v(minimalFilm({ audio: { mode: 'none', targetLUFS: -20 } }))).includes('audio-target-profile'));
});

test('档位表与决策 D07 一致，ffprobe 期望值与 QA 期望值由它推出', () => {
  const P = loadProfiles({ fresh: true });
  assert.equal(P.default, 'web-1080p24');
  assert.deepEqual(Object.keys(P.profiles).sort(), ['beiming-1040p24', 'broadcast-1080p25', 'master-1080p24', 'uhd-2160p24', 'vertical-1080x1920-30', 'web-1080p24']);
  const web = getProfile('web-1080p24');
  assert.deepEqual([web.video.width, web.video.height, web.video.fps, web.video.pixFmt], [1920, 1080, 24, 'yuv420p']);
  assert.deepEqual(web.video.color, { range: 'tv', matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' });
  assert.deepEqual([web.audio.codec, web.audio.sampleRate, web.audio.channels], ['aac', 48000, 2]);
  assert.deepEqual([web.audio.loudness.integrated, web.audio.loudness.tolerance, web.audio.loudness.truePeak], [-14, 1, -1]);
  assert.deepEqual([getProfile('broadcast-1080p25').audio.loudness.integrated, getProfile('broadcast-1080p25').audio.loudness.tolerance], [-23, 0.5]);
  // D07：真峰值一律不高于 −1.0 dBTP（作品可在 film.json 的 audio.truePeakDbTP 定更严的混音目标）
  for (const id of Object.keys(P.profiles)) assert.equal(getProfile(id).audio.loudness.truePeak, -1, id);
  // 安全区：16:9 按 EBU R95（每边 5% / 3.5%，routes/directing/VISUAL-DESIGN.md §6.3）；竖屏按平台界面的保守交集
  assert.deepEqual(web.safeArea.title, { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 });
  assert.deepEqual(web.safeArea.action, { top: 0.035, right: 0.035, bottom: 0.035, left: 0.035 });
  assert.deepEqual(getProfile('vertical-1080x1920-30').safeArea.title, { top: 0.08, right: 0.12, bottom: 0.18, left: 0.06 });
  assert.equal(getProfile('broadcast-1080p25').video.fps, 25);
  assert.deepEqual([getProfile('vertical-1080x1920-30').video.width, getProfile('vertical-1080x1920-30').video.height, getProfile('vertical-1080x1920-30').video.fps], [1080, 1920, 30]);
  assert.deepEqual([getProfile('uhd-2160p24').video.width, getProfile('uhd-2160p24').video.height], [3840, 2160]);
  assert.deepEqual([getProfile('beiming-1040p24').video.width, getProfile('beiming-1040p24').video.height], [1920, 1040]);
  for (const id of Object.keys(P.profiles)) {
    const c = getProfile(id).video.color;
    assert.deepEqual(c, { range: 'tv', matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' }, id);
    assert.ok(getProfile(id).texts.minContrast >= 3, id);
  }
  assert.deepEqual(ffprobeExpect('web-1080p24').video, {
    codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 1920, height: 1080, r_frame_rate: '24/1', avg_frame_rate: '24/1',
    sample_aspect_ratio: '1:1', field_order: 'progressive', color_range: 'tv', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709',
  });
  assert.equal(matchProfile({ width: 1920, height: 1080, fps: 24 }), 'web-1080p24');
  assert.equal(matchProfile({ width: 1280, height: 720, fps: 24 }), null);
  assert.equal(ffprobeExpect('web-1080p24').audio.profile, 'LC');
  const e = qaExpectations(v(minimalFilm()).film);
  assert.equal(e.checks.texts.minHoldFrames, 20);   // 0.8 秒 @24 fps
  assert.equal(e.checks.visual.freezeMinFrames, 12);   // 0.5 秒 @24 fps
  assert.equal(e.checks.visual.cutTolFrames, 1);
  assert.equal(e.checks.sync.lipLateFrames, 2);
  assert.deepEqual(e.source.overrides, []);
  assert.deepEqual(e.aigc, { contains: false, markerRequired: false, kinds: [], explicit: [], metadataKey: 'comment', metadata: 'required' });
  // 作品的 qa 段按键覆盖档位阈值，期望值照实写出覆盖了什么
  const o = qaExpectations(v(minimalFilm({ qa: { texts: { minHoldSec: 1.0 }, safeArea: { title: { bottom: 0.18 } } } })).film);
  assert.equal(o.checks.texts.minHoldFrames, 24);
  assert.equal(o.safeArea.title.bottom, 0.18);
  assert.equal(o.safeArea.title.top, 0.05);
  assert.deepEqual(o.source.overrides.sort(), ['safeArea.title', 'texts.minHoldSec']);
  const ai = qaExpectations(v(minimalFilm({ aigc: { contains: true, note: '底板为 AI 生成后人工整理' } })).film);
  assert.deepEqual([ai.aigc.markerRequired, ai.aigc.kinds, ai.aigc.explicit], [true, ['visual'], [AIGC_MARK]]);
});

test('档位表就是 QA 读的那一份：tools/qa 读它不需要任何兜底，数值与 QA 内置档位一致（只有一把尺子）', async () => {
  const qa = await import('../../tools/qa/lib/profiles.mjs');
  const store = qa.loadProfiles({ root: REPO });
  assert.equal(store.source, 'engine/production/profiles.json');
  assert.deepEqual(store.warnings, []);
  for (const [id, p] of store.profiles) {
    assert.deepEqual(p.warnings, [], id);
    const mine = getProfile(id);
    assert.deepEqual([p.width, p.height, p.fps], [mine.video.width, mine.video.height, mine.video.fps], id);
    assert.deepEqual([p.audio.integratedLufs, p.audio.lufsTolerance, p.audio.truePeakMaxDbtp], [mine.audio.loudness.integrated, mine.audio.loudness.tolerance, mine.audio.loudness.truePeak], id);
    assert.deepEqual([p.video.colorRange, p.video.colorSpace, p.video.colorPrimaries, p.video.colorTransfer], Object.values(mine.video.color), id);
    for (const k of ['texts', 'visual', 'sync', 'plates']) {
      for (const [key, val] of Object.entries(mine[k])) assert.deepEqual(p[k][key], val, `${id}.${k}.${key}`);
    }
    assert.deepEqual(p.safeArea.title, mine.safeArea.title, id);
  }
  // 作品 qa 段的覆盖：两边合并规则相同
  const film = v(minimalFilm({ qa: { visual: { freezeMinSec: 0.75 }, safeArea: { title: 0.08 } } })).film;
  const theirs = qa.resolveProfile(store, film.output.profile, { profile: film.output.profile, qa: film.qa, audioMode: 'none' });
  const ours = effectiveProfile(film).profile;
  assert.equal(theirs.visual.freezeMinSec, ours.visual.freezeMinSec);
  assert.deepEqual(theirs.safeArea.title, ours.safeArea.title);
});

test('AIGC 的显式标识文字与合规库 tools/compliance/lib/aigc.mjs 一致', async () => {
  const { EXPLICIT } = await import('../../tools/compliance/lib/aigc.mjs');
  assert.deepEqual(AIGC_KINDS, EXPLICIT);
  assert.ok(errors(v(minimalFilm({ aigc: { contains: true, note: 'x', kinds: ['visual', 'smell'] } }))).includes('aigc-invalid'));
  assert.ok(errors(v(minimalFilm({ aigc: { contains: false, kinds: ['visual'] } }))).includes('aigc-invalid'));
  assert.deepEqual(errors(v(minimalFilm({ aigc: { contains: true, note: '配音为 AI 合成', kinds: ['voice'] } }))), []);
  assert.ok(errors(v(minimalFilm({ aigc: { note: '没写 contains' } }))).includes('aigc-invalid'));
});

test('路线：注册表 id 是规范值，别名只提示；后端按路线校验', () => {
  assert.ok(warnings(v(minimalFilm({ route: 'c-style' }))).includes('route-alias'));
  assert.ok(errors(v(minimalFilm({ route: 'd' }))).includes('route-invalid'));
  assert.ok(errors(v(minimalFilm({ backend: 'native' }))).includes('backend-invalid'));
  assert.ok(errors(v(minimalFilm({ backend: undefined }))).includes('backend-missing'));
  for (const backend of ['canvas', 'svg', 'dom', 'three', 'webgl']) assert.deepEqual(errors(v(minimalFilm({ backend }))), [], backend);
  // A 路线必须写 style；B 路线只能 native
  assert.ok(errors(v(minimalFilm({ route: 'a', backend: 'three' }))).includes('style-missing'));
  assert.deepEqual(errors(v(minimalFilm({ route: 'a', backend: 'three', style: { id: 'beiming-original', version: 1 } }))), []);
  assert.ok(errors(v(minimalFilm({ route: 'b', backend: 'three' }))).includes('backend-invalid'));
});

test('路线专属段：native 只属于 B，cuecheck 只属于页面型路线', () => {
  assert.ok(errors(v(minimalFilm({ native: { entry: 'film.tsx' } }))).includes('native-wrong-route'));
  const b = minimalFilm({ route: 'b', backend: 'native', audio: { mode: 'native' }, native: { entry: 'film.tsx', mux: 'copy', images: [{ from: 'x.png', to: 'x.png' }] } });
  assert.deepEqual(errors(v(b)), []);
  b.native.mux = 'ffmpeg';
  assert.ok(errors(v(b)).includes('native-invalid'));
  assert.ok(errors(v(minimalFilm({ route: 'b', backend: 'native', cuecheck: { grid: 2 } }))).includes('cuecheck-wrong-route'));
  assert.deepEqual(errors(v(minimalFilm({ cuecheck: { grid: 2, tolMs: 0.5, silence: ['A'], quietDb: 15 } }))), []);
  assert.ok(errors(v(minimalFilm({ cuecheck: { grid: 0 } }))).includes('cuecheck-invalid'));
  assert.ok(errors(v(minimalFilm({ audio: { mode: 'native' } }))).includes('audio-mode-invalid'));
});

test('闸门在 film.json 里只能全开；署名与 AIGC 标识必填', () => {
  assert.ok(errors(v(minimalFilm({ gates: { look: 'skip', animatic: 'required', final: 'required' } }))).includes('gates-relaxed'));
  assert.ok(errors(v(minimalFilm({ gates: { review: 'required' } }))).includes('gates-invalid'));
  assert.deepEqual(errors(v(minimalFilm({ gates: { look: 'required', animatic: 'required', final: 'required' } }))), []);
  const noCredits = minimalFilm(); delete noCredits.credits;
  assert.ok(errors(v(noCredits)).includes('credits-missing'));
  const noAigc = minimalFilm(); delete noAigc.aigc;
  assert.ok(errors(v(noAigc)).includes('aigc-missing'));
  assert.ok(errors(v(minimalFilm({ aigc: { contains: true } }))).includes('aigc-invalid'));
  assert.ok(warnings(v(minimalFilm({ credits: [{ what: '底板', owner: '本项目', license: '待补' }] }))).includes('credit-license-pending'));
  assert.ok(errors(v(minimalFilm({ credits: [{ what: '字体' }] }))).includes('credit-invalid'));
  assert.ok(errors(v(minimalFilm({ methodRefs: [{ caseId: 'local-beiming-film-9min', borrowed: '镜头表', catalogStatus: 'rejected', license: '本项目' }] }))).includes('method-ref-rejected'));
});

test('qa 段：刻意画面是整数帧半开区间、要写理由；顶层 holds 已并入 qa.intentional；海报帧在片内', () => {
  const ok = minimalFilm({ qa: { intentional: [{ kind: 'black', from: 0, to: 6, reason: '片头黑场' }, { kind: 'flash', from: 60, to: 62, reason: '拍点闪白' }] }, posterFrame: 70 });
  assert.deepEqual(errors(v(ok)), []);
  assert.deepEqual(intentionalRanges(ok).map(r => [r.kind, r.from, r.to]), [['black', 0, 6], ['flash', 60, 62]]);
  assert.ok(errors(v(minimalFilm({ qa: { intentional: [{ kind: 'black', from: 0, to: 6 }] } }))).includes('qa-intentional-invalid'));
  assert.ok(errors(v(minimalFilm({ qa: { intentional: [{ kind: 'freeze', from: 90, to: 100, reason: 'x' }] } }))).includes('qa-range-invalid'));
  assert.ok(errors(v(minimalFilm({ qa: { intentional: [{ kind: 'pause', from: 0, to: 6, reason: 'x' }] } }))).includes('qa-intentional-invalid'));
  // 旧写法 holds / blackouts / flashes 在 qa 里照读（QA 也认），提示并进 intentional
  const alias = v(minimalFilm({ qa: { blackouts: [{ from: 90, to: 96, reason: '片尾黑场' }] } }));
  assert.deepEqual(errors(alias), []);
  assert.ok(warnings(alias).includes('qa-intentional-alias'));
  // 顶层 holds：QA 不读，判错并给出搬法；migrateV2 自动搬
  const legacy = minimalFilm({ holds: [{ in: 0, out: 6, kind: 'black', reason: '片头黑场' }] });
  assert.ok(errors(v(legacy)).includes('holds-moved'));
  const m = migrateV2(legacy);
  assert.equal(m.changed, true);
  assert.equal(m.film.holds, undefined);
  assert.deepEqual(m.film.qa.intentional, [{ kind: 'black', from: 0, to: 6, reason: '片头黑场' }]);
  assert.deepEqual(errors(v(m.film)), []);
  // 阈值覆盖：键名必须是档位里有的；类型相同；豁免要有批准人、原话、出处，agent 不能批
  assert.ok(warnings(v(minimalFilm({ qa: { texts: { minHoldSeconds: 1 } } }))).includes('qa-override-unknown'));
  assert.ok(errors(v(minimalFilm({ qa: { visual: { freezeMinSec: '1s' } } }))).includes('qa-override-invalid'));
  assert.ok(errors(v(minimalFilm({ qa: { clearColor: 'black' } }))).includes('qa-override-invalid'));
  const waiver = { check: 'texts.duration', target: 'subtitle', frames: [90, 96], reason: '片尾副标题随最后一拍落定', approvedBy: '用户', quote: '最后那行字停短点没关系', source: '会话 2026-11-10 第 12 条' };
  assert.deepEqual(errors(v(minimalFilm({ qa: { waivers: [waiver] } }))), []);
  assert.ok(errors(v(minimalFilm({ qa: { waivers: [{ ...waiver, approvedBy: 'agent' }] } }))).includes('qa-waiver-agent'));
  assert.ok(errors(v(minimalFilm({ qa: { waivers: [{ ...waiver, quote: undefined }] } }))).includes('qa-waiver-invalid'));
  assert.ok(warnings(v(minimalFilm({ qa: { waivers: [{ check: 'texts.duration', status: 'proposed' }] } }))).includes('qa-waiver-proposed'));
  assert.ok(errors(v(minimalFilm({ qa: { waivers: [{ ...waiver, frames: [90, 100] }] } }))).includes('qa-waiver-invalid'));
  assert.ok(errors(v(minimalFilm({ posterFrame: 96 }))).includes('poster-invalid'));
});

test('qa 段的校验与机器 QA 的读法一致：QA 采用的豁免这里也合格，QA 丢弃的这里判错', async () => {
  const { validateWaiver } = await import('../../tools/qa/lib/waivers.mjs');
  const base = { check: 'texts.duration', reason: 'r', approvedBy: '用户', quote: '可以', source: '会话第 3 条' };
  for (const w of [base, { ...base, approvedBy: 'AI 助手' }, { ...base, quote: '' }, { ...base, frames: [10, 5] }, { ...base, source: undefined }]) {
    const theirs = validateWaiver(w).length === 0;
    const ours = !errors(v(minimalFilm({ qa: { waivers: [w] } }))).some(c => c.startsWith('qa-waiver'));
    assert.equal(ours, theirs, JSON.stringify(w));
  }
});

test('events[].sync 用 QA 的取值：lip / soft / none（不写 = 硬门）；布尔值与 cue 是旧写法', () => {
  for (const sync of ['lip', 'soft', 'none']) {
    const f = minimalFilm(); f.events[0].sync = sync;
    assert.deepEqual(errors(v(f)), [], sync);
  }
  const bad = minimalFilm(); bad.events[0].sync = 'hard';
  assert.ok(errors(v(bad)).includes('event-sync-invalid'));
  const legacy = minimalFilm(); legacy.events[0].sync = false;
  assert.ok(errors(v(legacy)).includes('event-sync-legacy'));
  assert.equal(migrateV2(legacy).film.events[0].sync, 'none');
  const cue = minimalFilm(); delete cue.events[0].audio; cue.events[0].cue = 'hit';
  assert.ok(errors(v(cue)).includes('event-cue-moved'));
  assert.equal(migrateV2(cue).film.events[0].audio, 'hit');
  const silent = minimalFilm(); delete silent.events[0].audio; silent.events[0].sync = 'lip';
  assert.ok(warnings(v(silent)).includes('event-sync-without-audio'));
  // 期望值：needsSound 与 QA 的判断一致（有 audio 且 sync 不是 none）
  const e = qaExpectations(v(minimalFilm({ events: [{ id: 'a.bed', frame: 0, shot: 'S1', end: 48, audio: 'bed', sync: 'none' }, { id: 'a.hit', frame: 60, shot: 'S2', audio: 'hit' }] })).film);
  assert.deepEqual(e.events.map(x => [x.id, x.sync, x.needsSound]), [['a.bed', 'none', false], ['a.hit', 'default', true]]);
});

test('next 是模版专用字段：模版里按注册表的步骤格式校验，作品里只提示', () => {
  const step = { stage: 'look', title: '先出三张关键帧', run: ['node', 'engine/render/still.mjs', '{dir}', '0', '{mid}', '{last}'] };
  const tpl = minimalFilm({ id: '{{NAME}}', title: '{{TITLE}}', next: [step] });
  assert.deepEqual(errors(v(tpl, { template: true })), []);
  assert.deepEqual(warnings(v(tpl, { template: true })).filter(c => c === 'unknown-field'), []);
  assert.ok(errors(v(minimalFilm({ id: '{{NAME}}', title: '{{TITLE}}', next: [{ ...step, stage: 'render' }] }), { template: true })).includes('next-invalid'));
  assert.ok(errors(v(minimalFilm({ id: '{{NAME}}', title: '{{TITLE}}', next: [{ ...step, run: 'node x.mjs' }] }), { template: true })).includes('next-invalid'));
  assert.ok(warnings(v(minimalFilm({ next: [step] }))).includes('next-in-film'));
});

test('v1 记录自动升级：frameCount = round(dur × fps)，整片一个镜头，poster 秒数换成帧', () => {
  const { film, notes } = upgradeFilm({ route: 'c', title: 'x', dur: 2.99, fps: 24, size: [1920, 1080], poster: 1.5 }, { dirName: 'x' });
  assert.equal(film.output.frameCount, 72);
  assert.equal(film.output.profile, 'web-1080p24');
  assert.deepEqual(film.shots, [{ id: 'S1', in: 0, out: 72 }]);
  assert.equal(film.posterFrame, 36);
  assert.ok(notes.some(n => n.includes('已取整')));
  const r = v({ route: 'c', title: 'x', dur: 3, fps: 24, size: [1920, 1080] }, { dirName: 'x' });
  assert.equal(r.upgraded, true);
  assert.deepEqual(errors(r), []);
  assert.ok(warnings(r).includes('v1-upgraded'));
  // v1 画幅对不上任何档位：判错并指出要写 output.profile
  assert.ok(errors(v({ route: 'c', title: 'x', dur: 3, fps: 24, size: [1280, 720] }, { dirName: 'x' })).includes('profile-unmatched'));
  // 不认识的版本拒绝自动解释；ProjectSpec 不是 film.json
  assert.ok(errors(v({ schemaVersion: 3 })).includes('schema-version-unknown'));
  assert.ok(errors(v({ schemaVersion: 1, projectId: 'x', execution: {} })).includes('projectspec-not-film'));
  assert.ok(errors(v({ title: 'x' })).includes('schema-version-missing'));
});

test('占位符：模版只许 {{NAME}} / {{TITLE}}，作品里不许残留', () => {
  const tpl = minimalFilm({ id: '{{NAME}}', title: '{{TITLE}}' });
  assert.deepEqual(errors(v(tpl, { template: true })), []);
  assert.ok(errors(v(tpl)).includes('placeholder-left'));
  assert.ok(errors(v(minimalFilm({ id: '{{NAME}}', title: '{{TITLE}}', notes: '{{BRIEF}}' }), { template: true })).includes('placeholder-unknown'));
});

test('引用的文件按作品目录核对存在（loadFilm 默认核对；--no-files 不核对）', () => {
  const t = tempFilm(minimalFilm({ shots: [{ id: 'S1', in: 0, out: 48, module: 'shots/s1.js' }, { id: 'S2', in: 48, out: 96 }] }));
  try {
    const L = loadFilm(t.dir);
    assert.ok(errors(L).includes('file-missing'));
    assert.deepEqual(errors(loadFilm(t.dir, { checkFiles: false })), []);
    assert.ok(errors(loadFilm(t.dir, { checkFiles: true })).includes('file-missing'));
  } finally { t.cleanup(); }
  const ok = tempFilm(minimalFilm({ shots: [{ id: 'S1', in: 0, out: 48, module: 'shots/s1.js' }, { id: 'S2', in: 48, out: 96 }] }), { 'shots/s1.js': 'export default {};\n' });
  try { assert.deepEqual(errors(loadFilm(ok.dir)), []); } finally { ok.cleanup(); }
});

test('页面自带的 timeline.js 与 film.json 的帧数必须一致', () => {
  const t = tempFilm(minimalFilm(), { 'timeline.js': 'export const FPS = 24;\nexport const DUR = 3;\n' });
  try { assert.ok(errors(loadFilm(t.dir)).includes('page-timing-mismatch')); } finally { t.cleanup(); }
  const ok = tempFilm(minimalFilm(), { 'timeline.js': 'export const FPS = 24;\nexport const DUR = 4;\n' });
  try { assert.deepEqual(errors(loadFilm(ok.dir)), []); } finally { ok.cleanup(); }
});

test('三条路线的模版按 --template 校验都通过（v1 自动升级读取）', () => {
  for (const slug of ['a-webgl', 'b-native', 'c-style']) {
    const L = loadFilm(join(REPO, 'routes', slug, 'template'), { template: true });
    assert.deepEqual(errors(L), [], slug);
  }
});

test('《北冥》镜像作品通过校验：v2、beiming-1040p24、三镜、路径相对仓库根', () => {
  const L = loadFilm(join(REPO, 'films', 'beiming-10s'));
  assert.deepEqual(errors(L), []);
  assert.equal(L.film.output.profile, 'beiming-1040p24');
  assert.deepEqual(L.film.shots.map(s => [s.id, s.in, s.out]), [['A', 0, 72], ['B', 72, 120], ['C', 120, 240]]);
  assert.equal(L.pathBase, REPO.replace(/[\\/]$/, ''));
  const raw = JSON.parse(readFileSync(join(REPO, 'films', 'beiming-10s', 'film.json'), 'utf8'));
  assert.equal(raw.mirror.frozen, true);
  assert.equal(clone(raw).schemaVersion, 2);
});
