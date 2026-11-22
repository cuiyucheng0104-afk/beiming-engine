// B3 二级第一批四道题的判分核验：把题目的基础谓词和 scoring[].args 里的阈值套到一份读数上。
//   evaluate(question, reading) → { score, pass, basePass, base: [{ predicate, pass, status, why, atFrame }], items: [{ metric, weight, pass, detail }] }
//   score 是过了的判分项的权重和；basePass 是基础谓词条条都过；pass 是 basePass 加每个判分项都过，差一项就判不合格。
//   基础谓词这里不另写判法：读数拼成片子描述和成片量测，逐条交给正式谓词核（verify/predicates.mjs 的 evaluateAssertion），它判 pass 才算过。
//   它回 skipped（缺量测）、要对镜头表而读数里没有成形的镜头表，都是没证据，不算过；不过的那条带 why 和反例帧 atFrame。
//   所以读数除了各题自己的表，还要带成片这一头的 colorTag、blackFrames、freezes、cuts 和工程的镜头表 shots。
//   读数不成形（不是 JSON 对象、缺子表、表里有空洞或混进非数、帧率和总帧数跟交付规格不一致）一律 0 分、不合格，原因写在 detail.invalid，不抛错。
//   读数的字段见 beiming/bench/refs/level-2-a/ 的夹具；时刻要么是整数帧，要么是整数毫秒，比较全用整数，不落在浮点误差上。
//   read27_1、read29_2、read23_2 从成片量读数，镜头表取工程的片子描述或事件表；readFilm 只量成片这一头；read30_1 静态扫工程目录，
//   要判基础谓词就把 readFilm 的结果并进去。机器上没有 ffmpeg/ffprobe 回 { toolMissing }。
// shortcut: 命中率和随机基线（05 第 7.1 节的 metric:beat.onset-hit）观测层还没有，先在这里算；它进了 observe/metrics 就换成调它。
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandEventFrames } from '../../../kernel/eval/events.mjs';
import { audioLoudness, blackFreezeDup, cutYdif, deliverSpec } from '../../../observe/metrics/index.mjs';
import { evaluateAssertion } from '../../../verify/predicates.mjs';

// 离周期网格最近一格有多远；网格向两头无限延伸，周期、相位、时刻同一个单位
function offGrid(at, period, phase = 0) {
  const into = (((at - phase) % period) + period) % period;
  return Math.min(into, period - into);
}
const share = (hits, events) => ({ hits, events, hitRate: events ? hits / events : 0 });
const finite = (...values) => values.every(Number.isFinite);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 没有空洞的整数表，每项落在 [low, high)；Array.from 把空洞读成 undefined，every 才不会跳过它
const ints = (list, low, high) => Array.isArray(list) && Array.from(list, (v) => Number.isSafeInteger(v) && v >= low && v < high).every(Boolean);
const rising = (list) => list.every((v, i) => i === 0 || v > list[i - 1]);
// 写死帧号的计数有两个名字，给了哪个算哪个
const hardcoded = (timeline) => [timeline.hardcodedFrames, timeline.hardcodedFrameCount].filter((count) => count !== undefined);
const rate = (fps) => {
  const [num, den] = typeof fps === 'string' ? fps.split('/').map(Number) : [];
  return num / den;
};

