// One-shot assembly job. The render worker never starts a solver.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { findBlender } from './host.mjs';

const run = promisify(execFile);
const driver = fileURLToPath(new URL('./bake.py', import.meta.url));
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function blenderCommand(explicit) {
  const configured = explicit ?? process.env.BLENDER_BIN ?? process.env.BEIMING_BLENDER;
  if (configured) return configured;
  return findBlender() ?? (process.platform === 'win32' && (process.env.PATH ?? '').split(delimiter)
    .filter(Boolean).map((dir) => join(dir, 'blender.exe')).find(existsSync));
}

/** Read a serialized asm-baked/0.1 job without invoking either engine. */
export async function loadBakedAssembly(path) {
  const job = JSON.parse(await readFile(path, 'utf8'));
  if (job?.format !== 'asm-baked/0.1' || !record(job.parts) || !Array.isArray(job.steps) ||
      typeof job.recipeSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(job.recipeSha256)) throw new Error('Invalid asm-baked/0.1 document');
  for (const [name, part] of Object.entries(job.parts)) {
    const m = part?.matrix4x4;
    if (!Array.isArray(m) || m.length !== 4 || !m.every((row) => Array.isArray(row) && row.length === 4 && row.every(Number.isFinite)) ||
        typeof part.touched !== 'boolean' || !(part.parent === null || (typeof part.parent === 'string' && Object.hasOwn(job.parts, part.parent)))) {
      throw new Error(`Invalid baked part: ${name}`);
    }
  }
  return job;
}

/** Bake world-space Y-up proxy meshes. With outPath, publish exactly the solver's UTF-8 bytes. */
export async function bakeAssembly({ recipe, meshes, outPath, engine = 'auto', blenderBin, pythonBin }) {
  if (!['auto', 'blender', 'python'].includes(engine)) throw new TypeError(`Unknown assembly engine: ${engine}`);
  if (!record(recipe)) throw new TypeError('recipe must be an object');
  const blender = engine !== 'python' && blenderCommand(blenderBin);
  if (engine === 'blender' && !blender) throw new Error('Blender not found; set blenderBin or BEIMING_BLENDER');
  const dest = outPath === undefined ? null : resolve(outPath);
  const parent = dest ? dirname(dest) : tmpdir();
  if (dest) await mkdir(parent, { recursive: true });
  // A private sibling directory keeps simultaneous jobs isolated and rename on the same volume.
  const work = await mkdtemp(join(parent, '.asm-bake-'));
  try {
    const input = join(work, 'input.json'), output = join(work, 'asm.baked.json');
    await writeFile(input, JSON.stringify({ recipe, ...(meshes === undefined ? {} : { meshes }) }));
    const bin = blender || (pythonBin ?? process.env.BEIMING_PYTHON ?? process.env.BEIMING_PY ?? process.env.PYTHON ??
      (process.platform === 'win32' ? 'python' : 'python3'));
    const args = blender ? ['-b', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '-P', driver, '--'] : ['-B', driver];
    try {
      await run(bin, [...args, input, output], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
    } catch (error) {
      // Some Blender builds report Python failures on stdout even with --python-exit-code.
      throw new Error(`Assembly bake failed: ${[error.stderr, error.stdout].filter(Boolean).join('\n').trim() || error.message}`, { cause: error });
    }
    const baked = await loadBakedAssembly(output);
    if (dest) await rename(output, dest);
    return baked;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
