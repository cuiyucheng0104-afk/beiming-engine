// 北冥 QA · delivery：交付规格。容器、完整解码、帧数、帧率与 CFR、时长、尺寸、SAR、编码、像素格式、BT.709 tv 色彩标注
// 及像素范围、音轨、音画首尾、ebur128 响度与真峰值、faststart、AIGC 标识。期望值全部来自档位与作品描述。
//
//   runDelivery({ input, profile, film, timeoutMs }) → { checks, probe, facts }
//        facts = { sha256, frames, width, height, fps, pixFmt, color, durationSec } 供报告与 run.json 用
import fs from 'node:fs';
import { makeCheck, finding, settle, notRun } from '../lib/checks.mjs';
import { probeFile, videoPackets, sha256File, topLevelBoxes, num, rate, sameRate } from '../lib/probe.mjs';
import { run, tool, tail } from '../lib/proc.mjs';
import { measureLoudness } from '../lib/audio.mjs';
import { grabRawY } from '../lib/frames.mjs';
import { fpsOf } from '../lib/profiles.mjs';

const fmtRate = r => (r ? (r.den === 1 ? `${r.num}` : `${r.num}/${r.den}`) : '未知');
const AIGC_MARK = /AIGC|AI[\s-]?generated|AI\s*生成|人工智能生成/i;