// 每道题的读数要长什么样；回空串是成形，否则回哪里不成形
const SHAPES = {
  '27-1': ({ cuts, loudnessLufs, truePeakDbtp }, { frames }) =>
    (ints(cuts, 0, frames) && rising(cuts) ? '' : 'cuts 要是片内严格递增的整数帧')
    || (finite(loudnessLufs, truePeakDbtp) ? '' : 'loudnessLufs、truePeakDbtp 要是有限数'),
  // 点击帧号出自事件表；那张表的 fps、frames 要和交付规格逐字相同（事件契约 EV6），不然帧号说的不是这条片子
  '29-2': ({ clicks, cuts, onsetsMs, eventsFps, eventsFrames }, { fps, frames, durationMs }) =>
    (eventsFps === fps && eventsFrames === frames ? '' : `事件表的 eventsFps、eventsFrames 要和交付规格一致（${fps}、${frames}）`)
    || ([clicks, cuts].every((list) => ints(list, 0, frames) && rising(list)) ? '' : 'clicks、cuts 要是片内严格递增的整数帧')
    || (ints(onsetsMs, 0, durationMs) && rising(onsetsMs) && onsetsMs.length ? '' : 'onsetsMs 要是不空的、片内严格递增的整数毫秒'),
  '23-2': ({ chaptersMs, strongOnsetsMs, beat }, { durationMs }) =>
    (ints(chaptersMs, 0, durationMs) && rising(chaptersMs) ? '' : 'chaptersMs 要是片内严格递增的整数毫秒')
    || (ints(strongOnsetsMs, 0, durationMs) && rising(strongOnsetsMs) && strongOnsetsMs.length ? '' : 'strongOnsetsMs 要是不空的、片内严格递增的整数毫秒')
    || (plain(beat) && ints([beat.periodMs], 1, Infinity) && ints([beat.phaseMs], 0, beat.periodMs) ? '' : 'beat 要有正整数 periodMs 和 [0, periodMs) 里的整数 phaseMs'),
  '30-1': ({ moments, timeline }, { frames }) =>
    (Array.isArray(moments) && Array.from(moments, (m) => plain(m) && typeof m.id === 'string' && m.id !== '' && ints([m.frame], 0, frames)).every(Boolean)
      && new Set(moments.map((m) => m.id)).size === moments.length ? '' : 'moments 每项要有不空、不重复的字符串 id 和片内的整数 frame')
    || (plain(timeline) && ints([timeline.beatConstantDefs], 0, Infinity) && hardcoded(timeline).length && ints(hardcoded(timeline), 0, Infinity)
      ? '' : 'timeline 的 beatConstantDefs、hardcodedFrames（也认 hardcodedFrameCount）要是非负整数')
    || ([timeline.bpm].every((v) => v === undefined || (Number.isFinite(v) && v > 0)) && (timeline.beatFrames === undefined || ints([timeline.beatFrames], 1, Infinity))
      ? '' : 'timeline 的 bpm 要是正数、beatFrames 要是正整数；没有节拍表就两个都不写'),
};

// 判分里帧和毫秒互换、片内范围都按题面的帧率和总帧数算，所以这两项对不上的读数不判，直接算不成形；画幅只在基础谓词里核
function malformed({ id, deliverable }, reading) {
  if (!plain(reading)) return '读数不是对象';
  if (reading.toolMissing) return `量不了：机器上没有 ${reading.toolMissing}`;
  if (reading.unreadable) return `读不了 ${reading.unreadable}`;
  const fps = rate(deliverable.fps), { frames } = deliverable;
  if (reading.fps !== fps || reading.frames !== frames) return `fps、frames 要和交付规格一致（${fps}、${frames}）`;
  return SHAPES[id](reading, { fps: deliverable.fps, frames, durationMs: (frames * 1000) / fps });
}

