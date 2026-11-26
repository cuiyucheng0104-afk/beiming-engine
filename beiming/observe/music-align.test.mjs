import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { align } from './index.mjs';

const ffmpeg = (process.env.FFMPEG ?? '').trim() || 'ffmpeg';
const skip = spawnSync(ffmpeg, ['-version']).error?.code === 'ENOENT' && '环境缺少 FFmpeg';

function encode(...args) {
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', ...args]);
}

test('music.align isolates delayed and retimed bass from an earlier treble distractor', { skip }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'music-align-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trackPath = join(dir, 'track.wav');
  const filmPath = join(dir, 'film.mkv');
  const silencePath = join(dir, 'silence.wav');
  const pattern = 'between(t,0.3,0.42)+0.8*between(t,1.5,1.62)+0.7*between(t,2.9,3.02)'
    + '+0.9*between(t,4.4,4.52)+0.6*between(t,6.1,6.22)+between(t,7.4,7.52)';
  encode('-f', 'lavfi', '-i', `aevalsrc='0.12*sin(2*PI*70*t)*(${pattern})':s=24000:d=8`, trackPath);
  encode('-f', 'lavfi', '-i', 'color=s=32x24:r=30:d=10', '-i', trackPath,
    '-f', 'lavfi', '-i', `aevalsrc='0.75*sin(2*PI*2400*t)*(${pattern})':s=24000:d=10`,
    '-filter_complex', '[1:a]asetrate=24000/1.01,aresample=24000,adelay=1000:all=1[bass];'
      + '[bass][2:a]amix=inputs=2:normalize=0:duration=longest,pan=stereo|c0=c0|c1=c0[mix]',
    '-map', '0:v:0', '-map', '[mix]', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', filmPath);
  const spec = { filmPath, trackPath, fps: 30, maxOffsetSec: 2 };
  const result = align({ music: spec, stretch: spec });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.music.metric, 'metric:music.align');
  assert.equal(result.music.reliable, true, JSON.stringify(result.music));
  assert.ok(result.music.corr >= 0.9, JSON.stringify(result.music));
  assert.ok(Math.abs(result.music.offsetSec - 1) <= 0.021, JSON.stringify(result.music));
  assert.ok(Math.abs(result.music.stretch - 1.01) <= 0.002, JSON.stringify(result.music));
  assert.equal(result.music.offsetFrames, Number((result.music.offsetSec * spec.fps).toFixed(2)));
  assert.ok(Math.abs(result.stretch.offsetSec) <= 0.021, JSON.stringify(result.stretch));
  assert.deepEqual(result.stretch, align({ media: spec }).stretch);

  const wrongWindow = align({ music: { ...spec, stretchRange: [1, 1], maxOffsetSec: 0 } });
  assert.equal(wrongWindow.ok, true);
  assert.equal(wrongWindow.music.reliable, false);
  assert.ok(wrongWindow.music.corr < 0.5 && wrongWindow.music.offsetSec === 0, JSON.stringify(wrongWindow.music));

  encode('-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=10', silencePath);
  const silent = align({ music: { ...spec, filmPath: silencePath } });
  assert.deepEqual(silent.music, {
    metric: 'metric:music.align', offsetSec: null, offsetFrames: null, stretch: null, corr: 0, reliable: false,
  });
});

test('music.align uses the full reference track energy when the film clips the ending', { skip }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'music-align-overlap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trackPath = join(dir, 'track.wav');
  const filmPath = join(dir, 'film.wav');
  const amplitude = 'if(lt(t,9.2),0.05+0.03*sin(2*PI*1.7*t),0.85)';
  encode('-f', 'lavfi', '-i', `aevalsrc='sin(2*PI*70*t)*${amplitude}':s=8000:d=10`, trackPath);
  encode('-i', trackPath, '-t', '9.2', filmPath);
  const spec = { filmPath, trackPath, stretchRange: [1, 1], maxOffsetSec: 0 };
  const result = align({ music: spec, stretch: spec });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.music.overlapRatio, 0.92);
  assert.equal(result.stretch.reliable, true);
  assert.ok(result.stretch.corr > 0.99, JSON.stringify(result.stretch));
  assert.equal(result.music.reliable, false);
  assert.ok(result.music.corr > 0 && result.music.corr < 0.5, JSON.stringify(result.music));
});

test('music.align requires both media paths and keeps structured validation errors', () => {
  for (const music of [null, {}, { filmPath: 'clip.mkv' }, { filmPath: '', trackPath: 'track.wav' }]) {
    const result = align({ music });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'usage.bad-argument');
    assert.match(result.error.message, /music/);
  }
});
