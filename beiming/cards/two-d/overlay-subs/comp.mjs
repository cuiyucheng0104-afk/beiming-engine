// overlay.subs 在合成一侧的实现：把逐词时间和字幕分块排成字幕时间表，交给合成工具往成片上叠。
// 合成宿主怎么用 Handle 还没有契约，这里定的用法写在卡文件的 ports.requires 里：ctx 带 size、fps 和 shot；
// 合成工具取 Handle.object.table 或 Handle.object.ass() 去叠字，逐帧调 meta(f) 拿文字框。时间先舍入到整数毫秒再算。

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
const fail = (message) => { throw Object.assign(new RangeError(`overlay.subs：${message}`), { code: 'contract.bad-value' }); };
const two = (n) => String(n).padStart(2, '0');

/**
 * ctx：用到 size（[宽, 高]，像素）、fps（"分子/分母"，帧每秒）和 shot.in（镜头起始帧，全片帧号；不带 shot 当 0）。
 * params.timing：{ scenes, words }，全片时间，秒，和 time.narration 收的是同一份；有旁白的场景要带 durSec、audioStartSec、audioDurSec。
 * params.blocks：每项 { scene, text, phrase }，一块字幕显示 text，从旁白念到 phrase（不写就用 text）第一次出现的那个词起。
 *   blocks 是空的就自己切：每个场景的词顺着排，一块最多 maxWords 个词、maxChars 个字符；一个词自己就超过 maxChars 的，
 *   每 maxChars 个字符硬切成一截，各截的起点按字符数在这个词的起止之间摊。
 * 一块从它起始词的起点提前 earlySec 起（不早于配音起点），到同场景下一块的起点止；场景里最后一块停到配音结束之后 holdSec（不晚于场景结束）。
 * Handle.object.table 每项 { index, scene, text, startSec, endSec, startFrame, endFrame, bbox }：帧号是全片帧号，这一块在 [startFrame, endFrame) 这些帧上；
 *   bbox 是 [x0, y0, x1, y1]（像素，原点在左上角，y 向下）。Handle.object.ass() 是同一张表写成的 ASS 字幕文本，起止对着帧边界写。
 * meta(f) 的 f 是镜头局部帧号，交全片第 shot.in + f 帧上那一块字幕的文字框，没有就交空的。
 */
export function create(ctx, params) {
  const [width, height] = ctx.size, [num, den] = ctx.fps.split('/').map(Number), { scenes, words } = params.timing;
  const frameAt = (t) => Math.round((t * num) / (1000 * den)), early = ms(params.earlySec);
  const stray = params.blocks.find((b) => !scenes.some((s) => s.scene === b.scene));
  if (stray) fail(`字幕块 ${JSON.stringify(stray.text)} 的场景 ${stray.scene} 不在 timing.scenes 里`);
  const fontPx = Math.round(params.heightFrac * height), bottom = height - Math.round(params.bottomFrac * height);
  // shortcut: 文字框按字符数 × 字高 × charAspect 估，不量字形；合成一侧有了排字的量宽再换成量出来的
  const bbox = (text) => {
    const w = Math.min(width, Math.round([...text].length * fontPx * params.charAspect));
    return [(width - w) / 2, bottom - fontPx, (width + w) / 2, bottom];
  };

  const table = [];
  for (const scene of scenes) {
    const mine = words.filter((w) => w.scene === scene.scene);
    let blocks;
    if (params.blocks.length) {
      // 一个词条切出几个词就占几项，时间都是这个词条的
      const seq = mine.flatMap((w) => tokens(w.word).map((word) => ({ word, start: ms(w.startSec) })));
      blocks = params.blocks.filter((b) => b.scene === scene.scene).map((b) => {
        const need = tokens(b.phrase ?? b.text), at = need.length ? seq.findIndex((_, i) => need.every((w, k) => seq[i + k]?.word === w)) : -1;
        if (at < 0) fail(`场景 ${scene.scene} 的旁白里找不到字幕块 ${JSON.stringify(b.text)} 的起始短语 ${JSON.stringify(b.phrase ?? b.text)}`);
        return { text: b.text, start: seq[at].start };
      });
    } else {
      blocks = [];
      const max = params.maxChars;
      for (const w of mine) {
        const chars = [...w.word], from = ms(w.startSec), span = ms(w.endSec) - from;
        for (let k = 0; k < chars.length; k += max) {
          const piece = chars.slice(k, k + max), cur = blocks.at(-1);
          if (cur && cur.n < params.maxWords && cur.len + 1 + piece.length <= max) { cur.text += ` ${piece.join('')}`; cur.len += 1 + piece.length; cur.n++; } else blocks.push({ text: piece.join(''), len: piece.length, n: 1, start: from + Math.round((span * k) / chars.length) });
        }
      }
    }
    if (!blocks.length) continue;
    if (![scene.durSec, scene.audioStartSec, scene.audioDurSec].every(Number.isFinite)) fail(`场景 ${scene.scene} 有字幕，timing.scenes 里它要带 durSec、audioStartSec、audioDurSec`);
    const audioStart = ms(scene.audioStartSec), last = Math.min(ms(scene.startSec) + ms(scene.durSec), audioStart + ms(scene.audioDurSec) + ms(params.holdSec));
    blocks.forEach((b, i) => {
      const start = Math.max(audioStart, b.start - early), end = i + 1 < blocks.length ? blocks[i + 1].start - early : last;
      if (end <= start) fail(`场景 ${scene.scene} 的字幕块 ${JSON.stringify(b.text)} 排不出时长：它的起始词不在下一块的起始词之前，或者离得不到 earlySec`);
      table.push({ index: table.length, scene: scene.scene, text: b.text, startSec: start / 1000, endSec: end / 1000, startFrame: frameAt(start), endFrame: frameAt(end), bbox: bbox(b.text) });
    });
  }

  // ASS 的时间只到百分之一秒：写帧的时间戳往下取整，帧率不到 100 时正好落在这一帧和上一帧之间，显示的帧就是 [startFrame, endFrame)
  const stamp = (frame) => {
    const cs = Math.floor((frame * 100 * den) / num);
    return `${Math.floor(cs / 360000)}:${two(Math.floor(cs / 6000) % 60)}:${two(Math.floor(cs / 100) % 60)}.${two(cs % 100)}`;
  };
  const ass = () => [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: subs,${params.font},${fontPx},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(fontPx / 16))},0,2,0,0,${height - bottom},1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...table.filter((r) => r.endFrame > r.startFrame).map((r) => `Dialogue: 0,${stamp(r.startFrame)},${stamp(r.endFrame)},subs,,0,0,0,,${r.text.replace(/[{}]/g, '\\$&').replace(/\r?\n/g, '\\N')}`), '',
  ].join('\n');

  return {
    object: { table, ass },
    meta(f) {
      const frame = (ctx.shot?.in ?? 0) + f, row = table.find((r) => r.startFrame <= frame && frame < r.endFrame);
      return { texts: row ? [{ id: `sub-${row.index}`, text: row.text, bbox2d: row.bbox }] : [] };
    },
    dispose() {},
  };
}
