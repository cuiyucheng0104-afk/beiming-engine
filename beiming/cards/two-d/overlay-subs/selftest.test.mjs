// overlay.subs 的自测：手写的逐词时间表上排两块字幕。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from './comp.mjs';

const timing = {
  scenes: [{ scene: 'title', startSec: 0, durSec: 2 }, { scene: 'rain', startSec: 2, durSec: 3, audioStartSec: 2.3, audioDurSec: 2.2 }],
  words: [
    { scene: 'rain', word: 'Rain', startSec: 2.3, endSec: 2.6 }, { scene: 'rain', word: 'falls', startSec: 2.7, endSec: 3 }, { scene: 'rain', word: 'on', startSec: 3.2, endSec: 3.4 },
    { scene: 'rain', word: 'the', startSec: 3.5, endSec: 3.6 }, { scene: 'rain', word: 'hills.', startSec: 3.7, endSec: 4.1 },
  ],
};
const BLOCKS = [{ scene: 'rain', text: 'Rain falls', phrase: 'rain' }, { scene: 'rain', text: 'on the hills.', phrase: 'on the' }];
const DEFAULTS = { timing, blocks: BLOCKS, maxWords: 7, maxChars: 42, earlySec: 0.06, holdSec: 0.25, heightFrac: 0.05, bottomFrac: 0.08, charAspect: 0.5, font: 'sans-serif' };
const subs = (params = {}) => create({ size: [1920, 1080], fps: '30/1' }, { ...DEFAULTS, ...params });

test('overlay.subs：第一块从配音起点起，停在第二块起始词之前 0.06 秒；最后一块停到配音结束之后 0.25 秒；框按字数估、左右居中', () => {
  assert.deepEqual(subs().object.table, [
    { index: 0, scene: 'rain', text: 'Rain falls', startSec: 2.3, endSec: 3.14, startFrame: 69, endFrame: 94, bbox: [825, 940, 1095, 994] },
    { index: 1, scene: 'rain', text: 'on the hills.', startSec: 3.14, endSec: 4.75, startFrame: 94, endFrame: 143, bbox: [784.5, 940, 1135.5, 994] },
  ]);
});

test('overlay.subs：最后一块不越出场景；不写 phrase 就用 text 找', () => {
  assert.equal(subs({ holdSec: 1 }).object.table[1].endSec, 5);
  assert.deepEqual(subs({ blocks: [{ scene: 'rain', text: 'Falls on' }] }).object.table.map((r) => [r.startSec, r.endSec]), [[2.64, 4.75]]);
});

test('overlay.subs：blocks 是空的就按 maxWords、maxChars 自己切', () => {
  assert.deepEqual(subs({ blocks: [], maxWords: 2 }).object.table.map((r) => [r.text, r.startSec, r.endSec]), [['Rain falls', 2.3, 3.14], ['on the', 3.14, 3.64], ['hills.', 3.64, 4.75]]);
  assert.deepEqual(subs({ blocks: [], maxChars: 11 }).object.table.map((r) => r.text), ['Rain falls', 'on the', 'hills.']);
});

test('overlay.subs：meta(f) 交这一帧那块字幕的文字框，起始帧在、结束帧不在；没有字幕的帧交空的', () => {
  const s = subs();
  assert.deepEqual(s.meta(69), { texts: [{ id: 'sub-0', text: 'Rain falls', bbox2d: [825, 940, 1095, 994] }] });
  assert.deepEqual(s.meta(93).texts[0].id, 'sub-0');
  assert.deepEqual(s.meta(94).texts[0].id, 'sub-1');
  assert.deepEqual([s.meta(68), s.meta(143)], [{ texts: [] }, { texts: [] }]);
});

test('overlay.subs：非首镜头（shot.in 是 69）：meta(f) 的 f 是镜头局部帧号，meta(0) 就是全片第 69 帧上的那一块；表里的帧号不变', () => {
  const s = create({ size: [1920, 1080], fps: '30/1', shot: { id: 's02', in: 69, frames: 90 } }, DEFAULTS);
  assert.deepEqual(s.object.table.map((r) => [r.startFrame, r.endFrame]), [[69, 94], [94, 143]]);
  assert.deepEqual([s.meta(0).texts[0].id, s.meta(24).texts[0].id, s.meta(25).texts[0].id, s.meta(73).texts[0].id, s.meta(74).texts], ['sub-0', 'sub-0', 'sub-1', 'sub-1', []]);
});

