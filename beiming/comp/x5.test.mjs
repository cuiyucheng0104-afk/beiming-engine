import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { eventsTable } from '../kernel/eval/input.mjs';
import { masterAudio, measureLoudness, mixEvents, VOICES } from './audio.mjs';
import { deliver, PIECES } from './deliver.mjs';
import { CompError, runTool, tools } from './stitch.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comp-sink-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'out.bin') };
}

const failed = (e) => e instanceof CompError && e.code === 'failure.ffmpeg';

// 子进程先产生半截文件，再等父进程放行，让 drain、abort 和提前退出的顺序可复现。
async function stalledEncoder(t, action) {
  const { openEncoderSink } = await import('./sink.mjs');
  const { dir, path } = fixture(t);
  const ready = join(dir, 'ready'), go = join(dir, 'go');
  const script = `const fs = require('node:fs');
    const [ready, go, tmp] = process.argv.slice(1);
    fs.writeFileSync(tmp, 'partial');
    fs.writeFileSync(ready + '.tmp', String(process.pid)); fs.renameSync(ready + '.tmp', ready);
    const timer = setInterval(() => { if (fs.existsSync(go)) { clearInterval(timer); ${action} } }, 5);`;
  const sink = openEncoderSink({ path, bin: process.execPath, args: ['-e', script, ready, go], timeoutMs: 20000 });
  t.after(() => sink.abort());
  while (!existsSync(ready)) await sleep(5, undefined, { signal: t.signal });
  const pid = Number(readFileSync(ready, 'utf8'));
  rmSync(ready);
  return { sink, dir, path, go, pid };
}

const countTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const assertReaped = (pid) => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

test('文件在 finish 后一次发布，abort 保留已有内容', async (t) => {
  const { openFileSink } = await import('./sink.mjs');
  const { dir, path } = fixture(t);
  const first = openFileSink({ path });
  await first.write(Buffer.alloc(256 * 1024, 1));
  assert.ok(!existsSync(path));
  await Promise.all([first.abort(), first.abort()]);
  assert.deepEqual(readdirSync(dir), []);
  writeFileSync(path, 'previous');
  const next = openFileSink({ path });
  await next.write(Buffer.from('complete'));
  assert.equal(readFileSync(path, 'utf8'), 'previous');
  await next.finish();
  await next.abort();
  assert.equal(readFileSync(path, 'utf8'), 'complete');
  const cancelled = openFileSink({ path });
  await cancelled.write(Buffer.from('partial'));
  await cancelled.abort();
  assert.equal(readFileSync(path, 'utf8'), 'complete');
  assert.deepEqual(readdirSync(dir), ['out.bin']);
});

for (const mode of ['abort', 'exit', 'drain']) {
  test(`写满真实管道后 ${mode}，回收子进程、定时器和临时文件`, { timeout: 10000 }, async (t) => {
    const timers = countTimers();
    const action = mode === 'exit' ? 'process.exit(9)' : 'process.stdin.pipe(fs.createWriteStream(tmp))';
    const { sink, dir, path, go, pid } = await stalledEncoder(t, action);
    const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
    let settled = false;
    const write = sink.write(bytes).finally(() => { settled = true; });
    const checked = mode === 'drain' ? write : assert.rejects(write, failed);
    await sleep(15);
    assert.equal(settled, false);
    assert.ok(!existsSync(path));
    if (mode === 'abort') await Promise.all([sink.abort(), sink.abort()]);
    else writeFileSync(go, '');
    await checked;
    if (mode === 'drain') {
      await sink.finish();
      assert.deepEqual(readFileSync(path), bytes);
    } else await assert.rejects(sink.finish(), failed);
    assertReaped(pid);
    rmSync(go, { force: true });
    assert.deepEqual(readdirSync(dir), mode === 'drain' ? ['out.bin'] : []);
    assert.equal(countTimers(), timers);
  });
}

test('并发 finish 和 abort 会拒绝在途写入，保留原成品', async (t) => {
  const { openFileSink } = await import('./sink.mjs');
  const { path, dir } = fixture(t);
  writeFileSync(path, 'original');
  const sink = openFileSink({ path });
  await Promise.all([
    assert.rejects(sink.write(Buffer.alloc(256 * 1024)), failed),
    assert.rejects(sink.finish(), failed),
    sink.abort(),
  ]);
  assert.equal(readFileSync(path, 'utf8'), 'original');
  assert.deepEqual(readdirSync(dir), ['out.bin']);
});

test('缺失编码器和超时分别给出登记的 CompError，目录内零残留', async (t) => {
  const { openEncoderSink } = await import('./sink.mjs');
  const { path, dir } = fixture(t);
  for (const [code, options] of [
    ['env.ffmpeg-missing', { bin: join(dir, 'absent'), args: [] }],
    ['timeout.ffmpeg', { bin: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], timeoutMs: 100 }],
  ]) {
    const sink = openEncoderSink({ path, ...options });
    await assert.rejects(sink.finish(), (e) => e instanceof CompError && e.code === code);
    assert.deepEqual(readdirSync(dir), []);
  }
});

