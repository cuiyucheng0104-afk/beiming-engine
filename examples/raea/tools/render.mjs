#!/usr/bin/env node
// Optional external runtime. Does not modify the Three.js build or install RAEA.
import { access, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const raea = process.env.RAEA_BIN;
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const expected = '0.1.0-canary.2';
if (process.argv.includes('--help')) {
  console.log('node examples/raea/tools/render.mjs [--check-only]\nEnvironment: RAEA_BIN, FFMPEG, FFPROBE, WGPU_BACKEND, COMFY_URL. Requires RAEA v0.1.0-canary.2 and prepared media.');
  process.exit(0);
}
function run(bin, args, env = process.env) {
  const p = spawnSync(bin, args, { cwd: project, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (p.error) throw p.error;
  return p;
}
function requireSuccess(p, label) {
  if (p.status !== 0) throw new Error(`${label} failed (${p.status}): ${p.stderr}\n${p.stdout}`);
  return p;
}
// Canary.2 has no --version CLI; its release layout carries share/raea/VERSION.
if (!raea) throw new Error('Set RAEA_BIN to the full path of the separately installed RAEA executable.');
const executable = await realpath(raea);
const packageVersion = (await readFile(resolve(dirname(executable), '../share/raea/VERSION'), 'utf8')).trim();
const versionText = `RAEA ${packageVersion} (package VERSION)`;
if (packageVersion !== expected) {
  throw new Error(`Expected RAEA ${expected}; found ${packageVersion}. Revalidate before upgrading.`);
}
requireSuccess(run(ffmpeg, ['-version']), 'FFmpeg');
requireSuccess(run(ffprobe, ['-version']), 'ffprobe');
for (const name of ['kun.glb', 'ferry.glb', 'sky_dawn.png', 'clouds_back.png', 'skyline_pudong.png', 'clouds_front_a.png', 'clouds_front_b.png', 'river.png', 'mix.wav']) {
  await access(resolve(project, 'media', name));
}
if (process.argv.includes('--check-only')) {
  console.log(`${versionText}\nRuntime, tools and required assets found. No GPU render started.`);
  process.exit(0);
}
// Respect another session's ComfyUI work. Network failure is different from a busy queue.
let queue;
try {
  const response = await fetch(`${process.env.COMFY_URL || 'http://127.0.0.1:8188'}/queue`, { signal: AbortSignal.timeout(2500) });
  if (response.ok) queue = await response.json();
} catch { /* ComfyUI is optional; never stop a process. */ }
if (queue?.queue_running?.length || queue?.queue_pending?.length) throw new Error('ComfyUI is busy; retry after its queue finishes.');
const gpu = runOptionalGpu();
if (gpu.busy) throw new Error('GPU utilization exceeds 10%; retry when the shared workstation is idle.');
await mkdir(resolve(project, 'out'), { recursive: true });
await mkdir(resolve(project, 'delivery'), { recursive: true });
const env = { ...process.env };
if (process.platform === 'win32' && !env.WGPU_BACKEND) env.WGPU_BACKEND = 'vulkan';
console.log(`Rendering with ${versionText}; backend ${env.WGPU_BACKEND || 'runtime default'}`);
const native = run(raea, ['render', 'film.tsx', '-o', 'out/native-10s.mp4', '--quality', 'master', '--manifest', 'out/render.json'], env);
await writeFile(resolve(project, 'out/render.stdout.log'), native.stdout || '');
await writeFile(resolve(project, 'out/render.stderr.log'), native.stderr || '');
requireSuccess(native, 'Native render (see out/render.stderr.log)');
const target = 'delivery/beiming-raea-10s.mp4';
requireSuccess(run(ffmpeg, ['-hide_banner', '-y', '-i', 'out/native-10s.mp4', '-i', 'media/mix.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-t', '10', '-movflags', '+faststart', target]), 'Mux');
const probe = JSON.parse(requireSuccess(run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration,size', '-of', 'json', target]), 'Output inspection').stdout);
const video = probe.streams.find(s => s.codec_type === 'video');
const audio = probe.streams.find(s => s.codec_type === 'audio');
if (video?.width !== 1920 || video?.height !== 1040 || video?.r_frame_rate !== '24/1' || Number(video?.nb_read_frames) !== 240 || audio?.codec_name !== 'aac' || Math.abs(Number(probe.format.duration) - 10) > 0.05) throw new Error('Output does not match the 240-frame / 10-second / AAC contract.');
const sha256 = createHash('sha256').update(await readFile(resolve(project, target))).digest('hex');
await writeFile(resolve(project, 'delivery/technical.json'), JSON.stringify({ runtime: versionText, backend: env.WGPU_BACKEND || 'runtime default', gpuBefore: gpu, probe, sha256, note: 'Technical output check only; inspect imagery, actions, black/frozen frames and loudness separately.' }, null, 2) + '\n');
console.log(`Rendered ${target}: 1920x1040, 24fps, 240 frames, AAC. Visual review remains separate.`);

function runOptionalGpu() {
  const p = spawnSync('nvidia-smi', ['--query-gpu=name,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
  if (p.error || p.status !== 0) return { available: false, busy: false };
  const lines = p.stdout.trim().split('\n');
  return { available: true, samples: lines, busy: lines.some(line => Number(line.split(',').at(-1).trim()) > 10) };
}
