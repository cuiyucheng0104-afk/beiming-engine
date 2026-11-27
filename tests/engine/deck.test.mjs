// engine/stage/deck.js 的纯状态机与交互行为测试：章节推进、节拍切点、自动播放、静音、导览配音、画质档位轮转、声卡时钟跟随、降档阈值；
// deck-audio.js 的起播参数（相位锁定、导览 cue）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, createDeckModel, createGovernor, TIERS, TIER_CONFIGS, FPS_WINDOW_SIZE, LOW_FPS_STREAK } from '../../engine/stage/deck.js';
import { createDeckAudio, stemStartArgs, cueStartArgs } from '../../engine/stage/deck-audio.js';

test('deckModel：章节与节拍按事件帧切分，保持确定性步进', () => {
  const shots = [
    { id: 'S1', in: 0, out: 24, name: '第一章' },
    { id: 'S2', in: 24, out: 48, name: '第二章', split: true },
  ];
  const events = [
    { id: 'e1', frame: 10, visual: '节拍一' },
    { id: 'e2', frame: 36, visual: '节拍二' },
  ];
  const model = createDeckModel({ shots, events, fps: 24, dur: 2 });
  const s0 = model.getSnapshot();
  assert.equal(s0.totalChapters, 2);
  assert.equal(s0.totalFrames, 48);
  assert.equal(s0.chapterIndex, 0);
  assert.equal(s0.frame, 0);
  assert.equal(s0.beats.length, 4, '两章起点 + 两个事件帧（0 与首章起点重合）');

  // nextBeat：步进到下一拍
  model.nextBeat();
  let snap = model.getSnapshot();
  assert.equal(snap.playing, true);
  // step 步进半秒（12 帧），到达 targetHoldFrame (10) 后自动停住
  model.step(0.5);
  snap = model.getSnapshot();
  assert.equal(snap.frame, 10);
  assert.equal(snap.playing, false);
  assert.equal(snap.beat.name, '节拍一');

  // nextChapter：直接跳到第二章 (24)
  model.nextChapter();
  snap = model.getSnapshot();
  assert.equal(snap.frame, 24);
  assert.equal(snap.chapterIndex, 1);
  assert.equal(snap.chapter.name, '第二章');

  // prevBeat：回到前一拍 (10)
  model.prevBeat();
  snap = model.getSnapshot();
  assert.equal(snap.frame, 10);

  // 导览配音与静音独立状态
  assert.equal(snap.voEnabled, false, '导览配音默认关闭');
  assert.equal(model.toggleVo(), true);
  assert.equal(model.getSnapshot().voEnabled, true);
  assert.equal(model.toggleMute(), true);
  assert.equal(model.getSnapshot().muted, true);

  // 画质档位
  assert.equal(snap.tier, 'full');
  assert.equal(model.setTier('low'), true);
  assert.equal(model.getSnapshot().tier, 'low');
  assert.equal(model.getSnapshot().tierConfig.kuwaharaRadius, 0);
  assert.equal(model.setTier('ultra'), false, '不认识的档位不接');
  assert.equal(model.setTier('low'), false, '同一档不重复报');
});

