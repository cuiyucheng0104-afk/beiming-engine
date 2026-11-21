// 北冥引擎 · 浏览器端带声分轨调片预览外壳（?preview=1 时由 lib/preview.mjs 注入页面，纯原生 ES 模块、零外部依赖）。
//
// 行为约定：
//   1. 等待页面兑现北冥渲染约定（window.READY === true 且 typeof window.render === 'function'）；非影片页面静默退出、不碰 DOM。
//   2. 拉取 /_preview/state?dir=<目录>，解码全部分轨 stems（每轨独立 GainNode → 总线 → 扬声器，实时无咔嗒 Mute / Solo），
//      没有分轨但有 mix.wav 时退回解码总混音；尚无音频时用 performance.now() 静默时钟驱动画面。
//   3. 相位锁定主时钟：有音频时以硬件声卡时钟 t = startOffset + (audioCtx.currentTime - ctxStartTime) 驱动 window.render(t)，
//      声画零漂移；支持拖拽时间轴、空格启停、←/→ 逐帧步进、[/] 跳切点、L 循环、一键 POST /_preview/rebuild 热重载分轨与 QA 状态。

const STEM_LABELS = {
  vo: 'VO',
  dialogue: 'VO',
  music: 'MUS',
  amb: 'AMB',
  fx: 'FX',
  sfx: 'FX',
  foley: 'FOL',
  ui: 'UI',
};

const READY_POLL_MS = 50;
const READY_MAX_WAIT_MS = 60_000;
const NON_FILM_EXIT_MS = 4_000;

function inferPageDir(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname || '/'); } catch { decoded = pathname || '/'; }
  const parts = decoded.split('/').filter(Boolean);
  if (parts.length && /\.html?$/i.test(parts[parts.length - 1])) parts.pop();
  return parts.length ? parts.join('/') : '.';
}

function waitForFilmContract() {
  return new Promise(resolve => {
    const t0 = performance.now();
    let completeSince = document.readyState === 'complete' ? t0 : null;
    const check = () => {
      if (window.READY === true && typeof window.render === 'function') return resolve(true);
      const now = performance.now();
      if (document.readyState === 'complete' && completeSince === null) completeSince = now;
      const looksUninitialized = window.READY === undefined && typeof window.render !== 'function' && window.DUR === undefined;
      if (completeSince !== null && looksUninitialized && now - completeSince > NON_FILM_EXIT_MS) return resolve(false);
      if (now - t0 > READY_MAX_WAIT_MS) return resolve(false);
      setTimeout(check, READY_POLL_MS);
    };
    check();
  });
}

function padInt(n, width) {
  return String(Math.max(0, Math.trunc(n))).padStart(width, '0');
}

function formatSeconds(sec) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const whole = Math.floor(s);
  const hundredths = Math.floor((s - whole + 1e-9) * 100);
  return `${String(whole).padStart(2, '0')}.${String(Math.min(99, hundredths)).padStart(2, '0')}s`;
}

function stemLabel(key) {
  return STEM_LABELS[key] || String(key).slice(0, 4).toUpperCase();
}

