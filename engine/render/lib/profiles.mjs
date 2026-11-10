// 北冥引擎 · 交付档位（决定 D07、加固计划附录 C7）：渲染器只读档位里的画幅、帧率与响度目标。
// 档位表的唯一来源是 engine/production/profiles.json（作品描述包维护）；文件还不存在时用下面的内置表，内容照 D07 抄写，
// 两边不一致以 profiles.json 为准。读取时对字段名宽松（width / video.width / size[0]；audio.targetLUFS / integratedLUFS …），
// 只要能读出宽、高、帧率就算一个有效档位。
//   loadProfiles(root)       → { source, profiles: Map<id, Profile> }
//   resolveProfile(id, root) → Profile：{ id, width, height, fps, audio: { targetLUFS, toleranceLU, truePeakDbTP, sampleRate, channels },
//                               video: { crf?, preset? }, source }；不认识的 id → UsageError（列出可用档位）
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './cli.mjs';

const audio = (targetLUFS = -14, toleranceLU = 1, truePeakDbTP = -1.0) => ({ targetLUFS, toleranceLU, truePeakDbTP, sampleRate: 48000, channels: 2 });
/** 内置表（D07）：profiles.json 缺席时才用 */
export const BUILTIN_PROFILES = Object.freeze({
  'web-1080p24': { width: 1920, height: 1080, fps: 24, audio: audio(), note: 'H.264 High yuv420p，BT.709 tv，AAC 48 kHz 立体声' },
  'master-1080p24': { width: 1920, height: 1080, fps: 24, audio: audio(), video: { crf: 10, preset: 'slow' }, note: '高码率母版（另可出无损中间件）' },
  'uhd-2160p24': { width: 3840, height: 2160, fps: 24, audio: audio() },
  'vertical-1080x1920-30': { width: 1080, height: 1920, fps: 30, audio: audio(), note: '竖屏 9:16，安全区按 9:16' },
  'broadcast-1080p25': { width: 1920, height: 1080, fps: 25, audio: audio(-23, 1, -1.0) },
  'beiming-1040p24': { width: 1920, height: 1040, fps: 24, audio: audio(), note: '《北冥》样片专用档' },
});

const num = (...vs) => vs.map(Number).find(v => Number.isFinite(v));
function normalize(id, p, source) {
  if (!p || typeof p !== 'object') return null;
  const res = typeof p.resolution === 'string' ? /^(\d+)x(\d+)$/.exec(p.resolution) : null;
  const width = num(p.width, p.video?.width, p.size?.[0], res?.[1]);
  const height = num(p.height, p.video?.height, p.size?.[1], res?.[2]);
  const fps = num(p.fps, p.video?.fps, p.frameRate, p.video?.frameRate);
  if (!(width > 0 && height > 0 && fps > 0)) return null;
  const a = p.audio ?? p.loudness ?? {};
  return {
    id, width, height, fps,
    audio: {
      targetLUFS: num(a.targetLUFS, a.integratedLUFS, a.lufs, a.target, p.targetLUFS) ?? -14,
      toleranceLU: num(a.toleranceLU, a.lufsTolerance, a.tolLU, a.tolerance) ?? 1,
      truePeakDbTP: num(a.truePeakDbTP, a.maxTruePeakDbTP, a.truePeak, a.tp) ?? -1.0,
      sampleRate: num(a.sampleRate, a.sr) ?? 48000, channels: num(a.channels) ?? 2,
    },
    video: { crf: num(p.video?.crf, p.crf), preset: p.video?.preset ?? p.preset },
    source,
  };
}

export function loadProfiles(root) {
  const file = path.join(root, 'engine', 'production', 'profiles.json');
  const out = new Map();
  let source = 'builtin（engine/render/lib/profiles.mjs，照抄 D07）';
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); source = 'engine/production/profiles.json'; } catch (e) { if (e.code !== 'ENOENT') throw new UsageError(`engine/production/profiles.json 不是合法 JSON：${e.message}`); }
  const entries = raw === null ? Object.entries(BUILTIN_PROFILES)
    : Array.isArray(raw.profiles) ? raw.profiles.map(p => [p.id, p])
      : raw.profiles && typeof raw.profiles === 'object' ? Object.entries(raw.profiles)
        : Object.entries(raw).filter(([k]) => !k.startsWith('$') && k !== 'schemaVersion');
  for (const [id, p] of entries) { const n = id && normalize(String(id), p, source); if (n) out.set(n.id, n); }
  return { source, profiles: out };
}

export function resolveProfile(id, root) {
  const { profiles, source } = loadProfiles(root);
  const p = profiles.get(id);
  if (!p) throw new UsageError(`不认识的交付档位 ${id}`, `可用：${[...profiles.keys()].join(' / ')}（来源：${source}）`);
  return p;
}
