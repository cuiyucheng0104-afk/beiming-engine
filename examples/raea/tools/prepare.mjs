#!/usr/bin/env node
// Prepare only our assets and code; RAEA is installed separately by the operator.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const repo = resolve(here, '../../..');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const assets = ['sky_dawn.png', 'clouds_back.png', 'skyline_pudong.png', 'clouds_front_a.png', 'clouds_front_b.png', 'river.png'];

if (process.argv.includes('--help')) {
  console.log('node examples/raea/tools/prepare.mjs\nEnvironment: PYTHON, FFMPEG, BEIMING_CHROME. Requires npm run setup and Python requirements.');
  process.exit(0);
}
function run(bin, args, quiet = false) {
  const p = spawnSync(bin, args, { cwd: project, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (p.error) throw p.error;
  if (p.status !== 0) throw new Error(`${bin} failed (${p.status}): ${p.stderr}\n${p.stdout}`);
  if (!quiet && p.stdout) process.stdout.write(p.stdout);
  return p;
}
run(python, ['-c', 'import numpy, scipy, soundfile']);
run(ffmpeg, ['-version'], true);
await mkdir(resolve(project, 'media'), { recursive: true });
for (const name of assets) await copyFile(resolve(repo, 'assets/plates', name), resolve(project, 'media', name));
await copyFile(resolve(repo, 'fonts/LICENSE.md'), resolve(project, 'media/FONT-LICENSE.md'));
run(process.execPath, [resolve(here, 'export-kun.mjs'), '--no-preview']);
run(python, [resolve(here, 'sound.py')]);
const first = run(ffmpeg, ['-hide_banner', '-i', 'media/sound.wav', '-af', 'loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json', '-f', 'null', '-'], true);
const block = first.stderr.match(/\{\s*"input_i"[\s\S]*?\}/);
if (!block) throw new Error('FFmpeg did not return loudnorm measurements.');
const m = JSON.parse(block[0]);
for (const key of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
  if (!Number.isFinite(Number(m[key]))) throw new Error(`Invalid loudnorm ${key}`);
}
const norm = `loudnorm=I=-14:TP=-1.2:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
run(ffmpeg, ['-hide_banner', '-y', '-i', 'media/sound.wav', '-af', norm, '-ar', '48000', '-c:a', 'pcm_s24le', 'media/mix.wav'], true);
const hashes = {};
for (const name of [...assets, 'kun.glb', 'ferry.glb', 'mix.wav']) {
  hashes[name] = createHash('sha256').update(await readFile(resolve(project, 'media', name))).digest('hex');
}
await writeFile(resolve(project, 'media/prepared.json'), JSON.stringify({ assets: hashes, loudnorm: m }, null, 2) + '\n');
console.log('Prepared examples/raea/media; models were exported and round-trip validated.');