// 每道题一组判法，次序和题目文件的 scoring 一一对应；进来的读数都过了上面的成形检查
const RULES = {
  '27-1': [
    ({ gridFrames, shotBeats, firstCut }, { cuts, frames }) => {
      const stray = cuts.filter((frame) => frame % gridFrames !== 0);
      // 片尾不足一拍的零头算最后一个镜头的收尾，不计拍数
      const edges = [0, ...cuts, frames - (frames % gridFrames)];
      const beats = edges.slice(1).map((frame, i) => (frame - edges[i]) / gridFrames);
      // 切点表严格递增，cuts[0] 就是第一个换镜头：它前面再切一刀，第 firstCut 帧就不是首切了
      return { pass: cuts.length > 0 && cuts[0] === firstCut && stray.length === 0 && beats.every((n) => shotBeats.includes(n)),
        cuts: cuts.length, firstCut: cuts[0] ?? null, offGrid: stray, beats };
    },
    ({ rangeLufs: [low, high], maxTruePeakDbtp }, { loudnessLufs, truePeakDbtp }) => ({
      pass: loudnessLufs >= low && loudnessLufs <= high && truePeakDbtp <= maxTruePeakDbtp,
      loudnessLufs,
      truePeakDbtp,
    }),
  ],
  '29-2': [
    ({ count, lagFrames }, { clicks, cuts }) => {
      // 点击、切点都严格递增，不同的点击要的切点帧也不同，所以这里是一个点击配一个切点，不会多次点击共用一个
      const uncut = clicks.filter((frame) => !cuts.includes(frame + lagFrames));
      return { pass: clicks.length === count && uncut.length === 0, clicks: clicks.length, uncut };
    },
    ({ tolFrames, minHitRate, minLift }, { fps, frames, clicks, onsetsMs }) => {
      // 帧号 × 1000 和 起音毫秒 × 帧率 都是整数，相差不超过 容差帧 × 1000 就算踩上（容差两端都算）
      const onOnset = (frame) => onsetsMs.some((ms) => Math.abs(frame * 1000 - ms * fps) <= tolFrames * 1000);
      const hit = share(clicks.filter(onOnset).length, clicks.length);
      // 随机基线：同一条音轨上任取一帧的命中率，取样窗口是全片 [0, frames) 的每一帧
      const randomBaseline = Array.from({ length: frames }, (_, frame) => frame).filter(onOnset).length / frames;
      return { pass: hit.hitRate >= minHitRate && hit.hitRate - randomBaseline >= minLift, ...hit, randomBaseline, baselineFrames: [0, frames] };
    },
  ],
  '23-2': [
    ({ count, bpm, tolFrames }, { fps, chaptersMs, beat }) => {
      const offBeatMs = chaptersMs.map((ms) => offGrid(ms, beat.periodMs, beat.phaseMs));
      // 一帧是 1000 / 帧率 毫秒，两边乘开成整数再比
      const onBeat = offBeatMs.every((ms) => ms * fps <= tolFrames * 1000);
      return { pass: beat.periodMs * bpm === 60000 && chaptersMs.length === count && onBeat, chapters: chaptersMs.length, offBeatMs };
    },
    ({ bpm, tolMs, minHitRate }, { strongOnsetsMs, beat }) => {
      const hit = share(strongOnsetsMs.filter((ms) => offGrid(ms, beat.periodMs, beat.phaseMs) <= tolMs).length, strongOnsetsMs.length);
      return { pass: beat.periodMs * bpm === 60000 && hit.hitRate >= minHitRate, ...hit };
    },
  ],
  '30-1': [
    ({ bpm, minCount, tolFrames, minHitRate }, { fps, moments, timeline }) => {
      // 落拍按工程自己那张节拍表算，不拿题面的 BPM 代它；表里写了的 bpm、beatFrames 都要和题面对上，两个都没写就是没有表
      const want = (fps * 60) / bpm;
      const beatFrames = timeline.beatFrames ?? (timeline.bpm === undefined ? null : (fps * 60) / timeline.bpm);
      const asAsked = Number.isInteger(want) && beatFrames === want && (timeline.bpm ?? bpm) === bpm;
      const hit = share(beatFrames === null ? 0 : moments.filter(({ frame }) => offGrid(frame, beatFrames) <= tolFrames).length, moments.length);
      return { pass: asAsked && moments.length >= minCount && hit.hitRate >= minHitRate, ...hit, beatFrames, bpm: timeline.bpm ?? null };
    },
    ({ maxBeatConstantDefs, maxHardcodedFrames }, { timeline }) => {
      // 节拍表得真有：别处的一个节拍常量凑出来的「定义一次」不算
      const table = timeline.bpm !== undefined || timeline.beatFrames !== undefined;
      const { beatConstantDefs } = timeline, hardcodedFrames = Math.max(...hardcoded(timeline));
      return { pass: table && beatConstantDefs >= 1 && beatConstantDefs <= maxBeatConstantDefs && hardcodedFrames <= maxHardcodedFrames,
        table, beatConstantDefs, hardcodedFrames };
    },
  ],
};

// 首尾相接、盖满全片的镜头表
const shotTable = (shots, frames) => Array.isArray(shots) && shots.length > 0 && Array.from(shots, plain).every(Boolean)
  && shots.every((shot, i) => Number.isSafeInteger(shot.out) && shot.in === (i ? shots[i - 1].out : 0) && shot.out > shot.in) && shots.at(-1).out === frames;