function mergeTimelineMeta(serverState) {
  const pageDur = typeof window.DUR === 'number' && Number.isFinite(window.DUR) && window.DUR > 0 ? window.DUR : null;
  const pageFps = typeof window.FPS === 'number' && Number.isFinite(window.FPS) && window.FPS > 0 ? window.FPS : null;
  const tl = window.TIMELINE && typeof window.TIMELINE === 'object' ? window.TIMELINE : null;

  const fps = pageFps || serverState?.fps || (typeof tl?.fps === 'number' && tl.fps > 0 ? tl.fps : 24);
  const dur = pageDur || serverState?.dur || (typeof tl?.dur === 'number' && tl.dur > 0 ? tl.dur : 10);
  const frames = serverState?.frames
    || (Number.isInteger(tl?.frameCount) && tl.frameCount > 0 ? tl.frameCount : Math.max(1, Math.round(dur * fps)));

  let shots = Array.isArray(serverState?.shots) && serverState.shots.length ? serverState.shots : [];
  if (!shots.length && Array.isArray(tl?.shots) && tl.shots.length) {
    shots = tl.shots
      .filter(s => s && Number.isInteger(s.in) && Number.isInteger(s.out) && s.out > s.in)
      .map((s, i) => ({ id: String(s.id ?? `S${i + 1}`), in: s.in, out: s.out }));
  }
  if (!shots.length) shots = [{ id: 'S1', in: 0, out: frames }];

  const cutSet = new Set([
    ...(Array.isArray(serverState?.cuts) ? serverState.cuts : []),
    ...shots.slice(1).map(s => s.in),
  ].filter(f => Number.isInteger(f) && f > 0 && f < frames));
  const cuts = [...cutSet].sort((a, b) => a - b);

  const eventByFrame = new Map();
  const addEv = (frame, label) => {
    if (!Number.isInteger(frame) || frame < 0 || frame >= frames) return;
    if (!eventByFrame.has(frame)) eventByFrame.set(frame, String(label || `F${frame}`));
  };
  if (Array.isArray(serverState?.events)) {
    for (const e of serverState.events) {
      const f = Number.isInteger(e?.frame) ? e.frame : (typeof e?.t === 'number' ? Math.round(e.t * fps) : null);
      if (f !== null) addEv(f, e.label || e.id);
    }
  }
  if (tl?.t && typeof tl.t === 'object') {
    for (const [k, sec] of Object.entries(tl.t)) {
      if (typeof sec === 'number' && Number.isFinite(sec)) addEv(Math.round(sec * fps), k);
    }
  }
  if (Array.isArray(window.EV)) {
    for (const e of window.EV) {
      if (e && typeof e.t === 'number' && Number.isFinite(e.t) && (e.cue || e.id)) {
        addEv(Math.round(e.t * fps), e.cue || e.id);
      }
    }
  }
  const events = [...eventByFrame.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, label]) => ({ frame, t: frame / fps, label }));

  return {
    title: serverState?.title || document.title || '',
    fps,
    dur,
    frames,
    shots,
    cuts,
    events,
  };
}

const STYLES = `
:host {
  all: initial;
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2147483647;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  color: #e9eef7;
  user-select: none;
}
* { box-sizing: border-box; }
.wrap {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 0 12px 10px;
  gap: 6px;
}
.diag {
  pointer-events: auto;
  align-self: flex-end;
  max-width: min(760px, 96vw);
  background: rgba(28, 12, 16, 0.92);
  border: 1px solid rgba(255, 107, 107, 0.45);
  border-radius: 8px;
  padding: 7px 11px;
  font-size: 12px;
  line-height: 1.45;
  color: #ffd7d7;
  backdrop-filter: blur(14px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  display: none;
}
.diag.show { display: flex; align-items: flex-start; gap: 10px; }
.diag-text { white-space: pre-wrap; word-break: break-word; flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.diag-close {
  background: transparent;
  border: none;
  color: #ff9e9e;
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
  line-height: 1;
}
.bar {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  background: rgba(12, 15, 22, 0.84);
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 11px;
  padding: 8px 12px 9px;
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.52);
}
.bar.hidden { display: none; }
.mini {
  pointer-events: auto;
  align-self: flex-end;
  display: none;
  align-items: center;
  gap: 8px;
  background: rgba(12, 15, 22, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  backdrop-filter: blur(14px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  color: #dbe4f3;
}
.mini.show { display: inline-flex; }
.timeline-wrap {
  position: relative;
  height: 18px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}
.track {
  position: relative;
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 3px;
  overflow: visible;
}
.fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0%;
  background: linear-gradient(90deg, #4ea8ff, #38e8ff);
  border-radius: 3px;
  pointer-events: none;
}
.ticks {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.tick-cut {
  position: absolute;
  top: -4px;
  width: 2px;
  height: 14px;
  transform: translateX(-1px);
  background: #ff9f43;
  border-radius: 1px;
  opacity: 0.95;
}
.tick-ev {
  position: absolute;
  top: -2px;
  width: 1.5px;
  height: 10px;
  transform: translateX(-0.75px);
  background: #38e8ff;
  opacity: 0.78;
}
.head {
  position: absolute;
  top: 50%;
  left: 0%;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #ffffff;
  border: 2px solid #38e8ff;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.left, .center, .right {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.btn {
  appearance: none;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #edf2fb;
  border-radius: 6px;
  padding: 4px 9px;
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.26);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.active {
  background: rgba(56, 232, 255, 0.18);
  border-color: rgba(56, 232, 255, 0.55);
  color: #8cf0ff;
}
.btn-play {
  min-width: 58px;
  justify-content: center;
  font-weight: 600;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: #dbe5f5;
  letter-spacing: 0.01em;
}
.sep {
  color: rgba(255, 255, 255, 0.24);
  font-size: 11px;
}
.badge {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 5px;
  background: rgba(255, 159, 67, 0.16);
  border: 1px solid rgba(255, 159, 67, 0.42);
  color: #ffc285;
}
.stems {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.stem-pill {
  display: inline-flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 6px;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  transition: opacity 0.12s ease, border-color 0.12s ease;
}
.stem-pill.dimmed { opacity: 0.42; }
.stem-pill.soloed { border-color: rgba(250, 204, 21, 0.65); }
.stem-pill.muted { border-color: rgba(248, 113, 113, 0.55); }
.stem-name {
  padding: 3px 6px;
  font-weight: 600;
  color: #d6e0f0;
  letter-spacing: 0.03em;
}
.stem-toggle {
  appearance: none;
  border: none;
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  background: transparent;
  color: #9fb0c9;
  padding: 3px 5px;
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 700;
  cursor: pointer;
}
.stem-toggle:hover { background: rgba(255, 255, 255, 0.12); color: #ffffff; }
.stem-toggle.m-on { background: rgba(239, 68, 68, 0.82); color: #ffffff; }
.stem-toggle.s-on { background: rgba(234, 179, 8, 0.88); color: #111827; }
.audio-note {
  font-size: 11.5px;
  color: #8fa1bd;
}
.qa-badge {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 700;
  padding: 3px 7px;
  border-radius: 5px;
  display: none;
}
.qa-badge.pass {
  display: inline-flex;
  background: rgba(16, 185, 129, 0.18);
  border: 1px solid rgba(16, 185, 129, 0.5);
  color: #6ee7b7;
}
.qa-badge.fail {
  display: inline-flex;
  background: rgba(239, 68, 68, 0.22);
  border: 1px solid rgba(239, 68, 68, 0.58);
  color: #fca5a5;
  cursor: pointer;
}
`;

