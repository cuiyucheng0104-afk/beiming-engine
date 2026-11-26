// O2 · 英文歌词按序对词。输入粒度和参考片复算见 LYRICS-MATCH.md。
import { types } from 'node:util';

function need(condition, message) {
  if (!condition) throw Object.assign(new RangeError(message), { code: 'usage.bad-argument' });
}

function normalizeWords(input, reference) {
  need(!types.isProxy(input) && Array.isArray(input) && Object.getPrototypeOf(input) === Array.prototype,
    '词序列须为普通数组');
  need(input.length <= 512 && (!reference || input.length > 0), '每侧至多 512 词，参考序列不能为空');
  need(Reflect.ownKeys(input).length === input.length + 1, '词序列须为密实数组且无额外属性');
  const result = [];
  for (let i = 0; i < input.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, i);
    need(descriptor && Object.hasOwn(descriptor, 'value'), '词序列含空洞或访问器');
    const word = descriptor.value;
    need(typeof word === 'string' && word.length <= 256 && (!reference || word.trim().length > 0),
      '每词须为至多 256 个 UTF-16 单元的字符串，参考词不能为空白');
    const token = word.toLowerCase().replace(/[^a-z']/g, '');
    if (reference || token) result.push(token);
  }
  return result;
}

// dp[j + 1] 是以当前参考词、识别词 j 结束的公共连续块长度。
// 按参考、识别位置升序遍历，仅在严格增长时更新，保留原算法的并列优先级。
function longestBlock(ref, hyp, a0, a1, b0, b1, dp) {
  dp.fill(0, b0, b1 + 1);
  let a = a0, b = b0, size = 0;
  for (let i = a0; i < a1; i++) {
    let diagonal = 0;
    for (let j = b0; j < b1; j++) {
      const previous = dp[j + 1];
      const length = ref[i] === hyp[j] ? diagonal + 1 : 0;
      dp[j + 1] = length;
      diagonal = previous;
      if (length > size) {
        a = i + 1 - length;
        b = j + 1 - length;
        size = length;
      }
    }
  }
  return { a, b, size };
}

export function lyricsMatch(referenceWords, hypothesisWords) {
  const ref = normalizeWords(referenceWords, true);
  const hyp = normalizeWords(hypothesisWords, false);
  const pending = [[0, ref.length, 0, hyp.length]];
  const dp = new Uint16Array(hyp.length + 1);
  let matchedWords = 0;
  while (pending.length) {
    const [a0, a1, b0, b1] = pending.pop();
    const { a, b, size } = longestBlock(ref, hyp, a0, a1, b0, b1, dp);
    if (size === 0) continue;
    matchedWords += size;
    if (a0 < a && b0 < b) pending.push([a0, a, b0, b]);
    if (a + size < a1 && b + size < b1) pending.push([a + size, a1, b + size, b1]);
  }
  return { metric: 'metric:lyrics.match', matchedWords, hypothesisWords: hyp.length, referenceWords: ref.length,
    value: matchedWords / ref.length, unit: 'ratio' };
}
