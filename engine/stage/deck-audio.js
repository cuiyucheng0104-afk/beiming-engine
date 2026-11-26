// 北冥引擎 · 演示壳音频：Web Audio 声卡时钟驱动的三轨相位锁定调音台（Mute / Solo / 总静音）与导览配音轨。
// 相位锁定：所有轨在同一次声卡时间点起播，而且每轨都从「自己的循环与时间轴 0 秒对齐」的位置进入——循环长度不同的轨也不会互相漂；
// 播放进度只从 audioContext.currentTime 推出来（壳拿它当主时钟），不靠 setTimeout / rAF 累加，长时间播放零漂移。
// 导览配音是独立的一条轨（按 cue 对齐时间轴、不循环、默认关、有单独的增益），开或关不动其它轨的进度。
//
//   createDeckAudio() → { ctx, ensureContext, play(offsetSeconds), pause(), seek(t), currentTime(), isPlaying(),
//                         setStem(key, { name, buffer, volume }), toggleMuteStem(key), toggleSoloStem(key), setMasterMute(muted),
//                         setVoEnabled(on), setVoCues([{ at, buffer }]), getStemsState() }
//   stemStartArgs(offsetSeconds, loopLen) / cueStartArgs(cue, offsetSeconds)   起播参数（纯函数，Node 里可测）
//
// 自动播放限制：AudioContext 起初是 suspended，第一次用户手势后 resume（ensureContext 要在手势里调一次）。
export function stemStartArgs(offsetSeconds, loopLen) {
  if (!(loopLen > 0)) return { delay: 0, offset: 0 };
  const phase = ((offsetSeconds % loopLen) + loopLen) % loopLen;   // 这条轨在时间轴这个时刻已经循环到的位置
  return { delay: 0, offset: phase };                              // 同一声卡时刻起播，各轨从对应的样本偏移进入
}

// cue = { at, buffer }：从 offsetSeconds 开始播时，这条 cue 要不要播、多久后起、从素材的哪里起；不播返回 null
export function cueStartArgs(cue, offsetSeconds) {
  const dur = cue.buffer?.duration ?? 0, at = cue.at ?? 0;
  if (at + dur <= offsetSeconds || dur <= 0) return null;
  return { delay: Math.max(0, at - offsetSeconds), offset: Math.max(0, offsetSeconds - at) };
}

