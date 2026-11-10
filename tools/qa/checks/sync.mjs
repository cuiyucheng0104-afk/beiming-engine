// 北冥 QA · sync：声画同步。对每个要求有声的事件（film.json 的 events[].audio / sfx: true，或 C 路线 events.json 里带 cue 的打点），
// 在最终文件解码出的音轨里找起音，量「起音 − 事件结果帧时刻」。容差按 routes/directing/craft/animation.md §5.7 的同步容差表（不对称）：
//   一般事件：声音晚于结果帧 0 – lateFrames 帧可以接受；早于结果帧不超过 earlyFrames 帧（24 fps 约 10 ms）
//   口型类（sync: "lip" 或 visual: "lip"）：允许晚到 lipLateFrames 帧（口型先到）
//   sync: "soft" 的事件只给软项，sync: "none" 的不查
// AAC 的编码延迟由 MP4 编辑列表在解码时扣掉，这里不再另加常数；起音检测方法见 tools/qa/lib/audio.mjs。
//
//   runSync({ input, profile, film, events, probe, timeoutMs }) → { checks }
import { makeCheck, finding, settle, notRun } from '../lib/checks.mjs';
import { probeFile } from '../lib/probe.mjs';
import { decodeMono, findOnset } from '../lib/audio.mjs';
import { fpsOf } from '../lib/profiles.mjs';

export async function runSync({ input, profile, film = null, events, probe = null, timeoutMs }) {
  const pr = probe || await probeFile(input, { timeoutMs });
  const c = makeCheck('sync.events');
  const Y = profile.sync;
  const fps = (film?.fps || fpsOf(profile)).value;
  const fd = 1000 / fps;
  c.expected = `声音晚于结果帧 0–${Y.lateFrames} 帧（≤ ${(Y.lateFrames * fd).toFixed(1)} ms）、早不超过 ${Y.earlyFrames} 帧（${(Y.earlyFrames * fd).toFixed(1)} ms）；口型类可晚 ${Y.lipLateFrames} 帧`;
  if (!pr.audio) return { checks: [notRun(c, '成片没有音轨')] };
  const sr = 48000;
  const x = await decodeMono(input, { sampleRate: sr, timeoutMs });
  const rows = [];
  for (const e of events.filter(ev => ev.needsSound)) {
    const t = e.t;
    const on = findOnset(x, sr, t, { early: Y.searchEarlySec, late: Y.searchLateSec });
    const late = (e.kind === 'lip' ? Y.lipLateFrames : Y.lateFrames) * fd, early = Y.earlyFrames * fd;
    const at = e.frame ?? +(t * fps).toFixed(2);
    if (!on) {
      rows.push({ id: e.id, frame: at, t, onset: null, deltaMs: null });
      finding(c, { key: `none@${e.id}`, target: e.id, frames: Number.isInteger(e.frame) ? [e.frame, e.frame + 1] : undefined, status: e.soft ? 'warn' : undefined,
        message: `事件 ${e.id}（第 ${at} 帧，${t.toFixed(3)} 秒）前 ${Y.searchEarlySec * 1000}–后 ${Y.searchLateSec * 1000} ms 内没有检出起音`,
        hint: '确认混音里真有这一声（声音表的 ev 引用对得上），或事件帧号与声音时刻同源（同一份事件表）' });
      continue;
    }
    const d = (on.t - t) * 1000;
    rows.push({ id: e.id, frame: at, t: +t.toFixed(5), onset: on.t, deltaMs: +d.toFixed(1), deltaFrames: +(d / fd).toFixed(2), riseDb: on.riseDb, kind: e.kind });
    if (d < -early - 1e-6) {
      finding(c, { key: `early@${e.id}`, target: e.id, frames: Number.isInteger(e.frame) ? [e.frame, e.frame + 1] : undefined, status: e.soft ? 'warn' : undefined,
        message: `事件 ${e.id}：声音比结果帧早 ${(-d).toFixed(1)} ms（${(-d / fd).toFixed(2)} 帧），超过容许的 ${early.toFixed(1)} ms`,
        hint: '声音超前最容易被察觉：把声音挪到结果帧上或稍后；拍点不落整帧时画面结果帧取 floor、声音留在网格原位（animation.md §5.7）' });
    } else if (d > late + 1e-6) {
      finding(c, { key: `late@${e.id}`, target: e.id, frames: Number.isInteger(e.frame) ? [e.frame, e.frame + 1] : undefined, status: e.soft ? 'warn' : undefined,
        message: `事件 ${e.id}：声音比结果帧晚 ${d.toFixed(1)} ms（${(d / fd).toFixed(2)} 帧），超过容许的 ${late.toFixed(1)} ms`,
        hint: '检查声音表的偏移（offsetSec、anchor）与事件帧号是否同源；刻意的「晚到」要在事件上写 sync: "soft" 并在阐述里说明' });
    }
  }
  const ok = rows.filter(r => r.deltaMs !== null);
  c.value = ok.length ? `${ok.length}/${rows.length} 个事件检出起音，偏差 ${Math.min(...ok.map(r => r.deltaMs)).toFixed(1)} … ${Math.max(...ok.map(r => r.deltaMs)).toFixed(1)} ms` : `${rows.length} 个事件都没检出起音`;
  c.evidence = { events: rows, sampleRate: sr, method: '全频带与高频强调两路 2 ms RMS 包络，取抬升 ≥ 9 dB 的局部峰，起音 = 峰前越过「底噪 + 20%」的位置' };
  return { checks: [settle(c)] };
}
