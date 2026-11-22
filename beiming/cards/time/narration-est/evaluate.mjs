// time.narration-est：还没有配音时，按词长和标点估旁白的时间。纯函数，不留跨帧的状态。
// 时间全程用整数毫秒累加，交出去之前才除以 1000，所以同一份稿子在哪台机器上算都是同一组数。

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
const TIMES = ['wordSec', 'letterSec', 'stopSec', 'commaSec', 'segTailSec', 'leadInSec', 'firstLeadExtraSec', 'tailPadSec', 'gapSec'];

/**
 * inputs：用到 fps（"分子/分母"，帧每秒）和 shot.in（镜头起始帧，全片帧号）。
 * params.script：一段一项，按出场次序。带 text 的是有旁白的段；带 holdSec 的是没有旁白、固定时长的段。scene 不写就用 id。
 * 一段的时长 = 段前留白 + 配音时长 + 段后留白。配音时长：每个词 wordSec + letterSec × min(字母数, letterCap)；
 * 按空白切出的原始块以 . ? ! 结尾加 stopSec，以 , ; : 结尾或者是独立的破折号加 commaSec（破折号先被空格隔开，自己不算词）；整段再加 segTailSec。
 * 段前留白是 leadInSec，第一段多留 firstLeadExtraSec；段后留白是 tailPadSec；段与段之间隔 gapSec。各个秒数先舍入到整数毫秒。
 * f 是镜头局部帧号，sub 是子帧相位 [0, 1)。
 * 返回 { narration: { durationSec, frames, scenes, words, at } }：时间都是全片时间。
 *   scenes 每项 { scene, seg, startSec, durSec, startFrame, endFrame }，有旁白的段另带 audioStartSec、audioDurSec，没有旁白的段 seg 是 null；
 *   words 每项 { scene, word, startSec, endSec }，是估出来的逐词时间；
 *   at 是这一刻（f + sub）的读数 { sec, scene, word }：落在哪个段、哪个词（words 的下标），都没有就是 null。
 */
export function evaluate(inputs, params, f, sub) {
  const [num, den] = inputs.fps.split('/').map(Number), frameAt = (t) => Math.round((t * num) / (1000 * den));
  const p = Object.fromEntries(TIMES.map((k) => [k, ms(params[k])]));
  const scenes = [], words = [];
  let T = 0;
  params.script.forEach((seg, i) => {
    const scene = seg.scene ?? seg.id, spoken = typeof seg.text === 'string';
    if (spoken === Number.isFinite(seg.holdSec)) throw new RangeError(`time.narration-est 的段 ${seg.id} 要么带 text，要么带 holdSec，只能有一样`);
    const row = { scene, seg: spoken ? seg.id : null, startSec: T / 1000 };
    let dur = spoken ? 0 : ms(seg.holdSec);
    if (spoken) {
      const lead = p.leadInSec + (i === 0 ? p.firstLeadExtraSec : 0);
      let t = 0;
      for (const chunk of seg.text.replaceAll('—', ' — ').split(/\s+/).filter(Boolean)) {
        for (const word of tokens(chunk)) {
          const d = p.wordSec + p.letterSec * Math.min(word.length, params.letterCap);
          words.push({ scene, word, startSec: (T + lead + t) / 1000, endSec: (T + lead + t + d) / 1000 });
          t += d;
        }
        // 停顿只看原始块的最后一个字符：句中带句点的缩写也算句末，引号包住的句点不算
        const last = chunk.at(-1);
        if ('.?!'.includes(last)) t += p.stopSec;
        else if (',;:'.includes(last) || chunk === '—') t += p.commaSec;
      }
      Object.assign(row, { audioStartSec: (T + lead) / 1000, audioDurSec: (t + p.segTailSec) / 1000 });
      dur = lead + t + p.segTailSec + p.tailPadSec;
    }
    scenes.push({ ...row, durSec: dur / 1000, startFrame: frameAt(T), endFrame: frameAt(T + dur) });
    T += dur + (i + 1 < params.script.length ? p.gapSec : 0);
  });
  const sec = ((inputs.shot.in + f + sub) * den) / num;
  const here = scenes.find((s) => s.startSec <= sec && sec < s.startSec + s.durSec), word = words.findIndex((w) => w.startSec <= sec && sec < w.endSec);
  return { narration: { durationSec: T / 1000, frames: frameAt(T), scenes, words, at: { sec, scene: here?.scene ?? null, word: word < 0 ? null : word } } };
}
