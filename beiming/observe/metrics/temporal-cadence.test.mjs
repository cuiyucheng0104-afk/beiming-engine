import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { regionalFlicker, onTwosCadence } from './temporal-cadence.mjs';

function movie(t, frames) {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'frames.mkv');
  const input = Buffer.from(frames.flatMap(row => [...row, ...row, ...Array(4 * row.length).fill(128)]));
  execFileSync('ffmpeg', ['-v','error','-f','rawvideo','-pixel_format','yuv444p',
    '-video_size', frames[0].length + 'x2','-framerate','30','-i','pipe:0','-c:v','ffv1',path], {input});
  return path;
}

test('three exact horizontal regions on seven pixels, strict jumps and neighbors', async t => {
  const rows = Array.from({length: 11}, () => Array(7).fill(80));
  rows[2].fill(89, 0, 2);
  rows[4].fill(88, 2, 4);
  rows[6].fill(90, 2, 4);
  rows[8][6] = 110;
  rows[9].fill(85, 0, 2);
  rows[8].fill(95, 0, 2); // neighbor gap 5 equals half the smaller jump
  const result = await regionalFlicker(movie(t,rows), {startFrame: 3});
  assert.deepEqual(result.value, {left: [], center: [6], right: [8]});
});

test('previous source parity, absolute five-frame phase and segment boundaries', async t => {
  const rows = Array.from({length: 20}, (_, n) => {
    const source = Math.floor(n * 4 / 5);
    const y = 40 + 12 * Math.floor(source / 2) + 2 * (source % 2);
    return [y,y,y,80,80,80];
  });
  const path = movie(t,rows);
  const result = await onTwosCadence(path, {cuts: [7],crop:{x:0,y:0,width:3,height:2}});
  assert.deepEqual(result.value.map(s => [s.start,s.end,s.oddToEven,s.evenToOdd,s.ratio]),
    [[0,7,10,2,5],[7,20,10,2,5]]);
  assert.deepEqual(result.details.phaseMedians,[10,0,2,10,2]);
  assert.equal(result.details.phaseOneRepeats,4);
  const still = await onTwosCadence(path,{crop:{x:3,y:0,width:3,height:2}});
  assert.equal(still.value[0].ratio,0);
});

test('upper median, empty parity groups and interior cuts', async t => {
  const path = movie(t,[40,40,42,52,58,72].map(v => [v,v,v]));
  const report = await onTwosCadence(path);
  assert.equal(report.value[0].oddToEven,14);
  assert.equal(report.value[0].evenToOdd,6);
  assert.equal(report.value[0].ratio,14/6);
  const short = await onTwosCadence(path,{cuts:[1]});
  assert.deepEqual(short.value[0],{start:0,end:1,oddToEven:null,evenToOdd:null,ratio:null});
  await assert.rejects(onTwosCadence(path,{cuts:[6]}),RangeError);
  await assert.rejects(onTwosCadence(path,{cuts:[2,2]}),RangeError);
  await assert.rejects(onTwosCadence(path,{crop:{x:2,y:0,width:2,height:1}}),RangeError);
});