test('deckModel：播放中以声卡时钟为准——手动模式走到目标拍停住，自动模式一路跟随，不越界', () => {
  const shots = [{ id: 'S1', in: 0, out: 96 }, { id: 'S2', in: 96, out: 192 }];
  const events = [{ id: 'b', frame: 48 }];
  const model = createDeckModel({ shots, events, fps: 24, dur: 8 });

  // 手动：0 → 48 帧。声卡时钟一口气报到 3 秒（72 帧），画面停在目标拍 48 并停播
  model.nextBeat();
  model.followTime(3);
  let snap = model.getSnapshot();
  assert.equal(snap.frame, 48);
  assert.equal(snap.playing, false);
  model.followTime(1.5);
  assert.equal(model.getSnapshot().frame, 36, '没走到目标拍时逐帧跟随');
  // 时钟回退（拖动进度）也被跟随；负数夹到 0
  model.followTime(0.25);
  assert.equal(model.getSnapshot().frame, 6);
  model.followTime(-5);
  assert.equal(model.getSnapshot().frame, 0);

  // 自动：连续跟随直到片尾
  model.toggleAuto();
  model.followTime(7.99);
  snap = model.getSnapshot();
  assert.equal(snap.autoMode, true);
  assert.equal(snap.totalFrames, 192);
  assert.equal(snap.frame, 191, '夹到最后一帧（总帧数 − 1）');
  assert.equal(snap.playing, false, '到片尾停');
  model.toggleAuto();
  model.toggleAuto();
  model.followTime(4.5);
  snap = model.getSnapshot();
  assert.equal(snap.frame, 108);
  assert.equal(snap.chapter.id, 'S2');

  // 分屏位置夹到 0..1
  model.setSplit(1.7);
  assert.equal(model.getSnapshot().splitRatio, 1);
  model.setSplit(-1);
  assert.equal(model.getSnapshot().splitRatio, 0);
});

test('deck：到拍的回调内停声并对齐画面，从停点恢复，自动播放可越过节拍', t => {
  const model = createDeckModel({ shots: [{ id: 's', in: 0, out: 96 }], events: [{ frame: 24 }, { frame: 48 }], fps: 24, dur: 4 });
  let next, now = 0, clock = 0, playing = false, rendered;
  const win = new EventTarget(), calls = [];
  win.requestAnimationFrame = callback => { next = callback; return 1; };
  win.cancelAnimationFrame = () => { next = null; };
  const tick = () => { now += 16; next(now); };
  const audio = {
    isPlaying: () => playing, currentTime: () => clock,
    play(time) { calls.push(['play', time]); clock = time; playing = true; },
    pause() { calls.push(['pause']); playing = false; },
    seek(time) { calls.push(['seek', time]); clock = time; },
  };
  const deck = createDeck({ root: new EventTarget(), win, model, audio,
    onRender(time) { rendered = { time, playing, clock }; } });
  t.after(() => deck.dispose());
  model.nextBeat(); deck.start(); tick();
  assert.deepEqual(calls.splice(0), [['play', 0]]);
  clock = 1.03; tick();
  assert.equal(model.getSnapshot().frame, 24);
  assert.equal(model.getSnapshot().playing, false);
  assert.deepEqual(rendered, { time: 1, playing: false, clock: 1 });
  assert.deepEqual(calls.splice(0), [['pause'], ['seek', 1]]);
  tick(); tick();
  assert.deepEqual(calls, []);
  model.nextBeat(); tick();
  assert.deepEqual(calls.splice(0), [['play', 1]]);
  model.toggleAuto(); clock = 2.25; tick();
  assert.deepEqual(rendered, { time: 2.25, playing: true, clock: 2.25 });
  assert.deepEqual(calls, []);
  model.togglePlay(); tick();
  assert.deepEqual(calls.splice(0), [['pause'], ['seek', 2.25]]);
  model.togglePlay(); tick();
  assert.deepEqual(calls, [['play', 2.25]]);
});

test('governor：平均帧率持续低于 32 fps 才降档；卡得厉害更快降；手动锁定的档不降', () => {
  const run = (fps, { frames, locked = false, threshold = 32 } = {}) => {
    const g = createGovernor({ threshold });
    let downAt = null, n = 0;
    for (let i = 0; i < frames; i++) { if (g.feed(1 / fps, locked)) { downAt ??= i + 1; n++; } }
    return { downAt, n, fps: g.fps };
  };
  // 60 fps、33 fps（阈值之上）：永不降档
  assert.equal(run(60, { frames: 2000 }).downAt, null);
  assert.equal(run(33, { frames: 2000 }).downAt, null);
  // 31 fps：窗口填满的那一帧（第 30 帧）起连续 45 帧偏低 → 第 74 帧降档；之后每 45 帧再报一次
  let r = run(31, { frames: 200 });
  assert.equal(r.downAt, FPS_WINDOW_SIZE + LOW_FPS_STREAK - 1);
  assert.equal(r.n, 3);
  assert.ok(Math.abs(r.fps - 31) < 1e-6);
  // 10 fps（低于阈值一半）：每帧按 3 帧计 → 第 45 帧
  r = run(10, { frames: 60 });
  assert.equal(r.downAt, 30 + 15 - 1);
  // 锁定：不降
  assert.equal(run(5, { frames: 300, locked: true }).downAt, null);
  // 偶尔掉帧不算：九帧 60 fps、一帧 10 fps → 实际 40 fps，不降；dt ≤ 0 的帧不计
  const g = createGovernor();
  for (let i = 0; i < 400; i++) { assert.equal(g.feed(i % 10 ? 1 / 60 : 0.1, false), false); g.feed(0, false); }
  assert.equal(g.feed(-1, false), false);
});