async function bootPreviewShell() {
  if (window.__BEIMING_PREVIEW_ACTIVE) return;
  const ok = await waitForFilmContract();
  if (!ok || window.__BEIMING_PREVIEW_ACTIVE) return;
  window.__BEIMING_PREVIEW_ACTIVE = true;

  const pageDir = inferPageDir(window.location.pathname);
  let serverState = null;
  try {
    const r = await fetch(`/_preview/state?dir=${encodeURIComponent(pageDir)}`, { cache: 'no-store' });
    if (r.ok) serverState = await r.json();
  } catch { /* 离线或状态接口不可达时退回纯页面静默预览 */ }

  let meta = mergeTimelineMeta(serverState);

  // ───── WebAudio 分轨混音与相位锁定主时钟 ─────
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;
  let masterGain = null;
  let stemGains = new Map();
  let stemBuffers = new Map();
  let mixBuffer = null;
  let mixGain = null;
  const stemStates = new Map(); // key -> { muted, soloed }
  let mixMuted = false;
  let activeSources = [];

  function ensureAudioGraph() {
    if (audioCtx || !AudioCtx) return audioCtx;
    try {
      audioCtx = new AudioCtx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1;
      // 透明安全限幅：保护 32 位浮点未限幅分轨在叠加峰值略超 0 dBFS 时不削波爆音，正常 −1 dBTP 以下完全不介入
      if (typeof audioCtx.createDynamicsCompressor === 'function') {
        const limiter = audioCtx.createDynamicsCompressor();
        limiter.threshold.value = -0.5;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.001;
        limiter.release.value = 0.05;
        masterGain.connect(limiter);
        limiter.connect(audioCtx.destination);
      } else {
        masterGain.connect(audioCtx.destination);
      }
    } catch {
      audioCtx = null;
    }
    return audioCtx;
  }

  async function fetchAudioBuffer(url) {
    const ctx = ensureAudioGraph();
    if (!ctx) return null;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    return await ctx.decodeAudioData(ab);
  }

  function applyGains(immediate = false) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const anySolo = [...stemStates.values()].some(s => s.soloed);
    for (const [k, gainNode] of stemGains) {
      const st = stemStates.get(k) || { muted: false, soloed: false };
      const audible = anySolo ? (st.soloed && !st.muted) : !st.muted;
      const target = audible ? 1 : 0;
      gainNode.gain.cancelScheduledValues(now);
      if (immediate) gainNode.gain.setValueAtTime(target, now);
      else gainNode.gain.setTargetAtTime(target, now, 0.008);
    }
    if (mixGain) {
      const target = mixMuted ? 0 : 1;
      mixGain.gain.cancelScheduledValues(now);
      if (immediate) mixGain.gain.setValueAtTime(target, now);
      else mixGain.gain.setTargetAtTime(target, now, 0.008);
    }
  }

  async function loadAudioFromState(st) {
    const stemsObj = st?.stems && typeof st.stems === 'object' ? st.stems : {};
    const stemEntries = Object.entries(stemsObj).filter(([, u]) => typeof u === 'string' && u);
    if (stemEntries.length > 0) {
      const ctx = ensureAudioGraph();
      if (!ctx) return;
      const decoded = await Promise.all(stemEntries.map(async ([k, u]) => {
        try { return [k, await fetchAudioBuffer(u)]; } catch { return [k, null]; }
      }));
      const nextBuffers = new Map();
      const nextGains = new Map();
      for (const [k, buf] of decoded) {
        if (!buf) continue;
        nextBuffers.set(k, buf);
        if (!stemStates.has(k)) stemStates.set(k, { muted: false, soloed: false });
        const g = stemGains.get(k) || ctx.createGain();
        if (!stemGains.has(k)) g.connect(masterGain);
        nextGains.set(k, g);
      }
      for (const [oldKey, oldGain] of stemGains) {
        if (!nextGains.has(oldKey)) { try { oldGain.disconnect(); } catch {} }
      }
      stemBuffers = nextBuffers;
      stemGains = nextGains;
      mixBuffer = null;
      applyGains(true);
      return;
    }

    // 无分轨时退回加载总混音 mixUrl
    for (const [, oldGain] of stemGains) { try { oldGain.disconnect(); } catch {} }
    stemGains = new Map();
    stemBuffers = new Map();
    if (typeof st?.mixUrl === 'string' && st.mixUrl) {
      const ctx = ensureAudioGraph();
      if (!ctx) return;
      try {
        mixBuffer = await fetchAudioBuffer(st.mixUrl);
        if (!mixGain) {
          mixGain = ctx.createGain();
          mixGain.connect(masterGain);
        }
        applyGains(true);
      } catch {
        mixBuffer = null;
      }
    } else {
      mixBuffer = null;
    }
  }

  const hasDecodedAudio = () => stemBuffers.size > 0 || Boolean(mixBuffer);

  function stopSources() {
    for (const s of activeSources) {
      try { s.stop(); } catch {}
      try { s.disconnect(); } catch {}
    }
    activeSources = [];
  }

  // ───── 渲染与播放状态机 ─────
  let currentT = 0;
  let isPlaying = false;
  let loopEnabled = true;
  let scrubbing = false;
  let wasPlayingBeforeScrub = false;
  let startOffset = 0;
  let ctxStartTime = 0;
  let perfStartMs = 0;
  let clockMode = 'silent'; // 'audio' | 'silent'
  let rafId = 0;
  let playSeq = 0;
  let rendering = false;
  let pendingRenderT = null;

  function renderAt(t) {
    const clamped = Math.min(Math.max(0, t), Math.max(0, meta.dur - 1e-4));
    if (rendering) {
      pendingRenderT = clamped;
      return;
    }
    rendering = true;
    let out;
    try { out = window.render(clamped); } catch (err) { rendering = false; console.error('[preview] render(t) 异常:', err); return; }
    if (out && typeof out.then === 'function') {
      out.then(() => {
        rendering = false;
        if (pendingRenderT !== null) {
          const next = pendingRenderT;
          pendingRenderT = null;
          renderAt(next);
        }
      }, err => {
        rendering = false;
        console.error('[preview] render(t) 异步异常:', err);
      });
    } else {
      rendering = false;
    }
  }

  async function startPlayback(fromSec = currentT) {
    const seq = ++playSeq;
    stopSources();
    const offset = fromSec >= meta.dur - 1e-3 ? 0 : Math.max(0, Math.min(fromSec, meta.dur - 1e-4));
    currentT = offset;
    isPlaying = true;
    syncTransportUi();

    if (hasDecodedAudio() && audioCtx) {
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch {}
      }
      if (seq !== playSeq || !isPlaying) return;
      if (audioCtx.state === 'running') {
        applyGains(true);
        const when = audioCtx.currentTime + 0.015;
        startOffset = offset;
        ctxStartTime = when;
        clockMode = 'audio';
        if (stemBuffers.size > 0) {
          for (const [k, buf] of stemBuffers) {
            const g = stemGains.get(k);
            if (!g || offset >= buf.duration) continue;
            const src = audioCtx.createBufferSource();
            src.buffer = buf;
            src.connect(g);
            src.start(when, offset);
            activeSources.push(src);
          }
        } else if (mixBuffer && mixGain && offset < mixBuffer.duration) {
          const src = audioCtx.createBufferSource();
          src.buffer = mixBuffer;
          src.connect(mixGain);
          src.start(when, offset);
          activeSources.push(src);
        }
        scheduleTick();
        return;
      }
    }

    startOffset = offset;
    perfStartMs = performance.now();
    clockMode = 'silent';
    scheduleTick();
  }

  function pausePlayback() {
    playSeq++;
    isPlaying = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    stopSources();
    syncTransportUi();
  }

  function togglePlay() {
    if (isPlaying) pausePlayback();
    else startPlayback(currentT);
  }

  function seekTo(targetSec, { resumeIfPlaying = true } = {}) {
    const clamped = Math.max(0, Math.min(targetSec, Math.max(0, meta.dur - 1e-4)));
    currentT = clamped;
    renderAt(clamped);
    updateTimeUi(clamped);
    if (isPlaying && resumeIfPlaying) startPlayback(clamped);
  }

  function stepFrames(delta) {
    if (isPlaying) pausePlayback();
    const curFrame = Math.min(meta.frames - 1, Math.max(0, Math.floor(currentT * meta.fps + 1e-6)));
    const nextFrame = Math.min(meta.frames - 1, Math.max(0, curFrame + delta));
    const nextT = nextFrame / meta.fps;
    currentT = nextT;
    renderAt(nextT);
    updateTimeUi(nextT);
  }

  function jumpCut(dir) {
    const curFrame = Math.min(meta.frames - 1, Math.max(0, Math.floor(currentT * meta.fps + 1e-6)));
    const points = [0, ...meta.cuts];
    let targetFrame;
    if (dir < 0) {
      const prev = points.filter(f => f < curFrame);
      targetFrame = prev.length ? prev[prev.length - 1] : 0;
    } else {
      const next = points.filter(f => f > curFrame);
      targetFrame = next.length ? next[0] : meta.frames - 1;
    }
    seekTo(targetFrame / meta.fps);
  }

  function scheduleTick() {
    if (rafId) cancelAnimationFrame(rafId);
    const tick = () => {
      rafId = 0;
      if (!isPlaying) return;
      let t;
      if (clockMode === 'audio' && audioCtx) {
        t = startOffset + Math.max(0, audioCtx.currentTime - ctxStartTime);
      } else {
        t = startOffset + Math.max(0, (performance.now() - perfStartMs) / 1000);
      }
      if (t >= meta.dur) {
        if (loopEnabled) {
          startPlayback(0);
          return;
        }
        pausePlayback();
        currentT = meta.dur;
        const endT = Math.max(0, meta.dur - 1e-4);
        renderAt(endT);
        updateTimeUi(meta.dur);
        return;
      }
      currentT = t;
      renderAt(Math.min(meta.dur - 1e-4, t));
      updateTimeUi(t);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  // ───── Studio HUD Bar DOM（Shadow DOM 隔离样式） ─────
  const host = document.createElement('div');
  host.id = 'beiming-preview-shell';
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLES;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const diagEl = document.createElement('div');
  diagEl.className = 'diag';
  const diagText = document.createElement('div');
  diagText.className = 'diag-text';
  const diagClose = document.createElement('button');
  diagClose.className = 'diag-close';
  diagClose.type = 'button';
  diagClose.textContent = '✕';
  diagClose.title = '关闭诊断提示';
  diagClose.addEventListener('click', () => diagEl.classList.remove('show'));
  diagEl.append(diagText, diagClose);

  const bar = document.createElement('div');
  bar.className = 'bar';

  const timelineWrap = document.createElement('div');
  timelineWrap.className = 'timeline-wrap';
  const track = document.createElement('div');
  track.className = 'track';
  const fill = document.createElement('div');
  fill.className = 'fill';
  const ticks = document.createElement('div');
  ticks.className = 'ticks';
  const head = document.createElement('div');
  head.className = 'head';
  track.append(fill, ticks, head);
  timelineWrap.appendChild(track);

  const controls = document.createElement('div');
  controls.className = 'controls';

  const left = document.createElement('div');
  left.className = 'left';
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'btn btn-play';
  playBtn.title = '播放 / 暂停（Space）';
  const loopBtn = document.createElement('button');
  loopBtn.type = 'button';
  loopBtn.className = 'btn active';
  loopBtn.textContent = '循环';
  loopBtn.title = '循环播放（L）';
  const timeEl = document.createElement('span');
  timeEl.className = 'mono';
  const sepEl = document.createElement('span');
  sepEl.className = 'sep';
  sepEl.textContent = '·';
  const frameEl = document.createElement('span');
  frameEl.className = 'mono';
  const shotBadge = document.createElement('span');
  shotBadge.className = 'badge';
  left.append(playBtn, loopBtn, timeEl, sepEl, frameEl, shotBadge);

  const center = document.createElement('div');
  center.className = 'center';
  const stemsBox = document.createElement('div');
  stemsBox.className = 'stems';
  center.appendChild(stemsBox);

  const right = document.createElement('div');
  right.className = 'right';
  const qaBadge = document.createElement('span');
  qaBadge.className = 'qa-badge';
  const rebuildBtn = document.createElement('button');
  rebuildBtn.type = 'button';
  rebuildBtn.className = 'btn';
  rebuildBtn.textContent = '↻ 重混声音';
  rebuildBtn.title = '不重渲画面，快速重跑声音脚本与声音门禁';
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'btn';
  collapseBtn.textContent = '▾';
  collapseBtn.title = '折叠预览栏';
  right.append(qaBadge, rebuildBtn, collapseBtn);

  controls.append(left, center, right);
  bar.append(timelineWrap, controls);

  const mini = document.createElement('button');
  mini.type = 'button';
  mini.className = 'mini';
  mini.title = '展开带声调片预览栏';
  const miniText = document.createElement('span');
  miniText.className = 'mono';
  mini.appendChild(miniText);

  wrap.append(diagEl, bar, mini);
  shadow.append(styleEl, wrap);
  document.body.appendChild(host);

  function showDiag(message) {
    if (!message) {
      diagEl.classList.remove('show');
      return;
    }
    diagText.textContent = message;
    diagEl.classList.add('show');
  }

  function renderTicks() {
    ticks.replaceChildren();
    for (const ev of meta.events) {
      const el = document.createElement('div');
      el.className = 'tick-ev';
      el.style.left = `${(ev.frame / meta.frames) * 100}%`;
      el.title = `事件 ${ev.label}（F${ev.frame}）`;
      ticks.appendChild(el);
    }
    for (const cutFrame of meta.cuts) {
      const el = document.createElement('div');
      el.className = 'tick-cut';
      el.style.left = `${(cutFrame / meta.frames) * 100}%`;
      el.title = `镜头切点 F${cutFrame}`;
      ticks.appendChild(el);
    }
  }

  function renderStemsUi() {
    stemsBox.replaceChildren();
    if (stemBuffers.size > 0) {
      const anySolo = [...stemStates.values()].some(s => s.soloed);
      for (const k of stemBuffers.keys()) {
        const st = stemStates.get(k) || { muted: false, soloed: false };
        const audible = anySolo ? (st.soloed && !st.muted) : !st.muted;
        const pill = document.createElement('div');
        pill.className = `stem-pill${!audible ? ' dimmed' : ''}${st.soloed ? ' soloed' : ''}${st.muted ? ' muted' : ''}`;
        const nameEl = document.createElement('span');
        nameEl.className = 'stem-name';
        nameEl.textContent = stemLabel(k);
        nameEl.title = `分轨 ${k}.wav`;

        const mBtn = document.createElement('button');
        mBtn.type = 'button';
        mBtn.className = `stem-toggle${st.muted ? ' m-on' : ''}`;
        mBtn.textContent = 'M';
        mBtn.title = `静音 ${stemLabel(k)}（Mute）`;
        mBtn.addEventListener('click', () => {
          st.muted = !st.muted;
          stemStates.set(k, st);
          applyGains(false);
          renderStemsUi();
        });

        const sBtn = document.createElement('button');
        sBtn.type = 'button';
        sBtn.className = `stem-toggle${st.soloed ? ' s-on' : ''}`;
        sBtn.textContent = 'S';
        sBtn.title = `独奏 ${stemLabel(k)}（Solo）`;
        sBtn.addEventListener('click', () => {
          st.soloed = !st.soloed;
          if (st.soloed) st.muted = false;
          stemStates.set(k, st);
          applyGains(false);
          renderStemsUi();
        });

        pill.append(nameEl, mBtn, sBtn);
        stemsBox.appendChild(pill);
      }
      return;
    }

    if (mixBuffer) {
      const pill = document.createElement('div');
      pill.className = `stem-pill${mixMuted ? ' dimmed muted' : ''}`;
      const nameEl = document.createElement('span');
      nameEl.className = 'stem-name';
      nameEl.textContent = 'MIX';
      nameEl.title = '总混音 mix.wav（未发现独立分轨）';
      const mBtn = document.createElement('button');
      mBtn.type = 'button';
      mBtn.className = `stem-toggle${mixMuted ? ' m-on' : ''}`;
      mBtn.textContent = 'M';
      mBtn.title = '静音总混音';
      mBtn.addEventListener('click', () => {
        mixMuted = !mixMuted;
        applyGains(false);
        renderStemsUi();
      });
      pill.append(nameEl, mBtn);
      stemsBox.appendChild(pill);
      return;
    }

    const note = document.createElement('span');
    note.className = 'audio-note';
    note.textContent = '尚无混音（静默时钟预览）';
    stemsBox.appendChild(note);
  }

  function updateQaUi(qaSummary, lastDiag = '') {
    qaBadge.className = 'qa-badge';
    qaBadge.onclick = null;
    if (!qaSummary) return;
    if (qaSummary.ok) {
      qaBadge.classList.add('pass');
      qaBadge.textContent = qaSummary.warn > 0 ? `QA PASS · ${qaSummary.warn}!` : 'QA PASS';
      const warnTip = qaSummary.warnings?.length
        ? `\n软告警：${qaSummary.warnings.map(w => `${w.id}（${w.message || w.value}）`).join('；')}`
        : '';
      qaBadge.title = `声音门禁通过（${qaSummary.pass} 项通过）${warnTip}`;
    } else {
      qaBadge.classList.add('fail');
      qaBadge.textContent = 'QA FAIL';
      const failLines = (qaSummary.failures || []).map(f => `✗ ${f.id}：${f.message || f.value}${f.hint ? `（${f.hint}）` : ''}`);
      const detail = [failLines.join('\n'), lastDiag].filter(Boolean).join('\n');
      qaBadge.title = detail || '声音门禁未通过（点击查看详情）';
      qaBadge.onclick = () => showDiag(detail || '声音门禁未通过');
    }
  }

  function shotAtFrame(f) {
    let cur = meta.shots[0] || { id: 'S1', in: 0, out: meta.frames };
    for (const s of meta.shots) if (f >= s.in) cur = s;
    return cur;
  }

  function updateTimeUi(t) {
    const pct = meta.dur > 0 ? Math.min(100, Math.max(0, (t / meta.dur) * 100)) : 0;
    fill.style.width = `${pct}%`;
    head.style.left = `${pct}%`;
    const width = Math.max(3, String(meta.frames).length);
    const frame = t >= meta.dur ? meta.frames - 1 : Math.min(meta.frames - 1, Math.max(0, Math.floor(t * meta.fps + 1e-6)));
    const tc = formatSeconds(Math.min(t, meta.dur));
    timeEl.textContent = tc;
    frameEl.textContent = `F ${padInt(frame, width)} / ${padInt(meta.frames, width)}`;
    const shot = shotAtFrame(frame);
    shotBadge.textContent = shot.id || 'S1';
    miniText.textContent = `▴ ${isPlaying ? '⏸' : '▶'} ${tc} · ${shot.id || 'S1'}`;
  }

  function syncTransportUi() {
    playBtn.textContent = isPlaying ? '⏸ 暂停' : '▶ 播放';
    loopBtn.classList.toggle('active', loopEnabled);
    rebuildBtn.disabled = !serverState?.canRebuild || rebuilding;
    updateTimeUi(currentT);
  }

  // ───── 交互事件绑定 ─────
  playBtn.addEventListener('click', () => togglePlay());
  loopBtn.addEventListener('click', () => {
    loopEnabled = !loopEnabled;
    syncTransportUi();
  });

  collapseBtn.addEventListener('click', () => {
    bar.classList.add('hidden');
    mini.classList.add('show');
  });
  mini.addEventListener('click', () => {
    mini.classList.remove('show');
    bar.classList.remove('hidden');
  });

  function pointerToTime(ev) {
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    return ratio * meta.dur;
  }

  timelineWrap.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    scrubbing = true;
    wasPlayingBeforeScrub = isPlaying;
    if (isPlaying) pausePlayback();
    timelineWrap.setPointerCapture?.(ev.pointerId);
    seekTo(pointerToTime(ev), { resumeIfPlaying: false });
  });
  timelineWrap.addEventListener('pointermove', ev => {
    if (!scrubbing) return;
    seekTo(pointerToTime(ev), { resumeIfPlaying: false });
  });
  const endScrub = ev => {
    if (!scrubbing) return;
    scrubbing = false;
    timelineWrap.releasePointerCapture?.(ev.pointerId);
    if (wasPlayingBeforeScrub) startPlayback(currentT);
  };
  timelineWrap.addEventListener('pointerup', endScrub);
  timelineWrap.addEventListener('pointercancel', endScrub);

  let rebuilding = false;
  rebuildBtn.addEventListener('click', async () => {
    if (rebuilding || !serverState?.canRebuild) return;
    rebuilding = true;
    rebuildBtn.textContent = '↻ 重混中…';
    syncTransportUi();
    showDiag('');
    try {
      const res = await fetch(`/_preview/rebuild?dir=${encodeURIComponent(pageDir)}`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (data && typeof data === 'object') {
        serverState = { ...serverState, ...data };
        meta = mergeTimelineMeta(serverState);
        renderTicks();
        const resumeAfter = isPlaying;
        const savedT = Math.min(currentT, Math.max(0, meta.dur - 1e-4));
        if (resumeAfter) pausePlayback();
        await loadAudioFromState(serverState);
        renderStemsUi();
        const diagMsg = !res.ok
          ? [data.message, data.hint ? `提示：${data.hint}` : '', data.stderr || ''].filter(Boolean).join('\n')
          : '';
        updateQaUi(data.qaSummary || (res.status === 422 ? { ok: false, failures: [] } : null), diagMsg);
        if (!res.ok) showDiag(diagMsg || `重混声音未通过（HTTP ${res.status}）`);
        currentT = savedT;
        renderAt(savedT);
        updateTimeUi(savedT);
        if (resumeAfter && res.ok) await startPlayback(savedT);
      } else if (!res.ok) {
        showDiag(`重混声音请求失败（HTTP ${res.status}）`);
      }
    } catch (err) {
      showDiag(`重混声音网络异常：${err?.message || err}`);
    } finally {
      rebuilding = false;
      rebuildBtn.textContent = '↻ 重混声音';
      syncTransportUi();
    }
  });

  window.addEventListener('keydown', ev => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      togglePlay();
    } else if (ev.code === 'ArrowLeft') {
      ev.preventDefault();
      stepFrames(-1);
    } else if (ev.code === 'ArrowRight') {
      ev.preventDefault();
      stepFrames(1);
    } else if (ev.key === '[') {
      ev.preventDefault();
      jumpCut(-1);
    } else if (ev.key === ']') {
      ev.preventDefault();
      jumpCut(1);
    } else if (ev.key === 'l' || ev.key === 'L') {
      ev.preventDefault();
      loopEnabled = !loopEnabled;
      syncTransportUi();
    }
  });

  // 初始装配：先画刻度与时间，再后台解码分轨（不阻塞界面出现）
  renderTicks();
  renderStemsUi();
  updateQaUi(serverState?.qaSummary || null);
  syncTransportUi();
  await loadAudioFromState(serverState);
  renderStemsUi();
}

bootPreviewShell();
