// 北冥 QA · sync：声画同步。对每个要求有声的事件（film.json 的 events[].audio / sfx: true，或 C 路线 events.json 里带 cue 的打点），
// 在最终文件解码出的音轨里找起音，量「起音 − 事件结果帧时刻」。容差按 routes/directing/craft/animation.md §5.7 的同步容差表（不对称）：
//   一般事件：声音晚于结果帧 0 – lateFrames 帧可以接受；早于结果帧不超过 earlyFrames 帧（24 fps 约 10 ms）
//   口型类（sync: "lip" 或 visual: "lip"）：允许晚到 lipLateFrames 帧（口型先到）
//   sync: "soft" 的事件只给软项，sync: "none" 的不查；没检出起音记「注意」（要人带声复核），一个都没检出才判硬失败
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
  const list = events.filter(ev => ev.needsSound).sort((p, q) => p.t - q.t);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const t = e.t;
    // 相邻事件挨得近时，各自只在到邻居的中点为止的范围里找（免得把前一下的起音认成这一下的）
    const early = Math.min(Y.searchEarlySec, i > 0 ? (t - list[i - 1].t) / 2 : Infinity);
    const late = Math.min(Y.searchLateSec, i + 1 < list.length ? (list[i + 1].t - t) / 2 : Infinity);
    const on = findOnset(x, sr, t, { early: Math.max(early, 0.5 / fps), late: Math.max(late, 1.5 / fps), minRiseDb: Y.minRiseDb ?? 8 });
    const lateTol = (e.kind === 'lip' ? Y.lipLateFrames : Y.lateFrames) * fd, earlyTol = Y.earlyFrames * fd;
    const at = e.frame ?? +(t * fps).toFixed(2);
    const fr = Number.isInteger(e.frame) ? [e.frame, e.frame + 1] : undefined;
    if (!on) {
      rows.push({ id: e.id, frame: at, t, onset: null, deltaMs: null });
      finding(c, { key: `none@${e.id}`, target: e.id, frames: fr, status: 'warn',
        message: `事件 ${e.id}（第 ${at} 帧，${t.toFixed(3)} 秒）前 ${Math.round(early * 1000)}–后 ${Math.round(late * 1000)} ms 内没有检出起音（可能被混音盖住，或这一声没进混音）`,
        hint: '带声看这一处：真没有声音就查声音表的引用；声音太轻听不出就调混音；声音是缓起的（弦乐、铺底）就在事件上写 sync: "soft"' });
      continue;
    }
    const d = (on.t - t) * 1000;
    rows.push({ id: e.id, frame: at, t: +t.toFixed(5), onset: on.t, deltaMs: +d.toFixed(1), deltaFrames: +(d / fd).toFixed(2), riseDb: on.riseDb, band: on.band, kind: e.kind });
    if (d < -earlyTol - 1e-6) {
      finding(c, { key: `early@${e.id}`, target: e.id, frames: fr, status: e.soft ? 'warn' : undefined,
        message: `事件 ${e.id}：声音比结果帧早 ${(-d).toFixed(1)} ms（${(-d / fd).toFixed(2)} 帧），超过容许的 ${earlyTol.toFixed(1)} ms`,
        hint: '声音超前最容易被察觉：把声音挪到结果帧上或稍后；拍点不落整帧时画面结果帧取 floor、声音留在网格原位（animation.md §5.7）' });
    } else if (d > lateTol + 1e-6) {
      finding(c, { key: `late@${e.id}`, target: e.id, frames: fr, status: e.soft ? 'warn' : undefined,
        message: `事件 ${e.id}：声音比结果帧晚 ${d.toFixed(1)} ms（${(d / fd).toFixed(2)} 帧），超过容许的 ${lateTol.toFixed(1)} ms`,
        hint: '检查声音表的偏移（offsetSec、anchor）与事件帧号是否同源；刻意的「晚到」要在事件上写 sync: "soft" 并在阐述里说明' });
    }
  }
  // 一个起音都没检出：多半是整条声音错位、混音没进成片或事件表不是这部片的，判硬失败
  const hard = list.filter(e => !e.soft);
  if (hard.length && rows.filter(r => r.deltaMs !== null && hard.some(e => e.id === r.id)).length === 0) {
    finding(c, { key: 'none-at-all', message: `${hard.length} 个要求有声的事件一个起音都没检出`, hint: '确认成片封装的是这部片的混音、事件表帧号与这部片同源；再带声看一遍' });
  }
  const ok = rows.filter(r => r.deltaMs !== null);
  c.value = ok.length ? `${ok.length}/${rows.length} 个事件检出起音，偏差 ${Math.min(...ok.map(r => r.deltaMs)).toFixed(1)} … ${Math.max(...ok.map(r => r.deltaMs)).toFixed(1)} ms` : `${rows.length} 个事件都没检出起音`;
  c.evidence = { events: rows, sampleRate: sr, method: '全频带与高频强调两路 2 ms RMS 包络，取抬升 ≥ 9 dB 的局部峰，起音 = 峰前越过「底噪 + 20%」的位置' };
  return { checks: [settle(c)] };
}