// 基础谓词的判法：读数拼成正式谓词核的两份输入（映射照出片链的成片量测），一条一条交给它
function basis({ deliverable: { size, fps, frames } }, reading) {
  const film = { output: { size, fps, frames }, shots: reading.shots };
  // 读数的 fps 是数，成形检查核过它等于交付规格，这里换回正式谓词核要的分数写法
  const measured = { output: { size: [reading.width, reading.height], fps, frames: reading.frames, colorTag: reading.colorTag },
    blackFrames: reading.blackFrames, freezes: reading.freezes, cuts: reading.cuts,
    audio: { loudnessLufs: reading.loudnessLufs, truePeakDbtp: reading.truePeakDbtp } };
  // 片子描述里没有镜头时正式谓词核把「对镜头表」当成没什么可对、判过；这里读数拿不出镜头表就是没证据
  return (predicate) => (/\bshots\b/.test(predicate) && !shotTable(reading.shots, frames)
    ? { status: 'skipped', reason: '读数里没有首尾相接、盖满全片的镜头表 shots' } : evaluateAssertion(predicate, film, measured));
}

// 读数先照 JSON 拍一份快照再判：一读就抛的取值器、已撤销的代理、读一回变一回的字段，到这里要么成了普通数据，要么算读不了
function snapshot(reading) {
  try { return JSON.parse(JSON.stringify(reading)); } catch { return undefined; }
}

export function evaluate(question, given) {
  const rules = RULES[question.id];
  if (!rules || rules.length !== question.scoring.length) throw new Error(`题目 ${question.id} 没有和 scoring 对得上的判法`);
  const reading = snapshot(given);
  const invalid = malformed(question, reading);
  const judge = invalid ? () => ({ status: 'skipped', reason: invalid }) : basis(question, reading);
  const base = question.basePredicates.map((predicate) => {
    const { status, reason, expected, counterexampleFrame } = judge(predicate);
    return { predicate, pass: status === 'pass', status, ...(status === 'pass' ? {} : { why: reason ?? expected, atFrame: counterexampleFrame ?? null }) };
  });
  const items = question.scoring.map(({ metric, weight, args }, i) => {
    const { pass, ...detail } = invalid ? { pass: false, invalid } : rules[i](args, reading);
    return { metric, weight, pass, detail };
  });
  const basePass = base.every((item) => item.pass);
  return { score: items.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0), pass: basePass && items.every((item) => item.pass), basePass, base, items };
}

// ── 读数提取 ──────────────────────────────────────────────────────────────
// 缺工具时读数函数不抛错，回 { toolMissing: 工具名 }，拿去判分是干净的 0 分；片子本身读不了照旧抛，带工具的诊断
const absent = (tool) => Object.assign(new Error(`机器上没有 ${tool}`), { toolMissing: tool });
const orMissing = (read) => async (...args) => {
  try { return await read(...args); } catch (error) {
    if (!error.toolMissing) throw error;
    return { toolMissing: error.toolMissing };
  }
};
// 观测层的指标缺工具时 value 是 null
async function metric(pending) {
  const got = await pending;
  if (got.value === null) throw absent(got.details.tool);
  return got;
}
function run(tool, args) {
  const child = spawnSync(tool, args, { maxBuffer: Infinity });
  if (child.error?.code === 'ENOENT') throw absent(tool);
  if (child.status !== 0) throw new Error(`${tool}: ${child.error?.message ?? child.stderr}`);
  return child.stdout;
}
// 成片这一头正式谓词核要的量测：画幅、帧率、帧数、色彩标签、黑帧、冻结段（半开区间）、换镜头帧；crop 只看画面的一块认切点
async function filmed(file, crop) {
  const [spec, still, cuts] = await Promise.all([metric(deliverSpec(file)), metric(blackFreezeDup(file)), metric(cutYdif(file, 24, crop))]);
  const { width, height, fps, frames, color_space: colorTag } = spec.value;
  return { width, height, fps, frames, colorTag, blackFrames: still.details.black,
    freezes: still.details.freezes.map(([from, to]) => ({ in: from, out: to + 1 })), cuts: cuts.value };
}
export const readFilm = orMissing((file) => filmed(file));

