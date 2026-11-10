// tests/qa 公共件：现场用 ffmpeg lavfi 生成夹具（临时目录，测完删掉），以子进程跑 tools/qa/cli.mjs 并解析 --json 信封。
// 夹具都不进仓库；只有文字夹具页面（fixtures/texts-page）与测试档位表（fixtures/profiles.json）是文件。
//
//   ROOT / CLI / FIXTURES             仓库根、QA 命令、夹具目录
//   tmp()                             新建临时目录，进程退出前删掉（after 钩子里调用 cleanup()）
//   ffmpeg(args)                      跑 ffmpeg（-v error -y 已加），失败直接抛错
//   clip(file, opts)                  生成一段测试成片，默认 1920×1080、24 fps、4 秒、BT.709 有限范围完整标注、AAC 48 kHz 立体声、约 −14 LUFS
//   qa(args)                          跑 node tools/qa/cli.mjs <args> --json → { code, env, stdout, stderr }
//   check(env, id)                    取报告里某项检查
//   haveFfmpeg / haveBrowser()        环境探测（没有就跳过对应测试，并在跳过原因里写清楚）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLI = path.join(ROOT, 'tools/qa/cli.mjs');
export const FIXTURES = path.join(ROOT, 'tests/qa/fixtures');
export const TEST_PROFILES = path.join(FIXTURES, 'profiles.json');
const FF = process.env.FFMPEG || 'ffmpeg';

const dirs = [];
export function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bmqa-test-'));
  dirs.push(d);
  return d;
}
export function cleanup() {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
}
process.once('exit', cleanup);

export const haveFfmpeg = (() => {
  const r = spawnSync(FF, ['-hide_banner', '-version'], { encoding: 'utf8' });
  return r.status === 0 && /version\s+n?([7-9]|\d{2,})\./.test(r.stdout.split('\n')[0]);
})();

export function ffmpeg(args) {
  const r = spawnSync(FF, ['-v', 'error', '-y', '-nostdin', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg 失败：${r.stderr}\n参数：${args.join(' ')}`);
  return r;
}

const TAG709 = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';
const ENC709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

// opts：size、rate、dur、src（lavfi 视频源，可用 {S} {R} {D} 占位）、vf（加在源后面的滤镜）、audio（'tone' | 'none' | lavfi 音频源）、
//       gainDb（正弦音量，7.8 dB ≈ −14 LUFS）、pixFmt、encColor（false 就不写色彩参数）、extra（额外输出参数）
export function clip(file, o = {}) {
  const size = o.size || '1920x1080', rate = o.rate || 24, dur = o.dur || 4;
  const src = (o.src || 'testsrc2=s={S}:r={R}:d={D}').replace('{S}', size).replace('{R}', rate).replace('{D}', dur);
  const pix = o.pixFmt || 'yuv420p';
  const vchain = [o.vf, `format=${pix}`, o.encColor === false ? null : TAG709].filter(Boolean).join(',');
  const args = ['-f', 'lavfi', '-i', src];
  const audio = o.audio ?? 'tone';
  if (audio !== 'none') args.push('-f', 'lavfi', '-i', audio === 'tone' ? `sine=frequency=440:sample_rate=48000:duration=${dur}` : audio);
  const fc = [`[0:v]${vchain}[v]`];
  if (audio !== 'none') fc.push(`[1:a]volume=${o.gainDb ?? 7.8}dB,aformat=sample_rates=48000:channel_layouts=stereo[a]`);
  args.push('-filter_complex', fc.join(';'), '-map', '[v]');
  if (audio !== 'none') args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-pix_fmt', pix);
  if (o.encColor !== false) args.push(...ENC709);
  args.push('-frames:v', String(Math.round(dur * rate)), '-movflags', '+faststart', ...(o.extra || []), file);
  ffmpeg(args);
  return file;
}

export function qa(args, { cwd = ROOT, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  return { code: r.status, env: parsed, stdout: r.stdout, stderr: r.stderr };
}

export const check = (env, id) => env?.result?.checks?.find(c => c.id === id) || null;

export function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 1));
  return file;
}

let browser = null;
export function haveBrowser() {
  if (browser !== null) return browser;
  const r = spawnSync(process.execPath, ['-e', "import('playwright-core').then(async ({chromium}) => { const b = await chromium.launch(); await b.close(); }).then(() => process.exit(0), () => process.exit(3))"], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  browser = r.status === 0;
  return browser;
}
