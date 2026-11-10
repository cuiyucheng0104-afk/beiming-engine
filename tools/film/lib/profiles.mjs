// 北冥仓库 · 出片编排 · 交付档位（决定 D07、附录 C7）。
// 档位的唯一定义在 engine/production/profiles.json（P05）；它合入前用下面与 D07 逐项一致的内置表，并在信封里给出警告。
//   resolveProfile(film, { override, size }) → { id, width, height, fps, lufs, lufsTol, truePeak, base, source, custom }
//     顺序：--profile > film.json 的 output.profile > v1 作品按 film.json 的 size/fps（编码与响度按 web-1080p24）
//     --size 只覆盖画幅（非 --final），记进 run.json，不改档位 id
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from './exit.mjs';
import { ROOT } from './repo.mjs';

export const BUILTIN = Object.freeze({
  'web-1080p24': { width: 1920, height: 1080, fps: 24, lufs: -14, lufsTol: 1, truePeak: -1.0, note: '网页交付：H.264 High yuv420p、BT.709 tv、AAC 48 kHz 立体声' },
  'master-1080p24': { width: 1920, height: 1080, fps: 24, lufs: -14, lufsTol: 1, truePeak: -1.0, note: '高码率母版' },
  'uhd-2160p24': { width: 3840, height: 2160, fps: 24, lufs: -14, lufsTol: 1, truePeak: -1.0, note: '原生 4K' },
  'vertical-1080x1920-30': { width: 1080, height: 1920, fps: 30, lufs: -14, lufsTol: 1, truePeak: -1.0, note: '竖屏 9:16，安全区按 9:16' },
  'broadcast-1080p25': { width: 1920, height: 1080, fps: 25, lufs: -23, lufsTol: 1, truePeak: -1.0, note: '广播 25 fps、−23 LUFS' },
  'beiming-1040p24': { width: 1920, height: 1040, fps: 24, lufs: -14, lufsTol: 1, truePeak: -1.0, note: '《北冥》样片专用档' },
});

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function fromP05(id) {
  const f = path.join(ROOT, 'engine/production/profiles.json');
  if (!fs.existsSync(f)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  const map = Array.isArray(j) ? Object.fromEntries(j.map(p => [p.id, p])) : Array.isArray(j.profiles) ? Object.fromEntries(j.profiles.map(p => [p.id, p])) : (j.profiles || j);
  const p = map?.[id];
  if (!p || typeof p !== 'object') return { known: Object.keys(map || {}) };
  const size = Array.isArray(p.size) ? p.size : [p.width ?? p.video?.width, p.height ?? p.video?.height];
  const fps = p.fps ?? p.video?.fps;
  const lufs = num(p.lufs) ?? num(p.targetLUFS) ?? num(p.audio?.targetLUFS) ?? num(p.loudness?.integrated) ?? num(p.audio?.lufs);
  const tol = num(p.lufsTol) ?? num(p.audio?.toleranceLU) ?? num(p.loudness?.tolerance);
  const tp = num(p.truePeak) ?? num(p.truePeakDbTP) ?? num(p.audio?.truePeakDbTP) ?? num(p.loudness?.truePeak);
  if (!Number.isInteger(size[0]) || !Number.isInteger(size[1]) || !Number.isInteger(fps)) return { known: Object.keys(map) };
  return { width: size[0], height: size[1], fps, lufs, lufsTol: tol, truePeak: tp, source: 'engine/production/profiles.json' };
}

export function knownProfiles() {
  const f = path.join(ROOT, 'engine/production/profiles.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ids = Array.isArray(j) ? j.map(p => p.id) : Array.isArray(j.profiles) ? j.profiles.map(p => p.id) : Object.keys(j.profiles || j);
    return [...new Set([...ids.filter(Boolean), ...Object.keys(BUILTIN)])];
  } catch { return Object.keys(BUILTIN); }
}

function lookup(id, warnings) {
  const p = fromP05(id);
  if (p && !p.known) return { id, ...BUILTIN[id], ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) };
  if (BUILTIN[id]) {
    warnings.push({ code: 'profiles-builtin', message: `交付档位 ${id} 取自编排器内置表（engine/production/profiles.json 尚未提供该档位），数值与决定 D07 一致` });
    return { id, ...BUILTIN[id], source: 'tools/film（内置，D07）' };
  }
  throw new FilmError(EXIT.USAGE, 'profile-unknown', `不认识的交付档位「${id}」`, `可用档位：${knownProfiles().join(' / ')}`);
}

export function resolveProfile(film, { override = null, size = null } = {}, warnings = []) {
  let prof;
  if (override) {
    prof = lookup(override, warnings);
    if (film.profileId && film.profileId !== override) warnings.push({ code: 'profile-override', message: `按 --profile ${override} 出片（film.json 写的是 ${film.profileId}）` });
  } else if (film.profileId) {
    prof = lookup(film.profileId, warnings);
  } else {
    // 只在通用档位里按画幅帧率对号；《北冥》专用档不拿来猜新作品
    const match = Object.entries(BUILTIN).find(([id, p]) => !id.startsWith('beiming-') && p.width === film.width && p.height === film.height && p.fps === film.fps);
    if (match) prof = lookup(match[0], warnings);
    else {
      prof = { id: 'custom', ...BUILTIN['web-1080p24'], width: film.width, height: film.height, fps: film.fps, base: 'web-1080p24', source: 'film.json（v1 size/fps）', custom: true };
      warnings.push({ code: 'profile-custom', message: `film.json 没有 output.profile，且 ${film.width}×${film.height}@${film.fps} 不是标准档位：按 film.json 出片，编码与响度按 web-1080p24；正式交付请写 output.profile 或加 --profile` });
    }
  }
  if (size) {
    warnings.push({ code: 'size-override', message: `画幅按 --size ${size[0]}x${size[1]} 覆盖（档位 ${prof.id} 是 ${prof.width}x${prof.height}）` });
    prof = { ...prof, width: size[0], height: size[1], sizeOverride: true };
  }
  return prof;
}

// 档位帧率与 film.json 不同时，帧数按时长换算；不是整数帧时给出警告（页面契约要求 DUR × fps 为整数帧）
export function framesAt(film, fps, warnings = []) {
  if (fps === film.fps) return film.frameCount;
  const exact = film.frameCount * fps / film.fps;
  const n = Math.round(exact);
  if (Math.abs(exact - n) > 1e-6) warnings.push({ code: 'fps-resample-fractional', message: `film.json 是 ${film.fps} fps × ${film.frameCount} 帧，换到 ${fps} fps 是 ${exact.toFixed(3)} 帧，取整为 ${n}` });
  else warnings.push({ code: 'fps-resample', message: `档位帧率 ${fps} fps 与 film.json 的 ${film.fps} fps 不同：按时长换算为 ${n} 帧，镜头表同比换算` });
  return n;
}