// 起音：声轨解成 16 千赫单声道，每 10 毫秒一格算均方根音量的常用对数（满幅是 0，静音压到 -4），比前一格高出 jump 以上就记一个起音，回毫秒
function onsets(file, jump) {
  const bytes = run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-i', resolve(file), '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  // 拷一份对齐到 2 字节的再按 16 位读
  const pcm = new Int16Array(new Uint8Array(bytes.subarray(0, bytes.length & ~1)).buffer);
  const found = [];
  let last = -4;
  for (let w = 0; (w + 1) * 160 <= pcm.length; w++) {
    let sum = 0;
    for (let k = w * 160; k < (w + 1) * 160; k++) sum += pcm[k] * pcm[k];
    const level = Math.max(-4, Math.log10(Math.sqrt(sum / 160) / 32768));
    if (level - last > jump) found.push(w * 10);
    last = level;
  }
  return found;
}

// 拍子：相邻起音的间隔里出现最多的当周期，起音对周期取余出现最多的当相位；起音不到两个估不出来，回 null
// shortcut: 只认最常见的起音间隔，切分多的配乐会认成半拍或两拍；真片上认错了就换成自相关估速
function beatOf(onsetsMs) {
  const mode = (values) => {
    const seen = new Map();
    for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1);
    return [...seen].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  };
  const periodMs = mode(onsetsMs.slice(1).map((ms, i) => ms - onsetsMs[i]));
  return periodMs ? { periodMs, phaseMs: mode(onsetsMs.map((ms) => ms % periodMs)) } : null;
}

// 27-1：交付量测、换镜头帧、响度和真峰值从成片量；镜头表取工程的片子描述
export const read27_1 = orMissing(async (file, film) => {
  const [seen, loud] = await Promise.all([filmed(file), metric(audioLoudness(file))]);
  return { ...seen, shots: film?.shots, loudnessLufs: loud.value, truePeakDbtp: loud.details.truePeakDbtp };
});

// 29-2：事件表（events/0.1）给点击（名字以 click 开头的命名条目）、镜头表（切点条目就是镜头的交界）和它自己的时间基准；
// 切点从画面量（crop 只看画面的一块），起音从声轨量
export const read29_2 = orMissing(async (file, events, { crop, jump = 0.25 } = {}) => {
  const seen = await filmed(file, crop);
  const at = (keep) => (Array.isArray(events?.events) ? events.events.filter((entry) => plain(entry) && keep(entry)).map((entry) => entry.frame) : []);
  const edges = [0, ...at((entry) => entry.kind === 'cut'), events?.frames];
  return { ...seen, eventsFps: events?.fps, eventsFrames: events?.frames, shots: edges.slice(1).map((out, i) => ({ in: edges[i], out })),
    clicks: at((entry) => entry.kind === 'named' && /^click/.test(entry.id)), onsetsMs: onsets(file, jump) };
});

// 23-2：章节起点读成片的章节元数据，强起音和拍子从声轨量；镜头表取工程的片子描述
export const read23_2 = orMissing(async (file, film, { jump = 0.35 } = {}) => {
  const seen = await filmed(file);
  const { chapters } = JSON.parse(run('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', resolve(file)]));
  const strongOnsetsMs = onsets(file, jump);
  return { ...seen, shots: film?.shots, chaptersMs: chapters.map((chapter) => Math.round(Number(chapter.start_time) * 1000)), beat: beatOf(strongOnsetsMs), strongOnsetsMs };
});

