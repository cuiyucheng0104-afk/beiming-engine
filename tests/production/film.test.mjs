// film.json v2：校验器、v1 升级、交付档位、路线专属段（计划 P05·M0，附录 C6 / C7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AIGC_MARK, ffprobeExpect, getProfile, loadFilm, loadProfiles, matchProfile, qaExpectations, upgradeFilm, validateFilm,
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
    ['停顿里的 start', f => { f.holds = [{ in: 0, out: 2, kind: 'black', reason: '片头黑场', start: 0 }]; }],
  ]) {
    const f = minimalFilm(); mutate(f);
    assert.ok(errors(v(f)).includes('orphan-time-field'), where);
  }
  const typo = minimalFilm({ titel: 'x' });
  const r = v(typo);
  assert.deepEqual(errors(r), []);
  assert.ok(warnings(r).includes('unknown-field'));
  // 兼容镜像 dur / fps / size：与 output 一致时只提示，不一致判错
  assert.ok(warnings(v(minimalFilm({ dur: 4, fps: 24, size: [1920, 1080] }))).includes('legacy-mirror'));
  assert.ok(errors(v(minimalFilm({ dur: 5 }))).includes('legacy-mirror-mismatch'));
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
  assert.deepEqual([web.audio.loudness.integratedLUFS, web.audio.loudness.toleranceLU, web.audio.truePeakMaxDbTP], [-14, 1, -1]);
  assert.equal(getProfile('broadcast-1080p25').audio.loudness.integratedLUFS, -23);
  assert.equal(getProfile('broadcast-1080p25').video.fps, 25);
  assert.deepEqual([getProfile('vertical-1080x1920-30').video.width, getProfile('vertical-1080x1920-30').video.height, getProfile('vertical-1080x1920-30').video.fps], [1080, 1920, 30]);
  assert.deepEqual([getProfile('uhd-2160p24').video.width, getProfile('uhd-2160p24').video.height], [3840, 2160]);
  assert.deepEqual([getProfile('beiming-1040p24').video.width, getProfile('beiming-1040p24').video.height], [1920, 1040]);
  for (const id of Object.keys(P.profiles)) {
    const c = getProfile(id).video.color;
    assert.deepEqual(c, { range: 'tv', matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' }, id);
    assert.ok(getProfile(id).qa.text.minContrast >= 3, id);
  }
  assert.deepEqual(ffprobeExpect('web-1080p24').video, {
    codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 1920, height: 1080, r_frame_rate: '24/1', avg_frame_rate: '24/1',
    sample_aspect_ratio: '1:1', field_order: 'progressive', color_range: 'tv', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709',
  });
  assert.equal(matchProfile({ width: 1920, height: 1080, fps: 24 }), 'web-1080p24');
  assert.equal(matchProfile({ width: 1280, height: 720, fps: 24 }), null);
  const e = qaExpectations(v(minimalFilm()).film);
  assert.equal(e.checks.text.minHoldFrames, 20);   // 0.8 秒 @24 fps
  assert.equal(e.checks.cuts.toleranceFrames, 1);
  assert.equal(e.aigc.marker, AIGC_MARK);
  assert.ok(Array.isArray(e.checks.calibrate));
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

test('停顿与海报帧都是整数帧，停顿要写原因（QA 据此豁免黑场 / 静帧）', () => {
  assert.deepEqual(errors(v(minimalFilm({ holds: [{ in: 0, out: 6, kind: 'black', reason: '片头黑场' }], posterFrame: 70 }))), []);
  assert.ok(errors(v(minimalFilm({ holds: [{ in: 0, out: 6, kind: 'black' }] }))).includes('hold-invalid'));
  assert.ok(errors(v(minimalFilm({ holds: [{ in: 90, out: 100, kind: 'freeze', reason: 'x' }] }))).includes('hold-invalid'));
  assert.ok(errors(v(minimalFilm({ posterFrame: 96 }))).includes('poster-invalid'));
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
