// 北冥引擎 · 演示壳的占位配乐：三条轨（和声垫 / 脉冲 / 点描主奏）与导览提示音，用 OfflineAudioContext 程序合成，不占包体。
// 这是技术底座（M0）的占位音轨：正式配乐与场景拟音由 Phase 2 的 composer.py + orchestra.py 出（Opus），换掉这三条轨即可，时间轴与调音台不变。
// 三轨同一个速度，循环起点都对齐时间轴 0 秒（循环长度不同也不漂：engine/stage/deck-audio.js 起播时按时间轴对相位）。
// 全部是确定性的：固定种子、固定谱，同一台机器每次合成逐样本相同。
//
//   await renderDeckStems({ sampleRate, bpm }) → { pad, pulse, lead }   AudioBuffer ×3
//   await renderVoChime({ sampleRate }) → AudioBuffer                   导览配音的占位提示音（正式导览由 VoxCPM2 出，按 cue 换）
// 96 BPM：一拍 0.625 s = 24 fps 的 15 帧，一小节 60 帧；和声垫与脉冲 8 小节一循环（20 s），主奏 16 小节一循环（40 s）。
const NOTE = n => 220 * 2 ** (n / 12);   // 相对 A3 的半音数 → 频率
const rnd = seed => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// 渲 seconds + tail 秒，再把 tail 折回开头：循环点两边波形相接，循环时没有爆音
async function looped(seconds, tail, sampleRate, build) {
  const n = Math.round(seconds * sampleRate), ctx = new OfflineAudioContext(2, n + Math.round(tail * sampleRate), sampleRate);
  const bus = ctx.createGain(); bus.gain.value = 1; bus.connect(ctx.destination);
  build(ctx, bus);
  const raw = await ctx.startRendering();
  const out = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate });
  for (let c = 0; c < 2; c++) {
    const s = raw.getChannelData(c), d = out.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = s[i] + (s[n + i] ?? 0);
  }
  return out;
}

const env = (g, t, peak, attack, hold, release) => { g.setValueAtTime(0, t); g.linearRampToValueAtTime(peak, t + attack); g.setValueAtTime(peak, t + attack + hold); g.linearRampToValueAtTime(0, t + attack + hold + release); };

// A 小调里的四个和弦（相对 A3 的半音），一小节换一次
const CHORDS = [[0, 7, 12, 16], [-3, 4, 9, 14], [-5, 2, 7, 12], [-1, 6, 11, 16]];

function buildPad(ctx, bus, { bar, bars }) {
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.4; lp.connect(bus);
  const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 1 / 13; lg.gain.value = 350; lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
  for (let i = 0; i < bars; i++) CHORDS[i % 4].forEach((n, k) => [-1, 1].forEach(side => {
    const o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
    o.type = 'triangle'; o.frequency.value = NOTE(n - 12); o.detune.value = side * 5; p.pan.value = side * (0.25 + k * 0.12);
    o.connect(g); g.connect(p); p.connect(lp);
    env(g.gain, i * bar, 0.07, 0.6, bar - 0.8, 0.7);   // 尾巴伸进下一小节 0.5 s：两个和弦交叠
    o.start(i * bar); o.stop(i * bar + bar + 0.8);
  }));
}

function buildPulse(ctx, bus, { beat, bar, bars }) {
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), nd = noise.getChannelData(0), r = rnd(96);
  for (let i = 0; i < nd.length; i++) nd[i] = r() * 2 - 1;
  const kick = (t, v) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + 0.34);
  };
  const hat = (t, v) => {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise; f.type = 'bandpass'; f.frequency.value = 7200; f.Q.value = 1.2;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    s.connect(f); f.connect(g); g.connect(bus); s.start(t); s.stop(t + 0.06);
  };
  for (let i = 0; i < bars; i++) {
    const t0 = i * bar;
    kick(t0, 0.9); kick(t0 + 2 * beat, 0.7); if (i % 2 === 1) kick(t0 + 3.5 * beat, 0.4);
    for (let e = 0; e < 8; e++) hat(t0 + e * beat / 2, e % 2 ? 0.11 : 0.045);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = NOTE(CHORDS[i % 4][0] - 36);   // 根音低两个八度
    o.connect(g); g.connect(bus); env(g.gain, t0, 0.5, 0.03, bar - 0.2, 0.15); o.start(t0); o.stop(t0 + bar);
  }
}

