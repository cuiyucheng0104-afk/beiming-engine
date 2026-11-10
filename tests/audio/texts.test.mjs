// engine/audio/voice/texts.mjs（字幕排版与 window.TEXTS）与声音报告的结构：
//   · 排版：字高为画高 4.5%、最后一行底边离画面底边 5%、方框在图文安全区（每边 5%）里、按帧起止、两行自下而上；
//   · 声音 QA（engine/audio/qa.py）与拍点核对（engine/audio/cuecheck.py）写的报告，过 P07 的 tools/qa/lib/report.mjs validateReport
//     （附录 C8 同一结构，film qa 可以直接收进总报告）。后一组要 Python（tools/env/py.mjs 选解释器），没有时跳过。
//   node --test tests/audio/texts.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cueAt, emWidth, subtitleLayout, textsFrom } from '../../engine/audio/voice/texts.mjs';
import { validateReport } from '../../tools/qa/lib/report.mjs';
import { pythonEnv, resolvePython } from '../../tools/env/py.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXTS = {
  schema: 'beiming.texts/1', fps: 24, size: [1920, 1080],
  cues: [
    { id: 'L1.1', line: 'L1', speaker: 'n', text: '北冥有鱼 其名为鲲', lines: ['北冥有鱼 其名为鲲'], start: 1, end: 3, startFrame: 24, endFrame: 72 },
    { id: 'L2.1', line: 'L2', speaker: 'g', text: '鲲之大 不知其几千里也\n化而为鸟 其名为鹏', lines: ['鲲之大 不知其几千里也', '化而为鸟 其名为鹏'], start: 4, end: 9, startFrame: 96, endFrame: 216 },
  ],
};

test('按帧起止：startFrame ≤ round(t·fps) < endFrame', () => {
  assert.equal(cueAt(TEXTS, 23 / 24), null);
  assert.equal(cueAt(TEXTS, 24 / 24).id, 'L1.1');
  assert.equal(cueAt(TEXTS, 71 / 24).id, 'L1.1');
  assert.equal(cueAt(TEXTS, 72 / 24), null);
  assert.equal(cueAt(TEXTS, 100 / 24).id, 'L2.1');
});

test('排版：字高 4.5%、底边留 5%、方框在图文安全区里、两行自下而上', () => {
  for (const [w, h] of [[1920, 1080], [1080, 1920], [3840, 2160]]) {
    const layout = subtitleLayout(TEXTS, { width: w, height: h });
    const rows = layout(5);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].fontPx, Math.round(h * 0.045));
    assert.ok(rows[0].y < rows[1].y, '第一行在上');
    for (const r of rows) {
      const [x, y, bw, bh] = r.box;
      assert.ok(x >= w * 0.05 && x + bw <= w * 0.95, `横向超出图文安全区：${JSON.stringify(r.box)}（${w}×${h}）`);
      assert.ok(y >= h * 0.05 && y + bh <= h * 0.95 + 1, `纵向超出：${JSON.stringify(r.box)}（${w}×${h}）`);
      assert.equal(r.x, w / 2);
    }
  }
});

test('window.TEXTS：{text, box, alpha, font}；淡入淡出按帧', () => {
  const T = textsFrom(subtitleLayout(TEXTS, { width: 1920, height: 1080, fadeFrames: 2 }));
  const [a] = T(24 / 24);
  assert.deepEqual(Object.keys(a).sort(), ['alpha', 'box', 'font', 'text']);
  assert.ok(a.alpha > 0 && a.alpha < 1, '第一帧淡入中');
  assert.equal(T(48 / 24)[0].alpha, 1);
  assert.deepEqual(T(80 / 24), []);
  assert.ok(Math.abs(emWidth('北冥 ab') - 3.4) < 1e-9);
});

const py = await resolvePython({});
const skip = py.ok ? false : `没有可用的 Python：${py.error}`;
const runPy = (args) => spawnSync(py.cmd, [...py.args, ...args], { cwd: ROOT, env: pythonEnv(process.env), encoding: 'utf8', timeout: 300_000 });

test('engine/audio/qa 与 cuecheck 的报告过 tools/qa 的 validateReport（附录 C8）', { skip }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-audio-c8-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const film = path.join(tmp, 'film');
  const gen = runPy(['-c', [
    'import sys, os', `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tests', 'audio'))})`, 'import _audiotest as H',
    `d = ${JSON.stringify(film)}`,
    "H.film_json(d, frames=240, fps=24, cuts=(120,), events=[{'id': 'bell', 'frame': 60, 'audio': 'bell'}])",
    "H.write_wav(os.path.join(d, 'out', 'mix.wav'), H.mastered(10.0, seed=2))",
    "import json; json.dump({'onsets': {'bell': 2.5}, 'notes': [2.5]}, open(os.path.join(d, 'out', 'score_onsets.json'), 'w'))",
  ].join('\n')]);
  assert.equal(gen.status, 0, gen.stderr);
  const qa = runPy(['-m', 'engine.audio.qa', '--film', film, '--report', path.join(tmp, 'qa.json')]);
  assert.equal(qa.status, 0, qa.stderr);
  const cc = runPy(['-m', 'engine.audio.cuecheck', film, '--report', path.join(tmp, 'cue.json')]);
  assert.equal(cc.status, 0, cc.stderr + cc.stdout);
  for (const f of ['qa.json', 'cue.json']) {
    const rep = JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8'));
    const v = validateReport(rep);
    assert.deepEqual(v.errors, [], `${f} 不符合附录 C8：${v.errors.join('；')}`);
    assert.equal(v.ok, true);
  }
});
