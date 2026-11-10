// 时间轴：镜头表与事件表是唯一时间源（计划 P05·M1；北极星验收第 4 条）。
// 核心用例：只改一个镜头的 out，切点、事件、QA 期望、镜头局部帧与给页面的 shots 表同步变化，不改任何代码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFilm, qaExpectations, retime, validateFilm } from '../../engine/production/film.js';
import {
  TimelineError, beatAt, beatGrid, beatOf, cutList, eventsSignature, frameOfBeat, frameToSeconds, globalFrame, legacyEvents, legacyTimeline,
  localFrame, offGrid, parseTimecode, retimeShot, secondsToFrame, sectionsFromTempo, shotAt, shotSignature, stageShots, tempoSecs, timecode,
  timingOf, timingSignature, filmTempo, pageTiming,
} from '../../engine/production/timeline.js';
import { createTempo, createTempoFromFrames } from '../../engine/core/tempo.js';
import { REPO, minimalFilm } from './helpers.mjs';

const beiming = () => JSON.parse(readFileSync(join(REPO, 'films', 'beiming-10s', 'film.json'), 'utf8'));

test('帧 ↔ 秒：秒只由 帧 / fps 推出，取整方式写明', () => {
  assert.equal(frameToSeconds(36, 24), 1.5);
  assert.equal(secondsToFrame(0.4, 24, 'floor'), 9);     // 9.6 帧：所在的那一帧
  assert.equal(secondsToFrame(0.4, 24, 'ceil'), 10);     // t ≥ 0.4 的第一帧
  assert.equal(secondsToFrame(0.4, 24, 'round'), 10);
  assert.equal(secondsToFrame(5.45, 24, 'ceil'), 131);   // 130.8 → 131（浮点误差被吸收）
  assert.equal(secondsToFrame(3, 24, 'exact'), 72);
  assert.throws(() => secondsToFrame(0.4, 24, 'exact'), e => e instanceof TimelineError && e.code === 'not-on-frame');
  assert.throws(() => secondsToFrame(1, 23.976), e => e.code === 'fps-invalid');
  assert.equal(timecode(1234, 24), '00:00:51:10');
  assert.equal(parseTimecode('00:00:51:10', 24), 1234);
  assert.throws(() => parseTimecode('00:00:51:24', 24), e => e.code === 'timecode-invalid');
  assert.deepEqual(timingOf({ dur: 2.99, fps: 24, size: [1920, 1080] }).frameCount, 72);
});

test('镜头：帧 → 镜头 → 局部帧，局部帧 → 全局帧，切点表与给页面的 shots 表', () => {
  const f = beiming();
  assert.equal(shotAt(f, 71).id, 'A');
  assert.equal(shotAt(f, 72).id, 'B');
  assert.equal(shotAt(f, 240), null);
  assert.deepEqual(localFrame(f, 130), { shot: 'C', local: 10, frame: 130 });
  assert.equal(globalFrame(f, 'B', 0), 72);
  assert.throws(() => globalFrame(f, 'B', 48), e => e.code === 'local-out-of-range');
  assert.deepEqual(cutList(f).map(c => [c.frame, c.from, c.to]), [[72, 'A', 'B'], [120, 'B', 'C']]);
  const shots = { A: { name: 'a' }, B: { name: 'b' }, C: { name: 'c' } };
  assert.deepEqual(stageShots(f, shots).map(s => s.at), [0, 3, 5]);
  assert.throws(() => stageShots(f, { A: {} }), e => e.code === 'shot-builder-missing');
});

