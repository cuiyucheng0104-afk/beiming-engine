// 北冥引擎 · 演示壳：章节（shots）+ 节拍（events）两层推进的纯状态机，和挂到页面上的交互控制器。
// 三条契约：
//   1. 确定性：画面只由 render(t, input) 决定，同样的 (t, input) 逐像素相同；指针、分屏位置、画质档位都经 input 传进去，壳自己不碰镜头；
//   2. 交互：←/→ 节拍（Shift + ←/→ 切章）、O 章节总览、N 提词独立窗、F 全屏、M 总静音、A 自动/手动、V 导览配音（默认关）、
//      S 调音台、H 操作说明、T 手动换档；
//   3. 画质治理：播放中量帧间隔，平均帧率持续低于 32 fps 就自动降一档（full → medium → low → minimal），手动选过的档不再自动降。
//      阈值与窗口见 createGovernor（纯逻辑，Node 里可测）。
// 时间：播放中以声卡时钟为准（audio.currentTime，零漂移）；没有音频或暂停时按帧间隔累加。
//
//   createDeckModel({ shots, events, fps, dur }) → { seekFrame, seekTime, nextBeat, prevBeat, nextChapter, prevChapter, togglePlay, toggleAuto,
//                                                    toggleMute, toggleVo, setSplit, setTier, step, followTime, getSnapshot }
//   createGovernor() → { fps, reset(), feed(dt, tierLocked) → 是否该降档 }
//   createDeck({ root, win, model, audio, ui, onRender, onTier }) → { model, start, stop, dispose, openNotesWindow }
import { clamp } from '../core/math.js';

export const TIERS = ['full', 'medium', 'low', 'minimal'];

// 每档的旋钮：页面按档位设后期采样（ss / msaa 要重建后期）、每帧参数与实例数；renderScale 是输出像素占视口的比例
export const TIER_CONFIGS = {
  full: { ss: 2, msaa: 4, kuwaharaRadius: 4, kuwaharaStrength: 1, bloom: true, outline: 1, instances: 30000, shaftSteps: 16, hazeLayers: 3, dust: 1500, renderScale: 1 },
  medium: { ss: 1, msaa: 0, kuwaharaRadius: 2, kuwaharaStrength: 0.8, bloom: true, outline: 1, instances: 15000, shaftSteps: 12, hazeLayers: 2, dust: 800, renderScale: 1 },
  low: { ss: 1, msaa: 0, kuwaharaRadius: 0, kuwaharaStrength: 0, bloom: false, outline: 0.7, instances: 8000, shaftSteps: 8, hazeLayers: 1, dust: 300, renderScale: 0.65 },
  minimal: { ss: 1, msaa: 0, kuwaharaRadius: 0, kuwaharaStrength: 0, bloom: false, outline: 0, instances: 3000, shaftSteps: 0, hazeLayers: 0, dust: 0, renderScale: 0.4 },
};

