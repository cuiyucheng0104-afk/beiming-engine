// 北冥仓库 · FFmpeg 能力探测：版本（按发行号，git 构建按 libavcodec 主版本换算）与编码器、滤镜、封装格式。
//
// 接口：
//   parseVersion(text)        → {version, major, libavcodecMajor, configuration, git}；text 是 `ffmpeg -version` 的输出
//   parseList(text)           → Set<名字>；`ffmpeg -encoders/-decoders/-filters/-muxers/-demuxers` 的输出
//   probeFfmpeg(bin, {full})  → Promise<{ok, path, version, major, libavcodecMajor, lists:{encoders,...}, error}>
//       full=false 只跑 -version（preflight 用，几十毫秒）；full=true 再列出五类组件（doctor 用）
//   missingComponents(probe, spec)  → {required: [...], recommended: [...]}，元素形如 'filters:loudnorm'
//   ffmpegBins(env)           → {ffmpeg, ffprobe}：尊重 FFMPEG / FFPROBE（完整路径），否则用 PATH 里的名字。
//       给要调用 ffmpeg 的 Node 入口共用（engine/render、tools/film、tools/qa…），全仓库对这两个变量的口径一致
import { run, which } from './proc.mjs';

export function ffmpegBins(env = process.env) {
  const pick = (name, fallback) => ((env[name] || '').trim() || fallback);
  return { ffmpeg: pick('FFMPEG', 'ffmpeg'), ffprobe: pick('FFPROBE', 'ffprobe') };
}

// libavcodec 主版本 → FFmpeg 主版本（用于 N-xxxxx-g… 这类 git 构建，版本号里看不出发行号）
const LAVC_TO_FFMPEG = { 58: 4, 59: 5, 60: 6, 61: 7, 62: 8, 63: 9 };

export function parseVersion(text) {
  const first = (text || '').split('\n')[0] || '';
  const m = /version\s+(\S+)/.exec(first);
  const raw = m ? m[1] : null;
  const rel = raw && /^n?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw);
  const lavc = /libavcodec\s+(\d+)\.\s*(\d+)\.\s*(\d+)/.exec(text || '');
  const libavcodecMajor = lavc ? +lavc[1] : null;
  const git = !!raw && (/^N-/.test(raw) || /^\d{4}-\d{2}-\d{2}-git/.test(raw) || /git/.test(raw) && !rel);
  let major = rel && !/^\d{4}-/.test(raw) ? +rel[1] : null;
  if (major !== null && major > 100) major = null;            // 日期型版本号（2025-01-01-git-…）
  if (major === null && libavcodecMajor !== null) major = LAVC_TO_FFMPEG[libavcodecMajor] ?? (libavcodecMajor >= 61 ? libavcodecMajor - 54 : null);
  const configuration = (/configuration:\s*(.*)/.exec(text || '') || [])[1] || '';
  return { version: raw, major, libavcodecMajor, configuration, git };
}

export function parseList(text) {
  const names = new Set();
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.includes(' = ') || /^-+$/.test(line) || /:$/.test(line)) continue;
    const tok = line.split(/\s+/);
    if (tok.length < 2 || !/^[A-Z.|]+$/.test(tok[0])) continue;
    for (const n of tok[1].split(',')) names.add(n);
  }
  return names;
}

export async function probeFfmpeg(bin = 'ffmpeg', { full = false, env = process.env, timeout = 15_000 } = {}) {
  const path = (bin.includes('/') || bin.includes('\\')) ? bin : which(bin, { env });
  if (!path) return { ok: false, error: `PATH 里没有 ${bin}` };
  const v = await run(path, ['-hide_banner', '-version'], { env, timeout });
  if (v.error || v.code !== 0) return { ok: false, path, error: v.error ? `无法启动（${v.error.code || v.error.message}）` : `-version 退出码 ${v.code}` };
  const info = parseVersion(v.stdout);
  const out = { ok: true, path, ...info, lists: {} };
  if (full) {
    const kinds = ['encoders', 'decoders', 'filters', 'muxers', 'demuxers'];
    const res = await Promise.all(kinds.map(k => run(path, ['-hide_banner', `-${k}`], { env, timeout })));
    kinds.forEach((k, i) => { out.lists[k] = parseList(res[i].stdout); });
  }
  return out;
}

export function missingComponents(probe, spec) {
  const miss = { required: [], recommended: [] };
  for (const level of ['required', 'recommended']) {
    for (const [kind, names] of Object.entries(spec[level] || {})) {
      const have = probe.lists[kind];
      if (!have) continue;
      for (const n of names) if (!have.has(n)) miss[level].push(`${kind}:${n}`);
    }
  }
  return miss;
}
