// B3 二级第一批四道题的判分核验：把题目的基础谓词和 scoring[].args 里的阈值套到一份读数上。
//   evaluate(question, reading) → { score, pass, basePass, base: [{ predicate, pass, status, why, atFrame }], items: [{ metric, weight, pass, detail }] }
//   score 是过了的判分项的权重和；basePass 是基础谓词条条都过；pass 是 basePass 加每个判分项都过，差一项就判不合格。
//   基础谓词这里不另写判法：读数拼成片子描述和成片量测，逐条交给正式谓词核（verify/predicates.mjs 的 evaluateAssertion），它判 pass 才算过。
//   它回 skipped（缺量测）、要对镜头表而读数里没有成形的镜头表，都是没证据，不算过；不过的那条带 why 和反例帧 atFrame。
//   所以读数除了各题自己的表，还要带成片这一头的 colorTag、blackFrames、freezes、cuts 和工程的镜头表 shots。
//   读数不成形（不是 JSON 对象、缺子表、表里有空洞或混进非数、帧率和总帧数跟交付规格不一致）一律 0 分、不合格，原因写在 detail.invalid，不抛错。
//   读数的字段见 beiming/bench/refs/level-2-a/ 的夹具；时刻要么是整数帧，要么是整数毫秒，比较全用整数，不落在浮点误差上。
//   read27_1、read29_2、read23_2 从成片量读数，镜头表取工程的片子描述或事件表；readFilm 只量成片这一头；read30_1 静态扫工程目录，
//   要判基础谓词就把 readFilm 的结果并进去。机器上没有 ffmpeg/ffprobe（read30_1 是没装 eslint）回 { toolMissing }。
// shortcut: 命中率和随机基线（05 第 7.1 节的 metric:beat.onset-hit）观测层还没有，先在这里算；它进了 observe/metrics 就换成调它。
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import nodeModule, { createRequire } from 'node:module';
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
// 镜头的出入点、转场的 at、刻意区间契约只许写整数，不算）。镜头代码里认四种写法：
//   帧的线性式跟常数比（数在哪边都算）、switch 帧的线性式里的 case、名字以 frame 结尾的量赋成整数、对象里时间键写成两位以上的整数。
// JS、TS 源码解析成语法树，按词法作用域认哪个量是帧（scanTree），换行、注释、字符串、同名的别的量都不改结论：
//   帧 = 名字以 frame 结尾的量和属性（frame、localFrame、ctx.frame）；叫 f、t 的量和属性；
//     对象和类里的帧回调（render、state、meta、apply、evaluate，写成方法、属性、obj.state = …、点名的函数 state: tick）的第一个形参，
//     叫 i、cursor 都算，只有 ctx 不算；从帧名解构改的名（const { frame: n } = ctx）；
//     没人在文件里调用的函数：自己叫帧回调名字的取第一个形参，形参表是 (ctx, 名字) 的取第二个；
//     文件里有调用点的函数：哪个形参是帧，看调用处传进来的实参是不是帧。
//   帧的线性式 = 帧和常数只做加减、乘除常数得来的式子，赋给变量照样跟着走（声明、赋值、形参默认值都算，定义写在用处后面也传得到）。
//   比较时折回帧上再看门槛：f - 432 >= 0、f / 24 >= 18、f >= 18 * 24、f >= 0x1b0 都是第 432 帧。门槛两位以上才算（x > 1 这样的
//   归一化比较不算），式子里有名字以 frame 结尾的一位数也算。减去命名时刻（f - at('m02')）、除以总长这样带别的量的式子不是线性式，不算。
// Python 和解析不了的 JS（语法错、Node 抹不掉的 TS 写法）先把注释、字符串抹成空格，再用正则整份文件一起认（hardcodedLines）。
// 节拍常量的定义数 = 节拍表（有就算 1）+ 别处再给 bpm、tempo、beat* 赋数的次数；节拍表在不在看读数里有没有 bpm、beatFrames。
// shortcut: 只扫 JS、TS、Python 源码，film.json 以外的 JSON 不看；只在上面四种写法里认帧号，拿帧做算术不比较的
// （(f - 432) / 216、clamp(f, 432, 648)、f % 24）不认；帧经对象的方法、回调、展开实参、别的文件传进辅助函数的不跟。真片上漏了再补规则。
// shortcut: 正则那一路不解析语法：帧名按整份文件算、不分作用域，帧回调的第一个形参叫 i、w 这类名字的不认，算术里藏的帧号、
// 十六进制也不认，模板字符串 ${} 里再套花括号、正则字面量里带引号的那一行会认错。Python 镜头多起来就接 Python 的语法树
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
// 叫这些名字的形参是上下文、像素、下标，不当帧
const NOT_FRAME = /^(?:ctx|w|h|x|y|z|i|j|width|height|size|aspect|index|count)$/;
// 整条取值链，末段是 names 里的名字；后面跟着 . [ ( 的是没取完的链，不算
const chain = (names) => String.raw`(?<![\w$.\])])(?:[\w$]+\.)*(?:${names})(?![\w$.\[(])`;
// 帧回调叫这几个名字
const HOOKS = 'render|state|meta|apply|evaluate';
// 对象里点名当帧回调的函数：state: tick
const HOOK_ALIAS = new RegExp(String.raw`\b(?:${HOOKS})\s*:\s*(?!(?:null|undefined|true|false)\b)([A-Za-z_$][\w$]*)\s*[,}]`, 'g');
// 一个量的声明和初值（const 后面逗号连着的也算）。初值到分号、花括号、括号外的逗号为止；
// 换行只在算式没写完时接着读：等号后面、上一行以 + - ( , 结尾、下一行以 + - ) 开头
const DECLARED = /(?:\b(?:const|let|var)\s+|,\s*)([\w$]+)\s*(?::[^=;\n]*)?(?<![<>!=])=(?![=>])\s*((?:[^;{},()\n]|\((?:[^()]|\([^()]*\))*\)|(?<=[-+(,]\s*)\n|\n(?=\s*[-+)]))*)/g;
// 这份代码里哪些名字是帧：固定的几种加帧形参，再加从它们只做加减得来的量（一遍遍认到不再多出来，定义写在用处后面也传得到）
function frameNames(code) {
  const names = new Set(['f', 't']);
  const escaped = (name) => name.replaceAll('$', String.raw`\$`);
  const add = (name) => { if (!NOT_FRAME.test(name)) names.add(escaped(name)); };
  // 帧形参只取帧回调的第一个形参。随手赋给一个名字的箭头函数（const wide = pixels => pixels >= 640）不是帧回调
  const hooks = [HOOKS, ...Array.from(code.matchAll(HOOK_ALIAS), ([, name]) => escaped(name))].join('|');
  const entry = new RegExp(String.raw`(?<![\w$])(?:${hooks})\s*(?:(?:[:=]\s*(?:async\s+)?(?:function\b\s*[\w$]*\s*)?)?\(\s*([\w$]+)[^)]*\)\s*(?:=>|[{:])|[:=]\s*(?:async\s+)?([\w$]+)\s*=>)`, 'g');
  for (const [, first, bare] of code.matchAll(entry)) add(first ?? bare);
  for (const [, name] of code.matchAll(/\(\s*ctx\s*,\s*([\w$]+)/g)) add(name);
  const all = () => [FRAME_NAMED, ...names].join('|');
  for (let known = -1; known !== names.size;) {
    known = names.size;
    const framed = new RegExp(chain(all()));
    for (const [, name, init] of code.matchAll(DECLARED)) if (!/[*/%?<>=!&|]/.test(init) && framed.test(init)) add(name);
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

// ── JS、TS 源码走语法树 ──
// 解析器 espree 和作用域分析 eslint-scope 用 eslint 自带的（仓库的开发依赖），不另加依赖；头一回扫到 JS 才载入
let toolkit;
function parser() {
  if (!toolkit) {
    let load;
    try { load = createRequire(createRequire(import.meta.url).resolve('eslint/package.json')); } catch { throw absent('eslint'); }
    toolkit = { espree: load('espree'), analyze: load('eslint-scope').analyze };
  }
  return toolkit;
}
// 解析成语法树和作用域表，模块、脚本两种读法都试；带类型标注的让 Node 把类型抹成空格（行号不变）再试。都不行回 null
function parse(text) {
  const { espree, analyze } = parser();
  // 只有语法错算解析不了；作用域分析出错是这里的毛病，照抛，不混成解析不了去走正则
  const tree = (source) => {
    for (const sourceType of ['module', 'script']) {
      let ast;
      // range 是作用域分析要的
      try { ast = espree.parse(source, { ecmaVersion: 'latest', sourceType, loc: true, range: true, ecmaFeatures: { jsx: true } }); } catch { continue; }
      return { ast, manager: analyze(ast, { ecmaVersion: espree.latestEcmaVersion, sourceType, childVisitorKeys: espree.VisitorKeys }) };
    }
    return null;
  };
  const plainly = tree(text);
  if (plainly) return plainly;
  // stripTypeScriptTypes 在 Node 22.13 以后才有；没有、或者遇到抹不掉的写法（enum、TSX），都当解析不了
  let typeless;
  try { typeless = nodeModule.stripTypeScriptTypes(text); } catch { return null; }
  return tree(typeless);
}
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const COMPARES = new Set(['<', '<=', '>', '>=', '==', '===', '!=', '!==']);
const HOOK = new RegExp(`^(?:${HOOKS})$`), BEAT_NAME = /^(?:bpm|tempo|beat\w*)$/i, SLOT = /^(?:Property|MethodDefinition|PropertyDefinition)$/;
// 一棵语法树里写死的帧号各在第几行、给节拍常量赋数有几处
function scanTree({ ast, manager }) {
  const { VisitorKeys } = parser().espree;
  const each = (node, visit) => {
    visit(node);
    for (const key of VisitorKeys[node.type] ?? []) for (const child of [node[key]].flat()) if (child) each(child, visit);
  };
  // 每个标识符落在哪个绑定上，声明处和引用处都记；同名不同作用域是不同的绑定
  const variables = manager.scopes.flatMap((scope) => scope.variables), bound = new Map();
  for (const variable of variables) for (const id of variable.identifiers) bound.set(id, variable);
  for (const scope of manager.scopes) for (const ref of scope.references) if (ref.resolved) bound.set(ref.identifier, ref.resolved);
  // 绑定上的函数（function 声明，或初值是函数的量）、函数归哪个绑定、文件里对这个绑定的调用
  const functionsOf = (variable) => (variable?.defs ?? []).map((def) => (def.type === 'FunctionName' ? def.node : def.node.init)).filter((node) => FUNCTIONS.has(node?.type));
  const owner = new Map(variables.flatMap((variable) => functionsOf(variable).map((fn) => [fn, variable]))), calls = new Map();
  // handed 是当实参交出去的回调（直接写在调用里的函数，或点名的绑定）：收到什么由对方定，some、map 给的是数组元素
  // stepped 把 n -= 432 这样的赋值记成 n - 432，和 n = n - 432 一样算
  const handed = new Set(), stepped = new Map();
  each(ast, (node) => {
    const callee = node.type === 'CallExpression' && bound.get(node.callee);
    if (callee) calls.set(callee, [...(calls.get(callee) ?? []), node]);
    if (/^(?:Call|New)Expression$/.test(node.type)) for (const arg of node.arguments) handed.add(FUNCTIONS.has(arg.type) ? arg : bound.get(arg));
    if (node.type === 'AssignmentExpression' && node.operator !== '=') stepped.set(node.left, { type: 'BinaryExpression', operator: node.operator.slice(0, -1), left: node.left, right: node.right });
  });
  // 导出的绑定（export 声明、export { 名字 }、export default 名字）：调用它的在别的文件
  // shortcut: 只认 ESM 的 export，module.exports = { 名字 } 不算；镜头改用 CommonJS 写时再补
  const exported = new Set(ast.body.filter((node) => /^Export(?:Named|Default)Declaration$/.test(node.type))
    .flatMap(({ declaration: made, specifiers = [] }) => [made, made?.id, ...(made?.declarations ?? []).map(({ id }) => id), ...specifiers.map(({ local }) => local)])
    .map((id) => bound.get(id)).filter(Boolean));
  // 「名字、值」的几种写法：声明、赋值、形参默认值、对象和类里的属性与方法
  const pair = (node) => (node.type === 'VariableDeclarator' ? [node.id, node.init]
    : (node.type === 'AssignmentExpression' && node.operator === '=') || node.type === 'AssignmentPattern' ? [node.left, node.right]
      : SLOT.test(node.type) && !node.computed ? [node.key, node.value] : []);
  const nameOf = (node) => (/^(?:Private)?Identifier$/.test(node?.type) ? node.name : node?.type === 'MemberExpression' && !node.computed ? node.property.name
    : node?.type === 'Literal' && typeof node.value === 'string' ? node.value : '');
  // 帧的线性式记成 帧 × k + c，named 是式子里有名字以 frame 结尾的；k 是 0 的是常数。一个量可能取到的几种式子都留着：
  // 同一个形参在几个调用点收到的式子（on(f)、on(f - 432)）哪一处写在前面不改结论，局部常量（const delay = 432）和直接写数一样算
  // shortcut: 一个量最多留 LIMIT 种式子、一串派生量最多追 DEEP 层，再多的不看；正常的工程到不了，真撞到再放宽
  const LIMIT = 10000, DEEP = 400, NONE = [];
  const gather = (forms, into = new Map()) => {
    for (const a of forms) if (into.size < LIMIT) into.set(`${a.k}:${a.c}:${Boolean(a.named)}`, a);
    return into;
  };
  const byName = (name) => (/[Ff]rame$/.test(name) ? [{ k: 1, c: 0, named: true }] : /^[ft]$/.test(name) ? [{ k: 1, c: 0 }] : NONE);
  const scaled = (a, by) => ({ ...a, k: a.k * by, c: a.c * by });
  // seeds 是不看别处就认成帧的绑定，passed 是形参在各调用点收到的实参
  const seeds = new Map(), passed = new Map();
  // 帧回调的第一个形参按位置认，叫 ctx 也是帧（hook）；别处叫 ctx 的形参是上下文，不认
  const seed = (param, forms = [{ k: 1, c: 0 }], hook = false) => {
    const variable = bound.get(param?.type === 'AssignmentPattern' ? param.left : param);
    if (variable && (hook || variable.name !== 'ctx')) seeds.set(variable, gather(forms, seeds.get(variable)));
  };
  each(ast, (node) => {
    const named = owner.get(node);
    if (FUNCTIONS.has(node.type) && calls.has(named)) {
      // 有调用点的函数，形参是什么看传进来的实参
      node.params.forEach((param, i) => {
        const variable = bound.get(param.left ?? param);
        if (variable && variable.name !== 'ctx') passed.set(variable, [...(passed.get(variable) ?? NONE), ...calls.get(named).map((site) => site.arguments[i])]);
      });
    } else if (FUNCTIONS.has(node.type)) {
      const [first, second] = node.params;
      // 调用点在别的文件的函数（导出的、对象和类里的方法、返回出去的）只能照名字认：形参叫 f、t 的是帧，形参表是 (ctx, 名字) 的取第二个。
      // 文件里没导出的局部函数、交给别的调用的回调不照名字认，形参收到帧才是帧
      if (!handed.has(node) && !handed.has(named) && (!named || exported.has(named))) {
        for (const param of node.params) seed(param, byName(nameOf(param.left ?? param)));
        if (first?.type === 'Identifier' && first.name === 'ctx' && second?.type === 'Identifier' && !NOT_FRAME.test(second.name)) seed(second);
      }
      // 自己叫帧回调名字的函数取第一个形参
      if (HOOK.test(named?.name ?? '')) seed(first, undefined, true);
    }
    // 对象、类里的帧回调（方法、属性、obj.state = …），值是函数或点名的函数：第一个形参就是帧
    const [key, value] = pair(node);
    if ((SLOT.test(node.type) || key?.type === 'MemberExpression') && HOOK.test(nameOf(key))) {
      for (const fn of FUNCTIONS.has(value?.type) ? [value] : functionsOf(bound.get(value))) seed(fn.params[0], undefined, true);
    }
    // 从帧名解构改的名：const { frame: n } = ctx
    if (node.type === 'ObjectPattern') {
      for (const prop of node.properties) if (prop.type === 'Property' && !prop.computed) seed(prop.value, byName(nameOf(prop.key)));
    }
  });
  // 一个绑定可能取到的线性式：种子，加赋进来的值（解构、for-of 这样只拿到一部分的不算），加各调用点传给这个形参的实参。用到才算，算完记下，
  // 定义写在用处后面也一样。绕回自己（n = n - 432、递归）时只拿已经算出的那几种，展开一层就停；这时算到一半的别的量不记，等绕完了重算
  const settled = new Map(), busy = new Map(), loops = new Set();
  const formsOf = (variable) => {
    if (!settled.has(variable) && busy.has(variable)) loops.add(variable);
    const known = settled.get(variable) ?? busy.get(variable);
    if (known) return [...known.values()];
    if (busy.size >= DEEP) return NONE;
    const forms = gather(seeds.get(variable)?.values() ?? NONE);
    busy.set(variable, forms);
    for (const ref of variable.references) if (ref.isWrite() && !ref.partial) gather(lin(stepped.get(ref.identifier) ?? ref.writeExpr), forms);
    for (const arg of passed.get(variable) ?? NONE) gather(lin(arg), forms);
    busy.delete(variable);
    loops.delete(variable);
    if (!loops.size) settled.set(variable, forms);
    return [...forms.values()];
  };
  // 一个式子可能取到的几种线性式；算不成线性式的回空表
  function lin(node) {
    if (node?.type === 'Literal') return typeof node.value === 'number' ? [{ k: 0, c: node.value }] : NONE;
    if (node?.type === 'ChainExpression') return lin(node.expression);
    if (node?.type === 'Identifier') {
      // 落在文件里某个绑定上的名字，是不是帧看这个绑定；f、t 这样的短名只在没有绑定时照拼写认，名字以 frame 结尾的没收到帧也照旧是帧
      const variable = bound.get(node), forms = variable ? formsOf(variable) : NONE;
      return forms.some((a) => a.k) || (variable && !/[Ff]rame$/.test(node.name)) ? forms : [...byName(node.name), ...forms];
    }
    if (node?.type === 'MemberExpression') return node.computed ? NONE : byName(node.property.name);
    if (node?.type === 'UnaryExpression') {
      const sign = { '+': 1, '-': -1 }[node.operator];
      return sign ? lin(node.argument).map((a) => scaled(a, sign)) : NONE;
    }
    if (node?.type !== 'BinaryExpression') return NONE;
    const sign = { '+': 1, '-': -1 }[node.operator], right = lin(node.right), mixed = new Map();
    for (const a of lin(node.left)) {
      if (mixed.size >= LIMIT) break;
      gather(right.map((b) => {
        if (sign) return { k: a.k + sign * b.k, c: a.c + sign * b.c, named: a.named || b.named };
        if (node.operator === '*' && !(a.k && b.k)) return a.k ? scaled(a, b.c) : scaled(b, a.c);
        return node.operator === '/' && !b.k ? scaled(a, 1 / b.c) : null;
      }).filter(Boolean), mixed);
    }
    return [...mixed.values()];
  }
  const lines = [];
  let beatDefs = 0;
  // 帧的线性式跟常数比，折回帧上的门槛够不够大；两边各有几种式子时，有一对够就算
  const past = (moving, fixed, least) => moving.some((a) => a.k && fixed.some((b) => !b.k && (b.c - a.c) / a.k >= (least ?? (a.named ? 1 : 10))));
  each(ast, (node) => {
    if (node.type === 'BinaryExpression' && COMPARES.has(node.operator)) {
      const left = lin(node.left), right = lin(node.right);
      if (past(left, right) || past(right, left)) lines.push(node.loc.start.line);
    } else if (node.type === 'SwitchStatement') {
      const on = lin(node.discriminant);
      for (const branch of node.cases) if (past(on, lin(branch.test), 1)) lines.push(branch.loc.start.line);
    } else {
      const [key, value] = pair(node), name = nameOf(key), fixed = lin(value);
      if (!fixed.length || fixed.some((a) => a.k)) return;
      // 节拍常量只数直接写数的定义：从别的常量算出来的量（beatSeconds = 60 / BPM）不是另一处定义
      let literal = true;
      each(value, (part) => { literal &&= part.type !== 'Identifier'; });
      if (literal && BEAT_NAME.test(name)) beatDefs++;
      const least = /[Ff]rame$/.test(name) ? 1 : node.type === 'Property' && TIME_KEYS.includes(name) ? 10 : Infinity;
      if (fixed.some((a) => Number.isInteger(a.c) && a.c >= least)) lines.push(node.loc.start.line);
    }
  });
  return { lines: lines.sort((a, b) => a - b), beatDefs };
}
// 抹掉注释和字符串的源码用正则认：Python，和解析不了的 JS
const scanText = (code) => ({ lines: hardcodedLines(code), beatDefs: code.match(BEAT_DEF)?.length ?? 0 });

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
    const text = readFileSync(join(root, file), 'utf8'), py = file.endsWith('.py');
    let tree;
    // 没装 eslint 就没有解析器：和缺 ffmpeg 一样回 toolMissing，不悄悄换成正则那一路
    try { tree = py ? null : parse(text); } catch (error) {
      if (!error.toolMissing) throw error;
      return { toolMissing: error.toolMissing };
    }
    const { lines, beatDefs } = tree ? scanTree(tree) : scanText(codeOf(text, py));
    for (const line of lines) found.push(`${file}:${line}`);
    beatConstantDefs += beatDefs;
  }
  const [width, height] = Array.isArray(output?.size) ? output.size : [];
  return { width, height, fps: rate(output.fps), frames: output.frames, shots,
    moments: (events ?? []).map(({ id }) => ({ id, frame: frameOf[id] })), timeline: { ...table, beatConstantDefs, hardcodedFrames: found.length, found } };
}
