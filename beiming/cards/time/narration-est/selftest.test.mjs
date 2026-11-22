// time.narration-est 的自测：手算得出答案的小稿子。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from './evaluate.mjs';

const DEFAULTS = { wordSec: 0.15, letterSec: 0.036, letterCap: 9, stopSec: 0.34, commaSec: 0.18, segTailSec: 0.15, leadInSec: 0.3, firstLeadExtraSec: 0.25, tailPadSec: 0.36, gapSec: 0 };
const est = (script, params = {}, f = 0, sub = 0) => evaluate({ fps: '30/1', shot: { id: 's01', in: 0, frames: 300 } }, { ...DEFAULTS, ...params, script }, f, sub).narration;

test('time.narration-est：Hi, all. 两个词：222 + 180 + 258 + 340 毫秒，整段再加 150；第一段段前留 0.55 秒，段后留 0.36 秒', () => {
  const n = est([{ id: 's01', scene: 'intro', text: 'Hi, all.' }, { id: 'card', holdSec: 1.5 }]);
  assert.deepEqual(n.scenes, [
    { scene: 'intro', seg: 's01', startSec: 0, audioStartSec: 0.55, audioDurSec: 1.15, durSec: 2.06, startFrame: 0, endFrame: 62 },
    { scene: 'card', seg: null, startSec: 2.06, durSec: 1.5, startFrame: 62, endFrame: 107 },
  ]);
  assert.deepEqual(n.words, [{ scene: 'intro', word: 'hi', startSec: 0.55, endSec: 0.772 }, { scene: 'intro', word: 'all', startSec: 0.952, endSec: 1.21 }]);
  assert.deepEqual([n.durationSec, n.frames], [3.56, 107]);
});

test('time.narration-est：字母数封顶；带句点的缩写连成一个词、在句中也算句末；引号包住的句点不算；破折号加子句停顿、自己不算词', () => {
  // extraordinary 13 个字母按 9 个算：150 + 324
  assert.equal(est([{ id: 'a', text: 'extraordinary' }]).words[0].endSec, 1.024);
  // U.S. 是一个词 us（222），块以句点结尾加 340；gauge 330；整段 150
  const abbr = est([{ id: 'a', text: 'U.S. gauge' }]);
  assert.deepEqual(abbr.words.map((w) => [w.word, w.startSec]), [['us', 0.55], ['gauge', 1.112]]);
  assert.equal(abbr.scenes[0].audioDurSec, 1.042);
  // “stop.” 的最后一个字符是引号：只有 294 + 150
  assert.equal(est([{ id: 'a', text: '“stop.”' }]).scenes[0].audioDurSec, 0.444);
  // kit—no：258 + 180 + 222 + 150
  assert.equal(est([{ id: 'a', text: 'kit—no' }]).scenes[0].audioDurSec, 0.81);
});

test('time.narration-est：第二段起段前只留 leadInSec，段间隔 gapSec；参数先舍入到整数毫秒', () => {
  const n = est([{ id: 'a', text: 'no' }, { id: 'b', text: 'no' }], { gapSec: 0.5, letterSec: 0.0364 });
  // 每段配音 222 + 150 = 372；第一段 550 + 372 + 360 = 1282，隔 500，第二段从 1782 起、配音从 2082 起
  assert.deepEqual(n.scenes.map((s) => [s.startSec, s.audioStartSec, s.durSec]), [[0, 0.55, 1.282], [1.782, 2.082, 1.032]]);
  assert.equal(n.durationSec, 2.814);
});

test('time.narration-est：at 是这一刻落在哪个段、哪个词；段和词之外是 null', () => {
  const script = [{ id: 's01', scene: 'intro', text: 'Hi, all.' }, { id: 'card', holdSec: 1.5 }];
  assert.deepEqual(est(script, {}, 0).at, { sec: 0, scene: 'intro', word: null });
  assert.deepEqual(est(script, {}, 29).at.word, 1);
  assert.deepEqual(est(script, {}, 90).at, { sec: 3, scene: 'card', word: null });
  assert.deepEqual(est(script, {}, 200).at.scene, null);
});

test('time.narration-est：一段既没有 text 也没有 holdSec，或者两样都有，报错', () => {
  assert.throws(() => est([{ id: 'a' }]), RangeError);
  assert.throws(() => est([{ id: 'a', text: 'no', holdSec: 1 }]), RangeError);
});