/** 纯状态机：不依赖 DOM，Node 测试可直接测 */
export function createDeckModel({ shots = [], events = [], fps = 24, dur = 0, notes = {} } = {}) {
  const totalFrames = Math.max(1, Math.round(dur * fps));
  const chapterList = (shots.length ? shots : [{ id: 'S1', in: 0, out: totalFrames, name: '第一章' }]).map((s, i) => ({
    index: i, id: s.id ?? `S${i + 1}`, name: s.name ?? s.title ?? `第 ${i + 1} 章`,
    in: s.in ?? 0, out: s.out ?? totalFrames, note: notes[s.id] ?? s.note ?? '', split: !!s.split,
  }));

  // 节拍表：事件帧 + 各章起点，排序去重
  const beatFrames = new Set([0]);
  for (const e of events) if (Number.isInteger(e?.frame) && e.frame >= 0 && e.frame < totalFrames) beatFrames.add(e.frame);
  for (const c of chapterList) beatFrames.add(c.in);
  const beats = Array.from(beatFrames).sort((a, b) => a - b).map((f, i) => {
    const ev = events.find(e => e.frame === f);
    const ch = chapterList.slice().reverse().find(c => c.in <= f) || chapterList[0];
    return {
      index: i, frame: f, time: f / fps, id: ev?.id ?? `beat_${i}`,
      name: ev?.visual ?? ev?.desc ?? ev?.id ?? `${ch.name} · 拍 ${i + 1}`,
      chapterId: ch.id, chapterIndex: ch.index,
    };
  });

  let currentFrame = 0;
  let targetHoldFrame = beats[0]?.frame ?? 0;
  let playing = false;
  let autoMode = false;
  let muted = false;
  let voEnabled = false; // 导览配音默认关闭
  let splitRatio = 0.5; // 朱红分屏位置 0..1
  let currentTier = 'full';
  let tierLocked = false;

  function findChapter(f) {
    return chapterList.slice().reverse().find(c => c.in <= f) || chapterList[0];
  }
  function findBeat(f) {
    let b = beats[0];
    for (const item of beats) { if (item.frame <= f) b = item; else break; }
    return b;
  }

  function seekFrame(f) {
    currentFrame = clamp(Math.round(f), 0, totalFrames - 1);
    targetHoldFrame = currentFrame;
    playing = false;
  }

  function nextBeat() {
    const next = beats.find(b => b.frame > currentFrame + 0.5);
    if (next) {
      targetHoldFrame = next.frame;
      playing = true;
    } else {
      seekFrame(totalFrames - 1);
      playing = false;
    }
  }

  function prevBeat() {
    const prev = beats.slice().reverse().find(b => b.frame < currentFrame - 2);
    if (prev) seekFrame(prev.frame);
    else seekFrame(0);
    playing = false;
  }

  function nextChapter() {
    const curCh = findChapter(currentFrame);
    const next = chapterList.find(c => c.index > curCh.index);
    if (next) seekFrame(next.in);
    playing = false;
  }

  function prevChapter() {
    const curCh = findChapter(currentFrame);
    if (currentFrame > curCh.in + fps * 0.5) seekFrame(curCh.in);
    else {
      const prev = chapterList[curCh.index - 1];
      if (prev) seekFrame(prev.in);
      else seekFrame(0);
    }
    playing = false;
  }

  // 按帧间隔推进（没有声卡时钟时用）
  function step(dt) {
    if (!playing) return currentFrame;
    if (autoMode) {
      currentFrame = Math.min(totalFrames - 1, currentFrame + dt * fps);
      if (currentFrame >= totalFrames - 1) playing = false;
    } else if (playing) {
      currentFrame = Math.min(targetHoldFrame, currentFrame + dt * fps);
      if (currentFrame >= targetHoldFrame) playing = false;
    }
    return currentFrame;
  }

  // 跟随外部时钟（声卡）：t 秒 → 帧；手动模式走到目标拍就停
  function followTime(t) {
    const f = clamp(t * fps, 0, totalFrames - 1);
    currentFrame = autoMode ? f : Math.min(f, targetHoldFrame);
    if (currentFrame >= totalFrames - 1 || (!autoMode && currentFrame >= targetHoldFrame)) playing = false;
    return currentFrame;
  }

  function getSnapshot() {
    const f = Math.round(currentFrame);
    const ch = findChapter(f);
    const beat = findBeat(f);
    const nextB = beats.find(b => b.frame > f);
    return {
      frame: f,
      time: currentFrame / fps,
      dur,
      fps,
      totalFrames,
      chapter: ch,
      chapterIndex: ch.index,
      totalChapters: chapterList.length,
      chapters: chapterList,
      beat,
      beatIndex: beat.index,
      totalBeats: beats.length,
      nextBeat: nextB || null,
      beats,
      playing,
      autoMode,
      muted,
      voEnabled,
      splitRatio,
      tier: currentTier,
      tierConfig: TIER_CONFIGS[currentTier],
      tierLocked,
      progress: currentFrame / Math.max(1, totalFrames - 1),
      note: ch.note || '',
    };
  }

  return {
    seekFrame,
    seekTime: t => seekFrame(t * fps),
    nextBeat,
    prevBeat,
    nextChapter,
    prevChapter,
    togglePlay: () => {
      if (playing) { playing = false; return; }
      if (currentFrame >= totalFrames - 1) seekFrame(0);
      if (autoMode) playing = true; else nextBeat();
    },
    toggleAuto: () => { autoMode = !autoMode; if (autoMode && currentFrame >= totalFrames - 1) seekFrame(0); playing = autoMode; return autoMode; },
    toggleMute: () => { muted = !muted; return muted; },
    toggleVo: () => { voEnabled = !voEnabled; return voEnabled; },
    setSplit: r => { splitRatio = clamp(r, 0, 1); },
    setTier: (t, lock = true) => { if (TIERS.includes(t) && t !== currentTier) { currentTier = t; tierLocked = lock; return true; } return false; },
    step,
    followTime,
    getSnapshot,
  };
}

