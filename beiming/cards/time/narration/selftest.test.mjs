// time.narration 的自测：手写的逐词时间表上找短语。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from './evaluate.mjs';

const timing = {
  scenes: [{ scene: 'intro', startSec: 0 }, { scene: 'rain', startSec: 2 }],
  words: [
    { scene: 'intro', word: 'Rain', startSec: 0.4, endSec: 0.7 },
    { scene: 'rain', word: 'Rain', startSec: 2.5, endSec: 2.8 },
    { scene: 'rain', word: 'falls;', startSec: 2.9, endSec: 3.3 },
    { scene: 'rain', word: 'U.S.', startSec: 3.5, endSec: 3.8 },
    { scene: 'rain', word: '3.7%', startSec: 4, endSec: 4.4 },
  ],
};
const cues = (triggers, anticipationSec = 0, f = 0) => evaluate({ fps: '30/1', shot: { id: 's01', in: 60, frames: 90 } }, { timing, triggers, anticipationSec }, f, 0).cues;

test('time.narration：短语在它那个场景里找，取第一个词的起点；anchor 是 end 取最后一个词的终点；offsetSec 往后挪', () => {
  assert.deepEqual(cues([{ id: 'rain', scene: 'rain', phrase: 'rain' }]).list, [{ id: 'rain', scene: 'rain', sec: 2.5, sceneSec: 0.5, frame: 75 }]);
  assert.deepEqual(cues([{ id: 'done', scene: 'rain', phrase: 'Rain falls', anchor: 'end', offsetSec: 0.1 }]).list, [{ id: 'done', scene: 'rain', sec: 3.4, sceneSec: 1.4, frame: 102 }]);
});

test('time.narration：大小写、标点、缩写里的句点不计；一个词条切出两个词时都用它的时间', () => {
  assert.deepEqual(cues([{ id: 'a', scene: 'rain', phrase: 'falls us' }, { id: 'b', scene: 'rain', phrase: '7' }]).list.map((c) => c.sec), [2.9, 4]);
});

test('time.narration：提前量压不过场景起点', () => {
  assert.deepEqual(cues([{ id: 'rain', scene: 'rain', phrase: 'rain' }], 0.2).list[0], { id: 'rain', scene: 'rain', sec: 2.3, sceneSec: 0.3, frame: 69 });
  assert.deepEqual(cues([{ id: 'rain', scene: 'rain', phrase: 'rain' }], 1).list[0], { id: 'rain', scene: 'rain', sec: 2, sceneSec: 0, frame: 60 });
});

test('time.narration：events 是命名条目，按帧号、标识排；hits 是落在这一帧的触发点', () => {
  const c = cues([{ id: 'z', scene: 'rain', phrase: 'falls' }, { id: 'b', scene: 'rain', phrase: 'rain' }, { id: 'a', scene: 'rain', phrase: 'rain falls' }], 0, 15);
  assert.deepEqual(c.events, [
    { id: 'a', frame: 75, sub: 0, kind: 'named', from: 'film' }, { id: 'b', frame: 75, sub: 0, kind: 'named', from: 'film' }, { id: 'z', frame: 87, sub: 0, kind: 'named', from: 'film' },
  ]);
  assert.deepEqual(c.hits, ['a', 'b']);
});

test('time.narration：入口是四个参数；同一帧的触发点按码点序排，U+E000 在 U+10000 前面', () => {
  assert.equal(evaluate.length, 4);
  const ids = ['\u{10000}', '\u{E000}', 'b', 'a'], c = cues(ids.map((id) => ({ id, scene: 'rain', phrase: 'rain' })), 0, 15);
  assert.deepEqual([c.events.map((e) => e.id), c.hits], [['a', 'b', '\u{E000}', '\u{10000}'], ['a', 'b', '\u{E000}', '\u{10000}']]);
});

test('time.narration：找不到短语、场景不在表里、id 重复、anchor 写错都报 contract.bad-value', () => {
  const bad = (triggers) => assert.throws(() => cues(triggers), (e) => e instanceof RangeError && e.code === 'contract.bad-value');
  bad([{ id: 'a', scene: 'rain', phrase: 'snow' }]);
  bad([{ id: 'a', scene: 'intro', phrase: 'rain falls' }]);
  bad([{ id: 'a', scene: 'rain', phrase: '—' }]);
  bad([{ id: 'a', scene: 'storm', phrase: 'rain' }]);
  bad([{ id: 'a', scene: 'rain', phrase: 'rain' }, { id: 'a', scene: 'rain', phrase: 'falls' }]);
  bad([{ id: 'a', scene: 'rain', phrase: 'rain', anchor: 'middle' }]);
});