// 30-1：静态扫工程目录。片子描述 film.json（film/3.0）是时间的出处：timeline 是节拍表，原样读出它的 bpm、beatFrames；
// events 是命名时刻，照片子描述契约 5.3 展开，event(m01) + 18、cut(180) + 12 这样的算式和整数帧一样算；shots 是镜头表。
// 写死的帧号（第 0 帧不算）有两处来源。片子描述里别处把时间键写成整数（卡参数里相机关键帧的 f、片名入场的 enter 都在内；
// 镜头的出入点、转场的 at、刻意区间契约只许写整数，不算）。镜头代码先把注释、字符串抹成空格，再整份文件一起认，换行不改结论：
//   帧表达式跟整数比（数在哪边都算）、switch 帧表达式里的 case、名字以 frame 结尾的量赋成整数、对象里时间键写成两位以上的整数。
//   帧表达式是整条取值链（a.b.c），末段是这几种名字：以 frame 结尾的（frame、localFrame、ctx.frame，一位数也认）；f、t；
//   帧形参（render、state、meta、apply、evaluate 的形参，ctx 后面那个形参，赋给名字或属性的单形参箭头函数的形参）；
//   从帧表达式只做加减得来的 const、let、var。后三种只认两位以上的整数，x > 1 这样的归一化比较不算。
//   ctx.size[0] 这样末段是下标的、width、height、循环下标都不是帧表达式。
// 节拍常量的定义数 = 节拍表（有就算 1）+ 别处再给 bpm、tempo、beat* 赋数的次数；节拍表在不在看读数里有没有 bpm、beatFrames。
// shortcut: 用正则认，不解析语法，只扫 JS、TS、Python 源码，film.json 以外的 JSON 不看；帧名按整份文件算，不分作用域；
// 帧号先做算术再比（f - 432 >= 0）、先赋给名字不带 frame 的常量再比、形参名不在上面几种里的、十六进制写的，都认不出；
// 模板字符串的 ${} 里再套花括号或模板、正则字面量里带引号的那一行、switch 里第一个右花括号之后的 case 会认错。要更准就换成语法树
const TIME_KEYS = ['in', 'out', 'frame', 'at', 'start', 'end', 'f', 'enter', 'exit'];
// 比较号：不是箭头、移位的一半
const CMP = String.raw`(?<![<>=!])(?:[<>]=?|[!=]==?)(?![<>=])`;
const BEAT_DEF = /\b(?:bpm|tempo|beat\w*)\s*[:=]\s*\d+(?:\.\d+)?\s*(?:[;,)}\]]|$)/gim;
// 注释和字符串：JS 的块注释、行注释、模板、两种引号；Python 的三引号、# 注释、行尾续行的反斜杠、两种引号。写成一条正则，谁先开头谁算数
const NOISE = {
  js: /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
  py: /"""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|\\(?=\r?\n)|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
};
// 抹成空格、留着换行，行号不变。只有一个词的字符串原样留下（带引号的键）；模板字符串 ${} 里的是代码，留下
const codeOf = (text, py) => text.replace(py ? NOISE.py : NOISE.js, (noise) => (/^(["'])\w+\1$/.test(noise) ? noise
  : noise[0] === '`' ? noise.replace(/(\$\{[^}]*\})|[^\n]/g, (char, kept) => kept ?? ' ') : noise.replace(/[^\n]/g, ' ')));
const FRAME_NAMED = String.raw`[\w$]*[Ff]rame`;
// 叫这些名字的形参是像素、下标，不当帧
const NOT_FRAME = /^(?:w|h|x|y|z|i|j|width|height|size|aspect|index|count)$/;
// 整条取值链，末段是 names 里的名字；后面跟着 . [ ( 的是没取完的链，不算
const chain = (names) => String.raw`(?<![\w$.\])])(?:[\w$]+\.)*(?:${names})(?![\w$.\[(])`;
// 这份代码里哪些名字是帧：固定的几种加帧形参，再加从它们只做加减得来的量（照书写顺序认一遍）
function frameNames(code) {
  const names = new Set(['f', 't']);
  const add = (name) => { if (!NOT_FRAME.test(name)) names.add(name.replaceAll('$', String.raw`\$`)); };
  for (const [, list] of code.matchAll(/\b(?:render|state|meta|apply|evaluate)\s*(?:[:=]\s*(?:async\s+)?(?:function\b\s*[\w$]*\s*)?)?\(([^)]*)\)\s*(?:=>|[{:])/g)) {
    for (const [, name] of list.matchAll(/(?:^|,)\s*([\w$]+)/g)) add(name);
  }
  for (const [, name] of code.matchAll(/\(\s*ctx\s*,\s*([\w$]+)/g)) add(name);
  for (const [, name] of code.matchAll(/[=:]\s*(?:async\s+)?\(?\s*([\w$]+)\s*\)?\s*=>/g)) add(name);
  const all = () => [FRAME_NAMED, ...names].join('|');
  for (const [, name, init] of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=([^;\n]*)/g)) {
    if (!/[*/%?<>=!&|]/.test(init) && new RegExp(chain(all())).test(init)) add(name);
  }
  return all();
}
// 一份代码里写死的帧号各在第几行
function hardcodedLines(code) {
  const named = chain(FRAME_NAMED), any = chain(frameNames(code));
  const one = String.raw`[1-9][\d_]*\b(?!\.\d)`, two = String.raw`[1-9][\d_]+\b(?!\.\d)`, left = String.raw`(?<![\w$.])`;
  // 帧表达式放在环视里不吃掉，Python 的 432 <= t < 648 才能两头各认一处
  const literal = new RegExp([
    String.raw`(?<=${named}\s*)${CMP}\s*${one}`, String.raw`${left}${one}\s*${CMP}(?=\s*${named})`,
    String.raw`(?<=${any}\s*)${CMP}\s*${two}`, String.raw`${left}${two}\s*${CMP}(?=\s*${any})`,
    String.raw`${named}\s*[:=]\s*${one}`,
    String.raw`(?<=\bswitch\s*\(\s*${any}\s*\)\s*\{[^}]*)\bcase\s+${one}\s*:`,
    String.raw`(?<=[{,]\s*["']?)(?:${TIME_KEYS.join('|')})["']?\s*:\s*${two}`,
  ].join('|'), 'g');
  return Array.from(code.matchAll(literal), ({ index }) => code.slice(0, index).split('\n').length);
}
export function read30_1(root) {
  let film, frameOf;
  try { film = JSON.parse(readFileSync(join(root, 'film.json'), 'utf8')); } catch { film = null; }
  if (!plain(film)) return { unreadable: 'film.json' };
  // 镜头表不首尾相接、算式引用了没定义的事件或者成环，求值核都拒收，这个工程就读不了
  try { frameOf = expandEventFrames(film); } catch (error) { return { unreadable: `film.json（${error.message}）` }; }
  const { output, timeline, shots, transitions, events, ...rest } = film;
  const table = Object.fromEntries(['bpm', 'beatFrames'].filter((key) => plain(timeline) && Number.isFinite(timeline[key]) && timeline[key] > 0).map((key) => [key, timeline[key]]));
  const found = [];
  let beatConstantDefs = Object.keys(table).length ? 1 : 0;
  const walk = (node, path) => {
    const under = (key) => (path ? `${path}/${key}` : String(key));
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, under(plain(item) && typeof (item.id ?? item.as) === 'string' ? item.id ?? item.as : i)));
    else if (plain(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value !== 'number') walk(value, under(key));
        else if (TIME_KEYS.includes(key) && Number.isInteger(value) && value !== 0) found.push(`film.json:${under(key)}`);
        else if (/^(?:bpm|tempo|beat)/i.test(key)) beatConstantDefs++;
      }
    }
  };
  const rows = (list, ...own) => (Array.isArray(list) ? list.map((row) => (plain(row) ? Object.fromEntries(Object.entries(row).filter(([key]) => !own.includes(key))) : row)) : list);
  walk({ ...rest, shots: rows(shots, 'in', 'out', 'deliberate'), transitions: rows(transitions, 'at'), events: rows(events, 'frame') }, '');
  const sources = readdirSync(root, { recursive: true }).map((file) => file.replaceAll('\\', '/'))
    .filter((file) => /\.(?:[cm]?[jt]sx?|py)$/.test(file) && !/(?:^|\/)(?:node_modules|out|\.[^/]*)\//.test(file)).sort();
  for (const file of sources) {
    const code = codeOf(readFileSync(join(root, file), 'utf8'), file.endsWith('.py'));
    for (const line of hardcodedLines(code)) found.push(`${file}:${line}`);
    beatConstantDefs += code.match(BEAT_DEF)?.length ?? 0;
  }
  const [width, height] = Array.isArray(output?.size) ? output.size : [];
  return { width, height, fps: rate(output.fps), frames: output.frames, shots,
    moments: (events ?? []).map(({ id }) => ({ id, frame: frameOf[id] })), timeline: { ...table, beatConstantDefs, hardcodedFrames: found.length, found } };
}
