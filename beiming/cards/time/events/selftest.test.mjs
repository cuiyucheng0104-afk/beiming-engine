// time.events 的自测：落在这一帧的事件、离前后事件的帧数。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from './evaluate.mjs';

// 事件表换成镜头局部帧号之后的样子：一个命名事件在第 12 帧，一个切点在第 0 帧，一个命名事件在镜头结束之后
const inputs = { events: [{ id: 'cut.180', kind: 'cut', f: 0, sub: 0 }, { id: 'title', kind: 'named', f: 12, sub: 0 }, { id: 'outro', kind: 'named', f: 130, sub: 0 }] };
const at = (f, sub = 0, kind = 'named') => evaluate(inputs, { kind }, f, sub).events;

test('time.events：事件落的那一帧 hits 里有它，别的帧没有', () => {
  assert.deepEqual(at(12), { hits: ['title'], sinceFrames: 0, untilFrames: 118 });
  assert.deepEqual(at(12, 0.5), { hits: ['title'], sinceFrames: 0.5, untilFrames: 117.5 });
  assert.deepEqual(at(20), { hits: [], sinceFrames: 8, untilFrames: 110 });
});

test('time.events：前面没有事件时 sinceFrames 是 null', () => {
  assert.deepEqual(at(5), { hits: [], sinceFrames: null, untilFrames: 7 });
});

test('time.events：kind 定看哪一类；写了别的值报错', () => {
  assert.deepEqual(at(0, 0, 'cut'), { hits: ['cut.180'], sinceFrames: 0, untilFrames: null });
  assert.deepEqual(at(12, 0, 'any').sinceFrames, 0);
  assert.deepEqual(at(5, 0, 'any'), { hits: [], sinceFrames: 5, untilFrames: 7 });
  assert.throws(() => at(0, 0, 'beat'), RangeError);
});
