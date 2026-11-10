// 北冥引擎 · 交付档位（决定 D07、加固计划附录 C7）：渲染器只读档位里的画幅、帧率、响度目标与编码提示。
// 档位表的唯一来源是 engine/production/profiles.json（作品描述包维护）；读取与兜底统一走仓库的 tools/lib/profiles.mjs
// （它在 profiles.json 缺席时用 D07 的兜底表），这里不再另抄一份表，只补渲染器要用、而那边不读的三项：
//   响度容差 toleranceLU（audio.loudness.toleranceLU / lufsTolerance，缺省 1，D07）、真峰值缺省 −1.0 dBTP，
//   编码提示 video.crf / video.preset（profiles.json 写了就用；没写时 master-* 档位用 crf 10 / slow 的高码率母版，其余 crf 14 / medium）。
//   loadProfiles(root)       → { source, profiles: Map<id, Profile>, warnings[] }
//   resolveProfile(id, root) → Profile：{ id, label, width, height, fps, audio: { targetLUFS, toleranceLU, truePeakDbTP, sampleRate, channels },
//                               video: { crf, preset }, source }；不认识的 id → usage.profile-unknown（列出可用档位）
import fs from 'node:fs';
import path from 'node:path';
import { loadProfiles as loadRepoProfiles, PROFILES_PATH } from '../../../tools/lib/profiles.mjs';
import { RenderError } from './errors.mjs';

const num = (...vs) => vs.find(v => typeof v === 'number' && Number.isFinite(v)) ?? null;
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** profiles.json 里某个档位的原始条目（读不出就是 {}） */
function rawEntries(root) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(root, PROFILES_PATH), 'utf8')); } catch { return new Map(); }
  const body = raw && typeof raw === 'object' && 'profiles' in raw ? raw.profiles : raw;
  if (Array.isArray(body)) return new Map(body.filter(p => typeof p?.id === 'string').map(p => [p.id, p]));
  if (body && typeof body === 'object') return new Map(Object.entries(body).filter(([k]) => !k.startsWith('$')));
  return new Map();
}

export function loadProfiles(root) {
  const { source, profiles, warnings } = loadRepoProfiles(root);
  const raw = rawEntries(root);
  const out = new Map();
  for (const [id, p] of profiles) {
    const r = obj(raw.get(id)), a = obj(r.audio), loud = obj(a.loudness), v = obj(r.video), x264 = obj(v.x264);
    const master = /^master-/.test(id);
    out.set(id, {
      id, label: p.label ?? id, width: p.width, height: p.height, fps: p.fps,
      audio: {
        targetLUFS: p.targetLUFS ?? -14,
        toleranceLU: num(loud.toleranceLU, loud.toleranceLu, a.lufsTolerance, a.toleranceLU) ?? 1,
        truePeakDbTP: p.truePeakDbTP ?? -1.0,
        sampleRate: num(a.sampleRate) ?? 48000, channels: num(a.channels) ?? 2,
      },
      video: {
        crf: num(v.crf, x264.crf) ?? (master ? 10 : 14),
        preset: (typeof v.preset === 'string' && v.preset) || (typeof x264.preset === 'string' && x264.preset) || (master ? 'slow' : 'medium'),
      },
      source: source === 'fallback' ? 'tools/lib/profiles.mjs（D07 兜底表）' : source,
    });
  }
  return { source, profiles: out, warnings };
}

export function resolveProfile(id, root) {
  const { profiles, source } = loadProfiles(root);
  const p = profiles.get(id);
  if (!p) throw new RenderError('usage.profile-unknown', `不认识的交付档位 ${id}`, { hint: `可用：${[...profiles.keys()].join(' / ')}（来源：${source === 'fallback' ? 'D07 兜底表' : source}）` });
  return p;
}