test('相位锁定的起播参数：每轨按时间轴 0 秒对齐循环，循环长度不同也不漂；导览 cue 按时间轴对齐', () => {
  // 时间轴 45 秒、20 秒一循环的轨：已经循环到 5 秒 → 5 秒前起播（现在正好播到相位 5）
  assert.deepEqual(stemStartArgs(45, 20), { delay: 0, offset: 5 });
  // 40 秒一循环的轨在同一时刻：相位 5 → 两轨的循环起点都落在时间轴 0、20、40 秒
  assert.deepEqual(stemStartArgs(45, 40), { delay: 0, offset: 5 });
  // 恰在循环点上：不提前
  assert.deepEqual(stemStartArgs(40, 20), { delay: 0, offset: 0 });
  assert.ok(stemStartArgs(0, 20).delay === 0, '从 0 秒起播不提前');
  assert.deepEqual(stemStartArgs(3, 0), { delay: 0, offset: 0 }, '没有循环长度就从头播');
  // 10 秒与 20 秒两条轨：各自相位之和在时间轴上每 20 秒回到同一组关系（相位锁定）
  for (let t = 0; t <= 200; t += 2.5) {
    const a = stemStartArgs(t, 10).offset, b = stemStartArgs(t, 20).offset;
    assert.ok(Math.abs(a - (b % 10)) < 1e-9, `t=${t}`);
  }

  const cue = { at: 12, buffer: { duration: 1.5 } };
  assert.deepEqual(cueStartArgs(cue, 0), { delay: 12, offset: 0 }, '还没到：12 秒后从头播');
  assert.deepEqual(cueStartArgs(cue, 12.5), { delay: 0, offset: 0.5 }, '播到一半 seek 进来：从素材 0.5 秒处接着播');
  assert.equal(cueStartArgs(cue, 13.5), null, '已经播完的不补播');
  assert.equal(cueStartArgs({ at: 0, buffer: null }, 0), null, '没有素材的不播');
});

test('画质档位：从高到低逐档减负，满档放得下 30,000 实例的实测段，最低档降分辨率', () => {
  assert.deepEqual(TIERS, ['full', 'medium', 'low', 'minimal']);
  for (const k of ['ss', 'instances', 'shaftSteps', 'hazeLayers', 'dust', 'renderScale', 'kuwaharaRadius']) {
    const vals = TIERS.map(t => TIER_CONFIGS[t][k]);
    assert.deepEqual(vals, [...vals].sort((a, b) => b - a), `${k} 要逐档不升`);
  }
  assert.equal(TIER_CONFIGS.full.instances, 30000, '满档要能放下 30,000 实例的实测段');
  assert.ok(TIER_CONFIGS.minimal.renderScale > 0 && TIER_CONFIGS.minimal.renderScale < 1);
});