export const FPS_WINDOW_SIZE = 30, LOW_FPS_THRESHOLD = 32, LOW_FPS_STREAK = 45;

/** 降档监测（纯逻辑）：每帧喂帧间隔；平均帧率持续低于 LOW_FPS_THRESHOLD 就报一次「该降档」。
 *  30 帧滑动平均；连续 45 帧偏低降一档，低于阈值一半（卡得厉害）按 3 帧计；手动选过档（tierLocked）不降。 */
export function createGovernor({ windowSize = FPS_WINDOW_SIZE, threshold = LOW_FPS_THRESHOLD, streak = LOW_FPS_STREAK } = {}) {
  const win = [];
  let low = 0, avg = 0;
  return {
    get fps() { return avg; },
    reset() { win.length = 0; low = 0; avg = 0; },
    // dt：这一帧的秒数（≤ 0 不计）；返回 true = 现在应该降一档
    feed(dt, tierLocked = false) {
      if (!(dt > 0)) return false;
      win.push(dt);
      if (win.length > windowSize) win.shift();
      avg = win.length / win.reduce((a, b) => a + b, 0);
      if (tierLocked || win.length < windowSize) { low = 0; return false; }
      if (avg < threshold) {
        low += avg < threshold / 2 ? 3 : 1;
        if (low >= streak) { low = 0; return true; }
      } else {
        low = 0;
      }
      return false;
    },
  };
}