test('overlay.subs：自己切的时候一个词比 maxChars 还长就硬切，每一块都不超过 maxChars，各截的起点按字符数摊', () => {
  // 43 个字符的词，2.7 到 3.13 秒（430 毫秒）：前 42 个字符一块，从 2.7 - 0.06 起；第 43 个字符从 2700 + round(430 × 42 / 43) = 3120 毫秒起、不再提前，和后面的 on 拼一块
  const long = 'a'.repeat(42) + 'b', words = timing.words.map((w) => (w.word === 'falls' ? { ...w, word: long, endSec: 3.13 } : w));
  const table = subs({ blocks: [], timing: { ...timing, words } }).object.table;
  assert.deepEqual(table.map((r) => [r.text, r.startSec, r.endSec]), [['Rain', 2.3, 2.64], ['a'.repeat(42), 2.64, 3.12], ['b on the hills.', 3.12, 4.75]]);
  for (const maxChars of [1, 5, 11, 42]) assert.ok(subs({ blocks: [], maxChars, timing: { ...timing, words } }).object.table.every((r) => [...r.text].length <= maxChars), `maxChars = ${maxChars}`);
});

test('overlay.subs：硬切出来的各截顺着接，只有第一截提前 earlySec；后面一块的提前量不压到最后一截摊到的时间里', () => {
  // 420 个字符的词，2.7 到 3.12 秒（420 毫秒）：每 42 个字符一截、各摊 42 毫秒；后面的 on 从 3.2 秒起，提前到 3.14
  const words = timing.words.map((w) => (w.word === 'falls' ? { ...w, word: 'a'.repeat(420), endSec: 3.12 } : w));
  const table = subs({ blocks: [], timing: { ...timing, words } }).object.table;
  assert.deepEqual(table.map((r) => r.startSec), [2.3, 2.64, 2.742, 2.784, 2.826, 2.868, 2.91, 2.952, 2.994, 3.036, 3.078, 3.14]);
  table.slice(1).forEach((r, i) => assert.ok(table[i].startSec < r.startSec && table[i].endSec === r.startSec, r.text));
  // on 紧跟在长词后面（3.12 秒起）：提前 0.06 秒会早过最后一截的起点 3.078，改从长词念完的 3.12 起
  const tight = subs({ blocks: [], timing: { ...timing, words: words.map((w) => (w.word === 'on' ? { ...w, startSec: 3.12 } : w)) } }).object.table;
  assert.deepEqual([tight[10].startSec, tight[10].endSec, tight[11].text], [3.078, 3.12, 'on the hills.']);
});

test('overlay.subs：ASS 的起止对着帧边界往下取到百分之一秒，花括号转义', () => {
  const lines = subs({ blocks: [BLOCKS[0], { ...BLOCKS[1], text: 'on {the} hills.' }] }).object.ass().split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('Dialogue:')), [
    'Dialogue: 0,0:00:02.30,0:00:03.13,subs,,0,0,0,,Rain falls',
    'Dialogue: 0,0:00:03.13,0:00:04.76,subs,,0,0,0,,on \\{the\\} hills.',
  ]);
  assert.ok(lines.includes('PlayResX: 1920') && lines.includes('PlayResY: 1080'));
  assert.equal(lines.find((l) => l.startsWith('Style:')), 'Style: subs,sans-serif,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,0,0,86,1');
});

test('overlay.subs：找不到起始短语、两块落在同一个词上、场景不在表里、有字幕的场景缺配音时间，都报 contract.bad-value', () => {
  const bad = (params) => assert.throws(() => subs(params), (e) => e instanceof RangeError && e.code === 'contract.bad-value');
  bad({ blocks: [{ scene: 'rain', text: 'Snow' }] });
  bad({ blocks: [BLOCKS[0], { scene: 'rain', text: 'Rain again', phrase: 'rain' }] });
  bad({ blocks: [BLOCKS[1], BLOCKS[0]] });
  bad({ blocks: [{ scene: 'storm', text: 'Rain' }] });
  bad({ timing: { scenes: [{ scene: 'rain', startSec: 2 }], words: timing.words } });
});
