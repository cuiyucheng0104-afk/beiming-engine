import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import manifest from '../../beiming/cards/c14-craft-manifest.json' with { type: 'json' };
import { loadCardLibrary } from '../../beiming/api/runtime.mjs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const library = loadCardLibrary();
const guide = read('beiming/cards/C14-CRAFT.md');
const origin = 'https://github.com/cuiyucheng0104-afk/beiming-engine/blob/' + manifest.baseline + '/';

// 排除术语图例、表头、清单标题，以及样片缺少的海面镜头。
const chapters = {
  toon: { notes: [6, 435], count: 27, backlog: [465, 476] },
  'two-five-d': { notes: [7, 396, 513], count: 28, backlog: [515, 524] },
  animation: { notes: [6, 553], count: 22, backlog: [555, 569] },
  video: { notes: [6, 443], count: 36, backlog: [445, 456] },
  threejs: { notes: [6, 502], count: 17, backlog: [504, 513] },
};

test('目录中的工艺卡与固定提交的原文行号双向对应', () => {
  assert.equal(manifest.baseline, '490e76dba0e4fb29c39f3c932392a100f9e92e2a');
  const expectedRows = [];
  const counts = new Map();
  const covered = new Map();
  for (const id of manifest.ids) {
    const { card, dir } = library[id];
    const prefix = manifest.baseline + ' ';
    assert.ok(card.provenance.note.startsWith(prefix));
    const locations = card.provenance.note.slice(prefix.length);
    for (const location of locations.split(' · ')) {
      const [, chapter, numbers] = /^routes\/directing\/craft\/([\w-]+)\.md:([\d,]+)$/.exec(location);
      assert.ok(Object.hasOwn(chapters, chapter));
      counts.set(chapter, (counts.get(chapter) ?? 0) + 1);
      const path = 'routes/directing/craft/' + chapter + '.md';
      const lines = numbers.split(',').map(Number);
      const mapped = covered.get(chapter) ?? new Set();
      for (const n of lines) mapped.add(n);
      covered.set(chapter, mapped);
      const links = lines.map(n => '[' + n + '](' + origin + path + '?plain=1#L' + n + ')');
      expectedRows.push('| ' + card.title + ' | [`' + id + '@1`](' + dir.slice('cards/'.length)
        + '/card.json) | ' + links.join('、') + ' |');
    }
  }
  const actualRows = guide.split('\n').filter(line => line.includes('@1`]('));
  assert.deepEqual(actualRows.sort(), expectedRows.sort());

  for (const [chapter, { count, notes, backlog }] of Object.entries(chapters)) {
    const snapshot = manifest.chapters[chapter];
    const path = 'routes/directing/craft/' + chapter + '.md';
    assert.ok(guide.includes('[' + chapter + '.md](' + origin + path + ')'));
    assert.equal(counts.get(chapter), count);
    const mapped = covered.get(chapter);
    assert.deepEqual([...mapped].sort((a, b) => a - b), snapshot.citedLines);
    for (const n of notes) assert.ok(snapshot.markedLines.includes(n));
    for (const n of snapshot.markedLines) assert.ok(notes.includes(n) || mapped.has(n), path + ':' + n);
    for (let n = backlog[0]; n <= backlog[1]; n++) assert.ok(mapped.has(n), path + ':' + n);
  }
});

test('工作树仍含基线版本时，复核固定提交的章节索引', () => {
  for (const [chapter, snapshot] of Object.entries(manifest.chapters)) {
    const url = new URL('routes/directing/craft/' + chapter + '.md', root);
    let bytes;
    try {
      bytes = readFileSync(url);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== snapshot.sha256) continue;
    const lines = bytes.toString('utf8').split('\n');
    assert.deepEqual(lines.flatMap((line, index) => line.includes('未实现') ? [index + 1] : []),
      snapshot.markedLines);
    for (const n of snapshot.citedLines) assert.ok(lines[n - 1]?.trim(), chapter + ':' + n);
  }
});
