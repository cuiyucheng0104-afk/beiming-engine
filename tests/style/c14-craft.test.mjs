import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadCardLibrary } from '../../beiming/api/runtime.mjs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const library = loadCardLibrary();
const guide = read('beiming/cards/C14-CRAFT.md');
const cards = Object.values(library).filter(({ card }) => card.id.includes('.craft-'));

// 每组另外列出术语图例、表头、清单标题，以及底板章只说明样片缺少的海面镜头。
const chapters = {
  toon: { notes: [6, 435], count: 27, backlog: [465, 476] },
  'two-five-d': { notes: [7, 396, 513], count: 28, backlog: [515, 524] },
  animation: { notes: [6, 553], count: 22, backlog: [555, 569] },
  video: { notes: [6, 443], count: 36, backlog: [445, 456] },
  threejs: { notes: [6, 502], count: 17, backlog: [504, 513] },
};

test('工艺目录与卡出处双向对应，逐行覆盖五章历史标记及清单', () => {
  assert.equal(cards.length, 122);
  const indexed = [...guide.matchAll(/\| \[(`[^\n]+`)\]\(([^)]+\/card\.json)\) \| \[([\d,]+)\]\(\.\.\/\.\.\/(routes\/directing\/craft\/[\w-]+\.md)\)/g)];
  const expected = new Set();
  const counts = new Map();
  const covered = new Map();
  for (const { card, dir } of cards) {
    for (const location of card.provenance.note.split(' · ')) {
      const [, chapter, numbers] = /^routes\/directing\/craft\/([\w-]+)\.md:([\d,]+)$/.exec(location);
      assert.ok(Object.hasOwn(chapters, chapter));
      counts.set(chapter, (counts.get(chapter) ?? 0) + 1);
      const lines = covered.get(chapter) ?? new Set();
      numbers.split(',').map(Number).forEach(n => lines.add(n));
      covered.set(chapter, lines);
      expected.add(card.id + '@1 ' + dir + ' ' + location);
    }
  }
  const actual = indexed.map(([, ref, file, lines, path]) => {
    return ref.slice(1, -1) + ' cards/' + file.replace(/\/card\.json$/, '') + ' ' + path + ':' + lines;
  });
  assert.deepEqual(actual.sort(), [...expected].sort());
  for (const [chapter, { count, notes, backlog }] of Object.entries(chapters)) {
    const lines = read('routes/directing/craft/' + chapter + '.md').split('\n');
    assert.equal(counts.get(chapter), count);
    const mapped = covered.get(chapter);
    for (const n of mapped) assert.ok(lines[n - 1]?.trim(), chapter + ':' + n);
    for (const n of notes) assert.ok(lines[n - 1].includes('未实现'));
    lines.forEach((line, index) => {
      const n = index + 1;
      if ((line.includes('未实现') && !notes.includes(n)) || (n >= backlog[0] && n <= backlog[1])) {
        assert.ok(mapped.has(n), chapter + ':' + n);
      }
    });
  }
});
