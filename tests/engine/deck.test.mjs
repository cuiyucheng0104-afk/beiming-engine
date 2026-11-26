// engine/stage/deck.js 的纯状态机与交互行为测试：章节推进、节拍切点、自动播放、静音、导览配音、画质档位轮转、声卡时钟跟随、降档阈值；
// deck-audio.js 的起播参数（相位锁定、导览 cue）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeckModel, createGovernor, TIERS, TIER_CONFIGS, FPS_WINDOW_SIZE, LOW_FPS_STREAK } from '../../engine/stage/deck.js';
import { stemStartArgs, cueStartArgs } from '../../engine/stage/deck-audio.js';

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