/** 交互控制器：键盘、指针通道、分屏拖拽、提词窗、降档监测 */
export function createDeck({ root = document.body, win = window, model, audio = null, ui = null, onRender = null, onTier = null } = {}) {
  let notesWindow = null;
  let pointer = [0.5, 0.5]; // 0..1，相对 root
  let pointerDown = false;
  let isDraggingSplit = false;
  let running = false, lastTimestamp = 0, lastFrame = -1, wasPlaying = false, warm = 0;

  const governor = createGovernor();

  function updateNotesWindow(snap) {
    if (!notesWindow || notesWindow.closed) return;
    try {
      const doc = notesWindow.document;
      const set = (id, text) => { const el = doc.getElementById(id); if (el) el.textContent = text; };
      set('nx-ch-title', `${snap.chapterIndex + 1}/${snap.totalChapters} · ${snap.chapter.name}`);
      set('nx-time', `${snap.time.toFixed(1)}s / ${snap.dur.toFixed(1)}s (F${snap.frame})`);
      set('nx-beat', snap.beat.name);
      set('nx-next-beat', snap.nextBeat ? `下一拍：${snap.nextBeat.name}` : '末拍');
      set('nx-notes-body', snap.note || '（本章无演讲者备注）');
    } catch {
      notesWindow = null;
    }
  }

  function openNotesWindow() {
    if (notesWindow && !notesWindow.closed) {
      notesWindow.focus();
      return;
    }
    const w = 480, h = 640;
    const left = win.screenX + Math.max(0, win.outerWidth - w - 20);
    const top = win.screenY + 40;
    notesWindow = win.open('', 'wonderx-speaker-notes', `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
    if (!notesWindow) {
      ui?.showNotes?.();   // 被拦截：退到页内右下角的提词面板
      return;
    }
    notesWindow.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>演讲者提词窗</title>
<style>
  body { margin:0; padding:20px; font-family:${ui?.notesFont ?? 'sans-serif'}; background:#141417; color:#F4F0E6; line-height:1.6; }
  .tag { display:inline-block; padding:2px 8px; border-radius:4px; font-size:12px; font-weight:700; background:#D2452C; color:#FFF; margin-bottom:12px; letter-spacing:0.05em; }
  h2 { margin:0 0 4px; font-size:22px; font-weight:700; color:#F4F0E6; }
  .time { font-family:monospace; color:#B9B3A6; font-size:13px; margin-bottom:16px; border-bottom:1px solid #282830; padding-bottom:10px; }
  .beat-box { background:#1D1D22; border-left:3px solid #FFC46B; padding:10px 14px; margin-bottom:16px; font-size:15px; font-weight:600; color:#FFC46B; }
  .notes { font-size:16px; color:#E0DCD1; background:#08080A; border:1px solid #282830; padding:16px; min-height:180px; white-space:pre-wrap; }
  .next-cue { margin-top:16px; font-size:13px; color:#B9B3A6; }
</style></head><body>
  <div class="tag">SPEAKER NOTES</div>
  <h2 id="nx-ch-title">加载中…</h2>
  <div class="time" id="nx-time">0.0s</div>
  <div class="beat-box" id="nx-beat">当前节拍</div>
  <div class="notes" id="nx-notes-body">暂无备注</div>
  <div class="next-cue" id="nx-next-beat">下一拍：--</div>
</body></html>`);
    notesWindow.document.close();
    updateNotesWindow(model.getSnapshot());
  }

  const toggleFullscreen = () => {
    if (!root.ownerDocument.fullscreenElement) root.ownerDocument.documentElement.requestFullscreen().catch(() => {});
    else root.ownerDocument.exitFullscreen().catch(() => {});
  };

  function handleKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        if (e.shiftKey) model.nextChapter(); else model.nextBeat();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        if (e.shiftKey) model.prevChapter(); else model.prevBeat();
        break;
      case ' ':
        e.preventDefault();
        model.togglePlay();
        break;
      case 'a': case 'A':
        e.preventDefault();
        model.toggleAuto();
        break;
      case 'o': case 'O':
        e.preventDefault();
        ui?.toggleOverview?.();
        break;
      case 'n': case 'N':
        e.preventDefault();
        openNotesWindow();
        break;
      case 'f': case 'F':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'm': case 'M':
        e.preventDefault();
        audio?.setMasterMute?.(model.toggleMute());
        break;
      case 'v': case 'V':
        e.preventDefault();
        audio?.setVoEnabled?.(model.toggleVo());
        break;
      case 'h': case 'H':
        e.preventDefault();
        ui?.toggleHelp?.();
        break;
      case 's': case 'S':
        e.preventDefault();
        ui?.toggleMixer?.();
        break;
      case 't': case 'T': {
        e.preventDefault();
        const snap = model.getSnapshot();
        model.setTier(TIERS[(TIERS.indexOf(snap.tier) + 1) % TIERS.length], true);
        break;
      }
      case 'Escape':
        ui?.closePanels?.();
        break;
    }
  }

  // 指针换算到 0..1：root 是 body 时按视口算（body 的高度不跟绝对定位的画面走）
  const rectOf = () => root === win.document.body || !root.getBoundingClientRect ? { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight } : root.getBoundingClientRect();
  function handlePointerMove(e) {
    const r = rectOf();
    pointer = [clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1), clamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1)];
    if (isDraggingSplit) model.setSplit(pointer[0]);
  }

  function handlePointerDown(e) {
    pointerDown = true;
    handlePointerMove(e);
    const snap = model.getSnapshot();
    const r = rectOf();
    const splitPx = r.left + snap.splitRatio * r.width;
    if (snap.chapter?.split && Math.abs(e.clientX - splitPx) < 28) {
      isDraggingSplit = true;
      model.setSplit(pointer[0]);
      e.preventDefault();
    }
  }

  function handlePointerUp() {
    pointerDown = false;
    isDraggingSplit = false;
  }

  // 降档：持续低帧率就降一档（已经最低档、或手动选过档时不降）
  function govern(dt) {
    const snap = model.getSnapshot();
    if (!governor.feed(dt, snap.tierLocked)) return false;
    const curIdx = TIERS.indexOf(snap.tier);
    return curIdx < TIERS.length - 1 && model.setTier(TIERS[curIdx + 1], false);
  }

  let lastTier = null, request = 0;
  function loop(now) {
    if (!running) return;
    const dt = lastTimestamp && warm <= 0 ? Math.min(0.25, (now - lastTimestamp) / 1000) : 0; // determinism-ok: 壳的交互与降档监测，不进画面
    if (warm > 0) warm--;   // 起头 30 帧（着色器编译、贴图上传）不计入降档监测
    lastTimestamp = now;

    if (govern(dt)) ui?.toast?.(`帧率持续偏低（低于 32 fps），已自动降档：${model.getSnapshot().tier}`);

    const snap0 = model.getSnapshot();
    if (snap0.playing && !wasPlaying) audio?.play(snap0.time);
    if (snap0.playing && audio?.isPlaying()) model.followTime(audio.currentTime());
    else model.step(dt);

    // 声卡可能已越过目标拍，按步进后的停点同步音频，再画这一帧。
    const snap = model.getSnapshot();
    if (audio && !snap.playing && (wasPlaying || snap0.playing || snap.frame !== lastFrame)) {
      audio.pause();
      audio.seek(snap.time);
    }
    wasPlaying = snap.playing;
    lastFrame = snap.frame;
    if (snap.tier !== lastTier) {
      const prev = lastTier;
      lastTier = snap.tier;
      onTier?.(snap.tier, prev, snap.tierConfig);
    }
    updateNotesWindow(snap);
    ui?.update?.(snap, { fps: governor.fps, pointerActive: pointerDown });

    // 确定性输入：画面只认这组数
    const input = {
      pointer,
      pointerDown,
      split: snap.splitRatio,
      tier: snap.tier,
      tierConfig: snap.tierConfig,
      chapter: snap.chapter,
      beat: snap.beat,
    };
    if (onRender) onRender(snap.time, input);
    else if (win.render) win.render(snap.time, input);

    request = win.requestAnimationFrame(loop);
  }

  win.addEventListener('keydown', handleKeyDown);
  root.addEventListener('pointermove', handlePointerMove);
  root.addEventListener('pointerdown', handlePointerDown);
  win.addEventListener('pointerup', handlePointerUp);
  const leave = () => { if (!isDraggingSplit) pointer = [0.5, 0.5]; };
  root.addEventListener('pointerleave', leave);
  const unlock = () => audio?.ensureContext?.();
  win.addEventListener('keydown', unlock);
  win.addEventListener('pointerdown', unlock);

  function start() {
    if (running) return;
    running = true;
    lastTimestamp = 0;
    warm = FPS_WINDOW_SIZE;
    governor.reset();
    lastTier = model.getSnapshot().tier;
    request = win.requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    win.cancelAnimationFrame(request);
    audio?.pause();
    wasPlaying = false;
  }

  function dispose() {
    stop();
    win.removeEventListener('keydown', handleKeyDown);
    root.removeEventListener('pointermove', handlePointerMove);
    root.removeEventListener('pointerdown', handlePointerDown);
    root.removeEventListener('pointerleave', leave);
    win.removeEventListener('pointerup', handlePointerUp);
    win.removeEventListener('keydown', unlock);
    win.removeEventListener('pointerdown', unlock);
    if (notesWindow && !notesWindow.closed) notesWindow.close();
  }

  return { model, start, stop, dispose, openNotesWindow };
}