// 点描主奏：A 小调五声音阶上的一句动机，16 小节里出现、移位、留白；带附点八分回声
const SCALE = [0, 3, 5, 7, 10, 12, 15, 17];
const MOTIF = [[0, 5, 1], [1.5, 4, 1], [3, 3, 2], [6, 4, 1], [7.5, 5, 1], [10, 7, 3], [14, 5, 1.5]];
function buildLead(ctx, bus, { beat, bars }) {
  const dry = ctx.createGain(), wet = ctx.createGain(), dly = ctx.createDelay(2), fb = ctx.createGain(), lp = ctx.createBiquadFilter(), pan = ctx.createStereoPanner();
  dry.gain.value = 0.7; wet.gain.value = 0.3; dly.delayTime.value = beat * 1.5; fb.gain.value = 0.32; lp.type = 'lowpass'; lp.frequency.value = 2400; pan.pan.value = -0.4;
  dry.connect(bus); wet.connect(pan); pan.connect(bus);
  dly.connect(lp); lp.connect(fb); fb.connect(dly); dly.connect(wet);
  const pluck = (t, n, len) => {
    [1, 2].forEach((h, k) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = NOTE(n + 12) * h; o.connect(g); g.connect(dry); g.connect(dly);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(k ? 0.06 : 0.2, t + 0.006); g.gain.exponentialRampToValueAtTime(0.001, t + Math.min(1.6, len * beat + 0.4));
      o.start(t); o.stop(t + 1.7);
    });
  };
  for (let i = 0; i < bars / 4; i++) {
    const shift = [0, 0, 2, 3, 0, 2, 5, 3][i % 8];   // 每两小节把动机在音阶上挪一格
    MOTIF.forEach(([b, s, len]) => pluck(i * 16 * beat + b * beat, SCALE[(s + shift) % SCALE.length] + 12 * Math.floor((s + shift) / SCALE.length), len));
  }
}

/** 三条轨：{ pad, pulse, lead } */
export async function renderDeckStems({ sampleRate = 48000, bpm = 96 } = {}) {
  const beat = 60 / bpm, bar = 4 * beat, bars = 8;
  const gain = v => (ctx, bus) => { bus.gain.value = v; };
  const mix = (...parts) => (ctx, bus) => parts.forEach(p => p(ctx, bus));
  const [pad, pulse, lead] = await Promise.all([
    looped(bars * bar, 1.2, sampleRate, mix(gain(0.9), (c, b) => buildPad(c, b, { bar, bars }))),
    looped(bars * bar, 0.6, sampleRate, mix(gain(0.55), (c, b) => buildPulse(c, b, { beat, bar, bars }))),
    looped(2 * bars * bar, 2.4, sampleRate, mix(gain(0.6), (c, b) => buildLead(c, b, { beat, bars: 2 * bars }))),
  ]);
  return { pad, pulse, lead };
}

/** 导览配音的占位提示音：两声轻钟（E5 → A5），1.1 s */
export async function renderVoChime({ sampleRate = 48000 } = {}) {
  return looped(1.1, 0, sampleRate, (ctx, bus) => {
    bus.gain.value = 0.5;
    [[0, 76], [0.16, 81]].forEach(([t, n]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 440 * 2 ** ((n - 69) / 12); o.connect(g); g.connect(bus);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.2, t + 0.015); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      o.start(t); o.stop(t + 0.95);
    });
  });
}