test('只改镜头 B 的 out（120 → 132）：总长、切点、事件、QA 期望、局部帧一起变；不改代码', () => {
  const raw = beiming();
  const before = validateFilm(raw, { checkFiles: false }).film;
  const qa0 = qaExpectations(before);
  const res = retime(raw, 'B', { out: 132 });
  const after = res.normalized;
  const qa1 = qaExpectations(after);
  // 整片 252 帧，切点 [72, 132]
  assert.equal(after.output.frameCount, 252);
  assert.deepEqual(cutList(after).map(c => c.frame), [72, 132]);
  assert.deepEqual(qa0.cuts.map(c => c.frame), [72, 120]);
  assert.deepEqual(qa1.cuts.map(c => c.frame), [72, 132]);
  assert.equal(qa1.video.frameCount, 252);
  assert.equal(qa1.video.durationSeconds, 10.5);
  // 镜头 C 的事件整体后移 12 帧；镜头 A、B 里的不动；整镜铺底跟着新出点
  const at = film => Object.fromEntries(film.events.map(e => [e.id, e]));
  const e0 = at(before), e1 = at(after);
  for (const e of before.events) {
    const shift = e.shot === 'C' ? 12 : 0;
    assert.equal(e1[e.id].frame, e.frame + shift, e.id);
  }
  assert.equal(e1['hud.scan'].frame, 143);
  assert.equal(e1['b.amb_close'].end, 132);
  assert.equal(e1['c.amb_open'].end, 252);
  assert.equal(e0['title.bei'].frame + 12, qa1.events.find(x => x.id === 'title.bei').frame);
  assert.equal(qa1.events.find(x => x.id === 'title.bei').seconds, 228 / 24);
  // 镜头 C 的局部时间从 0 起：新第 132 帧是 C 的第 0 帧；镜头 B 多出 12 帧
  assert.deepEqual(localFrame(after, 132), { shot: 'C', local: 0, frame: 132 });
  assert.deepEqual(localFrame(after, 131), { shot: 'B', local: 59, frame: 131 });
  assert.deepEqual(stageShots(after, { A: 1, B: 2, C: 3 }).map(s => s.at), [0, 3, 5.5]);
  // 给旧消费者的导出也跟着变（声音表的 t）
  assert.equal(legacyTimeline(after).dur, 10.5);
  assert.equal(legacyEvents(after).ev.find(x => x.id === 'hud.scan').t, 143 / 24);
  // 只平移不改内容的镜头 C：位置无关签名不变（ripple 不让它重渲）；镜头 B 变了
  assert.equal(shotSignature(after, 'C'), shotSignature(before, 'C'));
  assert.notEqual(shotSignature(after, 'B'), shotSignature(before, 'B'));
  // 镜头 C 的鲲按镜头 C 的设计帧一拍三（src/shotC.js 的 f = fg - FSHIFT）：时钟起点跟着镜头平移
  assert.equal(after.shots[2].actorClockOrigin.kun, 12);
  assert.equal(after.shots[1].actorClockOrigin.girl, 72);
  assert.notEqual(timingSignature(after), timingSignature(before));
  // 改切点前后的描述都合格；原对象没被改
  assert.deepEqual(validateFilm(res.film, { checkFiles: false }).diagnostics.filter(d => d.level === 'error'), []);
  assert.equal(raw.output.frameCount, 240);
  assert.equal(res.film.dur, 10.5);   // v1 兼容镜像同步
});

test('roll 只挪切点：总长不变，切点上的事件跟着切点走；会让事件换镜头的 roll 拒绝', () => {
  const raw = beiming();
  const r = retime(raw, 'B', { out: 123 }, { mode: 'roll' });
  assert.equal(r.normalized.output.frameCount, 240);
  const e = Object.fromEntries(r.film.events.map(x => [x.id, x]));
  assert.equal(e['hud.on'].frame, 123);
  assert.equal(e['c.open'].frame, 123);
  assert.equal(e['b.amb_close'].end, 123);
  assert.equal(e['hud.remind'].frame, 125);
  // 从切点起算的角色时钟跟着切点走（GIRL_SHOT.start = TIMELINE.B）
  const early = retime(raw, 'A', { out: 66 }, { mode: 'roll' });
  assert.equal(early.film.shots[1].actorClockOrigin.girl, 66);
  assert.throws(() => retime(raw, 'B', { out: 126 }, { mode: 'roll' }), err => err.code === 'retime-conflict' && /hud\.remind/.test(err.message));
  assert.throws(() => retime(raw, 'C', { out: 200 }, { mode: 'roll' }), err => err.code === 'retime-args');
});

