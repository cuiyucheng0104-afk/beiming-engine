// 北冥仓库 · 交付档位读取：优先读 engine/production/profiles.json（附录 C7，作品描述包维护，校验在 engine/production/film.js）；
// 该文件还没落地或读不出可用档位时，用这里按 D07 抄下的兜底表（只含画幅、帧率与响度目标，编码细节以 profiles.json 为准）。
//   loadProfiles(root) → { source, defaultId, profiles: Map<id, {id, label, width, height, fps, targetLUFS, truePeakDbTP, reserved?}>, warnings[] }
// profiles.json 的正式写法（作品描述包）：{ default, profiles: { id: { label, video: { width, height, fps }, audio: { loudness: { integratedLUFS }, truePeakMaxDbTP } } } }；
// 也容忍几种扁平写法：{ profiles: [{id, …}] }、顶层 {id: {…}}；画幅取 width/height、size: [w, h] 或 resolution: "WxH"，帧率取 fps 或 frameRate。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROFILES_PATH = 'engine/production/profiles.json';
export const DEFAULT_PROFILE = 'web-1080p24';

/** 保留给特定影片的档位：新作品选它时提示（D07）。不管档位表从哪来都生效。 */
export const RESERVED_PROFILES = Object.freeze({
  'beiming-1040p24': '《北冥》样片专用档（D07），新作品不用',
});

/** D07 的六个档位（兜底用；与 profiles.json 不一致时以 profiles.json 为准，tests/cli/registry.test.mjs 会比对）。 */
export const FALLBACK_PROFILES = Object.freeze({
  'web-1080p24': { label: '网页 1080p24（新作品默认）', width: 1920, height: 1080, fps: 24, targetLUFS: -14, truePeakDbTP: -1.0 },
  'master-1080p24': { label: '母版 1080p24', width: 1920, height: 1080, fps: 24, targetLUFS: -14, truePeakDbTP: -1.0 },
  'uhd-2160p24': { label: '超高清 2160p24', width: 3840, height: 2160, fps: 24, targetLUFS: -14, truePeakDbTP: -1.0 },
  'vertical-1080x1920-30': { label: '竖屏 1080×1920 30 fps', width: 1080, height: 1920, fps: 30, targetLUFS: -14, truePeakDbTP: -1.0 },
  'broadcast-1080p25': { label: '广播 1080p25（EBU R128）', width: 1920, height: 1080, fps: 25, targetLUFS: -23, truePeakDbTP: -1.0 },
  'beiming-1040p24': { label: '《北冥》样片专用档 1920×1040 24 fps', width: 1920, height: 1040, fps: 24, targetLUFS: -14, truePeakDbTP: -1.2 },
});

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function normalize(id, p) {
  if (!p || typeof p !== 'object') return null;
  const v = obj(p.video);
  let w = num(v.width) ?? num(p.width), h = num(v.height) ?? num(p.height);
  if ((w === null || h === null) && Array.isArray(p.size)) [w, h] = p.size.map(num);
  if ((w === null || h === null) && typeof p.resolution === 'string') {
    const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(p.resolution);
    if (m) [w, h] = [Number(m[1]), Number(m[2])];
  }
  const fps = num(v.fps) ?? num(p.fps) ?? num(p.frameRate);
  if (!w || !h || !fps) return null;
  const a = obj(p.audio), loud = obj(a.loudness), flatLoud = obj(p.loudness);
  return {
    id,
    label: typeof p.label === 'string' ? p.label : id,
    width: w, height: h, fps,
    targetLUFS: num(loud.integratedLUFS) ?? num(p.targetLUFS) ?? num(p.integratedLUFS) ?? num(flatLoud.integrated) ?? num(flatLoud.targetLUFS) ?? null,
    truePeakDbTP: num(a.truePeakMaxDbTP) ?? num(p.truePeakDbTP) ?? num(p.truePeak) ?? num(flatLoud.truePeak) ?? null,
    ...(RESERVED_PROFILES[id] || p.reserved ? { reserved: String(RESERVED_PROFILES[id] ?? p.reserved) } : {}),
  };
}

function entries(raw) {
  const body = raw && typeof raw === 'object' && 'profiles' in raw ? raw.profiles : raw;
  if (Array.isArray(body)) return body.map(p => [p?.id, p]);
  if (body && typeof body === 'object') return Object.entries(body).filter(([k]) => !k.startsWith('$') && !['schemaVersion', 'default', 'ffprobeFields'].includes(k));
  return [];
}

export function loadProfiles(root) {
  const warnings = [];
  const file = join(root, PROFILES_PATH);
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const map = new Map();
      for (const [id, p] of entries(raw)) {
        const n = typeof id === 'string' ? normalize(id, p) : null;
        if (n) map.set(id, n); else if (typeof id === 'string') warnings.push(`${PROFILES_PATH} 的档位 ${id} 读不出画幅或帧率，已跳过`);
      }
      if (map.size) {
        const declared = typeof raw?.default === 'string' ? raw.default : null;
        if (declared && !map.has(declared)) warnings.push(`${PROFILES_PATH} 的 default 指向不存在的档位 ${declared}`);
        return { source: PROFILES_PATH, defaultId: declared && map.has(declared) ? declared : null, profiles: map, warnings };
      }
      warnings.push(`${PROFILES_PATH} 里没有可用的档位，改用 D07 兜底表`);
    } catch (e) {
      warnings.push(`${PROFILES_PATH} 读不出来（${e.message}），改用 D07 兜底表`);
    }
  }
  const map = new Map(Object.entries(FALLBACK_PROFILES).map(([id, p]) => [id, normalize(id, p)]));
  return { source: 'fallback', defaultId: DEFAULT_PROFILE, profiles: map, warnings };
}
