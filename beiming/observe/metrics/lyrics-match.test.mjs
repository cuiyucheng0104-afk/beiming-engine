import test from 'node:test';
import assert from 'node:assert/strict';
import { lyricsMatch } from './lyrics-match.mjs';

test('original English normalization and reference-length denominator', () => {
  assert.deepEqual(lyricsMatch(["Moon,", "CAN'T", 're-fit'], [' moon!', ' extra', " can't", ' refit', '...']), {
    metric: 'metric:lyrics.match', matchedWords: 3, hypothesisWords: 4, referenceWords: 3, value: 1, unit: 'ratio',
  });
  assert.equal(lyricsMatch(['Moon', '—'], ['moon', '—']).value, 0.5);
  assert.equal(lyricsMatch(['blue'], []).value, 0);
  assert.equal(lyricsMatch(['blue', 'green'], ['green', 'blue']).matchedWords, 1);
});

test('longest block and earliest tie follow SequenceMatcher, including common tokens', () => {
  const seq = s => [...s];
  assert.equal(lyricsMatch(seq('tide'), seq('diet')).matchedWords, 1);
  assert.equal(lyricsMatch(seq('diet'), seq('tide')).matchedWords, 2);
  const common = Array(205).fill('green');
  assert.equal(lyricsMatch(['one', ...common], ['two', ...common]).matchedWords, 205);
});

test('rejects malformed, unbounded and empty reference inputs without invoking accessors', () => {
  for (const bad of [[], null, 'abc', [3], Array(2), Array(513).fill('x'), ['a'.repeat(257)], ['']]) {
    assert.throws(() => lyricsMatch(bad, []), { code: 'usage.bad-argument' });
  }
  assert.throws(() => lyricsMatch(['a'], new Proxy([], { get() { assert.fail(); } })), { code: 'usage.bad-argument' });
  const words = ['a'];
  Object.defineProperty(words, '0', { get() { assert.fail(); } });
  assert.throws(() => lyricsMatch(words, []), { code: 'usage.bad-argument' });
});

test('case 20 archived transcript and fixed local recognizer, equality-preserving anonymous tokens', () => {
  const words = ids => ids.split(' ').map(id => 'word' + String.fromCharCode(97 + Math.floor(Number(id) / 26), 97 + Number(id) % 26));
  const ref = words('0 1 0 2 0 3 4 5 6 7 8 9 10 11 12 13 10 11 12 14 15 16 17 18 19 20 12 21 22 12 21 23 24 25 26 27 15 16 15 16');
  const archive = words('0 1 0 2 0 3 4 5 6 7 8 9 10 11 28 10 11 29 15 16 30 31 32 33 12 21 34 12 21 23 24 25 26 27 15 16 15 16');
  const local = words('0 1 0 2 0 3 4 5 6 7 8 9 10 11 12 35 10 11 12 14 15 16 36 31 32 33 12 21 34 12 21 23 24 25 26 27 15 16 15 16');
  for (const [hyp, count, matches] of [[archive, 38, 31], [local, 40, 34]]) {
    const result = lyricsMatch(ref, hyp);
    assert.deepEqual([result.hypothesisWords, result.matchedWords, result.referenceWords, result.value], [count, matches, 40, matches / 40]);
  }
});