test('deckModel 与空格：手动模式连续快按按目标拍推进，自动模式空格保持暂停/恢复', t => {
  const model = createDeckModel({
    shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 48, out: 96 }],
    events: [{ id: 'b1', frame: 24 }, { id: 'b2', frame: 72 }],
    fps: 24, dur: 4,
  });
  const win = new EventTarget();
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  const deck = createDeck({ root: new EventTarget(), win, model });
  t.after(() => deck.dispose());
  const pressSpace = () => {
    const e = new Event('keydown');
    e.key = ' ';
    Object.defineProperty(e, 'target', { value: { tagName: 'BODY' }, configurable: true });
    e.preventDefault = () => {};
    win.dispatchEvent(e);
  };

  // 手动模式：连续快按 2 次空格（中间只走 2 帧），目标应直接推进到第 2 个目标拍 (48)
  pressSpace();
  model.step(2 / 24);
  assert.equal(model.getSnapshot().playing, true);
  pressSpace();
  model.followTime(10);
  assert.equal(model.getSnapshot().frame, 48, '两次快按应停在第 2 目标拍而非卡在第 1 拍或被暂停');
  assert.equal(model.getSnapshot().playing, false);

  // 再连按 2 次：72 → 95（片尾）
  pressSpace();
  pressSpace();
  model.followTime(10);
  assert.equal(model.getSnapshot().frame, 95, '末拍之后继续平滑播到片尾停住');
  assert.equal(model.getSnapshot().playing, false);

  // 切到自动播放模式：空格仍负责暂停 / 恢复，不回退
  model.seekFrame(12);
  model.toggleAuto();
  assert.equal(model.getSnapshot().autoMode, true);
  assert.equal(model.getSnapshot().playing, true);
  pressSpace();
  assert.equal(model.getSnapshot().playing, false, '自动模式下按空格暂停');
  pressSpace();
  assert.equal(model.getSnapshot().playing, true, '自动模式下再按空格恢复');
});

test('deckAudio：手势前 setStem 不创建 AudioContext；早开导览与静音在首次手势后严格同步', t => {
  let ctxCount = 0;
  const gains = [];
  class FakeAudioContext {
    constructor() {
      ctxCount++;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = { id: 'dest' };
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createGain() {
      const g = {
        connected: [],
        gain: {
          value: 1,
          cancelScheduledValues() {},
          setValueAtTime(v) { this.value = v; },
          setTargetAtTime(v) { this.value = v; },
        },
        connect(dest) { this.connected.push(dest); },
      };
      gains.push(g);
      return g;
    }
    createBufferSource() {
      return { buffer: null, loop: false, connect() {}, start() {}, stop() {}, disconnect() {} };
    }
  }
  const prevWin = globalThis.window;
  globalThis.window = { AudioContext: FakeAudioContext };
  t.after(() => { if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin; });

  const audio = createDeckAudio();
  audio.setStem('pad', { name: '和声', buffer: { duration: 56 }, volume: 0.86 });
  audio.setStem('pulse', { name: '脉冲', buffer: { duration: 56 }, volume: 0.92 });
  audio.setVoCues([{ at: 1, buffer: { duration: 2 } }]);
  assert.equal(ctxCount, 0, '手势前登记分轨与导览 cue 绝不创建实时 AudioContext');
  assert.equal(audio.getStemsState().length, 2);

  // 手势前早按 V 开导览、对 pad 静音
  assert.equal(audio.setVoEnabled(true), true);
  assert.equal(audio.toggleMuteStem('pad'), true);
  assert.equal(ctxCount, 0, '未发生用户手势时仍为零 AudioContext');

  // 首次手势触发 ensureContext：masterGain[0], voGain[1], pad[2], pulse[3]
  const ctx = audio.ensureContext();
  assert.ok(ctx);
  assert.equal(ctxCount, 1);
  assert.equal(gains[0].gain.value, 1, 'masterGain 默认开启');
  assert.equal(gains[1].gain.value, 1, '早按 V 的导览增益须在创建后保持为 1');
  assert.equal(gains[2].gain.value, 0, '手势前对 pad 静音须生效');
  assert.equal(gains[3].gain.value, 0.92, 'pulse 保持设定音量');

  // Solo 切换与总静音
  audio.toggleSoloStem('pulse');
  assert.equal(gains[2].gain.value, 0);
  assert.equal(gains[3].gain.value, 0.92);
  audio.setMasterMute(true);
  assert.equal(gains[0].gain.value, 0);
});
