// 北冥仓库 · 交付档位读取：优先读 engine/production/profiles.json（附录 C7，由作品描述包维护）；
// 该文件还没落地或读不出可用档位时，用这里按 D07 抄下的兜底表（只含画幅、帧率与响度目标，编码细节以 profiles.json 为准）。
//   loadProfiles(root) → { source, profiles: Map<id, {id, width, height, fps, targetLUFS, truePeakDbTP, reserved?}>, warnings[] }
// 读 profiles.json 时容忍几种写法：{ profiles: {id: {...}} }、{ profiles: [{id, ...}] }、顶层 {id: {...}} 或数组；
// 画幅取 width/height、size: [w, h] 或 resolution: "WxH"；帧率取 fps 或 frameRate；响度取 targetLUFS / integratedLUFS / loudness.integrated。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROFILES_PATH = 'engine/production/profiles.json';
export const DEFAULT_PROFILE = 'web-1080p24';

/** D07 的六个档位（兜底用；与 profiles.json 不一致时以 profiles.json 为准，tests/cli 会比对）。 */
export const FALLBACK_PROFILES = Object.freeze({
  'web-1080p24': { width: 1920, height: 1080, fps: 24, targetLUFS: -14, truePeakDbTP: -1.0 },
  'master-1080p24': { width: 1920, height: 1080, fps: 24, targetLUFS: -14, truePeakDbTP: -1.0 },
  'uhd-2160p24': { width: 3840, height: 2160, fps: 24, targetLUFS: -14, truePeakDbTP: -1.0 },
  'vertical-1080x1920-30': { width: 1080, height: 1920, fps: 30, targetLUFS: -14, truePeakDbTP: -1.0 },
  'broadcast-1080p25': { width: 1920, height: 1080, fps: 25, targetLUFS: -23, truePeakDbTP: -1.0 },
  'beiming-1040p24': { width: 1920, height: 1040, fps: 24, targetLUFS: -14, truePeakDbTP: -1.0, reserved: '《北冥》样片专用档（D07），新作品不用' },
});

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalize(id, p) {
  if (!p || typeof p !== 'object') return null;
  let w = num(p.width), h = num(p.height);
  if ((w === null || h === null) && Array.isArray(p.size)) [w, h] = p.size.map(num);
  if ((w === null || h === null) && typeof p.resolution === 'string') {
    const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(p.resolution);
    if (m) [w, h] = [Number(m[1]), Number(m[2])];
  }
  const fps = num(p.fps) ?? num(p.frameRate);
  if (!w || !h || !fps) return null;
  const loud = p.loudness && typeof p.loudness === 'object' ? p.loudness : {};
  return {
    id, width: w, height: h, fps,
    targetLUFS: num(p.targetLUFS) ?? num(p.integratedLUFS) ?? num(loud.integrated) ?? num(loud.targetLUFS) ?? null,
    truePeakDbTP: num(p.truePeakDbTP) ?? num(p.truePeak) ?? num(loud.truePeak) ?? num(loud.truePeakDbTP) ?? null,
    ...(p.reserved ? { reserved: String(p.reserved) } : {}),
  };
}

function entries(raw) {
  const body = raw && typeof raw === 'object' && 'profiles' in raw ? raw.profiles : raw;
  if (Array.isArray(body)) return body.map(p => [p?.id, p]);
  if (body && typeof body === 'object') return Object.entries(body).filter(([k]) => !k.startsWith('$') && k !== 'schemaVersion');
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
      if (map.size) return { source: PROFILES_PATH, profiles: map, warnings };
      warnings.push(`${PROFILES_PATH} 里没有可用的档位，改用 D07 兜底表`);
    } catch (e) {
      warnings.push(`${PROFILES_PATH} 读不出来（${e.message}），改用 D07 兜底表`);
    }
  }
  const map = new Map(Object.entries(FALLBACK_PROFILES).map(([id, p]) => [id, { id, ...p }]));
  return { source: 'fallback', profiles: map, warnings };
}