export async function runDelivery({ input, profile, film = null, timeoutMs }) {
  const checks = [];
  const add = c => { checks.push(settle(c)); return c; };
  const facts = { sha256: await sha256File(input), size: fs.statSync(input).size };
  const pfps = fpsOf(profile);

  // ── 容器 ──
  const container = makeCheck('delivery.container', { expected: `${profile.container.formats.join(' / ')}，1 条视频流` });
  let pr;
  try { pr = await probeFile(input, { timeoutMs }); } catch (e) {
    finding(container, { key: 'unreadable', message: e.message, hint: e.hint });
    add(container);
    return { checks, probe: null, facts };
  }
  const fmtNames = String(pr.format.format_name || '').split(',');
  container.value = `${pr.format.format_name}（${pr.videos.length} 条视频、${pr.audios.length} 条音频）`;
  container.evidence = { formatName: pr.format.format_name, majorBrand: pr.format.tags?.major_brand ?? null, streams: pr.streams.length };
  if (!profile.container.formats.some(f => fmtNames.includes(f))) finding(container, { key: 'format', message: `容器是 ${pr.format.format_name}，不是 ${profile.container.formats.join(' / ')}` });
  if (pr.videos.length !== 1) finding(container, { key: 'video-streams', message: `应有 1 条视频流，实际 ${pr.videos.length} 条` });
  add(container);
  const v = pr.video;
  if (!v) return { checks, probe: pr, facts };
  const vr = rate(v.r_frame_rate), va = rate(v.avg_frame_rate);
  const tb = rate(v.time_base);

  // ── 完整解码（-xerror），顺便数帧 ──
  const decode = makeCheck('delivery.decode', { expected: '无解码错误' });
  // framecrc 每个解码出的画面一行（# 开头的是表头）；passthrough 保证不因时间戳增删帧
  const args = ['-v', 'error', '-xerror', '-nostdin', '-i', input, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framecrc', 'pipe:1'];
  if (pr.audio) args.push('-map', '0:a:0', '-f', 'null', '-');
  let frames = 0, pending = '';
  const countLines = chunk => {
    const lines = (pending + chunk.toString('latin1')).split('\n');
    pending = lines.pop();
    for (const l of lines) if (l && l[0] !== '#') frames++;
  };
  const r = await run(tool('ffmpeg'), args, { timeoutMs, onStdout: countLines });
  if (pending && pending[0] !== '#') frames++;
  const errLines = r.stderr.split(/\r?\n/).filter(l => l.trim());
  decode.value = r.code === 0 && !errLines.length ? `完整解码无错误（${frames} 帧）` : `退出码 ${r.code}`;
  decode.evidence = { exitCode: r.code, decodedFrames: frames, errors: errLines.slice(0, 8) };
  if (r.code !== 0) finding(decode, { key: 'xerror', message: `解码在出错时中止（已解出 ${frames} 帧）：${tail(r.stderr) || '无输出'}`, hint: '文件可能被截短或损坏；重新封装（必要时重渲）后再验' });
  else if (errLines.length) finding(decode, { key: 'errors', message: `解码过程报了 ${errLines.length} 条错误：${errLines[0]}` });
  add(decode);
  facts.frames = frames;

  const fc = makeCheck('delivery.frame-count');
  const expectFrames = film?.frameCount ?? null;
  fc.value = facts.frames;
  if (expectFrames !== null) {
    fc.expected = expectFrames;
    if (facts.frames !== expectFrames) finding(fc, { key: 'mismatch', message: `实际 ${facts.frames ?? '无法计数'} 帧，作品描述要求 ${expectFrames} 帧`, hint: '缺帧不要用 fps 滤镜或补帧「修」，回到渲染查原因（validation-and-rtx.md 第 2 节）' });
  } else {
    const dur = num(v.duration) ?? num(pr.format.duration);
    const est = dur && pfps ? Math.round(dur * pfps.value) : null;
    fc.expected = est !== null ? `约 ${est}（没有作品描述，只按时长×帧率估）` : null;
    finding(fc, { key: 'no-film', status: 'warn', message: '没有作品描述（--film），帧数只能与时长自洽，不能核对 frameCount' });
    if (est !== null && facts.frames !== null && Math.abs(est - facts.frames) > 1) finding(fc, { key: 'self', message: `解码 ${facts.frames} 帧，与时长×帧率 ${est} 不符` });
  }
  add(fc);

  // ── 帧率与 CFR ──
  const frc = makeCheck('delivery.frame-rate', { expected: fmtRate(pfps) });
  frc.value = `r=${fmtRate(vr)} avg=${fmtRate(va)}`;
  if (!sameRate(vr, pfps)) finding(frc, { key: 'r', message: `r_frame_rate 是 ${fmtRate(vr)}，档位要求 ${fmtRate(pfps)}` });
  if (!sameRate(va, pfps)) finding(frc, { key: 'avg', message: `avg_frame_rate 是 ${fmtRate(va)}，档位要求 ${fmtRate(pfps)}` });
  if (film?.fps && !sameRate(film.fps, pfps)) finding(frc, { key: 'film', message: `作品描述的 fps（${fmtRate(film.fps)}）与档位（${fmtRate(pfps)}）不一致` });
  add(frc);

  const cfr = makeCheck('delivery.cfr', { expected: tb && pfps ? `相邻 PTS 差 = ${(tb.den * pfps.den) / (tb.num * pfps.num)} tick（1/${fmtRate(pfps)} 秒）` : '等间隔' });
  try {
    const pk = (await videoPackets(input, { timeoutMs })).filter(p => p.pts !== null);
    const step = tb && pfps ? (tb.den * pfps.den) / (tb.num * pfps.num) : null;
    const bad = [];
    for (let i = 1; i < pk.length; i++) {
      const d = pk[i].pts - pk[i - 1].pts;
      if (step !== null ? Math.abs(d - step) > 1 : d <= 0) bad.push({ frame: i, delta: d });
    }
    cfr.value = bad.length ? `${bad.length} 处不等间隔` : `${pk.length} 个时间戳等间隔`;
    cfr.evidence = { packets: pk.length, stepTicks: step, firstPts: pk[0]?.pts ?? null, irregular: bad.slice(0, 20) };
    if (pk.length && pk[0].pts !== 0 && num(v.start_time) !== 0) cfr.evidence.startTime = num(v.start_time);
    for (const b of bad.slice(0, 5)) finding(cfr, { key: `pts@${b.frame}`, frames: [b.frame, b.frame + 1], message: `第 ${b.frame} 帧与前一帧的时间戳差 ${b.delta} tick（应为 ${step ?? '正数'}）` });
    if (bad.length > 5) finding(cfr, { key: 'pts-more', message: `另有 ${bad.length - 5} 处不等间隔` });
  } catch (e) { notRun(cfr, e.message); }
  add(cfr);

  const durc = makeCheck('delivery.duration');
  const vdur = num(v.duration);
  const want = (expectFrames ?? facts.frames) && pfps ? (expectFrames ?? facts.frames) / pfps.value : null;
  durc.value = vdur !== null ? `${vdur.toFixed(4)} 秒` : '未知';
  durc.expected = want !== null ? `${want.toFixed(4)} 秒 ± 1 帧` : null;
  facts.durationSec = vdur;
  if (vdur === null) finding(durc, { key: 'unknown', status: 'warn', message: '视频流没有 duration 字段，按帧数核对' });
  else if (want !== null && Math.abs(vdur - want) > 1 / pfps.value + 1e-6) finding(durc, { key: 'mismatch', message: `视频时长 ${vdur.toFixed(4)} 秒，应为 ${want.toFixed(4)} 秒` });
  add(durc);

  // ── 尺寸、SAR、编码、像素格式 ──
  const sz = makeCheck('delivery.size', { expected: `${profile.width}×${profile.height}` });
  sz.value = `${v.width}×${v.height}`;
  facts.width = v.width; facts.height = v.height;
  if (v.width !== profile.width || v.height !== profile.height) finding(sz, { key: 'mismatch', message: `画幅 ${v.width}×${v.height}，档位 ${profile.id} 要求 ${profile.width}×${profile.height}` });
  if (v.width % 2 || v.height % 2) finding(sz, { key: 'odd', message: '宽高必须是偶数（yuv420p 的要求）' });
  if (film?.width && film?.height && (film.width !== profile.width || film.height !== profile.height)) {
    finding(sz, { key: 'film', message: `作品描述的画幅 ${film.width}×${film.height} 与档位 ${profile.id} 不一致：改 output.profile 或改画幅` });
  }
  add(sz);

  const sar = makeCheck('delivery.sar', { expected: profile.video.sar });
  const s = v.sample_aspect_ratio;
  sar.value = s || '未标（按 1:1）';
  if (s && s !== '0:1' && s !== 'N/A' && s !== profile.video.sar) finding(sar, { key: 'mismatch', message: `SAR 是 ${s}，应为 ${profile.video.sar}` });
  add(sar);

  const codec = makeCheck('delivery.codec', { expected: `${profile.video.codec}（${profile.video.profiles.join(' / ')}，Level ≤ ${profile.video.maxLevel}）` });
  const level = num(v.level) !== null && num(v.level) > 0 ? num(v.level) / 10 : null;
  codec.value = `${v.codec_name}${v.profile ? `（${v.profile}` : '（'}${level ? `@${level}` : ''}）`;
  codec.evidence = { codec: v.codec_name, profile: v.profile ?? null, level };
  if (v.codec_name !== profile.video.codec) finding(codec, { key: 'codec', message: `编码是 ${v.codec_name}，应为 ${profile.video.codec}` });
  if (v.profile && !profile.video.profiles.includes(v.profile)) finding(codec, { key: 'profile', status: 'warn', message: `H.264 档次是 ${v.profile}，档位建议 ${profile.video.profiles.join(' / ')}` });
  if (level && profile.video.maxLevel && level > profile.video.maxLevel + 1e-9) {
    finding(codec, { key: 'level', status: 'warn', message: `Level ${level} 高于 ${profile.video.maxLevel}：部分硬件解码器与老设备放不了（参考帧数超了解码缓冲，见 routes/directing/craft/video.md §5.5）` });
  }
  add(codec);

  const pf = makeCheck('delivery.pix-fmt', { expected: profile.video.pixFmt });
  pf.value = v.pix_fmt;
  facts.pixFmt = v.pix_fmt;
  if (v.pix_fmt !== profile.video.pixFmt) {
    finding(pf, { key: 'mismatch', message: `像素格式 ${v.pix_fmt}，应为 ${profile.video.pixFmt}`, hint: /^yuvj/.test(v.pix_fmt) ? 'yuvj* 是全范围像素：编码前用 scale 做 full→tv 范围转换（不能只改标签）' : null });
  }
  add(pf);

  // ── 色彩标注 ──
  const col = makeCheck('delivery.color', { expected: `range=${profile.video.colorRange} matrix=${profile.video.colorSpace} primaries=${profile.video.colorPrimaries} transfer=${profile.video.colorTransfer}` });
  const got = { range: v.color_range || 'unknown', matrix: v.color_space || 'unknown', primaries: v.color_primaries || 'unknown', transfer: v.color_transfer || 'unknown' };
  facts.color = got;
  col.value = `range=${got.range} matrix=${got.matrix} primaries=${got.primaries} transfer=${got.transfer}`;
  const expect = { range: profile.video.colorRange, matrix: profile.video.colorSpace, primaries: profile.video.colorPrimaries, transfer: profile.video.colorTransfer };
  const colorHint = '像素与标签要一起改：编码前 scale=out_color_matrix=bt709:out_range=tv 做一次转换，滤镜链末尾加 setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv，'
    + '再写 -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv（FFmpeg 8 实测：只写编码器参数而帧上没有原色 / 传递属性时，这两项会是 unknown）';
  for (const k of ['range', 'matrix', 'primaries', 'transfer']) {
    if (got[k] !== expect[k]) finding(col, { key: k, message: `${k} 是 ${got[k]}，应为 ${expect[k]}`, hint: colorHint });
  }
  add(col);

  // 标签说有限范围时，抽几帧原尺寸 Y 平面，看像素是不是真的落在 16–235
  const rp = makeCheck('delivery.range-pixels', { expected: 'Y 码值在 16–235 之外的像素 < 1%' });
  if (got.range === 'tv' && facts.frames) {
    try {
      const picks = [...new Set([0, 0.25, 0.5, 0.75, 1].map(x => Math.min(facts.frames - 1, Math.round(x * (facts.frames - 1)))))];
      const ys = await grabRawY(input, picks, { w: v.width, h: v.height, timeoutMs });
      let below = 0, above = 0, total = 0;
      for (const y of ys.values()) { for (const p of y) { if (p < 16) below++; else if (p > 235) above++; } total += y.length; }
      const frac = total ? (below + above) / total : 0;
      rp.value = `${(frac * 100).toFixed(2)}%（<16：${below}，>235：${above}，共抽 ${ys.size} 帧）`;
      rp.evidence = { frames: [...ys.keys()], below, above, total };
      if (frac >= 0.01) finding(rp, { key: 'out-of-range', message: `${(frac * 100).toFixed(1)}% 的像素超出有限范围：疑似全范围像素只改了标签`, hint: colorHint });
    } catch (e) { notRun(rp, e.message); }
  } else {
    rp.value = got.range === 'tv' ? '帧数未知，未抽查' : `范围标签是 ${got.range}，不适用`;
  }
  add(rp);

  // ── 音轨 ──
  const au = makeCheck('delivery.audio-stream', { expected: profile.audio.required ? `${profile.audio.codec}-${profile.audio.aacProfile}、${profile.audio.sampleRate} Hz、${profile.audio.channels} 声道` : '作品声明无声' });
  const a = pr.audio;
  if (!a) {
    au.value = '没有音轨';
    if (profile.audio.required) finding(au, { key: 'missing', message: '成片没有音轨（档位要求 AAC 48 kHz 立体声）', hint: '确认混音步骤产出了 mix.wav 并封装进去；确实是无声片就在 film.json 写 audio.mode = "none"' });
  } else {
    au.value = `${a.codec_name}${a.profile ? `-${a.profile}` : ''}、${a.sample_rate} Hz、${a.channels} 声道${a.channel_layout ? `（${a.channel_layout}）` : ''}`;
    if (a.codec_name !== profile.audio.codec) finding(au, { key: 'codec', message: `音频编码是 ${a.codec_name}，应为 ${profile.audio.codec}` });
    if (a.codec_name === 'aac' && a.profile && profile.audio.aacProfile && a.profile !== profile.audio.aacProfile) finding(au, { key: 'aac-profile', status: 'warn', message: `AAC 档次是 ${a.profile}，建议 ${profile.audio.aacProfile}` });
    if (num(a.sample_rate) !== profile.audio.sampleRate) finding(au, { key: 'rate', message: `采样率 ${a.sample_rate} Hz，应为 ${profile.audio.sampleRate} Hz` });
    if (a.channels !== profile.audio.channels) finding(au, { key: 'channels', message: `${a.channels} 声道，应为 ${profile.audio.channels} 声道` });
    if (pr.audios.length > 1) finding(au, { key: 'extra', status: 'warn', message: `有 ${pr.audios.length} 条音轨，播放器一般只放第一条` });
  }
  add(au);

  const av = makeCheck('delivery.av-align', { expected: pfps ? `首、尾差 ≤ 1 帧（${(1000 / pfps.value).toFixed(1)} ms）` : null });
  if (a && pfps) {
    const vs = num(v.start_time) ?? 0, as = num(a.start_time) ?? 0;
    const ve = vs + (num(v.duration) ?? (facts.frames ?? 0) / pfps.value), ae = as + (num(a.duration) ?? 0);
    const ds = (as - vs) * 1000, de = (ae - ve) * 1000, lim = 1000 / pfps.value + 0.5;
    av.value = `起点差 ${ds.toFixed(1)} ms，终点差 ${de.toFixed(1)} ms`;
    av.evidence = { videoStart: vs, videoEnd: ve, audioStart: as, audioEnd: ae };
    if (Math.abs(ds) > lim) finding(av, { key: 'start', message: `音画起点差 ${ds.toFixed(1)} ms，超过 1 帧` });
    if (Math.abs(de) > lim) finding(av, { key: 'end', message: `音画终点差 ${de.toFixed(1)} ms，超过 1 帧`, hint: de < 0 ? '声音比画面短：混音按全片时长出，或封装时补静音' : '声音比画面长：混音时长要等于 帧数 ÷ 帧率' });
  } else av.value = a ? '帧率未知' : '没有音轨，不适用';
  add(av);

  // ── 响度（对最终文件测，D07 / 档位） ──
  const loud = makeCheck('delivery.loudness', { expected: `${profile.audio.integratedLufs} LUFS ± ${profile.audio.lufsTolerance} LU` });
  const tp = makeCheck('delivery.true-peak', { expected: `≤ ${profile.audio.truePeakMaxDbtp.toFixed(1)} dBTP` });
  if (a) {
    try {
      const L = await measureLoudness(input, { timeoutMs });
      loud.value = `${L.integrated.toFixed(1)} LUFS`;
      loud.evidence = { integrated: L.integrated, lra: L.lra, maxMomentary: L.maxMomentary, maxShortTerm: L.maxShortTerm, gateThreshold: L.threshold };
      const dev = L.integrated - profile.audio.integratedLufs;
      if (Math.abs(dev) > profile.audio.lufsTolerance + 1e-9) {
        finding(loud, { key: 'integrated', message: `积分响度 ${L.integrated.toFixed(1)} LUFS，偏离目标 ${dev > 0 ? '+' : ''}${dev.toFixed(1)} LU`, hint: '在混音阶段按 BS.1770 算好增益；封装时不要再跑 loudnorm（会把 −14.1 压成 −14.9，见 routes/directing/craft/video.md §5.8）' });
      }
      tp.value = `${Number.isFinite(L.truePeak) ? L.truePeak.toFixed(1) : '−∞'} dBTP`;
      tp.evidence = { truePeak: L.truePeak };
      if (L.truePeak > profile.audio.truePeakMaxDbtp + 1e-9) finding(tp, { key: 'over', message: `真峰值 ${L.truePeak.toFixed(1)} dBTP，高于 ${profile.audio.truePeakMaxDbtp.toFixed(1)}`, hint: 'AAC 会抬高样本间峰值：混音（premaster）的真峰值留在 −1.5 到 −2 dBTP 更稳' });
    } catch (e) { notRun(loud, e.message); notRun(tp, e.message); }
  } else {
    loud.value = tp.value = '没有音轨';
    if (profile.audio.required) { finding(loud, { key: 'missing', message: '没有音轨，无法测响度' }); finding(tp, { key: 'missing', message: '没有音轨，无法测真峰值' }); }
  }
  add(loud); add(tp);

  // ── faststart ──
  const fs0 = makeCheck('delivery.faststart', { expected: profile.container.faststart === 'off' ? '不要求' : 'moov 在 mdat 之前' });
  if (profile.container.faststart !== 'off' && fmtNames.includes('mp4')) {
    const boxes = topLevelBoxes(input);
    const im = boxes.findIndex(b => b.type === 'moov'), id = boxes.findIndex(b => b.type === 'mdat');
    fs0.value = boxes.map(b => b.type).join(' → ');
    if (im < 0) finding(fs0, { key: 'no-moov', message: '文件头部找不到 moov' });
    else if (id >= 0 && im > id) finding(fs0, { key: 'late-moov', message: 'moov 在 mdat 之后：网页要下载完才能开播', hint: '封装时加 -movflags +faststart' });
  } else fs0.value = '不适用';
  add(fs0);

  // ── AIGC 标识（D11）──
  const ai = makeCheck('delivery.aigc-label', { expected: film?.aigc?.contains ? 'comment 含 AIGC 标识' : '作品未声明含 AI 生成画面时不要求' });
  const comment = pr.format.tags?.comment ?? pr.format.tags?.COMMENT ?? null;
  ai.value = comment ? `comment=${JSON.stringify(comment).slice(0, 80)}` : '没有 comment 元数据';
  if (!film) finding(ai, { key: 'no-film', status: 'warn', message: '没有作品描述，无法判断是否需要 AIGC 标识（D11）' });
  else if (film.aigc?.contains === true && !(comment && AIGC_MARK.test(comment))) {
    finding(ai, { key: 'missing', message: '作品声明含 AI 生成画面，但 mp4 的 comment 元数据里没有 AIGC 标识', hint: '封装时加 -metadata comment="含 AI 生成画面（AIGC）"，片尾或说明里也要写明（D11）' });
  } else if (film.aigc == null) finding(ai, { key: 'undeclared', status: 'warn', message: '作品描述没有 aigc 字段，无法核对 D11 标识' });
  add(ai);

  facts.fps = vr ? fmtRate(vr) : null;
  return { checks, probe: pr, facts };
}
