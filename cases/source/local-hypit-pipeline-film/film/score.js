// score.js — 全片配乐与音效（G-score）。经典脚本，在所有场景之后加载。
// 契约：window.__film.wav() → base64 WAV（48 kHz 立体声 16 bit，180 s）；window.__film.score 供实时播放可选。
// 全部内容只由时间和 F.events 决定：没有 Math.random()，噪声与混响都用 F.rng 固定种子生成；
// F.events 在 F.boot() 之后才齐，所以一切在 wav()/render() 被调用时才读取。
// 120 BPM：拍 0.5 s，小节 2 s，十六分 0.125 s。调性 D 小调五声（D F G A C），拨弦带"按音"上滑，呼应武侠原片。
'use strict';
(function () {
const F = window.F;
const SR = 48000, DUR = 180, BEAT = .5, BAR = 2, S16 = .125;
const TARGET_LUFS = -16, CEIL = Math.pow(10, -1.6 / 20);   // 采样峰值上限 −1.6 dBFS，给真峰值留余量
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

// ─── 和弦与五声音阶 ─────────────────────────────────────────────────────────
const PENT_PC = [2, 5, 7, 9, 0];
const PENT = []; for (let m = 36; m <= 96; m++) if (PENT_PC.includes(((m % 12) + 12) % 12)) PENT.push(m);
const pidx = m => { let k = 0; while (k < PENT.length - 1 && PENT[k] < m) k++; return k; };
const CH = {
  Dm:    { root: 38, pad: [50, 57, 62, 65, 69], anchor: 62 },
  Bb:    { root: 34, pad: [46, 53, 57, 62, 65], anchor: 62 },   // Bbmaj7
  F:     { root: 41, pad: [48, 53, 57, 60, 65], anchor: 65 },
  C:     { root: 36, pad: [48, 55, 60, 62, 67], anchor: 60 },   // Csus2
  Gm:    { root: 43, pad: [50, 55, 58, 62, 65], anchor: 67 },   // Gm7
  Asus:  { root: 45, pad: [52, 57, 62, 64, 69], anchor: 69 },   // Asus4
  Dsus2: { root: 38, pad: [50, 57, 62, 64, 69, 74], anchor: 62 },
};
// 每小节一个和弦（90 小节）
function chordAt(bar) {
  const t = bar * BAR, k = bar % 4;
  if (t < 8) return ['Dm', 'Dm', 'Bb', 'C'][k];
  if (t < 24) return ['Dm', 'Bb', 'Gm', 'Asus'][k];
  if (t < 64) return ['Dm', 'Bb', 'F', 'C'][k];
  if (t < 72) return ['Bb', 'Gm', 'Dm', 'Asus'][k];
  if (t < 160) return ['Dm', 'Bb', 'F', 'C'][k];
  if (t < 176) return ['Bb', 'F', 'Gm', 'C', 'Bb', 'C', 'Dm', 'Dsus2'][(bar - 80) % 8];
  return 'Dsus2';
}
// 八分音符琶音型（五声音阶上的级数，null = 休止）
const PATS = [
  [0, 2, 4, 2, 5, 4, 2, 1],
  [0, null, 2, 4, null, 4, 5, 7],
  [4, 2, 0, 2, 4, null, 7, null],
  [0, 1, 2, 4, 2, 1, 0, null],
];

// ─── 声音图 ─────────────────────────────────────────────────────────────────
// build(ac, events, opts) 在任意 BaseAudioContext 上排好整部片子的声音，返回 master 节点（已接到 ac.destination）。
function build(ac, events, opts = {}) {
  const OFF = {}; for (const k of (opts.off || [])) OFF[k] = 1;
  // 共享噪声（4 s，立体声各一份，固定种子）
  const NL = 4 * ac.sampleRate, noise = ac.createBuffer(2, NL, ac.sampleRate);
  for (let c = 0; c < 2; c++) { const d = noise.getChannelData(c), r = F.rng(77 + c); for (let i = 0; i < NL; i++) d[i] = r() * 2 - 1; }
  // 混响：噪声 × (1 − i/n)^2.6，2.8 s
  const IRL = Math.floor(2.8 * ac.sampleRate), ir = ac.createBuffer(2, IRL, ac.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c), r = F.rng(313 + c); for (let i = 0; i < IRL; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / IRL, 2.6); }

  const out = ac.createGain(); out.gain.value = 1;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 2.5; comp.attack.value = .012; comp.release.value = .22;
  const master = ac.createGain(), hpf = ac.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 30; hpf.Q.value = .6;
  master.connect(hpf); hpf.connect(comp); comp.connect(out); out.connect(ac.destination);
  // 结尾渐隐（与画面 176–179.6 的 smooth 渐黑同步）
  { const n = 64, curve = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1); curve[i] = 1 - x * x * (3 - 2 * x); }
    master.gain.setValueAtTime(1, 0); master.gain.setValueCurveAtTime(curve, F.fadeOut ? F.fadeOut[0] : 176, (F.fadeOut ? F.fadeOut[1] - F.fadeOut[0] : 3.6)); }

  const music = ac.createGain(), duck = ac.createGain(), sfx = ac.createGain();
  music.connect(duck); duck.connect(master); sfx.connect(master);
  music.gain.value = opts.mute === 'music' ? 0 : 1; sfx.gain.value = opts.mute === 'sfx' ? 0 : 1.25;
  const verb = ac.createConvolver(); verb.normalize = true; verb.buffer = ir;
  const verbLP = ac.createBiquadFilter(); verbLP.type = 'lowpass'; verbLP.frequency.value = 5200;
  const verbHP = ac.createBiquadFilter(); verbHP.type = 'highpass'; verbHP.frequency.value = 180;
  const verbOut = ac.createGain(); verbOut.gain.value = .9;
  verb.connect(verbLP); verbLP.connect(verbHP); verbHP.connect(verbOut); verbOut.connect(master);
  const sendM = ac.createGain(); sendM.gain.value = opts.mute === 'music' ? 0 : 1; sendM.connect(verb);
  const sendS = ac.createGain(); sendS.gain.value = opts.mute === 'sfx' ? 0 : 1; sendS.connect(verb);
  // 附点八分延迟（拨弦用）
  const dly = ac.createDelay(1); dly.delayTime.value = .375;
  const dfb = ac.createGain(); dfb.gain.value = .3;
  const dlp = ac.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2600;
  const dOut = ac.createGain(); dOut.gain.value = .45;
  dly.connect(dlp); dlp.connect(dfb); dfb.connect(dly); dlp.connect(dOut); dOut.connect(music); dOut.connect(sendM);

  // 段落电平（音乐总线）
  const secLv = [[0, .8], [8, .62], [16, .7], [24, .68], [40, .72], [64, .62], [72, 1], [160, .82]];
  for (const [t, v] of secLv) { music.gain.setTargetAtTime(v * (opts.mute === 'music' ? 0 : 1), Math.max(0, t - .05), .03); }

  // ── 小工具 ──
  let noiseOff = 0;
  const noiseSrc = (t, dur) => {
    const s = ac.createBufferSource(); s.buffer = noise; s.loop = true;
    noiseOff = (noiseOff + 1.37) % 3.5; s.start(t, noiseOff); s.stop(t + dur + .05); return s;
  };
  const pan = (node, p) => { const pn = ac.createStereoPanner(); pn.pan.value = p; node.connect(pn); return pn; };
  const envAD = (param, t, a, peak, dec) => {
    param.setValueAtTime(0, t); param.linearRampToValueAtTime(peak, t + a);
    param.setTargetAtTime(0, t + a, dec / 4);
  };
  const route = (node, bus, send = 0, sendBus) => {
    node.connect(bus);
    if (send > 0) { const g = ac.createGain(); g.gain.value = send; node.connect(g); g.connect(sendBus || (bus === sfx ? sendS : sendM)); }
  };

  // 同一时刻的"重拍"：配乐的底鼓遇到 hit 事件就让位
  const hitTimes = events.filter(e => e.type === 'hit').map(e => e.t);
  const nearHit = t => hitTimes.some(h => Math.abs(h - t) < .06);

  // ── 乐器（音乐总线） ──
  function kick(t, v = 1) {
    if (OFF.kick) return;
    if (nearHit(t)) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + .14);
    envAD(g.gain, t, .003, .95 * v, .38); o.connect(g); route(g, music);
    o.start(t); o.stop(t + .5);
    const c = noiseSrc(t, .02), cf = ac.createBiquadFilter(), cg = ac.createGain();
    cf.type = 'bandpass'; cf.frequency.value = 3200; cf.Q.value = .8; envAD(cg.gain, t, .001, .12 * v, .015);
    c.connect(cf); cf.connect(cg); route(cg, music);
  }
  function clap(t, v = 1, wet = .25) {
    if (OFF.clap) return;
    const s = noiseSrc(t, .3), f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 1.1;
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 3; k++) { const tk = t + k * .011; g.gain.setValueAtTime(.55 * v, tk); g.gain.setTargetAtTime(.05 * v, tk + .001, .004); }
    g.gain.setValueAtTime(.4 * v, t + .033); g.gain.setTargetAtTime(0, t + .034, .05);
    s.connect(f); f.connect(g); route(g, music, wet);
    const o = ac.createOscillator(), og = ac.createGain(); o.type = 'triangle'; o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(150, t + .08);
    envAD(og.gain, t, .002, .22 * v, .09); o.connect(og); route(og, music); o.start(t); o.stop(t + .2);
  }
  function hat(t, v = 1, open = false, p = 0) {
    if (OFF.hat) return;
    const d = open ? .22 : .045, s = noiseSrc(t, d + .1), f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = 'highpass'; f.frequency.value = open ? 7000 : 8200;
    envAD(g.gain, t, .001, (open ? .16 : .22) * v, d); s.connect(f); f.connect(g); route(pan(g, p), music, open ? .1 : 0);
  }
  function tom(t, f0, v = 1) {
    if (OFF.tom) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.setValueAtTime(f0 * 1.6, t); o.frequency.exponentialRampToValueAtTime(f0, t + .06);
    envAD(g.gain, t, .003, .6 * v, .45); o.connect(g); route(g, music, .2); o.start(t); o.stop(t + .6);
    const s = noiseSrc(t, .1), nf = ac.createBiquadFilter(), ng = ac.createGain();
    nf.type = 'lowpass'; nf.frequency.value = 1400; envAD(ng.gain, t, .001, .15 * v, .06); s.connect(nf); nf.connect(ng); route(ng, music);
  }
  function bass(t, m, dur, v = 1, cut = 420) {
    if (OFF.bass) return;
    const f = mtof(m), o = ac.createOscillator(), o2 = ac.createOscillator(), lp = ac.createBiquadFilter(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = f; o2.type = 'triangle'; o2.frequency.value = f;
    lp.type = 'lowpass'; lp.frequency.value = cut; lp.Q.value = .5;
    const g2 = ac.createGain(); g2.gain.value = .55;
    o.connect(g); o2.connect(g2); g2.connect(lp); lp.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.27 * v, t + .012);
    g.gain.setTargetAtTime(.19 * v, t + .02, .15); g.gain.setTargetAtTime(0, t + dur - .03, .025);
    route(g, music); o.start(t); o2.start(t); o.stop(t + dur + .2); o2.stop(t + dur + .2);
  }
  function pad(t, notes, dur, v = 1, cut = 1100, att = .6, rel = .9, wet = .35) {
    if (OFF.pad) return;
    const lp = ac.createBiquadFilter(), g = ac.createGain();
    lp.type = 'lowpass'; lp.Q.value = .6;
    lp.frequency.setValueAtTime(cut * .6, t); lp.frequency.linearRampToValueAtTime(cut, t + dur * .5); lp.frequency.linearRampToValueAtTime(cut * .75, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.05 * v, t + att);
    g.gain.setValueAtTime(.05 * v, t + dur); g.gain.setTargetAtTime(0, t + dur, rel / 3);
    notes.forEach((m, k) => {
      for (const det of [-7, 7]) {
        const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det + (k % 2 ? 2 : -2);
        const pn = ac.createStereoPanner(); pn.pan.value = det < 0 ? -.35 : .35;
        o.connect(pn); pn.connect(lp); o.start(t); o.stop(t + dur + rel * 1.5);
      }
    });
    lp.connect(g); route(g, music, wet);
  }
  // 拨弦（古筝感）：三角波 + 二次谐波，起音略低于目标音、40 ms 内按到位
  function pluck(t, m, v = 1, p = 0, d = .9, bright = 3200, echo = true) {
    if (OFF.pluck) return;
    const f = mtof(m), o = ac.createOscillator(), o2 = ac.createOscillator(), lp = ac.createBiquadFilter(), g = ac.createGain(), g2 = ac.createGain();
    o.type = 'triangle'; o2.type = 'sine';
    o.frequency.setValueAtTime(f * .975, t); o.frequency.exponentialRampToValueAtTime(f, t + .045);
    o2.frequency.setValueAtTime(f * 2 * .975, t); o2.frequency.exponentialRampToValueAtTime(f * 2, t + .045);
    g2.gain.value = .35;
    lp.type = 'lowpass'; lp.Q.value = 1.2; lp.frequency.setValueAtTime(bright, t); lp.frequency.setTargetAtTime(520, t + .01, .12);
    envAD(g.gain, t, .002, .24 * v, d);
    o.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g);
    const pn = pan(g, p); route(pn, music, .22);
    if (echo) { const eg = ac.createGain(); eg.gain.value = .6; pn.connect(eg); eg.connect(dly); }
    o.start(t); o2.start(t); o.stop(t + d + .3); o2.stop(t + d + .3);
  }
  // 钟 / 编钟：非谐分音，长衰减
  function bell(t, m, v = 1, dur = 2.4, bus = music, wet = .45, p = 0) {
    if (OFF.bell) return;
    const f = mtof(m), parts = [[1, 1, 1], [2.76, .42, .45], [5.4, .2, .25], [8.93, .08, .12]];
    const sum = ac.createGain(); sum.gain.value = 1;
    for (const [r, a, dk] of parts) {
      const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f * r;
      envAD(g.gain, t, .003, .16 * a * v, dur * dk); o.connect(g); g.connect(sum); o.start(t); o.stop(t + dur * dk + .5);
    }
    route(pan(sum, p), bus, wet);
  }
  // 古筝刮奏：沿五声音阶快速滑过
  function gliss(t, fromM, toM, dur, v = 1) {
    let a = pidx(fromM), b = pidx(toM); const n = Math.abs(b - a) + 1, dir = b > a ? 1 : -1;
    for (let k = 0; k < n; k++) {
      const x = k / Math.max(1, n - 1);
      pluck(t + x * dur, PENT[a + dir * k], v * (.45 + .45 * (dir < 0 ? 1 - x : x)), (x - .5) * .6 * dir, .6, 3600, false);
    }
  }

  // ── 音效（音效总线）：按 F.events 出声 ──
  const SFX = {
    hit(t, e, v) {                              // 段落重拍：低鼓轰 + 太鼓皮 + 空气尾
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(34, t + .4);
      envAD(g.gain, t, .004, 1.0 * v, 1.1); o.connect(g); route(g, sfx, .15); o.start(t); o.stop(t + 1.4);
      const s = noiseSrc(t, .5), lp = ac.createBiquadFilter(), ng = ac.createGain();
      lp.type = 'lowpass'; lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(300, t + .3);
      envAD(ng.gain, t, .002, .35 * v, .35); s.connect(lp); lp.connect(ng); route(ng, sfx, .3);
      const a = noiseSrc(t, 1.6), hp = ac.createBiquadFilter(), ag = ac.createGain();
      hp.type = 'highpass'; hp.frequency.value = 5500; envAD(ag.gain, t, .01, .05 * v, 1.4); a.connect(hp); hp.connect(ag); route(ag, sfx, .6);
    },
    lock(t, e, v) {                             // 陶瓷轻碰：短促非谐分音 + 一点点击
      const n = e.n || 1, base = 2100 * (1 + ((Math.round(t * 8) % 5) - 2) * .03);
      for (const [r, a, d] of [[1, 1, .09], [1.47, .55, .06], [2.63, .3, .04]]) {
        const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = base * r;
        envAD(g.gain, t, .001, .1 * a * v * (n > 1 ? 1.25 : 1), d); o.connect(g); route(g, sfx, .25); o.start(t); o.stop(t + d + .2);
      }
      const c = noiseSrc(t, .03), bp = ac.createBiquadFilter(), cg = ac.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 4200; bp.Q.value = 2; envAD(cg.gain, t, .0005, .12 * v, .012);
      c.connect(bp); bp.connect(cg); route(cg, sfx);
      if (n > 1) for (let k = 1; k <= 3; k++) {                    // 多块同时锁定：几声极轻的余响，不叠爆
        const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = base * (1.1 + k * .13);
        envAD(g.gain, t + k * .018, .001, .035 * v, .07); o.connect(g); route(g, sfx, .3); o.start(t + k * .018); o.stop(t + k * .018 + .3);
      }
    },
    gate(t, e, v) {                             // 放行钟音：第 i 关沿五声音阶往上走
      const i = e.i ?? 0, m = PENT[pidx(62) + (i % 8)] + (i >= 8 ? 12 : 0);
      bell(t, m, 1.25 * v, 3.2, sfx, .5);
      bell(t, m - 12, .55 * v, 2.2, sfx, .4);
    },
    tick(t, e, v) {                             // 数字跳动：细小的滴答
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine';
      o.frequency.value = 3400 + ((e.i ?? 0) % 4) * 120;
      envAD(g.gain, t, .0005, .06 * v, .025); o.connect(g); route(g, sfx, .08); o.start(t); o.stop(t + .08);
    },
    whoosh(t, e, v) {                           // 镜头大动：带通噪声扫频
      const dur = Math.max(.25, e.dur || .8), soft = e.soft ? .45 : 1, pk = t + dur * .55;
      const s = noiseSrc(t, dur + .2), bp = ac.createBiquadFilter(), g = ac.createGain();
      bp.type = 'bandpass'; bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(320, t); bp.frequency.exponentialRampToValueAtTime(1900, pk); bp.frequency.exponentialRampToValueAtTime(600, t + dur);
      const lvl = (dur > 3 ? .09 : .16) * soft * v;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lvl, pk); g.gain.linearRampToValueAtTime(0, t + dur);
      s.connect(bp); bp.connect(g); route(g, sfx, .25);
    },
    riser(t, e, v) {                            // 转折前上升音：高通噪声 + 两个上滑正弦，末端干净切断
      const dur = Math.max(.5, e.dur || 2), end = t + dur;
      const s = noiseSrc(t, dur + .1), hp = ac.createBiquadFilter(), g = ac.createGain();
      hp.type = 'bandpass'; hp.Q.value = .9; hp.frequency.setValueAtTime(500, t); hp.frequency.exponentialRampToValueAtTime(6000, end);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.12 * v, end - .04); g.gain.linearRampToValueAtTime(0, end);
      s.connect(hp); hp.connect(g); route(g, sfx, .35);
      for (const [m0, a] of [[50, .06], [57, .04]]) {
        const o = ac.createOscillator(), og = ac.createGain(); o.type = 'sine';
        o.frequency.setValueAtTime(mtof(m0), t); o.frequency.exponentialRampToValueAtTime(mtof(m0 + 12), end);
        og.gain.setValueAtTime(0, t); og.gain.linearRampToValueAtTime(a * v, end - .04); og.gain.linearRampToValueAtTime(0, end);
        o.connect(og); route(og, sfx, .3); o.start(t); o.stop(end + .05);
      }
    },
    thud(t, e, v) {                             // 石膏块落地
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.setValueAtTime(80, t); o.frequency.exponentialRampToValueAtTime(46, t + .18);
      envAD(g.gain, t, .002, .5 * v, .22); o.connect(g); route(g, sfx, .12); o.start(t); o.stop(t + .4);
      const s = noiseSrc(t, .15), lp = ac.createBiquadFilter(), ng = ac.createGain();
      lp.type = 'lowpass'; lp.frequency.value = 900; envAD(ng.gain, t, .001, .22 * v, .07); s.connect(lp); lp.connect(ng); route(ng, sfx);
    },
    pin(t, e, v) {                              // 金属钉：高而短的金属声 + 敲击
      for (const [f, a, d] of [[2650, 1, .35], [3980, .5, .22], [6120, .25, .12]]) {
        const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f;
        envAD(g.gain, t, .001, .07 * a * v, d); o.connect(g); route(g, sfx, .3); o.start(t); o.stop(t + d + .2);
      }
      SFX.thud(t, e, .45 * v);
    },
    paper(t, e, v) {                            // 纸张展开：一串短促的带通噪声（固定种子）
      const r = F.rng(Math.round(t * 1000) + 5); const n = 7, span = .38;
      for (let k = 0; k < n; k++) {
        const tk = t + span * k / n + r() * .03, s = noiseSrc(tk, .06), bp = ac.createBiquadFilter(), g = ac.createGain();
        bp.type = 'bandpass'; bp.frequency.value = 2500 + r() * 3000; bp.Q.value = 1.5;
        envAD(g.gain, tk, .002, (.08 + r() * .06) * v, .04 + r() * .03); s.connect(bp); bp.connect(g); route(g, sfx, .15);
      }
    },
    gear(t, e, v) {                             // 齿轮咔哒：三声棘轮
      for (let k = 0; k < 3; k++) {
        const tk = t + k * .055, s = noiseSrc(tk, .03), bp = ac.createBiquadFilter(), g = ac.createGain();
        bp.type = 'bandpass'; bp.frequency.value = 1800 - k * 150; bp.Q.value = 4;
        envAD(g.gain, tk, .0005, (k === 0 ? .28 : .18) * v, .02); s.connect(bp); bp.connect(g); route(g, sfx, .1);
      }
    },
    crack(t, e, v) {                            // 石膏裂：尖锐爆裂 + 几粒碎响 + 低沉一震
      const s = noiseSrc(t, .12), hp = ac.createBiquadFilter(), g = ac.createGain();
      hp.type = 'highpass'; hp.frequency.value = 1800; envAD(g.gain, t, .0005, .3 * v, .05); s.connect(hp); hp.connect(g); route(g, sfx, .3);
      const r = F.rng(Math.round(t * 1000) + 9);
      for (let k = 0; k < 5; k++) {
        const tk = t + .02 + r() * .2, c = noiseSrc(tk, .02), bp = ac.createBiquadFilter(), cg = ac.createGain();
        bp.type = 'bandpass'; bp.frequency.value = 2500 + r() * 2500; bp.Q.value = 3; envAD(cg.gain, tk, .0005, .08 * v, .012);
        c.connect(bp); bp.connect(cg); route(cg, sfx);
      }
      SFX.thud(t, e, .5 * v);
    },
    rain(t, e, v) {                             // 雨声：高通 + 带通噪声床，首尾各 0.8 s 渐变
      const dur = Math.max(1, e.dur || 4), s = noiseSrc(t, dur), hp = ac.createBiquadFilter(), lp = ac.createBiquadFilter(), g = ac.createGain();
      hp.type = 'highpass'; hp.frequency.value = 900; lp.type = 'lowpass'; lp.frequency.value = 7500;
      const fi = Math.min(.8, dur / 3);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.075 * v, t + fi);
      g.gain.setValueAtTime(.075 * v, t + dur - fi); g.gain.linearRampToValueAtTime(0, t + dur);
      s.connect(hp); hp.connect(lp); lp.connect(g); route(pan(g, 0), sfx, .2);
      const r = F.rng(Math.round(t * 1000) + 21), nd = Math.floor(dur * 5);      // 屋檐滴水
      for (let k = 0; k < nd; k++) {
        const tk = t + fi + r() * Math.max(.1, dur - 2 * fi), o = ac.createOscillator(), og = ac.createGain();
        o.frequency.setValueAtTime(1800 + r() * 1600, tk); o.frequency.exponentialRampToValueAtTime(900, tk + .03);
        envAD(og.gain, tk, .001, .018 * v, .03); o.connect(og); route(pan(og, r() * 1.2 - .6), sfx, .3); o.start(tk); o.stop(tk + .08);
      }
    },
    stamp(t, e, v) {                            // 盖章：闷响 + 纸面拍击
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(60, t + .1);
      envAD(g.gain, t, .002, .55 * v, .18); o.connect(g); route(g, sfx, .2); o.start(t); o.stop(t + .35);
      const s = noiseSrc(t, .1), bp = ac.createBiquadFilter(), ng = ac.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = .8; envAD(ng.gain, t, .001, .3 * v, .05);
      s.connect(bp); bp.connect(ng); route(ng, sfx, .2);
    },
  };

  // 惰性排程：Chrome 里已创建、尚未开始的音源也会让下游滤波器从第 0 秒起一直运算，
  // 所以每个音符/音效先进队列，渲染时按 2 s 一窗（OfflineAudioContext.suspend）才真正建节点。
  const Q = [];
  const defer = fn => (t, ...a) => { Q.push({ t, f: () => fn(t, ...a) }); };
  kick = defer(kick); clap = defer(clap); hat = defer(hat); tom = defer(tom); bass = defer(bass);
  pad = defer(pad); pluck = defer(pluck); bell = defer(bell); gliss = defer(gliss);
  for (const k of Object.keys(SFX)) SFX[k] = defer(SFX[k]);
  const flush = until => {
    for (;;) {
      const due = []; for (let i = Q.length - 1; i >= 0; i--) if (Q[i].t < until) { due.push(Q[i]); Q.splice(i, 1); }
      if (!due.length) return;
      due.sort((a, b) => a.t - b.t); for (const d of due) d.f();
    }
  };

  // 事件整理：同类型 30 ms 内只出一声；同一时刻多个事件按 1/√n 让位
  const evs = [];
  for (const e of events.slice().sort((a, b) => a.t - b.t)) {
    if (!SFX[e.type] || !(e.t >= 0) || e.t >= DUR) continue;
    const dup = evs.find(x => x.type === e.type && Math.abs(x.t - e.t) < .03);
    if (dup) { if ((e.dur || 0) > (dup.dur || 0)) dup.dur = e.dur; if ((e.n || 1) > (dup.n || 1)) dup.n = e.n; continue; }
    evs.push(Object.assign({}, e));
  }
  const PERC = { hit: 1, lock: 1, gate: 1, thud: 1, pin: 1, crack: 1, stamp: 1, gear: 1, tick: 1, paper: 1 };
  if (!OFF.sfx) for (const e of evs) {
    const n = evs.filter(x => PERC[x.type] && Math.abs(x.t - e.t) < .05).length;
    const v = PERC[e.type] ? 1 / Math.sqrt(Math.max(1, n)) : 1;
    SFX[e.type](e.t, e, v * (e.gain ?? 1));
  }
  // 结构性上升音 / 开场雨：只有场景没登记时才补
  const risers = evs.filter(e => e.type === 'riser');
  for (const b of [24, 72, 160]) if (!risers.some(e => Math.abs(e.t + (e.dur || 2) - b) < .6)) SFX.riser(b - 2, { dur: 2 }, .6);
  if (!evs.some(e => e.type === 'rain' && e.t < 8 && e.t + (e.dur || 0) > 0)) SFX.rain(0, { dur: 9 }, 1);
  // 放行钟音时音乐让位（-4 dB，0.9 s 回来）
  duck.gain.setValueAtTime(1, 0);
  for (const e of evs.filter(e => e.type === 'gate')) {
    duck.gain.setTargetAtTime(.63, e.t, .01); duck.gain.setTargetAtTime(1, e.t + .15, .25);
  }

  // ── 作曲：逐小节 ──
  // 开场 0–0.5：反向噪声吸入第一拍
  { const s = noiseSrc(0, .5), lp = ac.createBiquadFilter(), g = ac.createGain();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(400, 0); lp.frequency.exponentialRampToValueAtTime(5000, .48);
    g.gain.setValueAtTime(.001, 0); g.gain.exponentialRampToValueAtTime(.12, .48); g.gain.linearRampToValueAtTime(0, .5);
    s.connect(lp); lp.connect(g); route(g, music, .3); }
  bass(.5, 26, 7.4, .55, 200);                              // D1 低持续音
  pad(.5, [50, 57, 62, 65, 69], 3.5, .9, 900, 1.2, .9, .4);
  pad(4, CH.Bb.pad, 2, .9, 1000, .4, .7, .4);
  pad(6, CH.C.pad, 2, .95, 1200, .4, .6, .4);
  { const seq = [0, 2, 4, 2, 1, 3, 5, 3, 2, 4, 6, 4, 7], a = pidx(57);  // 面板每拍亮一格：拨弦同拍往上走
    seq.forEach((d, i) => pluck(1 + i * BEAT, PENT[a + d], .55 + i * .02, i % 2 ? .25 : -.25, 1.0, 2400)); }

  for (let b = 4; b < 90; b++) {
    const t = b * BAR, name = chordAt(b), C = CH[name], k4 = b % 4;
    // 问题 8–24：低沉、悬疑
    if (t < 24) {
      pad(t, C.pad.map(m => m - 12 >= 45 ? m - 12 : m), 2, .95, 650, .5, .9, .45);
      bass(t, C.root - 12 >= 24 ? C.root - 12 : C.root, 2, .8, 180);
      kick(t, .5); kick(t + .25, .3);                      // 心跳
      const a = pidx(C.anchor - 12);
      pluck(t + .5, PENT[a + 2], .45, -.3, 1.2, 1800); pluck(t + 1.25, PENT[a + (k4 % 2 ? 1 : 3)], .38, .3, 1.2, 1600);
      if (t >= 16) {
        for (let s = 0; s < 8; s++) if (s % 2) bass(t + s * .25, C.root, .2, .45, 300);
        hat(t + .5, .5); hat(t + 1.5, .5);
      }
      if (t === 22) for (let s = 0; s < 4; s++) tom(t + 1 + s * .25, 110 - s * 12, .35 + s * .12);   // 进原理段的鼓过门
      continue;
    }
    // 原理 24–64：推进，鼓组进来
    if (t < 64) {
      const full = t >= 40;
      pad(t, C.pad, 2, 1, full ? 1500 : 1200);
      for (let s = 0; s < 8; s++) {
        const ts = t + s * .25;
        bass(ts, C.root + (full && s % 2 ? 12 : 0), .22, s === 0 ? 1 : .7, 380);
      }
      for (let bt = 0; bt < 4; bt++) { if (full || bt % 2 === 0) kick(t + bt * BEAT, bt ? .85 : 1); }
      clap(t + BEAT, .8); clap(t + 3 * BEAT, .85);
      for (let s = 0; s < (full ? 16 : 8); s++) {
        const ts = t + s * (full ? S16 : .25), off = full ? s % 4 === 2 : s % 2 === 1;
        hat(ts, off ? .9 : .45, false, s % 2 ? .2 : -.2);
      }
      const P = PATS[(b + (full ? 1 : 0)) % 4], a = pidx(C.anchor);
      P.forEach((d, s) => { if (d !== null) pluck(t + s * .25, PENT[a + d], s % 2 ? .45 : .6, s % 2 ? .35 : -.35, .7); });
      if (t === 62) for (let s = 0; s < 8; s++) tom(t + 1 + s * S16, 140 - s * 10, .3 + s * .06);
      continue;
    }
    // 转折 64–72：收一下
    if (t < 72) {
      pad(t, C.pad, 2, .95, 900, .5, 1.1, .5);
      bass(t, C.root, 1.9, .75, 220);
      if (k4 === 0) kick(t, .8);
      const a = pidx(C.anchor);
      pluck(t, PENT[a + 2], .5, -.3, 1.2, 2000); pluck(t + 1, PENT[a + 4], .45, .3, 1.2, 2000);
      if (t === 70) {                                      // 军鼓滚奏渐强 → 上行刮奏进入关卡段
        for (let s = 0; s < 8; s++) clap(t + s * S16, .15 + s * .03, .15);
        for (let s = 0; s < 12; s++) clap(t + 1 + s * .0625, .3 + s * .03, .15);
        gliss(t + 1.55, 57, 81, .4, .6);
      }
      continue;
    }
    // 关卡 72–160：最饱满，每关一个 8 s 循环；u=4.0–4.5 留一口气，4.5 放行钟音（事件）后全部回来
    if (t < 160) {
      const gi = Math.floor((t - 72) / 8), u0 = t - 72 - gi * 8, last = gi === 10;
      const breath = ts => { const u = ts - 72 - gi * 8; return u >= 4.0 && u < 4.5; };
      pad(t, C.pad, 2, 1, 1600 + gi * 40);
      const bpat = [[0, 1], [3, .6], [6, .75, 12], [8, .8], [11, .6], [14, .7, 12]];
      for (const [s, v, o] of bpat) { const ts = t + s * S16; if (!breath(ts)) bass(ts, C.root + (o || 0), .2, v, 420); }
      for (let bt = 0; bt < 4; bt++) { const ts = t + bt * BEAT; if (!breath(ts) && !(last && u0 === 6 && bt >= 3)) kick(ts, bt ? .85 : 1); }
      for (const bt of [1, 3]) { const ts = t + bt * BEAT; if (!breath(ts)) clap(ts, .85); }
      const sixteen = gi >= 3;
      for (let s = 0; s < (sixteen ? 16 : 8); s++) {
        const ts = t + s * (sixteen ? S16 : .25); if (breath(ts)) continue;
        const off = sixteen ? s % 4 === 2 : s % 2 === 1;
        hat(ts, off ? .9 : (s % 2 ? .35 : .5), false, s % 2 ? .22 : -.22);
      }
      if (!breath(t + 1.75)) hat(t + 1.75, .8, true, .3);
      const P = PATS[(gi + k4) % 4], a = pidx(C.anchor) + (k4 === 2 ? 1 : 0);
      P.forEach((d, s) => { const ts = t + s * .25; if (d !== null && !breath(ts)) pluck(ts, PENT[a + d], s % 2 ? .42 : .58, s % 2 ? .35 : -.35, .7); });
      if (gi >= 5 && (u0 === 0 || u0 === 2)) bell(t, PENT[pidx(C.anchor) + 5 + (u0 ? -1 : 0) + (gi % 3)], .7, 1.8, music, .5, -.2);
      if (u0 === 6 && !last) gliss(t + 1.5, 86, 62, .45, .55);       // 每关结尾一记下行刮奏，把镜头送过门
      continue;
    }
    // 收束 160–176：开阔，和声展开，半速鼓
    if (t < 176) {
      const wide = C.pad.concat([C.pad[1] + 12, C.pad[3] + 12]).concat([C.root + 12]);
      pad(t, wide, 2, 1.05, 2200, .35, 1.2, .55);
      bass(t, C.root, 1.95, .95, 300);
      kick(t, 1); kick(t + 1.25, .6);
      clap(t + 1, .8, .55);
      for (let s = 0; s < 4; s++) hat(t + .25 + s * .5, .45, false, s % 2 ? .2 : -.2);
      const a = pidx(C.anchor);
      [0, 2, 4, 5].forEach((d, s) => pluck(t + s * BEAT, PENT[a + d], .5, (s - 1.5) * .25, 1.0, 2600));
      const mel = [69, 72, 74, 72, 69, 72, 74, 74][b - 80];
      bell(t, mel, .75, 2.4, music, .6, .15);
      if (t === 166) gliss(t + 1.5, 62, 86, .45, .5);
      continue;
    }
    // 176–180：Dsus2 延长，随画面渐隐
    pad(t, CH.Dsus2.pad, 180 - t, .9, 1600, .2, 1, .6);
    bass(t, 26, 180 - t, .8, 200);
    if (t === 176) { bell(t, 74, .8, 3.6, music, .7); bell(t, 81, .45, 3.6, music, .7, .25); }
  }
  return { master, flush };
}