test('刻意画面与豁免帧段（qa 段）也跟着镜头走：ripple 平移、roll 贴切点、缩短时冲突拒绝；QA 期望同步', () => {
  const film = minimalFilm({
    shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 48, out: 96 }],
    qa: {
      intentional: [{ kind: 'freeze', from: 40, to: 48, reason: 'S1 结尾停住等切' }, { kind: 'black', from: 90, to: 96, reason: '片尾黑场' }],
      waivers: [{ check: 'texts.duration', target: 'sub', frames: [84, 96], reason: '片尾字随最后一拍落定', approvedBy: '用户', quote: '最后那行字停短点没关系', source: '会话第 12 条' }],
    },
  });
  // ripple：S1 加长 12 帧 → 贴着 S1 出点的停住延长，S2 里的黑场与豁免整体后移
  const r = retime(film, 'S1', { out: 60 });
  assert.deepEqual(r.film.qa.intentional.map(x => [x.from, x.to]), [[40, 60], [102, 108]]);
  assert.deepEqual(r.film.qa.waivers[0].frames, [96, 108]);
  assert.deepEqual(r.moved.ranges.map(x => x.label), ['qa.intentional[0]', 'qa.intentional[1]', 'qa.waivers[0].frames']);
  const qa = qaExpectations(r.normalized);
  assert.deepEqual(qa.intentional.map(x => [x.kind, x.from, x.to]), [['freeze', 40, 60], ['black', 102, 108]]);
  assert.deepEqual(qa.waivers[0].frames, [96, 108]);
  // roll：只挪切点，贴切点的区间跟着切点走，其余不动
  const roll = retime(film, 'S1', { out: 44 }, { mode: 'roll' });
  assert.deepEqual(roll.film.qa.intentional.map(x => [x.from, x.to]), [[40, 44], [90, 96]]);
  // 缩短 S2：到出点为止的黑场与豁免跟着出点缩短；从被剪掉的部分开始的区间没有归宿，拒绝，不替你删
  const short = retime(film, 'S2', { out: 92 });
  assert.deepEqual(short.film.qa.intentional[1], { kind: 'black', from: 90, to: 92, reason: '片尾黑场' });
  assert.deepEqual(short.film.qa.waivers[0].frames, [84, 92]);
  assert.throws(() => retime(film, 'S2', { out: 88 }), err => err.code === 'retime-conflict' && /qa\.intentional\[1\]/.test(err.message) && !/qa\.waivers/.test(err.message));
  // 位置无关签名：只平移的 S2 签名不变（刻意画面按镜头局部帧记）
  assert.equal(shotSignature(r.normalized, 'S2'), shotSignature(validateFilm(film, { checkFiles: false }).film, 'S2'));
});

test('缩短镜头时会被剪掉的事件拒绝改动，不替你删；节拍主导的片子不许 ripple', () => {
  const raw = beiming();
  assert.throws(() => retime(raw, 'B', { out: 84 }), err => err.code === 'retime-conflict' && /girl\.touch/.test(err.message));
  const ok = retime(raw, 'B', { out: 108 });
  assert.equal(ok.normalized.output.frameCount, 228);
  assert.equal(ok.film.events.find(x => x.id === 'b.hair').end, 108);
  assert.equal(ok.film.shots[2].actorClockOrigin.kun, -12);   // 镜头 C 前移 12 帧，它的鲲时钟起点也前移（早于第 0 帧是允许的）
  const beat = minimalFilm({ drive: 'beat', timeline: { sections: [{ id: 'A', start: 0, bpm: 120, meter: 4 }] } });
  assert.throws(() => retimeShot(beat, 'S1', { out: 60 }), err => err.code === 'beat-locked');
  assert.equal(retimeShot(beat, 'S1', { out: 60 }, { mode: 'roll' }).film.shots[1].in, 60);
  assert.throws(() => retimeShot(beat, 'S1', { out: 60, length: 60 }), err => err.code === 'retime-args');
  assert.throws(() => retimeShot(beat, 'S9', { out: 60 }), err => err.code === 'shot-unknown');
});

test('节拍网格：按 BPM 分段、逐拍帧表、小节数组三种写法得到同一组拍点', () => {
  const opts = { fps: 24, frameCount: 96 };
  const a = beatGrid({ sections: [{ id: 'A', start: 0, bpm: 120, meter: 4 }] }, opts);
  const b = beatGrid({ beats: [0, 12, 24, 36, 48, 60, 72, 84] }, opts);
  const c = beatGrid({ bars: [[12, 12, 12, 12], [12, 12, 12, 12]] }, opts);
  assert.deepEqual(a.beats, [0, 12, 24, 36, 48, 60, 72, 84]);
  assert.deepEqual(b.beats, a.beats);
  assert.deepEqual(c.beats, a.beats);
  assert.deepEqual(a.barStarts, [0, 4]);
  assert.deepEqual(c.barStarts, [0, 4]);
  assert.equal(frameOfBeat(a, 5), 60);
  assert.equal(frameOfBeat(a, 5.5), 66);
  assert.deepEqual(beatAt(a, 66), { beat: 5.5, bar: 2, beatInBar: 2, frac: 0.5, section: 'A' });
  assert.equal(beatOf(a, 'A', 2, 2, 0.5), 5.5);
  assert.equal(beatOf(c, 'M', 2, 1), 4);
  // 变速：两段
  const two = beatGrid({ sections: [{ id: 'A', start: 0, bpm: 120, meter: 4 }, { id: 'B', start: 48, bpm: 90, meter: 3 }] }, opts);
  assert.deepEqual(two.beats, [0, 12, 24, 36, 48, 64, 80]);
  // 不落整帧的速度要被指出（100 BPM @24 fps = 14.4 帧一拍）
  const off = offGrid(beatGrid({ sections: [{ id: 'A', start: 0, bpm: 100, meter: 4 }] }, opts));
  assert.ok(off.length > 0 && off[0].errorMs > 0);
  assert.throws(() => beatGrid({ beats: [0, 12, 12] }, opts), e => e.code === 'timeline-invalid');
  assert.throws(() => beatGrid({ sections: [{ id: 'A', start: 3, bpm: 120, meter: 4 }] }, opts), e => e.code === 'timeline-invalid');
});

