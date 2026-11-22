// time.narration：旁白里的短语落在哪一刻，交成命名触发点。纯函数，不留跨帧的状态。
// 时间先舍入到整数毫秒再算，交出去之前才除以 1000。

/** 归一成词：小写；弯撇号当直撇号；后面紧跟字母或撇号的句点删掉（带句点的缩写连成一个词）；其余不是字母、数字、撇号的都断词 */
function tokens(text) {
  const s = text.toLowerCase(), out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] === '’' ? "'" : s[i];
    if (ch === '.' && /[a-z'’]/.test(s[i + 1] ?? '')) continue;
    if (/[a-z0-9']/.test(ch)) cur += ch;
    else if (cur) { out.push(cur); cur = ''; }
  }
  return cur ? [...out, cur] : out;
}

const ms = (sec) => Math.round(sec * 1000);
/** 按 Unicode 码点比，和事件表契约排条目的次序一样（字符串自带的比较按 UTF-16 码元，U+E000 会排到 U+10000 后面） */
function byCodePoint(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
const fail = (message) => { throw Object.assign(new RangeError(`time.narration：${message}`), { code: 'contract.bad-value' }); };

/**
 * inputs：用到 fps（"分子/分母"，帧每秒）和 shot.in（镜头起始帧，全片帧号）。
 * params.timing：{ scenes, words }，全片时间，秒。scenes 每项 { scene, startSec }；words 每项 { scene, word, startSec, endSec }，
 *   来自真实配音的逐词对齐，或者 time.narration-est 交出的 narration（可以整个传进来）。
 * params.triggers：每项 { id, scene, phrase, anchor, offsetSec }。在这个场景的词序列里找 phrase 第一次连续出现的位置；
 *   anchor 是 start（默认）取短语第一个词的起点，是 end 取最后一个词的终点；再加 offsetSec、减 params.anticipationSec，不早于场景起点。
 * f 是镜头局部帧号；sub 是子帧相位，触发点只落在整帧上，用不到。
 * 返回 { cues: { list, events, hits } }：list 照 triggers 的次序，每项 { id, scene, sec, sceneSec, frame }，sec 是全片时间，
 *   sceneSec 是离场景起点多久，frame 是全片帧号（毫秒 × 帧率，四舍五入）；events 是事件表里的命名条目，按帧号、标识（码点序）排好；
 *   hits 是正好落在这一帧的触发点的 id。找不到短语、场景不在 timing 里、id 重复都报错，不丢。
 */
export function evaluate(inputs, params, f, sub) { // sub 用不到也写上：卡入口的签名固定是四个参数
  const [num, den] = inputs.fps.split('/').map(Number), { scenes, words } = params.timing, seen = new Set();
  const list = params.triggers.map((tr) => {
    if (seen.has(tr.id)) fail(`触发点 ${tr.id} 重复`);
    seen.add(tr.id);
    const scene = scenes.find((s) => s.scene === tr.scene) ?? fail(`触发点 ${tr.id} 的场景 ${tr.scene} 不在 timing.scenes 里`);
    if (!['start', 'end'].includes(tr.anchor ?? 'start')) fail(`触发点 ${tr.id} 的 anchor 只能是 start、end，给的是 ${tr.anchor}`);
    // 一个词条切出几个词就占几项，时间都是这个词条的
    const seq = words.filter((w) => w.scene === tr.scene).flatMap((w) => tokens(w.word).map((word) => ({ word, start: ms(w.startSec), end: ms(w.endSec) })));
    const need = tokens(tr.phrase), at = need.length ? seq.findIndex((_, i) => need.every((w, k) => seq[i + k]?.word === w)) : -1;
    if (at < 0) fail(`场景 ${tr.scene} 的旁白里找不到触发点 ${tr.id} 的短语 ${JSON.stringify(tr.phrase)}`);
    const anchor = tr.anchor === 'end' ? seq[at + need.length - 1].end : seq[at].start, start = ms(scene.startSec);
    const t = Math.max(start, anchor + ms(tr.offsetSec ?? 0) - ms(params.anticipationSec));
    return { id: tr.id, scene: tr.scene, sec: t / 1000, sceneSec: (t - start) / 1000, frame: Math.round((t * num) / (1000 * den)) };
  });
  const events = list.map(({ id, frame }) => ({ id, frame, sub: 0, kind: 'named', from: 'film' })).sort((a, b) => a.frame - b.frame || byCodePoint(a.id, b.id));
  return { cues: { list, events, hits: list.filter((c) => c.frame === inputs.shot.in + f).map((c) => c.id).sort(byCodePoint) } };
}