// ─── 离线渲染 + 响度归一（BS.1770 K 加权，门限积分）+ 前瞻限幅 ───────────────
function biquad(x, b, a) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function lufs(chs) {
  const kw = chs.map(c => biquad(biquad(c, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, .73248077421585]),
    [1, -2, 1], [1, -1.99004745483398, .99007225036621]));
  const N = kw[0].length, blk = Math.round(.4 * SR), hop = Math.round(.1 * SR), ms = [];
  const pre = kw.map(c => { const p = new Float64Array(N + 1); for (let i = 0; i < N; i++) p[i + 1] = p[i] + c[i] * c[i]; return p; });
  for (let s = 0; s + blk <= N; s += hop) { let z = 0; for (const p of pre) z += (p[s + blk] - p[s]) / blk; ms.push(z); }
  const L = z => -.691 + 10 * Math.log10(z + 1e-20);
  const g1 = ms.filter(z => L(z) > -70); if (!g1.length) return -70;
  const m1 = g1.reduce((a, b) => a + b, 0) / g1.length, rel = L(m1) - 10;
  const g2 = g1.filter(z => L(z) > rel); return L(g2.reduce((a, b) => a + b, 0) / g2.length);
}
function limit(chs, ceil) {
  const N = chs[0].length, La = 96;                            // 2 ms 前瞻
  const req = new Float32Array(N);
  for (let i = 0; i < N; i++) { let p = 0; for (const c of chs) p = Math.max(p, Math.abs(c[i])); req[i] = p > ceil ? ceil / p : 1; }
  // 滑动最小（窗口 ±La）
  const mn = new Float32Array(N), dq = new Int32Array(N); let h = 0, tl = 0, j = 0;
  for (let i = 0; i < N; i++) {
    while (j < N && j <= i + La) { while (tl > h && req[dq[tl - 1]] >= req[j]) tl--; dq[tl++] = j; j++; }
    while (dq[h] < i - La) h++;
    mn[i] = req[dq[h]];
  }
  // 盒式平滑（宽 La，保证不高于所需增益），再加 80 ms 释放
  const ps = new Float64Array(N + 1); for (let i = 0; i < N; i++) ps[i + 1] = ps[i] + mn[i];
  const half = La >> 1, rel = 1 - Math.exp(-1 / (.08 * SR)); let g = 1, hits = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - half), b = Math.min(N, i + half + 1), s = (ps[b] - ps[a]) / (b - a);
    g = Math.min(s, g + (1 - g) * rel); if (g < .999) hits++;
    for (const c of chs) c[i] *= g;
  }
  return hits / N;
}
async function renderBuffer(opts = {}) {
  const events = (F.events || []).slice();
  const ac = new OfflineAudioContext(2, SR * (opts.len || DUR), SR);
  const { flush } = build(ac, events, opts);
  const LEN = opts.len || DUR, AHEAD = 3;
  flush(AHEAD);
  for (let T = 2; T < LEN; T += 2) ac.suspend(T).then(() => { flush(T + AHEAD); ac.resume(); });
  const buf = await ac.startRendering();
  const chs = [buf.getChannelData(0), buf.getChannelData(1)];
  const info = { lufsRaw: lufs(chs) };
  if (opts.raw && opts.gain) for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= opts.gain;   // 分轨调试用
  if (!opts.raw) {
    // 两轮：按积分响度定增益 → 限幅 → 复测补偿
    let gain = Math.pow(10, (TARGET_LUFS - info.lufsRaw) / 20);
    for (let pass = 0; pass < 2; pass++) {
      for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= gain;
      info['limited' + pass] = limit(chs, CEIL);
      const l = lufs(chs); info['lufs' + pass] = l;
      gain = Math.pow(10, Math.max(-3, Math.min(3, TARGET_LUFS - l)) / 20);
      if (Math.abs(TARGET_LUFS - l) < .15) break;
    }
    let pk = 0; for (const c of chs) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]));
    info.peakDb = 20 * Math.log10(pk);
  }
  score.lastInfo = info;
  return buf;
}
function toWavB64(buf) {
  const n = buf.length, ch = buf.numberOfChannels, bytes = 44 + n * ch * 2, ab = new ArrayBuffer(bytes), dv = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); ws(8, 'WAVE'); ws(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * ch * 2, true);
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); ws(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const cs = [...Array(ch)].map((_, c) => buf.getChannelData(c)); let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, cs[c][i])); dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2; }
  const u8 = new Uint8Array(ab); let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

const score = {
  build,                                     // build(ac, events, opts) → { master, flush(until) }：flush 把 until 之前的音符真正建进图里
  render: renderBuffer,                      // → Promise<AudioBuffer>（已归一、已限幅）
  lastInfo: null,
  // 实时播放：先离线渲染成 buffer，再在 ac 上从 offset 秒处播放（和 wav() 完全同一份声音）
  async play(ac, when = ac.currentTime + .1, offset = 0) {
    const buf = await renderBuffer(); const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
    src.start(when, offset); return src;
  },
};
window.__film.score = score;
window.__film.wav = async (opts = {}) => toWavB64(await renderBuffer(opts));
})();