test('与 engine/core/tempo.js 同一公式：秒地址、帧地址、film.json 段落互转', () => {
  const secs = [{ id: 'A', t0: 0, bpm: 120, meter: 4 }, { id: 'B', t0: 2, bpm: 90, meter: 3 }];
  const sections = sectionsFromTempo(secs, 24);
  assert.deepEqual(sections, [{ id: 'A', start: 0, bpm: 120, meter: 4 }, { id: 'B', start: 48, bpm: 90, meter: 3 }]);
  assert.deepEqual(tempoSecs({ sections }, 24), secs);
  assert.throws(() => sectionsFromTempo([{ id: 'A', t0: 0.01, bpm: 120, meter: 4 }], 24), e => e.code === 'not-on-frame');
  const t1 = createTempo(secs, { fps: 24 });
  const t2 = createTempoFromFrames(sections, { fps: 24 });
  const grid = beatGrid({ sections }, { fps: 24, frameCount: 96 });
  for (const addr of [['A', 1, 2], ['A', 1, 3, 0.5], ['B', 1, 1], ['B', 1, 3, 0.25]]) {   // 地址都在各自段落之内
    assert.equal(t1.at(...addr), t2.at(...addr), addr.join());
    assert.equal(t2.frame(...addr), Math.floor(frameOfBeat(grid, beatOf(grid, ...addr)) + 1e-6), addr.join());
  }
  assert.equal(t2.framesPerBeat('B'), 16);
  assert.deepEqual(t2.cueFrames({ hit: ['B', 1, 2] }), { hit: 64 });
  assert.equal(t2.frameOf(2.6666666), 63);
  const film = { output: { fps: 24, frameCount: 96 }, timeline: { sections } };
  assert.equal(filmTempo(film).frame('B', 1, 2), 64);
  assert.throws(() => filmTempo({ output: { fps: 24 }, timeline: { beats: [0, 12] } }), e => e.code === 'timeline-form');
  assert.throws(() => createTempoFromFrames([{ id: 'A', start: 0.5, bpm: 120, meter: 4 }], { fps: 24 }), /非负整数帧/);
});

test('签名：事件改动不影响切点签名，切点改动不影响事件签名的内容比较', () => {
  const f = beiming();
  const g = structuredClone(f);
  g.events.find(e => e.id === 'hud.scan').frame += 1;
  assert.equal(timingSignature(g), timingSignature(f));
  assert.notEqual(eventsSignature(g), eventsSignature(f));
});

test('pageTiming：页面从 film.json 读出 DUR、镜头起止秒、事件秒；改一个镜头的 out，页面拿到的切点与事件跟着变', () => {
  const raw = beiming();
  const p = pageTiming(raw);
  assert.equal(p.DUR, 10);
  assert.equal(Math.round(p.DUR * p.fps), p.frameCount);   // 页面约定 v1（附录 C5）
  assert.deepEqual(p.shots.map(s => [s.id, s.t0, s.t1]), [['A', 0, 3], ['B', 3, 5], ['C', 5, 10]]);
  assert.deepEqual(p.at(3), { shot: 'B', index: 1, local: 0, localFrame: 0, frame: 72 });
  assert.equal(p.at(2.999).shot, 'A');
  assert.equal(p.at(10).frame, 239);   // 末尾夹到最后一帧
  assert.equal(p.event('hud.scan').t, 131 / 24);
  assert.equal(p.event('c.amb_open').t1, 10);
  assert.throws(() => p.event('nope'), e => e.code === 'event-unknown');
  // 只改镜头 B 的 out：页面不改代码，切点、镜头内时间与事件时刻都变
  const q = pageTiming(retime(raw, 'B', { out: 132 }).film);
  assert.equal(q.DUR, 10.5);
  assert.equal(q.shot('C').t0, 5.5);
  assert.equal(q.at(5.25).shot, 'B');
  assert.equal(q.at(5.5).local, 0);
  assert.equal(q.event('hud.scan').frame, 143);
  // v1 记录：整片一个镜头，没有事件
  const v1 = pageTiming({ route: 'c', title: 'x', dur: 3, fps: 24, size: [1920, 1080] });
  assert.deepEqual([v1.version, v1.frameCount, v1.shots.length, v1.events.length], [1, 72, 1, 0]);
  assert.throws(() => pageTiming({ schemaVersion: 2, output: { fps: 24, frameCount: 96 }, shots: [{ id: 'S1', in: 0, out: 40 }] }), e => e.code === 'shots-coverage');
});