export function createDeckAudio() {
  const AudioCtx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  let audioCtx = null;
  let masterGain = null;
  let limiter = null;

  const stems = new Map(); // key -> { name, buffer, gainNode, muted, soloed, volume }
  let activeSources = [];

  // 导览配音
  let voCues = [];      // [{ at, buffer }]
  let voGainNode = null;
  let voEnabled = false;

  // 播放与时钟状态
  let isPlaying = false;
  let playbackStartAudioTime = 0;
  let playbackStartOffset = 0;

  function ensureContext() {
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    if (audioCtx || !AudioCtx) return audioCtx;
    try {
      audioCtx = new AudioCtx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1;

      // 透明安全限幅器：-0.5 dBFS 阈值，20:1 压缩比，1ms 建立，50ms 释放，防止爆音
      if (typeof audioCtx.createDynamicsCompressor === 'function') {
        limiter = audioCtx.createDynamicsCompressor();
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

      voGainNode = audioCtx.createGain();
      voGainNode.gain.value = 0; // 默认关
      voGainNode.connect(masterGain);
    } catch (e) {
      console.warn('[DeckAudio] AudioContext 初始化失败：', e);
      audioCtx = null;
    }
    return audioCtx;
  }

  function applyGains(immediate = false) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const anySolo = [...stems.values()].some(s => s.soloed);
    for (const [, st] of stems) {
      if (!st.gainNode) continue;
      const audible = anySolo ? (st.soloed && !st.muted) : !st.muted;
      const target = audible ? (st.volume ?? 1) : 0;
      st.gainNode.gain.cancelScheduledValues(now);
      if (immediate) st.gainNode.gain.setValueAtTime(target, now);
      else st.gainNode.gain.setTargetAtTime(target, now, 0.008);
    }
    // 导览配音增益
    if (voGainNode) {
      const voTarget = voEnabled ? 1 : 0;
      voGainNode.gain.cancelScheduledValues(now);
      if (immediate) voGainNode.gain.setValueAtTime(voTarget, now);
      else voGainNode.gain.setTargetAtTime(voTarget, now, 0.008);
    }
  }

  function stopSources() {
    for (const src of activeSources) {
      try { src.stop(); src.disconnect(); } catch {}
    }
    activeSources = [];
  }

  function play(offsetSeconds = 0) {
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    stopSources();
    playbackStartOffset = offsetSeconds;
    const when = ctx.currentTime + 0.02; // 20ms 预调度，防欠载爆音
    playbackStartAudioTime = when;
    isPlaying = true;

    // 相位锁定触发所有分轨
    for (const [key, st] of stems) {
      if (!st.buffer) continue;
      const src = ctx.createBufferSource();
      src.buffer = st.buffer;
      src.loop = true;
      src.connect(st.gainNode);
      const { delay, offset } = stemStartArgs(offsetSeconds, st.buffer.duration);
      src.start(when + delay, offset);
      activeSources.push(src);
    }

    // 导览配音：按 cue 对齐时间轴，不循环
    if (voGainNode) {
      for (const cue of voCues) {
        const a = cueStartArgs(cue, offsetSeconds);
        if (!a) continue;
        const voSrc = ctx.createBufferSource();
        voSrc.buffer = cue.buffer;
        voSrc.loop = false;
        voSrc.connect(voGainNode);
        voSrc.start(when + a.delay, a.offset);
        activeSources.push(voSrc);
      }
    }

    applyGains(true);
  }

  function pause() {
    playbackStartOffset = currentTime();
    isPlaying = false;
    stopSources();
  }

  function seek(t) {
    if (isPlaying) {
      play(t);
    } else {
      playbackStartOffset = t;
    }
  }

  // 声卡时钟：此刻时间轴上的秒数（起播后的 20ms 预调度里不小于起点）
  function currentTime() {
    if (!audioCtx || !isPlaying) return playbackStartOffset;
    return Math.max(playbackStartOffset, playbackStartOffset + (audioCtx.currentTime - playbackStartAudioTime));
  }

  // 登记或更新单个分轨
  function setStem(key, { name, buffer, volume = 1 } = {}) {
    const ctx = ensureContext();
    if (!ctx) return;
    let st = stems.get(key);
    if (!st) {
      const g = ctx.createGain();
      g.connect(masterGain);
      st = { name: name || key, buffer: null, gainNode: g, muted: false, soloed: false, volume };
      stems.set(key, st);
    }
    st.buffer = buffer ?? st.buffer;
    st.volume = volume;
    st.name = name || st.name;
    applyGains(true);
    if (isPlaying) play(currentTime());   // 播放中换轨：原位重启，保持相位
  }

  function toggleMuteStem(key) {
    const st = stems.get(key);
    if (st) {
      st.muted = !st.muted;
      applyGains();
      return st.muted;
    }
    return false;
  }

  function toggleSoloStem(key) {
    const st = stems.get(key);
    if (st) {
      st.soloed = !st.soloed;
      applyGains();
      return st.soloed;
    }
    return false;
  }

  function setMasterMute(muted) {
    if (!masterGain || !audioCtx) return;
    const now = audioCtx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(muted ? 0 : 1, now, 0.008);
  }

  function setVoEnabled(enabled) {
    voEnabled = !!enabled;
    applyGains();
    return voEnabled;
  }

  function setVoCues(cues) {
    voCues = Array.isArray(cues) ? cues.filter(c => c && c.buffer) : [];
    if (isPlaying) play(currentTime());
  }

  return {
    ensureContext,
    play,
    pause,
    seek,
    currentTime,
    isPlaying: () => isPlaying && audioCtx?.state === 'running',
    setStem,
    toggleMuteStem,
    toggleSoloStem,
    setMasterMute,
    setVoEnabled,
    setVoCues,
    getStemsState: () => Array.from(stems.entries()).map(([k, s]) => ({ id: k, name: s.name, muted: s.muted, soloed: s.soloed, volume: s.volume })),
  };
}