test('合成收尾公共入口提供两种输出端和拟音库', async () => {
  const comp = await import('./index.mjs');
  assert.equal(typeof comp.openFileSink, 'function');
  assert.equal(typeof comp.openEncoderSink, 'function');
  assert.equal(typeof comp.FOLEY_VOICES, 'object');
});

for (const voice of ['foley.step', 'foley.cloth', 'foley.impact', 'foley.metal']) {
  test(`X5 ${voice} 第 5 次触发与第 1 次的波形不同`, () => {
    const { make, pcenter } = VOICES[voice];
    const first = make(42, 0).left, fifth = make(42, 4).left;
    // 分开比较接触与主体：只有音高或只有高频增益在变，整段样本也会不等。
    for (const [layer, from, to] of [['接触', 0, 72], ['主体', 160, 600]]) {
      let delta = 0;
      for (let i = pcenter + from; i < pcenter + to; i++) delta = Math.max(delta, Math.abs(first[i] - fifth[i]));
      assert.ok(delta > 1e-4, `第 1、5 次${layer}的最大采样差 ${delta}`);
    }
  });
}

const hasFfmpeg = Object.values(tools()).every((bin) =>
  spawnSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }).status === 0);
const needFfmpeg = { skip: !hasFfmpeg && '环境缺少 ffmpeg / ffprobe' };
const example = (name) => JSON.parse(readFileSync(new URL(`../kernel/contracts/${name}`, import.meta.url), 'utf8'));

function foleyFilm(audio, count) {
  const film = example('film/examples/minimal.json');
  film.output = { size: [32, 16], fps: '30/1', frames: 30 + 15 * count };
  Object.assign(film.shots[0], { out: film.output.frames, colorRef: 'display', seed: 7 });
  film.events = Array.from({ length: count }, (_, i) => ({ id: `e${i}`, frame: 10 + 15 * i, audio, sync: 'onset' }));
  film.audio = { mode: 'script', loudness: -14, truePeak: -1 };
  film.delivery.web = true;
  return film;
}

function deliveryInput(dir, voice) {
  const film = foleyFilm(voice, 4);
  const lock = example('lock/examples/minimal.json');
  lock.cards['audio.master'] = example('lock/examples/check-full.json').lock.cards['audio.master'];
  lock.seeds.s01 = film.shots[0].seed;
  const pattern = join(dir, 'frame%03d.png');
  runTool(tools().ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x16:r=30',
    '-frames:v', String(film.output.frames), '-start_number', '0', pattern]);
  return { film, lock, events: eventsTable(film), frames: { s01: { pattern } } };
}

function checkLevels(t, label, { integrated, truePeak }) {
  const measured = `${label} ${integrated} LUFS，${truePeak} dBTP`;
  t.diagnostic(measured);
  assert.ok(integrated >= -15 && integrated <= -13 && truePeak <= -1, measured);
}

for (const voice of ['foley.step', 'foley.cloth']) {
  for (const count of [3, 8, 24]) {
    test(`X5 masterAudio ${voice} ×${count} 的 WAV 响度和真峰值达标`, needFfmpeg, (t) => {
      const events = eventsTable(foleyFilm(voice, count));
      const master = masterAudio(mixEvents(events, { seed: 1 }), fixture(t).dir);
      checkLevels(t, 'master.wav', measureLoudness(master.path));
    });
  }

  test(`X5 deliver ${voice} ×4 的母版与网页 AAC 响度和真峰值达标`, needFfmpeg, (t) => {
    const { dir } = fixture(t);
    const input = deliveryInput(dir, voice);
    const bundle = deliver({ ...input, outDir: join(dir, 'deliver') });
    const run = JSON.parse(readFileSync(join(bundle.dir, PIECES.run), 'utf8'));
    const audio = run.steps.find((step) => step.step === 'audio');
    assert.deepEqual(audio.placements.map((p) => [p.audio, p.frame]), input.film.events.map((e) => [e.audio, e.frame]));
    checkLevels(t, '交付记录中的 WAV 母带', audio.passes.at(-1));
    for (const name of [PIECES.master, PIECES.web]) {
      assert.equal(bundle.report.probes[name].audio.codec, 'aac');
      checkLevels(t, name, measureLoudness(join(bundle.dir, name)));
    }
  });
}

test('X5 M19 同一种子交付的 PCM 可重放，改 film 与锁的全片种子后 PCM 改变', needFfmpeg, (t) => {
  const { dir } = fixture(t);
  const input = deliveryInput(dir, 'foley.metal');
  const hashes = [1, 1, 2].map((seed, i) => {
    input.film.seed = input.lock.seeds.film = seed;
    const bundle = deliver({ ...input, outDir: join(dir, `deliver-${i}`) });
    const { stdout } = runTool(tools().ffmpeg, ['-nostdin', '-v', 'error', '-i', join(bundle.dir, PIECES.master),
      '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'hash', '-hash', 'sha256', 'pipe:1']);
    const hash = stdout.toString('utf8').trim();
    assert.match(hash, /^SHA256=[0-9a-f]{64}$/);
    t.diagnostic(`seed=${seed} PCM ${hash}`);
    return hash;
  });
  assert.equal(hashes[0], hashes[1], '同种子重放');
  assert.notEqual(hashes[0], hashes[2], '不同全片种子');
});
